#!/usr/bin/env node
'use strict';

/**
 * gen-capability-registry.cjs — generates gsd-core/bin/lib/capability-registry.cjs
 * from every capabilities/<id>/capability.json declaration.
 *
 * Usage:
 *   node scripts/gen-capability-registry.cjs              # print to stdout
 *   node scripts/gen-capability-registry.cjs --write      # write capability-registry.cjs
 *   node scripts/gen-capability-registry.cjs --check      # exit 1 if committed registry is stale
 *
 * ADR-894 phase 3a-impl. Validates each capability against the schema, enforces
 * cross-capability invariants, materializes hook ordering, and emits a role-
 * partitioned CommonJS registry module.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES_DIR = path.join(ROOT, 'capabilities');
const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const CONFIG_SCHEMA_PATH = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');

// ─── Loop Host Contract ───────────────────────────────────────────────────────
//
// Generated from workflow markers by scripts/gen-loop-host-contract.cjs (ADR-894 §3).
// Require the committed gsd-core/bin/lib/loop-host-contract.cjs artifact so the
// registry generator and the loop-host-contract generator share one source of truth.
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

// Wired-points helper — tells us which points actually have render-hooks call sites.
const { getWiredLoopPoints } = require('./gen-loop-host-contract.cjs');

// Capability validator — shared runtime-callable module extracted per ADR-1244 D2.
const capValidator = require('../gsd-core/bin/lib/capability-validator.cjs');
// Destructure only what the generator's own function bodies reference directly.
// Everything else is re-exported from capValidator in module.exports below.
const {
  POINT_ORDER,
  HOST_ARTIFACT_EARLIEST_POINT_IDX,
  VALID_LOOP_POINTS,
  POINT_TO_CONTRACT,
  VALID_CONFIG_SLICE_TYPES,
  VALID_TIERS,
  SEMVER_RE,
  SEMVER_RANGE_RE,
  SHA512_INTEGRITY_RE,
  VALID_CONVERTER_NAMES,
  VALID_CONFIG_HOME_KINDS,
  VALID_COMMAND_STYLES,
  VALID_HOOKS_SURFACES,
  VALID_HOOK_EVENTS,
  VALID_SANDBOX_TIERS,
  VALID_ARTIFACT_KIND_NAMES,
  VALID_ARTIFACT_NESTINGS,
  VALID_INSTALL_SURFACES,
  VALID_PERMISSION_WRITERS,
  VALID_EXTENDED_HOOK_EVENTS,
  INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES,
  INSTALL_SURFACE_TO_CONFIG_FORMAT,
  SCHEMA_VERSION,
  validateVersionEnvelope,
  validateCapability,
  validateCommandEntry,
  validateRuntimeCompat,
  validateConfigHome,
  validateArtifactKindEntry,
  validateArtifactLayout,
  validateRuntimeBody,
  collectReviewerWarnings,
  materializeHookFragments,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  computeRequiresClosure,
  topoSortSteps,
  topoSortContributions,
  validateHooksWired,
  validateConfigSliceEntry,
  classifyCrossErrors,
  runConfigFormatParityGate,
} = capValidator;

// ─── Central config-schema loader ────────────────────────────────────────────

/**
 * Loads the set of keys from the central config-schema manifest.
 * Returns a Set<string>. Used for collision detection.
 *
 * Contract:
 *   - ENOENT (file not found): returns empty Set silently — legitimate absent case.
 *   - Any other read error OR JSON parse error: writes a prominent warning to stderr
 *     naming the schema path and the underlying error, then throws ExitError(1).
 *     A parse error clearly states the schema is broken (not merely absent).
 *
 * @param {string} [schemaPath]  Path to the config-schema manifest. Defaults to
 *                               CONFIG_SCHEMA_PATH (the real production path).
 *                               Overridable for unit testing with fixture paths.
 * @returns {Set<string>}
 */
function loadCentralConfigKeys(schemaPath = CONFIG_SCHEMA_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return new Set();
    }
    process.stderr.write(
      '  ERROR  Failed to read config-schema manifest at ' + schemaPath + ': ' + err.message + '\n',
    );
    throw new ExitError(1, 'could not read config-schema manifest');
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      '  ERROR  Config-schema manifest at ' + schemaPath + ' is broken (JSON parse error): ' + err.message + '\n',
    );
    throw new ExitError(1, 'config-schema manifest JSON is malformed');
  }

  return new Set(Array.isArray(manifest.validKeys) ? manifest.validKeys : []);
}

