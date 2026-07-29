/**
 * Config — Planning config CRUD operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/config.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error, ERROR_REASON } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { CONFIG_DEFAULTS } = configLoader;
import { platformWriteSync, platformEnsureDir } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot, withPlanningLock } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { VALID_PROFILES, getAgentToModelMapForProfile, formatAgentToModelMapAsTable } = modelProfiles;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configSchema = require('./config-schema.cjs');
const { VALID_CONFIG_KEYS, isValidConfigKey, getCapabilityConfigSchema } = configSchema;
import { isSecretKey, maskSecret } from './secrets.cjs';
import { normalizeConfiguredDefaultReviewers, INSTANCE_NAME_PATTERN, KNOWN_REVIEWER_SLUGS } from './review-reviewer-selection.cjs';
import { migrateOnDisk } from './configuration.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetConfigValueResult {
  updated: boolean;
  key: string;
  value: unknown;
  previousValue: unknown;
}

interface UnsetConfigValueResult {
  updated: boolean;
  unset: true;
  key: string;
  value: null;
  previousValue: unknown;
}

interface WorkstreamContext {
  configPath?: string;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_KEY_SUGGESTIONS: Record<string, string> = {
  'workflow.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'agents.nyquist_validation_enabled': 'workflow.nyquist_validation',
  'nyquist.validation_enabled': 'workflow.nyquist_validation',
  'hooks.research_questions': 'workflow.research_before_questions',
  'workflow.research_questions': 'workflow.research_before_questions',
  'workflow.codereview': 'workflow.code_review',
  'workflow.review_command': 'workflow.code_review_command',
  'workflow.review': 'workflow.code_review',
  'workflow.code_review_level': 'workflow.code_review_depth',
  'workflow.review_depth': 'workflow.code_review_depth',
  'review.model': 'review.models.<cli-name>',
  'sub_repos': 'planning.sub_repos',
  'plan_checker': 'workflow.plan_check',
};

const SHIP_PR_BODY_SECTION_KEYS = new Set(['heading', 'enabled', 'source', 'fallback', 'template']);
const SHIP_PR_BODY_TEMPLATE_TOKENS = new Set([
  'phase_number',
  'phase_name',
  'phase_dir',
  'base_branch',
  'padded_phase',
]);
const SHIP_PR_BODY_SOURCE_RE = /^(ROADMAP|PLAN|SUMMARY|VERIFICATION|STATE|REQUIREMENTS|CONTEXT)\.md\s+##\s+[^\r\n#][^\r\n]*$/;

/**
 * Schema-level defaults for well-known config keys.
 * When a key is absent from config.json and no --default flag was supplied,
 * cmdConfigGet checks here before emitting "Key not found".
 */
const SCHEMA_DEFAULTS: Record<string, unknown> = {
  'context_window': 200000,
  'executor.stall_detect_interval_minutes': 5,
  'executor.stall_threshold_minutes': 10,
  'git.create_tag': true,
  // Derived from the defaults manifest rather than restated, so the manifest
  // stays the single source of truth for the smart-zone budget (#2630).
  'workflow.smart_zone_tokens': CONFIG_DEFAULTS.smart_zone_tokens,
};

/**
 * Resolve a schema-level default for an absent key (#2256). Checks the legacy
 * hardcoded SCHEMA_DEFAULTS first, then the capability-registry configSchema
 * default — the same registry default the runtime's capability-activation
 * resolver (resolveConfigKey Level 4, capability-activation.cts) already honors,
 * so `query config-get` can no longer disagree with the runtime about an absent
 * key's effective value.
 */
function resolveSchemaDefault(cwd: string, kp: string): { found: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(SCHEMA_DEFAULTS, kp)) {
    return { found: true, value: SCHEMA_DEFAULTS[kp] };
  }
  const capSchema = getCapabilityConfigSchema(cwd);
  if (capSchema && typeof capSchema === 'object'
      && Object.prototype.hasOwnProperty.call(capSchema, kp)) {
    const entry = capSchema[kp];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const def = (entry as Record<string, unknown>)['default'];
      if (def !== undefined) return { found: true, value: def };
    }
  }
  return { found: false, value: undefined };
}

/**
 * Emit a schema-resolved default (#2256), applying the same secret-masking
 * invariant the found-key path applies. getCapabilityConfigSchema is a
 * federated, third-party-extensible surface (ADR-1244) — a future key-name
 * collision with a secret key must not leak a declared default in plaintext.
 * Centralizing emission here means masking can't be missed at a call site.
 */
