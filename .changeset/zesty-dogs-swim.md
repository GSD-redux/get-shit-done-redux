---
type: Fixed
pr: 2934
---
**Non-Latin phase and milestone titles no longer produce empty slugs** — a Cyrillic title used to reduce to an empty slug, creating unnamed phase directories (bare numeric prefix like `01-`) and empty `milestone_slug` fields. Titles are now transliterated to ASCII before the slug filter, so a non-Latin title yields a usable slug. Latin-script output is unchanged. (#2848)
