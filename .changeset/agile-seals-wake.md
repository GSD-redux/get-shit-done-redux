---
type: Fixed
pr: 2779
---
spec-phase now runs the edge-completeness and prohibition-completeness probes on every gate-passed path; previously all four gate-passed transitions jumped straight to SPEC generation, so a SPEC could ship with empty Edge Coverage and Prohibitions sections.
