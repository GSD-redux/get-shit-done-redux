---
type: Fixed
pr: 4048
---
gsd-mempalace-curator no longer hardcodes model: sonnet in its frontmatter — the only pin in the 34-agent fleet; it intercepted the deliberate inherit case (agents inherit the orchestrator model when resolution is inherit) and operators could not durably remove it. Default profiles keep sonnet via the model catalog; model_overrides and inherit now work (#3895)
