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
import { buildWorkstreamInventory, isCompletedInventory } from './workstream-inventory-builder.cjs';
import type { WorkstreamInventory, StateProjection } from './workstream-inventory-builder.cjs';

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

/**
 * #2562: parse the ROADMAP `## Progress` milestone table into a
 * phase-number → milestone-version map, e.g. `| 30. Name | v10.0 | 1/3 | … |`
 * → `{ "30" => "v10.0" }`. This is the authoritative per-phase milestone
 * attribution and — crucially — lists phases declared but never scaffolded
 * (no directory), which a directory-only scan misses. Only milestone-grouped
 * tables (with a version column) yield entries; greenfield tables
 * (`| Phase | Plans | Status | … |`, no version column) yield an empty map,
 * and callers fall back to legacy whole-roadmap counting. Mirrors the
 * reference implementation in the issue (scripts/gsd-truth.mjs).
 */
function parseRoadmapMilestoneTable(roadmapPath: string): Map<string, string> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return map; /* no roadmap */
  }
  // Only the `milestone-grouped` RoadmapProgress variant carries per-phase
  // milestone attribution; the `flat` variant has no Milestone column and
  // yields an empty map (callers then fall back to legacy counting).
  const table = findTableWithColumns(content, ['Phase', 'Milestone']);
  if (!table) return map;
  for (const row of table.rows) {
    const num = (row['Phase'] ?? '').match(/^\s*(\d+(?:\.\d+)?)\b/);
    const version = (row['Milestone'] ?? '').trim();
    if (num && /^v\d+(?:\.\d+)+$/.test(version)) map.set(num[1], version);
  }
  return map;
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
 * #2562: normalize a phase directory name to its ROADMAP-table number key,
 * e.g. `30-schedule-8` → `30`, `05.1-follow-up` → `5.1`. Leading zeros on the
 * integer segment are stripped so padded directories match unpadded table keys.
 */
function phaseDirNum(dir: string): string | null {
  const m = dir.match(/^0*(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * #2562: does the CURRENT milestone's own ROADMAP heading / milestone-list line
 * carry a shipped marker (✅ / SHIPPED) without an in-progress marker? Scoped to
 * the current version so a prior milestone's collapsed `<details><summary>✅ …
 * SHIPPED</summary>` block can never mark the current milestone complete.
 */
function currentMilestoneHeadingShipped(roadmapPath: string, version: string): boolean {
  try {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    const esc = escapeRegExp(version);
    const lineRe = new RegExp(`^(?:#{1,3}\\s|[-*]\\s).*\\b${esc}\\b.*$`, 'gmi');
    for (const line of content.match(lineRe) ?? []) {
      if (/🚧|🔄|in\s+progress/i.test(line)) continue;
      if (/✅|\bSHIPPED\b/i.test(line)) return true;
    }
  } catch {
    /* no roadmap */
  }
  return false;
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
 */
function workstreamMilestoneShipped(
  roadmapPath: string,
  planningBase: string,
  currentVersion: string | null,
): boolean {
  if (!currentVersion) {
    return legacyMilestoneShipped(roadmapPath, planningBase);
  }
  // Canonical shipped artifact: the archived ROADMAP snapshot of the CURRENT
  // milestone (`vX.Y-ROADMAP.md`), written at milestone close. REQUIREMENTS
  // snapshots are intentionally NOT accepted — they can be written at milestone
  // START (requirements-locked), so they do not imply shipped.
  const snapshot = path.join(planningBase, 'milestones', `${currentVersion}-ROADMAP.md`);
  if (fs.existsSync(snapshot)) return true;
  return currentMilestoneHeadingShipped(roadmapPath, currentVersion);
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

  // #2562: scope progress to the CURRENT milestone. The Progress-table map
  // gives per-phase milestone attribution (incl. dirless phases); the set of
  // phase numbers belonging to the current version is both the completion
  // denominator and the directory-membership filter for the numerator.
  const currentVersion = readCurrentMilestoneVersion(p.state, p.roadmap);
  const milestoneTable = parseRoadmapMilestoneTable(p.roadmap);
  const currentMilestoneNums = new Set<string>();
  if (currentVersion) {
    for (const [num, version] of milestoneTable) {
      if (version === currentVersion) currentMilestoneNums.add(num);
    }
  }
  const scoped = currentMilestoneNums.size > 0;

  // Collect per-phase file counts (+ milestone membership + verification verdict)
  const phaseFilesCounts = phaseDirNames.map(dir => {
    const phaseDir = path.join(p.phases, dir);
    const counts = countPhaseFiles(phaseDir);
    const num = phaseDirNum(dir);
    return {
      directory: dir,
      planCount: counts.planCount,
      summaryCount: counts.summaryCount,
      inMilestone: scoped ? (num !== null && currentMilestoneNums.has(num)) : true,
      verificationStatus: readVerificationStatus(phaseDir).status,
    };
  });

  return buildWorkstreamInventory({
    name,
    projectDir: cwd,
    workstreamDir: wsDir,
    phaseDirNames,
    activeWorkstreamName: activeWorkstreamName ?? '',
    phaseFilesCounts,
    roadmapPhaseCount: countRoadmapPhases(p.roadmap, phaseDirNames.length),
    currentMilestonePhaseCount: currentMilestoneNums.size,
    stateProjection: readStateProjection(p.state),
    filesExist: {
      roadmap: fs.existsSync(p.roadmap),
      state: fs.existsSync(p.state),
      requirements: fs.existsSync(p.requirements),
    },
    milestoneShipped: workstreamMilestoneShipped(p.roadmap, p.planning, currentVersion),
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
