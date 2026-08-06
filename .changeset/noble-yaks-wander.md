---
type: Fixed
pr: 3104
---
**Codex skill adapter collaboration-tool vocabulary corrected** — the generated adapter documented an obsolete `wait(ids)` call (the real tool is `collaboration.wait_agent`), unconditionally instructed `close_agent` without a tool-visibility gate, and omitted the required `task_name` field and the `fork_turns` parameter. The adapter now names the real wait tool, disambiguates it from the unrelated exec-cell `functions.wait`, gates `close_agent` on schema visibility, and covers `task_name` + `fork_turns`. (#3004)
