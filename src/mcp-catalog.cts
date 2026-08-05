/**
 * MCP served catalog — Phase B, issue #3072 (ADR-1671 epic #1671).
 * Design: `.gsd/phase/feat-3072-mcp-served-catalog/40-design.md`.
 *
 * Serves GSD's content tree as MCP **resources** (`gsd-core/workflows/*.md`,
 * `gsd-core/references/*.md`) and the 71 `commands/gsd/*.md` files as MCP
 * **prompts**, through the SAME composition rule the installer applies
 * (`bin/install.js`'s `copyWithPathReplacement`) — additive to the file-copy
 * floor, which stays untouched (ADR-1671 Decision 6).
 *
 * ## The two findings that shape this module's shape (40-design.md)
 *
 * **F1 — composition is scoped to `gsd-core/workflows/`, and that scoping is
 * load-bearing.** `bin/install.js` runs `composeWorkflow` (from
 * `workflow-fragments.cts`) only when the normalized source path matches
 * `(?:^|\/)gsd-core\/workflows\//`. A reference/command doc that merely
 * *documents* `<!-- gsd:section -->` marker syntax with an unfenced example
 * would otherwise be mis-parsed as a real marker and have that line lossily
 * dropped. {@link shouldCompose} is the ONE exported predicate both this
 * module and `bin/install.js` call — never a second, hand-duplicated regex
 * (ADR-1671:309, `DEFECT.GENERATIVE-FIX`).
 *
 * **F2 — parity cannot mean byte-equality with an emitted runtime tree.**
 * Install applies per-runtime path rewrites AFTER composition. The served
 * catalog is host-agnostic and rewrites for no runtime, so served bytes
 * equal the post-composition, pre-rewrite stage — the parity assertion is
 * that the catalog and the installer apply the SAME composition rule to the
 * SAME source, not that final bytes match an emitted tree.
 *
 * ## Shape
 *
 * ```
 * buildCatalog({root?, readFile?, readDir?}) -> Catalog {resources, prompts}
 * readResource(catalog, uri)                 -> {uri, mimeType, text} | throws CatalogError
 * getPrompt(catalog, name, args?)             -> {description, messages}   | throws CatalogError
 * shouldCompose(relPath)                      -> boolean   // THE shared F1 predicate
 * listResources(catalog, {cursor?, pageSize?}) -> {resources, nextCursor?} | throws CatalogError
 * ```
 *
 * `listResources` is a delegation surface beyond the four primitives named in
 * the design's "Shape" block: `src/mcp-server.cts`'s `handleMessage` is
 * documented PURE and must stay thin (design "Shape" section), so cursor
 * pagination over the resource index is catalog-module responsibility, not
 * protocol-handler responsibility, mirroring how `shouldCompose` centralizes
 * the F1 predicate rather than letting it leak into the protocol layer.
 *
 * `buildCatalog`'s `root` is optional: omitted, the real implementation must
 * resolve the package root from THIS MODULE's own location (`__dirname`),
 * never from `ctx.cwd` (design row 16 / test-matrix rows 46-47) — `ctx.cwd`
 * is the user's *project* (state IO), the catalog lives in the *package*.
 *
 * Pure over injected `readFile`/`readDir` seams so tests inject IO faults by
 * monkeypatching the seam (never `chmod 0o000` — root bypasses mode bits and
 * the test would silently pass with zero coverage in CI).
 *
 * Every throw carries a stable {@link REASON} code via a typed `CatalogError`
 * (mirrors `workflow-fragments.cts`'s `REASON`/`fail()` idiom) so tests assert
 * `err.reason === REASON.X` rather than regex-/substring-matching the
 * human-readable message (CONTRIBUTING.md "Prohibited: Raw Text Matching on
 * Test Outputs").
 *
 * `src/mcp-server.cts` gains `resources/*` + `prompts/*` `handleMessage`
 * cases delegating to this module. The catalog is built once per process,
 * lazily, and is immutable for the process's lifetime (Gall's Law — no
 * watching, no invalidation, no subscriptions; see design "Known limits").
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/mcp-catalog.cjs (gitignored).
 *
 * ## Directory-walk fail-open/fail-closed split (buildCatalog)
 *
 * The three catalog roots (`gsd-core/workflows/`, `gsd-core/references/`,
 * `commands/gsd/`) are each reached through exactly ONE "speculative" probe —
 * `readDir(root/gsd-core)` and `readDir(root/commands)` — whose failure is
 * TOLERATED as "this segment has zero entries" (never fatal, never a crash;
 * design row 45 / row 16 "absent root does not fall back to cwd"). Every
 * directory reached AFTER that, because a parent's successful listing already
 * reported it as a real subdirectory entry, is CONFIRMED to exist; a read
 * failure for a confirmed directory is fatal (`REASON.READ_FAILED`, design
 * row 43 "a directory read failure fails closed" — "no partial catalog
 * silently served"). This is what lets an absent `commands/` tree (row 45 /
 * many unit fixtures that only populate `gsd-core/workflows/`) build an empty
 * segment silently, while an INJECTED failure on an already-listed
 * `gsd-core/workflows/` directory (row 43) still fails the whole build.
 *
 * `readFile` is never called at build time — only `readDir`, for discovery.
 * A single resource's content is read (and, for a workflow, composed) lazily
 * inside {@link readResource}/{@link getPrompt}, so a bad `readFile` for ONE
 * entry never prevents that entry from being *listed*, only from being
 * *read* (design row 14 / test-matrix row 42).
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { validatePath } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- workflow-fragments.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
import workflowFragments = require('./workflow-fragments.cjs');
const { composeWorkflow } = workflowFragments;

/**
 * Frozen, stable reason codes for every typed throw this module's real
 * implementation will produce. Tests assert `err.reason === REASON.X`
 * (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs") — shape
 * copied from `workflow-fragments.cts`'s own `REASON` enum.
 *
 * - UNKNOWN_RESOURCE — uri (or a real-but-unindexed sibling path) is not a
 *   key in the prebuilt resource index; index membership is the sole
 *   authority (design "Hostile inputs" gate 1 / negative-space bullets).
 * - UNKNOWN_PROMPT — prompt name is not a key in the prebuilt prompt index.
 * - INVALID_URI — uri is syntactically malformed but not string-typed
 *   traversal shape: empty string, wrong scheme (e.g. `file://`).
 * - TRAVERSAL_REFUSED — uri is shaped like a path-traversal or absolute-path
 *   escape attempt (`../`, `..\\`, percent/double-encoded, absolute posix/
 *   windows paths, null byte, a symlink caught by the second `validatePath`
 *   gate) — refused by defense-in-depth, index-first (design "Hostile
 *   inputs").
 * - UNKNOWN_CURSOR — an unrecognized/malformed pagination cursor.
 * - READ_FAILED — the injected `readFile`/`readDir` seam threw for one
 *   resource (or a directory) at build or read time; the failure is
 *   contained to that one entry (design row 14).
 * - UNKNOWN_ROOT — uri's scheme is `gsd://` but its root segment names
 *   neither `workflows` nor `references`.
 * - INVALID_PARAMS — a required parameter is missing or wrong-typed (e.g. a
 *   non-string uri/name passed to `readResource`/`getPrompt`).
 *
 * Adding a new reason requires updating this map AND the test that locks
 * `Object.keys(REASON).sort()` as a coordinated change.
 */
