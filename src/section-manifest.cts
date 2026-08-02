/**
 * Section Manifest — pure `when=` evaluator over `InvocationFacts`, mapping
 * a document-order list of parsed `<!-- gsd:section -->` sections (Phase 3,
 * `src/workflow-fragments.cts`) to an included/excluded partition for one
 * concrete invocation (ADR-1671 epic #1671, Phase 5 / issue #2932,
 * `.gsd/phase/chore-2932-init-section-manifest/40-design.md`).
 *
 * Pure module: no I/O, no dependency beyond node built-ins and the sibling
 * compiled module `workflow-fragments.cjs`, whose {@link
 * workflowFragments.WHEN_VOCABULARY} is imported and never redeclared here
 * (DEFECT.GENERATIVE-FIX — a second frozen copy of the same 4 strings would
 * silently desync from the source of truth the moment either side is edited
 * without the other).
 *
 * ## The evaluator is a LOOKUP, not a parser
 *
 * Derived from Greenspun's Tenth Rule (ADR-1671:69 cites it by name) and
 * binding on this implementation: `when=` is a closed, 4-entry vocabulary.
 * {@link WHEN_PREDICATES} is a total map from each frozen vocabulary entry
 * to exactly one predicate over {@link InvocationFacts}. It MUST NOT
 * tokenize, split on operators, or interpret structure in the `when=`
 * string — the moment it parses, the ad-hoc language has begun. An
 * unrecognized `when=` value fails closed via {@link selectSections}
 * throwing a `TypeError` carrying `.reason = REASON.UNKNOWN_WHEN`; it is
 * never silently excluded (Postel's Law: liberal on FORMAT elsewhere in the
 * pipeline, strict on this SEMANTIC boundary — matching the discipline
 * Phase 3 already established for the same vocabulary at parse time).
 *
 * ## Totality over facts
 *
 * Every predicate treats an absent/missing fact key as falsy WITHOUT
 * throwing — {@link InvocationFacts} is a plain data object handed in by a
 * caller (the init CLI seam) that may not always populate every field, and
 * this module must never surprise that caller with an exception for an
 * omission rather than a malformed `when=` value.
 *
 * ## Partition invariant
 *
 * {@link selectSections} returns `included` and `excluded` id arrays that
 * together contain every input section's `id` exactly once, in the SAME
 * relative document order they appeared in the input — never mutating the
 * input array or its elements.
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/section-manifest.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- workflow-fragments.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
import workflowFragments = require('./workflow-fragments.cjs');

/**
 * The facts a concrete invocation supplies to the evaluator. Every field is
 * a plain, already-resolved value — no parsing, no derivation — computed by
 * the caller (the init CLI seam) before {@link selectSections} is invoked.
 */
export interface InvocationFacts {
  /** Whether the `--wave` flag's literal token was present on the invocation (token-presence, not value-truthiness). */
  readonly waveFlag: boolean;
  /** The invocation's phase number, or `null` when absent. A decimal (`X.Y`) phase number is a gap-closure phase. */
  readonly phaseNumber: string | null;
  /** Whether prior phases exist for this invocation. */
  readonly hasPriorPhases: boolean;
}

/** A single input to {@link selectSections}: structurally compatible with {@link workflowFragments.WorkflowSection}. */
export interface SelectableSection {
  readonly id: string;
  readonly when: string;
}

/** The result of partitioning a document-order section list against one set of {@link InvocationFacts}. */
export interface SectionSelection {
  /** Ids of sections whose `when=` predicate held, in document order. */
  readonly included: string[];
  /** Ids of sections whose `when=` predicate did not hold, in document order. */
  readonly excluded: string[];
}

/**
 * Frozen, stable reason codes for every `fail()` throw site in this module.
 * Tests assert via `assert.equal(err.reason, REASON.X)` rather than
 * regex-/substring-matching the human-readable message (CONTRIBUTING.md
 * "Prohibited: Raw Text Matching on Test Outputs"; shape copied from
 * `src/workflow-fragments.cts`'s own `REASON` export) — a message reword
 * must never silently pass a test that exists to catch a behavior
 * regression.
 *
 * Adding a new reason requires updating this map AND the test that locks
 * `Object.keys(REASON).sort()` as a coordinated change.
 */
