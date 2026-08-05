---
type: Fixed
pr: 3091
---
**`progress.completed_plans` no longer stays pinned after a gap-closure cycle** — when plan-phase re-planned a phase and added gap-closure plans, `total_plans` corrected upward but `completed_plans` was restored to its pre-growth value, so STATE.md showed `completed_plans < total_plans` permanently even after every plan (including the gap-closure ones) was summarized. `completed_plans` and `completed_phases` now ratchet up to the disk-derived count under the plan-phase progress opt-in (never deriving downward, preserving the curated-progress ratchet for unrelated edits). (#2969)
