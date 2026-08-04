---
type: Fixed
pr: 3047
---
**Documentation now shows the command form that actually works** — reader-facing docs instructed users to type `/gsd:<command>`, a form no runtime registers, so copying it produced an unrecognized command. All 178 occurrences across 53 files, including the Japanese, Korean, Portuguese and Chinese mirrors, now use `/gsd-<command>`. A new lint keeps it from drifting back, while leaving the colon form intact where it is load-bearing — source artifacts, where install-time converters key on it — and preserving the genuine `/gsd-core:<command>` plugin namespace. (#2903)
