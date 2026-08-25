---
id: 7
title: UI Review
group: Core Features
---

**Command:** `/gsd-ui-review [N]`

**Purpose:** Retroactive 6-pillar visual audit of implemented frontend code. Works standalone on any project.

**Requirements:**
- REQ-UIREVIEW-01: System MUST score each of the 6 pillars on a 1-4 scale
- REQ-UIREVIEW-02: System MUST capture screenshots via Playwright CLI to `.planning/ui-reviews/`
- REQ-UIREVIEW-03: System MUST create `.gitignore` for screenshot directory
- REQ-UIREVIEW-04: System MUST identify top 3 priority fixes
- REQ-UIREVIEW-05: System MUST work standalone (without UI-SPEC.md) using abstract quality standards

**6 Audit Pillars (scored 1-4):**
1. **Copywriting** — CTA labels, empty states, error states
2. **Visuals** — Focal points, visual hierarchy, icon accessibility
3. **Color** — Accent usage discipline, 60/30/10 compliance
4. **Typography** — Font size/weight constraint adherence
5. **Spacing** — Grid alignment, token consistency
6. **Experience Design** — Loading/error/empty state coverage

**Produces:** `{padded_phase}-UI-REVIEW.md` — Scores and prioritized fixes
