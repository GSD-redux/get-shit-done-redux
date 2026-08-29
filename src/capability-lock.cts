/**
 * Shared cross-process mutual-exclusion lock primitive — #1459 finding 4 + #1462 finding 1.
 *
 * A SINGLE hardened lockfile protocol shared by BOTH capability-lifecycle (the `.gsd/capabilities/.lock`
 * mutation lock) and capability-consent (the consent-store `.consent.lock`). Before this extraction the
 * two locks had DIFFERENT, divergent steal policies: the lifecycle lock was hardened (#1462 — pid +
 * process-start-time identity + hard deadman, never steals a verified-live same-host holder), while the
 * consent lock used a naive mtime-only 60 s steal that would STEAL A LIVE WRITER (a slow/paused holder
 * past 60 s is reclaimed; the original writer then resumes and overwrites — a lost update). Sharing one
 * primitive makes the consent lock as safe as the lifecycle lock (single source of truth — mirrors the
 * shared-validator / shared bounded-reader lessons).
 *
 * STEAL PROTOCOL (never deadlocks AND never steals a verified-live SAME-host holder). The age is bound
 * to the BODY instance the acquirer acts on — `age = now - body.ts` for a JSON body (a fresh replacement
 * body carries a fresh ts), falling back to `now - mtime` for a legacy/no-`ts` body — and the
 * (dev, ino, ts) identity is re-confirmed immediately before the atomic rename-steal:
 *   - age <= LOCK_STALE_MS                         → FRESH: never stolen (genuinely held → blocked).
 *   - age >  LOCK_STALE_MS:
 *       · SAME host: VERIFIED-LIVE (pid alive AND recorded startTime present AND observed startTime ===
 *         recorded) → NEVER steal (even past the deadman). NOT verified-live (dead pid, start-time
 *         MISMATCH = pid-reuse, or start-time unobtainable) → STEAL (fast local recovery).
 *       · DIFFERENT host / no parseable pid (legacy/oversized/garbage body) → liveness unverifiable →
 *         steal ONLY after age > LOCK_DEADMAN_MS (the deadman fallback).
 *
 * The lockfile body is UNTRUSTED: it is read via the shared fd-based bounded reader
 * (ledgerMod.readSmallRegularFile) so a FIFO/device/oversized body cannot block or read unbounded.
 *
 * Test seam: _setLockProbes / _resetLockProbes inject deterministic isPidAlive / getProcessStartTime so
 * the start-time liveness branches are exercised without depending on real OS pids beyond the current
 * process. capability-lifecycle re-exports these so its existing #1462 lock tests keep driving them.
 *
 * Imports: node:fs, node:path, node:os, node:crypto, and the ledger's shared bounded readSmallRegularFile
 * + execTool (for the rare start-time shell-out on win32/macOS).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* eslint-disable @typescript-eslint/no-require-imports */
