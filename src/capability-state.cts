/**
 * Capability State Resolver — ADR-857 phase 4b
 *
 * Unified capability-state resolver that composes the three toggle systems
 * (install profile, runtime surface, config activation) into one per-capability
 * view. The loop resolver consumes this state so workflow dispatch and the
 * `gsd-tools capability state` diagnostic share the same enablement answer.
 *
 * Exports (three things, mirroring loop-resolver):
 *   resolveCapabilityState({ registry, installedSkills, surfacedSkills, config, cwd })
 *     → { capabilities: CapabilityStateEntry[] }
 *   cmdCapabilityState(cwd, runtimeConfigDir, raw, options) — I/O entry point
 *
 * resolveCapabilityState is DETERMINISTIC given (registry, installedSkills,
 * surfacedSkills, config) and — when `cwd` is provided — the project config
 * files at `cwd` (.planning/config.json etc). Pass `cwd: undefined` for a
 * pure, config-only resolution with no filesystem I/O.
 * cmdCapabilityState is the I/O handler.
 *
 * Dependencies (leaf modules only — no circular risk):
 *   - node:path
 *   - ./io.cjs                 (output, error)
 *   - ./capability-activation.cjs (_resolveActivationValue)
 *   - ./install-profiles.cjs   (readActiveProfile, loadSkillsManifest, resolveProfile)
 *   - ./surface.cjs            (resolveSurface)
 *   - ./config-loader.cjs      (loadConfig)
 *   - ./runtime-homes.cjs      (getGlobalConfigDir — for runtimeConfigDir auto-detection)
 *   - ./runtime-slash.cjs      (resolveRuntime — GSD_RUNTIME > config.runtime > 'claude' precedence)
 *   - capability-registry.cjs  (loaded at call time)
 */

import path from 'node:path';
import fs from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output: coreOutput, error: coreError } = ioMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import activationMod = require('./capability-activation.cjs');
const { _resolveActivationValue, _resolvePointGate } = activationMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfilesMod = require('./install-profiles.cjs');
const { readActiveProfile, loadSkillsManifest, resolveProfile, parseRequires, parseCallsAgents, workflowAgentRefs } = installProfilesMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import surfaceMod = require('./surface.cjs');
const { resolveSurface } = surfaceMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookEntry {
  /** Loop point this hook fires at */
  point: string;
  /** Which hook kind */
  kind: 'step' | 'gate' | 'contribution';
  /**
   * The raw `when` value from the registry entry. Carried through for
   * visibility (diagnostic aid). undefined = no `when` field present
   * (unconditional hook). empty-string or non-string = present but
   * malformed → inactive (mirrors loop-resolver semantics).
   */
  when: unknown;
  /** Whether this hook is currently active based on config */
  configured: boolean;
  /** Whether this hook participates after capability enablement is applied */
  active: boolean;
}

interface CapabilityStateEntry {
  id: string;
  tier: string;
  /** Skill stems this capability owns */
  skills: string[];
  /**
   * True if every skill owned by this capability is in the installed set.
   * Vacuously true for capabilities with an empty skills array.
   * True when installedSkills is the '*' sentinel (full install).
   */
  installed: boolean;
  /**
   * True if every skill owned by this capability is in the surfaced set.
   * Vacuously true for capabilities with an empty skills array.
   */
  surfaced: boolean;
  /** True when the capability is both installed and surfaced. */
  enabled: boolean;
  /**
   * True when the capability is enabled AND its config activation resolves to
   * true. Config activation is determined by resolving the capability's
   * `activationKey` (a dotted config key, e.g. `graphify.enabled`) via
   * `_resolveActivationValue`. When `activationKey` is absent, configActivation
   * defaults to `true` — the capability has no config gate.
   *
   * active = enabled && configActivation
   *
   * Note: `enabled` stays exactly `installed && surfaced` (unchanged).
   */
  active: boolean;
  /** Resolved hook activation state across steps, gates, and contributions */
  hooks: HookEntry[];
}

