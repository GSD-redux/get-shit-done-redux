/**
 * Planning Workspace — .planning path resolution + active workstream routing.
 *
 * This module owns the planning workspace seam:
 * - planningDir/planningRoot/planningPaths
 * - planning lock semantics
 *
 * Active workstream pointer policy/session identity lives in
 * active-workstream-store.cjs and is consumed here via thin adapters.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/planning-workspace.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
import { realClock } from './clock.cjs';
import type { Clock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import activeWorkstreamStore = require('./active-workstream-store.cjs');
const {
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  getActiveWorkstream: getStoredActiveWorkstream,
  peekActiveWorkstream: peekStoredActiveWorkstream,
  setActiveWorkstream: setStoredActiveWorkstream,
  clearActiveWorkstream: clearStoredActiveWorkstream,
  diagnoseUnresolvedActiveWorkstream: diagnoseUnresolvedStoredActiveWorkstream,
} = activeWorkstreamStore;

// Track .planning/.lock files held by this process so they can be removed on exit.
const _heldPlanningLocks = new Set<string>();
process.on('exit', () => {
  for (const lockPath of _heldPlanningLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------------
// Lock liveness probe (test seam) — audit M1
//
// mtime is a leaky proxy for "the holder is alive". The prior withPlanningLock
// timeout fallback unconditionally unlinked WHATEVER lock existed — even a fresh,
// live holder's — and re-acquired it, force-stealing a live writer's critical
// section. We backport capability-lock.cts's pid-liveness gate: a dead holder is
// stolen promptly inside the polite loop; a live holder is waited on. The
// indirection lets unit tests inject a deterministic isPidAlive without real pids.
// ---------------------------------------------------------------------------

/** Is `pid` a live process? process.kill(pid, 0) succeeds for a live (signalable) process. */
function _realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    // EPERM = process exists but we cannot signal it (still ALIVE). ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const _planningLockProbes: { isPidAlive: (pid: number) => boolean } = { isPidAlive: _realIsPidAlive };

function _planningLockIsPidAlive(pid: number): boolean {
  return _planningLockProbes.isPidAlive(pid);
}

// Test seam (PR #1532 review): beforeSteal fires AFTER the steal decision but BEFORE
// the identity re-confirm + atomic rename-steal, so a test can recreate a fresh lock
// in the decision→steal gap and prove the identity re-confirm aborts a double-steal.
// Defaults to a no-op; real callers are byte-for-behaviour unchanged.
interface PlanningLockTestHooks {
  beforeSteal?: (ctx: { lockPath: string }) => void;
}
const _planningLockTestHooks: PlanningLockTestHooks = {};

// Monotonic sequence for unique stale-steal rename targets (no crypto dependency).
let _planningStealSeq = 0;

/**
 * Is the holder recorded in the .lock body VERIFIED-LIVE? The body is JSON
 * { pid, cwd, acquired }. Returns true ONLY when the body parses AND the recorded
 * pid signals alive. A garbage / pid-less / unreadable body (or a dead pid) is NOT
 * verified-live, so the lock stays stealable — corrupt locks never block forever,
 * and a live holder is never force-stolen.
 */
function _planningHolderVerifiedLive(lockPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return false; // unreadable / unparseable body → cannot verify → not verified-live
  }
  const pid = (parsed as { pid?: unknown } | null)?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  return _planningLockIsPidAlive(pid);
}

// Transient errno codes that indicate a temporary filesystem condition under
// concurrent O_EXCL races — Docker overlay-fs (ENOENT/EINVAL/EIO), NFS
// (ESTALE), and OS-level interrupt/retry signals (EAGAIN/EINTR).  These are
// recoverable; withPlanningLock retries instead of propagating them.
// Truly fatal codes (EMFILE, ENOSPC, EROFS, EACCES) are NOT in this set and
// will still throw immediately.
const PLANNING_LOCK_RETRY_ERRNOS = new Set([
  'EPERM',   // Windows / macOS AV scanner holds the file open during delete
  'EBUSY',   // Windows: file in use by another process
  'EAGAIN',  // POSIX: resource temporarily unavailable
  'EINTR',   // POSIX: syscall interrupted by signal
  'EINVAL',  // Docker overlay-fs: transient during concurrent O_EXCL creation
  'EIO',     // Docker overlay-fs / NFS: transient I/O error
  'ENOENT',  // Docker overlay-fs: parent dir transiently missing during race
  'ESTALE',  // NFS: stale file handle (self-resolves on retry)
]);

