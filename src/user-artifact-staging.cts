'use strict';

/**
 * User Artifact Staging Module — #2875 (epic #2866 Phase 6), governed by
 * ADR-3574 and `.gsd/phase/feat-2875-materialization-primitives/40-design.md`
 * Part 1.
 *
 * Durable, on-disk staging for user-owned artifacts (`USER_OWNED_ARTIFACTS`,
 * `install-engine.cts`) across the preserve → wipe → restore window that
 * `preserveUserArtifacts`/`restoreUserArtifacts` previously held only in an
 * in-memory `Map` (#1874-F19). A process death between preserve and restore —
 * Ctrl-C, OOM, a converter throw mid-copy — silently discarded the map,
 * losing the user's file forever. Staging to disk closes that window;
 * `recoverOrphanedUserArtifacts` closes the OTHER half of the fix: a staged
 * copy nothing ever reads back is bytes-safe but user-visibly lost — the
 * #1879-F15 inert-fix failure mode 40-design.md's "inertness trap" section
 * names explicitly. See that doc for the full rationale.
 *
 * Synchronous only, matching install-fs-adapter.cts's documented contract —
 * every fs call in this module routes through `installFs()`.
 *
 * Staging layout, all under a caller-supplied `stagingRoot` (by convention
 * `<configDir>/.gsd-staging/user-artifacts/` — a sibling of every wipe
 * target this phase's call sites wipe, so staging survives all of them,
 * while still resolving inside `configDir`):
 *
 *   <stagingRoot>/<sha256(destDir)-16>-<sha256(runId)-8>/record.json  — the commit point
 *   <stagingRoot>/<sha256(destDir)-16>-<sha256(runId)-8>/files/<name> — copied, symlink-safe
 *
 * The sha256-of-destDir component (not a raw path) keeps the entry-dir name
 * filesystem-safe; the sha256-of-runId component (`opts.runId`, default
 * `String(process.pid)`) discriminates concurrent RUNS targeting the same
 * destDir (module doc "Concurrency" below) while still making repeat calls
 * from the SAME run (the same process, the default case) reuse/overwrite the
 * same entry rather than accumulating orphans (test-matrix A6) — hashing
 * `runId` rather than using it raw keeps the same filesystem-safety/bounded-
 * length guarantee the destDir hash already provides, regardless of what a
 * caller passes.
 *
 * `record.json` (`{ destDir, names, timestamp }`) is written AFTER every
 * file copy lands, never before — a half-written staging directory (a crash
 * during the copy loop) has no record, and `recoverOrphanedUserArtifacts`
 * ignores it (test-matrix B4/A7). The record's PRESENCE is what "staged"
 * means; this module never infers completeness from directory contents
 * alone.
 *
 * Confinement: this module carries the SAME "no policy, reuse the existing
 * decision" discipline install-fs-adapter.cts documents for
 * `hasExistingSymlinkBetween` / `assertDestWithinConfigHome` — it never
 * reimplements either. Every path this module writes, and every path
 * `recoverOrphanedUserArtifacts` reads OUT of an on-disk record before
 * writing to it (attacker-influenceable input the moment an install runs on
 * a shared machine — test-matrix E2), is re-resolved through the SAME
 * `assertDestWithinConfigHome` (runtime-artifact-install-plan.cts) every
 * other write on this call tree already uses, never a bespoke check.
 * `recoverOrphanedUserArtifacts` ADDITIONALLY re-applies `hasExistingSymlinkBetween`
 * (install-engine.cts) — the SAME guard `_copyStaged`/
 * `migrateLegacyDevPreferencesToSkill` apply to their own writes — against
 * the record's `destDir` once it has cleared `assertDestWithinConfigHome`
 * (#2875 defect fix, test-matrix E2 strengthened): lexical confinement alone
 * does not detect a symlinked ANCESTOR directory (e.g. `<configDir>/linkdir
 * -> <outside>`, a record naming `<configDir>/linkdir/sub/USER-PROFILE.md`)
 * — `path.resolve` string math has no concept of what a path component
 * actually IS on disk. `hasExistingSymlinkBetween` is required lazily
 * (inside the function body, not at module top) via `require('./install-
 * engine.cjs')` specifically to avoid a load-time circular require:
 * install-engine.cts imports this module statically at its own top, so a
 * static top-level import here would capture install-engine's exports
 * object BEFORE its own `export =` assignment runs, permanently binding to
 * an empty object (the classic `module.exports = {...}` circular-require
 * footgun) — a lazy, call-time `require` instead resolves against the fully
 * populated module, exactly matching the existing lazy-require precedent
 * `runtime-artifact-install-plan.cts` already uses for the same reason. This
 * module does not accept a `configDir` parameter to `stageUserArtifacts` (it
 * cannot confine `stagingRoot` itself against a configHome — callers remain
 * responsible for that; the same call-site pattern `_copyStaged`/
 * `migrateLegacyDevPreferencesToSkill` already use for
 * `hasExistingSymlinkBetween`, including the symlinked-staging-root refusal,
 * test-matrix E4 — see install-engine.cts's and bin/install.js's call sites).
 * `recoverOrphanedUserArtifacts`, however, DOES take `configDir` explicitly —
 * deriving it from `stagingRoot`'s own path shape would rest the E2
 * confinement guarantee on a naming convention rather than an explicit
 * caller-supplied value, which is fragile in exactly the direction E2 exists
 * to guard against.
 *
 * Never-overwrite (C2) and destination-symlink refusal: both
 * `recoverOrphanedUserArtifacts` and `restoreStagedUserArtifacts` probe the
 * destination with `lstatSync` (never `existsSync`) before writing (#2875
 * defect fix). `existsSync` FOLLOWS symlinks and reports `false` for a
 * DANGLING one — a symlink whose target does not exist — so an
 * `existsSync`-based "is something already there" check is blind to exactly
 * a dangling symlink planted at the destination; `copyFileSync`/
 * `symlinkSync` (via `copyPreservingSymlink`) then follow that link and
 * create the attacker-chosen target outside `configDir`. `lstatSync` never
 * follows a symlink and succeeds for a dangling one, so it correctly reports
 * "something is here" (a symlink, whatever its target) rather than "nothing
 * is here". Every path name staged, restored, or recovered is REQUIRED to be
 * a flat name — no path separator of either platform's flavor (`/` or `\`),
 * matching every real caller's actual usage (a single flat filename like
 * `'dev-preferences.md'`) and the `E3/E5` traversal/NUL-byte rejection this
 * module already performs; a name containing a separator is rejected the
 * same way (test-matrix rewritten E-series).
 *
 * Symlink safety: staged files are copied via installer-migrations.cts's
 * `copyPreservingSymlink` (routed through `installFs()` by this same phase),
 * which never dereferences a symlink — a managed path replaced by a link to
 * (e.g.) `~/.ssh/id_rsa` cannot have the referent's bytes copied into the
 * staging tree, or back out of it on restore/recovery (test-matrix A4). This
 * is the SOURCE side; consumers that read a staged copy's CONTENT back
 * (rather than re-copying it byte-for-byte via `copyPreservingSymlink`) must
 * separately check `lstatSync(...).isSymbolicLink()` before calling
 * `readFileSync` on it, or `readFileSync` will happily follow the staged
 * symlink and read the referent's bytes — see install-engine.cts's
 * `_runLegacyInstallMigrations` call site for the guarded pattern.
 *
 * Failure posture: staging (`stageUserArtifacts`) throws on any real IO
 * failure — an existing file that cannot be copied, or the staging directory
 * itself cannot be created. This is deliberate (test-matrix D4, a
 * correctness row, not an error-handling row): a caller MUST let this
 * propagate and abort BEFORE wiping the source directory, or the wipe
 * proceeds having staged nothing, which is worse than no staging at all.
 * `restoreStagedUserArtifacts`/`discardStagedUserArtifacts`/
 * `recoverOrphanedUserArtifacts` degrade instead: a missing staged file, a
 * missing `stagingRoot`, or a malformed record are all treated as "nothing
 * to do", never a throw — the durability property this module exists for
 * would be self-defeating if RECOVERY could itself crash an install.
 * `recoverOrphanedUserArtifacts`'s "never throws" contract is enforced with
 * a per-FILE try/catch around every copy (a failure recovering one name is
 * reported and skipped, the rest of the batch still proceeds) wrapped in a
 * per-ENTRY try/catch around the whole batch (a failure this module did not
 * anticipate — e.g. `symlinkSync` throwing `EPERM` for an unprivileged
 * Windows user, or a staged `files/<name>` that is unexpectedly a directory
 * — is reported and the loop moves to the NEXT staging entry rather than
 * propagating out of the function entirely). A batch that cannot be
 * recovered is never swept — it is left in place for a future run or manual
 * inspection, matching this module's existing "malformed record left alone"
 * precedent (C6).
 *
 * CONCURRENCY (#2875 defect fix, test-matrix row F1 — previously documented
 * as an open limitation requiring a cross-process lock; that reasoning was
 * revisited and found unnecessarily strong): two RUNS (processes) racing the
 * same `destDir` no longer share an entry directory. The staging key is
 * `sha256(destDir)` COMBINED with `sha256(runId)` (`opts.runId`, default
 * `String(process.pid)`) — the OS guarantees PID uniqueness among
 * SIMULTANEOUSLY RUNNING processes, so two concurrently-live installs always
 * key to different entry directories, and `stageUserArtifacts`'s
 * entryDir-clearing step / `recoverOrphanedUserArtifacts`'s end-of-batch
 * `rmSync` can therefore never destroy a DIFFERENT live run's in-flight or
 * just-committed batch — the destructive clear is safe by construction, no
 * lock needed. A crashed run's orphaned entry is not lost either: it is
 * swept the ordinary way, by a LATER run's `recoverOrphanedUserArtifacts`
 * pass (module doc "Failure posture" / C1-C4) — recovery iterates every
 * entry under `stagingRoot` regardless of which run's key produced it, and
 * the C2 never-overwrite guard means a stale orphan from an earlier crashed
 * run can never clobber a newer, already-restored file.
 *
 * OWNER-LIVENESS GUARD (#2875 defect fix, closes the F1 residual above — a
 * SECOND run's recovery pass executing WHILE a first, still-live run is
 * between `stageUserArtifacts`'s commit and its own
 * `restoreStagedUserArtifacts`/`discardStagedUserArtifacts` call is not an
 * exotic interleaving: `recoverOrphanedUserArtifacts` runs as the FIRST
 * statement of both `install()` and `uninstall()`, so it is exactly what
 * happens whenever a second install starts while a first is still inside its
 * wipe): `record.json` now carries `runId` RAW (unhashed — `stagingKeyFor`
 * still only ever sees the hash) alongside `timestamp`, and
 * `recoverOrphanedUserArtifacts` treats an entry as belonging to a STILL-LIVE
 * run — leaving it COMPLETELY untouched, neither recovered nor swept, never
 * even attempting `assertDestWithinConfigHome` against it — when ALL of:
 * (1) `runId` parses as a valid positive-integer pid (`parseOwnerPid` —
 * `"0"` and negative values are excluded because POSIX treats those as a
 * process-GROUP signal, never a single pid); (2) `process.kill(pid, 0)`
 * does not report `ESRCH` (`isProcessAlive` — cross-platform pid-existence
 * probe that sends no actual signal; any outcome OTHER than "provably dead"
 * is treated as "alive", including `EPERM`); (3) the record's `timestamp` is
 * within `OWNER_LIVENESS_GRACE_MS` (5 minutes — a generous multiple of this
 * codebase's own 60s npm-subprocess timeout convention, chosen because the
 * failure direction is asymmetric: skipping a genuine orphan for up to 5
 * minutes merely delays recovery, the bytes stay on disk, whereas sweeping a
 * live run's entry destroys data outright) of `clock.now()` — the pid-reuse
 * guard: an OS pid recycled onto an unrelated, currently-alive later process
 * cannot mask a genuine orphan past this window regardless of what
 * `process.kill` reports. `recoverOrphanedUserArtifacts` now accepts the
 * SAME `{clock}` seam `stageUserArtifacts` already does (default the real
 * `Date`) — never reads the wall clock directly. Every one of these checks
 * degrades toward NOT protecting (i.e. toward the pre-this-fix, always-
 * eligible-for-recovery behavior) rather than toward protecting forever: a
 * missing/non-numeric `runId` (an old record, or a hand-edited one) is never
 * treated as live, and an unparsable `timestamp` never grants indefinite
 * protection — see `parseOwnerPid`/`ownerStillLive`'s own doc comments.
 *
 * This closes the F1 residual as previously documented: recovery no longer
 * has any interleaving with a live peer run that can destroy that peer's
 * data. What remains, and is inherent to any liveness probe rather than a
 * gap in this specific check: a false "alive" reading (an unrelated process
 * reusing the crashed run's exact pid, itself started within the same
 * `OWNER_LIVENESS_GRACE_MS` window) delays that one orphan's recovery by up
 * to 5 minutes — never data loss, only a bounded delay, and exactly the
 * direction this guard is biased toward.
 *
 * Explicitly out of scope (40-design.md "Explicitly out of scope"): fsync
 * durability (crash-safe against process death only, not power loss);
 * routing the raw-`fs` uninstall wipe at call site 2
 * (`_runLegacyUninstallCleanup`) — only the staging call itself routes
 * through `installFs()` there, the surrounding wipe stays raw `fs` by
 * design (Phase 5 deliberately left the uninstall tree unrouted).
 */

