/**
 * Capability ledger module — ADR-1244 Phase 3 (Decision D4).
 *
 * Manages a per-runtime install manifest (`.gsd-capabilities.json`) that records
 * what each capability install wrote. Serves as the atomic commit point and
 * reconciliation basis for Phase 4 upgrade/remove operations.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, node:crypto. No other src/ imports.
 *
 * Exports:
 *   readLedger(runtimeDir)        — structural-validated read, never throws
 *   readLedgerStrict(runtimeDir)  — like readLedger but throws CorruptLedgerError when
 *                                   the file exists but is unparseable/invalid. The
 *                                   corrupt file is LEFT IN PLACE (not moved/quarantined)
 *                                   so every subsequent op also blocks until the user
 *                                   inspects and resolves it.
 *   writeLedger(runtimeDir, ledger) — atomic write (tmp + rename, crash-safe)
 *   recordInstall(runtimeDir, entry) — idempotent upsert of a ledger entry
 *   removeEntry(runtimeDir, capId)   — remove a single entry by id
 *   reconcile(runtimeDir)            — report orphans / stale entries (read-only)
 *   CorruptLedgerError               — thrown by readLedgerStrict on corruption
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGER_FILE_NAME = '.gsd-capabilities.json';
const LEDGER_SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// CorruptLedgerError
// ---------------------------------------------------------------------------

/**
 * Thrown by `readLedgerStrict` when the ledger file is present but cannot be
 * parsed or is structurally invalid. The corrupt file is LEFT IN PLACE so that
 * every subsequent operation also blocks until the user resolves it manually.
 * Recovery: inspect the file, restore a backup, or move it aside to start fresh.
 */
class CorruptLedgerError extends Error {
  /** Absolute path of the corrupt ledger file. */
  ledgerPath: string;
  constructor(message: string, ledgerPath: string) {
    super(message);
    this.name = 'CorruptLedgerError';
    this.ledgerPath = ledgerPath;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LedgerEntry {
  id: string;
  version: string;
  source: string;
  integrity: string;
  files: string[];
  sharedEdits: Array<{ file: string; marker: string }>;
}

interface LedgerFile {
  /** Ledger schema version — currently '1'. */
  version: string;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
  /** Map of capability id → LedgerEntry. */
  entries: Record<string, LedgerEntry>;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

/** Pattern for valid capability IDs (must match this to be accepted as ledger keys). */
const VALID_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * DOS-3 / finding 5(a): GENEROUS DoS backstop bounds — NOT product limits. No legitimate capability
 * declares this many files or shared-config edits, but a hostile ledger with a 100k+-element array
 * is rejected before it can be iterated/spread into a Set (memory/CPU DoS). Raised from the prior
 * 256/64 (which risked false-rejecting large-but-legitimate installs) to clearly-generous bounds.
 */
const MAX_FILES = 10_000;
const MAX_SHARED_EDITS = 256;
/** Cap for `_pending.sharedFiles` (finding 3) — same generous bound as `sharedEdits`. */
const MAX_SHARED_FILES = 256;
/**
 * Finding 3 (MEDIUM): GENEROUS DoS backstops on the ledger FILE itself, NOT product limits. The
 * ledger is untrusted on-disk content; readLedgerRaw must not read+parse+materialize an unbounded
 * file. Before reading, `statSync` and reject (fail-closed via the corrupt path) if `size` exceeds
 * LEDGER_MAX_BYTES. And enforce MAX_ENTRIES during validation so a hostile ledger with millions of
 * keys cannot weaponize Object.keys iteration. 8 MiB / 4096 entries are far beyond any real install
 * (a typical entry is a few hundred bytes; 4096 capabilities is wildly more than any user installs).
 */
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 4096;

/**
 * Returns true when `id` must never be used as an object key or ledger entry id — either
 * because it would cause prototype pollution or because it fails the kebab-case constraint.
 *
 * Security note: uses INLINE LITERAL key comparisons (do NOT use a Set or computed lookup)
 * as required by the CodeQL prototype-pollution barrier — a Set.has call could itself be
 * attacked via a poisoned prototype.
 */
function isUnsafeCapabilityId(id: unknown): boolean {
  if (typeof id !== 'string') return true;
  if (id === '__proto__') return true;
  if (id === 'constructor') return true;
  if (id === 'prototype') return true;
  if (!VALID_ID_RE.test(id)) return true;
  return false;
}

/**
 * Sentinel for distinguishing IO errors (EACCES, EISDIR, EPERM, …) from
 * parse/validation failures. Thrown internally by readLedgerRaw; caught by the
 * two public readers to produce the right error type or return value.
 */
class LedgerIOError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LedgerIOError';
    this.code = code;
  }
}

/**
 * Finding 2 (HIGH): the SINGLE shared robust bounded reader for every untrusted on-disk file the
 * capability stack reads (the ledger here AND the .lock body in capability-lifecycle, which imports
 * this). A path-`stat`(path)+`readFileSync`(path) pair is NOT safe: a FIFO, a symlink to a character
 * device like /dev/zero, or a regular file SWAPPED/GROWN between the stat and the read defeats the
 * size cap and can BLOCK (FIFO with no writer) or read UNBOUNDED (infinite device). Project-scope
 * ledgers are repo-plantable, so this is a repo-borne DoS.
 *
 * The fix binds the type+size decision to the SAME open fd we read from:
 *   1. openSync(path, O_RDONLY|O_NONBLOCK) — open ONCE, NON-BLOCKING. The O_NONBLOCK is essential:
 *                                      a plain openSync of a FIFO BLOCKS until a writer appears (the
 *                                      very hang we are defending against); O_NONBLOCK returns the fd
 *                                      immediately so fstat can reject it. (Symlinks are still followed
 *                                      to their target, as a read would; O_NONBLOCK is ignored for a
 *                                      regular file.)
 *   2. fstatSync(fd)                 — stat the OPENED fd (not the path) — defeats the stat-then-read
 *                                      swap and reads the REAL target's type/size.
 *   3. require stat.isFile()         — reject FIFO / device / directory / symlink-to-nonregular. A
 *                                      directory keeps the legacy `EISDIR` code so existing callers
 *                                      that branch on it are unchanged.
 *   4. require stat.size <= maxBytes — refuse an oversized regular file WITHOUT reading it whole.
 *   5. read EXACTLY stat.size bytes from the fd — never an unbounded streaming read.
 *   6. closeSync(fd) in finally.
 *
 * Returns the file content as a string, or null for ENOENT (genuinely missing). Throws LedgerIOError
 * for every other condition (non-regular, oversized, IO error) so callers fail closed. Behavior for a
 * normal small regular file is identical to the prior readFileSync(path,'utf8').
 */
function readSmallRegularFile(filePath: string, maxBytes: number): string | null {
  const buf = readSmallRegularFileBuffer(filePath, maxBytes);
  if (buf === null) return null;
  // Decode to UTF-8 for STRING consumers (JSON parsers, lock-body parsers). This decode is LOSSY for
  // binary content (invalid byte sequences → U+FFFD), so a content-hash binding must NOT use this —
  // it must hash the RAW bytes via readSmallRegularFileBuffer (#1459 finding 1b: a swapped binary
  // artifact differing only in invalid-UTF-8 bytes would otherwise not change the digest).
  return buf.toString('utf8');
}

interface RegularFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface IdentityBoundBufferRead {
  readonly buffer: Buffer;
  readonly identity: RegularFileIdentity;
}

function snapshotRegularFileIdentity(st: fs.Stats): RegularFileIdentity {
  return {
    dev: st.dev,
    ino: st.ino,
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
  };
}

function sameRegularFileIdentity(
  actual: RegularFileIdentity,
  expected: RegularFileIdentity,
): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.mode === expected.mode
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs;
}