// Loose opts type accepted by createPlanningWorkspace — passed through to
// active-workstream-store get/set/clear which accept { activeWorkstreamAdapter?,
// activeWorkstreamAdapters?, getStored? }. Using Record<string, unknown> is
// compatible with the structural type the store expects.
type WorkstreamAdapterOpts = Record<string, unknown>;

/**
 * #4257: the ONE owner of the env workstream discriminator `planningDir`
 * itself applies when handed no `ws` argument. `planningPaths(cwd)` — and
 * therefore every workstream-scoped `PlanningSnapshot` read — resolves its
 * base through exactly this read, and the CLI bootstrap has already folded
 * the stored active-workstream pointer into the env by the time any
 * diagnostic runs (`resolveActiveWorkstream` → `applyResolvedWorkstreamEnv`,
 * `active-workstream-store.cjs`). Exposed so a consumer that needs to NAME
 * the scope those reads used (W002's warning message, via the snapshot's
 * `workstream` field) derives it from the same resolution point instead of
 * growing a second env read site that can drift (the #612 PR-2
 * two-readers-two-bases lesson).
 */
function resolveEnvWorkstream(): string | null {
  return process.env['GSD_WORKSTREAM'] ?? null;
}

function planningDir(cwd: string, ws?: string | null, project?: string | null): string {
  if (project === undefined) project = process.env['GSD_PROJECT'] ?? null;
  if (ws === undefined) ws = resolveEnvWorkstream();

  // Reject path separators and traversal components in project/workstream names
  const BAD_SEGMENT = /[/\\]|\.\./;
  if (project && BAD_SEGMENT.test(project)) {
    throw new Error(`GSD_PROJECT contains invalid path characters: ${project}`);
  }
  if (ws && BAD_SEGMENT.test(ws)) {
    throw new Error(`GSD_WORKSTREAM contains invalid path characters: ${ws}`);
  }

  let base = path.join(cwd, '.planning');
  if (project) base = path.join(base, project);
  if (ws) base = path.join(base, 'workstreams', ws);
  return base;
}

function planningRoot(cwd: string): string {
  return path.join(cwd, '.planning');
}

/**
 * #3972: the ONE owner of "is this planning scope opted out of worktrees?" —
 * the effective `workflow.use_worktrees === false` read every
 * isolation-deciding surface must share (config-get's merged view is the
 * contract). Ladder: the scoped config's OWN key wins (planningDir is
 * project- and workstream-aware); otherwise the flat root's key, but only
 * under the GSD_WORKSTREAM env gate — config-get deliberately does NOT
 * inherit root under GSD_PROJECT alone, and this read must not diverge
 * (#3963). Strict `=== false` (never coerced); any read failure degrades to
 * "not opted out" (worktrees on — the fail-safe direction: the guard keeps
 * enforcing). Direct file reads only — never loadConfig, which normalizes
 * and rewrites config on paths that back sentinel writes.
 */
function worktreesOptedOut(cwd: string): boolean {
  // #3972 review: the WHOLE body is guarded — planningDir/planningRoot
  // themselves throw on a GSD_PROJECT/GSD_WORKSTREAM value containing path
  // separators or `..`, and this contract ("any failure degrades to not
  // opted out — worktrees on, keep enforcing") must hold for that shape too.
  try {
    return worktreesOptedOutUnguarded(cwd);
  } catch {
    return false;
  }
}

