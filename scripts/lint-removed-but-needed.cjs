#!/usr/bin/env node
'use strict';

/**
 * lint-removed-but-needed.cjs — DEFECT.REMOVED-BUT-NEEDED (CONTEXT.md).
 *
 * ## Why
 *
 * A file/key gets removed because "no longer used" without verifying every
 * consumer (workflows, docs, manifests, npm scripts, tests). #3316: root
 * `package-lock.json` was deleted while `package.json` still declares deps
 * and workflows still use `cache: 'npm'` + `npm ci` (which require a
 * lockfile). e3b52c70: docs referenced a removed `/gsd-new-workspace`
 * workflow after it was deleted. #3560: a deleted workflow was pinned by an
 * existence assertion in `tests/phase.test.cjs` — the lint passed clean and
 * the breakage surfaced only as four red tests on the remote runner,
 * because `tests/` was not scanned at all.
 *
 * ## What this checks
 *
 * For every file deleted (`git diff --name-status <base>...HEAD`, status
 * `D`), grep the post-diff tree for the deleted file's basename:
 *
 * - `.github/workflows/`, `gsd-core/`, `docs/`, `package.json` — ANY
 *   surviving reference fails (the original rule).
 * - `tests/` — scanned with a discriminator (#3565): a reference that PINS
 *   existence (`fs.existsSync(path)`, `readFileSync`, `require`, or the
 *   basename as a quoted object key) fails; a reference that ASSERTS
 *   ABSENCE (`assert.ok(!content.includes('x.md'))`, `!fs.existsSync(...)`)
 *   is the correct post-deletion state and passes. The naive widening —
 *   flagging every mention — was tried in #3560 and reverted: an absence
 *   assertion must contain the basename to assert the file is gone, so
 *   without the two kinds separated the guard fires on correct code and
 *   gets disabled. A mention that is neither a pin nor an absence
 *   assertion (prose, a path assembled on another line) is not flagged —
 *   a documented known limit, chosen because a false violation reds a
 *   correct tree while a missed prose mention only loses one detection
 *   channel.
 *
 * `package-lock.json` deletions additionally fail if any workflow still
 * uses `npm ci` or `cache: 'npm'`/`cache: "npm"` — those depend on a
 * lockfile even though they never spell out its filename.
 *
 * ## False-positive risk (moderate, per audit)
 *
 * A common basename (`index.js`, `config.json`) can coincidentally match an
 * unrelated file, and this only catches LITERAL string references — not a
 * variable holding the filename or a glob that happened to match it.
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { sanitizeEcho } = require('./command-contract-helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['.github/workflows', 'gsd-core', 'docs'];
const EXTRA_FILES = ['package.json'];
const TESTS_ROOT = 'tests';

// Skip these when walking SCAN_ROOTS — binary/generated content that can
// never carry a meaningful basename reference, and is often large.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.zip']);

/**
 * Pure: does `content` contain a literal reference to `basename`, delimited
 * by non-identifier/non-path characters on both sides (so "foo.json" doesn't
 * match inside "old-foo.json.bak" style names but does match in a normal
 * path/prose context)?
 * @param {string} content
 * @param {string} basename
 * @returns {boolean}
 */
function referencesBasename(content, basename) {
  const re = new RegExp(`(^|[^\\w.-])${escapeRegex(basename)}($|[^\\w.-])`);
  return re.test(content);
}

/**
 * Pure: given the deleted file's basename, does content contain a
 * lockfile-dependent idiom (`npm ci`, `cache: 'npm'` / `cache: "npm"`)?
 * Only meaningful for package-lock.json deletions.
 * @param {string} content
 * @returns {boolean}
 */
