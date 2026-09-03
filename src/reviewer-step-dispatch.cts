/**
 * Reviewer Step Dispatch (#4209 Phase 1 Plan 2, ADR-2782 seam).
 *
 * ONE interpreter for "a step declares `supportsReviewerLanes: true`" (the trait plan 01-01
 * projects onto `activeHooks` — see `src/loop-resolver.cts`). Every direct or lifecycle caller
 * routes through `dispatchReviewerLanes` so selection/plan/invoke logic is owned once, not
 * re-derived per feature. This module owns NONE of those primitives — it wires
 * `resolveReviewerSelection` (selection) and `resolveLanePlan` (planning), the same building
 * blocks `gsd-core/bin/gsd-tools.cjs`'s `review-lane plan` subcommand uses. Invocation
 * (`runLane`) needs OS-aware spawn/probe plumbing this module does not own, so `deps.invoke`
 * is the one required, caller-supplied seam (wired for real in `gsd-core/bin/gsd-tools.cjs`'s
 * `review-lane dispatch-step` route).
 *
 * Scope note (this task): a step with the trait off, or a selection resolving to zero lanes,
 * dispatches nothing. Each selected lane is planned and invoked exactly once. The bounded
 * source-review prompt built here is METADATA ONLY — repository root, canonical file paths,
 * review depth, base SHA, and four fixed prohibitions. It never embeds file contents. The
 * remaining fail-closed guards (explicit-unavailable still failing the aggregate, unsafe
 * paths, missing provenance, budget overflow) land in the next task.
 */

import fs from 'node:fs';

import type { LanePlan, ResolveResult } from './review-lane-invocation.cjs';
import { resolveLanePlan } from './review-lane-invocation.cjs';
import type { ReviewerLane } from './review-lane-descriptor.cjs';
import { REVIEWER_LANES } from './review-lane-descriptor.cjs';
import type {
  ReviewerSelectionInput,
  ReviewerSelectionResult,
} from './review-reviewer-selection.cjs';
import { resolveReviewerSelection } from './review-reviewer-selection.cjs';

/** Closed set of request-level (not per-lane) halt reasons. Mirrors `LANE_UNAVAILABLE`'s shape. */
export const DISPATCH_REASON = Object.freeze({
  TRAIT_NOT_ENABLED: 'trait_not_enabled',
  NO_LANES_SELECTED: 'no_lanes_selected',
} as const);
export type DispatchReason = (typeof DISPATCH_REASON)[keyof typeof DISPATCH_REASON];

/** Fixed, non-negotiable prompt constraints (SAFE-01..SAFE-07). Order is the display order. */
export const SOURCE_REVIEW_PROHIBITIONS: readonly string[] = Object.freeze([
  'Do not modify any source file.',
  'Do not run tests.',
  'Do not start background processes.',
  'Do not poll or wait — return findings from a single read-only pass.',
]);

export interface ReviewerStepDispatchInput {
  /**
   * Value of the step's `supportsReviewerLanes` field, read verbatim from `activeHooks`.
   * Anything other than the literal boolean `true` (absent, `false`, or a malformed non-boolean
   * that slipped past `capability-validator.cjs`) makes this dispatch a hard no-op.
   */
  trait: unknown;
  /** Passed through verbatim to `resolveReviewerSelection` — this module invents no selection. */
  selection: ReviewerSelectionInput;
  /** Absolute repository root. */
  repoRoot: string;
  /** Canonical, already-resolved file paths under review. Never file contents. */
  paths: readonly string[];
  /** Review depth label, carried into the bounded prompt as provenance. */
  depth: string;
  /** Base SHA the review is anchored to, carried into the bounded prompt as provenance. */
  baseSha: string;
  /** Run-scoped directory; shared prompt file lands at `${runDir}/gsd-review-prompt.md`. */
  runDir: string;
}

export interface PlanContext {
  configGet: (key: string) => unknown;
  runDir: string;
  repoRoot: string;
}

export interface InvokeOutcome {
  ok: boolean;
  reason?: string;
  detail?: string;
  reviewPath?: string;
  errPath?: string;
}

export interface ReviewerStepDispatchDeps {
  /** Defaults to the real `resolveReviewerSelection`. Overridden by tests with a spy. */
  resolveSelection?: (input: ReviewerSelectionInput) => ReviewerSelectionResult;
  /** Defaults to a first-party-only lookup over `REVIEWER_LANES`. */
  getLane?: (slug: string) => ReviewerLane | undefined;
  /** Defaults to a function returning `undefined` for every key (no config overrides). */
  configGet?: (key: string) => unknown;
  /** Defaults to the real, PURE `resolveLanePlan`. Overridden by tests with a spy. */
  plan?: (lane: ReviewerLane, ctx: PlanContext) => ResolveResult;
  /**
   * REQUIRED. `runLane` needs OS-aware spawn/probe plumbing (`RunnerDeps`) this module does not
   * own — the caller (`review-lane dispatch-step`) wires the real one; tests inject a spy.
   */
  invoke: (lane: ReviewerLane, plan: LanePlan, identity: string) => Promise<InvokeOutcome> | InvokeOutcome;
  /** Defaults to `node:fs`'s `writeFileSync`. */
  writePromptFile?: (filePath: string, content: string) => void;
}

