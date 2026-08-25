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
  statusForVerdict,
  EXPECTED_PACKAGE_NAME,
  IDENTITY_STATUS,
  IDENTITY_RAW_PREFIX,
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

  test('an empty-string packageName is unparseable, not a match', () => {
    // Distinct path from "no packageName key at all": the key is present and is
    // a string, so only the `.length > 0` guard rejects it.
    const v = classifyIdentityProbe({ stdout: '{"packageName":"","version":"1.0.0"}', exitCode: 0 });
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

  // ── Anchor parity on the classifier itself (#3841) ──────────────────────
  test('a payload that names this package but is not anchored does not verify', () => {
    const stdout = `{"note":"x","packageName":"${EXPECTED_PACKAGE_NAME}","version":"1.0.0"}`;
    const v = classifyIdentityProbe({ stdout, exitCode: 0 });
    assert.equal(v.reason, 'unparseable');
  });

  test('leading whitespace breaks the anchor', () => {
    const v = classifyIdentityProbe({ stdout: `  ${okStdout()}`, exitCode: 0 });
    assert.equal(v.reason, 'unparseable');
  });

  test('a foreign packageName is a mismatch wherever it appears in the object', () => {
    const stdout = '{"note":"x","packageName":"get-shit-done-cc"}';
    const v = classifyIdentityProbe({ stdout, exitCode: 0 });
    assert.equal(v.reason, 'identity_mismatch');
  });

  // ── Parse-before-exit-code (#3841) ──────────────────────────────────────
  // The shell preamble reads stdout only — its command substitution discards
  // the child's exit status entirely. So the classifier must reach the same
  // verdict a tool that already proved its identity and then exited non-zero
  // for an unrelated reason (a later verb failing, a warning exit, etc.).

  test('a valid payload verifies even when the probe exits non-zero', () => {
    const v = classifyIdentityProbe({ stdout: okStdout(), exitCode: 1 });
    assert.equal(v.reason, 'ok');
    assert.equal(v.actual, EXPECTED_PACKAGE_NAME);
  });

  test('a non-zero exit with a foreign payload is a mismatch, not a missing verb', () => {
    const v = classifyIdentityProbe({
      stdout: '{"packageName":"get-shit-done-cc","version":"1.0.0"}',
      exitCode: 1,
    });
    assert.equal(v.reason, 'identity_mismatch');
    assert.equal(v.actual, 'get-shit-done-cc');
  });

  // REGRESSION PIN: these pass today and must keep passing — the predecessor
  // and any answer that proves nothing still fall through to no_identity_verb.
  for (const stdout of [
    'usage: gsd-tools ...',
    '[]',
    '0',
    'null',
    '{"version":"1"}',
  ]) {
    test(`a non-zero exit that proved nothing stays no_identity_verb (${JSON.stringify(stdout)})`, () => {
      const v = classifyIdentityProbe({ stdout, exitCode: 1 });
      assert.equal(v.reason, 'no_identity_verb');
    });
  }

  test('a signal-killed probe that still proved identity verifies', () => {
    const v = classifyIdentityProbe({ stdout: okStdout(), exitCode: null });
    assert.equal(v.reason, 'ok');
  });

  test('an empty stdout is unparseable', () => {
    const v = classifyIdentityProbe({ stdout: '', exitCode: 0 });
    assert.equal(v.reason, 'unparseable');
  });

  test('spawn failure short-circuits ahead of the payload', () => {
    const spawnFailed = classifyIdentityProbe({ stdout: okStdout(), exitCode: 0, spawnFailed: true });
    assert.equal(spawnFailed.reason, 'probe_failed');
    const timedOut = classifyIdentityProbe({ stdout: okStdout(), exitCode: 0, timedOut: true });
    assert.equal(timedOut.reason, 'probe_failed');
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

// ─────────────────────────────────────────────────────────────────────────────
// #3841 — the launcher preamble ASSERTS identity before any verb runs.
//
// #3831 closed the PATH route structurally (the resolver takes `gsd_run`, which
// only this package publishes). The path-based branches — a project-local
// install, a runtime config directory — had no such guarantee: they trusted
// their configured location. These tests cover the assertion that closes them.
//
// Every shell assertion below reads the TYPED `GSD_IDENTITY_STATUS` value, never
// the warning prose: CONTRIBUTING forbids `assert.match` on process output as
// the proof a behavior fired.
// ─────────────────────────────────────────────────────────────────────────────

describe('statusForVerdict — the five-way reason collapses to two shell values', () => {
  test('only `ok` yields OK; every other reason yields UNVERIFIED', () => {
    const cases = [
      [{ stdout: JSON.stringify(buildIdentityPayload({ readVersion: () => '1.0.0' })), exitCode: 0 }, IDENTITY_STATUS.OK],
      [{ stdout: okStdout('get-shit-done-cc'), exitCode: 0 }, IDENTITY_STATUS.UNVERIFIED],
      [{ stdout: 'Usage: gsd-sdk', exitCode: 1 }, IDENTITY_STATUS.UNVERIFIED],
      [{ stdout: 'not json', exitCode: 0 }, IDENTITY_STATUS.UNVERIFIED],
      [{ stdout: '', exitCode: null, spawnFailed: true }, IDENTITY_STATUS.UNVERIFIED],
    ];
    const seen = new Set();
    for (const [probe, expected] of cases) {
      const verdict = classifyIdentityProbe(probe);
      seen.add(verdict.reason);
      assert.equal(statusForVerdict(verdict), expected, `reason ${verdict.reason}`);
    }
    // Proof of coverage: all five reason codes were actually exercised above.
    assert.equal(seen.size, 5, `expected all five reasons, saw ${[...seen].join(',')}`);
  });

  test('the status enum is frozen, so a test can bind to the value', () => {
    assert.equal(Object.isFrozen(IDENTITY_STATUS), true);
    assert.deepEqual(Object.values(IDENTITY_STATUS).sort(), ['ok', 'unverified']);
  });

  test('is total: every classifier output maps to a declared status', () => {
    const STATUSES = new Set(Object.values(IDENTITY_STATUS));
    fc.assert(
      fc.property(
        fc.string(),
        fc.oneof(fc.integer({ min: -8, max: 8 }), fc.constant(null)),
        fc.boolean(),
        fc.boolean(),
        (stdout, exitCode, spawnFailed, timedOut) => {
          const verdict = classifyIdentityProbe({ stdout, exitCode, spawnFailed, timedOut });
          const status = statusForVerdict(verdict);
          assert.ok(STATUSES.has(status));
          // OK is reachable only through a genuine match — fail-closed by default.
          if (status === IDENTITY_STATUS.OK) assert.equal(verdict.reason, 'ok');
        },
      ),
      { seed: 38410, numRuns: 300 },
    );
  });
});

describe('IDENTITY_RAW_PREFIX — the anchor the shell matches on', () => {
  // Generative-divergence guard: the shell `case` pattern and the JS payload
  // builder are two surfaces that must agree byte-for-byte. If `--raw`'s key
  // order or serialization ever changed, the preamble would silently stop
  // verifying a legitimate install and warn on every run.
  test('the real --raw payload starts with the prefix', () => {
    const r = runNode([GSD_TOOLS, 'runtime-identity', '--raw'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.startsWith(IDENTITY_RAW_PREFIX), true);
  });

  test('the prefix names this package and closes the quoted value', () => {
    assert.equal(IDENTITY_RAW_PREFIX, `{"packageName":"${EXPECTED_PACKAGE_NAME}"`);
  });
});

const skipOnWindows = (t) => {
  if (process.platform !== 'win32') return false;
  t.skip('POSIX shell preamble is not executed on Windows runtimes');
  return true;
};

/**
 * Per-describe fixture for driving the REAL launcher preamble against a fake
 * `gsd-tools`. Shared by the two describes below rather than retyped: they need
 * the same temp tree (a `bin/` holding only a `node` symlink, plus
 * `gsd-core/bin/gsd-tools.cjs`) and the same restricted-PATH invocation, and a
 * second copy is a place for the two to drift apart.
 *
 * Returns handles rather than installing its own beforeEach/afterEach, so each
 * describe keeps its own fresh state and its own lifecycle hooks.
 */
function makeIdentityFixture() {
  let dir;
  let binDir;
  let toolsDir;

  const setup = () => {
    dir = createTempDir('gsd-3841-identity-');
    binDir = path.join(dir, 'bin');
    toolsDir = path.join(dir, 'gsd-core', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  };

  const teardown = () => cleanup(dir);

  // Resolution here goes through the RUNTIME_DIR-local branch — the branch
  // #3831 could NOT make safe structurally, and therefore the one this
  // assertion exists for.
  const installFakeTool = (identityBody) => {
    fs.writeFileSync(
      path.join(toolsDir, 'gsd-tools.cjs'),
      '#!/usr/bin/env node\n' +
        "const a = process.argv.slice(2);\n" +
        "if (a[0] === 'runtime-identity') { " + identityBody + " }\n" +
        "process.stdout.write('RAN:' + a.join(',') + '\\n');\n",
      { mode: 0o755 },
    );
  };

  const sourceAndReport = (extra = '') => {
    const harness = path.join(dir, 'harness.sh');
    fs.writeFileSync(
      harness,
      '#!/bin/sh\n' +
        `. "${SNIPPET}"\n` +
        "printf 'STATUS=%s\\n' \"$GSD_IDENTITY_STATUS\"\n" +
        extra +
        '\n',
      { mode: 0o755 },
    );
    return runHook(harness, [], {
      // Absolute interpreter: env.PATH below is restricted to the fixture bin,
      // so a bare `sh` would not resolve and every assertion would be vacuous.
      interpreter: '/bin/sh',
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      // PATH holds only the fixture bin (plus a node symlink) so a real gsd_run
      // on the developer's machine cannot satisfy the resolver instead.
      env: { PATH: binDir, HOME: dir, RUNTIME_DIR: dir },
    });
  };

  return { setup, teardown, installFakeTool, sourceAndReport };
}

describe('launcher preamble: identity assertion on a path-based branch (#3841)', () => {
  const fx = makeIdentityFixture();

  beforeEach(() => fx.setup());
  afterEach(() => fx.teardown());

  const installFakeTool = (identityBody) => fx.installFakeTool(identityBody);
  const sourceAndReport = (extra = '') => fx.sourceAndReport(extra);

  const emit = (json) => `process.stdout.write(${JSON.stringify(json)} + '\\n'); process.exit(0);`;

  test('a tool that proves it is this package reports status ok', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"9.9.9"}`));

    const r = sourceAndReport();

    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.OK}`), true, r.stdout);
  });

  // ── Anchor boundary: limit-1 / limit / limit+1 on the matched prefix ───────
  // The "limit" is IDENTITY_RAW_PREFIX itself. One byte short, exact, and one
  // byte long are the three cases a substring match would get wrong.
  test('a payload one byte SHORT of the anchor does not verify (limit-1)', (t) => {
    if (skipOnWindows(t)) return;
    // Truncate the expected name by one character, then close the JSON legally.
    const short = IDENTITY_RAW_PREFIX.slice(0, IDENTITY_RAW_PREFIX.length - 2) + '"';
    assert.notEqual(short, IDENTITY_RAW_PREFIX);
    installFakeTool(emit(`${short},"version":"9.9.9"}`));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  test('the exact anchor verifies (limit)', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"0.0.0"}`));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.OK}`), true, r.stdout);
  });

  test('a payload one byte LONGER than the anchor does not verify (limit+1)', (t) => {
    if (skipOnWindows(t)) return;
    // An extra character inside the package name: `@opengsd/gsd-coreX`.
    const long = `{"packageName":"${EXPECTED_PACKAGE_NAME}X"`;
    installFakeTool(emit(`${long},"version":"9.9.9"}`));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  // ── The closing brace in the pattern is load-bearing, not cosmetic ─────────
  // The `case` pattern is anchored at BOTH ends: it starts with the prefix and
  // requires the payload to be a closed object. The trailing `'}'` also happens
  // to balance the literal `{` for the raw-text brace guards the preamble is
  // inlined into (see runtime-launcher-parity (F0)) — but it is asserted here
  // because it does real work. Delete it and these two tests go red.
  test('a truncated payload does not verify even though its prefix matches', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"9.9.9"`));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  test('trailing garbage after the closing brace does not verify', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"9.9.9"} and then some`));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  // Negative space for the two above: closing-brace anchoring must not reject a
  // legitimate FUTURE payload. A JSON object's own `}` is always the last
  // character regardless of the last value's type, so additive fields are safe.
  for (const [label, extraKey] of [
    ['a nested object', { extra: { a: [1, 2] } }],
    ['an array-valued last key', { tags: ['x'] }],
  ]) {
    test(`an additive payload ending in ${label} still verifies`, (t) => {
      if (skipOnWindows(t)) return;
      installFakeTool(emit(JSON.stringify({
        packageName: EXPECTED_PACKAGE_NAME,
        version: '1.0.0',
        ...extraKey,
      })));

      const r = sourceAndReport();

      assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.OK}`), true, r.stdout);
    });
  }

  test('the anchor rejects a decoy that carries the name in a later field', (t) => {
    if (skipOnWindows(t)) return;
    // An UNANCHORED substring match accepts this. That is the whole point of
    // anchoring: the decoy is trivially publishable by a colliding package.
    installFakeTool(emit(JSON.stringify({ packageName: 'get-shit-done-cc', note: EXPECTED_PACKAGE_NAME })));

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  test('a tool with no runtime-identity verb does not verify and does not kill the run', (t) => {
    if (skipOnWindows(t)) return;
    // Shape of the real predecessor: usage screen, exit 1. Also the shape of an
    // @opengsd/gsd-core older than the verb — which is why this WARNS rather
    // than failing during the warn-then-fail rollout (#3146 ruling).
    installFakeTool("process.stderr.write('Unknown command\\n'); process.exit(1);");

    const r = sourceAndReport('gsd_run phases clear');

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
    assert.equal(r.exitCode, 0, 'the warn phase must not stop the workflow');
    assert.equal(r.stdout.includes('RAN:phases,clear'), true, 'the verb must still run in the warn phase');
  });

  test('a probe that prints nothing does not verify', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool('process.exit(0);');

    const r = sourceAndReport();

    assert.equal(r.stdout.includes(`STATUS=${IDENTITY_STATUS.UNVERIFIED}`), true, r.stdout);
  });

  test('the probe writes nothing to the workflow stdout', (t) => {
    if (skipOnWindows(t)) return;
    // The preamble captures the probe in a command substitution. If it leaked,
    // every workflow that parses gsd_run output would read the payload first.
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"1.0.0"}`));

    const r = sourceAndReport();

    assert.equal(r.stdout.split('\n')[0], `STATUS=${IDENTITY_STATUS.OK}`, r.stdout);
  });

  test('the status survives as an exported environment variable', (t) => {
    if (skipOnWindows(t)) return;
    installFakeTool(emit(`${IDENTITY_RAW_PREFIX},"version":"1.0.0"}`));

    // A child process must see it — workflows spawn subshells between steps.
    // Absolute interpreter: PATH holds only the fixture bin, so a bare `sh`
    // would not resolve and the child would never run.
    const r = sourceAndReport('/bin/sh -c \'printf "CHILD=%s\\n" "$GSD_IDENTITY_STATUS"\'');

    assert.equal(r.stdout.includes(`CHILD=${IDENTITY_STATUS.OK}`), true, r.stdout);
  });
});

