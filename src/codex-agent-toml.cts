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
 * #3897 rung 3 amendment: `deriveCodexSandboxMode`/`CODEX_SANDBOX_HOLDS`/
 * `validateCodexSandboxHolds` also live here now (moved from `bin/install.js`).
 * That IS a policy (which `sandbox_mode` a role's tool contract derives), a
 * narrow exception to this module's "document model, not policy" charter above
 * — made because `bin/install.js` cannot be the shared owner: requiring it for
 * its side effect on `require()` (the CLI banner print) corrupts every
 * stdout-JSON caller (`agent-install-check.cts`'s `checkCodexSandboxPosture`).
 * This module was already the single fs/path-free-parsing home both callers
 * shared; `fs`/`path` are imported below ONLY for `validateCodexSandboxHolds`'s
 * roster check — still node builtins only, no third-party or bin/lib dependency.
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

import fs from 'node:fs';
import path from 'node:path';

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
  /**
   * #3897 rung 4 (isolated correctness review, MINOR finding 2): the
   * installed `sandbox_mode` value, block-aware exactly like `model` above —
   * a `sandbox_mode = "..."`-shaped line inside the `developer_instructions`
   * block (prose discussing sandbox modes) must never be read as a live
   * value, same reasoning as the `model` probe this scan already protects.
   * `null` when no live `sandbox_mode` key is present.
   */
  sandboxMode: string | null;
}

interface HeaderLineInfo {
  model: string | null;
  modelLineIndex: number | null;
  reasoningEffort: string | null;
  reasoningEffortLineIndex: number | null;
  sandboxMode: string | null;
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
// `sandbox_mode` (#3897 rung 4 MINOR finding 2) rides the same block-aware
// pass as `model`/`model_reasoning_effort` — one scanner, never a second,
// naive whole-file regex that could match prose inside the block.
function scanHeaderLines(lines: string[], blockStart: number, blockEnd: number): HeaderLineInfo {
  let model: string | null = null;
  let modelLineIndex: number | null = null;
  let reasoningEffort: string | null = null;
  let reasoningEffortLineIndex: number | null = null;
  let sandboxMode: string | null = null;
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
    } else if (key === 'sandbox_mode') {
      sandboxMode = unquoteTomlValue(rawValue);
    }
  }
  return { model, modelLineIndex, reasoningEffort, reasoningEffortLineIndex, sandboxMode };
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
  const { model, reasoningEffort, sandboxMode } = scanHeaderLines(lines, start, end);
  return { model, hasReasoningEffort: reasoningEffort !== null, sandboxMode };
}

