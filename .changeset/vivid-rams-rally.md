---
type: Fixed
pr: 4188
---
**ZCode installs: command `<execution_context>` @-refs now resolve to `~/.zcode/gsd-core/` instead of the Claude copy** — the installer's runtime rewrite pass had no ZCode case, so every generated command loaded the Claude runtime's workflow copy and the ZCode-adapted core was never read. Re-running the installer repairs existing installs. (#4002)
