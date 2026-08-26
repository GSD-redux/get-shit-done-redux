'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { ExitError, runMain } = require('../scripts/lib/cli-exit.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

// Paths to the compiled product seam (src/cli-exit.cts → gsd-core/bin/lib/cli-exit.cjs)
// used for json-error mode regression tests which require io.cjs integration.
const BUILT_CLI_EXIT_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/cli-exit.cjs');
const IO_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');
const SCRIPTS_CLI_EXIT_PATH = path.resolve(__dirname, '../scripts/lib/cli-exit.cjs');

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
    return toLegacyResult(runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS }));
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

  /**
   * #3904 (epic #3889, ADR-3889 P0) — scripts/lib/cli-exit.cjs was a SECOND
   * hand-written implementation of this seam, and it had no json-error arm at
   * all: an unexpected throw printed a raw stack trace where the documented
   * contract promises { ok:false, reason, message }. 64+ files under scripts/
   * require that copy.
   *
   * Fix: scripts/lib/cli-exit.cjs is now GENERATED from src/cli-exit.cts's
   * compiled output and byte-compared by scripts/gen-scripts-cli-exit.cjs
   * --check, so the two cannot diverge again.
   *
   * These run against the SCRIPTS copy specifically — the sibling bug-965 block
   * above deliberately targets the built copy, which is exactly how the drift
   * stayed invisible.
   */
  describe('bug-3904: the scripts copy is the same artifact as the built one', () => {
    /** Build a one-shot driver script for whichever copy is under test. */
    function driver(modulePath, { jsonMode, throwExpr }) {
      return [
        `const cliExit = require(${JSON.stringify(modulePath)});`,
        `const { runMain, ExitError } = cliExit;`,
        `void ExitError;`,
        `cliExit.setJsonErrorMode(${jsonMode});`,
        `runMain(() => { throw ${throwExpr}; });`,
        `setImmediate(() => {});`,
      ].join('\n');
    }

    /**
     * Drive the SCRIPTS copy. json-error mode is set through the scripts copy's
     * own accessor, because a scripts/ consumer on an unbuilt clone has no
     * io.cjs to reach for — that independence is part of what is under test.
     */
    function spawnScriptsRun(opts) {
      return toLegacyResult(
        runNode(['-e', driver(SCRIPTS_CLI_EXIT_PATH, opts)], { timeoutMs: PROBE_TIMEOUT_MS }),
      );
    }

    /** The same driver, pointed at the BUILT copy, for the parity row. */
    function spawnBuiltRun(opts) {
      return toLegacyResult(
        runNode(['-e', driver(BUILT_CLI_EXIT_PATH, opts)], { timeoutMs: PROBE_TIMEOUT_MS }),
      );
    }

    /** Run a snippet that prints JSON on stdout, and return the parsed value. */
    function readJsonFromChild(lines) {
      const r = toLegacyResult(runNode(['-e', lines.join('\n')], { timeoutMs: PROBE_TIMEOUT_MS }));
      assert.strictEqual(r.status, 0, `child exited ${r.status}; stderr: ${r.stderr}`);
      return JSON.parse(r.stdout);
    }

    /** Parse stderr as a single JSON object, failing with the raw text if it is not one. */
    function parseEnvelope(result) {
      const trimmed = result.stderr.trim();
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        return assert.fail(
          `stderr is NOT a single JSON object (raw stack leaked through):\n${trimmed}\nparse error: ${e.message}`,
        );
      }
    }

    // ── Matrix rows 1-3: the reported defect, at the consumer's output ────────
    test('scripts copy emits the structured envelope on an unexpected throw under json mode', () => {
      const result = spawnScriptsRun({ jsonMode: true, throwExpr: `new TypeError('unexpected boom')` });
      assert.strictEqual(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);
      const parsed = parseEnvelope(result);
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.reason, 'sdk_fail_fast');
      assert.ok(
        String(parsed.message).includes('unexpected boom'),
        `expected the thrown text in message, got: ${JSON.stringify(parsed.message)}`,
      );
    });

    test('scripts copy envelope covers RangeError as well as TypeError', () => {
      const result = spawnScriptsRun({ jsonMode: true, throwExpr: `new RangeError('out of bounds')` });
      assert.strictEqual(result.status, 1);
      const parsed = parseEnvelope(result);
      assert.strictEqual(parsed.reason, 'sdk_fail_fast');
      assert.ok(String(parsed.message).includes('out of bounds'));
    });

    test('scripts copy writes the envelope to stderr and leaves stdout empty', () => {
      const result = spawnScriptsRun({ jsonMode: true, throwExpr: `new TypeError('boom')` });
      assert.strictEqual(result.stdout, '', `expected empty stdout, got: ${result.stdout}`);
    });

    // ── Matrix rows 4-5: negative space — what must NOT become an envelope ────
    test('scripts copy preserves the raw stack trace when json mode is off', () => {
      const result = spawnScriptsRun({ jsonMode: false, throwExpr: `new TypeError('unexpected boom')` });
      assert.strictEqual(result.status, 1);
      const trimmed = result.stderr.trim();
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch { /* expected — not JSON */ }
      assert.strictEqual(parsed, null, `expected a raw stack in plain mode, got JSON: ${trimmed.slice(0, 200)}`);
      assert.ok(trimmed.includes('unexpected boom'), `expected the thrown text; got: ${trimmed.slice(0, 200)}`);
    });

    test('scripts copy keeps ExitError plain-text under json mode', () => {
      const result = spawnScriptsRun({
        jsonMode: true,
        throwExpr: `new ExitError(1, 'Usage: gsd-tools <command> [args]')`,
      });
      assert.strictEqual(result.status, 1, 'ExitError exits with its own code');
      const trimmed = result.stderr.trim();
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch { /* expected — plain text */ }
      assert.strictEqual(parsed, null, `ExitError must stay plain text; got JSON: ${trimmed.slice(0, 200)}`);
      assert.ok(trimmed.includes('Usage'), `plain-text message must reach stderr; got: ${trimmed.slice(0, 200)}`);
    });

    // ── Matrix rows 6-10: non-Error throws reach String(err) ─────────────────
    for (const [label, throwExpr, expectedMessage] of [
      ['a thrown string', `'a bare string'`, 'a bare string'],
      ['a thrown null', `null`, 'null'],
      ['a thrown undefined', `undefined`, 'undefined'],
      ['an Error with an empty message', `new Error('')`, 'Error'],
    ]) {
      test(`scripts copy envelope handles ${label}`, () => {
        const result = spawnScriptsRun({ jsonMode: true, throwExpr });
        assert.strictEqual(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);
        const parsed = parseEnvelope(result);
        assert.strictEqual(parsed.ok, false);
        assert.strictEqual(parsed.reason, 'sdk_fail_fast');
        assert.ok(
          String(parsed.message).includes(expectedMessage),
          `expected ${JSON.stringify(expectedMessage)} in message, got ${JSON.stringify(parsed.message)}`,
        );
      });
    }

    test('scripts copy envelope stays parseable when the message contains quotes and newlines', () => {
      // Proves JSON.stringify is doing the encoding rather than string concatenation:
      // an unescaped quote or newline would split stderr into something JSON.parse rejects.
      const hostile = 'he said "hi"\nthen \\left\ttab';
      const result = spawnScriptsRun({ jsonMode: true, throwExpr: `new Error(${JSON.stringify(hostile)})` });
      assert.strictEqual(result.status, 1);
      const parsed = parseEnvelope(result);
      assert.strictEqual(parsed.message, hostile, 'the message must round-trip byte-for-byte');
    });

    // ── Matrix row 11: the two copies are one artifact ───────────────────────
    test('the built copy and the scripts copy produce identical verdicts for every throw class', () => {
      const cases = [
        { jsonMode: true, throwExpr: `new TypeError('same boom')` },
        { jsonMode: false, throwExpr: `new TypeError('same boom')` },
        { jsonMode: true, throwExpr: `new ExitError(3, 'same usage')` },
      ];
      for (const c of cases) {
        const fromScripts = spawnScriptsRun(c);
        const fromBuilt = spawnBuiltRun(c);
        assert.strictEqual(
          fromScripts.status, fromBuilt.status,
          `exit status must match for ${c.throwExpr} (json=${c.jsonMode})`,
        );
        // Normalize the module path that necessarily differs between the two
        // copies, then require the remaining diagnostic bytes to be identical.
        const norm = (s) => s.replace(/[^\s:]*cli-exit\.cjs/g, '<cli-exit>').trim();
        assert.strictEqual(
          norm(fromScripts.stderr), norm(fromBuilt.stderr),
          `stderr must match for ${c.throwExpr} (json=${c.jsonMode})`,
        );
      }
    });

    // ── Matrix rows 13-15: ONE json-error-mode cell, not two ─────────────────
    // This is the hazard the fix INTRODUCES and must therefore be tested rather
    // than reasoned about: after generation there are two module instances of
    // the same artifact, and a module-level `let` would give them two flags.
    test('the mode set through io is visible through the scripts copy', () => {
      assert.deepStrictEqual(
        readJsonFromChild([
          `const io = require(${JSON.stringify(IO_PATH)});`,
          `const cliExit = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
          `io.setJsonErrorMode(true);`,
          `process.stdout.write(JSON.stringify({ viaCliExit: cliExit.getJsonErrorMode() }));`,
        ]),
        { viaCliExit: true },
      );
    });

    test('the mode set through the scripts copy is visible through io', () => {
      assert.deepStrictEqual(
        readJsonFromChild([
          `const io = require(${JSON.stringify(IO_PATH)});`,
          `const cliExit = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
          `cliExit.setJsonErrorMode(true);`,
          `process.stdout.write(JSON.stringify({ viaIo: io.getJsonErrorMode() }));`,
        ]),
        { viaIo: true },
      );
    });

    test('both copies of the exit module share one json-error-mode cell', () => {
      assert.deepStrictEqual(
        readJsonFromChild([
          `const io = require(${JSON.stringify(IO_PATH)});`,
          `const built = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
          `const scripts = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
          // Two distinct module instances of the same artifact.
          `if (built === scripts) throw new Error('expected two distinct module instances');`,
          `io.setJsonErrorMode(true);`,
          `process.stdout.write(JSON.stringify({`,
          `  built: built.getJsonErrorMode(),`,
          `  scripts: scripts.getJsonErrorMode(),`,
          `  io: io.getJsonErrorMode(),`,
          `}));`,
        ]),
        { built: true, scripts: true, io: true },
        'all three views must read one cell — two module-level flags would diverge here',
      );
    });

    // ── Matrix rows 16-17: coercion and default, preserved exactly ───────────
    test('setJsonErrorMode keeps its truthiness coercion', () => {
      const seen = readJsonFromChild([
        `const c = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
        `const seen = [];`,
        `for (const v of [0, '', 'false', null, undefined, 1, 'x']) {`,
        `  c.setJsonErrorMode(v); seen.push(c.getJsonErrorMode());`,
        `}`,
        `process.stdout.write(JSON.stringify(seen));`,
      ]);
      // `!!v` — note 'false' is a NON-EMPTY string and is therefore true.
      assert.deepStrictEqual(seen, [false, false, true, false, false, true, true]);
    });

    test('json-error mode defaults to false when never set', () => {
      assert.deepStrictEqual(
        readJsonFromChild([
          `const c = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
          `const v = c.getJsonErrorMode();`,
          `process.stdout.write(JSON.stringify({ v, type: typeof v }));`,
        ]),
        { v: false, type: 'boolean' },
        'an unset cell must read as boolean false, never undefined',
      );
    });

    // ── Matrix rows 18-21: io's export surface must not move (Hyrum) ─────────
    test('io still exports both json-error-mode accessors and an unchanged ERROR_REASON', () => {
      const seen = readJsonFromChild([
        `const io = require(${JSON.stringify(IO_PATH)});`,
        `process.stdout.write(JSON.stringify({`,
        `  setter: typeof io.setJsonErrorMode,`,
        `  getter: typeof io.getJsonErrorMode,`,
        `  failFast: io.ERROR_REASON.SDK_FAIL_FAST,`,
        `  frozen: Object.isFrozen(io.ERROR_REASON),`,
        `  reasonCount: Object.keys(io.ERROR_REASON).length,`,
        `  keys: Object.keys(io.ERROR_REASON).sort(),`,
        `}));`,
      ]);
      assert.strictEqual(seen.setter, 'function');
      assert.strictEqual(seen.getter, 'function');
      assert.strictEqual(seen.failFast, 'sdk_fail_fast', 'the literal must survive moving to cli-exit');
      assert.strictEqual(seen.frozen, true);
      assert.strictEqual(seen.reasonCount, 23, 'ERROR_REASON must keep all 23 members');
      assert.ok(
        seen.keys.includes('SDK_FAIL_FAST'),
        `ERROR_REASON must still include SDK_FAIL_FAST, got: ${JSON.stringify(seen.keys)}`,
      );
    });

    // ── Matrix rows 22-23: the unbuilt-clone constraint ──────────────────────
    test('the scripts copy loads with no gsd-core tree in scope at all', (t) => {
      // The generated file is COMMITTED and 64+ scripts/ consumers require it,
      // including scripts/check-env.cjs which runs before any build. It must
      // therefore not reach into gsd-core/bin/lib/, which is gitignored tsc
      // output absent on a fresh clone.
      //
      // Proven by copying the file into an isolated temp directory that has no
      // gsd-core sibling and no node_modules — a require of the built tree is
      // MODULE_NOT_FOUND there. Deliberately NOT done by renaming the real
      // gsd-core/bin/lib: test files run in parallel, so mutating a shared
      // production directory would break every sibling suite mid-run.
      //
      // This is the sole guard of the "depends on node: builtins only"
      // constraint: it proves the property by real module resolution in an
      // isolated directory, rather than by inspecting require() specifiers.
      const dir = createTempDir('gsd-3904-standalone-');
      t.after(() => cleanup(dir));
      const copied = path.join(dir, 'cli-exit.cjs');
      fs.copyFileSync(SCRIPTS_CLI_EXIT_PATH, copied);

      const r = toLegacyResult(runNode(['-e', [
        `const c = require(${JSON.stringify(copied)});`,
        `c.setJsonErrorMode(true);`,
        `c.runMain(() => { throw new TypeError('still works'); });`,
        `setImmediate(() => {});`,
      ].join('\n')], { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }));

      assert.ok(
        !r.stderr.includes('MODULE_NOT_FOUND'),
        `the scripts copy must not require anything outside node: builtins; got: ${r.stderr.slice(0, 400)}`,
      );
      assert.strictEqual(r.status, 1, `expected exit 1; stderr: ${r.stderr}`);
      assert.strictEqual(JSON.parse(r.stderr.trim()).reason, 'sdk_fail_fast');
    });

    test('the build sentinel is still emitted', () => {
      // gsd-core/bin/ensure-runtime-build.cjs keys isBuilt() on this exact filename.
      assert.ok(
        fs.statSync(BUILT_CLI_EXIT_PATH).isFile(),
        'gsd-core/bin/lib/cli-exit.cjs must remain tsc output — it is the build sentinel',
      );
    });
  });
});
