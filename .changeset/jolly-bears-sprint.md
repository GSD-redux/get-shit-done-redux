---
type: Fixed
pr: 3998
---
**`audit-open acknowledge` works on heading-shaped deferred-items.md** — the CLI writer previously refused every entry in any file using the heading-delimited (#3457) convention (a real project saw 0 of 107 items acknowledgeable); leaf headings and interleaved headless bullets now acknowledge through the same span-anchored, span-verified write the bullet shape uses, with a human `Status: resolved` never downgraded. Only entries embedding a GFM table row still refuse. (#3781)
