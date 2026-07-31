---
type: Changed
pr: 2559
---
**Digit-leading phase names now resolve consistently by bare number** — phases such as "24/7 Autonomy", "80/20 Cleanup", and "12-Factor Refactor" now resolve across every phase verb instead of appearing missing; ambiguous directory collisions now fail loudly with their candidate paths instead of silently selecting the first match. `/gsd` and `/gsd:progress` also stop under-reporting: their verify-failed check shares the same directory selection, so a failed verification in one of these phases is surfaced rather than read as a healthy phase, and phase directories carrying a project-code prefix (`MEM-05-…`) are no longer skipped by that check entirely (#2528).
