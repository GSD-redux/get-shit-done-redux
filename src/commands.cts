/**
 * Commands — Standalone utility commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/commands.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit, platformWriteSync, platformReadSync, platformEnsureDir } from './shell-command-projection.cjs';
import { requireSafePath, sanitizeForDisplay } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig, isGitIgnored } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal, extractOneLinerFromBody } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { normalizePhaseName, comparePhaseNum, extractPhaseToken, PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { getArchivedPhaseDirs, findPhaseInternal } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { extractCurrentMilestone, stripShippedMilestones: _stripShippedMilestones, getMilestoneInfo, getMilestonePhaseFilter, getRoadmapPhaseInternal } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelResolverMod = require('./model-resolver.cjs');
const { resolveModelInternal, resolveModelForTier, resolveProviderEscalation, resolveEffortInternal, resolveFastModeInternal, resolveEffortForTier, resolveGranularityInternal, assertValidGranularityOverride } = modelResolverMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import agentCommandRouterMod = require('./agent-command-router.cjs');
const { AGENT_FAILURE_CLASSES } = agentCommandRouterMod;
import { renderEffortForRuntime, renderEffortArgv, RUNTIMES_WITH_FAST_MODE } from './model-catalog.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import hostIntegrationMod = require('./host-integration.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningPaths } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { MODEL_PROFILES, VALID_PHASE_TYPES } = modelProfiles;
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArchivedPhaseDir {
  name: string;
  fullPath: string;
  milestone: string | null;
}

interface PhaseProgress {
  number: string;
  name: string;
  plans: number;
  summaries: number;
  status: string;
}

interface GroupFilesBySubrepoResult {
  grouped: Record<string, string[]>;
  unmatched: string[];
}

interface WebsearchOptions {
  limit?: number;
  freshness?: string;
}

interface ScaffoldOptions {
  phase?: string;
  name?: string;
}

interface CommitToSubrepoRepoResult {
  committed: boolean;
  hash: string | null;
  files: string[];
  reason?: string;
  error?: string;
}

interface EffortSyncChange {
  agent: string;
  from: string | null;
  to: string;
}

// ─── Phase Status ─────────────────────────────────────────────────────────────

/**
 * Phase-status precedence ladder — furthest-along wins (#2408).
 *
 * `cmdStats` builds `phasesByNumber` by scanning on-disk phase directories.
 * When two directories normalize to the same phase key (e.g. `05-real/` and
 * `05-real-stray/`), the status field must be folded by precedence rather
 * than overwritten last-write-wins — otherwise `/gsd-stats` reports whatever
 * directory `fs.readdirSync` happened to yield last, which is non-deterministic
 * across platforms and can silently call a `Complete` phase `Not Started`.
 */
const PHASE_STATUS_PRECEDENCE: ReadonlyArray<string> = [
  'Complete',
  'Needs Review',
  'Executed',
  'In Progress',
  'Planned',
  'Not Started',
  'Pending',
];
const PHASE_STATUS_RANK = new Map<string, number>(
  PHASE_STATUS_PRECEDENCE.map((s, i) => [s, i]),
);

/**
 * Fold two phase statuses by precedence — returns whichever is further along
 * the {@link PHASE_STATUS_PRECEDENCE} ladder. Unrecognized statuses fall behind
 * every recognized one (so a recognized status always wins over an unknown one;
 * two unrecognized statuses favor `a` for determinism).
 */
function foldPhaseStatus(a: string, b: string): string {
  const ra = PHASE_STATUS_RANK.get(a);
  const rb = PHASE_STATUS_RANK.get(b);
  if (ra === undefined && rb === undefined) return a;
  if (ra === undefined) return b;
  if (rb === undefined) return a;
  // Lower rank = higher precedence (Complete=0 wins over Not Started=5).
  return ra <= rb ? a : b;
}

/**
 * Determine phase status by checking plan/summary counts AND verification state.
 * Introduces "Executed" for phases with all summaries but no passing verification.
 */
function determinePhaseStatus(plans: number, summaries: number, phaseDir: string, defaultPending: string): string {
  if (plans === 0) return defaultPending;
  if (summaries < plans && summaries > 0) return 'In Progress';
  if (summaries < plans) return 'Planned';

  // summaries >= plans — check verification
  try {
    const files = fs.readdirSync(phaseDir);
    const verificationFile = files.find(f => f === 'VERIFICATION.md' || f.endsWith('-VERIFICATION.md'));
    if (verificationFile) {
      const content = platformReadSync(path.join(phaseDir, verificationFile)) || '';
      // #1159 (Defect A): read ONLY the frontmatter `status` key to avoid false
      // matches from historical body metadata such as `previous_status: gaps_found`.
      // Full-text regexes like /status:\s*gaps_found/ match the substring inside
      // `previous_status: gaps_found`, producing incorrect phase status labels.
      const fm = extractFrontmatter(content) as Record<string, unknown>;
      // Normalise to lower-case to preserve the prior case-insensitive behaviour
      // while reading only the frontmatter `status` key (not the full body text).
      const fmStatus = typeof fm['status'] === 'string' ? fm['status'].trim().toLowerCase() : '';
      if (fmStatus === 'passed') return 'Complete';
      if (fmStatus === 'human_needed') return 'Needs Review';
      if (fmStatus === 'gaps_found') return 'Executed';
      // Verification exists but unrecognized status — treat as executed
      return 'Executed';
    }
  } catch { /* directory read failed — fall through */ }

  // No verification file — executed but not verified
  return 'Executed';
}

function cmdGenerateSlug(text: string | undefined, raw: boolean): void {
  if (!text) {
    error('text required for slug generation');
  }

  const slug = (text as string)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);

  const result = { slug };
  output(result, raw, slug);
}

function cmdCurrentTimestamp(format: string | undefined, raw: boolean): void {
  const now = new Date();
  let result: string;

  switch (format) {
    case 'date':
      result = now.toISOString().split('T')[0];
      break;
    case 'filename':
      result = now.toISOString().replace(/:/g, '-').replace(/\..+/, '');
      break;
    case 'full':
    default:
      result = now.toISOString();
      break;
  }

  output({ timestamp: result }, raw, result);
}

function cmdListTodos(cwd: string, area: string | undefined, raw: boolean): void {
  const pendingDir = path.join(planningDir(cwd), 'todos', 'pending');

  let count = 0;
  const todos: Array<{ file: string; created: string; title: string; area: string; path: string; severity?: string }> = [];

  try {
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const content = platformReadSync(path.join(pendingDir, file));
      if (content === null) continue;
      const createdMatch = content.match(/^created:\s*(.+)$/m);
      const titleMatch = content.match(/^title:\s*(.+)$/m);
      const areaMatch = content.match(/^area:\s*(.+)$/m);
      // #2337: surface severity when present. Omit the key entirely for todos
      // with no severity line so existing consumers of this JSON are unaffected.
      const severityMatch = content.match(/^severity:\s*(.+)$/m);

      const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

      // Apply area filter if specified
      if (area && todoArea !== area) continue;

      count++;
      todos.push({
        file,
        created: createdMatch ? createdMatch[1].trim() : 'unknown',
        title: titleMatch ? titleMatch[1].trim() : 'Untitled',
        area: todoArea,
        path: toPosixPath(path.relative(cwd, path.join(pendingDir, file))),
        ...(severityMatch ? { severity: severityMatch[1].trim() } : {}),
      });
    }
  } catch { /* intentionally empty */ }

  const result = { count, todos };
  output(result, raw, count.toString());
}

/**
 * List captured seeds from .planning/seeds/SEED-*.md for browsing/audit (#441).
 *
 * Unlike audit.scanSeeds (which returns only *unimplemented* seeds for the
 * milestone surface), this lists seeds of every status with the richer fields a
 * human audit needs (scope, trigger, planted date). An optional case-insensitive
 * status filter narrows the set. Seed content is user-controlled, so every
 * displayed field is passed through sanitizeForDisplay and each file path is
 * validated with requireSafePath before reading. Read-only — never mutates.
 */
/**
 * Derive the canonical `{ seed_id, slug }` from a seed filename stem and the
 * frontmatter `id:` value. Pure (no I/O) so it can be property-tested directly.
 *
 * seed_id: frontmatter `id:` when it matches `SEED-NNN`, else the numeric prefix
 * of the filename (`SEED-NNN-…`), else the whole stem. slug: the descriptive
 * remainder after `SEED-NNN-`, else the stem with a leading `SEED-` stripped.
 * `rawFmId` is `unknown` because frontmatter values are not guaranteed strings.
 */
function deriveSeedIdentity(stem: string, rawFmId: unknown): { seed_id: string; slug: string } {
  const fmId = typeof rawFmId === 'string' ? rawFmId.trim() : '';
  let seedId: string;
  if (/^SEED-\d+$/i.test(fmId)) {
    seedId = fmId;
  } else {
    const numMatch = stem.match(/^(SEED-\d+)/i);
    seedId = numMatch ? numMatch[1] : stem;
  }
  const slugMatch = stem.match(/^SEED-\d+-(.+)$/i);
  const slug = slugMatch ? slugMatch[1] : stem.replace(/^SEED-/i, '');
  return { seed_id: seedId, slug };
}

