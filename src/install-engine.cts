/* eslint-disable @typescript-eslint/no-explicit-any,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-argument,
                  @typescript-eslint/no-require-imports */
// Mechanical extraction from bin/install.js; keep behavior parity before typing.
'use strict';

/**
 * Install Engine Module — ADR-1239 Phase B.
 *
 * Runtime-artifact install/uninstall cluster extracted from bin/install.js.
 * bin/install.js imports this module for the layout-driven install/uninstall
 * orchestrators and their private helpers. getCommitAttribution STAYS in
 * bin/install.js (impure install-time config I/O); it is injected via the
 * `resolveAttribution` parameter at each call site.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import runtimeArtifactConversion = require('./runtime-artifact-conversion.cjs');
import runtimeArtifactLayout = require('./runtime-artifact-layout.cjs');
import runtimeArtifactInstallPlan = require('./runtime-artifact-install-plan.cjs');
import runtimeNamePolicy = require('./runtime-name-policy.cjs');
import installProfiles = require('./install-profiles.cjs');
import installerMigrations = require('./installer-migrations.cjs');
import retiredArtifactCleanup = require('./retired-artifact-cleanup.cjs');
import { posixNormalize } from './shell-command-projection.cjs';
import { isPathConfined } from './external-descriptor-trust.cjs';
import { ensureCommonJsMarker } from './commonjs-marker.cjs';
import testHomeGuard = require('./real-home-guard.cjs');
// #2874 (ADR-58 cleanup phase): the injectable fs seam for the
// installRuntimeArtifacts call tree. `installFs()` resolves to real
// `node:fs` unless a call is wrapped in `withInstallFs(deps.fs, ...)` —
// every fs call below in this file that installRuntimeArtifacts's own call
// tree reaches goes through it. See install-fs-adapter.cts's module doc for
// why this is an ambient swap rather than a threaded `deps` parameter.
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs, withInstallFs } = installFsAdapter;
// #2875 (epic #2866 Phase 6): durable on-disk staging for USER_OWNED_ARTIFACTS
// across the preserve -> wipe -> restore window (#1874-F19). See
// user-artifact-staging.cts's module doc.
import userArtifactStaging = require('./user-artifact-staging.cjs');
// #2870: InstallScope is owned by install-scope.cts, not re-declared here.
// `isGlobalScope` centralizes the `scope === 'global'` boolean projection
// this module's two remaining re-derivation sites need (see the
// module-level doc comment on `isGlobalScope` for why the projection is
// centralized rather than eliminated).
import { isGlobalScope, type InstallScope } from './install-scope.cjs';

const { processAttribution } = runtimeArtifactConversion;
// resolveRuntimeArtifactLayout: accessed via module ref (not destructured) so
// test stubs that monkeypatch the module's exports are seen at call time.
const { getDirName } = runtimeNamePolicy;
// assertDestWithinConfigHome: must be accessed via module ref at call time for
// test-stub compatibility (monkeypatching the module property works; a local
// const binding from destructure would capture the pre-stub value).
// These are only called from functions that are not stubbed, but we use the
// module ref pattern consistently for correctness.

// ---------------------------------------------------------------------------
// Types (loose — minimal annotations for strict mode compliance)
// ---------------------------------------------------------------------------

type ResolveAttribution = (runtime: string) => any;

type RuntimeSurfaceSourceClass = 'commands' | 'agents';

function withInstallerPackageSource<T>(
  configDir: string,
  fn: () => T,
): T {
  // Reuse the existing compatibility-marker contract through the existing fs
  // seam. The marker exists only in this synchronous call tree: no disk state,
  // layout export, stage argument, or caller-settable authority flag is added.
  const markerPath = path.resolve(configDir, '.gsd-source');
  const packageCommandsRoot = runtimeArtifactLayout.findInstallSourceRoot();
  const markerBytes = Buffer.from(packageCommandsRoot + '\n');
  const base = installFs();
  const overlay = {
    ...base,
    existsSync: (candidate: string): boolean =>
      path.resolve(candidate) === markerPath || base.existsSync(candidate),
    lstatSync: (candidate: string): ReturnType<typeof base.lstatSync> =>
      path.resolve(candidate) === markerPath
        ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
        : base.lstatSync(candidate),
    readFileSync: ((candidate: string, encoding?: BufferEncoding): string | Buffer => {
      if (path.resolve(candidate) !== markerPath) {
        return encoding ? base.readFileSync(candidate, encoding) : base.readFileSync(candidate);
      }
      return encoding ? markerBytes.toString(encoding) : Buffer.from(markerBytes);
    }) as typeof base.readFileSync,
  };
  return withInstallFs(overlay, fn);
}

function isRuntimeSurfaceSourceUnavailable(message: string): boolean {
  return message.startsWith('Runtime Surface source is unavailable or incomplete for ') &&
    message.endsWith('install or upgrade gsd-core before materializing this surface.');
}

function assertCorpusTreeHasNoSymlinks(root: string): void {
  if (!installFs().existsSync(root)) return;
  const stat = installFs().lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Runtime Surface corpus path is a symlink: ${root}`);
  }
  if (!stat.isDirectory()) return;
  for (const name of installFs().readdirSync(root)) {
    assertCorpusTreeHasNoSymlinks(path.join(root, name));
  }
}

function previousOwnedCorpusFiles(configDir: string, prefix: string): string[] {
  try {
    const files = installerMigrations.readInstallManifest(configDir).files;
    return Object.keys(files)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .filter((entry) => entry !== '' && !path.posix.isAbsolute(entry) && !entry.split('/').some((part) => part === '' || part === '.' || part === '..'));
  } catch {
    // An absent or unreadable prior manifest provides no ownership evidence.
    // Preserve existing entries rather than guessing that they are stale.
    return [];
  }
}

function pruneEmptyCorpusParents(start: string, stop: string): void {
  let current = path.dirname(start);
  while (current !== stop && current.startsWith(stop + path.sep)) {
    if (installFs().readdirSync(current).length > 0) return;
    installFs().rmdirSync(current);
    current = path.dirname(current);
  }
}

function syncRuntimeSurfaceCorpus(source: string, destination: string, configDir: string, manifestPrefix: string): void {
  if (hasExistingSymlinkBetween(path.resolve(configDir), destination, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `syncRuntimeSurfaceCorpus: destination "${destination}" contains a symlink the install root "${configDir}" does not trust — refusing to write.`,
    );
  }
  assertCorpusTreeHasNoSymlinks(destination);

  // Remove only paths the previous manifest proves GSD owned and which the
  // executing package no longer ships. Unknown neighbouring files survive.
  for (const relative of previousOwnedCorpusFiles(configDir, manifestPrefix)) {
    const sourceEntry = path.join(source, ...relative.split('/'));
    let sourceIsFile = false;
    try {
      sourceIsFile = installFs().lstatSync(sourceEntry).isFile();
    } catch {
      sourceIsFile = false;
    }
    if (sourceIsFile) continue;

    const target = path.join(destination, ...relative.split('/'));
    if (!installFs().existsSync(target)) continue;
    const targetStat = installFs().lstatSync(target);
    if (!targetStat.isFile()) {
      throw new Error(`Runtime Surface corpus ownership conflict at ${target}`);
    }
    installFs().rmSync(target, { force: true });
    pruneEmptyCorpusParents(target, destination);
  }

  installFs().mkdirSync(path.dirname(destination), { recursive: true });
  installFs().cpSync(source, destination, { recursive: true });
}

/**
 * Provision the raw, installation-owned input needed to re-materialize a
 * global Runtime Surface after the executing package tree disappears.
 *
 * The corpus deliberately lives below the already-installed `gsd-core/`
 * tree and is accepted only after its manifest ownership and hashes verify.
 * The compatibility marker does not replace that installed-corpus authority.
 */
function provisionRuntimeSurfaceCorpus(
  layout: { runtime: string; kinds: Iterable<{ kind?: string }> },
  configDir: string,
  scope: string,
): void {
  const required = new Set<RuntimeSurfaceSourceClass>();
  if (isGlobalScope(scope as InstallScope)) {
    for (const kind of layout.kinds) {
      if (kind.kind === 'commands' || kind.kind === 'skills') required.add('commands');
      if (kind.kind === 'agents' || kind.kind === 'kimi-agents') required.add('agents');
    }
  }
  if (required.size === 0) return;

  const corpusRoot = path.join(configDir, 'gsd-core');
  if (required.has('commands')) {
    const source = runtimeArtifactLayout.findInstallSourceRoot();
    const destination = path.join(corpusRoot, 'commands', 'gsd');
    syncRuntimeSurfaceCorpus(source, destination, configDir, 'gsd-core/commands/gsd/');
  }
  if (required.has('agents')) {
    const source = path.join(executingPackageRoot(), 'agents');
    const destination = path.join(corpusRoot, 'agents');
    syncRuntimeSurfaceCorpus(source, destination, configDir, 'gsd-core/agents/');
  }

  const markerFile = _hostBehaviors(layout.runtime).sourceMarkerFile;
  if (typeof markerFile === 'string' && markerFile !== '' && required.has('commands')) {
    try {
      const markerPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(configDir, markerFile);
      if (hasExistingSymlinkBetween(path.resolve(configDir), markerPath, { allowOptInFollow: isSymlinkedDestOptIn() })) {
        throw new Error(`compatibility marker "${markerPath}" contains an untrusted symlink`);
      }
      installFs().writeFileSync(markerPath, path.join(corpusRoot, 'commands', 'gsd') + '\n', 'utf8');
    } catch {
      // The existing installer marker writer owns the user-facing warning and
      // keeps marker failure non-fatal. The installed corpus remains usable
      // without the compatibility marker.
    }
  }
}

function executingPackageRoot(): string { return path.dirname(path.dirname(runtimeArtifactLayout.findInstallSourceRoot())); }

// ---------------------------------------------------------------------------
// USER_OWNED_ARTIFACTS
// ---------------------------------------------------------------------------

/**
 * Single source of truth for user-owned artifacts inside gsd-core/.
 *
 * These files are created/refreshed by user-facing workflows (e.g.
 * /gsd-profile-user) and must be preserved across reinstalls. Critically, they
 * MUST be excluded from gsd-file-manifest.json — otherwise saveLocalPatches()
 * will compare a refreshed file against a stale manifest hash and emit a
 * spurious "locally modified GSD file" warning (bug #2771).
 *
 * Invariant: a file is either distribution (manifest-tracked, diff'd against
 * manifest) or user artifact (preserved across installs, never diff'd). Never
 * both. Both the user-artifact-staging.cts call sites (#2875) and
 * writeManifest must agree on this list, which is why it lives here as a
 * single constant.
 *
 * Paths are relative to the gsd-core/ directory.
 */
const USER_OWNED_ARTIFACTS: string[] = ['USER-PROFILE.md'];

// ---------------------------------------------------------------------------
// Host-behavior helpers
// ---------------------------------------------------------------------------

/**
 * Host-specific install behaviors declared on the runtime descriptor
 * (capabilities/<runtime>/capability.json -> runtime.hostBehaviors).
 * Mirrors bin/install.js's `_hostBehaviors` (ADR-1239 / #2086/#2087). Returns
 * {} for runtimes that declare none or if the registry fails to load, so
 * every behavior branch degrades to the generic path by default.
 */
