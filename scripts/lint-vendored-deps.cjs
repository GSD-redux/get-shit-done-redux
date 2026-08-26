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
 * 2 and 3 (the byte-compares) — there is no upstream/bin-side counterpart
 * to compare against, and that is deliberate rather than a gap in coverage.
 * They get a DIFFERENT check instead (#3881 review, finding 4): every
 * value-level export the twin DECLARES (`export function`/`export const`,
 * not a type/interface) must be an actual own property of the vendored
 * runtime module. `srcTwin` was previously read only inside the
 * upstream-verbatim branch — for a hand-authored row it was declared and
 * never consulted by anything, so a stale claim in the twin (a declared
 * export that no longer exists at runtime, or the reverse) could drift
 * silently. This is how a hand-authored twin's docblock/type surface could
 * make a false claim about the runtime (ADR-3473 §8.1, finding 2) without
 * this gate — or any other — ever catching it.
 *
 * Usage: node scripts/lint-vendored-deps.cjs
 * Exit 0 when every vendored copy is fresh; 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

/**
 * Resolve a path that may be either repo-relative (the shape every VENDORED
 * row and CLI usage actually passes) or already absolute (the shape a test
 * exercising drift against a scratch file outside the repo passes). Joining
 * an absolute path onto ROOT via `path.join(ROOT, abs)` silently produces a
 * nonsense path (Windows: crossing drive letters is not even representable
 * as a relative join; POSIX: an absolute second segment wins but the result
 * is coincidental, not correct) — this makes "absolute in, absolute out"
 * explicit instead of relying on that coincidence.
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

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
  const absA = resolvePath(relA);
  const absB = resolvePath(relB);
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
 * Extract every value-level export name (`export function foo` / `export const
 * foo`) declared in a hand-authored `.d.cts` twin. Deliberately excludes
 * `export type`/`export interface` — those have no runtime existence to check
 * against, so including them would only ever produce false failures.
 * @param {string} dctsSource
 * @returns {string[]}
 */
function declaredValueExports(dctsSource) {
  const names = [];
  const re = /^export\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(dctsSource)) !== null) names.push(m[1]);
  return names;
}

/**
 * #3881 review, finding 4: for a `hand-authored` twin, verify every value-level
 * export it DECLARES is an actual own property of the vendored runtime module —
 * the check `srcTwin` previously had no consumer for. Returns findings (empty
 * when the twin's declared surface matches runtime reality).
 * @param {VendoredPackage} row
 * @returns {string[]}
 */
function checkHandAuthoredTwin(row) {
  if (!row.srcTwin) return [`${row.name}: twinKind 'hand-authored' but srcTwin is null`];
  const twinPath = resolvePath(row.srcTwin);
  if (!fs.existsSync(twinPath)) return [`${row.srcTwin} does not exist`];

  const declared = declaredValueExports(fs.readFileSync(twinPath, 'utf8'));
  if (declared.length === 0) {
    return [`${row.srcTwin} declares zero value-level exports — nothing for this twin to gate`];
  }

  const runtimeModule = require(resolvePath(row.vendoredCjs));
  const findings = [];
  for (const name of declared) {
    if (!Object.prototype.hasOwnProperty.call(runtimeModule, name)) {
      findings.push(
        `${row.srcTwin} declares export "${name}" — not an own property of ${row.vendoredCjs} at runtime`,
      );
    }
  }
  return findings;
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
  } else if (row.twinKind === 'hand-authored') {
    findings.push(...checkHandAuthoredTwin(row));
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

module.exports = {
  compareFiles,
  stripRangeOperator,
  VENDORED,
  buildRefreshCommand,
  checkRow,
  declaredValueExports,
  checkHandAuthoredTwin,
  resolvePath,
};
