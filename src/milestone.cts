/**
 * Milestone — Milestone and requirements lifecycle operations.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/milestone.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the same
 * require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir, execGit, retryRenameSync } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { writeSetComplete } from './write-set.cjs';
import type { WriteSet } from './write-set.cjs';
import { updateTableCell, resetQuickTaskRows, QUICK_TASKS_SECTION_ABSENT } from './markdown-table.cjs';
import { requireSafePath } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- audit.cjs is an export= CommonJS module
import auditMod = require('./audit.cjs');
const { resolveQuickTaskSummaryFile } = auditMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { normalizePhaseName, matchPhaseDirs, PHASE_NUMBER_TOKEN_SOURCE, isSentinelPhaseId } = phaseIdMod;
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const {
  getMilestonePhaseFilter,
  extractCurrentMilestone,
  getMilestoneInfo,
  sliceMilestoneWindow,
} = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { extractOneLinerFromBody, countMatchedSummaries } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorMod;
const { planningPaths } = planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
// ADR-3408 §8.3 / #3469: `writeStateMd` gets sync and NO preservation — the
// same #3374-shaped exposure the milestone-complete write used to carry (a
// stale body value silently clobbering fresher frontmatter, with no
// divergence signal). Routed through the single write-seam composition
// (`syncAndPreserveStateMd`) instead, under `withStateLock` — see
// `cmdMilestoneComplete`'s own STATE.md-update block for the full rationale.
const { syncAndPreserveStateMd, withStateLock, readModifyWriteStateMd } = stateMod;

// #2288 security: a milestone version label becomes a filesystem directory
// component (`milestones/<label>-phases/`) into which phase directories are
// MOVED. Any label used as a path segment must be a safe version token —
// letters/digits/'.'/'-'/'_', leading alphanumeric, no path separators and no
// `..` (the leading-alphanumeric anchor rejects a bare `..`). This gates both
// the caller-supplied `--archive-version` override and the STATE.md-derived
// live-read value, so a crafted value cannot escape `.planning/milestones/`.
const ARCHIVE_VERSION_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface MilestoneCompleteOptions {
  name?: string;
  force?: boolean;
  archivePhases?: boolean;
  dryRun?: boolean;
  // #2142: opt-in quick-task archival. Default OFF (unlike archivePhases,
  // which is default-ON since #1871) — acceptance criterion 1 is explicit
  // that Skip/absent must preserve today's behavior. Do NOT mirror
  // archivePhases' inverted `--no-archive-phases` shape.
  archiveQuick?: boolean;
}

/**
 * Scope an `updateTableCell` call to the `## Traceability` (or
 * `## Traceability Status`) heading's own section — up to the next H1/H2
 * heading — instead of handing it the WHOLE REQUIREMENTS.md content.
 *
 * F1 (#2245 review, BLOCKER): `updateTableCell` binds to the FIRST GFM table
 * found in whatever text it is given. The shipped requirements template
 * (gsd-core/templates/requirements.md) puts an `## Out of Scope` table
 * (`| Feature | Reason |`, no `Status` column) BEFORE `## Traceability` — so
 * an unscoped whole-file call targets the Out-of-Scope table instead, fails
 * with `{ok:false, reason:'unknown column: Status'}`, and the real
 * Traceability row is never flipped, while the checkbox surface still flips
 * and the command reports success (the #2140 silent-divergence class one
 * level deeper). Mirrors phase.cts's `editProgressHeadingSlice` scoping of
 * `## Progress` writes to that heading's own slice.
 *
 * Falls back to running `updateTableCell` against the whole `text` when no
 * `## Traceability` heading exists — matching the previous (unscoped)
 * behaviour for a REQUIREMENTS.md whose traceability table sits under some
 * other heading, or with no heading at all (never worse than before this fix).
 */
function updateTraceabilityCell(
  text: string,
  match: (row: Record<string, string>, index: number) => boolean,
  column: string,
  newValue: string | ((current: string) => string),
): ReturnType<typeof updateTableCell> {
  const headingMatch = text.match(/^##[ \t]+Traceability(?:[ \t]+Status)?\b/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return updateTableCell(text, match, column, newValue);
  }
  const headingOffset = headingMatch.index;
  const before = text.slice(0, headingOffset);
  const fromHeading = text.slice(headingOffset);
  const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
  const after = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

  const result = updateTableCell(scoped, match, column, newValue);
  if (!result.ok) return result;
  return { ok: true, value: before + result.value + after };
}

function cmdRequirementsMarkComplete(cwd: string, reqIdsRaw: string[], raw: boolean): void {
  if (!reqIdsRaw || reqIdsRaw.length === 0) {
    error('requirement IDs required. Usage: requirements mark-complete REQ-01,REQ-02 or REQ-01 REQ-02');
  }

  // Accept comma-separated, space-separated, or bracket-wrapped: [REQ-01, REQ-02]
  const reqIds = reqIdsRaw
    .join(' ')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (reqIds.length === 0) {
    error('no valid requirement IDs found');
  }

  const reqPath = planningPaths(cwd).requirements;
  if (!fs.existsSync(reqPath)) {
    output({ updated: false, reason: 'REQUIREMENTS.md not found', ids: reqIds }, raw, 'no requirements file');
    return;
  }

  let reqContent = fs.readFileSync(reqPath, 'utf-8');
  const updated: string[] = [];
  const alreadyComplete: string[] = [];
  const notFound: string[] = [];
  // #2140: IDs reconciled on the checkbox surface only — a traceability table
  // exists but has no row for the ID. Without this bucket the payload for a
  // partial reconcile is byte-identical to a full one, and audit-milestone (which
  // reads the table) still sees Pending while the CLI reported success.
  const tableUnmatched: string[] = [];

  // A traceability table is present if the file has a requirement-ID column
  // header: "Requirement", "Requirement ID", or "REQ-ID" (#2769/#2203) — kept
  // in sync with the positional first-cell rowMatch/hasRow below so a
  // REQ-ID-headed table (the real-world format) participates in the
  // write-set and the #2140 drift check below, not just the "Requirement"
  // case. A REQUIREMENTS.md with no such table is legitimate (mid-roadmap),
  // so a missing row only counts as drift when a table actually exists.
  const hasTable = /^\|\s*(?:Requirement(?:\s*ID)?|REQ[-\s]?ID)\s*\|/im.test(reqContent);

  // ADR-2143 §6 per-surface write-set, tracked PER requirement ID: a
  // multi-ID batch must not OR one ID's surface outcome into another's —
  // that is the exact #2140 class one level up (an ID whose traceability
  // row is absent/unmatched must not have its partial write masked by a
  // different ID in the same invocation that fully reconciled). Reported
  // additively as `write_set` below — it does not change the existing
  // marked_complete/already_complete/not_found/table_unmatched/updated
  // computation, which stays byte-for-behaviour identical (#2140's tactical
  // fix already surfaces the checkbox-only-partial-write case via
  // table_unmatched; this only adds the structured ADR-2143 shape on top).
  const writeSet: WriteSet = [];

  for (const reqId of reqIds) {
    const reqEscaped = escapeRegex(reqId);

    // Surface 1 — the checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**
    // Use replace() + compare to avoid the test()+replace() global regex
    // lastIndex bug where test() advances state and replace() misses matches.
    // (#2788 defect 2: the flip is CONDITIONAL — when a traceability row EXISTS
    // for this ID but its Status write is rejected, the checkbox must NOT flip,
    // so the two surfaces cannot silently diverge. The row-write outcome below
    // gates whether the flip is kept.)
    const checkboxPattern = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
    const beforeCheckbox = reqContent;
    const afterCheckbox = reqContent.replace(checkboxPattern, '$1x$2');
    const checkboxFlipped = afterCheckbox !== beforeCheckbox;
    if (checkboxFlipped) reqContent = afterCheckbox;

    // Surface 2 — the traceability row: | <REQ-ID> | Phase N | Pending | → ... Complete |
    // via the markdown-table seam (ADR-2143 §7) — supersedes the prior ordinal
    // regex. Match the row by its FIRST cell's value (the requirement-ID column)
    // regardless of that column's HEADER name — real tables head it `REQ-ID`,
    // others `Requirement` (#2769/#2203); this mirrors the prior regex's first-cell
    // `\|\s*<id>\s*\|` anchor. Object.values(row) is in header order so [0] is the
    // first column. Case-insensitive (mirrors the prior regex's 'i' flag).
    const rowMatch = (row: Record<string, string>): boolean =>
      (Object.values(row)[0] ?? '').trim().toLowerCase() === reqId.toLowerCase();
    // Ragged-tolerant (#2245 Blocker 2): drive the write purely off
    // updateTableCell's own tolerant row scan — a DIFFERENT requirement's row
    // elsewhere in the same table having a mismatched cell count must never
    // silently no-op THIS requirement's write. The "only flip Pending ->
    // Complete" gate is folded into the newValue callback so one
    // updateTableCell call both probes the current value and writes.
    let tableHit = false;
    const tableUpdate = updateTraceabilityCell(reqContent, rowMatch, 'Status', (current) => {
      // #2788: accept `Gaps Found` as a forward input too — `revert-phase` (the
      // documented gaps_found response) leaves a row stranded at Gaps Found with
      // no inverse; a genuinely-satisfied requirement must be able to reach
      // Complete again via mark-complete, or the milestone is blocked forever.
      if (/^(pending|gaps found)$/i.test(current.trim())) {
        tableHit = true;
        return ' Complete ';
      }
      return current;
    });
    if (tableUpdate.ok) {
      reqContent = tableUpdate.value;
    }

    // #2788 defect 2: if a row EXISTS for this ID but its Status write was
    // rejected (e.g. the row reads `Blocked`, which mark-complete does not
    // accept), roll the checkbox back so the checkbox and the row cannot
    // silently diverge. The checkbox and the row are two representations of the
    // same fact; flipping one while the other rejects the write is the lie.
    let checkboxHit = checkboxFlipped;
    const rowExistsProbe = tableUpdate;  // ok === a row matched (probes existence)
    if (checkboxFlipped && rowExistsProbe.ok && !tableHit) {
      reqContent = beforeCheckbox;
      checkboxHit = false;
    }

    // ADR-2143 §6 per-ID write-set entries: this ID's checkbox surface is
    // always tracked; the traceability surface is tracked only when the file
    // has a traceability table at all (same `hasTable` gate the existing
    // required-surface logic below uses) — omitted entirely, not a false
    // `applied:false`, when no table is required of this file.
    writeSet.push({ requirement: reqId, surface: 'checkbox', applied: checkboxHit });
    if (hasTable) {
      writeSet.push({ requirement: reqId, surface: 'traceability', applied: tableHit });
    }

    // Coverage of the traceability surface for this ID (computed after any flip).
    // hasRow keys on the ID's FIRST cell (the requirement-ID column, by position —
    // see rowMatch above) so a bare mention of the ID in a non-traceability table
    // does not masquerade as a real row.
    // Ragged-tolerant (#2245 Blocker 2): same reasoning as the write above — a
    // sibling row's raggedness must not blind this classification to a row
    // that genuinely exists. Probe via a no-op updateTableCell write (its own
    // tolerant scan) instead of findTableWithColumns (whole-table parse gate).
    let currentStatusCell = '';
    const statusProbe = updateTraceabilityCell(reqContent, rowMatch, 'Status', (current) => {
      currentStatusCell = current;
      return current;
    });
    const hasRow = statusProbe.ok;
    const doneCheckbox = new RegExp(`-\\s*\\[x\\]\\s*\\*\\*${reqEscaped}\\*\\*`, 'i').test(reqContent);
    const doneTable = Boolean(hasRow && /^complete$/i.test(currentStatusCell.trim()));

    // #2788 defect 2: when a traceability table exists AND this ID has a row in
    // it, `updated`/`marked_complete` must reflect the ROW moving, not a
    // checkbox-only flip. Otherwise (`table_unmatched` — no row for this ID, or
    // no table at all) the checkbox flip is a legitimate partial reconcile / the
    // sole completion surface, so the #2140 OR semantics are preserved.
    const rowExists = hasTable && hasRow;
    const idUpdated = rowExists ? tableHit : (checkboxHit || tableHit);
    if (idUpdated) {
      updated.push(reqId);
    } else if (doneTable || (doneCheckbox && !hasTable)) {
      // Fully reconciled: the table row is Complete, OR the checkbox is done and
      // there is no table to reconcile against. (A [x] checkbox with a Pending or
      // absent row is NOT fully reconciled when a table exists — #2140.)
      alreadyComplete.push(reqId);
    } else if (!doneCheckbox && !doneTable) {
      notFound.push(reqId);
    }
    // else: doneCheckbox && hasTable && !doneTable — partially reconciled. It is
    // neither updated, already_complete, nor not_found; the table_unmatched bucket
    // below carries the truthful partial-reconcile signal.

    // Surface traceability drift: checkbox reconciled (this run or before) but the
    // table has no row for this ID. This is what makes a partial reconcile
    // distinguishable from a full one (#2140).
    if (hasTable && doneCheckbox && !hasRow) {
      tableUnmatched.push(reqId);
    }
  }

  if (updated.length > 0) {
    platformWriteSync(reqPath, reqContent);
  }

  // ADR-2143 §6: `writeSet` above already carries one WriteOutcome per
  // (requirement, surface) this invocation could have written to — per ID,
  // not ORed across the batch. `write_set` and `write_set_complete` are
  // additive: they do not replace or gate `updated` / `marked_complete` /
  // `already_complete` / `not_found` / `table_unmatched`, which remain
  // computed exactly as before (see #2140 note above — that fix already
  // surfaces a checkbox-only partial write via `table_unmatched`;
  // `write_set_complete` is a structured, ADR-2143-shaped read of the SAME
  // per-surface, per-ID facts, `false` if ANY id's ANY required surface did
  // not apply, since `writeSetComplete` requires EVERY entry to have
  // applied, never an OR across surfaces OR across IDs).
  output(
    {
      updated: updated.length > 0,
      marked_complete: updated,
      already_complete: alreadyComplete,
      not_found: notFound,
      table_unmatched: tableUnmatched,
      total: reqIds.length,
      write_set: writeSet,
      write_set_complete: writeSetComplete(writeSet),
    },
    raw,
    `${updated.length}/${reqIds.length} requirements marked complete`,
  );
}