import path from 'node:path';
import crypto from 'node:crypto';

// #2875: this module's own fs seam — see install-fs-adapter.cts's module doc
// for the ambient-adapter delivery mechanism this reuses unchanged.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs } = installFsAdapter;
// assertDestWithinConfigHome: the confinement decision this module reuses
// rather than reimplements (see module doc). Accessed via module ref at call
// time, matching install-engine.cts's own documented pattern for the same
// function, for test-stub compatibility.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactInstallPlan = require('./runtime-artifact-install-plan.cjs');
// copyPreservingSymlink: the symlink-safe copy primitive this module reuses
// rather than reimplements (see module doc "Symlink safety").
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installerMigrations = require('./installer-migrations.cjs');

/** Deterministic clock seam (repo convention — see e.g. research-store.cts):
 *  production code defaults to the real `Date` class; tests inject a fake via
 *  `node:test`'s `mock.timers` or a `{ now(): number }`-shaped double. Never
 *  read the wall clock directly. */
interface ClockLike {
  now(): number;
}

interface StageOptions {
  clock?: ClockLike;
  /** Discriminates concurrent RUNS staging the same `destDir` (module doc
   *  "Concurrency") — defaults to `String(process.pid)`, real-process
   *  identity, never faked by production code. Tests inject a distinct
   *  string here to simulate two concurrent runs without forking a real OS
   *  process, the same role `clock` plays for simulating time. Hashed, not
   *  used raw, when building the staging key — see `stagingKeyFor`. */
  runId?: string;
}

