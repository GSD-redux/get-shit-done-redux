---
type: Fixed
pr: 3101
---
**Multi-paragraph changeset bodies no longer truncate and lose their PR trailer** — `serializeChangelog` wrote bullet bodies verbatim, so an embedded newline became a column-0 line that `parseChangelog` treated as the end of the bullet, silently dropping the continuation and the `(#NNNN)` trailer. Continuation lines are now indented so the round-trip preserves content and attribution. (#3001)