interface ResolveCapabilityStateInput {
  /** The registry object (typically from capability-registry.cjs) */
  registry: Record<string, unknown>;
  /**
   * Set of installed skill stems, or '*' for full/unrestricted install.
   */
  installedSkills: Set<string> | '*';
  /** Set of surfaced skill stems for the current runtime config dir */
  surfacedSkills: Set<string>;
  /** loadConfig result for config-key activation resolution */
  config: Record<string, unknown>;
  /** Optional cwd — enables raw config.json fallback read (mirrors loop-resolver) */
  cwd?: string | undefined;
}

interface ResolveCapabilityStateResult {
  capabilities: CapabilityStateEntry[];
}

/**
 * Canonical **read-verb envelope** for the capability-state seam (ADR-1411 P3 / #1416).
 *
 * This is the shape emitted by the capability-state read verb:
 *   `{ runtimeConfigDir, capabilities, warnings? }`
 *
 * The shared contract with other diagnostic shapes is `warnings: string[]`.
 * Unlike `Resolution<T>` (src/resolution.cts, for config-interpreting read verbs),
 * this read verb does not carry `configured`/`reason` — those fields are meaningful
 * only for config-interpreting verbs such as agent-skills. Do NOT change the emitted
 * JSON shape; this comment names the convention, it does not alter the contract.
 */
interface ResolveCapabilityRuntimeStateResult {
  runtimeConfigDir: string;
  warnings: string[];
  capabilities: CapabilityStateEntry[];
}

// ─── Prototype-pollution guard (inline literal, CodeQL barrier) ───────────────

function _isSafePropKey(key: unknown): key is string {
  // Inline literal guards — CodeQL barrier pattern
  if (typeof key !== 'string') return false;
  if (key === '__proto__') return false;
  if (key === 'constructor') return false;
  if (key === 'prototype') return false;
  return true;
}

// ─── Pure resolver ─────────────────────────────────────────────────────────────

/**
 * Deterministic resolver: for each capability in the registry, produce the
 * three-dimension state view:
 *   1. installed  — does the install profile cover this capability?
 *   2. surfaced   — does the runtime surface enable this capability?
 *   3. hooks      — per-hook activation derived from config `when` keys.
 *
 * Determinism contract: given the same (registry, installedSkills,
 * surfacedSkills, config) and — when `cwd` is set — the same project config
 * files at `cwd`, the output is identical across calls. Pass `cwd: undefined`
 * for a pure, config-only resolution with no filesystem I/O.
 *
 * Never throws for malformed registry/hook entries — skips/defaults defensively.
 * An empty or missing capabilities object → { capabilities: [] }.
 *
 * @param input.registry         The capability-registry.cjs module export.
 * @param input.installedSkills  Set<string> | '*' — from resolveProfile().skills.
 * @param input.surfacedSkills   Set<string> — from resolveSurface().skills.
 * @param input.config           Record from loadConfig(cwd).
 * @param input.cwd              Optional; when provided, enables raw .planning/config.json
 *                               fallback reads (levels 2+3 of _resolveActivationValue
 *                               precedence). Omit for a pure in-memory resolution.
 */
