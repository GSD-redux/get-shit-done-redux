---
type: Added
pr: 1689
---
**Plans can now opt into a specialist executor via a per-plan `agent_hint:` frontmatter field** — `execute-phase` dispatches the named subagent instead of `gsd-executor` when it resolves on the active runtime, and falls back to `gsd-executor` when the field is absent, blank, or the named agent does not resolve (byte-identical to today). Resolution consults the active runtime's agent directory (project-local and user-global, across filename variants) via a new `gsd-tools resolve-agent` query, and the hint flows through `phase-plan-index` as `plan_json.agent_hint`. Default-on via `workflow.agent_hint_routing` (set `false` to disable); covers the `Agent()`-based dispatch (harness-worktree and sequential). (#1689)
