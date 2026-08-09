---
type: Removed
pr: 3272
---
**The undocumented `runtime.hostBehaviors.reviewerCli` capability field has been removed** — it was superseded by the declared `reviewer` body in 1.9.0 and kept working for one release as a derived alias. A manifest that still sets it contributes no reviewer lane and now reports a non-fatal warning naming the capability, at build time on stderr and at install time through the overlay loader; nothing crashes and no other behavior changes. Every shipped reviewer lane already declares a `reviewer` body, so the roster is unchanged — if you maintain an out-of-tree runtime descriptor that relied on the flag, declare a `reviewer` body to restore the lane. (#2801)
