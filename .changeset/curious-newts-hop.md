---
type: Added
pr: 0
---
**Read-injection scanner advisory output now carries typed `severity` and `source` fields** — `gsd-read-injection-scanner.js`'s Read/WebFetch/WebSearch advisory (already emitting a typed `findings` array since #3523) now also includes `severity: 'LOW'|'HIGH'` and `source` (the scanned file path, URL, or query) alongside its existing `additionalContext` prose. (#3546)
