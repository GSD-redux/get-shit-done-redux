---
type: Removed
pr: 3932
---
Removed the hand-written root bin/lib/ui-safety-gate.cjs — the GSD installer and every shipped workflow only ever resolved gsd-core/bin/lib/ui-safety-gate.cjs, so the root copy was unused dead code.
