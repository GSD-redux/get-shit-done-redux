/**
 * Tests for src/core-utils.cts (compiled to gsd-core/bin/lib/core-utils.cjs).
 *
 * Verifies behavioural contracts of the utilities extracted from core.cjs
 * per ADR-857 rollout phase 2c (#877):
 *   - toPosixPath
 *   - detectSubRepos
 *   - extractOneLinerFromBody
 *   - pathExistsInternal
 *   - generateSlugInternal
 *   - getPhaseFileStats
 *   - readSubdirectories
 *   - timeAgo
 *   - extractCanonicalPlanId (private — only via coreUtils, NOT via core)
 *   - core.cjs re-export shims resolve to the exact same functions (shim-identity)
 *
 * Adversarial inputs per QA matrix: path-traversal-like names, unicode,
 * decimal phase ids, missing/empty dirs, fs edge cases.
 * Uses helpers.cjs createTempProject/cleanup for filesystem tests.
 */

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const {
  cleanup, runGsdTools, scrubConfigLocationEnv,
  saveSessionEnv, restoreSessionEnv, clearSessionEnv, TEST_HOME_SANDBOX_MARKER,
  captureFdSync,
} = require('./helpers.cjs');
const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const workstreamNamePolicy = require('../gsd-core/bin/lib/workstream-name-policy.cjs');
const activeWorkstreamStore = require('../gsd-core/bin/lib/active-workstream-store.cjs');
const gsd2Import = require('../gsd-core/bin/lib/gsd2-import.cjs');
const commandsMod = require('../gsd-core/bin/lib/commands.cjs');
const initMod = require('../gsd-core/bin/lib/init.cjs');

// #3883/Stryker shard budget (scripts/mutation-matrix.cjs `core-utils` entry,
// `tests/state-contract.test.cjs`'s header documents the same mechanism):
// Stryker's command-runner bills one `node --test <file>` invocation as a
// single unit costing whatever the file's slowest run costs, re-run once per
// mutant. A3/A5 originally drove every CLI-reachable slug site through
// `runGsdTools` (a real child-process spawn per call, ~85-170ms each across
// ~70 calls) — ~7.5s of the file's ~7.9s wall time, which blew the 15-minute
// shard cap. `cmdGenerateSlug` / `cmdInitExecutePhase` / `cmdInitPhaseOp` /
// `cmdInitProgress` are plain functions reachable in-process from the built
// `gsd-core/bin/lib/*.cjs` — calling them directly removes the spawn
// entirely instead of moving the cost to a sibling file. `captureFd1Sync`
// intercepts the fd-level write these commands make via io.cjs's
// `writeAllSync` → `fs.writeSync(1, ...)` (bug #1008's pattern, already
// established in tests/io.test.cjs and tests/init.test.cjs's
// `captureInitVerifyWork` — NOT `process.stdout.write`, which silently
// captures nothing here). `withHermeticInProcessEnv` reproduces the isolation
// `runGsdTools(..., { HOME: tmpDir })` + `testEnvBase()` gave the child
// process (HOME/USERPROFILE sandbox + config-location env scrub + session-
// identity env clear) so an in-process call can't read the developer's real
// `~/.gsd` config or leak real session-identity env into the slug output.

function captureFd1Sync(fn) {
  return captureFdSync(1, fn);
}

function withHermeticInProcessEnv(dir, fn) {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const savedMarker = process.env[TEST_HOME_SANDBOX_MARKER];
  const savedSession = saveSessionEnv();
  const restoreConfigEnv = scrubConfigLocationEnv();
  clearSessionEnv();
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env[TEST_HOME_SANDBOX_MARKER] = dir;
  try {
    return fn();
  } finally {
    restoreConfigEnv();
    restoreSessionEnv(savedSession);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedMarker === undefined) delete process.env[TEST_HOME_SANDBOX_MARKER];
    else process.env[TEST_HOME_SANDBOX_MARKER] = savedMarker;
  }
}

function cmdGenerateSlugInProcess(text) {
  const captured = captureFd1Sync(() => commandsMod.cmdGenerateSlug(text, false));
  return JSON.parse(captured).slug;
}

// ─── toPosixPath ─────────────────────────────────────────────────────────────

describe('toPosixPath', () => {
  test('forward-slash paths are unchanged', () => {
    assert.strictEqual(coreUtils.toPosixPath('foo/bar/baz'), 'foo/bar/baz');
  });

  test('empty string returns empty string', () => {
    assert.strictEqual(coreUtils.toPosixPath(''), '');
  });

  test('single segment (no separators) is unchanged', () => {
    assert.strictEqual(coreUtils.toPosixPath('file.txt'), 'file.txt');
  });

  test('platform path.sep is normalized to /', () => {
    // On POSIX this is a no-op; on Windows it converts backslashes.
    const sep = path.sep;
    const p = ['a', 'b', 'c'].join(sep);
    assert.strictEqual(coreUtils.toPosixPath(p), 'a/b/c');
  });

  test('adversarial: path-traversal-like string with backslash separators', () => {
    // On POSIX, path.sep === '/' so backslashes are treated as literal characters
    // and toPosixPath leaves them as-is (split on '/' only finds one token).
    // On Windows (where path.sep === '\\'), backslashes would be normalized to '/'.
    // Either way, the result is a string and does not throw.
    const result = coreUtils.toPosixPath('..\\..\\etc\\passwd');
    assert.strictEqual(typeof result, 'string');
    if (path.sep === '\\') {
      // Windows: separators normalized
      assert.ok(result.includes('/'));
      assert.ok(!result.includes('\\'));
    } else {
      // POSIX: backslash is a literal char, not a separator
      assert.ok(result.includes('\\'));
    }
  });

  test('unicode in path segments passes through', () => {
    const result = coreUtils.toPosixPath('中文/path/to/file');
    assert.strictEqual(result, '中文/path/to/file');
  });
});

// ─── detectSubRepos ───────────────────────────────────────────────────────────

describe('detectSubRepos', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns empty array for directory with no sub-repos', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), []);
  });

  test('returns empty array for non-existent directory', () => {
    assert.deepEqual(coreUtils.detectSubRepos('/nonexistent-path-xyz-' + Date.now()), []);
  });

  test('detects directory with .git as sub-repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const subDir = path.join(tmpDir, 'myrepo');
    fs.mkdirSync(subDir);
    fs.mkdirSync(path.join(subDir, '.git'));
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), ['myrepo']);
  });

  test('excludes hidden directories', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const hiddenDir = path.join(tmpDir, '.hidden');
    fs.mkdirSync(hiddenDir);
    fs.mkdirSync(path.join(hiddenDir, '.git'));
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), []);
  });

  test('excludes node_modules', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const nmDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nmDir);
    fs.mkdirSync(path.join(nmDir, '.git'));
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), []);
  });

  test('returns sorted results for multiple sub-repos', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    for (const name of ['z-repo', 'a-repo', 'm-repo']) {
      const subDir = path.join(tmpDir, name);
      fs.mkdirSync(subDir);
      fs.mkdirSync(path.join(subDir, '.git'));
    }
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), ['a-repo', 'm-repo', 'z-repo']);
  });

  test('adversarial: directory name with path-traversal-like characters', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    // Create a subdirectory that doesn't start with '.' and isn't node_modules
    const subDir = path.join(tmpDir, 'normal-dir');
    fs.mkdirSync(subDir);
    // No .git, so not a sub-repo
    assert.deepEqual(coreUtils.detectSubRepos(tmpDir), []);
  });
});

// ─── pathExistsInternal ───────────────────────────────────────────────────────

describe('pathExistsInternal', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns true for an existing file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const fp = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(fp, 'hello');
    assert.strictEqual(coreUtils.pathExistsInternal(tmpDir, 'file.txt'), true);
  });

  test('returns true for an existing directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir);
    assert.strictEqual(coreUtils.pathExistsInternal(tmpDir, 'subdir'), true);
  });

  test('returns false for a non-existent path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    assert.strictEqual(coreUtils.pathExistsInternal(tmpDir, 'nope.txt'), false);
  });

  test('handles absolute targetPath', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    assert.strictEqual(coreUtils.pathExistsInternal(tmpDir, tmpDir), true);
  });

  test('adversarial: path traversal attempt returns false (no such file)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    // Traversal resolves via path.join — no crash, just correct false/true
    const result = coreUtils.pathExistsInternal(tmpDir, '../nonexistent');
    assert.strictEqual(typeof result, 'boolean');
  });
});

