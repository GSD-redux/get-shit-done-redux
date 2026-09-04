/**
 * Skill Surface Budget Module — single source of truth for which skills/agents
 * are written to the runtime config dirs (ADR-0011).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/install-profiles.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// #2874 (ADR-58 cleanup phase): route the staging functions' fs calls
// through the installRuntimeArtifacts call tree's injectable seam — see
// install-fs-adapter.cts's module doc. Resolves to real `node:fs` unless the
// top-level installRuntimeArtifacts call injected a `deps.fs`. Only the
// staging functions reachable FROM that call tree are routed
// (stageSkillsForProfile / stageAgentsForProfile /
// stageAgentsForRuntimeWithConverter / stageSkillsForRuntimeAsSkills /
// stageCommandsForRuntimeFlat / buildNamespaceBundleMap) — the profile-marker
// and manifest-loading helpers below are not on that call tree and keep
// using real `fs` directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs, mkInstallTempDir } = installFsAdapter;
import { platformWriteSync } from './shell-command-projection.cjs';
// #2322: reuse the existing pure path-containment seam (ADR-1239 Phase C-2)
// instead of hand-rolling a new traversal check for capability skill stems.
import { isPathConfined } from './external-descriptor-trust.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import conversionModule = require('./runtime-artifact-conversion.cjs');
const {
  applyAgentPathRewrites: _applyAgentPathRewrites,
  processAttribution: _processAttribution,
  normalizeAgentBodyForRuntime: _normalizeAgentBodyForRuntime,
  readGsdCommandNames: _readGsdCommandNames,
  deriveAgentName: _deriveAgentName,
  applyAgentFrontmatterExtensions: _applyAgentFrontmatterExtensions,
  appendAgentTools: _appendAgentTools,
} = conversionModule as {
  applyAgentPathRewrites: (content: string, runtime: string, pathPrefix: string) => string;
  processAttribution: (content: string, attribution: string | null | undefined) => string;
  normalizeAgentBodyForRuntime: (content: string, runtime: string, cmdNames: string[]) => string;
  readGsdCommandNames: () => string[];
  // #2875 Part 2: single-sourced agent-name derivation + the frontmatter-
  // extensions step (effort/disallowedTools injection), driven by the
  // runtime descriptor's hostBehaviors.agentFrontmatterExtensions.
  deriveAgentName: (fileName: string) => string;
  applyAgentFrontmatterExtensions: (content: string, opts: { runtime: string; agentName: string; targetDir?: string | null }) => string;
  appendAgentTools: (content: string, grants: string[]) => string;
};

// #2995 (epic #1671 Phase 6.4): agent bodies join the fragment model. Markers are
// stripped at emit BEFORE any path rewrite or converter runs, so a `.claude/` ->
// `.windsurf/` regex can never reach inside a marker attribute and corrupt it —
// the same ordering #2930 established for workflows.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import workflowFragmentsModule = require('./workflow-fragments.cjs');
const { composeWorkflow: _composeWorkflow } = workflowFragmentsModule as {
  composeWorkflow: (content: string, opts?: { sourcePath?: string }) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installModelOverrideResolver = require('./install-model-override-resolver.cjs');

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

/**
 * PROFILES maps profile name → base skill set (array) or '*' sentinel (full).
 *
 * The effective set for any profile is CLOSURE(base, requires: manifest).
 * standard is a superset of core; full is the identity (all skills).
 *
 * Composition: --profile=core,audit resolves to union(closure(core), closure(audit)).
 */
const PROFILES = Object.freeze({
  core: Object.freeze([
    'new-project',
    'discuss-phase',
    'plan-phase',
    'execute-phase',
    'phase',
    'help',
    'update',
    'surface',
  ]),
  standard: Object.freeze([
    // Core loop
    'new-project',
    'onboard',
    'discuss-phase',
    'plan-phase',
    'execute-phase',
    'help',
    'update',
    'surface',
    // Phase management (hot nodes from audit — required by 38+ skills)
    'phase',
    'review',
    'config',
    'progress',
    // Workspace / state
    'resume-work',
    'pause-work',
    'workspace',
  ]),
  full: '*' as const,
} as const);

type ProfileName = keyof typeof PROFILES;

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/**
 * Parse the requires: field from YAML frontmatter.
 * Handles: "requires: [a, b, c]" (flow style) and absent field.
 * Returns string[] — empty array if no requires: field.
 *
 * No external YAML parser dependency — hand-parse the single line
 * since GSD enforces flow-style arrays for requires:.
 */
function parseRequires(content: string): string[] {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const line = fm.match(/^requires:\s*(.+)$/m);
  if (!line) return [];
  const val = line[1].trim();
  // Flow-style: [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  }
  // Single bare value (not currently used, but defensive)
  return val ? [val] : [];
}

/**
 * Parse agent references from a skill file's body text.
 * Scans the full content for `gsd-<stem>` patterns that correspond to
 * real agent files. Returns all unique `gsd-*` stems found in the body.
 *
 * The caller is responsible for filtering by which agents actually exist —
 * this function returns all syntactically valid `gsd-*` matches.
 */
function parseCallsAgents(content: string): string[] {
  // Match word-boundary gsd-<stem> patterns; stems are lowercase letters and hyphens.
  // We use a regex that matches `gsd-` followed by one or more lowercase-alpha-or-hyphen chars.
  // This catches `gsd-planner`, `gsd-plan-checker`, etc. in prose and code.
  const matches = content.match(/\bgsd-[a-z][a-z-]*/g);
  if (!matches) return [];
  // Deduplicate
  return [...new Set(matches)];
}

/**
 * Load the requires: dependency graph from a commands/gsd directory.
 * Also derives calls_agents for each skill by scanning the body text for
 * `gsd-*` agent name references. Agent stems are stored under the special
 * key `_calls_agents_<stem>` so they don't conflict with skill stems.
 *
 * #3798: command bodies are thin delegators — the actual `subagent_type=`
 * spawns live in the workflow files each command references
 * (`@…/workflows/<name>.md`). The agent derivation therefore ALSO reads every
 * workflow file the command references (plus the workflow's steps/ fragments
 * when it is split per the progressive-disclosure pattern) and unions their
 * `gsd-*` tokens into the same `_calls_agents_<stem>` set. Without this,
 * tiered profiles omitted agents their own installed skills spawn
 * (gsd-verifier at execute-phase's verify_phase_goal was the filed repro).
 * Over-inclusion fails safe: a tiered profile installing one extra agent
 * costs bytes, never a broken spawn.
 */
const DEFAULT_COMMANDS_DIR = path.resolve(__dirname, '..', '..', '..', 'commands', 'gsd');
const DEFAULT_WORKFLOWS_DIR = path.resolve(__dirname, '..', '..', 'workflows');

/**
 * Collect the `gsd-*` agent tokens from every workflow file a command body
 * references. References are the `workflows/<name>.md` path suffixes the
 * delegating commands embed (`@…/gsd-core/workflows/<name>.md`). A
 * split workflow (workflows/<name>/steps/*.md) contributes its fragments as
 * well, because the parent dispatches into them and the spawns live there.
 */
