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

test('all installed js-yaml copies are patched (>=4.3.1 / >=3.15.1) — #3238', () => {
  const versions = npmLs('js-yaml');
  // Vacuity guard: an empty list would make every assertion below trivially true.
  assert.ok(versions.length > 0, 'js-yaml must be installed (devDependency) to guard');
  for (const v of versions) {
    const [maj, min, pat] = v.split('.').map(Number);
    const ok = (maj === 3 && (min > 15 || (min === 15 && pat >= 1)))  // 3.x >= 3.15.1
      || (maj === 4 && (min > 3 || (min === 3 && pat >= 1)))          // 4.x >= 4.3.1
      || (maj > 4);                                                   // >4.x
    assert.ok(ok,
      `js-yaml@${v} is within the vulnerable range (>=4.0.0 <4.3.1 / >=3.0.0 <3.15.1) — ` +
      'lockfile regressed the #3238 patch bump (GHSA-5p4m-2wfm-xmqj). ' +
      'Re-apply: npm install js-yaml@^4.3.1');
  }
});
