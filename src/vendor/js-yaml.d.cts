// Hand-authored type twin for gsd-core/bin/lib/vendor/js-yaml.cjs.
//
// js-yaml ships no type declarations of its own (`@types/js-yaml` is not
// installed either), so unlike src/vendor/re2js.d.cts this file has no
// upstream .d.ts to copy verbatim — it is written by hand and therefore
// EXCLUDED from lint-vendored-deps.cjs's byte-compare (there is nothing
// upstream to compare it against).
//
// The declared surface is DELIBERATELY NARROW: only `load`, `dump`,
// `FAILSAFE_SCHEMA` and `YAMLException` (plus `load`'s `listener` callback,
// used only to detect an anchor/alias BEFORE it is acted on) are declared.
// This is a capability gate, not laziness — `loadAll` and any custom
// (non-FAILSAFE) schema are genuinely unreachable from typed code that only
// ever imports through this twin, so a caller cannot accidentally widen
// parsing beyond what ADR-3473 §8.1 reviewed.
//
// CORRECTED (post-#3881-review): an earlier version of this comment claimed
// anchors and aliases were themselves "simply UNREACHABLE" through this
// twin. That was false — anchor/alias resolution is document-level `load`
// mechanics, not a separate export gated by the type surface, and is
// reachable through exactly the declared `load` + `FAILSAFE_SCHEMA` +
// `json: true` combination this twin exposes. Anchor/alias refusal is NOT
// enforced by narrowing this type surface; it is enforced at RUNTIME, in
// `refuseAnchorsAndAliases` (src/frontmatter.cts), which uses `load`'s
// `listener` callback to detect `state.anchor` and abort the parse before
// any alias expansion happens. Do not widen this twin's surface (`loadAll`,
// a non-FAILSAFE schema) without a matching change to the security posture
// in ADR-3473 §8.1, and do not restate the "unreachable by type" claim for
// anchors/aliases — it is runtime-enforced, not type-enforced.

/**
 * The subset of js-yaml's internal parser `State` this twin exposes to a `listener`
 * callback: just enough to detect that the CURRENT parse event belongs to an anchored
 * node. `anchor` is the anchor name (non-null/non-undefined) while js-yaml is
 * defining OR resolving an alias to it; `null`/`undefined` otherwise.
 */
export interface LoadListenerState {
  readonly anchor?: string | null;
}

export interface LoadOptions {
  /** Overrides the schema used for parsing. Only FAILSAFE_SCHEMA is supported by this twin. */
  schema?: SchemaType;
  /**
   * When true, duplicate keys overwrite (last-wins) instead of throwing.
   * See ADR-3473 §8.1 §3.3 — required to keep the documented "last value
   * wins" invariant for `duplicate-keys.md` without a naive catch.
   */
  json?: boolean;
  /**
   * Invoked once per parse event with the parser's internal state. Declared solely so
   * `refuseAnchorsAndAliases` (src/frontmatter.cts) can inspect `state.anchor` and abort
   * the parse — by throwing from inside the callback — before any anchor/alias is
   * expanded. Not a general-purpose parse-event hook: no other consumer should add a
   * second `listener` use without reviewing ADR-3473 §8.1's security posture.
   */
  listener?: (event: string, state: LoadListenerState) => void;
}

export interface DumpOptions {
  schema?: SchemaType;
  [key: string]: unknown;
}

/** Opaque marker for the vendored schema constants; not constructible from typed code. */
export interface SchemaType {
  readonly __jsYamlSchemaBrand: unique symbol;
}

/** The failsafe schema: every scalar resolves to a string; no anchors/aliases/custom types. */
export const FAILSAFE_SCHEMA: SchemaType;

export function load(src: string, opts?: LoadOptions): unknown;

export function dump(obj: unknown, opts?: DumpOptions): string;

export interface YAMLExceptionMark {
  readonly line: number;
  readonly column: number;
  readonly position: number;
}

export class YAMLException extends Error {
  readonly message: string;
  /** Present at runtime (verified: js-yaml assigns `this.mark` in its constructor). */
  readonly mark?: YAMLExceptionMark;
}

export {};
