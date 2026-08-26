// Hand-authored type twin for gsd-core/bin/lib/vendor/js-yaml.cjs.
//
// js-yaml ships no type declarations of its own (`@types/js-yaml` is not
// installed either), so unlike src/vendor/re2js.d.cts this file has no
// upstream .d.ts to copy verbatim — it is written by hand and therefore
// EXCLUDED from lint-vendored-deps.cjs's byte-compare (there is nothing
// upstream to compare it against).
//
// The declared surface is DELIBERATELY NARROW: only `load`, `dump`,
// `FAILSAFE_SCHEMA` and `YAMLException` are declared. This is a capability
// gate, not laziness — ADR-3473 §8.1 refuses anchor/alias expansion for
// security reasons (a hostile anchor/alias document can resolve to
// megabytes from a few bytes of source), and js-yaml's anchors, aliases,
// custom types and `loadAll` are simply UNREACHABLE from typed code that
// only ever imports through this twin. Do not widen it to cover more of
// js-yaml's surface without a matching change to the security posture in
// ADR-3473 §8.1.

export interface LoadOptions {
  /** Overrides the schema used for parsing. Only FAILSAFE_SCHEMA is supported by this twin. */
  schema?: SchemaType;
  /**
   * When true, duplicate keys overwrite (last-wins) instead of throwing.
   * See ADR-3473 §8.1 §3.3 — required to keep the documented "last value
   * wins" invariant for `duplicate-keys.md` without a naive catch.
   */
  json?: boolean;
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
