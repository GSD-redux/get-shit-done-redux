---
type: Fixed
pr: 0
---
**Bracket-convention icebox and pre-milestone directories no longer produce spurious health warnings** — the disk-side guards could not see bracket sentinel-ness (it lives in the milestone portion of `GSD.999-07-icebox`), so icebox dirs false-fired as roadmap orphans. A dir-aware sentinel recognizer now excludes them exactly like their legacy twins. (#3639)
