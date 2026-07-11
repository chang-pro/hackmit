// Frame selector (README §7.2) — target roughly 1-2 fps.
//
// Two cheap gates, applied in order:
//   1. Rate limit: reject frames arriving faster than minIntervalMs after the
//      last selected frame (default 500 ms => 2 fps ceiling).
//   2. Near-duplicate skip: compare byte length plus a sampled-byte hash of
//      the base64 payload against the last selected frame.
//
// KNOWN LIMITATION: the duplicate check operates on compressed image bytes,
// not pixels. JPEG re-encodes of visually identical camera frames usually
// differ slightly (sensor noise, timestamps in metadata), so this gate mainly
// catches byte-identical payloads — replayed stills, a paused video source, or
// a client resending the same capture. Real perceptual dedup (downscaled pixel
// diff / dHash) belongs with the Slice 2 vision work; the consider() interface
// will not change when it lands.

const DEFAULT_MIN_INTERVAL_MS = 500;
const HASH_SAMPLES = 64;

// FNV-1a over `samples` evenly spaced characters of the base64 payload.
// Cheap (O(samples)) and stable; not cryptographic, not perceptual.
export function sampledHash(base64, samples = HASH_SAMPLES) {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(base64.length / samples));
  for (let i = 0; i < base64.length; i += step) {
    h ^= base64.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class FrameSelector {
  // `now` is injectable so tests can control time deterministically.
  constructor({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.lastSelectedAt = -Infinity;
    this.lastLength = null;
    this.lastHash = null;
  }

  // Decides whether a frame should flow downstream to vision.
  // Returns { accepted: boolean, reason: string | null }.
  consider(imageBase64) {
    const t = this.now();
    if (t - this.lastSelectedAt < this.minIntervalMs) {
      return { accepted: false, reason: "rate_limited" };
    }

    const length = imageBase64.length;
    const hash = sampledHash(imageBase64);
    if (length === this.lastLength && hash === this.lastHash) {
      return { accepted: false, reason: "near_duplicate" };
    }

    this.lastSelectedAt = t;
    this.lastLength = length;
    this.lastHash = hash;
    return { accepted: true, reason: null };
  }
}
