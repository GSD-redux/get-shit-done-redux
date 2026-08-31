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
| `target_test` | The runner-native id of the test that must fail. The observed `actual.subject` must equal it exactly. For an outside-in missing-target declaration, declare it at the granularity the runner reports the missing target against — for a compile-time or collection-time failure that is the test FILE, since a module that never imports collects no tests and so offers no single test id to select — and record `expected_failure.subject`, `target_test` and the observed `actual.subject` at that same granularity, each excluding any position suffix (line, column) the runner appends, because a position is not part of the node's identity and moves as edits leave the declaration correct. |
| `implementation_target` | The production module or symbol GREEN will create or change. Always present, so an outside-in failure that never reaches the test body is still bound to a declared production intent. Recorded for audit only: the predicate reads no field of it. |
| `expected_failure.phase` | The runner-native lifecycle phase the failure occurs in. **Open vocabulary, not an enum.** pytest's `collection`/`setup`/`call`/`teardown` are one runner's examples; a compiled language has no collection phase at all and declares `build`. The contract compares declared against observed and never validates the value against a list. |
| `expected_failure.class_or_mode` | The runner-native exception class or failure mode. Never a message substring. For a compiler, the diagnostic's own class, not its wording. |
| `expected_failure.subject` | What the failure is reported against: normally `target_test`; for an outside-in missing target, `implementation_target`. A declaration whose `expected_failure.subject` equals its `implementation_target` is an outside-in missing-target mode; there is no separate mode flag and no mode taxonomy. The predicate compares the observed subject against the plan's declared values and never routes on the observed `actual.subject` — an echo may not choose the predicate that judges it. For an outside-in declaration the declared subject is a mode marker naming production intent, not a prediction of what the runner will print: the runner reports an outside-in miss against the test file. |

`<red_contract>` is a **sibling** of `<behavior>`, never an attribute on it.

### Evidence

The RED commit carries what was observed as a Git trailer — one line of JSON with exactly six
top-level fields:

```text
red-evidence: {"command":"pytest tests/test_pricing.py::test_discount_reduces_total -q","exit_status":1,"target_test":"tests/test_pricing.py::test_discount_reduces_total","expected":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"actual":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"location":{"declared":{"file":"tests/test_pricing.py","line":8},"observed":{"file":"/srv/build/tests/test_pricing.py","line":8}}}
```

| Field | Meaning |
|---|---|
| `command` | The exact command whose run this is. The predicate reads `command` only to require a non-empty string, and still binds nothing about its content to `target_test`. |
| `exit_status` | That command's process exit status, as a JSON number — never a quoted string. A bash-assembled trailer that interpolates `"$?"` inside quotes produces a string and fails the guard; interpolate it unquoted. |
| `target_test` | The runner-native id the run was asked to produce. |
| `expected` | The declared `expected_failure`, echoed back: `phase`, `class_or_mode`, `subject`. |
| `actual` | What was observed, in the same three fields. |
| `location` | Where the failure was declared to occur and where it was observed to occur: `declared` and `observed`, each a `{file, line}` pair. Compared by `locationsAgree`, defined below. |

> `locationsAgree(declared, observed)` compares `declared.file` and `observed.file` by basename
> only, never by full path, and compares `declared.line` and `observed.line` by strict equality;
> no column ever enters the comparison, because two of the four probed runners emit none, and a
> compare-if-present rule for it would be asymmetric across ecosystems. `declared.file`/`line`
> name the INNERMOST frame the runner will report — where the failing assertion actually
> executes, not the test body's own line — so a failure raised inside a shared helper or a custom
> matcher is declared at the helper's own site. Every runner probed reports that innermost frame
> (`03-RESEARCH.md`'s node:test transcript reports `pricing.test.js:4:10`, not the test body's own
> line), and helper-based assertions are common across all four target ecosystems, so without this
> declaration rule the conjunct would block legitimate RED. `observed.file` is recorded verbatim
> from the runner's own path; the evaluator, not the trailer, normalizes it before comparing.
>
> This is a different obligation from `target_test`'s (`tdd.md:153`): a position there is excluded
> from node identity because a node's identity must survive edits across a plan's whole life, while
> `location` is not identity at all — it is the declared-versus-observed pair inside a single RED
> commit, compared minutes apart and never used as a reference afterward. `tdd.md:153` itself stays
> untouched.

