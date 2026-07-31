/**
 * Capability lifecycle orchestration — ADR-1244 Phase 4 (D5 trust enforcement + D6 upgrade).
 *
 * Composes the Phase-3 source resolver + ledger with the Phase-4 trust gate into the three
 * mutating operations — install, upgrade, remove — plus a reconciliation sweep that recovers
 * from a crash mid-upgrade. The LEDGER WRITE is the commit point for every operation: a crash
 * before it leaves the prior state fully intact; a crash after it is a completed operation.
 *
 * Trust invariants enforced here (see docs/explanation/capability-trust-model.md):
 *   - install/upgrade never execute capability code (resolver stages copy-only; we only swap
 *     directories and edit JSON);
 *   - executable surfaces are disclosed and consent is required before anything is promoted
 *     (decline => nothing written);
 *   - integrity + engines.gsd are verified by the resolver BEFORE staging finalizes;
 *   - remove deletes exactly the ledger-recorded files and surgically strips exactly the
 *     capability-owned shared-config entries (marker-isolated), touching nothing the user owns.
 *
 * Imports: node:fs, node:path, ./capability-source.cjs, ./capability-ledger.cjs,
 *          ./capability-trust.cjs, ./shell-command-projection.cjs (platformWriteSync).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* eslint-disable @typescript-eslint/no-require-imports */
