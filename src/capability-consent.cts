/**
 * Capability consent store — issue #1459 (capability trust model bypassable).
 *
 * A USER-OWNED store, living OUTSIDE any repository at `${GSD_HOME||homedir()}/.gsd/consent.json`,
 * that binds each PROJECT-scope third-party capability activation to a decision the user made on
 * THIS machine. Before #1459 a project's in-repo ledger entry was treated as the consent signal —
 * but a project ledger is repo-plantable, so cloning/forging a repo activated executable surfaces
 * and command dispatch with no user decision (the trust model was bypassable). The consent store
 * moves the authoritative signal off the repo tree: a project overlay is INACTIVE until a matching
 * consent record exists in this user-owned store.
 *
 * CONTENT BINDING (the security crux — #1459 round 2, findings CB-1/CB-2/TRUST2-5). The consent
 * record is bound to a RECOMPUTED full-bundle content hash (`bundleContentHash`), NOT to the ledger
 * `integrity` (which is `''` for path/git/dir installs and taken verbatim from the repo-plantable
 * project ledger — `'' === ''` is no binding) NOR to the `disclosureSignature` alone (which covers
 * only executable surfaces, so a declarative-only cap has a constant signature and a repo-write
 * attacker could swap `capability.json` for a malicious gate/contribution while consent still
 * matched). `bundleContentHash` is recomputed by the loader at load over EVERY file in the bundle
 * (manifest AND artifacts AND identity), so any tamper — declarative-only swap, hook-script edit,
 * empty-integrity local install — changes the hash and leaves the cap inactive. `integrity` and
 * `disclosureSignature` remain on the record for the human disclosure + re-consent-on-executable-
 * change UX (TRUST-2); they are NO LONGER the security binding.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, node:os, node:crypto, and the shared bounded
 * fd reader (readSmallRegularFile) from ./capability-ledger.cjs.
 *
 * Schema: `{ version: "1", records: { "<JSON({r,i})>": ConsentRecord } }`. The store is UNRELEASED
 * (no migration/back-compat shims needed); the only version is "1".
 *
 * Exports:
 *   consentStorePath(gsdHome?)            — resolve the store path (GSD_HOME||homedir() rule).
 *   bundleContentHash(capDir)            — recomputed sha512 over the whole bundle (the binding).
 *   readConsentStore(gsdHome?)            — bounded, NON-THROWING read; bad input → { records: {} }.
 *   hasProjectConsent({...})             — true iff a record matches the recomputed contentHash.
 *   recordProjectConsent({...})          — atomic+durable+LOCKED write of a project-scope record.
 *   revokeProjectConsent({...})          — atomic+LOCKED delete of a project-scope record (no-op if absent).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* eslint-disable @typescript-eslint/no-require-imports */
const ledgerMod = require('./capability-ledger.cjs') as {
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
  // #1459 finding 1 (HIGH): the RAW-BYTES reader — bundleContentHash MUST hash raw bytes, not a lossy
  // utf8-decoded string, so two binary artifacts differing only in invalid-UTF-8 bytes cannot collide.
  // #1459 finding 4 (LOW): accepts a RAW-BYTE Buffer path too — an invalid-UTF-8 FILENAME must be
  // reopened by its exact bytes (a utf8-decoded string path would resolve to a U+FFFD-mangled name).
  // fs.openSync accepts a Buffer path at runtime; widening the type here reflects that.
  readSmallRegularFileBuffer: (filePath: string | Buffer, maxBytes: number) => Buffer | null;
};
// #1459 finding 4: the SHARED hardened lock primitive (single source of truth for lifecycle + consent).
// Before this, the consent lock used a naive mtime-only 60s steal that would STEAL A LIVE WRITER (a
// slow/paused holder past 60s is reclaimed → original writer resumes and overwrites = lost update). The
// shared primitive never stale-steals a verified-live same-host holder (pid + start-time identity) and
// only reclaims a provably-dead/unverifiable holder (dead-pid fast path or the hard deadman).
const lockMod = require('./capability-lock.cjs') as {
  acquireLock: (lockPath: string, opts?: { maxAttempts?: number; waitForFresh?: boolean }) => { path: string; token: string; dev: number | null; ino: number | null } | null;
  releaseLock: (handle: { path: string; token: string; dev: number | null; ino: number | null } | null) => void;
  _setLockProbes: (probes: Partial<{ isPidAlive: (pid: number) => boolean; getProcessStartTime: (pid: number) => string | null }>) => void;
  _resetLockProbes: () => void;
};

/**
 * The consent store has GENUINELY-CONTENDED writers (two different projects installing concurrently
 * both write the ONE global consent.json), so it must SERIALIZE under brief contention rather than fail
 * — a larger steal/retry budget than the lifecycle's small sub-second default. Combined with #1459
 * finding 3 (throw on a NULL handle), this throws only when contention truly outlasts the budget.
 */
const CONSENT_LOCK_MAX_ATTEMPTS = 50;
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONSENT_SCHEMA_VERSION = '1';
const CONSENT_DIRNAME = '.gsd';
const CONSENT_FILE_NAME = 'consent.json';

/**
 * GENEROUS DoS backstop on the store FILE — NOT a product limit. The consent store is untrusted
 * on-disk content; the bounded reader must not read+parse an unbounded file. A few hundred bytes
 * per record × MAX_RECORDS is far below this; 8 MiB is wildly more than any real store.
 */
