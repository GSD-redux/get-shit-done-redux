const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');

const planningWorkspaceDirect = require('../gsd-core/bin/lib/planning-workspace.cjs');

const {
  createPlanningWorkspace,
  createMemoryPointerAdapter,
  planningDir,
  planningPaths,
  withPlanningLock,
  getActiveWorkstream,
  setActiveWorkstream,
} = planningWorkspaceDirect;

describe('planning-workspace: planningDir/planningPaths parity', () => {
  const cwd = '/fake/repo';
  let savedProject;
  let savedWorkstream;

  beforeEach(() => {
    savedProject = process.env.GSD_PROJECT;
    savedWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
  });

  afterEach(() => {
    if (savedProject !== undefined) process.env.GSD_PROJECT = savedProject;
    else delete process.env.GSD_PROJECT;
    if (savedWorkstream !== undefined) process.env.GSD_WORKSTREAM = savedWorkstream;
    else delete process.env.GSD_WORKSTREAM;
  });

  test('matches expected path resolution', () => {
    assert.strictEqual(planningDir(cwd, null, null), path.join(cwd, '.planning'));
    assert.strictEqual(planningDir(cwd, 'feature-x', null), path.join(cwd, '.planning', 'workstreams', 'feature-x'));
    assert.strictEqual(planningDir(cwd, 'feature-x', 'my-app'), path.join(cwd, '.planning', 'my-app', 'workstreams', 'feature-x'));

    const paths = planningPaths(cwd, 'feature-x');
    assert.strictEqual(paths.planning, path.join(cwd, '.planning', 'workstreams', 'feature-x'));
    assert.strictEqual(paths.state, path.join(cwd, '.planning', 'workstreams', 'feature-x', 'STATE.md'));
    assert.strictEqual(paths.config, path.join(cwd, '.planning', 'workstreams', 'feature-x', 'config.json'));
  });

  test('rejects traversal and path separators', () => {
    assert.throws(() => planningDir(cwd, null, '../../etc'), /invalid path characters/);
    assert.throws(() => planningDir(cwd, 'foo/bar', null), /invalid path characters/);
    assert.throws(() => planningDir(cwd, 'foo\\bar', null), /invalid path characters/);
  });
});