const sourceMod = require('./capability-source.cjs') as {
  resolveCapabilitySource: (
    spec: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ id: string; version: string; stagedDir: string; integrity: string | null; source: string }>;
  parseSpec: (spec: string) => { kind: string; raw: string; target: string; ref?: string };
  // #1463 D6 "Update available?" per-source latest-version peek. NEVER throws — returns a status the
  // `outdated` aggregation maps onto a record. The exec seam mirrors the resolver's execOverrides.
  peekLatestVersion: (
    source: string,
    opts?: { execOverrides?: Record<string, unknown> },
  ) => { status: 'ok' | 'pinned' | 'manual' | 'unsupported' | 'unknown'; version: string | null; reason?: string };
};
const ledgerMod = require('./capability-ledger.cjs') as {
  readLedger: (runtimeDir: string) => LedgerFile | null;
  readLedgerStrict: (runtimeDir: string) => LedgerFile | null;
  writeLedger: (runtimeDir: string, ledger: LedgerFile) => void;
  recordInstall: (runtimeDir: string, entry: LedgerEntry, opts?: { baseLedger?: LedgerFile | null }) => void;
  removeEntry: (runtimeDir: string, capId: string) => boolean;
  reconcile: (runtimeDir: string) => unknown;
  isUnsafeCapabilityId: (id: unknown) => boolean;
  CorruptLedgerError: new (message: string, ledgerPath: string) => Error & { ledgerPath: string };
  LEDGER_FILE_NAME: string;
  MAX_SHARED_FILES: number;
  // Finding 2 (HIGH): the shared fd-based bounded reader. Returns the content, null for ENOENT, or
  // THROWS for a non-regular (FIFO/device/dir) / oversized / IO-error file (fail closed).
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
};
const trustMod = require('./capability-trust.cjs') as {
  evaluateInstallTrust: (args: Record<string, unknown>) => InstallTrustVerdict;
  discloseExecutableSurfaces: (manifest: Record<string, unknown>, stagedDir?: string) => Disclosure;
  executableSetChanged: (a: Disclosure, b: Disclosure) => boolean;
  evaluateSourceAllowed: (
    parsed: { kind: string; raw: string; target: string },
    strict: string[] | null | undefined,
  ) => { allowed: boolean; reason: string | null };
  // #1459: the consent-binding signature (single source of truth for loader + lifecycle).
  signatureForManifest: (manifest: Record<string, unknown>, stagedDir?: string) => string;
};
const consentMod = require('./capability-consent.cjs') as {
  recordProjectConsent: (args: { gsdHome?: string; projectRoot: string; id: string; integrity: string; disclosureSignature: string; contentHash: string; reviewerHost?: string }) => void;
  revokeProjectConsent: (args: { gsdHome?: string; projectRoot: string; id: string }) => void;
  /** #1459 CB-1/CB-2: recompute the full-bundle content hash (the consent security binding). */
  bundleContentHash: (capDir: string) => string;
  /** #1459 IC-05/WIN-2: resolve the consent store path for an unwritable-store warning message. */
  consentStorePath: (gsdHome?: string) => string;
};
const projectRootMod = require('./project-root.cjs') as {
  // #1459 IC-01/CB-4: the canonical consent project root (RECORD site parity with the loader LOOKUP).
  consentProjectRoot: (cwd: string) => string;
};
// #1459 finding 4: the SHARED hardened lock primitive (single source of truth for lifecycle + consent).
const lockMod = require('./capability-lock.cjs') as {
  acquireLock: (lockPath: string) => { path: string; token: string; dev: number | null; ino: number | null } | null;
  releaseLock: (handle: { path: string; token: string; dev: number | null; ino: number | null } | null) => void;
  getProcessStartTime: (pid: number) => string | null;
  _setLockProbes: (probes: Partial<{ isPidAlive: (pid: number) => boolean; getProcessStartTime: (pid: number) => string | null }>) => void;
  _resetLockProbes: () => void;
};
const { platformWriteSync, retryRenameSync } = require('./shell-command-projection.cjs') as {
  platformWriteSync: (filePath: string, content: string) => void;
  retryRenameSync: (fromPath: string, toPath: string) => void;
};
// #1463: numeric major.minor.patch comparison for the outdated check (the SAME compare the resolver
// and capability list use). -1 (a<b), 0 (equal), 1 (a>b).
const semverMod = require('./semver-compare.cjs') as {
  compareSemverCore: (a: unknown, b: unknown) => -1 | 0 | 1;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Types (mirrors of the Phase-3/4 module shapes we consume)
// ---------------------------------------------------------------------------

interface Disclosure {
  hooks: Array<{ event: string; script: string }>;
  // #1459 TRUST2-3: router (which exported fn runs) is part of the disclosed/consent-bound surface.
  commandModules: Array<{ family: string; module: string; router: string }>;
  // #1459: env (string→string) and cwd are part of the disclosed/consent-bound MCP surface; TRUST2-2
  // adds transport/url/headers for non-stdio servers; TRUST2-4 adds the raw args array.
  mcpServers: Array<{
    name: string;
    transport: string;
    command: string;
    argv: string[];
    rawArgs: unknown[];
    url: string;
    headers: Record<string, string>;
    env: Record<string, string>;
    cwd?: string;
  }>;
  hasExecutable: boolean;
  missingArtifacts: string[];
}

interface InstallTrustVerdict {
  allowed: boolean;
  requiresConsent: boolean;
  disclosure: Disclosure;
  engines: { compatible: boolean; range: string | null; satisfiedBy: 'engines' | 'compatVersions' | 'unconstrained' | null; downgradeTo?: string };
  blockReasons: string[];
}

interface LedgerEntry {
  id: string;
  version: string;
  source: string;
  integrity: string;
  files: string[];
  sharedEdits: Array<{ file: string; marker: string }>;
  /**
   * In-flight mutation intent. Written BEFORE the filesystem swap and cleared by the commit. Its
   * presence — NOT a version comparison — is the authoritative "operation did not finish" signal
   * for reconcileCapabilities (so a same-version malicious bundle cannot be mistaken for committed).
   *   kind 'install'  — fresh install (no prior bundle); rollback REMOVES the half-installed entry.
   *   kind 'upgrade'  — upgrade or reinstall over an existing bundle; rollback RESTORES the backup.
   */
  _pending?: { kind: 'install' | 'upgrade'; backupName: string | null; sharedFiles: string[] };
}

interface LedgerFile {
  version: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface LifecycleOptions {
  /** Scope root: holds .gsd/capabilities/<id>, the ledger, and shared config files. */
  runtimeDir: string;
  hostVersion: string;
  /**
   * #1459: the scope of this operation. A PROJECT-scope consented install/upgrade records a user
   * consent in the user-owned consent store (see consentStoreDir) and a remove revokes it; GLOBAL
   * scope (under the user's own home) records nothing. Defaults to 'project' when a consentStoreDir
   * is supplied (the conservative choice — bind consent unless explicitly global).
   */
  scope?: 'global' | 'project';
  /**
   * #1459: the USER-OWNED consent home (`GSD_HOME||homedir()`) where project-scope consent records
   * live — OUTSIDE any repo. When omitted, no consent record is written/revoked (back-compat for
   * callers that have not wired the consent store; the loader then leaves the project cap inactive).
   */
  consentStoreDir?: string;
  /** capabilities.strict_known_registries policy value. */
  strictKnownRegistries?: string[] | null;
  /** Whether the user has consented to executable surfaces (CLI/runtime edge supplies this). */
  consentGranted?: boolean;
  /** Expected integrity (sha512-...) to verify against the fetched artifact. */
  integrity?: string;
  /** Shared config files (relative to runtimeDir) to write capability hooks/mcpServers into. */
  sharedFiles?: string[];
  /** Injectable exec overrides, threaded to the resolver for tests. */
  execOverrides?: Record<string, unknown>;
  /** Also delete CAPABILITY_DATA on remove (default false — data is preserved/prompted). */
  removeData?: boolean;
  /**
   * When set, the resolved capability id MUST equal this or the operation is refused with NO writes.
   * `gsd capability update <id>` passes the requested id so a source that has been retargeted or
   * hand-edited to a different manifest id cannot silently act on (and overwrite) another capability.
   */
  expectedId?: string;
  /**
   * Test seam: override the source resolver. Must honor promote:false semantics — return a
   * staged dir (left on disk for the caller to promote/clean). Defaults to the real resolver.
   */
  _resolve?: (
    spec: string,
    opts: Record<string, unknown>,
  ) => Promise<{ id: string; version: string; stagedDir: string; integrity: string | null; source: string }>;
}

// ---------------------------------------------------------------------------
// Constants + path helpers
// ---------------------------------------------------------------------------

/** Stamp written onto every capability-owned shared-config entry, for surgical removal. */
const CAP_MARKER = '_gsdCapability';

/** Keys that must never be used as object indices (prototype-pollution guard). */
function isUnsafeKey(k: string): boolean {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function capabilitiesRoot(runtimeDir: string): string {
  return path.join(runtimeDir, '.gsd', 'capabilities');
}

function capDir(runtimeDir: string, id: string): string {
  return path.join(capabilitiesRoot(runtimeDir), id);
}

function capDataDir(runtimeDir: string, id: string): string {
  return path.join(runtimeDir, '.gsd', 'capability-data', id);
}

/** Errnos from a directory fsync that are tolerated (platforms/filesystems disallowing dir fsync). */
const DIR_FSYNC_TOLERATED_ERRNOS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF']);

/**
 * fsync a DIRECTORY so a rename inside it is durable across a power loss (DUR-2/DUR-3). Some
 * platforms/filesystems disallow fsync on a directory fd (EISDIR/EPERM/EINVAL/EBADF) — those are
 * tolerated (best-effort, swallowed). Finding 4: any OTHER errno (e.g. EIO — a real storage error)
 * is RETHROWN as a clear durability-uncertain error rather than silently swallowed; the rename may
 * already be visible, so the caller must NOT claim success when durability could not be confirmed.
 * The directory fd is always closed (finally).
 */
function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // openSync itself failing (e.g. dir vanished) is also non-fatal best-effort UNLESS it's a real
    // storage error; treat tolerated errnos (and a missing code) as best-effort, rethrow the rest.
    if (code !== undefined && !DIR_FSYNC_TOLERATED_ERRNOS.has(code)) {
      throw new Error(
        `Directory fsync of "${dirPath}" failed (${code}); durability of the preceding rename ` +
        `could NOT be confirmed: ${(err as Error).message}`,
      );
    }
    /* tolerated errno (or no code) — best-effort: a missing dir-fsync only weakens durability */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

/**
 * Build a collision-resistant backup-dir name for `id` (CONC-3). Two processes upgrading the same
 * capability in the same millisecond would otherwise produce identical `<id>.upgrading-<pid>-<ts>`
 * names; the random nonce eliminates that collision. The name still matches BACKUP_NAME_RE so a
 * recorded intent can find the backup after a crash.
 */
function newBackupName(id: string): string {
  return `${id}.upgrading-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Cross-process mutual exclusion
// ---------------------------------------------------------------------------

// The lock primitive is now a SHARED LEAF module (src/capability-lock.cts → capability-lock.cjs),
// used by BOTH this module and capability-consent (#1459 finding 4): one hardened steal protocol
// (pid + process-start-time identity + hard deadman; never steals a verified-live same-host holder)
// instead of two divergent ones. lockMod owns acquire/release; this module only computes the
// per-runtimeDir lock PATH and re-exports the test seams its #1462 lock tests drive.

// Non-lock orphan-sweep / id constants (kept local — not part of the shared lock primitive).
/** A `.staging/*` dir younger than this may belong to an in-flight resolve; do not sweep it. */
const STAGING_ORPHAN_MS = 600_000;
/** A `.gsd-capabilities.json.tmp.*` temp younger than this may belong to an in-flight write; spare it (W-3/DUR-5). */
const LEDGER_TMP_ORPHAN_MS = 300_000;
/** Valid capability id (kebab-case). Used to reject tampered ledger keys before acting on them. */
const KEBAB_ID_RE = /^[a-z][a-z0-9-]*$/;

type LockHandle = { path: string; token: string; dev: number | null; ino: number | null };

/**
 * Acquire the capability-mutation lock (the single `.gsd/capabilities/.lock` under runtimeDir),
 * delegating the hardened steal/liveness/deadman protocol to the shared lock primitive. The lockfile
 * path is the SAME as before extraction, so all existing #1462 lock tests (which key on a `.lock`
 * suffix and call lifecycle.acquireLock(runtimeDir)) keep passing unchanged.
 */
function acquireLock(runtimeDir: string): LockHandle | null {
  const root = capabilitiesRoot(runtimeDir);
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best-effort — lockMod also mkdirs */ }
  return lockMod.acquireLock(path.join(root, '.lock'));
}

/** Release a capability-mutation lock (shared primitive — token + inode owner-safe). */
function releaseLock(handle: LockHandle | null): void {
  lockMod.releaseLock(handle);
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'capability.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(file: string, obj: unknown): void {
  platformWriteSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Rm a ledger-recorded path only if its REAL location is strictly under runtimeDir's real path.
 *
 * Lexical containment alone is insufficient: a tampered ledger could record `.gsd/link/victim`
 * where `.gsd/link` is a symlink to `/`, and a lexical check would pass while the delete escapes
 * (Codex R1 H4). So we realpath the parent chain (defeating symlinked components) and `lstat` the
 * final component (a symlinked target is unlinked as a link, never followed into a recursive rm).
 *
 * Residual: a parent-chain symlink swapped in the window between the realpath check and the rm is a
 * classic TOCTOU. It is out of threat model here — both the ledger and runtimeDir are the user's own
 * trusted config tree, so an attacker who can tamper the ledger and win that race already has write
 * access to delete these files directly (no privilege boundary is crossed). The mutation lock also
 * serializes GSD's own operations, and the realpath check defeats the realistic persistent-symlink
 * vector.
 */
function safeRmUnder(runtimeDir: string, rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false;
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return false;
  let realRoot: string;
  try { realRoot = fs.realpathSync(runtimeDir); } catch { return false; }
  const target = path.resolve(realRoot, rel);
  let realParent: string;
  try { realParent = fs.realpathSync(path.dirname(target)); } catch { return false; }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return false;
  const realTarget = path.join(realParent, path.basename(target));
  let st: fs.Stats;
  try { st = fs.lstatSync(realTarget); } catch { return true; /* already gone — idempotent */ }
  try {
    if (st.isSymbolicLink()) fs.rmSync(realTarget, { force: true }); // unlink the link, don't follow
    else fs.rmSync(realTarget, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a shared-config file path RELATIVE to runtimeDir, confined to the scope root by realpath
 * (mirrors safeRmUnder). Rejects absolute paths, `..`, and any relFile whose existing parent
 * directory is a symlink escaping runtimeDir — so `--shared-file evil/x.json`, where `evil` is a
 * pre-planted symlink pointing outside the scope, can never write outside it. Returns the safe
 * absolute path, or null when the path is unsafe.
 */
function confinedSharedFile(runtimeDir: string, relFile: unknown): string | null {
  if (typeof relFile !== 'string' || !relFile || path.isAbsolute(relFile) || relFile.split(/[/\\]/).includes('..')) {
    return null;
  }
  let realRoot: string;
  try { realRoot = fs.realpathSync(runtimeDir); } catch { return null; }
  const target = path.resolve(realRoot, relFile);
  const parentDir = path.dirname(target);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // Parent does not exist yet (created inside the scope on write): a non-existent path cannot be a
    // symlink escaping the root, so a lexical containment check is sufficient.
    if (parentDir !== realRoot && !parentDir.startsWith(realRoot + path.sep)) return null;
    return target;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;
  return path.join(realParent, path.basename(target));
}

// #1460 (R) HIGH — shell-safe hook-script allowlist (mirrors capability-validator.cjs
// isSafeHookScriptPath; see confinedBundleScript for why). Only [A-Za-z0-9._/-], no leading
// `-` segment, no `..`, not absolute.
const SAFE_HOOK_SCRIPT_RE = /^[A-Za-z0-9._/-]+$/;
function isSafeHookScriptPath(script: string): boolean {
  if (typeof script !== 'string' || script.length === 0) return false;
  if (!SAFE_HOOK_SCRIPT_RE.test(script)) return false;
  if (path.isAbsolute(script)) return false;
  const segments = script.split(/[/\\]/);
  if (segments.includes('..')) return false;
  for (const seg of segments) {
    if (seg.startsWith('-')) return false;
  }
  return true;
}

/**
 * #1460 (R) HIGH: POSIX single-quote an arbitrary string for safe inclusion in a shell command.
 * The emitted hook `command` is the ABSOLUTE confined script path, which begins with the
 * (non-manifest) install-prefix — commonly a home dir containing spaces/special chars (e.g.
 * "/Users/Bob Smith/.claude/..."). Written unquoted it would word-split (and, with a hostile
 * prefix, could inject). Wrapping in single quotes — with each embedded `'` escaped as `'\''` —
 * makes the whole path a single shell token that no metacharacter inside it can break.
 */
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * #1634: build the emitted hook `command` for an ABSOLUTE confined script path. For `.js`-family
 * hooks (`.js`/`.cjs`/`.mjs`) prefix with `node` so the hook runs regardless of the source's
 * executable bit — a `git`/tarball source that lost `+x` would otherwise yield
 * `/bin/sh: Permission denied` on every matching call (defect #2). This mirrors first-party hooks
 * (`node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`). The path stays POSIX single-quoted (#1460 (R) HIGH)
 * so a space-containing install prefix cannot word-split or inject. Non-JS scripts (e.g. `.sh`)
 * keep the bare single-quoted absolute path (unchanged) — they remain responsible for their own
 * executability, exactly as before; per-runtime command projection is a separate concern (ADR-857 D8).
 */
const JS_HOOK_EXT_RE = /\.(?:js|cjs|mjs)$/;
function runnableHookCommand(absScript: string): string {
  return JS_HOOK_EXT_RE.test(absScript) ? 'node ' + shellSingleQuote(absScript) : shellSingleQuote(absScript);
}

/**
 * #1460 CONF-1: resolve a hook `script` (declared RELATIVE to the bundle) against the capability's
 * own install dir and CONFINE it via realpath, returning the ABSOLUTE confined path or null when it
 * escapes the bundle. Mirrors confinedSharedFile (realpath the FULL existing ancestor chain so an
 * ancestor symlink at any depth cannot escape) and capability-validator's materializeHookFragments
 * (resolve-against-capDir containment), but rooted at capDir rather than runtimeDir.
 *
 * Why this matters: the prior code wrote the RAW relative `script` as the hook command. At hook-exec
 * time a relative command resolves against the CWD, not the bundle — so it could execute an arbitrary
 * file, and a crafted relative path (or a symlinked subdir) could escape the bundle. Writing the
 * absolute confined path makes the hook always run the bundle's own file regardless of CWD.
 */
function confinedBundleScript(capDirPath: string, script: string): string | null {
  // Absolute paths and `..` segments are invalid script inputs (and rejected by the caller too).
  if (path.isAbsolute(script) || script.split(/[/\\]/).includes('..')) return null;

  // #1460 (R) HIGH (defense-in-depth): the confined ABSOLUTE path is written verbatim as a hook
  // `command` string that a host runtime consumes through a shell. A manifest-controlled script
  // name containing a shell metacharacter / whitespace / control char / leading "-" would inject a
  // second command — even though the file genuinely exists inside the bundle and so passes the
  // realpath confinement below. The validator already rejects such scripts at install/load time
  // (capability-validator.cjs isSafeHookScriptPath); we MIRROR the same conservative allowlist here
  // so applyCapabilitySharedEdits skips an unsafe script even if validation were somehow bypassed.
  if (!isSafeHookScriptPath(script)) return null;

  let realCapRoot: string;
  try {
    realCapRoot = fs.realpathSync(capDirPath);
  } catch {
    // capDir does not exist yet (e.g. applyCapabilitySharedEdits called before the bundle is on
    // disk): a non-existent root cannot be a symlink escaping itself, so confine lexically.
    realCapRoot = path.resolve(capDirPath);
    const targetLex = path.resolve(realCapRoot, script);
    if (targetLex !== realCapRoot && !targetLex.startsWith(realCapRoot + path.sep)) return null;
    return targetLex;
  }

  const target = path.resolve(realCapRoot, script);
  const parentDir = path.dirname(target);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // Parent does not exist yet (created inside the bundle): lexical containment is sufficient
    // because a non-existent path cannot be a symlink escaping the root.
    if (parentDir !== realCapRoot && !parentDir.startsWith(realCapRoot + path.sep)) return null;
    return target;
  }
  // The realpath'd parent chain must remain inside the bundle — an ancestor symlink escaping the
  // bundle is refused here (the symlink is followed by realpathSync, so its real location is checked).
  if (realParent !== realCapRoot && !realParent.startsWith(realCapRoot + path.sep)) return null;
  return path.join(realParent, path.basename(target));
}

// ---------------------------------------------------------------------------
// Atomic directory promotion (stage -> swap, backup retained for the caller)
// ---------------------------------------------------------------------------

/**
 * Promote a validated staging dir to its final location, setting the old bundle aside (if any)
 * into a backup that the CALLER removes only after the ledger commit. When `backupName` is given
 * (the upgrade path), the backup uses that exact name so a recorded intent can find it after a
 * crash; otherwise a fresh `.upgrading-<pid>-<ts>` name is generated. Returns the backup dir path
 * (or null when there was no prior bundle). On a failed swap the old bundle is restored.
 */
function promoteStagingToFinal(
  stagingDir: string,
  finalDir: string,
  backupName?: string,
): { backupDir: string | null } {
  // Both finalDir and the backup share this parent; fsyncing it makes each rename durable (DUR-3).
  const parent = path.dirname(finalDir);
  if (fs.existsSync(finalDir)) {
    const backupDir = backupName
      ? path.join(parent, backupName)
      // CONC-3: a random nonce in the unnamed-branch backup name prevents same-ms cross-process collision.
      : path.join(parent, newBackupName(path.basename(finalDir)));
    retryRenameSync(finalDir, backupDir);
    // DUR-3: fsync the parent dir so the old→backup rename is durable BEFORE the second rename —
    // a crash here must not lose the backup (the only recovery path for reconcile).
    fsyncDir(parent);
    try {
      retryRenameSync(stagingDir, finalDir);
    } catch (err) {
      try { retryRenameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
      throw err;
    }
    // DUR-3: fsync the parent dir again so the staging→final rename is durable too.
    fsyncDir(parent);
    return { backupDir };
  }
  fs.mkdirSync(parent, { recursive: true });
  retryRenameSync(stagingDir, finalDir);
  fsyncDir(parent); // DUR-3: durable fresh-install promotion.
  return { backupDir: null };
}

/**
 * The canonical shared-edit transition used by install, upgrade, AND reconcile: strip every entry
 * stamped with this capability's marker from `stripFiles`, then re-apply the capability's declared
 * surfaces (from `manifest`) into `applyFiles`. Centralized so the security-critical strip→apply
 * pair cannot diverge across the three callers. Returns the resulting sharedEdits records.
 */
function reapplyCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  stripFiles: string[];
  applyFiles: string[];
  manifest: Record<string, unknown>;
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, stripFiles, applyFiles, manifest } = args;
  if (stripFiles.length > 0) {
    stripCapabilitySharedEdits({ runtimeDir, capId, sharedEdits: stripFiles.map((file) => ({ file, marker: capId })) });
  }
  return applyCapabilitySharedEdits({ runtimeDir, capId, manifest, sharedFiles: applyFiles });
}

/**
 * Re-project a capability's shared-config edits to match its CURRENT on-disk bundle (strip the
 * marker across `sharedFiles`, re-apply from the on-disk manifest). Used by reconcile so that after
 * a roll-forward/back the shared config is consistent with whichever bundle won (Codex R1 H2).
 */
function resyncCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  sharedFiles: string[];
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, sharedFiles } = args;
  return reapplyCapabilitySharedEdits({
    runtimeDir,
    capId,
    stripFiles: sharedFiles,
    applyFiles: sharedFiles,
    manifest: readManifest(capDir(runtimeDir, capId)) ?? {},
  });
}

// ---------------------------------------------------------------------------
// Shared-config edits (marker-isolated)
// ---------------------------------------------------------------------------

/**
 * Write a capability's declared hooks/mcpServers into the given shared config files, stamping
 * every added entry with CAP_MARKER === capId so it can later be stripped surgically. Returns
 * the ledger `sharedEdits` records (one per file actually touched).
 *
 * Operates on the settings.json hook shape (`hooks[event][] = { hooks: [...] }`) and the
 * mcpServers map (`mcpServers[name] = {...}`), which covers the settings.json-family runtimes;
 * runtime-specific command resolution is layered in Phase 5.
 */
function applyCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  manifest: Record<string, unknown>;
  sharedFiles: string[];
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, manifest, sharedFiles } = args;
  const records: Array<{ file: string; marker: string }> = [];

  const hooks = Array.isArray(manifest['hooks']) ? (manifest['hooks'] as unknown[]) : [];
  const mcpRaw = manifest['mcpServers'];
  const mcpEntries: Array<{ name: string; config: unknown }> = [];
  if (mcpRaw && typeof mcpRaw === 'object') {
    if (Array.isArray(mcpRaw)) {
      for (const s of mcpRaw) {
        if (typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>)['name'] === 'string') {
          const rec = s as Record<string, unknown>;
          mcpEntries.push({ name: rec['name'] as string, config: rec['config'] ?? rec });
        }
      }
    } else {
      for (const [name, config] of Object.entries(mcpRaw as Record<string, unknown>)) {
        mcpEntries.push({ name, config });
      }
    }
  }

  if (hooks.length === 0 && mcpEntries.length === 0) return records;

  for (const relFile of sharedFiles) {
    const file = confinedSharedFile(runtimeDir, relFile);
    if (file === null) continue; // unsafe path (absolute / .. / symlink escaping the scope root)
    const settings = readJsonFile(file) ?? {};
    let touched = false;

    if (hooks.length > 0) {
      const hooksObj = (typeof settings['hooks'] === 'object' && settings['hooks'] !== null && !Array.isArray(settings['hooks']))
        ? (settings['hooks'] as Record<string, unknown>)
        : {};
      for (const h of hooks) {
        if (typeof h !== 'object' || h === null) continue;
        const rec = h as Record<string, unknown>;
        const event = typeof rec['event'] === 'string' ? rec['event'] : '';
        const script = typeof rec['script'] === 'string' ? rec['script'] : '';
        if (!event || !script || isUnsafeKey(event)) continue;
        // #1634: optional tool-scoping `matcher` (a settings.json concept — entry-level sibling of
        // `hooks`). Absent => match-all (field OMITTED so the existing shipped capabilities' wiring
        // is byte-for-byte unchanged, Hyrum's Law). The validator gates this to a non-empty string.
        const matcherRaw = rec['matcher'];
        const matcher = typeof matcherRaw === 'string' && matcherRaw.length > 0 ? matcherRaw : null;
        // #1460 CONF-1: resolve the declared (relative) script against the capability's OWN install
        // dir and CONFINE via realpath, then write the ABSOLUTE confined path as the hook command —
        // never the raw relative path (which would resolve against the CWD at hook-exec time and could
        // execute an arbitrary file). Absolute/`..` inputs and any script escaping the bundle (e.g.
        // through a symlinked subdir) return null and are SKIPPED, exactly as before.
        const absScript = confinedBundleScript(capDir(runtimeDir, capId), script);
        if (absScript === null) continue;
        // #1460 (R) HIGH + #1634: the hook `command` is consumed by a shell. `runnableHookCommand`
        // emits a `node`-prefixed POSIX-single-quoted absolute path for `.js`-family hooks (runs
        // without `+x`; mirrors first-party) and a bare single-quoted path otherwise. Single-quoting
        // keeps a space-containing install prefix as one shell token (cannot word-split or inject).
        const command = runnableHookCommand(absScript);
        const arr = Array.isArray(hooksObj[event]) ? (hooksObj[event] as unknown[]) : [];
        // #1634: stamp the marker so the entry is surgically strippable, and carry the declared
        // `matcher` (entry-level sibling of `hooks`) only when the author declared one.
        const entry: Record<string, unknown> = { [CAP_MARKER]: capId, hooks: [{ type: 'command', command }] };
        if (matcher !== null) entry['matcher'] = matcher;
        arr.push(entry);
        hooksObj[event] = arr;
        touched = true;
      }
      settings['hooks'] = hooksObj;
    }

    if (mcpEntries.length > 0) {
      const mcpObj = (typeof settings['mcpServers'] === 'object' && settings['mcpServers'] !== null && !Array.isArray(settings['mcpServers']))
        ? (settings['mcpServers'] as Record<string, unknown>)
        : {};
      for (const { name, config } of mcpEntries) {
        if (!name || isUnsafeKey(name)) continue;
        // Marker isolation for the map-keyed mcpServers shape: only (re)write an entry we already own
        // or a brand-new name. A collision with an UNOWNED entry (the user's, or another capability's)
        // is SKIPPED so user config is never clobbered — hooks are arrays and append, but mcpServers is
        // keyed by name, so a blind overwrite would silently destroy the existing server config.
        const existing = mcpObj[name];
        const ownedByUs = typeof existing === 'object' && existing !== null
          && (existing as Record<string, unknown>)[CAP_MARKER] === capId;
        if (existing !== undefined && !ownedByUs) continue;
        const stamped = (typeof config === 'object' && config !== null && !Array.isArray(config))
          ? { ...(config as Record<string, unknown>), [CAP_MARKER]: capId }
          : { value: config, [CAP_MARKER]: capId };
        mcpObj[name] = stamped;
        touched = true;
      }
      settings['mcpServers'] = mcpObj;
    }

    if (touched) {
      writeJsonFileAtomic(file, settings);
      records.push({ file: relFile, marker: capId });
    }
  }
  return records;
}

/**
 * Surgically remove a capability's owned entries (those stamped CAP_MARKER === capId) from each
 * recorded shared-config file, leaving everything else — including user hand-edits — untouched.
 * Idempotent: tolerates a missing/unparseable file or already-removed entries.
 */
function stripCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  sharedEdits: Array<{ file: string; marker: string }>;
}): number {
  const { runtimeDir, capId, sharedEdits } = args;
  let stripped = 0;
  for (const edit of sharedEdits) {
    const relFile = edit && typeof edit.file === 'string' ? edit.file : '';
    const file = confinedSharedFile(runtimeDir, relFile);
    if (file === null) continue; // unsafe path (absolute / .. / symlink escaping the scope root)
    const settings = readJsonFile(file);
    if (settings === null) continue; // missing/unparseable — nothing to strip
    let changed = false;

    const hooksObj = settings['hooks'];
    if (hooksObj && typeof hooksObj === 'object' && !Array.isArray(hooksObj)) {
      const ho = hooksObj as Record<string, unknown>;
      for (const event of Object.keys(ho)) {
        if (!Array.isArray(ho[event])) continue;
        const arr = ho[event] as unknown[];
        const kept = arr.filter(
          (e) => !(typeof e === 'object' && e !== null && (e as Record<string, unknown>)[CAP_MARKER] === capId),
        );
        if (kept.length !== arr.length) {
          changed = true;
          stripped += arr.length - kept.length;
        }
        if (kept.length === 0) delete ho[event];
        else ho[event] = kept;
      }
      if (Object.keys(ho).length === 0) delete settings['hooks'];
    }

    const mcpObj = settings['mcpServers'];
    if (mcpObj && typeof mcpObj === 'object' && !Array.isArray(mcpObj)) {
      const mo = mcpObj as Record<string, unknown>;
      for (const name of Object.keys(mo)) {
        const v = mo[name];
        if (typeof v === 'object' && v !== null && (v as Record<string, unknown>)[CAP_MARKER] === capId) {
          delete mo[name];
          changed = true;
          stripped += 1;
        }
      }
      if (Object.keys(mo).length === 0) delete settings['mcpServers'];
    }

    if (changed) writeJsonFileAtomic(file, settings);
  }
  return stripped;
}

