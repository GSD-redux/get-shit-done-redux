/**
 * Installer migrations engine — plan, apply, and track filesystem-mutation
 * migrations for GSD runtime config directories.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/installer-migrations.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  validateInstallerMigrationActions,
  validateInstallerMigrationRecord,
  type MigrationRecord,
  type MigrationAction,
} from './installer-migration-authoring.cjs';
import { platformWriteSync, retryRenameSync, posixNormalize } from './shell-command-projection.cjs';
import { realClock, type Clock } from './clock.cjs';

const MANIFEST_NAME = 'gsd-file-manifest.json';
const INSTALL_STATE_NAME = 'gsd-install-state.json';
const INSTALL_MIGRATION_LOCK_NAME = 'gsd-install-migration.lock';
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'installer-migrations');
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const STRICT_JSON = Symbol('strict-json');

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Copy a managed path for the rollback snapshot or the user-facing backup,
 * WITHOUT dereferencing a symlink.
 *
 * `fs.copyFileSync` follows symlinks, so a managed path that has been replaced
 * by a link (tampering, or an unexpected user layout) would have had the
 * LINK TARGET's bytes copied into `gsd-migration-journal/…-backups/` — e.g. a
 * `gsd.cjs` symlinked at `~/.ssh/id_rsa` would land that key's contents in the
 * backup tree. Nothing GSD installs is ever a symlink, so the faithful snapshot
 * of a symlinked managed path is the link itself: recreating it preserves
 * rollback fidelity (restore re-creates the same link) while never reading the
 * referent. Deletion was already safe — `fs.rmSync` unlinks the link, never the
 * target.
 *
 * Windows note: `fs.symlinkSync` can throw EPERM for unprivileged users. That
 * surfaces as an apply failure and triggers the normal rollback path, which is
 * the correct outcome — refusing to proceed beats silently copying referent
 * bytes.
 */
/**
 * Evaluate and, if safe, perform a `remove-empty-dir` action against `fullPath`.
 *
 * This is deliberately WEAKER than a recursive directory-removal primitive
 * (which 003's docblock records as an intentional absence in the ADR-0008
 * design): it only ever calls `fs.rmdirSync` — never `fs.rmSync`, never
 * `{ recursive: true }`, never `{ force: true }` — so a non-empty directory
 * fails the underlying syscall rather than being swept. The emptiness check
 * immediately above the call is what turns that failure mode into a
 * deliberate, non-error "left in place" outcome instead of surfacing ENOTEMPTY.
 *
 * Guards, in order:
 *   - lstat (not stat): a symlinked directory is refused outright, never
 *     followed. A missing target is reported distinctly so callers can tell
 *     "nothing was ever there" from "something was there and is left alone".
 *   - must actually be a directory (not a file masquerading under the relPath).
 *   - containment: the REALPATH of the target must resolve strictly inside the
 *     REALPATH of configDir — never equal to it (removing the config root
 *     itself is never in scope) and never escaping it (e.g. via an ancestor
 *     symlink the lstat check alone would not catch).
 *   - emptiness, re-checked here rather than trusted from planning time: a
 *     directory that still holds any entry (managed-but-undeleted, unknown,
 *     or created between plan and apply) is left in place. This is reported
 *     as 'skipped-not-empty', a successful no-op, not a failure.
 *
 * Any unexpected error along the way (EACCES, EBUSY, a race that removes the
 * target between the lstat and the rmdir, etc.) degrades to 'left-in-place'.
 * This action must never throw out of the executor, matching every sibling
 * action type's failure posture.
 */
function evaluateRemoveEmptyDir(configDir: string, fullPath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) return 'left-in-place';
  if (!stat.isDirectory()) return 'left-in-place';

  let resolvedRoot: string;
  let resolvedTarget: string;
  try {
    resolvedRoot = fs.realpathSync(configDir);
    resolvedTarget = fs.realpathSync(fullPath);
  } catch {
    return 'left-in-place';
  }
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    // Refuses both "target IS configDir" and "target escaped configDir".
    return 'left-in-place';
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(fullPath);
  } catch {
    return 'left-in-place';
  }
  if (entries.length > 0) return 'skipped-not-empty';

  try {
    fs.rmdirSync(fullPath);
    return 'removed';
  } catch {
    return 'left-in-place';
  }
}

