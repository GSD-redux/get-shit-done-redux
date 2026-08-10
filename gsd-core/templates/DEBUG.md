# Debug Template

Template for `.planning/debug/[slug].md` — active debug session tracking.

---

## File Template

```markdown
---
status: gathering | investigating | fixing | verifying | awaiting_human_verify | resolved
goal: find_and_fix | find_root_cause_only
trigger: "[verbatim user input]"
created: [ISO timestamp]
updated: [ISO timestamp]
---

## Current Focus
<!-- OVERWRITE on each update - always reflects NOW -->

hypothesis: [current theory being tested]
test: [how testing it]
expecting: [what result means if true/false]
next_action: [immediate next step — be specific, not "continue investigating"]
bug_class: null  <!-- assigned at Phase 1.75 — bohrbug|heisenbug-mandelbug|concurrency — routes investigation technique (see gsd-core/references/debugger-bug-taxonomy.md) -->
reasoning_checkpoint: null  <!-- populated before every fix attempt — see structured_returns -->
tdd_checkpoint: null  <!-- populated when tdd_mode is active after root cause confirmed -->

## Symptoms
<!-- Written during gathering, then immutable -->

expected: [what should happen]
actual: [what actually happens]
errors: [error messages if any]
reproduction: [how to trigger]
started: [when it broke / always broken]

## Eliminated
<!-- APPEND only - prevents re-investigating after /clear -->

- hypothesis: [theory that was wrong]
  evidence: [what disproved it]
  timestamp: [when eliminated]

## Evidence
<!-- APPEND only - facts discovered during investigation -->

- timestamp: [when found]
  checked: [what was examined]
  found: [what was observed]
  implication: [what this means]

## Runtime Evidence
<!-- OPTIONAL additive schema. Legacy absence means policy off + state not_used. -->

schema_version: 1
policy: adaptive | off
state: not_used | planned | active | cleanup_pending | clean | cleanup_failed
mode: null | passive | source_probes
reproduction_ref: null
next_run_seq: 1
active_run: null  # or {run_id, phase, reproduction_ref, sink_artifact_id, started_at}
artifact_root: null
probes: []
artifacts: []
cleanup:
  markers_remaining: 0
  artifacts_remaining: 0
  verified_at: null
  failure: null

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: [empty until found — may hold one OR a small set of contributing causes when the AND-gate fires; see gsd-core/references/debugger-rca-branching.md]
fix: [empty until applied]
verification: [empty until verified — holds the nested per-signal fix-acceptance guardrail record (map shape) when active; see gsd-core/references/debugger-fix-acceptance.md]
oracle_type: [empty until the regression test is written — specified|derived|metamorphic|implicit; the assertion's oracle classification per gsd-core/references/debugger-repro-hardening.md]
files_changed: []
```

---

<section_rules>

**Frontmatter (status, goal, trigger, timestamps):**
- `status`: OVERWRITE - reflects current phase
- `goal`: IMMUTABLE - set once to `find_and_fix` or `find_root_cause_only`, then never changes
- `trigger`: IMMUTABLE - verbatim user input, never changes
- `created`: IMMUTABLE - set once
- `updated`: OVERWRITE - update on every change
- A missing `goal` in a legacy session means `find_and_fix`; preserve that effective value on every resume without a migration-only rewrite.

**Current Focus:**
- OVERWRITE entirely on each update
- Always reflects what Claude is doing RIGHT NOW
- If Claude reads this after /clear, it knows exactly where to resume
- Fields: hypothesis, test, expecting, next_action, reasoning_checkpoint, tdd_checkpoint
- `next_action`: must be concrete and actionable — bad: "continue investigating"; good: "Add logging at line 47 of auth.js to observe token value before jwt.verify()"
- `reasoning_checkpoint`: OVERWRITE before every fix_and_verify — seven-field structured reasoning record (hypothesis, confirming_evidence, falsification_test, fix_rationale, blind_spots, candidate_causes, and_gate) — see `gsd-debugger.md` Structured Reasoning Checkpoint
- `tdd_checkpoint`: OVERWRITE during TDD red/green phases — test file, name, status, failure output

**Symptoms:**
- Written during initial gathering phase
- IMMUTABLE after gathering complete
- Reference point for what we're trying to fix
- Fields: expected, actual, errors, reproduction, started

**Eliminated:**
- APPEND only - never remove entries
- Prevents re-investigating dead ends after context reset
- Each entry: hypothesis, evidence that disproved it, timestamp
- Critical for efficiency across /clear boundaries

**Evidence:**
- APPEND only - never remove entries
- Facts discovered during investigation
- Each entry: timestamp, what checked, what found, implication
- Builds the case for root cause

**Runtime Evidence:**
- OPTIONAL additive schema version 1. A missing section in a legacy session means `policy: off` and `state: not_used`; do not rewrite merely to migrate it.
- Valid policy is `adaptive | off`. An invalid saved policy remains stored for inspection while effective dispatch fails safe to `off`.
- An explicit policy override changes only `policy`; it never resets state, mode, reproduction, runs, probes, artifacts, or cleanup.
- Probe and artifact entries, write-ahead runs, bounded Evidence digests, and exact cleanup follow `gsd-core/references/debugger-runtime-evidence.md` when the protocol is active or needs reconciliation.
- Terminal-safe means the section is absent; or `not_used` with null root/run and empty probe/artifact ledgers; or `clean` with null root/run, every probe/artifact entry `removed`, and the artifact root removed with identity verified. Both present-state cases require zero cleanup counts and null failure; malformed or contradictory fields are non-terminal.

**Resolution:**
- OVERWRITE as understanding evolves
- May update multiple times as fixes are tried
- Final state shows confirmed root cause and verified fix
- Fields: root_cause, fix, verification, files_changed

</section_rules>

<lifecycle>

**Creation:** Immediately when /gsd:debug is called
- Create file with trigger from user input
- Set status to "gathering"
- Current Focus: next_action = "gather symptoms"
- Symptoms: empty, to be filled

**During symptom gathering:**
- Update Symptoms section as user answers questions
- Update Current Focus with each question
- When complete: status → "investigating"

**During investigation:**
- OVERWRITE Current Focus with each hypothesis
- APPEND to Evidence with each finding
- APPEND to Eliminated when hypothesis disproved
- Update timestamp in frontmatter

**During fixing:**
- status → "fixing"
- Update Resolution.root_cause when confirmed
- Update Resolution.fix when applied
- Update Resolution.files_changed

**During verification:**
- status → "verifying"
- Update Resolution.verification with results
- If verification fails: status → "investigating", try again

**After self-verification passes:**
- status -> "awaiting_human_verify"
- Request explicit user confirmation in a checkpoint
- Do NOT move file to resolved yet

**On resolution:**
- status → "resolved"
- Move file to .planning/debug/resolved/ (only after user confirms fix)

</lifecycle>

<resume_behavior>

When Claude reads this file after /clear:

1. Parse frontmatter → know status and immutable goal (`find_and_fix` when legacy-absent)
2. Inspect Runtime Evidence ownership first when it is non-clean or has an active run
3. Read Current Focus → know exactly what was happening
4. Read Eliminated → know what NOT to retry
5. Read Evidence → know what's been learned
6. Continue from next_action

The file IS the debugging brain. Claude should be able to resume perfectly from any interruption point.

</resume_behavior>

<size_constraint>

Keep debug files focused:
- Evidence entries: 1-2 lines each, just the facts
- Eliminated: brief - hypothesis + why it failed
- No narrative prose - structured data only

If evidence grows very large (10+ entries), consider whether you're going in circles. Check Eliminated to ensure you're not re-treading.

</size_constraint>
