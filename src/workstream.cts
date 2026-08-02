/**
 * Workstream — CRUD operations for workstream namespacing
 *
 * Workstreams enable parallel milestones by scoping ROADMAP.md, STATE.md,
 * REQUIREMENTS.md, and phases/ into .planning/workstreams/{name}/ directories.
 *
 * When no workstreams/ directory exists, GSD operates in "flat mode" with
 * everything at .planning/ — backward compatible with pre-workstream installs.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParser = require('./roadmap-parser.cjs');
const { getMilestoneInfo } = roadmapParser;
import { platformWriteSync, platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningRoot, setActiveWorkstream, getActiveWorkstream } = planningWorkspace;
import {
  toWorkstreamSlug,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
} from './workstream-name-policy.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import workstreamInventory = require('./workstream-inventory.cjs');
const {
  getOtherActiveWorkstreamInventories,
  inspectWorkstream,
  listWorkstreamInventories,
} = workstreamInventory;

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkstreamCreateOptions {
  migrate?: boolean;
  migrateName?: string | null;
}

interface MigrateResult {
  migrated: boolean;
  workstream: string;
  files_moved: string[];
}

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate flat .planning/ layout to workstream mode.
 * Moves per-workstream files (ROADMAP.md, STATE.md, REQUIREMENTS.md, phases/)
 * into .planning/workstreams/{name}/. Shared files (PROJECT.md, config.json,
 * milestones/, research/, codebase/, todos/) stay in place.
 */
function migrateToWorkstreams(cwd: string, workstreamName: string): MigrateResult {
  try {
    assertValidActiveWorkstreamName(workstreamName, 'Invalid workstream name for migration');
  } catch {
    throw new Error('Invalid workstream name for migration');
  }

  const baseDir = planningRoot(cwd);
  const wsDir = path.join(baseDir, 'workstreams', workstreamName);

  if (fs.existsSync(path.join(baseDir, 'workstreams'))) {
    throw new Error('Already in workstream mode — .planning/workstreams/ exists');
  }

  const toMove: Array<{ name: string; type: string }> = [
    { name: 'ROADMAP.md', type: 'file' },
    { name: 'STATE.md', type: 'file' },
    { name: 'REQUIREMENTS.md', type: 'file' },
    { name: 'phases', type: 'dir' },
  ];

  platformEnsureDir(wsDir);

  const filesMoved: string[] = [];
  try {
    for (const item of toMove) {
      const src = path.join(baseDir, item.name);
      if (fs.existsSync(src)) {
        const dest = path.join(wsDir, item.name);
        retryRenameSync(src, dest);
        filesMoved.push(item.name);
      }
    }
  } catch (err) {
    for (const name of filesMoved) {
      try { retryRenameSync(path.join(wsDir, name), path.join(baseDir, name)); } catch { /* ignore */ }
    }
    try { fs.rmSync(wsDir, { recursive: true }); } catch { /* ignore */ }
    try { fs.rmdirSync(path.join(baseDir, 'workstreams')); } catch { /* ignore */ }
    throw err;
  }

  return { migrated: true, workstream: workstreamName, files_moved: filesMoved };
}

// ─── CRUD Commands ────────────────────────────────────────────────────────────

