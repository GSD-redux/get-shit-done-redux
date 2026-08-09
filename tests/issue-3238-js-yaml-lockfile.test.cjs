// allow-test-rule: structural-implementation-guard (#3238)
'use strict';

// Regression guard for #3238: the lockfile must pin a patched js-yaml (>=4.3.1 on the
// 4.x line, >=3.15.1 on the 3.x line) to resolve GHSA-5p4m-2wfm-xmqj — a high-severity
// (CVSS 7.5, CWE-407) quadratic-CPU DoS in `!!omap` resolution, vulnerable range
// `>=4.0.0 <4.3.1`. `!!omap` is in the DEFAULT schema, so a plain yaml.load() is
// affected. This is a lockfile-only devDependency bump (direct, plus an
// @eslint/eslintrc dedupe); production (npm audit --omit=dev) was already clean.
// The test pins every installed copy so the bump can't silently regress.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// `npm` is not process.execPath, git, or a bash script/hook, so this does not
// route through tests/helpers/process-seam.cjs (whose runNode/runGit/runHook
// primitives cover exactly those three shapes and forward no `shell` option)
// — `npm` needs `shell: true` on Windows (npm.cmd), which the seam has no
// surface for. Bounding this directly with an explicit `timeout` is the
// documented alternative in eslint-rules/no-unbounded-spawn.cjs.
const NPM_LS_TIMEOUT_MS = 30000;

function npmLs(pkg) {
  // `npm ls <pkg> --json --all` lists every installed copy with its version. Collect
  // the version of every node whose key is `pkg` (not the parent packages).
  const out = execFileSync('npm', ['ls', pkg, '--json', '--all'], {
    cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'],
    timeout: NPM_LS_TIMEOUT_MS,
  });
  const versions = [];
  const walk = (node) => {
    if (!node || !node.dependencies) return;
    for (const [k, v] of Object.entries(node.dependencies)) {
      if (k === pkg && v && v.version) versions.push(v.version);
      walk(v);
    }
  };
  walk(JSON.parse(out));
  return versions;
}

// GHSA-5p4m-2wfm-xmqj names only the 3.x (<3.15.1) and 4.x (<4.3.1) lines. The SAME
// weakness in the 5.x line is CVE-2026-59870 / GHSA-724g-mxrg-4qvm, fixed in 5.2.1 —
// so a guard against this bug CLASS must require 5.2.1 there too rather than waving
// every 5.x through, or an accidental major bump to 5.0.0 would reintroduce the exact
// quadratic `!!omap` resolution this test exists to prevent.
function isPatched(version) {
  const core = String(version).split('+')[0]; // drop build metadata
  // A prerelease of the patched version (e.g. 4.3.1-beta.1) sorts BELOW it in semver
  // and may predate the fix — fail closed rather than guess.
  if (core.includes('-')) return false;
  const [maj, min, pat] = core.split('.').map(Number);
  if (![maj, min, pat].every(Number.isInteger)) return false; // unparseable — fail closed
  if (maj < 3) return true;                                   // predates the affected lines
  if (maj === 3) return min > 15 || (min === 15 && pat >= 1);  // 3.x >= 3.15.1
  if (maj === 4) return min > 3 || (min === 3 && pat >= 1);    // 4.x >= 4.3.1
  if (maj === 5) return min > 2 || (min === 2 && pat >= 1);    // 5.x >= 5.2.1 (CVE-2026-59870)
  return true;                                                // >5.x
}

test('all installed js-yaml copies are patched (>=4.3.1 / >=3.15.1 / >=5.2.1) — #3238', () => {
  const versions = npmLs('js-yaml');
  // Vacuity guard: an empty list would make every assertion below trivially true.
  assert.ok(versions.length > 0, 'js-yaml must be installed (devDependency) to guard');
  for (const v of versions) {
    assert.ok(isPatched(v),
      `js-yaml@${v} is not a patched version — the quadratic \`!!omap\` resolution bug is ` +
      'present in 3.x <3.15.1 (GHSA-5p4m-2wfm-xmqj), 4.x <4.3.1 (same), and 5.x <5.2.1 ' +
      '(CVE-2026-59870). Re-apply: npm install js-yaml@^4.3.1');
  }
});
