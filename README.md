# agent-browser-runtime

`agent-browser-runtime` is a small, dependency-free browser execution layer
for coding-agent diagnostics. It launches an isolated Chrome profile and uses
the Chrome DevTools Protocol (CDP) directly, so a slow or wedged managed
browser bridge cannot hold an operation until an outer 30,000 ms deadline.

The project currently contains two complementary executables:

- `agent-browser-cdp` — one-shot navigation/inspection with timing telemetry.
- `agent-browser-session` — a reusable single-tab session with leases,
  heartbeats, single-flight operations, cancellation, and stale-session
  invalidation.

The runtime is intentionally read-only. It does not submit forms, upload
files, mutate application data, or reuse a user's existing browser profile.
Use a managed browser only when an existing signed-in session or an explicit
human confirmation is required.

## Quick start

Requirements: Node.js 22+ and a local Chrome/Chromium. On macOS the default
Chrome path is used; set `DIRECT_CDP_CHROME` for another installation.

```bash
npm run check
npm run smoke

node scripts/browser_session_runner.mjs start --session demo
node scripts/browser_session_runner.mjs request --session demo --action navigate \
  --url https://example.com --timeout-ms 5000
node scripts/browser_session_runner.mjs request --session demo --action inspect
node scripts/browser_session_runner.mjs stop --session demo
```

For a single measurement:

```bash
node scripts/direct_cdp_browser.mjs --url https://example.com \
  --runs 3 --timeout-ms 15000
```

The JSON output records operation duration and network-byte counters. It is
intended to make bridge overhead, page/network latency, and local Chrome
startup cost distinguishable instead of guessing from one wall-clock timeout.

## Session contract

The session manager writes a `state.json` lease record and exposes a local
newline-delimited JSON socket. Actions are:

`health`, `navigate`, `inspect`, `cancel`, and `close`.

Only one navigation/inspection may run at a time. A caller supplies an
operation timeout (250 ms–120 s). If the deadline fires, or the caller issues
`cancel`, the session becomes `stale` and its Chrome process is terminated.
The caller must explicitly `restart` or start a new session before retrying.
Structured error codes include `STALE_SESSION`, `SESSION_BUSY`, `CANCELLED`,
`OPERATION_TIMEOUT`, and `READ_ONLY_ACTION`.

## Repository layout

```text
scripts/browser_session_runner.mjs  reusable lifecycle-safe runtime
scripts/direct_cdp_browser.mjs      one-shot CDP probe and timing output
scripts/smoke_session_runner.mjs    local end-to-end smoke test
LICENSE                             Apache License 2.0
docs/architecture.md                design and migration boundary
docs/skills/direct-cdp-browser.md   Codex skill adapter instructions
```

The Codex skill is an adapter, not the runtime's source of truth. Other coding
agents can invoke the same CLI or local socket without depending on Codex.

## Design boundary

This repository addresses the execution-layer failure mode where a stale tab,
an unavailable CDP target, or an uncancellable bridge call is allowed to run
into a large outer timeout. It does not claim to fix the managed Browser host
itself, nor does it infer facts about a customer's environment. Environment
identity and authorization remain the caller's responsibility.

See [`docs/architecture.md`](docs/architecture.md) for the control-plane and
adapter design, including the path toward Playwright/CDP-backed test tooling.

## Replacing the managed browser path

This runtime can replace the Codex managed-browser execution path for a useful
subset of coding-agent work: known URLs, health checks, repeatable read-only
navigation, and DOM assertions. It is an execution-layer replacement, not a
replacement for an existing signed-in browser session or for human UI review.

The repeatable workflow is:

```bash
ROOT=$(mktemp -d)
node scripts/browser_session_runner.mjs start \
  --root "$ROOT" --session diagnosis --lease-ms 900000
node scripts/browser_session_runner.mjs request \
  --root "$ROOT" --session diagnosis --action health
node scripts/browser_session_runner.mjs request \
  --root "$ROOT" --session diagnosis --action navigate \
  --url https://example.com --timeout-ms 5000
node scripts/browser_session_runner.mjs request \
  --root "$ROOT" --session diagnosis --action inspect --timeout-ms 5000
node scripts/browser_session_runner.mjs stop \
  --root "$ROOT" --session diagnosis
```

