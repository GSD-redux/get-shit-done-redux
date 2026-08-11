#!/usr/bin/env node
'use strict';

/**
 * Canary-version-leak lint (DEFECT.CANARY-VERSION-LEAK, CONTEXT.md).
 *
 * `package.json` `.version` on `main` must never carry a `-canary.<N>`
 * suffix — that suffix is a dev-branch/prerelease marker. Nothing published
 * depends on the string at runtime, but every consumer of the version
 * metadata (release flow, install banners, statusline) surfaces the
 * dev-channel label as if it were the shipped release. The 2026-05-16 audit
 * found `origin/main` at `"version": "1.50.0-canary.0"`, landed by a fix PR
 * that accidentally carried a version bump from a dev-branch base (commit
 * 2d32ad82, #3206).
 *
 * Modeled on scripts/lint-package-identity-drift.cjs / scripts/lint-table-schema-drift.cjs:
 * a standalone node script (not a node:test), exit 0 clean / exit 1 + message
 * on a leaked canary version. Wired to run only for PRs targeting `main`
 * (.github/workflows/version-gate.yml) — a canary version is expected and
 * harmless on every other branch.
 */

const fs = require('node:fs');
const path = require('node:path');

const CANARY_RE = /-canary\.\d+/;

/**
 * Pure: does this version string carry a `-canary.<N>` suffix?
 * @param {string} version
 * @returns {boolean}
 */
function isCanaryVersion(version) {
  return typeof version === 'string' && CANARY_RE.test(version);
}

/**
 * Read `<root>/package.json` and return its `.version`, or null if the file
 * is missing/unreadable/unparsable.
 * @param {string} root
 * @returns {string|null}
 */
function readPackageVersion(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function main() {
  const root = path.join(__dirname, '..');
  const version = readPackageVersion(root);
  if (version == null) {
    process.stderr.write('canary-version-leak: could not read/parse package.json .version\n');
    process.exitCode = 1;
    return;
  }
  if (!isCanaryVersion(version)) {
    process.stdout.write(`ok canary-version-leak: package.json version '${version}' carries no -canary.<N> suffix\n`);
    return;
  }
  process.stderr.write(`canary-version-leak: package.json version '${version}' carries a -canary.<N> suffix (DEFECT.CANARY-VERSION-LEAK).\n`);
  process.stderr.write('A -canary.<N> version must never land on main. Reset .version to the canonical\n');
  process.stderr.write('pre-canary stable before merging — see CONTEXT.md DEFECT.CANARY-VERSION-LEAK.\n');
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { isCanaryVersion, readPackageVersion, CANARY_RE };
