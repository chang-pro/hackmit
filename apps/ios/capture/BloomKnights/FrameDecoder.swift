// FrameDecoder — the ONLY heavy work in the barebones app. Decodes the glasses'
// hvc1 samples to pixel buffers on its own bounded background queue and hands
// each decoded frame to onFrame (→ WebRTC). Bounded queue + keyframe-resync so
// it can never back up the SDK's delivery thread (that backpressure was the old
// freeze). No JPEG, no recording, no preview — one job.
import Foundation
import CoreMedia
import VideoToolbox

final class FrameDecoder: @unchecked Sendable {
    private let lock = NSLock()
    private let work = DispatchQueue(label: "com.bloomknights.decode", qos: .userInitiated)
    private let maxQueued = 3
    private var queued = 0
    private var waitForKeyframe = false
    private var session: VTDecompressionSession?
    private var running = false
    var onFrame: (@Sendable (CVImageBuffer) -> Void)?

    func setRunning(_ on: Bool) {
        lock.lock()
        running = on
        if on { waitForKeyframe = false; queued = 0 }
        if !on, let s = session { VTDecompressionSessionInvalidate(s); session = nil }
        lock.unlock()
    }

    // A sample is a keyframe unless explicitly flagged NotSync. The decoder must
    // start (and resync) on a keyframe or the GOP is undecodable.
    private static func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              CFArrayGetCount(arr) > 0 else { return true }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self) as NSDictionary
        if let notSync = dict[kCMSampleAttachmentKey_NotSync as String] as? Bool { return !notSync }
        return true
    }

    // Called on the SDK delivery thread — cheap check + one async handoff, never
    // decodes inline.
    func ingest(_ sb: CMSampleBuffer) {
        let keyframe = Self.isKeyframe(sb)
        lock.lock()
        guard running else { lock.unlock(); return }
        if waitForKeyframe {
            // After a backlog drop, resume only from a clean keyframe.
            guard keyframe, queued == 0 else { lock.unlock(); return }
            if let s = session { VTDecompressionSessionInvalidate(s); session = nil }
            waitForKeyframe = false
        }
        guard queued < maxQueued else { waitForKeyframe = true; lock.unlock(); return }
        queued += 1
        lock.unlock()
        work.async { [weak self] in self?.decode(sb) }   // decode() owns the decrement
    }

    private func finished() { lock.lock(); queued = max(0, queued - 1); lock.unlock() }

    // decode() must decrement `queued` EXACTLY once — on any early return, and
    // otherwise in the async decode callback (so the cap reflects frames still
    // in flight, not just submitted). Fixes Codex's queue-undercount finding.
    private func decode(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb) else { finished(); return }
        lock.lock()
        guard running else { lock.unlock(); finished(); return }
        if let s = session, !VTDecompressionSessionCanAcceptFormatDescription(s, formatDescription: fmt) {
            VTDecompressionSessionInvalidate(s); session = nil
        }
        if session == nil {
            guard Self.isKeyframe(sb) else { lock.unlock(); finished(); return }
            // NV12 is WebRTC's native camera format and half the memory of BGRA.
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ]
            var made: VTDecompressionSession?
            let status = VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: fmt,
                decoderSpecification: nil,
                imageBufferAttributes: attrs as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &made
            )
            guard status == noErr, let made else { lock.unlock(); finished(); return }
            session = made
        }
        guard let s = session else { lock.unlock(); finished(); return }
        lock.unlock()
        let submit = VTDecompressionSessionDecodeFrame(s, sampleBuffer: sb, flags: [], infoFlagsOut: nil) {
            [weak self] status, _, imageBuffer, _, _ in
            if status == noErr, let imageBuffer { self?.onFrame?(imageBuffer) }
            self?.finished()   // decode truly done → free a queue slot
        }
        // If the submit itself failed, the callback above never fires.
        if submit != noErr { finished() }
    }
}
