// BloomKnights analyst chat — Gemini 3.1 Flash-Lite grounded in the live insight.
// The API key stays server-side. Never return secrets or invent live market quotes.

export const GEMINI_CHAT_MODEL =
  process.env.GEMINI_CHAT_MODEL ?? "gemini-3.1-flash-lite";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_QUESTION_CHARS = 1_200;
const MAX_HISTORY_TURNS = 8;
const MAX_CONTEXT_CHARS = 8_000;

const SYSTEM_INSTRUCTION = [
  "You are BloomKnights Analyst, a concise sports-probability co-pilot embedded in a live broadcast viewer.",
  "Answer only from the supplied live insight context plus general sports reasoning.",
  "Be precise about model probability, market-implied probability, and the gap between them.",
  "If market values are mocked, replayed, or historical, say so plainly.",
  "Never claim a guaranteed edge, never give trade execution advice, and never invent live quotes.",
  "If the context is missing a fact, say what is unknown instead of guessing.",
  "Keep answers short: usually 2–5 sentences, or a tight bullet list when comparing factors.",
].join(" ");

function compactInsight(insight) {
  if (!insight || typeof insight !== "object") return null;
  const observation = insight.observation ?? null;
  const analysis = insight.analysis ?? null;
  const intelligence = insight.demo_intelligence ?? null;
  const comparison = insight.comparison ?? null;
  const market = insight.market ?? null;
  const presentation = insight.presentation ?? null;
  return {
    source: insight.source ?? null,
    rehearsal: insight.rehearsal ?? null,
    observation: observation && {
      sport: observation.sport,
      competition: observation.competition,
      event_name: observation.event_name,
      participants: observation.participants,
      participant_a: observation.participant_a,
      participant_b: observation.participant_b,
      score_a: observation.score_a,
      score_b: observation.score_b,
      score_display: observation.score_display,
      phase: observation.phase,
      clock: observation.clock,
      situation: observation.situation,
      visible_facts: observation.visible_facts,
      confidence: observation.confidence,
    },
    analysis: analysis && {
      event_summary: analysis.event_summary,
      primary_market_question: analysis.primary_market_question,
      primary_outcome: analysis.primary_outcome,
      primary_probability: analysis.primary_probability,
      market_probability: analysis.market_probability,
      gap_percentage_points: analysis.gap_percentage_points,
      confidence: analysis.confidence,
      key_factors: analysis.key_factors,
      what_changed: analysis.what_changed,
      next_probability_trigger: analysis.next_probability_trigger,
      alternate_markets: analysis.alternate_markets,
      risk_note: analysis.risk_note,
    },
    market: market && {
      provider: market.provider,
      probability: market.probability,
      is_mock: market.is_mock,
      question: market.question,
      outcome: market.outcome,
    },
    comparison,
    intelligence: intelligence && {
      mode: intelligence.mode,
      pack_label: intelligence.pack_label,
      moment_label: intelligence.moment_label,
      match_confidence: intelligence.match_confidence,
      focus: intelligence.focus,
      key_factors: intelligence.key_factors,
      what_changed: intelligence.what_changed,
      next_probability_trigger: intelligence.next_probability_trigger,
      disclosure: intelligence.disclosure,
      evidence: (intelligence.evidence ?? []).slice(0, 4).map((entry) => ({
        provider: entry.provider,
        label: entry.label,
        detail: entry.detail,
      })),
      research: (intelligence.research ?? []).slice(0, 4).map((entry) => ({
        category: entry.category,
        query: entry.query,
        result: entry.result,
        is_mock: entry.is_mock,
      })),
    },
    presentation: presentation && {
      status: presentation.status,
      short_text: presentation.short_text,
    },
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && (entry.role === "user" || entry.role === "model"))
    .map((entry) => ({
      role: entry.role,
      text: String(entry.text ?? "").trim().slice(0, MAX_QUESTION_CHARS),
    }))
    .filter((entry) => entry.text)
    .slice(-MAX_HISTORY_TURNS);
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

export function geminiChatStatus() {
  return {
    configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    model: GEMINI_CHAT_MODEL,
  };
}

export async function askGeminiAnalyst({
  question,
  insight = null,
  history = [],
  fetchImpl = fetch,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("Analyst chat unavailable: GEMINI_API_KEY is not set");
    error.statusCode = 503;
    throw error;
  }

  const cleanedQuestion = String(question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!cleanedQuestion) {
    const error = new Error("question is required");
    error.statusCode = 400;
    throw error;
  }

  const context = compactInsight(insight);
  const contextJson = context
    ? JSON.stringify(context).slice(0, MAX_CONTEXT_CHARS)
    : "null";
  const turns = normalizeHistory(history);
  const contents = [
    ...turns.map((entry) => ({
      role: entry.role,
      parts: [{ text: entry.text }],
    })),
    {
      role: "user",
      parts: [
        {
          text: [
            "Live insight context (JSON):",
            contextJson,
            "",
            `Analyst question: ${cleanedQuestion}`,
          ].join("\n"),
        },
      ],
    },
  ];

  const response = await fetchImpl(
    `${API_BASE}/models/${GEMINI_CHAT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 700,
        },
      }),
    }
  );

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || raw.slice(0, 280) || response.statusText;
    const error = new Error(`Analyst chat failed (${response.status}): ${detail}`);
    error.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }

  const answer = extractText(payload);
  if (!answer) {
    const error = new Error("Analyst chat returned an empty response");
    error.statusCode = 502;
    throw error;
  }

  return {
    answer,
    model: GEMINI_CHAT_MODEL,
    grounded: Boolean(context),
  };
}
