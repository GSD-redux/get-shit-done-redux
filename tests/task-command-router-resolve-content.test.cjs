'use strict';

/**
 * Tests for `task resolve-content` (ADR-3646 Decision 2, issue #3970).
 * Covers test matrix rows 17-19:
 *   17 — plan exists, task-id not found in it -> USAGE, non-zero exit.
 *   18 — end-to-end happy path via injected `resolveTaskContentFn`.
 *   19 — missing --plan and/or --task-id -> USAGE, before any filesystem access.
 * Plus the hard-halt path: a thrown resolver-error class must surface as a
 * non-zero CLI exit, never a swallowed `{resolved:false}` JSON answer.
 *
 * In-process style (routeResolveContent's own `_`-prefixed-equivalent
 * `deps` injection seam), mirroring `refactor-trigger-command-router.cts`'s
 * injection convention — no subprocess spawn needed for these rows.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, captureFdSync } = require('./helpers.cjs');

const { routeResolveContent } = require('../gsd-core/bin/lib/task-command-router.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');
const {
  ResolverFailedError,
} = require('../gsd-core/bin/lib/task-content-resolution.cjs');

function writePlan(dir, taskXml) {
  const planPath = path.join(dir, '01-PLAN.md');
  fs.writeFileSync(planPath, `# Plan\n\n${taskXml}\n`, 'utf8');
  return planPath;
}

/**
 * `io.cjs`'s `output()` writes to fd 1 via `fs.writeSync` directly (never
 * `process.stdout.write`) — see `writeAllSync` in
 * `gsd-core/bin/lib/io.cjs`. Capture fd-1 writes by mocking `fs.writeSync`
 * itself; every other fd passes through to the real implementation
 * unmocked (so the plan-file reads and any other fs traffic inside a test
 * body still work).
 */
function captureStdout(fn) {
  return captureFdSync(1, fn);
}

/**
 * `io.cjs`'s `error()` (ADR-3889) writes its human-readable message to fd 2
 * via `writeAllSync`, then throws a bare `new ExitError(1)` with NO message
 * — the stderr write already happened, so the thrown Error's own `.message`
 * defaults to `"process exit ${code}"` (see `cli-exit.cjs`'s `ExitError`
 * constructor) and never carries the diagnostic text. Asserting against
 * `err.message` therefore can never see the "outside project scope" text;
 * the diagnostic must be read off the captured fd-2 bytes instead. Mirrors
 * the same fd-mock idiom `captureStdout` above uses for fd 1, and the
 * established repo pattern in `tests/estimate-calibrate.test.cjs`'s
 * `runCalibrateExpectError`.
 */
function captureStderr(fn) {
  return captureFdSync(2, fn);
}

const RESOLVABLE_TASK = '<task type="auto" tracker-id="test:1"><name>x</name><action>do the thing</action></task>';

