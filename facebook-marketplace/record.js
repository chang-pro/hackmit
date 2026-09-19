// Browser action recorder. Attaches to a live tab and writes down what you do
// by hand — clicks, typing, navigation — as a replayable step list.
//
// This exists because guessing selectors from a DOM dump is slow and wrong.
// Doing the flow once by hand and reading back what you touched is faster, and
// it captures the order and the waits, which a static probe cannot.
//
// Usage:
//   node facebook-marketplace/record.js                 # record until Ctrl-C
//   node facebook-marketplace/record.js out.json 120    # to a file, stop after 120s

import { writeFile } from "node:fs/promises";
import { CdpSession, findTarget } from "./cdp.js";

// Runs in the page. Hangs listeners on window and buffers events for the
// driver to drain — CDP bindings are awkward to set up, and polling a buffer
// is simpler and loses nothing at human speed.
const INSTALL = `(() => {
  if (window.__reloopRec) return "already-installed";
  const buf = [];
  window.__reloopRec = buf;

  // Prefers a selector that survives a re-render: a test id, then an aria
  // label, then an id, and only falls back to nth-child position.
  const selectorFor = (el) => {
    if (!el || el === document.body) return "body";
    const testid = el.getAttribute?.("data-testid");
    if (testid) return "[data-testid=" + JSON.stringify(testid) + "]";
    const aria = el.getAttribute?.("aria-label");
    if (aria) return el.tagName.toLowerCase() + "[aria-label=" + JSON.stringify(aria) + "]";
    if (el.id) return "#" + CSS.escape(el.id);
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const index = [...parent.children].indexOf(el) + 1;
    return selectorFor(parent) + " > " + el.tagName.toLowerCase() + ":nth-child(" + index + ")";
  };

  const push = (event) => buf.push({ ...event, t: Date.now() });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("button, a, [role=button], input, textarea, label") || e.target;
    push({
      kind: "click",
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || "").trim().slice(0, 60),
    });
  }, true);

  // change, not input: one entry per field when you leave it, rather than one
  // per keystroke.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!("value" in el)) return;
    const secret = el.type === "password" || /pass|secret|token|card|cvv/i.test(el.name || el.id || "");
    push({
      kind: "type",
      selector: selectorFor(el),
      value: secret ? "***REDACTED***" : String(el.value).slice(0, 200),
    });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") push({ kind: "key", key: "Enter", selector: selectorFor(e.target) });
  }, true);

  return "installed";
})()`;

const DRAIN = `(() => {
  const buf = window.__reloopRec || [];
  const out = buf.splice(0, buf.length);
  return JSON.stringify(out);
})()`;

export async function record(urlMatch, { onEvent, signal } = {}) {
  const target = await findTarget(urlMatch);
  if (!target) throw new Error(`no open tab matching "${urlMatch}"`);
  const cdp = await CdpSession.attach(target);
  const events = [];

  // A navigation wipes the page's listeners, so reinstall on every load.
  await cdp.send("Page.enable");
  cdp.on("Page.loadEventFired", () => {
    cdp.evaluate(INSTALL).catch(() => {});
    events.push({ kind: "navigate", t: Date.now() });
  });
  await cdp.evaluate(INSTALL);

  const url = await cdp.evaluate("location.href");
  events.push({ kind: "start", url, t: Date.now() });

  while (!signal?.aborted) {
    await new Promise((done) => setTimeout(done, 500));
    let drained = [];
    try {
      drained = JSON.parse(await cdp.evaluate(DRAIN));
    } catch {
      // A navigation mid-drain throws; the reload handler reinstalls.
      await cdp.evaluate(INSTALL).catch(() => {});
    }
    for (const event of drained) {
      events.push(event);
      onEvent?.(event);
    }
  }
  cdp.close();
  return events;
}

// Turns raw events into steps with the real pauses preserved, because a flow
// that works by hand often fails when replayed with no waits.
export function toSteps(events) {
  const steps = [];
  let previous = null;
  for (const event of events) {
    if (event.kind === "start") continue;
    if (previous) {
      const waitMs = event.t - previous;
      if (waitMs > 400) steps.push({ action: "wait", ms: Math.min(waitMs, 15_000) });
    }
    previous = event.t;
    if (event.kind === "click") steps.push({ action: "click", selector: event.selector, note: event.text });
    else if (event.kind === "type") steps.push({ action: "type", selector: event.selector, value: event.value });
    else if (event.kind === "key") steps.push({ action: "key", key: event.key });
    else if (event.kind === "navigate") steps.push({ action: "awaitNavigation" });
  }
  return steps;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = process.argv[2] ?? "recording.json";
  const seconds = Number(process.argv[3] ?? 0);
  const controller = new AbortController();

  process.on("SIGINT", () => controller.abort());
  if (seconds > 0) setTimeout(() => controller.abort(), seconds * 1000);

  console.log(`Recording ${process.env.RECORD_URL_MATCH ?? "muse.ai"} — do the flow by hand. Ctrl-C to stop.`);
  const events = await record(process.env.RECORD_URL_MATCH ?? "muse.ai", {
    signal: controller.signal,
    onEvent: (e) => console.log(" ", e.kind, e.selector ?? e.key ?? "", (e.value ?? e.text ?? "").slice(0, 40)),
  });
  const steps = toSteps(events);
  await writeFile(outPath, JSON.stringify({ events, steps }, null, 2));
  console.log(`\n${events.length} events -> ${steps.length} steps written to ${outPath}`);
}
