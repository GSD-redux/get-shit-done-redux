/**
 * Planning Inspect Module — the schema-v1 canonical planning snapshot (#2790).
 *
 * `planning.inspect` is READ-ONLY: it opens `.planning/` documents and writes
 * nothing, anywhere, ever. Downstream harness UIs (gsd-code Phase 12, plan
 * mission-control) consume it instead of parsing ROADMAP/REQUIREMENTS/PLAN/
 * SUMMARY markdown a second time — gsd-core is the single source of `.planning/`
 * truth.
 *
 * COMPOSED, NOT RE-DERIVED. Every ADR-3180 §7 derivation arrives from its
 * declared owner: milestone identity and windowing from `getMilestoneInfo`
 * (§7.2) and phase enumeration from `listMilestonePhaseDirs` (§7.3), both via
 * `buildPlanningSnapshot`; phase completion from `isPhaseComplete` (§7.4,
 * disk-strict); live-plan counting from `scanPhasePlans` (§7.5); the
 * fraction→percent arithmetic from `clampPercent` (§7.6). Plan bodies come from
 * `parsePlanDocument` (`src/plan-document.cts`), requirement IDs from
 * `parseRequirements` (`src/gap-checker.cts`), UAT items from `parseUatItems`
 * (`src/uat.cts`). This module introduces no second answer to any of those
 * questions.
 *
 * WHY THIS DOES NOT SERIALIZE `PlanningSnapshot` DIRECTLY. `PlanningSnapshot`
 * is the §8.1 *diagnostic-rule subject* — explicitly additive and still growing
 * (4 fields at Phase 10, 20+ by Phase 12). schema-v1 is a frozen EXTERNAL
 * contract. Handing an internal, churning shape to external consumers is a
 * Hyrum's-Law break waiting to happen, so this module declares its own flat
 * schema and maps into it. Adding a field to `PlanningSnapshot` must never
 * change what `planning.inspect` emits.
 *
 * NEVER INFERS. Where evidence is absent or two sources disagree, the value is
 * `null` / `unknown` and a diagnostic names why. It is never reconciled, never
 * guessed, and never filled from a plausible default. Keys are ALWAYS present —
 * omitting a key on a non-answer is itself an observable a consumer would bind
 * to.
 *
 * NOT a diagnostic rule, and deliberately NOT registered in
 * `scripts/lint-planning-snapshot-bypass-drift.cjs`: that guard is
 * `DIAGNOSTIC_RULE_FUNCTIONS`-scoped and must be prunable to zero when #3309
 * lands. This is a query command.
 *
 * ADR-457 build-at-publish: source in src/planning-inspect.cts, compiled to
 * gsd-core/bin/lib/planning-inspect.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningSnapshotMod = require('./planning-snapshot.cjs');
const { buildPlanningSnapshot, worstScope } = planningSnapshotMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningPaths } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScan = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument, TASK_KIND, planIdFromFile } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gapCheckerMod = require('./gap-checker.cjs');
const { parseRequirements } = gapCheckerMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import uatMod = require('./uat.cjs');
const { parseUatItems, selectPhaseUatFiles } = uatMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLifecycleMod = require('./phase-lifecycle.cjs');
const { clampPercent } = phaseLifecycleMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { readVerificationStatus } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { phaseKeyFromDir, phaseKeyFromToken } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
import { stateFieldValue, stateCurrentPositionSlice } from './state-document.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownSectionizer = require('./markdown-sectionizer.cjs');
const { collectSection, iterateBullets } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownTable = require('./markdown-table.cjs');
const { parseMarkdownTable, matchTableSchema } = markdownTable;

/**
 * The wire schema version. A consumer MUST reject any value other than this
 * one rather than best-effort-parsing an unknown shape.
 */
const PLANNING_INSPECT_SCHEMA_VERSION = 1;

/**
 * Frozen diagnostic vocabulary. Adding a member is the repo's standard three
 * coordinated changes: this enum, the emitting site, and the test that locks
 * `Object.keys(INSPECT_DIAGNOSTIC).sort()`.
 */
