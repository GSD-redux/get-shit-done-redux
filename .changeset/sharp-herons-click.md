---
type: Fixed
pr: 2689
---
**A failed LM Studio or llama.cpp reviewer leg is now visible instead of silently dropped** — when a local OpenAI-compatible endpoint was unreachable or returned empty content, `/gsd-review` wrote no review file at all, so the reviewer's section was omitted from the final review and the result was indistinguishable from that reviewer never having been selected. Both legs now emit a diagnosable stub carrying curl's stderr and the raw response body, matching the guard the claude/gemini/codex legs already had. (#2605)
