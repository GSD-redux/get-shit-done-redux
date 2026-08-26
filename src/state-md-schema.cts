/**
 * STATE.md Field Schema — the one declaration (ADR-3473 §8.8, issue #3873).
 *
 * Phase 3 substrate. Before this module, "which STATE.md keys exist and what
 * they carry" was declared in THREE hand-maintained places that were already
 * observed to disagree (see the `last_activity` docstring below):
 *
 *   - `FIELD_CLASSIFICATION` (`src/state-transition.cts`) — source/preservation/
 *     guard/mergeStrategy per frontmatter key (ADR-1769 §4 / ADR-3408).
 *   - `FRONTMATTER_BODY_SOURCE` (`src/state-transition.cts`) — which BODY field
 *     a frontmatter key derives from.
 *   - `FRONTMATTER_KEY_TO_BODY_LABEL` (`src/state.cts`) — the Title-Case label
 *     a report speaks a preserved field in (ADR-3408 §8.4/§8.5).
 *
 * This module is the single row-per-key declaration those three now PROJECT
 * from at load time (`state-transition.cts` / `state.cts`), rather than
 * hand-maintaining a fourth copy of the same knowledge. Every exported shape
 * of the three original tables is unchanged — same keys, same key ORDER, same
 * frozen/null-prototype-ness — so every existing consumer (the preservation
 * dispatch loop, `getFieldClassification`, `getPreserveWhenUnchangedFields`,
 * `bodyLabelFor`, and issue #3872's `declaredLeavesOf`) keeps working without
 * an edit. See `.gsd/phase/feat-3873-state-md-schema/40-design.md`.
 *
 * LEAF MODULE, DELIBERATELY. This file imports from neither `state-transition.cts`
 * nor `state.cts` — both of those import THIS module, and either importing
 * back would be the exact CJS require-cycle `src/health-diagnostic-types.cts`'s
 * own docstring describes breaking for the health-diagnostic rule tables
 * (`module.exports` read before it is assigned, so a destructured value comes
 * back `undefined`). `FieldSource` / `FieldPreservation` / `FieldGuard` /
 * `FieldMergeStrategy` therefore live HERE now and are re-exported (by the same
 * name, so no importer of `state-transition.cts` needs to change) from
 * `state-transition.cts`.
 *
 * ADR-457 build-at-publish: source in `src/state-md-schema.cts`, compiled to
 * `gsd-core/bin/lib/state-md-schema.cjs` (gitignored).
 *
 * Design: .gsd/phase/feat-3873-state-md-schema/40-design.md
 * Test matrix: .gsd/phase/feat-3873-state-md-schema/50-test-matrix.md
 */

// ─── Closed vocabularies (moved from state-transition.cts, ADR-3408 Decision 1) ──
//
// Greenspun's Tenth Rule (ADR-3408 Decision 1): these are named members of a
// CLOSED vocabulary, never an open predicate slot. Adding a member to any of
// the four unions below is an amendment to ADR-3408, not a table edit —
// unchanged from their pre-#3873 home in `state-transition.cts`.

export type FieldSource =
  | 'body' // value is derived from a body field (Phase:, Status:, etc.)
  | 'disk' // value is derived from a disk scan (.planning/phases/* counts)
  | 'external' // value is derived from an external file (ROADMAP.md milestone)
  | 'curated' // value is set by humans/tools; preserve unless explicitly overwritten
  | 'free'; // caller's word is law (no preservation)

export type FieldPreservation =
  | 'derive' // always re-derive from source
  | 'preserve-when-unchanged' // #1230 delta heuristic: keep existing if body source field unchanged
  | 'preserve-always' // never overwrite unless the caller explicitly names this field
  | 'preserve-if-placeholder'; // overwrite only when derived value is a known placeholder (#948)
// ADR-3408 §8.6 amendment: 'clear' was deleted (no row used it, no executor
// existed) rather than implemented — Speculative Generality, a policy
// invented for a need that never arrived.

export type FieldGuard = 'non-sentinel-unknown';
export type FieldMergeStrategy = 'progress-ratchet';

/**
 * `status`'s closed lifecycle, as `normalizeStateStatus` (`src/state-document.cts`)
 * actually computes it — the function's default fallback plus each branch's
 * literal output, in the order the function tests them. This is NOT the raw
 * body prose vocabulary `CONTEXT.md`'s "STATE.md Status Lifecycle (ADR-2207)"
 * entry documents (`Ready to plan` → `All phases complete` → `<version>
 * milestone complete` → `Awaiting next milestone`, plus the handler-authored
 * strings in `KNOWN_TEMPLATE_DEFAULTS['Status']`) — that is free-form prose
 * `normalizeStateStatus` READS. This is the closed, seven-member set the
 * FRONTMATTER `status` key can actually hold once that function has run.
 */