const CONSENT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * GENEROUS cap on the record COUNT so a hostile store with millions of keys cannot weaponize
 * Object.keys iteration. 4096 project×capability consents is far more than any user accumulates.
 * Enforced on BOTH read (refuse a hostile store wholesale) AND write (recordProjectConsent refuses
 * to grow the store past it — CONSENT-MAXRECORDS-WRITE-1).
 */
const MAX_RECORDS = 4096;

/**
 * CB-1/CB-2 content-hash bound: the maximum total bytes summed over every regular file in a bundle
 * `bundleContentHash` will hash. A legitimate capability bundle is a handful of small declarative
 * files plus a few scripts; 16 MiB is far more than any real bundle. A bundle exceeding this (a
 * hostile or runaway tree) fails closed: bundleContentHash throws rather than hashing unbounded
 * content, so the loader leaves the cap inactive.
 */
const BUNDLE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Per-file size cap inside a bundle (each file is read via the shared bounded fd reader). */
const BUNDLE_MAX_FILE_BYTES = BUNDLE_MAX_TOTAL_BYTES;
/**
 * Bound the bundle ENTRY count so a pathological tree of millions of empty files (or a very deep tree)
 * cannot DoS the walk. #1459 finding 2 (round 6): the cap is enforced on the CUMULATIVE entry count as
 * the walk STREAMS each directory (fs.opendirSync + readSync) — it throws the MOMENT the running count
 * exceeds this, BEFORE collecting/sorting a whole directory's entries — so a huge single directory (or a
 * deep tree) cannot force unbounded memory/CPU before the fail-closed cap. Backed by a mutable variable
 * with a test seam (`_setBundleMaxFilesForTest`) so a test can drive the bound deterministically without
 * planting 100k files; production code never mutates it.
 */
const BUNDLE_MAX_FILES_DEFAULT = 100_000;
let BUNDLE_MAX_FILES = BUNDLE_MAX_FILES_DEFAULT;

/** Valid capability id (kebab-case, lowercase, leading letter). */
const VALID_ID_RE = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsentRecord {
  projectRoot: string;
  id: string;
  scope: 'project';
  /** Ledger integrity at consent time — kept for the human disclosure UX, NOT the security binding. */
  integrity: string;
  /** Executable-surface disclosure signature — kept for re-consent-on-executable-change UX (TRUST-2). */
  disclosureSignature: string;
  /**
   * THE security binding (#1459 CB-1/CB-2): a recomputed full-bundle content hash. The loader
   * recomputes `bundleContentHash(capDir)` at load and activates the cap only when it equals this.
   */
  contentHash: string;
  consentedAt: string;
  /**
   * ADR-2782 D5 rule 1 (#2799): the egress destination this consent was granted against, for an
   * `openai-http` reviewer lane. Absent for every other capability, and for records written before
   * the rule existed.
   *
   * OPTIONAL BY DESIGN, and `isValidConsentRecord` deliberately does not require it. Making it
   * mandatory would invalidate every consent record already on disk, forcing re-consent across all
   * installed capabilities — precisely the spurious re-consent storm D4 rule 5 forbids.
   *
   * Deliberately NOT part of `disclosureSignature`: that signature is computed by BOTH the loader
   * and the lifecycle so the two can never drift, and the loader has no config resolver. Folding a
   * config-derived value in would make them compute different signatures for the same manifest and
   * re-prompt forever. The signature binds the manifest; this field binds the destination; Phase 5b
   * re-resolves and compares at invocation, which is where D5 rule 4 puts the check.
   */
  reviewerHost?: string;
}

interface ConsentStore {
  /** Map of `${realpath(projectRoot)}<NUL>${id}` (the canonical in-memory key) → ConsentRecord. */
  records: Record<string, ConsentRecord>;
}

// ---------------------------------------------------------------------------
// Safety helpers (prototype-pollution-safe; CodeQL inline-literal barrier)
// ---------------------------------------------------------------------------

/**
 * Returns true when `id` must never be used as an object key / record id — either because it would
 * cause prototype pollution or because it fails the kebab-case constraint. Uses INLINE LITERAL key
 * comparisons (no Set / computed lookup) per the CodeQL prototype-pollution barrier.
 */
function isUnsafeCapabilityId(id: unknown): boolean {
  if (typeof id !== 'string') return true;
  if (id === '__proto__') return true;
  if (id === 'constructor') return true;
  if (id === 'prototype') return true;
  if (!VALID_ID_RE.test(id)) return true;
  return false;
}

/** The canonical IN-MEMORY lookup key for a (projectRoot, id) pair (NUL-joined). */
function consentKey(realRoot: string, id: string): string {
  return realRoot + String.fromCharCode(0) + id;
}

/**
 * The ON-DISK key (WIN-3): an unambiguous JSON-object string `{"r":<realpath>,"i":<id>}`. The prior
 * space-joined `<realpath> <id>` form was ambiguous when a path contained a space (Windows
 * `C:\Users\John Smith\...`): two distinct (root,id) pairs could collide. A JSON-stringified object
 * key encodes both components unambiguously, so distinct pairs never collide on disk.
 */
function diskKey(realRoot: string, id: string): string {
  return JSON.stringify({ r: realRoot, i: id });
}

/**
 * Best-effort realpath of a project root. A non-existent path cannot be realpath'd; fall back to
 * path.resolve so a record can still be written/looked-up consistently (both record and lookup use
 * this same function, so they agree).
 */
