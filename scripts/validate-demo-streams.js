import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_DEMO_STREAMS_DIR,
  demoStreamFileStatus,
  demoStreamMediaPath,
  listDemoStreamDefinitions,
} from "../services/demo/streams.js";
import { listDemoIntelligencePacks } from "../services/demo/intelligence.js";

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function probe(path) {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,width,height",
    "-of", "json",
    path,
  ], { encoding: "utf8" });
  return JSON.parse(output);
}

const rows = [];
let failures = 0;
const intelligencePacks = new Map(
  listDemoIntelligencePacks().map((pack) => [pack.id, pack]),
);
const seenPacks = new Set();

for (const definition of listDemoStreamDefinitions()) {
  const file = await demoStreamFileStatus(definition.stream_id, DEFAULT_DEMO_STREAMS_DIR);
  const errors = [];
  const pack = intelligencePacks.get(definition.pack_id);
  if (!pack) {
    errors.push(`missing intelligence pack ${definition.pack_id}`);
  } else {
    seenPacks.add(pack.id);
    const streamMomentIds = [...definition.checkpoints.map((checkpoint) => checkpoint.moment_id)].sort();
    const packMomentIds = [...pack.checkpoints.map((checkpoint) => checkpoint.id)].sort();
    if (JSON.stringify(streamMomentIds) !== JSON.stringify(packMomentIds)) {
      errors.push(`checkpoint ids do not match intelligence pack ${pack.id}`);
    }
  }
  if (!file.available) {
    errors.push(`missing ${definition.filename}`);
  } else {
    if (file.bytes !== definition.expected_size_bytes) {
      errors.push(`size ${file.bytes} != ${definition.expected_size_bytes}`);
    }
    const digest = await sha256(file.path);
    if (digest !== definition.expected_sha256) errors.push(`sha256 ${digest} != manifest`);
    let media;
    try {
      media = probe(file.path);
    } catch (error) {
      errors.push(`ffprobe failed: ${error.message}`);
    }
    if (media) {
      const duration = Number(media.format?.duration);
      if (!Number.isFinite(duration) || Math.abs(duration - definition.expected_duration_seconds) > 0.1) {
        errors.push(`duration ${duration} != ${definition.expected_duration_seconds}`);
      }
      const video = media.streams?.find((stream) => stream.codec_type === "video");
      const audio = media.streams?.find((stream) => stream.codec_type === "audio");
      if (video?.codec_name !== "h264") errors.push(`video codec ${video?.codec_name ?? "missing"} is not h264`);
      if (video?.pix_fmt !== "yuv420p") errors.push(`pixel format ${video?.pix_fmt ?? "missing"} is not yuv420p`);
      if (audio && audio.codec_name !== "aac") errors.push(`audio codec ${audio.codec_name} is not aac`);
    }
  }

  for (const checkpoint of definition.checkpoints) {
    if (checkpoint.available_in_media && !checkpoint.calibrated) {
      errors.push(`${checkpoint.moment_id} is available but uncalibrated`);
    }
    if (checkpoint.calibrated && checkpoint.anchor_media_seconds > definition.expected_duration_seconds) {
      errors.push(`${checkpoint.moment_id} anchor exceeds duration`);
    }
  }

  if (errors.length > 0) failures += 1;
  rows.push({
    stream: definition.stream_id,
    file: demoStreamMediaPath(definition.stream_id, DEFAULT_DEMO_STREAMS_DIR),
    checkpoints: `${definition.calibrated_checkpoints}/${definition.available_checkpoint_count}`,
    omitted: definition.unavailable_checkpoint_count,
    status: errors.length === 0 ? "READY" : "FAIL",
    errors,
  });
}

for (const packId of intelligencePacks.keys()) {
  if (!seenPacks.has(packId)) {
    failures += 1;
    console.log(`FAIL  ${packId}  intelligence pack has no stream manifest entry`);
  }
}

for (const row of rows) {
  console.log(`${row.status}  ${row.stream}  checkpoints=${row.checkpoints}  omitted=${row.omitted}`);
  for (const error of row.errors) console.log(`  - ${error}`);
}

if (failures > 0) process.exitCode = 1;
