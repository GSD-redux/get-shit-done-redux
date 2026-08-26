
/**
 * Remediation binding-ness across the revision contract (#3771).
 *
 * The remediation channel used to fuse "what property failed" with "how to fix it"
 * into a single `fix_hint` and never said which half binds. The checker rendered
 * every hint under a "must fix" heading, the orchestrators injected the issues
 * verbatim and ordered targeted updates, and the shared revision references mapped
 * each hint to a prescriptive strategy. A contract-following planner therefore
 * applied a hint literally even when a smaller mechanism satisfied the same
 * property, or when the hint contradicted a locked decision — with no channel to
 * report the conflict, and each attempt burning a revision iteration.
 *
 * ## What this suite locks
 *
 * The separation, at every link in the chain that carries it:
 *   - checker side  — `required_property` + evidence + severity bind; `fix_hint` is
 *     marked non-binding, including in the human-facing blocker rendering
 *   - planner side  — constraints are re-checked before editing, a smaller
 *     mechanism counts as addressing, and conflicts return `REVISION_CONFLICT`
 *   - orchestrators — the conflict is routed to the user or to the configured
 *     convergence loop WITHOUT consuming retry budget
 *   - field naming  — the generic pattern and the plan-checker schema agree on
 *     `fix_hint`; `suggested_fix` is retired
 *
 * It also pins what must NOT have been weakened: blockers still block, severity
 * still gates, the iteration caps and stall escalation still fire.
 *
 * ## What it cannot prove
 *
 * That a model acts on the text. The subject is a set of LLM prompts; no test in
 * this repo can prove behavior for the checker's other dimensions either. Stated so
 * the coverage claim is honest rather than implied.
 *
 * Multi-line phrases are asserted against a whitespace-normalized copy (`flat`), which
 * is CRLF-tolerant and survives a re-wrap of the same words — the runtime loads these
 * files whole, including on a checkout that produced CRLF.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

/**
 * Collapse every whitespace run to one space. Multi-line phrases are asserted against
 * this form so a re-wrap of the prose — which changes nothing the runtime reads — cannot
 * red the suite, while the words themselves stay pinned. CRLF folds out here too.
 */
const flat = (content) => content.replace(/\s+/g, ' ');

const PLAN_CHECKER = read('agents', 'gsd-plan-checker.md');
const UI_CHECKER = read('agents', 'gsd-ui-checker.md');
const PLANNER_REVISION = read('gsd-core', 'references', 'planner-revision.md');
const REVISION_LOOP = read('gsd-core', 'references', 'revision-loop.md');
const FEW_SHOT = read('gsd-core', 'references', 'few-shot-examples', 'plan-checker.md');
const PLAN_PHASE = read('gsd-core', 'workflows', 'plan-phase.md');
const QUICK_LOOP = read('gsd-core', 'workflows', 'quick', 'steps', 'plan-checker-loop.md');
const UI_PHASE = read('gsd-core', 'workflows', 'ui-phase.md');
const DIAGNOSE = read('gsd-core', 'workflows', 'diagnose-issues.md');
const CONVERGENCE = read('gsd-core', 'workflows', 'plan-review-convergence.md');

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Every fenced YAML issue example that names a `fix_hint`. Each block is returned
 * whole so an assertion can check the two fields co-occur rather than merely both
 * existing somewhere in the file.
 */
