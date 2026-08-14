---
type: Fixed
pr: 0
---
gap-analysis check gap-analysis.plan-post no longer reports prose trailing the requirement ID list as missing requirements. ROADMAP Requirements lines routinely carry locked-decision annotations, ambiguity scores, and prohibition notes after the ID list; passing that value verbatim into --phase-req-ids previously caused every prose word to be reported as an individually-missing requirement, drowning the real coverage signal. Tokens that cannot be requirement IDs (prose, punctuation, dates) are now dropped after range expansion.
