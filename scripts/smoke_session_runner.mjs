#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";

const runner = join(fileURLToPath(new URL(".", import.meta.url)), "browser_session_runner.mjs");
const root = mkdtempSync(join(tmpdir(), "agent-browser-runtime-smoke-"));
const session = "smoke";
const env = { ...process.env, DIRECT_CDP_SESSION_ROOT: root };

function run(args) {
  const output = execFileSync(process.execPath, [runner, ...args], { env, encoding: "utf8" });
  return JSON.parse(output.trim());
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr || `runner exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch (error) { reject(new Error(`${error.message}: ${stdout}`)); }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTreeEventually(path) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await delay(100);
    }
  }
}

async function main() {
  const privateUrl = "data:text/html,<title>private</title><main>signed-in fixture</main>";
  try {
    const started = run(["start", "--shared", "--session", session, "--lease-ms", "60000"]);
    if (started.status !== "ready" || started.state?.profileMode !== "shared") {
      throw new Error(`start failed: ${JSON.stringify(started)}`);
    }

    const signedIn = run([
      "request", "--session", session, "--action", "navigate",
      "--url", privateUrl, "--timeout-ms", "5000",
    ]);
    if (!signedIn.ok || signedIn.result?.url !== privateUrl) {
      throw new Error(`fixture navigation failed: ${JSON.stringify(signedIn)}`);
    }

    const checked = run([
      "request", "--session", session, "--action", "auth-check",
      "--url", privateUrl, "--contains", "signed-in fixture", "--timeout-ms", "5000",
    ]);
    if (!checked.ok || checked.status !== "authenticated" || checked.auth?.epoch !== 1) {
      throw new Error(`auth-check failed: ${JSON.stringify(checked)}`);
    }

    const premature = run([
      "request", "--session", session, "--action", "auth-ready", "--agent", "worker-a",
    ]);
    if (premature.ok || premature.errorCode !== "AUTH_READY_NOT_REQUESTED") {
      throw new Error(`premature auth-ready was accepted: ${JSON.stringify(premature)}`);
    }

    const required = run([
      "request", "--session", session, "--action", "auth-required",
      "--agent", "worker-a", "--reason", "fixture_expired",
    ]);
    if (required.errorCode !== "AUTH_REQUIRED" || required.auth?.status !== "required") {
      throw new Error(`auth-required failed: ${JSON.stringify(required)}`);
    }

    const waiting = runAsync([
      "request", "--session", session, "--action", "wait-auth", "--timeout-ms", "5000",
    ]);
    await delay(100);
    const ready = run([
      "request", "--session", session, "--action", "auth-ready", "--agent", "manual-user",
    ]);
    const waited = await waiting;
    if (!ready.ok || ready.auth?.epoch !== 2 || waited.status !== "ready") {
      throw new Error(`auth coordination failed: ${JSON.stringify({ ready, waited })}`);
    }

    const stopped = run(["stop", "--session", session]);
    if (!stopped.ok || stopped.status !== "closed") throw new Error(`stop failed: ${JSON.stringify(stopped)}`);

    const restarted = run(["start", "--shared", "--session", session, "--lease-ms", "60000"]);
    if (restarted.state?.profileMode !== "shared" || restarted.state?.auth?.epoch !== 2 || !existsSync(restarted.state.profileDir)) {
      throw new Error(`restart did not preserve shared auth metadata: ${JSON.stringify(restarted)}`);
    }
    const persisted = run([
      "request", "--session", session, "--action", "auth-check",
      "--url", privateUrl, "--contains", "signed-in fixture", "--timeout-ms", "5000",
    ]);
    if (!persisted.ok || persisted.auth?.epoch !== 2) {
      throw new Error(`profile/auth metadata did not persist: ${JSON.stringify(persisted)}`);
    }
    const finalStopped = run(["stop", "--session", session]);
    if (!finalStopped.ok || finalStopped.status !== "closed") throw new Error(`final stop failed: ${JSON.stringify(finalStopped)}`);
    console.log(JSON.stringify({ ok: true, status: "smoke_passed", session, sharedProfile: true, authEpoch: persisted.auth.epoch }));
  } finally {
    await removeTreeEventually(root);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
