import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(ROOT, "packages", "fixtures", "demo-streams", "manifest.json");
export const DEFAULT_DEMO_STREAMS_DIR = resolve(
  process.env.DEMO_STREAMS_DIR || join(ROOT, "demo-footage")
);

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateManifest(manifest) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.streams)) {
    throw new Error("demo stream manifest must use schema_version 1 and contain streams");
  }
  if (manifest.streams.length !== 4) {
    throw new Error(`demo stream manifest must contain exactly four streams; received ${manifest.streams.length}`);
  }
  const streamIds = new Set();
  const packIds = new Set();
  const filenames = new Set();
  for (const stream of manifest.streams) {
    if (!stream?.stream_id || !stream?.pack_id || !stream?.source?.filename) {
      throw new Error("every demo stream requires stream_id, pack_id, and source.filename");
    }
    if (!Number.isInteger(stream.source.size_bytes) || stream.source.size_bytes <= 0 ||
        !finiteNonNegative(stream.source.duration_seconds) ||
        !/^[a-f0-9]{64}$/.test(stream.source.expected_sha256 ?? "")) {
      throw new Error(`demo stream ${stream.stream_id} requires exact size, duration, and SHA-256`);
    }
    if (streamIds.has(stream.stream_id) || packIds.has(stream.pack_id)) {
      throw new Error(`duplicate demo stream or pack id: ${stream.stream_id}`);
    }
    if (basename(stream.source.filename) !== stream.source.filename || filenames.has(stream.source.filename)) {
      throw new Error(`unsafe or duplicate demo stream filename: ${stream.source.filename}`);
    }
    if (stream.playback?.route !== `/demo-streams/${stream.stream_id}` ||
        stream.playback?.switch_policy !== "on_pack_change") {
      throw new Error(`invalid playback contract for demo stream ${stream.stream_id}`);
    }
    const moments = new Set();
    for (const checkpoint of stream.checkpoints ?? []) {
      if (!checkpoint?.moment_id || moments.has(checkpoint.moment_id)) {
        throw new Error(`invalid or duplicate checkpoint in demo stream ${stream.stream_id}`);
      }
      if (typeof checkpoint.available_in_media !== "boolean") {
        throw new Error(`${stream.stream_id}/${checkpoint.moment_id} must declare available_in_media`);
      }
      for (const field of ["anchor_media_seconds", "playback_start_seconds"]) {
        if (checkpoint[field] !== null && !finiteNonNegative(checkpoint[field])) {
          throw new Error(`${stream.stream_id}/${checkpoint.moment_id} has invalid ${field}`);
        }
      }
      if (!checkpoint.available_in_media &&
          (checkpoint.anchor_media_seconds !== null || checkpoint.playback_start_seconds !== null)) {
        throw new Error(`${stream.stream_id}/${checkpoint.moment_id} is unavailable but has media offsets`);
      }
      if (finiteNonNegative(checkpoint.anchor_media_seconds) &&
          finiteNonNegative(checkpoint.playback_start_seconds) &&
          checkpoint.playback_start_seconds > checkpoint.anchor_media_seconds) {
        throw new Error(`${stream.stream_id}/${checkpoint.moment_id} starts after its anchor`);
      }
      if (finiteNonNegative(checkpoint.anchor_media_seconds) &&
          checkpoint.anchor_media_seconds > stream.source.duration_seconds) {
        throw new Error(`${stream.stream_id}/${checkpoint.moment_id} is outside the media duration`);
      }
      moments.add(checkpoint.moment_id);
    }
    streamIds.add(stream.stream_id);
    packIds.add(stream.pack_id);
    filenames.add(stream.source.filename);
  }
  return manifest;
}

const MANIFEST = Object.freeze(validateManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))));
const STREAM_BY_ID = new Map(MANIFEST.streams.map((stream) => [stream.stream_id, stream]));
const STREAM_BY_PACK = new Map(MANIFEST.streams.map((stream) => [stream.pack_id, stream]));
const FILE_VERIFICATION_CACHE = new Map();

function fileSha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function publicCheckpoint(checkpoint) {
  const availableInMedia = checkpoint.available_in_media === true;
  const calibrated = availableInMedia && finiteNonNegative(checkpoint.anchor_media_seconds) &&
    finiteNonNegative(checkpoint.playback_start_seconds);
  return {
    moment_id: checkpoint.moment_id,
    available_in_media: availableInMedia,
    calibrated,
    anchor_media_seconds: calibrated ? checkpoint.anchor_media_seconds : null,
    playback_start_seconds: calibrated ? checkpoint.playback_start_seconds : null,
    calibration_note: checkpoint.calibration_note ?? null,
  };
}