function workflowAgentRefs(content: string, workflowsDir: string): string[] {
  const refs = content.match(/workflows\/([a-z0-9][a-z0-9-]*)\.md/g) || [];
  const names = [...new Set(refs.map((r) => r.slice('workflows/'.length)))];
  const tokens = new Set<string>();
  for (const name of names) {
    const direct = path.join(workflowsDir, name);
    let body: string | null = null;
    try { body = fs.readFileSync(direct, 'utf8'); } catch { body = null; }
    if (body === null) continue;
    for (const tok of parseCallsAgents(body)) tokens.add(tok);
    // Split workflow: union EVERY fragment under the workflow's directory
    // (steps/, modes/, templates/…) — the parent dispatches into these per
    // the progressive-disclosure pattern, and spawns live in all of them
    // (#3798 review: modes/ carried gsd-advisor-researcher's spawn while the
    // parent only named it incidentally in prose).
    const fragDir = path.join(workflowsDir, name.slice(0, -3));
    const walk = (dir: string): void => {
      let frags: fs.Dirent[];
      try { frags = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const frag of frags) {
        const full = path.join(dir, frag.name);
        if (frag.isDirectory()) { walk(full); continue; }
        if (!frag.isFile() || !frag.name.endsWith('.md')) continue;
        try {
          const fragBody = fs.readFileSync(full, 'utf8');
          for (const tok of parseCallsAgents(fragBody)) tokens.add(tok);
        } catch { /* unreadable fragment — skip */ }
      }
    };
    walk(fragDir);
  }
  return [...tokens];
}

