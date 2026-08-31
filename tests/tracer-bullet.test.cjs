// allow-test-rule: source-text-is-the-product [#1945]
// Agent .md / workflow .md / command .md / reference .md / docs .md files —
// their text IS the deployed contract the runtime (and the changelog/docs
// surface) loads. The planner/executor "task type" enum and the tracer-first
// decomposition discipline are prose contracts, not compiled code, so the
// contract test asserts on the shipped text. The behavioral suite at the bottom
// exercises the ONE code seam (verify plan-structure) through the CLI.

/**
 * Tracer-bullet vertical slices (#1945).
 *
 * Feature: make "thin end-to-end slice first, verify, then expand" a first-class,
 * default planning + execution discipline (not an opt-in `--mvp` mode).
 *
 *   1. Planner — a first-class `tracer` task type + a tracer-first default.
 *   2. Executor — a feedback gate after the tracer slice.
 *   3. Terminology — `tracer bullet` promoted to the CONTEXT.md glossary.
 *
 * Acceptance criteria (verbatim from the issue) mapped to tests below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PLANNER = read('agents/gsd-planner.md');
const EXECUTOR = read('agents/gsd-executor.md');
const EXECUTE_PLAN = read('gsd-core/workflows/execute-plan.md');
const WORKFLOW = read('gsd-core/workflows/plan-phase.md');
const COMMAND = read('commands/gsd/plan-phase.md');
const HELP_FULL = read('gsd-core/workflows/help/modes/full.md');
const MVP_REF = read('gsd-core/references/planner-mvp-mode.md');
const CONTEXT = read('CONTEXT.md');
const COMMANDS_DOC = read('docs/COMMANDS.md');
const PLAN_MD_REF = read('docs/reference/plan-md.md');
const HOWTO = read('docs/how-to/plan-a-phase.md');
const AGENTS_DOC = read('docs/AGENTS.md');

// ─── contract parsers (typed views over the deployed prose) ──────────────────

// Isolate the planner's default-decomposition section so we can prove tracer-first
// is NOT gated behind a flag/mode conditional.
function plannerTracerSection(md) {
  const start = md.indexOf('## Tracer-First Decomposition');
  if (start === -1) return '';
  const rest = md.slice(start + 3);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? md.slice(start) : md.slice(start, start + 3 + nextHeading);
}

function parsePlannerContract(md) {
  const section = plannerTracerSection(md);
  return {
    hasTracerFirstSection: section.length > 0,
    // "default" and "not gated behind a flag" — the whole point of #1945.
    declaresDefault: /\bdefault\b/i.test(section) && /not gated behind a flag/i.test(section),
    leadsWithTracer: /LEADS with one `type="tracer"`/.test(section),
    documentsTracerTaskType: /<task type="tracer">/.test(section),
    // Production-quality, not a prototype (the book's core distinction).
    productionQualityNotPrototype:
      /production-quality, not a prototype/i.test(section) &&
      /architectural gaps are not/i.test(section),
    // A real, runnable END-TO-END verify (not a per-layer unit check).
    endToEndVerify: /END-TO-END/i.test(section) && /not a per-layer unit test/i.test(section),
    // --no-tracer / TRACER_MODE=false restores horizontal layers.
    documentsNoTracerOptOut:
      /--no-tracer/.test(section) && /TRACER_MODE=false/.test(section) && /horizontal layers/i.test(section),
    // The break_into_tasks step itself leads with the tracer by default.
    breakStepLeadsWithTracer:
      /\*\*Lead with the tracer\.\*\*/.test(md) &&
      /Unless `TRACER_MODE=false`/.test(md),
    // Composition with --tdd (tracer starts red).
    composesWithTdd: /TDD composition/i.test(section) && /starts red/i.test(section),
    // MVP is now enrichment on top, not the toggle for vertical slices.
    mvpIsEnrichment: /MVP enrichment/i.test(section) && /no longer \*turns on\* vertical slices/i.test(section),
  };
}

