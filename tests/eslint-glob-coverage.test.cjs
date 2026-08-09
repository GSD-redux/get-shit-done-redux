'use strict';

/**
 * eslint-glob-coverage.test.cjs
 *
 * Coverage for scripts/lint-eslint-glob-coverage.cjs (#3059): every unit row
 * uses injected deps (no temp repos, no real subprocess, no chmod). The
 * ANCHOR rows and the real-tree row drive the actual ESLint config against
 * eslint.config.mjs to prove the discrimination logic holds outside the
 * mocked seams.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  checkGlobCoverage,
  listTrackedSourceFiles,
  loadAllowlist,
  SOURCE_EXT_RE,
  MIN_TRACKED_SOURCE_FILES,
} = require('../scripts/lint-eslint-glob-coverage.cjs');

const ROOT = path.join(__dirname, '..');

/** A resolveConfig stub that reports every file as covered by exactly one rule. */
function coveredResolver() {
  return () => ({ ignored: false, ruleCount: 1 });
}

/** A resolveConfig stub driven by a Map<path, {ignored, ruleCount}>. */
function mapResolver(entries) {
  return (relPath) => entries.get(relPath) || { ignored: false, ruleCount: 0 };
}

describe('eslint-glob-coverage: real tree (expected end state)', () => {
  test('the current tree resolves clean against the guard (drives the guard to green)', async () => {
    const result = await checkGlobCoverage();
    assert.equal(
      result.ok,
      true,
      `expected 0 violations, got ${result.violations.length}: ${JSON.stringify(result.violations, null, 2)}`
    );
  });
});

describe('eslint-glob-coverage: uncovered detection', () => {
  test('an unmatched file is reported uncovered; a matched file is not', async () => {
    const resolver = mapResolver(
      new Map([
        ['scripts/covered.cjs', { ignored: false, ruleCount: 3 }],
        ['scripts/escaped.cjs', { ignored: false, ruleCount: 0 }],
      ])
    );
    const result = await checkGlobCoverage({
      trackedFiles: ['scripts/covered.cjs', 'scripts/escaped.cjs'],
      resolveConfig: resolver,
      allowlist: [],
      minTrackedFiles: 0,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.escapes, [{ path: 'scripts/escaped.cjs' }]);
    const kinds = result.violations.map((v) => v.path);
    assert.ok(!kinds.includes('scripts/covered.cjs'));
  });
});

describe('eslint-glob-coverage: allowlist reason validation', () => {
  test('non-empty reason passes; empty/whitespace reason and missing reason each fail', async () => {
    const resolver = mapResolver(
      new Map([
        ['a.cjs', { ignored: false, ruleCount: 0 }],
        ['b.cjs', { ignored: false, ruleCount: 0 }],
        ['c.cjs', { ignored: false, ruleCount: 0 }],
        ['d.cjs', { ignored: false, ruleCount: 0 }],
      ])
    );
    const result = await checkGlobCoverage({
      trackedFiles: ['a.cjs', 'b.cjs', 'c.cjs', 'd.cjs'],
      resolveConfig: resolver,
      minTrackedFiles: 0,
      allowlist: [
        { path: 'a.cjs', reason: 'a real reason' },
        { path: 'b.cjs', reason: '' },
        { path: 'c.cjs', reason: '   ' },
        { path: 'd.cjs' },
      ],
    });
    const byPath = (p) => result.violations.filter((v) => v.path === p).map((v) => v.kind);
    assert.deepEqual(byPath('a.cjs'), []);
    assert.deepEqual(byPath('b.cjs'), ['allowlist_empty_reason']);
    assert.deepEqual(byPath('c.cjs'), ['allowlist_empty_reason']);
    assert.deepEqual(byPath('d.cjs'), ['allowlist_missing_reason']);
  });
});

describe('eslint-glob-coverage: allowlist ratchet', () => {
  test('a stale entry (path now resolves to >=1 rule) reports allowlist_stale', async () => {
    const resolver = mapResolver(new Map([['now-covered.cjs', { ignored: false, ruleCount: 2 }]]));
    const result = await checkGlobCoverage({
      trackedFiles: ['now-covered.cjs'],
      resolveConfig: resolver,
      minTrackedFiles: 0,
      allowlist: [{ path: 'now-covered.cjs', reason: 'stale — should be pruned' }],
    });
    assert.equal(result.ok, false);
    const kinds = result.violations.filter((v) => v.path === 'now-covered.cjs').map((v) => v.kind);
    assert.deepEqual(kinds, ['allowlist_stale']);
  });

  test('an allowlist path not in the tracked list reports allowlist_missing_path', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: ['tracked.cjs'],
      resolveConfig: coveredResolver(),
      minTrackedFiles: 0,
      allowlist: [{ path: 'ghost.cjs', reason: 'not actually tracked' }],
    });
    assert.equal(result.ok, false);
    const kinds = result.violations.filter((v) => v.path === 'ghost.cjs').map((v) => v.kind);
    assert.deepEqual(kinds, ['allowlist_missing_path']);
  });

  test('a duplicate entry reports allowlist_duplicate', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: ['dup.cjs'],
      resolveConfig: mapResolver(new Map([['dup.cjs', { ignored: false, ruleCount: 0 }]])),
      minTrackedFiles: 0,
      allowlist: [
        { path: 'dup.cjs', reason: 'first' },
        { path: 'dup.cjs', reason: 'second' },
      ],
    });
    assert.equal(result.ok, false);
    const kinds = result.violations.filter((v) => v.path === 'dup.cjs').map((v) => v.kind);
    assert.ok(kinds.includes('allowlist_duplicate'));
  });
});

