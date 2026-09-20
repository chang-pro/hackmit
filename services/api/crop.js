// Cuts one item out of the frame it was found in, so a listing shows the item
// and not the whole room. Uses sips, which ships with macOS, to keep the server
// free of dependencies. Anywhere sips is missing this returns null and the
// caller falls back to the whole frame.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Room around the box: the model's boxes are tight and sometimes clip an edge.
const PAD = 0.18;
// Stream frames are small, so a crop can be a couple of hundred pixels across.
// Storefronts show that as a postage stamp; scale small crops up to this.
const MIN_LONG_EDGE = 900;

async function pixelSize(file) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

// The pixel rectangle for a 0..1000 box, padded and kept inside the frame.
export function cropRect(bbox, frame, pad = PAD) {
  const bx = (Number(bbox?.x) / 1000) * frame.width;
  const by = (Number(bbox?.y) / 1000) * frame.height;
  const bw = (Number(bbox?.width) / 1000) * frame.width;
  const bh = (Number(bbox?.height) / 1000) * frame.height;
  if (![bx, by, bw, bh].every(Number.isFinite) || bw < 8 || bh < 8) return null;
  const left = Math.max(0, Math.floor(bx - bw * pad));
  const top = Math.max(0, Math.floor(by - bh * pad));
  const right = Math.min(frame.width, Math.ceil(bx + bw * (1 + pad)));
  const bottom = Math.min(frame.height, Math.ceil(by + bh * (1 + pad)));
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 8) return null;
  // A box that is already nearly the whole frame is not worth a second file.
  if (width * height > frame.width * frame.height * 0.9) return null;
  return { left, top, width, height };
}

// bytes: a JPEG or PNG. Returns the cropped JPEG, or null if it cannot be made.
export async function cropItem(bytes, bbox) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "reloop-crop-"));
    const source = join(dir, "in.jpg");
    const out = join(dir, "out.jpg");
    await writeFile(source, bytes);
    const frame = await pixelSize(source);
    if (!frame) return null;
    const rect = cropRect(bbox, frame);
    if (!rect) return null;
    await run("sips", [
      "-s", "format", "jpeg",
      "-c", String(rect.height), String(rect.width),
      "--cropOffset", String(rect.top), String(rect.left),
      source, "--out", out,
    ]);
    if (Math.max(rect.width, rect.height) < MIN_LONG_EDGE) {
      await run("sips", ["-Z", String(MIN_LONG_EDGE), out]);
    }
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
