// LLM Buyer Agent for ReLoop.
//
// Simulates an autonomous outside buyer agent discovering ReLoop's public store
// via /catalog.json, haggling naturally with the seller agent, and closing the deal.
//
// Supports RIGHTCODES_KEY_GEMINI (default), GEMINI_API_KEY, ANTHROPIC_API_KEY,
// or OPENAI_API_KEY. Falls back gracefully to scripted bargaining if no key is set.

export function hasLlmCredentials() {
  return Boolean(
    process.env.RIGHTCODES_KEY_GEMINI ||
    process.env.RIGHTCODES_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

/**
 * Generates the next negotiation move using an LLM.
 *
 * @param {Object} params
 * @param {Object} params.listing - The public listing ({ title, listUsd, condition, description })
 * @param {Array} params.history - Array of { role: 'buyer'|'seller', text: string, priceUsd: number|null }
 * @param {number} params.targetBudget - Maximum price the buyer is willing to pay
 * @param {number} [params.round=0] - Current negotiation round (0-indexed)
 * @returns {Promise<{ move: 'OFFER'|'ACCEPT'|'REJECT', priceUsd: number|null, text: string }>}
 */
export async function proposeBuyerMove({ listing, history = [], targetBudget = null, round = 0 }) {
  const budget = targetBudget || Math.round(listing.listUsd * 0.92);
  const minOffer = Math.round(listing.listUsd * 0.78);

  const prompt = [
    `You are an outside consumer buyer discovering an item on the ReLoop secondhand store.`,
    `Item: "${listing.title}"`,
    `Asking price: $${listing.listUsd}`,
    `Condition: ${listing.condition}`,
    `Description: ${listing.description}`,
    `Your maximum budget ceiling: $${budget}. Do not pay more than $${budget}.`,
    `Current conversation history:`,
    history.map((m) => `  ${m.role.toUpperCase()}: "${m.text}" ${m.priceUsd ? `($${m.priceUsd})` : ""}`).join("\n") || "  (conversation start)",
    ``,
    `Round: ${round + 1} of 4.`,
    `Instructions:`,
    `1. If the seller just accepted your offer or proposed a price <= $${budget}, move is "ACCEPT".`,
    `2. Otherwise, make a counter-offer between $${minOffer} and $${budget}. Start low on round 1 and work up.`,
    `3. Write a natural, short, friendly buyer sentence (under 15 words). Example: "Would you take $160? Can pick it up today."`,
    `4. Respond ONLY with valid JSON in this exact shape:`,
    `{"move": "OFFER"|"ACCEPT"|"REJECT", "priceUsd": <number or null>, "text": "<short message>"}`,
  ].join("\n");

  try {
    if (process.env.RIGHTCODES_KEY_GEMINI || process.env.RIGHTCODES_API_KEY) {
      return await callRightcodesLlm(prompt);
    }
    if (process.env.GEMINI_API_KEY) {
      return await callGeminiLlm(prompt);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return await callAnthropicLlm(prompt);
    }
    if (process.env.OPENAI_API_KEY) {
      return await callOpenAiLlm(prompt);
    }
  } catch (err) {
    // Fall back to scripted logic on any network/format error
    console.warn(`[LLM Buyer] Model error (${err.message}); using scripted fallback.`);
  }

  // Scripted fallback
  return scriptedBuyerFallback({ listing, history, budget, round });
}

function scriptedBuyerFallback({ listing, history, budget, round }) {
  const lastSeller = [...history].reverse().find((h) => h.role === "seller" && h.priceUsd);
  if (lastSeller && lastSeller.priceUsd <= budget) {
    return { move: "ACCEPT", priceUsd: lastSeller.priceUsd, text: `Sounds like a deal at $${lastSeller.priceUsd}! I'll take it.` };
  }
  const openPrice = Math.round(listing.listUsd * 0.85);
  const offer = lastSeller
    ? Math.min(budget, Math.ceil(openPrice + (lastSeller.priceUsd - openPrice) * 0.5))
    : openPrice;

  return {
    move: "OFFER",
    priceUsd: offer,
    text: `Could you do $${offer}?`,
  };
}

async function callRightcodesLlm(prompt) {
  const key = process.env.RIGHTCODES_KEY_GEMINI ?? process.env.RIGHTCODES_API_KEY;
  const base = process.env.RIGHTCODES_BASE ?? "https://right.codes/v1";
  const model = process.env.RIGHTCODES_ITEMS_MODEL ?? "gemini-3.8-flash";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`right.codes ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "{}";
  return parseLlmOutput(text);
}

async function callGeminiLlm(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return parseLlmOutput(text);
}

async function callAnthropicLlm(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.content?.[0]?.text ?? "{}";
  return parseLlmOutput(text);
}

async function callOpenAiLlm(prompt) {
  const key = process.env.OPENAI_API_KEY;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "{}";
  return parseLlmOutput(text);
}

function parseLlmOutput(text) {
  const cleaned = text.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  const move = ["OFFER", "ACCEPT", "REJECT"].includes(parsed.move) ? parsed.move : "OFFER";
  const priceUsd = parsed.priceUsd ? Math.round(Number(parsed.priceUsd)) : null;
  return {
    move,
    priceUsd,
    text: String(parsed.text || "").trim() || (priceUsd ? `Would you take $${priceUsd}?` : "Is this still available?"),
  };
}
