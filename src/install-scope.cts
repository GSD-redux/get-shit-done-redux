/**
 * install-scope.cts — Install Scope Module (#2870, ADR-2866, governed by
 * ADR-2866, Phase 0 PR #3265).
 *
 * `resolveScope()` turns a bare `'global' | 'local'` string — previously
 * re-derived at 12 `isGlobal ? 'global' : 'local'` sites in `bin/install.js`
 * plus several downstream consumers — into ONE resolved value produced by
 * ONE module. See `.gsd/phase/feat-2870-install-scope-module/40-design.md`
 * for the full behavior table and rationale; the summary that matters for
 * future readers is captured in the comments below.
 *
 * This module OWNS the `InstallScope` type name. It was previously declared
 * (as a private, non-exported `TypeAlias`) inside
 * `runtime-artifact-install-plan.cts`; that module now imports it from here
 * instead of re-declaring it, so the codebase has one spelling of "install
 * scope" instead of a fifth one appearing alongside the three that already
 * existed (`'local' | 'global'` in the layout module, `'global' | 'project'`
 * in capability-lifecycle, and the single literal `'project'` in
 * capability-consent).
 *
 * ── Compose, never modify, resolveConfigHomeFromDescriptor ─────────────────
 * `resolveConfigHomeFromDescriptor` (`runtime-homes.cts`) is rated CRITICAL
 * blast radius: 60 dependents across 13 files and 2 process flows. Adding a
 * `scope` parameter to it — the "obvious" refactor — would touch all 60 for
 * no reason this module needs: it already resolves the GLOBAL config home
 * correctly today. So this module calls it as-is for the global scope and
 * derives the LOCAL scope's config dir independently (see
 * `resolveScopeConfigHome` below) — genuine composition, not a rename. Every
 * one of those 60 call sites stays byte-identical.
 *
 * ── Why `settingsFile: null` is correct, not a bug ──────────────────────────
 * Only `claude` declares `hostBehaviors.settingsFileByScope` in the
 * capability registry; the other 18 registered runtimes do not have a
 * per-scope settings file at all. Returning `null` for them is honest —
 * substituting `'settings.json'` (or any other Claude-shaped default) would
 * invent a fact for every non-Claude runtime that asked. Callers that
 * legitimately want a Claude-specific fallback (there is exactly one today,
 * `bin/install.js:550`) apply it themselves; this module does not.
 */

import path from 'node:path';
import os from 'node:os';

import {
  resolveConfigHomeFromDescriptor,
  type ConfigHomeDescriptor,
} from './runtime-homes.cjs';

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ── Public types ────────────────────────────────────────────────────────

/**
 * The two install-scope axis values. Spelling is `'local'`, not `'project'`:
 * `'local'` is the CLI's own vocabulary (`--local`), matches what the
 * artifact-layout module and the manifest already use, and is what the user
 * types. `'project'` is a SEPARATE, deliberately un-unified vocabulary that
 * belongs to the capability consent/lifecycle subsystem — see the boundary
 * mapping below.
 */
export type InstallScope = 'global' | 'local';

export interface ResolvedScope {
  id: InstallScope;
  /** Absolute config directory for this scope, normalized to forward
   *  slashes (see `normalizeSeparators` below). */
  configHome: string;
  /** Per-scope settings filename declared by the runtime's descriptor, or
   *  `null` when the runtime declares none. `null` is a value, not an
   *  error — see the module-level comment above. */
  settingsFile: string | null;
  /** `false` for `global` (nothing is recorded — the scope lives under the
   *  user's own home, matching `capability-lifecycle.cts:163`'s rule).
   *  `true` for `local`. This module reports the requirement; it does not
   *  perform or waive consent — `capability-consent.cts` owns that. */
  consentRequired: boolean;
  /** Higher wins; `global` outranks `local`. Carried as data only — nothing
   *  in this phase reads it (Phase 2, #2871, is the first consumer). Not a
   *  shadowing/collision answer on its own: whether two artifacts actually
   *  collide needs the trigger, which is out of scope here. */
  hostPrecedenceRank: number;
}

export interface ResolveScopeInput {
  id: InstallScope;
  runtime: string;
  /** Explicit config-dir override (e.g. `--config-dir`). Honored identically
   *  to `getGlobalConfigDir(runtime, explicitDir)` — takes precedence over
   *  every other resolution path, for both scopes. */
  explicitDir?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
  /** Working directory the `local` scope's `configHome` is resolved against
   *  — defaults to `process.cwd()`, so local-scope resolution is assertable
   *  without a real working directory, matching `env`/`home`/`existsSync`. */
  cwd?: string;
}

// ── The `local` / `project` boundary (see CONTEXT.md glossary entry) ──────
//
// `ConsentRecord.scope: 'project'` (capability-consent.cts) and
// `capability-lifecycle.cts:163`'s `'global' | 'project'` are NOT renamed to
// match this module's `'local'` spelling. `ConsentRecord.scope` is persisted
// on disk in user-owned consent records outside this repo; renaming that
// literal would silently invalidate every existing project-scoped consent
// record on a user's machine the next time it is read back. The
// reconciliation is a documented boundary mapping, not a rename sweep:
//   install scope 'local'  ⇄  consent scope 'project'
//   install scope 'global' ⇄  no consent record at all
// `consentRequired` above reports the install-scope side of that mapping;
// it is deliberately still the CLI's own vocabulary.

