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

/** Result of deriveProgressFromRoadmap. */
export interface RoadmapProgress {
  completedPhases: number | null;
  totalPhases: number | null;
  totalPlans: number | null;
}

/**
 * Derive completed_phases, total_phases, and total_plans from ROADMAP content.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
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
  //
  // ADR-2143 §3: read the Progress table by column NAME (order/injection-invariant),
  // via the markdown-table seam. Scope to the `## Progress` section when present
  // (#2012 decoy avoidance); a headingless milestone slice (#1445) falls back to the
  // whole input. Requires the canonical Phase/Plans Complete/Status/Completed columns
  // in any order (extra columns ignored) — supersedes findTableBySchema's exact-schema lookup.
  const progressMatch = roadmapContent.match(/^##[ \t]+Progress\b/im);
  let scoped = roadmapContent;
  if (progressMatch && progressMatch.index !== undefined) {
    const afterHeading = roadmapContent.slice(progressMatch.index);
    const nextHeading = afterHeading.search(/\n#{1,2}[ \t]/);
    scoped = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  }
  const table = findTableWithColumns(scoped, ['Phase', 'Plans Complete', 'Status', 'Completed']);

  if (table) {
    const allRows = table.rows;

    const completed = allRows.filter((r) => /^complete$/i.test((r['Status'] ?? '').trim())).length;
    completedPhases = completed > 0 ? completed : null;

    // Data rows only (exclude 999.x backlog phases). Mirrors init.cts /^999(?:\.|$)/ filter.
    const dataRows = allRows.filter((r) => {
      const phase = (r['Phase'] ?? '').trim();
      return /^\d/.test(phase) && !/^999\b/.test(phase);
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
