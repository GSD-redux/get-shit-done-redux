---
type: Fixed
pr: 3994
---
**Two QA oracles no longer report findings against the wrong field.** `routing-validity` demanded a live-command token from `recommended`, which is an action id by design, and also validated `recommended_command`, a field nothing in the repo produces; it now checks the fields that actually carry tokens. `value-hygiene` reported command tokens such as `/gsd:progress` as leaked absolute paths, and now exempts them by value shape rather than by key name, so a `command` field holding a genuine absolute path is still reported. (#3913)
