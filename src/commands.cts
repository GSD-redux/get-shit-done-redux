/**
 * Commands — Standalone utility commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/commands.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeEol } from './text-lines.cjs';
import { execGit, platformWriteSync, platformReadSync, platformEnsureDir, isSpawnTimeout, retryRenameSync } from './shell-command-projection.cjs';
import { escapeRegex } from './pattern.cjs';
import { requireSafePath, sanitizeForDisplay } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig, isGitIgnored } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal, extractOneLinerFromBody } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const {
  normalizePhaseName,
  comparePhaseNum,
  extractPhaseToken,
  PHASE_NUMBER_TOKEN_SOURCE,
  isSentinelPhaseId,
  parsePhaseId,
  renderPhaseId,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
} = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdDisplayMod = require('./phase-id-display.cjs');
const { renderBracketMilestoneDisplay } = phaseIdDisplayMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { getArchivedPhaseDirs, findPhaseInternal, listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { extractCurrentMilestone, stripShippedMilestones: _stripShippedMilestones, getMilestoneInfo, getRoadmapPhaseInternal } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelResolverMod = require('./model-resolver.cjs');
const { resolveModelInternal, resolveTierInternal, resolveModelForTier, resolveProviderEscalation, resolveEffortInternal, resolveFastModeInternal, resolveEffortForTier, resolveGranularityInternal, assertValidGranularityOverride } = modelResolverMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import agentCommandRouterMod = require('./agent-command-router.cjs');
const { AGENT_FAILURE_CLASSES } = agentCommandRouterMod;
import { renderEffortForRuntime, renderEffortArgv, RUNTIMES_WITH_FAST_MODE, isAnthropicFlavoredModel } from './model-catalog.cjs';
// #3243 (ADR-2313 D7) — the Codex `.toml` sync's typed IR: parse/render/strip
// primitives moved from agent-install-check.cts's Phase-2 parsing into this
// leaf so both consumers share one block-range detector. See
// codex-agent-toml.cts's module header for the reader/writer reconciliation.
import { parseCodexAgentToml, renderCodexAgentToml, stripModel, stripReasoningEffort } from './codex-agent-toml.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import hostIntegrationMod = require('./host-integration.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningPaths, resolvePhaseIdConvention } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, agentScalarNeedsDoubleQuoting, escapeDoubleQuotedScalar } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { MODEL_PROFILES, VALID_PHASE_TYPES } = modelProfiles;
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { clampPercent } from './phase-lifecycle.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
const { resolveVerificationFile } = verificationMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArchivedPhaseDir {
  name: string;
  fullPath: string;
  milestone: string | null;
}

interface PhaseProgress {
  number: string;
  display_id?: string;
  name: string;
  plans: number;
  summaries: number;
  status: string;
}

interface BracketPhaseDirProjection {
  number: string;
  display_id: string;
  name: string;
}

/**
 * Project one canonical bracket directory onto its display identity and slug.
 *
 * The identity is deliberately obtained only through parsePhaseId/renderPhaseId;
 * this helper owns no second bracket grammar. Callers invoke it only after the
 * project's resolved convention is exactly `bracket`.
 */
function bracketPhaseDirProjection(dir: string): BracketPhaseDirProjection {
  const id = parsePhaseId(dir);
  const number = id.subphase ? `${id.phase}.${id.subphase}` : id.phase;
  const identityPrefix = `${id.project}.${id.milestone}-${number}`;
  const slug = dir.slice(identityPrefix.length).replace(/^-/, '');
  return {
    number,
    display_id: renderPhaseId(id),
    name: slug ? slug.replace(/-/g, ' ') : '',
  };
}

function recoverBracketPhaseName(dir: string, phaseToken: string): string {
  const tokenBoundary = `-${phaseToken}`;
  const tokenOffset = dir.indexOf(tokenBoundary);
  if (tokenOffset === -1) return '';
  const afterToken = dir.slice(tokenOffset + tokenBoundary.length).replace(/^-/, '');
  return afterToken ? afterToken.replace(/-/g, ' ') : '';
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
  /** #3886: true when the repo's git commit was timeout-killed (reason commit_timeout). */
  timed_out?: boolean;
}

interface EffortSyncChange {
  agent: string;
  // #3533 (10d) / #3706: from === null means the key was ABSENT; from === ''
  // means the key was PRESENT with an empty value. Collapsing both to null
  // would make "no key" and "empty key" indistinguishable in sync output.
  from: string | null;
  // #3533 (10d): to === null is the typed IR for omission (inherit strips the key).
  to: string | null;
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
    // #3473 F2: routed through the shared resolver (readdir order is
    // filesystem-dependent, so the prior hand-rolled `.find()` could pick
    // either file when a phase held both a canonical report and an ad-hoc
    // `-CORRECTION-VERIFICATION.md` worksheet — see #3357).
    // #3492: pin selection to THIS phase's own token so a stray cross-phase
    // or sentinel-numbered canonically-shaped file cannot outrank this
    // phase's own (possibly non-canonical) report.
    const phaseDirName = path.basename(phaseDir);
    const phaseToken = extractPhaseToken(phaseDirName);
    const verificationFile = resolveVerificationFile(files, { allowBare: true, phaseToken, phaseDirName });
    if (verificationFile) {
      const verificationFilePath = path.join(phaseDir, verificationFile);
      const content = platformReadSync(verificationFilePath) || '';
      // #1159 (Defect A): read ONLY the frontmatter `status` key to avoid false
      // matches from historical body metadata such as `previous_status: gaps_found`.
      // Full-text regexes like /status:\s*gaps_found/ match the substring inside
      // `previous_status: gaps_found`, producing incorrect phase status labels.
      const fm = extractFrontmatter(content, verificationFilePath) as Record<string, unknown>;
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

  // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
  // (generateSlugInternal, core-utils.cts) instead of re-implementing it —
  // this call site previously diverged from it (Cyrillic collapsed to "",
  // and truncation could leave a trailing hyphen; #2848/#2849).
  const slug = coreUtilsMod.generateSlugInternal(text) ?? '';

  const result = { slug };
  output(result, raw, slug);
}

function cmdCurrentTimestamp(format: string | undefined, raw: boolean): void {
  const now = new Date(realClock.now());
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

    const fm = extractFrontmatter(content, safeFilePath) as Record<string, unknown>;
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
      // #3183: canonical summary set (root+nested) from the single owner.
      // This call also opens every plan file's frontmatter to check
      // superseded status even though cmdHistoryDigest never uses planFiles
      // or the superseded distinction — that per-phase-dir cost is accepted
      // deliberately (correctness/single-ownership over micro-optimization;
      // summaryFiles itself is not superseded-filtered either way). Do not
      // "optimize" this back into a second hand-rolled summary derivation.
      const summaries = scanPhasePlans(dirPath).summaryFiles;

      for (const summary of summaries) {
        const summaryFilePath = path.join(dirPath, summary);
        const content = platformReadSync(summaryFilePath);
        if (content === null) continue;
        try {
          const fm = extractFrontmatter(content, summaryFilePath) as Record<string, unknown>;

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

  // Own-property guard: agentType is an unvalidated CLI positional, so a
  // prototype-chain value ("toString", "constructor") would otherwise return
  // an inherited truthy member from this plain object and misreport a
  // genuinely unknown agent as known (unknown_agent dropped from the result).
  const agentModelsMap = MODEL_PROFILES as Record<string, unknown>;
  const agentModels = Object.hasOwn(agentModelsMap, agentType!) ? agentModelsMap[agentType!] : undefined;
  // #2229: `tier` is additive — existing keys and their values are untouched, so
  // every `--pick model` / `--pick profile` / `--raw` consumer is unaffected. It
  // exists because the model id is deliberately blank under resolve_model_ids:"omit",
  // which leaves a tier-sensitive guard with nothing to read.
  const tier = resolveTierInternal(cwd, agentType!);
  const result = agentModels
    ? { model, profile, effort, tier }
    : { model, profile, effort, tier, unknown_agent: true };
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
  // #3007: pass the resolved model so the per-model advertised-effort ceiling
  // (CODEX_MODEL_EFFORT) is reachable from this production seam. `model` may
  // be a tier alias or a non-Codex id for other runtimes — that's fine and
  // must not be special-cased here: advertisedCodexEffort() falls back to the
  // family baseline for any id it doesn't recognize.
  const rendered = renderEffortForRuntime(runtime, effort, model);

  const fastModeSupported = RUNTIMES_WITH_FAST_MODE.has(runtime);

  // #3534 (10a): the effective effort — what the installed agent will actually
  // run at. `effort` above is the config cascade; for the claude runtime the
  // per-agent frontmatter key is the source of truth (Claude Code's Agent tool
  // has no per-spawn effort parameter), so the query reads the installed file.
  // An ABSENT key is a real state — the agent follows the session effort
  // ('inherit'), not drift. No file / no frontmatter / any read failure means
  // no evidence: the resolved value is reported, flagged 'resolved' so a
  // consumer can tell evidence from echo. Additive only — every existing key
  // is unchanged.
  let effortEffectiveSource: 'frontmatter' | 'frontmatter-absent' | 'resolved' = 'resolved';
  let effortEffective: string = effort;
  if (runtime === 'claude') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
      const { getGlobalConfigDir } = require('./runtime-homes.cjs') as { getGlobalConfigDir(runtime: string, explicitDir?: string | null): string };
      const agentsDirEff = path.join(getGlobalConfigDir(runtime), 'agents');
      const agentPath = path.join(agentsDirEff, `${agentType}.md`);
      // agentType is an unvalidated CLI positional: keep the read inside the
      // agents dir so `../../x` cannot point it elsewhere (defense in depth —
      // the reflected surface is only a frontmatter effort line).
      if (!path.resolve(agentPath).startsWith(path.resolve(agentsDirEff) + path.sep)) {
        throw new Error('agent path escapes the agents directory');
      }
      const agentContent = fs.readFileSync(agentPath, 'utf8');
      // eslint-disable-next-line local/no-unbounded-quantifier -- same lazy `*?` bounded by the `^---$/m` closing anchor as the sibling frontmatter regexes in this file
      const fmMatchEff = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(agentContent);
      if (fmMatchEff) {
        const effortLine = /^effort:[ \t]*(.+?)[ \t]*$/m.exec(fmMatchEff[1]);
        if (effortLine) {
          effortEffective = effortLine[1];
          effortEffectiveSource = 'frontmatter';
        } else {
          effortEffective = 'inherit';
          effortEffectiveSource = 'frontmatter-absent';
        }
      }
    } catch { /* no frontmatter evidence — stay on the resolved value */ }
  }

  // Own-property guard: agentType is an unvalidated CLI positional, so a
  // prototype-chain value ("toString", "constructor") would otherwise return
  // an inherited truthy member from this plain object and misreport a
  // genuinely unknown agent as known (unknown_agent dropped from the result).
  const agentModelsMap = MODEL_PROFILES as Record<string, unknown>;
  const agentModels = Object.hasOwn(agentModelsMap, agentType!) ? agentModelsMap[agentType!] : undefined;
  const result: Record<string, unknown> = {
    model,
    profile,
    effort,
    effort_rendered: rendered.value,
    effort_param: rendered.param,
    effort_propagation: rendered.channel,
    effort_requested: rendered.requested,
    effort_clamped: rendered.clamped,
    effort_clamp_reason: rendered.reason,
    effort_effective: effortEffective,
    effort_effective_source: effortEffectiveSource,
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
 * #488 — Replace or inject the `<key>:` value in YAML frontmatter.
 * Unlike injectEffortFrontmatter (install.js), this overwrites an existing value.
 * #3706: key-parameterised so the same line-editor serves both claude's
 * `effort:` and OpenCode's `variant:`. #3706: all offsets (eol, openLen,
 * closingStart) are derived from the MATCHED BLOCK, not the start of the
 * file, and the existing-key replace is scoped to the frontmatter span only.
 */
function setFrontmatterKeyLine(content: string, key: string, value: string): string {
  const fmRe = /^---\r?\n([\s\S]*?)^---\r?$/m;
  const match = fmRe.exec(content);
  if (!match) return content;
  const fmBody = match[1];
  // Both writers of these frontmatter keys — this sync path and the
  // install-side `frontmatterScalar` in runtime-artifact-conversion.cts —
  // now share one escaping rule: quote via `agentScalarNeedsDoubleQuoting` +
  // `escapeDoubleQuotedScalar` (both from frontmatter.cts) rather than each
  // interpolating `value` raw/differently.
  const renderedValue = agentScalarNeedsDoubleQuoting(value) ? `"${escapeDoubleQuotedScalar(value)}"` : value;
  // EOL comes from the MATCHED BLOCK, not the start of the file. With a
  // preamble the two can disagree, and on a CRLF document that misaligns every
  // offset below by one byte and mangles the opening fence.
  const eol = /^---\r\n/.test(match[0]) ? '\r\n' : '\n';
  const openLen = 3 + eol.length;
  const bodyStart = match.index + openLen;
  const closingStart = bodyStart + fmBody.length;
  // #3706: key is now generic (not just the literal 'effort'/'variant'
  // callers happen to pass today) — escape it before interpolating into the
  // RegExp so a future caller can't have its key metacharacters reinterpreted.
  const keyLineRe = new RegExp(`^(${escapeRegex(key)}:)[ \\t]*.*$`, 'm');
  if (keyLineRe.test(fmBody)) {
    // #3706: a duplicated `<key>:` line is already invalid YAML, but a
    // non-first-wins reader (last-wins) would otherwise honour a stale
    // second occurrence left behind by a naive single-hit replace, while
    // this function's own single-hit read reports "in sync" — a
    // permanently non-converging state. Use a GLOBAL replace with a
    // first-hit flag so every occurrence collapses to exactly one, IN THE
    // POSITION of the first occurrence (never delete-then-append, which
    // would move the key to the end of the frontmatter and churn every
    // already-generated single-occurrence file).
    const escaped = escapeRegex(key);
    let seen = false;
    const newBody = fmBody.replace(
      new RegExp(`^${escaped}:[ \\t]*.*(\\r?\\n?)`, 'gm'),
      (_m, nl) => {
        if (!seen) {
          seen = true;
          return `${key}: ${renderedValue}${nl}`;
        }
        return '';
      },
    );
    // Replace INSIDE the frontmatter span only: a whole-file /m replace would
    // rewrite an earlier preamble line that happens to start with this key.
    return content.slice(0, bodyStart) + newBody + content.slice(closingStart);
  }
  return content.slice(0, closingStart) + `${key}: ${renderedValue}${eol}` + content.slice(closingStart);
}

/**
 * #3533 (10d) — remove exactly the frontmatter `<key>:` line (and its line
 * ending) so an agent configured for `inherit` carries NO key. Mirrors the
 * codex-agent-toml strip discipline: targeted line removal, EOL-aware, every
 * other byte (comments, sibling keys, the body) untouched.
 * #3706: key-parameterised so the same line-editor serves both claude's
 * `effort:` and OpenCode's `variant:`. #3706: openLen is derived from the
 * MATCHED BLOCK, not the start of the file — a preamble on a CRLF document
 * would otherwise misalign every offset below.
 */
function removeFrontmatterKeyLine(content: string, key: string): string {
  // Scoped to the FIRST frontmatter block (not a whole-file /m match): a
  // preamble or body line starting with `<key>:` (a fenced config example,
  // a thematic-break flanked fragment) must never be the line removed.
  const fmRe = /^---\r?\n([\s\S]*?)^---\r?$/m;
  const match = fmRe.exec(content);
  if (!match) return content;
  const fmBody = match[1];
  // #3706: same generic-key escape as setFrontmatterKeyLine above.
  const lineRe = new RegExp(`^${escapeRegex(key)}:[ \\t]*.*\\r?\\n?`, 'm');
  if (!lineRe.test(fmBody)) return content;
  // A duplicate `<key>:` mapping key is already invalid YAML (a document with
  // two `effort:`/`variant:` lines does not parse), so this is robustness
  // against a malformed document, not a live corruption path. Still, "a null
  // target means the key must not exist" is an invariant this function must
  // leave true on disk — a non-global replace here would strip only the
  // FIRST occurrence and require a second run to converge. Use a fresh
  // global RegExp for the strip so every occurrence in the frontmatter body
  // is removed in one pass.
  const stripAllRe = new RegExp(`^${escapeRegex(key)}:[ \\t]*.*\\r?\\n?`, 'gm');
  const strippedFm = fmBody.replace(stripAllRe, '');
  // Same rule as setFrontmatterKeyLine: the EOL must come from the matched
  // block, not the start of the file, or a preambled CRLF document misaligns.
  const eol = /^---\r\n/.test(match[0]) ? '\r\n' : '\n';
  const openLen = 3 + eol.length;
  const closingStart = match.index + openLen + fmBody.length;
  return content.slice(0, match.index + openLen) + strippedFm + content.slice(closingStart);
}

/** #488 — Replace or inject the `effort:` value in YAML frontmatter. */
function setEffortFrontmatter(content: string, effortValue: string): string {
  return setFrontmatterKeyLine(content, 'effort', effortValue);
}

/** #3533 (10d) — remove exactly the frontmatter `effort:` line (and its line ending). */
function removeEffortFrontmatter(content: string): string {
  return removeFrontmatterKeyLine(content, 'effort');
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

  // ADR-2313 D7 (#3243) — Codex gets its own `.toml` sync path (strip a stale
  // Anthropic/tier `model` and an orphaned `model_reasoning_effort`, leaving a
  // legal pin untouched). Every other non-claude runtime keeps the prior
  // early-return; the claude branch below is untouched byte-for-byte.
  if (runtime === 'codex') {
    cmdEffortSyncCodex(raw, dryRun, opts.configDir);
    return;
  }

  // #3706: install now bakes OpenCode's resolved effort into agent
  // frontmatter under the `variant:` key (not `effort:`), so OpenCode gets
  // its own sync path — mirroring the codex branch above — rather than
  // falling into the generic "does not use effort: frontmatter" skip.
  if (runtime === 'opencode') {
    cmdEffortSyncOpencode(cwd, raw, dryRun, opts.configDir);
    return;
  }

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
    readGsdEffectiveEffortConfig(cwd: string): Record<string, unknown> | null;
    resolveInstallTimeEffort(cfg: Record<string, unknown> | null, agentName: string): string;
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
  }).sort(); // #3706: sorted like the codex and
  // opencode branches — readdir order is platform-dependent, so leaving it unsorted makes the
  // reported `changes` ordering differ across machines for identical inputs.

