---
type: Added
pr: 4083
---
**Reviewer lane timeouts can now be configured per-lane** — declare `timeoutConfigKey` on a reviewer lane manifest (nine of the twelve shipped lanes now do, via `review.timeouts.<slug>`) to override its frozen wall-clock timeout floor from `.planning/config.json`, instead of being stuck with a value that was right for one repository and wrong for another. For the antigravity lane, its native `agy --print-timeout` flag now derives from the same configured value instead of a second hardcoded literal. (#3274)
