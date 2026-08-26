#!/usr/bin/env node
'use strict';

/**
 * lint-vendored-deps.cjs — freshness gate for gsd-core/bin/lib/vendor/.
 *
 * #3477 follow-up: gsd-core/bin/** is copied by the installer into trees
 * that have NO node_modules, so it must carry zero external requires
 * (local/no-external-require-in-bin, eslint-rules/no-external-require-in-bin.cjs).
 * Third-party packages that gsd-core/bin/** needs at runtime are instead
 * vendored verbatim under gsd-core/bin/lib/vendor/ — see
 * gsd-core/bin/lib/vendor/README.md.
 *
 * A vendored artifact that silently drifts from its upstream package is
 * just as dangerous as never vendoring it in the first place (a stale
 * copy ships a different engine than the one actually reviewed/audited).
 * #3881: this used to be a single hand-rolled check hardcoded to `re2js`.
 * It is now table-driven (VENDORED below), so adding a second vendored
 * package (js-yaml, #3881) does not require a second hardcoded block —
 * that would violate ADR-3473 §8.3, "one implementation per rule."
 *
 * For each row in VENDORED, this guard fails CI when:
 *   1. The vendored `.cjs` no longer matches its upstream `node_modules`
 *      build output byte-for-byte.
 *   2. (upstream-verbatim twins only) The vendored `.d.cts` under
 *      gsd-core/bin/lib/vendor/ no longer matches its upstream
 *      `node_modules` `.d.cts` byte-for-byte.
 *   3. (upstream-verbatim twins only) The source-side twin under
 *      src/vendor/ (which tsc needs to resolve types for a relative
 *      `./vendor/<pkg>.cjs` import — module resolution for a .cts source
 *      is relative to src/, not the output dir) no longer matches the
 *      vendored `.d.cts` under gsd-core/bin/lib/vendor/.
 *   4. The package's version pinned in package.json `devDependencies` no
 *      longer matches the version actually installed at
 *      `node_modules/<pkg>/package.json` (read there, per the dispatch
 *      brief, rather than duplicating a second pin).
 *
 * Hand-authored twins (js-yaml.d.cts, #3881: js-yaml ships no type
 * declarations upstream, so there is nothing to byte-compare) skip checks
 * 2 and 3 entirely — there is no upstream/bin-side counterpart to compare
 * against, and that is deliberate rather than a gap in coverage.
 *
 * Usage: node scripts/lint-vendored-deps.cjs
 * Exit 0 when every vendored copy is fresh; 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

/**
 * One row per vendored third-party package.
 *
 * @typedef {object} VendoredPackage
 * @property {string} name              npm package name, matches package.json devDependencies key
 * @property {string} upstreamCjs       path under node_modules/ to the upstream build artifact
 * @property {string} vendoredCjs       path under gsd-core/bin/lib/vendor/ to the vendored copy
 * @property {string|null} upstreamDts  path under node_modules/ to the upstream .d.cts/.d.ts, or
 *                                       null when upstream ships no types (forces hand-authored)
 * @property {string|null} vendoredDts  path under gsd-core/bin/lib/vendor/ to the vendored .d.cts,
 *                                       or null when there is no bin-side type twin
 * @property {string|null} srcTwin      path under src/vendor/ to the source-side type twin tsc
 *                                       resolves for a relative import from src/**, or null
 * @property {'upstream-verbatim'|'hand-authored'} twinKind
 *                                       'upstream-verbatim': srcTwin/vendoredDts are byte-compared
 *                                       against upstream and each other.
 *                                       'hand-authored': no upstream counterpart exists, so the
 *                                       twin is excluded from the byte-compare (checks 2 and 3
 *                                       above are skipped for this row).
 */

/** @type {VendoredPackage[]} */
const VENDORED = [
  {
    name: 're2js',
    upstreamCjs: 'node_modules/re2js/build/index.cjs',
    vendoredCjs: 'gsd-core/bin/lib/vendor/re2js.cjs',
    upstreamDts: 'node_modules/re2js/build/index.d.cts',
    vendoredDts: 'gsd-core/bin/lib/vendor/re2js.d.cts',
    srcTwin: 'src/vendor/re2js.d.cts',
    twinKind: 'upstream-verbatim',
  },
  {
    name: 'js-yaml',
    upstreamCjs: 'node_modules/js-yaml/dist/js-yaml.js',
    vendoredCjs: 'gsd-core/bin/lib/vendor/js-yaml.cjs',
    upstreamDts: null,
    vendoredDts: null,
    srcTwin: 'src/vendor/js-yaml.d.cts',
    twinKind: 'hand-authored',
  },
];