  const changes: EffortSyncChange[] = [];
  let synced = 0;
  let skipped = 0;
  // Local-only counter: reads AND writes are both guarded in this loop (an
  // unreadable or unwritable agent file must not abort the whole sweep), but
  // this result shape (`{synced, skipped, changes, dry_run, agents_dir}`) is
  // long-standing and widely consumed, so it deliberately gains NO new key
  // (no `read_failures`/`write_failures`, unlike the codex/opencode branches
  // below). Instead every per-file failure — read or write — is folded into
  // `skipped` and rides the raw-mode summary token below — `output()`'s
  // third argument is never merged into the emitted JSON object (see io.cts
  // `output()`: it is only read when `raw === true`, entirely replacing the
  // JSON payload), so flipping it to `'failed'` costs nothing in the wire
  // shape while still surfacing the failure to a raw-mode caller. The three
  // branches differ on that reporting shape, but are now also consistent in
  // HOW they publish: every write below goes through the same tmp-file +
  // chmod + retryRenameSync atomic-publish sequence used by
  // cmdEffortSyncCodex and cmdEffortSyncOpencode, so a fault mid-write can
  // never leave an agent file truncated or empty.
  let fileFailureCount = 0;

  for (const file of files) {
    const agentName = file.replace(/\.md$/, '');
    const filePath = path.join(agentsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      // An unreadable agent file must not abort the whole sweep. Deliberately
      // NOT adding a new field here: this result shape (`{synced, skipped,
      // changes, dry_run, agents_dir}`) is long-standing and widely consumed,
      // so the failure is folded into `skipped` only, with no
      // read_failures/write_failures list — see `fileFailureCount` above.
      skipped++;
      fileFailureCount++;
      continue;
    }

    // Resolve using install-time logic: home defaults merged with project config.
    const universalEffort = resolveInstallTimeEffort(effortCfg, agentName);

    // #3533 (10d): 'inherit' means the key must NOT exist. An absent key is
    // the CORRECT state (in sync, skipped) — before #3533 absence read as null
    // drift and the sync re-added a hand-stripped key on every apply. A
    // present key under inherit is stripped, reported as {from, to: null}.
    if (universalEffort === 'inherit') {
      const fmMatchInherit = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(content);
      if (!fmMatchInherit) { skipped++; continue; }
      // Presence and value are distinct questions: `effort:` with an EMPTY
      // value is a key that IS present but whose captured value is null (the
      // `(.+?)` group requires at least one char). Deciding "already correct"
      // from a null value alone is wrong here — it would leave an
      // unresolvable `effort: null` key on disk forever. Test presence with
      // its own regex, and only compare values once presence is known.
      const effortPresentInherit = /^effort:/m.test(fmMatchInherit[1]);
      if (!effortPresentInherit) { skipped++; continue; }
      const effortMatchInherit = /^effort:[ \t]*(.+?)[ \t]*$/m.exec(fmMatchInherit[1]);
      // `effortPresentInherit` is guaranteed true here (checked above), so a
      // failed value match means the key is present with an EMPTY value —
      // report `''`, not `null`, so "present-but-empty" is never conflated
      // with "absent" in the sync output.
      if (!dryRun) {
        // Atomic publish AND mode preservation, same discipline as
        // cmdEffortSyncCodex/cmdEffortSyncOpencode: write to a sibling tmp
        // file, chmod it to match filePath's existing (masked) mode, then
        // retryRenameSync it over the target so filePath is either the old
        // bytes or the new ones, never half-written and never dropped to a
        // default mode. On any failure the tmp file is unlinked (best-effort)
        // and the write is reported (folded into `skipped`/`fileFailureCount`,
        // no new field), not thrown, so the remaining agents still get
        // processed. ONE failure path for this site — no nested try/catch.
        const tmpPathInherit = `${filePath}.tmp.${process.pid}`;
        // Stat filePath BEFORE the write so its mode can be passed at
        // CREATION time — a plain `writeFileSync(tmpPath, data)` creates the
        // tmp file at the default `0666 & ~umask` even when filePath is more
        // restrictive. Best-effort only: a stat failure must not abort the
        // sync, since the content write is what matters, not the mode.
        let originalModeInherit: number | undefined;
        try {
          originalModeInherit = fs.statSync(filePath).mode & 0o7777;
        } catch { /* non-fatal: fall back to writing without an explicit mode */ }
        try {
          fs.writeFileSync(
            tmpPathInherit,
            removeEffortFrontmatter(content),
            originalModeInherit !== undefined ? { mode: originalModeInherit } : undefined,
          );
          // Not redundant with the `mode` option above: `mode` only applies
          // when the file is actually created (O_CREAT). A leftover tmp file
          // from an earlier crashed run would be reused (truncated) at its
          // OLD mode instead, and this chmod is what corrects that case.
          // Best-effort only: a chmod failure must not abort the sync, since
          // the content write is what matters, not the mode.
          try {
            if (originalModeInherit !== undefined) fs.chmodSync(tmpPathInherit, originalModeInherit);
          } catch { /* non-fatal: proceed with default tmp-file mode */ }
          retryRenameSync(tmpPathInherit, filePath);
        } catch {
          try { fs.unlinkSync(tmpPathInherit); } catch { /* already gone or never created */ }
          skipped++;
          fileFailureCount++;
          continue;
        }
      }
      changes.push({ agent: agentName, from: effortMatchInherit ? effortMatchInherit[1] : '', to: null });
      synced++;
      continue;
    }

    // `runtime` is guaranteed 'claude' by the guard above (#3007: only
    // codex's 'ultra' rejection can produce a null value).
    const rendered = renderEffortForRuntime(runtime, universalEffort);
    const newEffortValue = rendered.value as string;

    const fmMatch = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(content);
    if (!fmMatch) { skipped++; continue; }

    // Presence and value are distinct questions here too: `currentEffort`
    // reads null both when the key is ABSENT and when it is present with an
    // EMPTY value. `effortPresent` disambiguates those two for the reported
    // `from` below (never `null` when the key is present but empty) — but it
    // has no bearing on the skip check that follows: `newEffortValue` is
    // never null on this path (guarded above), so an absent key already
    // yields `currentEffort === null !== newEffortValue` without consulting
    // presence separately.
    const effortPresent = /^effort:/m.test(fmMatch[1]);
    const effortMatch = /^effort:[ \t]*(.+?)[ \t]*$/m.exec(fmMatch[1]);
    // `null` (key absent) and `''` (key present, value empty) are distinct
    // states `effortPresent` deliberately disambiguates — collapsing both to
    // `null` here would make the reported `from` lie about which case fired.
    const currentEffort = effortPresent ? (effortMatch ? effortMatch[1] : '') : null;

    if (currentEffort === newEffortValue) { skipped++; continue; }

    if (!dryRun) {
      // Atomic publish AND mode preservation, same discipline as
      // cmdEffortSyncCodex/cmdEffortSyncOpencode: write to a sibling tmp
      // file, chmod it to match filePath's existing (masked) mode, then
      // retryRenameSync it over the target so filePath is either the old
      // bytes or the new ones, never half-written and never dropped to a
      // default mode. On any failure the tmp file is unlinked (best-effort)
      // and the write is reported (folded into `skipped`/`fileFailureCount`,
      // no new field), not thrown, so the remaining agents still get
      // processed. ONE failure path for this site — no nested try/catch.
      const tmpPathSet = `${filePath}.tmp.${process.pid}`;
      // Stat filePath BEFORE the write so its mode can be passed at CREATION
      // time — a plain `writeFileSync(tmpPath, data)` creates the tmp file
      // at the default `0666 & ~umask` even when filePath is more
      // restrictive. Best-effort only: a stat failure must not abort the
      // sync, since the content write is what matters, not the mode.
      let originalModeSet: number | undefined;
      try {
        originalModeSet = fs.statSync(filePath).mode & 0o7777;
      } catch { /* non-fatal: fall back to writing without an explicit mode */ }
      try {
        fs.writeFileSync(
          tmpPathSet,
          setEffortFrontmatter(content, newEffortValue),
          originalModeSet !== undefined ? { mode: originalModeSet } : undefined,
        );
        // Not redundant with the `mode` option above: `mode` only applies
        // when the file is actually created (O_CREAT). A leftover tmp file
        // from an earlier crashed run would be reused (truncated) at its OLD
        // mode instead, and this chmod is what corrects that case.
        // Best-effort only: a chmod failure must not abort the sync, since
        // the content write is what matters, not the mode.
        try {
          if (originalModeSet !== undefined) fs.chmodSync(tmpPathSet, originalModeSet);
        } catch { /* non-fatal: proceed with default tmp-file mode */ }
        retryRenameSync(tmpPathSet, filePath);
      } catch {
        try { fs.unlinkSync(tmpPathSet); } catch { /* already gone or never created */ }
        skipped++;
        fileFailureCount++;
        continue;
      }
    }

    changes.push({ agent: agentName, from: currentEffort, to: newEffortValue });
    synced++;
  }

