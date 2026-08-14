---
type: Fixed
pr: 3425
---
**GSD skills no longer override the caller's effort level** (#3151) — invoking `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-autonomous`, `/gsd-next`, `/gsd-progress`, or `/gsd-stats` previously set `output_config.effort` to a static value baked into the skill frontmatter; when that differed from the session's effort (which it did ~76% of the time), it invalidated the entire prompt cache at both scope boundaries (skill entry and exit). These skills now run at the session's existing effort level (no `effort:` emitted into SKILL.md). The elevated-effort intent is preserved on the source command files; only the skill-frontmatter emission is dropped. The separate agent-effort surface is unaffected.
