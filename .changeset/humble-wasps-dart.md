---
type: Fixed
pr: 4233
---
**`worktree base-check` no longer misreports a user/global `worktree.baseRef:"head"` as ignored by the harness** — the settings resolver now carries which cascade layer supplied the value, and in harness-worktree mode only a *project*-settings `"head"` (the case #48 verified) falls through to the fork-base comparison; a `"head"` set in the user/global layer (`/config`) keeps the `baseref-head` suppress, restoring the #1038 fix for #1013 that #3659 had made inert. Operator messages and workflow docs are re-scoped to say the harness does not read the setting from *project* settings (#4090).
