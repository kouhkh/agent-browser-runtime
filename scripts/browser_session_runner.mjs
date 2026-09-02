#!/usr/bin/env node

/**
 * Small standalone browser session manager.
 *
 * The runner is intentionally read-only. It owns a dedicated Chrome process,
 * exposes a newline-delimited JSON control socket, and treats a timed-out
 * operation as a stale session instead of leaving a ghost tab behind.
 */

import { spawn } from "node:child_process";
import { createServer, connect as connectSocket } from "node:net";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_ROOT = join(tmpdir(), "agent-browser-sessions");
const DEFAULT_SHARED_ROOT = join(homedir(), ".agent-browser-runtime", "sessions");
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function parseArgs(argv) {
  const out = {
    command: argv[0] || "help",
    session: null,
    root: process.env.DIRECT_CDP_SESSION_ROOT || DEFAULT_ROOT,
    rootExplicit: Boolean(process.env.DIRECT_CDP_SESSION_ROOT),
    shared: false,
    url: null,
    contains: null,
    authCheckUrl: null,
    authCheckContains: null,
    agent: null,
    reason: null,
    action: null,
    operationId: null,
    timeoutMs: 5000,
    leaseMs: 15 * 60 * 1000,
    headed: false,
    keepProfile: true,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session") out.session = argv[++i];
    else if (arg === "--root") { out.root = argv[++i]; out.rootExplicit = true; }
    else if (arg === "--shared") out.shared = true;
    else if (arg === "--url") out.url = argv[++i];
    else if (arg === "--contains") out.contains = argv[++i];
    else if (arg === "--auth-check-url") out.authCheckUrl = argv[++i];
    else if (arg === "--auth-check-contains") out.authCheckContains = argv[++i];
    else if (arg === "--agent") out.agent = argv[++i];
    else if (arg === "--reason") out.reason = argv[++i];
    else if (arg === "--action") out.action = argv[++i];
    else if (arg === "--operation-id") out.operationId = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Math.max(250, Number(argv[++i] || 5000));
    else if (arg === "--lease-ms") out.leaseMs = Math.max(1000, Number(argv[++i] || 900000));
    else if (arg === "--headed") out.headed = true;
    else if (arg === "--remove-profile") out.keepProfile = false;
    else if (arg === "--help" || arg === "-h") out.command = "help";
  }
  if (!Number.isFinite(out.timeoutMs) || !Number.isFinite(out.leaseMs)) {
    throw new Error("--timeout-ms/--lease-ms must be numbers");
  }
  if (out.session && !SESSION_RE.test(out.session)) {
    throw new Error("Invalid session name; use 1-64 letters, numbers, _ or -");
  }
  if (out.shared && !out.rootExplicit) out.root = DEFAULT_SHARED_ROOT;
  return out;
}

function sessionDir(options) {
  if (!options.session) throw new Error("--session is required");
  return join(options.root, options.session);
}

function statePath(options) {
  return join(sessionDir(options), "state.json");
}

function socketPath(options) {
  return join(sessionDir(options), "control.sock");
}

function lockPath(options) {
  return join(sessionDir(options), "session.lock");
}

class SessionLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionLockError";
  }
}

function authRecord(options) {
  return {
    status: "unknown",
    epoch: 0,
    reason: null,
    requestedAt: null,
    requestedBy: null,
    authenticatedAt: null,
    authenticatedBy: null,
    lastCheckedAt: null,
    checkUrl: options.authCheckUrl || null,
    checkContains: options.authCheckContains || null,
  };
}

function readState(options) {
  const path = statePath(options);
  if (!existsSync(path)) throw new Error(`Session state not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on platforms without chmod */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(options, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      lastState = readState(options);
      if (predicate(lastState)) return lastState;
    } catch {
      // The detached server may not have created its state file yet.
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for session state${lastState ? ` (${lastState.status})` : ""}`);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function request(options, payload) {
  const state = readState(options);
  const path = state.socketPath || socketPath(options);
  return await new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Control request timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs + 1000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => clearTimeout(timer));
  });
}

