---
type: Fixed
pr: 0
---
**`audit-open acknowledge` no longer silently strands or clobbers Title-case status lines** — a bare `Status:`/`STATUS:` marker is now acknowledged through a line the reader actually parses instead of being rewritten in place invisibly, and a human-written `Status: resolved` is left untouched rather than downgraded to `acknowledged`. (#3775)