export const STATUS_LIFECYCLE_ENUM = Object.freeze([
  'unknown',
  'paused',
  'executing',
  'planning',
  'discussing',
  'verifying',
  'completed',
] as const);

// ─── The schema row shape ───────────────────────────────────────────────────

export type StateFieldSchema = {
  type: 'string' | 'number' | 'boolean' | 'object';
  /** Closed value set (currently only `status`'s ADR-2207 lifecycle). */
  enum?: readonly string[];
  cardinality: 'one' | 'optional' | 'many';
  source: FieldSource;
  preservation: FieldPreservation;
  /** Closed vocabulary (see `FieldGuard` above). Adding a member is an ADR-3408 amendment. */
  guard?: FieldGuard;
  /** Closed vocabulary (see `FieldMergeStrategy` above). Same rule. */
  mergeStrategy?: FieldMergeStrategy;
  /** Which BODY field(s) this frontmatter key derives from, in fallback order. */
  bodySource?: readonly string[];
  /** The Title-Case label a preservation report speaks this field in. */
  bodyLabel?: string;
  /**
   * The value SHAPES a hand-written parser accepts for this field's body
   * source — a DECLARED SET, never a predicate (Greenspun's Tenth Rule/
   * ADR-3408 Decision 1 applies here too: this is data a test checks a parser
   * against, not executable matching logic the schema itself runs).
   */
  acceptedShapes?: readonly string[];
  /** Mirrors `buildStateFrontmatter`'s (`src/state.cts`) null-guards. */
  emitted: 'always' | 'when-present';
};