Two further obligations:

- **`command` lands in permanent published Git history.** Record no credential value in any
  position — environment prefix, flag argument, URL, header — substituting the variable's
  placeholder name. Where a credential typed literally has no originating variable to name,
  substitute a bracketed descriptor of what it was, never the value.
  This is an obligation, not a pattern list, so no unlisted position leaks by omission.
- **`expected` and `target_test` are the executor's echoes, so the predicate pins both to the
  declaration before comparing anything against them.** `trailer.expected == plan.expected_failure`
  and `trailer.target_test == plan.target_test` are shared conjuncts that must hold first; only
  then do the `actual`-versus-`expected` field comparisons carry meaning. Pinning is what stops a
  mis-copied trailer from approving itself by agreeing with its own echo, and what stops a
  self-reported id from being bent to fit whatever the run produced.

No `version` field. The top-level key set must equal exactly these six, and that equality is
itself the fail-closed mechanism: a foreign or future schema fails it instead of being partly
honoured. Extending the vector is therefore a change to THIS CONTRACT, never a runtime one:
a vector carrying additional keys is not this vector and fails the equality by construction.
The residuals named under **RED Predicate** are narrowed, not closed, by the `location` conjunct
below.

### RED Predicate

`plan.target_test` and `plan.expected_failure` are the
**plan-declared** values from `<red_contract>`; every other symbol is a field of the trailer.

