---
type: Fixed
pr: 2803
---
**Merging an emitted-drift acknowledgment no longer turns the mainline red.** An acknowledgment is now scoped to the diff that introduced it, so once its ripple is absorbed into the base it goes inert instead of reporting as stale — which had reddened `next` for five consecutive commits and every pull request branching off it. (#2789)
