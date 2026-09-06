/**
 * Capability Writer — ADR-1213 write-side inverse of capability-state resolver.
 *
 * Exports:
 *   setCapabilityState(cwd, runtimeConfigDir, desired, opts?)
 *     → { capabilities: CapabilityStateEntry[], warnings: string[] }
 *   cmdCapabilitySet(cwd, runtimeConfigDir, capId, options, raw)
 *
 * Projection rules (three axes: install, surface, config):
 *   - enabled axis: mutates .gsd-surface.json via readSurface/writeSurface
 *   - gates axis: mutates .planning/config.json via setConfigValues (batched)
 *   - materialize: optionally calls applySurface to write skill files
 *   - re-resolve: always calls resolveCapabilityRuntimeState for the return value
 *
 * Dependencies (leaf modules only — no circular risk):
 *   - ./io.cjs                 (output, error)
 *   - ./capability-state.cjs   (resolveCapabilityRuntimeState, _resolveManifest, _resolveCommandsGsdDir)
 *   - ./surface.cjs            (readSurface, writeSurface, applySurface)
 *   - ./install-profiles.cjs   (readActiveProfile)
 *   - ./config.cjs             (setConfigValues)
 *   - ./runtime-artifact-layout.cjs (resolveRuntimeArtifactLayout)
 *   - capability-registry.cjs  (loaded at call time)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output: coreOutput } = ioMod;

// ExitError (NOT process.exit) is how every gsd-tools command signals a non-zero exit: runMain
// translates it to process.exitCode so buffered stdout flushes first. Calling process.exit() here
// truncates a just-written --raw JSON payload before the reader sees it (a real silent-output bug).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitMod = require('./cli-exit.cjs');
const { ExitError } = cliExitMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
const { resolveCapabilityRuntimeState, _resolveManifest, _resolveCommandsGsdDir } = capabilityStateMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import surfaceMod = require('./surface.cjs');
const { readSurface, writeSurface, applySurface } = surfaceMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfilesMod = require('./install-profiles.cjs');
const { readActiveProfile } = installProfilesMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configMod = require('./config.cjs');
const { setConfigValues } = configMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import nodefs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import nodepath = require('path');

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookEntry {
  point: string;
  kind: 'step' | 'gate' | 'contribution';
  when: unknown;
  configured: boolean;
  active: boolean;
}

interface CapabilityStateEntry {
  id: string;
  tier: string;
  skills: string[];
  installed: boolean;
  surfaced: boolean;
  enabled: boolean;
  hooks: HookEntry[];
}

interface SurfaceState {
  baseProfile: string;
  disabledClusters: string[];
  explicitAdds: string[];
  explicitRemoves: string[];
}

interface DesiredCapability {
  id: string;
  enabled?: boolean;
  gates?: Record<string, boolean>;
}

interface SetCapabilityStateOptions {
  materialize?: { runtime: string; scope: string; resolveAttribution?: (runtime: string) => string | null | undefined };
}

/**
 * Canonical **mutation-verb result** for the capability-writer seam (ADR-1411 P3 / #1416).
 *
 * Shape: `{ capabilities, warnings, errors }`
 *
 * - `warnings` — advisory messages (the verb still succeeded)
 * - `errors`   — operation-not-applied messages; the write was not performed
 *
 * The shared contract with read-verb shapes is `warnings: string[]`.
 * Mutation verbs also carry `errors[]` (operation-not-applied), which is
 * load-bearing and distinct from `warnings[]` (advisory). This is why a single
 * generic `Resolution<T>` across read+write verbs was rejected by the deletion
 * test (ADR-1411 P3 amendment). Do NOT change the emitted JSON shape; this
 * comment names the convention, it does not alter the contract.
 */