function worktreesOptedOutUnguarded(cwd: string): boolean {
  type MaybeConfig = { workflow?: unknown } | null;
  const readCfg = (p: string): MaybeConfig => {
    try {
      return JSON.parse(String(fs.readFileSync(p, 'utf8'))) as MaybeConfig;
    } catch {
      return null;
    }
  };
  const ownKey = (cfg: MaybeConfig): { present: boolean; value: unknown } => {
    if (cfg === null || typeof cfg !== 'object') return { present: false, value: undefined };
    const wf = cfg.workflow;
    if (wf === null || typeof wf !== 'object' || Array.isArray(wf)) return { present: false, value: undefined };
    const wfRec = wf as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(wfRec, 'use_worktrees')
      ? { present: true, value: wfRec['use_worktrees'] }
      : { present: false, value: undefined };
  };
  const scoped = ownKey(readCfg(path.join(planningDir(cwd), 'config.json')));
  if (scoped.present) return scoped.value === false;
  if (process.env['GSD_WORKSTREAM']) {
    const root = ownKey(readCfg(path.join(planningRoot(cwd), 'config.json')));
    if (root.present) return root.value === false;
  }
  return false;
}

/**
 * #612: resolve `phase_id_convention` with the SAME workstream->root federation
 * config-loader uses (config-loader.cts:618/:649) — the workstream config wins,
 * the root config is the fallback.
 *
 * Why this exists rather than `loadConfig(cwd)['phase_id_convention']`: as of
 * #2997 (aa7697fe, in `next`), loadConfig surfaces `phase_id_convention` in
 * its resolved `_baseConfig` — the "loadConfig drops keys it does not know"
 * rationale this comment used to give is stale. The surviving reasons for the
 * direct read are (1) the workstream->root federation below, a standalone
 * resolution this function needs to run against a GIVEN cwd rather than
 * whatever base a `loadConfig(cwd)` call elsewhere would federate from, and
 * (2) convention-ENUM validation, which is still #612 PR-4 work — this
 * function returns the raw string unvalidated, same as the now-surfaced
 * resolved key would. #2997 surfacing the key makes consuming it from
 * resolved config (instead of re-reading config.json here) a natural PR-4
 * consolidation, not this PR's scope. Cycles were never the obstacle.
 *
 * Why federation matters here specifically: the phase-id readers were splitting
 * on this value from two different bases — one resolving from the workstream
 * directory, one from the root — so a workstream repo got the widened ROADMAP
 * read with the narrow directory read, or the reverse, and reported every phase
 * either missing from disk or malformed on disk. One resolver, one answer.
 *
 * The workstream is `planningDir`'s own `ws` parameter, forwarded, so this
 * shares the canonical resolution (and its GSD_PROJECT/GSD_WORKSTREAM
 * handling). Root is consulted as a fallback only when a workstream is active,
 * matching config-loader; a project-scoped directory stands alone. Returns null
 * when unset, absent, or unreadable — every caller treats null as "not the
 * bracket convention".
 *
 * #2761 B1 (trek-e review): `ws` is a PARAMETER, not read from the environment
 * here. It was omitted at first on the reasoning that "the active workstream is
 * whatever planningDir resolves" — true only for the env-driven caller. A
 * caller that iterates workstreams passes the name as an ARGUMENT (it cannot
 * set `GSD_WORKSTREAM` per iteration), and `planningDir` falls back to the env
 * only when `ws` is `undefined`, so an argument-driven call resolved this
 * convention from the ROOT config while reading that workstream's ROADMAP. Two
 * consequences, both reproduced: a workstream that explicitly declares its OWN
 * convention had it ignored — the root's value decided how the workstream's
 * roadmap was parsed, so flipping ONLY the root config changed which milestone
 * a workstream extracted; and `--workstream foo` disagreed with
 * `GSD_WORKSTREAM=foo` on the same repo.
 *
 * `undefined` (the default) keeps `planningDir`'s env fallback, so every
 * pre-#2761 call site is byte-identical; `null` means "explicitly no
 * workstream". Same discriminator `planningDir` and `getMilestonePhaseFilter`
 * already carry.
 *
 * SCOPE: this governs the #612 bracket-selection reads ONLY. The shipped
 * milestone-prefixed W021 gate keeps its own root-only read — re-basing a
 * legacy convention's gate onto a different config is a behaviour change to a
 * shipped check, in both directions, and is not part of read tolerance.
 */
