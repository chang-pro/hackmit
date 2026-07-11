// FrameUplink — decodes the hvc1 glasses stream on a bounded background queue,
// taps every ~12th decoded frame to the WebRTC publisher (visible video on the
// desktop /capture page) and JPEG-uploads ~1 fps to /api/frames (analysis).
// All heavy work runs OFF the SDK delivery thread with a bounded queue that
// resyncs on a keyframe, so it cannot back up the stream.
import Foundation
import UIKit
import CoreImage
import CoreMedia
import VideoToolbox

final class FrameUplink: @unchecked Sendable {
    private let lock = NSLock()
    // Dedicated serial queue so the heavy decode + WebRTC-push + JPEG work
    // NEVER runs on the SDK's frame-delivery thread — doing it inline backs up
    // the SDK's bounded delivery queue and stalls the whole stream.
    private let work = DispatchQueue(label: "com.bloomknights.uplink", qos: .userInitiated)
    private let maxQueuedFrames = 4
    private var queuedFrames = 0
    private var waitForKeyframe = false
    private var decodeSession: VTDecompressionSession?
    private var streaming = false
    private var lastUploadAt = Date.distantPast
    private var lastPublishAt = Date.distantPast
    private let uploadInterval: TimeInterval = 1.0   // ~1 fps to the backend
    private let publishInterval: TimeInterval = 1.0 / 12.0 // 12 fps is enough for the viewer
    private let jpegQuality: CGFloat = 0.7
    private let ciContext = CIContext()

    // The laptop backend, now on a stable custom domain (no more rotating
    // tunnelmole urls).
    private let framesURL = URL(string: "https://capture.saicharanramineni.com/api/frames")!

    private var sentCount = 0
    private var okCount = 0
    private var failCount = 0
    var onStatus: @Sendable (String) -> Void = { _ in }
    // Selected decoded frames (12 fps) feed the WebRTC publisher. Called on
    // the VT decode callback thread.
    private var onDecodedFrame: (@Sendable (CVImageBuffer) -> Void)?

    func setFrameTap(_ tap: (@Sendable (CVImageBuffer) -> Void)?) {
        lock.lock()
        onDecodedFrame = tap
        lock.unlock()
    }

