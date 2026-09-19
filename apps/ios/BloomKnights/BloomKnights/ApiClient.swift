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

struct ApiClient {
    static let baseURLDefaultsKey = "backendBaseURL"
    static let defaultBaseURL = "http://localhost:3000"

    let baseURL: URL

    // One shared session for the whole app (the frame streamer builds a
    // client per upload; sessions must not accumulate).
    private static let sharedSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private var session: URLSession { Self.sharedSession }

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Builds a client from the AppStorage-backed setting.
    static func fromSettings() throws -> ApiClient {
        let raw = UserDefaults.standard.string(forKey: baseURLDefaultsKey) ?? defaultBaseURL
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil, url.host() != nil else {
            throw ApiError.badBaseURL(raw)
        }
        return ApiClient(baseURL: url)
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
