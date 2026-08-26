/**
 * Frontmatter — YAML frontmatter parsing, serialization, and CRUD commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/frontmatter.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 *
 * ADR-3473 §8.1 (#3881): the read path is no longer a hand-rolled line
 * scanner. `parseGuardedYamlRegion` now parses through the vendored `js-yaml`
 * (`./vendor/js-yaml.cjs`, verbatim `node_modules/js-yaml/dist/js-yaml.js`)
 * under `FAILSAFE_SCHEMA` + `json: true` — every scalar comes back a string
 * (today's contract, no adapter needed) and duplicate keys overwrite
 * (last-wins, the documented invariant). What js-yaml does NOT do —
 * anchors/alias refusal, the #3257 comment channel, the #1882 truncation
 * probe, null-byte preservation and object-list flattening for the existing
 * string-shaped value contract — is layered on top, in one place, below.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
import { platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';
import { textEncodingError } from './validate.cjs';
import { splitLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
import { load as yamlLoad, dump as yamlDump, FAILSAFE_SCHEMA, YAMLException } from './vendor/js-yaml.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

// ─── Parsing engine ───────────────────────────────────────────────────────────

/**
 * Base js-yaml options for every parse in this module (ADR-3473 §8.1 §3.1/§3.3).
 * `FAILSAFE_SCHEMA` resolves only `!!str`/`!!seq`/`!!map` — every scalar comes
 * back a string, which is today's contract and needs no coercion layer.
 * `json: true` makes duplicate keys overwrite (last-wins) instead of throwing,
 * which is the documented behavior `tests/fixtures/adversarial/frontmatter/
 * duplicate-keys.md` pins.
 */
const YAML_LOAD_OPTS = { schema: FAILSAFE_SCHEMA, json: true };

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
 * has a false-positive class the other closes. This heuristic is deliberately a raw-text scan,
 * independent of whichever parser counts the keys (see `countKeysBeforeTruncation`) — it is the
 * guard that keeps a stricter parser from turning "opens with a rule" into a false positive.
 */
function isFrontmatterShaped(region: string): boolean {
  const lines = splitLines(region).filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((line) => (
    /^\s*[a-zA-Z0-9_-]+:/.test(line)   // key: value
    || /^\s*-\s+/.test(line)           // - list item
    || /^\s+\S/.test(line)             // indented continuation of a nested value
  ));
}

/**
 * #3257: a Symbol-keyed channel that carries full-line (column-0 `#`) YAML
 * comments through a parse → reconstruct round-trip. Comments are otherwise
 * unrepresentable on the Frontmatter object (Record<string, ...>) and were
 * silently dropped by reconstructFrontmatter. The Symbol is invisible to
 * Object.entries / Object.keys / JSON.stringify / for-in, so every existing
 * reader is unchanged; only reconstructFrontmatter reads it. Leading comments
 * are attached to the top-level key that follows them; comments after the last
 * key go to `trailing`. Only set when a comment is actually seen, so comment-less
 * frontmatter parses byte-identically to before.
 */
const FULL_LINE_COMMENTS = Symbol('fullLineComments');
type FullLineCommentChannel = { leading: Record<string, string[]>; trailing: string[] };

/**
 * ADR-3473 §8.1 §0.3 (#3881, consequence 2): a Symbol-keyed marker carried on the `{}`
 * `extractFrontmatter` returns when the region failed to parse (malformed YAML, or a refused
 * anchor/alias/merge key — consequence 6). Mirrors `FULL_LINE_COMMENTS` exactly: invisible to
 * `Object.keys`/`Object.entries`/`JSON.stringify`/`for-in`, so the 70 call sites that never
 * inspect it are unaffected, while the 8 `hasFrontmatter = Object.keys(...).length > 0` sites
 * consult it to tell "genuinely empty" apart from "unparseable" and avoid reassembling the
 * document without its (unparsed but still present) frontmatter block. Those 8 call sites (7 in
 * `state-transition.cts` behind `isUnparseableFrontmatter`/`rawFrontmatterPrefix`, plus 1 more in
 * `state.cts`'s `cmdStateCompletePhase`) are wired on this branch — this module sets and exports
 * the marker; the callers consume it.
 */
const FRONTMATTER_UNPARSEABLE = Symbol('frontmatterUnparseable');

function unparseableResult(): Frontmatter {
  // Plain-prototype (post-remote-runner-fix, #3881): the PUBLIC parse surface must keep
  // handing callers ordinary `{}`-shaped objects — `assert.deepStrictEqual` compares
  // prototypes, and 50+ existing call sites/tests compare against object literals. The
  // Symbol marker is still attached via `Object.defineProperty` rather than bracket
  // assignment, which is what actually matters for prototype-pollution safety: a data
  // property named e.g. `__proto__` set through `defineProperty` never invokes the
  // inherited `Object.prototype.__proto__` accessor setter the way `fm[k] = v` would.
  const fm: Record<string, unknown> = {};
  Object.defineProperty(fm, FRONTMATTER_UNPARSEABLE, {
    value: true, writable: true, enumerable: true, configurable: true,
  });
  return fm as Frontmatter;
}

/**
 * Convert an internal, possibly null-prototype, YAML-derived value tree into an ordinary
 * plain-prototype tree for the public parse surface (post-remote-runner-fix, #3881).
 *
 * The internal construction (`normalizeParsedValue`, `restoreNullBytesDeep`,
 * `extractCommentChannel`) deliberately builds with `Object.create(null)` so a hostile key
 * like `__proto__`/`constructor`/`toString` is always a genuine own data property and never
 * resolves to (or overwrites) an inherited `Object.prototype` member WHILE THE TREE IS BEING
 * BUILT. That safety property has nothing to do with what prototype the FINAL object callers
 * receive — `assert.deepStrictEqual` compares prototypes, so handing back a null-prototype
 * object silently broke every caller comparing against `{}` object literals (57+ tests). This
 * walks the tree exactly once at the return boundary and re-homes every string/number-keyed
 * own property onto an ordinary `{}` via `Object.defineProperty` (never `out[k] = v`), which
 * is what keeps the copy itself safe: `defineProperty` always creates a real own data
 * property, even for a key literally named `__proto__`, and never triggers the inherited
 * setter the way bracket assignment would.
 *
 * The `FULL_LINE_COMMENTS` Symbol channel is copied across by reference, NOT recursed into —
 * it stays null-prototype. It is purely internal plumbing (only `reconstructFrontmatter` /
 * `propagateCommentChannel`, both in this module, ever read `channel.leading[key]` with an
 * arbitrary user-authored key), invisible to every external reader (`Object.keys` /
 * `Object.entries` / `JSON.stringify` / `for-in` all skip symbols), and re-plaining it would
 * reopen the exact `leading[key]` inherited-member bug the null prototype exists to close.
 */
function toPlainValueTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlainValueTree);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      Object.defineProperty(out, k, {
        value: toPlainValueTree((value as Record<string, unknown>)[k]),
        writable: true, enumerable: true, configurable: true,
      });
    }
    for (const s of Object.getOwnPropertySymbols(value)) {
      Object.defineProperty(out, s, {
        value: (value as Record<symbol, unknown>)[s], // internal channel: copied raw, not recursed
        writable: true, enumerable: true, configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 6, corrected post-#3881-review): `FAILSAFE_SCHEMA` still resolves
 * anchors, aliases and merge keys — that is core YAML mechanics, not tag resolution, so no
 * schema choice disables it. A hostile 7-line frontmatter (`&a [...]` fanned out through nested
 * aliases) expands to tens of megabytes in a few milliseconds, and `.planning/` documents are
 * user-authored, untrusted input. Corpus occurrences of anchors/aliases/merge keys today: zero,
 * so refusing them costs nothing.
 *
 * This was originally a raw-text line regex, and it was bypassable: a quoted key (`"a": &x 1`),
 * a flow mapping (`{b: &x 1, c: *x}`) or a flow sequence (`[&x "q", *x]`) all define/use an
 * anchor while never matching the "bareword key, then `&`/`*`" line shape the regex checked —
 * so the exact expansion this guard exists to stop went straight through unrefused. Detecting a
 * YAML anchor with a regex is re-implementing a YAML parser in order to guard a YAML parser; the
 * fix is to let the real parser report it instead of re-deriving anchor syntax by hand. js-yaml's
 * `load` accepts a `listener` invoked once per parse event with the parser's internal `State`;
 * `state.anchor` is non-null on every event belonging to an anchored node, in every spelling
 * above (verified by execution against all four), so throwing the instant it is set aborts the
 * parse before any alias expansion happens — the 303-byte quoted-key bomb refuses in ~1ms rather
 * than expanding to ~35MB. A `<<: *base` merge key is refused too, because it can only ever
 * reference a previously anchored node — the alias itself trips `state.anchor`. A merge key with
 * NO alias (`<<: {b: 1}`) carries no anchor and is not separately refused: under
 * `FAILSAFE_SCHEMA` (no `!!merge` type resolution) it never actually merges — it parses as an
 * ordinary literal `"<<"` string key with a normal, non-expanding nested map — so it carries none
 * of the resource-exhaustion risk this guard exists for.
 */
/** Thrown from inside the `listener` callback below; never surfaced past `refuseAnchorsAndAliases`. */
class AnchorDetectedSignal extends Error {}

function refuseAnchorsAndAliases(yaml: string): void {
  try {
    yamlLoad(yaml, {
      ...YAML_LOAD_OPTS,
      listener: (_event: string, state: { anchor?: string | null }) => {
        // Thrown FROM INSIDE the listener, not merely recorded and checked after `load`
        // returns: js-yaml keeps parsing (and, for an alias, keeps EXPANDING) past a listener
        // that only sets a flag, which reintroduces the exact resource-exhaustion window this
        // guard exists to close. Throwing here aborts the parse immediately, before any
        // expansion — the billion-laughs fixture refuses in ~1-2ms rather than building the
        // ~35MB tree first and discarding it.
        if (state.anchor !== null && state.anchor !== undefined) throw new AnchorDetectedSignal();
      },
    });
  } catch (e) {
    if (e instanceof AnchorDetectedSignal) {
      throw new YAMLException(
        'frontmatter: anchors, aliases and merge keys are refused (ADR-3473 §8.1)',
      );
    }
    // Any other failure (malformed YAML unrelated to anchors) is reported by the real parse
    // in parseGuardedYamlRegion; this pre-pass only exists to refuse anchors/aliases early.
  }
}

/**
 * ADR-3473 §8.1 (consequence 7): js-yaml rejects a literal U+0000 unconditionally, under every
 * schema. The fixture invariant (`null-byte-value.md`) is "preserve or normalize; never truncate
 * silently", so the byte is swapped for a private-use sentinel before the parse and restored in
 * every resulting string afterward — preserving the exact byte rather than normalizing it away.
 *
 * CORRECTED (post-#3881-review, finding 3): the round-trip was non-injective. `restoreNullBytesDeep`
 * rewrites EVERY U+E000 in the parsed tree back to U+0000 — including one the document author
 * legitimately wrote — so a document containing a literal U+E000 (with or without an actual NUL
 * elsewhere) came back corrupted: its own U+E000 silently became a NUL. Rather than pick a
 * "provably absent" sentinel (unprovable in general — any fixed codepoint can itself appear in
 * user-authored input), `refuseIfSentinelPresent` makes the substitution provably reversible by
 * refusing outright whenever the RAW region already contains U+E000, before any substitution
 * happens — consistent with this module's existing refusal path (anchors/aliases/merge keys) for
 * "cannot faithfully round-trip this input." Once refused, the sentinel is guaranteed absent from
 * the input the escape/restore pair actually operates on, and the substitution is injective by
 * construction.
 */
const NULL_BYTE_SENTINEL = String.fromCharCode(0xE000);

function refuseIfSentinelPresent(yaml: string): void {
  if (yaml.includes(NULL_BYTE_SENTINEL)) {
    throw new YAMLException(
      'frontmatter: contains the reserved null-byte-escape sentinel U+E000 — refused rather than ' +
        'silently corrupted on restore (ADR-3473 §8.1)',
    );
  }
}

function escapeNullBytesForParse(yaml: string): string {
  return yaml.indexOf('\u0000') === -1 ? yaml : yaml.split('\u0000').join(NULL_BYTE_SENTINEL);
}

function restoreNullBytesDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes(NULL_BYTE_SENTINEL) ? value.split(NULL_BYTE_SENTINEL).join('\u0000') : value;
  }
  if (Array.isArray(value)) return value.map(restoreNullBytesDeep);
  if (value && typeof value === 'object') {
    // Null-prototype (post-#3881-review, finding 3): an ordinary {} here silently DROPS a
    // top-level key literally named __proto__ -- out['__proto__'] = v on a normal object
    // invokes the inherited Object.prototype.__proto__ SETTER (reassigning the object's own
    // prototype) instead of creating a data property, so key: __proto__ in a document
    // vanishes from the parsed result with no error. Confirmed by execution: ---\n__proto__:
    // hello\nz: 1\n---\n parsed to {z: "1"}, silently dropping the __proto__ key entirely.
    // Object.create(null) has no such setter, so the assignment below is always a genuine
    // own data property, for every key including __proto__ itself.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const restoredKey = k.includes(NULL_BYTE_SENTINEL) ? k.split(NULL_BYTE_SENTINEL).join(String.fromCharCode(0)) : k;
      out[restoredKey] = restoreNullBytesDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 3): js-yaml resolves `- test: a b` (and the three other spellings
 * of the same value — `"a b"`, `'a b'`, `{test: a b}`) to ONE tree shape, `[{test: "a b"}]` —
 * unlike the legacy scanner, whose output was a function of the raw source line and therefore
 * produced four different strings for those four spellings (ADR-3473 40-design.md §0.1). No
 * adapter over a tree can recover a distinction the tree does not carry, so this renders a single
 * canonical string per object-list item instead, keeping the existing value SHAPE (an array of
 * strings) that `sliceTopLevelFrontmatterSegments`, the `[object Object]` guard and
 * `noOpObjectListSetError` all depend on. Choosing structured (non-string) values is fork (b) —
 * out of scope for this phase.
 */
function flattenScalarForDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(flattenScalarForDisplay).join(', ')}]`;
  if (typeof value === 'object') return flattenObjectListItem(value as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function flattenObjectListItem(item: Record<string, unknown>): string {
  return Object.entries(item)
    .map(([k, v]) => `${k}: ${flattenScalarForDisplay(v)}`)
    .join(', ');
}

/**
 * Recursively normalize a parsed js-yaml tree to this module's historical contract:
 *  - `null`/`undefined` in an object-value slot becomes `{}` (consequence 1 — matches the
 *    legacy scanner's empty-value handling exactly, so `reconstructFrontmatter` — which omits
 *    null-valued keys — still round-trips a bare `key:` line instead of deleting it);
 *  - `null`/`undefined` inside an array becomes `''` (arrays are always string[] in this
 *    module's contract);
 *  - a map or nested array found as an array ITEM is flattened to a canonical string
 *    (consequence 3);
 *  - every other scalar is already a string under `FAILSAFE_SCHEMA` and passes through.
 */
function normalizeParsedValue(value: unknown, inArray: boolean): unknown {
  if (value === null || value === undefined) return inArray ? '' : {};
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        return Array.isArray(item) ? flattenScalarForDisplay(item) : flattenObjectListItem(item as Record<string, unknown>);
      }
      return normalizeParsedValue(item, true);
    });
  }
  if (typeof value === 'object') {
    // Null-prototype (post-#3881-review, finding 3): a top-level YAML key named `constructor`,
    // `__proto__`, `toString`, `valueOf` or `hasOwnProperty` is ordinary user-authored input
    // (`.planning/` frontmatter), not an attack — but on an ordinary `{}` it resolves to the
    // inherited Object.prototype member instead of `undefined`, which crashes downstream
    // bracket reads (`commentChannel?.leading[key]`) and silently mis-answers `fm[field]`
    // lookups in `cmdFrontmatterGet`. `Object.create(null)` severs the prototype chain so every
    // reader of a parsed Frontmatter object gets a real bracket-read contract: present or
    // `undefined`, never an inherited function.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeParsedValue(v, false);
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 5): the #3257 comment scan used to key off the legacy parser's own
 * `[a-zA-Z0-9_-]+:` key regex — a Unicode key (e.g. `相:`) never matched it, so a comment above
 * one silently attached to the WRONG key once js-yaml owns the real (Unicode-inclusive) key set.
 * This attributes each pending column-0 comment block against js-yaml's own parsed top-level key
 * list, in document order, by matching the literal key text at column 0 rather than re-deriving a
 * key shape independently — so it can never disagree with what was actually parsed.
 */
function extractCommentChannel(yaml: string, orderedKeys: string[]): FullLineCommentChannel | undefined {
  const lines = splitLines(yaml);
  let pending: string[] = [];
  let channel: FullLineCommentChannel | undefined;
  let keyIdx = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^#/.test(line)) {
      pending.push(line);
      continue;
    }
    if (!/^\s/.test(line) && keyIdx < orderedKeys.length) {
      const key = orderedKeys[keyIdx];
      if (line.startsWith(`${key}:`) || line.startsWith(`"${key}"`) || line.startsWith(`'${key}'`)) {
        if (pending.length) {
          // Null-prototype `leading` (post-#3881-review, finding 3): `key` is an arbitrary
          // user-authored YAML key — `constructor`, `__proto__`, `toString`, `valueOf`,
          // `hasOwnProperty` all round-trip through here. On an ordinary `{}` those resolve
          // to inherited Object.prototype members, and `reconstructFrontmatter`'s
          // `commentChannel?.leading[key]` read then finds e.g. the `Object.prototype.toString`
          // FUNCTION instead of `undefined`, throwing when it is iterated as if it were an
          // array of comment strings.
          if (!channel) channel = { leading: Object.create(null) as Record<string, string[]>, trailing: [] };
          channel.leading[key] = pending;
          pending = [];
        }
        keyIdx++;
        continue;
      }
    }
    // A non-comment line that is not the next expected top-level key start: any comments
    // pending before it were not actually leading a key (malformed/unusual input) — drop
    // rather than misattach, matching the prior scan's "attach only when a key follows" shape.
    pending = [];
  }

  if (pending.length) {
    if (!channel) channel = { leading: Object.create(null) as Record<string, string[]>, trailing: [] };
    channel.trailing = pending;
  }
  return channel;
}

/**
 * Parse one already-delimited YAML region into a Frontmatter object, via the vendored js-yaml
 * (ADR-3473 §8.1). Throws (a `YAMLException`, or a plain `Error` from `refuseAnchorsAndAliases`)
 * on anything js-yaml itself cannot parse or that this module refuses outright; callers decide
 * whether to surface that as `unparseableResult()` or use it as a truncation signal.
 *
 * Renamed from `parseYamlRegion` (post-#3881-review, finding 2): §8.1 says `parseYamlRegion` is
 * "deleted, not patched" — the hand-rolled line scanner that name identified IS gone, but the
 * name itself survived on a new function with two callers (`extractFrontmatter` and
 * `countKeysBeforeTruncation`) that could not be inlined without duplicating the
 * refusal/null-byte/comment-channel glue below. Renaming closes that gap literally: nothing in
 * this module still answers to the old hand-rolled scanner's name.
 */
/**
 * Post-remote-runner-fix (#3881): the legacy hand-rolled scanner captured a top-level line's
 * value with a plain `(.*)` regex group — any text after the FIRST `key:` was accepted
 * verbatim, colons and all (`title: a: b` parsed to `{title: "a: b"}`). Real YAML has no such
 * leniency: a colon followed by whitespace inside an unquoted scalar is core block-mapping
 * syntax (it opens a nested key), so `last_activity: 2026-06-08: reviewed the PR queue` is
 * genuinely ambiguous/invalid YAML and js-yaml throws ("bad indentation of a mapping entry")
 * on the WHOLE region — not just that one value. That is a real, common shape: hand-edited
 * STATE.md files that skip the template's em-dash separator and use a plain colon instead
 * (#2571). Before this fix the entire frontmatter block came back `unparseableResult()` for
 * one ordinary, non-hostile line — total data loss for every OTHER key in the block too.
 *
 * This is a FALLBACK-ONLY retry, never the primary path: the unmodified `yaml` is tried first,
 * and this repair only runs when that attempt already threw. A well-formed (or genuinely
 * malformed-for-other-reasons) document is completely unaffected — zero behavior change, zero
 * added parse cost, on every document that already parses. Only a document that parses
 * SPECIFICALLY because of this repair benefits; if the repaired text still fails to parse, the
 * repair is a no-op and the original error is what callers see (never silently swallowed).
 */
function loadWithAmbiguousColonRepair(yaml: string): unknown {
  try {
    return yamlLoad(yaml, YAML_LOAD_OPTS);
  } catch (e) {
    for (const repair of [repairAmbiguousColonValues, repairMalformedInlineArrays]) {
      const repaired = repair(yaml);
      if (repaired === yaml) continue; // this repair found nothing to change
      try {
        return yamlLoad(repaired, YAML_LOAD_OPTS);
      } catch {
        continue; // still invalid (possibly for another reason) — try the next repair
      }
    }
    throw e; // no repair helped — surface the original error
  }
}

/**
 * Post-remote-runner-fix (#3881): the legacy hand-rolled scanner's inline-array handling
 * (`splitInlineArray`) was a tolerant, quote-aware comma-split over whatever sat between a
 * literal `[` and `]` on one line — consecutive commas and whitespace-only items were silently
 * filtered (`[a,,b]` -> `['a','b']`, `[ , ]` -> `[]`), and a `[` with nothing else on the line
 * was treated exactly like an empty value: an open nested context, populated by any `- item`
 * block-sequence lines that followed, or left an empty array if none did. A real YAML flow
 * sequence has none of that leniency — `[a,,b]` is a syntax error (empty flow-sequence entry),
 * and an unclosed `[` is an unterminated collection — so js-yaml throws on all four shapes,
 * where the legacy scanner silently recovered. This restores that recovery, scoped to exactly
 * the two shapes it covered: a single-line `key: [...]` (repaired into a well-formed, re-
 * parseable flow sequence with empty items dropped) and a bare unclosed `key: [` (rewritten to
 * either `key:` — so a following block-sequence parses normally — or `key: []` when nothing
 * follows, preserving the ARRAY-typed empty result the literal `[` signaled, as distinct from
 * the empty-OBJECT contract of a bare `key:` line with no bracket at all).
 */
function repairMalformedInlineArrays(yaml: string): string {
  const lines = splitLines(yaml);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+):\s*\[(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    const [, key, afterBracket] = m;
    const closeIdx = afterBracket.indexOf(']');
    if (closeIdx !== -1) {
      const inner = afterBracket.slice(0, closeIdx);
      const trailing = afterBracket.slice(closeIdx + 1);
      const items = splitLegacyInlineArrayItems(inner).map((it) =>
        /[,:#[\]{}]/.test(it) || /^\s|\s$/.test(it) ? `"${it.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : it,
      );
      out.push(`${key}: [${items.join(', ')}]${trailing}`);
      continue;
    }
    if (afterBracket.trim() === '') {
      const next = lines[i + 1];
      out.push(next !== undefined && /^\s+-\s/.test(next) ? `${key}:` : `${key}: []`);
      continue;
    }
    out.push(line); // an unrecognized shape this repair doesn't claim to fix
  }
  return out.join('\n');
}