/**
 * Loads the central config-schema's DYNAMIC key patterns (#2797).
 *
 * `loadCentralConfigKeys` above reads `validKeys` only, so a federated key
 * claimed by a central *pattern* was invisible to the exclusivity check. That is
 * not a cosmetic gap: `isCentralConfigKey` consults these same patterns, and
 * `mergeFederatedConfig` skips every key for which it returns true — so an
 * overlapping slice is inert while the build stays green.
 *
 * The patterns are read from the SAME manifest the runtime reads and compiled
 * with the same `source`, rather than re-implementing a matcher here, so the two
 * cannot drift.
 *
 * Failure contract MATCHES `loadCentralConfigKeys` above deliberately — the two
 * read the same file and must not disagree about what a broken one means:
 *   - ENOENT → empty list. Legitimately absent.
 *   - Any other read error, or a JSON parse error → prominent stderr + throw.
 *
 * An earlier revision swallowed the parse error and returned []. That is
 * fail-OPEN on the gate this function exists to feed: with zero patterns,
 * `validateCrossCapability`'s pattern-collision check silently passes and an
 * inert federated slice ships green. It was masked in the one production call
 * site only because `loadCentralConfigKeys` runs first against the same path and
 * throws — a coincidence of ordering, not a guarantee, and this function is
 * exported and called standalone.
 *
 * A single unparseable PATTERN is still skipped rather than fatal: that is a
 * per-entry defect the central schema's own tests own, and skipping one pattern
 * degrades to "checked less" rather than blocking every build.
 */
function loadCentralConfigPatterns(schemaPath = CONFIG_SCHEMA_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    process.stderr.write(
      '  ERROR  Failed to read config-schema manifest at ' + schemaPath + ': ' + err.message + '\n',
    );
    throw new ExitError(1, 'could not read config-schema manifest');
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      '  ERROR  Config-schema manifest at ' + schemaPath + ' is broken (JSON parse error): ' + err.message + '\n',
    );
    throw new ExitError(1, 'config-schema manifest JSON is malformed');
  }
  const declared = Array.isArray(manifest.dynamicKeyPatterns) ? manifest.dynamicKeyPatterns : [];
  const out = [];
  for (const entry of declared) {
    const src = entry && typeof entry.source === 'string' ? entry.source : null;
    if (!src) continue;
    try {
      out.push(new RegExp(src));
    } catch {
      // Unparseable pattern — the central schema's own tests own that failure.
    }
  }
  return out;
}

// ─── ADR-857 Phase 4a: Derived views ─────────────────────────────────────────

// (Config-slice validation, per-capability validators, contract validators,
// cross-capability validators, topo-sort helpers, and classifyCrossErrors have
// been moved to gsd-core/bin/lib/capability-validator.cjs per ADR-1244 D2.)

const INSTALL_PROFILES_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs');
const CLUSTERS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'clusters.cjs');

let _installProfilesMod = null;
let _clustersMod = null;

function getInstallProfiles() {
  if (!_installProfilesMod) _installProfilesMod = require(INSTALL_PROFILES_PATH);
  return _installProfilesMod;
}

function getClusters() {
  if (!_clustersMod) _clustersMod = require(CLUSTERS_PATH);
  return _clustersMod;
}

/**
 * Derive capabilityClusters: { <capId>: [<skill stems>] }
 * Each capability's own skills array, sorted for determinism.
 *
 * FIX 3: scope rule = "capabilities that own skills" (non-empty skills array).
 * Both capabilityClusters and profileMembership use this same predicate so a
 * future non-feature role carrying skills is treated identically in both, and a
 * feature cap with no skills appears in neither.
 *
 * @param {Map<string, object>} capMap
 * @returns {object}  Object.create(null) — prototype-pollution safe
 */
function deriveCapabilityClusters(capMap) {
  const result = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    // FIX 3: include any cap that owns skills (non-empty skills array), regardless of role
    if (!Array.isArray(cap.skills) || cap.skills.length === 0) continue;
    // Sort for determinism
    const sorted = [...cap.skills].sort();
    result[capId] = sorted;
  }
  return result;
}

/**
 * Derive profileMembership: { <capId>: { tier: <t>, profiles: [<names>] } }
 * profiles = suffix of PROFILE_RANK starting at the capability's tier index.
 *   tier 'core'     → ['core', 'standard', 'full']
 *   tier 'standard' → ['standard', 'full']
 *   tier 'full'     → ['full']
 *
 * FIX 3: scope rule = "capabilities that own skills" (non-empty skills array),
 * consistent with deriveCapabilityClusters. Both derived views cover the same set.
 *
 * FIX 5: tierIdx === -1 means VALID_TIERS and PROFILE_RANK have drifted; throw
 * loudly instead of silently producing ['full'] for the affected capability.
 *
 * @param {Map<string, object>} capMap
 * @returns {object}  Object.create(null) — prototype-pollution safe
 */
