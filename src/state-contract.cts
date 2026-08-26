/**
 * State Contract Module — `.planning/state.json` schema v1 (#3227).
 *
 * A **best-effort publisher** invoked at 11 step-boundary commands
 * (`state.*`, `phase.*`, `milestone.complete`). It composes existing
 * canonical owners; it introduces no second answer to any question GSD
 * already answers:
 *   - `planning-workspace.cjs`'s `planningPaths` for every `.planning/` path
 *     (workstream-aware — never re-derived here).
 *   - `phase-lifecycle.cjs`'s `locateProgressTable` (this issue's Edit 1) for
 *     "where is the Progress table" — the SAME table
 *     `deriveProgressFromRoadmap` counts from, so `phases[]` and
 *     `deriveProgressFromRoadmap`'s `totalPhases` can never disagree about
 *     which rows are data rows.
 *   - `phase-id.cjs`'s `isSentinelPhaseId` / `parsePhaseFromProse` for
 *     sentinel exclusion and STATE.md phase-token parsing.
 *   - `roadmap-parser.cjs`'s `getMilestoneInfo` for milestone identity.
 *   - `markdown-sectionizer.cjs`'s `collectSection` for the `## Phases`
 *     checkbox fallback.
 *   - `state-document.cjs`'s `stateFieldValue` + `frontmatter.cjs`'s
 *     `extractFrontmatter`/`stripFrontmatter` for STATE.md's `current_phase`.
 *   - `shell-command-projection.cjs`'s `platformReadSync`/`platformWriteSync`
 *     — the CLAUDE.md-designated single OS-facing I/O seam. `platformWriteSync`
 *     is ALREADY atomic (sibling tmp + `retryRenameSync`, Windows transient-
 *     lock retry, EXDEV fallback) — this module adds no sixth atomic-write
 *     helper (the repo already carries five).
 *   - `smart-entry.cjs`'s `classifyProject` for `next` — this is what makes
 *     "`next` equals smart-entry's recommended action" true BY CONSTRUCTION
 *     rather than by a second copy of the routing table.
 *
 * WHY NOT `PlanningSnapshot` / `buildPlanningInspect`. `PlanningSnapshot` is
 * an explicitly-additive INTERNAL diagnostic shape (ADR-3180 §8.1) still
 * growing across phases; freezing it as an external contract is the exact
 * Hyrum's-Law break `planning.inspect` (`src/planning-inspect.cts`) already
 * refused for the same reason (#2790). `state.json` declares its OWN flat,
 * minimal, six-key schema instead — see PUBLIC SURFACE below.
 *
 * NOT built (Gall's Law / Zawinski's Law — see `.gsd/phase/feat-3227-state-
 * contract/40-design.md`): a `--watch` mode, a reader API inside gsd-core, a
 * diff/event stream, a config toggle, milestone-scoping of `phases[]`. This
 * module answers "where is this project right now" and nothing else — a
 * request for document *contents* belongs to `planning.inspect`.
 *
 * REQUIRE-CYCLE HAZARD (the single most important implementation
 * constraint). `src/state.cts` imports THIS module, and `src/smart-entry.cts`
 * imports `state.cjs` and destructures `readStateHeadFreshness` off it at
 * MODULE LOAD time. A top-level `import smartEntry = require('./smart-entry.cjs')`
 * here would therefore close the cycle
 * `state.cjs -> state-contract.cjs -> smart-entry.cjs -> state.cjs`, binding
 * `readStateHeadFreshness` to `undefined` inside `smart-entry.cjs` and
 * throwing at its first call. Every owner below is required LAZILY, inside
 * the function body, via a small cached loader — never at module top level —
 * which also keeps this module's (and its owners') load cost off every
 * command that imports `state.cjs` but never reaches a publish boundary.
 * Someone will be tempted to "tidy" the lazy requires into top-level ones;
 * doing so reopens the cycle.
 *
 * `withPlanningLock` is deliberately NOT taken around the write (Rejected §3
 * of the design doc): it is not re-entrant, several phase commands already
 * hold it when they would call this publisher, and `platformWriteSync`'s
 * tmp+rename already makes each publish all-or-nothing without it.
 *
 * ADR-457 build-at-publish: source in src/state-contract.cts, compiled to
 * gsd-core/bin/lib/state-contract.cjs (gitignored).
 */

import path from 'node:path';
import fs from 'node:fs';

// ─── Public wire vocabulary ────────────────────────────────────────────────

export const STATE_CONTRACT_VERSION = '1.0.0';
export const STATE_CONTRACT_FLAVOR = 'core';

/** Key order of the emitted contract object — an observable, pinned by test. */
export const CONTRACT_KEY_ORDER = Object.freeze(['contract', 'flavor', 'milestone', 'phases', 'next', 'updated_at']);

