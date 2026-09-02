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
// #2874 (ADR-58 cleanup phase): route this module's fs calls through the
// installRuntimeArtifacts call tree's injectable seam — see
// install-fs-adapter.cts's module doc. Resolves to real `node:fs` (the
// `fs` import above stays for type-only references, e.g. `fs.Dirent`)
// unless the top-level installRuntimeArtifacts call injected a `deps.fs`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs, mkInstallTempDir } = installFsAdapter;
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
// #2875 Part 2 (J8): shared model-override precedence resolver — see its
// module doc for why kilo/opencode MUST resolve through this ONE function
// rather than re-deriving the chain per runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installModelOverrideResolver = require('./install-model-override-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- export= CommonJS module, same as the sibling resolver import above
import installEffortResolver = require('./install-effort-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- export= CommonJS module, same as the sibling resolver import above
import modelCatalog = require('./model-catalog.cjs');
import { posixNormalize } from './shell-command-projection.cjs';
// #2870: `isGlobalScope` centralizes the `scope === 'global'` boolean
// projection both kind-builder closures below need at the converters'
// positional `isGlobal` boundary (see its doc comment in install-scope.cts
// for why the projection is centralized rather than eliminated).
import { isGlobalScope, scopeRank, validateScopeId, SCOPE_ORDER, type InstallScope } from './install-scope.cjs';

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
  /** #2875 Part 2 (row I1-I3): install root, threaded through to the
   *  frontmatter-extensions step and (for kilo/opencode's converters) the
   *  per-agent model-override resolution below. Mirrors install-profiles.cts's
   *  identically-named AgentCtx field — see its doc comment. */
  targetDir?: string | null;
  /** Project/config discovery root, distinct from global artifact destinations. */
  projectDir?: string | null;
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
  // Step 1: marker check — reads `<runtimeConfigDir>/.gsd-source`, a path
  // under the INSTALL DESTINATION, so this probe goes through the injected
  // adapter (installFs()).
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (installFs().existsSync(markerPath)) {
      try {
        const src = installFs().readFileSync(markerPath, 'utf8').trim();
        if (src && installFs().existsSync(src)) return src;
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname to locate the GSD PACKAGE'S OWN source
  // tree (commands/gsd/) — this resolves where the installer's own code is
  // running FROM, not anything under the install destination, so it is
  // deliberately NOT routed through the injected fs adapter (#2874): a fake
  // "destination" adapter has no reason to know about the real package's own
  // on-disk layout (an injected adapter's store starts empty and is never
  // seeded with real repo paths), and routing it through would make this
  // resolution unconditionally throw rather than gracefully staging nothing.
  //
  // Uses `fs.statSync` in a try/catch rather than `fs.existsSync` — this is
  // LOAD-BEARING, not a style choice: tests/executed-plan.test.cjs's F2 cases
  // poison every method on the ROUTED fs surface (including `existsSync`,
  // since installFs()'s REAL_ADAPTER also calls it) to prove nothing on the
  // installRuntimeArtifacts call tree reaches real fs. The F2 "nativePlugin
  // runtime: pi" test calls this function (via findInstallSourceRoot()) AFTER
  // installing that poison, specifically to resolve the pi nativePlugin
  // source path against this repo's own real layout — an operation this
  // function must still be able to perform even while `existsSync` is
  // poisoned, because this Step 2 walk is real-fs-only by design and was
  // never meant to be covered by that poison list. `statSync` is not on the
  // poisoned surface, so this probe survives; switching back to `existsSync`
  // makes that F2 test throw (verified: reverting this to `existsSync` trips
  // the poison and breaks the pi nativePlugin case).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'commands', 'gsd');
    try {
      fs.statSync(candidate);
      return candidate;
    } catch { /* not here — keep walking up */ }
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
  // Step 1: marker check (destination-relative — routed through installFs()).
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (installFs().existsSync(markerPath)) {
      try {
        const src = installFs().readFileSync(markerPath, 'utf8').trim();
        if (src && installFs().existsSync(src)) {
          // Marker points to commands/gsd; agents/ is a sibling of commands/
          const agentsCandidate = path.resolve(path.dirname(src), '..', 'agents');
          if (installFs().existsSync(agentsCandidate)) return agentsCandidate;
        }
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname — locates THIS package's own agents/
  // source tree, not the install destination. See findInstallSourceRoot's
  // Step 2 comment (#2874) for why this stays unrouted, real-fs-only, and why
  // it uses `statSync` rather than `existsSync` (load-bearing against F2's
  // poison of the routed fs surface, not a style choice).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'agents');
    try {
      fs.statSync(candidate);
      return candidate;
    } catch { /* not here — keep walking up */ }
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
    // #2875 Part 2 (row I2): agentCtx threaded through so a runtime using this
    // converter:null builder (claude, plus any future identity-copy runtime)
    // ALSO gets path-rewrites/attribution/frontmatter-extensions/normalize
    // when a caller supplies agentCtx (createRuntimeArtifactInstallPlan /
    // applySurface's agentCtx build). Previously this closure's `(resolved) =>`
    // signature silently dropped the second arg every caller already passed —
    // a caller with NO agentCtx in scope is unaffected (row I2: converter-only,
    // as today), matching stageAgentsForRuntimeWithConverter's own contract.
    stage: (resolved, agentCtx) => stageAgentsForRuntimeWithConverter(
      findAgentsSourceRoot(configDir),
      resolved,
      (content: string) => content,
      false,
      agentCtx,
    ),
  };
}

/**
 * Runtime allowlist check for a descriptor-declared `converter` name, applied
 * at DISPATCH time (security fix). `VALID_CONVERTER_NAMES` (capability-
 * validator.cjs) is otherwise enforced ONLY at lint/build time
 * (`check:contract-drift`) — every `conversionExports[converterName]`
 * dynamic-property read below trusted that a `capability.json` reaching this
 * far had already passed that check. It had not, in general: a hand-edited
 * or malformed descriptor naming an Object-prototype member (`"constructor"`,
 * `"toString"`, `"hasOwnProperty"`, ...) resolves to that member instead of
 * throwing, producing garbage staged content rather than a loud failure —
 * pre-existing, but promoted from the `/gsd-surface`-only path to the real
 * install path for seven runtimes by #2875 Part 2's agents-bypass closure.
 * Required lazily (call-time, not module-top) to avoid a load-time circular
 * require, the same pattern install-engine.cts's `_hostBehaviors` already
 * uses for `capability-registry.cjs`. Fails CLOSED: any error loading the
 * allowlist itself (missing module, exotic bundling) is treated as "nothing
 * is allowed", never as "skip the check".
 */
function _resolveNamedConverter(converterName: string, kindLabel: string): (...args: unknown[]) => unknown {
  let validNames: Set<string> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    validNames = (require('./capability-validator.cjs') as { VALID_CONVERTER_NAMES: Set<string> }).VALID_CONVERTER_NAMES;
  } catch {
    validNames = undefined;
  }
  if (!validNames || !validNames.has(converterName)) {
    throw new Error(
      `Unknown converter "${converterName}" declared for a ${kindLabel} kind — refusing to dispatch (not in capability-validator.cjs's VALID_CONVERTER_NAMES allowlist).`,
    );
  }
  const fn = conversionExports[converterName];
  if (typeof fn !== 'function') {
    throw new Error(`Converter "${converterName}" is allowlisted but is not an exported function of runtime-artifact-conversion.cjs.`);
  }
  return fn as (...args: unknown[]) => unknown;
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
 * #1173 SCOPE, updated by #2875 Part 2 (the agents-bypass closure) — measured
 * against the tree, not the ADR-3574 framing that preceded it:
 *
 * Of the four blockers this comment used to name for wiring `bin/install.js`'s
 * inline agent loop against this resolver, THREE were already stale by the
 * time #2875 measured them and are not re-litigated here: Copilot's
 * `.agent.md` rename (the loop's own `destName = entry.name` comment records
 * the ternary dropped in #2099; the descriptor fold applies it via
 * `hostBehaviors.agentFileExtension`), the cross-cutting path-prefix rewrite +
 * attribution (`stageAgentsForRuntimeWithConverter` already applies
 * `applyAgentPathRewrites` -> `processAttribution` when `agentCtx` is
 * present), and stale-file cleanup (`_removeGsdEntries` prunes every
 * `gsd-`-prefixed entry in a kind's destSubpath, broader than the loop's own
 * extension-gated check).
 *
 * The fourth — config-reading steps — was the real gap, and #2875 Part 2
 * closed it: `stageAgentsForRuntimeWithConverter` now takes a per-file
 * `agentName` (`agentCtx.agentName`, ADR-1235 §1) and a `targetDir`
 * (`agentCtx.targetDir`), which together let it (a) run a post-converter
 * frontmatter-extensions step (`applyAgentFrontmatterExtensions`, driven by
 * `hostBehaviors.agentFrontmatterExtensions` — Claude's `effort` +
 * `disallowedTools` injection) and (b) let THIS function resolve a per-agent
 * model override (`installModelOverrideResolver.resolveAgentModelOverride`,
 * `model_overrides[agent]` > `model_profile_overrides.<rt>.<tier>` > omit)
 * before invoking a converter that needs it (kilo/opencode). Both pieces —
 * plus a data-driven Hermes branding converter
 * (`convertClaudeAgentToHermesAgent`, reading `hostBehaviors.brandingRewrites`
 * rather than a hardcoded string table) — are single-sourced: `bin/install.js`
 * requires the SAME functions this module does, so its inline loop and the
 * descriptor path can no longer independently drift (the CLAUDE.md
 * "Generative Fix Divergence" class the prior duplication risked).
 *
 * `tests/agent-descriptor-parity.test.cjs` proves byte-identical output
 * between the inline loop and a SYNTHETIC descriptor registry (the same
 * override seam `resolveRuntimeArtifactLayoutFromRegistry` exposes) for all
 * six runtimes the inline loop still served: claude, cline, codex, hermes,
 * kilo, opencode.
 *
 * Both findings the prior revision of this comment named as STILL deferred
 * are now CLOSED (#2875 Part 2 Task A/B/C), measured against the real
 * `capability.json` entries and the real production entry points, not
 * argued from this module alone:
 *
 * 1. **kilo/opencode reaching `layout.kinds`.** `installEngine.
 *    installAgentsKindStandalone` (install-engine.cts) is called from inside
 *    `installOpencodeFamilyArtifacts` and resolves the agents kind through
 *    THIS SAME `resolveRuntimeArtifactLayout`/`convertedAgentsKind` path —
 *    `installOpencodeFamilyArtifacts` no longer stages only `commands` +
 *    `skills`. `bin/install.js`'s legacy-flat local path (claude-local,
 *    `hostBehaviors.localInstallStyle === 'legacy-flat'`) reaches the SAME
 *    generic loop only via `installRuntimeArtifacts`'s conditional
 *    `_isSkillsRuntime` branch; a call to `installAgentsKindStandalone` was
 *    added at claude-local's own call site to cover that scope too — the
 *    install-tree golden fixture (`tests/fixtures/install-tree/claude-local.json`)
 *    is what caught the gap when it was first missed.
 * 2. **`/gsd:surface` / `applySurface` activation.** Confirmed convergent,
 *    not merely non-broken: for all six runtimes (claude, cline, codex,
 *    hermes, kilo, opencode), staging via `applySurface` into a freshly
 *    wiped `agents/` directory produces byte-identical output (including
 *    filenames) to `installRuntimeArtifacts`'s own write — verified directly
 *    against the built registry, not inferred.
 *
 * The inline loop (`_DESCRIPTOR_AGENTS_RUNTIMES` and the `bin/install.js`
 * agent-staging block it gated) is DELETED — every runtime the registry
 * declares an `agents` kind for is descriptor-driven now, including a
 * seventh runtime (`kimi-code`) this comment's own prior measurement missed
 * (it fell through the inline loop's generic `else if` branch, same as
 * claude, with no dedicated dialect arm — caught by the same golden fixture).
 *
 * Codex's `config.toml [agents.gsd-*]` strip (`bin/install.js`, under
 * `isMinimalMode` + `hostBehaviors.tomlConfigInstall`) remains the one
 * genuinely out-of-scope constraint: it mutates a host config file, not the
 * agents directory, and no descriptor kind models host-config mutation. It
 * stays exactly where it is.
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
      // #2870: `scope` is this function's own parameter (default `'global'`,
      // so it is never undefined here), sourced upstream from the Install
      // Scope Module's resolved id. `isGlobalScope` projects it to the
      // boolean `stageAgentsForRuntimeWithConverter`'s positional API
      // requires — see its doc comment in install-scope.cts.
      const rawConverter = _resolveNamedConverter(converterName, 'agents') as
        (content: string, arg2?: boolean | { isAgent?: boolean; modelOverride?: string | null; variant?: string | null }) => string;

      // #2875 Part 2 (J5-J8): kilo/opencode agent converters take an options
      // bag (`{isAgent, modelOverride}`), not the `isGlobal` boolean every
      // other agent converter's 2nd positional arg means — mirrors the
      // inline loop's per-runtime `frontmatterDialect === 'opencode' | 'kilo'`
      // branches (bin/install.js), which resolve model_overrides[agent] >
      // model_profile_overrides.<runtime>.<tier> > omit BEFORE calling the
      // converter. Resolved ONCE per stage() call (not per file — a pure
      // function of configDir/targetDir) via the single shared precedence
      // resolver so kilo and opencode can never diverge (J8).
      const needsModelOverride = converterName === 'convertClaudeToOpencodeFrontmatter' || converterName === 'convertClaudeToKiloFrontmatter';
      let converter: (content: string, isGlobal?: boolean, meta?: { agentName: string }) => string;
      if (needsModelOverride) {
        const overrideTargetDir = agentCtx?.targetDir ?? configDir;
        const modelOverrides = installModelOverrideResolver.readGsdEffectiveModelOverrides(overrideTargetDir);
        const runtimeResolver = installModelOverrideResolver.readGsdRuntimeProfileResolver(overrideTargetDir);
        // #3706: the resolved reasoning effort, threaded exactly as the model is —
        // config read ONCE per stage(), per-agent value resolved per file.
        //
        // Gated on the effort config being PRESENT, not on a value coming back.
        // `resolveInstallTimeEffort` always returns something (measured: 'high'
        // even with no project config and no effort block), so "skip when
        // resolution yields no value" has no trigger and would stamp `variant:`
        // into every generated agent file for every existing install. OpenCode's
        // built-in variant sets are provider-specific upstream (Anthropic ships
        // only `high`/`max`), so a level GSD resolved is not guaranteed to name a
        // variant the user's provider actually has — emitting one unasked-for is
        // the risk this gate avoids. #1156's rule for `model: inherit` is the
        // precedent: do not emit a key the runtime may not understand.
        //
        // OpenCode only; the kilo converter ignores the field (no EFFORT_ARGV.kilo).
        const effortConfig = converterName === 'convertClaudeToOpencodeFrontmatter'
          ? installEffortResolver.readGsdEffectiveEffortConfig(overrideTargetDir)
          : null;
        converter = (content, _isGlobal, meta) => {
          const modelOverride = meta
            ? installModelOverrideResolver.resolveAgentModelOverride(meta.agentName, modelOverrides, runtimeResolver)
            : null;
          // The universal level is NOT emitted raw. `clampEffortForHost` is the
          // declared OpenCode effort capability (EFFORT_ARGV.opencode: its own
          // `supported` set + `clamp`), and it is what rejects a level that is
          // not a wire value — most importantly `inherit`, which per #3533 (10d)
          // means "omit the key and follow the host default" and must never be
          // written literally. Anything unsupported clamps to null, which omits
          // the key rather than inventing one.
          const universal = effortConfig && meta
            ? installEffortResolver.resolveInstallTimeEffort(effortConfig, meta.agentName)
            : null;
          const variant = universal ? modelCatalog.clampEffortForHost('opencode', universal) : null;
          return rawConverter(content, { isAgent: true, modelOverride, variant });
        };
      } else {
        // isGlobal is threaded so scope-aware agent converters (copilot, antigravity)
        // choose global-home vs workspace-relative paths; converters that only take
        // (content) ignore the extra positional arg. Mirrors skillsKind's scope
        // threading (#1173).
        converter = (content) => rawConverter(content, isGlobalScope(scope));
      }
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
    stage: (resolved, agentCtx) => {
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
        false,
        agentCtx,
      );
      const subagents: Array<{ path: string; content: string }> = [];
      if (installFs().existsSync(stagedAgents)) {
        for (const entry of installFs().readdirSync(stagedAgents, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const agentPath = path.join(stagedAgents, entry.name);
          subagents.push({
            path: posixNormalize(path.join('agents', entry.name)),
            content: installFs().readFileSync(agentPath, 'utf8'),
          });
        }
      }

      const rootAgent = `---\nname: gsd\ndescription: Run GSD workflows in Kimi CLI.\ntools: Agent\n---\n\n# GSD for Kimi CLI\n\nCoordinate installed /skill:gsd-* workflows and route work to generated GSD subagents when a workflow requires an agent handoff.\n`;
      const artifacts = buildKimiAgentArtifacts({ rootAgent, subagents });
      const stageDir = mkInstallTempDir('gsd-kimi-agents-');
      installProfiles.STAGED_DIRS.add(stageDir);
      installFs().writeFileSync(path.join(stageDir, 'gsd.yaml'), artifacts.root.yaml);
      installFs().writeFileSync(path.join(stageDir, 'gsd.md'), artifacts.root.prompt);
      const subagentsDir = path.join(stageDir, 'subagents');
      installFs().mkdirSync(subagentsDir, { recursive: true });
      for (const artifact of artifacts.subagents) {
        installFs().writeFileSync(path.join(subagentsDir, `${artifact.name}.yaml`), artifact.yaml);
        installFs().writeFileSync(path.join(subagentsDir, `${artifact.name}.md`), artifact.prompt);
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
      const realConverter = _resolveNamedConverter(converterName, 'skills') as (content: string, skillName: string, runtime: string, cmdNames: string[], isGlobal: boolean) => string;
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
      // #2873 (4b): spec-root reachability is applied LATER in the pipeline —
      // see `rewriteStagedSkillBodies` in runtime-artifact-conversion.cts, not
      // here. This stage() closure runs BEFORE the staged directory's generic
      // path-prefix rewrite pass (`applyRuntimeContentRewritesInPlace`'s
      // `case 'claude'`), which unconditionally rewrites any bare (non-`@`)
      // `~/.claude/` substring to the undocumented `$HOME/.claude/` form and
      // only restores the `@`-prefixed form. Emitting the imperative
      // tilde-path prose here would get silently mangled by that later pass;
      // it must run AFTER it instead, once the `@`-include is in its final
      // rewritten shape.
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
      const converter = _resolveNamedConverter(converterName, 'commands') as (content: string, commandName: string) => string;
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

/**
 * True when a `commands` kind entry is namespaced by its destination
 * directory rather than by a filename prefix — i.e. `destSubpath`'s basename
 * equals `prefix` with its trailing hyphen stripped (e.g. `commands/gsd` +
 * `gsd-`). When true, `_copyStaged` (`install-engine.cts`) and `surface.cts`
 * both write the bare stem filename (no prefix) because the directory itself
 * already carries the namespace; `resolveTriggerSurface` mirrors that in its
 * own `destPath` computation. Single source of truth for the three sites
 * that used to compute this independently (#2871 Phase 2 review finding) —
 * a new caller MUST reuse this rather than re-deriving the rule.
 */
function isNamespacedByDir(kind: string, destSubpath: string, prefix: string): boolean {
  const destLast = path.posix.basename(posixNormalize(destSubpath));
  const prefixStem = prefix ? prefix.replace(/-$/, '') : '';
  return kind === 'commands' && destLast === prefixStem;
}

/**
 * Compose the destination filename `_copyStaged` (install-engine.cts) writes
 * for a `commands` kind entry, given `isNamespacedByDir`'s result, the
 * kind's prefix, and the file's `.md`-stripped stem. Single source of truth
 * alongside `isNamespacedByDir` for the FILENAME COMPOSITION itself (#2871
 * Phase 2 review finding — the boolean was single-sourced first, but the
 * `${stem}.md` / `${prefix}${stem}.md` string-building around it stayed
 * duplicated between `_copyStaged` and `resolveTriggerSurface`'s `destPath`
 * prediction below, so a divergence in the write convention would not have
 * failed anything).
 *
 * Byte-identical to `_copyStaged`'s prior separate branches: when
 * `namespacedByDir` is true this returns `${stem}.md`. `_copyStaged` always
 * derives `stem` as `entry.name.slice(0, -3)` for an `entry.name` that has
 * already been filtered to end in `.md`, so `${stem}.md` is always exactly
 * `entry.name` again — `_copyStaged` can pass this helper's result in place
 * of the `entry.name` it used to write directly, with no behavior change.
 */
function composeCommandFilename(namespacedByDir: boolean, prefix: string, stem: string): string {
  return namespacedByDir ? `${stem}.md` : `${prefix}${stem}.md`;
}

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
 * @throws {TypeError} for an unrecognized entry in `scopes` — reuses
 *   `install-scope.cts`'s shared `validateScopeId`, the same validator
 *   `scopeRank`/`resolveScope`/`isGlobalScope` already throw through, so this
 *   sibling of theirs cannot silently fail open on a bad scope (#2871 Phase 2
 *   review finding). `scopes: []` is untouched — an empty array has no
 *   entries to validate and still resolves to `[]`.
 */
function resolveTriggerSurface(runtime: string, scopes: InstallScope[], opts: TriggerSurfaceOpts): TriggerSurface[] {
  const registry = opts.registry ?? getTriggerRegistry();
  const runtimeDescriptor = registry.runtimes[runtime]?.runtime;
  const layout = runtimeDescriptor?.artifactLayout;
  if (!layout) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  for (const scope of scopes) {
    validateScopeId(scope, 'resolveTriggerSurface');
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
      const namespacedByDir = isNamespacedByDir(kind, entry.destSubpath, entry.prefix);
      const nested = entry.nesting === 'nested';

      for (const stem of stems) {
        const trigger = `${entry.prefix}${stem}`;
        let destPath: string;
        if (kind === 'skills') {
          destPath = `${destSubpath}/${entry.prefix}${stem}`;
        } else {
          destPath = `${destSubpath}/${composeCommandFilename(namespacedByDir, entry.prefix, stem)}`;
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
export = { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry, findInstallSourceRoot, resolveTriggerSurface, isNamespacedByDir, composeCommandFilename };