function loadSkillsManifest(commandsDir: string = DEFAULT_COMMANDS_DIR, workflowsDir: string = DEFAULT_WORKFLOWS_DIR): Map<string, string[]> {
  const manifest = new Map<string, string[]>();
  if (!fs.existsSync(commandsDir)) return manifest;
  const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    try {
      const content = fs.readFileSync(path.join(commandsDir, entry.name), 'utf8');
      manifest.set(stem, parseRequires(content));
      // Derive agent references from body text + the workflows it delegates to
      const agentRefs = [
        ...parseCallsAgents(content),
        ...workflowAgentRefs(content, workflowsDir),
      ];
      manifest.set(`_calls_agents_${stem}`, [...new Set(agentRefs)]);
    } catch {
      manifest.set(stem, []);
      manifest.set(`_calls_agents_${stem}`, []);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Profile resolution (transitive closure)
// ---------------------------------------------------------------------------

/**
 * Compute the transitive closure of a set of skill stems over the manifest.
 */
function computeClosure(base: Iterable<string>, manifest: Map<string, string[]>): Set<string> {
  const closed = new Set(base);
  const queue = [...closed];
  while (queue.length > 0) {
    const stem = queue.pop()!;
    const deps = manifest.get(stem) || [];
    for (const dep of deps) {
      if (!closed.has(dep)) {
        closed.add(dep);
        queue.push(dep);
      }
    }
  }
  return closed;
}

interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

interface CapabilityRegistry {
  capabilityClusters?: Record<string, string[]>;
  profileMembership?: Record<string, { tier: string; profiles: string[] }>;
}

interface ResolveProfileOpts {
  modes?: string[];
  manifest?: Map<string, string[]>;
  _profilesOverride?: Record<string, string | readonly string[]>;
  /** ADR-857 phase 4c: optional capability registry; when present, capability
   *  skills are unioned into the base set for each resolved mode before closure. */
  registry?: CapabilityRegistry;
}

/**
 * Compute the capability skills to add for a given profile mode from the registry.
 * Returns an array of skill stems contributed by capabilities whose profileMembership
 * includes the given mode.  Guards against prototype pollution and malformed registry.
 */
function _capabilitySkillsForMode(mode: string, registry: CapabilityRegistry): string[] {
  const BANNED = ['__proto__', 'constructor', 'prototype'];
  const clusters = registry.capabilityClusters;
  const membership = registry.profileMembership;
  if (!clusters || typeof clusters !== 'object' || !membership || typeof membership !== 'object') {
    return [];
  }
  const result: string[] = [];
  for (const capId of Object.keys(clusters)) {
    if (BANNED.includes(capId)) continue;
    const mem = membership[capId];
    if (!mem || typeof mem !== 'object') continue;
    const profiles = mem.profiles;
    if (!Array.isArray(profiles)) continue;
    if (!profiles.includes(mode)) continue;
    const skills = clusters[capId];
    if (!Array.isArray(skills)) continue;
    for (const s of skills) {
      if (typeof s === 'string' && s.length > 0) result.push(s);
    }
  }
  return result;
}

/**
 * Resolve a profile (or composed profiles) to a typed result object.
 */
function resolveProfile({ modes, manifest, _profilesOverride, registry }: ResolveProfileOpts = {}): ResolvedProfile {
  const profiles: Record<string, string | readonly string[]> = _profilesOverride || PROFILES;
  const activeModes = (modes && modes.length > 0) ? modes : ['full'];
  const normalizedModes = activeModes
    .flatMap((mode) => String(mode).split(','))
    .map((mode) => mode.trim())
    .filter(Boolean);
  const modesToResolve = normalizedModes.length > 0 ? normalizedModes : ['full'];

  // If any mode is 'full', the result is the full sentinel
  if (modesToResolve.includes('full')) {
    return { name: 'full', skills: '*', agents: new Set() };
  }

  const validModes = modesToResolve.filter((mode) => Object.prototype.hasOwnProperty.call(profiles, mode));
  if (validModes.length === 0) {
    // Invalid/corrupt marker fallback: avoid empty installs by defaulting to full.
    return { name: 'full', skills: '*', agents: new Set() };
  }

  const man = manifest || new Map<string, string[]>();
  const unionSkills = new Set<string>();

  for (const mode of validModes) {
    const base = profiles[mode];
    if (base === '*') {
      // This profile is full — sentinel short-circuit
      return { name: 'full', skills: '*', agents: new Set() };
    }
    // ADR-857 phase 4c: union capability skills for this mode BEFORE closure so
    // their requires: chains expand too.
    const capSkills = registry ? _capabilitySkillsForMode(mode, registry) : [];
    const baseWithCap: string[] = [...(base as Iterable<string>), ...capSkills];
    const closure = computeClosure(baseWithCap, man);
    for (const s of closure) unionSkills.add(s);
  }

  // Derive agents: union of all agent names referenced in the body text of
  // every skill in unionSkills. Agent names are stored in the manifest under
  // _calls_agents_<stem> keys (populated by loadSkillsManifest).
  const unionAgents = new Set<string>();
  for (const skillStem of unionSkills) {
    const agentRefs = man.get(`_calls_agents_${skillStem}`) || [];
    for (const agentStem of agentRefs) {
      unionAgents.add(agentStem);
    }
  }

  const name = validModes.length === 1 ? validModes[0] : validModes.join(',');
  return { name, skills: unionSkills, agents: unionAgents };
}

// ---------------------------------------------------------------------------
// Staging — skills
// ---------------------------------------------------------------------------

// Stage dirs created during this process — cleaned up on exit.
// 13 runtime dispatch sites in install.js can each call stageSkillsForMode,
// so accumulating them in a single set avoids leaks without forcing each
// site to track its own cleanup handle.
const STAGED_DIRS = new Set<string>();
let exitHandlerRegistered = false;

// #2874 leak-fix: `cleanupStagedSkills` runs at process exit — AFTER
// `withInstallFs` has already restored `current` back to the real adapter
// (install-fs-adapter.cts's module doc, "SYNCHRONOUS-ONLY / RE-ENTRANCY
// ASSUMPTION" — extended there to reference this map). A dir staged during a
// fake-adapter call must be cleaned up with THAT SAME fake adapter, not with
// whatever is ambiently active later, or an exit handler would perform real
// filesystem IO on a path that only ever existed in the fake's in-memory
// store. Capturing the adapter OBJECT `installFs()` returns at registration
// time (not the ambient `current` variable, which changes) means cleanup
// always replays the exact adapter that created the path. Dirs added to
// STAGED_DIRS without going through `registerStagedDir` (the deprecated
// `stageSkillsForMode`, which creates its stage dir via raw `fs.mkdtempSync`
// and was never on the injectable seam) have no entry here and fall back to
// real `fs.rmSync` below — the same real fs it always used to create them.
const STAGED_DIR_ADAPTERS = new Map<string, ReturnType<typeof installFs>>();

/**
 * Register a dir just staged through the injectable seam (`installFs()`) for
 * exit-time cleanup, capturing the adapter that staged it alongside the path.
 * See `STAGED_DIR_ADAPTERS`'s comment for why the capture matters.
 */
function registerStagedDir(dir: string): void {
  STAGED_DIRS.add(dir);
  STAGED_DIR_ADAPTERS.set(dir, installFs());
  ensureExitCleanup();
}

function cleanupStagedSkills(): void {
  for (const dir of STAGED_DIRS) {
    const adapter = STAGED_DIR_ADAPTERS.get(dir);
    try {
      if (adapter) {
        adapter.rmSync(dir, { recursive: true, force: true });
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort: missing dir or permission error shouldn't crash a
      // successful install. The OS reaps tmpdir eventually.
    }
  }
  STAGED_DIRS.clear();
  STAGED_DIR_ADAPTERS.clear();
}

// Signals we register a cleanup handler for in addition to the natural
// 'exit' event. `process.on('exit')` does NOT fire on these — an installer
// is exactly the kind of process users abort mid-run, so without explicit
// signal handling Ctrl+C would leave staged tmp dirs behind.
const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function ensureExitCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on('exit', cleanupStagedSkills);
  for (const sig of CLEANUP_SIGNALS) {
    // `once` so re-raising the signal below isn't intercepted by us a second
    // time — the OS-default handler should take over and exit with the right
    // status code (so CI sees the abort, scripts see 130 for SIGINT, etc.).
    process.once(sig, () => {
      cleanupStagedSkills();
      process.kill(process.pid, sig);
    });
  }
}

/**
 * Stage a filtered copy of commands/gsd for a resolved profile.
 * In full mode (skills === '*') returns srcDir unchanged (no-op).
 */
function stageSkillsForProfile(srcDir: string, resolvedProfile: ResolvedProfile): string {
  if (resolvedProfile.skills === '*') return srcDir;
  if (!installFs().existsSync(srcDir)) return srcDir;

  const stageDir = mkInstallTempDir('gsd-profile-skills-');
  try {
    const entries = installFs().readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (!(resolvedProfile.skills).has(stem)) continue;
      installFs().copyFileSync(
        path.join(srcDir, entry.name),
        path.join(stageDir, entry.name),
      );
    }
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  registerStagedDir(stageDir);
  return stageDir;
}

/**
 * Stage a filtered copy of the agents directory for a resolved profile.
 * For 'full', returns srcAgentsDir unchanged.
 * For tiered profiles, copies only agents whose full stem (e.g. 'gsd-planner')
 * is in resolvedProfile.agents — which is populated by resolveProfile() from
 * the _calls_agents_* entries in the manifest.
 *
 * ⚠️ RAW STAGER — ITS OUTPUT IS NOT EMISSION-READY (#2995). This stager performs a
 * plain `fs.copyFileSync` and — under the default `full` profile — short-circuits
 * and returns the real source directory unstaged. It does NOT strip `gsd:section`
 * markers. It is still called, by `bin/install.js`'s `_stageAgents`, whose output
 * feeds the inline agent loop and `installCodexConfig`; both of those compose the
 * content themselves before writing, so the raw output never reaches disk. What
 * changed in #2995 is that `agentsKind` and `kimiAgentsKind` no longer use it —
 * they route through `stageAgentsForRuntimeWithConverter`, which composes.
 *
 * The invariant to preserve: anything that takes this function's output and WRITES
 * it as a runtime artifact must call `composeWorkflow` on each file first, or it
 * ships markers verbatim.
 */
function stageAgentsForProfile(srcAgentsDir: string, resolvedProfile: ResolvedProfile): string {
  if (resolvedProfile.skills === '*') return srcAgentsDir;
  if (!installFs().existsSync(srcAgentsDir)) return srcAgentsDir;

  const stageDir = mkInstallTempDir('gsd-profile-agents-');
  try {
    if (resolvedProfile.agents instanceof Set && resolvedProfile.agents.size > 0) {
      const entries = installFs().readdirSync(srcAgentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.md')) continue;
        // Agent stem is the full filename without extension, e.g. "gsd-planner"
        const stem = entry.name.slice(0, -3);
        if (!resolvedProfile.agents.has(stem)) continue;
        installFs().copyFileSync(
          path.join(srcAgentsDir, entry.name),
          path.join(stageDir, entry.name),
        );
      }
    }
    // If agents is empty Set, we produce an empty stageDir (no agents for this profile)
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  registerStagedDir(stageDir);
  return stageDir;
}

/**
 * Namespace-router → concrete sub-skill mapping for nested install layouts (#69).
 */
interface NamespaceBundleMap {
  routerStems: Set<string>;
  routerChildren: Map<string, string[]>;
  childToRouters: Map<string, string[]>;
}

/**
 * Build the namespace router → concrete sub-skill mapping (#69). The
 * authoritative source is each `ns-*.md` router file's `requires:` frontmatter
 * list. A concrete skill may be routed by more than one router (e.g. spec-phase
 * is shared by ns-workflow and ns-ideate); it is nested — and physically
 * duplicated — under every owning router.
 */
function buildNamespaceBundleMap(srcCommandsDir: string): NamespaceBundleMap {
  const routerStems = new Set<string>();
  const routerChildren = new Map<string, string[]>();
  const childToRouters = new Map<string, string[]>();
  if (!installFs().existsSync(srcCommandsDir)) {
    return { routerStems, routerChildren, childToRouters };
  }
  for (const entry of installFs().readdirSync(srcCommandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (!entry.name.startsWith('ns-')) continue;
    const stem = entry.name.slice(0, -3);
    let children: string[] = [];
    try {
      children = parseRequires(installFs().readFileSync(path.join(srcCommandsDir, entry.name), 'utf8'));
    } catch { children = []; }
    routerStems.add(stem);
    routerChildren.set(stem, children);
    for (const child of children) {
      const owners = childToRouters.get(child) || [];
      owners.push(stem);
      childToRouters.set(child, owners);
    }
  }
  return { routerStems, routerChildren, childToRouters };
}

/**
 * Rewrite a converted namespace-router SKILL.md so its routing table points at
 * nested sub-skill files instead of bare Skill-tool names (#69). Each table row
 * whose final cell carries a `gsd-<stem>` token (optionally with `--flag`
 * suffixes) is rewritten to `Read \`skills/<stem>/SKILL.md\`` (flags preserved
 * as a note), the `Invoke` column header becomes `Read`, and the
 * "Invoke … using the Skill tool" trailer becomes a file-read instruction.
 * Only lines beginning with a table pipe are touched, so the `|` inside the
 * `description:` frontmatter field is never matched.
 */
function transformRouterBodyToNested(converted: string): string {
  const lines = converted.split('\n');
  const out = lines.map((line) => {
    if (/Invoke the matched skill directly using the Skill tool\./.test(line)) {
      return line.replace(
        /Invoke the matched skill directly using the Skill tool\./,
        "Read the matched sub-skill's SKILL.md and follow its instructions. The `skills/<name>/SKILL.md` paths in the right column are relative to this skill's own directory.",
      );
    }
    if (!/^\s*\|/.test(line)) return line;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return line;
    if (/\|\s*Invoke\s*\|/.test(line)) {
      return line.replace(/\|\s*Invoke\s*\|/, '| Read |');
    }
    const cells = line.split('|');
    const lastIdx = cells.length - 2;
    if (lastIdx < 1) return line;
    const cell = cells[lastIdx];
    const m = cell.match(/gsd-([a-z0-9-]+)((?:\s+--[a-z0-9-]+)*)/i);
    if (!m) return line;
    const stem = m[1];
    const flags = m[2].trim();
    cells[lastIdx] = flags
      ? ` Read \`skills/${stem}/SKILL.md\` (${flags}) `
      : ` Read \`skills/${stem}/SKILL.md\` `;
    return cells.join('|');
  });
  return out.join('\n');
}

/**
 * #2322 SECURITY: a third-party `capability.json`'s `skills[]` entries are only
 * validated for being STRINGS and not one of the 3 reserved prototype-pollution
 * names (capability-validator.cjs validateFeatureBody, ~line 503) — NOT for
 * non-emptiness and NOT for a safe path-segment shape. `isSafeCapabilitySkillStem`
 * is therefore the SOLE defense against an empty-string, `..`-escaping,
 * separator-carrying, absolute, or NUL-carrying stem reaching a filesystem path
 * as a literal component — not a second defense-in-depth layer on top of any
 * validator-enforced non-emptiness (there is none). Once unioned into
 * resolveSurface's `resolved.skills` (#2045), such a stem must never reach
 * fs.readFileSync/writeFileSync as a literal path component, or it can escape
 * the capabilities root on read (or stageDir on write). Reject anything but a
 * single, ordinary path segment.
 */
function isSafeCapabilitySkillStem(stem: string): boolean {
  if (typeof stem !== 'string' || stem.length === 0) return false;
  if (stem.includes('\0')) return false;
  if (stem === '.' || stem === '..') return false;
  if (stem.includes('/') || stem.includes('\\')) return false;
  if (path.isAbsolute(stem)) return false;
  return true;
}

/**
 * Resolve which capability id DECLARES ownership of `stem`, per the registry's
 * `capabilityClusters` view (capId -> [owned skill stems]) — the SAME
 * authoritative binding `_capabilitySkillsForMode` (above) and `resolveSurface`
 * (surface.cts) already trust to decide which stems a capability contributes.
 * `capabilityClusters` is derived (gen-capability-registry.cjs
 * deriveCapabilityClusters) straight from each ACCEPTED capability's OWN
 * declared, non-empty `skills[]` array — an UNDECLARED directory a capability
 * happens to ship on disk (an unlisted `skills/<stem>/` bundled by mistake, or
 * by a malicious author trying to hijack another capability's stem) never
 * appears here, so it can never resolve as an owner. Two capabilities can never
 * both own the same stem: the registry loader (capability-loader.cts) rejects a
 * candidate whose declared skill collides with an already-registered owner
 * BEFORE it is ever composed into the registry — so this lookup is unambiguous
 * by construction. Returns null for an unowned/unregistered stem or a
 * malformed registry (never throws).
 */
function _owningCapabilityId(stem: string, clusters: Record<string, string[]>): string | null {
  const BANNED = ['__proto__', 'constructor', 'prototype'];
  for (const capId of Object.keys(clusters)) {
    if (BANNED.includes(capId)) continue;
    const owned = clusters[capId];
    if (!Array.isArray(owned)) continue;
    if (owned.includes(stem)) return capId;
  }
  return null;
}

/**
 * Union every stem ANY accepted capability declares across the WHOLE registry
 * (unfiltered by mode/tier) — used only for the `'*'` (full profile) staging
 * fill-in below, mirroring the SAME unconditional union `resolveSurface`
 * (surface.cts) already performs when ITS OWN base profile resolves to `'*'`.
 * Guards against a malformed/prototype-polluted registry; never throws.
 */
function capabilityClusterStems(registry: CapabilityRegistry | undefined): Set<string> {
  const result = new Set<string>();
  const clusters = registry?.capabilityClusters;
  if (!clusters || typeof clusters !== 'object') return result;
  const BANNED = ['__proto__', 'constructor', 'prototype'];
  for (const capId of Object.keys(clusters)) {
    if (BANNED.includes(capId)) continue;
    const stems = clusters[capId];
    if (!Array.isArray(stems)) continue;
    for (const s of stems) {
      if (typeof s === 'string' && s.length > 0) result.add(s);
    }
  }
  return result;
}

/**
 * #2322 HIGH-3: filesystem marker written into every staged THIRD-PARTY
 * capability skill directory (alongside SKILL.md) so a later prune pass
 * (surface.cts pruneSkillDirs) can identify the directory as GSD-capability-
 * owned even after the owning capability has been uninstalled/unsurfaced and
 * no longer appears in ANY registry view. Without a persisted marker, an
 * orphaned capability skill directory has no first-party manifest entry (the
 * skill manifest only ever knows gsd-core's own bundled stems) and
 * pruneSkillDirs' conservative unknown-directory branch would preserve it
 * FOREVER — uninstalling a malicious capability would never actually remove
 * its already-staged instructions from the agent's context. A directory
 * WITHOUT this marker is presumed genuinely user-created (data-loss
 * protection is unchanged for that case).
 */
const CAPABILITY_SKILL_MARKER = '.gsd-capability-skill';

/**
 * Look up an installed third-party capability's already-authored SKILL.md for
 * `stem`, bound to its DECLARING capability via the registry's
 * `capabilityClusters` view (capId -> owned stems) — NEVER by scanning every
 * installed capability directory and taking the first (sorted) match.
 *
 * #2322 BLOCKER 1: the prior implementation scanned every directory under the
 * capabilities root for a `skills/<stem>/SKILL.md` file and returned the FIRST
 * SORTED match, regardless of whether that capability actually DECLARED the
 * stem in its `capability.json` `skills[]` and regardless of whether it was
 * the (sole) REGISTERED owner. An attacker-controlled capability could ship an
 * UNDECLARED `skills/<victim-stem>/SKILL.md` directory that sorted ahead of
 * the legitimate, declaring capability and hijack its stem — the agent would
 * load the attacker's instructions believing they came from the legitimate
 * capability. Resolving `stem -> capId` via `capabilityClusters` FIRST (the
 * same authoritative binding `resolveSurface`/`_capabilitySkillsForMode`
 * trust) then reading ONLY that capability's own directory makes an
 * undeclared/unregistered sibling directory unreachable by construction.
 *
 * The install-root path convention (`<capabilitiesRoot>/<capId>/skills/<stem>/
 * SKILL.md` under `GSD_HOME || homedir()`) mirrors capability-loader.cts
 * (global overlay root) and capability-source.cts's `stageValidated` finalDir.
 *
 * Total/non-throwing (#2322 requirement 5): no registry, an unowned stem, a
 * missing capabilities root, an unreadable capability dir, or a missing/
 * corrupt SKILL.md all degrade to `null` (skip that stem) rather than
 * throwing — a partial/corrupt third-party install must never break
 * first-party staging. No registry at all means NOTHING third-party is
 * staged (fail closed — never a fallback scan).
 *
 * NOTE: the content returned here is staged AS-IS (no per-file `converter`
 * runs on it — unlike gsd-core's flat command `.md`, an installed capability
 * skill is already a complete SKILL.md), but it is NOT immune from the LATER
 * runtime-targeted body rewrite pass `applySurface` runs over the ENTIRE
 * staged directory (`rewriteStagedSkillBodies`, surface.cts): a `~/.claude/`
 * (etc.) path reference in a third-party skill body IS rewritten exactly like
 * a first-party one. "As-is" here refers only to this copy step, not to the
 * final on-disk content after a full `applySurface` run.
 */
function readInstalledCapabilitySkill(stem: string, registry: CapabilityRegistry | undefined): { capId: string; content: string } | null {
  if (!isSafeCapabilitySkillStem(stem)) return null;
  if (!registry || !registry.capabilityClusters || typeof registry.capabilityClusters !== 'object') return null;
  const capId = _owningCapabilityId(stem, registry.capabilityClusters);
  if (capId === null) return null;
  // Defense-in-depth: capId is a real accepted-capability directory name (a
  // trusted fs.readdirSync entry at capability-loader.cts accept time), but
  // re-validate its path-segment shape before using it as a literal path
  // component in case a future registry composer ever stops guaranteeing that.
  if (!isSafeCapabilitySkillStem(capId)) return null;
  const home = process.env['GSD_HOME'] || os.homedir();
  const capDir = path.join(home, '.gsd', 'capabilities', capId);
  const relSkillPath = path.join('skills', stem, 'SKILL.md');
  // Defense-in-depth: isSafeCapabilitySkillStem already rejects separators/
  // '..'/absolute stems, but re-confirm the resolved read path stays under
  // this capability's own directory before ever touching the filesystem.
  if (!isPathConfined(relSkillPath, capDir)) return null;
  const skillPath = path.join(capDir, relSkillPath);
  try {
    if (!fs.statSync(skillPath).isFile()) return null;
    return { capId, content: fs.readFileSync(skillPath, 'utf8') };
  } catch {
    return null; // missing / unreadable / corrupt entry -> skip
  }
}

/**
 * @param registry optional capability registry (capabilityClusters view) —
 *   when present, third-party capability skills are unioned into the staged
 *   output (bound to their declaring capId; see readInstalledCapabilitySkill).
 *   When absent, NOTHING third-party is staged (fail closed).
 */
function stageSkillsForRuntimeAsSkills(
  srcCommandsDir: string,
  resolvedProfile: ResolvedProfile,
  converter: (content: string, skillName: string) => string,
  prefix: string,
  nested = false,
  registry?: CapabilityRegistry,
): string {
  if (!installFs().existsSync(srcCommandsDir)) return srcCommandsDir;

  // Nesting applies to the `full` install AND to any surface whose skill set
  // still contains every namespace router (a full/reset surface). It must NOT
  // depend on the `'*'` sentinel alone: applySurface() materializes `full` into
  // a concrete Set, so a sentinel-only gate would re-flatten the layout on every
  // surface apply/reset (#69 adversarial-review finding). A partial surface that
  // drops a whole router cluster falls back to flat automatically.
  const bundles = nested ? buildNamespaceBundleMap(srcCommandsDir) : null;
  let doNest = false;
  if (nested && bundles && bundles.routerStems.size > 0) {
    if (resolvedProfile.skills === '*') {
      doNest = true;
    } else {
      const present = resolvedProfile.skills;
      doNest = [...bundles.routerStems].every((r) => present.has(r));
    }
  }

  // #2322: stems actually staged from gsd-core's OWN bundled commands/gsd dir
  // this call, so the third-party fill-in pass below can enforce "first-party
  // ALWAYS wins on collision" without re-deriving membership.
  const firstPartyStems = new Set<string>();

  const stageDir = mkInstallTempDir('gsd-profile-runtime-skills-');
  try {
    const entries = installFs().readdirSync(srcCommandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (resolvedProfile.skills !== '*' && !(resolvedProfile.skills).has(stem)) continue;
      firstPartyStems.add(stem);
      const content = installFs().readFileSync(path.join(srcCommandsDir, entry.name), 'utf8');
      const skillName = `${prefix}${stem}`;
      const converted = converter(content, skillName);

      if (doNest && bundles!.routerStems.has(stem)) {
        // Router skill: rewrite its routing table to the nested Read pattern and
        // emit it as the single top-level bundle entry.
        const destDir = path.join(stageDir, skillName);
        installFs().mkdirSync(destDir, { recursive: true });
        installFs().writeFileSync(path.join(destDir, 'SKILL.md'), transformRouterBodyToNested(converted));
        continue;
      }

      if (doNest && bundles!.childToRouters.has(stem)) {
        // Concrete skill routed by one or more namespace routers: nest a copy
        // under each owning router's skills/ subdir so it drops out of the
        // top-level eager listing while staying readable by file path (#69).
        for (const routerStem of bundles!.childToRouters.get(stem)!) {
          const destDir = path.join(stageDir, `${prefix}${routerStem}`, 'skills', stem);
          installFs().mkdirSync(destDir, { recursive: true });
          installFs().writeFileSync(path.join(destDir, 'SKILL.md'), converted);
        }
        continue;
      }

      // Flat top-level skill (default behaviour; also the unrouted fallback when
      // nesting is active).
      const destDir = path.join(stageDir, skillName);
      installFs().mkdirSync(destDir, { recursive: true });
      installFs().writeFileSync(path.join(destDir, 'SKILL.md'), converted);
    }

    // #2322: materialize installed THIRD-PARTY capability skills, bound to
    // their DECLARING capability via the registry's capabilityClusters view
    // (see readInstalledCapabilitySkill — NEVER scan-and-first-match). The
    // registry union (#2045) already puts every accepted-capability stem into
    // a concrete resolvedProfile.skills Set, but srcCommandsDir only ever
    // holds gsd-core's own bundled commands — so any stem with no first-party
    // file here was silently dropped (registry says surfaced:true, nothing on
    // disk) unless we fill it in from the capability's own install dir.
    //
    // BLOCKER 2 (#2322): `resolveProfile` short-circuits the `full` profile
    // straight to the `'*'` sentinel BEFORE ever consulting a registry — the
    // sentinel therefore carries no per-stem list of its own, and a bare
    // `resolvedProfile.skills !== '*'` gate here skipped this ENTIRE fill-in
    // pass for a `full` install regardless of what the registry declared
    // (the issue's default-profile repro: `mode=full` staged zero third-party
    // skills even when `mode=standard` on the SAME registry staged them
    // correctly). When `resolvedProfile.skills === '*'`, the candidate stems
    // are instead every stem the registry's `capabilityClusters` declares —
    // mirroring the SAME unconditional union `resolveSurface` (surface.cts,
    // "Issue #2045" block) already performs for its own `'*'` case. When
    // `resolvedProfile.skills` is a concrete Set, the candidate stems are the
    // ones `_capabilitySkillsForMode` already unioned into it (unchanged).
    //
    // No registry in scope at all -> stage NOTHING third-party (fail closed —
    // never fall back to scanning). Nesting (#69) never applies to a
    // capability skill — it was never a child of any ns-* router's
    // `requires:` list — so it always lands flat at the top level, exactly
    // like an unrouted first-party skill.
    if (registry) {
      const candidateStems: Iterable<string> =
        resolvedProfile.skills === '*' ? capabilityClusterStems(registry) : resolvedProfile.skills;
      for (const stem of candidateStems) {
        if (firstPartyStems.has(stem)) continue; // first-party always wins
        const found = readInstalledCapabilitySkill(stem, registry);
        if (found === null) continue; // absent/malformed/unowned -> skip gracefully
        const skillName = `${prefix}${stem}`;
        if (!isPathConfined(skillName, stageDir)) continue; // defense-in-depth
        const destDir = path.join(stageDir, skillName);
        installFs().mkdirSync(destDir, { recursive: true });
        installFs().writeFileSync(path.join(destDir, 'SKILL.md'), found.content);
        // #2322 HIGH-3: persist the capability-owned marker so a later prune
        // pass (surface.cts pruneSkillDirs) can identify — and remove — this
        // directory even once the owning capability is uninstalled/unsurfaced
        // and no longer appears in any registry view.
        installFs().writeFileSync(path.join(destDir, CAPABILITY_SKILL_MARKER), found.capId + '\n', 'utf8');
      }
    }
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  registerStagedDir(stageDir);
  return stageDir;
}

/**
 * Cross-cutting context for descriptor-driven agent staging (ADR-1235 §1).
 * When present, stageAgentsForRuntimeWithConverter applies the full inline-loop
 * sequence per agent: pathRewrites → attribution → converter → frontmatter
 * extensions → normalize. The field names mirror the inline loop's available
 * identifiers.
 *
 * `targetDir` (#2875 Part 2 / row I1-I3 — the one real per-agent resolution
 * gap the agents-bypass closure needed): the install root, threaded through
 * so the frontmatter-extensions step and (via the converter's own closure in
 * `convertedAgentsKind`) model-override resolution can read
 * `.planning/config.json` / `~/.gsd/defaults.json` exactly as the inline loop
 * did with its own `targetDir` variable. Optional — a caller with no
 * `targetDir` in scope (e.g. the feat-1173 synthetic-descriptor seam tests)
 * degrades to `null`, matching `readGsdEffectiveEffortConfig(null)`'s own
 * global-only-config contract. `projectDir` separates project config discovery
 * from that artifact destination for global installs (#4032).
 */
interface AgentCtx {
  runtime: string;
  pathPrefix: string;
  attribution: string | null | undefined;
  targetDir?: string | null;
  /** Project/config discovery root; defaults to targetDir for compatibility. */
  projectDir?: string | null;
}

/**
 * Stage a converted copy of the agents directory for a given runtime.
 *
 * Analogous to `stageCommandsForRuntimeFlat` but for agent `.md` files. Each
 * source `.md` is passed through `converter` and written as a flat `${name}.md`
 * file in the staging directory. Agent filenames are kept verbatim (no prefix
 * added here — the prefix is already embedded in agent stems, e.g. `gsd-planner.md`).
 *
 * This is used by the descriptor-driven `dispatchKindEntry` when an `agents` kind
 * entry carries a non-null converter (ADR-457 / #1173). When `converter` is null,
 * `agentsKind` falls back to the existing raw-copy path (`stageAgentsForProfile`).
 *
 * For the `full` profile (`skills === '*'`), all `.md` files are staged.
 * For tiered profiles, only agents whose full stem is in `resolvedProfile.agents`
 * are staged (mirrors `stageAgentsForProfile` behaviour).
 *
 * ADR-1235 §1: when `agentCtx` is provided, the per-file order matches the inline
 * agent loop in bin/install.js exactly:
 *   1. applyAgentPathRewrites   (4 base ~/.claude/ regexes; skipped for copilot/antigravity)
 *   2. processAttribution       (Co-Authored-By policy)
 *   3. appendAgentTools         (#4032: validated agent_tools grants, before host conversion)
 *   4. converter                (runtime-specific frontmatter/body transform)
 *   5. applyAgentFrontmatterExtensions (#2875 Part 2: effort/disallowedTools,
 *      gated by hostBehaviors.agentFrontmatterExtensions — no-op for a runtime
 *      that declares nothing, e.g. every non-Claude runtime today)
 *   6. normalizeAgentBodyForRuntime (colon→hyphen refs; no-op for trivial group)
 * When `agentCtx` is absent, only global `agent_tools` augmentation and the
 * converter run; other cross-cutting remains absent for backward compatibility.
 *
 * @param srcAgentsDir    source agents directory (e.g. agents/)
 * @param resolvedProfile profile filter from resolveProfile()
 * @param converter       (content: string, isGlobal?: boolean, meta?: {agentName: string}) → string
 *                        per-file converter; scope-aware converters (copilot/antigravity)
 *                        read isGlobal, single-arg converters ignore both extra args (#1173).
 *                        `meta.agentName` (#2875 Part 2) is passed ONLY when `agentCtx` is
 *                        present, letting a converter close over per-agent config
 *                        (e.g. kilo/opencode model-override resolution in
 *                        runtime-artifact-layout.cts's convertedAgentsKind) without widening
 *                        every OTHER converter's contract — converters that don't declare a
 *                        3rd parameter simply never read it.
 * @param isGlobal        install scope passed through to the converter
 * @param agentCtx        optional cross-cutting context (ADR-1235 §1)
 */
function stageAgentsForRuntimeWithConverter(
  srcAgentsDir: string,
  resolvedProfile: ResolvedProfile,
  converter: (content: string, isGlobal?: boolean, meta?: { agentName: string }) => string,
  isGlobal = false,
  agentCtx?: AgentCtx,
): string {
  if (!installFs().existsSync(srcAgentsDir)) return srcAgentsDir;

  const stageDir = mkInstallTempDir('gsd-profile-runtime-agents-');
  let entries: fs.Dirent[];
  try {
    // #2284/#2875: readdirSync-ing the shipped agents/ source is isolated in
    // its own try/catch so an unreadable source directory (permissions, a
    // corrupted install, or — as the #2284 test suite demonstrates — the
    // fail-closed injection harness) produces the SAME "refusing to install"
    // fail-closed wording every other agents-dir-unreadable path in this
    // codebase uses (bin/install.js's `_resolveAvailableGsdRoles` /
    // `_assertRoleResolvable`), instead of an unrelated raw fs error message
    // escaping uncaught. Hermes's role-dispatch validation depends on the
    // SAME shipped agents/ directory being readable; before this runtime also
    // declared an `agents` kind, this function was never reached on a Hermes
    // install, so an unreadable source here silently surfaced as a raw error
    // rather than the deliberate fail-closed contract #2284 established.
    entries = installFs().readdirSync(srcAgentsDir, { withFileTypes: true });
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(
      `stageAgentsForRuntimeWithConverter: could not resolve the shipped agents/ directory "${srcAgentsDir}" to stage — refusing to install (fail-closed, #2284/#2875): ${(err as Error).message}`,
    );
  }
  try {
    // Resolve cmdNames once per staging call (not per file) for performance.
    const cmdNames = agentCtx ? _readGsdCommandNames() : [];
    const agentTools = installModelOverrideResolver.readGsdEffectiveAgentTools(agentCtx?.projectDir ?? agentCtx?.targetDir ?? null);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      // For tiered profiles, gate by agent stem (full filename without extension).
      if (resolvedProfile.skills !== '*') {
        const stem = entry.name.slice(0, -3);
        if (!(resolvedProfile.agents instanceof Set && resolvedProfile.agents.has(stem))) {
          continue;
        }
      }
      const agentSourcePath = path.join(srcAgentsDir, entry.name);
      let content = installFs().readFileSync(agentSourcePath, 'utf8');
      // #2995: strip gsd:section markers FIRST — before path rewrites, attribution,
      // and the per-runtime converter. Byte-identical (no-op) for an unmarked agent;
      // throws loudly naming the file for a malformed marker, never emitting a
      // half-composed agent.
      content = _composeWorkflow(content, { sourcePath: agentSourcePath });
      const agentName = _deriveAgentName(entry.name);
      const grants = [
        ...(agentTools?.['*'] || []),
        ...(agentTools?.[agentName] || []),
      ];
      if (agentCtx) {
        // #2875 Part 2 / row I3: derived exactly as the inline loop does —
        // single-sourced via deriveAgentName (runtime-artifact-conversion.cts).
        // ADR-1235 §1: pre-converter cross-cutting (matches inline loop order exactly)
        // Step 1: path rewrites (4 base ~/.claude/ regexes; skipped for copilot/antigravity)
        content = _applyAgentPathRewrites(content, agentCtx.runtime, agentCtx.pathPrefix);
        // Step 2: attribution
        content = _processAttribution(content, agentCtx.attribution);
        // Step 3: validated canonical grants, before host conversion.
        content = _appendAgentTools(content, grants);
        // Step 4: converter (runtime-specific frontmatter/body transform)
        content = converter(content, isGlobal, { agentName });
        // Step 5: frontmatter extensions (effort/disallowedTools; no-op unless
        // the runtime declares hostBehaviors.agentFrontmatterExtensions)
        content = _applyAgentFrontmatterExtensions(content, { runtime: agentCtx.runtime, agentName, targetDir: agentCtx.targetDir });
        // Step 6: normalize colon→hyphen refs (no-op for trivial group)
        content = _normalizeAgentBodyForRuntime(content, agentCtx.runtime, cmdNames);
      } else {
        content = _appendAgentTools(content, grants);
        content = converter(content, isGlobal);
      }
      installFs().writeFileSync(path.join(stageDir, entry.name), content, 'utf8');
    }
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  registerStagedDir(stageDir);
  return stageDir;
}

/**
 * Stage converted command files as flat `.md` files.
 *
 * Analogous to `stageSkillsForRuntimeAsSkills` but for runtimes that use a
 * flat commands directory (e.g. Cursor's `.cursor/commands/<name>.md`).
 * Each source `.md` is passed through `converter` and written as a single flat
 * `${stem}.md` file in the staging directory (no subdirectory, no prefix).
 *
 * The `_copyStaged` commands branch in install.js will add the prefix when
 * copying staged files to the destination directory, so staged files must be
 * named with just the stem (e.g. `help.md` not `gsd-help.md`).
 *
 * The `converter` receives `(content, ${prefix}${stem})` so it can embed the
 * full command name (e.g. 'gsd-help') into the document body if needed.
 *
 * Used by the `convertedCommandsKind` layout descriptor in
 * runtime-artifact-layout.cts (#785 — Cursor 1.6 slash commands).
 *
 * @param srcCommandsDir  source commands directory (e.g. commands/gsd/)
 * @param resolvedProfile profile filter — '*' for all, Set for subset
 * @param converter       (content, commandName) → string  pure converter
 * @param prefix          command name prefix (for converter arg), e.g. 'gsd-'
 */
function stageCommandsForRuntimeFlat(
  srcCommandsDir: string,
  resolvedProfile: ResolvedProfile,
  converter: (content: string, commandName: string) => string,
  prefix: string,
): string {
  if (!installFs().existsSync(srcCommandsDir)) return srcCommandsDir;

  const stageDir = mkInstallTempDir('gsd-profile-runtime-commands-');
  try {
    const entries = installFs().readdirSync(srcCommandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (resolvedProfile.skills !== '*' && !(resolvedProfile.skills).has(stem)) continue;
      const content = installFs().readFileSync(path.join(srcCommandsDir, entry.name), 'utf8');
      // Pass the full command name (with prefix) to the converter so it can
      // reference the installed command name in the body (e.g. for descriptions).
      // The staged file itself is named without the prefix; _copyStaged adds it.
      const commandName = `${prefix}${stem}`;
      const converted = converter(content, commandName);
      installFs().writeFileSync(path.join(stageDir, `${stem}.md`), converted);
    }
  } catch (err) {
    try { installFs().rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  registerStagedDir(stageDir);
  return stageDir;
}

// ---------------------------------------------------------------------------
// Profile marker persistence
// ---------------------------------------------------------------------------

const PROFILE_MARKER_NAME = '.gsd-profile';

/**
 * Read the active profile from a runtime config directory.
 */
function readActiveProfile(runtimeConfigDir: string): string | null {
  const markerPath = path.join(runtimeConfigDir, PROFILE_MARKER_NAME);
  try {
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    if (!raw) return null;
    // Validate that it looks like a profile name (alphanumeric + hyphens + commas)
    if (!/^[a-z0-9,_-]+$/i.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist the active profile to a runtime config directory.
 */
function writeActiveProfile(runtimeConfigDir: string, profileName: string): void {
  platformWriteSync(path.join(runtimeConfigDir, PROFILE_MARKER_NAME), profileName + '\n');
}

// ---------------------------------------------------------------------------
// Profile resolution helpers for install / update flows
// ---------------------------------------------------------------------------

/**
 * Rank ordering for profiles (lower index = more restrictive / smaller skill set).
 * Unknown profiles default to the permissive end (treated as 'full').
 */
const PROFILE_RANK = Object.freeze(['core', 'standard', 'full'] as const);

/**
 * Given an array of profile names (one per runtime), return the most-restrictive
 * profile — i.e. the one with the smallest effective skill set.
 *
 * Ordering (most to least restrictive): core < standard < full.
 * Composed profiles (e.g. 'core,audit') and unknown profiles are treated as
 * 'full' for this comparison.
 */
function mostRestrictiveProfile(profileNames: string[]): string {
  if (!profileNames || profileNames.length === 0) return 'full';
  // Initialize with the least-restrictive rank (one past the end of PROFILE_RANK)
  let bestRank: number = PROFILE_RANK.length;
  let bestName = 'full';
  for (const name of profileNames) {
    const rank = PROFILE_RANK.indexOf(name as ProfileName);
    // Unknown/composed profiles are treated as the permissive 'full' rank.
    const effectiveRank = rank === -1 ? PROFILE_RANK.indexOf('full') : rank;
    if (effectiveRank < bestRank) {
      bestRank = effectiveRank;
      bestName = rank === -1 ? 'full' : name;
    }
  }
  return bestName;
}

interface ResolveEffectiveProfileOpts {
  requestedProfileName: string | null;
  targetDir: string;
}

/**
 * Resolve the effective profile name for an install() run.
 *
 * Priority:
 *   1. Explicit flag (requestedProfileName != null) → use it as-is.
 *   2. Marker exists in targetDir and is not 'full' → use marker.
 *   3. Else → 'full' (back-compat for fresh non-interactive installs).
 */
function resolveEffectiveProfile({ requestedProfileName, targetDir }: ResolveEffectiveProfileOpts): string {
  // 1. Explicit flag overrides everything
  if (requestedProfileName != null) return requestedProfileName;
  // 2. Marker-driven (gsd update path)
  const marker = readActiveProfile(targetDir);
  if (marker && marker !== 'full') return marker;
  // 3. Default
  return 'full';
}

// ---------------------------------------------------------------------------
// Back-compat shims (deprecated — use profile-based API instead)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use PROFILES.core instead.
 * Preserved for callers in install.js and existing tests.
 */
const MINIMAL_SKILL_ALLOWLIST = Object.freeze([...PROFILES.core]);

const MINIMAL_ALLOWLIST_SET = new Set(MINIMAL_SKILL_ALLOWLIST);

/**
 * @deprecated Use resolveProfile({ modes: ['core'] }) instead.
 */
function isMinimalMode(mode: string): boolean {
  return mode === 'minimal' || mode === 'core-only';
}

/**
 * Overloaded for back-compat.
 * - If resolvedProfileOrMode is a string: legacy mode check (full/minimal)
 * - If resolvedProfileOrMode is an object with .skills: new profile API
 *
 * @deprecated String-mode form; use resolvedProfile object form instead.
 */
function shouldInstallSkill(skillBaseName: string, resolvedProfileOrMode: ResolvedProfile | string): boolean {
  if (typeof resolvedProfileOrMode === 'object' && resolvedProfileOrMode !== null) {
    const { skills } = resolvedProfileOrMode;
    if (skills === '*') return true;
    return skills instanceof Set && skills.has(skillBaseName);
  }
  // Legacy string mode
  const mode = resolvedProfileOrMode;
  if (!isMinimalMode(mode)) return true;
  return MINIMAL_ALLOWLIST_SET.has(skillBaseName);
}

/**
 * Stage a filtered copy of the source commands/gsd directory.
 * Back-compat wrapper: maps 'minimal' → core profile, 'full' → full.
 *
 * @deprecated Use stageSkillsForProfile with a resolved profile instead.
 */
function stageSkillsForMode(srcDir: string, mode: string): string {
  if (!isMinimalMode(mode)) return srcDir;
  if (!fs.existsSync(srcDir)) return srcDir;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-minimal-skills-'));
  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const baseName = entry.name.replace(/\.md$/, '');
      if (!shouldInstallSkill(baseName, mode)) continue;
      fs.copyFileSync(
        path.join(srcDir, entry.name),
        path.join(stageDir, entry.name),
      );
    }
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  STAGED_DIRS.add(stageDir);
  ensureExitCleanup();
  return stageDir;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  // New profile API (ADR-0011)
  PROFILES,
  PROFILE_RANK,
  loadSkillsManifest,
  resolveProfile,
  resolveEffectiveProfile,
  mostRestrictiveProfile,
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageAgentsForRuntimeWithConverter,
  stageSkillsForRuntimeAsSkills,
  stageCommandsForRuntimeFlat,
  STAGED_DIRS,
  readActiveProfile,
  writeActiveProfile,
  // Shared internals
  parseRequires,
  parseCallsAgents,
  workflowAgentRefs,
  cleanupStagedSkills,
  // #2322: capability-skill security seams — exported for direct unit-testing
  // and for surface.cts's prune pass (CAPABILITY_SKILL_MARKER parity).
  isSafeCapabilitySkillStem,
  readInstalledCapabilitySkill,
  capabilityClusterStems,
  CAPABILITY_SKILL_MARKER,
  // Back-compat / deprecated
  MINIMAL_SKILL_ALLOWLIST,
  isMinimalMode,
  shouldInstallSkill,
  stageSkillsForMode,
};