/** Key order of each emitted phase object — an observable, pinned by test. */
export const PHASE_KEY_ORDER = Object.freeze(['number', 'name', 'status']);

/** Frozen three-value phase status vocabulary. Conservative in what we send (Postel's Law). */
export const PHASE_STATUS = Object.freeze({
  COMPLETE: 'complete',
  IN_PROGRESS: 'in_progress',
  PENDING: 'pending',
});

/** Frozen `publishStateContract` result reasons. */
export const PUBLISH_REASON = Object.freeze({
  PUBLISHED: 'published',
  NO_PLANNING_DIR: 'no_planning_dir',
  WRITE_FAILED: 'write_failed',
});

export interface StateContractDeps {
  now?: () => number;
  classify?: (cwd: string) => unknown;
}

interface StateContractPhase {
  number: string;
  name: string | null;
  status: string;
}

interface StateContractNext {
  command: string;
  label: string;
  reason: string;
}

export interface StateContractV1 {
  contract: string;
  flavor: string;
  milestone: string | null;
  phases: StateContractPhase[];
  next: StateContractNext | null;
  updated_at: string;
}

// ─── Lazy owner loader (breaks the state.cjs <-> smart-entry.cjs cycle) ────

interface Owners {
  planningPaths: typeof import('./planning-workspace.cjs')['planningPaths'];
  platformReadSync: typeof import('./shell-command-projection.cjs')['platformReadSync'];
  platformWriteSync: typeof import('./shell-command-projection.cjs')['platformWriteSync'];
  locateProgressTable: typeof import('./phase-lifecycle.cjs')['locateProgressTable'];
  isSentinelPhaseId: typeof import('./phase-id.cjs')['isSentinelPhaseId'];
  parsePhaseFromProse: typeof import('./phase-id.cjs')['parsePhaseFromProse'];
  getMilestoneInfo: typeof import('./roadmap-parser.cjs')['getMilestoneInfo'];
  collectSection: typeof import('./markdown-sectionizer.cjs')['collectSection'];
  stateFieldValue: typeof import('./state-document.cjs')['stateFieldValue'];
  extractFrontmatter: typeof import('./frontmatter.cjs')['extractFrontmatter'];
  stripFrontmatter: typeof import('./frontmatter.cjs')['stripFrontmatter'];
  classifyProject: typeof import('./smart-entry.cjs')['classifyProject'];
}

let _owners: Owners | null = null;

/**
 * Lazily require every owner this module composes. MUST stay lazy — see the
 * "REQUIRE-CYCLE HAZARD" module-doc comment above. Cached after first call so
 * repeat invocations within one process (multiple publishes in one command,
 * or across the several boundary commands in a test run) pay the require
 * cost once.
 */
function owners(): Owners {
  if (_owners) return _owners;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const planningWorkspaceMod = require('./planning-workspace.cjs') as typeof import('./planning-workspace.cjs');
  const shellCommandProjectionMod = require('./shell-command-projection.cjs') as typeof import('./shell-command-projection.cjs');
  const phaseLifecycleMod = require('./phase-lifecycle.cjs') as typeof import('./phase-lifecycle.cjs');
  const phaseIdMod = require('./phase-id.cjs') as typeof import('./phase-id.cjs');
  const roadmapParserMod = require('./roadmap-parser.cjs') as typeof import('./roadmap-parser.cjs');
  const markdownSectionizerMod = require('./markdown-sectionizer.cjs') as typeof import('./markdown-sectionizer.cjs');
  const stateDocumentMod = require('./state-document.cjs') as typeof import('./state-document.cjs');
  const frontmatterMod = require('./frontmatter.cjs') as typeof import('./frontmatter.cjs');
  const smartEntryMod = require('./smart-entry.cjs') as typeof import('./smart-entry.cjs');
  /* eslint-enable @typescript-eslint/no-require-imports */
  _owners = {
    planningPaths: planningWorkspaceMod.planningPaths,
    platformReadSync: shellCommandProjectionMod.platformReadSync,
    platformWriteSync: shellCommandProjectionMod.platformWriteSync,
    locateProgressTable: phaseLifecycleMod.locateProgressTable,
    isSentinelPhaseId: phaseIdMod.isSentinelPhaseId,
    parsePhaseFromProse: phaseIdMod.parsePhaseFromProse,
    getMilestoneInfo: roadmapParserMod.getMilestoneInfo,
    collectSection: markdownSectionizerMod.collectSection,
    stateFieldValue: stateDocumentMod.stateFieldValue,
    extractFrontmatter: frontmatterMod.extractFrontmatter,
    stripFrontmatter: frontmatterMod.stripFrontmatter,
    classifyProject: smartEntryMod.classifyProject,
  };
  return _owners;
}

// ─── milestone ──────────────────────────────────────────────────────────────