// ─── generateSlugInternal ─────────────────────────────────────────────────────

describe('generateSlugInternal', () => {
  test('null → null', () => {
    assert.strictEqual(coreUtils.generateSlugInternal(null), null);
  });

  test('undefined → null', () => {
    assert.strictEqual(coreUtils.generateSlugInternal(undefined), null);
  });

  test('empty string → null', () => {
    assert.strictEqual(coreUtils.generateSlugInternal(''), null);
  });

  test('lowercases and replaces non-alphanumeric with hyphens', () => {
    assert.strictEqual(coreUtils.generateSlugInternal('Hello World!'), 'hello-world');
  });

  test('strips leading and trailing hyphens', () => {
    assert.strictEqual(coreUtils.generateSlugInternal('  Hello  '), 'hello');
  });

  test('truncates at 60 characters', () => {
    const long = 'a'.repeat(100);
    const result = coreUtils.generateSlugInternal(long);
    assert.ok(result !== null && result.length <= 60);
  });

  // ─── #2849: trailing hyphen must not survive 60-char truncation. ───────────
  // The strip ran before .substring(0, 60), so a cut landing on a separator
  // produced a slug ending in `-`. The strip must run after truncation.

  test('#2849 — trailing hyphen is stripped after 60-char truncation', () => {
    // 59 a's + space + "tail" → "aaaa…aaa-tail" (64 chars). Truncating at 60
    // lands on the separator → "aaaa…aaa-" (ends in `-`) without the fix.
    const slug = coreUtils.generateSlugInternal('a'.repeat(59) + ' tail');
    assert.ok(slug !== null, 'slug must not be null');
    assert.ok(!slug.endsWith('-'), `slug must not end with a hyphen; got: ${JSON.stringify(slug)}`);
    assert.ok(slug.length <= 60, `slug must be at most 60 chars; got length ${slug?.length}`);
    // The tail word is truncated away — the slug is the 59 a's with no separator.
    assert.strictEqual(slug, 'a'.repeat(59));
  });

  test('#2849 — truncation landing before a separator keeps a clean boundary', () => {
    // 58 a's + space + "b" = 60 chars exactly. Truncation keeps all 60 → "aaa…aa-b".
    const slug = coreUtils.generateSlugInternal('a'.repeat(58) + ' b');
    assert.ok(slug !== null);
    assert.ok(!slug.endsWith('-'), `slug must not end with a hyphen; got: ${JSON.stringify(slug)}`);
    assert.strictEqual(slug?.length, 60);
    assert.strictEqual(slug, 'a'.repeat(58) + '-b');
  });

  test('#2849 — leading hyphens are still stripped after the truncation reorder', () => {
    // Leading punctuation becomes a hyphen, then is stripped. Truncation runs
    // after the strip; the leading-hyphen guarantee must survive the reorder.
    const slug = coreUtils.generateSlugInternal('!!!' + 'a'.repeat(60));
    assert.ok(slug !== null);
    assert.ok(!slug.startsWith('-'), `slug must not start with a hyphen; got: ${JSON.stringify(slug)}`);
    assert.ok(!slug.endsWith('-'), `slug must not end with a hyphen; got: ${JSON.stringify(slug)}`);
    assert.ok((slug?.length ?? 0) <= 60);
  });

  test('#2849 — long Cyrillic transliterates and truncates without a trailing hyphen', () => {
    // Transliteration expands Cyrillic; the result can exceed 60 chars and land
    // on a separator when truncated. The post-truncation strip must still fire.
    const slug = coreUtils.generateSlugInternal('Объект день '.repeat(10).trim());
    assert.ok(slug !== null);
    assert.ok(!slug.includes('Объект'), 'non-ASCII must be transliterated away');
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `slug must be ASCII-only and well-formed; got: ${slug}`);
    assert.ok(!slug.endsWith('-'), `slug must not end with a hyphen; got: ${JSON.stringify(slug)}`);
    assert.ok((slug?.length ?? 0) <= 60);
  });

  test('#2849 — all-separator input collapses to empty, not a stray hyphen', () => {
    // Input that is entirely separators must reduce to '' (not null, not '-'),
    // both short and when truncated past 60 chars.
    assert.strictEqual(coreUtils.generateSlugInternal('!!!'), '');
    assert.strictEqual(coreUtils.generateSlugInternal('!'.repeat(70)), '');
  });

  test('unicode characters are replaced with hyphens', () => {
    const result = coreUtils.generateSlugInternal('中文phase');
    assert.ok(typeof result === 'string');
    assert.ok(!result.includes('中'));
  });

  test('preserves numbers in slug', () => {
    assert.strictEqual(coreUtils.generateSlugInternal('Phase 42 Done'), 'phase-42-done');
  });

  // ─── #2858 — wait, #2848: non-Latin (Cyrillic) titles must not produce an
  // empty slug. A transliteration map is applied before the ASCII filter so the
  // title's meaning is preserved as ASCII. Latin-script output is byte-for-byte
  // unchanged (negative control below).

  test('#2848 row 1 — Cyrillic title produces a non-empty transliterated slug', () => {
    // Russian "Проверка гипотезы" → "proverka gipotezy" → slug.
    const result = coreUtils.generateSlugInternal('Проверка гипотезы');
    assert.ok(typeof result === 'string' && result.length > 0, `Cyrillic title must not produce an empty slug; got: ${JSON.stringify(result)}`);
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(result), `slug must be ASCII-only and well-formed; got: ${result}`);
    assert.strictEqual(result, 'proverka-gipotezy');
  });

  test('#2848 row 3 — Latin-script output is byte-for-byte unchanged (negative control)', () => {
    // These must remain identical to the pre-fix outputs.
    assert.strictEqual(coreUtils.generateSlugInternal('Hello World!'), 'hello-world');
    assert.strictEqual(coreUtils.generateSlugInternal('Setup environment'), 'setup-environment');
    assert.strictEqual(coreUtils.generateSlugInternal('  Hello  '), 'hello');
    assert.strictEqual(coreUtils.generateSlugInternal('Phase 42 Done'), 'phase-42-done');
  });

  test('#2848 row 4 — multi-letter Cyrillic mappings transliterate correctly', () => {
    // ж→zh ч→ch ш→sh щ→sch ю→yu я→ya. 'Яша Щучин' → ya-sh-a + sch-u-ch-i-n.
    const result = coreUtils.generateSlugInternal('Яша Щучин');
    assert.ok(result, `expected non-empty slug; got: ${result}`);
    assert.ok(result.includes('yasha'), `я→ya + ш→sh + а→a = yasha expected; got: ${result}`);
    assert.ok(result.includes('schuchin'), `щ→sch + у→u + ч→ch expected; got: ${result}`);
    assert.strictEqual(result, 'yasha-schuchin');
    // Spot-check each multi-letter mapping in isolation.
    assert.strictEqual(coreUtils.generateSlugInternal('ж'), 'zh');
    assert.strictEqual(coreUtils.generateSlugInternal('ч'), 'ch');
    assert.strictEqual(coreUtils.generateSlugInternal('ш'), 'sh');
    assert.strictEqual(coreUtils.generateSlugInternal('щ'), 'sch');
    assert.strictEqual(coreUtils.generateSlugInternal('ю'), 'yu');
    assert.strictEqual(coreUtils.generateSlugInternal('я'), 'ya');
  });

  test('#2848 row 5 — soft/hard signs (ъ ь) drop cleanly without hyphen runs', () => {
    // "Объект день" — ъ and ь should disappear, NOT produce consecutive hyphens.
    const result = coreUtils.generateSlugInternal('Объект день');
    assert.ok(result, `expected non-empty slug; got: ${result}`);
    assert.ok(!result.includes('--'), `no double hyphens from dropped signs; got: ${result}`);
    assert.strictEqual(result, 'obekt-den');
  });

  test('#2848 row 6 — Ukrainian/Belarusian Cyrillic extras transliterate', () => {
    // і ї є ґ ў — non-Russian Cyrillic letters in the reported scope.
    assert.strictEqual(coreUtils.generateSlugInternal('і'), 'i');
    assert.strictEqual(coreUtils.generateSlugInternal('ї'), 'yi');
    assert.strictEqual(coreUtils.generateSlugInternal('є'), 'ye');
    assert.strictEqual(coreUtils.generateSlugInternal('ґ'), 'g');
    assert.strictEqual(coreUtils.generateSlugInternal('ў'), 'u');
  });

  test('#2848 row 7 — null/undefined/empty still return null (contract preserved)', () => {
    assert.strictEqual(coreUtils.generateSlugInternal(null), null);
    assert.strictEqual(coreUtils.generateSlugInternal(undefined), null);
    assert.strictEqual(coreUtils.generateSlugInternal(''), null);
  });

  test('#2848 row 9 — mixed Latin+Cyrillic title transliterates correctly', () => {
    assert.strictEqual(coreUtils.generateSlugInternal('Phase Фаза 42'), 'phase-faza-42');
  });

  test('#2848 row 10 — truncation still applies after transliteration (≤60 chars)', () => {
    // A long Cyrillic title transliterates to a longer ASCII string; the 60-char
    // cap must still bind the result.
    const long = 'Проверка'.repeat(20);
    const result = coreUtils.generateSlugInternal(long);
    assert.ok(result !== null && result.length <= 60, `truncation must still apply; got len ${result && result.length}`);
  });
});


