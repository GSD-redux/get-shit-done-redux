---
id: 118
title: Sketch Command
group: v1.37.0 Features
---

**Command:** `/gsd-sketch [idea] [--quick] [--text]`

**Purpose:** Explore design directions through throwaway HTML mockups before committing to implementation. Produces 2–3 interactive variants per design question, all viewable directly in a browser with no build step. Companion `/gsd-sketch --wrap-up` packages winning decisions into a project-local skill.

**Requirements:**
- REQ-SKETCH-01: Each sketch MUST answer one specific visual design question
- REQ-SKETCH-02: Each sketch MUST include 2–3 meaningfully different variants in a single `index.html` with tab navigation
- REQ-SKETCH-03: All interactive elements (hover, click, transitions) MUST be functional
- REQ-SKETCH-04: Sketches MUST use real-ish content, not lorem ipsum
- REQ-SKETCH-05: A shared `themes/default.css` MUST provide CSS variables adapted to the agreed aesthetic
- REQ-SKETCH-06: `--quick` flag skips mood intake; `--text` flag replaces `AskUserQuestion` with numbered lists for non-Claude runtimes
- REQ-SKETCH-07: The winning variant MUST be marked in the README frontmatter and with a ★ in the HTML tab
- REQ-SKETCH-08: `/gsd-sketch --wrap-up` MUST package winning decisions into `.claude/skills/sketch-findings-[project]/`

**Produces:**
| Artifact | Description |
|----------|-------------|
| `.planning/sketches/NNN-name/index.html` | 2–3 interactive HTML variants |
| `.planning/sketches/NNN-name/README.md` | Design question, variants, winner, what to look for |
| `.planning/sketches/themes/default.css` | Shared CSS theme variables |
| `.planning/sketches/MANIFEST.md` | Index of all sketches with winners |
| `.claude/skills/sketch-findings-[project]/` | Packaged decisions (via `/gsd-sketch --wrap-up`) |