function deriveProfileMembership(capMap) {
  const { PROFILE_RANK } = getInstallProfiles();
  const result = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (!VALID_TIERS.has(cap.tier)) continue;
    // FIX 3: consistent scope — only capabilities that own skills (non-empty skills array)
    if (!Array.isArray(cap.skills) || cap.skills.length === 0) continue;
    const tierIdx = PROFILE_RANK.indexOf(cap.tier);
    // FIX 5: throw loudly on VALID_TIERS/PROFILE_RANK drift (was silent continue)
    if (tierIdx === -1) {
      throw new Error(
        'deriveProfileMembership: capability "' + capId + '" tier "' + cap.tier +
        '" is in VALID_TIERS but not in PROFILE_RANK — VALID_TIERS/PROFILE_RANK drift detected',
      );
    }
    const profiles = PROFILE_RANK.slice(tierIdx);
    result[capId] = { tier: cap.tier, profiles: [...profiles] };
  }
  return result;
}

/**
 * Run consistency gates:
 * - HARD: for each capId that matches a CLUSTERS key, derived skills must match
 *   the hand-authored CLUSTERS[capId] set (order-insensitive). Throws on mismatch.
 * - SOFT: for each capability, for each skill not yet in all non-full profiles it
 *   belongs to (closure-resolved), emit ONE pending-reconciliation warning listing
 *   the missing profiles together. Warnings are collected and returned — NOT thrown.
 *
 * FIX 1: load the REAL skills manifest (same as bin/install.js) so resolveProfile
 * expands requires:-closure. Loaded once and reused across all capabilities.
 *
 * FIX 3: iterate capabilityClusters (which already covers "capabilities that own
 * skills") rather than profileMembership, so both derived views share one scope.
 *
 * FIX 4: one warning per (capability, skill) gap, listing all missing non-full
 * profiles together, instead of one warning per (capability, skill, profile).
 *
 * @param {object} capabilityClusters   From deriveCapabilityClusters()
 * @param {object} profileMembership    From deriveProfileMembership()
 * @param {Map<string, object>} capMap  Original capMap for skill lists
 * @returns {string[]}  Array of pending-reconciliation warning strings
 */
function runConsistencyGate(capabilityClusters, profileMembership, capMap) {
  const { CLUSTERS: clustersObj } = getClusters();
  const { resolveProfile, loadSkillsManifest } = getInstallProfiles();

  // ── HARD gate: cluster set comparison ──────────────────────────────────────
  for (const capId of Object.keys(capabilityClusters)) {
    // S2b: inline literal guard (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    // Only check if a CLUSTERS entry with the same name exists
    if (!Object.prototype.hasOwnProperty.call(clustersObj, capId)) continue;
    const derivedSet = new Set(capabilityClusters[capId]);
    const handAuthored = clustersObj[capId];
    const handAuthoredSet = new Set(handAuthored);
    // Compare sets (order-insensitive)
    let mismatch = derivedSet.size !== handAuthoredSet.size;
    if (!mismatch) {
      for (const s of derivedSet) {
        if (!handAuthoredSet.has(s)) { mismatch = true; break; }
      }
    }
    if (mismatch) {
      throw new Error(
        'capability-cluster consistency gate FAILED for capId "' + capId + '":\n' +
        '  derived set:      [' + [...derivedSet].sort().join(', ') + ']\n' +
        '  hand-authored set: [' + [...handAuthoredSet].sort().join(', ') + ']\n' +
        'The capability\'s skills array must match the hand-authored CLUSTERS["' + capId + '"] at cutover.',
      );
    }
  }

  // ── SOFT gate: profile reconciliation warnings ─────────────────────────────

  // FIX 1: load the REAL skills manifest once (same path as bin/install.js uses),
  // so resolveProfile expands requires:-closure and the effective set is accurate.
  const commandsGsdDir = path.join(ROOT, 'commands', 'gsd');
  const skillsManifest = loadSkillsManifest(commandsGsdDir);

  // FIX 1: resolve each profile's effective set once and cache — don't reload per-capability.
  const profileEffectiveSetCache = Object.create(null);
  function getEffectiveSet(profileName) {
    if (profileName in profileEffectiveSetCache) return profileEffectiveSetCache[profileName];
    const resolved = resolveProfile({ modes: [profileName], manifest: skillsManifest });
    const effectiveSet = resolved.skills === '*' ? null : resolved.skills;
    profileEffectiveSetCache[profileName] = effectiveSet;
    return effectiveSet;
  }

  const warnings = [];

  // FIX 3: iterate capabilityClusters (same set as profileMembership after FIX 3 scoping).
  for (const capId of Object.keys(capabilityClusters)) {
    // S2b: inline literal guard (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    const membership = profileMembership[capId];
    if (!membership) continue; // no profile membership (e.g. cap has skills but invalid tier)
    const cap = capMap.get(capId);
    if (!cap || !Array.isArray(cap.skills)) continue;

    // Collect the non-full profiles for this capability
    const nonFullProfiles = membership.profiles.filter((p) => p !== 'full');

    // FIX 4: one warning per (capability, skill) gap — list all missing profiles together
    for (const skill of cap.skills) {
      // S2b: inline literal guard (CodeQL barrier)
      if (skill === '__proto__' || skill === 'constructor' || skill === 'prototype') continue;

      const missingProfiles = [];
      for (const profileName of nonFullProfiles) {
        const effectiveSet = getEffectiveSet(profileName);
        if (effectiveSet === null) continue; // profile resolved to full (unexpected but safe)
        if (!effectiveSet.has(skill)) {
          missingProfiles.push(profileName);
        }
      }

      if (missingProfiles.length > 0) {
        warnings.push(
          '⚠ pending-reconciliation: capability \'' + capId + '\' (tier ' + membership.tier + ')' +
          ' skill \'' + skill + '\' not yet in hand-authored profile(s): <' + missingProfiles.join(', ') +
          '>; add at cutover',
        );
      }
    }
  }

  return warnings;
}