/** Maps a staged file name to a DIFFERENT destination file name on restore —
 *  e.g. `dev-preferences.md` (staged) -> `gsd-dev-preferences.md` (restored),
 *  the legacy-to-flat-layout migration bin/install.js's Claude commands-install
 *  path performs. A name absent from `rename` restores under its own staged
 *  name (the common case — every other call site). */
interface RestoreOptions {
  rename?: Record<string, string>;
}

interface StagedUserArtifacts {
  /** Resolved absolute destDir this batch was staged from. */
  destDir: string;
  /** The stagingRoot the caller supplied — carried so restore/discard never
   *  need it threaded back in separately. */
  stagingRoot: string;
  /** Absolute path to this batch's staging entry dir (`<stagingRoot>/<key>/`). */
  entryDir: string;
  /** Absolute path to this batch's `files/` subdir. */
  filesDir: string;
  /** Absolute path to this batch's `record.json`. */
  recordPath: string;
  /** File names actually staged — a subset of the `fileNames` passed to
   *  `stageUserArtifacts` (files absent from `destDir` at stage time are
   *  never included — test-matrix A2). */
  names: string[];
}

interface StagingRecord {
  destDir: string;
  names: string[];
  timestamp: string;
  /** The staging `runId` (module doc "Concurrency"), carried RAW (not
   *  hashed) so `recoverOrphanedUserArtifacts` can tell a still-live owner
   *  from a genuine orphan (module doc "Owner-liveness guard"). Optional —
   *  a record written before this field existed, or hand-edited, omits or
   *  malforms it; that case is NEVER treated as "live forever" (see
   *  `parseOwnerPid`). */
  runId?: string;
}

