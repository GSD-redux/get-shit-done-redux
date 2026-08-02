'use strict';

/**
 * paths.cjs — the single containment-check source of truth for the QA-walk
 * harness.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Several harness call sites take a scenario-supplied, project-relative path
 * (`step.mutate.target`, `step.agent.write` keys, `LoopWalk#writeArtifact`'s
 * `relPath`) and join it onto a real temp-project directory before touching
 * the filesystem (`fs.writeFileSync` / `fs.unlinkSync` / `fs.symlinkSync`).
 * Without a containment check, a scenario (or a helper copied from one) could
 * supply `"../../../../etc/hosts"` and reach arbitrary paths outside the temp
 * project — this module is the one place that risk is closed.
 *
 * `resolveForCompare` / `realpathNearestAncestor` / `isUnderProjectDir` were
 * originally written in `oracles.cjs` to fix a macOS `/var` vs `/private/var`
 * symlink false positive in the `value-hygiene` oracle's absolute-path-leak
 * check. They are moved here, unchanged, as the single source of truth —
 * `oracles.cjs` now requires them from this module rather than keeping a
 * second copy, which would otherwise be exactly the duplicated-containment-
 * check divergence class this codebase calls out.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Realpath-resolves `candidate` by walking up to its nearest EXISTING ancestor and rejoining
 * the non-existent suffix, rather than requiring the whole path to exist. Plain
 * `fs.realpathSync` throws ENOENT for the *entire* path when any segment is missing, which is
 * exactly the case for QA payloads — `init` returns `project_path` / `roadmap_path` for files
 * the agent has not written yet, nested under a project directory that DOES exist, and
 * `resolveWithin` below is deliberately called BEFORE an artifact exists on disk. Falling back
 * to the fully-unresolved raw string in that case would compare an unresolved `d` against a
 * resolved `projectDir` and reintroduce the same false positive this function exists to fix
 * (verified: `.planning/NOT-YET.md` under an mkdtemp'd macOS `/var/...` dir was flagged as
 * outside a `/private/var/...`-resolved project root). Resolving the nearest existing ancestor
 * and rejoining the missing suffix keeps the comparison correct without requiring the leaf to
 * exist.
 *
 * @param {string} candidate absolute path (may or may not exist on disk)
 * @returns {string} realpath-resolved path, with any non-existent suffix rejoined
 */
function realpathNearestAncestor(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate; // reached a root that itself doesn't exist
    return path.join(realpathNearestAncestor(parent), path.basename(candidate));
  }
}

/**
 * Best-effort realpath resolution for containment comparisons: resolves `candidate` via
 * `realpathNearestAncestor` and backslash-normalizes the result.
 *
 * MACOS SYMLINK CASE (do not "simplify" this back to a lexical compare): on macOS,
 * `os.tmpdir()` / `TMPDIR` resolves to `/var/folders/...`, which is itself a symlink to
 * `/private/var/folders/...`. `fs.mkdtempSync` returns the unresolved `/var/...` form, but
 * `gsd-tools` output paths are realpath-resolved by the OS/child process to the
 * `/private/var/...` form. Comparing those two strings *lexically* makes the very same
 * directory compare as "outside the project" and fires a spurious `value-hygiene` smell on
 * every macOS run — and would make a legitimate `resolveWithin` call throw a false containment
 * violation for the very same reason. Resolving both sides through `fs.realpathSync` before
 * comparison is what fixes that — a lexical `path.relative`/prefix compare on the raw strings
 * will regress it.
 *
 * @param {string} candidate absolute path (may or may not exist on disk)
 * @returns {string} realpath-resolved (nearest-ancestor fallback) path, backslash-normalized
 */
function resolveForCompare(candidate) {
  // Unconditional: backslash-separated path strings can arrive as *data* (e.g. a
  // Windows-style path embedded in JSON) even when running on Linux/macOS, not only when
  // `fs.realpathSync` itself returns a drive-letter path on native Windows.
  return realpathNearestAncestor(candidate).replace(/\\/g, '/');
}

/**
 * True when `resolvedCandidate` is `resolvedProjectDir` itself or a path-segment descendant
 * of it. Both arguments MUST already be realpath-resolved and backslash-normalized via
 * `resolveForCompare` — this function does no I/O itself, so the (syscall-bearing) realpath
 * work happens once per candidate/project-dir string, not repeatedly inside this comparator.
 *
 * Uses `path.posix.relative` structurally (never substring/`.includes()` on the raw string,
 * and never a string-prefix test) so a sibling directory like `/tmp/proj-evil` does NOT count
 * as inside `/tmp/proj`: a relative path that escapes `resolvedProjectDir` either starts with
 * a `..` path segment or is itself still absolute (e.g. a different drive on Windows).
 * `path.posix` (not the platform-specific `path`) is used deliberately because both inputs
 * were already forward-slash-normalized by `resolveForCompare`, and comparisons must stay
 * consistent regardless of the host OS.
 *
 * @param {string} resolvedCandidate realpath-resolved, backslash-normalized absolute path
 * @param {string} resolvedProjectDir realpath-resolved, backslash-normalized absolute project root
 * @returns {boolean}
 */
function isUnderProjectDir(resolvedCandidate, resolvedProjectDir) {
  const rel = path.posix.relative(resolvedProjectDir, resolvedCandidate);
  return rel === '' || (rel.split('/')[0] !== '..' && !path.posix.isAbsolute(rel));
}