function resolvePhaseIdConvention(cwd: string, ws?: string | null): string | null {
  const readFrom = (dir: string): string | null => {
    const configPath = path.join(dir, 'config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const value = parsed['phase_id_convention'];
      return typeof value === 'string' && value !== '' ? value : null;
    } catch {
      return null;
    }
  };
  const scoped = planningDir(cwd, ws);
  const root = planningRoot(cwd);
  if (scoped === root) return readFrom(root);
  // Root is a fallback only when a WORKSTREAM is active — config-loader falls
  // back to the root config under `if (ws)` and not otherwise, so a
  // project-scoped directory stands alone. Detected by suppressing the
  // workstream segment rather than re-reading the environment.
  const projectOnly = planningDir(cwd, null);
  if (scoped === projectOnly) return readFrom(scoped);
  return readFrom(scoped) ?? readFrom(root);
}

// Sorted list of workstream directory names under `<root>/.planning/workstreams`,
// or `[]` when the project is flat (no workstreams dir). Single source of truth
// for the "workstream mode" detection shared by the #1912/#2028 fail-safe guards
// (init.progress, phase.complete) so the two paths cannot drift.
function listAvailableWorkstreams(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(planningRoot(cwd), 'workstreams'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface PlanningPaths {
  planning: string;
  state: string;
  roadmap: string;
  project: string;
  config: string;
  phases: string;
  requirements: string;
  debug: string;
  quick: string;
  todos: string;
}

// #2142: the quick-task directory. Exported as its own function (not only as a
// `planningPaths` key) because `audit.cts`'s `scanQuickTasks` receives an
// already-resolved planning base rather than a `cwd`, so it cannot reach
// `planningPaths`. Without this shared helper, adding the `quick` key would
// leave TWO composers of `<planning>/quick` — the DEFECT.GENERATIVE-FIX shape
// the `debug` key (#3149) was introduced to eliminate.
function quickDirFrom(planningBase: string): string {
  return path.join(planningBase, 'quick');
}

// #4256: the todos directory — deliberately ROOT-SCOPED, unlike every other
// planningPaths key. Todos are shared project state by construction: the
// migrateToWorkstreams contract keeps them among the shared files that "stay
// in place" at .planning/todos/ (workstream.cts), and every workflow writer
// writes that literal cwd-relative root path. The six todos readers
// previously hand-composed `path.join(planningDir(cwd), 'todos', ...)`,
// which silently re-scoped to .planning/workstreams/<ws>/todos/ — a
// directory nothing creates — under a workstream, so todos went invisible
// and audit-open passed the milestone-close gate vacuously. Same
// two-composers-of-one-path shape the `debug` (#3149) and `quick` (#2142)
// keys were introduced to eliminate (DEFECT.GENERATIVE-FIX).
//
// Exported as its own function pair (not only as a `planningPaths` key)
// because `audit.cts`'s `scanTodos`/`cmdAuditAcknowledge` consume an
// already-resolved todos base rather than a `cwd`, mirroring how #2142
// exported `quickDirFrom` for `scanQuickTasks`. `todosDir` takes NO ws/project
// parameter — todos have no workstream- or project-scoped form anywhere, so
// there is no discriminator to thread. This is also the single root #4327's
// future filename-containment guard should enforce against.
function todosDirFrom(planningBase: string): string {
  return path.join(planningBase, 'todos');
}

function todosDir(cwd: string): string {
  return todosDirFrom(planningRoot(cwd));
}

function planningPaths(cwd: string, ws?: string | null): PlanningPaths {
  const base = planningDir(cwd, ws);
  return {
    planning: base,
    state: path.join(base, 'STATE.md'),
    roadmap: path.join(base, 'ROADMAP.md'),
    project: path.join(base, 'PROJECT.md'),
    config: path.join(base, 'config.json'),
    phases: path.join(base, 'phases'),
    requirements: path.join(base, 'REQUIREMENTS.md'),
    // #3149: the debug-session directory. Single source for both `state.load`'s
    // `debug_dir` field and `init.debug`'s — previously each composed its own
    // `path.join(planning, 'debug')` (DEFECT.GENERATIVE-FIX).
    debug: path.join(base, 'debug'),
    // #2142: quick-task directory, composed via the shared quickDirFrom helper.
    quick: quickDirFrom(base),
    // #4256: todos directory — deliberately ROOT-scoped while the rest of
    // this record follows the active workstream/project (todos are shared
    // project state per the migrateToWorkstreams contract), composed via the
    // shared todosDir helper so this key and every direct caller agree.
    todos: todosDir(cwd),
  };
}

/**
 * @param cwd
 * @param fn - callback to run while holding the lock
 * @param clock
 *   Optional clock seam for testing. Defaults to realClock (Date.now + Atomics.wait).
 *   Pass a fake clock from tests/helpers/clock.cjs to drive timeout/stale logic
 *   without real wall-clock waits.
 */
function withPlanningLock<T>(cwd: string, fn: () => T, clock?: Clock): T {
  if (clock === undefined) clock = realClock;
  const lockPath = path.join(planningDir(cwd), '.lock');
  const lockTimeout = 10000; // 10 seconds
  // Deadman ceiling (audit M1 / R4-FIX) — set ABOVE lockTimeout so a holder that reads
  // as alive but is actually a pid-reuse alias (the .lock body has no startTime, so
  // liveness alone cannot detect reuse) is still recovered once its lock ages past this
  // absolute ceiling. Without it, a false-alive holder would make withPlanningLock throw
  // on every call with no self-heal. Mirrors acquireStateLock's deadmanCeilingMs.
  const deadmanCeilingMs = 60000;
  const start = clock.now();

  // Ensure .planning/ exists. A genuine failure here (EACCES/ENOSPC/EROFS/EMFILE)
  // MUST surface immediately: the prior `catch { /* ok */ }` swallowed it, the lock
  // write below then failed with ENOENT (parent dir missing), and ENOENT is retryable
  // (PLANNING_LOCK_RETRY_ERRNOS — added for a Docker overlay-fs race), so the loop
  // spun the full 10s budget and reported a PHANTOM "held by a live process"
  // contention pointing at a nonexistent holder (epic #1879 / F16, #1884).
  // `mkdirSync(recursive:true)` does not throw on an existing dir, so the normal
  // path (dir already present) is unaffected; only real creation failures propagate.
  platformEnsureDir(planningDir(cwd));

  function acquireLock(): void {
    // Atomic create — fails if file exists
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      cwd,
      acquired: new Date().toISOString(),
    }), { flag: 'wx' });

    _heldPlanningLocks.add(lockPath);
  }

  function runWithHeldLock(): T {
    try {
      return fn();
    } finally {
      _heldPlanningLocks.delete(lockPath);
      try { fs.unlinkSync(lockPath); } catch { /* already released */ }
    }
  }

  while (clock.now() - start < lockTimeout) {
    let lockWasAcquired = false;
    try {
      acquireLock();
      lockWasAcquired = true;
      return runWithHeldLock();
    } catch (err) {
      // Transient filesystem errors (Docker overlay-fs, NFS, OS signals, AV scanners)
      // are recoverable — wait and retry rather than propagating.
      // See PLANNING_LOCK_RETRY_ERRNOS for the full list and rationale.
      if (lockWasAcquired) throw err;
      const nodeErr = err as NodeJS.ErrnoException;
      if (PLANNING_LOCK_RETRY_ERRNOS.has(nodeErr.code ?? '')) {
        clock.sleep(100);
        continue;
      }
      if (nodeErr.code === 'EEXIST') {
        // Liveness-gated steal (audit M1). Steal the lock PROMPTLY only when its
        // recorded holder is NOT verified-live (crashed/dead pid or garbage body).
        // A verified-live holder is waited on — never force-stolen — because nuking
        // a slow-but-live writer's lock corrupts the .planning/ critical section.
        // The steal is an ATOMIC rename-then-recreate guarded by an identity re-confirm
        // so a racer that recreates a fresh lock in the decision→steal gap never has
        // its replacement deleted (audit M2 / PR #1532 review, window b). The body is
        // written atomically (writeFileSync …{flag:'wx'}) so there is no empty-body
        // create window here — only the double-steal needs hardening.
        try {
          const decisionStat = fs.statSync(lockPath);
          // Snapshot the decision-time body too: (dev, ino) alone is defeated by inode
          // REUSE (a racer's unlink+recreate can land on the same inode), so the body
          // content binds the identity as well — mirrors capability-lock.cts's (dev,
          // ino, ts) re-confirm.
          let decisionBody: string | null;
          try { decisionBody = fs.readFileSync(lockPath, 'utf-8'); } catch { decisionBody = null; }
          let stealable = !_planningHolderVerifiedLive(lockPath);
          if (!stealable) {
            // Verified-live, but recover anyway once the lock crosses the absolute
            // deadman ceiling — defeats a pid-reuse false-alive that would otherwise
            // block forever (R4-FIX; mtime age is from lock creation, not this call).
            const age = clock.now() - decisionStat.mtimeMs;
            stealable = age > deadmanCeilingMs;
          }
          if (stealable) {
            if (_planningLockTestHooks.beforeSteal) _planningLockTestHooks.beforeSteal({ lockPath });
            // Identity re-confirm immediately before the steal: a racer that stole +
            // recreated a fresh lock in the decision→steal gap changes (dev, ino) → do
            // NOT delete the replacement; back off and re-evaluate.
            let confirmStat: fs.Stats;
            try {
              confirmStat = fs.statSync(lockPath);
            } catch {
              continue; // vanished between decision and steal — retry the create.
            }
            let confirmBody: string | null;
            try { confirmBody = fs.readFileSync(lockPath, 'utf-8'); } catch { confirmBody = null; }
            const sameInstance =
              typeof decisionStat.dev === 'number' && typeof decisionStat.ino === 'number' &&
              confirmStat.dev === decisionStat.dev && confirmStat.ino === decisionStat.ino &&
              decisionBody !== null && confirmBody === decisionBody;
            if (!sameInstance) {
              clock.sleep(100); // a racer won the steal + recreated — re-evaluate, don't delete it.
              continue;
            }
            // Atomic steal: rename the inode aside, then remove it. Only ONE racer can
            // win the rename; a failed rename means another process already stole it, so
            // we must NOT fall through to a delete — back off and retry the create.
            const stolen = lockPath + '.stale-' + process.pid + '-' + clock.now() + '-' + (_planningStealSeq++);
            let renamed = false;
            try { retryRenameSync(lockPath, stolen); renamed = true; } catch { /* another racer won */ }
            if (renamed) {
              try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
              continue; // dead/garbage/expired holder freed — retry immediately to grab it.
            }
            clock.sleep(100); // lost the steal race — back off and retry.
            continue;
          }
        } catch { continue; }

        // Live holder — wait and retry (cross-platform, no shell dependency).
        clock.sleep(100);
        continue;
      }
      throw err;
    }
  }

  // Timeout against a holder still present at budget exhaustion. The polite loop
  // already stole any DEAD holder; reaching here means the holder is verified-live
  // (or a pid-reuse alias we must not corrupt). Do NOT force-steal — the prior
  // unconditional `unlinkSync(lockPath); acquireLock()` here (audit M1) robbed live
  // writers, and its re-acquire sat OUTSIDE any try so a concurrent re-create raced
  // a raw EEXIST out of the helper (audit M2). Surface a clear timeout error instead.
  const timeoutErr = new Error(
    'withPlanningLock: ' + lockPath + ' held by a live process for ' +
    (clock.now() - start) + 'ms (exceeded ' + lockTimeout + 'ms budget)'
  );
  (timeoutErr as unknown as Record<string, unknown>).lockTimeout = true;
  throw timeoutErr;
}

