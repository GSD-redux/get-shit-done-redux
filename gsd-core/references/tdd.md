<overview>
TDD is about design quality, not coverage metrics. The red-green-refactor cycle forces you to think about behavior before implementation, producing cleaner interfaces and more testable code.

**Principle:** If you can describe the behavior as `expect(fn(input)).toBe(output)` before writing `fn`, TDD improves the result.

**Key insight:** TDD work is fundamentally heavier than standard tasks—it requires 2-3 execution cycles (RED → GREEN → REFACTOR), each with file reads, test runs, and potential debugging. TDD features get dedicated plans to ensure full context is available throughout the cycle.
</overview>

<when_to_use_tdd>
## When TDD Improves Quality

**TDD candidates (create a TDD plan):**
- Business logic with defined inputs/outputs
- API endpoints with request/response contracts
- Data transformations, parsing, formatting
- Validation rules and constraints
- Algorithms with testable behavior
- State machines and workflows
- Utility functions with clear specifications

**Skip TDD (use standard plan with `type="auto"` tasks):**
- UI layout, styling, visual components
- Configuration changes
- Glue code connecting existing components
- One-off scripts and migrations
- Simple CRUD with no business logic
- Exploratory prototyping

**Heuristic:** Can you write `expect(fn(input)).toBe(output)` before writing `fn`?
→ Yes: Create a TDD plan
→ No: Use standard plan, add tests after if needed
</when_to_use_tdd>

<tdd_plan_structure>
## TDD Plan Structure

Each TDD plan implements **one feature** through the full RED-GREEN-REFACTOR cycle.

```markdown
---
phase: XX-name
plan: NN
type: tdd
---

<objective>
[What feature and why]
Purpose: [Design benefit of TDD for this feature]
Output: [Working, tested feature]
</objective>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@relevant/source/files.ts
</context>

<feature>
  <name>[Feature name]</name>
  <files>[source file, test file]</files>
  <behavior>
    [Expected behavior in testable terms]
    Cases: input → expected output
  </behavior>
  <red_contract>
    <target_test>[Runner-native id of the test that must fail]</target_test>
    <implementation_target>[Production module or symbol GREEN will create]</implementation_target>
    <expected_failure>
      <phase>[Runner-native lifecycle phase the failure occurs in]</phase>
      <class_or_mode>[Runner-native exception class or failure mode]</class_or_mode>
      <subject>[What the failure is reported against]</subject>
    </expected_failure>
  </red_contract>
  <implementation>[How to implement once tests pass]</implementation>
</feature>

<verification>
[Test command that proves feature works]
</verification>

<success_criteria>
- Failing test written and committed
- Implementation passes test
- Refactor complete (if needed)
- All 2-3 commits present
</success_criteria>

<output>
After completion, create SUMMARY.md with:
- RED: What test was written, why it failed
- GREEN: What implementation made it pass
- REFACTOR: What cleanup was done (if any)
- Commits: List of commits produced
</output>
```

`<red_contract>` is a sibling of `<behavior>`, never an attribute on it. Its five field meanings,
and the predicate that judges the run against them, are in `<red_contract_spec>` below.

**One feature per TDD plan.** If features are trivial enough to batch, they're trivial enough to skip TDD—use a standard plan and add tests after.
</tdd_plan_structure>

<execution_flow>
## Red-Green-Refactor Cycle

**RED - Write failing test:**
1. Create test file following project conventions
2. Write test describing expected behavior (from `<behavior>` element)
3. Run test - it MUST fail
4. For `tdd="true"` tasks the failure must additionally satisfy the RED Predicate in
   `<red_contract_spec>` below, and the RED commit carries the `red-evidence:` trailer
5. If test passes: feature exists or test is wrong. Investigate.
6. Commit: `test({phase}-{plan}): add failing test for [feature]`

**GREEN - Implement to pass:**
1. Write minimal code to make test pass
2. No cleverness, no optimization - just make it work
3. Run test - it MUST pass
4. Commit: `feat({phase}-{plan}): implement [feature]`

**REFACTOR (if needed):**
1. Clean up implementation if obvious improvements exist
2. Run tests - MUST still pass
3. Only commit if changes made: `refactor({phase}-{plan}): clean up [feature]`

