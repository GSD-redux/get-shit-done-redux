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
 *   <stagingRoot>/<sha256(destDir)-16>/record.json   — the commit point
 *   <stagingRoot>/<sha256(destDir)-16>/files/<name>  — copied, symlink-safe
 *
 * The sha256-of-destDir key (not a raw path) keeps the entry-dir name
 * filesystem-safe and makes staging the SAME destDir twice reuse/overwrite
 * the same entry rather than accumulating orphans (test-matrix A6).
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
 * other write on this call tree already uses, never a bespoke check. This
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
 * Symlink safety: staged files are copied via installer-migrations.cts's
 * `copyPreservingSymlink` (routed through `installFs()` by this same phase),
 * which never dereferences a symlink — a managed path replaced by a link to
 * (e.g.) `~/.ssh/id_rsa` cannot have the referent's bytes copied into the
 * staging tree, or back out of it on restore/recovery (test-matrix A4).
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
}

interface RecoveredEntry {
  destDir: string;
  name: string;
}

interface SkippedEntry {
  entryDir: string;
  reason: 'destDir-outside-confinement' | 'dest-already-present';
}

interface RecoveryResult {
  /** `{ destDir, name }` pairs actually restored to disk. */
  recovered: RecoveredEntry[];
  /** Staged entries found but not (fully) restored, with why. Never a throw
   *  — see module doc "Failure posture". */
  skipped: SkippedEntry[];
}

function stagingKeyFor(destDir: string): string {
  return crypto.createHash('sha256').update(path.resolve(destDir)).digest('hex').slice(0, 16);
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
 * repeat call for the same `destDir` (A6) never leaves files from a PRIOR
 * batch lingering alongside the new one — recovery and restore both iterate
 * `record.names` so stale leftovers were already inert, but a stale-free
 * staging tree is what an operator inspecting it on disk expects to see.
 */
function stageUserArtifacts(destDir: string, fileNames: string[], stagingRoot: string, opts: StageOptions = {}): StagedUserArtifacts {
  const { clock = Date } = opts;
  const key = stagingKeyFor(destDir);
  const entryDir = path.join(stagingRoot, key);
  const filesDir = path.join(entryDir, 'files');
  const recordPath = path.join(entryDir, 'record.json');

  installFs().rmSync(entryDir, { recursive: true, force: true });
  installFs().mkdirSync(filesDir, { recursive: true });

  const stagedNames: string[] = [];
  for (const name of fileNames) {
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
 */
function restoreStagedUserArtifacts(destDir: string, staged: StagedUserArtifacts, opts: RestoreOptions = {}): void {
  const { rename = {} } = opts;
  for (const name of staged.names) {
    const srcInStaging = runtimeArtifactInstallPlan.assertDestWithinConfigHome(staged.filesDir, name);
    if (!installFs().existsSync(srcInStaging)) continue;
    const destName = Object.prototype.hasOwnProperty.call(rename, name) ? rename[name] : name;
    const destPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(destDir, destName);
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
 * Never overwrites a present file (C2 — a file that IS there was not lost).
 * Never throws: a missing `stagingRoot` (C5), a malformed/truncated record
 * (C6), or a record naming a `destDir` outside `configDir` (E2) are all
 * reported via `skipped` or silently ignored.
 *
 * Re-confinement (E2): the record's `destDir` is data, not policy — this
 * function never trusts it directly. `configDir` is a REQUIRED, EXPLICIT
 * parameter (not derived from `stagingRoot`'s own path shape — resting E2's
 * confinement guarantee on a path-naming convention would let a caller that
 * passes a differently-shaped `stagingRoot` silently get the wrong
 * confinement root, in either direction, which is exactly what E2 exists to
 * prevent). The recorded `destDir` is re-resolved through the SAME
 * `assertDestWithinConfigHome` every other write on this call tree uses
 * against the CALLER-SUPPLIED `configDir`. A record naming a `destDir`
 * outside it is refused (`skipped`), never written.
 *
 * Callers MUST invoke this before the ordinary preserve step, from a
 * PRODUCTION entry point (test-matrix C7 — anti-inertness). Calling this
 * function directly and never wiring it into a real install path is exactly
 * the #1879-F15 inert-fix failure mode this module exists to avoid; see
 * bin/install.js's `install()`/`uninstall()` for the wiring.
 */
function recoverOrphanedUserArtifacts(stagingRoot: string, configDir: string): RecoveryResult {
  const result: RecoveryResult = { recovered: [], skipped: [] };
  if (!installFs().existsSync(stagingRoot)) return result; // C5: no-op, no throw, no dir created

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = installFs().readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const configHome = path.resolve(configDir);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryDir = path.join(stagingRoot, entry.name);
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

    const filesDir = path.join(entryDir, 'files');
    let confinedDestDir: string;
    try {
      const relDest = path.relative(configHome, record.destDir);
      confinedDestDir = runtimeArtifactInstallPlan.assertDestWithinConfigHome(configHome, relDest);
    } catch {
      result.skipped.push({ entryDir, reason: 'destDir-outside-confinement' }); // E2
      continue;
    }

    for (const name of record.names) {
      let srcPath: string;
      let destPath: string;
      try {
        srcPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(filesDir, name);
        destPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(confinedDestDir, name);
      } catch {
        continue; // E3/E5: traversal or NUL byte in a staged name — reject that name
      }
      if (!installFs().existsSync(srcPath)) continue;
      if (installFs().existsSync(destPath)) {
        result.skipped.push({ entryDir, reason: 'dest-already-present' }); // C2: never overwrite
        continue;
      }
      installFs().mkdirSync(path.dirname(destPath), { recursive: true }); // C3: recreate a since-removed destDir
      stagedCopy(srcPath, destPath);
      result.recovered.push({ destDir: confinedDestDir, name });
    }

    // The batch is fully accounted for — every name either restored or
    // explicitly left because the destination already had a file. Not a
    // backup, so removed either way (module doc "Explicitly out of scope").
    installFs().rmSync(entryDir, { recursive: true, force: true });
  }

  return result;
}

export = {
  stageUserArtifacts,
  restoreStagedUserArtifacts,
  discardStagedUserArtifacts,
  recoverOrphanedUserArtifacts,
};
