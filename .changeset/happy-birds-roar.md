---
type: Fixed
pr: 0
---
Reviewer lanes that declare source-grounded evidence are now verified at run time: a review citing zero file:line source evidence is stamped [reviewed-without-source-citations] and down-weighted in the Consensus Summary, instead of silently riding its declared evidence class at full weight (gemini plan-only reviews were measured doing exactly this).
