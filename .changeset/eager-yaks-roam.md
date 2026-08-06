---
type: Fixed
pr: 3112
---
**Installer `--help` now documents every supported runtime** — `--pi` and `--gemini` were accepted but omitted from the help output, making them invisible to users discovering runtime support via `--help`. A parity test now guards against future drift. (#3026)