```text
valid_red =
  exit_status != 0
  AND trailer.expected == plan.expected_failure
  AND actual.phase == expected.phase
  AND actual.class_or_mode == expected.class_or_mode
  AND trailer.target_test == plan.target_test
  AND location.observed == location.declared
  AND actual.subject == plan.target_test
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

**One refinement**, not narrowing the shape: `actual == expected` is written out as its two
field comparisons, omitting `subject` because the predicate binds `actual.subject` to plan-declared
values instead.

The predicate applies no condition proving the target test exists; **Executor Gate
Validation** below supplies that separately by requiring the RED commit to touch the file its own
evidence reports the failure in, checked after selection rather than by filtering the search, and
it fires for every `type: tdd` plan. `gsd-core/references/execute-mvp-tdd.md` repeats the same
condition, but only under MVP+TDD, so it is not the live path on a project that sets `tdd_mode`
alone. The predicate itself cannot tell whether the target test was ever written.

What the outside-in residual admits and what it does not: it proves the run failed, at the declared phase, with the
declared class, reported against the declared test file, at the declared location, from a
declaration that pre-committed to outside-in mode. It does not prove the missing entity is the declared `implementation_target`
— that identity appears only in the diagnostic message, and this contract keeps identity out of
message text. The admitted case is narrower than before: an unrelated missing dependency in the
declared test file, at the same declared phase, the same declared class, and the same declared file
and line — a same-basename, same-line collision the `location` conjunct alone does not distinguish
from the plan's own declared failure site. Two controls compensate: **Executor Gate Validation**
requires the RED commit to touch the file its own evidence names, and `implementation_target`
stays declared, so a human or a later coded gate can compare it against the recorded `command` and
the message. Note
that this state is strictly NARROWER than the one it replaces: the outside-in residual was
previously unsatisfiable and admitted nothing at all, correctly or otherwise, so anchoring it on
the declared test file admits legitimate outside-in RED while bounding what else it lets through.

What the target-test residual admits and what it does not: it proves that the trailer's
self-reported `actual` triple and `location` agree with the plan's declaration and with each
other — the declared phase, the declared class, a subject whose id equals the declared
`target_test`, and an observed location equal to the declared one. It does NOT independently
prove that the target test was collected or executed: with `selected_count` and `target_executed`
removed (SIMP-01), no conjunct establishes execution, so a trailer whose target never ran but
whose remaining fields agree is indistinguishable from one whose target ran and failed. That
boundary is accepted deliberately — both removed fields were executor-authored inside the same
self-reported record, so neither was independent evidence — and it is pinned by the
`target-not-executed-fields-agree` evidence vector rather than left to drift.
It does not prove that the assertion which failed is the
one the plan's `<behavior>` describes, because the predicate never consumes `<behavior>` and the
`actual` triple is the finest granularity this vector has. The admitted case is narrower than
before: an unrelated assertion earlier in the body of the declared test, failing at the same
declared phase, the same declared class, and the same declared file and line — and, at a fixture
phase, an unrelated fixture crash at that same declared file and line, which the `location`
conjunct alone does not distinguish from the fixture the plan declared as the behavior under test.
The same two controls compensate: **Executor Gate Validation** requires the RED commit to touch
the file its own evidence names, and `implementation_target` stays declared for a human or a later
coded gate to compare against. These residuals remain admitted, narrower than before, on the same
terms as the outside-in
residual's: they
are one root cause with three surfaces, bound by the same declared-versus-observed collision the
`location` conjunct checks for.

One rule sits outside the predicate: `exit_status == 0` is an unexpected pass. It fails the first
conjunct, and it is neither valid RED nor an invalid RED to retry — halt the cycle. Every other way
of failing the predicate blocks GREEN.

### Outcomes

Each row is a consequence of the predicate, and each names the field that decides it.

| Outcome | Decided by | Verdict |
|---|---|---|
| Zero tests selected | `actual.phase` differs from `expected.phase` — the run reported at collection, not at the declared call-phase failure | block |
| Suite failed to collect or parse | `actual.class_or_mode` differs from `expected.class_or_mode` — a test-file `SyntaxError` is not the declared missing target, unless the declaration names that class itself, in which case the classes agree, this row does not hold, and the outside-in row below decides | block |
| Fixture or setup crashed before the target assertion | `actual.phase` differs from `expected.phase` | block |
| A different test failed | `actual.subject == plan.target_test` does not hold | block |
| Genuine target-behavior failure | every conjunct holds | authorize |
| Unrelated assertion in the target test | `location.observed` differs from `location.declared` — a different assertion failing first at the same phase and class reports a different declared-versus-observed file or line | block |
| Outside-in: the declared implementation target is missing | every conjunct holds — `actual.subject == plan.target_test` and `plan.expected_failure` is an outside-in missing-target mode | authorize |
| Unrelated missing dependency in the target test file | `location.observed` differs from `location.declared` — the subject conjunct anchors on the declared test FILE, and the location conjunct anchors further, on the declared line within it | block |
| Fixture is itself the behavior under test | `expected.phase` and `actual.phase` are both the fixture phase, and every conjunct holds | authorize |
| Unrelated fixture crash at the declared fixture phase | `location.observed` differs from `location.declared` — a fixture crash elsewhere in the target's dependency chain reports a different file or line than the one declared | block |
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
- This is an unexpected pass. The RED Contract's `halt` verdict decides it; apply it there.

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
test(08-02): add failing test for discount reducing order total

- Tests a percentage discount reduces the total
- Tests a discount larger than the total floors at zero
- Tests an absent discount leaves the total unchanged

red-evidence: {"command":"pytest tests/test_pricing.py::test_discount_reduces_total -q","exit_status":1,"target_test":"tests/test_pricing.py::test_discount_reduces_total","expected":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"actual":{"phase":"call","class_or_mode":"AssertionError","subject":"tests/test_pricing.py::test_discount_reduces_total"},"location":{"declared":{"file":"tests/test_pricing.py","line":8},"observed":{"file":"/srv/build/tests/test_pricing.py","line":8}}}

feat(08-02): implement discount reduction on order total

- Applies the discount rate to the order subtotal
- Returns the reduced total, floored at zero
- Handles edge cases (zero rate, discount exceeding total)

refactor(08-02): extract the discount rate to a constant (optional)

- Moved the rate to a DEFAULT_DISCOUNT_RATE constant
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

1. **Unexpected GREEN in RED phase:** an unexpected pass. The RED Contract's `halt` verdict decides it; apply it there.
2. **Missing RED commit:** If no `test(...)` commit precedes the `feat(...)` commit, the TDD discipline was violated. Flag in SUMMARY.md.
3. **REFACTOR breaks tests:** Undo the refactor immediately. Commit was premature — refactor in smaller steps.

### Executor Gate Validation

After completing a `type: tdd` plan, the executor validates the git log:
```bash
STATUS=0
TAB=$(printf '\t')
# Check for the RED gate commit and read its red-evidence: trailer in ONE pass.
# Each candidate is formatted once as SHA<TAB>trailer<TAB>subject, so a single
# grep expresses the whole selection rule; git logs newest-first, so -m1
# selects the newest candidate that is plan-scoped by SUBJECT alone — the
# trailer field is not part of selection, only of the verdict judged below.
RED_RECORD=$(git log --format='%H%x09%(trailers:key=red-evidence,valueonly,separator=%x20)%x09%s' \
  | grep -m1 -E "^[0-9a-f]+${TAB}[^${TAB}]*${TAB}test\(${PHASE}-${PLAN}\):" || true)
