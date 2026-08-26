---
type: Changed
pr: 3845
---
**`docs/FEATURES.md` is now generated from per-feature fragments** — a feature no longer hand-allocates a section number or hand-edits the table of contents, the two cells that made almost every concurrent feature PR conflict; contributors add one file under `docs/features/` with any unique `id` and regenerate. (#3840)
