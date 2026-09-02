---
type: Added
pr: 4156
---
**Edge-completeness probe requirements accept an optional `text_en` field** — spec-phase Step 5.5 can now populate an explicit English translation for non-English SPEC requirements, which the shape classifier reads in preference to `text` (`text_en ?? text`). This replaces the #2773 doc-only convention where `text` silently carried the translation; `text` now always keeps the requirement's own wording. (#3717)