RED_SHA=$(printf '%s' "$RED_RECORD" | cut -d"$TAB" -f1 || true)
if [ -z "$RED_SHA" ]; then
  echo "missing_red_commit"
  STATUS=1
else
  RED_TRAILER=$(printf '%s\n' "$RED_RECORD" | cut -d"$TAB" -f2 || true)
  printf '%s\n' "$RED_TRAILER"
  if [ -z "$RED_TRAILER" ]; then
    # The two RED failures need different remedies, so they stay distinct.
    echo "matching test(${PHASE}-${PLAN}) commits exist but none carries a red-evidence: trailer — amend the trailer onto the commit you already made"
    STATUS=1
  else
    # Ask the evidence which file it named, never the path's shape: `tests/`
    # and `.test.`/`.spec.` are JS and pytest conventions, and a rule built on
    # them rejects Go (`*_test.go`), Rust (`#[test]` inline) and R outright.
    DECLARED=$(printf '%s' "$RED_TRAILER" | sed -n 's/.*"declared":{"file":"\([^"]*\)".*/\1/p')
    if [ -z "$DECLARED" ]; then
      # Fail closed: unreadable evidence is never authorization.
      echo "the RED commit $RED_SHA carries evidence naming no declared file"
      STATUS=1
    fi
  fi
fi
# Check for GREEN gate commit — GATED: `### Gate Definitions` marks GREEN
# `Required | Yes`, and this block runs only after the plan COMPLETES.
GREEN_HIT=$(git log --format='%H %s' | grep -m1 -E "^[0-9a-f]+ feat\(${PHASE}-${PLAN}\):" || true)
if [ -z "$GREEN_HIT" ]; then
  echo "missing GREEN gate: no feat(${PHASE}-${PLAN}) commit — the plan completed without one"
  STATUS=1
fi
# Check for optional REFACTOR gate commit
REFACTOR_HIT=$(git log --format='%H %s' | grep -m1 -E "^[0-9a-f]+ refactor\(${PHASE}-${PLAN}\):" || true)
[ -n "$REFACTOR_HIT" ] || echo "no refactor(${PHASE}-${PLAN}) commit — REFACTOR is optional and its absence is not a violation"
exit "$STATUS"
```

Every search matches the commit **subject**, never the message body: a commit that quotes a `test(...)` subject in its body would otherwise match, and since git logs newest-first the decoy would be selected over the real RED commit.

**This block is illustrative, and it does not check membership at all.** Whether the RED commit actually touches the file its evidence declares is decided in exactly one place: `task.red-evidence-verdict` (`changedFilesInclude`, `src/task-command-router.cts`), which the task-scoped gate in `execute-phase.md` calls. Read this block for the shape of the gate, never as a second specification of what membership admits.

The two RED failures are distinct. No commit whose subject matches `test({phase}-{plan}):` is `missing_red_commit` — there is nothing to read. A matching commit whose `red-evidence:` trailer value comes back empty is a missing RED gate — the commit exists but was made without evidence. Judging the trailer's contents against the RED Predicate **is** mechanised: the gate passes the trailer to `gsd_run query task.red-evidence-verdict` and proceeds only on verdict `authorize`. Any other verdict — `red_commit_not_failing`, `unexpected_pass` — trips the gate under the verdict's own name. Existence of a subject-matching commit authorizes nothing on its own. The predicate is in **RED Contract** above.

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