const ledgerMod = require('./capability-ledger.cjs') as {
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
};
const { execTool, retryRenameSync } = require('./shell-command-projection.cjs') as {
  execTool: (
    program: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => { exitCode: number; stdout: string; stderr: string; signal: NodeJS.Signals | null; error: Error | null };
  retryRenameSync: (fromPath: string, toPath: string) => void;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A lock older than this is a CANDIDATE for stealing (the holder may have crashed). A same-host
 * lock past this age whose recorded pid is DEAD is stolen immediately (fast local recovery).
 */
const LOCK_STALE_MS = 60_000;
/**
 * HARD deadman timeout. A lock older than this is stolen REGARDLESS of pid liveness or host. This is
 * the only thing that can break a permanent deadlock caused by:
 *   - PID REUSE: a crashed holder's pid reused by an unrelated long-lived process makes isPidAlive
 *     return true forever, so the dead-pid fast-recovery branch never fires.
 *   - CROSS-HOST (NFS): a remote holder's pid is meaningless to local process.kill(pid,0), so liveness
 *     cannot be judged at all — only the deadman can reclaim such a lock.
 * Much larger than LOCK_STALE_MS so a genuinely slow-but-live SAME-host holder is given a wide grace
 * window (it is protected by the same-host liveness check until then); 10 minutes is far longer than
 * any real sub-second capability fs critical section.
 */
const LOCK_DEADMAN_MS = 600_000;
/**
 * The lockfile body is UNTRUSTED content. A well-formed lock body is a tiny JSON object. The body is
 * read via the shared fd-based bounded reader (open → fstat → require a REGULAR file → enforce this
 * size cap → read exactly size). A non-regular/oversized body is treated as UNPARSEABLE → routed to the
 * deadman policy (cannot verify liveness → steal only after the deadman). 64 KiB is orders of magnitude
 * larger than any legitimate lock body.
 */
const LOCK_MAX_BODY_BYTES = 64 * 1024;
/**
 * DEFAULT bounded steal/retry attempts so a pathological never-acquirable lock cannot recurse forever.
 * A caller may raise it (the consent store passes a larger budget — two genuinely-racing same-machine
 * consent writers must SERIALIZE, not fail, before the lock-acquire-failure throw kicks in #1459
 * finding 3). The lifecycle's sub-second critical section is happy with the small default.
 */
const LOCK_MAX_ATTEMPTS = 8;
const LOCK_RETRY_BACKOFF_MS = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A held lock: the lockfile path, the unique OWNER TOKEN we wrote into it, and the (dev, ino) of the
 * lockfile inode captured at acquire. releaseLock re-confirms BOTH the token AND the captured dev/ino
 * still match the path on disk immediately before rmSync, so a successor lock that replaced ours at the
 * same path (different inode) is never deleted. dev/ino are null when the post-create stat could not be
 * taken (best-effort) — then release falls back to the token check alone.
 */
interface LockHandle { path: string; token: string; dev: number | null; ino: number | null; }

/**
 * Parsed view of a lockfile body. `hostname` is null for a legacy lock (no hostname recorded) — treated
 * as SAME-host (conservative, backward compatible). `startTime` is the holder process's recorded
 * start-time; null for a legacy lock or one whose body did not record it — a null recorded start-time
 * cannot be matched, so liveness cannot be verified and the holder is treated as NOT verified-live.
 */
interface ParsedLock { pid: number | null; hostname: string | null; startTime: string | null; ts: number | null; }

/** Per-body IDENTITY used to confirm the lock being stolen is still the same instance just before steal. */
interface LockIdentity { dev: number | null; ino: number | null; ts: number | null; }

// ---------------------------------------------------------------------------
// Tokens + backoff
// ---------------------------------------------------------------------------

let _lockSeq = 0;
/**
 * A per-acquire unique token so release is owner-safe (never deletes a successor's lock). The FIRST
 * `-`-delimited segment is the holder PID — acquireLock parses it back out to check liveness before
 * stealing a stale lock.
 */
function newLockToken(): string {
  return `${process.pid}-${Date.now()}-${++_lockSeq}`;
}

let _lockSleepBuf: Int32Array | null = null;
function lockBackoff(): void {
  // Small jittered backoff between steal attempts (yields the thread via Atomics.wait).
  if (_lockSleepBuf === null) _lockSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  const jitter = Math.floor(Math.random() * LOCK_RETRY_BACKOFF_MS);
  Atomics.wait(_lockSleepBuf, 0, 0, LOCK_RETRY_BACKOFF_MS + jitter);
}

// ---------------------------------------------------------------------------
// Body parse / age / host
// ---------------------------------------------------------------------------

/**
 * Parse the holder PID from a legacy plain-token lockfile body (the first `-`-delimited segment).
 * Returns null when the body has no numeric leading segment (e.g. JSON content, or legacy no-pid).
 */
function lockHolderPid(body: string): number | null {
  const seg = body.split('-')[0];
  if (!/^\d+$/.test(seg)) return null;
  const pid = Number(seg);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Parse a lockfile body into { pid, hostname, startTime, ts }. The new format is JSON
 * `{ token, pid, hostname, startTime, ts }`; a legacy body is a plain `pid-ts-seq` token (or
 * non-numeric junk). Never throws — unparseable content yields all-null.
 *
 * `ts` is the body's OWN recorded timestamp. The age decision is bound to `now - ts` (a FRESH
 * replacement body carries a FRESH ts → small age → not stolen), NOT to the file `mtime`. A legacy/
 * no-`ts` body yields ts:null and the caller falls back to the file `mtime` age.
 */
function parseLockBody(body: string): ParsedLock {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed as Record<string, unknown>;
        const pidVal = p['pid'];
        const pid = typeof pidVal === 'number' && Number.isInteger(pidVal) && pidVal > 0 ? pidVal : null;
        const hostVal = p['hostname'];
        const hostname = typeof hostVal === 'string' && hostVal ? hostVal : null;
        const stVal = p['startTime'];
        const startTime = typeof stVal === 'string' && stVal ? stVal : null;
        const tsVal = p['ts'];
        const ts = typeof tsVal === 'number' && Number.isFinite(tsVal) ? tsVal : null;
        return { pid, hostname, startTime, ts };
      }
    } catch { /* fall through to legacy parse */ }
  }
  // Legacy plain-token body: hostname/startTime/ts were never recorded → null.
  return { pid: lockHolderPid(trimmed), hostname: null, startTime: null, ts: null };
}