function cmdListSeeds(cwd: string, statusFilter: string | undefined, raw: boolean): void {
  const planDir = planningDir(cwd);
  const seedsDir = path.join(planDir, 'seeds');
  const wantStatus = statusFilter ? statusFilter.trim().toLowerCase() : null;

  const seeds: Array<{
    seed_id: string; slug: string; status: string; scope: string;
    trigger_when: string; planted: string; title: string; path: string;
  }> = [];
  const summary: Record<string, number> = {};

  // Frontmatter values are not guaranteed to be scalars: extractFrontmatter
  // yields {} for a bare `key:` line and an array for `key: [a, b]`. Coerce every
  // read to a string so one malformed seed cannot crash the whole audit list
  // (`.toLowerCase()` on a non-string throws) or leak a raw object/array into the
  // JSON contract. Mirrors the existing `typeof fm.id === 'string'` guard below.
  const fmStr = (v: unknown): string => (typeof v === 'string' ? v : '');

  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(seedsDir, { withFileTypes: true });
  } catch {
    // No seeds dir (or unreadable) — an empty, non-error result. The seed dir is
    // created lazily by the first plant-seed, so absence is the normal zero case.
    output({ count: 0, seeds: [], summary: {} }, raw, '0');
    return;
  }

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('SEED-') || !entry.name.endsWith('.md')) continue;

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(path.join(seedsDir, entry.name), planDir, 'seed file', { allowAbsolute: true });
    } catch {
      continue;
    }
    const content = platformReadSync(safeFilePath);
    if (content === null) continue;

    const fm = extractFrontmatter(content) as Record<string, unknown>;
    const status = (fmStr(fm.status) || 'dormant').toLowerCase().trim() || 'dormant';

    // Match on the raw lowercased status (both sides already normalized);
    // sanitizeForDisplay is for output, not comparison.
    if (wantStatus && status !== wantStatus) continue;

    // Canonical seed id is `SEED-NNN` (frontmatter `id:`, e.g. SEED-001). Fall
    // back to the numeric prefix of the filename, then to the whole stem. The
    // descriptive remainder of the filename (`SEED-NNN-<slug>.md`) is the slug.
    const stem = path.basename(entry.name, '.md');
    const { seed_id: seedId, slug } = deriveSeedIdentity(stem, fm.id);

    let title = sanitizeForDisplay(fmStr(fm.title).slice(0, 100));
    if (!title) {
      const headingMatch = content.match(/^#\s*(.+)$/m);
      if (headingMatch) title = sanitizeForDisplay(headingMatch[1].trim().slice(0, 100));
    }

    const safeStatus = sanitizeForDisplay(status);
    summary[safeStatus] = (summary[safeStatus] || 0) + 1;

    seeds.push({
      seed_id: sanitizeForDisplay(seedId),
      slug: sanitizeForDisplay(slug),
      status: safeStatus,
      scope: sanitizeForDisplay(fmStr(fm.scope) || 'unknown'),
      trigger_when: sanitizeForDisplay(fmStr(fm.trigger_when)),
      planted: sanitizeForDisplay(fmStr(fm.planted)),
      title,
      path: toPosixPath(path.relative(cwd, safeFilePath)),
    });
  }

  // Stable order: by seed_id so output is deterministic across filesystems.
  seeds.sort((a, b) => a.seed_id.localeCompare(b.seed_id));

  output({ count: seeds.length, seeds, summary }, raw, seeds.length.toString());
}

function cmdVerifyPathExists(cwd: string, targetPath: string | undefined, raw: boolean): void {
  if (!targetPath) {
    error('path required for verification');
  }

  // Reject null bytes and validate path does not contain traversal attempts
  if ((targetPath as string).includes('\0')) {
    error('path contains null bytes');
  }

  const fullPath = path.isAbsolute(targetPath as string) ? targetPath as string : path.join(cwd, targetPath as string);

  try {
    const stats = fs.statSync(fullPath);
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    const result = { exists: true, type };
    output(result, raw, 'true');
  } catch {
    const result = { exists: false, type: null };
    output(result, raw, 'false');
  }
}

function cmdHistoryDigest(cwd: string, raw: boolean): void {
  const phasesDir = planningPaths(cwd).phases;
  const digest: {
    phases: Record<string, { name: string; provides: Set<string> | string[]; affects: Set<string> | string[]; patterns: Set<string> | string[] }>;
    decisions: Array<{ phase: string; decision: string }>;
    tech_stack: Set<string> | string[];
  } = { phases: {}, decisions: [], tech_stack: new Set() };

  // Collect all phase directories: archived + current
  const allPhaseDirs: Array<{ name: string; fullPath: string; milestone: string | null }> = [];

  // Add archived phases first (oldest milestones first)
  const archived = getArchivedPhaseDirs(cwd) as ArchivedPhaseDir[];
  for (const a of archived) {
    allPhaseDirs.push({ name: a.name, fullPath: a.fullPath, milestone: a.milestone });
  }

  // Add current phases
  if (fs.existsSync(phasesDir)) {
    try {
      const currentDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      for (const dir of currentDirs) {
        allPhaseDirs.push({ name: dir, fullPath: path.join(phasesDir, dir), milestone: null });
      }
    } catch { /* intentionally empty */ }
  }

  if (allPhaseDirs.length === 0) {
    digest.tech_stack = [];
    output(digest, raw, undefined);
    return;
  }

  try {
    for (const { name: dir, fullPath: dirPath } of allPhaseDirs) {
      const summaries = fs.readdirSync(dirPath).filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

      for (const summary of summaries) {
        const content = platformReadSync(path.join(dirPath, summary));
        if (content === null) continue;
        try {
          const fm = extractFrontmatter(content) as Record<string, unknown>;

          const phaseNum = (fm['phase'] as string) || dir.split('-')[0];

          if (!digest.phases[phaseNum]) {
            digest.phases[phaseNum] = {
              name: (fm['name'] as string) || dir.split('-').slice(1).join(' ') || 'Unknown',
              provides: new Set<string>(),
              affects: new Set<string>(),
              patterns: new Set<string>(),
            };
          }

          // Merge provides
          const depGraph = fm['dependency-graph'] as Record<string, string[]> | undefined;
          if (depGraph && depGraph['provides']) {
            depGraph['provides'].forEach((p: string) => (digest.phases[phaseNum].provides as Set<string>).add(p));
          } else if (fm['provides']) {
            (fm['provides'] as string[]).forEach((p: string) => (digest.phases[phaseNum].provides as Set<string>).add(p));
          }

          // Merge affects
          if (depGraph && depGraph['affects']) {
            depGraph['affects'].forEach((a: string) => (digest.phases[phaseNum].affects as Set<string>).add(a));
          }

          // Merge patterns
          if (fm['patterns-established']) {
            (fm['patterns-established'] as string[]).forEach((p: string) => (digest.phases[phaseNum].patterns as Set<string>).add(p));
          }

          // Merge decisions
          if (fm['key-decisions']) {
            (fm['key-decisions'] as string[]).forEach((d: string) => {
              digest.decisions.push({ phase: phaseNum, decision: d });
            });
          }

          // Merge tech stack
          const techStack = fm['tech-stack'] as { added?: Array<string | { name: string }> } | undefined;
          if (techStack && techStack['added']) {
            techStack['added'].forEach((t: string | { name: string }) => (digest.tech_stack as Set<string>).add(typeof t === 'string' ? t : t.name));
          }

        } catch {  
          // Skip malformed summaries
        }
      }
    }

    // Convert Sets to Arrays for JSON output
    Object.keys(digest.phases).forEach(p => {
      digest.phases[p].provides = [...(digest.phases[p].provides as Set<string>)];
      digest.phases[p].affects = [...(digest.phases[p].affects as Set<string>)];
      digest.phases[p].patterns = [...(digest.phases[p].patterns as Set<string>)];
    });
    digest.tech_stack = [...(digest.tech_stack as Set<string>)];

    output(digest, raw, undefined);
  } catch (e) {
    error('Failed to generate history digest: ' + (e as Error).message);
  }
}

function cmdResolveModel(cwd: string, agentType: string | undefined, raw: boolean): void {
  if (!agentType) {
    error('agent-type required');
  }

  const config = loadConfig(cwd);
  const profile = (config['model_profile'] as string) || 'balanced';
  const model = resolveModelInternal(cwd, agentType!);
  const effort = resolveEffortInternal(cwd, agentType!);

  const agentModels = (MODEL_PROFILES as Record<string, unknown>)[agentType!];
  const result = agentModels
    ? { model, profile, effort }
    : { model, profile, effort, unknown_agent: true };
  output(result, raw, model);
}

function cmdResolveGranularity(cwd: string, phaseType: string | undefined, raw: boolean, override?: string): void {
  if (!phaseType) {
    error('phase-type required');
  }
  assertValidGranularityOverride(override, error);
  const granularity = resolveGranularityInternal(cwd, phaseType, override);
  const result = (VALID_PHASE_TYPES).has(phaseType!)
    ? { granularity, phase_type: phaseType }
    : { granularity, phase_type: phaseType, unknown_phase_type: true };
  output(result, raw, granularity);
}

/**
 * #443 — Superset execution query: model + unified effort + fast_mode.
 *
 * Emits JSON:
 *   { model, profile, effort, effort_rendered, effort_param, effort_propagation,
 *     fast_mode, fast_mode_supported, [unknown_agent] }
 *
 * Flags: --effort <level>, --fast-mode <true|false>, --attempt <n>,
 *        --failure-class <class> (#2296), --host <runtime-id> (#2481)
 */
