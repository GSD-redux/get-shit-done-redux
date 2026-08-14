#!/usr/bin/env node
'use strict';

/**
 * lint-vendored-deps.cjs — freshness gate for gsd-core/bin/lib/vendor/.
 *
 * #3477 follow-up: gsd-core/bin/** is copied by the installer into trees
 * that have NO node_modules, so it must carry zero external requires
 * (local/no-external-require-in-bin, eslint-rules/no-external-require-in-bin.cjs).
 * `re2js` (src/pattern.cts's RE2 engine) is vendored verbatim under
 * gsd-core/bin/lib/vendor/ instead — see gsd-core/bin/lib/vendor/README.md.
 *
 * A vendored artifact that silently drifts from its upstream package is
 * just as dangerous as never vendoring it in the first place (a stale
 * copy ships a different engine than the one actually reviewed/audited).
 * This guard fails CI when:
 *   1. gsd-core/bin/lib/vendor/re2js.cjs no longer matches
 *      node_modules/re2js/build/index.cjs byte-for-byte.
 *   2. gsd-core/bin/lib/vendor/re2js.d.cts no longer matches
 *      node_modules/re2js/build/index.d.cts byte-for-byte.
 *   3. src/vendor/re2js.d.cts (the source-side twin tsc needs to resolve
 *      types for src/pattern.cts's relative './vendor/re2js.cjs' import —
 *      module resolution for a .cts source is relative to src/, not the
 *      output dir) no longer matches gsd-core/bin/lib/vendor/re2js.d.cts.
 *   4. The `re2js` version pinned in package.json `devDependencies` no
 *      longer matches the version actually installed at
 *      node_modules/re2js/package.json (read there, per the dispatch
 *      brief, rather than duplicating a second pin).
 *
 * Usage: node scripts/lint-vendored-deps.cjs
 * Exit 0 when every vendored copy is fresh; 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

const REFRESH_COMMAND =
  'cp node_modules/re2js/build/index.cjs gsd-core/bin/lib/vendor/re2js.cjs && '
  + 'cp node_modules/re2js/build/index.d.cts gsd-core/bin/lib/vendor/re2js.d.cts && '
  + 'cp node_modules/re2js/build/index.d.cts src/vendor/re2js.d.cts';

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

function main() {
  const findings = [];

  const cjsDrift = compareFiles('gsd-core/bin/lib/vendor/re2js.cjs', 'node_modules/re2js/build/index.cjs');
  if (cjsDrift) findings.push(cjsDrift);

  const dctsDrift = compareFiles('gsd-core/bin/lib/vendor/re2js.d.cts', 'node_modules/re2js/build/index.d.cts');
  if (dctsDrift) findings.push(dctsDrift);

  const srcTwinDrift = compareFiles('src/vendor/re2js.d.cts', 'gsd-core/bin/lib/vendor/re2js.d.cts');
  if (srcTwinDrift) findings.push(srcTwinDrift);

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pinnedSpec = pkg.devDependencies && pkg.devDependencies.re2js;
  if (!pinnedSpec) {
    findings.push('package.json devDependencies.re2js is missing');
  } else {
    const installedPkgPath = path.join(ROOT, 'node_modules', 're2js', 'package.json');
    if (!fs.existsSync(installedPkgPath)) {
      findings.push('node_modules/re2js/package.json does not exist (run npm install)');
    } else {
      const installed = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
      const pinned = stripRangeOperator(pinnedSpec);
      if (pinned !== installed.version) {
        findings.push(
          `package.json devDependencies.re2js ("${pinnedSpec}" -> "${pinned}") != `
            + `node_modules/re2js/package.json version ("${installed.version}")`,
        );
      }
    }
  }

  if (findings.length > 0) {
    const detail = findings.map((f) => `  ${f}`).join('\n');
    throw new ExitError(
      1,
      'lint-vendored-deps: gsd-core/bin/lib/vendor/re2js.* has drifted from its\n'
        + 'upstream package (or its version pin). Refresh with:\n'
        + `  ${REFRESH_COMMAND}\n`
        + 'Findings:\n'
        + detail,
    );
  }

  process.stdout.write('ok lint-vendored-deps: gsd-core/bin/lib/vendor/re2js.* matches node_modules/re2js and its pinned version\n');
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { compareFiles, stripRangeOperator };