/**
 * Derive the lock AGE (ms) from the body's own `ts` when trustworthy, else fall back to the file
 * `mtime`. A `ts` is distrusted when it is in the FUTURE (planted body / clock-skewed writer): a
 * trusted future `ts` would keep age <= LOCK_STALE_MS forever → permanent block. A future `mtime` is
 * likewise distrusted past a half-stale-window jitter tolerance → MAX_SAFE_INTEGER so the lock routes
 * into the normal steal decision tree (verified-live holders are still protected there).
 */
function lockAgeMs(ts: number | null, mtimeMs: number): number {
  if (ts !== null) {
    const age = Date.now() - ts;
    if (age >= 0 && age <= Number.MAX_SAFE_INTEGER) return age;
  }
  const mtimeAge = Date.now() - mtimeMs;
  if (mtimeAge >= 0) return mtimeAge;
  return mtimeAge >= -(LOCK_STALE_MS / 2) ? 0 : Number.MAX_SAFE_INTEGER;
}

/** Is the parsed lock from THIS host? A null (legacy) hostname is treated as same-host. */
function isSameHost(parsed: ParsedLock): boolean {
  return parsed.hostname === null || parsed.hostname === os.hostname();
}

// ---------------------------------------------------------------------------
// Process start-time (the pid-reuse discriminator)
// ---------------------------------------------------------------------------

/**
 * Best-effort process start-time for `pid`, as an OPAQUE platform-specific string used ONLY for
 * equality comparison (never parsed as a date). The pair (pid, startTime) uniquely identifies a
 * process instance: even if a crashed holder's pid is REUSED, the new process's start-time differs.
 * Returns null on ANY error / unobtainable value (liveness cannot be VERIFIED → steal-eligible past
 * the deadman). The shell-outs only run on the rare STEAL-decision path, never the happy path.
 */
