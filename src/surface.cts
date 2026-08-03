/**
 * Runtime surface module — ADR-0011 Phase 2 (Option B).
 *
 * Manages the runtime enable/disable surface state (the `.gsd-surface.json` marker in
 * each runtime's config dir root (e.g., ~/.claude)) independently of the install-time profile marker
 * (`.gsd-profile`). Runtime config locations are resolved by callers.
 *
 * Effective skill set = base profile ∪ explicitAdds − disabledClusters − explicitRemoves,
 * then transitively closed via the manifest.
 *
 * Exports:
 *   readSurface(runtimeConfigDir)
 *   writeSurface(runtimeConfigDir, surfaceState)
 *   resolveSurface(runtimeConfigDir, manifest, clusterMap?, registry?)
 *   applySurface(runtimeConfigDir, layout, manifest, clusterMap?, registry?)
 *   listSurface(runtimeConfigDir, manifest, clusterMap?, registry?)
 *   pruneSkillDirs(skillsDir, retainedNames, prefix, manifest)
 *
 * The optional `registry` param (ADR-857 phase 4c) accepts the capability-registry
 * object.  When present, capability clusters are merged into the effective cluster
 * map and the registry is threaded into resolveProfile so capability-contributed
 * skills participate in the base set and disable-ability.  Absent or undefined
 * leaves behaviour identical to the pre-registry path (no-op for current registry
 * where UI=full and the full profile returns '*' regardless).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/surface.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformWriteSync, posixNormalize } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfiles = require('./install-profiles.cjs');
const {
  readActiveProfile,
  resolveProfile,
  loadSkillsManifest,
  // #2322 HIGH-3: shared marker name — single source of truth with the writer
  // (install-profiles.cts stageSkillsForRuntimeAsSkills) so the prune reader
  // below can never drift from what the stage-time writer actually wrote.
  CAPABILITY_SKILL_MARKER,
} = installProfiles;
import { CLUSTERS } from './clusters.cjs';
import type { ClusterMap } from './clusters.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactLayout = require('./runtime-artifact-layout.cjs');
const { findInstallSourceRoot } = runtimeArtifactLayout;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactConversion = require('./runtime-artifact-conversion.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactInstallPlan = require('./runtime-artifact-install-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import retiredArtifactCleanup = require('./retired-artifact-cleanup.cjs');
const { assertDestWithinConfigHome } = runtimeArtifactInstallPlan;

const SURFACE_FILE_NAME = '.gsd-surface.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentCtx {
  runtime: string;
  pathPrefix: string;
  attribution: string | null | undefined;
}

interface ArtifactKind {
  kind: string;
  destSubpath: string;
  prefix: string;
  stage: (resolvedProfile: { name: string; skills: Set<string> | '*'; agents: Set<string> }, agentCtx?: AgentCtx) => string;
}

interface Layout {
  runtime: string;
  configDir: string;
  scope?: 'local' | 'global';
  kinds: ArtifactKind[];
}

interface ApplySurfaceOptions {
  resolveAttribution?: (runtime: string) => string | null | undefined;
  homedir?: () => string;
  platform?: string;
}

// ---------------------------------------------------------------------------
// State IO
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SurfaceState
 * @property {string} baseProfile
 * @property {string[]} disabledClusters
 * @property {string[]} explicitAdds
 * @property {string[]} explicitRemoves
 */

interface SurfaceState {
  baseProfile: string;
  disabledClusters: string[];
  explicitAdds: string[];
  explicitRemoves: string[];
}

/**
 * Read the surface state from a runtime config directory.
 *
 * @param runtimeConfigDir
 * @returns null if file missing or corrupt
 */
function readSurface(runtimeConfigDir: string): SurfaceState | null {
  const filePath = path.join(runtimeConfigDir, SURFACE_FILE_NAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Structural validation — must have these fields with expected types
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['baseProfile'] !== 'string') return null;
    if (!Array.isArray(p['disabledClusters'])) return null;
    if (!Array.isArray(p['explicitAdds'])) return null;
    if (!Array.isArray(p['explicitRemoves'])) return null;
    return {
      baseProfile: p['baseProfile'],
      disabledClusters: p['disabledClusters'] as string[],
      explicitAdds: p['explicitAdds'] as string[],
      explicitRemoves: p['explicitRemoves'] as string[],
    };
  } catch {
    return null;
  }
}

