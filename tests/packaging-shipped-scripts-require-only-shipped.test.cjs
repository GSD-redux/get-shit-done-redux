// allow-test-rule: integration-test-input (see #2858)
// #2858 — class-extinction guard: every shipped scripts/**/*.cjs must be
// require-able using only shipped paths. A script that ships in the npm tarball
// but requires a module from tests/ (which does not ship) is MODULE_NOT_FOUND
// at load time in a published install.
//
// This test statically checks each shipped .cjs's require() calls against the
// resolved tarball file list (npm pack --dry-run --json), so adding a new entry
// to `files` cannot silently opt out. It does NOT execute the scripts — it parses
// their require() calls and resolves them against the shipped set.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Resolve the tarball file list via `npm pack --dry-run --json`.
 * This is the ACTUAL set of files that ship — not a hardcoded list — so adding
 * a new entry to package.json `files` cannot silently bypass the guard.
 */
function resolveTarballFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    shell: true, // Windows: npm is npm.cmd and needs a shell
    stdio: ['pipe', 'pipe', 'pipe'],
    // package.json's `prepack`/`prepare` runs a full `npm run build:lib`
    // (tsc) before `npm pack` computes the file list — a bounded but
    // non-trivial subprocess (~2s in isolation). Under the full parallel
    // 28,000+-test CI matrix this has been observed to take 60.6s and trip
    // a 60_000ms bound (#2931 gsd-test run d52d2ee4, linux-node24,
    // duration_ms 60637.56), aborting this file's `before()` hook and
    // cascading every sibling test to "cancelled". 120s keeps the bound
    // finite (never unbounded, per the subprocess-timeout convention) while
    // giving real headroom for a contended CI box.
    timeout: 120_000,
  });
  const parsed = JSON.parse(raw);
  return new Set(parsed[0].files.map((f) => f.path.replace(/\\/g, '/')));
}

/**
 * Extract all require('...') string-literal calls from a .cjs source.
 * Only static string-literal requires are checked — dynamic require(variable)
 * is out of scope (and would itself be a red flag in a shipped script).
 */
function extractRequires(source) {
  const requires = [];
  // Strip block comments (/* ... */) and inline line comments (// ...) before
  // matching, so a require() appearing in a doc comment or fenced code block
  // inside a /* */ does not produce a false positive.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(stripped)) !== null) {
    requires.push(m[1]);
  }
  return requires;
}

/**
 * Classify a require specifier from a given file path:
 * - 'builtin'   — node: prefix or a Node builtin (fs, path, etc.)
 * - 'shipped'   — resolves to a file within the shipped tarball set
 * - 'external'  — an npm dependency (resolvable from node_modules)
 * - 'unshipped' — resolves to a repo path that is NOT in the shipped set (VIOLATION)
 */
function classifyRequire(spec, fromFile, shippedFiles) {
  // Node builtins (including node: prefix)
  if (spec.startsWith('node:')) return 'builtin';
  const BUILTINS = ['fs', 'path', 'os', 'child_process', 'crypto', 'util', 'url', 'events', 'stream', 'http', 'https', 'net', 'tls', 'zlib', 'querystring', 'string_decoder', 'timers', 'vm', 'worker_threads', 'buffer', 'process'];
  const bare = spec.split('/')[0];
  if (BUILTINS.includes(bare)) return 'builtin';

  // Relative/absolute requires — resolve against the file's directory
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const fromDir = path.dirname(fromFile);
    const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
    // Try exact, .cjs, .js, .json, /index.cjs, /index.js
    const candidates = [
      resolved,
      resolved + '.cjs',
      resolved + '.js',
      resolved + '.json',
      resolved + '/index.cjs',
      resolved + '/index.js',
    ];
    for (const c of candidates) {
      const normalized = c.replace(/\\/g, '/');
      if (shippedFiles.has(normalized)) return 'shipped';
    }
    // If it resolves to a real file on disk but is NOT shipped → violation
    const absResolved = path.resolve(REPO_ROOT, resolved);
    const absCandidates = [
      absResolved,
      absResolved + '.cjs',
      absResolved + '.js',
      absResolved + '.json',
      path.join(absResolved, 'index.cjs'),
      path.join(absResolved, 'index.js'),
    ];
    for (const c of absCandidates) {
      if (fs.existsSync(c)) return 'unshipped';
    }
    // Doesn't resolve to anything — likely a typo or generated artifact; flag it
    return 'unshipped';
  }

  // Bare specifier (not relative, not builtin) → npm dependency
  return 'external';
}

describe('#2858 — shipped scripts require only shipped paths', () => {
  let shippedFiles;
  let shippedScripts;

  before(() => {
    shippedFiles = resolveTarballFiles();
    // Filter to scripts/**/*.{cjs,js} (the shipped script surface — both .cjs
    // and .js files ship under scripts/, e.g. build-hooks.js is required by
    // bin/install.js). Both extensions are checked so a broken require() in a
    // .js file is caught just the same as one in a .cjs file.
    shippedScripts = [...shippedFiles]
      .filter((f) => f.startsWith('scripts/') && /\.(cjs|js)$/.test(f))
      .sort();
  });

  test('every shipped scripts/*.{cjs,js} is require-able from a shipped-only tree', () => {
    assert.ok(shippedScripts.length > 0, 'expected at least one shipped script');

    const violations = [];
    for (const scriptRel of shippedScripts) {
      const absPath = path.join(REPO_ROOT, scriptRel);
      if (!fs.existsSync(absPath)) continue; // generated artifact, skip
      const source = fs.readFileSync(absPath, 'utf-8');
      const requires = extractRequires(source);

      for (const spec of requires) {
        const classification = classifyRequire(spec, scriptRel, shippedFiles);
        if (classification === 'unshipped') {
          violations.push({
            script: scriptRel,
            require: spec,
            classification,
          });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.script}: require('${v.require}') → ${v.classification}`)
        .join('\n');
      assert.fail(
        `${violations.length} shipped script(s) require modules outside the shipped tree (MODULE_NOT_FOUND in a published install):\n${details}`,
      );
    }
  });

  test('gen-emitted-baseline.cjs does NOT ship (repo-only CI tooling)', () => {
    // This script requires ../tests/helpers/* which does not ship. It is
    // repo-only CI tooling (CI workflows + test fixtures spawn it from a
    // checkout). It must be excluded from the npm tarball.
    assert.ok(
      !shippedFiles.has('scripts/gen-emitted-baseline.cjs'),
      'scripts/gen-emitted-baseline.cjs must NOT ship — it requires tests/ which does not ship (#2858)',
    );
  });

  test('a script requiring a sibling in the same shipped dir resolves as shipped (positive case)', () => {
    // Sanity: scripts/lib/cli-exit.cjs ships and is required by shipped scripts.
    // This confirms the guard's positive path works — a valid intra-shipped require
    // is NOT flagged.
    assert.ok(shippedFiles.has('scripts/lib/cli-exit.cjs'), 'scripts/lib/cli-exit.cjs should ship');
    const classification = classifyRequire('./lib/cli-exit.cjs', 'scripts/gen-adr-index.cjs', shippedFiles);
    assert.strictEqual(classification, 'shipped',
      `a sibling require within scripts/ must classify as 'shipped'; got '${classification}'`);
  });
});
