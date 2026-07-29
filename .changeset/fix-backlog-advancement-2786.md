---
"@opengsd/gsd-core": patch
---

Fixed an issue where \`phase.complete\` and \`state.update\` would incorrectly scan into deferred or backlog headings (e.g. \`## Future Backlog\`) in \`ROADMAP.md\` to find the next active phase or compute progress, causing the milestone to improperly advance into deferred phases.
