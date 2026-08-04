/**
 * runtime-homes.cts — canonical runtime → global config/skills directory mapping.
 *
 * Single source of truth for resolving the global config base directory and
 * the correct global skills directory for every GSD-supported runtime.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-homes.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Runtime-specific notes:
 *   hermes  — GSD skills nest under skills/gsd/<skillName>/ (not the flat
 *             skills/<skillName>/ layout used by all other runtimes).
 *   cline   — Skills-capable since v3.48.0 (#782). SKILL.md files live at
 *             ~/.cline/skills/<skillName>/SKILL.md (same flat layout as cursor/codex).
 *             .clinerules is also emitted (rules-based compatibility layer).
 *   kimi    — Agent Skills are discovered from Kimi's generic user roots:
 *             ~/.config/agents/skills (recommended) then ~/.agents/skills,
 *             with Kimi selecting the first existing generic skills directory.
 *             ~/.kimi-code/skills is brand-specific and can be selected as a
 *             GSD write target with --config-dir or KIMI_CONFIG_DIR.
 *   trae    — Targets Trae IDE (trae.ai), the Electron-based IDE — NOT
 *             trae-agent (github.com/bytedance/trae-agent), a Python CLI that
 *             uses trae_config.yaml, has no ~/.trae directory, and has no
 *             skills system. Both are ByteDance "Trae" products; they are
 *             entirely distinct. The global ~/.trae/skills/ path is
 *             community-soft-confirmed: docs.trae.ai/ide/skills documents the
 *             SKILL.md format and project-level .trae/skills/, but does NOT
 *             publish the global on-disk path; ~/.trae/skills/ rests on
 *             community evidence incl. Trae-AI/TRAE#2253. Best-effort only.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Expand a leading ~ to os.homedir().
 */
function expandTilde(p: string): string {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return p;
}

export interface ResolveAntigravityOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

export interface ResolveKimiOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

/**
 * Options for `resolveKimiHooksTomlDir`. Separate from `ResolveKimiOpts` so the
 * `runtime` selector is not implied to affect `resolveKimiGlobalDir`, which
 * resolves the generic Agent-Skills root and is runtime-independent.
 */
export interface ResolveKimiHooksTomlOpts extends ResolveKimiOpts {
  /** Runtime id — `kimi` (default) or `kimi-code`. See #2755. */
  runtime?: string;
}

export interface ResolveConfigHomeOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

// ── Descriptor shapes (mirroring the registry types) ──────────────────────

interface DotHomeDescriptor {
  kind: 'dot-home';
  name: string;
  env: string[];
  skillsHome?: ConfigHomeDescriptor;
}

interface DotHomeNestedDescriptor {
  kind: 'dot-home-nested';
  name: string;
  parent: string;
  env: string[];
  probe?: string[];
  /**
   * Optional sub-path that qualifies which probe candidate GSD actually owns
   * (e.g. `gsd-core/VERSION`). The same field name and check used by the
   * generic-agents-root descriptor — unified vocabulary per ADR-1016. The
   * resolution *strength* differs per kind: generic-agents-root treats it as a
   * hard filter (a candidate only qualifies if `<candidate>/<probeExists>`
   * exists), whereas dot-home-nested treats it as a *preference* — probing runs
   * in two passes: first the candidate whose `<candidate>/<probeExists>` exists
   * wins (the dir GSD installed into), then a bare-existence pass, then
   * `probe[0]`. Without it, behaviour is the legacy first-bare-existing-wins
   * probe, so other dot-home-nested runtimes (e.g. windsurf, which has no probe)
   * are unaffected. See ADR-1016 and #213/#217 (antigravity split).
   */
  probeExists?: string;
  skillsHome?: ConfigHomeDescriptor;
}

interface XdgDescriptor {
  kind: 'xdg';
  name: string;
  env: string[];
  skillsHome?: ConfigHomeDescriptor;
}

