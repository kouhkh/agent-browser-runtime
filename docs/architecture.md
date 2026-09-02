# Architecture and operating model

## Problem boundary

The observed 30-second symptom is at the boundary between a managed browser
bridge and its caller: a stale tab or binding can remain selected while the
bridge has no explicit cancellation edge, so the outer tool's default
30,000 ms deadline becomes the visible delay. The runtime here removes that
coupling for standalone diagnostics; it does not alter Codex's built-in
Browser host.

## Components

1. **Session manager** owns one isolated Chrome process, one page target, a
   lease, heartbeat checks, and a local control socket.
2. **Operation boundary** serializes navigation/inspection, carries an
   `AbortSignal`, and enforces a caller-supplied deadline.
3. **Invalidation path** marks the session stale and terminates Chrome on tab
   loss, CDP disconnect, timeout, cancellation, lease expiry, or process exit.
4. **One-shot probe** measures a fresh process separately from warm-session
   operations, including page/network counters.
5. **Adapters** (the Codex skill today; Playwright or an HTTP/MCP adapter later)
   translate an agent request into this stable session contract.

## Request flow

```text
agent -> adapter -> session socket -> BrowserSession
                         |                |
                         |                +-- CDP Page/Runtime/Network
                         +-- state.json lease/health/evidence
```

There is no automatic retry on the same tab. A retry is an explicit new
session (or `restart`) after the stale result is observed. This avoids hidden
duplicate navigation and makes timeout cost measurable.

## Why CDP first

CDP is the smallest dependency-free execution layer available in this
repository. Playwright remains a compatible higher-level adapter when robust
locators, browser contexts, or richer assertions are needed. Neither choice
removes the need for leases, cancellation, and stale-session invalidation;
those are lifecycle guarantees above the protocol.

## Security and environment rules

- Profiles are isolated and temporary by default.
- No credentials are collected or copied by the runtime.
- Remote targets must be identity-checked and explicitly authorized by the
  caller. Test, customer, and intranet environments are never interchangeable.
- The current actions are read-only. Mutation-capable actions require a
  separate reviewed adapter and an explicit authorization boundary.

## Next increments

- Add a Playwright adapter that implements the same session contract.
- Persist structured traces (operation id, timings, bytes, stale reason) in an
  evidence store without retaining page secrets.
- Add a control-plane API for `createSession`, `health`, `navigate`, `inspect`,
  `cancel`, `close`, and `getTrace`.
- Compare cold-start, warm-session, page/network, and bridge timings in CI.
