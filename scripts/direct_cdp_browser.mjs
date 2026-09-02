#!/usr/bin/env node

/**
 * Small dependency-free Chrome/CDP runner.
 *
 * It intentionally talks to a locally launched Chrome over its DevTools
 * websocket instead of the managed browser-agent bridge. The default mode is
 * read-only and uses a temporary profile.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv) {
  const out = { url: null, runs: 1, timeoutMs: 3000, headed: false, keepProfile: false, screenshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg === "--runs") out.runs = Math.max(1, Number(argv[++i] || 1));
    else if (arg === "--timeout-ms") out.timeoutMs = Math.max(250, Number(argv[++i] || 3000));
    else if (arg === "--headed") out.headed = true;
    else if (arg === "--keep-profile") out.keepProfile = true;
    else if (arg === "--screenshot") out.screenshot = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: direct_cdp_browser.mjs --url URL [--runs N] [--timeout-ms N] [--headed] [--screenshot PATH]");
      process.exit(0);
    }
  }
  if (!out.url) throw new Error("--url is required");
  if (!Number.isFinite(out.runs) || !Number.isFinite(out.timeoutMs)) throw new Error("--runs/--timeout-ms must be numbers");
  return out;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
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
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method) || [];
      for (const handler of handlers) handler(message.params || {});
    };
  }

  send(method, params = {}, timeoutMs = 3000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((handler) => handler !== onEvent));
        reject(new Error(`CDP event timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      const onEvent = (params) => {
        clearTimeout(timer);
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((handler) => handler !== onEvent));
        resolve(params);
      };
      this.on(method, onEvent);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

async function connectCdp(webSocketUrl, timeoutMs) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket open timeout after ${timeoutMs}ms`)), timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
  });
  return new CdpClient(socket);
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

async function runOnce(cdp, url, timeoutMs, screenshotPath) {
  const started = performance.now();
  let encodedBytes = 0;
  let responseCount = 0;
  cdp.on("Network.responseReceived", () => { responseCount += 1; });
  cdp.on("Network.loadingFinished", (event) => { encodedBytes += Number(event.encodedDataLength || 0); });
  await cdp.send("Page.enable", {}, timeoutMs);
  await cdp.send("Runtime.enable", {}, timeoutMs);
  await cdp.send("Network.enable", {}, timeoutMs);
  const loadEvent = cdp.once("Page.loadEventFired", Math.min(timeoutMs, 2000)).catch(() => null);

  const navigateStarted = performance.now();
  let navigateResult;
  let navigateError = null;
  try {
    navigateResult = await cdp.send("Page.navigate", { url }, timeoutMs);
  } catch (error) {
    navigateError = error.message;
  }
  const navigateCommandMs = performance.now() - navigateStarted;
  await loadEvent;

  const evaluateStarted = performance.now();
  let page = null;
  let evaluateError = null;
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: visibleDomExpression(),
      returnByValue: true,
      awaitPromise: false,
    }, timeoutMs);
    page = result?.result?.value || null;
  } catch (error) {
    evaluateError = error.message;
  }
  const evaluateMs = performance.now() - evaluateStarted;

  let screenshotMs = null;
  let screenshotError = null;
  if (screenshotPath) {
    const screenshotStarted = performance.now();
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "png" }, timeoutMs);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(screenshotPath, Buffer.from(result.data, "base64"));
    } catch (error) {
      screenshotError = error.message;
    }
    screenshotMs = performance.now() - screenshotStarted;
  }

  return {
    url,
    navigateCommandMs: Number(navigateCommandMs.toFixed(1)),
    evaluateMs: Number(evaluateMs.toFixed(1)),
    screenshotMs: screenshotMs == null ? null : Number(screenshotMs.toFixed(1)),
    totalMs: Number((performance.now() - started).toFixed(1)),
    readyState: page?.readyState || null,
    title: page?.title || null,
    finalUrl: page?.url || navigateResult?.frameId || null,
    visibleChars: page?.visibleText?.length || 0,
    responseCount,
    encodedBytes: Math.round(encodedBytes),
    navigateError,
    evaluateError,
    screenshotError,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chrome = process.env.DIRECT_CDP_CHROME || DEFAULT_CHROME;
  const profile = mkdtempSync(join(tmpdir(), "codex-direct-cdp-"));
  const port = await getFreePort();
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-gpu",
    "--window-size=1440,1000",
  ];
  if (!options.headed) chromeArgs.push("--headless=new");
  chromeArgs.push(options.url);

  const child = spawn(chrome, chromeArgs, { stdio: ["ignore", "ignore", "ignore"] });
  let cdp;
  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 10000);
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 3000);
    const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target) throw new Error("No page target exposed by Chrome");
    cdp = await connectCdp(target.webSocketDebuggerUrl, 3000);
    const results = [];
    for (let i = 0; i < options.runs; i += 1) {
      results.push(await runOnce(cdp, options.url, options.timeoutMs, options.screenshot && `${options.screenshot}.${i + 1}.png`));
    }
    console.log(JSON.stringify({
      runtime: "direct-cdp",
      chromeVersion: version.Browser || null,
      profile,
      isolatedProfile: true,
      results,
    }, null, 2));
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    if (!options.keepProfile) {
      // Chrome may keep cache files open for a short time after SIGTERM.
      // Wait briefly, then remove only this explicitly-created temp profile.
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // A locked cache file is harmless; the profile is isolated and not reused.
      }
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ runtime: "direct-cdp", error: error.message }, null, 2));
  process.exitCode = 1;
});
