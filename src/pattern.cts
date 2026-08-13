/**
 * pattern.cts — the pattern-construction seam (ADR-3212 §1, epic #3212 Phase 1,
 * #3412).
 *
 * Source in src/pattern.cts, compiled to gsd-core/bin/lib/pattern.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Sole owner of building a `RegExp` from a runtime value. `escapeRegex`
 * delegates to the built-in `RegExp.escape` (ES2026 / Node 24+) rather than
 * hand-rolling a thirteenth copy of the twelve byte-identical
 * `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` helpers this module replaces — see
 * ADR §1 ("No module outside the seam escapes a value for regex use").
 *
 * `escapeRegex` is the PRIMARY export: of the 17 real call sites the seam
 * replaces, 13-14 build a *source string* (alternation via
 * `.map(escapeRegex).join('|')`, or template/concat interpolation into a
 * larger pattern) rather than a standalone literal match. `literalPattern` is
 * the minority convenience wrapper for the remaining "match this value
 * literally" shape — not the dominant one (see
 * .gsd/phase/chore-3412-pattern-seam/40-design.md, "Ground truth" #2).
 *
 * Behavior-preserving for MATCH RESULTS, not for pattern TEXT: `RegExp.escape`
 * hex-escapes the leading character of nearly every non-empty input (and `-`,
 * space, and control characters throughout), so the escaped source string
 * differs from the twelve deleted copies' output for almost every value.
 * Match behavior against that source is unaffected — verified by the
 * migration-equivalence property sweep in tests/pattern.test.cjs (rows 15-17).
 */

export function escapeRegex(value: string): string {
  return RegExp.escape(value);
}

export function literalPattern(value: string, flags?: string): RegExp {
  return new RegExp(escapeRegex(value), flags);
}
