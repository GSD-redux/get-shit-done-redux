'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  ExitError, runMain, projectOutcome, resolveContractVersion, getContractVersion,
} = require('../scripts/lib/cli-exit.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

// Paths to the compiled product seam (src/cli-exit.cts → gsd-core/bin/lib/cli-exit.cjs)
// used for json-error mode regression tests which require io.cjs integration.
const BUILT_CLI_EXIT_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/cli-exit.cjs');
const IO_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');
const SCRIPTS_CLI_EXIT_PATH = path.resolve(__dirname, '../scripts/lib/cli-exit.cjs');
const EXIT_CODE_REGISTRY_PATH = path.resolve(__dirname, '../gsd-core/bin/lib/exit-code-registry.cjs');

const { EXIT_CODES } = require(EXIT_CODE_REGISTRY_PATH);
const REGISTERED_NAMES = EXIT_CODES.map((e) => e.name);
const VERSIONS = ['v1', 'v2'];

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
  test('main returns a number sets process.exitCode', async (t) => {
    const saved = process.exitCode;
    t.after(() => { process.exitCode = saved || 0; });
    runMain(() => 42);
    await settle();
    assert.equal(process.exitCode, 42);
  });

  test('main returns undefined leaves process.exitCode unchanged', async (t) => {
    const saved = process.exitCode;
    // Set a known value before calling
    process.exitCode = 0;
    t.after(() => { process.exitCode = saved || 0; });
    runMain(() => undefined);
    await settle();
    assert.equal(process.exitCode, 0);
  });

  test('main throws ExitError sets process.exitCode to err.code', async (t) => {
    const saved = process.exitCode;
    t.after(() => { process.exitCode = saved || 0; });
    runMain(() => { throw new ExitError(2); });
    await settle();
    assert.equal(process.exitCode, 2);
  });

  test('main rejects async ExitError(0) sets process.exitCode to 0', async (t) => {
    const saved = process.exitCode;
    t.after(() => { process.exitCode = saved !== undefined ? saved : 0; });
    runMain(async () => { throw new ExitError(0); });
    await settle();
    assert.equal(process.exitCode, 0);
  });

  test('main throws generic Error sets process.exitCode to 1 and writes stderr', async (t) => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    t.after(() => {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    });
    runMain(() => { throw new Error('kaboom'); });
    await settle();
    assert.equal(process.exitCode, 1);
    const combined = stderrChunks.join('');
    assert.ok(combined.includes('kaboom'), `expected "kaboom" in stderr: ${combined}`);
  });

  test('ExitError with hasUserMessage and non-zero code writes to stderr', async (t) => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    t.after(() => {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    });
    runMain(() => { throw new ExitError(1, 'user-visible error'); });
    await settle();
    assert.equal(process.exitCode, 1);
    const combined = stderrChunks.join('');
    assert.ok(combined.includes('user-visible error'), `expected message in stderr: ${combined}`);
  });

  test('ExitError with hasUserMessage and code 0 does NOT write to stderr', async (t) => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    t.after(() => {
      process.stderr.write = origWrite;
      process.exitCode = saved !== undefined ? saved : 0;
    });
    runMain(() => { throw new ExitError(0, 'silent success'); });
    await settle();
    assert.equal(process.exitCode, 0);
    const combined = stderrChunks.join('');
    assert.equal(combined.includes('silent success'), false,
      `did not expect message in stderr: ${combined}`);
  });

  // #3906 (ADR-3889 Phase 2): runMain gained the ability to accept a declared
  // outcome STRING return, projected through the same projectOutcome() the
  // sibling terminator (terminateNow) uses. Every arm above this one is
  // byte-for-byte unchanged — this is the only new arm.
  describe('#3906: runMain accepts a declared outcome string', () => {
    test('a returned registered name projects through the current contract version', async (t) => {
      const saved = process.exitCode;
      t.after(() => { process.exitCode = saved || 0; });
      resolveContractVersion({ argv: ['node', 'x'], env: {} }); // v1 (default)
      runMain(() => 'USAGE');
      await settle();
      assert.equal(process.exitCode, 64);
    });

    test('a returned DEGRADED projects to 0 under v1 and 80 under v2', async (t) => {
      const saved = process.exitCode;
      t.after(() => {
        resolveContractVersion({ argv: ['node', 'x'], env: {} }); // restore default
        process.exitCode = saved || 0;
      });
      resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v1'], env: {} });
      runMain(() => 'DEGRADED');
      await settle();
      assert.equal(process.exitCode, 0);

      resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
      runMain(() => 'DEGRADED');
      await settle();
      assert.equal(process.exitCode, 80);
    });

    test('an unregistered outcome string rejects the same way projectOutcome does (surfaces as the generic-throw arm)', async (t) => {
      const saved = process.exitCode;
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      t.after(() => {
        process.stderr.write = origWrite;
        process.exitCode = saved || 0;
      });
      runMain(() => 'NOT_A_REAL_OUTCOME');
      await settle();
      // The string arm's projectOutcome() call throws synchronously inside
      // the .then() callback, which the SAME .catch() below it already
      // handles as a generic (non-ExitError) throw -> exit code 1.
      assert.equal(process.exitCode, 1);
    });
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
    // Stack-trace bytes are NOT the contract here: on the json=false path, stderr
    // is a raw stack trace, and the generated scripts/ copy carries an 11-line
    // provenance banner that the built copy does not, so every frame line number
    // is offset by exactly that banner length, and the two files necessarily sit
    // at different absolute paths. The two copies share one compiled BODY —
    // the banner is the only difference — so what actually must match is the
    // VERDICT: same exit code, and (json mode) the same structured envelope, or
    // (plain-text mode) the same unqualified error header line with no path or
    // line number in it.
    test('the built copy and the scripts copy produce identical verdicts for every throw class', () => {
      const cases = [
        { jsonMode: true, throwExpr: `new TypeError('same boom')`, compare: 'json' },
        { jsonMode: false, throwExpr: `new TypeError('same boom')`, compare: 'firstLine' },
        { jsonMode: true, throwExpr: `new ExitError(3, 'same usage')`, compare: 'exact' },
      ];
      for (const c of cases) {
        const fromScripts = spawnScriptsRun(c);
        const fromBuilt = spawnBuiltRun(c);
        assert.strictEqual(
          fromScripts.status, fromBuilt.status,
          `exit status must match for ${c.throwExpr} (json=${c.jsonMode})`,
        );
        const label = `${c.throwExpr} (json=${c.jsonMode})`;
        if (c.compare === 'json') {
          // Structured output: parse both and compare the resulting objects.
          assert.deepStrictEqual(
            parseEnvelope(fromScripts), parseEnvelope(fromBuilt),
            `parsed envelopes must match for ${label}`,
          );
        } else if (c.compare === 'firstLine') {
          // Plain-text stack trace: only the header line (e.g. "TypeError: same
          // boom") is path/line-number-free and therefore comparable; the frame
          // lines below it are expected to diverge per the banner offset above.
          for (const r of [fromScripts, fromBuilt]) {
            assert.throws(() => JSON.parse(r.stderr.trim()), `stderr for ${label} must NOT be JSON`);
          }
          const firstLine = (s) => s.trim().split('\n')[0];
          assert.strictEqual(
            firstLine(fromScripts.stderr), firstLine(fromBuilt.stderr),
            `stderr first line must match for ${label}`,
          );
        } else {
          // ExitError: plain prose with no stack trace, so it is byte-identical.
          assert.strictEqual(
            fromScripts.stderr.trim(), fromBuilt.stderr.trim(),
            `stderr must match for ${label}`,
          );
        }
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
      // #3884 (ADR-3473 §8.4) legitimately added two new codes —
      // PICK_FIELD_ABSENT and PICK_OUTPUT_NOT_JSON — for the `--pick`
      // absence contract (see .gsd/phase/feat-3884-failure-is-a-value/40-design.md
      // rows B6/B11). 23 -> 25 is an intentional, documented growth of the
      // enum, not drift; bump the golden count rather than treat this as a
      // Hyrum violation.
      assert.strictEqual(seen.reasonCount, 25, 'ERROR_REASON must keep all 25 members (23 + #3884 PICK_FIELD_ABSENT/PICK_OUTPUT_NOT_JSON)');
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
      //
      // #3906 (ADR-3889 Phase 2): scripts/lib/cli-exit.cjs now also requires
      // its OWN generated sibling, ./exit-code-registry.cjs (dual-emitted by
      // scripts/gen-exit-code-registry.cjs to this exact directory) — so the
      // standalone set this test proves is now TWO files, not one. Copying
      // only cli-exit.cjs here would (correctly) MODULE_NOT_FOUND on the
      // registry require; that failure mode is exercised on its own by the
      // dedicated #3906 standalone-load test below, which is the one that
      // asserts the CORRECT two-file set loads clean.
      const dir = createTempDir('gsd-3904-standalone-');
      t.after(() => cleanup(dir));
      const copied = path.join(dir, 'cli-exit.cjs');
      fs.copyFileSync(SCRIPTS_CLI_EXIT_PATH, copied);
      fs.copyFileSync(path.resolve(__dirname, '../scripts/lib/exit-code-registry.cjs'), path.join(dir, 'exit-code-registry.cjs'));

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

// ─── #3906 (ADR-3889 Phase 2): two terminators over one registry ────────────
//
// projectOutcome/resolveContractVersion are pure (no process.exit, no real
// I/O) and are exercised IN-PROCESS. runMain/terminateNow are exercised as
// SUBPROCESSES via tests/helpers/process-seam.cjs — terminateNow really
// calls process.exit(), which would kill the test runner if called in-process.

const NON_DEGRADED_REGISTERED_NAMES = REGISTERED_NAMES.filter((n) => n !== 'DEGRADED');

describe('#3906: projectOutcome', () => {
  test('PASS projects to 0 under both versions', () => {
    for (const v of VERSIONS) assert.equal(projectOutcome('PASS', v), 0);
  });

  test('FAIL projects to 1 under both versions', () => {
    for (const v of VERSIONS) assert.equal(projectOutcome('FAIL', v), 1);
  });

  test('DEGRADED projects to 0 under v1 and 80 under v2', () => {
    assert.equal(projectOutcome('DEGRADED', 'v1'), 0);
    assert.equal(projectOutcome('DEGRADED', 'v2'), 80);
  });

  test('every other registered name is version-invariant', () => {
    for (const name of NON_DEGRADED_REGISTERED_NAMES) {
      assert.equal(
        projectOutcome(name, 'v1'), projectOutcome(name, 'v2'),
        `${name} must project identically under v1 and v2`,
      );
    }
  });

  test('a registered name resolves through the registry, not a hardcoded table', () => {
    // HOOK_DENY=2, USAGE=64, NO_INPUT=66, UNAVAILABLE=69, INTERNAL=70 — pinned
    // to the shipped table so a future re-allocation is caught here too.
    assert.equal(projectOutcome('HOOK_DENY', 'v1'), 2);
    assert.equal(projectOutcome('USAGE', 'v2'), 64);
    assert.equal(projectOutcome('NO_INPUT', 'v1'), 66);
    assert.equal(projectOutcome('UNAVAILABLE', 'v2'), 69);
    assert.equal(projectOutcome('INTERNAL', 'v1'), 70);
  });

  const badOutcomes = [
    ['unregistered name', 'NOT_A_REAL_OUTCOME'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 0],
    ['plain object', {}],
    ['wrong case', 'pass'],
    ['wrong case registered name', 'usage'],
    ['untrimmed', ' PASS '],
  ];
  for (const [label, value] of badOutcomes) {
    test(`throws for ${label} outcome`, () => {
      assert.throws(() => projectOutcome(value, 'v1'));
      assert.throws(() => projectOutcome(value, 'v2'));
    });
  }

  const badVersions = [
    ['v3', 'v3'],
    ['garbage', 'garbage'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['uppercase V1', 'V1'],
    ['number', 1],
  ];
  for (const [label, value] of badVersions) {
    test(`throws for ${label} version`, () => {
      assert.throws(() => projectOutcome('PASS', value));
    });
  }

  test('every projection is an integer', () => {
    for (const v of VERSIONS) {
      for (const outcome of ['PASS', 'FAIL', ...REGISTERED_NAMES]) {
        const result = projectOutcome(outcome, v);
        assert.equal(Number.isInteger(result), true, `${outcome}/${v} -> ${result} must be an integer`);
      }
    }
  });

  test('every v2 projection except PASS is non-zero', () => {
    for (const outcome of ['FAIL', ...REGISTERED_NAMES]) {
      assert.notEqual(projectOutcome(outcome, 'v2'), 0, `${outcome} must be non-zero under v2`);
    }
  });

  test('fast-check: every projection over the closed outcome/version space is a non-negative integer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('PASS', 'FAIL', ...REGISTERED_NAMES),
        fc.constantFrom(...VERSIONS),
        (outcome, version) => {
          const result = projectOutcome(outcome, version);
          assert.equal(Number.isInteger(result), true);
          assert.ok(result >= 0);
        },
      ),
      { seed: 3906, numRuns: 200 },
    );
  });
});

describe('#3906: resolveContractVersion', () => {
  // Every test in this describe leaves the shared globalThis cell restored to
  // the documented default so later describes (and other test files requiring
  // either copy of this module in the SAME worker) do not observe a version
  // some earlier test selected.
  afterEach(() => { resolveContractVersion({ argv: ['node', 'x'], env: {} }); });

  test('no flag, no env -> v1 (documented default)', () => {
    assert.equal(resolveContractVersion({ argv: ['node', 'x'], env: {} }), 'v1');
  });

  test('--exit-contract=v2 flag -> v2', () => {
    assert.equal(resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} }), 'v2');
  });

  test('GSD_EXIT_CONTRACT=v2 env -> v2', () => {
    assert.equal(resolveContractVersion({ argv: ['node', 'x'], env: { GSD_EXIT_CONTRACT: 'v2' } }), 'v2');
  });

  test('flag v1 beats env v2', () => {
    assert.equal(
      resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v1'], env: { GSD_EXIT_CONTRACT: 'v2' } }),
      'v1',
    );
  });

  test('flag v2 beats env v1 (both directions)', () => {
    assert.equal(
      resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: { GSD_EXIT_CONTRACT: 'v1' } }),
      'v2',
    );
  });

  test('an empty GSD_EXIT_CONTRACT reads as unset, not as an explicit selection', () => {
    assert.equal(resolveContractVersion({ argv: ['node', 'x'], env: { GSD_EXIT_CONTRACT: '' } }), 'v1');
  });

  for (const bad of ['v3', 'garbage', '--exit-contract=']) {
    const flagArg = bad === '--exit-contract=' ? bad : `--exit-contract=${bad}`;
    test(`--exit-contract=${bad === '--exit-contract=' ? '<empty>' : bad} is REJECTED, not silently defaulted`, () => {
      assert.throws(() => resolveContractVersion({ argv: ['node', 'x', flagArg], env: {} }));
    });
  }

  test('GSD_EXIT_CONTRACT=v3 (env garbage) is rejected the same way', () => {
    assert.throws(() => resolveContractVersion({ argv: ['node', 'x'], env: { GSD_EXIT_CONTRACT: 'v3' } }));
  });

  test('casing is decided: uppercase V2 is rejected, not silently accepted', () => {
    assert.throws(() => resolveContractVersion({ argv: ['node', 'x', '--exit-contract=V2'], env: {} }));
    assert.throws(() => resolveContractVersion({ argv: ['node', 'x'], env: { GSD_EXIT_CONTRACT: 'V2' } }));
  });

  test('resolveContractVersion persists into the shared cell read by getContractVersion', () => {
    resolveContractVersion({ argv: ['node', 'x', '--exit-contract=v2'], env: {} });
    assert.equal(getContractVersion(), 'v2');
    resolveContractVersion({ argv: ['node', 'x'], env: {} });
    assert.equal(getContractVersion(), 'v1');
  });
});

