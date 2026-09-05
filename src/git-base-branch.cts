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
 * the resolver degrades gracefully to the next tier — it never throws. Tier 5
 * is reachable two ways that `resolveBaseBranch()` alone cannot tell apart: a
 * repository that genuinely has no candidate branch (every git query on tiers
 * 2-4 completed and cleanly answered "nothing"), or a total resolution
 * failure (some query timed out / could not run). `resolveBaseBranchDiagnostics()`
 * distinguishes the two via `verified`; `cmdGitBaseBranch` surfaces the
 * unverified case as a stderr diagnostic without changing its stdout contract
 * (#3057 B4).
 *
 * Pure/testable: all I/O is injectable via the `deps` argument so unit
 * tests can run without touching the real filesystem or spawning real git.
 */

import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
import { normalizeLegacyKeys } from './configuration.cjs';
import { sanitizeLabel } from './security.cjs';
import { execGit as execGitSeam } from './shell-command-projection.cjs';

const { error, ERROR_REASON } = io;
const { loadConfig: loadConfigSeam } = configLoader;

// ─── Types ────────────────────────────────────────────────────────────────────

type ExecGitFn = typeof execGitSeam;
type LoadConfigFn = typeof loadConfigSeam;

export interface BaseBranchDeps {
  /** Override the git runner (default: execGit from shell-command-projection) */
  execGit?: ExecGitFn;
  /**
   * Test-only low-level config-file seam for {@link readEffectiveGitConfig}.
   * When supplied without `loadConfig`, reads only `<cwd>/.planning/config.json`,
   * applies legacy-key normalization in memory, and performs no merge, defaults,
   * warning, or write-back. Production callers must use `loadConfig` instead.
   */
  readFile?: (p: string) => string | null;
  /** Override effective configuration loading (default: config-loader.loadConfig) */
  loadConfig?: LoadConfigFn;
  /** Inject the write function used by cmdGitBaseBranch (default: process.stdout.write) */
  write?: (s: string) => void;
  /**
   * Inject the diagnostic-write function used by cmdGitBaseBranch when the
   * last-resort default is reached WITHOUT verification (default:
   * process.stderr.write). Never used for the resolved branch itself — only
   * for the "this is an unverified guess" warning (#3057 B4).
   */
  writeDiagnostic?: (s: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface EffectiveGitConfig {
  baseBranch: string | null;
  protectedBranches: string[];
  /** Rendered form of every entry rejected as unusable, for the caller to report. */
  rejectedProtectedBranches: string[];
  /**
   * `git.allow_default_branch_commits` escape hatch (#3819). When `true`, the
   * resolved base branch is no longer auto-added to `protectedBranches` — for
   * a project that legitimately runs GSD directly on its default branch.
   * Explicitly configured `protected_branches` entries are unaffected: this
   * flag narrows only the automatic base-branch protection, never a name the
   * project named on purpose.
   */
  allowDefaultBranchCommits: boolean;
}

/** Render a rejected config value for a diagnostic without throwing on exotic input. */
function renderRejected(value: unknown): string {
  try {
    return sanitizeLabel(JSON.stringify(value) ?? String(value));
  } catch {
    return sanitizeLabel(String(value));
  }
}

/** Nested-only read of `git.<field>`, mirroring `loadConfigResolved`'s `getNested`. */
export function _readGitNested(config: Record<string, unknown>, field: string): unknown {
  const git = config['git'];
  if (git !== null && typeof git === 'object' && !Array.isArray(git)) {
    return (git as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * Flat-then-nested read, mirroring `loadConfigResolved`'s own `get()`.
 *
 * Used for `base_branch` ONLY, and only because it HAS a legacy flat spelling:
 * `normalizeLegacyKeys` normally hoists it away, so a flat key that SURVIVED
 * normalization is one the migration refused (a non-object `git` section,
 * #3760) and is the user's last remaining expression of intent.
 *
 * `protected_branches` deliberately does NOT use this. It is new in #3552 with
 * no legacy form, so honouring a top-level spelling would invent an
 * undocumented alias that silently outranks the canonical nested key
 * (round-4 external review).
 */
export function _readGitKey(config: Record<string, unknown>, field: string): unknown {
  if (config[field] !== undefined) return config[field];
  return _readGitNested(config, field);
}

/**
 * Read the effective root/workstream configuration once for branch policy.
 *
 * Production takes the `loadConfig` branch, with `persist: false` — this is a
 * PREDICATE, invoked on every `execute-phase` and every `ship` run, and a
 * question must not rewrite the file it is asking about. Without it, any project
 * carrying a legacy flat key (`base_branch`, `branching_strategy`, `depth`, …)
 * has `.planning/config.json` silently normalized and rewritten by a call whose
 * entire contract is to answer a boolean (#3648 review Blocker 1).
 *
 * The `readFile` branch is a unit-test seam, NOT a second production path, and
 * it is deliberately narrower than `loadConfig`. It covers exactly two of
 * production's steps — `normalizeLegacyKeys`, then the flat-then-nested lookup
 * — over a single `<cwd>/.planning/config.json`. It does NOT apply
 * root/workstream `_deepMergeConfig`, builtin or `~/.gsd/defaults.json`
 * defaults, or `mergeFederatedConfig`. Tests that assert on any of those must
 * drive `loadConfig` instead; the seam's own tests are scoped to normalization
 * and shape validation, which is all it reproduces (#3648 review Major 3).
 */
function readEffectiveGitConfig(
  cwd: string,
  deps?: Pick<BaseBranchDeps, 'loadConfig' | 'readFile'>
): EffectiveGitConfig {
  let config: Record<string, unknown> = {};

  if (deps?.readFile && !deps.loadConfig) {
    const raw = deps.readFile(path.join(cwd, '.planning', 'config.json'));
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const { parsed: normalized } = normalizeLegacyKeys(parsed as Record<string, unknown>);
          config = {
            base_branch: _readGitKey(normalized, 'base_branch'),
            protected_branches: _readGitNested(normalized, 'protected_branches'),
            allow_default_branch_commits: _readGitNested(normalized, 'allow_default_branch_commits'),
          };
        }
      } catch { /* malformed direct edit contributes no policy values */ }
    }
  } else {
    try {
      config = (deps?.loadConfig ?? loadConfigSeam)(cwd, { persist: false });
    } catch { /* configuration loading is fail-soft for branch resolution */ }
  }

  const rawBaseBranch = config.base_branch;
  const baseBranch = typeof rawBaseBranch === 'string' && rawBaseBranch.trim()
    ? rawBaseBranch.trim()
    : null;
  // A protection predicate must not fail OPEN. `config-set` validation is
  // bypassable by a direct edit of .planning/config.json, so one bad element
  // discarding the whole list would silently answer "not protected" for names
  // the user believes are protected — the exact failure #3552 exists to close,
  // reintroduced through a different door (#3648 review Blocker 3). Drop only
  // the bad elements, and report every rejection so it cannot pass unnoticed.
  const rawProtectedBranches = config.protected_branches;
  const protectedBranches: string[] = [];
  const rejectedProtectedBranches: string[] = [];
  if (Array.isArray(rawProtectedBranches)) {
    for (const branch of rawProtectedBranches) {
      if (typeof branch === 'string' && branch.trim() !== '') {
        protectedBranches.push(branch.trim());
      } else {
        rejectedProtectedBranches.push(renderRejected(branch));
      }
    }
  } else if (rawProtectedBranches !== undefined && rawProtectedBranches !== null) {
    // Not a list at all — contributes no names, but is still a misconfiguration.
    rejectedProtectedBranches.push(renderRejected(rawProtectedBranches));
  }

  // #3819: nested-only read (mirrors protected_branches — new key, no legacy
  // flat form, so a top-level spelling must not become an undocumented alias).
  const allowDefaultBranchCommits = config.allow_default_branch_commits === true;

  return { baseBranch, protectedBranches, rejectedProtectedBranches, allowDefaultBranchCommits };
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
    // No `!branch ||` guard: m[1] comes from the `(\S+)` capture group above, so it is never empty.
    if (branch === '(unknown)') return null;
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
 * Result of {@link resolveBaseBranchDiagnostics}: the resolved branch plus
 * whether it was actually verified against the repository.
 */
export interface ResolvedBaseBranch {
  branch: string;
  /**
   * True when `branch` came from a tier that ran to completion and produced
   * a real answer: a config override, a resolved git query (tiers 2-4), or
   * the tier-5 default reached because every git query on tiers 2-4
   * completed and cleanly reported no candidate. False when the tier-5
   * default was reached because at least one of those git queries timed out
   * or failed to run (e.g. git missing) — collapsing that case into the same
   * `'main'` as a verified "no candidate" answer is the fail-open branch
   * fixed by #3057 B4: the two are no longer indistinguishable.
   */
  verified: boolean;
}

/**
 * Resolve the default/base branch for the repository at `cwd`, along with
 * whether the tier-5 last-resort default (if reached) was verified.
 *
 * Consults the full precedence ladder and always returns a non-empty string.
 * Never throws.
 */
function resolveBaseBranchDiagnosticsWithConfig(
  cwd: string,
  configured: string | null,
  deps?: BaseBranchDeps,
): ResolvedBaseBranch {
  const rawExecGit: ExecGitFn = deps?.execGit ?? execGitSeam;
  // A genuine execGit failure (timeout, or the call could not even spawn —
  // e.g. git missing, surfaced as exitCode 127 with `error` set) is distinct
  // from git completing and cleanly reporting a negative answer (non-zero
  // exit with no useful output, or exit 0 with empty stdout). Only the former
  // means a tier's answer was never actually obtained. Wrapping execGit here
  // observes every tier's calls uniformly without changing trySymbolicRef /
  // tryRemoteShow / tryLocalBranch's own return contracts.
  let anyGitFailure = false;
  const execGit: ExecGitFn = (args, opts) => {
    const r = rawExecGit(args, opts);
    if (r.timedOut || r.error) anyGitFailure = true;
    return r;
  };

  // 1. Config override
  if (configured) return { branch: configured, verified: true };

  // 2. symbolic-ref (fast, no network)
  const symref = trySymbolicRef(cwd, execGit);
  if (symref) return { branch: symref, verified: true };

  // 3. git remote show origin (authoritative when origin/HEAD unset)
  const remoteShow = tryRemoteShow(cwd, execGit);
  if (remoteShow) return { branch: remoteShow, verified: true };

  // 4. Local branch existence
  const local = tryLocalBranch(cwd, execGit);
  if (local) return { branch: local, verified: true };

  // 5. Last-resort default. `verified:false` when at least one tier-2/3/4
  // execGit call timed out or failed to run — the default was never actually
  // checked against this repository, it is just what's left after git could
  // not answer (#3057 B4).
  return { branch: 'main', verified: !anyGitFailure };
}

export function resolveBaseBranchDiagnostics(
  cwd: string,
  deps?: BaseBranchDeps
): ResolvedBaseBranch {
  const { baseBranch } = readEffectiveGitConfig(cwd, deps);
  return resolveBaseBranchDiagnosticsWithConfig(cwd, baseBranch, deps);
}

/**
 * Resolve the default/base branch for the repository at `cwd`.
 *
 * Consults the full precedence ladder and always returns a non-empty string.
 * Never throws. See {@link resolveBaseBranchDiagnostics} for a caller that
 * needs to distinguish a verified answer from an unverified fallback.
 */
export function resolveBaseBranch(
  cwd: string,
  deps?: BaseBranchDeps
): string {
  return resolveBaseBranchDiagnostics(cwd, deps).branch;
}

export interface ProtectedBranchStatus {
  baseBranch: string;
  protectedBranches: string[];
  /** Rendered `git.protected_branches` entries that were unusable and ignored. */
  rejectedProtectedBranches: string[];
  isProtected: boolean;
  verified: boolean;
  /** Mirrors the `git.allow_default_branch_commits` config value (#3819). */
  allowDefaultBranchCommits: boolean;
}

/** Resolve the base branch plus configured protected-branch extensions. */
export function resolveProtectedBranchStatus(
  cwd: string,
  currentBranch: string,
  deps?: BaseBranchDeps
): ProtectedBranchStatus {
  const effectiveConfig = readEffectiveGitConfig(cwd, deps);
  const { branch: baseBranch, verified } = resolveBaseBranchDiagnosticsWithConfig(
    cwd,
    effectiveConfig.baseBranch,
    deps,
  );
  const protectedBranches = [...new Set([
    ...(effectiveConfig.allowDefaultBranchCommits ? [] : [baseBranch]),
    ...effectiveConfig.protectedBranches,
  ])];
  return {
    baseBranch,
    protectedBranches,
    rejectedProtectedBranches: effectiveConfig.rejectedProtectedBranches,
    isProtected: protectedBranches.includes(currentBranch),
    verified,
    allowDefaultBranchCommits: effectiveConfig.allowDefaultBranchCommits,
  };
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
export function gitWorktreeInfoInternal(
  cwd: string,
  deps?: Pick<BaseBranchDeps, 'execGit'>
): GitWorktreeInfo {
  const execGit: ExecGitFn = deps?.execGit ?? execGitSeam;
  try {
    const insideResult = execGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 });
    if (insideResult.exitCode !== 0) {
      return { inside: false, worktreeRoot: null };
    }
    const insideStdout = String(insideResult.stdout || '').trim();
    if (insideStdout !== 'true') {
      return { inside: false, worktreeRoot: null };
    }
    const rootResult = execGit(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 });
    if (rootResult.exitCode !== 0) {
      return { inside: true, worktreeRoot: null };
    }
    const root = String(rootResult.stdout || '').trim();
    return { inside: true, worktreeRoot: root || null };
  } catch {
    return { inside: false, worktreeRoot: null };
  }
}

// ─── Adapter 3: phase-start anchor + touched-file listing (issue #1953) ───────

/**
 * Resolve the commit that ADDED `<phaseDir>/*-PLAN.md` — the anchor commit
 * marking when the phase began (see `.gsd/phase/feat-1953-complexity-triggered-
 * refactor/42-router-contract.md`, "Touched-file anchor"). `phaseDir` is a
 * project-relative path (backslashes are normalized unconditionally before
 * building the pathspec, never via `path.sep` — matches the repo's
 * cross-platform path-normalization convention).
 *
 * Bounded (`timeout: 15_000`), degrades to `null` on any failure or when no
 * such commit exists (a phase never planned through git, a shallow clone).
 * Never throws.
 */
export function phaseStartCommit(
  cwd: string,
  phaseDir: string,
  execGit?: ExecGitFn
): string | null {
  const git: ExecGitFn = execGit ?? execGitSeam;
  try {
    const normalizedPhaseDir = phaseDir.replace(/\\/g, '/');
    const pathspec = `${normalizedPhaseDir}/*-PLAN.md`;
    const r = git(
      ['log', '--format=%H', '--diff-filter=A', '-1', '--', pathspec],
      { cwd, timeout: 15_000 }
    );
    if (r.exitCode !== 0 || !r.stdout) return null;
    const sha = r.stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Reject characters/sequences that have no legitimate use in a git revision
 * expression reaching this module (a ref name, SHA, or `<ref>~N` / `<ref>^N`
 * / `<ref>@{...}` navigation) but that a hostile `--since` value could use to
 * confuse either the shell-out or a downstream reader: whitespace, ASCII
 * control characters, and the option-shaped `?`, `*`, `[`, `\` characters
 * that `git check-ref-format` also disallows in ref *names*. A leading `-`
 * is rejected outright — that is the actual option-injection vector `--end-
 * of-options` (below) already neutralizes, so this is belt-and-suspenders
 * for older git. `..` is rejected because `sinceRef` is a single revision
 * that this function itself turns into a range (`sinceRef..HEAD`); a
 * `sinceRef` that already contains `..` can only produce a malformed or
 * misleading range. A trailing `.lock` is rejected per `check-ref-format`.
 *
 * Deliberately NOT rejected: `~`, `^`, `:`, `@`, `{`, `}` — `check-ref-
 * format` disallows these in a bare ref *name*, but this value is a git
 * *revision expression*, and rejecting them would break entirely ordinary
 * user input such as `HEAD~1`, `HEAD^`, or `main@{yesterday}`. None of
 * these characters can reintroduce option parsing once `--end-of-options`
 * is in effect, so allowing them costs nothing security-wise.
 */
function isSafeRevisionRef(ref: string): boolean {
  if (ref === '') return false;
  if (ref.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f ?*[\\]/.test(ref)) return false;
  if (ref.includes('..')) return false;
  if (ref.endsWith('.lock')) return false;
  return true;
}

/**
 * List files changed between `sinceRef` and `HEAD`, NUL-delimited and
 * quotepath-safe. Load-bearing details (see the router contract):
 *   - `-z` and `-c core.quotepath=false` avoid git's lossy quote-and-escape
 *     round-trip for non-ASCII paths;
 *   - splitting on `NUL` (never `\n`) tolerates a filename containing a real
 *     newline (git permits it);
 *   - `sinceRef` is validated by `isSafeRevisionRef` AND the revision-range
 *     argument is preceded by `--end-of-options`. A trailing `--` alone does
 *     NOT stop git from option-parsing an argument that appears BEFORE it —
 *     it only stops PATHSPEC interpretation of arguments AFTER it — so
 *     `--since '--output=/tmp/pwn'` would otherwise become the argument
 *     `--output=/tmp/pwn..HEAD`, which git accepts as an option and uses to
 *     redirect diff output to an attacker-chosen path. `--end-of-options`
 *     (git >= 2.24) is the correct fix: everything after it is parsed as a
 *     revision or path, never as an option, regardless of leading `-`.
 *
 * Bounded (`timeout: 15_000`), degrades to `null` when `sinceRef` fails
 * validation or the underlying git call fails (non-zero exit, timeout, or
 * spawn error) — never throws. An empty result set (no files changed
 * between the two revisions) is a valid, non-null answer: `[]`.
 */
export function changedFilesSince(
  cwd: string,
  sinceRef: string,
  execGit?: ExecGitFn
): string[] | null {
  if (!isSafeRevisionRef(sinceRef)) return null;
  const git: ExecGitFn = execGit ?? execGitSeam;
  try {
    const r = git(
      ['-c', 'core.quotepath=false', 'diff', '--name-only', '-z', '--end-of-options', `${sinceRef}..HEAD`, '--'],
      { cwd, timeout: 15_000 }
    );
    if (r.exitCode !== 0) return null;
    if (!r.stdout) return [];
    return r.stdout.split('\0').filter((f) => f.length > 0);
  } catch {
    return null;
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
  args: string[],
  deps?: BaseBranchDeps
): string {
  if (args[0] === '--is-protected') {
    if (args.length > 2) {
      error('Usage: git base-branch --is-protected [<branch>]', ERROR_REASON.USAGE);
    }
    const writeDiagnostic = deps?.writeDiagnostic ?? ((s: string) => process.stderr.write(s));
    // `git branch --show-current` prints nothing on a detached HEAD, so the
    // call sites legitimately pass an explicit empty string: no protected
    // branch is named '', the answer is false, and that is not a fault worth
    // reporting. The flag with NO argument is a different thing — a caller bug
    // that `args[1] ?? ''` used to collapse into the detached-HEAD case. Same
    // handling, but said out loud so the two can be told apart.
    //
    // This diagnostic deliberately does NOT state the answer. The empty branch
    // matches no protected name, but the fail-closed guard below still renders
    // `true` when the base branch could not be verified — so promising "false"
    // here would contradict what this same call prints on stdout (#3648 review).
    if (args.length < 2) {
      writeDiagnostic(
        `⚠ git-base-branch: --is-protected was called without a branch argument; ` +
        `treating it as an empty branch name. Pass the branch to test, ` +
        `e.g. --is-protected "$CURRENT_BRANCH".\n`
      );
    }
    const status = resolveProtectedBranchStatus(cwd, args[1] ?? '', deps);
    if (status.rejectedProtectedBranches.length > 0) {
      writeDiagnostic(
        `⚠ git-base-branch: ignoring ${status.rejectedProtectedBranches.length} unusable ` +
        `git.protected_branches entr${status.rejectedProtectedBranches.length === 1 ? 'y' : 'ies'} ` +
        `(${status.rejectedProtectedBranches.join(', ')}) — each must be a non-empty branch name. ` +
        `The remaining names are still enforced. See #3552.\n`
      );
    }
    // A protection guard must fail closed: if the base branch could not be
    // verified against this repository (a git query timed out or failed to
    // run — #3057 B4), report "protected" rather than silently trusting an
    // unverified guess that might happen to not match the current branch.
    const rendered = String(status.verified ? status.isProtected : true);
    if (!status.verified) {
      writeDiagnostic(
        `⚠ git-base-branch: --is-protected could not verify repository branch metadata; ` +
        `defaulting to protected (fail-closed). See #3057.\n`
      );
    }
    const write = deps?.write ?? ((s: string) => process.stdout.write(s));
    write(rendered + '\n');
    return rendered;
  }
  if (args.length > 0) {
    error(`Unknown flag for git.base-branch: ${args[0]}`, ERROR_REASON.USAGE);
  }

  const { branch, verified } = resolveBaseBranchDiagnostics(cwd, deps);
  if (!verified) {
    const writeDiagnostic = deps?.writeDiagnostic ?? ((s: string) => process.stderr.write(s));
    writeDiagnostic(
      `⚠ git-base-branch: defaulted to 'main' WITHOUT verifying against this repository — ` +
      `a git query timed out or could not run. See #3057.\n`
    );
  }
  const write = deps?.write ?? ((s: string) => process.stdout.write(s));
  write(branch + '\n');
  return branch;
}