/** Quote-aware comma split mirroring the legacy scanner's `splitInlineArray`: an item may be
 * wrapped in matching quotes (a comma inside stays part of the item), otherwise split on bare
 * commas. Empty / whitespace-only items are filtered — the exact "consecutive commas" /
 * "whitespace-only items" tolerance the legacy scanner pinned.
 */
function splitLegacyInlineArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { items.push(current); current = ''; continue; }
    current += ch;
  }
  items.push(current);
  return items
    .map((it) => it.trim().replace(/^["']|["']$/g, ''))
    .filter((it) => it !== '');
}

/**
 * Double-quote (and escape) any column-0 `key: value` line whose (single-line) value contains
 * an unquoted colon+whitespace or a trailing bare colon — the exact shape that reads as an
 * ambiguous nested mapping key to a real YAML parser. Lines that are already safely quoted or
 * open a flow/block collection (`"`, `'`, `[`, `{`) are left untouched (js-yaml already handles
 * those); an empty value (`key:` alone, opening a nested block) is left untouched too, since
 * repairing it would change a legitimate nested-map opener into a scalar. Only column-0 lines
 * are considered — an indented line is either already-valid nested content or a genuinely
 * different malformation this repair does not claim to fix.
 */
function repairAmbiguousColonValues(yaml: string): string {
  return splitLines(yaml)
    .map((line) => {
      const m = /^([A-Za-z0-9_][A-Za-z0-9_-]*):[ \t](.+)$/.exec(line);
      if (!m) return line;
      const [, key, value] = m;
      if (/^["'[{]/.test(value)) return line; // already safely quoted/collection-opened
      if (!/:(?:[ \t]|$)/.test(value)) return line; // no ambiguous colon in the value
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join('\n');
}

function parseGuardedYamlRegion(yaml: string): Frontmatter {
  refuseAnchorsAndAliases(yaml);
  refuseIfSentinelPresent(yaml);
  const escaped = escapeNullBytesForParse(yaml);
  const raw: unknown = loadWithAmbiguousColonRepair(escaped);
  const normalized = normalizeParsedValue(raw, false);
  const root: Record<string, unknown> =
    normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? (normalized as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const restored = restoreNullBytesDeep(root) as Frontmatter;

  const commentChannel = extractCommentChannel(yaml, Object.keys(restored));
  if (commentChannel) {
    (restored as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] = commentChannel;
  }
  // Plain-prototype at the public-surface boundary (post-remote-runner-fix, #3881): see
  // `toPlainValueTree`'s docblock. Everything above this line stays null-prototype internally.
  return toPlainValueTree(restored) as Frontmatter;
}

/**
 * ADR-3473 §8.1 (consequence 4): the #1882 truncation probe used to run the SAME parser
 * (`parseGuardedYamlRegion`) over an unterminated region and count its keys — deliberately, so a second
 * "does this look like YAML?" matcher could never drift from the real parser. js-yaml is stricter
 * than the old scanner, though: the dominant real truncation shape (fence opened, well-formed
 * keys, then the document body follows with no closing fence) is *invalid* YAML — a plain-text
 * paragraph at column 0 right after a block mapping raises `bad indentation of a mapping entry`
 * — so a naive "parse the whole region, count keys on success" port yields 0 keys and goes
 * silent on exactly the case #1882 exists for.
 *
 * CORRECTED (post-#3881-review, finding 5): the original recovery — re-parse ONLY the exact
 * prefix named by `e.mark.line` — regressed on every realistic truncation shape actually
 * checked by execution: an unquoted-colon value (`title: a: b`) and a mis-indented sibling
 * key (`  plan: 2`) both raise "bad indentation of a mapping entry" ON the offending line
 * itself, so `mark.line` names that SAME line and slicing BEFORE it drops the offending
 * line's own key entirely — undercounting by exactly the key the probe most needs to see. An
 * open flow collection (`list: [a, b`) raises its error on the (nonexistent) line AFTER the
 * region's end, so the "marked prefix" still contains the same unterminated `[` and the retry
 * parse fails too, falling through to a hard `0`. And a refused anchor/alias/merge key throws
 * a mark-LESS `YAMLException` (`refuseAnchorsAndAliases`, thrown from inside the parse
 * `listener` before js-yaml attaches position info) — the `e.mark` guard was never entered at
 * all, hard `0` again, even though every other key in the region is perfectly valid.
 *
 * A first fix attempt tried shrinking the region line-by-line and re-parsing through the SAME
 * real parser only — still no second matcher. It did NOT recover any of the three shapes above:
 * the offending line in the first two IS the malformed token, at every possible prefix boundary
 * that includes it, so no amount of shrinking ever makes it parse; the only prefix that ever
 * succeeds is the one line BEFORE it, i.e. exactly the original bug's undercount. A parser-only
 * strategy cannot report a key whose own line is genuinely invalid YAML — the same limitation
 * that made the mark-based recovery fail in the first place. This means "the one real parser,
 * never a hand-rolled matcher" is unreachable for the truncation-probe's actual job (a lower-
 * bound COUNT of what looks like a key line, not a validity judgment) — this file already
 * accepts an independent raw-text matcher for the adjacent question of "is this shaped like
 * frontmatter" (`isFrontmatterShaped`, used by this probe's only caller), so `countKeysBeforeTruncation`
 * takes the MAX of two lower bounds: how many keys the real parser can recover from the longest
 * parseable line-prefix (still the primary signal — correct on the dominant fence-then-prose
 * shape, and on any prefix boundary that genuinely IS the truncation point), and how many
 * column-0 `key:`-shaped lines the raw text contains (recovers the three regressed shapes,
 * whose offending key line the parser can never count). Neither alone is sufficient; together
 * they never under-report a key that either signal can see.
 */
function countKeysBeforeTruncation(region: string): number {
  const parsed = parsedKeyCount(region);
  const textual = countTopLevelKeyShapedLines(region);
  return Math.max(parsed, textual);
}

/** How many keys the real parser recovers from the longest line-prefix of `region` that parses
 * cleanly (the whole region itself, when it parses outright). Bounded to at most `region`'s own
 * line count re-parses — no worse than the whole-region parse already paid for on the caller's
 * unterminated-region path, which is itself bounded by ordinary `.planning/` document sizes (the
 * huge-bounded fixture parses successfully on the FIRST try and never reaches the shrink loop).
 */
function parsedKeyCount(region: string): number {
  try {
    return Object.keys(parseGuardedYamlRegion(region)).length;
  } catch {
    const lines = splitLines(region);
    for (let n = lines.length - 1; n >= 1; n--) {
      const prefix = lines.slice(0, n).join('\n');
      if (prefix.trim() === '') continue;
      try {
        return Object.keys(parseGuardedYamlRegion(prefix)).length;
      } catch {
        continue;
      }
    }
    return 0;
  }
}

/** How many `key:`-shaped lines `region` textually contains — the raw-text lower bound that
 * recovers a key whose OWN line is malformed YAML (an unquoted colon in the value, or a
 * mis-indented sibling that reads as an "indented continuation" to the real parser), which no
 * re-parse of any prefix can ever count (see `countKeysBeforeTruncation`'s docblock). Matches
 * ANY indentation, not only column 0 — the mis-indented-sibling shape is, by construction, a key
 * the author intended as top-level but indented by mistake; requiring column 0 here would just
 * relocate the exact undercount finding 5 reports. Deliberately the SAME key-shape pattern this
 * file already uses for the sibling shape check (`isFrontmatterShaped`'s first branch) — ASCII-
 * only is an accepted, precedented scope limit for this raw-text heuristic, not a new one.
 */
function countTopLevelKeyShapedLines(region: string): number {
  return splitLines(region).filter((line) => /^\s*[A-Za-z0-9_-]+:/.test(line)).length;
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
 * unterminated region's key count (see `countKeysBeforeTruncation`) is reported only when it
 * yields **two or more** keys AND the region is uniformly frontmatter-shaped raw text
 * (`isFrontmatterShaped`).
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
 * A closed region that js-yaml itself cannot parse (malformed YAML, or a refused
 * anchor/alias/merge key — ADR-3473 §8.1 consequence 6) returns `{}` carrying the
 * `FRONTMATTER_UNPARSEABLE` Symbol (consequence 2) rather than a bare, indistinguishable `{}`.
 *
 * @param content Raw document text.
 * @param sourcePath Optional resolved path, used to name the file in the diagnostic and to
 *   key its deduplication. Optional because this function has 50-odd call sites and several
 *   hold only an in-memory string; those dedup on a content digest instead.
 */
function extractFrontmatter(content: string, sourcePath?: string): Frontmatter {
  // #2977: tolerate a single leading UTF-8 BOM (U+FEFF), which Windows tooling
  // (PowerShell `>`/`Out-File` on PS 5.1, several editors) writes by default. Without this
  // strip, the byte-0 `startsWith('---')` fence check below fails on the BOM and the whole
  // parse collapses to {} — every frontmatter field silently disappears, and the engine
  // proceeds as though the file had no frontmatter at all. The BOM is a single codepoint;
  // stripping it here restores byte-0 alignment so the rest of the function is unchanged.
  // Scope: BOM only. Arbitrary non-BOM content before the fence (leading whitespace/blank
  // line/comment) is a separate product-intent decision (tolerate vs diagnose) left to a
  // future change — this fix does not broaden the byte-0 fence rule beyond the BOM.
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  // Match frontmatter only at byte 0 — a `---` block later in the document
  // body (YAML examples, horizontal rules) must never be treated as frontmatter.
  const headerEnd = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : -1;
  if (headerEnd === -1) return {};

  const closingLineStart = content.indexOf('\n---', headerEnd);
  if (closingLineStart === -1) {
    const region = content.slice(headerEnd);
    const keyCount = countKeysBeforeTruncation(region);
    if (keyCount >= UNTERMINATED_KEY_THRESHOLD && isFrontmatterShaped(region)) {
      warnUnusableInput({
        reason: UNUSABLE_REASON.FRONTMATTER_UNTERMINATED,
        source: sourcePath,
        content,
      });
    }
    return {};
  }

  const yamlEnd = content[closingLineStart - 1] === '\r' ? closingLineStart - 1 : closingLineStart;
  const region = content.slice(headerEnd, yamlEnd);
  try {
    return parseGuardedYamlRegion(region);
  } catch {
    return unparseableResult();
  }
}

/**
 * Escape a string for emission inside a YAML double-quoted scalar (#1779). ADR-3473 §8.1
 * (#3881): routed through the vendored js-yaml's `dump()` (forced double-quoted style) rather
 * than a hand-rolled character-class replace chain, so the writer shares the same escaping
 * engine the reader now uses. js-yaml emits control-char escapes as uppercase hex (`\x1F`);
 * this repo has emitted lowercase (`\x1f`) since #1779, so the hex digits are lowercased after
 * dump to keep serialized output byte-stable across the migration FOR THE CASES the old
 * hand-rolled chain actually covered (backslash/quote/newline/tab/CR, and every C0 control
 * plus DEL via \xHH). It is NOT byte-stable end-to-end (post-#3881-review, finding 4,
 * verified by execution): the old chain left BEL/NUL unescaped-as-hex (`\x07`/`\x00`) and
 * left NEL/NBSP/LINE SEPARATOR/PARAGRAPH SEPARATOR/BOM as raw literal bytes entirely (they
 * fall outside its `\u0000-\u001f\u007f` class); js-yaml's dump instead emits the YAML-named
 * escapes `\a`/`\0`/`\N`/`\_`/`\L`/`\P` for those six, and a `\uXXXX` escape for the BOM and
 * any lone UTF-16 surrogate. The serialized TEXT differs from pre-migration output for these
 * codepoints, but the round-trip is equivalence-preserving, not merely byte-preserving: every
 * one of `\a`/`\0`/`\N`/`\_`/`\L`/`\P`/`\uXXXX` is a YAML double-quoted-scalar escape that
 * resolves back to the EXACT source codepoint on re-parse (confirmed by execution — see
 * `tests/frontmatter.unit.test.cjs`'s pinned cases). scalarNeedsDoubleQuoting was extended in
 * the same review round to also route lone surrogates through this quoted+escaped path,
 * because they were previously emitted bare and produced genuinely UNPARSEABLE YAML.
 *
 * Renamed from `escapeDoubleQuoted` (post-#3881-review, finding 2): §8.1 says this function is
 * "deleted, not patched" — like `parseGuardedYamlRegion`, the hand-rolled character-class chain
 * is gone, but unlike that function this one HAS no other caller inside this module to hide the
 * old name's survival behind, so the rename is a straight mechanical propagation to its three
 * call sites (`reconstructFrontmatter` here, plus `commands.cts` and
 * `runtime-artifact-conversion.cts`, both updated in this change — no ADR amendment needed).
 */
function escapeDoubleQuotedScalar(s: string): string {
  const dumped = yamlDump(s, { schema: FAILSAFE_SCHEMA, forceQuotes: true, quotingType: '"', lineWidth: -1 });
  const withoutTrailingNewline = dumped.endsWith('\n') ? dumped.slice(0, -1) : dumped;
  const interior = withoutTrailingNewline.slice(1, -1); // strip the outer double-quote pair
  return interior.replace(/\\x([0-9A-Fa-f]{2})/g, (_m, hex: string) => `\\x${hex.toLowerCase()}`);
}

/**
 * A plain (unquoted) scalar that would mis-parse or round-trip lossily when
 * emitted bare must instead go through the double-quoted + escaped form
 * (#1779): the empty string (bare `k:` reloads as null), an embedded `"`/`\`
 * or control char, a leading YAML indicator (quote, `&`/`*`/`!` anchor/alias/
 * tag, `|`/`>` block scalar, flow `[]{},`, `#`, reserved `%`/`@`/backtick, or
 * `-`/`?`/`:` before a space), or leading/trailing whitespace. This helper is
 * the correctness complement of `escapeDoubleQuotedScalar`: it broadens the *trigger*
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
  // Post-#3881-review, finding 4 (found while verifying escapeDoubleQuotedScalar's byte-
  // stability claim): an unpaired UTF-16 surrogate (U+D800-U+DFFF) is outside YAML's
  // printable-character set, so js-yaml's loader refuses it ("the stream contains
  // non-printable characters") the instant it is emitted bare. No other trigger above
  // catches it -- not whitespace, not a C0/C1 control, not a leading indicator -- so a bare
  // emission was genuinely invalid YAML: reconstructFrontmatter produced text
  // extractFrontmatter could not re-parse, silently collapsing to {} via
  // unparseableResult(). Confirmed by execution: reconstructFrontmatter({weird: '\uD800'})
  // round-tripped to undefined before this fix. Routing it through the quoted +
  // escapeDoubleQuotedScalar path (which already emits the \uD800 escape) fixes the
  // round-trip.
  if (/[\uD800-\uDFFF]/.test(s)) return true;
  return false;
}

/**
 * #3706 — Does this value need double-quoting when written as an AGENT
 * frontmatter scalar (`model:`, `variant:`)?
 *
 * Deliberately a superset of `scalarNeedsDoubleQuoting` rather than a second,
 * competing predicate: that one answers "can this open a plain scalar safely",
 * which is necessary but not sufficient for a value that must ROUND-TRIP as the
 * exact string it went in as. Keeping both here is the point — they are two
 * answers to one question and drift the moment they live apart.
 *
 * The extra clauses, each an observed mis-parse rather than a precaution:
 *
 *   - a non-alphanumeric first character. `scalarNeedsDoubleQuoting` rejects the
 *     indicators that cannot OPEN a scalar, but YAML still resolves plenty of
 *     values that open legally: `~` and `.inf`/`.nan` become null and floats,
 *     and a leading sign or dot (`+1`, `-0`, `.5`) becomes a number. Requiring
 *     alphanumeric-first covers that whole family at once, and costs nothing:
 *     every real model ID and effort level starts alphanumeric.
 *   - a trailing `:` — `model: foo:` is read as a nested mapping key and fails
 *     the whole frontmatter with "bad indentation of a mapping entry".
 *   - a boolean/null word — YAML 1.1 readers resolve `no`/`y`/`off`/`null` to
 *     non-strings, so a variant named `no` arrives as `false`.
 *   - a numeric-looking value, including the YAML 1.1 sexagesimal form: `12:30`
 *     resolves to the integer 750, and `:` is legal mid-identifier here.
 *   - a date. `2026-08-25` starts alphanumeric and survives every clause above,
 *     yet YAML resolves it to a Date object rather than a string.
 */
const YAML_WORD_SCALAR_RE = /^(?:y|n|yes|no|true|false|on|off|null)$/i;
const YAML_NUMERIC_RE = /^(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?)$/;
// YAML 1.1 timestamp: a bare ymd, optionally followed by a time part.
const YAML_TIMESTAMP_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ].*)?$/;

function agentScalarNeedsDoubleQuoting(s: string): boolean {
  if (scalarNeedsDoubleQuoting(s)) return true;
  if (!/^[A-Za-z0-9]/.test(s)) return true;
  // A plain scalar ENDS at `: ` or ` #` wherever they appear — the base
  // predicate only inspects the first character, because its question is
  // whether the scalar can legally open. `a: b` makes the line a nested
  // mapping (a parse error at this indent) and `a #b` silently truncates to
  // `a`. Both were found by the round-trip property, not by inspection.
  if (/:\s/.test(s) || /\s#/.test(s)) return true;
  if (s.endsWith(':')) return true;
  if (YAML_WORD_SCALAR_RE.test(s)) return true;
  if (YAML_NUMERIC_RE.test(s)) return true;
  if (YAML_TIMESTAMP_RE.test(s)) return true;
  return false;
}

function reconstructFrontmatter(obj: Frontmatter): string {
  const lines: string[] = [];
  // #3257: read the full-line-comment channel (set by parseGuardedYamlRegion when comments
  // were present). Object.entries skips the Symbol key, so the data loop is unchanged.
  const commentChannel = (obj as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] as FullLineCommentChannel | undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    // #3257: re-emit this key's leading full-line comments before the key itself.
    const leading = commentChannel?.leading[key];
    if (leading) for (const c of leading) lines.push(c);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every(v => typeof v === 'string') && value.length <= 3 && (value).join(', ').length < 60) {
        lines.push(`${key}: [${(value).join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${typeof item === 'string' && (item.includes(':') || item.includes('#') || scalarNeedsDoubleQuoting(item)) ? `"${escapeDoubleQuotedScalar(item)}"` : item}`);
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
              lines.push(`    - ${typeof item === 'string' && (item.includes(':') || item.includes('#') || scalarNeedsDoubleQuoting(item)) ? `"${escapeDoubleQuotedScalar(item)}"` : item}`);
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
          lines.push(`  ${subkey}: ${sv.includes(':') || sv.includes('#') || scalarNeedsDoubleQuoting(sv) ? `"${escapeDoubleQuotedScalar(sv)}"` : sv}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{') || scalarNeedsDoubleQuoting(sv)) {
        lines.push(`${key}: "${escapeDoubleQuotedScalar(sv)}"`);
      } else {
        lines.push(`${key}: ${sv}`);
      }
    }
  }
  // #3257: re-emit any trailing full-line comments (those after the last key).
  if (commentChannel?.trailing?.length) {
    for (const c of commentChannel.trailing) lines.push(c);
  }
  return lines.join('\n');
}

/**
 * #3257: copy the full-line-comment channel from `source` onto `target`, filtering
 * `leading` to keys still present in `target` (a deleted key's annotation goes with
 * it — AC5). No-op when `source` carries no channel. Consumers that rebuild their
 * target object fresh (syncStateFrontmatter builds derivedFm via buildStateFrontmatter
 * and copies keys with Object.keys, which skips the Symbol) MUST call this before
 * reconstructFrontmatter, or the channel parseGuardedYamlRegion attached to the extracted
 * source is lost.
 */
function propagateCommentChannel(source: Frontmatter, target: Frontmatter): void {
  const channel = (source as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] as FullLineCommentChannel | undefined;
  if (!channel) return;
  // Null-prototype `leading` (post-#3881-review, finding 3) — same rationale as
  // `extractCommentChannel`. `target` may be a plain `{}` built by a caller outside this
  // module (e.g. `buildStateFrontmatter`), so `key in target` is checked via
  // `hasOwnProperty`, not the `in` operator: `in` walks target's OWN prototype chain too,
  // and a target key named `constructor`/`toString`/etc. would otherwise read as "present"
  // even when it was never actually set.
  const filtered: FullLineCommentChannel = { leading: Object.create(null) as Record<string, string[]>, trailing: channel.trailing };
  for (const [key, comments] of Object.entries(channel.leading)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) filtered.leading[key] = comments;
  }
  if (filtered.trailing.length || Object.keys(filtered.leading).length) {
    (target as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] = filtered;
  }
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
  const lines = splitLines(yaml);
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
    const fmLines = splitLines(fmBlock);
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
  const yamlLines = splitLines(yaml);

  // Find must_haves: first to detect its indentation level. Split-then-scan
  // (rather than a whole-string /m match) so a CRLF or blank-line boundary
  // can never be absorbed into the indent capture (#3360) — see
  // .gsd/phase/chore-3413-text-lines-seam/40-design.md.
  const mustHavesLinePattern = /^(\s*)must_haves:\s*$/;
  const mustHavesLineIndex = yamlLines.findIndex((line) => mustHavesLinePattern.test(line));
  if (mustHavesLineIndex === -1) return [];
  const mustHavesIndent = (yamlLines[mustHavesLineIndex].match(/^(\s*)/) as RegExpMatchArray)[1].length;

  // Find the block (e.g., "truths:", "artifacts:", "key_links:") under must_haves
  // It must be indented more than must_haves but we detect the actual indent dynamically
  const blockLinePattern = new RegExp(`^(\\s+)${blockName}:\\s*$`);
  const blockLineIndex = yamlLines.findIndex((line) => blockLinePattern.test(line));
  if (blockLineIndex === -1) return [];

  const blockIndent = (yamlLines[blockLineIndex].match(/^(\s*)/) as RegExpMatchArray)[1].length;
  // The block must be nested under must_haves (more indented)
  if (blockIndent <= mustHavesIndent) return [];

  const blockLines = yamlLines.slice(blockLineIndex + 1); // skip the header line

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

// Shared base for 'plan' and 'plan-gap-closure' below — a plain array reference (not
// FRONTMATTER_SCHEMAS.plan.required) because the object literal that defines
// FRONTMATTER_SCHEMAS cannot refer to itself mid-initialization (TDZ).
const PLAN_REQUIRED_FIELDS = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];

// `requiredValues` is optional per schema: when a field name is a key here, the
// field must be PRESENT AND strictly equal (===) to the given value to satisfy
// the schema — presence alone is not enough. Every other required field (no
// entry in requiredValues) keeps the original presence-only contract.
const FRONTMATTER_SCHEMAS: Record<string, { required: string[]; requiredValues?: Record<string, FrontmatterValue> }> = {
  plan: { required: PLAN_REQUIRED_FIELDS },
  // #2847: gap-closure plans carry every 'plan' field PLUS gap_closure — the flag
  // execute-phase --gaps-only filters on. A separate schema (not a change to
  // 'plan') so standard/reviews-mode plans stay unaffected: they validate against
  // 'plan' and are never required to declare or be checked for gap_closure.
  // Derived from PLAN_REQUIRED_FIELDS (never hand-duplicated) so the two can't drift.
  //
  // requiredValues.gap_closure = true (not just presence): --gaps-only filters
  // strictly on gap_closure === true (execute-phase.md, partial-wave.md), so a
  // plan carrying `gap_closure: false` would pass a presence-only check and
  // still be silently skipped at execute time — the exact symptom #2847
  // reports, one value away. Presence-only was flagged in review as a live
  // reproduction of the bug this schema exists to close.
  'plan-gap-closure': {
    required: [...PLAN_REQUIRED_FIELDS, 'gap_closure'],
    // extractFrontmatter parses every scalar as a string (FrontmatterValue has
    // no boolean member — `gap_closure: true` in YAML becomes the JS string
    // "true", not the boolean true), so the required value is the string here.
    requiredValues: { gap_closure: 'true' },
  },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

/**
 * Strip frontmatter blocks from the start of `content`.
 *
 * Handles CRLF line endings and, by default, multiple stacked blocks
 * (corruption recovery): greedily strips consecutive `---...---` blocks
 * separated by optional whitespace, so a doubled/tripled frontmatter header
 * (e.g. from a botched merge) is fully removed, not just the first block.
 *
 * Pass `{ once: true }` to stop after the first block. Callers whose input is
 * an arbitrary user-authored document — rather than a GSD artefact with a
 * known doubling failure mode — need this: a body that opens with a
 * thematic-break-delimited section is lexically indistinguishable from a
 * second frontmatter block, and the greedy loop deletes it silently (#2703).
 *
 * Canonical home for this primitive (#2143 audit dedup): previously
 * duplicated byte-identically in both `state.cts` and `state-transition.cts`.
 */
function stripFrontmatter(content: string, opts: { once?: boolean } = {}): string {
  let result = content;
  while (true) {
    const stripped = result.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, '');
    if (stripped === result) break;
    result = stripped;
    if (opts.once) break;
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
  // #1660 (broadened): a lossy object-list field being genuinely CHANGED must fail closed
  // before it is regenerated, not just when the regenerated result happens to be byte-identical
  // to the original (see objectListFieldWouldLoseData's docblock).
  const lossyErr = objectListFieldWouldLoseData(content, field as string, parsedValue);
  if (lossyErr) {
    output({ error: lossyErr, field }, raw, undefined);
    return;
  }
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

/**
 * #1660 (broadened, ADR-3473 §8.1 / #3881): `noOpObjectListSetError` only catches the
 * BYTE-IDENTICAL no-op case. Under the js-yaml migration, `flattenObjectListItem` correctly
 * joins EVERY sub-key of an object-list item (`path: X, provides: Y`) instead of the legacy
 * hand-rolled scanner's accidental behavior of silently discarding every field but the one on
 * the dash line itself. That fixes a real data-loss bug on READ, but it also means a `set` that
 * replaces such a field with a plainly-flattened string (e.g. `{artifacts: ["path: X"]}`,
 * omitting `provides`) is no longer byte-identical to the original — so it no longer trips the
 * no-op guard, sails through `regenerateFrontmatterKey` (which only refuses when the NEW value
 * itself contains a live JS object), and silently writes a version with `provides` gone.
 *
 * This is the general form of the same "cannot faithfully round-trip" contract: a field is
 * lossy exactly when regenerating its OWN already-parsed value fails to reproduce its own raw
 * source text byte-for-byte (proof, not a guess, that this key's original shape does not
 * survive parse → reconstruct). When that is true AND the caller is genuinely changing the
 * field (not merely re-supplying an equal value, which `frontmatterDeepEqual` already lets
 * through), the set is refused — matching `regenerateFrontmatterKey`'s own fail-closed
 * philosophy for the mirror-image case (new value carries a nested object outright).
 */
function objectListFieldWouldLoseData(content: string, field: string, newValue: unknown): string | null {
  // A NEW value that itself carries a live nested object (rather than an already-flattened
  // string) is the mirror-image case `regenerateFrontmatterKey` already refuses on its own
  // (the "[object Object]" guard, via spliceFrontmatter) — leave that path's existing throw
  // behavior alone rather than intercepting it here with a different (non-throwing) contract.
  try { regenerateFrontmatterKey(field, newValue as FrontmatterValue); } catch { return null; }

  let originalParsed: Frontmatter;
  try { originalParsed = extractFrontmatter(content); } catch { return null; }
  if (!Object.prototype.hasOwnProperty.call(originalParsed, field)) return null;
  const originalValue = originalParsed[field];
  if (frontmatterDeepEqual(newValue, originalValue)) return null;

  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return null;
  const original = sliceTopLevelFrontmatterSegments(fmMatch[1]).find((s) => s.key === field);
  if (!original) return null;

  let regeneratedOriginal: string;
  try {
    regeneratedOriginal = regenerateFrontmatterKey(field, originalValue);
  } catch {
    return `frontmatter set refused — the existing "${field}" field contains a nested object-list ` +
      `(e.g. must_haves.artifacts) the frontmatter writer cannot faithfully represent, and this change ` +
      `would silently discard data. Edit the file directly instead of using frontmatter set/merge.`;
  }
  if (regeneratedOriginal.trim() === original.raw.trim()) return null;

  return `frontmatter set refused — the existing "${field}" field cannot be faithfully round-tripped by ` +
    `the frontmatter writer (its structure would be flattened and data, such as a nested object-list ` +
    `field, silently dropped). Edit the file directly instead of using frontmatter set/merge.`;
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
  // Guard against prototype-chain keys (__proto__, constructor, toString, hasOwnProperty,
  // valueOf, ...): a bare FRONTMATTER_SCHEMAS[schemaName] lookup resolves those to
  // Object.prototype members instead of undefined, so a `!schema` check on the raw
  // lookup never fires and the code crashes later on `schema.required.filter` with an
  // uncaught TypeError instead of the intended "Unknown schema" message. Confirmed live
  // with --schema __proto__. Now that --schema is agent-bound (agents/gsd-planner.md's
  // $SCHEMA), this is reachable from prompt state, not just an unreachable literal.
  // Checked and rejected BEFORE the lookup (rather than `?? undefined`-ing the lookup
  // itself) so `schema`'s inferred type stays non-optional and needs no assertion below.
  if (!Object.prototype.hasOwnProperty.call(FRONTMATTER_SCHEMAS, schemaName as string)) {
    error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`);
  }
  const schema = FRONTMATTER_SCHEMAS[schemaName as string];
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
  const requiredValues = schema.requiredValues || {};
  // A field satisfies the schema when it is present AND — for fields with a
  // requiredValues entry — strictly equal to that value. Absent and
  // wrong-value both surface as `missing` (existing `missing`/`present`
  // partition of `required` is unchanged — no consumer reads `present` to
  // mean "physically exists regardless of value," confirmed by searching
  // every caller before choosing this). But #2847 review: folding silently
  // made "missing" misleading for a WRONG-valued field the plan author can
  // plainly see in the file (e.g. `gap_closure: True`) — nothing told them
  // the field is present but the VALUE is wrong, so they could loop trying
  // to add a field that is already there. `invalidValue` names exactly that
  // subset (present, but not the required value) so the message stays
  // actionable without changing what `missing`/`present` mean.
  const wrongValue = (f: string): boolean =>
    fm[f] !== undefined && Object.prototype.hasOwnProperty.call(requiredValues, f) && fm[f] !== requiredValues[f];
  const satisfies = (f: string): boolean => fm[f] !== undefined && !wrongValue(f);
  const missing = schema.required.filter(f => !satisfies(f));
  const present = schema.required.filter(f => satisfies(f));
  const invalidValue = schema.required.filter(wrongValue);
  output({ valid: missing.length === 0, missing, present, invalidValue, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

export = {
  // #3706: shared with the agent-frontmatter writers so a config-supplied
  // `model:`/`variant:` value cannot break out of its scalar. Previously private
  // here while those writers interpolated raw — one escaper, three call sites.
  escapeDoubleQuotedScalar,
  agentScalarNeedsDoubleQuoting,
  extractFrontmatter,
  UNTERMINATED_KEY_THRESHOLD,
  // ADR-3473 §8.1 (#3881, consequence 2): the unparseable-vs-empty marker Symbol. Exported so
  // the 8 `hasFrontmatter` call sites named in the design can consult it in a follow-up change.
  FRONTMATTER_UNPARSEABLE,
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
  propagateCommentChannel,
};
