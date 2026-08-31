#!/usr/bin/env node
'use strict';

/**
 * lint-source-test-name-collision.cjs — no SOURCE file may carry a basename
 * that matches Node's built-in test-file collection patterns.
 *
 * ## Why (the incident)
 *
 * `src/test-home-guard.cts` was a SOURCE module (a runtime guard, not a
 * test) whose filename happened to match Node's `test-*` collection
 * convention. `scripts/run-tests.cjs` — what local `npm test` and GitHub CI
 * use — globs only `tests/**\/*.test.cjs`, so CI never saw it. But the
 * REMOTE test runner (the push gate; see CLAUDE.md's `gsd-test` section)
 * collects test files the way `node --test` does by default, across the
 * whole tree, so it picked the file up and executed it AS a test, where it
 * exited 1. Net effect: `next` was green on GitHub CI and red on the push
 * gate, blocking every push repo-wide. Proven by a control run on the
 * unmodified `next` tip 622f43353: `37199 passed / 1 failed`,
 * `throw · src/test-home-guard.cts`. The file has since been renamed to
 * `src/real-home-guard.cts` in this branch; this lint exists so a source
 * file can never silently re-acquire a collectable name again.
 *
 * ## What "collectable" means
 *
 * Node's test runner (`node --test`, and by extension the remote runner
 * that dispatches this repo's push-gate suite) collects any file whose path
 * matches, by default:
 *
 *   **\/*.test.?(c|m)js      **\/*-test.?(c|m)js     **\/*_test.?(c|m)js
 *   **\/test-*.?(c|m)js      **\/test.?(c|m)js       **\/test/**
 *
 * Node also resolves `.ts`/`.cts`/`.mts` through the same collector once
 * type-stripping is active (unflagged since Node 23.6; this repo's
 * `engines.node` floor is >=24) — which is exactly how a `.cts` file ended
 * up collected in the incident above. This lint therefore checks each of
 * the six extensions `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` against each
 * basename-shaped pattern, plus a path-based check for any file living
 * inside a directory literally named `test` (not `tests` — this repo's own
 * test directory is deliberately outside the scanned source dirs, see
 * below).
 *
 * ## Scanned (source/shipped) directories
 *
 *   src/, scripts/, hooks/, bin/, gsd-core/bin/ (excluding
 *   gsd-core/bin/lib/**, see below), eslint-rules/
 *
 * ## Exempted
 *
 *   - tests/ — files there are SUPPOSED to match; that is the point.
 *   - node_modules/, .git/ — never source we own.
 *   - gsd-core/bin/lib/** — build output generated from src/*.cts by
 *     `npm run build:lib` (tsc), and gitignored (verified: every file under
 *     it, including the incident's own post-fix
 *     `gsd-core/bin/lib/real-home-guard.cjs`, is listed in .gitignore). A
 *     generated file inherits its source's basename 1:1, so scanning it
 *     would double-report the exact same defect `src/` already caught —
 *     noise, not signal. `gsd-core/bin/shared/*.json` is data, not code,
 *     but is harmlessly included since it never matches a JS/TS extension.
 *
 * Exported pure(ish) function `checkSourceTestNameCollisions({ dirs, root })`
 * so tests can drive it against synthetic fixture directories; also runnable
 * as a CLI against the real tree
 * (`node scripts/lint-source-test-name-collision.cjs`).
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// The six extensions Node's test runner collects, per the incident: the
// documented `?(c|m)js` set (js, cjs, mjs) plus the TypeScript-loader
// equivalents (ts, cts, mts) that the same collector resolves once
// type-stripping is active (unflagged since Node 23.6; this repo's
// engines.node floor is >=24, per package.json).
const COLLECTED_EXTENSIONS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'];
const EXT_ALT = COLLECTED_EXTENSIONS.join('|');

// Basename-shaped patterns, translated 1:1 from Node's documented defaults:
//   **/*.test.?(c|m)js   **/*-test.?(c|m)js   **/*_test.?(c|m)js
//   **/test-*.?(c|m)js   **/test.?(c|m)js
// (the sixth default, **/test/**, is a path-shaped check — see
// isUnderLiteralTestDir below, not a basename regex.)
const BASENAME_PATTERNS = [
  { name: '*.test.EXT', re: new RegExp(`\\.test\\.(?:${EXT_ALT})$`) },
  { name: '*-test.EXT', re: new RegExp(`-test\\.(?:${EXT_ALT})$`) },
  { name: '*_test.EXT', re: new RegExp(`_test\\.(?:${EXT_ALT})$`) },
  { name: 'test-*.EXT', re: new RegExp(`^test-.*\\.(?:${EXT_ALT})$`) },
  { name: 'test.EXT', re: new RegExp(`^test\\.(?:${EXT_ALT})$`) },
];

/**
 * Source/shipped directories this guard checks, relative to repo root.
 * Confirmed against the repo layout: src/, scripts/, hooks/, bin/,
 * gsd-core/bin/, eslint-rules/ all ship first-party source or shipped
 * tooling; nothing else at the top level carries executable source outside
 * tests/.
 */