function parseExecutorContract(md) {
  return {
    recognizesTracerType: /\*\*If `type="tracer"`:\*\*/.test(md),
    // The gate runs BEFORE expansion tasks — an early integration checkpoint.
    earlyIntegrationGate:
      /tracer feedback gate BEFORE any expansion task/i.test(md) &&
      /early integration checkpoint/i.test(md),
    // Autonomous: halt-on-fail before any expansion task.
    // Keyed on the file's own auto-mode definition (AUTO_CHAIN or AUTO_CFG),
    // not AUTO_CFG alone — see <auto_mode_detection>.
    // #3299 B3: `gate="blocking-human"` is evaluated BEFORE the auto-mode
    // branch and binds in every mode (golden rule 6). Ordering is the whole
    // point — a chain that reached the auto branch first would auto-continue
    // past the repo's strongest gate in exactly the unattended mode where it
    // matters most, which is the defect this ordering fixes. Asserted by
    // POSITION, not presence: both clauses existing in the wrong order passes
    // any presence check and still ships the bypass.
    blockingHumanPrecedesAutoMode: (() => {
      const iGate = md.indexOf('`gate="blocking-human"` \u2192 STOP');
      const iAuto = md.indexOf('**Auto mode active**');
      return iGate > -1 && iAuto > iGate && /Every mode, auto included/i.test(md);
    })(),
    autoHaltsOnFailure:
      /\*\*Auto mode active\*\* \(`AUTO_CHAIN`\/`AUTO_CFG`/.test(md) &&
      /HALT/.test(md) &&
      /never expand/i.test(md),
    // Interactive: the branch exists and still names checkpoint:human-verify.
    interactiveHumanVerify:
      /\*\*Interactive:\*\*/.test(md) &&
      /checkpoint:human-verify/.test(md),
    // #3299: that checkpoint is now the FALLBACK, not the unconditional result.
    // Merely finding HUMAN_VERIFY_MODE on the line proves nothing — peer review
    // showed a branch can name the variable and still checkpoint unconditionally.
    // Require the ordered clause markers AND that the auto-continue clause is
    // free of any STOP outcome, which is what "conditional" actually means here.
    interactiveIsConditional: (() => {
      const m = md.match(/\*\*Interactive:\*\*([^\n]*)/);
      if (!m) return false;
      const body = m[1];
      // Both outcomes must be present and separated, and the auto-continue
      // half must contain no STOP — naming HUMAN_VERIFY_MODE proves nothing on
      // its own, as a branch can cite the variable and still checkpoint
      // unconditionally (that exact shape passed an earlier revision).
      const iElse = body.indexOf('else');
      if (iElse < 0) return false;
      const autoContinue = body.slice(0, iElse);
      return /HUMAN_VERIFY_MODE/.test(body)
        && /no checkpoint/i.test(autoContinue)
        && !/\bSTOP\b/.test(autoContinue)
        && /STOP \u2192 `checkpoint:human-verify`/.test(body.slice(iElse));
    })(),
    // Cross-referenced in the checkpoint protocol section too.
    documentedInCheckpointProtocol: /\*\*Tracer feedback gate:\*\*/.test(md),
  };
}

function parseWorkflowContract(md) {
  const lines = md.split(/\r?\n/);
  const argLine = lines.find((l) => l.includes('Extract from $ARGUMENTS:')) || '';
  return {
    argListDocumentsNoTracer: argLine.includes('--no-tracer'),
    resolvesTracerMode:
      md.includes('TRACER_MODE=true') &&
      md.includes('--no-tracer') &&
      md.includes('TRACER_MODE=false'),
    injectsTracerModeToPlanner: /\*\*TRACER_MODE:\*\* \$\{TRACER_MODE\}/.test(md),
    // Guard: must not eagerly @-import the reference (size-budget rule, mirrors
    // tests/workflow-size-budget.test.cjs). An eager import is an @-path at line start.
    noEagerImportOfMvpRef: !/^\s*@[^\n]*planner-mvp-mode\.md/m.test(md),
  };
}

function parseCommandContract(md) {
  const argHint = (md.split(/\r?\n/).find((l) => l.startsWith('argument-hint:')) || '');
  return {
    argHintHasNoTracer: argHint.includes('--no-tracer'),
    flagsDocumentNoTracer: /- `--no-tracer` —/.test(md),
  };
}

// ─── Suite 1: Planner — first-class tracer task + tracer-first default ────────

describe('#1945 planner: first-class tracer task + tracer-first default', () => {
  const c = parsePlannerContract(PLANNER);

  test('planner has a Tracer-First Decomposition section that is the DEFAULT (not flag-gated)', () => {
    assert.ok(c.hasTracerFirstSection, 'planner must document a "Tracer-First Decomposition" section');
    assert.ok(c.declaresDefault, 'the section must declare tracer-first the default, not gated behind a flag');
  });

  // Acceptance: with no flags, PLAN.md leads with exactly one tracer task touching every layer.
  test('every plan LEADS with one type="tracer" task (acceptance #1)', () => {
    assert.ok(c.leadsWithTracer, 'planner must instruct leading every plan with one type="tracer" task');
    assert.ok(c.documentsTracerTaskType, 'planner must document the <task type="tracer"> shape');
    assert.ok(c.breakStepLeadsWithTracer, 'the break_into_tasks step must lead with the tracer by default');
  });

  // Acceptance: the tracer includes a real end-to-end <verify>, not a per-layer unit check.
  test('tracer task carries a real end-to-end <verify> (acceptance #2)', () => {
    assert.ok(c.endToEndVerify, 'planner must require a real END-TO-END verify, not a per-layer unit test');
  });

  // Acceptance: --no-tracer reproduces today's horizontal-layer default.
  test('--no-tracer / TRACER_MODE=false restores horizontal layers (acceptance #5)', () => {
    assert.ok(c.documentsNoTracerOptOut, 'planner must document the --no-tracer horizontal-layer opt-out');
  });

  test('tracer is production-quality, not a prototype', () => {
    assert.ok(c.productionQualityNotPrototype, 'planner must state a tracer is production-quality, not a prototype');
  });

  test('composes with --tdd (tracer starts red) and --mvp is enrichment on top', () => {
    assert.ok(c.composesWithTdd, 'planner must document tracer + --tdd composition');
    assert.ok(c.mvpIsEnrichment, 'planner must reframe MVP as enrichment, no longer the toggle for vertical slices');
  });

  test('vertical-slice reference is reconciled to tracer-first-by-default', () => {
    assert.match(MVP_REF, /Tracer-First Decomposition/, 'reference title must reflect tracer-first');
    assert.match(MVP_REF, /the \*\*default\*\* tracer-first decomposition/, 'reference must state tracer-first is the default');
    assert.doesNotMatch(
      MVP_REF,
      /only when `MVP_MODE=true`/,
      'reference must no longer gate vertical slices behind MVP_MODE only',
    );
  });
});

// ─── Suite 2: Executor — post-tracer feedback gate ───────────────────────────

describe('#1945 executor: post-tracer feedback gate', () => {
  const c = parseExecutorContract(EXECUTOR);

  test('executor recognizes type="tracer"', () => {
    assert.ok(c.recognizesTracerType, 'executor must handle type="tracer"');
  });

  test('runs an early integration gate BEFORE expansion tasks', () => {
    assert.ok(c.earlyIntegrationGate, 'executor must run the tracer verify as an early integration checkpoint before expansion');
  });

  // Acceptance: autonomous run halts before any expansion task on a failing tracer.
  test('autonomous run HALTS before expansion on a failing tracer (acceptance #3)', () => {
    assert.ok(c.autoHaltsOnFailure, 'autonomous run must halt (surfaced) before expansion when the tracer verify fails');
  });

  // Golden rule 6 (checkpoints.md): `gate="blocking-human"` stops for a human in
  // EVERY mode, auto included. The precedence chain is first-match, so this is an
  // ordering property, not a presence one — an auto-mode branch evaluated first
  // silently swallows a blocking-human tracer in exactly the unattended run where
  // the gate matters most, with both clauses still present in the file.
  test('gate="blocking-human" is evaluated BEFORE the auto-mode branch (golden rule 6)', () => {
    assert.ok(
      c.blockingHumanPrecedesAutoMode,
      'the blocking-human STOP must appear before the auto-mode branch and state that it binds in every mode',
    );
  });

  // Acceptance #4, as narrowed by #3299. Originally "an interactive run ALWAYS
  // emits checkpoint:human-verify after the tracer". That is no longer the
  // contract: under human_verify_mode=end-of-phase an automated-only tracer
  // verify auto-continues with no checkpoint. What survives of #1945's
  // acceptance is that the interactive branch still HAS a checkpoint outcome —
  // it is now the fallback rather than the unconditional result.
  //
  // Left as a bare `interactiveHumanVerify` substring check this test kept
  // passing after #3299 purely because the strings still appear in the fallback
  // clause, while its NAME asserted the opposite of shipped behavior — the same
  // one-copy-stale drift #3299 itself is about. Suite 6 owns the conditional
  // contract; this one is scoped to what #1945 still guarantees.
  test('interactive run retains a checkpoint:human-verify outcome (acceptance #4, narrowed by #3299)', () => {
    assert.ok(c.interactiveHumanVerify, 'interactive branch must still exist and still name checkpoint:human-verify');
    assert.ok(
      c.interactiveIsConditional,
      'post-#3299 the interactive checkpoint is CONDITIONAL — the branch must consult HUMAN_VERIFY_MODE, not emit unconditionally',
    );
  });

  test('gate is cross-referenced in the checkpoint protocol', () => {
    assert.ok(c.documentedInCheckpointProtocol, 'checkpoint protocol must cross-reference the tracer feedback gate');
  });

  // The execute-plan orchestrator has its OWN inline per-task dispatch (used for
  // step-by-step / non-Claude-Code / inline execution) — it must know tracer too,
  // else the gate silently no-ops on those paths.
  test('execute-plan.md inline dispatch also handles type="tracer" with the gate', () => {
    assert.match(EXECUTE_PLAN, /`type="tracer"`/, 'execute-plan.md inline dispatch must handle type="tracer"');
    assert.match(EXECUTE_PLAN, /tracer feedback gate BEFORE any expansion task/i, 'execute-plan.md must run the tracer gate before expansion');
    assert.match(EXECUTE_PLAN, /Auto mode active \(`AUTO_CHAIN` or `AUTO_CFG`\)/, 'execute-plan.md tracer gate must key on auto mode (AUTO_CHAIN or AUTO_CFG)');
  });
});

// ─── Suite 3: Orchestrator + command wire --no-tracer ────────────────────────

describe('#1945 plan-phase orchestrator + command: --no-tracer wiring', () => {
  const w = parseWorkflowContract(WORKFLOW);
  const cmd = parseCommandContract(COMMAND);

  test('workflow argument list documents --no-tracer', () => {
    assert.ok(w.argListDocumentsNoTracer, 'plan-phase workflow must extract --no-tracer from $ARGUMENTS');
  });

  test('workflow resolves TRACER_MODE (default true, --no-tracer -> false)', () => {
    assert.ok(w.resolvesTracerMode, 'workflow must resolve TRACER_MODE with a --no-tracer -> false path');
  });

  test('workflow injects TRACER_MODE into the planner subagent prompt', () => {
    assert.ok(w.injectsTracerModeToPlanner, 'workflow must wire **TRACER_MODE:** ${TRACER_MODE} into the planner prompt');
  });

  test('workflow does not eagerly @-import planner-mvp-mode.md (size-budget guard)', () => {
    assert.ok(w.noEagerImportOfMvpRef, 'planner-mvp-mode.md must stay lazily loaded by the planner, not eagerly imported');
  });

  test('command argument-hint and flags document --no-tracer', () => {
    assert.ok(cmd.argHintHasNoTracer, 'command argument-hint must advertise --no-tracer');
    assert.ok(cmd.flagsDocumentNoTracer, 'command flags list must document --no-tracer');
  });

  test('/gsd:help full listing documents --no-tracer', () => {
    assert.match(HELP_FULL, /\[--no-tracer\]/, 'help/modes/full.md plan-phase usage line must list --no-tracer');
    assert.match(HELP_FULL, /- `--no-tracer` —/, 'help/modes/full.md must describe the --no-tracer flag');
  });
});

// ─── Suite 4: Terminology — CONTEXT glossary + docs ──────────────────────────

describe('#1945 glossary + docs', () => {
  // Acceptance: CONTEXT.md glossary defines tracer bullet vs prototype.
  test('CONTEXT.md glossary defines "Tracer Bullet" against "prototype" (acceptance #7)', () => {
    assert.match(CONTEXT, /^### Tracer Bullet$/m, 'CONTEXT.md must have a ### Tracer Bullet glossary entry');
    const start = CONTEXT.indexOf('### Tracer Bullet');
    const entry = CONTEXT.slice(start, start + 1400);
    assert.match(entry, /production-quality/i, 'entry must call a tracer production-quality');
    assert.match(entry, /\bprototype\b/i, 'entry must contrast tracer with a prototype');
    assert.match(entry, /throwaway/i, 'entry must describe a prototype as throwaway');
  });

  test('docs/COMMANDS.md documents the --no-tracer flag', () => {
    assert.match(COMMANDS_DOC, /\| `--no-tracer` \|/, 'COMMANDS.md flag table must include --no-tracer');
  });

  test('docs/how-to and docs/AGENTS reflect tracer-first + the executor gate', () => {
    assert.match(HOWTO, /tracer/i, 'how-to must mention tracer-first');
    assert.match(HOWTO, /--no-tracer/, 'how-to must mention the --no-tracer opt-out');
    assert.match(AGENTS_DOC, /task types: auto, tracer/i, 'AGENTS.md must list tracer among task types');
    assert.match(AGENTS_DOC, /Tracer feedback gate/i, 'AGENTS.md must describe the executor tracer gate');
  });
});

// ─── Suite 5: Behavioral — the one code seam accepts tracer ──────────────────
// Acceptance #6: `tracer` is accepted everywhere the task-type enum is validated;
// no schema/validation path rejects it. `verify plan-structure` is the only code
// path that inspects <task type=...>. Prove it accepts tracer and never confuses
// a tracer for a checkpoint.

// Minimal valid PLAN.md; `taskType` and `n` let us sweep the tracer-count boundary.
function planWith({ taskType = 'auto', n = 1, autonomous = 'true' } = {}) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(
      `<task type="${taskType}">`,
      `  <name>Task ${i + 1}: End-to-end slice</name>`,
      '  <files>some/file.ts</files>',
      '  <action>Wire one path through every layer</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Happy path works end-to-end</done>',
      '</task>',
      '',
    );
  }
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [some/file.ts]',
    `autonomous: ${autonomous}`,
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    ...tasks,
    '</tasks>',
  ].join('\n');
}

