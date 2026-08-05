---
type: Changed
pr: 3061
---
**The extracted workflow fragment tree is now inventoried** — the 47 step files and 13 mode files that live under `gsd-core/workflows/<workflow>/` were invisible to `docs/INVENTORY-MANIFEST.json`, so a new one could ship with no row and no gate firing. They now have their own manifest families. (#2996)
