'use strict';

/**
 * Tests for tests/helpers/process-seam.cjs (the spawnSync-based subprocess
 * seam) and its runGsdTools adapter in tests/helpers.cjs.
 *
 * Contract: .gsd/phase/test-3055-process-seam-module/40-design.md
 * Matrix:   .gsd/phase/test-3055-process-seam-module/50-test-matrix.md
 *
 * Rows 1-24 exercise the seam directly. Rows 25-35 exercise the
 * `runGsdTools` adapter's contract-parity guarantee for its 136 callers.
 *
 * Assertions are on typed fields only (outcome/exitCode/timedOut/signal/
 * killed/code) or on structured JSON a fixture prints to stdout — never on
 * raw stdout/stderr text via .includes()/assert.match(), per CONTRIBUTING
 * "Prohibited: Raw Text Matching on Test Outputs".
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup, runGsdTools, TOOLS_PATH } = require('./helpers.cjs');
const processSeam = require('./helpers/process-seam.cjs');
const { runNode, runGit, runHook, OUTCOME } = processSeam;

// ---- fixture sources -------------------------------------------------

// argv: [exitCode?, stdoutPayload?, stderrPayload?]
const FIXTURE_EXIT = [
  "const code = Number(process.argv[2] || '0');",
  'const stdoutPayload = process.argv[3];',
  'const stderrPayload = process.argv[4];',
  "if (stdoutPayload) console.log(stdoutPayload);",
  "if (stderrPayload) console.error(stderrPayload);",
  'process.exitCode = code;',
].join('\n');

// argv: [sleepMs, stdoutMarker?, stderrMarker?] — writes markers via a
// synchronous fd write (never buffered console.log) so partial output
// survives a kill even when the child never reaches a clean exit.
const FIXTURE_SLEEPER = [
  "const fs = require('fs');",
  "const sleepMs = Number(process.argv[2] || '0');",
  'const stdoutMarker = process.argv[3];',
  'const stderrMarker = process.argv[4];',
  "if (stdoutMarker) fs.writeSync(1, stdoutMarker + '\\n');",
  "if (stderrMarker) fs.writeSync(2, stderrMarker + '\\n');",
  'setTimeout(() => {}, sleepMs);',
].join('\n');

// Echoes received argv back as JSON — proves argv arrives literal/unmodified.
const FIXTURE_ECHO_ARGV = [
  'console.log(JSON.stringify({ argv: process.argv.slice(2) }));',
].join('\n');

// Echoes stdin back as JSON.
const FIXTURE_ECHO_STDIN = [
  "let data = '';",
  "process.stdin.on('data', (chunk) => { data += chunk; });",
  "process.stdin.on('end', () => {",
  '  console.log(JSON.stringify({ received: data, hadData: data.length > 0 }));',
  '});',
].join('\n');

// Kills its own process with SIGKILL — simulates an external kill (OOM
// killer, `process.kill(pid, 'SIGKILL')` from outside) that spawnSync does
// NOT populate `result.error` for on this runtime.
const FIXTURE_SUICIDE = [
  "process.kill(process.pid, 'SIGKILL');",
  'setTimeout(() => {}, 5000);',
].join('\n');

// argv: [exitCode?] — writes well past the 1MB default maxBuffer, then
// attempts a clean exit with exitCode (which the overflow kill preempts).
const FIXTURE_OVERFLOW = [
  "const exitCode = Number(process.argv[2] || '0');",
  'process.exitCode = exitCode;',
  'for (let i = 0; i < 300; i += 1) {',
  "  process.stdout.write('x'.repeat(10000));",
  '}',
].join('\n');

const BUFFER_OVERFLOW_CODES = ['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'];

function writeFixture(dir, name, source) {
  const fixturePath = path.join(dir, name);
  fs.writeFileSync(fixturePath, source);
  return fixturePath;
}

/**
 * Monkeypatch processSeam.runNode for the duration of `block`, restoring the
 * original in `finally`. Standalone helper (no test-context access), per
 * CONTRIBUTING's try/finally carve-out and the CLAUDE.md IO-fault-injection
 * pattern (save original, override, restore in finally).
 */