class CdpClient {
  constructor(socket, onClosed = null) {
    this.socket = socket;
    this.onClosed = onClosed;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }
      if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.onAbort);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.listeners.get(message.method) || []) handler(message.params || {});
    };
    socket.onclose = () => this.close(new Error("CDP socket closed"));
    socket.onerror = () => this.close(new Error("CDP socket error"));
  }

  send(method, params = {}, timeoutMs = 5000, signal) {
    if (this.closed) return Promise.reject(new Error("CDP client is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new Error(`Operation cancelled: ${method}`));
      const timer = setTimeout(() => finish(reject, new Error(`CDP timeout after ${timeoutMs}ms: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  once(method, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const onEvent = (params) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((handler) => handler !== onEvent));
        resolve(params);
      };
      const onAbort = () => {
        clearTimeout(timer);
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((handler) => handler !== onEvent));
        reject(new Error(`Operation cancelled while waiting for ${method}`));
      };
      timer = setTimeout(() => {
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((handler) => handler !== onEvent));
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`CDP event timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.on(method, onEvent);
    });
  }

  close(reason = new Error("CDP client closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(reason);
    }
    this.pending.clear();
    try { this.socket.close(); } catch { /* already closed */ }
    this.onClosed?.(reason);
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function connectCdp(webSocketUrl, timeoutMs, onClosed = null) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket open timeout after ${timeoutMs}ms`)), timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
  });
  return new CdpClient(socket, onClosed);
}

function visibleDomExpression() {
  return `(() => {
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const text = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean)
      .join('\\n');
    return { readyState: document.readyState, title: document.title, url: location.href, visibleText: text.slice(0, 20000) };
  })()`;
}

class BrowserSession {
  constructor(options) {
    this.options = options;
    this.dir = sessionDir(options);
    this.socketFile = socketPath(options);
    this.lockFile = lockPath(options);
    this.lockFd = null;
    this.state = {
      schemaVersion: 1,
      sessionId: options.session,
      status: "starting",
      state: "starting",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + options.leaseMs).toISOString(),
      socketPath: this.socketFile,
      lockPath: this.lockFile,
      pid: null,
      port: null,
      targetId: null,
      profileDir: join(this.dir, "profile"),
      profileMode: options.shared ? "shared" : "ephemeral",
      headed: Boolean(options.headed),
      auth: authRecord(options),
      busy: false,
      activeOperationIds: [],
      staleReason: null,
    };
    this.chrome = null;
    this.cdp = null;
    this.server = null;
    this.target = null;
    this.operation = null;
    this.heartbeat = null;
    this.invalidated = false;
  }

  save(extra = {}) {
    this.state = {
      ...this.state,
      ...extra,
      lastSeenAt: new Date().toISOString(),
      ...(this.state.status === "stale" || this.state.status === "closed"
        ? {}
        : { leaseExpiresAt: new Date(Date.now() + this.options.leaseMs).toISOString() }),
      busy: Boolean(this.operation),
      activeOperationIds: this.operation ? [this.operation.id] : [],
    };
    writeState(this.dir, this.state);
  }

  authStatus() {
    return {
      ok: this.state.auth?.status === "ready",
      status: this.state.auth?.status || "unknown",
      sessionId: this.state.sessionId,
      profileMode: this.state.profileMode,
      auth: this.state.auth || authRecord(this.options),
    };
  }

  requireAuth(reason = "caller_requested", requestedBy = "unknown") {
    const current = this.state.auth || authRecord(this.options);
    const changed = current.status !== "required";
    const auth = {
      ...current,
      status: "required",
      reason,
      requestedAt: changed ? new Date().toISOString() : current.requestedAt,
      requestedBy: changed ? requestedBy : current.requestedBy,
      lastCheckedAt: new Date().toISOString(),
    };
    this.save({ auth });
    return {
      ok: false,
      status: "auth_required",
      errorCode: "AUTH_REQUIRED",
      sessionId: this.state.sessionId,
      auth,
      message: "Manual sign-in is required in the dedicated headed Chrome session; callers must wait for auth-ready instead of retrying the page.",
    };
  }

  markAuthReady(authenticatedBy = "manual_login", extra = {}) {
    const current = this.state.auth || authRecord(this.options);
    const verified = Boolean(extra.verified);
    const { verified: _verified, ...authExtra } = extra;
    if (current.status !== "required" && !verified) {
      return {
        ok: false,
        status: "auth_ready_rejected",
        errorCode: "AUTH_READY_NOT_REQUESTED",
        sessionId: this.state.sessionId,
        auth: current,
        message: "Marking a login ready requires an auth-required state; use auth-check to verify a fresh session.",
      };
    }
    const newlyAuthenticated = current.status !== "ready";
    const auth = {
      ...current,
      ...authExtra,
      status: "ready",
      epoch: Number(current.epoch || 0) + (newlyAuthenticated ? 1 : 0),
      reason: null,
      requestedAt: current.requestedAt,
      requestedBy: current.requestedBy,
      authenticatedAt: new Date().toISOString(),
      authenticatedBy,
      lastCheckedAt: new Date().toISOString(),
    };
    this.save({ auth });
    return { ok: true, status: "authenticated", sessionId: this.state.sessionId, auth };
  }

  async waitForAuth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = this.state.auth?.status || "unknown";
      if (status === "ready") return this.authStatus();
      await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
      try {
        const latest = readState(this.options);
        if (latest.auth) this.state.auth = latest.auth;
      } catch {
        // The session may be transitioning during a restart.
      }
    }
    return {
      ok: false,
      status: "auth_wait_timeout",
      errorCode: "AUTH_WAIT_TIMEOUT",
      sessionId: this.state.sessionId,
      auth: this.state.auth || authRecord(this.options),
    };
  }

  observeAuth(page) {
    if (this.state.profileMode !== "shared" || !page) return null;
    const loginLike = typeof page.url === "string" && /\/login(?:[/?#]|$)/i.test(page.url);
    if (loginLike) {
      return this.requireAuth("login_page_detected", "runtime");
    }
    return null;
  }

  acquireLock() {
    const writeLock = () => {
      this.lockFd = openSync(this.lockFile, "wx", 0o600);
      writeFileSync(this.lockFd, `${process.pid}\n`, { encoding: "utf8" });
      try { chmodSync(this.lockFile, 0o600); } catch { /* best effort on platforms without chmod */ }
    };
    try {
      writeLock();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let ownerPid = null;
    try { ownerPid = Number(readFileSync(this.lockFile, "utf8").trim()); } catch { /* stale or unreadable lock */ }
    if (isAlive(ownerPid)) {
      throw new SessionLockError(`Session is already owned by process ${ownerPid}: ${this.options.session}`);
    }
    try { unlinkSync(this.lockFile); } catch { /* another starter may have won the race */ }
    try {
      writeLock();
    } catch (error) {
      if (error.code === "EEXIST") throw new SessionLockError(`Session lock is held: ${this.options.session}`);
      throw error;
    }
  }

  releaseLock() {
    if (this.lockFd != null) {
      try { closeSync(this.lockFd); } catch { /* already closed */ }
      this.lockFd = null;
    }
    try { unlinkSync(this.lockFile); } catch { /* already gone */ }
  }

  async start() {
    mkdirSync(this.dir, { recursive: true });
    this.acquireLock();
    try {
      const previous = readState(this.options);
      if (previous.auth) this.state.auth = previous.auth;
    } catch {
      // First start has no prior state to preserve.
    }
    if (existsSync(this.socketFile)) {
      try { unlinkSync(this.socketFile); } catch { /* stale socket */ }
    }
    this.save();
    const chromePath = process.env.DIRECT_CDP_CHROME || DEFAULT_CHROME;
    const port = await this.freePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.state.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-gpu",
      "--window-size=1440,1000",
    ];
    if (!this.options.headed) args.push("--headless=new");
    args.push("about:blank");
    this.chrome = spawn(chromePath, args, { stdio: ["ignore", "ignore", "ignore"] });
    this.state.pid = this.chrome.pid;
    this.state.port = port;
    this.chrome.once("exit", (code, signal) => {
      if (!this.invalidated) this.invalidate(`chrome_exit:${code ?? signal ?? "unknown"}`);
    });
    this.save({ status: "starting", state: "starting" });
    const version = await this.waitForVersion(10000);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
    this.target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!this.target) throw new Error("No page target exposed by Chrome");
    this.state.targetId = this.target.id;
    this.cdp = await connectCdp(this.target.webSocketDebuggerUrl, 3000, () => {
      if (!this.invalidated) this.invalidate("cdp_socket_closed");
    });
    await this.cdp.send("Page.enable", {}, 3000);
    await this.cdp.send("Runtime.enable", {}, 3000);
    await this.cdp.send("Network.enable", {}, 3000);
    this.save({ status: "starting", state: "starting", chromeVersion: version.Browser || null });
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketFile, () => resolve());
    });
    try { chmodSync(this.socketFile, 0o600); } catch { /* best effort on platforms without chmod */ }
    this.heartbeat = setInterval(() => { void this.checkLeaseAndProcess(); }, 2000);
    this.heartbeat.unref?.();
    this.save({ status: "ready", state: "ready" });
  }

  async freePort() {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  async waitForVersion(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try { return await fetchJson(`http://127.0.0.1:${this.state.port}/json/version`, 500); }
      catch (error) { lastError = error; await sleep(50); }
    }
    throw new Error(`Timed out waiting for Chrome: ${lastError?.message || "unknown error"}`);
  }

  async checkLeaseAndProcess() {
    if (this.state.status !== "ready" && this.state.status !== "busy") return;
    if (!isAlive(this.state.pid)) {
      this.invalidate("chrome_not_alive");
      return;
    }
    try {
      const targets = await fetchJson(`http://127.0.0.1:${this.state.port}/json/list`, 500);
      if (!targets.some((item) => item.id === this.state.targetId && item.type === "page")) {
        this.invalidate("tab_closed");
        return;
      }
    } catch {
      this.invalidate("cdp_endpoint_unreachable");
      return;
    }
    if (!this.operation && Date.now() >= Date.parse(this.state.leaseExpiresAt)) {
      this.invalidate("lease_expired");
    }
  }

  async handleConnection(socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let requestBody;
      try { requestBody = JSON.parse(line); }
      catch (error) { this.respond(socket, { ok: false, errorCode: "BAD_REQUEST", error: error.message }); return; }
      const result = await this.dispatch(requestBody);
      this.respond(socket, result);
    });
    socket.on("error", () => {});
  }

  respond(socket, body) {
    try { socket.end(`${JSON.stringify(body)}\n`); } catch { /* client disconnected */ }
  }

  async dispatch(body) {
    const action = body.action || "health";
    const operationId = body.operationId || randomUUID();
    if (action === "health") return this.health();
    if (action === "cancel") return this.cancel(body.operationId || body.targetOperationId);
    if (action === "close") { await this.close(); return { ok: true, status: "closed" }; }
    if (action === "auth-status") return this.authStatus();
    if (action === "auth-required") {
      return this.requireAuth(body.reason || "caller_requested", body.agent || "unknown");
    }
    if (action === "auth-ready") {
      return this.markAuthReady(body.agent || "manual_login", {
        checkUrl: body.url || this.state.auth?.checkUrl || null,
        checkContains: body.contains || this.state.auth?.checkContains || null,
      });
    }
    if (action === "wait-auth") {
      const waitMs = Math.min(Math.max(250, Number(body.timeoutMs || this.options.timeoutMs)), 120000);
      return await this.waitForAuth(waitMs);
    }
    if (this.invalidated || !this.cdp || this.cdp.closed || (this.state.status !== "ready" && this.state.status !== "busy")) {
      return { ok: false, status: "stale", errorCode: "STALE_SESSION", staleReason: this.state.staleReason };
    }
    if (this.operation) {
      return { ok: false, status: "busy", errorCode: "SESSION_BUSY", activeOperationIds: [this.operation.id] };
    }
    if (this.state.profileMode === "shared" && this.state.auth?.status === "required" && action !== "auth-check") {
      return this.requireAuth(this.state.auth.reason || "session_expired", this.state.auth.requestedBy || "runtime");
    }
    if (!["navigate", "inspect", "auth-check"].includes(action)) {
      return { ok: false, status: "rejected", errorCode: "READ_ONLY_ACTION", message: `Unsupported action: ${action}` };
    }
    const timeoutMs = Math.min(Math.max(250, Number(body.timeoutMs || this.options.timeoutMs)), 120000);
    const controller = new AbortController();
    const operation = { id: operationId, action, controller, startedAt: Date.now(), timedOut: false };
    this.operation = operation;
    this.save({ status: "busy", state: "busy" });
    const timeout = setTimeout(() => {
      operation.timedOut = true;
      controller.abort();
      this.invalidate("operation_timeout");
    }, timeoutMs);
    try {
      const result = action === "navigate"
        ? await this.navigate(body.url, body.waitUntil || "load", timeoutMs, controller.signal)
        : action === "auth-check"
          ? await this.navigate(body.url || this.state.auth?.checkUrl, body.waitUntil || "load", timeoutMs, controller.signal)
          : await this.inspect(timeoutMs, controller.signal);
      if (action === "auth-check") {
        const contains = body.contains || this.state.auth?.checkContains;
        const hasExpectedText = !contains || result?.visibleText?.includes(contains);
        const loginLike = typeof result?.url === "string" && /\/login(?:[/?#]|$)/i.test(result.url);
        if (!hasExpectedText || loginLike) {
          return {
            ...this.requireAuth(loginLike ? "login_page_detected" : "auth_marker_missing", body.agent || "auth-check"),
            result,
          };
        }
        return {
          ...this.markAuthReady(body.agent || "auth-check", { verified: true, checkUrl: body.url || this.state.auth?.checkUrl || null, checkContains: contains || null }),
          operationId,
          elapsedMs: Date.now() - operation.startedAt,
          result,
        };
      }
      const authRequired = this.observeAuth(result);
      if (authRequired) return { ...authRequired, operationId, elapsedMs: Date.now() - operation.startedAt, result };
      return { ok: true, status: "succeeded", operationId, elapsedMs: Date.now() - operation.startedAt, authEpoch: this.state.auth?.epoch || 0, result };
    } catch (error) {
      const cancelled = controller.signal.aborted && !operation.timedOut;
      return {
        ok: false,
        status: cancelled ? "cancelled" : operation.timedOut ? "timeout" : "failed",
        operationId,
        elapsedMs: Date.now() - operation.startedAt,
        errorCode: cancelled ? "CANCELLED" : operation.timedOut ? "OPERATION_TIMEOUT" : "BROWSER_OPERATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        stale: this.invalidated,
      };
    } finally {
      clearTimeout(timeout);
      if (this.operation?.id === operationId) {
        this.operation = null;
        if (!this.invalidated) this.save({ status: "ready", state: "ready" });
      }
    }
  }

  health() {
    const alive = isAlive(this.state.pid);
    if (!alive && !this.invalidated) this.invalidate("chrome_not_alive");
    if (!this.invalidated && this.cdp?.closed) this.invalidate("cdp_socket_closed");
    const status = this.invalidated ? "stale" : this.state.status;
    return {
      ok: status === "ready" || status === "busy",
      status,
      sessionId: this.state.sessionId,
      pid: this.state.pid,
      targetId: this.state.targetId,
      state: this.state.state,
      profileMode: this.state.profileMode,
      headed: this.state.headed,
      auth: this.state.auth || authRecord(this.options),
      staleReason: this.state.staleReason,
      busy: Boolean(this.operation),
      leaseExpiresAt: this.state.leaseExpiresAt,
      lastSeenAt: this.state.lastSeenAt,
    };
  }

  async navigate(url, waitUntil, timeoutMs, signal) {
    if (typeof url !== "string" || !url) throw new Error("navigate requires a URL");
    const allowedWaitUntil = new Set(["commit", "domcontentloaded", "load"]);
    if (!allowedWaitUntil.has(waitUntil)) throw new Error(`Unsupported waitUntil: ${waitUntil}`);
    const eventName = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
    const eventPromise = waitUntil === "commit" ? Promise.resolve(null) : this.cdp.once(eventName, timeoutMs, signal);
    const result = await this.cdp.send("Page.navigate", { url }, timeoutMs, signal);
    if (result?.errorText) throw new Error(result.errorText);
    await eventPromise;
    const page = await this.readDom(timeoutMs, signal);
    return { frameId: result?.frameId || null, loaderId: result?.loaderId || null, ...page };
  }

  async inspect(timeoutMs, signal) {
    return await this.readDom(timeoutMs, signal);
  }

  async readDom(timeoutMs, signal) {
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: visibleDomExpression(),
      returnByValue: true,
      awaitPromise: false,
    }, timeoutMs, signal);
    return result?.result?.value || null;
  }

  cancel(operationId) {
    if (!operationId || !this.operation || this.operation.id !== operationId) {
      return { ok: false, status: "not_found", errorCode: "OPERATION_NOT_FOUND" };
    }
    this.operation.controller.abort();
    this.invalidate("cancelled");
    return { ok: true, status: "cancelling", operationId };
  }

  invalidate(reason) {
    if (this.invalidated) return;
    this.invalidated = true;
    this.state.status = "stale";
    this.state.state = "stale";
    this.state.staleReason = reason;
    this.save({ status: "stale", state: "stale", staleReason: reason });
    this.cdp?.close(new Error(`Session invalidated: ${reason}`));
    this.cdp = null;
    this.killChrome();
  }

  killChrome() {
    if (!this.chrome || this.chrome.killed) return;
    try { this.chrome.kill("SIGTERM"); } catch { /* already exited */ }
    const child = this.chrome;
    const timer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, 500);
    timer.unref?.();
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.invalidated = true;
    this.state.status = "closed";
    this.state.state = "closed";
    this.state.staleReason = null;
    this.save({ status: "closed", state: "closed" });
    this.cdp?.close();
    this.cdp = null;
    // Do not await server.close() here: the current control connection is the
    // one carrying the close response, and waiting for it would deadlock.
    if (this.server) this.server.close(() => {});
    this.killChrome();
    if (!this.options.keepProfile) {
      try { rmSync(this.state.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* isolated profile cleanup is best effort */ }
    }
    try { unlinkSync(this.socketFile); } catch { /* already gone */ }
    this.releaseLock();
  }
}

