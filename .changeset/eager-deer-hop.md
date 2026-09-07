---
type: Added
pr: 4502
---
**A new offline benchmark reports the token savings from compact-content splits** — `npm run benchmark:compact-content` measures, per registered `workflow.compact_content` spine/detail split, the token count with and without the split active using a pinned tokenizer, and prints the reduction against a committed baseline without ever failing CI. (#4404)
