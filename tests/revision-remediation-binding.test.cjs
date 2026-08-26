
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
const VERIFY_WORK = read('gsd-core', 'workflows', 'verify-work.md');
const PLANNER = read('agents', 'gsd-planner.md');
const UI_RESEARCHER = read('agents', 'gsd-ui-researcher.md');
const CONTRACTS = read('gsd-core', 'references', 'agent-contracts.md');

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

  test('a smaller mechanism counts as addressing, and a conflicting hint is never authored', () => {
    assert.match(PLAN_CHECKER, /smaller or different mechanism has addressed the issue in full/,
      'the checker must concede that a smaller valid mechanism fully addresses the issue');
    assert.match(flat(PLAN_CHECKER), /Never author a `fix_hint` you can see contradicts/,
      'the checker must not emit remediation that contradicts a constraint it can see');
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
    // The smaller-alternative rule is NOT demonstrated here on purpose: this file is the
    // CHECKER's calibration set, fixed by tests/few-shot-calibration.test.cjs at 2 positive +
    // 2 negative, and the rule is about what the PLANNER may do with a hint. It is normative in
    // the checker and in planner-revision.md, and pinned by the assertions in this suite.
    assert.match(flat(FEW_SHOT), /because the binding payload is the property rather than the example, the planner may satisfy it a different way/,
      'the calibration commentary must still teach that the hint does not bind');
  });
});

// ── Planner side: re-check, smaller alternative, conflict channel ───