/**
 * #2388: a requirement ID shared by more than one plan in a phase must not be
 * handed to `cmdRequirementsMarkComplete` until every plan declaring it has
 * finished (i.e. has a `*-SUMMARY.md`) — otherwise the ID reads `Complete` in
 * REQUIREMENTS.md ~20 minutes before its sibling plans even run, and long
 * before `verify_phase_goal` has a chance to catch a gap.
 *
 * Pure read-only gate: scans sibling `*-PLAN.md` files in the SAME phase
 * directory as `planPath` (excluding `planPath` itself) and, for each
 * candidate ID, blocks it only when a sibling plan ALSO declares that ID in
 * its own `requirements:` frontmatter AND that sibling has no matching
 * `*-SUMMARY.md` yet. An ID no sibling declares is never blocked — a
 * single-plan (non-shared) ID is always `ready`, preserving immediate
 * marking with no added latency (acceptance criterion 4). Does not read or
 * write REQUIREMENTS.md itself; callers pass the `ready` subset on to
 * `cmdRequirementsMarkComplete` (whose own flip semantics are untouched).
 */
function cmdRequirementsReadyIds(cwd: string, args: string[], raw: boolean): void {
  const planPathArg = args[0];
  if (!planPathArg) {
    error('plan path required. Usage: requirements ready-ids <plan-path> REQ-01,REQ-02');
  }

  const reqIds = args
    .slice(1)
    .join(' ')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (reqIds.length === 0) {
    output({ ready: [], blocked: [], total: 0 }, raw, 'no requirement IDs provided');
    return;
  }

  const planAbsPath = path.resolve(cwd, planPathArg);
  // #3183: `planPathArg` may point at a root plan (`<phaseDir>/<n>-PLAN.md`)
  // or a nested plan (`<phaseDir>/plans/PLAN-<n>.md`, #3139 layout) —
  // scanPhasePlans always operates on the PHASE dir, so a nested plan needs
  // one extra `dirname` to reach it, and its planFiles-relative identity
  // carries the `plans/` prefix scanPhasePlans itself applies.
  const isNestedPlanPath = path.basename(path.dirname(planAbsPath)) === 'plans';
  const phaseDir = isNestedPlanPath ? path.dirname(path.dirname(planAbsPath)) : path.dirname(planAbsPath);
  const currentRelative = isNestedPlanPath ? `plans/${path.basename(planAbsPath)}` : path.basename(planAbsPath);

  // #3183: canonical plan/summary sets (root+nested, superseded-excluded)
  // from the single owner, rather than a root-only hand-rolled readdirSync
  // filter — a superseded sibling that still declares reqId with no SUMMARY
  // used to block the ID forever (false-block); it is now excluded upstream.
  const phaseScan = scanPhasePlans(phaseDir);
  const siblingPlanFiles = phaseScan.planFiles.filter((f) => f !== currentRelative);

  const parseFrontmatterReqIds = (content: string, sourcePath?: string): string[] => {
    const fm = extractFrontmatter(content, sourcePath);
    const fmReq = fm.requirements;
    if (Array.isArray(fmReq)) return fmReq.map((r) => String(r).trim()).filter(Boolean);
    if (typeof fmReq === 'string') {
      return fmReq
        .replace(/[\[\]]/g, '')
        .split(/[,\s]+/)
        .map((r) => r.trim())
        .filter(Boolean);
    }
    return [];
  };

  const ready: string[] = [];
  const blocked: string[] = [];

  for (const reqId of reqIds) {
    let blockedBySibling = false;

    for (const siblingFile of siblingPlanFiles) {
      const siblingPath = path.join(phaseDir, siblingFile);
      let siblingContent: string;
      try {
        siblingContent = fs.readFileSync(siblingPath, 'utf-8');
      } catch {
        continue;
      }

      const siblingReqIds = parseFrontmatterReqIds(siblingContent, siblingPath);
      const siblingDeclaresId = siblingReqIds.some((id) => id.toLowerCase() === reqId.toLowerCase());
      if (!siblingDeclaresId) continue;

      // Sibling declares the SAME ID — it must have finished (produced a
      // SUMMARY) before this ID is ready to mark Complete. Canonical pairing
      // via countMatchedSummaries (root+nested, all three naming forms)
      // instead of a bespoke -PLAN.md→-SUMMARY.md regex swap.
      const siblingHasSummary = countMatchedSummaries([siblingFile], phaseScan.summaryFiles) > 0;
      if (!siblingHasSummary) {
        blockedBySibling = true;
        break;
      }
    }

    if (blockedBySibling) blocked.push(reqId);
    else ready.push(reqId);
  }

  output(
    { ready, blocked, total: reqIds.length },
    raw,
    `${ready.length}/${reqIds.length} requirement(s) ready to mark complete`,
  );
}

/**
 * #2388: revert this phase's own requirement IDs out of `Complete` when
 * `verify_phase_goal` returns `gaps_found` — a gap verdict must not leave a
 * premature `Complete` (from a shared ID's first-declaring plan, or from any
 * other early write) sitting in REQUIREMENTS.md indefinitely.
 *
 * Mirrors `cmdRequirementsMarkComplete`'s two write surfaces in reverse:
 * checkbox `[x]` -> `[ ]`, and traceability Status `Complete` -> `Gaps
 * Found`. Phase-scoping is the CALLER's responsibility — this function only
 * ever touches the exact IDs it is given, so a caller passing just this
 * phase's own `phase_req_ids` never touches another phase's `Complete` row.
 * Never call this on the pass path; it is `gaps_found`-only.
 */
