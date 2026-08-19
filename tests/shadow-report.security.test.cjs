'use strict';

/**
 * tests/shadow-report.security.test.cjs — hostile-manifest rendering suite
 * for `install-shadow-report.cts` (#2873, epic #2866 Phase 4a — governed by
 * `.gsd/phase/feat-2873-cross-scope-shadowing/40-design.md`).
 *
 * Implements matrix section B ("Rendering / sanitization (hostile manifest)",
 * rows B1-B16) from
 * `.gsd/phase/feat-2873-cross-scope-shadowing/50-test-matrix.md`. The
 * matrix's own "Suites" section names this file `install-shadow-report
 * .security.test.cjs`; it is shipped as `shadow-report.security.test.cjs`
 * instead so its `lint-test-file-count.cjs` prefix is `shadow` rather than
 * colliding with the already grandfathered, already-at-cap `install` prefix.
 *
 * Fixture provenance (#2371, per the matrix's own note): B1-B4/B7/B8's
 * `declaredRuntime` payloads and B9-B13's manifest bodies are authored
 * against the PUBLISHED `gsd-file-manifest.json` schema/format directly (raw
 * JSON text or a hand-built `readManifest` result), never derived from
 * `writeManifest`'s own output — a fixture the writer produced could only
 * confirm what the writer already believes.
 *
 * Every `declaredRuntime` assertion below reads the TYPED IR field
 * (`report.mismatches[0].declaredRuntime`) produced by `buildShadowReport`'s
 * sanitize-at-the-render-seam guarantee — never a substring match against
 * rendered prose (CONTRIBUTING → "Prohibited: Raw Text Matching on Test
 * Outputs"). Where a `renderShadowReport` line is also inspected (B2, B12),
 * the check is a structural security invariant (absence of a control
 * character / a traversal payload), not a wording assertion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { buildShadowReport, renderShadowReport } = require('../gsd-core/bin/lib/install-shadow-report.cjs');
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const { MANIFEST_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');

// ─── Fixture helpers (mirrors tests/installed-surface-resolver.test.cjs) ───

const ABSENT_MANIFEST = Object.freeze({ manifestVersion: null, runtime: null, scope: null, files: {} });

function manifest({ manifestVersion = null, runtime = null, scope = null, files = {} } = {}) {
  return { manifestVersion, runtime, scope, files };
}

function mkReadManifest(byConfigHome) {
  return (configDir) => byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
}

function scopeHomes(runtime, home, cwd) {
  const base = { runtime, env: {}, home, existsSync: () => false, cwd };
  return {
    global: resolveScope({ ...base, id: 'global' }).configHome,
    local: resolveScope({ ...base, id: 'local' }).configHome,
  };
}

function baseOpts(home, cwd, overrides = {}) {
  return { home, cwd, env: {}, existsSync: () => false, ...overrides };
}

/** Single-scope (global-only) fixture: a claude install declaring
 *  `declaredRuntime = runtimeVal` — always a mismatch against the requested
 *  'claude' runtime unless `runtimeVal === 'claude'`, which is exactly what
 *  puts an entry in `report.mismatches` for every B-row below to inspect.
 *  `files: {}` keeps the fixture single-purpose: no trigger/shadowing signal
 *  competes with the mismatch signal under test. */
function declaredRuntimeReport(runtimeVal) {
  const home = '/fixture/sec-home';
  const cwd = '/fixture/sec-cwd';
  const homes = scopeHomes('claude', home, cwd);
  const byConfigHome = new Map([
    [homes.global, manifest({ manifestVersion: 2, runtime: runtimeVal, scope: 'global', files: {} })],
  ]);
  return buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
}

// RLO (Right-to-Left Override, U+202E) — written as a `\u{...}` escape (not
// a literal bidi character) so the source stays plain ASCII and does not
// carry the very invisible/dangerous-Unicode class it tests. See the
// matching B17/B18 note further below for the same rationale.
const BIDI_RLO = '\u{202E}';

// ─── B1-B4 — hostile declaredRuntime payloads are neutralized in the IR ────

