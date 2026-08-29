---
type: Fixed
pr: 0
---
the phase-taking init.* queries (execute-phase, plan-phase, verify-work, code-review, phase-op, review, discuss-phase-assumptions, todos) accept --phase <N> as an alias for the positional form, matching phase list-plans; a valueless --phase is now a usage error instead of silently answering phase_found:false for a phase that has plans (#3865)