/**
 * Is `id` a first-party capability id (present in the committed registry)? First-party always wins,
 * so an overlay reusing one of these ids — even a non-reserved name like "ui" — must be refused at
 * install (the loader would skip it at load anyway; rejecting here avoids writing an inert, shadowing
 * bundle). Fail-open to `false` if the registry cannot be read (the reserved-prefix gate still applies).
 */
function isFirstPartyCapabilityId(id: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./capability-registry.cjs') as { capabilities?: Record<string, unknown> };
    return !!(reg && reg.capabilities && Object.prototype.hasOwnProperty.call(reg.capabilities, id));
  } catch {
    return false;
  }
}

/**
 * Finding 5(b): bound the --shared-file COUNT against the same generous DoS cap the ledger applies
 * to `_pending.sharedFiles`. Returns an error string when over-cap (so the caller can fail fast
 * BEFORE source resolution / staging / shared-config writes), or null when within bounds.
 */
function checkSharedFileCount(sharedFiles: string[] | undefined): string | null {
  if (!Array.isArray(sharedFiles)) return null;
  if (sharedFiles.length > ledgerMod.MAX_SHARED_FILES) {
    return `too many --shared-file entries: ${sharedFiles.length} exceeds the maximum of ` +
      `${ledgerMod.MAX_SHARED_FILES}. A capability does not need this many shared-config files; ` +
      `reduce the --shared-file count.`;
  }
  return null;
}