describe('planning-workspace: session adapter precedence', () => {
  let savedSession;

  beforeEach(() => {
    savedSession = process.env.GSD_SESSION_KEY;
  });

  afterEach(() => {
    if (savedSession !== undefined) process.env.GSD_SESSION_KEY = savedSession;
    else delete process.env.GSD_SESSION_KEY;
  });

  test('uses session adapter over shared adapter when session key exists', () => {
    process.env.GSD_SESSION_KEY = 'session-123';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-precedence-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'session-ws'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'shared-ws'), { recursive: true });

      const session = createMemoryPointerAdapter('session-ws');
      const shared = createMemoryPointerAdapter('shared-ws');
      const workspace = createPlanningWorkspace(tmpDir, {
        activeWorkstreamAdapters: { session, shared },
      });

      assert.strictEqual(workspace.activeWorkstream.get(), 'session-ws');
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace: self-heal behavior', () => {
  test('clears invalid pointer names and returns null', () => {
    const adapter = createMemoryPointerAdapter('bad/name');
    const workspace = createPlanningWorkspace('/fake/repo', {
      activeWorkstreamAdapter: adapter,
    });

    assert.strictEqual(workspace.activeWorkstream.get(), null);
    assert.strictEqual(adapter.read(), null);
  });

  test('clears stale pointers when workstream directory is gone', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-workspace-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams'), { recursive: true });
      const adapter = createMemoryPointerAdapter('ghost');
      const workspace = createPlanningWorkspace(tmpDir, {
        activeWorkstreamAdapter: adapter,
      });

      assert.strictEqual(workspace.activeWorkstream.get(), null);
      assert.strictEqual(adapter.read(), null);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace: lock seam', () => {
  test('exports withPlanningLock and acquires/release lock', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-lock-'));
    try {
      const result = withPlanningLock(tmpDir, () => 'ok');
      assert.strictEqual(result, 'ok');
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')));
    } finally {
      cleanup(tmpDir);
    }
  });

  test('does not retry errors thrown by locked work', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-lock-work-error-'));
    let attempts = 0;
    try {
      assert.throws(() => {
        withPlanningLock(tmpDir, () => {
          attempts += 1;
          const err = new Error('write failed inside critical section');
          err.code = 'EIO';
          throw err;
        });
      }, /write failed inside critical section/);
      assert.strictEqual(attempts, 1);
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')));
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace direct: functions expose matching behavior', () => {
  let savedSession;

  beforeEach(() => {
    savedSession = process.env.GSD_SESSION_KEY;
    delete process.env.GSD_SESSION_KEY;
  });

  afterEach(() => {
    if (savedSession !== undefined) process.env.GSD_SESSION_KEY = savedSession;
    else delete process.env.GSD_SESSION_KEY;
  });

  test('planning-workspace functions work consistently', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-core-compat-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });

      planningWorkspaceDirect.setActiveWorkstream(tmpDir, 'alpha');
      assert.strictEqual(planningWorkspaceDirect.getActiveWorkstream(tmpDir), 'alpha');
      assert.strictEqual(getActiveWorkstream(tmpDir), 'alpha');

      assert.strictEqual(
        planningWorkspaceDirect.planningDir(tmpDir, 'feature-x', 'my-project'),
        planningDir(tmpDir, 'feature-x', 'my-project')
      );
      assert.deepStrictEqual(
        planningWorkspaceDirect.planningPaths(tmpDir, 'feature-x'),
        planningPaths(tmpDir, 'feature-x')
      );

      setActiveWorkstream(tmpDir, null);
      assert.strictEqual(planningWorkspaceDirect.getActiveWorkstream(tmpDir), null);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withPlanningLock PID-liveness staleness + EEXIST safety (audit M1 + M2)
//
// M1: the prior timeout fallback unconditionally unlinked WHATEVER lock existed —
//     even a fresh, live holder's — then re-acquired. A legitimate op taking
//     longer than lockTimeout (10 000 ms) got its lock force-stolen. The fix gates
//     stealing on a real liveness signal (injected via _setLockProbes): a dead
//     holder is stolen promptly inside the polite loop; a LIVE holder is waited on
//     and, on genuine timeout, the waiter throws a clear timeout error rather than
//     corrupting the live holder's critical section.
//
// M2: the timeout-fallback re-acquire (acquireLock with { flag: 'wx' }) sat OUTSIDE
//     any try/catch — if another process re-created the lock between the unlink and
//     the wx write, a raw EEXIST escaped the helper and crashed the command. The
//     fix removes the unconditional force-steal so no raw EEXIST can escape.
// ─────────────────────────────────────────────────────────────────────────────

describe('withPlanningLock PID-liveness staleness + EEXIST safety (audit M1+M2)', () => {
  let tmpDir;
  let lockPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-liveness-planning-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    lockPath = path.join(tmpDir, '.planning', '.lock');
  });

  afterEach(() => {
    planningWorkspaceDirect._resetLockProbes();
    if (typeof planningWorkspaceDirect._resetPlanningLockTestHooks === 'function') {
      planningWorkspaceDirect._resetPlanningLockTestHooks();
    }
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('a dead holder recreated by a racer mid-steal is NOT double-stolen (identity re-confirm — PR #1532)', () => {
    const deadPid = 4040;
    const livePid = 5050;
    // Decision-time holder: a DEAD pid → eligible for steal inside the polite loop.
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    // Inject a concurrent waiter that, in the gap between our steal-DECISION and our
    // steal, already stole + recreated a FRESH lock owned by a LIVE pid. A correct
    // (identity-re-confirming) acquirer must notice the instance changed and must NOT
    // delete the racer's live replacement.
    let injected = false;
    planningWorkspaceDirect._setPlanningLockTestHooks({
      beforeSteal: () => {
        if (injected) return;
        injected = true;
        try { fs.unlinkSync(lockPath); } catch { /* ok */ }
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: livePid,
          cwd: tmpDir,
          acquired: new Date().toISOString(),
        }));
      },
    });

    let ranCriticalSection = false;
    const clock = makeFakeClock(0);
    // The racer's replacement is held by a LIVE pid → the acquirer must wait on it and
    // budget out, NOT delete it and run the critical section (which a double-steal does).
    assert.throws(
      () => withPlanningLock(tmpDir, () => { ranCriticalSection = true; return 'x'; }, clock),
      (err) => err && err.lockTimeout === true,
      'acquirer must not double-steal the racer\'s live replacement — it must wait + time out'
    );
    assert.strictEqual(ranCriticalSection, false, 'critical section must NOT run — the live replacement was not stolen');
    assert.ok(fs.existsSync(lockPath), 'the racer\'s live replacement lock must survive');
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.strictEqual(body.pid, livePid, 'the racer\'s freshly-recreated live lock body must be intact (never deleted by a stale-decision unlink)');
  });

  test('exports _setLockProbes / _resetLockProbes seams', () => {
    assert.ok(typeof planningWorkspaceDirect._setLockProbes === 'function', '_setLockProbes seam must be exported');
    assert.ok(typeof planningWorkspaceDirect._resetLockProbes === 'function', '_resetLockProbes seam must be exported');
  });

  test('live holder held past lockTimeout is NOT force-stolen — waiter throws a clear timeout error', () => {
    const livePid = 5151;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: livePid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Holder pid reads as ALIVE → must never be force-stolen.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    let ranCriticalSection = false;
    // Fake clock whose sleep advances past lockTimeout (10 000 ms) so the polite
    // loop budgets out; the live holder must survive and the waiter must throw.
    const clock = makeFakeClock(0);
    assert.throws(
      () => withPlanningLock(tmpDir, () => { ranCriticalSection = true; return 'stolen'; }, clock),
      /lock/i,
      'a live holder must never be force-stolen on timeout — the waiter must throw a clear timeout error'
    );

    assert.strictEqual(ranCriticalSection, false, 'critical section must NOT run against a live holder (no force-steal)');
    assert.ok(fs.existsSync(lockPath), 'live holder lock must still exist (not unlinked)');
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.strictEqual(body.pid, livePid, 'live holder lock body must be unchanged');
  });

  test('dead holder is stolen promptly inside the polite loop (no full timeout wait)', () => {
    const deadPid = 888;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Holder pid reads as DEAD → eligible for prompt steal inside the loop.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: () => false });

    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'acquired', clock);
    assert.strictEqual(result, 'acquired', 'dead holder lock must be stolen and the critical section must run');
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after the critical section completes');
  });

  test('M2: no raw EEXIST escapes the helper on the timeout path against a live holder', () => {
    const livePid = 6262;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: livePid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    const clock = makeFakeClock(0);
    let caught;
    try {
      withPlanningLock(tmpDir, () => 'x', clock);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'helper must surface a failure rather than silently force-stealing a live lock');
    assert.notStrictEqual(caught.code, 'EEXIST', 'a raw EEXIST must never escape the lock helper (M2)');
  });

  test('R4-FIX: false-alive pid-reuse holder aged past the deadman ceiling IS stolen (self-heal)', () => {
    const reusedPid = 7373;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: reusedPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Probe says the recorded pid is ALIVE — simulating pid-reuse: the original holder
    // crashed but its pid was recycled by an unrelated live process. The .lock body has
    // no startTime, so liveness alone cannot distinguish this from a genuine live holder.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === reusedPid });

    // Lock mtime ≈ now (real); seed the fake clock ABOVE the 60 000 ms deadman ceiling so
    // age = clock.now() - mtimeMs ≫ ceiling → the lock must be recovered despite "alive".
    // Without the ceiling, withPlanningLock would throw on every call with no self-heal.
    const clock = makeFakeClock(Date.now() + 120000);
    const result = withPlanningLock(tmpDir, () => 'self-healed', clock);
    assert.strictEqual(result, 'self-healed', 'a false-alive lock past the deadman ceiling must be stolen (no infinite block)');
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after the critical section completes');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3739-gap-checker-padded-prefix-context.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3739-gap-checker-padded-prefix-context (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #3739: gap-analysis silently skips CONTEXT.md decisions when the file
 * uses the padded-prefix convention (e.g. 01-CONTEXT.md, 02.1-CONTEXT.md).
 *
 * Verifies:
 *   1. Padded-prefix CONTEXT.md (NN-CONTEXT.md) decisions ARE included in the
 *      gap report — was silently skipped before the fix.
 *   2. Decisions from padded-prefix CONTEXT.md ARE checked for coverage.
 *   3. Bare CONTEXT.md still works — no regression on the existing path.
 *   4. A padded-prefix decision that is NOT covered in the plan is surfaced
 *      as "Not covered" (not silently dropped from the report).
 *   5. planning-workspace.cjs findContextMdIn() helper returns the right
 *      filename for both bare and padded forms (unit test for the extractor).
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #3739 — gap-analysis padded-prefix CONTEXT.md', () => {
  let tmpDir;
  let phaseDir;

  function writeContextAs(filename, decisions) {
    const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
    fs.writeFileSync(
      path.join(phaseDir, filename),
      `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`
    );
  }

  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }

  function ensureConfig() {
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    ensureConfig();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Test 1: padded-prefix decisions appear in the gap report ─────────────

  test('decisions from padded-prefix CONTEXT.md (01-CONTEXT.md) appear in gap report', () => {
    writeContextAs('01-CONTEXT.md', [
      { id: 'D-01', text: 'Use library X' },
      { id: 'D-02', text: 'Fail loud on unknown input' },
    ]);
    writePlan('01', '# Plan\n\nImplements D-01 and D-02.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    const d01 = out.rows.find(x => x.item === 'D-01');
    const d02 = out.rows.find(x => x.item === 'D-02');

    assert.ok(d01, 'D-01 row must appear in gap report when CONTEXT.md uses padded-prefix 01-CONTEXT.md');
    assert.ok(d02, 'D-02 row must appear in gap report when CONTEXT.md uses padded-prefix 01-CONTEXT.md');
    assert.strictEqual(d01.source, 'CONTEXT.md', 'source label must be CONTEXT.md');
    assert.strictEqual(d01.status, 'Covered', 'D-01 is mentioned in plan — must be Covered');
    assert.strictEqual(d02.status, 'Covered', 'D-02 is mentioned in plan — must be Covered');
  });

  // ── Test 2: uncovered padded-prefix decision surfaces as Not covered ──────

  test('uncovered decision from padded-prefix CONTEXT.md surfaces as Not covered', () => {
    writeContextAs('01-CONTEXT.md', [
      { id: 'D-01', text: 'Use library X' },
    ]);
    writePlan('01', '# Plan\n\nUnrelated work, no mention of any D-NN.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    const d01 = out.rows.find(x => x.item === 'D-01');
    assert.ok(d01, 'D-01 row must appear even when not covered');
    assert.strictEqual(d01.status, 'Not covered',
      'D-01 must be Not covered (not silently absent) when plan omits it');
  });

  // ── Test 3 (counter-test): bare CONTEXT.md still works — no regression ───

  test('bare CONTEXT.md still works (regression guard)', () => {
    writeContextAs('CONTEXT.md', [
      { id: 'D-05', text: 'Bare form decision' },
    ]);
    writePlan('01', '# Plan\n\nImplements D-05.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    const d05 = out.rows.find(x => x.item === 'D-05');
    assert.ok(d05, 'D-05 must appear when CONTEXT.md uses bare filename');
    assert.strictEqual(d05.status, 'Covered', 'D-05 must be Covered');
  });

  // ── Test 4: deeper padded prefix (02.1-CONTEXT.md) ───────────────────────

  test('multi-segment padded prefix (02.1-CONTEXT.md) decisions appear in gap report', () => {
    writeContextAs('02.1-CONTEXT.md', [
      { id: 'D-03', text: 'Use postgres' },
    ]);
    writePlan('01', '# Plan\n\nImplements D-03.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    const d03 = out.rows.find(x => x.item === 'D-03');
    assert.ok(d03, 'D-03 must appear from 02.1-CONTEXT.md');
    assert.strictEqual(d03.status, 'Covered');
  });

  // ── Test 5: findContextMdIn helper unit test ─────────────────────────────

  test('findContextMdIn helper returns padded filename when present', () => {
    const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    // Write 01-CONTEXT.md into the phase dir (already created in beforeEach)
    fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# context\n');

    const found = findContextMdIn(phaseDir);
    assert.strictEqual(found, '01-CONTEXT.md',
      'findContextMdIn must return the padded-prefix filename');
  });

  test('findContextMdIn helper returns bare filename when only bare form exists', () => {
    const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# context\n');

    const found = findContextMdIn(phaseDir);
    assert.strictEqual(found, 'CONTEXT.md',
      'findContextMdIn must return CONTEXT.md for bare form');
  });

  test('findContextMdIn helper returns null when no CONTEXT.md exists', () => {
    const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    // phaseDir exists but is empty (no CONTEXT.md)
    const found = findContextMdIn(phaseDir);
    assert.strictEqual(found, null,
      'findContextMdIn must return null when no CONTEXT.md exists');
  });

  // ── Test 5b: findContextMdIn accepts pre-read files array (avoids double readdirSync) ──

  test('findContextMdIn accepts an already-read files array (avoids double readdirSync)', () => {
    const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    // Passing an array directly should behave identically to passing a directory path.
    assert.strictEqual(findContextMdIn(['CONTEXT.md', 'other.md']), 'CONTEXT.md',
      'bare form found in array');
    assert.strictEqual(findContextMdIn(['01-CONTEXT.md', 'other.md']), '01-CONTEXT.md',
      'padded form found in array');
    assert.strictEqual(findContextMdIn(['unrelated.md']), null,
      'returns null when no CONTEXT.md in array');
    // Bare wins over padded when both are present
    assert.strictEqual(findContextMdIn(['01-CONTEXT.md', 'CONTEXT.md']), 'CONTEXT.md',
      'bare form preferred over padded form when both in array');
  });

  // ── Test 6: dual-file precedence — bare CONTEXT.md wins over padded form ──

  test('findContextMdIn prefers bare CONTEXT.md over padded form (helper level)', () => {
    const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    // Write BOTH forms into the phase directory
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# bare context\n');
    fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# padded context\n');

    const found = findContextMdIn(phaseDir);
    assert.strictEqual(found, 'CONTEXT.md',
      'findContextMdIn must return bare CONTEXT.md when both forms exist — matches pre-refactor gap-checker behavior');
  });

  test('gap-analysis uses bare CONTEXT.md decisions when both forms exist (integration level)', () => {
    // Bare form has D-BARE; padded form has D-PADDED.
    // If the integration path resolves bare correctly, only D-BARE appears in the report.
    const bareContent =
      '# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n- **D-BARE:** From bare form\n</decisions>\n';
    const paddedContent =
      '# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n- **D-PADDED:** From padded form\n</decisions>\n';
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), bareContent);
    fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), paddedContent);

    writePlan('01', '# Plan\n\nImplements D-BARE.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    const dBare = out.rows.find(x => x.item === 'D-BARE');
    const dPadded = out.rows.find(x => x.item === 'D-PADDED');

    assert.ok(dBare, 'D-BARE (from bare CONTEXT.md) must appear in gap report');
    assert.ok(!dPadded, 'D-PADDED (from 01-CONTEXT.md) must NOT appear — bare form takes precedence');
    assert.strictEqual(dBare.status, 'Covered', 'D-BARE must be Covered');
  });
});
  });
}