describe('task resolve-content (rows 17-19)', () => {
  test('row 19: missing --plan and --task-id -> USAGE, no filesystem access', (t) => {
    const dir = createTempDir('gsd-resolve-content-19-');
    t.after(() => cleanup(dir));
    const readMock = require('node:test').mock.method(fs, 'readFileSync', () => {
      throw new Error('must not read the filesystem before usage validation');
    });
    t.after(() => readMock.mock.restore());

    assert.throws(
      () => routeResolveContent({ args: ['task', 'resolve-content'], cwd: dir, raw: false }),
      ExitError,
    );
  });

  test('row 19: missing --task-id only -> USAGE', (t) => {
    const dir = createTempDir('gsd-resolve-content-19b-');
    t.after(() => cleanup(dir));
    writePlan(dir, RESOLVABLE_TASK);
    assert.throws(
      () =>
        routeResolveContent({
          args: ['task', 'resolve-content', '--plan', '01-PLAN.md'],
          cwd: dir,
          raw: false,
        }),
      ExitError,
    );
  });

  test('row 17: plan exists, task-id not found -> USAGE, non-zero exit', (t) => {
    const dir = createTempDir('gsd-resolve-content-17-');
    t.after(() => cleanup(dir));
    writePlan(dir, RESOLVABLE_TASK);

    assert.throws(
      () =>
        routeResolveContent({
          args: ['task', 'resolve-content', '--plan', '01-PLAN.md', '--task-id', 'nope:999'],
          cwd: dir,
          raw: false,
        }),
      (err) => {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${err}`);
        assert.strictEqual(err.code, 1);
        return true;
      },
    );
  });

  test('row 18: end-to-end happy path, resolved:true content shape', (t) => {
    const dir = createTempDir('gsd-resolve-content-18-');
    t.after(() => cleanup(dir));
    writePlan(dir, RESOLVABLE_TASK);

    const fakeCapabilities = [
      {
        id: 'fake-tracker',
        taskContentResolver: {
          trackerPrefix: 'test',
          invoke: { binary: 'fake-cli', args: ['show', '{{id}}'], timeoutMs: 5000 },
        },
      },
    ];

    let capturedInvocation = null;
    const resolveTaskContentFn = (input) => {
      capturedInvocation = input;
      return {
        kind: 'resolved',
        content: {
          action: 'do the resolved thing',
          verify: 'run the resolved verify',
          acceptanceCriteria: ['criterion a'],
          readFirst: ['README.md'],
          done: 'done marker',
        },
      };
    };

    const stdout = captureStdout(() => {
      routeResolveContent(
        {
          args: ['task', 'resolve-content', '--plan', '01-PLAN.md', '--task-id', 'test:1'],
          cwd: dir,
          raw: true,
        },
        { loadCapabilities: () => fakeCapabilities, resolveTaskContentFn },
      );
    });

    assert.strictEqual(capturedInvocation.trackerId, 'test:1');
    assert.deepStrictEqual(capturedInvocation.capabilities, fakeCapabilities);

    const printed = JSON.parse(stdout);
    assert.strictEqual(printed.resolved, true);
    assert.strictEqual(printed.content.action, 'do the resolved thing');
    assert.strictEqual(printed.content.verify, 'run the resolved verify');
    assert.deepStrictEqual(printed.content.acceptanceCriteria, ['criterion a']);
    assert.deepStrictEqual(printed.content.readFirst, ['README.md']);
    assert.strictEqual(printed.content.done, 'done marker');
  });

  test('hard-halt: a thrown ResolverFailedError becomes a non-zero exit, never {resolved:false}', (t) => {
    const dir = createTempDir('gsd-resolve-content-hardhalt-');
    t.after(() => cleanup(dir));
    writePlan(dir, RESOLVABLE_TASK);

    const fakeCapabilities = [
      {
        id: 'fake-tracker',
        taskContentResolver: {
          trackerPrefix: 'test',
          invoke: { binary: 'fake-cli', args: ['show', '{{id}}'], timeoutMs: 5000 },
        },
      },
    ];

    let thrown = null;
    const stdout = captureStdout(() => {
      try {
        routeResolveContent(
          {
            args: ['task', 'resolve-content', '--plan', '01-PLAN.md', '--task-id', 'test:1'],
            cwd: dir,
            raw: true,
          },
          {
            loadCapabilities: () => fakeCapabilities,
            resolveTaskContentFn: () => {
              throw new ResolverFailedError('fake-cli', 1, 'boom');
            },
          },
        );
      } catch (err) {
        thrown = err;
      }
    });
    assert.ok(thrown instanceof ExitError, `expected ExitError, got ${thrown}`);
    assert.strictEqual(stdout, '', 'resolver failure must never write a JSON {resolved:false} answer to stdout');
  });

  test('path traversal: --plan escaping the project root -> USAGE, non-zero exit, no filesystem read', (t) => {
    const dir = createTempDir('gsd-resolve-content-traversal-');
    t.after(() => cleanup(dir));

    const escapingPath = '../../../etc/passwit';
    let thrown = null;
    const stderr = captureStderr(() => {
      try {
        routeResolveContent({
          args: ['task', 'resolve-content', '--plan', escapingPath, '--task-id', 'test:1'],
          cwd: dir,
          raw: false,
        });
      } catch (err) {
        thrown = err;
      }
    });
    assert.ok(thrown instanceof ExitError, `expected ExitError, got ${thrown}`);
    assert.strictEqual(thrown.code, 1);
    assert.ok(
      stderr.includes('outside project scope') && stderr.includes(escapingPath),
      `expected an outside-project-scope rejection naming the path on stderr, got: ${stderr}`,
    );
  });

  test('not-applicable: task-id with no ":" -> {resolved:false}, no reason field', (t) => {
    const dir = createTempDir('gsd-resolve-content-na-');
    t.after(() => cleanup(dir));
    writePlan(dir, '<task type="auto" tracker-id="notrackerprefix"><name>y</name></task>');

    const stdout = captureStdout(() => {
      routeResolveContent(
        {
          args: ['task', 'resolve-content', '--plan', '01-PLAN.md', '--task-id', 'notrackerprefix'],
          cwd: dir,
          raw: true,
        },
        { loadCapabilities: () => [] },
      );
    });
    const printed = JSON.parse(stdout);
    assert.deepStrictEqual(printed, { resolved: false });
  });
});
