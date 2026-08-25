---
id: 51
title: Workstream Namespacing
group: v1.28 Features
---

**Command:** `/gsd-workstreams`

**Purpose:** Parallel workstreams for concurrent work on different milestone areas.

**Requirements:**
- REQ-WS-01: System MUST isolate workstream state in separate `.planning/workstreams/{name}/` directories
- REQ-WS-02: System MUST validate workstream names (alphanumeric + hyphens only, no path traversal)
- REQ-WS-03: System MUST support list, create, switch, status, progress, complete, resume subcommands

**Produces:**
| Artifact | Description |
|----------|-------------|
| `.planning/workstreams/{name}/` | Isolated workstream directory structure |

**Process:**
1. **Create** — Initialize a named workstream with isolated `.planning/workstreams/{name}/` directory
2. **Switch** — Change active workstream context for subsequent GSD commands
3. **Manage** — List, check status, track progress, complete, or resume workstreams