const INSPECT_DIAGNOSTIC = Object.freeze({
  PLANNING_ROOT_ABSENT: 'planning_root_absent',
  ROADMAP_UNSCOPED: 'roadmap_unscoped',
  REQUIREMENTS_ABSENT: 'requirements_absent',
  REQUIREMENTS_UNREADABLE: 'requirements_unreadable',
  REQUIREMENT_DUPLICATE: 'requirement_duplicate',
  REQUIREMENT_UNMAPPED: 'requirement_unmapped',
  REQUIREMENT_PHASE_UNKNOWN: 'requirement_phase_unknown',
  REQUIREMENT_COMPLETION_UNKNOWN: 'requirement_completion_unknown',
  ORPHAN_PHASE_DIR: 'orphan_phase_dir',
  PHASE_SCOPE_DEGRADED: 'phase_scope_degraded',
  PLAN_UNREADABLE: 'plan_unreadable',
  SUMMARY_UNREADABLE: 'summary_unreadable',
  TASK_SHAPE_CHECKPOINT: 'task_shape_checkpoint',
  TASK_CHANGED_FILES_PLAN_SCOPED: 'task_changed_files_plan_scoped',
  TASK_CHANGED_FILES_CONFLICTING: 'task_changed_files_conflicting',
  UAT_ABSENT: 'uat_absent',
  UAT_UNREADABLE: 'uat_unreadable',
  PERCENT_WITHHELD: 'percent_withheld',
});

type InspectDiagnosticCode = (typeof INSPECT_DIAGNOSTIC)[keyof typeof INSPECT_DIAGNOSTIC];

/** Whether a task has a completion record. `unknown` is a first-class answer. */
const TASK_STATUS = Object.freeze({
  DONE: 'done',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
});

type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/**
 * How precisely a changed-file list is attributed. `plan_scoped` is the common
 * case and is NOT an error — SUMMARY.md's `## Files Created/Modified` is a
 * plan-level section, so spreading it across a plan's tasks would be inference.
 */
const PROVENANCE = Object.freeze({
  TASK_SCOPED: 'task_scoped',
  PLAN_SCOPED: 'plan_scoped',
  ABSENT: 'absent',
});

type Provenance = (typeof PROVENANCE)[keyof typeof PROVENANCE];

/** Whether planned and changed file sets agree. Never reconciled. */
const AGREEMENT = Object.freeze({
  AGREED: 'agreed',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
});

type Agreement = (typeof AGREEMENT)[keyof typeof AGREEMENT];

interface Diagnostic {
  code: InspectDiagnosticCode;
  subject: string;
  detail: string;
}

interface Fraction {
  completed: number;
  total: number;
  /** `null` whenever `scope !== complete` — ADR-3180 §7.6 rule 4. */
  percent: number | null;
  scope: Scope;
}

// ─── Small shared helpers ─────────────────────────────────────────────────────

/**
 * Path separators are normalised UNCONDITIONALLY, never via `path.sep` — a
 * backslash-bearing path can arrive on Linux too, so a platform-gated
 * normaliser leaves the non-Windows case untested and broken.
 */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Read a UTF-8 file, distinguishing absent from unreadable. */