function withMockedRunNode(impl, block) {
  const original = processSeam.runNode;
  let callCount = 0;
  processSeam.runNode = (...args) => {
    callCount += 1;
    return impl(callCount, ...args);
  };
  try {
    block(() => callCount);
  } finally {
    processSeam.runNode = original;
  }
}

describe('process-seam', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('process-seam-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('exit 0 reports EXITED with the child stdout', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    const result = runNode([fixture, '0', JSON.stringify({ ok: true })]);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
    assert.equal(result.killed, false);
    assert.equal(result.code, null);
    assert.equal(typeof result.stdout, 'string');
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { ok: true });
  });

  test('non-zero exit is EXITED, not a failure-to-run', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    const result = runNode([fixture, '5', '', 'boom']);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 5);
    assert.equal(result.timedOut, false);
    assert.ok(result.stderr.length > 0);
  });

  test('empty stderr with non-zero exit keeps exitCode', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    const result = runNode([fixture, '9']);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 9);
    assert.equal(result.stderr, '');
    assert.notEqual(result.code, undefined);
    assert.equal(result.code, null);
  });

  test('a child that overruns is TIMED_OUT as data, not a throw', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '5000'], { timeoutMs: 300 });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
    assert.equal(result.timedOut, true);
    assert.equal(result.killed, true);
    assert.equal(result.exitCode, null);
  });

  test('timedOut does not depend on signal presence (Windows)', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '5000'], { timeoutMs: 300 });
    // The assertion below is intentionally the whole point of this test: it
    // proves timedOut alone, without ever branching on result.signal. See
    // 40-design.md row 6 — signal is null on Windows and must not be
    // load-bearing for this flag.
    assert.equal(result.timedOut, true);
  });

  test('a timeout still returns string stdout/stderr (partial content is platform-dependent)', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const marker = JSON.stringify({ partial: true });
    const result = runNode([fixture, '5000', marker], { timeoutMs: 300 });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
    assert.equal(result.timedOut, true);
    assert.equal(typeof result.stdout, 'string');
    assert.equal(typeof result.stderr, 'string');
    // spawnSync preserves partial child output on a timeout on darwin, but discards
    // it on Linux (verified on node 22 and 24). The seam passes through whatever
    // spawnSync gives it, so the cross-platform contract is only that these are
    // strings — the partial content itself is asserted where it is actually available.
    if (process.platform === 'darwin') {
      assert.ok(result.stdout.length > 0, 'darwin preserves partial stdout on timeout');
      assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { partial: true });
    }
  });

  test('maxBuffer overflow is not misreported as exit 1', () => {
    const fixture = writeFixture(tmpDir, 'overflow.cjs', FIXTURE_OVERFLOW);
    const result = runNode([fixture, '0']);
    assert.equal(result.outcome, OUTCOME.BUFFER_OVERFLOW);
    assert.notEqual(result.exitCode, 1);
    assert.equal(result.exitCode, null);
    assert.ok(BUFFER_OVERFLOW_CODES.includes(result.code));
  });

  test('a missing binary is SPAWN_FAILED, not a timeout', () => {
    // git exists on the test host; a nonexistent cwd makes the OS-level
    // spawn itself fail with ENOENT (uv_spawn), the same failure class as a
    // missing binary, without requiring the seam to expose a raw command
    // parameter callers could point at an arbitrary executable name.
    const result = runGit(['status'], { cwd: path.join(tmpDir, 'does-not-exist') });
    assert.equal(result.outcome, OUTCOME.SPAWN_FAILED);
    assert.equal(result.code, 'ENOENT');
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
  });

  // Regression for the Windows CI failure on PR #3066: a `status === null`
  // catch-all previously misclassified this as TIMED_OUT (the process never
  // even started), which drove the adapter into a pointless retry. An
  // oversized argv errors at the OS spawn boundary before the child exists
  // at all — E2BIG on Linux/macOS, ENAMETOOLONG on Windows — and must
  // classify as SPAWN_FAILED regardless of which errno the platform uses.
  test('an oversized argv is SPAWN_FAILED, not TIMED_OUT, cross-platform', () => {
    const fixture = writeFixture(tmpDir, 'echo-argv.cjs', FIXTURE_ECHO_ARGV);
    const oversizedArg = 'x'.repeat(4 * 1024 * 1024);
    const result = runNode([fixture, oversizedArg]);
    assert.equal(result.outcome, OUTCOME.SPAWN_FAILED);
    assert.equal(result.timedOut, false);
    assert.equal(typeof result.code, 'string');
    assert.ok(result.code.length > 0);
  });

  test('omitting timeoutMs still bounds the call', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    const withDefault = runNode([fixture, '0']);
    const withExplicitDefault = runNode([fixture, '0'], { timeoutMs: 60000 });
    // Omitting timeoutMs must resolve to the same bounded code path as
    // explicitly passing the documented default — never a distinct
    // "unbounded" branch.
    assert.deepStrictEqual(
      { outcome: withDefault.outcome, exitCode: withDefault.exitCode, timedOut: withDefault.timedOut },
      { outcome: withExplicitDefault.outcome, exitCode: withExplicitDefault.exitCode, timedOut: withExplicitDefault.timedOut }
    );
  });

  test('child finishing just under the bound is EXITED', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '50'], { timeoutMs: 5000 });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.timedOut, false);
  });

  test('at-the-bound child yields one deterministic outcome', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '300'], { timeoutMs: 300 });
    // Either outcome is acceptable at the exact bound (OS/scheduler
    // jitter decides which side of the race wins) — what must never happen
    // is an outcome outside the pair, or fields inconsistent with whichever
    // branch fired. This is the non-flaky formulation of "at the limit".
    assert.ok([OUTCOME.EXITED, OUTCOME.TIMED_OUT].includes(result.outcome));
    if (result.outcome === OUTCOME.EXITED) {
      assert.equal(result.timedOut, false);
      assert.notEqual(result.exitCode, null);
    } else {
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
    }
  });

  test('child overrunning the bound is TIMED_OUT', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '5000'], { timeoutMs: 200 });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
  });

  test('invalid timeoutMs is rejected, not coerced to unbounded', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    for (const invalid of [0, -5, NaN, 'abc', Infinity]) {
      assert.throws(() => runNode([fixture, '0'], { timeoutMs: invalid }), TypeError);
    }
  });

  test('input is delivered to the child on stdin', () => {
    const fixture = writeFixture(tmpDir, 'echo-stdin.cjs', FIXTURE_ECHO_STDIN);
    const result = runNode([fixture], { input: 'hello-stdin' });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {
      received: 'hello-stdin',
      hadData: true,
    });
  });

  test('omitted input does not close stdin as empty string', () => {
    const fixture = writeFixture(tmpDir, 'echo-stdin.cjs', FIXTURE_ECHO_STDIN);
    const result = runNode([fixture]);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {
      received: '',
      hadData: false,
    });
  });

  test('caller cannot override encoding into Buffers', () => {
    const fixture = writeFixture(tmpDir, 'exit.cjs', FIXTURE_EXIT);
    const result = runNode([fixture, '0', 'marker'], { encoding: 'buffer' });
    assert.equal(typeof result.stdout, 'string');
    assert.equal(Buffer.isBuffer(result.stdout), false);
  });

  test('argv metacharacters are not interpreted by a shell', () => {
    const fixture = writeFixture(tmpDir, 'echo-argv.cjs', FIXTURE_ECHO_ARGV);
    const hostileArgv = [';', '&&', '$(ls)', '`ls`', '| cat', '> /tmp/x'];
    const result = runNode([fixture, ...hostileArgv]);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()).argv, hostileArgv);
  });

  test('flag-shaped argv values are not re-parsed', () => {
    const fixture = writeFixture(tmpDir, 'echo-argv.cjs', FIXTURE_ECHO_ARGV);
    const flagLikeArgv = ['--weird', '--timeoutMs=1', '-x'];
    const result = runNode([fixture, ...flagLikeArgv]);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()).argv, flagLikeArgv);
  });

  test('long and unicode argv survive the seam', () => {
    const fixture = writeFixture(tmpDir, 'echo-argv.cjs', FIXTURE_ECHO_ARGV);
    const longArgv = ['x'.repeat(5000), '日本語テスト', '🚀emoji🚀', 'café'];
    const result = runNode([fixture, ...longArgv]);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()).argv, longArgv);
  });

  test('a custom killSignal is reported, not normalized', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '5000'], { timeoutMs: 200, killSignal: 'SIGINT' });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
    if (process.platform !== 'win32') {
      assert.equal(result.signal, 'SIGINT');
    }
  });

  test('timeout with stderr reports one outcome, keeps both fields', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const result = runNode([fixture, '5000', '', 'err-marker'], { timeoutMs: 300 });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
    assert.equal(typeof result.stdout, 'string');
    assert.equal(typeof result.stderr, 'string');
    // spawnSync preserves partial child output on a timeout on darwin, but discards
    // it on Linux (verified on node 22 and 24). The seam passes through whatever
    // spawnSync gives it, so the cross-platform contract is only that these are
    // strings — the partial content itself is asserted where it is actually available.
    if (process.platform === 'darwin') {
      assert.ok(result.stderr.length > 0, 'darwin preserves partial stderr on timeout');
    }
  });

  test('overflow is not masked by an exit code', () => {
    const fixture = writeFixture(tmpDir, 'overflow.cjs', FIXTURE_OVERFLOW);
    const result = runNode([fixture, '7']);
    assert.equal(result.outcome, OUTCOME.BUFFER_OVERFLOW);
    assert.equal(result.exitCode, null);
  });

  test('consecutive timeouts do not share state', () => {
    const fixture = writeFixture(tmpDir, 'sleeper.cjs', FIXTURE_SLEEPER);
    const first = runNode([fixture, '5000'], { timeoutMs: 200 });
    const second = runNode([fixture, '5000'], { timeoutMs: 200 });
    assert.equal(first.outcome, OUTCOME.TIMED_OUT);
    assert.equal(second.outcome, OUTCOME.TIMED_OUT);
  });

  test('OUTCOME enum keys are locked', () => {
    assert.equal(Object.isFrozen(OUTCOME), true);
    assert.deepStrictEqual(Object.keys(OUTCOME).sort(), [
      'BUFFER_OVERFLOW',
      'EXITED',
      'KILLED',
      'SPAWN_FAILED',
      'TIMED_OUT',
    ]);
    assert.deepStrictEqual(OUTCOME, {
      EXITED: 'exited',
      KILLED: 'killed',
      TIMED_OUT: 'timed_out',
      BUFFER_OVERFLOW: 'buffer_overflow',
      SPAWN_FAILED: 'spawn_failed',
    });
    assert.throws(() => {
      OUTCOME.EXITED = 'nope';
    }, TypeError);
  });

  test('a child killed by an external signal is KILLED, not EXITED', (t) => {
    if (process.platform === 'win32') {
      t.skip('signal semantics differ on win32 — see design doc row on Windows signals');
      return;
    }
    const fixture = writeFixture(tmpDir, 'suicide.cjs', FIXTURE_SUICIDE);
    const result = runNode([fixture], { timeoutMs: 5000 });
    assert.equal(result.outcome, OUTCOME.KILLED);
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.exitCode, null);
  });

  // Smoke coverage for runHook's export (matches the invocation shape used by
  // tests/read-guard.test.cjs:34 and tests/workflow-guard.test.cjs:28 —
  // process.execPath + [HOOK_PATH, ...args] with a JSON stdin payload).
  test('runHook invokes a real hook via process.execPath', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-read-guard.js');
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: {} });
    const env = {
      ...process.env,
      CLAUDE_SESSION_ID: '',
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      CLAUDE_CODE_SSE_PORT: '',
      CLAUDE_PROJECT_DIR: '',
    };
    const result = runHook(hookPath, [], { input: payload, env, timeoutMs: 5000 });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(typeof result.stdout, 'string');
  });
});

