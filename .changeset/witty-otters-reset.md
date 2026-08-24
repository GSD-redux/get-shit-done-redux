---
type: Fixed
pr: 3808
---
**A context compaction no longer permanently disables context-warning escalation** — the monitor's per-session warn sentinel survived `PreCompact`, so once the first CRITICAL of a session had fired, `lastLevel` stayed pinned at `critical` for the rest of the run, and two documented behaviours died with it: the first warning of the post-compaction cycle was debounced instead of firing immediately, and the WARNING → CRITICAL escalation bypass could never be true again. The sticky `criticalRecorded` flag had the same shape, so a session that compacted and later genuinely ran out kept a resume breadcrumb (#1974) describing the earlier near-miss rather than the exhaustion that ended the run. A compaction now clears both that state and the statusline reading that produced it, so the cycle after a compact behaves like a fresh session. (#3709)