The `stop` response closes the control socket before Chrome's process-exit
event is necessarily observed. If a caller wants to remove `ROOT`, wait until
the recorded Chrome PID is gone and then delete this explicitly created
directory; deleting it immediately can race Chrome's profile flush.

Set `DIRECT_CDP_CHROME` for a non-default Chrome/Chromium installation. Keep
the profile isolated; do not point the runner at a user's normal profile or
copy cookies from the managed browser. A headed isolated profile can be used
for a user to sign in manually, but that is a separate session and does not
reuse Codex's in-app login.

## Measured comparison

The following measurements were made on 2026-09-02 on the same Mac and Chrome
152.0.7977.65. The local fixture was a fixed HTML page served from
`127.0.0.1:8765`; the remote target was the public Planora test environment
`planora / 60.205.205.35`. All actions were read-only.

| Scenario | Codex managed Browser | This runtime | What was saved |
| --- | --- | --- | --- |
| Local fixture, fresh managed tab then two warm navigations | Navigation 59.9/22.6/23.8 ms; DOM evaluate 36.6/14.2/29.0 ms | One-shot CDP total 11.6–35.9 ms across five runs (navigation 2.5–7.9 ms; evaluate 0.8–7.1 ms) | Only tens of milliseconds; both paths are already fast locally. |
| Public test `/login`, fresh managed tab, explicit 10 s outer budget | No result before 10,000 ms; the browser call timed out and its kernel reset | One-shot CDP: first run 3,091 ms, then 116 ms and 66 ms; session runner: first navigation 4,112 ms, then 316 ms and 552 ms; warm DOM inspect about 1 ms (CLI wrapper about 29 ms) | In this sample, a warm check avoided at least 9.8 s of waiting; the first request avoided the managed timeout but still paid real page/network latency. |

An HTTP GET-only profile of the same public `/login` page returned HTML in
51.2 ms (time to first byte 40.9 ms). Crawling its 9 static assets sequentially
took about 1.03 s and transferred 741,508 bytes; the largest assets were two
JavaScript chunks of 222,191 and 199,865 bytes. This is a separate network
baseline, not a browser result, but it shows why a 10-second managed-browser
wait cannot be explained by page size alone.

The public-page result is a timing observation, not a promise that every
managed-browser call takes 10 or 30 seconds. The same managed Browser is fast
for the local fixture, while the isolated runtime has explicit per-operation
deadlines and does not inherit the outer 30,000 ms bridge cutoff. Re-run the
commands above on the target machine before using the numbers as an SLA.

## When it does and does not replace Codex Browser

Use this runtime by default for:

- authenticated-free health and metadata checks after the caller has verified
  the exact environment;
- known-page navigation and visible-DOM extraction;
- repeated coding-agent tests where a stale tab must fail fast and be rebuilt;
- timing comparisons that need page/network bytes separated from bridge cost.

Keep the managed Browser for:

- an existing Codex/in-app login session (this runtime deliberately cannot
  read or copy it);
- user-visible screenshots, manual sign-in, confirmation, or other human
  handoff steps;
- interactions not yet represented by the read-only `navigate`/`inspect`
  contract.

The current implementation therefore replaces the *standalone execution path*,
not every browser capability. A Playwright locator/interaction adapter and a
separate control plane can be added later without changing the session
contract. Neither would remove the need for explicit deadlines, cancellation,
leases, and stale-session invalidation.

## License

This project is licensed under the Apache License, Version 2.0. See
[`LICENSE`](LICENSE) for the complete terms. In short, the license permits
commercial use, modification, and redistribution subject to its notice and
attribution conditions; it also includes an explicit contributor patent grant.
