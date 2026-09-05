---
type: Added
pr: 4246
---
**Two new ESLint rules catch the #4220 Windows CI hang bug class at author time.** `local/require-full-tmpdir-triad` flags a `TMPDIR` environment override (direct or in a child-process `env:` literal) missing `TEMP`/`TMP` — Node never reads `TMPDIR` on Windows. `local/no-unbounded-dirname-walk` flags a `dirname()` ancestor-walk loop with no fixed-point termination guard, which spins forever at a Windows drive root. (#4244)
