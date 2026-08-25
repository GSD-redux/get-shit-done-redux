---
id: 151
title: Companion MCP Server
group: v1.7.0 Features
---

**Command:** `gsd-mcp-server`

**Purpose:** A companion MCP server exposing GSD over stdio JSON-RPC 2.0, covering interface points 1 and 5 (#1681).

**Behavior:** OpenCode installs auto-register it as `mcp.gsd` (#1682). OpenCode also gained the `opencode-subset` hook dialect plus `session.idle` handling (#1682) and now runs GSD's lifecycle safety hooks — prompt-injection guard, read-before-edit guard, and injection scanner (#1923).
