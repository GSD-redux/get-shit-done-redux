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
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScopeMod = require('./planning-scope.cjs');
import { execGit } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';

const { output, error } = io;
const { extractPhaseToken, scopeToPhase } = phaseId;
const { extractFrontmatter } = frontmatterMod;
const { normalizeLineEndings } = coreUtilsMod;
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

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
    next_action: 'No verification report found — the verify step never completed. Running execute-phase is safe here: it resumes at the verification gates and does not re-run plans that already have a SUMMARY.md (see #2868).',
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

/**
 * Outcome of a staleness check. `determined:false` means the check could NOT
 * run to completion (an fs / scanPhasePlans / injected-clock failure) — this
 * is distinct from `determined:true, stale:false`, which means the check ran
 * to completion and genuinely found nothing stale. Collapsing the two (the
 * pre-#3057 behavior: both returned `null`) let a disk-scan failure silently
 * report "not stale" — the same fail-open shape as #3050. (#3057 B3)
 */
type StaleCheckResult =
  | { determined: true; stale: true; verificationFile: string; summaryFile: string }
  | { determined: true; stale: false }
  | { determined: false };

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

interface ResolveVerificationFileOptions {
  /**
   * #3473 F2: three OTHER hand-rolled selection sites (`src/commands.cts`
   * determinePhaseStatus and two `verification_path` projectors in
   * `src/init.cts`) additionally accept a BARE `VERIFICATION.md` — a form
   * this module's own two callers (`findStaleVerificationSummary`,
   * `readVerificationStatus`) have never accepted, because a bare filename
   * carries no phase token and `.endsWith('-VERIFICATION.md')` structurally
   * excludes it. Defaults to `false`, which is byte-for-behavior identical to
   * the pre-existing (non-optioned) resolver — no call-site edit required for
   * the two callers in THIS module. Set `true` only from a call site whose
   * pre-fix behavior already accepted a bare match.
   */
  allowBare?: boolean;
  /**
   * #3492 regression fix: the phase token (`extractPhaseToken` on the phase
   * directory's own basename — same grammar `src/phase-id.cts` owns via
   * `PHASE_NUMBER_TOKEN_SOURCE`) THIS call is resolving for. Every call site
   * knows its own phaseDir, so every call site can derive and pass this.
   *
   * Pinning selection to the caller's own phase is load-bearing: preferring
   * ANY canonically-shaped `<token>-VERIFICATION.md` (regardless of whose
   * token it carries) let a stray cross-phase or sentinel-numbered file
   * (`999-VERIFICATION.md`) outrank the phase's own non-canonical report
   * (`12-review-VERIFICATION.md`) — a regression this option closes.
   *
   * Omitted / empty when the token cannot be derived: falls back to plain
   * alphabetically-first among the SCOPED dashed candidates (see
   * `phaseDirName` below), never to null.
   */
  phaseToken?: string;
  /**
   * #3511 reconciliation: the phase directory's own basename (the same value
   * every call site already passes through `extractPhaseToken` to derive
   * `phaseToken` above) — needed separately because the fallback below scopes
   * by `isPhaseArtifact(fileName, phaseDirName)`, not by `phaseToken`.
   *
   * Omitted: the fallback degrades to the plain (unscoped) alphabetically-first
   * pick — the original pre-#3357 behavior — never to null.
   */
  phaseDirName?: string;
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded verbatim into
   * `scopeToPhase(candidates, phaseDirName, convention)` so the fallback
   * scopes a bracket dir (`{CODE}.{MM}-{PP}-slug`) by its real phase token
   * instead of the include-everything ambiguity fail-safe. Same ADR-2121
   * additive shape as every other convention thread: omitted / null resolves
   * to the unchanged legacy scoping.
   */
  convention?: string | null;
}

/**
 * #3518: `resolveUatFile`'s options — same two knobs, same semantics, as
 * `ResolveVerificationFileOptions` above (the UAT artifact is selected by the
 * identical phase-pinned rule the verification report is; see
 * `resolvePhaseArtifactFile` below for the single shared selection core).
 */
type ResolveUatFileOptions = ResolveVerificationFileOptions;

