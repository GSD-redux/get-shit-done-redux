---
type: Added
pr: 2661
---
**Phase effort estimation against a calibrated smart-zone budget** — plans can now be sized against a configurable token budget (`workflow.smart_zone_tokens`, default 100000) instead of a static heuristic, and the estimate self-corrects against measured reality. Adds the `estimate-check` and `estimate-calibration` query verbs. (#2630)
