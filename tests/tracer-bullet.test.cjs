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
    // Interactive: emit checkpoint:human-verify immediately after the tracer.
    interactiveHumanVerify:
      /Interactive run \(auto mode not active\)/i.test(md) &&
      /checkpoint:human-verify/.test(md),
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

  // Acceptance: interactive run presents a human-verify checkpoint after the tracer.
  test('interactive run emits checkpoint:human-verify after the tracer (acceptance #4)', () => {
    assert.ok(c.interactiveHumanVerify, 'interactive run must emit checkpoint:human-verify immediately after the tracer');
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

  test('docs/reference/plan-md.md task-types table includes tracer', () => {
    assert.match(PLAN_MD_REF, /\| `tracer` \|/, 'plan-md.md Task types table must include a tracer row');
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

  // ── Scope the assertions to the DECISION POINT, not the whole file ──────────
  //
  // This is the load-bearing part of the suite. An earlier revision asserted
  // against the whole file and was VACUOUS on the executor path: reverting
  // agents/gsd-executor.md's interactive branch to its pre-#3299 unconditional
  // "STOP -> checkpoint:human-verify" left every assertion passing, because the
  // strings they matched lived in the config read and the reference pointer
  // rather than in the rule itself. The bug could return with CI green — which
  // is exactly the duplicate-copy drift that produced #3299. Each extractor
  // below returns ONLY the tracer gate's interactive branch, so a mutation of
  // that branch has nowhere to hide.

  // agents/gsd-executor.md: the `2. **If type="tracer":**` list item, up to the
  // next numbered item.
  function executorTracerGate(md) {
    const start = md.indexOf('2. **If `type="tracer"`:**');
    assert.notStrictEqual(start, -1, 'executor tracer task branch not found — extractor is stale, fix it before trusting this suite');
    const rest = md.slice(start);
    const end = rest.search(/\n3\. \*\*If /);
    assert.notStrictEqual(end, -1, 'executor tracer branch terminator not found — extractor is stale');
    return rest.slice(0, end);
  }

  // gsd-core/workflows/execute-plan.md: the single `- type="tracer":` dispatch line.
  function executePlanTracerGate(md) {
    const line = md.split(/\r?\n/).find((l) => l.includes('`type="tracer"`') && /tracer feedback gate/i.test(l));
    assert.ok(line, 'execute-plan.md tracer dispatch line not found — extractor is stale');
    return line;
  }

  // Both operative copies, keyed by the file an agent would actually be reading.
  const GATES = [
    ['agents/gsd-executor.md', executorTracerGate(EXECUTOR)],
    ['gsd-core/workflows/execute-plan.md', executePlanTracerGate(EXECUTE_PLAN)],
  ];

  // Guard the extractors themselves: if they ever silently return the pre-fix
  // text (or nothing), every assertion below would pass vacuously again.
  test('extractors isolate a real, non-trivial decision point in both copies', () => {
    for (const [name, gate] of GATES) {
      assert.ok(gate.length > 120, `${name}: extracted gate is implausibly short (${gate.length} chars) — extractor is broken`);
      assert.match(gate, /Interactive/i, `${name}: extracted gate must contain the interactive branch`);
    }
  });

  // ── Clause-level parsing: bind CONDITION to ACTION, and pin ORDER ──────────
  //
  // Peer review (round 2) defeated an earlier revision of this suite that only
  // checked vocabulary: mutating `blocking-human -> STOP` into
  // `blocking-human AND HUMAN_VERIFY_MODE is mid-flight -> STOP` makes an
  // interactive end-of-phase tracer carrying blocking-human fall through and
  // auto-continue — a genuine safety bypass — and all 37 assertions still
  // passed, because every token it looked for was still present somewhere in
  // the region. Presence is not binding. These helpers split the interactive
  // branch into its ordered clauses so each condition is asserted against its
  // own action, and the order is asserted as an order.

  // Both operative copies use the same First / Next / Otherwise clause markers
  // precisely so one parser can hold them to the same contract.
  function interactiveClauses(name, gate) {
    const m = gate.match(/Interactive[^\n]*?evaluate in order \(#3299\)\.?\s*([\s\S]*)$/);
    assert.ok(m, `${name}: interactive branch must open with "evaluate in order (#3299)"`);
    const body = m[1];
    const iFirst = body.indexOf('First,');
    const iNext = body.indexOf('Next,');
    const iElse = body.indexOf('Otherwise');
    assert.ok(iFirst === 0 || iFirst > -1, `${name}: missing "First," clause`);
    assert.ok(iNext > iFirst, `${name}: "Next," clause must follow "First," — precedence order is the contract`);
    assert.ok(iElse > iNext, `${name}: "Otherwise" clause must come last — it is the fallback`);
    return {
      blocking: body.slice(iFirst, iNext),
      automated: body.slice(iNext, iElse),
      fallback: body.slice(iElse),
    };
  }

  test('clause 1 stops on blocking-human UNCONDITIONALLY in both copies', () => {
    for (const [name, gate] of GATES) {
      const c = interactiveClauses(name, gate);
      assert.match(c.blocking, /blocking-human/, `${name}: clause 1 must be the blocking-human clause`);
      assert.match(c.blocking, /STOP/, `${name}: clause 1 must STOP`);
      // The mutation that defeated the previous suite: qualifying this clause on
      // a mode makes blocking-human bypassable under end-of-phase.
      assert.doesNotMatch(
        c.blocking,
        /\bAND\b|\bOR\b|mid-flight|end-of-phase|HUMAN_VERIFY_MODE/,
        `${name}: clause 1 must be UNCONDITIONAL — qualifying blocking-human on a mode makes it bypassable`,
      );
    }
  });

  test('clause 2 binds end-of-phase + automated-only to re-run, HALT on failure, continue on success', () => {
    for (const [name, gate] of GATES) {
      const c = interactiveClauses(name, gate);
      assert.match(c.automated, /end-of-phase/, `${name}: clause 2 must be gated on end-of-phase`);
      assert.match(c.automated, /only `<automated>`/, `${name}: clause 2 must require automated-only evidence`);
      assert.match(c.automated, /no `<human-check>`/, `${name}: clause 2 must exclude <human-check>`);
      assert.match(c.automated, /failure[^.;]*HALT/i, `${name}: clause 2 must bind HALT to the failure case`);
      assert.match(c.automated, /never a checkpoint/i, `${name}: clause 2 must forbid turning a failure into a checkpoint`);
      assert.match(c.automated, /success[^.;]*continue/i, `${name}: clause 2 must bind continue to the success case`);
    }
  });

  test('clause 3 is the STOP fallback covering mid-flight and human-check', () => {
    for (const [name, gate] of GATES) {
      const c = interactiveClauses(name, gate);
      assert.match(c.fallback, /mid-flight/, `${name}: the fallback must name mid-flight`);
      assert.match(c.fallback, /STOP/, `${name}: the fallback must STOP`);
      assert.match(c.fallback, /checkpoint:human-verify/, `${name}: the fallback must return checkpoint:human-verify`);
      assert.doesNotMatch(
        c.fallback,
        /continue with NO checkpoint|do NOT synthesize/i,
        `${name}: the fallback must never auto-continue`,
      );
    }
  });

  // Every site that reads the mode must pass --default: the key is absent from
  // SCHEMA_DEFAULTS, so a bare read fails closed-but-empty on legacy projects.
  test('every site reading the mode passes an explicit --default end-of-phase', () => {
    for (const [name, md] of [
      ['agents/gsd-executor.md', EXECUTOR],
      ['gsd-core/workflows/execute-plan.md', EXECUTE_PLAN],
      ['gsd-core/references/checkpoints.md', CHECKPOINTS],
    ]) {
      assert.match(
        md,
        /config-get workflow\.human_verify_mode --default end-of-phase/,
        `${name}: must pass --default end-of-phase (the key is absent from SCHEMA_DEFAULTS)`,
      );
    }
  });

  // Behavioral: prove the CLI contract the whole fix rests on, rather than
  // trusting the flag is spelled correctly. Absent key -> documented default;
  // present key -> the operator's value always wins over --default.
  test('config-get resolves end-of-phase when the key is absent, and never overrides a set value', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const configPath = path.join(tmpDir, '.planning', 'config.json');

    // The reporter's exact config shape (issue #3299): human_verify_mode absent
    // entirely — the pre-#3309 project shape every existing user still has.
    const base = { mode: 'yolo', workflow: { _auto_chain_active: false, tdd_mode: true } };
    fs.writeFileSync(configPath, JSON.stringify(base, null, 2));

    // Precondition — and the entire reason --default is mandatory. Assert the
    // FAILURE explicitly (exit code + message), not merely "output was empty":
    // an empty successful result would satisfy a laxer check while meaning
    // something completely different.
    const bare = runGsdTools('query config-get workflow.human_verify_mode --raw', tmpDir);
    assert.strictEqual(bare.success, false, 'a bare config-get for an absent key must FAIL, not return empty');
    assert.notStrictEqual(bare.exitCode, 0, 'a bare config-get for an absent key must exit non-zero');
    assert.match(String(bare.error || ''), /Key not found/, 'the failure must be the Key-not-found path, not some other error');

    const withDefault = runGsdTools('query config-get workflow.human_verify_mode --default end-of-phase --raw', tmpDir);
    assert.strictEqual(withDefault.success, true, '--default must succeed for an absent key');
    assert.strictEqual((withDefault.output || '').trim(), 'end-of-phase', '--default must supply the documented default');

    // An operator who opted back into mid-flight must not be silently overridden.
    base.workflow.human_verify_mode = 'mid-flight';
    fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
    const setValue = runGsdTools('query config-get workflow.human_verify_mode --default end-of-phase --raw', tmpDir);
    assert.strictEqual(setValue.success, true, 'a present value must resolve successfully');
    assert.strictEqual((setValue.output || '').trim(), 'mid-flight', 'a present value must win over --default');
  });

  // agents/gsd-executor.md is LARGE tier against a 49152-byte HARD cap
  // (tests/agent-size-budget.test.cjs) and had 154 bytes of headroom at the
  // merge-base, so it carries the rule and delegates the precedence table to
  // checkpoints.md — which <checkpoint_protocol> already @-imports, so nothing
  // new is loaded. That is only safe while the terse copy points at the
  // canonical one; an orphaned pointer is how two copies drift apart.
  test('the terse executor copy points at the canonical rule, which exists', () => {
    assert.match(
      EXECUTOR,
      /full rule in "Tracer feedback gate", checkpoints\.md/,
      'gsd-executor.md must point at the canonical tracer-gate rule',
    );
    assert.match(
      CHECKPOINTS,
      /### Tracer feedback gate \(#3299\)/,
      'checkpoints.md must carry the canonical tracer-gate section the executor points to',
    );
  });

  // The canonical table is a PRECEDENCE CHAIN. Peer review round 1 caught an
  // earlier revision that listed auto-mode as "any verify -> continue" while
  // also claiming auto-continue required automated-only evidence — two rules an
  // agent could follow to opposite conclusions, one unsafe. Round 2 caught that
  // asserting on the table's TEXT rather than its ROWS could not tell a correct
  // table from a reordered or re-celled one. So: parse the rows, assert cells.
  function canonicalTracerRows(md) {
    const secStart = md.indexOf('### Tracer feedback gate (#3299)');
    assert.notStrictEqual(secStart, -1, 'checkpoints.md must carry the canonical tracer-gate section');
    const rest = md.slice(secStart);
    const secEnd = rest.search(/\n### |\n<type /);
    const section = secEnd === -1 ? rest : rest.slice(0, secEnd);
    const rows = section
      .split(/\r?\n/)
      .filter((l) => /^\s*\|/.test(l))
      .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
      .filter((cells) => !cells.every((c) => /^-+$/.test(c) || c === ''));
    // drop the header row
    const header = rows.shift();
    assert.ok(header && /run/i.test(header.join(' ')), 'tracer-gate table header not found — parser is stale');
    return rows;
  }

  test('the canonical table is an ordered precedence chain with the right cells', () => {
    assert.match(CHECKPOINTS, /in order/i, 'checkpoints.md must state the rows are evaluated in order');
    const rows = canonicalTracerRows(CHECKPOINTS);
    assert.ok(rows.length >= 5, `expected at least 5 precedence rows, got ${rows.length}`);

    // Rows are numbered in column 0; they must be 1..N in order — a shuffled
    // table would still contain all the same words.
    rows.forEach((cells, idx) => {
      assert.strictEqual(cells[0], String(idx + 1), `row ${idx + 1} must carry its precedence number in column 1`);
    });

    const row = (n) => rows[n - 1].join(' | ');

    // Row 1 outranks everything and must STOP unconditionally.
    assert.match(row(1), /blocking-human/, 'row 1 must be the blocking-human row — it outranks every other condition');
    assert.match(row(1), /STOP/, 'row 1 must STOP');
    assert.match(row(1), /Never auto-continued/i, 'row 1 must state explicitly that it is never auto-continued');
    assert.doesNotMatch(row(1), /no checkpoint/i, 'row 1 must never be a no-checkpoint row');

    // Row 2 is the pre-existing autonomous branch, explicitly out of #3299 scope.
    assert.match(row(2), /Auto mode active/i, 'row 2 must be the autonomous branch');
    assert.match(row(2), /unchanged by #3299/i, 'row 2 must be marked out of #3299 scope so the table reads as one rule');

    // Row 3 is the ONLY row this fix makes continue.
    assert.match(row(3), /end-of-phase/, 'row 3 must be the end-of-phase interactive row');
    assert.match(row(3), /only `<automated>`/, 'row 3 must require automated-only evidence');
    assert.match(row(3), /no checkpoint/i, 'row 3 is the row that continues without a checkpoint');

    // Rows 4-5 must STOP, never continue.
    for (const n of [4, 5]) {
      assert.match(row(n), /STOP/, `row ${n} must STOP`);
      assert.doesNotMatch(row(n), /no checkpoint/i, `row ${n} must not auto-continue`);
    }
    assert.match(row(4), /human-check/, 'row 4 must be the human-check row');
    assert.match(row(5), /mid-flight/, 'row 5 must be the mid-flight row');
  });

  // The gap existed because planner-side suppression could not reach an
  // executor-synthesized checkpoint and nothing documented that seam.
  test('planner-human-verify-mode.md documents the executor-side seam', () => {
    assert.match(HV_REF, /tracer feedback gate/i, 'the reference must document the tracer gate as a mode consumer');
    assert.match(HV_REF, /#3299/, 'the reference must cite the issue so the decision is traceable');
    assert.match(HV_REF, /SCHEMA_DEFAULTS/, 'the reference must record why --default end-of-phase is mandatory');
    // The harvest seam is the decisive reason a <human-check> tracer halts
    // rather than deferring: gsd-verifier harvests auto tasks, not tracers.
    assert.match(
      HV_REF,
      /harvest does not cover tracers|does not cover tracers/i,
      'the reference must record WHY a human-check tracer halts (the end-of-phase harvest does not reach tracers)',
    );
  });
});
