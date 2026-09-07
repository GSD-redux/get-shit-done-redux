/**
 * Phase Lifecycle Pure Helpers — pure-computation functions extracted from
 * the phase-lifecycle SDK handler (ADR-457 build-at-publish: the hand-written
 * bin/lib/phase-lifecycle.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * I/O adapter pattern (ADR-3524 Section 4): each side supplies its own I/O
 * (sync readFileSync for CJS, async readFile for SDK); the pure computation
 * logic is shared via this generated artifact.
 *
 * Scope:
 *   - deriveProgressFromRoadmap(roadmapContent): count Complete rows => idempotent
 *   - clampPercent(completed, total): percent with 100 ceiling
 *
 * These two functions are the root-cause fix for issue #4.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (open-gsd/gsd-core)
 */

import { findTableWithColumns } from './markdown-table.cjs';
import type { MarkdownTable } from './markdown-table.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const { isSentinelPhaseId } = phaseIdMod;

/** Result of deriveProgressFromRoadmap. */
export interface RoadmapProgress {
  completedPhases: number | null;
  totalPhases: number | null;
  totalPlans: number | null;
}

/**
 * #3227: the single owner of "where is this ROADMAP's Progress table".
 * Lifted verbatim out of deriveProgressFromRoadmap so `state-contract.cts`
 * enumerates phases from THE SAME table this module derives its counts from.
 * A second copy of this locator is the DEFECT.GENERATIVE-FIX shape.
 *
 * ADR-2143 §3 ("addressed by NAME, never ordinal"): the Progress table is
 * located via the markdown-table seam's `findTableWithColumns`, which is
 * column-NAME/order/count-invariant — it matches the first table whose header
 * is a SUPERSET of the canonical `Phase` / `Plans Complete` / `Status` /
 * `Completed` names, in any order, tolerating extra/injected unrelated
 * columns (#2137's fast-check property test shuffles headers and injects
 * columns and asserts the derived counts never change). This supersedes the
 * earlier `findTableBySchema` exact-schema lookup, which required an exact
 * canonical column SET+ORDER and returned all-null on any reordering or
 * injection.
 *
 * Scoped to the `## Progress` section when the document has one (#2012 decoy
 * avoidance — a differently-headed table sharing the same column names must
 * not be picked up instead); a headingless milestone slice (#1445) falls back
 * to scanning the whole input, preserving the "Progress table not under a
 * `## Progress` heading, or not the first table in the document, still
 * resolves" behaviour.
 */