describe('#3771 revision re-checks constraints and has a conflict path', () => {
  test('constraints are re-read before any edit', () => {
    const stepAt = PLANNER_REVISION.indexOf('### Step 2.5');
    assert.ok(stepAt > 0, 'a constraint re-check step must exist before Step 3');
    const step = PLANNER_REVISION.slice(stepAt);
    assert.match(step, /Locked decisions in CONTEXT\.md/, 'locked decisions must be re-checked');
    assert.match(step, /capability \/ project guidance/i, 'capability guidance must be re-checked');
    assert.match(step, /Constraints the existing plans already encode/, 'plan constraints must be re-checked');
  });

  test('binding-ness of each field is stated to the planner', () => {
    assert.match(flat(PLANNER_REVISION), /`fix_hint` is \*\*one example\*\*/,
      'the planner must be told the hint is an example');
    assert.match(
      flat(PLANNER_REVISION),
      /Never treat the absence of the field as licence to apply `fix_hint` literally/,
      'an older checker return without required_property must not fall back to literal application'
    );
  });

  test('a smaller sufficient mechanism is preferred and reported as addressed', () => {
    assert.match(flat(PLANNER_REVISION), /must be reported as addressed, naming the property satisfied and the mechanism used/);
  });

  // A marker four workflows dispatch on must be declared and emitted where the agent is
  // defined, not only in the shared reference — otherwise nothing produces what they match.
  test('the producing agents declare and emit REVISION_CONFLICT', () => {
    for (const [name, agent] of [['gsd-planner', PLANNER], ['gsd-ui-researcher', UI_RESEARCHER]]) {
      assert.match(agent, /```markdown\r?\n## REVISION_CONFLICT/,
        `${name} must emit the marker in-fence, or check:contract-drift reports an orphan consumer`);
    }
    const plannerRow = CONTRACTS.split(/\r?\n/).find((l) => l.startsWith('| gsd-planner |'));
    const uiRow = CONTRACTS.split(/\r?\n/).find((l) => l.startsWith('| gsd-ui-researcher |'));
    assert.ok(plannerRow && uiRow, 'both registry rows must exist');
    for (const [name, row] of [['gsd-planner', plannerRow], ['gsd-ui-researcher', uiRow]]) {
      assert.match(row, /`## REVISION_CONFLICT`/, `${name}'s registry row must declare the marker`);
    }
    for (const consumer of ['quick/steps/plan-checker-loop.md', 'verify-work.md']) {
      assert.ok(plannerRow.includes(consumer),
        `gsd-planner's Consumed by must list ${consumer} — it dispatches on the marker`);
    }
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
    assert.match(flat(section), /Do NOT increment the iteration counter and do NOT update `prev_issue_count`/);
    assert.match(flat(REVISION_LOOP), /The increment is step g, AFTER the producing agent returns/,
      'the canonical flow must place the increment on the return path, or the rule above is unreachable');
    assert.doesNotMatch(flat(REVISION_LOOP), /a\. iteration \+= 1/,
      'the pre-dispatch increment is the ordering defect and must be gone');
    assert.match(flat(section), /Accepting the output with the blocker still open is NOT offered here/,
      'the conflict gate must not become an early exit from a blocker');
  });

  test('the shared contract does not describe a hand-off that no workflow performs', () => {
    assert.match(flat(REVISION_LOOP), /recording is in addition to asking, never instead of it/,
      'after #3771 round 2 no workflow hands a conflict to a loop and returns');
    assert.doesNotMatch(flat(REVISION_LOOP), /it may route there instead of asking directly/,
      'the superseded routing description must not survive as drift');
  });

  // The conflict text is agent-authored and lands in a file scanned by heading. Verified by
  // hand before this was written: 3 open conflicts, awk returned 2, because one conflict's text
  // began a `## ` line and ended the scan. That is a fail-OPEN — convergence over a live blocker.
  test('agent-authored conflict text is sanitized at the write boundary', () => {
    assert.match(flat(REVISION_LOOP), /Sanitize before writing — the conflict text is agent-authored/,
      'the shared protocol must sanitize where the untrusted text enters the file');
    assert.match(flat(REVISION_LOOP), /collapse every newline and tab to a single space, and strip any leading `#`/,
      'the rule must name the exact transform, or it is advice rather than a control');
    assert.match(flat(REVISION_LOOP), /it fails OPEN, the dangerous direction/,
      'the failure direction must be stated so nobody relaxes this later');
    assert.match(flat(PLAN_PHASE), /Sanitize each agent-authored field before appending/,
      'the workflow that does the appending must carry the rule, not only the reference');
    for (const [name, agent] of [['planner-revision', PLANNER_REVISION], ['gsd-ui-researcher', UI_RESEARCHER]]) {
      assert.match(flat(agent), /\*\*Every field is one line of plain text\.\*\*/,
        `${name} must forbid the shapes the writer would otherwise have to strip`);
    }
    assert.match(flat(CONVERGENCE), /This scan stops at the next `## `, so it is only sound because the writer sanitizes/,
      'the reader must state the invariant it depends on, or a future edit silently breaks it');
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
  // verify-work's gap-plan revision hands <revision_context> to gsd-planner, so it inherits the
  // contract whether or not it states it. It was missed in the first pass (#3771 round-2 review).
  ['verify-work gap-plan revision', VERIFY_WORK, 'iteration_count'],
];

describe('#3771 every revision orchestrator routes conflicts instead of retrying', () => {
  // plan-phase @-imports revision-loop.md, so the shared Conflict Return protocol really is in
  // its loaded context and it states only its own bindings. The other three do not import it and
  // must carry the rules inline. `loadedFor` is what the runtime actually puts in front of each
  // orchestrator — the honest surface to assert a shared rule against.
  const importsShared = (content) => /@~\/\.claude\/gsd-core\/references\/revision-loop\.md/.test(content);
  const loadedFor = (content) => (importsShared(content) ? flat(content + '\n' + REVISION_LOOP) : flat(content));

  test('plan-phase delegates the shared protocol rather than duplicating it', () => {
    assert.ok(importsShared(PLAN_PHASE), 'plan-phase must @-import the reference it defers to');
    assert.match(flat(PLAN_PHASE), /follow the shared Conflict Return protocol in `gsd-core\/references\/revision-loop\.md`/,
      'the delegation must be explicit, or the bindings have no protocol to bind to');
  });

  for (const [name, content, counter] of ORCHESTRATORS) {
    const loaded = loadedFor(content);

    test(`${name} tells the reviser the hint is non-binding`, () => {
      assert.match(loaded, /`fix_hint` is ONE non-binding example route/,
        `${name} must mark the remediation example non-binding in its revision prompt`);
      assert.match(loaded, /smaller or different mechanism reaching the same property/,
        `${name} must accept a smaller alternative`);
    });

    test(`${name} orders a constraint re-check before editing`, () => {
      assert.match(loaded, /BEFORE editing/,
        `${name} must order the constraint re-check before any edit`);
      assert.match(loaded, /return `## REVISION_CONFLICT` with the conflict and\s+the alternatives rather than applying or working around it/,
        `${name} must forbid applying a conflicting hint`);
    });

    // Four prompts state this contract; planner-revision.md is the authority they must agree
    // with. Each must name where that authority is, or the next editor updates one of five.
    test(`${name} names the authority its inline statement summarises`, () => {
      assert.match(loaded, /Full contract:\s+`gsd-core\/references\/planner-revision\.md`|see your `## Revision Conflict`\s+section/,
        `${name} must point at the contract its prompt paraphrases`);
    });

    test(`${name} routes REVISION_CONFLICT without consuming ${counter}`, () => {
      assert.match(loaded, /## REVISION_CONFLICT/,
        `${name} must handle the conflict return`);
      assert.match(
        loaded,
        new RegExp(`[Dd]o NOT increment (the iteration counter|\`?${counter}\`?)`),
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
      assert.match(loaded, new RegExp(`(returns|return) [^.]*increment \`?${counter}\`?|increment \`?${counter}\`?, then re-spawn|Counter not spent: \`${counter}\``, 'i'),
        `${name} must increment ${counter} only once the reviser has returned`);
    });

    // Not incrementing the counter removes the bound the counter provided. Something must
    // replace it, or an agent returning the same conflict forever loops unattended.
    // Two bounds, because one is evadable: an agent alternating property names never trips the
    // repeat rule, so the repeat rule alone leaves the un-incremented path unbounded.
    test(`${name} bounds conflict recurrence so the un-incremented path cannot spin`, () => {
      assert.match(
        loaded,
        /same `required_property` (a second time in a row|twice in a row)/i,
        `${name} must detect a repeated conflict rather than re-spawning forever`
      );
      assert.match(
        loaded,
        /THIRD conflict return of this loop whatever property it names/,
        `${name} must cap TOTAL conflict returns — round-robin across property names evades the repeat rule`
      );
    });

    // The conflict gate resolves the conflict; it must not become an early exit from a blocker.
    test(`${name} re-evaluates a second conflict instead of falling through to the checker`, () => {
      assert.match(
        loaded,
        /re-evaluate (its|the [a-z]+'s|the) return (from the top of this handler|here)|return to this step/,
        `${name} must loop back on the re-spawn, not fall through to the checker spawn`
      );
    });

    test(`${name} does not offer accepting the output with the blocker still open`, () => {
      assert.match(
        loaded,
        /is NOT offered here/,
        `${name} must state that accepting an unaddressed blocker is not one of the conflict options`
      );
      assert.match(loaded, /amend the constraint/,
        `${name} must offer amending the constraint as the third resolving option`);
    });
  }

  test('plan-phase records the conflict on a channel it can actually test for', () => {
    assert.match(PLAN_PHASE, /workflow\.plan_review_convergence/,
      'plan-phase must consult the convergence config');
    assert.match(flat(PLAN_PHASE), /REVIEWS_FILE=\$\(ls "\$\{PHASE_DIR\}"\/\*-REVIEWS\.md/,
      'the record branch must be gated on a condition the orchestrator can evaluate at runtime');
    assert.match(flat(PLAN_PHASE), /plan-phase wrote the line, so plan-phase closes it/,
      'closure must have exactly one named owner, or a line can be orphaned open');
    assert.match(flat(REVISION_LOOP), /never invokes `\/gsd:plan-review-convergence`/,
      'plan-phase runs inside that loop; invoking it would be a cycle');
    // A markdown table cannot be counted by any simple filter — its header and separator rows
    // look like data. The recorded shape must be one the reader can match exactly.
    assert.match(flat(REVISION_LOOP), /A checkbox, not a table row/,
      'the recorded conflict must be countable without parsing a table');
    assert.match(REVISION_LOOP, /- \[ \] \{dimension\}\/\{plan\} — required_property:/,
      'the shared protocol must define the open form the convergence gate matches');
    assert.match(flat(REVISION_LOOP), /owns flipping it to `- \[x\]`/,
      'the close step must produce the resolved form the gate excludes');
  });

  test('convergence gates on the conflicts BEFORE it writes state or prints success', () => {
    assert.match(CONVERGENCE, /## Plan-Revision Conflicts/,
      'the convergence loop must know about the section plan-phase writes');
    assert.match(CONVERGENCE, /OPEN_CONFLICTS=/,
      'the count must be read from REVIEWS.md — CYCLE_SUMMARY does not carry it');
    // The counter and the writer must agree on the marker, or every resolved conflict reads as
    // open and the loop deadlocks instead of converging.
    assert.match(CONVERGENCE, /\/\^- \\\[ \\\]\//,
      'the gate must count exactly the open-checkbox form plan-phase writes');
    assert.doesNotMatch(CONVERGENCE, /grep -c '\^\| '/,
      'counting table rows would include the header and separator and never reach zero');
    assert.match(flat(CONVERGENCE), /escalates rather than deadlocking/,
      'the gate must state that an unresolvable conflict still terminates at MAX_CYCLES');
    assert.match(
      CONVERGENCE,
      /\*\*If HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0 and OPEN_CONFLICTS == 0 \(converged\):\*\*/,
      'an open conflict must be part of the converged CONDITION, not a note after the banner'
    );
    // Ordering is the whole finding: the gate placed after `state planned-phase` would write
    // and announce convergence over a conflict nobody resolved.
    const gateAt = CONVERGENCE.indexOf('OPEN_CONFLICTS=$(awk');
    const writeAt = CONVERGENCE.indexOf('gsd_run state planned-phase');
    const bannerAt = CONVERGENCE.indexOf('GSD ► CONVERGENCE COMPLETE');
    assert.ok(gateAt > 0 && writeAt > 0 && bannerAt > 0, 'all three anchors must exist');
    assert.ok(gateAt < writeAt, 'the conflict gate must precede the planned-phase state write');
    assert.ok(gateAt < bannerAt, 'the conflict gate must precede the convergence banner');
    assert.match(flat(CONVERGENCE), /Re-running the planner against an unchanged conflict cannot resolve it/,
      'the replan step must be told that re-running alone cannot clear a conflict');
  });

  test('quick does not advertise a convergence route it has no artifact for', () => {
    assert.match(flat(QUICK_LOOP), /A quick task has no REVIEWS\.md and no phase/,
      'quick must say why the convergence route does not apply, rather than dangling a dead branch');
  });

  test('the conflict is surfaced to the user with its alternatives', () => {
    for (const [name, content] of ORCHESTRATORS) {
      assert.match(loadedFor(content), /alternatives to the user|conflict and its alternatives to the user/,
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
