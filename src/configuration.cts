/**
 * Configuration Module — legacy-key normalization, defaults merge, and explicit
 * on-disk migration. Pure normalization primitives consumed by config-loader.cjs
 * and config-schema.cjs. `loadConfig` was extracted to config-loader.cjs per
 * ADR-857 phase 2e (#885) and removed from this module per #893.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/configuration.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ⚠️ DO NOT add a sibling `.cjs` import to this module. `configuration.cjs` must load
// from an install layout containing ONLY itself plus `bin/shared/*.manifest.json` —
// that is the #3571 contract, pinned by "co-located bin/shared manifests let
// configuration.cjs load without sdk/shared" in tests/install.test.cjs. A `require`
// for a sibling that the installer does not co-locate fails at load time with
// MODULE_NOT_FOUND. This is why #3760's out-of-band diagnostic is emitted by this
// module's CALLERS (`cmdMigrateConfig` in config.cts, `loadConfigResolved` in
// config-loader.cts) rather than here: `normalizeLegacyKeys` reports refusals
// in-band via `skipped[]`, which keeps it both pure AND dependency-free.

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ─── Manifest requires ───────────────────────────────────────────────────────
function loadConfigurationManifest(fileName: string): Record<string, unknown> {
  const candidates = [
    // Installed runtime layout: gsd-core/bin/shared/*.manifest.json
    join(__dirname, '..', 'shared', fileName),
  ];
  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      return _require(candidate) as Record<string, unknown>;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const isMissingCandidate =
        e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(candidate);
      if (!isMissingCandidate) throw err;
      lastErr = e;
    }
  }
  throw new Error(
    `${fileName} not found. Tried:\n${candidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${lastErr?.message}`
  );
}

const CONFIG_DEFAULTS = loadConfigurationManifest('config-defaults.manifest.json');
const SCHEMA_MANIFEST = loadConfigurationManifest('config-schema.manifest.json') as {
  validKeys: string[];
  runtimeStateKeys: string[];
  dynamicKeyPatterns: Array<{ source: string; [k: string]: unknown }>;
};
const VALID_CONFIG_KEYS = new Set<string>(SCHEMA_MANIFEST.validKeys);
const RUNTIME_STATE_KEYS = new Set<string>(SCHEMA_MANIFEST.runtimeStateKeys);

interface DynamicKeyPattern {
  source: string;
  test: (key: string) => boolean;
  [k: string]: unknown;
}

const DYNAMIC_KEY_PATTERNS: DynamicKeyPattern[] = SCHEMA_MANIFEST.dynamicKeyPatterns.map((p) => {
  const pattern = new RegExp(p.source);
  return {
    ...p,
    test: (key: string) => {
      pattern.lastIndex = 0;
      return pattern.test(key);
    },
  };
});

// ─── Depth → Granularity mapping ─────────────────────────────────────────────
const DEPTH_TO_GRANULARITY: Record<string, string> = {
  quick: 'coarse',
  standard: 'standard',
  comprehensive: 'fine',
};

// ─── Internal helpers ─────────────────────────────────────────────────────────
function planningDir(cwd: string, workstream?: string): string {
  if (!workstream)
    return join(cwd, '.planning');
  return join(cwd, '.planning', 'workstreams', workstream);
}

function detectSubRepos(cwd: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules')
        continue;
      const gitPath = join(cwd, entry.name, '.git');
      try {
        if (existsSync(gitPath)) {
          results.push(entry.name);
        }
      }
      catch { /* ignore */ }
    }
  }
  catch { /* ignore */ }
  return results.sort();
}

function deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    const ov = overlay[key];
    if (ov !== null && ov !== undefined && typeof ov === 'object' && !Array.isArray(ov)) {
      const bv = base[key];
      if (bv !== null && bv !== undefined && typeof bv === 'object' && !Array.isArray(bv)) {
        result[key] = deepMergeConfig(bv as Record<string, unknown>, ov as Record<string, unknown>);
      }
      else {
        result[key] = deepMergeConfig({}, ov as Record<string, unknown>);
      }
    }
    else {
      result[key] = ov;
    }
  }
  return result;
}

// ─── Exported types ───────────────────────────────────────────────────────────

interface Normalization {
  from: string;
  to: string;
  value: unknown;
  requiresFilesystem?: boolean;
}

/**
 * A legacy-key migration that could not run because its destination section is
 * present but is not an object.
 *
 * This is deliberately NOT a `Normalization`. Every caller treats a non-empty
 * `normalizations` array as "the config changed, write it back" — reporting a
 * refusal there would persist a migration that did not happen. Reporting it
 * here keeps the two claims separate: `normalizations` is what changed,
 * `skipped` is what was declined and why. (#3760)
 */