function cmdRequirementsRevertPhase(cwd: string, reqIdsRaw: string[], raw: boolean): void {
  const reqIds = (reqIdsRaw || [])
    .join(' ')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (reqIds.length === 0) {
    output({ reverted: [], unchanged: [], total: 0 }, raw, 'no requirement IDs provided');
    return;
  }

  const reqPath = planningPaths(cwd).requirements;
  if (!fs.existsSync(reqPath)) {
    output(
      { reverted: [], unchanged: reqIds, total: reqIds.length, reason: 'REQUIREMENTS.md not found' },
      raw,
      'no requirements file',
    );
    return;
  }

  let reqContent = fs.readFileSync(reqPath, 'utf-8');
  const reverted: string[] = [];
  const unchanged: string[] = [];

  for (const reqId of reqIds) {
    const reqEscaped = escapeRegex(reqId);
    let idReverted = false;

    // Surface 1 — checkbox: - [x] **REQ-ID** -> - [ ] **REQ-ID**
    const checkboxPattern = new RegExp(`(-\\s*\\[)x(\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
    const afterCheckbox = reqContent.replace(checkboxPattern, '$1 $2');
    if (afterCheckbox !== reqContent) {
      reqContent = afterCheckbox;
      idReverted = true;
    }

    // Surface 2 — traceability row: Status Complete -> Gaps Found. Only
    // flips a row currently reading Complete (mirrors mark-complete's own
    // "only flip Pending -> Complete" gate, in reverse).
    const rowMatch = (row: Record<string, string>): boolean =>
      (Object.values(row)[0] ?? '').trim().toLowerCase() === reqId.toLowerCase();
    let tableHit = false;
    const tableUpdate = updateTraceabilityCell(reqContent, rowMatch, 'Status', (current) => {
      if (/^complete$/i.test(current.trim())) {
        tableHit = true;
        return ' Gaps Found ';
      }
      return current;
    });
    if (tableUpdate.ok) {
      reqContent = tableUpdate.value;
      if (tableHit) idReverted = true;
    }

    if (idReverted) reverted.push(reqId);
    else unchanged.push(reqId);
  }

  if (reverted.length > 0) {
    platformWriteSync(reqPath, reqContent);
  }

  output(
    { reverted, unchanged, total: reqIds.length },
    raw,
    `${reverted.length}/${reqIds.length} requirement(s) reverted from Complete`,
  );
}

/**
 * #2142 (code-review FIX 4): the single owned "should the Quick Tasks
 * Completed table be reset, and is a reset failure worth a warning" decision
 * — shared by `cmdMilestoneComplete` (which folds this into its own
 * `withStateLock` transform, since it already holds that lock for the
 * closure-transition write happening in the same block) and `cmdQuickArchive`
 * (which routes through `readModifyWriteStateMd`'s own transform instead, per
 * the lock-reentrancy note on that function). Only the WRITE mechanics
 * differ between the two callers — the decision itself ("skip a
 * `QUICK_TASKS_SECTION_ABSENT` result silently; surface any other failure")
 * was previously duplicated verbatim at both call sites.
 *
 * Never throws: a reset failure degrades to returning `content` unchanged
 * with a non-null `warning`, mirroring both callers' pre-existing
 * "liberal but visible" posture.
 */
function applyQuickTasksReset(content: string): { content: string; warning: { field: string; reason: string } | null } {
  const resetResult = resetQuickTaskRows(content);
  if (resetResult.ok) {
    return { content: resetResult.value.content, warning: null };
  }
  if (resetResult.reason !== QUICK_TASKS_SECTION_ABSENT) {
    return { content, warning: { field: 'quick_tasks_table', reason: resetResult.reason } };
  }
  return { content, warning: null };
}

function cmdMilestoneComplete(cwd: string, version: string, options: MilestoneCompleteOptions, raw: boolean): void {
  if (!version) {
    error('version required for milestone complete (e.g., v1.0)');
  }
  // #2288 security: `version` is a CLI positional that is interpolated into
  // multiple filesystem sinks below — `path.join(archiveDir, `${version}-ROADMAP.md`)`,
  // `${version}-REQUIREMENTS.md`, `${version}-MILESTONE-AUDIT.md`, and the
  // `${version}-phases` archive directory that phase dirs are MOVED into. Reject
  // path separators / `..` here (same guard as `--archive-version`) so a crafted
  // version cannot write or relocate content outside `.planning/milestones/`.
  if (!ARCHIVE_VERSION_LABEL_RE.test(version)) {
    error(`milestone complete: version "${version}" is invalid — a milestone version label may contain only letters, digits, '.', '-' and '_', and must not contain path separators or "..".`);
  }

  const roadmapPath = planningPaths(cwd).roadmap;
  const reqPath = planningPaths(cwd).requirements;
  const statePath = planningPaths(cwd).state;
  // #1911: derive the archive base from the workstream-aware planning root so
  // `milestone complete --ws` archives into the workstream, not root. planningPaths(cwd).planning
  // resolves to the workstream base when GSD_WORKSTREAM is set and to root .planning otherwise
  // (flat mode is a no-op).
  const planningBase = planningPaths(cwd).planning;
  const milestonesPath = path.join(planningBase, 'MILESTONES.md');
  const archiveDir = path.join(planningBase, 'milestones');
  const phasesDir = planningPaths(cwd).phases;
  const today = realClock.localToday();
  const milestoneName = options.name || version;
  // ADR-3408 §8.5 / #3469: "liberal but visible" — when the write-seam
  // composition's preservation stage restores a curated frontmatter value
  // over a disagreeing freshly-derived one, that divergence is surfaced
  // here rather than silently absorbed (the direct answer to #3374's
  // `warnings: []`). Structured (field + reason), not prose, so a caller can
  // assert on the value rather than regex a rendered message.
  //
  // Named `preservation_warnings`, NOT `warnings`: `cmdPhaseComplete` already
  // exposes a sibling field called `warnings` typed as prose `string[]`. Reusing
  // that name here for a structured `{field, reason}[]` shape would be the
  // "Generative Fix Divergence" anti-pattern — two sibling state commands
  // sharing one field name with different element types. `warnings` stays
  // one meaning (prose) repo-wide; this is a distinct, machine-assertable
  // signal for ADR-3408 §8.5's "preservation is visible" rule. Check
  // `preservation_warnings.length` rather than a companion `has_warnings`
  // flag — that flag existed only to mirror `cmdPhaseComplete`'s channel,
  // which this field intentionally does not claim to be.
  const preservationWarnings: Array<{ field: string; reason: string }> = [];

  // Scope stats and accomplishments to only the phases belonging to the
  // current milestone's ROADMAP.  Uses the shared filter from roadmap-parser.cjs
  // (same logic used by cmdPhasesList and other callers).
  // #3184 review finding: this scope computation + refusal MUST run BEFORE
  // `platformEnsureDir(archiveDir)` below — a refused run (scope not COMPLETE,
  // no --force) must be a true no-op on disk, and creating the archive
  // directory first left an empty directory behind even on refusal.
  const isDirInMilestone = getMilestonePhaseFilter(cwd, version);
  if (isDirInMilestone.missingExplicitVersion) {
    error(`no phases found for milestone ${version} in ROADMAP.md`);
  }
  // #3184/#3166: `milestone complete` is the ONE-WAY-DOOR consumer of the
  // milestone window (ROADMAP/REQUIREMENTS archived, phase directories
  // MOVED). #3166 is specifically the TRUNCATED case: the milestone's
  // heading IS found but its section closes before the phase region, and the
  // phase filter degrades to pass-all (see getMilestonePhaseFilter above) —
  // silently archiving every phase directory on disk. UNREADABLE (no
  // ROADMAP.md at all) and UNSCOPED (no section for this version) are
  // pre-existing, legitimately-handled states — `missingExplicitVersion`
  // above already errors where that matters, and a missing ROADMAP.md has
  // its own documented graceful path — so only TRUNCATED is refused here.
  // The read-path consumers keep the pass-all degrade for every scope
  // (ADR-3180 Decision 3's Rejected section: deny-all there would trade one
  // silent wrong answer for another); this write path refuses on TRUNCATED
  // alone, positioned before `platformEnsureDir` so a refusal stays a no-op
  // on disk.
  if (isDirInMilestone.scope === SCOPE.TRUNCATED && !options.force) {
    error(
      `Cannot mark milestone complete: the ROADMAP window for "${version}" is truncated ` +
        `(the milestone heading was found but its section ends before reaching any phase ` +
        `entries, even though the ROADMAP has phase entries elsewhere), so phase scoping ` +
        `cannot be trusted for this destructive operation. Re-run with --force to override.`,
    );
  }

  // Guard: prevent marking complete when ROADMAP still lists phases that have
  // no directory on disk (disk_status: no_directory). This catches the case
  // where the active milestone was erroneously marked complete before phases
  // were even started. The scan scopes the ROADMAP via the `version` argument
  // (getMilestonePhaseFilter / extractCurrentMilestone above) and runs whenever
  // --force is absent — a fresh project with no `### Phase N:` headings in the
  // scoped slice yields an empty `noDirectoryPhases` and the guard is a no-op,
  // so no STATE match is required to avoid false positives.
  // Pass --force to override this guard.
  //
  // #2946: the scan used to be nested inside `if (stateVersion && stateVersion
  // === version)`, which silently disarmed the guard whenever STATE.md's
  // `milestone:` field was desynced or absent — functionally an implicit
  // --force on a one-way-door operation (ROADMAP/REQUIREMENTS archived, phase
  // directories MOVED). The STATE field is not the source of truth for which
  // phases belong to this milestone; the ROADMAP scoping is. The scan now runs
  // unconditionally, and a present-but-mismatched STATE field emits a WARNING
  // so the suspicious condition is visible rather than silent.
  if (!options.force) {
    try {
      // Read STATE.md's milestone field only to detect a suspicious mismatch;
      // it no longer gates the scan. (#2946)
      let stateVersion: string | null = null;
      try {
        const stateRaw = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : null;
        if (stateRaw) {
          const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
          if (milestoneMatch) stateVersion = milestoneMatch[1].trim();
        }
      } catch {
        /* skip — stateVersion stays null, scan still runs */
      }
      if (stateVersion !== null && stateVersion !== version) {
        // #2946: emit a WARNING so the suspicious STATE mismatch is visible
        // rather than silently disarming the guard. Plain-text diagnostic on
        // stderr, matching the existing [gsd-tools] WARNING convention
        // (state.cts). A missing STATE.md `milestone:` field is not warned
        // here — the scan still runs, and "no milestone declared" is a normal
        // state for a fresh project, not a suspicious drift.
        //
        // `stateVersion` comes from a user-controlled file (STATE.md) and is
        // not validated like the CLI `version` arg (ARCHIVE_VERSION_LABEL_RE).
        // Sanitize before interpolating into stderr so ANSI escapes / control
        // chars / secret-looking strings cannot be echoed verbatim into a CI
        // log or terminal (CONTRIBUTING.md security: secret-looking values in
        // stderr). `version` is already constrained to [A-Za-z0-9._-].
        const safeStateVersion = stateVersion.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 80);
        process.stderr.write(
          `[gsd-tools] WARNING: STATE.md milestone: "${safeStateVersion}" ≠ requested "${version}" — ` +
            `running the unstarted-phase guard against the ROADMAP scoped for "${version}" anyway.\n`,
        );
      }

      const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
      // #3184/#2946: scope the unstarted-phase guard to the same `version`
      // window `getMilestonePhaseFilter` used above, NOT to
      // extractCurrentMilestone's own STATE.md-derived window — those two
      // can disagree (that disagreement is exactly what the WARNING above
      // detects), and scoping this guard to the wrong window under-detects
      // unstarted phases on the destructive completion path. Calls the same
      // sliceMilestoneWindow owner getMilestonePhaseFilter's versionOverride
      // branch calls (a prior pass here re-composed locate+select+section-end
      // locally, which review caught as a second, disagreeing derivation of
      // the same window — ADR-3180 Decision 4(c)); falls back to
      // extractCurrentMilestone's whole-document result only for the
      // free-form (no versioned milestones anywhere) shape, where both
      // windows converge to the same value regardless of which version drove
      // the lookup.
      const scopedContent = sliceMilestoneWindow(roadmapContent, version) ?? extractCurrentMilestone(roadmapContent, cwd);
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gi');
      const noDirectoryPhases: string[] = [];
      let pm: RegExpExecArray | null;
      const phaseDirEntries = ((): string[] => {
        try {
          return fs
            .readdirSync(phasesDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          return [];
        }
      })();
      while ((pm = phasePattern.exec(scopedContent)) !== null) {
        const phaseNum = pm[1];
        // Phase 0 (pre-milestone) and Phase 999 (backlog) are sentinels, not
        // real phases — they legitimately have no directory and must not block
        // milestone completion. Mirrors the engine-wide sentinel convention
        // (phase-id getMilestoneFromPhaseId, roadmap-command-router SENTINELS,
        // the #1445 /^999/ progress filters). (#1580)
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this local check already covered both 0 and 999; now delegates to the single canonical owner.
        if (isSentinelPhaseId(phaseNum)) continue;
        const normalized = normalizePhaseName(phaseNum);
        // A phase has disk_status: 'no_directory' when no phase directory
        // with a matching token exists on disk. Use the same matchPhaseDirs
        // owner that roadmap.analyze uses to avoid false positives on decimal
        // (2.1) and letter-suffix (12A) phase IDs. (#2528)
        const hasDirectory = matchPhaseDirs(phaseDirEntries, normalized).matches.length > 0;
        if (!hasDirectory) {
          noDirectoryPhases.push(phaseNum);
        }
      }
      if (noDirectoryPhases.length > 0) {
        error(
          `Cannot mark milestone complete: ROADMAP lists ${noDirectoryPhases.length} unstarted phase(s) ` +
            `(e.g. Phase ${noDirectoryPhases[0]}). Re-run with --force to override.`,
        );
      }
    } catch (e) {
      // If the error came from our guard, re-throw it; otherwise skip silently.
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.startsWith('Cannot mark milestone complete:')) throw e;
      // Phase scan failed (e.g. ROADMAP unreadable) — allow completion to proceed.
    }
  }

  // Gather stats from phases (scoped to current milestone only)
  let phaseCount = 0;
  let totalPlans = 0;
  let totalTasks = 0;
  const accomplishments: string[] = [];

  try {
    // #3185 (ADR-3180 Decision 1): "which phase directories belong to the
    // CURRENT milestone" — routed through the canonical owner (with the
    // explicit `version` this command already resolved) instead of a
    // hand-rolled readdirSync + isDirInMilestone filter, which also never
    // excluded sentinels, unlike the owner.
    const dirs = listMilestonePhaseDirs(phasesDir, { cwd, versionOverride: version }).value;

    for (const dir of dirs) {
      phaseCount++;
      // #3183: canonical plan/summary sets (root+nested, superseded-excluded)
      // from the single owner, rather than a root-only hand-rolled readdirSync
      // filter.
      const phaseScan = scanPhasePlans(path.join(phasesDir, dir));
      const summaries = phaseScan.summaryFiles;
      totalPlans += phaseScan.planCount;

      // Extract one-liners from summaries
      for (const s of summaries) {
        try {
          const content = fs.readFileSync(path.join(phasesDir, dir, s), 'utf-8');
          const fm = extractFrontmatter(content, path.join(phasesDir, dir, s));
          const rawOneLiner = fm['one-liner'];
          const oneLiner = (typeof rawOneLiner === 'string' ? rawOneLiner : '') || extractOneLinerFromBody(content);
          if (oneLiner) {
            accomplishments.push(oneLiner);
          }
          // Count tasks: prefer **Tasks:** N from Performance section,
          // then <task XML tags, then ## Task N markdown headers
          const tasksFieldMatch = content.match(/\*\*Tasks:\*\*\s*(\d+)/);
          if (tasksFieldMatch) {
            totalTasks += parseInt(tasksFieldMatch[1], 10);
          } else {
            const xmlTaskMatches = content.match(/<task[\s>]/gi) || [];
            const mdTaskMatches = content.match(/##\s*Task\s*\d+/gi) || [];
            totalTasks += xmlTaskMatches.length || mdTaskMatches.length;
          }
        } catch {
          /* best-effort (#2245 audit): one unreadable/malformed SUMMARY.md
           * must not abort the accomplishments/task-count roll-up for every
           * OTHER summary across every OTHER phase — it's simply excluded
           * from the milestone's shipped-summary text. */
        }
      }
    }
  } catch {
    /* best-effort (#2245 audit): mirrors the phaseDirEntries IIFE a few
     * lines below this function (same phasesDir, same "try readdirSync,
     * tolerate ENOENT" pattern) — phasesDir may legitimately not exist yet
     * (e.g. milestone being force-completed before any phase directories
     * were created). Degrades stats to phaseCount/totalPlans/totalTasks=0,
     * accomplishments=[] rather than crash `milestone complete`. */
  }

  // #2118: --dry-run preview — compute what WOULD happen without mutating.
  // The stats above are read-only; all mutations start at the archive section below.
  if (options.dryRun) {
    const phaseDirsToArchive: string[] = [];
    if (options.archivePhases !== false) {
      // #3185 (ADR-3180 Decision 1): same routed derivation as the stats loop
      // above — the dry-run preview must list exactly what the real archive
      // pass below would move.
      phaseDirsToArchive.push(...listMilestonePhaseDirs(phasesDir, { cwd, versionOverride: version }).value);
    }
    // #2142 MAJOR 5 (review): dry-run preview of quick-task archival —
    // read-only, routed through the SAME `listQuickTaskDirsForArchive`
    // selection `archiveQuickTaskDirectories` uses for real (directory
    // entries only, `requireSafePath`-guarded, sorted) so this preview can
    // never disagree with what a real run actually archives. Absent
    // --archive-quick this stays `[]` and nothing on disk is touched either
    // way (dry-run always returns before any mutation below).
    const quickDirsToArchive: string[] = options.archiveQuick ? listQuickTaskDirsForArchive(cwd) : [];
    const dryRunResult = {
      dry_run: true,
      version,
      name: milestoneName,
      stats: { phases: phaseCount, plans: totalPlans, tasks: totalTasks },
      accomplishments,
      would_archive: {
        roadmap: fs.existsSync(roadmapPath)
          ? { source: path.relative(cwd, roadmapPath).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-ROADMAP.md`)).split(path.sep).join('/') }
          : null,
        requirements: fs.existsSync(reqPath)
          ? { source: path.relative(cwd, reqPath).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-REQUIREMENTS.md`)).split(path.sep).join('/') }
          : null,
        audit: fs.existsSync(path.join(planningBase, `${version}-MILESTONE-AUDIT.md`))
          ? { source: path.relative(cwd, path.join(planningBase, `${version}-MILESTONE-AUDIT.md`)).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`)).split(path.sep).join('/') }
          : null,
        phases: phaseDirsToArchive,
        quick: quickDirsToArchive,
      },
      would_update: {
        milestones_md: path.relative(cwd, milestonesPath).split(path.sep).join('/'),
        state_md: fs.existsSync(statePath) ? path.relative(cwd, statePath).split(path.sep).join('/') : null,
      },
    };
    output(dryRunResult, raw);
    return;
  }

  // Ensure archive directory exists. Deliberately placed AFTER the dry-run
  // early return and every refusal/guard above (missingExplicitVersion, the
  // scope refusal, the unstarted-phase guard) — #3184 review finding: this
  // used to run before those checks, so a refused run still left an empty
  // archive directory behind. Reaching this point means the run is
  // committed to mutating.
  platformEnsureDir(archiveDir);

  // Archive ROADMAP.md
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    platformWriteSync(path.join(archiveDir, `${version}-ROADMAP.md`), roadmapContent);
  }

  // Archive REQUIREMENTS.md
  if (fs.existsSync(reqPath)) {
    const reqContent = fs.readFileSync(reqPath, 'utf-8');
    // Derive the display path from the same source the writer uses (reqPath), so a
    // workstream archive header points at `.planning/workstreams/<ws>/REQUIREMENTS.md`
    // instead of the hardcoded root path (#1993). Root case is byte-identical.
    // Normalize to POSIX separators so the header is cross-platform (Windows
    // path.relative yields backslashes; the original literal was forward-slash).
    const reqDisplay = path.relative(cwd, reqPath).split(path.sep).join('/');
    const archiveHeader = `# Requirements Archive: ${version} ${milestoneName}\n\n**Archived:** ${today}\n**Status:** SHIPPED\n\nFor current requirements, see \`${reqDisplay}\`.\n\n---\n\n`;
    platformWriteSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`), archiveHeader + reqContent);
  }

  // Archive audit file if exists
  const auditFile = path.join(planningBase, `${version}-MILESTONE-AUDIT.md`);
  if (fs.existsSync(auditFile)) {
    retryRenameSync(auditFile, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`));
  }

  // Create/append MILESTONES.md entry
  const accomplishmentsList = accomplishments.map((a) => `- ${a}`).join('\n');
  const milestoneEntry = `## ${version} ${milestoneName} (Shipped: ${today})\n\n**Phases completed:** ${phaseCount} phases, ${totalPlans} plans, ${totalTasks} tasks\n\n**Key accomplishments:**\n${accomplishmentsList || '- (none recorded)'}\n\n---\n\n`;

  if (fs.existsSync(milestonesPath)) {
    const existing = fs.readFileSync(milestonesPath, 'utf-8');
    if (!existing.trim()) {
      // Empty file — treat like new
      platformWriteSync(milestonesPath, `# Milestones\n\n${milestoneEntry}`);
    } else {
      // Insert after the header line(s) for reverse chronological order (newest first)
      // #3415: empirically verified linear-time up to 5MB adversarial input (worst-case
      // no-newline-at-all forcing full [^\r\n]* backtrack: 0.11ms@10KB -> 6.9ms@5MB).
      // Non-global, `^`-anchored (no /m) so this is a single match attempt at position 0
      // only — never rescanned at every offset — with no nested repeated group, so it
      // cannot exhibit the #2128-class catastrophic backtracking.
      // eslint-disable-next-line local/no-unbounded-quantifier -- single ^-anchored non-global attempt at pos 0, measured linear to 5MB, no nested quantifier
      const headerMatch = existing.match(/^(#{1,3}\s+[^\r\n]*\r?\n(?:\r?\n)?)/);
      if (headerMatch) {
        const header = headerMatch[1];
        const rest = existing.slice(header.length);
        platformWriteSync(milestonesPath, header + milestoneEntry + rest);
      } else {
        // No recognizable header — prepend the entry
        platformWriteSync(milestonesPath, milestoneEntry + existing);
      }
    }
  } else {
    platformWriteSync(milestonesPath, `# Milestones\n\n${milestoneEntry}`);
  }

  // #2142 BLOCKER 2 (review): opt-in quick-task archival. This call MUST sit
  // immediately adjacent to the STATE.md write block directly below it, with
  // NO unguarded IO in between (unlike the ROADMAP/REQUIREMENTS/audit/
  // MILESTONES.md writes above, none of which are wrapped in a try/catch).
  // If the move ran earlier — e.g. right after `platformEnsureDir(archiveDir)`
  // — and any one of those unguarded writes then threw, the quick-task
  // directories would already be gone from `.planning/quick/` while the
  // STATE.md Quick Tasks table reset (which lives inside `withStateLock`
  // immediately below) would never be reached. That is precisely the
  // STATE-vs-disk drift #2142 exists to eliminate: a table still describing
  // directories that no longer exist. Keeping the move and the reset
  // adjacent — separated only by this comment, never by IO that can throw —
  // means either both happen or (if the move itself throws) neither does.
  // `archiveQuick` is opt-in (default OFF); absent the flag this is `null`
  // and every downstream read of it degrades to "no quick archival happened".
  const quickArchiveResult = options.archiveQuick
    ? archiveQuickTaskDirectories(cwd, version)
    : null;

  // Update STATE.md — keep frontmatter/body semantically aligned after closure.
  // ADR-1769 Phase 5: dispatches to the STATE.md Transition Module. The closure
  // write (Status, Last Activity, Last Activity Description, Current Position
  // reset, Operator Next Steps reset) is the pure `milestoneCompleteCore` in
  // src/state-transition.cts, backed by the field-classification table. The
  // runtime-specific next-milestone slash command is resolved here and injected
  // via the intent so the core stays pure.
  //
  // ADR-3408 §8.3 / #3469: this used to write via `writeStateMd`, which gets
  // sync and NO preservation — the identical shape #3374 reported for
  // `phase.complete` (a stale body value silently clobbering fresher
  // frontmatter). Routed through the single write-seam composition
  // (`syncAndPreserveStateMd`) instead, under the same lock discipline
  // `cmdPhaseComplete`'s atomic-commit adapter already uses: `withStateLock`
  // wraps read + transform + sync + preserve + write so the read this
  // transaction bases its transform on cannot be raced by a concurrent
  // writer (closing a pre-existing TOCTOU gap `writeStateMd`'s own internal
  // lock never covered, since the read used to happen before any lock was
  // taken). `resync: true` mirrors `cmdPhaseComplete`'s posture (progress
  // recomputed from disk; only the preserve-when-unchanged deltas apply) —
  // milestone completion is the same kind of lifecycle transition.
  if (fs.existsSync(statePath)) {
    withStateLock(statePath, () => {
      const originalStateContent = platformReadSync(statePath) || '';
      const result = transitionCore(
        originalStateContent,
        {
          kind: 'milestoneComplete',
          version,
          nextMilestoneCommand: formatGsdSlash('new-milestone', resolveRuntime(cwd)) as string,
        },
        { clock: realClock, sourcePath: statePath },
      );
      const divergedFields: string[] = [];
      // #2111 (found by #3471 review): `milestoneCompleteCore` never declares
      // `current_phase`/`current_phase_name` among the fields it touches — but
      // its ## Current Position reset REWRITES the `Phase:` prose line to a
      // closure message ("Milestone vX.Y complete"), which is not a number.
      // That is an unavoidable side effect of the wholesale section reset
      // `resetSectionVerbatim` performs, not an intent to change the phase.
      // Downstream, `current_phase`/`current_phase_name` are
      // `preserve-when-unchanged` rows: the #1230 delta heuristic sees the
      // body source go from a real value to unparseable and — correctly, per
      // ADR-3408 §8.5 Row 2 — lets the derived (empty) value win, discarding
      // the curated phase entirely. §8.5 Row 2 governs a genuine mid-write
      // body edit (e.g. `state.patch` deleting the Phase line); milestone
      // closure is a different shape — the transition never intended to
      // touch these fields at all. Re-assert them via `authoritativeFm` (the
      // same #2736 intent-first mechanism `beginPhaseCore`/`completePhaseCore`
      // already use to freeze a field the transition resolved out-of-band),
      // so the closure-message side effect cannot clobber the last real
      // phase. Scoped to non-empty strings only, mirroring #2736's own guard.
      const authoritativeFm: Record<string, unknown> = {};
      const preFm = extractFrontmatter(originalStateContent, statePath) as Record<string, unknown>;
      const preCurrentPhase = preFm['current_phase'];
      const preCurrentPhaseName = preFm['current_phase_name'];
      if (typeof preCurrentPhase === 'string' && preCurrentPhase.trim().length > 0) {
        authoritativeFm['current_phase'] = preCurrentPhase;
      }
      if (typeof preCurrentPhaseName === 'string' && preCurrentPhaseName.trim().length > 0) {
        authoritativeFm['current_phase_name'] = preCurrentPhaseName;
      }

      // #2142: fold the Quick Tasks table reset into this SAME
      // `withStateLock` transform — no second lock acquisition, no second
      // `syncAndPreserveStateMd`/`platformWriteSync` pass. Only applied when
      // quick archival actually MOVED something (never when the flag was
      // absent, and never for a mere dry-run preview, which never reaches
      // here at all). A refused reset degrades to leaving the content
      // untouched and never fails milestone completion, but the two refusal
      // shapes are NOT equally noteworthy (design doc §40, behavior table
      // row 5): an ABSENT "Quick Tasks Completed" section is the normal,
      // common case — the section is created lazily by
      // `gsd-core/workflows/quick.md` Step 7b, not by
      // `gsd-core/templates/state.md`, so most projects simply don't have
      // one — and is silently skipped (compared via the shared
      // `QUICK_TASKS_SECTION_ABSENT` sentinel, never by matching on the
      // free-form reason string). A section that EXISTS but couldn't be
      // reset (unparseable table, or columns matching neither registered
      // QuickTasks variant) is a genuine anomaly and IS surfaced via
      // `preservationWarnings`, the same "liberal but visible" posture the
      // rest of this block already uses for a disagreeing derived STATE.md
      // value.
      let quickTasksResetContent = result.content;
      if (quickArchiveResult && quickArchiveResult.archived > 0) {
        const { content: resetContent, warning } = applyQuickTasksReset(quickTasksResetContent);
        quickTasksResetContent = resetContent;
        if (warning) preservationWarnings.push(warning);
      }

      const finalContent = syncAndPreserveStateMd(
        originalStateContent,
        quickTasksResetContent,
        statePath,
        cwd,
        {
          resync: true,
          authoritativeFm: Object.keys(authoritativeFm).length > 0 ? authoritativeFm : undefined,
          divergedFields,
        },
      );
      platformWriteSync(statePath, finalContent);
      for (const field of divergedFields) {
        preservationWarnings.push({ field, reason: 'preserved-over-disagreeing-derived' });
      }
      // The authoritativeFm re-assert above (unlike a delta-based restore) is
      // invisible to `divergedFields` — #2736's re-assert runs after that
      // diff — so surface it explicitly here for "liberal but visible".
      for (const field of Object.keys(authoritativeFm)) {
        if (!divergedFields.includes(field)) {
          preservationWarnings.push({ field, reason: 'preserved-over-disagreeing-derived' });
        }
      }
    });
  }

  // Archive phase directories if requested
  let phasesArchived = false;
  // #1871: archive phase dirs by default on milestone complete (opt out via --no-archive-phases).
  if (options.archivePhases !== false) {
    // #2245 audit (was ERROR-HIDING): retryRenameSync moves one phase dir at a
    // time — a mid-loop failure (e.g. the Nth rename) used to leave
    // `phasesArchived` at its `false` default even though the first N-1 dirs
    // had ALREADY been moved to phaseArchiveDir on disk, silently
    // under-reporting a real partial archive in the JSON result. archivedCount
    // is now computed in a `finally` so it reflects whatever succeeded before
    // any failure, instead of being lost with the swallowed exception.
    let archivedCount = 0;
    try {
      const phaseArchiveDir = path.join(archiveDir, `${version}-phases`);
      platformEnsureDir(phaseArchiveDir);

      // #3185 (ADR-3180 Decision 1): same routed derivation as the stats
      // loop above — only the CURRENT milestone's phase directories move,
      // never a sentinel or an out-of-window directory left for a later
      // milestone.
      const phaseDirNames = listMilestonePhaseDirs(phasesDir, { cwd, versionOverride: version }).value;
      for (const dir of phaseDirNames) {
        retryRenameSync(path.join(phasesDir, dir), path.join(phaseArchiveDir, dir));
        archivedCount++;
      }
    } catch {
      /* best-effort: phasesDir may not exist yet, or the archive rename loop
       * failed partway — phasesArchived below still reflects whatever
       * archivedCount succeeded before the failure. */
    } finally {
      phasesArchived = archivedCount > 0;
    }
  }

  const result = {
    version,
    name: milestoneName,
    date: today,
    phases: phaseCount,
    plans: totalPlans,
    tasks: totalTasks,
    accomplishments,
    archived: {
      roadmap: fs.existsSync(path.join(archiveDir, `${version}-ROADMAP.md`)),
      requirements: fs.existsSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`)),
      audit: fs.existsSync(path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`)),
      phases: phasesArchived,
      quick: !!quickArchiveResult && quickArchiveResult.archived > 0,
    },
    milestones_updated: true,
    state_updated: fs.existsSync(statePath),
    preservation_warnings: preservationWarnings,
  };

  output(result, raw);
}

function cmdPhasesClear(cwd: string, raw: boolean, args: string[]): void {
  const phasesDir = planningPaths(cwd).phases;
  const confirm = Array.isArray(args) && args.includes('--confirm');
  // --force bypasses the uncommitted-changes guard. Only use when the caller
  // has already archived or explicitly accepts loss of uncommitted work. (#1447)
  const force = Array.isArray(args) && args.includes('--force');
  // #2288: explicit outgoing-version override for the archive destination.
  // new-milestone.md runs `state.milestone-switch` BEFORE `phases.clear --confirm`,
  // so a live read of STATE.md would already report the NEW milestone version by
  // the time we get here. Callers that know the outgoing version pass it explicitly;
  // absent an override, archivePhaseDirectories falls back to the live read.
  const avIndex = Array.isArray(args) ? args.indexOf('--archive-version') : -1;
  let archiveVersionOverride: string | null = null;
  if (avIndex !== -1) {
    const rawArchiveVersion = args[avIndex + 1];
    // Missing / flag-shaped value: fail loud instead of silently dropping the
    // override. A truncated invocation (e.g. a broken template substitution
    // leaving `--archive-version` with no value) must NOT fall through to the
    // live read — that silently re-files the archive under the new milestone,
    // the exact #2288 bug this flag exists to prevent.
    if (typeof rawArchiveVersion !== 'string' || rawArchiveVersion.startsWith('--') || rawArchiveVersion.trim() === '') {
      error('--archive-version requires a value (a milestone version token, e.g. v1.0)');
    }
    const trimmed = rawArchiveVersion.trim();
    // #2288 security: reject path separators / `..` so a crafted value cannot
    // relocate phase history outside `.planning/milestones/` (phase dirs are
    // MOVED into the archive dir — a traversal is data loss, not just an odd name).
    if (!ARCHIVE_VERSION_LABEL_RE.test(trimmed)) {
      error(`--archive-version "${trimmed}" is invalid — a milestone version label may contain only letters, digits, '.', '-' and '_', and must not contain path separators or "..".`);
    }
    archiveVersionOverride = trimmed;
  }
  let cleared = 0;

  if (fs.existsSync(phasesDir)) {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    // #3185 (ADR-3180 Decision 1): this carried the FIFTH copy of the
    // sentinel rule and its THIRD regex variant — `/^999(?:\.|$)/` — which
    // excluded 999 but NOT 0. Because this is the DESTRUCTIVE path, that
    // divergence meant a `0-*` directory `roadmap analyze` preserves as a
    // sentinel was DELETED here. Routed through the canonical predicate so
    // every reader of "is this a sentinel phase" agrees by construction.
    const dirs = entries.filter((e) => e.isDirectory() && !isSentinelPhaseId(e.name));

    if (dirs.length > 0 && !confirm) {
      error(
        `phases clear would delete ${dirs.length} phase director${dirs.length === 1 ? 'y' : 'ies'}. ` +
          `Pass --confirm to proceed.`,
      );
    }

    // Guard (#1447): refuse to hard-delete phase directories that contain
    // uncommitted changes. This prevents data loss when `new-milestone` runs
    // `phases.clear --confirm` before the operator has archived or committed
    // phase work from the outgoing milestone.
    // Use `--force` to bypass this guard only when you have verified that
    // archive or commit of the outgoing phases is already done.
    if (dirs.length > 0 && !force) {
      // Compute the path relative to cwd for git status
      let relPhasesDir: string;
      try {
        relPhasesDir = path.relative(cwd, phasesDir);
      } catch {
        relPhasesDir = phasesDir;
      }

      let gitStatusOutput = '';
      try {
        const gitResult = execGit(['status', '--porcelain', relPhasesDir], { cwd, timeout: 10_000 });
        if (gitResult.exitCode === 0) {
          gitStatusOutput = gitResult.stdout ?? '';
        }
        // If git is not available or this is not a git repo, skip the guard
        // (gitResult.exitCode non-zero → not a git repo → no uncommitted changes to protect).
      } catch {
        // git unavailable — skip guard
      }

      const uncommittedLines = gitStatusOutput
        .split('\n')
        .filter((line) => line.trim().length > 0);
      if (uncommittedLines.length > 0) {
        error(
          `phases clear aborted: ${uncommittedLines.length} uncommitted change${uncommittedLines.length === 1 ? '' : 's'} detected in phase directories. ` +
            `Archive or commit outgoing phase work before running this command, ` +
            `or pass --force to skip this check and permanently delete the phase directories. (#1447)`,
        );
      }
    }

    try {
      // #1871: archive phase directories instead of destroying them (shared helper).
      // #2288: thread the explicit --archive-version override (if any) through.
      cleared = archivePhaseDirectories(cwd, phasesDir, dirs, archiveVersionOverride).archived;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('Failed to clear phases directory: ' + message);
    }
  }

  output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
}

/**
 * #1871: move each non-999 phase directory under `phasesDir` into
 * `milestones/<version>-phases/` (collision-safe). Shared by `phases clear`
 * (archive-then-remove) and the internal milestone.complete phase archival so
 * phase history survives a milestone switch instead of being hard-deleted.
 *
 * Archive-version precedence (#2288): an explicit `archiveVersionOverride` wins
 * first, then a live `getMilestoneInfo(cwd)` read (which itself defaults to a
 * version like `v1.0` when ROADMAP/STATE is absent), and only a dated fallback
 * label if no safe version label is resolvable at all. The override is validated
 * by the caller (`cmdPhasesClear`); the live-read value is re-validated here
 * (defense in depth) because `getMilestoneInfo` derives it from STATE.md's
 * unvalidated `milestone:` field. The override exists because `new-milestone.md`
 * runs `state.milestone-switch` BEFORE `phases.clear --confirm` — by the time
 * this runs, a live read of STATE.md would already report the NEW milestone
 * version, so phase history from the OLD milestone would be misfiled under the
 * new version's archive directory. Callers that know the outgoing version must
 * pass it explicitly.
 */
function archivePhaseDirectories(cwd: string, phasesDir: string, dirs: ReadonlyArray<{ name: string }>, archiveVersionOverride: string | null = null): { archiveDir: string; archived: number } {
  // Self-protecting (#2288 security defense in depth): the sole current caller
  // (`cmdPhasesClear`) already validates the override, but re-test it here so a
  // future caller cannot reopen the path-traversal sink at line ~742. An override
  // that fails the safe-label check is discarded (falls through to the live read
  // / dated label) rather than reaching `path.join` unvalidated.
  const safeOverride = archiveVersionOverride && ARCHIVE_VERSION_LABEL_RE.test(archiveVersionOverride.trim())
    ? archiveVersionOverride.trim()
    : null;
  let archiveVersion: string | null = safeOverride;
  if (!archiveVersion) {
    try {
      // #3216 (ADR-3180 §7.2 Decision): getMilestoneInfo's version becomes a
      // DIRECTORY NAME below — only a COMPLETE scope's identity is trustworthy
      // enough to act on destructively. On any other scope, treat the version
      // as unavailable so control falls through to the dated-label fallback,
      // same as an unreadable ROADMAP/STATE.
      const info = getMilestoneInfo(cwd);
      const liveVersion = info.scope === SCOPE.COMPLETE ? (info.value?.version ?? null) : null;
      // Defense in depth (#2288 security): getMilestoneInfo reads STATE.md's
      // `milestone:` field, which is unvalidated file content. Only accept it
      // as a path component if it is a safe version label; a crafted value
      // (path separators / `..`) falls through to the dated label below rather
      // than escaping `.planning/milestones/`.
      archiveVersion = liveVersion && ARCHIVE_VERSION_LABEL_RE.test(liveVersion) ? liveVersion : null;
    } catch {
      /* ROADMAP/STATE unreadable — fall back to a dated label */
    }
  }
  if (!archiveVersion) {
    archiveVersion = `archived-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8)}`;
  }
  const archivePhasesDir = path.join(planningPaths(cwd).planning, 'milestones', `${archiveVersion}-phases`);
  platformEnsureDir(archivePhasesDir);
  let archived = 0;
  for (const entry of dirs) {
    const src = path.join(phasesDir, entry.name);
    // Collision-safe: if a same-named archive entry exists (re-run), suffix it.
    let dest = path.join(archivePhasesDir, entry.name);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(archivePhasesDir, `${entry.name}.${n++}`);
    }
    retryRenameSync(src, dest);
    archived++;
  }
  return { archiveDir: archivePhasesDir, archived };
}