  output(
    { synced, skipped, changes, dry_run: dryRun, agents_dir: agentsDir },
    raw,
    fileFailureCount > 0 ? 'failed' : synced > 0 ? 'changed' : 'ok',
  );
}

/** One `{agent, field, from}` strip reported by {@link cmdEffortSyncCodex} — `to` is always omission (`null`). */
interface CodexEffortSyncChange {
  agent: string;
  field: 'model' | 'model_reasoning_effort';
  from: string;
  to: null;
}

/** A file `parseCodexAgentToml` refused, reported rather than partially rewritten (ADR-2313 D7 row 11). */
interface CodexEffortSyncRefusal {
  agent: string;
  file: string;
  reason: string;
}

/** A read or write that failed mid-sync (fs fault), reported so the remaining agents still get processed. */
interface EffortSyncFileFailure {
  agent: string;
  file: string;
  error: string;
}

/**
 * ADR-2313 D7 (#3243) — the Codex branch of `cmdEffortSync`. Strips a stale
 * Anthropic-flavored/tier `model` pin and an orphaned `model_reasoning_effort`
 * from every installed `~/.codex/agents/<agent>.toml`, leaving a legal
 * real-Codex pin (and its coupled effort) untouched. Dry-run by default; every
 * strip reported as a structured `{agent, field, from}` change; an unparseable
 * document is refused and reported, never partially rewritten (40-design.md
 * "Reconciliation" — parseCodexAgentToml is the STRICT half of the reader/
 * writer split). Result shape is additive over the claude branch's
 * `{synced, skipped, changes, dry_run, agents_dir}` — `refused`,
 * `write_failures`, and `read_failures` are new fields, never a reshape of
 * the existing ones.
 */