/**
 * Write the surface state atomically via the platform seam (mkdir + tmp+rename).
 */
function writeSurface(runtimeConfigDir: string, surfaceState: SurfaceState): void {
  platformWriteSync(path.join(runtimeConfigDir, SURFACE_FILE_NAME), JSON.stringify(surfaceState, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Expand cluster names to skill stems using the provided clusterMap.
 */
function clustersToSkills(clusterNames: string[], clusterMap: ClusterMap | Record<string, string[]>): Set<string> {
  const result = new Set<string>();
  for (const name of clusterNames) {
    const members = (clusterMap as Record<string, ReadonlyArray<string> | undefined>)[name];
    // FIX 5: guard against non-iterable members — malformed registry must never throw
    if (!Array.isArray(members)) continue;
    for (const s of (members as string[])) result.add(s);
  }
  return result;
}

/**
 * Normalize manifest inputs to the skill-dependency Map shape expected by
 * resolveProfile/computeClosure.
 *
 * Supports:
 *  - canonical Map<string, string[]>
 *  - legacy plain object map: { [stem]: string[] }
 *  - parsed gsd-file-manifest.json object ({ files: { ... } }) by rebuilding
 *    the dependency manifest from the install source tree
 */
function normalizeSkillManifest(runtimeConfigDir: string, manifest: Map<string, string[]> | object | null | undefined): Map<string, string[]> {
  if (manifest instanceof Map) {
    return manifest;
  }
  if (!manifest || typeof manifest !== 'object') {
    return new Map();
  }

  // Legacy/ad-hoc object map: stem -> requires[]
  const arrayEntries = Object.entries(manifest as Record<string, unknown>).filter(([, value]) => Array.isArray(value)) as [string, string[]][];
  if (arrayEntries.length > 0) {
    return new Map(arrayEntries.map(([stem, deps]) => [stem, deps]));
  }

  // Parsed gsd-file-manifest.json shape: rebuild the dependency map from source.
  const manifestObj = manifest as Record<string, unknown>;
  if (manifestObj['files'] && typeof manifestObj['files'] === 'object') {
    const srcCommandsDir = findInstallSourceRoot(runtimeConfigDir);
    return loadSkillsManifest(srcCommandsDir);
  }

  return new Map();
}

/**
 * Resolve the effective surface to a typed profile-like object.
 * Shape: { name, skills: Set<string>|'*', agents: Set<string> }
 *
 * Resolution order:
 * 1. Start with base profile resolved via resolveProfile()
 * 2. Remove skills in disabled clusters
 * 3. Add explicitAdds (and their transitive closure)
 * 4. Remove explicitRemoves (only the stem itself, no cascade)
 *
 * ADR-857 phase 4c: optional registry param.  When present:
 *   - capability clusters are merged into the effective cluster map so
 *     capability-owned skill groups are disable-able.
 *   - registry is threaded into resolveProfile so capability skills
 *     participate in the base skill set and their requires: chains expand.
 */
function resolveSurface(runtimeConfigDir: string, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>, registry?: { capabilityClusters?: Record<string, string[]>; profileMembership?: Record<string, { tier: string; profiles: string[] }> }): { name: string; skills: Set<string>; agents: Set<string> } {
  // Merge capability clusters into the cluster map when registry is provided.
  // The ADR-857 phase 4a HARD gate guarantees that when a capId matches a CLUSTERS
  // key, the values are EQUAL — so the spread is idempotent for matching names.
  // Defense-in-depth: if a capId collides with a hand-authored CLUSTERS key AND
  // the values DIFFER (future drift bypassing the gate), prefer the hand-authored
  // value so disable behavior is never silently changed by a stale registry entry.
  // Also guard: skip entries whose value is not a string[] (malformed registry).
  let cm: ClusterMap | Record<string, string[]> = clusterMap || CLUSTERS;
  if (registry && registry.capabilityClusters && typeof registry.capabilityClusters === 'object') {
    const baseCm = cm;
    const capClusters = registry.capabilityClusters;
    const merged: Record<string, string[]> = { ...(baseCm as Record<string, string[]>) };
    for (const capId of Object.keys(capClusters)) {
      const val = capClusters[capId];
      // FIX 5: skip malformed (non-array) entries — never throw on bad registry
      if (!Array.isArray(val)) continue;
      // FIX 4: if the capId matches an existing cluster key, only override when
      // the values are identical (guaranteed by 4a gate).  If they differ, the
      // hand-authored value wins — prefer known-correct disable behavior over
      // a potentially stale registry entry.
      if (Object.prototype.hasOwnProperty.call(baseCm, capId)) {
        const existing = (baseCm as Record<string, readonly string[] | string[]>)[capId];
        if (!Array.isArray(existing)) { merged[capId] = val; continue; }
        // Values differ → hand-authored wins (skip the override)
        if (existing.length !== val.length || existing.some((v, i) => v !== val[i])) continue;
      }
      // Prototype-pollution guard (parity with _capabilitySkillsForMode in install-profiles.cts)
      if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
      merged[capId] = val;
    }
    cm = merged;
  }
  const skillManifest = normalizeSkillManifest(runtimeConfigDir, manifest);
  const surface = readSurface(runtimeConfigDir);

  // Determine base profile name: from surface state or from .gsd-profile marker
  const baseProfileName = (surface && surface.baseProfile)
    ? surface.baseProfile
    : (readActiveProfile(runtimeConfigDir) || 'full');

  // Resolve base profile — thread registry so capability skills are included.
  const baseResolved = resolveProfile({
    modes: baseProfileName.split(',').map((s: string) => s.trim()),
    manifest: skillManifest,
    registry,
  });

  // If full, we need to enumerate all skills from the manifest
  let skills: Set<string>;
  if (baseResolved.skills === '*') {
    // Materialize all skill stems from manifest
    skills = new Set<string>();
    for (const [key] of skillManifest) {
      if (!key.startsWith('_calls_agents_')) skills.add(key);
    }
    // Issue #2045 (DEFECT 1): third-party capability skills live at
    // ~/.gsd/capabilities/<id>/skills/<stem>/SKILL.md — NOT in the runtime skills
    // dir → never in skillManifest → never in the Set → surfaced:false. The
    // overlay-aware registry's `capabilityClusters` already covers accepted
    // overlay caps (composed by loadRegistry({includeInstalled})), so union its
    // values into the surfaced Set. This is IDEMPOTENT for first-party skills
    // (their stems are already on disk → already in the Set) and ADDITIVE for
    // third-party skills (the fix). The 'full' profile means everything, and
    // every cap's profileMembership profiles-array includes 'full' (it is the
    // suffix top), so no per-tier gate is needed here — this invariant is owned
    // by gen-capability-registry.cjs deriveProfileMembership (PROFILE_RANK suffix)
    // + deriveCapabilityClusters (same non-empty-skills scoping); revisit both if
    // either derivation changes. Prototype-pollution guard mirrors the cluster-
    // merge block above (lines 217-240). NOTE: third-party cap agents are NOT
    // unioned here (skillManifest has no `_calls_agents_` companion for them) —
    // v1 scopes to skills-only caps per issue #2045; agents are a follow-up.
    if (registry && registry.capabilityClusters && typeof registry.capabilityClusters === 'object') {
      const BANNED = ['__proto__', 'constructor', 'prototype'];
      for (const capId of Object.keys(registry.capabilityClusters)) {
        if (BANNED.includes(capId)) continue;
        const stems = (registry.capabilityClusters as Record<string, unknown>)[capId];
        if (!Array.isArray(stems)) continue;
        for (const s of stems) {
          if (typeof s === 'string' && s.length > 0) skills.add(s);
        }
      }
    }
  } else {
    skills = new Set(baseResolved.skills);
  }

  if (surface) {
    // Step 2: remove disabled cluster members
    const disabledSkills = clustersToSkills(surface.disabledClusters, cm);
    for (const s of disabledSkills) skills.delete(s);

    // Step 3: add explicitAdds with transitive closure
    if (surface.explicitAdds.length > 0) {
      const addSet = new Set(surface.explicitAdds);
      // Compute closure of adds
      const queue = [...addSet];
      const visited = new Set(addSet);
      while (queue.length > 0) {
        const stem = queue.pop()!;
        const deps = skillManifest.get(stem) || [];
        for (const dep of deps) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      for (const s of visited) skills.add(s);
    }

    // Step 4: remove explicitRemoves (stem only, no cascade)
    for (const s of surface.explicitRemoves) {
      skills.delete(s);
    }
  }

  // Derive agents from skills
  const agents = new Set<string>();
  for (const skillStem of skills) {
    const agentRefs = skillManifest.get(`_calls_agents_${skillStem}`) || [];
    for (const agentStem of agentRefs) agents.add(agentStem);
  }

  const name = surface ? `surface:${surface.baseProfile}` : `profile:${baseProfileName}`;
  return { name, skills, agents };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Re-stage the active surface using the resolved layout.
 * Iterates layout.kinds and syncs each artifact kind to its destination.
 */
function applySurface(runtimeConfigDir: string, layout: Layout, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>, registry?: { capabilityClusters?: Record<string, string[]>; profileMembership?: Record<string, { tier: string; profiles: string[] }> }, opts?: ApplySurfaceOptions): { name: string; skills: Set<string>; agents: Set<string> } {
  if (path.resolve(runtimeConfigDir) !== path.resolve(layout.configDir)) {
    throw new TypeError('applySurface runtimeConfigDir must match layout.configDir');
  }
  const skillManifest = normalizeSkillManifest(layout.configDir, manifest);
  const resolved = resolveSurface(layout.configDir, skillManifest, clusterMap, registry);
  // Profile toggles must converge retired surfaces too. Once a kind disappears
  // from artifactLayout there is no normal sync pass left to prune it (#2644).
  retiredArtifactCleanup.pruneRetiredRuntimeArtifacts(layout.runtime, layout.configDir);
  // #1575: agents kind now mirrors createRuntimeArtifactInstallPlan — build
  // agentCtx (pathPrefix + attribution) and pass it to kind.stage() so
  // stageAgentsForRuntimeWithConverter applies the full inline-loop pipeline
  // (pathRewrites -> attribution -> converter -> normalize). Without this,
  // surface-path agents lack path-prefix rewrites and Co-Authored-By trailers,
  // diverging from a fresh install.
  const _homedirFn: () => string = opts?.homedir ?? (() => os.homedir());
  const _resolvedTarget = posixNormalize(path.resolve(layout.configDir));
  const _homeDir = posixNormalize(_homedirFn());
  const _isGlobal = (layout.scope ?? 'global') === 'global';
  const _isOpencode = layout.runtime === 'opencode';
  const _isWindowsHost = (opts?.platform ?? process.platform) === 'win32';
  const _pathPrefix = runtimeArtifactConversion._computePathPrefix({ isGlobal: _isGlobal, isOpencode: _isOpencode, isWindowsHost: _isWindowsHost, resolvedTarget: _resolvedTarget, homeDir: _homeDir });
  const _attribution = opts?.resolveAttribution ? opts.resolveAttribution(layout.runtime) : undefined;
  const agentCtx: AgentCtx = { runtime: layout.runtime, pathPrefix: _pathPrefix, attribution: _attribution };

  const tempDirsToClean: string[] = [];
  // #1575: When the surface has no state modifications AND the base profile is
  // 'full', pass the '*' sentinel for agents staging so ALL agents are staged —
  // matching the install path which uses { skills: '*' }. Without this, agents
  // not referenced by any skill's _calls_agents_ manifest entry would be silently
  // dropped from the surface path. For tiered profiles (core/standard) or when
  // surface mods exist, pass the resolved set so only the filtered subset stages.
  const _surfaceState = readSurface(layout.configDir);
  const _baseProfileName = (_surfaceState && _surfaceState.baseProfile)
    ? _surfaceState.baseProfile
    : (readActiveProfile(layout.configDir) || 'full');
  const _hasSurfaceMods = !!_surfaceState && (
    _surfaceState.disabledClusters.length > 0 ||
    _surfaceState.explicitAdds.length > 0 ||
    _surfaceState.explicitRemoves.length > 0
  );
  const _isUnmodifiedFull = _baseProfileName === 'full' && !_hasSurfaceMods;
  try {
    for (const kind of layout.kinds) {
      let staged: string;
      if (kind.kind === 'agents') {
        const agentProfile = _isUnmodifiedFull ? { ...resolved, skills: '*' as const } : resolved;
        staged = kind.stage(agentProfile, agentCtx);
      } else {
        staged = kind.stage(resolved);
      }
      if (kind.kind === 'skills') {
        runtimeArtifactConversion.rewriteStagedSkillBodies(staged, {
          runtime: layout.runtime,
          configDir: layout.configDir,
          scope: layout.scope ?? 'global',
        });
      } else if (kind.kind === 'commands') {
        const rewritten: string | undefined = runtimeArtifactConversion.rewriteStagedCommandBodies(staged, {
          runtime: layout.runtime,
          configDir: layout.configDir,
          scope: layout.scope ?? 'global',
        }) as string | undefined;
        if (rewritten && rewritten !== staged) {
          staged = rewritten;
          tempDirsToClean.push(rewritten);
        }
      }
      const dest = assertDestWithinConfigHome(layout.configDir, kind.destSubpath);
      _syncGsdDir(staged, dest, kind, skillManifest, layout.runtime);
    }
  } finally {
    for (const dir of tempDirsToClean) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
  return resolved;
}

/**
 * Prune GSD-managed skill directories from a skills directory.
 *
 * Removes every directory in `skillsDir` that is GSD-owned but NOT listed
 * in `retainedNames`. User-owned dirs (not matching the GSD ownership criteria)
 * are always preserved.
 *
 * Ownership criteria:
 *   - Non-empty prefix (e.g. 'gsd-'): dir name starts with that prefix AND
 *     EITHER appears in the manifest (first-party membership) OR carries the
 *     persisted `CAPABILITY_SKILL_MARKER` file (#2322 HIGH-3: a third-party
 *     capability skill, self-certifying and independent of current registry
 *     state — so an uninstalled/unsurfaced capability's stale skill is still
 *     prunable even though it no longer appears in any registry view). Dirs
 *     that match the prefix but satisfy NEITHER are treated as user-owned and
 *     preserved — this prevents data loss for user-created gsd-* directories.
 *     A warning is written to stderr when such a dir is encountered.
 *   - Empty prefix (Hermes): dir name appears as a canonical skill stem in the
 *     manifest. User dirs not in the manifest are preserved. (Hermes does not
 *     yet stage third-party capability skills, so the marker check does not
 *     apply on this path.)
 *   - Empty prefix without manifest, or manifest not a Map: conservative; no
 *     dirs are removed.
 *
 * This is the single point of truth for skill-dir pruning. Both _syncGsdDir
 * (surface apply) and callers that need stand-alone pruning use this function.
 *
 * @param skillsDir        directory that contains the gsd-STEM sub-dirs
 * @param retainedNames    set of directory names to keep (e.g. 'gsd-help')
 * @param prefix           GSD dir prefix, e.g. 'gsd-' (or '' for Hermes)
 * @param manifest         optional; required for Hermes empty-prefix case
 *                         and for manifest-membership gate in prefixed case.
 *                         Must be a Map; any other type is treated as missing.
 */
function pruneSkillDirs(skillsDir: string, retainedNames: Set<string>, prefix: string, manifest?: Map<string, string[]>): void {
  if (!fs.existsSync(skillsDir)) return;

  // Finding 2: guard against callers passing a truthy non-Map as manifest.
  // A non-Map manifest would throw on .keys(); treat it as absent and be conservative.
  const safeManifest = (manifest instanceof Map) ? manifest : null;

  // Build the canonical stem set from the manifest (used for both prefixed and Hermes paths).
  // Deletion requires manifest membership — without a valid manifest, be conservative.
  const canonicalStems = safeManifest
    ? new Set([...safeManifest.keys()].filter(k => !k.startsWith('_calls_agents_')))
    : null;

  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    let isGsdOwned: boolean;
    if (prefix !== '') {
      if (!entry.startsWith(prefix)) {
        // Does not match prefix at all — user-owned, preserve.
        continue;
      }
      // #2322: an entry in THIS apply's retained set is unambiguously wanted —
      // check that BEFORE the first-party-manifest-membership gate below. The
      // manifest only ever knows gsd-core's own bundled stems; a materialized
      // third-party capability skill (retained via the resolved profile's
      // registry union, #2045/#2322) has no manifest entry at all, so without
      // this early check it fell into the "unknown, preserve with warning"
      // branch on EVERY apply — misreporting a live, GSD-managed capability
      // skill as "user-owned or unknown" noise. This does not change any
      // deletion outcome (a retained entry was always preserved — see the
      // `retainedNames.has(entry)` check further below); it only short-
      // circuits the ambiguous-ownership warning for entries we already know,
      // this apply, are wanted.
      if (retainedNames.has(entry)) continue;
      // Finding 1 fix: prefix match is necessary but NOT sufficient.
      // The dir must also be in the manifest to be considered GSD-owned.
      // A user-created gsd-* dir that isn't in the manifest is preserved with a warning.
      const stem = entry.slice(prefix.length);
      if (canonicalStems && canonicalStems.has(stem)) {
        isGsdOwned = true;
      } else if (fs.existsSync(path.join(entryPath, CAPABILITY_SKILL_MARKER))) {
        // #2322 HIGH-3: not a first-party stem, but self-certified as a
        // GSD-managed THIRD-PARTY capability skill via the persisted marker
        // (written by install-profiles.cts stageSkillsForRuntimeAsSkills at
        // stage time). Without this, an orphaned capability skill — its
        // owning capability uninstalled/unsurfaced and no longer appearing in
        // ANY registry view — had no manifest entry at all and fell into the
        // "unknown, preserve with warning" branch below FOREVER: uninstalling
        // a malicious capability never actually removed its already-staged
        // instructions from the agent's context. The marker makes ownership
        // self-certifying at prune time, independent of current registry
        // state (or even of whether a manifest was supplied at all).
        isGsdOwned = true;
      } else if (!canonicalStems) {
        // No manifest available and no capability marker: cannot confirm
        // ownership — preserve conservatively (silent).
        continue;
      } else {
        process.stderr.write(
          `[gsd] Warning: ${entry} matches GSD prefix '${prefix}' but is not in the manifest — preserving (user-owned or unknown)\n`
        );
        continue;
      }
    } else if (canonicalStems) {
      // Hermes: GSD-owned iff the directory name appears in the canonical manifest.
      isGsdOwned = canonicalStems.has(entry);
    } else {
      // No manifest available: be conservative, don't remove anything.
      continue;
    }

    if (!isGsdOwned) continue;         // Hermes path only: preserve user-owned dirs not in manifest
    if (retainedNames.has(entry)) continue; // GSD-owned and in retain set
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`surface: failed to prune ${entryPath}: ${(err as Error).message}\n`);
    }
  }
}

/**
 * Sync destination directory from staged source.
 *
 * For 'commands' kind: iterate *.md files in destDir, remove if not in staged set.
 * For 'agents' kind: same, but only remove files starting with 'gsd-' prefix.
 * For 'skills' kind: iterate directories in destDir matching kind.prefix; add missing
 *   by copying recursively; remove dirs not in staged set. Preserves dirs not matching
 *   the prefix (user-owned skills). Pruning is delegated to pruneSkillDirs().
 *
 * For Hermes (empty prefix): uses manifest membership to discriminate GSD-owned vs
 * user-owned dirs. GSD-owned = stem in manifest; removal targets = in manifest AND
 * not in staged set. User-owned (not in manifest) are always preserved.
 */
function _syncGsdDir(stagedDir: string, destDir: string, kind: ArtifactKind | string, manifest?: Map<string, string[]>, runtime?: string): void {
  if (!fs.existsSync(stagedDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  // Normalize: allow legacy string context for backward-compat with internal callers
  const kindName = (typeof kind === 'string') ? kind : kind.kind;
  const kindPrefix = (typeof kind === 'object' && kind !== null) ? kind.prefix : 'gsd-';

  // #1575 / #2103: agent files are renamed .md -> <agentFileExtension> at copy
  // time when the runtime's descriptor declares hostBehaviors.agentFileExtension
  // (e.g. copilot's '.agent.md'), mirroring install-engine.cts's staged-copy
  // loop (`_copyStaged`) — ONE descriptor read shared by both surfaces instead
  // of a duplicated hardcoded `runtime === 'copilot'` literal. Other runtimes
  // (no agentFileExtension declared) keep the staged filename verbatim.
  const _agentExt = runtime ? runtimeArtifactConversion.agentFileExtensionFor(runtime) : undefined;
  const isRenamedAgents = !!_agentExt && kindName === 'agents';

  if (kindName === 'skills') {
    // Skills kind: work with directories, not files.
    // Each staged entry is a directory named ${prefix}${stem}.
    const stagedDirs = new Set<string>(
      fs.readdirSync(stagedDir).filter(entry => {
        return fs.statSync(path.join(stagedDir, entry)).isDirectory();
      })
    );

    // Copy missing dirs from staged to dest (always overwrite to ensure content is current)
    for (const dirName of stagedDirs) {
      const destSubDir = path.join(destDir, dirName);
      fs.cpSync(path.join(stagedDir, dirName), destSubDir, { recursive: true });
    }

    // Prune GSD-owned dirs that are no longer in the staged set.
    // pruneSkillDirs() is the single point of truth for this logic.
    pruneSkillDirs(destDir, stagedDirs, kindPrefix, manifest);
  } else {
    // commands / agents kind: mirror installRuntimeArtifacts (_copyStaged /
    // _removeGsdEntries in bin/install.js) so surface produces the SAME files as a
    // fresh install (#816). Flat command dirs (opencode/cursor/augment/kilo) take
    // the gsd- prefix on copy; namespaced command dirs (commands/gsd) and agents
    // keep their staged names. Copying staged names verbatim previously diverged
    // from install and orphaned the installed gsd-*.md files, and the unscoped
    // prune deleted user-owned command files.
    //
    // NOTE: the destName rule below intentionally mirrors bin/install.js
    // `_copyStaged` (the `namespacedByDir` decision). Keep them in sync.
    const destLast = (typeof kind === 'object' && kind !== null && kind.destSubpath)
      ? path.basename(kind.destSubpath)
      : '';
    const prefixStem = kindPrefix ? kindPrefix.replace(/-$/, '') : '';
    const namespacedByDir = kindName === 'commands' && destLast === prefixStem;

    const stagedFiles = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    const stagedDestNames = new Set<string>();
    for (const file of stagedFiles) {
      const destName = isRenamedAgents
        ? file.replace(/\.md$/, _agentExt)
        : (kindName === 'agents' || namespacedByDir)
          ? file
          : `${kindPrefix}${file.slice(0, -3)}.md`;
      fs.copyFileSync(path.join(stagedDir, file), path.join(destDir, destName));
      stagedDestNames.add(destName);
    }

    // Prune stale GSD-owned files not in the staged set, preserving user-owned files
    // (mirrors install's prefix-scoped _removeGsdEntries):
    //   - agents: only gsd-* are GSD-owned (copilot: gsd-*.agent.md)
    //   - flat command dirs: only `${kindPrefix}`-prefixed are GSD-owned
    //   - namespaced command dirs: the whole dir is GSD-owned
    const shouldPruneAgents = !(kindName === 'agents' && (!manifest || manifest.size === 0));
    if (shouldPruneAgents) {
      for (const file of fs.readdirSync(destDir).filter(f => f.endsWith('.md'))) {
        if (kindName === 'agents' && !file.startsWith('gsd-')) continue;
        if (kindName === 'commands' && !namespacedByDir && kindPrefix && !file.startsWith(kindPrefix)) continue;
        if (!stagedDestNames.has(file)) {
          try { fs.unlinkSync(path.join(destDir, file)); } catch { /* ignore */ }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List the currently enabled and disabled skills with token cost.
 *
 * Token cost = sum of description lengths ÷ 4 (mirrors audit script).
 * Descriptions are read from the install source (findInstallSourceRoot).
 */
function listSurface(runtimeConfigDir: string, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>, registry?: { capabilityClusters?: Record<string, string[]>; profileMembership?: Record<string, { tier: string; profiles: string[] }> }): { enabled: string[]; disabled: string[]; tokenCost: number } {
  const skillManifest = normalizeSkillManifest(runtimeConfigDir, manifest);
  const resolved = resolveSurface(runtimeConfigDir, skillManifest, clusterMap, registry);

  // All known stems from manifest (exclude _calls_agents_ meta keys)
  const allStems: string[] = [];
  for (const [key] of skillManifest) {
    if (!key.startsWith('_calls_agents_')) allStems.push(key);
  }

  const enabledSet = resolved.skills instanceof Set ? resolved.skills : new Set(allStems);

  const enabled = allStems.filter(s => enabledSet.has(s)).sort();
  const disabled = allStems.filter(s => !enabledSet.has(s)).sort();

  // Compute token cost by reading descriptions from the install source
  const srcCommandsDir = findInstallSourceRoot(runtimeConfigDir);
  let tokenCost = 0;
  for (const stem of enabled) {
    const filePath = path.join(srcCommandsDir, `${stem}.md`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        tokenCost += Math.ceil(descMatch[1].trim().length / 4);
      }
    } catch { /* ignore */ }
  }

  return { enabled, disabled, tokenCost };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  readSurface,
  writeSurface,
  resolveSurface,
  applySurface,
  listSurface,
  // Exported for testing and for callers that need stand-alone pruning
  pruneSkillDirs,
  _syncGsdDir,
};