describe('eslint-glob-coverage: tracked-count floor boundary', () => {
  function fakeTrackedFiles(n) {
    const files = [];
    for (let i = 0; i < n; i += 1) files.push(`scripts/fake-${i}.cjs`);
    return files;
  }

  test('499 tracked files (limit-1) fails tracked_count_below_floor', async () => {
    const files = fakeTrackedFiles(MIN_TRACKED_SOURCE_FILES - 1);
    const result = await checkGlobCoverage({
      trackedFiles: files,
      resolveConfig: coveredResolver(),
      allowlist: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.kind === 'tracked_count_below_floor'));
  });

  test('500 tracked files (limit) passes', async () => {
    const files = fakeTrackedFiles(MIN_TRACKED_SOURCE_FILES);
    const result = await checkGlobCoverage({
      trackedFiles: files,
      resolveConfig: coveredResolver(),
      allowlist: [],
    });
    assert.equal(result.ok, true);
    assert.ok(!result.violations.some((v) => v.kind === 'tracked_count_below_floor'));
  });

  test('501 tracked files (limit+1) passes', async () => {
    const files = fakeTrackedFiles(MIN_TRACKED_SOURCE_FILES + 1);
    const result = await checkGlobCoverage({
      trackedFiles: files,
      resolveConfig: coveredResolver(),
      allowlist: [],
    });
    assert.equal(result.ok, true);
    assert.ok(!result.violations.some((v) => v.kind === 'tracked_count_below_floor'));
  });
});

describe('eslint-glob-coverage: never a vacuous clean', () => {
  test('an empty git ls-files result never reports clean (fails the floor)', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: [],
      resolveConfig: coveredResolver(),
      allowlist: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.kind === 'tracked_count_below_floor'));
  });

  test('listTrackedSourceFiles itself returns ok:true with zero files on empty stdout (not a throw)', () => {
    const result = listTrackedSourceFiles({ execFile: () => '' });
    assert.deepEqual(result, { ok: true, files: [] });
  });
});

describe('eslint-glob-coverage: container safe.directory (#3059)', () => {
  test('git invocation passes -c safe.directory=* before ls-files, so a container-owned repo ("dubious ownership") never degrades the guard to git_failed', () => {
    let capturedArgs;
    const result = listTrackedSourceFiles({
      execFile: (cmd, args) => {
        capturedArgs = args;
        return 'scripts/a.cjs\n';
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      capturedArgs.slice(0, 3),
      ['-c', 'safe.directory=*', 'ls-files'],
      'the safe.directory override must precede the ls-files subcommand'
    );
  });
});

describe('eslint-glob-coverage: git failure handling', () => {
  test('an injected git failure reports git_failed without throwing', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: { ok: false, files: [], error: 'git ls-files: exit 128' },
      resolveConfig: coveredResolver(),
      allowlist: [],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.map((v) => v.kind),
      ['git_failed']
    );
  });

  test('listTrackedSourceFiles degrades (does not throw) when execFile throws', () => {
    const boom = () => {
      throw new Error('git: command not found');
    };
    const result = listTrackedSourceFiles({ execFile: boom });
    assert.equal(result.ok, false);
    assert.equal(result.files.length, 0);
    assert.match(result.error, /git: command not found/);
  });
});

