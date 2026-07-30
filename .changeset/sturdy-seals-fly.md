---
type: Removed
pr: 2767
---
**`npm run gen:golden`, `UPDATE_GOLDEN`, `npm run size:baseline`, and `npm run setup:merge-driver` are removed** — the committed golden-install-parity fixtures and the two per-file size baselines they regenerated are deleted. The differential attribution check (`tests/emitted-attribution.test.cjs`) is now the sole gate for both emitted-content propagation and workflow/agent size growth; editing shipped content requires zero manual fixture regeneration. `npm run regen:derived` and `npm run gen:install-tree` are unaffected. (#2724)
