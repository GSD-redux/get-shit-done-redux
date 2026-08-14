---
type: Fixed
pr: 3483
---
ZCode installs now strip mcp__* tool grants from installed GSD subagents at install time. ZCode's dispatcher treats every mcp__<server>__* entry in an agent's tools: frontmatter as a required MCP server and hard-fails the subagent spawn (CONFIGURATION_ERROR) when it is not connected, so /gsd-quick --full and plan/execute-phase flows failed out of the box with zero MCP servers configured. Installed ZCode agents now declare only core tools; MCP tools remain available when servers are connected. Claude Code installs are unchanged.