describe('eslint-glob-coverage: path normalization', () => {
  test('a backslash path from git ls-files normalizes before allowlist matching', () => {
    const result = listTrackedSourceFiles({
      execFile: () => 'scripts\\weird-windows-path.cjs\nsrc\\normal.cts\n',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.files.sort(), ['scripts/weird-windows-path.cjs', 'src/normal.cts'].sort());
  });

  test('CRLF git ls-files output parses with no phantom paths', () => {
    const result = listTrackedSourceFiles({
      execFile: () => 'scripts/a.cjs\r\nscripts/b.cjs\r\n',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ['scripts/a.cjs', 'scripts/b.cjs']);
  });
});

describe('eslint-glob-coverage: listTrackedSourceFiles parser properties (fast-check)', () => {
  // Generators for `git ls-files`-style path-like lines. Segments avoid '.',
  // '\n', '\r' so extension/line boundaries stay unambiguous; the generators
  // below deliberately introduce the shapes the parser must handle: source
  // extensions, non-source extensions, no extension, backslashes, spaces,
  // and empty lines.
  const pathSegment = fc.stringMatching(/^[A-Za-z0-9_\- ]{1,12}$/);
  const sourceExt = fc.constantFrom('cjs', 'cts', 'js', 'mjs');
  const nonSourceExt = fc.constantFrom('md', 'json', 'txt');

  const sourcePath = fc
    .tuple(fc.array(pathSegment, { minLength: 1, maxLength: 3 }), sourceExt)
    .map(([segs, ext]) => `${segs.join('/')}.${ext}`);

  const nonSourcePath = fc
    .tuple(fc.array(pathSegment, { minLength: 1, maxLength: 3 }), nonSourceExt)
    .map(([segs, ext]) => `${segs.join('/')}.${ext}`);

  const noExtPath = fc.array(pathSegment, { minLength: 1, maxLength: 3 }).map((segs) => segs.join('/'));

  const backslashPath = fc
    .tuple(fc.array(pathSegment, { minLength: 1, maxLength: 3 }), sourceExt)
    .map(([segs, ext]) => `${segs.join('\\')}.${ext}`);

  const spacedPath = fc
    .tuple(fc.array(pathSegment, { minLength: 1, maxLength: 2 }), sourceExt)
    .map(([segs, ext]) => `${segs.join(' / ')} file.${ext}`);

  const emptyPath = fc.constant('');

  const anyPathLine = fc.oneof(sourcePath, nonSourcePath, noExtPath, backslashPath, spacedPath, emptyPath);
  const terminator = fc.constantFrom('\n', '\r\n');

  // (1) Extension totality / soundness: every returned path ends in a
  // source extension, is traceable back to a generated input line (modulo
  // backslash->slash normalization), and no returned entry is empty. Each
  // generated line carries its OWN terminator (mixing \n and \r\n within a
  // single stdout blob), including the last line — this also exercises "a
  // trailing terminator produces no phantom empty entry" on every run,
  // since every line (including the last) is terminator-suffixed.
  test('property: extension totality — every returned path is source-extensioned, traceable, non-empty', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(anyPathLine, terminator), { maxLength: 20 }),
        (lines) => {
          const stdout = lines.map(([p, t]) => p + t).join('');
          const result = listTrackedSourceFiles({ execFile: () => stdout });
          assert.equal(result.ok, true);

          const normalizedInputs = new Set(
            lines.map(([p]) => p.replace(/\\/g, '/')).filter((p) => p.length > 0)
          );

          for (const file of result.files) {
            assert.notEqual(file, '', 'no returned entry is the empty string');
            assert.match(file, SOURCE_EXT_RE, `${file} must end in a source extension`);
            assert.ok(normalizedInputs.has(file), `${file} must be traceable to a generated input line`);
          }

          // Exact-equality corollary: the parser's own filter/normalize
          // pipeline applied to the same inputs must reproduce the result.
          const expected = lines
            .map(([p]) => p)
            .filter((p) => p.length > 0)
            .map((p) => p.replace(/\\/g, '/'))
            .filter((p) => SOURCE_EXT_RE.test(p));
          assert.deepEqual(result.files, expected);
        }
      )
    );
  });

  // (2) Separator normalization is total: any generated path containing a
  // backslash never survives into the output with a backslash intact.
  test('property: separator normalization is total — no returned path contains a backslash', () => {
    fc.assert(
      fc.property(fc.array(backslashPath, { minLength: 0, maxLength: 15 }), (paths) => {
        const stdout = paths.map((p) => `${p}\n`).join('');
        const result = listTrackedSourceFiles({ execFile: () => stdout });
        assert.equal(result.ok, true);
        for (const file of result.files) {
          assert.ok(!file.includes('\\'), `${file} must not contain a backslash`);
        }
      })
    );
  });

  // (3) CRLF/LF equivalence: the same set of path lines, terminated
  // uniformly with LF vs. uniformly with CRLF, must parse to the same
  // result — the invariant the recurring CRLF defect class breaks.
  test('property: CRLF and LF inputs describing the same path set yield the same result', () => {
    fc.assert(
      fc.property(fc.array(anyPathLine, { maxLength: 20 }), (lines) => {
        const lfStdout = lines.map((p) => `${p}\n`).join('');
        const crlfStdout = lines.map((p) => `${p}\r\n`).join('');

        const lfResult = listTrackedSourceFiles({ execFile: () => lfStdout });
        const crlfResult = listTrackedSourceFiles({ execFile: () => crlfStdout });

        assert.equal(lfResult.ok, true);
        assert.equal(crlfResult.ok, true);
        assert.deepEqual(lfResult.files, crlfResult.files);
      })
    );
  });
});

