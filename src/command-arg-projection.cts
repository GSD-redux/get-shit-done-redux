/**
 * Command Argument Projection Module (ADR-457 build-at-publish: the
 * hand-written bin/lib/command-arg-projection.cjs collapsed to a TypeScript
 * source of truth).
 *
 * ADR-3473 §8.4 ("failure is a value"): `parseNamedArgs` is now strict and
 * returns a `Result` instead of silently accepting unrecognized or stray
 * positional tokens. See .gsd/phase/feat-3884-failure-is-a-value/40-design.md
 * for the full behavior table (A1-A18) and negative-space section (N1-N8).
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { ERROR_REASON } = io;

// Structurally identical to io.cts's own (unexported) ErrorReasonValue type —
// both are computed from the SAME ERROR_REASON object, so the two never
// drift. Needed here (rather than a plain `string`) so `parseNamedArgsOrExit`
// can accept a real ERROR_REASON-typed callback (e.g. io.cts's `error`)
// directly: a `fail` parameter typed with a bare `string` second argument
// fails TypeScript's contravariant function-parameter check against a
// callback whose real signature narrows that argument to ErrorReasonValue.
type ErrorReasonValue = (typeof ERROR_REASON)[keyof typeof ERROR_REASON];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NamedArgSpec {
  valueFlags?: string[];
  booleanFlags?: string[];
  /**
   * Count of leading argv slots the CALLER owns and reads itself (args[0] =
   * family, args[1] = subcommand, plus any documented positional).
   * Validation begins at this index. 'rest' means the caller consumes all
   * remaining tokens as free text; undeclared-flag rejection is disabled
   * entirely for that call (documented exemption, e.g. `init quick`).
   */
  positionals: number | 'rest';
}

export type ParsedNamedArgs = Record<string, string | boolean | null>;

export type NamedArgsResult =
  | { ok: true; data: ParsedNamedArgs }
  | { ok: false; kind: 'InvalidArgs'; arg: string; reason: string; exitReason: ErrorReasonValue };

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * ADR-3473 Decision 2: both ends of this seam are gsd-core's own source, so a
 * malformed spec (a stale call site still using the legacy
 * `parseNamedArgs(args, valueFlags, booleanFlags)` shape, or a missing spec
 * entirely) is an internal invariant violation, not user input — it throws
 * loudly instead of destructuring `undefined` off a Result.
 */
function assertValidSpec(spec: unknown): asserts spec is NamedArgSpec {
  if (!isPlainObject(spec)) {
    throw new TypeError(
      'parseNamedArgs: spec must be an object of shape ' +
        '{ valueFlags?: string[], booleanFlags?: string[], positionals: number | "rest" }. ' +
        'Received a missing, array, or non-object value — this is the legacy ' +
        'parseNamedArgs(args, valueFlags, booleanFlags) call shape, retired by ADR-3473 §8.4.',
    );
  }
  const positionals = spec.positionals;
  const positionalsValid =
    positionals === 'rest' ||
    (typeof positionals === 'number' && Number.isInteger(positionals) && positionals >= 0);
  if (!positionalsValid) {
    throw new TypeError(
      'parseNamedArgs: spec.positionals must be a non-negative integer or the literal "rest" ' +
        `— received ${JSON.stringify(positionals)}.`,
    );
  }
}

// Single predicate reused for both extraction (a value beginning with a
// single `-` is a value, not a flag) and validation (negative space N5).
function isFlagToken(tok: string): boolean {
  return tok.startsWith('--');
}

// ─── parseNamedArgs ───────────────────────────────────────────────────────────

/**
 * Project argv tokens into typed named values, then strictly validate every
 * token past the caller's declared positional boundary.
 *
 * Extraction (unchanged semantics, #312): first occurrence wins; a value
 * flag whose next token is absent or starts with `--` yields `null`; boolean
 * flags are presence tests. Kept as a single first-index Map so the flag
 * loops don't each re-scan argv — O(argv + flags) instead of O(flags * argv).
 *
 * Validation (skipped entirely when `positionals === 'rest'`): a single
 * left-to-right cursor walk from `spec.positionals`, per the design doc's
 * Kernighan's Law note — debuggable over clever, never a set-difference.
 */
