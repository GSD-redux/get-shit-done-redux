#!/usr/bin/env node
/**
 * lint-test-file-count.cjs — max 2 test files per production module.
 *
 * Scans sdk/src/query/, sdk/src/, gsd-core/bin/lib/, bin/ for production
 * modules, then counts matching test files in tests/ and sdk/src (recursive). Cap is 2
 * (primary + one integration). Over-limit clusters must be in the allowlist with the
 * EXACT set of test filenames grandfathered (identity ratchet via allowlist-ratchet.cjs).
 * Adding a new test file to a capped module is a novel offender; removing one requires
 * pruning the allowlist entry (stale). --json emits structured output.
 *
 * Verdicts: OK_UNDER_LIMIT | OK_IN_ALLOWLIST | FAIL_EXCEEDS_LIMIT |
 *           FAIL_NOVEL_FILES | FAIL_STALE_ALLOWLIST
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const PROD_DIRS = [
  path.join(ROOT, 'sdk', 'src', 'query'),
  path.join(ROOT, 'sdk', 'src'),
  path.join(ROOT, 'gsd-core', 'bin', 'lib'),
  path.join(ROOT, 'bin'),
];
const TEST_DIRS = [
  path.join(ROOT, 'tests'),
  path.join(ROOT, 'sdk', 'src'),
];
const ALLOWLIST_PATH = path.join(__dirname, 'lint-test-file-count.allowlist.json');
const MAX_FILES = 2;

const Verdict = Object.freeze({
  OK_UNDER_LIMIT:       'OK_UNDER_LIMIT',
  OK_IN_ALLOWLIST:      'OK_IN_ALLOWLIST',
  FAIL_EXCEEDS_LIMIT:   'FAIL_EXCEEDS_LIMIT',
  FAIL_NOVEL_FILES:     'FAIL_NOVEL_FILES',
  FAIL_STALE_ALLOWLIST: 'FAIL_STALE_ALLOWLIST',
});

function isTestFile(name) {
  return name.endsWith('.test.ts') || name.endsWith('.test.cjs');
}

function listFiles(dir, pred) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && pred(e.name))
      .map(e => path.join(dir, e.name));
  } catch (_) { return []; }
}

function findTestFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findTestFilesRecursive(full));
    else if (isTestFile(e.name)) out.push(full);
  }
  return out;
}

function prodPrefix(filename) {
  return filename.replace(/\.(cjs|ts|js)$/, '');
}

// Strip .test.{cjs,ts} and .integration.test.ts, then strip issue stamps.
function testEffectivePrefix(testName) {
  const bare = testName
    .replace(/\.integration\.test\.(ts|cjs)$/, '')
    .replace(/\.test\.(ts|cjs)$/, '')
    // #3227: strip a trailing suite/kind qualifier (`.unit`, `.property`,
    // `.security`, `.slow`, `.install`, `.rule`, `.regression`, `.qa`, ...).
    // A production prefix comes from `prodPrefix`, which strips only the file
    // extension, so it never contains a dot — any surviving trailing `.<word>`
    // is a qualifier. Without this, `frontmatter.property` matched no module at
    // all (65 files counted against nothing repo-wide) and `state-contract.unit`
    // matched the SHORTER `state` module through the `prefix + '-'` rule
    // (9 files mis-bucketed).
    .replace(/\.[a-z0-9]+$/i, '');
  const m = bare.match(/^(?:feat|bug|enh|fix)-\d+(?:-\d+)*-(.+)$/);
  return m ? m[1] : bare;
}

function collectProdPrefixes() {
  const map = new Map();
  for (const dir of PROD_DIRS) {
    for (const f of listFiles(dir, n =>
      !isTestFile(n) &&
      !/\.(generated|md|json)(\.|$)/.test(n) &&
      /\.(ts|cjs|js)$/.test(n)
    )) {
      const prefix = prodPrefix(path.basename(f));
      if (!map.has(prefix)) map.set(prefix, f);
    }
  }
  return map;
}

function collectAllTestFiles() {
  const seen = new Set();
  const all = [];
  for (const dir of TEST_DIRS) {
    for (const f of findTestFilesRecursive(dir)) {
      if (!seen.has(f)) { seen.add(f); all.push(f); }
    }
  }
  return all;
}

function buildTestMap(prodPrefixes, allTestFiles) {
  const map = new Map([...prodPrefixes.keys()].map(p => [p, []]));
  for (const tf of allTestFiles) {
    const ep = testEffectivePrefix(path.basename(tf));
    // fs.readdirSync order (and therefore prodPrefixes' Map insertion order,
    // which is built from it in collectProdPrefixes) is NOT stable across
    // platforms/filesystems — e.g. ext4 hash order on Linux CI differs from
    // HFS+/APFS on macOS. When one module's name is a hyphen-extension of
    // another's (e.g. `verify` and `verify-command-grounding`), first-match-
    // wins bucketing is therefore platform-dependent. Scan every candidate
    // and keep the longest (most specific) matching prefix, so the bucket a
    // test file lands in is decided by specificity, never iteration order.
    let bestPrefix = null;
    for (const prefix of prodPrefixes.keys()) {
      if (ep === prefix || ep.startsWith(prefix + '-')) {
        if (bestPrefix === null || prefix.length > bestPrefix.length) {
          bestPrefix = prefix;
        }
      }
    }
    if (bestPrefix !== null) {
      map.get(bestPrefix).push(tf);
    }
  }
  return map;
}

function loadAllowlist() {
  try { return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8')).modules || {}; }
  catch (_) { return {}; }
}

/**
 * Evaluate one module's test files against the allowlist.
 *
 * For modules under the default cap (≤ MAX_FILES): simple count check.
 * For modules with an allowlist entry: identity check via assertWithinAllowlist.
 *   - count now ≤ MAX_FILES → FAIL_STALE_ALLOWLIST (all known files are stale; prune entry)
 *   - novel files (in current but not in known) → FAIL_NOVEL_FILES
 *   - stale files (in known but not in current) → FAIL_STALE_ALLOWLIST
 *   - exact match → OK_IN_ALLOWLIST
 * For modules over the cap with no allowlist entry: FAIL_EXCEEDS_LIMIT.
 *
 * Returns { verdict, prefix, count, knownFiles, novel, stale, files }
 */
