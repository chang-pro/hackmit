// ApiClient.swift — small async/await URLSession client for the
// BloomKnights zero-dep Node backend (services/api/server.js).

import Foundation

enum ApiError: LocalizedError {
    case badBaseURL(String)
    case server(String)          // backend returned { "error": "..." }
    case http(Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .badBaseURL(let url):
            return "Backend URL is not valid: \(url)"
        case .server(let message):
            return message
        case .http(let code):
            return "Backend returned HTTP \(code)."
        case .decoding(let detail):
            return "Could not read the backend response (\(detail))."
        }
    }
}

/// Finds the Mac. One hardcoded address failed three different ways in one
/// evening: "localhost" is the phone itself, the Tailscale address relayed
/// through another city, and the USB-bridge address vanishes the moment the
/// cable is unplugged. So: an ordered list, fastest path first, probed in
/// PARALLEL with a short timeout, sticky until a request fails.
///
/// A sequential walk would be useless here. An address with no route does not
/// fail fast on a phone with a default route; the SYN leaves via wifi or cell
/// and the request sits until its timeout. Probing everything at once bounds
/// failover at one probe timeout no matter how many candidates are dead.
final class BackendLocator: @unchecked Sendable {
    static let shared = BackendLocator()

    /// Priority order. Earlier wins when several answer.
    static let candidates: [String] = [
        "http://192.168.234.1:3000",    // USB cable via the Mac's sharing bridge, ~2 ms
        "http://172.20.10.2:3000",      // Mac tethered to this phone's hotspot (USB or wifi)
        "http://10.189.45.199:3000",    // venue LAN, verified reachable from the phone
        "http://100.104.109.111:3000",  // Tailscale: works anywhere, slowest (often relayed)
    ]

    private let lock = NSLock()
    private var active: URL?
    private var probing = false
    private var lastProbeAt = Date.distantPast
    // How often to look for a better path while settled on a slower one.
    private static let upgradeEvery: TimeInterval = 30

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 2
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// The sticky choice, probing first if nothing has been chosen yet.
    func current() async -> URL {
        lock.lock()
        let chosen = active
        let stale = Date().timeIntervalSince(lastProbeAt) > Self.upgradeEvery
        lock.unlock()
        if let chosen {
            // The choice only changed on FAILURE, so an app that started on
            // Tailscale stayed there after the cable was plugged in: the slow
            // path kept working, so nothing ever looked for the fast one. While
            // settled on anything but the best candidate, re-probe in the
            // background. Frames keep flowing on the current path meanwhile.
            if stale, chosen.absoluteString != Self.candidates[0] {
                Task.detached(priority: .utility) { await BackendLocator.shared.reselect() }
            }
            return chosen
        }
        await reselect()
        lock.lock()
        defer { lock.unlock() }
        return active ?? URL(string: Self.candidates[0])!
    }

    /// Probes every candidate at once and keeps the highest-priority one that
    /// answers. Called when nothing is chosen yet and after any failed request.
    func reselect() async {
        lock.lock()
        if probing { lock.unlock(); return }
        probing = true
        lock.unlock()
        defer { lock.lock(); probing = false; lock.unlock() }

        let winner: (Int, URL)? = await withTaskGroup(of: (Int, URL)?.self) { group in
            for (index, raw) in Self.candidates.enumerated() {
                guard let base = URL(string: raw) else { continue }
                group.addTask {
                    var request = URLRequest(url: base.appending(path: "/api/health"))
                    request.httpMethod = "GET"
                    guard let (_, response) = try? await Self.probeSession.data(for: request),
                          (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
                    return (index, base)
                }
            }
            var best: (Int, URL)?
            for await result in group {
                if let result, best == nil || result.0 < best!.0 { best = result }
            }
            return best
        }

        lock.lock()
        active = winner?.1   // nil when nothing answered: probe again next time
        lastProbeAt = Date()
        lock.unlock()
    }

    /// Forget the current choice so the next request re-probes.
    func invalidate() {
        lock.lock(); active = nil; lock.unlock()
    }
}

struct ApiClient {
    static let baseURLDefaultsKey = "backendBaseURL"
    // "localhost" resolves to the phone itself on a real device, so every
    // frame POST vanished. Default to the Mac's Tailscale address: it is stable
    // across a wifi/cell switch, unlike a DHCP LAN address.
    // The Mac's LAN address, not its Tailscale one. Verified reachable from the
    // phone's browser: the venue wifi passes TCP between clients even though it
    // blocks the UDP that Tailscale needs to go direct, so every frame was
    // relaying through New York for no reason. On the LAN the frames never
    // touch the internet at all.
    static let defaultBaseURL = "http://192.168.234.1:3000"

    let baseURL: URL

    // One shared session for the whole app (the frame streamer builds a
    // client per upload; sessions must not accumulate).
    private static let sharedSession: URLSession = {
        let config = URLSessionConfiguration.default
        // Idle timers, not total-time budgets. 5s because the relay's retransmit
        // schedule after a loss is ~1s/2s/4s — giving up sooner throws away bytes
        // already committed to the tunnel and re-sends a full frame into a link
        // that is mid-recovery. The resource timeout matters more: its default is
        // 7 days, so a request dribbling a packet every few seconds runs forever.
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private var session: URLSession { Self.sharedSession }

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Builds a client for the best reachable backend. A saved override still
    /// wins if one exists; otherwise the locator picks, probing if it must.
    static func fromSettings() async throws -> ApiClient {
        if let raw = UserDefaults.standard.string(forKey: baseURLDefaultsKey) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: trimmed), url.scheme != nil, url.host() != nil else {
                throw ApiError.badBaseURL(raw)
            }
            return ApiClient(baseURL: url)
        }
        return ApiClient(baseURL: await BackendLocator.shared.current())
    }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    // MARK: - Endpoints

    /// GET /api/comparison?sport=&fixture=
    func comparison(sport: String, fixture: String) async throws -> ComparisonResponse {
        var components = URLComponents(url: baseURL.appending(path: "/api/comparison"),
                                       resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "sport", value: sport),
            URLQueryItem(name: "fixture", value: fixture),
        ]
        guard let url = components?.url else { throw ApiError.badBaseURL(baseURL.absoluteString) }
        let (data, response) = try await session.data(from: url)
        return try Self.parse(data: data, response: response)
    }

    /// GET /api/sports — the backend's sport/fixture catalog.
    func sports() async throws -> [SportCatalogEntry] {
        let url = baseURL.appending(path: "/api/sports")
        let (data, response) = try await session.data(from: url)
        return try Self.parse(data: data, response: response)
    }

    /// POST /api/frames — source-agnostic frame ingestion (capture gateway §7.1).
    func submitFrame(_ submission: FrameSubmission) async throws -> FrameSubmissionResponse {
        var request = URLRequest(url: baseURL.appending(path: "/api/frames"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try Self.encoder.encode(submission)
        let (data, response) = try await session.data(for: request)
        return try Self.parse(data: data, response: response)
    }

    // MARK: - Shared response handling

    private static func parse<T: Decodable>(data: Data, response: URLResponse) throws -> T {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if let body = try? decoder.decode(ApiErrorBody.self, from: data),
               let message = body.error {
                throw ApiError.server(message)
            }
            throw ApiError.http(status)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw ApiError.decoding(String(describing: T.self))
        }
    }
}
