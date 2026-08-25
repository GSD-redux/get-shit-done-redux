---
id: 35
title: CLI Tools
group: Infrastructure Features
---

**Purpose:** Programmatic utilities for workflows and agents, replacing repetitive inline bash patterns.

**Requirements:**
- REQ-CLI-01: System MUST provide atomic commands for state, config, phase, roadmap operations
- REQ-CLI-02: System MUST provide compound `init` commands that load all context for each workflow
- REQ-CLI-03: System MUST support `--raw` flag for machine-readable output
- REQ-CLI-04: System MUST support `--cwd` flag for sandboxed subagent operation
- REQ-CLI-05: All operations MUST use forward-slash paths on Windows

**Command Categories:** State (11 subcommands), Phase (5), Roadmap (3), Verify (8), Template (2), Frontmatter (4), Scaffold (4), Init (12), Validate (2), Progress, Stats, Todo
