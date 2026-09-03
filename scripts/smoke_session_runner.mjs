#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";

const runner = join(fileURLToPath(new URL(".", import.meta.url)), "browser_session_runner.mjs");
const root = mkdtempSync(join(tmpdir(), "agent-browser-runtime-smoke-"));
const session = "smoke";
const env = { ...process.env, DIRECT_CDP_SESSION_ROOT: root, AGENT_BROWSER_SMOKE_VALUE: "bootstrap value" };

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
  const privateUrl = `data:text/html,${encodeURIComponent("<title>private</title><main>signed-in fixture<input id='name'><input id='file' type='file'><button id='apply' onclick=\"document.querySelector('output').textContent=document.querySelector('#name').value\">Apply</button><button id='confirm' onclick=\"if(confirm('Proceed with fixture?')) document.querySelector('#dialog-output').textContent='confirmed'\">Confirm</button><output></output><span id='dialog-output'></span></main>")}`;
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
    if ((checked.result?.visibleText?.match(/signed-in fixture/g) || []).length !== 1) {
      throw new Error(`visible text contains duplicated ancestor text: ${JSON.stringify(checked.result)}`);
    }

    const unauthorizedClick = run([
      "request", "--session", session, "--action", "click", "--selector", "#apply",
    ]);
    if (unauthorizedClick.ok || unauthorizedClick.errorCode !== "AUTHORIZATION_REQUIRED") {
      throw new Error(`click without authorization was accepted: ${JSON.stringify(unauthorizedClick)}`);
    }

    const filled = run([
      "request", "--session", session, "--action", "fill", "--selector", "#name",
      "--value", "audited value", "--label", "Fill fixture", "--authorization", "local smoke fixture",
    ]);
    if (!filled.ok || filled.input?.value || filled.evidence?.screenshots?.length !== 2 || !filled.evidence.screenshots[0]?.found) {
      throw new Error(`audited fill failed: ${JSON.stringify(filled)}`);
    }
    const clicked = run([
      "request", "--session", session, "--action", "click", "--selector", "#apply",
      "--label", "Apply fixture", "--authorization", "local smoke fixture",
    ]);
    if (!clicked.ok || !clicked.result?.visibleText?.includes("audited value") || clicked.evidence?.screenshots?.length !== 2 || !clicked.evidence.screenshots[0]?.found) {
      throw new Error(`audited click failed: ${JSON.stringify(clicked)}`);
    }
    const undeclaredDialog = run([
      "request", "--session", session, "--action", "click", "--selector", "#confirm",
      "--label", "Dismiss undeclared fixture dialog", "--authorization", "local smoke fixture",
    ]);
    if (undeclaredDialog.ok || undeclaredDialog.errorCode !== "DIALOG_REQUIRED" || undeclaredDialog.interaction?.dialog?.handledAs !== "dismiss") {
      throw new Error(`undeclared dialog was not safely rejected: ${JSON.stringify(undeclaredDialog)}`);
    }
    const acceptedDialog = run([
      "request", "--session", session, "--action", "click", "--selector", "#confirm",
      "--dialog", "accept", "--label", "Accept fixture dialog", "--authorization", "local smoke fixture",
    ]);
    if (!acceptedDialog.ok || acceptedDialog.interaction?.dialog?.handledAs !== "accept" || !acceptedDialog.result?.visibleText?.includes("confirmed")) {
      throw new Error(`declared dialog acceptance failed: ${JSON.stringify(acceptedDialog)}`);
    }
    const waitedFor = run([
      "request", "--session", session, "--action", "wait-for", "--selector", "output",
      "--contains", "audited value", "--label", "Wait for fixture output", "--timeout-ms", "5000",
    ]);
    if (!waitedFor.ok || waitedFor.evidence?.screenshots?.length !== 1 || !waitedFor.evidence.screenshots[0]?.found) {
      throw new Error(`audited wait-for failed: ${JSON.stringify(waitedFor)}`);
    }
    const uploaded = run([
      "request", "--session", session, "--action", "upload", "--selector", "#file",
      "--file", runner, "--label", "Upload fixture file", "--authorization", "local smoke fixture",
    ]);
    if (!uploaded.ok || uploaded.interaction?.files?.[0]?.name !== "browser_session_runner.mjs" || uploaded.evidence?.screenshots?.length !== 2) {
      throw new Error(`audited upload failed: ${JSON.stringify(uploaded)}`);
    }
    const tracePath = join(root, session, "evidence", "trace.ndjson");
    const traceText = readFileSync(tracePath, "utf8");
    const traces = traceText.trim().split("\n").map((line) => JSON.parse(line));
    if (traces.length < 7 || traces.some((trace) => trace.action === "fill" && trace.input?.redacted !== true)) {
      throw new Error(`evidence trace is missing or unsafe: ${JSON.stringify(traces)}`);
    }
    if (traceText.includes("audited value")) throw new Error("fill value leaked into evidence trace");
    for (const trace of traces) {
      for (const screenshot of trace.screenshots || []) {
        if (!existsSync(screenshot.path)) throw new Error(`evidence screenshot is missing: ${screenshot.path}`);
      }
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

    const blockedBootstrap = run([
      "request", "--session", session, "--action", "fill", "--selector", "#name",
      "--value-env", "AGENT_BROWSER_SMOKE_VALUE", "--label", "Blocked login bootstrap",
      "--authorization", "local smoke fixture",
    ]);
    if (blockedBootstrap.status !== "auth_required" || blockedBootstrap.auth?.status !== "required") {
      throw new Error(`auth-required did not block ordinary fill: ${JSON.stringify(blockedBootstrap)}`);
    }
    const bootstrapped = run([
      "request", "--session", session, "--action", "fill", "--selector", "#name",
      "--value-env", "AGENT_BROWSER_SMOKE_VALUE", "--label", "Automated test-login bootstrap",
      "--authorization", "local smoke fixture", "--auth-bootstrap",
    ]);
    if (!bootstrapped.ok || bootstrapped.input?.value || bootstrapped.interaction?.valueLength !== 15) {
      throw new Error(`authorized auth bootstrap failed: ${JSON.stringify(bootstrapped)}`);
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
    const timedOut = run([
      "request", "--session", session, "--action", "wait-for",
      "--selector", "#never-matches", "--timeout-ms", "250",
    ]);
    if (timedOut.ok || timedOut.status !== "timeout" || timedOut.stale !== true) {
      throw new Error(`timeout did not invalidate the session: ${JSON.stringify(timedOut)}`);
    }
    const recovered = run(["restart", "--shared", "--session", session, "--lease-ms", "60000"]);
    if (recovered.status !== "ready" || recovered.state?.auth?.epoch !== 2) {
      throw new Error(`restart did not reclaim a stale session: ${JSON.stringify(recovered)}`);
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
