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
 * STATUS: skeleton only. Every function below is UNIMPLEMENTED
 * (`throw new Error('not implemented')`) so the failing-first test suites
 * (`tests/mcp-catalog.test.cjs`, `tests/mcp-server-catalog.test.cjs`,
 * `tests/mcp-catalog-parity.test.cjs`, `tests/mcp-catalog.property.test.cjs`)
 * fail on BEHAVIOR, not on `MODULE_NOT_FOUND`. `REASON` is the sole
 * exception — it is real, frozen, and complete against the 55-row test
 * matrix (`.gsd/phase/feat-3072-mcp-served-catalog/50-test-matrix.md`).
 */
'use strict';

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

/** The built, immutable catalog index. */
export interface Catalog {
  readonly resources: ReadonlyMap<string, CatalogResourceEntry>;
  readonly prompts: ReadonlyMap<string, CatalogPromptEntry>;
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
 * Build the immutable catalog index over `root` (or, if omitted, this
 * module's own package location — never `ctx.cwd`; design row 16).
 * Pure over the injected `readFile`/`readDir` seams so IO faults are tested
 * by monkeypatching them, never `chmod 0o000`.
 */
export function buildCatalog(opts: BuildCatalogOptions = {}): Catalog {
  void opts;
  throw new Error('not implemented');
}

/**
 * Read one resource by uri. Index-membership-then-validate (design "Hostile
 * inputs"): the uri must be an exact key in `catalog.resources`; a workflow
 * entry is served through `shouldCompose`-gated composition (F1), a
 * reference entry is served verbatim. Throws a {@link CatalogError} for any
 * uri not present in the index — never an empty success.
 */
export function readResource(catalog: Catalog, uri: unknown): ReadResourceResult {
  void catalog;
  void uri;
  throw new Error('not implemented');
}

/**
 * List resources, sorted deterministically by uri, optionally paginated.
 * Throws a {@link CatalogError} (`REASON.UNKNOWN_CURSOR`) for a malformed or
 * unrecognized cursor rather than silently resetting to page 1.
 */
export function listResources(catalog: Catalog, opts: ListResourcesOptions = {}): ListResourcesResult {
  void catalog;
  void opts;
  throw new Error('not implemented');
}

/**
 * Get one prompt by its bare command name (never a path). `args`, if
 * supplied, is accepted and ignored (design row 11 — no command template
 * takes injected arguments today). Throws a {@link CatalogError} for any
 * name not present in the index.
 */
export function getPrompt(catalog: Catalog, name: unknown, args?: unknown): GetPromptResult {
  void catalog;
  void name;
  void args;
  throw new Error('not implemented');
}

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
  void relPath;
  throw new Error('not implemented');
}
