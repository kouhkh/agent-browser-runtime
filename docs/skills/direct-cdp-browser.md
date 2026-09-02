---
name: direct-cdp-browser
description: Use an isolated local Chrome over direct CDP for fast, read-only page navigation and DOM checks when a managed browser bridge is slow or timing out.
---

# Direct CDP browser

This adapter starts an isolated Chrome profile and talks to the Chrome DevTools
Protocol directly. It is intended for coding-agent diagnostics and repeatable
web checks; it is not a replacement for a managed browser when an existing
signed-in session is required.

## Scope and safety

- Use a temporary, isolated Chrome profile. Never read or copy cookies,
  storage, passwords, or an existing profile.
- Keep operations read-only. The included helpers only navigate and inspect
  visible DOM state.
- Verify the exact target environment and host identity before checking a
  remote system. Do not use this adapter for customer or intranet hosts
  without explicit authorization.
- Do not submit forms, upload files, or follow destructive links.

## One-shot check

```bash
node scripts/direct_cdp_browser.mjs \
  --url https://example.com --runs 3 --timeout-ms 15000
```

Each run emits one JSON record containing navigation, DOM-evaluation, title,
visible-character, response-count, encoded-byte, and Chrome-process timings.
There is no fixed 30-second outer bridge deadline.

## Reusable session

Use the session manager for multiple operations. It owns one isolated Chrome
process and a local newline-delimited JSON control socket.

```bash
node scripts/browser_session_runner.mjs start \
  --session diagnosis --lease-ms 900000
node scripts/browser_session_runner.mjs request \
  --session diagnosis --action health
node scripts/browser_session_runner.mjs request \
  --session diagnosis --action navigate \
  --url https://example.com --timeout-ms 5000
node scripts/browser_session_runner.mjs request \
  --session diagnosis --action inspect --timeout-ms 5000
node scripts/browser_session_runner.mjs stop --session diagnosis
```

Set `DIRECT_CDP_CHROME` when Chrome is not at the macOS default path. Set
`DIRECT_CDP_SESSION_ROOT` to choose where session state and the isolated
profile are stored. Pass `--headed` only when a user must sign in manually to
this dedicated profile.

## Lifecycle and timeout rules

- A session has `starting`, `ready`, `busy`, `stale`, and `closed` states.
- A lease, heartbeat, target-id check, and single-flight operation prevent
  stale tabs from being reused.
- Every operation has an explicit bounded timeout. A timeout or cancellation
  invalidates and terminates the isolated Chrome process; callers must create a
  fresh session for a retry.
- The runner never retries a failed operation automatically.
- Supported actions are deliberately limited to `health`, `navigate`,
  `inspect`, `cancel`, and `close`.

If direct CDP is fast while a managed browser is slow, the evidence points to
the managed bridge/service path rather than page/network work. If direct CDP is
also slow, inspect the emitted page/network timing fields before attributing
the delay to a bridge.
