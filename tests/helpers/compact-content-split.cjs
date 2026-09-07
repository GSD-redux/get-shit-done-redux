'use strict';

/**
 * Shared library for the compact-content partition guard (ADR-4139 Decision 5,
 * epic #4139, Phase 3 #4403). See `docs/PARTITION-RULES.md` for the operational
 * spec this module implements — it is the source of truth for behavior; this
 * file is the mechanics.
 *
 * A "registered split" is any `gsd-core/workflows/<name>/detail/*.md` path
 * paired with the spine at `gsd-core/workflows/<name>.md`. There is no
 * separate registry — a pair is registered by existing on disk
 * (`discoverRegisteredSplits`). Everything else here is one of the five
 * checks PARTITION-RULES.md describes, or a primitive those checks share:
 *
 *   1. Completeness  — NOT implemented here (fires once, at split time, and
 *      needs the merge-base spine content the way the pilot test already
 *      reads it; `normalizeNonTrivialLines` is the shared primitive it needs).
 *   2. Disjointness  — `checkDisjointness`.
 *   3. Registration  — `checkRegistration`.
 *   4. Protected content — `extractProtectedBlocks` extracts the sentinel-
 *      wrapped spans; the guard test compares their presence itself.
 *   5. Boundary moves — `readBoundaryMoveTrailers`.
 *
 * `checkDetailFileSizeCap` is the pilot's size-cap assertion, generalized.
 *
 * This module only reads (filesystem + `git log`/`git merge-base`, both
 * read-only). No writes, no network.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  REPO_ROOT,
  GIT_TIMEOUT_MS,
  safeDirArgs,
} = require('./emitted-runtime.cjs');
const { NEW_FILE_CAP, ACK_TRAILER_DELIM, normalizeAckReason } = require('./emitted-diff.cjs');
const { runGit, OUTCOME } = require('./process-seam.cjs');

/** Default scan root: `gsd-core/workflows/` at repo root. */
const DEFAULT_WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'gsd-core', 'workflows');

/**
 * Discover every registered spine/detail split under `workflowsDir`.
 *
 * A split is registered by a `<workflowsDir>/<name>/detail/` DIRECTORY (never
 * a `<name>/detail.md` FILE — only an actual `detail/` subdirectory counts)
 * containing at least one `*.md` file, where `<name>` is exactly ONE path
 * segment directly under `workflowsDir` — a `detail/` dir nested two or more
 * segments deep (e.g. `<name>/sub/detail/`) is walked (so its own children
 * are still found) but is never itself registered, per PARTITION-RULES.md's
 * "no nested split names" contract.
 *
 * Pure enumeration: a missing spine is reported here as `spineExists: false`,
 * never thrown — deciding that's a failure is check 3's (registration) job,
 * not discovery's.
 *
 * @param {string} [workflowsDir]
 * @returns {Array<{name: string, spinePath: string, detailPaths: string[], spineExists: boolean}>}
 */
