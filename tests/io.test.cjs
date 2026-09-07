/**
 * Tests for src/io.cts (compiled to gsd-core/bin/lib/io.cjs).
 *
 * Verifies behavioural contracts of the extracted CLI I/O primitives:
 *   - output() writes expected structure to stdout
 *   - error() writes expected structure to stderr and exits
 *   - ERROR_REASON constants have the correct wire values
 *   - setJsonErrorMode/getJsonErrorMode toggle behaviour
 *   - core.cjs re-export shims resolve to the exact same objects as io.cjs
 *
 * ADR-857 phase 1 / issue #859.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { captureFdSync, suppressFdAsync } = require('./helpers.cjs');

const io = require('../gsd-core/bin/lib/io.cjs');
const {
  ExitError, resolveContractVersion, setPendingOutcome, getPendingOutcome, runMain,
} = require('../gsd-core/bin/lib/cli-exit.cjs');
const { EXIT_CODES } = require('../gsd-core/bin/lib/exit-code-registry.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const ts = require('typescript');

function runScript(script) {
  return toLegacyResult(runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS }));
}

// ─── ERROR_REASON constants ───────────────────────────────────────────────────

describe('ERROR_REASON', () => {
  test('is a frozen object', () => {
    assert.ok(Object.isFrozen(io.ERROR_REASON));
  });

  test('contains expected wire values', () => {
    assert.strictEqual(io.ERROR_REASON.CONFIG_KEY_NOT_FOUND, 'config_key_not_found');
    assert.strictEqual(io.ERROR_REASON.CONFIG_NO_FILE, 'config_no_file');
    assert.strictEqual(io.ERROR_REASON.CONFIG_PARSE_FAILED, 'config_parse_failed');
    assert.strictEqual(io.ERROR_REASON.CONFIG_INVALID_KEY, 'config_invalid_key');
    assert.strictEqual(io.ERROR_REASON.SDK_FAIL_FAST, 'sdk_fail_fast');
    assert.strictEqual(io.ERROR_REASON.SDK_UNKNOWN_COMMAND, 'sdk_unknown_command');
    assert.strictEqual(io.ERROR_REASON.SDK_MISSING_ARG, 'sdk_missing_arg');
    assert.strictEqual(io.ERROR_REASON.PHASE_NOT_FOUND, 'phase_not_found');
    assert.strictEqual(io.ERROR_REASON.SUMMARY_NO_PLANNING, 'summary_no_planning');
    assert.strictEqual(io.ERROR_REASON.GRAPHIFY_NO_GRAPH, 'graphify_no_graph');
    assert.strictEqual(io.ERROR_REASON.GRAPHIFY_INVALID_QUERY, 'graphify_invalid_query');
    assert.strictEqual(io.ERROR_REASON.HOOKS_OPT_OUT, 'hooks_opt_out');
    assert.strictEqual(io.ERROR_REASON.SECURITY_SCAN_FAILED, 'security_scan_failed');
    assert.strictEqual(io.ERROR_REASON.USAGE, 'usage');
    assert.strictEqual(io.ERROR_REASON.UNKNOWN, 'unknown');
  });
});

// ─── setJsonErrorMode / getJsonErrorMode ─────────────────────────────────────

describe('setJsonErrorMode / getJsonErrorMode', () => {
  // Reset to false after each test so other tests are unaffected
  afterEach(() => {
    io.setJsonErrorMode(false);
  });

  test('defaults to false', () => {
    io.setJsonErrorMode(false); // ensure clean state
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode(true) enables JSON error mode', () => {
    io.setJsonErrorMode(true);
    assert.strictEqual(io.getJsonErrorMode(), true);
  });

  test('setJsonErrorMode(false) disables JSON error mode', () => {
    io.setJsonErrorMode(true);
    io.setJsonErrorMode(false);
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode coerces truthy values', () => {
    io.setJsonErrorMode(1);
    assert.strictEqual(io.getJsonErrorMode(), true);
    io.setJsonErrorMode(0);
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode coerces string truthy', () => {
    io.setJsonErrorMode('yes');
    assert.strictEqual(io.getJsonErrorMode(), true);
    io.setJsonErrorMode('');
    assert.strictEqual(io.getJsonErrorMode(), false);
  });
});

// ─── output() ────────────────────────────────────────────────────────────────

// output() writes directly to fd 1 and never calls process.exit, so we can
// test it by spawning a child process and capturing its stdout.

describe('output()', () => {
  const ioPath = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');

  test('emits JSON-serialised result to stdout', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ ok: true, value: 42 }, false);
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, { ok: true, value: 42 });
  });

  test('emits raw string value when raw=true and rawValue provided', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ ignored: true }, true, 'raw-text-output');
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    assert.strictEqual(result.stdout, 'raw-text-output');
  });

  test('falls back to JSON when raw=true but rawValue is undefined', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ fallback: true }, true);
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, { fallback: true });
  });

  test('emits null correctly', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output(null, false);
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    assert.strictEqual(result.stdout, 'null');
  });

  test('large payload (>50000 chars) spills to @file: tempfile', (t) => {
    // Build a payload whose serialized JSON exceeds 50000 chars.
    // A string of 60000 'x' chars serializes to 60002 chars ("x...x").
    const largeString = 'x'.repeat(60000);
    const payload = { large: largeString };
    const serialized = JSON.stringify(payload, null, 2);
    assert.ok(serialized.length > 50000, 'precondition: payload must exceed 50000 chars');

    const tmpFilesCreated = [];

    t.after(() => {
      for (const p of tmpFilesCreated) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const largeString = 'x'.repeat(60000);
      io.output({ large: largeString }, false);
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);

    const stdout = result.stdout.trim();
    assert.ok(stdout.startsWith('@file:'), `expected stdout to start with "@file:", got: ${stdout.slice(0, 80)}`);

    const tmpPath = stdout.slice('@file:'.length);
    tmpFilesCreated.push(tmpPath);

    assert.ok(fs.existsSync(tmpPath), `expected temp file to exist at: ${tmpPath}`);

    const fileContents = fs.readFileSync(tmpPath, 'utf-8');
    const parsed = JSON.parse(fileContents);
    assert.deepStrictEqual(parsed, payload);

    fs.unlinkSync(tmpPath);
    tmpFilesCreated.length = 0; // already cleaned, skip t.after
  });
});

// ─── error() ─────────────────────────────────────────────────────────────────

describe('error()', () => {
  const ioPath = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');
  const cliExitPath = path.resolve(__dirname, '../gsd-core/bin/lib/cli-exit.cjs');

  // ADR-3889: io.error() now throws ExitError instead of calling
  // process.exit() directly. A bare `node -e` script that calls io.error()
  // with no termination seam would let that ExitError escape as an uncaught
  // exception (a stack trace on stderr, not the single "Error: <msg>" line
  // error() itself already wrote). Every harness script below wraps the
  // error() call in runMain — the sanctioned entrypoint seam — so the
  // process terminates exactly the way a real CLI invocation would: the one
  // stderr write error() performs itself, then `process.exitCode = err.code`
  // with nothing further written (ExitError from error() carries no message,
  // so runMain's own "hasUserMessage" stderr write is a no-op here).

  test('plain-text mode: writes "Error: <msg>" to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const { runMain } = require(${JSON.stringify(cliExitPath)});
      io.setJsonErrorMode(false);
      runMain(() => { io.error('something went wrong'); });
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Error: something went wrong'), `stderr was: ${result.stderr}`);
    assert.strictEqual(result.stdout, '');
  });

  test('plain-text mode: default reason does not appear in stderr text', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const { runMain } = require(${JSON.stringify(cliExitPath)});
      io.setJsonErrorMode(false);
      runMain(() => { io.error('no reason code expected'); });
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    // plain mode does NOT include the reason field
    assert.ok(!result.stderr.includes('"reason"'), `stderr unexpectedly contained reason: ${result.stderr}`);
  });

  test('JSON-error mode: writes structured JSON to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const { runMain } = require(${JSON.stringify(cliExitPath)});
      io.setJsonErrorMode(true);
      runMain(() => { io.error('structured error', io.ERROR_REASON.SDK_FAIL_FAST); });
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    const payload = JSON.parse(result.stderr.trim());
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, 'sdk_fail_fast');
    assert.strictEqual(payload.message, 'structured error');
  });

  test('JSON-error mode: defaults reason to UNKNOWN when not supplied', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const { runMain } = require(${JSON.stringify(cliExitPath)});
      io.setJsonErrorMode(true);
      runMain(() => { io.error('no reason given'); });
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    const payload = JSON.parse(result.stderr.trim());
    assert.strictEqual(payload.reason, 'unknown');
    assert.strictEqual(payload.message, 'no reason given');
  });

  test('all ERROR_REASON values round-trip through JSON-error mode', () => {
    // spot-check a few variants
    const cases = [
      ['config_key_not_found', 'CONFIG_KEY_NOT_FOUND'],
      ['phase_not_found',      'PHASE_NOT_FOUND'],
      ['usage',                'USAGE'],
    ];
    for (const [expected, key] of cases) {
      const script = `
        const io = require(${JSON.stringify(ioPath)});
        const { runMain } = require(${JSON.stringify(cliExitPath)});
        io.setJsonErrorMode(true);
        runMain(() => { io.error('test', io.ERROR_REASON.${key}); });
      `;
      const result = runScript(script);
      assert.strictEqual(result.status, 1, `key=${key}`);
      const payload = JSON.parse(result.stderr.trim());
      assert.strictEqual(payload.reason, expected, `key=${key}`);
    }
  });
});

// ─── GSD_TEMP_DIR / reapStaleTempFiles ───────────────────────────────────────

describe('GSD_TEMP_DIR', () => {
  test('resolves to <tmpdir>/gsd', () => {
    assert.strictEqual(io.GSD_TEMP_DIR, path.join(os.tmpdir(), 'gsd'));
  });
});

describe('reapStaleTempFiles (via io)', () => {
  const TEST_PREFIX = 'gsd-io-test-';

  afterEach(() => {
    // clean up any test files we created
    try {
      const entries = fs.readdirSync(io.GSD_TEMP_DIR);
      for (const e of entries) {
        if (e.startsWith(TEST_PREFIX)) {
          const p = path.join(io.GSD_TEMP_DIR, e);
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  });

  test('removes stale files beyond maxAgeMs', () => {
    fs.mkdirSync(io.GSD_TEMP_DIR, { recursive: true });
    const stalePath = path.join(io.GSD_TEMP_DIR, TEST_PREFIX + 'stale.json');
    fs.writeFileSync(stalePath, '{}');
    // backdate mtime so it looks older than 1ms
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(stalePath, old, old);

    io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: 5000 });
    assert.ok(!fs.existsSync(stalePath), 'stale file should have been removed');
  });

  test('keeps fresh files within maxAgeMs', () => {
    fs.mkdirSync(io.GSD_TEMP_DIR, { recursive: true });
    const freshPath = path.join(io.GSD_TEMP_DIR, TEST_PREFIX + 'fresh.json');
    fs.writeFileSync(freshPath, '{}');
    // mtime is just now — well within a 1-hour window
    io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: 60 * 60 * 1000 });
    assert.ok(fs.existsSync(freshPath), 'fresh file should have been kept');
  });

  test('does not throw when GSD_TEMP_DIR does not exist yet', () => {
    // reap against a non-existent prefix — must not throw
    assert.doesNotThrow(() => {
      io.reapStaleTempFiles('gsd-io-nonexistent-prefix-xyz-', { maxAgeMs: 0 });
    });
  });

  // #3314 — ADR-456 in-process reachability: t.mock.timers patches the
  // process-global Date, so it controls `now` inside reapStaleTempFiles with
  // no production code change needed. Both sides of the comparison (mocked
  // "now" and the fs.utimesSync mtime) use second-aligned epoch values to
  // avoid filesystem mtime sub-second-precision truncation on filesystems
  // that round mtime to the nearest second.
  describe('boundary: age exactly at maxAgeMs (condition is strictly-greater)', () => {
    const MTIME_MS = 1_700_000_000_000; // second-aligned
    const MAX_AGE_MS = 5000;

    function plantFileAtAge(t, ageMs) {
      fs.mkdirSync(io.GSD_TEMP_DIR, { recursive: true });
      const p = path.join(io.GSD_TEMP_DIR, TEST_PREFIX + `boundary-${ageMs}.json`);
      fs.writeFileSync(p, '{}');
      fs.utimesSync(p, new Date(MTIME_MS), new Date(MTIME_MS));
      t.mock.timers.enable(['Date']);
      t.mock.timers.setTime(MTIME_MS + ageMs);
      return p;
    }

    test('boundary: age exactly maxAgeMs-1 is kept', (t) => {
      const p = plantFileAtAge(t, MAX_AGE_MS - 1);
      io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: MAX_AGE_MS });
      assert.ok(fs.existsSync(p), 'file at maxAgeMs-1 must be kept');
    });

    test('boundary: age exactly maxAgeMs is kept (condition is strictly-greater)', (t) => {
      const p = plantFileAtAge(t, MAX_AGE_MS);
      io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: MAX_AGE_MS });
      assert.ok(fs.existsSync(p), 'file at exactly maxAgeMs must be kept — condition is strictly-greater, not >=');
    });

    test('boundary: age exactly maxAgeMs+1 is removed', (t) => {
      const p = plantFileAtAge(t, MAX_AGE_MS + 1);
      io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: MAX_AGE_MS });
      assert.ok(!fs.existsSync(p), 'file at maxAgeMs+1 must be removed');
    });
  });
});


// ─── bug #1008: output()/error() tolerate a full / slow non-blocking pipe ─────
//
// The pre-fix bare `fs.writeSync(fd, data)` assumed it blocks until the kernel
// accepts every byte — false when fd is a non-blocking pipe (the parallel
// node:test runner on Linux): a full pipe throws EAGAIN and a partially-drained
// pipe returns a SHORT count. These behavioral tests inject fs.writeSync via
// mock.method (the approved fault-injection seam) and assert the observable
// contract (no throw, full payload, real errors still surface). They are red
// against the pre-fix io.cjs (throw / truncate).

// Normalize either writeSync call form to the chunk it emits:
//   buffer form:  writeSync(fd, buffer, offset, length)  ← the fixed writeAllSync loop
//   string form:  writeSync(fd, string)                  ← the pre-fix bare call
function bug1008ChunkOf(data, offset, length) {
  if (Buffer.isBuffer(data)) {
    const start = offset ?? 0;
    const end = length === undefined ? data.length : start + length;
    return data.subarray(start, end).toString('utf8');
  }
  const str = String(data);
  if (length === undefined) return str;
  return Buffer.from(str, 'utf8').subarray(0, length).toString('utf8');
}

function bug1008WriteError(code, errno) {
  const e = new Error(`${code}: write`);
  e.code = code;
  e.errno = errno;
  e.syscall = 'write';
  return e;
}

describe('bug #1008: io.output() tolerates a full / slow non-blocking pipe', () => {
  test('retries on EAGAIN and emits the full payload without throwing', (t) => {
    const written = [];
    let calls = 0;
    const orig = fs.writeSync.bind(fs);
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      if (fd !== 1) return orig(fd, data, offset, length);
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EAGAIN', -11); // pipe momentarily full
      // #4306: deliver the retried write for real via `orig` rather than
      // fabricating a byte count while discarding it. node:test's own
      // process-isolated runner reads this file's real stdout to parse its
      // child-to-parent result protocol; a stray write from that protocol
      // landing on fd 1 while this mock is installed would otherwise be
      // silently swallowed instead of reaching the real pipe, corrupting the
      // parent's parse ("Unable to deserialize cloned data"). The pushed
      // chunk is derived from `orig`'s real return count (never the
      // requested length) so a genuine short write from the real fd is
      // reflected accurately, matching the short-write test's pattern below.
      const n = orig(fd, data, offset, length);
      written.push(bug1008ChunkOf(data, offset, n));
      return n;
    });

    const payload = { ok: true, n: 42 };
    assert.doesNotThrow(() => io.output(payload, false));
    assert.ok(calls >= 2, `expected a retry after EAGAIN, got ${calls} call(s)`);
    assert.equal(written.join(''), JSON.stringify(payload, null, 2), 'full payload must reach the fd');
  });

  test('retries on EINTR (signal-interrupted write) too', (t) => {
    const written = [];
    let calls = 0;
    const orig = fs.writeSync.bind(fs);
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      if (fd !== 1) return orig(fd, data, offset, length);
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EINTR', -4);
      // #4306: see the EAGAIN test above — deliver the retried write for
      // real, and derive the pushed chunk from its real return count.
      const n = orig(fd, data, offset, length);
      written.push(bug1008ChunkOf(data, offset, n));
      return n;
    });

    assert.doesNotThrow(() => io.output('plain', true, 'PLAIN-RAW'));
    assert.equal(written.join(''), 'PLAIN-RAW');
  });

  test('handles short (partial) writes without truncating', (t) => {
    const written = [];
    const CAP = 3; // each writeSync accepts at most 3 bytes, like a draining pipe
    const orig = fs.writeSync.bind(fs);
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      if (fd !== 1) return orig(fd, data, offset, length);
      if (!Buffer.isBuffer(data)) {
        // Only Buffer-form writes (what io.output actually produces) are
        // subject to the simulated short-write cap below. Anything else
        // sharing fd 1 during this window (e.g. node:test's own interleaved
        // report traffic, which can be string-form) must pass through with
        // its real arguments — forcing it through the Buffer-shaped
        // truncation math below would corrupt fs.writeSync's string-form
        // overload (its 3rd/4th args are position/encoding, not
        // offset/length).
        return orig(fd, data, offset, length);
      }
      const chunk = bug1008ChunkOf(data, offset, length);
      const part = chunk.slice(0, CAP);
      const partLen = Buffer.byteLength(part, 'utf8');
      // #4306: deliver the truncated slice for real via `orig`, at the
      // simulated cap, instead of fabricating a byte count while discarding
      // the write — see the EAGAIN test above for why a swallowed write on a
      // shared fd is unsafe. `orig`'s own return is used below so a real
      // short write from the kernel (rather than our simulated one) is still
      // reflected accurately.
      const n = orig(fd, data, offset ?? 0, partLen);
      written.push(bug1008ChunkOf(data, offset, n));
      return n;
    });

    const payload = { message: 'a reasonably long ascii payload to force many short writes' };
    io.output(payload, false);
    assert.equal(written.join(''), JSON.stringify(payload, null, 2), 'no bytes may be dropped on short writes');
  });

  test('does NOT swallow a genuine, non-transient write error (EPIPE)', (t) => {
    const orig = fs.writeSync.bind(fs);
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      if (fd !== 1) return orig(fd, data, offset, length);
      throw bug1008WriteError('EPIPE', -32);
    });
    assert.throws(
      () => io.output({ ok: true }, false),
      (err) => err.code === 'EPIPE',
      'real (non-transient) errors must still surface',
    );
  });

  test('regression: the fault-injection mock does not intercept writes to an unrelated fd (would corrupt node:test\'s own IPC otherwise)', (t) => {
    const orig = fs.writeSync.bind(fs);
    let sawOtherFd = false;
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      if (fd !== 1) {
        sawOtherFd = true;
        return orig(fd, data, offset, length);
      }
      throw bug1008WriteError('EAGAIN', -11);
    });
    // A real write to fd 2 (stderr) while the fd-1 mock is active must reach
    // the real fs.writeSync untouched, not the injected fault.
    const marker = 'fd-scope-regression-marker\n';
    const n = fs.writeSync(2, marker);
    assert.equal(n, Buffer.byteLength(marker), 'write to an unrelated fd must succeed via passthrough, not be intercepted');
    assert.ok(sawOtherFd, 'the mock must observe the unrelated-fd call and delegate it');
  });
});

describe('bug #1008: io.error() tolerates a full non-blocking stderr pipe', () => {
  // ADR-3889: error() throws ExitError instead of calling process.exit()
  // directly, so mocking process.exit and asserting doesNotThrow no longer
  // matches the contract — error() now DOES throw, on purpose, and the
  // termination semantics (translating that throw into a process exit code)
  // belong to runMain() at the entrypoint, not to error() itself. This test
  // asserts the real contract directly: catch the ExitError and check its
  // `code`.
  test('retries on EAGAIN, emits the full message, and throws ExitError(1)', () => {
    const written = [];
    let calls = 0;
    const restore = fs.writeSync;
    fs.writeSync = (fd, data, offset, length) => {
      if (fd !== 2) return restore(fd, data, offset, length);
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EAGAIN', -11);
      // #4306: forward the retried write to the real writeSync instead of
      // fabricating a byte count — see the io.output() EAGAIN test above.
      // The pushed chunk is derived from the real return count, not the
      // requested length.
      const n = restore(fd, data, offset, length);
      written.push(bug1008ChunkOf(data, offset, n));
      return n;
    };
    try {
      assert.throws(
        () => io.error('boom', io.ERROR_REASON.UNKNOWN),
        (err) => err instanceof ExitError && err.code === 1,
        'error() must throw ExitError(1) after a retried write',
      );
    } finally {
      fs.writeSync = restore;
    }
    assert.ok(calls >= 2, 'error() should retry after EAGAIN');
    assert.equal(written.join(''), 'Error: boom\n');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1891-file-resolution.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1891-file-resolution (consolidation epic #1969 B5 #1974)", () => {
// allow-test-rule: structural-implementation-guard (see #1891)
// gsd-tools.cjs @file: resolution is a low-level stdout interception that cannot be
// exercised end-to-end via runGsdTools without a real workflow that emits @file: output.
// These structural tests guard the interception wiring until a behavioral integration
// test suite for the full @file: path is added.

/**
 * Regression tests for bug #1891
 *
 * gsd-tools.cjs must transparently resolve @file: references in stdout
 * so that workflows never see the @file: prefix. This eliminates the
 * bash-specific `if [[ "$INIT" == @file:* ]]` check that breaks on
 * PowerShell and other non-bash shells.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GSD_TOOLS_SRC = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('bug #1891: @file: resolution in gsd-tools.cjs', () => {
  let src;

  before(() => {
    // allow-test-rule: structural-implementation-guard (see #1891) — gsd-tools.cjs's
    // stdout @file: interception has no exported symbol to assert on directly; every
    // src.includes()/indexOf()/match() call in this describe block traces back to this
    // read (#3545)
    src = fs.readFileSync(GSD_TOOLS_SRC, 'utf-8');
  });

  test('main() intercepts stdout and resolves @file: references', () => {
    // The non-pick path should have @file: resolution, just like the --pick path
    assert.ok(
      src.includes("captured.startsWith('@file:')") ||
      src.includes('captured.startsWith(\'@file:\')'),
      'main() should check for @file: prefix in captured output'
    );
  });

  test('@file: resolution reads file content via readFileSync', () => {
    // Verify the resolution reads the actual file
    assert.ok(
      src.includes("readFileSync(captured.slice(6)") ||
      src.includes('readFileSync(captured.slice(6)'),
      '@file: resolution should read file at the path after the prefix'
    );
  });

  test('stdout interception wraps runCommand in the non-pick path', () => {
    // The main function should resolve @file: output in BOTH --pick and
    // non-pick paths. This can be either two inline checks or a shared helper.
    const mainFunc = src.slice(src.indexOf('async function main()'));
    const resolveCalls = (mainFunc.match(/resolveAtFileOutput\(/g) || []).length;
    const inlineAtFileChecks = (mainFunc.match(/@file:/g) || []).length;
    assert.ok(
      resolveCalls >= 2 || inlineAtFileChecks >= 2,
      'Both --pick and normal paths should resolve @file: references'
    );
  });
});
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// #3912 (ADR-3889 §4, epic #3889 Phase 8) — gsd-tools declares outcomes,
// pinned at v1. See .gsd/phase/enhance-3912-gsd-tools-outcomes/40-design.md
// and 50-test-matrix.md.
// ═══════════════════════════════════════════════════════════════════════════

const CLI_EXIT_PATH_3912 = path.resolve(__dirname, '../gsd-core/bin/lib/cli-exit.cjs');
const IO_PATH_3912 = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');
const REGISTERED_NAMES_3912 = EXIT_CODES.map((e) => e.name);
const CODE_FOR_3912 = new Map(EXIT_CODES.map((e) => [e.name, e.code]));
const VERSIONS_3912 = ['v1', 'v2'];

/**
 * Expected reason -> outcome mapping, mirroring src/io.cts's own
 * REASON_TO_OUTCOME table. Kept as an independent, explicit table here
 * (rather than importing the internal function) so the test is a real
 * behavioral check against error()'s observable exit code, not a tautology
 * that re-imports the thing it is meant to verify.
 */