function buildMilestone(cwd: string): string | null {
  try {
    const { value } = owners().getMilestoneInfo(cwd);
    if (!value) return null;
    // U+2014 EM DASH, spaced on both sides. Never fabricate a name — version
    // alone when no name-bearing evidence resolved (design row 21).
    return value.name && value.name.length > 0 ? `${value.version} — ${value.name}` : value.version;
  } catch {
    return null;
  }
}

// ─── phases: Progress-table (primary) enumerator ───────────────────────────

const PHASE_CELL_RE = /^(\d+(?:\.\d+)*)\s*[.:)–—-]?\s*(.*)$/;

function statusFromProgressCell(raw: string | undefined): string {
  const normalized = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'complete') return PHASE_STATUS.COMPLETE;
  if (normalized === 'in progress') return PHASE_STATUS.IN_PROGRESS;
  // Everything else — 'not started', 'deferred' (design row 12, lossy by
  // design), '', and any unrecognized word — folds to pending. An
  // unrecognized status must never reach the wire as a 4th value.
  return PHASE_STATUS.PENDING;
}

function phasesFromProgressTable(
  table: { columns: string[]; rows: Record<string, string>[] },
): StateContractPhase[] {
  const { isSentinelPhaseId } = owners();
  const phases: StateContractPhase[] = [];
  for (const row of table.rows) {
    const cell = (row['Phase'] ?? '').trim();
    if (!/^\d/.test(cell)) continue; // stray note row, no leading digit
    if (isSentinelPhaseId(cell)) continue; // phase 0 / 999.x sentinels
    const m = PHASE_CELL_RE.exec(cell);
    const number = m ? m[1] : cell;
    const name = m && m[2].trim().length > 0 ? m[2].trim() : null;
    phases.push({ number, name, status: statusFromProgressCell(row['Status']) });
  }
  return phases;
}

// ─── phases: `## Phases` checkbox fallback ─────────────────────────────────

// `- [x] **Phase 1: Foundation**` / `- [ ] **Phase 2.1: Hardening**`.
const PHASE_BULLET_RE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+\*\*Phase[ \t]+(\d+(?:\.\d+)*)[ \t]*:?[ \t]*([^*\n]*)\*\*/gm;

/**
 * STATE.md's current phase, via the same frontmatter-then-body chain
 * `cmdStateCompletePhase` uses (`stateFieldValue` owns the #1760 fallback
 * ladder). Any failure anywhere in the chain yields `null` — treat current
 * phase as unknown so every unchecked bullet is PENDING rather than
 * IN_PROGRESS by a guess.
 */
function currentPhaseFromState(statePath: string): string | null {
  const { platformReadSync, extractFrontmatter, stripFrontmatter, stateFieldValue, parsePhaseFromProse } = owners();
  try {
    const raw = platformReadSync(statePath);
    if (raw === null) return null;
    const fm = extractFrontmatter(raw, statePath);
    const body = stripFrontmatter(raw);
    const { value } = stateFieldValue(fm, body, 'current_phase', 'Current Phase');
    if (!value) return null;
    return parsePhaseFromProse(value).phase;
  } catch {
    return null;
  }
}

/**
 * Fallback enumerator when the ROADMAP carries no Progress table.
 *
 * Scoping to `## Phases` is load-bearing negative space (design "Not-
 * corruption" section): it is what keeps `- [x] 01-01: a plan` (a PLAN
 * bullet under `## Phase Details`) and `- ✅ **v1.0 MVP** - Phases 1-4`
 * (a MILESTONE bullet under `## Milestones`) from being read as phases. The
 * `**Phase N` anchor inside `PHASE_BULLET_RE` is the second layer of that
 * defence — a plan bullet's text never starts with `**Phase`.
 */
