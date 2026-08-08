/**
 * Plan Scan Module — detects plan and summary files in a phase directory.
 * Supports both flat (pre-#3139) and nested (post-#3139) layouts.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/plan-scan.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { countMatchedSummaries } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// Excluded derivative files
const PLAN_OUTLINE_RE = /-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /\.pre-bounce\.md$/i;
const PLAN_REVIEW_RE = /-PLAN-REVIEW\.md$/i;

// #2349: a plan's frontmatter always sits at byte 0 and closes well before the
// body, so only a bounded prefix is ever needed to read the `status` marker.
// Capping the read keeps scanPhasePlans — which loops over every phase directory
// on hot paths (state sync/validate, roadmap progress) — from slurping a
// pathologically large committed plan file into memory just to inspect one key.
const PLAN_FRONTMATTER_READ_CAP = 64 * 1024;

/**
 * #2349: a plan whose frontmatter declares `status: superseded` was deliberately
 * reassigned or never executed — its work moved to a later plan, so it can never
 * gain a matching `*-SUMMARY.md`. Like a retired phase (#1514, one level up), such
 * a plan must be excluded from BOTH the plan and summary counts; otherwise a phase
 * with a deliberately-unexecuted plan reads `completed: false` forever, pinning the
 * milestone below 100%. Reading only the frontmatter `status` key is the same seam
 * verify.cts / phase.cts already use for plan metadata; a plan without the marker is
 * counted exactly as before.
 *
 * This is the only path in scanPhasePlans that opens file *contents* (the rest is
 * filename matching), so it is hardened accordingly: `statSync().isFile()` rejects
 * anything that is not a regular file — a directory, socket, or a symlink resolving
 * to a device such as `/dev/zero` (a git-committable DoS vector; cf. #2378/#2383) —
 * BEFORE any open, and the read is bounded to a fixed prefix. Fail-safe throughout:
 * a non-regular or unreadable plan is treated as a normal (counted) plan, never
 * silently dropped.
 */
