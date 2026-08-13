'use strict';

// allow-test-rule: runtime-contract-is-the-product (see #3412) — this helper's
// job IS to read a script's source and resolve its static require() graph, so
// the "assert behavior, never grep source" rule does not apply to it. Nothing
// here asserts anything; it copies files.

/**
 * Copy a repo script into a throwaway fixture tree ALONG WITH its transitive
 * relative-require dependencies, preserving repo-relative layout.
 *
 * Several suites drive a `scripts/*.cjs` end-to-end by copying it into an
 * mkdtemp fixture and spawning it there — necessary because those scripts
 * resolve their scan root from `path.join(__dirname, '..')`, so running the
 * REAL script would scan the real repo instead of the fixture (see
 * tests/removed-but-needed-lint.test.cjs's copyScriptInto for the original
 * statement of that constraint).
 *
 * Each such harness used to hand-list the script's dependencies
 * (`fs.copyFileSync(... 'scripts/lib/cli-exit.cjs' ...)`). That made every new
 * require in a covered script a silent, duplicated edit across N harnesses,
 * and the failure mode was a MODULE_NOT_FOUND that only ever appeared in CI.
 * #3412 collected the bill: adding one require of the new pattern seam to
 * gen-adr-index.cjs broke 82 tests across two suites that had each hand-copied
 * a now-incomplete dependency list.
 *
 * Walking the require graph instead means a script's dependencies are derived,
 * never re-declared, so this class cannot recur.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Relative specifiers — the only kind that resolves inside the fixture tree. */
const RELATIVE_SPEC_RE = /^\.{1,2}[\\/]/;

/**
 * Extract every static `require('...')` string-literal specifier from a CJS
 * source. Dynamic `require(variable)` is deliberately out of scope: it cannot
 * be resolved statically, and in a script that ships it would itself be a red
 * flag (see tests/packaging-shipped-scripts-require-only-shipped.test.cjs,
 * which consumes this same extractor so the two guards cannot disagree about
 * what "a require" is).
 *
 * @param {string} source
 * @returns {string[]} specifiers, in source order, duplicates included
 */
function extractRequires(source) {
  const requires = [];
  // Strip block comments and line comments first, so a require() written
  // inside a doc comment or a fenced example does not register as real.
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
 * Resolve a relative require specifier to a real file, applying Node's CJS
 * extension/index candidates.
 *
 * @param {string} fromAbsFile absolute path of the requiring file
 * @param {string} spec the relative specifier
 * @returns {string|null} absolute path of the resolved file, or null
 */
function resolveRelativeRequire(fromAbsFile, spec) {
  const base = path.resolve(path.dirname(fromAbsFile), spec);
  const candidates = [
    base,
    `${base}.cjs`,
    `${base}.js`,
    `${base}.json`,
    path.join(base, 'index.cjs'),
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Copy `scriptRel` (repo-relative, e.g. `scripts/gen-adr-index.cjs`) and every
 * file reachable from it through static relative requires into `fixtureRoot`,
 * at the same repo-relative paths. Bare specifiers (`node:fs`, npm packages)
 * are left alone — they resolve from the real installation.
 *
 * Throws when a relative require does not resolve on disk. That is nearly
 * always an unbuilt artifact (`gsd-core/bin/lib/*.cjs` requires
 * `npm run build:lib`), and failing here names the cause instead of letting
 * the spawned subprocess die with a bare MODULE_NOT_FOUND.
 *
 * @param {string} repoRoot absolute path to the repo root
 * @param {string} fixtureRoot absolute path to the temp fixture root
 * @param {string} scriptRel repo-relative path of the script to copy
 * @returns {string} absolute path of the copied script inside `fixtureRoot`
 */
function copyScriptWithDeps(repoRoot, fixtureRoot, scriptRel) {
  const toPosix = (p) => p.split(path.sep).join('/');
  const entry = toPosix(scriptRel);
  const copied = new Set();
  const unresolved = [];

  /** @param {string} rel repo-relative posix path */
  function copyOne(rel) {
    if (copied.has(rel)) return;
    copied.add(rel);

    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      unresolved.push(`${rel} (does not exist in the repo)`);
      return;
    }
    const dest = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);

    for (const spec of extractRequires(fs.readFileSync(abs, 'utf-8'))) {
      if (!RELATIVE_SPEC_RE.test(spec)) continue;
      const depAbs = resolveRelativeRequire(abs, spec);
      if (!depAbs) {
        unresolved.push(`require('${spec}') from ${rel}`);
        continue;
      }
      const depRel = path.relative(repoRoot, depAbs);
      // A require that resolves OUTSIDE the repo would make `path.join(
      // fixtureRoot, depRel)` climb out of the fixture and write into the
      // surrounding temp dir. Nothing in the tree does this today; refuse
      // rather than leave the sandbox escape available to whatever lands next.
      if (depRel.startsWith('..') || path.isAbsolute(depRel)) {
        unresolved.push(
          `require('${spec}') from ${rel} resolves outside the repo (${depAbs}) — refusing to copy outside the fixture`,
        );
        continue;
      }
      copyOne(toPosix(depRel));
    }
  }

  copyOne(entry);

  if (unresolved.length > 0) {
    throw new Error(
      `copyScriptWithDeps(${entry}) could not resolve ${unresolved.length} ` +
        `relative require(s); the fixture would fail with MODULE_NOT_FOUND:\n` +
        unresolved.map((u) => `  - ${u}`).join('\n') +
        `\nIf these are compiled artifacts under gsd-core/bin/lib/, run \`npm run build:lib\`.`,
    );
  }

  return path.join(fixtureRoot, scriptRel);
}

module.exports = { extractRequires, resolveRelativeRequire, copyScriptWithDeps };
