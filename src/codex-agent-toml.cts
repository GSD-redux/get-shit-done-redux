/**
 * Codex Agent TOML — typed IR for `~/.codex/agents/<agent>.toml` (#3243, ADR-2313).
 *
 * A genuine leaf: node builtins only. This is a **document model**, not a policy —
 * it knows how to parse/render/strip two known keys (`model`,
 * `model_reasoning_effort`) from a Codex agent `.toml`. It does NOT know which
 * `model` values are illegal for Codex (that predicate — Anthropic-flavored
 * detection — stays in `model-catalog.cts`; callers decide what to strip).
 *
 * Moved here (not copied) from `agent-install-check.cts` (#3242, Phase 2), which
 * wrote the hard half: block-range detection, BOM stripping, TOML value
 * unquoting, and the lenient header scan. That module's behavior is UNCHANGED —
 * it imports `stripBOM`/`scanTomlLines` from here and its regression suite
 * (`tests/agent-install-check.test.cjs`) is the proof.
 *
 * ── The reconciliation (40-design.md) ──────────────────────────────────────
 *
 * Phase 2's reader and this phase's writer disagree on how to handle an
 * unterminated `developer_instructions` block, deliberately:
 *
 *   - The READER (`scanTomlLines`, used directly by `checkCodexModelPosture`)
 *     stays LENIENT: an unterminated block still excludes "the rest of the
 *     file" from the header scan (findDeveloperInstructionsBlockRange's
 *     existing fallback), because misreading prompt prose as a pin is only a
 *     false positive — it wastes a user's time, nothing more.
 *   - The WRITER (`parseCodexAgentToml`, used by the Codex sync) is STRICT: an
 *     unterminated block makes the whole document `{ok:false}`, because a
 *     writer that proceeds on a malformed document risks rewriting it.
 *
 * One block-range detector, two call sites, two policies — never two detectors
 * that could silently drift from each other.
 */

/** Frozen reason enum for a failed {@link parseCodexAgentToml}. */
export const PARSE_REASON = Object.freeze({
  UNTERMINATED_BLOCK: 'unterminated_block',
});

export type ParseReason = (typeof PARSE_REASON)[keyof typeof PARSE_REASON];

/**
 * The typed IR. Carries the original `lines` (never re-tokenized once parsed)
 * plus the detected BOM/trailing-newline metadata so {@link renderCodexAgentToml}
 * can reproduce the source **byte-identically** when nothing was stripped (the
 * load-bearing round-trip property — see 50-test-matrix.md row A14), even when
 * the source mixes line-ending styles (`\r\n`, `\n`, a lone `\r`) within one
 * file. `stripModel`/`stripReasoningEffort` remove a targeted line AND its own
 * terminator from `lines`/`terminators`; every other line's content is
 * untouched, and so is its own terminator — EXCEPT when the removed line was
 * the file's last line AND the removed line had no terminator (the source had
 * no trailing newline), in which case the new last line's terminator is
 * cleared to `''` too (see {@link removeLine}) so the file's trailing-newline
 * status is preserved rather than silently changed. When the source DID end
 * with a newline, the new last line keeps its OWN terminator unchanged —
 * copying the removed line's terminator there would corrupt a mixed-EOL
 * source by silently changing the new last line's own ending style.
 */
export interface CodexAgentDoc {
  /** Content lines (BOM-stripped, terminator-free). Paired 1:1 by index with `terminators`. */
  lines: string[];
  /**
   * Each line's OWN terminator (`'\r\n'`, `'\n'`, `'\r'`, or `''` for a line
   * with none — the last line of a source with no trailing newline). Never
   * collapsed to one whole-file style: {@link renderCodexAgentToml} rejoins
   * `lines[i] + terminators[i]` so a mixed-EOL source round-trips exactly.
   */
  terminators: string[];
  /**
   * The line-ending style that appears in the source, informational only —
   * `renderCodexAgentToml` does NOT use this field (it rejoins each line with
   * its own `terminators[i]` instead). Recorded as `'\r\n'` if any `\r\n`
   * appears anywhere in the source, else `'\n'`, purely for callers that want
   * a human-readable summary (e.g. logging); never a rendering input.
   */
  eol: '\n' | '\r\n';
  /** Whether the source began with a UTF-8 BOM (U+FEFF). */
  hadBOM: boolean;
  /** Whether the source ended with a line terminator (any of `\r\n`/`\n`/`\r`). */
  trailingNewline: boolean;
  /** The `developer_instructions = '''...'''` block's line range, or `{start:-1,end:-1}` if absent. */
  blockRange: { start: number; end: number };
  /** The resolved `model` value (last occurrence outside the block), or null. */
  model: string | null;
  /** Line index of the `model` key, or null if absent. */
  modelLineIndex: number | null;
  /** The resolved `model_reasoning_effort` value (last occurrence outside the block), or null. */
  reasoningEffort: string | null;
  /** Line index of the `model_reasoning_effort` key, or null if absent. */
  reasoningEffortLineIndex: number | null;
}