export const REASON = Object.freeze({
  UNKNOWN_RESOURCE: 'unknown_resource',
  UNKNOWN_PROMPT: 'unknown_prompt',
  INVALID_URI: 'invalid_uri',
  TRAVERSAL_REFUSED: 'traversal_refused',
  UNKNOWN_CURSOR: 'unknown_cursor',
  READ_FAILED: 'read_failed',
  UNKNOWN_ROOT: 'unknown_root',
  INVALID_PARAMS: 'invalid_params',
});

/** A directory entry as returned by the injected `readDir` seam (mirrors `fs.Dirent`'s relevant surface). */
export interface DirEntryLike {
  readonly name: string;
  isDirectory(): boolean;
}

/** One indexed, servable resource (a `gsd-core/workflows/` or `gsd-core/references/` `.md` file). */
export interface CatalogResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
  /** POSIX-normalized path relative to `root` (e.g. `gsd-core/workflows/plan-phase.md`). */
  readonly relPath: string;
}

/** One indexed, servable prompt (a `commands/gsd/*.md` file), keyed by its bare command name. */
export interface CatalogPromptEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** POSIX-normalized path relative to `root` (e.g. `commands/gsd/plan-phase.md`). */
  readonly relPath: string;
}

/** Build-time-only extension of {@link CatalogResourceEntry} carrying the absolute path so `readResource` never re-joins one from client-influenced data. */
interface CatalogResourceEntryInternal extends CatalogResourceEntry {
  readonly absPath: string;
}