function copyPreservingSymlink(srcPath: string, destPath: string): void {
  if (fs.lstatSync(srcPath).isSymbolicLink()) {
    // symlinkSync fails with EEXIST on an occupied path, so clear it first.
    // Scoped to this branch on purpose: the regular-file path below keeps
    // copyFileSync's overwrite-in-place, so a mid-restore failure cannot leave
    // the destination destroyed.
    fs.rmSync(destPath, { force: true });
    fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    return;
  }
  fs.copyFileSync(srcPath, destPath);
}

function readJsonIfPresent(filePath: string, fallback: unknown): unknown {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (fallback === STRICT_JSON) {
      throw new Error(`invalid installer migration state JSON: ${filePath}: ${(error as Error).message}`);
    }
    return fallback;
  }
}

interface InstallManifest {
  version: string | null;
  timestamp: string | null;
  mode: string | null;
  files: Record<string, string>;
}

function readInstallManifest(configDir: string): InstallManifest {
  const manifest = readJsonIfPresent(path.join(configDir, MANIFEST_NAME), null);
  if (!manifest || typeof manifest !== 'object') {
    return { version: null, timestamp: null, mode: null, files: {} };
  }
  const m = manifest as Record<string, unknown>;
  return {
    version: typeof m.version === 'string' ? m.version : null,
    timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
    mode: typeof m.mode === 'string' ? m.mode : null,
    files: m.files && typeof m.files === 'object' ? m.files as Record<string, string> : {},
  };
}

interface InstallState {
  schemaVersion: number;
  appliedMigrations: Array<Record<string, unknown>>;
}

function readInstallState(configDir: string): InstallState {
  const state = readJsonIfPresent(path.join(configDir, INSTALL_STATE_NAME), STRICT_JSON);
  if (!state || typeof state !== 'object') {
    return { schemaVersion: 1, appliedMigrations: [] };
  }
  const s = state as Record<string, unknown>;
  return {
    schemaVersion: typeof s.schemaVersion === 'number' ? s.schemaVersion : 1,
    appliedMigrations: Array.isArray(s.appliedMigrations) ? s.appliedMigrations as Array<Record<string, unknown>> : [],
  };
}

// Strict atomic write for the install state: must never be left half-written.
// Bypasses the seam because platformWriteSync falls back to a direct write on
// rename failure, which would silently violate this invariant.
function atomicWriteInstallState(configDir: string, content: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, INSTALL_STATE_NAME);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    retryRenameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

function writeInstallState(configDir: string, state: InstallState): InstallState {
  atomicWriteInstallState(configDir, JSON.stringify(state, null, 2) + '\n');
  return state;
}

interface ReadJsonResult {
  exists: boolean;
  value: unknown;
  error: Error | null;
}

function readJson(configDir: string, relPath: string): ReadJsonResult {
  const { fullPath } = ensureInsideConfig(configDir, relPath);
  if (!fs.existsSync(fullPath)) {
    return { exists: false, value: null, error: null };
  }
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(fullPath, 'utf8')), error: null };
  } catch (error) {
    return { exists: true, value: null, error: error as Error };
  }
}

function normalizeRelPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('migration action relPath must be a non-empty string');
  }
  const normalized = posixNormalize(relPath);
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
  }
  return segments.join('/');
}

interface ArtifactClassification {
  classification: string;
  originalHash: string | null;
  currentHash: string | null;
}

function classifyArtifact(configDir: string, relPath: string, manifest: InstallManifest): ArtifactClassification {
  const normalized = normalizeRelPath(relPath);
  const originalHash = manifest.files[normalized] || null;
  const fullPath = path.join(configDir, normalized);
  if (!fs.existsSync(fullPath)) {
    return { classification: originalHash ? 'managed-missing' : 'missing', originalHash, currentHash: null };
  }
  const currentHash = sha256File(fullPath);
  if (!originalHash) {
    return { classification: 'unknown', originalHash: null, currentHash };
  }
  if (currentHash === originalHash) {
    return { classification: 'managed-pristine', originalHash, currentHash };
  }
  return { classification: 'managed-modified', originalHash, currentHash };
}

function appliedMigrationIds(state: InstallState): Set<string> {
  return new Set(
    state.appliedMigrations
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => entry.id as string)
  );
}

function appliedMigrationEntries(state: InstallState): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>();
  for (const entry of state.appliedMigrations) {
    if (entry && typeof entry.id === 'string' && !entries.has(entry.id)) {
      entries.set(entry.id, entry);
    }
  }
  return entries;
}

