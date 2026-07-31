---
type: Fixed
pr: 2895
---
**Code-review now scopes repository-root and extensionless build files (Dockerfile, Makefile, .gitlab-ci.yml, renovate.json, AGENTS.md)** — the SUMMARY.md file extractor no longer silently drops every root-level path and every extensionless build file, and a partial SUMMARY scope is now cross-checked against `git diff` with a warning naming any changed files it missed. (#2666)