/**
 * #1459: should this operation bind a user consent record? Only a PROJECT-scope op with a consent
 * store configured. GLOBAL scope is under the user's own home and is trusted without a record. A
 * caller that supplies a consentStoreDir but omits scope is treated as PROJECT (bind unless told
 * otherwise) — the conservative default that closes the trust gap.
 */
function shouldBindConsent(opts: LifecycleOptions): boolean {
  if (!opts.consentStoreDir) return false;
  const scope = opts.scope ?? 'project';
  return scope === 'project';
}

/**
 * #1459: a non-fatal capability-consent diagnostic on stderr. The lifecycle lib does not own a logger,
 * but a consent-binding skip/failure must be OBSERVABLE to the caller (IC-05/WIN-2, IC-07) — a silent
 * skip leaves a project cap inactive with no explanation. Best-effort: never throws (stderr can fail).
 */
function warnConsent(message: string): void {
  try { process.stderr.write(`capability consent: ${message}\n`); } catch { /* best-effort */ }
}

/**
 * #1459 IC-07: a PROJECT-scope op that did NOT supply a consentStoreDir cannot bind a consent record,
 * so the freshly-installed/upgraded project cap will be DISCOVERED-BUT-INACTIVE at load. That used to
 * be a SILENT skip. Emit a stderr warning so the caller knows consent binding was skipped (and why the
 * cap is inactive). Only fires for project scope with NO consent store — GLOBAL scope is trusted and
 * intentionally records nothing.
 */
function warnIfConsentSkipped(opts: LifecycleOptions, id: string): void {
  const scope = opts.scope ?? 'project';
  if (scope === 'project' && !opts.consentStoreDir) {
    warnConsent(
      `project-scope install of "${id}" did not supply a consent store (consentStoreDir); ` +
      `consent binding was SKIPPED, so this capability will be DISCOVERED-BUT-INACTIVE until consented.`,
    );
  }
}

/**
 * Record a project-scope user consent for `id` AFTER its ledger commit (#1459). The consent is bound
 * to the RECOMPUTED full-bundle content hash of the INSTALLED bundle (capDir) — the security binding
 * (CB-1/CB-2) — plus `integrity` + `disclosureSignature` (kept for the disclosure/re-consent UX). The
 * loader recomputes `bundleContentHash(capDir)` at load and re-activates exactly this bundle on THIS
 * machine; a forged/cloned project ledger without this record (or whose on-disk bundle differs from
 * the consented content) stays inactive.
 *
 * The content hash MUST be computed from the bundle as it now lives on disk (capDir(runtimeDir, id)),
 * NOT the staged dir — the loader hashes the installed capDir, so the two must agree.
 *
 * Best-effort: a consent-store write failure must not turn a successful install/upgrade into a
 * failure (the bundle is already committed) — it is surfaced as a warning, not a throw.
 */
/**
 * Resolve an `openai-http` reviewer lane's declared `hostConfigKey` to the destination it currently
 * names, or `undefined` when this capability is not such a lane.
 *
 * Falls back to the lane's declared `defaultHost` when the key is unset, because that is exactly
 * what the invocation path will do — binding the config value while the runtime uses the default
 * would guarantee a mismatch on the very first review.
 *
 * Non-throwing: consent binding is best-effort and must never turn a successful install into a
 * failure. An unresolvable host simply records nothing, which reads as "not bound" and allows.
 */