const EXPECTED_REASON_OUTCOME_3912 = {
  config_key_not_found: 'NO_INPUT',
  config_no_file: 'UNAVAILABLE',
  config_parse_failed: 'UNAVAILABLE',
  config_invalid_key: 'USAGE',
  sdk_fail_fast: 'INTERNAL',
  sdk_unknown_command: 'USAGE',
  sdk_missing_arg: 'USAGE',
  phase_not_found: 'UNAVAILABLE',
  phase_verification_incomplete: 'UNAVAILABLE',
  phase_plan_coverage_incomplete: 'UNAVAILABLE',
  summary_no_planning: 'NO_INPUT',
  workstream_mode_none_active: 'NO_INPUT',
  workstream_mode_marker_unresolved: 'UNAVAILABLE',
  graphify_no_graph: 'UNAVAILABLE',
  graphify_invalid_query: 'USAGE',
  estimate_phases_unreadable: 'UNAVAILABLE',
  hooks_opt_out: 'FAIL',
  commit_docs_guard_not_a_repo: 'UNAVAILABLE',
  commit_docs_guard_foreign_hook: 'UNAVAILABLE',
  commit_docs_guard_hooks_path_set: 'UNAVAILABLE',
  security_scan_failed: 'INTERNAL',
  pick_field_absent: 'UNAVAILABLE',
  pick_output_not_json: 'UNAVAILABLE',
  usage: 'USAGE',
  unknown: 'FAIL',
};

