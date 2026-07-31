---
type: Fixed
pr: 2916
---
**roadmap.update-plan-progress no longer deletes hand-written annotations** — bumping the plan count used to swallow the rest of the Plans line, silently deleting any prose a human wrote after the count. The verb now replaces only the count token and leaves trailing text intact. (#2853)