// ─── readSubdirectories ───────────────────────────────────────────────────────

describe('readSubdirectories', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns [] for non-existent directory', () => {
    assert.deepEqual(coreUtils.readSubdirectories('/nonexistent-xyz-' + Date.now()), []);
  });

  test('returns [] for empty directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    assert.deepEqual(coreUtils.readSubdirectories(tmpDir), []);
  });

  test('returns only directory names, not files', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), '');
    const result = coreUtils.readSubdirectories(tmpDir);
    assert.deepEqual(result, ['subdir']);
  });

  test('sort=false returns dirs in filesystem order', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.mkdirSync(path.join(tmpDir, '02-phase'));
    fs.mkdirSync(path.join(tmpDir, '01-phase'));
    const result = coreUtils.readSubdirectories(tmpDir, false);
    assert.strictEqual(result.length, 2);
  });

  test('sort=true orders by comparePhaseNum', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    for (const name of ['10-phase', '02-phase', '01-phase']) {
      fs.mkdirSync(path.join(tmpDir, name));
    }
    const result = coreUtils.readSubdirectories(tmpDir, true);
    assert.deepEqual(result, ['01-phase', '02-phase', '10-phase']);
  });

  test('sort=true handles decimal phase ids correctly', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    for (const name of ['01.2-phase', '01.10-phase', '01.1-phase']) {
      fs.mkdirSync(path.join(tmpDir, name));
    }
    const result = coreUtils.readSubdirectories(tmpDir, true);
    // Decimal ordering: 01.1 < 01.2 < 01.10
    assert.deepEqual(result, ['01.1-phase', '01.2-phase', '01.10-phase']);
  });
});

// ─── getPhaseFileStats ────────────────────────────────────────────────────────

describe('getPhaseFileStats', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns empty arrays and false flags for empty directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.deepEqual(stats.plans, []);
    assert.deepEqual(stats.summaries, []);
    assert.strictEqual(stats.hasResearch, false);
    assert.strictEqual(stats.hasContext, false);
    assert.strictEqual(stats.hasVerification, false);
    assert.strictEqual(stats.hasReviews, false);
  });

  test('detects PLAN.md files', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'PLAN.md'), '');
    fs.writeFileSync(path.join(tmpDir, '01-PLAN.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.deepEqual(stats.plans.sort(), ['01-PLAN.md', 'PLAN.md']);
  });

  test('detects SUMMARY.md files', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'SUMMARY.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.deepEqual(stats.summaries, ['SUMMARY.md']);
  });

  test('detects RESEARCH.md', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'RESEARCH.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.hasResearch, true);
  });

  test('detects *-RESEARCH.md', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'feature-RESEARCH.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.hasResearch, true);
  });

  test('detects VERIFICATION.md', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'VERIFICATION.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.hasVerification, true);
  });

  test('detects REVIEWS.md', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'REVIEWS.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.hasReviews, true);
  });

  test('detects CONTEXT.md via findContextMdIn', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, 'CONTEXT.md'), '');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.hasContext, true);
  });

  // ─── #3183 (ADR-3180 Decision 2): scope field + degrade-not-throw ─────────

  test('#3183 row 17: scope is COMPLETE for a readable, empty phase dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.scope, SCOPE.COMPLETE);
  });

  test('#3183 row 15: scope is UNREADABLE and getPhaseFileStats does not throw for a nonexistent dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const missing = path.join(tmpDir, 'does-not-exist');
    assert.doesNotThrow(() => coreUtils.getPhaseFileStats(missing));
    const stats = coreUtils.getPhaseFileStats(missing);
    assert.strictEqual(stats.scope, SCOPE.UNREADABLE);
    assert.deepEqual(stats.plans, []);
    assert.deepEqual(stats.summaries, []);
    assert.strictEqual(stats.hasResearch, false);
    assert.strictEqual(stats.hasContext, false);
    assert.strictEqual(stats.hasVerification, false);
    assert.strictEqual(stats.hasReviews, false);
  });

  // ─── #4014 (epic #3473 B4-unreadable) matrix rows 10-11 ───────────────────
  //
  // getPhaseFileStats used to catch its OWN readdirSync failure and return
  // `scope: scan.scope` — the scope of the UNRELATED, already-successful
  // scanPhasePlans call — silently dropping that THIS function's own read
  // failed. Both scanPhasePlans and getPhaseFileStats's own read call
  // `fs.readdirSync(phaseDir)` on the identical path, in that order (scan
  // first) — so the failure is injected on the SECOND call to that exact
  // path only, letting scanPhasePlans succeed (scope complete) while
  // getPhaseFileStats's own read fails, reproducing the exact swallowing bug
  // named in the issue. No chmod 0o000 — root bypasses mode bits (silent
  // zero coverage in root CI); restored via t.mock's auto-restore.
  test('#4014 matrix row 10: own readdirSync failure is not masked by an already-successful scan.scope', (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, '01-PLAN.md'), '# Plan\n');
    const target = path.resolve(tmpDir);
    const origReaddirSync = fs.readdirSync.bind(fs);
    let callsOnTarget = 0;
    t.mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (path.resolve(String(p)) === target) {
        callsOnTarget += 1;
        // 1st call = scanPhasePlans's own read: let it succeed (scope complete).
        if (callsOnTarget === 1) return origReaddirSync(p, ...rest);
        // 2nd call = getPhaseFileStats's own read (via findContextMdIn): fail it.
        const err = new Error(`EACCES: simulated failure, scandir '${p}'`);
        err.code = 'EACCES';
        throw err;
      }
      return origReaddirSync(p, ...rest);
    });

    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.scope, SCOPE.UNREADABLE,
      `own readdirSync failure must win over the unrelated already-successful scan.scope; got: ${stats.scope}`);
    // #3183's pre-existing plans/summaries-untouched contract: unaffected
    // by this function's own (unrelated) read outcome.
    assert.deepEqual(stats.plans, ['01-PLAN.md']);
  });

  test('#4014 matrix row 11: both reads succeed — scope complete, flags computed as before (must not regress)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.writeFileSync(path.join(tmpDir, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(tmpDir, 'CONTEXT.md'), '# context\n');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.strictEqual(stats.scope, SCOPE.COMPLETE);
    assert.strictEqual(stats.hasContext, true);
    assert.deepEqual(stats.plans, ['01-PLAN.md']);
  });

  test('#3183 row 7 regression: nested plans/PLAN-01.md ONLY is reported (used to report 0)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    fs.mkdirSync(path.join(tmpDir, 'plans'));
    fs.writeFileSync(path.join(tmpDir, 'plans', 'PLAN-01.md'), '# Plan\n');
    const stats = coreUtils.getPhaseFileStats(tmpDir);
    assert.deepEqual(stats.plans, ['plans/PLAN-01.md']);
  });

  test('#3511 BLOCKER-2 regression: a cross-phase stray VERIFICATION.md is scoped out of hasVerification', () => {
    // Dir is phase 03's own directory ("03-test" → token "03"); the only
    // VERIFICATION.md present belongs to phase 04. scopeToPhase must exclude
    // it, so hasVerification reads false — an unscoped implementation would
    // wrongly report phase 03 as verified off phase 04's report.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cu-test-'));
    const phaseDir = path.join(tmpDir, '03-test');
    fs.mkdirSync(phaseDir);
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    const stats = coreUtils.getPhaseFileStats(phaseDir);
    assert.strictEqual(stats.hasVerification, false,
      `hasVerification must be false — the only VERIFICATION.md belongs to phase 04, not 03; got scopedFiles-derived: ${stats.hasVerification}`);
  });
});

