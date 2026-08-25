---
id: 142
title: Structured JSON Error Mode
group: v1.42.1 Features
---

**CLI:** `gsd-tools --json-errors`

**Purpose:** Give automation callers stable machine-readable error envelopes.

**Behavior:** Commands that fail under `--json-errors` return structured `ok: false` payloads with error kind, message, command context, and exit mapping instead of prose-only stderr.

**Requirements:**
- REQ-JSON-ERRORS-01: Unknown commands, validation errors, timeouts, native failures, fallback failures, and internal errors MUST map to canonical error kinds.
- REQ-JSON-ERRORS-02: CLI exit code mapping MUST remain stable for automation callers.
- REQ-JSON-ERRORS-03: Human-readable output MUST remain the default when `--json-errors` is absent.

**Reference:** [JSON Error Mode](json-errors.md)
