---
type: Added
pr: 4471
---
**`workflow.compact_content` now actually does something: `plan-phase` is the first workflow split into a spine + detail file.** With the key off (default), nothing changes — the spine reads the deferred elaboration back in before continuing, so the instruction set is identical to today. With it on, that read is skipped and the orchestrator runs on the terser spine alone, which is complete enough to plan a phase correctly on its own. The check and the resolution rule live in one shared reference (`gsd-core/references/compact-content-gate.md`) that future splits reference instead of restating. (#4402)
