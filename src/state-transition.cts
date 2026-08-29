/**
 * STATE.md Transition Module — ADR-1769.
 *
 * Phase 1 substrate: field-classification table, section constants, the pure
 * `transitionCore` dispatch, and the `beginPhase` intent (migrating
 * `cmdStateBeginPhase` in state.cts onto this seam).
 *
 * Sibling/super-module of the STATE.md Document Module (state-document.cjs):
 * consumes its `stateExtractField` / `stateReplaceField` primitives. Body
 * section headings live as constants here (single writer after migration).
 *
 * Pure core + injected I/O (ADR-1769 §3): the exported `transitionCore` is a
 * pure function `(content, intent, deps) → result`; adapters that own locks,
 * file I/O, and the disk-scan wrap it.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
import { stateReplaceField, stateExtractField, stateReplaceFieldIfTemplate, stateReplaceFieldWithFallback, stateReplaceFieldInSession, stateCurrentPositionSlice } from './state-document.cjs';
import { KNOWN_TEMPLATE_DEFAULTS, toFiniteNumber, computeProgressPercent } from './state-document.cjs';
import { tokenizeHeadings } from './markdown-sectionizer.cjs';
import type { HeadingToken } from './markdown-sectionizer.cjs';
import { deriveProgressFromRoadmap, clampPercent, clampPercentFromFraction } from './phase-lifecycle.cjs';
import { escapeRegex } from './pattern.cjs';
// #4129: the completion-ratio kernel for the resync-arm ratchet's percent
// (planning-scope's SCOPE — state-document's own dependency, no cycle here:
// state-document never imports this module).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateMdSchemaMod = require('./state-md-schema.cjs');
const { STATE_FIELD_SCHEMA } = stateMdSchemaMod;
type StateFieldSchema = stateMdSchemaMod.StateFieldSchema;

const { extractFrontmatter, reconstructFrontmatter, stripFrontmatter, FRONTMATTER_UNPARSEABLE } = frontmatter;

export function formatProgressMachineSegment(percent: number): string {
  // ADR-3180 Decision 7: rounding and the 100 ceiling belong to the
  // completion-ratio kernel. The floor is added here because this helper is
  // also fed persisted frontmatter values (hand-editable, unlike the
  // count-shaped entries into that kernel), and `'░'.repeat` throws on a
  // negative count. Bar and printed percent use the clamped value so the two
  // halves of the segment can never disagree.
  const clamped = Math.max(0, clampPercentFromFraction(percent / 100));
  const filled = Math.round(clamped / 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${clamped}%`;
}

// Consumers (a future STATE.md writer that bypasses all three reintroduces the
// #4213 divergence class): `cmdStateUpdateProgress` and `syncCore`'s progress
// intent (both in this module) plus the post-sync body reconciliation in
// `applyPostSyncPreservation` (src/state.cts). `cmdStateSync` never reaches
// that reconciliation — ADR-3408 §8.3: `state sync` lets the body win, so
// preservation must NOT run — which is why its correctness comes from
// `syncCore`'s call here.
export function stateReplaceProgressPercent(content: string, percent: number): string | null {
  const body = stripFrontmatter(content);
  // #2177: bold `**Progress:**` anywhere in the body wins outright; the plain
  // `^Progress:` form is the fallback only when no bold line exists, so an
  // earlier free-text line starting with `Progress:` cannot capture the
  // rewrite ahead of the real status line.
  const boldProgressPattern = /(\*\*Progress:\*\*[ \t]*)([^\r\n]*)/i;
  const plainProgressPattern = /^(Progress:[ \t]*)([^\r\n]*)/im;
  const pattern = boldProgressPattern.test(body)
    ? boldProgressPattern
    : plainProgressPattern.test(body)
      ? plainProgressPattern
      : null;
  if (!pattern) return null;
  const machineSegment = /(?:\[[^\]\r\n]*\][ \t]*)?\d{1,3}%/;
  const progress = formatProgressMachineSegment(percent);
  const updatedBody = body.replace(pattern, (_match: string, prefix: string, value: string) => (
    `${prefix}${machineSegment.test(value) ? value.replace(machineSegment, progress) : progress}`
  ));
  return content.slice(0, content.length - body.length) + updatedBody;
}

/**
 * ADR-3473 §8.1 (#3881, consequence 2 wiring): does `existingFm` carry the
 * `FRONTMATTER_UNPARSEABLE` marker `extractFrontmatter` sets when a
 * frontmatter-fenced region exists but failed to parse (malformed YAML, or a
 * refused anchor/alias/merge key)? A plain `Object.keys(existingFm).length >
 * 0` check cannot distinguish that case from "no frontmatter block at all" —
 * both parse to `{}` — so every `hasFrontmatter`-gated reassemble below would
 * silently drop the raw frontmatter block on the next write. The marker is a
 * non-enumerable-to-Object.keys Symbol key, so this check is additive and
 * never fires for the genuinely-empty case.
 */
function isUnparseableFrontmatter(existingFm: Record<string, unknown>): boolean {
  return (existingFm as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true;
}

/**
 * ADR-3473 §8.1 (#3881): the exact bytes `stripFrontmatter` removed from the
 * front of `content` to produce `strippedBody` — i.e. `content`'s raw
 * frontmatter-fenced prefix, verbatim, whether or not it parsed. Reassembling
 * with this prefix (instead of dropping it under `hasFrontmatter === false`)
 * is what preserves an UNPARSEABLE frontmatter block across a write; it is a
 * no-op difference from `content` itself when `strippedBody === content`
 * (nothing was stripped).
 */
function rawFrontmatterPrefix(content: string, strippedBody: string): string {
  return content.slice(0, content.length - strippedBody.length);
}

/**
 * Shared frontmatter-strip-and-reassemble preamble (#3881 review, finding 5): the
 * `existingFm` / `hasFrontmatter` / `stripFrontmatter` / `fmPrefix` / `unparseableFm` /
 * `reassemble` block above was copy-pasted at every `*Core` transition below (and, before
 * this change, hand-inlined a sixth time in `state.cts`'s `cmdStateCompletePhase` instead of
 * importing `isUnparseableFrontmatter`/`rawFrontmatterPrefix`). One helper, one place to fix
 * the frontmatter-preservation contract. `reassemble` is parameterized on the (possibly
 * further-mutated) body rather than closing over it, matching every call site's existing
 * usage — several reassign `body` after this preamble runs and reassemble the FINAL body,
 * not the one captured here.
 */
export type FrontmatterReassembly = {
  existingFm: Record<string, unknown>;
  hasFrontmatter: boolean;
  body: string;
  fmPrefix: string;
  unparseableFm: boolean;
  reassemble: (b: string) => string;
};

export function beginFrontmatterReassembly(
  content: string,
  sourcePath?: string,
): FrontmatterReassembly {
  const existingFm = extractFrontmatter(content, sourcePath) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  const body = stripFrontmatter(content);
  // ADR-3473 §8.1 (#3881): computed from the ORIGINAL content/body pair, before any caller
  // reassigns `body` further — the captured prefix is always the exact bytes stripped from
  // the ORIGINAL content, regardless of what the caller does with `body` afterward.
  const fmPrefix = rawFrontmatterPrefix(content, body);
  const unparseableFm = isUnparseableFrontmatter(existingFm);
  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
      : unparseableFm
        ? `${fmPrefix}${b}`
        : b;
  return { existingFm, hasFrontmatter, body, fmPrefix, unparseableFm, reassemble };
}

// Stop predicate for section-body slicing: a level-2+ heading ends the section.
const STOP_H2_PLUS = (lv: number): boolean => lv >= 2;

// ----------------------------------------------------------------------------
// Field-classification table (ADR-1769 §4)
// ----------------------------------------------------------------------------
//
// Two-column shape per ADR: `{ source, preservation }`. Source alone is
// insufficient because two fields can share a source but need different
// preservation rules (e.g. `current_phase` and `last_activity` are both
// `derived-from-body`, but `current_phase` preserves-when-unchanged per #1230
// while `last_activity` always re-derives). Codex review of Phase 1 caught
// the collapsed-enum shape as a substrate defect that wouldn't survive
// Phases 2–7.

/**
 * #3873 (ADR-3473 §8.8): the four closed vocabularies below moved to
 * `src/state-md-schema.cts` — the leaf module `FIELD_CLASSIFICATION`'s
 * projection is now derived from — and are re-exported here BY THE SAME NAME
 * so no existing importer of this module needs to change (`state.cts`
 * consumes them via `stateTransitionMod.FieldSource` etc., the namespace
 * access pattern this module's plain `export type` already supported before
 * this move). See `state-md-schema.cts` for the full ADR-3408 Decision 1
 * ("Greenspun's Tenth Rule" — closed vocabulary, never an open predicate slot)
 * docstring these four used to carry directly.
 */
export type FieldSource = stateMdSchemaMod.FieldSource;
export type FieldPreservation = stateMdSchemaMod.FieldPreservation;
export type FieldGuard = stateMdSchemaMod.FieldGuard;
export type FieldMergeStrategy = stateMdSchemaMod.FieldMergeStrategy;

export type FieldClassification = {
  source: FieldSource;
  preservation: FieldPreservation;
  /** Closed vocabulary (see the comment above). Adding a member is an ADR-3408 amendment, not a table edit. */
  guard?: FieldGuard;
  /** Closed vocabulary. Same rule. */
  mergeStrategy?: FieldMergeStrategy;
};

/**
 * Single source of truth for "which fields win when frontmatter and body
 * disagree". Transitions declare which body fields they touch; the core
 * consults the table to apply the preservation policy uniformly.
 *
 * Adding a new STATE.md field = one row here, not 9 transition edits.
 *
 * Field set verified against `buildStateFrontmatter` (state.cts:1474) — every
 * frontmatter key emitted there has a row here.
 *
 * Frozen null-prototype object: prevents prototype-pollution lookups
 * (`FIELD_CLASSIFICATION['toString']` returns undefined, not the inherited
 * function). Use `getFieldClassification()` for lookups.
 */
/**
 * #3873 (ADR-3473 §8.8): PROJECTED from `STATE_FIELD_SCHEMA`
 * (`src/state-md-schema.cts`) rather than hand-maintained here. Byte-identical
 * to the pre-#3873 literal table — same 19 keys, same key ORDER (walks
 * `Object.keys(STATE_FIELD_SCHEMA)` directly; see that module's row-order
 * comment for why this is the one projection allowed to do that), same
 * per-row shape (`{source, preservation, guard?, mergeStrategy?}`, in that
 * key order, `guard`/`mergeStrategy` present only when the schema row carries
 * them — never as an `undefined` own-property), same frozen null-prototype
 * container. Pinned by `tests/state-transition.test.cjs`'s
 * `fieldClassificationProjectionMatchesTodaysTable`, whose comparand is
 * today's literal copied VERBATIM into the test (never re-derived from this
 * schema — see that test's own docstring on why a self-referential parity
 * test proves nothing).
 */
export const FIELD_CLASSIFICATION: Readonly<Record<string, FieldClassification>> = Object.freeze(
  Object.keys(STATE_FIELD_SCHEMA).reduce((acc, key) => {
    const row: StateFieldSchema = STATE_FIELD_SCHEMA[key];
    const projected: FieldClassification = { source: row.source, preservation: row.preservation };
    if (row.guard !== undefined) projected.guard = row.guard;
    if (row.mergeStrategy !== undefined) projected.mergeStrategy = row.mergeStrategy;
    acc[key] = projected;
    return acc;
  }, Object.create(null) as Record<string, FieldClassification>),
);

/**
 * Which BODY field feeds each frontmatter key.
 *
 * `FIELD_CLASSIFICATION` above answers "who wins when frontmatter and body
 * disagree"; this answers "and what is the body one called". They are separate
 * questions and this one is display/routing knowledge, not preservation policy,
 * so it does not widen the ADR-3408-governed table.
 *
 * #3699: `state update stopped_at …` reported `Field "stopped_at" not found in
 * STATE.md` — byte-identical to what a genuinely absent field reports. The key
 * IS present; it is a projection of a body field, and the message pointed away
 * from the route that works. Naming the source is what makes the two cases
 * distinguishable.
 *
 * Transcribed from `buildStateFrontmatter` (`state.cts`), which is the real
 * deriver. That makes this a SECOND copy of knowledge that already exists, so it
 * ships with a parity test asserting this key set equals the body-derived key set
 * the builder actually emits (CLAUDE.md → Generative Fix Divergence). Keys the
 * builder derives from disk, an external file, or the clock have no body source
 * and are deliberately ABSENT here rather than mapped to a lie.
 */
/**
 * #3873 (ADR-3473 §8.8): PROJECTED from `STATE_FIELD_SCHEMA`
 * (`src/state-md-schema.cts`)'s `bodySource` field, in this EXPLICIT key
 * order. This order is NOT `STATE_FIELD_SCHEMA`'s own row order filtered down
 * to the body-sourced keys — the pre-#3873 literal already put `status`
 * before `stopped_at`/`paused_at` here while `FRONTMATTER_KEY_TO_BODY_LABEL`
 * (`src/state.cts`) put it AFTER them, i.e. the two pre-existing tables
 * disagreed with each other's order too, and this projection must reproduce
 * ITS table's order specifically. Byte-identical to the pre-#3873 literal —
 * same 8 keys, same order, same frozen null-prototype container with frozen
 * per-key arrays. Pinned by `tests/state-transition.test.cjs`'s
 * `bodySourceProjectionMatchesTodaysTable`.
 */
const FRONTMATTER_BODY_SOURCE_KEY_ORDER = Object.freeze([
  'current_phase',
  'current_phase_name',
  'current_plan',
  'status',
  'stopped_at',
  'paused_at',
  'last_activity',
  'last_activity_desc',
] as const);

export const FRONTMATTER_BODY_SOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  FRONTMATTER_BODY_SOURCE_KEY_ORDER.reduce((acc, key) => {
    const row: StateFieldSchema = STATE_FIELD_SCHEMA[key];
    acc[key] = Object.freeze([...(row.bodySource ?? [])]);
    return acc;
  }, Object.create(null) as Record<string, readonly string[]>),
);

/**
 * The frontmatter keys whose body source lives inside `## Session`.
 *
 * #3374 established that these fields must be written where the reader reads
 * them: `buildStateFrontmatter` harvests `Stopped At` / `Paused At` from the
 * session section only, so a whole-body replace "lets a decoy `**Stopped at:**`
 * line in an unrelated (e.g. archive) section absorb the refresh while the
 * harvested session value stays stale" (`stateReplaceFieldInSession`'s own
 * docstring). `updateCore` was still doing the whole-body replace.
 */
const SESSION_SCOPED_KEYS: ReadonlySet<string> = new Set(['stopped_at', 'paused_at']);

/**
 * The `(primary, fallback)` label pair for a session-scoped frontmatter KEY.
 */
function sessionLabelsForKey(key: string): { primary: string; fallback: string | null } | null {
  if (!SESSION_SCOPED_KEYS.has(key)) return null;
  const labels = FRONTMATTER_BODY_SOURCE[key];
  return { primary: labels[0], fallback: labels[1] ?? null };
}

/**
 * The same pair, resolved from a BODY LABEL the caller named (`Stopped At`,
 * `Stopped at`, `Paused At`). `null` for anything else.
 *
 * Deliberately does NOT accept a frontmatter key. An earlier cut resolved both
 * spellings through one function and used it for the write, which made
 * `state update stopped_at …` write the BODY line through the session writer —
 * silently defeating the "frontmatter keys are not directly writable" contract
 * this whole change exists to state, and reporting `updated: false` while having
 * written. The write may only ever be reached by naming a body field.
 */
function sessionLabelsForBodyField(field: string): { primary: string; fallback: string | null } | null {
  const key = frontmatterKeyForBodyField(field);
  return key === null ? null : sessionLabelsForKey(key);
}

/**
 * Would a session-scoped write actually land? Asks by attempting the real write
 * with a throwaway value and seeing whether anything moved.
 *
 * Deliberately reuses the writer rather than re-deriving "where is the session
 * section" — a separate scope check could disagree with the writer, and a
 * presence check that disagrees with the write it guards is the whole bug class
 * here. `stateReplaceFieldInSession` is replace-only and pure, so probing costs
 * nothing and the result is discarded.
 */
function sessionSourceExists(body: string, labels: { primary: string; fallback: string | null }): boolean {
  return stateReplaceFieldInSession(body, labels.primary, labels.fallback, '\u0000probe') !== body;
}

/**
 * Own-property body-source lookup. `null` for a key with no body source (a
 * disk/external/clock-derived key) and for anything not a frontmatter key.
 */
export function getFrontmatterBodySource(field: string): readonly string[] | null {
  if (!Object.prototype.hasOwnProperty.call(FRONTMATTER_BODY_SOURCE, field)) return null;
  return FRONTMATTER_BODY_SOURCE[field];
}

/**
 * Reverse lookup: the frontmatter key a body field feeds, or `null`.
 * Lets a failed body-field update name the frontmatter key that still carries a
 * value (#3699 case D), instead of reporting a bare absence.
 */
export function frontmatterKeyForBodyField(bodyField: string): string | null {
  const wanted = bodyField.trim().toLowerCase();
  for (const key of Object.keys(FRONTMATTER_BODY_SOURCE)) {
    if (FRONTMATTER_BODY_SOURCE[key].some((f) => f.toLowerCase() === wanted)) return key;
  }
  return null;
}

/**
 * Own-property classification lookup. Returns `null` for unknown fields
 * (including inherited prototype methods like `toString`/`valueOf`).
 */
export function getFieldClassification(field: string): FieldClassification | null {
  if (!Object.prototype.hasOwnProperty.call(FIELD_CLASSIFICATION, field)) return null;
  return FIELD_CLASSIFICATION[field];
}

/**
 * #3836: the single source of truth for "which frontmatter keys carry the
 * `preserve-when-unchanged` policy" — read straight off `FIELD_CLASSIFICATION`
 * rather than re-typed as a hand-maintained literal array at each consumer.
 * `cmdStateJson` (`state.cts`) previously hardcoded a 6-field list that had
 * already drifted from this table by one row (`last_activity_desc`, #3258) —
 * exactly the "second table parallel to the first" shape ADR-3473 exists to
 * remove. `progress`/`milestone`/`milestone_name` carry a different
 * preservation policy (`preserve-always` / `preserve-if-placeholder`) and are
 * naturally excluded by the filter, not by a separate exclusion list.
 */
export function getPreserveWhenUnchangedFields(): readonly string[] {
  return Object.keys(FIELD_CLASSIFICATION).filter(
    (field) => FIELD_CLASSIFICATION[field].preservation === 'preserve-when-unchanged',
  );
}

// ----------------------------------------------------------------------------
// The state transaction (ADR-3473 §8.6, issue #3871)
// ----------------------------------------------------------------------------
//
// Collapses the two-field `preFm` / `preFmSnapshot` shape (same source, same
// arguments, same `extractFrontmatter` call — `preFm` was `preFmSnapshot` with
// a policy flag baked in by nulling it on `resync`) into ONE snapshot plus a
// typed constructor pair that names the policy explicitly instead of encoding
// it as a null. See `.gsd/phase/feat-3871-state-transaction-snapshot/40-design.md`.

/** The two sanctioned write-path kinds (ADR-3408 §8.3's closed exception list, typed). */
export type StateTransactionKind = 'open' | 'rebuild';

export type StateBodyDelta = { pre: string | null; post: string | null };

