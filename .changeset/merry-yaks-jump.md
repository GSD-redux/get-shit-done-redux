---
type: Fixed
pr: 4252
---
**An empty `phase_slug` no longer degrades the phase branch to the literal `gsd/phase-NN-phase`** — a phase whose slug cannot be derived (a directory with no name segment such as `.planning/phases/07`, or a name entirely outside the slug generator's Latin/Cyrillic scope, e.g. a CJK-only name) now drops the `{slug}` segment from `phase_branch_template` together with one adjacent separator (if any), so `query commit` creates and `init execute-phase` reports `gsd/phase-08` — unique per phase, visibly nameless, and consistent with the `phase_slug: null` in the same payload instead of contradicting it. Both sites render `{phase}` and `{slug}` through one shared helper (`renderPhaseBranchName`, phase-id), so on a template without `{project}` `query commit` and `init execute-phase` always compute the same name; `{project}` remains substituted by `init execute-phase` only, before the render, exactly as before. A normally-named phase is unchanged. (#4126)
