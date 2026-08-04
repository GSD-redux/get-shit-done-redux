---
type: Fixed
pr: 3049
---
**A Codex surface re-stage no longer creates a duplicate skill tree** — re-staging skills on a global Codex install wrote them to `$CODEX_HOME/skills` while the installer had correctly placed them in `$HOME/.agents/skills`, leaving two active GSD skill trees and no signal which one was live. The re-stage and the legacy dev-preferences migration now resolve the same destination the installer uses. (#2911)