function emitResolvedDefault(kp: string, value: unknown, raw: boolean): void {
  if (isSecretKey(kp)) {
    const masked = maskSecret(value as Parameters<typeof maskSecret>[0]);
    output(masked, raw, masked);
    return;
  }
  output(value, raw, String(value));
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateKnownConfigKeyPath(keyPath: string): void {
  const suggested = CONFIG_KEY_SUGGESTIONS[keyPath];
  if (suggested) {
    error(`Unknown config key: ${keyPath}. Did you mean ${suggested}?`, ERROR_REASON.CONFIG_INVALID_KEY);
  }
}

function validateShipPrBodySections(value: unknown): void {
  if (!Array.isArray(value)) {
    error('Invalid ship.pr_body_sections value. Expected a JSON array of section objects.');
  }

  (value as unknown[]).forEach((section: unknown, index: number) => {
    const prefix = `Invalid ship.pr_body_sections[${index}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      error(`${prefix}. Expected an object.`);
    }

    const sectionObj = section as Record<string, unknown>;
    const unknownKeys = Object.keys(sectionObj).filter((key) => !SHIP_PR_BODY_SECTION_KEYS.has(key));
    if (unknownKeys.length > 0) {
      error(`${prefix}. Unknown field(s): ${unknownKeys.join(', ')}.`);
    }

    if (typeof sectionObj['heading'] !== 'string' || sectionObj['heading'].trim() === '') {
      error(`${prefix}. heading must be a non-empty string.`);
    }
    if (/[\r\n]/.test(sectionObj['heading'] as string)) {
      error(`${prefix}. heading must be a single line.`);
    }

    if ('enabled' in sectionObj && typeof sectionObj['enabled'] !== 'boolean') {
      error(`${prefix}. enabled must be true or false.`);
    }

    for (const field of ['source', 'fallback', 'template']) {
      if (field in sectionObj && typeof sectionObj[field] !== 'string') {
        error(`${prefix}. ${field} must be a string.`);
      }
    }

    const hasContent = ['source', 'fallback', 'template'].some((field) => {
      const v = sectionObj[field];
      return typeof v === 'string' && v.trim() !== '';
    });
    if (!hasContent) {
      error(`${prefix}. Provide at least one of source, fallback, or template.`);
    }

    if (typeof sectionObj['source'] === 'string' && sectionObj['source'].trim() !== '') {
      const selectors = sectionObj['source'].split('||').map((selector) => selector.trim()).filter(Boolean);
      if (selectors.length === 0 || selectors.some((selector) => !SHIP_PR_BODY_SOURCE_RE.test(selector))) {
        error(`${prefix}. source must use selectors like "PLAN.md ## Risks", separated with "||".`);
      }
    }

    if (typeof sectionObj['template'] === 'string') {
      const tokens = sectionObj['template'].matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g);
      for (const match of tokens) {
        if (!SHIP_PR_BODY_TEMPLATE_TOKENS.has(match[1])) {
          error(`${prefix}. Unsupported template token: {${match[1]}}.`);
        }
      }
    }
  });
}

// ─── Core config operations ───────────────────────────────────────────────────

/**
 * Build a fully-materialized config object for a new project.
 *
 * Merges (increasing priority):
 *   1. Hardcoded defaults — every key that loadConfig() resolves, plus mode/granularity
 *   2. User-level defaults from ~/.gsd/defaults.json (if present)
 *   3. userChoices — the settings the user explicitly selected during /gsd:new-project
 *
 * Uses the canonical `git` namespace for branching keys (consistent with VALID_CONFIG_KEYS
 * and the settings workflow). loadConfig() handles both flat and nested formats, so this
 * is backward-compatible with existing projects that have flat keys.
 *
 * Returns a plain object — does NOT write any files.
 */
function buildNewProjectConfig(userChoices: Record<string, unknown>): Record<string, unknown> {
  const choices = userChoices || {};
  const homedir = os.homedir();

  // Detect API key availability
  const braveKeyFile = path.join(homedir, '.gsd', 'brave_api_key');
  const hasBraveSearch = !!(process.env['BRAVE_API_KEY'] || fs.existsSync(braveKeyFile));
  const firecrawlKeyFile = path.join(homedir, '.gsd', 'firecrawl_api_key');
  const hasFirecrawl = !!(process.env['FIRECRAWL_API_KEY'] || fs.existsSync(firecrawlKeyFile));
  const exaKeyFile = path.join(homedir, '.gsd', 'exa_api_key');
  const hasExaSearch = !!(process.env['EXA_API_KEY'] || fs.existsSync(exaKeyFile));
  const tavilyKeyFile = path.join(homedir, '.gsd', 'tavily_api_key');
  const hasTavilySearch = !!(process.env['TAVILY_API_KEY'] || fs.existsSync(tavilyKeyFile));
  const refKeyFile = path.join(homedir, '.gsd', 'ref_api_key');
  const hasRefSearch = !!(process.env['REF_API_KEY'] || fs.existsSync(refKeyFile));
  const perplexityKeyFile = path.join(homedir, '.gsd', 'perplexity_api_key');
  const hasPerplexity = !!(process.env['PERPLEXITY_API_KEY'] || fs.existsSync(perplexityKeyFile));
  const jinaKeyFile = path.join(homedir, '.gsd', 'jina_api_key');
  const hasJina = !!(process.env['JINA_API_KEY'] || fs.existsSync(jinaKeyFile));

  // Load user-level defaults from ~/.gsd/defaults.json if available
  const globalDefaultsPath = path.join(homedir, '.gsd', 'defaults.json');
  let userDefaults: Record<string, unknown> = {};
  try {
    if (fs.existsSync(globalDefaultsPath)) {
      userDefaults = JSON.parse(fs.readFileSync(globalDefaultsPath, 'utf-8')) as Record<string, unknown>;
      // Migrate deprecated "depth" key to "granularity"
      if ('depth' in userDefaults && !('granularity' in userDefaults)) {
        const depthToGranularity: Record<string, string> = { quick: 'coarse', standard: 'standard', comprehensive: 'fine' };
        userDefaults['granularity'] = depthToGranularity[userDefaults['depth'] as string] || userDefaults['depth'];
        delete userDefaults['depth'];
        try {
          platformWriteSync(globalDefaultsPath, JSON.stringify(userDefaults, null, 2));
        } catch { /* intentionally empty */ }
      }
    }
  } catch {
    // Ignore malformed global defaults
  }

  const hardcoded: Record<string, unknown> = {
    model_profile: CONFIG_DEFAULTS.model_profile,
    commit_docs: CONFIG_DEFAULTS.commit_docs,
    parallelization: CONFIG_DEFAULTS.parallelization,
    search_gitignored: CONFIG_DEFAULTS.search_gitignored,
    brave_search: hasBraveSearch,
    firecrawl: hasFirecrawl,
    exa_search: hasExaSearch,
    tavily_search: hasTavilySearch,
    ref_search: hasRefSearch,
    perplexity: hasPerplexity,
    jina: hasJina,
    git: {
      branching_strategy: CONFIG_DEFAULTS.branching_strategy,
      create_tag: true,
      phase_branch_template: CONFIG_DEFAULTS.phase_branch_template,
      milestone_branch_template: CONFIG_DEFAULTS.milestone_branch_template,
      quick_branch_template: CONFIG_DEFAULTS.quick_branch_template,
    },
    workflow: {
      research: true,
      plan_check: true,
      verifier: true,
      nyquist_validation: true,
      auto_advance: false,
      node_repair: true,
      node_repair_budget: 2,
      ui_phase: true,
      ui_safety_gate: true,
      ai_integration_phase: true,
      api_coverage_gate: true,
      human_verify_mode: 'end-of-phase',
      context_guard_mode: 'warn',
      text_mode: false,
      research_before_questions: false,
      discuss_mode: 'discuss',
      skip_discuss: false,
      code_review: true,
      code_review_depth: 'standard',
      code_review_command: null,
      pattern_mapper: true,
      plan_bounce: false,
      plan_bounce_script: null,
      plan_bounce_passes: 2,
      auto_prune_state: false,
      post_planning_gaps: CONFIG_DEFAULTS.post_planning_gaps,
      security_enforcement: CONFIG_DEFAULTS.security_enforcement,
      security_asvs_level: CONFIG_DEFAULTS.security_asvs_level,
      security_block_on: CONFIG_DEFAULTS.security_block_on,
    },
    ship: {
      pr_body_sections: [],
    },
    hooks: {
      context_warnings: true,
    },
    project_code: null,
    phase_naming: 'sequential',
    agent_skills: {},
    claude_md_path: './.claude/CLAUDE.md',
    plan_review: {
      source_grounding: true,
      source_grounding_authority: 'grep',
    },
  };

  const ud = userDefaults as Record<string, Record<string, unknown>>;
  const ch = choices as Record<string, Record<string, unknown>>;
  const hd = hardcoded as Record<string, Record<string, unknown>>;

  // Three-level deep merge: hardcoded <- userDefaults <- choices
  const config: Record<string, unknown> = {
    ...hardcoded,
    ...userDefaults,
    ...choices,
    git: {
      ...hd['git'],
      ...(ud['git'] || {}),
      ...(ch['git'] || {}),
    },
    workflow: {
      ...hd['workflow'],
      ...(ud['workflow'] || {}),
      ...(ch['workflow'] || {}),
    },
    ship: {
      ...hd['ship'],
      ...(ud['ship'] || {}),
      ...(ch['ship'] || {}),
    },
    hooks: {
      ...hd['hooks'],
      ...(ud['hooks'] || {}),
      ...(ch['hooks'] || {}),
    },
    agent_skills: {
      ...hd['agent_skills'],
      ...(ud['agent_skills'] || {}),
      ...(ch['agent_skills'] || {}),
    },
    plan_review: {
      ...hd['plan_review'],
      ...(ud['plan_review'] || {}),
      ...(ch['plan_review'] || {}),
    },
  };

  validateShipPrBodySections((config['ship'] as Record<string, unknown>)['pr_body_sections']);
  return config;
}

/**
 * Command: create a fully-materialized .planning/config.json for a new project.
 *
 * Accepts user-chosen settings as a JSON string (the keys the user explicitly
 * configured during /gsd:new-project). All remaining keys are filled from
 * hardcoded defaults and optional ~/.gsd/defaults.json.
 *
 * Idempotent: if config.json already exists, returns { created: false }.
 */
function cmdConfigNewProject(cwd: string, choicesJson: string | undefined, raw: boolean): void {
  const planningBase = planningDir(cwd);
  const configPath = path.join(planningBase, 'config.json');

  // Idempotent: don't overwrite existing config
  if (fs.existsSync(configPath)) {
    output({ created: false, reason: 'already_exists' }, raw, 'exists');
    return;
  }

  // Parse user choices
  let userChoices: Record<string, unknown> = {};
  if (choicesJson && choicesJson.trim() !== '') {
    try {
      userChoices = JSON.parse(choicesJson) as Record<string, unknown>;
    } catch (err) {
      error('Invalid JSON for config-new-project: ' + (err as Error).message);
    }
  }

  // Ensure .planning directory exists
  try {
    platformEnsureDir(planningBase);
  } catch (err) {
    error('Failed to create .planning directory: ' + (err as Error).message);
  }

  const config = buildNewProjectConfig(userChoices);

  try {
    platformWriteSync(configPath, JSON.stringify(config, null, 2));
    output({ created: true, path: '.planning/config.json' }, raw, 'created');
  } catch (err) {
    error('Failed to write config.json: ' + (err as Error).message);
  }
}

/**
 * Ensures the config file exists (creates it if needed).
 *
 * Does not call `output()`, so can be used as one step in a command without triggering `exit(0)` in
 * the happy path. But note that `error()` will still `exit(1)` out of the process.
 */
function ensureConfigFile(cwd: string): { created: boolean; reason?: string; path?: string } | undefined {
  const planningBase = planningDir(cwd);
  const configPath = path.join(planningBase, 'config.json');

  // Ensure .planning directory exists
  try {
    platformEnsureDir(planningBase);
  } catch (err) {
    error('Failed to create .planning directory: ' + (err as Error).message);
  }

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    return { created: false, reason: 'already_exists' };
  }

  const config = buildNewProjectConfig({});

  try {
    platformWriteSync(configPath, JSON.stringify(config, null, 2));
    return { created: true, path: '.planning/config.json' };
  } catch (err) {
    error('Failed to create config.json: ' + (err as Error).message);
  }
}

/**
 * Command to ensure the config file exists (creates it if needed).
 *
 * Note that this exits the process (via `output()`) even in the happy path; use
 * `ensureConfigFile()` directly if you need to avoid this.
 */
function cmdConfigEnsureSection(cwd: string, raw: boolean): void {
  const ensureConfigFileResult = ensureConfigFile(cwd);
  if (ensureConfigFileResult && ensureConfigFileResult.created) {
    output(ensureConfigFileResult, raw, 'created');
  } else {
    output(ensureConfigFileResult, raw, 'exists');
  }
}

/**
 * Shared helper: write a single key-path into an in-memory config object.
 *
 * Prototype-pollution guard: reject dangerous segments via inline literal
 * comparisons on the exact key used to index `current`, immediately before
 * each write. The inline comparison is the barrier CodeQL's
 * js/prototype-pollution-utility query recognises — the previous Set-based
 * pre-loop check was functionally correct but not traced through, so
 * code-scanning alert #26 kept firing. Behaviour is unchanged from #663.
 *
 * Returns the previous value at the leaf key (undefined if absent).
 * Never writes to disk — callers handle persistence.
 * Calls error() (process.exit(1)) on prototype-pollution attempts.
 */
function _setNestedValue(
  config: Record<string, unknown>,
  keyPath: string,
  parsedValue: unknown,
): unknown {
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      error('Invalid config key (prototype pollution guard): ' + keyPath, ERROR_REASON.CONFIG_PARSE_FAILED);
    }
    const existingChild = current[key];
    if (existingChild === undefined || existingChild === null || typeof existingChild !== 'object' || Array.isArray(existingChild)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey === '__proto__' || lastKey === 'prototype' || lastKey === 'constructor') {
    error('Invalid config key (prototype pollution guard): ' + keyPath, ERROR_REASON.CONFIG_PARSE_FAILED);
  }
  const previousValue = current[lastKey];
  current[lastKey] = parsedValue;
  return previousValue;
}

/**
 * Deletes a value from the config object, allowing nested values via dot
 * notation (e.g., "review.models.gemini"). Mirrors `_setNestedValue`'s
 * prototype-pollution guard on every path segment (including intermediates).
 *
 * Unlike `_setNestedValue`, this NEVER creates missing intermediate objects —
 * if any segment along the path is missing (or not a plain, non-array
 * object), the key doesn't exist and we return early without mutating
 * `config` at all.
 *
 * Does not prune now-empty parent objects after deletion (matches the
 * conservative, structure-preserving behaviour callers expect from a bare
 * unset).
 *
 * Returns { previousValue, existed } — existed is false when the leaf key
 * (or an intermediate segment) was never present.
 * Calls error() (process.exit(1)) on prototype-pollution attempts.
 */
function _unsetNestedValue(
  config: Record<string, unknown>,
  keyPath: string,
): { previousValue: unknown; existed: boolean } {
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      error('Invalid config key (prototype pollution guard): ' + keyPath, ERROR_REASON.CONFIG_PARSE_FAILED);
    }
    const existingChild = current[key];
    if (existingChild === undefined || existingChild === null || typeof existingChild !== 'object' || Array.isArray(existingChild)) {
      // Path doesn't exist — nothing to unset, and we must not create it.
      return { previousValue: undefined, existed: false };
    }
    current = existingChild as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey === '__proto__' || lastKey === 'prototype' || lastKey === 'constructor') {
    error('Invalid config key (prototype pollution guard): ' + keyPath, ERROR_REASON.CONFIG_PARSE_FAILED);
  }
  const existed = Object.prototype.hasOwnProperty.call(current, lastKey);
  const previousValue = current[lastKey];
  if (existed) {
    delete current[lastKey];
  }
  return { previousValue, existed };
}

/**
 * Deletes a key from the config file, allowing nested values via dot
 * notation. Mirrors `setConfigValue`'s load/lock/write cycle.
 *
 * Does not call `output()`, so can be used as one step in a command without triggering `exit(0)` in
 * the happy path. But note that `error()` will still `exit(1)` out of the process.
 */
function unsetConfigValue(cwd: string, keyPath: string): UnsetConfigValueResult {
  const configPath = path.join(planningDir(cwd), 'config.json');

  return withPlanningLock(cwd, () => {
    // Load existing config or start with empty object
    let config: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      error('Failed to read config.json: ' + (err as Error).message, ERROR_REASON.CONFIG_PARSE_FAILED);
    }

    const { previousValue, existed } = _unsetNestedValue(config, keyPath);

    // Write back
    try {
      platformWriteSync(configPath, JSON.stringify(config, null, 2));
      return { updated: existed, unset: true, key: keyPath, value: null, previousValue };
    } catch (err) {
      error('Failed to write config.json: ' + (err as Error).message);
    }
  }) as UnsetConfigValueResult;
}

/**
 * Sets a value in the config file, allowing nested values via dot notation (e.g.,
 * "workflow.research").
 *
 * Does not call `output()`, so can be used as one step in a command without triggering `exit(0)` in
 * the happy path. But note that `error()` will still `exit(1)` out of the process.
 */
function setConfigValue(cwd: string, keyPath: string, parsedValue: unknown): SetConfigValueResult {
  const configPath = path.join(planningDir(cwd), 'config.json');

  return withPlanningLock(cwd, () => {
    // Load existing config or start with empty object
    let config: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      error('Failed to read config.json: ' + (err as Error).message, ERROR_REASON.CONFIG_PARSE_FAILED);
    }

    const previousValue = _setNestedValue(config, keyPath, parsedValue);

    // Write back
    try {
      platformWriteSync(configPath, JSON.stringify(config, null, 2));
      return { updated: true, key: keyPath, value: parsedValue, previousValue };
    } catch (err) {
      error('Failed to write config.json: ' + (err as Error).message);
    }
  }) as SetConfigValueResult;
}

/**
 * Batched sibling of setConfigValue: apply multiple key-path writes in a
 * single load → set-all → write cycle inside ONE withPlanningLock call.
 *
 * Returns { updated: true, results: SetConfigValueResult[] } on success.
 * An empty entries array is a no-op and returns { updated: false, results: [] }.
 *
 * Prototype-pollution guards are enforced per entry (identical inline-literal
 * guards as setConfigValue — CodeQL barrier requirement).
 */
function setConfigValues(
  cwd: string,
  entries: Array<{ keyPath: string; value: unknown }>,
): { updated: boolean; results: SetConfigValueResult[] } {
  if (entries.length === 0) {
    return { updated: false, results: [] };
  }

  const configPath = path.join(planningDir(cwd), 'config.json');

  return withPlanningLock(cwd, () => {
    // Load existing config or start with empty object
    let config: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      error('Failed to read config.json: ' + (err as Error).message, ERROR_REASON.CONFIG_PARSE_FAILED);
    }

    const results: SetConfigValueResult[] = [];
    for (const entry of entries) {
      const previousValue = _setNestedValue(config, entry.keyPath, entry.value);
      results.push({ updated: true, key: entry.keyPath, value: entry.value, previousValue });
    }

    // Write back once for all entries
    try {
      platformWriteSync(configPath, JSON.stringify(config, null, 2));
      return { updated: true, results };
    } catch (err) {
      error('Failed to write config.json: ' + (err as Error).message);
    }
  }) as { updated: boolean; results: SetConfigValueResult[] };
}

/**
 * Type-safe enum guard for config-set string-enum keys.
 *
 * Rejects any parsedValue that is not a plain string AND a member of `allowed`.
 * This closes the JSON-array coercion bypass: String(["val"]) === "val" satisfies
 * a bare .includes(String(parsedValue)) check, but typeof parsedValue !== 'string'
 * catches the array before the includes test.
 *
 * The `label` parameter is used verbatim in the error message so callers can
 * preserve existing message text byte-for-byte.
 */
function assertEnumValue(parsedValue: unknown, rawVal: string, allowed: readonly string[], label: string): void {
  if (typeof parsedValue !== 'string' || !allowed.includes(parsedValue)) {
    error(`Invalid ${label} '${rawVal}'. Valid values: ${allowed.join(', ')}`);
  }
}

/**
 * Command to set a value in the config file, allowing nested values via dot notation (e.g.,
 * "workflow.research").
 *
 * Note that this exits the process (via `output()`) even in the happy path; use `setConfigValue()`
 * directly if you need to avoid this.
 */
function cmdConfigSet(cwd: string, keyPath: string | undefined, value: string | undefined, raw: boolean): void {
  if (!keyPath) {
    error('Usage: config-set <key.path> <value>', ERROR_REASON.USAGE);
  }
  // #3593: reject the "key without value" form (e.g. `config-set
  // model_profile` with args[2] === undefined). Without this guard the
  // value passes through as undefined, the number/boolean/json branches
  // all fall through, and the write either silently strips the key
  // (JSON.stringify drops undefined values) or writes a corrupt entry.
  // Typed reason so the negative-matrix test can assert on it instead
  // of greppinng prose.
  if (value === undefined) {
    error('Usage: config-set <key.path> <value>', ERROR_REASON.USAGE);
  }

  // After the two error() guards above, keyPath and value are narrowed to string.
  // TypeScript doesn't always infer never-return narrowing through error(), so we assert.
  const kp = keyPath!;
  const val = value!;

  validateKnownConfigKeyPath(kp);

  if (!isValidConfigKey(kp, cwd)) {
    error(`Unknown config key: "${kp}". Valid keys: ${[...VALID_CONFIG_KEYS].sort().join(', ')}, agent_skills.<agent-type>, features.<feature_name>`, ERROR_REASON.CONFIG_INVALID_KEY);
  }

  // Parse value (handle booleans, numbers, and JSON arrays/objects)
  let parsedValue: unknown = val;
  if (val === 'true') parsedValue = true;
  else if (val === 'false') parsedValue = false;
  else if (val === 'null') parsedValue = null;
  // #1581: Number.isFinite (not !isNaN) so 'Infinity'/'-Infinity' are NOT
  // coerced to non-finite numbers that JSON.stringify later renders as `null`
  // (disk=null while the CLI echoed 'Infinity'). They fall through to the
  // JSON branch (which rejects them) and stay strings, then per-key validators
  // reject them with a non-zero exit.
  else if (Number.isFinite(Number(val)) && val !== '') parsedValue = Number(val);
  else if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
    try { parsedValue = JSON.parse(val); } catch { /* keep as string */ }
  }

  // #2046: a bare `null` unsets (deletes) the key — the documented "Clear" action.
  // Short-circuits before every typed per-key validator so clearing a typed key
  // (enum/boolean/number) removes it rather than being rejected. Deleting (not
  // persisting JSON null) is the correct "clear": a persisted null is still a
  // present, truthy-adjacent value that consumers must special-case — worst for
  // secret keys where a leftover value can be passed as a real credential.
  if (parsedValue === null) {
    const unsetResult = unsetConfigValue(cwd, kp);
    if (isSecretKey(kp)) {
      const maskedPrev = unsetResult.previousValue === undefined
        ? undefined
        : maskSecret(unsetResult.previousValue as Parameters<typeof maskSecret>[0]);
      output({ ...unsetResult, value: null, previousValue: maskedPrev, masked: true }, raw, `${kp} unset`);
      return;
    }
    output(unsetResult, raw, `${kp} unset`);
    return;
  }

  // #1581: project_code is an identifier string — never number-coerce it. A
  // leading-zero code like '007' must persist verbatim (not collapse to 7).
  if (kp === 'project_code') {
    parsedValue = val;
  }

  const VALID_CONTEXT_VALUES = ['dev', 'research', 'review'];
  if (kp === 'context') assertEnumValue(parsedValue, val, VALID_CONTEXT_VALUES, 'context value');

  // Codebase drift detector (#2003)
  const VALID_DRIFT_ACTIONS = ['warn', 'auto-remap'];
  if (kp === 'workflow.drift_action') assertEnumValue(parsedValue, val, VALID_DRIFT_ACTIONS, 'workflow.drift_action');
  if (kp === 'workflow.drift_threshold') {
    if (typeof parsedValue !== 'number' || !Number.isInteger(parsedValue) || parsedValue < 1) {
      error(`Invalid workflow.drift_threshold '${val}'. Must be a positive integer.`);
    }
  }

  // #1581: context_window must be a finite positive integer. 'Infinity' is no
  // longer number-coerced (see the parse block above) so it reaches here as a
  // string and is rejected; '0', negatives, and non-integers are also rejected.
  if (kp === 'context_window') {
    if (typeof parsedValue !== 'number' || !Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue < 1) {
      error(`Invalid context_window '${val}'. Must be a positive integer (token count).`, ERROR_REASON.USAGE);
    }
  }

  // Smart-zone token budget (#2630, ADR-2629). Same shape as context_window:
  // a positive integer token count. A POLICY default, not a benchmark constant.
  // Number.isSafeInteger, NOT Number.isInteger: the read side
  // (estimate-cli readSmartZoneBudget) accepts only safe integers, so an
  // isInteger-only gate would let config-set 'succeed' on a value past 2^53
  // that estimate-check then silently ignores in favour of the default.
  // Accept and honour must agree.
  if (kp === 'workflow.smart_zone_tokens') {
    if (typeof parsedValue !== 'number' || !Number.isSafeInteger(parsedValue) || parsedValue < 1) {
      error(`Invalid workflow.smart_zone_tokens '${val}'. Must be a positive integer (token count).`, ERROR_REASON.USAGE);
    }
  }

  // Post-planning gap checker (#2493)
  if (kp === 'workflow.post_planning_gaps') {
    if (typeof parsedValue !== 'boolean') {
      error(`Invalid workflow.post_planning_gaps '${val}'. Must be a boolean (true or false).`);
    }
  }

  // #3086 — git.create_tag: boolean only
  if (kp === 'git.create_tag') {
    if (typeof parsedValue !== 'boolean') {
      error(`Invalid git.create_tag '${val}'. Must be a boolean (true or false).`);
    }
  }

  if (kp === 'ship.pr_body_sections') {
    validateShipPrBodySections(parsedValue);
  }

  // Human verification checkpoint mode (#3309)
  const VALID_HUMAN_VERIFY_MODES = ['mid-flight', 'end-of-phase'];
  if (kp === 'workflow.human_verify_mode') assertEnumValue(parsedValue, val, VALID_HUMAN_VERIFY_MODES, 'workflow.human_verify_mode');

  // Context exhaustion guard mode (#1452)
  const VALID_CONTEXT_GUARD_MODES = ['auto', 'warn', 'off'];
  if (kp === 'workflow.context_guard_mode') assertEnumValue(parsedValue, val, VALID_CONTEXT_GUARD_MODES, 'workflow.context_guard_mode');

  // Context position enum validation (#2937)
  const VALID_CONTEXT_POSITIONS = ['front', 'end'];
  if (kp === 'statusline.context_position') assertEnumValue(parsedValue, val, VALID_CONTEXT_POSITIONS, 'statusline.context_position');

  // statusline.show_context_tokens — boolean only
  if (kp === 'statusline.show_context_tokens') {
    if (typeof parsedValue !== 'boolean') {
      error(`Invalid statusline.show_context_tokens '${val}'. Must be a boolean (true or false).`);
    }
  }

  // Statusline GSD-state format enum validation
  const VALID_STATE_FORMATS = ['full', 'compact'];
  if (kp === 'statusline.state_format') assertEnumValue(parsedValue, val, VALID_STATE_FORMATS, 'statusline.state_format');

  // statusline.show_git — boolean only
  if (kp === 'statusline.show_git') {
    if (typeof parsedValue !== 'boolean') {
      error(`Invalid statusline.show_git '${val}'. Must be a boolean (true or false).`);
    }
  }

  // Fallow scope + profile enum validation (#3424)
  const VALID_FALLOW_SCOPES = ['phase', 'repo'];
  if (kp === 'code_quality.fallow.scope') assertEnumValue(parsedValue, val, VALID_FALLOW_SCOPES, 'code_quality.fallow.scope');
  const VALID_FALLOW_PROFILES = ['minimal', 'standard', 'strict'];
  if (kp === 'code_quality.fallow.profile') assertEnumValue(parsedValue, val, VALID_FALLOW_PROFILES, 'code_quality.fallow.profile');

  // plan_review.source_grounding (#22) — boolean only
  if (kp === 'plan_review.source_grounding') {
    if (typeof parsedValue !== 'boolean') {
      error(`Invalid plan_review.source_grounding '${val}'. Must be a boolean (true or false).`);
    }
  }

  // plan_review.source_grounding_authority (#22) — enum
  const VALID_SOURCE_GROUNDING_AUTHORITIES = ['grep', 'intel', 'treesitter', 'lsp', 'scip'];
  if (kp === 'plan_review.source_grounding_authority') assertEnumValue(parsedValue, val, VALID_SOURCE_GROUNDING_AUTHORITIES, 'plan_review.source_grounding_authority');

  // Generic capability-registry validation (#1628). Capability-owned keys declare
  // their type/values in the registry but most lack a hardcoded guard, so out-of-
  // domain values (including JSON array/object coercion) were stored silently.
  const capDef = getCapabilityConfigSchema(cwd)[kp] as { type?: string; values?: unknown[] } | undefined;
  if (capDef && typeof capDef.type === 'string') {
    switch (capDef.type) {
      case 'enum':
        if (Array.isArray(capDef.values)) {
          assertEnumValue(parsedValue, val, capDef.values.map((v) => String(v)), kp);
        }
        break;
      case 'boolean':
        if (typeof parsedValue !== 'boolean') {
          error(`Invalid ${kp} '${val}'. Must be a boolean (true or false).`);
        }
        break;
      case 'number':
        if (typeof parsedValue !== 'number' || !Number.isFinite(parsedValue)) {
          error(`Invalid ${kp} '${val}'. Must be a number.`);
        }
        break;
      case 'string':
        if (typeof parsedValue !== 'string') {
          error(`Invalid ${kp} '${val}'. Must be a string.`);
        }
        break;
    }
  }

  // Security — ASVS level range (#1628)
  // Must be an integer in {1, 2, 3} (OWASP ASVS levels).
  if (kp === 'workflow.security_asvs_level') {
    if (typeof parsedValue !== 'number' || !Number.isInteger(parsedValue) || parsedValue < 1 || parsedValue > 3) {
      error(`Invalid workflow.security_asvs_level '${val}'. Must be an integer 1, 2, or 3.`);
    }
  }

  if (kp === 'review.default_reviewers') {
    const normalized = normalizeConfiguredDefaultReviewers(parsedValue);
    if (normalized.errors.length > 0) {
      error(normalized.errors[0]);
    }
    parsedValue = normalized.values;
  }

  // #1517: validate review.reviewer_instances.<name>.<field> leaves at the
  // invocation boundary (Postel/Kerckhoffs — strict at accept). The config
  // schema dynamic pattern admits the path; this block validates the name + the
  // field value so a misconfigured instance is rejected at config-set time, not
  // silently at review time. Single-source validators live in
  // review-reviewer-selection.cjs (INSTANCE_NAME_PATTERN, KNOWN_REVIEWER_SLUGS).
  const instanceLeaf = kp.match(/^review\.reviewer_instances\.([a-zA-Z0-9_-]+)\.(cli|model|agent)$/);
  if (instanceLeaf) {
    const [, instanceName, field] = instanceLeaf;
    if (!INSTANCE_NAME_PATTERN.test(instanceName)) {
      error(`Invalid reviewer instance name '${instanceName}'. Must match ^[a-z0-9][a-z0-9-]*$.`);
    }
    if (KNOWN_REVIEWER_SLUGS.includes(instanceName)) {
      error(`Reviewer instance name '${instanceName}' must not equal a built-in reviewer slug.`);
    }
    if (field === 'cli') {
      if (typeof parsedValue !== 'string' || !KNOWN_REVIEWER_SLUGS.includes(parsedValue)) {
        error(`Invalid reviewer_instances.${instanceName}.cli '${val}'. Must be a known reviewer adapter: ${KNOWN_REVIEWER_SLUGS.join(', ')}.`);
      }
    } else {
      // model | agent — opaque pass-through strings (never interpolated into shell).
      if (typeof parsedValue !== 'string') {
        error(`Invalid reviewer_instances.${instanceName}.${field} '${val}'. Must be a string.`);
      }
    }
  }

  const setConfigValueResult = setConfigValue(cwd, kp, parsedValue);

  // Mask secrets in both JSON and text output. The plaintext is written
  // to config.json (that's where secrets live on disk); the CLI output
  // must never echo it. See lib/secrets.cjs.
  if (isSecretKey(kp)) {
    // parsedValue is unknown at this point; maskSecret accepts MaskableValue
    const masked = maskSecret(parsedValue as Parameters<typeof maskSecret>[0]);
    const maskedPrev = setConfigValueResult.previousValue === undefined
      ? undefined
      : maskSecret(setConfigValueResult.previousValue as Parameters<typeof maskSecret>[0]);
    const maskedResult = {
      ...setConfigValueResult,
      value: masked,
      previousValue: maskedPrev,
      masked: true,
    };
    output(maskedResult, raw, `${kp}=${masked}`);
    return;
  }

  output(setConfigValueResult, raw, `${kp}=${String(parsedValue)}`);
}

function cmdConfigGet(cwd: string, keyPath: string | undefined, raw: boolean, defaultValue: unknown): void {
  const configPath = path.join(planningDir(cwd), 'config.json');
  const hasDefault = defaultValue !== undefined;

  if (!keyPath) {
    error('Usage: config-get <key.path> [--default <value>]');
  }

  // After the error() guard, keyPath is narrowed to string.
  const kp = keyPath!;

  let config: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } else {
      // #2702: when a workstream is active and has no config.json of its own, fall
      // back to the project ROOT config first — a key the user configured at root is
      // a real, present value and must inherit (per #1893: a present key wins over
      // --default). Only when root also misses do --default / schema default apply.
      // (When no workstream is active, resolveFromRootConfig is a no-op: same file.)
      const rootVal = resolveFromRootConfig(cwd, kp);
      if (rootVal.found) { emitResolvedDefault(kp, rootVal.value, raw); return; }
      if (hasDefault) { emitResolvedDefault(kp, defaultValue, raw); return; }
      const sd = resolveSchemaDefault(cwd, kp);
      if (sd.found) { emitResolvedDefault(kp, sd.value, raw); return; }
      error('No config.json found at ' + configPath, ERROR_REASON.CONFIG_NO_FILE);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('No config.json')) throw err;
    error('Failed to read config.json: ' + (err as Error).message, ERROR_REASON.CONFIG_PARSE_FAILED);
  }

  // Traverse dot-notation path (e.g., "workflow.auto_advance")
  const keys = kp.split('.');
  let current: unknown = config;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== 'object') {
      // #2702: root-config inheritance before --default / schema default (see above).
      const rootVal = resolveFromRootConfig(cwd, kp);
      if (rootVal.found) { emitResolvedDefault(kp, rootVal.value, raw); return; }
      if (hasDefault) { emitResolvedDefault(kp, defaultValue, raw); return; }
      const sd = resolveSchemaDefault(cwd, kp);
      if (sd.found) { emitResolvedDefault(kp, sd.value, raw); return; }
      error(`Key not found: ${kp}`, ERROR_REASON.CONFIG_KEY_NOT_FOUND);
    }
    // Own-property gate: bracket access on a plain object walks the
    // prototype chain, so an unqualified `current[key]` would resolve
    // '__proto__' / 'constructor' / 'hasOwnProperty' (and other
    // Object.prototype members) to their inherited values instead of
    // correctly reporting them as absent. hasOwnProperty.call only
    // returns true for a key JSON.parse actually assigned as data on
    // this object (including a literal "__proto__" JSON key, which
    // JSON.parse defines as an own data property, not the accessor) —
    // never for something inherited from the prototype chain.
    current = Object.prototype.hasOwnProperty.call(current, key)
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }

  if (current === undefined) {
    // #2702: root-config inheritance before --default / schema default (see above).
    const rootVal = resolveFromRootConfig(cwd, kp);
    if (rootVal.found) { emitResolvedDefault(kp, rootVal.value, raw); return; }
    if (hasDefault) { emitResolvedDefault(kp, defaultValue, raw); return; }
    const sd = resolveSchemaDefault(cwd, kp);
    if (sd.found) { emitResolvedDefault(kp, sd.value, raw); return; }
    error(`Key not found: ${kp}`, ERROR_REASON.CONFIG_KEY_NOT_FOUND);
  }

  // Never echo plaintext for sensitive keys via config-get. Plaintext lives
  // in config.json on disk; the CLI surface always shows the masked form.
  if (isSecretKey(kp)) {
    const masked = maskSecret(current as Parameters<typeof maskSecret>[0]);
    output(masked, raw, masked);
    return;
  }

  output(current, raw, String(current));
}

