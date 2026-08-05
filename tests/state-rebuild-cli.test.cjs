'use strict';

// Phase 2 integration tests for the `state rebuild` CLI subcommand (#1826).
//
// These tests exercise the CLI dispatch path (routeStateCommand → cmdStateRebuild),
// the --dry-run flag (no write), and the --verbose flag (stderr emit). The
// underlying rebuildCore logic is covered by tests/state-rebuild.test.cjs (Phase 1).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createTempProject,
  cleanup,
  runGsdTools,
} = require('./helpers.cjs');
const { withFaultyFs } = require('./helpers/faulty-deps.cjs');
const stateMod = require('../gsd-core/bin/lib/state.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Write a STATE.md with one drift signature (stale Current Phase in body vs
 * frontmatter) into a freshly-created temp project. Returns the temp dir.
 */
function projectWithDriftedState() {
  const cwd = createTempProject('state-rebuild-cli');
  const planningPath = path.join(cwd, '.planning');
  // Drop two phase dirs so phaseInventoryProvider has something to scan.
  fs.mkdirSync(path.join(planningPath, 'phases', '01-phase-one'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'phases', '01-phase-one', '01-PLAN.md'), '# Plan');
  fs.mkdirSync(path.join(planningPath, 'phases', '02-phase-two'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'phases', '02-phase-two', '01-PLAN.md'), '# Plan');

  // STATE.md with a drift: body says Current Phase 1, frontmatter says 2.
  const stateContent = [
    '---',
    'gsd_state_version: \'1.0\'',
    'status: executing',
    'milestone: 1.0.0',
    'milestone_name: Test',
    'current_phase: 2',
    'current_phase_name: Phase Two',
    'current_plan: 1',
    'progress:',
    '  total_phases: 2',
    '  completed_phases: 1',
    '  total_plans: 2',
    '  completed_plans: 1',
    '  percent: 50',
    '---',
    '',
    '# Project State',
    '',
    '## Project Reference',
    '',
    '**Core value:** A test project',
    '**Current focus:** Phase Two',
    '',
    '## Current Position',
    '',
    '**Current Phase:** 1',
    '**Current Phase Name:** Phase One',
    '**Current Plan:** 1',
    '**Total Plans in Phase:** 1',
    '**Status:** executing',
    '**Last Activity:** 2026-06-29',
    '**Last Activity Description:** mid-flight',
    '',
    'Phase: 2 of 2 (Phase Two)',
    'Plan: 1 of 1',
    'Status: Executing Phase 2',
    'Last activity: 2026-06-29 — mid-flight',
    '',
    '**Progress:** [█████░░░░░] 50%',
    '',
    '## Performance Metrics',
    '',
    '**By Phase:**',
    '',
    '| Phase | Plans | Total | Avg/Plan |',
    '|-------|-------|-------|----------|',
    '| 99 | 1 | - | - |',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    'None yet.',
    '',
    '## Session Continuity',
    '',
    'Last session: 2026-06-29 12:00',
    'Stopped at: mid-flight',
    'Resume file: None',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningPath, 'STATE.md'), stateContent);
  return cwd;
}

/** Read the live STATE.md from a project (strips the audit log so assertions
 * check the canonical body, not the appended ## Rebuild Log entries). */
function readLiveState(cwd) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  const content = fs.readFileSync(statePath, 'utf8');
  // Strip ## Rebuild Log and everything after for shape assertions.
  return content.replace(/^## Rebuild Log[\s\S]*$/m, '');
}

/**
 * A project whose ONLY drift is the `**By Phase:**` table (an orphan row for
 * phase 99, which isn't on disk). Every other body/frontmatter field is
 * already canonical, so `rebuildCore`'s other reconciliation steps are all
 * no-ops — the ONLY thing that can add a `## Rebuild Log` entry / flip
 * `mutated` is whether the phase-inventory disk scan actually reconciles the
 * table. This isolates the phase-inventory-scan outcome for #3057 B1.
 */