function discoverRegisteredSplits(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  const found = new Map(); // name -> split record, first registration wins

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to discover under it
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);

      if (entry.name === 'detail') {
        let mdFiles = [];
        try {
          mdFiles = fs.readdirSync(full, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => e.name);
        } catch {
          mdFiles = [];
        }
        if (mdFiles.length > 0) {
          // `dir` is detail/'s PARENT — the segment(s) between workflowsDir
          // and dir are the candidate `<name>`. Only a single segment counts.
          const segments = path.relative(workflowsDir, dir).split(path.sep).filter(Boolean);
          if (segments.length === 1) {
            const name = segments[0];
            if (!found.has(name)) {
              const spinePath = path.join(workflowsDir, `${name}.md`);
              const detailPaths = mdFiles.map((f) => path.join(full, f)).sort();
              found.set(name, { name, spinePath, detailPaths, spineExists: fs.existsSync(spinePath) });
            }
          }
        }
      }

      walk(full);
    }
  }

  walk(workflowsDir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * "Trivial" lines (fences, `---` rules, bare headings, bare `Label:` lines)
 * are boilerplate that legitimately repeats throughout any markdown file with
 * code blocks — excluding them from the completeness/disjointness checks is
 * what keeps those checks from flaring on structure rather than content.
 * Ported verbatim from the pilot's `tests/plan-phase-compact-split.test.cjs`,
 * which this module supersedes as Phase 3's generalized version of the same
 * check.
 */
function isTrivial(line) {
  if (/^`{3,}/.test(line)) return true;
  if (/^-{3,}$/.test(line)) return true;
  if (/^#+\s*$/.test(line)) return true;
  if (/^[A-Za-z][A-Za-z ]*:$/.test(line)) return true; // bare label lines like "Options:"
  return false;
}

/**
 * Normalize file content into the comparable unit the completeness and
 * disjointness checks both operate on: trimmed, non-empty, non-trivial
 * lines, in order, duplicates preserved (callers choose Set vs array
 * depending whether they need membership or a count).
 *
 * @param {string} content
 * @returns {string[]}
 */
function normalizeNonTrivialLines(content) {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isTrivial(l));
}

/**
 * Is `line` the canonical `gsd_run` launcher bootstrap preamble (see
 * `gsd-core/workflows/_runtime-launcher.snippet.sh`,
 * `tests/runtime-launcher-parity.test.cjs`)?
 *
 * That other guard's OWN contract mandates exactly one inlined copy in every
 * workflow/detail file that calls `gsd_run` — spine and detail both call it,
 * so both legitimately carry their own copy. That is sanctioned
 * cross-file duplication, not something the disjointness check should ever
 * flag, so it is filtered out wherever this module compares lines across a
 * spine/detail pair.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isCanonicalLauncherPreamble(line) {
  return line.startsWith('_GSD_SHIM_NAME="gsd-tools.cjs";');
}

const PROTECTED_START = '<!-- gsd:protected:start -->';
const PROTECTED_END = '<!-- gsd:protected:end -->';
const PROTECTED_SINGLE = '<!-- gsd:protected -->';

/**
 * Extract every `<!-- gsd:protected -->` (single-line) and
 * `<!-- gsd:protected:start -->`/`<!-- gsd:protected:end -->` (paired)
 * sentinel-wrapped block from `content`.
 *
 * Never throws on a malformed sentinel (unclosed start, orphan end, a single
 * marker with no following content, a paired block enclosing nothing) —
 * those are reported best-effort in `blocks` (covering whatever content is
 * actually present, or an empty span) AND named explicitly in `malformed`,
 * mirroring the well-formedness rules `tests/plan-phase-compact-split.test.cjs`'s
 * `'every gsd:protected sentinel...'` test already enforced for the one
 * existing split. The check-4 caller decides what to do with a malformed
 * sentinel; this function's job is only to describe the file accurately.
 *
 * Single-marker coverage: from the marker line, skip blank lines, then
 * collect (trimmed) lines until a blank line, another sentinel line, or EOF.
 * Paired coverage: every non-blank (trimmed) line strictly between the start
 * and end sentinel lines.
 *
 * @param {string} content
 * @returns {{
 *   blocks: Array<{kind: 'single'|'paired', lines: string[], firstLine: string}>,
 *   malformed: Array<{line: number, message: string}>,
 * }}
 */
function extractProtectedBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  const malformed = [];
  const singleMarkerLines = [];
  let openStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === PROTECTED_START) {
      if (openStart !== -1) {
        // A new start while one is already open: the earlier open span is
        // abandoned (best-effort — it never gets a `blocks` entry) and this
        // one becomes the tracked open start.
        malformed.push({ line: i + 1, message: `nested/unclosed gsd:protected:start at line ${i + 1}` });
      }
      openStart = i;
    } else if (trimmed === PROTECTED_END) {
      if (openStart === -1) {
        malformed.push({ line: i + 1, message: `gsd:protected:end with no matching start at line ${i + 1}` });
        continue;
      }
      const covered = lines.slice(openStart + 1, i).map((l) => l.trim()).filter((l) => l.length > 0);
      if (covered.length === 0) {
        malformed.push({
          line: openStart + 1,
          message: `protected block at lines ${openStart + 1}-${i + 1} encloses no content`,
        });
      }
      blocks.push({ kind: 'paired', lines: covered, firstLine: covered[0] || '' });
      openStart = -1;
    } else if (trimmed === PROTECTED_SINGLE) {
      singleMarkerLines.push(i);
    }
  }

  if (openStart !== -1) {
    malformed.push({ line: openStart + 1, message: 'a gsd:protected:start sentinel was never closed' });
    const covered = lines.slice(openStart + 1).map((l) => l.trim()).filter((l) => l.length > 0);
    blocks.push({ kind: 'paired', lines: covered, firstLine: covered[0] || '' });
  }

  for (const idx of singleMarkerLines) {
    let j = idx + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length || lines[j].trim().length === 0) {
      malformed.push({ line: idx + 1, message: `single protected marker at line ${idx + 1} has no following content` });
      blocks.push({ kind: 'single', lines: [], firstLine: '' });
      continue;
    }
    const covered = [];
    for (let k = j; k < lines.length; k++) {
      const trimmed = lines[k].trim();
      if (trimmed === '' || trimmed === PROTECTED_START || trimmed === PROTECTED_END || trimmed === PROTECTED_SINGLE) break;
      covered.push(trimmed);
    }
    blocks.push({ kind: 'single', lines: covered, firstLine: covered[0] || '' });
  }

  return { blocks, malformed };
}

/** Trailer key for check 5 (boundary moves), PARTITION-RULES.md check 5. */
const ACK_TRAILER_BOUNDARY_MOVE = 'Boundary-Move-Declared';

// Record/value separators for the `git log --format` trailer extraction
// below — same ASCII control characters, same escaped-hex-in-`separator=`
// gotcha, as `readAckTrailers` (`tests/helpers/emitted-runtime.cjs`) and
// `ship.md:312`'s own `%(trailers:...)` extraction. Only one trailer key
// space here (unlike the hash/growth pair `readAckTrailers` reads), so no
// field separator is needed — one placeholder per commit record.
const BOUNDARY_RECORD_SEP = '\x1e'; // between commits
const BOUNDARY_VALUE_SEP = '\x1d'; // between multiple values of the SAME trailer key on one commit

/**
 * Bounded git invocation for the boundary-move trailer reader, built on the
 * never-throws process seam (`runGit`) so a PER-CALL `timeoutMs` override is
 * honored (mirrors `emitted-runtime.cjs`'s private `ackTrailerGit`, which
 * this reimplements locally since it is not exported). A git failure THROWS
 * — never an empty result — same "a git failure is a hard error" law as
 * every other git-touching helper in this test suite.
 */
function boundaryTrailerGit(args, { cwd = REPO_ROOT, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = runGit([...safeDirArgs(cwd), ...args], { cwd, timeoutMs });
  if (result.outcome === OUTCOME.EXITED && result.exitCode === 0) {
    return result.stdout;
  }
  throw new Error(
    `boundary-move-trailer: \`git ${args.join(' ')}\` failed — outcome=${result.outcome} `
    + `exitCode=${result.exitCode} stderr=${(result.stderr || '').trim()}`,
  );
}

/**
 * Parse raw `Boundary-Move-Declared` trailer VALUES (no git I/O) into the
 * declarations map, applying the SAME rules `parseAckTrailers`
 * (`tests/helpers/emitted-diff.cjs`) applies to its two spaces, narrowed to
 * one: empty key -> error, empty reason -> error, two declarations of the
 * SAME key with the SAME reason (after `normalizeAckReason`) -> silent
 * dedupe (keep the first), two declarations of the same key with DIFFERENT
 * reasons -> error and drop the key entirely (never guess a winner).
 *
 * Keys here are deliberately NOT validated against `<`/`>`/whitespace or the
 * `__proto__`/`constructor`/`prototype` reserved set the ack-trailer parser
 * rejects — those defenses exist because `parseAckTrailers`' output keys
 * plain OBJECTS (`ackHash`/`ackGrowth` consumers). `declarations` here is a
 * `Map`, which has no prototype-pollution surface, so narrowing to only the
 * rules PARTITION-RULES.md's check 5 actually specifies avoids inventing
 * validation the spec never asked for.
 *
 * @param {string[]} values
 * @returns {{declarations: Map<string, {reason: string}>, errors: string[]}}
 */
function parseBoundaryMoveTrailerValues(values) {
  const errors = [];
  const declarations = new Map();
  const conflicted = new Set(); // keys already reported ambiguous — never resurrected

  for (const raw of values) {
    const delimIndex = raw.indexOf(ACK_TRAILER_DELIM);
    if (delimIndex === -1) {
      errors.push(
        `${ACK_TRAILER_BOUNDARY_MOVE}: trailer value ${JSON.stringify(raw)} has no `
        + `"${ACK_TRAILER_DELIM}" delimiter — expected "<spine-path> — <reason>"`,
      );
      continue;
    }
    const key = raw.slice(0, delimIndex).trim();
    const reason = raw.slice(delimIndex + ACK_TRAILER_DELIM.length).trim();

    if (key === '') {
      errors.push(`${ACK_TRAILER_BOUNDARY_MOVE}: trailer value ${JSON.stringify(raw)} has an empty key`);
      continue;
    }
    if (reason === '') {
      errors.push(
        `${ACK_TRAILER_BOUNDARY_MOVE}: trailer value ${JSON.stringify(raw)} has an empty reason — `
        + 'name it and say why',
      );
      continue;
    }
    if (conflicted.has(key)) continue;

    const existing = declarations.get(key);
    if (existing === undefined) {
      declarations.set(key, { reason });
    } else if (normalizeAckReason(existing.reason) === normalizeAckReason(reason)) {
      // Identical after normalization — dedupe silently, keep the first declaration.
    } else {
      errors.push(
        `${ACK_TRAILER_BOUNDARY_MOVE}: trailer key "${key}" is declared twice with ambiguous, `
        + 'conflicting reasons — an ambiguous declaration cannot silently pick a winner',
      );
      declarations.delete(key);
      conflicted.add(key);
    }
  }

  return { declarations, errors };
}

/**
 * Read `Boundary-Move-Declared` commit trailers over `<merge-base>..<headRef>`
 * (never `<baseRef>..<headRef>` — a two-dot range would let the diff and the
 * commit range being checked disagree about what "this PR" means, the same
 * correction ADR-3942 made for its own ack trailers).
 *
 * Fails closed: an uncomputable merge-base (shallow clone, unrelated
 * histories, a bad ref) THROWS — never returns an empty Map, which would
 * silently read as "no boundary moves to excuse" and disarm check 5 exactly
 * the way an empty `readAckTrailers` result would disarm ADR-3942's gate.
 *
 * @param {{baseRef: string, headRef?: string, cwd?: string, timeoutMs?: number}} opts
 * @returns {{declarations: Map<string, {reason: string}>, errors: string[]}}
 */
function readBoundaryMoveTrailers({ baseRef, headRef = 'HEAD', cwd = REPO_ROOT, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  let mergeBaseOut;
  try {
    mergeBaseOut = boundaryTrailerGit(['merge-base', baseRef, headRef], { cwd, timeoutMs });
  } catch (err) {
    throw new Error(
      `boundary-move-trailer: could not compute a merge-base range for "${baseRef}..${headRef}" `
      + '(a bad ref, a shallow clone with no common ancestor, or another git failure): '
      + err.message,
    );
  }
  const mergeBase = mergeBaseOut.trim();
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    throw new Error(
      `boundary-move-trailer: git merge-base for "${baseRef}..${headRef}" returned no usable `
      + `commit (${JSON.stringify(mergeBase)}) — the range is structurally uncomputable `
      + '(possibly a shallow clone with no common ancestor).',
    );
  }

  const valueSepHex = `%x${BOUNDARY_VALUE_SEP.codePointAt(0).toString(16).padStart(2, '0')}`;
  const format = `${BOUNDARY_RECORD_SEP}%(trailers:key=${ACK_TRAILER_BOUNDARY_MOVE},valueonly,separator=${valueSepHex})`;

  let raw;
  try {
    raw = boundaryTrailerGit(['log', `${mergeBase}..${headRef}`, `--format=${format}`], { cwd, timeoutMs });
  } catch (err) {
    throw new Error(`boundary-move-trailer: could not read commit trailers over the range: ${err.message}`);
  }

  const normalized = raw.replace(/\r/g, ''); // a CRLF commit message must parse identically to LF
  const values = [];
  // index 0 is the (empty) text before the FIRST record separator — every
  // real record starts with one, by construction of the `--format` string.
  const records = normalized.split(BOUNDARY_RECORD_SEP).slice(1);
  for (const record of records) {
    const field = record.replace(/\n+$/, ''); // git's own between-commit newline
    for (const v of field.split(BOUNDARY_VALUE_SEP)) if (v !== '') values.push(v);
  }

  return parseBoundaryMoveTrailerValues(values);
}

/**
 * Check 2 (disjointness): no non-trivial line may appear in both a spine and
 * any of its detail parts. Checked on every registered pair regardless of
 * what a given PR touched — this is what keeps duplication from creeping
 * back in after a split is made.
 *
 * The canonical `gsd_run` launcher preamble is excluded from both sides
 * before comparing (`isCanonicalLauncherPreamble`) — it is sanctioned
 * cross-file duplication under a different guard's contract, not a
 * violation of this one.
 *
 * Capped at the first 20 reported violations PER SPLIT, to avoid a
 * runaway report on a badly-drifted pair; this is a reporting cap only,
 * not a detection cap — `ok` (computed by the caller from array length) is
 * unaffected either way since any violation at all fails the check.
 *
 * @param {ReturnType<typeof discoverRegisteredSplits>} splits - already
 *   filtered by the caller to `spineExists: true` entries.
 * @returns {Array<{splitName: string, detailPath: string, line: string}>}
 */
function checkDisjointness(splits) {
  const violations = [];
  const PER_SPLIT_CAP = 20;

  for (const split of splits) {
    const spineLines = normalizeNonTrivialLines(fs.readFileSync(split.spinePath, 'utf8'))
      .filter((l) => !isCanonicalLauncherPreamble(l));
    const spineSet = new Set(spineLines);

    let reported = 0;
    for (const detailPath of split.detailPaths) {
      if (reported >= PER_SPLIT_CAP) break;
      const detailLines = normalizeNonTrivialLines(fs.readFileSync(detailPath, 'utf8'))
        .filter((l) => !isCanonicalLauncherPreamble(l));
      for (const line of detailLines) {
        if (reported >= PER_SPLIT_CAP) break;
        if (spineSet.has(line)) {
          violations.push({ splitName: split.name, detailPath, line });
          reported++;
        }
      }
    }
  }

  return violations;
}

/** A detail-path-shaped substring in spine prose: `<segments>/detail/<segments>.md`. */
const DETAIL_REFERENCE_PATTERN = /[\w./-]+\/detail\/[\w./-]+\.md/g;

/**
 * Check 3 (registration): a `<name>/detail/*.md` with no `<name>.md` spine
 * fails as an orphan; a spine that never mentions one of its own detail
 * paths fails as unreferenced; and any detail-path-SHAPED substring in the
 * spine's prose that does not resolve to a real file fails as a dangling
 * reference — three independent ways the spine/detail pairing can rot.
 *
 * Runs uncritically over every split `discoverRegisteredSplits` found,
 * including `spineExists: false` entries — that is exactly the orphan case
 * this check exists to name.
 *
 * @param {ReturnType<typeof discoverRegisteredSplits>} splits
 * @param {string} workflowsDir
 * @returns {Array<object>} violations, one of:
 *   `{kind: 'orphan_detail', name, detailPaths}`
 *   `{kind: 'unreferenced_detail', name, detailPath}`
 *   `{kind: 'dangling_reference', name, referencedPath}`
 */
function checkRegistration(splits, workflowsDir) {
  const violations = [];

  for (const split of splits) {
    if (!split.spineExists) {
      violations.push({ kind: 'orphan_detail', name: split.name, detailPaths: split.detailPaths });
      continue;
    }

    const spineContent = fs.readFileSync(split.spinePath, 'utf8');

    for (const detailPath of split.detailPaths) {
      const rel = path.relative(workflowsDir, detailPath).split(path.sep).join('/');
      if (!spineContent.includes(rel)) {
        violations.push({ kind: 'unreferenced_detail', name: split.name, detailPath });
      }
    }

    // The prose spells these out in full — e.g. `gsd-core/workflows/plan-phase/
    // detail/elaboration.md` — i.e. relative to the REPO ROOT (`workflowsDir`'s
    // grandparent: `workflowsDir` = `<root>/gsd-core/workflows`), not relative
    // to `workflowsDir` itself (verified against plan-phase.md's real
    // references; resolving against `workflowsDir` directly double-prefixes
    // `gsd-core/workflows/` and false-positives every real reference).
    const repoRoot = path.join(workflowsDir, '..', '..');
    const referenced = new Set(spineContent.match(DETAIL_REFERENCE_PATTERN) || []);
    for (const referencedPath of referenced) {
      const resolved = path.join(repoRoot, referencedPath);
      // Containment check: DETAIL_REFERENCE_PATTERN allows `.` and `/` freely, so
      // spine prose shaped like `../../../etc/detail/passwd.md` would otherwise
      // resolve outside repoRoot and turn this existence check into a path-traversal
      // oracle (security review finding, #4403). A resolved path outside repoRoot
      // can never be a real detail file this repo ships, so it is reported the same
      // as any other dangling reference rather than probed on disk.
      const relFromRoot = path.relative(repoRoot, resolved);
      const escapesRoot = relFromRoot === '' || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot);
      if (escapesRoot || !fs.existsSync(resolved)) {
        violations.push({ kind: 'dangling_reference', name: split.name, referencedPath });
      }
    }
  }

  return violations;
}

