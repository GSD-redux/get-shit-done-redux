'use strict';

const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { routeRoadmapCommand } = require('../gsd-core/bin/lib/roadmap-command-router.cjs');
const roadmapUpgrade = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');

// These tests exercise router dispatch with a deterministic runtime context.
let _prevWorkstream;
before(() => {
  _prevWorkstream = process.env.GSD_WORKSTREAM;
  process.env.GSD_WORKSTREAM = 'test-unit';
});
after(() => {
  if (_prevWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
  else process.env.GSD_WORKSTREAM = _prevWorkstream;
});

describe('roadmap-command-router', () => {
  test('routes roadmap analyze', () => {
    const calls = [];
    const roadmap = {
      cmdRoadmapAnalyze: (cwd, raw) => calls.push({ cwd, raw }),
    };

    routeRoadmapCommand({
      roadmap,
      args: ['roadmap', 'analyze'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => {
        throw new Error(msg);
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cwd: '/tmp/proj', raw: true });
  });

  test('routes roadmap get-phase and update-plan-progress with phase arg', () => {
    const calls = [];
    const roadmap = {
      cmdRoadmapGetPhase: (cwd, phase, raw) => calls.push({ kind: 'get', cwd, phase, raw }),
      cmdRoadmapUpdatePlanProgress: (cwd, phase, raw) => calls.push({ kind: 'update', cwd, phase, raw }),
    };

    routeRoadmapCommand({
      roadmap,
      args: ['roadmap', 'get-phase', '10'],
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => {
        throw new Error(msg);
      },
    });

    routeRoadmapCommand({
      roadmap,
      args: ['roadmap', 'update-plan-progress', '10'],
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => {
        throw new Error(msg);
      },
    });

    assert.deepEqual(calls, [
      { kind: 'get', cwd: '/tmp/proj', phase: '10', raw: false },
      { kind: 'update', cwd: '/tmp/proj', phase: '10', raw: false },
    ]);
  });

  test('errors on unknown roadmap subcommand', () => {
    let message = null;
    routeRoadmapCommand({
      roadmap: {},
      args: ['roadmap', 'nonsense'],
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => {
        message = msg;
      },
    });

    // #3262 added the read-only `milestone-scope` probe after `analyze`
    // (ROADMAP_SUBCOMMANDS order mirrors ROADMAP_COMMAND_ALIASES).
    assert.equal(message, 'Unknown roadmap subcommand. Available: analyze, milestone-scope, get-phase, update-plan-progress, annotate-dependencies, validate, upgrade');
  });
});

// #1538 — the `upgrade` handler must honor the no-throw hub contract (ADR-0012)
// and parse `--convention` in both `--convention <v>` and `--convention=<v>` forms.
describe('roadmap upgrade — hub contract + --convention parsing (#1538)', () => {
  let exitCalls;
  let applyCalls;

  beforeEach(() => {
    exitCalls = [];
    applyCalls = [];
    // A hub-dispatched handler must never call process.exit. Mock it to throw a
    // sentinel so the test can observe an illegal exit instead of killing the runner.
    mock.method(process, 'exit', (code) => {
      exitCalls.push(code);
      throw new Error('UNEXPECTED_PROCESS_EXIT');
    });
    // Stub the migration so the supported-convention path is observable without a real project.
    mock.method(roadmapUpgrade, 'computeMigrationPlan', () => ({ phases: [] }));
    mock.method(roadmapUpgrade, 'applyMigration', (_cwd, _plan, opts) => {
      applyCalls.push({ opts });
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  function runUpgrade(args) {
    let message = null;
    routeRoadmapCommand({
      roadmap: {},
      args,
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => { message = msg; },
    });
    return message;
  }

  test('rejects an unsupported convention (space form) via error(), never process.exit', () => {
    const message = runUpgrade(['roadmap', 'upgrade', '--convention', 'sequential']);
    assert.equal(exitCalls.length, 0, 'a hub handler must not call process.exit');
    assert.equal(message, 'Only --convention milestone-prefixed is supported');
    assert.equal(applyCalls.length, 0, 'must not run the migration for an unsupported convention');
  });

  test('rejects an unsupported convention in equals form — no silent fail-open', () => {
    const message = runUpgrade(['roadmap', 'upgrade', '--convention=sequential']);
    assert.equal(exitCalls.length, 0, 'a hub handler must not call process.exit');
    assert.equal(message, 'Only --convention milestone-prefixed is supported');
    assert.equal(applyCalls.length, 0, '--convention=sequential must not silently run the milestone-prefixed migration');
  });

  test('rejects empty/malformed convention values fail-closed (never runs the migration)', () => {
    for (const args of [
      ['roadmap', 'upgrade', '--convention', ''],
      ['roadmap', 'upgrade', '--convention='],
      ['roadmap', 'upgrade', '--convention'],
      ['roadmap', 'upgrade', '--convention==x'],
    ]) {
      const message = runUpgrade(args);
      assert.equal(
        message,
        'Only --convention milestone-prefixed is supported',
        `should reject ${JSON.stringify(args)}`,
      );
      assert.equal(exitCalls.length, 0, 'a hub handler must not call process.exit');
    }
    assert.equal(applyCalls.length, 0, 'no migration runs for any malformed convention');
  });

  test('accepts the supported convention in both forms and the default (reaches applyMigration, dry-run)', () => {
    assert.equal(runUpgrade(['roadmap', 'upgrade', '--convention', 'milestone-prefixed']), null);
    assert.equal(runUpgrade(['roadmap', 'upgrade', '--convention=milestone-prefixed']), null);
    assert.equal(runUpgrade(['roadmap', 'upgrade']), null);
    assert.equal(exitCalls.length, 0);
    assert.equal(applyCalls.length, 3, 'all three supported invocations reach applyMigration');
    assert.ok(applyCalls.every((c) => c.opts.dryRun === true), 'no --apply ⇒ dryRun');
  });
});
