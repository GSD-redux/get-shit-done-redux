---
type: Fixed
pr: 3658
---
**Documentation no longer points at files that were renamed or deleted** — `docs/INVENTORY.md` claimed its roster was anchored by six drift-control tests when five had been deleted, and the four translations named a seventh that the English file had already dropped. `CONTEXT.md`, `VERSIONING.md`, `docs/CONFIGURATION.md` and `docs/skills/discovery-contract.md` pointed at `issue-NNN-` test filenames and `sdk/` paths that no longer exist, and `VERSIONING.md` described an SDK bundling step the release workflow does not perform. Most consequentially, `docs/TESTING-SUITES.md` instructed contributors to add drift acknowledgments to a file `CONTRIBUTING.md` says to never use — following it put the entry where the contributing guide forbids. (#3620)