/**
 * #1459 finding 1 (HIGH): the RAW-BYTES variant of readSmallRegularFile. Identical open → fstat →
 * require-regular-file → size-cap → read-exactly-size protocol (so a FIFO/device/swapped/oversized
 * untrusted file can never block or read unbounded), but returns the bytes as a Buffer WITHOUT a
 * UTF-8 decode. This is the SOLE correct reader for the consent content-hash binding: the binding
 * must be byte-exact and INJECTIVE, and a utf8 decode is lossy (collapses distinct invalid byte
 * sequences to U+FFFD) so two different binary artifacts could collide. Returns the bytes, or null
 * for ENOENT (genuinely missing); throws LedgerIOError for every other fail-closed condition.
 */
function readSmallRegularFileBuffer(filePath: string, maxBytes: number): Buffer | null {
  // O_RDONLY | O_NONBLOCK: never block on opening a FIFO/device — return the fd so fstat can reject it.
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(filePath, openFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // genuinely missing — not a corruption.
    throw new LedgerIOError(`Cannot open ${filePath}: ${(err as Error).message}`, code);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      // FIFO / device / directory / symlink-to-nonregular. Preserve EISDIR for a directory so callers
      // that distinguish it (and existing tests) still see that code; other non-regular kinds get a
      // synthetic ENXIO. Either way it is an unreadable, fail-closed condition (not content parsing).
      const code = st.isDirectory() ? 'EISDIR' : 'ENXIO';
      throw new LedgerIOError(
        `Cannot read ${filePath}: not a regular file (unreadable; FIFO/device/directory) — refusing.`,
        code,
      );
    }
    if (st.size > maxBytes) {
      throw new LedgerIOError(
        `Cannot read ${filePath}: file size ${st.size} bytes exceeds the maximum of ${maxBytes} ` +
        `bytes (refusing to read an oversized file). Inspect or move it aside.`,
        'EFBIG',
      );
    }
    if (st.size === 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    // Read EXACTLY st.size bytes from the fd (never a streaming/unbounded read).
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break; // EOF earlier than fstat reported (truncated under us) — return what we got.
      off += n;
    }
    // Return EXACTLY the bytes we read (off may be < st.size on a truncated-under-us read).
    return off === buf.length ? buf : buf.subarray(0, off);
  } catch (err) {
    if (err instanceof LedgerIOError) throw err;
    throw new LedgerIOError(`Cannot read ${filePath}: ${(err as Error).message}`, (err as NodeJS.ErrnoException).code);
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

/**
 * Identity-bound variant for callers that validated a pathname before opening
 * it. The required expected identity is compared with the descriptor's fstat,
 * not another path stat, closing rename/symlink substitution between validation
 * and open. The returned identity is the descriptor actually read and can be
 * matched against the caller's final pathname validation.
 */
function readSmallRegularFileBufferWithIdentity(
  filePath: string,
  maxBytes: number,
  expectedIdentity: RegularFileIdentity,
): IdentityBoundBufferRead | null {
  // O_NONBLOCK prevents a FIFO open from hanging. O_NOFOLLOW rejects a
  // substituted symlink where the platform exposes it; descriptor identity
  // binding remains the portable backstop.
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow;
  let fd: number;
  try {
    fd = fs.openSync(filePath, openFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // genuinely missing — not a corruption.
    if (code === 'ELOOP') {
      throw new LedgerIOError(
        `Cannot open ${filePath}: symlink is not accepted as a regular file — refusing.`,
        code,
      );
    }
    throw new LedgerIOError(`Cannot open ${filePath}: ${(err as Error).message}`, code);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      // FIFO / device / directory / symlink-to-nonregular. Preserve EISDIR for a directory so callers
      // that distinguish it (and existing tests) still see that code; other non-regular kinds get a
      // synthetic ENXIO. Either way it is an unreadable, fail-closed condition (not content parsing).
      const code = st.isDirectory() ? 'EISDIR' : 'ENXIO';
      throw new LedgerIOError(
        `Cannot read ${filePath}: not a regular file (unreadable; FIFO/device/directory) — refusing.`,
        code,
      );
    }
    const openedIdentity = snapshotRegularFileIdentity(st);
    if (!sameRegularFileIdentity(openedIdentity, expectedIdentity)) {
      throw new LedgerIOError(
        `Cannot read ${filePath}: file identity changed between validation and open — refusing substituted bytes.`,
        'ESTALE',
      );
    }
    if (st.size > maxBytes) {
      throw new LedgerIOError(
        `Cannot read ${filePath}: file size ${st.size} bytes exceeds the maximum of ${maxBytes} ` +
        `bytes (refusing to read an oversized file). Inspect or move it aside.`,
        'EFBIG',
      );
    }
    const buf = st.size === 0 ? Buffer.alloc(0) : Buffer.allocUnsafe(st.size);
    let off = 0;
    // Read EXACTLY st.size bytes from the fd (never a streaming/unbounded read).
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== st.size) {
      throw new LedgerIOError(
        `Cannot read ${filePath}: file was truncated during the bounded read — refusing partial bytes.`,
        'ESTALE',
      );
    }

    const afterRead = fs.fstatSync(fd);
    if (!afterRead.isFile()
      || !sameRegularFileIdentity(snapshotRegularFileIdentity(afterRead), openedIdentity)) {
      throw new LedgerIOError(
        `Cannot read ${filePath}: descriptor identity changed during the bounded read — refusing.`,
        'ESTALE',
      );
    }
    return { buffer: buf, identity: openedIdentity };
  } catch (err) {
    if (err instanceof LedgerIOError) throw err;
    throw new LedgerIOError(`Cannot read ${filePath}: ${(err as Error).message}`, (err as NodeJS.ErrnoException).code);
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

/**
 * Read and structurally validate the ledger file. Throws LedgerIOError when the
 * file cannot be read due to an OS error (EACCES, EISDIR, EPERM, …). Returns
 * null when the file is missing (ENOENT) or when its content fails validation.
 * Never throws for parse or validation failures — those become null.
 */
function readLedgerRaw(runtimeDir: string): LedgerFile | null {
  const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
  // Finding 3 (MEDIUM) + Finding 2 (HIGH): the ledger file is untrusted. Read it via the shared
  // fd-based bounded reader (open → fstat → require regular file → size cap → read exactly size). A
  // FIFO/device/symlink-to-device or a stat-then-read swap can no longer block or bypass the cap; an
  // oversized/non-regular file is surfaced as a LedgerIOError (a "cannot read" condition, not a
  // content-parse failure) so readLedger returns null and readLedgerStrict rethrows it — every
  // subsequent op then fails closed until the user resolves it, exactly like the corrupt path.
  let raw: string;
  try {
    const content = readSmallRegularFile(filePath, LEDGER_MAX_BYTES);
    if (content === null) return null; // genuinely missing — not a corruption.
    raw = content;
  } catch (err) {
    if (err instanceof LedgerIOError) throw err; // non-regular / oversized / IO — fail closed.
    throw new LedgerIOError(`Cannot read ledger at ${filePath}: ${(err as Error).message}`, (err as NodeJS.ErrnoException).code);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    // Schema version must be the expected value (not any string) — finding 11.
    if (p['version'] !== LEDGER_SCHEMA_VERSION) return null;
    // updatedAt must be a non-empty string — finding 11.
    if (typeof p['updatedAt'] !== 'string' || !p['updatedAt']) return null;
    if (typeof p['entries'] !== 'object' || p['entries'] === null || Array.isArray(p['entries'])) return null;
    // Validate each entry via isValidLedgerEntry — THE single validator (ROOT FIX 1).
    // This eliminates the previous inline duplication and guarantees readLedger and
    // isValidLedgerEntry can never diverge.
    const entries = p['entries'] as Record<string, unknown>;
    const keys = Object.keys(entries);
    // Finding 3 (MEDIUM): cap the entry COUNT so a hostile ledger with millions of keys cannot
    // weaponize per-entry validation/iteration (the size cap above already bounds the parse; this
    // bounds the post-parse key count). Generous DoS backstop, not a product limit.
    if (keys.length > MAX_ENTRIES) return null;
    for (const key of keys) {
      if (!isValidLedgerEntry(key, entries[key])) return null;
    }
    return {
      version: p['version'],
      updatedAt: p['updatedAt'],
      entries: entries as Record<string, LedgerEntry>,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a single ledger entry object against the per-entry shape that readLedger enforces.
 * This is THE single validator — readLedger/readLedgerRaw call it per-entry instead of
 * duplicating inline checks (ROOT FIX 1 — single source of truth; #1459 will also consume this).
 *
 * Returns true when the entry is structurally valid for the given `id` key.
 * Returns false for any structural violation:
 *   - id is an unsafe prototype-pollution key (__proto__, constructor, prototype)
 *   - id fails the kebab-case constraint (VALID_ID_RE)
 *   - entry.id field missing or not matching the key
 *   - missing/wrong-type required fields (version, source, integrity)
 *   - files[] with non-string members
 *   - sharedEdits[] with missing / non-string file or marker fields
 *   - _pending present but wrong shape (kind not 'install'/'upgrade', bad backupName, missing sharedFiles[])
 */
function isValidLedgerEntry(id: unknown, entry: unknown): boolean {
  // ROOT FIX 3: reject unsafe ids using inline literal checks (CodeQL-safe pattern).
  if (isUnsafeCapabilityId(id)) return false;
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e['id'] !== 'string' || e['id'] !== id) return false;
  if (typeof e['version'] !== 'string') return false;
  if (typeof e['source'] !== 'string') return false;
  if (typeof e['integrity'] !== 'string') return false;
  if (!Array.isArray(e['files'])) return false;
  // DOS-3 / finding 5(a): cap array sizes so a hostile ledger cannot weaponize a 100k+-element
  // files[] (or sharedEdits[]/_pending.sharedFiles[]) into a memory/CPU DoS at validation/reconcile
  // time. These are GENEROUS DoS backstops, NOT product limits — no legitimate capability declares
  // 10k files or 256 shared-config edits, but a 100k+ hostile array is rejected (not iterated).
  if (e['files'].length > MAX_FILES) return false;
  for (const f of e['files'] as unknown[]) {
    if (typeof f !== 'string') return false;
  }
  if (!Array.isArray(e['sharedEdits'])) return false;
  if (e['sharedEdits'].length > MAX_SHARED_EDITS) return false; // DOS-3 (see above)
  for (const se of e['sharedEdits'] as unknown[]) {
    if (se === null || typeof se !== 'object') return false;
    const seObj = se as Record<string, unknown>;
    if (typeof seObj['file'] !== 'string' || !seObj['file']) return false;
    if (typeof seObj['marker'] !== 'string' || !seObj['marker']) return false;
  }
  // Validate _pending shape if present (ROOT FIX 1 — previously only in readLedgerRaw).
  if (Object.prototype.hasOwnProperty.call(e, '_pending')) {
    const pending = e['_pending'];
    if (pending !== undefined) {
      if (typeof pending !== 'object' || pending === null) return false;
      const p = pending as Record<string, unknown>;
      if (p['kind'] !== 'install' && p['kind'] !== 'upgrade') return false;
      // backupName must be string or null — not a number or object.
      if (p['backupName'] !== null && typeof p['backupName'] !== 'string') return false;
      if (!Array.isArray(p['sharedFiles'])) return false;
      // Finding 3: _pending.sharedFiles was previously ONLY Array.isArray-checked, so a hostile
      // ledger with a 500k-element (or non-string) _pending.sharedFiles was accepted and later
      // spread into a Set + iterated in reconcileCapabilities (DoS bypass). Cap its length with the
      // same generous bound as sharedFiles and require every member to be a string.
      if ((p['sharedFiles'] as unknown[]).length > MAX_SHARED_FILES) return false;
      for (const sf of p['sharedFiles'] as unknown[]) {
        if (typeof sf !== 'string') return false;
      }
    }
  }
  return true;
}

/**
 * Validate a WHOLE ledger-file object against the SAME structural rules a strict read enforces
 * (finding 5 — LOW): the schema version, a non-empty `updatedAt`, an entries map within MAX_ENTRIES,
 * and every entry valid via isValidLedgerEntry. Used by recordInstall to gate the in-lock
 * `baseLedger` fast-path so an invalid caller-supplied base can never be written verbatim. Never
 * throws; returns false for any structural violation.
 */
function isValidLedgerFile(base: unknown): base is LedgerFile {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return false;
  const b = base as Record<string, unknown>;
  if (b['version'] !== LEDGER_SCHEMA_VERSION) return false;
  if (typeof b['updatedAt'] !== 'string' || !b['updatedAt']) return false;
  const entriesVal = b['entries'];
  if (typeof entriesVal !== 'object' || entriesVal === null || Array.isArray(entriesVal)) return false;
  const entries = entriesVal as Record<string, unknown>;
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) return false;
  for (const key of keys) {
    if (!isValidLedgerEntry(key, entries[key])) return false;
  }
  return true;
}

/**
 * Read and structurally validate the ledger file.
 *
 * Returns null if the file is missing or structurally invalid.
 * Returns the parsed ledger when the file is valid.
 * On IO errors (EACCES, EISDIR, EPERM), returns null (non-throwing, compatible with old API).
 * Never throws.
 */
function readLedger(runtimeDir: string): LedgerFile | null {
  try {
    return readLedgerRaw(runtimeDir);
  } catch (err) {
    if (err instanceof LedgerIOError) {
      // IO error — treat as unreadable (return null) so callers are not broken.
      // readLedgerStrict will surface the real error.
      return null;
    }
    return null;
  }
}

/**
 * Like `readLedger` but distinguishes missing-vs-corrupt, and surfaces IO errors distinctly:
 *   - File missing → returns null (no ledger yet, fresh start is fine).
 *   - File present and valid → returns the parsed LedgerFile.
 *   - File present but unparseable/invalid CONTENT → throws CorruptLedgerError. The file is
 *     LEFT IN PLACE (not moved, renamed, or deleted) so every subsequent operation also
 *     blocks until the user resolves it. Recovery: inspect the file, restore a backup,
 *     or move it aside yourself to start fresh.
 *   - File present but unreadable (EACCES, EPERM, EISDIR, …) → throws LedgerIOError with
 *     the original OS errno/code preserved. This is an IO/permission problem — NOT a content
 *     corruption — and callers should surface it as such (finding 4).
 *
 * Callers that must fail-closed on corruption (upgrade, remove, install) should use this
 * instead of `readLedger` so they never mistake a corrupt file for "not installed".
 */
function readLedgerStrict(runtimeDir: string): LedgerFile | null {
  const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
  let raw: LedgerFile | null;
  try {
    raw = readLedgerRaw(runtimeDir);
  } catch (err) {
    if (err instanceof LedgerIOError) {
      // IO error (EACCES, EPERM, EISDIR, …) — rethrow as-is so callers see it as an IO
      // problem with the original errno, not as content corruption (finding 4).
      throw err;
    }
    throw err; // unexpected — propagate
  }
  if (raw !== null) return raw;
  // readLedgerRaw returned null: either genuinely missing or present-but-invalid (or unreadable).
  // ROOT FIX 4: use lstatSync (not existsSync) to detect dangling/broken symlinks.
  // existsSync follows the symlink and returns false for a broken symlink, making the ledger
  // appear "missing" when it is actually an IO problem — so a broken symlink would silently
  // allow a "fresh install" over a dangling ledger pointer, losing all prior records.
  // lstatSync checks the directory entry itself (not the target) — if it exists (even as a
  // broken symlink), that is NOT "missing": surface it as an IO error so every subsequent op
  // also fails closed until the user resolves it.
  let lstatResult: fs.Stats | null = null;
  try {
    lstatResult = fs.lstatSync(filePath);
  } catch (lstatErr) {
    const lstatCode = (lstatErr as NodeJS.ErrnoException).code;
    if (lstatCode === 'ENOENT') return null; // genuinely missing directory entry — fresh start is fine.
    // Any other lstat error (EACCES, EPERM, …) — treat as IO failure.
    throw new LedgerIOError(
      `Cannot stat ledger at ${filePath}: ${(lstatErr as Error).message}`,
      lstatCode,
    );
  }
  // lstat succeeded — the path exists in the directory (could be a broken symlink, dir, etc.).
  if (lstatResult.isSymbolicLink()) {
    // Broken symlink: the entry exists but the target is unreadable. This is an IO problem,
    // not content corruption — surface as LedgerIOError (not CorruptLedgerError) so callers
    // distinguish "I/O problem" from "corrupt content" (ROOT FIX 4).
    throw new LedgerIOError(
      `Ledger path ${filePath} is a broken or dangling symlink. ` +
      `Remove or fix the symlink so the ledger can be read normally.`,
      'ENOENT',
    );
  }
  // BC-1: distinguish a future/unsupported SCHEMA VERSION from genuine corruption. readLedgerRaw
  // returns null both when the JSON is unparseable AND when it parses cleanly but carries a
  // version string we do not support (currently only '1' exists). A version bump should surface a
  // clear "unsupported schema version X" message, not a misleading "corrupt or invalid". This is a
  // best-effort re-parse for the message only — the file is still LEFT IN PLACE.
  //
  // FIRST SCHEMA BUMP: when a v2 schema is introduced, ADD A MIGRATION BRANCH here (and in
  // readLedgerRaw) — read the old shape, migrate it forward, and write the upgraded ledger — rather
  // than throwing. Until then there are no v0/v2 ledgers in the wild (no released version wrote one),
  // so blocking on an unknown version is the safe fail-closed behavior.
  try {
    // Finding 2 (HIGH): the reparse is ALSO a read of the untrusted ledger path — a FIFO/device or a
    // file swapped after the first read must not block/bypass the cap here. Route it through the same
    // bounded fd reader (a null/throw means there's nothing safely reparseable → fall through to the
    // generic corrupt message).
    const reparsedRaw = readSmallRegularFile(filePath, LEDGER_MAX_BYTES);
    const reparsed: unknown = reparsedRaw === null ? null : JSON.parse(reparsedRaw);
    if (typeof reparsed === 'object' && reparsed !== null) {
      const ver = (reparsed as Record<string, unknown>)['version'];
      if (typeof ver === 'string' && ver !== LEDGER_SCHEMA_VERSION) {
        throw new CorruptLedgerError(
          `Capability ledger at ${filePath} uses unsupported ledger schema version "${ver}" ` +
          `(this build supports version "${LEDGER_SCHEMA_VERSION}"). Upgrade GSD to a build that ` +
          `understands this ledger, or move the file aside to start fresh.`,
          filePath,
        );
      }
    }
  } catch (reparseErr) {
    // A CorruptLedgerError from the unsupported-version branch must propagate; any other error
    // (re-read/parse failure) means it is genuinely corrupt — fall through to the generic message.
    if (reparseErr instanceof CorruptLedgerError) throw reparseErr;
  }
  // File exists (not a symlink, not missing) but failed validation — throw. The file is
  // intentionally LEFT IN PLACE so that every subsequent op is also blocked until the user
  // resolves it (finding 1): auto-moving it would let the NEXT op proceed as fresh state
  // → data-loss/orphan outcome.
  // W-2: the recovery hint must be platform-aware — a POSIX `mv` with a forward-slash path is wrong
  // on Windows (backslash paths, no `mv`). Show the native rename command for the running platform.
  const moveHint = process.platform === 'win32'
    ? `ren "${filePath}" "${path.basename(filePath)}.bak"  (or PowerShell: Move-Item "${filePath}" "${filePath}.bak")`
    : `mv "${filePath}" "${filePath}.bak"`;
  throw new CorruptLedgerError(
    `Capability ledger at ${filePath} is present but corrupt or invalid. ` +
    `Inspect the file to recover your capability records, restore a known-good backup, ` +
    `or move it aside to start fresh (e.g. ${moveHint}).`,
    filePath,
  );
}

/** W-1: rename errnos that are transient on Windows (AV scanner / indexer holding a brief lock). */
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;

/** Synchronous best-effort backoff sleep (Atomics.wait — same idiom as io.cts). */
let _renameSleepBuf: Int32Array | null = null;
function renameBackoff(): void {
  if (_renameSleepBuf === null) _renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(_renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}

/** Errnos from a directory fsync that are tolerated (platforms/filesystems disallowing dir fsync). */
const DIR_FSYNC_TOLERATED_ERRNOS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF']);

/**
 * fsync the directory CONTAINING `dest` so the just-completed rename is durable across a power loss
 * (DUR-2). Some platforms/filesystems disallow fsync on a directory fd (EISDIR/EPERM/EINVAL/EBADF) —
 * those are tolerated (best-effort, swallowed). Finding 4: any OTHER errno (e.g. EIO — a real
 * storage error) is RETHROWN as a clear durability-uncertain error rather than silently swallowed;
 * the rename may already be visible, so the caller must NOT claim success when durability could not
 * be confirmed. The directory fd is always closed (finally).
 */
function fsyncContainingDir(dest: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(path.dirname(dest), 'r');
    fs.fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && !DIR_FSYNC_TOLERATED_ERRNOS.has(code)) {
      // Real storage error (e.g. EIO): the rename may already be visible but its durability could
      // NOT be confirmed. Rethrow rather than silently claim success (finding 4).
      throw new Error(
        `Directory fsync of "${path.dirname(dest)}" failed (${code}); durability of the ledger ` +
        `rename could NOT be confirmed: ${(err as Error).message}`,
      );
    }
    /* tolerated errno (or no code) — best-effort: a missing dir-fsync only weakens durability */
  } finally {
    if (dirFd !== null) { try { fs.closeSync(dirFd); } catch { /* best-effort */ } }
  }
}

/**
 * Write the ledger atomically AND durably (tmp file in the same dir → fsync → close → rename →
 * dir fsync, no truncating fallback). Using a local implementation rather than platformWriteSync
 * so that a crash or power-loss mid-write cannot produce a zero-byte / truncated ledger — the
 * corrupt file that LEDGER-1 mishandled (ADR-1244 D4 fix).
 *
 * Durability sequence (DUR-1 / DUR-2):
 *   1. writeFileSync(fd, content)  — full-buffer write (no short-writes).
 *   2. fsyncSync(fd)               — flush the file's bytes to stable storage BEFORE the rename;
 *                                    otherwise a power-loss AFTER a successful rename can leave a
 *                                    zero/partial ledger (total loss). If fsync throws, the temp is
 *                                    unlinked and the error rethrown (treated as a write failure) —
 *                                    we NEVER rename a possibly-unflushed file live.
 *   3. closeSync(fd)               — a close error can also signal delayed-writeback failure;
 *                                    unlink the temp and rethrow before the rename.
 *   4. renameSync(tmp, dest)       — atomic install (retried on transient Windows AV locks, W-1).
 *   5. fsyncSync(dirname fd)       — make the rename itself durable (DUR-2).
 *
 * Security hardening (adversarial re-review):
 *   - Temp path includes a random nonce (not just pid) to avoid predictable names and resist
 *     collision between concurrent processes.
 *   - Temp file is created with the exclusive `wx` flag (O_EXCL) so a pre-planted symlink at the
 *     same path cannot redirect the write to another file.
 *   - On any failure (write, fsync, close, or rename) the temp file is cleaned up before
 *     rethrowing, and the primary error is always preserved (finding 13).
 */
function writeLedger(runtimeDir: string, ledger: LedgerFile): void {
  const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
  const content = JSON.stringify(ledger, null, 2) + '\n';
  fs.mkdirSync(runtimeDir, { recursive: true });
  // Unique nonce in the name prevents predictable-path attacks; wx (O_EXCL) prevents
  // a pre-existing symlink from silently redirecting the write.
  const nonce = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}-${nonce}`;
  const fd = fs.openSync(tmpPath, 'wx'); // exclusive create — throws if already exists
  let primaryErr: Error | null = null;
  try {
    // Write as a Buffer in one call to prevent short-writes (finding 6).
    // fs.writeFileSync(fd, …) internally uses a write-all loop that flushes the
    // entire buffer before returning, unlike a bare writeSync which may short-write.
    fs.writeFileSync(fd, content);
    // DUR-1: fsync the file's contents to stable storage BEFORE closing/renaming. Without this a
    // power-loss after a successful rename can leave a zero/partial ledger → total loss.
    fs.fsyncSync(fd);
  } catch (err) {
    primaryErr = err instanceof Error ? err : new Error(String(err));
  } finally {
    // closeSync can also throw (finding 2): a close error on the write fd can signal
    // delayed-writeback failure, meaning the data may not have been durably committed
    // to storage. In that case we must NOT install the possibly-unflushed temp as the
    // live ledger — unlink it and rethrow the close error before the rename.
    let closeErr: Error | null = null;
    try { fs.closeSync(fd); } catch (err) { closeErr = err instanceof Error ? err : new Error(String(err)); }
    // If the write OR fsync failed, always clean up and rethrow that error (DUR-1).
    if (primaryErr !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — no orphan */ }
      throw primaryErr;
    }
    // Write+fsync succeeded but close threw — unlink the possibly-unflushed temp and rethrow
    // the close error. NEVER proceed to rename a potentially unflushed file (finding 2).
    if (closeErr !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — no orphan */ }
      throw closeErr;
    }
    // Write, fsync, and close all succeeded — fall through to rename.
  }
  // W-1: renameSync can transiently fail on Windows when an AV scanner / file indexer holds a
  // brief lock (EPERM/EBUSY/EACCES). Retry a few times with a short backoff before giving up.
  let renameErr: Error | null = null;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      renameErr = null;
      break;
    } catch (err) {
      renameErr = err instanceof Error ? err : new Error(String(err));
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
        renameBackoff();
        continue;
      }
      break;
    }
  }
  if (renameErr !== null) {
    // Clean up the orphaned temp file before rethrowing.
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw renameErr;
  }
  // DUR-2: make the rename durable by fsyncing the containing directory (best-effort).
  fsyncContainingDir(filePath);
}

// ---------------------------------------------------------------------------
// Mutation operations
// ---------------------------------------------------------------------------

/**
 * Record a capability installation in the ledger (idempotent).
 *
 * If an entry with the same id already exists it is replaced. The `updatedAt`
 * timestamp is refreshed on every call. Rejects ids that would cause prototype
 * pollution (__proto__, constructor, prototype).
 *
 * Uses `readLedgerStrict` so that a corrupt-but-present ledger fails closed (throws
 * CorruptLedgerError, leaving the file in place) rather than silently overwriting it.
 *
 * DOS-4: `opts.baseLedger` lets an IN-LOCK caller pass the ledger it has ALREADY strict-read this
 * critical section so recordInstall does not redundantly re-read+re-validate it (install does up to
 * three strict reads per op). It is ONLY safe when the caller holds the mutation lock (so the
 * on-disk ledger cannot change underneath the passed snapshot) AND obtained it via readLedgerStrict
 * (so corruption was already fail-closed). The standalone strict read remains the DEFAULT — omit
 * `baseLedger` and the strict guarantee is unchanged. A null/missing baseLedger falls back to the
 * strict read; a non-object baseLedger is rejected.
 */
function recordInstall(
  runtimeDir: string,
  entry: LedgerEntry,
  opts?: { baseLedger?: LedgerFile | null },
): void {
  // ROOT FIX 3: reject ALL unsafe ids with a throw (not silent return) — this includes
  // prototype-pollution keys AND non-kebab ids. Using isUnsafeCapabilityId (which uses
  // inline literal === checks — CodeQL-safe pattern) as the single gate.
  if (isUnsafeCapabilityId(entry.id)) {
    throw new Error(
      `Invalid capability id "${entry.id}": must match /^[a-z][a-z0-9-]*$/ (kebab-case, lowercase). ` +
      `Unsafe or non-kebab ids are rejected to prevent prototype pollution and ledger corruption.`,
    );
  }

  // ROOT FIX 3 (finding 3): validate the WHOLE entry — not just entry.id — against the single
  // per-entry validator. Otherwise recordInstall could write a structurally-invalid entry (e.g.
  // files:[123] or a malformed sharedEdits member) that every subsequent readLedger/readLedgerStrict
  // would then reject as corrupt — turning a bad write into a persistent self-inflicted lockout.
  // Validating here makes recordInstall fail FAST (throw, write nothing) on a malformed entry.
  if (!isValidLedgerEntry(entry.id, entry)) {
    throw new Error(
      `Refusing to record a structurally-invalid ledger entry for "${entry.id}": the entry fails ` +
      `the ledger schema (check files[]/sharedEdits[]/version/source/integrity types). ` +
      `Writing it would corrupt the ledger so every later read rejects it.`,
    );
  }

  // DOS-4 + finding 5 (LOW): use the caller-supplied in-lock base ONLY when it passes the SAME
  // validation a strict read would (version, updatedAt, entry-count cap, and every entry via
  // isValidLedgerEntry). Previously the base was accepted on a shallow `entries is an object` check
  // and written VERBATIM — so a caller passing an invalid base (bad version/updatedAt, or a malformed
  // entry) would write a self-corrupting ledger that every later read rejects. Now an INVALID base is
  // ignored and we fall back to the strict read (the default, unchanged strict guarantee), so the
  // ledger is only ever derived from validated state.
  let existing: LedgerFile | null;
  const base = opts?.baseLedger;
  if (base !== undefined && base !== null && isValidLedgerFile(base)) {
    existing = base;
  } else {
    // readLedgerStrict: returns null when missing, parsed ledger when valid,
    // throws CorruptLedgerError (leaving file in place) when present-but-corrupt.
    existing = readLedgerStrict(runtimeDir);
  }

  const ledger: LedgerFile = existing ?? {
    version: LEDGER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };

  ledger.entries[entry.id] = entry;
  ledger.updatedAt = new Date().toISOString();

  writeLedger(runtimeDir, ledger);
}

/**
 * Remove a single capability entry from the ledger by id.
 *
 * Returns true if the entry was present and removed, false if GENUINELY not found.
 *
 * Finding 4 (fail-closed): uses `readLedgerStrict` (not the non-throwing `readLedger`) so a
 * corrupt-but-present ledger THROWS (CorruptLedgerError / LedgerIOError, file left in place)
 * rather than returning false. Returning false on corruption would let a corrupt ledger
 * masquerade as "entry not installed" — a silent no-op that hides recorded state. `false` is
 * now reserved exclusively for a genuinely-missing ledger or a genuinely-absent entry.
 */
function removeEntry(runtimeDir: string, capId: string): boolean {
  const ledger = readLedgerStrict(runtimeDir); // throws on corrupt-present / IO error (fail-closed)
  if (ledger === null) return false; // genuinely missing ledger — nothing installed
  if (!Object.prototype.hasOwnProperty.call(ledger.entries, capId)) return false;
  delete ledger.entries[capId];
  ledger.updatedAt = new Date().toISOString();
  writeLedger(runtimeDir, ledger);
  return true;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface ReconcileResult {
  /** Entries whose recorded files are partially or fully missing on disk. */
  orphans: Array<{ id: string; missing: string[] }>;
  /** Reserved for future use — capabilities whose source has been superseded. */
  stale: string[];
  /** Non-fatal warnings (e.g. unreadable ledger). */
  warnings: string[];
}

/**
 * Check ledger consistency against the filesystem.
 *
 * Read-only — never mutates the ledger or the filesystem. Reports:
 *   - orphans: entries with one or more recorded files missing on disk.
 *   - stale:   (reserved, always empty in Phase 3).
 *   - warnings: problems encountered while reading the ledger.
 */
function reconcile(runtimeDir: string): ReconcileResult {
  const result: ReconcileResult = { orphans: [], stale: [], warnings: [] };

  const ledger = readLedger(runtimeDir);
  if (ledger === null) {
    const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
    // Finding 5: use lstatSync (not existsSync) to detect the directory ENTRY itself. existsSync
    // FOLLOWS the symlink and returns false for a dangling/broken symlink — so a ledger that is a
    // broken symlink would be reported "missing" (no warning) when it is actually an unreadable IO
    // problem. lstatSync stats the entry without following it: any entry present (even a broken
    // symlink) is NOT "missing" and must surface a warning.
    let entryExists = false;
    try {
      fs.lstatSync(filePath);
      entryExists = true;
    } catch (lstatErr) {
      // ENOENT — genuinely absent: nothing installed, not a warning. Any other error (EACCES,
      // EPERM, …) means the entry is present-but-unreadable → treat as a parse/IO warning.
      if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') entryExists = true;
    }
    if (entryExists) {
      result.warnings.push(`Ledger file exists but could not be parsed: ${filePath}`);
    }
    // Missing ledger is not a warning — it simply means nothing has been installed.
    return result;
  }

  for (const id of Object.keys(ledger.entries)) {
    const entry = ledger.entries[id];
    const missing: string[] = [];
    for (const file of entry.files) {
      // Harden against hostile ledger JSON: a non-string member, or one that is
      // absolute or escapes runtimeDir via "..", must not crash reconcile or become
      // an existence oracle for files outside the runtime config dir.
      if (typeof file !== 'string' || file === '' || path.isAbsolute(file) || file.split(/[/\\]/).includes('..')) {
        // Note: do NOT String(file) — a hostile value like { toString: null } would throw.
        const shown = typeof file === 'string' ? file : `<${typeof file}>`;
        result.warnings.push(`Ledger entry "${id}" has an invalid file path; skipped: ${shown}`);
        continue;
      }
      const resolved = path.join(runtimeDir, file);
      if (!fs.existsSync(resolved)) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      result.orphans.push({ id, missing });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  readLedger,
  readLedgerStrict,
  writeLedger,
  recordInstall,
  removeEntry,
  reconcile,
  isValidLedgerEntry,
  isUnsafeCapabilityId,
  // Finding 2 (HIGH): the SINGLE shared bounded fd reader — also consumed by capability-lifecycle's
  // lock-body reads so every untrusted file read goes through the regular-file + size-capped fd path.
  readSmallRegularFile,
  // #3128: binds validated path identity to the descriptor actually read and returns that identity
  // so a caller can prove its post-read pathname still names the same file.
  readSmallRegularFileBufferWithIdentity,
  // #1459 finding 1 (HIGH): the RAW-BYTES variant — the SOLE correct reader for the byte-exact,
  // injective consent content-hash binding (a utf8 decode is lossy and could collide binary artifacts).
  readSmallRegularFileBuffer,
  // Exported for testing / introspection
  LEDGER_FILE_NAME,
  CorruptLedgerError,
  LedgerIOError,
  // DoS backstop bounds — shared with the lifecycle/CLI early count check (finding 5).
  MAX_SHARED_FILES,
};
