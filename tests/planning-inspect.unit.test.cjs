'use strict';

/**
 * FAST, IN-PROCESS mutation-testing surface for `planning-inspect.cjs`,
 * `plan-document.cjs`, and `planning-command-router.cjs` (#2790).
 *
 * Root cause this file exists to fix: `tests/planning-inspect.test.cjs` is
 * INTEGRATION-shaped — it spawns a `gsd-tools` child process per case via
 * `runGsdTools`. Stryker's command runner treats a `node --test <file>`
 * invocation as ONE test costing whatever the slowest case costs (measured in
 * CI: ~20s), and re-runs that whole file once per mutant. 640 mutants x 20s
 * cannot finish inside a 15-minute shard cap — CI evidence: two shards were
 * CANCELLED at 4% (27/640) after ~3 elapsed minutes. This file is the
 * dedicated, spawn-free mutation surface `scripts/mutation-matrix.cjs`
 * repoints those three modules' shards at; the integration suite keeps
 * running unmodified in the normal (non-mutation) test job.
 *
 * NEVER spawn a child process here — no `runGsdTools`, `spawnSync`,
 * `execFileSync`, or CLI invocation of any kind. Every case below requires
 * the BUILT `.cjs` artifacts directly and calls their exports in-process.
 * `plan-document.cjs` needs no filesystem at all (pure `(content) -> object`
 * parser); `planning-command-router.cjs` is driven with a recording mock and
 * needs no filesystem; `planning-inspect.cjs` needs small `.planning/`
 * fixtures on disk (cheap disk I/O, not the cost this file exists to avoid)
 * under `os.tmpdir()`.
 *
 * Every fixture shape and every asserted value below was verified by
 * requiring the built libs directly and inspecting the real returned object
 * — never guessed from reading the source alone (CLAUDE.md "verify
 * assertions by executing, not retyping").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  parsePlanDocument,
  planIdFromFile,
  TASK_KIND,
} = require('../gsd-core/bin/lib/plan-document.cjs');

const {
  routePlanningCommand,
  PLANNING_SUBCOMMANDS,
} = require('../gsd-core/bin/lib/planning-command-router.cjs');

const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');
const {
  buildPlanningInspect,
  INSPECT_DIAGNOSTIC,
  TASK_STATUS,
  PROVENANCE,
  AGREEMENT,
} = planningInspectLib;

// ─── Shared fs fixture helpers (planning-inspect only) ────────────────────────

function writeAbs(fullPath, content) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function writeFile(cwd, relPath, content) {
  writeAbs(path.join(cwd, relPath), content);
}

function mkCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planning-inspect-unit-'));
}

function frontmatterDoc(fmLines, bodyLines) {
  return ['---', ...fmLines, '---', '', ...bodyLines].join('\n');
}

function phaseDirOf(cwd, token) {
  return path.join(cwd, '.planning', 'phases', token);
}

function diagnosticCodes(payload) {
  return payload.diagnostics.map((d) => d.code);
}

// ═══════════════════════════════════════════════════════════════════════════
// plan-document.cjs — pure, in-memory parser
// ═══════════════════════════════════════════════════════════════════════════

describe('plan-document — objective extraction', () => {
  test('extracts the first line after an <objective> tag', () => {
    const parsed = parsePlanDocument(['<objective>', 'Ship the thing', '</objective>'].join('\n'));
    assert.strictEqual(parsed.objective, 'Ship the thing');
  });

  test('falls back to frontmatter objective when no <objective> tag is present', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['objective: From frontmatter'], ['no objective tag here']));
    assert.strictEqual(parsed.objective, 'From frontmatter');
  });

  test('is null when neither the tag nor frontmatter carries an objective', () => {
    const parsed = parsePlanDocument('no objective anywhere');
    assert.strictEqual(parsed.objective, null);
  });

  test('prefers the <objective> tag over frontmatter when both are present', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['objective: From frontmatter'], ['<objective>', 'From tag', '</objective>']));
    assert.strictEqual(parsed.objective, 'From tag');
  });
});

describe('plan-document — task grammar', () => {
  test('parses one <task> block with name/files/acceptance/done', () => {
    const parsed = parsePlanDocument([
      '<tasks>',
      '<task type="auto">',
      '  <name>  Task One  </name>',
      '  <files>a.ts, b.ts</files>',
      '  <acceptance_criteria>',
      '- criterion one',
      '* criterion two',
      '  </acceptance_criteria>',
      '  <done>  All done  </done>',
      '</task>',
      '</tasks>',
    ].join('\n'));
    assert.strictEqual(parsed.tasks.length, 1);
    const [task] = parsed.tasks;
    assert.strictEqual(task.index, 1);
    assert.strictEqual(task.kind, TASK_KIND.AUTO);
    assert.strictEqual(task.type, 'auto');
    assert.strictEqual(task.name, 'Task One');
    assert.deepStrictEqual(task.plannedFiles, ['a.ts', 'b.ts']);
    assert.deepStrictEqual(task.acceptanceCriteria, ['criterion one', 'criterion two']);
    assert.strictEqual(task.done, 'All done');
    assert.strictEqual(parsed.taskCount, parsed.tasks.length);
  });

  test('splits <files> on newlines as well as commas', () => {
    const parsed = parsePlanDocument([
      '<task type="auto">',
      '  <files>',
      'a.ts',
      'b.ts',
      '  </files>',
      '</task>',
    ].join('\n'));
    assert.deepStrictEqual(parsed.tasks[0].plannedFiles, ['a.ts', 'b.ts']);
  });

  test('falls back to ## Task N headings when no <task> blocks exist', () => {
    const parsed = parsePlanDocument([
      '## Task 1: Do the thing',
      'some body text',
      '## Task 2: Do another thing',
    ].join('\n'));
    assert.strictEqual(parsed.tasks.length, 2);
    assert.strictEqual(parsed.taskCount, 2);
    assert.strictEqual(parsed.tasks[0].name, 'Task 1: Do the thing');
    assert.strictEqual(parsed.tasks[0].type, null);
    assert.deepStrictEqual(parsed.tasks[0].plannedFiles, []);
    assert.strictEqual(parsed.tasks[1].index, 2);
    assert.strictEqual(parsed.tasks[1].name, 'Task 2: Do another thing');
  });

  test('prefers <task> blocks over ## Task N headings when both are present', () => {
    const parsed = parsePlanDocument([
      '## Task 1: Legacy heading',
      '<task type="auto">',
      '  <name>Real task</name>',
      '</task>',
    ].join('\n'));
    assert.strictEqual(parsed.tasks.length, 1);
    assert.strictEqual(parsed.tasks[0].name, 'Real task');
  });

  test('a checkpoint task carries no name/files/acceptance/done, even if present in the tag', () => {
    const parsed = parsePlanDocument([
      '<task type="checkpoint:manual">',
      '  <decision>Ship it?</decision>',
      '  <name>Should be ignored</name>',
      '</task>',
    ].join('\n'));
    const [task] = parsed.tasks;
    assert.strictEqual(task.kind, TASK_KIND.CHECKPOINT);
    assert.strictEqual(task.type, 'checkpoint:manual');
    assert.strictEqual(task.name, null);
    assert.deepStrictEqual(task.plannedFiles, []);
    assert.deepStrictEqual(task.acceptanceCriteria, []);
    assert.strictEqual(task.done, null);
  });

  test('checkpoint type detection is case-insensitive and prefix-only', () => {
    const parsed = parsePlanDocument('<task type="CHECKPOINT:Manual"></task>');
    assert.strictEqual(parsed.tasks[0].kind, TASK_KIND.CHECKPOINT);
  });

  test('an unclosed <task> block is bounded by the next opening tag, never swallowing siblings', () => {
    const parsed = parsePlanDocument([
      '<task type="auto">',
      '  <name>First (unclosed)</name>',
      '<task type="auto">',
      '  <name>Second</name>',
      '</task>',
    ].join('\n'));
    assert.strictEqual(parsed.tasks.length, 2);
    assert.strictEqual(parsed.taskCount, 2);
    assert.strictEqual(parsed.tasks[0].name, 'First (unclosed)');
    assert.strictEqual(parsed.tasks[1].name, 'Second');
  });

  test('an unclosed final <task> block runs to end of document', () => {
    const parsed = parsePlanDocument(['<task type="auto">', '  <name>Only task</name>'].join('\n'));
    assert.strictEqual(parsed.tasks.length, 1);
    assert.strictEqual(parsed.tasks[0].name, 'Only task');
  });

  test('taskCount always equals tasks.length', () => {
    const noTasks = parsePlanDocument('no tasks here at all');
    assert.strictEqual(noTasks.taskCount, 0);
    assert.deepStrictEqual(noTasks.tasks, []);
  });
});

describe('plan-document — frontmatter scheduling metadata', () => {
  test('invalid wave, string depends_on, autonomous false, agent_hint set, scalar files_modified', () => {
    const parsed = parsePlanDocument(frontmatterDoc([
      'wave: not-a-number',
      'depends_on: 1-01-PLAN.md',
      'autonomous: false',
      'agent_hint: backend-specialist',
      'files_modified: src/single.ts',
    ], ['body']));
    assert.strictEqual(parsed.declaredWave, null);
    assert.deepStrictEqual(parsed.dependsOn, ['1-01-PLAN.md']);
    assert.strictEqual(parsed.autonomous, false);
    assert.strictEqual(parsed.agentHint, 'backend-specialist');
    assert.deepStrictEqual(parsed.filesModified, ['src/single.ts']);
  });

  test('valid wave, array depends_on, empty agent_hint, files-modified (hyphen) array', () => {
    const parsed = parsePlanDocument(frontmatterDoc([
      'wave: 3',
      'depends_on: [1-01-PLAN.md, 1-02-PLAN.md]',
      'agent_hint: ""',
      'files-modified: [a.ts, b.ts]',
    ], ['body']));
    assert.strictEqual(parsed.declaredWave, 3);
    assert.deepStrictEqual(parsed.dependsOn, ['1-01-PLAN.md', '1-02-PLAN.md']);
    assert.strictEqual(parsed.agentHint, null);
    assert.deepStrictEqual(parsed.filesModified, ['a.ts', 'b.ts']);
  });

  test('no frontmatter at all defaults wave/dependsOn/agentHint/filesModified and autonomous true', () => {
    const parsed = parsePlanDocument('plain body, no frontmatter');
    assert.strictEqual(parsed.declaredWave, null);
    assert.deepStrictEqual(parsed.dependsOn, []);
    assert.strictEqual(parsed.autonomous, true);
    assert.strictEqual(parsed.agentHint, null);
    assert.deepStrictEqual(parsed.filesModified, []);
  });

  test('empty depends_on string is dropped, not turned into a single blank entry', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['depends_on: ""'], ['body']));
    assert.deepStrictEqual(parsed.dependsOn, []);
  });

  test('autonomous absent defaults to true', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['wave: 1'], ['body']));
    assert.strictEqual(parsed.autonomous, true);
  });
});

describe('plan-document — frontmatter filesDeleted', () => {
  test('no frontmatter at all defaults filesDeleted to []', () => {
    const parsed = parsePlanDocument('plain body, no frontmatter');
    assert.deepStrictEqual(parsed.filesDeleted, []);
  });

  test('scalar files_deleted (underscore key) is wrapped into a one-element array', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['files_deleted: src/gone.ts'], ['body']));
    assert.deepStrictEqual(parsed.filesDeleted, ['src/gone.ts']);
  });

  test('array files-deleted (hyphen key) is mapped element-wise', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['files-deleted: [a.ts, b.ts]'], ['body']));
    assert.deepStrictEqual(parsed.filesDeleted, ['a.ts', 'b.ts']);
  });

  test('empty files_deleted list yields []', () => {
    const parsed = parsePlanDocument(frontmatterDoc(['files_deleted: []'], ['body']));
    assert.deepStrictEqual(parsed.filesDeleted, []);
  });
});

describe('plan-document — planIdFromFile / TASK_KIND', () => {
  test('strips the -PLAN.md suffix from a root-form plan file', () => {
    assert.strictEqual(planIdFromFile('1-01-PLAN.md'), '1-01');
  });

  test('strips a bare PLAN.md to an empty id', () => {
    assert.strictEqual(planIdFromFile('PLAN.md'), '');
  });

  test('a nested numbered plan file (plans/PLAN-01-foo.md) is left unchanged', () => {
    // Neither the `-PLAN.md` nor bare `PLAN.md` suffix matches this shape —
    // characterised, byte-for-behaviour-preserved limit (see module doc).
    assert.strictEqual(planIdFromFile('plans/PLAN-01-foo.md'), 'plans/PLAN-01-foo.md');
  });

  test('a nested bare plan file (plans/PLAN.md) strips to its directory prefix', () => {
    assert.strictEqual(planIdFromFile('plans/PLAN.md'), 'plans/');
  });

  test('TASK_KIND is the frozen two-member vocabulary', () => {
    assert.deepStrictEqual(TASK_KIND, { AUTO: 'auto', CHECKPOINT: 'checkpoint' });
    assert.ok(Object.isFrozen(TASK_KIND));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// planning-command-router.cjs — pure dispatch, recording mocks, no fs
// ═══════════════════════════════════════════════════════════════════════════

describe('planning-command-router', () => {
  function mockError() {
    const calls = [];
    const fn = (message, reason) => calls.push({ message, reason });
    fn.calls = calls;
    return fn;
  }

  function mockInspect() {
    const calls = [];
    return {
      calls,
      cmdPlanningInspect(cwd, raw) {
        calls.push({ cwd, raw });
      },
    };
  }

  test('PLANNING_SUBCOMMANDS is exactly ["inspect"]', () => {
    assert.deepStrictEqual(PLANNING_SUBCOMMANDS, ['inspect']);
  });

  test('dispatches "planning inspect" and forwards cwd/raw verbatim', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning', 'inspect'], cwd: '/some/cwd', raw: true, error, _planningInspect: mod });
    assert.deepStrictEqual(error.calls, []);
    assert.deepStrictEqual(mod.calls, [{ cwd: '/some/cwd', raw: true }]);
  });

  test('forwards a falsy raw and a different cwd verbatim (not defaulted)', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning', 'inspect'], cwd: '/other', raw: false, error, _planningInspect: mod });
    assert.deepStrictEqual(mod.calls, [{ cwd: '/other', raw: false }]);
  });

  test('a missing subcommand yields sdk_unknown_command and never calls the mock', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning'], cwd: '/x', raw: false, error, _planningInspect: mod });
    assert.strictEqual(error.calls.length, 1);
    assert.strictEqual(error.calls[0].reason, 'sdk_unknown_command');
    assert.strictEqual(error.calls[0].message, 'Unknown planning subcommand. Available: inspect');
    assert.deepStrictEqual(mod.calls, []);
  });

  test('an unknown subcommand yields sdk_unknown_command and never calls the mock', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning', 'bogus'], cwd: '/x', raw: false, error, _planningInspect: mod });
    assert.strictEqual(error.calls.length, 1);
    assert.strictEqual(error.calls[0].reason, 'sdk_unknown_command');
    assert.deepStrictEqual(mod.calls, []);
  });

  test('a stray positional argument is a usage error naming the offender, never dispatched', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning', 'inspect', 'extra'], cwd: '/x', raw: false, error, _planningInspect: mod });
    assert.strictEqual(error.calls.length, 1);
    assert.strictEqual(error.calls[0].reason, 'usage');
    assert.strictEqual(
      error.calls[0].message,
      'planning inspect takes no arguments; got positional argument: extra. Usage: gsd-tools query planning inspect',
    );
    assert.deepStrictEqual(mod.calls, []);
  });

  test('an unknown flag is a usage error naming it as a flag, never dispatched', () => {
    const error = mockError();
    const mod = mockInspect();
    routePlanningCommand({ args: ['planning', 'inspect', '--nope'], cwd: '/x', raw: false, error, _planningInspect: mod });
    assert.strictEqual(error.calls.length, 1);
    assert.strictEqual(error.calls[0].reason, 'usage');
    assert.strictEqual(
      error.calls[0].message,
      'planning inspect takes no arguments; got flag: --nope. Usage: gsd-tools query planning inspect',
    );
    assert.deepStrictEqual(mod.calls, []);
  });

  test('defaults to the real planning-inspect module when no mock is injected', (t) => {
    // No fixtures — buildPlanningInspect degrades gracefully on an absent
    // .planning/ dir, so this proves the `mod ?? planningInspect` fallback
    // wiring without spawning anything.
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    const error = mockError();
    routePlanningCommand({ args: ['planning', 'inspect'], cwd, raw: true, error });
    assert.deepStrictEqual(error.calls, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// planning-inspect.cjs — small on-disk fixtures, in-process buildPlanningInspect
// ═══════════════════════════════════════════════════════════════════════════

describe('planning-inspect — planning root absent', () => {
  test('degrades every section to a non-answer with PLANNING_ROOT_ABSENT', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));

    const result = buildPlanningInspect(cwd);

    assert.strictEqual(result.schema_version, 1);
    assert.strictEqual(result.generated_from.planning_root, null);
    assert.deepStrictEqual(result.phases, []);
    assert.deepStrictEqual(result.orphan_phase_dirs, []);
    assert.deepStrictEqual(result.requirements, []);
    assert.deepStrictEqual(result.progress.accepted_phases, { completed: 0, total: 0, percent: null, scope: 'unreadable' });
    assert.deepStrictEqual(result.progress.completed_plans, { completed: 0, total: 0, percent: null, scope: 'unreadable' });
    assert.strictEqual(result.milestone.scope, 'unreadable');
    assert.deepStrictEqual(diagnosticCodes(result), [
      INSPECT_DIAGNOSTIC.PLANNING_ROOT_ABSENT,
      INSPECT_DIAGNOSTIC.ROADMAP_UNSCOPED,
      INSPECT_DIAGNOSTIC.REQUIREMENTS_ABSENT,
      INSPECT_DIAGNOSTIC.PERCENT_WITHHELD,
      INSPECT_DIAGNOSTIC.PERCENT_WITHHELD,
    ]);
  });
});

describe('planning-inspect — healthy two-phase project', () => {
  function buildHealthy(cwd) {
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(
      ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'],
      ['## Current Position', '', 'Plan: 1-01-PLAN.md', ''],
    ));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '',
      '- [x] **Phase 1: Foo** - stub',
      '- [ ] **Phase 2: Bar** - stub',
      '',
      '### Phase 1: Foo', '', 'Ship the foo module end to end.', '',
      '**Depends on:** Phase 0', '',
      '### Phase 2: Bar', '', 'Ship the bar module.', '',
    ].join('\n'));
    writeFile(cwd, '.planning/REQUIREMENTS.md', [
      '# Requirements: Test', '', '## v1 Requirements', '',
      '- [x] **AUTH-01**: User can sign up',
      '- [ ] **AUTH-02**: User can log in',
      '',
      '## Traceability', '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| AUTH-01 | Phase 1 | Complete |',
      '| AUTH-02 | Phase 2 | Pending |',
      '',
    ].join('\n'));
    for (const [token, name] of [['1', 'foo'], ['2', 'bar']]) {
      const phaseDir = phaseDirOf(cwd, `0${token}-${name}`);
      writeAbs(path.join(phaseDir, `${token}-01-PLAN.md`), frontmatterDoc(['wave: 1'], [
        '<objective>', `Ship ${name}`, '</objective>', '',
        '<tasks>', '',
        '<task type="auto">',
        `  <name>Task 1: Build ${name}</name>`,
        `  <files>src/${name}.ts</files>`,
        '  <done>Done</done>',
        '</task>', '',
        '</tasks>',
      ]));
      writeAbs(path.join(phaseDir, `${token}-01-SUMMARY.md`), frontmatterDoc(['status: complete'], [
        '# Summary', '', '## Files Created/Modified', `- \`src/${name}.ts\` - ${name}`,
      ]));
      writeAbs(path.join(phaseDir, `${token}-VERIFICATION.md`), ['---', 'status: passed', '---', ''].join('\n'));
    }
  }

  test('reports exact scope, percent, requirement, plan-metadata and phase-goal values', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    buildHealthy(cwd);

    const result = buildPlanningInspect(cwd);

    assert.strictEqual(result.phases.length, 2);
    assert.strictEqual(result.milestone.version, 'v1.0');

    const [foo, bar] = result.phases;
    assert.strictEqual(foo.dir, '01-foo');
    assert.strictEqual(foo.phase_id, '01');
    assert.strictEqual(foo.complete, true);
    assert.strictEqual(foo.scope, 'complete');
    assert.deepStrictEqual(foo.goal, { value: 'Ship the foo module end to end.', scope: 'complete' });
    assert.deepStrictEqual(foo.dependencies, { value: ['0'], scope: 'complete' });
    assert.deepStrictEqual(foo.verification, { status: 'passed', next_action: 'Verification passed — continue.' });
    assert.deepStrictEqual(foo.roadmap_acceptance, { checkbox: true, authoritative: false });

    assert.strictEqual(bar.dir, '02-bar');
    assert.deepStrictEqual(bar.dependencies, { value: [], scope: 'complete' });
    assert.deepStrictEqual(bar.roadmap_acceptance, { checkbox: false, authoritative: false });

    const [plan] = foo.plans;
    assert.strictEqual(plan.id, '1-01');
    assert.strictEqual(plan.wave, 1);
    assert.deepStrictEqual(plan.dependsOn, []);
    assert.strictEqual(plan.hasSummary, true);
    assert.deepStrictEqual(plan.changedFiles, ['src/foo.ts']);

    // The SUMMARY carries only `## Files Created/Modified` (plan-level), with
    // no `## Deviations from Plan` block naming a task — so provenance is
    // PLAN_SCOPED, not TASK_SCOPED, and status/agreement are UNKNOWN.
    const [task] = plan.tasks;
    assert.strictEqual(task.provenance, PROVENANCE.PLAN_SCOPED);
    assert.strictEqual(task.agreement, AGREEMENT.UNKNOWN);
    assert.strictEqual(task.status, TASK_STATUS.UNKNOWN);
    assert.strictEqual(task.changedFiles, null);

    assert.deepStrictEqual(result.requirements.map((r) => [r.id, r.complete, r.mappedPhases]), [
      ['AUTH-01', true, ['1']],
      ['AUTH-02', false, ['2']],
    ]);

    assert.deepStrictEqual(result.progress.accepted_phases, { completed: 2, total: 2, percent: 100, scope: 'complete' });
    assert.deepStrictEqual(result.progress.completed_plans, { completed: 2, total: 2, percent: 100, scope: 'complete' });
    assert.strictEqual(diagnosticCodes(result).includes(INSPECT_DIAGNOSTIC.PERCENT_WITHHELD), false);
  });
});

describe('planning-inspect — task provenance/agreement variety, checkpoint, orphan dirs, requirement diagnostics', () => {
  function build(cwd) {
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '',
      '- [x] **Phase 1: Foo** - stub', '',
      '### Phase 1: Foo', '', 'Ship the foo module.', '',
    ].join('\n'));
    writeFile(cwd, '.planning/REQUIREMENTS.md', [
      '# Requirements: Test', '', '## v1 Requirements', '',
      '- [x] **AUTH-01**: User can sign up',
      '- [x] **AUTH-01**: Duplicate row',
      '- [ ] **AUTH-02**: Unmapped requirement',
      '- [ ] **AUTH-03**: Maps to missing phase',
      '', '## Traceability', '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| AUTH-01 | Phase 1 | Complete |',
      '| AUTH-03 | Phase 9 | Pending |',
      '',
    ].join('\n'));
    const p1 = phaseDirOf(cwd, '01-foo');
    writeAbs(path.join(p1, '1-01-PLAN.md'), frontmatterDoc(['wave: 1'], [
      '<objective>', 'Ship foo', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Agreed task</name>',
      '  <files>src/a.ts</files>',
      '  <done>Done</done>',
      '</task>', '',
      '<task type="auto">',
      '  <name>Task 2: Conflicting task</name>',
      '  <files>src/b.ts</files>',
      '  <done>Done</done>',
      '</task>', '',
      '<task type="checkpoint:manual">',
      '  <decision>Ship it?</decision>',
      '</task>', '',
      '</tasks>',
    ]));
    writeAbs(path.join(p1, '1-01-SUMMARY.md'), frontmatterDoc(['status: complete'], [
      '# Summary', '', '## Files Created/Modified', '- `src/a.ts` - a', '',
      '## Deviations from Plan', '',
      '**Found during:** Task 1',
      '**Files modified:** `src/a.ts`', '',
      '**Found during:** Task 2',
      '**Files modified:** `src/other.ts`',
    ]));
    writeAbs(path.join(p1, '1-VERIFICATION.md'), ['---', 'status: passed', '---', ''].join('\n'));
    fs.mkdirSync(phaseDirOf(cwd, '99-orphan'), { recursive: true });
  }

  test('agreed vs conflicting task provenance, checkpoint shape, orphan dir, and every requirement diagnostic code', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    build(cwd);

    const result = buildPlanningInspect(cwd);

    assert.deepStrictEqual(result.orphan_phase_dirs, ['99-orphan']);
    assert.strictEqual(result.phases.length, 1);

    const [agreedTask, conflictingTask, checkpointTask] = result.phases[0].plans[0].tasks;
    assert.strictEqual(agreedTask.provenance, PROVENANCE.TASK_SCOPED);
    assert.strictEqual(agreedTask.agreement, AGREEMENT.AGREED);
    assert.strictEqual(agreedTask.status, TASK_STATUS.DONE);
    assert.deepStrictEqual(agreedTask.changedFiles, ['src/a.ts']);

    assert.strictEqual(conflictingTask.provenance, PROVENANCE.TASK_SCOPED);
    assert.strictEqual(conflictingTask.agreement, AGREEMENT.CONFLICTING);
    assert.deepStrictEqual(conflictingTask.changedFiles, ['src/other.ts']);
    assert.deepStrictEqual(conflictingTask.plannedFiles, ['src/b.ts']);

    assert.strictEqual(checkpointTask.kind, TASK_KIND.CHECKPOINT);
    assert.strictEqual(checkpointTask.provenance, PROVENANCE.PLAN_SCOPED);
    assert.strictEqual(checkpointTask.agreement, AGREEMENT.UNKNOWN);

    assert.deepStrictEqual(
      result.requirements.map((r) => ({ id: r.id, complete: r.complete, mappedPhases: r.mappedPhases, diagnostics: r.diagnostics })),
      [
        { id: 'AUTH-01', complete: true, mappedPhases: ['1'], diagnostics: [INSPECT_DIAGNOSTIC.REQUIREMENT_DUPLICATE] },
        { id: 'AUTH-02', complete: false, mappedPhases: [], diagnostics: [INSPECT_DIAGNOSTIC.REQUIREMENT_UNMAPPED] },
        { id: 'AUTH-03', complete: false, mappedPhases: ['9'], diagnostics: [INSPECT_DIAGNOSTIC.REQUIREMENT_PHASE_UNKNOWN] },
      ],
    );

    const codes = diagnosticCodes(result);
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.ORPHAN_PHASE_DIR));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.TASK_CHANGED_FILES_CONFLICTING));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.TASK_SHAPE_CHECKPOINT));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.TASK_CHANGED_FILES_PLAN_SCOPED));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.REQUIREMENT_DUPLICATE));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.REQUIREMENT_UNMAPPED));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.REQUIREMENT_PHASE_UNKNOWN));
    assert.strictEqual(codes.includes(INSPECT_DIAGNOSTIC.PERCENT_WITHHELD), false);
  });
});

describe('planning-inspect — percent withheld, unreadable plan/summary, completion-unknown requirement', () => {
  function build(cwd) {
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '',
      '- [x] **Phase 1: Foo** - stub',
      '- [ ] **Phase 2: Bar** - stub',
      '',
      '### Phase 1: Foo', '', 'Ship the foo module.', '',
      // Deliberately NO section for Phase 2 -> ROADMAP_UNSCOPED for it.
    ].join('\n'));
    writeFile(cwd, '.planning/REQUIREMENTS.md', [
      '# Requirements: Test', '', '## v1 Requirements', '',
      '- [x] **AUTH-01**: User can sign up',
      '',
      '## Other', '',
      '| AUTH-05 | some description |',
      '',
      '## Traceability', '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| AUTH-01 | Phase 1 | Complete |',
      '| AUTH-05 | Phase 1 | Pending |',
      '',
    ].join('\n'));
    const p1 = phaseDirOf(cwd, '01-foo');
    writeAbs(path.join(p1, '1-01-PLAN.md'), frontmatterDoc(['wave: 1'], [
      '<objective>', 'Ship foo', '</objective>', '',
      '<tasks>', '', '<task type="auto">', '  <name>Task 1</name>', '  <files>src/a.ts</files>', '  <done>Done</done>', '</task>', '', '</tasks>',
    ]));
    // Directory-in-file-position (cross-platform, no chmod): readDocument sees
    // !stat.isFile() and reports unreadable, never a permissions hack.
    fs.mkdirSync(path.join(p1, '1-01-SUMMARY.md'), { recursive: true });
    const p2 = phaseDirOf(cwd, '02-bar');
    fs.mkdirSync(p2, { recursive: true });
    fs.mkdirSync(path.join(p2, '2-01-PLAN.md'), { recursive: true });
  }

  test('withholds percent when a windowed phase has no ROADMAP section, and reports unreadable plan/summary + completion-unknown', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    build(cwd);

    const result = buildPlanningInspect(cwd);

    const [foo, bar] = result.phases;
    assert.deepStrictEqual(foo.goal, { value: 'Ship the foo module.', scope: 'complete' });
    assert.deepStrictEqual(bar.goal, { value: null, scope: 'unscoped' });
    assert.deepStrictEqual(bar.dependencies, { value: [], scope: 'unscoped' });
    assert.strictEqual(bar.scope, 'unscoped');
    assert.strictEqual(bar.plans[0].scope, 'unreadable');
    assert.strictEqual(bar.plans[0].tasks.length, 0);

    assert.deepStrictEqual(result.progress.accepted_phases, { completed: 0, total: 2, percent: null, scope: 'unscoped' });
    assert.strictEqual(result.progress.completed_plans.percent, null);

    const auth05 = result.requirements.find((r) => r.id === 'AUTH-05');
    assert.strictEqual(auth05.complete, 'unknown');
    assert.deepStrictEqual(auth05.mappedPhases, ['1']);
    assert.deepStrictEqual(auth05.diagnostics, [INSPECT_DIAGNOSTIC.REQUIREMENT_COMPLETION_UNKNOWN]);

    const codes = diagnosticCodes(result);
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.SUMMARY_UNREADABLE));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.PLAN_UNREADABLE));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.ROADMAP_UNSCOPED));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.PHASE_SCOPE_DEGRADED));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.REQUIREMENT_COMPLETION_UNKNOWN));
    assert.strictEqual(codes.filter((c) => c === INSPECT_DIAGNOSTIC.PERCENT_WITHHELD).length, 2);
  });
});

describe('planning-inspect — UAT unreadable, UAT items, requirements unreadable, containment escape', () => {
  test('a directory-in-file-position UAT document is UAT_UNREADABLE and degrades phase scope', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '', '- [ ] **Phase 1: Foo** - stub', '',
      '### Phase 1: Foo', '', 'Ship the foo module.', '',
    ].join('\n'));
    const p1 = phaseDirOf(cwd, '01-foo');
    fs.mkdirSync(path.join(p1, '1-UAT.md'), { recursive: true });

    const result = buildPlanningInspect(cwd);
    assert.deepStrictEqual(result.phases[0].uat, { unresolved: [], scope: 'truncated' });
    assert.strictEqual(result.phases[0].scope, 'truncated');
    const codes = diagnosticCodes(result);
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.UAT_UNREADABLE));
    assert.ok(codes.includes(INSPECT_DIAGNOSTIC.PHASE_SCOPE_DEGRADED));
  });

  test('a pending UAT test item is surfaced verbatim in phases[].uat.unresolved', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '', '- [ ] **Phase 1: Foo** - stub', '',
      '### Phase 1: Foo', '', 'Ship the foo module.', '',
    ].join('\n'));
    const p1 = phaseDirOf(cwd, '01-foo');
    fs.mkdirSync(p1, { recursive: true });
    writeAbs(path.join(p1, '1-UAT.md'), [
      '# UAT: Phase 1', '',
      '## Current Test', '[testing complete]', '',
      '## Tests', '',
      '### 1. Sign up flow',
      'expected: user can sign up',
      'result: pending',
      '',
    ].join('\n'));

    const result = buildPlanningInspect(cwd);
    assert.deepStrictEqual(result.phases[0].uat, {
      scope: 'complete',
      unresolved: [{ test: 1, name: 'Sign up flow', expected: 'user can sign up', result: 'pending', category: 'pending' }],
    });
  });

  test('REQUIREMENTS.md as a directory-in-file-position is unreadable, not absent, and yields zero rows', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', ['## v1.0 Current 🚧', '', '## Phases', ''].join('\n'));
    fs.mkdirSync(path.join(cwd, '.planning/REQUIREMENTS.md'), { recursive: true });

    const result = buildPlanningInspect(cwd);
    assert.deepStrictEqual(result.requirements, []);
    assert.ok(diagnosticCodes(result).includes(INSPECT_DIAGNOSTIC.REQUIREMENTS_UNREADABLE));
    assert.strictEqual(diagnosticCodes(result).includes(INSPECT_DIAGNOSTIC.REQUIREMENTS_ABSENT), false);
  });

  test('a plan file symlinked outside the planning root degrades to unreadable, never leaking the escaped content', (t) => {
    const cwd = mkCwd();
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/STATE.md', frontmatterDoc(["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], []));
    writeFile(cwd, '.planning/ROADMAP.md', [
      '## v1.0 Current 🚧', '', '## Phases', '', '- [ ] **Phase 1: Foo** - stub', '',
      '### Phase 1: Foo', '', 'Ship the foo module.', '',
    ].join('\n'));
    const p1 = phaseDirOf(cwd, '01-foo');
    fs.mkdirSync(p1, { recursive: true });
    const outside = path.join(os.tmpdir(), `planning-inspect-unit-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'SECRET CONTENT');
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(p1, '1-01-PLAN.md'));

    const result = buildPlanningInspect(cwd);
    const [plan] = result.phases[0].plans;
    assert.strictEqual(plan.scope, 'unreadable');
    assert.strictEqual(plan.objective, null);
    assert.deepStrictEqual(plan.tasks, []);
    const json = JSON.stringify(result);
    assert.strictEqual(json.includes('SECRET CONTENT'), false);
    assert.ok(diagnosticCodes(result).includes(INSPECT_DIAGNOSTIC.PLAN_UNREADABLE));
  });
});
