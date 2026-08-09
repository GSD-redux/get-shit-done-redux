# How to catch complexity before it compounds

**Goal:** Turn on the complexity-triggered refactor hook, understand the proposals it surfaces after a phase, and dispose of each one — so a function that grew a branch per phase gets refactored while it is still one function, instead of becoming a rewrite nobody noticed accumulating.

**Prerequisites:** A GSD project on v1.10.0 or later. Nothing else — the hook has no external dependency and needs no indexer. It is **off by default**; a project that never enables it is completely unaffected.

For what the metric measures, why the anchor moves only on disposition, and the metric's known biases, see [Complexity-Triggered Refactor](../FEATURES.md#159-complexity-triggered-refactor) and [ADR-1953](../adr/1953-complexity-triggered-refactor.md). This guide covers only how to *use* it.

---

## Turn it on

```bash
gsd config-set refactor.trigger_enabled true
```

That is the whole setup. From the next `/gsd-execute-phase`, an `execute:post` step measures the files that phase touched and writes a proposal only if something crosses a line. Nothing else about the loop changes: the hook never edits code, never picks a refactor, and never blocks.

To check it without running a phase:

```bash
node gsd-tools.cjs refactor evaluate --phase 3 --raw
```

---

## Read a proposal

A triggered proposal lands at `.planning/phases/<N>/<NN>-REFACTOR.md`. It names one **target** — the hotspot — and lists every other candidate it found.

Two numbers matter, and they answer different questions:

- **`score`** — the function's absolute complexity right now. It triggered because it exceeds `refactor.complexity_threshold` (default 15). Answers *"is this function too complex?"*
- **`delta`** — growth over the function's **anchor**, the score recorded the last time you consciously decided about it. It triggered because it exceeds `refactor.complexity_jump_delta` (default 5). Answers *"has this been quietly creeping?"*

A proposal can carry both reasons. The delta is the one worth reading closely: because the anchor does not move on its own, a function gaining two points per phase accumulates against it and trips the delta a phase or more *before* the absolute threshold would have caught it. That gap is the entire point of the second number.

Both thresholds are **strictly greater** — a score of exactly 15 against a threshold of 15 does not trigger. This matches ESLint's `complexity: {max: N}`.

---

## Act on it

A proposal stays untriaged until you disposition it. There are exactly two ways, and **both** clear it:

```bash
node gsd-tools.cjs refactor accept  --phase 3
node gsd-tools.cjs refactor decline --phase 3 --reason "flat dispatch table — branchy by construction, not a hotspot"
```

**Accept** when you intend to refactor. The anchor re-anchors to the function's current score, so after you do the work the next evaluation measures growth from the new, lower baseline.

**Decline** when the complexity is justified. The reason is required and recorded. The anchor re-anchors to the *current* score — you have consciously accepted this much complexity, so the delta clock restarts from here rather than nagging you every phase about growth you already signed off.

> **The score improving does not clear a proposal — only a disposition does.** This is deliberate. If clearing required the number to go down, the cheapest way to satisfy it would be splitting one coherent function into two incoherent ones: identical total complexity, worse cohesion. The gate asks whether you decided, not whether the metric moved.

To see what is outstanding across the project:

```bash
node gsd-tools.cjs refactor status
```

---

## Tune the thresholds

If proposals feel like noise, raise the threshold rather than turning the hook off:

```bash
gsd config-set refactor.complexity_threshold 20     # ESLint's own default
gsd config-set refactor.complexity_jump_delta 8
```

Defaults are 15 (SonarSource's default) and 5. For reference, radon's rank C — "moderate, slightly complex" — begins at 11, and ESLint's `complexity` rule defaults to 20. There is no universally correct number; start at the default and raise it once you have seen a few proposals you disagreed with.

---

## Make it block before ship

Advisory mode surfaces proposals and tracks nothing. To make an untriaged proposal a task that must be resolved before shipping, you need **two** settings, not one:

```bash
gsd config-set refactor.trigger_strict true      # 1. record proposals in the ledger
gsd config-set workflow.windows_enforce true     # 2. make the ledger block /gsd-ship
```

Why two: `refactor.trigger_strict` records an untriaged proposal as an open `deviation` entry in the [broken-windows ledger](../FEATURES.md#158-broken-windows-ledger). The *blocking* is that capability's existing `ship:pre` gate, which is separately opt-in. Setting only the first gives you tracking without enforcement — which is a reasonable place to stop, but it will not stop a ship.

If the broken-windows capability is not installed, strict mode still records the proposal locally and says so in its output (`ledger_recorded: false` with a note). It cannot block on its own.

Dispositioning resolves the ledger entry automatically: `accept` marks it `fixed`, `decline` marks it `waived` with your reason attached.

---

## When it stays quiet

The hook is deliberately silent in several situations. If you expected a proposal and got none, check these before assuming it is broken — `--raw` reports the reason in every case:

| You see | What happened |
|---|---|
| `refactor_no_touched_files` | The phase changed nothing the analyzer looks at. |
| `refactor_analyzer_unsupported` | The file's language or path is out of scope. Only `.js .cjs .mjs .ts .cts .mts` are analyzed; `tests/` and generated `gsd-core/bin/lib/` paths are excluded by design. |
| `refactor_analyzer_unparseable` | An unterminated string, template, or block comment. The analyzer **refuses to emit a score** it cannot defend rather than guessing — a silently wrong number is worse than none. |
| `refactor_git_unavailable` | Not a git repository, `git` missing, the call timed out, or the phase has no committed `PLAN.md` to anchor against. Degrades quietly, exit 0. |
| `refactor_file_unreadable` | One file could not be read, or resolved outside the project root. That file is skipped; the rest of the run continues. |
| Nothing at all, `below_threshold` | Everything the phase touched is under both lines. This is the normal, healthy case. |

Two limits worth knowing up front. A **renamed function loses its anchor** — it reads as a delete plus an add, so it is evaluated against the absolute threshold only until it is dispositioned again. And the metric is **biased against a flat `switch`**: twelve readable cases score 13, which is why proposals are advisory and why `decline` takes a reason instead of demanding a code change.
