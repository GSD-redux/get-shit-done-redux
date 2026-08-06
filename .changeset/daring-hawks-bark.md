---
type: Fixed
pr: 3111
---
**Pi no longer emits a `typebox unavailable` warning at every startup** — the warning fired because the Pi adapter attempts to `require('typebox')` (not a gsd-core dependency) and falls back to a plain JSON-Schema object on every startup. The fallback is the normal path; the warning is now suppressed. (#3022)
