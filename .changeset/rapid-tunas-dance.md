---
type: Added
pr: 3555
---
**`audit-open acknowledge` now suppresses open audit items at future milestone closes** — deferring an item via /gsd-complete-milestone previously only wrote a human-readable note; the item resurfaced at every later close with no way to silence it short of resolving it for real. The new `audit-open acknowledge --category <cat> --milestone <ver> [--at <date>] ...` CLI verb writes a verdict-preserving `audit_acknowledged` marker that suppresses the item starting at the next audit scan, without ever touching the artifact's own `status:` field, and self-invalidates the moment the artifact's observed state changes again. `query audit-open --json` now also reports an `acknowledged` count per category alongside `counts`, so a clean close can be told apart from one that is clean only because prior items are still suppressed. (#3458)