function cmdWorkstreamCreate(cwd: string, name: string | null | undefined, options: WorkstreamCreateOptions, raw: boolean): void {
  if (!name) {
    error('workstream name required. Usage: workstream create <name>');
  }

  const slug = toWorkstreamSlug(name);
  if (!slug) {
    error('Invalid workstream name — must contain at least one alphanumeric character');
  }

  const baseDir = planningRoot(cwd);
  if (!fs.existsSync(baseDir)) {
    error(`.planning/ directory not found — run ${formatGsdSlash('new-project', resolveRuntime(cwd)) as string} first`);
  }

  const wsRoot = path.join(baseDir, 'workstreams');
  const wsDir = path.join(wsRoot, slug);

  if (fs.existsSync(wsDir) && fs.existsSync(path.join(wsDir, 'STATE.md'))) {
    output({ created: false, error: 'already_exists', workstream: slug, path: toPosixPath(path.relative(cwd, wsDir)) }, raw, undefined);
    return;
  }

  const isFlatMode = !fs.existsSync(wsRoot);
  let migration: MigrateResult | null = null;
  if (isFlatMode && options.migrate !== false) {
    const hasExistingWork = fs.existsSync(path.join(baseDir, 'ROADMAP.md')) ||
                            fs.existsSync(path.join(baseDir, 'STATE.md')) ||
                            fs.existsSync(path.join(baseDir, 'phases'));

    if (hasExistingWork) {
      const migrateName = options.migrateName || null;
      let existingWsName: string;
      if (migrateName) {
        const slugged = toWorkstreamSlug(migrateName);
        if (!slugged) {
          output({
            created: false,
            error: 'migration_failed',
            message: 'Invalid migrate-name — must contain at least one alphanumeric character',
          }, raw, undefined);
          return;
        }
        existingWsName = slugged;
      } else {
        try {
          const milestone = getMilestoneInfo(cwd);
          // 'default' stays the answer for "there is no milestone to name this
          // after" (the catch below), but NOT for "the milestone has a name we
          // could not render" — that would file the work under a directory
          // unrelated to it, silently (#2848).
          // Logical OR, because the generator returns an empty string for
          // input with no slug-safe characters, not only a missing value —
          // a nullish check alone lets that case through.
          existingWsName = generateSlugInternal(milestone.name)
            || error(`milestone name has no slug-safe characters: ${JSON.stringify(milestone.name)}`);
        } catch {
          existingWsName = 'default';
        }
      }

      try {
        migration = migrateToWorkstreams(cwd, existingWsName);
      } catch (e) {
        output({ created: false, error: 'migration_failed', message: (e as Error).message }, raw, undefined);
        return;
      }
    } else {
      platformEnsureDir(wsRoot);
    }
  }

  platformEnsureDir(wsDir);
  platformEnsureDir(path.join(wsDir, 'phases'));

  const today = realClock.localToday();
  const stateContent = [
    '---',
    `workstream: ${slug}`,
    `created: ${today}`,
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '**Status:** Not started',
    '**Current Phase:** None',
    `**Last Activity:** ${today}`,
    '**Last Activity Description:** Workstream created',
    '',
    '## Progress',
    '**Phases Complete:** 0',
    '**Current Plan:** N/A',
    '',
    '## Session Continuity',
    '**Stopped At:** N/A',
    '**Resume File:** None',
    '',
  ].join('\n');

  const statePath = path.join(wsDir, 'STATE.md');
  if (!fs.existsSync(statePath)) {
    platformWriteSync(statePath, stateContent);
  }

  setActiveWorkstream(cwd, slug);

  const relPath = toPosixPath(path.relative(cwd, wsDir));
  output({
    created: true,
    workstream: slug,
    path: relPath,
    state_path: relPath + '/STATE.md',
    phases_path: relPath + '/phases',
    migration: migration || null,
    active: true,
  }, raw, undefined);
}

function cmdWorkstreamList(cwd: string, raw: boolean): void {
  const inventory = listWorkstreamInventories(cwd);
  if (inventory.mode === 'flat') {
    output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
    return;
  }

  const workstreams = inventory.workstreams.map(ws => ({
    name: ws.name,
    path: ws.path,
    has_roadmap: ws.files.roadmap,
    has_state: ws.files.state,
    status: ws.status,
    // #2562: a refused shipped marker must reach the surface. Projecting
    // `status` without it renders the refusal invisible at the CLI, which is
    // the silent-collapse defect this issue is about.
    milestone_shipped_unverified: ws.milestone_shipped_unverified,
    current_phase: ws.current_phase,
    phase_count: ws.phase_count,
    completed_phases: ws.completed_phases,
  }));

  output({ mode: 'workstream', workstreams, count: workstreams.length }, raw, undefined);
}

