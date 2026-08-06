'use strict';

/**
 * mutations.cjs — a catalog of deterministic corruptions applied to a
 * planning-artifact string (or to the file on disk, for the two structural
 * ones).
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * A QA harness walks an otherwise-valid scenario and, at one chosen step,
 * applies exactly one mutation from `MUTATIONS`. The harness then asserts
 * the engine under test degrades to a structured error rather than
 * crashing, hanging, or silently producing wrong state. Every mutation here
 * is a PURE, DETERMINISTIC transform (content-kind) or a scripted disk
 * operation (file-kind) — no `Math.random()`, no `Date.now()`, no hidden
 * global state — so a failing run is always reproducible from the mutation
 * id alone.
 *
 * CONTENT-KIND mutations take a string and return a string (except
 * `nonsequential-phases`, documented below, which may return the exported
 * `NOOP` sentinel). FILE-KIND mutations take `{dir, relPath}` and mutate the
 * file at `path.join(dir, relPath)` on disk; they return nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveWithin } = require('./paths.cjs');

/** Distinguishable placeholder heading/content used by unicode-headings. */
const UNICODE_HEADING_TEXT = '🚀 مرحبا Ünïcøde';

/** Cell content injected by escaped-pipes: an escaped pipe next to a real one. */
const ESCAPED_PIPE_CELL = 'a \\| b | c';

/**
 * Sentinel returned by `apply('nonsequential-phases', text)` when `text`
 * contains no recognizable phase-id occurrence to renumber. A mutation that
 * silently no-ops on unrecognized input is a vacuous test: returning this
 * frozen, identity-comparable sentinel — instead of quietly handing back the
 * unchanged string — forces callers to explicitly decide to skip the step
 * rather than accidentally asserting against an untouched artifact.
 *
 * @type {{ readonly noop: true, readonly reason: string }}
 */
const NOOP = Object.freeze({ noop: true, reason: 'no phase-id occurrence found to renumber' });

/**
 * Frozen catalog of every mutation this module implements.
 * @type {ReadonlyArray<{ id: string, kind: 'content'|'file', describe: string }>}
 */
const MUTATIONS = Object.freeze([
  {
    id: 'truncate-frontmatter',
    kind: 'content',
    describe: 'Cuts the text mid-YAML-frontmatter so the closing "---" is missing.',
  },
  {
    id: 'crlf',
    kind: 'content',
    describe: 'Converts every line ending to CRLF.',
  },
  {
    id: 'bom',
    kind: 'content',
    describe: 'Prefixes the text with a UTF-8 byte-order-mark character.',
  },
  {
    id: 'empty',
    kind: 'content',
    describe: 'Replaces the text with an empty string.',
  },
  {
    id: 'duplicate-phase-id',
    kind: 'content',
    describe: 'Duplicates the first phase-id heading or table row line.',
  },
  {
    id: 'nonsequential-phases',
    kind: 'content',
    describe: 'Renumbers phase-id occurrences to a non-sequential sequence (1, 3, 7, ...).',
  },
  {
    id: 'unicode-headings',
    kind: 'content',
    describe: 'Replaces every markdown heading\'s text with mixed unicode/emoji/RTL text.',
  },
  {
    id: 'oversized',
    kind: 'content',
    describe: 'Pads the text to just over a caller-supplied byte target.',
  },
  {
    id: 'escaped-pipes',
    kind: 'content',
    describe: 'Injects a table cell containing an escaped pipe next to a real one.',
  },
  {
    id: 'delete',
    kind: 'file',
    describe: 'Removes the file on disk.',
  },
  {
    id: 'symlink',
    kind: 'file',
    describe: 'Replaces the file with a symlink (or hardlink fallback) to a sibling copy.',
  },
]);