interface RecoveredEntry {
  destDir: string;
  name: string;
}

interface SkippedEntry {
  entryDir: string;
  reason:
    | 'destDir-outside-confinement'
    | 'destDir-symlink-escape'
    | 'files-symlink-escape'
    | 'dest-already-present'
    | 'recover-error'
    | 'entry-recovery-error'
    | 'owner-still-live';
  /** File name this row is about, when the failure is per-file rather than
   *  per-entry (`recover-error`). Absent for entry-level rows. */
  name?: string;
}

interface RecoveryResult {
  /** `{ destDir, name }` pairs actually restored to disk. */
  recovered: RecoveredEntry[];
  /** Staged entries found but not (fully) restored, with why. Never a throw
   *  — see module doc "Failure posture". */
  skipped: SkippedEntry[];
}

interface RecoveryOptions {
  clock?: ClockLike;
}

function stagingKeyFor(destDir: string, runId: string): string {
  const destHash = crypto.createHash('sha256').update(path.resolve(destDir)).digest('hex').slice(0, 16);
  // #2875 defect fix (test-matrix F1): hashed, not used raw — bounds the
  // discriminator's contribution to the entry-dir name and keeps it
  // filesystem-safe regardless of what a caller passes as `runId`, matching
  // the same treatment `destDir` already gets.
  const runHash = crypto.createHash('sha256').update(runId).digest('hex').slice(0, 8);
  return `${destHash}-${runHash}`;
}

// #2875 defect fix (test-matrix F1 residual — owner-liveness guard): the
// grace window past which a record is treated as orphaned REGARDLESS of
// whether `process.kill(pid, 0)` still reports the pid as alive — closes the
// pid-reuse gap (a crashed run's pid reassigned to an unrelated later
// process must not mask a genuine orphan forever). 5 minutes is a generous
// multiple of the codebase's own bound on a single install-tree operation
// (`npm` subprocess timeout convention is 60s — see this module's own
// "KNOWN DEFECTS" precedent in CLAUDE.md's "Unbounded Subprocesses" row);
// staging's own copy loop is a handful of small, flat, user-owned files, far
// cheaper than an `npm` call. The FAILURE DIRECTION is asymmetric by design
// (module doc "Owner-liveness guard"): skipping a real orphan for up to this
// long merely delays recovery — the bytes stay on disk — whereas sweeping a
// live run's entry destroys data outright, so this constant is deliberately
// generous rather than tight.
const OWNER_LIVENESS_GRACE_MS = 5 * 60 * 1000;

/**
 * Parses `runId` (raw, from an on-disk `record.json` — attacker/hand-edit
 * influenceable, same threat model as every other on-disk field this module
 * reads, module doc "Confinement") into a pid `process.kill` can safely take.
 * Returns `null` — never throws — for anything that is not a plain positive
 * integer string: absent (pre-this-fix record), the wrong type (a
 * hand-edited record could put a number, an object, anything), `"0"`
 * (`process.kill(0, ...)` signals the WHOLE process group, never a single
 * pid — deliberately excluded by the `[1-9]` leading-digit requirement), or
 * a negative/non-integer value (POSIX also treats a negative pid as a
 * process-GROUP signal). `null` here means "no liveness claim to evaluate"
 * — the caller falls back to unconditional recovery eligibility, the exact
 * pre-this-fix behavior, so an old or malformed record is never treated as
 * "live forever" (module doc "Owner-liveness guard").
 */
function parseOwnerPid(runId: unknown): number | null {
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/.test(runId)) return null;
  const pid = Number(runId);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * True when a process with this pid currently exists. `process.kill(pid, 0)`
 * sends no signal, only probes existence — throws `ESRCH` ("no such
 * process") when it is provably dead. Any OTHER outcome (`EPERM` — the
 * process exists but this process lacks permission to signal it; any other
 * platform quirk) is treated as "still alive" — the same NOT-sweeping bias
 * `parseOwnerPid`/`OWNER_LIVENESS_GRACE_MS` apply: an ambiguous liveness
 * result must never be read as license to sweep.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * True when `record` still belongs to a run recovery must leave entirely
 * alone (module doc "Owner-liveness guard") — a valid pid (`parseOwnerPid`),
 * that pid currently exists (`isProcessAlive`), AND the record is within
 * `OWNER_LIVENESS_GRACE_MS` of `clock.now()`. All three degrade toward
 * "not protected" (eligible for ordinary recovery, this function's existing
 * pre-this-fix behavior) rather than toward "protected forever": a missing
 * pid, a dead pid, or an unparsable/missing `timestamp` (already required
 * and validated elsewhere in this module, but re-checked here defensively)
 * all return `false`. The grace check is unconditional once a pid IS deemed
 * alive — a stale-but-apparently-live claim past the grace window is treated
 * as orphaned regardless (the pid-reuse guard).
 */
