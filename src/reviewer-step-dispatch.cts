/**
 * Reviewer Step Dispatch (#4209 Phase 1 Plan 2, ADR-2782 seam).
 *
 * ONE interpreter for "a step declares `supportsReviewerLanes: true`" (the trait plan 01-01
 * projects onto `activeHooks` — see `src/loop-resolver.cts`). This module trusts `trait` exactly
 * as given: it is the CALLER's job to have derived it correctly. `gsd-core/bin/gsd-tools.cjs`'s
 * `review-lane dispatch-step` is the one production caller, and it re-derives `trait` itself —
 * given `--cap-id`/`--point`, it calls `resolveActiveHooksForPoint` (`src/loop-resolver.cts`,
 * the same in-process resolver `loop render-hooks` itself uses) and checks whether that capId's
 * active hook carries `supportsReviewerLanes: true` — rather than trusting a caller-passed
 * boolean, so ANY workflow can reuse this same seam by declaring the trait on its own capability
 * step and passing `--cap-id`/`--point`, with zero bespoke trait-resolution code of its own. Every
 * direct or lifecycle caller routes through `dispatchReviewerLanes` so selection/plan/invoke logic
 * is owned once, not re-derived per feature. This module owns NONE of those primitives — it wires
 * `resolveReviewerSelection` (selection) and `resolveLanePlan` (planning), the same building
 * blocks `gsd-core/bin/gsd-tools.cjs`'s `review-lane plan` subcommand uses. Invocation
 * (`runLane`) needs OS-aware spawn/probe plumbing this module does not own, so `deps.invoke`
 * is the one required, caller-supplied seam (wired for real in `gsd-core/bin/gsd-tools.cjs`'s
 * `review-lane dispatch-step` route).
 *
 * Fail-closed contract:
 * - Trait not exactly `true`, or nothing selected → inert. Zero plan/invoke calls.
 * - Missing/unsafe request-level input (paths escaping `repoRoot`, absent depth/base SHA) stops
 *   the WHOLE dispatch before any lane is planned or invoked.
 * - An explicitly requested lane the selector could not resolve does not silently narrow the
 *   result to only what worked: lanes that DID resolve still run and their results are kept,
 *   but the aggregate `ok` is `false` so no caller mistakes a partial run for a clean one.
 * - Once a lane is planned, a per-lane plan/budget/invoke failure never displaces or cancels a
 *   sibling lane already run.
 *
 * The bounded source-review prompt built here is METADATA ONLY — repository root, canonical
 * file paths, review depth, base SHA, and four fixed prohibitions. It never embeds file
 * contents. If the assembled prompt exceeds a lane's resolved budget, that lane's dispatch
 * hard-fails before `invoke` runs for it — no silent truncation of the file list.
 */

import fs from 'node:fs';
import path from 'node:path';

import { estimateTokens } from './prompt-budget.cjs';
import type { LanePlan, ResolveResult } from './review-lane-invocation.cjs';
import { resolveLaneBudget } from './review-lane-invocation.cjs';
import type { ReviewerLane } from './review-lane-descriptor.cjs';
import type {
  ReviewerSelectionInput,
  ReviewerSelectionResult,
} from './review-reviewer-selection.cjs';
import { resolveReviewerSelection } from './review-reviewer-selection.cjs';

/** Closed set of request-level (not per-lane) halt reasons. Mirrors `LANE_UNAVAILABLE`'s shape. */
export const DISPATCH_REASON = Object.freeze({
  TRAIT_NOT_ENABLED: 'trait_not_enabled',
  NO_LANES_SELECTED: 'no_lanes_selected',
  SELECTION_FAILED: 'selection_failed',
  INVALID_PATHS: 'invalid_paths',
  PATH_ESCAPES_REPO_ROOT: 'path_escapes_repo_root',
  MISSING_PROVENANCE: 'missing_provenance',
} as const);
export type DispatchReason = (typeof DISPATCH_REASON)[keyof typeof DISPATCH_REASON];

/** Fixed, non-negotiable prompt constraints (SAFE-03..SAFE-06). Order is the display order. */
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
  /**
   * REQUIRED (#4209 R4). The one production caller always injects an overlay-merged lookup
   * (`gsd-tools.cjs`'s `laneBySlug`); a first-party-only default would silently diverge from
   * what actually ships, so there is no safe default to fall back to.
   */
  getLane: (slug: string) => ReviewerLane | undefined;
  /**
   * REQUIRED (#4209 R3). A `configGet` that always returns `undefined` silently disables
   * `resolveLaneBudget`'s overflow guard (a missing config key and an explicitly-unbounded
   * config key are indistinguishable to it) — a safety-relevant gate must not fail open on a
   * missing dependency, so this has no default.
   */
  configGet: (key: string) => unknown;
  /**
   * REQUIRED (#4209 R4). The one production caller always injects a per-host effort-aware plan
   * function; a simpler default that skips effort resolution would silently strip that behavior
   * if `plan` were ever omitted, so there is no safe default to fall back to.
   */
  plan: (lane: ReviewerLane, ctx: PlanContext) => ResolveResult;
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

function defaultWritePromptFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Validate that every path is a non-empty string resolving INSIDE `repoRoot` — blocks `..`
 * traversal and absolute paths pointing elsewhere before any lane sees them.
 */
