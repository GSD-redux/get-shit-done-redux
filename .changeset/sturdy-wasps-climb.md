---
type: Fixed
pr: 2908
---
**Non-Latin titles no longer produce an empty slug.** `gsd generate-slug` transliterates Cyrillic to ASCII instead of returning an empty string, and refuses input that has no ASCII spelling with a non-zero exit rather than printing an empty slug. Slug generation is consolidated into a single implementation, truncation happens once against a caller-supplied limit, and a slug cut on a word boundary no longer keeps a trailing hyphen.