/**
 * #3518: the shared phase-pinned artifact-selection core BOTH single-pick
 * resolvers (`resolveVerificationFile` for `*-VERIFICATION.md`,
 * `resolveUatFile` for `*-UAT.md`) delegate to — one rule, not two grammars
 * that agree today and drift tomorrow (epic #3473 F2's defect class).
 *
 * `bareName` is the artifact filename WITHOUT the leading dash (`'UAT.md'`);
 * a "dashed" candidate is any entry ending `-${bareName}`.
 *
 * Selection order:
 *   1. `options.phaseToken` given and `<phaseToken>-${bareName}` is among
 *      the candidates — that exact file always wins: it is THIS phase's own
 *      artifact, and no other candidate (whichever phase's token it carries)
 *      can outrank it (#3492 / #3518).
 *   2. Fallback — no exact phase-token match (or no token given): alphabetically
 *      first of the dashed candidates that are THIS phase's own, per
 *      `scopeToPhase(candidates, options.phaseDirName)` (#3511 reconciliation,
 *      below). Load-bearing: a phase whose only artifact is non-canonically
 *      named must keep resolving to it, not to null — this fix must not turn
 *      "found an artifact" into "found nothing" for anyone. A
 *      non-canonically-named artifact of THIS phase (e.g.
 *      `03-CORRECTION-VERIFICATION.md` in `03-foo`) still passes
 *      `isPhaseArtifact` (it names phase 03, same as the directory), so it
 *      is still returned here.
 *   3. `options.allowBare` only — a bare `${bareName}`, ranked BELOW both
 *      of the above. Rationale: a dashed file names its phase, a bare one
 *      does not, so a dashed file (canonical or not) is always the better
 *      answer when both exist. Reached when neither (1) nor (2) found any
 *      candidate — including when (2)'s scoping filtered every dashed
 *      candidate out as belonging to some OTHER phase.
 *
 * #3511 RECONCILIATION with `isPhaseArtifact` (`src/phase-id.cts`): that
 * predicate's own docblock used to flag this fallback as an open gap — its
 * aggregate scans exclude a cross-phase stray, but this single-pick resolver
 * did not, so it could return a stray as THE artifact while the aggregate
 * scans correctly ignored it. Closed by scoping step (2) above through
 * `scopeToPhase` (`src/phase-id.cts`, itself built on `isPhaseArtifact`):
 * `options.phaseDirName` threads the phase directory's basename in, and the
 * fallback now filters candidates through `scopeToPhase(candidates,
 * phaseDirName)` before picking alphabetically-first. This does NOT reopen
 * the #3357 guarantee — that guarantee is "a phase whose only report is
 * non-canonically named must keep working", and a non-canonically-named
 * artifact of THIS phase still passes `isPhaseArtifact` (it is membership by
 * phase number, not by canonical shape), so it is still returned. Only a
 * file belonging to a DIFFERENT phase is now excluded — and excluding it is
 * correct: returning another phase's artifact as this phase's own is worse
 * than reporting none (confidently wrong beats honestly empty).
 * The fail-safe now lives entirely inside `isPhaseArtifact`, not in
 * `scopeToPhase` (which is a plain filter with no unfiltered fallback):
 * (a) when phase-number membership cannot be determined for `phaseDirName` at
 * all (no reliable token — the zero-token directory case), every candidate is
 * treated as belonging to the phase; (b) the `firstLetterPrefixed`
 * bracket-ambiguity case, where a letter-prefixed-decimal dir is
 * string-indistinguishable from a bracket-dir token, also includes
 * everything rather than guess; (c) a token-less filename (bare
 * `${bareName}`) is accepted by directory containment alone. Outside
 * those cases, when scoping DOES remove every dashed candidate — a real
 * cross-phase stray, or a phase whose own artifact is genuinely absent — the
 * fallback below correctly falls through to `allowBare`/`null`: reporting no
 * artifact, not another phase's. `options.phaseDirName` omitted entirely skips
 * the filter outright (the ternary below), which is unscoped, pre-#3511
 * behavior.
 *
 * Pure — takes an already-read directory listing and does no I/O of its own,
 * so every call site keeps its existing `fsImpl` seam and no-throw contract
 * untouched.
 */
