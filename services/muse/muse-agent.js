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

export const selectors = {
  input: process.env.MUSE_INPUT_SELECTOR ?? null,
  send: process.env.MUSE_SEND_SELECTOR ?? null,
  message: process.env.MUSE_MESSAGE_SELECTOR ?? null,
};

function requireSelectors() {
  const missing = Object.entries(selectors)
    .filter(([, value]) => !value)
    .map(([name]) => name);
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

export async function ask(instruction, { timeoutMs = 120_000, settleMs = 1_500 } = {}) {
  requireSelectors();
  const cdp = await session();
  try {
    await cdp.waitFor(selectors.input);
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