function migrationChecksum(migration: MigrationRecord): string {
  const checksum = migration.checksum;
  if (typeof checksum === 'string' && checksum) return checksum;
  const serializable = {
    id: migration.id,
    title: migration.title || null,
    description: migration.description || null,
    introducedIn: migration.introducedIn || null,
    runtimes: migration.runtimes || null,
    scopes: migration.scopes || null,
    destructive: migration.destructive === true,
    runtimeContract: migration.runtimeContract || null,
    plan: typeof migration.plan === 'function' ? (migration.plan as (...args: unknown[]) => unknown).toString() : null,
  };
  return `sha256:${sha256Text(JSON.stringify(serializable))}`;
}

// Rewrite the stored checksum of any already-applied entry whose id drifted, so the
// drift is reconciled durably and not re-detected on every subsequent run (issue #670).
// Returns the number of entries actually changed (so callers know whether a write is needed).
function reconcileDriftedChecksums(
  appliedEntries: Array<Record<string, unknown>>,
  checksumDrift: Array<{ id: string; currentChecksum: string }> | undefined
): number {
  if (!Array.isArray(checksumDrift) || checksumDrift.length === 0) return 0;
  const reconcile = new Map(checksumDrift.map((d) => [d.id, d.currentChecksum]));
  let changed = 0;
  for (let i = 0; i < appliedEntries.length; i++) {
    const existing = appliedEntries[i];
    if (existing && typeof existing.id === 'string' && reconcile.has(existing.id)) {
      const next = reconcile.get(existing.id) as string;
      if (existing.checksum !== next) {
        appliedEntries[i] = { ...existing, checksum: next };
        changed += 1;
      }
    }
  }
  return changed;
}

function collectAppliedChecksumDrift(
  applied: Map<string, Record<string, unknown>>,
  migrations: MigrationRecord[]
): Array<{ id: string; storedChecksum: string; currentChecksum: string }> {
  const drift: Array<{ id: string; storedChecksum: string; currentChecksum: string }> = [];
  for (const migration of migrations) {
    const entry = applied.get(migration.id as string);
    if (!entry || !entry.checksum) continue;
    const currentChecksum = migrationChecksum(migration);
    if (entry.checksum !== currentChecksum) {
      // An already-applied migration is never re-run (it is filtered out of `pending`),
      // so a checksum drift here is functionally inert. A prior release may have edited a
      // shipped migration body (see issue #670). Surface it for reconciliation instead of
      // hard-aborting the user's upgrade.
      drift.push({
        id: migration.id as string,
        storedChecksum: entry.checksum as string,
        currentChecksum,
      });
    }
  }
  return drift;
}

function migrationMatchesContext(migration: MigrationRecord, { runtime, scope }: { runtime: string | null; scope: string | null }): boolean {
  if (Array.isArray(migration.runtimes) && (migration.runtimes as string[]).length > 0) {
    if (!runtime || !(migration.runtimes as string[]).includes(runtime)) return false;
  }
  if (Array.isArray(migration.scopes) && (migration.scopes as string[]).length > 0) {
    if (!scope || !(migration.scopes as string[]).includes(scope)) return false;
  }
  return true;
}

function discoverInstallerMigrations({ migrationsDir }: { migrationsDir: string }): MigrationRecord[] {
  if (!migrationsDir || !fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
    .map((entry) => entry.name)
    .sort()
    .flatMap((fileName) => {
      const source = path.join(migrationsDir, fileName);
       
      delete require.cache[require.resolve(source)];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported: unknown = require(source);
      const records = Array.isArray(exported) ? exported : [exported];
      return records.map((record) => validateInstallerMigrationRecord(record as MigrationRecord, source));
    });
}

function journalTimestamp(now: () => string): string {
  return now().replace(/[:.]/g, '-');
}

function migrationRunId(appliedAt: string): string {
  return `${journalTimestamp(() => appliedAt)}-${crypto.randomBytes(8).toString('hex')}`;
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * Check whether a given PID is alive on the current host.
 * Uses process.kill(pid, 0) which works on POSIX and Windows (Node's
 * implementation maps it to OpenProcess + GetExitCodeProcess on win32).
 * Returns true if alive or permission-denied (live but not ours),
 * false if ESRCH (no such process).
 */
function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // alive (or permission denied — treat as live)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface LockFileData {
  pid: number;
  acquiredAt: string;
}

/**
 * Try to read and parse the lock file JSON. Returns null on any error
 * (missing, invalid JSON, I/O failure).
 */
function readLockFile(lockPath: string): LockFileData | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).pid === 'number') {
      return parsed as LockFileData;
    }
    return null;
  } catch {
    return null;
  }
}