function readDocument(filePath: string): { text: string | null; exists: boolean; readable: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: null, exists: false, readable: false };
  }
  // A directory, socket, or symlink resolving to a device in a document
  // position is not a document. Reject before any open (cf. #2378/#2383).
  if (!stat.isFile()) return { text: null, exists: true, readable: false };
  try {
    return { text: fs.readFileSync(filePath, 'utf-8'), exists: true, readable: true };
  } catch {
    return { text: null, exists: true, readable: false };
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// ─── Requirements ─────────────────────────────────────────────────────────────

interface RequirementRow {
  id: string;
  text: string | null;
  /** `true` / `false` from the checkbox, or `unknown` when no checkbox exists. */
  complete: boolean | 'unknown';
  /** Phase tokens the Traceability table maps this requirement to. */
  mappedPhases: string[];
  scope: Scope;
}

/**
 * Prefix-agnostic requirement-ID format shared with `parseRequirements`
 * (`src/gap-checker.cts`) — REQ-01, TST-01, BACK-07, INSP-04, etc. Bold
 * markers (`**ID**`) are optional decoration, matching how `gap-checker.cts`
 * pulls the ID out of a checkbox bullet's text.
 */
const ID_PATTERN = '[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+';

/**
 * A Traceability table's `Requirement` cell holds ONLY the ID (mod optional
 * bold + surrounding whitespace) — full-match, mirroring the pipe-bounded
 * anchoring the prior hand-rolled `ID_CELL` regex enforced.
 */
const CELL_ID_RE = new RegExp(`^\\*{0,2}(${ID_PATTERN})\\*{0,2}$`);

/**
 * A checkbox bullet's leading `**ID**` — prefix match only (no end anchor):
 * trailing prose (`: description`, ` some text`) is not required to match,
 * mirroring the prior hand-rolled `BULLET` regex.
 */
const BULLET_ID_RE = new RegExp(`^\\*{0,2}(${ID_PATTERN})\\*{0,2}`);

/**
 * Parse the `## Traceability` table's `Requirement | Phase | Status` rows via
 * the canonical `markdown-table` seam (ADR-2143) — never a hand-rolled
 * table/row regex. A missing/malformed section or table, or a header that
 * doesn't match the `RequirementsTraceability` schema, yields an EMPTY map: a
 * malformed table is a non-answer, and every requirement then falls through
 * to the caller's own `REQUIREMENT_UNMAPPED` diagnostic.
 */
function parseTraceability(reqMd: string): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const section = collectSection(reqMd, (h) => /^traceability$/i.test(h.text.trim()));
  if (!section) return byId;

  const parsed = parseMarkdownTable(section.body);
  if (!parsed.ok) return byId;

  const schema = matchTableSchema(parsed.value.columns);
  if (!schema || schema.id !== 'RequirementsTraceability') return byId;

  for (const row of parsed.value.rows) {
    const idMatch = CELL_ID_RE.exec((row.Requirement ?? '').trim());
    if (!idMatch) continue;
    const id = idMatch[1];
    // `Phase 1`, `1`, `Phase 1, Phase 2` — the token is what a consumer can
    // match against a phase id; the surrounding word is decoration. This is
    // value-level parsing of ONE already-addressed cell, not markdown parsing.
    const tokens = [...(row.Phase ?? '').matchAll(/\d+(?:\.\d+)*/g)].map((t) => t[0]);
    const existing = byId.get(id);
    if (existing) existing.push(...tokens);
    else byId.set(id, tokens);
  }
  return byId;
}

/**
 * Checkbox completion state per requirement ID, from the `- [x] **ID**`
 * bullets — driven by the canonical `iterateBullets` seam, same bold-ID
 * extraction style as `parseRequirements` (`src/gap-checker.cts`). A
 * requirement with no bullet has no checkbox answer — reported as `unknown`,
 * never defaulted to `false`.
 */
function parseCheckboxStates(reqMd: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const bullet of iterateBullets(reqMd)) {
    if (bullet.marker !== 'checkbox-checked' && bullet.marker !== 'checkbox-unchecked') continue;
    const m = BULLET_ID_RE.exec(bullet.text);
    if (!m) continue;
    // First occurrence wins, matching parseRequirements' own `seen` set.
    if (!states.has(m[1])) states.set(m[1], bullet.marker === 'checkbox-checked');
  }
  return states;
}

/** IDs appearing more than once in the checkbox bullets, in document order. */
function findDuplicateIds(reqMd: string): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const bullet of iterateBullets(reqMd)) {
    if (bullet.marker !== 'checkbox-checked' && bullet.marker !== 'checkbox-unchecked') continue;
    const m = BULLET_ID_RE.exec(bullet.text);
    if (!m) continue;
    if (seen.has(m[1])) dupes.push(m[1]);
    else seen.add(m[1]);
  }
  return dupes;
}

