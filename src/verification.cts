/**
 * Verification Status — single queryable home for verification-status routing.
 *
 * Issue #651: consolidate the pass/gaps_found/human_needed routing that was
 * previously scattered across ship.md and execute-phase.md into a single
 * tested module. Both workflow files will later consume this module's routing
 * table as the single source of truth.
 *
 * ADR-457 build-at-publish: source in src/verification.cts, compiled to
 * gsd-core/bin/lib/verification.cjs (gitignored).
 *
 * DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix: status extraction is scoped to
 * the leading YAML frontmatter block only. A `status:` line in the body (e.g.
 * inside a fenced code block) is ignored — this is the exact failure mode that
 * issue #586 / PR #650 identified. The shared extractFrontmatter parser anchors
 * its regex at byte 0 of the document, which provides this guarantee.
 *
 * #2348 staleness signal: whether a *-VERIFICATION.md is stale (a summary newer
 * than it) is decided from git commit time when a file is committed AND clean,
 * and from filesystem mtime otherwise. mtimes are assigned at checkout time and
 * are not preserved by `git clone` / `cp -R`, and any unrelated `touch` /
 * reformat / editor-save re-stales a valid report — so a committed phase could
 * read `passed` on one machine and `stale` on a fresh clone purely from checkout
 * order. Git commit time is content-tied and clone-stable; mtime is retained
 * only for uncommitted or working-tree-dirty files, where it is the true
 * last-changed signal. Both are real wall-clock change times, so the comparison
 * is sound even when one file uses each.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseId = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import scanPhasePlans = require('./plan-scan.cjs');
import { execGit } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';

const { output, error } = io;
const { extractPhaseToken } = phaseId;
const { extractFrontmatter } = frontmatterMod;

// ─── Constants ────────────────────────────────────────────────────────────────

/** The set of status values that the gsd-verifier agent emits. */
const VERIFIER_STATUSES: ReadonlyArray<string> = ['passed', 'gaps_found', 'human_needed'];

// ─── Routing table ────────────────────────────────────────────────────────────

interface VerificationRoute {
  status: string;
  next_action: string;
  next_command: string;
}

/**
 * Canonical routing table for verification statuses.
 *
 * This is the single source of truth — ship.md and execute-phase.md will
 * later import from here instead of embedding their own message strings.
 *
 * INTERNAL SENTINELS: 'missing' and 'unknown' are operational states constructed
 * internally — the verifier (gsd-verifier.md) never emits them. The verifier only
 * emits values in VERIFIER_STATUSES (passed|gaps_found|human_needed). The guard in
 * readVerificationStatus excludes 'missing' and 'unknown' from raw-status table
 * lookup so they can only be reached via internal construction paths.
 *
 * For 'gaps_found', next_command is built at call time in readVerificationStatus
 * by substituting the phase number — it is NOT stored as a function in the table.
 *
 * #2617: `next_command` here holds a BARE command name (`execute-phase`), never a
 * prefixed one. Every return path projects it through `formatGsdSlash` with the
 * caller's runtime, so Codex sees `$gsd-execute-phase` and slash-hyphen runtimes
 * see `/gsd-execute-phase`. Storing a prefixed literal is what leaked the
 * hard-coded (and deprecated) `/gsd:` colon form to every runtime.
 */