function yamlIssueBlocks(content) {
  return content
    .split(/```/)
    // `[>\s]*` not `\s*`: the few-shot file blockquotes its YAML (`>     fix_hint:`), so an
    // indent-only anchor matched nothing there and every loop over it ran zero times.
    .filter((block) => /(^|\r?\n)[>\s]*fix_hint:/.test(block));
}

// ── Checker side: binding payload vs advisory remediation ──────────

describe('#3771 checker states the property and marks the example non-binding', () => {
  test('the issue schema carries required_property and evidence, with binding-ness declared', () => {
    const schema = PLAN_CHECKER.slice(PLAN_CHECKER.indexOf('## Issue Format'));
    assert.match(schema, /required_property:.*#\s*BINDING/,
      'Issue Format must declare required_property as the binding invariant');
    assert.match(schema, /description:.*#\s*BINDING.*evidence/i,
      'Issue Format must declare description as the binding evidence field');
    assert.match(schema, /fix_hint:.*#\s*NON-BINDING/,
      'Issue Format must declare fix_hint as non-binding');
  });

  test('a smaller mechanism reaching the same property counts as addressing the issue', () => {
    assert.match(
      PLAN_CHECKER,
      /smaller or different mechanism has addressed the issue in full/,
      'the checker must concede that a smaller valid mechanism fully addresses the issue'
    );
  });

  test('the checker is forbidden from authoring a hint it can see conflicts', () => {
    assert.match(
      flat(PLAN_CHECKER),
      /Never author a `fix_hint` you can see contradicts a locked decision, a CLAUDE\.md convention, or an active capability constraint/,
      'the checker must not emit remediation that contradicts a constraint it can see'
    );
  });

  test('every YAML issue example carries required_property alongside its fix_hint', () => {
    const blocks = yamlIssueBlocks(PLAN_CHECKER);
    assert.ok(blocks.length >= 15, `expected the dimension examples to be present, found ${blocks.length}`);
    for (const block of blocks) {
      assert.match(
        block,
        /(^|\r?\n)[>\s]*required_property:/,
        `issue example names fix_hint but no required_property:\n${block.trim().slice(0, 240)}`
      );
    }
  });

  test('the blocker rendering names the property, not the example, as what must be fixed', () => {
    assert.match(
      PLAN_CHECKER,
      /### Blockers — these properties must hold \("must fix" is the property, never the example\)/,
      '"must fix" must unambiguously refer to the required property'
    );
    assert.match(PLAN_CHECKER, /- Evidence: \{description\}/,
      'the blocker rendering must surface the evidence');
    assert.match(
      PLAN_CHECKER,
      /- Example fix \(non-binding — any mechanism reaching the property counts\): \{fix_hint\}/,
      'the blocker rendering must label the hint non-binding at the point of display'
    );
    assert.doesNotMatch(PLAN_CHECKER, /(^|\r?\n)- Fix: \{fix_hint\}/,
      'the bare "Fix: {fix_hint}" rendering reads as a prescription and must be gone');
  });

  test('the adversarial stance requires the property and evidence, not just severity', () => {
    assert.match(
      flat(PLAN_CHECKER),
      /Neither are issues without a `required_property`/,
      'a missing required_property must invalidate the finding the same way a missing severity does'
    );
  });

  test('the success checklist gates on the binding/advisory split', () => {
    assert.match(
      flat(PLAN_CHECKER),
      /binding `required_property` \+ evidence \+ severity, with `fix_hint` rendered as a non-binding example/,
      'success_criteria must require the split, or the checker is never told to produce it'
    );
  });

  test('the calibration examples model the split and a smaller-alternative acceptance', () => {
    assert.doesNotMatch(FEW_SHOT, /suggested_fix|(^|\n)>?\s*finding:|affected_field/,
      'few-shot examples must use the plan-checker schema field names, not the drifted ones');
    const fewShotBlocks = yamlIssueBlocks(FEW_SHOT);
    assert.ok(fewShotBlocks.length >= 3,
      `expected the few-shot issue examples to be found, got ${fewShotBlocks.length} — ` +
      'a zero here means the block filter stopped matching, not that the file is clean');
    for (const block of fewShotBlocks) {
      assert.match(block, /(^|\r?\n)[>\s]*required_property:/,
        `few-shot issue example lacks required_property:\n${block.trim().slice(0, 200)}`);
    }
    assert.match(FEW_SHOT, /Planner satisfies the property through a smaller mechanism than the hint/,
      'a positive example proving a smaller alternative is acceptable must exist');
    assert.match(FEW_SHOT, /REVISION_CONFLICT/,
      'the calibration file must show the conflict route as the alternative to literal application');
  });
});

// ── Planner side: re-check, smaller alternative, conflict channel ───

describe('#3771 revision re-checks constraints and has a conflict path', () => {
  test('constraints are re-read before any edit', () => {
    assert.match(PLANNER_REVISION, /### Step 2\.5: Constraint Re-check \(before any edit\)/);
    const step = PLANNER_REVISION.slice(PLANNER_REVISION.indexOf('### Step 2.5'));
    assert.match(step, /Locked decisions in CONTEXT\.md/, 'locked decisions must be re-checked');
    assert.match(step, /capability \/ project guidance/i, 'capability guidance must be re-checked');
    assert.match(step, /Constraints the existing plans already encode/, 'plan constraints must be re-checked');
  });

  test('binding-ness of each field is stated to the planner', () => {
    assert.match(PLANNER_REVISION, /\*\*What binds and what does not\.\*\*/);
    assert.match(flat(PLANNER_REVISION), /`fix_hint` is \*\*one example\*\*/,
      'the planner must be told the hint is an example');
    assert.match(
      flat(PLANNER_REVISION),
      /Never treat the absence of the field as licence to apply `fix_hint` literally/,
      'an older checker return without required_property must not fall back to literal application'
    );
  });

  test('a smaller sufficient mechanism is preferred and reported as addressed', () => {
    assert.match(PLANNER_REVISION, /\*\*Prefer the smallest sufficient mechanism\.\*\*/);
    assert.match(flat(PLANNER_REVISION), /must be reported as addressed, naming the property satisfied and the mechanism used/);
  });

  test('conflicts return REVISION_CONFLICT carrying conflicts and alternatives', () => {
    assert.match(PLANNER_REVISION, /## REVISION_CONFLICT/);
    const block = PLANNER_REVISION.slice(PLANNER_REVISION.indexOf('### Step 7b'));
    assert.match(block, /### Alternatives Considered/, 'the conflict must carry alternatives');
    assert.match(block, /Conflicts with/, 'the conflict must name what it conflicts with');
    assert.match(block, /it does not count as a failed revision iteration/,
      'a conflict must not consume retry budget');
  });

  test('the completion checklist accepts a smaller mechanism and rejects conflicting application', () => {
    const checklist = PLANNER_REVISION.slice(PLANNER_REVISION.indexOf('### Step 5: Validate Changes'));
    assert.match(checklist, /smaller\/different mechanism \(both count as addressed\)/);
    assert.match(checklist, /No `fix_hint` applied that contradicts a locked decision/);
    assert.doesNotMatch(checklist, /- \[ \] All flagged issues addressed\r?\n/,
      'the old "all flagged issues addressed" line implies literal application and must be replaced');
  });
});

// ── Generic pattern: naming reconciled, literal-application removed ─

describe('#3771 generic revision pattern carries the same separation', () => {
  test('the field list matches the plan-checker schema', () => {
    assert.match(flat(REVISION_LOOP), /`plan`, `dimension`, `severity`, `required_property`, `description`, `task`, `fix_hint`/,
      'the generic pattern must advertise exactly the plan-checker schema');
    assert.doesNotMatch(
      REVISION_LOOP,
      /affected_field, suggested_fix|dimension, severity, finding/,
      'the generic pattern must not advertise fields the checker never emits'
    );
    assert.match(flat(REVISION_LOOP), /There is no `suggested_fix` field/,
      'the retired name must be called out so a reader of an old prompt is not confused');
  });

  test('BLOCKERs are satisfied by property, not by literal application of the hint', () => {
    assert.doesNotMatch(REVISION_LOOP, /For each BLOCKER: make the required change/,
      '"make the required change" orders the example applied and must be gone');
    assert.match(REVISION_LOOP, /For each BLOCKER: make required_property true/);
    assert.match(REVISION_LOOP, /a smaller or different mechanism that makes the same property true/);
  });

  test('the conflict return is handled before the iteration counter and stall check', () => {
    const section = REVISION_LOOP.slice(REVISION_LOOP.indexOf('### Conflict Return'));
    assert.ok(section.length > 0, 'the pattern must define a conflict return');
    assert.match(section, /has not failed and has not stalled/);
    assert.match(section, /Do NOT increment `iteration` and do NOT update `prev_issue_count`/);
    assert.match(flat(REVISION_LOOP), /The increment is step g, AFTER the producing agent returns/,
      'the canonical flow must place the increment on the return path, or the rule above is unreachable');
    assert.doesNotMatch(flat(REVISION_LOOP), /a\. iteration \+= 1/,
      'the pre-dispatch increment is the ordering defect and must be gone');
    assert.match(flat(section), /Accepting the output with the blocker still open is NOT offered here/,
      'the conflict gate must not become an early exit from a blocker');
  });

  test('an issue satisfied by a smaller mechanism counts as resolved for the loop checks', () => {
    assert.match(
      REVISION_LOOP,
      /A remediation hint is an example, not an order/,
      'the Important Notes must state the binding rule the loop depends on'
    );
  });
});

// ── Orchestrators: routing without burning retry budget ────────────

const ORCHESTRATORS = [
  ['plan-phase', PLAN_PHASE, 'iteration_count'],
  ['quick plan-checker-loop', QUICK_LOOP, 'iteration_count'],
  ['ui-phase', UI_PHASE, 'revision_count'],
];

describe('#3771 every revision orchestrator routes conflicts instead of retrying', () => {
  for (const [name, content, counter] of ORCHESTRATORS) {
    test(`${name} tells the reviser the hint is non-binding`, () => {
      assert.match(flat(content), /`fix_hint` is ONE example route to that property and is NON-BINDING/,
        `${name} must mark the remediation example non-binding in its revision prompt`);
      assert.match(flat(content), /smaller or different mechanism that makes the same property true/,
        `${name} must accept a smaller alternative`);
    });

    test(`${name} orders a constraint re-check before editing`, () => {
      assert.match(content, /Before editing, re-check/,
        `${name} must order the constraint re-check`);
      assert.match(flat(content), /would contradict one, or the property is unreachable without breaking one, do NOT apply it/,
        `${name} must forbid applying a conflicting hint`);
    });

    test(`${name} routes REVISION_CONFLICT without consuming ${counter}`, () => {
      assert.match(content, /## REVISION_CONFLICT/,
        `${name} must handle the conflict return`);
      assert.match(
        content,
        new RegExp(`[Dd]o NOT increment \`?${counter}\`?`),
        `${name} must not spend a revision iteration on an unresolvable conflict`
      );
    });

    // A counter incremented BEFORE dispatch is already spent when the conflict comes back, so
    // "do NOT increment" would be unreachable prose. The increment must sit on the return path.
    test(`${name} increments ${counter} on the return, not before dispatch`, () => {
      assert.doesNotMatch(
        flat(content),
        new RegExp(`- Increment \`${counter}\` - Re-spawn`),
        `${name} must not increment ${counter} before the reviser is dispatched`
      );
      assert.match(flat(content), new RegExp(`(returns|return) [^.]*increment \`?${counter}\`?|increment \`?${counter}\`?, then re-spawn`, 'i'),
        `${name} must increment ${counter} only once the reviser has returned`);
    });

    // The conflict gate resolves the conflict; it must not become an early exit from a blocker.
    test(`${name} does not offer accepting the output with the blocker still open`, () => {
      assert.match(
        flat(content),
        /is NOT offered here/,
        `${name} must state that accepting an unaddressed blocker is not one of the conflict options`
      );
      assert.match(flat(content), /amend the constraint/,
        `${name} must offer amending the constraint as the third resolving option`);
    });
  }

  test('plan-phase routes to convergence through the channel convergence already reads', () => {
    assert.match(PLAN_PHASE, /workflow\.plan_review_convergence/,
      'plan-phase must consult the convergence config');
    assert.match(flat(PLAN_PHASE), /REVIEWS\.md` under `## Plan-Revision Conflicts`/,
      'the hand-off must use REVIEWS.md rather than inventing a new mechanism');
    assert.match(flat(PLAN_PHASE), /Routing back into convergence from a run convergence itself started would be a cycle/,
      'plan-phase must not route back into the loop that invoked it');
  });

  test('convergence consumes the conflicts plan-phase records, and will not converge over them', () => {
    assert.match(CONVERGENCE, /## Plan-Revision Conflicts/,
      'the convergence loop must know about the section plan-phase writes');
    assert.match(flat(CONVERGENCE), /whose entries are not marked resolved, convergence has NOT been achieved/,
      'an open conflict must block the converged exit');
    assert.match(flat(CONVERGENCE), /Re-running the planner against an unchanged conflict cannot resolve it/,
      'the replan step must be told that re-running alone cannot clear a conflict');
  });

  test('quick does not advertise a convergence route it has no artifact for', () => {
    assert.match(flat(QUICK_LOOP), /A quick task has no REVIEWS\.md and no phase/,
      'quick must say why the convergence route does not apply, rather than dangling a dead branch');
  });

  test('the conflict is surfaced to the user with its alternatives when convergence is off', () => {
    for (const [name, content] of ORCHESTRATORS) {
      assert.match(content, /alternatives to the user/,
        `${name} must present the alternatives rather than deciding silently`);
    }
  });
});