// ─── bug #1883: findContextMdIn must not swallow permission/I-O errors ───────
// A catch-all `catch { return null }` conflated a genuine ENOENT ("nothing there")
// with an EACCES/EIO failure ("can't read this"), so an unreadable phase dir was
// silently reported as "no CONTEXT.md" — discuss/plan gates then wrongly believed
// context had never been gathered. The narrowed catch re-throws every non-ENOENT
// error and keeps returning null only for genuine absence.
describe('bug #1883 — findContextMdIn distinguishes a permission error from emptiness', () => {
  const { findContextMdIn } = require('../gsd-core/bin/lib/planning-workspace.cjs');

  // Helper: build a Node-style error with a `code`, matching what fs.readdirSync throws.
  function fsError(code) {
    const err = new Error(`${code}: operation failed, scandir '/denied'`);
    err.code = code;
    err.syscall = 'scandir';
    err.path = '/denied';
    return err;
  }

  test('findContextMdIn re-throws a permission (EACCES) error instead of swallowing it as null', (t) => {
    // No chmod 0o000 — root bypasses mode bits (silent zero coverage in root CI).
    // t.mock auto-restores after the test.
    t.mock.method(fs, 'readdirSync', () => { throw fsError('EACCES'); });
    assert.throws(
      () => findContextMdIn('/denied/phase-dir'),
      (err) => err.code === 'EACCES',
      'an unreadable dir must propagate EACCES, not return null as if empty',
    );
  });

  test('findContextMdIn re-throws any non-ENOENT error (EIO)', (t) => {
    t.mock.method(fs, 'readdirSync', () => { throw fsError('EIO'); });
    assert.throws(
      () => findContextMdIn('/io-failure/phase-dir'),
      (err) => err.code === 'EIO',
      'every non-ENOENT error must propagate — the narrowed catch only keeps ENOENT',
    );
  });

  test('findContextMdIn returns null for an absent dir (ENOENT) — empty path unchanged', () => {
    // A path that genuinely does not exist yields ENOENT from the real OS call.
    const absent = path.join(os.tmpdir(), 'gsd-1883-does-not-exist-' + process.pid);
    assert.strictEqual(findContextMdIn(absent), null,
      'an absent dir (ENOENT) must still return null — Hyrum: empty path unchanged');
  });

  test('findContextMdIn finds bare CONTEXT.md', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1883-bare-'));
    t.after(() => { cleanup(tmp); });
    fs.writeFileSync(path.join(tmp, 'CONTEXT.md'), '# bare\n');
    assert.strictEqual(findContextMdIn(tmp), 'CONTEXT.md');
  });

  test('findContextMdIn finds padded NN-CONTEXT.md', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1883-padded-'));
    t.after(() => { cleanup(tmp); });
    fs.writeFileSync(path.join(tmp, '01-CONTEXT.md'), '# padded\n');
    assert.strictEqual(findContextMdIn(tmp), '01-CONTEXT.md');
  });

  test('findContextMdIn matches against a pre-read files array without touching fs', (t) => {
    // The array path never calls readdirSync — exercised by getPhaseFileStats,
    // countPhasePlansAndSummaries, runGapAnalysis. Must keep working untouched.
    t.mock.method(fs, 'readdirSync', () => { throw new Error('array path must not call fs'); });
    assert.strictEqual(findContextMdIn(['CONTEXT.md', 'PLAN.md']), 'CONTEXT.md',
      'array path matches bare form');
    assert.strictEqual(findContextMdIn(['02-CONTEXT.md']), '02-CONTEXT.md',
      'array path matches padded form');
    assert.strictEqual(findContextMdIn(['PLAN.md']), null,
      'array path returns null when no match');
  });
});
