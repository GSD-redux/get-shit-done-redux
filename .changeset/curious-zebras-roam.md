---
type: Fixed
pr: 0
---
**`phase complete` no longer advances to an inserted phase that merely has a directory** — the next-phase resolution scanned phase directories first and only consulted ROADMAP.md when the disk turned up nothing, so an inserted decimal phase (whose directory `phase insert` scaffolds immediately) outranked the phases preceding it in roadmap order. The wrong successor was reported and written to STATE.md as the resume pointer. Roadmap order now decides which phase is next; the disk still supplies the on-disk spelling when both agree, and remains the fallback when no roadmap is readable. (#3701)
