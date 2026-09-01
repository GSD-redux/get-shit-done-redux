---
type: Added
pr: 0
---
**Hook advisory output now carries typed reason-code fields** — `gsd-read-guard.js`'s Write/Edit advisory now includes `code: 'READ_BEFORE_EDIT'` and `fileName` alongside its existing `additionalContext` prose, so callers reading the hook's JSON no longer need to substring-match the advisory text to detect why it fired or which file it named. (#3546)
