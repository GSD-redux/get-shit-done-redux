---
id: 132
title: Package Legitimacy Gate
group: v1.42.1 Features
---

**Purpose:** Stop hallucinated, suspicious, or slopsquatting package names before they reach a shell install command.

**Behavior:**
- Phase research writes a `## Package Legitimacy Audit` table for recommended packages.
- Packages verified only through search are treated as `[ASSUMED]`, not trusted.
- `[SLOP]` packages are removed from recommendations.
- Plans that need `[ASSUMED]` or suspicious packages add a human verification checkpoint.
- Executor install failures stop for human verification instead of auto-trying similarly named packages.

**Requirements:**
- REQ-PKG-GATE-01: Research MUST record package registry, age, download/source signals, legitimacy verdict, and disposition.
- REQ-PKG-GATE-02: Planner MUST gate unverified or suspicious package installs before execution.
- REQ-PKG-GATE-03: Executor MUST NOT auto-substitute package names after failed package-manager installs.

**Reference:** [v1.42.1 Release Notes](RELEASE-NOTES-LEGACY.md)
