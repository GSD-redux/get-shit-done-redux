/**
 * Worktree Safety Policy Module
 *
 * Owns worktree-root resolution and non-destructive prune policy decisions.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/worktree-safety.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam, posixNormalize } from './shell-command-projection.cjs';

// Default timeout for worktree-related git subprocess calls.
// 10 s is generous enough for normal git operations on large repos while still
// providing a deterministic failure path when git stalls (locked index, hung
// remote, stalled NFS mount, etc.).  Callers can override via deps.timeout.
const DEFAULT_GIT_TIMEOUT_MS = 10000;

const WORKTREE_AGENT_BRANCH_RE = /^(worktree-)?agent-[A-Za-z0-9._/-]+$/;
const WORKTREE_AGENT_BRANCH_PATTERN = WORKTREE_AGENT_BRANCH_RE.source;

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string | null;
  error?: NodeJS.ErrnoException | null;
  timedOut: boolean;
}

type ExecGitFn = (args: string[], opts?: { cwd?: string; timeout?: number }) => GitResult;

/**
 * Execute a git command via the shell-projection seam, with a derived
 * `timedOut` field. Tests inject mocks via deps.execGit using the new
 * (args, opts) shape — see worktree-safety-policy.test.cjs.
 *
 * Return shape: { exitCode, stdout, stderr, timedOut, error, signal }
 *   - timedOut: true when spawnSync reports SIGTERM + ETIMEDOUT
 */
function execGitDefault(args: string[], opts: { cwd?: string; timeout?: number } = {}): GitResult {
  const result = execGitSeam(args, { ...opts, timeout: opts.timeout ?? DEFAULT_GIT_TIMEOUT_MS });
  const timedOut = result.signal === 'SIGTERM' && (result.error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT';
  return { ...result, timedOut };
}

interface WorktreeBranchEntry {
  path: string;
  branch: string;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function parseWorktreePorcelain(porcelain: string): WorktreeBranchEntry[] {
  return parseWorktreeEntries(porcelain).filter((entry) => entry.branch !== null).map((entry) => ({
    path: entry.path,
    branch: entry.branch!,
  }));
}

function parseWorktreeEntries(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = String(porcelain || '').split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const worktreeLine = lines.find((l) => l.startsWith('worktree '));
    if (!worktreeLine) continue;
    const worktreePath = worktreeLine.slice('worktree '.length).trim();
    if (!worktreePath) continue;
    const branchLine = lines.find((l) => l.startsWith('branch refs/heads/'));
    const branch = branchLine ? branchLine.slice('branch refs/heads/'.length).trim() : null;
    entries.push({ path: worktreePath, branch });
  }
  return entries;
}

function parseWorktreeListPaths(porcelain: string): string[] {
  return parseWorktreeEntries(porcelain).map((entry) => entry.path);
}

interface WorktreeListResult {
  ok: boolean;
  reason: string;
  porcelain: string;
  entries: WorktreeEntry[];
}

interface WorktreeDeps {
  execGit?: ExecGitFn;
  existsSync?: (p: string) => boolean;
  statSync?: (p: string) => fs.Stats;
  findSummaryFiles?: (worktreePath: string) => string[];
  readFileSync?: (p: string) => string;
  mkdirSync?: (d: string, o?: { recursive?: boolean }) => void;
  copyFileSync?: (src: string, dest: string) => void;
  isPidAlive?: (pid: number) => boolean;
  readDirSafe?: (dir: string) => string[] | null;
  readFileSafe?: (file: string) => string | null;
  mtimeSafe?: (file: string) => Date | null;
  reapMtimeGuardMs?: number;
  /** Injected current time in ms since epoch for deterministic tests (#1191). */
  nowMs?: number;
  parseWorktreePorcelain?: (porcelain: string) => WorktreeBranchEntry[];
}

function readWorktreeList(repoRoot: string, deps: WorktreeDeps = {}): WorktreeListResult {
  const execGit = deps.execGit || execGitDefault;
  const listResult = execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (listResult.timedOut) {
    // AC2 / AC4: surface timeout as a distinct reason so callers can emit a
    // structured warning rather than silently treating the failure as a generic
    // list error (PRED.k302 — error-swallowing-empty-sentinel).
    return {
      ok: false,
      reason: 'git_timed_out',
      porcelain: '',
      entries: [],
    };
  }
  if (listResult.exitCode !== 0) {
    const stderr = String(listResult.stderr || '');
    return {
      ok: false,
      reason: /not a git repository|not a git repo/i.test(stderr)
        ? 'not_a_git_repo'
        : 'git_list_failed',
      porcelain: '',
      entries: [],
    };
  }

  return {
    ok: true,
    reason: 'ok',
    porcelain: listResult.stdout,
    entries: parseWorktreeEntries(listResult.stdout),
  };
}

interface WorktreeContextResult {
  effectiveRoot: string;
  mode: string;
  reason: string;
}

function resolveWorktreeContext(cwd: string, deps: WorktreeDeps = {}): WorktreeContextResult {
  const execGit = deps.execGit || execGitDefault;
  const existsSync = deps.existsSync || fs.existsSync;

  // Local .planning takes precedence over linked-worktree remapping.
  if (existsSync(path.join(cwd, '.planning'))) {
    return {
      effectiveRoot: cwd,
      mode: 'current_directory',
      reason: 'has_local_planning',
    };
  }

  const gitDir = execGit(['rev-parse', '--git-dir'], { cwd });
  const commonDir = execGit(['rev-parse', '--git-common-dir'], { cwd });
  if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
    return {
      effectiveRoot: cwd,
      mode: 'current_directory',
      reason: 'not_git_repo',
    };
  }

  const gitDirResolved = path.resolve(cwd, gitDir.stdout);
  const commonDirResolved = path.resolve(cwd, commonDir.stdout);
  if (gitDirResolved !== commonDirResolved) {
    return {
      effectiveRoot: path.dirname(commonDirResolved),
      mode: 'linked_worktree_root',
      reason: 'linked_worktree',
    };
  }

  return {
    effectiveRoot: cwd,
    mode: 'current_directory',
    reason: 'main_worktree',
  };
}

