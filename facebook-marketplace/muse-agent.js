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

// Returns the name of the chat currently open, read from the header.
async function currentChat(cdp) {
  return cdp.evaluate(`(() => {
    const h = document.querySelector("h1, h2");
    return h ? (h.innerText || "").trim() : null;
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
      .map((e, i) => ({ i, text: (e.innerText || "").trim().split("\n")[0].slice(0, 80) }));
  })()`);
  const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

// The instruction is explicit about the price floor so muse.ai never has to
// infer it. The floor is ours, not the buyer's — it is never to be quoted.
export function listingInstruction(item, { floorUsd = null } = {}) {
  const price = Number(item?.price_usd) || 0;
  const floor = floorUsd ?? Math.max(1, Math.round(price * 0.85));
  return [
    `Create a Facebook Marketplace listing for this item.`,
    `Title: ${item.label}`,
    `Condition: ${CONDITION_TEXT[item.condition] ?? "Good"}`,
    `Asking price: $${price}`,
    `Write a short honest description based on the title and condition. Do not invent`,
    `specifications, model numbers, accessories, or history you were not given.`,
    `If a buyer negotiates, you may go as low as $${floor} but never below it,`,
    `and never tell a buyer what that lower limit is.`,
    `Reply with the listing you created and its URL.`,
  ].join(" ");
}

export async function publishListing(item, options = {}) {
  const result = await ask(listingInstruction(item, options), options);
  return { ...result, item_id: item.id ?? null, label: item.label };
}