interface SetCapabilityStateResult {
  capabilities: CapabilityStateEntry[];
  warnings: string[];
  errors: string[];
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Write-side capability state mutator.
 *
 * Applies desired capability state changes (enabled axis via surface, gates
 * axis via config) then re-resolves and returns the full capability state.
 *
 * Control flow:
 *   1. RESOLVE BEFORE STATE: call resolveCapabilityRuntimeState once to get the
 *      canonical runtimeConfigDir and current capability state.
 *   2. VALIDATION PASS (no writes): validate each desired entry against the
 *      registry and `before` state; collect errors and warnings.
 *   3. If errors → return early with before.capabilities (no writes performed).
 *   4. APPLY PASS: compute new surface state, writeSurface once if changed,
 *      setConfigValues once for gate writes; materialize if opts provided.
 *   5. RE-RESOLVE: call resolveCapabilityRuntimeState again to get final state.
 *   6. POST CHECKS: enabled=true but not-surfaced (not-in-profile) error;
 *      present-but-dead warning; append resolver warnings.
 *   7. Return { capabilities: after.capabilities, warnings, errors }.
 */
function setCapabilityState(
  cwd: string,
  runtimeConfigDir: string | undefined | null,
  desired: DesiredCapability[],
  opts?: SetCapabilityStateOptions,
): SetCapabilityStateResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // ── Step 1: Resolve BEFORE state once ────────────────────────────────────
  const before = resolveCapabilityRuntimeState(cwd, runtimeConfigDir);
  const resolvedConfigDir = before.runtimeConfigDir;