/**
 * Read + validate all capabilities/<id>/capability.json files.
 * Returns { capMap, errors } where capMap is Map<id, cap>.
 *
 * @param {Set<string>} [centralKeys]   Keys in central config-schema for collision detection.
 *   If omitted, reads from disk. Pass new Set() to skip central-collision checks
 *   (used during 3a-impl while migration is in-progress).
 * @param {string} [capabilitiesDir]    Override capabilities dir (for testing with fixtures).
 */
function loadAndValidate(centralKeys, capabilitiesDir, centralPatterns) {
  const resolvedCentralKeys = centralKeys !== undefined ? centralKeys : loadCentralConfigKeys();
  // #2797: patterns default to the real manifest unless a caller passes its own
  // (tests pass [] to isolate the exact-key path).
  const resolvedCentralPatterns = centralPatterns !== undefined ? centralPatterns : loadCentralConfigPatterns();
  const resolvedCapDir = capabilitiesDir !== undefined ? capabilitiesDir : CAPABILITIES_DIR;
  const errors = [];
  const capMap = new Map();
  // ADR-2782 D4 — non-fatal diagnostics (e.g. an unknown field inside a reviewer
  // body). These NEVER fail the build; they surface on stderr so a forward-built
  // manifest degrades visibly instead of silently.
  const warnings = [];

  if (!fs.existsSync(resolvedCapDir)) {
    return { capMap, errors, warnings };
  }

  // Compute wired points ONCE before iterating capabilities so the filesystem
  // scan is not repeated per-capability. ROOT is the repo root (defined at top of file).
  const wiredSet = getWiredLoopPoints(ROOT);

  const folderEntries = fs.readdirSync(resolvedCapDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const folderId of folderEntries) {
    const capPath = path.join(resolvedCapDir, folderId, 'capability.json');
    if (!fs.existsSync(capPath)) continue;

    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    } catch (err) {
      errors.push(folderId + '/capability.json: JSON parse error: ' + String(err.message));
      continue;
    }

    // Collected BEFORE the error short-circuit below so a manifest that is both
    // forward-built and invalid still reports why it looked unfamiliar.
    for (const w of collectReviewerWarnings(cap)) warnings.push(folderId + '/capability.json: ' + w);

    const capErrors = validateCapability(cap, folderId);
    if (capErrors.length > 0) {
      for (const e of capErrors) errors.push(folderId + '/capability.json: ' + e);
      continue; // skip cross-validation if basic schema fails
    }

    const contractErrors = validateAgainstContract(cap, cap.id);
    if (contractErrors.length > 0) {
      for (const e of contractErrors) errors.push(folderId + '/capability.json: ' + e);
      // Fix #6: do NOT add contract-invalid caps to capMap — validateCrossCapability should
      // only see fully-valid capabilities so its invariants are meaningful.
      continue;
    }

    // Gen-time wired guard: reject hooks that declare a valid point with no call site.
    const wiredErrors = validateHooksWired(cap, wiredSet);
    if (wiredErrors.length > 0) {
      for (const e of wiredErrors) errors.push(folderId + '/capability.json: ' + e);
      continue;
    }

    const fragmentErrors = materializeHookFragments(cap, path.dirname(capPath));
    if (fragmentErrors.length > 0) {
      for (const e of fragmentErrors) errors.push(folderId + '/capability.json: ' + e);
      continue;
    }

    capMap.set(cap.id, cap);
  }

  // Cross-capability invariants — capMap contains only fully-valid capabilities at this point.
  const crossErrors = validateCrossCapability(capMap, resolvedCentralKeys, resolvedCentralPatterns);
  errors.push(...crossErrors);

  // C2: Global consumes-satisfiability — runs after capMap is fully built so cross-capability
  // produces are visible. A capability with consumes errors is kept in capMap (it passed per-cap
  // validation) but the errors are surfaced so the build fails.
  const consumesErrors = validateConsumesGlobal(capMap);
  errors.push(...consumesErrors);

  return { capMap, errors, warnings };
}