/**
 * Every detail file is a NEW shipped file (it did not exist before its
 * split), so it must stay under the same `NEW_FILE_CAP` (32768 bytes,
 * `tests/helpers/emitted-diff.cjs`, ADR-1610 Decision point 3) any other
 * brand-new workflow/agent file is held to — generalizes the pilot's
 * `tests/plan-phase-compact-split.test.cjs` size assertion to every split.
 *
 * @param {ReturnType<typeof discoverRegisteredSplits>} splits
 * @returns {Array<{splitName: string, detailPath: string, size: number}>}
 */
function checkDetailFileSizeCap(splits) {
  const violations = [];
  for (const split of splits) {
    for (const detailPath of split.detailPaths) {
      const size = fs.statSync(detailPath).size;
      if (size >= NEW_FILE_CAP) {
        violations.push({ splitName: split.name, detailPath, size });
      }
    }
  }
  return violations;
}

module.exports = {
  DEFAULT_WORKFLOWS_DIR,
  discoverRegisteredSplits,
  normalizeNonTrivialLines,
  isCanonicalLauncherPreamble,
  extractProtectedBlocks,
  ACK_TRAILER_BOUNDARY_MOVE,
  readBoundaryMoveTrailers,
  parseBoundaryMoveTrailerValues,
  checkDisjointness,
  checkRegistration,
  checkDetailFileSizeCap,
  NEW_FILE_CAP,
};
