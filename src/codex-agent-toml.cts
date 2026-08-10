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
 * plus the detected `eol`/BOM/trailing-newline metadata so
 * {@link renderCodexAgentToml} can reproduce the source **byte-identically**
 * when nothing was stripped (the load-bearing round-trip property — see
 * 50-test-matrix.md row A14). `stripModel`/`stripReasoningEffort` remove a
 * targeted line from `lines`; every other byte is untouched.
 */
export interface CodexAgentDoc {
  /** Content lines (BOM-stripped, EOL-stripped). `lines.join(eol)` reproduces the body. */
  lines: string[];
  /** The single line-ending style detected in the source. */
  eol: '\n' | '\r\n';
  /** Whether the source began with a UTF-8 BOM (U+FEFF). */
  hadBOM: boolean;
  /** Whether the source ended with a line terminator. */
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

/**
 * The STRICT parse entry point (Phase 3, the writer's half of the
 * reconciliation). Returns `{ok:false, reason:UNTERMINATED_BLOCK}` rather than
 * guessing when the `developer_instructions` block is opened but never closed.
 * On success, `doc` carries enough (the original `lines`, `eol`, BOM/trailing-
 * newline flags, and the two resolved values with their line indices) for
 * {@link renderCodexAgentToml} to reproduce the source byte-identically, and for
 * {@link stripModel}/{@link stripReasoningEffort} to remove exactly one line.
 */
export function parseCodexAgentToml(content: string): ParseCodexAgentTomlResult {
  const hadBOM = content.charCodeAt(0) === 0xfeff;
  const stripped = stripBOM(content);
  const eol: '\n' | '\r\n' = stripped.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(stripped);
  const lines = stripped.split(/\r?\n/);
  const { start, end, terminated } = findDeveloperInstructionsBlockRange(lines);
  if (start !== -1 && !terminated) {
    return { ok: false, reason: PARSE_REASON.UNTERMINATED_BLOCK };
  }
  const { model, modelLineIndex, reasoningEffort, reasoningEffortLineIndex } = scanHeaderLines(lines, start, end);
  const doc: CodexAgentDoc = {
    lines,
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
 * byte-identical to the original `parseCodexAgentToml` input (matrix row A14)
 * — it never re-derives line content, only rejoins `lines` with the recorded
 * `eol` and re-prepends a BOM if one was present. `split(/\r?\n/)` followed by
 * `join(eol)` round-trips exactly for a uniformly-line-ended source, including
 * the trailing-newline case: a trailing terminator in the source produces a
 * trailing empty string in `lines`, which `join` restores as a trailing `eol`.
 */
export function renderCodexAgentToml(doc: CodexAgentDoc): string {
  const body = doc.lines.join(doc.eol);
  return doc.hadBOM ? BOM_CHAR + body : body;
}

// Removes exactly one line (by index) from `doc.lines`, re-indexing the block
// range and the OTHER key's line index so a subsequent strip/render still sees
// a consistent doc. Never touches any other line's content.
function removeLine(doc: CodexAgentDoc, index: number, which: 'model' | 'reasoningEffort'): CodexAgentDoc {
  const lines = doc.lines.slice(0, index).concat(doc.lines.slice(index + 1));
  const reindex = (i: number | null): number | null => (i === null ? null : i > index ? i - 1 : i);
  const blockRange = { ...doc.blockRange };
  if (blockRange.start !== -1) {
    if (blockRange.start > index) blockRange.start -= 1;
    if (blockRange.end > index) blockRange.end -= 1;
  }
  return {
    ...doc,
    lines,
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