function validatePaths(
  repoRoot: string,
  paths: readonly string[],
): { ok: true } | { ok: false; reason: DispatchReason } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, reason: DISPATCH_REASON.INVALID_PATHS };
  }
  const root = path.resolve(String(repoRoot ?? ''));
  // #4209 agy-F1: a control character (newline, CR, NUL, ...) in a path lets a maliciously
  // named repo file inject a fabricated section into the markdown prompt built from `paths`
  // below (buildSourceReviewPrompt) — reject it here, at the shared trust boundary, rather than
  // relying on the incidental quoting `git diff --name-only` happens to apply upstream.
  const CONTROL_CHAR = /[\x00-\x1f\x7f\u2028\u2029]/;
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || CONTROL_CHAR.test(p)) {
      return { ok: false, reason: DISPATCH_REASON.INVALID_PATHS };
    }
    const resolved = path.resolve(root, p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, reason: DISPATCH_REASON.PATH_ESCAPES_REPO_ROOT };
    }
  }
  return { ok: true };
}

// `resolveLaneBudget` (review-lane-invocation.cjs) resolves the number; `null` and a resolved
// `0` both mean unbounded (#2797) — the caller's overflow check must test both `!== null` and
// `!== 0`. See the call site below.

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
  // Base SHA is identical for every file and already stated once above — repeating it per line
  // (as an earlier version of this prompt did) wastes real tokens at O(files), for zero
  // information gain, on every dispatched lane.
  const fileLines = input.paths.map((p) => `- ${p}`).join('\n');
  const ruleLines = SOURCE_REVIEW_PROHIBITIONS.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return [
    '## Source Review Request',
    '',
    `Repository root: ${input.repoRoot}`,
    `Review depth: ${input.depth}`,
    `Base SHA: ${input.baseSha}`,
    '',
    'Review the changes introduced in each file below relative to the base SHA above, at the',
    'requested depth. Report every bug, security issue, and code-quality problem you find. For every claim',
    'you make, cite the exact file path and line number(s) it applies to — a claim with no',
    'file:line citation cannot be independently re-verified and will be discarded by the',
    'consolidating reviewer.',
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
    // Distinguish "explicitly requested but every candidate was unavailable" (a real failure —
    // `errors` is non-empty) from "nothing was ever requested" (a clean, inert no-op).
    const reason = selection.errors.length > 0
      ? DISPATCH_REASON.SELECTION_FAILED
      : DISPATCH_REASON.NO_LANES_SELECTED;
    return { dispatched: false, ok: selection.errors.length === 0, reason, selection, results: [] };
  }

  const pathCheck = validatePaths(input.repoRoot, input.paths);
  if (!pathCheck.ok) {
    return { dispatched: false, ok: false, reason: pathCheck.reason, selection, results: [] };
  }
  if (typeof input.depth !== 'string' || input.depth.length === 0
    || typeof input.baseSha !== 'string' || input.baseSha.length === 0) {
    return { dispatched: false, ok: false, reason: DISPATCH_REASON.MISSING_PROVENANCE, selection, results: [] };
  }

  const { configGet, getLane, plan } = deps;
  const writePromptFile = deps.writePromptFile ?? defaultWritePromptFile;

  const prompt = buildSourceReviewPrompt(input);
  const estimatedTokens = estimateTokens(prompt);

  const results: ReviewerLaneDispatchResult[] = [];
  // Never narrow the requested set: an explicit reviewer the selector could not resolve is
  // already surfaced in `selection.errors` — reflect that in the aggregate `ok` even though
  // lanes that DID resolve still run below and keep their own results.
  let anyFailed = selection.errors.length > 0;
  // Tracks whether any lane actually reached plan() — `dispatched` must stay false when every
  // selected slug turned out to be unresolvable, even though a `results` entry was still pushed.
  let planned = false;

  for (const slug of selection.selected) {
    const lane = getLane(slug);
    if (!lane) {
      results.push({ slug, ok: false, reason: 'malformed_lane', detail: 'no such declared lane' });
      anyFailed = true;
      continue;
    }

    // A single throwing plan()/writePromptFile()/invoke() must not take down every sibling lane
    // already collected in `results` — same rationale as gsd-tools.cjs's resolveLanePlan guard
    // (#2494/#2605/#1698/#1936/#2073/#2176/#2589/#2794): belt and braces on purpose.
    let planOutcome: ResolveResult;
    try {
      planOutcome = plan(lane, { configGet, runDir: input.runDir, repoRoot: input.repoRoot });
    } catch (e) {
      results.push({ slug, ok: false, reason: 'malformed_lane', detail: e instanceof Error ? e.message : String(e) });
      anyFailed = true;
      continue;
    }
    if (!planOutcome.ok) {
      results.push({ slug, ok: false, reason: planOutcome.reason, detail: planOutcome.detail });
      anyFailed = true;
      continue;
    }
    planned = true;

    const budget = resolveLaneBudget(lane, configGet);
    if (budget !== null && budget !== 0 && estimatedTokens > budget) {
      results.push({
        slug,
        ok: false,
        reason: 'budget_exceeded',
        detail: `estimated ${estimatedTokens} tokens exceeds resolved budget ${budget} for lane '${slug}'`,
      });
      anyFailed = true;
      continue;
    }

    let invokeOutcome: InvokeOutcome;
    try {
      // Idempotent: `prompt` is loop-invariant, so writing it again per lane is harmless and
      // avoids coupling this lane's write to whatever another lane's `plan()` happened to
      // resolve as `promptPath` (#4209 R1 — a `deps.plan` override that ever varies promptPath
      // per lane would otherwise silently invoke a later lane against a file no one wrote).
      writePromptFile(planOutcome.plan.promptPath, prompt);
      invokeOutcome = await deps.invoke(lane, planOutcome.plan, slug);
    } catch (e) {
      results.push({ slug, ok: false, reason: 'invoke_failed', detail: e instanceof Error ? e.message : String(e) });
      anyFailed = true;
      continue;
    }
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
    dispatched: planned,
    ok: !anyFailed,
    selection,
    results,
  };
}
