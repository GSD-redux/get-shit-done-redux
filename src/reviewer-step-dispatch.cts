/**
 * Reviewer Step Dispatch (#4209 Phase 1 Plan 2, ADR-2782 seam).
 *
 * ONE interpreter for "a step declares `supportsReviewerLanes: true`" — see
 * `gsd-core/references/loop-hook-dispatch.md` for the canonical explanation of the trait and how
 * `review-lane dispatch-step` re-derives it. This module trusts `trait` exactly as given: it is
 * the CALLER's job to have derived it correctly. Every direct or lifecycle caller routes through
 * `dispatchReviewerLanes` so selection/plan/invoke logic is owned once, not re-derived per
 * feature. This module owns NONE of those primitives — it wires `resolveReviewerSelection`
 * (selection) and `resolveLanePlan` (planning), the same building blocks
 * `gsd-core/bin/gsd-tools.cjs`'s `review-lane plan` subcommand uses. Invocation (`runLane`) needs
 * OS-aware spawn/probe plumbing this module does not own, so `deps.invoke` is the one required,
 * caller-supplied seam (wired for real in `gsd-core/bin/gsd-tools.cjs`'s `review-lane
 * dispatch-step` route).
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
import { resolveLaneBudget, artifactPaths } from './review-lane-invocation.cjs';
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
  INVALID_PROVENANCE: 'invalid_provenance',
  PROMPT_WRITE_FAILED: 'prompt_write_failed',
} as const);
export type DispatchReason = (typeof DISPATCH_REASON)[keyof typeof DISPATCH_REASON];

/** Fixed, non-negotiable prompt constraints (SAFE-03..SAFE-06). Order is the display order. */
export const SOURCE_REVIEW_PROHIBITIONS: readonly string[] = Object.freeze([
  'Do not modify any source file.',
  'Do not run tests.',
  'Do not start background processes.',
  'Do not poll or wait — return findings from a single read-only pass.',
]);

// #4209 RQ-04: a control character (newline, CR, NUL, ...) in ANY string this module embeds
// into the external prompt (`buildSourceReviewPrompt`) lets it inject a fabricated section —
// not just via `paths` (agy-F1's original finding), since `depth`, `baseSha`, and `repoRoot` land
// in that same markdown. Every embedded string is checked against this ONE shared boundary.
const CONTROL_CHAR = /[\x00-\x1f\x7f\u2028\u2029]/;

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
  invoke: (lane: ReviewerLane, plan: LanePlan) => Promise<InvokeOutcome> | InvokeOutcome;
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
  /** True iff at least one lane was actually planned. False means the dispatch was inert. */
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
  // repoRoot itself may be a symlink (e.g. a `/tmp`-based worktree on macOS, where `/tmp` is
  // itself a symlink to `/private/tmp`) — realpath it once so the per-path comparison below
  // compares like with like, not a resolved child path against an unresolved root.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  // #4209 agy-F1: a control character (newline, CR, NUL, ...) in a path lets a maliciously
  // named repo file inject a fabricated section into the markdown prompt built from `paths`
  // below (buildSourceReviewPrompt) — reject it here, at the shared trust boundary, rather than
  // relying on the incidental quoting `git diff --name-only` happens to apply upstream.
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || CONTROL_CHAR.test(p)) {
      return { ok: false, reason: DISPATCH_REASON.INVALID_PATHS };
    }
    const resolved = path.resolve(root, p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, reason: DISPATCH_REASON.PATH_ESCAPES_REPO_ROOT };
    }
    // #4209 WR-05: `path.resolve` is lexical only — a symlink whose OWN path sits inside
    // repoRoot can still point outside it, passing the check above while listing an
    // out-of-repo file for the external lane to read. `fs.realpathSync` follows the link;
    // ENOENT is expected and benign here (a `git diff --name-only` path can legitimately name
    // a file already deleted in a stale worktree) and is not itself an escape.
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return { ok: false, reason: DISPATCH_REASON.PATH_ESCAPES_REPO_ROOT };
    }
  }
  return { ok: true };
}

// `resolveLaneBudget` (review-lane-invocation.cjs) resolves the number; `null` and a resolved
// `0` both mean unbounded (#2797) — the caller's overflow check must test both `!== null` and
// `!== 0`. See the call site below.

/**
 * One-line depth definition for an external reviewer lane, condensed from `<depth_levels>` in
 * `agents/gsd-code-reviewer.md` (#4209 review: a bare `quick`/`standard`/`deep` label means
 * nothing to a third-party CLI that never sees that agent's system prompt — unlike the internal
 * reviewer, whose own persona fully defines these three terms). Every category named here must
 * stay a strict subset of what `<depth_levels>` actually does — `tests/reviewer-step-dispatch
 * .test.cjs`'s "depthMeaning tracks depth_levels" tests assert each case against the real agent
 * file, not just against this function, so the two cannot silently drift again. An unrecognised
 * depth normalizes to `standard`'s text, matching `agents/gsd-code-reviewer.md`'s own "if depth
 * is not one of quick/standard/deep, default to standard" rule — the raw label is not repeated
 * here since `buildSourceReviewPrompt` already states it once, verbatim, earlier in the prompt.
 */