**Result:** Each TDD plan produces 2-3 atomic commits.
</execution_flow>

<red_contract_spec>
## RED Contract

RED is not "the command exited non-zero". A collection error, a crashed fixture and an unrelated
failing test all exit non-zero, and a legitimate outside-in RED that never reaches the test body
looks identical to all three. So every `tdd="true"` task declares which failure counts before the
run, and the RED commit records what was actually observed.

### Declaration

```xml
<red_contract>
  <target_test>tests/test_pricing.py::test_discount_reduces_total</target_test>
  <implementation_target>pricing.apply_discount</implementation_target>
  <expected_failure>
    <phase>call</phase>
    <class_or_mode>AssertionError</class_or_mode>
    <subject>tests/test_pricing.py::test_discount_reduces_total</subject>
  </expected_failure>
</red_contract>
```

| Field | Meaning |
|---|---|
| `target_test` | The runner-native id of the test that must fail. Matched by `id_matches`, defined under **Evidence**. |
| `implementation_target` | The production module or symbol GREEN will create. Always present, so an outside-in failure that never reaches the test body is still bound to a declared production intent. |
| `expected_failure.phase` | The runner-native lifecycle phase the failure occurs in. **Open vocabulary, not an enum.** pytest's `collection`/`setup`/`call`/`teardown` are one runner's examples; a compiled language has no collection phase at all and declares `build`. The contract compares declared against observed and never validates the value against a list. |
| `expected_failure.class_or_mode` | The runner-native exception class or failure mode. Never a message substring. For a compiler, the diagnostic's own class, not its wording. |
| `expected_failure.subject` | What the failure is reported against: normally `target_test`; for an outside-in missing target, `implementation_target`. A declaration whose `expected_failure.subject` equals its `implementation_target` is an outside-in missing-target mode; that equality is the definition the predicate's second arm tests, and there is no separate mode flag and no mode taxonomy. The predicate compares the observed subject against the plan's declared values and never routes on the observed `actual.subject` — an echo may not choose the arm that judges it. |

`<red_contract>` is a **sibling** of `<behavior>`, never an attribute on it.

### Evidence

The RED commit carries what was observed as a Git trailer — one line of JSON with exactly seven
top-level fields:

```text
red-evidence: {"command":"pytest tests/test_pricing.py::test_discount_reduces_total -q","exit_status":1,"target_test":"tests/test_pricing.py::test_discount_reduces_total","selected_count":1,"target_executed":true,"expected":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"actual":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"}}
```

| Field | Meaning |
|---|---|
| `command` | The exact command whose run this is. Recorded for audit only: the predicate reads no field of it, and nothing binds it to `target_test`. |
| `exit_status` | That command's process exit status. |
| `target_test` | The runner-native id the run was asked to produce. |
| `selected_count` | How many tests the run selected. |
| `target_executed` | Whether the declared target test was executed and reported — defined below. |
| `expected` | The declared `expected_failure`, echoed back: `phase`, `class_or_mode`, `subject`. |
| `actual` | What was observed, in the same three fields. |

> `target_executed` is true when some member of the run's executed-and-reported set `id_matches`
> the declared `target_test`. It does **not** mean "the test function's body ran," and it is not a
> literal membership test — a parameterized run reports only bracket-suffixed variants, and a
> literal check would block the legitimate RED that `id_matches` exists to admit.

`false` means no member of the reported set matches at all.

> `id_matches(observed, declared)` is true when `observed === declared`, or when `observed` is
> `declared` followed **immediately** by a runner-native variant delimiter opening a parametrization
> case — pytest's `[`, as in `[100-10-90]`. A bare prefix with no delimiter is not a match, so
> `test_discount` never matches `test_discount_v2`.

`id_matches` applies to the target-test arm only; the implementation-target arm keeps exact
equality, because a symbol name is never a near-miss.

Two further obligations:

- **`command` lands in permanent published Git history.** Record no credential value in any
  position — environment prefix, flag argument, URL, header — substituting the variable's
  placeholder name. This is an obligation, not a pattern list, so no unlisted position leaks by
  omission.
