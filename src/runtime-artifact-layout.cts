'use strict';

/**
 * Runtime artifact layout module — resolves the artifact directory shapes
 * (commands, agents, skills) for each supported runtime.
 *
 * grok is intentionally absent: it is in runtime-homes.cjs but has no runtime
 * capability descriptor. The TypeError on unknown runtime is the loud-fail
 * signal that a runtime was added without an artifact layout descriptor.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-artifact-layout.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfiles = require('./install-profiles.cjs');
const {
  stageSkillsForProfile,
  stageAgentsForRuntimeWithConverter,
  stageSkillsForRuntimeAsSkills,
  stageCommandsForRuntimeFlat,
} = installProfiles;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactConversion = require('./runtime-artifact-conversion.cjs');
const conversionExports = runtimeArtifactConversion as Record<string, unknown> & {
  readGsdCommandNames?: () => string[];
};
import { posixNormalize } from './shell-command-projection.cjs';
// #2870: `isGlobalScope` centralizes the `scope === 'global'` boolean
// projection both kind-builder closures below need at the converters'
// positional `isGlobal` boundary (see its doc comment in install-scope.cts
// for why the projection is centralized rather than eliminated).
import { isGlobalScope, scopeRank, type InstallScope } from './install-scope.cjs';

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// loadInstallExports / getInstallExports / InstallExports removed in ADR-1508
// / #1511 Phase 2 — removed this module's upward dependency on bin/install.js
// (the getInstallExports relay). surface.cts now calls
// runtimeArtifactConversion.rewriteStagedSkillBodies directly.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArtifactKindName = 'commands' | 'agents' | 'skills';
type KimiArtifactKindName = ArtifactKindName | 'kimi-agents';

// Mirrors the (unexported) ResolvedProfile in install-profiles.cts.
// Must stay in sync if that shape changes.
interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

/**
 * #2322: mirrors the (unexported) CapabilityRegistry shape in install-profiles.cts.
 * Threaded through resolveRuntimeArtifactLayout -> skillsKind so the skills-kind
 * stage() closure can bind a third-party capability skill stem to its DECLARING
 * capability (capabilityClusters) at staging time — never by scanning the
 * installed capabilities root and guessing. Optional: a caller with no registry
 * in scope gets a layout whose skills kind stages NOTHING third-party (fail
 * closed), matching install-profiles.cts's own registry-optional contract.
 */
interface CapabilityRegistryForSkills {
  capabilityClusters?: Record<string, string[]>;
  profileMembership?: Record<string, { tier: string; profiles: string[] }>;
}

/**
 * Cross-cutting context for descriptor-driven agent staging (ADR-1235 §1).
 * Passed as the optional second arg to ArtifactKind.stage() for agents kind
 * entries so that stageAgentsForRuntimeWithConverter can apply the exact
 * inline-loop transform order: pathRewrites → attribution → converter → normalize.
 */
interface AgentCtx {
  runtime: string;
  pathPrefix: string;
  attribution: string | null | undefined;
}

interface ArtifactKind {
  kind: KimiArtifactKindName;
  destSubpath: string;
  prefix: string;
  /** For agents kind with a converter, accepts an optional AgentCtx as the second
   *  arg so cross-cutting can be applied pre-converter (ADR-1235 §1). */
  stage: (resolvedProfile: ResolvedProfile, agentCtx?: AgentCtx) => string;
  /** Resolved absolute alternate install root for this kind, if the descriptor
   *  specifies one (e.g. codex skills → $HOME/.agents). Undefined means the
   *  kind installs under the runtime's normal configDir. */
  home?: string;
  /** Name of the converter function in Runtime Artifact Conversion exports, as
   *  declared on the descriptor's `converter` field. Only populated for the
   *  `skills` kind today — lets bespoke callers (e.g. the OpenCode-family
   *  combined installer, ADR-1239 / #2093) look up the descriptor-declared
   *  converter by name instead of re-deriving it from a runtime === check. */
  converter?: string;
}

interface Layout {
  runtime: string;
  configDir: string;
  scope?: 'local' | 'global';
  kinds: ArtifactKind[];
}

// ---------------------------------------------------------------------------
// Source root finders
// ---------------------------------------------------------------------------

