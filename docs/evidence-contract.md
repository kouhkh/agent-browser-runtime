# Evidence contract

The session manager owns browser evidence. Callers do not decide whether a
browser operation is recorded.

## Mandatory artifacts

Every `navigate`, `inspect`, `screenshot`, `wait-for`, `click`, `fill`,
`upload`, and `auth-check` operation writes one JSON object to
`<evidenceDir>/trace.ndjson` and at least one PNG screenshot. `click`, `fill`,
and `upload` write both before and after screenshots.

Page text is derived once from the rendered `body.innerText`, normalized, and capped at
8,000 characters. The result and trace report the total character count and whether the
returned text was truncated. This prevents ancestor/descendant text duplication from
turning a short inspection into a large agent-context payload.

Each trace contains:

- session and operation ids;
- action, label, CSS selector, start/end time, deadline and elapsed time;
- page URL, title, ready state and visible-text length;
- response count, encoded network bytes, HTTP errors and failed requests;
- screenshot paths and the highlighted element's bounding box;
- terminal status, structured error code and error text;
- the explicit authorization scope for mutation-capable actions.

`fill` values are never written to the trace. Only a redacted marker and input
length are retained. Uploads record file names and sizes, not file contents.
Browser-native password masking still applies to the screenshot.

## Visual annotation

Screenshots are created inside the runtime. Before capture it temporarily adds:

- a red outline around the CSS-selected target;
- a visible mouse pointer over the target;
- a red step label at the top-left of the viewport.

The overlay is removed immediately after capture. It is not a business-data
mutation and is never persisted by the page.

## Authorization boundary

`click`, `fill`, and `upload` require a non-empty `--authorization` value describing the
approved target and scope. The runtime rejects the command if it is absent.
This field is an audit assertion, not a replacement for the caller's duty to
verify user permission and environment identity.

When a shared session is waiting for authentication, ordinary actions remain
blocked. An application-specific harness may pass `--auth-bootstrap` only for
login-page `inspect`, `screenshot`, `wait-for`, `click`, and `fill` operations
using a deliberately configured test account. Credential values should be
read with `--value-env`; fill evidence still stores only a redacted marker and
length. The harness must complete a successful `auth-check` before business
operations continue.

The interaction surface deliberately starts with CSS selectors. A caller that
cannot express an operation through this surface must report the missing
runtime capability; it must not silently connect another client directly to
the shared CDP port and then claim an audited result.

Ordinary button/link clicks use the selected element's native DOM `click()`
after visibility/disabled checks and evidence capture. Coordinate-dependent
gestures such as drag, hover menus, or canvas interaction are intentionally a
separate future surface; they must not be approximated through an unbounded
low-level mouse-event sequence.

## Example

```bash
node scripts/browser_session_runner.mjs start \
  --shared --session planora-test \
  --evidence-dir ./artifacts/planora-acceptance

node scripts/browser_session_runner.mjs request \
  --shared --session planora-test --action navigate \
  --url http://test.example/projects --label "Open project list" \
  --timeout-ms 15000

node scripts/browser_session_runner.mjs request \
  --shared --session planora-test --action click \
  --selector '[data-testid="open-project"]' \
  --label "Open acceptance project" \
  --authorization "User-approved public test acceptance" \
  --timeout-ms 8000
```

Inspect `trace.ndjson` and the referenced PNGs before reporting a pass. A
successful command proves only the browser action completed; the caller must
still add and evaluate the business assertion.