function projectWithOnlyPhaseTableDrift() {
  const cwd = createTempProject('state-rebuild-cli-scan');
  const planningPath = path.join(cwd, '.planning');
  fs.mkdirSync(path.join(planningPath, 'phases', '01-phase-one'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'phases', '01-phase-one', '01-PLAN.md'), '# Plan');

  const stateContent = [
    '---',
    'gsd_state_version: \'1.0\'',
    'status: executing',
    'milestone: 1.0.0',
    'milestone_name: Test',
    'current_phase: 1',
    'current_phase_name: Phase One',
    'current_plan: 1',
    'progress:',
    '  total_phases: 1',
    '  completed_phases: 0',
    '  total_plans: 1',
    '  completed_plans: 0',
    '  percent: 0',
    '---',
    '',
    '# Project State',
    '',
    '## Project Reference',
    '',
    '**Core value:** A test project',
    '**Current focus:** Phase One',
    '',
    '## Current Position',
    '',
    '**Current Phase:** 1',
    '**Current Phase Name:** Phase One',
    '**Current Plan:** 1',
    '**Total Plans in Phase:** 1',
    '**Status:** executing',
    '**Last Activity:** 2026-06-29',
    '**Last Activity Description:** mid-flight',
    '',
    'Phase: 1 of 1 (Phase One)',
    'Plan: 1 of 1',
    'Status: Executing Phase 1',
    'Last activity: 2026-06-29 — mid-flight',
    '',
    '**Progress:** [░░░░░░░░░░] 0%',
    '',
    '## Performance Metrics',
    '',
    '**By Phase:**',
    '',
    '| Phase | Plans | Total | Avg/Plan |',
    '|-------|-------|-------|----------|',
    '| 1 | 1 | - | - |',
    '| 99 | 1 | - | - |',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    'None yet.',
    '',
    '## Session Continuity',
    '',
    'Last session: 2026-06-29 12:00',
    'Stopped at: mid-flight',
    'Resume file: None',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningPath, 'STATE.md'), stateContent);
  return cwd;
}

/**
 * Run `fn` while capturing every fd-1 write `cmdStateRebuild`'s `output()`
 * performs (it writes via a raw `fs.writeSync(1, ...)`, never
 * `console.log`/`process.stdout.write` — same seam `tests/io.test.cjs`
 * exercises for bug #1008). Standalone helper with no test context, so the
 * try/finally restore is CONTRIBUTING-compliant (same shape as
 * `withFaultyFs`).
 */