function acquireInstallMigrationLock(
  configDir: string,
  { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: { timeoutMs?: number } = {},
  clock: Clock = realClock,
): () => void {
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, INSTALL_MIGRATION_LOCK_NAME);
  const started = clock.now();

  while (true) {
    let fd: number | null = null;
    let lockCreatedByUs = false;
    try {
      fd = fs.openSync(lockPath, 'wx');
      // Close the open descriptor before writing so the file handle is
      // released on Windows before the release closure unlinks it.
      // Write payload via writeFileSync with the path (not the fd) so we
      // don't hold an open fd across the lifetime of the lock.
      fs.closeSync(fd);
      fd = null;
      lockCreatedByUs = true; // we own the file; clean it up on any subsequent error
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }) + '\n');
      lockCreatedByUs = false; // release closure owns cleanup from here
      return () => {
        const failures: Error[] = [];
        // Use unlinkSync (not rmSync with { force: true }) so EPERM errors
        // are NOT silently swallowed. On Windows, if the unlink fails
        // transiently, the error surfaces via releaseError so the caller
        // can observe and surface it rather than leaving a stale lock.
        try { fs.unlinkSync(lockPath); } catch (error) { failures.push(error as Error); }
        if (failures.length > 0) {
          const releaseError = new Error(`failed to release installer migration lock: ${lockPath}`) as Error & { failures: Error[] };
          releaseError.failures = failures;
          throw releaseError;
        }
      };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
        fd = null;
      } else if (lockCreatedByUs) {
        // fd was closed but writeFileSync threw before we returned the release
        // closure — the empty lock file is still on disk and must be removed
        // so it does not orphan as an unreadable (empty/invalid JSON) stale lock.
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
      }
      const err = error as NodeJS.ErrnoException;
      if (err && err.code === 'EEXIST') {
        // Stale-lock reclamation: read the on-disk PID and check liveness.
        // If the PID is dead (ESRCH) or is our own process (same-process
        // re-entry caused by rmSync silently swallowing an unlink error on
        // a previous call in the same invocation — the root cause of #3670),
        // reclaim the lock by removing the stale file and retrying.
        const lockData = readLockFile(lockPath);
        if (lockData !== null) {
          const holderPid = lockData.pid;
          const isSameProcess = holderPid === process.pid;
          const isDeadProcess = !isPidAlive(holderPid);
          if (isSameProcess || isDeadProcess) {
            // Reclaim: remove the stale lock and loop back to openSync.
            // Only continue (retry) when unlink actually succeeds — a silent
            // continue on reclaim failure recreates the original deadlock:
            // the lock stays on disk and we spin indefinitely.
            let reclaimed = false;
            try { fs.unlinkSync(lockPath); reclaimed = true; } catch { /* unlink failed — fall through to timeout path */ }
            if (reclaimed) continue;
          }
        }
        if (clock.now() - started >= timeoutMs) {
          const holderInfo = lockData ? ` (held by pid ${lockData.pid} since ${lockData.acquiredAt})` : '';
          throw new Error(`installer migration lock is held: ${lockPath}${holderInfo}`);
        }
        clock.sleep(Math.min(50, Math.max(1, timeoutMs - (clock.now() - started))));
        continue;
      }
      throw error;
    }
  }
}

interface EnsureInsideConfigResult {
  normalized: string;
  fullPath: string;
}

function ensureInsideConfig(configDir: string, relPath: string): EnsureInsideConfigResult {
  const normalized = normalizeRelPath(relPath);
  const fullPath = path.resolve(configDir, normalized);
  const root = path.resolve(configDir);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw new Error(`migration path escapes configDir: ${relPath}`);
  }
  return { normalized, fullPath };
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

interface JournalAction extends Record<string, unknown> {
  status: string;
}

function journalAction(action: MigrationAction, status: string, extras: Record<string, unknown> = {}): JournalAction {
  const { value: _value, ...safeAction } = action;
  return { ...safeAction, ...extras, status };
}

interface PlanContext {
  configDir: string;
  runtime: string | null;
  scope: string | null;
  manifest: InstallManifest;
  state: InstallState;
  baselineScan: boolean;
  now: () => string;
  classifyArtifact: (relPath: string) => ArtifactClassification;
  readJson: (relPath: string) => ReadJsonResult;
}

