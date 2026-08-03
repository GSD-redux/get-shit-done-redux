---
type: Fixed
pr: 3014
---
**`/gsd-spike` no longer blends unrelated ideas' requirements together** — `.planning/spikes/MANIFEST.md` now scopes each idea's paragraph and Requirements under its own idea key, and `/gsd-spike --wrap-up` only emits a feature area's owning idea's requirements instead of the whole file. (#1700)