function cmdEffortSyncCodex(raw: boolean, dryRun: boolean, configDir?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { getGlobalConfigDir } = require('./runtime-homes.cjs') as { getGlobalConfigDir(runtime: string, explicitDir?: string | null): string };
  const agentsDir = path.join(configDir || getGlobalConfigDir('codex'), 'agents');

  if (!fs.existsSync(agentsDir)) {
    output({ synced: 0, skipped: 0, changes: [], dry_run: dryRun, agents_dir: agentsDir, reason: 'agents directory not found' }, raw, '');
    return;
  }

  // Skip symlinks — matches the claude branch's existing guard above (only
  // write regular files, never follow a symlink into clobbering its target).
  const files = fs
    .readdirSync(agentsDir)
    .filter(f => {
      if (!f.endsWith('.toml')) return false;
      try { return fs.lstatSync(path.join(agentsDir, f)).isFile(); } catch { return false; }
    })
    .sort();

  const changes: CodexEffortSyncChange[] = [];
  const refused: CodexEffortSyncRefusal[] = [];
  const writeFailures: EffortSyncFileFailure[] = [];
  const readFailures: EffortSyncFileFailure[] = [];
  let synced = 0;
  let skipped = 0;

  for (const file of files) {
    const agentName = file.replace(/\.toml$/, '');
    const filePath = path.join(agentsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // An unreadable agent file must not abort the whole sweep — mirrors the
      // opencode branch's own read guard, reported under its own
      // `read_failures` key so a caller can tell "never read" apart from
      // "read but write failed".
      skipped++;
      readFailures.push({ agent: agentName, file: filePath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const parsed = parseCodexAgentToml(content);
    if (!parsed.ok) {
      // Never partially rewritten (40-design.md, ADR-2313 reader/writer
      // boundary): an unparseable document is skipped and reported, not
      // guessed at.
      skipped++;
      refused.push({ agent: agentName, file: filePath, reason: parsed.reason });
      continue;
    }

    let doc = parsed.doc;
    const stripModelNeeded = doc.model !== null && isAnthropicFlavoredModel(doc.model);
    // #838 coupling: an orphaned effort (no model) is always stale; a stale
    // model's effort is coupled to it and strips with it. A legal pin's effort
    // (model present, not Anthropic-flavored) is left untouched (rows 4-5).
    const stripEffortNeeded = doc.reasoningEffort !== null && (stripModelNeeded || doc.model === null);

    if (!stripModelNeeded && !stripEffortNeeded) {
      // Posture-clean, OR a legal pin (and its coupled effort) — reported
      // skipped, never synced (ADR-2313 reader/writer boundary).
      skipped++;
      continue;
    }

    const pendingChanges: CodexEffortSyncChange[] = [];
    if (stripModelNeeded) {
      pendingChanges.push({ agent: agentName, field: 'model', from: doc.model as string, to: null });
      doc = stripModel(doc);
    }
    if (stripEffortNeeded) {
      pendingChanges.push({ agent: agentName, field: 'model_reasoning_effort', from: doc.reasoningEffort as string, to: null });
      doc = stripReasoningEffort(doc);
    }

    if (!dryRun) {
      // Atomic publish (ADR-2313 "never partially rewritten"): write the
      // rendered TOML to a sibling tmp file, then rename it over the target.
      // Same-filesystem rename is atomic, so filePath is either the old bytes
      // or the new ones, never truncated/half-written mid-crash. Deliberately
      // NOT platformWriteSync — its normalizeContent step rewrites CRLF/
      // trailing-newline bytes, which would break the byte-identical
      // round-trip (A14) this writer must preserve. retryRenameSync (not a
      // bare fs.renameSync) carries the transient-Windows-lock retry per
      // DEFECT.WINDOWS-FS-OPS.
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      // Stat filePath BEFORE the write so the original mode is available to
      // pass at creation time, not just at chmod time afterward — otherwise
      // the tmp file is briefly created at the default `0666 & ~umask`
      // (world-readable under a typical 022 umask) even when filePath is
      // e.g. 0600, exposing its contents for the window between creation and
      // chmod. Best-effort: a stat failure must not abort the sync, since the
      // content write is what matters, not the mode.
      let originalMode: number | undefined;
      try {
        originalMode = fs.statSync(filePath).mode & 0o7777;
      } catch { /* non-fatal: fall back to writing without an explicit mode */ }
      try {
        fs.writeFileSync(tmpPath, renderCodexAgentToml(doc), originalMode !== undefined ? { mode: originalMode } : undefined);
        // Not redundant with the `mode` option above: `mode` only applies
        // when the file is actually created (O_CREAT). A leftover tmp file
        // from an earlier crashed run would be reused (truncated) at its OLD
        // mode instead, and this chmod is what corrects that case. Mask off
        // the file-type bits fs.statSync().mode carries (POSIX leaves
        // chmod's handling of those unspecified); best-effort only, since
        // the content write is what matters, not the mode.
        try {
          if (originalMode !== undefined) fs.chmodSync(tmpPath, originalMode);
        } catch { /* non-fatal: proceed with default tmp-file mode */ }
        retryRenameSync(tmpPath, filePath);
      } catch (err) {
        // Reported, not thrown — the remaining agents still get processed.
        // Clean up the orphaned tmp file; filePath itself was never touched.
        try { fs.unlinkSync(tmpPath); } catch { /* already gone or never created */ }
        skipped++;
        writeFailures.push({ agent: agentName, file: filePath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }

    changes.push(...pendingChanges);
    synced++;
  }

  output(
    { synced, skipped, changes, dry_run: dryRun, agents_dir: agentsDir, refused, write_failures: writeFailures, read_failures: readFailures },
    raw,
    writeFailures.length > 0 || readFailures.length > 0 ? 'failed' : synced > 0 ? 'changed' : 'ok',
  );
}

/**
 * #3706 — the OpenCode branch of `cmdEffortSync`. Maintains the `variant:`
 * frontmatter key install now bakes into every `~/.config/opencode/agents/
 * gsd-*.md` (or configDir-relative equivalent), mirroring exactly what
 * install writes: a resolved universal effort clamped through
 * `clampEffortForHost('opencode', ...)`. Null means the key must be ABSENT —
 * #3533 (10d): an absent key is the correct state under `inherit`, and a
 * level OpenCode does not accept must never be written, so both collapse to
 * the same `target: null` and the same removal path. Result shape is
 * additive over the claude branch, matching the CODEX branch's
 * `{synced, skipped, changes, dry_run, agents_dir, write_failures}`.
 */
function cmdEffortSyncOpencode(cwd: string, raw: boolean, dryRun: boolean, configDir?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { getGlobalConfigDir } = require('./runtime-homes.cjs') as { getGlobalConfigDir(runtime: string, explicitDir?: string | null): string };
  const agentsDir = path.join(configDir || getGlobalConfigDir('opencode'), 'agents');

  if (!fs.existsSync(agentsDir)) {
    output({ synced: 0, skipped: 0, changes: [], dry_run: dryRun, agents_dir: agentsDir, reason: 'agents directory not found' }, raw, '');
    return;
  }

  // Skip symlinks — matches the claude branch's existing guard (only write
  // regular files, never follow a symlink into clobbering its target).
  const files = fs
    .readdirSync(agentsDir)
    .filter(f => {
      if (!f.startsWith('gsd-') || !f.endsWith('.md')) return false;
      try { return fs.lstatSync(path.join(agentsDir, f)).isFile(); } catch { return false; }
    })
    .sort();

  // Use install-time resolvers: they merge ~/.gsd/defaults.json with project
  // config, matching the exact logic used when agents were originally
  // installed. Resolved once, outside the loop, like the claude branch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { readGsdEffectiveEffortConfig, resolveInstallTimeEffort } = require('./install-effort-resolver.cjs') as {
    readGsdEffectiveEffortConfig(cwd: string): Record<string, unknown> | null;
    resolveInstallTimeEffort(cfg: Record<string, unknown> | null, agentName: string): string;
  };
  const effortCfg = readGsdEffectiveEffortConfig(cwd);

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { clampEffortForHost } = require('./model-catalog.cjs') as { clampEffortForHost(host: string, effort: string): string | null };

  const changes: EffortSyncChange[] = [];
  const writeFailures: EffortSyncFileFailure[] = [];
  const readFailures: EffortSyncFileFailure[] = [];
  let synced = 0;
  let skipped = 0;

  for (const file of files) {
    const agentName = file.replace(/\.md$/, '');
    const filePath = path.join(agentsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // An unreadable agent file must not abort the whole sweep — degrade
      // like the write path below does, and report it under its own
      // `read_failures` key so a caller can tell "never read" apart from
      // "read but write failed".
      skipped++;
      readFailures.push({ agent: agentName, file: filePath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    // `target === null` covers both "no effort configured" (inherit) and "a
    // level OpenCode does not accept" — both must produce NO `variant:` key,
    // exactly what install writes.
    const universal = effortCfg ? resolveInstallTimeEffort(effortCfg, agentName) : null;
    const target = universal ? clampEffortForHost('opencode', universal) : null;

    const fmMatch = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(content);
    if (!fmMatch) { skipped++; continue; }

    // Presence and value are distinct questions: `variant:` with an EMPTY
    // value is a key that IS present but whose captured value is null (the
    // `(.+?)` group requires at least one char). Deciding "already correct"
    // from a null-vs-null comparison alone is wrong when target is also
    // null — it would leave an unresolvable `variant: null` key on disk
    // forever. Test presence with its own regex, and only compare values
    // once presence is known.
    const variantPresent = /^variant:/m.test(fmMatch[1]);
    const variantMatch = /^variant:[ \t]*(.+?)[ \t]*$/m.exec(fmMatch[1]);
    // `null` (key absent) and `''` (key present, value empty) are distinct
    // states this code deliberately tracks via `variantPresent` above — a
    // reported `from` that collapses both to `null` would make "no key" and
    // "empty key" indistinguishable in the sync output, even though only one
    // of them actually has a `variant:` line to remove.
    const currentVariant = variantPresent ? (variantMatch ? variantMatch[1] : '') : null;

    if (target === null) {
      if (!variantPresent) { skipped++; continue; }
    } else if (variantPresent && currentVariant === target) {
      skipped++;
      continue;
    }

    changes.push({ agent: agentName, from: currentVariant, to: target });
    synced++;

    if (!dryRun) {
      // Atomic publish AND mode preservation, same discipline as
      // cmdEffortSyncCodex above: write to a sibling tmp file, chmod it to
      // match filePath's existing (masked) mode, then retryRenameSync it over
      // the target so filePath is either the old bytes or the new ones, never
      // half-written and never dropped to a default mode. On failure the
      // write is reported, not thrown, so the remaining agents still get
      // processed.
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      // Stat filePath BEFORE the write so its mode can be passed at CREATION
      // time — a plain `writeFileSync(tmpPath, data)` creates the tmp file at
      // the default `0666 & ~umask` (world-readable under a typical 022
      // umask) even when filePath is e.g. 0600, exposing its contents for
      // the window between creation and the chmod below. Mask off the
      // file-type bits (e.g. S_IFREG 0o100000) that fs.statSync().mode
      // carries alongside the permission bits — POSIX leaves chmod's
      // handling of those bits unspecified, and the remote matrix runs Linux
      // only (Darwin tolerating the full mode is not evidence it is safe
      // there). Best-effort only: a stat failure must not abort the sync,
      // since the content write is what matters, not the mode.
      let originalMode: number | undefined;
      try {
        originalMode = fs.statSync(filePath).mode & 0o7777;
      } catch { /* non-fatal: fall back to writing without an explicit mode */ }
      try {
        fs.writeFileSync(
          tmpPath,
          target === null ? removeFrontmatterKeyLine(content, 'variant') : setFrontmatterKeyLine(content, 'variant', target),
          originalMode !== undefined ? { mode: originalMode } : undefined,
        );
        // Not redundant with the `mode` option above: `mode` only applies
        // when the file is actually created (O_CREAT). A leftover tmp file
        // from an earlier crashed run would be reused (truncated) at its OLD
        // mode instead, and this chmod is what corrects that case.
        // Best-effort only: a chmod failure must not abort the sync, since
        // the content write is what matters, not the mode.
        try {
          if (originalMode !== undefined) fs.chmodSync(tmpPath, originalMode);
        } catch { /* non-fatal: proceed with default tmp-file mode */ }
        retryRenameSync(tmpPath, filePath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* already gone or never created */ }
        changes.pop();
        synced--;
        skipped++;
        writeFailures.push({ agent: agentName, file: filePath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
  }

  // Any failure — a write OR a read — must not report 'ok' or 'changed':
  // either would hide that at least one agent's on-disk state is now unknown
  // (unread) or unchanged despite being reported as a pending change (write
  // failed after being pushed onto `changes`/`synced`). `write_failures` and
  // `read_failures` take priority over the synced-count-derived summary below,
  // even when other agents in the same run succeeded.
  //
  // Known limitation, deliberately not fixed here: `output()` only honors its
  // third argument when `raw === true`, and this command's process always
  // exits 0 regardless of the summary string — so `if gsd-tools effort sync;
  // then` reads success in a shell even on a run where every write failed.
  // Making the exit code reflect failure would be a CLI-contract change
  // affecting all three cmdEffortSync* branches (claude, codex, opencode) and
  // is out of scope for this fix.
  output(
    { synced, skipped, changes, dry_run: dryRun, agents_dir: agentsDir, write_failures: writeFailures, read_failures: readFailures },
    raw,
    writeFailures.length > 0 || readFailures.length > 0 ? 'failed' : synced > 0 ? 'changed' : 'ok',
  );
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

type CommitDocsSource = 'phase' | 'config' | 'gitignore' | 'default';
interface CommitDocsResolution {
  resolved: boolean;
  source: CommitDocsSource;
}

/**
 * #3587: resolve the `phase_commit_docs.<phase-id>` override for `phaseNum`
 * against `config['phase_commit_docs']` (a `{ "<phase-id>": boolean }` map, the
 * same shape `agent_skills`/`features` use for their dynamic key families).
 * Returns `undefined` — "no override applies" — when: no phase is known (B7),
 * the map carries no entry for THIS phase (B5: no cross-phase leak), or the
 * entry exists but is not a boolean (B6: never silently coerced). Both sides of
 * the comparison route through `normalizePhaseName` so `3`, `03`, and `PROJ-03`
 * all resolve to the same entry (B4/B9), reusing the single-owner phase-id
 * normalizer rather than a second, looser string-equality rule.
 */
function resolvePhaseCommitDocsOverride(config: Record<string, unknown>, phaseNum: string | null): boolean | undefined {
  if (!phaseNum) return undefined;
  const overrides = config['phase_commit_docs'];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return undefined;
  const target = normalizePhaseName(phaseNum);
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (normalizePhaseName(key) === target) {
      return typeof value === 'boolean' ? value : undefined;
    }
  }
  return undefined;
}

/**
 * #3587: the four-tier `commit_docs` precedence chain for a single commit —
 * `phase_commit_docs.<phase-id>` (tier 1, resolved HERE because this call site
 * is the one place that knows the phase — see 40-design.md "Rejected" §1: NOT
 * inside `loadConfig`, which has no phase context and is called by nearly every
 * command), then the pre-existing explicit `commit_docs` (tier 2), `.gitignore`
 * auto-detect (tier 3), and manifest default (tier 4). Tiers 2-4 are byte-for-
 * behaviour identical to the pre-#3587 inline checks (epic #2292 AC4): when no
 * phase override applies, `resolved` matches exactly what those checks computed
 * and `source` merely labels which of the three decided it.
 *
 * `isPlanningGitIgnored` is a thunk, not a plain boolean, so the pre-existing
 * short-circuit is preserved byte-for-behaviour: the original inline checks
 * only ever ran `isGitIgnored` (a real `git check-ignore` subprocess) when
 * `commit_docs` was truthy, and a phase override or an explicit `commit_docs:
 * false` must keep skipping that call entirely, not just its result. Passing
 * a thunk also keeps this function pure and directly property-testable
 * (test matrix F1) without spawning git.
 */
function resolveCommitDocsPolicy(
  config: Record<string, unknown>,
  phaseNum: string | null,
  isPlanningGitIgnored: () => boolean,
): CommitDocsResolution {
  const phaseOverride = resolvePhaseCommitDocsOverride(config, phaseNum);
  if (phaseOverride !== undefined) return { resolved: phaseOverride, source: 'phase' };
  if (!config['commit_docs']) return { resolved: false, source: 'config' };
  if (isPlanningGitIgnored()) return { resolved: false, source: 'gitignore' };
  return { resolved: true, source: 'default' };
}

// Reason string per commit_docs-resolution source, for the tier-1/tier-2 skip
// envelope below. `phase` gets its OWN reason (`skipped_commit_docs_phase_false`)
// rather than reusing `skipped_commit_docs_false` — telling a user "commit_docs
// is false" when their project setting is actually `true` would be actively
// misleading (design "Rejected" §3). `config` keeps the pre-existing string
// unchanged: `agents/gsd-executor.md` pattern-matches on it (D2).
const COMMIT_DOCS_SKIP_REASON: Record<Exclude<CommitDocsSource, 'default'>, string> = {
  phase: 'skipped_commit_docs_phase_false',
  config: 'skipped_commit_docs_false',
  gitignore: 'skipped_gitignored',
};

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

  // Check commit_docs config — #3587: resolved through the tier 1
  // (phase_commit_docs.<phase-id>) → tier 2 (commit_docs) → tier 3 (.gitignore)
  // → tier 4 (default) precedence chain; see resolveCommitDocsPolicy above.
  // `skipped: true` is explicit so agent prompts can match on a first-class
  // success signal rather than inferring "skip" from "committed is missing"
  // and improvising raw git fallbacks (#3678).
  const commitDocsPolicy = resolveCommitDocsPolicy(
    config,
    detectPhaseNumberFromFiles(files),
    () => isGitIgnored(cwd, '.planning'),
  );
  if (!commitDocsPolicy.resolved) {
    const result = {
      committed: false,
      skipped: true,
      hash: null,
      reason: COMMIT_DOCS_SKIP_REASON[commitDocsPolicy.source as Exclude<CommitDocsSource, 'default'>],
    };
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
      // #3734: a 999.x/0.x backlog sentinel is a parking-lot entry, not a real
      // phase — the phase arm must never branch-mutate for it (isSentinelPhaseId
      // is the invariant's single owner, src/phase-id.cts).
      if (phaseNum && !isSentinelPhaseId(phaseNum)) {
        const phaseInfo = findPhaseInternal(cwd, phaseNum) as Record<string, unknown> | null;
        if (phaseInfo) {
          branchName = (config['phase_branch_template'] as string)
            .replace('{phase}', normalizePhaseName(phaseInfo['phase_number']))
            .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase');
        }
      }
    } else if (branchingStrategy === 'milestone') {
      const milestoneInfo = getMilestoneInfo(cwd);
      // #3216 review Finding 3: explicit scope gate instead of plain truthiness.
      // COMPLETE and TRUNCATED both carry a real `version` (ADR-3180 §7.2 rule
      // 6 — TRUNCATED means the version resolved but the milestone's NAME did
      // not), so a TRUNCATED identity is acceptable here: `milestone.version`
      // only feeds a BRANCH NAME, and `generateSlugInternal(null) || 'milestone'`
      // already degrades the missing name to the literal "milestone" slug on
      // purpose. This differs from `archivePhaseDirectories` (milestone.cts),
      // which uses the same value as a DIRECTORY NAME and therefore demands
      // COMPLETE only — a real-but-unnamed version is not safe enough there.
      const milestone = milestoneInfo.scope === SCOPE.COMPLETE || milestoneInfo.scope === SCOPE.TRUNCATED
        ? milestoneInfo.value
        : null;
      if (milestone && milestone.version) {
        branchName = (config['milestone_branch_template'] as string)
          .replace('{milestone}', milestone.version)
          .replace('{slug}', generateSlugInternal(milestone.name) || 'milestone');
      }
    }
    if (branchName) {
      const currentBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      if (currentBranch.exitCode === 0 && currentBranch.stdout.trim() !== branchName) {
        // #2539/#3079/#3207: two cases the prior (#3079) code collapsed into one.
        // #1278 intent: CREATE the phase/milestone branch before the FIRST commit
        // on it so the phase's work accumulates there. #3079/#2539 hazard: never
        // silently switch an already-checked-out working branch onto a DIFFERENT
        // EXISTING branch — that resurrects merged-and-deleted phase branches and
        // silently moves HEAD onto a stale ref (#2539 AC2: an auto-checkout
        // mid-commit must never happen silently).
        // Reconciliation (#3207): a brand-new branch has no resurrection target,
        // so create-and-switch is safe here and is exactly the #1278 intent; an
        // EXISTING branch is never switched to (the else arm logs + commits in
        // place). The fresh create is logged so the first phase-scoped commit is
        // not silent about where the work is landing (#3207 AC3).
        const verify = execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd });
        if (verify.exitCode !== 0) {
          // Branch does not exist — CREATE AND SWITCH (the #1278 first-commit
          // case). checkout -b cannot resurrect anything: the branch was just
          // verified absent, so it is created fresh at HEAD.
          const create = execGit(['checkout', '-b', branchName], { cwd });
          if (create.exitCode === 0) {
            process.stderr.write(
              `${branchingStrategy} branch "${branchName}" created; switched to it for this commit.\n`
            );
          } else {
            process.stderr.write(
              `Warning: could not create ${branchingStrategy} branch "${branchName}" ` +
              `(${create.stderr.trim()}); committing on the current branch "${currentBranch.stdout.trim()}".\n`
            );
          }
        } else {
          // Branch already exists — do NOT switch, commit on current branch.
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
        stagingFailures.push({
          file,
          error: rmResult.stderr || rmResult.stdout,
          timed_out: isSpawnTimeout(rmResult),
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
        stagingFailures.push({
          file,
          error: addResult.stderr || addResult.stdout,
          // The projection exposes a timeout distinctly (#2608 AC5); this uses
          // the shared isSpawnTimeout predicate (shell-command-projection.cts)
          // also used by worktree-safety.cts and worktree-base-ref.cts (#3050).
          timed_out: isSpawnTimeout(addResult),
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
  const mergeHeadProbe = execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd });
  const isMergeInProgress = mergeHeadProbe.exitCode === 0;
  // PROVENANCE FOR THIS WHOLE BLOCK: every behavioural claim below was DRIVEN
  // against git 2.54, not reasoned by analogy. Individual claims state what was
  // observed and omit the version; where a claim is version-SENSITIVE rather
  // than merely version-observed, it says so at the claim.
  //
  // #3776: git refuses a PARTIAL commit (`git commit -- <paths>`) while a merge
  // or a cherry-pick is in progress, so in those states the pathspec describes
  // nothing about what would actually land and the empty-diff decision below
  // must not be made from it. The three sequencer states do NOT agree:
  //   MERGE_HEAD        -> `fatal: cannot do a partial commit during a merge.`
  //   CHERRY_PICK_HEAD  -> `fatal: cannot do a partial commit during a cherry-pick.`
  //   REVERT_HEAD       -> permitted; behaves like an ordinary commit.
  // REVERT_HEAD is therefore deliberately absent: including it would suppress
  // this fix during a revert, reintroducing the very misreport it removes.
  // `canScope` below keeps its narrower merge-only test on purpose — widening it
  // would change pre-existing cherry-pick behaviour, which is outside this fix.
  // Only the scoped, non-amend call can return through the guard below, so the
  // cherry-pick probe and the guard's own probes are gated on that — an
  // unscoped commit or an --amend would otherwise pay for git invocations whose
  // answer it can never use. The MERGE_HEAD probe above predates this fix and
  // stays unconditional: `canScope` needs it on every path.
  // A non-zero exit from either sequencer probe means "not in that state" AND
  // "the probe never answered" — `execGit` surfaces a spawn timeout as
  // `exitCode: 1` (`_spawnResult`: `result.status ?? 1`), which is the exact
  // code `rev-parse --verify` returns for a ref that does not exist. Conflating
  // them is the one path in this fix that does NOT fail toward the old
  // behaviour: a timeout during a real merge would leave `partialCommitRefused`
  // false, the guard would decide `nothing_to_commit` from a pathspec git will
  // not honour, and the merge would be silently abandoned where it previously
  // reported a loud `commit_failed`. So an unanswered probe is treated as
  // "assume the partial commit would be refused" — the conservative reading,
  // which falls through to `git commit` and lets git speak for itself.
  //
  // This is deliberately routed into `partialCommitRefused` ONLY, never into
  // `isMergeInProgress`: that flag also feeds the pre-existing `canScope` below,
  // where a spurious timeout would convert a scoped commit into a bare one and
  // record the whole index instead of the named paths. Suppressing a misreport
  // must not be paid for by committing content the caller never named.
  const guardApplies = explicitFiles && !amend;
  const cherryPickProbe = guardApplies
    ? execGit(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd })
    : null;
  const partialCommitRefused = isMergeInProgress
    || isSpawnTimeout(mergeHeadProbe)
    || (cherryPickProbe !== null
      && (cherryPickProbe.exitCode === 0 || isSpawnTimeout(cherryPickProbe)));
  // `stagedPaths` records paths whose `git add` exited 0 — that is "did
  // staging succeed", not "is there anything to commit". Staging an
  // already-committed, unmodified file succeeds while contributing no diff, so
  // `length === 0` is reachable only when EVERY named path was missing from
  // disk. For the ordinary empty-diff case control fell through to `git commit`,
  // and the only thing converting that back to `nothing_to_commit` was the
  // string match on git's output below — which a rejecting pre-commit hook
  // pre-empts, because git runs the hook before it decides there is nothing to
  // commit. The caller was then handed `commit_failed` carrying a gate message
  // about a commit that had nothing to gate. Ask git whether the named paths
  // actually differ instead. Three things about that probe are load-bearing:
  //  - it compares the WORKING TREE to HEAD (`diff HEAD`), not the index
  //    (`diff --cached`). `git commit -- <paths>` is a partial commit: it takes
  //    the working-tree content of those paths and ignores what is staged. A
  //    probe against the index therefore answers a different question than the
  //    commit asks, and a working-tree write landing between the `git add`
  //    above and this line — another process in a shared checkout — would make
  //    the index say "empty" while the commit would still have recorded the new
  //    content. Driven: `diff --cached` rc 0 and `diff HEAD` rc 1 on the same
  //    path, with `git commit -- <path>` then committing it.
  //  - the `length === 0` short-circuit keeps the all-missing-paths case exact.
  //    Spreading an empty array yields a pathspec-less `diff`, which tests the
  //    WHOLE tree — unrelated work elsewhere would then suppress the guard and
  //    regress the skip-missing contract (#2014).
  //    It is deliberately NOT gated on `partialCommitRefused`, and gating it
  //    would be a REGRESSION rather than a hardening. With every named path
  //    missing, `stagedPaths` is empty, so `canScope` is false and the
  //    fall-through reaches a BARE `git commit` — which git PERMITS during a
  //    merge, and which then CONCLUDES that merge: rc 0, a two-parent merge
  //    commit recording the entire index, under a message naming a path that
  //    does not exist, reported to the caller as `committed: true` (driven).
  //    Today's answer writes nothing at all. That is the same trade the timeout
  //    routing above already refuses — a misreport must not be paid for by
  //    committing content the caller never named — which is why the sequencer
  //    states gate the DIFF branch only. The behaviour is also PRE-EXISTING and
  //    unchanged by this fix: before it the identical short-circuit ran ABOVE
  //    the MERGE_HEAD probe, so it never consulted the sequencer either. The
  //    residual it leaves — a merge held open behind a `nothing_to_commit`
  //    report — is offered as a separate issue with the other three, not folded
  //    in here. Both sequencer shapes are pinned in
  //    tests/commit-files-pathspec.test.cjs.
  //  - `!partialCommitRefused`: see above — deciding "nothing to commit" from a
  //    pathspec git will not honour would abandon an in-progress merge, so those
  //    states keep their pre-existing behaviour untouched.
  //  - the probe is pinned against user configuration that would make `git diff`
  //    answer a DIFFERENT question than `git commit -- <paths>` asks. `git diff`
  //    is porcelain and honours settings the commit does not, so without these
  //    flags a caller's config decides whether the guard fires. Each vector
  //    below was driven with the paired `git commit -- <path>` confirmed to
  //    record the change the probe reported as absent:
  //      `diff.ignoreSubmodules=all`   -> a gitlink bump is invisible to the probe
  //      `.gitmodules` `ignore = all`  -> the same, and it needs NO local config:
  //                                       it is checked in, so it arrives with a
  //                                       clone
  //      `diff=<driver>` + `textconv`  -> two different blobs converge to one
  //                                       text, so the probe sees no change at
  //                                       all; no submodule involved
  //    `--ignore-submodules=dirty` rather than `=none`, because `dirty` is what
  //    a partial commit of a submodule path actually means: it records the
  //    GITLINK, and the gitlink moves only when the submodule's HEAD does. Under
  //    `=none` a merely dirty submodule WORKTREE reports a difference the commit
  //    would not record, sending an empty call back to `git commit` — the #3776
  //    misreport, re-entered from the other side. `dirty` still overrides both
  //    `diff.ignoreSubmodules` and a checked-in `.gitmodules` `ignore`, so the
  //    gitlink vectors above stay closed (driven: rc 1 under every one of them).
  //    `--no-ext-diff` is deliberately absent: `--quiet` short-circuits ahead of
  //    an external diff driver, so an external `diff.<driver>.command` cannot
  //    invert the probe (driven: rc 1 with and without the flag).
  // Any other non-zero exit from the probe (a genuine git error, or an unborn
  // HEAD) leaves the guard shut and falls through to the commit — failing toward
  // today's path rather than manufacturing a no-op.
  // THE ONE STATE WHERE `git diff` AND `git commit -- <paths>` GENUINELY DISAGREE.
  // `--assume-unchanged` tells git to skip the worktree stat for a path, so
  // `git add` stages nothing and BOTH diff forms report no difference — while
  // `git commit -- <path>` reads the working tree directly and records it
  // (driven: probe rc 0, commit rc 0, new content in the tree). Left
  // to the diff probe alone the guard reports `nothing_to_commit` about content
  // the caller explicitly named in `--files` and git would have written. #3776
  // is a purely diagnostic bug — nothing is corrupted and no wrong commit is
  // made — so suppressing its misreport must not be paid for by dropping named
  // content. The same rule the timeout routing already follows one block up.
  //
  // `git ls-files -v` is the discriminator for the STATE: it tags an
  // assume-unchanged path with a LOWERCASE letter (`h`), where
  // `--skip-worktree` is an uppercase `S` and never reaches THIS branch:
  // `git add` exits 1 under it, so a present-but-modified skip-worktree path
  // fails closed as `staging_failed` above the guard. (An ABSENT one is skipped
  // before `git add` runs at all per #2014, and is answered by the
  // `stagedPaths.length === 0` arm above — correctly, and exactly as it was
  // pre-fix. Both shapes are pinned.)
  //
  // Then ASK GIT, rather than reconstructing its answer. `git commit --dry-run`
  // is the same decision the real commit makes, and `--no-verify` is what keeps
  // it a DECISION rather than an execution. git 2.54 already declines to run
  // `pre-commit` on a dry run (driven: a rejecting one neither fires nor writes
  // its marker), which is the property that matters here, because a firing
  // `pre-commit` is the whole of #3776 — but that is an observed behaviour of
  // one version, and the failure it would produce on a version that differs is
  // SILENT. A `pre-commit` that fires and rejects exits 1, the same code git
  // returns for `nothing to record`, so the closure below would read it as a
  // CONFIRMED empty answer, drop the content the caller named, and report
  // `nothing_to_commit` — #3776's exact shape, in #3776's exact configuration.
  // `--no-verify` forecloses that structurally instead of resting on the
  // version, and is behaviour-neutral where the version already agrees (driven:
  // rc 0 would-record / rc 1 nothing, identical with and without it). This is
  // VERSION-SENSITIVE reasoning, hence stated at the claim per the provenance
  // note above.
  //
  // It is still NOT hook-free in general, and `--no-verify` does not widen that
  // claim: `post-index-change` fires on this call with or without the flag
  // (driven both ways), so a repo using that hook sees TWO extra invocations
  // for the probe — git fires it twice per `commit --dry-run`, and twice again
  // for the real commit (driven: 2/2/2 across flagged probe, unflagged probe
  // and real commit). Stated rather than claimed away; the narrower
  // claim is the true one. `--porcelain` keeps the output to a couple
  // of machine-readable lines instead of a full status listing — the rc is
  // identical either way (driven: 0 would-record / 1 nothing), but the plain
  // form prints every untracked path, which on a large tree is output this
  // probe has no use for and `execGit` would have to buffer. rc 0 means the
  // commit would record something, so the guard must stand aside.
  //
  // Reconstructing it was tried and is WRONG in three measured ways, all of
  // them silent drops of named content. Comparing `git hash-object` against
  // `HEAD:<path>` misses a mode-only change (`chmod +x` leaves the blob
  // identical while `git commit -- <path>` records `100755`); it cannot hash a
  // submodule path at all (`fatal: Unable to hash sub`, while the commit
  // advances the gitlink); and the path it needs must be parsed out of
  // `ls-files` output, which `core.quotePath` renders as `"caf\303\251.md"`
  // by default, so the probe reads a filename that does not exist. Asking git
  // needs no path parsed and no case enumerated.
  //
  // Scoped to this branch on purpose. The diff probe above answers the ordinary
  // case cheaply and is pinned against the configuration vectors below; the
  // dry run is the heavier, exact answer, and it runs only when an
  // assume-unchanged path is actually present.
  //
  // The `ls-files` read is an OPTIMISATION, never a gate — so an unreadable one
  // must not decide anything. It exists only to keep the dry run off the hot
  // path when no assume-unchanged entry is present; when it cannot answer, the
  // dry run simply runs, because the dry run needs nothing from it. Both
  // failing-closed (drop the content) and failing-open (re-enter #3776) are
  // wrong answers to a question we can just ask directly.
  const assumeUnchangedWouldRecord = (): boolean => {
    const listed = execGit(['ls-files', '-v', '--', ...stagedPaths], { cwd });
    // Only the TAG is read; the path is deliberately never parsed out — see the
    // `core.quotePath` note above, and the dry run below needs no path anyway.
    if (listed.exitCode === 0
      && !listed.stdout.split('\n').some((line) => /^[a-z] /.test(line))) return false;
    const dryRun = execGit(
      ['commit', '--dry-run', '--porcelain', '--no-verify', '-m', sanitizedMessage as string, '--', ...stagedPaths],
      { cwd },
    );
    // Only a CONFIRMED "nothing to record" closes the path: rc 1 from a git
    // that actually answered. This is the one probe in the guard whose rc 0
    // is the REASSURING answer, so it inverts the diff probe's safety: there
    // a timeout can only yield non-zero and reads as "not clean"; here
    // `execGit` collapses a spawn timeout (or any spawn error) to
    // `exitCode: 1` (`_spawnResult`: `result.status ?? 1`), byte-identical to
    // git's own "nothing to record" — and the guard then reports
    // `nothing_to_commit` about content it never asked git to write. Same
    // conflation the sequencer probes above defend against, same remedy: an
    // unanswered probe falls toward the commit, where git speaks for itself
    // (and a genuine error there is reported loudly, as it always was). rc 128
    // is likewise not an answer. Timeout kill of a dry run CAN leave a stale
    // `index.lock` behind (it refreshes the index); the real commit then
    // fails on it, loudly — never silently.
    if (isSpawnTimeout(dryRun) || dryRun.error !== null) return true;
    return dryRun.exitCode !== 1;
  };
  const nothingToCommit = guardApplies
    && (stagedPaths.length === 0
      || (!partialCommitRefused
        && execGit(
          ['diff', '--quiet', '--ignore-submodules=dirty', '--no-textconv', 'HEAD', '--', ...stagedPaths],
          { cwd },
        ).exitCode === 0
        && !assumeUnchangedWouldRecord()));
  if (nothingToCommit) {
    const result = { committed: false, hash: null, reason: 'nothing_to_commit' };
    output(result, raw, 'nothing');
    return;
  }
  const canScope = explicitFiles && stagedPaths.length > 0 && !amend
    && !isMergeInProgress;
  const commitArgs = amend
    ? ['commit', '--amend', '--no-edit']
    : ['commit', '-m', sanitizedMessage as string];
  if (noVerify) commitArgs.push('--no-verify');
  if (canScope) {
    commitArgs.push('--', ...stagedPaths);
  }
  // #3859 follow-up: on git 2.39.5 (confirmed on the CI Linux bench image,
  // ghcr.io/open-gsd/gsd-tester-linux:v1.8.0-node24; NOT reproducible on git
  // 2.50.1) `git commit` itself — not just `git diff` — consults
  // `diff.ignoreSubmodules` when deciding whether there is anything to
  // record. With a local `diff.ignoreSubmodules=all` and a submodule gitlink
  // genuinely bumped, that git version silently REFUSES the commit (prints a
  // `git status`-style "Changes to be committed" dump and exits 1, having
  // written nothing) even though the diff probe above (already pinned with
  // its own `--ignore-submodules=dirty`) correctly reported the change as
  // present. The result was misclassified as generic `commit_failed` because
  // git's refusal text does not contain "nothing to commit".
  // Originally scoped to `canScope` on the assumption that only a
  // PATHSPEC-LIMITED `git commit -- <paths>` exercises this git internal
  // path. That assumption was wrong: reproduced directly against the pinned
  // v1.8.0-node24 tester image, a bare WHOLE-INDEX `git commit -m ...` (no
  // pathspec at all) is refused identically when the only staged change is a
  // submodule gitlink and `diff.ignoreSubmodules=all` — git's "nothing to
  // commit" check is a real diff (HEAD vs. index) honouring
  // `diff.ignoreSubmodules` regardless of whether a pathspec narrows it.
  // `--amend` is the one shape confirmed NOT to hit this: it always
  // recreates the commit from the current index and never runs the
  // empty-diff refusal a plain `git commit` does, override or not. The
  // override is therefore applied unconditionally here (not gated on
  // `canScope`) — it is a documented no-op everywhere it is not needed
  // (dry-run, git 2.50.1, and `--amend` already behave this way with or
  // without it; see `#3859 follow-up (canScope gap)` regression tests).
  // The override rides in via `GIT_CONFIG_*` env vars rather than a `-c`
  // argv flag so `commitArgs[0]` stays `'commit'` — several #3859 regression
  // tests assert on the raw argv captured at the `execGit` seam (e.g.
  // `gitCalls.some((a) => a[0] === 'commit')`), and a leading `-c` would shift
  // every element and break that pinning. Same override the probe already
  // carries, so the two can never disagree again.
  const commitEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'dirty',
  };
  // #3886: `git commit` runs pre-commit hooks (husky/lint-staged routinely
  // idles ~4s on Windows before any task) — 10s is too tight, and a timeout
  // kill is NOT an ordinary failure. Same band as the push call below.
  const commitResult = execGit(commitArgs, { cwd, env: commitEnv, timeout: COMMIT_TIMEOUT_MS });
  if (commitResult.exitCode !== 0) {
    // #3886: a SIGTERM'd git commit is a timeout, not commit_failed — the
    // partial stderr it flushed (often incidental CRLF warnings) is noise,
    // and the kill can leave a stale index.lock that blocks the next
    // attempt. Report the distinct reason and surface the lock path.
    if (isSpawnTimeout(commitResult)) {
      const result = {
        committed: false,
        hash: null,
        reason: 'commit_timeout',
        timed_out: true,
        error: commitTimeoutMessage(cwd, commitResult.stderr, commitResult.stdout),
      };
      output(result, raw, 'failed');
      return;
    }
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
        subStagingFailures.push({
          file,
          error: addResult.stderr || addResult.stdout,
          timed_out: isSpawnTimeout(addResult),
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
    // #3859 follow-up fix as cmdCommit above (line ~2081) — git 2.39.5 needs
    // this override for pathspec-scoped AND whole-index commits alike.
    const commitEnvSub: Record<string, string> = {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'dirty',
    };
    const commitResult = execGit(commitArgs, { cwd: repoCwd, timeout: COMMIT_TIMEOUT_MS, env: commitEnvSub });
    if (commitResult.exitCode !== 0) {
      if (isSpawnTimeout(commitResult)) {
        // #3886 (subrepo counterpart): timeout ≠ error; surface the stale-lock
        // path a killed commit can leave in the subrepo.
        repos[repo] = {
          committed: false,
          hash: null,
          files: repoFiles,
          reason: 'commit_timeout',
          timed_out: true,
          error: commitTimeoutMessage(repoCwd, commitResult.stderr, commitResult.stdout),
        };
        continue;
      }
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
  // #3859 follow-up: `git status --porcelain` honors `diff.ignoreSubmodules`
  // the same way the empty-diff probe fixed for cmdCommit did — under a local
  // `diff.ignoreSubmodules=all`, a genuinely bumped submodule gitlink is
  // invisible here too, so `changedFiles` comes back empty and the function
  // reports `nothing_to_commit` before ever reaching the (now-fixed) commit
  // call. `--ignore-submodules=dirty` pins this the same way, reported
  // verbatim: `git -C repo status --porcelain` (no flag) shows nothing for a
  // pure gitlink bump under `diff.ignoreSubmodules=all`, while
  // `--ignore-submodules=dirty` reports ` M nested` (reproduced directly).
  const statusResult = execGit(
    ['-c', 'core.quotePath=false', 'status', '--porcelain', '--ignore-submodules=dirty'],
    { cwd: repoCwd },
  );
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
  // #3859 follow-up fix as cmdCommit above (line ~2081) — git 2.39.5 needs
  // this override for pathspec-scoped AND whole-index commits alike.
  const commitEnvPr: Record<string, string> = {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'dirty',
  };
  const commitResult = execGit(commitArgs, { cwd: repoCwd, timeout: COMMIT_TIMEOUT_MS, env: commitEnvPr });
  if (commitResult.exitCode !== 0) {
    rollback();
    if (isSpawnTimeout(commitResult)) {
      // #3886 (PR-subrepo counterpart): name the timeout and the stale lock
      // instead of echoing the killed hook's partial stderr.
      error(
        `git commit timed out after ${COMMIT_TIMEOUT_MS / 1000}s in ${repo} (killed mid-hook; ` +
        `a stale lock may remain at ${resolveIndexLockPath(repoCwd)} — remove it if no git process is running)`,
      );
    }
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
  const fm = extractFrontmatter(content, fullPath) as Record<string, unknown>;

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
  const milestone = getMilestoneInfo(cwd).value;
  const phaseIdConvention = resolvePhaseIdConvention(cwd);
  const milestoneDisplay = phaseIdConvention === 'bracket'
    ? renderBracketMilestoneDisplay(milestone?.version, loadConfig(cwd).project_code)
    : null;
  const milestoneVersion = milestoneDisplay ?? milestone?.version ?? null;

  const phases: PhaseProgress[] = [];
  let totalPlans = 0;
  let totalSummaries = 0;
  let phaseScope: string | null = null;

  try {
    // #3185 (ADR-3180 Decision 1): the single owner applies the milestone
    // window AND the sentinel filter and returns dirs already sorted by
    // comparePhaseNum. This command previously read the phases directory
    // directly with neither, which is why `query progress` listed 999.*
    // backlog directories as current-milestone phases (#3167).
    const { value: dirs, scope } = listMilestonePhaseDirs(phasesDir, {
      cwd,
      phaseIdConvention,
    });
    phaseScope = scope;

    for (const dir of dirs) {
      let phaseNum: string;
      let phaseName: string;
      let displayId: string | undefined;
      if (phaseIdConvention === 'bracket') {
        try {
          const projection = bracketPhaseDirProjection(dir);
          phaseNum = projection.number;
          phaseName = projection.name;
          displayId = projection.display_id;
        } catch {
          // A malformed/tolerated directory must not suppress every later row.
          // It cannot receive a canonical display_id because parsePhaseId
          // rejected it, but the convention-aware token keeps it observable.
          const phaseToken = extractPhaseToken(dir, phaseIdConvention);
          phaseNum = phaseToken || dir;
          phaseName = recoverBracketPhaseName(dir, phaseToken);
        }
      } else {
        const dm = dir.match(/^(\d+(?:\.\d+)*)-?(.*)/);
        phaseNum = dm ? dm[1] : dir;
        phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      }
      // #3183: canonical plan/summary counts (root+nested, superseded-excluded,
      // canonical pairing) from the single owner.
      const phaseScan = scanPhasePlans(path.join(phasesDir, dir));
      const plans = phaseScan.planCount;
      const summaries = phaseScan.summaryCount;

      totalPlans += plans;
      totalSummaries += summaries;

      const status = determinePhaseStatus(plans, summaries, path.join(phasesDir, dir), 'Pending');

      phases.push({
        number: phaseNum,
        ...(displayId ? { display_id: displayId } : {}),
        name: phaseName,
        plans,
        summaries,
        status,
      });
    }
  } catch { /* intentionally empty */ }

  // #3217 (ADR-3180 §7.6 rule 4): `phaseScope` was already computed above
  // (Phase 3, #3222) but never consulted before rendering — a percentage was
  // rendered from counts the scope said were not answers (TRUNCATED /
  // UNSCOPED / UNREADABLE). Withhold the percentage itself (never `0` — a
  // real `0` under COMPLETE must still render, rule 2's territory) when the
  // scope is not COMPLETE. `phaseScope` stays `null` only if the try block
  // above threw before assigning it; treat that the same as non-COMPLETE.
  const percent: number | null = phaseScope === SCOPE.COMPLETE
    ? clampPercent(totalSummaries, totalPlans)
    : null;

  if (format === 'table') {
    // Render markdown table
    const barWidth = 10;
    const filled = percent === null ? 0 : Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const percentSuffix = percent === null ? '' : ` (${percent}%)`;
    let out = `# ${milestoneVersion ?? ''} ${milestone?.name ?? ''}\n\n`;
    out += `**Progress:** [${bar}] ${totalSummaries}/${totalPlans} plans${percentSuffix}\n\n`;
    out += `| Phase | Name | Plans | Status |\n`;
    out += `|-------|------|-------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.display_id ?? p.number} | ${p.name} | ${p.summaries}/${p.plans} | ${p.status} |\n`;
    }
    output({ rendered: out }, raw, out);
  } else if (format === 'bar') {
    const barWidth = 20;
    const filled = percent === null ? 0 : Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const percentSuffix = percent === null ? '' : ` (${percent}%)`;
    const text = `[${bar}] ${totalSummaries}/${totalPlans} plans${percentSuffix}`;
    output({ bar: text, percent, completed: totalSummaries, total: totalPlans }, raw, text);
  } else {
    // JSON format
    output({
      milestone_version: milestoneVersion,
      milestone_name: milestone?.name ?? null,
      phases,
      total_plans: totalPlans,
      total_summaries: totalSummaries,
      percent,
      // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
      // can tell a genuinely-empty milestone from one it could not scope.
      phase_scope: phaseScope,
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
      // #3183: canonical plan set (root+nested, superseded-excluded) from the
      // single owner, rather than a root-only hand-rolled readdirSync filter.
      const planFiles = scanPhasePlans(phaseDir).planFiles;
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
  const milestone = getMilestoneInfo(cwd).value;
  const phaseIdConvention = resolvePhaseIdConvention(cwd);
  const milestoneDisplay = phaseIdConvention === 'bracket'
    ? renderBracketMilestoneDisplay(milestone?.version, loadConfig(cwd).project_code)
    : null;
  const milestoneVersion = milestoneDisplay ?? milestone?.version ?? null;

  // Phase & plan stats (reuse progress pattern)
  const phasesByNumber = new Map<string, {
    number: string;
    display_id?: string;
    name: string;
    plans: number;
    summaries: number;
    status: string;
  }>();
  let totalPlans = 0;
  let totalSummaries = 0;
  let phaseScope: string | null = null;

  try {
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('roadmap missing');
    const roadmapContent = extractCurrentMilestone(roadmapRaw, cwd);
    // Matches both plain numeric (Phase 1:) and milestone-prefixed (Phase 2-01:) headings.
    // Also tolerates optional [bracket-token] scope prefix on phase headings.
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    // #3569: the id capture is the canonical #3036 shape (digit REQUIRED — incl.
    // letter-prefixed B7, decimals, milestone 2-01), the same group roadmap.cts's
    // collectAnalyzePhases uses. The former `([\w][\w.-]*)` matched ANY word, so
    // prose mentioning `### Phase N:` inside an inline code span produced a phantom
    // Not-Started row and made phases_total disagree with roadmap analyze.
    // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
    const capturesBracketId = phaseIdConvention === 'bracket';
    const headingPrefix = phaseHeadingPrefixSrcFor(
      PHASE_HEADING_BASELINE.ANY_BRACKET,
      phaseIdConvention,
      capturesBracketId,
    );
    // phase-id-owner: this preserves cmdStats's shipped dot-or-dash heading
    // token variant; PHASE_NUMBER_TOKEN_SOURCE is dot-only and would drop M-NN.
    const headingPattern = new RegExp(
      // phase-id-owner: cmdStats's shipped [.-] token variant; the canonical token is dot-only.
      `#{2,4}\\s*${headingPrefix}([A-Za-z]?\\d+[A-Z]?(?:[.-]\\d+)*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`,
      'gi',
    );
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(roadmapContent)) !== null) {
      const bracketId = capturesBracketId ? match[1] : undefined;
      const phaseToken = capturesBracketId ? match[2] : match[1];
      const phaseName = capturesBracketId ? match[3] : match[2];
      // #3185: the heading seed carried no sentinel filter, so a
      // `### Phase 999.1:` backlog heading produced a stats row even with no
      // directory on disk. Uses the canonical predicate (phase-id.cts), not a
      // local literal — the rule had five copies and three regex variants
      // before this phase, disagreeing about Phase 0.
      const sentinelId = bracketId ? `${bracketId}-${phaseToken}` : phaseToken;
      if (capturesBracketId
        ? isSentinelPhaseId(sentinelId, phaseIdConvention)
        : isSentinelPhaseId(sentinelId)) continue;
      const key = normalizePhaseName(phaseToken);
      let displayId: string | undefined;
      if (bracketId) {
        try {
          displayId = renderPhaseId(parsePhaseId(`${bracketId}-${phaseToken}`));
        } catch {
          // Read tolerance can admit a non-canonical heading spelling; keep
          // the stats row but do not invent a canonical identity for it.
        }
      }
      phasesByNumber.set(key, {
        number: key,
        ...(displayId ? { display_id: displayId } : {}),
        name: phaseName.replace(/\(INSERTED\)/i, '').trim(),
        plans: 0,
        summaries: 0,
        status: 'Not Started',
      });
    }
  } catch { /* intentionally empty */ }

  try {
    // #3185 (ADR-3180 Decision 1): route through the single owner. This
    // previously applied the milestone window but NOT a directory-level
    // sentinel filter — and getMilestonePhaseFilter degrades to a pass-all
    // predicate when its heading set is empty, at which point every directory
    // on disk passed, backlog included (#3167).
    const { value: dirs, scope } = listMilestonePhaseDirs(phasesDir, {
      cwd,
      phaseIdConvention,
    });
    phaseScope = scope;

    for (const dir of dirs) {
      let phaseNum: string;
      let phaseName: string;
      let displayId: string | undefined;
      if (phaseIdConvention === 'bracket') {
        try {
          const projection = bracketPhaseDirProjection(dir);
          phaseNum = projection.number;
          phaseName = projection.name;
          displayId = projection.display_id;
        } catch {
          const phaseToken = extractPhaseToken(dir, phaseIdConvention);
          phaseNum = phaseToken || dir;
          phaseName = recoverBracketPhaseName(dir, phaseToken);
        }
      } else {
        // Use extractPhaseToken to correctly parse M-NN-style and code-prefixed dir names.
        const phaseToken = extractPhaseToken(dir) as string | null;
        phaseNum = phaseToken || dir;
        // phaseName is everything after the token (strip leading '-')
        const afterToken = dir.slice(phaseToken ? phaseToken.length : 0).replace(/^-/, '');
        phaseName = afterToken ? afterToken.replace(/-/g, ' ') : '';
      }
      // #3183: canonical plan/summary counts (root+nested, superseded-excluded,
      // canonical pairing) from the single owner.
      const phaseScan = scanPhasePlans(path.join(phasesDir, dir));
      const plans = phaseScan.planCount;
      const summaries = phaseScan.summaryCount;

      totalPlans += plans;
      totalSummaries += summaries;

      const status = determinePhaseStatus(plans, summaries, path.join(phasesDir, dir), 'Not Started');

      const normalizedNum = normalizePhaseName(phaseNum);
      const existing = phasesByNumber.get(normalizedNum);
      phasesByNumber.set(normalizedNum, {
        number: normalizedNum,
        ...(existing?.display_id || displayId
          ? { display_id: existing?.display_id || displayId }
          : {}),
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
  // #3217 (ADR-3180 §7.6 rule 4): both percentages here are derived from the
  // same `phaseScope`-carrying directory enumeration above (Phase 3, #3222) —
  // withhold both when that scope is not COMPLETE, same rationale as
  // cmdProgressRender above. A real `0` under COMPLETE still renders.
  const planPercent: number | null = phaseScope === SCOPE.COMPLETE ? clampPercent(totalSummaries, totalPlans) : null;
  const percent: number | null = phaseScope === SCOPE.COMPLETE ? clampPercent(completedPhases, phases.length) : null;

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
    milestone_version: milestoneVersion,
    milestone_name: milestone?.name ?? null,
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
    // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
    // can tell a genuinely-empty milestone from one it could not scope.
    phase_scope: phaseScope,
  };

  if (format === 'table') {
    const barWidth = 10;
    const filled = percent === null ? 0 : Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    let out = `# ${milestoneVersion ?? ''} ${milestone?.name ?? ''} — Statistics\n\n`;
    const percentSuffix = percent === null ? '' : ` (${percent}%)`;
    out += `**Progress:** [${bar}] ${completedPhases}/${phases.length} phases${percentSuffix}\n`;
    if (totalPlans > 0 && planPercent !== null) {
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
      out += `| ${p.display_id ?? p.number} | ${p.name} | ${p.plans} | ${p.summaries} | ${p.status} |\n`;
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
 * Check whether a commit should be allowed based on the `commit_docs`
 * precedence chain, INCLUDING any `phase_commit_docs.<phase-id>` override
 * (#3587/#3601). Rejects commits that stage `.planning/` files when the
 * resolved policy is false. Intended for use as a pre-commit hook guard —
 * see `commit-docs-guard enable` above.
 *
 * The phase is derived from the STAGED `.planning/` paths via the single-
 * owner `detectPhaseNumberFromFiles` (the same helper `cmdCommit` uses), and
 * the policy itself is resolved via the single-owner `resolveCommitDocsPolicy`
 * (also shared with `cmdCommit`) — this function never re-derives phase
 * detection or precedence, so it cannot diverge from `cmdCommit`'s decision
 * for the same staged tree (#3588 Part 1: this guard was previously
 * phase-blind, reading only project-level `commit_docs` and directly
 * contradicting `gsd-tools query commit`'s phase-aware resolution).
 *
 * Staged paths are read via `git diff --cached --name-only -z`, NUL-
 * delimited, rather than the LF-delimited default. Without `-z`, git
 * C-style-quotes (wraps in double quotes, octal-escapes) any path containing
 * a non-ASCII byte, a space-adjacent special character, or a literal quote —
 * `.planning/café.md` is reported as `".planning/caf\303\251.md"`, which
 * does not start with `.planning/`, so the old LF-based filter silently
 * missed it and allowed the commit (#3588 F2: a false negative in the harm
 * direction this guard exists to prevent). `-z` disables that quoting
 * entirely and NUL-terminates each path instead, so every staged path is
 * read as literal, unquoted bytes and no unquoting logic is needed.
 */
function cmdCheckCommit(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  const stagedResult = execGit(['diff', '--cached', '--name-only', '-z'], { cwd });
  if (stagedResult.exitCode === 0) {
    const files = stagedResult.stdout.split('\0').filter(Boolean);
    const planningFiles = files.filter(f => f.startsWith('.planning/'));

    if (planningFiles.length > 0) {
      const policy = resolveCommitDocsPolicy(
        config,
        detectPhaseNumberFromFiles(planningFiles),
        () => isGitIgnored(cwd, '.planning'),
      );
      if (!policy.resolved) {
        error(
          `commit_docs is false but ${planningFiles.length} .planning/ file(s) are staged:\n` +
          planningFiles.map(f => `  ${f}`).join('\n') +
          `\n\nTo unstage: git reset HEAD ${planningFiles.join(' ')}`
        );
        return;
      }
      output(
        { allowed: true, reason: policy.source === 'phase' ? 'phase_commit_docs_true' : 'commit_docs_enabled' },
        raw,
        'allowed',
      );
      return;
    }
  }
  // exitCode !== 0 (no staged files / not a git repo) or no .planning/ files staged — allow

  output({ allowed: true, reason: 'no_planning_files_staged' }, raw, 'allowed');
}

// ─── commit-docs-guard: opt-in pre-commit hook (#3588) ─────────────────────

/**
 * Stable sentinel line identifying a `.git/hooks/pre-commit` file as ours.
 * Detection is by PRESENCE of this line, not byte-equality (design "Identifying
 * 'our' hook") — a user who appends a line to a GSD-written hook must not make
 * it unrecognizable, and a hook lacking this line must never be overwritten or
 * deleted by `commit-docs-guard enable`/`disable`.
 */
const COMMIT_DOCS_GUARD_MARKER = '# gsd-core:commit-docs-guard';

/**
 * Locate `gsd-core/workflows/_runtime-launcher.snippet.sh` — the SAME
 * gsd-tools-resolution chain every shipped workflow/agent bash block uses
 * (scripts/sync-runtime-launcher.cjs) — by walking up from this module's own
 * compiled location rather than a fixed literal `../..` join, so the walk
 * tolerates the module living at a different depth under an alternate build
 * or bundling layout (same defensive shape as
 * runtime-artifact-layout.cts#findInstallSourceRoot).
 */
function findRuntimeLauncherSnippet(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'workflows', '_runtime-launcher.snippet.sh');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`commit-docs-guard: could not locate workflows/_runtime-launcher.snippet.sh from ${__dirname}`);
}

/**
 * Build the literal `.git/hooks/pre-commit` content `commit-docs-guard enable`
 * writes. Reuses the canonical gsd_run resolution preamble byte-for-byte
 * (read from disk, never hand-copied — see findRuntimeLauncherSnippet) so this
 * hook resolves `gsd-tools` exactly the way every other shipped workflow bash
 * block does, and cannot drift from it.
 *
 * LF-only (#3588 A2): the snippet file and every literal line here are joined
 * with `\n`; platformWriteSync additionally normalizes CRLF→LF on write, so a
 * CRLF shebang — which is not executable under Git Bash — cannot reach disk.
 */
function buildCommitDocsGuardHookScript(): string {
  const snippetPath = findRuntimeLauncherSnippet();
  const preamble = normalizeEol(fs.readFileSync(snippetPath, 'utf8')).replace(/\n+$/, '');
  const lines = [
    '#!/usr/bin/env bash',
    COMMIT_DOCS_GUARD_MARKER,
    '# Refuses a commit that stages .planning/ files when `commit_docs` resolves',
    '# false (honoring any per-phase override). Installed by',
    '# `gsd-tools commit-docs-guard enable`; remove with',
    '# `gsd-tools commit-docs-guard disable`. See',
    '# docs/how-to/keep-planning-docs-private.md.',
    'set -euo pipefail',
    '',
    preamble,
    '',
    'gsd_run check-commit --raw',
  ];
  return lines.join('\n') + '\n';
}

interface HooksDirResolution {
  ok: boolean;
  dir?: string;
  reason?: string;
}

/**
 * #3886: the timeout band for `git commit` — pre-commit hooks (husky +
 * lint-staged idles ~4s on Windows before any task) routinely exceed the 10s
 * plumbing default; 30s is the same band the push call uses. Shared by all
 * three commit sites AND their timeout messages, so the number and the text
 * cannot drift apart.
 */
const COMMIT_TIMEOUT_MS = 30_000;

/**
 * #3886: resolve where a killed `git commit` would leave its stale
 * index.lock — via `git rev-parse --git-path index.lock`, never a literal
 * `.git/index.lock` join (#3588 row 8's class: a linked worktree's `.git` is
 * a FILE pointing at `<gitdir>/worktrees/<name>/`, so the literal path
 * cannot exist there while the real lock blocks the next commit). Best
 * effort: any resolution failure falls back to the literal join, and the
 * message already hedges with "may remain".
 */
function resolveIndexLockPath(cwd: string): string {
  const result = execGit(['rev-parse', '--git-path', 'index.lock'], { cwd });
  if (result.exitCode !== 0) return path.join(cwd, '.git', 'index.lock');
  const raw = result.stdout.trim();
  return raw ? (path.isAbsolute(raw) ? raw : path.join(cwd, raw)) : path.join(cwd, '.git', 'index.lock');
}

/** #3886: shared timeout message shape for all three commit sites. */
function commitTimeoutMessage(cwd: string, stderr: string, stdout: string): string {
  return (
    `git commit timed out after ${COMMIT_TIMEOUT_MS / 1000}s (killed mid-hook; a stale lock may remain at ` +
    `${resolveIndexLockPath(cwd)} — remove it if no git process is running). ` +
    `Partial stderr: ${stderr || stdout || '(none)'}`
  );
}

/**
 * Resolve the real git hooks directory for `cwd` via `git rev-parse
 * --git-path hooks` — never a literal `.git/hooks` join (#3588 row 8: a
 * linked worktree or submodule's `.git` is a FILE pointing elsewhere, and
 * this is the one git-native call that already resolves that correctly).
 */
function resolveCommitDocsGuardHooksDir(cwd: string): HooksDirResolution {
  const gitDirResult = execGit(['rev-parse', '--git-dir'], { cwd });
  if (gitDirResult.exitCode !== 0) {
    return { ok: false, reason: 'not_a_git_repo' };
  }
  const hooksPathResult = execGit(['rev-parse', '--git-path', 'hooks'], { cwd });
  if (hooksPathResult.exitCode !== 0) {
    return { ok: false, reason: 'not_a_git_repo' };
  }
  const hooksDirRaw = hooksPathResult.stdout.trim();
  const hooksDir = path.isAbsolute(hooksDirRaw) ? hooksDirRaw : path.join(cwd, hooksDirRaw);
  return { ok: true, dir: hooksDir };
}

/** Marker presence, not byte-equality (#3588 row B10). */
function isCommitDocsGuardHook(content: string): boolean {
  return content.includes(COMMIT_DOCS_GUARD_MARKER);
}

/**
 * `gsd-tools commit-docs-guard enable` — write `.git/hooks/pre-commit`.
 * Behavior table (40-design.md rows 1-3, 8-9): refuses to clobber a foreign
 * hook, refuses when `core.hooksPath` would make our own write inert, and is
 * idempotent when already enabled.
 */
function cmdCommitDocsGuardEnable(cwd: string, raw: boolean): void {
  const hooksDir = resolveCommitDocsGuardHooksDir(cwd);
  if (!hooksDir.ok || !hooksDir.dir) {
    error('not a git repository (or any of the parent directories)', ERROR_REASON.COMMIT_DOCS_GUARD_NOT_A_REPO);
    return;
  }

  // core.hooksPath already set: our .git/hooks/pre-commit would be inert —
  // git would never invoke it. Silently writing an ignored file is worse
  // than refusing (design row 9).
  const hooksPathConfig = execGit(['config', '--get', 'core.hooksPath'], { cwd });
  if (hooksPathConfig.exitCode === 0 && hooksPathConfig.stdout.trim() !== '') {
    const configuredPath = hooksPathConfig.stdout.trim();
    error(
      `core.hooksPath is set to "${configuredPath}"; a hook written to ${path.join(hooksDir.dir, 'pre-commit')} ` +
      `would never run. Wire commit-docs-guard into "${configuredPath}" manually, or unset core.hooksPath first.`,
      ERROR_REASON.COMMIT_DOCS_GUARD_HOOKS_PATH_SET,
    );
    return;
  }

  const hookPath = path.join(hooksDir.dir, 'pre-commit');
  const existing = platformReadSync(hookPath);
  if (existing !== null) {
    if (!isCommitDocsGuardHook(existing)) {
      error(
        `refusing to overwrite an existing pre-commit hook at ${hookPath} that GSD did not write. ` +
        `Remove or rename it, or wire commit-docs-guard into it by hand.`,
        ERROR_REASON.COMMIT_DOCS_GUARD_FOREIGN_HOOK,
      );
    }
    // Already ours — idempotent no-op (row 3). Leave any user edits intact;
    // just make sure the executable bit survived.
    try { fs.chmodSync(hookPath, 0o755); } catch { /* best-effort */ }
    output({ enabled: true, action: 'already_enabled', path: hookPath }, raw, 'already_enabled');
    return;
  }

  platformWriteSync(hookPath, buildCommitDocsGuardHookScript());
  fs.chmodSync(hookPath, 0o755);
  output({ enabled: true, action: 'written', path: hookPath }, raw, 'enabled');
}

/**
 * `gsd-tools commit-docs-guard disable` — remove `.git/hooks/pre-commit`
 * ONLY when it is the hook we wrote (marker presence). Never deletes a
 * foreign hook (design row 5); a missing hook is a no-op success, not an
 * error (row 6).
 */
function cmdCommitDocsGuardDisable(cwd: string, raw: boolean): void {
  const hooksDir = resolveCommitDocsGuardHooksDir(cwd);
  if (!hooksDir.ok || !hooksDir.dir) {
    error('not a git repository (or any of the parent directories)', ERROR_REASON.COMMIT_DOCS_GUARD_NOT_A_REPO);
    return;
  }

  const hookPath = path.join(hooksDir.dir, 'pre-commit');
  const existing = platformReadSync(hookPath);
  if (existing === null) {
    output({ disabled: true, action: 'noop', path: hookPath }, raw, 'noop');
    return;
  }
  if (!isCommitDocsGuardHook(existing)) {
    error(
      `refusing to remove the pre-commit hook at ${hookPath}: it does not carry the ` +
      `${COMMIT_DOCS_GUARD_MARKER} marker, so GSD did not write it.`,
      ERROR_REASON.COMMIT_DOCS_GUARD_FOREIGN_HOOK,
    );
  }

  fs.unlinkSync(hookPath);
  output({ disabled: true, action: 'removed', path: hookPath }, raw, 'disabled');
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
  detectPhaseNumberFromFiles,
  resolvePhaseCommitDocsOverride,
  resolveCommitDocsPolicy,
  COMMIT_DOCS_SKIP_REASON,
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
  COMMIT_DOCS_GUARD_MARKER,
  buildCommitDocsGuardHookScript,
  cmdCommitDocsGuardEnable,
  cmdCommitDocsGuardDisable,
  _wsParseRetryAfter,
};