interface PlannedAction extends MigrationAction {
  migrationId: string;
  migrationChecksum: string;
  type: string;
  relPath: string;
  reason: string;
  classification: string;
  originalHash: string | null;
  currentHash: string | null;
  requestedType?: string;
  backupRelPath?: string | null;
  value?: unknown;
  deleteIfEmpty?: boolean;
  prompt?: unknown;
  choices?: unknown[];
}

interface MigrationPlan {
  generatedAt: string;
  manifest: InstallManifest;
  state: InstallState;
  pendingMigrationIds: string[];
  pendingMigrations: MigrationRecord[];
  actions: PlannedAction[];
  blocked: PlannedAction[];
  checksumDrift: Array<{ id: string; storedChecksum: string; currentChecksum: string }>;
}

function planInstallerMigrations({
  configDir,
  runtime = null,
  scope = null,
  migrations,
  baselineScan = false,
  now = () => new Date().toISOString(),
}: {
  configDir: string;
  runtime?: string | null;
  scope?: string | null;
  migrations: MigrationRecord[];
  baselineScan?: boolean;
  now?: () => string;
}): MigrationPlan {
  if (!configDir) throw new Error('configDir is required');
  if (!Array.isArray(migrations)) throw new Error('migrations must be an array');

  const manifest = readInstallManifest(configDir);
  const state = readInstallState(configDir);
  const validatedMigrations = migrations.map((migration) =>
    validateInstallerMigrationRecord(migration)
  );
  const scopedMigrations = validatedMigrations.filter((migration) =>
    migrationMatchesContext(migration, { runtime, scope })
  );
  const applied = appliedMigrationEntries(state);
  const checksumDrift = collectAppliedChecksumDrift(applied, scopedMigrations);
  const pending = scopedMigrations.filter((migration) => !applied.has(migration.id as string));
  const actions: PlannedAction[] = [];
  const blocked: PlannedAction[] = [];
  const classifications = new Map<string, ArtifactClassification>();
  const classify = (relPath: string): ArtifactClassification => {
    const normalized = normalizeRelPath(relPath);
    if (!classifications.has(normalized)) {
      classifications.set(normalized, classifyArtifact(configDir, normalized, manifest));
    }
    return classifications.get(normalized)!;
  };

  for (const migration of pending) {
    const planFn = migration.plan as (ctx: PlanContext) => unknown[];
    const plannedActions = planFn({
      configDir,
      runtime,
      scope,
      manifest,
      state,
      baselineScan,
      now,
      classifyArtifact: classify,
      readJson: (relPath) => readJson(configDir, relPath),
    });
    validateInstallerMigrationActions(plannedActions, migration);
    const checksum = migrationChecksum(migration);
    for (const rawAction of plannedActions as MigrationAction[]) {
      const relPath = normalizeRelPath(rawAction.relPath as string);
      const classification = rawAction.classification
        ? {
            classification: rawAction.classification as string,
            originalHash: rawAction.originalHash as string | null || null,
            currentHash: rawAction.currentHash as string | null || null,
          }
        : classify(relPath);
      let protectedType = rawAction.type as string;
      if (rawAction.type === 'remove-managed' && classification.classification === 'managed-modified') {
        protectedType = 'backup-and-remove';
      }
      if (rawAction.type === 'remove-managed' && classification.classification === 'unknown') {
        protectedType = 'preserve-user';
      }
      const action: PlannedAction = {
        migrationId: migration.id as string,
        migrationChecksum: checksum,
        type: protectedType,
        relPath,
        reason: rawAction.reason as string || migration.description as string || '',
        classification: classification.classification,
        originalHash: classification.originalHash,
        currentHash: classification.currentHash,
      };
      if (action.type !== rawAction.type) {
        action.requestedType = rawAction.type as string | undefined;
      }
      if (action.type === 'backup-and-remove') {
        action.backupRelPath = null;
      }
      if (action.type === 'rewrite-json') {
        action.value = rawAction.value;
        action.deleteIfEmpty = rawAction.deleteIfEmpty === true;
      }
      if (rawAction.prompt) action.prompt = rawAction.prompt;
      if (Array.isArray(rawAction.choices)) action.choices = rawAction.choices as unknown[];
      if (action.type === 'prompt-user') {
        blocked.push(action);
      } else if (
        action.classification === 'unknown' &&
        action.type !== 'rewrite-json' &&
        action.type !== 'record-baseline' &&
        action.type !== 'baseline-preserve-user'
      ) {
        blocked.push(action);
      }
      actions.push(action);
    }
  }

  return {
    generatedAt: now(),
    manifest,
    state,
    pendingMigrationIds: pending.map((migration) => migration.id as string),
    pendingMigrations: pending,
    actions,
    blocked,
    checksumDrift,
  };
}