async function serve(options) {
  const session = new BrowserSession(options);
  const shutdown = async () => { await session.close(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await session.start();
    // Keep the detached server alive while the Chrome session is leased.
    await new Promise(() => {});
  } catch (error) {
    if (!(error instanceof SessionLockError)) {
      session.invalidate(`startup_failed:${error.message}`);
    }
    console.error(JSON.stringify({ ok: false, status: "failed", errorCode: "SESSION_START_FAILED", error: error.message }));
    process.exitCode = 1;
  }
}

async function start(options) {
  mkdirSync(options.root, { recursive: true });
  const dir = sessionDir(options);
  if (existsSync(statePath(options))) {
    try {
      const old = readState(options);
      if (["starting", "ready", "busy"].includes(old.status) && isAlive(old.pid)) {
        throw new Error(`Session already exists: ${options.session} (${old.status})`);
      }
    } catch (error) {
      if (error.message.startsWith("Session already exists")) throw error;
    }
  }
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [process.argv[1], "serve", "--session", options.session, "--root", options.root, "--lease-ms", String(options.leaseMs), ...(options.shared ? ["--shared"] : []), ...(options.authCheckUrl ? ["--auth-check-url", options.authCheckUrl] : []), ...(options.authCheckContains ? ["--auth-check-contains", options.authCheckContains] : []), ...(options.headed ? ["--headed"] : []), ...(options.keepProfile ? [] : ["--remove-profile"])], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
  const state = await waitForState(options, (item) => item.status === "ready" || item.status === "stale", 15000);
  if (state.status !== "ready") throw new Error(`Session failed to start: ${state.staleReason || "unknown"}`);
  console.log(JSON.stringify({ ok: true, status: "ready", session: options.session, state }));
}

async function stop(options) {
  const result = await request(options, { action: "close" });
  console.log(JSON.stringify(result));
}

async function restart(options) {
  let oldState = null;
  try {
    const state = readState(options);
    oldState = state;
    if (isAlive(state.pid)) await request(options, { action: "close" });
  } catch {
    // A stale or already-closed session can be replaced directly.
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      if (!isAlive(readState(options).pid)) break;
    } catch { break; }
    await sleep(50);
  }
  await start({
    ...options,
    shared: options.shared || oldState?.profileMode === "shared",
    headed: options.headed || Boolean(oldState?.headed),
    authCheckUrl: options.authCheckUrl || oldState?.auth?.checkUrl || null,
    authCheckContains: options.authCheckContains || oldState?.auth?.checkContains || null,
  });
}