function referencesNpmLockfileDependency(content) {
  return /\bnpm ci\b/.test(content) || /cache:\s*['"]npm['"]/.test(content);
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && !SKIP_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Pure: given a list of deleted basenames and a `{ file, content }[]` corpus
 * of the post-diff tree, find every surviving reference.
 * @param {string[]} deletedFiles - repo-relative deleted paths
 * @param {{ file: string, content: string }[]} corpus
 * @returns {{ deletedFile: string, referencedIn: string, reason: string }[]}
 */
function findSurvivingReferences(deletedFiles, corpus) {
  const violations = [];
  for (const deletedFile of deletedFiles) {
    const basename = path.basename(deletedFile);
    for (const { file, content } of corpus) {
      if (referencesBasename(content, basename)) {
        violations.push({ deletedFile, referencedIn: file, reason: `basename '${basename}' still referenced` });
      }
    }
    if (basename === 'package-lock.json') {
      for (const { file, content } of corpus) {
        if (file.startsWith('.github/workflows') && referencesNpmLockfileDependency(content)) {
          violations.push({
            deletedFile,
            referencedIn: file,
            reason: '`npm ci` / `cache: \'npm\'` still present — both require a lockfile',
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Pure: classify ONE line of a test file that references `basename`.
 * Returns 'asserts-absence' | 'pins-existence' | null.
 *
 * - asserts-absence: a NEGATED check carrying the basename —
 *   `assert.ok(!content.includes('x.md'))`, `!fs.existsSync(p)`,
 *   `!/x\.md/.test(s)`. The basename must appear for the assertion to
 *   work, so this is the CORRECT post-deletion state (#3560's reverted
 *   naive widening fired exactly here).
 * - pins-existence: a direct dependency on the file existing —
 *   `fs.existsSync/readFileSync/statSync/readdirSync/require(...)` on the
 *   same line, or the basename as a quoted object key (`'x.md': ...`,
 *   the allowlist trap — a key means the test resolves against the file).
 * - null: neither (prose mention, path assembled on another line). Not a
 *   violation — see the header's known-limit note.
 *
 * @param {string} line
 * @param {string} basename
 * @returns {'asserts-absence'|'pins-existence'|null}
 */
function classifyTestReference(line, basename) {
  const negatedCheck =
    /!\s*[A-Za-z_$][\w.$]*\.(includes|indexOf|search|startsWith|endsWith|match)\s*\(/.test(line) ||
    /!\s*(fs\.)?(existsSync|statSync)\s*\(/.test(line) ||
    // [^/\n]* (not .*) so an adversarial line cannot backtrack the regex
    /!\s*\/[^/\n]*\/\s*\.(test|match)\s*\(/.test(line);
  if (negatedCheck) return 'asserts-absence';
  const pinsByCall =
    /\b(existsSync|readFileSync|statSync|readdirSync|require|accessSync)\s*\(/.test(line) ||
    /\brequire\s*\(?['"]/.test(line);
  if (pinsByCall) return 'pins-existence';
  // Template literal needs \\s so the RegExp constructor receives \s — a
  // bare \s in a template literal collapses to 's' and silently matches a
  // literal 's' instead of whitespace.
  if (new RegExp(`['"\`]${escapeRegex(basename)}['"\`]\\s*:`).test(line)) return 'pins-existence';
  return null;
}

/**
 * Pure: for every deleted basename, scan the tests corpus line by line and
 * report each `pins-existence` reference as a violation. `asserts-absence`
 * references are explicitly NOT violations; unclassifiable mentions are
 * skipped (known limit). Violations are per-reference — one test file
 * carrying both an absence assertion and an existence pin reports the pin.
 *
 * @param {string[]} deletedFiles - repo-relative deleted paths
 * @param {{ file: string, content: string }[]} testsCorpus
 * @returns {{ deletedFile: string, referencedIn: string, reason: string }[]}
 */
function findSurvivingTestReferences(deletedFiles, testsCorpus) {
  const violations = [];
  for (const deletedFile of deletedFiles) {
    const basename = path.basename(deletedFile);
    const refRe = new RegExp(`(^|[^\\w.-])${escapeRegex(basename)}($|[^\\w.-])`);
    for (const { file, content } of testsCorpus) {
      for (const line of content.split(/\r?\n/)) {
        if (!refRe.test(line)) continue;
        const kind = classifyTestReference(line, basename);
        if (kind === 'pins-existence') {
          violations.push({
            deletedFile,
            referencedIn: file,
            // control-char-stripped + capped: this text is echoed into lint
            // output that AI agents read as trusted instructions
            reason: `pins-existence: test depends on deleted basename '${basename}' — ${sanitizeEcho(line.trim())}`,
          });
        }
        // 'asserts-absence' is correct post-deletion state; null is a
        // documented known limit — neither is a violation.
      }
    }
  }
  return violations;
}

function getDeletedFiles(root, baseRef) {
  // Deliberately let a git failure (unresolvable ref, no merge base, etc.)
  // propagate as a plain Error — main() treats ANY scan() failure as "cannot
  // resolve this base ref in this environment" and degrades to a skip,
  // matching lint-fix-has-regression-test.cjs. There is no failure mode here
  // that should hard-exit non-zero; a real drift is only ever reported once
  // the diff succeeds and findSurvivingReferences finds a violation.
  const out = cp.execFileSync('git', ['diff', '--name-status', `${baseRef}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.startsWith('D\t'))
    .map((line) => line.slice(2));
}

function buildCorpus(root) {
  const corpus = [];
  for (const rel of SCAN_ROOTS) {
    for (const abs of walk(path.join(root, rel))) {
      try {
        corpus.push({ file: path.relative(root, abs).replace(/\\/g, '/'), content: fs.readFileSync(abs, 'utf8') });
      } catch {
        // unreadable (broken symlink, binary that slipped past SKIP_EXT) — skip
      }
    }
  }
  for (const rel of EXTRA_FILES) {
    const abs = path.join(root, rel);
    try {
      corpus.push({ file: rel, content: fs.readFileSync(abs, 'utf8') });
    } catch {
      // optional file absent — skip
    }
  }
  return corpus;
}

function scan(root, baseRef) {
  const deletedFiles = getDeletedFiles(root, baseRef);
  if (deletedFiles.length === 0) return [];
  const corpus = buildCorpus(root);
  const violations = findSurvivingReferences(deletedFiles, corpus);
  // tests/ arm (#3565): same deletions, discriminated references. A bare
  // mention that pins nothing is skipped; an absence assertion is the
  // correct post-deletion state; only a pin on a deleted file fails.
  const testsCorpus = [];
  for (const abs of walk(path.join(root, TESTS_ROOT))) {
    try {
      testsCorpus.push({
        file: path.relative(root, abs).replace(/\\/g, '/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    } catch {
      // unreadable (broken symlink, binary that slipped past SKIP_EXT) — skip
    }
  }
  violations.push(...findSurvivingTestReferences(deletedFiles, testsCorpus));
  return violations;
}

function main() {
  const baseRef = `origin/${process.env.GSD_REMOVED_BUT_NEEDED_BASE || process.env.GITHUB_BASE_REF || 'next'}`;
  let violations;
  try {
    violations = scan(ROOT, baseRef);
  } catch (e) {
    // origin/<base> unreachable in this environment (e.g. a shallow local
    // clone with no matching remote-tracking ref) — degrade to a skip rather
    // than a false failure, matching lint-fix-has-regression-test.cjs.
    console.log(`lint-removed-but-needed: could not resolve ${baseRef}, skipping (${e.message})`);
    return;
  }
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  ${v.deletedFile} deleted, but still referenced in ${v.referencedIn}: ${v.reason}`)
      .join('\n');
    throw new ExitError(
      1,
      'lint-removed-but-needed: a deleted file is still referenced by a live consumer\n'
        + '(DEFECT.REMOVED-BUT-NEEDED). Either restore the file or update every consumer in the\n'
        + 'same commit — do not paper over with a workaround that loses reproducibility:\n'
        + detail,
    );
  }
  console.log('ok lint-removed-but-needed: no deleted file has a surviving reference');
}

module.exports = {
  referencesBasename,
  referencesNpmLockfileDependency,
  findSurvivingReferences,
  classifyTestReference,
  findSurvivingTestReferences,
  getDeletedFiles,
  buildCorpus,
  scan,
  SCAN_ROOTS,
  EXTRA_FILES,
  TESTS_ROOT,
};

if (require.main === module) runMain(main);
