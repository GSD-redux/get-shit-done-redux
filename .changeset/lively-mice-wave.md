---
type: Fixed
pr: 3893
---
**Sentinel phases no longer skew estimation calibration.** Backlog and icebox phase directories (milestones 0 and 999) were counted as completed phases when rebuilding the calibration factor, so a single one could switch calibration on from phantom evidence and two could corrupt the factor outright. (#3882)