/**
 * #2702: resolve a dot-notation key against the project ROOT config
 * (`.planning/config.json`), ignoring any active workstream scope. Returns
 * `{found:false}` when the root config is absent, unparseable, or does not
 * contain the key. This is the inheritance rung `cmdConfigGet` was missing —
 * when a workstream's own config doesn't set a key, the project root value
 * must show through (workstream overrides root; it never fully replaces it),
 * exactly as `loadConfigResolved`'s root+workstream merge already does for
 * every other config consumer. No-op (found:false) when no workstream is
 * active, because `planningDir === planningRoot` and the caller already read
 * that file directly.
 */
function resolveFromRootConfig(cwd: string, kp: string): { found: boolean; value: unknown } {
  // Only meaningful when a workstream is active (GSD_WORKSTREAM set) — that is what
  // redirects planningDir away from root AND what loadConfigResolved gates root-reading
  // on. Gating on `process.env.GSD_WORKSTREAM` (not on a planningDir !== planningRoot
  // path inequality) avoids a false trigger under GSD_PROJECT alone, where planningDir
  // diverges from planningRoot without a workstream and loadConfigResolved does NOT
  // inherit root — matching the runtime's own `if (ws)` gate keeps the two surfaces
  // from diverging on the project-scoped (non-workstream) case.
  if (!process.env['GSD_WORKSTREAM']) return { found: false, value: undefined };
  const root = planningRoot(cwd);
  const rootConfigPath = path.join(root, 'config.json');
  let rootConfig: Record<string, unknown>;
  try {
    if (!fs.existsSync(rootConfigPath)) return { found: false, value: undefined };
    rootConfig = JSON.parse(fs.readFileSync(rootConfigPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Unparseable root config → don't inherit (do not let a corrupt root file
    // change config-get's verdict). Fall through to schema default / error.
    return { found: false, value: undefined };
  }
  let current: unknown = rootConfig;
  for (const key of kp.split('.')) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return { found: false, value: undefined };
    }
    current = Object.prototype.hasOwnProperty.call(current, key)
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }
  if (current === undefined) return { found: false, value: undefined };
  return { found: true, value: current };
}