function realpathProject(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the consent store path. Uses the SAME `gsdHome || GSD_HOME || homedir()` rule the loader
 * and CLI use, so a consent record written by the CLI is found by the loader. The store NEVER lives
 * under a repository — it is user-owned, machine-local config.
 */
function consentStorePath(gsdHome?: string): string {
  const home = gsdHome || process.env['GSD_HOME'] || os.homedir();
  return path.join(home, CONSENT_DIRNAME, CONSENT_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Bundle content hash (the security binding — CB-1/CB-2/TRUST2-5)
// ---------------------------------------------------------------------------

/**
 * A bundle entry collected by the walk: either a regular FILE or a (possibly empty) DIRECTORY.
 *
 * #1459 finding 4 (LOW): both the absolute path (`abs`, for re-reading FILE bytes) and the relative
 * path (`rel`, the path component of the digest) are RAW BYTE Buffers, NOT decoded strings. On POSIX a
 * filename is an arbitrary byte sequence that may not be valid UTF-8; reading dir entries as strings
 * coerces each invalid byte through U+FFFD, so two files whose NAMES differ only in invalid-UTF-8 bytes
 * would collapse to the same string → the same path bytes → a hash COLLISION (a repo-write attacker
 * could swap one for the other without changing the binding). Carrying raw bytes end to end keeps the
 * path component LOSSLESS.
 */
interface BundleEntry {
  /** Absolute path on disk as RAW BYTES (Buffer) — fs accepts a Buffer path on POSIX. DIR markers reuse it for recursion. */
  abs: Buffer;
  /** NORMALIZED POSIX relpath relative to the bundle root as RAW BYTES (path separators are the `/` byte 0x2f). */
  rel: Buffer;
  /** Entry kind — a typed marker so a file and a directory at the same relpath never collide. */
  kind: 'file' | 'dir';
}

/** The path-separator BYTE used to join raw-byte path segments — `/` (0x2f) on every platform we hash on. */
const SEP_BYTE = Buffer.from('/');
/** On Windows the OS separator is `\\` (0x5c); normalize it to `/` at the BYTE level for cross-platform determinism. */
const WIN_SEP_BYTE = 0x5c;

/** Join a parent raw-byte path and a raw-byte segment with the `/` separator byte. An empty parent → the segment alone. */
function joinBytes(parent: Buffer, segment: Buffer): Buffer {
  if (parent.length === 0) return Buffer.from(segment);
  return Buffer.concat([parent, SEP_BYTE, segment]);
}

/** Normalize Windows `\\` separator bytes to `/` in a raw-byte relpath (no-op on POSIX paths). */
function normalizeSepBytes(rel: Buffer): Buffer {
  if (process.platform !== 'win32') return rel;
  const out = Buffer.from(rel);
  for (let i = 0; i < out.length; i++) if (out[i] === WIN_SEP_BYTE) out[i] = 0x2f;
  return out;
}

/**
 * Recursively collect every REGULAR file AND every DIRECTORY under `absDir` as RAW-BYTE POSIX-relative
 * paths (`rel`, relative to the bundle root), refusing to follow symlinks out of the bundle. Bounded:
 * throws if the entry count or total byte size exceeds the caps (fail closed — a hostile/runaway tree
 * never hashes unbounded content). A non-regular entry encountered IN the tree (FIFO/device) is a
 * fail-closed throw — a bundle must be plain files and directories.
 *
 * #1459 finding 2 (MED/HIGH, ROUND 6): the enumeration ITSELF is bounded. Instead of
 * `fs.readdirSync` (which loads + sorts a WHOLE directory before the count cap — so a malicious bundle
 * with a huge single directory, or a very deep tree, forces unbounded memory/CPU before fail-closing),
 * we STREAM each level via fs.opendirSync + dir.readSync() and increment a CUMULATIVE entry counter
 * (`count.n`) across the recursive walk, throwing the MOMENT it exceeds BUNDLE_MAX_FILES — BEFORE
 * collecting (let alone sorting) the rest of the level. Determinism is preserved: the BOUNDED set of a
 * level is still sorted (by raw-byte name) before lstat/recursion, and the FINAL digest sorts over all
 * rel byte strings. The cap is cumulative, so a deep tree spread across many nested dirs cannot blow it.
 *
 * #1459 finding 2 (LOW): directories (including EMPTY ones) are emitted as typed DIR markers so that
 * adding/removing an empty directory CHANGES the canonical hash. Capability code can branch on a
 * directory's existence, so a bare-dir add must be observable to the binding.
 *
 * #1459 finding 4 (LOW): dir entries are read as raw-byte Buffer names (`encoding: 'buffer'`) and the
 * abs/rel paths are concatenated at the BYTE level, so an invalid-UTF-8 filename is never lossily
 * decoded — two filenames that differ only in invalid bytes produce distinct rel byte strings.
 *
 * @param absDir  the absolute directory to scan, as RAW BYTES (Buffer).
 * @param relDir  the relpath of `absDir` from the bundle root, as RAW BYTES (Buffer; empty at the root).
 * @param count   the CUMULATIVE entry counter shared across the whole recursive walk (fail-closed at the cap).
 */
function collectBundleEntries(absDir: Buffer, relDir: Buffer, acc: BundleEntry[], total: { bytes: number }, count: { n: number }): void {
  let dir: fs.Dir;
  try {
    // RAW-BYTE streaming open: dirent names are Buffers (encoding: 'buffer'), so an invalid-UTF-8
    // filename is preserved verbatim. opendirSync + readSync iterates one entry at a time, so the cap
    // can fail closed BEFORE the whole directory is materialized/sorted.
    dir = fs.opendirSync(absDir, { encoding: 'buffer' } as unknown as fs.OpenDirOptions);
  } catch (err) {
    throw new Error(`bundleContentHash: cannot read directory "${absDir.toString('utf8')}": ${(err as Error).message}`);
  }
  // Collect ONLY the BOUNDED set of this level's dirents — the cumulative counter throws the moment it
  // crosses the cap, so the array can never grow past it. We still sort this bounded set (by raw-byte
  // name) so the byte/count accounting walk is reproducible across platforms.
  const levelEntries: fs.Dirent<Buffer>[] = [];
  try {
    for (;;) {
      let ent: fs.Dirent<Buffer> | null;
      try {
        ent = dir.readSync() as unknown as fs.Dirent<Buffer> | null;
      } catch (err) {
        throw new Error(`bundleContentHash: cannot read directory "${absDir.toString('utf8')}": ${(err as Error).message}`);
      }
      if (ent === null) break;
      // BOUND THE ENUMERATION ITSELF: increment the cumulative counter and fail closed BEFORE this entry
      // is retained/sorted, so a huge directory (or deep tree) cannot be loaded/sorted in full first.
      count.n++;
      if (count.n > BUNDLE_MAX_FILES) {
        throw new Error(`bundleContentHash: bundle entry count exceeds ${BUNDLE_MAX_FILES} (refusing)`);
      }
      levelEntries.push(ent);
    }
  } finally {
    try { dir.closeSync(); } catch { /* best-effort */ }
  }
  levelEntries.sort((a, b) => Buffer.compare(a.name, b.name));
  for (const ent of levelEntries) {
    const name = ent.name; // Buffer
    const abs = joinBytes(absDir, name);
    const rel = normalizeSepBytes(joinBytes(relDir, name));
    // lstat the entry (Buffer path): a symlink must NOT be followed (it could escape the bundle to
    // /etc/passwd or to an infinite device). Re-lstat to be certain across platforms.
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      throw new Error(`bundleContentHash: cannot lstat "${abs.toString('utf8')}": ${(err as Error).message}`);
    }
    if (st.isSymbolicLink()) {
      // A symlink in the bundle is suspicious and unhashable safely (it would either escape the
      // bundle or follow to a non-regular target). Fail closed.
      throw new Error(`bundleContentHash: refusing to hash a symlink in the bundle: "${abs.toString('utf8')}"`);
    }
    if (st.isDirectory()) {
      // Emit a typed DIR marker for THIS directory (so an empty dir is bound), then recurse into it.
      acc.push({ abs, rel, kind: 'dir' });
      collectBundleEntries(abs, rel, acc, total, count);
      continue;
    }
    if (!st.isFile()) {
      throw new Error(`bundleContentHash: refusing to hash a non-regular file in the bundle: "${abs.toString('utf8')}"`);
    }
    acc.push({ abs, rel, kind: 'file' });
    total.bytes += st.size;
    if (total.bytes > BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error(`bundleContentHash: bundle size exceeds ${BUNDLE_MAX_TOTAL_BYTES} bytes (refusing)`);
    }
  }
}

/** Encode an unsigned 32-bit length as 4 big-endian bytes (the path-length frame). */
function uint32be(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * Encode an unsigned 64-bit length as 8 big-endian bytes (the content-length frame). A bundle file is
 * size-capped well below 2^53 so writeBigUInt64BE of a BigInt is exact and never overflows.
 */
function uint64be(n: number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/** Typed entry tags so a FILE and a DIR at the same relpath can never produce the same digest input. */
const TAG_FILE = Buffer.from([0x01]);
const TAG_DIR = Buffer.from([0x02]);

/**
 * The recomputed full-bundle content hash (#1459 CB-1/CB-2/TRUST2-5) — the SECURITY BINDING. A
 * `sha512-<base64>` over a DETERMINISTIC, INJECTIVE, LOSSLESS serialization of EVERY regular file
 * AND directory under `capDir` (recursively).
 *
 * Canonicalization (#1459 findings 1 + 4 — the prior `relpath + NUL + content + NUL` over utf8-decoded
 * STRINGS was non-injective, lossy in CONTENT, AND lossy in the PATH component):
 *   - LENGTH-FRAMED, no ambiguous delimiters. A leading fixed-width entry COUNT, then per entry
 *     (sorted by raw-byte relpath): a 1-byte TYPE tag, uint32 path-byte-length + the raw path bytes,
 *     and (for a FILE) uint64 content-byte-length + the raw content bytes. Because every component is
 *     length-prefixed, a NUL (or any byte) inside a path or file content can never be mistaken for a
 *     boundary — two different (path, content) splits cannot collide.
 *   - RAW BYTES end to end, never utf8-decoded — for BOTH content AND the path. File bytes are read via
 *     the ledger's RAW-BYTES bounded reader (readSmallRegularFileBuffer); the PATH bytes come straight
 *     from a raw-byte (`encoding: 'buffer'`) dir walk (#1459 finding 4), so two binary artifacts that
 *     differ only in invalid-UTF-8 bytes — whether in their CONTENT or in their FILENAME (both of which
 *     a utf8 decode would collapse to U+FFFD) — produce DIFFERENT digests.
 *   - DETERMINISTIC across platforms: entries sorted by the raw-byte relpath whose separators are
 *     normalized to the `/` byte, so an on-disk reorder and a Windows-vs-POSIX separator difference do
 *     not matter.
 *
 * Throws (fail closed) on an unreadable dir, a non-regular/symlinked bundle entry, or a bundle that
 * exceeds the size/count caps — the loader treats a throw as "no matching consent" (inactive).
 *
 * Each file's bytes are read via the SHARED bounded fd reader (open → fstat → require regular file →
 * size cap → read exactly size), so a file swapped for a FIFO/device between the walk and the read
 * cannot block or read unbounded.
 */
function bundleContentHash(capDir: string): string {
  // Resolve to an absolute path, then carry it as RAW BYTES so the walk never lossily decodes a name.
  const rootBytes = Buffer.from(path.resolve(capDir));
  const entries: BundleEntry[] = [];
  collectBundleEntries(rootBytes, Buffer.alloc(0), entries, { bytes: 0 }, { n: 0 });
  // Sort by the raw-byte (separator-normalized) relpath so the digest is identical on Windows and POSIX,
  // and is independent of the on-disk creation/readdir order. Tie-break on kind so a (degenerate, never
  // produced on a real fs) file-and-dir same-relpath pair still has a stable order.
  entries.sort((a, b) => {
    const c = Buffer.compare(a.rel, b.rel);
    if (c !== 0) return c;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  const hash = crypto.createHash('sha512');
  // Header: a fixed-width entry COUNT frames the whole stream (so a truncated/extended entry list
  // cannot be confused with a different bundle).
  hash.update(uint64be(entries.length));
  for (const ent of entries) {
    const pathBytes = ent.rel; // RAW path bytes (finding 4) — never utf8-decoded.
    if (ent.kind === 'dir') {
      // Typed DIR marker: tag + length-framed path. No content — binds the directory's mere existence.
      hash.update(TAG_DIR);
      hash.update(uint32be(pathBytes.length));
      hash.update(pathBytes);
      continue;
    }
    // FILE: tag + length-framed path + length-framed RAW content bytes (no utf8 decode).
    const content = ledgerMod.readSmallRegularFileBuffer(ent.abs, BUNDLE_MAX_FILE_BYTES);
    // null here would mean the file vanished between walk and read — fail closed.
    if (content === null) {
      throw new Error(`bundleContentHash: file vanished during hash: "${ent.abs.toString('utf8')}"`);
    }
    hash.update(TAG_FILE);
    hash.update(uint32be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64be(content.length));
    hash.update(content);
  }
  return `sha512-${hash.digest('base64')}`;
}

// ---------------------------------------------------------------------------
// Read (bounded, non-throwing)
// ---------------------------------------------------------------------------

/**
 * Validate a single record object. Rejects anything not matching the schema — a malformed/tampered
 * record is dropped (fail closed: it cannot grant consent). Returns true only for a structurally-
 * complete project-scope record carrying a contentHash binding.
 */
function isValidConsentRecord(rec: unknown): rec is ConsentRecord {
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return false;
  const r = rec as Record<string, unknown>;
  if (typeof r['projectRoot'] !== 'string' || !r['projectRoot']) return false;
  if (typeof r['id'] !== 'string' || isUnsafeCapabilityId(r['id'])) return false;
  if (r['scope'] !== 'project') return false;
  if (typeof r['integrity'] !== 'string') return false;
  if (typeof r['disclosureSignature'] !== 'string') return false;
  // The security binding MUST be present and non-empty — a record without a contentHash can never
  // match a recomputed hash and is treated as invalid (fail closed).
  if (typeof r['contentHash'] !== 'string' || !r['contentHash']) return false;
  if (typeof r['consentedAt'] !== 'string' || !r['consentedAt']) return false;
  // Optional (see ConsentRecord.reviewerHost): absent is valid and is the common case. Present but
  // non-string is a corrupt record — reject rather than silently comparing against a non-host.
  if (r['reviewerHost'] !== undefined && typeof r['reviewerHost'] !== 'string') return false;
  return true;
}

/**
 * Read the consent store. NON-THROWING and BOUNDED: a missing, corrupt, oversized, non-regular
 * (FIFO/device), or wrong-shape store yields an empty `{ records: {} }`. Invalid individual records
 * are dropped. A store whose record count exceeds MAX_RECORDS is refused wholesale (hostile DoS).
 */
function readConsentStore(gsdHome?: string): ConsentStore {
  const empty: ConsentStore = { records: {} };
  const filePath = consentStorePath(gsdHome);
  let raw: string | null;
  try {
    raw = ledgerMod.readSmallRegularFile(filePath, CONSENT_MAX_BYTES);
  } catch {
    // Non-regular (FIFO/device/dir), oversized, or IO error → fail closed to empty.
    return empty;
  }
  if (raw === null || raw === '') return empty; // genuinely missing / empty.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty; // corrupt JSON.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
  const p = parsed as Record<string, unknown>;
  const recordsVal = p['records'];
  if (typeof recordsVal !== 'object' || recordsVal === null || Array.isArray(recordsVal)) return empty;
  const records = recordsVal as Record<string, unknown>;
  const keys = Object.keys(records);
  if (keys.length > MAX_RECORDS) return empty; // hostile record count — refuse the whole store.
  // Re-key by the canonical NUL key so lookups never depend on the disk-key's serialization.
  const out: ConsentStore = { records: {} };
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue; // proto-safe.
    const rec = records[key];
    if (!isValidConsentRecord(rec)) continue;
    out.records[consentKey(rec.projectRoot, rec.id)] = rec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Has (the security match is the recomputed contentHash)
// ---------------------------------------------------------------------------

/**
 * True iff a consent record exists for `(realpath(projectRoot), id)` whose `contentHash` equals the
 * supplied (recomputed-by-the-loader) value. The contentHash is THE security binding (#1459
 * CB-1/CB-2): it covers the whole bundle (manifest AND artifacts AND identity), so a swapped
 * declarative manifest, a tampered hook script, or an empty-integrity local install all fail to
 * match. An unsafe id is rejected (→ false) before any lookup. Prototype-pollution-safe (NUL keys +
 * hasOwnProperty).
 */
function hasProjectConsent(args: {
  gsdHome?: string;
  projectRoot: string;
  id: string;
  contentHash: string;
}): boolean {
  const { gsdHome, projectRoot, id, contentHash } = args;
  if (isUnsafeCapabilityId(id)) return false;
  if (typeof contentHash !== 'string' || !contentHash) return false;
  const store = readConsentStore(gsdHome);
  const key = consentKey(realpathProject(projectRoot), id);
  if (!Object.prototype.hasOwnProperty.call(store.records, key)) return false;
  const rec = store.records[key];
  return rec.contentHash === contentHash;
}

// ---------------------------------------------------------------------------
// Cross-process mutual exclusion (CONSENT-CONCURRENCY-1) — via the SHARED lock primitive
// ---------------------------------------------------------------------------

type ConsentLock = { path: string; token: string; dev: number | null; ino: number | null };

/** The consent-store lock path — keyed on the consent store DIRECTORY (one lock per machine store). */
function consentLockPath(gsdHome?: string): string {
  return path.join(path.dirname(consentStorePath(gsdHome)), '.consent.lock');
}

/**
 * CONSENT-CONCURRENCY-1 (HIGH): record/revoke do a read-modify-write of the ONE global consent.json.
 * Two DIFFERENT projects writing the same store concurrently would lose-update without a lock (project B
 * reads, project A writes, project B overwrites with its stale snapshot, dropping A's record). The lock
 * is keyed on the consent store DIRECTORY so all consent writers on this machine serialize.
 *
 * #1459 finding 4 (MEDIUM): this now uses the SHARED hardened lock primitive (capability-lock) — the
 * SAME steal protocol as the lifecycle lock. The old self-contained consent lock stole any holder past
 * a 60s mtime regardless of liveness, so a slow/paused LIVE writer would be stolen and its store
 * overwritten (lost update). The shared primitive NEVER stale-steals a verified-live same-host holder
 * (pid + process-start-time identity) and reclaims only a provably-dead/unverifiable holder (dead-pid
 * fast path or the hard deadman) — so a live writer is never stolen and a crashed writer never deadlocks.
 */
function acquireConsentLock(dir: string): ConsentLock | null {
  // waitForFresh: a contended fresh/live holder is WAITED FOR (back off + retry), not failed-fast, so
  // two genuinely-racing consent writers serialize; null only when contention outlasts the budget.
  return lockMod.acquireLock(path.join(dir, '.consent.lock'), { maxAttempts: CONSENT_LOCK_MAX_ATTEMPTS, waitForFresh: true });
}

/** Release the consent lock (shared primitive — token + inode owner-safe; never deletes a successor's). */
function releaseConsentLock(handle: ConsentLock | null): void {
  lockMod.releaseLock(handle);
}

// ---------------------------------------------------------------------------
// Atomic + durable write (mirrors capability-ledger.writeLedger)
// ---------------------------------------------------------------------------

/**
 * Errnos from a directory fsync that are tolerated (platforms/filesystems disallowing dir fsync).
 * WIN-4 (#1459 round 2): ENOENT is tolerated too — the containing dir can vanish between rename and
 * fsync on an aggressively-swept tmp tree (Windows/CI), and a missing dir cannot be fsync'd.
 */
const DIR_FSYNC_TOLERATED_ERRNOS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF', 'ENOENT']);

/** fsync the directory containing `dest` so a rename is durable across a power loss (best-effort). */
function fsyncContainingDir(dest: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(path.dirname(dest), 'r');
    fs.fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && !DIR_FSYNC_TOLERATED_ERRNOS.has(code)) {
      throw new Error(
        `Directory fsync of "${path.dirname(dest)}" failed (${code}); durability of the consent ` +
        `store rename could NOT be confirmed: ${(err as Error).message}`,
      );
    }
    /* tolerated errno (or no code) — best-effort */
  } finally {
    if (dirFd !== null) { try { fs.closeSync(dirFd); } catch { /* best-effort */ } }
  }
}

/** WIN-1: rename errnos that are transient on Windows (AV scanner / indexer holding a brief lock). */
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;
let _renameSleepBuf: Int32Array | null = null;
function renameBackoff(): void {
  if (_renameSleepBuf === null) _renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(_renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}

/**
 * Serialize the store to disk atomically + durably (tmp with O_EXCL → write-all → fsync → close →
 * rename → dir fsync; temp cleaned up on any failure). Mirrors the capability-ledger writeLedger
 * durability idiom so a crash/power-loss mid-write can never produce a truncated consent store.
 *
 * WIN-1 / CONSENT-ATOMIC-WRITE parity (#1459 round 2): the renameSync is retried with backoff on the
 * transient Windows AV/indexer errnos (EPERM/EBUSY/EACCES), matching writeLedger.
 *
 * The on-disk JSON uses the unambiguous JSON-object disk key (WIN-3); the in-memory store is keyed by
 * the canonical NUL key, so we re-key here.
 */
function writeConsentStore(gsdHome: string | undefined, store: ConsentStore): void {
  const filePath = consentStorePath(gsdHome);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const onDisk: { version: string; records: Record<string, ConsentRecord> } = {
    version: CONSENT_SCHEMA_VERSION,
    records: {},
  };
  for (const key of Object.keys(store.records)) {
    const rec = store.records[key];
    onDisk.records[diskKey(rec.projectRoot, rec.id)] = rec;
  }
  const content = JSON.stringify(onDisk, null, 2) + '\n';

  const nonce = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}-${nonce}`;
  const fd = fs.openSync(tmpPath, 'wx'); // exclusive create — defeats a pre-planted symlink.
  let primaryErr: Error | null = null;
  try {
    fs.writeFileSync(fd, content); // write-all loop — no short writes.
    fs.fsyncSync(fd); // flush bytes to stable storage BEFORE the rename.
  } catch (err) {
    primaryErr = err instanceof Error ? err : new Error(String(err));
  } finally {
    let closeErr: Error | null = null;
    try { fs.closeSync(fd); } catch (err) { closeErr = err instanceof Error ? err : new Error(String(err)); }
    if (primaryErr !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — no orphan */ }
      throw primaryErr;
    }
    if (closeErr !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — no orphan */ }
      throw closeErr;
    }
  }
  // WIN-1: retry the rename on transient Windows AV/indexer locks before giving up (writeLedger parity).
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
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw renameErr;
  }
  fsyncContainingDir(filePath);
}

/**
 * Record a PROJECT-scope consent: that the user, on THIS machine, accepted capability `id` at the
 * given `projectRoot`, bound to the recomputed bundle `contentHash` (the security binding) plus the
 * `integrity` + `disclosureSignature` (kept for the disclosure/re-consent UX). Rejects an unsafe id
 * (throws, writing nothing). Idempotent: re-recording the same (projectRoot, id) overwrites in place;
 * other records are preserved.
 *
 * CONSENT-CONCURRENCY-1: the whole read-modify-write runs UNDER the consent-store lock so two
 * different projects writing concurrently cannot lose each other's record.
 * CONSENT-MAXRECORDS-WRITE-1: refuses to grow the store past MAX_RECORDS BEFORE writing (a clear
 * 'consent store full' throw), leaving the on-disk store intact.
 *
 * #1459 finding 3 (MEDIUM): if the consent-store lock CANNOT be acquired, this THROWS rather than
 * proceeding UNLOCKED — an unlocked read-modify-write is exactly the lost-update vector the lock exists
 * to prevent. The lifecycle treats a consent-write failure as NON-FATAL + warns (round-2 IC-05), so
 * throwing here is safe: an install still succeeds; the cap simply stays inactive until consent can be
 * written. (The OLD code returned a null handle and proceeded unlocked — that is the bug.)
 */
function recordProjectConsent(args: {
  gsdHome?: string;
  projectRoot: string;
  id: string;
  integrity: string;
  disclosureSignature: string;
  contentHash: string;
  reviewerHost?: string;
}): void {
  const { gsdHome, projectRoot, id, integrity, disclosureSignature, contentHash, reviewerHost } = args;
  if (isUnsafeCapabilityId(id)) {
    throw new Error(
      `Invalid capability id "${String(id)}": must match /^[a-z][a-z0-9-]*$/ (kebab-case, lowercase). ` +
      `Unsafe or non-kebab ids are rejected to keep the consent store prototype-pollution-safe.`,
    );
  }
  if (typeof contentHash !== 'string' || !contentHash) {
    throw new Error(
      `recordProjectConsent: a non-empty contentHash is required (it is the security binding). ` +
      `Compute it via bundleContentHash(capDir) over the installed bundle.`,
    );
  }
  const realRoot = realpathProject(projectRoot);
  const lockDir = path.dirname(consentStorePath(gsdHome));
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch { /* best-effort — write also mkdirs */ }
  // #1459 finding 3: never proceed UNLOCKED. A null handle (live holder / contention budget exhausted)
  // → throw rather than risk a lost update.
  const lock = acquireConsentLock(lockDir);
  if (lock === null) {
    throw new Error(
      `recordProjectConsent: could not acquire the consent-store lock at ${consentLockPath(gsdHome)} ` +
      `(another writer holds it). Refusing to write the consent store UNLOCKED (a lost-update risk). ` +
      `Retry; if a stale lock persists past the deadman it is reclaimed automatically.`,
    );
  }
  try {
    const store = readConsentStore(gsdHome);
    const key = consentKey(realRoot, id);
    // CONSENT-MAXRECORDS-WRITE-1: enforce the cap BEFORE the write. A re-record of an EXISTING key
    // does not grow the store (allowed); only ADDING a new key when already at the cap is refused.
    if (!Object.prototype.hasOwnProperty.call(store.records, key) && Object.keys(store.records).length >= MAX_RECORDS) {
      throw new Error(
        `consent store full: already at the maximum of ${MAX_RECORDS} consent records. Revoke an ` +
        `unused consent (gsd capability trust revoke) before recording a new one.`,
      );
    }
    store.records[key] = {
      projectRoot: realRoot,
      id,
      scope: 'project',
      integrity,
      disclosureSignature,
      contentHash,
      consentedAt: new Date().toISOString(),
      // Written only when the capability actually declares an egress destination, so a spawn lane
      // or a non-lane capability keeps a byte-identical record shape.
      ...(typeof reviewerHost === 'string' && reviewerHost ? { reviewerHost } : {}),
    };
    writeConsentStore(gsdHome, store);
  } finally {
    releaseConsentLock(lock);
  }
}

/**
 * Revoke a PROJECT-scope consent record. No-op (and never throws) when the record is absent or the
 * id is unsafe. Atomic, LOCKED write of the resulting store. Used on `capability remove` and
 * `trust revoke`.
 *
 * #1459 finding 3 (MEDIUM): if the consent-store lock CANNOT be acquired, this THROWS rather than
 * doing an unlocked read-modify-write (the lost-update vector). An ABSENT-record no-op still happens
 * UNDER the lock (so a concurrent record cannot interleave); only a genuine lock-acquire failure throws.
 */
function revokeProjectConsent(args: { gsdHome?: string; projectRoot: string; id: string }): void {
  const { gsdHome, projectRoot, id } = args;
  if (isUnsafeCapabilityId(id)) return; // an unsafe id was never stored — nothing to revoke.
  const realRoot = realpathProject(projectRoot);
  const lockDir = path.dirname(consentStorePath(gsdHome));
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch { /* best-effort — write also mkdirs */ }
  // #1459 finding 3: never proceed UNLOCKED — a null handle throws rather than deleting unlocked.
  const lock = acquireConsentLock(lockDir);
  if (lock === null) {
    throw new Error(
      `revokeProjectConsent: could not acquire the consent-store lock at ${consentLockPath(gsdHome)} ` +
      `(another writer holds it). Refusing to modify the consent store UNLOCKED (a lost-update risk). ` +
      `Retry; if a stale lock persists past the deadman it is reclaimed automatically.`,
    );
  }
  try {
    const store = readConsentStore(gsdHome);
    const key = consentKey(realRoot, id);
    if (!Object.prototype.hasOwnProperty.call(store.records, key)) return; // absent — no-op.
    delete store.records[key];
    writeConsentStore(gsdHome, store);
  } finally {
    releaseConsentLock(lock);
  }
}

/**
 * The egress destination a capability's consent was granted against, or `undefined`.
 *
 * ADR-2782 D5 rule 4 (#2799) — read on the INVOCATION path, not only at install, because
 * `hostConfigKey` names a key in `.planning/config.json`: the one consent-bound value that lives
 * outside the SHA-pinned bundle and can be changed by an ordinary pull request with no re-install
 * and no integrity check.
 *
 * `undefined` means "nothing to compare", and the caller MUST treat that as allow, not deny. Two
 * legitimate ways to get it: the capability has no consent record at all (first-party lanes ship
 * inside the SHA-pinned distribution and are never consent-gated), or the record predates this
 * field. Denying on absence would break every existing local-model user on upgrade.
 *
 * Non-throwing: a missing, corrupt, or oversized store yields `undefined` like any other absence.
 */
function readConsentedReviewerHost(args: {
  gsdHome?: string;
  projectRoot: string;
  id: string;
}): string | undefined {
  const { gsdHome, projectRoot, id } = args;
  if (isUnsafeCapabilityId(id)) return undefined;
  try {
    const store = readConsentStore(gsdHome);
    const key = consentKey(realpathProject(projectRoot), id);
    if (!Object.prototype.hasOwnProperty.call(store.records, key)) return undefined;
    const host = store.records[key].reviewerHost;
    return typeof host === 'string' && host ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #1459 finding 2 (round 6): TEST-ONLY — override the cumulative bundle entry-count cap and return a
 * restore() that resets it to the production default. Lets a test prove the streaming walk fails closed
 * at the bound without planting 100k real files. Never called by production code.
 */
function _setBundleMaxFilesForTest(n: number): () => void {
  const prev = BUNDLE_MAX_FILES;
  BUNDLE_MAX_FILES = n;
  return () => { BUNDLE_MAX_FILES = prev; };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  consentStorePath,
  bundleContentHash,
  readConsentStore,
  readConsentedReviewerHost,
  hasProjectConsent,
  recordProjectConsent,
  revokeProjectConsent,
  // Exported for testing / introspection.
  MAX_RECORDS,
  CONSENT_FILE_NAME,
  // #1459 finding 3/4: the consent-store lock path + the shared lock primitive's test seams (so tests
  // can plant a lock and inject deterministic liveness probes to verify the never-steal-a-live-writer
  // and dead-holder-reclaim behavior). Not part of the CLI surface.
  consentLockPath,
  _setLockProbes: lockMod._setLockProbes,
  _resetLockProbes: lockMod._resetLockProbes,
  // #1459 finding 2 (round 6): a TEST-ONLY seam to drive the cumulative entry-count cap deterministically
  // (so a test can prove the streaming walk fails closed at the bound without planting 100k real files).
  // Returns a restore() that resets the cap to its production default. Not part of the CLI surface.
  _setBundleMaxFilesForTest,
};
