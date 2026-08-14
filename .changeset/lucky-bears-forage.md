---
type: Fixed
pr: 3459
---
A plan SUMMARY whose frontmatter declares status: blocked is no longer counted as a completed plan. Previously both the progress counters written to STATE.md (state planned-phase / begin-phase / record-session) and the phase-plan-index read path paired PLAN and SUMMARY files by filename existence alone, so a blocked plan counted as done and was omitted from the incomplete list. Filename existence remains the fallback when a SUMMARY carries no status field, and status: halted summaries still count as completion records (a designed stop), so untouched projects are unaffected.
