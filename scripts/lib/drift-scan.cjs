#!/usr/bin/env node
'use strict';

/**
 * Shared anti-divergence scanner machinery (epic #3180, ADR-3180 Decision 4).
 *
 * Extracted from `scripts/lint-plan-count-drift.cjs` (#3183) so that
 * `scripts/lint-milestone-window-drift.cjs` (#3184) and any future
 * `scripts/lint-<derivation>-drift.cjs` guard consume ONE tree-walk /
 * root-confinement / literal-tokenizer / sanitizer implementation instead of
 * each copying it verbatim — the exact generative-fix-divergence class this
 * epic exists to remove, now applied to the guards themselves (see
 * `.gsd/phase/refactor-3184-milestone-window-single-owner/40-design.md`,
 * "Rejected: let the new drift guard copy Phase 1's tree-walk /
 * root-confinement / sanitizer").
 *
 * `lint-plan-count-drift.cjs` re-exports every symbol it exported before this
 * extraction (`readRegexLiteralAt`, `MAX_REGEX_LITERAL_LEN`, `isInsideRoot`,
 * `sanitizeForReport`), so `tests/plan-count-single-owner.test.cjs` — the
 * ReDoS and root-confinement regression net for this exact machinery —
 * continues to pass unchanged and is the regression net for this move too.
 */

const fs = require('node:fs');
const path = require('node:path');

// Longest regex literal this scanner will consider, in characters. Real
// plan/summary filename filters (and milestone-window regex literals) are far
// shorter; the bound is what keeps the scan linear. The tokenizer restarts at
// every `/` on the line (so that a literal preceded by a stray unpaired `/`
// is still found, matching the previous regex's "find anywhere" behaviour),
// which without a per-literal bound would be quadratic on a pathological
// line. With it the whole-line cost is O(n * MAX_REGEX_LITERAL_LEN) with no
// backtracking at all.
const MAX_REGEX_LITERAL_LEN = 400;

// Directory names this scanner never descends into or reports out of —
// `.git` (repo internals, e.g. a persisted CI token in `.git/config`),
// `node_modules` (thousands of third-party files, none of them authored
// source), `dist` (build output). Named once and used at BOTH skip sites
// below: the cheap `entry.name` fast path in `walk`, and the resolved-path
// component check in `isUnderSkippedDir` — a symlink whose OWN name is not
// in this set but whose target resolves through a directory that IS (e.g.
// `src/g -> ../.git`, `src/nm -> ../node_modules`) must still be skipped, or
// the name-only check is a trivial bypass.
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

/**
 * Read the JS regex literal starting at `line[start]` (which must be `/`).
 * Returns `{ text, end }` — `text` includes the delimiters and any trailing
 * flags, `end` is the index one past the literal — or null if no literal
 * closes within MAX_REGEX_LITERAL_LEN characters.
 *
 * Single left-to-right pass, no backtracking. It models the two constructs a
 * backtracking pattern gets wrong, which is why this is a tokenizer and not a
 * regex:
 *   - `\x` escapes consume BOTH characters, so an escaped `\/` never
 *     terminates the literal;
 *   - inside a `[...]` character class a bare `/` does NOT terminate, so
 *     `/PLAN[\\/].*\.md$/` is one literal rather than two fragments. The
 *     previous regex silently MISSED every re-derivation using a
 *     cross-platform path-separator class for exactly this reason.
 */
// Deterministic regression seam for the MAJOR-2 bound (issue #3951/#3987): a
// counter of how many characters this tokenizer has actually examined, so a
// test can assert the bound HOLDS (total work stays a small linear multiple
// of the number of scan attempts × MAX_REGEX_LITERAL_LEN) without resorting
// to a wall-clock elapsed-time assertion, which this repo's test rules ban
// ("Clock Seams: Do not assert on wall-clock time.") and which is exactly
// what flaked on a slow shared CI runner. `resetRegexScanStats`/
// `getRegexScanStats` are read-modify-reset around a single scan under test;
// they are process-global and NOT safe under concurrent scans, which is fine
// for this synchronous, single-threaded CLI tool and its tests.
let regexScanStats = { calls: 0, charsExamined: 0 };

function resetRegexScanStats() {
  regexScanStats = { calls: 0, charsExamined: 0 };
}

function getRegexScanStats() {
  return { ...regexScanStats };
}

