'use strict';

/**
 * Installer Migration Module — manifest DOCUMENT schema contract, both
 * directions (#2872, ADR-2866 Phase 3, suite `unit` + suite `install`).
 *
 * Seams:
 *   - gsd-core/bin/lib/installer-migrations.cjs -> readInstallManifest (read path)
 *   - bin/install.js -> writeManifest(configDir, runtime, { mode, scope }) (write path)
 *
 * Covers rows R1-R21 (read path, section 2) and W1-W9 (write path, section 1)
 * of `.gsd/phase/feat-2872-manifest-scope-runtime/50-test-matrix.md`. The
 * resolver (S1-S21) and the stem bijection (B1-B8) belong to a different test
 * file entirely and are deliberately NOT covered here.
 *
 * Both the writer and the reader are asserted in this ONE file, side by side,
 * because they share a single on-disk format (`gsd-file-manifest.json`):
 * `writeManifest` produces it, `readInstallManifest` consumes it, and there
 * is no independent schema authority arbitrating between them other than
 * this test file. Splitting the two across files would let a writer/reader
 * divergence — the writer emitting a shape the reader silently misreads, or
 * vice versa — pass both suites individually while breaking the real
 * contract; keeping them together makes that class of defect fail in one
 * place instead of two.
 *
 * The manifest is a JSON config document WRITTEN by the code under test —
 * reading it back with JSON.parse and asserting field equality is the
 * correct, expected shape here (never `.includes()`/`.match()` on raw text;
 * that would trip `local/no-source-grep`, and this isn't a source file
 * anyway).
 *
 * `writeManifest` is driven DIRECTLY (in-process, via `require('../bin/
 * install.js')`) rather than through a full spawned install for every row.
 * `bin/install.js` guards its CLI entrypoint behind `require.main === module`
 * (bin/install.js:13806), so requiring it as a module — the same thing
 * tests/install-runtime-artifacts.test.cjs already does — never runs the
 * installer's CLI path; it only exposes the exported functions, including
 * `writeManifest` itself (see its export block).
 *
 * W1/W2 pass the exact three-argument shape production always uses
 * (`writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope:
 * _installScopeId })`, all 5 call sites in bin/install.js) so the suite
 * proves the property real callers exercise, not a degenerate one. W5-W7
 * deliberately use degenerate/omitted shapes — a third-party caller's
 * defense-in-depth case per 40-design.md row A4.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { MANIFEST_SCHEMA_VERSION, readInstallManifest } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { writeManifest } = require('../bin/install.js');

const MANIFEST_NAME = 'gsd-file-manifest.json';

function writeRawManifest(dir, content) {
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), content, 'utf8');
}

function writeJsonManifest(dir, value) {
  writeRawManifest(dir, JSON.stringify(value));
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('readInstallManifest — manifest schema (#2872 R1-R21)', () => {
  let dir;

  beforeEach(() => {
    dir = createTempDir('gsd-manifest-schema-');
  });

  afterEach(() => {
    cleanup(dir);
  });

  // R1 — no manifest file at all. manifestVersion must be null, distinct from
  // the `1` a v1 manifest reports (locked together with R2/R6 elsewhere), and
  // scope/runtime null too.
  test('R1: absent manifest reports manifestVersion null, distinct from 1', () => {
    const result = readInstallManifest(dir);
    assert.strictEqual(result.manifestVersion, null);
    assert.notStrictEqual(result.manifestVersion, 1);
    assert.strictEqual(result.runtime, null);
    assert.strictEqual(result.scope, null);
    assert.deepStrictEqual(result.files, {});
    assert.strictEqual(result.version, null);
    assert.strictEqual(result.timestamp, null);
    assert.strictEqual(result.mode, null);
  });

  // R2 — the must-have acceptance criterion (AC2): a REAL v1 manifest, with
  // exactly the four pre-#2872 fields and nothing else, reads without error
  // and without requiring a reinstall.
  test('R2 (must-have AC2): reads a v1 manifest without error and without reinstall', () => {
    const v1 = {
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files: { 'gsd-core/hooks/dist/gsd-check-update.js': 'deadbeef' },
    };
    writeJsonManifest(dir, v1);

    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.strictEqual(result.manifestVersion, 1);
    assert.strictEqual(result.runtime, null);
    assert.strictEqual(result.scope, null);
    // Byte-identical to what today's (pre-#2872) reader produced for the same input.
    assert.strictEqual(result.version, v1.version);
    assert.strictEqual(result.timestamp, v1.timestamp);
    assert.strictEqual(result.mode, v1.mode);
    assert.deepStrictEqual(result.files, v1.files);
  });

  // R3/R5 — a v2 manifest surfaces all three new fields.
  test('R3: reads scope and runtime from a v2 manifest', () => {
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime: 'claude',
      scope: 'local',
      files: { 'agents/gsd-planner.md': 'abc123' },
    });

    const result = readInstallManifest(dir);
    assert.strictEqual(result.manifestVersion, 2);
    assert.strictEqual(result.runtime, 'claude');
    assert.strictEqual(result.scope, 'local');
  });

  // R4 — a FUTURE writer's manifestVersion is reported verbatim, never
  // clamped and never thrown on.
  test('R4: reports a future manifestVersion verbatim', () => {
    writeJsonManifest(dir, {
      manifestVersion: 3,
      version: '1.99.0',
      timestamp: '2026-09-01T00:00:00.000Z',
      mode: 'full',
      runtime: 'codex',
      scope: 'global',
      files: {},
    });

    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.strictEqual(result.manifestVersion, 3);
  });

  // R6/R7/R8/R9 — the manifestVersion normalization boundary set, in one
  // table-driven test so the limit-1/limit/limit+1 + malformed classes sit
  // together.
  const manifestVersionCases = [
    { label: 'R6: explicit 1 matches an implicit v1', raw: 1, expected: 1 },
    { label: 'R7: 0 is out-of-range, rejected to 1', raw: 0, expected: 1 },
    { label: 'R7: -1 is out-of-range, rejected to 1', raw: -1, expected: 1 },
    { label: 'R8: 2.5 is non-integer, rejected to 1', raw: 2.5, expected: 1 },
    { label: 'R8: NaN is non-integer, rejected to 1', raw: NaN, expected: 1 },
    { label: 'R8: Infinity is non-integer, rejected to 1', raw: Infinity, expected: 1 },
    { label: 'R9: stringified "2" is not a version claim, rejected to 1', raw: '2', expected: 1 },
  ];
  for (const { label, raw, expected } of manifestVersionCases) {
    test(label, () => {
      writeJsonManifest(dir, {
        manifestVersion: raw,
        version: '1.50.0',
        timestamp: '2026-05-11T00:00:00.000Z',
        mode: 'full',
        files: {},
      });
      const result = readInstallManifest(dir);
      assert.strictEqual(result.manifestVersion, expected);
    });
  }

  // R6 (paired assertion) — an explicit manifestVersion:1 is indistinguishable
  // from one with the key entirely absent.
  test('R6: an explicit manifestVersion 1 matches an implicit one', (t) => {
    const explicitDir = createTempDir('gsd-manifest-schema-explicit-');
    const implicitDir = createTempDir('gsd-manifest-schema-implicit-');
    t.after(() => cleanup(explicitDir));
    t.after(() => cleanup(implicitDir));
    const base = { version: '1.50.0', timestamp: '2026-05-11T00:00:00.000Z', mode: 'full', files: {} };
    writeJsonManifest(explicitDir, { manifestVersion: 1, ...base });
    writeJsonManifest(implicitDir, base);

    assert.strictEqual(readInstallManifest(explicitDir).manifestVersion, 1);
    assert.strictEqual(
      readInstallManifest(explicitDir).manifestVersion,
      readInstallManifest(implicitDir).manifestVersion,
    );
  });

  // R10 — the negative-space row: consent/lifecycle vocabulary ('project')
  // must never be read as an install scope, and must NEVER collapse to
  // 'local'.
  test('R10 (negative space): does not read the consent vocabulary as an install scope', () => {
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime: 'claude',
      scope: 'project',
      files: {},
    });

    const result = readInstallManifest(dir);
    assert.strictEqual(result.scope, null);
    assert.notStrictEqual(result.scope, 'local');
  });

  // R11 — hostile scope values all reject to null.
  for (const scope of ['GLOBAL', '', 7, null]) {
    test(`R11: rejects an invalid scope (${JSON.stringify(scope)}) to null`, () => {
      writeJsonManifest(dir, {
        manifestVersion: 2,
        version: '1.60.0',
        timestamp: '2026-08-01T00:00:00.000Z',
        mode: 'full',
        runtime: 'claude',
        scope,
        files: {},
      });
      assert.strictEqual(readInstallManifest(dir).scope, null);
    });
  }

  // R12 — malformed runtime values (empty, whitespace-only, non-string)
  // reject to null.
  for (const runtime of ['', '   ', 42]) {
    test(`R12: rejects an empty or non-string runtime (${JSON.stringify(runtime)}) to null`, () => {
      writeJsonManifest(dir, {
        manifestVersion: 2,
        version: '1.60.0',
        timestamp: '2026-08-01T00:00:00.000Z',
        mode: 'full',
        runtime,
        scope: 'global',
        files: {},
      });
      assert.strictEqual(readInstallManifest(dir).runtime, null);
    });
  }

  // R13 — an unregistered runtime string is a fact about the file, reported
  // verbatim; the reader does not validate against the runtime registry.
  test('R13: reports an unregistered runtime string verbatim', () => {
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime: 'not-a-registered-runtime',
      scope: 'global',
      files: {},
    });
    assert.strictEqual(readInstallManifest(dir).runtime, 'not-a-registered-runtime');
  });

  // R14 — unparseable JSON reads as absent, no throw (Known limit, B9).
  test('R14: an unparseable manifest reads as absent', () => {
    writeRawManifest(dir, '{not valid json');

    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.strictEqual(result.manifestVersion, null);
    assert.strictEqual(result.runtime, null);
    assert.strictEqual(result.scope, null);
    assert.deepStrictEqual(result.files, {});
  });

  // R15 — valid JSON that is NOT an object (0, "str", true, null) all read
  // as absent, no throw.
  for (const value of [0, 'str', true, null]) {
    test(`R15 (negative space): valid non-object JSON (${JSON.stringify(value)}) reads as absent`, () => {
      writeJsonManifest(dir, value);

      let result;
      assert.doesNotThrow(() => {
        result = readInstallManifest(dir);
      });
      assert.strictEqual(result.manifestVersion, null);
      assert.strictEqual(result.runtime, null);
      assert.strictEqual(result.scope, null);
      assert.deepStrictEqual(result.files, {});
    });
  }

  // R16 — valid JSON `[]` documents the current branch: typeof [] === 'object'
  // passes the guard, but `files` is absent on an array so it collapses to {}.
  test('R16 (negative space): an array manifest yields an empty file map', () => {
    writeJsonManifest(dir, []);

    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.deepStrictEqual(result.files, {});
  });

  // R17 — a zero-byte manifest file reads as absent, no throw.
  test('R17 (negative space): an empty manifest file reads as absent', () => {
    writeRawManifest(dir, '');

    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.strictEqual(result.manifestVersion, null);
    assert.strictEqual(result.runtime, null);
    assert.strictEqual(result.scope, null);
    assert.deepStrictEqual(result.files, {});
  });

  // R18 — a manifest with zero files still reports its version: "present but
  // empty" is a distinct state from "absent".
  test('R18: a manifest with no files still reports its version', () => {
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime: 'claude',
      scope: 'global',
      files: {},
    });

    const result = readInstallManifest(dir);
    assert.strictEqual(result.manifestVersion, 2);
    assert.deepStrictEqual(result.files, {});
  });

  // R19 — CRLF line endings inside the JSON text must not change the parse.
  test('R19: CRLF line endings do not change the parse', (t) => {
    const lfDir = createTempDir('gsd-manifest-schema-lf-');
    const crlfDir = createTempDir('gsd-manifest-schema-crlf-');
    t.after(() => cleanup(lfDir));
    t.after(() => cleanup(crlfDir));
    const lfJson = [
      '{',
      '  "manifestVersion": 2,',
      '  "version": "1.60.0",',
      '  "timestamp": "2026-08-01T00:00:00.000Z",',
      '  "mode": "full",',
      '  "runtime": "claude",',
      '  "scope": "local",',
      '  "files": { "agents/gsd-planner.md": "abc123" }',
      '}',
      '',
    ].join('\n');
    writeRawManifest(lfDir, lfJson);
    writeRawManifest(crlfDir, lfJson.replace(/\n/g, '\r\n'));

    assert.deepStrictEqual(readInstallManifest(crlfDir), readInstallManifest(lfDir));
  });

  // R20 — a `files` key literally named `__proto__` must never pollute
  // Object.prototype.
  test('R20 (hostile): a __proto__ manifest key does not pollute the prototype', () => {
    // Built as raw JSON TEXT (never a JS object literal) so the on-disk bytes
    // contain a literal `"__proto__"` key. An object-literal spelling
    // (`{ '__proto__': ... }`) is special-cased by the ObjectLiteral grammar
    // and would set the JS object's prototype at construction time instead
    // of producing an own enumerable key — which would not reproduce what
    // `JSON.parse` actually hands the reader when a hostile manifest is read
    // from disk (JSON.parse's InternalizeJSONProperty creates a plain own
    // property named "__proto__", not a prototype rewire).
    const raw = [
      '{',
      '  "manifestVersion": 2,',
      '  "version": "1.60.0",',
      '  "timestamp": "2026-08-01T00:00:00.000Z",',
      '  "mode": "full",',
      '  "runtime": "claude",',
      '  "scope": "global",',
      '  "files": { "__proto__": { "polluted": "yes" }, "constructor": { "polluted": "also-yes" } }',
      '}',
    ].join('\n');
    writeRawManifest(dir, raw);

    assert.doesNotThrow(() => readInstallManifest(dir));

    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.getOwnPropertyNames(Object.prototype).includes('polluted'), false);
  });

  // R21 — independence: the four v1 callers read only `files`. A manifest
  // carrying just the four v1 fields must yield the exact same `files` map
  // the pre-#2872 reader produced for that input.
  test('R21 (independence): existing callers see an unchanged files map', () => {
    const files = {
      'gsd-core/hooks/dist/gsd-check-update.js': 'aaa111',
      'agents/gsd-planner.md': 'bbb222',
      'skills/gsd-plan-phase/SKILL.md': 'ccc333',
    };
    writeJsonManifest(dir, {
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    });

    const result = readInstallManifest(dir);
    assert.deepStrictEqual(result.files, files);
  });

  // R22 — boundary (limit): a runtime string of exactly 64 chars is reported
  // unchanged, no truncation marker.
  test('R22: reports a 64-char runtime unchanged', () => {
    const runtime = 'a'.repeat(64);
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime,
      scope: 'global',
      files: {},
    });
    assert.strictEqual(readInstallManifest(dir).runtime, runtime);
  });

  // R23 — boundary (limit+1): one char past the cap is truncated to 64 chars
  // plus the ellipsis marker (same convention as `truncatePostureValue`,
  // agent-install-check.cts:75-77).
  test('R23: truncates a 65-char runtime to 64 chars plus an ellipsis', () => {
    const runtime = 'a'.repeat(65);
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime,
      scope: 'global',
      files: {},
    });
    const result = readInstallManifest(dir);
    assert.strictEqual(result.runtime, `${'a'.repeat(64)}…`);
    assert.strictEqual(result.runtime.length, 65);
  });

  // R24 — boundary (limit-1): one char under the cap is reported unchanged.
  test('R24: reports a 63-char runtime unchanged', () => {
    const runtime = 'a'.repeat(63);
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime,
      scope: 'global',
      files: {},
    });
    assert.strictEqual(readInstallManifest(dir).runtime, runtime);
  });

  // R25 — hostile: the manifest is attacker-influenceable (a project-local
  // one lives inside a repository a user may merely have cloned), so a very
  // long `runtime` string must never reach a consumer unbounded, and must
  // never throw.
  test('R25: bounds a very long runtime without throwing', () => {
    const runtime = 'x'.repeat(100_000);
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime,
      scope: 'global',
      files: {},
    });
    let result;
    assert.doesNotThrow(() => {
      result = readInstallManifest(dir);
    });
    assert.strictEqual(result.runtime.length, 65);
  });

  // R26 — negative space, documented deliberately: the CHARSET of `runtime`
  // is NOT gated, only its length. `declaredRuntimeMatchesProbe` needs to see
  // the actual value to detect a mismatch, so a charset gate here would
  // destroy that signal. A future reader must not "fix" this by adding one —
  // Phase 4 (#2873) owns sanitizing `declaredRuntime` before it is rendered.
  test('R26: still reports a runtime containing a control character', () => {
    const runtime = 'claude[31m';
    writeJsonManifest(dir, {
      manifestVersion: 2,
      version: '1.60.0',
      timestamp: '2026-08-01T00:00:00.000Z',
      mode: 'full',
      runtime,
      scope: 'global',
      files: {},
    });
    assert.strictEqual(readInstallManifest(dir).runtime, runtime);
  });

  // R27 (regression, #2873 test-matrix row B9) — valid JSON that parses to a
  // non-object top-level value must degrade to "absent", identically to R1,
  // on every JS typeof-'object' member: `0`, a string, `true`, `null`
  // (JSON.parse('null') is a real value), and — the one the `typeof !==
  // 'object'` guard alone misses, since `typeof [] === 'object'` in JS — a
  // bare array. Found while implementing #2873's shadow-report test matrix:
  // `[]` was misread as manifestVersion 1 (a v1 install), reporting a
  // completely absent manifest as "installed". `readInstallManifest` now
  // explicitly excludes `Array.isArray` from the object-shape check.
  for (const raw of ['0', '"a string"', 'true', 'null', '[]']) {
    test(`R27: a valid-JSON, non-object manifest body (${raw}) reads as absent`, () => {
      writeRawManifest(dir, raw);
      const result = readInstallManifest(dir);
      assert.strictEqual(result.manifestVersion, null, `${raw}: manifestVersion must be null, not a v1 guess`);
      assert.strictEqual(result.runtime, null);
      assert.strictEqual(result.scope, null);
      assert.deepStrictEqual(result.files, {});
    });
  }
});

describe('writeManifest — scope + runtime recording (#2872 W1-W9)', () => {
  let dir;

  beforeEach(() => {
    dir = createTempDir('gsd-write-manifest-');
  });

  afterEach(() => {
    cleanup(dir);
  });

  // W1 — global install, claude: manifestVersion 2, runtime + scope recorded.
  test('records manifestVersion, runtime and scope for a global install', () => {
    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.runtime, 'claude');
    assert.strictEqual(manifest.scope, 'global');
  });

  // W2 — local install, claude: same runtime, scope local.
  test('records scope local for a --local install', () => {
    writeManifest(dir, 'claude', { mode: 'full', scope: 'local' });

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.runtime, 'claude');
    assert.strictEqual(manifest.scope, 'local');
  });

  // W3 — a non-claude runtime is recorded as itself, not a hardcoded default.
  test('records the installing runtime, not a default', () => {
    writeManifest(dir, 'codex', { mode: 'full', scope: 'global' });

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.runtime, 'codex');
  });

  // W4 — an install over a pre-existing v1 manifest rebuilds it whole, as v2,
  // with `files` still reflecting what's actually on disk (not wiped).
  test('an install over a v1 manifest rewrites it as v2', () => {
    const gsdCoreDir = path.join(dir, 'gsd-core');
    fs.mkdirSync(gsdCoreDir, { recursive: true });
    const trackedContent = 'console.log("hook");\n';
    fs.writeFileSync(path.join(gsdCoreDir, 'gsd-check-update.js'), trackedContent);
    fs.writeFileSync(
      path.join(dir, MANIFEST_NAME),
      JSON.stringify({
        version: '1.49.0',
        timestamp: '2026-05-10T00:00:00.000Z',
        mode: 'full',
        files: { 'some/stale/path.md': 'stalehash' },
      }),
    );

    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.runtime, 'claude');
    assert.strictEqual(manifest.scope, 'global');
    // `files` reflects what's actually on disk now, not the stale v1 entry.
    assert.strictEqual(
      manifest.files['gsd-core/gsd-check-update.js'],
      sha256(trackedContent),
    );
    assert.strictEqual(manifest.files['some/stale/path.md'], undefined);
  });

  // W5 — options omitted entirely: scope defaults to 'global', never
  // null/absent (A3: the SAME fallback the skills-root line already
  // applies, read from one place).
  test('defaults scope to global when options are omitted', () => {
    writeManifest(dir, 'claude');

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.scope, 'global');
    assert.notStrictEqual(manifest.scope, null);
  });

  // W6 — a junk options.scope coerces to 'global' without throwing (A4:
  // defense-in-depth for a third-party caller; junk cannot reach here from
  // bin/install.js itself).
  for (const junkScope of ['GLOBAL', '', 0, null]) {
    test(`coerces an unrecognized scope (${JSON.stringify(junkScope)}) to global without throwing`, () => {
      let manifest;
      assert.doesNotThrow(() => {
        writeManifest(dir, 'claude', { mode: 'full', scope: junkScope });
        manifest = readManifest(dir);
      });
      assert.strictEqual(manifest.scope, 'global');
    });
  }

  // W7 — runtime omitted: records DEFAULT_RUNTIME, never null.
  test('records the default runtime when none is passed', () => {
    writeManifest(dir);

    const manifest = readManifest(dir);
    assert.strictEqual(typeof manifest.runtime, 'string');
    assert.ok(manifest.runtime.length > 0);
    assert.notStrictEqual(manifest.runtime, null);
  });

  // W8 — independence: the four pre-existing manifest fields keep their
  // names and types.
  test('does not change any pre-existing manifest field', () => {
    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });

    const manifest = readManifest(dir);
    assert.strictEqual(typeof manifest.version, 'string');
    assert.strictEqual(typeof manifest.timestamp, 'string');
    assert.strictEqual(typeof manifest.mode, 'string');
    assert.strictEqual(typeof manifest.files, 'object');
    assert.ok(manifest.files !== null);
    assert.ok(!Array.isArray(manifest.files));
  });

  // W9 — idempotent apart from timestamp: writing twice over the same dir
  // produces two manifests that differ ONLY in their timestamp. Never
  // asserts on elapsed wall-clock time — only on structural equality once
  // `timestamp` is removed from both sides.
  test('is idempotent apart from timestamp', () => {
    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });
    const first = readManifest(dir);
    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });
    const second = readManifest(dir);

    assert.strictEqual(typeof first.timestamp, 'string');
    assert.strictEqual(typeof second.timestamp, 'string');
    delete first.timestamp;
    delete second.timestamp;
    assert.deepStrictEqual(first, second);
  });

  // W10 (parity) — the divergence guard this repo requires when two surfaces
  // share a constant: `writeManifest` (bin/install.js) and
  // `readInstallManifest` (gsd-core/bin/lib/installer-migrations.cjs) must
  // agree on the manifest schema version via the SAME owned constant, never
  // two independent literals that can drift apart (the "generative fix
  // divergence" class). This fails if either side is changed alone.
  test('W10 (parity): the version writeManifest emits is the same constant readInstallManifest owns', () => {
    writeManifest(dir, 'claude', { mode: 'full', scope: 'global' });

    const manifest = readManifest(dir);
    assert.strictEqual(manifest.manifestVersion, MANIFEST_SCHEMA_VERSION);
    assert.strictEqual(readInstallManifest(dir).manifestVersion, MANIFEST_SCHEMA_VERSION);
  });
});
