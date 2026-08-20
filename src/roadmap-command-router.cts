/**
 * Manifest-backed roadmap subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROADMAP_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapUpgrade = require('./roadmap-upgrade.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitMod = require('./cli-exit.cjs');
const { ExitError } = cliExitMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { extractCurrentMilestoneScoped, hasPhaseEntries } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoadmapModule {
  cmdRoadmapGetPhase(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdRoadmapAnalyze(cwd: string, raw: boolean): void;
  cmdRoadmapMilestoneScope(cwd: string, raw: boolean): void;
  cmdRoadmapUpdatePlanProgress(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdRoadmapAnnotateDependencies(cwd: string, phase: string | undefined, raw: boolean): void;
}

interface RouteRoadmapCommandOptions {
  roadmap: RoadmapModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

interface W021Warning {
  code: 'W021';
  message: string;
}

// ─── W021 Implementation ──────────────────────────────────────────────────────

/**
 * Check each phase entry in a milestone-prefixed ROADMAP.md for W021 violations.
 *
 * W021: a phase whose ID integer prefix does not match its enclosing milestone's
 * major version number.
 *
 * Sentinel milestones (0 = pre-milestone, 999 = backlog) are exempt.
 *
 * @param content - ROADMAP.md content
 * @returns Array of W021 warnings
 */
function checkW021(content: string): W021Warning[] {
  const warnings: W021Warning[] = [];

  // Sentinel milestone integers exempt from W021
  const SENTINELS = new Set([0, 999]);
  const MIGRATION_CMD = 'gsd-tools roadmap upgrade --convention milestone-prefixed';

  // Milestone section heading: ## [GSD] v2.0 — Label  OR  ## v2.0: Label  OR  ## Roadmap v2.0
  //   OR  ## ✅ v2.0  OR  ## 🚧 v2.0  (emoji-prefixed variants used by roadmap templates)
  // Capture the major integer.
  const MILESTONE_RE = /^#{1,3}\s+(?:\[[^\]]{1,200}\]\s+|Roadmap\s+|[✅🚧]\s*)?v(\d+)\.\d+(?:\s|:|\s*—)/iu;

  // Migrated phase heading: ### Phase M-NN: Name  (M-NN or unpadded M-N form)
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  const PHASE_RE = /^#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+(\d+)-(\d+)(?:-\d+)*(?:\s*\([^)\n]{0,200}\))?\s*:/i;
  // Unprefixed legacy phase heading: ### Phase N: Name  (no hyphen sub-index)
  // phase-id-owner: UNPREFIXED_PHASE_RE token uses the [A-Za-z] case-variant (identical to the canonical [A-Z] token under /i); kept literal, not source-byte-equal to PHASE_NUMBER_TOKEN_SOURCE.
  const UNPREFIXED_PHASE_RE = /^#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+(\d+[A-Za-z]?(?:\.\d+)*)(?:\s*\([^)\n]{0,200}\))?\s*:/i;

  let currentMilestoneMajor: number | null = null;
  const lines = content.split('\n');

  for (const line of lines) {
    const milestoneMatch = line.match(MILESTONE_RE);
    if (milestoneMatch) {
      currentMilestoneMajor = parseInt(milestoneMatch[1], 10);
      continue;
    }

    const phaseMatch = line.match(PHASE_RE);
    if (phaseMatch) {
      const phaseMajor = parseInt(phaseMatch[1], 10);
      if (SENTINELS.has(phaseMajor)) continue; // exempt

      if (currentMilestoneMajor !== null && phaseMajor !== currentMilestoneMajor) {
        const phaseId = `${phaseMatch[1]}-${phaseMatch[2]}`;
        warnings.push({
          code: 'W021',
          message:
            `Phase ID prefix mismatch: phase "${phaseId}" is listed under v${currentMilestoneMajor}.x ` +
            `but its prefix (${phaseMajor}) does not match. ` +
            `Run \`${MIGRATION_CMD}\` to fix.`,
        });
      }
      continue;
    }

    // When the convention is active, an unprefixed heading (### Phase 1:) is itself a W021
    // violation — it is missing the required M-NN prefix entirely.
    const unprefixedMatch = line.match(UNPREFIXED_PHASE_RE);
    if (unprefixedMatch && currentMilestoneMajor !== null) {
      const rawId = unprefixedMatch[1];
      // Skip if it matched PHASE_RE already (it didn't reach here in that case)
      // Also skip if it looks like a bare integer whose prefix matches the section
      // — those pass; only non-matching or non-prefixed forms fire W021.
      const numericMajor = parseInt(rawId, 10);
      if (!SENTINELS.has(numericMajor)) {
        warnings.push({
          code: 'W021',
          message:
            `Phase ID "${rawId}" is not in M-NN form (milestone-prefixed convention is active). ` +
            `Run \`${MIGRATION_CMD}\` to migrate.`,
        });
      }
    }
  }

  return warnings;
}