function resolveCapabilityState(input: ResolveCapabilityStateInput): ResolveCapabilityStateResult {
  const { registry, installedSkills, surfacedSkills, config, cwd } = input;

  // Guard: registry missing capabilities
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { capabilities: [] };
  }
  const capabilitiesRaw = registry['capabilities'];
  if (!capabilitiesRaw || typeof capabilitiesRaw !== 'object' || Array.isArray(capabilitiesRaw)) {
    return { capabilities: [] };
  }
  const capabilitiesMap = capabilitiesRaw as Record<string, unknown>;

  const results: CapabilityStateEntry[] = [];

  for (const capId of Object.keys(capabilitiesMap)) {
    // Prototype-pollution guard on capability id
    if (!_isSafePropKey(capId)) continue;

    const cap = capabilitiesMap[capId];
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) continue;
    const capObj = cap as Record<string, unknown>;

    // Extract tier
    const tier = typeof capObj['tier'] === 'string' ? capObj['tier'] : 'unknown';

    // Extract skills array
    const skillsRaw = capObj['skills'];
    const skills: string[] = Array.isArray(skillsRaw)
      ? skillsRaw.filter((s): s is string => typeof s === 'string')
      : [];

    // ── installed ──────────────────────────────────────────────────────────────
    // Empty-skills cap → vacuously installed (no skills to be absent).
    // installedSkills === '*' → installed = true for every cap.
    let installed: boolean;
    if (installedSkills === '*') {
      installed = true;
    } else if (skills.length === 0) {
      installed = true; // vacuous: no skills required
    } else {
      installed = skills.every((s) => installedSkills.has(s));
    }

    // ── surfaced ───────────────────────────────────────────────────────────────
    // Empty-skills cap → vacuously surfaced.
    let surfaced: boolean;
    if (skills.length === 0) {
      surfaced = true; // vacuous
    } else {
      surfaced = skills.every((s) => surfacedSkills.has(s));
    }

    const enabled = installed && surfaced;

    // ── per-capability config activation ──────────────────────────────────────
    // Resolve the capability's own activationKey (if present). This is the
    // config-level toggle that gates the whole capability — separate from the
    // per-hook `when` keys that gate individual hooks. When activationKey is
    // absent, configActivation defaults to true (no config gate on the cap).
    // active = enabled && configActivation  (enabled unchanged: installed && surfaced)
    const activationKey = typeof capObj['activationKey'] === 'string' && capObj['activationKey'].length > 0
      ? capObj['activationKey']
      : undefined;
    const configActivation: boolean = activationKey !== undefined
      ? _resolveActivationValue(activationKey, config, cwd, registry)
      : true;
    const active = enabled && configActivation;

    // ── hooks ──────────────────────────────────────────────────────────────────
    // Collect from steps, gates, contributions. Each may have a `when` key.
    // Activation semantics (mirrors loop-resolver.isActive exactly):
    //   - No `when` field present (undefined/null) → unconditional, active=true
    //   - Non-empty string `when` → resolve via _resolveActivationValue
    //   - Present-but-empty-string or non-string `when` → malformed, active=false
    // The original `when` value is carried through to the output for visibility.
    const hooks: HookEntry[] = [];

    function processHooks(
      arr: unknown[],
      kind: 'step' | 'gate' | 'contribution',
    ): void {
      for (const hookRaw of arr) {
        if (!hookRaw || typeof hookRaw !== 'object' || Array.isArray(hookRaw)) continue;
        const h = hookRaw as Record<string, unknown>;
        const point = typeof h['point'] === 'string' ? h['point'] : '';
        // Carry the raw `when` value through for visibility
        const whenRaw: unknown = h['when'];
        let configured: boolean;
        if (whenRaw === undefined || whenRaw === null) {
          // No `when` field → unconditional, always active
          configured = true;
        } else if (typeof whenRaw === 'string' && whenRaw.length > 0) {
          // Non-empty string `when` → resolve via _resolveActivationValue
          configured = _resolveActivationValue(whenRaw, config, cwd, registry);
        } else {
          // Present-but-empty-string or non-string `when` → malformed, inactive
          // (mirrors loop-resolver.isActive: `typeof when !== 'string' || when.length === 0` → false)
          configured = false;
        }
        // #3661: optional point-selection gate, ANDed in — mirrors loop-resolver.isActive
        // EXACTLY (see capability-activation.cts's _resolvePointGate doc comment; this
        // parity is load-bearing, see tests/capability-precedence-parity.test.cjs).
        if (configured) {
          configured = _resolvePointGate(h['pointFrom'], point, config, cwd, registry);
        }
        // Hook active = capability-level active AND hook's own config gate.
        // The capability's `active` constant (= enabled && configActivation) is
        // used here so that a config-disabled capability (active=false) cannot
        // produce active hooks even when the hook's own `when` is unconditional
        // (configured=true). The capability gate cascades to all its hooks.
        hooks.push({ point, kind, when: whenRaw, configured, active: active && configured });
      }
    }

    const stepsRaw = capObj['steps'];
    const gatesRaw = capObj['gates'];
    const contributionsRaw = capObj['contributions'];

    processHooks(Array.isArray(stepsRaw) ? stepsRaw : [], 'step');
    processHooks(Array.isArray(gatesRaw) ? gatesRaw : [], 'gate');
    processHooks(Array.isArray(contributionsRaw) ? contributionsRaw : [], 'contribution');

    results.push({ id: capId, tier, skills, installed, surfaced, enabled, active, hooks });
  }

  // Deterministic sort by id for stable output across calls
  results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return { capabilities: results };
}

