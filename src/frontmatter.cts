/**
 * Frontmatter — YAML frontmatter parsing, serialization, and CRUD commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/frontmatter.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
import { platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';
import { textEncodingError } from './validate.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;

// ─── Types ────────────────────────────────────────────────────────────────────

type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

// ─── Parsing engine ───────────────────────────────────────────────────────────

/**
 * Split a YAML inline array body on commas, respecting quoted strings.
 * e.g. '"a, b", c' → ['a, b', 'c']
 */
function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ',') {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

/**
 * How many parsed keys an unterminated region must yield before it is reported as a
 * truncated frontmatter rather than left alone as ordinary Markdown. See the rationale on
 * `extractFrontmatter`; exported for tests so the boundary is asserted against the constant
 * rather than a magic number duplicated in the suite.
 */
const UNTERMINATED_KEY_THRESHOLD = 2;

/**
 * Does every non-empty line of an unterminated region look like frontmatter?
 *
 * The key count alone cannot separate a truncated write from ordinary Markdown, because a
 * thematic break above a short labelled preamble parses as keys too:
 *
 *     ---
 *     Author: Jane Doe
 *     Reviewed-by: John Smith
 *
 *     Ordinary prose, and no second `---` anywhere.
 *
 * Raising the threshold only moves that boundary — two labelled lines are as common in prose as
 * one. What actually distinguishes the two is what follows: a write interrupted part-way through
 * a frontmatter block ends mid-block, so *every* line in the region is still frontmatter-shaped,
 * whereas a document merely opening with a rule goes on to prose. So the region must be
 * uniformly frontmatter-shaped AND carry enough keys to be worth reporting; either test alone
 * has a false-positive class the other closes.
 */
function isFrontmatterShaped(region: string): boolean {
  const lines = region.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((line) => (
    /^\s*[a-zA-Z0-9_-]+:/.test(line)   // key: value
    || /^\s*-\s+/.test(line)           // - list item
    || /^\s+\S/.test(line)             // indented continuation of a nested value
  ));
}

/**
 * Parse one already-delimited YAML region into a Frontmatter object.
 *
 * Extracted from `extractFrontmatter` (#1882) so the truncation probe below and the real
 * parse run the *same* parser. A second, simpler "does this look like YAML?" matcher would
 * be a parallel surface that drifts — exactly the generative-fix-divergence class.
 */
function parseYamlRegion(yaml: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  const lines = yaml.split(/\r?\n/);

  // Stack to track nested objects: [{obj, key, indent}]
  type StackEntry = { obj: Record<string, unknown> | unknown[]; key: string | null; indent: number };
  const stack: StackEntry[] = [{ obj: frontmatter, key: null, indent: -1 }];

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // Calculate indentation (number of leading spaces)
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Pop stack back to appropriate level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    // Check for key: value pattern
    const keyMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)/);
    if (keyMatch) {
      const key = keyMatch[2];
      const value = keyMatch[3].trim();

      if (value === '' || value === '[') {
        // Key with no value or opening bracket — could be nested object or array
        const newObj: Record<string, unknown> | unknown[] = value === '[' ? [] : {};
        (current.obj as Record<string, unknown>)[key] = newObj;
        current.key = null;
        // Push new context for potential nested content
        stack.push({ obj: newObj, key: null, indent });
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: key: [a, b, c] — quote-aware split (REG-04 fix)
        (current.obj as Record<string, unknown>)[key] = splitInlineArray(value.slice(1, -1));
        current.key = null;
      } else {
        // Simple key: value
        (current.obj as Record<string, unknown>)[key] = value.replace(/^["']|["']$/g, '');
        current.key = null;
      }
    } else if (line.trim().startsWith('- ')) {
      // Array item
      const itemValue = line.trim().slice(2).replace(/^["']|["']$/g, '');

      // If current context is an empty object, convert to array
      if (typeof current.obj === 'object' && !Array.isArray(current.obj) && Object.keys(current.obj).length === 0) {
        // Find the key in parent that points to this object and convert it
        const parent = stack.length > 1 ? stack[stack.length - 2] : null;
        if (parent) {
          for (const k of Object.keys(parent.obj)) {
            if ((parent.obj as Record<string, unknown>)[k] === current.obj) {
              (parent.obj as Record<string, unknown>)[k] = [itemValue];
              current.obj = (parent.obj as Record<string, unknown>)[k] as unknown[];
              break;
            }
          }
        }
      } else if (Array.isArray(current.obj)) {
        current.obj.push(itemValue);
      }
    }
  }

  return frontmatter;
}

/**
 * Extract frontmatter from a document.
 *
 * Returns `{}` when the document has no frontmatter — and, unchanged since #1882, also
 * returns `{}` when the frontmatter fence was opened and never closed. That return value is
 * deliberately preserved: ADR-1411's amendment requires the fallback to stay, because
 * changing it would break callers that treat "absent" and "unusable" identically. What #1882
 * adds is that the second case is no longer *silent*.
 *
 * The discriminator is the reason this is not simply "opened but never closed". A Markdown
 * document whose first line is a thematic break (`---`) takes that exact branch, so flagging
 * on the missing fence alone reports corruption on perfectly good Markdown. Instead the
 * unterminated region is run through this module's own parser and reported only when it
 * yields **two or more** keys.
 *
 * Two, not one, and the extra key is doing real work. A single `key: value` line is genuinely
 * ambiguous: `---` followed by `Note: this is a paragraph.` — or `Author:`, `TODO:`, `See:` —
 * is ordinary technical writing, a thematic break above a labelled line, and it parses as
 * exactly one key. There is no textual signal that separates it from a write interrupted
 * after its first key, so the threshold is set where the ambiguity ends. The cost is a false
 * negative on a file truncated after exactly one key; the benefit is silence on a very common
 * Markdown shape. That direction is deliberate and matches the choice already made at zero
 * keys: a false positive on valid Markdown is worse than a missed edge, because the
 * diagnostic is unconditional and cannot be turned off. Every GSD artefact this guards
 * (STATE.md, PLAN.md, ROADMAP.md, SUMMARY.md, agent/command docs) carries two or more
 * frontmatter keys, so the realistic interruption window stays covered.
 *
 * @param content Raw document text.
 * @param sourcePath Optional resolved path, used to name the file in the diagnostic and to
 *   key its deduplication. Optional because this function has 50-odd call sites and several
 *   hold only an in-memory string; those dedup on a content digest instead.
 */
function extractFrontmatter(content: string, sourcePath?: string): Frontmatter {
  // Match frontmatter only at byte 0 — a `---` block later in the document
  // body (YAML examples, horizontal rules) must never be treated as frontmatter.
  const headerEnd = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : -1;
  if (headerEnd === -1) return {};

  const closingLineStart = content.indexOf('\n---', headerEnd);
  if (closingLineStart === -1) {
    const region = content.slice(headerEnd);
    const probe = parseYamlRegion(region);
    if (Object.keys(probe).length >= UNTERMINATED_KEY_THRESHOLD && isFrontmatterShaped(region)) {
      warnUnusableInput({
        reason: UNUSABLE_REASON.FRONTMATTER_UNTERMINATED,
        source: sourcePath,
        content,
      });
    }
    return {};
  }

  const yamlEnd = content[closingLineStart - 1] === '\r' ? closingLineStart - 1 : closingLineStart;
  return parseYamlRegion(content.slice(headerEnd, yamlEnd));
}

/**
 * Escape a string for emission inside a YAML double-quoted scalar (#1779).
 * Backslash must be escaped first so the backslashes added for embedded quotes
 * (and control chars) are not themselves doubled. Without this, a value
 * carrying an indicator (`:`/`#`) that also contains a literal `"` serializes
 * to invalid YAML, e.g. `upstream: "https://x (Tom; "Git. Ship. Done")"`. A
 * literal newline/tab/control char inside the quotes likewise breaks (or
 * silently alters) the scalar, so those are escaped to their YAML forms too.
 */
function escapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    // Remaining C0 controls + DEL → \xHH (a valid YAML double-quoted escape).
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * A plain (unquoted) scalar that would mis-parse or round-trip lossily when
 * emitted bare must instead go through the double-quoted + escaped form
 * (#1779): the empty string (bare `k:` reloads as null), an embedded `"`/`\`
 * or control char, a leading YAML indicator (quote, `&`/`*`/`!` anchor/alias/
 * tag, `|`/`>` block scalar, flow `[]{},`, `#`, reserved `%`/`@`/backtick, or
 * `-`/`?`/`:` before a space), or leading/trailing whitespace. This helper is
 * the correctness complement of `escapeDoubleQuoted`: it broadens the *trigger*
 * for quoting without broadening the lossy object-list handling deferred to
 * #1572/#1660.
 */
function scalarNeedsDoubleQuoting(s: string): boolean {
  if (s === '') return true;
  if (/["\\\u0000-\u001f\u007f]/.test(s)) return true;
  // Always-unsafe leading indicators, or leading/trailing whitespace.
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) return true;
  // `-` `?` `:` only start a plain scalar safely when NOT followed by a space.
  if (/^[-?:](\s|$)/.test(s)) return true;
  return false;
}

function reconstructFrontmatter(obj: Frontmatter): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every(v => typeof v === 'string') && value.length <= 3 && (value).join(', ').length < 60) {
        lines.push(`${key}: [${(value).join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${typeof item === 'string' && (item.includes(':') || item.includes('#') || scalarNeedsDoubleQuoting(item)) ? `"${escapeDoubleQuoted(item)}"` : item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subkey, subval] of Object.entries(value)) {
        if (subval === null || subval === undefined) continue;
        if (Array.isArray(subval)) {
          if (subval.length === 0) {
            lines.push(`  ${subkey}: []`);
          } else if (subval.every((v: unknown) => typeof v === 'string') && subval.length <= 3 && (subval).join(', ').length < 60) {
            lines.push(`  ${subkey}: [${(subval).join(', ')}]`);
          } else {
            lines.push(`  ${subkey}:`);
            for (const item of subval) {
              lines.push(`    - ${typeof item === 'string' && (item.includes(':') || item.includes('#') || scalarNeedsDoubleQuoting(item)) ? `"${escapeDoubleQuoted(item)}"` : item}`);
            }
          }
        } else if (typeof subval === 'object') {
          lines.push(`  ${subkey}:`);
          for (const [subsubkey, subsubval] of Object.entries(subval as Record<string, unknown>)) {
            if (subsubval === null || subsubval === undefined) continue;
            if (Array.isArray(subsubval)) {
              if (subsubval.length === 0) {
                lines.push(`    ${subsubkey}: []`);
              } else {
                lines.push(`    ${subsubkey}:`);
                for (const item of subsubval) {
                  lines.push(`      - ${item}`);
                }
              }
            } else {
              // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions
              lines.push(`    ${subsubkey}: ${subsubval}`);
            }
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          const sv = String(subval);
          lines.push(`  ${subkey}: ${sv.includes(':') || sv.includes('#') || scalarNeedsDoubleQuoting(sv) ? `"${escapeDoubleQuoted(sv)}"` : sv}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{') || scalarNeedsDoubleQuoting(sv)) {
        lines.push(`${key}: "${escapeDoubleQuoted(sv)}"`);
      } else {
        lines.push(`${key}: ${sv}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Slice a frontmatter YAML body into per-top-level-key raw text segments. Each segment
 * runs from a column-0 `key:` line through the line before the next column-0 key (or the
 * end), capturing all nested indented content. Used by `spliceFrontmatter` for per-key
 * identity preservation (#1572): a structurally-unchanged key keeps its original raw
 * text, so the lossy `reconstructFrontmatter` never touches object-lists the caller did
 * not modify (e.g. must_haves.artifacts / .prohibitions).
 */
function sliceTopLevelFrontmatterSegments(yaml: string): Array<{ key: string; raw: string }> {
  const lines = yaml.split(/\r?\n/);
  const segments: Array<{ key: string; raw: string }> = [];
  let current: { key: string; raw: string[] } | null = null;
  for (const line of lines) {
    // A column-0 `key:` (no leading whitespace) starts a new top-level segment.
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      if (current) segments.push({ key: current.key, raw: current.raw.join('\n') });
      const keyName = (line.match(/^([A-Za-z0-9_-]+):/) as RegExpMatchArray)[1];
      current = { key: keyName, raw: [line] };
    } else if (current) {
      current.raw.push(line);
    }
    // Stray lines before the first top-level key (rare in frontmatter) are dropped.
  }
  if (current) segments.push({ key: current.key, raw: current.raw.join('\n') });
  return segments;
}

/**
 * Regenerate one frontmatter key's serialization, fail-closed if the lossy
 * `reconstructFrontmatter` cannot represent the value (#1572 codex review). Object-list
 * items (e.g. must_haves.artifacts `{path, provides}` maps) serialize as the literal
 * string "[object Object]"; rather than silently emit that and destroy the data, refuse
 * so the caller (cmdFrontmatterSet/Merge) errors out WITHOUT writing — directing the
 * user to edit the file directly. The reported #1572 case (mutating an UNRELATED field)
 * is unaffected: unchanged keys preserve their original raw text and never reach here.
 */
function regenerateFrontmatterKey(key: string, value: FrontmatterValue): string {
  const rendered = reconstructFrontmatter({ [key]: value });
  if (/\[object Object\]/.test(rendered)) {
    throw new Error(
      `frontmatter: cannot faithfully serialize key "${key}" — it contains a nested object-list ` +
        `(e.g. must_haves.artifacts) the frontmatter writer cannot represent, and serializing it would ` +
        `emit "[object Object]". Edit the file directly instead of using frontmatter set/merge.`,
    );
  }
  return rendered;
}

function spliceFrontmatter(content: string, newObj: Frontmatter): string {
  const match = content.match(/^---\r?\n[\s\S]+?\r?\n---/);
  if (match) {
    const fmBlock = match[0];

    // Whole-document no-op guard: a true no-op returns content verbatim (byte-exact,
    // including any formatting the lossy serializer would normalize).
    try {
      if (frontmatterDeepEqual(extractFrontmatter(content), newObj)) {
        return content;
      }
    } catch {
      /* fall through to regeneration on any comparison hiccup */
    }

    // Per-key identity preservation (#1572). `reconstructFrontmatter` is a deliberately
    // lossy serializer — it cannot faithfully re-emit nested object-list items (e.g.
    // must_haves.artifacts / .prohibitions, whose items are `{ path, provides }` /
    // `{ statement, status }` maps; `extractFrontmatter` flattens those to scalar
    // strings, so a round-trip drops `provides:` and collapses the list to a malformed
    // inline array). For any top-level key whose value is STRUCTURALLY UNCHANGED between
    // the original parse and `newObj`, preserve that key's ORIGINAL raw text verbatim;
    // regenerate only keys that actually changed. This generalizes the whole-document
    // no-op guard above to per-key fidelity, so mutating `wave` no longer destroys an
    // unrelated `must_haves` block. Keys absent from the original (genuinely new) are
    // regenerated and appended; keys absent from `newObj` are preserved (never silently
    // deleted by a set/merge).
    const fmLines = fmBlock.split(/\r?\n/);
    const inner = fmLines.slice(1, -1).join('\n'); // drop the opening `---` and closing `---`
    let originalParsed: Frontmatter;
    try { originalParsed = extractFrontmatter(fmBlock); } catch { originalParsed = {}; }

    const segments = sliceTopLevelFrontmatterSegments(inner);
    const emitted: string[] = [];
    const seen: Set<string> = new Set();

    for (const seg of segments) {
      seen.add(seg.key);
      if (Object.prototype.hasOwnProperty.call(newObj, seg.key)) {
        // Key is in newObj: preserve original raw text if structurally unchanged,
        // otherwise regenerate. The key SET is defined by newObj — keys that were in
        // the original but are absent from newObj are intentionally dropped (the real
        // cmdSet/cmdMerge flow always passes the full merged object, so this only
        // matters for direct unit callers and matches spliceFrontmatter's contract:
        // the result frontmatter IS newObj).
        if (frontmatterDeepEqual(newObj[seg.key], originalParsed[seg.key])) {
          emitted.push(seg.raw); // unchanged → preserve original raw text verbatim
        } else {
          emitted.push(regenerateFrontmatterKey(seg.key, newObj[seg.key])); // changed → regenerate (fail-closed on object-lists)
        }
      }
      // else: key absent from newObj → drop (not emitted).
    }
    // Append genuinely-new keys not present in the original frontmatter.
    for (const k of Object.keys(newObj)) {
      if (!seen.has(k)) {
        emitted.push(regenerateFrontmatterKey(k, newObj[k]));
      }
    }

    const yamlStr = emitted.join('\n');
    return `---\n${yamlStr}\n---` + content.slice(fmBlock.length);
  }
  // No existing frontmatter — generate from scratch, fail-closed on unrepresentable values.
  const yamlStr = reconstructFrontmatter(newObj);
  if (/\[object Object\]/.test(yamlStr)) {
    throw new Error(
      'frontmatter: cannot faithfully serialize the requested frontmatter — it contains a nested ' +
        'object-list (e.g. must_haves.artifacts) the writer cannot represent. Edit the file directly.',
    );
  }
  return `---\n${yamlStr}\n---\n\n` + content;
}

/**
 * Structural deep-equality for two parsed frontmatter objects. Order-sensitive for arrays
 * (YAML lists are ordered), key-order-insensitive for objects. Used only by `spliceFrontmatter`
 * to recognize a no-op write-back; intentionally narrow (handles the string / string[] /
 * nested-object shapes `extractFrontmatter` produces).
 */
function frontmatterDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => frontmatterDeepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao: Record<string, unknown> = a as Record<string, unknown>;
    const bo: Record<string, unknown> = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(bo, k) && frontmatterDeepEqual(ao[k], bo[k]),
    );
  }
  return false;
}

function parseMustHavesBlock(content: string, blockName: string): unknown[] {
  // Extract a specific block from must_haves in raw frontmatter YAML
  // Handles 3-level nesting: must_haves > artifacts/key_links > [{path, provides, ...}]
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return [];

  const yaml = fmMatch[1];

  // Find must_haves: first to detect its indentation level
  const mustHavesMatch = yaml.match(/^(\s*)must_haves:\s*$/m);
  if (!mustHavesMatch) return [];
  const mustHavesIndent = mustHavesMatch[1].length;

  // Find the block (e.g., "truths:", "artifacts:", "key_links:") under must_haves
  // It must be indented more than must_haves but we detect the actual indent dynamically
  const blockPattern = new RegExp(`^(\\s+)${blockName}:\\s*$`, 'm');
  const blockMatch = yaml.match(blockPattern);
  if (!blockMatch) return [];

  const blockIndent = blockMatch[1].length;
  // The block must be nested under must_haves (more indented)
  if (blockIndent <= mustHavesIndent) return [];

  // Find where the block starts in the yaml string
  const blockStart = yaml.indexOf(blockMatch[0]);
  if (blockStart === -1) return [];

  const afterBlock = yaml.slice(blockStart);
  const blockLines = afterBlock.split(/\r?\n/).slice(1); // skip the header line

  // List items are indented one level deeper than blockIndent
  // Continuation KVs are indented one level deeper than list items
  const items: unknown[] = [];
  let current: string | Record<string, unknown> | null = null;
  let listItemIndent = -1; // detected from first "- " line

  for (const line of blockLines) {
    // Skip empty lines
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    // Stop at same or lower indent level than the block header
    if (indent <= blockIndent && line.trim() !== '') break;

    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      // Detect list item indent from the first occurrence
      if (listItemIndent === -1) listItemIndent = indent;

      // Only treat as a top-level list item if at the expected indent
      if (indent === listItemIndent) {
        if (current) items.push(current);
        const afterDash = trimmed.slice(2);
        const trimmedAfterDash = afterDash.trim();
        // Check if it's a fully-quoted string (may contain ':' inside the quotes)
        if ((trimmedAfterDash.startsWith('"') && trimmedAfterDash.endsWith('"')) ||
            (trimmedAfterDash.startsWith("'") && trimmedAfterDash.endsWith("'"))) {
          current = trimmedAfterDash.slice(1, -1);
        // Check if it's a simple string item (no colon means not a key-value)
        } else if (!afterDash.includes(':')) {
          current = afterDash.replace(/^["']|["']$/g, '');
        } else {
          // Key-value on same line as dash: "- path: value"
          // YAML KV always has at least one space after the colon: "key: value"
          // Requiring \s+ rejects "Class::Method" and "db:seed" (no space after colon)
          const kvMatch = afterDash.match(/^(\w+):\s+"?([^"]*)"?\s*$/);
          if (kvMatch) {
            current = {};
            (current)[kvMatch[1]] = kvMatch[2];
          } else {
            // Looks like KV but doesn't match — treat as plain string (#2757)
            current = afterDash.replace(/^["']|["']$/g, '');
          }
        }
        continue;
      }
    }

    if (current && typeof current === 'object' && indent > listItemIndent) {
      // Continuation key-value or nested array item
      if (trimmed.startsWith('- ')) {
        // Array item under a key
        const arrVal = trimmed.slice(2).replace(/^["']|["']$/g, '');
        const keys = Object.keys(current);
        const lastKey = keys[keys.length - 1];
        if (lastKey && !Array.isArray((current)[lastKey])) {
          const existing = (current)[lastKey];
          (current)[lastKey] = existing ? [existing] : [];
        }
        if (lastKey) ((current)[lastKey] as unknown[]).push(arrVal);
      } else {
        const kvMatch = trimmed.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
        if (kvMatch) {
          // Trim: a quoted value like `"backstop "` captures the inner trailing space in group 2.
          // Left untrimmed, a hand-authored `must_haves` marker degrades (a `backstop` truth silently
          // grades green instead of abstaining — #1905, the #1154 false-pass; also the sibling
          // check_target/violationFixture path). Whitespace is never semantic in a scalar KV value.
          const val = kvMatch[2].trim();
          // Try to parse as number
          (current)[kvMatch[1]] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
        }
      }
    }
  }
  if (current) items.push(current);

  // Warn when must_haves block exists but parsed as empty -- likely YAML formatting issue.
  // This is a critical diagnostic: empty must_haves causes verification to silently degrade
  // to Option C (LLM-derived truths) instead of checking documented contracts.
  if (items.length === 0 && blockLines.length > 0) {
    const nonEmptyLines = blockLines.filter(l => l.trim() !== '').length;
    if (nonEmptyLines > 0) {
      process.stderr.write(
        `[gsd-tools] WARNING: must_haves.${blockName} block has ${nonEmptyLines} content lines but parsed 0 items. ` +
        `Possible YAML formatting issue — verification will fall back to LLM-derived truths.\n`
      );
    }
  }

  return items;
}

// ─── Frontmatter CRUD commands ────────────────────────────────────────────────

const FRONTMATTER_SCHEMAS: Record<string, { required: string[] }> = {
  plan: { required: ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'] },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

/**
 * Strip ALL frontmatter blocks from the start of `content`.
 *
 * Handles CRLF line endings and multiple stacked blocks (corruption
 * recovery): greedily strips consecutive `---...---` blocks separated by
 * optional whitespace, so a doubled/tripled frontmatter header (e.g. from a
 * botched merge) is fully removed, not just the first block.
 *
 * Canonical home for this primitive (#2143 audit dedup): previously
 * duplicated byte-identically in both `state.cts` and `state-transition.cts`.
 */
function stripFrontmatter(content: string): string {
  let result = content;
  while (true) {
    const stripped = result.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

function cmdFrontmatterGet(cwd: string, filePath: string, field: string | undefined, raw: boolean): void {
  if (!filePath) { error('file path required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  if (field) {
    const value = fm[field];
    if (value === undefined) { output({ error: 'Field not found', field }, raw, undefined); return; }
    output({ [field]: value }, raw, JSON.stringify(value));
  } else {
    output(fm, raw, undefined);
  }
}

function cmdFrontmatterSet(cwd: string, filePath: string, field: string | undefined, value: string | undefined, raw: boolean): void {
  if (!filePath || !field || value === undefined) { error('file, field, and value required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(value as string); } catch { parsedValue = value; }
  fm[field as string] = parsedValue as FrontmatterValue;
  const newContent = spliceFrontmatter(content, fm);
  // #1660: a no-op set (newContent unchanged) with a dict-valued field means the lossy
  // frontmatter parser made the new value's projection equal the original's — the change
  // did not apply (bites object-list fields like must_haves). Detection lives in the pure
  // exported helper noOpObjectListSetError so the mutation gate (property/unit set) covers
  // it — the cmd path itself is not in that set.
  const noOpErr = noOpObjectListSetError(content, newContent, parsedValue);
  if (noOpErr) {
    output({ error: noOpErr, field }, raw, undefined);
    return;
  }
  platformWriteSync(fullPath, newContent);
  output({ updated: true, field, value: parsedValue }, raw, 'true');
}

/**
 * #1660: detect a frontmatter `set` that would be a silent no-op on a dict-valued field.
 * Returns an error message when the splice produced no content change but the new value
 * is a dict (object-list fields like must_haves, whose `{path, provides}` items flatten to
 * scalar strings under extractFrontmatter so a replacement can deep-equal the original's
 * projection), else null. Scalars and scalar arrays round-trip faithfully, so idempotent
 * sets of those are intentionally NOT flagged. Pure and unit-tested directly (the cmd path
 * is not in Stryker's property/unit set, so the detection must be testable in isolation).
 */
function noOpObjectListSetError(originalContent: string, newContent: string, parsedValue: unknown): string | null {
  if (newContent !== originalContent) return null;
  if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) return null;
  return 'frontmatter set had no effect — the supplied value is equivalent to the existing field under the frontmatter parser, which cannot faithfully round-trip object-list fields like must_haves. Edit the file directly.';
}

function cmdFrontmatterMerge(cwd: string, filePath: string, data: string | undefined, raw: boolean): void {
  if (!filePath || !data) { error('file and data required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  let mergeData: Record<string, FrontmatterValue>;
  try { mergeData = JSON.parse(data as string) as Record<string, FrontmatterValue>; } catch { error('Invalid JSON for --data'); return; }
  Object.assign(fm, mergeData);
  const newContent = spliceFrontmatter(content, fm);
  platformWriteSync(fullPath, newContent);
  output({ merged: true, fields: Object.keys(mergeData) }, raw, 'true');
}

function cmdFrontmatterValidate(cwd: string, filePath: string, schemaName: string | undefined, raw: boolean): void {
  if (!filePath || !schemaName) { error('file and schema required'); }
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const schema = FRONTMATTER_SCHEMAS[schemaName as string];
  if (!schema) { error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  // #2701: fail loud on NUL/binary corruption before schema checks. A structurally
  // intact-but-NUL-corrupted file otherwise passes as valid:true and is then silently
  // skipped by recursive/binary-skipping searchers, reading downstream as "absent."
  const encErr = textEncodingError(content, filePath);
  if (encErr) { output({ valid: false, errors: [encErr], schema: schemaName }, raw, 'invalid'); return; }
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  const missing = schema.required.filter(f => fm[f] === undefined);
  const present = schema.required.filter(f => fm[f] !== undefined);
  output({ valid: missing.length === 0, missing, present, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

export = {
  extractFrontmatter,
  UNTERMINATED_KEY_THRESHOLD,
  // Additive alias (#644 prohibition-probe schema contract): the probe round-trip seam reads a
  // frontmatter object via `parseFrontmatter` (the name the contract test pins). It is the SAME
  // function as `extractFrontmatter` — a bare-object parse with no behavior change — exposed under
  // the alias so the prohibition schema round-trip and any future caller can use the canonical name.
  parseFrontmatter: extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  stripFrontmatter,
  noOpObjectListSetError,
  parseMustHavesBlock,
  FRONTMATTER_SCHEMAS,
  cmdFrontmatterGet,
  cmdFrontmatterSet,
  cmdFrontmatterMerge,
  cmdFrontmatterValidate,
};
