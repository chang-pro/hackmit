// Deterministic demo-intelligence router.
//
// Cerebras owns visual identification. Once it has identified a supported
// broadcast, this module selects the matching precollected evidence pack and
// the closest moment in that event. The returned payload is deliberately
// explicit about historical/replayed sources and illustrative market prices.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDemoPlaybackTarget } from "./streams.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(HERE, "..", "..", "packages", "fixtures", "demo-intelligence");
const PACK_FILES = [
  "world-cup-2022-final.json",
  "nba-celtics-knicks-2026.json",
  "super-bowl-li.json",
  "ufc-229.json",
];

const PACKS = PACK_FILES.map((name) =>
  Object.freeze(JSON.parse(readFileSync(join(PACK_DIR, name), "utf8")))
);

const MIN_VISION_CONFIDENCE = 0.55;
const MIN_DETERMINISTIC_CONFIDENCE = 0.72;
const MIN_STREAM_SWITCH_CONFIDENCE = 0.70;
const MIN_MOMENT_SCORE = 4;
const MIN_MOMENT_MARGIN = 0.75;
const UNKNOWN_TEXT = new Set(["", "unknown", "unidentified", "n a", "na", "none", "null"]);

function normalized(value) {
  const tokens = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const collapsed = [];
  for (let index = 0; index < tokens.length;) {
    if (tokens[index].length !== 1) {
      collapsed.push(tokens[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < tokens.length && tokens[end].length === 1) end += 1;
    const run = tokens.slice(index, end);
    collapsed.push(run.length >= 2 ? run.join("") : run[0]);
    index = end;
  }
  return collapsed.join(" ");
}

function known(value) {
  return !UNKNOWN_TEXT.has(normalized(value));
}

function canonicalSport(value) {
  const sport = normalized(value).replaceAll(" ", "_");
  return {
    nba: "basketball",
    nba_basketball: "basketball",
    pro_basketball: "basketball",
    nfl: "american_football",
    football: "american_football",
    american_football: "american_football",
    nfl_football: "american_football",
    gridiron: "american_football",
    ufc: "mma",
    ufc_mma: "mma",
    mixed_martial_arts: "mma",
    association_football: "soccer",
    fifa_football: "soccer",
  }[sport] ?? sport;
}

function primaryParticipantNames(observation) {
  const direct = [observation?.participant_a, observation?.participant_b]
    .filter(known)
    .map(normalized);
  if (direct.length > 0) return direct;
  return (Array.isArray(observation?.participants) ? observation.participants : [])
    .slice(0, 2)
    .map((participant) => participant?.name)
    .filter(known)
    .map(normalized);
}

function identityText(observation) {
  return normalized([
    observation?.competition,
    observation?.event_name,
    observation?.event_identity,
  ].filter(known).join(" "));
}

function includesAlias(text, alias) {
  const needle = normalized(alias);
  return needle.length > 1 && (` ${text} `).includes(` ${needle} `);
}

function matchedParticipantGroups(pack, names) {
  return new Set((pack.participant_groups ?? [])
    .map((group, index) => group.some((alias) => names.some((name) => includesAlias(name, alias)))
      ? index
      : null)
    .filter((index) => index != null));
}

function matchedIdentity(pack, observation) {
  const text = identityText(observation);
  return (pack.identity_tokens ?? []).some((token) => includesAlias(text, token));
}

function yearsIn(value) {
  return new Set(String(value ?? "").match(/\b(?:19|20)\d{2}\b/g) ?? []);
}

function firstNumberedIdentity(value, label) {
  const match = normalized(value).match(new RegExp(`\\b${label}\\s+([0-9]+|[ivxlcdm]+)\\b`));
  return match?.[1] ?? null;
}

function metadataConflicts(pack, observation) {
  const packText = [pack.event_label, ...(pack.identity_tokens ?? []), ...(pack.competition_tokens ?? [])]
    .join(" ");
  const observedText = [observation?.competition, observation?.event_name, observation?.event_identity]
    .filter(known)
    .join(" ");
  const packYears = yearsIn(packText);
  const observedYears = yearsIn(observedText);
  if (packYears.size > 0 && observedYears.size > 0 &&
      ![...observedYears].some((year) => packYears.has(year))) return true;

  const competition = normalized(observation?.competition);
  if (/\bregular season\b/.test(competition) && !/\bregular season\b/.test(normalized(packText))) {
    return true;
  }
  for (const label of ["ufc", "super bowl", "game"]) {
    const expected = firstNumberedIdentity(packText, label);
    const observed = firstNumberedIdentity(observedText, label);
    if (expected && observed && expected !== observed) return true;
  }
  const roundMarkers = ["group stage", "round of", "quarterfinal", "semifinal", "qualifier", "friendly"];
  if (roundMarkers.some((marker) => competition.includes(marker)) &&
      !roundMarkers.some((marker) => normalized(packText).includes(marker))) return true;
  return false;
}

function packMatch(pack, observation) {
  const visionConfidence = Number(observation?.confidence ?? 0);
  if (!Number.isFinite(visionConfidence) || visionConfidence < MIN_VISION_CONFIDENCE) return null;
  if (canonicalSport(observation?.sport) !== pack.sport) return null;
  const primaryNames = primaryParticipantNames(observation);
  const groups = matchedParticipantGroups(pack, primaryNames);
  const identityMatched = matchedIdentity(pack, observation);
  const conflict = metadataConflicts(pack, observation);
  const participantMatched = groups.size >= Math.min(2, pack.participant_groups?.length ?? 2);
  const exactEvidence = !conflict && (participantMatched || identityMatched);
  const deterministic = exactEvidence && visionConfidence >= MIN_DETERMINISTIC_CONFIDENCE;
  const baseConfidence = identityMatched ? 0.99 : participantMatched ? 0.98 : 0.66;
  return {
    score: exactEvidence ? (identityMatched ? 110 : 100) : 10,
    basis: conflict
      ? "conflicting_metadata"
      : identityMatched
        ? "identity_token"
        : participantMatched
          ? "primary_participants"
          : "sport_fallback",
    confidence: Math.min(visionConfidence, baseConfidence),
    exactEvidence,
    deterministic,
    pendingReason: conflict
      ? "conflicting_event_metadata"
      : exactEvidence && !deterministic
        ? "vision_confidence_below_deterministic_threshold"
        : null,
  };
}

function clockSeconds(value) {
  if (!known(value)) return null;
  const text = String(value)
    .trim()
    .toUpperCase()
    .replace(/[OQ]/g, "0")
    .replace(/[IL|]/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/[.;]/g, ":")
    .replace(/\s+/g, "");
  const countdown = text.match(/^(\d{1,3}):(\d{2})$/);
  if (countdown && Number(countdown[2]) < 60) {
    return Number(countdown[1]) * 60 + Number(countdown[2]);
  }
  const minute = text.match(/^(\d{1,3})(?:'|MIN(?:UTE)?S?|M)?$/);
  return minute ? Number(minute[1]) * 60 : null;
}

function numericScore(value) {
  if (value === null || value === undefined || value === "" || !known(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scoreMatches(moment, a, b) {
  return Array.isArray(moment.scores) &&
    moment.scores.some(([left, right]) => Number(left) === a && Number(right) === b);
}

function canonicalPhase(value, sport) {
  const phase = normalized(value);
  if (!phase) return "";
  if (sport === "basketball" || sport === "american_football") {
    if (/\b(?:half time|halftime|end q?2|end 2q)\b/.test(phase)) return "halftime";
    const quarter = phase.match(/\b(?:q|quarter|qtr)\s*([1-5])\b/) ??
      phase.match(/\b([1-5])(?:st|nd|rd|th)?\s*(?:q|quarter|qtr)\b/);
    if (quarter) return `q${quarter[1]}`;
    if (/\b(?:ot|overtime)\b/.test(phase)) return "q5";
  }
  if (sport === "mma") {
    const round = phase.match(/\b(?:round|rd|rnd|r)\s*([1-5])\b/);
    if (round) return `round ${round[1]}`;
  }
  if (sport === "soccer") {
    if (/\b(?:h2|2h|second half|2nd half|2nd)\b/.test(phase)) return "second half";
    if (/\b(?:h1|1h|first half|1st half|1st)\b/.test(phase)) return "first half";
    if (/\b(?:extra time|et|et1|et2|1et|2et)\b/.test(phase)) return "extra time";
  }
  return phase;
}

function phaseMatches(moment, observation, pack) {
  const observed = canonicalPhase(observation?.phase, pack.sport);
  if (!observed) return false;
  return (moment.phase_tokens ?? []).some((token) => {
    const expected = canonicalPhase(token, pack.sport);
    return expected === observed || observed.includes(expected) || expected.includes(observed);
  });
}

function momentScore(pack, moment, observation) {
  let score = 0;
  const a = numericScore(observation?.score_a);
  const b = numericScore(observation?.score_b);
  const scoreVisiblySupported = known(observation?.score_display) || a !== 0 || b !== 0;
  if (a != null && b != null && scoreVisiblySupported) {
    const matchingMoments = pack.moments.filter((entry) => scoreMatches(entry, a, b)).length;
    if (scoreMatches(moment, a, b) && matchingMoments > 0 && matchingMoments < pack.moments.length) {
      score += matchingMoments === 1 ? 12 : 6;
    }
  }
  if (phaseMatches(moment, observation, pack)) score += 5;
  const observedClock = clockSeconds(observation?.clock);
  if (observedClock != null && moment.clock_seconds != null) {
    const tolerance = moment.clock_tolerance_seconds ?? 180;
    const distance = Math.abs(observedClock - moment.clock_seconds);
    if (distance <= tolerance) score += 4 * (1 - distance / Math.max(1, tolerance));
  }
  const visible = normalized([
    observation?.situation,
    ...(observation?.visible_facts ?? []),
    ...(observation?.changes_across_frames ?? []),
  ].join(" "));
  if ((moment.situation_tokens ?? []).some((token) => visible.includes(normalized(token)))) score += 2;
  return score;
}

function selectMoment(pack, observation, previous) {
  const scoreA = numericScore(observation?.score_a);
  const scoreB = numericScore(observation?.score_b);
  const visibleScore = known(observation?.score_display) || scoreA !== 0 || scoreB !== 0;
  if (scoreA != null && scoreB != null && visibleScore &&
      !pack.moments.some((moment) => scoreMatches(moment, scoreA, scoreB))) {
    return {
      moment: null,
      index: -1,
      score: 0,
      status: "pending",
      reason: "visible_score_not_in_calibrated_checkpoints",
    };
  }
  const ranked = pack.moments
    .map((moment, index) => ({ moment, index, score: momentScore(pack, moment, observation) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;
  const priorIndex = previous?.pack_id === pack.id
    ? pack.moments.findIndex((moment) => moment.id === previous.moment_id)
    : -1;
  const ambiguous = !best || best.score < MIN_MOMENT_SCORE || margin < MIN_MOMENT_MARGIN;

  if (ambiguous && priorIndex >= 0 && previous?.mode === "precollected_event_replay") {
    return {
      moment: pack.moments[priorIndex],
      index: priorIndex,
      score: best?.score ?? 0,
      status: "held_previous",
      reason: "ambiguous_observation",
    };
  }
  if (ambiguous) {
    return {
      moment: null,
      index: -1,
      score: best?.score ?? 0,
      status: "pending",
      reason: best?.score >= MIN_MOMENT_SCORE ? "checkpoint_tie" : "insufficient_checkpoint_evidence",
    };
  }
  if (priorIndex > best.index && previous?.mode === "precollected_event_replay") {
    return {
      moment: pack.moments[priorIndex],
      index: priorIndex,
      score: best.score,
      status: "held_previous",
      reason: "monotonic_replay_guard",
    };
  }
  return { ...best, status: "ready", reason: null };
}

function phaseNumber(values, sport) {
  for (const value of values) {
    const phase = canonicalPhase(value, sport);
    const match = sport === "mma"
      ? phase.match(/^round ([1-5])$/)
      : phase.match(/^q([1-5])$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function timelineProgress(sport, phaseValues, clockValue) {
  const remaining = typeof clockValue === "number" ? clockValue : clockSeconds(clockValue);
  if (remaining == null) return null;
  if (sport === "soccer") return remaining;
  const period = phaseNumber(phaseValues, sport);
  if (!period) return null;
  const periodSeconds = sport === "mma" ? 300 : sport === "american_football" ? 900 : 720;
  return (period - 1) * periodSeconds + Math.max(0, periodSeconds - remaining);
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundedProbability(value) {
  return Number(clamp(value).toFixed(4));
}

function historicalTimelineMoment(pack, observation) {
  const observedProgress = timelineProgress(pack.sport, [observation?.phase], observation?.clock);
  if (!Number.isFinite(observedProgress)) return null;

  const anchors = pack.moments
    .map((moment, index) => ({
      moment,
      index,
      progress: timelineProgress(pack.sport, moment.phase_tokens ?? [], moment.clock_seconds),
    }))
    .filter((entry) => Number.isFinite(entry.progress))
    .sort((left, right) => left.progress - right.progress);
  if (!anchors.length) return null;

  let left = anchors[0];
  let right = anchors[0];
  for (const anchor of anchors) {
    if (anchor.progress <= observedProgress) left = anchor;
    if (anchor.progress >= observedProgress) {
      right = anchor;
      break;
    }
    right = anchor;
  }
  const span = right.progress - left.progress;
  const ratio = span > 0 ? clamp((observedProgress - left.progress) / span) : 0;
  const nearest = ratio < 0.5 ? left : right;
  const interpolate = (field) => Number(left.moment[field]) +
    ratio * (Number(right.moment[field]) - Number(left.moment[field]));
  const phase = String(observation?.phase ?? "Replay").trim();
  const clock = String(observation?.clock ?? "").trim();

  return {
    ...nearest.moment,
    id: null,
    label: `${phase}${clock ? ` ${clock}` : ""} · historical timeline estimate`,
    model_probability: roundedProbability(interpolate("model_probability")),
    market_probability: roundedProbability(interpolate("market_probability")),
    confidence: roundedProbability(Math.min(
      Number(left.moment.confidence ?? 0),
      Number(right.moment.confidence ?? 0)
    ) * 0.95),
    summary: `Backtested point-in-time estimate between “${left.moment.label}” and “${right.moment.label}”. The visible phase and clock set the position on the archived probability timeline; the final result is not injected into this estimate.`,
    what_changed: `The visible broadcast moved between the archived “${left.moment.label}” and “${right.moment.label}” states.`,
    next_trigger: right.progress > observedProgress
      ? `Recalculate at the next archived state: ${right.moment.label}.`
      : "Recalculate when the visible score, phase, or clock changes.",
    key_factors: [
      `Visible state: ${phase}${clock ? ` ${clock}` : ""}`,
      "Interpolated from the complete archived replay timeline",
      "Point-in-time estimate; final-result leakage is disabled",
      ...(nearest.moment.key_factors ?? []),
    ].slice(0, 6),
    timeline_interpolation: {
      left_anchor_id: left.moment.id,
      right_anchor_id: right.moment.id,
      ratio: Number(ratio.toFixed(4)),
      observed_progress: observedProgress,
    },
  };
}

function approximatePlaybackTarget(pack, observation) {
  const targets = pack.moments
    .map((moment) => ({ moment, target: getDemoPlaybackTarget(pack.id, moment.id) }))
    .filter(({ target }) => target?.calibrated);
  const base = targets[0]?.target;
  if (!base) return null;
  const observedProgress = timelineProgress(pack.sport, [observation?.phase], observation?.clock);
  const anchors = targets
    .map(({ moment, target }) => ({
      progress: timelineProgress(pack.sport, moment.phase_tokens ?? [], moment.clock_seconds),
      media: target.anchor_media_seconds,
    }))
    .filter((point) => Number.isFinite(point.progress) && Number.isFinite(point.media))
    .sort((left, right) => left.progress - right.progress);

  let anchor = 0;
  if (Number.isFinite(observedProgress) && anchors.length > 0) {
    let left = anchors[0];
    let right = anchors[1] ?? left;
    for (let index = 1; index < anchors.length; index += 1) {
      if (observedProgress <= anchors[index].progress) {
        right = anchors[index];
        left = anchors[index - 1];
        break;
      }
      left = anchors[index];
      right = anchors[index];
    }
    if (observedProgress < anchors[0].progress && anchors.length > 1) {
      left = anchors[0];
      right = anchors[1];
    }
    const span = right.progress - left.progress;
    const ratio = span > 0 ? (observedProgress - left.progress) / span : 0;
    anchor = Math.max(0, left.media + ratio * (right.media - left.media));
  }
  return {
    ...base,
    moment_id: null,
    match_mode: "approximate_event_sync",
    anchor_media_seconds: anchor,
    playback_start_seconds: Math.max(0, anchor - 2.5),
    available_in_media: true,
    calibrated: true,
  };
}

function detectedFocus(pack, observation, basis) {
  const names = primaryParticipantNames(observation);
  const matched = names.find((name) =>
    (pack.focus_aliases ?? []).some((alias) => includesAlias(name, alias))
  );
  if (matched) {
    const original = [observation?.participant_a, observation?.participant_b]
      .find((name) => normalized(name) === matched);
    return original || pack.focus_label;
  }
  if (basis === "sport_fallback") return observation?.participant_a || pack.focus_label;
  return pack.focus_label;
}

function template(text, focus) {
  return String(text ?? "").replaceAll("{focus}", focus);
}

export function listDemoIntelligencePacks() {
  return PACKS.map((pack) => ({
    id: pack.id,
    sport: pack.sport,
    event_label: pack.event_label,
    moments: pack.moments.length,
    checkpoints: pack.moments.map((moment) => ({ id: moment.id, label: moment.label })),
    research_categories: (pack.research ?? []).map((item) => item.category),
    disclosure: pack.disclosure,
  }));
}

export function selectDemoIntelligence(observation, { previous = null } = {}) {
  const matches = PACKS.map((pack) => ({ pack, match: packMatch(pack, observation) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match.score - a.match.score);
  if (!matches.length) return null;

  const { pack, match } = matches[0];
  const selection = match.exactEvidence
    ? selectMoment(pack, observation, previous)
    : {
        moment: null,
        index: -1,
        score: 0,
        status: "pending",
        reason: match.pendingReason ?? "event_identity_not_confirmed",
      };
  const { moment, index, score } = selection;
  const focus = detectedFocus(pack, observation, match.basis);
  const checkpointReady = Boolean(moment) && selection.status !== "pending";
  const interpolatedMoment = match.deterministic && !checkpointReady
    ? historicalTimelineMoment(pack, observation)
    : null;
  const resolvedMoment = moment ?? interpolatedMoment;
  const interpolatedReady = Boolean(interpolatedMoment);
  const deterministicReady = match.deterministic && Boolean(resolvedMoment);
  const mode = deterministicReady
    ? "precollected_event_replay"
    : match.exactEvidence
      ? "precollected_event_pending"
      : "illustrative_sport_template";
  const modelProbability = deterministicReady ? resolvedMoment.model_probability : null;
  const marketProbability = deterministicReady ? resolvedMoment.market_probability : null;
  const gap = deterministicReady
    ? Number(((modelProbability - marketProbability) * 100).toFixed(1))
    : null;
  const checkpointPlayback = deterministicReady && !interpolatedReady && selection.status === "ready"
    ? getDemoPlaybackTarget(pack.id, moment.id)
    : null;
  const playback = checkpointPlayback ??
    (match.exactEvidence && match.confidence >= MIN_STREAM_SWITCH_CONFIDENCE
      ? approximatePlaybackTarget(pack, observation)
      : null);

  return {
    mode,
    pack_id: pack.id,
    pack_label: mode === "illustrative_sport_template"
      ? `${pack.sport.replaceAll("_", " ")} intelligence template`
      : pack.event_label,
    detected_sport: canonicalSport(observation?.sport),
    detected_event: observation?.event_name || observation?.event_identity || "Recognized broadcast",
    match_basis: match.basis,
    match_confidence: match.confidence,
    checkpoint_status: deterministicReady ? (interpolatedReady ? "interpolated" : selection.status) : "pending",
    pending_reason: deterministicReady ? null : match.pendingReason ?? selection.reason,
    moment_selection_reason: interpolatedReady ? "historical_timeline_interpolation" : selection.reason,
    moment_id: resolvedMoment?.id ?? null,
    moment_label: resolvedMoment?.label ?? "Waiting for a stable scoreboard checkpoint",
    moment_index: index,
    moment_count: match.exactEvidence ? pack.moments.length : 0,
    moment_match_score: Number(score.toFixed(2)),
    playback,
    checkpoints: match.exactEvidence
      ? pack.moments.map((entry, entryIndex) => ({
          id: entry.id,
          label: entry.label,
          model_probability: entry.model_probability,
          market_probability: entry.market_probability,
          active: entryIndex === index,
        }))
      : [],
    focus,
    evidence: match.exactEvidence
      ? (resolvedMoment?.evidence ?? []).map((item) => ({ ...item, status: "ready" }))
      : [],
    research: match.exactEvidence
      ? (pack.research ?? []).map((item) => ({
          ...item,
          query: template(item.query, focus),
          result: template(item.result, focus),
          status: "ready",
          is_mock: true,
        }))
      : [],
    market: deterministicReady
      ? {
          question: template(resolvedMoment.market_question, focus),
          outcome: template(resolvedMoment.outcome, focus),
          model_probability: modelProbability,
          market_probability: marketProbability,
          gap_percentage_points: gap,
          is_mock: true,
          provider: "precollected_replay_market",
        }
      : null,
    confidence: deterministicReady
      ? Math.min(Number(resolvedMoment.confidence ?? 0), match.confidence)
      : match.confidence,
    key_factors: (resolvedMoment?.key_factors ?? []).map((factor) => template(factor, focus)),
    what_changed: template(resolvedMoment?.what_changed, focus),
    next_probability_trigger: template(resolvedMoment?.next_trigger, focus),
    summary: deterministicReady
      ? template(resolvedMoment.summary, focus)
      : "Event candidate identified. Waiting for a stable score, phase, or clock before loading replay probabilities.",
    alternate_markets: (resolvedMoment?.alternate_markets ?? []).map((market) => ({
      ...market,
      question: template(market.question, focus),
      outcome: template(market.outcome, focus),
    })),
    timeline_interpolation: interpolatedMoment?.timeline_interpolation ?? null,
    disclosure: pack.disclosure,
  };
}

export function analysisFromDemoIntelligence(intelligence, modelAnalysis = null) {
  if (!intelligence) return modelAnalysis;
  if (intelligence.mode === "precollected_event_pending") return null;
  if (intelligence.mode !== "precollected_event_replay" || !intelligence.market) {
    if (!modelAnalysis) return null;
    return {
      ...modelAnalysis,
      risk_note: [modelAnalysis.risk_note, intelligence.disclosure].filter(Boolean).join(" "),
      model: `${modelAnalysis.model ?? "cerebras"}+sport-replay-evidence-v1`,
    };
  }
  const deterministic = {
    event_summary: intelligence.summary,
    primary_market_question: intelligence.market.question,
    primary_outcome: intelligence.market.outcome,
    primary_probability: intelligence.market.model_probability,
    market_probability: intelligence.market.market_probability,
    gap_percentage_points: intelligence.market.gap_percentage_points,
    confidence: intelligence.confidence,
    alternate_markets: intelligence.alternate_markets,
    key_factors: intelligence.key_factors,
    what_changed: intelligence.what_changed,
    next_probability_trigger: intelligence.next_probability_trigger,
    risk_note: intelligence.disclosure,
    model: "bloom-replay-intelligence-v1",
  };
  if (!modelAnalysis) return deterministic;
  return {
    ...modelAnalysis,
    ...deterministic,
    key_factors: [...new Set([...deterministic.key_factors, ...(modelAnalysis.key_factors ?? [])])].slice(0, 6),
    model: `${modelAnalysis.model ?? "cerebras"}+bloom-replay-intelligence-v1`,
  };
}

function titleCase(value) {
  return String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayClock(sport, seconds) {
  if (seconds == null) return "";
  if (sport === "soccer") return `${Math.floor(seconds / 60)}'`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function rehearsalObservation(pack, moment) {
  const participantA = titleCase(pack.participant_groups?.[0]?.[0] ?? pack.focus_label);
  const participantB = titleCase(pack.participant_groups?.[1]?.[0] ?? "Opponent");
  const [scoreA, scoreB] = moment.scores?.[0] ?? [0, 0];
  return {
    sport: pack.sport,
    competition: pack.competition_tokens?.[0] ?? pack.event_label,
    event_name: pack.event_label,
    event_identity: `replay:${pack.id}`,
    event_format: pack.sport === "mma" ? "head_to_head" : "team_event",
    participants: [
      { name: participantA, role_or_position: "participant", score_or_status: String(scoreA), visible_rank: 0 },
      { name: participantB, role_or_position: "participant", score_or_status: String(scoreB), visible_rank: 0 },
    ],
    participant_a: participantA,
    participant_b: participantB,
    score_a: scoreA,
    score_b: scoreB,
    score_display: moment.label,
    phase: moment.phase_tokens?.[0] ?? "Replay checkpoint",
    clock: displayClock(pack.sport, moment.clock_seconds),
    event_status: "replay",
    possession_or_control: "UNKNOWN",
    situation: moment.situation_tokens?.join(" · ") ?? "Historical replay checkpoint",
    visible_facts: [moment.label],
    changes_across_frames: [moment.what_changed],
    confidence: 0.99,
  };
}

export function getDemoRehearsalInsight(packId, momentId = null) {
  const pack = PACKS.find((entry) => entry.id === packId);
  if (!pack) throw new Error(`unknown intelligence pack "${packId}"`);
  const moment = momentId
    ? pack.moments.find((entry) => entry.id === momentId)
    : pack.moments[0];
  if (!moment) {
    throw new Error(`unknown checkpoint for "${packId}"; known: ${pack.moments.map((entry) => entry.id).join(", ")}`);
  }
  const observation = rehearsalObservation(pack, moment);
  const intelligence = selectDemoIntelligence(observation);
  if (!intelligence || intelligence.mode !== "precollected_event_replay" ||
      intelligence.pack_id !== pack.id || intelligence.moment_id !== moment.id) {
    throw new Error(`checkpoint "${pack.id}/${moment.id}" does not resolve to itself`);
  }
  const analysis = analysisFromDemoIntelligence(intelligence);
  return {
    session_id: "session_rehearsal",
    source: "rehearsal",
    extraction: "precollected-rehearsal",
    rehearsal: { is_rehearsal: true, no_model_calls: true },
    observation,
    event_switch: {
      detected: false,
      from_event: null,
      to_event: {
        event_identity: observation.event_identity,
        sport: observation.sport,
        competition: observation.competition,
        event_name: observation.event_name,
      },
      reason: "explicit_rehearsal_checkpoint",
    },
    demo_intelligence: intelligence,
    market: {
      provider: intelligence.market.provider,
      probability: intelligence.market.market_probability,
      is_mock: true,
      question: intelligence.market.question,
      outcome: intelligence.market.outcome,
    },
    comparison: {
      model_probability: intelligence.market.model_probability,
      market_probability: intelligence.market.market_probability,
      gap_percentage_points: intelligence.market.gap_percentage_points,
      direction: intelligence.market.gap_percentage_points > 0
        ? "model_higher"
        : intelligence.market.gap_percentage_points < 0
          ? "model_lower"
          : "aligned",
      confidence: intelligence.confidence,
    },
    analysis,
    diagnostics: {
      analytics_error: null,
      analytics_skipped: true,
      analytics_skip_reason: "quota_free_rehearsal",
    },
    presentation: {
      status: "rehearsal",
      short_text: `Rehearsal only. ${analysis.event_summary}`,
      spoken_text: `Rehearsal only. ${analysis.event_summary}`,
    },
  };
}