- **`expected` and `target_test` are the executor's echoes, so the predicate pins both to the
  declaration before comparing anything against them.** `trailer.expected == plan.expected_failure`
  and `trailer.target_test == plan.target_test` are shared conjuncts that must hold first; only
  then do the `actual`-versus-`expected` field comparisons carry meaning. Pinning is what stops a
  mis-copied trailer from approving itself by agreeing with its own echo, and what stops a
  self-reported id from being bent to fit whatever the run produced.

No `version` field. The top-level key set must equal exactly these seven, and that equality is
itself the fail-closed mechanism: a foreign or future schema fails it instead of being partly
honoured.

### RED Predicate

`plan.target_test`, `plan.implementation_target` and `plan.expected_failure` are the
**plan-declared** values from `<red_contract>`; every other symbol is a field of the trailer.
`AND` binds tighter than `OR`, so the parenthesised group is exactly two arms.

```text
valid_red =
  exit_status != 0
  AND trailer.expected == plan.expected_failure
  AND actual.phase == expected.phase
  AND actual.class_or_mode == expected.class_or_mode
  AND trailer.target_test == plan.target_test
  AND (
    selected_count > 0
    AND target_executed
    AND id_matches(actual.subject, plan.target_test)
    OR
    actual.subject == plan.implementation_target
    AND plan.expected_failure is an outside-in missing-target mode
  )
```

This file is the block's only source. Reproduce it character-for-character wherever it is quoted:
every paraphrase of it so far has silently dropped a conjunct.

**`trailer.expected == plan.expected_failure`** and **`trailer.target_test == plan.target_test`**
are the pinning pair that binds the trailer's `expected` and `target_test` echoes to the
declaration. They shipped commented out at first, deferred to Phase 3 on the grounds that no plan
object is held at predicate time. That deferral is withdrawn: both reference only
`plan.expected_failure` and `plan.target_test`, symbols the parenthesised group below already
consumes, so deferring them introduced no plan-side input Phase 3 did not already require — while
leaving the `actual`-versus-`expected` comparisons above them as a self-comparison of the trailer
against its own echo.

**Two refinements**, neither narrowing the shape: `actual == expected` is written out as its two
field comparisons, omitting `subject` because the arms bind `actual.subject` to plan-declared
values instead; and the target arm's `actual.subject == plan.target_test` becomes
`id_matches(...)`.

`selected_count` and `target_executed` are conditions of the target-test arm **only**: an
outside-in RED fails before its target test is ever collected, so it reports 0 and false by
construction, and hoisting those two above the disjunction blocks exactly the case the outside-in
arm exists to admit. The arm applies no condition proving the target test exists; the MVP+TDD gate
supplies that separately by requiring the RED commit to touch a test file, per
`gsd-core/references/execute-mvp-tdd.md`, because the predicate alone cannot tell whether the
target test was ever written.

One rule sits outside the predicate: `exit_status == 0` is an unexpected pass. It fails the first
conjunct, and it is neither valid RED nor an invalid RED to retry — halt the cycle. Every other way
of failing the predicate blocks GREEN.

### Outcomes

Each row is a consequence of the predicate, and each names the field that decides it.

| Outcome | Decided by | Verdict |
|---|---|---|
| Zero tests selected | the target-test arm's `selected_count` is 0, and no failure is anchored to `plan.implementation_target` | block |
| Suite failed to collect or parse | `actual.class_or_mode` differs from `expected.class_or_mode` — a test-file `SyntaxError` is not the declared missing target — and the target-test arm's `selected_count` is 0 | block |
| Fixture or setup crashed before the target assertion | `actual.phase` differs from `expected.phase` | block |
| A different test failed | neither arm holds — `actual.subject` does not `id_matches` `plan.target_test`, nor equal `plan.implementation_target` | block |
| Genuine target-behavior failure | the shared comparisons hold and the target-test arm holds | authorize |
| Outside-in: the declared implementation target is missing | `actual.subject` equals `plan.implementation_target` and `plan.expected_failure` is an outside-in missing-target mode, with no selection or execution condition applied | authorize |
| Fixture is itself the behavior under test | `expected.phase` and `actual.phase` are both the fixture phase, and the target-test arm holds | authorize |
| Unexpected pass | `exit_status` is 0 | halt |
</red_contract_spec>