function resolveReviewerEgressHost(
  opts: LifecycleOptions,
  manifest: Record<string, unknown>,
): string | undefined {
  try {
    const reviewer = manifest['reviewer'];
    if (reviewer === null || typeof reviewer !== 'object' || Array.isArray(reviewer)) return undefined;
    const r = reviewer as Record<string, unknown>;
    if (r['transport'] !== 'openai-http') return undefined;
    const invoke = r['invoke'];
    if (invoke === null || typeof invoke !== 'object') return undefined;
    const inv = invoke as Record<string, unknown>;
    const key = typeof inv['hostConfigKey'] === 'string' ? inv['hostConfigKey'] : '';
    const fallback = typeof inv['defaultHost'] === 'string' ? inv['defaultHost'] : '';

    let configured = '';
    if (key) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cfgLoader = require('./config-loader.cjs') as {
        loadConfigResolved?: (cwd: string) => { config?: Record<string, unknown> };
      };
      const root = projectRootMod.consentProjectRoot(opts.runtimeDir);
      const cfg = cfgLoader.loadConfigResolved ? (cfgLoader.loadConfigResolved(root).config ?? {}) : {};
      let cur: unknown = cfg;
      for (const part of key.split('.')) {
        if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
        cur = Object.prototype.hasOwnProperty.call(cur, part)
          ? (cur as Record<string, unknown>)[part]
          : undefined;
      }
      if (typeof cur === 'string') configured = cur.trim();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { normalizeHost } = require('./review-lane-invocation.cjs') as {
      normalizeHost: (s: string) => string;
    };
    const resolved = normalizeHost(configured || fallback);
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

function bindProjectConsent(opts: LifecycleOptions, id: string, integrity: string, manifest: Record<string, unknown>): void {
  // #1459 IC-07: a project-scope op WITHOUT a consent store cannot bind — warn (then nothing to do).
  if (!shouldBindConsent(opts)) {
    warnIfConsentSkipped(opts, id);
    return;
  }
  try {
    consentMod.recordProjectConsent({
      gsdHome: opts.consentStoreDir,
      // #1459 IC-01/CB-4: bind the record's projectRoot through the SINGLE canonical helper so the
      // RECORD key matches the loader's LOOKUP key (consentProjectRoot) and `trust revoke`. The bundle
      // hash is still taken over the ACTUAL on-disk install location (capDir(opts.runtimeDir, id)).
      projectRoot: projectRootMod.consentProjectRoot(opts.runtimeDir),
      id,
      integrity,
      disclosureSignature: trustMod.signatureForManifest(manifest),
      contentHash: consentMod.bundleContentHash(capDir(opts.runtimeDir, id)),
      // ADR-2782 D5 rule 1 (#2799): bind the RESOLVED egress destination, not merely the config key
      // that names it. The key lives in `.planning/config.json`, outside the SHA-pinned bundle, so
      // without this the user consents to "wherever that key points" — a promise the bundle hash
      // cannot keep. Phase 5b re-resolves and compares at invocation (rule 4).
      reviewerHost: resolveReviewerEgressHost(opts, manifest),
    });
  } catch (err) {
    // #1459 IC-05/WIN-2: a consent-store write failure (read-only/UNC/NFS store) must NOT turn an
    // otherwise-successful install/upgrade into a failure — the bundle is already committed. Surface a
    // non-fatal warning (naming the store path so the operator can fix permissions and re-consent via
    // `gsd capability trust`), and let the op SUCCEED. The cap is simply inactive until consent writes.
    const storePath = (() => {
      try { return consentMod.consentStorePath(opts.consentStoreDir); } catch { return String(opts.consentStoreDir); }
    })();
    warnConsent(
      `could not write the consent record for "${id}" to "${storePath}": ${(err as Error).message}. ` +
      `The install succeeded but this capability stays INACTIVE until consent can be recorded.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

interface InstallResult {
  status: 'installed' | 'aborted' | 'blocked';
  id?: string;
  version?: string;
  disclosure?: Disclosure;
  blockReasons?: string[];
  requiresConsent?: boolean;
}

/**
 * Install a capability from a spec. Resolves (copy-only, integrity+engines verified), evaluates
 * the trust gate, and only promotes + records when policy allows and consent (if required) was
 * granted. Nothing is written on a blocked or aborted result.
 */
async function installCapability(spec: string, opts: LifecycleOptions): Promise<InstallResult> {
  const { runtimeDir, hostVersion, strictKnownRegistries, consentGranted, integrity, sharedFiles, execOverrides } = opts;

  // Pre-fetch source gate: never fetch/clone a disallowed source.
  const parsedPre = sourceMod.parseSpec(spec);
  const srcPre = trustMod.evaluateSourceAllowed(parsedPre, strictKnownRegistries);
  if (!srcPre.allowed) {
    return { status: 'blocked', blockReasons: [srcPre.reason ?? 'source not allowed'] };
  }

  // Finding 5(b) (MEDIUM): bound the --shared-file COUNT EARLY — BEFORE source resolution, staging,
  // or any shared-config write — so an over-cap install fails fast with a clear count error instead
  // of writing files + leaving a `_pending` for reconcile to clean up. The same generous DoS cap as
  // the ledger's `_pending.sharedFiles` validation.
  const sharedCountError = checkSharedFileCount(sharedFiles);
  if (sharedCountError) return { status: 'blocked', blockReasons: [sharedCountError] };

  // Finding 1 (HIGH): strict ledger PREFLIGHT — BEFORE source resolution, staging, trust, or
  // consent. On a corrupt-but-present ledger this must block IMMEDIATELY with a corruption
  // reason. The previous order called _resolve first (creating .gsd/capabilities/.staging) and
  // only strict-read later, so a corrupt ledger could surface as `aborted` (consent) for an
  // executable install without --yes BEFORE the corruption was ever reported, and would leave a
  // staging dir behind. A non-throwing read here is a READ-ONLY operation: it touches no lock and
  // creates no directory. The later read (re-read under lock before commit) is kept for race-safety.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  // Resolve copy-only into staging (do NOT promote — trust gate decides first).
  const resolve = opts._resolve ?? sourceMod.resolveCapabilitySource;
  let resolved;
  try {
    resolved = await resolve(spec, {
      hostVersion,
      gsdHome: runtimeDir,
      integrity,
      promote: false,
      // The lifecycle owns the engines gate via checkEngines (so it can also surface a
      // compatVersions downgrade hint); the resolver must not pre-empt it by throwing.
      skipEnginesGate: true,
      execOverrides,
    });
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  const stagedDir = resolved.stagedDir;
  // Serialize the fs swap + ledger writes (and reconcile) so a concurrent op can't interleave.
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) {
      return { status: 'blocked', id: resolved.id, blockReasons: ['another capability operation is in progress'] };
    }
    const manifest = readManifest(stagedDir);
    if (manifest === null) {
      return { status: 'blocked', blockReasons: ['staged capability.json is missing or invalid'] };
    }
    if (opts.expectedId && resolved.id !== opts.expectedId) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`source resolved to capability id "${resolved.id}" but "${opts.expectedId}" was expected; refusing`] };
    }
    // ROOT FIX 3: reject unsafe capability ids before any promotion or ledger write.
    // A .gsd/capabilities/constructor (or __proto__, prototype) bundle must never be promoted —
    // the resolved id is untrusted data from the bundle's capability.json.
    if (ledgerMod.isUnsafeCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`capability id "${resolved.id}" is unsafe (prototype-pollution key or invalid kebab-case); refusing to install`] };
    }
    if (isFirstPartyCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`"${resolved.id}" is a first-party capability id and cannot be overridden by a third-party overlay`] };
    }

    const verdict = trustMod.evaluateInstallTrust({
      parsed: parsedPre,
      manifest,
      stagedDir,
      strictKnownRegistries,
      hostVersion,
    });

    if (!verdict.allowed) {
      return { status: 'blocked', disclosure: verdict.disclosure, blockReasons: verdict.blockReasons };
    }
    if (verdict.requiresConsent && !consentGranted) {
      return { status: 'aborted', disclosure: verdict.disclosure, requiresConsent: true };
    }

    const finalDir = capDir(runtimeDir, resolved.id);
    const relCapDir = path.relative(runtimeDir, finalDir);
    const files = sharedFiles ?? [];

    // A reinstall over an existing bundle behaves like an upgrade (preserve the old on rollback).
    // readLedgerStrict: returns null when MISSING (fresh first install), throws CorruptLedgerError
    // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
    // corrupt-but-present ledger fails closed rather than silently treating it as "no prior entry".
    let existingLedger: LedgerFile | null;
    try {
      existingLedger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }
    const prior = existingLedger && Object.prototype.hasOwnProperty.call(existingLedger.entries, resolved.id)
      ? existingLedger.entries[resolved.id]
      : null;
    const hadDir = fs.existsSync(finalDir);
    const priorSharedFiles = prior && Array.isArray(prior.sharedEdits) ? prior.sharedEdits.map((e) => e.file) : [];
    const candidateFiles = Array.from(new Set([...priorSharedFiles, ...files]));
    // CONC-3: nonce'd backup name prevents same-ms cross-process collision.
    const backupName = hadDir ? newBackupName(resolved.id) : null;

    // INTENT: record BEFORE any filesystem mutation so a crash is recoverable (Codex R2 H1).
    // Kind 'upgrade' is used ONLY when BOTH a prior ledger entry AND the on-disk bundle exist (a
    // true reinstall-over-existing): the intent then carries the PRIOR metadata + a backup, so a
    // rollback restores the old files AND their matching ledger entry (Codex R3 H2/M6). Otherwise
    // it is a fresh install (kind 'install', no usable old state) whose rollback removes the
    // half-installed entry entirely.
    const isUpgradeLike = !!prior && hadDir;
    const pendingBase: LedgerEntry = isUpgradeLike
      ? { ...prior }
      : {
          id: resolved.id,
          version: resolved.version,
          source: resolved.source,
          integrity: resolved.integrity ?? '',
          files: [relCapDir],
          sharedEdits: prior?.sharedEdits ?? [],
        };
    // recordInstall calls readLedgerStrict internally and can throw CorruptLedgerError if the
    // ledger is corrupt. Catch it here so the function always returns a typed result, never throws.
    // DOS-4: pass the already-strict-read `existingLedger` as the base so recordInstall skips a
    // redundant strict re-read (we hold the lock, so the on-disk ledger cannot change underneath it).
    try {
      ledgerMod.recordInstall(runtimeDir, {
        ...pendingBase,
        _pending: { kind: isUpgradeLike ? 'upgrade' : 'install', backupName, sharedFiles: candidateFiles },
      }, { baseLedger: existingLedger });
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }

    let committed = false;
    let backupDir: string | null = null;
    try {
      ({ backupDir } = promoteStagingToFinal(stagedDir, finalDir, backupName ?? undefined));
      const sharedEdits = reapplyCapabilitySharedEdits({ runtimeDir, capId: resolved.id, stripFiles: candidateFiles, applyFiles: files, manifest });
      // COMMIT: rewrite WITHOUT _pending. Clearing the intent IS the commit.
      ledgerMod.recordInstall(runtimeDir, {
        id: resolved.id,
        version: resolved.version,
        source: resolved.source,
        integrity: resolved.integrity ?? '',
        files: [relCapDir],
        sharedEdits,
      });
      committed = true;
      // #1459: a CONSENTED project install (no consent needed for declarative; granted for
      // executable) records a user consent in the user-owned consent store AFTER the ledger commit,
      // bound to integrity + disclosure signature. Without this record the loader leaves the project
      // overlay inactive — closing the repo-plantable-ledger bypass. Global scope records nothing.
      bindProjectConsent(opts, resolved.id, resolved.integrity ?? '', manifest);
    } catch (err) {
      // Swap/commit failed; the intent remains for reconcile to roll back.
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    } finally {
      if (committed && backupDir) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }

    return { status: 'installed', id: resolved.id, version: resolved.version, disclosure: verdict.disclosure };
  } finally {
    // If staging survived (blocked/aborted/throw before promotion), clean it up; release the lock.
    try { if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Upgrade (atomic stage-then-swap, ledger = commit point)
// ---------------------------------------------------------------------------

interface UpgradeResult {
  status: 'upgraded' | 'aborted' | 'blocked' | 'not_installed';
  id?: string;
  fromVersion?: string;
  toVersion?: string;
  disclosure?: Disclosure;
  blockReasons?: string[];
  requiresConsent?: boolean;
}

/**
 * Upgrade an installed capability from a (new-version) spec via atomic stage-then-swap. The new
 * bundle is fully fetched, verified, and validated into staging; the old bundle is set aside;
 * the new is swapped in; THEN the ledger is rewritten (commit point); THEN the backup is dropped.
 * A crash anywhere leaves either the old or the new bundle fully intact — see reconcileCapabilities.
 *
 * Re-prompts for consent (returns 'aborted' when consent not granted) when the executable surface
 * set changed between the installed version and the new one.
 */
async function upgradeCapability(spec: string, opts: LifecycleOptions): Promise<UpgradeResult> {
  const { runtimeDir, hostVersion, strictKnownRegistries, consentGranted, integrity, sharedFiles, execOverrides } = opts;

  const parsedPre = sourceMod.parseSpec(spec);
  const srcPre = trustMod.evaluateSourceAllowed(parsedPre, strictKnownRegistries);
  if (!srcPre.allowed) {
    return { status: 'blocked', blockReasons: [srcPre.reason ?? 'source not allowed'] };
  }

  // Finding 5(b) (MEDIUM): bound the --shared-file COUNT EARLY — BEFORE source resolution/staging.
  const sharedCountError = checkSharedFileCount(sharedFiles);
  if (sharedCountError) return { status: 'blocked', blockReasons: [sharedCountError] };

  // Finding 1 (HIGH): strict ledger PREFLIGHT — BEFORE source resolution, staging, trust, or
  // re-consent. On a corrupt-but-present ledger this must block IMMEDIATELY with a corruption
  // reason, never fetch/stage the new bundle, and never surface a downstream not_installed/consent
  // result that masks the corruption. Read-only — takes no lock, creates no directory. The later
  // read (re-read under lock before commit) is kept for race-safety.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  const resolve = opts._resolve ?? sourceMod.resolveCapabilitySource;
  let resolved;
  try {
    resolved = await resolve(spec, {
      hostVersion,
      gsdHome: runtimeDir,
      integrity,
      promote: false,
      // The lifecycle owns the engines gate via checkEngines (so it can also surface a
      // compatVersions downgrade hint); the resolver must not pre-empt it by throwing.
      skipEnginesGate: true,
      execOverrides,
    });
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  const stagedDir = resolved.stagedDir;
  let committed = false;
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) {
      return { status: 'blocked', id: resolved.id, blockReasons: ['another capability operation is in progress'] };
    }
    if (opts.expectedId && resolved.id !== opts.expectedId) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`source for "${opts.expectedId}" now resolves to a different capability id "${resolved.id}"; refusing to upgrade`] };
    }
    // ROOT FIX 3: reject unsafe capability ids before any ledger read or promotion.
    if (ledgerMod.isUnsafeCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`capability id "${resolved.id}" is unsafe (prototype-pollution key or invalid kebab-case); refusing to upgrade`] };
    }
    // readLedgerStrict: returns null when MISSING (not installed), throws CorruptLedgerError
    // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
    // corrupt-but-present ledger fails closed rather than silently reporting not_installed.
    let existing: LedgerFile | null;
    try {
      existing = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }
    const prior = existing && Object.prototype.hasOwnProperty.call(existing.entries, resolved.id)
      ? existing.entries[resolved.id]
      : null;
    if (!prior) {
      return { status: 'not_installed', id: resolved.id, blockReasons: ['capability is not installed; use install'] };
    }

    const newManifest = readManifest(stagedDir);
    if (newManifest === null) {
      return { status: 'blocked', blockReasons: ['staged capability.json is missing or invalid'] };
    }

    const verdict = trustMod.evaluateInstallTrust({
      parsed: parsedPre,
      manifest: newManifest,
      stagedDir,
      strictKnownRegistries,
      hostVersion,
    });
    if (!verdict.allowed) {
      return { status: 'blocked', disclosure: verdict.disclosure, blockReasons: verdict.blockReasons };
    }

    // Re-consent only when the executable surface set changed between versions.
    const finalDir = capDir(runtimeDir, resolved.id);
    const oldManifest = readManifest(finalDir) ?? {};
    const oldDisclosure = trustMod.discloseExecutableSurfaces(oldManifest);
    if (trustMod.executableSetChanged(oldDisclosure, verdict.disclosure) && !consentGranted) {
      return { status: 'aborted', disclosure: verdict.disclosure, requiresConsent: true };
    }

    const files = sharedFiles ?? [];
    // Every shared file that EITHER the old or the new version touches must be cleaned on a
    // rollback, so a crash mid-swap can never strand the new version's executable config.
    const candidateFiles = Array.from(new Set([
      ...(Array.isArray(prior.sharedEdits) ? prior.sharedEdits.map((e) => e.file) : []),
      ...files,
    ]));

    // INTENT: record the in-flight upgrade BEFORE touching the filesystem. Its presence — not a
    // version comparison — is the commit signal reconcile uses (Codex R1 H3).
    // Wrap in try/catch so a disk failure (EPERM, ENOSPC, …) at the intent-write stage
    // returns a blocked result rather than a raw stack trace (finding 4).
    const backupName = newBackupName(resolved.id); // CONC-3: nonce'd, collision-resistant.
    try {
      ledgerMod.recordInstall(runtimeDir, { ...prior, _pending: { kind: 'upgrade', backupName, sharedFiles: candidateFiles } });
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }

    let backupDir: string | null = null;
    try {
      // Atomic swap: old -> backup(backupName), new -> live.
      ({ backupDir } = promoteStagingToFinal(stagedDir, finalDir, backupName));

      // Re-derive shared edits across ALL candidate files: strip old marker entries, apply new.
      const sharedEdits = reapplyCapabilitySharedEdits({ runtimeDir, capId: resolved.id, stripFiles: candidateFiles, applyFiles: files, manifest: newManifest });

      // COMMIT: rewrite the entry WITHOUT _pendingUpgrade. Clearing the intent IS the commit.
      const relCapDir = path.relative(runtimeDir, finalDir);
      ledgerMod.recordInstall(runtimeDir, {
        id: resolved.id,
        version: resolved.version,
        source: resolved.source,
        integrity: resolved.integrity ?? '',
        files: [relCapDir],
        sharedEdits,
      });
      committed = true;
      // #1459: re-record the project consent for the UPGRADED bundle (new integrity + signature) so
      // the loader re-activates exactly the new version on THIS machine. Global scope records nothing.
      bindProjectConsent(opts, resolved.id, resolved.integrity ?? '', newManifest);
    } catch (err) {
      // Swap/commit failed mid-flight; the intent remains in the ledger so reconcile can recover.
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    } finally {
      // Drop the backup ONLY after a successful commit; on failure leave it for reconcile.
      if (committed && backupDir) {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }

    return { status: 'upgraded', id: resolved.id, fromVersion: prior.version, toVersion: resolved.version, disclosure: verdict.disclosure };
  } finally {
    try { if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

interface RemoveResult {
  status: 'removed' | 'not_installed' | 'blocked';
  id: string;
  strippedEdits?: number;
  removedFiles?: string[];
  dataPreserved?: boolean;
  blockReasons?: string[];
  /**
   * #1459 finding 3 (round 6): true when the files/ledger were removed but the project-scope consent
   * record could NOT be revoked (e.g. the consent-store lock could not be acquired — revokeProjectConsent
   * THROWS rather than doing an unlocked delete). The removal is still `removed` (the bundle is gone), but
   * a STALE consent record remains that a byte-identical re-drop + forged ledger could reactivate against,
   * so the caller must report a NON-CLEAN removal and tell the user to clear it (`gsd capability trust revoke`).
   */
  consentRevokeFailed?: boolean;
  /** Human-readable detail naming the stale consent record when consentRevokeFailed is true. */
  consentRevokeWarning?: string;
}

/**
 * Remove an installed capability: strip exactly its marker-owned shared-config entries, delete
 * exactly the ledger-recorded files, then drop the ledger entry (commit point). Idempotent.
 * CAPABILITY_DATA is preserved unless opts.removeData is set.
 */
function removeCapability(id: string, opts: LifecycleOptions): RemoveResult {
  const { runtimeDir, removeData } = opts;
  // Finding 2 (HIGH): READ-ONLY corruption preflight BEFORE acquireLock. acquireLock creates
  // .gsd/capabilities and a .lock file; doing it before detecting corruption pollutes the scope
  // (and takes a lock) on a ledger we will refuse anyway. A strict read takes no lock and creates
  // no directory, so on a corrupt/IO-error ledger we return blocked with NO lock and NO dir created.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', id, blockReasons: [(err as Error).message] };
  }
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) return { status: 'blocked', id, blockReasons: ['another capability operation is in progress'] };
    // Re-read under the lock to close the race (the ledger could have gone corrupt between the
    // preflight and acquiring the lock). readLedgerStrict: returns null when MISSING (not
    // installed), throws CorruptLedgerError when the file exists but is corrupt — fail-closed.
    let ledger: LedgerFile | null;
    try {
      ledger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id, blockReasons: [(err as Error).message] };
    }
    const entry = ledger && Object.prototype.hasOwnProperty.call(ledger.entries, id) ? ledger.entries[id] : null;
    if (!entry) return { status: 'not_installed', id };

    // 1. Surgically strip capability-owned shared-config entries (user edits untouched).
    const strippedEdits = stripCapabilitySharedEdits({
      runtimeDir,
      capId: id,
      sharedEdits: Array.isArray(entry.sharedEdits) ? entry.sharedEdits : [],
    });

    // 2. Delete exactly the ledger-recorded files (guarded to under runtimeDir).
    const removedFiles: string[] = [];
    for (const f of Array.isArray(entry.files) ? entry.files : []) {
      if (typeof f === 'string' && safeRmUnder(runtimeDir, f)) removedFiles.push(f);
    }

    // 3. CAPABILITY_DATA: preserved unless explicitly requested.
    if (removeData) safeRmUnder(runtimeDir, path.relative(runtimeDir, capDataDir(runtimeDir, id)));

    // 4. Ledger commit point — entry no longer referenced.
    // Finding 3 (HIGH): commit from the ALREADY-read in-memory ledger (the one we strict-read
    // at the top of this function), NOT via removeEntry's non-strict re-read. If the ledger
    // goes corrupt between the strict pre-read and the commit, removeEntry would return false
    // (it re-reads non-strictly → null → returns false) while removeCapability still returns
    // 'removed', leaving a dangling reference in the corrupt file for a capability whose files
    // are already gone. Writing from the in-memory snapshot is atomic and coherent.
    //
    // If the write fails (EPERM, EBUSY, EXDEV, …) after the files are already deleted, we
    // return a typed 'blocked' result with recovery info rather than letting an unhandled
    // throw propagate as a CLI stack trace. The ledger would still reference files that no
    // longer exist — the user can re-run `gsd capability remove <id>` to retry the commit (the
    // next install/update/remove also runs the reconcile sweep automatically). There is no
    // standalone `reconcile` CLI subcommand (UX-4).
    try {
      if (ledger !== null) {
        delete ledger.entries[id];
        ledger.updatedAt = new Date().toISOString();
        ledgerMod.writeLedger(runtimeDir, ledger);
      }
    } catch (err) {
      return {
        status: 'blocked',
        id,
        blockReasons: [
          `Capability files were deleted but the ledger commit failed: ${(err as Error).message}. ` +
          `To recover: run 'gsd capability remove ${id}' again, or manually inspect and restore ` +
          `the ledger file to remove the stale entry for "${id}".`,
        ],
      };
    }

    // #1459: a PROJECT-scope removal fully REVOKES the user consent record so a later repo-dropped
    // bundle of the same id cannot silently re-activate against a stale consent. The ledger removal has
    // already succeeded, so a revoke failure must NOT fail the removal — but it MUST NOT be silently
    // swallowed either (#1459 finding 3, round 6): revokeProjectConsent now THROWS on a consent-lock
    // failure (round 3) rather than doing an unlocked delete, and swallowing that throw would report a
    // clean `removed` while leaving a STALE consent record a byte-identical re-drop + forged ledger could
    // reactivate against (the same stale-redrop class the reconcile path closes). Surface it instead: a
    // stderr warning naming the record AND a flag on the result so the CLI reports a non-clean removal.
    let consentRevokeFailed = false;
    let consentRevokeWarning: string | undefined;
    if (shouldBindConsent(opts)) {
      try {
        // #1459 IC-01/CB-4: revoke under the SAME canonical root the record was written under
        // (consentProjectRoot), so a removal actually clears the record the install bound.
        consentMod.revokeProjectConsent({ gsdHome: opts.consentStoreDir, projectRoot: projectRootMod.consentProjectRoot(runtimeDir), id });
      } catch (err) {
        consentRevokeFailed = true;
        consentRevokeWarning =
          `removed capability "${id}" but could NOT revoke its project consent record: ${(err as Error).message}. ` +
          `The consent record is now STALE — a byte-identical re-drop of this bundle could reactivate against it. ` +
          `Clear it manually: gsd capability trust revoke ${id}`;
        warnConsent(consentRevokeWarning);
      }
    }

    const result: RemoveResult = { status: 'removed', id, strippedEdits, removedFiles, dataPreserved: !removeData };
    if (consentRevokeFailed) {
      result.consentRevokeFailed = true;
      result.consentRevokeWarning = consentRevokeWarning;
    }
    return result;
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (crash recovery)
// ---------------------------------------------------------------------------

interface ReconcileReport {
  rolledBack: string[];
  rolledForward: string[];
  orphansRemoved: string[];
  ledger: unknown;
  /** Non-fatal warnings encountered during reconciliation (e.g. a corrupt-present ledger). */
  warnings: string[];
}

/**
 * Backup-dir name shape; the id segment is kebab-case so no traversal is possible. The trailing
 * `-<hex>` nonce (CONC-3) is OPTIONAL so legacy backups written before the nonce was added still
 * match (backward compatible).
 */
const BACKUP_NAME_RE = /^[a-z][a-z0-9-]*\.upgrading-\d+-\d+(-[0-9a-f]+)?$/;

/** A backup name is trustworthy for `id` only if it is well-formed AND names that exact id. */
function backupNameMatchesId(name: unknown, id: string): name is string {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name) && name.startsWith(id + '.upgrading-');
}

/**
 * Recover from a crashed install/upgrade and clean staging orphans. The commit signal is the
 * ledger entry's `_pending` INTENT — never a version comparison (a same-version malicious bundle
 * must not read as committed; Codex R1 H3). Holds the mutation lock so a concurrent in-flight
 * operation's just-written intent is never cleared mid-flight (Codex R2 H2); if the lock is held,
 * reconcile defers to that operation and no-ops.
 *
 *   - `_pending.kind === 'upgrade'` (or reinstall): the op did NOT commit -> ROLL BACK by restoring
 *     the backup over the live (possibly new, uncommitted) dir, re-syncing shared config from the
 *     restored OLD bundle, and clearing the intent. The intent is cleared ONLY if the restore
 *     succeeded (Codex R2 M4) so a failed recovery is retried, never silently committed.
 *   - `_pending.kind === 'install'` (fresh): the install did NOT commit -> remove the half-installed
 *     dir + its shared edits + the ledger entry entirely.
 *   - Leftover `<id>.upgrading-*` backups with NO live intent: the op committed -> drop the backup.
 *
 * The post-recovery state is always fully-old or fully-new — never a half-state.
 */
function reconcileCapabilities(opts: { runtimeDir: string; scope?: 'global' | 'project'; consentStoreDir?: string }): ReconcileReport {
  const { runtimeDir } = opts;
  const report: ReconcileReport = { rolledBack: [], rolledForward: [], orphansRemoved: [], ledger: null, warnings: [] };
  const root = capabilitiesRoot(runtimeDir);

  // #1459 IC-03: when a rollback DELETES a committed/half-committed project-scope ledger entry whose
  // bundle dir is gone, the user consent record bound to that (projectRoot, id) is now stale. Revoke it
  // so a later re-dropped BYTE-IDENTICAL bundle of the same id (whose recomputed content hash would
  // still match the stale record) cannot silently re-activate without a fresh user decision. The
  // content-hash binding already deactivates a DIFFERENT re-drop; revoking on rollback closes the
  // identical-re-drop gap. Best-effort + only when a project consent store is configured.
  const revokeStaleConsent = (id: string): void => {
    if (!opts.consentStoreDir) return;
    if ((opts.scope ?? 'project') !== 'project') return;
    try {
      consentMod.revokeProjectConsent({
        gsdHome: opts.consentStoreDir,
        projectRoot: projectRootMod.consentProjectRoot(runtimeDir),
        id,
      });
    } catch { /* best-effort — a consent-store IO error must never abort crash recovery */ }
  };

  // Finding 2 (HIGH): READ-ONLY corruption preflight BEFORE acquireLock. acquireLock creates
  // .gsd/capabilities and a .lock file; doing it before detecting corruption pollutes the scope
  // (and takes a lock) on a ledger we will refuse to mutate anyway. A strict read takes no lock and
  // creates no directory, so on a corrupt/IO-error/broken-symlink ledger we WARN and return WITHOUT
  // any filesystem mutation and WITHOUT a lock or directory created. (The in-lock re-read below
  // still fires to close the race if the ledger goes corrupt after this preflight.)
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    report.warnings.push(
      `Capability ledger file exists but could not be read: ${(err as Error).message}`,
    );
    return report; // no lock taken, no directory created, no filesystem mutation (finding 2)
  }

  const lock = acquireLock(runtimeDir);
  if (!lock) return report; // another op is in flight and will reconcile itself.
  try {
    // --- Step 1: resolve uncommitted operations flagged by the intent. ---
    let ledger = ledgerMod.readLedger(runtimeDir);
    // Detect corrupt-present or IO-error ledger: readLedger returns null but the file exists.
    // Finding 1 (CRITICAL): when the ledger file is present but unreadable/unparseable (or is a
    // broken symlink), RETURN IMMEDIATELY with the warning — perform NO filesystem mutations (no
    // backup sweep, no staging cleanup, no rmSync/rename). Continuing into step 2 would delete
    // `.upgrading-*` backups that may be the only recovery path for the user.
    //
    // ROOT FIX 4: use lstatSync (not existsSync) — existsSync follows the symlink and returns
    // false for a broken/dangling symlink, making reconcile treat a dangling ledger pointer as
    // "no ledger yet" and proceed to sweep backups. lstatSync checks the directory ENTRY itself,
    // so a broken symlink is detected and treated as an IO problem requiring user intervention.
    if (ledger === null) {
      const ledgerFilePath = path.join(runtimeDir, '.gsd-capabilities.json');
      let ledgerEntryExists = false;
      try {
        fs.lstatSync(ledgerFilePath);
        ledgerEntryExists = true;
      } catch (lstatErr) {
        // ENOENT means genuinely absent — no ledger, no entry, fresh start is fine.
        // Any other error (EACCES, EPERM, …) means an IO problem — also treat as "exists but broken".
        if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          ledgerEntryExists = true; // IO problem accessing the entry — treat as corrupt/broken.
        }
      }
      if (ledgerEntryExists) {
        report.warnings.push(`Capability ledger file exists but could not be parsed: ${ledgerFilePath}`);
        return report; // MUST return here — no mutations when ledger is corrupt/broken (finding 1)
      }
    }
    if (ledger) {
      // DOS-2: accumulate ALL step-1 ledger mutations in this in-memory copy and write ONCE at the
      // end of step 1, instead of a full read+write per pending entry (O(N) reads/writes → O(1)).
      // We already hold the lock and the ledger has passed the corruption preflight, so writing the
      // validated in-memory copy is coherent. `ledgerDirty` gates whether the single write runs.
      const workingLedger = ledger;
      let ledgerDirty = false;
      for (const id of Object.keys(workingLedger.entries)) {
        // W-6: a per-entry mutation can now throw (the strip/restore IO, or a future strict write).
        // One bad entry must NOT abort the whole reconcile — wrap it, warn, and continue.
        try {
          // Reject a tampered ledger key: a non-kebab id (e.g. one containing `../`) must never reach
          // capDir()/safeRmUnder() (Codex R3 M5). Leave it in place for ledger.reconcile to report.
          if (!KEBAB_ID_RE.test(id)) continue;
          const entry = workingLedger.entries[id];
          const pending = entry._pending;
          if (!pending) continue;
          // Candidate shared files: the intent's list UNION the entry's recorded files, so a
          // tampered/missing `sharedFiles` still cleans the genuinely-touched files (Codex R2 M5).
          const candidateFiles = Array.from(new Set([
            ...(Array.isArray(pending.sharedFiles) ? pending.sharedFiles : []),
            ...(Array.isArray(entry.sharedEdits) ? entry.sharedEdits.map((e) => e.file) : []),
          ]));
          const finalDir = capDir(runtimeDir, id);

          if (pending.kind === 'install') {
            // Uncommitted FRESH install -> remove dir + shared edits + the half-installed entry.
            stripCapabilitySharedEdits({ runtimeDir, capId: id, sharedEdits: candidateFiles.map((file) => ({ file, marker: id })) });
            // Only drop the entry once the dir is actually gone (safeRmUnder returns true when the
            // dir is already absent). If the delete genuinely FAILS (e.g. EPERM), keep `_pending` so
            // the next run retries — never orphan the dir with no recovery signal (code-review H).
            if (!safeRmUnder(runtimeDir, path.relative(runtimeDir, finalDir))) continue;
            delete workingLedger.entries[id]; // DOS-2: in-memory drop; single write at end of step 1.
            ledgerDirty = true;
            revokeStaleConsent(id); // #1459 IC-03: drop the now-stale consent so an identical re-drop stays inactive.
            report.rolledBack.push(id);
            continue;
          }

          // Uncommitted UPGRADE/reinstall. A kind 'upgrade' intent ALWAYS carries a well-formed
          // backupName naming this id; if it does not, the intent is tampered/corrupt — fail CLOSED
          // (leave it pending for manual handling) rather than silently accepting the live dir
          // (Codex R3 M6).
          if (!backupNameMatchesId(pending.backupName, id)) continue;
          const backupDir = path.join(root, pending.backupName);
          let restored: boolean;
          if (fs.existsSync(backupDir)) {
            try {
              // DUR-6: NEVER rmSync(finalDir) before restoring — a crash between the rm and the
              // rename would leave BOTH the new dir AND the backup gone (the old `rmSync` then
              // `rename` ordering). Instead, move the uncommitted new dir ASIDE (atomic rename), then
              // rename the backup over the now-free finalDir, then drop the aside copy. (`rename`
              // cannot atomically replace a non-empty directory on POSIX, so a single rename-over is
              // not an option.) At every instant at least one intact copy of the old bundle exists:
              //   - crash after step (a): backup still present + `_pending` still references it → retry.
              //   - crash after step (b): old bundle live at finalDir; only the aside copy leaks → swept.
              const discard = `${finalDir}.discard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
              if (fs.existsSync(finalDir)) retryRenameSync(finalDir, discard); // (a) set the new dir aside
              retryRenameSync(backupDir, finalDir);                            // (b) restore the old bundle
              fsyncDir(root);                                                // make the restore durable
              try { fs.rmSync(discard, { recursive: true, force: true }); } catch { /* swept later */ }
              restored = true;
            } catch {
              restored = false; // restore failed — leave the intent for a later retry.
            }
          } else if (fs.existsSync(finalDir)) {
            // Backup absent with a valid pointer: the swap never started, so the OLD bundle is live.
            restored = true;
          } else {
            // BOTH the backup and the live dir are gone (external deletion of both) — the bundle no
            // longer exists. Self-heal as a clean uninstall (strip + drop the entry) rather than
            // looping on a never-satisfiable restore (code-review M).
            stripCapabilitySharedEdits({ runtimeDir, capId: id, sharedEdits: candidateFiles.map((file) => ({ file, marker: id })) });
            delete workingLedger.entries[id]; // DOS-2: in-memory drop.
            ledgerDirty = true;
            revokeStaleConsent(id); // #1459 IC-03: both backup + live gone → uninstall self-heal also revokes consent.
            report.rolledBack.push(id);
            continue;
          }

          if (!restored) continue; // keep `_pending` so recovery is retried, never silently committed.

          const refreshed = resyncCapabilitySharedEdits({ runtimeDir, capId: id, sharedFiles: candidateFiles });
          const cleared: LedgerEntry = { ...entry, sharedEdits: refreshed };
          delete cleared._pending;
          workingLedger.entries[id] = cleared; // DOS-2: in-memory update; single write at end.
          ledgerDirty = true;
          report.rolledBack.push(id);
        } catch (entryErr) {
          // W-6: surface the failed entry as a warning and keep going with the rest.
          report.warnings.push(
            `Reconcile could not roll back capability "${id}": ${(entryErr as Error).message}`,
          );
        }
      }
      // DOS-2: write the accumulated step-1 mutations exactly ONCE.
      if (ledgerDirty) {
        workingLedger.updatedAt = new Date().toISOString();
        try {
          ledgerMod.writeLedger(runtimeDir, workingLedger);
        } catch (writeErr) {
          report.warnings.push(
            `Reconcile could not persist rolled-back ledger state: ${(writeErr as Error).message}`,
          );
        }
      }
      ledger = ledgerMod.readLedger(runtimeDir);
    }

    // --- Step 2: sweep leftover backups (committed ops) + staging orphans. ---
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      try { report.ledger = ledgerMod.reconcile(runtimeDir); } catch { /* best-effort */ }
      return report;
    }

    for (const name of entries) {
      // DUR-6: sweep `.discard-*` dirs left by an interrupted upgrade-rollback (the uncommitted new
      // bundle that was moved aside before the backup was renamed back in). They never carry a live
      // intent, so they are always safe to drop here.
      if (/\.discard-\d+-\d+-[0-9a-f]+$/.test(name)) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); report.orphansRemoved.push(name); } catch { /* best-effort */ }
        continue;
      }
      // Match both the legacy `<id>.upgrading-<pid>-<ts>` and the nonce'd `<id>.upgrading-<pid>-<ts>-<hex>`.
      const m = /^(.+)\.upgrading-\d+-\d+(?:-[0-9a-f]+)?$/.exec(name);
      if (!m) continue;
      const id = m[1];
      // If a pending intent still references this backup, step 1 left it (failed restore) — keep it.
      const entry = ledger && Object.prototype.hasOwnProperty.call(ledger.entries, id) ? ledger.entries[id] : null;
      if (entry && entry._pending && entry._pending.backupName === name) continue;
      // No live intent => the op committed (apply ran before commit) — drop the stale backup.
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        report.rolledForward.push(id);
      } catch { /* best-effort */ }
    }

    // Clean staging orphans — but spare recently-created dirs, which may belong to an in-flight
    // resolve that has not yet acquired this lock (resolve stages BEFORE locking; Codex R3 M7).
    const stagingRoot = path.join(root, '.staging');
    try {
      const now = Date.now();
      for (const s of fs.readdirSync(stagingRoot)) {
        const p = path.join(stagingRoot, s);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs <= STAGING_ORPHAN_MS) continue; // too fresh — could be live
          fs.rmSync(p, { recursive: true, force: true });
          report.orphansRemoved.push(s);
        } catch { /* best-effort */ }
      }
    } catch { /* no staging dir */ }

    // W-3 / DUR-5: sweep STALE ledger temp orphans (`.gsd-capabilities.json.tmp.<pid>-<nonce>`) from
    // the runtime dir. A double-IO-error (or Windows AV lock) during writeLedger's cleanup-unlink can
    // leave a temp behind; without this sweep they accumulate forever. Spare recently-created ones,
    // which may belong to an in-flight write in another process. Best-effort.
    try {
      const now = Date.now();
      const tmpPrefix = `${ledgerMod.LEDGER_FILE_NAME}.tmp.`;
      for (const f of fs.readdirSync(runtimeDir)) {
        if (!f.startsWith(tmpPrefix)) continue;
        const p = path.join(runtimeDir, f);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs <= LEDGER_TMP_ORPHAN_MS) continue; // too fresh — could be a live write
          fs.rmSync(p, { force: true });
          report.orphansRemoved.push(f);
        } catch { /* best-effort */ }
      }
    } catch { /* runtimeDir unreadable — nothing to sweep */ }

    try { report.ledger = ledgerMod.reconcile(runtimeDir); } catch { /* best-effort */ }
    return report;
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// outdatedCapabilities (ADR-1244 D6 "Update available?"; #1463)
// ---------------------------------------------------------------------------

