// Minimal Chrome DevTools Protocol client. Zero dependencies — Node 22+ ships
// a global WebSocket, which is all CDP needs over the wire.
//
// Chrome must already be running with --remote-debugging-port. A running
// Chrome cannot have the port attached after the fact, so it has to be
// launched with the flag (see facebook-marketplace/README.md).

const DEFAULT_ENDPOINT = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 20_000;

export class CdpError extends Error {}

async function httpJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new CdpError(`${url} returned ${res.status}`);
  return res.json();
}

export async function browserVersion({ endpoint = DEFAULT_ENDPOINT, timeoutMs = 5_000 } = {}) {
  try {
    return await httpJson(`${endpoint}/json/version`, timeoutMs);
  } catch (err) {
    throw new CdpError(
      `no debuggable Chrome at ${endpoint} (${err.message}). Launch Chrome with --remote-debugging-port=9222.`
    );
  }
}

export async function listTargets({ endpoint = DEFAULT_ENDPOINT, timeoutMs = 5_000 } = {}) {
  let targets;
  try {
    targets = await httpJson(`${endpoint}/json/list`, timeoutMs);
  } catch (err) {
    // This is the failure everyone hits first, so it names the fix.
    throw new CdpError(
      `no debuggable Chrome at ${endpoint}. Quit Chrome completely, then relaunch it with ` +
        `--remote-debugging-port=9222 (see facebook-marketplace/README.md). Underlying error: ${err.message}`
    );
  }
  return targets.filter((t) => t.type === "page");
}

// Finds an already-open tab whose URL matches, so we reuse the session the
// user is already logged into rather than opening a fresh unauthenticated one.
export async function findTarget(urlSubstring, options = {}) {
  const targets = await listTargets(options);
  return targets.find((t) => (t.url ?? "").includes(urlSubstring)) ?? null;
}

export async function openTarget(url, { endpoint = DEFAULT_ENDPOINT, timeoutMs = 10_000 } = {}) {
  const res = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new CdpError(`could not open ${url}: HTTP ${res.status}`);
  return res.json();
}

// One websocket to one page target. Commands are correlated by id; events are
// dispatched to listeners registered by method name.
export class CdpSession {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(webSocketDebuggerUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.url = webSocketDebuggerUrl;
    this.timeoutMs = timeoutMs;
  }

  static async attach(target, options = {}) {
    if (!target?.webSocketDebuggerUrl) {
      throw new CdpError("target has no webSocketDebuggerUrl — is another debugger attached?");
    }
    const session = new CdpSession(target.webSocketDebuggerUrl, options);
    await session.open();
    return session;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.#ws = ws;
      const failFast = () => reject(new CdpError(`could not connect to ${this.url}`));
      ws.addEventListener("open", () => {
        ws.removeEventListener("error", failFast);
        resolve();
      }, { once: true });
      ws.addEventListener("error", failFast, { once: true });
      ws.addEventListener("close", () => {
        this.#closed = true;
        for (const { reject: rejectPending } of this.#pending.values()) {
          rejectPending(new CdpError("CDP connection closed"));
        }
        this.#pending.clear();
      });
      ws.addEventListener("message", (event) => this.#dispatch(event.data));
    });
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id != null) {
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new CdpError(message.error.message ?? "CDP error"));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) {
      listener(message.params);
    }
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(listener);
    return () => this.#listeners.get(method)?.delete(listener);
  }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new CdpError("CDP connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Runs an expression in the page and returns its value. awaitPromise lets the
  // caller pass an async IIFE, which is how the page-side helpers below work.
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "page threw";
      throw new CdpError(`page evaluation failed: ${text}`);
    }
    return result.result?.value;
  }

  // Typing through Input.insertText rather than setting .value directly: React
  // and similar frameworks ignore a value assignment that fires no key events,
  // so a directly-set value looks filled but submits empty.
  async typeInto(selector, text) {
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (!focused) throw new CdpError(`no element matches ${selector}`);
    await this.send("Input.insertText", { text });
  }

  async pressEnter() {
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new CdpError(`no element matches ${selector}`);
  }

  async waitFor(selector, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await this.evaluate(
        `document.querySelector(${JSON.stringify(selector)}) != null`
      );
      if (present) return true;
      await new Promise((done) => setTimeout(done, intervalMs));
    }
    throw new CdpError(`${selector} never appeared within ${timeoutMs}ms`);
  }

  close() {
    this.#closed = true;
    try {
      this.#ws?.close();
    } catch {
      // Closing an already-dead socket is not an error worth surfacing.
    }
  }
}
