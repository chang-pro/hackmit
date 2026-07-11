import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const SUPPORTED_MIME_TYPES = new Set(Object.values(MIME_TYPES));

export async function loadFrameImage(frame) {
  if (frame?.image_base64) {
    const dataUrl = String(frame.image_base64).match(/^data:([^;]+);base64,(.+)$/s);
    const mimeType = dataUrl?.[1] ?? frame.mime_type ?? "image/jpeg";
    const base64 = dataUrl?.[2] ?? frame.image_base64;
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new Error(`unsupported frame MIME type: ${mimeType}`);
    }
    return { mimeType, base64 };
  }

  const imagePath = frame?.image_path ?? frame?.image_uri;
  if (!imagePath || String(imagePath).startsWith("memory://")) {
    throw new Error("vision backend requires frame.image_base64 or a readable image path");
  }
  const mimeType = MIME_TYPES[extname(imagePath).toLowerCase()];
  if (!mimeType) throw new Error(`unsupported image type: ${imagePath}`);
  return { mimeType, base64: (await readFile(imagePath)).toString("base64") };
}