// ─── I/O command handler ───────────────────────────────────────────────────────

/**
 * Derive the commands/gsd path from __dirname (which resolves to
 * gsd-core/bin/lib/ at runtime). The source tree is:
 *   <repo>/gsd-core/bin/lib/capability-state.cjs
 *   <repo>/commands/gsd/*.md
 * So we walk up three levels: lib/ → bin/ → gsd-core/ → <repo>/, then
 * into commands/gsd/.
 */
function _resolveCommandsGsdDir(): string {
  // __dirname = gsd-core/bin/lib/
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  return path.join(repoRoot, 'commands', 'gsd');
}

/**
 * Build a skill dependency manifest from an INSTALLED runtime's skills directory.
 *
 * In an installed runtime (e.g. Codex at ~/.codex), gsd skills live as
 * configDir/skills/gsd-STEM/SKILL.md. There is no commands/gsd source tree.
 * This function scans that installed layout and builds the same
 * Map shape that loadSkillsManifest produces from sources.
 *
 * Stem extraction: a directory named gsd-secure-phase maps to stem secure-phase.
 * Only directories whose names start with gsd- are included so user-created
 * skills (without the gsd- prefix) are not accidentally pulled in.
 *
 * The requires: field is parsed via the shared parseRequires helper (the same
 * parser loadSkillsManifest uses), so the two paths cannot drift.
 *
 * Returns an empty Map when the skills dir does not exist.
 */
function _loadInstalledSkillsManifest(configDir: string): Map<string, string[]> {
  const manifest = new Map<string, string[]>();
  const skillsDir = path.join(configDir, 'skills');
  if (!fs.existsSync(skillsDir)) return manifest;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return manifest;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('gsd-')) continue;
    // Strip the 'gsd-' prefix to get the skill stem
    const stem = entry.name.slice(4); // 'gsd-'.length === 4
    if (!stem) continue;
    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    // Parity with loadSkillsManifest: a stem exists only when its artifact
    // file is present. loadSkillsManifest registers a stem per .md FILE (and
    // tolerates an unreadable file as []), but never invents a stem for which
    // no file exists. Mirror that here: a stale gsd-<stem>/ directory with no
    // SKILL.md must NOT register the stem — otherwise the capability would be
    // wrongly reported surfaced/enabled and a verify:post hook would render
    // for a skill that cannot run.
    if (!fs.existsSync(skillMdPath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      // SKILL.md present but unreadable — register with no deps (parity with
      // loadSkillsManifest's readFileSync catch branch).
    }
    // Parse requires: via the SAME shared parser loadSkillsManifest uses, so
    // installed-runtime dependency resolution can never silently diverge from
    // the source-tree path (single source of truth — no duplicated regex).
    manifest.set(stem, content ? parseRequires(content) : []);
    // Mirror loadSkillsManifest's Map shape: it always sets a companion
    // `_calls_agents_<stem>` key. Installed SKILL.md bodies carry no
    // recoverable agent-call refs, so [] (the no-agents case) keeps the two
    // manifest shapes identical and prevents undefined-vs-[] drift for any
    // consumer that reads the agent-refs companion key.
    manifest.set(`_calls_agents_${stem}`, []);
  }
  return manifest;
}