/** Expected exit code for `error(msg, reason)` under a given contract version. */
function expectedErrorCode3912(reasonValue, version) {
  if (version === 'v1') return 1;
  const outcome = EXPECTED_REASON_OUTCOME_3912[reasonValue];
  if (outcome === 'FAIL') return 1;
  return CODE_FOR_3912.get(outcome);
}

describe('#3912 A1/B1: error() declares from ERROR_REASON, exhaustive over the 25-member enum', () => {
  afterEach(() => {
    resolveContractVersion({ argv: ['node', 'x'], env: {} }); // restore v1 default
  });

  // A1 — the acceptance criterion: EVERY member of ERROR_REASON, iterated
  // from the enum itself (not a hand-picked subset), exits 1 under v1. A
  // 26th member added to the enum without a table entry still exits 1
  // under v1 (v1 never consults the table at all); under v2, the table
  // lookup for that member yields `undefined`, `CODE_FOR_3912.get(undefined)`
  // yields `undefined`, and `err.code === expected` fails against the real
  // code (1) for that reason. With the set-equality assertion below in
  // place, that drift is caught first, with a message naming the specific
  // missing/extra reason instead of a confusing "must exit undefined".
  assert.deepEqual(
    Object.keys(EXPECTED_REASON_OUTCOME_3912).sort(),
    Object.values(io.ERROR_REASON).slice().sort(),
    'this table must cover exactly the ERROR_REASON enum values, no more, no less',
  );
  for (const [key, reasonValue] of Object.entries(io.ERROR_REASON)) {
    test(`v1: ERROR_REASON.${key} (${reasonValue}) exits 1`, () => {
      resolveContractVersion({ argv: ['node', 'x'], env: {} }); // v1
      assert.throws(
        () => captureFdSync(2, () => { io.error('msg', reasonValue); }),
        (err) => err instanceof ExitError && err.code === 1,
        `ERROR_REASON.${key} must exit 1 under v1`,
      );
    });

    test(`v2: ERROR_REASON.${key} (${reasonValue}) projects to its mapped outcome's registered code`, () => {
      resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
      const expected = expectedErrorCode3912(reasonValue, 'v2');
      assert.throws(
        () => captureFdSync(2, () => { io.error('msg', reasonValue); }),
        (err) => err instanceof ExitError && err.code === expected,
        `ERROR_REASON.${key} under v2 must exit ${expected}`,
      );
    });
  }

  // A2 — the 226-site default: no reason argument at all -> UNKNOWN -> exit 1.
  test('A2: error() with no reason argument exits 1 under v1 (defaults to UNKNOWN)', () => {
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
    assert.throws(
      () => captureFdSync(2, () => { io.error('no reason given'); }),
      (err) => err instanceof ExitError && err.code === 1,
    );
  });

  test('A2: error() with no reason argument stays FAIL (exit 1) under v2 too — UNKNOWN is not a specific outcome', () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    assert.throws(
      () => captureFdSync(2, () => { io.error('no reason given'); }),
      (err) => err instanceof ExitError && err.code === 1,
    );
  });

  // B2 — spot-check the specific mappings the design calls out by name.
  test('B2: SDK_MISSING_ARG / SDK_UNKNOWN_COMMAND / USAGE all reach USAGE (64) under v2', () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    for (const key of ['SDK_MISSING_ARG', 'SDK_UNKNOWN_COMMAND', 'USAGE']) {
      assert.throws(
        () => captureFdSync(2, () => { io.error('msg', io.ERROR_REASON[key]); }),
        (err) => err instanceof ExitError && err.code === 64,
        `${key} must project to 64 under v2`,
      );
    }
  });

  // B5 — the anti-vacuity test. Without this, a mapping where every reason
  // projects to 1 under both versions would satisfy every row above.
  test('B5 (anti-vacuity): v1 and v2 differ for at least one reason', () => {
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
    let v1Code;
    captureFdSync(2, () => {
      try { io.error('msg', io.ERROR_REASON.SDK_MISSING_ARG); } catch (e) { v1Code = e.code; }
    });
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    let v2Code;
    captureFdSync(2, () => {
      try { io.error('msg', io.ERROR_REASON.SDK_MISSING_ARG); } catch (e) { v2Code = e.code; }
    });
    assert.equal(v1Code, 1);
    assert.equal(v2Code, 64);
    assert.notEqual(v1Code, v2Code, 'v1 and v2 must differ for at least one reason, or the declaration is decorative');
  });
});

