---
type: Fixed
pr: 0
---
**Curated STATE.md content survives writes that measured nothing** — `state record-session`, `state add-decision` and the other resyncing verbs no longer drop a curated `progress:` block once a milestone's phases have been archived, `state planned-phase` without `--name` no longer overwrites `current_phase_name` with a placeholder, `state complete-phase` no longer deletes that key while reporting it as updated, and `state json` no longer serves `last_activity_desc` from stale body prose. (#3871)
