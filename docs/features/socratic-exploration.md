---
id: 94
title: Socratic Exploration
group: v1.34.0 Features
---

**Command:** `/gsd-explore [topic]`

**Purpose:** Guide a developer through exploring an idea via Socratic probing questions before committing to a plan. Routes outputs to the appropriate GSD artifact: notes, todos, seeds, research questions, requirements updates, or a new phase.

**Requirements:**
- REQ-EXPLORE-01: Exploration MUST use Socratic probing — ask questions before proposing solutions
- REQ-EXPLORE-02: Session MUST offer to route outputs to the appropriate GSD artifact
- REQ-EXPLORE-03: An optional topic argument MUST prime the first question
- REQ-EXPLORE-04: Exploration MUST optionally spawn a research agent for technical feasibility
- REQ-EXPLORE-05: A research pass MUST disposition each surfaced claim (admit / refute / abstain) and route every abstention to a visible Unresolved Ledger — never smoothing an ungrounded claim into the narrative as confident prose