/**
 * Command to set the model profile in the config file.
 *
 * Note that this exits the process (via `output()`) even in the happy path.
 */
function cmdConfigSetModelProfile(cwd: string, profile: string | undefined, raw: boolean): void {
  if (!profile) {
    error(`Usage: config-set-model-profile <${VALID_PROFILES.join('|')}>`);
  }

  const normalizedProfile = profile!.toLowerCase().trim();
  if (!VALID_PROFILES.includes(normalizedProfile)) {
    error(`Invalid profile '${String(profile)}'. Valid profiles: ${VALID_PROFILES.join(', ')}`);
  }

  // Ensure config exists (create if needed)
  ensureConfigFile(cwd);

  // Set the model profile in the config
  const { previousValue } = setConfigValue(cwd, 'model_profile', normalizedProfile);
  const previousProfile = typeof previousValue === 'string' ? previousValue : 'balanced';

  // Build result value / message and return
  const agentToModelMap = getAgentToModelMapForProfile(normalizedProfile);
  const result = {
    updated: true,
    profile: normalizedProfile,
    previousProfile,
    agentToModelMap,
  };
  const rawValue = getCmdConfigSetModelProfileResultMessage(
    normalizedProfile,
    previousProfile,
    agentToModelMap
  );
  output(result, raw, rawValue);
}