interface WorktreePrunePlan {
  repoRoot: string;
  action: string;
  reason: string;
  destructiveModeRequested: boolean;
}

function planWorktreePrune(repoRoot: string, options: { allowDestructive?: boolean } = {}, deps: WorktreeDeps = {}): WorktreePrunePlan {
  const parsePorcelain = deps.parseWorktreePorcelain || parseWorktreePorcelain;
  const destructiveModeRequested = Boolean(options.allowDestructive);
  const listed = readWorktreeList(repoRoot, deps);
  if (!listed.ok) {
    return {
      repoRoot,
      action: 'skip',
      reason: listed.reason,
      destructiveModeRequested,
    };
  }

  let worktrees: WorktreeBranchEntry[] = [];
  try {
    worktrees = parsePorcelain(listed.porcelain);
  } catch {
    // Keep historical behavior: still run metadata prune when parsing fails.
    worktrees = [];
  }

  return {
    repoRoot,
    action: 'metadata_prune_only',
    reason: worktrees.length === 0 ? 'no_worktrees' : 'worktrees_present',
    destructiveModeRequested,
  };
}

interface PruneExecuteResult {
  ok: boolean;
  action: string;
  reason: string;
  timedOut?: boolean;
  pruned: unknown[];
}

function executeWorktreePrunePlan(plan: WorktreePrunePlan | null, deps: WorktreeDeps = {}): PruneExecuteResult {
  const execGit = deps.execGit || execGitDefault;
  if (!plan || plan.action === 'skip') {
    return {
      ok: false,
      action: plan ? plan.action : 'skip',
      reason: plan ? plan.reason : 'missing_plan',
      pruned: [],
    };
  }

  if (plan.action !== 'metadata_prune_only') {
    return {
      ok: false,
      action: plan.action,
      reason: 'unsupported_action',
      pruned: [],
    };
  }

  const result = execGit(['worktree', 'prune'], { cwd: plan.repoRoot });
  if (result.timedOut) {
    // AC4: surface timedOut as a first-class field so callers can log a structured WARNING rather
    // than silently ignoring it (PRED.k302 — error-swallowing-empty-sentinel).
    return {
      ok: false,
      action: plan.action,
      reason: 'git_timed_out',
      timedOut: true,
      pruned: [],
    };
  }
  return {
    ok: result.exitCode === 0,
    action: plan.action,
    reason: plan.reason,
    timedOut: false,
    pruned: [],
  };
}

interface LinkedWorktreePathsResult {
  ok: boolean;
  reason: string;
  paths: string[];
}

function listLinkedWorktreePaths(repoRoot: string, deps: WorktreeDeps = {}): LinkedWorktreePathsResult {
  const listed = readWorktreeList(repoRoot, deps);
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.reason,
      paths: [],
    };
  }

  const allPaths = listed.entries.map((entry) => entry.path);
  // git worktree list always includes the current/main worktree first.
  return {
    ok: true,
    reason: 'ok',
    paths: allPaths.slice(1),
  };
}

interface WorktreeFinding {
  kind: 'orphan' | 'stale';
  path: string;
  ageMinutes?: number;
}

interface HealthResult {
  ok: boolean;
  reason: string;
  findings: WorktreeFinding[];
}

function inspectWorktreeHealth(repoRoot: string, options: { staleAfterMs?: number; nowMs?: number } = {}, deps: WorktreeDeps = {}): HealthResult {
  const inventory = snapshotWorktreeInventory(repoRoot, options, deps);
  if (!inventory.ok) {
    return {
      ok: false,
      reason: inventory.reason,
      findings: [],
    };
  }

  const findings: WorktreeFinding[] = [];
  for (const entry of inventory.entries) {
    if (!entry.exists) {
      findings.push({
        kind: 'orphan',
        path: entry.path,
      });
      continue;
    }
    if (entry.isStale) {
      findings.push({
        kind: 'stale',
        path: entry.path,
        ageMinutes: entry.ageMinutes ?? undefined,
      });
    }
  }

  return {
    ok: true,
    reason: 'ok',
    findings,
  };
}

interface InventoryEntry {
  path: string;
  exists: boolean;
  isStale: boolean;
  ageMinutes: number | null;
}

interface InventoryResult {
  ok: boolean;
  reason: string;
  entries: InventoryEntry[];
}

function snapshotWorktreeInventory(repoRoot: string, options: { staleAfterMs?: number; nowMs?: number } = {}, deps: WorktreeDeps = {}): InventoryResult {
  const existsSync = deps.existsSync || fs.existsSync;
  const statSync = deps.statSync || fs.statSync;
  const staleAfterMs = options.staleAfterMs ?? (60 * 60 * 1000);
  const nowMs = options.nowMs ?? Date.now();
  const listed = listLinkedWorktreePaths(repoRoot, { execGit: deps.execGit || execGitDefault });
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.reason,
      entries: [],
    };
  }

  const entries: InventoryEntry[] = [];
  for (const worktreePath of listed.paths) {
    let exists = false;
    let isStale = false;
    let ageMinutes: number | null = null;

    if (!existsSync(worktreePath)) {
      entries.push({
        path: worktreePath,
        exists,
        isStale,
        ageMinutes,
      });
      continue;
    }

    exists = true;
    try {
      const stat = statSync(worktreePath);
      const ageMs = nowMs - stat.mtimeMs;
      ageMinutes = Math.round(ageMs / 60000);
      if (ageMs > staleAfterMs) {
        isStale = true;
      }
    } catch {
      // Keep historical behavior: stat failures are ignored.
    }
    entries.push({
      path: worktreePath,
      exists,
      isStale,
      ageMinutes,
    });
  }

  return {
    ok: true,
    reason: 'ok',
    entries,
  };
}

interface CleanupManifestEntry {
  agent_id: string | null;
  worktree_path: string;
  branch: string;
  expected_base: string;
  allowed_bases?: string[];
}

