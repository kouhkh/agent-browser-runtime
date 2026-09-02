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