describe('eslint-glob-coverage: SOURCE_EXT_RE filtering', () => {
  test('listTrackedSourceFiles filters to cjs/cts/js/mjs only', () => {
    const result = listTrackedSourceFiles({
      execFile: () =>
        ['scripts/a.cjs', 'src/b.cts', 'hooks/c.js', 'gsd-core/d.mjs', 'README.md', 'docs/e.txt'].join('\n'),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.files.sort(),
      ['gsd-core/d.mjs', 'hooks/c.js', 'scripts/a.cjs', 'src/b.cts'].sort()
    );
  });

  test('SOURCE_EXT_RE matches the four source extensions and rejects others', () => {
    assert.equal(SOURCE_EXT_RE.test('foo.cjs'), true);
    assert.equal(SOURCE_EXT_RE.test('foo.cts'), true);
    assert.equal(SOURCE_EXT_RE.test('foo.js'), true);
    assert.equal(SOURCE_EXT_RE.test('foo.mjs'), true);
    assert.equal(SOURCE_EXT_RE.test('foo.ts'), false);
    assert.equal(SOURCE_EXT_RE.test('foo.md'), false);
  });
});

describe('eslint-glob-coverage: ANCHOR rows (real ESLint against real config)', () => {
  // One shared resolver for the anchor rows: the anchors deliberately re-resolve
  // the config themselves rather than importing the guard's resolveFileCoverage,
  // so an anchor still fails if the guard's own resolution regresses.
  const { ESLint } = require('eslint');
  const anchorEslint = new ESLint({ cwd: ROOT });
  async function rulesFor(relPath) {
    const config = await anchorEslint.calculateConfigForFile(path.join(ROOT, relPath));
    return config && config.rules;
  }

  test('tests/*.test.cjs has local/no-unbounded-spawn reachable', async () => {
    const rules = await rulesFor('tests/eslint-glob-coverage.test.cjs');
    assert.ok(rules, 'expected a resolved rule set');
    assert.ok(
      Object.prototype.hasOwnProperty.call(rules, 'local/no-unbounded-spawn'),
      'expected local/no-unbounded-spawn to be reachable on a tests/*.test.cjs file'
    );
  });

  test('scripts/*.cjs has n/no-path-concat reachable', async () => {
    const rules = await rulesFor('scripts/lint-eslint-glob-coverage.cjs');
    assert.ok(rules, 'expected a resolved rule set');
    assert.ok(
      Object.prototype.hasOwnProperty.call(rules, 'n/no-path-concat'),
      'expected n/no-path-concat to be reachable on a scripts/*.cjs file'
    );
  });

  test('src/*.cts has at least one @typescript-eslint/* rule reachable', async () => {
    const rules = await rulesFor('src/milestone.cts');
    assert.ok(rules, 'expected a resolved rule set');
    const tsRules = Object.keys(rules).filter((r) => r.startsWith('@typescript-eslint/'));
    assert.ok(tsRules.length > 0, 'expected at least one @typescript-eslint/* rule reachable on src/*.cts');
  });
});

describe('eslint-glob-coverage: ignored vs. unmatched discrimination (real ESLint)', () => {
  test('an ADR-457 tsc artifact under gsd-core/bin/lib/*.cjs is not reported as uncovered', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: ['gsd-core/bin/lib/milestone.cjs'],
      allowlist: [],
      minTrackedFiles: 0,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.escapes, []);
  });

  test('bin/install.js is not reported as uncovered and is not in the real allowlist', async () => {
    const result = await checkGlobCoverage({
      trackedFiles: ['bin/install.js'],
      allowlist: [],
      minTrackedFiles: 0,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.escapes, []);

    const realAllowlist = loadAllowlist();
    assert.ok(!realAllowlist.some((entry) => entry.path === 'bin/install.js'));
  });
});
