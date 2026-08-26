---
type: Fixed
pr: 3808
---
**A context compaction no longer permanently disables context-warning escalation** — the monitor's per-session warn state survived `PreCompact`, so after a session's first CRITICAL the immediate-first-warning and WARNING→CRITICAL escalation rules were dead for the rest of the run, and the #1974 resume breadcrumb kept describing the wrong near-miss. A compaction now clears that state, deletes the statusline reading that produced it, and writes a compaction watermark so a reading the statusline re-creates mid-compaction — the old value under a fresh timestamp — is dropped instead of trusted. The cycle after a compact behaves like a fresh session. (#3709)