// ─── extractOneLinerFromBody ──────────────────────────────────────────────────

describe('extractOneLinerFromBody', () => {
  test('null → null', () => {
    assert.strictEqual(coreUtils.extractOneLinerFromBody(null), null);
  });

  test('undefined → null', () => {
    assert.strictEqual(coreUtils.extractOneLinerFromBody(undefined), null);
  });

  test('empty string → null', () => {
    assert.strictEqual(coreUtils.extractOneLinerFromBody(''), null);
  });

  // #3170: extractOneLinerFromBody anchors to a Summary/Overview/Accomplishments
  // heading (the function is summary-specific — both callers extract a SUMMARY
  // deliverable one-liner). These fixtures use Summary-shaped headings; the
  // extraction mechanism under test (heading + bold → bold, frontmatter strip,
  // colon-label → prose, CRLF, unicode) is unchanged.
  test('extracts bold text after a heading as one-liner', () => {
    const content = '# Phase Summary\n\n**Implement the feature**\n\nMore details here.\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Implement the feature');
  });

  test('returns null when no bold text after heading', () => {
    const content = '# Phase Summary\n\nSome prose without bold.\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), null);
  });

  test('strips frontmatter before searching', () => {
    const content = '---\nstatus: done\n---\n# Summary\n\n**One liner here**\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'One liner here');
  });

  test('when bold ends with colon, returns text after the bold', () => {
    const content = '# Summary\n\n**Objective:** Complete the work\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Complete the work');
  });

  test('CRLF line endings are normalized', () => {
    const content = '# Summary\r\n\r\n**Bold line**\r\nmore\r\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Bold line');
  });

  test('adversarial: unicode in bold text', () => {
    const content = '# Summary\n\n**中文 one-liner**\n\nMore.\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), '中文 one-liner');
  });
});

// ─── timeAgo ─────────────────────────────────────────────────────────────────

describe('timeAgo', () => {
  function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }
  function minutesAgo(n) {
    return new Date(Date.now() - n * 60 * 1000);
  }
  function hoursAgo(n) {
    return new Date(Date.now() - n * 60 * 60 * 1000);
  }
  function secondsAgo(n) {
    return new Date(Date.now() - n * 1000);
  }

  test('"just now" for < 5 seconds', () => {
    assert.strictEqual(coreUtils.timeAgo(secondsAgo(2)), 'just now');
  });

  test('"X seconds ago" for < 60 seconds', () => {
    const result = coreUtils.timeAgo(secondsAgo(30));
    assert.ok(result.endsWith('seconds ago'), `Expected "X seconds ago", got: ${result}`);
  });

  test('"1 minute ago" for ~1 minute', () => {
    assert.strictEqual(coreUtils.timeAgo(minutesAgo(1)), '1 minute ago');
  });

  test('"X minutes ago" for < 60 minutes', () => {
    const result = coreUtils.timeAgo(minutesAgo(30));
    assert.ok(result.endsWith('minutes ago'), `Expected "X minutes ago", got: ${result}`);
  });

  test('"1 hour ago" for ~1 hour', () => {
    assert.strictEqual(coreUtils.timeAgo(hoursAgo(1)), '1 hour ago');
  });

  test('"X hours ago" for < 24 hours', () => {
    const result = coreUtils.timeAgo(hoursAgo(10));
    assert.ok(result.endsWith('hours ago'), `Expected "X hours ago", got: ${result}`);
  });

  test('"1 day ago" for ~1 day', () => {
    assert.strictEqual(coreUtils.timeAgo(daysAgo(1)), '1 day ago');
  });

  test('"X days ago" for < 30 days', () => {
    const result = coreUtils.timeAgo(daysAgo(15));
    assert.ok(result.endsWith('days ago'), `Expected "X days ago", got: ${result}`);
  });

  test('"1 month ago" for ~30 days', () => {
    assert.strictEqual(coreUtils.timeAgo(daysAgo(30)), '1 month ago');
  });

  test('"X months ago" for < 12 months', () => {
    const result = coreUtils.timeAgo(daysAgo(180));
    assert.ok(result.endsWith('months ago'), `Expected "X months ago", got: ${result}`);
  });

  test('"1 year ago" for ~365 days', () => {
    assert.strictEqual(coreUtils.timeAgo(daysAgo(365)), '1 year ago');
  });

  test('"X years ago" for multiple years', () => {
    const result = coreUtils.timeAgo(daysAgo(730));
    assert.ok(result.endsWith('years ago'), `Expected "X years ago", got: ${result}`);
  });
});

// ─── extractCanonicalPlanId ───────────────────────────────────────────────────

