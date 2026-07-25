---
type: Added
pr: 2258
---
**Bracket phase-ID core grammar lands behind an opt-in flag** — `parsePhaseId`/`renderPhaseId`/`toDir` add one pure round-trippable `PhaseId` model inside the ADR-2121 canonical owner (`src/phase-id.cts`), gated on `phase_id_convention: 'bracket'`, with generative round-trip properties; legacy `null`/`milestone-prefixed` paths stay byte-untouched (epic #612 PR-1). (#2249)

<!-- docs-exempt: internal core grammar behind the phase_id_convention flag; nothing user-visible until the epic's display/injection slices (PR-5/PR-6), which carry the docs/ updates; governing ADR already merged at docs/adr/612-bracket-phase-id-convention.md (#2181) -->

