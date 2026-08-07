---
type: Fixed
pr: 3119
---
**Heavy workflow skills no longer fail on Claude with thinking disabled** — `effort: max` in plan-phase, execute-phase, and autonomous SKILL.md frontmatter was rejected by the Anthropic API (`400: effort 'max' is not supported when thinking is disabled`). The installer now clamps `max`/`xhigh` to `high` for Claude-runtime skills, the maximum value that works in both thinking states on all supported models. (#3039)
