#!/usr/bin/env node
'use strict';

/**
 * lint-eslint-glob-coverage.cjs — ESLint `files:` glob coverage drift guard (#3059).
 *
 * ## What this enforces
 *
 * `eslint.config.mjs` is a flat config: a tracked source file is only linted
 * if it matches at least one config object's `files:` glob (or a global,
 * files-less block). A file matching NO glob resolves to zero reachable
 * rules and `eslint .` silently exits 0 on it — the #3059 defect class (62
 * tracked source files found with this shape). This guard walks every
 * tracked `.cjs/.cts/.js/.mjs` source file, resolves its real ESLint config,
 * and fails when a file resolves to zero rules and isn't a deliberately
 * exempted, reasoned allowlist entry.
 *
 * This checks rule REACHABILITY (does at least one rule apply to this file
 * at all, any severity), not rule SEVERITY (whether an applicable rule is
 * `error` vs `warn` vs `off`) — severity coverage is a separate gate, #1885
 * F17. A file with one `off` rule reachable still counts as "covered" here:
 * it proves the file was deliberately targeted by a `files:` glob, which is
 * the thing #3059 is about.
 *
 * ## Goodhart rationale
 *
 * A coverage metric is trivially gameable by padding the allowlist instead
 * of fixing the glob, so every knob here is built to resist that:
 *   - Every allowlist entry MUST carry a non-empty `reason` — an unreasoned
 *     entry is indistinguishable from "quietly made the metric look better".
 *   - The allowlist only ratchets DOWN: an entry whose path now resolves to
 *     >=1 rule (`allowlist_stale`) is a failure, forcing prompt removal
 *     rather than letting stale exemptions accumulate as free cover for
 *     future accidental escapes at the same path.
 *   - A tracked-file-count floor (`tracked_count_below_floor`) exists so a
 *     broken or empty `git ls-files` (e.g. wrong cwd, detached worktree)
 *     can't report a vacuous "0 escapes out of 0 checked" clean run.
 *
 * ## Ignored vs. unmatched (the discrimination this script makes)
 *
 * ESLint's `ignores:` blocks are the one legitimate "this file is not meant
 * to be linted" decision (e.g. the ADR-457 tsc-emitted `.cjs` artifacts
 * under `gsd-core/bin/lib/`) and must NOT be reported as uncovered. But
 * `ESLint#isPathIgnored` cannot be trusted uniformly across extensions:
 * for ESLint's default-lintable extensions (`.js`/`.mjs`/`.cjs`), it
 * reports `true` only when the path matches an explicit `ignores:` glob —
 * verified empirically: an unmatched top-level `.cjs` probe file reports
 * `isPathIgnored() === false` with an empty resolved rule set, not `true`.
 * For `.cts` (and any other non-default extension), flat config requires an
 * EXPLICIT `files:` glob match to be linted at all; a `.cts` file matching
 * no `files:` glob ALSO reports `isPathIgnored() === true` — indistinguishable,
 * via this API, from a genuine `ignores:` entry (verified with a scratch
 * `.cts` fixture under `tests/fixtures/`). This repo's `ignores:` list never
 * contains a `.cts` path (ADR-457 retires only the emitted `.cjs`; the
 * `.cts` source is always meant to stay linted), so for `.cts` specifically
 * an `isPathIgnored() === true` verdict can only mean "matches no `files:`
 * glob" and is therefore treated as UNCOVERED, not ignored. See
 * `resolveFileCoverage` below.
 *
 * ## Why `bin/install.js` is NOT in the allowlist
 *
 * The allowlist below is exclusively for files that resolve to ZERO rules —
 * it is a registry of accepted escapes, not a general-purpose "reasons for
 * how a file is configured" log. The `bin/install.js` / `bin/gsd-mcp-server.js`
 * / `scripts/build-hooks.js` family is deliberately covered by a minimal,
 * 2-rule block in `eslint.config.mjs` per ADR-1703 (targeting only the
 * portability defect surface, not a full style sweep of ~12k lines of
 * generated code) — see the comment at that block in `eslint.config.mjs`.
 * Because 2 rules is non-empty, that family already passes this guard
 * without needing an allowlist entry, and adding one anyway would itself be
 * flagged `allowlist_stale` (see the ratchet above). The allowlist exemption
 * surface deliberately cannot be used to re-state a decision that is already
 * recorded in the config; #3059 is the guard, ADR-1703 is the decision.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'lint-eslint-glob-coverage.allowlist.json');

const SOURCE_EXT_RE = /\.(cjs|cts|js|mjs)$/;

// ESLint's flat-config default-lintable extensions: a file with one of these
// extensions that matches no `files:` glob still reports `isPathIgnored()
// === false` (with an empty resolved rule set) — so for these extensions,
// `isPathIgnored() === true` reliably means an explicit `ignores:` match.
const DEFAULT_LINTABLE_EXT_RE = /\.(js|mjs|cjs)$/;

const MIN_TRACKED_SOURCE_FILES = 500;

/**
 * Runs `git ls-files` and returns the tracked source files (repo-relative,
 * POSIX-normalized, filtered to SOURCE_EXT_RE). Never throws: a git failure
 * (non-zero exit or timeout) produces a degraded `{ ok: false }` result so
 * callers can turn it into a `git_failed` violation instead of crashing.
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFile] - injectable sync exec function with the
 *   `execFileSync(cmd, args, options)` signature; defaults to
 *   `child_process.execFileSync`.
 */
