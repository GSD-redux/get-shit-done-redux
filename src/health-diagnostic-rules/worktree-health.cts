/**
 * Health Diagnostic — Worktree health rules (Phase 11, #3309, ADR-3180
 * §8.2/§8.3/§8.5).
 *
 * Group: "Worktree health" (design doc, "Rule table organization" table) —
 * W020 (×3 internal conditions, one subject: "the worktree health scan
 * itself is degraded", design doc "Rejected alternatives" §3), W017 (orphan
 * worktree), W027 (NEW — the split-off "stale worktree" subject, design
 * doc's "New codes for the two split subjects" section).
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:2193-2268`), the exact call sites for W020/W017/W027 (the
 * pre-migration source still names the split-off stale-worktree site
 * 'W017' — this batch is what actually applies the W027 split).
 *
 * W020's original THREE conditions were git_timed_out / git_list_failed / a
 * per-finding 'unverified' kind, each with its own message. The first two
 * are scan-level failures reported by `inspectWorktreeHealth`'s own `reason`
 * field ('git_timed_out' vs 'git_list_failed' vs 'not_a_git_repo') —
 * `planning-snapshot.cts`'s `buildWorktreeHealthField` now carries `reason`
 * straight through on `PlanningSnapshot.worktreeHealth`, so `checkW020`
 * below reproduces the original's exact branch-per-reason messages instead
 * of collapsing them (a prior version of this file collapsed both into one
 * message AND, worse, warned on 'not_a_git_repo' too — a regression, since
 * the original silently skips a non-git cwd; see `verify.cts:2202-2217`).
 *
 * W027 restores the pre-migration active-worktree exclusion
 * (`verify.cts:2233-2242`) via `PlanningSnapshot.cwd` — see `checkW027`'s own
 * comment below for the mechanism.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/worktree-health.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/worktree-health.cjs (gitignored).
 */

import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCmdProjection = require('../shell-command-projection.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// ─── W020 — worktree health scan itself is degraded (verify.cts:2193-2264) ─
//
// ONE rule, THREE internal conditions, all the same subject ("the worktree
// health scan itself is degraded" — design doc "Rejected alternatives" §3):
// (a) `git worktree list` timed out (verify.cts:2202-2209), (b) `git
// worktree list` failed outright (verify.cts:2210-2217), (c) a specific
// 'unverified' finding (existsSync ok, statSync threw,
// verify.cts:2256-2263). A fourth `!ok` reason, 'not_a_git_repo', and a
// thrown exception ('exception') are DELIBERATELY silent — the original's
// `if` ladder never matches 'not_a_git_repo', and the outer try/catch around
// the whole block is commented "git worktree not available or not a git
// repo — skip silently".

function checkW020(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { scope, reason } = snapshot.worktreeHealth;
  const degraded = scope === SCOPE.UNREADABLE;

  // (a) — git worktree list timed out (verify.cts:2202-2209).
  if (degraded && reason === 'git_timed_out') {
    diagnostics.push({
      code: 'W020',
      severity: SEVERITY.WARNING,
      message:
        'Worktree health check degraded: git worktree list timed out after 10s — orphan/stale worktrees could not be inspected',
      remedy: adviseRemedy(
        'Run: git worktree list --porcelain to diagnose; check for .git/index.lock or a hung git process',
      ),
    });
  }

  // (b) — git worktree list failed outright (verify.cts:2210-2217).
  if (degraded && reason === 'git_list_failed') {
    diagnostics.push({
      code: 'W020',
      severity: SEVERITY.WARNING,
      message:
        'Worktree health check degraded: git worktree list failed — orphan/stale worktrees could not be inspected',
      remedy: adviseRemedy(
        'Run: git worktree list --porcelain to diagnose; check git repository state and permissions',
      ),
    });
  }

  // (c) — per-finding 'unverified' (existsSync ok, statSync threw).
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'unverified') continue;
    diagnostics.push({
      code: 'W020',
      severity: SEVERITY.WARNING,
      message: `Worktree health check degraded: could not stat ${finding.path} — presence/staleness could not be verified`,
      remedy: adviseRemedy('Check filesystem permissions on the worktree path, or investigate why statSync failed for it'),
    });
  }

  return diagnostics;
}

