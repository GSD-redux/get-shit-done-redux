---
type: Changed
pr: 3431
---
<!-- docs-exempt: internal prompt-precision change to the plan-phase workflow's AI-keyword gate; no docs surface documents the keyword list or the gate's trigger keywords (re-verified on next @ 7976b1ca0 — no docs/ file mentions the list's distinctive tokens) -->
**The `plan-phase` AI-integration capability gate no longer lists substring-collidable keywords** — bare `eval` (a substring of ordinary phase-goal words like `evaluation` and `retrieval`) is replaced by `llm eval`, and the under-specified `ai system` is dropped, per maintainer triage on the linked issue. The gate is a capability prompt, not a hard block, so this is a precision improvement: phase goals like "add evaluation metrics" or "build the retrieval layer" no longer invite a spurious AI-SPEC branch, and genuinely AI-flavored goals still match on the precise framework and technique names. (#2115)
