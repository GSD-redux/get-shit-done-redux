---
type: Changed
pr: 0
---
**Agent required-reading enforcement now actually fires** — spawner workflows and commands emitted `<files_to_read>` while agents gate on `<required_reading>`, so the "you MUST Read every listed file" clause never triggered; the canonical tag is now `<required_reading>` everywhere (46 spawn blocks across 24 workflows), with a repo guard banning the legacy tag so the two vocabularies can never drift apart again. (#3423)