<test_quality>
## Good Tests vs Bad Tests

**Test behavior, not implementation:**
- Good: "returns formatted date string"
- Bad: "calls formatDate helper with correct params"
- Tests should survive refactors

**One concept per test:**
- Good: Separate tests for valid input, empty input, malformed input
- Bad: Single test checking all edge cases with multiple assertions

**Descriptive names:**
- Good: "should reject empty email", "returns null for invalid ID"
- Bad: "test1", "handles error", "works correctly"

**No implementation details:**
- Good: Test public API, observable behavior
- Bad: Mock internals, test private methods, assert on internal state
</test_quality>

<framework_setup>
## Test Framework Setup (If None Exists)

When executing a TDD plan but no test framework is configured, set it up as part of the RED phase:

**1. Detect project type:**
```bash
# JavaScript/TypeScript
if [ -f package.json ]; then echo "node"; fi

# Python
if [ -f requirements.txt ] || [ -f pyproject.toml ]; then echo "python"; fi

# Go
if [ -f go.mod ]; then echo "go"; fi

# Rust
if [ -f Cargo.toml ]; then echo "rust"; fi
```

**2. Install minimal framework:**
| Project | Framework | Install |
|---------|-----------|---------|
| Node.js | Jest | `npm install -D jest @types/jest ts-jest` |
| Node.js (Vite) | Vitest | `npm install -D vitest` |
| Python | pytest | `pip install pytest` |
| Go | testing | Built-in |
| Rust | cargo test | Built-in |

**3. Create config if needed:**
- Jest: `jest.config.js` with ts-jest preset
- Vitest: `vitest.config.ts` with test globals
- pytest: `pytest.ini` or `pyproject.toml` section

**4. Verify setup:**
```bash
# Run empty test suite - should pass with 0 tests
npm test  # Node
pytest    # Python
go test ./...  # Go
cargo test    # Rust
```

**5. Create first test file:**
Follow project conventions for test location:
- `*.test.ts` / `*.spec.ts` next to source
- `__tests__/` directory
- `tests/` directory at root

Framework setup is a one-time cost included in the first TDD plan's RED phase.
</framework_setup>

<error_handling>
## Error Handling

**Test doesn't fail in RED phase:**
- Feature may already exist - investigate
- Test may be wrong (not testing what you think)
- Fix before proceeding

**Test doesn't pass in GREEN phase:**
- Debug implementation
- Don't skip to refactor
- Keep iterating until green

**Tests fail in REFACTOR phase:**
- Undo refactor
- Commit was premature
- Refactor in smaller steps

**Unrelated tests break:**
- Stop and investigate
- May indicate coupling issue
- Fix before proceeding
</error_handling>

<commit_pattern>
## Commit Pattern for TDD Plans

TDD plans produce 2-3 atomic commits (one per phase):

```
test(08-02): add failing test for email validation

- Tests valid email formats accepted
- Tests invalid formats rejected
- Tests empty input handling

red-evidence: {"command":"pytest tests/test_pricing.py::test_discount_reduces_total -q","exit_status":1,"target_test":"tests/test_pricing.py::test_discount_reduces_total","selected_count":1,"target_executed":true,"expected":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"actual":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"}}

feat(08-02): implement email validation

- Regex pattern matches RFC 5322
- Returns boolean for validity
- Handles edge cases (empty, null)

refactor(08-02): extract regex to constant (optional)

- Moved pattern to EMAIL_REGEX constant
- No behavior changes
- Tests still pass
```

**Comparison with standard plans:**
- Standard plans: 1 commit per task, 2-4 commits per plan
- TDD plans: 2-3 commits for single feature

Both follow same format: `{type}({phase}-{plan}): {description}`

**Benefits:**
- Each commit independently revertable
- Git bisect works at commit level
- Clear history showing TDD discipline
- Consistent with overall commit strategy
</commit_pattern>

<gate_enforcement>
## Gate Enforcement Rules

When `workflow.tdd_mode` is enabled in config, the RED/GREEN/REFACTOR gate sequence is enforced for all `type: tdd` plans.

### Gate Definitions