/**
 * Build the registry object from a validated capMap.
 *
 * @param {Map<string, object>} capMap
 */
function buildRegistry(capMap) {
  // S2b: Use Object.create(null) for all accumulator maps so prototype-pollution
  // can't touch Object.prototype even if a reserved name slips through validation.
  const capabilities = Object.create(null);
  const bySkill = Object.create(null);
  const byAgent = Object.create(null);
  const byLoopPoint = Object.create(null);
  const configKeys = Object.create(null);
  const configSchema = Object.create(null);
  const runtimes = Object.create(null);

  // Initialize byLoopPoint for all valid points
  for (const point of VALID_LOOP_POINTS) {
    byLoopPoint[point] = { steps: [], contributions: [], gates: [] };
  }

  // Phase 1: collect per-point entries grouped by point
  const pointSteps = new Map(); // point → [{ capId, step }]
  const pointContribs = new Map(); // point → [{ capId, contrib }]
  const pointGates = new Map(); // point → [{ capId, gate }]

  for (const point of VALID_LOOP_POINTS) {
    pointSteps.set(point, []);
    pointContribs.set(point, []);
    pointGates.set(point, []);
  }

  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    capabilities[capId] = cap;

    // Federated config slice — harvested from ANY role that declares one.
    //
    // ADR-2782 D1/D9: this loop was nested inside the `role === 'feature'` branch,
    // so a `role: "runtime"` capability's `config` was read by nothing and dropped
    // in silence — the actual reason reviewer config keys are stranded in the
    // central schema. (The often-cited reason, that the runtime body forbids
    // feature-only fields, does not apply: `config` is NOT in
    // FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME.) Owning a config slice is a property of
    // DECLARING one, not of being a feature. Verified inert at introduction — no
    // shipped capability declares `config` on a non-feature role — so this changes
    // no existing key; it stops a latent silent drop and unblocks Phase 4 (#2797).
    for (const key of Object.keys(cap.config || {})) {
      // S2b: inline literal guard at each write site (CodeQL barrier)
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      configKeys[key] = capId;

      // Build configSchema entry — validate the slice first (throw on violation)
      const slice = (cap.config || {})[key];
      const sliceErrors = validateConfigSliceEntry(capId, key, slice);
      if (sliceErrors.length > 0) {
        throw new Error(
          'configSchema validation failed during registry build:\n' +
          sliceErrors.map((e) => '  ' + e).join('\n'),
        );
      }
      // S2b: inline literal guard for configSchema write site
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        configSchema[key] = {
          owner: capId,
          type: slice.type,
          default: slice.default,
          description: slice.description,
        };
        // Preserve values array for enum types if present
        if (slice.type === 'enum' && Array.isArray(slice.values)) {
          configSchema[key].values = slice.values;
        }
      }
    }

    if (cap.role === 'feature') {
      for (const skill of (cap.skills || [])) {
        // S2b: inline literal guard at each write site (CodeQL barrier)
        if (skill === '__proto__' || skill === 'constructor' || skill === 'prototype') continue;
        bySkill[skill] = capId;
      }
      for (const agent of (cap.agents || [])) {
        // S2b: inline literal guard at each write site (CodeQL barrier)
        if (agent === '__proto__' || agent === 'constructor' || agent === 'prototype') continue;
        byAgent[agent] = capId;
      }

      for (const step of (cap.steps || [])) {
        if (VALID_LOOP_POINTS.has(step.point)) {
          pointSteps.get(step.point).push({ capId, step });
        }
      }
      for (const contrib of (cap.contributions || [])) {
        if (VALID_LOOP_POINTS.has(contrib.point)) {
          // Group contributions by into, then cap-id order
          pointContribs.get(contrib.point).push({ capId, contrib });
        }
      }
      for (const gate of (cap.gates || [])) {
        if (VALID_LOOP_POINTS.has(gate.point)) {
          pointGates.get(gate.point).push({ capId, gate });
        }
      }
    } else if (cap.role === 'runtime') {
      // S2b: inline literal guard at each write site (CodeQL barrier) — capId already guarded above
      runtimes[capId] = cap;
    }
  }

  // Phase 2: materialize ordering
  for (const point of VALID_LOOP_POINTS) {
    // Steps: topological sort by produces/consumes, cap-id tiebreak
    const sortedSteps = topoSortSteps(pointSteps.get(point));
    byLoopPoint[point].steps = sortedSteps.map((e) => ({
      capId: e.capId,
      ...e.step,
    }));

    // Contributions: topological sort by produces/consumes, cap-id tiebreak
    const sortedContribs = topoSortContributions(pointContribs.get(point));
    byLoopPoint[point].contributions = sortedContribs.map((e) => ({
      capId: e.capId,
      ...e.contrib,
    }));

    // Gates: as declared (stable by capId order)
    const gates = pointGates.get(point);
    gates.sort((a, b) => a.capId.localeCompare(b.capId));
    byLoopPoint[point].gates = gates.map((e) => ({
      capId: e.capId,
      ...e.gate,
    }));
  }

  // ── ADR-959: commandFamilies index ─────────────────────────────────────────
  // family → { capId, module, router }
  // Built from all feature capabilities' commands arrays.
  const commandFamilies = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (cap.role !== 'feature' || !Array.isArray(cap.commands)) continue;
    for (const cmd of cap.commands) {
      if (typeof cmd.family !== 'string' || cmd.family.length === 0) continue;
      // S2b: inline literal guard at family key write site (CodeQL barrier)
      if (cmd.family === '__proto__' || cmd.family === 'constructor' || cmd.family === 'prototype') continue;
      if (typeof cmd.module !== 'string' || cmd.module.length === 0) continue;
      if (typeof cmd.router !== 'string' || cmd.router.length === 0) continue;
      commandFamilies[cmd.family] = { capId, module: cmd.module, router: cmd.router };
    }
  }

  // ── ADR-857 phase 4a: derived views ────────────────────────────────────────
  const capabilityClusters = deriveCapabilityClusters(capMap);
  const profileMembership = deriveProfileMembership(capMap);
  // runConsistencyGate: hard gate throws on mismatch; returns soft warning strings.
  // Warnings are returned in the registry object so callers can emit them to stderr
  // without affecting the serialized file content (determinism gate stays clean).
  const reconciliationWarnings = runConsistencyGate(capabilityClusters, profileMembership, capMap);

  // ADR-857 phase 5e: configFormat ↔ installSurface parity gate.
  // HARD gate — throws on mismatch; SOFT skip if adapter module not loadable.
  runConfigFormatParityGate(capMap);

  return {
    version: SCHEMA_VERSION,
    capabilities,
    bySkill,
    byAgent,
    byLoopPoint,
    configKeys,
    configSchema,
    runtimes,
    commandFamilies,
    capabilityClusters,
    profileMembership,
    // warnings are NOT serialized — returned only for caller consumption via stderr
    _reconciliationWarnings: reconciliationWarnings,
  };
}

