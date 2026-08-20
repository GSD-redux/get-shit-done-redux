---
type: Added
pr: 3700
---
**Statusline can now warn that STATE.md has fallen behind the code** — enable `statusline.show_state_freshness` and the GSD-state segment renders `state ~N commits back` once HEAD is 20+ commits past the commit STATE.md was written against, the same advisory threshold `/gsd-health`'s W024 uses. Off by default; costs one bounded git call per render only while enabled, and stays silent rather than guessing when freshness cannot be established. (#2734)