/**
 * #1858 — Build a skill dependency manifest from a FLAT commands/gsd-<stem>.md
 * source layout (the Claude local project install shape, where the `gsd-`
 * prefix is baked into each filename at the commands/ level and there is no
 * commands/gsd/ subdir). Strips the `gsd-` prefix so stems match the nested
 * loader's output (gsd-validate-phase.md → validate-phase, same as nested
 * validate-phase.md).
 *
 * Map shape is identical to loadSkillsManifest: each stem maps to its
 * `requires` deps (parsed via the same shared parseRequires) and carries a
 * companion `_calls_agents_<stem>` key (parsed via parseCallsAgents) so the
 * flat and nested paths cannot drift.
 *
 * Returns an empty Map when the parent directory does not exist or contains
 * no gsd-*.md files (so _resolveManifest can use size>0 as the "flat layout
 * present" signal and fall through to the installed-skills branch otherwise).
 */
function _loadFlatCommandsGsdManifest(commandsParentDir: string, workflowsDir?: string): Map<string, string[]> {
  // #3798: derive agents from the command body PLUS the workflow files it
  // references, exactly like loadSkillsManifest does for the nested layout —
  // the flat (#1858) layout retained the original defect otherwise, and the
  // parity test in tests/capability-state.test.cjs asserts the two loaders
  // produce identical _calls_agents_* sets. Default: <pkg>/gsd-core/workflows
  // one level above the commands dir — the shape of both the repo checkout
  // (<repo>/commands/) and a flat runtime install (the runtime config dir's
  // commands/ with the package's gsd-core/ beside it).
  const flatWorkflowsDir = workflowsDir
    || path.resolve(commandsParentDir, '..', 'gsd-core', 'workflows');
  const manifest = new Map<string, string[]>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(commandsParentDir, { withFileTypes: true });
  } catch {
    return manifest;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('gsd-')) continue;
    if (!entry.name.endsWith('.md')) continue;
    // Strip 'gsd-' prefix (4 chars) and '.md' suffix (3 chars) → stem.
    const stem = entry.name.slice(4, -3);
    if (!stem) continue;
    // Mirror loadSkillsManifest's try/catch structure exactly: wrap read +
    // parse + set together so an unreadable file OR a thrown parser degrades
    // both keys to [] (parity; closes the latent catch-scope drift a reviewer
    // flagged — both parsers are non-throwing today, but the structural
    // match future-proofs the "identical Map shape" contract).
    try {
      const content = fs.readFileSync(path.join(commandsParentDir, entry.name), 'utf8');
      manifest.set(stem, parseRequires(content));
      manifest.set(`_calls_agents_${stem}`, [
        ...new Set([
          ...parseCallsAgents(content),
          ...workflowAgentRefs(content, flatWorkflowsDir),
        ]),
      ]);
    } catch {
      manifest.set(stem, []);
      manifest.set(`_calls_agents_${stem}`, []);
    }
  }
  return manifest;
}

/**
 * Resolve the skill dependency manifest for capability-state resolution.
 *
 * Resolution order:
 *   1. If commandsGsdDir exists, load from the nested source layout
 *      (repo-checkout behavior: <repo>/commands/gsd/*.md).
 *   2. #1858 — otherwise, if the flat source layout is present (gsd-<stem>.md
 *      files in dirname(commandsGsdDir)), load from there. This is the Claude
 *      local project install shape where commands/gsd/ does not exist but
 *      commands/gsd-<stem>.md files do.
 *   3. #1160 — otherwise, fall back to installed skills at
 *      configDir/skills/gsd-[stem]/SKILL.md.
 *
 * In an installed runtime both source trees are absent; only the skills/
 * layout exists. Returning an empty manifest caused resolveSurface to
 * materialise the full-sentinel to an empty Set, making every skill-bearing
 * capability appear unsurfaced even when the skill was physically installed
 * (#1160) or authored as a flat command file (#1858).
 */
