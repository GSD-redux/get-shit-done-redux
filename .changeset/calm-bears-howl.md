---
type: Changed
pr: 3283
---
state validate now runs its drift scan for STATE.md files whose phase lives only in frontmatter, instead of silently skipping the scan and reporting a false-clean result (#3162); it also no longer lets a frontmatter status: key shadow the body Status field. Its output gains a scope field (complete/truncated/unscoped/unreadable) reporting whether the check could actually run — valid still means no drift was found, and is not derived from scope. (#3187)

state complete-phase's idempotency guard now consults frontmatter current_phase (via the same fallback chain as state validate), so a STATE.md whose phase lives only in frontmatter is no longer silently rolled back on a re-run of `state complete-phase --phase N`. It also gains a new refusal path: when the frontmatter cannot be parsed, the command now errors out ("Unable to read STATE.md frontmatter; refusing to run complete-phase to avoid a destructive rollback") instead of guessing. (#3187)

workstream list/status/progress's per-workstream state projection (status, current_phase, last_activity) now resolves those fields from frontmatter when the body has no corresponding field, instead of reporting them absent — a frontmatter-only STATE.md's workstream inventory output changes accordingly. (#3187)
