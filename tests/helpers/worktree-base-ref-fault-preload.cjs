'use strict';

/**
 * Preload fixture for #4232 review (Nit 1) — exercise `baseCheckDegrades`'s
 * catch/unbuilt-lib fallback in `gsd-core/bin/gsd-tools.cjs`.
 *
 * `baseCheckDegrades` (#4222) lazily `require`s the compiled
 * `./lib/worktree-base-ref.cjs` and wraps BOTH the require and the call in one
 * `catch { return false }`. Its own doc comment names two producers for that
 * catch — "an unbuilt runtime lib, or any thrown error" — and both land in the
 * SAME block, so either arm pins the same observable contract: no degrade is
 * re-derived, and the resolver records the naturally-resolved host capability
 * exactly as it did before #4222.
 *
 * Neither arm was reachable from a test before this fixture. `baseCheckDegrades`
 * is not on `module.exports`, so it cannot be required and called directly, and
 * the module it loads is a real build artifact the rest of the suite depends on —
 * it cannot simply be deleted.
 *
 * `GSD_TEST_BASEREF_FAULT` selects the arm:
 *
 *   unresolvable — the lazy `require` itself fails: the unbuilt-lib arm.
 *                  Modelled at the module-resolution seam because that is what
 *                  an absent artifact actually does. Worth knowing that this is
 *                  a real partial-build shape rather than a contrivance:
 *                  `ensure-runtime-build.cjs`'s fast path keys on a
 *                  `cli-exit.cjs` SENTINEL, so a tree missing only this one
 *                  artifact is reported "built" and reaches the require.
 *
 *   throws       — the require succeeds and the evaluation throws: the
 *                  any-thrown-error arm. Patched at the export seam, the same
 *                  shape `tests/helpers/shadow-report-throws-preload.cjs`
 *                  already uses, and reached because `baseCheckDegrades`
 *                  destructures the export at call time.
 *
 * Loaded via `NODE_OPTIONS=--require`, so the patch is in place before
 * gsd-tools.cjs reaches its lazy require. One-shot subprocess: no restoration.
 *
 * Deliberately scoped to the one module under test. All three of that module's
 * call sites in gsd-tools.cjs are lazy (inside functions), so the process still
 * starts normally and only the base-check path is affected.
 *
 * Unset/unknown values REFUSE rather than defaulting: a silently inert fault
 * fixture makes the fault test pass for the wrong reason.
 */

const path = require('node:path');
const Module = require('node:module');

const FAULT = process.env.GSD_TEST_BASEREF_FAULT || '';
const TARGET = path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs');

if (FAULT === 'unresolvable') {
  // Matched on the RESOLVED filename, never on the request string. A basename
  // test would also catch any other module that happens to share the name, which
  // would contradict the exact-path scoping this fixture claims two paragraphs up.
  const resolvedTarget = path.resolve(TARGET);
  const load = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null; // unresolvable for a real reason — let the real loader report it
    }
    if (resolved && path.resolve(resolved) === resolvedTarget) {
      const err = new Error(
        `Cannot find module '${request}' ` +
        `(injected by tests/helpers/worktree-base-ref-fault-preload.cjs)`,
      );
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return load.call(this, request, parent, isMain);
  };
} else if (FAULT === 'throws') {
  const mod = require(require.resolve(TARGET));
  mod.evaluateWorktreeBaseDegradeForCwd = function throwingEvaluate() {
    throw new Error(
      'injected by tests/helpers/worktree-base-ref-fault-preload.cjs (#4232 review, catch arm)',
    );
  };
} else {
  throw new Error(
    `worktree-base-ref-fault-preload.cjs: GSD_TEST_BASEREF_FAULT must be ` +
    `'unresolvable' or 'throws', got ${JSON.stringify(FAULT)}`,
  );
}
