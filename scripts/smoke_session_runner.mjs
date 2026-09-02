#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

try {
  const started = run(["start", "--session", session, "--lease-ms", "60000"]);
  if (started.status !== "ready") throw new Error(`start failed: ${JSON.stringify(started)}`);

  const navigated = run([
    "request", "--session", session, "--action", "navigate",
    "--url", "data:text/html,<title>smoke</title><main>agent browser runtime</main>",
    "--timeout-ms", "3000",
  ]);
  if (!navigated.ok || navigated.result?.title !== "smoke") {
    throw new Error(`navigate failed: ${JSON.stringify(navigated)}`);
  }

  const inspected = run(["request", "--session", session, "--action", "inspect", "--timeout-ms", "3000"]);
  if (!inspected.ok || !inspected.result?.visibleText?.includes("agent browser runtime")) {
    throw new Error(`inspect failed: ${JSON.stringify(inspected)}`);
  }

  const stopped = run(["stop", "--session", session]);
  if (!stopped.ok || stopped.status !== "closed") throw new Error(`stop failed: ${JSON.stringify(stopped)}`);
  console.log(JSON.stringify({ ok: true, status: "smoke_passed", session }));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