function resolvePhaseArtifactFile(
  entries: string[],
  bareName: string,
  options: ResolveVerificationFileOptions = {},
): string | null {
  const candidates = entries.filter((f) => f.endsWith(`-${bareName}`)).sort();
  if (candidates.length > 0) {
    if (options.phaseToken) {
      const thisPhaseFile = `${options.phaseToken}-${bareName}`;
      if (candidates.includes(thisPhaseFile)) return thisPhaseFile;
    }
    // #3511: scope the fallback to files that belong to THIS phase, so a
    // stray cross-phase file can no longer outrank a return of null.
    // `phaseDirName` omitted, or membership undeterminable for it, →
    // unscoped `candidates` (pre-#3511 behavior); otherwise strays are
    // filtered out, and if that leaves nothing the code falls through to
    // `allowBare`/`null` deliberately.
    const scoped = options.phaseDirName
      ? scopeToPhase(candidates, options.phaseDirName, options.convention)
      : candidates;
    if (scoped.length > 0) return scoped[0];
  }
  if (options.allowBare && entries.includes(bareName)) return bareName;
  return null;
}

/**
 * Resolve which `*-VERIFICATION.md` entry in a phase directory's listing IS
 * the phase's verification report, when more than one such file exists.
 *
 * #3357: a phase dir can legitimately hold more than one `*-VERIFICATION.md`
 * — the real per-phase report (`03-VERIFICATION.md`) alongside an ad-hoc plan
 * worksheet (`03-CORRECTION-VERIFICATION.md`). Picking "alphabetically first"
 * (`'C' < 'V'`) silently chose the worksheet, which usually has no
 * frontmatter `status:`, so a phase with a PASSING report read as `missing`.
 * This was two independent hand-rolled `.sort()[0]` picks
 * (findStaleVerificationSummary and readVerificationStatus) — this is the
 * single resolver both now call (#3473 F2).
 *
 * Selection order: see `resolvePhaseArtifactFile` (the shared core this
 * delegates to since #3518, itself phase-scoped since #3511) —
 * phase-token-pinned, then phase-scoped alphabetically-first dashed
 * fallback, then (allowBare only) a bare `VERIFICATION.md`. #3518 extracted
 * this into the shared core without changing behavior; #3511's
 * `phaseDirName` scoping now lives inside that shared core rather than here.
 */
function resolveVerificationFile(
  entries: string[],
  options: ResolveVerificationFileOptions = {},
): string | null {
  return resolvePhaseArtifactFile(entries, 'VERIFICATION.md', options);
}

/**
 * #3518: resolve which `*-UAT.md` entry in a phase directory's listing IS
 * the phase's UAT artifact, when more than one such file exists — the UAT
 * counterpart of `resolveVerificationFile`, sharing its exact selection rule
 * via `resolvePhaseArtifactFile`.
 *
 * The bug this closes: both `uat_path` projectors in `src/init.cts` picked
 * with a bare `.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md')` over an
 * unsorted `readdir` listing — no phase-membership check and no ordering — so
 * a stray or cross-phase `04-UAT.md` sitting in phase 03's directory could
 * become phase 03's `uat_path`, and WHICH file won was filesystem-dependent
 * (creation order on APFS, hash order on ext4/XFS): two machines on the same
 * commit could emit different `uat_path` values for the same phase. `uat_path`
 * is consumed downstream by workflows that then read the named file, so a
 * wrong path routes UAT state from another phase.
 *
 * Deterministic by construction: same answer on every machine. Phase-scoped
 * (#3511): passing `options.phaseDirName` filters the alphabetically-first
 * fallback (tier 2) to artifacts that belong to THIS phase — see
 * `resolvePhaseArtifactFile` for the full selection order and scoping
 * rationale.
 */
function resolveUatFile(
  entries: string[],
  options: ResolveUatFileOptions = {},
): string | null {
  return resolvePhaseArtifactFile(entries, 'UAT.md', options);
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
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded through to
   * `resolveVerificationFile` (exact-pin token + fallback scoping) and
   * `findStaleVerificationSummary` so a bracket phase dir resolves and
   * scopes its report exactly like its legacy twin. Deliberately NOT used
   * for the routed command argument — see the derivation comment in the
   * body. Omitted / null: unchanged legacy behavior.
   */
  convention?: string | null;
}