describe('runHook interpreter option', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('process-seam-interpreter-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('omitting interpreter still spawns via process.execPath', () => {
    const hookPath = writeFixture(tmpDir, 'hook.cjs', FIXTURE_ECHO_ARGV);
    const result = runHook(hookPath, ['a', 'b']);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()).argv, ['a', 'b']);
  });

  // bash availability is checked, never assumed — a Windows host or a
  // node-only container may not have bash on PATH.
  function isBashAvailable() {
    if (process.platform === 'win32') return false;
    const probeResult = spawnSync('bash', ['-c', 'exit 0']);
    return !probeResult.error;
  }

  const bashAvailable = isBashAvailable();

  test('interpreter: bash runs a bash script and reports EXITED', (t) => {
    if (!bashAvailable) {
      t.skip('bash is not available on this host');
      return;
    }
    const scriptPath = path.join(tmpDir, 'hook.sh');
    fs.writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        'echo \'{"ok":true}\'',
        'exit 0',
      ].join('\n')
    );
    const result = runHook(scriptPath, [], { interpreter: 'bash' });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { ok: true });
  });

  test('interpreter is not forwarded into spawnSync options', () => {
    const hookPath = writeFixture(tmpDir, 'hook.cjs', FIXTURE_EXIT);
    // If `interpreter` leaked into spawnOptions, spawnSync would receive an
    // unexpected string-valued option alongside a valid timeoutMs; the
    // seam's contract-validation for timeoutMs must still pass through
    // untouched and the call must complete without throwing.
    const result = runHook(hookPath, ['0'], { interpreter: process.execPath, timeoutMs: 5000 });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
  });

  test('interpreter: bash on a script past timeoutMs is TIMED_OUT', (t) => {
    if (!bashAvailable) {
      t.skip('bash is not available on this host');
      return;
    }
    const scriptPath = path.join(tmpDir, 'sleeper.sh');
    fs.writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        'sleep 5',
      ].join('\n')
    );
    const result = runHook(scriptPath, [], { interpreter: 'bash', timeoutMs: 300 });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  });
});