| Gate | Required | Commit Pattern | Validation |
|------|----------|---------------|------------|
| RED | Yes | `test({phase}-{plan}): ...` | The commit carries a `red-evidence:` trailer satisfying the RED Predicate — see **RED Contract** |
| GREEN | Yes | `feat({phase}-{plan}): ...` | Test passes after implementation |
| REFACTOR | No | `refactor({phase}-{plan}): ...` | Tests still pass after cleanup |

### Fail-Fast Rules

1. **Unexpected GREEN in RED phase:** If the test passes before any implementation code is written, STOP. The feature may already exist or the test is wrong. Investigate before proceeding.
2. **Missing RED commit:** If no `test(...)` commit precedes the `feat(...)` commit, the TDD discipline was violated. Flag in SUMMARY.md.
3. **REFACTOR breaks tests:** Undo the refactor immediately. Commit was premature — refactor in smaller steps.

### Executor Gate Validation

After completing a `type: tdd` plan, the executor validates the git log:
```bash
# Check for RED gate commit, then read its red-evidence: trailer
RED_SHA=$(git log --format='%H %s' | grep -m1 -E "^[0-9a-f]+ test\(${PHASE}-${PLAN}\):" | cut -d' ' -f1)
if [ -z "$RED_SHA" ]; then
  echo "missing_red_commit"
else
  git log -1 --format='%(trailers:key=red-evidence,valueonly)' "$RED_SHA"
fi
# Check for GREEN gate commit
git log --format='%H %s' | grep -m1 -E "^[0-9a-f]+ feat\(${PHASE}-${PLAN}\):"
# Check for optional REFACTOR gate commit
git log --format='%H %s' | grep -m1 -E "^[0-9a-f]+ refactor\(${PHASE}-${PLAN}\):"
```

Every search matches the commit **subject**, never the message body: a commit that quotes a `test(...)` subject in its body would otherwise match, and since git logs newest-first the decoy would be selected over the real RED commit.

The two RED failures are distinct. No commit whose subject matches `test({phase}-{plan}):` is `missing_red_commit` — there is nothing to read. A matching commit whose `red-evidence:` trailer value comes back empty is a missing RED gate — the commit exists but was made without evidence. Judging the trailer's contents against the RED Predicate is not yet mechanised — the coded gate is Phase 3's; until then the executor reads the trailer and reports it. The predicate is in **RED Contract** above.

If RED or GREEN gate commits are missing, add a `## TDD Gate Compliance` section to SUMMARY.md with the violation details.
</gate_enforcement>

<end_of_phase_review>
## End-of-Phase TDD Review Checkpoint

When `workflow.tdd_mode` is enabled, the execute-phase orchestrator inserts a collaborative review checkpoint after all waves complete but before phase verification.

### Review Checkpoint Format

```
### TDD REVIEW — Phase {X}

TDD Plans: {count} | Gate violations: {count}

| Plan | RED | GREEN | REFACTOR | Status |
|------|-----|-------|----------|--------|
| {id} |  ✓  |   ✓   |    ✓     | Pass   |
| {id} |  ✓  |   ✗   |    —     | FAIL   |

{If violations exist:}
⚠ Gate violations are advisory — review before advancing.
```

### What the Review Checks

1. **Gate sequence:** Each TDD plan has RED → GREEN commits in order
2. **Test quality:** RED phase tests fail for the right reason (not import errors or syntax)
3. **Minimal GREEN:** Implementation is minimal — no premature optimization in GREEN phase
4. **Refactor discipline:** If REFACTOR commit exists, tests still pass

This checkpoint is advisory — it does not block phase completion but surfaces TDD discipline issues for human review.
</end_of_phase_review>

<context_budget>
## Context Budget

TDD plans target **~40% context usage** (lower than standard plans' ~50%).

Why lower:
- RED phase: write test, run test, potentially debug why it didn't fail
- GREEN phase: implement, run test, potentially iterate on failures
- REFACTOR phase: modify code, run tests, verify no regressions

Each phase involves reading files, running commands, analyzing output. The back-and-forth is inherently heavier than linear task execution.

Single feature focus ensures full quality throughout the cycle.
</context_budget>