function cmdResolveExecution(cwd: string, agentType: string | undefined, raw: boolean, opts?: { effortOverride?: string; fastModeOverride?: boolean; attempt?: number; failureClass?: string; host?: string }): void {
  if (!agentType) {
    error('agent-type required');
  }

  opts = opts || {};
  const config = loadConfig(cwd);
  const profile = (config['model_profile'] as string) || 'balanced';
  // #2068: resolve the model per-attempt so dynamic_routing escalates the MODEL
  // (heavy tier) alongside effort. Gated on an explicit --attempt exactly like the
  // effort resolution below, so the two fields stay symmetric: with no --attempt
  // the model comes from the classic profile path (unchanged for everyone,
  // including dynamic_routing-enabled users who don't pass --attempt), and only an
  // explicit attempt routes through the tier ladder. resolveModelForTier itself
  // still falls back to resolveModelInternal when dynamic_routing is off.
  let model = (opts.attempt !== undefined && opts.attempt !== null)
    ? resolveModelForTier(cwd, agentType!, opts.attempt)
    : resolveModelInternal(cwd, agentType!);

  // #2296: when the caller reports WHY the previous attempt failed, consult the
  // provider-escalation ladder. Only a quota/rate-limit class warrants it — a
  // heavier tier on the same throttled provider is still throttled, so this
  // ladder swaps providers instead. Gated on an explicit --failure-class so the
  // JSON contract is byte-identical for every existing caller.
  let escalation: Record<string, unknown> | undefined;
  if (opts.failureClass !== undefined) {
    const applicable = opts.failureClass === AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED;
    const resolved = resolveProviderEscalation(cwd, agentType!, opts.attempt, applicable);
    if (resolved.escalated) model = resolved.to;
    escalation = { class: opts.failureClass, ...resolved };
  }

  const effortOpts: Record<string, unknown> = {};
  if (typeof opts.effortOverride === 'string') effortOpts['override'] = opts.effortOverride;

  const fastModeOpts: Record<string, unknown> = {};
  if (typeof opts.fastModeOverride === 'boolean') fastModeOpts['override'] = opts.fastModeOverride;

  const effort = (opts.attempt !== undefined && opts.attempt !== null)
    ? resolveEffortForTier(cwd, agentType!, opts.attempt)
    : resolveEffortInternal(cwd, agentType!, effortOpts);

  const fastMode = resolveFastModeInternal(cwd, agentType!, fastModeOpts);

  const runtime = (config['runtime'] as string) || 'claude';
  const rendered = renderEffortForRuntime(runtime, effort);

  const fastModeSupported = RUNTIMES_WITH_FAST_MODE.has(runtime);

  const agentModels = (MODEL_PROFILES as Record<string, unknown>)[agentType!];
  const result: Record<string, unknown> = {
    model,
    profile,
    effort,
    effort_rendered: rendered.value,
    effort_param: rendered.param,
    effort_propagation: rendered.channel,
    fast_mode: fastMode,
    fast_mode_supported: fastModeSupported,
  };
  // ADR-1239 amendment (#2481) / ADR-443 path (a): invocation-time effort for a
  // named host. The host's negotiated `effortSurface` decides WHETHER an argument
  // is emitted; the catalog knows the syntax. Absent --host the contract is
  // byte-identical to before, so every existing caller is unaffected.
  if (typeof opts.host === 'string' && opts.host.length > 0) {
    const surface = effortSurfaceForHost(cwd, opts.host);
    const argvRendered = renderEffortArgv(opts.host, effort, surface);
    result['host'] = opts.host;
    result['effort_surface'] = surface;
    result['effort_argv'] = argvRendered.argv;
    result['effort_argv_string'] = argvRendered.argv.join(' ');
    result['effort_argv_value'] = argvRendered.value;
  }

  if (!agentModels) result['unknown_agent'] = true;
  if (escalation) result['escalation'] = escalation;
  output(result, raw, effort);
}

/**
 * ADR-1239 amendment (#2481) — resolve a host's negotiated `effortSurface`.
 *
 * Reads the host's runtime descriptor from the generated capability registry and
 * runs it through the Host-Integration negotiation so the trust-boundary invariant
 * applies here exactly as everywhere else: an unknown host, a missing axis, or the
 * `undocumented` sentinel all degrade to the safe floor rather than being trusted.
 * Never throws — a lookup failure yields `'none'`, which renders no argument.
 */
function effortSurfaceForHost(cwd: string, host: string): string {
  void cwd;
  try {
    // Mirrors the lazy-require pattern from runtime-slash.cts §runtimeSlash —
    // capability-registry.cjs is generated and carries no type declarations.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runtimes } = require('./capability-registry.cjs') as {
      runtimes: Record<string, { runtime?: { hostIntegration?: unknown } }>;
    };
    const declared = runtimes[host]?.runtime?.hostIntegration;
    if (!declared || typeof declared !== 'object') return 'none';
    // The descriptor is untrusted JSON; negotiation applies the trust-boundary
    // invariant (effective ⊆ host-declared ∩ engine-known) and fails closed.
    const negotiated = hostIntegrationMod.negotiateHostCapabilities(declared);
    const surface: unknown = negotiated?.effective?.effortSurface;
    return typeof surface === 'string' ? surface : 'none';
  } catch {
    return 'none';
  }
}

/**
 * #488 — Replace or inject the `effort:` value in YAML frontmatter.
 * Unlike injectEffortFrontmatter (install.js), this overwrites an existing value.
 */
function setEffortFrontmatter(content: string, effortValue: string): string {
  const eol = /^---\r\n/.test(content) ? '\r\n' : '\n';
  const fmRe = /^---\r?\n([\s\S]*?)^---\r?$/m;
  const match = fmRe.exec(content);
  if (!match) return content;
  const fmBody = match[1];
  if (/^effort:/m.test(fmBody)) {
    return content.replace(/^(effort:)[ \t]*.*$/m, `$1 ${effortValue}`);
  }
  const openLen = 3 + eol.length;
  const closingStart = match.index + openLen + fmBody.length;
  return content.slice(0, closingStart) + `effort: ${effortValue}${eol}` + content.slice(closingStart);
}

/**
 * #488 — Re-sync effort: frontmatter in all installed gsd-*.md agent files to
 * match the current effort config, without requiring a full reinstall.
 *
 * Uses install-time resolution (readGsdEffectiveEffortConfig + resolveInstallTimeEffort
 * from bin/install.js) rather than the runtime resolver (resolveEffortInternal), because
 * the sync must mirror what install actually wrote: home defaults merged with project config.
 * The runtime resolver (loadConfig) does not merge ~/.gsd/defaults.json when a project
 * .planning/config.json exists, so it would silently ignore home-level effort changes.
 */