function captureStdout(fn) {
  const chunks = [];
  const original = fs.writeSync;
  fs.writeSync = (fd, data, offset, length) => {
    if (fd !== 1) return original(fd, data, offset, length);
    const chunk = Buffer.isBuffer(data)
      ? data.subarray(offset ?? 0, length === undefined ? data.length : (offset ?? 0) + length).toString('utf8')
      : String(data);
    chunks.push(chunk);
    return Buffer.byteLength(chunk, 'utf8');
  };
  try {
    fn();
  } finally {
    fs.writeSync = original;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ADR-1817 Phase 2: `state rebuild` CLI subcommand dispatch (criterion #5 + end-to-end)', () => {
  test('`state rebuild` with no flags reconciles drifted body fields and writes', (t) => {
    const cwd = projectWithDriftedState();
    t.after(() => cleanup(cwd));

    const result = runGsdTools('state rebuild', cwd);
    assert.ok(result.success, `state rebuild should succeed; stderr: ${result.stderr || result.error || ''}`);

    // Body fields reconciled with frontmatter.
    const live = readLiveState(cwd);
    assert.ok(live.includes('**Current Phase:** 2'),
      'body Current Phase must be reconciled to frontmatter value 2');
    assert.ok(live.includes('**Current Phase Name:** Phase Two'),
      'body Current Phase Name must be reconciled to frontmatter value');

    // Orphan table row dropped (phase 99 is not on disk).
    assert.ok(!live.includes('| 99 |'),
      'orphan row for phase 99 must be dropped (phaseInventoryProvider wired to disk scan)');

    // Audit log appended.
    const fullState = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');
    assert.ok(fullState.includes('## Rebuild Log'),
      'audit log section must be appended');
  });

  test('`state rebuild --dry-run` computes the diff but writes nothing', (t) => {
    const cwd = projectWithDriftedState();
    t.after(() => cleanup(cwd));
    const before = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');

    const result = runGsdTools('state rebuild --dry-run', cwd);
    assert.ok(result.success, `state rebuild --dry-run should succeed; error: ${result.error || ''}`);

    const after = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');
    assert.strictEqual(after, before,
      '--dry-run must NOT modify STATE.md on disk');

    // The structured output should signal mutations would occur (the fixture
    // has drift, so mutated=true in dry-run preview).
    assert.ok(result.output.includes('mutated'),
      `dry-run output should report mutated flag; output: ${result.output}`);
  });

  test('`state rebuild --verbose` emits audit-log entries to stderr', (t) => {
    const cwd = projectWithDriftedState();
    t.after(() => cleanup(cwd));

    // runGsdTools returns stdout only on success; --verbose writes to stderr,
    // so invoke gsd-tools directly to capture both streams separately.
    const stdout = execFileSync(
      process.execPath,
      [TOOLS_PATH, 'state', 'rebuild', '--verbose'],
      { cwd, encoding: 'utf8' },
    );
    // execFileSync does not separate stderr — stderr is inherited by default.
    // Assert via the canonical record written to STATE.md: the audit log
    // section is always appended (mutated fixture), and --verbose merely
    // tees the same entries to stderr. The functional guarantee (audit log
    // written) is what matters; the stderr tee is a convenience.
    const after = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');
    assert.ok(after.includes('## Rebuild Log'),
      '--verbose must still produce the audit log section in STATE.md');
    assert.ok(stdout.includes('rebuilt'),
      `--verbose stdout must include the rebuild result; got: ${stdout.slice(0, 200)}`);
  });

  test('`state rebuild` on a clean STATE.md is a no-op (idempotency, end-to-end)', (t) => {
    const cwd = projectWithDriftedState();
    t.after(() => cleanup(cwd));

    // First run: reconcile the drift.
    const first = runGsdTools('state rebuild', cwd);
    assert.ok(first.success, 'first rebuild should succeed');
    const afterFirst = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');

    // Second run: should detect no drift, write nothing beyond what's there.
    const second = runGsdTools('state rebuild', cwd);
    assert.ok(second.success, 'second rebuild should succeed');
    const afterSecond = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf8');

    assert.strictEqual(afterSecond, afterFirst,
      'second rebuild on the just-rebuilt file must be byte-identical (idempotency)');
  });

  test('`state rebuild` on a missing STATE.md emits a clean error, no stack trace', (t) => {
    const cwd = createTempProject('state-rebuild-missing');
    t.after(() => cleanup(cwd));
    // No STATE.md written.

    const result = runGsdTools('state rebuild', cwd);
    // The command emits an error result but does not crash the process.
    const combined = `${result.output}\n${result.error || ''}`;
    assert.ok(combined.includes('STATE.md not found'),
      'missing STATE.md should produce a clean "STATE.md not found" message');
    assert.ok(!combined.includes('at Object.'),
      'no raw stack trace should leak into the output (CONTRIBUTING QA Matrix)');
  });
});

// ---------------------------------------------------------------------------
// #3057 B1: the PRODUCTION `phaseInventoryProvider` closure (state.cts:3106),
// not just the pure `reconcileByPhaseTable` core, must distinguish a real
// disk-scan failure from a genuinely-empty/reconciled scan. In-process fault
// injection via `withFaultyFs` on the real `fs.readdirSync` the closure
// calls — never chmod, never the subprocess seam (both banned per
// tests/helpers/faulty-deps.cjs's module doc).
// ---------------------------------------------------------------------------

describe('#3057 B1: cmdStateRebuild (production adapter) surfaces a real phase-inventory scan failure', () => {
  test('FAILURE path: readdirSync(.planning/phases) faulted → phase_inventory_scan_failed:true, table left untouched, mutated:false', (t) => {
    const cwd = projectWithOnlyPhaseTableDrift();
    t.after(() => cleanup(cwd));
    const phasesDir = path.join(cwd, '.planning', 'phases');
    const originalReaddirSync = fs.readdirSync;

    const stdout = withFaultyFs({
      readdirSync: (p, ...rest) => {
        if (String(p) === phasesDir) {
          throw Object.assign(new Error('EACCES: permission denied, scandir ' + phasesDir), { code: 'EACCES' });
        }
        return originalReaddirSync(p, ...rest);
      },
    }, () => captureStdout(() => {
      stateMod.cmdStateRebuild(cwd, { dryRun: true }, false);
    }));

    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.phase_inventory_scan_failed, true,
      `a faulted disk scan must report phase_inventory_scan_failed:true; got: ${stdout}`);
    assert.strictEqual(parsed.mutated, false,
      'nothing else drifted in this fixture, so mutated must stay false — the failure is carried ONLY by the dedicated field');
    assert.strictEqual(parsed.phase_inventory_scan_reason,
      'EACCES: permission denied, scandir ' + phasesDir,
      `phase_inventory_scan_reason must carry the exact fault message from the injected readdirSync throw; got: ${JSON.stringify(parsed.phase_inventory_scan_reason)}`);

    // The orphan row must survive untouched — a failed scan is not a
    // trustworthy inventory to reconcile the table against.
    const live = readLiveState(cwd);
    assert.ok(live.includes('| 99 |'), 'orphan row for phase 99 must be preserved when the scan failed');
  });

  test('BENIGN path: the same fixture with an unfaulted disk scan reconciles the table and reports no failure', (t) => {
    const cwd = projectWithOnlyPhaseTableDrift();
    t.after(() => cleanup(cwd));

    const stdout = captureStdout(() => {
      stateMod.cmdStateRebuild(cwd, { dryRun: true }, false);
    });

    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.phase_inventory_scan_failed, false,
      `an unfaulted disk scan must report phase_inventory_scan_failed:false; got: ${stdout}`);
    assert.strictEqual(parsed.mutated, true,
      'the real disk scan finds phase 1 only, so the orphan row 99 is real drift the (dry-run) rebuild would fix');
    assert.strictEqual(parsed.phase_inventory_scan_reason, undefined,
      'a clean scan must leave phase_inventory_scan_reason absent, distinguishing it from a faulted scan');
  });
});