function buildRequirements(
  requirementsPath: string,
  knownPhaseKeys: Set<string>,
  diagnostics: Diagnostic[],
): { rows: RequirementRow[]; scope: Scope } {
  const doc = readDocument(requirementsPath);
  if (!doc.exists) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.REQUIREMENTS_ABSENT,
      subject: toPosix(requirementsPath),
      detail: 'REQUIREMENTS.md does not exist; no requirement rows are available.',
    });
    return { rows: [], scope: SCOPE.UNSCOPED };
  }
  if (!doc.readable || doc.text === null) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.REQUIREMENTS_UNREADABLE,
      subject: toPosix(requirementsPath),
      detail: 'REQUIREMENTS.md exists but could not be read; zero rows is not a reliable answer.',
    });
    return { rows: [], scope: SCOPE.UNREADABLE };
  }

  const reqMd = doc.text;
  const items = parseRequirements(reqMd);
  const traceability = parseTraceability(reqMd);
  const checkboxes = parseCheckboxStates(reqMd);

  for (const dupe of findDuplicateIds(reqMd)) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.REQUIREMENT_DUPLICATE,
      subject: dupe,
      detail: 'Requirement ID appears more than once; the first occurrence is authoritative.',
    });
  }

  const rows: RequirementRow[] = items.map((item: { id: string; text: string }) => {
    const mappedPhases = sortedUnique(traceability.get(item.id) ?? []);
    const hasCheckbox = checkboxes.has(item.id);
    const complete: boolean | 'unknown' = hasCheckbox ? (checkboxes.get(item.id) as boolean) : 'unknown';

    if (mappedPhases.length === 0) {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.REQUIREMENT_UNMAPPED,
        subject: item.id,
        detail: 'No Traceability row maps this requirement to a phase.',
      });
    }
    for (const token of mappedPhases) {
      // `phaseKeyFromDir` and `phaseKeyFromToken` are the canonical pair for
      // phase-IDENTITY equality: both map a directory name and a document
      // token onto the same canonical zero-padded key, so `01-auth` /
      // `1-auth` / `Phase 1` / `Phase 01` are recognized as one phase, and
      // decimal phases (`1.1`) compare correctly. A raw string compare gets
      // the padding case wrong; `phaseTokenMatches` is the wrong primitive
      // here too — it is a FILE-MEMBERSHIP predicate (#3511) for aggregate
      // `*-UAT.md` / `*-VERIFICATION.md` scans, not a phase-identity equality
      // test, and is unreliable for decimal phases.
      if (!knownPhaseKeys.has(phaseKeyFromToken(token))) {
        diagnostics.push({
          code: INSPECT_DIAGNOSTIC.REQUIREMENT_PHASE_UNKNOWN,
          subject: `${item.id}->${token}`,
          detail: 'Traceability maps this requirement to a phase that is not present on disk.',
        });
      }
    }
    if (complete === 'unknown') {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.REQUIREMENT_COMPLETION_UNKNOWN,
        subject: item.id,
        detail: 'Requirement has no checkbox bullet; completion is unknown, not incomplete.',
      });
    }

    return {
      id: item.id,
      text: item.text && item.text.length > 0 ? item.text : null,
      complete,
      mappedPhases,
      scope: SCOPE.COMPLETE,
    };
  });

  return { rows, scope: SCOPE.COMPLETE };
}

// ─── Summary provenance ───────────────────────────────────────────────────────

interface SummaryProvenance {
  /** `## Files Created/Modified` — a PLAN-level list. Never attributed to a task. */
  planFiles: string[];
  /** Task index -> files, from a deviation block naming `Found during: Task N`. */
  byTask: Map<number, string[]>;
}

/**
 * Parse a SUMMARY.md body for file provenance.
 *
 * Two DIFFERENT scopes live in this document and conflating them is the whole
 * hazard: `## Files Created/Modified` describes the PLAN, while a deviation
 * block's `**Files modified:**` is attributed to the task its `**Found during:**
 * Task N` line names. Only the latter is task-scoped.
 */
function parseSummaryProvenance(content: string): SummaryProvenance {
  const planFiles: string[] = [];
  const byTask = new Map<number, string[]>();

  // `## Files Created/Modified` — a PLAN-level bullet list. Bounded to the
  // section body via collectSection + iterateBullets; absent is not an error.
  const filesSection = collectSection(content, (h) => /^files\s+created\/modified\s*$/i.test(h.text.trim()));
  if (filesSection) {
    for (const bullet of iterateBullets(filesSection.body)) {
      // `- \`path/to/file.ts\` - What it does`
      const m = /^`([^`]+)`/.exec(bullet.text);
      if (m) planFiles.push(m[1].trim());
    }
  }

  // `## Deviations from Plan` (also matches the `(Auto-fixed)` variant) — the
  // `**Found during:** Task N` / `**Files modified:**` scan is a regex
  // CONFINED to this already-collected section body (ADR-2143 §4 sanctioned
  // pattern), never a document-wide heading walk.
  const deviationsSection = collectSection(content, (h) => /^deviations\s+from\s+plan/i.test(h.text.trim()));
  if (deviationsSection) {
    let currentTask: number | null = null;
    for (const line of deviationsSection.body.split(/\r?\n/)) {
      const foundDuring = /\*\*Found during:\*\*\s*Task\s*(\d+)/i.exec(line);
      if (foundDuring) {
        currentTask = parseInt(foundDuring[1], 10);
        continue;
      }

      const filesModified = /\*\*Files modified:\*\*\s*(.+)$/i.exec(line);
      if (filesModified && currentTask !== null) {
        const files = filesModified[1]
          .split(',')
          .map((f) => f.trim().replace(/^`|`$/g, ''))
          .filter((f) => f.length > 0);
        const existing = byTask.get(currentTask);
        if (existing) existing.push(...files);
        else byTask.set(currentTask, files);
      }
    }
  }

  return { planFiles: sortedUnique(planFiles), byTask };
}

