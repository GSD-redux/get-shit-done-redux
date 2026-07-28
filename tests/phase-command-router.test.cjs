'use strict';

/**
 * Behavioral tests for the phase-command-router adapter (#3788).
 *
 * Shape:
 *   1. Adapter translation — CLI args → hub dispatch shape
 *   2. Result translation — hub result → stdout / error callback
 *   3. Unsupported subcommands — scaffold produces the documented redirect
 *   4. Unknown subcommand — unmapped subcommands produce a well-formed error
 *   5. Integration — real hub + real CJS phase handler invocation
 *
 * Testing rules in force (CONTRIBUTING.md § Testing Standards):
 *   - No readFileSync of source files.
 *   - No mocking of the hub itself — tests use the real CommandRoutingHub
 *     with stub cjsRegistry / sdkLoader entries.
 *   - All assertions on return values and captured call arguments.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { routePhaseCommand } = require('../gsd-core/bin/lib/phase-command-router.cjs');

// Force CJS path throughout: set GSD_WORKSTREAM so tryLoadSdk() is bypassed.
// This makes unit-level assertions deterministic regardless of SDK build state.
let _prevWorkstream;
before(() => {
  _prevWorkstream = process.env.GSD_WORKSTREAM;
  process.env.GSD_WORKSTREAM = 'test-unit';
});
after(() => {
  if (_prevWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
  else process.env.GSD_WORKSTREAM = _prevWorkstream;
});

// ─── Helper: build a minimal phase stub ──────────────────────────────────────

function makePhase(overrides = {}) {
  return {
    cmdPhaseMvpMode: () => {},
    cmdPhaseNextDecimal: () => {},
    cmdPhaseAdd: () => {},
    cmdPhaseAddBatch: () => {},
    cmdPhaseInsert: () => {},
    cmdPhaseRemove: () => {},
    cmdPhaseComplete: () => {},
    cmdPhaseListPlans: () => {},
    ...overrides,
  };
}

// ─── 1. Adapter translation — CLI args → handler calls ───────────────────────

describe('phase-command-router — CLI arg translation (CJS path)', () => {
  test('routes phase mvp-mode: passes cwd, args.slice(2), raw to handler', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseMvpMode: (cwd, slicedArgs, raw) => calls.push({ cwd, slicedArgs, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'mvp-mode', '--enable'], cwd: '/proj', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/proj');
    assert.deepEqual(calls[0].slicedArgs, ['--enable']);
    assert.equal(calls[0].raw, false);
  });

  test('routes phase next-decimal: passes cwd, args[2], raw to handler', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseNextDecimal: (cwd, label, raw) => calls.push({ cwd, label, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'next-decimal', '5'], cwd: '/p', raw: true, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].label, '5');
    assert.equal(calls[0].raw, true);
  });

  test('routes phase add: strips --raw, passes joined description and no customId', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseAdd: (cwd, desc, raw, customId) => calls.push({ cwd, desc, raw, customId }),
    });

    routePhaseCommand({ phase, args: ['phase', 'add', 'My', 'phase', '--raw'], cwd: '/p', raw: true, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].desc, 'My phase');
    assert.equal(calls[0].customId, null);
  });

  test('routes phase add: captures --id value', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseAdd: (cwd, desc, raw, customId) => calls.push({ customId }),
    });

    routePhaseCommand({ phase, args: ['phase', 'add', '--id', '05', 'Desc'], cwd: '/p', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].customId, '05');
  });

  test('routes phase add-batch: --descriptions JSON array parses correctly', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseAddBatch: (cwd, descriptions, _raw) => calls.push({ descriptions }),
    });

    routePhaseCommand({
      phase,
      args: ['phase', 'add-batch', '--descriptions', '["Phase A","Phase B"]'],
      cwd: '/p',
      raw: false,
      error: (m) => { throw new Error(m); },
    });

    assert.deepEqual(calls[0].descriptions, ['Phase A', 'Phase B']);
  });

  test('routes phase add-batch: positional args used when --descriptions absent', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseAddBatch: (cwd, descriptions, _raw) => calls.push({ descriptions }),
    });

    routePhaseCommand({
      phase,
      args: ['phase', 'add-batch', 'A', 'B', '--raw'],
      cwd: '/p',
      raw: true,
      error: (m) => { throw new Error(m); },
    });

    assert.deepEqual(calls[0].descriptions, ['A', 'B']);
  });

  test('routes phase insert: passes cwd, phaseNum, trailing joined, raw', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseInsert: (cwd, phaseNum, desc, raw) => calls.push({ cwd, phaseNum, desc, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'insert', '02', 'New', 'phase'], cwd: '/p', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].phaseNum, '02');
    assert.equal(calls[0].desc, 'New phase');
  });

  test('routes phase remove: passes cwd, phaseNum, force:false, raw', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseRemove: (cwd, phaseNum, opts, raw) => calls.push({ cwd, phaseNum, opts, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'remove', '03'], cwd: '/p', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].phaseNum, '03');
    assert.deepEqual(calls[0].opts, { force: false });
  });

  test('routes phase remove: --force flag sets opts.force:true', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseRemove: (cwd, phaseNum, opts, _raw) => calls.push({ opts }),
    });

    routePhaseCommand({ phase, args: ['phase', 'remove', '--force', '03'], cwd: '/p', raw: false, error: (m) => { throw new Error(m); } });

    assert.deepEqual(calls[0].opts, { force: true });
  });

  test('routes phase complete: passes cwd, args[2], raw', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseComplete: (cwd, phaseNum, raw) => calls.push({ cwd, phaseNum, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'complete', '04'], cwd: '/p', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls[0].phaseNum, '04');
  });
});

// ─── 2. Result translation — error callback on failure ───────────────────────

describe('phase-command-router — result translation (error path)', () => {
  test('phase add with --id missing value calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'add', '--id'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null, 'error callback must be called');
    assert.ok(msg.includes('--id requires a value'));
  });

  test('phase add with unknown flag calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'add', '--unknown-flag'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('phase add does not support'));
  });

  test('phase add-batch with non-JSON --descriptions calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'add-batch', '--descriptions', 'not-json'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('JSON array'));
  });

  test('phase insert with --dry-run calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'insert', '02', '--dry-run'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('does not support --dry-run'));
  });

  test('phase remove with unsupported flag calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'remove', '--quiet', '03'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('phase remove does not support'));
  });

  test('phase remove without a phase number calls error()', () => {
    let msg = null;
    const phase = makePhase();

    routePhaseCommand({
      phase,
      args: ['phase', 'remove'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('exactly one phase number'));
  });

  // #1437 — phase.list-plans routing
  test('routes phase list-plans: passes cwd, phaseNum, raw to handler', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseListPlans: (cwd, phaseNum, raw) => calls.push({ cwd, phaseNum, raw }),
    });

    routePhaseCommand({ phase, args: ['phase', 'list-plans', '03'], cwd: '/proj', raw: false, error: (m) => { throw new Error(m); } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/proj');
    assert.equal(calls[0].phaseNum, '03');
    assert.equal(calls[0].raw, false);
  });
});

// ─── 3. Unsupported subcommands ────────────────────────────────────────────────

describe('phase-command-router — unsupported subcommands', () => {
  // #1437: phase list-plans is now a supported subcommand — routing test in § 1.
  test('phase list-artifacts resolves as unknown subcommand', () => {
    let msg = null;
    routePhaseCommand({
      phase: makePhase(),
      args: ['phase', 'list-artifacts'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('Unknown phase subcommand'));
    assert.ok(msg.includes('Available:'), `expected "Available:" in: ${msg}`);
  });

  test('phase scaffold calls error() with redirect message', () => {
    let msg = null;
    routePhaseCommand({
      phase: makePhase(),
      args: ['phase', 'scaffold'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('scaffold'));
  });
});

// ─── 4. Unknown subcommand ────────────────────────────────────────────────────

describe('phase-command-router — unknown subcommand', () => {
  test('unknown phase subcommand calls error() listing available ones', () => {
    let msg = null;
    routePhaseCommand({
      phase: makePhase(),
      args: ['phase', 'frobnicate'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg !== null);
    assert.ok(msg.includes('Unknown phase subcommand'));
    assert.ok(msg.includes('Available:'), `expected "Available:" in: ${msg}`);
  });

  test('unknown subcommand message lists canonical manifest commands like add and complete', () => {
    // mvp-mode is NOT in the available list (not in PHASE_SUBCOMMANDS manifest),
    // matching the pre-#3788 behaviour of routeCjsCommandFamily.
    // The list does include the manifest-backed commands: add, complete, etc.
    let msg = null;
    routePhaseCommand({
      phase: makePhase(),
      args: ['phase', 'bogus'],
      cwd: '/p',
      raw: false,
      error: (m) => { msg = m; },
    });

    assert.ok(msg.includes('add'), `expected add in available list: ${msg}`);
    assert.ok(msg.includes('complete'), `expected complete in available list: ${msg}`);
    // #1437: list-plans is now a supported command and appears in the available list
    assert.ok(msg.includes('list-plans'), `list-plans must appear in available list: ${msg}`);
  });
});

// ─── 5. Integration — real hub + real CJS phase handler ──────────────────────
//
// This test exercises the full dispatch chain end-to-end:
//   routePhaseCommand → createHub (cjs mode) → dispatch → cjsRegistry handler
//   → phase stub → assert the call was received.
//
// No mocking of the hub. The phase stub is a real dependency collaborator.

describe('phase-command-router — integration: real hub + CJS phase handler', () => {
  test('dispatches phase complete through real hub to real CJS handler chain', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseComplete: (cwd, phaseNum, raw) => calls.push({ cwd, phaseNum, raw }),
    });

    // No error should occur; handler should be called exactly once.
    let errorMsg = null;
    routePhaseCommand({
      phase,
      args: ['phase', 'complete', '07'],
      cwd: '/integration',
      raw: false,
      error: (m) => { errorMsg = m; },
    });

    assert.equal(errorMsg, null, `unexpected error: ${errorMsg}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/integration');
    assert.equal(calls[0].phaseNum, '07');
    assert.equal(calls[0].raw, false);
  });

  test('dispatches phase add-batch through real hub with --descriptions', () => {
    const calls = [];
    const phase = makePhase({
      cmdPhaseAddBatch: (cwd, descriptions, _raw) => calls.push({ descriptions }),
    });

    let errorMsg = null;
    routePhaseCommand({
      phase,
      args: ['phase', 'add-batch', '--descriptions', '["Alpha","Beta"]'],
      cwd: '/integration',
      raw: false,
      error: (m) => { errorMsg = m; },
    });

    assert.equal(errorMsg, null, `unexpected error: ${errorMsg}`);
    assert.deepEqual(calls[0].descriptions, ['Alpha', 'Beta']);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1437-phase-list-plans.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1437-phase-list-plans (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for `gsd-tools query phase.list-plans <N>` (#1437).
 *
 * Prior to this fix, `phase.list-plans` was not registered in the
 * phase-command-router, so any invocation produced:
 *   "Error: Unknown phase subcommand. Available: uat-passed, next-decimal, ..."
 *
 * These tests exercise the full dispatch path:
 *   gsd-tools → phase-command-router → phase.cmdPhaseListPlans
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function setupProject(phaseSlug = '01-feature') {
  const tmpDir = createTempProject();
  // Minimal ROADMAP so findPhaseInternal can resolve the phase directory
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Feature',
      '',
      '### Phase 1: Feature',
      '**Goal:** Build feature',
      '**Plans:** 1 plans',
      '',
    ].join('\n'),
  );
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  return { tmpDir, phaseDir };
}

function touch(dir, ...files) {
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), '');
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let tmpDir;
let phaseDir;
// Consolidation #1969: the host suite forces GSD_WORKSTREAM=test-unit, which
// runGsdTools propagates into child processes and redirects the project lookup.
// Clear it for these tests (unset when this file ran standalone); restore after.
let __savedWorkstream;

beforeEach(() => {
  __savedWorkstream = process.env.GSD_WORKSTREAM;
  delete process.env.GSD_WORKSTREAM;
  const proj = setupProject('01-feature');
  tmpDir = proj.tmpDir;
  phaseDir = proj.phaseDir;
});

afterEach(() => {
  cleanup(tmpDir);
  if (__savedWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
  else process.env.GSD_WORKSTREAM = __savedWorkstream;
});

describe('bug-1437 — phase.list-plans is wired in gsd-tools', () => {
  test('command no longer returns Unknown phase subcommand error', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1'], tmpDir);
    // Previously this would fail with "Unknown phase subcommand"
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    assert.ok(!result.error || !result.error.includes('Unknown phase subcommand'),
      `got unexpected error: ${result.error}`);
  });

  test('returns JSON with plan_count and plans array when plans exist', () => {
    touch(phaseDir, '01-01-PLAN.md', '01-02-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 2, 'plan_count should be 2');
    assert.equal(data.has_plans, true, 'has_plans should be true');
    assert.ok(Array.isArray(data.plans), 'plans should be an array');
    assert.equal(data.plans.length, 2, 'plans array should have 2 entries');
  });

  test('returns plan_count 0 and empty plans array when phase has no plan files', () => {
    // Phase directory exists but has no *-PLAN.md files
    touch(phaseDir, 'CONTEXT.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 0);
    assert.equal(data.has_plans, false);
    assert.deepEqual(data.plans, []);
  });

  test('returns has_plans false when phase number is not found', () => {
    // Phase 99 does not exist in the fixture
    const result = runGsdTools(['query', 'phase.list-plans', '99', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.has_plans, false);
    assert.equal(data.plan_count, 0);
  });

  test('plan paths are relative to project root and posix-style', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plans.length, 1);
    // Paths must be forward-slash separated (posix) and relative (not absolute)
    const planPath = data.plans[0];
    assert.ok(!path.isAbsolute(planPath), `expected relative path, got: ${planPath}`);
    assert.ok(!planPath.includes('\\'), `expected posix path, got: ${planPath}`);
    assert.ok(planPath.includes('01-01-PLAN.md'), `expected plan filename in path: ${planPath}`);
  });

  test('dotted form phase.list-plans (without query prefix) also works', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 1);
  });
});
  });
}

// ─── 6. Observability logger wiring (#2620) ──────────────────────────────────
//
// The fix wires the reference DispatchLogger at BOTH live createHub() seams.
// The sibling seam (cjs-command-router-adapter) is covered in its own file;
// this pins the phase seam so a later refactor that drops the isAuditEnabled()
// gate or the injection here cannot reintroduce the #2620 defect silently.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { createTempDir, cleanup } = require('./helpers.cjs');

  describe('phase-command-router — observability logger wiring (#2620)', () => {
    test('a dispatch through the phase seam writes the opt-in audit trail when GSD_AUDIT=1', (t) => {
      const tmp = createTempDir('gsd-obs-phase-');
      const prevAudit = process.env.GSD_AUDIT;
      t.after(() => {
        if (prevAudit === undefined) delete process.env.GSD_AUDIT;
        else process.env.GSD_AUDIT = prevAudit;
        cleanup(tmp);
      });
      process.env.GSD_AUDIT = '1';

      const phase = makePhase({ cmdPhaseNextDecimal: () => {} });
      routePhaseCommand({
        phase,
        args: ['phase', 'next-decimal', '5'],
        cwd: tmp,
        raw: false,
        error: (m) => { throw new Error(m); },
      });

      const auditPath = path.join(tmp, '.planning', '.gsd-trace.jsonl');
      assert.ok(
        fs.existsSync(auditPath),
        'GSD_AUDIT=1 must produce .planning/.gsd-trace.jsonl — the phase router must build the Hub with a real DispatchLogger (ADR-0174 §6), not createNoOpLogger'
      );

      const lines = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.ok(lines.length > 0, 'at least one dispatch event must be recorded');
      assert.equal(lines.length, 1, 'exactly one dispatch event must be recorded');

      const event = JSON.parse(lines[0]);
      assert.equal(event.result.kind, 'ok', 'a successful dispatch is recorded with result.kind === "ok"');
      assert.ok(typeof event.command === 'string' && event.command.length > 0, 'event carries the dispatched command');
      assert.ok(typeof event.traceId === 'string' && event.traceId.length > 0, 'event carries a traceId');
      assert.ok(typeof event.timestamp === 'string' && event.timestamp.length > 0, 'event carries an ISO timestamp');
    });

    test('no audit trail is written when GSD_AUDIT is unset (Hub stays silent via the no-op fallback)', (t) => {
      const tmp = createTempDir('gsd-obs-phase-off-');
      const prevAudit = process.env.GSD_AUDIT;
      t.after(() => {
        if (prevAudit === undefined) delete process.env.GSD_AUDIT;
        else process.env.GSD_AUDIT = prevAudit;
        cleanup(tmp);
      });
      delete process.env.GSD_AUDIT;

      const phase = makePhase({ cmdPhaseNextDecimal: () => {} });
      routePhaseCommand({
        phase,
        args: ['phase', 'next-decimal', '5'],
        cwd: tmp,
        raw: false,
        error: (m) => { throw new Error(m); },
      });

      assert.equal(
        fs.existsSync(path.join(tmp, '.planning', '.gsd-trace.jsonl')),
        false,
        'without the opt-in signal the seam must leave no audit artifact'
      );
    });
  });
}
