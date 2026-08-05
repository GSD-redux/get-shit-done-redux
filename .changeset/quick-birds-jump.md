---
type: Fixed
pr: 3084
---
**`roadmap.analyze` no longer silently drops phases when the phase-listing heading isn't version-bearing** — if the phase list lives under a plain `## Phases` heading (the shipped greenfield template's own shape) and a later version-bearing progress/notes heading exists, the milestone scope previously latched onto the later heading and stripped every `### Phase N:` detail from the preamble, returning `phase_count: 0` with exit 0 and empty stderr. Phase details in the preamble are now preserved when the selected milestone section has none of its own. (#2947)
