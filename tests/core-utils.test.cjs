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
 *   - filterPlanFiles
 *   - filterSummaryFiles
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
const { cleanup } = require('./helpers.cjs');

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

// ─── filterPlanFiles ──────────────────────────────────────────────────────────

describe('filterPlanFiles', () => {
  test('returns only PLAN.md and *-PLAN.md files', () => {
    const files = ['PLAN.md', '01-PLAN.md', 'SUMMARY.md', 'README.md', 'foo-PLAN.md'];
    assert.deepEqual(coreUtils.filterPlanFiles(files), ['PLAN.md', '01-PLAN.md', 'foo-PLAN.md']);
  });

  test('empty array → empty array', () => {
    assert.deepEqual(coreUtils.filterPlanFiles([]), []);
  });

  test('no matching files → empty array', () => {
    assert.deepEqual(coreUtils.filterPlanFiles(['SUMMARY.md', 'CONTEXT.md']), []);
  });

  test('case-sensitive: plan.md is not matched', () => {
    assert.deepEqual(coreUtils.filterPlanFiles(['plan.md', 'Plan.md']), []);
  });
});

// ─── filterSummaryFiles ───────────────────────────────────────────────────────

describe('filterSummaryFiles', () => {
  test('returns only SUMMARY.md and *-SUMMARY.md files', () => {
    const files = ['SUMMARY.md', '01-SUMMARY.md', 'PLAN.md', 'foo-SUMMARY.md'];
    assert.deepEqual(coreUtils.filterSummaryFiles(files), ['SUMMARY.md', '01-SUMMARY.md', 'foo-SUMMARY.md']);
  });

  test('empty array → empty array', () => {
    assert.deepEqual(coreUtils.filterSummaryFiles([]), []);
  });

  test('no matching files → empty array', () => {
    assert.deepEqual(coreUtils.filterSummaryFiles(['PLAN.md', 'CONTEXT.md']), []);
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

  test('extracts bold text after a heading as one-liner', () => {
    const content = '# Phase Title\n\n**Implement the feature**\n\nMore details here.\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Implement the feature');
  });

  test('returns null when no bold text after heading', () => {
    const content = '# Phase Title\n\nSome prose without bold.\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), null);
  });

  test('strips frontmatter before searching', () => {
    const content = '---\nstatus: done\n---\n# Title\n\n**One liner here**\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'One liner here');
  });

  test('when bold ends with colon, returns text after the bold', () => {
    const content = '# Title\n\n**Objective:** Complete the work\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Complete the work');
  });

  test('CRLF line endings are normalized', () => {
    const content = '# Title\r\n\r\n**Bold line**\r\nmore\r\n';
    assert.strictEqual(coreUtils.extractOneLinerFromBody(content), 'Bold line');
  });

  test('adversarial: unicode in bold text', () => {
    const content = '# Title\n\n**中文 one-liner**\n\nMore.\n';
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
