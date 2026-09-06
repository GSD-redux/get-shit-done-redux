---
type: Fixed
pr: 4392
---
**`model_profile_overrides` now works on the claude runtime** — the documented per-runtime tier override was accepted and never read there; it now resolves, mapped to the agent alias Claude Code can actually spawn. The `model_overrides` documentation is corrected to state which values hold on claude, and `fable` is listed as the supported alias it already was. (#4192)