/** One row of the `outdated` report: the installed capability vs. its source's latest version. */
interface OutdatedRecord {
  id: string;
  /** Source kind discriminant (git | npm | local | tarball | registry | unknown). */
  sourceKind: string;
  /** Installed version (from the ledger entry). */
  current: string | null;
  /** Latest available version at the source, or null when not resolvable. */
  latest: string | null;
  /**
   * outdated (latest > current) | current (latest <= current) | pinned (recorded source pinned to an
   * immutable/explicit ref or exact version — update will not move it) | manual (tarball) | unknown
   * (peek failed/unsupported).
   */
  status: 'outdated' | 'current' | 'pinned' | 'manual' | 'unknown';
}

/**
 * #1463 (ADR-1244 D6): for every installed overlay in `runtimeDir`'s ledger, peek its recorded source
 * for the latest available version and classify it. This is a LIGHT remote read per entry (the source
 * module's metadata-only peek); it NEVER throws on a single bad entry — that entry is reported with
 * status 'unknown'. Status rules:
 *   - peek 'ok'      → compare latest vs current (compareSemverCore): latest > current ⇒ 'outdated', else 'current'.
 *   - peek 'pinned'  → 'pinned'   (#1463: source pinned to an immutable/explicit git ref or exact npm
 *                      version — `update` re-resolves the SAME ref/version, so it is NEVER outdated; the
 *                      peek's optional `version` is informational only).
 *   - peek 'manual'  → 'manual'   (tarball: not auto-detectable per D6).
 *   - peek 'unsupported'/'unknown' → 'unknown' (registry unimplemented, or the peek failed/timed out).
 *
 * An empty/missing ledger yields an empty array (non-throwing — readLedger returns null on a missing or
 * corrupt-present ledger; the `outdated` report is read-only and degrades to "nothing to report").
 *
 * @param opts.runtimeDir   the scope root holding `.gsd-capabilities.json`.
 * @param opts.execOverrides threaded to the source peek (test seam — mock git ls-remote / npm view).
 */