  // ── Load registry ─────────────────────────────────────────────────────────
  // Issue #2045 (DEFECT 2): validate against the COMPOSED overlay-aware registry
  // (first-party ∪ accepted overlays), mirroring capability-state.cts:547-551.
  // The frozen capability-registry.cjs only knows first-party ids, so a third-
  // party cap failed the membership check below → "unknown capability" even
  // though resolveCapabilityRuntimeState (the `before` snapshot, line 150) already
  // knew about it. loadRegistry is non-throwing and first-party-wins, so a
  // malformed overlay is skipped (never crashes the writer); a truly-unknown id
  // is STILL rejected because it is absent from the composed capabilities map.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadRegistry } = require('./capability-loader.cjs') as { loadRegistry: (opts?: Record<string, unknown>) => Record<string, unknown> };
  const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] });
  const capabilitiesMap = (
    registry['capabilities'] && typeof registry['capabilities'] === 'object' && !Array.isArray(registry['capabilities'])
      ? registry['capabilities']
      : {}
  ) as Record<string, unknown>;

  // ── Step 2: VALIDATION PASS (no writes) ──────────────────────────────────
  // Accumulate all valid gate writes and surface deltas.
  // If ANY error is found, we will return early without writing anything.

  const pendingGateWrites: Array<{ keyPath: string; value: unknown }> = [];
  // surface-delta accumulators: ids to add to / remove from disabledClusters
  const idsToDisable: string[] = [];
  const idsToEnable: string[] = [];
  // Track which ids need surface loading (have skills + explicit enabled flag)
  let needsSurface = false;

  for (const entry of desired) {
    const { id, enabled, gates } = entry;

    // Validate capability id
    if (!Object.prototype.hasOwnProperty.call(capabilitiesMap, id)) {
      errors.push(`unknown capability: "${id}"`);
      continue;
    }

    const capObj = capabilitiesMap[id] as Record<string, unknown>;
    const skillsRaw = capObj['skills'];
    const skills: string[] = Array.isArray(skillsRaw)
      ? skillsRaw.filter((s): s is string => typeof s === 'string')
      : [];
    const configDef = (
      capObj['config'] && typeof capObj['config'] === 'object' && !Array.isArray(capObj['config'])
        ? capObj['config']
        : {}
    ) as Record<string, unknown>;

    // ── Validate gate keys / values ──────────────────────────────────────────
    if (gates !== undefined) {
      for (const [key, val] of Object.entries(gates)) {
        if (!Object.prototype.hasOwnProperty.call(configDef, key)) {
          errors.push(`unknown gate key "${key}" for capability "${id}"`);
          continue;
        }
        if (typeof val !== 'boolean') {
          errors.push(`gate value for "${key}" must be boolean, got ${typeof val}`);
          continue;
        }
        pendingGateWrites.push({ keyPath: key, value: val });
      }
    }

    // ── Validate enabled axis ────────────────────────────────────────────────
    if (enabled !== undefined) {
      if (skills.length === 0) {
        // Advisory only — no surface effect possible
        warnings.push(
          `capability "${id}" owns no skills; 'enabled' has no surface effect — use gates to toggle its hooks`,
        );
        continue;
      }

      // Install-floor check: cannot enable a capability whose skills are not installed
      if (enabled === true) {
        const beforeEntry = before.capabilities.find((c: CapabilityStateEntry) => c.id === id);
        if (beforeEntry && beforeEntry.installed === false) {
          errors.push(`cannot enable "${id}": its skills are not in the install profile`);
          continue;
        }
      }

      needsSurface = true;
      if (enabled === false) {
        idsToDisable.push(id);
      } else {
        idsToEnable.push(id);
      }
    }
  }

  // ── Fix D: Pre-validate config.json parseability before any write ────────
  // If there are pending gate writes, attempt to read and parse the target
  // config.json BEFORE writing anything. A malformed file would cause
  // setConfigValues to error() mid-operation leaving a partial write.
  if (pendingGateWrites.length > 0) {
    try {
      const configJsonPath = nodepath.join(planningDir(cwd), 'config.json');
      if (nodefs.existsSync(configJsonPath)) {
        const raw = nodefs.readFileSync(configJsonPath, 'utf-8');
        try {
          JSON.parse(raw);
        } catch (parseErr: unknown) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          errors.push(`config.json is malformed: ${msg}`);
        }
      }
    } catch {
      // Cannot read the file path — not an error (e.g. planningDir env-var issue); let setConfigValues handle it
    }
  }

  // ── Step 3: Early return on validation errors ────────────────────────────
  if (errors.length > 0) {
    return {
      capabilities: before.capabilities,
      warnings,
      errors,
    };
  }

  // ── Step 4: APPLY PASS ────────────────────────────────────────────────────

  let pendingSurfaceForCommit: SurfaceState | undefined;

  // ── Surface writes ────────────────────────────────────────────────────────
  if (needsSurface && (idsToDisable.length > 0 || idsToEnable.length > 0)) {
    const existing = readSurface(resolvedConfigDir);
    let pendingSurface: SurfaceState = existing ?? {
      baseProfile: readActiveProfile(resolvedConfigDir) ?? 'full',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    };
    let surfaceChanged = false;

    for (const id of idsToDisable) {
      // Add id to disabledClusters (dedupe)
      if (!pendingSurface.disabledClusters.includes(id)) {
        pendingSurface = {
          ...pendingSurface,
          disabledClusters: [...pendingSurface.disabledClusters, id],
        };
        surfaceChanged = true;
      }
      // Fix A: explicitAdds contains SKILL STEMS, not capability ids.
      // Remove the capability's skill stems from explicitAdds so that
      // resolveSurface does not re-add those skills after the cluster disable.
      const capObjForDisable = capabilitiesMap[id] as Record<string, unknown>;
      const skillsRawForDisable = capObjForDisable?.['skills'];
      const skillStemsForDisable: string[] = Array.isArray(skillsRawForDisable)
        ? skillsRawForDisable.filter((s): s is string => typeof s === 'string')
        : [];
      const newExplicitAdds = pendingSurface.explicitAdds.filter(
        (x) => !skillStemsForDisable.includes(x),
      );
      if (newExplicitAdds.length !== pendingSurface.explicitAdds.length) {
        pendingSurface = { ...pendingSurface, explicitAdds: newExplicitAdds };
        surfaceChanged = true;
      }
    }

    for (const id of idsToEnable) {
      // Remove id from disabledClusters
      if (pendingSurface.disabledClusters.includes(id)) {
        pendingSurface = {
          ...pendingSurface,
          disabledClusters: pendingSurface.disabledClusters.filter((x) => x !== id),
        };
        surfaceChanged = true;
      }
      // Fix A (enable branch): also remove the capability's skill stems from
      // explicitRemoves so that resolveSurface does not subtract those skills.
      // Do NOT add anything to explicitAdds — a cap that was only in explicitAdds
      // and was disabled is caught by the post-check below.
      const capObjForEnable = capabilitiesMap[id] as Record<string, unknown>;
      const skillsRawForEnable = capObjForEnable?.['skills'];
      const skillStemsForEnable: string[] = Array.isArray(skillsRawForEnable)
        ? skillsRawForEnable.filter((s): s is string => typeof s === 'string')
        : [];
      const newExplicitRemoves = pendingSurface.explicitRemoves.filter(
        (x) => !skillStemsForEnable.includes(x),
      );
      if (newExplicitRemoves.length !== pendingSurface.explicitRemoves.length) {
        pendingSurface = { ...pendingSurface, explicitRemoves: newExplicitRemoves };
        surfaceChanged = true;
      }
    }

    if (surfaceChanged) {
      pendingSurfaceForCommit = pendingSurface;
    }
  }

  // ── Config writes (once, batched) ─────────────────────────────────────────
  if (pendingGateWrites.length > 0) {
    setConfigValues(cwd, pendingGateWrites);
  }

  // State-only callers preserve the existing direct-write behavior. A caller
  // that requests materialization lets applySurface publish the candidate only
  // after every artifact kind has staged and synchronized successfully.
  if (pendingSurfaceForCommit && !opts?.materialize) {
    writeSurface(resolvedConfigDir, pendingSurfaceForCommit);
  }

  // ── Materialize (optional) ────────────────────────────────────────────────
  if (opts?.materialize) {
    const { runtime, scope } = opts.materialize;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const runtimeArtifactLayout = require('./runtime-artifact-layout.cjs') as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveRuntimeArtifactLayout: (runtime: string, configDir: string, scope: string, capabilityRegistry?: unknown) => any;
      };
      // #2322: thread the SAME composed registry (loaded above, includeInstalled:true)
      // into layout resolution so the skills kind's stage() closure can bind a
      // third-party capability skill to its declaring capId at staging time —
      // required for BOTH the '*' (full-profile) fill-in and the ownership binding
      // (see resolveRuntimeArtifactLayout's #2322 doc comment).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, resolvedConfigDir, scope, registry);
      const commandsGsdDir = _resolveCommandsGsdDir();
      const manifest = _resolveManifest(commandsGsdDir, resolvedConfigDir);
      // #1575: applySurface now accepts opts.resolveAttribution so surface-path
      // agents get the same Co-Authored-By trailer as the install path. The
      // resolver is not threaded here yet — the CLI command handler does not have
      // access to getCommitAttribution (which lives in bin/install.js). Until that
      // is refactored into a shared module, surface-path agents for descriptor-
      // driven runtimes will lack the Co-Authored-By trailer that install adds.
      // Parity is proven when resolveAttribution IS provided (see the
      // folded:issue-1575-agent-descriptor-parity describe block in
      // tests/golden-parity-single-source.test.cjs).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      applySurface(resolvedConfigDir, layout, manifest, undefined, registry, {
        ...(pendingSurfaceForCommit ? { surfaceState: pendingSurfaceForCommit } : {}),
        ...(opts.materialize.resolveAttribution
          ? { resolveAttribution: opts.materialize.resolveAttribution }
          : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fix C: materialise was explicitly requested — a failure is an error (non-zero exit),
      // not merely advisory.
      errors.push(`materialize failed: ${msg}`);
    }
  }

  // ── Step 5: RE-RESOLVE ────────────────────────────────────────────────────
  const after = resolveCapabilityRuntimeState(cwd, resolvedConfigDir);

  // ── Step 6: POST CHECKS ───────────────────────────────────────────────────

  // Check: desired enabled=true but not actually enabled after write
  // (catches the not-in-profile / not-surfaced silent no-op case).
  // The install-floor case (installed===false) was already caught in validation.
  for (const entry of desired) {
    if (entry.enabled === true) {
      const afterCap = after.capabilities.find((c: CapabilityStateEntry) => c.id === entry.id);
      if (afterCap && afterCap.enabled !== true) {
        errors.push(
          `cannot enable "${entry.id}": not in the active surface/profile (widen the profile or use /gsd:surface enable)`,
        );
      }
    }
    // Fix B: desired enabled=false — assert it is actually disabled after write.
    // Prevents "off means off" silent failures (e.g. explicitAdds containing the
    // cap's skill stems re-adds them after the cluster disable).
    if (entry.enabled === false) {
      const afterCap = after.capabilities.find((c: CapabilityStateEntry) => c.id === entry.id);
      if (afterCap && afterCap.enabled !== false) {
        errors.push(`failed to disable "${entry.id}": still surfaced after write`);
      }
    }
  }

  // Check: present-but-dead — SCOPED to touched (desired) capabilities only.
  const desiredIds = new Set(desired.map((d) => d.id));
  for (const cap of after.capabilities as CapabilityStateEntry[]) {
    if (!desiredIds.has(cap.id)) continue;
    if (
      cap.enabled === true &&
      cap.hooks.length > 0 &&
      cap.hooks.every((h: HookEntry) => !h.configured)
    ) {
      warnings.push(
        `capability "${cap.id}" is surfaced but every hook is gated off — did you mean enabled:false?`,
      );
    }
  }

  // Append resolver's own warnings
  for (const w of after.warnings) {
    warnings.push(w);
  }

  return {
    capabilities: after.capabilities,
    warnings,
    errors,
  };
}