function readRegexLiteralAt(line, start) {
  if (line[start] !== '/') return null;
  regexScanStats.calls++;
  const limit = Math.min(line.length, start + MAX_REGEX_LITERAL_LEN);
  let inClass = false;
  let i = start + 1;
  for (; i < limit; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // escape consumes the next character, whatever it is
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // a literal cannot span lines
      regexScanStats.charsExamined += i - start;
      return null;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      // Trailing flags are bounded by the SAME `limit` as the literal body
      // itself (not `line.length`) — a literal followed by an unbounded run
      // of lowercase letters must not make `text` grow past
      // MAX_REGEX_LITERAL_LEN either.
      let end = i + 1;
      while (end < limit && line[end] >= 'a' && line[end] <= 'z') end++;
      regexScanStats.charsExamined += end - start;
      return { text: line.slice(start, end), end };
    }
  }
  regexScanStats.charsExamined += limit - start;
  return null;
}

// Symlinks report `isDirectory()`/`isFile()` as false on the Dirent from
// `readdirSync`, so a symlinked `.cts` (or a symlinked directory containing
// one) was previously invisible to this scanner — an evasion of a guard
// whose stated design principle (ADR-3180 Decision 4a) is whole-repo
// discovery with no allowlist. Resolve each entry with `fs.statSync` (which
// follows symlinks) to classify it, skipping broken links. `ctx.visitedRealDirs`
// guards against a symlink cycle sending `walk` into infinite recursion.
//
// Every sibling drift guard in `scripts/` that does NOT import this module
// (`lint-phase-id-drift.cjs`, `lint-package-identity-drift.cjs`,
// `lint-portable-timeout.cjs`, `lint-test-file-count.cjs`,
// `lint-allow-test-rule-refs.cjs`) uses the `Dirent` classification straight
// off `readdirSync` and does NOT follow symlinks at all. This scanner follows
// them so a symlinked source file cannot evade ADR-3180 Decision 4a's
// whole-repo discovery — root confinement (`isInsideRoot` below) is the price
// of doing so: without it, a symlink planted anywhere under a scan directory
// could walk this scanner out to read and report arbitrary files elsewhere on
// disk.
//
// DIRECTORY vs FILE symlinks are confined to two DIFFERENT roots, tracked as
// `ctx.scanDirRoot` (the realpath of the current top-level scan-dir entry,
// e.g. `<realRoot>/src`) vs `ctx.realRoot` (the whole repo):
//   - a DIRECTORY symlink is descended ONLY if its resolved realpath is
//     inside `ctx.scanDirRoot` — NOT merely inside `ctx.realRoot`. Without
//     this, `src/up -> ..` (or `-> <realRoot>`) resolves inside the repo
//     root and `walk` descends the ENTIRE repo, reporting violations under
//     paths like `tests/not-src.cts` or `docs/other.cts` — files the caller's
//     scan-dir list scopes it OUT of. This is a deliberate, fail-CLOSED
//     trade-off: a directory symlink pointing elsewhere INSIDE the repo (but
//     outside the scan directory) is simply not followed. The alternative —
//     descending it — is exactly the whole-repo sweep this rule exists to
//     prevent, and a fork PR could use that sweep to redden `lint:ci` on
//     files this guard was never meant to read. The narrower rule is worth
//     more than the missed edge case.
//   - a FILE symlink is still scanned if its resolved realpath is inside
//     `ctx.realRoot` (the whole repo, not just the scan directory) — this is
//     what keeps `src/alias.cts -> vendor/real.cts` covered (test (f)): an
//     aliased file genuinely is part of the compiled surface even when its
//     real target lives outside `src/`, and it is still reported under its
//     canonical (real) path.
//
// A resolved path is inside a root only if it IS that root or begins with
// root + separator — a plain `startsWith(root)` would also accept a sibling
// directory whose name merely starts with the root's name (`/repo-evil`).
function isInsideRoot(realPath, realRoot) {
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
}

// True when `realPath` (already confirmed inside `realRoot` by `isInsideRoot`)
// resolves THROUGH a skip-list directory anywhere along its path relative to
// the root — not just when `realPath` itself IS one. This is what closes the
// symlink bypass the `entry.name` fast path alone cannot: `walk` tests
// `entry.name` (the symlink's OWN name in its parent directory), but a
// symlink named something innocuous can still RESOLVE into `.git` /
// `node_modules` / `dist` (`src/g -> ../.git`, `src/leak.cts ->
// ../.git/config`, `src/nm -> ../node_modules`) — `isInsideRoot` alone admits
// all three, because every one of those real paths is still under the root.
function isUnderSkippedDir(realPath, realRoot) {
  const rel = path.relative(realRoot, realPath);
  return rel.split(path.sep).some((segment) => SKIP_DIR_NAMES.has(segment));
}

