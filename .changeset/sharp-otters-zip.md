---
type: Fixed
pr: 2597
---
**`/gsd-execute-phase` now auto-closes pending todos for single-digit phases** — the close_phase_todos step normalizes both the phase number and each todo's `resolves_phase` value before comparing, so a todo tagged `resolves_phase: 5` is recognized when phase `05` completes. Previously the step compared the zero-padded `PHASE_NUMBER` (e.g. "05") against the unpadded value new-milestone wrote (e.g. "5") as literal strings, so every single-digit phase (1-9) silently failed to auto-close its todos — they stayed stuck in `pending/` forever despite their resolving phase completing. Decimal sub-phases (4.1 vs 04.1), letter suffixes, and quoted YAML values are now handled too. (#2576)
