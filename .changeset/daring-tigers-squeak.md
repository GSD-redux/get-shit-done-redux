---
type: Fixed
pr: 3935
---
**No more console-window flash on Windows in non-GSD repositories** — the graphify auto-update hook ran a hidden `node` process to parse its payload before checking whether the project uses GSD at all; the cheap `.planning/config.json` and `CI` checks now run first, so non-GSD projects and CI pay for zero child processes per Bash tool call. (#3729)
