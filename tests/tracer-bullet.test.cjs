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
    autoHaltsOnFailure:
      /Autonomous run \(auto mode active/i.test(md) &&
      /`AUTO_CHAIN` or `AUTO_CFG`/.test(md) &&
      /HALT and surface it/i.test(md) &&
      /do NOT proceed to expansion tasks/i.test(md),
    // Interactive: the branch exists and still names checkpoint:human-verify.
    interactiveHumanVerify:
      /Interactive run \(auto mode not active\)/i.test(md) &&
      /checkpoint:human-verify/.test(md),
    // #3299: that checkpoint is now the FALLBACK, not the unconditional result.
    // Merely finding HUMAN_VERIFY_MODE on the line proves nothing — peer review
    // showed a branch can name the variable and still checkpoint unconditionally.
    // Require the ordered clause markers AND that the auto-continue clause is
    // free of any STOP outcome, which is what "conditional" actually means here.
    interactiveIsConditional: (() => {
      const m = md.match(/Interactive run \(auto mode not active\):\*\*([^\n]*)/i);
      if (!m) return false;
      const body = m[1];
      const iF = body.indexOf('First,'), iN = body.indexOf('Next,'), iO = body.indexOf('Otherwise');
      if (!(iF > -1 && iN > iF && iO > iN)) return false;
      const autoContinue = body.slice(iN, iO);
      return /HUMAN_VERIFY_MODE/.test(body) && !/\bSTOP\b/.test(autoContinue);
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

  // Asserting only that the row EXISTS is what let the canonical schema table
  // drift out of sync with shipped behavior after #3299 without CI noticing —
  // CONTEXT.md names this file the canonical reference for the task-type
  // contract, so a wrong row here is the authoritative wrong answer. Assert the
  // row's CONTENT against the behavior actually shipped.
  // Keyword presence in this row is not enough: peer review defeated an earlier
  // revision by APPENDING "Nevertheless, interactive runs always present a
  // checkpoint:human-verify." — every required keyword still matched, so the
  // canonical schema reference could contradict itself with CI green. Pin the
  // Autonomy cell EXACTLY. This is deliberately brittle: it is the canonical
  // contract, so a wording change here must be a conscious edit in both places.
  test('docs/reference/plan-md.md tracer row Autonomy cell matches shipped behavior exactly', () => {
    const row = (PLAN_MD_REF.split(/\r?\n/).find((l) => l.startsWith('| `tracer` |')) || '');
    assert.ok(row, 'plan-md.md Task types table must include a tracer row');
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    assert.strictEqual(cells.length, 3, `tracer row must have 3 cells, got ${cells.length}`);
    const autonomy = cells[2].replace(/\s+/g, ' ').trim();
    const EXPECTED = 'Fully autonomous; after committing, the executor runs the tracer\'s `<verify>` '
      + 'as an early integration gate. Autonomous runs halt on failure before expansion. '
      + 'Interactive runs honor `workflow.human_verify_mode` (#3299): under the `end-of-phase` '
      + 'default a `<verify>` carrying only `<automated>` is re-run and, on success, expansion '
      + 'continues with **no** checkpoint (failure still halts); under `mid-flight`, or when the '
      + 'tracer carries `<human-check>` or `gate="blocking-human"`, a `checkpoint:human-verify` is '
      + 'presented. Full precedence chain: `references/checkpoints.md` → "Tracer feedback gate".';
    assert.strictEqual(
      autonomy,
      EXPECTED,
      'plan-md.md tracer Autonomy cell drifted from the shipped gate contract. This table is the '
      + 'canonical schema reference (per CONTEXT.md) — if the behavior genuinely changed, update '
      + 'the cell AND this expected string together; do not relax the assertion.',
    );
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

  // ── Why this suite is shaped the way it is ─────────────────────────────────
  //
  // These files are prose an LLM executes, so a regression test has to prove the
  // OPERATIVE text is right — not that some correct-looking text exists somewhere
  // in the file. Five rounds of adversarial review defeated weaker shapes, each
  // leaving the full suite green while the reported bug shipped:
  //
  //   1. keyword presence          -> reverting the rule entirely passed
  //   2. keyword presence + names  -> `blocking-human AND mid-flight` passed
  //   3. blacklisting `STOP`       -> "pause and invoke checkpoint_protocol" passed
  //   4. exact-pinning one clause  -> an override sentence ABOVE the clause passed
  //   5. exact pin + `<!--` check  -> a commented DECOY copy above a live wrong one passed
  //
  // The shape that holds: strip comments first (so a commented decoy cannot be
  // selected), require the structural anchor to appear EXACTLY ONCE (so a live
  // second copy cannot hide), and pin the ENTIRE decision region rather than one
  // clause (so no unparsed prefix/suffix can override it).
  const stripComments = (md) => md.replace(/<!--[\s\S]*?-->/g, '');

  function soleRegion(name, md, startMarker, endRe) {
    const clean = stripComments(md);
    const occurrences = clean.split(startMarker).length - 1;
    assert.strictEqual(occurrences, 1,
      `${name}: expected exactly ONE "${startMarker}" in the comment-stripped file, found ${occurrences}. ` +
      `A second copy means the pin below may be checking a decoy while different text ships.`);
    const s = clean.indexOf(startMarker);
    const rest = clean.slice(s);
    const m = endRe ? rest.match(endRe) : null;
    const region = m ? rest.slice(0, m.index) : rest;
    assert.ok(region.length > 200, `${name}: extracted region is implausibly short (${region.length}) — extractor is stale`);
    return region.replace(/\s+/g, ' ').trim();
  }

  // The complete operative decision region for each copy an agent actually reads.
  // Pinned whole: an override sentence inserted anywhere inside the region breaks
  // equality even when every individual clause is untouched.
  const OPERATIVE = [
    ['agents/gsd-executor.md', () => soleRegion('agents/gsd-executor.md', EXECUTOR, '2. **If `type="tracer"`:**', /\r?\n3\. \*\*If /),
     "2. **If `type=\"tracer\"`:** - Execute and commit exactly like `type=\"auto\"`. - **Then run the tracer feedback gate BEFORE any expansion task** \u2014 an early integration checkpoint: - **Autonomous run (auto mode active \u2014 `AUTO_CHAIN` or `AUTO_CFG` is `\"true\"`, per `<auto_mode_detection>`):** re-run the tracer's `<verify>`. If it **fails**, HALT and surface it (deviation Rule 1) \u2014 do NOT proceed to expansion tasks. If it passes, log `\u26a1 Tracer verified end-to-end \u2014 expanding` and continue. - **Interactive run (auto mode not active):** evaluate in order (#3299). First, `gate=\"blocking-human\"` \u2192 STOP. Next, `HUMAN_VERIFY_MODE` is `end-of-phase` AND `<verify>` carries only `<automated>` (no `<human-check>`) \u2192 re-run it: on **failure** HALT and surface it as a deviation exactly as above \u2014 never a checkpoint; on success continue with NO checkpoint. Otherwise (`mid-flight`, or `<human-check>` present) \u2192 STOP, return a `checkpoint:human-verify` for the tracer."],
    ['gsd-core/workflows/execute-plan.md', () => {
      const clean = stripComments(EXECUTE_PLAN);
      const lines = clean.split(/\r?\n/).filter((l) => l.includes('`type="tracer"`') && /tracer feedback gate/i.test(l));
      assert.strictEqual(lines.length, 1,
        `execute-plan.md: expected exactly ONE tracer dispatch line, found ${lines.length}`);
      return lines[0].replace(/\s+/g, ' ').trim();
    }, "- `type=\"tracer\"`: execute like `type=\"auto\"` (production-quality, real `<verify>`, commit), then run the tracer feedback gate BEFORE any expansion task \u2014 an early integration checkpoint. Auto mode active (`AUTO_CHAIN` or `AUTO_CFG`): re-run the tracer `<verify>`; on failure HALT and surface (deviation) \u2014 do NOT start expansion tasks. Interactive (auto mode not active) \u2014 evaluate in order (#3299). First, `gate=\"blocking-human\"` \u2192 STOP. Next, `HUMAN_VERIFY_MODE` is `end-of-phase` (default) AND the tracer's `<verify>` carries only `<automated>` (no `<human-check>`) \u2192 re-run the tracer `<verify>`; on failure HALT and surface as a deviation exactly as in the auto-mode branch \u2014 never a checkpoint; on success log `\u26a1 Tracer verified end-to-end \u2014 expanding` and continue to expansion, do NOT synthesize a checkpoint. Otherwise (`mid-flight`, or the tracer carries genuine human-observable evidence) \u2192 STOP \u2192 return a `checkpoint:human-verify` for the tracer via checkpoint_protocol before expansion."],
  ];

  test('the complete operative gate region is pinned in both copies', () => {
    for (const [name, extract, expected] of OPERATIVE) {
      assert.strictEqual(extract(), expected,
        `${name}: the tracer gate's decision region drifted from its pinned contract.\n\n` +
        `This region is pinned WHOLE on purpose: pinning only the auto-continue clause let an ` +
        `unconditional override sentence be added beside it with every assertion still passing. ` +
        `If the behavior genuinely changed, update the prose AND this expected string together; ` +
        `do not narrow the assertion.`);
    }
  });

  // Same treatment for the canonical precedence chain the executor points at.
  test('the canonical checkpoints.md tracer section is pinned whole', () => {
    const sec = soleRegion('checkpoints.md', CHECKPOINTS, '### Tracer feedback gate (#3299)', /\r?\n### |\r?\n<type /);
    assert.strictEqual(sec, "### Tracer feedback gate (#3299) A `type=\"tracer\"` task is followed by an early integration checkpoint on the proven slice, run BEFORE any expansion task. This checkpoint is **synthesized by the executor at runtime** \u2014 no planner emits it \u2014 so planner-side `human_verify_mode` suppression cannot reach it. It must therefore consult the mode itself. Evaluate the rows **in order** and take the first that matches \u2014 they are a precedence chain, not independent conditions: | # | Run | Tracer `<verify>` | Behavior | |---|---|---|---| | 1 | Interactive, any mode | task carries `gate=\"blocking-human\"` | **STOP \u2192 `checkpoint:human-verify`.** Never auto-continued. | | 2 | Auto mode active (`AUTO_CHAIN`/`AUTO_CFG`) | any | Re-run verify; HALT on failure, continue on success. **Pre-existing behavior \u2014 unchanged by #3299.** | | 3 | Interactive, `end-of-phase` (default) | only `<automated>` | Re-run verify; HALT on failure, continue to expansion on success \u2014 **no checkpoint** | | 4 | Interactive, `end-of-phase` | carries `<human-check>` | STOP \u2192 `checkpoint:human-verify` | | 5 | Interactive, `mid-flight` | any | STOP \u2192 `checkpoint:human-verify` | **Carve-outs \u2014 the #3299 auto-continue (row 3) applies ONLY when all three hold:** the run is interactive, the mode is `end-of-phase`, and the tracer's `<verify>` contains only `<automated>`. Anything else STOPs or falls to the pre-existing auto-mode branch. HALT-on-failure is unconditional in rows 2 and 3 alike: a failing tracer never becomes an approvable checkpoint and never proceeds to expansion, because layering expansion onto a broken slice is the failure this gate exists to prevent. Row 2 is deliberately left as-is: whether an autonomous run should also stop for a tracer carrying `gate=\"blocking-human\"` is **pre-existing behavior outside #3299's scope** (the issue's Agent Brief names the autonomous branch as out of scope). No planner emits `gate` on a `type=\"tracer\"` task today, so the combination is currently unreachable; row 1 is scoped to interactive runs so this reference states one rule rather than two conflicting ones. Read `HUMAN_VERIFY_MODE` with an explicit default \u2014 `workflow.human_verify_mode` is absent from `SCHEMA_DEFAULTS`, so a bare `config-get` exits non-zero with `Key not found` on any project whose `config.json` predates #3309: ```bash HUMAN_VERIFY_MODE=$(gsd_run query config-get workflow.human_verify_mode --default end-of-phase --raw 2>/dev/null || echo \"end-of-phase\") ``` </type>",
      'checkpoints.md tracer-gate section drifted. Pinned whole so behavior-bearing prose cannot be ' +
      'added around the table (an "ignore row 3, always wait" line below it previously passed).');
  });

  // The canonical schema reference. Comment-stripped and uniqueness-checked so a
  // commented decoy row cannot satisfy the cell pin while a live wrong row ships.
  test('docs/reference/plan-md.md tracer row Autonomy cell matches shipped behavior exactly', () => {
    const clean = stripComments(PLAN_MD_REF);
    const rows = clean.split(/\r?\n/).filter((l) => l.startsWith('| `tracer` |'));
    assert.strictEqual(rows.length, 1, `plan-md.md must have exactly ONE tracer row, found ${rows.length}`);
    const cells = rows[0].replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    assert.strictEqual(cells.length, 3, `tracer row must have 3 cells, got ${cells.length}`);
    assert.strictEqual(cells[2].replace(/\s+/g, ' ').trim(), "Fully autonomous; after committing, the executor runs the tracer's `<verify>` as an early integration gate. Autonomous runs halt on failure before expansion. Interactive runs honor `workflow.human_verify_mode` (#3299): under the `end-of-phase` default a `<verify>` carrying only `<automated>` is re-run and, on success, expansion continues with **no** checkpoint (failure still halts); under `mid-flight`, or when the tracer carries `<human-check>` or `gate=\"blocking-human\"`, a `checkpoint:human-verify` is presented. Full precedence chain: `references/checkpoints.md` \u2192 \"Tracer feedback gate\".",
      'plan-md.md tracer Autonomy cell drifted from the shipped gate contract. CONTEXT.md names this ' +
      'table the canonical schema reference — update the cell AND this expected string together.');
  });

  // The planner template is what makes the fix reachable at all: the gate
  // auto-continues only on a <verify> carrying ONLY <automated>, so a bare-text
  // template made #3299 inert on the default tracer-first path (review round 3).
  // Structural, not copy-pinned: the contract is the shape, so a wording
  // improvement to the placeholder must not fail (review round 5, Minor).
  test('planner tracer template emits exactly one <automated>-wrapped verify', () => {
    const clean = stripComments(PLANNER);
    const marker = '**Tracer task shape:**';
    assert.strictEqual(clean.split(marker).length - 1, 1, 'planner must have exactly ONE tracer task shape block');
    const after = clean.slice(clean.indexOf(marker));
    const fence = after.match(/```xml\r?\n([\s\S]*?)```/);
    assert.ok(fence, 'the tracer task shape must be a fenced xml block');
    const verifies = fence[1].match(/<verify>[\s\S]*?<\/verify>/g) || [];
    assert.strictEqual(verifies.length, 1, `the tracer template must contain exactly ONE <verify>, found ${verifies.length}`);
    const inner = verifies[0].replace(/^<verify>/, '').replace(/<\/verify>$/, '').replace(/\s+/g, ' ').trim();
    assert.match(inner, /^<automated>[^<>]+<\/automated>$/,
      'the tracer template\'s <verify> body must be exactly one non-empty <automated> child — the #3299 ' +
      'gate auto-continues only on an automated-only verify, so a bare-text template makes the fix ' +
      'unreachable for every tracer the planner generates');
  });

  // Every site reading the mode must pass --default: the key is absent from
  // SCHEMA_DEFAULTS, so a bare read fails on any project predating #3309.
  test('every site reading the mode passes an explicit --default end-of-phase', () => {
    for (const [name, md] of [
      ['agents/gsd-executor.md', EXECUTOR],
      ['gsd-core/workflows/execute-plan.md', EXECUTE_PLAN],
      ['gsd-core/references/checkpoints.md', CHECKPOINTS],
    ]) {
      assert.match(md, /config-get workflow\.human_verify_mode --default end-of-phase/,
        `${name}: must pass --default end-of-phase (the key is absent from SCHEMA_DEFAULTS)`);
    }
  });

  // Behavioral counterpart: prove the CLI contract the whole fix rests on.
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

  // The gap existed because planner-side suppression could not reach an
  // executor-synthesized checkpoint and nothing documented that seam.
  test('planner-human-verify-mode.md documents the executor-side seam', () => {
    assert.match(HV_REF, /tracer feedback gate/i, 'the reference must document the tracer gate as a mode consumer');
    assert.match(HV_REF, /#3299/, 'the reference must cite the issue so the decision is traceable');
    assert.match(HV_REF, /SCHEMA_DEFAULTS/, 'the reference must record why --default end-of-phase is mandatory');
    assert.match(HV_REF, /harvest does not cover tracers|does not cover tracers/i,
      'the reference must record WHY a human-check tracer halts (the end-of-phase harvest does not reach tracers)');
  });
});
