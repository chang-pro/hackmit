// Deterministic demo-intelligence router.
//
// Cerebras owns visual identification. Once it has identified a supported
// broadcast, this module selects the matching precollected evidence pack and
// the closest moment in that event. The returned payload is deliberately
// explicit about historical/replayed sources and illustrative market prices.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(HERE, "..", "..", "packages", "fixtures", "demo-intelligence");
const PACK_FILES = [
  "world-cup-2022-final.json",
  "nba-finals-2016-game-7.json",
  "super-bowl-li.json",
  "ufc-229.json",
];

const PACKS = PACK_FILES.map((name) =>
  Object.freeze(JSON.parse(readFileSync(join(PACK_DIR, name), "utf8")))
);

function normalized(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalSport(value) {
  const sport = normalized(value).replaceAll(" ", "_");
  return {
    nba: "basketball",
    nfl: "american_football",
    football: "american_football",
    american_football: "american_football",
    ufc: "mma",
  }[sport] ?? sport;
}

function observationText(observation) {
  return normalized([
    observation?.competition,
    observation?.event_name,
    observation?.event_identity,
    observation?.participant_a,
    observation?.participant_b,
    ...(observation?.participants ?? []).map((participant) => participant?.name),
  ].join(" "));
}

function participantNames(observation) {
  return [
    observation?.participant_a,
    observation?.participant_b,
    ...(observation?.participants ?? []).map((participant) => participant?.name),
  ].map(normalized).filter(Boolean);
}

function includesAlias(text, alias) {
  const needle = normalized(alias);
  return needle.length > 1 && (` ${text} `).includes(` ${needle} `);
}

function packMatch(pack, observation) {
  if (Number(observation?.confidence ?? 0) < 0.55) return null;
  if (canonicalSport(observation?.sport) !== pack.sport) return null;
  const text = observationText(observation);
  const names = participantNames(observation);
  const groupsMatched = (pack.participant_groups ?? []).filter((group) =>
    group.some((alias) => names.some((name) => includesAlias(name, alias)))
  ).length;
  const competitionMatched = (pack.competition_tokens ?? []).some((token) =>
    includesAlias(text, token)
  );
  const eventMatched = (pack.event_tokens ?? []).filter((token) => includesAlias(text, token)).length;

  if (groupsMatched >= 2) return { score: 100 + eventMatched, basis: "participants", confidence: 0.98 };
  if (competitionMatched && groupsMatched >= 1) {
    return { score: 80 + eventMatched, basis: "competition_and_participant", confidence: 0.92 };
  }
  if (eventMatched >= 2) {
    return { score: 60 + eventMatched, basis: "event_context", confidence: 0.84 };
  }
  return { score: 10, basis: "sport_fallback", confidence: 0.66 };
}

function clockSeconds(value) {
  const text = String(value ?? "").trim();
  const countdown = text.match(/^(\d{1,2}):(\d{2})$/);
  if (countdown) return Number(countdown[1]) * 60 + Number(countdown[2]);
  const minute = text.match(/(\d{1,3})/);
  return minute ? Number(minute[1]) * 60 : null;
}

function momentScore(moment, observation) {
  let score = 0;
  const a = Number(observation?.score_a);
  const b = Number(observation?.score_b);
  if (Number.isFinite(a) && Number.isFinite(b) && Array.isArray(moment.scores)) {
    if (moment.scores.some(([left, right]) => left === a && right === b)) score += 12;
  }
  const phase = normalized(observation?.phase);
  if ((moment.phase_tokens ?? []).some((token) => phase.includes(normalized(token)))) score += 5;
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
  const ranked = pack.moments
    .map((moment, index) => ({ moment, index, score: momentScore(moment, observation) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  let selected = ranked[0];
  if (selected.score === 0 && previous?.pack_id === pack.id) {
    const priorIndex = pack.moments.findIndex((moment) => moment.id === previous.moment_id);
    if (priorIndex >= 0) selected = { moment: pack.moments[priorIndex], index: priorIndex, score: 0 };
  }
  if (previous?.pack_id === pack.id) {
    const priorIndex = pack.moments.findIndex((moment) => moment.id === previous.moment_id);
    if (priorIndex > selected.index) {
      selected = { moment: pack.moments[priorIndex], index: priorIndex, score: selected.score };
    }
  }
  return selected;
}

function detectedFocus(pack, observation, basis) {
  const names = participantNames(observation);
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
  const { moment, index, score } = selectMoment(pack, observation, previous);
  const focus = detectedFocus(pack, observation, match.basis);
  const modelProbability = moment.model_probability;
  const marketProbability = moment.market_probability;
  const gap = Number(((modelProbability - marketProbability) * 100).toFixed(1));

  return {
    mode: match.basis === "sport_fallback" ? "illustrative_sport_template" : "precollected_event_replay",
    pack_id: pack.id,
    pack_label: match.basis === "sport_fallback"
      ? `${pack.sport.replaceAll("_", " ")} demo intelligence template`
      : pack.event_label,
    detected_sport: canonicalSport(observation?.sport),
    detected_event: observation?.event_name || observation?.event_identity || "Recognized broadcast",
    match_basis: match.basis,
    match_confidence: match.confidence,
    moment_id: moment.id,
    moment_label: moment.label,
    moment_index: index,
    moment_count: pack.moments.length,
    moment_match_score: Number(score.toFixed(2)),
    checkpoints: pack.moments.map((entry, entryIndex) => ({
      id: entry.id,
      label: entry.label,
      model_probability: entry.model_probability,
      market_probability: entry.market_probability,
      active: entryIndex === index,
    })),
    focus,
    evidence: (moment.evidence ?? []).map((item) => ({ ...item, status: "ready" })),
    research: (pack.research ?? []).map((item) => ({
      ...item,
      query: template(item.query, focus),
      result: template(item.result, focus),
      status: "ready",
      is_mock: true,
    })),
    market: {
      question: template(moment.market_question, focus),
      outcome: template(moment.outcome, focus),
      model_probability: modelProbability,
      market_probability: marketProbability,
      gap_percentage_points: gap,
      is_mock: true,
      provider: "precollected_demo_market",
    },
    confidence: moment.confidence,
    key_factors: moment.key_factors.map((factor) => template(factor, focus)),
    what_changed: template(moment.what_changed, focus),
    next_probability_trigger: template(moment.next_trigger, focus),
    summary: template(moment.summary, focus),
    alternate_markets: (moment.alternate_markets ?? []).map((market) => ({
      ...market,
      question: template(market.question, focus),
      outcome: template(market.outcome, focus),
    })),
    disclosure: pack.disclosure,
  };
}

export function analysisFromDemoIntelligence(intelligence, modelAnalysis = null) {
  if (!intelligence) return modelAnalysis;
  if (intelligence.mode === "illustrative_sport_template") {
    if (!modelAnalysis) return null;
    return {
      ...modelAnalysis,
      risk_note: [modelAnalysis.risk_note, intelligence.disclosure].filter(Boolean).join(" "),
      model: `${modelAnalysis.model ?? "cerebras"}+sport-demo-evidence-v1`,
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
    model: "bloom-demo-intelligence-v1",
  };
  if (!modelAnalysis) return deterministic;
  return {
    ...modelAnalysis,
    ...deterministic,
    event_summary: modelAnalysis.event_summary || deterministic.event_summary,
    key_factors: [...new Set([...deterministic.key_factors, ...(modelAnalysis.key_factors ?? [])])].slice(0, 6),
    model: `${modelAnalysis.model ?? "cerebras"}+bloom-demo-intelligence-v1`,
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
    event_identity: `demo:${pack.id}`,
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
  if (!pack) throw new Error(`unknown demo intelligence pack "${packId}"`);
  const moment = momentId
    ? pack.moments.find((entry) => entry.id === momentId)
    : pack.moments[0];
  if (!moment) {
    throw new Error(`unknown checkpoint for "${packId}"; known: ${pack.moments.map((entry) => entry.id).join(", ")}`);
  }
  const observation = rehearsalObservation(pack, moment);
  const intelligence = selectDemoIntelligence(observation);
  if (!intelligence || intelligence.pack_id !== pack.id || intelligence.moment_id !== moment.id) {
    throw new Error(`demo checkpoint "${pack.id}/${moment.id}" does not resolve to itself`);
  }
  const analysis = analysisFromDemoIntelligence(intelligence);
  return {
    session_id: "session_demo_rehearsal",
    source: "demo_rehearsal",
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
    diagnostics: { analytics_error: null },
    presentation: {
      status: "demo_rehearsal",
      short_text: `Rehearsal only. ${analysis.event_summary}`,
      spoken_text: `Rehearsal only. ${analysis.event_summary}`,
    },
  };
}
