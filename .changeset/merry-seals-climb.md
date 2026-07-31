---
type: Added
pr: 2912
---
**Third-party reviewer lanes can now be listed in a discoverability catalog.** ADR-2782 made a reviewer lane installable by a third party, but the two existing registries could not hold one — the Community Capability Registry requires a non-empty `loopExtensionPoints`, which a lane registers on none of, and the EoS Registry is for host integrations. A new Reviewer Lane Registry (`docs/registries/reviewers.json` → `docs/registries/reviewer-registry.md`) gives lanes a home, with an entry schema describing the lane itself: slug, flags, transport, evidence class, and REVIEWS.md section. (#2904)
