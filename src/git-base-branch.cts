/**
 * Git Base-Branch Resolver — issue #1146.
 *
 * Single source of truth for detecting the repository's default branch.
 * Replaces the duplicated per-workflow bash detection that only consulted
 * `refs/remotes/origin/HEAD` then hardcoded `:-main`, which silently
 * returned "main" for repos whose default branch is "master" whenever
 * origin/HEAD was unset (git init + remote add / fetch without set-head /
 * most CI checkouts / many worktrees).
 *
 * Precedence ladder (highest to lowest):
 *   1. `git.base_branch` config override from .planning/config.json
 *   2. `git symbolic-ref --short refs/remotes/origin/HEAD`  (fast, no network)
 *   3. `git remote show origin` HEAD branch  ← AUTHORITATIVE; works when #2 unset
 *   4. Local branch existence: "master" present + "main" absent → "master";
 *      "main" present → "main"
 *   5. "main"  (last-resort default)
 *
 * Every git subprocess is bounded with a timeout (≤ 30 s); on timeout/error
 * the resolver degrades gracefully to the next tier — it never throws.
 *
 * Pure/testable: all I/O is injectable via the `deps` argument so unit
 * tests can run without touching the real filesystem or spawning real git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

type ExecGitFn = typeof execGitSeam;

export interface BaseBranchDeps {
  /** Override the git runner (default: execGit from shell-command-projection) */
  execGit?: ExecGitFn;
  /** Override filesystem reads (default: fs.readFileSync / fs.existsSync) */
  readFile?: (p: string) => string | null;
  /** Inject the write function used by cmdGitBaseBranch (default: process.stdout.write) */
  write?: (s: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely look up `git.base_branch` from the project's config.json.
 * Returns the configured value (a non-empty, non-null string) or null.
 */
export function readConfigBaseBranch(
  planningDir: string,
  deps?: Pick<BaseBranchDeps, 'readFile'>
): string | null {
  const readFile: (p: string) => string | null = deps?.readFile ??
    ((p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });

  const configPath = path.join(planningDir, 'config.json');
  const raw = readFile(configPath);
  if (!raw) return null;

  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { return null; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;

  const top = cfg as Record<string, unknown>;
  // Support both "git.base_branch" (nested) and "base_branch" (flat legacy)
  const gitSection = top.git;
  if (gitSection && typeof gitSection === 'object' && !Array.isArray(gitSection)) {
    const nested = (gitSection as Record<string, unknown>).base_branch;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  const flat = top.base_branch;
  if (typeof flat === 'string' && flat.trim()) return flat.trim();

  return null;
}

/**
 * Try `git symbolic-ref --short refs/remotes/origin/HEAD` (no network).
 * Strips the `origin/` prefix to return just the branch name.
 * Returns null if unset or on error/timeout.
 */
export function trySymbolicRef(
  cwd: string,
  execGit: ExecGitFn
): string | null {
  try {
    const r = execGit(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { cwd, timeout: 5_000 }
    );
    if (r.exitCode !== 0 || !r.stdout) return null;
    // Output is e.g. "origin/main" — strip the prefix
    const branch = r.stdout.trim().replace(/^origin\//, '');
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Try `git remote show origin` to read the HEAD branch.
 * This is authoritative when origin/HEAD is unset locally.
 * Requires network access but succeeds in the common CI case where
 * origin/HEAD was never set after `git init && git remote add origin`.
 *
 * Parses the line:  `HEAD branch: <name>`
 * Returns null on error, timeout, or if the output is malformed.
 */
export function tryRemoteShow(
  cwd: string,
  execGit: ExecGitFn
): string | null {
  try {
    const r = execGit(
      ['remote', 'show', 'origin'],
      { cwd, timeout: 15_000 }
    );
    if (r.exitCode !== 0 || !r.stdout) return null;
    // The line looks like: "  HEAD branch: master"
    const m = r.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (!m) return null;
    const branch = m[1];
    // git emits "(unknown)" when the remote is offline but the local cache
    // resolved it; treat that as non-authoritative and fall through.
    if (!branch || branch === '(unknown)') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Detect local branch existence as a tie-breaker when no remote info is available.
 *
 * Rules:
 *   - "master" present AND "main" absent → "master"
 *   - "main" present → "main"
 *   - Neither → null (fall through to default)
 *
 * Returns null on error/timeout.
 */
export function tryLocalBranch(
  cwd: string,
  execGit: ExecGitFn
): string | null {
  try {
    const r = execGit(
      ['branch', '--list', 'main', 'master'],
      { cwd, timeout: 5_000 }
    );
    if (r.exitCode !== 0 || !r.stdout) return null;
    // `git branch --list main master` outputs one line per matching branch
    const lines = r.stdout.split('\n').map(l => l.trim().replace(/^\*\s*/, ''));
    const hasMain   = lines.includes('main');
    const hasMaster = lines.includes('master');
    if (hasMaster && !hasMain) return 'master';
    if (hasMain)               return 'main';
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the default/base branch for the repository at `cwd`.
 *
 * Consults the full precedence ladder and always returns a non-empty string.
 * Never throws.
 */
export function resolveBaseBranch(
  cwd: string,
  deps?: BaseBranchDeps
): string {
  const execGit: ExecGitFn = deps?.execGit ?? execGitSeam;

  // Derive .planning dir relative to cwd (mirrors planningDir() in planning-workspace.cjs)
  const planningDir = path.join(cwd, '.planning');

  // 1. Config override
  const configured = readConfigBaseBranch(planningDir, deps);
  if (configured) return configured;

  // 2. symbolic-ref (fast, no network)
  const symref = trySymbolicRef(cwd, execGit);
  if (symref) return symref;

  // 3. git remote show origin (authoritative when origin/HEAD unset)
  const remoteShow = tryRemoteShow(cwd, execGit);
  if (remoteShow) return remoteShow;

  // 4. Local branch existence
  const local = tryLocalBranch(cwd, execGit);
  if (local) return local;

  // 5. Last-resort default
  return 'main';
}

// ─── gitWorktreeInfoInternal (moved from core.cjs, ADR-857 T0 #1268) ─────────

export interface GitWorktreeInfo {
  inside: boolean;
  worktreeRoot: string | null;
}

/**
 * Detect whether `cwd` sits inside a git worktree, and if so, return the
 * absolute path of the worktree root.
 */
export function gitWorktreeInfoInternal(cwd: string): GitWorktreeInfo {
  try {
    const insideResult = execGitSeam(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 });
    if (insideResult.exitCode !== 0) {
      return { inside: false, worktreeRoot: null };
    }
    const insideStdout = String(insideResult.stdout || '').trim();
    if (insideStdout !== 'true') {
      return { inside: false, worktreeRoot: null };
    }
    const rootResult = execGitSeam(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 });
    if (rootResult.exitCode !== 0) {
      return { inside: true, worktreeRoot: null };
    }
    const root = String(rootResult.stdout || '').trim();
    return { inside: true, worktreeRoot: root || null };
  } catch {
    return { inside: false, worktreeRoot: null };
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI command: `gsd-tools git base-branch`
 * Resolves the default branch and writes it to stdout (raw string, newline-terminated).
 * Called by workflows via `gsd_run query git.base-branch`.
 */
export function cmdGitBaseBranch(
  cwd: string,
  _args: string[],
  deps?: BaseBranchDeps
): string {
  const branch = resolveBaseBranch(cwd, deps);
  const write = deps?.write ?? ((s: string) => process.stdout.write(s));
  write(branch + '\n');
  return branch;
}