function cmdEffortSync(cwd: string, raw: boolean, opts?: { dryRun?: boolean; configDir?: string; runtime?: string }): void {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;

  const config = loadConfig(cwd);
  const runtime = opts.runtime || (config['runtime'] as string) || 'claude';

  if (runtime !== 'claude') {
    output({ synced: 0, skipped: 0, changes: [], dry_run: dryRun, reason: `runtime '${runtime}' does not use effort: frontmatter` }, raw, '');
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { getGlobalConfigDir } = require('./runtime-homes.cjs') as { getGlobalConfigDir(runtime: string, explicitDir?: string | null): string };
  // Use install-time resolvers: they merge ~/.gsd/defaults.json with project config,
  // matching the exact logic used when agents were originally installed. #2071: these
  // live in the shipped sibling install-effort-resolver.cjs (extracted from the
  // package-root bin/install.js, which the installer never copies into a runtime home).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { readGsdEffectiveEffortConfig, resolveInstallTimeEffort } = require('./install-effort-resolver.cjs') as {
    readGsdEffectiveEffortConfig(cwd: string): Record<string, unknown>;
    resolveInstallTimeEffort(cfg: Record<string, unknown>, agentName: string): string;
  };
  const effortCfg = readGsdEffectiveEffortConfig(cwd);

  const agentsDir = path.join(opts.configDir || getGlobalConfigDir(runtime), 'agents');

  if (!fs.existsSync(agentsDir)) {
    output({ synced: 0, skipped: 0, changes: [], dry_run: dryRun, agents_dir: agentsDir, reason: 'agents directory not found' }, raw, '');
    return;
  }

  // Skip symlinks — only write regular files to avoid clobbering symlink targets.
  const files = fs.readdirSync(agentsDir).filter(f => {
    if (!f.startsWith('gsd-') || !f.endsWith('.md')) return false;
    try { return fs.lstatSync(path.join(agentsDir, f)).isFile(); } catch { return false; }
  });
  const changes: EffortSyncChange[] = [];
  let synced = 0;
  let skipped = 0;

  for (const file of files) {
    const agentName = file.replace(/\.md$/, '');
    const filePath = path.join(agentsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');

    // Resolve using install-time logic: home defaults merged with project config.
    const universalEffort = resolveInstallTimeEffort(effortCfg, agentName);
    const rendered = renderEffortForRuntime(runtime, universalEffort);
    const newEffortValue = rendered.value;

    const fmMatch = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(content);
    if (!fmMatch) { skipped++; continue; }

    const effortMatch = /^effort:[ \t]*(.+?)[ \t]*$/m.exec(fmMatch[1]);
    const currentEffort = effortMatch ? effortMatch[1] : null;

    if (currentEffort === newEffortValue) { skipped++; continue; }

    changes.push({ agent: agentName, from: currentEffort, to: newEffortValue });
    synced++;

    if (!dryRun) {
      fs.writeFileSync(filePath, setEffortFrontmatter(content, newEffortValue));
    }
  }

  output({ synced, skipped, changes, dry_run: dryRun, agents_dir: agentsDir }, raw, synced > 0 ? 'changed' : 'ok');
}

/**
 * Detect the phase number for a commit from its `--files` path list.
 *
 * #2539: the extraction is anchored to the directory segment immediately under
 * `.planning/phases/` or `.planning/milestones/<version>-phases/`, then run
 * through the project-code-aware `extractPhaseToken` helper. The prior
 * unanchored `match(/(\d+(?:\.\d+)*)-/)` returned the leftmost digit-run-then-
 * hyphen anywhere in the joined path, so a project_code ending in a digit
 * (e.g. PROJECT_V2) made `…/PROJECT_V2-07-name/…` match the `2-` inside `V2-`
 * before the real `07-` phase token — resolving phase "2" instead of "7".
 *
 * Returns the phase number string (e.g. '07', '45.14'), or null when no phase
 * directory segment is present in any of the file paths (e.g. a commit of
 * `.planning/ROADMAP.md` has no phase segment, so no branch is resolved —
 * matching the prior regex-no-match behaviour).
 */
function detectPhaseNumberFromFiles(files: string[] | undefined): string | null {
  if (!files || files.length === 0) return null;
  // A phase directory lives one segment below a `phases` parent segment:
  //   .planning/phases/<phase-dir>/…
  //   .planning/milestones/v1.0-phases/<phase-dir>/…
  // The segment immediately after the `…phases` segment is the phase directory
  // name. extractPhaseToken owns the project-code-aware token read.
  for (const file of files) {
    const norm = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = norm.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] === 'phases' || segments[i].endsWith('-phases')) {
        const phaseDir = segments[i + 1];
        if (!phaseDir) continue;
        const token = extractPhaseToken(phaseDir);
        // extractPhaseToken falls back to returning dirName unchanged when no
        // numeric token is found. normalizePhaseName is the canonical arbiter
        // of "is this a real phase token": it strips the project-code prefix
        // and returns a zero-padded numeric form for a genuine phase token, or
        // the input unchanged otherwise. Accept the token only when it
        // normalizes to a numeric phase form (the single-owner rule shared by
        // every other phase-token reader — see #2528).
        const normalized = normalizePhaseName(token);
        // Built from the single-owner PHASE_NUMBER_TOKEN_SOURCE (the canonical
        // phase-number grammar — #2128 anti-divergence guard) so this read-side
        // acceptance check cannot drift from every other phase-token reader.
        const phaseTokenShape = new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}$`, 'i');
        if (token !== phaseDir && phaseTokenShape.test(normalized)) {
          return token;
        }
      }
    }
  }
  return null;
}

function cmdCommit(cwd: string, message: string | undefined, files: string[] | undefined, raw: boolean, amend: boolean, noVerify: boolean): void {
  if (!message && !amend) {
    error('commit message required');
  }

  // Sanitize commit message: strip invisible chars and injection markers
  // that could hijack agent context when commit messages are read back
  let sanitizedMessage = message;
  if (sanitizedMessage) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
    const { sanitizeForPrompt } = require('./security.cjs') as { sanitizeForPrompt(text: unknown): string };
    sanitizedMessage = sanitizeForPrompt(sanitizedMessage);
  }

  const config = loadConfig(cwd);

  // Check commit_docs config
  // `skipped: true` is explicit so agent prompts can match on a first-class
  // success signal rather than inferring "skip" from "committed is missing"
  // and improvising raw git fallbacks (#3678).
  if (!config['commit_docs']) {
    const result = { committed: false, skipped: true, hash: null, reason: 'skipped_commit_docs_false' };
    output(result, raw, 'skipped');
    return;
  }

  // Check if .planning is gitignored
  if (isGitIgnored(cwd, '.planning')) {
    const result = { committed: false, skipped: true, hash: null, reason: 'skipped_gitignored' };
    output(result, raw, 'skipped');
    return;
  }

  // Ensure branching strategy branch exists before first commit (#1278).
  // Pre-execution workflows (discuss, plan, research) commit artifacts but the branch
  // was previously only created during execute-phase — too late.
  const branchingStrategy = config['branching_strategy'] as string | undefined;
  if (branchingStrategy && branchingStrategy !== 'none') {
    let branchName: string | null = null;
    if (branchingStrategy === 'phase') {
      // Determine which phase we're committing for from the file paths.
      // #2539: the extraction is anchored to the directory SEGMENT immediately
      // under `.planning/phases/` (or `.planning/milestones/<v>-phases/`) and
      // runs through the project-code-aware extractPhaseToken helper, NOT a
      // free unanchored regex. The prior `match(/(\d+(?:\.\d+)*)-/)` returned
      // the leftmost digit-run-then-hyphen anywhere in the joined path, so a
      // project_code ending in a digit (PROJECT_V2) made `.../PROJECT_V2-07-…`
      // match the `2-` inside `V2-` before the real `07-` phase token —
      // resolving phase "2" instead of phase "7" and silently checking out the
      // wrong branch. extractPhaseToken already owns project-code-aware phase-
      // token parsing (it is the single owner shared by the other 6 call sites
      // — see #2528 for the parallel drift problem in phase-locator/phase),
      // so this is the canonical path-segment-bound read, not a fourth copy.
      const phaseNum = detectPhaseNumberFromFiles(files);
      if (phaseNum) {
        const phaseInfo = findPhaseInternal(cwd, phaseNum) as Record<string, unknown> | null;
        if (phaseInfo) {
          branchName = (config['phase_branch_template'] as string)
            .replace('{phase}', normalizePhaseName(phaseInfo['phase_number']))
            .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase');
        }
      }
    } else if (branchingStrategy === 'milestone') {
      const milestone = getMilestoneInfo(cwd);
      if (milestone && milestone.version) {
        branchName = (config['milestone_branch_template'] as string)
          .replace('{milestone}', milestone.version)
          .replace('{slug}', generateSlugInternal(milestone.name) || 'milestone');
      }
    }
    if (branchName) {
      const currentBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      if (currentBranch.exitCode === 0 && currentBranch.stdout.trim() !== branchName) {
        // #2539: the #1278 intent is to CREATE the phase/milestone branch
        // before the FIRST commit on it — not to force-switch an already-
        // checked-out working branch onto a DIFFERENT existing branch. The
        // prior fallback to a bare `git checkout <branch>` silently switched
        // the whole working tree onto an existing unrelated branch in the same
        // call that then committed (the only trace was a reflog entry). So:
        // create-if-absent only. If the resolved branch already exists and the
        // tree is on some other branch, do NOT switch — but never silently: log
        // the resolution so the operator sees that the phase branch was
        // resolved and deliberately not switched to (#2539 AC2: an auto-
        // checkout mid-commit must never happen silently).
        const create = execGit(['checkout', '-b', branchName], { cwd });
        if (create.exitCode !== 0) {
          // `git checkout -b` fails (non-zero) when the branch already exists.
          // The operator is on the branch they intend to be on; commit there.
          process.stderr.write(
            `Warning: resolved ${branchingStrategy} branch "${branchName}" already exists; ` +
            `committing on the current branch "${currentBranch.stdout.trim()}" instead of switching.\n`
          );
        }
      }
    }
  }

  // Stage files
  const explicitFiles = files && files.length > 0;
  const filesToStage = explicitFiles ? files : ['.planning/'];
  const stagedPaths: string[] = [];
  // #2608: a `git add` that fails must abort the commit, not be skipped.
  // #2523 stopped a failed path entering the commit pathspec, but skipping it
  // silently left two bad outcomes: a PARTIAL commit when only some requested
  // paths failed, and a misleading `nothing_to_commit` when all of them did —
  // in both cases the original staging error (permissions, unwritable index in
  // a linked worktree, timeout) was discarded and the operator saw a downstream
  // pathspec error pointing at an innocent file.
  const stagingFailures: Array<{ file: string; error: string; timed_out: boolean }> = [];
  // Paths already in the index BEFORE this call. On a staging failure the
  // rollback below unstages only what THIS call added — unstaging a path the
  // caller had staged themselves would destroy their work.
  const preStaged = new Set(
    execGit(['diff', '--cached', '--name-only'], { cwd })
      .stdout.split('\n').map(s => s.trim()).filter(Boolean),
  );
  for (const file of filesToStage) {
    const fullPath = path.resolve(cwd, file);
    if (!fs.existsSync(fullPath)) {
      if (explicitFiles) {
        // Caller passed an explicit --files list: missing files are skipped.
        // Staging a deletion here would silently remove tracked planning files
        // (e.g. STATE.md, ROADMAP.md) when they are temporarily absent (#2014).
        continue;
      }
      // Default mode (staging all of .planning/): stage the deletion so
      // removed planning files are not left dangling in the index.
      // This mutates the index exactly like `git add` does, so it fails closed
      // the same way — an unwritable index must not be swallowed here either.
      // `--ignore-unmatch` already makes "no such path" a success, so a non-zero
      // exit is a real I/O failure, not a missing file.
      const rmResult = execGit(['rm', '--cached', '--ignore-unmatch', file], { cwd });
      if (rmResult.exitCode !== 0) {
        const rmErr: NodeJS.ErrnoException | null = rmResult.error;
        stagingFailures.push({
          file,
          error: rmResult.stderr || rmResult.stdout,
          timed_out: rmResult.signal === 'SIGTERM' && rmErr?.code === 'ETIMEDOUT',
        });
      }
    } else {
      const addResult = execGit(['add', file], { cwd });
      // Only record paths that actually staged — a failed `git add` (permissions,
      // out-of-repo edge) must not enter the commit pathspec (#2523). Mirrors
      // cmdCommitToSubrepo's exitCode-gated push.
      if (addResult.exitCode === 0) {
        stagedPaths.push(file);
      } else {
        // `SpawnResultOutput.error` is typed `Error | null`; widen to the errno
        // shape by ANNOTATION rather than assertion — `Error` is assignable to
        // `NodeJS.ErrnoException` (its extra fields are optional), so an `as`
        // cast here trips no-unnecessary-type-assertion.
        const addErr: NodeJS.ErrnoException | null = addResult.error;
        stagingFailures.push({
          file,
          error: addResult.stderr || addResult.stdout,
          // The projection exposes a timeout distinctly (#2608 AC5); this is the
          // same SIGTERM+ETIMEDOUT idiom worktree-safety.cts uses.
          timed_out: addResult.signal === 'SIGTERM' && addErr?.code === 'ETIMEDOUT',
        });
      }
    }
  }

  // #2608: fail closed before `git commit` runs. Checked ahead of the
  // nothing_to_commit branch below so a run where EVERY path failed to stage
  // reports the staging cause rather than "nothing to commit", and ahead of the
  // commit itself so a multi-file scope never partially commits the subset that
  // happened to stage.
  if (stagingFailures.length > 0) {
    // Fail closed AND clean. Without this the paths that DID stage stay in the
    // index with no commit made, so the next bare `git commit` sweeps them up —
    // the same silent partial commit this fix exists to prevent, deferred one
    // step. Mirrors cmdPrSubrepo's rollback-then-error convention. Only paths
    // this call staged are unstaged (preStaged is excluded), and the reset is
    // best-effort: if the index is unwritable — the very failure being reported
    // — the reset cannot succeed either, and the staging error is still what
    // gets returned.
    const toUnstage = stagedPaths.filter(p => !preStaged.has(p));
    if (toUnstage.length > 0) {
      execGit(['reset', '-q', '--', ...toUnstage], { cwd });
    }
    const first = stagingFailures[0];
    const result = {
      committed: false,
      hash: null,
      reason: first.timed_out ? 'staging_timeout' : 'staging_failed',
      file: first.file,
      error: first.error,
      failures: stagingFailures,
    };
    output(result, raw, 'failed');
    return;
  }

  // Commit — when the caller declared a scope (--files), append a pathspec so
  // only the declared files land in the commit, not the entire index (#2112).
  // The pathspec uses stagedPaths (not filesToStage) so skipped missing files
  // are excluded — otherwise git would record them as deletions (#2014).
  // During a merge, git refuses partial commits — fall back to a bare commit.
  // --amend is left without a pathspec: amending with -- <paths> is a different
  // operation that rewrites the tip with only those paths.
  if (explicitFiles && stagedPaths.length === 0 && !amend) {
    const result = { committed: false, hash: null, reason: 'nothing_to_commit' };
    output(result, raw, 'nothing');
    return;
  }
  const isMergeInProgress = execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).exitCode === 0;
  const canScope = explicitFiles && stagedPaths.length > 0 && !amend
    && !isMergeInProgress;
  const commitArgs = amend
    ? ['commit', '--amend', '--no-edit']
    : ['commit', '-m', sanitizedMessage as string];
  if (noVerify) commitArgs.push('--no-verify');
  if (canScope) {
    commitArgs.push('--', ...stagedPaths);
  }
  const commitResult = execGit(commitArgs, { cwd });
  if (commitResult.exitCode !== 0) {
    if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
      const result = { committed: false, hash: null, reason: 'nothing_to_commit' };
      output(result, raw, 'nothing');
      return;
    }
    const result = {
      committed: false,
      hash: null,
      reason: 'commit_failed',
      error: commitResult.stderr || commitResult.stdout,
    };
    output(result, raw, 'failed');
    return;
  }

  // Get short hash
  const hashResult = execGit(['rev-parse', '--short', 'HEAD'], { cwd });
  const hash = hashResult.exitCode === 0 ? hashResult.stdout : null;
  const result = { committed: true, hash, reason: 'committed' };
  output(result, raw, hash || 'committed');
}

/**
 * Route a list of changed files to their sub-repo prefixes.
 *
 * Bucket sub-repos by their first path segment (#311). Any file that matches a
 * sub-repo prefix must share that sub-repo's first segment, so we only scan
 * the (small) same-first-segment bucket instead of all sub-repos. Within that
 * bucket all candidates are scanned to find the longest (most-specific)
 * matching prefix, so nested sub_repos (e.g. ['packages', 'packages/core'])
 * route to the deepest match regardless of sub_repos array order (#391).
 *
 * @param files    - changed file paths (relative to project root)
 * @param subRepos - sub-repo path prefixes from config.sub_repos
 */
function groupFilesBySubrepo(files: string[], subRepos: string[]): GroupFilesBySubrepoResult {
  const reposByFirstSeg = new Map<string, string[]>();
  for (const repo of subRepos) {
    const firstSeg = String(repo).split('/')[0];
    let bucket = reposByFirstSeg.get(firstSeg);
    if (!bucket) { bucket = []; reposByFirstSeg.set(firstSeg, bucket); }
    bucket.push(repo);
  }
  const grouped: Record<string, string[]> = {};
  const unmatched: string[] = [];
  for (const file of files) {
    const candidates = reposByFirstSeg.get(file.split('/')[0]);
    // Select the longest (most-specific) matching sub-repo prefix so nested
    // sub_repos (e.g. ['packages', 'packages/core']) route correctly regardless
    // of array order. (#391) String() guards the length read so non-string
    // entries never throw, matching the tolerance of the prior `.find` path.
    let match: string | undefined;
    let matchLen = -1;
    if (candidates) {
      for (const repo of candidates) {
        if (file.startsWith(repo + '/')) {
          const repoLen = String(repo).length;
          if (repoLen > matchLen) {
            match = repo;
            matchLen = repoLen;
          }
        }
      }
    }
    if (match) {
      (grouped[match] ||= []).push(file);
    } else {
      unmatched.push(file);
    }
  }
  return { grouped, unmatched };
}

function cmdCommitToSubrepo(cwd: string, message: string | undefined, files: string[] | undefined, raw: boolean): void {
  if (!message) {
    error('commit message required');
  }

  const config = loadConfig(cwd);
  const subRepos = config['sub_repos'] as string[] | undefined;

  if (!subRepos || subRepos.length === 0) {
    error('no sub_repos configured in .planning/config.json');
  }

  if (!files || files.length === 0) {
    error('--files required for commit-to-subrepo');
  }

  // Group files by sub-repo prefix
  const { grouped, unmatched } = groupFilesBySubrepo(files as string[], subRepos as string[]);

  if (unmatched.length > 0) {
    process.stderr.write(`Warning: ${unmatched.length} file(s) did not match any sub-repo prefix: ${unmatched.join(', ')}\n`);
  }

  const repos: Record<string, CommitToSubrepoRepoResult> = {};
  for (const [repo, repoFiles] of Object.entries(grouped)) {
    const repoCwd = path.join(cwd, repo);

    // Stage files (strip sub-repo prefix for paths relative to that repo)
    // #2608: this is the sub-repo twin of cmdCommit's staging loop and carried
    // the identical defect — a failed `git add` was dropped silently and the
    // function went straight on to commit the subset that happened to stage,
    // discarding git's stderr. Fails closed per-repo, with the same rollback of
    // only what this call staged.
    const preStagedSub = new Set(
      execGit(['diff', '--cached', '--name-only'], { cwd: repoCwd })
        .stdout.split('\n').map(s => s.trim()).filter(Boolean),
    );
    const stagedRelPaths: string[] = [];
    const subStagingFailures: Array<{ file: string; error: string; timed_out: boolean }> = [];
    for (const file of repoFiles) {
      const relativePath = file.slice(repo.length + 1);
      const addResult = execGit(['add', relativePath], { cwd: repoCwd });
      if (addResult.exitCode === 0) {
        stagedRelPaths.push(relativePath);
      } else {
        const addErr: NodeJS.ErrnoException | null = addResult.error;
        subStagingFailures.push({
          file,
          error: addResult.stderr || addResult.stdout,
          timed_out: addResult.signal === 'SIGTERM' && addErr?.code === 'ETIMEDOUT',
        });
      }
    }
    if (subStagingFailures.length > 0) {
      const toUnstageSub = stagedRelPaths.filter(p => !preStagedSub.has(p));
      if (toUnstageSub.length > 0) {
        execGit(['reset', '-q', '--', ...toUnstageSub], { cwd: repoCwd });
      }
      const firstSub = subStagingFailures[0];
      repos[repo] = {
        committed: false,
        hash: null,
        files: repoFiles,
        reason: firstSub.timed_out ? 'staging_timeout' : 'staging_failed',
        error: firstSub.error,
      };
      continue;
    }

    // Commit — pathspec limits the commit to the staged files only (#2112)
    const isMergeInProgressSub = execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoCwd }).exitCode === 0;
    const canScopeSub = stagedRelPaths.length > 0 && !isMergeInProgressSub;
    const commitArgs = canScopeSub
      ? ['commit', '-m', message as string, '--', ...stagedRelPaths]
      : ['commit', '-m', message as string];
    const commitResult = execGit(commitArgs, { cwd: repoCwd });
    if (commitResult.exitCode !== 0) {
      if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
        repos[repo] = { committed: false, hash: null, files: repoFiles, reason: 'nothing_to_commit' };
        continue;
      }
      repos[repo] = { committed: false, hash: null, files: repoFiles, reason: 'error', error: commitResult.stderr };
      continue;
    }

    // Get hash
    const hashResult = execGit(['rev-parse', '--short', 'HEAD'], { cwd: repoCwd });
    const hash = hashResult.exitCode === 0 ? hashResult.stdout : null;
    repos[repo] = { committed: true, hash, files: repoFiles };
  }

  const result = {
    committed: Object.values(repos).some(r => r.committed),
    repos,
    unmatched: unmatched.length > 0 ? unmatched : undefined,
  };
  output(result, raw, Object.entries(repos).map(([r, v]) => `${r}:${v.hash || 'skip'}`).join(' '));
}

/**
 * Prepare a sub-repo for a companion PR branch.
 *
 * Detects uncommitted changes, creates a new branch, stages every changed
 * file explicitly (never git add -A per universal-anti-patterns.md:44), commits,
 * and pushes with --set-upstream. Returns a structured result the workflow uses
 * to call `gh pr create`.
 *
 * On a stage/commit failure (nothing committed yet), the branch is deleted and
 * the caller is returned to the original HEAD so the repo is left clean. On a
 * push failure, the commit already exists — the branch is left in place instead
 * so the user's work is not lost; the error includes a retry instruction.
 */
function cmdPrSubrepo(
  cwd: string,
  repo: string | undefined,
  branch: string | undefined,
  commitMessage: string | undefined,
  raw: boolean,
): void {
  if (!repo) {
    error('--repo required');
  }
  if (!branch) {
    error('--branch required');
  }
  if (!commitMessage || commitMessage.startsWith('--')) {
    error('commit message required');
  }
  if ((branch as string).startsWith('-')) {
    error(`Branch name must not start with '-': ${branch}`);
  }

  // 0. Security: validate repo path is contained within the workspace root.
  //    Uses security.cjs validatePath (symlink-safe realpathSync + startsWith guard)
  //    to reject ../escape, absolute paths, and symlink traversal.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validatePath } = require('./security.cjs') as {
    validatePath(filePath: string, baseDir: string): { safe: boolean; resolved: string; error?: string };
  };
  const pathCheck = validatePath(repo as string, cwd);
  if (!pathCheck.safe) {
    error(`Sub-repo path is unsafe: ${pathCheck.error}`);
  }
  const repoCwd = pathCheck.resolved;
  if (!fs.existsSync(repoCwd)) {
    error(`Sub-repo not found: ${repoCwd}`);
  }

  // 1. Collect changed files via porcelain status — explicit, never git add -A.
  //    ?? (untracked) lines are excluded — only stage tracked modifications.
  const statusResult = execGit(['-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd: repoCwd });
  if (statusResult.exitCode !== 0) {
    error(`git status failed in ${repo}: ${statusResult.stderr}`);
  }

  // Parse porcelain output into two lists:
  //   changedFiles — all affected paths (old + new for renames) → goes into result.files
  //   filesToStage — paths to pass to git add (rename old-paths are already staged by
  //                  the rename op and no longer exist in the worktree; only add new paths)
  const changedFiles: string[] = [];
  const filesToStage: string[] = [];
  for (const line of statusResult.stdout.split('\n').filter(Boolean).filter(l => !l.startsWith('??'))) {
    // execGit trims the entire stdout string, which may strip the leading X-status
    // space from the first output line. Normalize before slicing.
    const normalized = line.trimStart();
    const file = normalized.slice(2).trim();
    const arrowIdx = file.indexOf(' -> ');
    if (arrowIdx !== -1) {
      const oldPath = file.slice(0, arrowIdx).trim();
      const newPath = file.slice(arrowIdx + 4).trim();
      changedFiles.push(oldPath, newPath);
      filesToStage.push(newPath); // old path already staged; worktree no longer has it
    } else {
      changedFiles.push(file);
      filesToStage.push(file);
    }
  }

  if (changedFiles.length === 0) {
    output(
      { ok: true, repo, branch, committed: false, reason: 'nothing_to_commit', files: [] },
      raw,
      'nothing_to_commit',
    );
    return;
  }

  // 2. Guard: refuse if branch already exists — checkout -b is non-idempotent
  const branchCheck = execGit(['rev-parse', '--verify', branch as string], { cwd: repoCwd });
  if (branchCheck.exitCode === 0) {
    error(`Branch already exists in ${repo}: ${branch}. Delete it first or choose a unique name.`);
  }

  // Capture current HEAD before switching so rollback can return explicitly.
  // git checkout - fails on a fresh single-branch repo with no prior HEAD.
  const prevBranchResult = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoCwd });
  const prevBranchName = prevBranchResult.exitCode === 0 ? prevBranchResult.stdout.trim() : null;

  // 3. Create branch
  const checkoutResult = execGit(['checkout', '-b', branch as string], { cwd: repoCwd });
  if (checkoutResult.exitCode !== 0) {
    error(`Failed to create branch ${branch} in ${repo}: ${checkoutResult.stderr}`);
  }

  // Helper: rollback the created branch and return to the previous HEAD.
  const rollback = (): void => {
    if (prevBranchName) {
      execGit(['checkout', prevBranchName], { cwd: repoCwd });
    }
    execGit(['branch', '-D', branch as string], { cwd: repoCwd });
  };

  // 4. Stage explicit files (never git add -A per universal-anti-patterns.md:44)
  for (const file of filesToStage) {
    const addResult = execGit(['add', '--', file], { cwd: repoCwd });
    if (addResult.exitCode !== 0) {
      rollback();
      error(`Failed to stage ${file} in ${repo}: ${addResult.stderr}`);
    }
  }

  // 5. Commit — pathspec limits the commit to the staged files only (#2112).
  // changedFiles includes both old and new paths for renames so the full
  // rename is captured atomically (pathspec on newPath alone would leave the
  // deletion of oldPath stranded in the index).
  const isMergeInProgressPr = execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoCwd }).exitCode === 0;
  const canScopePr = changedFiles.length > 0 && !isMergeInProgressPr;
  const commitArgs = canScopePr
    ? ['commit', '-m', commitMessage as string, '--', ...changedFiles]
    : ['commit', '-m', commitMessage as string];
  const commitResult = execGit(commitArgs, { cwd: repoCwd });
  if (commitResult.exitCode !== 0) {
    rollback();
    error(`Failed to commit in ${repo}: ${commitResult.stderr}`);
  }

  // 6. Capture commit hash
  const hashResult = execGit(['rev-parse', '--short', 'HEAD'], { cwd: repoCwd });
  const commitHash = hashResult.exitCode === 0 ? hashResult.stdout.trim() : null;

  // 7. Capture remote URL and derive GitHub owner/repo slug for gh pr create
  const remoteResult = execGit(['remote', 'get-url', 'origin'], { cwd: repoCwd });
  const remoteUrl = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
  let remoteSlug: string | null = null;
  if (remoteUrl) {
    const m = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    remoteSlug = m ? m[1] : null;
  }

  // 8. Push with --set-upstream so gh pr create can find the branch.
  //    Network operation — use a longer timeout than the default 10 s.
  //    Do NOT rollback on push failure — the commit already exists on the local branch.
  //    Deleting the branch here would destroy the only ref holding the user's work.
  //    Leave the branch in place so the user can retry the push.
  const pushResult = execGit(['push', '--set-upstream', 'origin', branch as string], { cwd: repoCwd, timeout: 60_000 });
  if (pushResult.exitCode !== 0) {
    error(`Failed to push ${branch} in ${repo}: ${pushResult.stderr}\nBranch ${branch} was created locally — retry with: git -C ${repo} push --set-upstream origin ${branch}`);
  }

  const result = {
    ok: true,
    repo,
    branch,
    committed: true,
    files: changedFiles,
    commit_hash: commitHash,
    remote_url: remoteUrl,
    remote_slug: remoteSlug,
  };
  output(result, raw, `${repo}@${commitHash ?? 'unknown'}`);
}

function cmdSummaryExtract(cwd: string, summaryPath: string | undefined, fields: string[] | undefined, raw: boolean): void {
  if (!summaryPath) {
    error('summary-path required for summary-extract');
  }

  const fullPath = path.join(cwd, summaryPath as string);

  if (!fs.existsSync(fullPath)) {
    output({ error: 'File not found', path: summaryPath }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content) as Record<string, unknown>;

  // Parse key-decisions into structured format
  const parseDecisions = (decisionsList: unknown) => {
    if (!decisionsList || !Array.isArray(decisionsList)) return [];
    return (decisionsList as string[]).map(d => {
      const colonIdx = d.indexOf(':');
      if (colonIdx > 0) {
        return {
          summary: d.substring(0, colonIdx).trim(),
          rationale: d.substring(colonIdx + 1).trim(),
        };
      }
      return { summary: d, rationale: null };
    });
  };

  const techStack = fm['tech-stack'] as { added?: string[] } | undefined;

  // Build full result
  const fullResult: Record<string, unknown> = {
    path: summaryPath,
    one_liner: fm['one-liner'] || extractOneLinerFromBody(content) || null,
    key_files: fm['key-files'] || [],
    tech_added: (techStack && techStack['added']) || [],
    patterns: fm['patterns-established'] || [],
    decisions: parseDecisions(fm['key-decisions']),
    // Tolerate both key forms: the template/reader use kebab `requirements-completed`,
    // but the tool's own JSON output and the milestone audit `--pick` use snake
    // `requirements_completed`. Reading both prevents a snake-keyed SUMMARY (the form the
    // tool emits) from being silently dropped to []. See #628.
    requirements_completed: fm['requirements-completed'] ?? fm['requirements_completed'] ?? [],
  };

  // If fields specified, filter to only those fields
  if (fields && fields.length > 0) {
    const filtered: Record<string, unknown> = { path: summaryPath };
    for (const field of fields) {
      if (fullResult[field] !== undefined) {
        filtered[field] = fullResult[field];
      }
    }
    output(filtered, raw, undefined);
    return;
  }

  output(fullResult, raw, undefined);
}

function _wsSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _wsParseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Math.max(parseInt(trimmed, 10) * 1000, 0), 60000);
  }
  const asDate = Date.parse(trimmed);
  if (!isNaN(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), 60000);
  }
  return null;
}

function _wsRetryDelayMs(attempt: number): number {
  const base = 250;
  const cap = 2000;
  const exp = Math.min(base * Math.pow(2, attempt), cap);
  return exp + Math.floor(Math.random() * 100);
}

async function cmdWebsearch(query: string | undefined, options: WebsearchOptions, raw: boolean): Promise<void> {
  const apiKey = process.env['BRAVE_API_KEY'];

  if (!apiKey) {
    // No key = silent skip, agent falls back to built-in WebSearch
    output({ available: false, reason: 'BRAVE_API_KEY not set' }, raw, '');
    return;
  }

  if (!query) {
    output({ available: false, error: 'Query required' }, raw, '');
    return;
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.limit || 10),
    country: 'us',
    search_lang: 'en',
    text_decorations: 'false'
  });

  if (options.freshness) {
    params.set('freshness', options.freshness);
  }

  const rawTimeout = parseInt(process.env['GSD_WEBSEARCH_TIMEOUT_MS'] as string, 10);
  const timeoutMs = (Number.isInteger(rawTimeout) && rawTimeout > 0) ? rawTimeout : 10000;

  const MAX_RETRIES = 2;
  let attempt = 0;

  while (true) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
      let response: Response;
      try {
        response = await fetch(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `https://api.search.brave.com/res/v1/web/search?${params}`,
          {
            headers: {
              'Accept': 'application/json',
              'X-Subscription-Token': apiKey
            },
            signal: ac.signal
          }
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string; age?: string }> } };
        const results = (data.web?.results || []).map(r => ({
          title: r.title,
          url: r.url,
          description: r.description,
          age: r.age || null
        }));
        output({
          available: true,
          query,
          count: results.length,
          results
        }, raw, results.map(r => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'));
        return;
      }

      const status = response.status;
      const isRetryable = status === 429 || status >= 500;

      if (!isRetryable) {
        // Non-retryable 4xx — fail immediately, no attempts field
        output({ available: false, error: `API error: ${status}` }, raw, '');
        return;
      }

      // Retryable HTTP error
      attempt++;
      if (attempt > MAX_RETRIES) {
        output({ available: false, error: `API error: ${status}`, attempts: attempt }, raw, '');
        return;
      }

      let delay: number;
      if (status === 429) {
        const retryAfter = _wsParseRetryAfter(response.headers.get('retry-after'));
        delay = retryAfter !== null ? retryAfter : _wsRetryDelayMs(attempt - 1);
      } else {
        delay = _wsRetryDelayMs(attempt - 1);
      }
      await _wsSleep(delay);

    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        output({ available: false, error: (err as Error).message, attempts: attempt }, raw, '');
        return;
      }
      await _wsSleep(_wsRetryDelayMs(attempt - 1));
    }
  }
}