/**
 * Returns '\r\n' when `text` already contains at least one CRLF pair,
 * otherwise '\n'. Used so line-oriented mutations rejoin with the
 * predominant line ending already present rather than forcing one style.
 *
 * @param {string} text
 * @returns {'\r\n'|'\n'}
 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Mutation: truncate-frontmatter.
 *
 * If `text` opens with a YAML frontmatter block (`---\n ... \n---`), the
 * output is cut to a point strictly inside the frontmatter body, before the
 * closing delimiter — so the closing `---` (and everything after it,
 * including the real document body) is missing. If `text` has no
 * frontmatter, a valid-looking opening block is synthesized and then itself
 * truncated, so the mutation is never a no-op.
 *
 * @param {string} text
 * @returns {string}
 */
function truncateFrontmatter(text) {
  const openMatch = /^---\r?\n/.exec(text);
  if (!openMatch) {
    const synthetic = '---\r\ntitle: mutated\r\ndescription: truncated-frontmatter\r\n';
    return synthetic.slice(0, Math.floor(synthetic.length / 2));
  }
  const openEnd = openMatch[0].length;
  const closeMatch = /\r?\n---\r?\n?/.exec(text.slice(openEnd));
  if (!closeMatch) {
    // Already has no closer (or is degenerate) — truncate further into
    // whatever body remains so the mutation still meaningfully shortens it.
    return text.slice(0, Math.max(openEnd, Math.floor(text.length / 2)));
  }
  const closeStart = openEnd + closeMatch.index;
  const cutPoint = Math.max(openEnd, Math.floor((openEnd + closeStart) / 2));
  return text.slice(0, cutPoint);
}

/**
 * Mutation: crlf.
 *
 * Normalizes any existing CRLF to LF first, then converts every LF to CRLF —
 * so text that already contains CRLF pairs is never doubled into `\r\r\n`,
 * and the mutation is idempotent: `crlf(crlf(text)) === crlf(text)`.
 *
 * @param {string} text
 * @returns {string}
 */
function crlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * Mutation: bom.
 *
 * Prefixes `text` with U+FEFF (byte-order-mark).
 *
 * @param {string} text
 * @returns {string}
 */
function bom(text) {
  return `\uFEFF${text}`;
}

/**
 * Mutation: duplicate-phase-id.
 *
 * Finds the first line matching a phase-id heading (`## Phase N`) or a
 * phase-id table row (`| N | ... |`) and duplicates that whole line
 * immediately after itself. If no such line exists, duplicates the first
 * non-blank line instead, so the mutation still produces a structural
 * duplicate. Returns `text` unchanged only when every line is blank.
 *
 * @param {string} text
 * @returns {string}
 */
function duplicatePhaseId(text) {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const headingRe = /^##\s+Phase\s+\d+\b/i;
  const rowRe = /^\s*\|\s*\d+\s*\|/;

  let idx = lines.findIndex((line) => headingRe.test(line) || rowRe.test(line));
  if (idx === -1) {
    idx = lines.findIndex((line) => line.trim() !== '');
  }
  if (idx === -1) return text;

  const out = [...lines.slice(0, idx + 1), lines[idx], ...lines.slice(idx + 1)];
  return out.join(eol);
}

/**
 * Generates the k-th term (0-indexed) of the deterministic non-sequential
 * skip series used by `nonsequential-phases`: 1, 3, 7, 15, 31, ... (2^(k+1) - 1).
 * The first three terms are exactly the "1, 3, 7" example from the mutation
 * catalog; the closed form extends deterministically to any number of
 * phase-id occurrences without repeating a value.
 *
 * @param {number} k zero-based occurrence index
 * @returns {number}
 */
function skipSeriesTerm(k) {
  return Math.pow(2, k + 1) - 1;
}

/**
 * Mutation: nonsequential-phases.
 *
 * Rewrites every phase-id occurrence — `## Phase N` headings and `| N | ... |`
 * table-row ids — to the deterministic skip series 1, 3, 7, 15, ... in order
 * of appearance. If `text` contains no phase-id occurrence at all, there is
 * nothing to renumber: returns the exported `NOOP` sentinel instead of
 * silently handing back the unchanged string, so a caller cannot mistake a
 * no-op for a genuine mutation.
 *
 * @param {string} text
 * @returns {string | typeof NOOP}
 */