function createPlanningWorkspace(cwd: string, opts: WorkstreamAdapterOpts = {}): {
  paths: {
    dir(ws?: string | null, project?: string | null): string;
    root(): string;
    all(ws?: string | null): PlanningPaths;
  };
  activeWorkstream: {
    get(): string | null;
    set(name: string): void;
    clear(): void;
  };
} {
  return {
    paths: {
      dir(ws?: string | null, project?: string | null) {
        return planningDir(cwd, ws, project);
      },
      root() {
        return planningRoot(cwd);
      },
      all(ws?: string | null) {
        return planningPaths(cwd, ws);
      },
    },
    activeWorkstream: {
      get() {
        return getStoredActiveWorkstream(cwd, opts);
      },
      set(name: string) {
        setStoredActiveWorkstream(cwd, name, opts);
      },
      clear() {
        clearStoredActiveWorkstream(cwd, opts);
      },
    },
  };
}

function getActiveWorkstream(cwd: string): string | null {
  return getStoredActiveWorkstream(cwd);
}

// #3579 root-cause fix: read-only sibling of getActiveWorkstream, thin
// pass-through to active-workstream-store's non-mutating peek. Callers that
// only need to KNOW whether a workstream resolves (a guard's initial check,
// a bootstrap that will re-derive the answer anyway) must use this instead
// of getActiveWorkstream — the mutating variant self-heals (clears) a
// present-but-unresolvable chain[0] value, and a later read in the SAME
// process (another getActiveWorkstream call, or diagnoseUnresolvedActiveWorkstream)
// would then observe already-cleared state instead of the original evidence,
// silently changing the answer or losing the diagnostic reason. Self-heal
// still happens — exactly once, wherever the real consuming call site invokes
// getActiveWorkstream — this sibling just avoids triggering it prematurely.
function peekActiveWorkstream(cwd: string): string | null {
  return peekStoredActiveWorkstream(cwd);
}