function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen === -1) return null;
      const rest = stat.slice(rparen + 1).trim().split(/\s+/);
      const starttime = rest[19]; // overall field 22 → index 19 after comm.
      return typeof starttime === 'string' && /^\d+$/.test(starttime) ? starttime : null;
    }
    if (process.platform === 'win32') {
      const res = execTool(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.Ticks`],
        { timeout: 5_000 },
      );
      if (res.exitCode !== 0 || res.error) return null;
      const out = res.stdout.trim();
      return /^\d+$/.test(out) ? out : null;
    }
    const res = execTool('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000 });
    if (res.exitCode !== 0 || res.error) return null;
    const out = res.stdout.trim();
    return out ? out : null;
  } catch {
    return null;
  }
}

/** THIS process's start-time, captured ONCE at module load so we never re-shell on every lock write. */
const _selfStartTime: string | null = getProcessStartTime(process.pid);

/** Serialize the lockfile body: JSON carrying the owner token, pid, hostname, cached start-time, ts. */
function lockFileBody(token: string): string {
  return JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), startTime: _selfStartTime, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Liveness probes (test seam)
// ---------------------------------------------------------------------------

/** Is `pid` a live process? process.kill(pid, 0) succeeds for a live (signalable) process. */
function _realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    // EPERM means the process exists but we cannot signal it (still ALIVE). ESRCH means it's gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Test seams: the steal-decision path goes through these indirections so unit tests can mock liveness +
 * process start-time DETERMINISTICALLY. The defaults are the real implementations.
 */
const _lockProbes: {
  isPidAlive: (pid: number) => boolean;
  getProcessStartTime: (pid: number) => string | null;
} = { isPidAlive: _realIsPidAlive, getProcessStartTime };

function isPidAlive(pid: number): boolean {
  return _lockProbes.isPidAlive(pid);
}

/**
 * Is the recorded SAME-host holder VERIFIED-LIVE? True ONLY when ALL hold: the pid signals alive AND
 * the lock recorded a non-null start-time AND the pid's CURRENT observed start-time matches that
 * recorded value. Any failure — dead pid, no recorded start-time, unobtainable current start-time, or a
 * MISMATCH (= pid-reuse) — means NOT verified-live, so the holder may be stolen. This defeats pid-reuse
 * WITHOUT ever stealing a genuinely-live holder.
 */
function holderVerifiedLive(parsed: ParsedLock): boolean {
  if (parsed.pid === null) return false;
  if (!isPidAlive(parsed.pid)) return false;
  if (parsed.startTime === null) return false;
  const observed = _lockProbes.getProcessStartTime(parsed.pid);
  if (observed === null) return false;
  return observed === parsed.startTime;
}

// ---------------------------------------------------------------------------
// Bounded body read + identity recheck
// ---------------------------------------------------------------------------

/**
 * Parse the lockfile body via the SHARED fd-based bounded reader. The body is untrusted: a FIFO/device/
 * oversized/garbage body returns all-null (routed to the deadman policy). Never throws.
 */
function readParsedLockBounded(lockPath: string): ParsedLock {
  const allNull: ParsedLock = { pid: null, hostname: null, startTime: null, ts: null };
  try {
    const body = ledgerMod.readSmallRegularFile(lockPath, LOCK_MAX_BODY_BYTES);
    if (body === null) return allNull; // vanished/missing — cannot verify anything.
    return parseLockBody(body);
  } catch {
    return allNull; // non-regular / oversized / unreadable untrusted body → unparseable.
  }
}

/**
 * The per-body IDENTITY used to confirm, immediately before the atomic rename-steal, that the lock the
 * acquirer decided to steal is STILL the same body instance. Binds (dev, ino) from a fresh stat AND the
 * body's own `ts` (when JSON). A null on any field means we could not read it → caller treats it as
 * "changed" and retries rather than stealing. Never throws.
 */
function lockIdentity(lockPath: string): LockIdentity {
  let dev: number | null = null;
  let ino: number | null = null;
  try {
    const st = fs.statSync(lockPath);
    dev = typeof st.dev === 'number' ? st.dev : null;
    ino = typeof st.ino === 'number' ? st.ino : null;
  } catch {
    return { dev: null, ino: null, ts: null }; // vanished/unstatable — treat as changed.
  }
  const ts = readParsedLockBounded(lockPath).ts;
  return { dev, ino, ts };
}

/**
 * Two lock identities refer to the SAME body instance only when dev AND ino match AND the `ts` is
 * unchanged. A null dev/ino on EITHER side is a CHANGE (fail-safe: do not steal). If the DECISION body
 * had a non-null JSON `ts`, the recheck body MUST carry the SAME non-null `ts` (a disappearing ts is a
 * CHANGE → do not steal, retry).
 */
function sameLockInstance(a: LockIdentity, b: LockIdentity): boolean {
  if (a.dev === null || a.ino === null || b.dev === null || b.ino === null) return false;
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  if (a.ts !== null && a.ts !== b.ts) return false;
  return true;
}

/** Extract the owner token from a lockfile body (JSON `token` field), or null if not JSON/absent. */
function lockBodyToken(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as Record<string, unknown>)['token'];
      return typeof t === 'string' ? t : null;
    }
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock at `lockPath` (a single lockfile created with O_EXCL), stamping a JSON body
 * that records a unique owner token, our PID, our HOSTNAME, our process START-TIME, and a timestamp.
 * The containing directory is mkdir'd (recursive, best-effort). Returns a LockHandle on success, or
 * null if another LIVE operation holds it / the attempt budget is exhausted.
 *
 * `opts.maxAttempts` raises the bounded steal/retry budget (default LOCK_MAX_ATTEMPTS) so a caller with
 * legitimately-contended writers (the consent store) can SERIALIZE rather than fail under brief
 * contention. The budget is always bounded — no unbounded recursion.
 *
 * `opts.waitForFresh` (consent store) changes the BLOCKED-held disposition: when a held lock is NOT
 * steal-eligible (fresh under the stale window, a verified-live same-host holder, or an unverifiable
 * holder under the deadman), the DEFAULT (lifecycle) returns null IMMEDIATELY (fail-fast — the caller
 * does not retry). With waitForFresh the acquirer instead BACKS OFF AND RETRIES (within the bounded
 * budget) so two genuinely-racing same-machine writers SERIALIZE — the loser waits for the holder to
 * release its sub-ms critical section and then wins the O_EXCL create. It still returns null once the
 * budget is exhausted (then #1459 finding 3 turns that into a throw rather than an unlocked write). This
 * NEVER steals a non-steal-eligible holder — it only WAITS for it; the steal protocol is unchanged.
 *
 * The steal itself is atomic (rename-then-recreate, so only ONE racing process can rename the inode),
 * and the whole thing is a BOUNDED iterative loop.
 */
function acquireLock(lockPath: string, opts?: { maxAttempts?: number; waitForFresh?: boolean }): LockHandle | null {
  // A genuine failure here (EACCES/ENOSPC/EROFS) MUST surface immediately, matching the #1884
  // fix (0c43d853e / PR #3472) for withPlanningLock's identical shape. The prior
  // `catch { /* best-effort */ }` swallowed it, and the subsequent `fs.openSync(lockPath, 'wx')`
  // below then failed with ENOENT (parent dir missing) — which is NOT 'EEXIST', so the
  // `if (code !== 'EEXIST') return null;` branch laundered a fatal filesystem error into an
  // ordinary "lock unavailable" (null) result, indistinguishable from another live process
  // legitimately holding the lock (#3987). `mkdirSync(recursive:true)` does not throw when the
  // directory already exists, so the normal path (dir already present) is unaffected; only real
  // creation failures propagate.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const maxAttempts = (opts && Number.isInteger(opts.maxAttempts) && (opts.maxAttempts as number) > 0)
    ? (opts.maxAttempts as number)
    : LOCK_MAX_ATTEMPTS;
  const waitForFresh = !!(opts && opts.waitForFresh);
  // A held lock that is NOT steal-eligible: fail-fast (return null) by default, or BACK OFF + RETRY
  // (continue) when waitForFresh and a retry budget remains — so a contended consent writer serializes.
  const blocked = (attempt: number): LockHandle | null | 'retry' => {
    if (waitForFresh && attempt + 1 < maxAttempts) { lockBackoff(); return 'retry'; }
    return null;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = newLockToken();
    try {
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create — fails if held
      // Once the exclusive create SUCCEEDS, a writeSync/closeSync failure must NOT leave the empty
      // lockfile behind — an orphan body self-blocks every later acquirer until the deadman. On any
      // write/close error, best-effort unlink the file we just created and bail. fs.writeFileSync(fd, …)
      // flushes the WHOLE buffer (no short-write) unlike a bare fs.writeSync.
      try {
        fs.writeFileSync(fd, lockFileBody(token));
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw writeErr;
      }
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw closeErr;
      }
      // Capture the lock inode's (dev, ino) so releaseLock can confirm, immediately before rmSync, that
      // the path still holds OUR inode. Best-effort: a null dev/ino just falls back to the token check.
      let dev: number | null = null;
      let ino: number | null = null;
      try {
        const lst = fs.statSync(lockPath);
        dev = typeof lst.dev === 'number' ? lst.dev : null;
        ino = typeof lst.ino === 'number' ? lst.ino : null;
      } catch { /* best-effort — release falls back to the token check alone */ }
      return { path: lockPath, token, dev, ino };
    } catch (err) {
      // EEXIST → held (fall through to the steal decision). Any other error here is the create failing
      // for a real reason OR a write/close failure we already cleaned up → bail out.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    // Held — decide whether to steal.
    let st: fs.Stats;
    try {
      st = fs.statSync(lockPath);
    } catch {
      continue; // lock vanished between open and stat — retry the create immediately.
    }

    // Bind the age decision to the SAME body instance we act on. Parse the (bounded) body ONCE; derive
    // age from the body's own `ts` for a JSON body so a FRESH replacement (fresh ts) is seen as fresh
    // even if the file `mtime` is stale-old. A legacy/garbage/no-`ts` body — and a FUTURE/implausible
    // `ts` — falls back to the file `mtime` age so a planted/clock-skewed future ts can never deadlock.
    const parsed = readParsedLockBounded(lockPath);
    const age = lockAgeMs(parsed.ts, st.mtimeMs);
    if (age <= LOCK_STALE_MS) { // genuinely held (fresh) — blocked.
      const b = blocked(attempt);
      if (b === 'retry') continue;
      return b;
    }

    const decisionIdentity: LockIdentity = {
      dev: typeof st.dev === 'number' ? st.dev : null,
      ino: typeof st.ino === 'number' ? st.ino : null,
      ts: parsed.ts,
    };

    if (isSameHost(parsed) && parsed.pid !== null) {
      // SAME host with a parseable pid → we CAN verify liveness via the (pid, start-time) pair. A
      // VERIFIED-LIVE holder is NEVER stolen — even past the deadman. Otherwise → steal.
      if (holderVerifiedLive(parsed)) { // provably-live same-host holder — blocked.
        const b = blocked(attempt);
        if (b === 'retry') continue;
        return b;
      }
      // else fall through to the atomic steal.
    } else {
      // DIFFERENT host, or no parseable pid → liveness cannot be verified locally. Only the deadman can
      // reclaim it; under the deadman, leave it (blocked).
      if (age <= LOCK_DEADMAN_MS) {
        const b = blocked(attempt);
        if (b === 'retry') continue;
        return b;
      }
      // else (age > deadman) → fall through to the atomic steal.
    }

    // Re-stat + re-read the body IMMEDIATELY before the rename and confirm it is the SAME instance
    // (dev/ino unchanged AND, for a JSON body, ts unchanged). If a racer stole+recreated a FRESH lock
    // between our decision and now, the identity differs → do NOT steal; RETRY the bounded loop.
    if (!sameLockInstance(decisionIdentity, lockIdentity(lockPath))) {
      if (attempt + 1 < maxAttempts) lockBackoff();
      continue; // the body changed under us — re-evaluate from scratch rather than steal a replacement.
    }

    // Steal atomically (only one racer can rename the inode).
    const stolen = `${lockPath}.stale-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try { retryRenameSync(lockPath, stolen); } catch { return null; } // another process won the steal
    try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
    if (attempt + 1 < maxAttempts) lockBackoff();
  }
  return null; // attempt budget exhausted (pathological contention) — never throws/recurses.
}

