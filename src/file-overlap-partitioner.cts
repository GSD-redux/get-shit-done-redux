/**
 * File-overlap partitioner — shared greedy first-fit stage assignment (#3674).
 *
 * Extracted from `claude-orchestration.cts`'s `partitionStages` (#1143), which
 * emits sequential Workflow `parallel()` stage barriers so that no two plans
 * sharing a `files_modified` entry ever cohabit a stage. This module is the
 * SAME algorithm, generalized: it depends on no `Plan`/`Wave` interface from
 * `claude-orchestration.cts` (or any other caller-specific shape), so a future
 * consumer (quick-batch, #3675 / ADR-1239 "Quick-batch binding") can partition
 * its own planned-path items without pulling in orchestration internals.
 *
 * This is a pure, behavior-preserving extraction (#3674's acceptance bar is
 * byte-identical output for `claude-orchestration.cts`'s existing callers —
 * not an improvement). Explicitly OUT of scope, per the #3674 design lock:
 *   - dependency-DAG ordering — this module only ever sees a flat item list
 *     and file-overlap; a caller resolves dependency order before calling in
 *     (same contract `partitionStages` already had);
 *   - path normalization — file entries are compared by exact string equality
 *     only. `Foo.ts` vs `foo.ts`, or `src/a.ts` vs `src\a.ts`, are treated as
 *     DISTINCT files. This is deliberate, not a gap to "fix" during extraction;
 *   - filesystem access — this module never reads a path off disk.
 *
 * Zero external dependencies. Pure function. Never throws on well-typed input.
 */

/** A generic overlap-partitioned item: an id plus the files it touches. */
interface OverlapItem {
  id: string;
  files: string[];
}

/**
 * Partition `items` into a near-minimal number of sequential stages (via
 * greedy first-fit — not guaranteed optimal for arbitrary overlap graphs, but
 * correct: no two items sharing a file ever cohabit a stage) such that no two
 * items in the same stage share a file. Each item goes into the earliest
 * stage where it does not overlap any item already there, in input order.
 *
 * An item with an EMPTY `files` array declares no files; it overlaps nothing
 * and coalesces into stage 0 (mirrors `partitionStages`' original behavior —
 * this module cannot guard against undeclared concurrent writes; a caller
 * must declare `files` accurately).
 *
 * File comparison is EXACT STRING EQUALITY — no path normalization, no
 * case-folding, no separator canonicalization. Duplicate `id`s in the input
 * are NOT deduplicated; each item is placed independently, in input order.
 *
 * Deterministic: identical input (including input order) always yields an
 * identical partition.
 */
function partitionByFileOverlap(items: OverlapItem[]): string[][] {
  const stages: { items: OverlapItem[]; files: Set<string> }[] = [];
  for (const item of items) {
    const fileSet = new Set(item.files);
    let placed = false;
    for (const stage of stages) {
      let overlap = false;
      for (const f of fileSet) {
        if (stage.files.has(f)) { overlap = true; break; }
      }
      if (!overlap) {
        stage.items.push(item);
        for (const f of fileSet) stage.files.add(f);
        placed = true;
        break;
      }
    }
    if (!placed) {
      stages.push({ items: [item], files: new Set(fileSet) });
    }
  }
  return stages.map((s) => s.items.map((i) => i.id));
}

export = {
  partitionByFileOverlap,
};
