---
type: Changed
pr: 2622
---
**STATE.md now records the commit it was written against** — a new `state_head` frontmatter stamp lets `/gsd-health` and smart-entry report how far the codebase has moved since STATE.md was last written, so a long-stale STATE.md can be discounted rather than read at face value. Health adds advisory `W024` once the gap reaches 20 commits. This is a freshness proxy, not a drift measurement: the count includes commits that never touched anything STATE.md describes, and the stamp refreshes on any state write — so it is always worded as approximate and never gates anything. The stamp is omitted entirely when the commit cannot be resolved to the project's *own* repository — a project nested inside an unrelated checkout reports unknown rather than borrowing that repo's freshness. (#2573)