// ─── Registry serialization ───────────────────────────────────────────────────

/**
 * Serialize the registry to a CommonJS module string.
 *
 * @param {object} registry   The registry object from buildRegistry()
 * @param {Map<string, object>} capMap  Used for requiresClosure()
 */
function serializeRegistry(registry, capMap) {
  const lines = [];

  lines.push("'use strict';");
  lines.push('');
  lines.push('/**');
  lines.push(' * capability-registry.cjs — generated by scripts/gen-capability-registry.cjs');
  lines.push(' * DO NOT EDIT BY HAND. Run: node scripts/gen-capability-registry.cjs --write');
  lines.push(' * ADR-894 §5 — role-partitioned Capability Registry.');
  lines.push(' */');
  lines.push('');

  // Serialize each section as a variable to keep the file readable
  lines.push('const capabilities = ' + JSON.stringify(registry.capabilities, null, 2) + ';');
  lines.push('');
  lines.push('const bySkill = ' + JSON.stringify(registry.bySkill, null, 2) + ';');
  lines.push('');
  lines.push('const byAgent = ' + JSON.stringify(registry.byAgent, null, 2) + ';');
  lines.push('');
  lines.push('const byLoopPoint = ' + JSON.stringify(registry.byLoopPoint, null, 2) + ';');
  lines.push('');
  lines.push('const configKeys = ' + JSON.stringify(registry.configKeys, null, 2) + ';');
  lines.push('');
  lines.push('const configSchema = ' + JSON.stringify(registry.configSchema, null, 2) + ';');
  lines.push('');
  lines.push('const runtimes = ' + JSON.stringify(registry.runtimes, null, 2) + ';');
  lines.push('');

  // ADR-959: commandFamilies index — sort family keys for determinism.
  const sortedCommandFamilies = Object.create(null);
  const commandFamilyKeys = Object.keys(registry.commandFamilies || {}).sort();
  for (const family of commandFamilyKeys) {
    // S2b: inline literal guard at write site (CodeQL barrier)
    if (family === '__proto__' || family === 'constructor' || family === 'prototype') continue;
    sortedCommandFamilies[family] = registry.commandFamilies[family];
  }
  lines.push('const commandFamilies = ' + JSON.stringify(sortedCommandFamilies, null, 2) + ';');
  lines.push('');

  // ADR-857 phase 4a: derived views — globally sorted capIds for determinism.
  // FIX 2: collect ALL capIds across both views and sort globally so feature + runtime
  // capIds interleave correctly when both are present (phase 5 readiness).
  const allClusterCapIds = new Set(Object.keys(registry.capabilityClusters));
  const allProfileCapIds = new Set(Object.keys(registry.profileMembership));
  const allCapIds = new Set([...allClusterCapIds, ...allProfileCapIds]);
  // FIX 5: inline literal guard at write sites (CodeQL barrier)
  allCapIds.delete('__proto__');
  allCapIds.delete('constructor');
  allCapIds.delete('prototype');
  const globalSortedCapIds = [...allCapIds].sort();

  const sortedCapabilityClusters = Object.create(null);
  for (const capId of globalSortedCapIds) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (registry.capabilityClusters[capId] !== undefined) {
      sortedCapabilityClusters[capId] = registry.capabilityClusters[capId];
    }
  }
  lines.push('const capabilityClusters = ' + JSON.stringify(sortedCapabilityClusters, null, 2) + ';');
  lines.push('');

  const sortedProfileMembership = Object.create(null);
  for (const capId of globalSortedCapIds) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (registry.profileMembership[capId] !== undefined) {
      sortedProfileMembership[capId] = registry.profileMembership[capId];
    }
  }
  lines.push('const profileMembership = ' + JSON.stringify(sortedProfileMembership, null, 2) + ';');
  lines.push('');

  // Inline the requires graph so requiresClosure() works without re-reading files
  const requiresGraph = {};
  for (const [id, cap] of capMap) {
    requiresGraph[id] = Array.isArray(cap.requires) ? cap.requires : [];
  }
  lines.push('const _requiresGraph = ' + JSON.stringify(requiresGraph, null, 2) + ';');
  lines.push('');

  // requiresClosure function
  lines.push('function requiresClosure(id) {');
  lines.push('  const visited = new Set();');
  lines.push('  const queue = [id];');
  lines.push('  while (queue.length > 0) {');
  lines.push('    const current = queue.shift();');
  lines.push('    const reqs = _requiresGraph[current] || [];');
  lines.push('    for (const req of reqs) {');
  lines.push('      if (!visited.has(req)) {');
  lines.push('        visited.add(req);');
  lines.push('        queue.push(req);');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('  return visited;');
  lines.push('}');
  lines.push('');

  lines.push('module.exports = {');
  lines.push("  version: '" + registry.version + "',");
  lines.push('  capabilities,');
  lines.push('  bySkill,');
  lines.push('  byAgent,');
  lines.push('  byLoopPoint,');
  lines.push('  configKeys,');
  lines.push('  configSchema,');
  lines.push('  runtimes,');
  lines.push('  commandFamilies,');
  lines.push('  capabilityClusters,');
  lines.push('  profileMembership,');
  lines.push('  requiresClosure,');
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