function normalizeCleanupManifestEntry(entry: unknown): CleanupManifestEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const worktreePath = typeof e.worktree_path === 'string'
    ? e.worktree_path
    : (typeof e.path === 'string' ? e.path : '');
  const branch = typeof e.branch === 'string' ? e.branch : '';
  const expectedBase = typeof e.expected_base === 'string' ? e.expected_base : '';
  if (!worktreePath || !branch || !expectedBase) return null;
  if (!WORKTREE_AGENT_BRANCH_RE.test(branch)) return null;
  const rawAllowedBases = Array.isArray(e.allowed_bases) ? e.allowed_bases : [];
  const allowedBases = Array.from(new Set(
    [expectedBase, ...rawAllowedBases.filter((base): base is string => typeof base === 'string' && base.length > 0)]
  ));
  return {
    agent_id: typeof e.agent_id === 'string' ? e.agent_id : null,
    worktree_path: worktreePath,
    branch,
    expected_base: expectedBase,
    allowed_bases: allowedBases,
  };
}

interface NormalizedManifestResult {
  ok: boolean;
  reason: string;
  entries: CleanupManifestEntry[];
}

function normalizeCleanupManifest(manifest: unknown): NormalizedManifestResult {
  let parsed: unknown = manifest;
  if (typeof manifest === 'string') {
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return { ok: false, reason: 'invalid_manifest_json', entries: [] };
    }
  }

  const p = parsed as Record<string, unknown> | unknown[] | null;
  const rawEntries = Array.isArray(p)
    ? p
    : (Array.isArray((p as Record<string, unknown>)?.worktrees) ? (p as Record<string, unknown>).worktrees as unknown[] : []);
  const seen = new Set<string>();
  const entries: CleanupManifestEntry[] = [];
  for (const raw of rawEntries) {
    const entry = normalizeCleanupManifestEntry(raw);
    if (!entry) continue;
    const key = `${entry.worktree_path}\0${entry.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  if (entries.length === 0) {
    return { ok: false, reason: 'empty_manifest', entries: [] };
  }

  return { ok: true, reason: 'ok', entries };
}

interface WaveCleanupPlan {
  ok: boolean;
  repoRoot: string;
  action: string;
  discovery: string;
  reason: string;
  entries: CleanupManifestEntry[];
}

function planWorktreeWaveCleanup(repoRoot: string, manifest: unknown): WaveCleanupPlan {
  const normalized = normalizeCleanupManifest(manifest);
  if (!normalized.ok) {
    return {
      ok: false,
      repoRoot,
      action: 'skip',
      discovery: 'manifest',
      reason: normalized.reason,
      entries: [],
    };
  }

  return {
    ok: true,
    repoRoot,
    action: 'cleanup_wave',
    discovery: 'manifest',
    reason: 'manifest_entries_present',
    entries: normalized.entries,
  };
}

function gitResultOk(result: GitResult | null | undefined): boolean {
  return !!(result && result.exitCode === 0 && !result.timedOut);
}

/**
 * Walk <worktreePath>/.planning/ recursively and collect absolute paths of
 * all files whose names match *SUMMARY.md.  Returns [] when the directory
 * does not exist or cannot be read.
 *
 * Mirrors the shell fallback in quick.md (#2296, #2070, #2838):
 *   find "$WT/.planning" -name "*SUMMARY.md"
 */
function defaultFindSummaryFiles(worktreePath: string): string[] {
  const planningDir = path.join(worktreePath, '.planning');
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('SUMMARY.md')) {
        results.push(full);
      }
    }
  }
  walk(planningDir);
  return results;
}

/**
 * Rescue uncommitted SUMMARY.md artifacts from a worktree into the main repo
 * tree before the dirty-state check.  Mirrors the shell-fallback rescue block
 * in quick.md (lines 878–891, #2296/#2070/#2838).
 *
 * For each *SUMMARY.md found under <worktreePath>/.planning/:
 *   - compute relative path from worktree root  → .planning/<id>-SUMMARY.md
 *   - if the file is ALREADY COMMITTED on the worktree branch
 *     (`git cat-file -e HEAD:<relPath>` returns exit 0), skip the copy entirely:
 *     the merge will carry it naturally and copying it as an untracked file would
 *     cause a "untracked working tree files would be overwritten by merge" collision.
 *     On timeout or fatal exit (128) the rescue is also skipped (fail-closed).
 *     (#706 — execute-phase committed-SUMMARY contract)
 *   - destination = <repoRoot>/<relPath>
 *   - copy when dest is absent or content differs
 *
 * Returns `{ rescuedRelPaths, failures }`:
 *   - `rescuedRelPaths`: Set of worktree-relative paths that were successfully rescued
 *     (copy not needed because dest already matches, or copy succeeded).  Only paths
 *     where the rescue genuinely succeeded are included so the dirty-block filter does
 *     not suppress paths that were silently lost.
 *   - `failures`: array of `{ relPath, error }` for any path where mkdirSync or
 *     copyFileSync threw.  A read failure during content comparison is NOT a rescue
 *     failure — it sets needsCopy=true and the copy is attempted normally.
 */
function rescueSummaryArtifacts(
  worktreePath: string,
  repoRoot: string,
  deps: WorktreeDeps,
): { rescuedRelPaths: Set<string>; failures: Array<{ relPath: string; error: string }> } {
  const execGit = deps.execGit || execGitDefault;
  const findSummaryFiles = deps.findSummaryFiles || defaultFindSummaryFiles;
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || ((p: string) => fs.readFileSync(p, 'utf8'));
  const mkdirSync = deps.mkdirSync || ((d: string, o?: { recursive?: boolean }) => fs.mkdirSync(d, o));
  const copyFileSync = deps.copyFileSync || fs.copyFileSync;

  const summaryPaths = findSummaryFiles(worktreePath);
  const rescuedRelPaths = new Set<string>();
  const failures: Array<{ relPath: string; error: string }> = [];

  for (const absPath of summaryPaths) {
    // relPath is the path relative to the worktree root (e.g. ".planning/q1-SUMMARY.md")
    // Normalize to forward slashes so the Set comparison against `git status --porcelain`
    // output works on Windows too (git always emits forward slashes in porcelain output).
    const relPath = posixNormalize(absPath.slice(worktreePath.length).replace(/^[/\\]/, ''));

    // #706: skip rescue when the SUMMARY is already committed on the branch.
    // Use `git cat-file -e HEAD:<relPath>` (not `ls-files --error-unmatch`) so
    // the check is against the committed tree, not the index.  ls-files also
    // matches staged-but-uncommitted files, which would skip rescue when the
    // file is staged but not yet committed — the merge wouldn't carry it, and
    // the executor's content could be lost.  cat-file -e HEAD:<path> returns
    // exit 0 only when the object exists in the committed HEAD tree.
    //
    // #2556: rescue whenever the object is NOT confirmed committed (any non-zero
    // exit). `git cat-file -e` returns 128 — NOT 1 — for an absent path (the
    // normal uncommitted-SUMMARY state), so the previous `!== 1` check never
    // rescued and the untracked file was silently discarded by `worktree remove
    // --force`. Data safety wins: an un-rescued untracked SUMMARY is lost, while
    // a spurious rescue is usually a no-op — the destination check below skips the
    // copy when the main tree already holds identical content (which is also what
    // guards the #706 merge collision). A divergent dest is overwritten, but only
    // uncommitted main-tree content could be lost (committed content is git-recoverable).
    const catFileResult = execGit(['-C', worktreePath, 'cat-file', '-e', `HEAD:${relPath}`], { cwd: repoRoot });
    if (catFileResult.exitCode === 0) {
      // exit 0 → the SUMMARY is committed on HEAD; the merge will carry it, so skip rescue.
      continue;
    }

    const dest = path.join(repoRoot, relPath);
    let needsCopy = !existsSync(dest);
    if (!needsCopy) {
      try {
        const srcContent = readFileSync(absPath);
        const destContent = readFileSync(dest);
        needsCopy = srcContent !== destContent;
      } catch {
        // Read failure during comparison is not a rescue failure — force a copy attempt.
        needsCopy = true;
      }
    }
    if (needsCopy) {
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(absPath, dest);
        // Copy succeeded — the SUMMARY is now safe in the main tree.
        rescuedRelPaths.add(relPath);
      } catch (err) {
        // Write failure: the SUMMARY was NOT rescued.  Record it so the caller can
        // block cleanup instead of silently losing data.
        failures.push({ relPath, error: (err as Error).message });
      }
    } else {
      // dest already exists with identical content — SUMMARY is already safe.
      rescuedRelPaths.add(relPath);
    }
  }

  return { rescuedRelPaths, failures };
}