const VERIFICATION_ROUTING_TABLE: Record<string, VerificationRoute> = {
  passed: {
    status: 'passed',
    next_action: 'Verification passed — continue.',
    next_command: '',
  },
  gaps_found: {
    status: 'gaps_found',
    next_action: 'Gaps found. Plan the fixes, then re-run execute-phase before shipping.',
    // next_command is computed at call time; this entry is never returned directly.
    next_command: '',
  },
  human_needed: {
    status: 'human_needed',
    next_action: "Human verification required. Complete the manual tests in the phase's *-UAT.md, then re-run the verify step until status is passed.",
    // #2617: was '' — next_action told the user to "re-run the verify step" but
    // named no command, while init.cts's parallel projector emitted
    // `verify-work <N>` for this same state. The two surfaces disagreed on
    // whether a next command existed at all; init's answer was the useful one,
    // and init now delegates here rather than re-deriving it.
    next_command: 'verify-work',
  },
  stale: {
    status: 'stale',
    next_action: 'Verification is stale. Re-run verify-work before transition.',
    next_command: '',
  },
  // INTERNAL SENTINEL: constructed when no *-VERIFICATION.md file exists or when
  // the file has no parseable frontmatter status. Never emitted by the verifier.
  missing: {
    status: 'missing',
    next_action: 'No verification report found — the verify step never completed. Re-run execute-phase.',
    next_command: 'execute-phase',
  },
  // INTERNAL SENTINEL: constructed when the file has a status value not in
  // VERIFIER_STATUSES. Never emitted by the verifier.
  unknown: {
    status: 'unknown',
    next_action: '', // filled in dynamically with the raw value
    next_command: 'execute-phase',
  },
};

/**
 * Project a BARE command name (plus optional argument tail) into the surface the
 * given runtime actually installs (#2617).
 *
 * `formatGsdSlash` owns the per-runtime shape (`$gsd-<cmd>` for shell-var
 * runtimes like Codex, `/gsd-<cmd>` otherwise) and is idempotent, so passing an
 * already-prefixed string is safe. An empty command stays empty — "no next
 * command" must not become a bare prefix.
 */
