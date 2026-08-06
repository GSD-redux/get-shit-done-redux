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
import { buildWorkstreamInventory, isCompletedInventory, pickRollupWinners } from './workstream-inventory-builder.cjs';
import type { WorkstreamInventory, StateProjection, MilestoneShippedSignal } from './workstream-inventory-builder.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhaseFileCounts {
  planCount: number;
  summaryCount: number;
}

interface InspectWorkstreamOptions {
  active?: string | null;
  /**
   * #3057 B3: injectable diagnostic-write seam, mirrored from
   * cmdGitBaseBranch's `writeDiagnostic` (git-base-branch.cts). Called with a
   * stderr-style line when a phase's readVerificationStatus staleness check
   * could not run to completion — WorkstreamInventory's own return shape
   * (`phases: PhaseStatus[]`) has no per-phase verification detail today, so
   * this side channel surfaces the fact without widening that aggregate type.
   * The second argument carries the same facts as structured, typed data
   * (CONTRIBUTING: no raw-text matching on produced diagnostics) so a caller
   * — tests included — can assert on `phaseDir`/`reason` directly instead of
   * pattern-matching the operator-facing `message`. The default
   * implementation writes only `message` to stderr; operator output is
   * unchanged. Never affects routing: the ledger / rollup computation below
   * is unchanged either way (the pre-existing fail-open contract).
   */
  writeDiagnostic?: (message: string, meta: { phaseDir: string; reason: string }) => void;
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

// ─── #2645: verification-deletion ledger ───────────────────────────────────
//
// #2562's completeness gate (`FAILING_VERIFICATION_STATUSES`,
// workstream-inventory-builder.cts) reads a phase's verification verdict
// fresh from `*-VERIFICATION.md` on every call. That makes "verifier ran,
// found gaps, report later deleted" indistinguishable from "verifier never
// ran" — both collapse to the same `'missing'` sentinel
// (verification.cts's `missingResult()`), which is deliberately NOT in the
// failing set (so verifier-disabled projects can still reach 100%). Deleting
// a failing report is therefore sufficient to silently raise the reported
// completion percentage — a Goodhart hole (#2645).
//
// The fix persists the last REAL (non-'missing') verdict this module has
// ever observed per phase key, in a small ledger file living at the
// WORKSTREAM directory level — never inside the phase directory whose file
// is the thing being deleted, so the same `rm` that triggers the hole
// cannot also erase the memory of it. When a live read comes back 'missing',
// the ledger is consulted as a fallback; when a live read comes back with a
// real verdict — including a later 'passed' that supersedes an earlier
// failing one — the ledger is updated to match, so a genuinely re-verified
// phase is never permanently pinned.
//
// #2645 review: a NAIVE two-state read ("got entries, or nothing") fails
// OPEN — any read/parse failure degraded to `{}`, which is indistinguishable
// from "genuinely never verified", so corrupting the ledger (or deleting it
// alongside the report) silently reopened the exact hole this fix exists to
// close, one level up. THREE states, not two:
//
//   1. `'absent'`  — no `.verification-ledger.json` for this workstream at
//      all. This is the ONLY state that behaves exactly as pre-#2645 (a
//      phase with no live report reads `'missing'`, ungated). Deliberate:
//      on the day this ships, EVERY existing project is in this state for
//      EVERY workstream, and gating here would drop them all to
//      `in_progress` at once. A workstream stays here forever if the
//      verifier is never actually used on it (criterion 2/3 — no entry is
//      ever written for a `'missing'` live read, so the file itself is
//      never created).
//   2. `'corrupt'` — the file exists but could not be read or parsed (I/O
//      error, invalid JSON, wrong shape). This is NOT the same as absent:
//      an unreadable file is evidence something existed. Treated identically
//      to "present, no entry for this phase" below — fails CLOSED, not open.
//   3. `'ok'`      — the file exists and parsed. A phase with an entry uses
//      it; a phase WITHOUT one is "present, no entry" — this workstream has
//      adopted the ledger (some phase in it has a real verdict on record),
//      so an unobserved phase can no longer default to the pre-adoption
//      "ungated" behavior, or the same evidence-erasure hole reopens for
//      THIS phase specifically. Fails CLOSED: resolves to the `'unrecorded'`
//      sentinel (`workstream-inventory-builder.cts`'s
//      `FAILING_VERIFICATION_STATUSES`), not `'missing'`.
//
// Corrupt-ledger recovery: a corrupt ledger is NOT a permanent wedge. Any
// phase with a REAL live verdict on disk still writes/repairs the ledger on
// this same call (the corrupt content is fully overwritten, never patched),
// so re-running the verifier for even one phase heals the file. A phase with
// no live report and no way to re-verify stays `'unrecorded'` (gated) until
// someone re-verifies it — a deliberate, disclosed cost of failing closed,
// not an accidental one.
//
// Disclosed, ACCEPTED residual gap (not closed by this fix, and not closable
// by ledger design alone): deleting the ledger FILE ITSELF (not just the
// phase's report) returns a workstream to state 1 (`'absent'`) and restores
// pre-#2645 behavior for it. Any durable store that can fail open when
// absent has this property at its own root — the ledger raises the bar from
// "delete one file" to "delete two files in two different directories,
// including one this issue's own reproduction never needed to touch", but a
// deliberately absent ledger is indistinguishable from a never-adopted one
// by design (criterion 2/3 depend on that same indistinguishability). Rail B
// is PROSPECTIVE ONLY: a phase verified and its report deleted BEFORE this
// fix ships has no ledger entry to fall back on and cannot be retroactively
// recovered.
interface VerificationLedger { [phaseKey: string]: string; }

interface VerificationLedgerRead {
  state: 'absent' | 'corrupt' | 'ok';
  entries: VerificationLedger;
}

function verificationLedgerPath(wsDir: string): string {
  return path.join(wsDir, '.verification-ledger.json');
}

function readVerificationLedger(wsDir: string): VerificationLedgerRead {
  const ledgerPath = verificationLedgerPath(wsDir);
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf-8');
  } catch (err) {
    // `fs.readFileSync` FOLLOWS symlinks, so a broken symlink at this path
    // (the entry exists, its target does not) reports the EXACT SAME
    // `ENOENT` as genuine absence — `code` alone cannot distinguish
    // "nothing was ever here" from "something is here and cannot be read".
    // `fs.lstatSync` does NOT follow symlinks, so it still finds the
    // symlink entry itself even when its target is gone. Only when NEITHER
    // call finds anything is this genuinely `'absent'` (pre-adoption); a
    // present-but-broken symlink is evidence something existed and must
    // fail CLOSED like any other unreadable ledger, not fall open.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      try {
        fs.lstatSync(ledgerPath);
        return { state: 'corrupt', entries: {} }; // a symlink entry exists; its target does not
      } catch (lstatErr) {
        // #2645 review: every OTHER failure path in this function fails
        // CLOSED — this one must too. A failed `lstatSync` is only proof of
        // absence when IT ALSO reports `ENOENT`; anything else (a raced
        // permission change, a path component that became inaccessible
        // between the two calls, …) is not evidence the file was never
        // there, and a bare `catch {}` here would silently fall OPEN exactly
        // like the two-state design this fix replaced.
        const lstatCode = (lstatErr as NodeJS.ErrnoException)?.code;
        if (lstatCode === 'ENOENT') return { state: 'absent', entries: {} }; // truly nothing at this path
        return { state: 'corrupt', entries: {} };
      }
    }
    // Any OTHER read failure (EACCES, EISDIR, …) also means the path EXISTS
    // in some form but this process cannot see its content right now — that
    // is corruption from this reader's point of view, not absence, and must
    // fail closed rather than silently falling back to the ungated
    // pre-adoption behavior.
    return { state: 'corrupt', entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', entries: {} };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'corrupt', entries: {} };
  }
  const out: VerificationLedger = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return { state: 'ok', entries: out };
}

