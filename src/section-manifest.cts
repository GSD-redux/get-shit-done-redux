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
 * binding on this implementation: `when=` is a closed vocabulary, widened
 * from 4 to 14 entries via the ADR-1671 amendment for #2992 (epic #1671
 * Phase 6.1; see `.gsd/phase/chore-2992-widen-when-vocabulary/
 * 40-design.md`), then from 14 to 19 via the ADR-1671 amendment for #2993
 * (epic #1671 Phase 6.2; see `.gsd/phase/chore-2993-fragmentize-plan-phase/
 * 40-design.md`), then from 19 to 20 via the ADR-1671 amendment for #2994
 * (epic #1671 Phase 6.3), then from 20 to 23 via a further #2994 amendment
 * fragmentizing `code-review.md` and `complete-milestone.md`, then from 23
 * to 24 via a still further #2994 amendment fragmentizing `autonomous.md`,
 * then from 24 to 26 via a still further #2994 amendment fragmentizing
 * `review.md` and `discuss-phase-assumptions.md`, then from 26 to 30 — and
 * finally to 29, `flag:--full` having been retired as dead vocabulary — via the
 * final #2994 slice fragmentizing `docs-update.md`, `update.md`,
 * `transition.md`, and `new-milestone.md`.
 * {@link WHEN_PREDICATES} is a total map from each frozen
 * vocabulary entry to exactly one predicate over {@link InvocationFacts}.
 * It MUST NOT tokenize, split on operators, or interpret structure in the
 * `when=` string — the moment it parses, the ad-hoc language has begun.
 * Every entry below is therefore a HAND-WRITTEN LITERAL: deriving a
 * predicate's flag/state name from its atom string (e.g. slicing `--fix`
 * out of `'flag:--fix'`) is tokenization relocated into this map and is
 * forbidden even though it would be shorter — the redundancy between each
 * key and its literal token is deliberate, and the bidirectional parity
 * test below catches any desync a hand-written entry could introduce. An
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
  /**
   * The literal `--<name>` tokens present on the invocation (token-presence,
   * not value-truthiness — an option whose value is `false` or a string is
   * still present; an option whose value is `undefined` is not). A
   * `ReadonlySet<string>` rather than a plain object: `.has()` carries no
   * prototype hazard, whereas a plain object's key lookup does.
   */
  readonly flags: ReadonlySet<string>;
  /** The invocation's phase number, or `null` when absent. A decimal (`X.Y`) phase number is a gap-closure phase. */
  readonly phaseNumber: string | null;
  /** Whether prior phases exist for this invocation. */
  readonly hasPriorPhases: boolean;
  /** Whether a codebase map is needed (init JSON). Absent/undefined is falsy, never throws. */
  readonly needsCodebaseMap?: boolean;
  /** Whether the current phase is in MVP mode (ROADMAP.md `**Mode:** mvp`). Absent/undefined is falsy, never throws. */
  readonly phaseMvpMode?: boolean;
  /** Whether worktrees are enabled (`.planning/config.json` `workflow.use_worktrees`). Absent/undefined is falsy, never throws. */
  readonly worktreesEnabled?: boolean;
  /**
   * Whether plan-phase chunked mode is active: `--chunked` flag OR
   * `.planning/config.json` `workflow.plan_chunked` (#2993). The disjunction
   * is resolved by the caller (the init seam) into this single boolean
   * BEFORE it reaches this module — `state:chunked-mode`'s predicate below
   * reads only this field, never `--chunked` and the config value
   * separately, which is what keeps the `when=` grammar operator-free.
   * Absent/undefined is falsy, never throws.
   */
  readonly chunkedMode?: boolean;
  /**
   * Whether the current phase's UI-phase surface is active (#2994):
   * the phase's active `plan:pre` loop hooks include the `ui-phase` step OR
   * the phase directory already contains a `*-UI-SPEC.md` file. Same
   * discipline as {@link chunkedMode} — the disjunction is resolved by the
   * caller (the init seam) into this single boolean BEFORE it reaches this
   * module. Absent/undefined is falsy, never throws.
   */
  readonly uiPhaseActive?: boolean;
  /**
   * Whether the fallow structural cross-module pre-pass is enabled
   * (`.planning/config.json` `code_quality.fallow.enabled`, #2994). Fail-closed
   * default `false` — resolved by the caller (`cmdInitCodeReview`, the init
   * seam) from the same config key `code-review.md`'s `structural_pre_pass`
   * step used to re-derive inline (a circular self-disabling gate); the
   * resolved value is exposed as the init-bundle's `fallow_enabled` field for
   * the step body to consume directly. Absent/undefined is falsy, never throws.
   */
  readonly fallowEnabled?: boolean;
  /**
   * Whether git tag creation is enabled on milestone close
   * (`.planning/config.json` `git.create_tag`, #2994). Fail-OPEN default
   * `true` (unset/missing config means "create the tag"), matching
   * `complete-milestone.md`'s pre-hoist `gsd-tools.cjs query config-get
   * git.create_tag 2>/dev/null || echo "true"` resolver — now hoisted into
   * `cmdInitCompleteMilestone` and exposed as the init-bundle's
   * `git_create_tag` field. Absent/undefined is falsy at the PREDICATE level
   * (per the totality convention every other atom here follows), so a caller
   * MUST always populate this fact with a real boolean (never omit it) or the
   * `git-tag` section will incorrectly evaluate to excluded.
   */
  readonly gitCreateTag?: boolean;
  /**
   * Whether `autonomous.md`'s planning step should route through plan-review
   * convergence instead of `gsd-plan-phase` (#2994): `--converge` flag OR its
   * documented alias `--cross-ai`. Same discipline as {@link chunkedMode} /
   * {@link uiPhaseActive} — the disjunction is resolved by the caller
   * (`cmdInitAutonomous`, the init seam) into this single boolean BEFORE it
   * reaches this module; `state:plan-strategy-converge`'s predicate below
   * reads only this field, never `--converge`/`--cross-ai` separately.
   * Absent/undefined is falsy, never throws.
   */
  readonly planStrategyConverge?: boolean;
  /**
   * Whether `review.md`'s `review.reviewer_instances` config surface is
   * configured — present AND non-empty (#2994). Resolved by the caller
   * (`cmdInitReview`, the init seam) via `readConfigJsonValue`; the same
   * fact backs both `reviewer-instances-note-1` and `reviewer-instances-note-2`
   * (two sections sharing one atom — legal, mirrors `plan-phase.md`'s
   * `research-only-*` pair). Absent/undefined is falsy, never throws.
   */
  readonly reviewerInstancesConfigured?: boolean;
  /**
   * Whether `discuss-phase-assumptions.md`'s `auto_advance` step should
   * dispatch (#2994): `--auto` flag OR a consolidated auto-mode config fact
   * (`workflow._auto_chain_active` OR `workflow.auto_advance`). Same
   * discipline as {@link chunkedMode} — the disjunction is resolved by the
   * caller (`cmdInitDiscussPhaseAssumptions`, the init seam) into this
   * single boolean BEFORE it reaches this module. Absent/undefined is
   * falsy, never throws.
   */
  readonly autoAdvanceActive?: boolean;
  /**
   * Whether the project is a monorepo with a non-empty workspaces list
   * (#2994, final slice): the SAME `monorepo_workspaces` glob list
   * `docs-init` (`src/docs.cts`) already produces, resolved by the caller
   * (`cmdInitDocsUpdate`, the init seam) via the exported
   * `detectMonorepoWorkspaces` detector rather than a second scan. Absent/
   * undefined is falsy, never throws.
   */
  readonly isMonorepo?: boolean;
  /**
   * Whether `update.md`'s release channel is `next` (#2994, final slice):
   * `--next` flag OR its documented alias `--rc`. Same disjunction-to-one-
   * boolean discipline as {@link chunkedMode} — resolved by the caller
   * (`cmdInitUpdate`, the init seam) into this single boolean BEFORE it
   * reaches this module. This fact exists purely to gate the
   * `channel-banner` section's admission; it deliberately does NOT replace
   * `update.md`'s own `TAG="next"`/`TAG="latest"` case-statement (issue
   * #815's regression test asserts that literal text stays in the
   * workflow). Absent/undefined is falsy, never throws.
   */
  readonly nextChannel?: boolean;
  /**
   * Whether a workstream is active (#2994, final slice): `GSD_WORKSTREAM`
   * env, falling back to the stored active-workstream pointer — resolved by
   * the caller (`cmdInitTransition`/`cmdInitNewMilestone`, the init seam),
   * mirroring `cmdInitProgress`'s own established resolution of the same
   * question. Shared across two workflows' `cmdInit*` entry points (not
   * redefined per-caller). Absent/undefined is falsy, never throws.
   */
  readonly workstreamActive?: boolean;
  /**
   * Whether NO workstream is active — the positively-phrased INVERSE of
   * {@link workstreamActive} (#2994, final slice). The `when=` grammar has
   * no negation operator (ADR-1671:69), so a section whose true condition is
   * "skip when a workstream IS active" (`new-milestone.md`'s Step 4 Part A)
   * cannot negate `state:workstream-active` in its marker; a separate atom
   * whose fact is independently resolved to the inverse is the sanctioned
   * pattern instead. Resolved by the caller (`cmdInitNewMilestone`, the init
   * seam) as `!workstreamActive` from the SAME authoritative source.
   * Absent/undefined is falsy, never throws.
   */
  readonly flatMode?: boolean;
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
 * Safely tests whether `facts.flags` contains `flag`, tolerating an absent,
 * `null`, or non-`Set` (e.g. array) `flags` value without throwing —
 * `.has` is checked to be callable before it is called, rather than
 * assuming every {@link InvocationFacts.flags} is a real `Set` (totality
 * over facts; not duck-typed — an array `flags` degrades to "not present",
 * it is never iterated or `.includes`-checked).
 */
function hasFlag(facts: InvocationFacts, flag: string): boolean {
  return typeof facts.flags?.has === 'function' && facts.flags.has(flag) === true;
}

/**
 * Total map from each frozen {@link workflowFragments.WHEN_VOCABULARY}
 * entry to exactly one predicate over {@link InvocationFacts}. This is a
 * LOOKUP, never a parser — see the module doc comment's "The evaluator is a
 * LOOKUP, not a parser" section. Every entry is a hand-written literal; see
 * the module doc comment for why deriving a predicate from its atom string
 * is forbidden. Semantics confirmed against the section bodies themselves
 * (design doc "Semantics confirmed against the section bodies themselves,
 * not inferred from the id"):
 *
 * - `gap-closure-artifacts` — "For decimal/polish phases only (X.Y
 *   pattern) … Skip if phase number has no decimal" -> `state:gap-closure-phase`.
 * - `regression-gate` — "Skip if: this is the first phase (no prior
 *   phases)" -> `state:has-prior-phases`.
 * - `partial-wave` — "If `WAVE_FILTER` was used" -> `flag:--wave`.
 */
export const WHEN_PREDICATES: Readonly<Record<string, (facts: InvocationFacts) => boolean>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, (facts: InvocationFacts) => boolean>, {
    always: () => true,
    'flag:--wave': (facts: InvocationFacts) => hasFlag(facts, '--wave'),
    'state:gap-closure-phase': (facts: InvocationFacts) =>
      typeof facts.phaseNumber === 'string' && facts.phaseNumber.includes('.'),
    'state:has-prior-phases': (facts: InvocationFacts) => facts.hasPriorPhases === true,
    'flag:--auto': (facts: InvocationFacts) => hasFlag(facts, '--auto'),
    'flag:--discuss': (facts: InvocationFacts) => hasFlag(facts, '--discuss'),
    'flag:--fix': (facts: InvocationFacts) => hasFlag(facts, '--fix'),
    'flag:--forensic': (facts: InvocationFacts) => hasFlag(facts, '--forensic'),
    'flag:--ingest': (facts: InvocationFacts) => hasFlag(facts, '--ingest'),
    'flag:--prd': (facts: InvocationFacts) => hasFlag(facts, '--prd'),
    'flag:--research': (facts: InvocationFacts) => hasFlag(facts, '--research'),
    'flag:--research-phase': (facts: InvocationFacts) => hasFlag(facts, '--research-phase'),
    'flag:--reset-phase-numbers': (facts: InvocationFacts) => hasFlag(facts, '--reset-phase-numbers'),
    'flag:--reviews': (facts: InvocationFacts) => hasFlag(facts, '--reviews'),
    'flag:--validate': (facts: InvocationFacts) => hasFlag(facts, '--validate'),
    'state:auto-advance-active': (facts: InvocationFacts) => facts.autoAdvanceActive === true,
    'state:chunked-mode': (facts: InvocationFacts) => facts.chunkedMode === true,
    'state:fallow-enabled': (facts: InvocationFacts) => facts.fallowEnabled === true,
    'state:flat-mode': (facts: InvocationFacts) => facts.flatMode === true,
    'state:git-create-tag': (facts: InvocationFacts) => facts.gitCreateTag === true,
    'state:is-monorepo': (facts: InvocationFacts) => facts.isMonorepo === true,
    'state:needs-codebase-map': (facts: InvocationFacts) => facts.needsCodebaseMap === true,
    'state:next-channel': (facts: InvocationFacts) => facts.nextChannel === true,
    'state:phase-mvp-mode': (facts: InvocationFacts) => facts.phaseMvpMode === true,
    'state:plan-strategy-converge': (facts: InvocationFacts) => facts.planStrategyConverge === true,
    'state:reviewer-instances-configured': (facts: InvocationFacts) => facts.reviewerInstancesConfigured === true,
    'state:ui-phase-active': (facts: InvocationFacts) => facts.uiPhaseActive === true,
    'state:workstream-active': (facts: InvocationFacts) => facts.workstreamActive === true,
    'state:worktrees-enabled': (facts: InvocationFacts) => facts.worktreesEnabled === true,
  }),
);

// Coordinated-change guard, checked at module load: every entry of the
// frozen WHEN_VOCABULARY (imported, never redeclared — see module doc
// comment) must have exactly one predicate here, and vice versa. This is
// the load-bearing half of the DEFECT.GENERATIVE-FIX parity contract; the
// test-level half (50-test-matrix.md rows 21-23) additionally asserts it
// from the vocabulary's own export so a 5th vocabulary entry added without
// a predicate fails loudly rather than silently falling through to
// REASON.UNKNOWN_WHEN only at run time.
for (const when of workflowFragments.WHEN_VOCABULARY) {
  if (!Object.hasOwn(WHEN_PREDICATES, when)) {
    throw new Error(`section-manifest: WHEN_VOCABULARY entry "${when}" has no predicate in WHEN_PREDICATES`);
  }
}

// Reverse half of the same coordinated-change guard: every own key of
// WHEN_PREDICATES must also appear in WHEN_VOCABULARY. Without this, a
// predicate key with no vocabulary entry would let the evaluator accept an
// atom that the parser (classifyMarker) rejects — a real divergence between
// the two shared-constant halves (DEFECT.GENERATIVE-FIX; B9/B10 in
// `.gsd/phase/chore-2992-widen-when-vocabulary/50-test-matrix.md`).
const VOCABULARY_SET = new Set(workflowFragments.WHEN_VOCABULARY);
for (const predicateKey of Object.keys(WHEN_PREDICATES)) {
  if (!VOCABULARY_SET.has(predicateKey)) {
    throw new Error(`section-manifest: WHEN_PREDICATES entry "${predicateKey}" has no matching WHEN_VOCABULARY entry`);
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
    if (!Object.hasOwn(WHEN_PREDICATES, section.when)) {
      fail(REASON.UNKNOWN_WHEN, `section "${section.id}" has unrecognized when= value "${section.when}"`);
    }
    const predicate = WHEN_PREDICATES[section.when];
    if (predicate(facts)) {
      included.push(section.id);
    } else {
      excluded.push(section.id);
    }
  }

  return { included, excluded };
}
