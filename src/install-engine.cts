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
import { posixNormalize } from './shell-command-projection.cjs';
import { isPathConfined } from './external-descriptor-trust.cjs';
import { ensureCommonJsMarker } from './commonjs-marker.cjs';

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
 * both. Both preserveUserArtifacts call sites and writeManifest must agree on
 * this list, which is why it lives here as a single constant.
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
// User-artifact preservation helpers
// ---------------------------------------------------------------------------

/**
 * Save user-generated files from destDir to an in-memory map before a wipe.
 *
 * @param destDir - Directory that is about to be wiped
 * @param fileNames - Relative file names (e.g. ['USER-PROFILE.md']) to preserve
 * @returns Map of fileName → file content (only entries that existed)
 */
function preserveUserArtifacts(destDir: string, fileNames: string[]): Map<string, string> {
  const saved = new Map<string, string>();
  for (const name of fileNames) {
    const fullPath = path.join(destDir, name);
    if (fs.existsSync(fullPath)) {
      try {
        saved.set(name, fs.readFileSync(fullPath, 'utf8'));
      } catch { /* skip unreadable files */ }
    }
  }
  return saved;
}

/**
 * Restore user-generated files saved by preserveUserArtifacts after a wipe.
 *
 * @param destDir - Directory that was wiped and recreated
 * @param saved - Map returned by preserveUserArtifacts
 */
