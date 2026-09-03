# Migration status

This repository is frozen as the direct-CDP prototype and migration history.
Its final active implementation baseline is commit `8917906`.

The canonical implementation now lives in
[`agent-eval-platform/packages/browser-runner`](https://github.com/kouhkh/agent-eval-platform/tree/main/packages/browser-runner).
It owns browser sessions, evidence, deadlines, cancellation, mutation intent,
dialog handling, uploads and the REST/CLI/MCP adapters. New fixes and features
belong there so those contracts cannot diverge across two runtimes.

Do not delete this repository: its Git history explains the measured
direct-CDP experiments and the origin of the migrated safety contracts. Do not
publish or extend it as a second production runner.
