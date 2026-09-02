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
5. **Shared-auth coordinator** (only for an explicitly shared session) records
   auth state and epoch, turns an observed login redirect into one
   `auth-required` condition, and lets other callers wait on state rather than
   repeatedly probing the browser.
6. **Adapters** (the Codex skill today; Playwright or an HTTP/MCP adapter later)
   translate an agent request into this stable session contract.

## Request flow

```text
agent -> adapter -> shared session socket -> BrowserSession
                         |                |
                         |                +-- CDP Page/Runtime/Network
                         +-- state.json lease/health/evidence
```

There is no automatic retry on the same tab. A retry is an explicit new
session (or `restart`) after the stale result is observed. This avoids hidden
duplicate navigation and makes timeout cost measurable.

For a shared headed session, all local callers use the same opaque session id
and socket. The Chrome profile lives below that session directory and is
preserved across `stop`/`restart` unless `--remove-profile` is explicitly
used. A caller that sees a login redirect or failed auth marker writes
`auth.status=required`; other callers can use `wait-auth`, which reads only the
state file and does not issue repeated page requests. A successful
`auth-check` (or an explicit acknowledgement after the user signs in) moves
the state to `ready` and increments `auth.epoch`. The business operation that
encountered expiry is not retried implicitly.

## Why CDP first

CDP is the smallest dependency-free execution layer available in this
repository. Playwright remains a compatible higher-level adapter when robust
locators, browser contexts, or richer assertions are needed. Neither choice
removes the need for leases, cancellation, and stale-session invalidation;
those are lifecycle guarantees above the protocol.

## Security and environment rules

- Profiles are isolated and temporary by default.
- `--shared` opts into one persistent, still-isolated profile under
  `~/.agent-browser-runtime/sessions`; it must never point at a normal user
  Chrome profile.
- No credentials are collected or copied by the runtime.
- The local control socket and state file are mode `0600`; this limits access
  to the local OS user but is not an agent identity/ACL system.
- A per-session lock file prevents two runner processes from opening the same
  Chrome profile concurrently. Stale lock files are reclaimable only after the
  recorded owner PID is no longer alive.
- Remote targets must be identity-checked and explicitly authorized by the
  caller. Test, customer, and intranet environments are never interchangeable.
- The current actions are read-only. Mutation-capable actions require a
  separate reviewed adapter and an explicit authorization boundary.

## Next increments

- Add a Playwright adapter that implements the same session contract.
- Persist structured traces (operation id, timings, bytes, stale reason) in an
  evidence store without retaining page secrets.
- Add a hardened control-plane API for `createSession`, `health`, `navigate`,
  `inspect`, `cancel`, `close`, `getTrace`, and explicit auth handoff. It needs
  per-agent identity/ACL, owner leases, a user notification channel, and
  bounded wait semantics before it can serve multiple machines or untrusted
  local users.
- Compare cold-start, warm-session, page/network, and bridge timings in CI.