function restoreUserArtifacts(destDir: string, saved: Map<string, string>): void {
  for (const [name, content] of saved) {
    const fullPath = path.join(destDir, name);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    } catch { /* skip unwritable paths */ }
  }
}

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
    realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
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
  let cursor = resolvedRoot;
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
    if (!allowFollow) return true;
    try {
      cursor = fs.realpathSync(cursor);
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
    if (!fs.existsSync(cursor)) return false;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
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
        const realTarget = fs.realpathSync(cursor);
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
 * @param saved - Map returned by preserveUserArtifacts
 * @param runtime - canonical runtime ID (e.g. 'hermes', 'qwen', 'claude')
 * @param scope - install scope
 * @returns true if a file was migrated, false otherwise
 */
function migrateLegacyDevPreferencesToSkill(targetDir: string, saved: Map<string, string>, runtime?: string, scope: string = 'global'): boolean {
  if (!saved || !saved.has('dev-preferences.md')) return false;
  let skillDir: string;
  if (runtime) {
    const layout: any = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, targetDir, scope as any);
    const skillsKindEntry = layout.kinds.find((k: any) => k.kind === 'skills');
    if (!skillsKindEntry) return false; // runtime has no skills layout at this scope (e.g. cline local)
    const stemName = skillsKindEntry.prefix === '' ? 'dev-preferences' : 'gsd-dev-preferences';
    skillDir = path.join(runtimeArtifactInstallPlan.assertDestWithinConfigHome(targetDir, skillsKindEntry.destSubpath), stemName);
  } else {
    // Legacy fallback for callers that have not yet been updated to pass runtime
    skillDir = path.join(runtimeArtifactInstallPlan.assertDestWithinConfigHome(targetDir, 'skills'), 'gsd-dev-preferences');
  }
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile)) return false;
  // Symlink-escape guard: reject if any path component between targetDir and
  // skillDir is a symlink that would redirect writes outside the config root.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(path.resolve(targetDir), skillDir, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `migrateLegacyDevPreferencesToSkill: skillDir "${skillDir}" contains a symlink the install root "${targetDir}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, saved.get('dev-preferences.md')!, 'utf8');
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
  if (!fs.existsSync(stagedDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  if (kind.kind === 'skills') {
    // Each child of stagedDir is a prefixed skill directory: gsd-help/, etc.
    for (const entry of fs.readdirSync(stagedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(stagedDir, entry.name);
      const dest = path.join(destDir, entry.name);
      fs.cpSync(src, dest, { recursive: true });
    }
    return;
  }

  if (kind.kind === 'kimi-agents') {
    fs.cpSync(stagedDir, destDir, { recursive: true });
    return;
  }

  // commands or agents
  const entries = fs.readdirSync(stagedDir, { withFileTypes: true });
  // For commands: apply prefix unless the destSubpath's last segment already
  // represents the GSD namespace (e.g. 'commands/gsd' → last segment 'gsd').
  const destLast = path.basename(kind.destSubpath);
  const prefixStem = kind.prefix ? kind.prefix.replace(/-$/, '') : '';
  const namespacedByDir = kind.kind === 'commands' && destLast === prefixStem;

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
    } else if (namespacedByDir) {
      // Directory is the namespace; don't double-prefix the filename
      destName = entry.name;
    } else {
      // Flat commands directory (e.g. command/ for opencode/kilo)
      destName = `${kind.prefix}${stem}.md`;
    }

    fs.copyFileSync(path.join(stagedDir, entry.name), path.join(destDir, destName));
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
  if (!fs.existsSync(destDir)) return;
  if (kind.kind === 'kimi-agents') {
    for (const fileName of ['gsd.yaml', 'gsd.md']) {
      fs.rmSync(path.join(destDir, fileName), { force: true });
    }
    const subagentsDir = path.join(destDir, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith('gsd-')) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.md')) continue;
        fs.rmSync(path.join(subagentsDir, entry.name), { force: true });
      }
    }
    return;
  }
  if (kind.prefix === '') {
    // Whole-namespace removal (Hermes nested case — destSubpath is skills/gsd)
    // The directory itself is the GSD namespace, so remove it entirely.
    fs.rmSync(destDir, { recursive: true, force: true });
    return;
  }
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(kind.prefix)) continue;
    fs.rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
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
  if (!fs.existsSync(dir)) return files;
  const walk = (relPath: string, absPath: string) => {
    for (const e of fs.readdirSync(absPath, { withFileTypes: true })) {
      const childRel = relPath ? path.join(relPath, e.name) : e.name;
      const childAbs = path.join(absPath, e.name);
      if (e.isDirectory()) walk(childRel, childAbs);
      else if (e.isFile()) files.set(childRel, fs.readFileSync(childAbs));
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
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
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
  if (!fs.existsSync(nestedGsdDir)) return;
  const entries = fs.readdirSync(nestedGsdDir, { withFileTypes: true });

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
      fs.rmSync(path.join(nestedGsdDir, entry.name), { recursive: true });
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
  let savedLegacyArtifacts: Map<string, string> | null = null;
  if (_hostBehaviors(runtime).legacyCommandsGsdInstallMigration) {
    if (fs.existsSync(legacyCommandsGsd)) {
      savedLegacyArtifacts = preserveUserArtifacts(legacyCommandsGsd, ['dev-preferences.md']);
      fs.rmSync(legacyCommandsGsd, { recursive: true });
    }
  }

  // Hermes: remove pre-#2841 flat skills/gsd-*/ entries that lived alongside
  // the new skills/gsd/ nested layout.
  if (runtime === 'hermes') {
    const flatSkillsDir = path.join(configDir, 'skills');
    if (fs.existsSync(flatSkillsDir)) {
      for (const entry of fs.readdirSync(flatSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
          fs.rmSync(path.join(flatSkillsDir, entry.name), { recursive: true });
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
  if (savedLegacyArtifacts) {
    migrateLegacyDevPreferencesToSkill(configDir, savedLegacyArtifacts, runtime, scope);
  }
}

/**
 * Run legacy uninstall cleanup that must execute BEFORE the layout-driven
 * removal so old-format entries are also cleaned up.
 *
 * @param runtime
 * @param configDir  resolved runtime config directory
 * @param scope
 * @returns saved legacy artifacts for post-removal migration, or null
 */
function _runLegacyUninstallCleanup(runtime: string, configDir: string, scope: string = 'global'): Map<string, string> | null {
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
  let savedLegacyArtifacts: Map<string, string> | null = null;
  // commands/gsd/ is a legacy location for Qwen, Hermes, and Claude global.
  // Claude local is intentionally excluded: the inline uninstall block (1c) handles
  // commands/gsd/ for claude local, preserving dev-preferences.md by restoring it
  // to the same location (#1423). Using migrateLegacyDevPreferencesToSkill here
  // (which would redirect to skills/) conflicts with the test contract for local installs.
  const _lu = _hostBehaviors(runtime).legacyCommandsGsdUninstall;
  const isLegacyCommandsGsd = _lu === true || (_lu === 'global' && scope === 'global');
  if (isLegacyCommandsGsd) {
    const legacyCommandsGsd = path.join(configDir, 'commands', 'gsd');
    if (fs.existsSync(legacyCommandsGsd)) {
      savedLegacyArtifacts = preserveUserArtifacts(legacyCommandsGsd, ['dev-preferences.md']);
      fs.rmSync(legacyCommandsGsd, { recursive: true });
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

  // Return saved artifacts so the caller can migrate after layout-driven removal.
  return savedLegacyArtifacts;
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
 */
function installRuntimeArtifacts(
  runtime: string,
  configDir: string,
  scope: string,
  resolvedProfile: any,
  resolveAttribution: ResolveAttribution = () => undefined,
  capabilityRegistry?: any,
): void {
  // Combined-family runtimes (OpenCode/Kilo, ADR-1239 / #2087): route through
  // the dedicated combined commands+skills+plugin orchestrator instead of the
  // generic layout-driven loop below, mirroring the bespoke install path that
  // previously lived inline in bin/install.js.
  const behaviors = _hostBehaviors(runtime);
  if (behaviors.combinedFamilyInstall) {
    // #2329: combined-family runtimes (OpenCode/Kilo) bypass
    // _runLegacyInstallMigrations below entirely (early return), so their
    // legacy-directory cleanup needs its own pre-materialization hook here.
    _migrateLegacyOpencodeCommandDir(runtime, configDir, behaviors);
    installOpencodeFamilyArtifacts(runtime, configDir, scope, resolvedProfile, resolveAttribution, behaviors, capabilityRegistry);
    return;
  }

  // Legacy cleanup before layout-driven writes
  _runLegacyInstallMigrations(runtime, configDir, scope);

  const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, configDir, scope as 'global' | 'local', capabilityRegistry);
  const planResult = runtimeArtifactInstallPlan.createRuntimeArtifactInstallPlan({
    // `Layout` is structurally identical across the layout/install-plan .cjs
    // modules but nominally distinct to tsc (untyped .cjs boundary) — bridge it.
    layout: layout as any,
    resolvedProfile,
    homedir: () => os.homedir(),
    platform: process.platform,
    resolveAttribution,
  });

  const cleanupDirs = planResult.ok ? planResult.plan.cleanupDirs : planResult.cleanupDirs;
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
      const installRoot = (kind && typeof kind.home === 'string' && kind.home !== '') ? kind.home : configDir;
      // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
      // Threat model from #1704 / ADR-1239 Phase B preserved: path-traversal and
      // resolved-target-equals-root still refuse regardless of opt-in.
      if (hasExistingSymlinkBetween(path.resolve(installRoot), dest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
        throw new Error(
          `installRuntimeArtifacts: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust — refusing to create. If this is an intentional user-owned symlink layout (e.g. externalized skills/hooks dir, multi-account configHome, or a dotfiles-managed configHome), re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
        );
      }
      fs.mkdirSync(dest, { recursive: true });
      if (kind.kind === 'skills' && fs.existsSync(dest)) {
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
            if (!fs.existsSync(skillDir)) continue;
            const snap = _snapshotDir(skillDir);
            if (snap.size > 0) toPreserve.set(dirName, snap);
          }
        }

        _removeGsdEntries(dest, kind);
        _copyStaged(item.sourceDir, dest, kind, configDir, runtime);

        // Restore user-owned dirs after the prune+copy
        for (const [dirName, snap] of toPreserve) {
          _restoreDir(path.join(dest, dirName), snap);
        }
      } else {
        // For non-skills kinds (commands, agents): no user content to preserve;
        // just prune stale gsd-* entries and copy new ones.
        _removeGsdEntries(dest, kind);
        _copyStaged(item.sourceDir, dest, kind, configDir, runtime);
      }
    }
  } finally {
    for (const dir of cleanupDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
  if (runtime === 'hermes') {
    const nestedGsdDirForCleanup = path.join(configDir, 'skills', 'gsd');
    _removeHermesBareStemDirs(nestedGsdDirForCleanup);
  }

  // Generic-branch nativePlugin staging (ADR-1239 / #2102 Stage 1): runtimes
  // outside the OpenCode/Kilo combined-family install (e.g. pi, whose
  // artifactLayout is empty and which never sets combinedFamilyInstall) still
  // need their declared hostBehaviors.nativePlugin file copied into configDir.
  // findInstallSourceRoot resolves the repo/package root independent of
  // configDir contents (marker check, then a walk-up from __dirname), so this
  // is safe even when configDir has no .gsd-source marker (artifactLayout: []).
  if (behaviors.nativePlugin) {
    const commandsGsdDir = runtimeArtifactLayout.findInstallSourceRoot(configDir);
    const src = path.dirname(path.dirname(commandsGsdDir));
    _installNativePluginIfDeclared(runtime, configDir, behaviors, src);
  }
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
  const rawDir = rawCommandsDir;
  if (!rawDir || !fs.existsSync(rawDir)) return 0;

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

  const dest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(targetDir, skillsKindEntry.destSubpath);
  // Symlink-escape guard: reject if any path component between targetDir and
  // dest is a symlink that would redirect writes outside the config root.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(path.resolve(targetDir), dest, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `installOpencodeFamilySkills: destDir "${dest}" contains a symlink the install root "${targetDir}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  fs.mkdirSync(dest, { recursive: true });

  // Preserve user-owned GSD-prefixed skill dirs across the gsd-* prune.
  // gsd-dev-preferences is generated by the user (via generate-dev-preferences)
  // and lives at <configDir>/skills/gsd-dev-preferences — _removeGsdEntries
  // would otherwise wipe it. Mirrors the preservation in installRuntimeArtifacts
  // (#2973).
  const USER_OWNED_SKILL_DIRS = ['gsd-dev-preferences'];
  const toPreserve = new Map<string, Map<string, Buffer>>(); // dirName -> Map<relPath, Buffer>
  for (const dirName of USER_OWNED_SKILL_DIRS) {
    const skillDir = path.join(dest, dirName);
    if (!fs.existsSync(skillDir)) continue;
    const snap = _snapshotDir(skillDir);
    if (snap.size > 0) toPreserve.set(dirName, snap);
  }

  _removeGsdEntries(dest, skillsKindEntry);

  let count = 0;
  const firstPartyStems = new Set<string>();
  for (const entry of fs.readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    firstPartyStems.add(stem);
    const skillName = `${skillsKindEntry.prefix}${stem}`;
    let content = fs.readFileSync(path.join(rawDir, entry.name), 'utf8');
    content = applyOpencodeFamilyPathPrefix(content, runtime, pathPrefix);
    content = processAttribution(content, resolveAttribution(runtime));
    content = converter(content, skillName);
    const skillDir = path.join(dest, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
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
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
      // #2322 HIGH-3 parity: persist the capability-owned marker so a later
      // prune pass can identify this directory even once the owning
      // capability is uninstalled/unsurfaced and no longer appears in any
      // registry view.
      fs.writeFileSync(path.join(skillDir, installProfiles.CAPABILITY_SKILL_MARKER), found.capId + '\n', 'utf8');
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
  if (!fs.existsSync(srcDir)) return;

  // Remove old gsd-*.md files before copying new ones
  if (fs.existsSync(destDir)) {
    for (const file of fs.readdirSync(destDir)) {
      if (file.startsWith(`${prefix}-`) && file.endsWith('.md')) fs.unlinkSync(path.join(destDir, file));
    }
  } else {
    fs.mkdirSync(destDir, { recursive: true });
  }

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      installOpencodeFamilyCommands(runtime, destDir, srcPath, pathPrefix, resolveAttribution, `${prefix}-${entry.name}`);
    } else if (entry.name.endsWith('.md')) {
      const baseName = entry.name.replace('.md', '');
      const destName = `${prefix}-${baseName}.md`;
      let content = fs.readFileSync(srcPath, 'utf8');
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
      fs.writeFileSync(path.join(destDir, destName), content);
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
    if (fs.existsSync(pluginSrc)) {
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
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(pluginSrc, destPath);
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
  if (!fs.existsSync(legacyDir)) return;
  // Never follow a symlinked legacy dir out of configDir.
  if (fs.lstatSync(legacyDir).isSymbolicLink()) return;

  const manifest = installerMigrations.readInstallManifest(configDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
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
      try { fs.unlinkSync(path.join(legacyDir, entry.name)); } catch { /* best-effort */ }
    }
    // 'unknown' (not manifest-tracked) is left untouched — GSD cannot prove
    // ownership, so it must never be deleted as collateral damage.
  }

  try {
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
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
 */
function installOpencodeFamilyArtifacts(
  runtime: string,
  configDir: string,
  scope: string,
  resolvedProfile: any,
  resolveAttribution: ResolveAttribution = () => undefined,
  behaviors: any = {},
  capabilityRegistry?: any,
): void {
  const isGlobal = scope === 'global';
  // findInstallSourceRoot resolves DIRECTLY to the commands/gsd source dir
  // (via the .gsd-source marker or a walk-up from __dirname) — every other
  // call site in runtime-artifact-layout.cts feeds its return value straight
  // into stageSkillsForProfile/stageSkillsForRuntimeAsSkills. The repo/package
  // root (needed below for the native plugin source) is two levels up.
  const commandsGsdDir = runtimeArtifactLayout.findInstallSourceRoot(configDir);
  const src = path.dirname(path.dirname(commandsGsdDir));
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
  installOpencodeFamilySkills(runtime, configDir, rawCommandsDir, pathPrefix, resolveAttribution, resolvedProfile, capabilityRegistry);

  _installNativePluginIfDeclared(runtime, configDir, behaviors, src);
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
function uninstallRuntimeArtifacts(runtime: string, configDir: string, scope: string): void {
  // Legacy cleanup before layout-driven removal (scope-aware to avoid
  // removing Claude local commands/gsd/ which is the primary install dir).
  // Returns saved user artifacts so we can migrate AFTER layout removal
  // (the layout's gsd-* prefix pass would wipe a skill dir created here).
  const savedLegacyArtifacts = _runLegacyUninstallCleanup(runtime, configDir, scope);

  const layout: any = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, configDir, scope as any);
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
  if (savedLegacyArtifacts) {
    migrateLegacyDevPreferencesToSkill(configDir, savedLegacyArtifacts, runtime, scope);
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
  installOpencodeFamilyArtifacts,
  _installNativePluginIfDeclared,
  _hostBehaviors,
  _copyStaged,
  hasExistingSymlinkBetween,
  isSymlinkedDestOptIn,
  preserveUserArtifacts,
  restoreUserArtifacts,
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