function listTrackedSourceFiles({ execFile } = {}) {
  const run = execFile || require('child_process').execFileSync;
  let stdout;
  try {
    // The test runner and CI execute inside a container where this repo is
    // owned by a different UID than the running user; bare `git ls-files`
    // then refuses with "detected dubious ownership" unless the path is in
    // `safe.directory`, and this guard degrades to a `git_failed` violation
    // — exactly where it must run to be a useful gate (#3059). `-c
    // safe.directory=*` scopes the override to THIS invocation only (it
    // never writes to any config file, global or local), and the wildcard
    // is fine here because this command only ever enumerates tracked paths
    // in the repo the guard is already executing inside.
    stdout = run('git', ['-c', 'safe.directory=*', 'ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
      // 30s — `git ls-files` on this tree returns ~1175 paths in <1s; 30s is
      // the CLAUDE.md git ceiling, generous for a cold index.
      timeout: 30000,
    });
  } catch (err) {
    return { ok: false, files: [], error: (err && err.message) || String(err) };
  }

  const files = String(stdout)
    // CRLF-safe: `git ls-files` output may carry \r\n on a Windows checkout
    // or a git config with core.autocrlf set (DEFECT.CRLF class).
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    // Unconditional backslash normalization (never path.sep-gated): the
    // guard's own process may run on any platform regardless of what
    // produced the tracked-file listing.
    .map((line) => line.replace(/\\/g, '/'))
    .filter((line) => SOURCE_EXT_RE.test(line));

  return { ok: true, files };
}