function cmdWorkstreamStatus(cwd: string, name: string | null | undefined, raw: boolean): void {
  if (!name) error('workstream name required. Usage: workstream status <name>');
  try {
    assertValidActiveWorkstreamName(name, INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  } catch {
    error(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name!);
  if (!fs.existsSync(wsDir)) {
    output({ found: false, workstream: name }, raw, undefined);
    return;
  }

  const inv = inspectWorkstream(cwd, name!);
  if (!inv) {
    output({ found: false, workstream: name }, raw, undefined);
    return;
  }

  output({
    found: true,
    workstream: name,
    path: inv.path,
    files: inv.files,
    phases: inv.phases,
    phase_count: inv.phase_count,
    completed_phases: inv.completed_phases,
    status: inv.status,
    milestone_shipped_unverified: inv.milestone_shipped_unverified,
    current_phase: inv.current_phase,
    last_activity: inv.last_activity,
  }, raw, undefined);
}

function cmdWorkstreamComplete(cwd: string, name: string | null | undefined, options: Record<string, unknown>, raw: boolean): void {
  if (!name) error('workstream name required. Usage: workstream complete <name>');
  try {
    assertValidActiveWorkstreamName(name, INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  } catch {
    error(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  }

  const root = planningRoot(cwd);
  const wsRoot = path.join(root, 'workstreams');
  const wsDir = path.join(wsRoot, name!);

  if (!fs.existsSync(wsDir)) {
    output({ completed: false, error: 'not_found', workstream: name }, raw, undefined);
    return;
  }

  const active = getActiveWorkstream(cwd);
  if (active === name) setActiveWorkstream(cwd, null as unknown as string);

  const archiveDir = path.join(root, 'milestones');
  const today = realClock.localToday();
  let archivePath = path.join(archiveDir, `ws-${name}-${today}`);
  let suffix = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDir, `ws-${name}-${today}-${suffix++}`);
  }

  platformEnsureDir(archivePath);

  const filesMoved: string[] = [];
  try {
    const entries = fs.readdirSync(wsDir, { withFileTypes: true });
    for (const entry of entries) {
      retryRenameSync(path.join(wsDir, entry.name), path.join(archivePath, entry.name));
      filesMoved.push(entry.name);
    }
  } catch (err) {
    for (const fname of filesMoved) {
      try { retryRenameSync(path.join(archivePath, fname), path.join(wsDir, fname)); } catch { /* ignore */ }
    }
    try { fs.rmSync(archivePath, { recursive: true }); } catch { /* ignore */ }
    if (active === name) setActiveWorkstream(cwd, name!);
    output({ completed: false, error: 'archive_failed', message: (err as Error).message, workstream: name }, raw, undefined);
    return;
  }

  try { fs.rmdirSync(wsDir); } catch { /* ignore */ }

  let remainingWs = 0;
  try {
    remainingWs = fs.readdirSync(wsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).length;
    if (remainingWs === 0) fs.rmdirSync(wsRoot);
  } catch { /* ignore */ }

  output({
    completed: true,
    workstream: name,
    archived_to: toPosixPath(path.relative(cwd, archivePath)),
    remaining_workstreams: remainingWs,
    reverted_to_flat: remainingWs === 0,
  }, raw, undefined);
}

// ─── Active Workstream Commands ───────────────────────────────────────────────

function cmdWorkstreamSet(cwd: string, name: string | null | undefined, raw: boolean): void {
  if (!name || name === '--clear') {
    if (name !== '--clear') {
      error('Workstream name required. Usage: workstream set <name> (or workstream set --clear to unset)');
    }
    const previous = getActiveWorkstream(cwd);
    setActiveWorkstream(cwd, null as unknown as string);
    output({ active: null, cleared: true, previous: previous || null }, raw, undefined);
    return;
  }

  if (!isValidActiveWorkstreamName(name)) {
    output({ active: null, error: 'invalid_name', message: 'Workstream name must be alphanumeric, hyphens, underscores, or dots' }, raw, undefined);
    return;
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name);
  if (!fs.existsSync(wsDir)) {
    output({ active: null, error: 'not_found', workstream: name }, raw, undefined);
    return;
  }

  setActiveWorkstream(cwd, name);
  output({ active: name, set: true }, raw, name);
}

function cmdWorkstreamGet(cwd: string, raw: boolean): void {
  const active = getActiveWorkstream(cwd);
  const wsRoot = path.join(planningRoot(cwd), 'workstreams');
  output({ active, mode: fs.existsSync(wsRoot) ? 'workstream' : 'flat' }, raw, active || 'none');
}

function cmdWorkstreamProgress(cwd: string, raw: boolean): void {
  const inventory = listWorkstreamInventories(cwd);
  if (inventory.mode === 'flat') {
    output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
    return;
  }

  const workstreams = inventory.workstreams.map(ws => ({
    name: ws.name,
    active: ws.active,
    status: ws.status,
    milestone_shipped_unverified: ws.milestone_shipped_unverified,
    current_phase: ws.current_phase ?? null,
    phases: `${ws.completed_phases}/${ws.roadmap_phase_count}`,
    plans: `${ws.completed_plans}/${ws.total_plans}`,
    progress_percent: ws.progress_percent,
  }));

  output({ mode: 'workstream', active: inventory.active, workstreams, count: workstreams.length }, raw, undefined);
}

// ─── Collision Detection ──────────────────────────────────────────────────────

/**
 * Return other workstreams that are NOT complete.
 * Used to detect whether the milestone has active parallel work
 * when a workstream finishes its last phase.
 */
function getOtherActiveWorkstreams(cwd: string, excludeWs: string): Array<{
  name: string;
  status: string;
  current_phase: string | null;
  phases: string;
}> {
  return getOtherActiveWorkstreamInventories(cwd, excludeWs).map(ws => ({
    name: ws.name,
    status: ws.status,
    current_phase: ws.current_phase ?? null,
    phases: `${ws.completed_phases}/${ws.phase_count}`,
  }));
}

export = {
  migrateToWorkstreams,
  cmdWorkstreamCreate,
  cmdWorkstreamList,
  cmdWorkstreamStatus,
  cmdWorkstreamComplete,
  cmdWorkstreamSet,
  cmdWorkstreamGet,
  cmdWorkstreamProgress,
  getOtherActiveWorkstreams,
};