function nonsequentialPhases(text) {
  let occurrence = 0;
  let matched = false;

  const withHeadings = text.replace(/(##\s+Phase\s+)(\d+)/gi, (_match, prefix) => {
    matched = true;
    return `${prefix}${skipSeriesTerm(occurrence++)}`;
  });

  const withRows = withHeadings.replace(/^(\s*\|\s*)(\d+)(\s*\|)/gm, (_match, prefix, _num, suffix) => {
    matched = true;
    return `${prefix}${skipSeriesTerm(occurrence++)}${suffix}`;
  });

  return matched ? withRows : NOOP;
}

/**
 * Mutation: unicode-headings.
 *
 * Replaces every markdown heading's text (the part after the `#` run and
 * whitespace) with a fixed mixed unicode/emoji/RTL string, preserving the
 * heading level and leading whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
function unicodeHeadings(text) {
  return text.replace(/^(#{1,6})(\s+).*$/gm, (_match, hashes, ws) => `${hashes}${ws}${UNICODE_HEADING_TEXT}`);
}

/**
 * Mutation: oversized.
 *
 * Pads `text` with a deterministic ASCII filler so the UTF-8 byte length of
 * the result is strictly greater than `opts.targetBytes` (exactly one byte
 * over when `text` is already at or under the target, since the filler is
 * single-byte-per-character). Callers drive their own boundary tests
 * (limit-1 / limit / limit+1) by varying `targetBytes` across calls; if
 * `text` already exceeds `targetBytes`, it is returned unchanged since it is
 * already oversized relative to that target.
 *
 * @param {string} text
 * @param {{ targetBytes: number }} opts
 * @returns {string}
 */
function oversized(text, opts) {
  if (!opts || !Number.isFinite(opts.targetBytes) || opts.targetBytes < 0) {
    throw new Error('apply("oversized", text, opts): opts.targetBytes must be a non-negative finite number');
  }
  const { targetBytes } = opts;
  const currentBytes = Buffer.byteLength(text, 'utf8');
  if (currentBytes > targetBytes) return text;
  const FILL_CHAR = 'X';
  const deficit = targetBytes - currentBytes + 1;
  return text + FILL_CHAR.repeat(deficit);
}

/**
 * Mutation: escaped-pipes.
 *
 * Finds the first markdown table row (a line whose trimmed form starts and
 * ends with `|`) and appends a cell containing an escaped pipe next to a
 * real one (`a \| b | c`) before the row's closing pipe. If no table row
 * exists, appends a new one-row table containing that cell.
 *
 * @param {string} text
 * @returns {string}
 */
function escapedPipes(text) {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const rowRe = /^\s*\|.*\|\s*$/;
  const idx = lines.findIndex((line) => rowRe.test(line));

  if (idx === -1) {
    const separator = text === '' ? '' : eol;
    return `${text}${separator}| ${ESCAPED_PIPE_CELL} |`;
  }

  const trimmed = lines[idx].replace(/\s+$/, '');
  const out = [...lines];
  out[idx] = `${trimmed} ${ESCAPED_PIPE_CELL} |`;
  return out.join(eol);
}

/**
 * Resolves `{dir, relPath}` to an absolute on-disk path via `resolveWithin`
 * (`./paths.cjs`) — the single containment guard for this harness. `relPath`
 * is scenario-supplied (`step.mutate.target`), so this is the seam both
 * `deleteFile` and `symlinkFile` inherit: a traversing `relPath` (e.g.
 * `"../../../../etc/hosts"`) throws here rather than reaching
 * `fs.unlinkSync` / `fs.symlinkSync` outside `dir`.
 *
 * @param {string} dir
 * @param {string} relPath
 * @returns {string}
 */
function resolveTargetPath(dir, relPath) {
  return resolveWithin(dir, relPath);
}

/**
 * Mutation: delete (file-kind).
 *
 * Removes the file at `path.join(dir, relPath)`.
 *
 * @param {{ dir: string, relPath: string }} target
 * @returns {void}
 */
function deleteFile(target) {
  const filePath = resolveTargetPath(target.dir, target.relPath);
  fs.unlinkSync(filePath);
}

