# Phase effort is estimated against a calibrated smart-zone budget, not a static heuristic

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–3 execute against. No production code lands in this PR.)
- **Date:** 2026-07-24
- **Issue:** #2629
- **Epic:** #1952 (Phase 0 design lock; epic stays open until Phase 3 merges)
- **Implementation:** Phase 1 #2630 (module + config), Phase 2 #2631 (planner emits), Phase 3 #2632 (actuals + calibration loop)

## Context

GSD sizes a phase with a static prose heuristic and never checks it against reality. `agents/gsd-planner.md` `<scope_estimation>` maps a phase to Light/Medium/Heavy and targets "~50% context budget, 2-3 tasks"; `agents/gsd-plan-checker.md` Dimension 5 pass/fails on it. No figure is recorded in the plan, no actuals are captured, and nothing calibrates the heuristic against what phases actually cost. The developer learns a phase was oversized only when the executor runs long and output quality degrades.

That matters more for an LLM executor than it did for humans, because degradation begins well before the advertised context window is full.

## Decision

### 1. `estimate` — additive, optional PLAN.md frontmatter

```yaml
estimate:
  tokens: 60000        # integer > 0 — projected execution cost
  tasks: 5             # integer > 0 — task count the projection assumes
  confidence: med      # low | med | high — DERIVED, not self-rated (see below)
```

Optional. A PLAN.md without `estimate` behaves exactly as today.

**`confidence` is derived from calibration sample count, not from the planner's self-assessment.** It is a pure function of how much measured history backs the number:

| Calibration samples (`n`) | `confidence` |
|---|---|
| `n < 3` (no correction applied) | `low` |
| `3 <= n < 6` | `med` |
| `n >= 6` | `high` |