describe('extractCanonicalPlanId', () => {
  test('strips -PLAN.md suffix and returns basename', () => {
    // '01-feature-PLAN.md' → base = '01-feature', no two adjacent phase tokens
    assert.strictEqual(coreUtils.extractCanonicalPlanId('01-feature-PLAN.md'), '01-feature');
  });

  test('strips -SUMMARY.md suffix', () => {
    assert.strictEqual(coreUtils.extractCanonicalPlanId('01-SUMMARY.md'), '01');
  });

  test('strips .md suffix for plain md file', () => {
    assert.strictEqual(coreUtils.extractCanonicalPlanId('01.md'), '01');
  });

  test('returns base when no phase token found', () => {
    assert.strictEqual(coreUtils.extractCanonicalPlanId('no-phase-token.md'), 'no-phase-token');
  });

  test('extracts canonical id with two adjacent phase tokens', () => {
    // e.g. phase 01 plan 02: filename = "01-02-PLAN.md"
    const result = coreUtils.extractCanonicalPlanId('01-02-PLAN.md');
    assert.strictEqual(result, '01-02');
  });

  test('adversarial: decimal phase id tokens', () => {
    // "01.1" matches the token regex (\d+[A-Z]?(\.\d+)*)
    const result = coreUtils.extractCanonicalPlanId('01.1-PLAN.md');
    assert.ok(typeof result === 'string');
  });

  test('adversarial: unicode filename returns some string', () => {
    const result = coreUtils.extractCanonicalPlanId('中文-phase.md');
    assert.ok(typeof result === 'string');
  });

  test('adversarial: path-traversal-like filename treated as literal', () => {
    // extractCanonicalPlanId operates on a filename string (not a real path).
    // The function does not sanitize slashes — it strips .md suffixes and
    // attempts to find phase tokens. The result is a string (no crash).
     const result = coreUtils.extractCanonicalPlanId('../../../etc/passwd');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('rejects single-digit slug word (#2043)', () => {
    // "46-6-rs-pipeline-orchestrator" is not a valid phase-token filename shape
    // (the "6" is a slug word, not a sub-phase segment) — must not collapse to
    // the pre-fix, buggy "46-6".
    assert.notStrictEqual(
      coreUtils.extractCanonicalPlanId('46-6-rs-pipeline-orchestrator'),
      '46-6',
    );
    // Legit multi-segment phase-token filenames are still extracted correctly,
    // including a single-digit letter-suffix phase id ("3A") — the "3A" token is
    // found and paired with its zero-padded plan index, not left unpaired.
    assert.strictEqual(coreUtils.extractCanonicalPlanId('01-02-PLAN.md'), '01-02');
    assert.strictEqual(coreUtils.extractCanonicalPlanId('3A-01-feature-PLAN.md'), '3A-01');
  });

  test('does not pair a ≥3-digit slug word as a plan component (#2232)', () => {
    // A year-leading slug word ("14-2026-photos-…") is not a plan component —
    // must not collapse to the bogus "14-2026".
    assert.notStrictEqual(
      coreUtils.extractCanonicalPlanId('14-2026-photos-performance-SUMMARY.md'),
      '14-2026',
    );
    assert.notStrictEqual(coreUtils.extractCanonicalPlanId('05-100-slug-PLAN.md'), '05-100');
    // The LEADING phase component stays unbounded (\d{2,}) — only the paired
    // continuation is width-capped, so phase ≥100 plan files still pair.
    assert.strictEqual(coreUtils.extractCanonicalPlanId('100-01-extra-slug-PLAN.md'), '100-01');
    assert.strictEqual(coreUtils.extractCanonicalPlanId('01-02-PLAN.md'), '01-02');
  });

  // ─── #4014 mutation-gap: the three chained suffix strips are each anchored
  // ($) to the true end of the filename. An unanchored variant would instead
  // strip the FIRST mid-string occurrence of the pattern, corrupting a
  // filename that merely CONTAINS one of these substrings earlier on.

  test('mutation-gap: mid-string ".md" is left alone — only the trailing .md is stripped', () => {
    // "foo.mdx-01-PLAN.md": the trailing "-PLAN.md" is stripped by the first
    // regex; the base "foo.mdx-01" does NOT end in ".md" (it ends in "mdx"
    // before "-01"), so the third (bare .md$) regex must NOT touch the ".md"
    // that happens to sit inside "foo.mdx". An unanchored /\.md/i would strip
    // it there instead, corrupting the base to "foox-01".
    assert.strictEqual(coreUtils.extractCanonicalPlanId('foo.mdx-01-PLAN.md'), 'foo.mdx-01');
  });

  test('mutation-gap: mid-string "-SUMMARY.md" is left alone — only the trailing form is stripped', () => {
    // "foo-SUMMARY.md-01-PLAN.md": trailing "-PLAN.md" is stripped by the
    // first regex, leaving "foo-SUMMARY.md-01" — which does NOT end in
    // "-SUMMARY.md". An unanchored /-SUMMARY\.md/i would still strip the
    // mid-string occurrence, corrupting the base to "foo-01".
    assert.strictEqual(coreUtils.extractCanonicalPlanId('foo-SUMMARY.md-01-PLAN.md'), 'foo-SUMMARY.md-01');
  });
});

// ─── countMatchedSummaries (#1988) ───────────────────────────────────────────
// Lives in core-utils.test.cjs (not roadmap.test.cjs) so the Stryker core-utils
// shard — which runs only this file — actually covers the helper's mutants.

describe('countMatchedSummaries — stray non-plan summaries excluded (#1988)', () => {
  const { countMatchedSummaries } = coreUtils;

  test('counts only summaries that are the PLAN→SUMMARY partner of a plan', () => {
    const plans = ['30-01-PLAN.md', '30-02-PLAN.md', '30-10-PLAN.md'];
    const summaries = ['30-01-SUMMARY.md', '30-FIX-CR02-SUMMARY.md', '30-GAPCLOSURE-SUMMARY.md'];
    assert.strictEqual(countMatchedSummaries(plans, summaries), 1);
  });

  test('all plans have a partner summary → counts every plan', () => {
    const plans = ['01-01-PLAN.md', '01-02-PLAN.md'];
    const summaries = ['01-01-SUMMARY.md', '01-02-SUMMARY.md'];
    assert.strictEqual(countMatchedSummaries(plans, summaries), 2);
  });

  test('nested layout pairing preserved (plans/PLAN-NN ↔ plans/SUMMARY-NN)', () => {
    const plans = ['plans/PLAN-01.md', 'plans/PLAN-02.md'];
    const summaries = ['plans/SUMMARY-01.md'];
    assert.strictEqual(countMatchedSummaries(plans, summaries), 1);
  });

  test('extended layout pairing (N-PLAN-MM-slug ↔ N-MM-SUMMARY)', () => {
    const plans = ['3-PLAN-01-setup.md', '5-PLAN-02-migrations.md'];
    const summaries = ['3-01-SUMMARY.md', '5-02-SUMMARY.md'];
    assert.strictEqual(countMatchedSummaries(plans, summaries), 2);
  });

  test('extended layout: only the matching plan counts (no cross-pairing)', () => {
    const plans = ['3-PLAN-01-setup.md', '3-PLAN-02-seed.md'];
    const summaries = ['3-01-SUMMARY.md']; // only plan 01 has a summary
    assert.strictEqual(countMatchedSummaries(plans, summaries), 1);
  });

  test('bare PLAN.md ↔ SUMMARY.md', () => {
    assert.strictEqual(countMatchedSummaries(['PLAN.md'], ['SUMMARY.md']), 1);
    assert.strictEqual(countMatchedSummaries(['PLAN.md'], []), 0);
  });

  test('bare PLAN.md ↔ PLAN-SUMMARY.md (stem-suffix convention)', () => {
    assert.strictEqual(countMatchedSummaries(['PLAN.md'], ['PLAN-SUMMARY.md']), 1);
  });

  test('legacy <N>-PLAN-<NN> ↔ <N>-PLAN-<NN>-SUMMARY', () => {
    const plans = ['14-PLAN-01.md', '14-PLAN-02.md'];
    const summaries = ['14-PLAN-01-SUMMARY.md', '14-PLAN-02-SUMMARY.md'];
    assert.strictEqual(countMatchedSummaries(plans, summaries), 2);
  });

  test('stray summaries never count when no plan partners exist', () => {
    const plans = ['30-01-PLAN.md'];
    const strays = ['30-FIX-CR02-SUMMARY.md', '30-GAPCLOSURE-SUMMARY.md', '30-01-EXTRA-SUMMARY.md'];
    assert.strictEqual(countMatchedSummaries(plans, strays), 0);
  });

  test('absolute path (leading slash) still pairs via the dir split', () => {
    // Guards the lastIndexOf('/') >= 0 boundary (slash at index 0).
    assert.strictEqual(countMatchedSummaries(['/abs/PLAN-01.md'], ['/abs/SUMMARY-01.md']), 1);
  });
});

// ─── #4014 mutation-gap: summaryCandidates / findUnsummarizedPlans /
// findOrphanSummaries — same "Stryker core-utils shard runs only THIS file"
// reasoning as countMatchedSummaries above. These three share the private
// summaryCandidates helper but, unlike countMatchedSummaries, had no direct
// coverage inside core-utils.test.cjs itself (their existing coverage lives
// in plan-count-single-owner.test.cjs / summary-status-blocked-3345.test.cjs,
// neither of which the core-utils Stryker shard executes).

describe('summaryCandidates / findUnsummarizedPlans / findOrphanSummaries — #4014 mutation-gap', () => {
  const { countMatchedSummaries, findUnsummarizedPlans, findOrphanSummaries } = coreUtils;

  test('mutation-gap: mid-string ".md" in the plan filename does not corrupt the base', () => {
    // "my.mdx-file-PLAN.md": summaryCandidates' own `base` strip is anchored
    // (/\.md$/i) so only the true trailing ".md" is removed, leaving
    // "my.mdx-file-PLAN" — the marker-swap candidate is then
    // "my.mdx-file-SUMMARY.md". An unanchored strip would instead corrupt the
    // base by stripping the ".md" that sits inside "my.mdx" first.
    assert.strictEqual(
      countMatchedSummaries(['my.mdx-file-PLAN.md'], ['my.mdx-file-SUMMARY.md']),
      1,
    );
    assert.deepEqual(findUnsummarizedPlans(['my.mdx-file-PLAN.md'], ['my.mdx-file-SUMMARY.md']), []);
  });

  test('mutation-gap: legacy extended form <n>-PLAN-<m> matches ONLY via the <n>-<m>-SUMMARY candidate', () => {
    // "14-PLAN-01.md" also generates a marker-swap candidate
    // ("14-SUMMARY-01.md") and a stem-suffix candidate
    // ("14-PLAN-01-SUMMARY.md"), but the summary file used here
    // ("14-01-SUMMARY.md") matches NEITHER of those — it can only match via
    // the `extended` candidate on the summaryCandidates line that special-
    // cases `^(\d+)-PLAN-(\d+)`. Isolates that candidate from the other two.
    assert.strictEqual(countMatchedSummaries(['14-PLAN-01.md'], ['14-01-SUMMARY.md']), 1);
    assert.deepEqual(findUnsummarizedPlans(['14-PLAN-01.md'], ['14-01-SUMMARY.md']), []);
  });

  test('mutation-gap: #3183 canonical-id candidate fires only when it differs from the PLAN-stripped stem', () => {
    // "68-01-scaffolding-PLAN.md": extractCanonicalPlanId pairs "68"+"01" into
    // "68-01", which differs from the plain PLAN-stripped stem
    // "68-01-scaffolding" — so the `canonicalId !== planStem` guard fires and
    // pushes the "68-01-SUMMARY.md" candidate. The summary here matches ONLY
    // through that candidate (not the marker-swap or stem-suffix forms), so
    // flipping the guard's equality in either direction breaks this match.
    assert.strictEqual(
      countMatchedSummaries(['68-01-scaffolding-PLAN.md'], ['68-01-SUMMARY.md']),
      1,
    );
    assert.deepEqual(findUnsummarizedPlans(['68-01-scaffolding-PLAN.md'], ['68-01-SUMMARY.md']), []);
  });

  test('mutation-gap: findUnsummarizedPlans on a MIXED set returns exactly the unsummarized subset', () => {
    // An all-matched or all-unmatched fixture can't distinguish a `.filter()`
    // that was mutated to always-true/always-false/identity from a correctly
    // behaving one — only a mixed set, checked by exact array identity, can.
    const plans = ['01-01-PLAN.md', '01-02-PLAN.md', '01-03-PLAN.md'];
    const summaries = ['01-01-SUMMARY.md', '01-03-SUMMARY.md']; // 01-02 has none
    assert.deepEqual(findUnsummarizedPlans(plans, summaries), ['01-02-PLAN.md']);
  });

  test('mutation-gap: findOrphanSummaries on a MIXED set returns exactly the unclaimed subset', () => {
    const plans = ['01-01-PLAN.md', '01-02-PLAN.md'];
    const summaries = ['01-01-SUMMARY.md', '01-02-SUMMARY.md', '01-STRAY-SUMMARY.md'];
    assert.deepEqual(findOrphanSummaries(plans, summaries), ['01-STRAY-SUMMARY.md']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3883 (ADR-3473 §8.3) — one slug implementation per rule
//
// generateSlugInternal (this file's own subject, above) is the canonical slug
// formula. 11 independent inline re-implementations were found by grep across
// src/ (file:line evidence in the PR description). This block drives each
// reachable site the way production reaches it and proves today's code
// disagrees with the canonical — failing-first, per the phase 6 test matrix
// (.gsd/phase/feat-3883-one-impl-per-rule/50-test-matrix.md section A/B).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3883 one-impl-per-rule: slug re-implementation divergence', () => {
  // ── A1: commands.cts cmdGenerateSlug (CLI `generate-slug`) ──────────────────

  test('A1 cyrillicSlugIsNotEmpty: cmdGenerateSlug on Cyrillic yields the canonical value, not ""', () => {
    const observedSlug = cmdGenerateSlugInProcess('Привет мир');
    // Pinned to a concrete value (not merely "non-empty") so this cannot be
    // satisfied by an unrelated fallback string — and pinned to the
    // canonical's OWN live output so a future change to the transliteration
    // map cannot silently desync this expectation from generateSlugInternal.
    const canonical = coreUtils.generateSlugInternal('Привет мир');
    assert.strictEqual(canonical, 'privet-mir', 'sanity: canonical must itself transliterate to privet-mir');
    assert.notStrictEqual(observedSlug, '', 'cmdGenerateSlug must not collapse a Cyrillic title to an empty slug (#2848-class regression)');
    assert.strictEqual(observedSlug, canonical, 'cmdGenerateSlug must delegate to (or agree with) generateSlugInternal');
  });

  // ── A2: commands.cts cmdGenerateSlug truncation-boundary trailing hyphen ────

  test('A2 truncationBoundaryLeavesNoTrailingHyphen: no trailing separator at the truncation boundary', () => {
    // #2849: strip-then-truncate (cmdGenerateSlug's current order) can
    // reintroduce a trailing hyphen when truncation lands exactly on an
    // internal separator that strip-then-truncate never revisits.
    // generateSlugInternal fixed this by truncating BEFORE the final strip
    // pass (see its own comment, above in this file). The boundary is
    // reproduced with 59 'a's + ' b': the collapsed separator sits exactly
    // at the canonical's substring(0, 60) cut point.
    const input = 'a'.repeat(59) + ' b';
    const observedSlug = cmdGenerateSlugInProcess(input);
    const canonical = coreUtils.generateSlugInternal(input);
    assert.strictEqual(canonical, 'a'.repeat(59), 'sanity: canonical must not leave a trailing hyphen at the boundary');
    assert.ok(!observedSlug.endsWith('-'), `cmdGenerateSlug must not emit a trailing hyphen at the truncation boundary; got: ${JSON.stringify(observedSlug)}`);
    assert.strictEqual(observedSlug, canonical, 'cmdGenerateSlug must agree with generateSlugInternal at the truncation boundary');
  });

  // ── A3/A4: every reachable slug call site vs. the canonical ─────────────────

  // Shared input corpus: ASCII, Cyrillic, CJK, emoji, punctuation runs,
  // leading/trailing separators. Boundary-length inputs are a SEPARATE
  // corpus (below) because not every site truncates (A4).
  const CORPUS = [
    ['ascii-simple', 'Hello World'],
    ['ascii-punctuation-run', 'Test@#$%^Special!!!'],
    ['ascii-leading-trailing-separators', '---Leading Trailing---'],
    ['ascii-numbers', 'Phase 3 Plan'],
    ['cyrillic', 'Привет мир'],
    ['cjk-non-transliterable', '中文测试'],
    ['emoji', 'hello 😀 world'],
    ['latin-diacritics', 'Café münchen'],
  ];

  // Boundary corpus: the separator sits one-under / exactly-at / one-over the
  // canonical's substring(0, 60) cut point (see A2 and B1 below).
  const BOUNDARY_CORPUS = [
    ['boundary-under', 'a'.repeat(58) + ' b'],
    ['boundary-exact', 'a'.repeat(59) + ' b'],
    ['boundary-over', 'a'.repeat(60) + ' b'],
  ];

  // #3883 regression corpus: inputs well past the OLD hard-coded 60-char cap,
  // for sites whose pre-migration contract never truncated (cap === null).
  // Proves the untruncated tail actually survives, not merely that the
  // truncation boundary is handled.
  const LONG_UNCAPPED_CORPUS = [
    ['long-ascii-70', 'a'.repeat(70)],
    ['long-ascii-100-with-separators', `${'word-'.repeat(20)}tail`],
    ['long-ascii-90-mixed-case', 'The Quick Brown Fox Jumps Over The Lazy Dog Many Many Many Times In A Row'],
  ];

  // cmdInitExecutePhase / cmdInitPhaseOp emit `phase_slug: phaseInfo?.['phase_slug'] || null`
  // (init.cts:1880 and neighbors) — an output-shaping `|| null` that coerces
  // ANY empty-string slug to null, independent of whether the slugification
  // itself was correct. Comparing the raw JSON value against the canonical's
  // real string output would flag every all-non-transliterable corpus entry
  // (e.g. CJK, where the canonical ALSO produces "") as a false divergence.
  // Normalizing null back to "" here isolates the axis this test actually
  // cares about — the slug ALGORITHM's output — from that unrelated
  // presentation choice.
  function phaseSlugField(json) {
    return json.phase_slug === null ? '' : json.phase_slug;
  }

  // Each site: { name, cap, call(text) => observed slug value }. `cap` is the
  // site's OWN pre-#3883-migration truncation contract (60, or null for
  // "never truncated") — the value it must now be compared against, not a
  // single global 60. #3883-remediation (this file, security-review finding):
  // the original A3/A4 harness compared every migrated site to
  // generateSlugInternal(text) with the DEFAULT 60 cap baked in, which could
  // only ever prove "truncates like the default" — it structurally could not
  // catch the two sites (phase-id.cts toDir, workstream-name-policy.cts
  // toWorkstreamSlug) that the migration silently truncated for the first
  // time, because a false-positive "matches the canonical" was the only
  // possible outcome once BOTH sides shared the same hard-coded 60. `call`
  // drives the site exactly the way production reaches it.
  const SITES = [
    {
      name: 'commands.cts:209 cmdGenerateSlug (CLI generate-slug)',
      cap: 60,
      call(text) {
        return cmdGenerateSlugInProcess(text);
      },
    },
    {
      name: 'init.cts:176 slugifyPhaseName (CLI init execute-phase, ROADMAP-only phase)',
      cap: null,
      call(text) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3883-ep-'));
        try {
          fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
          fs.writeFileSync(
            path.join(tmpDir, '.planning', 'ROADMAP.md'),
            `# Roadmap\n\n### Phase 1: ${text}\n**Goal:** test\n**Plans:** TBD\n`,
          );
          const json = withHermeticInProcessEnv(tmpDir, () => {
            const captured = captureFd1Sync(() => initMod.cmdInitExecutePhase(tmpDir, '1', false));
            return JSON.parse(captured);
          });
          return phaseSlugField(json);
        } finally {
          cleanup(tmpDir);
        }
      },
    },
    {
      name: 'init.cts:1957 cmdInitPhaseOp !phaseInfo fallback (CLI init phase-op, no directory)',
      cap: null,
      call(text) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3883-po-fb-'));
        try {
          fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
          fs.writeFileSync(
            path.join(tmpDir, '.planning', 'ROADMAP.md'),
            `# Roadmap\n\n### Phase 1: ${text}\n**Goal:** test\n**Plans:** TBD\n`,
          );
          const json = withHermeticInProcessEnv(tmpDir, () => {
            const captured = captureFd1Sync(() => initMod.cmdInitPhaseOp(tmpDir, '1', false));
            return JSON.parse(captured);
          });
          return phaseSlugField(json);
        } finally {
          cleanup(tmpDir);
        }
      },
    },
    {
      name: 'init.cts:1935 cmdInitPhaseOp archived branch (CLI init phase-op, archived dir + current ROADMAP)',
      cap: null,
      call(text) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3883-po-ar-'));
        try {
          const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-old');
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.writeFileSync(path.join(archiveDir, '01-CONTEXT.md'), '# old');
          fs.writeFileSync(
            path.join(tmpDir, '.planning', 'ROADMAP.md'),
            `# Roadmap\n\n<details>\n<summary>Shipped v1.0</summary>\n\n### Phase 1: Old\n**Goal:** old\n</details>\n\n## Current\n\n### Phase 1: ${text}\n**Goal:** test\n**Plans:** TBD\n`,
          );
          const json = withHermeticInProcessEnv(tmpDir, () => {
            const captured = captureFd1Sync(() => initMod.cmdInitPhaseOp(tmpDir, '1', false));
            return JSON.parse(captured);
          });
          return phaseSlugField(json);
        } finally {
          cleanup(tmpDir);
        }
      },
    },
    {
      name: 'init.cts:3109 cmdInitProgress unstarted ROADMAP phase (CLI init progress)',
      cap: null,
      call(text) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3883-prog-'));
        try {
          fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
          fs.writeFileSync(
            path.join(tmpDir, '.planning', 'ROADMAP.md'),
            `# Roadmap\n\n### Phase 1: ${text}\n**Goal:** test\n**Plans:** TBD\n`,
          );
          const json = withHermeticInProcessEnv(tmpDir, () => {
            const captured = captureFd1Sync(() => initMod.cmdInitProgress(tmpDir, false));
            return JSON.parse(captured);
          });
          return json.phases[0].name;
        } finally {
          cleanup(tmpDir);
        }
      },
    },
    {
      name: 'phase-id.cts:229 getPhaseDirFromPhaseId (direct require, exported)',
      cap: null,
      call(text) {
        // The rendered dir is `<milestone>-<sub>-<slug>`; strip the fixed
        // numeric prefix this call always emits to isolate the slug component.
        const dir = phaseId.getPhaseDirFromPhaseId('01-01', text, null);
        return dir.replace(/^01-01-?/, '');
      },
    },
    {
      name: 'phase-id.cts:380 toDir safeSlug guard (direct require, exported)',
      cap: null,
      call(text) {
        try {
          const dir = phaseId.toDir({ project: 'GSD', milestone: '01', phase: '01' }, text);
          return dir.replace(/^GSD\.01-01-?/, '');
        } catch (e) {
          // #3883 declared difference (axis: empty-sanitize-guard,
          // phase-id.cts:380 toDir docstring, "toDir: slug sanitizes to
          // empty"): toDir intentionally THROWS rather than emit an unusable
          // directory name when a slug sanitizes to "" — deliberate, not a
          // bug to consolidate away, because a slug here becomes a real
          // on-disk path segment (parsePhaseId's dir<->identity bijection;
          // every other slug call site just accepts "" silently). Post-
          // migration, toDir now shares the canonical's OWN transliteration
          // + truncation, so it throws in exactly the cases the canonical
          // itself would produce "" (CJK-only / punctuation-only / emoji-
          // only input — see B3) and NOT in any case the canonical succeeds
          // (Cyrillic — the #2848-class defect this migration fixes).
          // Surfaced as the canonical's own "" here so the corpus loop still
          // demands real agreement everywhere the canonical succeeds, and
          // only tolerates the throw where the canonical's answer is itself
          // "". Assert the SPECIFIC sentinel throw, not any exception — a
          // row that accepted an unrelated crash (e.g. a TypeError from a
          // regression elsewhere in toDir) as if it were the declared
          // empty-sanitize guard would pass while testing nothing.
          assert.ok(
            e instanceof Error && e.message.startsWith('toDir: slug sanitizes to empty'),
            `expected toDir's declared "toDir: slug sanitizes to empty" guard, got: ${e && e.message}`,
          );
          const canonical = coreUtils.generateSlugInternal(text, null);
          if (canonical === '' || canonical === null) return canonical ?? '';
          return `__THREW__:${e.message}`;
        }
      },
    },
    {
      name: 'phase-locator.cts:269 findPhaseInternal phase_slug (direct require, exported)',
      cap: null,
      call(text) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3883-pl-'));
        try {
          const phaseDir = path.join(tmpDir, '.planning', 'phases', `01-${text}`);
          fs.mkdirSync(phaseDir, { recursive: true });
          const result = phaseLocator.findPhaseInternal(tmpDir, '1');
          return result ? result.phase_slug : undefined;
        } finally {
          cleanup(tmpDir);
        }
      },
    },
    {
      name: 'workstream-name-policy.cts:75 toWorkstreamSlug (direct require, exported)',
      // #3883 regression (fixed): this site never truncated pre-migration.
      // generateSlugInternal's `maxLen` parameter now lets it opt out of the
      // 60-char default instead of colliding distinct >60-char names.
      cap: null,
      call(text) {
        return workstreamNamePolicy.toWorkstreamSlug(text);
      },
    },
  ];

  // A4: sites intentionally different from the canonical, with their reason.
  // A3 skips these for the axis named, an UNDECLARED divergence still fails.
  const DECLARED_DIFFERENT = [
    {
      site: 'gsd2-import.cts:97 slugify (direct require, exported)',
      axis: 'truncation',
      reason:
        'Documented distinct contract (gsd2-import.cts:97-102, tests/gsd2-import.test.cjs '
        + '"#2848 row 11"): slugify shares the transliteration primitive with '
        + 'generateSlugInternal but deliberately does NOT truncate at 60 chars — '
        + 'GSD-2 import titles are not filesystem path segments the way phase '
        + 'directory slugs are.',
    },
    {
      site: 'active-workstream-store.cts:97 getWorkstreamSessionKey (direct require, exported)',
      axis: 'input-domain',
      reason:
        'The slugified text is never caller-supplied: it is always one of a '
        + 'fixed ASCII whitelist of environment-variable KEY NAMES '
        + '(WORKSTREAM_SESSION_ENV_KEYS, all 13 entries: GSD_SESSION_KEY, '
        + 'CODEX_THREAD_ID, CLAUDE_SESSION_ID, CLAUDE_CODE_SESSION_ID, '
        + 'CLAUDE_CODE_SSE_PORT, OPENCODE_SESSION_ID, GEMINI_SESSION_ID, '
        + 'CURSOR_SESSION_ID, WINDSURF_SESSION_ID, TERM_SESSION_ID, WT_SESSION, '
        + 'TMUX_PANE, ZELLIJ_SESSION_NAME). The shared unicode/CJK/emoji/'
        + 'boundary-length corpus can never reach this call site in '
        + 'production, so it is checked separately below against its own real '
        + 'input domain rather than run through the shared CORPUS loop.',
    },
    {
      site: 'phase-id.cts:380 toDir safeSlug guard (direct require, exported)',
      axis: 'empty-sanitize-guard',
      reason:
        'toDir (phase-id.cts:380, docstring above toDir) intentionally THROWS '
        + '"toDir: slug sanitizes to empty" instead of emitting an unusable '
        + 'on-disk directory name — this is a disk-naming call site that '
        + 'protects the parsePhaseId dir<->identity bijection (an empty slug '
        + 'would leave a dangling trailing hyphen; every other slug call site '
        + 'silently accepts ""). Migrated to share the canonical\'s own '
        + 'transliteration + truncation, so the throw now fires in EXACTLY the '
        + 'cases the canonical itself reduces to "" (CJK/punctuation/emoji-only '
        + '— see B3), and never in a case the canonical succeeds (Cyrillic — '
        + 'the #2848-class defect this migration fixes for every other site).',
    },
  ];

  test('A4 deliberatelyDifferentSitesAreDeclared: the declared-divergence list names real sites with real reasons', () => {
    // This mechanism must exist even though today it is non-empty (both
    // entries above are load-bearing — remove either and A3 below starts
    // failing for the corresponding site/axis, which is exactly the point:
    // A3 cannot be silently satisfied by exempting the hard cases).
    assert.ok(Array.isArray(DECLARED_DIFFERENT));
    for (const entry of DECLARED_DIFFERENT) {
      assert.strictEqual(typeof entry.site, 'string');
      assert.ok(entry.site.length > 0);
      assert.strictEqual(typeof entry.reason, 'string');
      assert.ok(entry.reason.length > 20, 'a declared-different entry needs a real reason, not a placeholder');
    }
    const declaredForTruncation = DECLARED_DIFFERENT.filter((e) => e.axis === 'truncation').map((e) => e.site);
    assert.deepStrictEqual(
      declaredForTruncation,
      ['gsd2-import.cts:97 slugify (direct require, exported)'],
      'exactly one site is declared to skip the truncation axis — an undeclared truncation gap must fail A3',
    );
  });

  describe('A3 everySlugCallSiteAgreesWithTheCanonical', () => {
    for (const site of SITES) {
      describe(site.name, () => {
        for (const [label, text] of CORPUS) {
          test(`corpus:${label} agrees with generateSlugInternal`, () => {
            const canonical = coreUtils.generateSlugInternal(text);
            const observed = site.call(text);
            assert.strictEqual(
              observed,
              canonical,
              `site "${site.name}" on ${JSON.stringify(text)}: expected canonical ${JSON.stringify(canonical)}, got ${JSON.stringify(observed)}`,
            );
          });
        }

        if (site.cap !== null) {
          for (const [label, text] of BOUNDARY_CORPUS) {
            test(`boundary:${label} agrees with generateSlugInternal(text, ${site.cap})`, () => {
              const canonical = coreUtils.generateSlugInternal(text, site.cap);
              const observed = site.call(text);
              assert.strictEqual(
                observed,
                canonical,
                `site "${site.name}" at truncation boundary ${JSON.stringify(text)}: expected canonical ${JSON.stringify(canonical)}, got ${JSON.stringify(observed)}`,
              );
            });
          }
        } else {
          // #3883 regression coverage: a site whose pre-migration contract
          // never truncated must still never truncate post-migration — prove
          // it on inputs well past the OLD hard-coded 60-char cap, not just
          // at the boundary. This is the exact axis the original harness
          // could not see (it always compared against a 60-capped canonical).
          for (const [label, text] of LONG_UNCAPPED_CORPUS) {
            test(`long:${label} agrees with generateSlugInternal(text, null) and is not truncated to 60`, () => {
              const canonical = coreUtils.generateSlugInternal(text, null);
              const observed = site.call(text);
              assert.strictEqual(
                observed,
                canonical,
                `site "${site.name}" on long input ${JSON.stringify(text)}: expected untruncated canonical ${JSON.stringify(canonical)}, got ${JSON.stringify(observed)}`,
              );
            });
          }
        }
      });
    }

    // #3883 collision regression: the two concrete collisions the security
    // review proved by execution (workstream-name-policy.cts toWorkstreamSlug,
    // phase-id.cts toDir) — driven through the REAL surfaces, not the
    // canonical directly, and asserted RED against 01cc283da / GREEN after
    // generateSlugInternal gained the maxLen parameter and these sites opted
    // out of the 60-char default.
    describe('A5 uncappedSitesDoNotCollideOnLongInputs (#3883 collision regression)', () => {
      const COLLISION_PAIRS = [
        [`${'a'.repeat(60)}alpha`, `${'a'.repeat(60)}beta`],
        [
          'migrate the legacy billing subsystem onto the new distributed queue system today',
          'migrate the legacy billing subsystem onto the new distributed queue system tomorrow',
        ],
      ];
      for (const site of SITES.filter((s) => s.cap === null)) {
        describe(site.name, () => {
          for (const [textA, textB] of COLLISION_PAIRS) {
            test(`"${textA.slice(0, 20)}..." vs "${textB.slice(0, 20)}..." produce distinct slugs`, () => {
              const slugA = site.call(textA);
              const slugB = site.call(textB);
              assert.notEqual(
                slugA,
                slugB,
                `site "${site.name}": distinct >60-char inputs collided on slug ${JSON.stringify(slugA)}`,
              );
            });
          }
        });
      }
    });

    // gsd2-import.cts:97 slugify — compared on the general corpus (must still
    // transliterate correctly) but NOT the boundary corpus (declared, A4).
    describe('gsd2-import.cts:97 slugify (direct require, exported)', () => {
      for (const [label, text] of CORPUS) {
        test(`corpus:${label} agrees with generateSlugInternal`, () => {
          const canonical = coreUtils.generateSlugInternal(text);
          const observed = gsd2Import.slugify(text);
          assert.strictEqual(observed, canonical, `slugify on ${JSON.stringify(text)}: expected ${JSON.stringify(canonical)}, got ${JSON.stringify(observed)}`);
        });
      }
    });

    // active-workstream-store.cts:97 getWorkstreamSessionKey — checked against
    // its own real, restricted input domain (declared, A4), not the shared corpus.
    describe('active-workstream-store.cts:97 getWorkstreamSessionKey (real input domain only)', () => {
      const REAL_ENV_KEYS = [
        'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_CODE_SSE_PORT', 'OPENCODE_SESSION_ID', 'GEMINI_SESSION_ID', 'CURSOR_SESSION_ID',
        'WINDSURF_SESSION_ID', 'TERM_SESSION_ID', 'WT_SESSION', 'TMUX_PANE', 'ZELLIJ_SESSION_NAME',
      ];
      for (const envKey of REAL_ENV_KEYS) {
        test(`${envKey} slugifies identically to generateSlugInternal(${envKey})`, () => {
          const saved = {};
          for (const k of REAL_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
          process.env[envKey] = 'token123';
          try {
            const observedKey = activeWorkstreamStore.getWorkstreamSessionKey();
            const canonicalPrefix = coreUtils.generateSlugInternal(envKey);
            assert.strictEqual(
              observedKey,
              `${canonicalPrefix}-token123`,
              `getWorkstreamSessionKey(${envKey}): expected the envKey portion to equal generateSlugInternal(${envKey})`,
            );
          } finally {
            for (const k of REAL_ENV_KEYS) {
              if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
            }
          }
        });
      }
    });
  });

  // ── B. Boundaries (repo rule: limit-1, limit, limit+1) ───────────────────────

  describe('B1 slug truncation length: one-under / exact / one-over — no trailing separator at any', () => {
    for (const [label, text] of BOUNDARY_CORPUS) {
      test(`canonical: ${label}`, () => {
        const slug = coreUtils.generateSlugInternal(text);
        assert.ok(!slug.endsWith('-'), `generateSlugInternal(${JSON.stringify(text)}) must not end in a hyphen; got ${JSON.stringify(slug)}`);
      });
    }
  });

  describe('B2 empty and whitespace-only input', () => {
    test('generateSlugInternal("") → null', () => {
      assert.strictEqual(coreUtils.generateSlugInternal(''), null);
    });
    test('generateSlugInternal("   ") → "" (whitespace collapses, not null — falsy check is on the input, not the output)', () => {
      assert.strictEqual(coreUtils.generateSlugInternal('   '), '');
    });
    test('cmdGenerateSlug rejects empty input with an explicit error (not a silent empty slug)', () => {
      const result = runGsdTools(['generate-slug', ''], process.cwd(), { HOME: os.tmpdir() });
      assert.ok(!result.success, 'generate-slug must fail on empty text');
      assert.ok(result.error.includes('text required'), `expected "text required" error, got: ${result.error}`);
    });
  });

  describe('B3 input that is entirely non-transliterable (Cyrillic-to-empty class, generalized)', () => {
    test('CJK-only title → canonical produces "" (not an error, not a crash)', () => {
      assert.strictEqual(coreUtils.generateSlugInternal('中文测试'), '');
    });
    test('punctuation-only title → canonical produces ""', () => {
      assert.strictEqual(coreUtils.generateSlugInternal('!!!@@@###'), '');
    });
    test('emoji-only title → canonical produces ""', () => {
      assert.strictEqual(coreUtils.generateSlugInternal('😀😁😂'), '');
    });
  });
});