    // The supported `.raw` Meta stream already contains a CVPixelBuffer. Route
    // it directly to WebRTC; do not mutate or decode the SDK-owned sample.
    func routeRaw(_ sb: CMSampleBuffer) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock()
        guard streaming else { lock.unlock(); return }
        let now = Date()
        guard now.timeIntervalSince(lastPublishAt) >= publishInterval else {
            lock.unlock()
            return
        }
        lastPublishAt = now
        let tap = onDecodedFrame
        lock.unlock()
        tap?(imageBuffer)
    }

    func setStreaming(_ on: Bool) {
        lock.lock()
        streaming = on
        if on {
            sentCount = 0; okCount = 0; failCount = 0
            lastUploadAt = .distantPast; lastPublishAt = .distantPast
            waitForKeyframe = false
        }
        if !on, let s = decodeSession {
            VTDecompressionSessionInvalidate(s)
            decodeSession = nil
        }
        lock.unlock()
    }

    // A sample is a keyframe unless it is explicitly flagged NotSync. The
    // decoder must start on a keyframe or the first GOP is undecodable.
    private static func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              CFArrayGetCount(arr) > 0 else { return true }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self) as NSDictionary
        if let notSync = dict[kCMSampleAttachmentKey_NotSync as String] as? Bool { return !notSync }
        return true
    }

    // Called on the SDK delivery thread — hand off immediately and return, so
    // the delivery thread is never blocked by decode/encode/push work.
    func ingest(_ sb: CMSampleBuffer) {
        let keyframe = Self.isKeyframe(sb)
        lock.lock()
        guard streaming else { lock.unlock(); return }
        if waitForKeyframe {
            // A dropped HEVC P-frame invalidates the rest of its GOP. Resume
            // only from a clean keyframe after the bounded queue drains.
            guard keyframe, queuedFrames == 0 else { lock.unlock(); return }
            if let session = decodeSession { VTDecompressionSessionInvalidate(session) }
            decodeSession = nil
            waitForKeyframe = false
        }
        guard queuedFrames < maxQueuedFrames else {
            waitForKeyframe = true
            lock.unlock()
            return
        }
        queuedFrames += 1
        lock.unlock()
        work.async { [weak self] in
            self?.ingestSync(sb)
            self?.finishedQueuedFrame()
        }
    }

    private func finishedQueuedFrame() {
        lock.lock()
        queuedFrames = max(0, queuedFrames - 1)
        lock.unlock()
    }

    private func ingestSync(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb) else { return }

        lock.lock()
        guard streaming else { lock.unlock(); return }
        if let s = decodeSession, !VTDecompressionSessionCanAcceptFormatDescription(s, formatDescription: fmt) {
            VTDecompressionSessionInvalidate(s)
            decodeSession = nil
        }
        if decodeSession == nil {
            guard Self.isKeyframe(sb) else { lock.unlock(); return }   // wait for the first keyframe
            // NV12 uses much less memory than BGRA and is WebRTC's native
            // camera format. Core Image can still JPEG-encode the 1 fps sample.
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ]
            var session: VTDecompressionSession?
            let status = VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: fmt,
                decoderSpecification: nil,
                imageBufferAttributes: attrs as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &session
            )
            guard status == noErr, let session else { lock.unlock(); return }
            decodeSession = session
        }
        guard let session = decodeSession else { lock.unlock(); return }
        let now = Date()
        let wantUpload = now.timeIntervalSince(lastUploadAt) >= uploadInterval
        if wantUpload { lastUploadAt = now }
        let wantPublish = now.timeIntervalSince(lastPublishAt) >= publishInterval
        if wantPublish { lastPublishAt = now }
        lock.unlock()

        // Decode every frame (required for P-frame continuity). Publish at a
        // bounded 12 fps; only the ~1/second "wantUpload" frames additionally
        // get JPEG-encoded and POSTed.
        VTDecompressionSessionDecodeFrame(session,
                                          sampleBuffer: sb,
                                          flags: [],
                                          infoFlagsOut: nil) { [weak self] status, _, imageBuffer, _, _ in
            guard status == noErr, let imageBuffer, let self else { return }
            if wantPublish {
                self.lock.lock()
                let tap = self.onDecodedFrame
                self.lock.unlock()
                tap?(imageBuffer)
            }
            if wantUpload { self.encodeAndPost(imageBuffer) }
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func encodeAndPost(_ imageBuffer: CVImageBuffer) {
        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent),
              let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: jpegQuality) else { return }

        // Server contract (services/capture/gateway.js): snake_case fields;
        // source + image_base64 + positive width/height are required.
        let body: [String: Any] = [
            "source": "rayban_sdk",
            "sport": "auto",
            "captured_at": Self.isoFormatter.string(from: Date()),
            "image_base64": jpeg.base64EncodedString(),
            "mime_type": "image/jpeg",
            "width": Int(ciImage.extent.width),
            "height": Int(ciImage.extent.height),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }

        var req = URLRequest(url: framesURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        bump(sent: 1)
        let task = URLSession.shared.uploadTask(with: req, from: data) { [weak self] _, resp, err in
            guard let self else { return }
            if let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                // 202 = server up but analysis not started on the capture page.
                self.bump(ok: 1, note: http.statusCode == 202 ? "analysis OFF on server" : nil)
            } else {
                self.bump(fail: 1, note: err?.localizedDescription ?? "HTTP error")
            }
        }
        task.resume()
    }

    private func bump(sent: Int = 0, ok: Int = 0, fail: Int = 0, note: String? = nil) {
        lock.lock()
        sentCount += sent; okCount += ok; failCount += fail
        var line = "backend: sent \(sentCount) ok \(okCount) fail \(failCount)"
        if let note { line += " — \(note)" }
        lock.unlock()
        onStatus(line)
    }
}
