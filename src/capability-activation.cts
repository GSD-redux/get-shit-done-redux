/**
 * Capability activation helpers.
 *
 * Shared by the Capability State Resolver and Loop Resolver so config-key
 * activation uses one precedence chain and one prototype-pollution guard.
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspaceMod;

function _getNestedConfigValue(
  config: Record<string, unknown>,
  dotKey: string,
): { found: boolean; value: unknown } {
  const segments = dotKey.split('.');
  let current: unknown = config;
  for (const seg of segments) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
      return { found: false, value: undefined };
    }
    if (typeof current !== 'object' || current === null) {
      return { found: false, value: undefined };
    }
    const cur = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { found: false, value: undefined };
    }
    current = cur[seg];
  }
  return { found: true, value: current };
}

const _warnedRawConfigPaths = new Set<string>();

function _readRawConfigKey(
  filePath: string,
  dotKey: string,
): { found: boolean; value: unknown } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (!_warnedRawConfigPaths.has(filePath)) {
        _warnedRawConfigPaths.add(filePath);
        try {
          process.stderr.write(
            `gsd-tools: warning: failed to parse ${filePath} as JSON — skipping for activation resolution\n`,
          );
        } catch { /* stderr might be closed */ }
      }
      return { found: false, value: undefined };
    }
    return _getNestedConfigValue(parsed, dotKey);
  } catch {
    return { found: false, value: undefined };
  }
}

/**
 * Resolve the raw value for a dotted config key using the four-level precedence
 * walk. Returns { found, value } with the RAW value (not coerced to boolean),
 * so callers can decide how to interpret the value (boolean gate vs. raw config
 * value for numeric/string settings like security_asvs_level).
 *
 * Precedence (mirrors _resolveActivationValue):
 *   1. loadConfig result (config arg) — guarded nested-lookup.
 *   2. Workstream config.json at planningDir(cwd)/config.json.
 *   3. Root config.json at planningRoot(cwd)/config.json (only if path differs).
 *   4. registry.configSchema[dotKey].default — schema default.
 *   5. Absent → { found: false, value: undefined }.
 */
function resolveConfigKey(
  dotKey: string,
  opts: { config: Record<string, unknown>; cwd: string | undefined; registry: Record<string, unknown> },
): { found: boolean; value: unknown } {
  const { config, cwd, registry } = opts;

  // Level 1: loadConfig result
  const fromConfig = _getNestedConfigValue(config, dotKey);
  if (fromConfig.found) return { found: true, value: fromConfig.value };

  // Level 2 + 3: raw config.json files (only when cwd is available)
  if (cwd) {
    const wsConfigPath = path.join(planningDir(cwd), 'config.json');
    const rootConfigPath = path.join(planningRoot(cwd), 'config.json');

    const fromWs = _readRawConfigKey(wsConfigPath, dotKey);
    if (fromWs.found) return { found: true, value: fromWs.value };

    if (wsConfigPath !== rootConfigPath) {
      const fromRoot = _readRawConfigKey(rootConfigPath, dotKey);
      if (fromRoot.found) return { found: true, value: fromRoot.value };
    }
  }

  // Level 4: registry configSchema default
  const schemaMap = registry['configSchema'];
  if (schemaMap && typeof schemaMap === 'object' && !Array.isArray(schemaMap)
      && Object.prototype.hasOwnProperty.call(schemaMap, dotKey)) {
    const schemaEntry = (schemaMap as Record<string, unknown>)[dotKey];
    if (schemaEntry && typeof schemaEntry === 'object' && schemaEntry !== null) {
      const def = (schemaEntry as Record<string, unknown>)['default'];
      if (def !== undefined) return { found: true, value: def };
    }
  }

  // Level 5: absent
  return { found: false, value: undefined };
}

function _resolveActivationValue(
  dotKey: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  const r = resolveConfigKey(dotKey, { config, cwd, registry });
  return r.found ? Boolean(r.value) : false;
}

/**
 * Resolve a step's optional `pointFrom` gate (#3661): a step declaring
 * `pointFrom: "<dotted enum key>"` is only active for ITS OWN `point` when the
 * resolved value of that config key equals `point` exactly. This lets a
 * capability register the same logical step at more than one loop point and
 * have config select which registration is live — without teaching the
 * shared `when` grammar an equality operator (`when` stays a plain boolean
 * gate on a dotted key everywhere else).
 *
 * No `pointFrom` → true (unconditional; every existing step is unaffected).
 * Present but not a non-empty string → false (malformed, mirrors `when`).
 * Present and resolved → true only on an exact match against `point`.
 *
 * Single-owner precedence engine: called from both `loop-resolver.cts`
 * (`isActive`) and `capability-state.cts` (`processHooks`) so the two
 * consumers can never diverge on activation (see
 * `tests/capability-precedence-parity.test.cjs`).
 */
function _resolvePointGate(
  pointFrom: unknown,
  point: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  if (pointFrom === undefined || pointFrom === null) return true;
  if (typeof pointFrom !== 'string' || pointFrom.length === 0) return false;
  const r = resolveConfigKey(pointFrom, { config, cwd, registry });
  return r.found && r.value === point;
}

export = {
  _getNestedConfigValue,
  _readRawConfigKey,
  _resolveActivationValue,
  _resolvePointGate,
  resolveConfigKey,
};