/**
 * Returns the message to display for the result of the `config-set-model-profile` command when
 * displaying raw output.
 */
function getCmdConfigSetModelProfileResultMessage(
  normalizedProfile: string,
  previousProfile: string,
  agentToModelMap: Record<string, string>
): string {
  const agentToModelTable = formatAgentToModelMapAsTable(agentToModelMap);
  const didChange = previousProfile !== normalizedProfile;
  const paragraphs = didChange
    ? [
        `✓ Model profile set to: ${normalizedProfile} (was: ${previousProfile})`,
        'Agents will now use:',
        agentToModelTable,
        'Next spawned agents will use the new profile.',
      ]
    : [
        `✓ Model profile is already set to: ${normalizedProfile}`,
        'Agents are using:',
        agentToModelTable,
      ];
  return paragraphs.join('\n\n');
}

/**
 * Print the resolved config.json path (workstream-aware). Used by settings.md
 * so the workflow writes/reads the correct file when a workstream is active (#2282).
 */
function cmdConfigPath(cwd: string, _raw: boolean, workstreamContext: WorkstreamContext | null = null): void {
  // Always emit as plain text — a file path is used via shell substitution,
  // never consumed as JSON. Passing raw=true forces plain-text output.
  const configPath = workstreamContext && workstreamContext.configPath
    ? workstreamContext.configPath
    : path.join(planningDir(cwd), 'config.json');
  output(configPath, true, configPath);
}

