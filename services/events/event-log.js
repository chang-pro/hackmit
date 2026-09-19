// Append-only event log. The dashboard, the phone and any agent learn what
// happened by reading this, never by asking each other. In memory, with an
// optional JSONL file (RELOOP_EVENTS_FILE) so a restart replays the demo.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EVENT_KINDS } from "./dashboard-fold.js";

const TEXT_FIELDS = ["itemId", "listingId", "label", "text", "url", "source", "spot", "mode", "deadline", "missionId"];

export class EventLog {
  constructor({ file = process.env.RELOOP_EVENTS_FILE || null } = {}) {
    this.file = file;
    this.events = [];
    this.listeners = new Set();
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // A torn last line from a crash is skipped rather than blocking startup.
        }
      }
    }
  }

  append(input) {
    if (!input || !EVENT_KINDS.includes(input.kind)) {
      const err = new Error(`kind must be one of ${EVENT_KINDS.join(", ")}`);
      err.statusCode = 400;
      throw err;
    }
    const event = { id: `evt_${randomUUID().slice(0, 8)}`, ts: new Date().toISOString(), kind: input.kind };
    for (const field of TEXT_FIELDS) {
      if (input[field] !== undefined && input[field] !== null) event[field] = String(input[field]).slice(0, 500);
    }
    if (input.amountUsd !== undefined && input.amountUsd !== null) {
      const amount = Number(input.amountUsd);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
        const err = new Error("amountUsd must be a number between 0 and 1000000");
        err.statusCode = 400;
        throw err;
      }
      event.amountUsd = Math.round(amount);
    }
    this.events.push(event);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  list() {
    return [...this.events];
  }

  clear() {
    this.events = [];
    for (const listener of this.listeners) listener({ kind: "RESET" });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
