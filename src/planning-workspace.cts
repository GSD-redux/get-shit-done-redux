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
import activeWorkstreamStore = require('./active-workstream-store.cjs');
const {
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  getActiveWorkstream: getStoredActiveWorkstream,
  setActiveWorkstream: setStoredActiveWorkstream,
  clearActiveWorkstream: clearStoredActiveWorkstream,
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

function planningDir(cwd: string, ws?: string | null, project?: string | null): string {
  if (project === undefined) project = process.env['GSD_PROJECT'] ?? null;
  if (ws === undefined) ws = process.env['GSD_WORKSTREAM'] ?? null;

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

  // Ensure .planning/ exists
  try { platformEnsureDir(planningDir(cwd)); } catch { /* ok */ }

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

function setActiveWorkstream(cwd: string, name: string): void {
  setStoredActiveWorkstream(cwd, name);
}

/**
 * Locate the CONTEXT.md file in a phase directory, handling both the bare
 * form (`CONTEXT.md`) and the padded-prefix convention (`NN-CONTEXT.md`,
 * `NN.N-CONTEXT.md`, etc.) used by gsd-discuss-phase output.
 *
 * Returns the filename (not the full path) of the first match, or null if
 * no CONTEXT.md exists in the directory.
 *
 * Canonical dual-form predicate extracted here to eliminate the 5-site
 * duplication that previously existed across init.cjs, roadmap.cjs,
 * core.cjs, gap-checker.cjs (#3739).
 *
 * @param absDirOrFiles - Absolute path to the phase directory,
 *   OR an already-read files array (avoids a redundant readdirSync at call sites
 *   that already hold a directory listing).
 */
function findContextMdIn(absDirOrFiles: string | string[]): string | null {
  try {
    const files = Array.isArray(absDirOrFiles)
      ? absDirOrFiles
      : fs.readdirSync(absDirOrFiles);
    if (files.includes('CONTEXT.md')) return 'CONTEXT.md';
    return files.find((f: string) => f.endsWith('-CONTEXT.md')) ?? null;
  } catch (err) {
    // #1883: distinguish genuine absence from a permission/I-O failure. ENOENT
    // ("nothing there") keeps the long-standing null contract the callers rely
    // on; every other error (EACCES, EIO, …) is a real read failure that must
    // propagate — otherwise an unreadable phase dir is silently reported as
    // "no CONTEXT.md" and the discuss/plan gates wrongly skip context.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export = {
  createPlanningWorkspace,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  planningDir,
  planningRoot,
  listAvailableWorkstreams,
  planningPaths,
  withPlanningLock,
  getActiveWorkstream,
  setActiveWorkstream,
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