interface WaveCleanupEntryResult extends CleanupManifestEntry {
  status: string;
  reason: string | null;
  stderr: string;
}

interface WaveCleanupResult {
  ok: boolean;
  action: string;
  reason: string;
  entries: WaveCleanupEntryResult[];
  pending: CleanupManifestEntry[];
}

function executeWorktreeWaveCleanupPlan(plan: WaveCleanupPlan | null, deps: WorktreeDeps = {}): WaveCleanupResult {
  const execGit = deps.execGit || execGitDefault;
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  if (!plan || plan.action !== 'cleanup_wave' || entries.length === 0) {
    return {
      ok: false,
      action: plan ? plan.action : 'skip',
      reason: plan ? (plan.reason || 'missing_entries') : 'missing_plan',
      entries: [],
      pending: entries,
    };
  }

  const results: WaveCleanupEntryResult[] = [];
  const pending: CleanupManifestEntry[] = [];
  let ok = true;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const result: WaveCleanupEntryResult = {
      ...entry,
      status: 'pending',
      reason: null,
      stderr: '',
    };

    const branchCheck = execGit(['-C', entry.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: plan.repoRoot });
    if (!gitResultOk(branchCheck) || branchCheck.stdout.trim() !== entry.branch) {
      result.status = 'blocked';
      result.reason = 'branch_mismatch';
      result.stderr = branchCheck?.stderr || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    const mergeBase = execGit(['merge-base', 'HEAD', entry.branch], { cwd: plan.repoRoot });
    const allowedBases = Array.isArray(entry.allowed_bases) && entry.allowed_bases.length > 0
      ? entry.allowed_bases
      : [entry.expected_base];
    if (!gitResultOk(mergeBase) || !allowedBases.includes(mergeBase.stdout.trim())) {
      result.status = 'blocked';
      result.reason = 'base_mismatch';
      result.stderr = mergeBase?.stderr || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    const deletions = execGit(['diff', '--diff-filter=D', '--name-only', `HEAD...${entry.branch}`], { cwd: plan.repoRoot });
    if (!gitResultOk(deletions)) {
      result.status = 'blocked';
      result.reason = 'deletion_check_failed';
      result.stderr = deletions?.stderr || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }
    if (deletions.stdout) {
      result.status = 'blocked';
      result.reason = 'branch_contains_deletions';
      result.stderr = deletions.stdout;
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    // Safety net: rescue uncommitted SUMMARY.md artifacts before the dirty check.
    // The executor leaves <quick_id>-SUMMARY.md uncommitted by contract — the
    // orchestrator commits it.  Mirrors quick.md shell fallback (#2296, #2070, #2838, #3804).
    const { rescuedRelPaths, failures: rescueFailures } = rescueSummaryArtifacts(entry.worktree_path, plan.repoRoot, deps);
    if (rescueFailures.length > 0) {
      result.status = 'blocked';
      result.reason = 'summary_rescue_failed';
      result.stderr = rescueFailures.map((f) => `${f.relPath}: ${f.error}`).join('; ');
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    const worktreeStatus = execGit(['-C', entry.worktree_path, 'status', '--porcelain', '--untracked-files=all'], { cwd: plan.repoRoot });
    if (!gitResultOk(worktreeStatus)) {
      result.status = 'blocked';
      result.reason = 'worktree_dirty';
      result.stderr = worktreeStatus?.stderr || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }
    // Filter rescued SUMMARY paths out of the porcelain output before deciding dirty.
    // A line like "?? .planning/q1-SUMMARY.md" should not block when the SUMMARY
    // has already been rescued into the main tree.
    const dirtyLines = (worktreeStatus.stdout || '')
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        // porcelain v1 format: "XY path" (3-char prefix + space + path)
        const filePath = line.slice(3).trim();
        return !rescuedRelPaths.has(filePath);
      });
    if (dirtyLines.length > 0) {
      result.status = 'blocked';
      result.reason = 'worktree_dirty';
      result.stderr = dirtyLines.join('\n');
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    const merge = execGit(['merge', entry.branch, '--no-ff', '--no-edit', '-m', `chore: merge executor worktree (${entry.branch})`], { cwd: plan.repoRoot });
    if (!gitResultOk(merge)) {
      result.status = 'blocked';
      result.reason = 'merge_failed';
      result.stderr = merge?.stderr || merge?.stdout || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    let remove = execGit(['worktree', 'remove', entry.worktree_path, '--force'], { cwd: plan.repoRoot });
    if (!gitResultOk(remove)) {
      // Locked worktrees require unlock before remove (or --force --force).
      // Attempt: git worktree unlock <path> (ignore failure — already unlocked is ok)
      // then retry git worktree remove --force.  (#3707)
      execGit(['worktree', 'unlock', entry.worktree_path], { cwd: plan.repoRoot });
      remove = execGit(['worktree', 'remove', entry.worktree_path, '--force'], { cwd: plan.repoRoot });
    }
    if (!gitResultOk(remove)) {
      result.status = 'blocked';
      result.reason = 'worktree_remove_failed';
      result.stderr = remove?.stderr || '';
      results.push(result);
      pending.push(...entries.slice(i + 1));
      ok = false;
      break;
    }

    const branchDelete = execGit(['branch', '-D', entry.branch], { cwd: plan.repoRoot });
    if (!gitResultOk(branchDelete)) {
      result.status = 'warning';
      result.reason = 'branch_delete_failed';
      result.stderr = branchDelete?.stderr || '';
      ok = false;
    } else {
      result.status = 'merged_removed';
      result.reason = 'ok';
    }
    results.push(result);
  }

  return {
    ok,
    action: plan.action,
    reason: ok ? 'ok' : 'cleanup_blocked',
    entries: results,
    pending,
  };
}

function cmdWorktreeCleanupWave(cwd: string, args: string[] = []): void {
  const manifestFlagIndex = args.indexOf('--manifest');
  const manifestPath = manifestFlagIndex >= 0 ? args[manifestFlagIndex + 1] : '';
  if (!manifestPath) {
    process.stderr.write('Usage: worktree cleanup-wave --manifest <path>\n');
    process.exitCode = 2;
    return;
  }

  let manifest: string;
  try {
    manifest = fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8');
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'manifest_read_failed',
      error: (err as Error).message,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const plan = planWorktreeWaveCleanup(cwd, manifest);
  const result = executeWorktreeWaveCleanupPlan(plan);
  const response = {
    ok: result.ok,
    plan: {
      action: plan.action,
      discovery: plan.discovery,
      reason: plan.reason,
      entries: plan.entries.length,
    },
    result,
  };
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

interface RecordAgentFields {
  agentId: string;
  worktreePath: string;
  branch: string;
  base: string;
}

interface RecordAgentPlan {
  ok: boolean;
  reason: string;
  hint?: string;
  entry: CleanupManifestEntry | null;
  /** Serialized manifest to write back (with trailing newline); null when ok === false. */
  manifest: string | null;
}

/**
 * Pure planner for the per-agent wave-manifest append.
 *
 * Validates the candidate entry at write time using the SAME rules the
 * cleanup-wave reader enforces (via `normalizeCleanupManifestEntry`), so an
 * entry that `record-agent` accepts is guaranteed to survive
 * `normalizeCleanupManifest` on read — a field that would be silently dropped
 * at cleanup time fails loudly here instead.
 *
 * `agent_id` is treated write-strict (required) even though the reader is
 * lenient (nullable): the whole point of this verb is to catch an
 * under-populated entry at write time, and an entry whose author cannot be
 * identified defeats that. A duplicate `(worktree_path, branch)` is also
 * rejected loudly — the reader dedups on that key, so a re-record would be
 * silently dropped (the failure mode this verb exists to eliminate). The
 * on-disk shape stays the existing 4-field entry (`agent_id`, `worktree_path`,
 * `branch`, `expected_base`) — no schema change; the reader re-derives
 * `allowed_bases`.
 */
function planWorktreeRecordAgent(manifestRaw: string, fields: RecordAgentFields): RecordAgentPlan {
  // 1. Write-strict required-field check (loud, with which flag is missing).
  //    Trim first so a whitespace-only value ("   ") is rejected here rather
  //    than deferred to a guaranteed `git worktree remove` failure at cleanup.
  const agentId = (fields.agentId || '').trim();
  const worktreePath = (fields.worktreePath || '').trim();
  const branch = (fields.branch || '').trim();
  const base = (fields.base || '').trim();
  const missing: string[] = [];
  if (!agentId) missing.push('--agent-id');
  if (!worktreePath) missing.push('--path');
  if (!branch) missing.push('--branch');
  if (!base) missing.push('--base');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing_field',
      hint: `record-agent requires ${missing.join(', ')}. Re-run with all of --agent-id, --path, --branch, --base set to non-empty (non-whitespace) values.`,
      entry: null,
      manifest: null,
    };
  }

  // 2. Shared validation: run the candidate through the reader's normalizer.
  //    If it returns null the reader would drop this entry on read — reject now.
  const candidate = {
    agent_id: agentId,
    worktree_path: worktreePath,
    branch,
    expected_base: base,
  };
  const entry = normalizeCleanupManifestEntry(candidate);
  if (!entry) {
    return {
      ok: false,
      reason: 'invalid_entry',
      hint: `Entry failed cleanup-manifest validation: --path/--branch/--base must be non-empty and --branch must match ${WORKTREE_AGENT_BRANCH_PATTERN} (accepts both agent-<id> and worktree-agent-<id> namespaces; got branch="${branch}"). Fix the field and re-run.`,
      entry: null,
      manifest: null,
    };
  }

  // 3. Parse the existing manifest. The init shell ({orchestrator_root, worktrees: []})
  //    is written inline by the orchestrator before any agent spawns; a missing or
  //    malformed manifest is a loud failure here, not a silent under-populated write.
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return {
      ok: false,
      reason: 'invalid_manifest_json',
      hint: 'Manifest is not valid JSON. The orchestrator must initialize it as {"orchestrator_root": "...", "worktrees": []} before recording agents.',
      entry: null,
      manifest: null,
    };
  }

  // Accept the canonical {worktrees: []} shell or a bare top-level array (both
  // are read by normalizeCleanupManifest); preserve any other top-level keys.
  let worktrees: unknown[];
  let writeBack: unknown;
  if (Array.isArray(parsed)) {
    worktrees = parsed;
    writeBack = worktrees;
  } else if (parsed && typeof parsed === 'object') {
    const container = parsed as Record<string, unknown>;
    if (container.worktrees === undefined) container.worktrees = [];
    if (!Array.isArray(container.worktrees)) {
      return {
        ok: false,
        reason: 'manifest_shape_invalid',
        hint: 'Manifest "worktrees" must be an array. Re-initialize as {"orchestrator_root": "...", "worktrees": []}.',
        entry: null,
        manifest: null,
      };
    }
    worktrees = container.worktrees;
    writeBack = container;
  } else {
    return {
      ok: false,
      reason: 'manifest_shape_invalid',
      hint: 'Manifest must be a JSON object {"worktrees": []} or a top-level array.',
      entry: null,
      manifest: null,
    };
  }

  // 4. Reject a duplicate (worktree_path, branch). The reader dedups on this
  //    exact key, but only over entries that NORMALIZE successfully — so an
  //    existing malformed same-key entry (which the reader would drop) must NOT
  //    block recording a valid one. Run each existing entry through the reader's
  //    own normalizer and compare only the entries the reader would keep; this
  //    matches its dedup behavior exactly. A real duplicate signals an upstream
  //    double-spawn — surface it loudly instead of silently dropping it.
  const dupKey = `${entry.worktree_path}\0${entry.branch}`;
  const isDuplicate = worktrees.some((existing) => {
    const normalized = normalizeCleanupManifestEntry(existing);
    return normalized !== null && `${normalized.worktree_path}\0${normalized.branch}` === dupKey;
  });
  if (isDuplicate) {
    return {
      ok: false,
      reason: 'duplicate_entry',
      hint: `The manifest already records worktree_path="${entry.worktree_path}" branch="${entry.branch}". The cleanup reader dedups on (worktree_path, branch), so re-recording would be silently dropped — this usually signals an upstream double-spawn. Investigate rather than re-record.`,
      entry: null,
      manifest: null,
    };
  }

  // 5. Append the minimal 4-field entry, matching the existing on-disk format.
  const recorded: CleanupManifestEntry = {
    agent_id: entry.agent_id,
    worktree_path: entry.worktree_path,
    branch: entry.branch,
    expected_base: entry.expected_base,
  };
  worktrees.push(recorded);

  return {
    ok: true,
    reason: 'ok',
    entry: recorded,
    manifest: `${JSON.stringify(writeBack, null, 2)}\n`,
  };
}

interface RecordAgentCmdDeps {
  readFile?: (p: string) => string;
  writeFile?: (p: string, content: string) => void;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

interface RecordAgentCmdResult {
  ok: boolean;
  reason: string;
  hint?: string;
  entry: CleanupManifestEntry | null;
  manifest_path?: string;
}

/**
 * CLI command: append a validated per-agent entry to a wave cleanup manifest.
 *
 * Usage: worktree record-agent --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha>
 *
 * Fails loudly (non-zero exit + recovery hint on stderr) when a field is
 * missing/garbled or the manifest is absent/malformed, rather than appending an
 * under-populated entry that the cleanup reader would silently drop.
 */
function cmdWorktreeRecordAgent(cwd: string, args: string[] = [], deps: RecordAgentCmdDeps = {}): RecordAgentCmdResult {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
  };
  const write = deps.write || ((s: string) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s: string) => process.stderr.write(s));

  const manifestPath = flag('--manifest');
  if (!manifestPath) {
    writeErr('Usage: worktree record-agent --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha>\n');
    process.exitCode = 2;
    return { ok: false, reason: 'usage', entry: null };
  }

  const resolved = path.resolve(cwd, manifestPath);
  const readFile = deps.readFile || ((p: string) => fs.readFileSync(p, 'utf8'));
  let manifestRaw: string;
  try {
    manifestRaw = readFile(resolved);
  } catch (err) {
    const hint = `Manifest not found or unreadable at ${manifestPath}. The orchestrator must initialize it ({"orchestrator_root": "...", "worktrees": []}) before recording agents.`;
    writeErr(`[gsd] worktree.record-agent: manifest_read_failed — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'manifest_read_failed', hint, error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'manifest_read_failed', hint, entry: null };
  }

  const plan = planWorktreeRecordAgent(manifestRaw, {
    agentId: flag('--agent-id'),
    worktreePath: flag('--path'),
    branch: flag('--branch'),
    base: flag('--base'),
  });

  if (!plan.ok || plan.manifest === null) {
    writeErr(`[gsd] worktree.record-agent: ${plan.reason} — ${plan.hint || ''}\n`);
    write(`${JSON.stringify({ ok: false, reason: plan.reason, hint: plan.hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: plan.reason, hint: plan.hint, entry: null };
  }

  const writeFile = deps.writeFile || ((p: string, content: string) => fs.writeFileSync(p, content, 'utf8'));
  writeFile(resolved, plan.manifest);
  write(`${JSON.stringify({ ok: true, reason: 'ok', entry: plan.entry, manifest_path: resolved }, null, 2)}\n`);
  return { ok: true, reason: 'ok', entry: plan.entry, manifest_path: resolved };
}

/**
 * Reap orphaned linked worktrees whose lock owner process is dead, whose
 * branch tip is fully merged into the default branch, and whose lock file
 * mtime is older than REAP_MTIME_GUARD_MS (race guard).
 */
const REAP_MTIME_GUARD_MS = 5 * 60 * 1000; // 5 minutes

interface ReapResult {
  path: string;
  status: 'reaped' | 'skipped';
  reason: string;
}

function reapOrphanWorktrees(repoRoot: string, deps: WorktreeDeps = {}): ReapResult[] {
  const execGit = deps.execGit || execGitDefault;
  const isPidAliveCheck = deps.isPidAlive || defaultIsPidAlive;
  const readDirSafe = deps.readDirSafe || defaultReadDirSafe;
  const readFileSafe = deps.readFileSafe || defaultReadFileSafe;
  const mtimeSafe = deps.mtimeSafe || defaultMtimeSafe;
  const reapMtimeGuardMs = deps.reapMtimeGuardMs !== undefined ? deps.reapMtimeGuardMs : REAP_MTIME_GUARD_MS;
  const nowMs = deps.nowMs ?? Date.now();

  const results: ReapResult[] = [];

  // 1. Discover the .git/worktrees/ admin directory.
  const gitDir = execGit(['rev-parse', '--git-dir'], { cwd: repoRoot });
  if (!gitResultOk(gitDir)) return results;
  const gitDirPath = path.resolve(repoRoot, gitDir.stdout.trim());

  const worktreesAdminDir = path.join(gitDirPath, 'worktrees');
  const entries = readDirSafe(worktreesAdminDir);
  if (!entries) return results;

  // 2. Discover the default branch (main/master/etc) tip.
  const defaultBranchResult = execGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoRoot }
  );

  let mainTip: string | undefined;
  if (gitResultOk(defaultBranchResult)) {
    // Remote default branch is known — use it exclusively.
    const branchName = defaultBranchResult.stdout.trim().replace(/^origin\//, '');
    const r = execGit(['rev-parse', `refs/remotes/origin/${branchName}`], { cwd: repoRoot });
    if (!gitResultOk(r)) return results; // remote ref unresolvable — fail closed
    mainTip = r.stdout.trim();
  } else {
    // No remote configured (local-only repo, e.g. test fixtures).
    const hasRemote = execGit(['remote'], { cwd: repoRoot });
    if (gitResultOk(hasRemote) && hasRemote.stdout.trim()) {
      // Remote exists but origin/HEAD not set — ambiguous; fail closed.
      return results;
    }
    // Build candidate list: init.defaultBranch config, HEAD symref, then main, master.
    const candidateBranches: string[] = [];
    const configResult = execGit(['config', '--get', 'init.defaultBranch'], { cwd: repoRoot });
    if (gitResultOk(configResult) && configResult.stdout.trim()) {
      candidateBranches.push(configResult.stdout.trim());
    }
    const headSymref = execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot });
    if (gitResultOk(headSymref) && headSymref.stdout.trim()) {
      const headBranch = headSymref.stdout.trim();
      if (!candidateBranches.includes(headBranch)) {
        candidateBranches.push(headBranch);
      }
    }
    for (const b of ['main', 'master']) {
      if (!candidateBranches.includes(b)) candidateBranches.push(b);
    }
    for (const candidate of candidateBranches) {
      const r = execGit(['rev-parse', candidate], { cwd: repoRoot });
      if (gitResultOk(r)) {
        mainTip = r.stdout.trim();
        break;
      }
    }
    if (!mainTip) return results;
  }

  // 3. Build a canonical-path → listed-path index from git worktree list.
  const listedResult = execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const canonicalToListed = new Map<string, string>();
  if (gitResultOk(listedResult)) {
    const normalizedListed = listedResult.stdout.replace(/\r\n/g, '\n');
    for (const block of normalizedListed.split('\n\n').filter(Boolean)) {
      const wtLine = block.split('\n').find((l) => l.startsWith('worktree '));
      if (!wtLine) continue;
      const listed = wtLine.slice('worktree '.length).trim();
      try {
        const canonical = fs.realpathSync.native(listed);
        canonicalToListed.set(canonical, listed);
      } catch {
        // If the path doesn't exist (already removed), skip silently.
      }
    }
  }

  // 4. Process each worktree admin entry that has a 'locked' file.
  for (const entryName of entries) {
    const adminDir = path.join(worktreesAdminDir, entryName);
    const lockedFile = path.join(adminDir, 'locked');
    const lockedContent = readFileSafe(lockedFile);
    if (lockedContent === null) continue; // no lock file — not our concern

    // Resolve the actual worktree path from the gitdir pointer.
    const gitdirFile = path.join(adminDir, 'gitdir');
    const gitdirContent = readFileSafe(gitdirFile);
    if (!gitdirContent) continue;
    const resolvedGitFile = path.resolve(adminDir, gitdirContent.trim());
    const worktreePath = path.basename(resolvedGitFile) === '.git'
      ? path.dirname(resolvedGitFile)
      : resolvedGitFile;

    // Look up the git-list path (the path git knows about) for use in
    // git worktree unlock/remove commands.
    let gitKnownPath = worktreePath;
    try {
      const canonical = fs.realpathSync.native(worktreePath);
      gitKnownPath = canonicalToListed.get(canonical) || worktreePath;
    } catch {
      // worktreePath may not exist yet (already removed); use as-is.
    }

    // 4a. Stale-lock guard: skip if lock is too fresh (PID recycling / race).
    const lockMtime = mtimeSafe(lockedFile);
    if (!lockMtime || nowMs - lockMtime.getTime() < reapMtimeGuardMs) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_too_fresh' });
      continue;
    }

    // 4b. PID liveness check.
    const pidStr = lockedContent.trim().match(/^\d+/)?.[0];
    if (!pidStr) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_owner_unknown' });
      continue;
    }
    const pid = parseInt(pidStr, 10);
    let pidIsAlive: boolean;
    try {
      pidIsAlive = Number.isNaN(pid) || isPidAliveCheck(pid);
    } catch {
      pidIsAlive = true; // Cannot determine liveness — treat as alive, do not reap.
    }
    if (pidIsAlive) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'pid_alive' });
      continue;
    }

    // 4c. Ancestry guard: branch-tip must be reachable from main (fail closed).
    let branchTip: string | undefined;
    {
      const headContent = readFileSafe(path.join(adminDir, 'HEAD'));
      if (!headContent) {
        results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
        continue;
      }
      const trimmed = headContent.trim();
      if (trimmed.startsWith('ref: refs/heads/')) {
        // Symbolic ref — resolve to commit SHA via git
        const branchName = trimmed.slice('ref: refs/heads/'.length);
        const resolveResult = execGit(['rev-parse', `refs/heads/${branchName}`], { cwd: repoRoot });
        if (!gitResultOk(resolveResult)) {
          results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
          continue;
        }
        branchTip = resolveResult.stdout.trim();
      } else if (/^[0-9a-f]{40}$/i.test(trimmed)) {
        // Detached HEAD — bare SHA
        branchTip = trimmed;
      } else {
        results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
        continue;
      }
    }

    const ancestorCheck = execGit(
      ['merge-base', '--is-ancestor', branchTip, mainTip],
      { cwd: repoRoot }
    );
    if (!gitResultOk(ancestorCheck)) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'branch_not_merged' });
      continue;
    }

    // 4d. Reap: unlock → remove --force.
    execGit(['worktree', 'unlock', gitKnownPath], { cwd: repoRoot }); // ignore failure (already unlocked)
    const removeResult = execGit(['worktree', 'remove', gitKnownPath, '--force'], { cwd: repoRoot });
    if (!gitResultOk(removeResult)) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'remove_failed' });
      continue;
    }

    results.push({ path: gitKnownPath, status: 'reaped', reason: 'pid_dead_and_merged' });
  }

  // 5. Always prune stale metadata (handles missing-on-disk entries).
  execGit(['worktree', 'prune'], { cwd: repoRoot });

  return results;
}