function ownerStillLive(record: StagingRecord, clock: ClockLike): boolean {
  const pid = parseOwnerPid(record.runId);
  if (pid === null) return false;
  if (!isProcessAlive(pid)) return false;
  const recordMs = Date.parse(record.timestamp);
  if (!Number.isFinite(recordMs)) return false;
  return clock.now() - recordMs < OWNER_LIVENESS_GRACE_MS;
}

/**
 * Lazily require install-engine.cjs's `hasExistingSymlinkBetween` /
 * `isSymlinkedDestOptIn` — see module doc "Confinement" for why this MUST be
 * a call-time `require`, not a static top-level import (a real circular
 * require: install-engine.cts imports this module statically).
 */
interface InstallEngineSymlinkGuard {
  hasExistingSymlinkBetween: (root: string, fullPath: string, options?: { allowOptInFollow?: boolean }) => boolean;
  isSymlinkedDestOptIn: () => boolean;
}

function _installEngineSymlinkGuard(): InstallEngineSymlinkGuard {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const mod: InstallEngineSymlinkGuard = require('./install-engine.cjs');
  return mod;
}

/** Flat names only — no path separator of either platform's flavor. See
 *  module doc "Never-overwrite (C2) and destination-symlink refusal". */
function isFlatName(name: string): boolean {
  return !name.includes('/') && !name.includes('\\');
}

/**
 * True when `p` has ANYTHING at all on disk — including a dangling symlink,
 * which `existsSync` reports as absent (see module doc). Used everywhere
 * this module must refuse to write over an existing destination rather than
 * trusting `existsSync`.
 */