interface VerificationStatusResult {
  status: string;
  next_action: string;
  next_command: string;
  /**
   * True when the internal staleness check (findStaleVerificationSummary)
   * could not run to completion (an fs / scanPhasePlans / clock failure) —
   * `status` above was routed as if the phase were not stale (the pre-existing
   * no-throw fail-open contract, preserved unchanged), but this flag lets a
   * caller distinguish "checked; nothing is stale" from "could not check" so
   * the two are no longer silently identical (#3057 B3). Omitted (not present)
   * when the staleness check ran to completion, or was never reached (e.g. the
   * `gaps_found` short-circuit above it, or no verification file at all).
   */
  staleCheckIndeterminate?: boolean;
}

function findStaleVerificationSummary(
  phaseDir: string,
  fsImpl: FsLike = fs,
  phaseCleanCommitTimesMs: PhaseCleanCommitTimesFn = defaultPhaseCleanCommitTimesMs,
  convention?: string | null,
): StaleCheckResult {
  // FS errors (TOCTOU: a SUMMARY listed by scanPhasePlans then removed before statSync;
  // unreadable dir; broken symlink; file->dir swap) must degrade rather than throw
  // uncaught into callers that are NOT under the planning lock (init.manager /
  // init.progress / uat-predicate). Mirrors readVerificationStatus's no-throw
  // contract; `fsImpl` threads the same injectable-fs seam for parity/testing.
  // (Review B1 on #1548.) The degraded result is `{determined:false}`, NOT the
  // same value as a completed "nothing is stale" check — see StaleCheckResult
  // doc and #3057 B3. The caller decides how to route an indeterminate result;
  // this function only reports what it actually knows.
  try {
    const phaseFiles = fsImpl.readdirSync(phaseDir);
    // #3492: pin selection to THIS phase's own token so a stray cross-phase
    // or sentinel-numbered canonically-shaped file cannot outrank this
    // phase's own (possibly non-canonical) report. #3511: phaseDirName scopes
    // the fallback path to this same phase (see resolveVerificationFile docs).
    const phaseDirName = path.basename(phaseDir);
    // #612: token derived convention-aware — under the bracket convention a
    // dir's own token sits behind its `{CODE}.{MM}-` prefix, and the #3492
    // exact-pin only fires when the token matches what cmdScaffold writes
    // (padded, code- and milestone-stripped). Convention-less calls are
    // byte-identical to the prior derivation.
    const phaseToken = extractPhaseToken(phaseDirName, convention);
    const verificationFile = resolveVerificationFile(phaseFiles, { phaseToken, phaseDirName, convention });
    if (!verificationFile) return { determined: true, stale: false };

    const summaryFiles = (scanPhasePlans(phaseDir) as { summaryFiles: string[] }).summaryFiles
      .slice()
      .sort();
    // No summary can be newer than the verification → never stale. Return before
    // touching git so a phase with no summaries costs zero subprocesses. (#2348)
    if (summaryFiles.length === 0) return { determined: true, stale: false };

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
        return { determined: true, stale: true, verificationFile, summaryFile };
      }
    }

    return { determined: true, stale: false };
  } catch {
    return { determined: false };
  }
}

