---
type: Fixed
pr: 0
---
**Global OpenCode/Kilo installs no longer pin a tier-default model over your session selection** — a project's `model_profile: "inherit"` was invisible to the install-time resolver on global installs (it probes from the install dir and never reaches the project), so the `balanced` default silently baked e.g. `anthropic/claude-opus-4-8` into the agent frontmatter, which those runtimes use over the live `/model` selection — producing "Model not found" on providers without that exact id. A profile that cannot be verified now bakes no `model:` line, so subagents follow the session model as documented; declare `model_profile` in `~/.gsd/defaults.json` to pin tiers machine-wide. (#3543)
