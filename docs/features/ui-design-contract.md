---
id: 3
title: UI Design Contract
group: Core Features
---

**Command:** `/gsd-ui-phase [N]`

**Purpose:** Lock design decisions before planning so that all components in a phase share consistent visual standards.

**Requirements:**
- REQ-UI-01: System MUST detect existing design system state (shadcn components.json, Tailwind config, tokens)
- REQ-UI-02: System MUST ask only unanswered design contract questions
- REQ-UI-03: System MUST validate against 7 dimensions (Copywriting, Visuals, Color, Typography, Spacing, Registry Safety, Inventory Provenance)
- REQ-UI-04: System MUST enter revision loop if validation returns BLOCKED (max 2 iterations)
- REQ-UI-05: System MUST offer shadcn initialization for React/Next.js/Vite projects without `components.json`
- REQ-UI-06: System MUST enforce registry safety gate for third-party shadcn registries

**Produces:** `{padded_phase}-UI-SPEC.md` — Design contract consumed by executors

**7 Validation Dimensions:**
1. **Copywriting** — CTA labels, empty states, error messages
2. **Visuals** — Focal points, visual hierarchy, icon accessibility
3. **Color** — Accent usage discipline, 60/30/10 compliance
4. **Typography** — Font size/weight constraint adherence
5. **Spacing** — Grid alignment, token consistency
6. **Registry Safety** — Third-party component inspection requirements
7. **Inventory Provenance** — Component inventory enumerated from the installed design system, not recalled

**shadcn Integration:**
- Detects missing `components.json` in React/Next.js/Vite projects
- Guides user through `ui.shadcn.com/create` preset configuration
- Preset string becomes a planning artifact reproducible across phases
- Safety gate requires `npx shadcn view` and `npx shadcn diff` before third-party components
