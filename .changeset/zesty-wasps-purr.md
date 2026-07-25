---
type: Fixed
pr: 2642
---
**`execute-phase.md` now has ~3.3 KB of byte-budget headroom** — the `offer_next` step body (terminal reporting + next-phase routing prose) was extracted to `gsd-core/references/offer-next.md` and eagerly `@`-referenced, restoring the headroom the frozen size ceiling exists to provide. Previously the ceiling had only ~32-137 bytes of margin, so any bugfix touching `execute-phase.md` had to extract unrelated content or raise the ceiling. Runtime behavior is unchanged (the `@`-reference loads eagerly). (#2537)
