---
type: Changed
pr: 2768
---
**The phase researcher must now read and cite in-repo values before calling them verified** — an enum, schema or type union, error code, status constant, or filesystem path earns a `[VERIFIED: path:line-range]` tag only if the researcher opened the source-of-truth file with `Read` during the run and quoted the values verbatim in the `<interfaces>` block; every value used in a code skeleton must appear in that quote, and anything else stays `[ASSUMED]`. Previously the tag could be earned from training memory or a web search alone, so a plausible-but-drifted enum could pass into RESEARCH.md, get copied into PLAN.md, and fail only at the executor's `parse()`/typecheck — a mid-execution deviation, the most expensive place to discover it. (#1699)