/**
 * Read the verification status from the first `*-VERIFICATION.md` file in
 * phaseDir and return the routing result.
 *
 * Behavior:
 * 1. Find the phase's verification report via `resolveVerificationFile`
 *    (canonical `<phase-token>-VERIFICATION.md` preferred; falls back to the
 *    alphabetically-first `*-VERIFICATION.md` that belongs to THIS phase when
 *    none is canonical — #3357/#3511). If none → status 'missing'.
 * 2. Extract `status` from FRONTMATTER ONLY via the shared extractFrontmatter
 *    parser (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix — parser anchors at byte 0).
 *    If no frontmatter block or no `status` key → status 'missing'.
 * 3. Map to routing table. Unknown non-empty value → status 'unknown'.
 *
 * The internal staleness check can itself fail (fs / scanPhasePlans / clock
 * error); when it does, `status` is routed as if nothing were stale (the
 * pre-existing no-throw fail-open contract — unchanged), but the returned
 * result carries `staleCheckIndeterminate: true` so a caller can distinguish
 * "checked; nothing is stale" from "could not check" (#3057 B3).
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

  // Phase token for the gaps_found command — deliberately convention-LESS
  // even when `opts.convention` is present: the token becomes a bare COMMAND
  // ARGUMENT below, and a bare bracket phase number is milestone-ambiguous
  // (`02` cannot tell GSD.01-02 from GSD.02-02), so the argument keeps its
  // pre-#612 shape. The convention-aware token is derived separately for
  // FILE RESOLUTION only (`resolutionToken`, at the readdir below).
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
    // #3492: pin selection to THIS phase's own token so a stray cross-phase
    // or sentinel-numbered canonically-shaped file cannot outrank this
    // phase's own (possibly non-canonical) report. #3511: baseName also
    // scopes the fallback path to this same phase (see resolveVerificationFile
    // docs). #612: the RESOLUTION token is convention-aware — under the
    // bracket convention the dir's own token sits behind its `{CODE}.{MM}-`
    // prefix, and the exact-pin only fires when the token matches what
    // cmdScaffold writes — while the command-argument token above stays
    // convention-less (see its comment).
    const resolutionToken = opts.convention === 'bracket'
      ? extractPhaseToken(baseName, opts.convention)
      : phaseToken;
    verificationFile = resolveVerificationFile(entries, {
      phaseToken: resolutionToken,
      phaseDirName: baseName,
      convention: opts.convention,
    });
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
    // #3707-CR follow-up MINOR 1: normalize line endings at this read
    // boundary — this function's own `readFileSync` is the equivalent seam
    // `planning.inspect`'s `buildUatRows`/`readDocument` route through for
    // UAT/REQUIREMENTS documents, but `readVerificationStatus` had no such
    // normalization of its own. A lone-CR VERIFICATION.md's `---\r...\r---`
    // frontmatter fence never matched `extractFrontmatter`'s byte-0
    // `---\n`/`---\r\n` check, so `status: passed` was read as absent and
    // this function reported 'missing' — under-reporting a completed
    // verification as if the step never ran, the fail-safe direction but the
    // same root cause as the false-clean class fixed elsewhere in #3707-CR.
    const content = normalizeLineEndings(fsImpl.readFileSync(filePath, 'utf-8'));
    const fm = extractFrontmatter(content, filePath);
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

  const staleCheck = findStaleVerificationSummary(phaseDir, fsImpl, phaseCleanCommitTimesMs, opts.convention);
  if (staleCheck.determined && staleCheck.stale) {
    const entry = VERIFICATION_ROUTING_TABLE['stale'];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: projectNextCommand('verify-work', runtime, phaseArg),
    };
  }
  // staleCheck is either {determined:true, stale:false} (checked; nothing
  // stale) or {determined:false} (could not check — fs/scan/clock failure).
  // Both fall through to normal routing below (the pre-existing no-throw
  // fail-open contract is unchanged), but the indeterminate case is flagged
  // on the returned result so a caller can tell the two apart (#3057 B3).
  const staleCheckIndeterminate = !staleCheck.determined;

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
      ...(staleCheckIndeterminate ? { staleCheckIndeterminate: true } : {}),
    };
  }

  // Unknown value
  const unknownRoute = VERIFICATION_ROUTING_TABLE['unknown'];
  return {
    status: unknownRoute.status,
    next_action: `Unexpected verification status '${rawStatus}'. If this is an intentional non-standard marker (e.g. a hand-set failed/superseded state), no action is needed. Otherwise, run execute-phase to regenerate verification — it will not re-run plans that already have a SUMMARY.md.`,
    next_command: projectNextCommand(unknownRoute.next_command, runtime, phaseArg),
    ...(staleCheckIndeterminate ? { staleCheckIndeterminate: true } : {}),
  };
}

interface IsPhaseCompleteDeps {
  fs?: FsLike;
  /** Injectable per-phase clean-commit-time resolver, threaded through to readVerificationStatus. */
  phaseCleanCommitTimesMs?: PhaseCleanCommitTimesFn;
  /** Runtime whose command surface next_command is projected into (#2617). */
  runtime?: string;
  /** Phase number appended to the routed command (#2617). */
  phaseNumber?: string;
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded through to
   * readVerificationStatus so a bracket phase dir resolves and scopes its
   * report exactly like its legacy twin. Omitted / null: unchanged.
   */
  convention?: string | null;
}

interface PhaseCompletionValue {
  complete: boolean;
  verification: VerificationStatusResult;
}