function _resolveManifest(commandsGsdDir: string, configDir: string): Map<string, string[]> {
  if (fs.existsSync(commandsGsdDir)) {
    return loadSkillsManifest(commandsGsdDir);
  }
  // #1858: flat source layout — gsd-<stem>.md files at dirname(commandsGsdDir).
  // Only claim the flat branch when it actually has gsd-*.md files; otherwise
  // fall through to the installed-skills branch (a commands/ dir with no gsd
  // files must not shadow an installed skills/ tree).
  const flat = _loadFlatCommandsGsdManifest(path.dirname(commandsGsdDir));
  if (flat.size > 0) return flat;
  return _loadInstalledSkillsManifest(configDir);
}

/**
 * Command entry point: resolve install profile, surface, and config; compute
 * capability state; emit the envelope via io.output.
 *
 * Envelope: { runtimeConfigDir, warnings?: string[], capabilities: CapabilityStateEntry[] }
 *
 * runtimeConfigDir resolution (when not provided or empty):
 *   Detects the active runtime via the canonical precedence:
 *     process.env.GSD_RUNTIME → config.runtime → 'claude'
 *   (using resolveRuntime() from runtime-slash.cjs, the same precedence used
 *   by profile-output.cjs and the rest of the runtime resolution chain).
 *   Then calls getGlobalConfigDir(detectedRuntime) from runtime-homes.cjs —
 *   the same resolver used by install.js. This correctly handles all supported
 *   runtimes (claude, codex, cursor, gemini, opencode, grok, etc.) and their
 *   env-var overrides (CLAUDE_CONFIG_DIR, CODEX_HOME, CURSOR_CONFIG_DIR, …).
 *   Defaults to ~/.claude if either resolver throws.
 *
 * Failure surfacing: genuine resolution failures (manifest/profile/surface
 * errors) are reported in the `warnings` array in the envelope. The output
 * remains useful — degraded to the best available state — but the caller can
 * detect that the state is not fully resolved.
 *
 *   Legitimate "no marker → default full profile" is NOT a warning.
 *   A thrown error during profile/surface resolution IS a warning.
 *
 * @param cwd              Project root directory
 * @param runtimeConfigDir Runtime config directory (e.g. ~/.claude). May be
 *                         empty/undefined — falls back to auto-detection.
 *                         Providing a value without a next token (e.g. the flag
 *                         is last in argv with no following value) should be
 *                         caught by the caller before invoking this function.
 * @param raw              Whether to emit raw JSON (io.output raw mode)
 * @param _options         Reserved for future use
 */
