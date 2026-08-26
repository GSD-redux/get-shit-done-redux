---
type: Fixed
pr: 3876
---
**Global Antigravity installs target ~/.gemini/config** — default global Antigravity installs now resolve to `~/.gemini/config` instead of the deprecated `~/.gemini/antigravity` to match current Antigravity CLI scan discovery, while existing legacy installs keep resolving to their own directory via marker-priority detection (#3738).
