---
name: direct-cdp-browser
description: Use an isolated local Chrome over direct CDP for fast, auditable page checks when a managed browser bridge is slow or timing out; authorized interactions are recorded automatically.
---

# Direct CDP browser

Use the repository session runner as the browser control plane. It owns an
isolated Chrome profile, explicit deadlines, stale-session invalidation,
shared-login coordination, and mandatory evidence capture.

Repository root: `/Users/ltc/CodexProject/agent-browser-runtime`

## Required boundaries

- Verify the exact remote environment and host identity before the first
  remote check. Never transfer facts between test, customer, and intranet
  environments.
- Use a temporary isolated profile by default. Use `--shared` only for a
  deliberately selected test account. Never read or copy a normal Chrome or
  managed-browser profile.
- Navigation, inspection, screenshots, and waits are read-only. Use `click`,
  `fill`, or `upload` only when the
  user authorized that mutation on the verified target; pass a concise
  authorization scope to every such command.
- Use the session runner actions. Do not attach Playwright or another client
  directly to the shared CDP port and then claim the result is audited.
- Never retry a timed-out business operation automatically. A timeout makes
  the session stale; restart explicitly only when a retry is justified.

## Session workflow

```bash
RUNNER=/Users/ltc/CodexProject/agent-browser-runtime/scripts/browser_session_runner.mjs

node "$RUNNER" start --shared --session planora-test \
  --lease-ms 86400000 \
  --evidence-dir /absolute/path/to/evidence

node "$RUNNER" request --shared --session planora-test \
  --action auth-check --url http://test.example/dashboard \
  --contains "项目" --label "Verify authenticated project list" \
  --timeout-ms 15000
```

Reuse the same session id from other local tasks. If authentication expires,
record `auth-required` once and use `wait-auth`; do not poll the login page or
repeat the failed business action.

## Audited operations

```bash
# Read-only navigation and evidence screenshot
node "$RUNNER" request --shared --session planora-test \
  --action navigate --url http://test.example/projects/123 \
  --label "Open acceptance project" --timeout-ms 15000

# Highlight an assertion target without business mutation
node "$RUNNER" request --shared --session planora-test \
  --action screenshot --selector '[data-testid="job-progress"]' \
  --label "Observe real job progress" --timeout-ms 8000

# Wait for slow application state instead of guessing a fixed delay
node "$RUNNER" request --shared --session planora-test \
  --action wait-for --selector '[data-testid="job-progress"]' \
  --contains "执行中" --label "Wait for real progress" --timeout-ms 15000

# Authorized file upload; repeat --file for multiple files
node "$RUNNER" request --shared --session planora-test \
  --action upload --selector 'input[type="file"]' \
  --file /absolute/path/sample.docx --label "Upload acceptance sample" \
  --authorization "User-approved public test acceptance" --timeout-ms 15000

# Authorized interaction; before/after evidence is automatic
node "$RUNNER" request --shared --session planora-test \
  --action click --selector '[data-testid="submit"]' \
  --label "Submit sixth rewrite" \
  --authorization "User-approved public test acceptance" \
  --timeout-ms 8000
```

`navigate`, `inspect`, `screenshot`, `wait-for`, and `auth-check` save a
post-operation PNG. `click`, `fill`, and `upload` save both before and after
PNGs. The target is outlined
in red and marked with a mouse pointer. Every operation appends a structured
record to `trace.ndjson` with URL, locator, deadline, elapsed time, network
responses/bytes, screenshots, and terminal result. Fill values are redacted;
only their length is recorded. Uploads retain file names and sizes, not file
contents.

Read [the evidence contract](/Users/ltc/CodexProject/agent-browser-runtime/docs/evidence-contract.md)
before changing the interaction adapter or evidence format.

## Reporting results

A successful browser command proves the action completed, not that the product
behavior is correct. Record the business assertion beside the operation id and
screenshot paths. If the required operation cannot be expressed through the
runtime, report the missing capability and do not silently improvise an
unrecorded fallback.

For a one-shot timing-only measurement that needs no authenticated state or
interaction, `scripts/direct_cdp_browser.mjs` remains available. It reports
Chrome startup, navigation, DOM, response, and byte timings and has no fixed
30-second outer bridge wait.