function evaluateLint({ prefix, testFiles, allowlist }) {
  const count = testFiles.length;
  const entry = allowlist[prefix];
  const currentNames = testFiles.map(f => path.basename(f));

  if (entry !== undefined) {
    const knownFiles = Array.isArray(entry.files) ? entry.files : [];
    // If the module is now at or under the default cap, the entire allowlist entry is
    // stale and must be removed — this is a ratchet-DOWN failure, not a hint.
    // All known files are stale (the whole entry can go).
    if (count <= MAX_FILES) {
      return {
        verdict: Verdict.FAIL_STALE_ALLOWLIST,
        prefix, count,
        knownFiles,
        novel: [],
        stale: knownFiles.slice().sort(),
        files: testFiles,
      };
    }
    // Identity check via assertWithinAllowlist
    const messages = [];
    const { novel, stale } = assertWithinAllowlist({
      label: prefix,
      current: currentNames,
      known: knownFiles,
      fail: (msg) => messages.push(msg),
      pruneHint: 'scripts/lint-test-file-count.allowlist.json',
    });

    if (novel.length > 0) {
      return { verdict: Verdict.FAIL_NOVEL_FILES,     prefix, count, knownFiles, novel, stale, files: testFiles };
    }
    if (stale.length > 0) {
      return { verdict: Verdict.FAIL_STALE_ALLOWLIST, prefix, count, knownFiles, novel, stale, files: testFiles };
    }
    return { verdict: Verdict.OK_IN_ALLOWLIST,        prefix, count, knownFiles, novel: [], stale: [], files: testFiles };
  }

  if (count <= MAX_FILES) {
    return { verdict: Verdict.OK_UNDER_LIMIT,    prefix, count, knownFiles: null, novel: [], stale: [], files: testFiles };
  }
  return   { verdict: Verdict.FAIL_EXCEEDS_LIMIT, prefix, count, knownFiles: null, novel: [], stale: [], files: testFiles };
}

function run() {
  const jsonMode = process.argv.includes('--json');
  const prodPrefixes = collectProdPrefixes();
  const allTestFiles = collectAllTestFiles();
  const testMap      = buildTestMap(prodPrefixes, allTestFiles);
  const allowlist    = loadAllowlist();

  const results = [];
  for (const [prefix, files] of testMap) {
    if (files.length === 0) continue;
    results.push(evaluateLint({ prefix, testFiles: files, allowlist }));
  }

  const failures = results.filter(r =>
    r.verdict === Verdict.FAIL_EXCEEDS_LIMIT ||
    r.verdict === Verdict.FAIL_NOVEL_FILES ||
    r.verdict === Verdict.FAIL_STALE_ALLOWLIST);

  if (jsonMode) {
    console.log(JSON.stringify({ ok: failures.length === 0, results, failures, hints: [] }, null, 2));
    return failures.length > 0 ? 1 : 0;
  }

  if (failures.length === 0) {
    const inAllowlist = results.filter(r => r.verdict === Verdict.OK_IN_ALLOWLIST).length;
    console.log(`ok lint-test-file-count: ${results.length} module(s) checked, 0 failures` +
      (inAllowlist > 0 ? `, ${inAllowlist} allowlisted` : ''));
    return 0;
  }

  process.stderr.write(`\nERROR lint-test-file-count: ${failures.length} module(s) exceed the test-file limit\n\n`);
  for (const f of failures) {
    if (f.verdict === Verdict.FAIL_EXCEEDS_LIMIT) {
      process.stderr.write(`  ${f.prefix}: ${f.count} files (limit ${MAX_FILES}) — not in allowlist\n`);
      for (const tf of f.files) process.stderr.write(`    ${path.relative(ROOT, tf)}\n`);
    } else if (f.verdict === Verdict.FAIL_NOVEL_FILES) {
      process.stderr.write(`  ${f.prefix}: ${f.novel.length} NEW test file(s) not in allowlist\n`);
      for (const n of f.novel) process.stderr.write(`    + ${n}\n`);
    } else if (f.verdict === Verdict.FAIL_STALE_ALLOWLIST) {
      if (f.count <= MAX_FILES) {
        const staleList = f.stale.join(', ');
        process.stderr.write(`  "${f.prefix}": now at ${f.count} file(s) (≤ ${MAX_FILES}) — remove its entry from the allowlist (stale: ${staleList})\n`);
      } else {
        process.stderr.write(`  ${f.prefix}: ${f.stale.length} allowlisted file(s) no longer present — prune allowlist\n`);
        for (const s of f.stale) process.stderr.write(`    - ${s}\n`);
      }
    }
  }
  process.stderr.write('\nFix: consolidate test files per module (one primary + one integration).\n');
  process.stderr.write('Or update scripts/lint-test-file-count.allowlist.json with PR justification.\n\n');
  return 1;
}

module.exports = {
  Verdict, evaluateLint, testEffectivePrefix, prodPrefix,
  _collectProdPrefixes: collectProdPrefixes,
  _collectAllTestFiles: collectAllTestFiles,
  _buildTestMap: buildTestMap,
  _loadAllowlist: loadAllowlist,
};

if (require.main === module) runMain(run);