// ── UI-spec loop and the gap-plan hint ─────────────────────────────

describe('#3771 the UI-spec and gap-plan hints are marked non-binding too', () => {
  test('the UI checker states the property and marks its hint an example', () => {
    assert.match(UI_CHECKER, /\*\*`fix_hint` is an example, never an order\.\*\*/);
    assert.match(flat(UI_CHECKER), /reaches the same property by a smaller or different mechanism has resolved the issue in full/);
    const uiBlocks = yamlIssueBlocks(UI_CHECKER);
    assert.ok(uiBlocks.length >= 6, `expected the UI dimension examples, got ${uiBlocks.length}`);
    assert.doesNotMatch(UI_CHECKER, /exact fix required/,
      'the UI verdict must not order an exact fix — that is the prescription this fix removes');
    assert.match(flat(UI_CHECKER), /- \*\*Dimension \{N\} — \{name\}:\*\* \{required_property\} Evidence: \{description\} Example fix \(non-binding/,
      'the UI ISSUES FOUND rendering must name the property, its evidence, and a non-binding example');
    for (const block of uiBlocks) {
      assert.match(block, /(^|\r?\n)[>\s]*required_property:/,
        `UI checker issue example lacks required_property:\n${block.trim().slice(0, 200)}`);
    }
  });

  test('the UI-spec revision resolves listed issues rather than applying listed fixes', () => {
    assert.doesNotMatch(UI_PHASE, /fix ONLY the listed issues/,
      '"fix ONLY the listed issues" pairs with a prescriptive hint; it must read as resolve');
    assert.match(UI_PHASE, /resolve ONLY the listed issues/);
  });

  test('the gap-plan hint is bound to the root cause, not to the suggested direction', () => {
    assert.doesNotMatch(DIAGNOSE, /- suggested_fix: Hint for gap closure plan/,
      'the gap-closure hint must not read as the binding payload');
    assert.match(DIAGNOSE, /fix_hint: NON-BINDING example route for the gap closure plan/);
    assert.match(flat(DIAGNOSE), /the binding payload is `root_cause`/);
  });
});

// ── Preservation: nothing legitimately binding was weakened ────────

describe('#3771 preserves everything that legitimately binds', () => {
  test('blockers still block and severity still gates', () => {
    assert.match(PLAN_CHECKER, /Issues without a severity classification are not valid output/);
    assert.match(PLAN_CHECKER, /\*\*blocker\*\* - The `required_property` must hold before execution/);
    assert.match(PLAN_CHECKER, /\*\*BLOCKER\*\* — the phase goal will not be achieved if this is not fixed before execution/);
  });

  test('iteration caps and stall escalation still fire', () => {
    assert.match(REVISION_LOOP, /## Pattern: Check-Revise-Escalate \(max 3 iterations\)/);
    assert.match(REVISION_LOOP, /If the count does not decrease between consecutive iterations/);
    assert.match(PLAN_PHASE, /## 12\. Revision Loop \(Max 3 Iterations\)/);
    assert.match(PLAN_PHASE, /\*\*Stall detection:\*\* If `issue_count >= prev_issue_count`/);
    assert.match(QUICK_LOOP, /\*\*Revision loop \(max 2 iterations\):\*\*/);
    assert.match(UI_PHASE, /## 9\. Revision Loop \(Max 2 Iterations\)/);
  });

  test('required task fields and decision coverage still hold', () => {
    assert.match(PLAN_CHECKER, /\*\*FAIL the verification\*\* if any requirement ID from the roadmap is absent/);
    assert.match(PLANNER_REVISION, /\*\*DO NOT:\*\* Rewrite entire plans for minor issues/);
    assert.match(REVISION_LOOP, /Do NOT introduce new issues while fixing existing ones/);
    assert.match(REVISION_LOOP, /Preserve all content not flagged by the checker/);
  });
});
