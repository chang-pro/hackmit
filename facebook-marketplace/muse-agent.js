// Drives the muse.ai agent through a real logged-in Chrome tab.
//
// muse.ai is behind auth and has no API we can call, so the only way in is the
// session already sitting in the user's browser. We attach to that tab over
// CDP, type an instruction, and read the reply back. muse.ai is what actually
// touches Facebook Marketplace — this file never does.
//
// The DOM selectors are configuration, not constants: a chat UI's markup moves
// without notice, and a hardcoded selector fails as a confusing timeout. Run
// `probe()` against the live tab to rediscover them.

import { CdpError, CdpSession, findTarget, openTarget } from "./cdp.js";

const MUSE_URL = process.env.MUSE_URL ?? "https://muse.ai";
const MUSE_MATCH = process.env.MUSE_URL_MATCH ?? "muse.ai";

// Every muse.ai chat lives at the same URL, so a chat cannot be targeted by
// link — it has to be selected by name in the sidebar. All Marketplace posting
// goes through ONE dedicated chat; sending a "post this to Facebook"
// instruction into the wrong thread is the failure worth engineering against.
const MUSE_CHAT = process.env.MUSE_CHAT ?? "post items to facebook marketplace";
const THREAD_ROW = '[data-testid="hatch-thread-row"]';

// Read off the live logged-in page on 2026-09-19. muse.ai is a Tailwind app
// with no stable data-testid on the chat bubbles, so these are class-based and
// WILL break when the markup changes — rerun probe() and update them.
//
// The message selector deliberately excludes the user's own bubble. Matching
// every bubble would make awaitReply() return the echo of what we just sent.
export const selectors = {
  input: process.env.MUSE_INPUT_SELECTOR ?? 'textarea[aria-label="Message"]',
  send: process.env.MUSE_SEND_SELECTOR ?? null, // Enter submits; no button needed
  message:
    process.env.MUSE_MESSAGE_SELECTOR ??
    ".hatch-chat-groupable-bubble:not(.bg-chat-user-bubble)",
};

function requireSelectors() {
  const missing = ["input", "message"]
    .filter((name) => !selectors[name]);
  if (missing.length > 0) {
    throw new CdpError(
      `muse selectors not configured: ${missing.join(", ")}. Run probe() against the live tab ` +
        `and set MUSE_INPUT_SELECTOR / MUSE_SEND_SELECTOR / MUSE_MESSAGE_SELECTOR.`
    );
  }
}

async function session({ open = true } = {}) {
  let target = await findTarget(MUSE_MATCH);
  if (!target && open) {
    target = await openTarget(MUSE_URL);
    // A freshly opened tab needs a moment before its debugger URL is live.
    await new Promise((done) => setTimeout(done, 1_500));
    target = (await findTarget(MUSE_MATCH)) ?? target;
  }
  if (!target) throw new CdpError(`no muse.ai tab open and could not open ${MUSE_URL}`);
  return CdpSession.attach(target);
}

// Reports what the page actually looks like, so the selectors above can be
// filled in from evidence instead of guessed.
export async function probe() {
  const cdp = await session();
  try {
    return await cdp.evaluate(`(() => {
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        role: el.getAttribute("role"),
        id: el.id || null,
        testid: el.getAttribute("data-testid"),
        placeholder: el.getAttribute("placeholder"),
        ariaLabel: el.getAttribute("aria-label"),
        classes: (el.className && typeof el.className === "string"
          ? el.className.split(/\\s+/).slice(0, 4) : []),
        text: (el.innerText || "").trim().slice(0, 60),
      });
      const inputs = [...document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
      )].map(describe);
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .slice(0, 25).map(describe);
      return { url: location.href, title: document.title, inputs, buttons };
    })()`);
  } finally {
    cdp.close();
  }
}

// Returns the name of the chat currently open. The open sidebar row carries
// aria-current="page"; the page header is not reliable (it shows the agent's
// name, or nothing at all, depending on layout).
async function currentChat(cdp) {
  return cdp.evaluate(`(() => {
    const row = document.querySelector(
      ${JSON.stringify(THREAD_ROW)} + '[aria-current="page"]'
    );
    return row ? (row.innerText || "").trim().split("\\n")[0] : null;
  })()`);
}

function matches(text, wanted) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(text);
  const b = norm(wanted);
  return a === b || a.includes(b) || b.includes(a);
}

// Clicks the sidebar row for the wanted chat. Returns false when no row
// matches, which the caller must treat as fatal rather than sending anyway.
export async function selectChat(cdp, wanted = MUSE_CHAT) {
  if (matches(await currentChat(cdp), wanted)) return true;

  const rows = await cdp.evaluate(`(() => {
    return [...document.querySelectorAll(${JSON.stringify(THREAD_ROW)})]
      .map((e, i) => ({ i, text: (e.innerText || "").trim().split("\\n")[0].slice(0, 80) }));
  })()`);
  const target = (rows ?? []).find((r) => matches(r.text, wanted));
  if (!target) return false;

  await cdp.evaluate(`(() => {
    const rows = document.querySelectorAll(${JSON.stringify(THREAD_ROW)});
    const row = rows[${target.i}];
    if (row) row.click();
    return true;
  })()`);
  await new Promise((done) => setTimeout(done, 1_500));
  return matches(await currentChat(cdp), wanted);
}

