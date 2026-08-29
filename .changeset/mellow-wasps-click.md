---
type: Fixed
pr: 0
---
**Acknowledged moot items stay closed in `audit-uat`** — the `audit_acknowledged` frontmatter marker (the documented, self-invalidating "this item is moot" seam) now suppresses items in `query audit-uat` exactly as it already does in `audit-open`, with the same snapshot keys and a visible `acknowledged_files` count — no more choosing between lying (`status: passed`), inventing tokens, or deleting the planning record. (#3805)