function depthMeaning(depth: string): string {
  switch (depth) {
    case 'quick':
      return 'pattern-scan without reading full file contents: hardcoded secrets, dangerous functions, debug artifacts, empty catch blocks, commented-out code';
    case 'standard':
      return 'read each changed file in context for bugs, security, and quality problems; cross-reference imports and exports';
    case 'deep':
      return 'standard, plus cross-file analysis: trace call chains, check type consistency at API boundaries, verify error propagation, check state mutation consistency, detect circular dependencies';
    default:
      return depthMeaning('standard');
  }
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
    `requested depth (${depthMeaning(input.depth)}). Report every bug, security issue, and`,
    'code-quality problem you find. For every claim you make, cite the exact file path and line',
    'number(s) it applies to — a claim with no file:line citation cannot be independently',
    're-verified and will be discarded by the consolidating reviewer. Performance issues',
    '(O(n²), memory leaks) are out of scope unless also correctness issues (e.g. an infinite',
    'loop) — do not flag them otherwise.',
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
  // #4209 RQ-04: depth/baseSha/repoRoot/runDir land in the SAME markdown prompt `paths` does
  // (buildSourceReviewPrompt, `dispatchReviewerLanes`'s `runDir`-derived promptPath write) — a
  // control character in any of them is the identical injection vector agy-F1 found in `paths`,
  // so this trust boundary must reject it here too, not just for the file list.
  if (typeof input.depth !== 'string' || input.depth.length === 0
    || typeof input.baseSha !== 'string' || input.baseSha.length === 0
    || typeof input.repoRoot !== 'string' || input.repoRoot.length === 0
    || typeof input.runDir !== 'string' || input.runDir.length === 0) {
    return { dispatched: false, ok: false, reason: DISPATCH_REASON.MISSING_PROVENANCE, selection, results: [] };
  }
  // #4209 WR-04: a present-but-malicious field (control character) is a different failure mode
  // than an absent one — MISSING_PROVENANCE above means "the caller never supplied this"; this
  // branch means "the caller supplied something and it's an injection attempt," which a caller
  // handling the two reasons differently (e.g. surfacing one as a config problem, the other as
  // a security event) must be able to tell apart.
  if (CONTROL_CHAR.test(input.depth) || CONTROL_CHAR.test(input.baseSha)
    || CONTROL_CHAR.test(input.repoRoot) || CONTROL_CHAR.test(input.runDir)) {
    return { dispatched: false, ok: false, reason: DISPATCH_REASON.INVALID_PROVENANCE, selection, results: [] };
  }
  // #4209 WR-03 (considered, declined): gating `depth` to code-review's quick/standard/deep
  // enum here would reject the deliberately capability-neutral case this function supports —
  // see "a second, unrelated synthetic step context dispatches through the same function
  // identically" below, which passes a wholly different depth vocabulary on purpose to prove
  // this dispatcher has no code-review-specific special-casing. `depthMeaning()`'s `standard`
  // fallback for an off-enum value is accepted, not a bug, for that reason.

  const { configGet, getLane, plan } = deps;
  const writePromptFile = deps.writePromptFile ?? defaultWritePromptFile;

  const prompt = buildSourceReviewPrompt(input);
  const estimatedTokens = estimateTokens(prompt);
  // Written once, before any lane's plan() runs: `promptPath` is derived from `runDir` alone
  // (see `artifactPaths`), constant across every lane in this dispatch by construction — there
  // is no per-lane variance to defend against, so writing it per-lane (as an earlier version of
  // this function did) was pure redundancy, not a real safeguard.
  // A hoisted, whole-dispatch write (see the doc comment above) that throws must not escape as
  // an uncaught exception — no lane can succeed anyway if the shared prompt file was never
  // written, so this is a dispatch-level halt like `validatePaths`/`MISSING_PROVENANCE` above,
  // not a per-lane failure.
  try {
    writePromptFile(artifactPaths(input.runDir, '').promptPath, prompt);
  } catch {
    return { dispatched: false, ok: false, reason: DISPATCH_REASON.PROMPT_WRITE_FAILED, selection, results: [] };
  }

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

    // A single throwing plan()/invoke() must not take down every sibling lane already collected
    // in `results` — same rationale as gsd-tools.cjs's resolveLanePlan guard
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
    planned = true;

    let invokeOutcome: InvokeOutcome;
    try {
      invokeOutcome = await deps.invoke(lane, planOutcome.plan);
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