// ─── The one declaration ────────────────────────────────────────────────────
//
// Row order below is `FIELD_CLASSIFICATION`'s (`src/state-transition.cts`,
// pre-#3873) ORIGINAL literal order, verified by direct read and preserved
// deliberately: the `FIELD_CLASSIFICATION` projection built from this table
// (`state-transition.cts`) walks `Object.keys(STATE_FIELD_SCHEMA)` directly,
// so this row order IS that projection's key order, and key order is
// observable (the preservation dispatch loop iterates it). The two other
// projections (`FRONTMATTER_BODY_SOURCE`, `FRONTMATTER_KEY_TO_BODY_LABEL`) do
// NOT reuse this same order — their pre-#3873 literals were independently
// hand-written and already disagreed with each other and with this order (see
// each projection's own ordering constant in its home module) — so each
// projection module declares its OWN explicit key-order list rather than
// re-deriving order from this table's iteration, which would silently change
// two of the three tables' observable order out from under every consumer.
export const STATE_FIELD_SCHEMA: Readonly<Record<string, StateFieldSchema>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, StateFieldSchema>,
    {
      // Schema
      gsd_state_version: {
        type: 'string', cardinality: 'one', source: 'free', preservation: 'derive', emitted: 'always',
      } as StateFieldSchema,

      // Milestone (external — from ROADMAP.md)
      milestone: {
        type: 'string', cardinality: 'optional', source: 'external', preservation: 'preserve-if-placeholder', emitted: 'when-present',
      } as StateFieldSchema,
      milestone_name: {
        type: 'string', cardinality: 'optional', source: 'external', preservation: 'preserve-if-placeholder', emitted: 'when-present',
      } as StateFieldSchema,

      // Phase / plan position (body-derived)
      current_phase: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Current Phase']), bodyLabel: 'Current Phase', emitted: 'when-present',
      } as StateFieldSchema,
      current_phase_name: {
        type: 'string', cardinality: 'optional', source: 'curated', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Current Phase Name']), bodyLabel: 'Current Phase Name', emitted: 'when-present',
      } as StateFieldSchema,
      current_plan: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Current Plan']), bodyLabel: 'Current Plan',
        // #3784 (fixed 180d0dd0c): `advancePlanCore` reads the `Current Plan`
        // body field in exactly two value shapes — a bare number (`N`, paired
        // with a separate `Total Plans in Phase` field) and the hybrid compound
        // `N of M` (same field name, no `Total Plans in Phase` sibling — the
        // shape an agent wrote unprompted and every subsequent run inherited
        // the parse failure on). A THIRD spelling exists in the same fix —
        // `Plan: N of M` — but that is a DIFFERENT body field name
        // (`Plan`, not `Current Plan`) that `buildStateFrontmatter` never
        // reads into `current_plan` at all (verified: it calls
        // `stateExtractField(bodyContent, 'Current Plan')` only), so it is
        // deliberately NOT declared here — declaring it would assert a
        // frontmatter derivation this key does not have.
        acceptedShapes: Object.freeze(['N', 'N of M']),
        emitted: 'when-present',
      } as StateFieldSchema,

      // Status / lifecycle (body-derived; #1230 delta heuristic applies)
      // guard: the 'unknown' sentinel is the ONLY true executor-side guard in
      // this table (stopped_at's `## Session` scoping is caller-side delta
      // extraction, not an executor condition) — ADR-3408 Decision 1.
      status: {
        type: 'string', enum: STATUS_LIFECYCLE_ENUM, cardinality: 'one', source: 'body', preservation: 'preserve-when-unchanged',
        guard: 'non-sentinel-unknown', bodySource: Object.freeze(['Status']), bodyLabel: 'Status', emitted: 'always',
      } as StateFieldSchema,
      stopped_at: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Stopped At', 'Stopped at']), bodyLabel: 'Stopped At', emitted: 'when-present',
      } as StateFieldSchema,
      paused_at: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Paused At']), bodyLabel: 'Paused At', emitted: 'when-present',
      } as StateFieldSchema,

      // Activity log
      last_updated: {
        type: 'string', cardinality: 'one', source: 'free', preservation: 'derive', emitted: 'always',
      } as StateFieldSchema, // realClock.nowIso()
      // #3873: THE LIVE DISAGREEMENT. Pre-schema, `FRONTMATTER_BODY_SOURCE`
      // carried this key (`last_activity: ['Last Activity', 'Last activity']`)
      // while `FRONTMATTER_KEY_TO_BODY_LABEL` did NOT — same field, two
      // tables, two different answers to "does this key have a reportable
      // body label". Resolved by DECLARATION, not by picking whichever table
      // "looks right": `bodySource` is present below (this key IS derived from
      // a body field and `buildStateFrontmatter` — `src/state.cts` — reads it
      // via that exact two-case-variant fallback), and `bodyLabel` is
      // deliberately ABSENT, because that is what ships TODAY —
      // `last_activity`'s `preservation` is `'derive'`, never
      // `'preserve-when-unchanged'`, so it can never reach `bodyLabelFor`'s
      // (`src/state.cts`) `STATE_BODY_LABEL_UNWIRED_ROW` throw in the first
      // place; the absent label is inert, not a latent bug. Pinned by
      // `tests/state.test.cjs`'s pre-existing
      // `lastActivityLabelResolutionMatchesShippedBehavior`. Do NOT "tidy"
      // this by adding a label — that would be shipping a policy change
      // disguised as a consolidation, exactly the #3427 failure this epic is
      // named after.
      last_activity: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'derive',
        bodySource: Object.freeze(['Last Activity', 'Last activity']), emitted: 'when-present',
      } as StateFieldSchema, // always refresh on transition
      last_activity_desc: {
        type: 'string', cardinality: 'optional', source: 'body', preservation: 'preserve-when-unchanged',
        bodySource: Object.freeze(['Last Activity Description']), bodyLabel: 'Last Activity Description', emitted: 'when-present',
      } as StateFieldSchema,

      // Commit provenance (#2573) — ambient git read, recomputed on every write,
      // exactly like last_updated. Never preserved: a stale stamp would claim
      // STATE.md was written against a commit it wasn't.
      state_head: {
        type: 'string', cardinality: 'optional', source: 'free', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema, // #2573

      // Progress block (disk-derived, except the curated progress ratchet)
      // mergeStrategy: 'progress-ratchet' — completed_plans/completed_phases
      // only ever ratchet UP toward the derived value (#2969); everything
      // else in the merge is either always-derived (#2440) or always-curated.
      progress: {
        type: 'object', cardinality: 'optional', source: 'curated', preservation: 'preserve-always',
        mergeStrategy: 'progress-ratchet', emitted: 'when-present',
      } as StateFieldSchema, // #3242, #1446
      'progress.total_phases': {
        type: 'number', cardinality: 'optional', source: 'disk', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema,
      'progress.completed_phases': {
        type: 'number', cardinality: 'optional', source: 'disk', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema,
      'progress.total_plans': {
        type: 'number', cardinality: 'optional', source: 'disk', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema,
      'progress.completed_plans': {
        type: 'number', cardinality: 'optional', source: 'disk', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema,
      'progress.percent': {
        type: 'number', cardinality: 'optional', source: 'disk', preservation: 'derive', emitted: 'when-present',
      } as StateFieldSchema,
    } satisfies Record<string, StateFieldSchema>,
  ),
);
