---
type: Fixed
pr: 4380
---
**`gsd-tools state begin-phase` without `--phase` now exits non-zero and writes nothing** — previously a missing, empty, or flag-shaped phase argument was silently accepted and wrote a null-phase STATE.md (removing `current_phase`/`current_phase_name` from frontmatter and serialising the literal `Phase null` into three body locations), and took a milestone claim for the phase "null". (#4138)
