---
type: Fixed
pr: 4372
---
**The shell launcher no longer resolves through `GEMINI_CONFIG_DIR`** — the arm for the runtime removed in #1928 is gone from `_runtime-launcher.snippet.sh` and every propagated copy, so the shell and JS runtime-home resolvers can no longer pick different installs from the same environment. A parity test now pins the two lists together. (#4347)