function outdatedCapabilities(opts: {
  runtimeDir: string;
  execOverrides?: Record<string, unknown>;
}): OutdatedRecord[] {
  const { runtimeDir, execOverrides } = opts;
  const records: OutdatedRecord[] = [];
  const ledger = ledgerMod.readLedger(runtimeDir);
  if (!ledger || !ledger.entries) return records;

  for (const id of Object.keys(ledger.entries)) {
    const entry = ledger.entries[id];
    // Defensive: a hostile/partial ledger entry must never crash the sweep — report it 'unknown'.
    const current = entry && typeof entry.version === 'string' ? entry.version : null;
    const source = entry && typeof entry.source === 'string' ? entry.source : '';

    let sourceKind = 'unknown';
    try {
      sourceKind = sourceMod.parseSpec(source).kind;
    } catch { /* unparseable source — leave kind 'unknown' */ }

    let peek: { status: string; version: string | null };
    try {
      peek = sourceMod.peekLatestVersion(source, execOverrides ? { execOverrides } : undefined);
    } catch (err) {
      // peekLatestVersion is contractually non-throwing, but belt-and-suspenders: a single bad entry
      // must never abort the whole report.
      records.push({ id, sourceKind, current, latest: null, status: 'unknown' });
      void err;
      continue;
    }

    let status: OutdatedRecord['status'];
    let latest: string | null = peek.version;
    if (peek.status === 'pinned') {
      // #1463: the recorded source is pinned (immutable/explicit git ref or exact npm version). `update`
      // re-resolves the SAME ref/version, so it can never be outdated. `latest` carries the peek's
      // informational version when one is known (exact-pinned npm), else null (a pinned git ref is not
      // peeked for a tag).
      status = 'pinned';
    } else if (peek.status === 'manual') {
      status = 'manual';
    } else if (peek.status === 'ok' && peek.version && current) {
      status = semverMod.compareSemverCore(peek.version, current) > 0 ? 'outdated' : 'current';
    } else if (peek.status === 'ok' && peek.version && !current) {
      // We have a latest but no recorded current — cannot compare; treat as unknown (no false 'outdated').
      status = 'unknown';
    } else {
      // unsupported / unknown / ok-but-empty → unknown.
      status = 'unknown';
      latest = peek.version ?? null;
    }
    records.push({ id, sourceKind, current, latest, status });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  installCapability,
  upgradeCapability,
  removeCapability,
  reconcileCapabilities,
  outdatedCapabilities,
  applyCapabilitySharedEdits,
  stripCapabilitySharedEdits,
  // #1460 CONF-2: exported so the ancestor-symlink confinement is locked in by a regression test.
  confinedSharedFile,
  // #1460 (R) HIGH: exported so the shell-unsafe-script defense-in-depth (returns null for an
  // unsafe-char script even when the file exists in the bundle) is locked in by a regression test.
  confinedBundleScript,
  CAP_MARKER,
  // Exported for cross-process-lock unit tests (CONC-1/CONC-2/finding-1). Not part of the public CLI
  // surface. #1459 finding 4: the lock primitive now lives in the shared capability-lock module; these
  // re-export it (acquireLock here still takes a runtimeDir and computes the `.gsd/capabilities/.lock`
  // path) and the test seams (`_setLockProbes`/`_resetLockProbes`/`getProcessStartTime`) forward to the
  // shared module so the existing #1462 lock tests drive the SAME probe state the primitive reads.
  acquireLock,
  releaseLock,
  getProcessStartTime: lockMod.getProcessStartTime,
  _setLockProbes: lockMod._setLockProbes,
  _resetLockProbes: lockMod._resetLockProbes,
};