/**
 * True when `relPath` is an absolute path — checked both platform-natively via
 * `path.isAbsolute` and, since a path can arrive as *data* with foreign separators
 * regardless of host OS (e.g. a Windows-style path embedded in scenario JSON), via
 * `path.posix.isAbsolute` on the backslash-normalized form and a drive-letter pattern.
 *
 * This is the single source of truth for the "looks absolute" predicate — both
 * `resolveWithin` (below) and `tests/qa/scenario.cjs`'s load-time validation call this
 * rather than each keeping their own copy.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isAbsoluteLike(relPath) {
  const normRel = relPath.replace(/\\/g, '/');
  return path.isAbsolute(relPath) || path.posix.isAbsolute(normRel) || /^[a-zA-Z]:\//.test(normRel);
}

/**
 * True when `relPath` contains a `..` path segment, checked on its backslash-normalized form
 * so a Windows-style separator arriving as data is still caught on a POSIX host.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function hasTraversalSegment(relPath) {
  const normRel = relPath.replace(/\\/g, '/');
  return normRel.split('/').includes('..');
}

/**
 * Builds a typed containment-violation Error for `resolveWithin` to throw: callers that need
 * to distinguish "this relPath escaped its base" from any other Error MUST branch on
 * `err.code === 'EPATHESCAPE'` (and may read `err.attemptedPath` / `err.base`) rather than
 * matching on `err.message` text — see CONTRIBUTING.md "Prohibited: Raw Text Matching on Test
 * Outputs".
 *
 * @param {string} message human-readable message (unchanged shape from before this typed error existed)
 * @param {{attemptedPath: string, base: string}} fields
 * @returns {Error & {code: 'EPATHESCAPE', attemptedPath: string, base: string}}
 */
function pathEscapeError(message, { attemptedPath, base }) {
  const err = new Error(message);
  err.code = 'EPATHESCAPE';
  err.attemptedPath = attemptedPath;
  err.base = base;
  return err;
}

/**
 * The single containment guard for every scenario-supplied, project-relative path this harness
 * turns into a filesystem write/delete/symlink call. Resolves `relPath` against `baseDir` and
 * throws unless the result is provably `baseDir` itself or a path-segment descendant of it.
 *
 * Rejects, before doing any I/O beyond the realpath resolution needed to prove containment:
 *   - a non-string or empty `relPath`
 *   - a `relPath` containing a NUL byte (`\0`) — never a valid path-segment character, and a
 *     known argument-injection primitive against some native path APIs
 *   - an absolute `relPath` (checked both platform-natively via `path.isAbsolute` and, since
 *     scenario JSON travels as data and can carry POSIX- or Windows-style separators on either
 *     host, via `path.posix.isAbsolute` on the backslash-normalized form and a drive-letter
 *     pattern) — an absolute path is never "project-relative" regardless of where it points
 *   - any `relPath` (however constructed, including via `..` segments) that resolves outside
 *     `baseDir` — proven via realpath-resolved, path-segment containment (`isUnderProjectDir`),
 *     never a lexical/string-prefix compare, so a sibling directory like `<baseDir>-evil` is
 *     correctly treated as OUTSIDE `baseDir`
 *
 * The candidate need not exist yet — QA artifacts are routinely written before they exist on
 * disk (see `realpathNearestAncestor`) — so containment is proven against the nearest EXISTING
 * ancestor with the missing suffix rejoined, never a raw lexical join.
 *
 * @param {string} baseDir absolute path to the containing directory (e.g. a temp project root).
 * @param {string} relPath a project-relative path, as supplied by scenario JSON or harness code.
 * @returns {string} the absolute, realpath-resolved path — guaranteed to be `baseDir` or a
 *   descendant of it.
 * @throws {Error} naming both the offending `relPath` and `baseDir` on any violation above.
 */
function resolveWithin(baseDir, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new Error(
      `resolveWithin: relPath must be a non-empty string, got ${JSON.stringify(relPath)} (base=${JSON.stringify(baseDir)})`,
    );
  }
  if (relPath.includes('\0')) {
    throw new Error(
      `resolveWithin: relPath must not contain a NUL byte, got ${JSON.stringify(relPath)} (base=${JSON.stringify(baseDir)})`,
    );
  }

  // Unconditional: a backslash-separated path can arrive as *data* even on a POSIX host (e.g. a
  // Windows-style path embedded in scenario JSON) — see `resolveForCompare`'s header comment for
  // the same rule applied to comparison output.
  const normRel = relPath.replace(/\\/g, '/');

  if (isAbsoluteLike(relPath)) {
    throw pathEscapeError(
      `resolveWithin: relPath must be project-relative, got an absolute path ${JSON.stringify(relPath)} (base=${JSON.stringify(baseDir)})`,
      { attemptedPath: relPath, base: baseDir },
    );
  }

  const resolvedBase = resolveForCompare(baseDir);
  const rawCandidate = path.join(baseDir, normRel);
  const resolvedCandidate = resolveForCompare(rawCandidate);

  if (!isUnderProjectDir(resolvedCandidate, resolvedBase)) {
    throw pathEscapeError(
      `resolveWithin: "${relPath}" escapes base "${baseDir}" `
        + `(resolved candidate "${resolvedCandidate}" is outside resolved base "${resolvedBase}")`,
      { attemptedPath: relPath, base: baseDir },
    );
  }

  return resolvedCandidate;
}

module.exports = {
  resolveWithin,
  resolveForCompare,
  realpathNearestAncestor,
  isUnderProjectDir,
  isAbsoluteLike,
  hasTraversalSegment,
};