/**
 * Explicit on-disk migration of legacy config keys to canonical nested shape.
 *
 * Wraps the Configuration Module's migrateOnDisk() for the CLI surface. This
 * is the Phase 2 acceptance-criteria deliverable for opt-in migration (#3536):
 * users can run `gsd-tools migrate-config` to apply all four legacy-key
 * migrations to their .planning/config.json without having to load any config
 * implicitly via another command.
 *
 * Output: JSON object with { migrated, normalizations, wrote } or a human-readable
 * summary when --raw is set. Exits 0 in all cases (including no-op).
 *
 * Note: migrateOnDisk() is synchronous; the original CJS used async for
 * forward-compatibility but no await is needed. Dropped async per ADR-457 policy
 * (caller uses `await` which is safe on a sync return value).
 */
function cmdMigrateConfig(cwd: string, raw: boolean): void {
  const ws = process.env['GSD_WORKSTREAM'] || null;
  const report = migrateOnDisk(cwd, ws || undefined);

  if (raw) {
    if (!report.migrated) {
      const msg = 'No legacy keys found — config is already canonical.';
      output(msg, true, msg);
    } else {
      const lines = [
        `Migrated: ${String(report.wrote)}`,
        ...(report.normalizations as Array<{ from: string; to: string }>).map(n => `  ${n.from} → ${n.to}`),
      ].join('\n');
      output(lines, true, lines);
    }
  } else {
    // output() JSON.stringify's its first arg when raw=false; pass the report object.
    output(report, false, report);
  }
}

export = {
  VALID_CONFIG_KEYS,
  cmdConfigEnsureSection,
  cmdConfigSet,
  cmdConfigGet,
  cmdConfigSetModelProfile,
  cmdConfigNewProject,
  cmdConfigPath,
  cmdMigrateConfig,
  // Exported for programmatic use by capability-writer and tests
  setConfigValue,
  setConfigValues,
};