function cmdProgressRender(cwd: string, format: string | undefined, raw: boolean): void {
  const phasesDir = planningPaths(cwd).phases;
  const milestone = getMilestoneInfo(cwd);

  const phases: PhaseProgress[] = [];
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => comparePhaseNum(a, b));

    for (const dir of dirs) {
      const dm = dir.match(/^(\d+(?:\.\d+)*)-?(.*)/);
      const phaseNum = dm ? dm[1] : dir;
      const phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;

      totalPlans += plans;
      totalSummaries += summaries;

      const status = determinePhaseStatus(plans, summaries, path.join(phasesDir, dir), 'Pending');

      phases.push({ number: phaseNum, name: phaseName, plans, summaries, status });
    }
  } catch { /* intentionally empty */ }

  const percent = totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0;

  if (format === 'table') {
    // Render markdown table
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name}\n\n`;
    out += `**Progress:** [${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)\n\n`;
    out += `| Phase | Name | Plans | Status |\n`;
    out += `|-------|------|-------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.summaries}/${p.plans} | ${p.status} |\n`;
    }
    output({ rendered: out }, raw, out);
  } else if (format === 'bar') {
    const barWidth = 20;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const text = `[${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)`;
    output({ bar: text, percent, completed: totalSummaries, total: totalPlans }, raw, text);
  } else {
    // JSON format
    output({
      milestone_version: milestone.version,
      milestone_name: milestone.name,
      phases,
      total_plans: totalPlans,
      total_summaries: totalSummaries,
      percent,
    }, raw, undefined);
  }
}

/**
 * Match pending todos against a phase's goal/name/requirements.
 * Returns todos with relevance scores based on keyword, area, and file overlap.
 * Used by discuss-phase to surface relevant todos before scope-setting.
 */
function cmdTodoMatchPhase(cwd: string, phase: string | undefined, raw: boolean): void {
  if (!phase) { error('phase required for todo match-phase'); }

  const pendingDir = path.join(planningDir(cwd), 'todos', 'pending');
  const todos: Array<{
    file: string;
    title: string;
    area: string;
    files: string[];
    body: string;
  }> = [];

  // Load pending todos
  try {
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = platformReadSync(path.join(pendingDir, file));
      if (content === null) continue;
      const titleMatch = content.match(/^title:\s*(.+)$/m);
      const areaMatch = content.match(/^area:\s*(.+)$/m);
      const filesMatch = content.match(/^files:\s*(.+)$/m);
      const body = content.replace(/^(title|area|files|created|priority):.*$/gm, '').trim();

      todos.push({
        file,
        title: titleMatch ? titleMatch[1].trim() : 'Untitled',
        area: areaMatch ? areaMatch[1].trim() : 'general',
        files: filesMatch ? filesMatch[1].trim().split(/[,\s]+/).filter(Boolean) : [],
        body: body.slice(0, 200), // first 200 chars for context
      });
    }
  } catch { /* intentionally empty */ }

  if (todos.length === 0) {
    output({ phase, matches: [], todo_count: 0 }, raw, undefined);
    return;
  }

  // Load phase goal/name from ROADMAP
  const phaseInfo = getRoadmapPhaseInternal(cwd, phase) as Record<string, unknown> | null;
  const phaseName = phaseInfo ? ((phaseInfo['phase_name'] as string) || '') : '';
  const phaseGoal = phaseInfo ? ((phaseInfo['goal'] as string) || '') : '';
  const phaseSection = phaseInfo ? ((phaseInfo['section'] as string) || '') : '';

  // Build keyword set from phase name + goal + section text
  const phaseText = `${phaseName} ${phaseGoal} ${phaseSection}`.toLowerCase();
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'are', 'was', 'has', 'have', 'been', 'not', 'but', 'all', 'can', 'into', 'each', 'when', 'any', 'use', 'new']);
  const phaseKeywords = new Set(
    phaseText.split(/[\s\-_/.,;:()\[\]{}|]+/)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length > 2 && !stopWords.has(w))
  );

  // Find phase directory to get expected file paths
  const phaseInfoDisk = findPhaseInternal(cwd, phase) as Record<string, unknown> | null;
  const phasePlans: string[] = [];
  if (phaseInfoDisk && phaseInfoDisk['found']) {
    try {
      const phaseDir = path.join(cwd, phaseInfoDisk['directory'] as string);
      const planFiles = fs.readdirSync(phaseDir).filter(f => f.endsWith('-PLAN.md'));
      for (const pf of planFiles) {
        const planContent = platformReadSync(path.join(phaseDir, pf));
        if (planContent === null) continue;
        const fmFiles = planContent.match(/files_modified:\s*\[([^\]]{0,8000})\]/);
        if (fmFiles) {
          phasePlans.push(...fmFiles[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean));
        }
      }
    } catch { /* intentionally empty */ }
  }

  // Score each todo for relevance
  const matches: Array<{
    file: string;
    title: string;
    area: string;
    score: number;
    reasons: string[];
  }> = [];
  for (const todo of todos) {
    let score = 0;
    const reasons: string[] = [];

    // Keyword match: todo title/body terms in phase text
    const todoWords = `${todo.title} ${todo.body}`.toLowerCase()
      .split(/[\s\-_/.,;:()\[\]{}|]+/)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length > 2 && !stopWords.has(w));

    const matchedKeywords = todoWords.filter(w => phaseKeywords.has(w));
    if (matchedKeywords.length > 0) {
      score += Math.min(matchedKeywords.length * 0.2, 0.6);
      reasons.push(`keywords: ${[...new Set(matchedKeywords)].slice(0, 5).join(', ')}`);
    }

    // Area match: todo area appears in phase text
    if (todo.area !== 'general' && phaseText.includes(todo.area.toLowerCase())) {
      score += 0.3;
      reasons.push(`area: ${todo.area}`);
    }

    // File match: todo files overlap with phase plan files
    if (todo.files.length > 0 && phasePlans.length > 0) {
      const fileOverlap = todo.files.filter(f =>
        phasePlans.some(pf => pf.includes(f) || f.includes(pf))
      );
      if (fileOverlap.length > 0) {
        score += 0.4;
        reasons.push(`files: ${fileOverlap.slice(0, 3).join(', ')}`);
      }
    }

    if (score > 0) {
      matches.push({
        file: todo.file,
        title: todo.title,
        area: todo.area,
        score: Math.round(score * 100) / 100,
        reasons,
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  output({ phase, matches, todo_count: todos.length }, raw, undefined);
}

function cmdTodoComplete(cwd: string, filename: string | undefined, raw: boolean): void {
  if (!filename) {
    error('filename required for todo complete');
  }

  const pendingDir = path.join(planningDir(cwd), 'todos', 'pending');
  const completedDir = path.join(planningDir(cwd), 'todos', 'completed');
  const sourcePath = path.join(pendingDir, filename as string);

  if (!fs.existsSync(sourcePath)) {
    error(`Todo not found: ${filename as string}`);
  }

  // Ensure completed directory exists
  platformEnsureDir(completedDir);

  // Read, add completion timestamp, move
  let content = fs.readFileSync(sourcePath, 'utf-8');
  const today = realClock.localToday();
  content = `completed: ${today}\n` + content;

  platformWriteSync(path.join(completedDir, filename as string), content);
  fs.unlinkSync(sourcePath);

  output({ completed: true, file: filename, date: today }, raw, 'completed');
}

function cmdScaffold(cwd: string, type: string, options: ScaffoldOptions, raw: boolean): void {
  const { phase, name } = options;
  const padded = phase ? normalizePhaseName(phase) : '00';
  const today = realClock.localToday();

  // Find phase directory
  const phaseInfo = phase ? findPhaseInternal(cwd, phase) as Record<string, unknown> | null : null;
  const phaseDir = phaseInfo ? path.join(cwd, phaseInfo['directory'] as string) : null;

  if (phase && !phaseDir && type !== 'phase-dir') {
    error(`Phase ${phase} directory not found`);
  }

  let filePath: string, content: string;

  switch (type) {
    case 'context': {
      filePath = path.join(phaseDir as string, `${padded}-CONTEXT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'}"\ncreated: ${today}\n---\n\n# Phase ${phase}: ${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'} — Context\n\n## Decisions\n\n_Decisions will be captured during ${String(formatGsdSlash('discuss-phase', resolveRuntime(cwd)))} ${phase}_\n\n## Discretion Areas\n\n_Areas where the executor can use judgment_\n\n## Deferred Ideas\n\n_Ideas to consider later_\n`;
      break;
    }
    case 'uat': {
      filePath = path.join(phaseDir as string, `${padded}-UAT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'} — User Acceptance Testing\n\n## Test Results\n\n| # | Test | Status | Notes |\n|---|------|--------|-------|\n\n## Summary\n\n_Pending UAT_\n`;
      break;
    }
    case 'verification': {
      filePath = path.join(phaseDir as string, `${padded}-VERIFICATION.md`);
      content = `---\nphase: "${padded}"\nname: "${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || (phaseInfo?.['phase_name'] as string | undefined) || 'Unnamed'} — Verification\n\n## Goal-Backward Verification\n\n**Phase Goal:** [From ROADMAP.md]\n\n## Checks\n\n| # | Requirement | Status | Evidence |\n|---|------------|--------|----------|\n\n## Result\n\n_Pending verification_\n`;
      break;
    }
    case 'phase-dir': {
      if (!phase || !name) {
        error('phase and name required for phase-dir scaffold');
      }
      const slug = generateSlugInternal(name);
      // #3287: apply project_code prefix to stay consistent with phase.add/phase.insert
      const scaffoldConfig = loadConfig(cwd);
      const scaffoldProjectCode = (scaffoldConfig['project_code'] as string) || '';
      const scaffoldPrefix = scaffoldProjectCode ? `${scaffoldProjectCode}-` : '';
      const dirName = `${scaffoldPrefix}${padded}-${slug}`;
      const phasesParent = planningPaths(cwd).phases;
      platformEnsureDir(phasesParent);
      const dirPath = path.join(phasesParent, dirName);
      platformEnsureDir(dirPath);
      output({ created: true, directory: toPosixPath(path.relative(cwd, dirPath)), path: dirPath }, raw, dirPath);
      return;
    }
    default:
      error(`Unknown scaffold type: ${type}. Available: context, uat, verification, phase-dir`);
      // unreachable — error() calls process.exit
      return;
  }

  if (fs.existsSync(filePath)) {
    output({ created: false, reason: 'already_exists', path: filePath }, raw, 'exists');
    return;
  }

  platformWriteSync(filePath, content);
  const relPath = toPosixPath(path.relative(cwd, filePath));
  output({ created: true, path: relPath }, raw, relPath);
}

