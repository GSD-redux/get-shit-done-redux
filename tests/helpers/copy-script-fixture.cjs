'use strict';

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
const espree = require('espree');

/** Relative specifiers — the only kind that resolves inside the fixture tree. */
const RELATIVE_SPEC_RE = /^\.{1,2}[\\/]/;

/**
 * Parse attempts tried in order by `extractRequires`. `globalReturn: true` is
 * required on the `script` attempt because Node wraps every CommonJS module
 * body in an implicit function, which makes a top-level `return` legal there
 * even though it is not legal in a bare ECMAScript Program — `espree` without
 * the flag rejects it with "'return' outside of function". A real shipped
 * script relies on exactly this (`scripts/check-coverage-gate.cjs` has a
 * top-level `return`), so dropping the flag silently breaks the #2858
 * packaging guard that scans it. Do not remove this without re-verifying
 * every shipped `scripts/**`, `bin/**`, and `gsd-core/bin/**` .cjs/.js file
 * still parses.
 */
const PARSE_ATTEMPTS = [
  { ecmaVersion: 'latest', sourceType: 'script', ecmaFeatures: { globalReturn: true } },
  { ecmaVersion: 'latest', sourceType: 'module' },
];

/**
 * Extract every static `require('...')` string-literal call from a CJS or ESM
 * source, via a real AST parse rather than pattern-matching. Commented-out,
 * string-embedded, and template-literal occurrences are correctly ignored;
 * `foo.require('x')` (a method call, not a bare identifier callee) is
 * correctly ignored; dynamic `require(variable)` remains out of scope — it
 * cannot be resolved statically, and in a script that ships it would itself
 * be a red flag (see tests/packaging-shipped-scripts-require-only-shipped.
 * test.cjs, which consumes this same extractor so the two guards cannot
 * disagree about what "a require" is).
 *
 * Currently a spurious hit (a require-shaped call this function reports that
 * the source does not actually reach) is not merely harmless: an unresolvable
 * specifier makes `copyScriptWithDeps` throw. With a real parser this is
 * largely moot — there is no pattern-matching left to produce a false
 * positive from comment/string/regex content.
 *
 * @param {string} source
 * @returns {string[]} specifiers, in source order, duplicates included
 */
function extractRequires(source) {
  let ast = null;
  for (const options of PARSE_ATTEMPTS) {
    try {
      ast = espree.parse(source, options);
      break;
    } catch {
      /* try next */
    }
  }
  if (ast === null) {
    throw new Error('extractRequires: source did not parse as script or module');
  }
  const found = [];
  (function walk(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      found.push(node.arguments[0].value);
    }
    for (const key of Object.keys(node)) walk(node[key]);
  })(ast);
  return found;
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
 * True when `rel` (a `path.relative(base, target)` result) climbs outside
 * `base` — i.e. `target` is not contained within `base`. Guards against the
 * `'..foo'.startsWith('..')` false positive (a real sibling directory named
 * `..foo` is NOT an escape) by requiring either an exact `..` or a
 * `..<sep>`-prefixed relative path, using the platform separator since
 * `path.relative` returns platform-native separators.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function escapesContainment(rel) {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Copy `scriptRel` (repo-relative, e.g. `scripts/gen-adr-index.cjs`) and every
 * file reachable from it through static relative requires into `fixtureRoot`,
 * at the same repo-relative paths. Bare specifiers (`node:fs`, npm packages)
 * are left alone — they resolve from the real installation.
 *
 * Both the entry script and every discovered dependency are validated against
 * the repo boundary before being copied (symlinks resolved via
 * `fs.realpathSync` first, since the containment check is otherwise lexical
 * while `copyFileSync`/`readFileSync` follow links — a repo-committed symlink
 * pointing outside the repo must not smuggle its target's contents in). The
 * ORIGINAL repo-relative path (not the realpath-derived one) is preserved for
 * the destination location, so the copied layout is unchanged; the
 * realpath-derived repo-relative path is used as the dedupe key so a
 * directory-symlink cycle cannot mint a new key per level.
 *
 * Throws when a relative require does not resolve on disk, or when the entry
 * or a dependency resolves outside the repo. Unresolved-require failures are
 * nearly always an unbuilt artifact (`gsd-core/bin/lib/*.cjs` requires
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

  let realRepoRoot;
  try {
    realRepoRoot = fs.realpathSync(repoRoot);
  } catch (err) {
    throw new Error(`copyScriptWithDeps: could not resolve repoRoot ${repoRoot}: ${err.message}`);
  }

  /**
   * @param {string} abs absolute path (not yet realpath-resolved)
   * @param {string} label human-readable label for error messages
   * @returns {{ dedupeKey: string } | null} null when unresolvable or escaping
   */
  function checkContainment(abs, label) {
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      unresolved.push(`${label} could not be resolved on disk: ${err.message}`);
      return null;
    }
    const dedupeKey = toPosix(path.relative(realRepoRoot, real));
    if (escapesContainment(dedupeKey)) {
      unresolved.push(`${label} resolves outside the repo (${real}) — refusing to copy outside the fixture`);
      return null;
    }
    return { dedupeKey };
  }

  /** @param {string} rel repo-relative posix path (ORIGINAL, pre-realpath) */
  function copyOne(rel) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      if (!copied.has(rel)) {
        copied.add(rel);
        unresolved.push(`${rel} (does not exist in the repo)`);
      }
      return;
    }

    const containment = checkContainment(abs, rel);
    if (!containment) return;
    if (copied.has(containment.dedupeKey)) return;
    copied.add(containment.dedupeKey);

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
      const depRel = toPosix(path.relative(repoRoot, depAbs));
      copyOne(depRel);
    }
  }

  // F2: the entry path bypasses the sandbox guard the same way a dependency
  // could — validate it against the same containment rule before copying.
  const entryAbs = path.join(repoRoot, entry);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`copyScriptWithDeps: entry script does not exist in the repo: ${entry}`);
  }
  const entryContainment = checkContainment(entryAbs, `entry script ${entry}`);
  if (!entryContainment) {
    throw new Error(
      `copyScriptWithDeps: entry script ${entry} resolves outside the repo — refusing to copy outside the fixture`,
    );
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
