---
type: Fixed
pr: 2894
---
**Releases no longer fail their own emitted-parity gate** — cutting any release ran the differential attribution check against a baseline built at a different version, so the install-time hook version stamp made all 364 emitted hook paths look like unexplained drift and every `finalize`/`rc` run hard-failed before tagging or publishing. (#2891)