/**
 * Build the `cp` refresh command for one vendored package. Hand-authored
 * twins have no upstream .d.ts to cp, so only the .cjs line is emitted for
 * them; the twin itself must be refreshed by hand against the new API.
 * @param {VendoredPackage} row
 * @returns {string}
 */
function buildRefreshCommand(row) {
  const parts = [`cp ${row.upstreamCjs} ${row.vendoredCjs}`];
  if (row.twinKind === 'upstream-verbatim' && row.upstreamDts) {
    if (row.vendoredDts) parts.push(`cp ${row.upstreamDts} ${row.vendoredDts}`);
    if (row.srcTwin) parts.push(`cp ${row.upstreamDts} ${row.srcTwin}`);
  }
  return parts.join(' && ');
}

const REFRESH_COMMAND = VENDORED.map(buildRefreshCommand).join(' && ');

/**
 * Compare two files byte-for-byte. Returns null when equal, or a short
 * mismatch description (missing file / byte-length delta) otherwise.
 * @param {string} relA
 * @param {string} relB
 * @returns {string | null}
 */
function compareFiles(relA, relB) {
  const absA = path.join(ROOT, relA);
  const absB = path.join(ROOT, relB);
  if (!fs.existsSync(absA)) return `${relA} does not exist`;
  if (!fs.existsSync(absB)) return `${relB} does not exist`;
  const a = fs.readFileSync(absA);
  const b = fs.readFileSync(absB);
  if (a.equals(b)) return null;
  return `${relA} (${a.length} bytes) != ${relB} (${b.length} bytes)`;
}

/**
 * Strip a leading semver range operator (^, ~, >=, >, <=, <, =) from a
 * package.json dependency spec, leaving a bare version.
 * @param {string} spec
 * @returns {string}
 */
function stripRangeOperator(spec) {
  return String(spec || '').trim().replace(/^[\^~]|^>=|^<=|^>|^<|^=/, '').trim();
}

/**
 * Run all applicable freshness checks for one vendored package row.
 * @param {VendoredPackage} row
 * @returns {string[]} findings (empty when the row is fresh)
 */
function checkRow(row) {
  const findings = [];

  const cjsDrift = compareFiles(row.vendoredCjs, row.upstreamCjs);
  if (cjsDrift) findings.push(cjsDrift);

  if (row.twinKind === 'upstream-verbatim') {
    if (row.upstreamDts && row.vendoredDts) {
      const dctsDrift = compareFiles(row.vendoredDts, row.upstreamDts);
      if (dctsDrift) findings.push(dctsDrift);
    }
    if (row.srcTwin && row.vendoredDts) {
      const srcTwinDrift = compareFiles(row.srcTwin, row.vendoredDts);
      if (srcTwinDrift) findings.push(srcTwinDrift);
    }
  }

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pinnedSpec = pkg.devDependencies && pkg.devDependencies[row.name];
  if (!pinnedSpec) {
    findings.push(`package.json devDependencies.${row.name} is missing`);
  } else {
    const installedPkgPath = path.join(ROOT, 'node_modules', row.name, 'package.json');
    if (!fs.existsSync(installedPkgPath)) {
      findings.push(`node_modules/${row.name}/package.json does not exist (run npm install)`);
    } else {
      const installed = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
      const pinned = stripRangeOperator(pinnedSpec);
      if (pinned !== installed.version) {
        findings.push(
          `package.json devDependencies.${row.name} ("${pinnedSpec}" -> "${pinned}") != `
            + `node_modules/${row.name}/package.json version ("${installed.version}")`,
        );
      }
    }
  }

  return findings;
}

function main() {
  const findings = [];
  for (const row of VENDORED) {
    findings.push(...checkRow(row));
  }

  if (findings.length > 0) {
    const detail = findings.map((f) => `  ${f}`).join('\n');
    const names = VENDORED.map((row) => row.name).join(', ');
    throw new ExitError(
      1,
      `lint-vendored-deps: gsd-core/bin/lib/vendor/{${names}} has drifted from its\n`
        + 'upstream package (or its version pin). Refresh with:\n'
        + `  ${REFRESH_COMMAND}\n`
        + 'Findings:\n'
        + detail,
    );
  }

  const names = VENDORED.map((row) => row.name).join(', ');
  process.stdout.write(`ok lint-vendored-deps: gsd-core/bin/lib/vendor/{${names}} match node_modules and their pinned versions\n`);
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { compareFiles, stripRangeOperator, VENDORED, buildRefreshCommand, checkRow };