interface GenericAgentsRootDescriptor {
  kind: 'generic-agents-root';
  name: string;
  env: string[];
  probe: string[];
  probeExists: string;
  skillsHome?: ConfigHomeDescriptor;
}

type ConfigHomeDescriptor =
  | DotHomeDescriptor
  | DotHomeNestedDescriptor
  | XdgDescriptor
  | GenericAgentsRootDescriptor;

interface RuntimeArtifactKindDescriptor {
  kind: string;
  destSubpath: string;
  // ADR-1239 upgrade 3 (#2088): optional split-home override (relative to
  // os.homedir()), e.g. Codex skills → ".agents". Absent for most runtimes.
  home?: string;
}

interface RuntimeDescriptor {
  configHome: ConfigHomeDescriptor;
  artifactLayout?: {
    global?: RuntimeArtifactKindDescriptor[];
  };
}

function resolveDescriptorWithOptions(configHome: ConfigHomeDescriptor): string {
  return resolveConfigHomeFromDescriptor(configHome, {
    env: process.env,
    home: os.homedir(),
    existsSync: fs.existsSync,
  });
}

function getRegistry(): { runtimes: Record<string, { runtime?: RuntimeDescriptor }> } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: RuntimeDescriptor }>;
  };
}

/**
 * Resolve a configHome descriptor to an absolute directory path.
 *
 * Implements the four descriptor kinds:
 *   - dot-home:           env-override → path.join(home, name)
 *   - dot-home-nested:    env-override → probed subdir of path.join(home, parent)
 *   - xdg:                env[0] → env[1](dirname) → env[2](XDG subdir) → ~/.config/<name>
 *   - generic-agents-root:env[0] → first probe where probeExists exists → probe[0]
 */
export function resolveConfigHomeFromDescriptor(
  configHome: ConfigHomeDescriptor,
  opts: ResolveConfigHomeOpts = {},
): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;

  switch (configHome.kind) {
    case 'dot-home': {
      // First env var that is set wins
      for (const varName of configHome.env) {
        const val = env[varName];
        if (val) return expandTilde(val);
      }
      return path.join(home, configHome.name);
    }

    case 'dot-home-nested': {
      // env override
      const nestedEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && nestedEnv0Val) {
        return expandTilde(nestedEnv0Val);
      }
      const base = path.join(home, configHome.parent);
      if (configHome.probe && configHome.probe.length > 0) {
        // Pass 1 (marker-priority): when probeExists is declared, prefer the
        // candidate GSD actually owns (its `<candidate>/<probeExists>` exists).
        // This disambiguates an active-but-shadowing sibling dir (e.g. the
        // Antigravity-IDE `~/.gemini/antigravity` dir) from the dir GSD was
        // installed into, instead of blindly taking the first dir that exists.
        if (configHome.probeExists) {
          for (const candidate of configHome.probe) {
            const resolved = path.join(base, candidate);
            if (existsSyncFn(path.join(resolved, configHome.probeExists))) {
              return resolved;
            }
          }
        }
        // Pass 2 (legacy bare-existence): first candidate dir that exists.
        for (const candidate of configHome.probe) {
          const resolved = path.join(base, candidate);
          if (existsSyncFn(resolved)) return resolved;
        }
        // fallback: first probe candidate
        return path.join(base, configHome.probe[0]);
      }
      // no probe (e.g. windsurf): always name under parent
      return path.join(base, configHome.name);
    }

    case 'xdg': {
      // env[0]: direct override dir
      const xdgEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && xdgEnv0Val) {
        return expandTilde(xdgEnv0Val);
      }
      // env[1]: FILE path → dirname
      const xdgEnv1Val = env[configHome.env[1]];
      if (configHome.env[1] && xdgEnv1Val) {
        return path.dirname(expandTilde(xdgEnv1Val));
      }
      // env[2]: XDG_CONFIG_HOME → subdir
      const xdgEnv2Val = env[configHome.env[2]];
      if (configHome.env[2] && xdgEnv2Val) {
        return path.join(expandTilde(xdgEnv2Val), configHome.name);
      }
      return path.join(home, '.config', configHome.name);
    }

    case 'generic-agents-root': {
      // env override
      const garEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && garEnv0Val) {
        return expandTilde(garEnv0Val);
      }
      // probe each candidate; return first where probeExists subpath exists
      for (const candidate of configHome.probe) {
        const resolved = expandTildeWithHome(candidate, home);
        if (existsSyncFn(path.join(resolved, configHome.probeExists))) {
          return resolved;
        }
      }
      // fallback: first probe candidate
      return expandTildeWithHome(configHome.probe[0], home);
    }
  }
}