describe('buildShadowReport — hostile declaredRuntime is sanitized in the IR (B1-B4)', () => {
  test('ansi escape is neutralized (B1)', () => {
    const report = declaredRuntimeReport('\x1b[31mcursor');
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'cursor');
    assert.ok(!report.mismatches[0].declaredRuntime.includes('\x1b'));
  });

  test('newlines cannot forge a log line (B2)', () => {
    const lf = declaredRuntimeReport('cursor\nFAKE LOG LINE');
    const crlf = declaredRuntimeReport('cursor\r\nFAKE LOG LINE');
    assert.strictEqual(lf.mismatches[0].declaredRuntime, 'cursorFAKE LOG LINE');
    assert.strictEqual(crlf.mismatches[0].declaredRuntime, 'cursorFAKE LOG LINE');
    assert.ok(!lf.mismatches[0].declaredRuntime.includes('\n'));
    // Every rendered line must itself be single-line — a structural check on
    // the renderer's output shape, not a wording assertion.
    for (const line of renderShadowReport(lf)) {
      assert.ok(!line.includes('\n'), `rendered line must never carry an embedded newline: ${JSON.stringify(line)}`);
    }
  });

  test('control characters are stripped (B3)', () => {
    const report = declaredRuntimeReport('a\x00b\x07c');
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'abc');
  });

  test('bidi override is stripped (B4)', () => {
    const report = declaredRuntimeReport(`a${BIDI_RLO}b`);
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'ab');
  });
});

// ─── B5-B6 — the READER's 64-char cap, real fs, no double-truncation ───────

describe('buildShadowReport — declaredRuntime length cap, real reader (B5-B6)', () => {
  function realCappedReport(t, n) {
    const home = createTempDir('gsd-shadow-sec-b56-home-');
    const cwd = createTempDir('gsd-shadow-sec-b56-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });
    const globalDir = path.join(home, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'A'.repeat(n), scope: 'global', files: {},
    }));
    return buildShadowReport('claude', { home, cwd });
  }

  test('cap-length runtime renders intact (B5, 64 chars)', (t) => {
    const report = realCappedReport(t, 64);
    assert.strictEqual(report.mismatches[0].declaredRuntime.length, 64);
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'A'.repeat(64));
  });

  test('reader cap is respected once, not double-truncated (B6, 63/65 chars)', (t) => {
    const below = realCappedReport(t, 63);
    assert.strictEqual(below.mismatches[0].declaredRuntime, 'A'.repeat(63));

    const above = realCappedReport(t, 65);
    // readInstallManifest's MAX_REPORTED_RUNTIME_LENGTH truncates to 64 chars
    // plus an ellipsis (65 chars total) — buildShadowReport's sanitizer never
    // truncates further, so the ellipsis must survive intact.
    assert.strictEqual(above.mismatches[0].declaredRuntime.length, 65);
    assert.strictEqual(above.mismatches[0].declaredRuntime, `${'A'.repeat(64)}…`);
  });
});

// ─── B7-B8 — empty vs null declaredRuntime ─────────────────────────────────

describe('buildShadowReport — empty vs absent declaredRuntime (B7-B8)', () => {
  test('empty declared runtime renders as empty string, never as the string "null" (B7)', () => {
    // Injected directly (bypassing readInstallManifest's own empty-string ->
    // null normalization) so this exercises buildShadowReport/sanitizeForRender's
    // OWN handling of an empty-but-present declared value, independent of
    // the reader's separate empty-string rule.
    const report = declaredRuntimeReport('');
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].declaredRuntime, '');
    assert.notStrictEqual(report.mismatches[0].declaredRuntime, null);
  });

  test('absent declared runtime (null, v1 manifest) is omitted from the IR entirely (B8)', () => {
    const home = '/fixture/b8-home';
    const cwd = '/fixture/b8-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      // scope matches probe too, so NEITHER mismatch flag fires.
      [homes.global, manifest({ manifestVersion: 2, runtime: null, scope: 'global', files: {} })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(report.mismatches, [], 'a null declaredRuntime with no scope mismatch produces no mismatch entry at all');
  });
});