function setActiveWorkstream(cwd: string, name: string): void {
  setStoredActiveWorkstream(cwd, name);
}

// #3579 item 1: read-only diagnostic sibling of getActiveWorkstream, thin
// pass-through to active-workstream-store's chain walk. Lets the #1912/#2028
// fail-safe guards (init.progress, phase.complete) distinguish "no marker at
// all" from "a marker exists but didn't resolve" without duplicating the
// resolution predicate.
function diagnoseUnresolvedActiveWorkstream(cwd: string): {
  present: boolean;
  value: string | null;
  reason: 'invalid_name' | 'missing_workstream_dir' | null;
} {
  return diagnoseUnresolvedStoredActiveWorkstream(cwd);
}

// #3579 item 1: human-readable clause for diagnoseUnresolvedActiveWorkstream's
// `reason`, shared by the init.progress and phase.complete fail-safe guards so
// the two error messages describe the same failure the same way instead of
// drifting (CLAUDE.md's Generative Fix Divergence anti-pattern).
function describeUnresolvedWorkstreamReason(reason: 'invalid_name' | 'missing_workstream_dir' | null): string {
  if (reason === 'invalid_name') return 'the name is not a valid workstream name';
  return "its workstream directory doesn't exist (it may have been renamed or removed)";
}

/**
 * Locate the CONTEXT.md file in a phase directory, handling both the bare
 * form (`CONTEXT.md`) and the padded-prefix convention (`NN-CONTEXT.md`,
 * `NN.N-CONTEXT.md`, etc.) used by gsd-discuss-phase output.
 *
 * Canonical dual-form predicate extracted here to eliminate the 5-site
 * duplication that previously existed across init.cjs, roadmap.cjs,
 * core.cjs, gap-checker.cjs (#3739).
 *
 * Two call shapes, two return shapes (#4014, epic #3473 B4-unreadable):
 *
 * - Array-input form (`files: string[]`, an already-read directory listing —
 *   avoids a redundant readdirSync at call sites that already hold one, and
 *   lets a caller pass an already phase-scoped listing): UNCHANGED —
 *   returns the matched filename or `null`, never throws (there is no I/O
 *   to fail on an in-memory array).
 * - Directory-string form (`absDir: string`): performs the `readdirSync`
 *   itself and returns `{ file, files, scope }` — `file`/`files` are the
 *   match and the raw listing, `scope` is `SCOPE.COMPLETE` on a successful
 *   read (including ENOENT, which is a genuine "nothing there yet" answer,
 *   not a failure) or `SCOPE.UNREADABLE` on any other read error
 *   (EACCES/EIO/…). This form never throws — a caller that used to see an
 *   exception on an unreadable directory now sees `scope: SCOPE.UNREADABLE`
 *   instead, so an unreadable phase dir is reported distinctly from a
 *   genuinely empty one rather than being silently indistinguishable from
 *   it (#1883's original defect this closes at the source).
 */