function projectNextCommand(bare: string, runtime: string, tail = ''): string {
  if (!bare) return '';
  return `${formatGsdSlash(bare, runtime) as string}${tail}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FsLike {
  readdirSync(dir: string): string[];
  readFileSync(filePath: string, encoding: 'utf-8'): string;
  statSync(filePath: string): { mtimeMs: number };
}

interface StaleVerificationInfo {
  verificationFile: string;
  summaryFile: string;
}

/**
 * Resolve the git commit time (epoch-ms) for each of `files` (paths relative to
 * `phaseDir`) that is BOTH committed AND clean (its working-tree content matches
 * HEAD), keyed by the given relative path. A file that is dirty, untracked,
 * uncommitted, or in a non-repo is simply absent — callers then time it by its
 * filesystem mtime. Injectable so tests exercise the clock without git. (#2348)
 */
type PhaseCleanCommitTimesFn = (phaseDir: string, files: string[]) => Map<string, number>;

/** Normalize separators to posix (git emits `/`; callers may pass `\` on Windows). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Match a git-emitted (repo-root-relative) path back to the caller's
 * phaseDir-relative request by exact match or `/`-bounded suffix — precise
 * enough that a root file and a nested `plans/` file can never collide (a plain
 * basename match could). Returns the original caller-form file string, or null.
 */
function matchRequestedFile(gitPath: string, requested: string[], requestedPosix: string[]): string | null {
  const g = toPosix(gitPath);
  for (let i = 0; i < requested.length; i++) {
    const want = requestedPosix[i];
    if (g === want || g.endsWith('/' + want)) return requested[i];
  }
  return null;
}

/**
 * Parse `git log --format=%ct --name-only` output into file → most-recent commit
 * time (ms). Output is reverse-chronological, so a file's FIRST appearance
 * top-down is its latest commit. `%ct` headers are pure digits; path lines
 * contain a `.` (the `.md` extension) — so the two are unambiguous.
 */
function parseCommitTimes(
  stdout: string,
  requested: string[],
  requestedPosix: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  let currentCt: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (/^\d+$/.test(line)) {
      currentCt = Number.parseInt(line, 10);
      continue;
    }
    if (currentCt === null) continue;
    const rel = matchRequestedFile(line, requested, requestedPosix);
    if (rel !== null && !out.has(rel)) out.set(rel, currentCt * 1000);
  }
  return out;
}

/**
 * Default resolver: two bounded git calls per phase (never one-per-file — #2348 /
 * "Unbounded Subprocesses"; readVerificationStatus runs per-phase in the
 * init/roadmap listing loops, so per-file spawning would fan out to P×(S+1)):
 *
 *   1. `git log --first-parent --format=%ct --name-only -- <files…>` for commit
 *      times. `--first-parent` makes merge commits report their (first-parent)
 *      file lists — plain `--name-only` omits merge diffs, which would silently
 *      under-date content that landed via a conflict-resolving merge.
 *   2. `git diff --name-only HEAD -- <files…>` to drop any file whose working
 *      tree has diverged from HEAD: a committed-then-edited file must be timed by
 *      its mtime (the edit), never by its now-stale commit time.
 *
 * Paths pass after `--` so a dash-prefixed filename cannot be read as a flag. Any
 * non-answer (no repo, no commits, missing git) yields an empty map → the caller
 * times every file by mtime. Never throws. The per-phase file list is small (a
 * verification report + a handful of summaries), so the argv stays far below the
 * Windows 32K limit. `execGitFn` is injectable so the two-call error handling is
 * unit-testable without spawning git.
 */
type ExecGitFn = typeof execGit;

function defaultPhaseCleanCommitTimesMs(
  phaseDir: string,
  files: string[],
  execGitFn: ExecGitFn = execGit,
): Map<string, number> {
  if (files.length === 0) return new Map();
  const requestedPosix = files.map(toPosix);

  const logRes = execGitFn(['log', '--first-parent', '--format=%ct', '--name-only', '--', ...files], {
    cwd: phaseDir,
  });
  if (logRes.error || logRes.exitCode !== 0 || logRes.stdout.length === 0) return new Map();
  const commitTimes = parseCommitTimes(logRes.stdout, files, requestedPosix);
  if (commitTimes.size === 0) return commitTimes;

  // Drop dirty files (working tree ≠ HEAD) so their mtime is used instead. If the
  // dirty-check itself is INCONCLUSIVE (git diff errored / non-zero — as opposed
  // to "ran and reported no dirty files"), we cannot prove any file is clean, so
  // fail SAFE: discard the commit times and let every file fall back to mtime,
  // the same direction as a git-log failure. Trusting possibly-stale commit times
  // here would silently mask a real edit (false "not stale"). (#2348)
  const diffRes = execGitFn(['diff', '--name-only', 'HEAD', '--', ...files], { cwd: phaseDir });
  if (diffRes.error || diffRes.exitCode !== 0) return new Map();
  for (const line of diffRes.stdout.split('\n')) {
    if (line.length === 0) continue;
    const rel = matchRequestedFile(line, files, requestedPosix);
    if (rel !== null) commitTimes.delete(rel);
  }
  return commitTimes;
}

/**
 * Build a 'missing' result from the routing table.
 * Used for two early-return paths: no *-VERIFICATION.md file found, and
 * file present but no parseable frontmatter status.
 */
function missingResult(runtime: string, phaseArg: string): VerificationStatusResult {
  const route = VERIFICATION_ROUTING_TABLE['missing'];
  return {
    status: route.status,
    next_action: route.next_action,
    next_command: projectNextCommand(route.next_command, runtime, phaseArg),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

interface ReadVerificationStatusOptions {
  fs?: FsLike;
  /** Injectable per-phase clean-commit-time resolver for the staleness clock (#2348). */
  phaseCleanCommitTimesMs?: PhaseCleanCommitTimesFn;
  /**
   * Runtime whose command surface `next_command` is projected into (#2617).
   * Callers that have a cwd should pass `resolveRuntime(cwd)`. Defaults to
   * `'claude'`, which yields the canonical `/gsd-<cmd>` hyphen form — never the
   * deprecated `/gsd:` colon form this field used to hard-code.
   */
  runtime?: string;
  /**
   * Phase number appended to the routed command (#2617). Defaults to the token
   * parsed from `phaseDir`, but only when that token is unambiguously numeric.
   * Callers that already know the number pass it explicitly — `init` reaches
   * this with `phaseDir` unresolved in some branches.
   */
  phaseNumber?: string;
}

interface VerificationStatusResult {
  status: string;
  next_action: string;
  next_command: string;
}

function findStaleVerificationSummary(
  phaseDir: string,
  fsImpl: FsLike = fs,
  phaseCleanCommitTimesMs: PhaseCleanCommitTimesFn = defaultPhaseCleanCommitTimesMs,
): StaleVerificationInfo | null {
  // FS errors (TOCTOU: a SUMMARY listed by scanPhasePlans then removed before statSync;
  // unreadable dir; broken symlink; file->dir swap) must degrade to "not stale" rather
  // than throw uncaught into callers that are NOT under the planning lock
  // (init.manager / init.progress / uat-predicate). Mirrors readVerificationStatus's
  // no-throw contract; `fsImpl` threads the same injectable-fs seam for parity/testing.
  // (Review B1 on #1548.)
  try {
    const phaseFiles = fsImpl.readdirSync(phaseDir);
    const verificationFile = phaseFiles.filter((f) => f.endsWith('-VERIFICATION.md')).sort()[0];
    if (!verificationFile) return null;

    const summaryFiles = (scanPhasePlans(phaseDir) as { summaryFiles: string[] }).summaryFiles
      .slice()
      .sort();
    // No summary can be newer than the verification → never stale. Return before
    // touching git so a phase with no summaries costs zero subprocesses. (#2348)
    if (summaryFiles.length === 0) return null;

    // Each file's effective "last changed" time = its commit time when committed
    // AND clean (content-tied and clone-stable), else its filesystem mtime (the
    // uncommitted working-tree edit). Both are real wall-clock change times, so
    // comparing a clean file's commit time against a dirty file's mtime is sound.
    // One resolver call = two git subprocesses for the whole phase. (#2348)
    const cleanCommitMs = phaseCleanCommitTimesMs(phaseDir, [verificationFile, ...summaryFiles]);
    const effectiveTimeMs = (file: string): number =>
      cleanCommitMs.has(file)
        ? (cleanCommitMs.get(file) as number)
        : fsImpl.statSync(path.join(phaseDir, file)).mtimeMs;

    const verificationTimeMs = effectiveTimeMs(verificationFile);
    for (const summaryFile of summaryFiles) {
      // The caller only needs whether the phase is stale, not which summary —
      // the first stale summary (in sorted order) is enough. Short-circuit.
      if (effectiveTimeMs(summaryFile) > verificationTimeMs) {
        return { verificationFile, summaryFile };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Read the verification status from the first `*-VERIFICATION.md` file in
 * phaseDir and return the routing result.
 *
 * Behavior:
 * 1. Find the first file matching `*-VERIFICATION.md` (sorted, take first).
 *    If none → status 'missing'.
 * 2. Extract `status` from FRONTMATTER ONLY via the shared extractFrontmatter
 *    parser (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix — parser anchors at byte 0).
 *    If no frontmatter block or no `status` key → status 'missing'.
 * 3. Map to routing table. Unknown non-empty value → status 'unknown'.
 *
 * @param phaseDir - Absolute path to the phase directory.
 * @param opts     - Options. `opts.fs` allows test injection (defaults to node:fs).
 *                   `opts.runtime` selects the command surface `next_command` is
 *                   projected into (#2617).
 */
function readVerificationStatus(
  phaseDir: string,
  opts: ReadVerificationStatusOptions = {},
): VerificationStatusResult {
  const fsImpl: FsLike = opts.fs ?? fs;
  const phaseCleanCommitTimesMs: PhaseCleanCommitTimesFn =
    opts.phaseCleanCommitTimesMs ?? defaultPhaseCleanCommitTimesMs;
  const runtime = opts.runtime ?? 'claude';

  // Phase token for the gaps_found command
  const baseName = path.basename(phaseDir);
  const phaseToken = extractPhaseToken(baseName);
  const derivedPhaseNumber = phaseToken.length > 0 ? phaseToken : baseName;
  // #2617: the phase number becomes a COMMAND ARGUMENT, so it is appended only
  // when it is unambiguously one. extractPhaseToken also returns project-code
  // forms (`PROJ-07`), which are indistinguishable by shape from an ordinary
  // directory name — `gsd-651-parent` yields `gsd-651` — and emitting
  // `execute-phase gsd-651` is worse than emitting no argument at all. Callers
  // that already know the number (init) pass it explicitly and always get it.
  const phaseArgSource = opts.phaseNumber ?? (/^\d+(\.\d+)*$/.test(derivedPhaseNumber) ? derivedPhaseNumber : '');
  const phaseArg = phaseArgSource ? ` ${phaseArgSource}` : '';

  // 1. Find *-VERIFICATION.md
  let verificationFile: string | null = null;
  try {
    const entries = fsImpl.readdirSync(phaseDir);
    const candidates = entries.filter((f) => f.endsWith('-VERIFICATION.md')).sort();
    verificationFile = candidates.length > 0 ? candidates[0] : null;
  } catch {
    // Directory unreadable → treat as missing
    verificationFile = null;
  }

  if (!verificationFile) {
    return missingResult(runtime, phaseArg);
  }

  // 2. Read and parse frontmatter using the shared parser.
  // extractFrontmatter anchors at byte 0, so body `status:` lines are ignored.
  const filePath = path.join(phaseDir, verificationFile);
  let rawStatus: string | null = null;
  try {
    const content = fsImpl.readFileSync(filePath, 'utf-8');
    const fm = extractFrontmatter(content);
    const statusVal = fm['status'];
    // status is always a scalar string in a well-formed VERIFICATION.md frontmatter;
    // only accept string values — arrays and objects are not valid status values.
    if (typeof statusVal === 'string') {
      const trimmed = statusVal.trim();
      rawStatus = trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    rawStatus = null;
  }

  if (!rawStatus) {
    return missingResult(runtime, phaseArg);
  }

  // gaps_found takes priority over stale — gap closure is the correct next
  // step regardless of whether summaries are newer than the verification file.
  if (rawStatus === 'gaps_found') {
    const entry = VERIFICATION_ROUTING_TABLE['gaps_found'];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: projectNextCommand('plan-phase', runtime, `${phaseArg} --gaps`),
    };
  }

  const staleVerification = findStaleVerificationSummary(phaseDir, fsImpl, phaseCleanCommitTimesMs);
  if (staleVerification) {
    const entry = VERIFICATION_ROUTING_TABLE['stale'];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: projectNextCommand('verify-work', runtime, phaseArg),
    };
  }

  // 3. Route — exclude internal sentinels from raw-file lookup (they are
  // constructed internally above, never written by the verifier).
  if (
    rawStatus in VERIFICATION_ROUTING_TABLE &&
    rawStatus !== 'missing' &&
    rawStatus !== 'unknown' &&
    rawStatus !== 'stale' &&
    rawStatus !== 'gaps_found'
  ) {
    const entry = VERIFICATION_ROUTING_TABLE[rawStatus];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: projectNextCommand(entry.next_command, runtime, phaseArg),
    };
  }

  // Unknown value
  const unknownRoute = VERIFICATION_ROUTING_TABLE['unknown'];
  return {
    status: unknownRoute.status,
    next_action: `Unexpected verification status '${rawStatus}'. Re-run execute-phase verification.`,
    next_command: projectNextCommand(unknownRoute.next_command, runtime, phaseArg),
  };
}

/**
 * CLI command handler: resolve phaseDir against cwd, call readVerificationStatus,
 * emit via io.output().
 *
 * @param cwd         - Current working directory (used to resolve phaseDirArg).
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd).
 * @param raw         - Whether to emit raw (non-JSON) output.
 */
function cmdVerificationStatus(cwd: string, phaseDirArg: string | undefined, raw: boolean): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.status');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  const result = readVerificationStatus(phaseDir, { runtime: resolveRuntime(cwd) });
  output(result, raw);
}

export = {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  defaultPhaseCleanCommitTimesMs,
  findStaleVerificationSummary,
  readVerificationStatus,
  cmdVerificationStatus,
};