/** Build-time-only extension of {@link CatalogPromptEntry} carrying the absolute path. */
interface CatalogPromptEntryInternal extends CatalogPromptEntry {
  readonly absPath: string;
}

/**
 * The built, immutable catalog index. `root`/`readFile` are internal
 * implementation state (the resolved package root and the injected-or-default
 * read seam) carried on the returned object so `readResource`/`getPrompt`
 * need no second handshake — not part of the list/read *contract* callers
 * rely on, but present on every value this module returns.
 */
export interface Catalog {
  readonly resources: ReadonlyMap<string, CatalogResourceEntry>;
  readonly prompts: ReadonlyMap<string, CatalogPromptEntry>;
  readonly root: string;
  readonly readFile: (absPath: string) => string;
}

export interface BuildCatalogOptions {
  /** Package root to index from. Omitted: MUST resolve from this module's own location, never `ctx.cwd` (rows 46-47). */
  root?: string;
  readFile?: (absPath: string) => string;
  readDir?: (absPath: string) => DirEntryLike[];
}

export interface ReadResourceResult {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface PromptMessage {
  readonly role: 'user';
  readonly content: { readonly type: 'text'; readonly text: string };
}

export interface GetPromptResult {
  readonly description: string;
  readonly messages: readonly PromptMessage[];
}

export interface ListResourcesOptions {
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface ListResourcesResult {
  readonly resources: readonly CatalogResourceEntry[];
  readonly nextCursor?: string;
}

/** A `TypeError` carrying a stable {@link REASON} code alongside the human-readable message. */
export interface CatalogError extends TypeError {
  readonly reason: string;
}

/**
 * Default page size for {@link listResources}. ~326 real entries is past the
 * point where a single unpaginated response is polite (design row 3).
 */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Throws a `TypeError` carrying `reason` (one of {@link REASON}) as a typed
 * property, mirroring `workflow-fragments.cts`'s own `fail()` idiom so
 * callers/tests never pattern-match message prose. `cause`, when given, is
 * attached via the standard ES2022 `Error` cause chain (never string-baked
 * into the message) so the original injected-seam/compose failure stays
 * inspectable without shape-locking this module's own message text.
 */
function fail(reason: string, message: string, cause?: unknown): never {
  const options = cause === undefined ? undefined : { cause };
  const err = new TypeError(`mcp-catalog: ${message}`, options) as TypeError & { reason: string };
  err.reason = reason;
  throw err;
}

// ─── shouldCompose — the F1 predicate ───────────────────────────────────────

// Mirrors bin/install.js's pre-refactor inline regex EXACTLY (see that file's
// comment block, preserved, for the two-reviewer rationale). `bin/install.js`
// now imports THIS function rather than re-declaring the regex (task D).
const WORKFLOWS_SCOPE_RE = /(?:^|\/)gsd-core\/workflows\//;

/**
 * THE shared F1 predicate: does `relPath` (POSIX-normalized, relative to the
 * catalog root) fall under `gsd-core/workflows/`? Only such paths are ever
 * run through `composeWorkflow` — everything else (references, commands) is
 * served verbatim. `bin/install.js` imports and calls this SAME function
 * (replacing its inline regex) so the catalog and the installer can never
 * independently drift on what gets composed (ADR-1671:309,
 * `DEFECT.GENERATIVE-FIX`; the parity gate in
 * `tests/mcp-catalog-parity.test.cjs` asserts exactly this).
 */
export function shouldCompose(relPath: unknown): boolean {
  if (typeof relPath !== 'string') return false;
  // Path is normalized UNCONDITIONALLY (backslash paths arrive on Linux too —
  // CONTEXT.md path-separator rule), matching bin/install.js's own note.
  const normalized = relPath.replace(/\\/g, '/');
  return WORKFLOWS_SCOPE_RE.test(normalized);
}

// ─── buildCatalog — directory discovery ─────────────────────────────────────

/** Resolve the package root from THIS MODULE's own compiled location (`gsd-core/bin/lib/mcp-catalog.cjs`), never `ctx.cwd` (design row 16). */
function defaultPackageRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function defaultReadFile(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8');
}

function defaultReadDir(absPath: string): DirEntryLike[] {
  return fs.readdirSync(absPath, { withFileTypes: true });
}

/** Speculative directory probe: failure (missing, unreadable) is tolerated as "zero entries", never fatal — nothing has confirmed this path exists yet. */
function tryReadDir(readDir: (absPath: string) => DirEntryLike[], absPath: string): DirEntryLike[] | null {
  try {
    return readDir(absPath);
  } catch {
    return null;
  }
}

/**
 * Recursively walk `dirAbs` for `.md` files, calling `onFile(relPathFromDirAbs, absPath)`
 * for each in listing order (callers re-sort as needed — see `listResources`).
 * `dirAbs` is assumed CONFIRMED to exist (a parent's successful listing
 * already reported it as a directory entry), so any `readDir` failure here —
 * at this level or deeper — is fail-closed (`REASON.READ_FAILED`, design row
 * 43): "a directory listing failure must surface as a typed error, never a
 * silently partial catalog." Directory symlinks are inert here by
 * construction: {@link DirEntryLike} exposes only `isDirectory()`, and a
 * symlink's dirent type is never reported as a directory, so a symlinked
 * subtree is neither recursed into nor silently skipped-with-a-lie — it is
 * simply not `.md`-matched either, and falls out of the walk (the ONE
 * client-controlled path surface, `resources/read`, still gets the
 * `validatePath` second gate for a symlinked *file*; see `readIndexedResource`).
 */
function walkMarkdownFilesFatal(
  dirAbs: string,
  readDir: (absPath: string) => DirEntryLike[],
  onFile: (relPath: string, absPath: string) => void,
  relPrefix = ''
): void {
  let entries: DirEntryLike[];
  try {
    entries = readDir(dirAbs);
  } catch (err) {
    fail(REASON.READ_FAILED, `directory listing failed: ${relPrefix || dirAbs}`, err);
  }
  for (const entry of entries) {
    const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFilesFatal(childAbs, readDir, onFile, childRel);
    } else if (entry.name.endsWith('.md')) {
      onFile(childRel, childAbs);
    }
  }
}

/** Basename of a POSIX-joined relative path (never touches the OS path separator — every rel path this module builds is joined with literal `/`). */
function posixBaseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** `plan-phase` / `docs-update` -> `Plan Phase` / `Docs Update`; purely cosmetic, not asserted by any test. */
function titleFromBaseName(baseName: string): string {
  return baseName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Every segment served as an MCP **resource**. `commands` sits alongside
 * `workflows`/`references` here because a host may legitimately want to READ
 * a command's markdown without invoking it as a prompt: `resources/read`
 * returns raw text while `prompts/get` returns wrapped messages — two MCP
 * *shapes* over the SAME one file read through the SAME one read path, not a
 * second source of truth. Drives both the resource listing walk and
 * unindexed-uri classification (`UNKNOWN_ROOT` vs `UNKNOWN_RESOURCE`).
 */
const RESOURCE_SEGMENTS: ReadonlySet<string> = new Set(['workflows', 'references', 'commands']);

/** The subset of {@link RESOURCE_SEGMENTS} that lives under `gsd-core/` (as opposed to `commands/gsd/`, which is rooted elsewhere). */
const GSD_CORE_RESOURCE_SEGMENTS: ReadonlySet<string> = new Set(['workflows', 'references']);

function indexResourceSegments(
  root: string,
  readDir: (absPath: string) => DirEntryLike[],
  out: Map<string, CatalogResourceEntryInternal>
): void {
  const gsdCoreAbs = path.join(root, 'gsd-core');
  const gsdCoreEntries = tryReadDir(readDir, gsdCoreAbs);
  if (gsdCoreEntries === null) return;
  for (const segmentEntry of gsdCoreEntries) {
    if (!segmentEntry.isDirectory() || !GSD_CORE_RESOURCE_SEGMENTS.has(segmentEntry.name)) continue;
    const segment = segmentEntry.name;
    const segmentAbs = path.join(gsdCoreAbs, segment);
    walkMarkdownFilesFatal(segmentAbs, readDir, (withinSegmentRelPath, absPath) => {
      const relPath = `gsd-core/${segment}/${withinSegmentRelPath}`;
      const uri = `gsd://${segment}/${withinSegmentRelPath}`;
      const name = withinSegmentRelPath.replace(/\.md$/, '');
      out.set(uri, {
        uri,
        name,
        title: titleFromBaseName(posixBaseName(name)),
        description: `GSD ${segment} resource: ${relPath}`,
        mimeType: 'text/markdown',
        relPath,
        absPath,
      });
    });
  }
}

function indexPromptSegment(
  root: string,
  readDir: (absPath: string) => DirEntryLike[],
  out: Map<string, CatalogPromptEntryInternal>,
  resourcesOut: Map<string, CatalogResourceEntryInternal>
): void {
  const commandsAbs = path.join(root, 'commands');
  const commandsEntries = tryReadDir(readDir, commandsAbs);
  if (commandsEntries === null) return;
  for (const entry of commandsEntries) {
    if (!entry.isDirectory() || entry.name !== 'gsd') continue;
    const gsdAbs = path.join(commandsAbs, 'gsd');
    walkMarkdownFilesFatal(gsdAbs, readDir, (withinRelPath, absPath) => {
      const relPath = `commands/gsd/${withinRelPath}`;
      // Bare command name — never a path (design row 8 / test-matrix row 31).
      const name = posixBaseName(withinRelPath).replace(/\.md$/, '');
      out.set(name, {
        name,
        title: titleFromBaseName(name),
        description: `GSD command: ${name}`,
        relPath,
        absPath,
      });
      // Same file, second MCP shape: also indexed as a resource (see
      // RESOURCE_SEGMENTS doc comment) so a host can `resources/read` a
      // command's raw markdown without invoking it as a prompt.
      const resourceUri = `gsd://commands/${withinRelPath}`;
      const resourceName = withinRelPath.replace(/\.md$/, '');
      resourcesOut.set(resourceUri, {
        uri: resourceUri,
        name: resourceName,
        title: titleFromBaseName(posixBaseName(resourceName)),
        description: `GSD commands resource: ${relPath}`,
        mimeType: 'text/markdown',
        relPath,
        absPath,
      });
    });
  }
}

/**
 * Build the immutable catalog index over `root` (or, if omitted, this
 * module's own package location — never `ctx.cwd`; design row 16).
 * Pure over the injected `readFile`/`readDir` seams so IO faults are tested
 * by monkeypatching them, never `chmod 0o000`. Only `readDir` is called here
 * (discovery) — `readFile` is never invoked at build time; see the module
 * doc comment's "Directory-walk fail-open/fail-closed split" section.
 */
export function buildCatalog(opts: BuildCatalogOptions = {}): Catalog {
  const root = opts.root !== undefined ? opts.root : defaultPackageRoot();
  const readFile = opts.readFile || defaultReadFile;
  const readDir = opts.readDir || defaultReadDir;

  const resources = new Map<string, CatalogResourceEntryInternal>();
  const prompts = new Map<string, CatalogPromptEntryInternal>();

  indexResourceSegments(root, readDir, resources);
  indexPromptSegment(root, readDir, prompts, resources);

  return { resources, prompts, root, readFile };
}

// ─── readResource — the one client-controlled path surface ─────────────────

/** Percent-decode up to a few passes (double-encoding, design "Hostile inputs"), stopping early once decoding is a no-op or throws on malformed escapes. */
function decodePassesFor(value: string): string[] {
  const normalized = value.replace(/\\/g, '/');
  const passes = [normalized];
  let current = normalized;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    passes.push(decoded);
    current = decoded;
  }
  return passes;
}

/** Does any decode pass of `value` contain a literal `..` path segment? */
function hasTraversalSegment(value: string): boolean {
  return decodePassesFor(value).some((pass) => pass.split('/').some((seg) => seg === '..'));
}

const GSD_URI_RE = /^gsd:\/\/([^/]*)\/(.*)$/;
const WINDOWS_ABS_RE = /^[A-Za-z]:\//;

/**
 * Classify a uri NOT present in the index, to pick the right {@link REASON}
 * for the refusal. This is diagnostic only — the actual access decision is
 * the prebuilt index-membership check in {@link readResource}, which already
 * rejects every one of these shapes by construction (design "Hostile inputs"
 * gate 1: "a traversal uri is simply not a key").
 */
function classifyUnindexedUri(uri: string): string {
  if (uri.includes('\0')) return REASON.TRAVERSAL_REFUSED;
  if (uri.startsWith('file://')) return REASON.INVALID_URI;
  const normalized = uri.replace(/\\/g, '/');
  if (!normalized.startsWith('gsd://')) {
    if (normalized.startsWith('/')) return REASON.TRAVERSAL_REFUSED;
    if (WINDOWS_ABS_RE.test(normalized)) return REASON.TRAVERSAL_REFUSED;
    return REASON.INVALID_URI;
  }
  const match = GSD_URI_RE.exec(normalized);
  if (!match) return REASON.INVALID_URI;
  const [, rootSegment, rest] = match;
  if (!RESOURCE_SEGMENTS.has(rootSegment)) return REASON.UNKNOWN_ROOT;
  if (hasTraversalSegment(rest)) return REASON.TRAVERSAL_REFUSED;
  return REASON.UNKNOWN_RESOURCE;
}

/** Second, independent gate (design "Hostile inputs" gate 2): re-validate an INDEXED entry's relPath against the catalog root, catching a symlink planted after the index was built. */
function readIndexedResource(catalog: Catalog, entry: CatalogResourceEntry): ReadResourceResult {
  const check = validatePath(entry.relPath, catalog.root);
  if (!check.safe) {
    fail(REASON.TRAVERSAL_REFUSED, `indexed resource escapes catalog root: ${entry.relPath}`);
  }
  let raw: string;
  try {
    raw = catalog.readFile((entry as CatalogResourceEntryInternal).absPath);
  } catch (err) {
    fail(REASON.READ_FAILED, `failed to read resource: ${entry.relPath}`, err);
  }
  let text = raw;
  if (shouldCompose(entry.relPath)) {
    try {
      text = composeWorkflow(raw, { sourcePath: entry.relPath });
    } catch (err) {
      fail(REASON.READ_FAILED, `failed to compose resource: ${entry.relPath}`, err);
    }
  }
  return { uri: entry.uri, mimeType: entry.mimeType, text };
}

/**
 * Read one resource by uri. Index-membership-then-validate (design "Hostile
 * inputs"): the uri must be an exact key in `catalog.resources`; a workflow
 * entry is served through `shouldCompose`-gated composition (F1), a
 * reference entry is served verbatim. Throws a {@link CatalogError} for any
 * uri not present in the index — never an empty success.
 */
export function readResource(catalog: Catalog, uri: unknown): ReadResourceResult {
  if (typeof uri !== 'string') {
    fail(REASON.INVALID_PARAMS, `uri must be a string, got ${typeof uri}`);
  }
  if (uri.length === 0) {
    fail(REASON.INVALID_URI, 'uri must not be empty');
  }
  // Gate 1 — index membership, exact-match, never a path join.
  const entry = catalog.resources.get(uri);
  if (entry) {
    return readIndexedResource(catalog, entry);
  }
  fail(classifyUnindexedUri(uri), `unknown or refused resource uri: ${uri}`);
}

// ─── listResources — pagination ─────────────────────────────────────────────

interface DecodedCursor {
  readonly index: number;
}

function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger((parsed as { i?: unknown }).i) &&
      (parsed as { i: number }).i >= 0
    ) {
      return { index: (parsed as { i: number }).i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List resources, sorted deterministically by uri, optionally paginated.
 * Throws a {@link CatalogError} (`REASON.UNKNOWN_CURSOR`) for a malformed or
 * unrecognized cursor rather than silently resetting to page 1.
 */
export function listResources(catalog: Catalog, opts: ListResourcesOptions = {}): ListResourcesResult {
  const pageSize = opts.pageSize !== undefined && Number.isFinite(opts.pageSize) && opts.pageSize > 0 ? Math.floor(opts.pageSize) : DEFAULT_PAGE_SIZE;

  const sorted = [...catalog.resources.values()].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

  let startIndex = 0;
  if (opts.cursor !== undefined) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded === null) {
      fail(REASON.UNKNOWN_CURSOR, `unrecognized pagination cursor: ${opts.cursor}`);
    }
    startIndex = decoded.index;
  }

  const page = sorted.slice(startIndex, startIndex + pageSize);
  const nextIndex = startIndex + page.length;
  const result: { resources: CatalogResourceEntry[]; nextCursor?: string } = { resources: page };
  if (nextIndex < sorted.length) {
    result.nextCursor = encodeCursor(nextIndex);
  }
  return result;
}

// ─── getPrompt ───────────────────────────────────────────────────────────────

/**
 * Get one prompt by its bare command name (never a path). `args`, if
 * supplied, is accepted and ignored (design row 11 — no command template
 * takes injected arguments today). Throws a {@link CatalogError} for any
 * name not present in the index.
 */
export function getPrompt(catalog: Catalog, name: unknown, args?: unknown): GetPromptResult {
  void args;
  if (typeof name !== 'string' || name.length === 0) {
    fail(REASON.INVALID_PARAMS, `prompt name must be a non-empty string, got ${typeof name}`);
  }
  const entry = catalog.prompts.get(name);
  if (!entry) {
    fail(REASON.UNKNOWN_PROMPT, `unknown prompt: ${name}`);
  }
  let raw: string;
  try {
    raw = catalog.readFile((entry as CatalogPromptEntryInternal).absPath);
  } catch (err) {
    fail(REASON.READ_FAILED, `failed to read prompt: ${entry.relPath}`, err);
  }
  return {
    description: entry.description,
    messages: [{ role: 'user', content: { type: 'text', text: raw } }],
  };
}
