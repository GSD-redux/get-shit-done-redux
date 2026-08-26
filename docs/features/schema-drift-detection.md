---
id: 59
title: Schema Drift Detection
group: v1.31 Features
---

**Command:** Automatic during `/gsd-execute-phase`

**Purpose:** Detect when ORM schema files are modified without corresponding migration or push commands, preventing false-positive verification.

**Requirements:**
- REQ-SCHEMA-01: System MUST detect modifications to ORM schema files (Prisma, Drizzle, Payload, Sanity, Mongoose)
- REQ-SCHEMA-02: System MUST verify corresponding migration/push commands exist when schema changes are detected
- REQ-SCHEMA-03: System MUST implement two-layer defense: plan-time injection and execute-time gate
- REQ-SCHEMA-04: System MUST support `GSD_SKIP_SCHEMA_CHECK` env var to override detection
- REQ-SCHEMA-05: System MUST prevent false-positive verification when schema is modified without migration

**Process:**
1. **Detect** — Monitor ORM schema file modifications during plan execution
2. **Verify** — Check that corresponding migration/push commands are present in the plan
3. **Gate** — Block execution if schema drift is detected without migration (execute-time gate)
4. **Inject** — Add migration reminders during plan generation (plan-time injection)

**Config:** `GSD_SKIP_SCHEMA_CHECK` environment variable to bypass detection.