function _hostBehaviors(runtime: string): any {
  try {
    const reg = require('./capability-registry.cjs');
    return (reg && reg.runtimes && reg.runtimes[runtime] && reg.runtimes[runtime].runtime && reg.runtimes[runtime].runtime.hostBehaviors) || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Apply per-runtime path-prefix rewrites for OpenCode-family skill bodies.
 * Replaces ~/.claude/, $HOME/.claude/, ./.claude/ and OpenCode-variant paths
 * with the computed pathPrefix for the install.
 */
function applyOpencodeFamilyPathPrefix(content: string, runtime: string, pathPrefix: string): string {
  content = content.replace(/~\/\.claude\//g, pathPrefix);
  content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
  content = content.replace(/\.\/\.claude\//g, `./${getDirName(runtime)}/`);
  content = content.replace(/~\/\.opencode\//g, pathPrefix);
  content = content.replace(/~\/\.kilo\//g, pathPrefix);
  return content;
}

/**
 * Convert a Claude command (.md) to an OpenCode skill (SKILL.md).
 * The canonical OpenCode-family writer lives in runtime-artifact-conversion.cjs
 * (single source of truth — avoids a duplicate writer drifting per
 * DEFECT.GENERATIVE-FIX); this thin wrapper delegates to it.
 */
function convertClaudeCommandToOpencodeSkill(content: string, skillName: string): string {
  return (runtimeArtifactConversion as any).convertClaudeCommandToOpencodeSkill(content, skillName);
}

/**
 * Convert a Claude command (.md) to a Kilo skill (SKILL.md).
 * Thin wrapper over the shared OpenCode-family writer (Kilo shares the schema).
 */
function convertClaudeCommandToKiloSkill(content: string, skillName: string): string {
  return (runtimeArtifactConversion as any).convertClaudeCommandToKiloSkill(content, skillName);
}

/**
 * Converter-name registry for the OpenCode-family combined skills installer
 * (ADR-1239 / #2093). Maps the `converter` string declared on each runtime's
 * artifactLayout skills-kind descriptor (capabilities/<runtime>/capability.json)
 * to the actual conversion function, so `installOpencodeFamilySkills` dispatches
 * off the descriptor instead of a `frontmatterDialect === 'kilo'` runtime check.
 */
const SKILLS_CONVERTER_REGISTRY: Record<string, (content: string, skillName: string) => string> = {
  convertClaudeCommandToOpencodeSkill,
  convertClaudeCommandToKiloSkill,
  convertClaudeCommandToKimiCodeSkill: runtimeArtifactConversion.convertClaudeCommandToKimiCodeSkill,
};

// ---------------------------------------------------------------------------
// Symlink-escape guard
// ---------------------------------------------------------------------------

/**
 * Opt-in for intentional symlinked-dest layouts (#2393). When the env var is
 * set to "1" or "true", `hasExistingSymlinkBetween` follows symlinks instead of
 * refusing them, EXCEPT for two load-bearing cases that always refuse regardless
 * of opt-in (preserving ADR-1239 Phase B's threat model):
 *
 *   (a) The `fullPath` itself, before any symlink resolution, escapes `root`
 *       via `..`-traversal — protects against untrusted `destSubpath` strings
 *       like `../../etc`. This is the line `resolvedFullPath !== resolvedRoot
 *       && !resolvedFullPath.startsWith(resolvedRoot + path.sep)` below.
 *   (b) A symlink's resolved real path equals the install root itself — this
 *       would let `_removeGsdEntries` (the prune pass) wipe the install root,
 *       which is the config-root-wipe threat from #1704 threat model item (b).
 *
 * What opt-in RELAXES specifically: the "pre-existing symlink that points
 * outside configHome" refusal — threat (c) in #1704. The user has asserted
 * they own and trust the symlink target. The default (no env var) keeps all
 * three refusals, exactly the pre-#2393 behavior.
 *
 * Cross-platform note: on Windows, `fs.lstatSync().isSymbolicLink()` returns
 * true for both symbolic links and NTFS junctions (Node ≥ 16), so Mamiki's
 * Junction case (#2393 comment) is handled by the same code path as POSIX
 * symlinks.
 *
 * @returns true when the caller MUST refuse; false when writes may proceed.
 */
function isSymlinkedDestOptIn(): boolean {
  const v = process.env.GSD_ALLOW_SYMLINKED_DEST;
  return v === '1' || v === 'true';
}

/**
 * `lstatSync`, never following a symlink, returning `null` instead of
 * throwing when `p` does not exist AT ALL (not even as a dangling symlink).
 * Unlike `existsSync` (which follows symlinks and reports `false` for a
 * dangling one), this correctly distinguishes "nothing here" from "a
 * symlink is here, even if its target is missing" — see
 * `hasExistingSymlinkBetween`'s own doc comment for why that distinction is
 * security-load-bearing.
 */
function tryLstat(p: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean } | null {
  try {
    return installFs().lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Returns true if any path component between `root` and `fullPath` is a
 * symbolic link that would redirect writes outside the install root in a way
 * the caller must refuse.
 *
 * When `options.allowOptInFollow` is true (caller checked `isSymlinkedDestOptIn`),
 * symlinks are followed instead of refused, except for the two always-refuse
 * cases documented on `isSymlinkedDestOptIn` — (a) path-traversal in `fullPath`
 * itself, (b) a resolved symlink target that equals the install root (would let
 * the prune pass wipe it).
 */
function hasExistingSymlinkBetween(
  root: string,
  fullPath: string,
  options: { allowOptInFollow?: boolean } = {},
): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedFullPath = path.resolve(fullPath);
  // (a) Path-traversal refusal — ALWAYS enforced, even with opt-in. An untrusted
  // destSubpath string that escapes the install root via '..' is rejected
  // regardless of user opt-in state (ADR-1239 Phase B threat (a)).
  if (resolvedFullPath !== resolvedRoot && !resolvedFullPath.startsWith(resolvedRoot + path.sep)) {
    return true;
  }

  // #2393 (security-review finding): realpathSync fully resolves all symlink
  // components, path.resolve only normalizes lexically. On macOS, /var is a
  // symlink to /private/var — so resolvedRoot='/var/foo/.claude' but its real
  // path is '/private/var/foo/.claude'. A symlink whose real target equals the
  // install root (the threat-(b) wipe case) would compare unequal without this
  // normalization, defeating the guard exactly in the reporter's case (Azd325,
  // nix-darwin: ~/.claude is itself a symlink). Compute realRoot once; fall
  // back to the lexical form on any realpath failure (broken/missing/exotic FS)
  // — threat (a) above still confines regardless.
  let realRoot: string;
  try {
    realRoot = installFs().existsSync(resolvedRoot) ? installFs().realpathSync(resolvedRoot) : resolvedRoot;
  } catch {
    realRoot = resolvedRoot;
  }

  const allowFollow = options.allowOptInFollow === true;

  // #2393: when root itself is a symlink (e.g. nix-darwin manages ~/.claude as a
  // symlink to a dotfiles repo — Azd325's #2393 report), the pre-#2393 guard
  // refused unconditionally via an early return before the component loop. The
  // wipe threat (b) does NOT apply to the root itself being a symlink: destDir is
  // a CHILD of root, and resolving root gives root's target — there is no
  // circular back-reference to root from a path that descends from a resolved
  // root. So under opt-in, just follow the root symlink and continue the walk.
  // Default behavior (no opt-in) preserves the pre-#2393 refuse.
  // #2875 defect fix: `existsSync` FOLLOWS symlinks and returns `false` for a
  // DANGLING symlink (one whose target does not exist) — so the pre-fix
  // `existsSync(cursor) && lstatSync(cursor).isSymbolicLink()` ordering used
  // below (both here for `root` and in the per-segment loop) silently
  // treated a dangling symlink as "nothing here", never even reaching the
  // `lstatSync` symlink check. That let a dangling symlink planted AT a
  // write destination — e.g. `<configDir>/USER-PROFILE.md ->
  // <outside>/authorized_keys` — sail through this guard, after which the
  // actual write (`copyFileSync` et al., which DOES follow symlinks) created
  // attacker-controlled content outside the install root. `lstatSync` itself
  // never follows a symlink and succeeds for a dangling one, so probing with
  // it FIRST (falling back to "does not exist at all" only on ENOENT/similar)
  // detects the dangling case correctly while preserving the exact same
  // "cursor does not exist, stop walking" behavior for a path that truly has
  // nothing there.
  let cursor = resolvedRoot;
  const cursorLstat = tryLstat(cursor);
  if (cursorLstat && cursorLstat.isSymbolicLink()) {
    if (!allowFollow) return true;
    try {
      cursor = installFs().realpathSync(cursor);
    } catch {
      // realpathSync failed (broken symlink, permission denied, exotic FS) — refuse,
      // matching fail-closed posture.
      return true;
    }
  }

  const relative = path.relative(resolvedRoot, resolvedFullPath);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    const segmentLstat = tryLstat(cursor);
    if (!segmentLstat) return false;
    if (segmentLstat.isSymbolicLink()) {
      if (!allowFollow) return true;
      // Opt-in active: follow the symlink. Refuse if the resolved target is the
      // install root itself (threat (b) — would let _removeGsdEntries wipe the
      // root). Other targets are acceptable per the user's explicit opt-in. A
      // broken symlink (realpathSync throws) is still refused.
      //
      // Threat (b) check uses BOTH lexical and real forms of root to defend
      // against macOS /var ↔ /private/var-style normalization gaps: realpathSync
      // fully resolves, path.resolve only normalizes lexically, so a root path
      // containing a symlink component would compare unequal to a realtarget
      // that matches by real path. Compare both.
      //
      // Transitivity note: once followed, the walk continues from the resolved
      // real path WITHOUT re-checking that further segments stay inside any
      // confining boundary. The user's opt-in asserts trust in the target dir
      // AND any further symlinks reachable through it — transitive and unbounded
      // by design (one opt-in trusts the whole reachable tree). This is the
      // documented opt-in semantics; do not add a "follow one symlink only"
      // expectation here without revisiting the threat model.
      try {
        const realTarget = installFs().realpathSync(cursor);
        if (realTarget === realRoot || realTarget === resolvedRoot) return true; // (b)
        cursor = realTarget;
      } catch {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// User-artifact staging root
// ---------------------------------------------------------------------------

/**
 * Resolve the durable staging root for `configDir` (#2875 / user-artifact-
 * staging.cts), confined via the SAME `assertDestWithinConfigHome` gate every
 * other write on this call tree uses, and refused via the SAME
 * `hasExistingSymlinkBetween` guard `_copyStaged`/
 * `migrateLegacyDevPreferencesToSkill` already apply to their own writes
 * (test-matrix E1/E4) — this module never reimplements either decision, only
 * reuses them (user-artifact-staging.cts's own module doc, "Confinement").
 *
 * Fixed location: `<configDir>/.gsd-staging/user-artifacts/` — a sibling of
 * every directory this phase's four call sites wipe, so staging survives all
 * of them while staying inside configDir (40-design.md "Staging location").
 */
function _resolveUserArtifactStagingRoot(configDir: string): string {
  const stagingRoot = runtimeArtifactInstallPlan.assertDestWithinConfigHome(
    configDir,
    path.posix.join('.gsd-staging', 'user-artifacts'),
  );
  if (hasExistingSymlinkBetween(path.resolve(configDir), stagingRoot, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `_resolveUserArtifactStagingRoot: staging root "${stagingRoot}" contains a symlink the install root "${configDir}" does not trust — refusing to stage. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  return stagingRoot;
}

/**
 * Degrade-not-abort wrapper over `_resolveUserArtifactStagingRoot` (defect
 * fix — a hostile/broken `.gsd-staging` path, or a symlinked configDir
 * itself, e.g. nix-darwin/dotfiles-managed `~/.claude`, GSD_ALLOW_SYMLINKED_DEST's
 * own population) must never brick the command it is called from. Before
 * this fix `_resolveUserArtifactStagingRoot` was called UNGUARDED as the
 * first statement of both `install()` and `uninstall()` (bin/install.js) —
 * `ln -s /nonexistent ~/.claude/.gsd-staging` killed both commands,
 * including uninstall, the remedy for the first problem.
 *
 * Returns `null` (never throws) when staging is unavailable, logging ONE
 * warning naming the underlying cause. Every call site MUST treat `null` as
 * "skip the staging-dependent step for this run" — the same "degrade,
 * never throw" posture user-artifact-staging.cts's own recovery/restore
 * functions already document (module doc "Failure posture"), extended to
 * cover staging-ROOT resolution itself, not just the copy/restore that
 * follows it.
 */
function _tryResolveUserArtifactStagingRoot(configDir: string): string | null {
  try {
    return _resolveUserArtifactStagingRoot(configDir);
  } catch (err) {
    console.warn(
      `  [gsd] user-artifact staging unavailable for "${configDir}" (${(err as Error).message}) — proceeding without durable staging for this step.`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// migrateLegacyDevPreferencesToSkill
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy dev-preferences.md (saved from commands/gsd/) into the
 * runtime-aware SKILL.md location used by the writer after #2973.
 *
 * For runtimes with a nested skills layout (e.g. Hermes: skills/gsd/<stem>/),
 * the target is <configDir>/skills/gsd/dev-preferences/SKILL.md.
 * For runtimes with a flat skills layout (prefix='gsd-'), the target is
 * <configDir>/skills/gsd-dev-preferences/SKILL.md.
 *
 * Skips silently if no legacy file was preserved, or if a SKILL.md already
 * exists at the new location (don't clobber user-customized skill content
 * — they may have edited the new file directly). Returns true on actual
 * migration so callers can log a one-line confirmation.
 *
 * @param targetDir - Resolved runtime config directory (e.g. ~/.claude)
 * @param saved - Map of fileName -> content, built by the caller from a
 *   user-artifact-staging.cts staged batch's disk contents (#2875) — every
 *   call site reads this back AFTER its own wipe, never held in memory
 *   across it.
 * @param runtime - canonical runtime ID (e.g. 'hermes', 'qwen', 'claude')
 * @param scope - install scope
 * @returns true if a file was migrated, false otherwise
 */
/**
 * Resolve the `{ skillFile, installRoot }` `migrateLegacyDevPreferencesToSkill`
 * would target for `(targetDir, runtime, scope)`, WITHOUT performing any
 * write. Extracted (#2875 defect fix) purely as a resolution helper so a
 * caller can determine whether migration is even POSSIBLE for this
 * runtime/scope, and whether it is already SATISFIED (a skill file already
 * present), BEFORE deciding whether discarding a staged legacy copy would
 * lose the user's file — `migrateLegacyDevPreferencesToSkill`'s own boolean
 * return conflates "no skills layout for this runtime" with "the write
 * failed" with "already migrated": all three return `false` today, and
 * changing that return SHAPE would also change bin/install.js's own
 * `if (migrateLegacyDevPreferencesToSkill(...))` call site, which this
 * module does not own. This helper changes nothing about
 * `migrateLegacyDevPreferencesToSkill`'s own signature or behavior — it is
 * now IMPLEMENTED in terms of this helper, so there is exactly one copy of
 * the resolution logic, never two that could drift.
 *
 * @returns `{ skillFile, installRoot }`, or `null` if this runtime/scope has
 *   no skills layout to migrate into (mirrors `migrateLegacyDevPreferencesToSkill`'s
 *   own early return for that case).
 */
function _resolveDevPreferencesSkillTarget(targetDir: string, runtime?: string, scope: string = 'global'): { skillFile: string; installRoot: string; hasHomeOverride: boolean } | null {
  let skillDir: string;
  // #2911: the actual install root the skill dir resolves under — defaults to
  // targetDir, but a skills-kind `home` override (e.g. Codex -> $HOME/.agents)
  // moves it entirely outside targetDir. Every confinement/guard check below
  // must confine against installRoot, not targetDir, or it would flag the
  // legitimate override destination as an escape.
  let installRoot: string = targetDir;
  // Reported in Codex review of #3725: `installRoot !== targetDir` was used as the
  // stand-in for "the skills kind declared a `home` override", and the two are NOT
  // equivalent — a resolved `home` that happens to EQUAL targetDir (a configDir of
  // `$HOME/.agents`, which is exactly where codex's override points) makes the
  // inequality false while the override is very much declared, skipping the guard
  // and writing SKILL.md into the real home. Report the declaration itself instead
  // of inferring it from two paths, read off the SAME layout resolution the
  // destination came from so the guard cannot vouch for a path this does not write.
  let hasHomeOverride = false;
  if (runtime) {
    const layout: any = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, targetDir, scope as any);
    const skillsKindEntry = layout.kinds.find((k: any) => k.kind === 'skills');
    if (!skillsKindEntry) return null; // runtime has no skills layout at this scope (e.g. cline local)
    const stemName = skillsKindEntry.prefix === '' ? 'dev-preferences' : 'gsd-dev-preferences';
    // #2911: same destination-root defect as _copyStaged/applySurface — honor
    // skillsKindEntry.home as a FALLBACK-preferred override (e.g. Codex skills
    // -> $HOME/.agents) instead of always resolving against targetDir, so a
    // legacy dev-preferences migration lands in the SAME tree the installer
    // and surface-apply use. Runtimes with no `home` override are unaffected.
    hasHomeOverride = skillsKindEntry.home != null;
    installRoot = skillsKindEntry.home ?? targetDir;
    skillDir = path.join(runtimeArtifactInstallPlan.assertDestWithinConfigHome(installRoot, skillsKindEntry.destSubpath), stemName);
  } else {
    // Legacy fallback for callers that have not yet been updated to pass runtime
    skillDir = path.join(runtimeArtifactInstallPlan.assertDestWithinConfigHome(targetDir, 'skills'), 'gsd-dev-preferences');
  }
  return { skillFile: path.join(skillDir, 'SKILL.md'), installRoot, hasHomeOverride };
}

/**
 * @param deps - #3712 test seam, mirroring the one on `installRuntimeArtifacts`
 *   and `uninstallRuntimeArtifacts`. This is the SIXTH writer that resolves a
 *   skills-kind `home`, and its guard's trigger condition — "HOME equals the
 *   passwd home" — cannot be reproduced without pointing at the developer's real
 *   home, so it is injected rather than simulated. Production callers pass
 *   nothing and bind real `os`/`process.env`.
 */
function migrateLegacyDevPreferencesToSkill(
  targetDir: string,
  saved: Map<string, string>,
  runtime?: string,
  scope: string = 'global',
  deps: { os?: any; env?: Record<string, string | undefined> } = {},
): boolean {
  if (!saved || !saved.has('dev-preferences.md')) return false;
  const target = _resolveDevPreferencesSkillTarget(targetDir, runtime, scope);
  if (!target) return false; // runtime has no skills layout at this scope (e.g. cline local)
  // #3712 — the SIXTH writer that resolves a skills-kind `home` override.
  // Exported and directly callable, and `_runLegacyInstallMigrations` runs it
  // BEFORE installRuntimeArtifacts' own assertion, so a future runtime pairing a
  // home override with this migration would write to the real home ahead of any
  // guard. It creates rather than prunes, which is why it was missed.
  //
  // Guards the destination ALREADY RESOLVED above, never a second resolution of
  // its own. An earlier revision re-ran resolveRuntimeArtifactLayout() here —
  // and without `capabilityRegistry`, so a registry-dependent descriptor could
  // make the two disagree and leave the guard vouching for a path the migration
  // does not write. That is the generative-fix-divergence shape; reported in
  // review of #3725. `target.hasHomeOverride` is that same resolution's own answer
  // to "did the skills kind declare a `home`?" — not re-derived, and not inferred
  // from `installRoot !== targetDir`, which is false whenever the override happens
  // to resolve onto targetDir itself (Codex review of #3725).
  if (runtime && target.hasHomeOverride) {
    testHomeGuard.assertTestHomeSandboxed('migrateLegacyDevPreferencesToSkill', runtime, [
      { kind: 'skills', home: path.dirname(target.skillFile) },
    ], { os: deps.os, env: deps.env });
  }
  const { skillFile, installRoot } = target;
  const skillDir = path.dirname(skillFile);
  // Security fix: `existsSync` FOLLOWS symlinks and reports `false` for a
  // DANGLING one, so the prior `existsSync(skillFile)` check never even saw a
  // dangling symlink planted AT the leaf (e.g.
  // `<installRoot>/skills/gsd-dev-preferences/SKILL.md ->
  // ~/.ssh/authorized_keys`) — it fell through past this "already migrated"
  // bail, past the symlink-escape guard below (which only walks to `skillDir`,
  // the parent DIRECTORY, and never lstats the leaf FILE itself), and into
  // `writeFileSync`, which DOES follow symlinks and would have written
  // attacker-chosen `saved` content to the symlink's target. `tryLstat` never
  // follows a symlink and distinguishes "a real file is already here" (skip,
  // same as before) from "a symlink (dangling or not) is planted here"
  // (refuse — this is never a legitimate prior-migration state).
  const skillFileLstat = tryLstat(skillFile);
  if (skillFileLstat) {
    if (skillFileLstat.isSymbolicLink()) {
      throw new Error(
        `migrateLegacyDevPreferencesToSkill: skillFile "${skillFile}" is a symlink — refusing to write dev-preferences.md content through it (would follow the link and write to its target).`,
      );
    }
    return false; // a real file is already there — already migrated, skip
  }
  // Symlink-escape guard: reject if any path component between installRoot and
  // skillDir is a symlink that would redirect writes outside the install root.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(path.resolve(installRoot), skillDir, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `migrateLegacyDevPreferencesToSkill: skillDir "${skillDir}" contains a symlink the install root "${installRoot}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  try {
    installFs().mkdirSync(skillDir, { recursive: true });
    installFs().writeFileSync(skillFile, saved.get('dev-preferences.md')!, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// _copyStaged
// ---------------------------------------------------------------------------

/**
 * Copy a staged directory's contents into destDir.
 * Additive — does not prune (surface.cjs handles pruning).
 *
 * For skills kind: each child of stagedDir is a `${prefix}${stem}/` dir; copy
 *   the whole dir into destDir.
 * For commands/agents kind: iterate .md files and write them into destDir.
 *   - commands: write as `${prefix}${stem}.md` unless destSubpath already
 *     encodes the GSD namespace as its last segment (e.g. `commands/gsd`), in
 *     which case write as `${stem}.md` (directory IS the namespace).
 *   - agents: write as-is (files already carry their own `gsd-` prefix).
 * For kimi-agents kind: recursively copy generated YAML/prompt files.
 */
function _copyStaged(stagedDir: string, destDir: string, kind: any, configDir: string, runtime?: string): void {
  // Defense-in-depth: verify destDir is within the install root even if the
  // upstream assertDestWithinConfigHome check was somehow bypassed. This guards
  // the actual write site against any future call-site drift.
  // Fail-closed: every _copyStaged write must declare its install root so the gate
  // can confine it. All callers pass configDir; an omitted root is a bug, not a copy.
  if (configDir === undefined) {
    throw new Error(
      '_copyStaged: configDir (install root) is required to confine writes — refusing to write',
    );
  }
  // The install root is normally configDir, but a kind may declare an alternate
  // `home` (ADR-1239 upgrade 3 / #2088, e.g. Codex skills -> $HOME/.agents) — in
  // that case this defense-in-depth check must confine against the resolved
  // alternate root instead, matching the upstream gate's own root selection in
  // createRuntimeArtifactInstallPlan.
  const installRoot = (kind && typeof kind.home === 'string' && kind.home !== '') ? kind.home : configDir;
  // Strict-subpath + NUL containment via the canonical gate (shared with the
  // layout-driven install plan); throws if destDir escapes the install root.
  // destDir here is an absolute path; path.resolve(installRoot, absoluteDest) returns it unchanged, so the gate's strict-subpath check still correctly confines it to installRoot.
  const resolvedDest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(installRoot, destDir);
  // Symlink-escape guard: reject if any path component between the install root and
  // destDir is a symlink that would redirect writes outside the install root.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(path.resolve(installRoot), resolvedDest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `_copyStaged: destDir "${destDir}" contains a symlink the install root "${installRoot}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  // Use the validated absolute path for the actual writes below.
  destDir = resolvedDest;
  if (!installFs().existsSync(stagedDir)) return;
  installFs().mkdirSync(destDir, { recursive: true });

  if (kind.kind === 'skills') {
    // Each child of stagedDir is a prefixed skill directory: gsd-help/, etc.
    for (const entry of installFs().readdirSync(stagedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(stagedDir, entry.name);
      const dest = path.join(destDir, entry.name);
      installFs().cpSync(src, dest, { recursive: true });
    }
    return;
  }

  if (kind.kind === 'kimi-agents') {
    installFs().cpSync(stagedDir, destDir, { recursive: true });
    return;
  }

  // commands or agents
  const entries = installFs().readdirSync(stagedDir, { withFileTypes: true });
  // For commands: apply prefix unless the destSubpath's last segment already
  // represents the GSD namespace (e.g. 'commands/gsd' → last segment 'gsd').
  // Single source of truth: runtimeArtifactLayout.isNamespacedByDir (#2871
  // Phase 2 review finding — this rule previously drifted independently
  // across install-engine.cts / surface.cts / runtime-artifact-layout.cts).
  const namespacedByDir = runtimeArtifactLayout.isNamespacedByDir(kind.kind, kind.destSubpath, kind.prefix);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3); // strip .md

    let destName: string;
    if (kind.kind === 'agents') {
      // Agent files already carry the gsd- prefix in the source dir.
      // #2099: descriptor-driven via hostBehaviors.agentFileExtension (was
      // hardcoded `runtime === 'copilot'`). copilot declares '.agent.md';
      // every other runtime's descriptor leaves this unset, so destName falls
      // back to entry.name unchanged (byte-parity, #1575 origin comment).
      const _agentExt = runtime ? _hostBehaviors(runtime).agentFileExtension : undefined;
      destName = _agentExt
        ? entry.name.replace(/\.md$/, _agentExt)
        : entry.name;
    } else {
      // Commands: filename composition (namespacedByDir ? `${stem}.md` :
      // `${prefix}${stem}.md`) is single-sourced with resolveTriggerSurface's
      // destPath prediction via composeCommandFilename (#2871 Phase 2 review
      // finding). Byte-identical to the prior separate namespacedByDir/flat
      // branches — see that helper's doc comment for why the namespacedByDir
      // case reconstructing `${stem}.md` is always exactly `entry.name`.
      destName = runtimeArtifactLayout.composeCommandFilename(namespacedByDir, kind.prefix, stem);
    }

    installFs().copyFileSync(path.join(stagedDir, entry.name), path.join(destDir, destName));
  }
}

// ---------------------------------------------------------------------------
// _removeGsdEntries
// ---------------------------------------------------------------------------

/**
 * Remove GSD-prefixed entries from destDir matching kind.prefix.
 * For the prefix='' case: the destSubpath IS the namespace — remove the entire
 * destDir. (No current runtime uses prefix='' after #947 reversed Hermes; kept
 * as a defensive guard for future runtimes.)
 */
function _removeGsdEntries(destDir: string, kind: any): void {
  if (!installFs().existsSync(destDir)) return;
  if (kind.kind === 'kimi-agents') {
    for (const fileName of ['gsd.yaml', 'gsd.md']) {
      installFs().rmSync(path.join(destDir, fileName), { force: true });
    }
    const subagentsDir = path.join(destDir, 'subagents');
    if (installFs().existsSync(subagentsDir)) {
      for (const entry of installFs().readdirSync(subagentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith('gsd-')) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.md')) continue;
        installFs().rmSync(path.join(subagentsDir, entry.name), { force: true });
      }
    }
    return;
  }
  if (kind.prefix === '') {
    // Whole-namespace removal (Hermes nested case — destSubpath is skills/gsd)
    // The directory itself is the GSD namespace, so remove it entirely.
    installFs().rmSync(destDir, { recursive: true, force: true });
    return;
  }
  for (const entry of installFs().readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(kind.prefix)) continue;
    installFs().rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// _snapshotDir / _restoreDir
// ---------------------------------------------------------------------------

/**
 * Deep-snapshot a directory tree into a Map<relPath, Buffer>.
 * Returns an empty Map if the directory doesn't exist.
 */
function _snapshotDir(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!installFs().existsSync(dir)) return files;
  const walk = (relPath: string, absPath: string) => {
    for (const e of installFs().readdirSync(absPath, { withFileTypes: true })) {
      const childRel = relPath ? path.join(relPath, e.name) : e.name;
      const childAbs = path.join(absPath, e.name);
      if (e.isDirectory()) walk(childRel, childAbs);
      else if (e.isFile()) files.set(childRel, installFs().readFileSync(childAbs));
    }
  };
  walk('', dir);
  return files;
}

/**
 * Restore a directory tree from a Map<relPath, Buffer> produced by _snapshotDir.
 */
function _restoreDir(dir: string, snapshot: Map<string, Buffer>): void {
  for (const [relPath, buf] of snapshot) {
    const absPath = path.join(dir, relPath);
    installFs().mkdirSync(path.dirname(absPath), { recursive: true });
    installFs().writeFileSync(absPath, buf);
  }
}

// ---------------------------------------------------------------------------
// _removeHermesBareStemDirs
// ---------------------------------------------------------------------------

/**
 * After the layout-driven install loop writes new gsd-<stem>/ dirs to
 * skills/gsd/, remove any pre-existing bare-stem dirs (skills/gsd/<stem>/)
 * that correspond to the newly installed gsd-<stem> entries.
 *
 * @param nestedGsdDir  absolute path to skills/gsd/ category dir
 */
function _removeHermesBareStemDirs(nestedGsdDir: string): void {
  if (!installFs().existsSync(nestedGsdDir)) return;
  const entries = installFs().readdirSync(nestedGsdDir, { withFileTypes: true });

  // Collect the set of stems that were installed as gsd-<stem>/ this run.
  const installedStems = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
      installedStems.add(entry.name.slice('gsd-'.length)); // e.g. 'quick', 'dev-preferences'
    }
  }

  // Remove any bare <stem>/ dir for which gsd-<stem>/ was just installed.
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('gsd-') && installedStems.has(entry.name)) {
      installFs().rmSync(path.join(nestedGsdDir, entry.name), { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy migration helpers
// ---------------------------------------------------------------------------

/**
 * Run legacy install migrations that must execute BEFORE the layout-driven
 * copy so stale artifacts are cleaned up before new ones are written.
 *
 * @param runtime
 * @param configDir  resolved runtime config directory
 * @param scope
 */
function _runLegacyInstallMigrations(runtime: string, configDir: string, scope: string = 'global'): void {
  const legacyCommandsGsd = path.join(configDir, 'commands', 'gsd');

  // Claude / Qwen / Hermes: clean up legacy commands/gsd/ and preserve dev-preferences
  // for migration. The actual migration call is deferred to after all layout cleanup so
  // that for Hermes the flat skills/gsd-*/ removal (below) does not delete the freshly
  // created skills/gsd-dev-preferences/ skill dir.
  let stagedLegacyArtifacts: ReturnType<typeof userArtifactStaging.stageUserArtifacts> | null = null;
  if (_hostBehaviors(runtime).legacyCommandsGsdInstallMigration) {
    if (installFs().existsSync(legacyCommandsGsd)) {
      // #2875: staging root resolved lazily, only when there is actually
      // something to stage — reused below by every other call site sharing
      // this configDir.
      // #2875 defect fix: DEGRADE, never abort the whole install, when the
      // staging root itself cannot be resolved (e.g. a hostile/broken
      // `.gsd-staging` symlink) — skip this legacy-migration block entirely
      // rather than wipe legacyCommandsGsd without a durable backup (module
      // doc "Failure posture": a wipe having staged nothing is worse than no
      // staging at all). The stale legacy dir is simply left in place for a
      // future successful run.
      const stagingRoot = _tryResolveUserArtifactStagingRoot(configDir);
      if (stagingRoot !== null) {
        // #2875 (#1874-F19): staged DURABLY to disk before the wipe below, so a
        // crash anywhere in this function — including the Hermes flat-skills
        // wipe further down, previously inside the same in-memory-only window
        // — survives via recoverOrphanedUserArtifacts on the next run.
        stagedLegacyArtifacts = userArtifactStaging.stageUserArtifacts(legacyCommandsGsd, ['dev-preferences.md'], stagingRoot);
        installFs().rmSync(legacyCommandsGsd, { recursive: true });
      }
    }
  }

  // Hermes: remove pre-#2841 flat skills/gsd-*/ entries that lived alongside
  // the new skills/gsd/ nested layout.
  if (runtime === 'hermes') {
    const flatSkillsDir = path.join(configDir, 'skills');
    if (installFs().existsSync(flatSkillsDir)) {
      for (const entry of installFs().readdirSync(flatSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
          installFs().rmSync(path.join(flatSkillsDir, entry.name), { recursive: true });
        }
      }
    }

    // Hermes: bare-stem skills/gsd/<stem>/ cleanup is deferred to AFTER the
    // layout-driven install loop in installRuntimeArtifacts, where the exact set
    // of staged gsd-<stem>/ dirs is known. Removing here (before staging) would
    // require readGsdCommandNames() which misses skills like 'dev-preferences'
    // that are not in the commands directory. See _removeHermesBareStemDirs().
  }

  // Migrate dev-preferences.md content → runtime-aware SKILL.md location (#2973).
  // Done after all layout cleanup so Hermes flat-dir removal does not delete the
  // newly created skill dir. No-op if skill file already exists.
  if (stagedLegacyArtifacts) {
    // #2875: read the content back from the DISK-staged copy (fresh, after
    // every wipe above has already run) rather than an in-memory value held
    // across them.
    //
    // #2875 defect fix (readFileSync following a staged symlink):
    // readFileSync ALWAYS follows a symlink — a staged artifact that is
    // itself a symlink (module doc "Symlink safety", A4: staging never
    // dereferences a symlink; a symlinked USER-artifact is recreated AS a
    // symlink in the staging tree, not copied by content) would have its
    // REFERENT's bytes read here and land in SKILL.md, violating this
    // module's own "referent bytes never read" contract. A symlinked staged
    // name is excluded from migration below and restored to its original
    // location instead — migrating a symlink AS skill-file text content is
    // not a coherent operation to begin with.
    const savedLegacyArtifacts = new Map<string, string>();
    const migratableNames: string[] = [];
    for (const name of stagedLegacyArtifacts.names) {
      const stagedPath = path.join(stagedLegacyArtifacts.filesDir, name);
      // #2875 defect fix (crash resilience — TOCTOU): a raw `lstatSync` throws
      // if `stagedPath` has vanished between staging (above) and this read —
      // e.g. a co-resident attacker on a shared machine racing the staging
      // dir, the exact threat class this module's own "Confinement" doc
      // already treats as live. Every sibling probe in this file (`tryLstat`
      // itself, and its use at `skillFileLstat` above) already degrades
      // rather than throws; do the same here — a vanished staged file is
      // simply not migratable, matching A2's "absent, not staged, no throw"
      // precedent in user-artifact-staging.cts.
      const stagedLstat = tryLstat(stagedPath);
      if (!stagedLstat || stagedLstat.isSymbolicLink()) continue;
      savedLegacyArtifacts.set(name, installFs().readFileSync(stagedPath, 'utf8'));
      migratableNames.push(name);
    }
    // #2875 defect fix (regression closed — was previously unguarded and
    // BRICKED the command): migrateLegacyDevPreferencesToSkill correctly
    // THROWS when it finds a planted/dangling symlink at the skill-file leaf
    // (security fix — refusing to write through it is correct) but by this
    // point legacyCommandsGsd has ALREADY been wiped (rmSync above) and
    // stagedLegacyArtifacts is the only surviving copy. An unguarded throw
    // here propagated straight out of installRuntimeArtifacts, aborting the
    // whole install/uninstall WITHOUT ever reaching the restore-or-discard
    // logic below — the staged batch was orphaned on disk and every retry
    // hit the same throw again (same brick-the-command failure mode this
    // module's "DEGRADE, never abort" posture, see
    // _tryResolveUserArtifactStagingRoot above, already closed for a broken
    // `.gsd-staging` path). Degrade identically: catch, warn once, and treat
    // the batch as unmigrated so the restore branch below fires.
    let migrated = false;
    let migrationRefused = false;
    try {
      migrated = migrateLegacyDevPreferencesToSkill(configDir, savedLegacyArtifacts, runtime, scope);
    } catch (err) {
      console.warn(
        `  [gsd] dev-preferences.md migration skipped for "${configDir}" (${(err as Error).message}) — restoring the legacy copy instead.`,
      );
      migrationRefused = true;
    }
    // #2875 defect fix (call site 1 was a loss site): migrateLegacyDevPreferencesToSkill's
    // boolean return conflates "migrated", "already satisfied" (skill file
    // already present — safe to discard either way), and "cannot migrate"
    // (no skills layout for this runtime, or the write itself failed —
    // discarding here would silently lose the user's file, the exact loss
    // this whole module exists to prevent). Distinguish via the resolved
    // target's actual presence rather than trusting the boolean alone; a
    // symlinked staged name (excluded from migration above) is treated the
    // same way — never migrated, so it must not be silently discarded.
    //
    // #2875 defect fix (migrationRefused must short-circuit this to `false`,
    // never fall through to the existsSync probe below): when
    // migrateLegacyDevPreferencesToSkill refused because skillTarget.skillFile
    // is a symlink, `existsSync` FOLLOWS it — a symlink pointing at some
    // OTHER real file (not dangling) would read back `true` here and mark
    // the batch "satisfied", discarding it without ever restoring it. Refusal
    // is never satisfaction.
    const skillTarget = migrationRefused ? null : _resolveDevPreferencesSkillTarget(configDir, runtime, scope);
    const migrationSatisfied = !migrationRefused && (migrated || (skillTarget !== null && installFs().existsSync(skillTarget.skillFile)));
    const nothingLeftUnmigrated = migrationSatisfied && migratableNames.length === stagedLegacyArtifacts.names.length;
    if (!nothingLeftUnmigrated && stagedLegacyArtifacts.names.length > 0) {
      // Put the whole batch back where it came from rather than losing
      // whatever migration did not (or could not) account for.
      installFs().mkdirSync(legacyCommandsGsd, { recursive: true });
      userArtifactStaging.restoreStagedUserArtifacts(legacyCommandsGsd, stagedLegacyArtifacts);
    }
    userArtifactStaging.discardStagedUserArtifacts(stagedLegacyArtifacts);
  }
}

/**
 * Run legacy uninstall cleanup that must execute BEFORE the layout-driven
 * removal so old-format entries are also cleaned up.
 *
 * @param runtime
 * @param configDir  resolved runtime config directory
 * @param scope
 * @returns staged legacy artifacts for post-removal migration, or null
 */
function _runLegacyUninstallCleanup(runtime: string, configDir: string, scope: string = 'global'): ReturnType<typeof userArtifactStaging.stageUserArtifacts> | null {
  // commands/gsd/ is a legacy location for Qwen, Hermes, and all Claude installs.
  // Prior to #1367 fix, Claude-local used commands/gsd/<cmd>.md (colon-namespaced).
  // After #1367, Claude-local uses flat commands/gsd-<cmd>.md. The inline uninstall
  // block (1c) handles removal of flat files; this function handles the legacy
  // commands/gsd/ directory for all Claude scopes (global was already included,
  // local is now added since that layout is also legacy post-#1367).
  // #2973 / Codex review (bd1f06c9): preserve user-owned dev-preferences.md
  // before destructive wipe. Migration to skills/gsd-dev-preferences/SKILL.md
  // is deferred and returned so the caller can apply it AFTER layout-driven
  // removal — this prevents the layout's gsd-* prefix removal from wiping the
  // freshly created skill dir (same pattern as _runLegacyInstallMigrations).
  // #2875 (#1874-F19): staged DURABLY to disk (userArtifactStaging), not just
  // an in-memory Map — this function's own wipe below is raw `fs`, left
  // unrouted by design (Phase 5 deliberately left the uninstall tree off the
  // installFs() seam; 40-design.md "Explicitly out of scope"), but the
  // staging call itself still routes through installFs() because the shared
  // module does (ambient default: real fs here, since this call is never
  // wrapped in withInstallFs).
  let stagedLegacyArtifacts: ReturnType<typeof userArtifactStaging.stageUserArtifacts> | null = null;
  // commands/gsd/ is a legacy location for Qwen, Hermes, and Claude global.
  // Claude local is intentionally excluded: the inline uninstall block (1c) handles
  // commands/gsd/ for claude local, preserving dev-preferences.md by restoring it
  // to the same location (#1423). Using migrateLegacyDevPreferencesToSkill here
  // (which would redirect to skills/) conflicts with the test contract for local installs.
  const _lu = _hostBehaviors(runtime).legacyCommandsGsdUninstall;
  // #2870: `scope` keeps its exported `string = 'global'` signature (no
  // signature change), but every real caller — `uninstallRuntimeArtifacts`'s
  // own required `scope` param, always fed a validated 'global' | 'local'
  // literal by bin/install.js's scope-resolution ternary, plus every direct
  // test call site — only ever supplies 'global' or 'local'. The existing
  // `= 'global'` default already reproduces today's behavior for an omitted
  // scope, so the cast below is safe: `isGlobalScope` never sees a value
  // outside its union here.
  const isLegacyCommandsGsd = _lu === true || (_lu === 'global' && isGlobalScope(scope as InstallScope));
  if (isLegacyCommandsGsd) {
    const legacyCommandsGsd = path.join(configDir, 'commands', 'gsd');
    if (fs.existsSync(legacyCommandsGsd)) {
      // #2875 defect fix: DEGRADE, never abort uninstall, when the staging
      // root cannot be resolved — skip this legacy-cleanup block (leave the
      // stale dir in place) rather than wipe without a durable backup.
      // Uninstall in particular must always be able to proceed past this
      // point regardless of a hostile/broken `.gsd-staging` path.
      const stagingRoot = _tryResolveUserArtifactStagingRoot(configDir);
      if (stagingRoot !== null) {
        stagedLegacyArtifacts = userArtifactStaging.stageUserArtifacts(legacyCommandsGsd, ['dev-preferences.md'], stagingRoot);
        fs.rmSync(legacyCommandsGsd, { recursive: true });
      }
    }
  }

  // Hermes: pre-#2841 flat skills/gsd-*/ entries
  if (runtime === 'hermes') {
    const flatSkillsDir = path.join(configDir, 'skills');
    if (fs.existsSync(flatSkillsDir)) {
      for (const entry of fs.readdirSync(flatSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
          fs.rmSync(path.join(flatSkillsDir, entry.name), { recursive: true });
        }
      }
    }

    // Hermes: pre-#947 bare-stem skills/gsd/<stem>/ entries (dirs that do NOT
    // start with 'gsd-') — the #3664 layout used prefix='' so GSD-owned skills
    // had bare names (e.g. skills/gsd/help/). These are stale on uninstall.
    const nestedGsdDirForUninstall = path.join(configDir, 'skills', 'gsd');
    if (fs.existsSync(nestedGsdDirForUninstall)) {
      for (const entry of fs.readdirSync(nestedGsdDirForUninstall, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('gsd-')) {
          fs.rmSync(path.join(nestedGsdDirForUninstall, entry.name), { recursive: true });
        }
      }
    }
  }

  // Return staged artifacts so the caller can migrate after layout-driven removal.
  return stagedLegacyArtifacts;
}

// ---------------------------------------------------------------------------
// installRuntimeArtifacts
// ---------------------------------------------------------------------------

/**
 * Layout-driven install orchestrator.
 * Runs legacy migrations first, then uses resolveRuntimeArtifactLayout to
 * determine what artifact kinds to write and where.
 *
 * @param runtime             canonical runtime ID
 * @param configDir           resolved runtime config directory
 * @param scope
 * @param resolvedProfile     from resolveProfile() / resolveEffectiveProfile()
 * @param resolveAttribution  injection: (runtime) => attribution string | undefined
 * @param capabilityRegistry  #2322: optional composed capability registry
 *   (capabilityClusters view) — threaded into resolveRuntimeArtifactLayout so
 *   the skills kind can materialize installed third-party capability skills
 *   bound to their declaring capId. Absent -> no third-party skills staged
 *   (fail closed), matching the layout resolver's own optional-registry contract.
 * @param deps  #2874 (ADR-58 cleanup phase): optional injection bag, additive
 *   over the 6-positional-arg call shape every existing caller (bin/install.js,
 *   G1/G3 test doubles) already uses — an omitted/`{}` `deps` is byte-identical
 *   to before (AC4). `deps.fs` — a PARTIAL InstallFsAdapter
 *   (install-fs-adapter.cts) — is merged over the real fs adapter for the
 *   duration of this call (and everything it calls: layout source-root
 *   resolution, profile staging, content-rewrite passes) via `withInstallFs`.
 * @returns an executed-plan value describing what this call wrote, never
 *   `undefined` (40-design.md: "Legitimate undefined returns: none after this
 *   phase"). Throws, rather than returning an `ok:false` shape, on stage/
 *   rewrite failure — the return type describes what executed; failure stays
 *   an exception (design doc "Rejected" #3 / AC4).
 */
function installRuntimeArtifacts(
  runtime: string,
  configDir: string,
  scope: string,
  resolvedProfile: any,
  resolveAttribution: ResolveAttribution = () => undefined,
  capabilityRegistry?: any,
  deps: { fs?: any; os?: any; env?: Record<string, string | undefined>; packageRoot?: string } = {},
): any {
  return withInstallFs(deps.fs, (): any => {
    const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout(
      runtime,
      configDir,
      scope as 'global' | 'local',
      capabilityRegistry,
    );
    // A removed descriptor kind is no longer visited by the layout loop, so it
    // cannot prune its own previous output. Clean manifest-proven retired files
    // before materializing the current layout (#2644).
    retiredArtifactCleanup.pruneRetiredRuntimeArtifacts(runtime, configDir);

    // Combined-family runtimes (OpenCode/Kilo, ADR-1239 / #2087): route through
    // the dedicated combined commands+skills+plugin orchestrator instead of the
    // generic layout-driven loop below, mirroring the bespoke install path that
    // previously lived inline in bin/install.js.
    const behaviors = _hostBehaviors(runtime);
    const projectDir = scope === 'global' ? process.cwd() : configDir;
    if (behaviors.combinedFamilyInstall) {
      // #2329: combined-family runtimes (OpenCode/Kilo) bypass
      // _runLegacyInstallMigrations below entirely (early return), so their
      // legacy-directory cleanup needs its own pre-materialization hook here.
      _migrateLegacyOpencodeCommandDir(runtime, configDir, behaviors);
      // #2874 design row 2: this early return must ALSO return an executed
      // plan — installOpencodeFamilyArtifacts reports what it wrote, so a
      // whole runtime family returning undefined is no longer a hole.
      // An injected filesystem supplies its own hermetic corpus fixture. The
      // real installer is the authority that refreshes package bytes into the
      // durable installed corpus; attempting that cross-filesystem copy through
      // an in-memory destination adapter would read from the wrong filesystem.
      if (!deps.fs) provisionRuntimeSurfaceCorpus(layout, configDir, scope);
      return installOpencodeFamilyArtifacts(
        runtime,
        configDir,
        scope,
        resolvedProfile,
        resolveAttribution,
        behaviors,
        capabilityRegistry,
        deps.packageRoot,
        projectDir,
      );
    }

    // Legacy cleanup before layout-driven writes
    _runLegacyInstallMigrations(runtime, configDir, scope);

    if (!deps.fs) provisionRuntimeSurfaceCorpus(layout, configDir, scope);
    // #3712: a global `home` override escapes the sandboxed configDir. Refuse to
    // execute when a test run would land that escape in the developer's real home.
    testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', runtime, layout?.kinds, {
      os: deps.os, env: deps.env,
    });
    const createPlan = () => runtimeArtifactInstallPlan.createRuntimeArtifactInstallPlan({
      // `Layout` is structurally identical across the layout/install-plan .cjs
      // modules but nominally distinct to tsc (untyped .cjs boundary) — bridge it.
      layout: layout as any,
      resolvedProfile,
      homedir: () => os.homedir(),
      platform: process.platform,
      resolveAttribution,
      projectDir,
    });
    let planResult = createPlan();
    if (
      scope === 'global' &&
      !planResult.ok &&
      planResult.kind === 'stage_failed' &&
      planResult.cleanupDirs.length === 0 &&
      isRuntimeSurfaceSourceUnavailable(planResult.message)
    ) {
      planResult = withInstallerPackageSource(configDir, createPlan);
    }

    const cleanupDirs = planResult.ok ? planResult.plan.cleanupDirs : planResult.cleanupDirs;
    // #2874 row 1/4/5: per-kind executed-plan entries, appended only as the
    // loop below actually finishes writing each kind — a kind that throws
    // mid-copy is never reported as executed.
    const executedKinds: any[] = [];
    // #2874 rows 10/11: { dir, ok } per cleanupDirs entry — built in the
    // `finally` below regardless of whether the try block throws, so a
    // caught failure that still throws (row 3) leaves this populated even
    // though it is never returned on that path.
    const cleanupResults: { dir: string; ok: boolean }[] = [];
    try {
      if (!planResult.ok) {
        throw new Error(planResult.message);
      }

      const kindsByName = new Map<string, any>(layout.kinds.map((kind: any) => [kind.kind as string, kind]));
      for (const item of planResult.plan.items) {
        const kind: any = kindsByName.get(item.kind);
        if (!kind) throw new Error(`Install plan returned unknown artifact kind: ${item.kind}`);
        const dest = item.destDir;
        // Symlink-escape guard: reject before mkdir if dest (or any component
        // between the install root and dest) is a symlink pointing outside that
        // root. mkdirSync follows symlinks, so this must run BEFORE the mkdir
        // call. The install root is normally configDir, but a kind may declare
        // an alternate `home` (ADR-1239 upgrade 3 / #2088, e.g. Codex skills ->
        // $HOME/.agents) — in that case the guard must check against the
        // resolved alternate root instead, matching assertDestWithinConfigHome's
        // own root selection in createRuntimeArtifactInstallPlan.
        //
        // #2874: this REFUSAL DECISION stays outside the injected fs adapter —
        // only hasExistingSymlinkBetween's own existsSync/lstatSync/realpathSync
        // PROBES are routed through it (install-fs-adapter.cts's module doc).
        // A fake adapter can change what those probes observe for paths that
        // were never real to begin with; it cannot make this `if` pass for a
        // path the real filesystem would refuse.
        const installRoot = (kind && typeof kind.home === 'string' && kind.home !== '') ? kind.home : configDir;
        // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
        // Threat model from #1704 / ADR-1239 Phase B preserved: path-traversal and
        // resolved-target-equals-root still refuse regardless of opt-in.
        if (hasExistingSymlinkBetween(path.resolve(installRoot), dest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
          throw new Error(
            `installRuntimeArtifacts: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust — refusing to create. If this is an intentional user-owned symlink layout (e.g. externalized skills/hooks dir, multi-account configHome, or a dotfiles-managed configHome), re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
          );
        }
        // #2875 defect fix (--minimal regression closed): a restricted profile
        // (e.g. --minimal) can legitimately stage ZERO agents — no skill in
        // the profile's closure references a gsd-* role. The pre-#2875-Part-2
        // inline agent-staging loop this generic layout loop's agents handling
        // replaced never created `agents/` at all under a minimal install (the
        // now-deleted `isMinimalMode` branch skipped the whole step); this
        // loop's own unconditional `mkdirSync` above regressed that — every
        // profile, restricted or not, now gets an `agents/` dir materialized
        // even when nothing will ever be written into it, breaking
        // `.changeset/zesty-rams-march.md`'s "installed output is
        // byte-identical to before for every runtime" claim. Restore the old
        // behavior exactly for the `agents` kind specifically (skills/commands
        // are unaffected — they are never legitimately empty): skip creating
        // `dest` (and pruning/copying into it) entirely when this kind's
        // already-staged `item.sourceDir` (built by createRuntimeArtifactInstallPlan
        // BEFORE this loop) has nothing in it.
        if (kind.kind === 'agents') {
          const stagedAgentFiles = installFs().existsSync(item.sourceDir)
            ? installFs().readdirSync(item.sourceDir).filter((f: string) => f.endsWith('.md'))
            : [];
          // #2875 defect fix, corrected: the ORIGINAL fix (see the comment
          // above `installAgentsKindStandalone`) skipped this kind's stale-
          // agent prune along with the write whenever a restricted profile
          // (e.g. --minimal) staged zero agents — that also skipped
          // `_removeGsdEntries`, so a full -> minimal downgrade left every
          // previously-installed gsd-*.md/.toml agent file in place. The
          // deleted pre-#2875 inline loop never did that: its stale-cleanup
          // pre-pass ran UNCONDITIONALLY, and only the *write* of new agent
          // files was gated on minimal mode. Restore that split here: prune
          // first (no-ops via `_removeGsdEntries`'s own existsSync check when
          // `dest` was never created, so a fresh install with nothing staged
          // still never creates it below), then skip mkdir/copy when there is
          // nothing to write.
          _removeGsdEntries(dest, kind);
          if (stagedAgentFiles.length === 0) {
            continue;
          }
        }
        installFs().mkdirSync(dest, { recursive: true });
        const preserved: string[] = [];
        if (kind.kind === 'skills' && installFs().existsSync(dest)) {
          // Pre-prune: snapshot user-owned content before _removeGsdEntries wipes it,
          // then restore after. This preserves user dirs across a wipe-and-replace
          // install (#2973 / #3664).
          //
          // All runtimes (incl. Hermes after #947) use prefix='gsd-'.
          // _removeGsdEntries removes only gsd-* entries; non-gsd-* user dirs are
          // untouched. Preserve the explicit user-owned GSD-prefixed skill
          // gsd-dev-preferences, which GSD does not reinstall from source but must
          // survive the prune (#2973).
          const toPreserve = new Map<string, Map<string, Buffer>>(); // dirName -> Map<relPath, Buffer>

          {
            // Preserve explicitly user-owned GSD-prefixed skill dirs.
            // gsd-dev-preferences is the sole user-customisable skill in this category.
            const USER_OWNED_SKILL_DIRS = ['gsd-dev-preferences'];
            for (const dirName of USER_OWNED_SKILL_DIRS) {
              const skillDir = path.join(dest, dirName);
              if (!installFs().existsSync(skillDir)) continue;
              const snap = _snapshotDir(skillDir);
              if (snap.size > 0) toPreserve.set(dirName, snap);
            }
          }

          _removeGsdEntries(dest, kind);
          _copyStaged(item.sourceDir, dest, kind, configDir, runtime);

          // Restore user-owned dirs after the prune+copy
          for (const [dirName, snap] of toPreserve) {
            _restoreDir(path.join(dest, dirName), snap);
            preserved.push(dirName);
          }
        } else {
          // For non-skills kinds (commands, agents): no user content to preserve;
          // just prune stale gsd-* entries and copy new ones.
          _removeGsdEntries(dest, kind);
          _copyStaged(item.sourceDir, dest, kind, configDir, runtime);
        }
        executedKinds.push({ kind: item.kind, sourceDir: item.sourceDir, destDir: dest, preserved });
      }
    } finally {
      // #2874 rows 10/11: cleanup stays best-effort (an install must never
      // fail on cleanup) but a failed rmSync is now VISIBLE in `cleanup`
      // rather than silently swallowed — silently absent is worse than the
      // `void` return this replaces (40-design.md negative-space section).
      for (const dir of cleanupDirs) {
        try {
          installFs().rmSync(dir, { recursive: true, force: true });
          cleanupResults.push({ dir, ok: true });
        } catch {
          cleanupResults.push({ dir, ok: false });
        }
      }
    }

    // Hermes: after the install loop has written all gsd-<stem>/ dirs to
    // skills/gsd/, remove any stale bare-stem dirs (skills/gsd/<stem>/) that
    // correspond to the newly installed gsd-<stem> entries. This is the robust
    // replacement for the readGsdCommandNames()-based pre-install cleanup that
    // missed skills like 'dev-preferences' (#947 adversarial review).
    //
    // We run this AFTER the install loop so the installed set is authoritative:
    // every gsd-<stem>/ present now was written this run (or was there before
    // with the same prefix). User-owned bare dirs with no gsd-<stem> counterpart
    // are untouched.
    let hermesBareStemCleanup = false;
    if (runtime === 'hermes') {
      const nestedGsdDirForCleanup = path.join(configDir, 'skills', 'gsd');
      _removeHermesBareStemDirs(nestedGsdDirForCleanup);
      hermesBareStemCleanup = true;
    }

    // Generic-branch nativePlugin staging (ADR-1239 / #2102 Stage 1): runtimes
    // outside the OpenCode/Kilo combined-family install (e.g. pi, whose
    // artifactLayout is empty and which never sets combinedFamilyInstall) still
    // need their declared hostBehaviors.nativePlugin file copied into configDir.
    // findInstallSourceRoot resolves the repo/package root independent of
    // configDir contents (marker check, then a walk-up from __dirname), so this
    // is safe even when configDir has no .gsd-source marker (artifactLayout: []).
    let nativePluginInstalled = false;
    if (behaviors.nativePlugin) {
      // Native plugin sources live only in the executing package, never in the
      // durable Runtime Surface corpus. Do not derive this package root from a
      // config-scoped provider that may now correctly resolve installed input.
      const src = deps.packageRoot ?? executingPackageRoot();
      _installNativePluginIfDeclared(runtime, configDir, behaviors, src);
      nativePluginInstalled = true;
    }

    // #2874 row 14: an empty `layout.kinds` still returns `kinds: []` here
    // (executedKinds was never mutated), never `undefined`.
    return {
      runtime,
      scope,
      kinds: executedKinds,
      cleanup: cleanupResults,
      postSteps: { hermesBareStemCleanup, nativePlugin: nativePluginInstalled },
    };
  });
}

// ---------------------------------------------------------------------------
// installOpencodeFamilySkills
// ---------------------------------------------------------------------------

/**
 * Install the skills layout kind for an OpenCode-family runtime (OpenCode/Kilo).
 *
 * These runtimes do NOT go through installRuntimeArtifacts (their commands use a
 * bespoke flattened-command writer), so this writes ONLY the skills kind
 * alongside their existing command/ + agents/ surfaces. Uninstall is already
 * layout-driven (uninstallRuntimeArtifacts iterates layout.kinds), so the
 * skills/ dir is cleaned up automatically once the layout declares it.
 *
 * @param runtime - 'opencode' or 'kilo'
 * @param targetDir - resolved runtime config directory
 * @param rawCommandsDir - staged RAW Claude command dir (caller's _stageSkills output)
 * @param pathPrefix - computed config-path prefix for body rewrites
 * @param resolveAttribution - injection: (runtime) => attribution string | undefined
 * @param resolvedProfile - #2362: from resolveProfile()/resolveEffectiveProfile(); only
 *   `.skills` is consulted (either the `'*'` full-profile sentinel or a concrete Set
 *   of stems), and only to gate which THIRD-PARTY capability stems are candidates for
 *   staging below. Absent -> no third-party skills staged (fail closed).
 * @param capabilityRegistry - #2362: optional composed capability registry
 *   (capabilityClusters view). When present, installed third-party capability
 *   skills bound to their declaring capId are unioned into the staged output —
 *   the actual #2322 seam (install-profiles.cts stageSkillsForRuntimeAsSkills)
 *   this bespoke OpenCode/Kilo writer never called. Absent -> no third-party
 *   skills staged (fail closed), matching the seam's own optional-registry
 *   contract.
 * @returns number of gsd-* skill directories written
 */
function installOpencodeFamilySkills(
  runtime: string,
  targetDir: string,
  rawCommandsDir: string,
  pathPrefix: string,
  resolveAttribution: ResolveAttribution = () => undefined,
  resolvedProfile?: any,
  capabilityRegistry?: any,
): number {
  const layout: any = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, targetDir);
  const skillsKindEntry = layout.kinds.find((k: any) => k.kind === 'skills');
  if (!skillsKindEntry) return 0;
  // #3712: combined-family runtimes take installRuntimeArtifacts' early return
  // BEFORE its guard runs, and this writer honors `skillsKindEntry.home` below and
  // then prunes that destination. opencode/kilo declare no `home` today, so there
  // is no live escape — but that makes this a bypass waiting on a descriptor
  // change rather than a safe omission, so it is guarded at the writer instead.
  // Scoped to the SKILLS kind alone, for the same reason as the agents writer.
  testHomeGuard.assertTestHomeSandboxed('installOpencodeFamilySkills', runtime, [skillsKindEntry]);
  const rawDir = rawCommandsDir;
  if (!rawDir || !installFs().existsSync(rawDir)) return 0;

  // #2093: descriptor-driven — dispatch off the skills-kind entry's `converter`
  // string (capabilities/<runtime>/capability.json artifactLayout) via the
  // SKILLS_CONVERTER_REGISTRY, instead of a `frontmatterDialect === 'kilo'`
  // runtime check. Fail loud if the descriptor names an unregistered converter
  // (mirrors the converter=null throw in runtime-artifact-layout.cts).
  const converterName: string | undefined = skillsKindEntry.converter;
  const converter = converterName ? SKILLS_CONVERTER_REGISTRY[converterName] : undefined;
  if (!converter) {
    throw new TypeError(
      `installOpencodeFamilySkills: unknown skills converter '${String(converterName)}' for runtime '${runtime}'`,
    );
  }

  // #2911: same destination-root defect as _copyStaged/migrateLegacyDevPreferencesToSkill
  // — honor skillsKindEntry.home as a FALLBACK-preferred override (e.g. Codex skills
  // -> $HOME/.agents) instead of always resolving against targetDir, so this bespoke
  // OpenCode/Kilo writer lands in the SAME tree the installer and surface-apply use.
  // Runtimes with no `home` override (opencode, kilo today) are unaffected. Must stay
  // in lockstep with the sibling writers — the destination-parity test enforces it.
  const installRoot: string = skillsKindEntry.home ?? targetDir;
  const dest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(installRoot, skillsKindEntry.destSubpath);
  // Symlink-escape guard: reject if any path component between installRoot and
  // dest is a symlink that would redirect writes outside the install root.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(path.resolve(installRoot), dest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `installOpencodeFamilySkills: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  installFs().mkdirSync(dest, { recursive: true });

  // Preserve user-owned GSD-prefixed skill dirs across the gsd-* prune.
  // gsd-dev-preferences is generated by the user (via generate-dev-preferences)
  // and lives at <configDir>/skills/gsd-dev-preferences — _removeGsdEntries
  // would otherwise wipe it. Mirrors the preservation in installRuntimeArtifacts
  // (#2973).
  const USER_OWNED_SKILL_DIRS = ['gsd-dev-preferences'];
  const toPreserve = new Map<string, Map<string, Buffer>>(); // dirName -> Map<relPath, Buffer>
  for (const dirName of USER_OWNED_SKILL_DIRS) {
    const skillDir = path.join(dest, dirName);
    if (!installFs().existsSync(skillDir)) continue;
    const snap = _snapshotDir(skillDir);
    if (snap.size > 0) toPreserve.set(dirName, snap);
  }

  _removeGsdEntries(dest, skillsKindEntry);

  let count = 0;
  const firstPartyStems = new Set<string>();
  for (const entry of installFs().readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    firstPartyStems.add(stem);
    const skillName = `${skillsKindEntry.prefix}${stem}`;
    let content = installFs().readFileSync(path.join(rawDir, entry.name), 'utf8');
    content = applyOpencodeFamilyPathPrefix(content, runtime, pathPrefix);
    content = processAttribution(content, resolveAttribution(runtime));
    content = converter(content, skillName);
    const skillDir = path.join(dest, skillName);
    installFs().mkdirSync(skillDir, { recursive: true });
    installFs().writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    count++;
  }

  // #2362: materialize installed THIRD-PARTY capability skills, bound to their
  // DECLARING capability via the registry's capabilityClusters view — mirrors
  // install-profiles.cts stageSkillsForRuntimeAsSkills's third-party fill-in
  // (the actual #2322 seam), reusing its exported security-reviewed helpers
  // rather than hand-rolling a second scan (DEFECT.GENERATIVE-FIX guard).
  // First-party always wins on stem collision. The full/'*' sentinel resolves
  // through capabilityClusterStems (BLOCKER-2 parity: `resolveProfile`
  // short-circuits `full` to `'*'` before consulting a registry, so a bare
  // `resolvedProfile.skills !== '*'` gate would silently skip this pass for
  // the default full install). No registry in scope -> stage NOTHING
  // third-party (fail closed — never fall back to scanning).
  //
  // Unlike the seam (which stages third-party bodies as-is and relies on a
  // later applySurface rewrite pass), this install path has no such later
  // pass — so third-party bodies get the SAME inline path-prefix/attribution
  // rewrite as first-party ones for on-disk parity. They do NOT go through
  // `converter`: an installed capability skill is already a complete
  // SKILL.md, not a Claude-command body awaiting frontmatter conversion.
  if (capabilityRegistry) {
    const candidateStems: Iterable<string> =
      resolvedProfile && resolvedProfile.skills === '*'
        ? installProfiles.capabilityClusterStems(capabilityRegistry)
        : (resolvedProfile && resolvedProfile.skills) || [];
    for (const stem of candidateStems) {
      if (firstPartyStems.has(stem)) continue; // first-party always wins
      const found = installProfiles.readInstalledCapabilitySkill(stem, capabilityRegistry);
      if (found === null) continue; // absent/malformed/unowned -> skip gracefully
      const skillName = `${skillsKindEntry.prefix}${stem}`;
      if (!isPathConfined(skillName, dest)) continue; // defense-in-depth
      let content = found.content;
      content = applyOpencodeFamilyPathPrefix(content, runtime, pathPrefix);
      content = processAttribution(content, resolveAttribution(runtime));
      const skillDir = path.join(dest, skillName);
      installFs().mkdirSync(skillDir, { recursive: true });
      installFs().writeFileSync(path.join(skillDir, 'SKILL.md'), content);
      // #2322 HIGH-3 parity: persist the capability-owned marker so a later
      // prune pass can identify this directory even once the owning
      // capability is uninstalled/unsurfaced and no longer appears in any
      // registry view.
      installFs().writeFileSync(path.join(skillDir, installProfiles.CAPABILITY_SKILL_MARKER), found.capId + '\n', 'utf8');
      count++;
    }
  }

  // Restore user-owned dirs after the prune+copy.
  for (const [dirName, snap] of toPreserve) {
    _restoreDir(path.join(dest, dirName), snap);
  }

  return count;
}

// ---------------------------------------------------------------------------
// installAgentsKindStandalone
// ---------------------------------------------------------------------------

/**
 * Install the descriptor-driven `agents` kind for a runtime OUTSIDE the
 * generic `installRuntimeArtifacts` layout loop — i.e. any runtime/scope
 * combination that never reaches that loop's own `layout.kinds` iteration.
 * Two such call sites exist (#2875 Part 2):
 *
 * 1. **OpenCode-family runtimes** (OpenCode/Kilo, Task A) — `hostBehaviors.
 *    combinedFamilyInstall` makes `installRuntimeArtifacts` early-return into
 *    `installOpencodeFamilyArtifacts` instead, which stages commands+skills
 *    via its OWN bespoke writers and never called `resolveRuntimeArtifactLayout`
 *    for agents at all before this function existed. Declaring a
 *    `capability.json` `agents` entry for them without this would be inert
 *    on the real install path while live on `/gsd:surface` (#1879-F15).
 * 2. **Claude local** (`bin/install.js`'s `install()`, `_isSkillsRuntime ===
 *    false` branch) — `hostBehaviors.localInstallStyle === 'legacy-flat'`
 *    routes claude-local's commands/skills through `copyWithPathReplacement`
 *    instead of the layout loop, so it never reached `installRuntimeArtifacts`
 *    either. Its agents were previously written ONLY by the now-deleted
 *    inline agent-staging loop (Task C) — deleting that loop without this
 *    call site regressed claude-local's agents/ to empty (caught by the
 *    install-tree golden fixture, `tests/fixtures/install-tree/claude-local.json`).
 *
 * Reuses the SAME descriptor path every runtime inside the generic loop uses
 * (`layout.kinds` → `agentsKindEntry.stage(resolvedProfile, agentCtx)` →
 * `_copyStaged`), rather than forking a second agent-staging pipeline. A
 * runtime/scope whose resolved layout declares no `agents` kind at all
 * (e.g. pi, whose `artifactLayout` is empty for both scopes) is a no-op
 * (`null`) — mirrors `installOpencodeFamilySkills`'s own
 * `if (!skillsKindEntry) return 0` contract.
 *
 * @param runtime - canonical runtime id
 * @param targetDir - resolved runtime config directory
 * @param scope - install scope ('global' | 'local')
 * @param resolvedProfile - from resolveProfile() / resolveEffectiveProfile()
 * @param pathPrefix - computed config-path prefix for body rewrites (ADR-1235 §1 agentCtx)
 * @param resolveAttribution - injection: (runtime) => attribution string | undefined
 * @param capabilityRegistry - #2362: optional composed capability registry, threaded
 *   straight through to resolveRuntimeArtifactLayout (unused by the agents kind today,
 *   but kept for signature parity with the skills/commands siblings on this call tree)
 * @param projectDir - project/config discovery root, distinct from the artifact destination
 * @returns `{ sourceDir, destDir }` describing what was written, or `null` when the
 *   runtime's layout declares no `agents` kind.
 */
function installAgentsKindStandalone(
  runtime: string,
  targetDir: string,
  scope: string,
  resolvedProfile: any,
  pathPrefix: string,
  resolveAttribution: ResolveAttribution = () => undefined,
  capabilityRegistry?: any,
  projectDir?: string | null,
): { sourceDir: string; destDir: string } | null {
  const layout: Pick<
    ReturnType<typeof runtimeArtifactLayout.resolveRuntimeArtifactLayout>,
    'runtime' | 'kinds'
  > = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, targetDir, scope as 'global' | 'local', capabilityRegistry);
  const agentsKindEntry = layout.kinds.find((kind) => kind.kind === 'agents');
  if (!agentsKindEntry) return null;
  // #3712: this writer selects `agentsKindEntry.home` over targetDir below and then
  // prunes that destination via _removeGsdEntries, so it is a fifth route into the
  // developer's real home. No agents kind declares a `home` override today, so like
  // installOpencodeFamilySkills it is guarded against a descriptor change rather
  // than a present escape. Scoped to the AGENTS kind alone: passing the whole
  // layout made codex's unrelated skills-kind override trip a writer that never
  // touches it, which is a false refusal, not a tighter guard.
  testHomeGuard.assertTestHomeSandboxed('installAgentsKindStandalone', runtime, [agentsKindEntry]);

  // ADR-1235 §1: same agentCtx shape createRuntimeArtifactInstallPlan builds
  // for the generic layout-driven loop (runtime-artifact-install-plan.cts) —
  // targetDir IS the install root the inline agent loop called `targetDir`.
  const attribution = resolveAttribution ? resolveAttribution(runtime) : undefined;
  const agentCtx = { runtime, pathPrefix, attribution, targetDir, projectDir: projectDir ?? targetDir };
  let stagedDir: string;
  try {
    stagedDir = agentsKindEntry.stage(resolvedProfile, agentCtx);
  } catch (err) {
    if (scope !== 'global' || !isRuntimeSurfaceSourceUnavailable((err as Error).message)) throw err;
    stagedDir = withInstallerPackageSource(targetDir, () => agentsKindEntry.stage(resolvedProfile, agentCtx));
  }

  const stagedAgentFiles: string[] = installFs().existsSync(stagedDir)
    ? installFs().readdirSync(stagedDir).filter((f: string) => f.endsWith('.md'))
    : [];

  const installRoot: string = (typeof agentsKindEntry.home === 'string' && agentsKindEntry.home !== '') ? agentsKindEntry.home : targetDir;
  const dest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(installRoot, agentsKindEntry.destSubpath);
  // Symlink-escape guard — same gate _copyStaged/installOpencodeFamilySkills apply
  // to their own writes (#2393 GSD_ALLOW_SYMLINKED_DEST opt-in preserved). Runs
  // even when nothing will be written this call — the stale-agent prune below
  // (`_removeGsdEntries`) still touches `dest` whenever it already exists.
  if (hasExistingSymlinkBetween(path.resolve(installRoot), dest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `installAgentsKindStandalone: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }

  // #2875 defect fix, corrected: the ORIGINAL fix returned `null` (no-op)
  // whenever a restricted profile (e.g. --minimal) staged ZERO agents,
  // which — because that early return sat ABOVE the prune call — also
  // skipped `_removeGsdEntries`, leaving every previously-installed
  // gsd-*.md/.toml agent file in place on a full -> minimal downgrade. The
  // deleted pre-#2875 inline loop never did that: its stale-cleanup pre-pass
  // ran UNCONDITIONALLY (removing gsd-*.md, plus .toml for codex), and only
  // the *write* of new agent files was gated on minimal mode. Restore that
  // split: prune first — a no-op via `_removeGsdEntries`'s own existsSync
  // check when `dest` was never created, so a fresh install with nothing
  // staged still never creates it below — then skip mkdir/copy (and return
  // `null`, matching the doc comment above) when there is nothing to write.
  _removeGsdEntries(dest, agentsKindEntry);
  if (stagedAgentFiles.length === 0) return null;

  installFs().mkdirSync(dest, { recursive: true });
  _copyStaged(stagedDir, dest, agentsKindEntry, targetDir, runtime);

  return { sourceDir: stagedDir, destDir: dest };
}

// ---------------------------------------------------------------------------
// installOpencodeFamilyCommands
// ---------------------------------------------------------------------------

/**
 * Install the flattened commands surface for an OpenCode-family runtime
 * (OpenCode/Kilo): commands/gsd/**\/*.md -> command/gsd-<...>.md, with
 * per-runtime frontmatter conversion and path-prefix/attribution rewrites.
 *
 * Mirrors bin/install.js's copyFlattenedCommands VERBATIM (ADR-1239 /
 * #2087), except attribution is resolved via the injected
 * `resolveAttribution` callback instead of a module-level getCommitAttribution.
 *
 * @param runtime - 'opencode' or 'kilo'
 * @param destDir - destination directory for flattened commands (recurses with the same destDir)
 * @param srcDir - source directory to walk (commands/gsd/, recursing into subdirectories)
 * @param pathPrefix - computed config-path prefix for body rewrites
 * @param resolveAttribution - injection: (runtime) => attribution string | undefined
 * @param prefix - filename prefix accumulator (defaults to 'gsd'; grows on recursion)
 */
function installOpencodeFamilyCommands(
  runtime: string,
  destDir: string,
  srcDir: string,
  pathPrefix: string,
  resolveAttribution: ResolveAttribution = () => undefined,
  prefix: string = 'gsd',
): void {
  if (!installFs().existsSync(srcDir)) return;

  // Remove old gsd-*.md files before copying new ones
  if (installFs().existsSync(destDir)) {
    for (const file of installFs().readdirSync(destDir)) {
      if (file.startsWith(`${prefix}-`) && file.endsWith('.md')) installFs().unlinkSync(path.join(destDir, file));
    }
  } else {
    installFs().mkdirSync(destDir, { recursive: true });
  }

  for (const entry of installFs().readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      installOpencodeFamilyCommands(runtime, destDir, srcPath, pathPrefix, resolveAttribution, `${prefix}-${entry.name}`);
    } else if (entry.name.endsWith('.md')) {
      const baseName = entry.name.replace('.md', '');
      const destName = `${prefix}-${baseName}.md`;
      let content = installFs().readFileSync(srcPath, 'utf8');
      content = applyOpencodeFamilyPathPrefix(content, runtime, pathPrefix);
      content = processAttribution(content, resolveAttribution(runtime));
      // #2093: this commands-kind entry's descriptor `converter` field is
      // intentionally `null` (see capabilities/{kilo,opencode}/capability.json —
      // the flattened-command writer above applies its own path/attribution
      // rewrites and has no per-file converter slot to key on), so there is no
      // descriptor string to dispatch through here. `frontmatterDialect` is the
      // documented, intentional dispatch key for frontmatter-shape selection —
      // it is itself descriptor-driven (not a `runtime === 'kilo'` check), so it
      // already satisfies the fold-to-descriptor requirement. Only the SKILLS
      // converter site above (installOpencodeFamilySkills) has a real
      // `converter` string to key on via SKILLS_CONVERTER_REGISTRY.
      content = _hostBehaviors(runtime).frontmatterDialect === 'kilo'
        ? (runtimeArtifactConversion as any).convertClaudeToKiloFrontmatter(content)
        : (runtimeArtifactConversion as any).convertClaudeToOpencodeFrontmatter(content);
      installFs().writeFileSync(path.join(destDir, destName), content);
    }
  }
}

// ---------------------------------------------------------------------------
// _installNativePluginIfDeclared
// ---------------------------------------------------------------------------

/**
 * Copy a runtime's declared native-extension/plugin file (hostBehaviors.nativePlugin)
 * into its resolved config dir, when the runtime descriptor declares one.
 *
 * Extracted (ADR-1239 / #2102 Stage 1) from the body previously inlined in
 * installOpencodeFamilyArtifacts so a runtime that is NOT part of the
 * OpenCode/Kilo combined-family install (e.g. pi, whose artifactLayout is
 * empty and which never sets combinedFamilyInstall) can still get its
 * nativePlugin file staged via the generic installRuntimeArtifacts branch.
 * Behavior for opencode/kilo is unchanged — same source resolution, same
 * mkdir + copyFileSync call, same silent no-op when the source is missing.
 *
 * @param runtime  - canonical runtime id (only used for the assertDestWithinConfigHome guard)
 * @param configDir - resolved runtime config directory
 * @param behaviors - the runtime's hostBehaviors descriptor
 * @param src       - repo/package root (two levels up from the commands/gsd source dir)
 */
function _installNativePluginIfDeclared(
  runtime: string,
  configDir: string,
  behaviors: any,
  src: string,
): void {
  const np = behaviors.nativePlugin;
  if (np && np.source) {
    const pluginSrc = path.join(src, np.source);
    if (installFs().existsSync(pluginSrc)) {
      // Confine the FULL dest path (dir + file), not just the dir. Previously
      // only `np.dir` was validated and `np.file` was joined on unchecked, so a
      // descriptor whose `file` carried `..`, an absolute path, or a NUL byte
      // would have written outside configHome. Not reachable today — descriptors
      // are first-party and compiled into the capability registry at build time —
      // but `np.file` is exactly the field #2470 changes, and the guard costs
      // nothing. For a well-formed descriptor this resolves identically to the
      // previous mkdir(dir) + join(dir, file).
      const destPath = runtimeArtifactInstallPlan.assertDestWithinConfigHome(
        configDir,
        path.join(np.dir, np.file),
      );
      installFs().mkdirSync(path.dirname(destPath), { recursive: true });
      installFs().copyFileSync(pluginSrc, destPath);
      // #2544: the staged adapter is a `.js` file, so Node decides its module
      // type by walking up for the nearest package.json. It used to find the
      // marker the installer wrote at the config root — the write that
      // clobbered user-authored files. Pin it from the plugin's own directory
      // instead, leaving the config root alone. The marker cannot disturb
      // plugin discovery: OpenCode auto-discovers `plugins/*.{ts,js}` and pi's
      // isExtensionFile() accepts only `.ts`/`.js` (see installer-migration
      // 006), so a package.json here is never treated as a plugin. Never
      // written over a package.json GSD does not own — but when one is already
      // there, say so: the adapter is CommonJS and will not load under a
      // foreign `"type": "module"`, and a silent no-op would leave every guard
      // the adapter spawns dead with no diagnostic (the #2305 failure shape).
      const markerOutcome = ensureCommonJsMarker(path.dirname(destPath));
      if (markerOutcome === 'preserved-foreign') {
        console.warn(
          `  ⚠  ${np.dir}/package.json is not GSD's CommonJS marker — left untouched. `
          + `If it declares "type": "module", ${np.file} will not load.`,
        );
      } else if (markerOutcome === 'failed') {
        // Best-effort, never fatal: an unwritable plugin dir must not abort the
        // install. Same warn-and-continue posture as the foreign-marker branch —
        // the adapter is staged either way, it just may not resolve as CommonJS.
        console.warn(
          `  ⚠  Could not write ${np.dir}/package.json (CommonJS marker) — install continued. `
          + `If the config root declares "type": "module", ${np.file} will not load.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// _migrateLegacyOpencodeCommandDir
// ---------------------------------------------------------------------------

/**
 * #2329: migrate a pre-fix OpenCode install's legacy singular `command/`
 * command directory into the current descriptor-driven destination (plural
 * `commands/` for OpenCode — the dir OpenCode actually discovers slash
 * commands from; unaffected for Kilo, whose descriptor still declares
 * `command`, so `currentName === LEGACY_NAME` short-circuits below).
 *
 * Runs BEFORE materialization writes the fresh command set to the new
 * location (mirroring `_runLegacyInstallMigrations`'s ordering for the
 * generic branch, which combined-family runtimes otherwise skip entirely).
 *
 * Ownership safety mirrors installer-migrations 003
 * (rename-get-shit-done-to-gsd-core): only files present, and unchanged or
 * locally modified, in the PRIOR install manifest under the legacy
 * `command/<file>` key are removed here — the materialization call
 * immediately following writes the current command set fresh into the new
 * location, so removing the stale copies is safe. Anything not proven
 * manifest-managed (unrelated user content someone dropped into `command/`)
 * is left untouched, never deleted. The emptied legacy directory is removed
 * only once nothing else is left inside it.
 *
 * Implemented as inline pre-materialization cleanup rather than a
 * `src/installer-migrations/*.cts` record: the formal migrations framework
 * only ever DELETES individual files (never directories, and never a
 * relocate/move primitive — see docs/installer-migrations.md's Action
 * Types), so the empty-directory removal below would need this same
 * hand-written glue regardless. It also intentionally is NOT reachable via
 * combinedFamilyInstall's early return above `_runLegacyInstallMigrations`,
 * matching the existing precedent that OpenCode/Kilo's bespoke install path
 * owns its own legacy cleanup rather than routing through the generic
 * layout-driven migrations hook.
 */
function _migrateLegacyOpencodeCommandDir(runtime: string, configDir: string, behaviors: any): void {
  const LEGACY_NAME = 'command';
  const currentName = behaviors.flatCommandDir || LEGACY_NAME;
  if (currentName === LEGACY_NAME) return; // e.g. Kilo — legacy IS the current location; nothing to migrate
  const legacyDir = path.join(configDir, LEGACY_NAME);
  if (!installFs().existsSync(legacyDir)) return;
  // Never follow a symlinked legacy dir out of configDir.
  if (installFs().lstatSync(legacyDir).isSymbolicLink()) return;

  // #2874: installerMigrations.readInstallManifest/classifyArtifact are
  // routed through the injectable seam (installer-migrations.cts:36,54-58,
  // 376-380 — readInstallManifest -> readJsonIfPresent -> installFs(),
  // classifyArtifact -> sha256File -> installFs().readFileSync), so a
  // fake-adapter install of an opencode-family runtime with a legacy
  // `command/` dir present reaches the fake, not real fs. Exercised by
  // tests/executed-plan.test.cjs's F2 "opencode-family legacy command/ dir
  // migration" case, which poisons every real fs method and asserts the
  // fake store was mutated.
  const manifest = installerMigrations.readInstallManifest(configDir);
  let entries: fs.Dirent[];
  try {
    entries = installFs().readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // command/ is a flat directory of gsd-*.md files; skip anything that
    // isn't a plain file (nested dirs, symlinks) rather than guess intent.
    if (!entry.isFile()) continue;
    const relPath = `${LEGACY_NAME}/${entry.name}`;
    const { classification } = installerMigrations.classifyArtifact(configDir, relPath, manifest);
    if (classification === 'managed-pristine' || classification === 'managed-modified') {
      try { installFs().unlinkSync(path.join(legacyDir, entry.name)); } catch { /* best-effort */ }
    }
    // 'unknown' (not manifest-tracked) is left untouched — GSD cannot prove
    // ownership, so it must never be deleted as collateral damage.
  }

  try {
    if (installFs().readdirSync(legacyDir).length === 0) installFs().rmdirSync(legacyDir);
  } catch { /* best-effort — a non-empty or otherwise-busy dir is left in place */ }
}

// ---------------------------------------------------------------------------
// installOpencodeFamilyArtifacts
// ---------------------------------------------------------------------------

/**
 * Combined-family install orchestrator for OpenCode/Kilo (ADR-1239 / #2087,
 * #2093). Stages the flattened commands surface + skills surface + (any
 * runtime whose hostBehaviors declares `nativePlugin` — OpenCode and, since
 * #2093, Kilo) native plugin adapter, mirroring the bespoke `else if (isOpencode ||
 * isKilo)` block previously inlined in bin/install.js.
 *
 * @param runtime - 'opencode' or 'kilo'
 * @param configDir - resolved runtime config directory
 * @param scope - install scope ('global' | 'local')
 * @param resolvedProfile - from resolveProfile() / resolveEffectiveProfile()
 * @param resolveAttribution - injection: (runtime) => attribution string | undefined
 * @param behaviors - the runtime's hostBehaviors descriptor (already resolved by the caller)
 * @param capabilityRegistry - #2362: optional composed capability registry
 *   (capabilityClusters view), threaded straight through to
 *   installOpencodeFamilySkills so an installed third-party capability skill
 *   materializes for this combined-family (OpenCode/Kilo) install path too.
 *   Absent -> no third-party skills staged (fail closed).
 * @param projectDir - project/config discovery root, distinct from configDir for global installs
 * @returns #2874 design row 2: an executed-plan value, same top-level shape
 *   (`runtime`/`scope`/`kinds`/`cleanup`/`postSteps`) as the generic
 *   `installRuntimeArtifacts` branch — this was the one early return a
 *   `void`-shaped hole survived unnoticed in.
 */
function installOpencodeFamilyArtifacts(
  runtime: string,
  configDir: string,
  scope: string,
  resolvedProfile: any,
  resolveAttribution: ResolveAttribution = () => undefined,
  behaviors: any = {},
  capabilityRegistry?: any,
  packageRoot?: string,
  projectDir?: string | null,
): any {
  // #2870: `scope` keeps its exported required `string` signature (no
  // signature change). It is always the `installRuntimeArtifacts`-forwarded
  // 'global' | 'local' literal produced by bin/install.js's scope-resolution
  // ternary (both real call sites and every test call site), so the cast is
  // safe: `isGlobalScope` never sees a value outside its union here.
  const isGlobal = isGlobalScope(scope as InstallScope);
  // findInstallSourceRoot resolves DIRECTLY to the commands/gsd source dir
  // (via the .gsd-source marker or a walk-up from __dirname) — every other
  // call site in runtime-artifact-layout.cts feeds its return value straight
  // into stageSkillsForProfile/stageSkillsForRuntimeAsSkills. The repo/package
  // root (needed below for the native plugin source) is two levels up.
  const commandsGsdDir = runtimeArtifactLayout.findInstallSourceRoot(configDir);
  const src = packageRoot ?? executingPackageRoot();
  const rawCommandsDir = installProfiles.stageSkillsForProfile(commandsGsdDir, resolvedProfile);

  const pathPrefix = (runtimeArtifactConversion as any)._computePathPrefix({
    isGlobal,
    isOpencode: behaviors.skipHomePrefixSubstitution === true,
    isWindowsHost: process.platform === 'win32',
    resolvedTarget: posixNormalize(path.resolve(configDir)),
    homeDir: posixNormalize(os.homedir()),
  });

  // #2329: destDir is derived from the SAME hostBehaviors.flatCommandDir
  // descriptor value read by writeManifest's manifest-key prefix and by
  // resolveRuntimeArtifactLayout's commands-kind destSubpath — a hardcoded
  // literal here would silently diverge from the descriptor the moment either
  // is edited (Generative Fix Divergence guard). OpenCode uses 'commands'
  // (plural, the dir OpenCode actually discovers slash commands from); Kilo
  // keeps its own descriptor value ('command', singular) unchanged.
  const commandDir = runtimeArtifactInstallPlan.assertDestWithinConfigHome(
    configDir,
    behaviors.flatCommandDir || 'command',
  );
  installOpencodeFamilyCommands(runtime, commandDir, rawCommandsDir, pathPrefix, resolveAttribution);
  const skillsWritten = installOpencodeFamilySkills(runtime, configDir, rawCommandsDir, pathPrefix, resolveAttribution, resolvedProfile, capabilityRegistry);
  // #2875 Part 2 Task A: agents kind, reusing the SAME descriptor path the
  // generic layout-driven loop uses (see installAgentsKindStandalone's own
  // doc). A `null` result means this runtime's layout declares no `agents`
  // kind — nothing written, nothing reported (no #1879-F15 inert claim).
  const agentsResult = installAgentsKindStandalone(runtime, configDir, scope, resolvedProfile, pathPrefix, resolveAttribution, capabilityRegistry, projectDir);

  _installNativePluginIfDeclared(runtime, configDir, behaviors, src);

  // #2874 design row 2: report what this combined-family install wrote,
  // mirroring the generic branch's top-level shape. `cleanup` is `[]` — this
  // path stages via install-profiles.cts's STAGED_DIRS (process-exit
  // cleanup), not the per-call cleanupDirs mechanism createRuntimeArtifactInstallPlan
  // uses, so there is nothing this call itself attempted to clean up.
  return {
    runtime,
    scope,
    kinds: [
      { kind: 'commands', sourceDir: rawCommandsDir, destDir: commandDir },
      { kind: 'skills', sourceDir: rawCommandsDir, destDir: configDir, written: skillsWritten },
      ...(agentsResult ? [{ kind: 'agents', sourceDir: agentsResult.sourceDir, destDir: agentsResult.destDir }] : []),
    ],
    cleanup: [],
    postSteps: { hermesBareStemCleanup: false, nativePlugin: Boolean(behaviors.nativePlugin) },
  };
}

// ---------------------------------------------------------------------------
// uninstallRuntimeArtifacts
// ---------------------------------------------------------------------------

/**
 * Layout-driven uninstall orchestrator.
 * Runs legacy cleanup first, then uses resolveRuntimeArtifactLayout to
 * determine which GSD-owned entries to remove.
 *
 * @param runtime             canonical runtime ID
 * @param configDir           resolved runtime config directory
 * @param scope
 */
function uninstallRuntimeArtifacts(
  runtime: string,
  configDir: string,
  scope: string,
  deps: { os?: any; env?: Record<string, string | undefined> } = {},
): void {
  // A retired descriptor kind is absent from the current uninstall plan, just
  // as it is absent from the install plan. Sweep manifest-proven output from
  // retired kinds before removing the current layout so a direct uninstall
  // cannot leave stale runtime surfaces behind (#2644).
  retiredArtifactCleanup.pruneRetiredRuntimeArtifacts(runtime, configDir);

  // Legacy cleanup before layout-driven removal (scope-aware to avoid
  // removing Claude local commands/gsd/ which is the primary install dir).
  // Returns staged user artifacts so we can migrate AFTER layout removal
  // (the layout's gsd-* prefix pass would wipe a skill dir created here).
  const stagedLegacyArtifacts = _runLegacyUninstallCleanup(runtime, configDir, scope);

  const layout: any = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, configDir, scope as any);
  // #3712: uninstall resolves the SAME `kind.home` override as install and then
  // prunes it via _removeGsdEntries below, so it is a second escape route into
  // the developer's real home, not a read-only path. Guard it identically.
  testHomeGuard.assertTestHomeSandboxed('uninstallRuntimeArtifacts', runtime, layout?.kinds, {
    os: deps.os, env: deps.env,
  });
  const plan: any = runtimeArtifactInstallPlan.createRuntimeArtifactUninstallPlan(layout);
  const kindsByName = new Map<string, any>(layout.kinds.map((kind: any) => [kind.kind as string, kind]));
  for (const item of plan.items) {
    const kind: any = kindsByName.get(item.kind);
    if (!kind) {
      throw new Error(`Runtime artifact uninstall plan referenced unknown kind: ${item.kind}`);
    }
    _removeGsdEntries(item.destDir, kind);
  }

  // Hermes: after removing gsd-* skill dirs from skills/gsd/, also remove
  // the GSD-managed DESCRIPTION.md and then the category dir itself if it
  // contains no user content (#947). _removeGsdEntries removed gsd-* dirs
  // but left the category container and DESCRIPTION.md intact.
  if (runtime === 'hermes') {
    const nestedGsdDir = path.join(configDir, 'skills', 'gsd');
    if (fs.existsSync(nestedGsdDir)) {
      // Remove GSD-owned DESCRIPTION.md (written by writeHermesCategoryDescription)
      fs.rmSync(path.join(nestedGsdDir, 'DESCRIPTION.md'), { force: true });
      // Remove the category dir if empty (no user content remaining)
      const remaining = fs.readdirSync(nestedGsdDir, { withFileTypes: true });
      if (remaining.length === 0) {
        fs.rmSync(nestedGsdDir, { recursive: true, force: true });
      }
    }
  }

  // #2973 / Codex review (bd1f06c9): migrate dev-preferences.md to the
  // runtime-aware SKILL.md location after all layout-driven removal is
  // complete. Do NOT restore to commands/gsd/ — the user is uninstalling.
  if (stagedLegacyArtifacts) {
    // #2875: read the content back from the DISK-staged copy, matching
    // _runLegacyInstallMigrations's call site — never restored on failure
    // here either (the user is uninstalling; there is nothing to restore to).
    //
    // Security fix (parity with _runLegacyInstallMigrations's own guard,
    // src/install-engine.cts / bin/install.js:8478): `readFileSync` ALWAYS
    // follows a symlink. A staged `dev-preferences.md` that is itself a
    // symlink (user-artifact-staging.cts's "Symlink safety" contract: a
    // symlinked user artifact is recreated AS a symlink in the staging tree,
    // never copied by content) would previously have its REFERENT's bytes
    // read here and land in SKILL.md verbatim — e.g. a symlink to
    // `~/.ssh/id_rsa` gets its private key content written into a file GSD
    // loads into agent context. A symlink to a DIRECTORY instead throws
    // EISDIR uncaught out of this function, which the caller never expected
    // and which left the staged entry undiscarded (re-materializing on the
    // next recovery pass and failing uninstall every time thereafter).
    // lstatSync never follows a symlink; skip a symlinked name entirely
    // (never migrated) rather than dereferencing it.
    const savedLegacyArtifacts = new Map<string, string>();
    for (const name of stagedLegacyArtifacts.names) {
      const stagedPath = path.join(stagedLegacyArtifacts.filesDir, name);
      // #2875 defect fix (crash resilience — TOCTOU, parity with
      // _runLegacyInstallMigrations's own fix above): a raw `lstatSync`
      // throws if `stagedPath` has vanished between staging and this read;
      // degrade via `tryLstat` instead of crashing uninstall.
      const stagedLstat = tryLstat(stagedPath);
      if (!stagedLstat || stagedLstat.isSymbolicLink()) continue;
      savedLegacyArtifacts.set(name, installFs().readFileSync(stagedPath, 'utf8'));
    }
    migrateLegacyDevPreferencesToSkill(configDir, savedLegacyArtifacts, runtime, scope);
    userArtifactStaging.discardStagedUserArtifacts(stagedLegacyArtifacts);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
  installOpencodeFamilySkills,
  installOpencodeFamilyCommands,
  installAgentsKindStandalone,
  installOpencodeFamilyArtifacts,
  _installNativePluginIfDeclared,
  _hostBehaviors,
  _copyStaged,
  hasExistingSymlinkBetween,
  isSymlinkedDestOptIn,
  _resolveUserArtifactStagingRoot,
  _tryResolveUserArtifactStagingRoot,
  migrateLegacyDevPreferencesToSkill,
  applyOpencodeFamilyPathPrefix,
  convertClaudeCommandToOpencodeSkill,
  convertClaudeCommandToKiloSkill,
  USER_OWNED_ARTIFACTS,
  _runLegacyInstallMigrations,
  _runLegacyUninstallCleanup,
  _removeGsdEntries,
  _snapshotDir,
  _restoreDir,
  _removeHermesBareStemDirs,
};