function uniqueActionMigrationIds(actions: PlannedAction[]): string[] {
  return [...new Set(actions.map((action) => action.migrationId).filter(Boolean))];
}

interface RollbackArgs {
  configDir: string;
  journal: { actions: JournalAction[] };
  journalPath: string;
  rollbackRoot: string;
  backupRoot: string;
  previousInstallStateBytes: string | null;
}

function rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, backupRoot, previousInstallStateBytes }: RollbackArgs): void {
  const failures: Array<{ relPath: string; error: string }> = [];
  for (const action of [...journal.actions].reverse()) {
    if (!action.rollbackRelPath) continue;
    const rollbackPath = path.join(configDir, action.rollbackRelPath as string);
    const dest = path.join(configDir, action.relPath as string);
    try {
      // lstat-based existence check: a snapshot of a symlinked managed path is
      // itself a link, and existsSync() follows it — a link whose target is
      // gone would read as "missing" and silently skip the restore.
      if (fs.lstatSync(rollbackPath, { throwIfNoEntry: false })) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        copyPreservingSymlink(rollbackPath, dest);
      }
    } catch (error) {
      failures.push({ relPath: action.relPath as string, error: (error as Error).message });
    }
    if (action.backupRelPath) {
      try {
        fs.rmSync(path.join(configDir, action.backupRelPath as string), { force: true });
      } catch {
        // backup cleanup is best-effort; preserve restore failures above
      }
    }
  }

  try {
    if (previousInstallStateBytes === null) {
      fs.rmSync(path.join(configDir, INSTALL_STATE_NAME), { force: true });
    } else {
      atomicWriteInstallState(configDir, previousInstallStateBytes);
    }
  } catch (error) {
    failures.push({ relPath: INSTALL_STATE_NAME, error: (error as Error).message });
  }

  try {
    fs.rmSync(journalPath, { force: true });
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch {
    // journal cleanup is best-effort; the rollback above is the safety-critical part
  }

  if (failures.length > 0) {
    const error = new Error('migration rollback incomplete') as Error & { rollbackFailures: typeof failures };
    error.rollbackFailures = failures;
    throw error;
  }
}