// ─── reapOrphanWorktrees deps helpers ─────────────────────────────────────────

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function defaultReadDirSafe(dir: string): string[] | null {
  try { return fs.readdirSync(dir); } catch { return null; }
}

function defaultReadFileSafe(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function defaultMtimeSafe(file: string): Date | null {
  try { return fs.statSync(file).mtime; } catch { return null; }
}

function cmdWorktreeReapOrphans(cwd: string): void {
  let result: ReapResult[];
  try {
    result = reapOrphanWorktrees(cwd);
  } catch (err) {
    // Surface failure as a one-line warning; keep exit-zero so workflows don't break.
    process.stderr.write(`[gsd] worktree.reap-orphans failed: ${err && (err as Error).message ? (err as Error).message : String(err)}\n`);
    result = [];
  }
  const skippedCount = result.filter((r) => r.status === 'skipped').length;
  if (skippedCount > 0) {
    // Surface skipped entries so operators are aware of unresolved orphans.
    process.stderr.write(`[gsd] worktree.reap-orphans: ${skippedCount} orphan(s) skipped (run with DEBUG=1 for details)\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, reaped: result.filter((r) => r.status === 'reaped').length, entries: result }, null, 2)}\n`);
}

// Unused exports kept for API compatibility
void parseWorktreeListPaths;

// ─── Moved from core.cjs (ADR-857 T0 #1268 rehome-core-squatters) ─────────────

/**
 * Resolve the main worktree root when running inside a git worktree.
 * In a linked worktree, .planning/ lives in the main worktree, not in the linked one.
 * Returns the main worktree path, or cwd if not in a worktree.
 */
function resolveWorktreeRoot(cwd: string): string {
  const context = resolveWorktreeContext(cwd, {
    existsSync: fs.existsSync,
  });
  return context.effectiveRoot;
}

/**
 * Clear stale worktree metadata references via `git worktree prune`.
 *
 * Destructive linked-worktree removal is disabled by default for safety.
 *
 * @param repoRoot - absolute path to the main (or any) worktree of
 *   the repository; used as `cwd` for git commands.
 * @returns list of worktree paths that were removed (always empty)
 */
function pruneOrphanedWorktrees(repoRoot: string): string[] {
  try {
    const plan = planWorktreePrune(
      repoRoot,
      { allowDestructive: false },
      { parseWorktreePorcelain }
    );
    const pruneResult = executeWorktreePrunePlan(plan) as { timedOut?: boolean } | null;
    if (pruneResult && pruneResult.timedOut) {
      process.stderr.write(
        '[gsd-tools] WARNING: worktree health check degraded' +
        ' — git worktree prune timed out after 10s.' +
        ' Orphaned worktree metadata may remain until the next successful run.\n'
      );
    }
  } catch { /* never crash the caller */ }
  return [];
}

export = {
  resolveWorktreeContext,
  parseWorktreePorcelain,
  planWorktreePrune,
  executeWorktreePrunePlan,
  listLinkedWorktreePaths,
  inspectWorktreeHealth,
  snapshotWorktreeInventory,
  normalizeCleanupManifest,
  planWorktreeWaveCleanup,
  executeWorktreeWaveCleanupPlan,
  cmdWorktreeCleanupWave,
  planWorktreeRecordAgent,
  cmdWorktreeRecordAgent,
  reapOrphanWorktrees,
  cmdWorktreeReapOrphans,
  resolveWorktreeRoot,
  pruneOrphanedWorktrees,
};
