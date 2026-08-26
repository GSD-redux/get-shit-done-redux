---
type: Fixed
pr: 3876
---
Global antigravity installs now target ~/.gemini/config instead of the deprecated ~/.gemini/antigravity, matching current antigravity-cli's scan directory; existing legacy installs keep resolving to their own dir via marker-priority detection (gsd-core#3738)
