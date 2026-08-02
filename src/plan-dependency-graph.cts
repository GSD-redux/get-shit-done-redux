/**
 * Plan Dependency Graph — shared halt-propagation over a plan's depends_on DAG (#2830).
 *
 * Two independent "which plans are incomplete" readers exist in this codebase:
 * phase.cts's wave-grouping (`cmdPhasePlanIndex`) and phase-locator.cts's
 * phase-location primitive (`searchPhaseInDir`, consumed by ~50 symbols across
 * five command routers). Before #2830, only the former parsed `depends_on` —
 * and even it used the DAG only for topological wave assignment, never to
 * propagate a halted plan's block onto its dependents. The latter never parsed
 * `depends_on` at all; it derived completion from summary-file presence only.
 * A plan that reaches a designed stop still writes a SUMMARY (recording the
 * halt in prose only — no prior structured status existed for it), so both
 * readers saw it as ordinary "complete" and reported its dependents as
 * ordinary incomplete work, available to spawn against.
 *
 * This module is the SINGLE topological-order + halt-propagation engine both
 * readers call, so the two can never re-diverge on this rule again. Each
 * caller resolves its own raw `depends_on` tokens to canonical plan ids
 * (case-fold + `extractCanonicalPlanId` fallback — the same resolution
 * already performed by phase.cts's `computeDependencyLevels`) before
 * building `PlanHaltNode[]`; this module owns the graph traversal (exactly
 * one pass — Kahn's algorithm, or none at all when the caller already has a
 * valid topological order, see `computeHaltPropagation`'s `precomputedOrder`
 * parameter) plus the two small pure helpers below (`isHaltedStatus`,
 * `buildSummaryFileIndex`) that both callers would otherwise duplicate
 * identically — the exact "two implementations, one drifts" failure mode
 * this fix exists to close. Each caller still owns its own file I/O (the
 * actual `fs.readFileSync` + `extractFrontmatter` calls); only the
 * interpretive logic is centralized here.
 */

/**
 * The one place "does this SUMMARY status value mean halted" is decided.
 * Case-insensitive, trims whitespace. Both `phase.cts`'s `cmdPhasePlanIndex`
 * and `phase-locator.cts`'s `searchPhaseInDir` call this after reading a
 * completed plan's SUMMARY frontmatter `status` field, so the definition of
 * "halted" cannot drift between the two readers.
 */
function isHaltedStatus(status: unknown): boolean {
  return typeof status === 'string' && status.trim().toLowerCase() === 'halted';
}

/**
 * Build a planId -> summary-filename lookup from a phase's summary file
 * list, keyed by both the exact SUMMARY-file-derived id and its canonical
 * form (mirrors the `completedPlanIds` construction each caller already
 * performs for its own SUMMARY-presence check — same `summaryFiles` list,
 * same exact/canonical key pair — so the two can never disagree about which
 * summary file belongs to which plan id). `extractCanonicalPlanId` is
 * supplied by the caller (each module owns its own resolution helper).
 */
function buildSummaryFileIndex(
  summaryFiles: string[],
  extractCanonicalPlanId: (filename: string) => string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const s of summaryFiles) {
    const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
    const canonical = extractCanonicalPlanId(s);
    index.set(exact, s);
    if (canonical !== exact) index.set(canonical, s);
  }
  return index;
}

interface PlanHaltNode {
  /** Canonical plan id, already resolved — matches another node's `id` for a dependency edge to count. */
  id: string;
  /** Dependency ids, already resolved to `id` values present in this node list. Unresolved/cross-phase deps must be filtered out by the caller before this call. */
  resolvedDependsOn: string[];
  /** True iff this plan's own completion record (SUMMARY) declares `status: halted`. */
  halted: boolean;
}