/**
 * CLI command entry point for `gsd-tools capability set`.
 *
 * Builds one DesiredCapability from the provided options, calls setCapabilityState,
 * then prints the result. When raw=true emits JSON; else emits a human summary.
 * Warnings are always printed to stderr.
 */
function cmdCapabilitySet(
  cwd: string,
  runtimeConfigDir: string | undefined | null,
  capId: string,
  options: { enabled?: boolean; gates?: Record<string, boolean>; runtime?: string; scope?: string },
  raw: boolean,
): void {
  const desired: DesiredCapability[] = [
    {
      id: capId,
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.gates ? { gates: options.gates } : {}),
    },
  ];

  const opts: SetCapabilityStateOptions | undefined =
    options.runtime
      ? { materialize: { runtime: options.runtime, scope: options.scope ?? 'global' } }
      : undefined;

  const result = setCapabilityState(cwd, runtimeConfigDir, desired, opts);

  if (raw) {
    // Raw mode: emit JSON to stdout including errors; exit non-zero if errors present.
    // Do NOT print human stderr lines — raw consumers parse the JSON.
    coreOutput({ capabilities: result.capabilities, warnings: result.warnings, errors: result.errors }, true);
    if (result.errors.length > 0) {
      // Throw (don't process.exit) so the JSON written just above flushes before the process ends.
      throw new ExitError(1);
    }
    return;
  }

  // Human mode: print warnings and errors to stderr (non-fatally for warnings).
  for (const w of result.warnings) {
    process.stderr.write(`capability set: warning: ${w}\n`);
  }
  for (const e of result.errors) {
    process.stderr.write(`capability set: error: ${e}\n`);
  }

  // Exit non-zero if any errors (hard failures — requested action was not realized). The per-error
  // lines were already written to stderr above; signal the exit code via ExitError (not process.exit)
  // so any pending stdout/stderr flushes — runMain maps it to process.exitCode.
  if (result.errors.length > 0) {
    process.stderr.write(`Error: capability set: ${String(result.errors.length)} error(s) — see above\n`);
    throw new ExitError(1);
  }

  // Human-readable summary: focus on the target capability
  const cap = result.capabilities.find((c: CapabilityStateEntry) => c.id === capId);
  if (!cap) {
    const msg = `capability "${capId}" not found in registry`;
    coreOutput(msg, false, msg);
    return;
  }

  const activeHooks = cap.hooks.filter((h: HookEntry) => h.active).length;
  const summary = `capability ${capId}: enabled=${String(cap.enabled)}, surfaced=${String(cap.surfaced)}, installed=${String(cap.installed)}, activeHooks=${String(activeHooks)}/${String(cap.hooks.length)}`;
  coreOutput({ id: cap.id, enabled: cap.enabled, surfaced: cap.surfaced, installed: cap.installed, warnings: result.warnings.length > 0 ? result.warnings : undefined }, false, summary);
}

export = {
  setCapabilityState,
  cmdCapabilitySet,
};