// ─── --check diff helper ──────────────────────────────────────────────────────

/**
 * Compare committed registry with live registry (for --check).
 * Strips the generated comment line for comparison.
 */
function stripGeneratedComment(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes('generated by scripts/gen-capability-registry.cjs'))
    .join('\n');
}

/**
 * Normalize line endings to LF.
 * The generator always writes LF, but Windows git (autocrlf) checks out committed files with
 * CRLF. The --check comparison must be line-ending-agnostic so it only fails on REAL content
 * differences, not on checkout-introduced whitespace differences.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeLineEndings(content) {
  return content.replace(/\r/g, '');
}

// ─── Main ─────────────────────────────────────────────────────────────────────


function main() {
  const flag = process.argv[2];

  if (flag === '--check') {
    // Fix #3: read the REAL central config keys so collision detection fires and is visible.
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors, warnings } = loadAndValidate(centralKeys);

    // ADR-2782 D4 — non-fatal manifest diagnostics. Emitted BEFORE the hard-error
    // exit so a forward-built manifest still explains itself on a failing build.
    for (const w of warnings) process.stderr.write(w + '\n');

    // Separate pending-migration warnings from hard errors
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed (' + hardErrors.length + ' error(s))');
    }

    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    // (they do NOT affect the generated file content, so --check stays clean)
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    const live = serializeRegistry(registry, capMap);

    if (!fs.existsSync(REGISTRY_PATH)) {
      process.stderr.write(
        'gsd-core/bin/lib/capability-registry.cjs does not exist. Run:\n' +
        '  node scripts/gen-capability-registry.cjs --write\n',
      );
      throw new ExitError(1);
    }

    const committed = fs.readFileSync(REGISTRY_PATH, 'utf8');
    if (normalizeLineEndings(stripGeneratedComment(committed)) !== normalizeLineEndings(stripGeneratedComment(live))) {
      process.stderr.write(
        'gsd-core/bin/lib/capability-registry.cjs is stale. Run:\n' +
        '  node scripts/gen-capability-registry.cjs --write\n',
      );
      throw new ExitError(1);
    }

    process.stdout.write('gsd-core/bin/lib/capability-registry.cjs is up to date.\n');
  } else if (flag === '--write') {
    // Fix #3: read the REAL central config keys so collision detection fires and is visible.
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors, warnings } = loadAndValidate(centralKeys);

    // ADR-2782 D4 — non-fatal manifest diagnostics. Emitted BEFORE the hard-error
    // exit so a forward-built manifest still explains itself on a failing build.
    for (const w of warnings) process.stderr.write(w + '\n');

    // Separate pending-migration warnings from hard errors
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed — registry not written');
    }

    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    const content = serializeRegistry(registry, capMap);
    // Fix #5: mkdir-p before writing so --write doesn't ENOENT in a fresh worktree.
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, content, 'utf8');
    process.stdout.write('Wrote ' + REGISTRY_PATH + '\n');
  } else {
    // Default: print to stdout — use real central keys for visibility
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors } = loadAndValidate(centralKeys);

    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed');
    }
    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    process.stdout.write(serializeRegistry(registry, capMap) + '\n');
  }
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = {
  validateCapability,
  // ADR-1244 D1: versioned-manifest envelope validation (reused by the runtime overlay, D2)
  validateVersionEnvelope,
  SEMVER_RE,
  SEMVER_RANGE_RE,
  SHA512_INTEGRITY_RE,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  classifyCrossErrors,
  loadCentralConfigKeys,
  loadCentralConfigPatterns,
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  computeRequiresClosure,
  topoSortSteps,
  normalizeLineEndings,
  stripGeneratedComment,
  validateConfigSliceEntry,
  VALID_CONFIG_SLICE_TYPES,
  LOOP_HOST_CONTRACT,
  VALID_LOOP_POINTS,
  POINT_ORDER,
  POINT_TO_CONTRACT,
  HOST_ARTIFACT_EARLIEST_POINT_IDX,
  SCHEMA_VERSION,
  validateHooksWired,
  // ADR-857 phase 4a: derived views + gates
  deriveCapabilityClusters,
  deriveProfileMembership,
  runConsistencyGate,
  // ADR-959: command entry validation
  validateCommandEntry,
  validateRuntimeCompat,
  // ADR-1016 phase 5a: runtime body validators + closed-vocab sets
  validateConfigHome,
  validateArtifactLayout,
  validateArtifactKindEntry,
  VALID_CONFIG_HOME_KINDS,
  VALID_COMMAND_STYLES,
  VALID_HOOKS_SURFACES,
  VALID_HOOK_EVENTS,
  VALID_SANDBOX_TIERS,
  VALID_ARTIFACT_KIND_NAMES,
  VALID_ARTIFACT_NESTINGS,
  // ADR-857 phase 5e: closed ConverterName enum
  VALID_CONVERTER_NAMES,
  // ADR-857 phase 5e: configFormat ↔ installSurface parity gate
  runConfigFormatParityGate,
  INSTALL_SURFACE_TO_CONFIG_FORMAT,
  // ADR-857 phase 5f: cross-field consistency gates
  INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES,
  VALID_INSTALL_SURFACES,
  VALID_EXTENDED_HOOK_EVENTS,
  VALID_PERMISSION_WRITERS,
  validateRuntimeBody,
  // FIX 5 (lazy): PROFILE_RANK and CLUSTERS are loaded on first access via getters
  // so importing the generator on a fresh/unbuilt worktree doesn't fail at module load.
  get PROFILE_RANK() { return getInstallProfiles().PROFILE_RANK; },
  get CLUSTERS() { return getClusters().CLUSTERS; },
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