function resolveCapabilityRuntimeState(
  cwd: string,
  runtimeConfigDir: string | undefined | null,
  configOverride?: Record<string, unknown>,
  runtimeOverride?: string,
): ResolveCapabilityRuntimeStateResult {
  const warnings: string[] = [];

  // Resolve runtimeConfigDir using the canonical runtime-homes resolver.
  // When not provided, the active runtime is detected via the canonical
  // precedence:  process.env.GSD_RUNTIME → config.runtime → 'claude'
  // (mirrors resolveRuntime() from runtime-slash.cjs and the precedence used
  // by profile-output.cjs and the rest of the runtime resolution chain).
  // getGlobalConfigDir(detectedRuntime) is then called, which honours the
  // runtime-specific env-var override (CLAUDE_CONFIG_DIR, CODEX_HOME,
  // CURSOR_CONFIG_DIR, GROK_AGENTS_HOME, etc.) correctly and without
  // fabricating env vars that don't exist upstream.
  let resolvedConfigDir: string = runtimeConfigDir || '';
  if (!resolvedConfigDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const runtimeHomes = require('./runtime-homes.cjs') as {
        getGlobalConfigDir: (runtime: string) => string;
      };
      // #2003: an explicit --runtime override bypasses the persisted-runtime
      // fallback (GSD_RUNTIME → config.runtime → 'claude') so, e.g., a repo with
      // persisted runtime:"codex" resolves the Claude config dir when the operator
      // is driving from Claude Code. Canonicalize via runtime-name-policy (handles
      // aliases like codex-app → codex); if canonicalization yields nothing, fall
      // through to the persisted-runtime resolution below. Mirrors the update-
      // context / effort sync precedent (read/diagnostic paths accepting both
      // --config-dir and --runtime).
      if (typeof runtimeOverride === 'string' && runtimeOverride.trim() !== '') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const runtimeNamePolicy = require('./runtime-name-policy.cjs') as {
          canonicalizeRuntimeName: (value: unknown) => string | null;
        };
        const canonical = runtimeNamePolicy.canonicalizeRuntimeName(runtimeOverride);
        if (canonical) {
          resolvedConfigDir = runtimeHomes.getGlobalConfigDir(canonical);
        } else {
          // #2003: unknown runtime override — warn (don't silently ignore the
          // explicit input) and fall through to persisted-runtime resolution.
          // Avoids a silent-wrong-result on this diagnostic command for typos
          // (e.g. "cluade") or runtimes known to runtime-homes but not yet to
          // the alias manifest (e.g. "grok"). The warning surfaces via the
          // `warnings[]` channel consumed by cmdCapabilityState/cmdLoopRenderHooks.
          warnings.push(
            `--runtime "${runtimeOverride}" is not a known runtime; falling back to auto-detected/persisted runtime resolution`,
          );
        }
      }
      if (!resolvedConfigDir) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const runtimeSlash = require('./runtime-slash.cjs') as {
          resolveRuntime: (projectDir: string | null | undefined) => string;
        };
        // Detect the active runtime via GSD_RUNTIME → config.runtime → 'claude'.
        // resolveRuntime reads config.json directly (no side effects) and returns
        // a lowercased canonical runtime name.
        const detectedRuntime = runtimeSlash.resolveRuntime(cwd);
        resolvedConfigDir = runtimeHomes.getGlobalConfigDir(detectedRuntime);
      }
    } catch {
      // Defensive fallback: use ~/.claude if the canonical resolver throws.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('node:os') as typeof import('node:os');
      resolvedConfigDir = path.join(os.homedir(), '.claude');
    }
  }

  // ── Load registry (ADR-1244 D2 wiring) ──────────────────────────────────────
  // Load overlay-aware registry BEFORE resolveProfile and resolveSurface so both
  // calls receive the composed registry and installed third-party capabilities are
  // reflected in installed/surfaced state exactly like first-party capabilities.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadRegistry } = require('./capability-loader.cjs') as { loadRegistry: (opts?: Record<string, unknown>) => Record<string, unknown> };
  // #1459 IC-04: thread the consent home (process.env.GSD_HOME) EXPLICITLY so the overlay's global root
  // and the project-scope consent lookup resolve to the SAME user-owned home this consumer sees — a
  // legitimately-consented project cap then reports ACTIVE here (not falsely inactive at the wrong home).
  const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] });

  // ── Resolve installed skills (from install profile) ──────────────────────────
  // Distinguish "no profile marker → default full" (legitimate) from a thrown
  // error (surface as a warning and degrade gracefully — do NOT silently report
  // installedSkills='*' as if the install profile were truly unlimited).
  let installedSkills: Set<string> | '*';
  try {
    const commandsGsdDir = _resolveCommandsGsdDir();
    // Fix #1160: use _resolveManifest so installed-runtime layouts (where
    // commands/gsd is absent) fall back to <configDir>/skills/gsd-*/SKILL.md.
    const manifest = _resolveManifest(commandsGsdDir, resolvedConfigDir);
    const profileName = readActiveProfile(resolvedConfigDir) ?? 'full';
    const resolvedInstall = resolveProfile({
      modes: profileName.split(',').map((s: string) => s.trim()),
      manifest,
      registry,
    });
    installedSkills = resolvedInstall.skills;
  } catch (err: unknown) {
    // Genuine resolution failure — surface it so the caller is not misled.
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`profile-resolution failed: ${msg}`);
    // Degrade to empty set (not '*') so installed=false is reported accurately.
    installedSkills = new Set<string>();
  }

  // ── Resolve surfaced skills (from runtime surface) ────────────────────────────
  let surfacedSkills: Set<string>;
  try {
    const commandsGsdDir = _resolveCommandsGsdDir();
    // Fix #1160: use _resolveManifest so installed-runtime layouts (where
    // commands/gsd is absent) fall back to <configDir>/skills/gsd-*/SKILL.md.
    const manifest = _resolveManifest(commandsGsdDir, resolvedConfigDir);
    const surfaceResult = resolveSurface(resolvedConfigDir, manifest, undefined, registry);
    // resolveSurface returns { name, skills: Set<string>, agents: Set<string> }
    // (always a concrete Set — full profile is materialized)
    surfacedSkills = surfaceResult.skills instanceof Set
      ? surfaceResult.skills
      : new Set<string>();
  } catch (err: unknown) {
    // Genuine surface resolution failure — surface it so the caller is not misled.
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`surface-resolution failed: ${msg}`);
    surfacedSkills = new Set<string>();
  }

  // ── Load config ───────────────────────────────────────────────────────────────
  // When the caller already holds a loadConfig snapshot (e.g. cmdLoopRenderHooks),
  // accept it via configOverride so capability `active` and hook resolution
  // share the SAME config object — single snapshot, no TOCTOU window.
  let config: Record<string, unknown>;
  if (configOverride !== undefined) {
    config = configOverride;
  } else {
    try {
      config = loadConfig(cwd);
    } catch {
      config = {};
    }
  }

  // ── Resolve state ────────────────────────────────────────────────────────────

  const result = resolveCapabilityState({
    registry,
    installedSkills,
    surfacedSkills,
    config,
    cwd,
  });

  return {
    runtimeConfigDir: resolvedConfigDir,
    warnings,
    capabilities: result.capabilities,
  };
}

