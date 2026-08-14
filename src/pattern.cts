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

export function escapeRegex(value: string): string {
  return RegExp.escape(value);
}

export function literalPattern(value: string, flags?: string): RegExp {
  return new RegExp(escapeRegex(value), flags);
}
