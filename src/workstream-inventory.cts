/**
 * Workstream Inventory Module
 *
 * Owns discovery and read-only projection of .planning/workstreams/* state.
 * Command handlers should render outputs from this inventory instead of
 * rescanning workstream directories directly.
 *
 * Pure projection logic lives in workstream-inventory-builder.cts.
 * This module handles I/O orchestration only.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream-inventory.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { readSubdirectories } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScan = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningRoot, getActiveWorkstream } = planningWorkspace;
import { stateExtractField } from './state-document.cjs';
import { findTableWithColumns } from './markdown-table.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
const { readVerificationStatus } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const { phaseKeyFromDir, phaseKeyFromProse, parentPhaseKey } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter, isMilestoneShippedInRoadmap } = roadmapParserMod;
import { buildWorkstreamInventory, isCompletedInventory } from './workstream-inventory-builder.cjs';
import type { WorkstreamInventory, StateProjection, MilestoneShippedSignal } from './workstream-inventory-builder.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhaseFileCounts {
  planCount: number;
  summaryCount: number;
}

interface InspectWorkstreamOptions {
  active?: string | null;
}

interface WorkstreamInventoryList {
  mode: 'flat' | 'workstream';
  active: string | null;
  workstreams: WorkstreamInventory[];
  count: number;
  message?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function workstreamsRoot(cwd: string): string {
  return path.join(planningRoot(cwd), 'workstreams');
}

function countRoadmapPhases(roadmapPath: string, fallbackCount: number): number {
  try {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const matches = roadmapContent.match(/^#{2,4}\s+Phase\s+[\w][\w.-]*/gm);
    return matches ? matches.length : fallbackCount;
  } catch {
    return fallbackCount;
  }
}

interface RoadmapProgressRow {
  /** Canonical phase key (`phaseKeyFromProse`) — the SAME key space as `phaseKeyFromDir`. */
  key: string;
  /** `vX.Y` when the row attributes the phase to a milestone; null when the cell is absent, blank or malformed. */
  version: string | null;
}

/**
 * #2562: parse the ROADMAP `## Progress` table into canonical phase keys with
 * their milestone attribution, e.g. `| 30. Name | v10.0 | 1/3 | … |` →
 * `{ key: '30', version: 'v10.0' }`. The table is the authoritative per-phase
 * milestone attribution and — crucially — lists phases declared but never
 * scaffolded (no directory), which a directory-only scan misses. `Plans
 * Complete` is present in BOTH RoadmapProgress variants, so this matches the
 * flat (no Milestone column → every `version` null) and milestone-grouped
 * shapes alike.
 *
 * Row keys come from `phaseKeyFromProse`, the same owner-module derivation
 * `phaseKeyFromDir` uses for directories, so a `| 01. … |` row and a `1-slug`
 * directory cannot land in different key spaces (the padding-asymmetry defect).
 */
function parseRoadmapProgressRows(roadmapPath: string): RoadmapProgressRow[] {
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return []; /* no roadmap */
  }
  // Milestone-ATTRIBUTING shape first. Both shapes carry `Plans Complete`, so
  // probing that column first would pick a flat table appearing earlier in the
  // document over a milestone-grouped one later — every row would come back
  // unattributed and be treated as current-milestone, silently over-including.
  const table = findTableWithColumns(content, ['Phase', 'Milestone'])
    ?? findTableWithColumns(content, ['Phase', 'Plans Complete']);
  if (!table) return [];
  const rows: RoadmapProgressRow[] = [];
  for (const row of table.rows) {
    const key = phaseKeyFromProse(row['Phase']);
    if (key === null) continue;
    const cell = (row['Milestone'] ?? '').trim();
    rows.push({ key, version: /^v\d+(?:\.\d+)+$/.test(cell) ? cell : null });
  }
  return rows;
}