// ─── Plans and tasks ──────────────────────────────────────────────────────────

interface TaskRow {
  index: number;
  kind: string;
  type: string | null;
  name: string | null;
  plannedFiles: string[];
  acceptanceCriteria: string[];
  done: string | null;
  /** `null` unless the SUMMARY attributes files to THIS task. */
  changedFiles: string[] | null;
  provenance: Provenance;
  agreement: Agreement;
  status: TaskStatus;
}

interface PlanRow {
  id: string;
  file: string;
  superseded: boolean;
  objective: string | null;
  wave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  agentHint: string | null;
  /** From the plan's own frontmatter `files_modified`. */
  plannedFiles: string[];
  /** Plan-scoped `## Files Created/Modified`. `null` when no SUMMARY exists. */
  changedFiles: string[] | null;
  hasSummary: boolean;
  tasks: TaskRow[];
  scope: Scope;
}

/** Pair a plan file with its SUMMARY by the canonical id embedded in the name. */
function summaryForPlan(planFile: string, summaryFiles: string[]): string | null {
  const base = path.basename(planFile);
  const key = base.replace(/-?PLAN/i, '').replace(/\.md$/i, '');
  const dir = planFile.includes('/') ? planFile.slice(0, planFile.lastIndexOf('/') + 1) : '';
  for (const candidate of summaryFiles) {
    if (!candidate.startsWith(dir)) continue;
    const candidateKey = path.basename(candidate).replace(/-?SUMMARY/i, '').replace(/\.md$/i, '');
    if (candidateKey === key) return candidate;
  }
  return null;
}

function buildTaskRows(
  planFile: string,
  parsed: ReturnType<typeof parsePlanDocument>,
  provenance: SummaryProvenance | null,
  diagnostics: Diagnostic[],
): TaskRow[] {
  return parsed.tasks.map((task) => {
    if (task.kind === TASK_KIND.CHECKPOINT) {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.TASK_SHAPE_CHECKPOINT,
        subject: `${toPosix(planFile)}#${task.index}`,
        detail: 'Checkpoint task: the grammar carries no name/files/acceptance elements.',
      });
    }

    if (provenance === null) {
      return {
        index: task.index,
        kind: task.kind,
        type: task.type,
        name: task.name,
        plannedFiles: task.plannedFiles,
        acceptanceCriteria: task.acceptanceCriteria,
        done: task.done,
        changedFiles: null,
        provenance: PROVENANCE.ABSENT,
        agreement: AGREEMENT.UNKNOWN,
        status: TASK_STATUS.PENDING,
      };
    }

    const attributed = provenance.byTask.get(task.index);
    if (attributed === undefined) {
      // A SUMMARY exists but says nothing about THIS task. The plan-level file
      // list is not evidence about a task — attributing it would be inference.
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.TASK_CHANGED_FILES_PLAN_SCOPED,
        subject: `${toPosix(planFile)}#${task.index}`,
        detail: 'SUMMARY carries only a plan-level file list; task-scoped changed files are unknown.',
      });
      return {
        index: task.index,
        kind: task.kind,
        type: task.type,
        name: task.name,
        plannedFiles: task.plannedFiles,
        acceptanceCriteria: task.acceptanceCriteria,
        done: task.done,
        changedFiles: null,
        provenance: PROVENANCE.PLAN_SCOPED,
        agreement: AGREEMENT.UNKNOWN,
        status: TASK_STATUS.UNKNOWN,
      };
    }

    const changed = sortedUnique(attributed);
    const planned = sortedUnique(task.plannedFiles);
    let agreement: Agreement = AGREEMENT.UNKNOWN;
    if (planned.length > 0) {
      const same = planned.length === changed.length && planned.every((f, i) => f === changed[i]);
      agreement = same ? AGREEMENT.AGREED : AGREEMENT.CONFLICTING;
      if (!same) {
        diagnostics.push({
          code: INSPECT_DIAGNOSTIC.TASK_CHANGED_FILES_CONFLICTING,
          subject: `${toPosix(planFile)}#${task.index}`,
          detail: 'Planned and changed file sets disagree; both are reported verbatim, unreconciled.',
        });
      }
    }

    return {
      index: task.index,
      kind: task.kind,
      type: task.type,
      name: task.name,
      plannedFiles: task.plannedFiles,
      acceptanceCriteria: task.acceptanceCriteria,
      done: task.done,
      changedFiles: changed,
      provenance: PROVENANCE.TASK_SCOPED,
      agreement,
      status: TASK_STATUS.DONE,
    };
  });
}