/**
 * Release a lock only if it still carries our owner token (PRIMARY discriminator) — and, as a best-
 * effort SECONDARY check, if its inode still matches the (dev, ino) we captured at acquire, so the
 * common path never deletes a lock that was stale-stolen out from under us.
 *
 * The TOKEN re-check is the load-bearing protection: a real successor wrote a DIFFERENT token, so we
 * read a non-matching token and refuse to delete on every filesystem. The dev/ino recheck is best-
 * effort secondary hardening (may be defeated by inode reuse on some filesystems). The body is read via
 * the bounded reader so a FIFO/oversized body at the path is never read or deleted by us.
 */
function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  try {
    let body: string | null;
    try {
      body = ledgerMod.readSmallRegularFile(handle.path, LOCK_MAX_BODY_BYTES);
    } catch {
      return; // non-regular / oversized / unreadable → not ours; do not read or delete.
    }
    if (body === null) return; // gone / missing — nothing of ours to release.
    // The body is JSON `{ token, … }`; release only if the recorded token is still OURS. A legacy
    // plain-token body (whole body === token) is also honored.
    if (lockBodyToken(body) !== handle.token && body !== handle.token) return; // not our token (PRIMARY).
    if (handle.dev !== null && handle.ino !== null) {
      let cur: fs.Stats;
      try {
        cur = fs.statSync(handle.path);
      } catch {
        return; // vanished/unstatable between read and rmSync → nothing of ours to release.
      }
      if (cur.dev !== handle.dev || cur.ino !== handle.ino) return; // successor inode — not ours.
    }
    fs.rmSync(handle.path, { force: true });
  } catch { /* already gone / stale-stolen / unreadable — nothing of ours to release */ }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  acquireLock,
  releaseLock,
  getProcessStartTime,
  LOCK_STALE_MS,
  LOCK_DEADMAN_MS,
  LOCK_MAX_BODY_BYTES,
  // Test seams (shared by capability-lifecycle's #1462 lock tests via re-export): inject deterministic
  // isPidAlive / getProcessStartTime so the start-time liveness branches are exercised without real pids.
  _setLockProbes(probes: Partial<{ isPidAlive: (pid: number) => boolean; getProcessStartTime: (pid: number) => string | null }>): void {
    if (typeof probes.isPidAlive === 'function') _lockProbes.isPidAlive = probes.isPidAlive;
    if (typeof probes.getProcessStartTime === 'function') _lockProbes.getProcessStartTime = probes.getProcessStartTime;
  },
  _resetLockProbes(): void {
    _lockProbes.isPidAlive = _realIsPidAlive;
    _lockProbes.getProcessStartTime = getProcessStartTime;
  },
};
