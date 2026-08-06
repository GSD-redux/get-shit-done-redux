'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { ExitError, runMain } = require('../scripts/lib/cli-exit.cjs');

// Paths to the compiled product seam (src/cli-exit.cts → gsd-core/bin/lib/cli-exit.cjs)
// used for json-error mode regression tests which require io.cjs integration.
const BUILT_CLI_EXIT_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/cli-exit.cjs');
const IO_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');

/** Settle the runMain promise chain before asserting. */
async function settle() {
  await new Promise((r) => setImmediate(r));
}

describe('ExitError', () => {
  test('default code is 1', () => {
    const err = new ExitError();
    assert.equal(err.code, 1);
  });

  test('name is ExitError', () => {
    const err = new ExitError();
    assert.equal(err.name, 'ExitError');
  });

  test('instanceof Error', () => {
    assert.ok(new ExitError() instanceof Error);
  });

  test('hasUserMessage is false when no message passed', () => {
    const err = new ExitError(1);
    assert.equal(err.hasUserMessage, false);
  });

  test('hasUserMessage is true when message passed', () => {
    const err = new ExitError(1, 'something went wrong');
    assert.equal(err.hasUserMessage, true);
  });

  test('custom code is preserved', () => {
    const err = new ExitError(42, 'boom');
    assert.equal(err.code, 42);
  });

  test('message is set to user message when provided', () => {
    const err = new ExitError(2, 'user msg');
    assert.equal(err.message, 'user msg');
  });

  test('message is synthetic when no message provided', () => {
    const err = new ExitError(3);
    assert.equal(err.message, 'process exit 3');
  });
});