describe('#3906: parity — runMain and terminateNow project identically (mandatory per ADR-3889 §3)', () => {
  // #3906 follow-up: this MUST drive the version through the REAL ambient
  // mechanism (GSD_EXIT_CONTRACT in the child's env, never touched by the
  // script body itself), not by calling resolveContractVersion() explicitly
  // inside the child. A test that pre-seeds the shared cell before invoking
  // either terminator can pass even if getContractVersion() never actually
  // wires the ambient process in at all — which is exactly the defect this
  // matrix exists to catch (both terminators reading the SAME un-wired
  // default 'v1' would still "agree", 16/16, while GSD_EXIT_CONTRACT was
  // silently ignored). Neither script below calls resolveContractVersion or
  // passes --exit-contract; the version reaches the process ONLY via env.
  function runMainExit(outcome, version) {
    const script = [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.runMain(() => ${JSON.stringify(outcome)});`,
      `setImmediate(() => {});`,
    ].join('\n');
    return toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...process.env, GSD_EXIT_CONTRACT: version },
    }));
  }

  function terminateNowExit(outcome, version) {
    const script = [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow(${JSON.stringify(outcome)}, { outcome: ${JSON.stringify(outcome)} });`,
    ].join('\n');
    return toLegacyResult(runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...process.env, GSD_EXIT_CONTRACT: version },
    }));
  }

  // HOOK_DENY is EXCLUDED from the "both accept" set below on purpose: it is
  // the one outcome runMain refuses (ADR-3889 §3 — code 2 is terminateNow-only).
  // A cross-product that included it here would (as review found) run
  // runMain('HOOK_DENY'), observe exit 2, and call that "parity" — which is
  // exactly the false claim the restriction is meant to prevent. The
  // dedicated divergence test below this loop asserts the real contract for
  // HOOK_DENY instead: runMain refuses it, terminateNow alone produces 2.
  const NAMES_ACCEPTED_BY_BOTH_TERMINATORS = REGISTERED_NAMES.filter((n) => n !== 'HOOK_DENY');

  for (const version of VERSIONS) {
    for (const outcome of ['PASS', 'FAIL', ...NAMES_ACCEPTED_BY_BOTH_TERMINATORS]) {
      test(`${outcome} under ${version}: runMain and terminateNow agree`, () => {
        const fromRunMain = runMainExit(outcome, version);
        const fromTerminateNow = terminateNowExit(outcome, version);
        assert.equal(
          fromRunMain.status, fromTerminateNow.status,
          `runMain exited ${fromRunMain.status} (stderr: ${fromRunMain.stderr}) but terminateNow exited `
          + `${fromTerminateNow.status} (stderr: ${fromTerminateNow.stderr}) for ${outcome}/${version}`,
        );
      });
    }
  }

  // The restriction itself, made executable: HOOK_DENY (exit code 2) is the
  // ONE outcome the two terminators must NOT agree on. runMain must refuse to
  // produce it (a diagnosable, non-2 exit, never a silent drain to 2), while
  // terminateNow — the only sanctioned write-then-terminate path — still
  // delivers it. Run under both contract versions: the refusal is gated on
  // the PROJECTED code (version-invariant for HOOK_DENY per projectOutcome),
  // not on version, so it must hold identically under v1 and v2.
  for (const version of VERSIONS) {
    test(`HOOK_DENY under ${version}: runMain refuses it (non-2, diagnostic naming HOOK_DENY and terminateNow); terminateNow still exits 2`, () => {
      const fromRunMain = runMainExit('HOOK_DENY', version);
      assert.notEqual(
        fromRunMain.status, 2,
        `runMain must NEVER produce exit code 2 — that is terminateNow-only; stderr: ${fromRunMain.stderr}`,
      );
      assert.ok(
        fromRunMain.stderr.includes('HOOK_DENY'),
        `expected the refusal diagnostic to name HOOK_DENY; got: ${fromRunMain.stderr}`,
      );
      assert.ok(
        fromRunMain.stderr.includes('terminateNow'),
        `expected the refusal diagnostic to name terminateNow; got: ${fromRunMain.stderr}`,
      );

      const fromTerminateNow = terminateNowExit('HOOK_DENY', version);
      assert.equal(
        fromTerminateNow.status, 2,
        `terminateNow must still exit 2 for HOOK_DENY; stderr: ${fromTerminateNow.stderr}`,
      );
    });
  }

  // #3906 follow-up: a matrix where every row merely agrees between the two
  // terminators is satisfiable by a build that ignores GSD_EXIT_CONTRACT
  // entirely (both terminators would then agree on the un-wired v1 default
  // for every row, 16/16, and the matrix above would still read green). This
  // block is the non-vacuousness proof the brief demands: it asserts the ONE
  // row that MUST be version-sensitive actually differs by version, and
  // spot-checks a control row that must NOT.
  test('non-vacuousness: DEGRADED is version-sensitive via ambient GSD_EXIT_CONTRACT', () => {
    const runMainV1 = runMainExit('DEGRADED', 'v1');
    const runMainV2 = runMainExit('DEGRADED', 'v2');
    const terminateNowV1 = terminateNowExit('DEGRADED', 'v1');
    const terminateNowV2 = terminateNowExit('DEGRADED', 'v2');

    assert.equal(runMainV1.status, 0, `runMain DEGRADED under v1 must be 0; stderr: ${runMainV1.stderr}`);
    assert.equal(runMainV2.status, 80, `runMain DEGRADED under v2 must be 80; stderr: ${runMainV2.stderr}`);
    assert.equal(
      terminateNowV1.status, 0,
      `terminateNow DEGRADED under v1 must be 0; stderr: ${terminateNowV1.stderr}`,
    );
    assert.equal(
      terminateNowV2.status, 80,
      `terminateNow DEGRADED under v2 must be 80; stderr: ${terminateNowV2.stderr}`,
    );
    assert.notEqual(
      runMainV1.status, runMainV2.status,
      'the matrix above is vacuous unless at least one outcome actually differs by version',
    );
  });

  test('control: a non-DEGRADED outcome (FAIL) stays version-invariant via ambient GSD_EXIT_CONTRACT', () => {
    const runMainV1 = runMainExit('FAIL', 'v1');
    const runMainV2 = runMainExit('FAIL', 'v2');
    assert.equal(runMainV1.status, 1);
    assert.equal(runMainV2.status, 1);
  });
});