// Splits `content` into `{lines, terminators}` where `terminators[i]` is the
// terminator that FOLLOWS `lines[i]` (`'\r\n'`, `'\r'`, `'\n'`, or `''` for a
// line with none — only possible as the file's last line). The two arrays are
// always the same length and there is NEVER a phantom trailing entry: a
// source ending in a terminator (the common case) yields exactly as many
// lines as it has content lines, not one more. `render` is then a plain
// `lines[i] + terminators[i]` concatenation with no special-casing of "the
// last line" — see `renderCodexAgentToml`.
//
// `String#split` with a capturing group interleaves the delimiters into the
// result array — `"a\r\nb\nc".split(/(\r\n|\r|\n)/)` yields
// `["a","\r\n","b","\n","c"]` — so even indices are line content and odd
// indices are that line's terminator. When `content` ends WITH a terminator,
// `split` appends one extra empty-string element after the last real
// terminator (e.g. `"a\n".split(...)` → `["a","\n",""]`); that trailing `""`
// is not a real line, it is `split`'s "nothing after the last delimiter"
// marker, so the loop below stops before consuming it instead of recording it
// as a phantom empty final line (the defect this replaced — see A29: a doc
// with a phantom last element made every removal rule reason about the wrong
// element for any trailing-newline-terminated file, the common case). `\r\n`
// is tried before the bare `\r` alternative so a CRLF is never misread as a
// lone-CR line followed by an empty LF-terminated line.
function splitPreservingTerminators(content: string): { lines: string[]; terminators: string[] } {
  if (content === '') return { lines: [], terminators: [] };
  const parts = content.split(/(\r\n|\r|\n)/);
  const lastIndex = parts.length - 1;
  const lines: string[] = [];
  const terminators: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (i === lastIndex && parts[i] === '') break; // split's post-terminator marker, not a real line
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
    terminators = doc.terminators.slice(0, index);
    // Inherit the removed line's EMPTINESS, never its STYLE: if the removed
    // line had no terminator (the source had no trailing newline), the new
    // last line's terminator becomes '' too. Otherwise the source DID end
    // with a newline, and the new last line already has the right one — its
    // OWN terminator (already carried over by the slice above), which may
    // differ in style from the removed line's (a mixed-EOL source) — so it is
    // left unchanged rather than overwritten.
    if (doc.terminators[index] === '') {
      terminators[terminators.length - 1] = '';
    }
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

// ── Codex sandbox_mode derivation (#3897 rung 3, ADR-3473 §8.3) ────────────
//
// Moved here from `bin/install.js` (fix for the CAUSE A regression this rung
// introduced): `agent-install-check.cts`'s `checkCodexSandboxPosture` used to
// lazily `require(bin/install.js)` to reach this derivation — but requiring
// `bin/install.js` runs its whole top-level script, including the ASCII
// banner print to stdout, which corrupted every stdout-JSON caller downstream
// of `checkCodexSandboxPosture` (`gsd-tools validate agents`). This module is
// a genuine leaf with no top-level side effects, so both `bin/install.js` and
// `agent-install-check.cts` import the derivation from here instead — ONE
// owner, no second predicate (routing `src/` through `bin/install.js` was
// backwards layering to begin with).
//
// This module does NOT parse frontmatter (there is no third copy of that
// extraction here — two already exist, `bin/install.js` and
// `runtime-artifact-conversion.cts`). `deriveCodexSandboxMode` below takes
// the already-resolved `tools:` value as a plain string parameter: every
// caller already has it (or the raw frontmatter to pull it from) in hand
// before calling in, so this module stays a pure predicate over data
// supplied by the caller — never a document reader itself. This also means
// the module never needs the full YAML-backed `frontmatter.cts` engine
// (vendored js-yaml + anchor/alias refusal + comment-channel plumbing, built
// for a much broader contract than a single `tools:` line lookup) — it has
// no frontmatter-parsing need at all anymore.

/**
 * The 17 roles measured as widening under derivation (declare Write/Edit,
 * never in the pre-#3897 `CODEX_AGENT_SANDBOX` map, so the old
 * `|| 'read-only'` fallback silently under-granted them). Pinned to
 * `read-only` pending the open question of whether Codex enforces
 * `sandbox_mode` or treats it as advisory (HALT.md). This list is CLOSED and
 * SHRINK-ONLY: a new writing role never lands here (S6, T26); it is validated
 * against the live tool contract every time it is consulted
 * ({@link _deriveCodexSandboxModeFromTools}) and against the real
 * `agents/` roster by a dedicated test (`tests/codex-config.test.cjs` T24/T25)
 * so a stale or orphaned entry fails loudly instead of being silently
 * honored forever.
 *
 * `gsd-nyquist-auditor` is the 17th entry, added by the list-form `tools:`
 * parse fix (#3897 follow-up): its `tools:` frontmatter uses YAML block-list
 * form (`tools:` + indented `- Item` lines) and declares both Write and
 * Edit, but the original `extractToolsLine`/`extractFrontmatterField`
 * readers only ever saw the first list item (`- Read`) and derived
 * `read-only` by accident, not by design. {@link extractToolsValue} now
 * parses the list correctly, so this role genuinely derives
 * `workspace-write` from its tool contract — HALT.md's original 16-role
 * count measured against the pre-fix (single-line) readers and undercounted
 * this role. It is held here for the same reason as the other 16: pending
 * Codex's `sandbox_mode` enforcement decision, not because the derivation is
 * wrong.
 */
export const CODEX_SANDBOX_HOLDS: Readonly<Record<string, string>> = Object.freeze({
  'gsd-ai-researcher': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-code-fixer': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-code-reviewer': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-debug-session-manager': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-doc-classifier': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-doc-synthesizer': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-doc-verifier': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-doc-writer': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-dom-verifier': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-domain-researcher': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-eval-auditor': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-eval-planner': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-intel-updater': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-pattern-mapper': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-ui-auditor': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-ui-researcher': 'declares Write/Edit; pending Codex sandbox_mode enforcement decision',
  'gsd-nyquist-auditor': 'declares Write/Edit (YAML list-form tools:, surfaced by the list-form parse fix); pending Codex sandbox_mode enforcement decision',
});

// True iff a `tools:` frontmatter value declares Write or Edit as a whole
// token (never a substring match, so a hypothetical "Edith"-named tool could
// never collide). Single predicate owner for both the emitter
// ({@link _deriveCodexSandboxModeFromTools}) and the posture check
// (`agent-install-check.cts`'s `checkCodexSandboxPosture`, via
// {@link deriveCodexSandboxMode}).
//
// #3897 security review F5: a negation form — `All tools except Agent,
// Write, Edit` — used to derive `workspace-write` because the plain
// comma-tokenizer below saw the literal token `Write` and never noticed it
// was named as an EXCLUSION, not a grant. That is fail-OPEN: the value's
// stated meaning is "everything except these", so a `Write`/`Edit` name
// after `except` means the role does NOT get them. No shipped roster agent
// uses this form today, but a wrong answer here widens silently, so it is
// handled: once the literal word `except` (case-insensitive) appears
// anywhere in the value, this is a "<grant> except <exclusions>" statement
// and only the tokens AFTER `except` decide the verdict — `Write`/`Edit`
// declare broader iff `except` is ABSENT, or present but does not name them.
function _codexToolsDeclareWriteOrEdit(toolsRaw: string): boolean {
  const raw = String(toolsRaw || '');
  const exceptIndex = raw.search(/\bexcept\b/i);
  if (exceptIndex !== -1) {
    const exclusionsText = raw.slice(exceptIndex).replace(/^\S*\s*except\b/i, '');
    const exclusions = exclusionsText.split(',').map((t) => t.trim()).filter(Boolean);
    const excludesWriteOrEdit = exclusions.includes('Write') || exclusions.includes('Edit');
    return !excludesWriteOrEdit;
  }
  const tokens = raw.split(',').map((t) => t.trim());
  return tokens.includes('Write') || tokens.includes('Edit');
}

// #3897 security review F1/F3: control-character/whitespace class used by
// {@link normalizeSandboxIdentity} to trim more than plain ASCII whitespace
// from BOTH edges of a candidate identity before it is compared against the
// hold set. A bare .trim() only strips the ASCII whitespace \s already
// covers; the hold bypass this closes (a trailing space, \n/\r, or NBSP
// after `gsd-doc-writer`) is exactly a value that survives .trim() untouched.
// Spelled entirely as \u escapes (never a literal invisible codepoint in
// the source), matching this module's own BOM_CHAR convention above: NBSP
// (U+00A0), the zero-width space/non-joiner/joiner + LTR/RTL marks
// (U+200B-U+200F), the BOM/ZWNBSP (U+FEFF), and the full C0 control range
// + DEL (U+0000-U+001F, U+007F), alongside ASCII whitespace (\s).
const SANDBOX_IDENTITY_EDGE_RE = new RegExp(
  '^[\\s\\u0000-\\u001f\\u007f\\u00a0\\u200b-\\u200f\\ufeff]+' +
    '|[\\s\\u0000-\\u001f\\u007f\\u00a0\\u200b-\\u200f\\ufeff]+$',
  'g',
);

// Anything outside this set, AFTER normalization, is "suspicious" — see
// {@link isSandboxHeld}'s docblock for why fail-closed (never enumerate
// confusables) is the only tractable answer here.
const SANDBOX_IDENTITY_SUSPICIOUS_RE = /[^a-z0-9._-]/;

/**
 * Canonicalizes a single candidate sandbox-hold identity (a source filename
 * stem OR a frontmatter-derived `name:` value) into the same lowercase ASCII
 * shape {@link CODEX_SANDBOX_HOLDS}'s keys are written in, so both candidate
 * identities for one emitted artifact (see {@link isSandboxHeld}) can be
 * compared against the hold set on equal footing.
 *
 * #3897 security review F1/F3 — pipeline, in this exact order:
 *   1. basename it (strip through the LAST `/` or `\`) — a value carrying a
 *      path separator (`../agents/x`, `./x`) is reduced to its final segment
 *      before anything else runs, so a path-traversal-shaped candidate can
 *      never dodge the hold lookup by hiding behind a directory prefix.
 *   2. trim ASCII whitespace AND the NBSP/zero-width/control-char class
 *      ({@link SANDBOX_IDENTITY_EDGE_RE}) from both ends.
 *   3. strip trailing dots (`gsd-doc-writer.` collapses to the same key).
 *   4. `String.prototype.normalize('NFKC')` — canonicalizes compatibility
 *      variants (e.g. fullwidth `ｇ` U+FF47 folds to ASCII `g`) to their
 *      standard form so a widened-by-Unicode-lookalike name collapses onto
 *      the real held key instead of merely looking similar to it.
 *   5. lowercase — ASCII recasing already matched the hold set before this
 *      rung; this keeps that property after the above steps.
 *
 * Returns `null` (never throws) for a non-string input or when the fully
 * normalized result is empty, so callers can treat `null` as "not a real
 * identity, cannot be held, but see the `suspicious` companion signal".
 */
export function normalizeSandboxIdentity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  let value = lastSlash === -1 ? raw : raw.slice(lastSlash + 1);
  value = value.replace(SANDBOX_IDENTITY_EDGE_RE, '');
  value = value.replace(/\.+$/, '');
  value = value.normalize('NFKC');
  value = value.toLowerCase();
  return value === '' ? null : value;
}