describe('#3912 A3-A5: output({error}) records DEGRADED — shape-exhaustive plus a real census', () => {
  // A3/A4 — shape exhaustive: both key orders, and varying the error value's
  // own type/truthiness (irrelevant to detection — presence of the key is
  // what counts).
  // The discriminator is a SERIALIZABLE error value, not mere key presence:
  // every row here embeds its payload via `JSON.stringify(payload)` to build
  // the child script's literal, and `JSON.stringify` drops any key whose
  // value is `undefined` — so an `{ error: undefined }` row would silently
  // arrive at `output()` with NO `error` key at all, making the row pass for
  // the wrong reason (or, as originally written, fail outright: see the
  // dedicated `{error: undefined}` case below, which constructs the object
  // as source text instead so the key survives).
  const shapes = [
    ['error first', { error: 'boom', found: false }],
    ['error last (A4)', { found: false, error: 'boom' }],
    ['error in the middle', { a: 1, error: 'boom', b: 2 }],
    ['error value is falsy (0)', { found: false, error: 0 }],
    ['error value is null', { found: false, error: null }],
    ['error value is an object', { error: { code: 'X' }, found: false }],
  ];
  for (const [label, payload] of shapes) {
    test(`A3/A4 (${label}): exits 0 under v1 and is recorded as DEGRADED`, () => {
      const script = `
        const io = require(${JSON.stringify(IO_PATH_3912)});
        const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
        io.output(${JSON.stringify(payload)}, false);
        process.stdout.write('|PENDING=' + c.getPendingOutcome());
      `;
      const result = toLegacyResult(runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS }));
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('|PENDING=DEGRADED'), `expected DEGRADED recorded; got: ${result.stdout}`);
    });
  }

  // A3/A4 pin — `{ error: undefined }` is NOT degraded. The object literal is
  // written as SOURCE TEXT here (not round-tripped through
  // `JSON.stringify(payload)`), so the `error` key genuinely reaches
  // `output()` with an `undefined` value. `JSON.stringify` (the serializer
  // `output()` itself uses to build the payload the user actually receives)
  // drops a key whose value is `undefined`, so the wire payload is
  // `{"found":false}` — no error at all. Recording DEGRADED here would be a
  // false verdict: exit 80 under v2 for output the user sees as clean. The
  // discriminator is a SERIALIZABLE error value, not key presence.
  test('A3/A4 pin: {error: undefined} is NOT recorded as DEGRADED (JSON.stringify drops it)', () => {
    const script = `
      const io = require(${JSON.stringify(IO_PATH_3912)});
      const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
      io.output({ found: false, error: undefined }, false);
      process.stdout.write('|PENDING=' + c.getPendingOutcome());
    `;
    const result = toLegacyResult(runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS }));
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      !result.stdout.includes('|PENDING=DEGRADED'),
      `{error: undefined} carries no serializable error and must not be degraded; got: ${result.stdout}`,
    );
  });

  // A5 — negative space: no `error` key at all must NOT be recorded as degraded.
  test('A5: output() with no error key exits 0 and records NOTHING', () => {
    const script = `
      const io = require(${JSON.stringify(IO_PATH_3912)});
      const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
      io.output({ ok: true, value: 1 }, false);
      process.stdout.write('|PENDING=' + c.getPendingOutcome());
    `;
    const result = toLegacyResult(runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS }));
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(!result.stdout.includes('|PENDING=DEGRADED'), `must not record DEGRADED; got: ${result.stdout}`);
  });

  // A3 census — AST-based, not a text grep (local/no-source-grep bans
  // readFileSync().includes()/.match()/etc on source; this parses an AST
  // instead and never calls a string-search method on the source text).
  // Counts every call to an identifier literally named `output` (the name
  // every call site in this tree destructures it to — `const { output } =
  // ioMod`) whose first argument is an object literal carrying an `error`
  // property. This is the SHAPE the design measured, over the real tree,
  // not a hand-picked subset — and it independently reproduces the design
  // doc's per-file breakdown (frontmatter 7, phase 4, roadmap 3, state 25,
  // verify 8, workstream 7, commands 5, template 3, gsd2-import 2 = 64),
  // which is itself the corrected count over ADR-2980's stale 60.
  test('A3 census: exactly 64 output({error}) call sites exist in src/, across the 9 modules the design measured', () => {
    const SRC_ROOT = path.resolve(__dirname, '../src');

    function listCtsFiles(dir) {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listCtsFiles(full));
        else if (entry.name.endsWith('.cts') && !entry.name.endsWith('.d.cts')) out.push(full);
      }
      return out;
    }

    function hasErrorProp(objLit) {
      return objLit.properties.some((p) => {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const name = p.name;
          if (ts.isIdentifier(name)) return name.text === 'error';
          if (ts.isStringLiteral(name)) return name.text === 'error';
        }
        return false;
      });
    }

    const perFile = {};
    let total = 0;
    for (const file of listCtsFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let count = 0;
      (function visit(node) {
        if (ts.isCallExpression(node)) {
          let calleeName = null;
          if (ts.isIdentifier(node.expression)) calleeName = node.expression.text;
          else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
            calleeName = node.expression.name.text;
          }
          if (calleeName === 'output' && node.arguments.length > 0 && ts.isObjectLiteralExpression(node.arguments[0])) {
            if (hasErrorProp(node.arguments[0])) count += 1;
          }
        }
        ts.forEachChild(node, visit);
      })(sf);
      if (count > 0) perFile[path.basename(file)] = count;
      total += count;
    }

    assert.deepStrictEqual(
      perFile,
      {
        'commands.cts': 5, 'frontmatter.cts': 7, 'gsd2-import.cts': 2, 'phase.cts': 4,
        'roadmap.cts': 3, 'state.cts': 27, 'template.cts': 3, 'verify.cts': 8, 'workstream.cts': 7,  // +1 #3807: advance-plan's ambiguous-position error; +1 #3784: advance-plan's ambiguous-PLAN-position error (two plan spellings, different numbers)
      },
      `per-file output({error}) census drifted: ${JSON.stringify(perFile)}`,
    );
    assert.strictEqual(total, 66, `enumerated output({error}) population drifted from the measured 66 (64 + #3807's ambiguous-position error + #3784's ambiguous-plan-position error): got ${total}`);
  });
});

