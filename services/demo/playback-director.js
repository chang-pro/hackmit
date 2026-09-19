export const MIN_PLAYBACK_CONFIDENCE = 0.70;

function boundedConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
}

export function playbackCandidateFromInsight(insight) {
  const intelligence = insight?.demo_intelligence;
  const playback = intelligence?.playback;
  const exactCheckpoint = intelligence?.mode === "precollected_event_replay" &&
    intelligence?.checkpoint_status === "ready";
  const approximateEventSync = playback?.match_mode === "approximate_event_sync";
  if (insight?.source !== "live" || (!exactCheckpoint && !approximateEventSync) || !playback) return null;
  const confidence = Math.min(
    boundedConfidence(insight?.observation?.confidence),
    boundedConfidence(intelligence?.match_confidence),
    boundedConfidence(intelligence?.confidence)
  );
  if (confidence < MIN_PLAYBACK_CONFIDENCE || !playback.stream_id || !playback.media_url) return null;
  return {
    stream_id: playback.stream_id,
    pack_id: intelligence.pack_id,
    label: playback.label || intelligence.pack_label,
    media_url: playback.media_url,
    mime_type: playback.mime_type || "video/mp4",
    muted: playback.muted !== false,
    filename: playback.filename,
    moment_id: intelligence.moment_id ?? playback.moment_id,
    match_mode: playback.match_mode ?? "exact_checkpoint",
    available_in_media: playback.available_in_media !== false,
    calibrated: playback.calibrated === true && Number.isFinite(playback.playback_start_seconds),
    seek_seconds: Number.isFinite(playback.playback_start_seconds) ? playback.playback_start_seconds : null,
    anchor_media_seconds: playback.anchor_media_seconds,
    event_confidence: confidence,
  };
}

export function playbackDirectiveTarget(directive, {
  activeRevision = 0,
  pendingRevision = 0,
  activeEpoch = 0,
  pendingEpoch = 0,
} = {}) {
  const revision = Number(directive?.revision);
  const epoch = Number(directive?.epoch);
  const newestEpoch = Math.max(Number(activeEpoch) || 0, Number(pendingEpoch) || 0);
  const newestRevision = epoch === Number(pendingEpoch)
    ? Math.max(Number(activeRevision) || 0, Number(pendingRevision) || 0)
    : Number(activeRevision) || 0;
  if (directive?.status !== "locked" || !Number.isInteger(epoch) || epoch <= 0 ||
      !Number.isInteger(revision) || revision <= 0 || epoch < newestEpoch ||
      (epoch === newestEpoch && revision <= newestRevision) || !directive.stream_id ||
      !directive.media_url || !Number.isFinite(directive.initial_seek_seconds)) return null;
  return {
    epoch,
    revision,
    streamId: directive.stream_id,
    label: directive.label || directive.stream_id,
    mediaUrl: directive.media_url,
    mimeType: directive.mime_type || "video/mp4",
    muted: directive.muted !== false,
    momentId: directive.initial_moment_id,
    seekSeconds: Math.max(0, directive.initial_seek_seconds),
  };
}

export class PlaybackDirector {
  constructor({ now = Date.now, epoch = null } = {}) {
    this.now = now;
    const epochValue = Number(epoch ?? now());
    this.epoch = Number.isSafeInteger(epochValue) && epochValue > 0 ? epochValue : Date.now();
    this.revision = 0;
    this.active = null;
    this.candidate = null;
    this.reason = "awaiting_exact_stream_detection";
  }

  consider(insight, { assetAvailable = false } = {}) {
    const candidate = playbackCandidateFromInsight(insight);
    if (!candidate) {
      this.candidate = null;
      this.reason = this.active ? "current_stream_continues" : "awaiting_exact_stream_detection";
      return this.snapshot();
    }
    if (this.active?.stream_id === candidate.stream_id) {
      this.candidate = null;
      this.reason = "same_stream_continues_without_reseek";
      return this.snapshot();
    }
    if (!candidate.available_in_media) {
      this.candidate = { ...candidate, reason: "checkpoint_not_in_media" };
      this.reason = "detected_checkpoint_not_in_local_edit";
      return this.snapshot();
    }
    if (!candidate.calibrated) {
      this.candidate = { ...candidate, reason: "checkpoint_offset_not_calibrated" };
      this.reason = "detected_stream_checkpoint_not_calibrated";
      return this.snapshot();
    }
    if (!assetAvailable) {
      this.candidate = { ...candidate, reason: "media_file_missing" };
      this.reason = "detected_stream_media_unavailable";
      return this.snapshot();
    }
    this.revision += 1;
    this.active = {
      ...candidate,
      revision: this.revision,
      locked_at: new Date(this.now()).toISOString(),
    };
    this.candidate = null;
    this.reason = this.revision === 1 ? "initial_stream_lock" : "new_stream_detected";
    return this.snapshot();
  }

  snapshot() {
    return {
      epoch: this.epoch,
      status: this.active ? "locked" : this.candidate ? "candidate" : "camera",
      revision: this.revision,
      stream_id: this.active?.stream_id ?? null,
      pack_id: this.active?.pack_id ?? null,
      label: this.active?.label ?? null,
      media_url: this.active?.media_url ?? null,
      mime_type: this.active?.mime_type ?? null,
      muted: this.active?.muted ?? true,
      initial_moment_id: this.active?.moment_id ?? null,
      initial_seek_seconds: this.active?.seek_seconds ?? null,
      event_confidence: this.active?.event_confidence ?? null,
      locked_at: this.active?.locked_at ?? null,
      reason: this.reason,
      candidate: this.candidate ? { ...this.candidate } : null,
    };
  }

  reset() {
    this.revision += 1;
    this.active = null;
    this.candidate = null;
    this.reason = "explicit_reset";
    return this.snapshot();
  }
}