// ─── B9-B11 — manifest document malformation, real files, real reads ──────

describe('buildShadowReport — malformed manifest documents degrade, never throw (B9-B11)', () => {
  function realSingleScopeReport(t, rawBody) {
    const home = createTempDir('gsd-shadow-sec-b9-home-');
    const cwd = createTempDir('gsd-shadow-sec-b9-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });
    const globalDir = path.join(home, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), rawBody);
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('claude', { home, cwd });
    });
    return report;
  }

  test('non-object manifest json (0, string, array, boolean, null) all degrade to not-installed (B9)', (t) => {
    for (const raw of ['0', '"a string"', '[]', 'true', 'null']) {
      const report = realSingleScopeReport(t, raw);
      assert.strictEqual(report.shadowed, false, `raw body ${raw} must degrade to not-installed`);
      assert.deepStrictEqual(report.triggers, []);
    }
  });

  test('an empty (0-byte) manifest file degrades to not-installed (B10)', (t) => {
    const report = realSingleScopeReport(t, '');
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('a CRLF manifest parses identically to its LF counterpart (B11)', (t) => {
    const lfBody = [
      '{',
      '  "manifestVersion": 2,',
      '  "runtime": "claude",',
      '  "scope": "global",',
      '  "files": { "skills/gsd-plan-phase/SKILL.md": "a" }',
      '}',
      '',
    ].join('\n');
    const lfReport = realSingleScopeReport(t, lfBody);
    const crlfReport = realSingleScopeReport(t, lfBody.replace(/\n/g, '\r\n'));
    assert.deepStrictEqual(crlfReport, lfReport);
  });
});

// ─── B12-B13 — manifest key hostility / cross-platform normalization ──────

describe('buildShadowReport — manifest KEY hostility and normalization (B12-B13)', () => {
  test('a traversal stem is rejected, never reaches a rendered trigger (B12)', () => {
    const home = '/fixture/b12-home';
    const cwd = '/fixture/b12-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({
        manifestVersion: 2, runtime: 'claude', scope: 'global',
        files: {
          'skills/gsd-../../../x/SKILL.md': 'a',
          'skills/gsd-plan-phase/SKILL.md': 'b',
        },
      })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    // Only the legitimate stem is present — the traversal key contributed nothing.
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-plan-phase']);
    for (const line of renderShadowReport(report)) {
      assert.ok(!line.includes('..'), `rendered output must never carry a traversal payload: ${JSON.stringify(line)}`);
    }
  });

  test('backslash-separated keys normalize on posix too (B13)', () => {
    const home = '/fixture/b13-home';
    const cwd = '/fixture/b13-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills\\gsd-foo\\SKILL.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-foo.md': 'a' } })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-foo']);
  });
});

// ─── B14-B16 — the lstatSync symlink guard ─────────────────────────────────

