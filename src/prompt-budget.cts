/**
 * prompt-budget.cts
 *
 * Pure functions for assembling and trimming review prompts to fit within
 * a token budget (ADR-457 build-at-publish: the hand-written
 * bin/lib/prompt-budget.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Used by the review pipeline to support small-context models.
 *
 * Trim priority (in order — never violate). As of #2929 (epic #1671 Phase 2)
 * the ladder itself is executed by the shared `context-composer` seam
 * (`composeWithinBudget`); this module builds the fragment list in this
 * exact order, delegates the decision of what survives/shrinks/truncates,
 * and keeps only the prompt-specific rendering (`renderNote`,
 * `assemblePrompt`) and the hard-fail response shapes here:
 *   1. Instructions:   ALWAYS kept verbatim
 *   2. Reserve note tokens FIRST when any trim is anticipated
 *   3. Roadmap:        ALWAYS kept verbatim
 *   4. PROJECT.md:     head-shrink to projectMdHeadLines (default 40) if over budget
 *   5. Plans:          tail-truncate proportionally; never drop a whole plan
 *   6. Context:        DROP first if still over
 *   7. Research:       DROP second if still over
 *   8. Requirements:   DROP last (last-resort)
 *   9. Hard-fail:      if minimum-set exceeds effectiveBudget
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- context-composer.cjs is an export= CommonJS module
import contextComposer = require('./context-composer.cjs');

const NOTE_RESERVE_TOKENS = 80;

/**
 * Floor per plan when proportionally truncating and for the minimum-set
 * check. Exported so consumers (notably the load-bearing contract gate,
 * issue #3065) never need to re-declare this value locally.
 */
export const PLAN_FLOOR_CHARS = 1024;
const MIN_PLAN_BYTES = PLAN_FLOOR_CHARS;

const DEFAULT_NOTE_TEMPLATE = [
  '<note>',
  'Prompt automatically trimmed to fit a {budget}-token budget.',
  'Omitted sections: {omittedList}.',
  'Plan content truncated by approximately {planTruncationPct}%.',
  'Treat any missing context as out-of-scope rather than a review concern.',
  '</note>',
].join('\n');

/** A single plan section with its filename and content. */
export interface PlanSection {
  file: string;
  content: string;
}

/** Input sections for applyBudget. */
export interface PromptSections {
  instructions: string;
  roadmap: string;
  plans: PlanSection[];
  projectMd?: string | null;
  context?: string | null;
  research?: string | null;
  requirements?: string | null;
}

/** Options for applyBudget. */
export interface BudgetOptions {
  safetyMarginPct?: number;
  noteTemplate?: string;
  projectMdHeadLines?: number;
}

/** Metadata about the budget application result. */
export interface BudgetMetadata {
  budget: number;
  effectiveBudget: number;
  estimatedTokens: number;
  omitted: string[];
  projectMdShrunk: boolean;
  planTruncationPct: number;
  hardFailed: boolean;
  noteInjected: boolean;
}

/** Result of applyBudget. */
export interface BudgetResult {
  prompt: string;
  metadata: BudgetMetadata;
}

/** Input to applyBudget. */
export interface ApplyBudgetInput {
  sections: PromptSections;
  budget: number;
  options?: BudgetOptions;
}

/**
 * Estimate tokens for a string. Chars / 4, rounded up.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Render the trim-disclosure note.
 */
function renderNote(template: string, budget: number, omitted: string[], planTruncationPct: number): string {
  const omittedList = omitted.length > 0 ? omitted.join(', ') : 'none';
  return template
    .replace('{budget}', String(budget))
    .replace('{omittedList}', omittedList)
    .replace('{planTruncationPct}', String(Math.round(planTruncationPct)));
}

/**
 * Assemble the final prompt string from its sections.
 */