/**
 * isPhaseComplete — the single canonical owner of "is phase P complete?"
 * (ADR-3180 §7.4, Decision 1). Sited beside readVerificationStatus, which it
 * wraps.
 *
 * DISK-STRICT (#2957, maintainer decision 2026-08-08; ADR-3180 §7.4 amended
 * af92fd4c9): readVerificationStatus is called UNCONDITIONALLY here — plan
 * count is NOT a precondition. A phase with zero plans and a passing
 * `*-VERIFICATION.md` is complete (#3168). A ROADMAP checkbox has no machine
 * authority and is never consulted — this function never reads ROADMAP.md.
 *
 * `complete` is exactly `verification.status === 'passed'`. `verification`
 * carries the FULL routing result (status/next_action/next_command), so a
 * caller can distinguish a failing verdict (`gaps_found`/`human_needed`/
 * `stale`/`unknown`) from an absent one (`missing`) — both are "not
 * complete", but they are not the same non-answer.
 *
 * `scope` is UNREADABLE when `phaseDir` itself could not be listed — this is
 * INDEPENDENT of readVerificationStatus's own no-throw fail-open contract for
 * a missing `*-VERIFICATION.md` file (a well-formed answer,
 * `verification.status === 'missing'`, scope COMPLETE): a caller must not
 * read `value.complete: false` here as a confident "not complete" the way it
 * can for a genuinely-checked missing file.
 *
 * Does NOT import scanPhasePlans / plan-scan.cjs — the owner consumes plan
 * counts from its caller when a caller needs them for a different question
 * (e.g. buildPhaseCompletionProjection's own `implementation_complete`); it
 * never re-derives or requires them itself.
 */
function isPhaseComplete(
  phaseDir: string,
  deps: IsPhaseCompleteDeps = {},
): { value: PhaseCompletionValue; scope: Scope } {
  const fsImpl: FsLike = deps.fs ?? fs;
  let readable = true;
  try {
    fsImpl.readdirSync(phaseDir);
  } catch {
    readable = false;
  }

  const verification = readVerificationStatus(phaseDir, {
    fs: deps.fs,
    phaseCleanCommitTimesMs: deps.phaseCleanCommitTimesMs,
    runtime: deps.runtime,
    phaseNumber: deps.phaseNumber,
    convention: deps.convention,
  });

  return {
    value: {
      complete: verification.status === 'passed',
      verification,
    },
    scope: readable ? SCOPE.COMPLETE : SCOPE.UNREADABLE,
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

/**
 * CLI command handler: resolve which `*-VERIFICATION.md` in `phaseDirArg` is
 * the phase's own report, via the shared `resolveVerificationFile` seam, and
 * emit its absolute path.
 *
 * #3492 F3: the ONE seam shell callers (verify-work.md's writer, transition.md's
 * awk reader) route through instead of hand-rolling `ls *-VERIFICATION.md |
 * head -1` / an awk glob scan — both of which pick alphabetically-first and so
 * diverge from every JS reader now pinned to the phase's own token.
 *
 * Emits `{ verification_file: "<absolute path>" | "" }` (empty when no
 * candidate resolves, including an unreadable directory). `raw` emits the
 * bare path string (possibly empty) so `VAR=$(gsd_run query
 * verification.resolve-file "$PHASE_DIR" --raw)` is directly assignable.
 *
 * @param cwd         - Current working directory (used to resolve phaseDirArg).
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd).
 * @param raw         - Whether to emit raw (non-JSON) output.
 */
function cmdVerificationResolveFile(cwd: string, phaseDirArg: string | undefined, raw: boolean): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.resolve-file');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  let verificationPath = '';
  try {
    const entries = fs.readdirSync(phaseDir);
    const phaseDirName = path.basename(phaseDir);
    const phaseToken = extractPhaseToken(phaseDirName);
    const verificationFile = resolveVerificationFile(entries, { allowBare: true, phaseToken, phaseDirName });
    if (verificationFile) {
      verificationPath = path.join(phaseDir, verificationFile);
    }
  } catch {
    verificationPath = '';
  }
  output({ verification_file: verificationPath }, raw, verificationPath);
}

export = {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  defaultPhaseCleanCommitTimesMs,
  resolveVerificationFile,
  resolveUatFile,
  findStaleVerificationSummary,
  readVerificationStatus,
  isPhaseComplete,
  cmdVerificationStatus,
  cmdVerificationResolveFile,
};
