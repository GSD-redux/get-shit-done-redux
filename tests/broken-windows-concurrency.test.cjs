// Regression tests for issue #3780 — `windows append` lost writes under
// concurrent writers.
//
// These must be real processes, not an in-process loop: the defect is a
// read -> compute -> rewrite cycle that is not serialized ACROSS processes,
// and any single-process simulation would prove nothing about the thing that
// actually breaks. Each child performs one append; every append must survive.
//
// On the unfixed code the first test fails reliably — measured here at 3 of 8
// appends surviving, and the maintainer's triage measured one entry lost in
// 8 of 10 runs with only two concurrent writers.
//
// The concurrent leg uses async `spawn` deliberately rather than the sync
// process-seam: `runNode` is spawnSync-based, which would serialize the
// writers and make the test incapable of observing the race. The spawns are
// still bounded — each carries its own kill timer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'broken-windows.cjs');
const WRITERS = 8;
const CHILD_TIMEOUT_MS = 30_000;

const APPEND_SRC = `
  const bw = require(${JSON.stringify(LIB)});
  bw.cmdWindowsAppend(process.argv[1], [
    '--kind', 'todo',
    '--phase', '1',
    '--description', process.argv[2],
  ]);
`;

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-windows-race-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

/** Spawn one child that appends a single window and exits. Bounded by a kill timer. */
function spawnAppend(cwd, description) {
  return new Promise((resolve) => {
    // stdio ignored: each child emits its own JSON, which we do not consume —
    // the ledger on disk is the assertion surface.
    const child = spawn(process.execPath, ['-e', APPEND_SRC, cwd, description], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    const done = (code) => { clearTimeout(timer); resolve(code); };
    child.on('exit', done);
    child.on('error', () => done(-1));
  });
}

function readEntries(cwd) {
  const raw = fs.readFileSync(path.join(cwd, '.planning', 'WINDOWS.md'), 'utf8');
  return require(LIB).parseLedger(raw).entries;
}

test('#3780: concurrent appends all land in the ledger', async () => {
  const cwd = mkProject();
  try {
    const codes = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) => spawnAppend(cwd, `concurrent writer ${i}`)),
    );

    // Every writer must report success. A writer that legitimately could not
    // get the lock exits non-zero — a loud failure is acceptable behavior, but
    // it must not happen at this concurrency.
    assert.deepStrictEqual(codes.filter((c) => c !== 0), [], 'every concurrent append should exit 0');

    const entries = readEntries(cwd);
    assert.strictEqual(
      entries.length,
      WRITERS,
      `expected all ${WRITERS} appends to survive, found ${entries.length} — writes were lost`,
    );

    // Ids must be dense and unique: two writers computing the same nextId from
    // the same snapshot is the mechanism behind the loss.
    assert.deepStrictEqual(
      entries.map((e) => e.id).sort((a, b) => a - b),
      Array.from({ length: WRITERS }, (_, i) => i + 1),
      'ids should be unique and dense',
    );

    // And no writer's payload may be silently dropped in favour of another's.
    assert.strictEqual(
      new Set(entries.map((e) => e.description)).size,
      WRITERS,
      "every writer's description should be present exactly once",
    );
  } finally {
    cleanup(cwd);
  }
});

test('#3780: the ledger stays parseable and the lock is released', async () => {
  const cwd = mkProject();
  try {
    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) => spawnAppend(cwd, `racer ${i}`)),
    );

    // The atomic-rename writer's all-or-nothing property is a stated guard
    // rail: the ledger must never be partial, even in the failing case. This
    // leg passes with and without the fix — that is the point.
    const entries = readEntries(cwd);
    assert.ok(entries.length > 0, 'ledger should parse after concurrent writes');
    for (const e of entries) {
      assert.strictEqual(typeof e.id, 'number');
      assert.strictEqual(e.status, 'open');
    }

    assert.strictEqual(
      fs.existsSync(path.join(cwd, '.planning', 'WINDOWS.md.lock')),
      false,
      'lock should be released after every writer finishes',
    );
  } finally {
    cleanup(cwd);
  }
});

test('#3780: a single writer is unaffected — same ids, same shape', () => {
  const cwd = mkProject();
  try {
    for (let i = 0; i < 3; i++) {
      const r = runNode(['-e', APPEND_SRC, cwd, `sequential ${i}`], { timeoutMs: CHILD_TIMEOUT_MS });
      assert.strictEqual(r.exitCode, 0, `sequential append ${i} should succeed: ${r.stderr}`);
    }

    const entries = readEntries(cwd);
    assert.deepStrictEqual(entries.map((e) => e.id), [1, 2, 3], 'sequential id assignment is unchanged');
    assert.strictEqual(entries[0].description, 'sequential 0');
    assert.strictEqual(entries[0].status, 'open');
  } finally {
    cleanup(cwd);
  }
});
