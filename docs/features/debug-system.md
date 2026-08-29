---
id: 28
title: Debug System
group: Utility Features
---

**Command:** `/gsd-debug [--runtime-probes | --no-runtime-probes] [description]`

**Purpose:** Systematic debugging with persistent state across context resets and optional, locally captured runtime evidence linked to recorded hypotheses.

**Requirements:**
- REQ-DEBUG-01: System MUST create debug session file in `.planning/debug/`
- REQ-DEBUG-02: System MUST track hypotheses, evidence, and eliminated theories
- REQ-DEBUG-03: System MUST persist state so debugging survives context resets
- REQ-DEBUG-04: System MUST require human verification before marking resolved
- REQ-DEBUG-05: Resolved sessions MUST append to `.planning/debug/knowledge-base.md`
- REQ-DEBUG-06: Knowledge base MUST be consulted on new debug sessions to prevent re-investigation
- REQ-DEBUG-07: Runtime source probes MUST default to `off`; `--runtime-probes` selects opt-in `adaptive`, while `--no-runtime-probes` explicitly selects `off`
- REQ-DEBUG-08: A valid saved runtime-evidence policy MUST survive `continue`; an explicit override MUST change only policy and preserve existing run, probe, artifact, and cleanup state
- REQ-DEBUG-09: Adaptive source probes MUST require an exact persisted reproduction, competing hypotheses, bounded sanitized output, low perturbation risk, and durable ownership before source mutation
- REQ-DEBUG-10: The identical reproduction MUST be used for `baseline`, `post_fix`, and final `uninstrumented_verify`
- REQ-DEBUG-11: Session-owned source probes and capture artifacts MUST be hash/identity-verified and removed before terminal actions; cleanup failure MUST block commit, verification, abandonment, archive, and completion
- REQ-DEBUG-12: Runtime evidence MUST remain local and add no daemon, hosted service, telemetry, network transport, SDK, or external dependency

**Debug Session States:** `gathering` → `investigating` → `fixing` → `verifying` → `awaiting_human_verify` → `resolved`

**Runtime Evidence States:** `not_used` → `planned` → `active` → `cleanup_pending` → `clean`, with fail-closed `cleanup_failed`
