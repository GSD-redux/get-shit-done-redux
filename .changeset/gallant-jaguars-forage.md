---
type: Fixed
pr: 0
---
**`gsd-tools stats` no longer counts phantom phases from inline code** — prose mentioning `### Phase N:` inside an inline code span (e.g. a roadmap explaining its own numbering) inflated phases_total with a never-completing Not-Started row and deflated completion percent; stats now requires the same digit-bearing phase id shape roadmap analyze uses, so the two agree. (#3569)
