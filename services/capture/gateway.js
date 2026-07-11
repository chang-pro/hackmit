// Capture gateway (README §7.1).
// Isolates hardware-specific behavior from the rest of the system: glasses,
// phone companion, laptop webcam, uploaded screenshots, and prerecorded-clip
// frames all enter through the same ingest() contract. The vision pipeline is
// never coupled to a device SDK.
//
// Privacy baseline (README §16): frames live only in a small in-memory ring
// buffer. No raw camera footage is persisted to disk by default; image_uri is
// a memory:// reference, not a file path.

const DEFAULT_MAX_FRAMES = 30;
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class CaptureGateway {
  constructor({ maxFrames = DEFAULT_MAX_FRAMES } = {}) {
    this.maxFrames = maxFrames;
    this.frames = []; // newest last: { meta, image_base64 }
    this.counter = 0;
  }

  // Accepts a raw frame submission from any source and returns the §7.1 frame
  // metadata contract. Throws with a client-safe message on malformed input.
  ingest({ source, captured_at, image_base64, mime_type = "image/jpeg", width, height } = {}) {
    if (typeof source !== "string" || source.trim() === "")
      throw new Error("source is required");
    if (typeof image_base64 !== "string" || image_base64 === "")
      throw new Error("image_base64 is required");
    if (!SUPPORTED_MIME_TYPES.has(mime_type))
      throw new Error(`unsupported mime_type: ${mime_type}`);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error("width and height must be positive numbers");

    const parsedAt = Date.parse(captured_at ?? "");
    const capturedAt = Number.isNaN(parsedAt)
      ? new Date().toISOString()
      : new Date(parsedAt).toISOString();

    this.counter += 1;
    const frameId = `frame_${String(this.counter).padStart(6, "0")}`;
    const meta = {
      frame_id: frameId,
      captured_at: capturedAt,
      source,
      mime_type,
      image_uri: `memory://capture/${frameId}`, // in-memory only (README §16)
      width,
      height,
    };

    this.frames.push({ meta, image_base64, mime_type });
    if (this.frames.length > this.maxFrames) this.frames.shift();
    return meta;
  }

  latest() {
    return this.frames.at(-1) ?? null;
  }

  get(frameId) {
    return this.frames.find((f) => f.meta.frame_id === frameId) ?? null;
  }

  frame(frameId) {
    const stored = this.get(frameId);
    return stored
      ? { ...stored.meta, image_base64: stored.image_base64, mime_type: stored.mime_type }
      : null;
  }

  clear() {
    this.frames = [];
  }

  get size() {
    return this.frames.length;
  }
}
