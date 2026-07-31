/**
 * Context Composer — shared budget-trim seam (ADR-1671 Decision item 2).
 *
 * Extracted from the five-step trim ladder in `prompt-budget.cts` by issue
 * #2929 (epic #1671 Phase 2) so a second consumer — per-runtime artifact
 * emission, in a later phase — can reuse the exact same trimming behavior
 * without re-deriving it. `prompt-budget.applyBudget` is routed through this
 * module in a follow-up commit, which asserts byte-identical output against
 * a committed corpus; the algorithm here is a characterization of that
 * existing behavior, not a redesign.
 *
 * THE COMPOSER DECIDES, THE CALLER RENDERS. `composeWithinBudget` never
 * joins fragments and never returns a rendered string — it returns a plan of
 * surviving fragments with their (possibly trimmed) content, plus metadata
 * describing what happened. Rendering is prompt-specific: the review-prompt
 * consumer assembles Markdown sections with blank-line separators; the
 * per-runtime emission consumer renders differently. Keeping the decision
 * (what survives, in what shape) separate from the render (how it is joined)
 * is what lets both consumers share this module.
 *
 * The budget unit is injected via `measure(text) => number` rather than
 * hardcoded to a token estimator: `prompt-budget` passes its chars/4
 * estimator, per-runtime emission passes a byte counter. `charsPerUnit` in
 * `ComposeOptions` is the inverse of `measure` (4 for chars/4, 1 for a byte
 * counter) and is what lets `proportional-truncate`'s char-budget math stay
 * unit-agnostic.
 *
 * ADR-1671's literal contract describes "priority + binary-search cutoff"
 * trimming. That description cannot express this module's actual shape:
 * head-shrink (structural, line-bounded) and proportional-truncate-with-floor
 * (per-fragment guaranteed minimum, not a single global cutoff) are not
 * binary-search cutoffs. `ShrinkStrategy` — not a numeric priority field — is
 * the core abstraction here, and a `cutoff` strategy is expected to join this
 * closed set once per-runtime emission needs binary-search behavior. Relatedly,
 * `verbatim` and `drop` fragments are never reordered by importance: survival
 * and drop order both follow DECLARATION order (the order fragments appear in
 * `ComposeInput.fragments`), not a numeric priority.
 */

/** How a fragment's content is treated under budget pressure. */
export type ShrinkStrategy =
  | { readonly kind: 'verbatim' }
  | { readonly kind: 'head-shrink'; readonly maxLines: number }
  | { readonly kind: 'proportional-truncate'; readonly floorChars: number }
  | { readonly kind: 'drop' };

/** A single named prompt/artifact section and how it may be shrunk. */
export interface Fragment {
  readonly id: string;
  readonly content: string;
  readonly wrapper?: string;
  readonly strategy: ShrinkStrategy;
  readonly required?: boolean;
  readonly group?: string;
}

/** Tuning knobs for {@link composeWithinBudget}. */
export interface ComposeOptions {
  readonly safetyMarginPct?: number;
  readonly reserve?: number;
  readonly charsPerUnit?: number;
  readonly minimumFor?: (fragment: Fragment) => string | null;
}

/** Input to {@link composeWithinBudget}. */
export interface ComposeInput {
  readonly fragments: readonly Fragment[];
  readonly budget: number;
  readonly measure: (text: string) => number;
  readonly options?: ComposeOptions;
}

/** One fragment's outcome after budget trimming. */
export interface ComposedFragment {
  readonly id: string;
  readonly content: string;
  readonly wrapper: string;
  readonly present: boolean;
  readonly shrunk: boolean;
  readonly truncated: boolean;
}

/** Metadata describing what {@link composeWithinBudget} did. */
export interface ComposeMetadata {
  readonly budget: number;
  readonly effectiveBudget: number;
  readonly contentBudget: number;
  readonly underPressure: boolean;
  readonly omitted: string[];
  readonly shrunk: string[];
  readonly truncationPct: number;
  readonly hardFailed: boolean;
  readonly hardFailReason: 'minimum-set' | null;
}

/** Result of {@link composeWithinBudget}: a plan, not a rendered string. */
export interface ComposeResult {
  readonly fragments: ComposedFragment[];
  readonly metadata: ComposeMetadata;
}

/**
 * Head-shrink a string to at most `maxLines` lines.
 *
 * Copied verbatim from `prompt-budget.cts` (formerly private) — do not
 * "improve" it; a committed corpus depends on this exact behavior.
 */
export function headShrink(text: string, maxLines: number): string {
  if (maxLines <= 0) return '';
  let idx = -1;
  let seen = 0;
  while (seen < maxLines) {
    idx = text.indexOf('\n', idx + 1);
    if (idx === -1) return text;
    seen += 1;
  }
  return text.slice(0, idx);
}

/**
 * Tail-truncate a string to at most `maxChars` characters.
 *
 * Copied verbatim from `prompt-budget.cts` (formerly private) — do not
 * "improve" it; a committed corpus depends on this exact behavior.
 */
export function tailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/** Internal mutable working copy of a fragment during the trim ladder. */
interface WorkingFragment {
  readonly id: string;
  readonly wrapper: string;
  readonly strategy: ShrinkStrategy;
  readonly required: boolean;
  readonly group: string | undefined;
  readonly originalLength: number;
  content: string;
  shrunk: boolean;
  truncated: boolean;
}

const isPresent = (w: WorkingFragment): boolean => w.required || Boolean(w.content);