/** Loads and parses the allowlist JSON file. */
function loadAllowlist() {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Resolves the ESLint coverage verdict for a single tracked file. See the
 * "Ignored vs. unmatched" header section for the extension-dependent
 * discrimination rationale.
 *
 * @param {import('eslint').ESLint} eslint
 * @param {string} relPath - repo-relative POSIX path
 * @returns {Promise<{ ignored: boolean, ruleCount: number }>}
 */
async function resolveFileCoverage(eslint, relPath) {
  const absPath = path.join(ROOT, relPath);
  const ignored = await eslint.isPathIgnored(absPath);

  if (ignored) {
    if (DEFAULT_LINTABLE_EXT_RE.test(relPath)) {
      // .js/.mjs/.cjs: isPathIgnored() only reports true for an explicit
      // `ignores:` glob match — a recorded decision.
      return { ignored: true, ruleCount: 0 };
    }
    // .cts (or any non-default extension): isPathIgnored() can't
    // distinguish "explicit ignores: match" from "no files: glob matched
    // it at all" — and this repo's ignores: list never targets .cts, so
    // treat it as the latter (uncovered), never as ignored.
    return { ignored: false, ruleCount: 0 };
  }

  const config = await eslint.calculateConfigForFile(absPath);
  const ruleCount = config && config.rules ? Object.keys(config.rules).length : 0;
  return { ignored: false, ruleCount };
}

/** Builds the default real-ESLint-backed resolveConfig function. */
function createDefaultResolveConfig() {
  const { ESLint } = require('eslint');
  const eslint = new ESLint({ cwd: ROOT });
  return (relPath) => resolveFileCoverage(eslint, relPath);
}

/**
 * The pure coverage predicate. All I/O is injectable via `deps` so tests
 * never need a temp repo, a real subprocess, or a real ESLint instance:
 *
 * @param {object} [deps]
 * @param {string[] | { ok: boolean, files?: string[], error?: string }} [deps.trackedFiles]
 *   Either a plain array of tracked source paths (success shorthand), or a
 *   `listTrackedSourceFiles()`-shaped result object (so a git failure can be
 *   injected directly). Defaults to a real `listTrackedSourceFiles()` call.
 * @param {(relPath: string) => Promise<{ignored:boolean,ruleCount:number}> | {ignored:boolean,ruleCount:number}} [deps.resolveConfig]
 *   Per-file coverage resolver. Defaults to a real ESLint instance.
 * @param {Array<{path:string,reason?:string}>} [deps.allowlist] - defaults to
 *   the real `loadAllowlist()`.
 * @param {number} [deps.minTrackedFiles] - defaults to MIN_TRACKED_SOURCE_FILES.
 * @returns {Promise<{ ok: boolean, escapes: Array<{path:string}>, violations: Array<{kind:string,path:string|null,detail:string}>, checked: number }>}
 */
async function checkGlobCoverage(deps = {}) {
  const minTrackedFiles =
    typeof deps.minTrackedFiles === 'number' ? deps.minTrackedFiles : MIN_TRACKED_SOURCE_FILES;

  const violations = [];

  let trackedResult;
  if (deps.trackedFiles === undefined) {
    trackedResult = listTrackedSourceFiles();
  } else if (Array.isArray(deps.trackedFiles)) {
    trackedResult = { ok: true, files: deps.trackedFiles };
  } else {
    trackedResult = deps.trackedFiles;
  }

  if (!trackedResult.ok) {
    violations.push({
      kind: 'git_failed',
      path: null,
      detail: trackedResult.error || 'listTrackedSourceFiles() failed',
    });
    return { ok: false, escapes: [], violations, checked: 0 };
  }

  const trackedFiles = trackedResult.files;

  if (trackedFiles.length < minTrackedFiles) {
    violations.push({
      kind: 'tracked_count_below_floor',
      path: null,
      detail: `tracked source file count ${trackedFiles.length} is below the floor of ${minTrackedFiles} — a broken or empty git ls-files must never report a vacuous clean run`,
    });
  }

  const trackedSet = new Set(trackedFiles);
  const allowlist = deps.allowlist === undefined ? loadAllowlist() : deps.allowlist;

  const seenAllowlistPaths = new Set();
  const allowlistPathSet = new Set();
  for (const entry of allowlist) {
    const entryPath = entry && entry.path;

    if (seenAllowlistPaths.has(entryPath)) {
      violations.push({
        kind: 'allowlist_duplicate',
        path: entryPath,
        detail: 'path appears more than once in the allowlist',
      });
    } else {
      seenAllowlistPaths.add(entryPath);
    }
    allowlistPathSet.add(entryPath);

    if (!Object.prototype.hasOwnProperty.call(entry, 'reason')) {
      violations.push({
        kind: 'allowlist_missing_reason',
        path: entryPath,
        detail: 'allowlist entry is missing a "reason" key',
      });
    } else if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      violations.push({
        kind: 'allowlist_empty_reason',
        path: entryPath,
        detail: 'allowlist entry "reason" is empty or whitespace-only',
      });
    }

    if (!trackedSet.has(entryPath)) {
      violations.push({
        kind: 'allowlist_missing_path',
        path: entryPath,
        detail: 'allowlisted path is not a tracked source file',
      });
    }
  }

  const resolveConfig = deps.resolveConfig || createDefaultResolveConfig();

  const escapes = [];
  let checked = 0;

  for (const file of trackedFiles) {
    checked += 1;
    const result = await resolveConfig(file);
    const isAllowlisted = allowlistPathSet.has(file);

    if (result.ignored) {
      // A recorded ESLint `ignores:` decision — never an escape, regardless
      // of allowlist membership.
      continue;
    }

    if (result.ruleCount === 0) {
      if (isAllowlisted) continue;
      escapes.push({ path: file });
      violations.push({
        kind: 'uncovered',
        path: file,
        detail: 'resolves to 0 reachable ESLint rules and is not allowlisted',
      });
    } else if (isAllowlisted) {
      violations.push({
        kind: 'allowlist_stale',
        path: file,
        detail: 'allowlisted path now resolves to >=1 ESLint rule — prune the entry, the allowlist only ratchets down',
      });
    }
  }

  return { ok: violations.length === 0, escapes, violations, checked };
}

if (require.main === module) {
  checkGlobCoverage()
    .then((result) => {
      if (result.violations.length > 0) {
        console.error(
          `lint-eslint-glob-coverage: ${result.violations.length} violation(s) across ${result.checked} tracked source file(s) (${result.escapes.length} uncovered escape(s))`
        );
        for (const v of result.violations) {
          console.error(`  [${v.kind}] ${v.path === null ? '(n/a)' : v.path}${v.detail ? ' — ' + v.detail : ''}`);
        }
        process.exitCode = 1;
      } else {
        console.log(`ok lint-eslint-glob-coverage: ${result.checked} tracked source file(s), 0 escapes`);
      }
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exitCode = 1;
    });
}

module.exports = {
  checkGlobCoverage,
  listTrackedSourceFiles,
  loadAllowlist,
  SOURCE_EXT_RE,
  MIN_TRACKED_SOURCE_FILES,
};
