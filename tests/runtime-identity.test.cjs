'use strict';

/**
 * #3146 — runtime identity assertion.
 *
 * Two surfaces are under test:
 *   1. `classifyIdentityProbe` / `buildIdentityPayload` — the pure classifier
 *      and payload builder (the defect-dense part).
 *   2. The launcher preamble's shell check — the part that actually protects a
 *      workflow, because it runs on the CALLER side before a mutating verb.
 *
 * The preamble tests are behavioral: they stand up a fake `gsd-tools` on PATH
 * and assert on what the preamble does, never on the snippet's text.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode, runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  classifyIdentityProbe,
  buildIdentityPayload,
  explainVerdict,
  EXPECTED_PACKAGE_NAME,
} = require('../gsd-core/bin/lib/runtime-identity.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const SNIPPET = path.join(REPO_ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');

const okStdout = (name = EXPECTED_PACKAGE_NAME, version = '1.2.3') =>
  JSON.stringify({ packageName: name, version });

describe('classifyIdentityProbe', () => {
  test('classifies our own payload as ok', () => {
    const v = classifyIdentityProbe({ stdout: okStdout(), exitCode: 0 });
    assert.equal(v.reason, 'ok');
    assert.equal(v.actual, EXPECTED_PACKAGE_NAME);
    assert.equal(v.version, '1.2.3');
  });

  test('classifies predecessor usage text as no_identity_verb', () => {
    // Shape verified against get-shit-done-cc@1.42.3: exit 1 + usage, no JSON.
    const v = classifyIdentityProbe({
      stdout: 'Usage: gsd-sdk <command> [args] [options]\n\nCommands:\n  run <prompt>',
      exitCode: 1,
    });
    assert.equal(v.reason, 'no_identity_verb');
    assert.match(v.detail, /exit 1/);
  });

  test('classifies non-JSON stdout as unparseable', () => {
    const v = classifyIdentityProbe({ stdout: 'not json at all', exitCode: 0 });
    assert.equal(v.reason, 'unparseable');
  });

  test('classifies a foreign packageName as identity_mismatch', () => {
    const v = classifyIdentityProbe({ stdout: okStdout('get-shit-done-cc'), exitCode: 0 });
    assert.equal(v.reason, 'identity_mismatch');
    assert.equal(v.actual, 'get-shit-done-cc');
  });

  test('classifies JSON without packageName as unparseable', () => {
    const v = classifyIdentityProbe({ stdout: JSON.stringify({ version: '1.0.0' }), exitCode: 0 });
    assert.equal(v.reason, 'unparseable');
  });

  // JSON.parse accepts all of these. A naive truthiness check would let `[]`
  // through as a verified identity.
  for (const [label, raw] of [
    ['number', '0'],
    ['string', '"str"'],
    ['array', '[]'],
    ['null', 'null'],
    ['boolean', 'true'],
  ]) {
    test(`classifies non-object JSON (${label}) as unparseable`, () => {
      const v = classifyIdentityProbe({ stdout: raw, exitCode: 0 });
      assert.equal(v.reason, 'unparseable');
    });
  }

  test('classifies spawn failure as probe_failed', () => {
    const v = classifyIdentityProbe({ stdout: '', exitCode: null, spawnFailed: true });
    assert.equal(v.reason, 'probe_failed');
  });

  test('classifies timeout as probe_failed without throwing', () => {
    const v = classifyIdentityProbe({ stdout: '', exitCode: null, timedOut: true });
    assert.equal(v.reason, 'probe_failed');
    assert.match(v.detail, /timed out/);
  });

  test('ignores stderr noise by construction (stdout is the only input)', () => {
    const v = classifyIdentityProbe({ stdout: okStdout(), exitCode: 0 });
    assert.equal(v.reason, 'ok');
  });

  test('parses a CRLF payload as ok', () => {
    const v = classifyIdentityProbe({ stdout: `${okStdout()}\r\n`, exitCode: 0 });
    assert.equal(v.reason, 'ok');
  });

  test('classifies empty stdout as unparseable', () => {
    assert.equal(classifyIdentityProbe({ stdout: '', exitCode: 0 }).reason, 'unparseable');
  });

  test('classifies whitespace-only stdout as unparseable', () => {
    assert.equal(classifyIdentityProbe({ stdout: '   \n\t ', exitCode: 0 }).reason, 'unparseable');
  });

  test('ignores unknown payload keys so a future field cannot fail an older check', () => {
    const stdout = JSON.stringify({
      packageName: EXPECTED_PACKAGE_NAME,
      version: '1.2.3',
      somethingAddedLater: { nested: true },
    });
    assert.equal(classifyIdentityProbe({ stdout, exitCode: 0 }).reason, 'ok');
  });

  test('is total: never throws, always yields a known reason', () => {
    const REASONS = new Set([
      'ok',
      'identity_mismatch',
      'no_identity_verb',
      'unparseable',
      'probe_failed',
    ]);
    fc.assert(
      fc.property(
        fc.string(),
        fc.oneof(fc.integer({ min: -8, max: 8 }), fc.constant(null)),
        fc.boolean(),
        fc.boolean(),
        (stdout, exitCode, spawnFailed, timedOut) => {
          const v = classifyIdentityProbe({ stdout, exitCode, spawnFailed, timedOut });
          assert.ok(REASONS.has(v.reason));
          if (v.reason === 'ok') {
            // `ok` is reachable ONLY through a well-formed exact match.
            assert.equal(exitCode, 0);
            assert.equal(spawnFailed, false);
            assert.equal(timedOut, false);
            assert.equal(JSON.parse(stdout).packageName, EXPECTED_PACKAGE_NAME);
          }
        },
      ),
      { seed: 31460, numRuns: 300 },
    );
  });

  test('truncates evidence at the 200-char boundary', () => {
    const at = classifyIdentityProbe({ stdout: 'x'.repeat(200), exitCode: 1 });
    const over = classifyIdentityProbe({ stdout: 'y'.repeat(201), exitCode: 1 });
    const under = classifyIdentityProbe({ stdout: 'z'.repeat(199), exitCode: 1 });
    assert.equal(under.detail.includes('…'), false);
    assert.equal(at.detail.includes('…'), false);
    assert.equal(over.detail.includes('…'), true);
  });

  test('rejects a decoy that embeds the expected name in another field', () => {
    const stdout = JSON.stringify({ packageName: 'get-shit-done-cc', note: EXPECTED_PACKAGE_NAME });
    assert.equal(classifyIdentityProbe({ stdout, exitCode: 0 }).reason, 'identity_mismatch');
  });
});

describe('buildIdentityPayload', () => {
  test('reports the injected version', () => {
    const p = buildIdentityPayload({ readVersion: () => '4.5.6' });
    assert.equal(p.packageName, EXPECTED_PACKAGE_NAME);
    assert.equal(p.version, '4.5.6');
  });

  test('a fail-closed 0.0.0 version still verifies (identity-only assertion)', () => {
    const p = buildIdentityPayload({ readVersion: () => '0.0.0' });
    const v = classifyIdentityProbe({ stdout: JSON.stringify(p), exitCode: 0 });
    assert.equal(v.reason, 'ok');
  });

  test('payload shape is minimal — exactly the two documented keys', () => {
    const p = buildIdentityPayload({ readVersion: () => '1.0.0' });
    assert.deepEqual(Object.keys(p).sort(), ['packageName', 'version']);
  });

});

describe('explainVerdict', () => {
  test('names both plausible causes for a missing verb', () => {
    const v = classifyIdentityProbe({ stdout: 'Usage: gsd-sdk', exitCode: 1 });
    const msg = explainVerdict(v, '/usr/local/bin/gsd-tools');
    assert.match(msg, /different package/);
    // A legitimate older gsd-core also lacks the verb — the message must say so.
    assert.match(msg, /predating the verb/);
    assert.match(msg, /\/usr\/local\/bin\/gsd-tools/);
  });

  test('names the foreign package on a mismatch', () => {
    const v = classifyIdentityProbe({ stdout: okStdout('some-other-pkg'), exitCode: 0 });
    assert.match(explainVerdict(v, '/x/gsd-tools'), /some-other-pkg/);
  });
});

describe('runtime-identity verb', () => {
  test('emits a parseable payload naming this package', () => {
    const r = runNode([GSD_TOOLS, 'runtime-identity'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.packageName, EXPECTED_PACKAGE_NAME);
    assert.equal(typeof parsed.version, 'string');
  });

  test('the real verb output classifies as ok', () => {
    const r = runNode([GSD_TOOLS, 'runtime-identity'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(classifyIdentityProbe({ stdout: r.stdout, exitCode: r.exitCode }).reason, 'ok');
  });

  test('--raw emits the same identity on a single line', () => {
    const r = runNode([GSD_TOOLS, 'runtime-identity', '--raw'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(r.stdout).packageName, EXPECTED_PACKAGE_NAME);
  });
});

describe('launcher resolver: PATH branch prefers the collision-free bin', () => {
  let dir;
  let binDir;

  // The predecessor package `get-shit-done-cc` publishes a `gsd-tools` bin but
  // NO `gsd_run`. Preferring `gsd_run` is therefore what makes the colliding
  // name unreachable from PATH — this suite pins that, and pins that we never
  // fall back to executing the foreign binary (#3146, #3129).
  const writeFake = (name, body) => {
    const p = path.join(binDir, name);
    // Absolute interpreter: env.PATH below is restricted to the fixture bin, so
    // `#!/usr/bin/env sh` could not resolve `sh` and the fake would never run.
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  const sourceAndRun = (script) => {
    const harness = path.join(dir, 'harness.sh');
    fs.writeFileSync(harness, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return runHook(harness, [], {
      // Absolute path: `env.PATH` below is deliberately restricted to the
      // fixture bin, so a bare `sh` would not resolve and the child would die
      // before sourcing anything — making every assertion here vacuous.
      interpreter: '/bin/sh',
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      // PATH holds ONLY our fixture bin, so a real gsd_run installed on the
      // developer's machine cannot silently satisfy the resolver and turn a
      // failing case green.
      env: { PATH: binDir, HOME: dir, RUNTIME_DIR: dir },
    });
  };

  const skipOnWindows = (t) => {
    if (process.platform !== 'win32') return false;
    t.skip('POSIX shell preamble is not executed on Windows runtimes');
    return true;
  };

  beforeEach(() => {
    dir = createTempDir('gsd-3146-resolver-');
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // node must be reachable without putting its real directory on PATH.
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  });

  afterEach(() => cleanup(dir));

  test('prefers gsd_run when a foreign gsd-tools is also on PATH', (t) => {
    if (skipOnWindows(t)) return;
    const ours = path.join(dir, 'OURS');
    writeFake('gsd_run', `: > "${ours}"`);
    const foreign = path.join(dir, 'FOREIGN');
    writeFake('gsd-tools', `: > "${foreign}"`);

    sourceAndRun(`. "${SNIPPET}"; gsd_run query anything`);

    assert.equal(fs.existsSync(ours), true, 'our gsd_run should have run');
    assert.equal(fs.existsSync(foreign), false, 'the foreign gsd-tools must never run');
  });

  test('never executes a foreign gsd-tools when no gsd_run is reachable', (t) => {
    if (skipOnWindows(t)) return;
    const foreign = path.join(dir, 'FOREIGN');
    writeFake('gsd-tools', `: > "${foreign}"`);

    const r = sourceAndRun(`. "${SNIPPET}"; gsd_run query anything`);

    // Fail closed: the resolver reaches its final else and errors, rather than
    // silently handing a state-mutating verb to a package it was not written for.
    assert.equal(fs.existsSync(foreign), false, 'the foreign gsd-tools must never run');
    assert.notEqual(r.exitCode, 0);
  });

  // Regression: a second source finds the `gsd_run` FUNCTION, so `command -v`
  // returns a bare name rather than a path. A revision that guarded on `-x`
  // rejected it, fell through every branch, and hit the resolver's `exit 1` —
  // which, in a SOURCED script, terminates the caller's shell. `unset -f` at
  // the top of the preamble is what makes re-sourcing idempotent instead.
  test('sourcing the preamble twice leaves a working launcher and a live shell', (t) => {
    if (skipOnWindows(t)) return;
    const ours = path.join(dir, 'OURS');
    const alive = path.join(dir, 'ALIVE');
    writeFake('gsd_run', `: > "${ours}"`);

    const r = sourceAndRun(`. "${SNIPPET}"; . "${SNIPPET}"; : > "${alive}"; gsd_run query anything`);

    assert.equal(fs.existsSync(alive), true, 'the second source must not kill the shell');
    assert.equal(fs.existsSync(ours), true, 'the launcher must still work after re-sourcing');
    assert.equal(r.exitCode, 0);
  });

  // A non-executable file named `gsd_run` must never be selected. This is what
  // makes an explicit `-x` guard unnecessary: PATH search already requires an
  // executable, so `command -v` simply does not return this file. An earlier
  // revision carried such a guard, and it caused a worse bug — on a second
  // source it rejected the shell FUNCTION's bare name and fell through to the
  // resolver's `exit 1`, which kills a SOURCED caller's shell.
  test('never selects a non-executable gsd_run, and still refuses the foreign bin', (t) => {
    if (skipOnWindows(t)) return;
    fs.writeFileSync(path.join(binDir, 'gsd_run'), 'not executable\n', { mode: 0o644 });
    const foreign = path.join(dir, 'FOREIGN');
    writeFake('gsd-tools', `: > "${foreign}"`);

    const r = sourceAndRun(`. "${SNIPPET}"; gsd_run query anything`);

    assert.equal(fs.existsSync(foreign), false, 'the foreign gsd-tools must never run');
    assert.notEqual(r.exitCode, 0, 'resolution must fail closed');
  });
});
