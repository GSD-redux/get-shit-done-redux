#!/usr/bin/env node
'use strict';

/**
 * scripts/lint-mutation-test-derivation-drift.cjs
 *
 * #3881 follow-up ("one YAML parser" mutation-matrix piece 2): guards the
 * derivation engine in scripts/mutation-matrix.cjs against the exact drift
 * class PR #3888 shipped — a test file added on a branch that directly
 * `require()`s a covered module's built artifact AND names itself after that
 * module (`<module>.test.cjs` / `<module>.property.test.cjs` /
 * `<module>-anything.test.cjs`), yet is never wired into that module's
 * mutation shard.
 *
 * `scripts/mutation-matrix.cjs`'s `computeModuleTests` already derives most of
 * a module's `tests` array automatically from exactly that (require + naming)
 * signal, so a NEWLY drifting file of that shape is normally impossible — it
 * would be auto-included the moment it exists. What this guard catches is the
 * one case the derivation cannot self-correct: a file matching BOTH signals
 * that the module's own `excludeTests` withholds. `excludeTests` entries are
 * a deliberate, reasoned decision (see mutation-matrix.cjs's per-module
 * comments) — this guard does not second-guess that decision, but it DOES
 * verify every such file is EITHER accounted for in `tests` (auto-derived or
 * `extraTests`) OR named in `excludeTests`. A file satisfying both signals
 * that is in NEITHER list is exactly the drift #3888 shipped: nobody made a
 * decision about it at all.
 *
 * Pure core (`findDrift`) so tests can drive it against a synthetic COVERED +
 * requiring-files map without touching the real tests/ tree; `main()` wires
 * it to the real repo for `npm run lint:ci`.
 */

const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

/**
 * Pure: for every module in `covered`, every file in `requiringFiles[module]`
 * that ALSO matches the module's naming rule must be present in either
 * `covered[module].tests` (already `tests/`-prefixed, as computeModuleTests
 * emits it) or `covered[module].excludeTests` (bare basenames). Anything
 * matching both signals but present in neither is reported as drift.
 *
 * @param {object} covered - mutation-matrix.cjs's COVERED (post `computeModuleTests`)
 * @param {(moduleName: string) => string[]} findRequiringTestFiles - basenames requiring the module's artifact
 * @param {(moduleName: string, file: string) => boolean} matchesModuleNamingRule
 * @returns {{module: string, file: string}[]}
 */
function findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule) {
  const drift = [];
  for (const [moduleName, entry] of Object.entries(covered)) {
    const testsSet = new Set((entry.tests || []).map((t) => path.basename(t)));
    const excludeSet = new Set(entry.excludeTests || []);
    for (const file of findRequiringTestFiles(moduleName)) {
      if (!matchesModuleNamingRule(moduleName, file)) continue;
      if (testsSet.has(file) || excludeSet.has(file)) continue;
      drift.push({ module: moduleName, file });
    }
  }
  return drift;
}

function main() {
  const {
    COVERED,
    findRequiringTestFiles,
    matchesModuleNamingRule,
  } = require('./mutation-matrix.cjs');

  const drift = findDrift(COVERED, findRequiringTestFiles, matchesModuleNamingRule);

  if (drift.length === 0) {
    console.log(`ok mutation-test-derivation-drift: every module-named test file requiring a covered module has an explicit disposition (${Object.keys(COVERED).length} modules checked)`);
    return;
  }

  console.error('mutation-test-derivation-drift: test file(s) require a covered module and match its naming rule, but have no disposition in scripts/mutation-matrix.cjs (neither auto-derived/extraTests nor excludeTests):');
  for (const d of drift) {
    console.error(`  [${d.module}] tests/${d.file}`);
  }
  console.error('\n  remedy: in scripts/mutation-matrix.cjs, either let it auto-derive (do nothing further if it already appears in COVERED[<module>].tests), or add it to extraTests, or add a REASONED excludeTests entry explaining why it is deliberately withheld from the mutation shard.');
  throw new ExitError(1);
}

module.exports = { findDrift };

if (require.main === module) runMain(main);
