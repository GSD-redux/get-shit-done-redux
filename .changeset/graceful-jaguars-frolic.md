---
type: Fixed
pr: 2559
---
Phases whose names begin with a 2-digit number ("24/7 Autonomy", "80/20 Cleanup", "12-Factor Refactor") are now resolvable by their bare phase number across every phase verb (plan-index, find, execute-phase, plan-phase, complete, remove, list). The phase-token extractor no longer absorbs 2-digit slug words followed by a 1-digit word, directory-match selection is single-sourced across the three resolution paths with a bare-integer leading-digit-run fallback, and phase-plan-index now fails loud on ambiguous matches instead of silently indexing the first one.
