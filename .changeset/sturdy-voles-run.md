---
type: Added
pr: 0
---
**Windows binary resolution now has one owner** — GSD resolves a command name to the file Windows can actually start, in the single platform seam, instead of four divergent copies. Reviewer lanes, `execTool`, and the capability spawn path all share it, so a `.cmd`/`.bat` shim resolves and runs where it previously failed with `spawn ENOENT`. macOS and Linux behavior is unchanged. (#3411)
