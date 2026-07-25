---
type: Fixed
pr: 2592
---
**The Gemini and Claude reviewer legs now fail loudly instead of silently dropping out of the cross-AI review** — both blocks capture stderr to a `.err` sidecar instead of discarding it to `/dev/null`, and write a diagnostic stub with the captured error when the lane produces no output. Previously they were the only two of the ten prompt-fed reviewer legs with neither guard, so any failure that wrote no stdout (CLI missing, unauthenticated, rate-limited, crashed) left a zero-byte review file that `write_reviews` rendered as a reviewer that had run cleanly with nothing to report — quietly degrading an N-reviewer consensus to N-1 while `present_results` reported success. The guard matches the shape the Codex and Cursor legs already use. (#2494)