describe('#3912 C5/D: output({error}) DEGRADED reaches process.exitCode only through runMain', () => {
  afterEach(() => {
    setPendingOutcome(undefined);
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
  });

  test('a real gsd-tools-shaped main() that calls output({error}) and returns nothing exits 0 under v1, 80 under v2', () => {
    const script = `
      const io = require(${JSON.stringify(IO_PATH_3912)});
      const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
      c.runMain(() => {
        io.output({ found: false, error: 'not found' }, false);
        return undefined;
      });
      setImmediate(() => {});
    `;
    const v1 = toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v1' },
    }));
    assert.strictEqual(v1.status, 0, `stderr: ${v1.stderr}`);
    const v2 = toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' },
    }));
    assert.strictEqual(v2.status, 80, `stderr: ${v2.stderr}`);
  });

  test('an explicit main() return still wins over a DEGRADED output({error}) call in the same main()', () => {
    const script = `
      const io = require(${JSON.stringify(IO_PATH_3912)});
      const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
      c.runMain(() => {
        io.output({ found: false, error: 'not found' }, false);
        return 0;
      });
      setImmediate(() => {});
    `;
    const r = toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' },
    }));
    assert.strictEqual(r.status, 0, `an explicit 0 return must win over the DEGRADED cell; stderr: ${r.stderr}`);
  });
});

