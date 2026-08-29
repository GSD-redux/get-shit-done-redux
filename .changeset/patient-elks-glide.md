---
type: Fixed
pr: 0
---
**Raised the emitted-drift acknowledgment cap from 64 to 128** — a wide-touching maintenance PR could legitimately accumulate more distinct commit-trailer acknowledgments than the old ceiling allowed, failing CI even though nothing was wrong. (#4058)
