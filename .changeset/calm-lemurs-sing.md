---
type: Changed
pr: 3416
---
**GSD now requires Node 24 or newer** — the `engines.node` floor moves from 22 to 24, and the Node 22 test lane is retired. Node 22 entered Maintenance LTS and this project tracks the Active LTS line; the change is what lets regex escaping delegate to the built-in `RegExp.escape` instead of a hand-rolled implementation. If you are on Node 22, upgrade before updating GSD.