/**
 * #2142 BLOCKER 1 (review): escape one directory-name span for insertion as
 * markdown LINK TEXT (`[...]`) — a directory name containing a literal `|`,
 * `[` or `]` must not be able to break the enclosing markdown. `mkdirSync`
 * accepts an embedded newline in a directory name on POSIX (and `isDirectory()`
 * still reports true for it), so an unescaped newline would let attacker-
 * controlled content — including a markdown HEADING — land verbatim in the
 * generated README.md, an indirect prompt-injection vector for any agent
 * workflow step that later reads that file. Mirrors `escapeCell`'s exact
 * convention (markdown-table.cts `escapeCell`): collapse `\r?\n+` to a single
 * space FIRST (so a newline can never re-enter the output as a line break),
 * THEN escape the escape char itself (before the rest, so a literal backslash
 * in the name is never mistaken for part of an escape sequence this function
 * introduces), THEN the markdown-syntax characters.
 */
function escapeMarkdownLinkText(text: string): string {
  return text
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * #2142 BLOCKER 1 (review): encode one path span for insertion as a markdown
 * link DESTINATION (`(...)`) — `relSummary` is built from a directory name
 * that may legally contain a space, a `(`/`)`, or a control character
 * (including an embedded newline) on POSIX. Per CommonMark, an unbracketed
 * link destination terminates at the first ASCII space/control character and
 * requires parens to be balanced or escaped — any of those would truncate or
 * corrupt the link, or let attacker-controlled content spill out of the
 * `(...)` span into the surrounding markdown (the same indirect
 * prompt-injection vector `escapeMarkdownLinkText` guards the link TEXT
 * against). Percent-encodes just the unsafe set (space, `(`, `)`, and C0
 * control chars incl. `\r`/`\n`, plus DEL) rather than switching to the
 * angle-bracket `<...>` destination form — percent-encoding is reversible (a
 * markdown viewer resolving the link still reaches the right file) and does
 * not introduce a new pair of syntax characters (`<`/`>`) that would in turn
 * need their own escaping.
 */
function encodeMarkdownLinkTarget(target: string): string {
  return target.replace(/[\x00-\x1f\x7f ()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

interface QuickArchiveIndexEntry {
  /** Escaped for markdown LINK TEXT (`escapeMarkdownLinkText`) — see below. */
  name: string;
  /**
   * POSIX-relative path (from `archiveQuickDir`) to the task's summary file,
   * NOT yet percent-encoded for markdown link-destination use — `render()`
   * applies `encodeMarkdownLinkTarget` at render time. `null` when the task
   * has no resolvable summary file.
   */
  summary: string | null;
}

interface QuickArchiveIndex {
  entries: QuickArchiveIndexEntry[];
  /** Render the entries as the `README.md` markdown body. */
  render(): string;
}

/**
 * #2142 (code-review FIX 2): PURE builder — scans `archiveQuickDir` and
 * resolves each entry's summary link, but performs NO IO beyond the read
 * scan itself; never writes. Split out of the former `writeQuickArchiveReadme`
 * so tests can assert on the returned structured IR (`entries`) instead of
 * substring-matching rendered markdown (CONTRIBUTING.md "Prohibited: Raw Text
 * Matching on Test Outputs" — a generated archive index is a "Rendered file",
 * which requires a pure builder returning IR, not the `.md`-IS-the-runtime-
 * artifact exemption).
 *
 * (re)generates an index of every quick-task directory PHYSICALLY PRESENT in
 * the archive, built by scanning the ARCHIVE directory on disk. Deliberately
 * NOT built from STATE.md's Quick Tasks table (the issue evidenced that table
 * drifting — 53 rows against 49 dirs, ~22 rows pointing at absent dirs, 18
 * dirs missing from the table — the filesystem is the only source of truth)
 * and NOT from the pre-move source list either, so a RE-RUN's index includes
 * entries a PRIOR run already archived, not just this run's (design row 11).
 *
 * Each entry's summary link is resolved via `resolveQuickTaskSummaryFile`
 * (audit.cts) — the SAME rule `scanQuickTasks` uses to read a task's record
 * — imported rather than re-derived, so the read and write paths can never
 * disagree about which file is a task's summary. A task WITHOUT a summary is
 * still listed, just without a link — never omitted (an omission would
 * under-report the index, which is worse than an unlinked entry).
 *
 * Entries are sorted for deterministic output. A directory name containing
 * `|`, `[`, `]` or an embedded newline is neutralized via
 * `escapeMarkdownLinkText` (link TEXT) so it cannot break the generated
 * markdown or inject a heading — applied here, at build time, so `entries`
 * itself already carries the injection-safe name (the regression test
 * asserts on THIS, not on rendered output). The destination is separately
 * encoded via `encodeMarkdownLinkTarget` (link TARGET) at RENDER time, so a
 * space/paren/control char in the name cannot truncate or corrupt the
 * `(...)` span. The summary path is normalized to POSIX
 * (`.split(path.sep).join('/')`) so the link is stable across platforms.
 *
 * Throws when `archiveQuickDir` is unreadable — the caller (`writeQuickArchiveReadme`)
 * is the best-effort boundary, not this builder.
 */
function buildQuickArchiveIndex(archiveQuickDir: string): QuickArchiveIndex {
  const dirEntries = fs.readdirSync(archiveQuickDir, { withFileTypes: true });
  const dirNames = dirEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const entries: QuickArchiveIndexEntry[] = dirNames.map((dirName) => {
    const taskDir = path.join(archiveQuickDir, dirName);
    const summaryPath = resolveQuickTaskSummaryFile(taskDir, dirName);
    const escapedName = escapeMarkdownLinkText(dirName);
    if (summaryPath) {
      const relSummary = path.relative(archiveQuickDir, summaryPath).split(path.sep).join('/');
      return { name: escapedName, summary: relSummary };
    }
    // No summary file — list the directory, but never link into it (there
    // is nothing to point at). See indexListsTaskWithoutSummaryWithoutLink.
    return { name: escapedName, summary: null };
  });

  return {
    entries,
    render(): string {
      const lines: string[] = ['# Archived Quick Tasks', ''];
      for (const entry of entries) {
        if (entry.summary !== null) {
          lines.push(`- [${entry.name}](${encodeMarkdownLinkTarget(entry.summary)})`);
        } else {
          lines.push(`- ${entry.name}`);
        }
      }
      lines.push('');
      return lines.join('\n');
    },
  };
}

/**
 * #2142: thin writer — calls `buildQuickArchiveIndex` and writes its
 * `render()` output to `<archiveQuickDir>/README.md`. No-ops (writes
 * nothing) when `archiveQuickDir` is unreadable — this is a best-effort
 * index, not a gate on milestone completion. #2142 MAJOR 4 (review): the
 * whole body is wrapped in a try/catch so a failure of the WRITE itself
 * (read-only archive dir, full disk, or a quick-task directory literally
 * named `README.md` colliding with the file being written) degrades the same
 * way — this function genuinely cannot throw, matching its own
 * "best-effort, not a gate" contract; the directories are already safely
 * archived by the time this runs.
 */
function writeQuickArchiveReadme(archiveQuickDir: string): void {
  try {
    const index = buildQuickArchiveIndex(archiveQuickDir);
    platformWriteSync(path.join(archiveQuickDir, 'README.md'), index.render());
  } catch {
    /* best-effort (#2142 MAJOR 4): a read-only archive dir, a full disk, or a
     * quick-task directory literally named `README.md` colliding with the
     * file this function writes must never crash `milestone complete` —
     * the quick-task directories are already safely archived on disk by the
     * time this index-generation step runs. */
  }
}

/**
 * #2142 MAJOR 5 (review): the single owned selection rule for "which
 * directories under `.planning/quick/` would/will move" — directory entries
 * only (symlinks are excluded here, per the MAJOR 3 note above), each
 * additionally guarded with `requireSafePath` (the same guard
 * `scanQuickTasks`/`archiveQuickTaskDirectories` use), sorted for
 * deterministic output. Extracted so `cmdMilestoneComplete`'s dry-run
 * preview, `cmdQuickArchive`'s dry-run preview, and the REAL selection inside
 * `archiveQuickTaskDirectories` all call this ONE function instead of each
 * re-deriving the rule — the "Generative Fix Divergence" anti-pattern this
 * repo explicitly guards against (a prior version of this code had the rule
 * written three times, and only the real-run copy applied `requireSafePath`,
 * so a dry-run preview could list a directory the real run would silently
 * skip).
 */
function listQuickTaskDirsForArchive(cwd: string): string[] {
  const planningBase = planningPaths(cwd).planning;
  const quickDir = planningPaths(cwd).quick;
  let sourceEntries: fs.Dirent[];
  try {
    sourceEntries = fs.readdirSync(quickDir, { withFileTypes: true });
  } catch {
    // .planning/quick absent or unreadable — nothing to select.
    return [];
  }
  const names: string[] = [];
  for (const entry of sourceEntries) {
    if (!entry.isDirectory()) continue; // excludes symlinks too — see MAJOR 3 note above
    try {
      requireSafePath(path.join(quickDir, entry.name), planningBase, 'quick task dir', { allowAbsolute: true });
    } catch {
      continue; // symlink/escape attempt — never a candidate, in preview OR real run
    }
    names.push(entry.name);
  }
  return names.sort();
}

/**
 * #2142: move each DIRECTORY entry under `.planning/quick/` into
 * `milestones/<version>-quick/` (collision-safe), then (re)write that
 * archive directory's README.md index. Sibling of `archivePhaseDirectories`
 * — extracted rather than inlined into `cmdMilestoneComplete` (already
 * cyclomatic 61) — mirroring its collision-safe destination-suffix loop,
 * `retryRenameSync`, and `platformEnsureDir` usage.
 *
 * `version` is ALREADY validated by `ARCHIVE_VERSION_LABEL_RE` at
 * `cmdMilestoneComplete`'s entry — this helper does not re-validate it, and
 * must only ever be called after that guard has run.
 *
 * #2142 MAJOR 3 (review): a symlink under `.planning/quick/` — even one that
 * targets a directory — is excluded by the `dirEntries` filter below
 * (`fs.Dirent.isDirectory()` returns FALSE for a symlink, regardless of what
 * it points at), so it is never a candidate `entry` in the first place and
 * `requireSafePath` below never runs against it. `requireSafePath` is
 * retained here as defense-in-depth for the NON-symlink path (a real
 * directory entry whose resolved path still needs re-validating against
 * `planningBase`) — the SAME guard `scanQuickTasks` (audit.cts) uses — so an
 * entry that fails it is skipped, never archived, never counted. See the
 * symlink regression tests in tests/milestone-archive.test.cjs
 * (`symlinkEscapeIsNeverArchivedByMilestoneComplete` /
 * `symlinkEscapeIsNeverArchivedByQuickArchive`) for a fixture proving neither
 * the symlink nor its external target is ever moved or altered — added
 * specifically so a future change to this filter cannot silently reopen the
 * escape with nothing to catch it.
 *
 * No-op (returns `{archived: 0, entries: []}`, creates NOTHING on disk) when
 * `.planning/quick/` does not exist or contains zero DIRECTORY entries — a
 * stray file with no sibling directory is neither an empty-dir case nor an
 * archive case.
 *
 * A mid-loop rename failure (or a failure to create the archive directory
 * itself) does not crash `milestone complete` — it degrades to whatever
 * `archived`/`entries` had already accumulated before the failure, mirroring
 * the `archivedCount` finally-pattern `cmdMilestoneComplete`'s own phase
 * archival uses a few hundred lines above (so a partial archive reports the
 * TRUE count, never a false `0`/`false`).
 */
function archiveQuickTaskDirectories(cwd: string, version: string): { archiveDir: string; archived: number; entries: string[] } {
  const planningBase = planningPaths(cwd).planning;
  const quickDir = planningPaths(cwd).quick;
  const archiveQuickDir = path.join(planningBase, 'milestones', `${version}-quick`);

  // #2142 MAJOR 5 (review): dirNames is the SAME selection
  // `listQuickTaskDirsForArchive` hands to both dry-run previews — this is
  // the real run, so it cannot disagree with what a preview reported.
  const dirNames = listQuickTaskDirsForArchive(cwd);
  if (dirNames.length === 0) {
    // Boundary 0 (#2142): zero (safe) directory entries (empty dir, only
    // stray files, or every entry excluded by the selection rule) must not
    // create the archive directory. Also covers `.planning/quick/` being
    // absent/unreadable — `listQuickTaskDirsForArchive` degrades to `[]`.
    return { archiveDir: archiveQuickDir, archived: 0, entries: [] };
  }

  let archived = 0;
  const entries: string[] = [];
  try {
    platformEnsureDir(archiveQuickDir);
    for (const name of dirNames) {
      const src = path.join(quickDir, name);
      let safeSrc: string;
      try {
        // Re-validated here (not just trusted from the selection above) as
        // TOCTOU defense-in-depth: `listQuickTaskDirsForArchive` and this
        // rename are two separate filesystem observations, and an entry
        // that was a safe real directory at selection time could in theory
        // be swapped for a symlink before this loop reaches it.
        safeSrc = requireSafePath(src, planningBase, 'quick task dir', { allowAbsolute: true });
      } catch {
        continue; // symlink/escape attempt — skip, not archived
      }

      // Collision-safe: if a same-named archive entry exists (re-run), suffix it.
      let dest = path.join(archiveQuickDir, name);
      let destName = name;
      let n = 1;
      while (fs.existsSync(dest)) {
        destName = `${name}.${n++}`;
        dest = path.join(archiveQuickDir, destName);
      }
      retryRenameSync(safeSrc, dest);
      archived++;
      entries.push(destName);
    }
  } catch {
    /* best-effort: platformEnsureDir failed, or the rename loop failed
     * partway — `archived`/`entries` above already reflect exactly what
     * succeeded before the failure (accumulated incrementally, never lost
     * with the swallowed exception — mirrors the archivedCount pattern at
     * cmdMilestoneComplete's phase-archival block). */
  }

  // Regenerate the README from whatever is ACTUALLY on disk now — covers
  // both a clean full archive and a degraded partial one, and (on a re-run)
  // includes entries a PRIOR run already archived. Skipped only when the
  // archive directory itself was never created (ensureDir failed above).
  if (fs.existsSync(archiveQuickDir)) {
    writeQuickArchiveReadme(archiveQuickDir);
  }

  return { archiveDir: archiveQuickDir, archived, entries };
}

interface QuickArchiveOptions {
  dryRun?: boolean;
}

/**
 * #2142 escalation: `milestone.archive-quick` (CLI: `milestone archive-quick`,
 * renamed from the original `quick.archive` per code-review FIX 1 — folded
 * under the existing `milestone` namespace rather than adding a new top-level
 * command) — the narrow archival helper the issue's own "Scope of changes"
 * anticipated ("a `quick.archive`-style routine"), for callers (chiefly
 * `gsd-core/workflows/cleanup.md`) that need to sweep
 * `.planning/quick/*` WITHOUT the full `milestone complete` close-out.
 *
 * `milestone complete --archive-quick` cannot be reused for this: it
 * hard-errors via `missingExplicitVersion` for an already-completed
 * milestone (no `### Phase N:` headings left in its ROADMAP window),
 * re-archives ROADMAP.md over the very snapshot cleanup depends on, and
 * appends a duplicate MILESTONES.md entry on every re-run.
 *
 * This command performs ONLY the two things `archiveQuickTaskDirectories`
 * already does (move `.planning/quick/*` dirs into
 * `milestones/<version>-quick/` + (re)write that archive's README index —
 * the SAME helper `cmdMilestoneComplete` calls, so the two entry points can
 * never diverge on step 1) plus a Quick Tasks Completed table reset. It
 * NEVER touches ROADMAP.md, REQUIREMENTS.md, or MILESTONES.md, and runs
 * NEITHER the unstarted-phase guard NOR the milestone-window/TRUNCATED
 * refusal — those remain `milestone complete`'s alone.
 *
 * #2142 MAJOR 6 (review): the STATE.md write now routes through
 * `readModifyWriteStateMd` — the same owned read-transform-write composition
 * `gsd-tools.cjs`'s `quick-tasks-append` handler uses (ADR-3408 §8.3 / #3469:
 * "the single owned composition ... so the composition cannot diverge"). A
 * prior version of this function called `platformWriteSync` directly with
 * the reset result, bypassing `syncAndPreserveStateMd` entirely — the exact
 * bypass shape that ADR closed. Per `src/state.cts:3289-3330`,
 * `readModifyWriteStateMd` ALREADY acquires its own exclusive lock
 * (`acquireStateLock`/`releaseStateLock`, a real `O_CREAT|O_EXCL` file lock,
 * not reentrant) across its own read -> transform -> write cycle — so, unlike
 * `cmdMilestoneComplete` (which folds the table reset into its own
 * pre-existing `withStateLock` transform because it ALSO needs that lock for
 * the closure-transition write happening in the same block), this function
 * must NOT wrap the call in its own `withStateLock`: doing so would acquire
 * the same lock file twice in the same process, and the second acquire would
 * spin against a lock this same call already holds until it times out.
 */
function cmdQuickArchive(cwd: string, version: string, options: QuickArchiveOptions, raw: boolean): void {
  if (!version) {
    error('version required for milestone.archive-quick (e.g., v1.0)');
  }
  // #2288-class security: `version` becomes a filesystem directory component
  // (`milestones/<version>-quick/`) that directories are MOVED into — same
  // guard + wording shape `cmdMilestoneComplete` uses for its own version arg.
  if (!ARCHIVE_VERSION_LABEL_RE.test(version)) {
    error(`milestone.archive-quick: version "${version}" is invalid — a milestone version label may contain only letters, digits, '.', '-' and '_', and must not contain path separators or "..".`);
  }

  const statePath = planningPaths(cwd).state;
  const planningBase = planningPaths(cwd).planning;
  const toPosixRel = (p: string): string => path.relative(cwd, p).split(path.sep).join('/');

  // --dry-run: preview only, mutates nothing. #2142 MAJOR 5 (review): routed
  // through the SAME `listQuickTaskDirsForArchive` selection
  // `cmdMilestoneComplete`'s own dry-run preview and the real
  // `archiveQuickTaskDirectories` both use, so all three can never disagree.
  if (options.dryRun) {
    const quickDirsToArchive: string[] = listQuickTaskDirsForArchive(cwd);
    output(
      {
        dry_run: true,
        version,
        would_archive: quickDirsToArchive,
        archive_dir: toPosixRel(path.join(planningBase, 'milestones', `${version}-quick`)),
      },
      raw,
    );
    return;
  }

  const quickArchiveResult = archiveQuickTaskDirectories(cwd, version);
  const warnings: Array<{ field: string; reason: string }> = [];
  let stateUpdated = false;

  // Same silent/surfaced rule `cmdMilestoneComplete` applies: only attempt
  // the reset when something actually moved, and treat the
  // QUICK_TASKS_SECTION_ABSENT sentinel as a silent no-op (the section is
  // created lazily by quick.md Step 7b and absent from templates/state.md,
  // so absence is the common case, not an anomaly). Any other reset failure
  // is surfaced via `warnings`, never thrown.
  //
  // #2142 MAJOR 6 (review): routed through `readModifyWriteStateMd` (see the
  // docstring above) instead of a bare `platformWriteSync` — the transform
  // returns the ORIGINAL content unchanged whenever the reset did not apply
  // (sentinel-absent or a genuine failure), so `readModifyWriteStateMd`'s own
  // no-op guard (#948, state.cts:3304) skips the write and its `false`
  // return accurately reports "nothing was written" — the same "state_updated
  // must report accurately" contract the prior direct-write version upheld.
  if (quickArchiveResult.archived > 0 && fs.existsSync(statePath)) {
    let resetWarning: { field: string; reason: string } | null = null;
    stateUpdated = readModifyWriteStateMd(
      statePath,
      (content: string) => {
        const { content: nextContent, warning } = applyQuickTasksReset(content);
        resetWarning = warning;
        return nextContent;
      },
      cwd,
    );
    if (resetWarning) {
      warnings.push(resetWarning);
    }
  }

  output(
    {
      version,
      archived: quickArchiveResult.archived,
      entries: quickArchiveResult.entries,
      archive_dir: toPosixRel(quickArchiveResult.archiveDir),
      state_updated: stateUpdated,
      warnings,
    },
    raw,
    `${quickArchiveResult.archived} quick task director${quickArchiveResult.archived === 1 ? 'y' : 'ies'} archived`,
  );
}

export = {
  cmdRequirementsMarkComplete,
  cmdRequirementsReadyIds,
  cmdRequirementsRevertPhase,
  cmdMilestoneComplete,
  cmdPhasesClear,
  cmdQuickArchive,
  buildQuickArchiveIndex,
};
