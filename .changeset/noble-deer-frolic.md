---
type: Fixed
pr: 3041
---
**A phase stranded between its last plan and verification can now be recovered** — if every plan carried a SUMMARY but the run never reached the verify step (most often because a checkpoint plan was retired yet still summarized), re-running execute-phase exited immediately and could never produce the missing VERIFICATION.md, so the recommended recovery command silently did nothing. It now resumes at the phase gates instead, with the code-review and regression gates still running. (#2868)
