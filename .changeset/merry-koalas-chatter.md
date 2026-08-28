---
type: Fixed
pr: 3903
---
**A phase with an unreadable UAT row no longer reports an affirmative milestone completion percentage.** Previously, one specific unreadable class — UAT rows hidden inside a closed code fence — was exempted from degrading a phase's fold, so a milestone could still publish a completion percentage over work nobody could actually see. Every class of unreadable UAT content now withholds the milestone's percentages the same way. The per-phase signal is unchanged: a phase's own `uat.scope` already reported "truncated" for this case and still does. (#3707)