function publicDefinition(stream) {
  const checkpoints = stream.checkpoints.map(publicCheckpoint);
  const availableCheckpoints = checkpoints.filter((checkpoint) => checkpoint.available_in_media);
  return {
    stream_id: stream.stream_id,
    pack_id: stream.pack_id,
    label: stream.label,
    media_url: stream.playback.route,
    mime_type: stream.source.mime_type,
    filename: stream.source.filename,
    switch_policy: stream.playback.switch_policy,
    muted: stream.playback.muted !== false,
    expected_duration_seconds: stream.source.duration_seconds,
    expected_size_bytes: stream.source.size_bytes,
    expected_sha256: stream.source.expected_sha256,
    calibrated_checkpoints: checkpoints.filter((checkpoint) => checkpoint.calibrated).length,
    checkpoint_count: checkpoints.length,
    available_checkpoint_count: availableCheckpoints.length,
    unavailable_checkpoint_count: checkpoints.length - availableCheckpoints.length,
    coverage_status: availableCheckpoints.length === checkpoints.length ? "complete" : "partial",
    all_checkpoints_playable: availableCheckpoints.length === checkpoints.length,
    calibration_complete: availableCheckpoints.length > 0 &&
      availableCheckpoints.every((checkpoint) => checkpoint.calibrated),
    checkpoints,
  };
}

export function listDemoStreamDefinitions() {
  return MANIFEST.streams.map(publicDefinition);
}

export function getDemoStreamDefinition(streamId) {
  const stream = STREAM_BY_ID.get(streamId);
  return stream ? publicDefinition(stream) : null;
}

export function getDemoPlaybackTarget(packId, momentId) {
  const stream = STREAM_BY_PACK.get(packId);
  const checkpoint = stream?.checkpoints.find((entry) => entry.moment_id === momentId);
  if (!stream || !checkpoint) return null;
  const availableInMedia = checkpoint.available_in_media === true;
  const calibrated = availableInMedia && finiteNonNegative(checkpoint.anchor_media_seconds) &&
    finiteNonNegative(checkpoint.playback_start_seconds);
  return {
    stream_id: stream.stream_id,
    pack_id: stream.pack_id,
    label: stream.label,
    media_url: stream.playback.route,
    mime_type: stream.source.mime_type,
    filename: stream.source.filename,
    switch_policy: stream.playback.switch_policy,
    muted: stream.playback.muted !== false,
    moment_id: checkpoint.moment_id,
    available_in_media: availableInMedia,
    calibrated,
    anchor_media_seconds: calibrated ? checkpoint.anchor_media_seconds : null,
    playback_start_seconds: calibrated ? checkpoint.playback_start_seconds : null,
  };
}

export function demoStreamMediaPath(streamId, mediaDir = DEFAULT_DEMO_STREAMS_DIR) {
  const stream = STREAM_BY_ID.get(streamId);
  if (!stream) return null;
  const root = resolve(mediaDir);
  const path = resolve(root, stream.source.filename);
  if (dirname(path) !== root) return null;
  return path;
}

export async function demoStreamFileStatus(streamId, mediaDir = DEFAULT_DEMO_STREAMS_DIR) {
  const stream = STREAM_BY_ID.get(streamId);
  const path = demoStreamMediaPath(streamId, mediaDir);
  if (!stream || !path) return { available: false, bytes: null, path: null };
  try {
    const file = await stat(path);
    return {
      available: file.isFile(),
      bytes: file.isFile() ? file.size : null,
      modified_ms: file.isFile() ? file.mtimeMs : null,
      path,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, bytes: null, path };
    throw error;
  }
}

export async function demoStreamVerifiedStatus(streamId, mediaDir = DEFAULT_DEMO_STREAMS_DIR) {
  const definition = getDemoStreamDefinition(streamId);
  const file = await demoStreamFileStatus(streamId, mediaDir);
  if (!definition || !file.available || file.bytes !== definition.expected_size_bytes) {
    return { ...file, sha256: null, verified: false };
  }
  const cacheKey = `${file.path}:${file.bytes}:${file.modified_ms}`;
  let digestPromise = FILE_VERIFICATION_CACHE.get(cacheKey);
  if (!digestPromise) {
    for (const key of FILE_VERIFICATION_CACHE.keys()) {
      if (key.startsWith(`${file.path}:`)) FILE_VERIFICATION_CACHE.delete(key);
    }
    digestPromise = fileSha256(file.path);
    FILE_VERIFICATION_CACHE.set(cacheKey, digestPromise);
  }
  let digest;
  try {
    digest = await digestPromise;
  } catch (error) {
    FILE_VERIFICATION_CACHE.delete(cacheKey);
    throw error;
  }
  return {
    ...file,
    sha256: digest,
    verified: digest === definition.expected_sha256,
  };
}

export async function listDemoStreams({ mediaDir = DEFAULT_DEMO_STREAMS_DIR } = {}) {
  return Promise.all(MANIFEST.streams.map(async (stream) => {
    const definition = publicDefinition(stream);
    const file = await demoStreamVerifiedStatus(stream.stream_id, mediaDir);
    return {
      ...definition,
      file_available: file.available,
      bytes: file.bytes,
      file_matches_manifest: file.verified,
      ready: file.verified && definition.calibration_complete,
      playback_ready: file.verified && definition.calibration_complete,
      readiness_reason: !file.available
        ? "media_file_missing"
        : file.bytes !== definition.expected_size_bytes
          ? "media_file_size_mismatch"
        : !file.verified
          ? "media_file_hash_mismatch"
        : !definition.calibration_complete
          ? "checkpoint_offsets_not_calibrated"
          : "ready",
    };
  }));
}
