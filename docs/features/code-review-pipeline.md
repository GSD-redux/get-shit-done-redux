---
id: 93
title: Code Review Pipeline
group: v1.34.0 Features
---

**Commands:** `/gsd-code-review`, `/gsd-code-review --fix`

**Purpose:** Structured review of source files changed during a phase, with a separate auto-fix pass that commits each fix atomically.

**Requirements:**
- REQ-REVIEW-01: `gsd-code-review` MUST scope files to the phase using SUMMARY.md and git diff fallback
- REQ-REVIEW-02: Review MUST support three depth levels: `quick`, `standard`, `deep`
- REQ-REVIEW-03: Findings MUST be severity-classified: Critical, Warning, Info
- REQ-REVIEW-04: `gsd-code-review --fix` MUST read REVIEW.md and fix Critical + Warning findings by default
- REQ-REVIEW-05: Each fix MUST be committed atomically with a descriptive message
- REQ-REVIEW-06: `--auto` flag MUST enable fix + re-review iteration loop, capped at 3 iterations
- REQ-REVIEW-07: Feature MUST be gated by `workflow.code_review` config flag
- REQ-REVIEW-08: `workflow.code_review_point` MUST select which loop point the automatic review step registers at (`execute:post` default, or `execute:wave:post`), independent of the `workflow.code_review` on/off gate and of manual `/gsd-code-review` invocation (#3661)

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.code_review` | boolean | `true` | Enable code review commands |
| `workflow.code_review_point` | string | `execute:post` | Loop point for the automatic review: `execute:post` (once per phase, default) or `execute:wave:post` (once per completed wave, scoped to what changed since the phase's prior review). See below. |
| `workflow.code_review_depth` | string | `standard` | Default review depth: `quick`, `standard`, or `deep` |
| `workflow.code_review_depth_overrides` | array | `[]` | Ordered `{ paths, depth }` rules that escalate depth for directories matched by path prefix against the changed-file set (#2554). See below. |

**Reviewing per wave instead of per phase (#3661)**

Setting `workflow.code_review_point` to `execute:wave:post` moves the automatic review from
"once, after the whole phase's waves have all landed" to "once per completed wave." Each
wave's review scopes to what changed since the phase's *previous* review — the whole phase's
diff on the first wave, then just that wave's diff on every wave after — so review batches
stay small instead of growing with the phase. A finding introduced early is caught after the
wave that introduced it, not after the last wave of the phase.

This only affects the *automatic* dispatch inside a wave-based phase execution. Manual
`/gsd-code-review <phase>` runs are gated by `workflow.code_review` alone and are unaffected
by this key. `/gsd-autonomous` and `/gsd-quick` have no wave granularity of their own, so
setting this to `execute:wave:post` means automatic review does not run inside those two
flows — the same way every other wave-scoped capability step already behaves for them.

**Path-scoped code review depth overrides**

`workflow.code_review_depth_overrides` matches rules against the review's changed-file set by whole-segment directory-path prefix — `src/auth` matches `src/auth/token.ts` and `src/auth` itself, never `src/authfoo/x.ts` or `docs/src/auth/x.ts` — and is case-sensitive, following git.

Escalation is **whole-review, not per-file**: depth is a single scalar handed to the reviewer agent, not a per-file setting, so the strongest matching tier across the whole rule set applies to every file in the review — a sensitive file is never reviewed shallowly because it shared a review with an unrelated one.

v1 supports **directory-prefix matching only, not glob syntax**: no glob engine (`minimatch`, `picomatch`, `fast-glob`) exists in this project and none was added for this feature. A path containing `*` or `?` (e.g. `src/auth/**`) is a configuration error rather than a silent near-miss, because accepting it as sugar for a prefix would make unsupported patterns look armed when they match nothing. Every use case in the issue is expressible as a directory prefix. See [Scope code review depth by path](how-to/scope-code-review-depth-by-path.md) for the resolution order, error table, and a worked example.

**Optional external reviewer lanes (#4209)** `/gsd-code-review` accepts the same reviewer-lane flags as `/gsd-review` — any flag the roster declares (run `gsd_run review-lane flags` to list them for your installation, e.g. `--codex`, `--agy`). No reviewer-lane flag is the default and is byte-for-behavior unchanged from before #4209: zero lane selection, plan, or invoke calls, and only the internal `gsd-code-reviewer` agent runs. Passing one or more flags asks those lanes to independently review the same already-resolved file scope alongside the internal agent, through the same shared capability-trait interpreter and `review-lane plan`/`invoke` machinery `/gsd-review` uses — no second implementation. Each lane's prompt carries only the repository root, canonical file paths, review depth, and base SHA, never source file contents, under four fixed prohibitions (no source mutation, no test execution, no background processes, no polling). External findings are unverified corroborating evidence: `gsd-code-reviewer` independently re-verifies every claim against the actual source before writing it to `REVIEW.md`, so there remains exactly one `REVIEW.md` schema regardless of how many lanes ran. An explicitly requested lane that is unavailable or fails is reported as a warning, never silently dropped and never a raw-CLI fallback. This is separate from `/gsd-review`, which reviews `PLAN.md` files before execution, not source code.
