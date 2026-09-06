---
type: Changed
pr: 4397
---
<!-- docs-exempt: internal tool-grant correction to skill frontmatter; no file under docs/ enumerates per-skill allowed-tools (verified against docs/ARCHITECTURE.md, docs/AGENTS.md, and docs/adr/) so there is nothing to update -->
**21 GSD skills now declare `Grep` in `allowed-tools`** — cleanup, complete-milestone, config, debug, graphify, health, mempalace-capture, mempalace-recall, new-milestone, new-project, next, pause-work, phase, pr-branch, resume-work, review-backlog, settings, stats, thread, workspace, and workstreams can now use the dedicated structured-search tool instead of shelling out through Bash grep.