export type StateTransactionInit = {
  /** Pre-write frontmatter snapshot. `{}` is legal (see `createStateTransaction`). */
  snapshot: Record<string, unknown>;
  resync?: boolean;
  deriveProgressKeys?: boolean;
  bodyDeltas?: Record<string, StateBodyDelta>;
  /**
   * True ONLY when `resync` is true BECAUSE the caller explicitly named a
   * progress-affecting field (`state update Progress`, `state patch
   * Progress=...` / `Total Plans in Phase` / `Total Phases` —
   * `shouldResyncStateProgress`, state.cts), as opposed to `resync`
   * defaulting true for an unrelated write. See `applyPreserveAlways`'s use
   * of this flag for why the distinction matters (found while diagnosing a
   * regression against the pre-existing #3242 "resyncs progress frontmatter
   * from the updated body" spec, tests/frontmatter.test.cjs).
   */
  explicitProgressField?: boolean;
};

export type StateTransaction = {
  readonly kind: StateTransactionKind;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly resync: boolean;
  readonly deriveProgressKeys: boolean;
  readonly bodyDeltas?: Readonly<Record<string, StateBodyDelta>>;
  readonly explicitProgressField: boolean;
};

/**
 * Shared constructor body for `openStateTransaction` / `rebuildStateTransaction`
 * (ADR-3473 §8.6 Decision 2/3). Validates `init.snapshot` and freezes the
 * result so nothing downstream can mutate a transaction after construction
 * (this is what makes the aliasing fix in `applyPreserveAlways`'s clone hold:
 * the snapshot a caller passed in cannot be rewritten out from under it).
 *
 * `{}` and a null-prototype object are BOTH legal snapshots (Decision 2 / row
 * 15 of the behavior table): `extractFrontmatter` returns `{}` for a document
 * with no frontmatter or an unterminated one and never returns null or throws
 * (`src/frontmatter.cts`), so `{}` is the honest snapshot of a real document —
 * and `/gsd-health --repair`, which runs precisely when STATE.md is broken,
 * depends on that staying legal. What is NOT legal is the snapshot being
 * ABSENT (`null`/`undefined`/an array/a non-object): that is the caller
 * forgetting to read the pre-write document at all, a construction failure,
 * not a data question. Conflating "absent" with "empty" would turn the repair
 * path's normal case into a hard throw.
 */
function createStateTransaction(kind: StateTransactionKind, init: StateTransactionInit, ctorName: string): StateTransaction {
  if (init === null || typeof init !== 'object' || Array.isArray(init)) {
    const err = new Error(
      `${ctorName}: expected an init object, got ${init === null ? 'null' : typeof init}. ` +
      'Per ADR-3473 §8.6 / Decision 2, an absent init is a construction failure, distinct from ' +
      'a legal empty snapshot ({}) — do not "fix" this by tolerating null.',
    ) as Error & { code: string; constructorName: string };
    err.code = 'STATE_TRANSACTION_SNAPSHOT_REQUIRED';
    err.constructorName = ctorName;
    throw err;
  }
  const snapshot = init.snapshot;
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    const err = new Error(
      `${ctorName}: init.snapshot is required and must be a non-array object (frontmatter map). ` +
      `Per ADR-3473 §8.6 / Decision 2, an ABSENT snapshot is a construction failure — this is NOT ` +
      'the same as a legal EMPTY snapshot ({}), which every executor accepts and simply finds ' +
      'nothing to restore from (extractFrontmatter returns {} for a document with no parseable ' +
      'frontmatter, and /gsd-health --repair depends on that staying legal). Pass {} explicitly ' +
      'when the document truly has none; do not tolerate null/undefined here.',
    ) as Error & { code: string; constructorName: string };
    err.code = 'STATE_TRANSACTION_SNAPSHOT_REQUIRED';
    err.constructorName = ctorName;
    throw err;
  }
  return Object.freeze({
    kind,
    snapshot,
    resync: init.resync === true,
    deriveProgressKeys: init.deriveProgressKeys === true,
    bodyDeltas: init.bodyDeltas,
    explicitProgressField: init.explicitProgressField === true,
  });
}

/**
 * ADR-3473 §8.6's `open()`: the default write-path transaction. Carries the
 * pre-write snapshot and applies preservation (`applyStatePreservation` runs
 * its full dispatch loop against it) — this is every STATE.md write EXCEPT
 * the two sanctioned exceptions below.
 */
export function openStateTransaction(init: StateTransactionInit): StateTransaction {
  return createStateTransaction('open', init, 'openStateTransaction');
}

/**
 * ADR-3473 §8.6's `rebuild()`: the TYPED expression of ADR-3408 §8.3's closed
 * list of sanctioned exceptions to the preservation pipeline. Exactly two
 * callers may construct this: `cmdStateSync` (`state sync` re-derives
 * frontmatter FROM the body per #905 — the body is authoritative and
 * preservation would fight it) and `REGENERATE_STATE` (`/gsd-health --repair`'s
 * factory reset — the whole point is to replace what's there). The snapshot
 * is still carried (for §8.7's reporting) but `applyStatePreservation` skips
 * its dispatch loop entirely for a `rebuild` transaction.
 *
 * This list is NOT debt to be paid down later — it is a closed, deliberate
 * set. Adding a third caller is an amendment to ADR-3408 §8.3, not a call site
 * convenience.
 */
export function rebuildStateTransaction(init: StateTransactionInit): StateTransaction {
  return createStateTransaction('rebuild', init, 'rebuildStateTransaction');
}

// ----------------------------------------------------------------------------
// applyStatePreservation — table-driven post-sync preservation (ADR-1769 #1796)
// ----------------------------------------------------------------------------
//
// Absorbs the post-sync preservation block that previously lived inline in
// `readModifyWriteStateMd` (state.cts). One pure, field-classification-table-
// driven implementation replaces the three drifting encodings (the RMW post-sync
// block, `syncStateFrontmatter`, and `cmdStateBuildFrontmatter`'s read-path
// copy). Every preserved field — progress, status, stopped_at, current_phase_name
// — is governed by its FIELD_CLASSIFICATION row, so a policy change is a one-row
// table edit rather than a per-call-site patch. Behavior is byte-identical to
// the pre-#1796 inline block; this is the consolidation ADR-1769 / CONTEXT.md
// already claimed shipped. See issue #1796 (Path A: finish the consolidation).

/**
 * ADR-3473 §8.6: the whole pre-write policy — snapshot, resync, deriveProgressKeys,
 * bodyDeltas — now travels as ONE `StateTransaction` (see `openStateTransaction`
 * / `rebuildStateTransaction` above), rather than as four separate fields the
 * caller could set inconsistently (the `preFm`/`preFmSnapshot` split this
 * replaces was exactly that: the same snapshot with a policy flag baked in by
 * nulling one copy of it on resync).
 */
export type StatePreservationInput = {
  transaction: StateTransaction;
  /** Post-`syncStateFrontmatter` frontmatter (the freshly recomputed one). */
  postFm: Record<string, unknown>;
};

export type StatePreservationResult = {
  postFm: Record<string, unknown>;
  mutated: boolean;
};

/**
 * Mutable, single-write dispatch context threaded through every policy
 * executor below. `mutated` accumulates across the whole field loop (ADR-3408
 * §8.1 — one executor per policy, sharing one result).
 */
export type PreservationCtx = {
  postFm: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  resync: boolean;
  deriveProgressKeys: boolean;
  bodyDeltas: Record<string, { pre: string | null; post: string | null }> | undefined;
  mutated: boolean;
  /** See `StateTransactionInit.explicitProgressField`. Defaults false for a
   * plain `PreservationCtx` built outside a `StateTransaction` (e.g.
   * `cmdStateJson`'s direct `applyPreserveWhenUnchanged` call, row 19 of the
   * behavior table) — that read path never reaches `applyPreserveAlways`. */
  explicitProgressField?: boolean;
};

/**
 * ADR-3408 §8.2: an unenforced `preserve-when-unchanged` row throws. Both
 * ends of this invariant are gsd-core's own source — a declared row the
 * *caller code* forgot to wire via `bodyDeltas` — so it is a programming
 * error, unreachable from any user document. The bright line, stated because
 * conflating its two sides would be severe: a drifted, malformed, or
 * unparseable user STATE.md NEVER reaches this throw (§8.5 governs that case
 * with preserve-and-warn); this fires only when the *caller* omitted a
 * `bodyDeltas` entry for a row the table itself declares. Getting this
 * backwards turns every desynced project's `phase.complete` into a hard
 * failure.
 */
function throwUnwiredRow(field: string): never {
  const err = new Error(
    `applyStatePreservation: preserve-when-unchanged row ${JSON.stringify(field)} reached the ` +
    'executor with no wired ctx.bodyDeltas entry. This is an internal invariant violation (ADR-3408 ' +
    '§8.2) — the caller (readModifyWriteStateMd) forgot to supply this field\'s body-source delta. ' +
    'Add a bodyDeltas entry for this field per ADR-3408 §8.3, or remove the row from ' +
    'FIELD_CLASSIFICATION if the field no longer needs this policy.',
  ) as Error & { code: string; field: string };
  err.code = 'STATE_PRESERVATION_UNWIRED_ROW';
  err.field = field;
  throw err;
}

/**
 * Executor for `preservation: 'preserve-when-unchanged'` (ADR-3408 §8.1). The
 * #1230 delta heuristic: restore the pre-write frontmatter snapshot when this
 * write did not change the field's body source, and the snapshot is a real
 * (non-empty-after-trim) curated value the derived value should not clobber.
 *
 * Every row carrying this policy — status, stopped_at, current_phase_name,
 * current_phase, current_plan, paused_at, last_activity_desc — is honored by
 * this ONE executor; `cls.guard` is the only field-specific variation (the
 * closed vocabulary of ADR-3408 Decision 1).
 *
 * Exported (ADR-3408 §8.5 / D3) so `cmdStateJson` (state.cts) — a read-only
 * path with no transform of its own — can route its stale-vs-fresh decision
 * through the SAME executor the write path uses, rather than maintaining a
 * third private copy of this policy. `cmdStateJson` calls this directly
 * (not the full `applyStatePreservation` dispatch loop) so its read stays
 * scoped to exactly the fields it has always governed and never touches
 * `progress` or `milestone*`, which are different policies with their own
 * read-path rules (`shouldPreserveExistingProgress`, `preserve-if-placeholder`).
 */
export function applyPreserveWhenUnchanged(field: string, cls: FieldClassification, ctx: PreservationCtx): void {
  // 1. A declared row with no wired delta is an internal invariant violation
  // — throw (ADR-3408 §8.2). Never reached for a user-document defect: the
  // production caller (readModifyWriteStateMd) wires every preserve-when-
  // unchanged row unconditionally.
  const delta = ctx.bodyDeltas ? ctx.bodyDeltas[field] : undefined;
  if (!delta) throwUnwiredRow(field);

  // 2. Only a real, non-whitespace-only curated string is worth restoring
  // (#3468: tightened from `.length > 0` to a trimmed check — a whitespace-
  // only snapshot is not a real curated value).
  const snapshot = ctx.snapshot[field];
  if (typeof snapshot !== 'string' || snapshot.trim().length === 0) return;

  // 3. Closed-vocabulary guard: status's 'unknown' sentinel is never restored.
  // Exact-match, case-sensitive — 'Unknown' is a real value and IS restored.
  if (cls.guard === 'non-sentinel-unknown' && snapshot === 'unknown') return;

  // 4. The body source changed this write → the freshly-derived value wins.
  if (delta.pre !== delta.post) return;

  // 5. Already correct → no-op (avoid a spurious `mutated=true`).
  if (ctx.postFm[field] === snapshot) return;

  // 6. Restore.
  ctx.postFm[field] = snapshot;
  ctx.mutated = true;
}

/**
 * The closed set of `progress` keys whose non-zero value means "a real
 * measurement happened" (ADR-3473 §8.6 / #3756).
 */
const PROGRESS_TOTAL_KEYS = ['total_phases', 'total_plans'] as const;

/**
 * Did this row's derived (or curated) value represent a REAL measurement?
 *
 * For a `progress-ratchet` row (today, only `progress`): an empty
 * milestone-scoped scan is "nothing was measured", not "zero is done"
 * (#3756, and the convention #3233 established — `computeProgressPercent`
 * already returns `null` for an empty denominator). Only the TOTALS decide:
 * `completed_*` being zero is normal for a real project, so it is
 * deliberately excluded from this check. A non-object / absent / negative /
 * non-numeric total is NOT a measurement, so it degrades TOWARD preservation,
 * never toward deletion — `toFiniteNumber` (not a raw `=== 0`/`> 0` test)
 * because frontmatter scalars arrive as STRINGS (`"0"`, not `0`).
 *
 * For any other row (no `progress-ratchet` strategy) the question is
 * meaningless, so it answers `true` and behavior is unchanged — this
 * function is only ever consulted from inside the `preserve-always` /
 * `progress-ratchet` branch below.
 */
function scanMeasuredSomething(cls: FieldClassification, value: unknown): boolean {
  if (cls.mergeStrategy !== 'progress-ratchet') return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return PROGRESS_TOTAL_KEYS.some((k) => (toFiniteNumber(rec[k]) ?? 0) > 0);
}

/**
 * Deep-clone a curated value before it re-enters `postFm` (ADR-3473 §8.6,
 * "Defects fixed inline" / aliasing). `structuredClone` is a Node built-in;
 * this repo takes no external deps for it. WHY a clone and not a reference
 * assignment: the transaction's `snapshot` is now the SAME object §8.7's
 * reporting will diff against. Assigning the nested curated object by
 * reference would make `postFm.progress` alias that snapshot, so a later
 * in-place mutation of `postFm` would silently rewrite the snapshot too, and
 * the diff would report "no change" for a field that did change.
 */
function cloneCurated(value: unknown): unknown {
  return structuredClone(value);
}

/**
 * Structural equality for a restored value vs. what `postFm` already held
 * (ADR-3473 §8.6, "Defects fixed inline" / #948 no-op-write family).
 * `JSON.stringify` compare when either side is an object (the `progress`
 * block), `===` otherwise. WHY: `applyPreserveAlways` previously set
 * `ctx.mutated = true` unconditionally at its tail, even when it restored a
 * value identical to what was already there — driving a write that changes
 * nothing but still bumps `last_updated` / restamps `state_head`.
 * `applyPreserveWhenUnchanged` already guards this (its step 5); this brings
 * the two executors into agreement.
 */
function preservedValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * #4129: the resync-arm progress merge. A resyncing write whose scan MEASURED
 * something no longer wholesale-replaces the curated block — the declared
 * `progress-ratchet` mergeStrategy ("completed_plans/completed_phases only ever
 * ratchet UP toward the derived value (#2969)", state-md-schema.cts) now holds
 * on the write path too, matching what the read path (`shouldPreserveExistingProgress`)
 * has always enforced. Rules, mirroring the `deriveProgressKeys` branch above:
 *
 * - total_plans / total_phases always take the derived value (#2440 — totals
 *   correct in BOTH directions).
 * - completed_plans / completed_phases take the derived value only when it is
 *   strictly GREATER (#2969's `>` not `>=`); else the curated value survives
 *   (a hand-corrected or previously-correct counter can never be re-derived
 *   downward — the #4129 clobber).
 * - any other key keeps the curated value (the existing branch's convention).
 * - percent is RECOMPUTED from the merged counters through the single kernel
 *   (`computeProgressPercent`), because either side's stored percent was
 *   computed against that side's counters and the merged block may mix them
 *   (curated completed, derived totals). Recomputation runs ONLY when the
 *   derived block itself carried a percent — an upstream withhold
 *   (#1761 milestone-unbounded, #3217 scope) nulled percent deliberately and
 *   this merge must not resurrect it.
 *
 * Frontmatter scalars arrive as STRINGS ("2", not 2), so every comparison
 * coerces through `toFiniteNumber` — never a `typeof === 'number'` test
 * (scanMeasuredSomething's own convention).
 */
function mergeResyncProgressRatchet(
  curatedRecord: Record<string, unknown>,
  derivedRecord: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...derivedRecord };
  for (const [key, value] of Object.entries(curatedRecord)) {
    if (key === 'total_plans' || key === 'total_phases' || key === 'percent') continue;
    if (key === 'completed_plans' || key === 'completed_phases') {
      const derivedNum = toFiniteNumber(derivedRecord[key]) ?? -Infinity;
      const curatedNum = toFiniteNumber(value) ?? -Infinity;
      // Ratchet up only (strictly greater, #2969); else keep curated.
      if (derivedNum > curatedNum) continue;
      // Numerically EQUAL keeps the derived value VERBATIM. The two sides
      // arrive in different scalar shapes (the re-parsed derived block
      // carries string totals "2" while the curated snapshot carries numbers
      // 2), and substituting the curated spelling over an equal derived one
      // is a no-op in substance but a shape churn the §8.7 reporting loop
      // would surface as a phantom `preserved-over-disagreeing-derived`
      // warning (it diffs structurally). Only a curated counter that is
      // STRICTLY greater replaces the derived value.
      if (derivedNum === curatedNum) continue;
      merged[key] = value;
    } else {
      merged[key] = value;
    }
  }
  if (toFiniteNumber(derivedRecord.percent) !== null) {
    const recomputed = computeProgressPercent(
      toFiniteNumber(merged.completed_plans),
      toFiniteNumber(merged.total_plans),
      toFiniteNumber(merged.completed_phases),
      toFiniteNumber(merged.total_phases),
      planningScopeMod.SCOPE.COMPLETE,
    );
    // Same verbatim rule for percent: assign only when the recomputed value
    // numerically differs, so a string-spelled derived percent ("67") is not
    // churned into a number-spelled 67 (phantom-divergence noise, not a
    // change).
    if (recomputed !== null && recomputed !== toFiniteNumber(merged.percent)) {
      merged.percent = recomputed;
    }
  }
  return merged;
}

/**
 * Executor for `preservation: 'preserve-always'` (ADR-3408 §8.1). Only
 * `progress` carries this policy today. Preserves #3242/#1446/#2440/#2969
 * semantics byte-for-byte on every row the behavior table marks unchanged;
 * ADR-3473 §8.6 fixes the #3756 defect (a resyncing write that measured
 * nothing must not drop a real curated block) plus the two "Defects fixed
 * inline" no-op-write / aliasing bugs.
 */
function applyPreserveAlways(field: string, cls: FieldClassification, ctx: PreservationCtx): void {
  const curated = ctx.snapshot[field];
  if (!curated) return;
  const derived = ctx.postFm[field];
  const derivedMeasured = scanMeasuredSomething(cls, derived);
  const curatedMeasured = scanMeasuredSomething(cls, curated);
  // On a resyncing write the fresh derivation is authoritative in two cases
  // (#3756 / ADR-3473 §8.6, unchanged): when the caller EXPLICITLY named a
  // progress-affecting field (`preserve-always`'s contract is "never
  // overwrite unless the caller explicitly names this field" — `state update
  // Progress` is exactly that naming, pre-existing #3242 behavior), and when
  // the derivation measured something the curated block did not (an
  // unmeasured CURATED block is not worth protecting). The unmeasured-DERIVED
  // guard also stands: an incidental resync (e.g. `state add-decision`, whose
  // `resync` defaults true for reasons that have nothing to do with
  // `progress`) that measured nothing must not drop a real curated block
  // (#3756's archived-milestone case) — that falls through to the wholesale
  // restore below.
  //
  // #4129 narrows the remaining arm. A resyncing write whose scan MEASURED
  // something while the curated block is also real previously wholesale-
  // replaced the curated block with the derived one — no monotonic guard, so
  // any under-counting derivation (a stale-dated verification, #2348) silently
  // reverted every hand-correction and every correct value an earlier write
  // had persisted, while the read path (`shouldPreserveExistingProgress`)
  // kept reporting the higher stored counters. That arm now falls through to
  // `mergeResyncProgressRatchet` — the declared `progress-ratchet`
  // mergeStrategy, finally enforced on the write path: totals derived both
  // directions (#2440), completed counters up-only (#2969), percent
  // recomputed from the merged counters.
  if (ctx.resync && (ctx.explicitProgressField || (derivedMeasured && !curatedMeasured))) return;

  let next: unknown;
  if (cls.mergeStrategy === 'progress-ratchet' && ctx.resync && derived && derivedMeasured && curatedMeasured) {
    // #4129 resync arm — see mergeResyncProgressRatchet's doc. Reached only
    // after the early-out above, so curatedMeasured is guaranteed true here.
    next = mergeResyncProgressRatchet(
      curated as Record<string, unknown>,
      (derived ?? {}) as Record<string, unknown>,
    );
  } else if (cls.mergeStrategy === 'progress-ratchet' && ctx.deriveProgressKeys && derived && derivedMeasured) {
    // #2440: total_plans and total_phases always take the derived (post-sync)
    // value even under !resync. This is used by cmdStatePlannedPhase where
    // total_plans must correct upward after plans are added. For body-only
    // writes (state.update/patch without the flag), the wholesale restore
    // below preserves everything as before — the #3242 Bug A protection
    // stays fully in force.
    const curatedRecord = curated as Record<string, unknown> | null;
    const derivedRecord = (derived ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...derivedRecord };
    if (curatedRecord) {
      // #2440: total_plans and total_phases always take the derived value.
      // #2969: completed_plans and completed_phases take the derived value
      // when it is GREATER than the curated value (gap-closure plans that
      // completed after the plan count grew) — ratcheting UP only, never
      // deriving downward (preserves the #3242 curated-progress protection
      // for cases unrelated to plan-count growth, e.g. a deleted SUMMARY).
      // percent also takes the derived value — the resync recomputed it from
      // disk counts, and a stale curated percent would be incoherent against
      // the ratcheted-up completed counts (e.g. 54/54 at 93%).
      const ratchetUpKeys = new Set(['completed_plans', 'completed_phases']);
      for (const [key, value] of Object.entries(curatedRecord)) {
        if (key === 'total_plans' || key === 'total_phases' || key === 'percent') continue;
        if (ratchetUpKeys.has(key)) {
          const derivedNum = typeof derivedRecord[key] === 'number' ? derivedRecord[key] : -Infinity;
          const curatedNum = typeof value === 'number' ? value : -Infinity;
          // Take the derived value only when it ratchets up (strictly
          // greater — #2969's `>` not `>=`); else keep curated.
          if (derivedNum > curatedNum) continue;
          merged[key] = value;
        } else {
          merged[key] = value;
        }
      }
    }
    next = merged;
  } else {
    next = cloneCurated(curated);
  }
  if (preservedValuesEqual(ctx.postFm[field], next)) return;
  ctx.postFm[field] = next;
  ctx.mutated = true;
}

/**
 * Executor for `preservation: 'preserve-if-placeholder'` (ADR-3408 §8.1).
 * `milestone` and `milestone_name` both carry this policy in the table, and
 * both rows dispatch into this SAME executor body — no branch is selected by
 * field name (ADR-3408 §8.1). The body always restores the name+version pair
 * together (#948/#2135), ignoring which of the two rows triggered the call;
 * this is deliberately safe because the executor is idempotent: whichever
 * row fires first either performs the restore (after which the second row's
 * call recomputes against already-restored state and finds nothing left to
 * do) or finds no placeholder to restore (in which case the second row's
 * call, seeing the same unchanged inputs, reaches the same conclusion). Two
 * dispatches per write converge to the identical single-pass result, so the
 * field argument itself is unused here — it exists only to satisfy the
 * shared executor signature every policy branch in the dispatch loop shares.
 */
function applyPreserveIfPlaceholder(_field: string, _cls: FieldClassification, ctx: PreservationCtx): void {
  const MILESTONE_PLACEHOLDER = 'milestone';
  const derivedName = ctx.postFm['milestone_name'];
  const derivedLooksLikeName = typeof derivedName === 'string'
    && derivedName.length > 0
    && derivedName !== MILESTONE_PLACEHOLDER
    && !/^[\s—–:-]/.test(derivedName);
  const snapshotName = ctx.snapshot['milestone_name'];
  const snapshotNameIsReal = typeof snapshotName === 'string'
    && snapshotName.length > 0
    && snapshotName !== MILESTONE_PLACEHOLDER;
  if (derivedLooksLikeName || !snapshotNameIsReal) return;

  if (ctx.postFm['milestone_name'] !== snapshotName) {
    ctx.postFm['milestone_name'] = snapshotName;
    ctx.mutated = true;
  }
  const snapshotVersion = ctx.snapshot['milestone'];
  if (
    typeof snapshotVersion === 'string' && snapshotVersion.length > 0 &&
    ctx.postFm['milestone'] !== snapshotVersion
  ) {
    ctx.postFm['milestone'] = snapshotVersion;
    ctx.mutated = true;
  }
}

/**
 * Executor for `preservation: 'derive'`. Explicit no-op — the sync's
 * freshly-derived value stands untouched. Naming this executor (rather than
 * skipping `derive` rows by omission) is what makes ADR-3408 §8.2's throw
 * decidable: "policy says do nothing" is now distinguishable from "nobody
 * wired this", because every member of `FieldPreservation` reaches an
 * executor.
 */
function applyDerive(_field: string, _cls: FieldClassification, _ctx: PreservationCtx): void {
  // No-op by design — see docstring.
}

/**
 * Pure, table-driven post-sync preservation (ADR-3408 §8.1). One loop over
 * `FIELD_CLASSIFICATION`, dispatching on the row's `preservation` value —
 * never on the field name. Mutates `postFm` in place to mirror the
 * pre-#3468 inline block (which also mutated in place) and returns whether
 * any field was restored.
 */
export function applyStatePreservation(input: StatePreservationInput): StatePreservationResult {
  const { transaction } = input;

  // A `rebuild()` transaction still carries the snapshot (§8.7's reporting
  // needs it) but must not run preservation at all: `state sync` / `REGENERATE_STATE`
  // exist to let the body / factory-reset win, and restoring curated values
  // over that would re-lock exactly what the command was invoked to replace.
  if (transaction.kind === 'rebuild') {
    return { postFm: input.postFm, mutated: false };
  }

  const ctx: PreservationCtx = {
    postFm: input.postFm,
    snapshot: transaction.snapshot,
    resync: transaction.resync,
    deriveProgressKeys: transaction.deriveProgressKeys === true,
    bodyDeltas: transaction.bodyDeltas,
    mutated: false,
    explicitProgressField: transaction.explicitProgressField === true,
  };

  for (const field of Object.keys(FIELD_CLASSIFICATION)) {
    const cls = getFieldClassification(field);
    if (!cls) continue;
    if (cls.preservation === 'preserve-when-unchanged') {
      applyPreserveWhenUnchanged(field, cls, ctx);
    } else if (cls.preservation === 'preserve-always') {
      applyPreserveAlways(field, cls, ctx);
    } else if (cls.preservation === 'preserve-if-placeholder') {
      applyPreserveIfPlaceholder(field, cls, ctx);
    } else if (cls.preservation === 'derive') {
      applyDerive(field, cls, ctx);
    }
  }

  return { postFm: ctx.postFm, mutated: ctx.mutated };
}

// ----------------------------------------------------------------------------
// Body section constants (ADR-1769 §6 — single writer after migration)
// ----------------------------------------------------------------------------

/**
 * Top-level STATE.md section headings (H2). Aligned byte-for-byte with the
 * canonical template at `gsd-core/templates/state.md`. Sub-headings (H3) like
 * `### Decisions` / `### Pending Todos` / `### Blockers/Concerns` live under
 * `## Accumulated Context` and are not mutated by any Phase 1–7 transition;
 * they will be added here if a future transition needs them.
 *
 * Verified against `gsd-core/templates/state.md` (codex Phase 1 review).
 */
export const STATE_MD_SECTIONS = {
  projectReference: '## Project Reference',
  currentPosition: '## Current Position',
  performanceMetrics: '## Performance Metrics',
  accumulatedContext: '## Accumulated Context',
  deferredItems: '## Deferred Items',
  sessionContinuity: '## Session Continuity',
} as const;

// ----------------------------------------------------------------------------
// Intent + deps + result types (ADR-1769 §3)
// ----------------------------------------------------------------------------

export type StateTransitionDeps = {
  clock: { today: () => string; localToday: () => string; nowIso: () => string };
  /**
   * Roadmap content provider for transitions that re-derive milestone-wide
   * progress from ROADMAP.md (completePhase). Optional: transitions that don't
   * consult the roadmap ignore it. Injected (not imported) so the core stays
   * pure and testable without disk I/O.
   */
  roadmapProvider?: () => string | null;
  /**
   * Phase-inventory provider for `rebuild` (ADR-1817 §2): re-derives the
   * `## By-Phase Progress` table from canonical disk sources. Optional: when
   * absent, `rebuild` skips table reconciliation entirely (Leaky-Abstractions
   * guard — the core stays pure and testable without disk I/O).
   *
   * When present, MUST return a discriminated result, never a bare
   * array-or-null: `{ ok: true, phases }` for a (possibly empty) successful
   * scan vs `{ ok: false, reason }` for a scan that could not complete. A
   * disk-scan failure is NOT the same as "no phases on disk" — collapsing
   * both to the same value made a real failure indistinguishable from
   * "nothing to reconcile" (issue #3057 B1); `reconcileByPhaseTable` treats
   * the two differently and surfaces `ok:false` to the caller instead of
   * silently no-op'ing.
   */
  phaseInventoryProvider?: () => PhaseInventoryResult;
  /**
   * Resolved path of the STATE.md the content was read from. Injected (not
   * derived) so the core stays pure; used only to name the file in an
   * unusable-input frontmatter diagnostic (#1882). Optional: existing
   * callers and test stubs are unaffected when absent.
   */
  sourcePath?: string;
  /**
   * Plan-set provider for `advancePlan` (#3830): resolves the plan files
   * actually on disk for the phase `## Current Position` names, so the verb
   * can check its prose-derived plan position against ground truth before
   * mutating on it. Optional: when absent, `advancePlan` behaves exactly as
   * it did before this check existed (Leaky-Abstractions guard — the core
   * stays pure and testable without disk I/O, same shape as
   * `phaseInventoryProvider` and `roadmapProvider`).
   *
   * Zero-arg by design. `advance-plan` still takes no phase argument, so the
   * phase is whatever `## Current Position` names; the ADAPTER resolves it
   * (it already parses that field inside the STATE.md lock for the #3311
   * milestone-claim check) and closes over it here. Re-parsing the phase
   * inside the core would duplicate the position-selection question that
   * #3807 and #3812 own separately.
   */
  planSetProvider?: () => PlanSetResult;
};

/**
 * One on-disk phase record (ADR-1817). The `rebuild` transition consumes
 * these to re-derive the `## By-Phase Progress` table; the adapter wires
 * this to the same disk scan `buildStateFrontmatter` uses.
 */
export type PhaseInventoryRecord = {
  number: string;
  name: string;
  planCount: number;
  summaryCount: number;
};

/**
 * Discriminated result of a `phaseInventoryProvider` disk scan (issue #3057
 * B1). `ok:true` covers a completed scan, including the genuinely-empty case
 * (`phases: []` — no `.planning/phases/` directory exists yet). `ok:false`
 * covers a scan that could not complete (e.g. the phases directory could not
 * be read). The two are NOT interchangeable: only `ok:true` with an empty
 * array means "nothing to reconcile"; `ok:false` means "unknown — do not
 * treat as reconciled".
 */
/**
 * Discriminated result of a `planSetProvider` disk scan (#3830). Mirrors
 * `PhaseInventoryResult`'s contract, for the same reason (#3057 B1): a scan
 * that could not complete is NOT the same answer as "no plans on disk".
 *
 * Only `ok:true` licenses a divergence claim. `ok:false` means "unknown", and
 * `advancePlanCore` treats unknown as no-evidence rather than as divergence —
 * refusing to advance because a phase directory could not be read would block
 * a project the check has nothing against.
 */
export type PlanSetResult =
  | {
      ok: true;
      phase: string;
      /** Live canonical plans (superseded excluded) — `phase-plan-index`'s `plan_count`. */
      planCount: number;
      /** Canonical plans INCLUDING superseded — `find-phase`'s `plan_count_all`. */
      planCountAll: number;
    }
  | { ok: false; reason: string };

export type PhaseInventoryResult =
  | { ok: true; phases: PhaseInventoryRecord[] }
  | { ok: false; reason: string };

export type StateTransitionIntent =
  | { kind: 'beginPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null }
  | { kind: 'advancePlan' }
  | {
      kind: 'completePhase';
      phaseNum: string;
      /** Next phase number, or null when completing the final phase. */
      nextPhaseNum: string | null;
      /** Display name for the next phase (may be null when unknown). */
      nextPhaseName: string | null;
      /** True when this is the final phase in the milestone. */
      isLastPhase: boolean;
      planCount: number;
      summaryCount: number;
    }
  | { kind: 'plannedPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null }
  | { kind: 'milestoneSwitch'; version: string; name: string }
  | {
      kind: 'milestoneComplete';
      version: string;
      /** Resolved runtime slash command for the Operator Next Steps hint (e.g. '/gsd:new-milestone'). */
      nextMilestoneCommand: string;
    }
  | { kind: 'patch'; patches: Record<string, string> }
  | { kind: 'update'; field: string; value: string }
  | {
      kind: 'prune';
      /** Phases at or below this number are archived (currentPhase - keepRecent). */
      cutoff: number;
    }
  | {
      kind: 'sync';
      /** Disk-derived plan count for the highest incomplete phase, or null. */
      totalPlansInPhase: number | null;
      /** Recomputed progress percent (0-100), or null when it must be left untouched (#1761). */
      percent: number | null;
    }
  | {
      kind: 'rebuild';
    };
// Phase 7 closed the union for the 10 ADR-1769 intents. ADR-1817 adds `rebuild`
// as the 11th capstone transition (body-structure derivability contract).

export type StateTransitionResult = {
  content: string;
  updated: string[];
  /** Intent-specific output (e.g. advancePlan returns {advanced, currentPlan, totalPlans}).
   * Adapters read this to construct the CLI output shape. */
  data?: Record<string, unknown>;
};

// ----------------------------------------------------------------------------
// transitionCore — pure dispatch (ADR-1769 §3)
// ----------------------------------------------------------------------------

/**
 * Pure transition core. `(content, intent, deps) → result`.
 *
 * Discriminated-union dispatch via plain `switch` (ADR-1769 §2.7 Kernighan's
 * Law: debuggability over conciseness; the substrate sets the pattern).
 *
 * Phases 2–7 add cases for the remaining 9 intent kinds. A missing case is
 * a compile-time error (the function would not return on that path).
 */
export function transitionCore(
  content: string,
  intent: StateTransitionIntent,
  deps: StateTransitionDeps,
): StateTransitionResult {
  switch (intent.kind) {
    case 'beginPhase':
      return beginPhaseCore(content, intent, deps);
    case 'advancePlan':
      return advancePlanCore(content, deps);
    case 'completePhase':
      return completePhaseCore(content, intent, deps);
    case 'plannedPhase':
      return plannedPhaseCore(content, intent, deps);
    case 'milestoneSwitch':
      return milestoneSwitchCore(content, intent, deps);
    case 'milestoneComplete':
      return milestoneCompleteCore(content, intent, deps);
    case 'patch':
      return patchCore(content, intent);
    case 'update':
      return updateCore(content, intent);
    case 'prune':
      return pruneCore(content, intent);
    case 'sync':
      return syncCore(content, intent, deps);
    case 'rebuild':
      return rebuildCore(content, intent, deps);
  }
}

// ----------------------------------------------------------------------------
// beginPhase — intent implementation (Phase 1)
// ----------------------------------------------------------------------------

/**
 * Apply a `beginPhase` transition to STATE.md content.
 *
 * Phase 1 scope (this file): the Status field update only. Subsequent
 * behaviors land via RED-GREEN cycles per the ADR-1769 migration plan:
 *   - Current Phase, Current Phase Name, Current Plan, Total Plans
 *   - Current Position section mutation
 *   - Idempotency guard (#3127)
 *   - Resume vs first-time branching
 *   - #1255 / #1257 format-detection parity
 *
 * Adapters that acquire the STATE.md lock and call this core live in
 * state.cts and consume the existing `readModifyWriteStateMd` post-sync
 * machinery (preserves the #1230 delta heuristic without re-implementing it).
 */
function beginPhaseCore(
  content: string,
  intent: { kind: 'beginPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // not on the full content. The YAML `status:` key matches `^Status:\s*`
  // before the body pipe-table row if full content is passed.
  const { reassemble } = beginFrontmatterReassembly(content, deps.sourcePath);
  // #3881 review, finding 5: `body` is deliberately a LITERAL `stripFrontmatter(content)`
  // assignment here rather than the helper's own `body` (which the destructure above skips) —
  // scripts/lint-state-write-path-drift.cjs's Axis 3 backward scan is a single-hop textual
  // pattern match, not real dataflow, and only recognizes `body = stripFrontmatter(...)` written
  // out at the call site. `stripFrontmatter` is pure and idempotent, so computing it here (in
  // addition to the helper's own internal call) changes nothing observable.
  let body = stripFrontmatter(content);

  const today = deps.clock.localToday();

  // Consult the field-classification table for the frontmatter keys this
  // transition touches (codex Phase 1 review: "table not consulted by
  // transitionCore"). The table tracks FRONTMATTER keys (lowercase: `status`,
  // `current_phase`, `last_activity`); body field names like `Status` /
  // `Current Phase` are aliases and aren't enforced here — they're driven by
  // the first-time/resume branching below, which encodes the same rules.
  // Phase 2+ will dispatch preservation based on this lookup.
  for (const fmKey of ['status', 'current_phase', 'current_plan', 'last_activity']) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore beginPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // Helper: try to replace a body field; push to `updated` on success.
  // Body field names (Title Case: 'Status', 'Current Phase') are not in the
  // table — they're body-side aliases of classified frontmatter keys.
  const tryField = (name: string, value: string): void => {
    const replaced = stateReplaceField(body, name, value);
    if (replaced !== null) {
      body = replaced;
      updated.push(name);
    }
  };

  // #3127 idempotency guard: if Status already contains "Executing Phase N" for
  // the current phase number, this is a resume (e.g. --wave N continue). Skip
  // the first-time-only fields so mid-flight state (Current Plan, Total Plans,
  // Current Phase Name, Last Activity Description) is preserved.
  // Extract from body (not full content) so the YAML `status:` key cannot
  // shadow the body Status field (#1255).
  const currentStatus = stateExtractField(body, 'Status') || '';
  const isAlreadyExecuting = new RegExp(
    `Executing Phase\\s+${escapeRegex(String(intent.phaseNumber))}\\b`,
    'i',
  ).test(currentStatus);

  // Status update (applies on both first-time and resume — Status is always refreshed).
  tryField('Status', `Executing Phase ${intent.phaseNumber}`);

  // Last Activity date — safe to refresh on resume (tracks when execute-phase ran).
  tryField('Last Activity', today);

  if (!isAlreadyExecuting) {
    // First-time execution: set all progress fields.
    tryField('Last Activity Description', `Phase ${intent.phaseNumber} execution started`);
    tryField('Current Phase', String(intent.phaseNumber));
    if (intent.phaseName) {
      tryField('Current Phase Name', intent.phaseName);
    }
    tryField('Current Plan', '1');
    if (intent.planCount) {
      tryField('Total Plans in Phase', String(intent.planCount));
    }

    // **Current focus:** body text line (#1104).
    const focusLabel = intent.phaseName
      ? `Phase ${intent.phaseNumber} — ${intent.phaseName}`
      : `Phase ${intent.phaseNumber}`;
    const focusPattern = /(\*\*Current focus:\*\*\s*).*/i;
    if (focusPattern.test(body)) {
      body = body.replace(focusPattern, (_match, prefix: string) => `${prefix}${focusLabel}`);
      updated.push('Current focus');
    }

    // ## Current Position section mutation (#1104, #1365).
    // `locateCurrentPosition` (fence-aware, tokenizeHeadings-based) locates
    // the section; mirrors state.cts:2261-2324 byte-for-behaviour.
    body = mutateCurrentPositionFirstTime(body, intent, today, updated);
  } else {
    // Resume path: only update Last activity timestamp in Current Position
    // (do not touch Plan:, Phase:, Status:, stopped_at, progress.percent).
    body = mutateCurrentPositionResume(body, intent, today, updated);
  }

  // #2736: surface the #3127 resume decision so the adapter can drop its
  // intent-first current_phase_name override on a resume — the core just
  // preserved the mid-flight name, and an override would drift frontmatter
  // away from the preserved body value.
  return { content: reassemble(body), updated, data: { resumed: isAlreadyExecuting } };
}

// Local frontmatter type aliases matching frontmatter.cts so we can call
// reconstructFrontmatter without cross-module type re-exports.
type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

/**
 * Find the `## Current Position` section, return its `{start, end}` byte
 * offsets in `body` (end is exclusive — first byte of the next section or
 * body.length). Returns `null` when the section is absent.
 *
 * ADR-1372 T6: tokenizeHeadings-based locator (fence-aware).
 */
function locateCurrentPosition(body: string): { start: number; end: number } | null {
  const hs = tokenizeHeadings(body);
  const idx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
  if (idx === -1) return null;
  const h = hs[idx];
  const lines = body.split('\n');
  const hl = lines[h.line - 1];
  const start = h.offset + hl.length + 1;
  let end = body.length;
  for (let j = idx + 1; j < hs.length; j++) {
    if (STOP_H2_PLUS(hs[j].level)) {
      // Exclude the newline that separates this section from the next
      // heading. Walk back over a bare `\n`, then over a `\r` if one
      // immediately precedes it (CRLF), so a CRLF document's slice does not
      // retain a stray unpaired trailing `\r` (#3118).
      let e = hs[j].offset;
      if (e > 0 && body[e - 1] === '\n') {
        e -= 1;
        if (e > 0 && body[e - 1] === '\r') e -= 1;
      }
      // Clamp so the span can never invert (#3118 review): when the section
      // is empty and the next heading follows with no blank line between,
      // walking back over the newline(s) can land `e` before `start`. An
      // inverted span makes every mutator's `body.slice(0, start) +
      // sectionBody + body.slice(end)` reassembly duplicate the bytes in
      // `[end, start)`. A zero-length span (`end === start`) is the correct
      // representation of an empty-but-present section.
      end = Math.max(e, start);
      break;
    }
  }
  return { start, end };
}

/**
 * Return the body text of the `## Current Position` section, or `null` when it
 * is absent. Reuses the fence-aware `locateCurrentPosition` locator (ADR-1372).
 *
 * Exposed so callers that must read a position field (e.g. `cmdStatePrune`,
 * #1776) can scope extraction to the canonical section instead of the whole
 * document — where `stateExtractField`'s pipe-table fallback could otherwise
 * latch onto an unrelated `| Phase | N |` row elsewhere in STATE.md. This
 * scopes the *caller*; the shared extractor is left broad for every other use.
 */
export function sliceCurrentPositionSection(body: string): string | null {
  const span = locateCurrentPosition(body);
  return span === null ? null : body.slice(span.start, span.end);
}

/**
 * First-time ## Current Position mutation: update Phase / Plan / Status /
 * Last activity lines. Mirrors state.cts:2261-2324 byte-for-behaviour
 * (inline regex first, pipe-table fallback via stateReplaceField — #1257).
 *
 * F2 (#2245 review, MAJOR): a prior revision of this function used
 * `collectSection`/`replaceSection` here, whose default `levelBounded: true`
 * only stops the section at the next heading of level <= the opener's own
 * level (H1/H2 for a `##`-opened section) — an H3+ subsection nested under
 * `## Current Position` was NOT a stop boundary and got folded into
 * `sectionBody`, so the field regexes below (which run with the `m` flag,
 * matching ANY line start in the body) could clobber a same-named line
 * inside that subsection (the #2130/#2067/#2080 truncation/clobber class).
 * Restored to the fence-aware `locateCurrentPosition` locator (which stops
 * at ANY heading level >= 2, `STOP_H2_PLUS` — H2 through H6) + manual splice,
 * exactly matching the `mutateCurrentPositionResume`/
 * `mutateCurrentPositionForAdvance` siblings below, both of which use
 * `locateCurrentPosition` directly.
 */
function mutateCurrentPositionFirstTime(
  body: string,
  intent: { phaseNumber: string | number; phaseName: string | null; planCount: number | null },
  today: string,
  updated: string[],
): string {
  const span = locateCurrentPosition(body);
  if (span === null) return body;
  let sectionBody = body.slice(span.start, span.end);

  // Phase line — inline first, then pipe-table fallback (#1257).
  const phaseLabel = `${intent.phaseNumber}${intent.phaseName ? ` (${intent.phaseName})` : ''} — EXECUTING`;
  if (/^Phase:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Phase', phaseLabel);
    if (replaced !== null) sectionBody = replaced;
  }

  // Plan line.
  const planValue = `1 of ${intent.planCount || '?'}`;
  if (/^Plan:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${planValue}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Plan', planValue);
    if (replaced !== null) sectionBody = replaced;
  }

  // Status line.
  const statusValue = `Executing Phase ${intent.phaseNumber}`;
  if (/^Status:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Status:.*$/m, `Status: ${statusValue}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Status', statusValue);
    if (replaced !== null) sectionBody = replaced;
  }

  // Last activity line. The inline value carries date + narrative.
  const activityValue = `${today} — Phase ${intent.phaseNumber} execution started`;
  if (/^Last activity:/im.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Last activity:.*$/im, `Last activity: ${activityValue}`);
  } else {
    const replaced =
      stateReplaceField(sectionBody, 'Last Activity', activityValue) ??
      stateReplaceField(sectionBody, 'Last activity', activityValue);
    if (replaced !== null) sectionBody = replaced;
  }

  updated.push('Current Position');
  return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}

/**
 * Resume ## Current Position mutation: only update Last activity line
 * (preserves Plan/Phase/Status — #3127). Mirrors state.cts:2329-2363
 * byte-for-behaviour.
 */
function mutateCurrentPositionResume(
  body: string,
  intent: { phaseNumber: string | number },
  today: string,
  updated: string[],
): string {
  const span = locateCurrentPosition(body);
  if (span === null) return body;
  let sectionBody = body.slice(span.start, span.end);

  const resumeActivity = `Last activity: ${today} — Phase ${intent.phaseNumber} execution resumed (wave continue)`;
  if (/^Last activity:/im.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Last activity:.*$/im, resumeActivity);
    updated.push('Last activity (resume)');
  } else {
    // Pipe-table format fallback (#1255).
    const replaced =
      stateReplaceField(sectionBody, 'Last Activity', resumeActivity) ??
      stateReplaceField(sectionBody, 'Last activity', resumeActivity);
    if (replaced !== null) {
      sectionBody = replaced;
      updated.push('Last activity (resume)');
    }
  }

  return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}

/**
 * The two value grammars `Current Plan` / `Plan` accept, ANCHORED to the whole
 * value. These are the executable half of `STATE_FIELD_SCHEMA.current_plan`'s
 * declared `acceptedShapes` (`['N', 'N of M']`); ADR-3473 §8.8 keeps the parser
 * hand-written and has rows 23/24/25 assert the two agree, so widening one
 * without the other goes red rather than drifting.
 *
 * Anchoring is the whole point. An unanchored `/of\s+(\d+)/` reads a total out
 * of prose — `Current Plan: 4 — blocked on review of 2 PRs` yields `4 of 2`,
 * which is `currentPlan >= totalPlans`, which WRITES a terminal
 * "Phase complete" status into the user's STATE.md. Refusing to guess is the
 * behaviour #3840/`308c17505` settled for a malformed feature `order`, and it
 * applies here for the same reason: a wrong parse and a right one are
 * output-identical to the caller.
 *
 * The anchor that does the work is the one at the START. A trailing remainder
 * is allowed after the total because `Plan: 2 of 5 in current phase` is a real,
 * tested shape this field has always carried — the suffix is a human note, not
 * a second number. Prose is still refused, because the refusal comes from
 * requiring `of <total>` to follow the leading number IMMEDIATELY: in
 * `4 — blocked on review of 2 PRs` what follows `4` is ` — blocked`, so there
 * is nothing for the total to be read from.
 *
 * BOTH grammars carry the same trailing tolerance, deliberately. An earlier
 * revision anchored `N` hard (`/^(\d+)\s*$/`) while leaving `N of M` open,
 * which hard-errored on values base parsed happily via `parseInt`:
 * `Total Plans in Phase: 5 phases` and `Current Plan: 3 (blocked)`. #3784's own
 * brief puts "validating or normalizing plan numbers beyond this transition's
 * read/write" out of scope, so refusing an annotation nobody complained about
 * was a narrowing this issue does not license. The prose defect is closed by
 * the START anchor, not by forbidding suffixes: with a `Total Plans in Phase`
 * sibling present the total never comes from the value's text at all, and
 * without one `4 — blocked on review of 2 PRs` still fails `N of M` because
 * ` — blocked` does not follow the leading number with `of`.
 *
 * CRLF survives, but state the mechanism accurately: `stateExtractField`'s own
 * `(.+)` capture stops before the `\r` — JS `.` excludes CR as a
 * LineTerminator — so the value these grammars receive is already CR-free on
 * the common path. The trailing group is what covers the case where a CR does
 * reach here, and `\s` matching CR is why it works. It is belt-and-braces, not
 * the primary defence.
 */
/** The two body field names a plan position is ever written under. */
type PlanFieldName = 'Plan' | 'Current Plan';

const PLAN_SHAPE_N = /^(\d+)(?:\s.*)?$/;
const PLAN_SHAPE_N_OF_M = /^(\d+)\s+of\s+(\d+)(?:\s.*)?$/;

/**
 * Parse a decimal group into a plan number, or `null` if it is not a value we
 * are willing to do arithmetic on.
 *
 * `parseInt` is deliberately not used on the raw field: it truncates (`"2 of 5"`
 * -> 2), accepts a sign (`"+2"`), and silently loses precision past
 * `Number.MAX_SAFE_INTEGER`, where the number we report and the string we write
 * back stop agreeing. The grammars above already exclude signs and trailing
 * text, so the only remaining hazard is magnitude.
 */
function planNumberFrom(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Advance the leading integer of a written plan value, preserving everything
 * the author wrote around it: the zero-padding width ("04" -> "05") and any
 * trailing remainder ("2 of 99" -> "3 of 99", and the `\r` of a CRLF file).
 *
 * The three parse branches disagree about the field NAME and about whether a
 * total is carried inline, but they agree completely about this: only the
 * leading digits are the plan number, and nothing else on the line belongs to
 * this transition. Writing `String(newPlan)` instead — as the legacy branch
 * did — discards the author's text on a branch nobody was reading.
 *
 * padStart never truncates, so 09 -> 10 widens rather than clipping.
 */
function bumpLeadingNumber(raw: string, next: number): string | null {
  const digits = /^\d+/.exec(raw);
  // Total rather than pass-through. `raw.replace(/^\d+/, …)` returns the input
  // unchanged when there are no leading digits, so `+2` advanced in `data` and
  // wrote the file untouched — the command reported progress it had not made
  // and could be re-run forever. The grammars make that unreachable today;
  // returning null keeps it unreachable if a fourth branch is ever added.
  if (!digits) return null;
  return raw.replace(/^\d+/, () => String(next).padStart(digits[0].length, '0'));
}

/**
 * Update fields within the ## Current Position section for advancePlan.
 * Mirrors `updateCurrentPositionFields` (state.cts:496) byte-for-behaviour:
 * only replaces Status / Last Activity when the existing value is a known
 * template default (Knuth invariant: preserve executor-authored values).
 * Plan is always replaced (system-derived, never executor-authored).
 *
 * Cannot import `updateCurrentPositionFields` from state.cjs directly (circular
 * dep: state.cjs → state-transition.cjs → state.cjs), so the mutation is
 * inlined here using the same primitives.
 */
function mutateCurrentPositionForAdvance(
  content: string,
  fields: {
    phase?: string;
    status?: string;
    lastActivity?: string;
    /** Value for a section line spelled `Plan:`. */
    plan?: string;
    /** Value for a section line spelled `Current Plan:`. */
    currentPlan?: string;
  },
  statusDefaults: string[] | null | undefined,
  lastActivityDefaults: string[] | null | undefined,
): string {
  const span = locateCurrentPosition(content);
  if (span === null) return content;
  let sectionBody = content.slice(span.start, span.end);
  let mutated = false;

  // #3395: Phase is always replaced when a caller passes it — system-derived,
  // not executor-authored (same rule as Plan below). plannedPhaseCore uses
  // this so the transition that declares phase N planned also owns the `Phase:`
  // line the frontmatter resync and `state json` re-derive current_phase from;
  // before, the line survived stale from a previous phase and every
  // body-derived consumer kept reading it (#948 class).
  if (fields.phase) {
    if (/^Phase:/m.test(sectionBody)) {
      sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${fields.phase}`);
      mutated = true;
    } else {
      const replaced = stateReplaceField(sectionBody, 'Phase', fields.phase);
      if (replaced !== null) { sectionBody = replaced; mutated = true; }
    }
  }

  if (fields.status) {
    const replaced = stateReplaceFieldIfTemplate(sectionBody, 'Status', statusDefaults, fields.status);
    if (replaced !== null && replaced !== sectionBody) { sectionBody = replaced; mutated = true; }
  }

  if (fields.lastActivity) {
    const replaced =
      stateReplaceFieldIfTemplate(sectionBody, 'Last Activity', lastActivityDefaults, fields.lastActivity) ??
      stateReplaceFieldIfTemplate(sectionBody, 'Last activity', lastActivityDefaults, fields.lastActivity);
    if (replaced !== null && replaced !== sectionBody) { sectionBody = replaced; mutated = true; }
  }

  if (fields.plan || fields.currentPlan) {
    // Plan is always replaced — system-derived, not executor-authored.
    //
    // Which NAME to write is decided by what the SECTION carries, not by which
    // header field the value was read from. Mirroring the header was wrong in
    // both directions: a legacy header with a `Current Plan:` section line left
    // the section a plan behind, and a hybrid header with a `Plan:` section line
    // mutated nothing at all. The invariant is per-name — every site spelled
    // `Current Plan` gets the `Current Plan` value, every `Plan` site gets the
    // `Plan` value — so both are passed in and each is written where its own
    // name appears.
    //
    // Title-Case LITERALS reach both the regex and stateReplaceField
    // (ADR-3408 §8.3(b)): a literal cannot collide with a lowercase/snake_case
    // frontmatter key, whatever the caller passed.
    //
    // The replacements go through a replacer FUNCTION, never a replacement
    // string. `fields.plan` is derived from file content, and `String.replace`
    // expands `$&`, `` $` `` and `$'` in a replacement string — a STATE.md
    // carrying `Current Plan: 04 of 06 $&` would splice part of itself into the
    // document. `stateReplaceField` already uses a function for this reason;
    // these arms now agree with it.
    // Each name is written INDEPENDENTLY, and each falls back on its own.
    //
    // Two defects lived in the previous shape, both of which produced the
    // split-brain document this arm exists to prevent:
    //
    //   - The fallback was guarded by `!mutated`, and `mutated` is FUNCTION-wide
    //     — already set by the `phase`/`status`/`lastActivity` arms above, which
    //     `advancePlanCore` always populates. A section spelled `**Current
    //     Plan:**` (bold) or as a pipe-table row therefore skipped its fallback
    //     because an UNRELATED field had been refreshed, and the section stayed a
    //     plan behind the header.
    //   - The fallback then picked ONE name by ternary. In the legacy shape both
    //     values are populated, so it always chose `Current Plan` and a
    //     `**Plan:**` section line — which base did write — got nothing.
    //
    // `planWritten` is local, so nothing outside this arm can satisfy its guard.
    let planWritten = false;
    const writePlanField = (name: PlanFieldName, value: string | undefined): void => {
      if (!value) return;
      // Plain `Name:` line first. Title-Case LITERALS reach both the regex and
      // stateReplaceField (ADR-3408 §8.3(b)), and the replacement goes through a
      // replacer FUNCTION so a `$&` / `` $` `` / `$'` in the author's text is not
      // expanded into the document.
      if (name === 'Current Plan') {
        if (/^Current Plan:/m.test(sectionBody)) {
          sectionBody = sectionBody.replace(/^Current Plan:.*$/m, () => `Current Plan: ${value}`);
          planWritten = true;
          return;
        }
        const replaced = stateReplaceField(sectionBody, 'Current Plan', value);
        if (replaced !== null) { sectionBody = replaced; planWritten = true; }
        return;
      }
      if (/^Plan:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Plan:.*$/m, () => `Plan: ${value}`);
        planWritten = true;
        return;
      }
      const replaced = stateReplaceField(sectionBody, 'Plan', value);
      if (replaced !== null) { sectionBody = replaced; planWritten = true; }
    };
    writePlanField('Current Plan', fields.currentPlan);
    writePlanField('Plan', fields.plan);
    if (planWritten) mutated = true;
  }

  if (!mutated) return content;
  return content.slice(0, span.start) + sectionBody + content.slice(span.end);
}

// ----------------------------------------------------------------------------
// advancePlan — intent implementation (Phase 2)
// ----------------------------------------------------------------------------

/**
 * Apply an `advancePlan` transition to STATE.md content.
 *
 * Parses Current Plan / Total Plans in any of three shapes — the legacy
 * separate fields, the compound "Plan: X of Y", or the hybrid
 * "Current Plan: X of Y" (legacy name, compound value, no Total Plans
 * sibling) — increments the plan number, updates body fields
 * and the ## Current Position section. When currentPlan >= totalPlans,
 * takes the phase-complete branch (sets Status to "Phase complete — ready
 * for verification") instead of advancing.
 *
 * Uses `stateReplaceFieldIfTemplate` (template-default-aware) to preserve
 * executor-authored field values (Knuth invariant from cmdStateAdvancePlan).
 *
 * Returns `data.advanced` / `data.currentPlan` / `data.totalPlans` for the
 * adapter to construct CLI output.
 */
function advancePlanCore(content: string, deps: StateTransitionDeps): StateTransitionResult {
  const today = deps.clock.localToday();

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // not on the full content. The YAML `status:` key matches `^Status:\s*`
  // before the body field if full content is passed (codex Phase 2 review:
  // HIGH blocking finding — same pattern beginPhaseCore already handles).
  const { body: initialBody, reassemble } = beginFrontmatterReassembly(content, deps.sourcePath);
  let body = initialBody;

  // #3807: refuse a Current Position section carrying more than one `Phase:`
  // entry BEFORE mutating. The plan fields below come from document-wide
  // first-match extraction, so in a wave-log style section (one entry per
  // completed wave) the FIRST entry's plan counter silently advanced — in the
  // reporting incident, a hard-gated final plan 7→8 of 8 — while the entry
  // the caller meant sat untouched below it, with advanced:true and no
  // ambiguity signal. advance-plan now refuses before acting. Scoped via the
  // #2956 canonical locator (stateCurrentPositionSlice — H2 or H3 heading,
  // the same one cmdStateAdvancePlan's own milestone read uses); NO whole-body
  // fallback — a legacy-format document with unrelated `Phase:` history lines
  // elsewhere has no section to disambiguate and must keep its current
  // behavior rather than be falsely refused.
  const positionScope = stateCurrentPositionSlice(body);
  if (positionScope !== null) {
    const phaseCandidates = (positionScope.match(/^Phase:.*$/gm) || []);
    if (phaseCandidates.length > 1) {
      return {
        content,
        updated: [],
        data: {
          error: true,
          reason: 'ambiguous_position_phase',
          phase_candidates: phaseCandidates.map((l) => l.trim()),
        },
      };
    }
  }

  // Parse plan number — legacy pair first, then the hybrid, then compound.
  //
  // These branches decide ONE thing: which numbers the advance is computed
  // from. They deliberately do not record which FIELD supplied them, because
  // the write path no longer asks — every spelling is written back from its own
  // raw text (#3791 review round 6, B1/M1). An earlier revision tracked a
  // `planSourceField`/`planRawValue` pair here and then wrote the OTHER
  // spelling from this one's numbers, which is precisely how a field ended up
  // holding a value nothing had derived for it.
  const legacyPlan = stateExtractField(content, 'Current Plan');
  const legacyTotal = stateExtractField(content, 'Total Plans in Phase');
  const planField = stateExtractField(content, 'Plan');

  // Every branch below reads its numbers out of an ANCHORED match's capture
  // groups. Nothing here calls parseInt on a raw field value, so a value the
  // grammar does not fully describe cannot half-parse into a plausible number.
  const legacyNMatch = legacyPlan ? PLAN_SHAPE_N.exec(legacyPlan) : null;
  const legacyNofMMatch = legacyPlan ? PLAN_SHAPE_N_OF_M.exec(legacyPlan) : null;
  const totalNMatch = legacyTotal ? PLAN_SHAPE_N.exec(legacyTotal) : null;
  const planNofMMatch = planField ? PLAN_SHAPE_N_OF_M.exec(planField) : null;
  const planNMatch = planField ? PLAN_SHAPE_N.exec(planField) : null;

  let parsedCurrent: number | null = null;
  let parsedTotal: number | null = null;

  if (legacyPlan && legacyTotal && (legacyNMatch || legacyNofMMatch) && totalNMatch) {
    // Legacy pair wins whenever both fields are present and both are readable,
    // even if the Current Plan value also carries an "of M" — the explicit
    // sibling field is the stated intent, so it supplies the total.
    parsedCurrent = planNumberFrom((legacyNMatch ?? legacyNofMMatch)![1]);
    parsedTotal = planNumberFrom(totalNMatch[1]);
  } else if (legacyNofMMatch) {
    // Hybrid: legacy field name, compound value, no readable Total Plans
    // sibling. Written by hand (and by agents) often enough to be worth
    // reading — #3784.
    parsedCurrent = planNumberFrom(legacyNofMMatch[1]);
    parsedTotal = planNumberFrom(legacyNofMMatch[2]);
  } else if (planNofMMatch) {
    parsedCurrent = planNumberFrom(planNofMMatch[1]);
    parsedTotal = planNumberFrom(planNofMMatch[2]);
  }
  // No branch for a bare `Plan: N` paired with a `Total Plans in Phase: M`
  // sibling and no `Current Plan` at all (#3791 review round 6, M2). A revision
  // of this PR accepted it; base did not (its `else if (planField)` arm had no
  // `of M` match and errored via NaN), and it is out of #3784's scope, which is
  // the hybrid `Current Plan: N of M`. It cannot be given the schema-row +
  // forcing-test coupling the other shapes have, either: `Plan` is body-only,
  // `buildStateFrontmatter` never reads it into frontmatter, so there is no
  // `current_*` key to hang a row on. An accepted shape with no schema row and
  // no forcing test is exactly the drift this diff is otherwise built to
  // prevent, so the shape is refused and named in the error instead.

  if (parsedCurrent === null || parsedTotal === null) {
    return { content: reassemble(body), updated: [], data: { error: true } };
  }
  const currentPlan = parsedCurrent;
  const totalPlans = parsedTotal;

  // Each SPELLING's own plan number, read from its own value (#3791 review
  // round 6, B1/M1). The parse above picks ONE field to advance FROM; these are
  // what each field independently claims, and they are the only honest basis
  // for writing that field back.
  const legacyOwnCurrent = legacyNMatch || legacyNofMMatch
    ? planNumberFrom((legacyNMatch ?? legacyNofMMatch)![1])
    : null;
  const planOwnCurrent = planNofMMatch || planNMatch
    ? planNumberFrom((planNofMMatch ?? planNMatch)![1])
    : null;

  // A document carrying BOTH spellings with DIFFERENT plan numbers disagrees
  // with itself, and no rule here can say which half is right. Refuse.
  //
  // This is the #3807 posture one field over: name the conflict, let the caller
  // resolve it, never pick. The alternative shipped in an earlier revision of
  // this PR and was the round-6 Blocker — with `Plan` as the parse source, the
  // write path re-stamped `Current Plan`'s value with the number it had just
  // derived from `Plan`, so `Current Plan: 7` beside `Plan: 2 of 5` silently
  // became `Current Plan: 3`. A number with no relationship to the field it was
  // written into, no error, no diagnostic.
  //
  // Placed BEFORE the phase-complete branch deliberately. Guarding only the
  // normal advance leaves `Current Plan: 7` beside `Plan: 5 of 5` writing a
  // terminal "Phase complete — ready for verification" into a document whose
  // two spellings never agreed on where execution was.
  //
  // Differing TOTALS are NOT a disagreement about position and are preserved,
  // not resolved: `Current Plan: 2` / `Total Plans in Phase: 5` beside
  // `Plan: 2 of 9` advances to `3` and `3 of 9`. Reconciling the two totals
  // would be this transition inventing an answer to a question nobody asked it.
  if (legacyOwnCurrent !== null && planOwnCurrent !== null && legacyOwnCurrent !== planOwnCurrent) {
    return {
      content: reassemble(body),
      updated: [],
      data: {
        error: true,
        reason: 'ambiguous_plan_position',
        plan_candidates: [
          `Current Plan: ${legacyPlan}`,
          `Plan: ${planField}`,
        ],
      },
    };
  }

  // #3830: everything above came out of `## Current Position` prose and out of
  // nothing else — there is no filesystem read anywhere in this function. The
  // `isNaN` guard is SYNTACTIC, so a stale-but-well-formed `2 of 8` passes it
  // and gets incremented, written back, and reported as `advanced: true` for a
  // phase that may have twelve plans on disk, all summarized. Cross-check the
  // prose against the plan set actually on disk before mutating on it.
  //
  // The gate sits BEFORE both branches deliberately: the phase-completion test
  // below (`currentPlan >= totalPlans`) reads the same two operands, so drift
  // mistimes completion in either direction — withholding it from a finished
  // phase, or declaring it on an unfinished one — and a gate placed after that
  // test would leave the more expensive of the two failures uncovered.
  //
  // Deliberately narrow. Divergence is claimed ONLY from a completed scan that
  // found at least one plan file. An absent provider (existing callers and test
  // stubs), a scan that could not complete (`ok:false`), and a phase with no
  // plan files on disk yet are all "no evidence" — NOT "diverged". Blocking on
  // those would strand projects this check knows nothing about, and the
  // no-plans-yet case is the ordinary state of a phase between `begin-phase`
  // and its first written plan.
  //
  // "At least one plan FILE", not "at least one LIVE plan": the presence test
  // reads BOTH counts. Guarding on `planCount` alone made a phase whose plans are
  // every one of them `status: superseded` indistinguishable from a phase with no
  // plans written yet — live count 0 in both — so the gate abstained and the stale
  // prose was incremented exactly as #3830 reports. Driven: eight superseded plans
  // with prose `Plan: 2 of 7` returned `{"advanced": true, "current_plan": 3}`,
  // where the identical non-superseded fixture refuses. `planCountAll` separates
  // them, and the comparison below is unchanged — it already accepts a prose total
  // matching EITHER count, so an all-superseded phase whose prose tracks the full
  // set still agrees and still advances.
  const planSet = deps.planSetProvider ? deps.planSetProvider() : null;
  if (planSet !== null && planSet.ok && (planSet.planCount > 0 || planSet.planCountAll > 0)) {
    // The prose total is accepted if it matches EITHER disk count. The two
    // commands that write it disagree about supersession — execute-phase's
    // init scan supplies the live count, plan-review-convergence supplies
    // `plan_count_all` — so insisting on one of them would report a writer
    // disagreement as project drift. Divergence means the prose total matches
    // neither, which is unambiguous.
    const totalDiverged =
      totalPlans !== planSet.planCount && totalPlans !== planSet.planCountAll;

    // #3862 review (Major 3): a total that agrees with disk says nothing about
    // where the position sits INSIDE it. `Plan: 20 of 12` against twelve plans on
    // disk passes the total test, then satisfies `currentPlan >= totalPlans` below
    // and declares the phase ready_for_verification from a position that provably
    // exceeds the plan set; `Plan: 0 of 12` and `Plan: -1 of 12` sail through the
    // same way. This is pure arithmetic over two integers the provider already
    // returns — it derives no completion predicate and re-reads no `scan.completed`,
    // so scripts/lint-completion-predicate-drift.cjs does not bite and no
    // FUNCTION_SCOPED_EXEMPTIONS entry is needed.
    //
    // The upper bound is `planCountAll`, never `planCount`: a phase whose plans are
    // every one of them superseded is legitimately positioned past the LIVE count,
    // and bounding on that would manufacture a divergence out of ordinary
    // supersession — the same reason the total test accepts either count.
    // ONE upper bound, and it is the prose total — not a disk count. Reaching here means
    // `totalDiverged` is false, so `totalPlans` already equals `planCount` or
    // `planCountAll`; since `planCount <= planCountAll`, it follows that
    // `totalPlans <= planCountAll` and therefore `currentPlan > planCountAll` implies
    // `currentPlan > totalPlans`. A `planCountAll` term is strictly redundant — driven
    // exhaustively over the bounded space, zero decisions change without it. An earlier
    // draft shipped both and justified them with a counterexample (`20 of 12`) that in
    // fact trips both, which is how a redundant clause acquires a confident comment.
    //
    // The bound that actually does the work: `Plan: 10 of 8` against 12 plan files of
    // which 8 are live. The total (8) matches `planCount`, so the total test passes;
    // the position (10) then satisfied `currentPlan >= totalPlans` below and returned
    // `{reason: "last_plan", status: "ready_for_verification"}` while WRITING the phase
    // complete, from a position past its own declared total. Driven before the fix.
    //
    // `>` is strict, so `12 of 12` is in range and still reaches `last_plan`, and the
    // all-superseded `5 of 8` still advances.
    const rangeDiverged = currentPlan < 1 || currentPlan > totalPlans;

    if (totalDiverged || rangeDiverged) {
      return {
        // The ORIGINAL bytes, not a `reassemble(stripFrontmatter(content))`
        // round-trip: a refusal must not mutate, and frontmatter reconstruction
        // is a normalizing transform. The sibling `error: true` path above
        // round-trips because it predates this rule; do not copy it here.
        content,
        updated: [],
        data: {
          advanced: false,
          reason: 'position_diverged',
          prose: { current_plan: currentPlan, total_plans: totalPlans },
          disk: {
            phase: planSet.phase,
            plan_count: planSet.planCount,
            plan_count_all: planSet.planCountAll,
          },
        },
      };
    }
  }

  const updated: string[] = [];

  const statusDefaults = KNOWN_TEMPLATE_DEFAULTS['Status'];
  const lastActivityDefaults = KNOWN_TEMPLATE_DEFAULTS['Last Activity'];

  if (currentPlan >= totalPlans) {
    // Phase-complete branch.
    body = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Phase complete — ready for verification') || body;
    body = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today) || body;
    body = stateReplaceFieldIfTemplate(body, 'Last activity', lastActivityDefaults, today) || body;
    body = mutateCurrentPositionForAdvance(body, {
      status: 'Phase complete — ready for verification',
      lastActivity: today,
    }, statusDefaults, lastActivityDefaults);
    updated.push('Status', 'Last Activity', 'Current Position');
    return {
      content: reassemble(body),
      updated,
      data: { advanced: false, reason: 'last_plan', current_plan: currentPlan, total_plans: totalPlans, status: 'ready_for_verification' },
    };
  }

  // Normal advance branch.
  const newPlan = currentPlan + 1;
  // The value each SPELLING should carry after the advance. A document may hold
  // both names (a `Current Plan:` header and a `Plan:` line in the section, or
  // the reverse), and each has always rendered differently — the legacy field
  // holds a bare/padded number while the section's `Plan:` line holds the
  // compound `N of M`.
  //
  // Each is advanced from ITS OWN raw text, never from the other's numbers
  // (#3791 review round 6, B1/M1). `bumpLeadingNumber` replaces only the leading
  // digits, so the field's zero-padding width, its own ` of M` and any trailing
  // annotation all survive — which is what the changeset claims, and what the
  // previous revision did only for whichever field happened to be the parse
  // source. The other field it re-stamped from numbers that were never its own.
  const advanceOwn = (raw: string | null, own: number | null): string | undefined => {
    if (raw === null) return undefined;
    // Present but unreadable (`Plan: TBD`). Leave it exactly as authored: this
    // transition cannot advance what it cannot read, and writing a derived
    // number over it is the fabrication B1 was filed for. Stale-and-untouched is
    // honest; refusing the whole document because an unrelated line is
    // unreadable would be a narrowing #3784 does not license.
    if (own === null) return undefined;
    return bumpLeadingNumber(raw, newPlan) ?? undefined;
  };
  // Title-Case LITERALS to stateReplaceField (ADR-3408 §8.3(b)): a literal
  // cannot collide with a lowercase/snake_case frontmatter key, so it is safe
  // regardless of how the content argument was derived. `body` here is in fact
  // `stripFrontmatter(content)`, but the write-path drift guard does not do
  // dataflow tracking (by design), and satisfying its invariant by construction
  // is better than asking a reader to re-derive that it holds.
  // One value per SPELLING, then write both names everywhere they appear.
  //
  //   `Current Plan` — whatever the author wrote, advanced in place: padding
  //                    and any ` of M` preserved.
  //   `Plan`         — likewise, so its OWN total survives. `Plan: 2 of 9`
  //                    beside a `Total Plans in Phase: 5` advances to
  //                    `3 of 9`, not `3 of 5`: the two totals disagreeing is
  //                    the document's business, not this transition's to
  //                    reconcile.
  //
  // The two are deliberately different strings for the legacy shape, which is
  // why this is a per-name value rather than one shared display value. Writing
  // only the name the value was PARSED from is what left the other name stale:
  // a `**Plan:** 2 of 6` header beside a `Current Plan:` line advanced one and
  // not the other, in whichever direction the precedence happened to fall.
  //
  // Each write is a no-op when that name is absent (`stateReplaceField` returns
  // null), so a document carrying only one spelling is unaffected — and
  // `undefined` means "present but not advanceable", which is left untouched
  // rather than overwritten.
  const currentPlanDisplayValue = advanceOwn(legacyPlan, legacyOwnCurrent);
  const planDisplayValue = planField === null
    // No top-level `Plan:` field to advance, but the `## Current Position`
    // section may still carry a `Plan:` line in a shape `stateExtractField`
    // does not read. There is no raw text here to preserve, so it gets the
    // compound rendering that line has always carried.
    ? `${newPlan} of ${totalPlans}`
    : advanceOwn(planField, planOwnCurrent);
  if (currentPlanDisplayValue !== undefined) {
    body = stateReplaceField(body, 'Current Plan', currentPlanDisplayValue) || body;
  }
  // Only touch `Plan` when the document actually declares one. Writing it
  // unconditionally meant a `stateReplaceField` whose first match could be any
  // `Plan:` line anywhere in the body — including prose outside
  // `## Current Position` that was never a field. `planField` is the read of
  // that same field from the top of this function, so the write is scoped to a
  // document that has one.
  if (planField !== null && planDisplayValue !== undefined) {
    body = stateReplaceField(body, 'Plan', planDisplayValue) || body;
  }
  body = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Ready to execute') || body;
  body = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today) || body;
  body = stateReplaceFieldIfTemplate(body, 'Last activity', lastActivityDefaults, today) || body;
  body = mutateCurrentPositionForAdvance(body, {
    status: 'Ready to execute',
    lastActivity: today,
    // Both spellings, each with its own value. The section writes whichever
    // name it actually carries; passing only the header's name is what left
    // two sites disagreeing about where execution is.
    plan: planDisplayValue,
    currentPlan: currentPlanDisplayValue,
  }, statusDefaults, lastActivityDefaults);
  // Report `Current Plan` only when it actually moved. The write above is
  // conditional now — a `Current Plan:` that is present but unreadable is left
  // as authored — so an unconditional push here would report progress this
  // transition had not made, which is the same sin `bumpLeadingNumber` returns
  // null to avoid. `reconcileReportedFields` at the `state.cts` caller would
  // catch it against the persisted bytes, but `transitionCore`'s own `updated`
  // is consumed directly too and has to be true on its own.
  if (currentPlanDisplayValue !== undefined) updated.push('Current Plan');
  updated.push('Status', 'Last Activity', 'Current Position');

  return {
    content: reassemble(body),
    updated,
    data: { advanced: true, previous_plan: currentPlan, current_plan: newPlan, total_plans: totalPlans },
  };
}

// ----------------------------------------------------------------------------
// completePhase — intent implementation (Phase 3)
// ----------------------------------------------------------------------------

/**
 * Apply a `completePhase` transition to STATE.md content.
 *
 * Migrates the inline STATE.md transform that lived inside `cmdPhaseComplete`
 * (phase.cts) onto the substrate. Owns the field-classification-governed body
 * mutations: Current Phase (preserving the `of total` shape and phase name),
 * Current Phase Name, Status (`All phases complete` on the last phase, else
 * `Ready to plan` per ADR-2207), Current Plan (`Not started`), Last Activity + Description,
 * and the Completed/Total Phases + Progress percent block (re-derived from the
 * roadmap via the injected `roadmapProvider`).
 *
 * The adapter (`cmdPhaseComplete`) retains two concerns that are NOT pure field
 * updates: `updatePerformanceMetricsSection` (a section table upsert) and
 * `syncStateFrontmatter` (the disk-scan post-sync). It also retains the
 * multi-file atomic transaction (`writePlanningFileSet`) that writes ROADMAP,
 * REQUIREMENTS, and STATE together — `readModifyWriteStateMd` is not used here
 * because STATE.md is committed atomically with the other two files.
 *
 * Behavior is byte-for-byte with the pre-migration `phase.cts:1671-1772` block
 * (verified by characterization tests in tests/state-transition.test.cjs).
 */
function completePhaseCore(
  content: string,
  intent: {
    kind: 'completePhase';
    phaseNum: string;
    nextPhaseNum: string | null;
    nextPhaseName: string | null;
    isLastPhase: boolean;
    planCount: number;
    summaryCount: number;
  },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
  const today = deps.clock.localToday();

  // Consult the field-classification table for the frontmatter keys this
  // transition touches (same guard beginPhaseCore applies). A missing row is a
  // substrate defect — fail loudly rather than silently re-encoding policy.
  for (const fmKey of [
    'current_phase',
    'current_phase_name',
    'status',
    'current_plan',
    'last_activity',
    'last_activity_desc',
    'stopped_at',
    'progress',
  ]) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore completePhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // so the YAML `status:` / `current_phase:` keys cannot shadow the body fields.
  const { body: initialBody, reassemble } = beginFrontmatterReassembly(content, deps.sourcePath);
  let body = initialBody;

  // Current Phase — preserve the existing `of <total>` shape and the phase name
  // in parens (mirrors phase.cts:1675-1697 byte-for-behaviour).
  const phaseValue = intent.nextPhaseNum || intent.phaseNum;
  const nextPhaseDisplayName = intent.nextPhaseName;
  const existingPhaseField =
    stateExtractField(body, 'Current Phase') || stateExtractField(body, 'Phase');
  let newPhaseValue = String(phaseValue);
  if (existingPhaseField) {
    const totalMatch = existingPhaseField.match(/of\s+(\d+)/);
    const nameMatch = existingPhaseField.match(/\(([^)]+)\)/);
    if (totalMatch) {
      const total = totalMatch[1];
      const nameStr = nextPhaseDisplayName
        ? ` (${nextPhaseDisplayName})`
        : nameMatch
          ? ` (${nameMatch[1]})`
          : '';
      newPhaseValue = `${phaseValue} of ${total}${nameStr}`;
    } else if (nextPhaseDisplayName) {
      newPhaseValue = `${phaseValue} — ${nextPhaseDisplayName}`;
    }
  }
  const phaseAfter = stateReplaceFieldWithFallback(body, 'Current Phase', 'Phase', newPhaseValue);
  if (phaseAfter !== body) {
    body = phaseAfter;
    updated.push('Current Phase');
  }

  // Current Phase Name — only written when a next-phase display name is known
  // (#1743/#1695: classified curated/preserve-when-unchanged, so an absent
  // name does NOT clear an existing curated value).
  if (nextPhaseDisplayName) {
    const after = stateReplaceField(body, 'Current Phase Name', nextPhaseDisplayName);
    if (after) {
      body = after;
      updated.push('Current Phase Name');
    }
  }

  // Status — `All phases complete` on the final phase (ADR-2207), otherwise
  // `Ready to plan`. Milestone termination (`<version> milestone complete`) is
  // owned solely by the milestone-close verb (milestoneCompleteCore).
  const statusValue = intent.isLastPhase ? 'All phases complete' : 'Ready to plan';
  const statusAfter = stateReplaceFieldWithFallback(body, 'Status', null, statusValue);
  if (statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Current Plan — reset for the next phase.
  const planAfter = stateReplaceFieldWithFallback(body, 'Current Plan', 'Plan', 'Not started');
  if (planAfter !== body) {
    body = planAfter;
    updated.push('Current Plan');
  }

  // Last Activity — prefer the prose `Last activity:` line (date + narrative)
  // when present, else the bold `Last Activity:` date field.
  const lastActivityDescription = `Phase ${intent.phaseNum} complete${intent.nextPhaseNum ? `, transitioned to Phase ${intent.nextPhaseNum}` : ''}`;
  if (/^Last activity:/m.test(body)) {
    const after = stateReplaceField(body, 'Last activity', `${today} — ${lastActivityDescription}`);
    if (after) {
      body = after;
      updated.push('Last Activity');
    }
  } else {
    const after = stateReplaceField(body, 'Last Activity', today);
    if (after) {
      body = after;
      updated.push('Last Activity');
    }
  }

  const ladAfter = stateReplaceField(body, 'Last Activity Description', lastActivityDescription);
  if (ladAfter) {
    body = ladAfter;
    updated.push('Last Activity Description');
  }

  // Stopped At — #3374: write the continuity line this transition implies.
  // The frontmatter `stopped_at` is a projection of this body line
  // (source: 'body' in FIELD_CLASSIFICATION), and phase completion is exactly
  // the event the line describes — leaving it stale made the post-sync harvest
  // overwrite a fresher frontmatter value with pre-completion prose on every
  // completion (#3374), and left the workflow's later prose refresh as a
  // divergence source. Session-SCOPED replace (stateReplaceFieldInSession):
  // the harvest reads only the session section, so the write must target the
  // same scope — a whole-body replace let a decoy `**Stopped at:**` line in an
  // unrelated section absorb the refresh. Replace-only (no insertion): a
  // STATE.md with no session continuity line keeps its shape, and the
  // unchanged body source then lets the preservation delta keep an existing
  // frontmatter value. Last-phase wording reuses the ADR-2207 status phrase;
  // milestone termination wording stays owned by milestoneCompleteCore.
  const stoppedAtLine = intent.isLastPhase
    ? `Phase ${intent.phaseNum} complete — all phases complete`
    : `Phase ${intent.phaseNum} complete${intent.nextPhaseNum ? `, ready to plan Phase ${intent.nextPhaseNum}` : ''}`;
  const stoppedAfter = stateReplaceFieldInSession(body, 'Stopped At', 'Stopped at', stoppedAtLine);
  if (stoppedAfter !== body) {
    body = stoppedAfter;
    updated.push('Stopped At');
  }

  // Progress block — re-derive completed/total phases from the roadmap when
  // available (milestone-wide source of truth), then recompute the percent.
  // Only runs when a Completed Phases field exists (the existing guard).
  const completedRaw = stateExtractField(body, 'Completed Phases');
  if (completedRaw !== null) {
    let newCompleted = parseInt(completedRaw, 10);
    let derivedTotalPhases: number | null = null;
    const roadmapContent = deps.roadmapProvider ? deps.roadmapProvider() : null;
    if (roadmapContent) {
      const derived = deriveProgressFromRoadmap(roadmapContent);
      if (derived.completedPhases !== null) newCompleted = derived.completedPhases;
      if (derived.totalPhases !== null) derivedTotalPhases = derived.totalPhases;
    }
    // #3057 B9: only mark 'Completed Phases' updated when the text actually
    // changed. `stateReplaceField` returns the full (re-)substituted content
    // whenever the field pattern matches, REGARDLESS of whether newCompleted
    // differs from the value already in `body` — so a truthy-only check here
    // marked the field 'updated' even when the roadmap was unavailable and
    // newCompleted is just completedRaw parsed back to itself. That collapsed
    // "recomputed from roadmap" and "left as-is" into the same `updated`
    // signal. Comparing to `body` (the idiom every other field in this
    // function already uses) restores the distinction.
    const completedAfter = stateReplaceField(body, 'Completed Phases', String(newCompleted));
    if (completedAfter !== null && completedAfter !== body) {
      body = completedAfter;
      updated.push('Completed Phases');
    }

    const totalRaw = stateExtractField(body, 'Total Phases');
    const totalPhases = derivedTotalPhases || (totalRaw ? parseInt(totalRaw, 10) : null);
    if (totalPhases && totalPhases > 0) {
      const newPercent = clampPercent(newCompleted, totalPhases);
      // Same guard as 'Completed Phases' above, and for the same reason.
      const progAfter = stateReplaceField(body, 'Progress', `${newPercent}%`);
      if (progAfter !== null && progAfter !== body) {
        body = progAfter;
        updated.push('Progress');
      }
      // Inline `percent:` token (frontmatter / progress sub-block).
      body = body.replace(/(percent:\s*)\d+/, `$1${newPercent}`);
    }
  }

  return { content: reassemble(body), updated };
}

// ----------------------------------------------------------------------------
// plannedPhase — intent implementation (Phase 4)
// ----------------------------------------------------------------------------

/**
 * Apply a `plannedPhase` transition to STATE.md content.
 *
 * Migrates `cmdStatePlannedPhase` (state.cts) onto the substrate. Updates the
 * per-phase body fields after plan-phase runs: Status (template-aware — only
 * replaces handler-generated values, preserving executor-authored ones),
 * Total Plans in Phase, Last Activity (template-aware), Last Activity
 * Description, and the ## Current Position section — including its `Phase:`
 * line, which this transition owns (#3395: the line is the body source
 * `current_phase` re-derives from, so it must not survive stale from a
 * previous phase). The adapter wraps this in
 * `readModifyWriteStateMd({ resync: false })` so the milestone-wide progress.*
 * frontmatter is NOT re-derived from a half-planned disk snapshot (#500 RC1).
 *
 * Uses `mutateCurrentPositionForAdvance` (the inlined twin of state.cts's
 * `updateCurrentPositionFields`) so the Knuth template-default invariant
 * applies inside the Current Position section too.
 */
function plannedPhaseCore(
  content: string,
  intent: { kind: 'plannedPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
  const today = deps.clock.localToday();

  for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore plannedPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only.
  const { existingFm, hasFrontmatter, body: initialBody, reassemble } = beginFrontmatterReassembly(content, deps.sourcePath);
  let body = initialBody;

  const statusDefaults = KNOWN_TEMPLATE_DEFAULTS['Status'];
  const lastActivityDefaults = KNOWN_TEMPLATE_DEFAULTS['Last Activity'];

  // Status — template-aware (preserve executor-authored values).
  const statusAfter = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Ready to execute');
  if (statusAfter !== null && statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Total Plans in Phase — system-derived; always replaced when a count is given.
  if (intent.planCount !== null && intent.planCount !== undefined) {
    const result = stateReplaceField(body, 'Total Plans in Phase', String(intent.planCount));
    if (result) {
      body = result;
      updated.push('Total Plans in Phase');
    }
  }

  // Last Activity — template-aware.
  const lastActivityAfter = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today);
  if (lastActivityAfter !== null && lastActivityAfter !== body) {
    body = lastActivityAfter;
    updated.push('Last Activity');
  }

  // Last Activity Description.
  const ladResult = stateReplaceField(
    body,
    'Last Activity Description',
    `Phase ${intent.phaseNumber} planning complete — ${intent.planCount || '?'} plans ready`,
  );
  if (ladResult) {
    body = ladResult;
    updated.push('Last Activity Description');
  }

  // ## Current Position section — Phase + Status + Last activity.
  // #3395: plannedPhaseCore owns the `Phase:` line for the same reason
  // beginPhaseCore/completePhaseCore do — it is the body source the frontmatter
  // resync and `state json` re-derive `current_phase` from. Before, a stale
  // line from a previous phase survived this transition and every
  // body-derived consumer kept reading it (the write path was already
  // protected by the #3258 preserve-when-unchanged row; the source itself was
  // never refreshed). The label mirrors beginPhaseCore's `N (Name) — EXECUTING`
  // convention with this transition's status vocabulary ("Ready to execute").
  // Phase is system-derived, always replaced (Knuth invariant does not apply);
  // Status / Last activity stay template-aware.
  const beforePos = body;
  body = mutateCurrentPositionForAdvance(
    body,
    {
      phase: `${intent.phaseNumber}${intent.phaseName ? ` (${intent.phaseName})` : ''} — READY TO EXECUTE`,
      status: 'Ready to execute',
      lastActivity: `${today} — Phase ${intent.phaseNumber} planning complete`,
    },
    statusDefaults,
    lastActivityDefaults,
  );
  if (body !== beforePos) updated.push('Current Position');

  // #2400 Bug B: sync progress.total_plans to the frontmatter when a plan count
  // is given. This writes the explicitly-provided count — it is NOT a re-derivation
  // from disk (#500 RC1 is about deriving from a half-planned snapshot, not about
  // refusing to write an explicitly-passed argument).
  if (intent.planCount !== null && intent.planCount !== undefined && hasFrontmatter) {
    const fmProgress = (existingFm['progress'] as Record<string, unknown> | undefined) || {};
    if (fmProgress['total_plans'] !== intent.planCount) {
      fmProgress['total_plans'] = intent.planCount;
      existingFm['progress'] = fmProgress;
      updated.push('progress.total_plans');
    }
  }

  return { content: reassemble(body), updated };
}

// ----------------------------------------------------------------------------
// milestoneSwitch — intent implementation (Phase 4)
// ----------------------------------------------------------------------------

/**
 * Apply a `milestoneSwitch` transition to STATE.md content.
 *
 * Migrates `cmdStateMilestoneSwitch` (state.cts) onto the substrate. Resets
 * STATE.md for a new milestone cycle: rewrites the frontmatter (milestone,
 * milestone_name, status='planning', last_updated, last_activity, and the
 * progress block zeroed) and rewrites the ## Current Position body to the
 * "defining requirements" starting state. `gsd_state_version` is preserved.
 * Body content OUTSIDE Current Position (e.g. Accumulated Context) is
 * preserved.
 *
 * This is a destructive reset intent: it intentionally overwrites the curated
 * `progress` (preserve-always) / `current_phase_name` (preserve-when-unchanged)
 * fields because a new milestone starts from zero. That is the intent's
 * contract, not a violation of the field-classification table — the table
 * governs the steady-state RMW transitions; a milestone boundary is an
 * explicit reset.
 *
 * The adapter wraps this in `acquireStateLock` + `platformWriteSync` (NOT
 * `readModifyWriteStateMd`) because milestoneSwitch rebuilds frontmatter
 * directly and must not run the steady-state `syncStateFrontmatter` post-sync.
 */
function milestoneSwitchCore(
  content: string,
  intent: { kind: 'milestoneSwitch'; version: string; name: string },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const today = deps.clock.localToday();
  const updated: string[] = [
    'milestone',
    'milestone_name',
    'status',
    'last_updated',
    'last_activity',
    'progress',
    'Current Position',
  ];

  const existingFm = extractFrontmatter(content, deps.sourcePath) as Record<string, unknown>;
  const body = stripFrontmatter(content);
  const resolvedName = (intent.name && intent.name.trim()) || 'milestone';

  // ## Current Position reset body (mirrors state.cts:2371-2375).
  const resetPositionBody =
    `\nPhase: Not started (defining requirements)\n` +
    `Plan: —\n` +
    `Status: Defining requirements\n` +
    `Last activity: ${today} — Milestone ${intent.version} started\n\n`;

  let newBody: string;
  const hs = tokenizeHeadings(body);
  const posIdx = hs.findIndex((h) => h.level === 2 && /^current\s+position$/i.test(h.text));
  if (posIdx !== -1) {
    const h = hs[posIdx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const bodyStart = h.offset + hl.length + 1;
    let bodyEnd = body.length;
    for (let j = posIdx + 1; j < hs.length; j++) {
      if (STOP_H2_PLUS(hs[j].level)) {
        bodyEnd = hs[j].offset - 1;
        break;
      }
    }
    newBody = body.slice(0, bodyStart) + resetPositionBody + body.slice(bodyEnd);
  } else {
    const preface = body.trim().length > 0 ? body : '# Project State\n';
    newBody = `${preface.trimEnd()}\n\n## Current Position\n${resetPositionBody}`;
  }

  // Rebuilt frontmatter — curated fields are intentionally reset (milestone
  // boundary). gsd_state_version is preserved.
  const fm: Record<string, unknown> = {
    gsd_state_version: existingFm['gsd_state_version'] || '1.0',
    milestone: intent.version,
    milestone_name: resolvedName,
    status: 'planning',
    last_updated: deps.clock.nowIso(),
    last_activity: today,
    progress: {
      total_phases: 0,
      completed_phases: 0,
      total_plans: 0,
      completed_plans: 0,
      percent: 0,
    },
  };

  const yamlStr = reconstructFrontmatter(fm as unknown as Frontmatter);
  const assembled = `---\n${yamlStr}\n---\n\n${newBody.replace(/^\n+/, '')}`;
  return { content: assembled, updated };
}

// ----------------------------------------------------------------------------
// milestoneComplete — intent implementation (Phase 5)
// ----------------------------------------------------------------------------

/**
 * Replace a section's ENTIRE body with `newBody`, discarding whatever was
 * there — the "wholesale reset" write pattern used by milestoneComplete's
 * closure write (## Current Position / ## Operator Next Steps). Retires the
 * fence-blind raw regex `(##\s*<heading>\s*\n)([\s\S]*?)(?=\n##|$)`, which a
 * literal `##` inside a fenced code block in the section body could fool into
 * stopping early (the #2130/#2067/#2080 truncation class) — heading location
 * here goes through `tokenizeHeadings`, which is fence-aware.
 *
 * Byte-parity note: the retired regex's greedy `\s*` (before its mandatory
 * `\n`) swallowed any blank line(s) immediately after the heading into the
 * discarded match, and its non-greedy body match always left exactly ONE
 * newline unconsumed before the next heading (or EOF), regardless of how many
 * blank lines originally separated the section from what followed. Both
 * edges are reproduced explicitly (rather than delegated to `collectSection`'s
 * `trimEnd()`-based body, which trims a *different* amount and would drift
 * the surrounding blank-line count) so `newBody`'s own leading/trailing
 * formatting is exactly what appears in the output.
 *
 * Returns `null` when no heading matches `headingPredicate` (mirrors the
 * retired regex's `pattern.test(body)` miss) — callers fall back to their own
 * append-a-new-section path.
 */
function resetSectionVerbatim(
  content: string,
  headingPredicate: (heading: HeadingToken) => boolean,
  newBody: string,
): string | null {
  const headings = tokenizeHeadings(content);
  const idx = headings.findIndex(headingPredicate);
  if (idx === -1) return null;

  const target = headings[idx];
  const lines = content.split('\n');
  const headingLineEnd = target.offset + lines[target.line - 1].length + 1;

  // Swallow blank line(s) immediately after the heading (mirrors the retired
  // regex's greedy `\s*` folding them into the discarded match).
  //
  // F7 (#2245 review, nit): recognise a CRLF blank line (`\r\n`), not only a
  // bare LF — a lone `content[bodyStart] === '\n'` check never advances past
  // a `\r` byte, so on a CRLF STATE.md the blank line right after the
  // heading fell into the DISCARDED [bodyStart, bodyEnd) span instead of the
  // KEPT prefix, silently dropping one blank line (contradicting this
  // function's own byte-parity docstring).
  let bodyStart = headingLineEnd;
  while (bodyStart < content.length) {
    if (content[bodyStart] === '\n') { bodyStart += 1; continue; }
    if (content[bodyStart] === '\r' && content[bodyStart + 1] === '\n') { bodyStart += 2; continue; }
    break;
  }

  // Stop at the next heading of level >= 2 (mirrors the retired regex's
  // literal `##` lookahead, which matches any ATX heading two-or-more levels
  // deep); leave exactly one newline unconsumed before it, or run to EOF.
  let bodyEnd = content.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (STOP_H2_PLUS(headings[j].level)) { bodyEnd = headings[j].offset - 1; break; }
  }

  return content.slice(0, bodyStart) + newBody + content.slice(bodyEnd);
}

/**
 * Apply a `milestoneComplete` transition to STATE.md content.
 *
 * Migrates the STATE.md write path inside `cmdMilestoneComplete` (milestone.cts)
 * onto the substrate. Owns the closure write: Status (`<version> milestone
 * complete`), Last Activity, Last Activity Description, a ## Current Position
 * reset to the "Awaiting next milestone" state, and a ## Operator Next Steps
 * reset pointing at the next-milestone command.
 *
 * The adapter (`cmdMilestoneComplete`) retains `writeStateMd` (the writer that
 * owns the lock + steady-state syncStateFrontmatter post-sync) and resolves the
 * runtime-specific next-milestone slash command, injecting it via
 * `intent.nextMilestoneCommand` so the core stays pure.
 *
 * Behavior is byte-for-byte with the pre-migration milestone.cts:314-353 block.
 */
function milestoneCompleteCore(
  content: string,
  intent: { kind: 'milestoneComplete'; version: string; nextMilestoneCommand: string },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
  const today = deps.clock.localToday();
  const version = intent.version;

  for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore milestoneComplete: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only.
  const { body: initialBody, reassemble } = beginFrontmatterReassembly(content, deps.sourcePath);
  let body = initialBody;

  // Status — `<version> milestone complete`.
  const statusAfter = stateReplaceFieldWithFallback(body, 'Status', null, `${version} milestone complete`);
  if (statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Last Activity.
  const lastActivityAfter = stateReplaceFieldWithFallback(body, 'Last Activity', 'Last activity', today);
  if (lastActivityAfter !== body) {
    body = lastActivityAfter;
    updated.push('Last Activity');
  }

  // Last Activity Description.
  const ladAfter = stateReplaceFieldWithFallback(
    body,
    'Last Activity Description',
    null,
    `${version} milestone completed and archived`,
  );
  if (ladAfter !== body) {
    body = ladAfter;
    updated.push('Last Activity Description');
  }

  // ## Current Position reset — stop resume/progress flows pointing at closed
  // execution instructions.
  const closedPositionBody =
    `\nPhase: Milestone ${version} complete\n` +
    `Plan: —\n` +
    `Status: Awaiting next milestone\n` +
    `Last activity: ${today} — Milestone ${version} completed and archived\n\n`;
  const positionReset = resetSectionVerbatim(
    body,
    (h) => h.level === 2 && /^current\s+position$/i.test(h.text),
    closedPositionBody,
  );
  if (positionReset !== null) {
    body = positionReset;
  } else {
    body = `${body.trimEnd()}\n\n## Current Position\n${closedPositionBody}`;
  }
  updated.push('Current Position');

  // ## Operator Next Steps — normalize stale tails that can persist after close.
  const operatorReset = resetSectionVerbatim(
    body,
    (h) => h.level === 2 && /^operator\s+next\s+steps$/i.test(h.text),
    `\n- Start the next milestone with ${intent.nextMilestoneCommand}\n\n`,
  );
  if (operatorReset !== null) {
    body = operatorReset;
  } else {
    body = `${body.trimEnd()}\n\n## Operator Next Steps\n\n- Start the next milestone with ${intent.nextMilestoneCommand}\n`;
  }
  updated.push('Operator Next Steps');

  return { content: reassemble(body), updated };
}

// ----------------------------------------------------------------------------
// patch — intent implementation (Phase 6)
// ----------------------------------------------------------------------------

/**
 * Apply a `patch` transition to STATE.md content.
 *
 * Migrates `cmdStatePatch` (state.cts) onto the substrate. Applies each
 * caller-supplied `{field: value}` pair, resolved BODY-FIRST:
 *
 * - A key that resolves against the STRIPPED body (via `stateReplaceField`,
 *   case-insensitive on the field name) is applied there and reported
 *   `updated` — this is the legitimate, documented case (display-cased body
 *   fields — Status, Current Plan, Phase — which are never frontmatter
 *   keys). It wins deterministically even when the same key also happens to
 *   exist as a parsed frontmatter key (e.g. `status` matches both the
 *   frontmatter key and a `Status:` body line) — frontmatter is inert for
 *   that key.
 * - Only when the body has no match is the key checked against parsed
 *   frontmatter (determined structurally, never by a naming heuristic), and
 *   routed through the seam: `FIELD_CLASSIFICATION` governs it. A CLASSIFIED
 *   key (has a row, e.g. `current_phase`, `current_phase_name`) is NOT
 *   writable by an arbitrary patch — policy owns it — and is reported
 *   `failed`. An UNCLASSIFIED key (no row, e.g. a custom `risk_level`) is a
 *   pass-through per Phase 1 behavior-table row 19 ("field absent from
 *   FIELD_CLASSIFICATION → untouched pass-through"): it is applied directly
 *   to the frontmatter object before reassembly and reported `updated`.
 * - A key matching neither the body nor the frontmatter is reported `failed`.
 *
 * ADR-3408 §8.3(b): this used to run `stateReplaceField` over the FULL
 * document (body + frontmatter), which — because `field` is an arbitrary,
 * caller-supplied string, unlike every other `stateReplaceField` call site in
 * this file, which passes a fixed Title-Case string literal that can never
 * collide with a lowercase/snake_case YAML key — let a frontmatter-shaped
 * patch key (e.g. `status`, `current_phase`) match and rewrite the YAML
 * frontmatter block directly via `stateReplaceField`'s case-insensitive
 * `^field:` line pattern, entirely outside `FIELD_CLASSIFICATION` and the
 * write-seam preservation policy: a second, undeclared writer. The fix is
 * that a CLASSIFIED frontmatter key no longer writes outside the declared
 * policy table — not that every frontmatter-shaped key stops working.
 * `.gsd/phase/refactor-3469-one-write-seam/40-design.md` row 9 requires
 * frontmatter changes to route through the seam (still work, governed by
 * FIELD_CLASSIFICATION), not to stop working outright. Body-shaped keys
 * (`Status`, `Current Plan`, `Phase`, ...) are the LEGITIMATE case and are
 * unaffected — they were always matched against the body text, and still are.
 *
 * The curated-field preservation that fixes #1743/#1695 is NOT in this core —
 * it lives in the write seam's post-sync delta (table-driven via
 * `current_phase_name`'s `preserve-when-unchanged` row, ADR-3408 §8.1 —
 * reclassified from `preserve-always` in #3468 to match its long-standing,
 * delta-gated behavior).
 * `patch` consulting the table "refuses to overwrite" curated fields implicitly:
 * when the patch does not change a curated field's body source line, the
 * existing frontmatter value wins over the sync re-derivation. The adapter
 * still owns field-name validation (security) and the resync-progress decision.
 *
 * `data.updated` / `data.failed` mirror the pre-migration CLI output shape.
 */
function patchCore(
  content: string,
  intent: { kind: 'patch'; patches: Record<string, string> },
): StateTransitionResult {
  const { existingFm, hasFrontmatter, fmPrefix, unparseableFm } = beginFrontmatterReassembly(content);
  // #3881 review, finding 5: see beginPhaseCore's identical comment above — `body` stays a
  // literal `stripFrontmatter(content)` assignment here for scripts/lint-state-write-path-drift.cjs's
  // Axis 3 single-hop backward scan.
  let body = stripFrontmatter(content);
  const fm: Record<string, unknown> = { ...existingFm };

  const updated: string[] = [];
  const failed: string[] = [];

  for (const [field, value] of Object.entries(intent.patches)) {
    // Body-first: a key that resolves against a body field is the
    // legitimate, documented case (display-cased body fields — Status,
    // Current Plan, Phase — are never frontmatter keys) and wins
    // deterministically even when the same key also happens to exist as a
    // frontmatter key (case-insensitively, via stateReplaceField's
    // `^field:` pattern — e.g. `status` matching both the frontmatter key
    // and a `Status:` body line). Frontmatter is only consulted when the
    // body has no match for this key.
    const replaced = stateReplaceField(body, field, value);
    if (replaced !== null) {
      body = replaced;
      updated.push(field);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(existingFm, field)) {
      // Frontmatter-shaped key: route through the seam. A classified field
      // is policy-owned — a raw patch may not bypass it. An unclassified
      // field is an untouched pass-through (behavior-table row 19).
      if (getFieldClassification(field) !== null) {
        failed.push(field);
      } else {
        fm[field] = value;
        updated.push(field);
      }
      continue;
    }

    failed.push(field);
  }

  if (updated.length === 0) {
    // No field matched — return `content` VERBATIM (mirrors `updateCore`'s
    // null-result branch): reassembling via stripFrontmatter/
    // reconstructFrontmatter even when nothing changed can round-trip the
    // frontmatter block to different bytes than the original (key order,
    // formatting), which would falsely defeat `readModifyWriteStateMd`'s
    // #948 no-op write guard for every patch that updates nothing, not just
    // a frontmatter-shaped one.
    return { content, updated, data: { updated, failed } };
  }

  const result = hasFrontmatter
    ? `---\n${reconstructFrontmatter(fm as unknown as Frontmatter)}\n---\n\n${body}`
    : unparseableFm
      ? `${fmPrefix}${body}`
      : body;

  return { content: result, updated, data: { updated, failed } };
}

// ----------------------------------------------------------------------------
// update — intent implementation (Phase 7)
// ----------------------------------------------------------------------------

/**
 * Apply an `update` transition to STATE.md content.
 *
 * Migrates `cmdStateUpdate` (state.cts) onto the substrate. A single-field
 * body-only update (the field is replaced in the body; frontmatter is preserved
 * as-is and re-synced by the adapter's `readModifyWriteStateMd` post-sync).
 * Mirrors the pre-migration body-strip/reassemble contract.
 */
function updateCore(
  content: string,
  intent: { kind: 'update'; field: string; value: string },
): StateTransitionResult {
  const { existingFm, hasFrontmatter, reassemble } = beginFrontmatterReassembly(content);
  // #3881 review, finding 5: see beginPhaseCore's identical comment above — `body` stays a
  // literal `stripFrontmatter(content)` assignment here for scripts/lint-state-write-path-drift.cjs's
  // Axis 3 single-hop backward scan.
  const body = stripFrontmatter(content);
  // #3699 review: session-scoped fields are written through the session-scoped
  // writer. A whole-body `stateReplaceField` matches the FIRST occurrence
  // anywhere, so with no `Stopped At:` line in `## Session` but a stale one in
  // `## Session Continuity Archive`, `state update "Stopped At" …` reported
  // `updated: true` while rewriting the ARCHIVE line and leaving both the session
  // section and the `stopped_at` frontmatter key untouched — a silent corruption
  // of a historical record reported as success. #3374 already established this
  // rule for the other writer; this one had not adopted it.
  const sessionWriteLabels = sessionLabelsForBodyField(intent.field);
  let result: string | null;
  if (sessionWriteLabels) {
    // Replace-only by contract: unchanged content means the field is not in the
    // session section, which is a miss, not a write.
    const replaced = stateReplaceFieldInSession(body, sessionWriteLabels.primary, sessionWriteLabels.fallback, intent.value);
    result = replaced === body ? null : replaced;
  } else {
    result = stateReplaceField(body, intent.field, intent.value);
  }
  if (result === null) {
    // #3699 case D — the frontmatter fallback.
    //
    // Normally frontmatter keys are NOT writable here: they are projections, and
    // `buildStateFrontmatter` re-derives them from the body on every write, so a
    // direct frontmatter write would be discarded. But when the body source line
    // is absent entirely, there is nothing to derive FROM: the key's existing
    // value survives on `preserve-when-unchanged`, and neither the frontmatter
    // key nor the body field can be updated by any route. That document is
    // unrepairable through `state update`, which is the gap this closes.
    //
    // Deliberately narrow — all three must hold:
    //   (1) the field is a frontmatter key with a known body source,
    //   (2) NO body source line exists, so the body route is genuinely unavailable
    //       (this is what keeps case A, where the body route works, routing to the
    //       body as before), and
    //   (3) the frontmatter already carries the key, so this updates a value that
    //       is really there rather than inventing one.
    //
    // The presence check in (2) is UNSCOPED on purpose, unlike the builder's
    // `## Session` scoping for stopped_at/paused_at. The asymmetry is the safe
    // direction: any `Stopped at:` line anywhere in the body — including one in an
    // archive section — suppresses the fallback, so this never writes frontmatter
    // while a body line the user could edit still exists.
    const bodySource = getFrontmatterBodySource(intent.field);
    const frontmatterCarriesKey =
      hasFrontmatter && Object.prototype.hasOwnProperty.call(existingFm, intent.field);
    // The presence check asks the same question the WRITE asks, in the same
    // scope. An earlier cut checked the whole body on the reasoning that any
    // editable line should suppress the repair — but a line the reader never
    // reads is not a source, and suppressing on it left the document
    // unrepairable while pointing the user at a command that would rewrite the
    // wrong line. Same scope for read, write and probe, or they disagree.
    const sessionProbeLabels = sessionLabelsForKey(intent.field);
    const bodySourceExists = sessionProbeLabels
      ? sessionSourceExists(body, sessionProbeLabels)
      : (bodySource ?? []).some((f) => stateExtractField(body, f) !== null);
    if (bodySource && frontmatterCarriesKey && !bodySourceExists) {
      const nextFm = { ...existingFm, [intent.field]: intent.value };
      return {
        content: `---\n${reconstructFrontmatter(nextFm as unknown as Frontmatter)}\n---\n\n${body}`,
        updated: [intent.field],
        data: { updated: true, wroteFrontmatter: true },
      };
    }
    return { content, updated: [], data: { updated: false } };
  }
  const reassembled = reassemble(result);
  return { content: reassembled, updated: [intent.field], data: { updated: true } };
}

// ----------------------------------------------------------------------------
// prune — intent implementation (Phase 7)
// ----------------------------------------------------------------------------

type PrunedSection = { section: string; count: number; lines: string[] };

// Stop predicate for prune section slicing: a level-2 OR level-3 heading ends
// the section (mirrors state.cts STOP_H2_H3 — Decisions / Recently Completed /
// Blockers / Performance Metrics live at H2 or H3).
const STOP_H2_H3 = (lv: number): boolean => lv === 2 || lv === 3;

/**
 * Apply a `prune` transition to STATE.md content.
 *
 * Migrates the section-pruning half of `cmdStatePrune` (state.cts) onto the
 * substrate. Pure `content → {content, archivedSections}` given a cutoff phase:
 * archives Decisions / Recently Completed / resolved Blockers / Performance
 * Metrics table rows whose phase number is <= cutoff. ADR-1372 T6
 * tokenizeHeadings + untrimmed-span splicing, byte-identical to the pre-migration
 * `prunePass`.
 *
 * The adapter owns currentPhase derivation (with the #1760 `Phase` / `Current
 * Phase` fallback), keepRecent/dryRun, and STATE-ARCHIVE.md writes.
 */
function pruneCore(
  content: string,
  intent: { kind: 'prune'; cutoff: number },
): StateTransitionResult {
  const cutoff = intent.cutoff;
  const sections: PrunedSection[] = [];
  let c = content;

  // Helper: locate a heading matching pred, extract untrimmed body [bs, se),
  // apply transform, splice back. All prune sections stop at level 2 or 3.
  const pruneSectionSpan = (
    pred: (lv: number, text: string) => boolean,
    transform: (body: string) => { keep: string[]; archive: string[] },
    sectionName: string,
  ): void => {
    const hs = tokenizeHeadings(c);
    const i = hs.findIndex((h) => pred(h.level, h.text));
    if (i === -1) return;
    const h = hs[i];
    const ls = c.split('\n');
    const hl = ls[h.line - 1];
    const bs = h.offset + hl.length + 1;
    let se = c.length;
    for (let j = i + 1; j < hs.length; j++) {
      if (STOP_H2_H3(hs[j].level)) {
        se = hs[j].offset - 1;
        break;
      }
    }
    const body = c.slice(bs, se);
    const { keep, archive } = transform(body);
    if (archive.length > 0) {
      sections.push({ section: sectionName, count: archive.length, lines: archive });
      c = c.slice(0, bs) + keep.join('\n') + c.slice(se);
    }
  };

  pruneSectionSpan(
    (lv, text) => (lv === 2 || lv === 3) && /^(?:Decisions|Decisions Made|Accumulated.*Decisions)$/i.test(text),
    (body) => {
      const keep: string[] = [], archive: string[] = [];
      for (const line of body.split('\n')) {
        const phaseMatch = line.match(/^\s*-\s*\[Phase\s+(\d+)/i);
        if (phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) { archive.push(line); } else { keep.push(line); }
      }
      return { keep, archive };
    },
    'Decisions',
  );

  pruneSectionSpan(
    (lv, text) => (lv === 2 || lv === 3) && /^recently\s+completed$/i.test(text),
    (body) => {
      const keep: string[] = [], archive: string[] = [];
      for (const line of body.split('\n')) {
        const phaseMatch = line.match(/Phase\s+(\d+)/i);
        if (phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) { archive.push(line); } else { keep.push(line); }
      }
      return { keep, archive };
    },
    'Recently Completed',
  );

  pruneSectionSpan(
    (lv, text) => (lv === 2 || lv === 3) && /^(?:Blockers|Blockers\/Concerns|Blockers\s*&\s*Concerns)$/i.test(text),
    (body) => {
      const keep: string[] = [], archive: string[] = [];
      for (const line of body.split('\n')) {
        const isResolved = /~~.*~~|\[RESOLVED\]/i.test(line);
        const phaseMatch = line.match(/Phase\s+(\d+)/i);
        if (isResolved && phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) { archive.push(line); } else { keep.push(line); }
      }
      return { keep, archive };
    },
    'Blockers (resolved)',
  );

  pruneSectionSpan(
    (lv, text) => (lv === 2 || lv === 3) && /^performance\s+metrics$/i.test(text),
    (body) => {
      const keep: string[] = [], archive: string[] = [];
      for (const line of body.split('\n')) {
        const tableRowMatch = line.match(/^\|\s*(\d+)\s*\|/);
        if (tableRowMatch) {
          const rowPhase = parseInt(tableRowMatch[1], 10);
          if (rowPhase <= cutoff) { archive.push(line); } else { keep.push(line); }
        } else {
          keep.push(line);
        }
      }
      return { keep, archive };
    },
    'Performance Metrics',
  );

  const totalPruned = sections.reduce((sum, s) => sum + s.count, 0);
  return {
    content: c,
    updated: totalPruned > 0 ? ['pruned'] : [],
    data: { archivedSections: sections, totalPruned },
  };
}

// ----------------------------------------------------------------------------
// sync — intent implementation (Phase 7)
// ----------------------------------------------------------------------------

/**
 * Apply a `sync` transition to STATE.md content.
 *
 * Migrates the body-write half of `cmdStateSync` (state.cts) onto the substrate.
 * Updates Total Plans in Phase, the Progress bar, and Last Activity from
 * disk-derived numbers (injected via the intent). Returns the per-field change
 * log via `data.changes` so the adapter can build the CLI output.
 *
 * #1761: when the current milestone cannot be bounded to a versioned phase set,
 * the adapter passes `percent: null` and this core leaves Progress untouched
 * (rather than silently writing fallback-derived wrong values).
 */
function syncCore(
  content: string,
  intent: { kind: 'sync'; totalPlansInPhase: number | null; percent: number | null },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const today = deps.clock.localToday();
  const changes: string[] = [];
  let modified = content;
  const updated: string[] = [];

  if (intent.totalPlansInPhase !== null) {
    const currentPlansField = stateExtractField(modified, 'Total Plans in Phase');
    if (currentPlansField && parseInt(currentPlansField, 10) !== intent.totalPlansInPhase) {
      changes.push(`Total Plans in Phase: ${currentPlansField} -> ${intent.totalPlansInPhase}`);
      const result = stateReplaceField(modified, 'Total Plans in Phase', String(intent.totalPlansInPhase));
      if (result) { modified = result; updated.push('Total Plans in Phase'); }
    }
  }

  if (intent.percent !== null) {
    const currentProgress = stateExtractField(modified, 'Progress');
    if (currentProgress) {
      const currentPercent = parseInt(currentProgress.replace(/[^\d]/g, ''), 10);
      if (currentPercent !== intent.percent) {
        const result = stateReplaceProgressPercent(modified, intent.percent);
        if (result) {
          const progressStr = formatProgressMachineSegment(intent.percent);
          changes.push(`Progress: ${currentProgress} -> ${progressStr}`);
          modified = result; updated.push('Progress');
        }
      }
    }
  }

  const lastActivityResult = stateReplaceField(modified, 'Last Activity', today);
  if (lastActivityResult) {
    const oldActivity = stateExtractField(modified, 'Last Activity');
    if (oldActivity !== today) {
      changes.push(`Last Activity: ${oldActivity} -> ${today}`);
      updated.push('Last Activity');
    }
    modified = lastActivityResult;
  }

  return { content: modified, updated, data: { changes } };
}

// ----------------------------------------------------------------------------
// rebuild — intent implementation (ADR-1817, capstone 11th transition)
// ----------------------------------------------------------------------------
//
// Implements the body-structure derivability contract (ADR-1817 §2–§6):
//   - §2  re-derives derived sections (## Current Position prose, By Phase table
//         inside ## Performance Metrics), preserves curated sections verbatim
//         (## Accumulated Context, ## Deferred Items, ## Project Reference, ##
//         Session Continuity's prose fields) and unknown sections.
//   - §3  every mutation appends a structured entry to ## Rebuild Log
//         (ADR-1411 provenance principle — never drop silently).
//   - §4  idempotency: a no-mutation rebuild appends NO log entry, so two
//         successive runs on a clean file are byte-identical.
//   - §5  non-overlapping with sync (sync = 3 frontmatter fields, lightweight,
//         auto-triggered; rebuild = body structure, heavier, manual).
//   - §6  orthogonal to auto_prune_state (rebuild reconciles with current
//         canonical sources; prune removes by retention policy).
//
// Section ordering is invariant: rebuild rewrites content IN PLACE; it does
// not reorder, insert (other than ## Rebuild Log when absent), or remove
// sections.

const REBUILD_LOG_SECTION = '## Rebuild Log';
const REBUILD_LOG_TRUNCATION_LIMIT = 512;

type RebuildLogEntryKind =
  | 'placeholder-removed'
  | 'current-position-reconciled'
  | 'by-phase-table-reconciled'
  | 'session-archive-deduplicated';

interface RebuildLogEntry {
  timestamp: string;
  kind: RebuildLogEntryKind;
  section: string;
  before: string;
  after: string;
  reason: string;
}

/**
 * Out-of-band signal from `reconcileByPhaseTable` back to `rebuildCore`
 * (issue #3057 B1): a mutable sibling to `log`, carrying whether the
 * phase-inventory disk scan failed. Kept separate from `log`/`RebuildLogEntry`
 * because a scan failure does not mutate content (there is nothing to diff),
 * so it does not fit the before/after log-entry shape — but it still must
 * reach the caller so "scan failed" and "nothing to reconcile" stay
 * distinguishable in `rebuildCore`'s returned `data`.
 */
interface PhaseInventoryScanMeta {
  failed: boolean;
  reason: string | null;
}

/**
 * Truncate a string for inclusion in a rebuild log entry. Per ADR-1817 §3 the
 * `before` / `after` fields are bounded to REBUILD_LOG_TRUNCATION_LIMIT chars
 * to prevent unbounded log growth when the drifted content is large.
 */
function truncateForLog(s: string): string {
  if (s.length <= REBUILD_LOG_TRUNCATION_LIMIT) return s;
  return s.slice(0, REBUILD_LOG_TRUNCATION_LIMIT - 3) + '...';
}

/**
 * Apply a `rebuild` transition to STATE.md content. Pure core per ADR-1769 §3
 * and ADR-1817 §1. Returns `{ content, updated, data }` where `data.mutated`
 * is false when no drift was found (idempotency contract, ADR-1817 §4).
 */
function rebuildCore(
  content: string,
  _intent: { kind: 'rebuild' },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const timestamp = deps.clock.nowIso();
  const log: RebuildLogEntry[] = [];
  const phaseInventoryScan: PhaseInventoryScanMeta = { failed: false, reason: null };
  let modified = content;

  // §2 Decision: re-derive derived sections, preserve others. Order is
  // oldest-section-first so log entries appear in body order.
  // sourcePath threaded so `state rebuild --dry-run` names the file: that branch reads STATE.md
  // directly rather than through readModifyWriteStateMd, so nothing upstream has named it yet.
  modified = reconcileCurrentPosition(modified, timestamp, log, deps.sourcePath);
  modified = reconcileByPhaseTable(modified, deps, timestamp, log, phaseInventoryScan);
  modified = stripTemplatePlaceholders(modified, timestamp, log);
  modified = deduplicateSessionArchive(modified, timestamp, log);

  // §3 + §4: append the audit log ONLY when mutations occurred. The
  // log-appends-only-on-mutation rule is what makes idempotency byte-identical
  // (without it, the second invocation would always append a no-op entry).
  if (log.length > 0) {
    modified = appendRebuildLogSection(modified, log);
  }

  const updated = log.length > 0 ? ['rebuild'] : [];
  return {
    content: modified,
    updated,
    data: {
      mutated: log.length > 0,
      mutations: log.length,
      log,
      // #3057 B1: distinguishable from a clean "nothing to reconcile" — a
      // failed phase-inventory scan means the by-phase table was NOT
      // verified against disk, even though `mutated` may still be false.
      phase_inventory_scan_failed: phaseInventoryScan.failed,
      ...(phaseInventoryScan.reason !== null ? { phase_inventory_scan_reason: phaseInventoryScan.reason } : {}),
    },
  };
}

/**
 * §2 — re-derive `## Current Position` prose fields from frontmatter.
 *
 * Drift class: `Phase:`, `Status:` etc. in body contradict frontmatter after
 * a milestone switch or prune (epic #1817). The body prose is re-derivable
 * because `buildStateFrontmatter` already derives the canonical values from
 * disk; rebuild pushes those back into the body prose.
 *
 * Implementation: pull each canonical value from frontmatter and replace the
 * body field via `stateReplaceField`. Skip silently when frontmatter lacks
 * the key (Leaky-Abstractions guard — don't synthesize values the canonical
 * source doesn't have).
 */
function reconcileCurrentPosition(
  content: string,
  timestamp: string,
  log: RebuildLogEntry[],
  sourcePath?: string,
): string {
  const fm = extractFrontmatter(content, sourcePath) as Record<string, unknown>;
  if (!fm || typeof fm !== 'object') return content;

  let modified = content;

  // Phase prose: frontmatter `current_phase` overrides body `**Current Phase:**`.
  // The body `Phase:` prose line (e.g. "Phase: 3 of 12 (Test Phase)") is owned
  // by other transitions (beginPhase / completePhase) and reconstructed from
  // total-phase counts; rebuild reconciles only the `**Current Phase:**` body
  // field that frontmatter is the canonical source for.
  const fmPhase = fm.current_phase;
  if (typeof fmPhase === 'string' || typeof fmPhase === 'number') {
    const canonicalPhase = String(fmPhase);
    const existing = stateExtractField(modified, 'Current Phase');
    if (existing !== null && existing !== canonicalPhase) {
      const replaced = stateReplaceField(modified, 'Current Phase', canonicalPhase);
      if (replaced !== null) {
        modified = replaced;
        log.push({
          timestamp,
          kind: 'current-position-reconciled',
          section: STATE_MD_SECTIONS.currentPosition,
          before: truncateForLog(existing),
          after: truncateForLog(canonicalPhase),
          reason: "frontmatter 'current_phase' is canonical; body 'Current Phase' was stale",
        });
      }
    }
  }

  // Phase name prose.
  const fmPhaseName = fm.current_phase_name;
  if (typeof fmPhaseName === 'string' || typeof fmPhaseName === 'number') {
    const canonicalName = String(fmPhaseName);
    const existing = stateExtractField(modified, 'Current Phase Name');
    if (existing !== null && existing !== canonicalName) {
      const replaced = stateReplaceField(modified, 'Current Phase Name', canonicalName);
      if (replaced !== null) {
        modified = replaced;
        log.push({
          timestamp,
          kind: 'current-position-reconciled',
          section: STATE_MD_SECTIONS.currentPosition,
          before: truncateForLog(existing),
          after: truncateForLog(canonicalName),
          reason: "frontmatter 'current_phase_name' is canonical; body 'Current Phase Name' was stale",
        });
      }
    }
  }

  return modified;
}

/**
 * §2 — re-derive the `**By Phase:**` table inside `## Performance Metrics`
 * from the injected `phaseInventoryProvider`. Drift class: orphaned rows for
 * phases from a prior milestone, or zero-padded phase IDs that were renamed
 * (epic #1817).
 *
 * Leaky-Abstractions guard (ADR-1817 §1): when `phaseInventoryProvider` is
 * absent (no disk scan wired), this step is a no-op. The core stays pure and
 * testable without disk I/O.
 *
 * A DIFFERENT case is a scan that ran but failed (`ok:false`): that is NOT a
 * no-op-equivalent "nothing to reconcile" — the table is left untouched (we
 * have no trustworthy inventory to reconcile against) but the failure is
 * recorded into `meta` so the caller (`rebuildCore`) can surface it instead
 * of reporting a clean, fully-reconciled rebuild (#3057 B1).
 */
function reconcileByPhaseTable(
  content: string,
  deps: StateTransitionDeps,
  timestamp: string,
  log: RebuildLogEntry[],
  meta: PhaseInventoryScanMeta,
): string {
  if (!deps.phaseInventoryProvider) return content;
  const result = deps.phaseInventoryProvider();
  if (!result.ok) {
    meta.failed = true;
    meta.reason = result.reason;
    return content; // cannot reconcile without a trustworthy inventory — leave the table as-is
  }
  const inventory = result.phases;
  if (inventory.length === 0) return content;

  // The canonical table shape (from gsd-core/templates/state.md):
  //   | Phase | Plans | Total | Avg/Plan |
  //   |-------|-------|-------|----------|
  //   | -     | -     | -     | -        |
  // rebuild renders one row per inventory record (Phase N: P plans). The
  // Total/Avg columns are runtime-collected by other commands; rebuild does
  // NOT re-derive them and resets them to '-' so future plan-completion
  // repopulates. The canonical reconciliation target is the row SET.
  const tableRows = inventory.map((r) => `| ${r.number} | ${r.planCount} | - | - |`);
  const canonicalTable = [
    '| Phase | Plans | Total | Avg/Plan |',
    '|-------|-------|-------|----------|',
    ...tableRows,
  ];

  // Line-based splice: find `**By Phase:**` line, then walk forward collecting
  // the table block (header + separator + body rows), replace the block with
  // the canonical table preceded by a single blank-line separator.
  const lines = content.split('\n');
  const markerIdx = lines.findIndex((l) => l.trim() === '**By Phase:**');
  if (markerIdx === -1) return content; // unknown shape — preserve verbatim

  // Walk forward from markerIdx+1 to find the table block span. Skip leading
  // blank lines; once we see the first table row, consume subsequent table
  // rows; stop at the first non-table line after we've started.
  let blockStart = -1;
  let blockEnd = -1;
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isTable = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (blockStart === -1) {
      if (isTable) { blockStart = i; blockEnd = i + 1; }
      else if (trimmed === '') continue;
      else break; // non-table, non-blank before any row — unknown shape
    } else {
      if (isTable) blockEnd = i + 1;
      else break;
    }
  }
  if (blockStart === -1) return content; // no table found

  // Replace lines[blockStart..blockEnd) with canonicalTable.
  const beforeBlock = lines.slice(0, markerIdx + 1);
  const afterBlock = lines.slice(blockEnd);
  // Splice: `**By Phase:**` + blank + canonicalTable rows + (whatever came after)
  const newLines = [...beforeBlock, '', ...canonicalTable, ...afterBlock];
  const candidate = newLines.join('\n');

  if (candidate === content) return content;

  log.push({
    timestamp,
    kind: 'by-phase-table-reconciled',
    section: STATE_MD_SECTIONS.performanceMetrics,
    before: truncateForLog(lines.slice(blockStart, blockEnd).join('\n')),
    after: truncateForLog(canonicalTable.join('\n')),
    reason: 'phase dirs on disk are canonical; rows for missing phases dropped, missing phases added',
  });
  return candidate;
}

/**
 * §2 + epic-#1817 drift class — template-placeholder field values left in
 * place when an AI agent wrote partial state. The canonical template uses
 * `[X]`, `[Y]`, `[Phase name]`, `[date]`, `[N]`, etc. (see
 * `gsd-core/templates/state.md`). Rebuild clears any `**Field:** [placeholder]`
 * line where the value still matches the placeholder shape.
 *
 * "Clears" means: leaves the field in place with the literal text `(pending)`,
 * signalling that rebuild recognized the placeholder but had no canonical
 * source to substitute. This is honest — better than silently leaving `[X]`
 * which looks like a value.
 */
const TEMPLATE_PLACEHOLDER_VALUE = /^\s*\[[^\]]{1,200}\]\s*$|^\s*-\s*$/;

function stripTemplatePlaceholders(
  content: string,
  timestamp: string,
  log: RebuildLogEntry[],
): string {
  // Scan body `**Field:** value` lines; when value matches the placeholder
  // shape, replace with `(pending)`. We deliberately do NOT touch fields that
  // other transitions actively maintain (syncCore's three, beginPhase's set,
  // etc.) — only the template placeholder rows that nothing has touched.
  const lines = content.split('\n');
  const replacements: Array<{ lineIdx: number; before: string; after: string; fieldName: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\*\*([^*]+):\*\*\s*(.*)$/);
    if (!m) continue;
    const fieldName = m[1];
    const value = m[2];
    if (TEMPLATE_PLACEHOLDER_VALUE.test(value)) {
      const cleared = `**${fieldName}:** (pending)`;
      replacements.push({ lineIdx: i, before: line, after: cleared, fieldName });
    }
  }
  if (replacements.length === 0) return content;

  for (const r of replacements) {
    lines[r.lineIdx] = r.after;
    log.push({
      timestamp,
      kind: 'placeholder-removed',
      section: STATE_MD_SECTIONS.currentPosition,
      before: truncateForLog(r.before.trim()),
      after: truncateForLog(r.after),
      reason: `field ${JSON.stringify(r.fieldName)} still carried template placeholder ${JSON.stringify(r.before.match(/\*\*[^*]+:\*\*\s*(.*)$/)?.[1]?.trim() ?? '')}; no canonical source available — replaced with (pending)`,
    });
  }
  return lines.join('\n');
}

/**
 * §2 + epic-#1817 drift class — duplicate `## Session Continuity Archive`
 * blocks from repeated `state record-session` calls on a corrupt file. The
 * canonical template has one `## Session Continuity` section; archived blocks
 * may accumulate as `### Session — <timestamp>` H3 sub-sections under it.
 * Rebuild keeps the most-recent N (default 3) and drops older duplicates,
 * logging each drop.
 *
 * Conservative scope: only acts when the section has more than 3 H3
 * `### Session —` sub-headings; otherwise it's a no-op (preserve verbatim).
 */
const DEFAULT_MAX_SESSION_ARCHIVES = 3;
// `tokenizeHeadings` strips leading `#` markers — `h.text` for `### Session — X`
// is just `Session — X`. Match the bare heading text.
const SESSION_ARCHIVE_H3 = /^Session\s+—/;

function deduplicateSessionArchive(
  content: string,
  timestamp: string,
  log: RebuildLogEntry[],
): string {
  const hs = tokenizeHeadings(content);
  // Find `## Session Continuity` H2.
  const sectionIdx = hs.findIndex((h) => h.level === 2 && h.text === 'Session Continuity');
  if (sectionIdx === -1) return content;

  // Find the section span: from this H2's offset to the next H2 (or EOF).
  const sectionStart = hs[sectionIdx].offset;
  let sectionEnd = content.length;
  for (let i = sectionIdx + 1; i < hs.length; i++) {
    if (hs[i].level === 2) { sectionEnd = hs[i].offset; break; }
  }
  // Count `### Session — …` H3 sub-headings inside the section.
  const archiveHeadings = hs.filter(
    (h) => h.level === 3 && h.offset >= sectionStart && h.offset < sectionEnd && SESSION_ARCHIVE_H3.test(h.text),
  );
  if (archiveHeadings.length <= DEFAULT_MAX_SESSION_ARCHIVES) return content;

  // Keep the most-recent N by offset (last N in document order; if timestamps
  // in the H3 text are in chronological order — the template convention —
  // last-N == most-recent-N).
  const dropCount = archiveHeadings.length - DEFAULT_MAX_SESSION_ARCHIVES;
  const toDrop = archiveHeadings.slice(0, dropCount);

  // Compute the byte spans to drop: each archived H3 spans from its offset to
  // the next H3 (or to sectionEnd). Drop with one preceding blank line so we
  // don't leave a dangling separator.
  let mutated = content;
  // Process from the bottom up so offsets don't shift mid-edit.
  for (let i = toDrop.length - 1; i >= 0; i--) {
    const h = toDrop[i];
    let spanEnd = sectionEnd;
    // Find next H3 at-or-after h.offset (within the section).
    for (const candidate of hs) {
      if (candidate.level === 3 && candidate.offset > h.offset && candidate.offset < sectionEnd) {
        spanEnd = candidate.offset;
        break;
      }
    }
    const dropStart = h.offset;
    const before = mutated.slice(0, dropStart);
    const after = mutated.slice(spanEnd);
    const droppedText = mutated.slice(dropStart, spanEnd);
    mutated = before + after;

    log.push({
      timestamp,
      kind: 'session-archive-deduplicated',
      section: STATE_MD_SECTIONS.sessionContinuity,
      before: truncateForLog(droppedText),
      after: '',
      reason: `archived session ${JSON.stringify(h.text)} exceeded the ${DEFAULT_MAX_SESSION_ARCHIVES}-most-recent retention; dropped`,
    });
  }

  return mutated;
}

/**
 * §3 — append a structured audit entry to `## Rebuild Log`. Per ADR-1817 §3
 * the section is created if absent; existing entries are preserved verbatim
 * (append-only).
 *
 * Format (yaml-ish, human-readable, machine-parseable):
 *
 *   ## Rebuild Log
 *
 *   - timestamp: 2026-06-29T19:30:00Z
 *     kind: placeholder-removed
 *     section: ## Current Position
 *     before: ...
 *     after: ...
 *     reason: ...
 */
function appendRebuildLogSection(content: string, entries: RebuildLogEntry[]): string {
  const lines = content.split('\n');

  // Render the new entry block.
  const rendered: string[] = [];
  for (const e of entries) {
    rendered.push(`- timestamp: ${e.timestamp}`);
    rendered.push(`  kind: ${e.kind}`);
    rendered.push(`  section: ${e.section}`);
    rendered.push(`  before: ${e.before.replace(/\n/g, ' \\n ')}`);
    rendered.push(`  after: ${e.after.replace(/\n/g, ' \\n ')}`);
    rendered.push(`  reason: ${e.reason.replace(/\n/g, ' \\n ')}`);
  }

  // Locate an existing `## Rebuild Log` section.
  const sectionHeaderIdx = lines.findIndex((l) => l.trim() === REBUILD_LOG_SECTION);
  if (sectionHeaderIdx === -1) {
    // Create the section at end-of-file, separated by a blank line.
    const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1].trim() !== '';
    const trailer = needsLeadingBlank ? ['', REBUILD_LOG_SECTION, '', ...rendered] : [REBUILD_LOG_SECTION, '', ...rendered];
    return [...lines, ...trailer].join('\n');
  }

  // Append to the existing section. Find the end of the existing log entries
  // (walk forward until the next H2 or EOF). Insert before that boundary.
  let insertAt = sectionHeaderIdx + 1;
  while (insertAt < lines.length) {
    const l = lines[insertAt];
    if (/^##\s/.test(l)) break;
    insertAt++;
  }
  // Preserve a blank-line separator before the new entries if the prior line
  // is non-blank and non-header.
  const sep: string[] = [];
  if (insertAt > 0 && lines[insertAt - 1].trim() !== '' && lines[insertAt - 1].trim() !== REBUILD_LOG_SECTION) {
    sep.push('');
  }
  const next = [...lines.slice(0, insertAt), ...sep, ...rendered, ...lines.slice(insertAt)];
  return next.join('\n');
}
