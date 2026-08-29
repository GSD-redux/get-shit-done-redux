---
type: Fixed
pr: 0
---
workflow.research_before_questions now works on /gsd:quick (research runs before discussion questions when enabled — a gray-area answer without research becomes a locked decision in the quick task context) and resolves from ~/.gsd/defaults.json like its sibling workflow.post_planning_gaps, which the global-defaults merge previously forwarded while silently dropping this key (#3894)