export type ParseCodexAgentTomlResult =
  | { ok: true; doc: CodexAgentDoc }
  | { ok: false; reason: ParseReason };

// The UTF-8 BOM codepoint, spelled as an escape rather than the literal
// character so the source file never carries an invisible codepoint.
const BOM_CHAR = String.fromCharCode(0xfeff);

// Strips a leading UTF-8 BOM (U+FEFF), which fs.readFileSync(..., 'utf8') does not
// strip on its own, and unwraps a TOML basic/literal string value's surrounding
// quotes so `model = "sonnet"` yields `sonnet`, not `"sonnet"`.
export function stripBOM(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function unquoteTomlValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  const quoted = trimmed.match(/^"([^"]*)"/) ?? trimmed.match(/^'([^']*)'/);
  return quoted ? quoted[1] : trimmed;
}

// The `developer_instructions` block is a TOML multi-line literal string
// (`developer_instructions = '''...'''`) that `generateCodexAgentToml` always
// emits after the header fields. Prompt prose inside that block discusses models
// constantly, so a `model = ...`-shaped line inside it must never be read as a
// live pin — but the block can legally appear anywhere in the file (a
// hand-reordered agent can move `model` after it), and another key's *value* can
// legally contain the literal text `developer_instructions = '''` (e.g. a
// `description` field quoting it) without that being the real block opener. So
// instead of truncating the file at the first textual occurrence of the marker
// anywhere in the content, this locates the block by its anchored line-start
// opener (`^\s*developer_instructions\s*=\s*'''`, never a mid-line/mid-value
// match) and its closing `'''` line, and excludes only the lines between them —
// every other line in the file, before AND after the block, is scanned.
//
// If no opener is found, nothing is excluded (the whole file is scanned) and
// `terminated` is trivially true. If the block IS opened but never closed before
// EOF (malformed file), `terminated` is false: the lenient reader (scanTomlLines)
// still treats the rest of the file as inside the block (the safe direction for
// a reader — see module header comment); the strict writer (parseCodexAgentToml)
// reads `terminated` and refuses instead. The emitter always uses `'''` (a TOML
// literal string), never a `"""` basic multi-line string, so only `'''` is
// treated as the block delimiter here.
export function findDeveloperInstructionsBlockRange(
  lines: string[],
): { start: number; end: number; terminated: boolean } {
  const openIndex = lines.findIndex((line) => /^\s*developer_instructions\s*=\s*'''/.test(line));
  if (openIndex === -1) {
    return { start: -1, end: -1, terminated: true };
  }
  const afterOpenMarker = lines[openIndex].replace(/^\s*developer_instructions\s*=\s*'''/, '');
  if (afterOpenMarker.includes("'''")) {
    // Same-line block: developer_instructions = '''one line'''
    return { start: openIndex, end: openIndex, terminated: true };
  }
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (lines[i].includes("'''")) {
      return { start: openIndex, end: i, terminated: true };
    }
  }
  return { start: openIndex, end: lines.length - 1, terminated: false };
}

/** Header-scan result shared by the lenient reader ({@link scanTomlLines}). */
export interface HeaderScanResult {
  model: string | null;
  hasReasoningEffort: boolean;
}

interface HeaderLineInfo {
  model: string | null;
  modelLineIndex: number | null;
  reasoningEffort: string | null;
  reasoningEffortLineIndex: number | null;
}

// Line-oriented scan of every line OUTSIDE the `developer_instructions` block
// (see findDeveloperInstructionsBlockRange). Full-key-name anchoring —
// `^([A-Za-z_][\w]*)\s*=` for a bare key, or `^"([^"]*)"\s*=` / `^'([^']*)'\s*=`
// for TOML's legal quoted-key forms, normalized to the same key name — means
// `model_verbosity` / `model_reasoning_effort` never satisfy a `model` probe,
// and vice versa; `#`-prefixed lines (after trimming leading whitespace) are
// treated as comments, never live pins. Shared by both scanTomlLines (the
// lenient reader, boolean-only for reasoning effort) and parseCodexAgentToml
// (the strict writer, which also needs the effort's value and both keys' line
// indices so stripModel/stripReasoningEffort can remove exactly one line).
function scanHeaderLines(lines: string[], blockStart: number, blockEnd: number): HeaderLineInfo {
  let model: string | null = null;
  let modelLineIndex: number | null = null;
  let reasoningEffort: string | null = null;
  let reasoningEffortLineIndex: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (blockStart !== -1 && i >= blockStart && i <= blockEnd) continue;
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:"([^"]*)"|'([^']*)'|([A-Za-z_][\w]*))\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1] ?? match[2] ?? match[3];
    const rawValue = match[4];
    if (key === 'model') {
      model = unquoteTomlValue(rawValue);
      modelLineIndex = i;
    } else if (key === 'model_reasoning_effort') {
      reasoningEffort = unquoteTomlValue(rawValue);
      reasoningEffortLineIndex = i;
    }
  }
  return { model, modelLineIndex, reasoningEffort, reasoningEffortLineIndex };
}