describe('buildShadowReport — the lstatSync symlink guard (B14-B16)', () => {
  test('a symlinked local config dir is not followed, injected lstatSync (B14)', () => {
    const home = '/fixture/b14-home';
    const cwd = '/fixture/b14-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
      // A manifest IS present at the local configHome per this readManifest
      // stub — proving the guard, not the reader, is what refuses it below.
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    // Injected lstatSync reports the local configHome itself as a symlink.
    const lstatSync = (p) => ({ isSymbolicLink: () => p === homes.local });
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome), lstatSync }));
    assert.strictEqual(report.shadowed, false, 'the symlinked local scope must not be counted as installed, so nothing can shadow it');
    assert.deepStrictEqual(report.triggers, []);
  });

  test('a symlinked manifest file is not followed, real symlink on disk (B15)', (t) => {
    const home = createTempDir('gsd-shadow-sec-b15-home-');
    const cwd = createTempDir('gsd-shadow-sec-b15-cwd-');
    const outOfTreeDir = createTempDir('gsd-shadow-sec-b15-outoftree-');
    t.after(() => { cleanup(home); cleanup(cwd); cleanup(outOfTreeDir); });

    const globalDir = path.join(home, '.claude');
    const localDir = path.join(cwd, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' },
    }));
    const outOfTreeManifest = path.join(outOfTreeDir, 'real-manifest.json');
    fs.writeFileSync(outOfTreeManifest, JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' },
    }));
    // The local config DIR is real; only the manifest FILE inside it is a
    // symlink pointing OUTSIDE the config dir — proves the guard checks the
    // manifest path itself, not merely the directory.
    fs.symlinkSync(outOfTreeManifest, path.join(localDir, MANIFEST_NAME), 'file');

    const report = buildShadowReport('claude', { home, cwd });
    assert.strictEqual(report.shadowed, false, 'a symlinked manifest file must never be followed, even though its target is valid, matching content');
    assert.deepStrictEqual(report.triggers, []);
  });

  test('an unsymlinked local config still reads (B16, negative proof)', (t) => {
    const home = createTempDir('gsd-shadow-sec-b16-home-');
    const cwd = createTempDir('gsd-shadow-sec-b16-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });

    const globalDir = path.join(home, '.claude');
    const localDir = path.join(cwd, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' },
    }));
    fs.writeFileSync(path.join(localDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' },
    }));

    const report = buildShadowReport('claude', { home, cwd });
    assert.strictEqual(report.shadowed, true, 'the guard must not break the ordinary, unsymlinked happy path');
    assert.strictEqual(report.triggers.length, 1);
  });
});

// ─── B17-B18 — zalgo / zero-width, #2873 PR review Finding 2 (MINOR) ──────
//
// `sanitizeForRender` stripped ANSI, C0/C1, and bidi overrides/isolates, but
// not combining marks (U+0300-U+036F — "zalgo" text, which visually
// overflows into adjacent terminal cells) or zero-width characters (ZWSP
// U+200B, ZWNJ U+200C, ZWJ U+200D, BOM/ZWNBSP U+FEFF). Neither class is a JS
// `\s`, so both survived the 64-char cap and the whitespace-collapse step
// undetected.

// Written as `\u{...}` escapes throughout (never literal combining/bidi/
// zero-width characters) so the source stays plain ASCII and does not
// visually combine with adjacent punctuation in editors/diffs.
const ZALGO_COMBINING_1 = '\u{0300}'; // combining grave accent
const ZALGO_COMBINING_2 = '\u{0301}'; // combining acute accent
const ZALGO_COMBINING_3 = '\u{036F}'; // combining latin small letter x (top of range)
const ZWSP = '\u{200B}';
const ZWNJ = '\u{200C}';
const ZWJ = '\u{200D}';
const BOM = '\u{FEFF}';

describe('buildShadowReport — hostile declaredRuntime is sanitized in the IR (B17-B18)', () => {
  test('combining marks (zalgo) are stripped (B17)', () => {
    const report = declaredRuntimeReport(`a${ZALGO_COMBINING_1}${ZALGO_COMBINING_2}${ZALGO_COMBINING_3}b`);
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'ab');
    assert.ok(!/[\u{0300}-\u{036F}]/u.test(report.mismatches[0].declaredRuntime));
  });

  test('zero-width characters (ZWSP/ZWNJ/ZWJ/BOM) are stripped (B18)', () => {
    const report = declaredRuntimeReport(`a${ZWSP}b${ZWNJ}c${ZWJ}d${BOM}e`);
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'abcde');
    assert.ok(!/[\u{200B}-\u{200D}\u{FEFF}]/u.test(report.mismatches[0].declaredRuntime));
  });
});

// Note: the F3 property ("sanitizer output contains no character in the
// stripped class, for arbitrary input") lives in `tests/shadow-report.test.cjs`
// alongside F2 (sanitizer idempotence) — both target `sanitizeForRender` and
// share one hostile-input generator, extended for #2873 PR review Finding 2
// (MINOR) to also emit combining marks (zalgo) and zero-width characters so
// the property actually exercises the newly-stripped classes rather than
// passing vacuously.