/**
 * `held` is true iff ANY candidate identity, once normalized, names a real
 * {@link CODEX_SANDBOX_HOLDS} entry. `suspicious` is true iff any candidate,
 * after normalization, still contains a character outside `[a-z0-9._-]`.
 *
 * #3897 security review F1 (the blocker): the sandbox decision must be safe
 * for the ARTIFACT IT LANDS ON, not for whichever single identity happens to
 * be handy at the call site. `bin/install.js`'s emit loop has TWO candidate
 * identities for one `.toml` artifact — the source filename stem (what the
 * hold lookup used to be keyed on) and the frontmatter `name:` value (what
 * the OUTPUT PATH is actually keyed on) — and an attacker who controls
 * frontmatter can make them disagree (rename the file, or plant a sibling
 * file whose `name:` collides with a held role). Deciding over only one of
 * the two and applying the result to whichever path the OTHER one names is
 * exactly the regression this closes: this predicate takes every candidate
 * that can influence either the derivation or the emitted path and takes the
 * MOST RESTRICTIVE answer — `held` if any one of them is held.
 *
 * #3897 security review F3: `suspicious` is the fail-CLOSED half of this
 * predicate, and it is deliberately not an attempt to enumerate Unicode
 * confusables (Turkish dotted/dotless I, fullwidth forms, NFD combining
 * marks, ...). Every one of the 35 shipped roster files is pure ASCII
 * (`gsd-[a-z-]+`), so a non-ASCII-after-normalization identity cannot be a
 * legitimate shipped role — flagging it `suspicious` (which
 * {@link deriveCodexSandboxMode} turns into `read-only`) has zero false
 * positives against real content, and refuses to widen on anything this
 * module does not recognize instead of chasing an open-ended confusables
 * list that will always be one codepoint behind the next lookalike.
 */
