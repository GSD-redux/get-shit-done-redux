---
type: Added
pr: 4000
---
**Capabilities can now source a task's content from an external issue tracker.** A capability that declares a `taskContentResolver` for a tracker prefix lets a plan's `tracker-id` attribute resolve the task's action, verify, acceptance criteria, and done text from that external tracker at execution time instead of PLAN.md, and any resolution failure — ambiguous match, non-zero exit, timeout, or malformed output — hard-halts rather than silently falling back. (#3970)