const costOf = (w: WorkingFragment, measure: (text: string) => number): number =>
  isPresent(w) ? measure(w.wrapper) + measure(w.content) : 0;

const totalOf = (working: readonly WorkingFragment[], measure: (text: string) => number): number =>
  working.reduce((sum, w) => sum + costOf(w, measure), 0);

/**
 * Trim a set of fragments to fit within `budget`, following the exact
 * five-step ladder characterized from `prompt-budget.applyBudget`:
 * head-shrink, then group proportional-truncate, then declaration-order
 * drops — each pass individually guarded by the running total against the
 * content budget, walked once in declaration order.
 *
 * Returns a plan (surviving fragment content + metadata); it never renders.
 */
export function composeWithinBudget(input: ComposeInput): ComposeResult {
  const { fragments, budget, measure, options = {} } = input;
  const { safetyMarginPct = 0, reserve = 0, charsPerUnit = 1, minimumFor } = options;

  const effectiveBudget = Math.floor(budget * (1 - safetyMarginPct / 100));

  const seenIds = new Set<string>();
  const working: WorkingFragment[] = [];
  for (const f of fragments) {
    if (seenIds.has(f.id)) {
      throw new TypeError(`composeWithinBudget: duplicate fragment id "${f.id}"`);
    }
    seenIds.add(f.id);
    working.push({
      id: f.id,
      wrapper: f.wrapper ?? '',
      strategy: f.strategy,
      required: f.required === true,
      group: f.group,
      originalLength: f.content.length,
      content: f.content,
      shrunk: false,
      truncated: false,
    });
  }

  // Minimum-set pre-check. Wrappers are deliberately NOT counted here, and
  // the reserve is deliberately EXCLUDED — this checks the floor, not the
  // steady-state budget.
  if (minimumFor) {
    const minTotal = fragments.reduce((sum, f) => sum + measure(minimumFor(f) ?? ''), 0);
    if (minTotal > effectiveBudget) {
      return {
        fragments: [],
        metadata: {
          budget,
          effectiveBudget,
          contentBudget: effectiveBudget,
          underPressure: false,
          omitted: [],
          shrunk: [],
          truncationPct: 0,
          hardFailed: true,
          hardFailReason: 'minimum-set',
        },
      };
    }
  }

  const total = (): number => totalOf(working, measure);

  const baseline = total();
  const underPressure = baseline > effectiveBudget;
  // The reserve is deducted ONLY when under pressure — deducting it
  // unconditionally drops sections `reserve` units early
  // (CONTEXT.md LEARNING.prompt-budget.boundary-gap, PR #3708).
  const contentBudget = underPressure ? effectiveBudget - reserve : effectiveBudget;

  const omitted: string[] = [];
  const shrunk: string[] = [];
  const truncation = { pct: 0 };
  const processedGroups = new Set<string>();

  for (const w of working) {
    switch (w.strategy.kind) {
      case 'verbatim': {
        continue;
      }
      case 'head-shrink': {
        if (total() > contentBudget && isPresent(w)) {
          const next = headShrink(w.content, w.strategy.maxLines);
          if (next !== w.content) {
            w.content = next;
            w.shrunk = true;
            shrunk.push(w.id);
          }
        }
        continue;
      }
      case 'proportional-truncate': {
        const groupKey = w.group ?? w.id;
        if (processedGroups.has(groupKey)) continue;
        processedGroups.add(groupKey);

        if (total() > contentBudget) {
          const members = working.filter(
            (m) => m.strategy.kind === 'proportional-truncate' && (m.group ?? m.id) === groupKey
          );
          const memberContentTotal = members.reduce((sum, m) => sum + measure(m.content), 0);
          const overhead = total() - memberContentTotal;
          const groupBudget = contentBudget - overhead;
          const groupContentTotal = memberContentTotal;

          if (groupBudget > 0 && groupBudget < groupContentTotal) {
            const originalChars = members.reduce((sum, m) => sum + m.originalLength, 0);
            const charsBudget = groupBudget * charsPerUnit;

            for (const m of members) {
              const floorChars = m.strategy.kind === 'proportional-truncate' ? m.strategy.floorChars : 0;
              const share =
                originalChars > 0 ? Math.floor((m.originalLength / originalChars) * charsBudget) : 0;
              const maxChars = Math.max(share, floorChars);
              const next = tailTruncate(m.content, maxChars);
              if (next !== m.content) {
                m.content = next;
                m.truncated = true;
              }
            }

            const newChars = members.reduce((sum, m) => sum + m.content.length, 0);
            if (originalChars > 0) {
              truncation.pct = ((originalChars - newChars) / originalChars) * 100;
            }
          }
        }
        continue;
      }
      case 'drop': {
        if (total() > contentBudget && isPresent(w) && Boolean(w.content)) {
          w.content = '';
          omitted.push(w.id);
        }
        continue;
      }
    }
  }

  const composedFragments: ComposedFragment[] = working.map((w) => ({
    id: w.id,
    content: w.content,
    wrapper: w.wrapper,
    present: isPresent(w),
    shrunk: w.shrunk,
    truncated: w.truncated,
  }));

  return {
    fragments: composedFragments,
    metadata: {
      budget,
      effectiveBudget,
      contentBudget,
      underPressure,
      omitted,
      shrunk,
      truncationPct: truncation.pct,
      hardFailed: false,
      hardFailReason: null,
    },
  };
}