function cmdStats(cwd: string, format: string | undefined, raw: boolean): void {
  const phasesDir = planningPaths(cwd).phases;
  const roadmapPath = planningPaths(cwd).roadmap;
  const reqPath = planningPaths(cwd).requirements;
  const statePath = planningPaths(cwd).state;
  const milestone = getMilestoneInfo(cwd);
  const isDirInMilestone = getMilestonePhaseFilter(cwd) as (dir: string) => boolean;

  // Phase & plan stats (reuse progress pattern)
  const phasesByNumber = new Map<string, {
    number: string;
    name: string;
    plans: number;
    summaries: number;
    status: string;
  }>();
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('roadmap missing');
    const roadmapContent = extractCurrentMilestone(roadmapRaw, cwd);
    // Matches both plain numeric (Phase 1:) and milestone-prefixed (Phase 2-01:) headings.
    // Also tolerates optional [bracket-token] scope prefix on phase headings.
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    const headingPattern = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:\s*([^\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(roadmapContent)) !== null) {
      const key = normalizePhaseName(match[1]);
      phasesByNumber.set(key, {
        number: key,
        name: match[2].replace(/\(INSERTED\)/i, '').trim(),
        plans: 0,
        summaries: 0,
        status: 'Not Started',
      });
    }
  } catch { /* intentionally empty */ }

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(isDirInMilestone)
      .sort((a, b) => comparePhaseNum(a, b));

    for (const dir of dirs) {
      // Use extractPhaseToken to correctly parse M-NN-style and code-prefixed dir names.
      const phaseToken = extractPhaseToken(dir) as string | null;
      const phaseNum = phaseToken || dir;
      // phaseName is everything after the token (strip leading '-')
      const afterToken = dir.slice(phaseToken ? phaseToken.length : 0).replace(/^-/, '');
      const phaseName = afterToken ? afterToken.replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;

      totalPlans += plans;
      totalSummaries += summaries;

      const status = determinePhaseStatus(plans, summaries, path.join(phasesDir, dir), 'Not Started');

      const normalizedNum = normalizePhaseName(phaseNum);
      const existing = phasesByNumber.get(normalizedNum);
      phasesByNumber.set(normalizedNum, {
        number: normalizedNum,
        name: existing?.name || phaseName,
        plans: (existing?.plans || 0) + plans,
        summaries: (existing?.summaries || 0) + summaries,
        // #2408: fold colliding statuses by precedence rather than overwriting
        // last-write-wins. fs.readdirSync order is non-deterministic across
        // platforms, so a naive overwrite can report a Complete phase as Not
        // Started (or vice versa) depending on read order. The fold picks the
        // furthest-along status, matching what an operator expects.
        status: existing ? foldPhaseStatus(existing.status, status) : status,
      });
    }
  } catch { /* intentionally empty */ }

  const phases = [...phasesByNumber.values()].sort((a, b) => comparePhaseNum(a.number, b.number));
  const completedPhases = phases.filter(p => p.status === 'Complete').length;
  const planPercent = totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0;
  const percent = phases.length > 0 ? Math.min(100, Math.round((completedPhases / phases.length) * 100)) : 0;

  // Requirements stats
  let requirementsTotal = 0;
  let requirementsComplete = 0;
  const reqContent = platformReadSync(reqPath);
  if (reqContent !== null) {
    const checked = reqContent.match(/^- \[x\] \*\*/gm);
    const unchecked = reqContent.match(/^- \[ \] \*\*/gm);
    requirementsComplete = checked ? checked.length : 0;
    requirementsTotal = requirementsComplete + (unchecked ? unchecked.length : 0);
  }

  // Last activity from STATE.md
  let lastActivity: string | null = null;
  const stateContent = platformReadSync(statePath);
  if (stateContent !== null) {
    const activityMatch = stateContent.match(/^last_activity:\s*(.+)$/im)
      || stateContent.match(/\*\*Last Activity:\*\*\s*(.+)/i)
      || stateContent.match(/^Last Activity:\s*(.+)$/im)
      || stateContent.match(/^Last activity:\s*(.+)$/im);
    if (activityMatch) lastActivity = activityMatch[1].trim();
  }

  // Git stats
  let gitCommits = 0;
  let gitFirstCommitDate: string | null = null;
  const commitCount = execGit(['rev-list', '--count', 'HEAD'], { cwd });
  if (commitCount.exitCode === 0) {
    gitCommits = parseInt(commitCount.stdout, 10) || 0;
  }
  const rootHash = execGit(['rev-list', '--max-parents=0', 'HEAD'], { cwd });
  if (rootHash.exitCode === 0 && rootHash.stdout) {
    const firstCommit = rootHash.stdout.split('\n')[0].trim();
    const firstDate = execGit(['show', '-s', '--format=%as', firstCommit], { cwd });
    if (firstDate.exitCode === 0) {
      gitFirstCommitDate = firstDate.stdout || null;
    }
  }

  const result = {
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    phases,
    phases_completed: completedPhases,
    phases_total: phases.length,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    percent,
    plan_percent: planPercent,
    requirements_total: requirementsTotal,
    requirements_complete: requirementsComplete,
    git_commits: gitCommits,
    git_first_commit_date: gitFirstCommitDate,
    last_activity: lastActivity,
  };

  if (format === 'table') {
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name} — Statistics\n\n`;
    out += `**Progress:** [${bar}] ${completedPhases}/${phases.length} phases (${percent}%)\n`;
    if (totalPlans > 0) {
      out += `**Plans:** ${totalSummaries}/${totalPlans} complete (${planPercent}%)\n`;
    }
    out += `**Phases:** ${completedPhases}/${phases.length} complete\n`;
    if (requirementsTotal > 0) {
      out += `**Requirements:** ${requirementsComplete}/${requirementsTotal} complete\n`;
    }
    out += '\n';
    out += `| Phase | Name | Plans | Completed | Status |\n`;
    out += `|-------|------|-------|-----------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.plans} | ${p.summaries} | ${p.status} |\n`;
    }
    if (gitCommits > 0) {
      out += `\n**Git:** ${gitCommits} commits`;
      if (gitFirstCommitDate) out += ` (since ${gitFirstCommitDate})`;
      out += '\n';
    }
    if (lastActivity) out += `**Last activity:** ${lastActivity}\n`;
    output({ rendered: out }, raw, out);
  } else {
    output(result, raw, undefined);
  }
}

/**
 * Check whether a commit should be allowed based on commit_docs config.
 * When commit_docs is false, rejects commits that stage .planning/ files.
 * Intended for use as a pre-commit hook guard.
 */
function cmdCheckCommit(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  // If commit_docs is true (or not set), allow all commits
  if (config['commit_docs'] !== false) {
    output({ allowed: true, reason: 'commit_docs_enabled' }, raw, 'allowed');
    return;
  }

  // commit_docs is false — check if any .planning/ files are staged
  const stagedResult = execGit(['diff', '--cached', '--name-only'], { cwd });
  if (stagedResult.exitCode === 0) {
    const planningFiles = stagedResult.stdout.split('\n').filter(f => f.startsWith('.planning/') || f.startsWith('.planning\\'));

    if (planningFiles.length > 0) {
      error(
        `commit_docs is false but ${planningFiles.length} .planning/ file(s) are staged:\n` +
        planningFiles.map(f => `  ${f}`).join('\n') +
        `\n\nTo unstage: git reset HEAD ${planningFiles.join(' ')}`
      );
    }
  }
  // exitCode !== 0 → no staged files or not a git repo — allow

  output({ allowed: true, reason: 'no_planning_files_staged' }, raw, 'allowed');
}

export = {
  groupFilesBySubrepo,
  determinePhaseStatus,
  foldPhaseStatus,
  PHASE_STATUS_PRECEDENCE,
  cmdGenerateSlug,
  cmdCurrentTimestamp,
  cmdListTodos,
  cmdListSeeds,
  deriveSeedIdentity,
  cmdVerifyPathExists,
  cmdHistoryDigest,
  cmdResolveModel,
  cmdResolveGranularity,
  cmdResolveExecution,
  cmdEffortSync,
  cmdCommit,
  cmdCommitToSubrepo,
  cmdPrSubrepo,
  cmdSummaryExtract,
  cmdWebsearch,
  cmdProgressRender,
  cmdTodoComplete,
  cmdTodoMatchPhase,
  cmdScaffold,
  cmdStats,
  cmdCheckCommit,
  _wsParseRetryAfter,
};