/**
 * The LENIENT reader entry point (Phase 2, moved verbatim in behavior). Never
 * fails: an unterminated block falls back to "rest of file is inside the
 * block" via {@link findDeveloperInstructionsBlockRange}'s own fallback.
 * `content` is expected already BOM-stripped (callers pass `stripBOM(raw)`).
 */
export function scanTomlLines(content: string): HeaderScanResult {
  const lines = content.split(/\r?\n/);
  const { start, end } = findDeveloperInstructionsBlockRange(lines);
  const { model, reasoningEffort } = scanHeaderLines(lines, start, end);
  return { model, hasReasoningEffort: reasoningEffort !== null };
}

// Splits `content` into `{lines, terminators}` — each line's OWN terminator
// (`'\r\n'`, `'\r'`, or `'\n'`) is captured alongside it rather than discarded,
// so a source mixing line-ending styles round-trips byte-identically instead
// of every line being normalized to one whole-file style (the A14 defect: a
// `split(/\r?\n/)` + `join(eol)` pair throws away each line's own terminator
// and re-imposes a single style on rejoin, corrupting a mixed-EOL file even
// when zero lines were stripped). `String#split` with a capturing group
// interleaves the delimiters into the result array — `"a\r\nb\nc".split(/(\r\n|\r|\n)/)`
// yields `["a","\r\n","b","\n","c"]` — so even indices are line content and
// odd indices are that line's terminator; a final line with no trailing
// terminator has no odd-index sibling, which the `?? ''` below covers. `\r\n`
// is tried before the bare `\r` alternative so a CRLF is never misread as a
// lone-CR line followed by an empty LF-terminated line.
function splitPreservingTerminators(content: string): { lines: string[]; terminators: string[] } {
  const parts = content.split(/(\r\n|\r|\n)/);
  const lines: string[] = [];
  const terminators: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    terminators.push(parts[i + 1] ?? '');
  }
  return { lines, terminators };
}

/**
 * The STRICT parse entry point (Phase 3, the writer's half of the
 * reconciliation). Returns `{ok:false, reason:UNTERMINATED_BLOCK}` rather than
 * guessing when the `developer_instructions` block is opened but never closed.
 * On success, `doc` carries enough (the original `lines`/`terminators`, BOM/
 * trailing-newline flags, and the two resolved values with their line indices)
 * for {@link renderCodexAgentToml} to reproduce the source byte-identically —
 * including a source with mixed line-ending styles — and for
 * {@link stripModel}/{@link stripReasoningEffort} to remove exactly one line
 * and its own terminator.
 */
export function parseCodexAgentToml(content: string): ParseCodexAgentTomlResult {
  const hadBOM = content.charCodeAt(0) === 0xfeff;
  const stripped = stripBOM(content);
  // Informational only — see CodexAgentDoc.eol's docstring. Never used by
  // renderCodexAgentToml.
  const eol: '\n' | '\r\n' = stripped.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /(\r\n|\r|\n)$/.test(stripped);
  const { lines, terminators } = splitPreservingTerminators(stripped);
  const { start, end, terminated } = findDeveloperInstructionsBlockRange(lines);
  if (start !== -1 && !terminated) {
    return { ok: false, reason: PARSE_REASON.UNTERMINATED_BLOCK };
  }
  const { model, modelLineIndex, reasoningEffort, reasoningEffortLineIndex } = scanHeaderLines(lines, start, end);
  const doc: CodexAgentDoc = {
    lines,
    terminators,
    eol,
    hadBOM,
    trailingNewline,
    blockRange: { start, end },
    model,
    modelLineIndex,
    reasoningEffort,
    reasoningEffortLineIndex,
  };
  return { ok: true, doc };
}

