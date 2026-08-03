'use strict';

/**
 * Unit tests for the gate-predicate evaluator (pure core) — issue #2008.
 *
 * The evaluator is a pure, deps-injected function:
 *   evaluatePredicate(predicate, context, deps) -> { block, message, details? }
 * Malformed predicates / unknown kinds THROW (the CLI wrapper maps a throw to a
 * check-command failure so the workflow's `onError` step-1 contract applies).
 *
 * Built-in kind: `command-exit-zero` — runs a declared command via an injected
 * bounded-shell seam; exit 0 => pass, non-zero => block, timeout => block.
 *
 * Per RULESET.TESTS.boundary-coverage: exit code boundary (0/1/2), timedOut
 * true/false, message-trim boundary (MAX / MAX+1), timeout pass-through.
 * Per RULESET.TESTS.property-based: interpolation bijection property (fast-check).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  evaluatePredicate,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
} = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');

// ─── Fake bounded-shell seam ──────────────────────────────────────────────────

/** Build a fake runBoundedShell that records the invocation and returns a preset result. */
function fakeShell(preset) {
  const calls = [];
  const run = (opts) => {
    calls.push(opts);
    return {
      exitCode: preset.exitCode ?? 0,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      signal: preset.signal ?? null,
      timedOut: preset.timedOut ?? false,
    };
  };
  return { run, calls };
}

const baseCtx = { cwd: '/proj', phaseNumber: '03', phaseDir: '/proj/.planning/phases/03-x', phaseReqIds: 'R-1' };

// ─── command-exit-zero: exit-code boundary (0 / 1 / 2) ─────────────────────────

describe('evaluatePredicate — command-exit-zero exit mapping', () => {
  test('exit 0 => block:false (gate passes)', () => {
    const shell = fakeShell({ exitCode: 0 });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, false);
    assert.match(res.message, /exit/i);
  });

  test('exit 1 => block:true', () => {
    const shell = fakeShell({ exitCode: 1, stderr: 'boom' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'false' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
    assert.match(res.message, /boom/);
  });

  test('exit 2 => block:true (boundary above 1)', () => {
    const shell = fakeShell({ exitCode: 2 });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'bad' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
  });

  test('exit 127 (ENOENT) => block:true, surfaces not-found', () => {
    const shell = fakeShell({ exitCode: 127, stderr: 'sh: not found' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'nope' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /not found|127/);
  });

  test('non-zero exit with empty stderr still yields a block message', () => {
    const shell = fakeShell({ exitCode: 3, stderr: '', stdout: '' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /3/);
  });
});

// ─── timeout ──────────────────────────────────────────────────────────────────

describe('evaluatePredicate — command-exit-zero timeout', () => {
  test('timedOut => block:true with timed-out message', () => {
    const shell = fakeShell({ timedOut: true, exitCode: null, signal: 'SIGTERM' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'sleep 100', timeout: 5 },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /timed out|timeout/i);
  });

  test('default timeout applied when predicate.timeout absent', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].timeoutMs, COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS);
  });

  test('custom timeout (seconds) honored and converted to ms', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true', timeout: 90 },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].timeoutMs, 90_000);
  });
});

// ─── interpolation ────────────────────────────────────────────────────────────

describe('evaluatePredicate — interpolation', () => {
  test('${PHASE_DIR}, ${PHASE_NUMBER}, ${PHASE_REQ_IDS} are substituted', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check ${PHASE_DIR} ${PHASE_NUMBER} ${PHASE_REQ_IDS}' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(
      shell.calls[0].command,
      'check /proj/.planning/phases/03-x 03 R-1',
    );
  });

  test('undefined context var => empty string (no leftover placeholder)', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check ${PHASE_REQ_IDS}' },
      { cwd: '/proj' },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check ');
  });

  test('foreign ${HOME} placeholder left untouched (shell interprets)', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'echo ${HOME}' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'echo ${HOME}');
  });
});

// ─── output trimming ──────────────────────────────────────────────────────────

describe('evaluatePredicate — message trimming', () => {
  test('stderr longer than COMMAND_MAX_OUTPUT_CHARS is trimmed', () => {
    const long = 'E'.repeat(COMMAND_MAX_OUTPUT_CHARS + 50);
    const shell = fakeShell({ exitCode: 1, stderr: long });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.equal(res.message.length, COMMAND_MAX_OUTPUT_CHARS);
  });

  test('stderr exactly at COMMAND_MAX_OUTPUT_CHARS is not trimmed (boundary)', () => {
    const exact = 'E'.repeat(COMMAND_MAX_OUTPUT_CHARS);
    const shell = fakeShell({ exitCode: 1, stderr: exact });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.message.length, COMMAND_MAX_OUTPUT_CHARS);
  });
});

// ─── malformed predicate / fail-closed ────────────────────────────────────────

describe('evaluatePredicate — malformed predicate throws (maps to check-cmd failure)', () => {
  test('missing command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('non-string command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 42 }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('empty-string command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: '   ' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('oversized command throws (ARGV-overflow guard)', () => {
    const huge = 'a'.repeat(COMMAND_MAX_LENGTH + 1);
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: huge }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /max length/i,
    );
  });

  test('non-positive timeout throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: 0 }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: -5 }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
  });

  test('non-finite timeout throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: 'forever' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
  });

  test('unknown kind throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'no-such-kind', command: 'x' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /kind|unknown|no-such-kind/i,
    );
  });

  test('predicate not an object throws', () => {
    assert.throws(
      () => evaluatePredicate('nope', baseCtx, { runBoundedShell: fakeShell({}).run }),
      /predicate/i,
    );
  });
});

// ─── contract surface ─────────────────────────────────────────────────────────

describe('evaluatePredicate — exported contract surface', () => {
  test('EVALUATOR_KINDS advertises every built-in predicate kind', () => {
    assert.ok(Array.isArray(EVALUATOR_KINDS));
    assert.ok(EVALUATOR_KINDS.includes('command-exit-zero'));
    assert.ok(EVALUATOR_KINDS.includes('artifact-frontmatter-equals'));
  });

  test('default timeout is 30s', () => {
    assert.equal(COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS, 30_000);
  });

  test('cwd is passed through to the shell seam', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      { cwd: '/custom/proj' },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].cwd, '/custom/proj');
  });
});

// ─── property-based: interpolation bijection on non-placeholder strings ───────

describe('evaluatePredicate — interpolation property (fast-check)', () => {
  test('strings without the 3 placeholders pass through unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((s) => s.trim().length > 0 && !/\$\{(PHASE_NUMBER|PHASE_DIR|PHASE_REQ_IDS)\}/.test(s)),
        (cmd) => {
        const shell = fakeShell({ exitCode: 0 });
        evaluatePredicate(
          { kind: 'command-exit-zero', command: cmd },
          baseCtx,
          { runBoundedShell: shell.run },
        );
        // sh -c receives exactly the input; only the 3 known placeholders would have been rewritten.
        assert.equal(shell.calls[0].command, cmd);
      }),
      { numRuns: 100 },
    );
  });

  test('every placeholder is fully replaced (no leftover ${PHASE_*})', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (noise) => {
        const cmd = `${noise} ${noise}`;
        const shell = fakeShell({ exitCode: 0 });
        evaluatePredicate(
          { kind: 'command-exit-zero', command: `\${PHASE_DIR}${cmd}\${PHASE_NUMBER}` },
          baseCtx,
          { runBoundedShell: shell.run },
        );
        assert.doesNotMatch(shell.calls[0].command, /\$\{PHASE_(DIR|NUMBER|REQ_IDS)\}/);
      }),
      { numRuns: 100 },
    );
  });
});