// ─── W017 — orphan git worktree (verify.cts:2222-2229) ─────────────────────
//
// `finding.kind === 'orphan'` — path no longer exists on disk. One
// Diagnostic per orphan finding. Remedy mirrors the exact original literal
// fix, `verify.cts:2227`: `'Run: git worktree prune'`.

function checkW017(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'orphan') continue;
    diagnostics.push({
      code: 'W017',
      severity: SEVERITY.WARNING,
      message: `Orphan git worktree: ${finding.path} (path no longer exists on disk)`,
      remedy: adviseRemedy('git worktree prune'),
    });
  }
  return diagnostics;
}

// ─── W027 — stale git worktree (verify.cts:2232-2249, the split-off half of
// the pre-migration 'W017' site) ─────────────────────────────────────────
//
// `finding.kind === 'stale'` — age-based. Excludes the active session's own
// worktree, restored via `snapshot.cwd` (see module doc, gap 2 — RESOLVED):
// a 'stale' finding is skipped when `snapshot.cwd` equals the finding's path
// or is nested under it, the exact comparison `verify.cts:2238-2241` made
// against `process.cwd()`. Per this batch's brief: the interpolated command
// (with the real path) lives in `message`; `remedy.args.command` stays a
// static `<path>` template, mirroring the split the brief specifies.

// ─── #3663 — path-comparison provenance helper ─────────────────────────────
//
// snapshot.cwd is raw process-cwd-derived — path.resolve() normalizes
// separators and relative segments but NOT casing, and a process launched via
// a differently-cased path echoes that spelling back. finding.path is
// `git worktree list`-derived, which self-normalizes to the canonical
// on-disk casing (forward slashes). Comparing those two spellings strictly
// misclassifies the ACTIVE worktree as stale on win32 — so the comparison
// folds case ONLY on win32 (case-insensitive filesystem) and stays
// case-sensitive on POSIX, where differently-cased paths are genuinely
// different directories. Mirrors the normalizeForCompare precedent in
// init.cts (getInitGitState), scoped to casing + separators only — no
// realpath resolution, which would change symlink matching behavior.
function isActiveWorktreePath(
  activeCwd: string,
  worktreePath: string,
  platform: string = process.platform,
): boolean {
  const fold = (p: string): string => {
    const normalized = shellCmdProjection.posixNormalize(path.resolve(p)).replace(/\/+$/g, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const active = fold(activeCwd);
  const worktree = fold(worktreePath);
  return active === worktree || active.startsWith(worktree + '/');
}

function checkW027(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const activeCwd = snapshot.cwd;
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'stale') continue;
    if (isActiveWorktreePath(activeCwd, finding.path)) continue;
    diagnostics.push({
      code: 'W027',
      severity: SEVERITY.WARNING,
      // #3280: staleness is a pure mtime heuristic and carries no information
      // about whether the tree is clean — git's own refusal of a non-forced
      // removal on a dirty tree is the safety net, so the remediation must
      // direct the operator (or an agent executing this literally) to check
      // for uncommitted work FIRST and keep `--force` an explicit discard
      // opt-in, never the default instruction.
      message: `Stale git worktree: ${finding.path} (last modified ${finding.ageMinutes} minutes ago). Inspect uncommitted work first: git -C ${finding.path} status --porcelain; if clean run: git worktree remove ${finding.path}; only add --force to discard changes`,
      remedy: adviseRemedy(
        'git -C <path> status --porcelain; if clean: git worktree remove <path>; add --force only to discard changes',
      ),
    });
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    code: 'W020',
    severity: SEVERITY.WARNING,
    description: 'Worktree health scan degraded — git worktree list timed out, failed, or a finding could not be verified',
    repairable: false,
    check: checkW020,
  },
  {
    code: 'W017',
    severity: SEVERITY.WARNING,
    description: 'Orphan git worktree (path no longer exists on disk)',
    repairable: false,
    check: checkW017,
  },
  {
    code: 'W027',
    severity: SEVERITY.WARNING,
    description: 'Stale git worktree (not modified in a long time)',
    repairable: false,
    check: checkW027,
  },
];

export = { RULES, isActiveWorktreePath };
