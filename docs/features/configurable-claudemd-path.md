---
id: 115
title: Configurable CLAUDE.md Path
group: v1.36.0 Features
---

**Purpose:** Allow projects to store their CLAUDE.md in a non-root location. The `claude_md_path` config key controls where `/gsd-profile-user` and related commands write the generated CLAUDE.md file.

**Requirements:**
- REQ-CMDPATH-01: `claude_md_path` defaults to `./.claude/CLAUDE.md` (a valid project-scoped memory location; changed from `./CLAUDE.md` in v1.5 per [#1098](https://github.com/open-gsd/gsd-core/issues/1098) so generated content does not pollute a hand-crafted repo-root `CLAUDE.md`)
- REQ-CMDPATH-02: Profile generation commands read the path from config and write to the specified location
- REQ-CMDPATH-03: Relative paths are resolved from the project root
- REQ-CMDPATH-04: `generate-claude-md` never overwrites an existing instruction file that lacks GSD section markers (a hand-crafted file) unless `--force` is passed

**Configuration:** `claude_md_path`