function lstatPresent(p: string): boolean {
  try {
    installFs().lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `srcPath` to `destPath` without ever dereferencing a symlink — thin
 * wrapper over installer-migrations.cts's `copyPreservingSymlink`, routed
 * through the SAME `installFs()` adapter active for this call (ambient; see
 * install-fs-adapter.cts's module doc).
 */
function stagedCopy(srcPath: string, destPath: string): void {
  installerMigrations.copyPreservingSymlink(srcPath, destPath);
}

/**
 * Stage `fileNames` found in `destDir` to durable on-disk storage under
 * `stagingRoot`, BEFORE the caller wipes `destDir`.
 *
 * Absent files are skipped, never an error (A2). Throws on any real IO
 * failure — see module doc "Failure posture" (D4): callers MUST let this
 * propagate and abort before wiping `destDir`.
 *
 * `stagingRoot` itself is NOT re-confined here — callers own that (module
 * doc "Confinement").
 *
 * The staging entry dir is cleared FIRST (removed, then recreated) so a
 * repeat call for the same `destDir` FROM THE SAME RUN (same `runId`, the
 * default `process.pid` case — A6) never leaves files from a PRIOR batch
 * lingering alongside the new one — recovery and restore both iterate
 * `record.names` so stale leftovers were already inert, but a stale-free
 * staging tree is what an operator inspecting it on disk expects to see. A
 * DIFFERENT run's entry for the same `destDir` keys differently (module doc
 * "Concurrency") and is never touched by this clearing step.
 */
function stageUserArtifacts(destDir: string, fileNames: string[], stagingRoot: string, opts: StageOptions = {}): StagedUserArtifacts {
  const { clock = Date, runId = String(process.pid) } = opts;
  const key = stagingKeyFor(destDir, runId);
  const entryDir = path.join(stagingRoot, key);
  const filesDir = path.join(entryDir, 'files');
  const recordPath = path.join(entryDir, 'record.json');

  installFs().rmSync(entryDir, { recursive: true, force: true });
  installFs().mkdirSync(filesDir, { recursive: true });

  const stagedNames: string[] = [];
  for (const name of fileNames) {
    // #2875 defect fix: flat names only (module doc "Confinement") — a
    // caller passing a name with a path separator is a caller bug, hard-
    // throw matching this function's own "Failure posture" (D4), never a
    // silent skip.
    if (!isFlatName(name)) {
      throw new Error(`stageUserArtifacts: file name "${name}" must be a flat name — no path separator is allowed`);
    }
    const srcPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(destDir, name);
    if (!installFs().existsSync(srcPath)) continue; // A2: absent, not staged, no throw
    const destInStaging = runtimeArtifactInstallPlan.assertDestWithinConfigHome(filesDir, name);
    stagedCopy(srcPath, destInStaging);
    stagedNames.push(name);
  }

  // Commit point (A1/A7): written AFTER every copy lands. A crash before
  // this line leaves `filesDir` populated but recordless —
  // recoverOrphanedUserArtifacts treats that as incomplete, never a recovery
  // source (B4).
  const record: StagingRecord = {
    destDir: path.resolve(destDir),
    names: stagedNames,
    timestamp: new Date(clock.now()).toISOString(),
    // #2875 defect fix (F1 residual — owner-liveness guard): carried RAW so
    // a later recovery pass can tell a still-live owner from a genuine
    // orphan (module doc "Owner-liveness guard") — see `ownerStillLive`.
    runId,
  };
  installFs().writeFileSync(recordPath, JSON.stringify(record), 'utf8');

  return { destDir: record.destDir, stagingRoot, entryDir, filesDir, recordPath, names: stagedNames };
}

/**
 * Copy every staged file back into `destDir` (normally the SAME destDir the
 * batch was staged from, after the caller recreated it post-wipe).
 *
 * Deliberately does NOT discard the staged copy — kept a separate step
 * (`discardStagedUserArtifacts`) because not every call site restores
 * unconditionally (e.g. a migration call site restores only on migration
 * FAILURE, and wants the staged copy gone only once that decision is final).
 *
 * `opts.rename` restores a staged name under a DIFFERENT destination file
 * name (e.g. a legacy `dev-preferences.md` restored as
 * `gsd-dev-preferences.md`) — see `RestoreOptions`'s own doc comment. A name
 * absent from the map restores under its own staged name, unchanged.
 *
 * A name skips (never restores) if it is not a flat name (module doc
 * "Confinement"), or if `destPath` already has ANYTHING at it — including a
 * dangling symlink, which `existsSync` cannot see (module doc
 * "Never-overwrite (C2) and destination-symlink refusal", #2875 defect fix):
 * this function has no "already present, that's fine" semantics to fall
 * back on the way `recoverOrphanedUserArtifacts` does, so the safe,
 * degrade-not-throw choice is to refuse writing through whatever is already
 * there rather than silently following it.
 */
function restoreStagedUserArtifacts(destDir: string, staged: StagedUserArtifacts, opts: RestoreOptions = {}): void {
  const { rename = {} } = opts;
  for (const name of staged.names) {
    if (!isFlatName(name)) continue;
    const srcInStaging = runtimeArtifactInstallPlan.assertDestWithinConfigHome(staged.filesDir, name);
    if (!installFs().existsSync(srcInStaging)) continue;
    const destName = Object.prototype.hasOwnProperty.call(rename, name) ? rename[name] : name;
    if (!isFlatName(destName)) continue;
    const destPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(destDir, destName);
    // #2875 defect fix: refuse to write through a pre-existing symlink at
    // destPath (dangling or not) — copyFileSync/symlinkSync would otherwise
    // follow it and land content outside destDir.
    if (lstatPresent(destPath)) continue;
    installFs().mkdirSync(path.dirname(destPath), { recursive: true });
    stagedCopy(srcInStaging, destPath);
  }
}

/**
 * Remove a staging batch entirely. A staged copy is not a backup — see
 * module doc "Explicitly out of scope" / 40-design.md "Not-corruption".
 * Idempotent: a missing `entryDir` is a silent no-op (`force: true`),
 * matching every sibling best-effort cleanup in this codebase's install
 * tree.
 */
function discardStagedUserArtifacts(staged: StagedUserArtifacts): void {
  installFs().rmSync(staged.entryDir, { recursive: true, force: true });
}

/**
 * Find and restore every COMPLETE (record-committed) staging batch under
 * `stagingRoot` — batches orphaned by a crash between `stageUserArtifacts`
 * and the caller's own restore/discard.
 *
 * Never overwrites a present file (C2 — a file that IS there was not lost;
 * "present" is decided by `lstatSync`, not `existsSync`, so a dangling
 * symlink at the destination also counts as present — module doc
 * "Never-overwrite (C2) and destination-symlink refusal", #2875 defect fix).
 * Never throws, PERIOD: a missing `stagingRoot` (C5), a malformed/truncated
 * record (C6), a record naming a `destDir` outside `configDir` either
 * lexically or through a symlinked ancestor (E2), or ANY unanticipated
 * failure recovering one file or one whole batch (a `symlinkSync` `EPERM`
 * for an unprivileged Windows user, a staged `files/<name>` that turns out
 * to be a directory, an `mkdirSync`/`rmSync` failure) is reported via
 * `skipped` and the function moves on — to the next name, then to the next
 * staging entry — rather than propagating (#2875 defect fix: this contract
 * was previously false; `mkdirSync`/`stagedCopy`/the final `rmSync` were all
 * unguarded, so a single bad entry could throw out of this function
 * entirely, and because the throw happened before that entry was ever
 * cleaned up, it also permanently bricked every FUTURE install/uninstall —
 * this function is called as the very first step of both).
 *
 * Re-confinement (E2): the record's `destDir` is data, not policy — this
 * function never trusts it directly. `configDir` is a REQUIRED, EXPLICIT
 * parameter (not derived from `stagingRoot`'s own path shape — resting E2's
 * confinement guarantee on a path-naming convention would let a caller that
 * passes a differently-shaped `stagingRoot` silently get the wrong
 * confinement root, in either direction, which is exactly what E2 exists to
 * prevent). The recorded `destDir` is re-resolved through the SAME
 * `assertDestWithinConfigHome` every other write on this call tree uses
 * against the CALLER-SUPPLIED `configDir`, THEN through the SAME
 * `hasExistingSymlinkBetween` `_copyStaged`/`migrateLegacyDevPreferencesToSkill`
 * apply to their own writes (#2875 defect fix — `assertDestWithinConfigHome`
 * alone is pure lexical `path.resolve` string math and cannot see a
 * symlinked ANCESTOR directory between `configDir` and the recorded
 * `destDir`). A record naming a `destDir` outside it, lexically or via a
 * symlinked ancestor, is refused (`skipped`), never written.
 *
 * Callers MUST invoke this before the ordinary preserve step, from a
 * PRODUCTION entry point (test-matrix C7 — anti-inertness). Calling this
 * function directly and never wiring it into a real install path is exactly
 * the #1879-F15 inert-fix failure mode this module exists to avoid; see
 * bin/install.js's `install()`/`uninstall()` for the wiring.
 */
function recoverOrphanedUserArtifacts(stagingRoot: string, configDir: string, opts: RecoveryOptions = {}): RecoveryResult {
  const { clock = Date } = opts;
  const result: RecoveryResult = { recovered: [], skipped: [] };
  if (!installFs().existsSync(stagingRoot)) return result; // C5: no-op, no throw, no dir created

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = installFs().readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const configHome = path.resolve(configDir);
  const symlinkGuard = _installEngineSymlinkGuard();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryDir = path.join(stagingRoot, entry.name);
    // #2875 defect fix: the whole per-entry body is wrapped so nothing this
    // module did not anticipate can propagate out of the function — see the
    // doc comment above. A caught failure is reported once for the batch and
    // the loop proceeds to the NEXT entry; it is deliberately NOT swept
    // (matches the existing "malformed record left alone" precedent, C6) so
    // it remains available for inspection or a future recovery attempt.
    try {
      const recordPath = path.join(entryDir, 'record.json');
      if (!installFs().existsSync(recordPath)) continue; // B4: half-staged, not a recovery source

      let record: StagingRecord;
      try {
        const parsed = JSON.parse(installFs().readFileSync(recordPath, 'utf8')) as Partial<StagingRecord> | null;
        if (
          !parsed || typeof parsed !== 'object' ||
          typeof parsed.destDir !== 'string' ||
          !Array.isArray(parsed.names) ||
          !parsed.names.every((n) => typeof n === 'string')
        ) {
          continue; // C6: malformed shape, ignored — never a crash
        }
        record = parsed as StagingRecord;
      } catch {
        continue; // C6: corrupt/truncated JSON, ignored — never a crash
      }

      // #2875 defect fix (F1 residual — owner-liveness guard): checked
      // BEFORE any confinement resolution or write attempt — a still-live
      // owner's entry is left completely untouched, not merely un-swept
      // (module doc "Owner-liveness guard"): this run does not restore the
      // file to destDir on the live owner's behalf either, which would race
      // that owner's own still-in-progress wipe/restore cycle.
      if (ownerStillLive(record, clock)) {
        result.skipped.push({ entryDir, reason: 'owner-still-live' });
        continue;
      }

      const filesDir = path.join(entryDir, 'files');
      // #2875 defect fix (security — source-side symlink escape): every write
      // below reads FROM filesDir via a plain srcPath = filesDir/name join
      // (E3/E5 guard it against traversal/NUL, never against the `files`
      // PATH COMPONENT ITSELF being a symlink). record.json is data an
      // entryDir owner controls (module doc "Confinement" — same
      // attacker-influenceable-on-a-shared-machine threat E2 already treats
      // destDir against); a real `entryDir` whose `files` child is a symlink
      // to e.g. `/etc` or `/root/.ssh` would have its referent's bytes
      // dereferenced by the per-file `existsSync`/`stagedCopy` reads below,
      // landing victim-readable content at an attacker-named path inside
      // configDir. Reuse the SAME `hasExistingSymlinkBetween` guard the
      // dest side (E2) and every other write on this call tree already
      // applies, walked from entryDir (a real, non-symlinked directory —
      // `entry.isDirectory()` above already excludes a symlinked entryDir on
      // POSIX) to filesDir, BEFORE any name in `record.names` is read.
      // Per-file symlinks INSIDE files/ are untouched by this check and
      // remain legitimate (module doc "Symlink safety" — a symlinked staged
      // user artifact is expected and copied via copyPreservingSymlink,
      // never dereferenced).
      //
      // `allowOptInFollow` is hardcoded `false` here, NOT
      // `symlinkGuard.isSymlinkedDestOptIn()` — `GSD_ALLOW_SYMLINKED_DEST` is
      // documented (install-engine.cts `isSymlinkedDestOptIn`) as relaxing
      // only the destination-side "pre-existing symlink that points outside
      // configHome" refusal (the user asserting they own/trust a symlinked
      // WRITE destination, e.g. nix-darwin's `~/.claude` symlink). This is a
      // SOURCE read path — `entryDir`/`filesDir` is GSD-owned internal
      // staging state this module itself creates, never a user-authored
      // layout, so there is no legitimate opt-in case here. Honoring the
      // dest opt-in on this read would re-open exactly the escape this
      // guard exists to close: a `files` component symlinked to e.g.
      // `/root/.ssh` would be followed, and the per-file reads below would
      // dereference and copy the referent's bytes into configDir.
      if (symlinkGuard.hasExistingSymlinkBetween(entryDir, filesDir, { allowOptInFollow: false })) {
        result.skipped.push({ entryDir, reason: 'files-symlink-escape' });
        continue;
      }
      // #2875 defect fix (security — cwd-dependent confinement): a relative
      // `record.destDir` makes `path.relative(configHome, record.destDir)`
      // resolve the SECOND (relative) argument against `process.cwd()`
      // internally, not against `configHome` — the CLI's cwd at the moment
      // recovery runs, which an attacker who can plant a record.json does
      // not need to know or control to exploit (module doc "Confinement").
      // `stageUserArtifacts` (this module's own writer) always records an
      // ALREADY-`path.resolve`d, absolute `destDir` — a relative value here
      // only ever comes from a forged or hand-edited record, exactly the
      // untrusted-data case this function's confinement re-resolution
      // exists for. Refuse it the same way a lexically-escaping absolute
      // destDir is refused below, rather than let `path.relative` silently
      // reinterpret it against the wrong root.
      if (!path.isAbsolute(record.destDir)) {
        result.skipped.push({ entryDir, reason: 'destDir-outside-confinement' });
        continue;
      }
      let confinedDestDir: string;
      try {
        const relDest = path.relative(configHome, record.destDir);
        confinedDestDir = runtimeArtifactInstallPlan.assertDestWithinConfigHome(configHome, relDest);
      } catch {
        result.skipped.push({ entryDir, reason: 'destDir-outside-confinement' }); // E2 (lexical)
        continue;
      }
      // E2 (ancestor symlink): assertDestWithinConfigHome above is pure
      // lexical path math and does not see a symlinked ANCESTOR directory
      // between configHome and confinedDestDir — reuse the SAME guard every
      // other write on this call tree applies (module doc "Confinement").
      if (symlinkGuard.hasExistingSymlinkBetween(configHome, confinedDestDir, { allowOptInFollow: symlinkGuard.isSymlinkedDestOptIn() })) {
        result.skipped.push({ entryDir, reason: 'destDir-symlink-escape' }); // E2
        continue;
      }

      // #2875 defect fix: tracks whether ANY name in this batch hit a
      // genuine, unanticipated recovery error (as opposed to a deliberate,
      // accounted-for skip like "already present" or "rejected name") — see
      // the cleanup decision below.
      let anyGenuineFailure = false;
      for (const name of record.names) {
        // Per-FILE guard (#2875 defect fix): one bad name must not abort the
        // rest of the batch.
        try {
          if (!isFlatName(name)) continue; // flat names only — module doc "Confinement"
          let srcPath: string;
          let destPath: string;
          try {
            srcPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(filesDir, name);
            destPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(confinedDestDir, name);
          } catch {
            continue; // E3/E5: traversal or NUL byte in a staged name — reject that name
          }
          if (!installFs().existsSync(srcPath)) continue;
          // C2 (#2875 defect fix): lstatSync, not existsSync — existsSync
          // FOLLOWS symlinks and reports false for a DANGLING one, so it is
          // blind to exactly the case an attacker would plant at destPath to
          // bypass "never overwrite" (module doc).
          if (lstatPresent(destPath)) {
            result.skipped.push({ entryDir, reason: 'dest-already-present', name }); // C2: never overwrite
            continue;
          }
          installFs().mkdirSync(path.dirname(destPath), { recursive: true }); // C3: recreate a since-removed destDir
          stagedCopy(srcPath, destPath);
          result.recovered.push({ destDir: confinedDestDir, name });
        } catch {
          anyGenuineFailure = true;
          result.skipped.push({ entryDir, reason: 'recover-error', name }); // never throws — degrade per-file
        }
      }

      // #2875 defect fix: a batch with a genuine per-file failure is NEVER
      // swept — discarding the staging entry here would silently destroy the
      // only durable copy of a file this module could not otherwise recover,
      // exactly the loss this module exists to prevent. It is left in place
      // for a future recovery attempt or manual inspection, same as a
      // malformed record (C6) or a half-staged entry (B4). Only a batch that
      // is FULLY, DELIBERATELY accounted for (every name recovered, or
      // deliberately skipped because the destination already had something)
      // is removed — it is not a backup (module doc "Explicitly out of
      // scope"). Best-effort: a failure performing the removal itself (rare
      // — permissions, a Windows symlink-cleanup edge case) is swallowed
      // rather than propagated; the entry is left for a future run.
      if (anyGenuineFailure) continue;
      try {
        installFs().rmSync(entryDir, { recursive: true, force: true });
      } catch {
        // Intentionally swallowed — see comment above.
      }
    } catch {
      result.skipped.push({ entryDir, reason: 'entry-recovery-error' }); // never throws — degrade per-entry
    }
  }

  return result;
}

export = {
  stageUserArtifacts,
  restoreStagedUserArtifacts,
  discardStagedUserArtifacts,
  recoverOrphanedUserArtifacts,
  // #2875 defect fix: exported for a fast-check property test (CLAUDE.md
  // "Property-Based Testing" — parsers must carry at least one) — additive,
  // byte-identical for every existing caller of this module.
  parseOwnerPid,
};
