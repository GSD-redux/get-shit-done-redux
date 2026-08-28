---
type: Changed
pr: 0
---
**A twelfth hand-rolled slug copy can no longer land, and two existing ones are fixed.** `generateSlugInternal` is the canonical slug owner, but nothing prevented a call site from re-deriving it — and two had: `qa-smell-ratchet` trimmed before truncating instead of after, so any non-ASCII input collapsed to just its ASCII tail, and a test helper claimed parity with a function that transliterates while itself not transliterating. A new drift guard now fails the build on an unsanctioned re-derivation, with three legitimately-different sites explicitly sanctioned. (#3987)