function buildPlanRows(phaseDir: string, diagnostics: Diagnostic[]): { rows: PlanRow[]; scope: Scope } {
  const scan = planScan(phaseDir);
  const supersededSet = new Set(
    scan.allPlanFiles.filter((f: string) => !scan.planFiles.includes(f)),
  );

  const rows: PlanRow[] = scan.allPlanFiles.map((planFile: string) => {
    const doc = readDocument(path.join(phaseDir, planFile));
    if (doc.text === null) {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.PLAN_UNREADABLE,
        subject: toPosix(planFile),
        detail: 'Plan file could not be read; its body is unknown. Sibling plans are unaffected.',
      });
      return {
        id: planIdFromFile(planFile),
        file: toPosix(planFile),
        superseded: supersededSet.has(planFile),
        objective: null,
        wave: null,
        dependsOn: [],
        autonomous: true,
        agentHint: null,
        plannedFiles: [],
        changedFiles: null,
        hasSummary: false,
        tasks: [],
        scope: SCOPE.UNREADABLE,
      };
    }

    const parsed = parsePlanDocument(doc.text);
    const summaryFile = summaryForPlan(planFile, scan.summaryFiles);
    let provenance: SummaryProvenance | null = null;
    if (summaryFile !== null) {
      const summaryDoc = readDocument(path.join(phaseDir, summaryFile));
      if (summaryDoc.text === null) {
        diagnostics.push({
          code: INSPECT_DIAGNOSTIC.SUMMARY_UNREADABLE,
          subject: toPosix(summaryFile),
          detail: 'Summary file could not be read; file provenance for this plan is unknown.',
        });
      } else {
        provenance = parseSummaryProvenance(summaryDoc.text);
      }
    }

    return {
      id: planIdFromFile(planFile),
      file: toPosix(planFile),
      superseded: supersededSet.has(planFile),
      objective: parsed.objective,
      wave: parsed.declaredWave,
      dependsOn: parsed.dependsOn,
      autonomous: parsed.autonomous,
      agentHint: parsed.agentHint,
      plannedFiles: parsed.filesModified,
      changedFiles: provenance === null ? null : provenance.planFiles,
      hasSummary: summaryFile !== null,
      tasks: buildTaskRows(planFile, parsed, provenance, diagnostics),
      scope: SCOPE.COMPLETE,
    };
  });

  return { rows, scope: scan.scope };
}

// ─── UAT ──────────────────────────────────────────────────────────────────────

function buildUatRows(
  phasesDir: string,
  phaseDirName: string,
  diagnostics: Diagnostic[],
): { items: unknown[]; scope: Scope } {
  const phaseDir = path.join(phasesDir, phaseDirName);
  let entries: string[];
  try {
    entries = fs.readdirSync(phaseDir);
  } catch {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.UAT_UNREADABLE,
      subject: phaseDirName,
      detail: 'Phase directory could not be listed; UAT presence is unknown.',
    });
    return { items: [], scope: SCOPE.UNREADABLE };
  }

  const uatFiles = selectPhaseUatFiles(entries, phaseDirName);
  if (uatFiles.length === 0) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.UAT_ABSENT,
      subject: phaseDirName,
      detail: 'No UAT document for this phase. This does not affect phase acceptance.',
    });
    return { items: [], scope: SCOPE.COMPLETE };
  }

  const items: unknown[] = [];
  let scope: Scope = SCOPE.COMPLETE;
  for (const file of uatFiles) {
    const doc = readDocument(path.join(phaseDir, file));
    if (doc.text === null) {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.UAT_UNREADABLE,
        subject: `${phaseDirName}/${file}`,
        detail: 'UAT document exists but could not be read.',
      });
      scope = SCOPE.TRUNCATED;
      continue;
    }
    items.push(...parseUatItems(doc.text));
  }
  return { items, scope };
}

// ─── Progress ─────────────────────────────────────────────────────────────────

/**
 * ADR-3180 §7.6: the arithmetic is `clampPercent`'s alone (rule 1), a
 * non-positive denominator is 0 not 100 (rule 2), numerator and denominator
 * come from one scoped set (rule 3), and a scope other than COMPLETE renders NO
 * percentage at all (rule 4).
 */
