---
id: 159
title: Complexity-Triggered Refactor
group: v1.7.0 Features
---

**Behavior:** An `execute:post` step measures the complexity of the files a phase touched (decision-point counting over comment- and literal-stripped source, no external dependency) and surfaces a scoped refactor proposal at `.planning/phases/<N>/<NN>-REFACTOR.md` when a function's score exceeds `refactor.complexity_threshold` or its growth over its recorded anchor exceeds `refactor.complexity_jump_delta` — whichever trips first, both reported. Trigger semantics are strictly greater (ESLint's `complexity: {max: N}` convention), so a score exactly equal to the threshold does not trigger. The anchor is set the first time a function is observed and moves only when the proposal is dispositioned via `refactor accept` or `refactor decline` — never when the score alone improves — so the jump delta is cumulative growth since the last conscious decision about that function, not the change made in a single phase. Advisory by default: the proposal is informational only, never edits code, and never blocks. Opt-in `refactor.trigger_strict` records an untriaged proposal as an open `deviation` entry in the broken-windows ledger (#1950) instead — it does not block on its own; ship-blocking is broken-windows' existing `ship:pre` gate, enabled separately with `workflow.windows_enforce`. Without broken-windows installed, strict mode still records the proposal locally and says so. Enabling `refactor.trigger_strict` without `workflow.windows_enforce` also on (or with broken-windows absent) surfaces a typed `refactor_strict_not_enforcing` warning on every triggering evaluate, naming the exact remediation, so this enforcement gap is never silent. A declined proposal resolves its ledger entry as `waived` with the recorded reason; an accepted one resolves as `fixed`. The metric is approximate by construction: biased against a flat `switch`, blind to nesting depth, JS/TS-family only, and a renamed function loses its anchor (issue #1953).

**Commands:** `gsd-tools refactor evaluate | status | accept | decline`.

**Config:** `refactor.trigger_enabled` (master gate, default `false`), `refactor.complexity_threshold` (default `15`), `refactor.complexity_jump_delta` (default `5`), `refactor.trigger_strict` (default `false`). See [Configuration Reference](CONFIGURATION.md#refactor-trigger-settings).

**Backward compatibility:** Off by default. When `refactor.trigger_enabled` is `false` the hook never runs and writes nothing; a project that never enables it is completely unaffected.
