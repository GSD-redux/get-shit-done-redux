---
type: Added
pr: 2718
---
**`/gsd:review` gains a Kimi Code CLI reviewer lane (`--kimi-code`)** — Kimi Code CLI (Moonshot AI, Node) is now a first-class cross-AI reviewer alongside Cursor. The lane is invoked headless via `kimi -p` with a file-reference prompt (the prompt lives in the run dir, not inlined into the argument list), captures thinking/tool progress on stderr to a `.err` sidecar, and stubs an empty result with that stderr so a failed lane is diagnosable. Model override via `review.models.kimi-code` (passed as `kimi -m`); the lane needs no `jq`. The reviewer slug is registry-derived from the `kimi-code` capability's new `reviewerCli: true` host behavior — no hand-maintained slug list. (#2718)