function cmdCapabilityState(
  cwd: string,
  runtimeConfigDir: string | undefined | null,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  // #2003: thread an explicit --runtime override so the config-dir resolution
  // bypasses the persisted-runtime fallback (GSD_RUNTIME → config.runtime).
  const runtimeOverride = typeof options['runtime'] === 'string' ? options['runtime'] : undefined;
  const result = resolveCapabilityRuntimeState(cwd, runtimeConfigDir, undefined, runtimeOverride);
  for (const warning of result.warnings) {
    coreError(`capability state: ${warning}`);
  }

  // Build envelope — include warnings array only when non-empty so the nominal
  // path keeps the output clean and callers can check `warnings` for degraded state.
  const envelope: {
    runtimeConfigDir: string;
    warnings?: string[];
    capabilities: CapabilityStateEntry[];
  } = {
    runtimeConfigDir: result.runtimeConfigDir,
    capabilities: result.capabilities,
  };
  if (result.warnings.length > 0) {
    envelope.warnings = result.warnings;
  }

  coreOutput(envelope, raw);
}

/**
 * Convenience predicate: returns true if the capability identified by `capId`
 * is active (installed && surfaced && config-enabled) in the current runtime
 * environment at `cwd`.
 *
 * Internally calls `resolveCapabilityRuntimeState(cwd, undefined)` and returns
 * the `active` field of the matching CapabilityStateEntry.
 * Returns `false` when the capability is not found in the registry.
 *
 * @param capId  Capability identifier (e.g. 'graphify', 'intel')
 * @param cwd    Project root directory for config resolution
 */
function isCapabilityActive(capId: string, cwd: string): boolean {
  const result = resolveCapabilityRuntimeState(cwd, undefined);
  const entry = result.capabilities.find((c) => c.id === capId);
  return entry !== undefined ? entry.active : false;
}

export = {
  resolveCapabilityState,
  resolveCapabilityRuntimeState,
  isCapabilityActive,
  cmdCapabilityState,
  // Exported for tests
  _resolveCommandsGsdDir,
  _loadInstalledSkillsManifest,
  _loadFlatCommandsGsdManifest,
  _resolveManifest,
  _isSafePropKey,
};