function cleanupMigrationRunArtifacts(journalPath: string, rollbackRoot: string, backupRoot: string): void {
  try { fs.rmSync(journalPath, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

interface ApplyResult {
  appliedMigrationIds: string[];
  journalRelPath: string;
  rollback: () => void;
}

function applyInstallerMigrationPlan({
  configDir,
  plan,
  now = () => new Date().toISOString(),
}: {
  configDir: string;
  plan: MigrationPlan;
  now?: () => string;
}): ApplyResult {
  if (!configDir) throw new Error('configDir is required');
  if (!plan || !Array.isArray(plan.actions)) throw new Error('plan with actions is required');
  if (Array.isArray(plan.blocked) && plan.blocked.length > 0) {
    throw new Error(`migration plan has ${plan.blocked.length} blocked action(s)`);
  }

  const appliedAt = now();
  const runId = migrationRunId(appliedAt);
  const journalRelPath = path.posix.join('gsd-migration-journal', `${runId}.json`);
  const journalPath = path.join(configDir, journalRelPath);
  const rollbackRootRelPath = path.posix.join('gsd-migration-journal', `${runId}-rollback`);
  const rollbackRoot = path.join(configDir, rollbackRootRelPath);
  const backupRootRelPath = path.posix.join('gsd-migration-journal', `${runId}-backups`);
  const backupRoot = path.join(configDir, backupRootRelPath);
  const journal: { schemaVersion: number; appliedAt: string; appliedMigrationIds: string[]; actions: JournalAction[] } = {
    schemaVersion: 1,
    appliedAt,
    appliedMigrationIds: uniqueActionMigrationIds(plan.actions),
    actions: [],
  };
  const rollback: Array<{ relPath: string; rollbackPath: string }> = [];
  const installStatePath = path.join(configDir, INSTALL_STATE_NAME);
  const previousInstallStateBytes = fs.existsSync(installStatePath)
    ? fs.readFileSync(installStatePath, 'utf8')
    : null;

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    platformWriteSync(journalPath, JSON.stringify(journal, null, 2) + '\n');

    for (const action of plan.actions) {
      if (
        action.type !== 'remove-managed' &&
        action.type !== 'backup-and-remove' &&
        action.type !== 'rewrite-json' &&
        action.type !== 'record-baseline' &&
        action.type !== 'baseline-preserve-user' &&
        action.type !== 'remove-empty-dir'
      ) {
        throw new Error(`unsupported migration action type: ${action.type}`);
      }

      const { normalized, fullPath } = ensureInsideConfig(configDir, action.relPath);
      if (!fs.existsSync(fullPath)) {
        journal.actions.push(journalAction(action, 'missing'));
        continue;
      }

      if (action.type === 'record-baseline' || action.type === 'baseline-preserve-user') {
        journal.actions.push(journalAction(action, action.type === 'record-baseline' ? 'recorded' : 'preserved'));
        continue;
      }

      if (action.type === 'remove-empty-dir') {
        // Directory actions never enter the file-copy/rollback machinery below:
        // there is nothing to snapshot-and-restore for a directory node itself
        // (its former CONTENTS were already snapshotted by their own file-level
        // actions before this one runs), and rollback of a removed empty
        // directory is simply re-creating it, which the rollback path below
        // does not model. Non-recursive by construction (evaluateRemoveEmptyDir
        // only ever calls fs.rmdirSync), so there is nothing destructive to undo
        // beyond an mkdir the next install/migration run will happily redo.
        journal.actions.push(journalAction(action, evaluateRemoveEmptyDir(configDir, fullPath)));
        continue;
      }

      const rollbackPath = path.join(rollbackRoot, normalized);
      fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
      copyPreservingSymlink(fullPath, rollbackPath);
      rollback.push({ relPath: normalized, rollbackPath });

      if (action.type === 'rewrite-json') {
        if (action.deleteIfEmpty && isStructurallyEmpty(action.value)) {
          fs.rmSync(fullPath, { force: true });
          journal.actions.push(journalAction(action, 'removed', {
            rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
          }));
        } else {
          platformWriteSync(fullPath, JSON.stringify(action.value, null, 2) + '\n');
          journal.actions.push(journalAction(action, 'rewritten', {
            rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
          }));
        }
        continue;
      }

      if (action.type === 'backup-and-remove') {
        const backupRelPath = action.backupRelPath || path.posix.join(backupRootRelPath, normalized);
        const backupPath = path.join(configDir, backupRelPath);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        copyPreservingSymlink(fullPath, backupPath);
        journal.actions.push(journalAction(action, 'removed', {
          backupRelPath,
          rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
        }));
      } else {
        journal.actions.push(journalAction(action, 'removed', {
          rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
        }));
      }
      fs.rmSync(fullPath, { force: true });
    }

    platformWriteSync(journalPath, JSON.stringify(journal, null, 2) + '\n');

    const state = readInstallState(configDir);
    const applied = appliedMigrationIds(state);
    const nextApplied = [...state.appliedMigrations];
    reconcileDriftedChecksums(nextApplied, plan.checksumDrift);
    const actionsByMigrationId = new Map<string, PlannedAction>();
    for (const action of plan.actions) {
      if (action.migrationId && !actionsByMigrationId.has(action.migrationId)) {
        actionsByMigrationId.set(action.migrationId, action);
      }
    }
    for (const id of journal.appliedMigrationIds) {
      if (!applied.has(id)) {
        const action = actionsByMigrationId.get(id);
        nextApplied.push({
          id,
          appliedAt,
          journal: journalRelPath,
          checksum: action && action.migrationChecksum ? action.migrationChecksum : null,
        });
      }
    }
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: nextApplied,
    });

    return {
      appliedMigrationIds: journal.appliedMigrationIds,
      journalRelPath,
      rollback: () => rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, backupRoot, previousInstallStateBytes }),
    };
  } catch (error) {
    const rollbackFailures: Array<{ relPath: string; rollbackPath: string; error: string }> = [];
    for (const entry of rollback.reverse()) {
      const dest = path.join(configDir, entry.relPath);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // Symlink-preserving, same as the forward path: `entry.rollbackPath` is
        // itself a link whenever the managed path was one, so a raw copy here
        // would dereference it and write the referent's bytes back to the LIVE
        // install path — a worse leak than the journal-tree one, since it is
        // user-visible and at a predictable location.
        copyPreservingSymlink(entry.rollbackPath, dest);
      } catch (rollbackError) {
        rollbackFailures.push({
          relPath: entry.relPath,
          rollbackPath: entry.rollbackPath,
          error: (rollbackError as Error).message,
        });
      }
    }
    if (rollbackFailures.length > 0) {
      const rollbackError = new Error(`migration apply failed and rollback incomplete: ${(error as Error).message}`) as Error & { cause: unknown; rollbackFailures: typeof rollbackFailures };
      rollbackError.cause = error;
      rollbackError.rollbackFailures = rollbackFailures;
      throw rollbackError;
    }
    cleanupMigrationRunArtifacts(journalPath, rollbackRoot, backupRoot);
    throw error;
  }
}

