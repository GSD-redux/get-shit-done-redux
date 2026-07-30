---
type: Added
pr: 2861
---
**`/gsd:review --kimi-code` reviews your plans with Kimi Code CLI** — the new lane joins the cross-AI reviewer roster and is included by `--all` when detected. Detection distinguishes Kimi Code from the legacy Python kimi-cli, which ships a binary of the same name, so a host with only the legacy tool reports the lane unavailable instead of registering a reviewer that cannot serve it. (#2718)
