/**
 * Regression test for perf #316 — acquireStateLock allocates a fresh
 * SharedArrayBuffer on every retry iteration.
 *
 * The fix: hoist the sleep buffer allocation to once before the retry loop.
 * The buffer is never mutated and never escapes — Atomics.wait(buf,0,0,delay)
 * always sees 0 whether the buffer is fresh or reused, so the behavior is
 * identical.
 *
 * Observable invariant (POST-FIX): exactly ONE SharedArrayBuffer is allocated
 * per acquireStateLock call, regardless of retry count.
 *
 * RED (pre-fix):  sabCount >= 2 when >= 1 retry occurs.
 * GREEN (post-fix): sabCount === 1.
 *
 * Strategy: two Worker threads run in parallel.
 *   Worker A (lock holder): writes the lock file with the current process pid,
 *     sleeps 400ms via Atomics.wait, then removes the lock.
 *   Worker B (writer): installs a counting SharedArrayBuffer stub, then calls
 *     writeStateMd — which calls acquireStateLock and retries until A releases.
 *     Reports sabCount via postMessage.
 *
 * Using Worker threads (not child processes) avoids the node --test subprocess-
 * detection hang that occurs with spawn() inside a test runner worker context.
 *
 * Total test wall-time: ~400-600ms.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STATE_CJS_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'state.cjs'
);
// ADR-3473 §8.6: the writer worker's writeStateMd call now needs a
// rebuildStateTransaction() — resolved as a separate require path since the
// worker script runs in its own isolated module scope.
const STATE_TRANSITION_CJS_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'state-transition.cjs'
);
const FRONTMATTER_CJS_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'frontmatter.cjs'
);

const MINIMAL_STATE_MD = [
  '# Project State',
  '',
  '**Status:** Planning',
  '**Current Phase:** 01',
].join('\n') + '\n';

// Worker A: holds the lock file for holdMs, then removes it.
// workerData: { lockPath, holdMs }
const HOLDER_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
// Write pid to lock file so acquireStateLock sees a live pid and retries.
fs.writeFileSync(workerData.lockPath, String(process.pid));
parentPort.postMessage({ pid: process.pid });
// Hold the lock until the writer signals it has made its first FAILED lock
// attempt (deterministic contention), or until holdMs elapses as a safety cap.
// Atomics.wait blocks this thread while releaseFlag[0] === 0. A fixed timer here
// was racy: on a slow/loaded runner the writer's spawn+init could exceed the
// timer, so the lock released before the writer ever contended (lockAttempts:1).
const releaseFlag = new Int32Array(workerData.releaseSab);
Atomics.wait(releaseFlag, 0, 0, workerData.holdMs);
// Release the lock.
try { fs.unlinkSync(workerData.lockPath); } catch { /* already gone */ }
parentPort.postMessage({ done: true });
`;

// Worker B: stubs global.SharedArrayBuffer with a counting call-through wrapper,
// then calls writeStateMd (triggering acquireStateLock), and reports sabCount.
// workerData: { stateCjsPath, statePath, content, tmpDir }
const WRITER_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const RealSAB = global.SharedArrayBuffer;
let sabCount = 0;
// Stub: increments sabCount, calls through so Atomics.wait gets a real SAB-backed buffer.
function StubSAB(...args) {
  sabCount++;
  return new RealSAB(...args);
}
StubSAB.prototype = RealSAB.prototype;
global.SharedArrayBuffer = StubSAB;

// Lock-attempt counter: stubs fs.openSync to count atomic-create attempts
// (state.cjs's acquireStateLock uses fs.openSync(..., O_CREAT|O_EXCL|O_WRONLY)
// to atomically create the lock file). Each call with O_CREAT|O_EXCL flags
// is one retry-loop iteration. >=2 attempts proves the SUT entered the retry
// path — without this witness, a no-retry success would yield sabCount === 1
// from BOTH pre-fix and post-fix code (the SAB is allocated unconditionally
// post-fix, and exactly once for the single successful open pre-fix), giving
// a false-pass against the bug. Contention is deterministic here: this worker
// signals the holder to release only after its first failed attempt, so a
// retry always occurs (lockAttempts >= 2) regardless of runner speed.
const realOpenSync = fs.openSync.bind(fs);
const releaseFlag = new Int32Array(workerData.releaseSab);
let lockAttempts = 0;
fs.openSync = function(filePath, flags, mode) {
  const isLockCreate = typeof filePath === 'string' && filePath.endsWith('.lock') &&
      typeof flags === 'number' &&
      (flags & fs.constants.O_CREAT) && (flags & fs.constants.O_EXCL);
  if (isLockCreate) lockAttempts++;
  try {
    return realOpenSync(filePath, flags, mode);
  } catch (e) {
    // On the FIRST failed atomic-create (lock is held → contention proven),
    // signal the holder worker to release so the next retry succeeds. Makes the
    // retry path deterministic regardless of worker-spawn latency.
    if (isLockCreate && lockAttempts === 1) {
      Atomics.store(releaseFlag, 0, 1);
      Atomics.notify(releaseFlag, 0);
    }
    throw e;
  }
};

// Delete cache entry to ensure a fresh require picks up the stubbed constructor.
// (The inline "new SharedArrayBuffer(4)" in acquireStateLock reads the global at
// call time, so even a cached require would use our stub — but deleting avoids
// any module-level SAB allocations from a prior require contaminating sabCount.)
delete require.cache[workerData.stateCjsPath];
const { writeStateMd } = require(workerData.stateCjsPath);
const { rebuildStateTransaction } = require(workerData.stateTransitionCjsPath);
const { extractFrontmatter } = require(workerData.frontmatterCjsPath);

let callErr = null;
try {
  // ADR-3473 §8.6: writeStateMd now requires a rebuild() transaction — this
  // worker's write mirrors REGENERATE_STATE's shape (a fresh, no-frontmatter
  // MINIMAL_STATE_MD body), so the snapshot is of whatever (if anything)
  // already exists on disk at statePath before this write.
  const priorContent = fs.existsSync(workerData.statePath)
    ? fs.readFileSync(workerData.statePath, 'utf8')
    : '';
  writeStateMd(workerData.statePath, workerData.content, rebuildStateTransaction({
    snapshot: extractFrontmatter(priorContent, workerData.statePath),
  }), workerData.tmpDir);
} catch (e) {
  callErr = (e && e.message) ? e.message : String(e);
}
parentPort.postMessage({ sabCount, lockAttempts, callErr });
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-316-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function removeTempDir(dir) {
  try { cleanup(dir); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────────────────────────────────────

describe('perf #316: acquireStateLock hoists sleep buffer — exactly one SAB per call', () => {
  let tmpDir;
  let statePath;
  let lockPath;
  let holderWorker;

  beforeEach(() => {
    tmpDir = makeTempDir();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    lockPath = statePath + '.lock';
    fs.writeFileSync(statePath, MINIMAL_STATE_MD, 'utf-8');
  });

  afterEach(async () => {
    await holderWorker?.terminate();
    holderWorker = null;
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    removeTempDir(tmpDir);
  });

  test(
    'sabCount === 1 after a call that undergoes >= 1 retry (post-fix assertion)',
    { timeout: 15000 },
    async () => {
      // ── Worker A: hold the lock until the writer signals contention ─────────
      // The holder releases the lock only when the writer signals its first
      // failed lock attempt (see WRITER_WORKER_CODE), so the writer is guaranteed
      // to contend at least once. holdMs is ONLY a safety cap for a dead/hung
      // writer — it MUST be large enough that it never elapses while Worker B is
      // still spawning + requiring state.cjs + installing its stubs. Under load
      // (full suite in a container) that spawn+init can exceed 1s; a 1s cap let A
      // time out and remove the lock before B contended, so B's first openSync
      // succeeded (lockAttempts:1) and the retry-path witness failed. 30s is
      // comfortably beyond B's worst-case init yet still bounded; the test's own
      // timeout caps wall-clock, and afterEach terminate()s A the moment B posts
      // its result, so the normal path adds no delay.
      const holdMs = 30000;
      const releaseSab = new SharedArrayBuffer(4);
      let resolveLockWritten;
      const lockWritten = new Promise((resolve) => { resolveLockWritten = resolve; });
      const holderDone = new Promise((resolve, reject) => {
        holderWorker = new Worker(HOLDER_WORKER_CODE, {
          eval: true,
          workerData: { lockPath, holdMs, releaseSab },
        });
        holderWorker.on('message', (msg) => {
          if (msg.pid !== undefined) resolveLockWritten();
          if (msg.done) resolve();
        });
        holderWorker.on('error', (err) => {
          resolveLockWritten(); // unblock so the assert below fires immediately
          reject(err);
        });
        holderWorker.on('exit', (code) => {
          resolveLockWritten(); // unblock if Worker A exits before posting
          if (code !== 0) reject(new Error('Holder worker exit code: ' + code));
        });
      });
      // Suppress unhandled-rejection warnings on holderDone — we always observe
      // it later via `await holderDone`, which re-throws the original error.
      holderDone.catch(() => {});

      // Deterministic synchronization: await Worker A's {pid} message, which
      // it posts AFTER fs.writeFileSync returns (single-thread source order
      // within the worker). By the time the parent receives this message,
      // the lock file exists on disk and is visible across threads (workers
      // share the same OS file table). The MessagePort buffers messages
      // posted before the listener attaches, so there is no listener-race.
      // Ref: https://nodejs.org/api/worker_threads.html#event-message_1
      // The 5000ms safety timeout catches a hung holder; nominal latency <50ms.
      let lockWrittenTimer;
      const lockWrittenTimeout = new Promise((_, reject) => {
        lockWrittenTimer = setTimeout(
          () => reject(new Error('Holder worker did not post pid within 5000ms')),
          5000
        );
      });
      try {
        await Promise.race([lockWritten, lockWrittenTimeout]);
      } finally {
        clearTimeout(lockWrittenTimer);
      }
      assert.ok(fs.existsSync(lockPath), 'Worker A must have written the lock file');

      // ── Worker B: call writeStateMd, measure SAB allocations ───────────────
      let writerWorker;
      let writeResult;
      try {
        writeResult = await new Promise((resolve, reject) => {
          writerWorker = new Worker(WRITER_WORKER_CODE, {
            eval: true,
            workerData: {
              stateCjsPath: STATE_CJS_PATH,
              stateTransitionCjsPath: STATE_TRANSITION_CJS_PATH,
              frontmatterCjsPath: FRONTMATTER_CJS_PATH,
              statePath,
              content: MINIMAL_STATE_MD,
              tmpDir,
              releaseSab,
            },
          });
          writerWorker.on('message', resolve);
          writerWorker.on('error', reject);
          writerWorker.on('exit', (code) => {
            if (code !== 0) reject(new Error('Writer worker exit code: ' + code));
          });
        });
      } finally {
        await writerWorker?.terminate();
      }

      // Wait for Worker A to finish releasing
      await holderDone;

      // ── Assertions ─────────────────────────────────────────────────────────
      assert.ok(
        writeResult.callErr === null,
        'writeStateMd must succeed once the lock is released — error: ' + writeResult.callErr
      );

      assert.ok(
        writeResult.sabCount >= 1,
        'at least one SharedArrayBuffer must be allocated (the sleep buffer must exist)'
      );

      // PROOF OF RETRY-PATH COVERAGE (Contract 4 of test-rigor):
      //   The sabCount === 1 invariant below only discriminates pre-fix from
      //   post-fix when the SUT actually entered the retry loop. Without this
      //   witness, a no-retry success path yields sabCount === 1 under BOTH
      //   pre-fix and post-fix code (one SAB for the single successful open).
      //   lockAttempts counts atomic-create attempts (fs.openSync with
      //   O_CREAT|O_EXCL); >=2 means at least one failed-then-retried.
      assert.ok(
        writeResult.lockAttempts >= 2,
        'SUT must have entered the retry path (>=1 failed lock attempt before success). ' +
          'Got lockAttempts: ' + writeResult.lockAttempts + '. The holder releases only ' +
          'after the writer signals its first failed attempt, so contention is deterministic.'
      );

      // THE KEY INVARIANT:
      //   POST-FIX: sabCount === 1  (buffer allocated once, before the retry loop)
      //   PRE-FIX:  sabCount === lockAttempts  (new buffer on EVERY iteration,
      //             both successful and failed)
      // Combined with lockAttempts >= 2 above, sabCount === 1 strictly proves
      // the buffer is hoisted (post-fix). Pre-fix code would observe sabCount
      // equal to the iteration count, never 1.
      assert.strictEqual(
        writeResult.sabCount,
        1,
        'post-fix: exactly one SharedArrayBuffer must be allocated per acquireStateLock call ' +
          '(buffer hoisted before retry loop). Got: ' + writeResult.sabCount +
          ' across ' + writeResult.lockAttempts + ' lock attempts.'
      );
    }
  );
});