function verifyPlan(tmpDir, content) {
  const rel = path.join('.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), content);
  const result = runGsdTools(`verify plan-structure ${rel}`, tmpDir);
  assert.ok(result.success, `verify plan-structure failed to run: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#1945 behavioral: verify plan-structure accepts type="tracer" (acceptance #6)', () => {
  test('a type="tracer" plan validates with no errors', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const out = verifyPlan(tmpDir, planWith({ taskType: 'tracer', n: 1 }));
    assert.strictEqual(out.valid, true, `tracer plan must be valid, errors: ${JSON.stringify(out.errors)}`);
    assert.deepStrictEqual(out.errors, [], 'no validation path may reject a tracer task');
    assert.ok(
      !out.errors.some((e) => /tracer/i.test(e)) && !(out.warnings || []).some((w) => /tracer/i.test(w)),
      'nothing may flag the tracer task type specifically',
    );
  });

  // verify plan-structure is task-type-agnostic: it accepts any count of tracer
  // tasks (0/1/2) with no type-based rejection. This supports acceptance #6; it is
  // NOT a claim about the planner's "exactly one leading tracer" contract, which is
  // planner prose (asserted in Suite 1), not something plan-structure validates.
  test('verify plan-structure accepts 0 / 1 / 2 tracer tasks (type-agnostic, #6)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    for (const n of [0, 1, 2]) {
      const content = n === 0 ? planWith({ taskType: 'auto', n: 1 }) : planWith({ taskType: 'tracer', n });
      const out = verifyPlan(tmpDir, content);
      assert.strictEqual(out.valid, true, `${n}-tracer plan must be valid, errors: ${JSON.stringify(out.errors)}`);
    }
  });

  // A tracer task is NOT a checkpoint: an autonomous:true tracer plan must not trip
  // the "Has checkpoint tasks but autonomous is not false" rule.
  test('a tracer task is not misclassified as a checkpoint', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const out = verifyPlan(tmpDir, planWith({ taskType: 'tracer', n: 1, autonomous: 'true' }));
    assert.ok(
      !out.errors.some((e) => /checkpoint/i.test(e)),
      `tracer must not be treated as a checkpoint, errors: ${JSON.stringify(out.errors)}`,
    );
  });
});

// ─── Suite 6: #3299 — the tracer gate must honor workflow.human_verify_mode ───

// The tracer feedback gate (#2294) predates human_verify_mode (#3309), whose scope
// was the planner + verifier only. Until #3299 the gate branched on auto-mode ALONE,
// so under the documented `end-of-phase` default an interactive run halted after
// EVERY tracer — synthesizing a checkpoint:human-verify no planner ever emitted and
// asking the user to retype a verdict the executor had just computed.
//
// These assertions are prose-shaped because the gate itself is prose: it is executed
// by an agent reading agents/gsd-executor.md and gsd-core/workflows/execute-plan.md.
// The two files duplicate the rule and MUST stay in sync — a fix landing in only one
// leaves the defect live on whichever dispatch path reads the other.
describe('#3299 regression: tracer feedback gate honors workflow.human_verify_mode', () => {
  const HV_REF = read('gsd-core/references/planner-human-verify-mode.md');
  const CHECKPOINTS = read('gsd-core/references/checkpoints.md');
  const { parsePredicates } = require('../gsd-core/bin/lib/context-predicates.cjs');

  // ── Why the selection layer looks like this ────────────────────────────────
  //
  // These files are prose an agent executes, so a regression test must prove the
  // OPERATIVE text is right — not that correct-looking text exists somewhere in
  // the file. Six rounds of adversarial review defeated weaker shapes, each
  // leaving the suite green while the reported bug shipped:
  //
  //   1. keyword presence        -> reverting the rule entirely passed
  //   2. presence + names        -> `blocking-human AND mid-flight` passed
  //   3. blacklisting `STOP`     -> "pause and invoke checkpoint_protocol" passed
  //   4. exact-pin one clause    -> an override sentence ABOVE the clause passed
  //   5. + hand-rolled `<!--` strip -> a fenced DECOY, or an UNCLOSED comment,
  //                                    still selected non-operative text
  //
  // Round 5's hand-rolled comment stripper handled only BALANCED comments and was
  // fence-blind, so two ORDINARY edits could silently turn these guards into
  // decoy checks: a forgotten `-->` (which comments the real rule through EOF),
  // and a normal fenced documentation example of the rule combined with a
  // whitespace-only reformat of the live list item.
  //
  // Rather than hand-roll a third scanner, defer to the repo's own interleaved
  // fence/comment scanner via the PUBLIC `parsePredicates` export: instrument
  // candidate lines as throwaway predicate declarations and let it tell us which
  // ones are operative. Verified: fenced, balanced-commented, and
  // after-unclosed-comment candidates are all correctly excluded.
  function operativeLineIndexes(md, candidateRe) {
    // Guard the CLASS, not just the one caller that got it wrong (review round
    // 9). This helper REPLACES the candidate line. Deleting an ordinary content
    // line is harmless, but deleting a fence DELIMITER leaves its partner behind
    // to become an opener, inverting fence parity for the entire remainder of the
    // document — `computeSkippedLineFlags` is a strict FORWARD state machine, so
    // every marker after the deletion then lands alternately inside and outside a
    // phantom fence. Ask about a fence delimiter's position with
    // `isOperativePosition` instead, which INSERTS and therefore perturbs nothing.
    //
    // Checked against the lines this regex ACTUALLY matches in THIS document, not
    // against a sample of delimiter spellings. A fixed probe list was the first
    // attempt and it is not the class: `~~~xml`, ```` ```json ````, longer tilde
    // runs and info strings all walk straight past any list short enough to
    // write down. Matching on the real data cannot go stale, and cannot pass a
    // delimiter it has not thought of. (Codex review, round 9.)
    const lines = md.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (candidateRe.test(line) && /^\s*(?:`{3,}|~{3,})/.test(line)) {
        throw new Error(
          `operativeLineIndexes: the candidate regex ${candidateRe} matches the fence delimiter `
          + `${JSON.stringify(line)} at 0-based line ${i}. Replacing a delimiter inverts fence parity `
          + 'for the rest of the document and misclassifies LIVE fences downstream. '
          + 'Use isOperativePosition(md, idx).');
      }
    }
    const injected = new Set();
    const instrumented = lines
      .map((line, i) => {
        if (!candidateRe.test(line)) return line;
        // A ONE-LINE `<!-- ... -->` carries both delimiters, so the scanner's
        // multi-line comment tracking never opens for it — and replacing the
        // line with a predicate marker STRIPS the delimiters, promoting the
        // commented text to operative. Re-test with complete same-line spans
        // removed: if the candidate only matched inside one, it is not live.
        if (!candidateRe.test(line.replace(/<!--[\s\S]*?-->/g, ''))) return line;
        // Same trap, unclosed form: `<!-- ANCHOR` opens a comment the scanner
        // would honour, but the marker replacement deletes the opener first, so
        // the comment never registers. Drop anything from an unpaired `<!--`.
        if (!candidateRe.test(line.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, ''))) return line;
        // CommonMark treats a 4-space-indented line as an indented CODE BLOCK,
        // which `parsePredicates` does not skip (it accepts indented predicate
        // declarations by design). Emitting an UNINDENTED marker would strip
        // that indentation and PROMOTE an indented example to operative — the
        // exact inversion review round 8 found. Preserve the original indent so
        // an indented candidate stays an indented code line and is not counted.
        const indent = (line.match(/^[ \t]*/) || [''])[0];
        // CommonMark: only 0-3 LITERAL SPACES is ordinary block indentation.
        // Anything else — a tab, 4+ spaces, or a mix like " \t" — opens an
        // indented code block. Testing for `{4,}|\t` missed the mixed forms
        // (" \t", "  \t", "   \t"), which still let an indented decoy be
        // promoted to operative. Allow-list the operative shape instead of
        // trying to enumerate the code-block ones.
        if (!/^ {0,3}$/.test(indent)) return line;
        injected.add(i);
        return indent + '- `GSDTEST.CANDIDATE=' + i + '`';
      })
      .join('\n');
    return parsePredicates(instrumented).predicates
      .filter((p) => p.id === 'GSDTEST.CANDIDATE')
      // Provenance, not just value: require the predicate to have been parsed
      // FROM the line whose index it names, and that we injected there. A
      // pre-existing literal `GSDTEST.CANDIDATE=<n>` elsewhere in the source
      // otherwise satisfies a value-only check by naming an index some other
      // (skipped) candidate contributed.
      .filter((p) => injected.has(Number(p.value)) && p.line - 1 === Number(p.value))
      .map((p) => Number(p.value));
  }

  // Operative-aware line predicate, for selections that cannot go through the
  // instrumentation path (an END anchor). Reuses the same scanner so fenced /
  // commented / after-unclosed-comment lines are excluded consistently with
  // `operativeLineIndexes`, rather than testing raw text. NOT usable for a fence
  // delimiter — see the guard above and `isOperativePosition` below.
  function operativeLineSet(md, lineRe) {
    return new Set(operativeLineIndexes(md, lineRe));
  }

  // Is the line at `idx` in live prose — outside every fence and comment?
  //
  // Answers for a candidate that IS a fence delimiter, which `operativeLineIndexes`
  // structurally cannot: substituting a delimiter is destructive either way (delete
  // it and parity inverts; keep it and the marker is fenced and never parses).
  // INSERT the marker on its own line immediately before the candidate instead.
  // Insertion preserves every delimiter in the document, and because the skip-state
  // machine runs strictly FORWARD, a line inserted at `idx` observes exactly the
  // fence/comment state the candidate at `idx` observes — with nothing but the
  // marker between them. So marker-operative IS the candidate's position-liveness.
  function isOperativePosition(md, idx) {
    const lines = md.split(/\r?\n/);
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return false;
    // Same CommonMark rule as operativeLineIndexes: only 0-3 LITERAL SPACES is
    // ordinary block indentation, so an indented candidate's position cannot be
    // probed with an unindented marker without promoting it.
    const indent = (lines[idx].match(/^[ \t]*/) || [''])[0];
    if (!/^ {0,3}$/.test(indent)) return false;
    // Position-liveness is not content-liveness: a same-line `<!-- ... -->`
    // wrapper comments the candidate's CONTENT while leaving the position outside
    // every span, so the probe alone would answer "live" for `<!-- ```xml -->`.
    // Reject that here rather than relying on each caller's own shape test to
    // happen to exclude it.
    //
    // The rule is the SCANNER's, not a tighter one of our own: it skips an entire
    // line whose TRIMMED text starts with `<!--` — balanced or not — before it
    // considers fences at all. Stripping the span and asking whether content
    // survives would answer "live" for `<!-- closed --> real content`, which the
    // scanner skips outright. Agreeing with it beats out-reasoning it.
    // (Codex review, round 9.)
    if (lines[idx].trimStart().startsWith('<!--')) return false;
    if (lines[idx].replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '').trim() === '') return false;
    const probed = lines.slice(0, idx)
      .concat(indent + '- `GSDTEST.POSITION=' + idx + '`', lines.slice(idx))
      .join('\n');
    return parsePredicates(probed).predicates.some(
      (p) => p.id === 'GSDTEST.POSITION' && Number(p.value) === idx && p.line - 1 === idx);
  }

  function soleOperativeIndex(name, md, candidateRe, what) {
    const idx = operativeLineIndexes(md, candidateRe);
    assert.strictEqual(idx.length, 1,
      `${name}: expected exactly ONE operative ${what}, found ${idx.length}. Either the anchor drifted, `
      + `or a second live copy exists — in which case this pin may be proving a decoy while other text ships.`);
    return idx[0];
  }

  // Region extraction is line-based off the operative index, so fenced or
  // commented copies cannot be selected even when byte-identical.
  function regionFrom(md, startIdx, endRe) {
    const lines = md.split(/\r?\n/);
    // The END anchor must be operative too. Testing raw lines let a fenced
    // example containing a `###` / `<type ` line truncate the pinned region
    // early — a false FAILURE on a legitimate doc edit (review round 8).
    const operativeEnds = operativeLineSet(md, endRe);
    let end = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (operativeEnds.has(i)) { end = i; break; }
    }
    return lines.slice(startIdx, end).join('\n').replace(/\s+/g, ' ').trim();
  }

  // Anchors are whitespace-tolerant so a routine reformat cannot make the live
  // line stop matching while a pristine fenced example still does.
  const EXEC_ANCHOR = /^\s*2\.\s+\*\*If\s+`type="tracer"`:\*\*/;
  const EP_ANCHOR = /`type="tracer"`.*tracer feedback gate/i;
  const CK_ANCHOR = /^\s*###\s+Tracer feedback gate \(#3299\)/;
  const ROW_ANCHOR = /^\s*\|\s*`tracer`\s*\|/;
  const PLANNER_ANCHOR = /^\s*\*\*Tracer task shape:\*\*/;

  // Guard the selection layer itself. If this breaks, every pin below is suspect.
  test('the operative-line selector ignores fenced, commented, and unclosed-comment copies', () => {
    const md = [
      'ANCHOR live',
      '```xml',
      'ANCHOR fenced',
      '```',
      '<!--',
      'ANCHOR commented',
      '-->',
      '<!-- ANCHOR same-line -->',
      '<!--',
      'ANCHOR after-unclosed',
    ].join('\n');
    assert.deepStrictEqual(operativeLineIndexes(md, /^ANCHOR /), [0],
      'only the live ANCHOR line may be treated as operative — fenced, balanced-commented, and '
      + 'after-unclosed-comment copies must all be excluded');
  });

  // Review round 9. The round-8 fence-awareness fix reached for the replacement
  // helper to ask about a fence DELIMITER, which it cannot answer soundly. Both
  // halves are pinned: the unsound route now throws, and the sound one is right.
  test('fence-delimiter liveness: the replacement helper refuses, the insertion probe answers', () => {
    // Two live top-level ```xml fences. The FIRST one's deletion is what inverts
    // parity for the second — the exact misclassification found on the real
    // agents/gsd-planner.md, reduced to its smallest reproducing shape.
    const md = [
      'prose',            // 0
      '```xml',           // 1  live opener
      '<a/>',             // 2
      '```',              // 3
      'more prose',       // 4
      '```xml',           // 5  live opener — reported NON-operative by the old route
      '<b/>',             // 6
      '```',              // 7
      '<!--',             // 8
      '```xml',           // 9  commented opener
      '-->',              // 10
      '<!-- ```xml -->',  // 11 same-line-commented opener
    ].join('\n');
    const FENCE = /^\s*```xml(?:\s.*)?$/;

    assert.throws(() => operativeLineIndexes(md, FENCE), /matches the fence delimiter/,
      'a candidate regex matching a fence delimiter must be refused outright, not answered wrongly — '
      + 'this helper REPLACES the candidate, so removing one delimiter inverts parity downstream');

    // The spellings that defeated the first attempt at this guard, which probed a
    // fixed list of delimiter strings. Each is a real fence opener and none of
    // them appears in any list short enough to write down — which is why the
    // guard now matches the document's own lines instead. (Codex review, round 9.)
    for (const [label, doc, re] of [
      ['~~~xml', 'p\n~~~xml\n<a/>\n~~~\n', /^\s*~~~xml$/],
      ['```json', 'p\n```json\n{}\n```\n', /^\s*```json$/],
      ['~~~~ (4 tildes)', 'p\n~~~~\nx\n~~~~\n', /^\s*~~~~$/],
      ['``` with info string', 'p\n```xml title=a\n<a/>\n```\n', /^\s*```xml\s.*$/],
    ]) {
      assert.throws(() => operativeLineIndexes(doc, re), /matches the fence delimiter/,
        `${label}: the guard must cover the delimiter CLASS, not a sample of its spellings — a regex `
        + 'it waves through reintroduces the exact parity inversion this row exists for');
    }

    // Codex review, round 9. `isOperativePosition` must agree with the scanner,
    // which skips an ENTIRE line whose trimmed text starts with `<!--` before it
    // looks at fences. Stripping the span and asking whether content survives
    // answers "live" for a balanced comment followed by real content; the scanner
    // does not parse that line at all.
    assert.strictEqual(isOperativePosition('- `X.A=1`\n<!-- closed --> - `X.B=2`\n', 1), false,
      'a line that STARTS with a comment opener is skipped wholesale by the scanner, balanced or not — '
      + 'this probe must not claim it is live');

    assert.deepStrictEqual(
      [1, 5, 9, 11].map((i) => isOperativePosition(md, i)),
      [true, true, false, false],
      'both live openers must read operative (the second is the one the deletion route lost), and '
      + 'neither the block-commented nor the same-line-commented opener may');

    // Non-vacuity: the probe must not simply answer "true" for every position it
    // is handed, and must stay correct as content shifts above it.
    assert.strictEqual(isOperativePosition(md, 2), false, 'a line INSIDE a fence is not operative');
    assert.strictEqual(isOperativePosition(md, 0), true, 'plain prose is operative');
    const shifted = ['extra', '', ...md.split('\n')].join('\n');
    assert.deepStrictEqual([3, 7].map((i) => isOperativePosition(shifted, i)), [true, true],
      'both openers must still read operative after unrelated lines are inserted above them — the '
      + 'defect this replaces was a parity coincidence that a shift like this flipped');
  });

  const OPERATIVE = [
    ['agents/gsd-executor.md', () => regionFrom(EXECUTOR,
      soleOperativeIndex('agents/gsd-executor.md', EXECUTOR, EXEC_ANCHOR, 'tracer task branch'),
      /^\s*3\.\s+\*\*If\s/), "2. **If `type=\"tracer\"`:** (production-quality, never a throwaway) - Execute and commit exactly like `type=\"auto\"`. - **Then run the tracer feedback gate BEFORE any expansion task** \u2014 an early integration checkpoint on the proven slice. In order (full chain: \"Tracer feedback gate\", checkpoints.md): - **`gate=\"blocking-human\"` \u2192 STOP**, return a `checkpoint:human-verify`. Every mode, auto included (golden rule 6). - **Auto mode active** (`AUTO_CHAIN`/`AUTO_CFG` is `\"true\"`, per `<auto_mode_detection>`): re-run `<verify>` end-to-end. Fails \u2192 HALT, surface as deviation Rule 1, never expand \u2014 pouring more layers onto a broken foundation is exactly the failure this gate prevents. Passes \u2192 log `\u26a1 Tracer verified end-to-end \u2014 expanding`, continue. - **Interactive:** per `HUMAN_VERIFY_MODE` \u2014 `end-of-phase` (default) + automated-only `<verify>` \u2192 re-run; fails \u2192 HALT as above, passes \u2192 continue, no checkpoint; else STOP \u2192 `checkpoint:human-verify` (#3299)."],
    ['gsd-core/workflows/execute-plan.md', () => {
      const i = soleOperativeIndex('gsd-core/workflows/execute-plan.md', EXECUTE_PLAN, EP_ANCHOR, 'tracer dispatch line');
      return EXECUTE_PLAN.split(/\r?\n/)[i].replace(/\s+/g, ' ').trim();
    }, "- `type=\"tracer\"`: execute like `type=\"auto\"` (production-quality, real `<verify>`, commit), then run the tracer feedback gate BEFORE any expansion task \u2014 an early integration checkpoint. Evaluate in order (#3299). First, `gate=\"blocking-human\"` \u2192 STOP \u2192 return a `checkpoint:human-verify` via checkpoint_protocol \u2014 every mode, auto included (golden rule 6, checkpoints.md). Next, Auto mode active (`AUTO_CHAIN` or `AUTO_CFG`): re-run the tracer `<verify>`; on failure HALT and surface (deviation) \u2014 do NOT start expansion tasks. Next, `HUMAN_VERIFY_MODE` is `end-of-phase` (default) AND the tracer's `<verify>` carries only `<automated>` (no `<human-check>`) \u2192 re-run the tracer `<verify>`; on failure HALT and surface as a deviation exactly as in the auto-mode branch \u2014 never a checkpoint; on success log `\u26a1 Tracer verified end-to-end \u2014 expanding` and continue to expansion, do NOT synthesize a checkpoint. Otherwise (`mid-flight`, or the tracer carries genuine human-observable evidence) \u2192 STOP \u2192 return a `checkpoint:human-verify` for the tracer via checkpoint_protocol before expansion."],
  ];

  test('the complete operative gate region is pinned in both copies', () => {
    for (const [name, extract, expected] of OPERATIVE) {
      assert.strictEqual(extract(), expected,
        `${name}: the tracer gate's decision region drifted from its pinned contract.\n\n`
        + `Pinned WHOLE on purpose: pinning only the auto-continue clause let an unconditional override `
        + `sentence be added beside it with every assertion still passing. If the behavior genuinely `
        + `changed, update the prose AND this expected string together; do not narrow the assertion.`);
    }
  });

  test('the canonical checkpoints.md tracer section is pinned whole', () => {
    const i = soleOperativeIndex('checkpoints.md', CHECKPOINTS, CK_ANCHOR, 'tracer-gate heading');
    assert.strictEqual(regionFrom(CHECKPOINTS, i, /^\s*###\s|^\s*<type\s/), "### Tracer feedback gate (#3299) A `type=\"tracer\"` task is followed by an early integration checkpoint on the proven slice, run BEFORE any expansion task. This checkpoint is **synthesized by the executor at runtime** \u2014 no planner emits it \u2014 so planner-side `human_verify_mode` suppression cannot reach it. It must therefore consult the mode itself. Evaluate the rows **in order** and take the first that matches \u2014 they are a precedence chain, not independent conditions: | # | Run | Tracer `<verify>` | Behavior | |---|---|---|---| | 1 | **Any run, any mode** (incl. auto) | task carries `gate=\"blocking-human\"` | **STOP \u2192 `checkpoint:human-verify`.** Never auto-continued. | | 2 | Auto mode active (`AUTO_CHAIN`/`AUTO_CFG`) | any (row 1 already took `blocking-human`) | Re-run verify; HALT on failure, continue on success. **Pre-existing behavior \u2014 unchanged by #3299.** | | 3 | Interactive, `end-of-phase` (default) | only `<automated>` | Re-run verify; HALT on failure, continue to expansion on success \u2014 **no checkpoint** | | 4 | Interactive, `end-of-phase` | carries `<human-check>` | STOP \u2192 `checkpoint:human-verify` | | 5 | Interactive, `mid-flight` | any | STOP \u2192 `checkpoint:human-verify` | **Carve-outs \u2014 the #3299 auto-continue (row 3) applies ONLY when all three hold:** the run is interactive, the mode is `end-of-phase`, and the tracer's `<verify>` contains only `<automated>`. Anything else STOPs or falls to the pre-existing auto-mode branch. HALT-on-failure is unconditional in rows 2 and 3 alike: a failing tracer never becomes an approvable checkpoint and never proceeds to expansion, because layering expansion onto a broken slice is the failure this gate exists to prevent. Row 1 is deliberately **not** scoped to interactive runs. Golden rule 6 above states that `gate=\"blocking-human\"` stops for a human in *every* mode including auto-mode, and a precedence chain that let an autonomous run continue past it would make this file assert two incompatible rules about the same gate. No planner emits `gate` on a `type=\"tracer\"` task today, but `src/verify.cts` parses only `type` and does not consult `gate` on non-checkpoint tasks, so a hand-authored, imported, or externally-generated `PLAN.md` can carry it and validate \u2014 unreachable by our planner is not unreachable. Read `HUMAN_VERIFY_MODE` with an explicit default \u2014 `workflow.human_verify_mode` is absent from `SCHEMA_DEFAULTS`, so a bare `config-get` exits non-zero with `Key not found` on any project whose `config.json` predates #3309: ```bash HUMAN_VERIFY_MODE=$(gsd_run query config-get workflow.human_verify_mode --default end-of-phase --raw 2>/dev/null || echo \"end-of-phase\") ``` </type>",
      'checkpoints.md tracer-gate section drifted. Pinned whole so behavior-bearing prose cannot be '
      + 'added around the table (an "ignore row 3, always wait" line below it previously passed).');
  });

  // Asserting only that the row EXISTS is what let the canonical schema table
  // drift out of sync with shipped behavior after #3299 without CI noticing —
  // CONTEXT.md names this file the canonical reference for the task-type
  // contract, so a wrong row here is the authoritative wrong answer. Keyword
  // presence is not enough either: peer review defeated an earlier revision by
  // APPENDING "Nevertheless, interactive runs always present a
  // checkpoint:human-verify." — every required keyword still matched, so the
  // reference could contradict itself with CI green. Hence the EXACT pin, which
  // is deliberately brittle: a wording change must be a conscious edit in both
  // places. Selection routes through soleOperativeIndex rather than a raw
  // startsWith find — an earlier duplicate of this test used the raw form, which
  // this suite records at :477 as a defeated round-1 shape, and it was removed in
  // review of #3390 rather than left as a second hand-maintained copy of the
  // same canonical string.
  test('docs/reference/plan-md.md tracer row Autonomy cell matches shipped behavior exactly', () => {
    const i = soleOperativeIndex('plan-md.md', PLAN_MD_REF, ROW_ANCHOR, 'tracer table row');
    const cells = PLAN_MD_REF.split(/\r?\n/)[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    assert.strictEqual(cells.length, 3, `tracer row must have 3 cells, got ${cells.length}`);
    assert.strictEqual(cells[2].replace(/\s+/g, ' ').trim(), "Fully autonomous; after committing, the executor runs the tracer's `<verify>` as an early integration gate. A tracer carrying `gate=\"blocking-human\"` STOPs for a human in every mode, auto included. Otherwise autonomous runs halt on failure before expansion, and interactive runs honor `workflow.human_verify_mode` (#3299): under the `end-of-phase` default a `<verify>` carrying only `<automated>` is re-run and, on success, expansion continues with **no** checkpoint (failure still halts); under `mid-flight`, or when the tracer carries `<human-check>`, a `checkpoint:human-verify` is presented. Full precedence chain: `gsd-core/references/checkpoints.md` \u2192 \"Tracer feedback gate\".",
      'plan-md.md tracer Autonomy cell drifted. CONTEXT.md names this table the canonical schema '
      + 'reference — update the cell AND this expected string together.');
  });

  // Structural, not copy-pinned: the contract is the SHAPE of the verify, so a
  // wording improvement to the placeholder must not false-fail (round-5 Minor).
  test('planner tracer template emits exactly one <automated>-wrapped verify', () => {
    const i = soleOperativeIndex('agents/gsd-planner.md', PLANNER, PLANNER_ANCHOR, 'tracer task shape marker');
    const lines = PLANNER.split(/\r?\n/);
    // The fence OPENER must be operative AND the first non-blank line after the
    // marker. Matching the first raw ```xml in the remainder let a commented-out
    // decoy template be selected while the live one regressed (review round 8) —
    // this was the one selection in the suite that was not fence/comment aware.
    let openIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      openIdx = j;
      break;
    }
    assert.notStrictEqual(openIdx, -1, 'the tracer task shape marker must be followed by content');
    // Shape off the RAW line, liveness off the position. The round-8 fix asked
    // `operativeLineSet` — which deletes the opener it is asking about, inverting
    // fence parity downstream: on the head planner it reported the live "Task-level
    // TDD" fence at 0-based 233 as NON-operative, and the assertion only passed
    // because 0-based 262 happened to land in a surviving parity slot. One extra
    // live ```xml example anywhere earlier in the file flipped it to a false
    // FAILURE blaming a decoy that does not exist (review round 9).
    assert.ok(
      /^\s*```xml(?:\s.*)?$/.test(lines[openIdx]) && isOperativePosition(PLANNER, openIdx),
      'the first non-blank line after the tracer task shape marker must be a LIVE ```xml fence opener — '
      + 'a commented-out or non-adjacent decoy template must not be selectable',
    );
    const afterLines = lines.slice(openIdx);
    const xmlFence = scanFencedBlocks(afterLines).find(
      (b) => b.closeLineIdx !== -1 && /^xml(?:\s.*)?$/.test((b.infoString || '').trim()),
    );
    assert.ok(xmlFence, 'the tracer task shape must be followed by a fenced xml block');
    const fenceBody = afterLines.slice(xmlFence.openLineIdx + 1, xmlFence.closeLineIdx).join('\n');
    const verifies = fenceBody.match(/<verify>[\s\S]*?<\/verify>/g) || [];
    assert.strictEqual(verifies.length, 1, `the tracer template must contain exactly ONE <verify>, found ${verifies.length}`);
    const inner = verifies[0].replace(/^<verify>/, '').replace(/<\/verify>$/, '').replace(/\s+/g, ' ').trim();
    assert.match(inner, /^<automated>[^<>]+<\/automated>$/,
      "the tracer template's <verify> body must be exactly one non-empty <automated> child — the #3299 "
      + 'gate auto-continues only on an automated-only verify, so a bare-text template makes the fix '
      + 'unreachable for every tracer the planner generates');
  });

  test('every site reading the mode passes an explicit --default end-of-phase', () => {
    // Requires the ASSIGNMENT, not merely the command. Matching the config-get
    // substring alone let `IGNORED_MODE=$(gsd_run query config-get ...)` keep this
    // row green while nothing defines HUMAN_VERIFY_MODE — the gate then falls
    // through to STOP and #3299 is back with the regression suite still passing.
    // A test that survives the regression it exists to catch is not a test.
    // The lookahead after `end-of-phase` closes the other half: the bare prefix
    // also accepted `--default end-of-phase-wrong`. (Codex review, round 9.)
    const READ = /^\s*HUMAN_VERIFY_MODE=\$\(gsd_run query config-get workflow\.human_verify_mode --default end-of-phase(?=\s|$)/;
    // NOT operativeLineIndexes here, deliberately. All three reads live inside a
    // ```bash fence, which is their correct executable form in these files, and
    // that selector excludes fenced lines by design — using it would assert the
    // opposite of the shipped shape. What the original bare whole-file
    // assert.match genuinely could not catch is a read present ONLY inside an
    // HTML comment, or a second drifted copy alongside the live one. Pin both:
    // exactly one occurrence, inside a live fence, outside any comment.
    const BASH_FENCES = new Set(['bash', 'sh', 'shell', 'zsh']);
    const liveFencedReads = (md) => {
      let fenceLang = null, inComment = false, hits = 0;
      for (const raw of md.split(/\r?\n/)) {
        let line = raw;
        if (inComment) {
          const end = line.indexOf('-->');
          if (end === -1) continue;
          line = line.slice(end + 3);
          inComment = false;
        }
        // Strip COMPLETE <!-- ... --> spans first: a one-line comment carries both
        // delimiters, so an open/close test that only looks for an unpaired `<!--`
        // treats it as live. That gap let a fully commented-out read still count.
        line = line.replace(/<!--[\s\S]*?-->/g, '');
        const open = line.indexOf('<!--');
        if (open !== -1) { inComment = true; line = line.slice(0, open); }
        // Track the fence LANGUAGE, not just open/closed: a bare toggle counts a
        // read sitting in a ```text fence, so deleting the executable read and
        // leaving a prose copy behind would still pass. This helper is new code
        // in this change, so that gap is this PR's, not the shared selector's.
        const fence = line.match(/^\s*```([^\s`]*)/);
        if (fence) { fenceLang = fenceLang === null ? (fence[1] || '').toLowerCase() : null; continue; }
        if (!BASH_FENCES.has(fenceLang)) continue;
        // Bash comments, leading OR inline: `echo ok # HUMAN_VERIFY_MODE=...`
        // disables the read as effectively as a whole commented line. Not
        // shell-accurate about `#` inside quotes, deliberately: over-rejecting
        // costs nothing here, under-rejecting is the failure this guard exists
        // to prevent.
        if (READ.test(line.replace(/#.*$/, ''))) hits += 1;
      }
      return hits;
    };
    for (const [name, md] of [
      ['agents/gsd-executor.md', EXECUTOR],
      ['gsd-core/workflows/execute-plan.md', EXECUTE_PLAN],
      ['gsd-core/references/checkpoints.md', CHECKPOINTS],
    ]) {
      assert.strictEqual(
        liveFencedReads(md), 1,
        `${name}: must contain exactly ONE live, unfenced-by-comment \`--default end-of-phase\` read `
        + '(the key is absent from SCHEMA_DEFAULTS, so a bare config-get exits non-zero). Zero means '
        + 'the read is missing or commented out; more than one means a drifted second copy.',
      );
    }
  });

  test('config-get resolves end-of-phase when the key is absent, and never overrides a set value', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const base = { mode: 'yolo', workflow: { _auto_chain_active: false, tdd_mode: true } };
    fs.writeFileSync(configPath, JSON.stringify(base, null, 2));

    const bare = runGsdTools('query config-get workflow.human_verify_mode --raw', tmpDir);
    assert.strictEqual(bare.success, false, 'a bare config-get for an absent key must FAIL, not return empty');
    assert.notStrictEqual(bare.exitCode, 0, 'a bare config-get for an absent key must exit non-zero');
    assert.match(String(bare.error || ''), /Key not found/, 'the failure must be the Key-not-found path');

    const withDefault = runGsdTools('query config-get workflow.human_verify_mode --default end-of-phase --raw', tmpDir);
    assert.strictEqual(withDefault.success, true, '--default must succeed for an absent key');
    assert.strictEqual((withDefault.output || '').trim(), 'end-of-phase', '--default must supply the documented default');

    base.workflow.human_verify_mode = 'mid-flight';
    fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
    const setValue = runGsdTools('query config-get workflow.human_verify_mode --default end-of-phase --raw', tmpDir);
    assert.strictEqual((setValue.output || '').trim(), 'mid-flight', 'a present value must win over --default');
  });

  test('planner-human-verify-mode.md documents the executor-side seam', () => {
    // Bare presence checks are the shape this suite already logs as defeated:
    // every one of them still passes if the section is commented out or moved
    // into a fence. This file had no region pin at all, so the selector is the
    // only thing standing between it and silent removal.
    const live = (re, why) => assert.ok(operativeLineIndexes(HV_REF, re).length > 0, why);
    live(/tracer feedback gate/i, 'the reference must document the tracer gate as a mode consumer, on a live line');
    live(/#3299/, 'the reference must cite the issue so the decision is traceable, on a live line');
    live(/SCHEMA_DEFAULTS/, 'the reference must record why --default end-of-phase is mandatory, on a live line');
    live(/harvest does not cover tracers|does not cover tracers/i,
      'the reference must record WHY a human-check tracer halts (the end-of-phase harvest does not reach tracers)');
  });
});
