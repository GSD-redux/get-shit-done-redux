---
type: Changed
pr: 0
---
<!-- docs-exempt: internal prompt-precision change to the plan-phase workflow's AI-keyword gate; no docs surface documents the keyword list or the gate's trigger condition (verified: FEATURES.md §106, COMMANDS.md, USER-GUIDE.md, CONFIGURATION.md) -->
**The `plan-phase` AI-integration capability gate no longer invites false fires on ordinary phase goals like "add evaluation metrics" or "build the retrieval layer"** — the keyword set's two substring-collidable tokens are tightened (`eval` → `evals` / `llm eval` / `eval harness`; the under-specified `ai system` is dropped, its genuine matches already covered by `agent` / `llm`), and the gate's instruction now states explicitly that keywords match as whole words or phrases, never substrings — which also defuses the same collision class for the remaining short tokens (`rag` is a substring of `storage`, `coverage`, `average`). The gate is a capability prompt, not a hard block, so this is a precision improvement: fewer spurious AI-SPEC branch prompts on non-AI phases, no change to genuinely AI-flavored goals. (#2115)
