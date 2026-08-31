---
id: 134
title: Installer Migrations
group: v1.42.1 Features
---

**Purpose:** Make runtime config cleanup explicit, auditable, and rollback-aware during installs and updates.

**Capabilities:**
- First-time baseline migration records managed files.
- Legacy stale-file cleanup uses ownership evidence before deleting or rewriting.
- User-owned artifacts are preserved.
- Ambiguous GSD-looking files block with a clear report instead of being silently overwritten.
- Migration plans support dry-run reporting and rollback protection.

**Requirements:**
- REQ-INSTALL-MIGRATION-01: Migration records MUST include metadata, install scope, and ownership evidence.
- REQ-INSTALL-MIGRATION-02: Destructive actions MUST fail closed when ownership is ambiguous.
- REQ-INSTALL-MIGRATION-03: Install failures MUST restore the pre-install state when rollback data exists.

**Reference:** [Installer Migrations](installer-migrations.md)