const VALID_SCOPE_IDS: ReadonlySet<string> = new Set(['global', 'local']);

/**
 * Single owner of the `'global' | 'local'` membership check. `resolveScope`
 * and `isGlobalScope` (below) both call this instead of each carrying its
 * own copy of the rule — two surfaces reading one validator, not two
 * validators that could silently diverge.
 */
function validateScopeId(id: unknown, caller: string): InstallScope {
  if (typeof id !== 'string' || !VALID_SCOPE_IDS.has(id)) {
    throw new TypeError(
      `${caller}: id must be one of 'global' | 'local', got ${JSON.stringify(id)}`,
    );
  }
  return id as InstallScope;
}

// Higher wins. Not exported as a public constant — only the resulting
// `hostPrecedenceRank` field on `ResolvedScope` is public API, so a future
// re-basing of the literal values (Phase 2, #2871) never requires touching
// an exported symbol.
const HOST_PRECEDENCE_RANK: Record<InstallScope, number> = {
  global: 2,
  local: 1,
};

interface HostBehaviorsForScope {
  settingsFileByScope?: Partial<Record<InstallScope, string>>;
}

interface RuntimeDescriptorForScope {
  configHome: ConfigHomeDescriptor;
  /** Project-relative local config dir (e.g. `.claude`), or `null` for a
   *  runtime with no installable config dir at all (vscode). Resolved
   *  against `resolveScope`'s input `cwd` (defaulting to the real process
   *  cwd), the same way `bin/install.js`'s existing local-scope call sites
   *  (e.g. `path.join(process.cwd(), '.agents')`) resolve it today. */
  localConfigDir?: string | null;
  hostBehaviors?: HostBehaviorsForScope;
}

interface RegistryLike {
  runtimes: Record<string, { runtime?: RuntimeDescriptorForScope }>;
}

/** Lazy registry accessor — mirrors the pattern in runtime-homes.cts /
 *  runtime-artifact-layout.cts (5b/5c/5d). */
function getRegistry(): RegistryLike {
  return _require('./capability-registry.cjs') as RegistryLike;
}

/**
 * Normalize path separators UNCONDITIONALLY (never gated on `path.sep` /
 * `process.platform`). A Windows-shaped `home` (`C:\Users\x`) can arrive on
 * any host — via an injected test fixture, a cross-platform config sync, or
 * a value copied from a Windows machine — so the normalization must not
 * depend on which OS this process happens to be running on.
 */
function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Minimal leading-`~` expansion for `explicitDir`. `runtime-homes.cts`'s own
 * `expandTilde` is NOT exported (it is a private helper), and this module
 * must not add exports to that CRITICAL-blast-radius file just to reuse
 * three lines — so this is an intentionally small, independent
 * reimplementation, not a fork of shared logic.
 */
function expandTildeForExplicitDir(p: string, home: string | undefined): string {
  const resolvedHome = home ?? os.homedir();
  if (p === '~') return resolvedHome;
  if (p.startsWith('~/')) return path.join(resolvedHome, p.slice(2));
  return p;
}

/**
 * Resolve the config-home directory for one scope. `explicitDir` short-
 * circuits both scopes identically (matches `getGlobalConfigDir`'s existing
 * override behavior — the module must not regress it). Otherwise:
 *   - `global`: delegates entirely to `resolveConfigHomeFromDescriptor`
 *     (composition — see the module-level comment).
 *   - `local`: joins the registry's `localConfigDir` onto `cwd` (defaulting
 *     to the real process cwd) — the project-local dir, independent of
 *     `home`/`env`.
 */
function resolveScopeConfigHome(
  id: InstallScope,
  descriptor: RuntimeDescriptorForScope,
  input: ResolveScopeInput,
): string {
  const explicitDir = input.explicitDir;
  if (typeof explicitDir === 'string' && explicitDir.trim() !== '') {
    return normalizeSeparators(expandTildeForExplicitDir(explicitDir, input.home));
  }

  if (id === 'local') {
    // localConfigDir is guaranteed non-null here: the only registered
    // runtime with `localConfigDir: null` is vscode, and vscode's
    // `configHome.kind === 'none'` already causes resolveScope to throw
    // before this function is ever called (see the 'none' guard below).
    const localConfigDir = descriptor.localConfigDir as string;
    const cwd = input.cwd ?? process.cwd();
    return normalizeSeparators(path.join(cwd, localConfigDir));
  }

  return normalizeSeparators(
    resolveConfigHomeFromDescriptor(descriptor.configHome, {
      env: input.env,
      home: input.home,
      existsSync: input.existsSync,
    }),
  );
}