function markPendingMigrationsApplied({
  configDir,
  plan,
  now = () => new Date().toISOString(),
}: {
  configDir: string;
  plan: MigrationPlan;
  now?: () => string;
}): string[] {
  if (!plan) return [];
  const hasPending = Array.isArray(plan.pendingMigrationIds) && plan.pendingMigrationIds.length > 0;
  const hasDrift = Array.isArray(plan.checksumDrift) && plan.checksumDrift.length > 0;
  if (!hasPending && !hasDrift) return [];

  const appliedAt = now();
  const state = readInstallState(configDir);
  const applied = appliedMigrationIds(state);
  const nextApplied = [...state.appliedMigrations];
  const reconciledCount = reconcileDriftedChecksums(nextApplied, plan.checksumDrift);

  const newlyApplied: string[] = [];
  if (hasPending) {
    const checksumsByMigrationId = new Map<string, string>();
    for (const migration of plan.pendingMigrations || []) {
      checksumsByMigrationId.set(migration.id as string, migrationChecksum(migration));
    }
    for (const id of plan.pendingMigrationIds) {
      if (applied.has(id)) continue;
      nextApplied.push({
        id,
        appliedAt,
        journal: null,
        checksum: checksumsByMigrationId.get(id) || null,
      });
      newlyApplied.push(id);
    }
  }

  if (newlyApplied.length > 0 || reconciledCount > 0) {
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: nextApplied,
    });
  }
  return newlyApplied;
}

interface RunResult {
  appliedMigrationIds: string[];
  journalRelPath: string | null;
  plan: MigrationPlan;
  blocked?: PlannedAction[];
  rollback?: () => void;
}

function runInstallerMigrations({
  configDir,
  runtime = null,
  scope = null,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  migrations = discoverInstallerMigrations({ migrationsDir }),
  baselineScan = false,
  now = () => new Date().toISOString(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
}: {
  configDir: string;
  runtime?: string | null;
  scope?: string | null;
  migrationsDir?: string;
  migrations?: MigrationRecord[];
  baselineScan?: boolean;
  now?: () => string;
  lockTimeoutMs?: number;
} = { configDir: '' }): RunResult {
  const releaseLock = acquireInstallMigrationLock(configDir, { timeoutMs: lockTimeoutMs });
  let primaryError: (Error & { suppressed?: Error[] }) | null = null;
  let completed = false;
  try {
    const plan = planInstallerMigrations({ configDir, runtime, scope, migrations, baselineScan, now });
    if (plan.actions.length === 0) {
      const newlyApplied = markPendingMigrationsApplied({ configDir, plan, now });
      completed = true;
      return {
        appliedMigrationIds: newlyApplied,
        journalRelPath: null,
        plan,
      };
    }
    if (plan.blocked.length > 0) {
      completed = true;
      return {
        appliedMigrationIds: [],
        journalRelPath: null,
        plan,
        blocked: plan.blocked,
      };
    }
    const result = applyInstallerMigrationPlan({ configDir, plan, now });
    completed = true;
    return { ...result, plan };
  } catch (error) {
    primaryError = error as Error & { suppressed?: Error[] };
    throw error;
  } finally {
    try {
      releaseLock();
    } catch (releaseError) {
      if (primaryError) {
        primaryError.suppressed = [...(primaryError.suppressed || []), releaseError as Error];
      } else if (completed) {
        throw releaseError;
      } else {
        throw releaseError;
      }
    }
  }
}

// Unused but kept to satisfy eslint — sleepSync is referenced in the original
// and may be used by test code that patches this module.
void sleepSync;

export = {
  DEFAULT_MIGRATIONS_DIR,
  INSTALL_MIGRATION_LOCK_NAME,
  INSTALL_STATE_NAME,
  MANIFEST_NAME,
  acquireInstallMigrationLock,
  applyInstallerMigrationPlan,
  classifyArtifact,
  discoverInstallerMigrations,
  evaluateRemoveEmptyDir,
  migrationChecksum,
  planInstallerMigrations,
  readInstallManifest,
  readInstallState,
  runInstallerMigrations,
  writeInstallState,
};
