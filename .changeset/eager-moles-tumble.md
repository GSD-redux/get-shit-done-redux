---
type: Fixed
pr: 2824
---
**OpenCode/Kilo no longer spawn the context-monitor subprocess on every tool call when context warnings are disabled** — the adapter now reads the existing `hooks.context_warnings` toggle in-process and skips the child-process spawn entirely when it is set to `false`, instead of paying a Node boot per tool call only to read the flag and exit inside the child. Behavior is unchanged when the toggle is absent or enabled (the default).
