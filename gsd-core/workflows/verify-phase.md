<purpose>
Verify phase goal achievement through goal-backward analysis. Check that the codebase delivers what the phase promised, not just that tasks completed.

Executed by a verification subagent spawned from execute-phase.md.
</purpose>

<core_principle>
**Task completion ≠ Goal achievement**

A task "create chat component" can be marked complete when the component is a placeholder. The task was done — but the goal "working chat interface" was not achieved.

Goal-backward verification:
1. What must be TRUE for the goal to be achieved?
2. What must EXIST for those truths to hold?
3. What must be WIRED for those artifacts to function?
4. What must TESTS PROVE for those truths to be evidenced?

Then verify each level against the actual codebase.
</core_principle>

<required_reading>
@~/.claude/gsd-core/references/verification-patterns.md
@~/.claude/gsd-core/templates/verification-report.md
</required_reading>

<process>

<step name="load_context" priority="first">
Load phase operation context:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `phase_dir`, `phase_number`, `phase_name`, `has_plans`, `plan_count`.

Then load phase details and list plans/summaries:
```bash
gsd_run query roadmap.get-phase "${phase_number}"
grep -E "^| ${phase_number}" .planning/REQUIREMENTS.md 2>/dev/null || true
ls "$phase_dir"/*-SUMMARY.md "$phase_dir"/*-PLAN.md 2>/dev/null || true
```

Load full milestone phases for deferred-item filtering (Step 9b):
```bash
gsd_run query roadmap.analyze
```

Extract **phase goal** from ROADMAP.md (the outcome to verify, not tasks), **requirements** from REQUIREMENTS.md if it exists, and **all milestone phases** from roadmap analyze (for cross-referencing gaps against later phases).
</step>

<step name="establish_must_haves">
**Option A: Must-haves in PLAN frontmatter**

Use `gsd-tools.cjs query` verify handlers (or legacy gsd-tools) to extract must_haves from each PLAN:

```bash
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null
for plan in "$PHASE_DIR"/*-PLAN.md; do
  MUST_HAVES=$(gsd_run query frontmatter.get "$plan" --field must_haves)
  echo "=== $plan ===" && echo "$MUST_HAVES"
done
```

Returns JSON: `{ truths: [...], artifacts: [...], key_links: [...], prohibitions: [...] }`

Aggregate all must_haves across plans for phase-level verification.

**Prohibitions (`must_haves.prohibitions`, ADR-550 D3 — the must-NOT sibling block):** When a plan carries `must_haves.prohibitions`, extract each `{ statement, status, verification }` item and route it by `verification` tier in verdict assembly (ADR-550 D4, "B-with-guard", 2026-06-12 maintainer decision). These are NEGATIVE checks (the must-NOT must NOT have happened), distinct from positive `truths`:

- **judgment-tier → mode-dependent soft-gate.** Interactive verify defers each item to the end-of-phase human checkpoint (`human_verify_mode: end-of-phase`). Autonomous verify records a NON-AUTHORITATIVE LLM-judge verdict + a prominent `unverified-prohibition — human review recommended` flag (autonomous completion reads "complete with N flagged prohibitions"). NEVER a silent pass; NEVER a hard halt of an AFK run.
- **test-tier → ENFORCED via `check prohibition-enforcement` (green on pass, hard-gate on miss/fail).** Accept the `verification: test` value (the SPEC↔must_haves.prohibitions projection contract holds — no forced schema change later). For each test-tier item, the verifier builds `request.check` **DETERMINISTICALLY from the projected descriptor** — it does NOT invent `{ kind, target, rule }`. Read the flat scalar keys `check_kind` / `check_target` / `check_rule` / `check_violation_fixture` off the `must_haves.prohibitions` item and reconstruct the `CheckDescriptor` via the `descriptorFromProjection` adapter in `prohibition-enforcement` (`descriptorFromProjection(projectedItem)` → `{ kind: check_kind, target: check_target, rule?: check_rule, violationFixture?: check_violation_fixture }`). The `violationFixture` (a path to a KNOWN-BAD subject) is the field that gates **green** and it is **now projected** (`check_violation_fixture`, #1346) — so a prohibition authored with all four scalars greens through the projection alone, **zero hand-authoring at verify time**. Do NOT rely on `failFirst`: it is DEMOTED (#1279) and greens nothing on its own; an item with no projected fixture hard-gates fail-closed. Invoke the producer (CLI surface unchanged):

  ```bash
  gsd_run check prohibition-enforcement <request.json>
  ```

  where `<request.json>` carries `{ prohibition, check, mode }` — `check` being the wired mechanical-check descriptor `{ kind: 'node-test' | 'lint-rule', target, rule?, violationFixture, cleanFixture?, failFirst? }`, with `kind`/`target`/`rule`/`violationFixture`/`cleanFixture` now sourced from the projected `check_*` scalars (not author/verifier invention — #1278 + #1279 + #1346). For `node-test`, `target` (from `check_target`) is the negative-test file path; for `lint-rule`, `target` is the PATH to lint and `rule` (from `check_rule`) is the eslint rule id (e.g. `local/no-source-grep`) — both required (a lint-rule without `rule` is not a valid wired check). `violationFixture` (from `check_violation_fixture`) is the path to a KNOWN-BAD subject the producer runs the check against to **machine-prove fail-first** (for `node-test`, injected via the `GSD_PROHIB_SUBJECT` env convention — #1279); the optional `cleanFixture` (from `check_clean_fixture`) is a KNOWN-CLEAN control subject the `node-test` prover ALSO requires to stay GREEN, proving the RED is content-caused (#1346); `failFirst` is a DEMOTED, non-authoritative hint kept only for backward route-JSON shape (no path greens on it alone — FF-08). The producer LOCATES the wired check from the projection, **machine-proves it is fail-first** by running it against the violation and confirming it goes RED, RUNS it for a genuine non-vacuous pass, builds `enforcementEvidence`, and emits the `dispositionForProhibition()` verdict (#1259 + #1278 + #1279, ADR-550 D5d). Fail-first is **machine-proven, not caller-attested** — absent a provable violation the producer fails closed, never falling back to attestation. Route the result by its typed fields:
  - **`status: 'green'`, `flagged: false`** (a genuinely-passing wired negative test / lint rule, `located: true`, non-empty `evidence`) → the item is satisfiable → it can reach **passed**.
  - **missing, non-attested, or genuinely-non-passing check** (`located: false` OR `status: 'unverified'`, `flagged: true`) → **hard-gate**: disposes flagged-unverified, NEVER green, routing to `gaps_found` in BOTH interactive and autonomous modes (a failing mechanical check blocks even AFK; ADR-550 D4 / D3). The deterministic fail-closed default backing every miss/fail is `dispositionForProhibition()` in probe-core (`status: 'unverified'`, `flagged: true` on empty `enforcementEvidence`).

  > **Descriptor source — deterministic locate + machine-proof compose (#1278 + #1346, DELIVERED).** The `check` descriptor's `{ kind, target, rule, violationFixture }` is now sourced **deterministically from the projected `check_kind` / `check_target` / `check_rule` / `check_violation_fixture` scalars** on the `must_haves.prohibitions` item (authored at `/gsd:spec-phase`, projected by `projectProhibitions`, read back via the `descriptorFromProjection` adapter). So both halves close with **zero manual descriptor authoring** — the verifier neither invents the locate (#1278) nor hand-supplies the violation fixture (#1346): a prohibition authored with all four scalars machine-proves fail-first and greens end-to-end through the projection alone (removing the spoofable invent-at-verify-time surface; ADR-857 §147 exogenous grading). **Fail-closed is preserved:** an item with NO projected descriptor, a PARTIAL one (e.g. a `lint-rule` missing `check_rule`), OR a descriptor with **no `check_violation_fixture`** makes `descriptorFromProjection` return `null` / an under-specified or fixture-less descriptor, which falls through to the producer's fail-closed paths (`located: false`, or located-but-unprovable) → flagged-unverified, NEVER green, in BOTH modes. `failFirst` is demoted and greens nothing on its own (#1279, FF-08). Causation (**#1346**): supplying `check_clean_fixture` adds an opt-in control — the `node-test` prover also requires GREEN on a known-clean subject, proving the RED is content-caused; with no clean fixture that one residual case (a deceptive test reding merely because the env var is set) stays a documented constraint, an author opting into the stronger proof by wiring a clean control.

**Option B: Use Success Criteria from ROADMAP.md**

If no must_haves in frontmatter (MUST_HAVES returns error or empty), check for Success Criteria:

```bash
PHASE_DATA=$(gsd_run query roadmap.get-phase "${phase_number}" --raw)
```

Parse the `success_criteria` array from the JSON output. If non-empty:
1. Use each Success Criterion directly as a **truth** (they are already written as observable, testable behaviors)
2. Derive **artifacts** (concrete file paths for each truth)
3. Derive **key links** (critical wiring where stubs hide)
4. Document the must-haves before proceeding

Success Criteria from ROADMAP.md are the contract — they override PLAN-level must_haves when both exist.

**Option C: Derive from phase goal (fallback)**

If no must_haves in frontmatter AND no Success Criteria in ROADMAP:
1. State the goal from ROADMAP.md
2. Derive **truths** (3-7 observable behaviors, each testable)
3. Derive **artifacts** (concrete file paths for each truth)
4. Derive **key links** (critical wiring where stubs hide)
5. Document derived must-haves before proceeding
</step>

<step name="verify_truths">
For each observable truth, determine if the codebase enables it.

**Status:** ✓ VERIFIED (all supporting artifacts pass — and, for a behavior-dependent truth, a behavioral test exercises the asserted behavior) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (present + wired, but a state transition or cancellation/cleanup/ordering invariant is exercised by no test — routes to human verification, excluded from the score) | ✗ FAILED (artifact missing/stub/unwired) | ? UNCERTAIN (needs human)

For each truth: identify supporting artifacts → check artifact status → check wiring → determine truth status.

**Behavior-dependent truths:** when a truth asserts a state transition or a cancellation/cleanup/ordering invariant, symbol presence + wiring is necessary but not sufficient — the code can be present and wired yet still leak state on the path the invariant covers. Mark such a truth ✓ VERIFIED only when a pre-existing test exercises the transition/invariant and passes (one named test, never the full suite); otherwise mark it ⚠️ PRESENT_BEHAVIOR_UNVERIFIED, emit a human-verification item, and exclude it from the verified score.

**Non-inferable (`backstop`) truths (#1154):** a `must_haves.truths` item in object form `{ statement, verification: backstop }` is non-inferable — the correct behavior is not derivable from the spec alone, so the verifier cannot self-detect the gap and would false-pass it confidently. Branch on the `verification: backstop` field (read via `truthVerification()`, never prose): if confirmable with **explicit evidence** (a passing wired held-out/property test, or a directly-observed behavior) → ✓ VERIFIED; otherwise **abstain** — mark ⚠️ `insufficient_spec`, emit an `unverified — held-out test recommended` human-verification item, exclude from the verified score (routes to `human_needed`). Exogenous only (never a self-judged "abstain if unsure"); an inferable truth is never abstained. See `references/honest-verifier.md`.

**Example:** Truth "User can see existing messages" depends on Chat.tsx (renders), /api/chat GET (provides), Message model (schema). If Chat.tsx is a stub or API returns hardcoded [] → FAILED. If all exist, are substantive, and connected → VERIFIED.
</step>

<step name="verify_artifacts">
Use `gsd-tools.cjs query verify.artifacts` (or legacy gsd-tools) for artifact verification against must_haves in each PLAN:

```bash
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null
for plan in "$PHASE_DIR"/*-PLAN.md; do
  ARTIFACT_RESULT=$(gsd_run query verify.artifacts "$plan")
  echo "=== $plan ===" && echo "$ARTIFACT_RESULT"
done
```

Parse JSON result: `{ all_passed, passed, total, artifacts: [{path, exists, issues, passed}] }`

**Artifact status from result:**
- `exists=false` → MISSING
- `issues` not empty → STUB (check issues for "Only N lines" or "Missing pattern")
- `passed=true` → VERIFIED (Levels 1-2 pass)

**Level 3 — Wired (manual check for artifacts that pass Levels 1-2):**
```bash
grep -r "import.*$artifact_name" src/ --include="*.ts" --include="*.tsx"  # IMPORTED
grep -r "$artifact_name" src/ --include="*.ts" --include="*.tsx" | grep -v "import"  # USED
```
WIRED = imported AND used. ORPHANED = exists but not imported/used.

| Exists | Substantive | Wired | Status |
|--------|-------------|-------|--------|
| ✓ | ✓ | ✓ | ✓ VERIFIED |
| ✓ | ✓ | ✗ | ⚠️ ORPHANED |
| ✓ | ✗ | - | ✗ STUB |
| ✗ | - | - | ✗ MISSING |

**Export-level spot check (WARNING severity):**

For artifacts that pass Level 3, spot-check individual exports:
- Extract key exported symbols (functions, constants, classes — skip types/interfaces)
- For each, grep for usage outside the defining file
- Flag exports with zero external call sites as "exported but unused"

This catches dead stores like `setPlan()` that exist in a wired file but are
never actually called. Report as WARNING — may indicate incomplete cross-plan
wiring or leftover code from plan revisions.
</step>

<step name="verify_wiring">
Use `gsd-tools.cjs query verify.key-links` (or legacy gsd-tools) for key link verification against must_haves in each PLAN:

```bash
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null
for plan in "$PHASE_DIR"/*-PLAN.md; do
  LINKS_RESULT=$(gsd_run query verify.key-links "$plan")
  echo "=== $plan ===" && echo "$LINKS_RESULT"
done
```

Parse JSON result: `{ all_verified, verified, total, links: [{from, to, via, verified, detail}] }`

**Link status from result:**
- `verified=true` → WIRED
- `verified=false` with "not found" → NOT_WIRED
- `verified=false` with "Pattern not found" → PARTIAL

**Fallback patterns (if key_links not in must_haves):**

| Pattern | Check | Status |
|---------|-------|--------|
| Component → API | fetch/axios call to API path, response used (await/.then/setState) | WIRED / PARTIAL (call but unused response) / NOT_WIRED |
| API → Database | Prisma/DB query on model, result returned via res.json() | WIRED / PARTIAL (query but not returned) / NOT_WIRED |
| Form → Handler | onSubmit with real implementation (fetch/axios/mutate/dispatch), not console.log/empty | WIRED / STUB (log-only/empty) / NOT_WIRED |
| State → Render | useState variable appears in JSX (`{stateVar}` or `{stateVar.property}`) | WIRED / NOT_WIRED |

Record status and evidence for each key link.
</step>

<step name="verify_requirements">
If REQUIREMENTS.md exists:
```bash
grep -E "Phase ${PHASE_NUM}" .planning/REQUIREMENTS.md 2>/dev/null || true
```

For each requirement: parse description → identify supporting truths/artifacts → status: ✓ SATISFIED / ✗ BLOCKED / ? NEEDS HUMAN.
</step>

<step name="verify_decisions">
**Decision coverage validation gate (issue #2492).**

After requirements coverage, also check that each trackable CONTEXT.md
`<decisions>` entry shows up somewhere in the shipped artifacts (plans,
SUMMARY.md, files modified by the phase, or recent commit subjects on the
phase branch).

This gate is **non-blocking / warning only** by deliberate asymmetry with
the plan-phase translation gate. The plan-phase gate already blocked at
translation time, so by the time verification runs every decision has
either been translated or explicitly deferred. This gate's job is to
surface decisions that *were* translated but vanished during execution —
that's a soft signal because "honors a decision" is a fuzzy substring
heuristic, and we don't want a paraphrase miss to fail an otherwise good
phase.

**Skip if** `workflow.context_coverage_gate` is explicitly set to `false`
(absent key = enabled). Also skip cleanly when CONTEXT.md is missing or has
no `<decisions>` block.

```bash
GATE_CFG=$(gsd_run query config-get workflow.context_coverage_gate 2>/dev/null || echo "true")
if [ "$GATE_CFG" != "false" ]; then
  CONTEXT_PATH=$(ls "${PHASE_DIR}"/*-CONTEXT.md 2>/dev/null | head -1)  # #2962: not a for-glob (zsh aborts)
  DECISION_RESULT=$(gsd_run query check.decision-coverage-verify "${PHASE_DIR}" "${CONTEXT_PATH}")
fi
```

The handler returns JSON `{ skipped, blocking: false, total, honored,
not_honored: [...], message }`.

**Reporting:** Append the handler's `message` (a `### Decision Coverage`
section) to VERIFICATION.md regardless of outcome — even when all
decisions are honored, recording the count helps reviewers spot drift over
time. Set `decision_coverage` in the verification result to
`{honored, total, not_honored: [...]}` so downstream tooling can read it.

**Status impact:** none. The decision gate does NOT influence the
`gaps_found` / `human_needed` / `passed` decision tree in
`determine_status`. Its findings are warnings the user reviews and may act
on by re-opening the phase or by acknowledging the decision was abandoned
intentionally.
</step>

<step name="behavioral_verification">
**Run the project's test suite and CLI commands to verify behavior, not just structure.**

Static checks (grep, file existence, wiring) catch structural gaps but miss runtime
failures. This step runs actual tests and project commands to verify the phase goal
is behaviorally achieved.

This follows Anthropic's harness engineering principle: separating generation from
evaluation, with the evaluator interacting with the running system rather than
inspecting static artifacts.

**Step 1: Run test suite**

```bash
# Resolve test command: project config > Makefile > language sniff
TEST_CMD=$(gsd_run query config-get workflow.test_command --default "" --raw 2>/dev/null || true)
if [ -z "$TEST_CMD" ]; then
  if [ -f "Makefile" ] && grep -q "^test:" Makefile; then
    TEST_CMD="make test"
  elif [ -f "Justfile" ] || [ -f "justfile" ]; then
    TEST_CMD="just test"
  elif [ -f "package.json" ]; then
    TEST_CMD="npm test"
  elif [ -f "Cargo.toml" ]; then
    TEST_CMD="cargo test"
  elif [ -f "go.mod" ]; then
    TEST_CMD="go test ./..."
  elif [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
    TEST_CMD="python -m pytest -q --tb=short 2>&1 || uv run python -m pytest -q --tb=short"
  else
    TEST_CMD="false"
    echo "⚠ No test runner detected — skipping test suite"
  fi
fi
# Run all tests (timeout: 5 min). #1857: normalize to one-shot so watch mode exits.
TEST_CMD=$(gsd_run query normalize-test-command "$TEST_CMD" --cwd . 2>/dev/null || echo "$TEST_CMD")
TEST_EXIT=0
gsd_run run-with-timeout 300 -- bash -c "$TEST_CMD" 2>&1
TEST_EXIT=$?
if [ "${TEST_EXIT}" -eq 0 ]; then
  echo "✓ Test suite passed"
elif [ "${TEST_EXIT}" -eq 124 ]; then
  echo "⚠ Test suite timed out after 5 minutes — likely watch/dev mode"
else
  echo "✗ Test suite failed (exit code ${TEST_EXIT})"
fi
```

Record: total tests, passed, failed, coverage (if available).

**If any tests fail:** Mark as `behavioral_failures` — these are BLOCKER severity
regardless of whether static checks passed. A phase cannot be verified if tests fail.

**Step 2: Run project CLI/commands from success criteria (if testable)**

For each success criterion that describes a user command (e.g., "User can run
`mixtiq validate`", "User can run `npm start`"):

1. Check if the command exists and required inputs are available:
   - Look for example files in `templates/`, `fixtures/`, `test/`, `examples/`, or `testdata/`
   - Check if the CLI binary/script exists on PATH or in the project
2. **If no suitable inputs or fixtures exist:** Mark as `? NEEDS HUMAN` with reason
   "No test fixtures available — requires manual verification" and move on.
   Do NOT invent example inputs.
3. If inputs are available: run the command and verify it exits successfully.

```bash
# Only run if both command and input exist
if command -v {project_cli} &>/dev/null && [ -f "{example_input}" ]; then
  {project_cli} {example_input} 2>&1
fi
```

Record: command, exit code, output summary, pass/fail (or SKIPPED if no fixtures).

**Step 3: Report**

```
## Behavioral Verification

| Check | Result | Detail |
|-------|--------|--------|
| Test suite | {N} passed, {M} failed | {first failure if any} |
| {CLI command 1} | ✓ / ✗ | {output summary} |
| {CLI command 2} | ✓ / ✗ | {output summary} |
```

**If all behavioral checks pass:** Continue to scan_antipatterns.
**If any fail:** Add to verification gaps with BLOCKER severity.
</step>

<step name="scan_antipatterns">
Extract files modified in this phase from SUMMARY.md, scan each:

| Pattern | Search | Severity |
|---------|--------|----------|
| TBD/FIXME/XXX without same-line `issue #123`, `PR #123`, `#123`, or `DEF-*` reference | `grep -n -e TBD -e FIXME -e XXX` | 🛑 Blocker |
| TODO/HACK | `grep -n -e TODO -e HACK` | ⚠️ Warning |
| Placeholder content | `grep -n -iE "placeholder\|coming soon\|will be here"` | 🛑 Blocker |
| Empty returns | `grep -n -E "return null\|return \{\}\|return \[\]\|=> \{\}"` | ⚠️ Warning |
| Log-only functions | Functions containing only console.log | ⚠️ Warning |

Categorize: 🛑 Blocker (prevents goal) | ⚠️ Warning (incomplete) | ℹ️ Info (notable).
</step>

<step name="audit_test_quality">
**Verify that tests PROVE what they claim to prove.**

This step catches test-level deceptions that pass all prior checks: files exist, are substantive, are wired, and tests pass — but the tests don't actually validate the requirement.

**1. Identify requirement-linked test files**

From PLAN and SUMMARY files, map each requirement to the test files that are supposed to prove it.

**2. Disabled test scan**

For ALL test files linked to requirements, search for disabled/skipped patterns:

```bash
grep -rn -E "it\.skip|describe\.skip|test\.skip|xit\(|xdescribe\(|xtest\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]|\.pending|it\.todo|test\.todo" "$TEST_FILE"
```

**Rule:** A disabled test linked to a requirement = requirement NOT tested.
- 🛑 BLOCKER if the disabled test is the only test proving that requirement
- ⚠️ WARNING if other active tests also cover the requirement

**3. Circular test detection**

Search for scripts/utilities that generate expected values by running the system under test:

```bash
grep -rn -E "writeFileSync|writeFile|fs\.write|open\(.*w\)" "$TEST_DIRS"
```

For each match, check if it also imports the system/service/module being tested. If a script both imports the system-under-test AND writes expected output values → CIRCULAR.

**Circular test indicators:**
- Script imports a service AND writes to fixture files
- Expected values have comments like "computed from engine", "captured from baseline"
- Script filename contains "capture", "baseline", "generate", "snapshot" in test context
- Expected values were added in the same commit as the test assertions

**Rule:** A test comparing system output against values generated by the same system is circular. It proves consistency, not correctness.

**4. Expected value provenance** (for comparison/parity/migration requirements)

When a requirement demands comparison with an external source ("identical to X", "matches Y", "same output as Z"):

- Is the external source actually invoked or referenced in the test pipeline?
- Do fixture files contain data sourced from the external system?
- Or do all expected values come from the new system itself or from mathematical formulas?

**Provenance classification:**
- VALID: Expected value from external/legacy system output, manual capture, or independent oracle
- PARTIAL: Expected value from mathematical derivation (proves formula, not system match)
- CIRCULAR: Expected value from the system being tested
- UNKNOWN: No provenance information — treat as SUSPECT

**5. Assertion strength**

For each test linked to a requirement, classify the strongest assertion:

| Level | Examples | Proves |
|-------|---------|--------|
| Existence | `toBeDefined()`, `!= null` | Something returned |
| Type | `typeof x === 'number'` | Correct shape |
| Status | `code === 200` | No error |
| Value | `toEqual(expected)`, `toBeCloseTo(x)` | Specific value |
| Behavioral | Multi-step workflow assertions | End-to-end correctness |

If a requirement demands value-level or behavioral-level proof and the test only has existence/type/status assertions → INSUFFICIENT.

**6. Coverage quantity**

If a requirement specifies a quantity of test cases (e.g., "30 calculations"), check if the actual number of active (non-skipped) test cases meets the requirement.

**Reporting — add to VERIFICATION.md:**

```markdown
### Test Quality Audit

| Test File | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
|-----------|-----------|--------|---------|----------|----------------|---------|

**Disabled tests on requirements:** {N} → {BLOCKER if any req has ONLY disabled tests}
**Circular patterns detected:** {N} → {BLOCKER if any}
**Insufficient assertions:** {N} → {WARNING}
```

**Impact on status:** Any BLOCKER from test quality audit ��� overall status = `gaps_found`, regardless of other checks passing.
</step>

<step name="identify_human_verification">
**First: determine if this is an infrastructure/foundation phase.**

Infrastructure and foundation phases — code foundations, database schema, internal APIs, data models, build tooling, CI/CD, internal service integrations — have no user-facing elements by definition. For these phases:

- Do NOT invent artificial manual steps (e.g., "manually run git commits", "manually invoke methods", "manually check database state").
- Mark human verification as **N/A** with rationale: "Infrastructure/foundation phase — no user-facing elements to test manually."
- Set `human_verification: []` and do **not** produce a `human_needed` status solely due to lack of user-facing features.
- Only add human verification items if the phase goal or success criteria explicitly describe something a user would interact with (UI, CLI command output visible to end users, external service UX).
- **Exception — behavior-unverified truths still count.** A truth marked ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (a state transition or a cancellation/cleanup/ordering invariant with no test exercising it) is a behavioral-evidence gap, not an artificial user-facing step. Record it in `behavior_unverified_items` and emit a human-verification item for it **even on an infrastructure/foundation phase** — these invariants are exactly where infra phases hide runtime state leaks. Such a truth drives `human_needed`; the auto-pass-UAT shortcut applies only to the absence of user-facing UX, never to a behavior-unverified invariant.

**How to determine if a phase is infrastructure/foundation:**
- Phase goal or name contains: "foundation", "infrastructure", "schema", "database", "internal API", "data model", "scaffolding", "pipeline", "tooling", "CI", "migrations", "service layer", "backend", "core library"
- Phase success criteria describe only technical artifacts (files exist, tests pass, schema is valid) with no user interaction required
- There is no UI, CLI output visible to end users, or real-time behavior to observe

**If the phase IS infrastructure/foundation:** auto-pass UAT — skip the human verification items list entirely, **except any ⚠️ PRESENT_BEHAVIOR_UNVERIFIED truth (see exception above), which still emits a human-verification item and drives `human_needed`.** Log:

```markdown
## Human Verification

N/A — Infrastructure/foundation phase with no user-facing elements.
All acceptance criteria are verifiable programmatically.
```

**If the phase IS user-facing:** Only flag items that genuinely require a human. Do not invent steps.

**Always needs human (user-facing phases only):** Visual appearance, user flow completion, real-time behavior (WebSocket/SSE), external service integration, performance feel, error message clarity.

**Needs human if uncertain (user-facing phases only):** Complex wiring grep can't trace, dynamic state-dependent behavior, edge cases.

Format each as: Test Name → What to do → Expected result → Why can't verify programmatically.
</step>

<step name="determine_status">
Classify status using this decision tree IN ORDER (most restrictive first):

1. IF any truth FAILED, artifact MISSING/STUB, key link NOT_WIRED, blocker found, **or test quality audit found blockers (disabled requirement tests, circular tests)**:
   → **gaps_found**

2. IF any `must_haves.prohibitions` item disposes as flagged-unverified (ADR-550 D4):
   - **test-tier, fail-closed when the wired check is MISSING OR FAILS** (now run via `check prohibition-enforcement` — `located: false`, or `dispositionForProhibition()` returns `status: 'unverified'`, `flagged: true`): → **gaps_found** in both interactive and autonomous modes (never green; a missing/failing mechanical check is an unverified gap). A test-tier item whose wired check PASSES disposes `status: 'green'`, `flagged: false` and is NOT a gap — it can reach **passed**.
   - **judgment-tier, autonomous run** (non-authoritative LLM-judge verdict): emit the `unverified-prohibition — human review recommended` flag and classify → **human_needed** (autonomous completion reads "complete with N flagged prohibitions"; never a silent pass, never a hard halt).
   - **judgment-tier, interactive run**: route to the end-of-phase human checkpoint → **human_needed**.

2b. IF any `must_haves.truths` item carries the `verification: backstop` marker (#1154 — the verify-time truth-axis mirror of ADR-550 D4) AND the verifier cannot confirm it with **explicit evidence** (a wired held-out/property-based test that PASSES, or a directly-observed behavior — i.e. `dispositionForUnverifiableTruth()` returns `status: 'unverified'`, `flagged: true`, `reason: 'insufficient_spec'`):
   - **abstain → human_needed**, NEVER `passed` and never silently graded green. Emit a prominent `unverified — held-out test recommended` flag carrying the distinguishable `reason: insufficient_spec` (so it is not conflated with ordinary manual-UAT `human_needed`).
   - *Autonomous run:* record it and continue — completion reads "complete with N unverified non-inferable checks"; never a hard halt of an AFK run. *Interactive run:* route to the end-of-phase human checkpoint.
   - **Exogenous only:** abstention fires SOLELY on the `backstop` tag, never a self-judged "abstain if unsure" (N17). An **inferable** truth is NEVER abstained (over-abstention guard); a `backstop` truth WITH a passing wired held-out test reaches **passed**. Reliable on capable tiers (`sonnet`+); the budget `haiku` tier degrades — see `references/honest-verifier.md`.

3. IF the previous step produced ANY human verification items — this includes every ⚠️ PRESENT_BEHAVIOR_UNVERIFIED truth and every abstained `insufficient_spec` backstop truth:
   → **human_needed** (even if all other truths VERIFIED)

4. IF all checks pass AND no human verification items AND no flagged prohibitions AND no abstained (`insufficient_spec`) truths:
   → **passed**

**passed is ONLY valid when no human verification items, no flagged prohibitions, AND no abstained `insufficient_spec` truths exist.** Neither a prohibition (must-NOT) nor an unconfirmable non-inferable truth can ever be silently absorbed into a `passed` verdict — that is the core failure mode ADR-550 D4 forbids (now closed on both the prohibition and truth axes).

A ⚠️ PRESENT_BEHAVIOR_UNVERIFIED truth is never FAILED and never VERIFIED: it does not trigger gaps_found (the code is present and wired) and is not counted as verified (its runtime behavior was not exercised). It routes through the existing human_needed sink — no new overall status.

**Score:** `verified_truths / total_truths` — `verified_truths` counts ✓ VERIFIED truths plus PASSED (override) truths; excluded are ⚠️ PRESENT_BEHAVIOR_UNVERIFIED truths (the `behavior_unverified` count) and abstained ⚠️ `insufficient_spec` backstop truths (#1154) — both are not ✓ VERIFIED and both route to `human_needed`. A headline N/N therefore certifies behavioral evidence for every behavior-dependent truth and explicit evidence for every non-inferable one, not merely symbol presence.
</step>

<step name="filter_deferred_items">
Before reporting gaps, cross-reference each gap against later phases in the milestone using the full roadmap data loaded in load_context (from `roadmap analyze`).

For each potential gap identified in determine_status:
1. Check if the gap's failed truth or missing item is covered by a later phase's goal or success criteria
2. **Match criteria:** The gap's concern appears in a later phase's goal text, success criteria text, or the later phase's name clearly suggests it covers this area
3. If a clear match is found → move the gap to a `deferred` list with the matching phase reference and evidence text
4. If no match in any later phase → keep as a real `gap`

**Important:** Be conservative. Only defer a gap when there is clear, specific evidence in a later phase. Vague or tangential matches should NOT cause deferral — when in doubt, keep it as a real gap.

**Deferred items do NOT affect the status determination.** Recalculate after filtering:
- If gaps list is now empty and no human items exist → `passed`
- If gaps list is now empty but human items exist → `human_needed`
- If gaps list still has items → `gaps_found`

Include deferred items in VERIFICATION.md frontmatter (`deferred:` section) and body (Deferred Items table) for transparency. If no deferred items exist, omit these sections.
</step>

<step name="generate_fix_plans">
If gaps_found:

1. **Cluster related gaps:** API stub + component unwired → "Wire frontend to backend". Multiple missing → "Complete core implementation". Wiring only → "Connect existing components".

2. **Generate plan per cluster:** Objective, 2-3 tasks (files/action/verify each), re-verify step. Keep focused: single concern per plan.

3. **Order by dependency:** Fix missing → fix stubs → fix wiring → **fix test evidence** → verify.
</step>

<step name="create_report">
```bash
REPORT_PATH="$PHASE_DIR/${PHASE_NUM}-VERIFICATION.md"
```

Fill template sections: frontmatter (phase/timestamp/status/score), goal achievement, artifact table, wiring table, requirements coverage, anti-patterns, human verification, gaps summary, fix plans (if gaps_found), metadata.

See ~/.claude/gsd-core/templates/verification-report.md for complete template.
</step>

<step name="return_to_orchestrator">
Return status (`passed` | `gaps_found` | `human_needed`), score (N/M must-haves), report path.

If gaps_found: list gaps + recommended fix plan names.
If human_needed: list items requiring human testing.

Orchestrator routes: `passed` → update_roadmap | `gaps_found` → create/execute fixes, re-verify | `human_needed` → present to user.
</step>

</process>

<success_criteria>
- [ ] Must-haves established (from frontmatter or derived)
- [ ] All truths verified with status and evidence
- [ ] All artifacts checked at all three levels
- [ ] All key links verified
- [ ] Requirements coverage assessed (if applicable)
- [ ] CONTEXT.md decisions checked against shipped artifacts (#2492 — non-blocking)
- [ ] Anti-patterns scanned and categorized
- [ ] Test quality audited (disabled tests, circular patterns, assertion strength, provenance)
- [ ] Human verification items identified
- [ ] Overall status determined
- [ ] Deferred items filtered against later milestone phases (if gaps found)
- [ ] Fix plans generated (if gaps_found after filtering)
- [ ] VERIFICATION.md created with complete report
- [ ] Results returned to orchestrator
</success_criteria>