export interface ReviewerLaneDispatchResult {
  slug: string;
  ok: boolean;
  reason?: string;
  detail?: string;
  reviewPath?: string;
  errPath?: string;
}

export interface ReviewerStepDispatchResult {
  /** True iff at least one lane was actually planned. False means zero plan/invoke calls. */
  dispatched: boolean;
  /** Aggregate success: `dispatched` lanes all `ok`. */
  ok: boolean;
  reason?: DispatchReason;
  selection?: ReviewerSelectionResult;
  results: ReviewerLaneDispatchResult[];
}

function defaultGetLane(slug: string): ReviewerLane | undefined {
  return REVIEWER_LANES.find((l) => l.slug === slug);
}

function defaultPlan(lane: ReviewerLane, ctx: PlanContext): ResolveResult {
  return resolveLanePlan({
    lane,
    configGet: ctx.configGet,
    runDir: ctx.runDir,
    repoRoot: ctx.repoRoot,
    effortArgs: [],
    effortValue: undefined,
  });
}

function defaultWritePromptFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Build the bounded source-review prompt. Metadata only — repoRoot, paths, depth, base SHA, and
 * the four fixed prohibitions. NEVER embeds file contents.
 */
export function buildSourceReviewPrompt(input: {
  repoRoot: string;
  paths: readonly string[];
  depth: string;
  baseSha: string;
}): string {
  const fileLines = input.paths.map((p) => `- ${p} (base SHA ${input.baseSha})`).join('\n');
  const ruleLines = SOURCE_REVIEW_PROHIBITIONS.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return [
    '## Source Review Request',
    '',
    `Repository root: ${input.repoRoot}`,
    `Review depth: ${input.depth}`,
    `Base SHA: ${input.baseSha}`,
    '',
    '### Files in scope',
    fileLines,
    '',
    '### Rules',
    ruleLines,
  ].join('\n');
}

/**
 * Dispatch every selected reviewer lane for one opted-in step. See module docstring for scope.
 */
export async function dispatchReviewerLanes(
  input: ReviewerStepDispatchInput,
  deps: ReviewerStepDispatchDeps,
): Promise<ReviewerStepDispatchResult> {
  if (input.trait !== true) {
    return { dispatched: false, ok: true, reason: DISPATCH_REASON.TRAIT_NOT_ENABLED, results: [] };
  }

  const resolveSelection = deps.resolveSelection ?? resolveReviewerSelection;
  const selection = resolveSelection(input.selection);

  if (selection.selected.length === 0) {
    return { dispatched: false, ok: true, reason: DISPATCH_REASON.NO_LANES_SELECTED, selection, results: [] };
  }

  const configGet = deps.configGet ?? (() => undefined);
  const getLane = deps.getLane ?? defaultGetLane;
  const plan = deps.plan ?? defaultPlan;
  const writePromptFile = deps.writePromptFile ?? defaultWritePromptFile;

  const prompt = buildSourceReviewPrompt(input);
  let promptWritten = false;

  const results: ReviewerLaneDispatchResult[] = [];
  let anyFailed = false;

  for (const slug of selection.selected) {
    const lane = getLane(slug);
    if (!lane) {
      results.push({ slug, ok: false, reason: 'malformed_lane', detail: 'no such declared lane' });
      anyFailed = true;
      continue;
    }

    const planOutcome = plan(lane, { configGet, runDir: input.runDir, repoRoot: input.repoRoot });
    if (!planOutcome.ok) {
      results.push({ slug, ok: false, reason: planOutcome.reason, detail: planOutcome.detail });
      anyFailed = true;
      continue;
    }

    if (!promptWritten) {
      writePromptFile(planOutcome.plan.promptPath, prompt);
      promptWritten = true;
    }

    const invokeOutcome = await deps.invoke(lane, planOutcome.plan, slug);
    if (!invokeOutcome.ok) anyFailed = true;
    results.push({
      slug,
      ok: invokeOutcome.ok,
      reason: invokeOutcome.reason,
      detail: invokeOutcome.detail,
      reviewPath: invokeOutcome.reviewPath,
      errPath: invokeOutcome.errPath,
    });
  }

  return {
    dispatched: results.length > 0,
    ok: !anyFailed,
    selection,
    results,
  };
}
