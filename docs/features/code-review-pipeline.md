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

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.code_review` | boolean | `true` | Enable code review commands |
| `workflow.code_review_depth` | string | `standard` | Default review depth: `quick`, `standard`, or `deep` |
| `workflow.code_review_depth_overrides` | array | `[]` | Ordered `{ paths, depth }` rules that escalate depth for directories matched by path prefix against the changed-file set (#2554). See below. |

**Path-scoped code review depth overrides**

`workflow.code_review_depth_overrides` matches rules against the review's changed-file set by whole-segment directory-path prefix — `src/auth` matches `src/auth/token.ts` and `src/auth` itself, never `src/authfoo/x.ts` or `docs/src/auth/x.ts` — and is case-sensitive, following git.

Escalation is **whole-review, not per-file**: depth is a single scalar handed to the reviewer agent, not a per-file setting, so the strongest matching tier across the whole rule set applies to every file in the review — a sensitive file is never reviewed shallowly because it shared a review with an unrelated one.

v1 supports **directory-prefix matching only, not glob syntax**: no glob engine (`minimatch`, `picomatch`, `fast-glob`) exists in this project and none was added for this feature. A path containing `*` or `?` (e.g. `src/auth/**`) is a configuration error rather than a silent near-miss, because accepting it as sugar for a prefix would make unsupported patterns look armed when they match nothing. Every use case in the issue is expressible as a directory prefix. See [Scope code review depth by path](how-to/scope-code-review-depth-by-path.md) for the resolution order, error table, and a worked example.
