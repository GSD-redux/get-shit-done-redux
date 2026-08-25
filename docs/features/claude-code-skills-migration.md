---
id: 68
title: Claude Code Skills Migration
group: v1.31 Features
---

**Part of:** `npx @opengsd/gsd-core`

**Purpose:** Migrate GSD commands to Claude Code 2.1.88+ skills format with backward compatibility.

**Requirements:**
- REQ-SKILLS-01: Installer MUST write `skills/gsd-*/SKILL.md` for Claude Code 2.1.88+
- REQ-SKILLS-02: Installer MUST auto-clean legacy `commands/gsd/` directory
- REQ-SKILLS-03: Installer MUST maintain backward compatibility with older Claude Code versions via the legacy `commands/gsd/` path

**Process:**
1. **Detect** — Check Claude Code version to determine skills support
2. **Migrate** — Write `skills/gsd-*/SKILL.md` files for each GSD command
3. **Clean** — Remove legacy `commands/gsd/` directory if skills are installed
4. **Fallback** — Maintain legacy `commands/gsd/` path compatibility for older Claude Code versions