function assemblePrompt(parts: {
  instructions: string;
  note: string | null;
  roadmap: string;
  projectMd: string | null;
  plans: PlanSection[];
  context: string | null;
  research: string | null;
  requirements: string | null;
}): string {
  const {
    instructions,
    note,
    roadmap,
    projectMd,
    plans,
    context,
    research,
    requirements,
  } = parts;

  const blocks: string[] = [];

  blocks.push(instructions);

  if (note) blocks.push(note);

  blocks.push('## Roadmap\n\n' + roadmap);

  if (projectMd) blocks.push('## Project\n\n' + projectMd);

  const planBlocks = plans
    .map((p) => '### ' + p.file + '\n\n' + p.content)
    .join('\n\n');
  blocks.push('## Plans\n\n' + planBlocks);

  if (context) blocks.push('## Context\n\n' + context);
  if (research) blocks.push('## Research\n\n' + research);
  if (requirements) blocks.push('## Requirements\n\n' + requirements);

  return blocks.join('\n\n');
}

/**
 * Build the `composeWithinBudget` fragment array for a set of review prompt
 * sections, with each fragment's declared trim strategy attached.
 *
 * Extracted (issue #3065) so the load-bearing contract gate
 * (tests/load-bearing-contract-gate.test.cjs) can assert directly over the
 * REAL declared strategies used by `applyBudget`, rather than a hand-copied
 * duplicate array. A duplicate would let production silently diverge from
 * the gate (e.g. flipping `roadmap` from `verbatim` to `drop` would keep the
 * gate green if it read from a copy) — exactly the
 * `DEFECT.GENERATIVE-FIX` divergence class this extraction exists to
 * prevent. Pure; performs no I/O and has no side effects.
 */
export function buildBudgetFragments(
  sections: PromptSections,
  projectMdHeadLines: number
): contextComposer.Fragment[] {
  const {
    instructions,
    roadmap,
    plans,
    projectMd: projectMdRaw = null,
    context: contextRaw = null,
    research: researchRaw = null,
    requirements: requirementsRaw = null,
  } = sections;

  // Unique per-plan fragment ids: plain `plan:<file>` unless a filename
  // collision forces disambiguation by index — composeWithinBudget throws on
  // duplicate ids, and legitimate input may repeat a filename across plans.
  const usedPlanIds = new Set<string>();
  const planIds: string[] = plans.map((p, idx) => {
    let id = `plan:${p.file}`;
    if (usedPlanIds.has(id)) id = `plan:${idx}:${p.file}`;
    usedPlanIds.add(id);
    return id;
  });

  const planFragments: contextComposer.Fragment[] = plans.map((p, idx) => ({
    id: planIds[idx],
    content: p.content,
    wrapper: `### ${p.file}\n\n`,
    strategy: { kind: 'proportional-truncate', floorChars: MIN_PLAN_BYTES },
    group: 'plans',
    required: true,
  }));

  return [
    { id: 'instructions', content: instructions, wrapper: '', strategy: { kind: 'verbatim' }, required: true },
    { id: 'roadmap', content: roadmap, wrapper: '## Roadmap\n\n', strategy: { kind: 'verbatim' }, required: true },
    {
      id: 'projectMd',
      content: projectMdRaw ?? '',
      wrapper: '## Project\n\n',
      strategy: { kind: 'head-shrink', maxLines: projectMdHeadLines },
    },
    { id: 'plans-header', content: '', wrapper: '## Plans\n\n', strategy: { kind: 'verbatim' }, required: true },
    ...planFragments,
    { id: 'context', content: contextRaw ?? '', wrapper: '## Context\n\n', strategy: { kind: 'drop' } },
    { id: 'research', content: researchRaw ?? '', wrapper: '## Research\n\n', strategy: { kind: 'drop' } },
    { id: 'requirements', content: requirementsRaw ?? '', wrapper: '## Requirements\n\n', strategy: { kind: 'drop' } },
  ];
}

/**
 * Apply a token budget to a set of review prompt sections.
 * Returns the trimmed prompt and structured metadata.
 */