interface SkippedNormalization {
  /** The legacy top-level key that was left in place. */
  from: string;
  /** Where it would have gone, had the section been usable. */
  to: string;
  /** The section key that blocked the migration (`git`, `planning`). */
  section: string;
  reason: 'non_object_section';
  /** The legacy value, preserved. */
  value: unknown;
  /**
   * What the section holds, as a type name — `'string' | 'number' | 'boolean' |
   * 'array'` — NOT the value itself.
   *
   * The type is the whole diagnostic ("this is a string where an object belongs"),
   * and the value is still sitting untouched in the file, so echoing it buys
   * nothing. It would cost something: `cmdMigrateConfig` prints this report
   * verbatim on `gsd-tools migrate-config --json`, and config values are treated
   * as potentially secret-bearing elsewhere in this module (`maskSecret` on the
   * `config set/unset` output path).
   */
  sectionType: string;
}

/** Type name for a report — `'array'` for arrays, otherwise `typeof`. */
function describeSectionType(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

interface NormalizeLegacyKeysResult {
  parsed: Record<string, unknown>;
  normalizations: Normalization[];
  /** Migrations declined because the destination section is a non-object (#3760). */
  skipped: SkippedNormalization[];
}

interface MigrateOnDiskResult {
  migrated: boolean;
  normalizations: Normalization[];
  wrote: string | null;
  /** Migrations declined because the destination section is a non-object (#3760). */
  skipped: SkippedNormalization[];
}

/**
 * Is `value` usable as a config SECTION — something a nested key can be written into?
 *
 * Three cases, and the distinction between the second and third is the whole of #3760:
 *
 *  - `null` / `undefined` — ABSENT. Not a section yet, but nothing is lost by creating one.
 *    Callers substitute `{}`; this predicate reports `false` and callers check for absence
 *    separately, so the two are never conflated.
 *  - a non-null, non-array `object` — a SECTION. Spreading it is safe and correct.
 *  - anything else (string, number, boolean, array) — a PRESENT NON-OBJECT, i.e. user data
 *    that a spread would destroy. `{...'main'}` is `{0:'m',1:'a',2:'i',3:'n'}`; `{...7}` is
 *    `{}`. An array is included here because `typeof [] === 'object'` and `{...['a']}` is
 *    `{0:'a'}` — the identical expansion a bare `typeof` guard would wave through.
 *
 * This is the nested-section analog of the top-level shape check ADR-227 already requires
 * in `_readConfigFile` (`config-loader.cts`): valid JSON is not the same as a config object.
 * It lives here, exported, rather than being copied into `config-loader.cts`, because two
 * hand-rolled copies of one predicate is `DEFECT.GENERATIVE-FIX` by construction — the same
 * reasoning that made `unusable-input.cts` a shared seam.
 */
function isConfigSection(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Hoist a legacy top-level key into its canonical nested section.
 *
 * Refuses — and reports the refusal — when the destination section is present but is not an
 * object. Refusing means leaving BOTH the section and the legacy key exactly as they were and
 * pushing no `Normalization`, so this block never marks the config dirty and nothing it
 * touched can be written back. That is the #3760 contract: never expand, never drop, never
 * persist a shape the user did not write.
 */
function hoistLegacyKey(
  result: Record<string, unknown>,
  normalizations: Normalization[],
  skipped: SkippedNormalization[],
  legacyKey: string,
  section: string,
  field: string,
): void {
  const raw = result[section];
  // `null`/`undefined` mean "no section yet" and have always been treated as absent here.
  // They carry no user data, so creating the section loses nothing.
  const absent = raw === null || raw === undefined;
  if (!absent && !isConfigSection(raw)) {
    skipped.push({
      from: legacyKey,
      to: `${section}.${field}`,
      section,
      reason: 'non_object_section',
      value: result[legacyKey],
      sectionType: describeSectionType(raw),
    });
    return;
  }
  // `raw` is already narrowed by the isConfigSection guard above.
  const existing: Record<string, unknown> = absent ? {} : raw;
  const value = result[legacyKey];
  // Canonical nested wins when it is already set; otherwise the legacy value is hoisted.
  result[section] = existing[field] === undefined
    ? { ...existing, [field]: value }
    : { ...existing };
  delete result[legacyKey];
  normalizations.push({ from: legacyKey, to: `${section}.${field}`, value });
}

function normalizeLegacyKeys(parsed: Record<string, unknown>): NormalizeLegacyKeysResult {
  const result: Record<string, unknown> = { ...parsed };
  const normalizations: Normalization[] = [];
  const skipped: SkippedNormalization[] = [];
  // 1. branching_strategy → git.branching_strategy
  if (Object.prototype.hasOwnProperty.call(result, 'branching_strategy')) {
    hoistLegacyKey(result, normalizations, skipped, 'branching_strategy', 'git', 'branching_strategy');
  }
  // 2. top-level sub_repos → planning.sub_repos
  if (Object.prototype.hasOwnProperty.call(result, 'sub_repos')) {
    hoistLegacyKey(result, normalizations, skipped, 'sub_repos', 'planning', 'sub_repos');
  }
  // 3. multiRepo: true → marker (filesystem detection deferred to migrateOnDisk / caller)
  if (result['multiRepo'] === true) {
    // #3760: refuse here too, for the same reason as blocks 1 and 2 — and it must be
    // decided HERE, not in the caller. The caller is the one that runs filesystem
    // detection, but whether `planning` can receive the result is knowable from the
    // parsed config alone. Deciding it later meant `multiRepo` had already been
    // deleted and a Normalization already pushed: the config was written, the
    // sub_repos injection silently no-opped against the non-object section, and the
    // user's `multiRepo: true` was consumed with nothing to show for it and no
    // diagnostic. Refusing here keeps the marker, keeps the config clean of a
    // migration that did not happen, and gives all three callers the same report.
    const planning = result['planning'];
    if (planning !== null && planning !== undefined && !isConfigSection(planning)) {
      skipped.push({
        from: 'multiRepo',
        to: 'planning.sub_repos',
        section: 'planning',
        reason: 'non_object_section',
        value: true,
        sectionType: describeSectionType(planning),
      });
    }
    else {
      delete result['multiRepo'];
      normalizations.push({ from: 'multiRepo', to: 'planning.sub_repos', value: true, requiresFilesystem: true });
    }
  }
  // 4. top-level depth → granularity
  if (Object.prototype.hasOwnProperty.call(result, 'depth') && !Object.prototype.hasOwnProperty.call(result, 'granularity')) {
    const rawDepth = result['depth'] as string;
    const mapped = DEPTH_TO_GRANULARITY[rawDepth] ?? rawDepth;
    result['granularity'] = mapped;
    delete result['depth'];
    normalizations.push({ from: 'depth', to: 'granularity', value: mapped });
  }
  return { parsed: result, normalizations, skipped };
}

function mergeDefaults(parsed: Record<string, unknown>): Record<string, unknown> {
  // Start with a deep clone of defaults, then overlay parsed
  const defaults = structuredClone(CONFIG_DEFAULTS);
  return deepMergeConfig(defaults, parsed);
}

function migrateOnDisk(cwd: string, workstream?: string, configPathOverride?: string): MigrateOnDiskResult {
  // #3749: the caller (cmdMigrateConfig in config.cts) supplies the config
  // path resolved through planning-workspace's PROJECT-aware planningDir.
  // This module cannot import that sibling (#3571 install-layout contract),
  // and its own local planningDir above is deliberately workstream-only —
  // resolving here through the local copy made migrate-config under
  // GSD_PROJECT rewrite the ROOT config instead of the scoped one.
  const configPath = configPathOverride ?? join(planningDir(cwd, workstream), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  }
  catch {
    // File missing — nothing to migrate
    return { migrated: false, normalizations: [], wrote: null, skipped: [] };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { migrated: false, normalizations: [], wrote: null, skipped: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  }
  catch {
    // Malformed — can't migrate
    return { migrated: false, normalizations: [], wrote: null, skipped: [] };
  }
  const { parsed: normalized, normalizations, skipped } = normalizeLegacyKeys(parsed as Record<string, unknown>);
  // Resolve multiRepo filesystem detection
  const result: Record<string, unknown> = { ...normalized };
  for (const norm of normalizations) {
    if (norm.requiresFilesystem) {
      const detected = detectSubRepos(cwd);
      if (detected.length > 0) {
        // #3760: `requiresFilesystem` is pushed by block 3 only when `planning` was
        // absent or an object, and nothing between there and here changes it — so
        // `isConfigSection` picks between merge and create, and never has to discard.
        const planning = result['planning'];
        const existing = isConfigSection(planning) ? planning : {};
        result['planning'] = { ...existing, sub_repos: detected, commit_docs: false };
      }
    }
  }
  if (normalizations.length === 0) {
    // Nothing changed — and that now includes the case where every legacy key was
    // REFUSED. Returning early here is what keeps the corrupted-section input from
    // reaching writeFileSync at all.
    return { migrated: false, normalizations: [], wrote: null, skipped };
  }
  try {
    writeFileSync(configPath, JSON.stringify(result, null, 2));
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write migrated config at ${configPath}: ${msg}`);
  }
  return { migrated: true, normalizations, wrote: configPath, skipped };
}

export {
  normalizeLegacyKeys,
  mergeDefaults,
  migrateOnDisk,
  isConfigSection,
  CONFIG_DEFAULTS,
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
  DYNAMIC_KEY_PATTERNS,
};
