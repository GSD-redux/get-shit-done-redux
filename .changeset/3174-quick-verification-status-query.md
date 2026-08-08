---
type: Fixed
pr: 3205
---
**`/gsd-quick --validate` no longer trusts a verification result it cannot actually read** — quick parsed the verifier's status by grepping the whole report rather than its frontmatter, so a `status:` line in the report's prose could be picked up alongside or instead of the real one, staleness was never detected at all, and a range of valid and malformed reports alike resolved to a value no routing arm matched — leaving the orchestrator to improvise at the moment the pipeline had failed. Quick now reads the same frontmatter-anchored, staleness-aware `verification.status` query that `execute-phase`, `verify-work` and `progress` already use, and routes `missing` / `unknown` / `stale` through an explicit arm instead of falling through. (#3174)
