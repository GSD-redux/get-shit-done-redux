---
type: Fixed
pr: 0
---
**`roadmap.analyze` now discovers non-numeric-leading phase ids** — the phase-heading and checklist discovery regexes required a digit-first id (e.g. `07`), so a project using letter-prefixed ids (e.g. `B7`) got `phase_count: 0` even though `get-phase`/`execute-phase` resolved the same ids fine. The regexes now accept an optional leading letter prefix. (#3036)
