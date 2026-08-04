---
type: Fixed
pr: 3062
---
**Installed third-party reviewer lanes can now be selected, planned, and invoked** — an installed `role:"reviewer"` capability was roster-visible and disclosed at install but `/gsd-review` (`gsd-tools review-lane sections|flags|plan|invoke`) built its lane map from the static first-party set only, so every third-party lane failed with "no such declared lane". The invocation surface now merges installed overlay reviewer lanes (first-party wins on collision, ADR-2782 D8). (#2927)