describe('shell preamble and classifier agree (cross-surface parity, #3841)', () => {
  const fx = makeIdentityFixture();

  beforeEach(() => fx.setup());
  afterEach(() => fx.teardown());

  const installFakeTool = (identityBody) => fx.installFakeTool(identityBody);
  const sourceAndReport = () => fx.sourceAndReport();

  const matching = (extra = '') => `${IDENTITY_RAW_PREFIX},"version":"1.0.0"${extra}}`;
  const foreign = '{"packageName":"get-shit-done-cc","version":"1.0.0"}';

  const CASES = [
    ['P1 payload matches, exit 0', matching(), 0, true],
    ['P2 payload matches, exit 1', matching(), 1, true],
    ['P3 foreign payload, exit 0', foreign, 0, false],
    ['P4 foreign payload, exit 1', foreign, 1, false],
    ['P5 predecessor usage text, exit 1', 'usage: gsd-tools <command>', 1, false],
    [
      'P6 decoy embeds expected name in another field, exit 0',
      JSON.stringify({ packageName: 'get-shit-done-cc', note: EXPECTED_PACKAGE_NAME }),
      0,
      false,
    ],
    ['P7 truncated payload (no closing brace), exit 0', matching().slice(0, -1), 0, false],
    ['P8 payload followed by trailing garbage, exit 0', `${matching()}\nextra`, 0, false],
    ['P9 empty stdout, exit 0', '', 0, false],
    ['P10 additive unknown key, exit 0', matching(',"extra":true'), 0, true],
    ['P11 packageName present but not first, exit 0', `{"note":"x","packageName":"${EXPECTED_PACKAGE_NAME}","version":"1.0.0"}`, 0, false],
    ['P12 leading whitespace before the payload, exit 0', `  ${matching()}`, 0, false],
    ['P13 foreign packageName not first, exit 0', `{"note":"x","packageName":"get-shit-done-cc"}`, 0, false],
  ];

  for (const [label, stdout, exitCode, verified] of CASES) {
    test(label, (t) => {
      if (skipOnWindows(t)) return;

      installFakeTool(`process.stdout.write(${JSON.stringify(stdout)} + '\\n'); process.exit(${exitCode});`);
      const r = sourceAndReport();
      const shellStatus = r.stdout.split('\n').find((l) => l.startsWith('STATUS='))?.slice('STATUS='.length);

      const verdict = classifyIdentityProbe({ stdout: `${stdout}\n`, exitCode });
      const jsStatus = statusForVerdict(verdict);

      const expectedStatus = verified ? IDENTITY_STATUS.OK : IDENTITY_STATUS.UNVERIFIED;
      assert.equal(jsStatus, shellStatus, `classifier/shell disagree for: ${label}`);
      assert.equal(jsStatus, expectedStatus, `classifier status wrong for: ${label}`);
      assert.equal(shellStatus, expectedStatus, `shell status wrong for: ${label}`);
    });
  }
});
