---
id: 60
title: Security Enforcement
group: v1.31 Features
---

**Command:** `/gsd-secure-phase <N>`

**Purpose:** Threat-model-anchored security verification for phase implementations.

**Requirements:**
- REQ-SEC-01: System MUST perform threat-model-anchored verification (not blind scanning)
- REQ-SEC-02: System MUST support configurable OWASP ASVS verification levels (1-3)
- REQ-SEC-03: System MUST block phase advancement based on configurable severity threshold
- REQ-SEC-04: System MUST spawn `gsd-security-auditor` agent for analysis

**Produces:**
| Artifact | Description |
|----------|-------------|
| Security audit report | Threat-model-anchored findings with severity classification |

**Process:**
1. **Model** — Build threat model from phase implementation context
2. **Audit** — Spawn `gsd-security-auditor` to verify against threat model
3. **Gate** — Block phase advancement if findings meet or exceed `security_block_on` severity

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `security_enforcement` | boolean | `true` | Enable threat-model security verification |
| `security_asvs_level` | number (1-3) | `1` | OWASP ASVS verification level |
| `security_block_on` | string | `"high"` | Minimum severity to block phase advancement |
