---
type: Fixed
pr: 4251
---
**The npm-audit CI gate now retries a slow registry instead of failing on one bad moment, and reports a clear timeout error instead of a misleading JSON parse error when it does fail.** A timed-out audit call previously surfaced as `Unexpected end of JSON input` and made exactly one attempt with no retry, so any single transport hiccup against npm's registry failed a required gate. It now retries up to 3 times with backoff before failing, and any failure names the real cause. (#4250, #4260)