// `ctx.scanExt` is a `Set` of file extensions (e.g. `.cts`/`.ts`/`.mts`) the
// caller wants reported — threaded through `ctx` rather than as a positional
// parameter so recursive `walk(full, acc, ctx)` calls stay unchanged.
function walk(dir, acc, ctx) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIR_NAMES.has(entry.name)) continue; // cheap fast path
    let stat;
    try {
      stat = entry.isSymbolicLink() ? fs.statSync(full) : entry;
    } catch {
      continue; // broken symlink target
    }
    let realPath;
    try {
      realPath = fs.realpathSync(full);
    } catch {
      continue; // broken symlink target (race, or a link stat() followed but realpath cannot)
    }
    if (stat.isDirectory()) {
      // Directories (symlinked or real) are confined to the CURRENT scan
      // directory root, not merely the repo root — see the comment above
      // `isInsideRoot` for why (`src/up -> ..` whole-repo sweep).
      if (!isInsideRoot(realPath, ctx.scanDirRoot)) continue;
      if (isUnderSkippedDir(realPath, ctx.realRoot)) continue; // symlink resolves through a skipped dir
      if (ctx.visitedRealDirs.has(realPath)) continue; // symlink cycle guard
      ctx.visitedRealDirs.add(realPath);
      walk(full, acc, ctx);
    } else if (stat.isFile() && ctx.scanExt.has(path.extname(entry.name))) {
      // Files are confined to the whole repo root — a symlinked FILE whose
      // real target lives outside the scan directory but inside the repo
      // (e.g. `src/alias.cts -> vendor/real.cts`) is still part of the
      // compiled surface and must be scanned.
      if (!isInsideRoot(realPath, ctx.realRoot)) continue;
      if (isUnderSkippedDir(realPath, ctx.realRoot)) continue; // symlink resolves through a skipped dir
      if (ctx.visitedRealFiles.has(realPath)) continue; // two symlinks, same real file
      ctx.visitedRealFiles.add(realPath);
      acc.push(realPath);
    }
  }
  return acc;
}

/**
 * Whole-repo tree-walk driver shared by every `lint-<derivation>-drift.cjs`
 * guard. Resolves `root`, walks each of `scanDirs` filtered to `scanExt`
 * (symlink-following, root-confined, cycle-guarded — see `walk` above), reads
 * each discovered file, and calls `onFile(relPath, text)` for it — `relPath`
 * is repo-relative and already the file's canonical (real) path, so a
 * per-file exemption keyed on `relPath` matches consistently regardless of
 * which symlink reached it.
 *
 * `onFile` returns an array of violation objects (or an empty array / null /
 * undefined for "no violations in this file"); `scanTree` flattens them all
 * into one returned array. Pure I/O orchestration — detection logic lives
 * entirely in the caller's `onFile`.
 */
function scanTree({ root, scanDirs, scanExt, onFile }) {
  const violations = [];
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return violations; // root itself does not exist / is unreadable
  }
  for (const dir of scanDirs) {
    const scanDirPath = path.join(root, dir);
    let scanDirRoot;
    try {
      scanDirRoot = fs.realpathSync(scanDirPath);
    } catch {
      continue; // scan directory itself does not exist / is unreadable
    }
    const ctx = { realRoot, scanDirRoot, scanExt, visitedRealDirs: new Set(), visitedRealFiles: new Set() };
    for (const file of walk(scanDirPath, [], ctx)) {
      const rel = path.relative(realRoot, file);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const found = onFile(rel, text);
      if (found && found.length > 0) violations.push(...found);
    }
  }
  return violations;
}

// A reported fragment AND a reported file path are both attacker-controlled
// source text on a fork PR (a repo can legally track a filename containing
// control bytes, so the path is exactly as attacker-controlled as the
// fragment), and both are written straight to a CI log. Replace C0/C1
// control bytes (ANSI escapes included) with a visible \xNN, AND the
// non-Latin-1 formatting/bidi/line-separator codepoints below with \uNNNN, so
// a crafted literal or filename cannot rewrite the terminal rendering of the
// report or hide/reorder its own text:
//   - U+200B-U+200F: zero-width space/joiners and directional marks
//   - U+2028/U+2029: Unicode LINE SEPARATOR / PARAGRAPH SEPARATOR (line
//     breaks a `\n`-only log scan would not catch)
//   - U+202A-U+202E: bidi embedding/override controls (RLO etc.)
//   - U+2066-U+2069: bidi isolate controls
function sanitizeForReport(text) {
  return text
    // eslint-disable-next-line no-control-regex -- the control range IS the target
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = {
  SKIP_DIR_NAMES,
  isInsideRoot,
  isUnderSkippedDir,
  walk,
  readRegexLiteralAt,
  MAX_REGEX_LITERAL_LEN,
  sanitizeForReport,
  scanTree,
  resetRegexScanStats,
  getRegexScanStats,
};