/**
 * Mutation: symlink (file-kind).
 *
 * Replaces the file at `path.join(dir, relPath)` with a symlink pointing at
 * a sibling file (in the same directory) holding the same bytes. On
 * platforms where `fs.symlinkSync` fails with a permission error (e.g.
 * Windows without developer mode / elevated privileges), falls back to a
 * hard link (`fs.linkSync`).
 *
 * Never leaves the tree half-mutated: link capability is first proven
 * against a disposable probe path in the same directory (which never
 * touches the real target). Only once that probe succeeds is the real
 * target removed and immediately replaced using the now-proven method — so
 * a platform that supports neither symlinks nor hard links throws before
 * the target file is ever deleted, and a target that IS deleted is
 * guaranteed a same-shaped replacement (barring an out-of-process deletion
 * racing this function, which is out of scope for a single-writer QA tool).
 *
 * @param {{ dir: string, relPath: string }} target
 * @returns {void}
 */
function symlinkFile(target) {
  const filePath = resolveTargetPath(target.dir, target.relPath);
  const bytes = fs.readFileSync(filePath);
  const siblingPath = path.join(path.dirname(filePath), `.mutation-sibling-${path.basename(filePath)}`);
  fs.writeFileSync(siblingPath, bytes);

  const probePath = `${filePath}.mutation-probe`;
  try {
    fs.unlinkSync(probePath);
  } catch {
    // No stale probe from a previous failed run — nothing to clean up.
  }

  let useHardlink = false;
  try {
    fs.symlinkSync(siblingPath, probePath);
  } catch (symlinkErr) {
    if (process.platform !== 'win32') throw symlinkErr;
    try {
      fs.linkSync(siblingPath, probePath);
      useHardlink = true;
    } catch (linkErr) {
      throw new Error(
        'symlink mutation unavailable on this platform: '
          + `symlink failed (${symlinkErr.message}) and hardlink fallback failed (${linkErr.message})`,
      );
    }
  }
  fs.unlinkSync(probePath);

  // Link capability proven above — safe to swap the real target now.
  fs.unlinkSync(filePath);
  if (useHardlink) {
    fs.linkSync(siblingPath, filePath);
  } else {
    fs.symlinkSync(siblingPath, filePath);
  }
}

/**
 * Applies a single mutation by id.
 *
 * - content-kind mutations: `apply(id, input)` where `input` is a string,
 *   returning the mutated string (or, only for `nonsequential-phases`, the
 *   `NOOP` sentinel — see that mutation's doc comment).
 * - `oversized` additionally takes a third argument: `apply('oversized',
 *   text, {targetBytes})`.
 * - file-kind mutations: `apply(id, {dir, relPath})`, mutating the file on
 *   disk and returning nothing.
 *
 * @param {string} id one of MUTATIONS[].id
 * @param {string | { dir: string, relPath: string }} input
 * @param {{ targetBytes?: number }} [opts]
 * @returns {string | void | typeof NOOP}
 */
function apply(id, input, opts) {
  const entry = MUTATIONS.find((m) => m.id === id);
  if (!entry) {
    throw new Error(`apply: unknown mutation id "${String(id)}" (known ids: ${MUTATIONS.map((m) => m.id).join(', ')})`);
  }

  switch (id) {
    case 'truncate-frontmatter':
      return truncateFrontmatter(input);
    case 'crlf':
      return crlf(input);
    case 'bom':
      return bom(input);
    case 'empty':
      return '';
    case 'duplicate-phase-id':
      return duplicatePhaseId(input);
    case 'nonsequential-phases':
      return nonsequentialPhases(input);
    case 'unicode-headings':
      return unicodeHeadings(input);
    case 'oversized':
      return oversized(input, opts);
    case 'escaped-pipes':
      return escapedPipes(input);
    case 'delete':
      return deleteFile(input);
    case 'symlink':
      return symlinkFile(input);
    /* istanbul ignore next -- unreachable: entry lookup above already validated id */
    default:
      throw new Error(`apply: unhandled mutation id "${id}"`);
  }
}

module.exports = {
  MUTATIONS,
  apply,
  NOOP,
};
