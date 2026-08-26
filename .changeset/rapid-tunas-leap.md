---
type: Fixed
pr: 0
---
**audit-uat no longer reports zero outstanding items on UAT files it silently failed to parse.** Result lines with trailing text (e.g. `result: pending (blocked on staging)`) are matched again instead of dropped, an interleaved or trailing `## Gaps` section no longer bleeds its reason onto the prior test row, uppercase result tokens (`PENDING`, `Blocked`) categorize correctly, and a new parse_gap_files counter keeps audit-uat/progress from declaring all-clear when a file's test blocks genuinely failed to parse. (#3707)
