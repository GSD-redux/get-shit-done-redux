---
type: Added
pr: 0
---
**`/gsd-ui-review` can capture post-interaction UI states** — a new default-off `workflow.ui_interaction_capture` key on the `ui` capability lets `gsd-ui-auditor` add hover, focus-ring, open-menu and filled-form captures through the `chrome-devtools` CLI, driven from Bash with no MCP server and no tool-surface change. Requires an installed Chrome; when off, or when none resolves, the Playwright-only static capture runs exactly as before. (#4223)