/**
 * Expand ~ using an explicit home directory (for hermetic testing).
 */
function expandTildeWithHome(p: string, home: string): string {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') return path.join(home, p.slice(1));
  return p;
}

/**
 * Resolve Antigravity global config dir across 1.x and 2.x layouts.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * antigravity descriptor shape. Preserved for external callers and tests.
 */
export function resolveAntigravityGlobalDir(opts: ResolveAntigravityOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;
  return resolveConfigHomeFromDescriptor(
    {
      kind: 'dot-home-nested',
      name: 'antigravity',
      parent: '.gemini',
      env: ['ANTIGRAVITY_CONFIG_DIR'],
      probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
      // Prefer the candidate GSD installed into (carries gsd-core/VERSION) over
      // a bare-existing sibling. Without this, a CLI user (antigravity-cli) who
      // also has the IDE's ~/.gemini/antigravity dir is shadowed to the legacy
      // dir because it is probed first. See #213/#217. The posix-slash literal
      // matches capabilities/antigravity/capability.json; both normalize via
      // path.join at the check site, so Windows backslash handling is covered.
      probeExists: 'gsd-core/VERSION',
    },
    { env, home, existsSync: existsSyncFn },
  );
}

export interface AntigravityAmbiguity {
  /** True when more than one ~/.gemini/antigravity{,-ide,-cli} dir is present. */
  ambiguous: boolean;
  /** The dir GSD currently resolves to (where install/update will write). */
  resolved: string;
  /** All probe candidate dirs that exist on disk (absolute paths). */
  presentDirs: string[];
  /**
   * Candidate dirs that carry the GSD marker (gsd-core/VERSION). When this has
   * exactly one entry, resolution is unambiguous. Zero or >1 entries (or a
   * marker in a dir other than the one a CLI/IDE user expects) is the #213/#217
   * misinstall surface: a prior install may have landed in the wrong sibling dir.
   */
  gsdMarkedDirs: string[];
  /** ANTIGRAVITY_CONFIG_DIR is the operator escape hatch; true when already set. */
  envOverridden: boolean;
}

/**
 * Detect whether the Antigravity config-dir resolution is ambiguous — i.e. more
 * than one of ~/.gemini/{antigravity,antigravity-ide,antigravity-cli} exists, so
 * a user upgrading from a pre-#217 install may have had GSD written into the
 * wrong sibling dir (the legacy/IDE dir shadowing an active CLI dir).
 *
 * This is a pure, side-effect-free probe intended for the installer and
 * /gsd-update to surface operator guidance (set ANTIGRAVITY_CONFIG_DIR or move
 * gsd-core/ into the intended dir). The migration framework cannot relocate an
 * install across sibling config dirs (it is bounded to a single configDir and
 * has no cross-dir move primitive — see installer-migrations 004), so existing
 * misinstalls are corrected by re-detection + operator guidance, not an
 * automatic move.
 */
export function detectAntigravityDirAmbiguity(
  opts: ResolveAntigravityOpts = {},
): AntigravityAmbiguity {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;
  const marker = path.join('gsd-core', 'VERSION');
  const base = path.join(home, '.gemini');
  const candidates = ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((c) =>
    path.join(base, c),
  );
  const presentDirs = candidates.filter((dir) => existsSyncFn(dir));
  const gsdMarkedDirs = candidates.filter((dir) => existsSyncFn(path.join(dir, marker)));
  return {
    ambiguous: presentDirs.length > 1,
    resolved: resolveAntigravityGlobalDir({ env, home, existsSync: existsSyncFn }),
    presentDirs,
    gsdMarkedDirs,
    envOverridden: Boolean(env['ANTIGRAVITY_CONFIG_DIR']),
  };
}

