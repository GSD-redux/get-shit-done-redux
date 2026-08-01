---
type: Fixed
pr: 2961
---
**`current_phase` no longer rewinds to an archived phase when STATE.md carries a historical `Phase:` line** — a stale `Phase:` or `**Phase:**` line in an archive section of a long-lived STATE.md silently overwrote `current_phase` on every state write, and because `current_phase` drives `gsd-progress` and `--next` routing the rewind sent work to the wrong phase. Phase extraction is now scoped to the `## Current Position` section (mirroring the existing `## Session` scoping for Stopped At / Paused At). (#2956)