export function isSandboxHeld(
  ...candidates: Array<string | string[] | null | undefined>
): { held: boolean; suspicious: boolean } {
  let held = false;
  let suspicious = false;
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      const normalized = normalizeSandboxIdentity(value);
      if (normalized === null) continue;
      if (Object.prototype.hasOwnProperty.call(CODEX_SANDBOX_HOLDS, normalized)) {
        held = true;
      }
      if (SANDBOX_IDENTITY_SUSPICIOUS_RE.test(normalized)) {
        suspicious = true;
      }
    }
  }
  return { held, suspicious };
}

// #3897 CAUSE A fix: a single-purpose `tools:`-VALUE reader, NOT a general
// frontmatter parser (`extractFrontmatterAndBody`/`extractFrontmatterField`
// were deliberately deleted from this module's ancestor — see the module
// header's "document model, not policy" charter). This module is the one
// genuinely side-effect-free leaf `agent-install-check.cts`'s
// `checkCodexSandboxPosture` already imports from for
// {@link deriveCodexSandboxMode}; giving it this reader too avoids importing
// `runtime-artifact-conversion.cjs` there just to pull one frontmatter field
// — that module's own dependency chain (`command-roster.cjs` →
// `scripts/fix-slash-commands.cjs`, a dev-only repo script) does not resolve
// from an installed tree, which is exactly what broke
// `tests/agent-install-check.test.cjs` against a synthetic install dir.
// Scoped to ONLY the `tools:` key: finds the leading `---`-delimited
// frontmatter block and returns its `tools:` value (quotes stripped), or
// `''` when there is no frontmatter block or no `tools:` key at all.
//
// #3897 rung 4/list-form fix: handles BOTH shapes a `tools:` key can take —
// (a) inline: `tools: Read, Write, Edit` on the same line as the key, and
// (b) YAML block-list form: `tools:` alone, followed by indented `- Item`
// lines (`agents/gsd-nyquist-auditor.md`, `agents/gsd-security-auditor.md`
// are the only two roster files using this shape today). The former
// implementation was a single `/^tools:\s*(.+)$/m` regex — `\s*` swallows the
// newline after a bare `tools:` key, so it silently matched into the FIRST
// list item's own line and returned just `"- Read"`, reading a real
// Write/Edit DECLARATION as an absence. List items are joined with `, ` so
// the result feeds {@link _codexToolsDeclareWriteOrEdit}'s comma-tokenizer
// unchanged. The list terminates at the first line that is not an indented
// `- Item` (a new frontmatter key, `---`, a blank line, or EOF) — it never
// grows into a general YAML parser (that boundary is deliberate, see above).
//
// #3897 security review F4: TOTAL for any input, not just a well-formed
// string — a Buffer, `undefined`, or `null` returns `undefined` rather than
// throwing on `.startsWith`, matching this module's "never throws" charter
// (see {@link deriveCodexSandboxMode}'s own totality note).
export function extractToolsValue(agentContent: unknown): string | undefined {
  if (typeof agentContent !== 'string') return undefined;
  if (!agentContent.startsWith('---')) return '';
  const endIndex = agentContent.indexOf('---', 3);
  if (endIndex === -1) return '';
  const frontmatter = agentContent.substring(3, endIndex);
  const lines = frontmatter.split(/\r?\n/);
  const toolsLineIndex = lines.findIndex((line) => /^tools:/.test(line));
  if (toolsLineIndex === -1) return '';
  const inlineMatch = lines[toolsLineIndex].match(/^tools:[ \t]*(\S.*)$/);
  if (inlineMatch) {
    return inlineMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }
  // Bare `tools:` key (nothing but optional trailing whitespace on its own
  // line) — read the YAML block-list form that follows: indented `- Item`
  // lines, one item per line, stopping at the first line that is not one.
  const items: string[] = [];
  for (let i = toolsLineIndex + 1; i < lines.length; i++) {
    const itemMatch = lines[i].match(/^[ \t]+-[ \t]*(.+)$/);
    if (!itemMatch) break;
    items.push(itemMatch[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return items.join(', ');
}

/**
 * The single owner of `sandbox_mode` derivation: `workspace-write` iff the
 * role's own frontmatter `tools:` declares Write/Edit, UNLESS the role is
 * held ({@link CODEX_SANDBOX_HOLDS}) at `read-only`.
 *
 * #3897 CAUSE C fix: this function is TOTAL — it never throws, for any
 * (identity, toolsValue) pair. It used to throw when a held role's CONTENT
 * (whatever the caller handed it) did not derive broader than its pin, on
 * the theory that a stale hold should "fail loudly at the point the
 * derivation runs". That reasoning does not survive contact with this
 * function's actual contract: it is a pure predicate over whatever content
 * the caller supplies, and tests legitimately pass synthetic fixtures for
 * held role names, so the throw fired on arbitrary input, not just the real
 * roster. It is also redundant even for real input — if a held role's
 * content does not derive broader, applying the hold pins `read-only` and
 * derivation would return `read-only` anyway; the hold is a no-op, so there
 * is nothing to fail about at derivation time. The STALENESS invariant (S4)
 * is a property of the real `agents/` roster, not of an arbitrary call's
 * input, so it belongs — and stays enforced — only at the roster level: see
 * {@link validateCodexSandboxHolds} and `tests/codex-config.test.cjs`
 * T24/T25, which assert it against the real roster directly.
 *
 * `agentName` here MUST be every identity the content's own frontmatter
 * could disagree with — i.e. the source `.md` FILENAME stem AND (when the
 * caller has one) the frontmatter-derived `name:` display value, passed
 * together as an array. Accepting only one of the two and applying the
 * result to an ARTIFACT keyed on the other is the #3897 security review F1
 * regression this function closes: `bin/install.js`'s emit loop decides
 * `sandbox_mode` for the filename stem but writes the `.toml` at a path keyed
 * on `name`, so a renamed file (stem drifts, `name:` stays pinned) or a
 * sibling file whose `name:` collides with a held role could make the two
 * identities disagree and land a held role's own artifact with
 * `workspace-write`. See {@link isSandboxHeld} for the most-restrictive-wins
 * rule across every candidate identity.
 *
 * `toolsRaw` is the already-resolved `tools:` frontmatter VALUE (e.g.
 * `"Read, Write, Edit"`), not the frontmatter block or the full agent
 * content — see {@link deriveCodexSandboxMode}'s doc for why.
 */
function _deriveCodexSandboxModeFromTools(agentName: string | string[] | null | undefined, toolsRaw: string): string {
  const derivesBroader = _codexToolsDeclareWriteOrEdit(toolsRaw || '');
  const { held, suspicious } = isSandboxHeld(agentName);
  if (held || suspicious) {
    // A held (or unrecognizable/"suspicious", per F3) identity always pins
    // read-only, whether or not its supplied content still derives broader
    // (see #3897 CAUSE C note above the docstring for this function's
    // caller-facing counterpart): if it no longer derives broader, the pin is
    // a no-op and there is nothing to fail about here — the staleness
    // invariant lives at the roster level instead
    // ({@link validateCodexSandboxHolds}).
    return 'read-only';
  }
  return derivesBroader ? 'workspace-write' : 'read-only';
}

/**
 * Exported form for external callers (`checkCodexSandboxPosture`,
 * `generateCodexAgentToml`). Takes the already-resolved `tools:` frontmatter
 * VALUE, not raw agent content or a frontmatter slice — this module does no
 * frontmatter parsing at all (there is no third copy of that extraction
 * here; see the module-header note above `CODEX_SANDBOX_HOLDS`). Both
 * callers already have (or can trivially get) `tools:` in hand via this
 * module's own {@link extractToolsValue} — the single shared extractor both
 * `bin/install.js`'s `generateCodexAgentToml` and `agent-install-check.cts`'s
 * `checkCodexSandboxPosture` route through (#3897 CAUSE A fix, and the
 * #3897 list-form parse fix's Fix 3: `bin/install.js` used to read `tools:`
 * via its own private `extractFrontmatterField`, a second single-line-only
 * copy that disagreed with this module's reader on YAML block-list form —
 * NOT `runtime-artifact-conversion.cts`'s general-purpose extractors either;
 * that module's dependency chain does not resolve from an installed tree) —
 * so this stays a pure predicate over data the caller already holds, never a
 * document reader.
 *
 * `agentName` is one or more HOLD-LOOKUP IDENTITIES: pass the agent's
 * canonical source filename stem (e.g. `gsd-doc-writer` for
 * `agents/gsd-doc-writer.md`) as a plain string for the single-identity call
 * sites this signature always supported, OR an array of every identity that
 * can influence the emitted artifact (filename stem AND frontmatter `name:`)
 * when the caller — like `bin/install.js`'s per-agent emit loop — has both
 * (see the F1 security note on {@link _deriveCodexSandboxModeFromTools}
 * above). TOTAL for any value here, including `undefined`, `null`, `[]`, and
 * an array containing non-string members — none of those throw; they simply
 * contribute nothing to the hold/suspicious check (see {@link isSandboxHeld}
 * / {@link normalizeSandboxIdentity}).
 */
export function deriveCodexSandboxMode(agentName: string | string[] | null | undefined, toolsRaw: string): string {
  return _deriveCodexSandboxModeFromTools(agentName, toolsRaw || '');
}

/**
 * (S5) Every {@link CODEX_SANDBOX_HOLDS} key must still name a real
 * `<agentsSrcDir>/<role>.md`. A hold for a role that no longer exists is
 * stale and must fail loudly, not be silently ignored — else the hold list
 * only ever grows/rots instead of shrinking to zero.
 *
 * NOT called from the install runtime path ({@link deriveCodexSandboxMode} /
 * `bin/install.js`'s `installCodexConfig`): the shrink-to-zero invariant it
 * checks is a REPO invariant about the canonical roster in `agents/`, not a
 * property of whatever directory an install happens to read from — a
 * partial/synthetic install source (a test fixture, a `--config-dir`
 * subset) legitimately contains only a few agents, and a hold whose role is
 * simply absent from THAT source dir must be inert, not fatal. The invariant
 * is enforced instead as a test over the real `agents/` roster
 * (`tests/codex-config.test.cjs` T24/T25). This function is kept, exported,
 * for any caller that specifically wants to validate the CANONICAL roster
 * (pass `agents/` itself, never an arbitrary install source).
 */
export function validateCodexSandboxHolds(agentsSrcDir: string): void {
  for (const role of Object.keys(CODEX_SANDBOX_HOLDS)) {
    const agentFile = path.join(agentsSrcDir, `${role}.md`);
    if (!fs.existsSync(agentFile)) {
      throw new Error(
        `CODEX_SANDBOX_HOLDS: stale hold for "${role}" — no ${agentFile} exists. The hold list is ` +
        'closed and shrink-only (ADR-3473 §8.3 / HALT.md); remove this entry.'
      );
    }
  }
}
