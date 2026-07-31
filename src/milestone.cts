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
import { platformWriteSync, platformEnsureDir, execGit, retryRenameSync } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { writeSetComplete } from './write-set.cjs';
import type { WriteSet } from './write-set.cjs';
import { updateTableCell } from './markdown-table.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, phaseTokenMatches, PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter, extractCurrentMilestone, getMilestoneInfo } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { extractOneLinerFromBody } = coreUtilsMod;
const { planningPaths } = planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
const { writeStateMd } = stateMod;

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
  const phaseDir = path.dirname(planAbsPath);
  const currentBasename = path.basename(planAbsPath);

  let siblingPlanFiles: string[] = [];
  try {
    siblingPlanFiles = fs
      .readdirSync(phaseDir)
      .filter((f) => f.endsWith('-PLAN.md') && f !== currentBasename);
  } catch {
    siblingPlanFiles = [];
  }

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
      // SUMMARY) before this ID is ready to mark Complete.
      const siblingSummaryPath = siblingPath.replace(/-PLAN\.md$/, '-SUMMARY.md');
      if (!fs.existsSync(siblingSummaryPath)) {
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

  // Ensure archive directory exists (skipped in dry-run — no mutations)
  if (!options.dryRun) {
    platformEnsureDir(archiveDir);
  }

  // Scope stats and accomplishments to only the phases belonging to the
  // current milestone's ROADMAP.  Uses the shared filter from roadmap-parser.cjs
  // (same logic used by cmdPhasesList and other callers).
  const isDirInMilestone = getMilestonePhaseFilter(cwd, version);
  if (isDirInMilestone.missingExplicitVersion) {
    error(`no phases found for milestone ${version} in ROADMAP.md`);
  }

  // Guard: prevent marking complete when ROADMAP still lists phases that have
  // no directory on disk (disk_status: no_directory). This catches the case
  // where the active milestone was erroneously marked complete before phases
  // were even started. Only fires when STATE.md confirms the current milestone
  // version matches what is being completed — no false positives on fresh
  // projects where phases haven't been scaffolded yet.
  // Pass --force to override this guard.
  if (!options.force) {
    try {
      // Only guard when STATE.md's milestone field matches the version being completed.
      let stateVersion: string | null = null;
      try {
        const stateRaw = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : null;
        if (stateRaw) {
          const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
          if (milestoneMatch) stateVersion = milestoneMatch[1].trim();
        }
      } catch {
        /* skip */
      }

      if (stateVersion && stateVersion === version) {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const scopedContent = extractCurrentMilestone(roadmapContent, cwd);
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
          const major = parseInt(phaseNum, 10);
          if (major === 0 || major === 999) continue;
          const normalized = normalizePhaseName(phaseNum);
          // A phase has disk_status: 'no_directory' when no phase directory
          // with a matching token exists on disk. Use the same phaseTokenMatches
          // helper that roadmap.analyze uses to avoid false positives on decimal
          // (2.1) and letter-suffix (12A) phase IDs.
          const hasDirectory = phaseDirEntries.some((d) => phaseTokenMatches(d, normalized));
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
      }
    } catch (e) {
      // If the error came from our guard, re-throw it; otherwise skip silently.
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.startsWith('Cannot mark milestone complete:')) throw e;
      // Phase scan failed or STATE version mismatch — allow completion to proceed.
    }
  }

  // Gather stats from phases (scoped to current milestone only)
  let phaseCount = 0;
  let totalPlans = 0;
  let totalTasks = 0;
  const accomplishments: string[] = [];

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dir of dirs) {
      if (!isDirInMilestone(dir)) continue;

      phaseCount++;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md');
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
      totalPlans += plans.length;

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
      try {
        const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && isDirInMilestone(e.name)) {
            phaseDirsToArchive.push(e.name);
          }
        }
      } catch { /* phasesDir missing — nothing to archive */ }
    }
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
      },
      would_update: {
        milestones_md: path.relative(cwd, milestonesPath).split(path.sep).join('/'),
        state_md: fs.existsSync(statePath) ? path.relative(cwd, statePath).split(path.sep).join('/') : null,
      },
    };
    output(dryRunResult, raw);
    return;
  }

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
      const headerMatch = existing.match(/^(#{1,3}\s+[^\n]*\n\n?)/);
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

  // Update STATE.md — keep frontmatter/body semantically aligned after closure.
  // ADR-1769 Phase 5: dispatches to the STATE.md Transition Module. The closure
  // write (Status, Last Activity, Last Activity Description, Current Position
  // reset, Operator Next Steps reset) is the pure `milestoneCompleteCore` in
  // src/state-transition.cts, backed by the field-classification table. The
  // runtime-specific next-milestone slash command is resolved here and injected
  // via the intent so the core stays pure. writeStateMd still owns the lock and
  // the steady-state syncStateFrontmatter post-sync.
  if (fs.existsSync(statePath)) {
    const result = transitionCore(
      fs.readFileSync(statePath, 'utf-8'),
      {
        kind: 'milestoneComplete',
        version,
        nextMilestoneCommand: formatGsdSlash('new-milestone', resolveRuntime(cwd)) as string,
      },
      { clock: realClock, progressProvider: () => null, sourcePath: statePath },
    );
    writeStateMd(statePath, result.content, cwd);
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

      const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const phaseDirNames = phaseEntries.filter((e) => e.isDirectory()).map((e) => e.name);
      for (const dir of phaseDirNames) {
        if (!isDirInMilestone(dir)) continue;
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
    },
    milestones_updated: true,
    state_updated: fs.existsSync(statePath),
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
    const dirs = entries.filter((e) => e.isDirectory() && !/^999(?:\.|$)/.test(e.name));

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
      const liveVersion = getMilestoneInfo(cwd).version ?? null;
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

export = {
  cmdRequirementsMarkComplete,
  cmdRequirementsReadyIds,
  cmdRequirementsRevertPhase,
  cmdMilestoneComplete,
  cmdPhasesClear,
};