function phasesFromChecklist(roadmapContent: string, cwd: string, statePath: string): StateContractPhase[] {
  const { collectSection, isSentinelPhaseId } = owners();
  const section = collectSection(roadmapContent, (h) => /^phases$/i.test(h.text.trim()));
  if (!section) return [];

  const currentPhase = currentPhaseFromState(statePath);
  const phases: StateContractPhase[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(PHASE_BULLET_RE.source, PHASE_BULLET_RE.flags);
  while ((match = pattern.exec(section.body)) !== null) {
    const checked = match[1] === 'x' || match[1] === 'X';
    const number = match[2];
    if (isSentinelPhaseId(number)) continue;
    const name = match[3].replace(/\r$/, '').trim();
    const status = checked
      ? PHASE_STATUS.COMPLETE
      : (currentPhase !== null && number === currentPhase ? PHASE_STATUS.IN_PROGRESS : PHASE_STATUS.PENDING);
    phases.push({ number, name: name.length > 0 ? name : null, status });
  }
  return phases;
}

function buildPhases(cwd: string, paths: { roadmap: string; state: string }): StateContractPhase[] {
  const { platformReadSync, locateProgressTable } = owners();
  try {
    let content = platformReadSync(paths.roadmap);
    if (content === null) return [];
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip leading BOM

    const table = locateProgressTable(content);
    if (table) return phasesFromProgressTable(table);
    return phasesFromChecklist(content, cwd, paths.state);
  } catch {
    return [];
  }
}

// ─── next ───────────────────────────────────────────────────────────────────

function buildNext(cwd: string, deps?: StateContractDeps): StateContractNext | null {
  try {
    const classify = (deps?.classify as Owners['classifyProject'] | undefined) ?? owners().classifyProject;
    const result = classify(cwd);
    const action = result.actions.find((a) => a.id === result.recommended);
    if (!action) return null;
    return { command: action.command, label: action.label, reason: result.summary };
  } catch {
    return null;
  }
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Build the state-contract snapshot. PURE — writes nothing. Every stage is
 * independently try/caught (milestone, phases, next) so one bad document
 * cannot lose the others; `updated_at` and the frozen `contract`/`flavor`
 * keys always resolve.
 */
export function buildStateContract(cwd: string, deps?: StateContractDeps): StateContractV1 {
  const nowFn = deps?.now ?? Date.now;
  const updated_at = new Date(nowFn()).toISOString();

  // #2245 shape: `planningPaths` -> `planningDir` throws a plain Error for an
  // invalid GSD_WORKSTREAM/GSD_PROJECT segment. This call must not be hoisted
  // outside a try, or that throw escapes uncaught and breaks the invariant
  // this function is documented as upholding (see `getMilestoneInfo`'s
  // equivalent guard comment in src/roadmap-parser.cts for the same shape).
  let paths: { roadmap: string; state: string } | null;
  try {
    paths = owners().planningPaths(cwd);
  } catch {
    paths = null;
  }

  if (!paths) {
    return {
      contract: STATE_CONTRACT_VERSION,
      flavor: STATE_CONTRACT_FLAVOR,
      milestone: null,
      phases: [],
      next: null,
      updated_at,
    };
  }

  const milestone = buildMilestone(cwd);
  const phases = buildPhases(cwd, paths);
  const next = buildNext(cwd, deps);

  return {
    contract: STATE_CONTRACT_VERSION,
    flavor: STATE_CONTRACT_FLAVOR,
    milestone,
    phases,
    next,
    updated_at,
  };
}

/**
 * Publish the state-contract snapshot to `<planning>/state.json`. NEVER
 * throws — for any input, ever (acceptance criterion 3: the parent boundary
 * command's exit code and stdout must be unchanged whatever happens here).
 *
 * No `.planning/` directory at all: writes nothing, creates nothing. This
 * guard is essential — `platformWriteSync` does `mkdirSync(dirname,
 * {recursive:true})`, so without it the publisher would conjure a
 * `.planning/` tree inside a non-GSD directory.
 *
 * `withPlanningLock` is deliberately NOT taken here — see the module-doc
 * "REQUIRE-CYCLE HAZARD" section's sibling note: it is not re-entrant and
 * several phase commands already hold it when they call this publisher, so
 * acquiring it here would throw in exactly the situation this function must
 * never perturb. `platformWriteSync`'s sibling-tmp + rename already makes
 * each publish all-or-nothing without it.
 */
export function publishStateContract(cwd: string, deps?: StateContractDeps): { published: boolean; reason: string } {
  try {
    const { planningPaths, platformWriteSync } = owners();
    // Resolve the planning root BEFORE anything else. A resolution failure
    // (invalid GSD_WORKSTREAM/GSD_PROJECT segment — the #2245 shape) means no
    // write was ever attempted, so it must map to `no_planning_dir`, not
    // `write_failed` — that reason is reserved for an attempted-and-failed
    // write, and reporting it here would send a caller looking at disk
    // permissions for a problem that isn't there.
    let paths: { planning: string };
    try {
      paths = planningPaths(cwd);
    } catch {
      return { published: false, reason: PUBLISH_REASON.NO_PLANNING_DIR };
    }
    if (!fs.existsSync(paths.planning)) {
      return { published: false, reason: PUBLISH_REASON.NO_PLANNING_DIR };
    }

    const snapshot = buildStateContract(cwd, deps);
    const statePath = path.join(paths.planning, 'state.json');
    try {
      platformWriteSync(statePath, JSON.stringify(snapshot, null, 2) + '\n');
    } catch {
      return { published: false, reason: PUBLISH_REASON.WRITE_FAILED };
    }

    return { published: true, reason: PUBLISH_REASON.PUBLISHED };
  } catch {
    return { published: false, reason: PUBLISH_REASON.WRITE_FAILED };
  }
}
