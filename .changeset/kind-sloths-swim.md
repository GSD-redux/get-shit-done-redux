---
type: Fixed
pr: 4396
---
**Explicit model pins now hold on the Claude runtime** — set `model_profile_overrides.claude.<tier>` (e.g. pin the opus tier to `claude-opus-4-7`) and the resolver silently returned the bare tier alias anyway, and a fully-qualified Claude model ID in `model_overrides` was warn-dropped to tier resolution even though the configuration docs promise any fully-qualified model ID is valid; both are now resolved as configured (values naming the current tier default still collapse to their alias, so nothing changes for unpinned installs), and the docs now state the claude-runtime pin contract including the `fable` alias. (#4192)
