---
type: Fixed
pr: 0
---
**Local test runs no longer fail on machines with a global core.hooksPath** — the commit-docs-guard suites refused to install their pre-commit hook in every fresh fixture repo (18 tests read as a guard regression); the suites now pin GIT_CONFIG_GLOBAL to an empty file so children never inherit the host git config (#3901)