// #2645 review: Windows can transiently hold the rename target busy (AV
// scanners, indexers) — the SAME retry shape `broken-windows.cts`'s
// `writeLedgerAtomic`/`renameWithRetry` already uses for its own ledger
// write, mirrored here rather than imported (that function is private to
// its module) so this fix does not widen its own blast radius by exporting
// a new cross-module utility.
const LEDGER_RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LEDGER_RENAME_MAX_ATTEMPTS = 5;
const LEDGER_RENAME_BACKOFF_MS = 25;

function renameVerificationLedgerWithRetry(tmpPath: string, finalPath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LEDGER_RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, finalPath);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err && typeof err === 'object' && 'code' in err) ? String((err as { code?: unknown }).code) : '';
      if (code && LEDGER_RENAME_RETRY_ERRNOS.has(code) && attempt < LEDGER_RENAME_MAX_ATTEMPTS - 1) {
        // Exponential-ish backoff: 25ms, 50ms, 100ms, 200ms. Transient
        // Windows locks usually clear well inside that window.
        const delay = LEDGER_RENAME_BACKOFF_MS * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // Deliberate short busy-wait — no async/timer seam is available
          // in this synchronous read path.
        }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function writeVerificationLedger(wsDir: string, ledger: VerificationLedger): void {
  // #2645 review: atomic write. A crash or a concurrent read mid-write
  // against `verificationLedgerPath(wsDir)` directly would leave (or briefly
  // expose) TRUNCATED JSON — and now that `'corrupt'` carries real semantic
  // weight (it fails CLOSED, holding every phase with no live report at
  // `'unrecorded'`), producing a corrupt file ourselves is a self-inflicted
  // version of the exact failure mode this fix exists to survive. Write to a
  // sibling temp file in the SAME directory (same filesystem — `rename` is
  // only atomic within one) and rename into place: a reader can only ever
  // observe the prior complete content or the new complete content.
  const finalPath = verificationLedgerPath(wsDir);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
    renameVerificationLedgerWithRetry(tmpPath, finalPath);
  } catch {
    // Best-effort persistence: a missing parent directory that `mkdirSync`
    // itself cannot create, a read-only filesystem, a write failure, or a
    // rename failure that exhausts its retries must not break inventory
    // reads, which are otherwise pure. Losing this observation only
    // re-opens the pre-#2645 window for THIS run; the next successful read
    // while a report is on disk repairs it. Clean up a half-written temp
    // file so repeated failures cannot accumulate orphaned
    // `.verification-ledger.json.<pid>.tmp` files.
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up, or cleanup itself failed — not fatal */ }
  }
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
  const writeDiagnostic = options.writeDiagnostic ?? ((message: string) => process.stderr.write(message));
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
  //
  // #2645 review: built from `[...phaseDirNames].sort()`, NOT the raw
  // `phaseDirNames` (unsorted `readdirSync` order — `readSubdirectories`'s
  // default). `buildWorkstreamInventory`'s own de-dup (`rollupDirByKey`,
  // workstream-inventory-builder.cts) iterates the SAME sorted order; the
  // ledger-winner tie-break below (incumbent wins unless a later entry has a
  // STRICTLY newer mtime) only agrees with the builder's winner on an exact
  // mtime tie if both walk entries in the same order. Iterating unsorted
  // input here let the two independently pick different "winning"
  // directories for one phase key on a tie — reopening the stale-duplicate-
  // clobbers-live-verdict hole criterion 4 exists to close.
  const rawPhaseEntries = [...phaseDirNames].sort().map(dir => {
    const phaseDir = path.join(p.phases, dir);
    const counts = countPhaseFiles(phaseDir);
    const verificationResult = readVerificationStatus(phaseDir);
    // #3057 B3: routing is UNCHANGED — `liveVerificationStatus` below is still
    // `.status`, exactly as before, so the ledger/rollup logic that consumes
    // it is unaffected. This only makes an indeterminate staleness check
    // visible (stderr), matching cmdGitBaseBranch's own non-blocking
    // unverified-fallback diagnostic (#3057 B4) — the closest existing idiom,
    // since `WorkstreamInventory`'s aggregate return shape carries no
    // per-phase verification detail for this to attach to.
    if (verificationResult.staleCheckIndeterminate) {
      writeDiagnostic(
        `⚠ workstream-inventory: verification staleness check could not complete for phase directory '${dir}' in workstream '${name}' — routed as not-stale, but this was not actually verified. See #3057.\n`,
        { phaseDir: dir, reason: 'staleCheckIndeterminate' },
      );
    }
    return {
      directory: dir,
      phaseKey: phaseKeyFromDir(dir),
      mtimeMs: phaseDirMtime(phaseDir),
      planCount: counts.planCount,
      summaryCount: counts.summaryCount,
      inMilestone: isDirInCurrentMilestone(dir),
      liveVerificationStatus: verificationResult.status,
    };
  });

  // #2645: only the directory Bug #2445's de-dup rollup would actually pick
  // for a phase key may read or write that key's ledger entry. Letting every
  // same-keyed directory (including a stale leftover) write would let a
  // stale duplicate's stale verdict clobber the live directory's remembered
  // one.
  //
  // #2645 review — CORRECTED: an earlier version of this comment claimed the
  // milestone-scoping exclusion (`scoped && entry.inMilestone === false`)
  // was safe to drop here as "out of scope", and hand-wrote a scoping-free
  // tie-break rule. That was a real bug, not a scope call: in a SCOPED
  // workstream, a stale OUT-of-milestone directory sharing a phase key with
  // the live IN-milestone one can have a newer mtime (plausible after a
  // checkout/rebase resets mtimes) and would then win THIS selection while
  // the builder's own `rollupDirByKey` — which DOES apply the scoping filter
  // — picks the live directory instead. `isLedgerWinner` would then be false
  // for the live directory, so deleting ITS `*-VERIFICATION.md` would never
  // consult the ledger and would reopen #2645's exact hole for the phase
  // that actually counts toward `completed_phases` — reachable with a plain
  // `rm`, no ledger tampering required. Fixed by calling the SAME shared
  // `pickRollupWinners` the builder's `rollupDirByKey` now also calls, with
  // the identical scoping filter, rather than a second hand-written copy.
  const ledgerWinnerByKey = pickRollupWinners(
    rawPhaseEntries,
    (entry) => entry.phaseKey,
    (entry) => entry.mtimeMs,
    (entry) => !(scoped && entry.inMilestone === false),
  );

  const ledgerRead = readVerificationLedger(wsDir);
  // Both `'corrupt'` and `'ok'` start from whatever entries could actually be
  // trusted (empty for `'corrupt'` — nothing in an unparseable file is
  // trusted) and get REPAIRED below by any real verdict this call observes;
  // only `'absent'` skips the ledger mechanism entirely (pre-adoption).
  const verificationLedger = ledgerRead.entries;
  let ledgerDirty = false;
  for (const winner of ledgerWinnerByKey.values()) {
    if (winner.liveVerificationStatus === 'missing') continue;
    if (verificationLedger[winner.phaseKey] !== winner.liveVerificationStatus) {
      verificationLedger[winner.phaseKey] = winner.liveVerificationStatus;
      ledgerDirty = true;
    }
  }
  // A `'corrupt'` read that observes no real verdict this call has nothing to
  // repair with — writing an empty `{}` would DESTROY whatever the corrupt
  // file's bytes might still hold (a human could recover it by hand; this
  // fix must not foreclose that). Only write when there is something real to
  // persist, exactly as for `'absent'`/`'ok'`.
  if (ledgerDirty) writeVerificationLedger(wsDir, verificationLedger);

  const phaseFilesCounts = rawPhaseEntries.map(entry => {
    const isLedgerWinner = ledgerWinnerByKey.get(entry.phaseKey) === entry;
    let verificationStatus = entry.liveVerificationStatus;
    if (entry.liveVerificationStatus === 'missing' && isLedgerWinner) {
      if (ledgerRead.state === 'absent') {
        // State 1: pre-adoption. Exactly today's behavior — 'missing' is
        // NOT in FAILING_VERIFICATION_STATUSES, so this does not gate.
        verificationStatus = 'missing';
      } else {
        // States 2/3 ('corrupt' or 'ok'): this workstream has adopted the
        // ledger. A remembered entry wins; no entry fails CLOSED to the
        // 'unrecorded' sentinel rather than falling open to 'missing'.
        const remembered = verificationLedger[entry.phaseKey];
        verificationStatus = remembered !== undefined ? remembered : 'unrecorded';
      }
    }
    return {
      directory: entry.directory,
      phaseKey: entry.phaseKey,
      mtimeMs: entry.mtimeMs,
      planCount: entry.planCount,
      summaryCount: entry.summaryCount,
      inMilestone: entry.inMilestone,
      verificationStatus,
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