export function locateProgressTable(roadmapContent: string): MarkdownTable | null {
  const progressMatch = roadmapContent.match(/^##[ \t]+Progress\b/im);
  let scoped = roadmapContent;
  if (progressMatch && progressMatch.index !== undefined) {
    const afterHeading = roadmapContent.slice(progressMatch.index);
    const nextHeading = afterHeading.search(/\n#{1,2}[ \t]/);
    scoped = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  }
  return findTableWithColumns(scoped, ['Phase', 'Plans Complete', 'Status', 'Completed']);
}

/**
 * Derive completed_phases, total_phases, and total_plans from ROADMAP content.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 *
 * The Progress table itself is located by `locateProgressTable` (ADR-2143 §3,
 * lifted out as #3227's single-owner extraction) — this function consumes
 * that table.
 *
 * Cells are read by column NAME (`r['Status']`, `r['Plans Complete']`,
 * `r['Phase']`), fixing #2137 (the old position-based regex assumed "Status"
 * was always the 3rd cell and "Plans Complete" the 2nd, which broke for the
 * 5-column milestone-grouped variant that inserts a `Milestone` column ahead
 * of them).
 */
export function deriveProgressFromRoadmap(roadmapContent: string): RoadmapProgress {
  let completedPhases: number | null = null;
  let totalPhases: number | null = null;
  let totalPlans: number | null = null;

  // ADR-2143 §5 (fail-loud, no null-swallow): this used to be wrapped in a
  // try/catch that silently fell through to the existing (null) values on any
  // thrown error. `findTableWithColumns`/`parseMarkdownTable` never throw —
  // an unparseable or absent table resolves to `null` /
  // `{ ok: false, reason }`, not an exception — so the catch was masking
  // nothing but dead code paths. Removed per ADR-2143 §5; the public
  // `RoadmapProgress` contract (nulls = absent) is unchanged.
  const table = locateProgressTable(roadmapContent);

  if (table) {
    const allRows = table.rows;

    const completed = allRows.filter((r) => /^complete$/i.test((r['Status'] ?? '').trim())).length;
    completedPhases = completed > 0 ? completed : null;

    // Data rows only (exclude sentinel phases 0 and 999.x).
    // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
    const dataRows = allRows.filter((r) => {
      const phase = (r['Phase'] ?? '').trim();
      return /^\d/.test(phase) && !isSentinelPhaseId(phase);
    });
    totalPhases = dataRows.length > 0 ? dataRows.length : null;

    let totalPlansSum = 0;
    for (const r of allRows) {
      const cell = (r['Plans Complete'] ?? '').trim();
      const m = /(\d+)\s*\/\s*(\d+)/.exec(cell);
      if (m) totalPlansSum += parseInt(m[2], 10);
    }
    totalPlans = totalPlansSum > 0 ? totalPlansSum : null;
  }

  return { completedPhases, totalPhases, totalPlans };
}

/**
 * Compute progress percent clamped to 100 from an already-computed FRACTION.
 *
 * ADR-3180 Decision 7 (#3180): the completion-RATIO derivation has exactly one
 * owner, and this is its kernel — the single place the `fraction -> integer
 * percent` rounding and the 100 ceiling are expressed. `clampPercent` below is
 * the count-shaped entry point and delegates here; a caller that already holds a
 * fraction (rather than a completed/total pair) calls this directly instead of
 * re-deriving `Math.min(100, Math.round(f * 100))` locally.
 *
 * Enforced by `scripts/lint-completion-ratio-drift.cjs`.
 */
export function clampPercentFromFraction(fraction: number): number {
  return Math.min(100, Math.round(fraction * 100));
}

/**
 * Compute progress percent clamped to 100.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 *
 * A non-positive (or absent) denominator yields `0` — "nothing to complete" is
 * reported as 0%, never as 100%. Every `.planning/` completion percentage in this
 * codebase routes through here (ADR-3180 Decision 7); the `total > 0 ? ... : 0`
 * ternary that used to precede each inline copy IS this function's first line.
 */
export function clampPercent(completed: number, total: number): number {
  if (!total || total <= 0) return 0;
  return clampPercentFromFraction(completed / total);
}

/**
 * How many cells of a `width`-cell progress bar are filled for `percent`.
 *
 * #4294: the RENDER half's kernel — the counterpart of `clampPercentFromFraction`
 * one layer down. That function owns `fraction -> integer percent`; this one
 * owns `integer percent -> filled cells`, and is the single place that rounding
 * is expressed. Six call sites used to carry their own
 * `Math.round((percent / 100) * width)`, and every copy saturated: at width 10
 * that rounds to a full bar from 95 up, at width 20 from 98 up, so a project
 * at 19/20 plans drew the same bar as a shipped one beside a number that said
 * otherwise.
 *
 * Contract:
 *   - A FULL bar is reserved for an actual 100. Below 100 the fill is held one
 *     cell short of the width. This is the only departure from the old formula:
 *     at width 10 exactly 95-99 move (10 -> 9), at width 20 exactly 98-99
 *     (20 -> 19); every other percent in 0-100 rounds as before.
 *   - `null` / `undefined` / non-finite renders an empty bar, matching the
 *     `percent === null ? 0 : ...` guard the `progress` renderers already carried.
 *   - Out-of-range input is clamped to 0-100 before rounding, so the count is
 *     always within `[0, width]` and a `'░'.repeat(width - filled)` can never
 *     be handed a negative count (the old inline form threw `RangeError` at
 *     120%). A non-positive width yields 0.
 *
 * Callers wanting the glyph run call `renderProgressBar`; this is exported so
 * the rounding rule can be pinned directly against the legacy curve.
 */
export function progressBarFilledCells(percent: number | null | undefined, width: number): number {
  const cells = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (cells === 0) return 0;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped >= 100) return cells;
  // Scale by the WIDTH, not by 100 — this is cells-from-percent, not the
  // completion-ratio derivation lint-completion-ratio-drift.cjs guards.
  const rounded = Math.round((clamped / 100) * cells);
  return Math.min(rounded, cells - 1);
}

/**
 * Render the glyph run of a `width`-cell progress bar for `percent` —
 * `'█'` for each filled cell, `'░'` for the rest, always exactly `width`
 * glyphs (an empty string for a non-positive width). Brackets, the printed
 * percent and any suffix stay with the caller; the fill rule is
 * `progressBarFilledCells` (#4294).
 */
export function renderProgressBar(percent: number | null | undefined, width: number): string {
  const filled = progressBarFilledCells(percent, width);
  const cells = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}
