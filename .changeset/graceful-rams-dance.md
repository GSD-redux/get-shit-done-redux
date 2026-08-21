---
type: Fixed
pr: 3732
---
**`/gsd:config --integrations` no longer prescribes writes that fail** — the review-models section states the real rule (only reviewer lanes whose capability declares a modelConfigKey are settable; the nine settable lanes are enumerated; cursor/qwen/coderabbit named as keyless) instead of a validation pattern that never existed, and agent-skill lists are now written as JSON arrays instead of a comma-joined string that resolves as one broken skill path. (#3651)