export function parseNamedArgs(args: string[], spec: NamedArgSpec): NamedArgsResult {
  assertValidSpec(spec);
  const valueFlags = spec.valueFlags ?? [];
  const booleanFlags = spec.booleanFlags ?? [];

  const firstIndex = new Map<string, number>();
  for (let i = 0; i < args.length; i++) {
    if (!firstIndex.has(args[i])) firstIndex.set(args[i], i);
  }
  const data: ParsedNamedArgs = {};
  for (const flag of valueFlags) {
    const idx = firstIndex.has(`--${flag}`) ? (firstIndex.get(`--${flag}`) as number) : -1;
    data[flag] =
      idx !== -1 && args[idx + 1] !== undefined && !isFlagToken(args[idx + 1])
        ? args[idx + 1]
        : null;
  }
  for (const flag of booleanFlags) {
    data[flag] = firstIndex.has(`--${flag}`);
  }

  if (spec.positionals === 'rest') {
    return { ok: true, data };
  }

  const valueFlagSet = new Set(valueFlags);
  const booleanFlagSet = new Set(booleanFlags);
  const flagList = [
    ...valueFlags.map((f) => `--${f} <value>`),
    ...booleanFlags.map((f) => `--${f}`),
  ];

  let i = spec.positionals;
  while (i < args.length) {
    const tok = args[i];
    if (isFlagToken(tok)) {
      const name = tok.slice(2);
      if (valueFlagSet.has(name)) {
        const next = args[i + 1];
        if (next === undefined || isFlagToken(next)) {
          return {
            ok: false,
            kind: 'InvalidArgs',
            arg: tok,
            reason: `${tok} requires a value`,
            exitReason: ERROR_REASON.USAGE,
          };
        }
        i += 2;
        continue;
      }
      if (booleanFlagSet.has(name)) {
        i += 1;
        continue;
      }
      const reason =
        flagList.length > 0
          ? `unknown flag ${tok}; accepted: ${flagList.join(', ')}`
          : `unknown flag ${tok}; this command accepts no flags`;
      return { ok: false, kind: 'InvalidArgs', arg: tok, reason, exitReason: ERROR_REASON.USAGE };
    }
    return {
      ok: false,
      kind: 'InvalidArgs',
      arg: tok,
      reason: `unexpected positional argument "${tok}"`,
      exitReason: ERROR_REASON.USAGE,
    };
  }

  return { ok: true, data };
}

/**
 * Thin projection over `parseNamedArgs`: on `ok:false` it calls
 * `fail(result.reason, result.exitReason)` and then throws.
 *
 * The trailing throw exists for two reasons: (1) TypeScript's control-flow
 * analysis needs a `never`-returning path so callers can destructure the
 * return value without a null check; (2) it is a fail-closed backstop — the
 * `fail` callbacks in this repo are `never`-returning at runtime (`io.error`
 * calls `process.exit(1)`) but are typed `void`, so if a caller ever passes a
 * `fail` that actually returns, this still halts instead of falling through
 * with a half-built `ParsedNamedArgs`.
 */
export function parseNamedArgsOrExit(
  args: string[],
  spec: NamedArgSpec,
  fail: (message: string, exitReason?: ErrorReasonValue) => void,
): ParsedNamedArgs {
  const result = parseNamedArgs(args, spec);
  if (!result.ok) {
    fail(result.reason, result.exitReason);
    throw new Error(`parseNamedArgsOrExit: fail() returned instead of exiting (arg: ${result.arg})`);
  }
  return result.data;
}

/**
 * Collect all tokens after --flag until the next --flag or end of args.
 */
export function parseMultiwordArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1) return null;
  const tokens: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    tokens.push(args[i]);
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}