function isPlanSuperseded(planFullPath: string): boolean {
  let content: string;
  try {
    const st = statSync(planFullPath); // follows symlinks → resolves to the target's real type
    if (!st.isFile()) return false;
    const length = Math.min(st.size, PLAN_FRONTMATTER_READ_CAP);
    if (length === 0) return false;
    const fd = openSync(planFullPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buf, 0, length, 0);
      content = buf.toString('utf8', 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const status = extractFrontmatter(content, planFullPath)['status'];
  return typeof status === 'string' && status.trim().toLowerCase() === 'superseded';
}

function isRootPlanFile(fileName: string): boolean {
  if (PLAN_OUTLINE_RE.test(fileName)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(fileName)) return false;
  if (PLAN_REVIEW_RE.test(fileName)) return false;
  if (fileName.endsWith('-PLAN.md') || fileName === 'PLAN.md') return true;
  // A summary is never a plan. Reject summaries before the loose /PLAN/i
  // fallback so legacy `<N>-PLAN-<NN>-SUMMARY.md` names (which contain the
  // substring "PLAN") are not double-counted as plans. (#500 RC2)
  if (isRootSummaryFile(fileName)) return false;
  return /\.md$/i.test(fileName) && /PLAN/i.test(fileName);
}

function isNestedPlanFile(fileName: string): boolean {
  if (PLAN_OUTLINE_RE.test(fileName)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(fileName)) return false;
  return /^PLAN-\d+.*\.md$/i.test(fileName) || /-PLAN-\d+.*\.md$/i.test(fileName);
}

function isRootSummaryFile(fileName: string): boolean {
  return fileName.endsWith('-SUMMARY.md') || fileName === 'SUMMARY.md';
}

function isNestedSummaryFile(fileName: string): boolean {
  return /^SUMMARY-\d+.*\.md$/i.test(fileName) || /-SUMMARY-\d+.*\.md$/i.test(fileName);
}

/**
 * Strict canonical-naming predicate over a `scanPhasePlans` `planFiles`/
 * `allPlanFiles` ENTRY (root form bare, nested form `plans/`-prefixed, exactly
 * as those arrays store them) — root `<phase>-<NN>-PLAN.md`/bare `PLAN.md`,
 * or nested `plans/PLAN-<NN>....md`/`plans/<x>-PLAN-<NN>....md` — WITHOUT
 * `isRootPlanFile`'s loose `/\.md$/i && /PLAN/i` fallback.
 *
 * The `plans/` prefix check is load-bearing, not cosmetic: `isNestedPlanFile`
 * matches ANY basename containing `-PLAN-<digits>...md` with no anchor
 * requiring an actual `plans/` directory — that shape is exactly the #2893
 * reporter's non-canonical example, `01-PLAN-01-foundation.md`. Applying
 * `isNestedPlanFile` directly to a bare root-level name would therefore
 * misclassify that exact offender as canonical. Only entries scanPhasePlans
 * itself produced with the `plans/` prefix (i.e. read from the real nested
 * subdirectory) are eligible for the nested check.
 *
 * #2893/#3183: `isRootPlanFile`'s loose fallback is deliberately permissive
 * for live-plan COUNTING (a lowercase `plan.md` still counts toward
 * completion — see plan-count-single-owner.test.cjs's pinned case-sensitivity
 * asymmetry). But the #2893 "non-canonical filename" diagnostic (phase.cts's
 * `describeNonCanonicalPlans`, used by find-phase/phase-plan-index/phases
 * list --type plans) exists specifically to CATCH a plan-shaped file that
 * does NOT match the canonical contract and warn instead of silently
 * scheduling it. Feeding that diagnostic (and the `plans`/`files` lists those
 * commands return) the loose `allPlanFiles`/`planFiles` set defeats the
 * diagnostic entirely, since the loose fallback already recognizes the
 * non-canonical file as "matched". This predicate is the STRICT filter those
 * three call sites intersect against so the diagnostic (and what counts as a
 * schedulable plan for those commands specifically) stays canonical-only,
 * while scanPhasePlans's own planCount/summaryCount/completed stay on the
 * loose, permissive rule.
 */
function isCanonicalPlanFile(fileEntry: string): boolean {
  if (fileEntry.startsWith('plans/')) return isNestedPlanFile(fileEntry.slice('plans/'.length));
  return fileEntry.endsWith('-PLAN.md') || fileEntry === 'PLAN.md';
}

interface PhaseScanResult {
  planCount: number;
  summaryCount: number;
  completed: boolean;
  hasNestedPlans: boolean;
  // Callers asking "which plans are OUTSTANDING" (live-completion tracking,
  // pairing, wave scheduling) use planFiles — it is post status:superseded
  // exclusion. Callers asking "what plan files physically exist on disk"
  // (e.g. numbering-gap detection) use allPlanFiles — it is EVERY plan file
  // found, root + nested, BEFORE the superseded exclusion. One owner, two
  // questions.
  planFiles: string[];
  allPlanFiles: string[];
  summaryFiles: string[];
  scope: planningScopeMod.Scope;
}

function scanPhasePlans(phaseDir: string): PhaseScanResult {
  let rootFiles: string[];
  try {
    rootFiles = readdirSync(phaseDir);
  } catch {
    return {
      planCount: 0,
      summaryCount: 0,
      completed: false,
      hasNestedPlans: false,
      planFiles: [],
      allPlanFiles: [],
      summaryFiles: [],
      scope: SCOPE.UNREADABLE,
    };
  }

  const rootPlanFiles = rootFiles.filter(isRootPlanFile);
  const rootSummaryFiles = rootFiles.filter(isRootSummaryFile);
  let nestedPlanFiles: string[] = [];
  let nestedSummaryFiles: string[] = [];
  let hasNestedPlans = false;
  let scope: planningScopeMod.Scope = SCOPE.COMPLETE;

  const nestedDir = join(phaseDir, 'plans');
  if (existsSync(nestedDir)) {
    try {
      const nestedFiles = readdirSync(nestedDir);
      nestedPlanFiles = nestedFiles.filter(isNestedPlanFile).map((file) => `plans/${file}`);
      nestedSummaryFiles = nestedFiles.filter(isNestedSummaryFile).map((file) => `plans/${file}`);
      hasNestedPlans = nestedPlanFiles.length > 0;
    } catch {
      // #3183 (ADR-3180 Decision 2): the nested plans/ dir exists but could not
      // be read — this scan cannot see plans it knows are there, so zero is
      // NOT a reliable answer; mark TRUNCATED rather than COMPLETE.
      scope = SCOPE.TRUNCATED;
    }
  }

  const allPlanFiles = rootPlanFiles.concat(nestedPlanFiles);
  // #2349: drop plans explicitly marked `status: superseded` from the plan set
  // BEFORE counting, so they inflate neither the denominator (planCount) nor,
  // via countMatchedSummaries below, the numerator (summaryCount). Plans without
  // the marker are untouched, so behaviour is byte-for-behaviour identical for
  // every existing phase — only a phase carrying the new marker changes.
  const supersededPlanFiles = allPlanFiles.filter((f) => isPlanSuperseded(join(phaseDir, f)));
  const planFiles = supersededPlanFiles.length === 0
    ? allPlanFiles
    : allPlanFiles.filter((f) => !supersededPlanFiles.includes(f));
  const summaryFiles = rootSummaryFiles.concat(nestedSummaryFiles);
  const planCount = planFiles.length;
  // Count only summaries that are the PLAN→SUMMARY partner of an existing plan
  // (#1988): stray non-plan summaries (e.g. 30-FIX-CR02-SUMMARY.md,
  // 30-GAPCLOSURE-SUMMARY.md) must not inflate summary_count or flip a phase to
  // Complete when plans are still missing summaries. summaryFiles (the array)
  // still holds every summary on disk for callers that read/list them.
  const summaryCount = countMatchedSummaries(planFiles, summaryFiles);

  return {
    planCount,
    summaryCount,
    // #2349: gate completion on whether the phase had ANY plans on disk
    // (allPlanFiles), NOT on the post-exclusion planCount. A phase whose plans
    // were ALL marked superseded has planCount 0, but it is NOT an unplanned
    // empty phase — there is simply no remaining work, so it must read complete
    // (0 >= 0) rather than being pinned below 100% forever, which is the very
    // failure this fix removes. A genuinely empty phase (no plans authored)
    // still has allPlanFiles.length 0 and stays not-completed, exactly as before.
    completed: allPlanFiles.length > 0 && summaryCount >= planCount,
    hasNestedPlans,
    planFiles,
    allPlanFiles,
    summaryFiles,
    scope,
  };
}

// CJS callers do: const scanPhasePlans = require('./plan-scan.cjs')
// and also destructure named exports — support both call styles.
// Using export = with extra properties attached.
export = Object.assign(scanPhasePlans, {
  scanPhasePlans,
  isRootPlanFile,
  isNestedPlanFile,
  isRootSummaryFile,
  isNestedSummaryFile,
  isCanonicalPlanFile,
});
