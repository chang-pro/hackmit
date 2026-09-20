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

// Every bubble, ours and the agent's, to tell whose turn it is.
const ANY_BUBBLE = process.env.MUSE_ANY_BUBBLE_SELECTOR ?? ".hatch-chat-groupable-bubble";
const USER_BUBBLE_CLASS = process.env.MUSE_USER_BUBBLE_CLASS ?? "bg-chat-user-bubble";

// Do not type while the agent still owes an answer. A reply that lands after a
// timeout would otherwise be counted as the answer to the NEXT instruction, and
// that listing would be stored with the previous item's Facebook link. The chat
// is idle when its last bubble is the agent's and has stopped changing.
async function awaitIdle(cdp, { timeoutMs = 180_000, settleMs = 1_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastText = null;
  let stableSince = null;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const all = document.querySelectorAll(${JSON.stringify(ANY_BUBBLE)});
      const last = all[all.length - 1];
      if (!last) return { empty: true };
      return { mine: last.classList.contains(${JSON.stringify(USER_BUBBLE_CLASS)}), text: (last.innerText || "").trim() };
    })()`);
    if (state.empty) return;                       // a fresh chat owes nothing
    if (!state.mine && state.text === lastText) {
      if (stableSince && Date.now() - stableSince >= settleMs) return;
      stableSince ??= Date.now();
    } else {
      lastText = state.mine ? null : state.text;
      stableSince = null;
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new CdpError(
    "muse.ai is still working on the previous request; not sending another on top of it",
  );
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

function lastBubbleExpression() {
  return `(() => {
    const all = document.querySelectorAll(${JSON.stringify(ANY_BUBBLE)});
    const last = all[all.length - 1];
    if (!last) return null;
    return { mine: last.classList.contains(${JSON.stringify(USER_BUBBLE_CLASS)}), text: (last.innerText || "").trim() };
  })()`;
}

// A reply is the agent's bubble that comes AFTER ours, once it stops changing.
//
// This used to count agent bubbles and wait for the count to grow. muse.ai only
// keeps the most recent dozen or so bubbles in the page, so in a long thread
// the count never grows: old bubbles drop off the top as new ones arrive. Every
// request was answered and every request "timed out", which also fed the draft
// queue's retry. Position is what matters, not count: first our message shows
// up as the last bubble, then the agent's does.
async function awaitReply(cdp, before, { timeoutMs, settleMs }) {
  const deadline = Date.now() + timeoutMs;
  let sawOurs = false;
  let text = null;
  let stableSince = null;

  while (Date.now() < deadline) {
    const last = await cdp.evaluate(lastBubbleExpression());
    if (last?.mine) {
      sawOurs = true;
      text = null;
      stableSince = null;
    } else if (last && (sawOurs || last.text !== before)) {
      // Streaming: wait for it to stop growing, so an answer is not cut short.
      if (last.text && last.text === text) {
        if (stableSince && Date.now() - stableSince >= settleMs) return text;
        stableSince ??= Date.now();
      } else {
        text = last.text;
        stableSince = null;
      }
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  if (text) return text; // a slow stream that never settled still beats nothing
  throw new CdpError(`muse.ai did not reply within ${timeoutMs}ms`);
}

// One chat, one browser: two instructions typed at once would interleave and
// each would read the other's answer. Drafts, status checks and buyer replies
// all come through ask(), so they queue here.
let museBusy = Promise.resolve();

export function ask(instruction, options = {}) {
  const turn = museBusy.then(() => askNow(instruction, options));
  museBusy = turn.catch(() => {});
  return turn;
}

async function askNow(
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
    await awaitIdle(cdp);
    const before = (await cdp.evaluate(lastBubbleExpression()))?.text ?? null;
    await cdp.typeInto(selectors.input, instruction);
    if (selectors.send) await cdp.click(selectors.send);
    else await cdp.pressEnter();
    const reply = await awaitReply(cdp, before, { timeoutMs, settleMs });
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
//
// The result deliberately carries NO floor. It used to echo floor_usd back, the
// draft queue stored the whole result on the job, and GET /api/drafts served
// the job to anyone — so a buyer's agent could read the seller's real bottom
// price the moment a draft finished.
export async function draftListing(item, options = {}) {
  const result = await ask(listingInstruction(item, options), options);
  return {
    ...result,
    item_id: item.id ?? null,
    label: item.label,
    price_usd: Number(item?.price_usd) || 0,
    status: "draft_requested",
  };
}

// Asks muse where our listings stand and who has written in. Titles are what
// muse knows them by; it never sees our ids or any price rule.
export function statusInstruction(listings) {
  return [
    "Check my Facebook Marketplace account and report back. Do not change, publish, delete or reply to anything.",
    "For each of these listings, tell me whether it is still a draft, live (published and visible to buyers), sold, or removed, and give its facebook.com link if it has one:",
    ...listings.map((l) => `- ${l.title} ($${l.listUsd})`),
    "Then open Marketplace messages. For each of those listings, list every buyer who is waiting on a reply: the buyer's name, which listing, and their latest message word for word.",
    "If there are no messages, say so. Keep it factual and short.",
  ].join("\n");
}

// Sends one reply, exactly as written. The wording was produced by the seller
// policy; muse is only the hands.
export function replyInstruction({ title, buyer, text }) {
  return [
    `On Facebook Marketplace, open the conversation with ${buyer} about my listing "${title}".`,
    `Reply with exactly this message and nothing else: "${String(text).replace(/"/g, "'")}"`,
    "Do not negotiate, do not add anything, and do not message anyone else. Then tell me whether it was sent.",
  ].join("\n");
}