/**
 * Resolve Kimi's generic user root using Kimi CLI's documented first-existing
 * generic skills directory policy:
 *
 *   1. ~/.config/agents/skills  (recommended)
 *   2. ~/.agents/skills
 *
 * If neither generic skills directory exists yet, install to the recommended
 * ~/.config/agents root so the generated skills become the first generic
 * candidate Kimi discovers.
 *
 * KIMI_CONFIG_DIR is a GSD installer write-location override. It is not Kimi's
 * upstream data-root variable, and arbitrary roots are discoverable by Kimi only
 * when the user also configures Kimi --skills-dir or extra_skill_dirs.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * kimi descriptor shape. Preserved for external callers and tests.
 */
export function resolveKimiGlobalDir(opts: ResolveKimiOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;
  return resolveConfigHomeFromDescriptor(
    {
      kind: 'generic-agents-root',
      name: 'agents',
      env: ['KIMI_CONFIG_DIR'],
      probe: ['~/.config/agents', '~/.agents'],
      probeExists: 'skills',
    },
    { env, home, existsSync: existsSyncFn },
  );
}

/**
 * Resolve the directory holding the Kimi product's OWN native config.toml —
 * the file that product itself reads for providers/models/hooks/etc, and the
 * one GSD writes its `[[hooks]]` block, hooks bundle and CommonJS marker into.
 *
 * The two Kimi runtimes share `hooksSurface: "kimi-hooks-toml"` but are
 * different products with different roots, and this must be selected by
 * `runtime` (#2755). Before that fix this function was unparameterized and a
 * `--kimi-code` install wrote its hooks into Kimi CLI's `~/.kimi`, leaving Kimi
 * Code with none:
 *
 *   kimi       → `~/.kimi`,      overridden by `KIMI_SHARE_DIR`
 *                (moonshotai.github.io/kimi-cli/en/configuration/data-locations.html)
 *   kimi-code  → `~/.kimi-code`, overridden by `KIMI_CODE_HOME`
 *                (moonshotai/kimi-code docs/en/configuration/data-locations.md;
 *                 its hooks doc places `[[hooks]]` in `~/.kimi-code/config.toml`)
 *
 * Each product's env var is scoped to that product: `KIMI_SHARE_DIR` is Kimi
 * CLI's own upstream variable and must NOT redirect kimi-code, nor vice versa.
 *
 * An unrecognised `runtime` (and an omitted one) falls back to `~/.kimi`, which
 * preserves the pre-#2755 behaviour for every existing caller that passes no
 * runtime — this function is exported, so that default is a contract.
 *
 * For BOTH runtimes this is deliberately a SEPARATE directory from the generic
 * Agent-Skills root resolved by `resolveKimiGlobalDir` (`~/.config/agents`):
 * both vendors' docs confirm the Agent-Skills search path is independent of the
 * data-root env var. GSD's native `[[hooks]]` entries go in
 * `<this dir>/config.toml`, never into the skills configDir.
 */
export function resolveKimiHooksTomlDir(opts: ResolveKimiHooksTomlOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  // Explicit comparison rather than an object lookup keyed on `runtime`: the
  // value originates from argv, and an index would resolve inherited keys
  // (`constructor`, `__proto__`) to something that is not a descriptor.
  const descriptor: DotHomeDescriptor = opts.runtime === 'kimi-code'
    ? { kind: 'dot-home', name: '.kimi-code', env: ['KIMI_CODE_HOME'] }
    : { kind: 'dot-home', name: '.kimi', env: ['KIMI_SHARE_DIR'] };
  return resolveConfigHomeFromDescriptor(descriptor, { env, home });
}

