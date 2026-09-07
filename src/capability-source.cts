/**
 * capability-source.cts — Capability source resolver (ADR-1244 Phase 3, Decision D3).
 *
 * One seam `resolveCapabilitySource(spec, opts)` with an adapter per source kind.
 * Each adapter: fetch → verify integrity/SHA → check engines.gsd → return a STAGED,
 * VALIDATED bundle.
 *
 * SECURITY CONTRACT:
 *   - Install NEVER executes capability code. Copy/extract only.
 *   - All subprocesses routed through shell-command-projection.cjs seam (windowsHide,
 *     argv arrays, no shell string interpolation).
 *   - Integrity verified BEFORE extraction when provided.
 *   - engines.gsd pre-checked before staging.
 *   - Full validator suite run on manifest before finalizing.
 *   - Staging atomicity: stage under .staging/<id>-<pid>-<ts>/, renameSync on success,
 *     rmSync on any failure.
 *   - No raw spawnSync / execSync / shell strings.
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 *
 * Exports: resolveCapabilitySource, parseSpec, _setCapabilitySourceHttpGet,
 *          _setHttpsGetImpl, _readManifestBounded, MAX_RESPONSE_BYTES,
 *          MANIFEST_MAX_BYTES, MAX_STAGED_BUNDLE_BYTES, MAX_STAGED_BUNDLE_ENTRIES
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellSeam = require('./shell-command-projection.cjs') as {
  execGit: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execNpm: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execTool: (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  retryRenameSync: (fromPath: string, toPath: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const capValidator = require('./capability-validator.cjs') as ValidatorModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs') as {
  semverSatisfies: (version: unknown, range: unknown) => boolean;
  compareSemverCore: (a: unknown, b: unknown) => -1 | 0 | 1;
  isStableTripletSemver: (v: unknown) => boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ledgerMod = require('./capability-ledger.cjs') as {
  /** Shared fd-based bounded reader: content, null for ENOENT, or THROWS (non-regular/oversized/IO). */
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
  /** Shared structural ledger-entry validator — the loader's committed-entry test (#3929). */
  isValidLedgerEntry: (id: unknown, entry: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

/** First-party capability registry (`capability-registry.cjs`) — the generated build artifact. */
interface RegistryModule {
  capabilities?: Record<string, unknown>;
}

/** Registry generator — the loader's source for the central config-schema key set. */
interface GeneratorModule {
  loadCentralConfigKeys: () => Set<string>;
}

interface ValidatorModule {
  validateCapability: (cap: unknown, id: string) => string[];
  materializeHookFragments: (cap: unknown, capDir: string) => string[];
  validateAgainstContract: (cap: unknown, capId: string) => string[];
  validateConsumesGlobal: (capMap: Map<string, unknown>) => string[];
  validateCrossCapability: (capMap: Map<string, unknown>, centralKeys: Set<string>) => string[];
}

/** Parsed spec discriminant. */
type SpecKind = 'registry' | 'git' | 'npm' | 'tarball' | 'local';

interface ParsedSpec {
  kind: SpecKind;
  /** The original raw spec string. */
  raw: string;
  /** Resolved URL / path / package-spec, depending on kind. */
  target: string;
  /** Optional ref (git only). */
  ref?: string;
}

/** Tar-only exec signature (program is always 'tar', injected for testability). */
type TarExecFn = (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;

/** Options accepted by resolveCapabilitySource. */
interface ResolveOptions {
  /** Running GSD version. Defaults to package.json version, fail-closed to '0.0.0'. */
  hostVersion?: string;
  /** Override the GSD home directory (where .gsd/capabilities/ lives). */
  gsdHome?: string;
  /** Expected integrity string (`sha512-<base64>`). When provided, integrity is verified
   *  before any bytes are committed to the final location. */
  integrity?: string;
  /**
   * When false, stop after validation and return the staging dir WITHOUT promoting it to the
   * final capabilities location. The caller then owns the atomic stage-then-swap + ledger
   * commit ordering (ADR-1244 Phase 4 / D6 upgrade path). Defaults to true (promote in place),
   * preserving the original install behavior.
   */
  promote?: boolean;
  /**
   * When true, SKIP the resolver's `engines.gsd` hard-throw during staging. The caller becomes
   * responsible for the engines gate. Used by capability-lifecycle so its own `checkEngines` can
   * gate the install AND surface a `compatVersions` downgrade hint (the resolver throw would
   * pre-empt that). Staging remains copy-only and is never promoted by the lifecycle when the
   * engines check fails, so nothing incompatible is ever activated. Defaults to false (throw).
   */
  skipEnginesGate?: boolean;
  /** Injectable exec overrides for tests — keys match the shell-seam functions. */
  execOverrides?: {
    git?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    npm?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    tar?: TarExecFn;
  };
}

/** Resolved + staged bundle descriptor. */
interface ResolveResult {
  id: string;
  version: string;
  stagedDir: string;
  /** sha512-<base64> digest of the staged capability.json, or null for local/git sources. */
  integrity: string | null;
  /** The original spec string. */
  source: string;
}

/** Injectable HTTP response shape. */
interface HttpResponse {
  statusCode: number;
  body: Buffer;
}

type HttpGetFn = (url: string) => Promise<HttpResponse>;

/**
 * DOS-1 (#1461): GENEROUS but BOUNDED cap on a fetched capability source response. `realHttpsGet`
 * previously accumulated `res.on('data')` chunks with NO ceiling, so a hostile or accidental
 * oversized tarball (e.g. an HTTP endpoint streaming gigabytes) would buffer unbounded into memory
 * and OOM the process. A real capability bundle is a few hundred KiB of declarative JSON + small
 * artifacts; 64 MiB is far more than any legitimate bundle yet still a hard ceiling. Enforced two
 * ways: (1) a `content-length` header over the cap is rejected BEFORE buffering any body; (2) the
 * cumulative streamed byte count is tracked across `data` events and the request is destroyed +
 * rejected the instant it exceeds the cap (covers chunked / missing-content-length responses).
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * #1461 finding 2 (HIGH): GENEROUS but BOUNDED cap on an UNTRUSTED `capability.json` read during
 * resolve/staging. Every untrusted manifest (tarball / npm / git / local staging) MUST be read via
 * the SHARED bounded reader (`readSmallRegularFile`: open → fstat → require-regular-file → size-cap →
 * read-exactly-size), NOT a raw `fs.readFileSync`. A raw read of an oversized extracted-or-local
 * `capability.json` reads unbounded into memory (OOM), and a FIFO/device/non-regular manifest BLOCKS
 * the resolver forever. A legitimate manifest is a few KiB of declarative JSON; 8 MiB is far more than
 * any real capability.json yet a hard ceiling. The reader returns null for a genuinely-missing file
 * (ENOENT) and THROWS for non-regular/oversized/IO — both are mapped to a clear "manifest not
 * found / refused" rejection (fail-closed: the source never resolves).
 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * #1461 finding 1 (HIGH): ONE uniform aggregate byte-budget over the STAGED bundle directory. The HTTP
 * fetch is capped (MAX_RESPONSE_BYTES), but `copyDirRecursive` / `fs.copyFileSync`, `git clone`,
 * `npm pack`, and `tar -x` were only TIMEOUT-bounded — so a huge local source tree, a giant git repo, a
 * large npm package, or a gzip/tar bomb that expands far beyond the compressed download cap could fill
 * disk during staging. This single budget, enforced at the common staging chokepoint (stageValidated,
 * AFTER the source is copied into staging and BEFORE validation/promotion), uniformly bounds the RESULT
 * of every adapter: it sums the regular-file bytes of the staged dir via a BOUNDED streaming walk and
 * fails closed if the total exceeds the cap. 128 MiB is generous for a real capability bundle (a few
 * hundred KiB of declarative JSON + small artifacts) yet hard-bounds a bomb.
 *
 * RESIDUAL (#1461 finding 4): this bounds the staged RESULT — it rejects an oversized install BEFORE
 * promotion, but a transient disk-fill DURING extraction/clone (before the post-staging walk runs) is a
 * residual a fully-airtight bound would need a streaming byte-quota DURING extraction/clone (e.g. a
 * cgroup/disk-quota or a custom streaming extractor) to close. This is a stated, proportionate limit:
 * this resolver path is USER-INITIATED `install` only (the cloned-repo / loader overlay path does NOT
 * invoke the resolver and is bounded separately by capability-consent's bundleContentHash caps), and
 * staging happens under a temp/.staging dir that is rmSync'd on any failure.
 */
const MAX_STAGED_BUNDLE_BYTES = 128 * 1024 * 1024;

/**
 * #1461 finding 1: a cumulative ENTRY-count ceiling for the staged-dir budget walk so the enumeration
 * ITSELF is bounded (a hostile bundle with millions of tiny files / a very deep tree cannot force
 * unbounded readdir work before the byte cap trips). 100k entries is far more than any real bundle.
 */
const MAX_STAGED_BUNDLE_ENTRIES = 100_000;

/**
 * The low-level `https.get`-shaped transport. Extracted as an overridable module-level reference so
 * a test can inject a fake response stream (chunked / oversized / content-length-tagged) to exercise
 * the MAX_RESPONSE_BYTES enforcement in realHttpsGet WITHOUT real network I/O. Defaults to the real
 * node:https get. (The higher-level `_httpGet` seam below short-circuits realHttpsGet entirely and is
 * used by the integrity tests; this seam is specifically for the streaming/size-cap path.)
 */
type HttpsGetImpl = typeof https.get;
let _httpsGetImpl: HttpsGetImpl = https.get;

/** Test seam: override the low-level https.get transport used by realHttpsGet. Pass null to restore. */
function _setHttpsGetImpl(fn: HttpsGetImpl | null): void {
  _httpsGetImpl = fn ?? https.get;
}

// ---------------------------------------------------------------------------
// Injectable HTTP transport (test seam)
// ---------------------------------------------------------------------------

/**
 * #3514 (epic #1900 F21): pre-transport fetch gate. Runs BEFORE any bytes leave and before the
 * (possibly injected) transport is invoked:
 *
 *  - Non-`https` URLs are refused with a NAMED, actionable reason. parseSpec still CLASSIFIES an
 *    `http://` tarball URL as tarball (no parse-time hard reject — internal-mirror classification
 *    flows stay intact, the adopted split decision on the epic); the https-only transport then
 *    fails clearly instead of with a raw ERR_INVALID_PROTOCOL.
 *  - Loopback / link-local / metadata / unspecified hosts and `localhost`-form names are denied
 *    unconditionally — no legitimate capability install fetches them. RFC1918 private ranges are
 *    deliberately ALLOWED (internal mirrors are the legitimate use this leaves room for); the
 *    denylist is not an allowlist.
 *
 * Known limit (disclosed): the check is on the URL's HOST LITERAL. A public hostname that
 * RESOLVES via DNS to a denied range (rebinding) is out of scope — `https.get` resolves
 * internally and this gate does not double-resolve.
 */
function assertFetchableUrl(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid capability source URL: "${rawUrl}"`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(
      `capability source fetch requires https — refusing "${u.protocol}" URL (host "${u.hostname}"). ` +
        'The transport never fetches plaintext http; for an internal mirror use an https URL or a local path source.'
    );
  }
  // Node's URL.hostname KEEPS the brackets on IPv6 literals ('[::1]') — strip them so the
  // v6 checks below see the bare address. A single trailing dot is FQDN syntax ('localhost.'
  // is the same name as 'localhost'; some resolvers synthesize loopback for it) — strip it.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const deniedHost = () =>
    new Error(
      `refusing to fetch capability source from internal host "${host}" (loopback/link-local/metadata denylist)`
    );
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw deniedHost();
  }
  // IPv4 literal: 127/8 loopback, 0/8 unspecified, 169.254/16 link-local (contains the cloud
  // metadata IPs). Malformed literals that match no range simply fall through to a failed
  // resolution downstream — denying is not needed for safety there.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) throw deniedHost();
    return;
  }
  // IPv6-literal checks. A registered domain NEVER contains ':' after bracket-strip, while every
  // IPv6 literal does — that colon is the guard. Without it, the fe80::/10 prefix test below
  // would deny legitimate domains like 'feather.internal' or 'february.example.com' (isolated
  // review finding — a domain-shaped host must never reach the v6 branch).
  if (!host.includes(':')) {
    return;
  }
  // An IPv4-mapped address re-checks as IPv4 — in EITHER spelling, because the URL parser may
  // preserve the dotted form ('::ffff:127.0.0.1') or normalize to hex hextets ('::ffff:7f00:1').
  // Otherwise deny ::1 (loopback), :: (unspecified), and fe80::/10 (link-local, hex prefix range
  // fe80–febf).
  if (host.startsWith('::ffff:')) {
    const suffix = host.slice('::ffff:'.length);
    let v4str: string | null = null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) {
      v4str = suffix;
    } else {
      const hextets = suffix.split(':');
      if (hextets.length === 2 && /^[\da-f]{1,4}$/.test(hextets[0]) && /^[\da-f]{1,4}$/.test(hextets[1])) {
        const hi = parseInt(hextets[0], 16);
        const lo = parseInt(hextets[1], 16);
        v4str = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      }
    }
    if (v4str) {
      assertFetchableUrl(`https://${v4str}/`);
      return;
    }
  }
  // fe80::/10 = hex prefix fe80..febf, i.e. /^fe[89ab]/ (third nibble 8-b has top two bits set).
  if (host === '::1' || host === '::' || /^fe[89ab]/.test(host)) {
    throw deniedHost();
  }
}