function findContextMdIn(files: string[]): string | null;
function findContextMdIn(absDir: string): { file: string | null; files: string[]; scope: Scope };
function findContextMdIn(
  absDirOrFiles: string | string[],
): string | null | { file: string | null; files: string[]; scope: Scope } {
  const matchIn = (files: string[]): string | null => {
    if (files.includes('CONTEXT.md')) return 'CONTEXT.md';
    return files.find((f: string) => f.endsWith('-CONTEXT.md')) ?? null;
  };

  if (Array.isArray(absDirOrFiles)) {
    return matchIn(absDirOrFiles);
  }

  try {
    const files = fs.readdirSync(absDirOrFiles);
    return { file: matchIn(files), files, scope: SCOPE.COMPLETE };
  } catch (err) {
    // #1883 / #4014: distinguish genuine absence from a permission/I-O
    // failure. ENOENT ("nothing there") keeps the long-standing "real empty"
    // contract callers rely on; every other error (EACCES, EIO, …) is a real
    // read failure — reported as SCOPE.UNREADABLE rather than thrown, so a
    // caller no longer needs its own try/catch to keep an unreadable phase
    // dir from being silently reported the same as "no CONTEXT.md".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: null, files: [], scope: SCOPE.COMPLETE };
    }
    return { file: null, files: [], scope: SCOPE.UNREADABLE };
  }
}