function printHelp() {
  console.log(`Usage:
  browser_session_runner.mjs start --session NAME [--shared] [--headed] [--lease-ms N]
  browser_session_runner.mjs request --shared --session NAME --action health
  browser_session_runner.mjs request --shared --session NAME --action navigate --url URL [--timeout-ms N]
  browser_session_runner.mjs request --shared --session NAME --action inspect [--timeout-ms N]
  browser_session_runner.mjs request --shared --session NAME --action auth-status
  browser_session_runner.mjs request --shared --session NAME --action auth-required [--agent ID] [--reason TEXT]
  browser_session_runner.mjs request --shared --session NAME --action auth-check --url URL [--contains TEXT]
  browser_session_runner.mjs request --shared --session NAME --action auth-ready [--agent ID]
  browser_session_runner.mjs request --shared --session NAME --action wait-auth [--timeout-ms N]
  browser_session_runner.mjs request --shared --session NAME --action cancel --operation-id ID
  browser_session_runner.mjs stop --shared --session NAME
  browser_session_runner.mjs restart --shared --session NAME [--headed] [--lease-ms N]

Add --shared to start/restart a persistent, dedicated profile (default root:
~/.agent-browser-runtime/sessions). A headed shared session lets a user sign in
manually once; other callers reuse the same session id and wait on auth state.
The session is isolated, read-only, and managed through a local control socket.
Timeout/cancel invalidates the Chrome session so no ghost tab is reused.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") return printHelp();
  if (options.command === "serve") return await serve(options);
  if (options.command === "start") return await start(options);
  if (options.command === "stop") return await stop(options);
  if (options.command === "restart") return await restart(options);
  if (options.command === "request") {
    const result = await request(options, {
      action: options.action || "health",
      url: options.url,
      contains: options.contains,
      agent: options.agent,
      reason: options.reason,
      timeoutMs: options.timeoutMs,
      operationId: options.operationId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
