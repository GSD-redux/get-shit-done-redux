---
type: Added
pr: 2823
---
**Reviewer lanes can be declared as capability manifest data** — a capability may now carry a `reviewer` body describing a cross-AI review lane (slug, flags, transport, probe, invocation shape, timeout floor, output policy), and a new `role: "reviewer"` declares a lane that is not an install target. The registry validates the body against closed vocabularies and enforces slug, flag, and section uniqueness across first-party and installed capabilities, so two lanes can no longer silently share a REVIEWS.md heading. A capability with no reviewer body is unaffected. (#2795)