/**
 * Resolve a bare `'global' | 'local'` scope id plus a runtime into a single
 * `ResolvedScope` value: the config directory, the per-scope settings
 * filename (or `null`), whether the scope requires a consent record, and a
 * precedence rank (data only this phase — see `hostPrecedenceRank` above).
 *
 * Pure: performs no writes and no I/O of its own beyond what
 * `resolveConfigHomeFromDescriptor` already performs via the injected
 * `existsSync` (for `global`) or the injected `cwd`, defaulting to
 * `process.cwd()` (for `local`). Never mutates `input`. The returned object
 * is frozen so a caller mutating the result cannot corrupt a subsequent
 * call.
 *
 * Throws `TypeError` for:
 *   - an `id` outside `'global' | 'local'` — including wrong case, empty,
 *     missing, or any non-string value (no coercion, ever);
 *   - an unknown `runtime` (no matching capability-registry entry);
 *   - a `runtime` whose descriptor has `configHome.kind === 'none'`
 *     (vscode) — there is no installable config directory to resolve, so
 *     inventing one (or silently returning `configHome: null`) would be
 *     dishonest. All three cases share one catch shape (`instanceof
 *     TypeError`) with `resolveRuntimeArtifactLayout`'s existing contract
 *     for unknown runtimes, so callers of both never need two different
 *     catch blocks.
 */
export function resolveScope(input: ResolveScopeInput): ResolvedScope {
  const scopeId = validateScopeId(input?.id, 'resolveScope');

  const runtime = input.runtime;
  const registryEntry = typeof runtime === 'string'
    ? getRegistry().runtimes[runtime]
    : undefined;
  const descriptor = registryEntry?.runtime;
  if (!descriptor) {
    throw new TypeError(
      `resolveScope: unknown runtime '${String(runtime)}' — not present in the capability registry`,
    );
  }
  if (descriptor.configHome.kind === 'none') {
    // #2103: vscode-shaped runtimes (Marketplace/VSIX, installSurface:
    // 'none') have no file-projected config directory at all — the same
    // carve-out tests/runtime-flags.test.cjs's NON_INSTALLABLE_RUNTIMES
    // already documents. Throwing here matches
    // resolveConfigHomeFromDescriptor's own deliberate throw on this kind,
    // rather than silently inventing an install scope for a runtime that
    // cannot be installed.
    throw new TypeError(
      `resolveScope: runtime '${runtime}' has no installable config directory (configHome.kind === 'none')`,
    );
  }

  const configHome = resolveScopeConfigHome(scopeId, descriptor, input);
  const settingsFile = descriptor.hostBehaviors?.settingsFileByScope?.[scopeId] ?? null;
  const consentRequired = scopeId === 'local';
  const hostPrecedenceRank = HOST_PRECEDENCE_RANK[scopeId];

  return Object.freeze({
    id: scopeId,
    configHome,
    settingsFile,
    consentRequired,
    hostPrecedenceRank,
  });
}

/**
 * Project an `InstallScope` down to the boolean shape some downstream APIs
 * still require. Four call sites (both kind-builder closures in
 * `runtime-artifact-layout.cts`, plus one each in
 * `runtime-artifact-install-plan.cts` and `surface.cts`) were each
 * independently re-deriving this same `scope === 'global'` comparison — four
 * copies of one rule that could silently drift apart (#2870). They exist
 * because `runtime-artifact-conversion.cts`'s `_computePathPrefix` takes
 * `isGlobal: boolean` at its API boundary, and that boundary is not changing
 * here, so the boolean projection cannot be eliminated — only centralized to
 * the one place below.
 *
 * Throws the same `TypeError`, with the same message shape, as
 * `resolveScope` throws for an `id` outside `'global' | 'local'` — both call
 * `validateScopeId` above, so the two error contracts cannot diverge.
 *
 * Deliberately throws, rather than returning `false`, for an out-of-union
 * value — unlike the inline `scope === 'global'` comparison it replaced,
 * which silently returned `false` for anything unrecognized. The
 * alternative is silently treating an unknown scope as "not global" and
 * writing artifacts to the wrong place, which is worse than failing loud.
 * A caller holding an optional `scope` (e.g. a raw `Layout.scope`) must
 * default it before calling this — see `surface.cts` for the pattern.
 */
export function isGlobalScope(scope: InstallScope): boolean {
  return validateScopeId(scope, 'isGlobalScope') === 'global';
}

/**
 * Project a bare `InstallScope` down to its `hostPrecedenceRank` — the SAME
 * `HOST_PRECEDENCE_RANK` table `resolveScope`'s `ResolvedScope.hostPrecedenceRank`
 * field reads, exposed standalone so a caller that only needs the ranking (not a
 * full config-home resolution, which touches the filesystem via
 * `resolveConfigHomeFromDescriptor`) never has to re-derive `{global: 2, local:
 * 1}` as a second copy of the same fact. First consumer: `resolveTriggerSurface`
 * (`runtime-artifact-layout.cts`, #2871 Phase 2), which is documented pure — no
 * filesystem — so it cannot call `resolveScope` itself. Same validation/error
 * contract as `resolveScope` / `isGlobalScope`: all three share `validateScopeId`,
 * so an out-of-union `id` throws the same `TypeError` shape everywhere.
 */
export function scopeRank(id: InstallScope): number {
  return HOST_PRECEDENCE_RANK[validateScopeId(id, 'scopeRank')];
}