function realHttpsGet(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    // #3514: gate BEFORE the transport — scheme + host denylist refuse with named errors and
    // never invoke the (possibly injected) transport. A throw inside the executor rejects.
    try {
      assertFetchableUrl(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const req = _httpsGetImpl(
      url,
      { headers: { 'User-Agent': 'gsd-core-capability-source/1.0' } },
      (res) => {
        // DOS-1: reject early if the server ADVERTISES a body over the cap — no bytes buffered.
        const contentLength = Number(res.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          req.destroy();
          res.destroy?.();
          reject(
            new Error(
              `response exceeds ${MAX_RESPONSE_BYTES} bytes (content-length ${contentLength}) fetching ${url}`
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;
        res.on('data', (c: Buffer) => {
          if (aborted) return;
          received += c.length;
          // DOS-1: enforce the ceiling on the ACTUAL streamed bytes (covers chunked / lying or
          // absent content-length). Destroy the request/response and reject — never keep buffering.
          if (received > MAX_RESPONSE_BYTES) {
            aborted = true;
            req.destroy();
            res.destroy?.();
            reject(new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes fetching ${url}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? 0} fetching ${url}`));
            return;
          }
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`timeout after 30000ms fetching ${url}`));
    });
    req.on('error', reject);
  });
}

let _httpGet: HttpGetFn = realHttpsGet;

/**
 * Test seam: replace the HTTP transport. Pass null to restore the real transport.
 */
function _setCapabilitySourceHttpGet(fn: HttpGetFn | null): void {
  _httpGet = fn ?? realHttpsGet;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the running GSD version; fail-closed to '0.0.0'.
 *
 * Prefer the authoritative `gsd-core/VERSION` the installer writes for EVERY runtime
 * (libDir = gsd-core/bin/lib/, so `../../VERSION` = gsd-core/VERSION), so installed
 * layouts report the true version even when the walked-up `../../../package.json` is
 * absent or belongs to the user's own project (#1920). Fall back to the runtime-root
 * package.json (dev/source tree), then fail-closed. Mirrors resolveVersionFrom() (#1383).
 */
function readHostVersion(libDir: string = __dirname): string {
  const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;
  try {
    const v = fs.readFileSync(path.join(libDir, '..', '..', 'VERSION'), 'utf8').trim();
    if (SEMVER_PREFIX.test(v)) return v;
  } catch { /* not an installed tree (no gsd-core/VERSION) */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.join(libDir, '..', '..', '..', 'package.json')) as { version?: string };
    if (pkg && typeof pkg.version === 'string' && SEMVER_PREFIX.test(pkg.version)) return pkg.version;
  } catch { /* runtime root has no package.json */ }
  return '0.0.0';
}

/** Compute sha512-<base64> integrity over a buffer. */
function computeIntegrity(buf: Buffer): string {
  const digest = crypto.createHash('sha512').update(buf).digest('base64');
  return `sha512-${digest}`;
}

/** Verify buf against an `sha512-<base64>` integrity string. Throws on mismatch. */
function verifyIntegrity(buf: Buffer, expected: string): void {
  const prefix = 'sha512-';
  if (!expected.startsWith(prefix)) {
    throw new Error(`Unsupported integrity algorithm (expected sha512-<base64>): ${expected}`);
  }
  const expectedBase64 = expected.slice(prefix.length);
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== expectedBase64) {
    throw new Error(
      `Integrity mismatch: expected sha512-${expectedBase64} but got sha512-${actual}`
    );
  }
}

/**
 * #1461 finding 2 (HIGH): read an UNTRUSTED `capability.json` (extracted or local) via the SHARED
 * bounded reader and parse it as a JSON object, failing CLOSED on every untrusted-input condition.
 * Replaces the raw `fs.readFileSync(manifestPath,'utf8')` at each resolve/staging site so an oversized
 * manifest cannot read unbounded (OOM) and a FIFO/device/non-regular manifest cannot BLOCK forever.
 *   - ENOENT (reader returns null) → throw `<notFoundMessage>` (genuinely missing).
 *   - non-regular / oversized / IO (reader THROWS)  → throw `<notFoundMessage>: <reason>` (refused).
 *   - not valid JSON  → throw the caller's invalid-JSON message.
 *   - not a JSON object  → throw the caller's not-an-object message.
 */
function readManifestBounded(
  manifestPath: string,
  notFoundMessage: string,
): Record<string, unknown> {
  let raw: string | null;
  try {
    raw = ledgerMod.readSmallRegularFile(manifestPath, MANIFEST_MAX_BYTES);
  } catch (err) {
    // Non-regular (FIFO/device/dir), oversized, or IO error — fail closed with a clear message.
    throw new Error(`${notFoundMessage}: ${(err as Error).message}`);
  }
  if (raw === null) {
    throw new Error(notFoundMessage); // genuinely missing (ENOENT).
  }
  let cap: unknown;
  try {
    cap = JSON.parse(raw);
  } catch {
    throw new Error('capability.json is not valid JSON');
  }
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    throw new Error('capability.json must be a JSON object');
  }
  return cap as Record<string, unknown>;
}

/**
 * #1460 CS-1: read a locally-produced `npm pack` `.tgz` as RAW BYTES via a bounded fd read so a
 * supplied `--integrity` can be verified over the tarball (same SRI sha512 domain as the tarball
 * adapter) before extraction/staging. `readSmallRegularFile` decodes utf8 (corrupting binary), so
 * this reads the Buffer directly while keeping the same fail-closed discipline: open → fstat →
 * require a regular file (a FIFO/device cannot BLOCK or be misread) → size-cap (MAX_RESPONSE_BYTES,
 * the same ceiling the HTTP fetch enforces) → read exactly fstat.size bytes.
 */
function readPackTarball(tgzPath: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(tgzPath, 'r');
  } catch (err) {
    throw new Error(`Cannot read npm pack tarball: ${tgzPath}: ${(err as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Refusing to read non-regular npm pack tarball: ${tgzPath}`);
    }
    if (st.size > MAX_RESPONSE_BYTES) {
      throw new Error(`npm pack tarball exceeds ${MAX_RESPONSE_BYTES} bytes: ${tgzPath}`);
    }
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return read === st.size ? buf : buf.subarray(0, read);
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

/**
 * Reject spec/id values containing path separators or `..`.
 * Throws if the id is unsafe.
 */
function assertSafeId(id: string): void {
  if (!id || /[/\\]/.test(id) || id.includes('..')) {
    throw new Error(
      `Capability id "${id}" is invalid: must be kebab-case with no path separators or ".."`
    );
  }
}

// Shell-injection metacharacters + whitespace/control. execNpm runs under a shell
// on Windows (the npm shim), so an npm: spec must not carry any of these — they are
// never valid in a real npm package spec (scope/name@version|tag|^range|~range).
const SHELL_METACHAR_RE = /[;&|$`()<>!"'\\%\s]/;

/** Reject an npm package spec that could break out of the (Windows) shell. */
function assertSafeNpmSpec(pkgSpec: string): void {
  if (SHELL_METACHAR_RE.test(pkgSpec)) {
    throw new Error(`Unsafe npm package spec (shell metacharacters not allowed): "${pkgSpec}"`);
  }
}

/**
 * Allowlist git transports. Git's `ext::`/`fd::` remote helpers are external-command
 * bridges (arbitrary code execution if protocol.*.allow is permissive), and `file://`
 * enables local-path tricks — only network transports are permitted.
 */
function assertSafeGitUrl(url: string): void {
  if (!/^(https?|ssh|git):\/\//i.test(url)) {
    throw new Error(
      `Unsupported git transport for "${url}": only https://, ssh://, and git:// are allowed`
    );
  }
}

/**
 * Copy a directory tree recursively into destDir — STREAMING and BUDGETED.
 *
 * SECURITY: symlinks are REJECTED (fail closed). A fetched bundle could otherwise
 * smuggle a symlink (e.g. `id_rsa -> ~/.ssh/id_rsa`) that fs.copyFileSync would
 * FOLLOW, copying an arbitrary host file's bytes into the staged capability dir.
 * Dirent.isSymbolicLink() reflects the entry itself (lstat semantics), so this
 * catches both file and directory symlinks before any copy.
 *
 * #1461 finding 1 (HIGH, ROUND 2): the copy ITSELF is bounded. The former
 * `fs.readdirSync(src, { withFileTypes: true })` materialized the ENTIRE directory-entry
 * array into memory BEFORE any budget could run — and copyDirRecursive runs at staging time
 * BEFORE the post-copy assertStagedBundleWithinBudget walk. So a hostile local/git/npm/tar
 * source whose tree has a directory holding millions of tiny files (fetch < 64 MiB, but a
 * colossal dirent array) OOMs the process during the COPY, before the post-copy budget can
 * fail closed. We now STREAM each directory via fs.opendirSync + dir.readSync() (one entry at
 * a time, never the whole array) and thread CUMULATIVE counters across the recursion — total
 * entries (cap MAX_STAGED_BUNDLE_ENTRIES) and total regular-file bytes (cap
 * MAX_STAGED_BUNDLE_BYTES) — throwing the MOMENT either is exceeded, DURING the copy, before
 * reading/copying the rest. The shared mutable `budget` object mirrors bundleContentHash's
 * cumulative walk in capability-consent. The throw propagates to stageValidated's catch, which
 * rmSync's the staging dir (fail closed, no partial bundle promoted).
 */
function copyDirRecursive(
  src: string,
  dest: string,
  budget: { entries: number; bytes: number } = { entries: 0, bytes: 0 },
): void {
  fs.mkdirSync(dest, { recursive: true });
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(src);
  } catch (err) {
    throw new Error(`Cannot read source directory "${src}": ${(err as Error).message}`);
  }
  try {
    for (;;) {
      let entry: fs.Dirent | null;
      try {
        entry = dir.readSync();
      } catch (err) {
        throw new Error(`Cannot read source directory "${src}": ${(err as Error).message}`);
      }
      if (entry === null) break;

      // BOUND THE ENUMERATION ITSELF: count this entry and fail closed BEFORE it is processed,
      // so a huge directory (or deep tree) is never read in full into memory first.
      budget.entries++;
      if (budget.entries > MAX_STAGED_BUNDLE_ENTRIES) {
        throw new Error(
          `Refusing to stage bundle: entry count exceeds the maximum of ${MAX_STAGED_BUNDLE_ENTRIES}`
        );
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to stage symlink in capability bundle: ${entry.name}`);
      } else if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath, budget);
      } else if (entry.isFile()) {
        // Cumulative byte budget: lstat the entry (NOT stat — a symlink is already rejected above,
        // but lstat is the authoritative size of the regular file being copied) and fail closed the
        // MOMENT the running total crosses the cap, BEFORE copying the oversized file's bytes.
        let st: fs.Stats;
        try {
          st = fs.lstatSync(srcPath);
        } catch (err) {
          throw new Error(`Cannot lstat source entry "${srcPath}": ${(err as Error).message}`);
        }
        budget.bytes += st.size;
        if (budget.bytes > MAX_STAGED_BUNDLE_BYTES) {
          throw new Error(
            `Refusing to stage bundle: total staged size exceeds the maximum of ` +
            `${MAX_STAGED_BUNDLE_BYTES} bytes (possible oversized source tree, git repo, npm package, or tar bomb)`
          );
        }
        fs.copyFileSync(srcPath, destPath);
      }
      // Non-regular entries (sockets, fifos, devices) are silently skipped.
    }
  } finally {
    try { dir.closeSync(); } catch { /* best-effort: no fd leak per opened Dir */ }
  }
}

/**
 * #1461 finding 1 (HIGH): sum the total regular-file bytes under `stagedDir` via a BOUNDED streaming
 * walk and fail closed if the total exceeds MAX_STAGED_BUNDLE_BYTES. This is the SINGLE uniform bound on
 * the RESULT of staging for EVERY adapter (local copy / git clone / npm pack / tar extraction) — placed
 * at the common chokepoint in stageValidated AFTER copyDirRecursive and BEFORE validation/promotion.
 *
 * Bounded like capability-consent.bundleContentHash's enumeration: each level is STREAMED via
 * fs.opendirSync + dir.readSync() with a CUMULATIVE entry counter (`count.n`) that throws the moment it
 * exceeds MAX_STAGED_BUNDLE_ENTRIES — BEFORE the rest of a huge/deep level is read — so a hostile bundle
 * with millions of tiny files or a very deep tree cannot force unbounded readdir/memory work before the
 * byte cap trips. Per-entry: lstat (NOT stat) so a symlink is detected as itself; symlinks and other
 * non-regular entries are REJECTED (fail closed — copyDirRecursive already refuses symlinks at copy time,
 * but a fresh lstat here is the authoritative check on what actually landed in staging). Regular-file
 * st.size is accumulated and the walk throws the moment the running total crosses the cap.
 */
function assertStagedBundleWithinBudget(stagedDir: string): void {
  const total = { bytes: 0 };
  const count = { n: 0 };
  const walk = (absDir: string): void => {
    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(absDir);
    } catch (err) {
      throw new Error(`Cannot read staged directory "${absDir}": ${(err as Error).message}`);
    }
    const levelEntries: fs.Dirent[] = [];
    try {
      for (;;) {
        let ent: fs.Dirent | null;
        try {
          ent = dir.readSync();
        } catch (err) {
          throw new Error(`Cannot read staged directory "${absDir}": ${(err as Error).message}`);
        }
        if (ent === null) break;
        // BOUND THE ENUMERATION ITSELF: fail closed before this entry is retained, so a huge directory
        // (or deep tree) cannot be loaded in full first.
        count.n++;
        if (count.n > MAX_STAGED_BUNDLE_ENTRIES) {
          throw new Error(
            `Refusing to stage bundle: entry count exceeds the maximum of ${MAX_STAGED_BUNDLE_ENTRIES}`
          );
        }
        levelEntries.push(ent);
      }
    } finally {
      try { dir.closeSync(); } catch { /* best-effort */ }
    }
    for (const ent of levelEntries) {
      const abs = path.join(absDir, ent.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        throw new Error(`Cannot lstat staged entry "${abs}": ${(err as Error).message}`);
      }
      if (st.isSymbolicLink()) {
        // Defense in depth: copyDirRecursive already refuses symlinks, but the budget walk is the
        // authoritative re-check on what actually landed in staging.
        throw new Error(`Refusing to stage symlink in capability bundle: ${abs}`);
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) {
        // Sockets / FIFOs / devices are not part of a real capability bundle.
        throw new Error(`Refusing to stage non-regular file in capability bundle: ${abs}`);
      }
      total.bytes += st.size;
      if (total.bytes > MAX_STAGED_BUNDLE_BYTES) {
        throw new Error(
          `Refusing to stage bundle: total staged size exceeds the maximum of ` +
          `${MAX_STAGED_BUNDLE_BYTES} bytes (possible oversized source tree, git repo, npm package, or tar bomb)`
        );
      }
    }
  };
  walk(stagedDir);
}

/**
 * Defense-in-depth against tar-slip: list the archive members and reject any with
 * an absolute path or a `..` segment BEFORE extraction (system tar mostly guards
 * this, but the hard contract is "traversal rejected", so we verify explicitly).
 * Symlink members that survive extraction are caught later by copyDirRecursive.
 *
 * #1461 finding 2 (MED): the former per-member declared-size parse (parseTarMemberSize) was REMOVED.
 * It scanned the verbose listing for a date-looking token and treated the previous token as the size,
 * but on BSD `tar -tv` the owner/group columns PRECEDE the size, so a member owner/group like "Jan"
 * mis-anchored the scan → fail-OPEN (a bomb's real size column skipped). The staged-dir aggregate
 * budget (assertStagedBundleWithinBudget, #1461 finding 1) is now the real, non-spoofable bound on the
 * extracted RESULT, so the fragile header parse is redundant. This function keeps only the NAME and
 * TYPE guards (traversal / symlink / hardlink), which are unambiguous and not size-dependent.
 */
function assertSafeTarMembers(execTar: TarExecFn, tgzPath: string): void {
  // (1) Member NAMES — reject path traversal (absolute / "..").
  const listing = execTar('tar', ['-tzf', tgzPath], { timeout: 60_000 });
  if (listing.exitCode !== 0) {
    throw new Error(`tar listing failed (exit ${listing.exitCode}): ${listing.stderr}`);
  }
  for (const line of listing.stdout.split('\n')) {
    const member = line.trim();
    if (!member) continue;
    if (member.startsWith('/') || path.isAbsolute(member) || member.split(/[/\\]/).includes('..')) {
      throw new Error(`Refusing to extract tarball with unsafe member path: "${member}"`);
    }
  }
  // (2) Member TYPES — reject symlink/hardlink members BEFORE extraction. A symlink
  // member with a safe name is created during `tar -x` and a later member can be
  // written THROUGH it to escape the extract dir (the post-extraction copy guard is
  // too late). The verbose listing marks links: leading 'l'/'h' in the mode column
  // and a " -> " / " link to " suffix (GNU + bsd tar).
  const verbose = execTar('tar', ['-tvzf', tgzPath], { timeout: 60_000 });
  if (verbose.exitCode !== 0) {
    throw new Error(`tar verbose listing failed (exit ${verbose.exitCode}): ${verbose.stderr}`);
  }
  for (const line of verbose.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes(' -> ') || line.includes(' link to ') || /^\s*[lh]/.test(line)) {
      throw new Error('Refusing to extract tarball containing a symlink or hardlink member');
    }
  }
}

// ---------------------------------------------------------------------------
// Install-time cross-validation seeding (#3929)
// ---------------------------------------------------------------------------

/** Ledger size bound — the SAME cap the loader reads the untrusted per-scope ledger with. */
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Ids in the target scope's ledger that are COMMITTED — a structurally-valid entry carrying no
 * in-flight `_pending` intent. Mirrors the loader's `ledgerOverlayIds` classification (ADR-1244
 * Phase 5 / D7): a bundle merely sitting on disk with no committed entry was never consented, the
 * loader will not compose it, so it must not satisfy another capability's `requires` at install
 * time either. Never throws — a missing/invalid/non-regular/oversized ledger yields an empty set
 * (fail closed: no overlay joins the validation set).
 */
function committedOverlayIds(gsdHome: string): Set<string> {
  const committed = new Set<string>();
  try {
    const ledgerPath = path.join(gsdHome, '.gsd-capabilities.json');
    const content = ledgerMod.readSmallRegularFile(ledgerPath, LEDGER_MAX_BYTES);
    if (content === null) return committed; // genuinely missing — nothing installed yet.
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return committed;
    const entries = (parsed as Record<string, unknown>)['entries'];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return committed;
    for (const [entryId, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(entry, '_pending')) continue; // intent ⇒ uncommitted.
      if (ledgerMod.isValidLedgerEntry(entryId, entry)) committed.add(entryId);
    }
  } catch { /* missing / invalid / oversized ledger — no committed overlays (fail closed) */ }
  return committed;
}

/**
 * Central config-schema keys, resolved the way the loader resolves them. Falls back to an empty
 * Set on any failure — the SAME fail-open `loadRegistry` takes, so a packaging layout without the
 * generator degrades to today's behavior instead of blocking installs.
 */
function centralConfigKeys(): Set<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const generator: GeneratorModule = require('../../../scripts/gen-capability-registry.cjs');
    const keys = generator.loadCentralConfigKeys();
    return keys instanceof Set ? keys : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

/**
 * Canonical identity of an overlay root, used to dedup the global and target roots when they are the
 * same directory (a global-scope install, or a symlink alias). Falls back to the lexical resolve when
 * the directory does not exist yet or cannot be realpath'd — the loader's `canonicalDir` discipline.
 */
function canonicalOverlayDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Overlay roots install-time validation reads, in the loader's precedence order: the GLOBAL root
 * first, then the TARGET scope root. `loadRegistry` scans global before project and lets the FIRST
 * accepted id win, so scanning in the same order gives install the same winner on a cross-scope id
 * collision. The global home is resolved the way `overlayRoots` resolves it — `GSD_HOME`, else the
 * user's home — with the target scope standing in for the loader's explicit `options.gsdHome`. For a
 * global-scope install the two roots coincide and dedup to one entry.
 *
 * Each root carries its own scope home because the ledger that gates it is co-located there
 * (`<scope>/.gsd-capabilities.json`), exactly as in the loader.
 */
function installValidationRoots(gsdHome: string): Array<{ home: string; dir: string }> {
  const roots: Array<{ home: string; dir: string }> = [];
  const seen = new Set<string>();
  for (const home of [process.env['GSD_HOME'] || os.homedir(), gsdHome]) {
    const dir = path.join(home, '.gsd', 'capabilities');
    const key = canonicalOverlayDir(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ home, dir });
  }
  return roots;
}

/**
 * The capability universe install-time cross-validation resolves references against: first-party
 * capabilities ∪ the committed overlays already installed in the scopes the loader composes,
 * EXCLUDING `excludeId` (the incoming candidate REPLACES any same-id bundle already there, and the
 * caller adds it).
 *
 * #3929: `stageValidated` used to seed the suite with `new Map([[id, cap]])`. Every invariant
 * `validateCrossCapability` resolves by map MEMBERSHIP — `requires` existence, `runtimeCompat`
 * runtime ids, requires-cycles, tier-monotone, skill/agent/family owner-uniqueness — was therefore
 * evaluated against a universe of exactly one capability. A non-empty `requires` was unsatisfiable
 * at install time even when the dependency was first-party, installed and active, and every
 * ownership check was silently vacuous. `loadRegistry` seeds first-party ∪ accepted overlays; this
 * brings install-time validation into parity with load-time validation.
 *
 * Overlay manifests are UNTRUSTED disk content, so each is read through the shared bounded reader
 * and must pass `validateCapability` before it joins the set (the cross-capability validators
 * assume a structurally-valid shape — the loader only ever hands them validated caps). Acceptance
 * is INCREMENTAL, exactly as in `loadRegistry`: an overlay joins only if the suite stays clean
 * (and does not throw) with it in. That keeps the returned base map CLEAN by construction, so any
 * error the candidate then produces is the candidate's own fault — a broken or conflicting
 * neighbour can never block an unrelated install.
 *
 * An id already in the map is SKIPPED rather than overwritten (`fpIds.has(id) || acceptedIds.has(id)`
 * in the loader): first-party wins over every overlay, and the earlier scope wins over the later one.
 */
function installValidationSet(
  gsdHome: string,
  excludeId: string,
  centralKeys: Set<string>,
): Map<string, unknown> {
  const capMap = new Map<string, unknown>();

  // First-party capabilities — the same base `loadRegistry` seeds with, and clean by construction
  // (the build-time generator enforces the same invariants over it).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const registry: RegistryModule = require('./capability-registry.cjs');
    for (const [fpId, fpCap] of Object.entries(registry.capabilities ?? {})) {
      if (fpId !== excludeId) capMap.set(fpId, fpCap);
    }
  } catch { /* registry unavailable — first-party ids simply do not resolve */ }

  for (const root of installValidationRoots(gsdHome)) {
    const committed = committedOverlayIds(root.home);
    if (committed.size === 0) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // no overlay dir at this scope — normal on a first install.
    }

    // Sorted so acceptance (and therefore any resulting error text) is independent of readdir order.
    const overlayIds = entries
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)
      .filter((overlayId) => overlayId !== excludeId && committed.has(overlayId) && !capMap.has(overlayId))
      .sort();

    for (const overlayId of overlayIds) {
      let overlayCap: Record<string, unknown>;
      try {
        overlayCap = readManifestBounded(
          path.join(root.dir, overlayId, 'capability.json'),
          `capability.json not found for installed capability "${overlayId}"`,
        );
      } catch {
        continue; // unreadable / non-regular / oversized / malformed — skipped, never fatal.
      }
      if (capValidator.validateCapability(overlayCap, overlayId).length > 0) continue;
      capMap.set(overlayId, overlayCap);
      try {
        const errs = [
          ...capValidator.validateConsumesGlobal(capMap),
          ...capValidator.validateCrossCapability(capMap, centralKeys),
        ];
        if (errs.length > 0) capMap.delete(overlayId);
      } catch {
        capMap.delete(overlayId); // a throwing validator is treated exactly like a failure.
      }
    }
  }

  return capMap;
}

/**
 * Validate the fetched capability manifest and stage it atomically.
 *
 * Runs the full validation suite (validateCapability → materializeHookFragments →
 * validateAgainstContract → validateConsumesGlobal → validateCrossCapability).
 * On success, renames the staging dir to the final dir and returns the result.
 * On any failure, removes the staging dir and throws.
 */
function stageValidated(opts: {
  sourceDir: string;
  id: string;
  gsdHome: string;
  hostVersion: string;
  source: string;
  integrity: string | null;
  promote?: boolean;
  skipEnginesGate?: boolean;
}): ResolveResult {
  const { sourceDir, id, gsdHome, hostVersion, source, integrity } = opts;
  const promote = opts.promote !== false;

  // Safety: validate id before using it in a path.
  assertSafeId(id);

  const capabilitiesRoot = path.join(gsdHome, '.gsd', 'capabilities');
  const stagingRoot = path.join(capabilitiesRoot, '.staging');
  const stagingDir = path.join(stagingRoot, `${id}-${process.pid}-${Date.now()}`);
  const finalDir = path.join(capabilitiesRoot, id);

  // Reject a source-ROOT that is itself a symlink (copyDirRecursive guards interior
  // entries, but readdirSync would follow a symlinked root).
  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    throw new Error(`Refusing to stage a symlinked source directory: ${sourceDir}`);
  }

  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // Copy source into staging — STREAMING + BUDGETED (#1461 finding 1, ROUND 2). copyDirRecursive now
    // enforces BOTH the entry-count and aggregate-byte budget DURING the copy (per-entry, via opendirSync
    // + readSync, never readdirSync of the whole array), so a hostile source with millions of tiny files
    // or an oversized artifact fails closed IN-PROCESS before the whole directory is materialized — it can
    // no longer OOM the process before a post-copy walk runs. The catch below rmSync's the staging dir on
    // throw, so an over-budget bundle never lands at the final location.
    copyDirRecursive(sourceDir, stagingDir);

    // #1461 finding 1 (HIGH): belt-and-suspenders aggregate byte-budget re-verification on what ACTUALLY
    // landed in staging. copyDirRecursive (above) is now the PRIMARY in-process bound — it fails closed
    // DURING the copy — so this post-copy walk is no longer the sole guard, but it is kept as a cheap
    // authoritative re-lstat of the staged RESULT at the common chokepoint AFTER staging and BEFORE
    // validation/promotion: it re-checks the entry/byte caps and re-rejects any symlink / non-regular
    // entry on the real staged tree (every staging path here flows through copyDirRecursive — there is no
    // in-place-dir staging path — so the copy already bounds it; this is defense in depth).
    //
    // RESIDUAL (#1461 finding 4): the copy and this walk bound the staged RESULT (rejects an oversized
    // install before promotion); a transient disk-fill DURING extraction/clone (system tar/git/npm write
    // to a temp dir BEFORE copyDirRecursive streams it into staging) is a residual a fully-airtight bound
    // would need a streaming byte-quota DURING extraction/clone to close. Proportionate: this resolver
    // path is USER-INITIATED `install` only (the cloned-repo / loader overlay path does NOT invoke the
    // resolver and is bounded separately), and the temp/.staging dirs are removed on any failure.
    assertStagedBundleWithinBudget(stagingDir);

    // Read and parse the capability manifest via the SHARED bounded reader (#1461 finding 2): an
    // oversized/non-regular staged capability.json is refused (fail-closed) rather than read unbounded.
    const manifestPath = path.join(stagingDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in staged directory: ${stagingDir}`,
    );

    // engines.gsd pre-check — reject before staging finalizes (unless the caller owns the gate).
    const engines = cap['engines'];
    if (!opts.skipEnginesGate && engines && typeof engines === 'object' && !Array.isArray(engines)) {
      const gsdRange = (engines as Record<string, unknown>)['gsd'];
      if (typeof gsdRange === 'string' && gsdRange) {
        if (!semverMod.semverSatisfies(hostVersion, gsdRange)) {
          throw new Error(
            `Capability requires engines.gsd "${gsdRange}" but running GSD is ${hostVersion}`
          );
        }
      }
    }

    // Structural validation (validateCapability enforces id===folderId).
    const validationErrs = capValidator.validateCapability(cap, id);
    if (validationErrs.length > 0) {
      throw new Error(`Capability validation failed: ${validationErrs.join('; ')}`);
    }

    // Materialize hook fragments (returns errors, does not throw).
    const fragErrs = capValidator.materializeHookFragments(structuredClone(cap), stagingDir);
    if (fragErrs.length > 0) {
      throw new Error(`Hook fragment validation failed: ${fragErrs.join('; ')}`);
    }

    // Cross-capability validations (contract, consumes, cross-capability), seeded the way
    // LOAD-time validation seeds them (#3929): first-party ∪ the committed overlays already installed
    // in the scopes the loader composes ∪ the candidate, against the REAL central config-key set. The previous
    // singleton map made every membership-resolved invariant — `requires`, `runtimeCompat` ids,
    // cycles, tier-monotone, owner-uniqueness — either unsatisfiable or vacuous at install time.
    // The base map is clean by construction (see installValidationSet), so every error here is
    // attributable to the candidate.
    const centralKeys = centralConfigKeys();
    const capMap = installValidationSet(gsdHome, id, centralKeys);
    capMap.set(id, cap);
    const crossErrs = [
      ...capValidator.validateAgainstContract(cap, id),
      ...capValidator.validateConsumesGlobal(capMap),
      ...capValidator.validateCrossCapability(capMap, centralKeys),
    ];
    if (crossErrs.length > 0) {
      throw new Error(`Cross-capability validation failed: ${crossErrs.join('; ')}`);
    }

    // When promote === false the caller owns the swap (ADR-1244 Phase 4 upgrade path):
    // return the validated staging dir as-is, leaving it on disk for the caller to rename.
    if (!promote) {
      const version = typeof cap['version'] === 'string' ? cap['version'] : '';
      return { id, version, stagedDir: stagingDir, integrity, source };
    }

    // All validation passed — promote staging to final.
    // Replacement is move-aside-then-rename (not rm-then-rename): rename the old
    // bundle aside (atomic), move the new one in, restore the old one if the second
    // rename fails. This avoids leaving the capability missing on a failed swap.
    // (The fully-atomic stage-then-swap with the ledger as commit point — for upgrades —
    // lives in capability-lifecycle.cjs and uses promote:false above.)
    if (fs.existsSync(finalDir)) {
      const backupDir = `${finalDir}.old-${process.pid}-${Date.now()}`;
      shellSeam.retryRenameSync(finalDir, backupDir);
      try {
        shellSeam.retryRenameSync(stagingDir, finalDir);
      } catch (err) {
        try { shellSeam.retryRenameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
        throw err;
      }
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    } else {
      shellSeam.retryRenameSync(stagingDir, finalDir);
    }

    const version = typeof cap['version'] === 'string' ? cap['version'] : '';

    return { id, version, stagedDir: finalDir, integrity, source };
  } catch (err) {
    // Atomicity: always clean up the staging dir on failure.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/**
 * Detect the source kind from a raw spec string.
 *
 * Kind detection rules (first match wins):
 *   local:    starts with `./ | ../ | /` (absolute path)
 *   npm:      starts with `npm:` prefix
 *   tarball:  `https://…` ending in `.tgz` or `.tar.gz`
 *   git:      `https://…git`, URL with `#<ref>`, or starts with `git+`
 *   registry: `<name>@<registry>` form (no URL scheme)
 */
function parseSpec(spec: string): ParsedSpec {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('Capability spec must be a non-empty string');
  }
  const s = spec.trim();

  // local: relative or absolute path
  if (s.startsWith('./') || s.startsWith('../') || path.isAbsolute(s)) {
    return { kind: 'local', raw: spec, target: s };
  }

  // npm: explicit `npm:` prefix
  if (s.startsWith('npm:')) {
    const pkgSpec = s.slice('npm:'.length);
    if (!pkgSpec) throw new Error(`Invalid npm spec: "${spec}" — package spec is empty after "npm:"`);
    assertSafeNpmSpec(pkgSpec);
    return { kind: 'npm', raw: spec, target: pkgSpec };
  }

  // tarball: https URL ending in .tgz or .tar.gz
  if (/^https?:\/\/.+\.t(gz|ar\.gz)$/i.test(s)) {
    return { kind: 'tarball', raw: spec, target: s };
  }

  // git: git+ prefix, https URL ending in .git, or URL with #<ref>
  if (
    s.startsWith('git+') ||
    /^https?:\/\/.+\.git$/i.test(s) ||
    (/^https?:\/\//.test(s) && s.includes('#'))
  ) {
    let url = s.startsWith('git+') ? s.slice('git+'.length) : s;
    let ref: string | undefined;
    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1) {
      ref = url.slice(hashIdx + 1);
      url = url.slice(0, hashIdx);
    }
    assertSafeGitUrl(url);
    if (ref !== undefined && (SHELL_METACHAR_RE.test(ref) || ref.startsWith('-'))) {
      // Leading '-' would be parsed as a git option, not a ref.
      throw new Error(`Unsafe git ref (shell metacharacters or leading dash not allowed): "${ref}"`);
    }
    return { kind: 'git', raw: spec, target: url, ...(ref !== undefined ? { ref } : {}) };
  }

  // registry: <name>@<version-or-registry> — no URL scheme
  if (/^[a-zA-Z0-9@/_-]/.test(s) && !s.startsWith('http')) {
    return { kind: 'registry', raw: spec, target: s };
  }

  throw new Error(`Cannot determine source kind for capability spec: "${spec}"`);
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------

function resolveLocal(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  // #1460 CS-1: a local path is a directory tree, not a single downloadable artifact, so there is
  // no stable byte stream to verify a sha512 SRI pin against. A supplied `--integrity` is therefore
  // REJECTED with an actionable error rather than being silently dropped (the prior behaviour staged
  // with integrity:null, so the user believed content was pinned when it was not).
  if (opts.integrity) {
    throw new Error('integrity pinning is not supported for local sources');
  }

  const absPath = path.resolve(parsed.target);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Local capability path does not exist: ${absPath}`);
  }
  // Read id from capability.json to know the staging dest — via the SHARED bounded reader (#1461
  // finding 2): an oversized/non-regular local capability.json is refused, never read unbounded.
  const manifestPath = path.join(absPath, 'capability.json');
  const cap = readManifestBounded(
    manifestPath,
    `Cannot read capability.json from local path: ${manifestPath}`,
  );
  const id = typeof cap['id'] === 'string' ? cap['id'] : '';
  if (!id) throw new Error('capability.json missing "id" field');

  return stageValidated({ sourceDir: absPath, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
}

function resolveGit(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execGit = opts.execOverrides?.git ?? shellSeam.execGit;

  // #1460 CS-1: a git working tree has no single downloadable artifact to verify a sha512 SRI pin
  // against (a clone is a directory tree, and the digest would vary with pack/checkout details). A
  // supplied `--integrity` is therefore REJECTED with an actionable error rather than silently
  // dropped (the prior behaviour staged with integrity:null). Pin a git source by COMMIT instead.
  if (opts.integrity) {
    throw new Error('integrity pinning is not supported for git sources; pin the commit with #sha:<commit>');
  }

  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-git-'));
  try {
    // Clone (copy only — no hooks execute on clone, no npm install).
    const cloneResult = execGit(['clone', '--depth', '1', '--', parsed.target, cloneDir], { timeout: 60_000 });
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`);
    }

    // Optional ref checkout. The ref is a commit-ish (tag/branch/sha), NOT a path,
    // so it goes BEFORE the `--` pathspec terminator (a leading-dash ref is rejected
    // at parse time, so it cannot be misread as an option here).
    if (parsed.ref) {
      const checkoutResult = execGit(['-C', cloneDir, 'checkout', parsed.ref, '--'], { timeout: 60_000 });
      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `git checkout "${parsed.ref}" failed (exit ${checkoutResult.exitCode}): ${checkoutResult.stderr}`
        );
      }
    }

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): a cloned repo's
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(cloneDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in cloned repo: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir: cloneDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function resolveNpm(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execNpm = opts.execOverrides?.npm ?? shellSeam.execNpm;
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  const tmpPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-pack-'));
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-ext-'));

  try {
    // npm pack — creates a tarball. CRITICAL: `npm pack` runs prepack/prepare
    // lifecycle scripts by default, which would EXECUTE fetched code — so we pass
    // --ignore-scripts to guarantee copy-only. NEVER npm install.
    const packResult = execNpm(
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmpPackDir, '--', parsed.target],
      { timeout: 60_000 }
    );
    if (packResult.exitCode !== 0) {
      throw new Error(`npm pack failed (exit ${packResult.exitCode}): ${packResult.stderr}`);
    }

    // Locate the produced .tgz.
    const tarballs = fs.readdirSync(tmpPackDir).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      throw new Error(`npm pack produced no .tgz in ${tmpPackDir}`);
    }
    const tgzPath = path.join(tmpPackDir, tarballs[0]);

    // #1460 CS-1: a supplied `--integrity` is verified over the `.tgz` BYTES (same SRI sha512
    // domain as the tarball adapter) BEFORE anything is staged or promoted — never silently
    // dropped. The recorded integrity is always the computed digest of the produced tarball.
    // `npm pack --ignore-scripts` (above) ran no capability code, so reading these bytes is
    // copy-only. A mismatch throws here, before assertSafeTarMembers / extraction / staging.
    const tgzBytes = readPackTarball(tgzPath);
    const computedIntegrity = computeIntegrity(tgzBytes);
    if (opts.integrity) {
      verifyIntegrity(tgzBytes, opts.integrity);
    }

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    // Extract — copy only, no scripts. npm tarballs nest under package/.
    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // npm tarballs nest under package/; fall back to root.
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): an extracted
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(sourceDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found after npm pack extraction from: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: computedIntegrity, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(tmpPackDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function resolveTarball(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): Promise<ResolveResult> {
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  // Fetch buffer — always reject non-200 (realHttpsGet enforces this).
  const resp = await _httpGet(parsed.target);

  // Integrity check BEFORE any bytes touch disk (if provided).
  const computedIntegrity = computeIntegrity(resp.body);
  if (opts.integrity) {
    verifyIntegrity(resp.body, opts.integrity);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-tar-'));
  const tgzPath = path.join(extractDir, '_download.tgz');

  try {
    fs.writeFileSync(tgzPath, resp.body);

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // Locate capability.json — root or package/ (npm tarball shape).
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): an extracted
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(sourceDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in tarball from: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: computedIntegrity, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a capability spec, validate it, and stage it into the GSD capabilities dir.
 *
 * @param spec  - Source spec string. Kind auto-detected via parseSpec.
 * @param opts  - Optional overrides for hostVersion, gsdHome, integrity, exec/http seams.
 * @returns     - Resolved bundle descriptor with stagedDir path.
 */
async function resolveCapabilitySource(spec: string, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const parsed = parseSpec(spec);

  const hostVersion = opts.hostVersion ?? readHostVersion();
  const gsdHome = opts.gsdHome ?? process.env['GSD_HOME'] ?? os.homedir();

  switch (parsed.kind) {
    case 'local':
      return resolveLocal(parsed, opts, gsdHome, hostVersion);
    case 'git':
      return resolveGit(parsed, opts, gsdHome, hostVersion);
    case 'npm':
      return resolveNpm(parsed, opts, gsdHome, hostVersion);
    case 'tarball':
      return resolveTarball(parsed, opts, gsdHome, hostVersion);
    case 'registry':
      throw new Error(
        'registry source kind is not yet implemented (no first-party registry endpoint)'
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = parsed.kind;
      throw new Error(`Unknown source kind: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Latest-version peek (ADR-1244 D6 "Update available?" per-source matrix; #1463)
// ---------------------------------------------------------------------------

/**
 * #1463: timeouts for the LIGHT remote peek the `outdated` verb performs. These are deliberately the
 * SAME bounds the resolve path uses for the analogous heavy operations (CONTEXT.md "every git/npm
 * subprocess needs a timeout"): a hung registry/remote must DEGRADE the verb (status 'unknown'), never
 * hang it. The peek is a metadata-only read (`git ls-remote --tags`, `npm view … version`), NOT a
 * clone / pack / extract.
 */
const PEEK_GIT_TIMEOUT_MS = 30_000;
const PEEK_NPM_TIMEOUT_MS = 60_000;

/**
 * Status of a single per-source latest-version peek.
 *  - ok          a latest version was resolved (compare it to installed).
 *  - pinned      the recorded source is pinned to an immutable/explicit ref (git `#sha:`/`#tag:`/`#<ref>`)
 *                or an EXACT npm version (`npm:<pkg>@1.2.3`). `update` re-resolves to the SAME ref/version,
 *                so it can never be "outdated" — version (when known) is informational only.
 *  - manual      a bare tarball URL — one immutable artifact, no catalogue to query.
 *  - unsupported the source kind has no implemented peek (registry).
 *  - unknown     the peek failed / timed out / returned unparseable output (DEGRADE, never thrown).
 */
type PeekStatus = 'ok' | 'pinned' | 'manual' | 'unsupported' | 'unknown';

/** Result of peekLatestVersion: a status discriminant + the resolved version when status==='ok'. */
interface PeekResult {
  status: PeekStatus;
  /** The latest version string when status==='ok'; null otherwise. */
  version: string | null;
  /** Optional human-readable reason for a non-ok status (DEGRADE diagnostics, never thrown). */
  reason?: string;
}

/**
 * #1463: parse the output of `git ls-remote --tags <url>` and return the HIGHEST stable-triplet semver
 * tag, or null when no parseable semver tag exists. UNTRUSTED-DATA RULE: the remote's ref names are
 * treated purely as data — each line is `<sha>\t<ref>` (e.g. `<sha>\trefs/tags/v1.2.0`); we strip
 * `refs/tags/`, ignore the `^{}` peeled-annotation entries (they would otherwise double-count and the
 * `^{}` suffix is not a version), strip a leading `v`, and keep only STABLE x.y.z triplets
 * (isStableTripletSemver) so a `-rc`/junk tag never wins. The max is selected via compareSemverCore so
 * 1.10.0 correctly beats 1.2.0 (numeric, not lexical). Pure + deterministic → property-tested.
 */
function pickHighestSemverTag(lsRemoteOutput: string): string | null {
  if (typeof lsRemoteOutput !== 'string' || lsRemoteOutput.trim() === '') return null;
  let best: string | null = null;
  for (const rawLine of lsRemoteOutput.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    // `<sha>\t<ref>` — take the ref (last whitespace-delimited token); a line without a tab/ref is junk.
    const tabIdx = line.search(/\s/);
    const ref = tabIdx === -1 ? line : line.slice(tabIdx + 1).trim();
    if (!ref.startsWith('refs/tags/')) continue;
    let tag = ref.slice('refs/tags/'.length);
    // Ignore the peeled-annotation entry `refs/tags/<tag>^{}` — same tag, not a distinct version.
    if (tag.endsWith('^{}')) continue;
    if (tag.startsWith('v')) tag = tag.slice(1);
    // Keep only stable x.y.z triplets — a prerelease/junk tag is not an "available stable version".
    if (!semverMod.isStableTripletSemver(tag)) continue;
    if (best === null || semverMod.compareSemverCore(tag, best) > 0) best = tag;
  }
  return best;
}

const NPM_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * #1463: split an npm package spec (the `parsed.target` for an `npm:` source) into its package NAME and
 * its trailing version/range selector. The selector is everything after the `@` that separates name from
 * version — for a SCOPED package (`@scope/name@<sel>`) that is the LAST `@`, NOT the leading scope `@`;
 * for an unscoped package (`name@<sel>`) it is the single non-leading `@`. A spec with no such `@`
 * (`@scope/name`, `name`) has selector `''` (tracks the npm `latest` dist-tag).
 *
 * Pure string parse on an already-shell-safe spec (assertSafeNpmSpec ran in parseSpec). Used ONLY to
 * classify the recorded source (exact-pin vs range vs latest) and to range-filter `npm view` output —
 * the subprocess invocation still passes the FULL `parsed.target` unchanged.
 */
function splitNpmSpec(target: string): { name: string; selector: string } {
  // Find the `@` that introduces the version selector: search from the END, but stop at index 0 (the
  // leading `@` of a scope is never a version separator).
  const at = target.lastIndexOf('@');
  if (at <= 0) return { name: target, selector: '' };
  return { name: target.slice(0, at), selector: target.slice(at + 1) };
}

/**
 * #1463: pull the ONE canonical version token out of a single `npm view <spec> version` output line, or
 * null when the line carries no version in a canonical position. UNTRUSTED-DATA RULE: the line is data.
 *
 * #1463 Fix 1 (R Medium): the version MUST come from its CANONICAL position, NOT from "any x.y.z token on
 * the line" — a package NAME can itself contain a version-like substring (`@scope/cap-1.2.3@1.0.0`) and
 * the old any-token scan returned the NAME's `1.2.3` instead of the resolved `1.0.0`. npm prints lines
 * shaped `<name>@<version> '<version>'` (range/multi-match) or a single bare `<version>` token (latest
 * dist-tag). Canonical extraction:
 *   1. Prefer the QUOTED token (`'x.y.z'`) when present — that is npm's explicit version annotation.
 *   2. Else take the token after the LAST `@` of the leading `name@version` segment (the first
 *      whitespace-delimited field), mirroring splitNpmSpec's scoped last-`@` rule so a scope `@` is not
 *      mistaken for the version separator.
 *   3. Else (a single bare line with no `@` and no quotes) treat the whole first field as the version.
 * The candidate is validated against NPM_VERSION_RE; a version-like substring embedded in the NAME is
 * never consulted. Returns the canonical version (unvalidated against any range) or null. Pure.
 */
function extractNpmLineVersion(line: string): string | null {
  // 1. Quoted annotation `'x.y.z'` — npm's explicit version field.
  const quoted = line.match(/'([^']+)'/);
  if (quoted && NPM_VERSION_RE.test(quoted[1])) return quoted[1];

  // 2/3. The leading `name@version` (or bare `version`) field is the first whitespace-delimited token.
  const head = line.split(/\s+/, 1)[0];
  if (head === undefined || head === '') return null;
  // Last `@` that is not a leading scope `@` (index 0) separates name from version; no such `@` ⇒ the
  // whole head is the candidate (a bare `version` line). Never read a substring inside the NAME portion.
  const at = head.lastIndexOf('@');
  const candidate = at > 0 ? head.slice(at + 1) : head;
  return NPM_VERSION_RE.test(candidate) ? candidate : null;
}

/**
 * #1463: return the HIGHEST version across `npm view <spec> version` stdout that satisfies `range`
 * (compareSemverCore for max; semverSatisfies for the range bound), or null when none parse / match.
 * UNTRUSTED-DATA RULE: the output is treated purely as data. npm prints ONE annotated line per matching
 * version for a multi-version range, e.g.:
 *     @org/pkg@1.0.0 '1.0.0'
 *     @org/pkg@1.10.0 '1.10.0'
 * and a single bare line for a single match. Each line yields at most ONE canonical version (via
 * extractNpmLineVersion — Fix 1: the version's canonical position, NOT any token, so a version-like
 * substring in the package NAME never poisons the result). We keep only versions satisfying the recorded
 * range and pick the numeric max so 1.10.0 beats 1.2.0. An empty selector means "no range constraint"
 * (track latest) → every parseable version qualifies. Pure + deterministic.
 */
function pickHighestNpmVersion(viewOutput: string, range: string): string | null {
  if (typeof viewOutput !== 'string') return null;
  let best: string | null = null;
  for (const rawLine of viewOutput.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const tok = extractNpmLineVersion(line);
    if (tok === null) continue;
    // Empty range = no constraint (track latest); otherwise the version must satisfy the recorded range.
    if (range !== '' && !semverMod.semverSatisfies(tok, range)) continue;
    if (best === null || semverMod.compareSemverCore(tok, best) > 0) best = tok;
  }
  return best;
}

/**
 * #1463 Fix 2 (R Medium): classify the git ref FRAGMENT (`parsed.ref`, the raw text after `#`) by KIND.
 * parseSpec captures the WHOLE `#…` fragment as a raw string and does NOT split the kind, so we parse the
 * `sha:` / `tag:` prefix here. The kind decides mutability:
 *   - 'sha'  (`#sha:<commit>`)  → IMMUTABLE pin (a commit never moves).
 *   - 'tag'  (`#tag:<name>`)    → IMMUTABLE pin (a tag is opted-into; `update` re-checks-out the SAME tag).
 *   - 'bare' (`#<ref>`)          → AMBIGUOUS: it is either a tag (immutable) or a branch (MUTABLE). The
 *                                  caller must resolve it remotely (git ls-remote <url> <ref>) before
 *                                  deciding pinned-vs-not — a bare branch ref is NEVER pinned.
 *   - 'none'                     → no `#<ref>`: tracks the default branch (peek highest tag).
 * Pure string parse on an already-shell-safe ref (parseSpec asserted it). `sha:`/`tag:` are matched
 * case-insensitively with optional surrounding whitespace; the prefix's value is returned for diagnostics.
 */
function classifyGitRef(parsed: ParsedSpec): { kind: 'none' | 'sha' | 'tag' | 'bare'; value: string } {
  const raw = typeof parsed.ref === 'string' ? parsed.ref.trim() : '';
  if (raw === '') return { kind: 'none', value: '' };
  const shaMatch = /^sha:(.+)$/i.exec(raw);
  if (shaMatch) return { kind: 'sha', value: shaMatch[1].trim() };
  const tagMatch = /^tag:(.+)$/i.exec(raw);
  if (tagMatch) return { kind: 'tag', value: tagMatch[1].trim() };
  return { kind: 'bare', value: raw };
}

/**
 * #1463 Fix 2 (R Medium): resolve a bare ambiguous git ref to its KIND at the remote with a bounded
 * `git ls-remote <url> <ref>` (the SAME safe seam as the tag peek: argv + `--`, never a shell string).
 * ls-remote prints `<sha>\t<full-ref>` lines for every matching ref. A ref that matches under
 * `refs/tags/` is an immutable TAG; one under `refs/heads/` is a MUTABLE branch. UNTRUSTED-DATA RULE:
 * the remote's ref strings are data — we only test the canonical `refs/tags/` vs `refs/heads/` prefix on
 * the ref column (last whitespace-delimited token of each line). Returns:
 *   'tag'     — at least one matching ref under refs/tags/ (and none ambiguous-conflicting branch).
 *   'branch'  — at least one matching ref under refs/heads/.
 *   'unknown' — ls-remote error / timeout / non-zero / empty / unresolvable / conflicting output.
 * NEVER throws (DEGRADE). Bounded by PEEK_GIT_TIMEOUT_MS (≤30s).
 */
function classifyBareGitRefRemote(
  url: string,
  ref: string,
  execGit: (args: string[], o?: { timeout?: number }) => SpawnResult,
): 'tag' | 'branch' | 'unknown' {
  let r: SpawnResult;
  try {
    // Metadata-only ref lookup; `--` terminates options so a hostile URL/ref can't be read as a flag
    // (both are already transport-/shell-safe via parseSpec). The ref filters ls-remote server-side.
    r = execGit(['ls-remote', '--', url, ref], { timeout: PEEK_GIT_TIMEOUT_MS });
  } catch {
    return 'unknown';
  }
  if (!r || r.exitCode !== 0 || r.signal) return 'unknown';
  let sawTag = false;
  let sawBranch = false;
  for (const rawLine of (r.stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const tabIdx = line.indexOf('\t');
    const refName = tabIdx === -1 ? line : line.slice(tabIdx + 1).trim();
    if (refName.startsWith('refs/tags/')) sawTag = true;
    else if (refName.startsWith('refs/heads/')) sawBranch = true;
  }
  // A clean single-kind resolution wins; anything ambiguous (both, or neither) degrades to unknown so a
  // mutable branch is never silently treated as an immutable tag (and vice-versa).
  if (sawTag && !sawBranch) return 'tag';
  if (sawBranch && !sawTag) return 'branch';
  return 'unknown';
}

/**
 * #1463: resolve the LATEST available version for a recorded capability source string, per ADR-1244 D6
 * ("Update available?" is a per-source matrix). This is a LIGHT remote PEEK — metadata only — never a
 * re-clone / re-pack / re-extract. It NEVER throws: every error / timeout / unsupported source DEGRADES
 * to a status the `outdated` verb can render. Per-kind behaviour:
 *
 *   - git      `git ls-remote --tags <url>` → highest stable semver tag (pickHighestSemverTag). status 'ok'.
 *   - npm      `npm view <pkg> version` (latest dist-tag) → the reported version. status 'ok'.
 *   - local    re-read capability.json at the path (bounded reader) → its `version`. status 'ok'.
 *   - tarball  one immutable URL, not auto-detectable per D6 → status 'manual' (no version).
 *   - registry resolveCapabilitySource throws (unimplemented) → status 'unsupported'.
 *
 * BOUNDED SUBPROCESSES (CONTEXT.md): git ls-remote ≤30s, npm view ≤60s; on timeout / non-zero / error /
 * empty-or-unparseable output → status 'unknown' (DEGRADE, never crash the verb).
 *
 * The exec seam mirrors the resolver: opts.execOverrides.{git,npm} (or the default shell seam) so a test
 * can mock the remote PEEK with no network I/O.
 */
function peekLatestVersion(
  source: string,
  opts: {
    execOverrides?: { git?: (args: string[], o?: { timeout?: number }) => SpawnResult; npm?: (args: string[], o?: { timeout?: number }) => SpawnResult };
  } = {},
): PeekResult {
  let parsed: ParsedSpec;
  try {
    parsed = parseSpec(source);
  } catch (err) {
    // An unparseable recorded source cannot be peeked — DEGRADE (do not throw).
    return { status: 'unknown', version: null, reason: `unparseable source: ${(err as Error).message}` };
  }

  switch (parsed.kind) {
    case 'git': {
      const execGit = opts.execOverrides?.git ?? shellSeam.execGit;
      // #1463 Fix 2 (R Medium): classify the recorded ref by KIND before deciding pinned-vs-not. An
      // IMMUTABLE pin (`#sha:`/`#tag:`) is NEVER outdated — `update` re-resolves the SAME commit/tag, so
      // a newer remote tag is irrelevant; report 'pinned' WITHOUT any peek. A BARE `#<ref>` is ambiguous
      // (tag OR branch): we MUST classify it remotely so a MUTABLE branch is never falsely 'pinned'.
      const refKind = classifyGitRef(parsed);
      if (refKind.kind === 'sha' || refKind.kind === 'tag') {
        return { status: 'pinned', version: null, reason: `git source pinned to ${refKind.kind} "${refKind.value}"; update will not move it` };
      }
      if (refKind.kind === 'bare') {
        // Resolve the ambiguous ref at the remote (same safe execGit seam: argv + `--`).
        const resolved = classifyBareGitRefRemote(parsed.target, refKind.value, execGit);
        if (resolved === 'tag') {
          // An immutable tag → pinned (the ref the user recorded is a tag, not a moving branch).
          return { status: 'pinned', version: null, reason: `git source ref "${refKind.value}" resolves to an immutable tag; update will not move it` };
        }
        // A branch (MUTABLE) or an unresolvable/ambiguous result. The ledger records NO installed commit
        // sha for git sources (integrity is null), so a moved branch HEAD cannot be compared against the
        // installed commit → DEGRADE to 'unknown'. The HARD INVARIANT holds: a branch is NEVER 'pinned'.
        const reason = resolved === 'branch'
          ? `git source tracks mutable branch "${refKind.value}"; no installed commit recorded to compare against`
          : `git source ref "${refKind.value}" could not be classified (tag vs branch) at the remote`;
        return { status: 'unknown', version: null, reason };
      }
      // refKind.kind === 'none' — no `#<ref>`, tracks the default branch: peek the highest remote tag.
      let r: SpawnResult;
      try {
        // Metadata-only: ls-remote lists refs without cloning. `--` terminates options so a hostile
        // URL cannot be read as a flag (the URL is already transport-allowlisted by parseSpec).
        r = execGit(['ls-remote', '--tags', '--', parsed.target], { timeout: PEEK_GIT_TIMEOUT_MS });
      } catch (err) {
        return { status: 'unknown', version: null, reason: `git ls-remote error: ${(err as Error).message}` };
      }
      if (!r || r.exitCode !== 0 || r.signal) {
        const reason = r && r.signal ? `git ls-remote timed out (signal ${r.signal})`
          : `git ls-remote exit ${r ? r.exitCode : 'n/a'}`;
        return { status: 'unknown', version: null, reason };
      }
      const latest = pickHighestSemverTag(r.stdout || '');
      if (latest === null) return { status: 'unknown', version: null, reason: 'no semver tags at remote' };
      return { status: 'ok', version: latest };
    }
    case 'npm': {
      // #1463: classify the recorded npm spec — what would `update` resolve it to?
      //   exact version (`@1.2.3`)  → PINNED: update re-installs the SAME version, never outdated.
      //   range (`@^1`, `@~1.2`, …) → peek and pick the HIGHEST version satisfying the range (multi-line).
      //   no version (bare name)    → peek the single `latest` dist-tag version.
      const { selector } = splitNpmSpec(parsed.target);
      // An EXACT version selector is an immutable pin (a single x.y.z[-pre], no range operator/wildcard).
      if (selector !== '' && NPM_VERSION_RE.test(selector)) {
        return { status: 'pinned', version: selector, reason: `npm source pinned to exact version "${selector}"; update will not move it` };
      }
      const execNpm = opts.execOverrides?.npm ?? shellSeam.execNpm;
      let r: SpawnResult;
      try {
        // Mirrors scripts/check-latest-version.cjs (checkLatestVersion): `npm view <spec> version` reports
        // the matching version(s). parsed.target is the npm package spec (parseSpec asserted it is free of
        // shell metacharacters) and is passed UNCHANGED — for a range npm prints every matching version,
        // for a bare name the single latest. `--` terminates options.
        r = execNpm(['view', '--', parsed.target, 'version'], { timeout: PEEK_NPM_TIMEOUT_MS });
      } catch (err) {
        return { status: 'unknown', version: null, reason: `npm view error: ${(err as Error).message}` };
      }
      if (!r || r.exitCode !== 0 || r.signal) {
        const reason = r && r.signal ? `npm view timed out (signal ${r.signal})`
          : `npm view exit ${r ? r.exitCode : 'n/a'}`;
        return { status: 'unknown', version: null, reason };
      }
      // Treat the OUTPUT as untrusted: extract every version token (npm prints one annotated line per
      // matching version for a range, a bare token for a single match) and pick the HIGHEST that
      // satisfies the recorded range (empty selector = no constraint → latest). Garbage / no match →
      // DEGRADE to 'unknown'.
      const version = pickHighestNpmVersion(r.stdout || '', selector);
      if (version === null) {
        return { status: 'unknown', version: null, reason: `npm view returned no matching semver version: ${(r.stdout || '').trim() || '(empty)'}` };
      }
      return { status: 'ok', version };
    }
    case 'local': {
      // Re-read the recorded local capability.json (bounded reader) for its current declared version.
      let cap: Record<string, unknown>;
      try {
        const manifestPath = path.join(path.resolve(parsed.target), 'capability.json');
        cap = readManifestBounded(manifestPath, `local capability.json not readable: ${parsed.target}`);
      } catch (err) {
        return { status: 'unknown', version: null, reason: `local re-read failed: ${(err as Error).message}` };
      }
      const version = typeof cap['version'] === 'string' ? cap['version'] : '';
      if (!version) return { status: 'unknown', version: null, reason: 'local capability.json missing version' };
      return { status: 'ok', version };
    }
    case 'tarball':
      // D6: a bare tarball URL is one immutable artifact — there is no catalogue to query, so update
      // availability cannot be auto-detected. Surface 'manual' (the user must point install at a new URL).
      return { status: 'manual', version: null, reason: 'tarball sources cannot be auto-checked; re-install from a new URL' };
    case 'registry':
      // The registry adapter is unimplemented (resolveCapabilitySource throws for it).
      return { status: 'unsupported', version: null, reason: 'registry source kind is not yet implemented' };
    default: {
      const _never: never = parsed.kind;
      return { status: 'unknown', version: null, reason: `unknown source kind: ${String(_never)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  resolveCapabilitySource,
  parseSpec,
  _setCapabilitySourceHttpGet,
  _setHttpsGetImpl,
  // #1461 finding 3 test seam: the exact bounded reader stageValidated uses on the COPIED manifest, so
  // a test can exercise the staged re-read directly (not just the local pre-read that shadows it).
  _readManifestBounded: readManifestBounded,
  // #1463: D6 "Update available?" per-source latest-version peek + the pure parsers it composes (the
  // git highest-semver-tag parser, the npm spec splitter, and the npm-view range/version picker).
  peekLatestVersion,
  pickHighestSemverTag,
  splitNpmSpec,
  pickHighestNpmVersion,
  MAX_RESPONSE_BYTES,
  MANIFEST_MAX_BYTES,
  MAX_STAGED_BUNDLE_BYTES,
  MAX_STAGED_BUNDLE_ENTRIES,
  PEEK_GIT_TIMEOUT_MS,
  PEEK_NPM_TIMEOUT_MS,
};