This is deliberate and it is the one place this ADR overrules the obvious design. Asking the planner to rate its own certainty is endogenous self-assessment, and this project has **measured** that mechanism and found it weak: `gsd-core/references/honest-verifier.md:25-29` records that "abstain if unsure" moves a confident-false-pass rate only 100% → 67%, "and only on ambiguity it already notices; on a true blind spot it stays confidently wrong." `honest-verifier.md` therefore routes on an exogenous tag and contains no "are you sure?" prompt, and `.out-of-scope/general-purpose-agent-prompt-skills.md` (#2614) declines core mechanisms centered on self-rated confidence on exactly that evidence.

Deriving `confidence` from `n` keeps the field exogenous and reproducible: two planners looking at the same project must produce the same value, and the field answers the question a reader actually has — *how much measured history is behind this figure?* — rather than how certain the model happens to feel.

### 2. `actuals` — additive, optional SUMMARY.md frontmatter, measured on the *same scale*

```yaml
actuals:
  tokens: 74000        # estimateTokens() over the realized diff
  tasks: 5
  commits: 7
```

**`actuals.tokens` is not harness-reported token usage.** An executor subagent cannot read its own consumption — real counts exist only in the Claude Code statusline hook input (`hooks/gsd-statusline.js:314`, `context_window.current_usage`), which is not available to a spawned agent. Actuals are therefore measured with the **same `estimateTokens()` function** (`src/prompt-budget.cts:87`) applied to the realized diff.

This is a deliberate choice, not a workaround. The calibration ratio is only meaningful if numerator and denominator share a scale; pairing a chars/4 estimate with a harness-reported actual would measure the gap between two *measurement methods*, not the gap between projection and reality.

### 3. The smart-zone budget is a policy default, not a benchmark constant

New config key `workflow.smart_zone_tokens`, default `100000`, positive integer.

The literature cited on #1952 converges on the qualitative claim — degradation starts before the advertised ceiling, is non-uniform, and worsens as advertised windows grow — but **none of it yields a universal number**:

- Liu et al., *Lost in the Middle* (arXiv:2307.03172) — U-shaped positional degradation.
- Chroma Research, *Context Rot* (2025) — a "200K window" model can degrade significantly at 50K.
- Modarressi et al., *NoLiMa* (arXiv:2502.05167) — GPT-4o falls from 99.3% to 69.7% at 32K on latent association.
- Hsieh et al., *RULER* (arXiv:2404.06654) — only half of models claiming ≥32K hold up at 32K.

The effective ceiling is model-, task-, and distractor-dependent. **100k is a conservative operating policy that the calibration loop is expected to correct per project.** Anyone reading this later: do not cite 100000 as a measured constant, and do not "fix" it by pointing at a benchmark. It is configurable precisely because it will drift as models change.

### 4. Calibration: median ratio, clamped, with a minimum sample count

```
ratio_i  = actuals_i.tokens / estimate_i.raw_tokens  (per PLAN, with BOTH fields)
factor   = clamp(median(ratio_i), 0.5, 3.0)          when n >= 3
factor   = 1.0                                        when n <  3
```

- **Median, not mean** — one pathological phase (an aborted run, a mass rename) must not swing the projection for every later phase.
- **Clamped to [0.5, 3.0]** — bounds the blast radius of a degenerate history; a factor outside that range indicates the estimator is wrong in kind, not in degree, and should be fixed rather than amplified.
- **`n >= 3` before any correction applies** — below that, the sample says more about variance than about bias.
- **The denominator is the RAW projection, not the emitted (already-corrected) figure** — amended #2632. Measuring `actual / calibrated` is self-defeating: once the correction works the observed ratio approaches 1, which drags the median back toward 1 and un-corrects the next estimate. Simulated over 10 phases against a true 2x miss it oscillates and settles near 1.41 instead of converging on 2.0. Plans therefore record `estimate.raw_tokens` alongside the calibrated `estimate.tokens`, and `calibrationBasis()` prefers it (falling back to `tokens` for plans written before #2632, where no factor had yet been applied).
- **Samples are per PLAN, not per phase** — amended #2632. A phase holds several `<NN>-<PP>-PLAN.md` files; pairing at phase granularity cross-pairs one plan's projection with another's cost and discards the rest.
- **The raw/calibrated distinction is enforced by the type system, not by convention** — amended #2671. `--calibrated` and `raw_tokens` fix the two known call sites but remain conventions the *next* caller must also remember, and the failure mode is silent: both states are positive integers of the same magnitude, so no runtime check can tell them apart. `src/phase-estimation.cts` therefore gives them distinct branded types, `RawTokens` and `CalibratedTokens`, so `applyCalibration(alreadyCalibrated, factor)` and `{ estimateTokens: estimate.tokens }` are compile errors under `npm run build:lib` rather than review findings. The brands erase at compile time — no `.cjs` behavior change, no wire-format change, and untyped `.cjs` callers are unaffected, which is why every runtime guard in the module stays in place. Compile fixtures live in `tests/fixtures/brand-typing/` and are driven through the TypeScript compiler API by `tests/phase-estimation.test.cjs`.

Persisted to `.planning/estimation-calibration.json` with a `schema_version` field, written by `extract-learnings`, read at plan time. Versioned from the first write so the schema can migrate without a silent misread.

### 5. The over-budget flag is advisory, never a block

An estimate exceeding the budget produces a warning plus a split recommendation. It does not fail planning, does not block execution, and does not gate a PR. GSD advises on phase size; it does not overrule the developer on it.

### 6. Calibration lives in `extract-learnings`, not `gsd-verifier`

#1952 proposed "`gsd-verifier.md` or `extract-learnings`". The choice is forced: `tests/agent-size-budget.test.cjs` caps LARGE-tier agents at 49,152 bytes and `agents/gsd-verifier.md` is 49,140 — **12 bytes of headroom.** `gsd-core/workflows/extract-learnings.md` is 12,893 bytes against a 40,960 DEFAULT cap, and already reads every `*-SUMMARY.md` for the phase.

Recorded because the reasoning is invisible from the code: a future contributor asking "why isn't this in the verifier, next to the other phase-completion analysis?" will otherwise re-litigate it and hit the cap.

## Rationale

- **Additive-optional keeps Hyrum's Law in check.** Both new blocks are optional, so every existing PLAN.md and SUMMARY.md, and every consumer that reads them, is unaffected. No migration.
- **Gall's Law.** This grows the existing working system — the Context Weight heuristic — into a recorded figure, then into a calibrated one. It does not replace phase sizing with a new engine.
- **The estimate is the quantitative backbone under tracer-first planning (#1945).** Tracer bullets say *slice thin*; the estimate says *here is the measured reason this phase must be sliced, and how big the slices should be for this codebase*.
- **Estimation without calibration is the failure mode being fixed, not a smaller version of it.** Hunt & Thomas's discipline is to log the estimate, track it against the actual, and investigate a wide miss. A fixed heuristic that never learns stays wrong in the same direction forever — which is the status quo.
- **Every signal in this design is exogenous.** The correction routes on a measured ratio; `confidence` routes on a sample count. Nothing routes on the model's self-assessment. This is the same property `honest-verifier.md` names "exogenous, not endogenous", applied to estimation — and it is what places this work inside the carve-out in `.out-of-scope/general-purpose-agent-prompt-skills.md`, which denies *self-rated* confidence mechanisms while explicitly excepting "objectively-measured or externally-triggered calibration… a categorically different mechanism."

## Consequences

- PLAN.md and SUMMARY.md each gain one optional frontmatter block; `docs/reference/plan-md.md` gains an `estimate` row.
- One new config key, and one new pure module (`src/phase-estimation.cts`) that imports `estimateTokens` from `prompt-budget.cts` rather than copying it — no duplicated constant to drift.
- The estimator and the default budget must be revisited as models change. Mitigated by making the budget configuration and the correction self-calibrating.
- Calibration is inert on a project's first two phases (`n < 3`). This is intended: a correction derived from one or two samples is noise wearing a decimal point.
- Phases 1 and 2 each merge with a surface the next phase consumes. Phase 1's module is deliberately unconsumed at merge; Phase 2 emits an uncalibrated estimate. The loop is only closed by Phase 3, and **the epic does not close before it is.**

## Revisit if

- A runtime makes real per-agent token accounting available to a spawned subagent. Decision 2's same-scale rule should then be re-examined — though note that switching `actuals` to a different scale invalidates the accumulated calibration history, so the migration must reset `.planning/estimation-calibration.json`, not reinterpret it.
- The clamp in Decision 4 is hit routinely in practice. That is evidence the estimator is systematically wrong rather than noisy, and the fix belongs in the estimator, not in a wider clamp.

## References

- `gsd-core/references/context-budget.md` — existing context-degradation tiers and the `context_window` / `workflow.context_guard_mode` keys this sits beside.
- `src/prompt-budget.cts:87` — `estimateTokens`, the shared measurement primitive.
- `tests/agent-size-budget.test.cjs` — the tier caps that force Decision 6.
- `gsd-core/references/honest-verifier.md:25-29` — the measured result that self-rated confidence is weak, and the exogenous-not-endogenous property Decision 1 inherits.
- `.out-of-scope/general-purpose-agent-prompt-skills.md` (#2614) — denies self-rated-confidence mechanisms in core; its "What this does NOT cover" section excepts externally-measured calibration, which is what this ADR specifies.
- [ADR-2164](2164-statusline-scope-boundary.md) — prior art for a scope-boundary policy ADR.
- Issues: #1952 (epic), #1945 (tracer-first), #2630 / #2631 / #2632 (implementation phases).
