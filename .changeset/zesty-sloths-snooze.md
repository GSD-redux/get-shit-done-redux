---
type: Fixed
pr: 2566
---
**Codex installs no longer downgrade write-capable agents to a read-only sandbox** — previously every agent role missing from the installer's 11-entry sandbox map (15 roles, including `gsd-code-reviewer`, `gsd-code-fixer`, and `gsd-doc-writer`) was generated with `sandbox_mode = "read-only"` and could not write its declared outputs, while `validate agents` reported the install as clean. Unmapped roles now derive their sandbox from the agent's declared tool contract, and `validate agents` semantically checks each generated sandbox against the contract, reporting violations in a new `sandbox_violations` field. (#2540)
