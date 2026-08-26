---
id: 105
title: GSD-2 Reverse Migration
group: v1.35.0 Features
---

**Command:** `/gsd-import --from-gsd2 [--dry-run] [--force] [--path <dir>]`

**Purpose:** Migrate a project from GSD-2 format (`.gsd/` directory with Milestone→Slice→Task hierarchy) back to the v1 `.planning/` format, restoring full compatibility with all GSD v1 commands.

**Requirements:**
- REQ-FROM-GSD2-01: Importer MUST read `.gsd/` from the specified or current directory
- REQ-FROM-GSD2-02: Milestone→Slice hierarchy MUST be flattened to sequential phase numbers (M001/S01→phase 01, M001/S02→phase 02, M002/S01→phase 03, etc.)
- REQ-FROM-GSD2-03: System MUST guard against overwriting an existing `.planning/` directory without `--force`
- REQ-FROM-GSD2-04: `--dry-run` MUST preview all changes without writing any files
- REQ-FROM-GSD2-05: Migration MUST produce `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, and sequential phase directories

**Flags:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview migration output without writing files |
| `--force` | Overwrite an existing `.planning/` directory |
| `--path <dir>` | Specify the GSD-2 root directory |