/**
 * Locate the GSD commands/gsd source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findInstallSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) return src;
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'commands', 'gsd');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findInstallSourceRoot: could not locate commands/gsd from ${__dirname}`);
}

/**
 * Locate the GSD agents source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findAgentsSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) {
          // Marker points to commands/gsd; agents/ is a sibling of commands/
          const agentsCandidate = path.resolve(path.dirname(src), '..', 'agents');
          if (fs.existsSync(agentsCandidate)) return agentsCandidate;
        }
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'agents');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findAgentsSourceRoot: could not locate agents/ from ${__dirname}`);
}

// ---------------------------------------------------------------------------
// Layout table builders
// ---------------------------------------------------------------------------

function commandsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'commands',
    destSubpath,
    prefix,
    stage: (resolved) => stageSkillsForProfile(findInstallSourceRoot(configDir), resolved),
  };
}

function agentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'agents',
    destSubpath,
    prefix,
    // #2995: a `converter: null` agents entry (claude local, zcode) previously
    // staged via stageAgentsForProfile — a RAW byte copy that never reads content
    // into JS, so gsd:section markers shipped verbatim. Route through the
    // composing stager with an identity converter instead: same output as the raw
    // copy for an unmarked agent, markers stripped for a marked one. Routing both
    // agent kinds through the stager collapses what were five independent agent
    // read points down to three compose call sites: this stager, bin/install.js's
    // inline agent loop, and installCodexConfig's per-agent .toml writer. The
    // exhaustive per-runtime sweep in tests/agent-fragments-emission.install.test.cjs
    // is what keeps a fourth from appearing uncomposed.
    stage: (resolved) => stageAgentsForRuntimeWithConverter(
      findAgentsSourceRoot(configDir),
      resolved,
      (content: string) => content,
    ),
  };
}

/**
 * Build a converted-agents kind descriptor for runtimes whose agent `.md` files
 * need runtime-specific frontmatter/body conversion (e.g. Copilot, Cursor, Codex).
 *
 * Unlike `agentsKind` (which raw-copies source files), this kind applies
 * `converterName` from Runtime Artifact Conversion exports to each agent file
 * during staging, writing flat `${name}.md` files to the staged directory.
 *
 * Agent filenames are preserved verbatim (the prefix is already embedded in the
 * agent stem — e.g. `gsd-planner.md`).
 *
 * #1173 SCOPE — plumbing only (real install still elsewhere): this provides
 * the converter dispatch + `isGlobal` scope threading for the descriptor's
 * `agents` kind. As of #2092, 8 non-Claude runtimes DO declare a converted
 * `agents` kind in their `capability.json` — qwen (`convertClaudeAgentToQwenAgent`)
 * plus the 7 that already declared one before it (antigravity, augment,
 * codebuddy, copilot, cursor, trae, windsurf) — so the descriptor-level
 * declaration is no longer deferred. What IS still deferred is wiring
 * `resolveRuntimeArtifactLayout`'s `agents` kind into the REAL install:
 * `bin/install.js`'s agent-staging loop does not consume this module's
 * `convertedAgentsKind` resolution at all — it dispatches the very same
 * converter functions directly via `_hostBehaviors(runtime)` checks
 * (`frontmatterDialect`, `brandingRewrites`, `isCopilot`/`isAntigravity`/…),
 * duplicating the mapping declared here. That duplication is deliberate until
 * the second `layout.kinds` consumer — `applySurface` / `/gsd:surface` /
 * `--materialize` (`src/surface.cts`) — mirrors the legacy agent pipeline
 * (Copilot's `.agent.md` filename rename, the cross-cutting path-prefix
 * rewrite + attribution, stale-file cleanup, config-reading steps); declaring
 * `bin/install.js` itself against this resolver before then would risk
 * regressing the surface path. Until that follow-up lands, `bin/install.js`
 * remains authoritative for the real install, and this `convertedAgentsKind`
 * is exercised only by `/gsd:surface` and synthetic-descriptor seam tests.
 *
 * Mirrors the `convertedCommandsKind` pattern (#785).
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'agents')
 * @param prefix        filename prefix (informational; not applied here)
 * @param converterName name of converter function in Runtime Artifact Conversion exports
 * @param configDir     runtime config dir (for .gsd-source marker resolution)
 */
function convertedAgentsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  configDir: string,
  scope: 'local' | 'global' = 'global',
): ArtifactKind {
  return {
    kind: 'agents',
    destSubpath,
    prefix,
    stage: (resolved, agentCtx) => {
      // isGlobal is threaded so scope-aware agent converters (copilot, antigravity)
      // choose global-home vs workspace-relative paths; converters that only take
      // (content) ignore the extra positional arg. Mirrors skillsKind's scope
      // threading (#1173).
      // #2870: `scope` is this function's own parameter (default `'global'`,
      // so it is never undefined here), sourced upstream from the Install
      // Scope Module's resolved id. `isGlobalScope` projects it to the
      // boolean `stageAgentsForRuntimeWithConverter`'s positional API
      // requires — see its doc comment in install-scope.cts.
      const converter = conversionExports[converterName] as (content: string, isGlobal?: boolean) => string;
      // ADR-1235 §1: when agentCtx is provided (by createRuntimeArtifactInstallPlan
      // for descriptor-driven runtimes), thread it through so stageAgentsForRuntimeWithConverter
      // can apply the full pre-converter + post-converter sequence in the correct order.
      return stageAgentsForRuntimeWithConverter(
        findAgentsSourceRoot(configDir),
        resolved,
        converter,
        isGlobalScope(scope),
        agentCtx,
      );
    },
  };
}

function kimiAgentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'kimi-agents',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const buildKimiAgentArtifacts = conversionExports['buildKimiAgentArtifacts'] as (opts: {
        rootAgent?: string;
        subagents?: Array<{ path: string; content: string }>;
      }) => {
        root: { yaml: string; prompt: string };
        subagents: Array<{ name: string; yaml: string; prompt: string }>;
      };
      // #2995: compose at staging (identity converter) so the readFileSync below
      // sees marker-free content — same single composing stager as agentsKind.
      const stagedAgents = stageAgentsForRuntimeWithConverter(
        findAgentsSourceRoot(configDir),
        resolved,
        (content: string) => content,
      );
      const subagents: Array<{ path: string; content: string }> = [];
      if (fs.existsSync(stagedAgents)) {
        for (const entry of fs.readdirSync(stagedAgents, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const agentPath = path.join(stagedAgents, entry.name);
          subagents.push({
            path: posixNormalize(path.join('agents', entry.name)),
            content: fs.readFileSync(agentPath, 'utf8'),
          });
        }
      }

      const rootAgent = `---\nname: gsd\ndescription: Run GSD workflows in Kimi CLI.\ntools: Agent\n---\n\n# GSD for Kimi CLI\n\nCoordinate installed /skill:gsd-* workflows and route work to generated GSD subagents when a workflow requires an agent handoff.\n`;
      const artifacts = buildKimiAgentArtifacts({ rootAgent, subagents });
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-agents-'));
      installProfiles.STAGED_DIRS.add(stageDir);
      fs.writeFileSync(path.join(stageDir, 'gsd.yaml'), artifacts.root.yaml);
      fs.writeFileSync(path.join(stageDir, 'gsd.md'), artifacts.root.prompt);
      const subagentsDir = path.join(stageDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      for (const artifact of artifacts.subagents) {
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.yaml`), artifact.yaml);
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.md`), artifact.prompt);
      }
      return stageDir;
    },
  };
}

/**
 * Build a skills kind descriptor.
 *
 * @param destSubpath
 * @param prefix
 * @param converterName  name of converter function in Runtime Artifact Conversion exports
 * @param runtime        canonical runtime ID (gates Hermes/Qwen branding in converter)
 * @param configDir      runtime config dir (for .gsd-source marker resolution)
 * @param nested         if true, nest concrete skills under their ns-* routers (#69)
 * @param scope          install scope; converted to isGlobal and passed as 5th positional
 *                       arg so scope-aware converters (antigravity, copilot) can choose
 *                       between global home paths and workspace-relative paths without
 *                       colliding with the `runtime` string at position 3.
 * @param capabilityRegistry #2322: optional capability registry — captured in the
 *                       stage() closure so third-party capability skills are bound to
 *                       their declaring capId at staging time. Absent -> stage() stages
 *                       nothing third-party (fail closed).
 */
function skillsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  runtime: string,
  configDir: string,
  nested = false,
  scope: 'local' | 'global' = 'global',
  capabilityRegistry?: CapabilityRegistryForSkills,
): ArtifactKind {
  return {
    kind: 'skills',
    destSubpath,
    prefix,
    converter: converterName,
    stage: (resolved) => {
      const realConverter = conversionExports[converterName] as (content: string, skillName: string, runtime: string, cmdNames: string[], isGlobal: boolean) => string;
      // Compute cmdNames once per stage call for performance (#3583).
      // Extra trailing args are ignored by converters that don't need them. The
      // isGlobal flag is the 5th positional (NOT the 3rd): the 3rd positional is
      // `runtime` for the claude/kimi/cline converters, so the scope-aware
      // converters (antigravity, copilot) read isGlobal from position 5 to avoid
      // colliding with `runtime` and always taking the global branch.
      const cmdNames = conversionExports.readGsdCommandNames
        ? conversionExports.readGsdCommandNames()
        : [];
      // #2870: same judgment as convertedAgentsKind above — `scope` is this
      // function's own parameter (default `'global'`, so it is never
      // undefined here); `isGlobalScope` projects it to the boolean
      // `realConverter`'s positional `isGlobal` arg requires.
      const isGlobal = isGlobalScope(scope);
      const wrappedConverter = (content: string, skillName: string): string =>
        realConverter(content, skillName, runtime, cmdNames, isGlobal);
      return stageSkillsForRuntimeAsSkills(findInstallSourceRoot(configDir), resolved, wrappedConverter, prefix, nested, capabilityRegistry);
    },
  };
}

/**
 * Build a converted-commands kind descriptor for runtimes that use a flat
 * commands directory with per-file conversion (e.g. Cursor 1.6 slash commands).
 *
 * Unlike `commandsKind` (which passes raw source files through), this kind
 * applies `converterName` from Runtime Artifact Conversion exports to each file during
 * staging, writing flat `${prefix}${stem}.md` files to the staged directory.
 *
 * The staged files are then written by `_copyStaged` (commands branch) which
 * handles prefix logic via the existing layout machinery.
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'commands')
 * @param prefix        filename prefix, e.g. 'gsd-'
 * @param converterName name of converter function in Runtime Artifact Conversion exports
 * @param configDir     runtime config dir (for .gsd-source marker resolution)
 */
function convertedCommandsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  configDir: string,
): ArtifactKind {
  return {
    kind: 'commands',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const converter = conversionExports[converterName] as (content: string, commandName: string) => string;
      return stageCommandsForRuntimeFlat(findInstallSourceRoot(configDir), resolved, converter, prefix);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Nested skill-bundle support matrix (#69)
// ---------------------------------------------------------------------------
//
// When a runtime's skill loader scans only one level deep (non-recursive), a
// concrete skill nested at `<router>/skills/<name>/SKILL.md` drops out of the
// eager top-level listing yet stays readable by file path — which is exactly
// what namespace routing needs. Recursive loaders surface every nested SKILL.md
// as a peer (zero token saving), so they stay flat. Unconfirmed loaders stay
// flat conservatively. Verified June 2026:
//
//   NEST (confirmed non-recursive / one-level scan):
//     cline      — cline/cline skills.ts scanSkillsDirectory uses flat fs.readdir
//     qwen       — QwenLM/qwen-code skill-load.ts flat readdir ("depth 2 enough")
//     hermes     — hermes-agent.nousresearch.com/docs/user-guide/features/skills
//                  (single-level subdir probe of the tap path)
//     augment    — https://docs.augmentcode.com/cli/skills (flat single-level)
//     trae       — docs.trae.ai/ide/skills + Trae-AI/TRAE#2253 (flat; nesting errors)
//                  Trae IDE (trae.ai), not trae-agent — see runtime-homes.cts header note
//   FLAT (recursive loader → nesting gives no saving):
//     cursor     — https://cursor.com/docs/skills (walks skills root recursively)
//     opencode   — sst/opencode skill/index.ts glob "skills/**/SKILL.md"
//     kilo       — Kilo-Org/kilocode (opencode fork, same ** glob)
//
//   FLAT (one-level scan, but concrete skills must be directly discoverable):
//     antigravity— https://antigravity.google/docs/skills + /docs/cli-plugins
//                  (skills live at <skills-dir>/<skill-folder>/SKILL.md; AGY does not
//                   register router-nested concrete skills as slash commands)
//
//   FLAT (reverted from nested — nested skills not discoverable by Skill tool, #924):
//     claude     — https://code.claude.com/docs/en/skills + anthropics/claude-code#28266
//                  (one-level scan under ~/.claude/skills — but Skill-tool errors on unknown
//                   names rather than re-routing via the router; concrete skills must be
//                   at the top level so Skill(skill="gsd-plan-phase") succeeds)
//
//   FLAT (nested-scan behaviour unconfirmed → conservative):
//     codex      — developers.openai.com/codex/skills/
//     copilot    — docs.github.com/en/copilot/concepts/agents/about-agent-skills
//     windsurf   — docs.devin.ai/desktop/cascade/skills
//     codebuddy  — codebuddy.ai/docs/cli/skills

// ---------------------------------------------------------------------------
// Descriptor-driven dispatch helpers (ADR-857 phase 5d)
// ---------------------------------------------------------------------------

interface ArtifactKindDescriptor {
  kind: string;
  destSubpath: string;
  prefix: string;
  nesting: 'flat' | 'nested';
  recursive: boolean;
  converter: string | null;
  /** Optional alternate install home, relative to the user's home directory
   *  (e.g. ".agents" for codex skills → $HOME/.agents/skills). When absent,
   *  the kind installs under the runtime's normal configDir. */
  home?: string;
}

interface ArtifactLayoutDescriptor {
  global: ArtifactKindDescriptor[];
  local: ArtifactKindDescriptor[];
}

/** Lazy registry accessor — mirrors pattern from 5b/5c (runtime-homes.cts). */
interface RegistryLike {
  runtimes: Record<string, { runtime?: { artifactLayout?: ArtifactLayoutDescriptor } }>;
}

function getRegistry(): RegistryLike {
  return _require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: { artifactLayout?: ArtifactLayoutDescriptor } }>;
  };
}

/**
 * Map a single ArtifactKindDescriptor entry to an ArtifactKind using the
 * matching builder function. Mirrors the hand-built calls in the old switch.
 */
function dispatchKindEntry(entry: ArtifactKindDescriptor, runtime: string, configDir: string, scope: 'local' | 'global', capabilityRegistry?: CapabilityRegistryForSkills): ArtifactKind {
  const { kind, destSubpath, prefix, nesting, converter } = entry;
  const nested = nesting === 'nested';

  let result: ArtifactKind;
  switch (kind) {
    case 'commands':
      result = converter == null
        ? commandsKind(destSubpath, prefix, configDir)
        : convertedCommandsKind(destSubpath, prefix, converter, configDir);
      break;

    case 'agents':
      result = converter == null
        ? agentsKind(destSubpath, prefix, configDir)
        : convertedAgentsKind(destSubpath, prefix, converter, configDir, scope);
      break;

    case 'skills':
      if (converter == null) {
        throw new TypeError(
          `resolveRuntimeArtifactLayout: skills entry for '${runtime}' has converter=null (converter is required for skills)`,
        );
      }
      result = skillsKind(destSubpath, prefix, converter, runtime, configDir, nested, scope, capabilityRegistry);
      break;

    case 'kimi-agents':
      result = kimiAgentsKind(destSubpath, prefix, configDir);
      break;

    default:
      throw new TypeError(
        `resolveRuntimeArtifactLayout: unknown kind '${kind}' in descriptor for runtime '${runtime}'`,
      );
  }

  // scope is guaranteed 'local' | 'global' here: resolveRuntimeArtifactLayoutFromRegistry
  // (the only caller of dispatchKindEntry) throws TypeError before this point if scope is
  // anything else (see the `scope !== 'local' && scope !== 'global'` guard above its
  // dispatchKindEntry call), so isGlobalScope's throw-on-invalid-input never fires here.
  if (isGlobalScope(scope) && typeof entry.home === 'string' && entry.home !== '') {
    result.home = path.join(os.homedir(), entry.home);
  }

  return result;
}

/**
 * Resolve the artifact layout for a given runtime and config directory.
 *
 * ADR-857 phase 5d: driven by the capability-registry artifactLayout descriptor
 * instead of a hardcoded switch statement.
 *
 * @param capabilityRegistry #2322: optional — when the caller has a composed
 *   capability registry in scope (e.g. capability-writer.cts's `capability set`
 *   path, or a fresh install's registry-aware profile resolution), pass it here
 *   so the skills kind's stage() closure can materialize installed third-party
 *   capability skills bound to their declaring capId. Both call paths (surface
 *   apply AND the installer) must pass their registry here — resolveProfile's
 *   own `'*'` (full profile) short-circuit never carries a registry, so if it
 *   is not threaded in at layout-build time a `full`-profile install stages no
 *   third-party capability skills regardless of registration (#2322 blocker 2).
 */
function resolveRuntimeArtifactLayout(runtime: string, configDir: string, scope: 'local' | 'global' = 'global', capabilityRegistry?: CapabilityRegistryForSkills): Layout {
  return resolveRuntimeArtifactLayoutFromRegistry(getRegistry(), runtime, configDir, scope, capabilityRegistry);
}

function resolveRuntimeArtifactLayoutFromRegistry(
  registry: RegistryLike,
  runtime: string,
  configDir: string,
  scope: 'local' | 'global' = 'global',
  capabilityRegistry?: CapabilityRegistryForSkills,
): Layout {
  if (typeof configDir !== 'string' || configDir === '') {
    throw new TypeError('configDir must be a non-empty string');
  }
  if (scope !== 'local' && scope !== 'global') {
    throw new TypeError('scope must be "local" or "global"');
  }

  const desc = registry.runtimes[runtime]?.runtime?.artifactLayout;
  if (!desc) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  const entries: ArtifactKindDescriptor[] = desc[scope] ?? [];
  const kinds: ArtifactKind[] = entries.map((entry) => dispatchKindEntry(entry, runtime, configDir, scope, capabilityRegistry));

  return { runtime, configDir, scope, kinds };
}

// ---------------------------------------------------------------------------
// resolveTriggerSurface (#2871 Phase 2)
// ---------------------------------------------------------------------------
//
// Widens this module from PLACEMENT (resolveRuntimeArtifactLayout, above —
// untouched, still 7 callers) to TRIGGER resolution: "what does a user type"
// rather than "where does a file land". A new function, not a widened
// signature — see .gsd/phase/feat-2871-trigger-resolution/40-design.md.
//
// Only `commands` and `skills` are trigger-bearing. `agents` / `kimi-agents`
// are a SEPARATE dispatch interface point (subagent invocation via
// `subagent_type` / named dispatch, never a `/gsd-<name>` a user types) — see
// 40-design.md's "agents are not trigger-bearing" correction to ADR-2866.
// Excluding them here is deliberate, not an oversight: including `agents`
// would misreport windsurf (whose global scope emits agents only) as fully
// shadowing its local `/gsd-*` surface, when in fact nothing shadows it.

/** The trigger-bearing subset of ArtifactKindName — mirrors
 *  VALID_TRIGGER_PRECEDENCE_KINDS in capability-validator.cjs (kept as two
 *  literal-typed surfaces rather than importing a runtime Set into a type
 *  position; tests assert the two vocabularies parity-match via
 *  DEFAULT_TRIGGER_PRECEDENCE). */
type TriggerKindName = 'commands' | 'skills';

/** 'direct': the host itself registers this trigger. 'via-router': only the
 *  owning router is registered by the host; this trigger is reachable
 *  because the router's body was rewritten to `Read` it (#69 nested-skill
 *  bundles — install-profiles.cts:714-723). See 40-design.md's "Nested-router
 *  children" section for why a boolean cannot carry this distinction.
 *
 *  Not `export`ed: matches this file's existing house style (`Layout`,
 *  `ArtifactKind`, etc. are internal types too) — `export =` at the bottom
 *  of this module is its sole export surface, and mixing it with named type
 *  exports is unnecessary since the only external consumer of these shapes
 *  is a plain-JS test file. */
type TriggerRegistration = 'direct' | 'via-router';

interface TriggerShadower {
  kind: TriggerKindName;
  scope: InstallScope;
}

interface TriggerSurface {
  /** What the user types, e.g. `gsd-plan-phase`. Always `${prefix}${stem}` —
   *  unaffected by the destPath branch below (see `destPath`). */
  trigger: string;
  kind: TriggerKindName;
  scope: InstallScope;
  /** Where the artifact is staged, mirroring `_copyStaged`'s actual write
   *  (`install-engine.cts:404-493`) INCLUDING its `namespacedByDir` branch
   *  (~L464-466): a `commands` kind whose `destSubpath` basename equals
   *  `prefix` minus its trailing hyphen is written bare (no prefix on the
   *  filename) because the directory itself is the namespace. */
  destPath: string;
  registration: TriggerRegistration;
  /** The owning router's trigger string, only when `registration ===
   *  'via-router'`; `null` otherwise (including for the router's own entry —
   *  a router has no router of its own). */
  routerTrigger: string | null;
  /** The winning sibling entry for this SAME trigger, or `null` when this
   *  entry is itself unshadowed (including when it is the only candidate).
   *  Reported as a fact, never a defect — see 40-design.md's "Not-corruption"
   *  section: same-kind shadowing across scopes is the healthy, expected
   *  state for every both-scope runtime. */
  shadowedBy: TriggerShadower | null;
}

interface TriggerSurfaceOpts {
  /** Source command/skill stems present for this call, shared across every
   *  trigger-bearing kind entry — mirrors ResolvedProfile's flat stem
   *  membership at staging time (install-profiles.cts). */
  stems: string[];
  /** Subset of `stems` that are namespace routers (nested-router runtimes
   *  only, #69). Absent or empty ⇒ no nested-router distinction is made —
   *  every stem resolves `registration: 'direct'`, matching the caller's own
   *  choice not to supply router membership. */
  routerStems?: string[];
  /** Concrete stem -> owning router stem(s); mirrors
   *  buildNamespaceBundleMap's childToRouters shape. Only consulted for a
   *  stem that is NOT itself in `routerStems`, on a `nesting: 'nested'` kind
   *  entry. The first named router is used. */
  childToRouters?: Record<string, string[]>;
  /** Registry override — the SAME seam resolveRuntimeArtifactLayoutFromRegistry
   *  already exposes. Lets a synthetic descriptor be exercised without
   *  touching the real capability-registry. */
  registry?: TriggerRegistryLike;
}

interface RuntimeDescriptorForTriggers {
  artifactLayout?: ArtifactLayoutDescriptor;
  /** Ordered kind precedence, highest priority first (#2871 Phase 2). Absent
   *  ⇒ capability-validator.cjs's DEFAULT_TRIGGER_PRECEDENCE applies — see
   *  `getDefaultTriggerPrecedence` below. */
  triggerPrecedence?: string[];
}

interface TriggerRegistryLike {
  runtimes: Record<string, { runtime?: RuntimeDescriptorForTriggers }>;
}

function getTriggerRegistry(): TriggerRegistryLike {
  return _require('./capability-registry.cjs') as TriggerRegistryLike;
}

/**
 * capability-validator.cjs is a COMMITTED plain .cjs (not built from a .cts
 * source — see its own header comment), so it is required the same way
 * capability-registry.cjs is above: a lazy `_require` rather than a static
 * ES import. DEFAULT_TRIGGER_PRECEDENCE is the single source of truth for
 * "what applies when a descriptor omits triggerPrecedence"; this module
 * reads it rather than re-declaring `['skills', 'commands']` as a second
 * literal that could silently drift from the validator's own default.
 */
function getDefaultTriggerPrecedence(): string[] {
  const capValidator = _require('./capability-validator.cjs') as { DEFAULT_TRIGGER_PRECEDENCE: string[] };
  return capValidator.DEFAULT_TRIGGER_PRECEDENCE;
}

const SCOPE_ORDER: readonly InstallScope[] = ['global', 'local'];

/**
 * True when candidate `a` should win over the current best `b` for the same
 * trigger. Scope rank first (Phase 1's `install-scope.cts#scopeRank` —
 * global outranks local; NOT re-derived here), then the runtime's
 * `triggerPrecedence` kind ordering (lower index = higher priority). A kind
 * absent from `precedenceRank` (should not happen — every entry's kind is
 * validated against the same closed vocabulary the precedence list draws
 * from) sorts last rather than throwing, so a malformed precedence value
 * degrades to "leaves the incumbent standing" instead of corrupting the
 * whole resolution.
 */
function isHigherPriority(a: TriggerSurface, b: TriggerSurface, precedenceRank: Map<string, number>): boolean {
  const rankA = scopeRank(a.scope);
  const rankB = scopeRank(b.scope);
  if (rankA !== rankB) return rankA > rankB;
  const pa = precedenceRank.get(a.kind) ?? Number.POSITIVE_INFINITY;
  const pb = precedenceRank.get(b.kind) ?? Number.POSITIVE_INFINITY;
  return pa < pb;
}

/**
 * Resolve the `/gsd-<name>`-style trigger surface for a runtime: what the
 * user types, at which scope, whether it wins or is shadowed, and (for
 * nested-router runtimes) whether the host registers it directly or only
 * reaches it through a router. Pure — no filesystem, no mutation of `scopes`
 * or `opts`, and safe against a caller mutating the returned array/objects
 * (a fresh array/objects are built on every call; nothing is cached or
 * shared across calls beyond the read-only registry module).
 *
 * Only `commands` and `skills` kind entries are considered — see the
 * module-level comment above. `resolveRuntimeArtifactLayout` is untouched by
 * this function; they are independent readers of the same descriptor.
 *
 * @throws {TypeError} for an unknown runtime — same contract (and message
 *   shape) as `resolveRuntimeArtifactLayoutFromRegistry`.
 */
function resolveTriggerSurface(runtime: string, scopes: InstallScope[], opts: TriggerSurfaceOpts): TriggerSurface[] {
  const registry = opts.registry ?? getTriggerRegistry();
  const runtimeDescriptor = registry.runtimes[runtime]?.runtime;
  const layout = runtimeDescriptor?.artifactLayout;
  if (!layout) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  const scopeSet = new Set(scopes);
  const stems = opts.stems ?? [];
  const routerStemSet = new Set(opts.routerStems ?? []);
  const childToRouters = opts.childToRouters ?? {};
  const precedence = runtimeDescriptor?.triggerPrecedence ?? getDefaultTriggerPrecedence();
  const precedenceRank = new Map(precedence.map((kind, index) => [kind, index]));

  const surfaces: TriggerSurface[] = [];

  for (const scope of SCOPE_ORDER) {
    if (!scopeSet.has(scope)) continue;
    const entries = layout[scope] ?? [];
    for (const entry of entries) {
      if (entry.kind !== 'commands' && entry.kind !== 'skills') continue; // excludes agents/kimi-agents
      const kind = entry.kind;
      const destSubpath = posixNormalize(entry.destSubpath);
      const destLast = path.posix.basename(destSubpath);
      const prefixStem = entry.prefix ? entry.prefix.replace(/-$/, '') : '';
      // Mirrors _copyStaged's namespacedByDir branch exactly (install-engine.cts
      // ~L464-466): a commands kind whose destSubpath basename equals the prefix
      // stem is written bare (directory IS the namespace).
      const namespacedByDir = kind === 'commands' && destLast === prefixStem;
      const nested = entry.nesting === 'nested';

      for (const stem of stems) {
        const trigger = `${entry.prefix}${stem}`;
        let destPath: string;
        if (kind === 'skills') {
          destPath = `${destSubpath}/${entry.prefix}${stem}`;
        } else if (namespacedByDir) {
          destPath = `${destSubpath}/${stem}.md`;
        } else {
          destPath = `${destSubpath}/${entry.prefix}${stem}.md`;
        }

        let registration: TriggerRegistration = 'direct';
        let routerTrigger: string | null = null;
        if (nested && routerStemSet.size > 0 && !routerStemSet.has(stem)) {
          const owningRouters = childToRouters[stem];
          const routerStem = owningRouters && owningRouters.length > 0 ? owningRouters[0] : undefined;
          if (routerStem !== undefined && routerStemSet.has(routerStem)) {
            registration = 'via-router';
            routerTrigger = `${entry.prefix}${routerStem}`;
          }
        }

        surfaces.push({ trigger, kind, scope, destPath, registration, routerTrigger, shadowedBy: null });
      }
    }
  }

  // Winner computation, per trigger string, across every scope/kind candidate.
  const groups = new Map<string, TriggerSurface[]>();
  for (const surface of surfaces) {
    const group = groups.get(surface.trigger);
    if (group) {
      group.push(surface);
    } else {
      groups.set(surface.trigger, [surface]);
    }
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue; // sole candidate: unshadowed by construction
    let winner = group[0];
    for (let i = 1; i < group.length; i++) {
      const candidate = group[i];
      if (isHigherPriority(candidate, winner, precedenceRank)) winner = candidate;
    }
    for (const surface of group) {
      if (surface !== winner) {
        surface.shadowedBy = { kind: winner.kind, scope: winner.scope };
      }
    }
  }

  return surfaces;
}

// getInstallExports removed in ADR-1508 / #1511 Phase 2 (last upward .cts→install.js dep).
export = { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry, findInstallSourceRoot, resolveTriggerSurface };
