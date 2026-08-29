'use strict';

/**
 * tests/helpers/exit-code-artifact-flags.cjs
 *
 * Shared flag-derivation seam for scripts/gen-exit-code-registry.cjs test
 * callers. The generator emits FIVE artifacts (primary, scripts, hooks, dts,
 * sh) driven by `--out`/`--scripts-out`/`--hooks-out`/`--dts-out`/`--sh-out`.
 * Any call that supplies `--out` without also supplying matching overrides
 * for the other four would, under `--write`, clobber the real committed
 * `scripts/lib/exit-code-registry.cjs`, `hooks/lib/exit-code-registry.js`,
 * `src/exit-code-registry.d.cts`, and `gsd-core/bin/shared/exit-codes.sh` —
 * dangerous since test files in this repo run in parallel.
 *
 * `ensureScriptsOut` derives co-located, per-call-unique secondary/hooks/
 * dts/sh paths from whatever `--out` value the caller already supplies,
 * whenever the caller has not already supplied its own override. Calls with
 * no explicit `--out` (the "real committed set" checks) are left untouched.
 *
 * Extracted so every test file that drives this generator's five-artifact
 * flag surface shares ONE derivation — CONTRIBUTING.md's ban on re-deriving
 * a shared flag-builder applies here.
 */

/** @param {string[]} args
 * @returns {string[]}
 */
function ensureScriptsOut(args) {
  const outIdx = args.indexOf('--out');
  if (outIdx === -1) return args;
  const outValue = args[outIdx + 1];
  const extra = [];
  if (!args.includes('--scripts-out')) extra.push('--scripts-out', `${outValue}.secondary.cjs`);
  if (!args.includes('--hooks-out')) extra.push('--hooks-out', `${outValue}.hooks.js`);
  if (!args.includes('--dts-out')) extra.push('--dts-out', `${outValue}.d.cts`);
  if (!args.includes('--sh-out')) extra.push('--sh-out', `${outValue}.sh`);
  return extra.length === 0 ? args : [...args, ...extra];
}

module.exports = { ensureScriptsOut };
