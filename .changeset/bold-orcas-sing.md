---
type: Added
pr: 3323
---
**The install manifest now records which runtime and scope wrote it** — a global and a project-local install used to write two `gsd-file-manifest.json` files that neither named their own runtime nor their own scope, so nothing could answer "which GSD surfaces are installed, where". The manifest gains `manifestVersion`, `runtime` and `scope`, and a new read-only Installed Surface Resolver reads both scopes at once. Manifests written by earlier versions are read without error and need no reinstall. (#2872)
