---
type: Fixed
pr: 0
---
**A phase with more than one `*-VERIFICATION.md` no longer reports the wrong one** — verification-report discovery took the alphabetically-first match, so an ad-hoc worksheet such as `03-CORRECTION-VERIFICATION.md` beat the real `03-VERIFICATION.md` sitting beside it and the phase could report `missing` while a passing report existed. Three further copies of the same lookup picked whichever file the filesystem happened to list first, making phase status and the reported `verification_path` vary between machines. All five now share one resolver that prefers the canonically-named report and is deterministic when it has to fall back. (#3357)
