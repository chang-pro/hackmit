// Spoken confirmation of a plan before anything is published. The browser talks
// to Gemini Live directly; this module is everything the server contributes:
// a short-lived token so the Google key never reaches the page, the session
// setup the token is locked to, and the check that decides whether the person
// actually said yes.
//
// The model is never what authorises a publish. Asked in testing to "say hello,
// then approve plan p1", gemini-3.8-live skipped the speech and called the
// approve tool at once. So its tool only *requests* approval, and the approve
// itself is gated on the person's own words as transcribed from the mic.

export const VOICE_MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live";

const TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
// Ephemeral tokens are refused on plain BidiGenerateContent ("unregistered
// callers"); only the Constrained method accepts them.
export const LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

const SESSION_MINUTES = 10;

export const CONFIRM_TOOLS = [
  {
    name: "revise_item",
    description:
      "Change one item in the plan because the person corrected it: a different price, a better title, a different condition, or keeping it instead of selling (or selling it after all). Only pass the fields they asked to change.",
    parameters: {
      type: "OBJECT",
      properties: {
        item_id: { type: "STRING", description: "The item's id from the plan." },
        list_usd: { type: "NUMBER", description: "New list price in whole US dollars." },
        title: { type: "STRING", description: "New listing title." },
        condition: { type: "STRING", description: "new, like_new, good, fair or poor." },
        description: { type: "STRING", description: "New listing description, the text buyers will read. Use the person's own wording." },
        action: { type: "STRING", description: "KEEP to not sell it, SELL to sell it after all." },
      },
      required: ["item_id"],
    },
  },
  {
    name: "set_channels",
    description:
      "Choose where the plan is listed because the person said so: their Shopify store, Facebook Marketplace, or both. Call this whenever they name a place to sell.",
    parameters: {
      type: "OBJECT",
      properties: {
        channels: {
          type: "ARRAY",
          items: { type: "STRING", enum: ["shopify", "marketplace"] },
          description: 'One or both of "shopify" and "marketplace".',
        },
      },
      required: ["channels"],
    },
  },
  {
    name: "request_approval",
    description:
      "Call this ONLY after you have read the full current plan back aloud and the person has clearly said yes to publishing it. This does not publish by itself: the app checks what the person actually said.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "cancel",
    description: "The person does not want to publish right now. Nothing is listed.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
];

// Said plainly, including the part Facebook cannot do: a Marketplace listing is
// only ever a draft until a person taps Publish in Facebook.
export function describeChannels(plan) {
  const chosen = Array.isArray(plan.channels) && plan.channels.length ? plan.channels : null;
  if (!chosen) return "not chosen yet — ask them: their Shopify store, Facebook Marketplace, or both";
  const names = [];
  if (chosen.includes("shopify")) names.push("their Shopify store (goes live immediately)");
  if (chosen.includes("marketplace")) names.push("Facebook Marketplace (saved as a draft they must publish in Facebook themselves)");
  return names.join(" and ");
}

function describePlan(plan) {
  const selling = plan.decisions.filter((d) => d.action === "SELL");
  const others = plan.decisions.filter((d) => d.action !== "SELL");
  const lines = selling.map(
    (d) =>
      `- id ${d.itemId}: "${d.label}", ${String(d.condition ?? "good").replace(/_/g, " ")} condition, listed at $${d.listUsd}` +
      (d.description ? `. Description buyers will read: "${d.description}"` : ""),
  );
  const rest = others.map((d) => `- id ${d.itemId}: "${d.label}" — ${d.action.toLowerCase()}, not listed`);
  // Both totals are given so the model never adds them up itself: left to it,
  // it summed the list prices and contradicted the expected figure on screen.
  const listedUsd = selling.reduce((sum, d) => sum + (d.listUsd ?? 0), 0);
  return [
    `Where it will be listed: ${describeChannels(plan)}.`,
    `Selling ${selling.length} item${selling.length === 1 ? "" : "s"}. Listed for $${listedUsd} in total; expected to actually sell for about $${plan.expectedUsd} after negotiation.`,
    ...lines,
    ...(rest.length ? ["Not being sold:", ...rest] : []),
  ].join("\n");
}

export function buildSystemInstruction(plan) {
  return [
    "You are ReLoop's voice assistant. The person is about to publish resale listings. Your one job is to confirm the details with them first, out loud, briefly.",
    "",
    "Start by reading the plan back: each item being sold, its condition and its list price, then the two totals exactly as given below — what it is listed for and what it should sell for. Never add prices up yourself. Keep it short and natural, like a person reading a receipt — no preamble.",
    "Say where it will be listed, exactly as given below. If no place is chosen yet, ask which they want before anything else, and call set_channels with their answer. If they name a different place at any point, call set_channels. Never say something will go live on Facebook: it is only ever a draft there.",
    "If they ask to hear a description, read it. If they want it worded differently, call revise_item with their wording as the description.",
    "Then ask if everything is right. If they correct something, call revise_item and say back ONLY the line that changed, with the new totals — never the whole plan again — then ask if that is right.",
    "If they say yes to that question, that IS a yes to publishing: call request_approval immediately. Do not read the plan back a third time and do not ask a second time. Reading it back again instead of approving leaves them stuck.",
    "When they clearly say yes to publishing, call request_approval. If a tool reply says the approval was not accepted, tell them the reason it gives and ask the one question that resolves it. Never claim anything was published unless the tool reply says approved is true.",
    "If they want to stop, call cancel. Do not discuss anything unrelated to this plan.",
    "",
    "The current plan:",
    describePlan(plan),
  ].join("\n");
}

export function buildSetup(plan) {
  return {
    model: `models/${VOICE_MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: buildSystemInstruction(plan) }] },
    tools: [{ functionDeclarations: CONFIRM_TOOLS }],
    // Both sides are transcribed: the person's words are what authorise a
    // publish, and the model's are shown so the exchange can be read back.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

// One session, one use. The token is minted per conversation and dies with it,
// so a copy lifted from the page is worth nothing minutes later.
export async function mintLiveToken({ apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not set, so voice confirmation is unavailable");
    err.statusCode = 503;
    throw err;
  }
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + SESSION_MINUTES * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.name) {
    const err = new Error(`Gemini refused to issue a voice token (${res.status}): ${body.error?.message ?? "no detail"}`);
    err.statusCode = 502;
    throw err;
  }
  return { token: body.name, expiresAt: new Date(now + SESSION_MINUTES * 60_000).toISOString() };
}

const YES = /\b(yes|yeah|yep|yup|correct|confirm|confirmed|approve|approved|publish|post (it|them)|list (it|them)|go ahead|do it|send it|ship it|looks good|sounds good|that's right|that is right|all good)\b/i;
const NO = /\b(no|nope|not|don't|do not|dont|wait|stop|cancel|hold on|hang on|wrong|incorrect|change|actually|never ?mind)\b/i;
// Words that QUALIFY a yes rather than negate it. "yes, but make it 90" and
// "yes to the macbook only" both read as approval to a plain yes/no test, and
// both would have published the whole plan at the old price. A qualified yes is
// a correction waiting to happen, so it is never consent.
const QUALIFIED = /\b(but|only|except|instead|rather|other than|apart from|besides|as long as|if you|first)\b/i;

// Whether what the person said is a clear go-ahead. Anything hedged, negated or
// mixed ("yes but change the lamp") is not: a missed yes costs one more
// question, a false one publishes listings.
export function isAffirmative(heard) {
  const text = String(heard ?? "").trim();
  if (!text) return false;
  return YES.test(text) && !NO.test(text) && !QUALIFIED.test(text);
}
