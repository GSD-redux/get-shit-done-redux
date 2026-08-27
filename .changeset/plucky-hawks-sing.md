---
type: Changed
pr: 0
---
**The API-coverage seal gate no longer clears a phase it never examined** — a phase with no plan body and no roadmap section previously ran the detector over zero bytes and sealed as "no external-API integration"; it is now held with `scope_unavailable`, and the assumption-delta checkpoint reports `skipped` instead of a fabricated `detected:false` when it cannot resolve a phase section. (#3909)