function makeFraction(completed: number, total: number, scope: Scope, subject: string, diagnostics: Diagnostic[]): Fraction {
  if (scope !== SCOPE.COMPLETE) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.PERCENT_WITHHELD,
      subject,
      detail: `Scope is "${scope}"; a percentage derived from an incomplete read would be a confident wrong answer.`,
    });
    return { completed, total, percent: null, scope };
  }
  return { completed, total, percent: clampPercent(completed, total), scope };
}

/**
 * The active plan position, from STATE.md's `## Current Position` block.
 *
 * ADR-3180 §7.7: `stateFieldValue` owns the #1760 frontmatter-then-body
 * fallback ladder — this composes it, it does not re-derive it. The section
 * slice is load-bearing: `Plan:` canonically lives under `## Current Position`,
 * and a whole-document search would match a historical `Plan:` line in an
 * archive section instead (#2956). A missing section is therefore reported as
 * UNSCOPED rather than silently widened to the whole body.
 */
function buildActivePlan(statePath: string): { value: string | null; scope: Scope } {
  const doc = readDocument(statePath);
  if (!doc.exists) return { value: null, scope: SCOPE.UNSCOPED };
  if (!doc.readable || doc.text === null) return { value: null, scope: SCOPE.UNREADABLE };
  const fm = extractFrontmatter(doc.text, statePath) as Record<string, unknown>;
  const body = stripFrontmatter(doc.text);
  const slice = stateCurrentPositionSlice(body);
  return stateFieldValue(fm, slice ?? body, 'plan', 'Plan', {
    scope: slice === null ? SCOPE.UNSCOPED : SCOPE.COMPLETE,
  });
}

// ─── Entry points ─────────────────────────────────────────────────────────────

