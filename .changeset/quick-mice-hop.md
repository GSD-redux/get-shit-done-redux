---
type: Fixed
pr: 3983
---
**Pending-outcome cell no longer leaks across calls in one process.** A CLI run that calls `output()` with a payload-carried error and later returns cleanly, or that runs a second `main()` in the same process, could inherit a stale DEGRADED exit code (80 under the v2 exit contract) from an earlier declaration. The cell now follows last-write-wins semantics and is cleared on consumption. (#3912)