export = {
  worktreesOptedOut,
  createPlanningWorkspace,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  planningDir,
  planningRoot,
  resolveEnvWorkstream,
  resolvePhaseIdConvention,
  listAvailableWorkstreams,
  planningPaths,
  quickDirFrom,
  todosDirFrom,
  todosDir,
  withPlanningLock,
  getActiveWorkstream,
  peekActiveWorkstream,
  setActiveWorkstream,
  diagnoseUnresolvedActiveWorkstream,
  describeUnresolvedWorkstreamReason,
  findContextMdIn,
  // Test seam (audit M1): inject a deterministic isPidAlive so the liveness-gated
  // steal decision is exercised without real pids. Mirrors capability-lock.cts.
  _setLockProbes(probes: Partial<{ isPidAlive: (pid: number) => boolean }>): void {
    if (typeof probes.isPidAlive === 'function') _planningLockProbes.isPidAlive = probes.isPidAlive;
  },
  _resetLockProbes(): void {
    _planningLockProbes.isPidAlive = _realIsPidAlive;
  },
  // Test seam (PR #1532 review): script the steal decision→steal gap (window b).
  _setPlanningLockTestHooks(hooks: PlanningLockTestHooks): void {
    if ('beforeSteal' in hooks) _planningLockTestHooks.beforeSteal = hooks.beforeSteal;
  },
  _resetPlanningLockTestHooks(): void {
    delete _planningLockTestHooks.beforeSteal;
  },
};
