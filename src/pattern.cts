/**
 * pattern.cts — the pattern-construction seam (ADR-3212 §1, epic #3212 Phase 1,
 * #3412).
 *
 * Source in src/pattern.cts, compiled to gsd-core/bin/lib/pattern.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Sole owner of building a `RegExp` from a runtime value. `escapeRegex`
 * delegates to the built-in `RegExp.escape` (ES2026 / Node 24+) rather than
 * hand-rolling yet another copy of the metacharacter-escape helper this
 * module replaces — see ADR §1 ("No module outside the seam escapes a value
 * for regex use").
 *
 * Counts, corrected during implementation (design doc "Ground truth" #1;
 * .gsd/phase/chore-3412-pattern-seam/40-design.md): the ADR's census counted
 * ~12 *named* helper functions. The shape-based lint guard
 * (eslint-rules/no-adhoc-regex-escape.cjs), which matches the escape-class
 * SHAPE wherever it appears rather than named-function bodies, found 27
 * additional inline copies that census-by-name could not see — **~39 escape
 * sites total**. Call sites follow the same pattern: 17 were surveyed
 * directly, but `src/phase-id.cts`'s `escapeRegex` turned out to have 8
 * external production importers the pre-implementation survey missed, plus
 * the 27 guard-found inline sites also call into the seam — **~44 call
 * sites total**. The lesson worth keeping: a named-function census
 * structurally cannot see an inline `.replace(...)` copy or an
 * externally-imported symbol; only a shape-based guard (or a direct
 * importer graph query) does.
 *
 * `escapeRegex` is the PRIMARY export: the large majority of call sites
 * build a *source string* (alternation via `.map(escapeRegex).join('|')`, or
 * template/concat interpolation into a larger pattern) rather than a
 * standalone literal match. `literalPattern` is the minority convenience
 * wrapper for the remaining "match this value literally" shape — not the
 * dominant one (design doc "Ground truth" #2).
 *
 * Behavior-preserving for MATCH RESULTS, not for pattern TEXT: `RegExp.escape`
 * hex-escapes the leading character of nearly every non-empty input (and `-`,
 * space, and control characters throughout), so the escaped source string
 * differs from the twelve deleted copies' output for almost every value.
 * Match behavior against that source is unaffected — verified by the
 * migration-equivalence property sweep in tests/pattern.test.cjs (rows 15-17).
 */

// re2js is vendored, not an npm dependency at runtime: gsd-core/bin/** is
// copied into installed trees that have no node_modules, so this module must
// carry zero external requires (eslint-rules/no-external-require-in-bin.cjs
// enforces it). See gsd-core/bin/lib/vendor/README.md.
import { RE2JS } from './vendor/re2js.cjs';

export function escapeRegex(value: string): string {
  return RegExp.escape(value);
}

export function literalPattern(value: string, flags?: string): RegExp {
  return new RegExp(escapeRegex(value), flags);
}

/** Max length for a user-supplied regex pattern before it is refused (ReDoS/compile-cost mitigation). */
export const MAX_USER_PATTERN_LEN = 512;

/** Reason an untrusted pattern was refused and never compiled, or `null` if it compiled. */
export type UserPatternNeutralization = 'empty' | 'too-long' | 'unsupported';

export interface UserPatternResult {
  /** Linear-time match via RE2. Returns false for every neutralized pattern, by construction. */
  test(input: string): boolean;
  /** null when the pattern compiled; otherwise why it was refused. */
  neutralized: UserPatternNeutralization | null;
}

/** Always-false matcher shared by every neutralization path — a refused pattern must never be able to report a match. */
const NEVER_MATCH: UserPatternResult['test'] = () => false;

/**
 * Compile an UNTRUSTED, user-supplied pattern (e.g. plan frontmatter) via RE2
 * (re2js), whose matching is linear-time in input length by construction —
 * there is no backtracking engine here to exploit, so the vulnerability class
 * (catastrophic/exponential backtracking) is closed by the engine rather than
 * detected by a heuristic scan of the pattern text.
 *
 * Never throws. A pattern that is empty, too long, or not valid RE2 syntax
 * (backreferences and look-around are unsupported by RE2 — those are exactly
 * the constructs that require backtracking) is REFUSED: `test()` always
 * returns `false`, and `neutralized` reports why so callers can surface the
 * refusal (#3477 follow-up: a neutralized pattern must not look like a plain
 * "not found"). Restores the guards lost with
 * `sdk/src/query/validate.ts:regexForKeyLinkPattern` (#3477); this revision
 * (post-#3477-follow-up) replaces the hand-rolled backtracking-shape scanner
 * with RE2's linear-time guarantee — a refused pattern is never re-attempted
 * as a literal-escaped match, since guessing at a pattern we could not
 * compile is what produced the prior false-pass regression.
 *
 * `pattern` is `unknown`, not `string`, because callers pull this straight off
 * parsed plan frontmatter (untrusted YAML) — a non-string value must reach the
 * `'empty'`/never-match branch rather than being force-cast by the caller.
 */
export function compileUserPattern(pattern: unknown): UserPatternResult {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { test: NEVER_MATCH, neutralized: 'empty' };
  }
  if (pattern.length > MAX_USER_PATTERN_LEN) {
    // The cap now bounds compile cost/memory, not backtracking (RE2 has none) —
    // an over-long pattern is refused outright rather than truncated-and-compiled.
    return { test: NEVER_MATCH, neutralized: 'too-long' };
  }
  try {
    // translateRegExp accepts JS-flavored syntax (named groups, `/`-escaping,
    // etc.) that RE2's own grammar doesn't, reducing spurious refusals of
    // otherwise-safe, JS-authored patterns before compiling under RE2's
    // linear-time engine.
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern));
    return { test: (input: string) => compiled.test(input), neutralized: null };
  } catch {
    // Backreferences, look-around, or any other RE2-unsupported/malformed
    // syntax. No literal-escape fallback: a pattern we could not compile is
    // never guessed at — guessing produced the #3477 false-pass regression.
    return { test: NEVER_MATCH, neutralized: 'unsupported' };
  }
}