// ─── #3906 acceptance criterion, made executable ────────────────────────────
//
// "user can run the gsd-tools command with --exit-contract=v2 (or
// GSD_EXIT_CONTRACT=v2 in the environment) and observe the v2 registry
// projection on the exit status; absent both, the same command yields the v1
// integers." Nothing in the module wired the ambient process to the
// terminators before this: getContractVersion() only ever read the shared
// cell, and nothing populated that cell absent an explicit
// resolveContractVersion()/setContractVersion() call — so a bare
// `GSD_EXIT_CONTRACT=v2 node -e "...terminateNow('DEGRADED')..."` exited 0,
// not 80. These tests spawn a fresh child per case (a fresh process has an
// empty cell) and touch NOTHING but the documented public surface.
describe('#3906: ambient GSD_EXIT_CONTRACT/--exit-contract wiring (acceptance criterion)', () => {
  test('terminateNow: GSD_EXIT_CONTRACT=v2 -> DEGRADED exits 80', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('DEGRADED', {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' } }));
    assert.equal(r.status, 80, `stderr: ${r.stderr}`);
  });

  test('terminateNow: no env, no flag -> DEGRADED exits 0 (v1 default unchanged)', () => {
    const env = { ...process.env };
    delete env.GSD_EXIT_CONTRACT;
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('DEGRADED', {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('runMain: GSD_EXIT_CONTRACT=v2 -> DEGRADED exits 80', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.runMain(() => 'DEGRADED');`,
      `setImmediate(() => {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' } }));
    assert.equal(r.status, 80, `stderr: ${r.stderr}`);
  });

  test('runMain: no env, no flag -> DEGRADED exits 0 (v1 default unchanged)', () => {
    const env = { ...process.env };
    delete env.GSD_EXIT_CONTRACT;
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.runMain(() => 'DEGRADED');`,
      `setImmediate(() => {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });

  // `node -e "<script>" --exit-contract=v2` makes NODE itself consume the
  // trailing flag (Node's own CLI parser reports an unknown-option usage
  // error, exit 9) rather than leaving it in the CHILD's process.argv. A
  // real CLI entrypoint is invoked as `node <file> --exit-contract=v2`, so
  // the flag path is proven with a real temp script file, not `-e`.
  test('flag path: node <file> --exit-contract=v2 -> terminateNow DEGRADED exits 80', (t) => {
    const dir = createTempDir('gsd-3906-flag-');
    t.after(() => cleanup(dir));
    const scriptPath = path.join(dir, 'terminate-degraded.cjs');
    fs.writeFileSync(scriptPath, [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('DEGRADED', {});`,
      '',
    ].join('\n'));
    const env = { ...process.env };
    delete env.GSD_EXIT_CONTRACT;
    const r = toLegacyResult(runNode([scriptPath, '--exit-contract=v2'], { timeoutMs: PROBE_TIMEOUT_MS, env }));
    assert.equal(r.status, 80, `stderr: ${r.stderr}`);
  });

  test('flag path: node <file> with no flag -> terminateNow DEGRADED exits 0', (t) => {
    const dir = createTempDir('gsd-3906-flag-');
    t.after(() => cleanup(dir));
    const scriptPath = path.join(dir, 'terminate-degraded.cjs');
    fs.writeFileSync(scriptPath, [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('DEGRADED', {});`,
      '',
    ].join('\n'));
    const env = { ...process.env };
    delete env.GSD_EXIT_CONTRACT;
    const r = toLegacyResult(runNode([scriptPath], { timeoutMs: PROBE_TIMEOUT_MS, env }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });

  // setContractVersion itself is internal (not exported); resolveContractVersion
  // is the module's own sanctioned way to write an explicit version into the
  // shared cell, and it is what this precedence rests on: getContractVersion's
  // lazy ambient-resolution path must be skipped entirely once the cell is
  // already populated, so a later read of GSD_EXIT_CONTRACT must NOT unseat it.
  test('an explicit resolveContractVersion() call beats a later ambient GSD_EXIT_CONTRACT read (precedence)', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.resolveContractVersion({ argv: ['node','x','--exit-contract=v1'], env: {} });`,
      `c.terminateNow('DEGRADED', {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v2' } }));
    assert.equal(
      r.status, 0,
      `an explicit resolveContractVersion('v1') call must beat a later ambient GSD_EXIT_CONTRACT=v2 read; stderr: ${r.stderr}`,
    );
  });

  test('GSD_EXIT_CONTRACT=v3 (invalid) still THROWS on the lazy ambient path, never silently v1 (runMain: generic-throw arm, exit 1)', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.runMain(() => 'DEGRADED');`,
      `setImmediate(() => {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v3' } }));
    assert.equal(r.status, 1, `expected the generic-throw exit code 1; stderr: ${r.stderr}`);
    assert.ok(
      /unrecognized exit-contract version/.test(r.stderr),
      `expected the resolveContractVersion rejection message on stderr; got: ${r.stderr.slice(0, 300)}`,
    );
  });

  // #3906 follow-up (P7/#3911 hardening): terminateNow is TOTAL — unlike
  // runMain above, an invalid ambient contract version must NOT propagate a
  // throw at all (an enforcement-hook caller's own outer catch could turn
  // that into a fail-open exit 0). It must terminate deterministically with
  // INTERNAL (70) and diagnose on stderr instead.
  test('terminateNow: GSD_EXIT_CONTRACT=v3 (invalid) exits 70 (INTERNAL), not silently v1 and not a propagated throw', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('DEGRADED', {});`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v3' } }));
    assert.equal(r.status, 70, `expected INTERNAL (70); stderr: ${r.stderr}`);
    assert.ok(
      /unrecognized exit-contract version/.test(r.stderr),
      `expected the resolveContractVersion rejection message on stderr; got: ${r.stderr.slice(0, 300)}`,
    );
  });
});

describe('#3906: terminateNow', () => {
  function spawnTerminateNow(lines) {
    return toLegacyResult(runNode(['-e', lines.join('\n')], { timeoutMs: PROBE_TIMEOUT_MS }));
  }

  test('HOOK_DENY exits 2 with the payload written to stdout', () => {
    const r = spawnTerminateNow([
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('HOOK_DENY', { reason: 'blocked-by-guard', detail: 'x' });`,
    ]);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout), { reason: 'blocked-by-guard', detail: 'x' });
  });

  test('HOOK_DENY writes the SAME payload to both stdout and stderr (Kimi reads exit-2 output from stderr)', () => {
    const r = spawnTerminateNow([
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('HOOK_DENY', { reason: 'blocked' });`,
    ]);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout), { reason: 'blocked' });
    assert.deepEqual(JSON.parse(r.stderr), { reason: 'blocked' });
  });

  test('a non-deny outcome writes stdout only, not stderr', () => {
    const r = spawnTerminateNow([
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('FAIL', { reason: 'not-a-deny' });`,
    ]);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { reason: 'not-a-deny' });
    assert.equal(r.stderr, '');
  });

  // Cross-platform IO-failure injection: a monkeypatched THROWING fs.writeSync,
  // restored implicitly by process exit — never chmod (CONTRIBUTING.md /
  // CLAUDE.md: mode-bit tricks are bypassed by root/CI and leak resources).
  test('a failed write still exits with the projected code (the fail-open control)', () => {
    const r = spawnTerminateNow([
      `const fs = require('node:fs');`,
      `fs.writeSync = () => { throw new Error('injected write failure'); };`,
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('FAIL', { reason: 'x' });`,
    ]);
    assert.equal(r.status, 1, 'the exit code must still be the projected one, not corrupted by the write failure');
    assert.equal(r.stdout, '', 'nothing could be written, so stdout must be empty (not a partial payload)');
  });

  test('a failed write still exits 2 for a deny, including the stderr write attempt', () => {
    const r = spawnTerminateNow([
      `const fs = require('node:fs');`,
      `fs.writeSync = () => { throw new Error('injected write failure'); };`,
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('HOOK_DENY', { reason: 'x' });`,
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('does not return: nothing after the call executes', () => {
    const r = spawnTerminateNow([
      `const fs = require('node:fs');`,
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('PASS', { ok: true });`,
      `fs.writeSync(1, 'SHOULD_NEVER_APPEAR');`,
    ]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, JSON.stringify({ ok: true }));
    assert.ok(!r.stdout.includes('SHOULD_NEVER_APPEAR'), `code after terminateNow must never run; got: ${r.stdout}`);
  });

  test('a large payload (bigger than a pipe buffer) arrives whole', () => {
    // 256KB comfortably exceeds every common OS pipe-buffer size (64KB on
    // Linux, 16 pages, is the largest common default), so a single
    // fs.writeSync call is very likely to under-write without the
    // write-until-drained loop.
    const bigString = 'x'.repeat(256 * 1024);
    const r = spawnTerminateNow([
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `c.terminateNow('PASS', { big: ${JSON.stringify(bigString)} });`,
    ]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.big.length, bigString.length, 'the payload must arrive byte-for-byte whole, not truncated');
    assert.equal(parsed.big, bigString);
  });

  // ── terminateNow is TOTAL: no input can make it return or throw ──────────
  //
  // P7 (#3911) wires 19 enforcement hooks onto terminateNow, and hooks are
  // exactly the callers whose OWN outer catch may fail open
  // (`process.exit(0)`). If any of these malformed-call paths propagated a
  // throw instead of terminating, unwinding into that catch would silently
  // convert a deny into an allow — the regression this block exists to pin.
  describe('terminateNow is total: no input can make it return or throw', () => {
    test('an unregistered outcome name exits 70 (INTERNAL), with a stderr diagnostic naming it, and nothing after the call runs', () => {
      const r = spawnTerminateNow([
        `const fs = require('node:fs');`,
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('NOT_A_REGISTERED_OUTCOME', {});`,
        `fs.writeSync(1, 'SHOULD_NEVER_APPEAR');`,
      ]);
      assert.equal(r.status, 70, `expected INTERNAL (70); stderr: ${r.stderr}`);
      assert.ok(
        r.stderr.includes('NOT_A_REGISTERED_OUTCOME'),
        `expected the diagnostic to name the offending outcome; got: ${r.stderr}`,
      );
      assert.ok(!r.stdout.includes('SHOULD_NEVER_APPEAR'), `code after terminateNow must never run; got: ${r.stdout}`);
    });

    test('an empty-string outcome exits 70', () => {
      const r = spawnTerminateNow([
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('', {});`,
      ]);
      assert.equal(r.status, 70, `expected INTERNAL (70); stderr: ${r.stderr}`);
    });

    test('a null outcome exits 70', () => {
      const r = spawnTerminateNow([
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow(null, {});`,
      ]);
      assert.equal(r.status, 70, `expected INTERNAL (70); stderr: ${r.stderr}`);
    });

    test('FAIL under an invalid ambient GSD_EXIT_CONTRACT=v3 exits 70, not a Node crash and not a silent v1', () => {
      const r = toLegacyResult(runNode(['-e', [
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('FAIL', {});`,
      ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_EXIT_CONTRACT: 'v3' } }));
      assert.equal(r.status, 70, `expected INTERNAL (70), not a Node crash / silent v1; stderr: ${r.stderr}`);
      assert.notEqual(r.status, 1, 'FAIL under a valid v1 resolution would exit 1 — 70 proves the invalid version was not silently accepted as v1');
    });

    // The regression that matters: a caller-side outer catch that fails open
    // (process.exit(0)) must NEVER be reached. Written so it would FAIL
    // against the previous implementation, where the HOOK_DENY collision
    // guard's throw (and the other two throw sites) propagated out of
    // terminateNow and into this exact catch, exiting 0.
    test('the fail-open control: a try/catch wrapper around terminateNow that exits 0 on catch must still see exit 70, never 0', () => {
      const r = spawnTerminateNow([
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `try {`,
        `  c.terminateNow('BOGUS', {});`,
        `} catch {`,
        `  process.exit(0);`,
        `}`,
      ]);
      assert.equal(
        r.status, 70,
        `the outer catch must NEVER be reached (which would exit 0); got ${r.status}, stderr: ${r.stderr}`,
      );
      assert.notEqual(r.status, 0, 'a fail-open exit 0 here would mean a deny silently became an allow');
    });

    test('existing valid-outcome behaviour is unchanged: HOOK_DENY still exits 2, UNAVAILABLE still exits 69', () => {
      const deny = spawnTerminateNow([
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('HOOK_DENY', { reason: 'still-blocked' });`,
      ]);
      assert.equal(deny.status, 2, `stderr: ${deny.stderr}`);

      const unavailable = spawnTerminateNow([
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('UNAVAILABLE', { reason: 'still-unavailable' });`,
      ]);
      assert.equal(unavailable.status, 69, `stderr: ${unavailable.stderr}`);
    });

    test('a throwing fs.writeSync for a VALID outcome still exits with the projected code, not 70', () => {
      const r = spawnTerminateNow([
        `const fs = require('node:fs');`,
        `fs.writeSync = () => { throw new Error('injected write failure'); };`,
        `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
        `c.terminateNow('FAIL', { reason: 'x' });`,
      ]);
      assert.equal(
        r.status, 1,
        `a failed payload write must still exit with the PROJECTED code (1 for FAIL), not fall into the ` +
        `programming-error path (70); stderr: ${r.stderr}`,
      );
    });
  });
});

describe('#3906: runMain stays drain-then-exit (the reason two terminators exist)', () => {
  test('process.on(\'exit\') still fires, and a pending timer is allowed to run before exit', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const fs = require('node:fs');`,
      `const c = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `process.on('exit', () => { fs.writeSync(1, 'ON_EXIT_FIRED\\n'); });`,
      `setTimeout(() => { fs.writeSync(1, 'TIMER_FIRED\\n'); }, 20);`,
      `c.runMain(() => 'FAIL');`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS }));

    assert.equal(r.status, 1, `expected exit 1 from FAIL; stderr: ${r.stderr}`);
    // If runMain had hard-exited (like terminateNow), the 20ms timer below
    // would never have gotten to run — proving the process instead drained
    // its event loop naturally (process.exitCode, never process.exit).
    assert.ok(r.stdout.includes('TIMER_FIRED'), `pending timer must run before exit; got: ${JSON.stringify(r.stdout)}`);
    assert.ok(r.stdout.includes('ON_EXIT_FIRED'), `'exit' handler must fire; got: ${JSON.stringify(r.stdout)}`);
    assert.ok(
      r.stdout.indexOf('TIMER_FIRED') < r.stdout.indexOf('ON_EXIT_FIRED'),
      `the timer must fire BEFORE the 'exit' handler; got: ${JSON.stringify(r.stdout)}`,
    );
  });
});

describe('#3906: cross-copy — the built copy and the scripts copy agree', () => {
  test('projectOutcome agrees across both copies for every outcome/version', () => {
    const built = require(BUILT_CLI_EXIT_PATH);
    const scripts = require(SCRIPTS_CLI_EXIT_PATH);
    for (const version of VERSIONS) {
      for (const outcome of ['PASS', 'FAIL', ...REGISTERED_NAMES]) {
        assert.equal(
          built.projectOutcome(outcome, version), scripts.projectOutcome(outcome, version),
          `built vs scripts disagree for ${outcome}/${version}`,
        );
      }
    }
  });

  test('scripts/lib/cli-exit.cjs + its sibling exit-code-registry.cjs load standalone, no gsd-core sibling', (t) => {
    const dir = createTempDir('gsd-3906-standalone-');
    t.after(() => cleanup(dir));
    const copiedExit = path.join(dir, 'cli-exit.cjs');
    const copiedRegistry = path.join(dir, 'exit-code-registry.cjs');
    fs.copyFileSync(SCRIPTS_CLI_EXIT_PATH, copiedExit);
    fs.copyFileSync(path.resolve(__dirname, '../scripts/lib/exit-code-registry.cjs'), copiedRegistry);

    // This directory contains ONLY these two files — no node_modules, no
    // gsd-core sibling. A successful load here is the behavioral proof (per
    // CONTRIBUTING.md's ban on source-grepping a generated .cjs for its
    // require() specifiers) that this module's only dependencies are
    // node: builtins plus ./exit-code-registry.cjs: anything else would
    // MODULE_NOT_FOUND in this exact isolation.
    const r = toLegacyResult(runNode(['-e', [
      `const c = require(${JSON.stringify(copiedExit)});`,
      `process.stdout.write(JSON.stringify({`,
      `  degradedV2: c.projectOutcome('DEGRADED', 'v2'),`,
      `  hasTerminateNow: typeof c.terminateNow,`,
      `  hasRunMain: typeof c.runMain,`,
      `}));`,
    ].join('\n')], { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }));

    assert.ok(!r.stderr.includes('MODULE_NOT_FOUND'), `unexpected require failure; stderr: ${r.stderr}`);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { degradedV2: 80, hasTerminateNow: 'function', hasRunMain: 'function' });
  });

  test('the contract-version cell is shared across both copies', () => {
    const r = toLegacyResult(runNode(['-e', [
      `const built = require(${JSON.stringify(BUILT_CLI_EXIT_PATH)});`,
      `const scripts = require(${JSON.stringify(SCRIPTS_CLI_EXIT_PATH)});`,
      `if (built === scripts) throw new Error('expected two distinct module instances');`,
      `built.resolveContractVersion({ argv: ['node','x','--exit-contract=v2'], env: {} });`,
      `process.stdout.write(JSON.stringify({`,
      `  built: built.getContractVersion(),`,
      `  scripts: scripts.getContractVersion(),`,
      `}));`,
    ].join('\n')], { timeoutMs: PROBE_TIMEOUT_MS }));

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(
      JSON.parse(r.stdout),
      { built: 'v2', scripts: 'v2' },
      'both copies must read the version resolved through only ONE of them — two independent cells would diverge here',
    );
  });
});
