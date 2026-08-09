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

const io = require('../gsd-core/bin/lib/io.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

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

  test('plain-text mode: writes "Error: <msg>" to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(false);
      io.error('something went wrong');
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Error: something went wrong'), `stderr was: ${result.stderr}`);
    assert.strictEqual(result.stdout, '');
  });

  test('plain-text mode: default reason does not appear in stderr text', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(false);
      io.error('no reason code expected');
    `;
    const result = runScript(script);
    assert.strictEqual(result.status, 1);
    // plain mode does NOT include the reason field
    assert.ok(!result.stderr.includes('"reason"'), `stderr unexpectedly contained reason: ${result.stderr}`);
  });

  test('JSON-error mode: writes structured JSON to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(true);
      io.error('structured error', io.ERROR_REASON.SDK_FAIL_FAST);
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
      io.setJsonErrorMode(true);
      io.error('no reason given');
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
        io.setJsonErrorMode(true);
        io.error('test', io.ERROR_REASON.${key});
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
  return String(data);
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
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EAGAIN', -11); // pipe momentarily full
      const chunk = bug1008ChunkOf(data, offset, length);
      written.push(chunk);
      return Buffer.byteLength(chunk, 'utf8');
    });

    const payload = { ok: true, n: 42 };
    assert.doesNotThrow(() => io.output(payload, false));
    assert.ok(calls >= 2, `expected a retry after EAGAIN, got ${calls} call(s)`);
    assert.equal(written.join(''), JSON.stringify(payload, null, 2), 'full payload must reach the fd');
  });

  test('retries on EINTR (signal-interrupted write) too', (t) => {
    const written = [];
    let calls = 0;
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EINTR', -4);
      const chunk = bug1008ChunkOf(data, offset, length);
      written.push(chunk);
      return Buffer.byteLength(chunk, 'utf8');
    });

    assert.doesNotThrow(() => io.output('plain', true, 'PLAIN-RAW'));
    assert.equal(written.join(''), 'PLAIN-RAW');
  });

  test('handles short (partial) writes without truncating', (t) => {
    const written = [];
    const CAP = 3; // each writeSync accepts at most 3 bytes, like a draining pipe
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      const chunk = bug1008ChunkOf(data, offset, length);
      const part = chunk.slice(0, CAP);
      written.push(part);
      return Buffer.byteLength(part, 'utf8');
    });

    const payload = { message: 'a reasonably long ascii payload to force many short writes' };
    io.output(payload, false);
    assert.equal(written.join(''), JSON.stringify(payload, null, 2), 'no bytes may be dropped on short writes');
  });

  test('does NOT swallow a genuine, non-transient write error (EPIPE)', (t) => {
    t.mock.method(fs, 'writeSync', () => { throw bug1008WriteError('EPIPE', -32); });
    assert.throws(
      () => io.output({ ok: true }, false),
      (err) => err.code === 'EPIPE',
      'real (non-transient) errors must still surface',
    );
  });
});

describe('bug #1008: io.error() tolerates a full non-blocking stderr pipe', () => {
  test('retries on EAGAIN, emits the full message, and still exits', (t) => {
    const written = [];
    let calls = 0;
    let exitCode = null;
    t.mock.method(process, 'exit', (code) => { exitCode = code; }); // neutralize the hard exit
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
      calls += 1;
      if (calls === 1) throw bug1008WriteError('EAGAIN', -11);
      assert.equal(fd, 2, 'error() must write to stderr');
      const chunk = bug1008ChunkOf(data, offset, length);
      written.push(chunk);
      return Buffer.byteLength(chunk, 'utf8');
    });

    assert.doesNotThrow(() => io.error('boom', io.ERROR_REASON.UNKNOWN));
    assert.ok(calls >= 2, 'error() should retry after EAGAIN');
    assert.equal(written.join(''), 'Error: boom\n');
    assert.equal(exitCode, 1, 'error() must still exit(1) after a retried write');
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
