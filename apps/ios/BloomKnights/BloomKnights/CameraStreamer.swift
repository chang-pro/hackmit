// CameraStreamer.swift — the glasses bridge.
// The iPhone camera stands in for the Meta Ray-Ban stream: the user points
// the phone at the screen showing the broadcast (or at a screen mirroring
// the glasses view). Frames are sampled at ~1 fps, JPEG-encoded, base64'd,
// and POSTed to /api/frames with source "ios_app" (capture gateway §7.1).

import AVFoundation
import CoreImage
import Foundation
import UIKit

final class CameraStreamer: NSObject, ObservableObject {
    // Counters shown in the Glasses tab.
    @Published var sent = 0
    @Published var accepted = 0
    @Published var skipped = 0
    @Published var failed = 0
    @Published var isRunning = false
    @Published var statusText = "Idle"
    @Published var lastFrameId: String?
    @Published var permissionDenied = false

    /// Sport tag attached to each frame; set by GlassesView.
    var sportProvider: @Sendable () -> String = { Sport.nba.rawValue }

    let session = AVCaptureSession()

    private let sessionQueue = DispatchQueue(label: "com.bloomknights.camera.session")
    private let videoQueue = DispatchQueue(label: "com.bloomknights.camera.frames")
    private let ciContext = CIContext()
    private var configured = false
    private var lastSampleAt = Date.distantPast
    private let sampleInterval: TimeInterval = 1.0   // ~1 fps
    private let jpegQuality: CGFloat = 0.6

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // MARK: - Lifecycle

    func start() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            DispatchQueue.main.async {
                self.permissionDenied = !granted
                self.statusText = granted ? "Starting camera…" : "Camera permission denied"
            }
            guard granted else { return }
            self.sessionQueue.async {
                self.configureIfNeeded()
                if !self.session.isRunning { self.session.startRunning() }
                DispatchQueue.main.async {
                    self.isRunning = true
                    self.statusText = "Streaming ~1 fps"
                }
            }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning { self.session.stopRunning() }
            DispatchQueue.main.async {
                self.isRunning = false
                self.statusText = "Idle"
            }
        }
    }

    private func configureIfNeeded() {
        guard !configured else { return }
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720

        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let input = try? AVCaptureDeviceInput(device: device),
           session.canAddInput(input) {
            session.addInput(input)
        }

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
        configured = true
    }
}

// MARK: - Frame sampling + upload

extension CameraStreamer: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastSampleAt) >= sampleInterval else { return }
        lastSampleAt = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent),
              let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: jpegQuality) else {
            return
        }

        let submission = FrameSubmission(
            source: "ios_app",
            sport: sportProvider(),
            capturedAt: Self.isoFormatter.string(from: now),
            imageBase64: jpeg.base64EncodedString(),
            width: width,
            height: height
        )

        Task { await self.upload(submission) }
    }

    private func upload(_ submission: FrameSubmission) async {
        await MainActor.run { self.sent += 1 }
        do {
            let api = try ApiClient.fromSettings()
            let result = try await api.submitFrame(submission)
            await MainActor.run {
                if result.selection?.accepted == true {
                    self.accepted += 1
                } else {
                    self.skipped += 1
                }
                self.lastFrameId = result.frame?.frameId
                self.statusText = "Streaming ~1 fps"
            }
        } catch {
            await MainActor.run {
                self.failed += 1
                self.statusText = "Upload failing — check backend URL"
            }
        }
    }
}