/**
 * #2562: the workstream's CURRENT milestone version, read from the STATE.md
 * `milestone:` frontmatter field (the reliable per-workstream signal — the
 * ROADMAP's own in-progress markers can be stale, e.g. a lingering 🚧 on an
 * already-shipped milestone). Falls back to the ROADMAP in-progress heading
 * marker only when STATE has no field.
 */
function readCurrentMilestoneVersion(statePath: string, roadmapPath: string): string | null {
  try {
    const m = fs.readFileSync(statePath, 'utf-8').match(/^milestone:\s*["']?(v\d+(?:\.\d+)+)["']?/m);
    if (m) return m[1];
  } catch {
    /* no state */
  }
  try {
    const rm = fs.readFileSync(roadmapPath, 'utf-8').match(/(?:🚧|🔄)\s*\*\*(v\d+(?:\.\d+)+)\b/);
    if (rm) return rm[1];
  } catch {
    /* no roadmap */
  }
  return null;
}

/**
 * #2562: does the CURRENT milestone's own ROADMAP heading carry a shipped
 * marker? Delegated to `roadmap-parser`, the module that owns milestone-heading
 * classification: heading/`<summary>` lines only (never a bullet that merely
 * names the version), version-token boundary-matched so `v2.0` does not match
 * inside `v2.0.1`, and in-progress markers win. Scoped to the current version,
 * so a prior milestone's collapsed `<details><summary>✅ … SHIPPED</summary>`
 * block can never mark the current milestone complete.
 */
function currentMilestoneHeadingShipped(roadmapPath: string, version: string): boolean {
  try {
    return isMilestoneShippedInRoadmap(fs.readFileSync(roadmapPath, 'utf-8'), version);
  } catch {
    return false; /* no roadmap */
  }
}

/**
 * Legacy pre-#2562 shipped detection: ANY archived milestone snapshot OR a
 * SHIPPED marker anywhere in the ROADMAP. Over-broad (project-lifetime, not
 * milestone-scoped) — retained ONLY as the fallback when the current milestone
 * version cannot be determined (malformed/legacy STATE.md with no `milestone:`
 * field), so those projects keep #1913's stale-field protection.
 */
function legacyMilestoneShipped(roadmapPath: string, planningBase: string): boolean {
  try {
    const milestonesDir = path.join(planningBase, 'milestones');
    for (const entry of fs.readdirSync(milestonesDir, { withFileTypes: true })) {
      if (entry.isFile() && /-ROADMAP\.md$/i.test(entry.name)) return true;
    }
  } catch {
    /* no milestones archive dir */
  }
  try {
    if (/SHIPPED/i.test(fs.readFileSync(roadmapPath, 'utf-8'))) return true;
  } catch {
    /* no roadmap */
  }
  return false;
}

/**
 * #2562: directory mtime, used only to break a duplicate-phase-key tie in the
 * rollup (keep the more recently touched directory — the Bug #2445 rule). 0 on
 * a stat failure, which loses the tie rather than throwing.
 */
function phaseDirMtime(phaseDir: string): number {
  try {
    return fs.statSync(phaseDir).mtimeMs;
  } catch {
    return 0;
  }
}

function countPhaseFiles(phaseDir: string): PhaseFileCounts {
  const scan = planScan(phaseDir);
  return { planCount: scan.planCount, summaryCount: scan.summaryCount };
}

function readStateProjection(statePath: string): StateProjection {
  try {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    return {
      status: stateExtractField(stateContent, 'Status') || 'unknown',
      current_phase: stateExtractField(stateContent, 'Current Phase'),
      last_activity: stateExtractField(stateContent, 'Last Activity'),
    };
  } catch {
    return {
      status: 'unknown',
      current_phase: null,
      last_activity: null,
    };
  }
}

/**
 * #1913 + #2562: detect an authoritative shipped signal for a workstream's
 * CURRENT milestone, so the inventory status is never trusted from the mutable
 * STATE.md `Status` field alone (#1913) yet is never pinned to "milestone
 * complete" by a PRIOR milestone's shipped marker (#2562).
 *
 * When the current milestone version is known, the signal is scoped to it:
 * an archived snapshot `milestones/<version>-ROADMAP.md` (the canonical
 * "milestone shipped" artifact) OR the current milestone's own ROADMAP line
 * marked shipped. When the version cannot be determined, we fall back to the
 * over-broad legacy detection to preserve #1913's protection for those
 * (malformed/legacy) projects.
 *
 * Returns WHICH signal fired, not merely that one did. The two differ in how
 * much they can be trusted and therefore in how the builder cross-validates
 * them against the milestone's own artifacts — see the `shippedContradicted`
 * block in `workstream-inventory-builder.cts`. Collapsing them to a boolean is
 * what forced a single completeness check to serve two incompatible shapes.
 */
function workstreamShippedSignal(
  roadmapPath: string,
  planningBase: string,
  currentVersion: string | null,
): MilestoneShippedSignal {
  if (!currentVersion) {
    return legacyMilestoneShipped(roadmapPath, planningBase) ? 'legacy' : null;
  }
  // Canonical shipped artifact: the archived ROADMAP snapshot of the CURRENT
  // milestone (`vX.Y-ROADMAP.md`), written at milestone close. REQUIREMENTS
  // snapshots are intentionally NOT accepted — they can be written at milestone
  // START (requirements-locked), so they do not imply shipped.
  const snapshot = path.join(planningBase, 'milestones', `${currentVersion}-ROADMAP.md`);
  if (fs.existsSync(snapshot)) return 'snapshot';
  return currentMilestoneHeadingShipped(roadmapPath, currentVersion) ? 'heading' : null;
}

function sortWorkstreamInventories(inventories: WorkstreamInventory[], activeWorkstreamName: string | null): WorkstreamInventory[] {
  return [...inventories].sort((a, b) => {
    const aActive = a.name === activeWorkstreamName ? 1 : 0;
    const bActive = b.name === activeWorkstreamName ? 1 : 0;
    if (aActive !== bActive) {
      return bActive - aActive;
    }
    return a.name.localeCompare(b.name);
  });
}

function inspectWorkstream(cwd: string, name: string, options: InspectWorkstreamOptions = {}): WorkstreamInventory | null {
  const wsDir = path.join(workstreamsRoot(cwd), name);
  if (!fs.existsSync(wsDir)) return null;

  const activeWorkstreamName = options.active === undefined ? getActiveWorkstream(cwd) : options.active;
  const p = planningPaths(cwd, name);
  const phaseDirNames = readSubdirectories(p.phases);

  // #2562: scope progress to the CURRENT milestone. Membership and the
  // denominator are derived in ONE key space (`phaseKeyFromDir` /
  // `phaseKeyFromProse`, both from the phase-id owner module) so the two sides
  // of the rollup cannot disagree.
  const currentVersion = readCurrentMilestoneVersion(p.state, p.roadmap);
  const progressRows = parseRoadmapProgressRows(p.roadmap);

  // Phase keys the ROADMAP attributes to the current milestone. A row whose
  // Milestone cell is blank or malformed is INCLUDED rather than dropped: a
  // phase we cannot attribute must still be visible to the rollup. Dropping it
  // from both sides was the silent-deletion defect — it let an unstarted phase
  // vanish and the percentage round to 100. Over-inclusive-never-under is the
  // degrade direction this codebase already commits to for unparseable roadmap
  // input (see the getMilestonePhaseFilter catch in roadmap-parser.cts).
  const currentMilestoneKeys = new Set<string>();
  if (currentVersion) {
    for (const row of progressRows) {
      if (row.version === null || row.version === currentVersion) currentMilestoneKeys.add(row.key);
    }
  }

  // Roadmap-heading membership, from the module that OWNS milestone-phase
  // filtering. Consulted only when it is genuinely scoped to a single milestone
  // (`versionScoped`); the unversioned whole-roadmap shape spans the project's
  // lifetime and would re-admit prior-milestone phases — the very defect here.
  const headingFilter = getMilestonePhaseFilter(cwd, currentVersion, null, name);
  const headingScoped = headingFilter.versionScoped && headingFilter.phaseCount > 0;

  // Phase keys the ROADMAP attributes to some OTHER milestone. A row carrying an
  // explicit version that is not the current one is a positive claim by a prior
  // (or future) milestone — the only reliable evidence that a phase does NOT
  // belong to the current one.
  const claimedElsewhere = new Set<string>();
  for (const row of progressRows) {
    if (row.version !== null && row.version !== currentVersion) claimedElsewhere.add(row.key);
  }

  // #2562: the current milestone is DECLARED but nothing attributes a phase to
  // it yet — the window right after `/gsd-new-milestone`, where STATE.md's
  // `milestone:` field updates the moment the heading lands but the Progress
  // table and phase sections have not caught up.
  //
  // Treating that as "unscoped" was a hole in the original fix: scoping switched
  // off entirely and the fallback below counted the project's ENTIRE phase
  // history as both numerator and denominator, so a workstream whose current
  // milestone had zero phases done reported 100% off its predecessors' work.
  // That is the very symptom #2562 reports, reached by a different route.
  //
  // Three independent signals witness it; ANY of them is enough, and each covers
  // a ROADMAP shape the others miss:
  //   - `versionSectionFound` — the milestone's own section exists but declares
  //     no phases (heading-only ROADMAPs, and the common `## v3.0` stub).
  //   - `missingExplicitVersion` — the ROADMAP versions its milestones but has
  //     no section for this one at all.
  //   - a Progress table that attributes every row elsewhere (`claimedElsewhere`
  //     non-empty while `currentMilestoneKeys` is empty).
  // A ROADMAP that attributes NO versions anywhere matches none of them: its
  // rows parse with `version: null`, land in `currentMilestoneKeys`, and never
  // reach here. That is deliberate — for a free-form legacy project the
  // whole-roadmap count IS the current milestone, and `readCurrentMilestoneVersion`
  // hands back a non-null version for almost every project, so keying off
  // `currentVersion` alone would regress every one of them to 0%.
  const currentMilestoneDeclaredEmpty =
    currentVersion !== null &&
    currentMilestoneKeys.size === 0 &&
    !headingScoped &&
    (headingFilter.versionSectionFound || headingFilter.missingExplicitVersion || claimedElsewhere.size > 0);

  // A dir-only phase joins the current milestone when the roadmap names it, or
  // when it is a sub-phase (`30.1-…`) of a phase the roadmap names — sub-phases
  // inserted mid-milestone rarely get a row of their own. Membership feeds BOTH
  // the numerator and (via `milestoneKeys` below) the denominator, so a member
  // can never exceed the denominator that counts it.
  const scoped = currentMilestoneKeys.size > 0 || headingScoped || currentMilestoneDeclaredEmpty;
  const isDirInCurrentMilestone = (dir: string): boolean => {
    if (!scoped) return true;
    const key = phaseKeyFromDir(dir);
    if (currentMilestoneKeys.has(key)) return true;
    const parent = parentPhaseKey(key);
    if (parent !== null && currentMilestoneKeys.has(parent)) return true;
    // An empty current milestone has no roadmap declarations to match against,
    // so membership inverts: a directory belongs UNLESS another milestone claims
    // it. A phase scaffolded before the roadmap caught up would otherwise vanish
    // from both sides of the rollup — under-reporting, the direction this
    // codebase never degrades in.
    if (currentMilestoneDeclaredEmpty) {
      const parentKey = parentPhaseKey(key);
      return !claimedElsewhere.has(key) && (parentKey === null || !claimedElsewhere.has(parentKey));
    }
    return headingScoped && headingFilter(dir);
  };

  // Collect per-phase file counts (+ canonical key, milestone membership,
  // verification verdict). `phaseKey` lets the builder de-duplicate stale
  // same-numbered directories (Bug #2445's scenario) in the rollup.
  const phaseFilesCounts = phaseDirNames.map(dir => {
    const phaseDir = path.join(p.phases, dir);
    const counts = countPhaseFiles(phaseDir);
    return {
      directory: dir,
      phaseKey: phaseKeyFromDir(dir),
      mtimeMs: phaseDirMtime(phaseDir),
      planCount: counts.planCount,
      summaryCount: counts.summaryCount,
      inMilestone: isDirInCurrentMilestone(dir),
      verificationStatus: readVerificationStatus(phaseDir).status,
    };
  });

  // The denominator is the union of what the roadmap DECLARES for the current
  // milestone (including never-scaffolded phases) and the keys of the member
  // directories (including dir-only sub-phases). One key space, so
  // `completed_phases <= denominator` holds by construction rather than by a
  // `Math.min` cap that hid the inconsistency.
  const milestoneKeys = new Set(currentMilestoneKeys);
  for (const entry of phaseFilesCounts) {
    if (entry.inMilestone) milestoneKeys.add(entry.phaseKey);
  }
  const currentMilestonePhaseCount = scoped
    ? Math.max(milestoneKeys.size, headingScoped ? headingFilter.phaseCount : 0)
    : 0;

  // Unscoped fallback: the denominator must STILL count phases the ROADMAP
  // declares in its Progress table but never scaffolded — the heading-only
  // count drops them, even when other headings exist. Union the declared rows
  // with the phase directories so neither source can silently shrink it.
  let fallbackPhaseCount = countRoadmapPhases(p.roadmap, phaseDirNames.length);
  if (!scoped && progressRows.length > 0) {
    const union = new Set(progressRows.map(row => row.key));
    for (const entry of phaseFilesCounts) union.add(entry.phaseKey);
    fallbackPhaseCount = union.size;
  }

  return buildWorkstreamInventory({
    name,
    projectDir: cwd,
    workstreamDir: wsDir,
    phaseDirNames,
    activeWorkstreamName: activeWorkstreamName ?? '',
    phaseFilesCounts,
    roadmapPhaseCount: fallbackPhaseCount,
    currentMilestonePhaseCount,
    // Stated, not inferred from the count: a declared-but-empty current
    // milestone is legitimately scoped AND legitimately zero-phase, and the
    // builder cannot tell those apart from `currentMilestonePhaseCount` alone.
    milestoneScoped: scoped,
    stateProjection: readStateProjection(p.state),
    filesExist: {
      roadmap: fs.existsSync(p.roadmap),
      state: fs.existsSync(p.state),
      requirements: fs.existsSync(p.requirements),
    },
    milestoneShippedSignal: workstreamShippedSignal(p.roadmap, p.planning, currentVersion),
  });
}

function listWorkstreamInventories(cwd: string): WorkstreamInventoryList {
  const wsRoot = workstreamsRoot(cwd);
  if (!fs.existsSync(wsRoot)) {
    return {
      mode: 'flat',
      active: null,
      workstreams: [],
      count: 0,
      message: 'No workstreams — operating in flat mode',
    };
  }

  const active = getActiveWorkstream(cwd);
  const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
  const workstreams: WorkstreamInventory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const inventory = inspectWorkstream(cwd, entry.name, { active });
    if (inventory) workstreams.push(inventory);
  }

  const ordered = sortWorkstreamInventories(workstreams, active);

  return {
    mode: 'workstream',
    active,
    workstreams: ordered,
    count: ordered.length,
  };
}

function getOtherActiveWorkstreamInventories(cwd: string, excludeWs: string): WorkstreamInventory[] {
  return listWorkstreamInventories(cwd).workstreams
    .filter(inventory => inventory.name !== excludeWs)
    .filter(inventory => !isCompletedInventory(inventory.status));
}

export = {
  countPhaseFiles,
  countRoadmapPhases,
  getOtherActiveWorkstreamInventories,
  inspectWorkstream,
  isCompletedInventory,
  listWorkstreamInventories,
  sortWorkstreamInventories,
  workstreamsRoot,
};