/**
 * Return the global config base directory for the given runtime.
 * Respects the same env-var overrides as bin/install.js getGlobalDir().
 *
 * @param runtime   - The runtime identifier (e.g. 'claude', 'opencode').
 * @param explicitDir - If provided and non-empty, returned immediately after
 *   tilde-expansion, overriding all env-var and default logic. This matches
 *   the behaviour of bin/install.js getGlobalDir(runtime, explicitDir).
 */
export function getGlobalConfigDir(runtime: string, explicitDir?: string | null): string {
  if (explicitDir) return expandTilde(explicitDir);

  // ── Grok: not in the registry — hardcoded branch ─────────────────────────
  if (runtime === 'grok') {
    const env = process.env as Record<string, string | undefined>;
    return env['GROK_AGENTS_HOME'] ? expandTilde(env['GROK_AGENTS_HOME']) : path.join(os.homedir(), '.agents');
  }

  // ── Descriptor-driven: look up in capability-registry ────────────────────
  const { runtimes } = getRegistry();

  const runtimeEntry = runtimes[runtime];
  if (runtimeEntry?.runtime?.configHome) {
    return resolveDescriptorWithOptions(runtimeEntry.runtime.configHome);
  }

  // ── Default (unknown runtime → Claude fallback) ───────────────────────────
  const env = process.env as Record<string, string | undefined>;
  return env['CLAUDE_CONFIG_DIR'] ? expandTilde(env['CLAUDE_CONFIG_DIR']) : path.join(os.homedir(), '.claude');
}

/**
 * Return the global skills base directory for the given runtime.
 * Descriptor-backed runtimes derive the base home from configHome.skillsHome
 * when present, then append the first global skills artifact destSubpath.
 */
export function resolveSkillsBaseFromDescriptor(
  configHome: ConfigHomeDescriptor,
  opts: ResolveConfigHomeOpts = {},
  skillsDestSubpath = 'skills',
): string {
  const baseDescriptor = configHome.skillsHome ?? configHome;
  const base = resolveConfigHomeFromDescriptor(baseDescriptor, opts);
  return path.join(base, skillsDestSubpath);
}

export function getGlobalSkillsBase(runtime: string): string | null {
  const runtimeEntry = getRegistry().runtimes[runtime];
  const descriptor = runtimeEntry?.runtime;
  const globalSkillsKind = descriptor?.artifactLayout?.global?.find((entry) => entry.kind === 'skills');
  // ADR-1239 upgrade 3 (#2088): honor a skills-kind `home` override (e.g. Codex
  // → $HOME/.agents/skills, independent of $CODEX_HOME) so the reported skills
  // root matches where the installer actually writes (the artifact layout /
  // _resolveSkillsRootDir). Without this, `--skills-root` and the sync-skills
  // workflow would look under configHome/skills while skills live under ~/.agents.
  if (globalSkillsKind?.home && globalSkillsKind?.destSubpath) {
    return path.join(os.homedir(), globalSkillsKind.home, globalSkillsKind.destSubpath);
  }
  if (descriptor?.configHome && globalSkillsKind?.destSubpath) {
    return resolveSkillsBaseFromDescriptor(
      descriptor.configHome,
      { env: process.env, home: os.homedir(), existsSync: fs.existsSync },
      globalSkillsKind.destSubpath,
    );
  }
  const configDir = getGlobalConfigDir(runtime);
  return path.join(configDir, 'skills');
}

/**
 * Return the full path to a specific skill's directory for the given runtime.
 */
export function getGlobalSkillDir(runtime: string, skillName: string): string | null {
  const base = getGlobalSkillsBase(runtime);
  if (base === null) return null;
  return path.join(base, skillName);
}

/**
 * Return a human-readable display path for a global skill (for log messages).
 */
export function getGlobalSkillDisplayPath(runtime: string, skillName: string): string {
  const dir = getGlobalSkillDir(runtime, skillName);
  if (!dir) return `(${runtime} does not use a skills directory)`;
  // Replace homedir prefix with ~ for readability
  const home = os.homedir();
  return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}
