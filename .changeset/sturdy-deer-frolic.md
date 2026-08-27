---
type: Added
pr: 3920
---
**Exit codes are now allocated from one registry instead of invented per module** — a generated table records every non-standard exit code with its meaning, owning module and authorizing decision, and the build fails if two modules claim the same number or a code lands in a range Node or the shell reserves. Nothing emits a registered code yet; this is the allocator the following phases draw from. (#3905)