function messageCountExpression() {
  return `document.querySelectorAll(${JSON.stringify(selectors.message)}).length`;
}

function lastMessageExpression() {
  return `(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selectors.message)});
    const last = nodes[nodes.length - 1];
    return last ? (last.innerText || "").trim() : null;
  })()`;
}

// Waits for the reply to stop growing rather than for the first token, so a
// streaming answer is not truncated mid-sentence.
async function awaitReply(cdp, priorCount, { timeoutMs, settleMs }) {
  const deadline = Date.now() + timeoutMs;
  let text = null;
  let stableSince = null;

  while (Date.now() < deadline) {
    const count = await cdp.evaluate(messageCountExpression());
    if (count > priorCount) {
      const current = await cdp.evaluate(lastMessageExpression());
      if (current && current === text) {
        if (stableSince && Date.now() - stableSince >= settleMs) return text;
        stableSince ??= Date.now();
      } else {
        text = current;
        stableSince = null;
      }
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  if (text) return text; // a slow stream that never settled still beats nothing
  throw new CdpError(`muse.ai did not reply within ${timeoutMs}ms`);
}

export async function ask(
  instruction,
  { timeoutMs = 120_000, settleMs = 1_500, chat = MUSE_CHAT, requireChat = true } = {}
) {
  requireSelectors();
  const cdp = await session();
  try {
    await cdp.waitFor(selectors.input);
    if (chat) {
      const onTarget = await selectChat(cdp, chat);
      // Refusing beats posting a Marketplace listing into a personal thread.
      if (!onTarget && requireChat) {
        throw new CdpError(
          `could not switch to the "${chat}" chat, and refused to send into ` +
            `"${await currentChat(cdp)}" instead. Open that chat in the CDP Chrome window, ` +
            `or set MUSE_CHAT to its exact name.`
        );
      }
    }
    const priorCount = await cdp.evaluate(messageCountExpression());
    await cdp.typeInto(selectors.input, instruction);
    if (selectors.send) await cdp.click(selectors.send);
    else await cdp.pressEnter();
    const reply = await awaitReply(cdp, priorCount, { timeoutMs, settleMs });
    return { instruction, reply, asked_at: new Date().toISOString() };
  } finally {
    cdp.close();
  }
}

const CONDITION_TEXT = {
  like_new: "Like new",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  broken: "For parts / not working",
};

// Shaped by what the agent said it actually needs, asked directly on
// 2026-09-19: a listing cannot go live without photos, category, condition and
// a location as lat/lon — a typed city name is not enough. Anything missing is
// stated as missing rather than invented, so the draft stalls on a question
// instead of going live with a made-up location.
//
// Two things the agent told us it will NOT do, so we do not pretend otherwise:
//   - it builds a DRAFT; publishing needs a human tap, every time
//   - it does not message buyers or negotiate after a listing is live
// The floor is therefore recorded for our own later use, not sent as an
// instruction the agent has already declined to follow.
export function listingInstruction(item, { photoUrls = [], location = null, category = null } = {}) {
  const price = Number(item?.price_usd) || 0;
  const lines = [
    `Build a Facebook Marketplace listing DRAFT. Do not publish it.`,
    `Title: ${item.label}`,
    `Condition: ${CONDITION_TEXT[item.condition] ?? "Good"}`,
    `Asking price: $${price}`,
    category ? `Category: ${category}` : `Category: pick the closest fit and tell me which you chose.`,
  ];

  if (photoUrls.length > 0) lines.push(`Photos: ${photoUrls.join(" ")}`);
  else lines.push(`Photos: none attached yet — tell me this is blocking and I will send them.`);

  if (location?.lat != null && location?.lon != null) {
    lines.push(`Location: ${location.lat},${location.lon}`);
  } else {
    lines.push(`Location: not provided. Do not guess one — ask me for the lat/lon.`);
  }

  lines.push(
    `Write a short honest description from the title and condition alone.`,
    `Do not invent specifications, model numbers, accessories, included items, or history.`,
    `Reply with the draft you built and anything still missing before it could go live.`
  );
  return lines.join(" ");
}

// Named draftListing, not publishListing: the agent builds a draft and the
// publish needs a human tap. Calling it "publish" would misdescribe what
// happens and set the wrong expectation on stage.
export async function draftListing(item, options = {}) {
  const result = await ask(listingInstruction(item, options), options);
  return {
    ...result,
    item_id: item.id ?? null,
    label: item.label,
    price_usd: Number(item?.price_usd) || 0,
    floor_usd: options.floorUsd ?? Math.max(1, Math.round((Number(item?.price_usd) || 0) * 0.85)),
    status: "draft_requested",
  };
}