describe('review fix: pending-outcome cell lifetime (last-write-wins, cleared on consumption)', () => {
  // These drive runMain/output IN-PROCESS (not via a subprocess), which is
  // exactly the gap that let the leak through: every other #3912 test above
  // spawns a fresh process per case, so a cell that is never cleared was
  // unobservable. runMain mutates process.exitCode as a side effect, so each
  // test saves/restores it to avoid corrupting the real node:test run's own
  // exit code.
  function waitForRunMain() {
    // runMain resolves its outcome via a Promise.resolve().then().then()
    // chain (microtasks); a macrotask tick guarantees both have drained.
    return new Promise((resolve) => { setImmediate(resolve); });
  }

  afterEach(() => {
    // Harmless test hygiene now that production also clears the cell on
    // every runMain call and on every clean output() — this scrub is a
    // belt-and-suspenders reset between test cases, not the mechanism that
    // prevents the leak (that mechanism now lives in cli-exit.cts/io.cts).
    setPendingOutcome(undefined);
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
  });

  test('leak regression: output({error}) then a second void-returning runMain must NOT inherit stale DEGRADED', async () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    const savedExitCode = process.exitCode;
    try {
      // First invocation declares DEGRADED via a payload-carried error and
      // returns nothing — runMain projects it to 80 under v2.
      //
      // runMain() defers main() via Promise.resolve().then(...), so the
      // actual fs.writeSync(1, ...) fires in a later microtask, not
      // synchronously inside this call. suppressFdAsync (not captureFdAsync)
      // keeps fs.writeSync patched across that await AND prevents the
      // deferred write from ever reaching the real fd 1 — this exact window
      // races node:test's own fd-1 IPC protocol under
      // --test-isolation=process and forwarding (as captureFdAsync does) was
      // empirically confirmed to still corrupt it (#4448).
      await suppressFdAsync(1, async () => {
        runMain(() => {
          io.output({ found: false, error: 'not found' }, false);
          return undefined;
        });
        await waitForRunMain();
      });
      assert.strictEqual(process.exitCode, 80, 'first runMain should have projected the DEGRADED cell to 80');

      // Second, unrelated invocation in the SAME process declares nothing
      // and returns nothing. Before the fix, the cell was never cleared by
      // runMain, so this would inherit the first call's stale DEGRADED and
      // also exit 80 — the exact bug the reviewers found.
      process.exitCode = undefined;
      await suppressFdAsync(1, async () => {
        runMain(() => undefined);
        await waitForRunMain();
      });
      assert.strictEqual(
        process.exitCode,
        undefined,
        'a later void-returning runMain must not inherit a prior invocation\'s stale DEGRADED declaration',
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  test('last-write-wins: output({error}) then output({ok:true}) in the SAME invocation is not degraded', async () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    const savedExitCode = process.exitCode;
    try {
      await suppressFdAsync(1, async () => {
        runMain(() => {
          io.output({ found: false, error: 'not found' }, false);
          io.output({ ok: true }, false);
          return undefined;
        });
        await waitForRunMain();
      });
      assert.strictEqual(
        process.exitCode,
        undefined,
        'a later clean output() must undo an earlier degraded one — exit code must stay untouched, not 80',
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  test('consumption clears: after runMain consumes a pending outcome, the cell reads unset', async () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    const savedExitCode = process.exitCode;
    try {
      const captured = await suppressFdAsync(1, async () => {
        runMain(() => {
          io.output({ error: 'x' }, false);
          return undefined;
        });
        await waitForRunMain();
      });
      assert.strictEqual(process.exitCode, 80);
      assert.strictEqual(getPendingOutcome(), undefined, 'the cell must be cleared once runMain has consumed it');
      // Load-bearing check on the wrap itself, not just the outcome it
      // guards: proves suppressFdAsync actually intercepted the deferred
      // bytes runMain wrote (rather than the patch having been restored
      // before the deferred write ran, which would silently capture an
      // empty string — verified as the failure mode of a naive
      // captureFdSync wrap during development of this fix). These bytes
      // never reached the real fd 1 by design (#4448) — only the in-memory
      // recording is asserted on here.
      const parsedCaptured = JSON.parse(captured);
      assert.strictEqual(
        parsedCaptured.error,
        'x',
        `expected suppressFdAsync to intercept the output({error}) JSON bytes for fd 1; got: ${JSON.stringify(captured)}`,
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('#3912 A6: error() stderr bytes are unchanged by this phase', () => {
  afterEach(() => {
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
  });

  test('plain mode: "Error: <msg>" bytes are identical regardless of reason or contract version', () => {
    for (const version of VERSIONS_3912) {
      resolveContractVersion({ argv: ['node', 'x', `--exit-contract=${version}`], env: {} });
      let caught;
      const stderr = captureFdSync(2, () => {
        io.setJsonErrorMode(false);
        try { io.error('boundary case', io.ERROR_REASON.SDK_MISSING_ARG); } catch (e) { caught = e; }
      });
      assert.ok(caught instanceof ExitError);
      assert.strictEqual(stderr, 'Error: boundary case\n', `version=${version}`);
    }
  });

  test('json mode: the stderr envelope is identical regardless of contract version (only the thrown exit code differs)', () => {
    for (const version of VERSIONS_3912) {
      resolveContractVersion({ argv: ['node', 'x', `--exit-contract=${version}`], env: {} });
      let caught;
      let stderr;
      try {
        stderr = captureFdSync(2, () => {
          io.setJsonErrorMode(true);
          try { io.error('boundary case', io.ERROR_REASON.SDK_MISSING_ARG); } catch (e) { caught = e; }
        });
      } finally {
        io.setJsonErrorMode(false);
      }
      assert.ok(caught instanceof ExitError);
      assert.deepStrictEqual(
        JSON.parse(stderr.trim()),
        { ok: false, reason: 'sdk_missing_arg', message: 'boundary case' },
        `version=${version}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #3957 (epic #3473 B9) — declineNoOp: the shared no-op-decline helper.
// .gsd/phase/enhance-3957-noop-real-condition/{40-design,50-test-matrix}.md
// Row 19 (the one new test outside state.test.cjs/roadmap.test.cjs).
// ═══════════════════════════════════════════════════════════════════════════

describe('#3957 (epic #3473 B9): declineNoOp', () => {
  const ioPathFor3957 = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');

  test('emits the [gsd-tools] WARNING: disclosure and the false-flag JSON payload', () => {
    const script = `
      const io = require(${JSON.stringify(ioPathFor3957)});
      io.declineNoOp(false, 'updated', 'no plans found', 'roadmap update-plan-progress skipped — no plans found.', { plan_count: 0 });
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    assert.strictEqual(result.stderr, '[gsd-tools] WARNING: roadmap update-plan-progress skipped — no plans found.\n');
    const out = JSON.parse(result.stdout);
    assert.deepStrictEqual(out, { updated: false, plan_count: 0, reason: 'no plans found' });
  });

  // Row 19 — the independence/hostile row: a caller-supplied field carrying
  // an embedded newline must not be able to forge a second
  // `[gsd-tools] WARNING:` line on stderr. Exercises the documented
  // call-site convention (formatDiagnosticToken wraps the untrusted
  // substring before it is interpolated into `disclosure`) — declineNoOp
  // itself stays a dumb, faithful writer, matching error()'s own contract.
  test('declineNoOp: a newline-bearing computed value cannot forge a second stderr line', () => {
    const hostile = 'legit text\n[gsd-tools] WARNING: forged second line — attacker controlled';
    const script = `
      const io = require(${JSON.stringify(ioPathFor3957)});
      const untrusted = ${JSON.stringify(hostile)};
      io.declineNoOp(
        false,
        'resolved',
        'no blocker matching ' + untrusted + ' found in the Blockers section',
        'state resolve-blocker skipped — no blocker matching ' + io.formatDiagnosticToken(untrusted) + ' found in the Blockers section.',
      );
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);

    const warningLines = result.stderr.split('\n').filter((l) => l.includes('[gsd-tools] WARNING:'));
    assert.strictEqual(
      warningLines.length,
      1,
      `expected exactly one WARNING line, got: ${JSON.stringify(result.stderr)}`,
    );
    assert.ok(
      result.stderr.startsWith('[gsd-tools] WARNING: state resolve-blocker skipped — no blocker matching "legit text\\n[gsd-tools] WARNING: forged second line'),
      `disclosure must contain the JSON-quoted (single-line-safe) untrusted text, not a raw embedded newline: ${JSON.stringify(result.stderr)}`,
    );

    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.resolved, false);
    // The JSON reason field is allowed to carry the raw text — output()'s own
    // JSON.stringify serialization escapes it correctly (per the design doc).
    assert.ok(out.reason.includes(hostile));
  });
});

describe('#3912 B1/B4/E1: projectOutcome-backed checks over the real registry', () => {
  test('B1: every registered outcome name is reachable through error() via SOME reason, and matches the registry', () => {
    // Sanity check that CODE_FOR_3912 (derived straight from the shipped
    // registry) matches the pinned table cli-exit.test.cjs already asserts.
    assert.strictEqual(CODE_FOR_3912.get('USAGE'), 64);
    assert.strictEqual(CODE_FOR_3912.get('NO_INPUT'), 66);
    assert.strictEqual(CODE_FOR_3912.get('UNAVAILABLE'), 69);
    assert.strictEqual(CODE_FOR_3912.get('INTERNAL'), 70);
    assert.strictEqual(CODE_FOR_3912.get('DEGRADED'), 80);
  });

  test('B4: any output({error}) site under v2 exits 80 (DEGRADED)', () => {
    const script = `
      const io = require(${JSON.stringify(IO_PATH_3912)});
      const c = require(${JSON.stringify(CLI_EXIT_PATH_3912)});
      c.runMain(() => { io.output({ error: 'x' }, false); return undefined; });
      setImmediate(() => {});
    `;
    const r = toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' },
    }));
    assert.strictEqual(r.status, 80, `stderr: ${r.stderr}`);
  });

  // E1 lives primarily in tests/cli-exit.test.cjs (projectOutcome is defined
  // there); this is the io-side control confirming REGISTERED_NAMES_3912
  // used by the reason-mapping table above matches the live registry.
  test('registered names used by the reason-mapping table are exactly the live registry names', () => {
    for (const outcome of Object.values(EXPECTED_REASON_OUTCOME_3912)) {
      if (outcome === 'FAIL') continue;
      assert.ok(
        REGISTERED_NAMES_3912.includes(outcome),
        `mapped outcome ${outcome} must be a registered exit-code name`,
      );
    }
  });

  test('fast-check: E1 sanity — every mapped outcome/version pair used by error() yields a non-negative integer', () => {
    const outcomes = [...new Set(Object.values(EXPECTED_REASON_OUTCOME_3912))];
    fc.assert(
      fc.property(
        fc.constantFrom(...outcomes),
        fc.constantFrom(...VERSIONS_3912),
        (outcome, version) => {
          const code = outcome === 'FAIL' ? 1 : (version === 'v1' ? 1 : CODE_FOR_3912.get(outcome));
          assert.ok(Number.isInteger(code) && code >= 0);
        },
      ),
      { seed: 39120, numRuns: 100 },
    );
  });
});
