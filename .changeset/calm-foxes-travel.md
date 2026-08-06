---
type: Fixed
pr: 3127
---
**`detectApiIntegration` no longer triggers on negated prose** — a clause pairing an integration verb with an API noun but also containing a negation qualifier (`no`, `not`, `without`, `neither`, `nor`, etc.) is now suppressed. "This phase integrates no external API" no longer fires a false positive that halts verification. (#2784)