const DEFAULT_SCAN_DIRS = ['src', 'scripts', 'hooks', 'bin', 'gsd-core/bin', 'eslint-rules'];

// Directories to never descend into anywhere in the tree.
const ALWAYS_EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git']);

// Relative dir prefixes (POSIX-joined, relative to repo root) that are
// generated build output and must not be scanned — see the module doc for
// why gsd-core/bin/lib is excluded (it 1:1-inherits src/*.cts basenames, so
// scanning it double-reports the same defect src/ already catches).
const GENERATED_OUTPUT_PREFIXES = ['gsd-core/bin/lib'];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isGeneratedOutput(relPath) {
  const posixRel = toPosix(relPath);
  return GENERATED_OUTPUT_PREFIXES.some(
    (prefix) => posixRel === prefix || posixRel.startsWith(`${prefix}/`)
  );
}

/**
 * Node's **\/test/** default: any file living inside a directory literally
 * named `test` (singular) anywhere in its path. Deliberately does NOT match
 * `tests/` (plural) — this repo's real test directory is a sibling of the
 * scanned source dirs, not nested inside one, and is never itself scanned.
 */
function isUnderLiteralTestDir(relPath) {
  return toPosix(relPath).split('/').slice(0, -1).includes('test');
}

function matchingBasenamePatterns(basename) {
  return BASENAME_PATTERNS.filter((p) => p.re.test(basename)).map((p) => p.name);
}

function walk(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A scan dir that cannot be read must never be silently treated as
    // "zero files, zero violations" — that would be a green check that
    // guarded nothing (same class of bug as an empty registry elsewhere in
    // this repo's lints).
    out.unreadable.push({ dir: path.relative(root, dir) || dir, error: err.message });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      if (isGeneratedOutput(rel)) continue;
      walk(full, root, out);
    } else if (entry.isFile()) {
      out.scanned.push(rel);
    }
  }
}

/**
 * @param {{ dirs?: string[], root: string }} opts
 *   `dirs` — scan dirs relative to `root` (defaults to DEFAULT_SCAN_DIRS).
 *   `root` — the directory `dirs` are resolved against (repo root for the
 *   real CLI run; a synthetic fixture root in tests).
 * @returns {{ ok: boolean, violations: Array<{file:string, patterns:string[], reason:string}>, scanned: string[] }}
 */
function checkSourceTestNameCollisions({ dirs = DEFAULT_SCAN_DIRS, root }) {
  const violations = [];
  const out = { scanned: [], unreadable: [] };

  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue; // a configured dir that doesn't exist is not this lint's problem
    walk(full, root, out);
  }

  if (out.unreadable.length > 0) {
    return {
      ok: false,
      violations: out.unreadable.map((u) => ({
        file: u.dir,
        patterns: [],
        reason: `cannot read scan directory ${u.dir}: ${u.error} — a collision guard that cannot ` +
          'read its own input must fail, never silently report zero violations',
      })),
      scanned: out.scanned,
    };
  }

  for (const rel of out.scanned) {
    const basename = path.basename(rel);
    const patterns = matchingBasenamePatterns(basename);
    const underTestDir = isUnderLiteralTestDir(rel);
    if (patterns.length === 0 && !underTestDir) continue;

    const matched = underTestDir ? [...patterns, '**/test/**'] : patterns;
    violations.push({
      file: toPosix(rel),
      patterns: matched,
      reason:
        `basename matches Node's test-collection pattern(s) [${matched.join(', ')}] — the remote ` +
        'test runner (the push gate) collects files by this convention and executes them AS ' +
        'tests, while GitHub CI (scripts/run-tests.cjs) globs only tests/**/*.test.cjs and never ' +
        'sees it; the failure then appears ONLY at the push gate (incident: src/test-home-guard.cts, ' +
        'control run on next tip 622f43353: 37199 passed / 1 failed, throw · src/test-home-guard.cts). ' +
        'Remedy: rename the file out of the pattern; do NOT add a runner-side exclusion.',
    });
  }

  violations.sort((a, b) => a.file.localeCompare(b.file));

  return { ok: violations.length === 0, violations, scanned: out.scanned };
}

module.exports = {
  checkSourceTestNameCollisions,
  COLLECTED_EXTENSIONS,
  DEFAULT_SCAN_DIRS,
  GENERATED_OUTPUT_PREFIXES,
  isUnderLiteralTestDir,
  matchingBasenamePatterns,
};

function main() {
  const ROOT = path.join(__dirname, '..');
  const result = checkSourceTestNameCollisions({ root: ROOT });

  if (!result.ok) {
    process.stderr.write(
      `lint-source-test-name-collision: ${result.violations.length} violation(s) among ${result.scanned.length} scanned file(s)\n\n`
    );
    for (const v of result.violations) {
      process.stderr.write(`  ${v.file}\n    ${v.reason}\n`);
    }
    throw new ExitError(1);
  }

  console.log(`ok lint-source-test-name-collision: ${result.scanned.length} file(s) scanned, 0 violations`);
}

if (require.main === module) runMain(main);
