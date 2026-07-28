---
type: Added
pr: 2730
---
**`npm run regen:derived` regenerates every derived artifact in one command, and a `gsd-regen` merge driver ends hand-resolving the generated parity manifests** — the golden install-parity fixtures and the workflow/agent size baselines are pure functions of the source tree, so neither side of a merge conflict on them is ever correct. Run `npm run setup:merge-driver` once per clone and conflicts on those files resolve to your branch's copy with a one-line notice; `npm run regen:derived` then recomputes them, replacing seven separate invocations with one dependency-ordered command over twelve generators. (#2721)
