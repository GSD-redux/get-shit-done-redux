---
type: Fixed
pr: 2908
---
**Non-Latin titles no longer produce an empty slug.** `gsd generate-slug` transliterates Cyrillic to ASCII instead of returning an empty string, and refuses input that has no ASCII spelling with a non-zero exit rather than printing an empty slug. Slug generation is consolidated into a single implementation, truncation happens once against a caller-supplied limit, and a slug cut on a word boundary no longer keeps a trailing hyphen. `gsd scaffold phase-dir` now exits non-zero on a name with no slug-safe characters instead of creating a phase directory whose name ends in a bare hyphen, and the phase-id directory renderer delegates to the same generator, so a Latin diacritic is folded to its ASCII base (`café` renders as `cafe`, previously `caf`) and a Cyrillic phase name renders instead of throwing.