/**
 * Renders `doc` back to a string. For an unmodified doc this is
 * byte-identical to the original `parseCodexAgentToml` input (matrix row
 * A14) — it never re-derives line content, only rejoins each line with its
 * OWN recorded terminator (`terminators[i]`, never the whole-file `eol`) and
 * re-prepends a BOM if one was present. This is a plain concatenation of the
 * surviving `[line, terminator]` pieces, so a source with mixed `\r\n`/`\n`/
 * lone-`\r` line endings round-trips exactly, and a strip
 * ({@link stripModel}/{@link stripReasoningEffort}) removes only the target
 * line and its own terminator — every other line's ending is untouched.
 */
export function renderCodexAgentToml(doc: CodexAgentDoc): string {
  let body = '';
  for (let i = 0; i < doc.lines.length; i++) {
    body += doc.lines[i] + (doc.terminators[i] ?? '');
  }
  return doc.hadBOM ? BOM_CHAR + body : body;
}

// Removes exactly one line (by index) — AND its own terminator — from
// `doc.lines`/`doc.terminators`, re-indexing the block range and the OTHER
// key's line index so a subsequent strip/render still sees a consistent doc.
// Never touches any other line's content or terminator.
//
// The one exception is when `index` names the file's LAST line: a plain
// slice-out would drop the removed line's terminator but leave the
// *previous* line's terminator standing in its place, which silently
// invents (or drops) a trailing newline the source never had — a middle-line
// removal never has this problem because the terminator that survives (the
// one that WAS between the previous line and the removed one) is exactly the
// terminator the new neighbors should have between them. For a last-line
// removal, the file's trailing-newline-or-not status lives in whether the
// REMOVED line's own terminator was empty (that is what `trailingNewline`
// was computed from) — so the new last line inherits the removed line's
// EMPTINESS only: if the removed terminator was `''`, the new last line's
// terminator is cleared to `''` too. If the removed terminator was
// non-empty, the source already ended with a newline and the new last line
// already has the right one (its OWN, unchanged) — overwriting it with the
// removed line's terminator would silently change the new last line's own
// ending style on a mixed-EOL source (see A26). Removing the only remaining
// line is the degenerate case: there is no new last line, so the result is
// the empty document.
function removeLine(doc: CodexAgentDoc, index: number, which: 'model' | 'reasoningEffort'): CodexAgentDoc {
  const isLastLine = index === doc.lines.length - 1;
  let lines: string[];
  let terminators: string[];
  if (doc.lines.length === 1) {
    lines = [];
    terminators = [];
  } else if (isLastLine) {
    lines = doc.lines.slice(0, index);
    // Inherit the removed line's EMPTINESS, never its STYLE: if the removed
    // line had no terminator (the source had no trailing newline), the new
    // last line's terminator becomes '' too. Otherwise the source DID end
    // with a newline, and the new last line already has the right one — its
    // OWN terminator, which may differ in style from the removed line's (a
    // mixed-EOL source) — so it is left unchanged rather than overwritten.
    const removedTerminator = doc.terminators[index];
    const newLastTerminator = removedTerminator === '' ? '' : doc.terminators[index - 1];
    terminators = doc.terminators.slice(0, index - 1).concat([newLastTerminator]);
  } else {
    lines = doc.lines.slice(0, index).concat(doc.lines.slice(index + 1));
    terminators = doc.terminators.slice(0, index).concat(doc.terminators.slice(index + 1));
  }
  const reindex = (i: number | null): number | null => (i === null ? null : i > index ? i - 1 : i);
  const blockRange = { ...doc.blockRange };
  if (blockRange.start !== -1) {
    if (blockRange.start > index) blockRange.start -= 1;
    if (blockRange.end > index) blockRange.end -= 1;
  }
  return {
    ...doc,
    lines,
    terminators,
    blockRange,
    model: which === 'model' ? null : doc.model,
    modelLineIndex: which === 'model' ? null : reindex(doc.modelLineIndex),
    reasoningEffort: which === 'reasoningEffort' ? null : doc.reasoningEffort,
    reasoningEffortLineIndex: which === 'reasoningEffort' ? null : reindex(doc.reasoningEffortLineIndex),
  };
}

/**
 * Returns a new doc with the `model` line removed (a no-op copy if there was
 * no `model` line). Every other byte — comments, other keys, the
 * `developer_instructions` block, line endings, BOM — is untouched.
 */
export function stripModel(doc: CodexAgentDoc): CodexAgentDoc {
  if (doc.modelLineIndex === null) return doc;
  return removeLine(doc, doc.modelLineIndex, 'model');
}

/**
 * Returns a new doc with the `model_reasoning_effort` line removed (a no-op
 * copy if there was none). Every other byte is untouched.
 */
export function stripReasoningEffort(doc: CodexAgentDoc): CodexAgentDoc {
  if (doc.reasoningEffortLineIndex === null) return doc;
  return removeLine(doc, doc.reasoningEffortLineIndex, 'reasoningEffort');
}