// ─── Router ───────────────────────────────────────────────────────────────────

function routeRoadmapCommand({ roadmap, args, cwd, raw, error }: RouteRoadmapCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: ROADMAP_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown roadmap subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'get-phase': () => roadmap.cmdRoadmapGetPhase(cwd, args[2], raw),
      analyze: () => roadmap.cmdRoadmapAnalyze(cwd, raw),
      // #3262: read-only milestone-window identity probe — the capture/compare
      // signal for the edit-phase workflow's write-time milestone-scope guard.
      'milestone-scope': () => roadmap.cmdRoadmapMilestoneScope(cwd, raw),
      'update-plan-progress': () => roadmap.cmdRoadmapUpdatePlanProgress(cwd, args[2], raw),
      'annotate-dependencies': () => roadmap.cmdRoadmapAnnotateDependencies(cwd, args[2], raw),
      'validate': () => {
        const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
        const warnings: Array<{ code: string; message: string }> = [];

        // #2978: structural validation. A verb named "validate" that cannot
        // produce a negative result provides false assurance. Before the
        // opt-in milestone-prefix check, verify the file is structurally a
        // roadmap at all.
        let roadmapContent: string;
        try {
          roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
        } catch {
          // ROADMAP.md missing — not silent success.
          warnings.push({ code: 'V001', message: 'ROADMAP.md not found or unreadable' });
          const result = { warnings };
          process.stdout.write(raw ? JSON.stringify(result) : JSON.stringify(result, null, 2));
          throw new ExitError(1);
        }

        // Empty or whitespace-only.
        if (roadmapContent.trim() === '') {
          warnings.push({ code: 'V002', message: 'ROADMAP.md is empty' });
        }

        // Malformed frontmatter — a `---` opener with no matching closer.
        // Tolerate a leading BOM (#3057) before the fence.
        const contentAfterBom = roadmapContent.replace(/^\uFEFF/, '');
        if (contentAfterBom.startsWith('---')) {
          const closeMatch = contentAfterBom.slice(3).match(/\r?\n---\s*(\r?\n|$)/);
          if (!closeMatch) {
            warnings.push({ code: 'V003', message: 'ROADMAP.md frontmatter is malformed (unterminated --- fence)' });
          }
        }

        // #3641: resolve phase_id_convention ONCE, ahead of every consumer in
        // this validate pass — V004's entry check and V005's scope classifier
        // below, and the W021 milestone-prefix check after them.
        // Authoritative source: .planning/config.json (set by the upgrade
        // command). Fallback: ROADMAP.md frontmatter (for projects that set
        // the field there directly).
        let convention: string | undefined | null;
        try {
          const cfg = loadConfig(cwd);
          convention = cfg['phase_id_convention'] as string | undefined | null;
        } catch {
          convention = undefined;
        }
        if (convention === undefined || convention === null) {
          // Fallback: read from ROADMAP.md frontmatter. Bounded to match
          // cmdRoadmapMilestoneScope's copy exactly (#3641 review NEW-1: an
          // unbounded capture here read past 4KB frontmatters the probe's
          // bounded copy could not, diverging validate from the probe).
          const fmMatch = roadmapContent.match(/^---\r?\n([\s\S]{0,4000}?)\r?\n---/);
          if (fmMatch) {
            const kvMatch = fmMatch[1].match(/^phase_id_convention:\s*(.*)$/m);
            if (kvMatch) {
              const val = kvMatch[1].trim();
              if (val !== 'null' && val !== '') {
                convention = val.replace(/^["']|["']$/g, '');
              }
            }
          }
        }

        // No recognizable phase structure. #3641: routed through the
        // roadmap-parser owner (`hasPhaseEntries` — headings, #2199 bullets,
        // #3577 table rows) instead of a private inline heading regex, so the
        // document-level check and the V005 scope axis below can never
        // disagree about what a phase entry is — and so a bracket-convention
        // project's `### [GSD.04] 01:` entries are entries here too.
        const hasPhaseEntry = hasPhaseEntries(roadmapContent, convention);
        if (!hasPhaseEntry && !warnings.some((w) => w.code === 'V002')) {
          warnings.push({ code: 'V004', message: 'ROADMAP.md contains no recognizable phase entries (no phase headings, bullet entries, or table rows)' });
        }

        // #3263: a whole-document phase check (V004 above) is satisfied by a
        // document whose phase entries live OUTSIDE the active milestone's
        // resolved window — e.g. an intervening version-bearing heading closes
        // the window before its own `### Phase N:` sections. That truncation
        // is exactly what the #3184 scope discriminator classifies, so ask
        // the single owner (never re-derive the window shape here —
        // lint-milestone-window-drift bans local copies) and surface a
        // non-COMPLETE-but-not-empty verdict. TRUNCATED only: a genuinely
        // phase-less milestone classifies COMPLETE (V004 owns that case) and
        // an unscoped/unreadable window is a different failure mode with a
        // different remediation, deliberately not warned here.
        try {
          // #3641: thread the resolved convention so the scope axis's
          // hasPhaseEntries comparison recognizes bracket phase entries.
          const scoped = extractCurrentMilestoneScoped(contentAfterBom, cwd, undefined, convention);
          if (scoped.scope === SCOPE.TRUNCATED) {
            warnings.push({
              code: 'V005',
              message:
                'Active milestone window is truncated: phase entries exist in ROADMAP.md but are excluded from the ' +
                'active milestone\'s resolved window (check for a heading between the milestone heading and its phase-entry sections)',
            });
          }
        } catch {
          // The classifier is best-effort here — a throw must not mask the
          // structural warnings already collected above.
        }

        // W021 only fires when phase_id_convention is explicitly
        // 'milestone-prefixed' — the same hoisted resolution above (#3641).
        if (convention === 'milestone-prefixed') {
          warnings.push(...checkW021(roadmapContent));
        }

        const result = { warnings };
        process.stdout.write(raw ? JSON.stringify(result) : JSON.stringify(result, null, 2));
        // #2978: exit non-zero on any warning, per the documented contract
        // ("exits non-zero on any error or warning").
        if (warnings.length > 0) {
          throw new ExitError(1);
        }
      },
      'upgrade': () => {
        const dryRun = !args.includes('--apply');
        // Parse `--convention <value>` and `--convention=<value>`. When the flag is
        // absent entirely, default to the only supported convention; when present
        // with a missing/unsupported value, fall through to the rejection below
        // (fail-closed — never silently run a migration the user did not request).
        let convention = 'milestone-prefixed';
        const conventionFlagIdx = args.findIndex(
          (a) => a === '--convention' || a.startsWith('--convention='),
        );
        if (conventionFlagIdx !== -1) {
          const token = args[conventionFlagIdx];
          convention = token.includes('=')
            ? token.slice(token.indexOf('=') + 1)
            : (args[conventionFlagIdx + 1] ?? '');
        }
        if (convention !== 'milestone-prefixed') {
          // No-throw hub contract (ADR-0012): a hub-dispatched handler must not call
          // process.exit. Throw instead — the hub converts this to HandlerFailure and
          // the adapter routes it through the injected error() boundary.
          throw new Error('Only --convention milestone-prefixed is supported');
        }
        const plan = roadmapUpgrade.computeMigrationPlan(cwd);
        roadmapUpgrade.applyMigration(cwd, plan, { dryRun });
      },
    },
  });
}

export = {
  routeRoadmapCommand,
};