function buildPlanningInspect(cwd: string): Record<string, unknown> {
  const diagnostics: Diagnostic[] = [];
  const paths = planningPaths(cwd);
  const planningExists = fs.existsSync(paths.planning);
  if (!planningExists) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.PLANNING_ROOT_ABSENT,
      subject: toPosix(paths.planning),
      detail: 'No .planning/ directory; every section below is an empty non-answer, not an empty project.',
    });
  }

  const snapshot = buildPlanningSnapshot(cwd);

  if (snapshot.milestone.scope !== SCOPE.COMPLETE) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.ROADMAP_UNSCOPED,
      subject: toPosix(paths.roadmap),
      detail: `Milestone identity scope is "${snapshot.milestone.scope}"; no version is invented to stand in for it.`,
    });
  }

  const milestoneValue = snapshot.milestone.value as { version?: string; name?: string | null } | null;

  // Phase rows come from the WINDOWED set (this milestone's phases). A dir on
  // disk that the roadmap never declares is an orphan, reported separately —
  // it is not silently promoted into `phases`, and it is not silently dropped.
  const windowed: string[] = snapshot.phaseDirs.value;
  const windowedSet = new Set(windowed);
  const orphans = snapshot.allPhaseDirNames.value
    .filter((dir) => !windowedSet.has(dir))
    .sort();
  for (const orphan of orphans) {
    diagnostics.push({
      code: INSPECT_DIAGNOSTIC.ORPHAN_PHASE_DIR,
      subject: orphan,
      detail: 'Phase directory exists on disk but is not declared in the current milestone window.',
    });
  }

  const checkboxes = snapshot.roadmapPhaseCheckboxes.value;
  // ROADMAP checkboxes arrive keyed by the BARE phase token the ROADMAP prose
  // carries ("1"), while phase rows are keyed by on-disk directory name
  // ("01-auth"). Comparing them raw makes this field null for every
  // real-world directory — an evidence channel that silently never fires.
  // Both sides go through the phase-id owners so "1", "01" and "01-auth" are
  // one phase.
  const checkboxByPhaseKey = new Map<string, boolean>();
  for (const [token, ticked] of Object.entries(checkboxes)) {
    checkboxByPhaseKey.set(phaseKeyFromToken(token), ticked);
  }
  const phaseSnapshots = snapshot.phases.value as {
    dir: string;
    complete: boolean;
    verificationStatus: string;
    planCount: number;
    summaryCount: number;
    scope: Scope;
  }[];

  // Canonical per-directory identity keys (`phase-id.cts`'s
  // `phaseKeyFromDir`), not a raw regex scrape — this is the set
  // `buildRequirements` below matches Traceability tokens against via
  // `phaseKeyFromToken`.
  const knownPhaseKeys: Set<string> = new Set(windowed.map((dir) => phaseKeyFromDir(dir)));

  const phaseRows = phaseSnapshots.map((phase) => {
    const phaseDir = path.join(paths.phases, phase.dir);
    const plans = buildPlanRows(phaseDir, diagnostics);
    const uat = buildUatRows(paths.phases, phase.dir, diagnostics);
    const verification = readVerificationStatus(phaseDir);
    const folded = worstScope(phase.scope, plans.scope, uat.scope);
    if (folded !== SCOPE.COMPLETE) {
      diagnostics.push({
        code: INSPECT_DIAGNOSTIC.PHASE_SCOPE_DEGRADED,
        subject: phase.dir,
        detail: `Phase evidence is incomplete (scope "${folded}").`,
      });
    }

    const token = /^(\d+(?:\.\d+)*)/.exec(phase.dir);
    return {
      dir: phase.dir,
      phase_id: token ? token[1] : null,
      complete: phase.complete,
      // The three evidence sources are reported SIDE BY SIDE and never folded
      // into one verdict — folding them is precisely the confidently-wrong
      // composite ADR-3180 exists to remove.
      verification: {
        status: verification.status,
        next_action: verification.next_action ?? null,
      },
      roadmap_acceptance: {
        checkbox: checkboxByPhaseKey.has(phaseKeyFromDir(phase.dir))
          ? (checkboxByPhaseKey.get(phaseKeyFromDir(phase.dir)) as boolean)
          : null,
        // ADR-3180 §7.4: a ticked checkbox is a human annotation with no
        // machine authority. Stated in the payload so a consumer cannot
        // mistake it for a completion signal.
        authoritative: false,
      },
      uat: { unresolved: uat.items, scope: uat.scope },
      plan_count: phase.planCount,
      summary_count: phase.summaryCount,
      plans: plans.rows,
      scope: folded,
    };
  });

  const requirements = buildRequirements(paths.requirements, knownPhaseKeys, diagnostics);

  const phaseScope = worstScope(
    snapshot.phaseDirs.scope,
    snapshot.phases.scope,
    ...phaseRows.map((p) => p.scope),
  );
  const acceptedPhases = makeFraction(
    phaseRows.filter((p) => p.complete).length,
    phaseRows.length,
    phaseScope,
    'progress.accepted_phases',
    diagnostics,
  );
  const completedPlans = makeFraction(
    phaseRows.reduce((sum, p) => sum + p.summary_count, 0),
    phaseRows.reduce((sum, p) => sum + p.plan_count, 0),
    phaseScope,
    'progress.completed_plans',
    diagnostics,
  );

  return {
    schema_version: PLANNING_INSPECT_SCHEMA_VERSION,
    generated_from: {
      cwd: toPosix(cwd),
      planning_root: planningExists ? toPosix(paths.planning) : null,
    },
    milestone: {
      version: milestoneValue && milestoneValue.version ? milestoneValue.version : null,
      name: milestoneValue && milestoneValue.name ? milestoneValue.name : null,
      scope: snapshot.milestone.scope,
    },
    // Three DISTINCT STATE.md facts, each from its own source. Collapsing any
    // two of them is the confidently-wrong composite this schema exists to
    // avoid: `Status:` is a lifecycle label, `Plan:` is a position.
    active: {
      phase: { value: snapshot.currentPhaseLabel.value, scope: snapshot.currentPhaseLabel.scope },
      plan: buildActivePlan(paths.state),
      status: { value: snapshot.stateStatus.value, scope: snapshot.stateStatus.scope },
    },
    phases: phaseRows,
    orphan_phase_dirs: orphans,
    requirements: requirements.rows,
    progress: {
      accepted_phases: acceptedPhases,
      completed_plans: completedPlans,
    },
    diagnostics,
  };
}

/**
 * `planning inspect` — emit the schema-v1 snapshot.
 *
 * `output()` is the spill seam: a payload over 50 KB is written to a tmpfile and
 * returned as `@file:<path>`, which `gsd-tools`' `resolveAtFileOutput` resolves
 * transparently on stdout. Bypassing `output()` would lose that for free.
 */
function cmdPlanningInspect(cwd: string, raw: boolean): void {
  output(buildPlanningInspect(cwd), raw);
}

const planningInspect = {
  PLANNING_INSPECT_SCHEMA_VERSION,
  INSPECT_DIAGNOSTIC,
  TASK_STATUS,
  PROVENANCE,
  AGREEMENT,
  buildPlanningInspect,
  cmdPlanningInspect,
};

export = planningInspect;
