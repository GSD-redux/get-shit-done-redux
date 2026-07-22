---
type: Changed
pr: 2543
---
**`/gsd-explore` research passes now disposition each surfaced claim three ways** — **admit** (survives a prompted-to-refute pass and is grounded in a source, shown with the source), **refute** (a source contradicts it, dropped or corrected), or **abstain** (unverifiable, or a source-vs-prior conflict). Abstained claims go to a separate **Unresolved** ledger instead of being smoothed into confident prose, so you can see what the research could not stand behind. Two guards ship with it: conflict-abstention (a source-vs-prior conflict routes to the ledger, not a silent pick-a-side) and a tier floor (the grounded pass does not run on the lowest model tier). Claims-side analogue of the honest verifier. (#2229)