describe('runGsdTools adapter (process-seam parity)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('process-seam-adapter-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('adapter returns the legacy success shape', () => {
    const result = runGsdTools(['--help'], tmpDir);
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.output, 'string');
  });

  test('adapter returns the legacy failure shape', () => {
    const result = runGsdTools(['this-is-not-a-real-command'], tmpDir);
    assert.equal(result.success, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(typeof result.exitCode, 'number');
    assert.notEqual(result.exitCode, 0);
  });

  test('adapter reproduces the empty-stderr diagnostic verbatim', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.EXITED,
        exitCode: 9,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        killed: false,
        code: null,
      }),
      () => {
        const result = runGsdTools(['a', 'b'], tmpDir);
        const expected = `Command failed: ${process.execPath} ${TOOLS_PATH} a b [stderr: (empty) exit:9]`;
        assert.equal(result.success, false);
        assert.equal(result.error, expected);
        assert.equal(result.exitCode, 9);
      }
    );
  });

  test('adapter still retries once on kill', () => {
    withMockedRunNode(
      (callCount) => (callCount === 1
        ? {
          outcome: OUTCOME.TIMED_OUT,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          signal: 'SIGTERM',
          killed: true,
          code: 'ETIMEDOUT',
        }
        : {
          outcome: OUTCOME.EXITED,
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
          timedOut: false,
          signal: null,
          killed: false,
          code: null,
        }),
      (getCallCount) => {
        const result = runGsdTools(['x'], tmpDir);
        assert.equal(result.success, true);
        assert.equal(result.output, 'ok');
        assert.equal(getCallCount(), 2);
      }
    );
  });

  test('adapter retries once on KILLED, mirroring TIMED_OUT', () => {
    withMockedRunNode(
      (callCount) => (callCount === 1
        ? {
          outcome: OUTCOME.KILLED,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          signal: 'SIGKILL',
          killed: true,
          code: null,
        }
        : {
          outcome: OUTCOME.EXITED,
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
          timedOut: false,
          signal: null,
          killed: false,
          code: null,
        }),
      (getCallCount) => {
        const result = runGsdTools(['x'], tmpDir);
        assert.equal(result.success, true);
        assert.equal(result.output, 'ok');
        assert.equal(getCallCount(), 2);
      }
    );
  });

  test('adapter throws resource-starvation when KILLED persists after retry', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.KILLED,
        exitCode: null,
        stdout: 'partial-out',
        stderr: 'partial-err',
        timedOut: false,
        signal: 'SIGKILL',
        killed: true,
        code: null,
      }),
      (getCallCount) => {
        const expected =
          `[runGsdTools: resource-starvation / subprocess-kill after retry] ` +
          `gsd-tools was killed before completion ` +
          `(signal=SIGKILL, code=null, killed=true). ` +
          `This indicates host OOM or scheduler contention, not a product bug. ` +
          `stdout=partial-out stderr=partial-err`;
        assert.throws(
          () => runGsdTools(['x'], tmpDir),
          (err) => err instanceof Error && err.message === expected
        );
        assert.equal(getCallCount(), 2);
      }
    );
  });

  test('adapter still throws resource-starvation after retry', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.TIMED_OUT,
        exitCode: null,
        stdout: 'partial-out',
        stderr: 'partial-err',
        timedOut: true,
        signal: 'SIGTERM',
        killed: true,
        code: 'ETIMEDOUT',
      }),
      () => {
        const expected =
          `[runGsdTools: resource-starvation / subprocess-kill after retry] ` +
          `gsd-tools was killed before completion ` +
          `(signal=SIGTERM, code=ETIMEDOUT, killed=true). ` +
          `This indicates host OOM or scheduler contention, not a product bug. ` +
          `stdout=partial-out stderr=partial-err`;
        assert.throws(
          () => runGsdTools(['x'], tmpDir),
          (err) => err instanceof Error && err.message === expected
        );
      }
    );
  });

  test('adapter retries exactly once, not twice', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.TIMED_OUT,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        signal: 'SIGTERM',
        killed: true,
        code: 'ETIMEDOUT',
      }),
      (getCallCount) => {
        assert.throws(() => runGsdTools(['x'], tmpDir));
        assert.equal(getCallCount(), 2);
      }
    );
  });

  test('adapter still accepts a shell-style string', () => {
    const result = runGsdTools('--help', tmpDir);
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
  });

  test('adapter still accepts an argv array', () => {
    const result = runGsdTools(['--help'], tmpDir);
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
  });

  test('adapter preserves env override precedence', () => {
    withMockedRunNode(
      (_callCount, _args, options) => {
        // Capture the merged env the adapter built, then return a fast
        // EXITED result — this test is about the merge, not gsd-tools.
        withMockedRunNode.capturedEnv = options.env;
        return {
          outcome: OUTCOME.EXITED,
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          signal: null,
          killed: false,
          code: null,
        };
      },
      () => {
        runGsdTools(['x'], tmpDir, { GSD_SESSION_KEY: 'override-value' });
        // TEST_ENV_BASE defaults GSD_SESSION_KEY to '' — the caller's env
        // argument must win over it.
        assert.equal(withMockedRunNode.capturedEnv.GSD_SESSION_KEY, 'override-value');
      }
    );
  });

  // Legacy-shape contract: the SEAM reports exitCode: null for
  // BUFFER_OVERFLOW (asserted above, at the seam level), but a real caller
  // (tests/context-predicates-query.test.cjs) asserts
  // `typeof r.exitCode === 'number'` on the ADAPTER's legacy shape, matching
  // the pre-seam execFileSync helper's `err.status ?? 1`. This is the
  // adapter-level contract, deliberately distinct from the seam-level one.
  test('adapter does not retry a buffer overflow, and coerces exitCode to a number', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.BUFFER_OVERFLOW,
        exitCode: null,
        stdout: 'x'.repeat(20),
        stderr: '',
        timedOut: false,
        signal: 'SIGTERM',
        killed: true,
        code: 'ENOBUFS',
      }),
      (getCallCount) => {
        const result = runGsdTools(['x'], tmpDir);
        assert.equal(getCallCount(), 1);
        assert.equal(result.success, false);
        assert.equal(typeof result.exitCode, 'number');
        assert.equal(result.exitCode, 1);
      }
    );
  });

  // Same legacy-shape contract as the buffer-overflow test above, for
  // SPAWN_FAILED (the Windows CI regression case: an oversized argv).
  test('adapter does not retry a spawn failure, and coerces exitCode to a number', () => {
    withMockedRunNode(
      () => ({
        outcome: OUTCOME.SPAWN_FAILED,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        killed: false,
        code: 'ENOENT',
      }),
      (getCallCount) => {
        const result = runGsdTools(['x'], tmpDir);
        assert.equal(getCallCount(), 1);
        assert.equal(result.success, false);
        assert.equal(typeof result.exitCode, 'number');
        assert.equal(result.exitCode, 1);
      }
    );
  });
});
