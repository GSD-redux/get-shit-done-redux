---
type: Fixed
pr: 4468
---
**`roadmap update-plan-progress` no longer false-greens on checklist-form ROADMAPs** — a phase whose entry is a `- [ ] **Phase N: …**` checklist bullet with no writable Progress-table row or detail section now declines with `updated: false` and a typed `missing_phase_details` reason, leaving ROADMAP.md byte-identical, instead of reporting success off an unrelated checkbox mark while the phase row stayed untouched and blank lines were injected mid-sentence in other phases' entries. (#4247)