export function applyBudget({ sections, budget, options = {} }: ApplyBudgetInput): BudgetResult {
  const {
    safetyMarginPct = 10,
    noteTemplate = DEFAULT_NOTE_TEMPLATE,
    projectMdHeadLines = 40,
  } = options;

  const { plans } = sections;

  const fragments: contextComposer.Fragment[] = buildBudgetFragments(sections, projectMdHeadLines);

  // Recover the per-plan fragment ids buildBudgetFragments assigned (in
  // `plans` declaration order) rather than re-deriving the id-collision
  // logic here — a single source of truth for id assignment.
  const planIds: string[] = fragments.filter((f) => f.group === 'plans').map((f) => f.id);

  const composed = contextComposer.composeWithinBudget({
    fragments,
    budget,
    measure: estimateTokens,
    options: {
      safetyMarginPct,
      reserve: NOTE_RESERVE_TOKENS,
      charsPerUnit: 4,
      // Minimum-set floor: instructions + roadmap (in full) + 1KB per plan.
      // NOTE_RESERVE_TOKENS is intentionally excluded — a note is only
      // injected when trimming actually occurs, and a prompt that fits
      // without any trim needs no note at all. Wrappers are also excluded
      // (this checks the floor, not the steady-state budget).
      minimumFor: (f) => {
        if (f.id === 'instructions' || f.id === 'roadmap') return f.content;
        if (f.id.startsWith('plan:')) return f.content.slice(0, MIN_PLAN_BYTES);
        return null;
      },
    },
  });

  const effectiveBudget = composed.metadata.effectiveBudget;

  if (composed.metadata.hardFailed) {
    return {
      prompt: '',
      metadata: {
        budget,
        effectiveBudget,
        estimatedTokens: 0,
        omitted: [],
        projectMdShrunk: false,
        planTruncationPct: 0,
        hardFailed: true,
        noteInjected: false,
      },
    };
  }

  const byId = new Map(composed.fragments.map((f) => [f.id, f]));
  const get = (id: string): contextComposer.ComposedFragment => {
    const found = byId.get(id);
    if (!found) throw new Error(`applyBudget: missing composed fragment "${id}"`);
    return found;
  };

  const instructionsOut = get('instructions').content;
  const roadmapOut = get('roadmap').content;

  const projectMdFragment = get('projectMd');
  const projectMd: string | null = projectMdFragment.present ? projectMdFragment.content : null;

  const contextFragment = get('context');
  const context: string | null = contextFragment.present ? contextFragment.content : null;

  const researchFragment = get('research');
  const research: string | null = researchFragment.present ? researchFragment.content : null;

  const requirementsFragment = get('requirements');
  const requirements: string | null = requirementsFragment.present ? requirementsFragment.content : null;

  // Plans are never dropped — only their content may be truncated — so map
  // deliberately by original index/file rather than relying on `present`.
  const workingPlans: PlanSection[] = plans.map((p, idx) => ({
    file: p.file,
    content: get(planIds[idx]).content,
  }));

  const omitted = composed.metadata.omitted;
  const projectMdShrunk = composed.metadata.shrunk.includes('projectMd');
  const planTruncationPct = composed.metadata.truncationPct;

  // ── Decide whether note is actually needed ────────────────────────────────
  const anyTrimOccurred =
    omitted.length > 0 || projectMdShrunk || planTruncationPct > 0;

  let note: string | null = null;
  let noteInjected = false;
  if (anyTrimOccurred) {
    note = renderNote(noteTemplate, budget, omitted, planTruncationPct);
    noteInjected = true;
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const prompt = assemblePrompt({
    instructions: instructionsOut,
    note,
    roadmap: roadmapOut,
    projectMd,
    plans: workingPlans,
    context,
    research,
    requirements,
  });

  const estimatedTokens = estimateTokens(prompt);

  if (estimatedTokens > effectiveBudget) {
    return {
      prompt: '',
      metadata: {
        budget,
        effectiveBudget,
        estimatedTokens,
        omitted,
        projectMdShrunk,
        planTruncationPct,
        hardFailed: true,
        noteInjected,
      },
    };
  }

  return {
    prompt,
    metadata: {
      budget,
      effectiveBudget,
      estimatedTokens,
      omitted,
      projectMdShrunk,
      planTruncationPct,
      hardFailed: false,
      noteInjected,
    },
  };
}
