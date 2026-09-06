---
type: Fixed
pr: 4388
---
**`query verification.status` now resolves a bare `VERIFICATION.md` like `verification.resolve-file` does** — a phase whose only verification report was a bare `VERIFICATION.md` was reported as `missing` and told to re-run `/gsd-execute-phase` even though the report said `status: passed` and `verification.resolve-file` resolved it in the same directory. (#4187)