interface HaltPropagationResult {
  /**
   * Topological order (Kahn's algorithm), dependencies before dependents.
   * A length shorter than the input `nodes.length` signals a dependency
   * cycle among the unlisted ids — mirrors `computeDependencyLevels`'s
   * `visited` counter contract.
   */
  order: string[];
  visited: number;
  /**
   * planId -> de-duplicated list of halted plan ids that transitively block
   * it (direct or via any number of intermediate dependents). No entry means
   * not blocked. A halted plan's own id is never a key in its own value — a
   * halted plan is halted, not blocked by itself.
   */
  blockedBy: Map<string, string[]>;
}

/**
 * Computes halt-propagation over a plan dependency DAG.
 *
 * `precomputedOrder`: when the caller ALREADY has a valid topological order
 * for these exact node ids (e.g. phase.cts's `cmdPhasePlanIndex`, which runs
 * `computeDependencyLevels`'s Kahn's-algorithm pass for wave assignment
 * before ever calling this function), pass it here and this function skips
 * running Kahn's algorithm a second time — the halt-propagation forward pass
 * below only needs A valid topological order, not to derive one itself.
 * Omit it (as phase-locator.cts's `searchPhaseInDir` does — it has no prior
 * traversal of this DAG) and this function derives the order itself; either
 * way, exactly one Kahn's-algorithm pass runs per caller, never two.
 *
 * Diamond-safe (a plan blocked via two different halted ancestors gets both
 * in its `blockedBy` list, deduplicated) and transitive-safe (a dependent of
 * a dependent of a halted plan is blocked, at any depth).
 */
function computeHaltPropagation(nodes: PlanHaltNode[], precomputedOrder?: string[]): HaltPropagationResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  let order: string[];
  let visited: number;

  if (precomputedOrder) {
    // Caller already ran Kahn's algorithm over this exact node set (same ids)
    // — trust its order and skip re-deriving one. `visited` mirrors the same
    // "count of nodes reachable in valid topological order" contract a fresh
    // derivation would produce.
    order = precomputedOrder;
    visited = precomputedOrder.length;
  } else {
    const inDeg = new Map<string, number>();
    const adj = new Map<string, string[]>(); // dependency id -> dependent ids

    for (const n of nodes) {
      if (!inDeg.has(n.id)) inDeg.set(n.id, 0);
      if (!adj.has(n.id)) adj.set(n.id, []);
      for (const depId of n.resolvedDependsOn) {
        if (!byId.has(depId)) continue; // fail-safe: caller should have filtered these already
        if (!adj.has(depId)) adj.set(depId, []);
        (adj.get(depId) as string[]).push(n.id);
        inDeg.set(n.id, (inDeg.get(n.id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const n of nodes) {
      if ((inDeg.get(n.id) ?? 0) === 0) queue.push(n.id);
    }

    // Dequeue by head index, not Array.shift() — O(1) amortized, same
    // rationale as computeDependencyLevels (#307).
    let head = 0;
    let v = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      v++;
      for (const dep of adj.get(cur) ?? []) {
        inDeg.set(dep, (inDeg.get(dep) as number) - 1);
        if (inDeg.get(dep) === 0) queue.push(dep);
      }
    }
    order = queue;
    visited = v;
  }

  // `order` is a valid topological order for every visited node: for edge
  // dep -> dependent, dep appears before dependent. A single forward pass
  // over it — using each node's own already-resolved dependsOn ids —
  // computes blockedBy without any further graph traversal.
  const blockedBy = new Map<string, string[]>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const causes = new Set<string>();
    for (const depId of node.resolvedDependsOn) {
      const depNode = byId.get(depId);
      if (!depNode) continue;
      if (depNode.halted) causes.add(depId);
      const depCauses = blockedBy.get(depId);
      if (depCauses) {
        for (const c of depCauses) causes.add(c);
      }
    }
    if (causes.size > 0) blockedBy.set(id, Array.from(causes));
  }

  return { order, visited, blockedBy };
}

export = { computeHaltPropagation, isHaltedStatus, buildSummaryFileIndex };