export const REASON = Object.freeze({
  UNKNOWN_WHEN: 'unknown_when',
});

/** A `TypeError` carrying a stable {@link REASON} code alongside the human-readable message. */
export interface SectionManifestError extends TypeError {
  readonly reason: string;
}

/**
 * Throws a `TypeError` naming the offending `when` value, carrying `reason`
 * (one of {@link REASON}) as a typed property so callers/tests never need
 * to pattern-match the message prose.
 */
function fail(reason: string, message: string): never {
  const err = new TypeError(`section-manifest: ${message}`) as TypeError & { reason: string };
  err.reason = reason;
  throw err;
}

/**
 * Total map from each frozen {@link workflowFragments.WHEN_VOCABULARY}
 * entry to exactly one predicate over {@link InvocationFacts}. This is a
 * LOOKUP, never a parser — see the module doc comment's "The evaluator is a
 * LOOKUP, not a parser" section. Semantics confirmed against the section
 * bodies themselves (design doc "Semantics confirmed against the section
 * bodies themselves, not inferred from the id"):
 *
 * - `gap-closure-artifacts` — "For decimal/polish phases only (X.Y
 *   pattern) … Skip if phase number has no decimal" -> `state:gap-closure-phase`.
 * - `regression-gate` — "Skip if: this is the first phase (no prior
 *   phases)" -> `state:has-prior-phases`.
 * - `partial-wave` — "If `WAVE_FILTER` was used" -> `flag:--wave`.
 */
export const WHEN_PREDICATES: Readonly<Record<string, (facts: InvocationFacts) => boolean>> = Object.freeze({
  always: () => true,
  'flag:--wave': (facts: InvocationFacts) => facts.waveFlag === true,
  'state:gap-closure-phase': (facts: InvocationFacts) =>
    typeof facts.phaseNumber === 'string' && facts.phaseNumber.includes('.'),
  'state:has-prior-phases': (facts: InvocationFacts) => facts.hasPriorPhases === true,
});

// Coordinated-change guard, checked at module load: every entry of the
// frozen WHEN_VOCABULARY (imported, never redeclared — see module doc
// comment) must have exactly one predicate here, and vice versa. This is
// the load-bearing half of the DEFECT.GENERATIVE-FIX parity contract; the
// test-level half (50-test-matrix.md rows 21-23) additionally asserts it
// from the vocabulary's own export so a 5th vocabulary entry added without
// a predicate fails loudly rather than silently falling through to
// REASON.UNKNOWN_WHEN only at run time.
for (const when of workflowFragments.WHEN_VOCABULARY) {
  if (!(when in WHEN_PREDICATES)) {
    throw new Error(`section-manifest: WHEN_VOCABULARY entry "${when}" has no predicate in WHEN_PREDICATES`);
  }
}

/**
 * Partition `sections` (document order) into `included`/`excluded` id
 * arrays for one set of `facts`, per {@link WHEN_PREDICATES}. Exact
 * partition: every input id appears in exactly one of the two output
 * arrays, in the same relative order it appeared in `sections`. Never
 * mutates `sections` or its elements.
 *
 * @param sections - document-order sections carrying at least `{id, when}`
 * @param facts - the concrete invocation's resolved facts
 * @throws {SectionManifestError} with `.reason = REASON.UNKNOWN_WHEN` when a
 *   section's `when` value has no entry in {@link WHEN_PREDICATES} (fail
 *   closed — never silently excluded).
 */
export function selectSections(
  sections: readonly SelectableSection[],
  facts: InvocationFacts,
): SectionSelection {
  const included: string[] = [];
  const excluded: string[] = [];

  for (const section of sections) {
    const predicate = WHEN_PREDICATES[section.when];
    if (predicate === undefined) {
      fail(REASON.UNKNOWN_WHEN, `section "${section.id}" has unrecognized when= value "${section.when}"`);
    }
    if (predicate(facts)) {
      included.push(section.id);
    } else {
      excluded.push(section.id);
    }
  }

  return { included, excluded };
}