describe('runMain', () => {
  test('main returns a number sets process.exitCode', async () => {
    const saved = process.exitCode;
    try {
      runMain(() => 42);
      await settle();
      assert.equal(process.exitCode, 42);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main returns undefined leaves process.exitCode unchanged', async () => {
    const saved = process.exitCode;
    // Set a known value before calling
    process.exitCode = 0;
    try {
      runMain(() => undefined);
      await settle();
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main throws ExitError sets process.exitCode to err.code', async () => {
    const saved = process.exitCode;
    try {
      runMain(() => { throw new ExitError(2); });
      await settle();
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main rejects async ExitError(0) sets process.exitCode to 0', async () => {
    const saved = process.exitCode;
    try {
      runMain(async () => { throw new ExitError(0); });
      await settle();
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = saved !== undefined ? saved : 0;
    }
  });

  test('main throws generic Error sets process.exitCode to 1 and writes stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new Error('kaboom'); });
      await settle();
      assert.equal(process.exitCode, 1);
      const combined = stderrChunks.join('');
      assert.ok(combined.includes('kaboom'), `expected "kaboom" in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    }
  });

  test('ExitError with hasUserMessage and non-zero code writes to stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new ExitError(1, 'user-visible error'); });
      await settle();
      assert.equal(process.exitCode, 1);
      const combined = stderrChunks.join('');
      assert.ok(combined.includes('user-visible error'), `expected message in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    }
  });

  test('ExitError with hasUserMessage and code 0 does NOT write to stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new ExitError(0, 'silent success'); });
      await settle();
      assert.equal(process.exitCode, 0);
      const combined = stderrChunks.join('');
      assert.equal(combined.includes('silent success'), false,
        `did not expect message in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved !== undefined ? saved : 0;
    }
  });
});

// ─── Regressions ─────────────────────────────────────────────────────────────

/**
 * bug #965 — runMain unexpected throw with --json-errors active emitted a raw
 * stack trace instead of a structured { ok:false, reason, message } envelope.
 * SDK consumers parsing structured errors would receive an unparseable string.
 *
 * Fix: src/cli-exit.cts non-ExitError catch branch now checks getJsonErrorMode()
 * and emits the same structured envelope as error() when active.
 *
 * Tests run against the compiled product seam (gsd-core/bin/lib/cli-exit.cjs)
 * via subprocess so that io.cjs module-level state is isolated per spawn.
 */
describe('regressions', () => {
  /** Spawn a one-shot script that sets json-error mode and calls runMain with a throwing handler. */
  function spawnJsonErrorRun({ jsonMode, errorType = 'TypeError', message = 'unexpected boom' } = {}) {
    // ExitError lives in the same module as runMain; import it when the test
    // wants to exercise the ExitError carve-out path. ExitError takes (code, message).
    const isExitError = errorType === 'ExitError';
    const destructure = isExitError ? '{ runMain, ExitError }' : '{ runMain }';
    const throwExpr = isExitError
      ? `new ExitError(1, ${JSON.stringify(message)})`
      : `new ${errorType}(${JSON.stringify(message)})`;
    const script = `
      const io = require(${JSON.stringify(IO_PATH)});
      const ${destructure} = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});
      io.setJsonErrorMode(${jsonMode ? 'true' : 'false'});
      runMain(() => { throw ${throwExpr}; });
      setImmediate(() => {});
    `;
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
  }

  describe('bug-965: unexpected throw in json-error mode emits structured envelope', () => {
    test('stderr is a single parseable JSON object (not a raw stack trace)', () => {
      const result = spawnJsonErrorRun({ jsonMode: true });
      assert.strictEqual(result.status, 1,
        `expected exit code 1, got ${result.status}; stderr: ${result.stderr}`);
      const stderrTrimmed = result.stderr.trim();
      assert.ok(stderrTrimmed.length > 0, 'expected non-empty stderr');
      let parsed;
      try {
        parsed = JSON.parse(stderrTrimmed);
      } catch (e) {
        assert.fail(
          `stderr is NOT valid JSON (raw stack trace leaked through):\n${stderrTrimmed}\nparse error: ${e.message}`
        );
      }
      assert.strictEqual(parsed.ok, false, `expected ok:false, got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.reason, 'sdk_fail_fast',
        `expected reason "sdk_fail_fast", got: ${parsed.reason}`);
      assert.ok(
        parsed.message && parsed.message.includes('unexpected boom'),
        `expected message to include "unexpected boom", got: ${JSON.stringify(parsed.message)}`
      );
    });

    test('stderr JSON works for RangeError as well as TypeError', () => {
      const result = spawnJsonErrorRun({ jsonMode: true, errorType: 'RangeError', message: 'out of bounds' });
      assert.strictEqual(result.status, 1);
      const parsed = JSON.parse(result.stderr.trim());
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.reason, 'sdk_fail_fast');
      assert.ok(parsed.message.includes('out of bounds'));
    });

    test('stdout is empty when unexpected throw emits structured error', () => {
      const result = spawnJsonErrorRun({ jsonMode: true });
      assert.strictEqual(result.stdout, '',
        `expected empty stdout, got: ${result.stdout}`);
    });

    test('plain mode (json-error off) preserves raw stack trace on stderr', () => {
      const result = spawnJsonErrorRun({ jsonMode: false });
      assert.strictEqual(result.status, 1);
      const stderrTrimmed = result.stderr.trim();
      let parsed = null;
      try { parsed = JSON.parse(stderrTrimmed); } catch { /* expected — not JSON */ }
      assert.strictEqual(parsed, null,
        `expected raw stack (non-JSON) on stderr in plain mode, but got valid JSON: ${stderrTrimmed.slice(0, 200)}`);
      assert.ok(
        stderrTrimmed.includes('unexpected boom'),
        `expected "unexpected boom" in stderr, got: ${stderrTrimmed.slice(0, 200)}`
      );
    });

    // #2979: characterization test pinning the two error paths under json-errors
    // mode. The structured envelope covers non-ExitError failures; ExitError
    // (usage errors) intentionally emits plain text with its own exit code.
    // Both halves asserted together so the code cannot drift toward the doc's
    // prior overstated claim that EVERY error emits JSON.
    test('#2979: ExitError emits plain text (not JSON) even under --json-errors; non-ExitError emits the envelope', () => {
      // ExitError path: plain text, own exit code, NOT a JSON object.
      const exitResult = spawnJsonErrorRun({
        jsonMode: true,
        errorType: 'ExitError',
        message: 'Usage: gsd-tools <command> [args]',
      });
      assert.strictEqual(exitResult.status, 1, 'ExitError exits with its code');
      const exitStderr = exitResult.stderr.trim();
      let exitParsed = null;
      try { exitParsed = JSON.parse(exitStderr); } catch { /* expected — plain text */ }
      assert.strictEqual(exitParsed, null,
        `ExitError must emit plain text, not JSON; got: ${exitStderr.slice(0, 200)}`);
      assert.ok(exitStderr.includes('Usage'),
        `ExitError plain-text message must reach stderr; got: ${exitStderr.slice(0, 200)}`);

      // Non-ExitError path: structured JSON envelope.
      const envResult = spawnJsonErrorRun({ jsonMode: true });
      assert.strictEqual(envResult.status, 1);
      const envParsed = JSON.parse(envResult.stderr.trim());
      assert.strictEqual(envParsed.ok, false);
      assert.strictEqual(envParsed.reason, 'sdk_fail_fast');
      assert.ok(envParsed.message, 'envelope must carry a message');
    });
  });
});
