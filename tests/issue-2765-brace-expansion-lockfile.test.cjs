// allow-test-rule: structural-implementation-guard (#2765)
'use strict';

// Regression guard for #2765: the lockfile must pin the patched brace-expansion
// versions (>=1.1.18 for the 1.x line, >=5.0.9 for the 5.x line) published 2026-07-30
// to resolve the high-severity DoS/OOM advisories (GHSA-3jxr-9vmj-r5cp /
// GHSA-mh99-v99m-4gvg, range <=5.0.7). This is a lockfile-only devDependency bump
// (eslint/stryker → minimatch → brace-expansion); production (npm audit --omit=dev) is
// unaffected. The test pins the installed versions so the bump can't silently regress.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function npmLs(pkg) {
  // `npm ls <pkg> --json --all` lists every installed copy with its version. Collect
  // the version of every node whose key is `pkg` (not the parent packages).
  const out = execFileSync('npm', ['ls', pkg, '--json', '--all'], {
    cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'],
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

test('all installed brace-expansion copies are patched (>=1.1.18 / >=5.0.9) — #2765', () => {
  const versions = npmLs('brace-expansion');
  assert.ok(versions.length > 0, 'brace-expansion must be installed (devDependency) to guard');
  for (const v of versions) {
    const [maj, min, pat] = v.split('.').map(Number);
    const ok = (maj === 1 && (min > 1 || (min === 1 && pat >= 18))) // 1.x >= 1.1.18
      || (maj === 5 && (min > 0 || pat >= 9))                       // 5.x >= 5.0.9
      || (maj > 5);                                                 // >5.x
    assert.ok(ok,
      `brace-expansion@${v} is within the vulnerable range (<=5.0.7) — lockfile regressed the #2765 patch bump. ` +
      'Re-apply: npm audit fix (non-breaking) to bump to 1.1.18 / 5.0.9.');
  }
});
