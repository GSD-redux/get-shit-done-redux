/**
 * UAT Audit — Cross-phase UAT/VERIFICATION scanner
 *
 * Reads all *-UAT.md and *-VERIFICATION.md files across all phases.
 * Extracts non-passing items. Returns structured JSON for workflow consumption.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/uat.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownSectionizer = require('./markdown-sectionizer.cjs');
const { collectSection, tokenizeHeadings, stripFencedCode, scanFencedBlocks } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownTable = require('./markdown-table.cjs');
const { splitTableRow, isDelimiterRow } = markdownTable;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath, normalizeLineEndings } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, frontmatterListEntries, flattenObjectListItem } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE, scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocator = require('./phase-locator.cjs');
const { listMilestonePhaseDirs, getAllArchivedPhaseDirs } = phaseLocator;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import auditMod = require('./audit.cjs');
const { isAuditItemAcknowledged, deriveUatGapSnapshotValue } = auditMod;
import { requireSafePath, sanitizeForDisplay } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoader = require('./config-loader.cjs');
const { loadConfig } = configLoader;

// ─── Types ────────────────────────────────────────────────────────────────────

type UatResult = string;
type UatCategory = 'server_blocked' | 'device_needed' | 'build_needed' | 'third_party' | 'blocked' | 'skipped_unresolved' | 'pending' | 'human_uat' | 'unknown' | 'deferred' | 'issue';

interface UatItem {
  test?: number;
  name: string;
  expected?: string;
  result: UatResult;
  category: UatCategory;
  reason?: string;
  blocked_by?: string;
}

interface UatFileResult {
  phase: string;
  phase_dir: string;
  file: string;
  file_path: string;
  type: 'uat' | 'verification' | 'deferred';
  status: string;
  /**
   * Milestone version whose archive this phase dir was read from
   * (`.planning/milestones/<version>-phases/`), or undefined for a phase still
   * in the active `.planning/phases/` tree. Lets a consumer label provenance
   * instead of presenting archived and in-flight work identically.
   */
  archived_milestone?: string;
  items: UatItem[];
  /**
   * True when this file contained `### N.` test blocks that yielded ZERO
   * items (#3707) — a genuine parse gap (a row missing its `result:` field
   * entirely, or otherwise unrecognised) rather than a file whose every row
   * legitimately passed, or a Gaps-only file with nothing outstanding.
   * Derived from `parseUatItemsWithStats`'s `headingsSeen` counter, NOT from
   * frontmatter `status:` — see that function's doc comment. Distinguishes
   * "nothing to see here" from "something here could not be read" so a file
   * whose test blocks could not be parsed is still surfaced instead of
   * silently vanishing.
   */
  parse_gap?: boolean;
  /**
   * Count of `### N.` test blocks in this file that yielded ZERO items
   * (`headingsSeen` from `parseUatItemsWithStats`) — set alongside `parse_gap`
   * so a MIXED file (some parseable rows, some not) quantifies how many rows
   * are unaccounted for instead of the boolean flag alone. Present only when
   * `parse_gap` is true.
   */
  unparsed_blocks?: number;
}

interface CurrentTest {
  complete: boolean;
  number?: number;
  name?: string;
  expected?: string;
}

// ─── cmdAuditUat ─────────────────────────────────────────────────────────────

/**
 * Select the UAT documents belonging to ONE phase directory.
 *
 * Extracted (#2790) so `cmdAuditUat` and the read-only `planning.inspect` query
 * cannot drift on which files count as this phase's UAT. `scopeToPhase` has no
 * unfiltered fallback on purpose: a phase whose own UAT file is genuinely absent
 * scopes to empty and contributes nothing, rather than picking up a stray
 * cross-phase file (#3511).
 */
function selectPhaseUatFiles(files: string[], phaseDirName: string): string[] {
  return scopeToPhase(files.filter((f) => f.includes('-UAT') && f.endsWith('.md')), phaseDirName);
}

/**
 * The ONE read boundary for every document `cmdAuditUat` scans off disk
 * (#3707-CR follow-up MAJOR). Wraps `fs.readFileSync` +
 * `normalizeLineEndings` in a single seam so a lone-CR-separated
 * `*-UAT.md`, `*-VERIFICATION.md`, or `deferred-items.md` is normalized BY
 * CONSTRUCTION before it reaches ANY downstream parser — current
 * (`parseUatItemsWithStats`, `parseVerificationItems`, `parseDeferredItems`)
 * or future. Fixing this per-parser was the original (#3707-CR) MEDIUM fix's
 * mistake: two of the four ingresses in this function were normalized by
 * editing their own parsers directly, and the other two (VERIFICATION,
 * deferred-items.md) were missed precisely because nothing forced a new call
 * site to remember the step. Routing every read through this function
 * removes that failure mode: a parser added later needs no line-ending logic
 * of its own, because the text it receives is already normalized.
 */
function readNormalizedDocument(filePath: string): string {
  return normalizeLineEndings(fs.readFileSync(filePath, 'utf-8'));
}

function cmdAuditUat(cwd: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const hasActivePhases = fs.existsSync(phasesDir);

  // #2766: on milestone completion `milestone.cts` MOVES each phase dir into
  // `.planning/milestones/<version>-phases/` (archive-by-default since #1871),
  // leaving `.planning/phases/` empty or absent. Scanning only the active tree
  // meant a partly-archived project silently omitted the archived phases, and a
  // fully-archived one hard-errored with "No phases directory found" —
  // indistinguishable from a broken install. Outstanding UAT items do not stop
  // mattering when a milestone closes: a deferred human-UAT scenario or a
  // `skipped` live-stack test is exactly what gets archived still-open.
  //
  // Reuses the canonical `getAllArchivedPhaseDirs` seam (phase-locator.cts), which
  // `findPhaseInternal` already uses for this same fallback, so the archive
  // layout convention stays owned by one module.
  // #3804: the guard AND the scan use the cross-workstream enumeration —
  // a project whose only phases live in workstream milestone trees is a
  // fully-populated audit, not a broken install.
  const archivedDirs = getAllArchivedPhaseDirs(cwd);
  if (!hasActivePhases && archivedDirs.length === 0) {
    error('No phases directory found in planning directory');
  }

  const results: UatFileResult[] = [];
  let acknowledgedFiles = 0;

  // Active dirs are milestone-filtered; archived dirs deliberately are NOT.
  // listMilestonePhaseDirs derives the CURRENT milestone's phase directories
  // (window + sentinel filtered) from ROADMAP.md, and archived phases belong
  // to past milestones by definition — so applying it to them discards every
  // one and silently reinstates the bug.
  const scanTargets: { dir: string; phaseDir: string; milestone?: string }[] = [];

  if (hasActivePhases) {
    // #3185 (ADR-3180 Decision 1): routed through the canonical owner
    // instead of a hand-rolled readdirSync + isDirInMilestone filter, which
    // also never excluded sentinels, unlike the owner.
    const dirs = listMilestonePhaseDirs(phasesDir, { cwd }).value;
    for (const dir of dirs) {
      scanTargets.push({ dir, phaseDir: path.join(phasesDir, dir) });
    }
  }

  for (const archived of archivedDirs) {
    scanTargets.push({
      dir: archived.name,
      phaseDir: archived.fullPath,
      milestone: archived.milestone,
    });
  }

  for (const { dir, phaseDir, milestone } of scanTargets) {
    const phaseMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    const files = fs.readdirSync(phaseDir);

    // Process UAT files — scoped to THIS phase's own token (#3511) via
    // scopeToPhase, so a stray, cross-phase, or ad-hoc file cannot be reported
    // under this phase's audit-uat entry. A phase whose own UAT file is
    // genuinely absent scopes to empty and contributes nothing — correct, and
    // the reason scopeToPhase has no unfiltered fallback.
    for (const file of selectPhaseUatFiles(files, dir)) {
      const uatFilePath = path.join(phaseDir, file);
      const content = readNormalizedDocument(uatFilePath);
      const { items, headingsSeen } = parseUatItemsWithStats(content);
      const uatFm = extractFrontmatter(content, uatFilePath) as Record<string, unknown>;
      const status = ((uatFm.status as string) || 'unknown').toLowerCase();
      // #3805: honour the audit_acknowledged marker with the SAME snapshot
      // key audit.cts's scanUatGaps uses ('gap_snapshot', derived value
      // composed by the shared derivation) — one acknowledgement means the
      // same thing to both commands.
      if (isAuditItemAcknowledged(uatFm, { snapshotKey: 'gap_snapshot', currentValue: deriveUatGapSnapshotValue(status, content) })) {
        acknowledgedFiles++;
        continue;
      }
      // `parse_gap` means the file contained `### N.` test blocks that
      // yielded no items — NOT merely "zero items and not complete" (#3707
      // MAJOR: that broader signal false-positived on an all-pass file and on
      // a Gaps-only file with everything resolved). A file whose blocks all
      // passed, or that has no test blocks at all, never sets `headingsSeen`,
      // so it never sets the flag regardless of status.
      //
      // `status` deliberately does NOT gate this (#3078 security review). A
      // terminal `status: complete` is an ASSERTION BY THE AUTHOR that the
      // work is finished — and an assertion is exactly the thing that must
      // not be allowed to switch off the detector that would contradict it.
      // The earlier `status !== 'complete'` guard did precisely that: a file
      // could declare itself complete and thereby suppress the report of the
      // rows this tool could not read, which is a self-declared kill switch
      // over the very detector this issue built. The distinction that
      // actually matters is not "is it complete" but "is there anything the
      // tool failed to parse":
      //   - complete + `headingsSeen === 0` — nothing unread, so nothing to
      //     contradict the claim. Still omitted entirely, exactly as before;
      //     that is the whole point of a terminal status and must not
      //     regress. (Same for a file whose blocks all parsed and passed.)
      //   - complete + `headingsSeen > 0` — the author's claim of
      //     completeness CANNOT BE VERIFIED against rows the parser could not
      //     read, so the file is surfaced with `parse_gap` and the
      //     `unparsed_blocks` count. The audit reports what it could not see
      //     rather than trusting the frontmatter over the file body.
      //
      // This check is deliberately UNCONDITIONAL on `items.length` (#3707
      // follow-up BLOCKER): a MIXED file — some parseable rows plus some
      // unparseable blocks — must report BOTH the real items AND the parse
      // gap, quantified via `unparsed_blocks`. The previous `else if` only
      // ever flagged a file with ZERO items, silently discarding
      // `headingsSeen` (and every unparseable row it counted) the instant any
      // single item existed anywhere in the file, including via the Gaps
      // union.
      if (items.length > 0 || headingsSeen > 0) {
        const entry: UatFileResult = {
          phase: phaseNum,
          phase_dir: dir,
          file,
          file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
          type: 'uat',
          status,
          archived_milestone: milestone,
          items,
        };
        if (headingsSeen > 0) {
          entry.parse_gap = true;
          entry.unparsed_blocks = headingsSeen;
        }
        results.push(entry);
      }
    }

    // Process VERIFICATION files — scoped to THIS phase's own token (#3511)
    // for the same reason as the UAT loop above.
    for (const file of scopeToPhase(files.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md')), dir)) {
      const verificationFilePath = path.join(phaseDir, file);
      const content = readNormalizedDocument(verificationFilePath);
      const verFm = extractFrontmatter(content, verificationFilePath) as Record<string, unknown>;
      const status = ((verFm.status as string) || 'unknown').toLowerCase();
      // #3805: same marker, same 'status' snapshot key as scanVerificationGaps,
      // and the same ORDERING — the open-status gate runs FIRST (a marker on
      // a file that would never surface is not a suppressed item), then the
      // acknowledgement suppresses what the gate surfaced.
      if (status === 'human_needed' || status === 'gaps_found') {
        if (isAuditItemAcknowledged(verFm, { snapshotKey: 'status', currentValue: status })) {
          acknowledgedFiles++;
          continue;
        }
        const items = parseVerificationItems(content, status, verificationFilePath);
        if (items.length > 0) {
          results.push({
            phase: phaseNum,
            phase_dir: dir,
            file,
            file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
            type: 'verification',
            status,
            archived_milestone: milestone,
            items,
          });
        }
      }
    }

    // Process deferred-items.md (#2287) — the SCOPE BOUNDARY convention
    // (agents/gsd-executor.md) has the executor log out-of-scope discoveries
    // to this file; nothing previously read it back. Surface every
    // UNRESOLVED entry (see parseDeferredItems for the resolved/unresolved
    // parsing rule) as a 'deferred'-typed result, keeping deferred-items.md
    // itself the single source of truth — no duplicate pending-todo entry
    // required.
    const deferredFile = 'deferred-items.md';
    if (files.includes(deferredFile)) {
      const content = readNormalizedDocument(path.join(phaseDir, deferredFile));
      const items = parseDeferredItems(content);
      if (items.length > 0) {
        results.push({
          phase: phaseNum,
          phase_dir: dir,
          file: deferredFile,
          file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, deferredFile))),
          type: 'deferred',
          status: 'unresolved',
          archived_milestone: milestone,
          items,
        });
      }
    }
  }

  // Compute summary
  const summary: {
    total_files: number;
    total_items: number;
    parse_gap_files: number;
    by_category: Record<string, number>;
    by_phase: Record<string, number>;
  } = {
    total_files: results.length,
    total_items: results.reduce((sum, r) => sum + r.items.length, 0),
    // #3707 blocker 2: a distinct counter so a file whose test blocks
    // yielded no items (structurally unparseable, not "all clear") stays
    // visible even though it contributes zero to total_items. Consumers
    // (audit-uat.md, progress.md) must gate their all-clear / debt checks on
    // BOTH total_items === 0 AND parse_gap_files === 0.
    //
    // Counts EVERY entry with `parse_gap: true`, archived or not — same as
    // `total_items`, which has no archived split. An outstanding item does
    // not stop mattering because its phase was archived on milestone close
    // (#2766): a deferred human-UAT scenario or a `skipped` live-stack test
    // is exactly what gets archived still-open, so a parse gap on that same
    // file is still an unread outstanding row, not closed history. Splitting
    // this counter by `archived_milestone` (tried in this branch, reverted)
    // demoted an in-progress phase filed under an archived dir out of the
    // gate, and buried an archived outstanding row's parse failure relative
    // to the identical row when it happened to parse — the exact bug class
    // this issue exists to fix.
    parse_gap_files: results.filter((r) => r.parse_gap).length,
    by_category: {},
    by_phase: {},
  };

  for (const r of results) {
    // Deliberate (#3707 follow-up MINOR): this seeds a `by_phase` key at 0
    // even for a parse-gap-only phase whose `items` is empty — do NOT "tidy"
    // this away as dead code. The 0-valued key is itself the cue that this
    // phase was scanned and produced no COUNTABLE items, distinguishing it
    // from a phase absent from `by_phase` entirely (never scanned / no UAT
    // file at all). A phase with a real outstanding item overwrites it below.
    if (!summary.by_phase[r.phase]) summary.by_phase[r.phase] = 0;
    for (const item of r.items) {
      summary.by_phase[r.phase]++;
      const cat = item.category || 'unknown';
      summary.by_category[cat] = (summary.by_category[cat] || 0) + 1;
    }
  }

  // #3805: acknowledged files surface as a COUNT (audit-open's honesty
  // model: the marker fired, the items are suppressed, both facts visible).
  output({ results, summary, acknowledged_files: acknowledgedFiles }, raw, undefined);
}

// ─── cmdRenderCheckpoint ──────────────────────────────────────────────────────

function cmdRenderCheckpoint(cwd: string, options: { file?: string } = {}, raw: boolean): void {
  const filePath = options.file;
  if (!filePath) {
    error('UAT file required: use uat render-checkpoint --file <path>');
  }

  const resolvedPath = requireSafePath(filePath, cwd, 'UAT file', { allowAbsolute: true });
  if (!fs.existsSync(resolvedPath)) {
    error(`UAT file not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const currentTest = parseCurrentTest(content);

  if (currentTest.complete) {
    error('UAT session is already complete; no pending checkpoint to render');
  }

  const config = loadConfig(cwd);
  const responseLanguage = typeof config.response_language === 'string' ? config.response_language : undefined;
  const checkpoint = buildCheckpoint(currentTest as Required<Omit<CurrentTest, 'complete'>> & { complete: false }, responseLanguage);
  output({
    file_path: toPosixPath(path.relative(cwd, resolvedPath)),
    test_number: currentTest.number,
    test_name: currentTest.name,
    checkpoint,
  }, raw, checkpoint);
}

// ─── parseCurrentTest ─────────────────────────────────────────────────────────

function parseCurrentTest(content: string): CurrentTest {
  // #3707-CR: this is the render-checkpoint path's own independent ingress
  // into `tokenizeHeadings` (via the `parseFirstPendingTest` fallback below),
  // separate from `parseUatItemsWithStats`'s. Normalize here too, ONCE, so a
  // lone-CR document cannot hide its first pending row from this path either
  // — see `normalizeLineEndings` for why.
  content = normalizeLineEndings(content);

  // Use the seam to locate the ## Current Test section (ADR-1372 T5).
  // HTML-comment stripping within the section body is UAT-specific, so we keep
  // the comment removal caller-side after extracting the body.
  const currentTestSection = collectSection(
    content,
    (h) => /^current\s+test$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (!currentTestSection) {
    error('UAT file is missing a Current Test section');
  }

  // Remove any leading HTML comment block (UAT-specific document structure)
  const rawBody = currentTestSection!.body.replace(/^<!--[\s\S]*?-->\s*\n?/, '');
  const section = rawBody.trimEnd();
  if (!section.trim()) {
    error('Current Test section is empty');
  }

  if (/\[testing complete\]/i.test(section)) {
    return { complete: true };
  }

  const numberMatch = section.match(/^number:\s*(\d+)\s*$/m);
  const nameMatch = section.match(/^name:\s*(.+)\s*$/m);
  const expectedBlockMatch = section.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m)
    || section.match(/^expected:\s*\|\n([\s\S]+)/m);
  const expectedInlineMatch = section.match(/^expected:\s*(.+)\s*$/m);

  if (!numberMatch || !nameMatch || (!expectedBlockMatch && !expectedInlineMatch)) {
    if (!numberMatch && !nameMatch && !expectedBlockMatch && !expectedInlineMatch) {
      const pendingTest = parseFirstPendingTest(content);
      if (pendingTest) {
        return pendingTest;
      }
      error('Current Test section is non-structured and no pending UAT test remains to resume');
    }
    error('Current Test section is malformed');
  }

  let expected: string;
  if (expectedBlockMatch) {
    expected = expectedBlockMatch[1]
      .split('\n')
      .map((line: string) => line.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
  } else {
    expected = expectedInlineMatch![1].trim();
  }

  return {
    complete: false,
    number: parseInt(numberMatch![1], 10),
    name: sanitizeForDisplay(nameMatch![1].trim()),
    expected: sanitizeForDisplay(expected),
  };
}

function parseFirstPendingTest(content: string): CurrentTest | null {
  // Use the seam to locate the ## Tests section (ADR-1372 T5).
  const testsSection = collectSection(
    content,
    (h) => /^tests$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (!testsSection) {
    return null;
  }

  const sectionBody = testsSection.body;

  // Within the Tests section body, find ### N. Name sub-headings.
  // tokenizeHeadings operates on the section body as a standalone document,
  // filtering to level-3 headings matching the UAT-specific "N. Name" pattern.
  // The UAT-specific item parsing (number extraction, result parsing) stays caller-side.
  //
  // #3078 blocker (same exposure as `parseUatItemsWithStats`): only a COLUMN-0
  // heading is a test row — see `isColumnZeroHeading`. A `### N.` line indented
  // <= 3 spaces INSIDE an `expected: |` value is value text, and must not
  // register as a phantom heading and steal the real row's `result:` token.
  //
  // #3078 follow-up: tokenize a copy with the DELIMITER LINES of every
  // wholly-INDENTED fenced block blanked out first (bodies untouched — column
  // 0 is structure, indentation is content) — see
  // `blankIndentedFenceDelimiters`. Without this, an
  // indented ` ``` ` opener inside an `expected: |` value still reads as a
  // real fence to `tokenizeHeadings` (CommonMark tolerates 1-3 leading
  // spaces), which then hides every heading up to the next matching closer —
  // including a later, genuinely column-0 `### N.` row.
  //
  // #3078 round-5 MAJOR: the row predicate is `isTestRowHeadingText`, the ONE
  // shared helper `parseUatItemsWithStats` uses. It previously read
  // `/^\d+\.\s+/` here while the audit path read `/^\d+\.(?!\d)/`, so
  // `### 3.Foo` WAS a row on one path and was NOT on the other — two parse
  // paths in one module disagreeing about the same grammar.
  const subHeadings = tokenizeHeadings(blankIndentedFenceDelimiters(sectionBody)).filter(
    (h) => h.level === 3 && isTestRowHeadingText(h.text) && isColumnZeroHeading(sectionBody, h),
  );

  for (let i = 0; i < subHeadings.length; i += 1) {
    const current = subHeadings[i];
    const next = subHeadings[i + 1];
    // Slice the block for this sub-test from the RAW section body text
    const block = next
      ? sectionBody.slice(current.offset, next.offset)
      : sectionBody.slice(current.offset);

    if (!/^result:\s*\[?pending\]?\s*$/im.test(block)) {
      continue;
    }

    // Extract the UAT-specific number and name from the heading text via the
    // SAME `parseTestRowHeadingText` seam the audit path uses (#3078 round-5
    // MAJOR) — a name-mandatory `/^(\d+)\.\s+(.+)$/` here would have `continue`d
    // past exactly the `### 3.` / `### 3.Foo` shapes the shared predicate just
    // admitted, reintroducing the divergence one line below the fix.
    const headingParts = parseTestRowHeadingText(current.text);
    if (!headingParts) continue;
    const testNumber = headingParts.number;
    const testName = headingParts.name;

    // #3078 blocker: clip the block at its first fence opener before handing
    // it to `parseExpectedFromTestBlock`, so a raw read cannot reach into
    // fence-hidden content — including a LATER row's own `expected:` line.
    const expected = parseExpectedFromTestBlock(clipBlockAtFirstFence(block));
    if (!expected) {
      error(`Pending UAT test ${testNumber} is missing an expected field`);
    }

    return {
      complete: false,
      number: testNumber,
      name: sanitizeForDisplay(testName),
      expected: sanitizeForDisplay(expected),
    };
  }

  return null;
}

/**
 * CRLF (#3078, found while hardening the scalar reader): the opener pattern
 * demanded a BARE `\n` immediately after the `|`, so on a CRLF document
 * `expected: |\r\n` never matched the block-scalar arm at all — control fell
 * through to the INLINE arm, which happily captured the pipe character itself
 * and published `expected: "|"`, discarding the entire multi-line value with no
 * trace. `\r?` on the opener plus a per-line `\r` strip on the body fixes it.
 * `(?:[1-9][+-]?|[+-][1-9]?)?` additionally admits the `|-` / `|+` chomping
 * indicators AND the explicit indentation indicator (`|2`, `|2-`, `|-2`, ...,
 * in either order per the YAML header grammar), keeping this reader in step
 * with the column-0 heading rule (an indented heading inside a scalar body is
 * otherwise a `expected: |-` or `expected: |2` value would be structurally
 * masked but then read as the literal string `"|-"` / `"|2"` by the same
 * fall-through.
 *
 * `[|>]` (#3078 follow-up): the `>` FOLDED-scalar family (`>`, `>-`, `>+`,
 * `>2`, `>2+`, ...) hit the exact same fall-through as the CRLF/`|-`/`|+`
 * bugs above — the opener only ever matched `|`, so `expected: >` fell to the
 * inline arm and published the literal `">"` as the value, discarding the
 * whole scalar. The opener character is now captured (group 1) so the caller
 * can apply YAML's fold semantics for `>` while leaving `|` untouched.
 *
 * TRAILING COMMENT (#3078 round-6 MINOR 1): YAML permits a comment after a
 * block-scalar header — `expected: | # sample`, `reason: >- # note` are both
 * legal and open a scalar exactly as the bare forms do. The grammar was
 * `$`-anchored immediately after the indicator, so those headers matched
 * NEITHER `extractScalarField`'s opener (the value silently fell through to
 * the inline arm and published the literal `"|"`) NOR
 * `ANY_KEY_SCALAR_HEADER_LINE_RE` (so `countUnattributedIndentedRows` treated
 * the scalar's own indented body heading as an unattributed lost row — a FALSE
 * parse gap). `(?:#[^\r\n]*)?` closes both at the single shared source.
 */
const SCALAR_HEADER_BODY = String.raw`[ \t]*([|>])(?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#[^\r\n]*)?`;

/**
 * Build the block-scalar HEADER grammar for an arbitrary `key:` — the ONE
 * source shared by `expected:`, `reason:` and `blocked_by:` (#3078 MINOR 2:
 * `reason:`/`blocked_by:` previously had no block-scalar grammar of their own
 * at all, and silently published the literal `"|"` / `">"` for a `|`/`>`
 * value, discarding it). A key is always a hardcoded literal at each call
 * site in this module (never untrusted input), so no escaping is needed.
 */
function scalarHeaderFor(key: string): string {
  return String.raw`${key}:${SCALAR_HEADER_BODY}`;
}

/**
 * ANY key's block-scalar HEADER line (#3078 MINOR 1), matched against ONE
 * already-CR-stripped source line instead of against a multi-line block.
 * Derived from the SAME `SCALAR_HEADER_BODY` source `scalarHeaderFor` uses
 * so the opener grammars (`|`, `|-`, `|+`, `|2`, `|-2`, `>`, `>-`, `>+`, `>2+`,
 * ...) cannot drift between them — the generative-divergence class this repo
 * pins elsewhere.
 *
 * `countUnattributedIndentedRows` walks back from an indented `### N.`-shaped
 * line to the nearest preceding column-0 line and asks whether THAT line
 * opened a block scalar that still owns the indented line as its body.
 * Testing only an `expected:`-ONLY grammar there meant an indented
 * heading-shaped line inside ANY OTHER block scalar — `reported: |`
 * (templates/UAT.md), `reason: |`, a verbatim user response containing
 * `  ### 9. Section Nine` — was miscounted as a lost row even though nothing
 * is missing. YAML's indentation rule (any column-0 line terminates a scalar)
 * does not care WHICH key opened the scalar, only that a `[|>]`-family opener
 * did, so the walk-back only needs to recognise the opener grammar, not the
 * specific key.
 */
const ANY_KEY_SCALAR_HEADER_LINE_RE = new RegExp(String.raw`^[A-Za-z_][\w-]*:${SCALAR_HEADER_BODY}$`);

/**
 * Apply YAML FOLDED-scalar (`>`) line-joining to an already-dedented,
 * CRLF-stripped block-scalar body: lines within a paragraph (no blank line
 * between them) join with a single space; a blank line between paragraphs
 * becomes a literal `\n` in the result. `|` (LITERAL) bodies are returned
 * unchanged — folding is `>`-only.
 */
function foldScalarBody(body: string): string {
  const lines = body.split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(line);
    }
  }
  paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

/**
 * Extract a YAML-lite `key:` field's value from `block` — block-scalar
 * (`|`/`>` family, dedented and, for `>`, YAML-folded) OR plain inline.
 * Generalized from the `expected:`-only reader (#3078 MINOR 2) so `reason:`
 * and `blocked_by:` — which previously had NO block-scalar grammar at all and
 * silently published the literal `"|"` / `">"` for a multi-line value,
 * discarding it — go through the exact same opener grammar and fold
 * semantics instead of a third, hand-rolled dialect.
 */
function extractScalarField(block: string, key: string): string | null {
  const opener = String.raw`^${scalarHeaderFor(key)}\r?\n`;
  const blockMatch = block.match(new RegExp(`${opener}([\\s\\S]*?)(?=^\\w[\\w-]*:\\s)`, 'm'))
    || block.match(new RegExp(`${opener}([\\s\\S]+)`, 'm'));
  if (blockMatch) {
    const openerChar = blockMatch[1];
    const dedented = blockMatch[2]
      .split('\n')
      .map((line: string) => line.replace(/\r$/, '').replace(/^ {2}/, ''))
      .join('\n')
      .trim();
    return openerChar === '>' ? foldScalarBody(dedented) : dedented;
  }

  const inlineMatch = block.match(new RegExp(String.raw`^${key}:\s*(.+)\s*$`, 'm'));
  return inlineMatch ? inlineMatch[1].trim() : null;
}

function parseExpectedFromTestBlock(block: string): string | null {
  return extractScalarField(block, 'expected');
}

// ─── buildCheckpoint ──────────────────────────────────────────────────────────
//
// Localized frame strings (#2402): the checkpoint banner + instruction line are
// the byte-for-byte block verify-work.md reprints verbatim, so the model can't
// translate it after the fact — the frame must already be in `response_language`
// when this function returns it. Bounded table with an ENGLISH FALLBACK for
// unset/unrecognized languages keeps the default path byte-identical.

interface CheckpointFrame {
  banner: string;
  instruction: string;
  direction?: 'rtl';
}

const CHECKPOINT_FRAMES: Record<string, CheckpointFrame> = {
  english: {
    banner: 'CHECKPOINT: Verification Required',
    instruction: 'Type `pass` or describe what\'s wrong.',
  },
  spanish: {
    banner: 'PUNTO DE CONTROL: Verificación requerida',
    instruction: 'Escribe `pass` o describe qué está mal.',
  },
  french: {
    banner: 'POINT DE CONTRÔLE : Vérification requise',
    instruction: 'Tapez `pass` ou décrivez ce qui ne va pas.',
  },
  german: {
    banner: 'KONTROLLPUNKT: Überprüfung erforderlich',
    instruction: 'Gib `pass` ein oder beschreibe, was nicht stimmt.',
  },
  portuguese: {
    banner: 'PONTO DE VERIFICAÇÃO: Verificação necessária',
    instruction: 'Digite `pass` ou descreva o que está errado.',
  },
  japanese: {
    banner: 'チェックポイント: 検証が必要です',
    instruction: '`pass` と入力するか、問題点を説明してください。',
  },
  chinese: {
    banner: '检查点：需要验证',
    instruction: '输入 `pass` 或描述问题所在。',
  },
  korean: {
    banner: '체크포인트: 검증 필요',
    instruction: '`pass`를 입력하거나 문제를 설명하세요.',
  },
  italian: {
    banner: 'PUNTO DI CONTROLLO: Verifica richiesta',
    instruction: 'Digita `pass` o descrivi cosa non va.',
  },
  dutch: {
    banner: 'CONTROLEPUNT: Verificatie vereist',
    instruction: 'Typ `pass` of beschrijf wat er mis is.',
  },
  polish: {
    banner: 'PUNKT KONTROLNY: Wymagana weryfikacja',
    instruction: 'Wpisz `pass` lub opisz, co jest nie tak.',
  },
  russian: {
    banner: 'КОНТРОЛЬНАЯ ТОЧКА: требуется проверка',
    instruction: 'Введите `pass` или опишите, что не так.',
  },
  ukrainian: {
    banner: 'КОНТРОЛЬНА ТОЧКА: потрібна перевірка',
    instruction: 'Введіть `pass` або опишіть, що не так.',
  },
  turkish: {
    banner: 'KONTROL NOKTASI: Doğrulama gerekli',
    instruction: '`pass` yazın veya sorunu açıklayın.',
  },
  hindi: {
    banner: 'चेकपॉइंट: सत्यापन आवश्यक',
    instruction: '`pass` लिखें या बताएं कि क्या गलत है।',
  },
  arabic: {
    banner: 'نقطة تحقق: المراجعة مطلوبة',
    instruction: 'اكتب `pass` أو صف المشكلة.',
    direction: 'rtl',
  },
  vietnamese: {
    banner: 'ĐIỂM KIỂM TRA: Cần xác minh',
    instruction: 'Nhập `pass` hoặc mô tả vấn đề.',
  },
  indonesian: {
    banner: 'TITIK PEMERIKSAAN: Verifikasi diperlukan',
    instruction: 'Ketik `pass` atau jelaskan apa yang salah.',
  },
};

// Free-form response_language aliases → canonical CHECKPOINT_FRAMES key.
const CHECKPOINT_LANGUAGE_ALIASES: Record<string, string> = {
  english: 'english', en: 'english', 'en-us': 'english', 'en-gb': 'english',
  spanish: 'spanish', es: 'spanish', 'español': 'spanish', espanol: 'spanish', castellano: 'spanish',
  french: 'french', fr: 'french', 'français': 'french', francais: 'french',
  german: 'german', de: 'german', deutsch: 'german',
  portuguese: 'portuguese', pt: 'portuguese', 'pt-br': 'portuguese', 'português': 'portuguese', portugues: 'portuguese', 'brazilian portuguese': 'portuguese',
  japanese: 'japanese', ja: 'japanese', '日本語': 'japanese',
  chinese: 'chinese', zh: 'chinese', 'zh-cn': 'chinese', 'zh-tw': 'chinese', mandarin: 'chinese', 'simplified chinese': 'chinese', 'traditional chinese': 'chinese', '中文': 'chinese',
  korean: 'korean', ko: 'korean', '한국어': 'korean',
  italian: 'italian', it: 'italian', italiano: 'italian',
  dutch: 'dutch', nl: 'dutch', nederlands: 'dutch', flemish: 'dutch', vlaams: 'dutch',
  polish: 'polish', pl: 'polish', polski: 'polish',
  russian: 'russian', ru: 'russian', 'ru-ru': 'russian', 'русский': 'russian',
  ukrainian: 'ukrainian', uk: 'ukrainian', ua: 'ukrainian', 'українська': 'ukrainian',
  turkish: 'turkish', tr: 'turkish', 'türkçe': 'turkish', turkce: 'turkish',
  hindi: 'hindi', hi: 'hindi', 'हिन्दी': 'hindi', 'हिंदी': 'hindi',
  arabic: 'arabic', ar: 'arabic', 'العربية': 'arabic',
  vietnamese: 'vietnamese', vi: 'vietnamese', 'tiếng việt': 'vietnamese', 'tieng viet': 'vietnamese',
  indonesian: 'indonesian', id: 'indonesian', 'bahasa indonesia': 'indonesian',
};

function resolveCheckpointFrame(responseLanguage: string | undefined): CheckpointFrame {
  if (!responseLanguage) return CHECKPOINT_FRAMES.english;
  const key = CHECKPOINT_LANGUAGE_ALIASES[
    responseLanguage.trim().normalize('NFC').toLowerCase()
  ];
  return (key && CHECKPOINT_FRAMES[key]) || CHECKPOINT_FRAMES.english;
}

const RTL_ISOLATE = '\u2067';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

function isolateCheckpointFrameText(text: string, frame: CheckpointFrame): string {
  return frame.direction === 'rtl'
    ? `${RTL_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`
    : text;
}

function buildCheckpoint(currentTest: { number: number; name: string; expected: string }, responseLanguage?: string): string {
  const frame = resolveCheckpointFrame(responseLanguage);
  const banner = isolateCheckpointFrameText(frame.banner, frame);
  const instruction = isolateCheckpointFrameText(frame.instruction, frame);
  return [
    `### ${banner}`,
    '',
    `**Test ${currentTest.number}: ${currentTest.name}**`,
    '',
    currentTest.expected,
    '',
    '---',
    '',
    `**${instruction}**`,
  ].join('\n');
}

// ─── parseUatItems ────────────────────────────────────────────────────────────

/**
 * Result tokens treated as PASSING (#3707 defect 1). Deliberately MINIMAL —
 * that minimality is the point. Every token NOT in this set surfaces as an
 * outstanding item, mirroring the fail-safe direction `parseGapsItems`
 * already documents for this exact false-negative class (#2286): a project
 * that invents a novel pass-word gets a visible, correctable false positive
 * (an extra row an agent can dismiss) rather than today's invisible drop (a
 * genuinely outstanding row silently vanishing with no trace). This was the
 * issue's one open design question and was decided deliberately, here, in
 * favor of the fail-safe direction over a larger "known synonyms" allowlist.
 */
const UAT_PASS_RESULTS = new Set(['pass', 'passed']);

/**
 * A fenced-code OPENER line at COLUMN 0 (``` or ~~~).
 *
 * Deliberately NOT the CommonMark `{0,3}`-space form (#3078 simplification):
 * inside this module a fence only ever means "document structure the tokenizer
 * hid from us", and every structural fence in a UAT file starts at column 0. An
 * INDENTED fence run is, by construction, part of an `expected: |` block-scalar
 * value — the ordinary way a UAT row reproduces a code sample verbatim — and
 * must stay invisible to the clipper, or the very field it exists to protect
 * gets truncated at its own sample. Column 0 is the whole rule for every
 * fence-aware scan THIS MODULE writes directly against raw block text (this
 * one, `dropTopLevelFencedRegions`'s `delimRe`). It does NOT extend to
 * `tokenizeHeadings`, which is a third-party CommonMark scanner with its own
 * {0,3}-space fence tolerance baked in — see `blankIndentedFenceDelimiters`
 * for how an indented delimiter is kept from reaching that scanner at all.
 */
const FENCE_OPENER_RE = /^(?:`{3,}|~{3,})/;

/**
 * The CommonMark-tolerant (0-3 leading spaces) twin of `FENCE_OPENER_RE`,
 * used ONLY by the inner delimiter-shape sweep in
 * `blankIndentedFenceDelimiters` (#3078 round-7 MAJOR). That sweep runs
 * strictly BETWEEN a neutralised block's own (already-blanked) delimiters,
 * looking for a line `tokenizeHeadings` would itself read as a fence opener
 * once those delimiters are gone — and `tokenizeHeadings` tolerates up to
 * three leading spaces on an opener, so a column-0-anchored test here misses
 * an INDENTED delimiter-shaped line and lets the mutation manufacture exactly
 * the structure `scanFencedBlocks` never saw. `FENCE_OPENER_RE` itself stays
 * column-0-anchored: every OTHER call site depends on that anchoring.
 */
const INDENT_TOLERANT_DELIM_RE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * A raw source line whose shape is a UAT `### N.` test heading — the line-level
 * twin of the `h.level === 3 && /^\d+\.(?!\d)/` token filter in
 * `parseUatItemsWithStats`, and anchored at COLUMN 0 to match that filter's
 * `isColumnZeroHeading` guard exactly. Used ONLY to count headings that
 * `tokenizeHeadings` suppressed (a fence-straddled row), never to parse one:
 * the two counts must be derived by the SAME rule or the shortfall they
 * bracket over- or under-reports.
 */
const TEST_HEADING_LINE_RE = /^#{3}(?!#)[ \t]+\d+\.(?!\d)/;

/**
 * THE test-row grammar, in ONE place (#3078 round-5 MAJOR).
 *
 * `parseFirstPendingTest` (the render-checkpoint path) and
 * `parseUatItemsWithStats` (the audit path) each filtered level-3 headings with
 * their own literal — `/^\d+\.\s+/` vs `/^\d+\.(?!\d)/` — so the two paths in
 * this one module DISAGREED about what a test row is: `### 3.Foo` (name squished
 * against the dot) and `### 3.` (no name at all) were rows to the audit and were
 * silently NOT rows to the checkpoint. That is the generative-divergence class
 * this repo requires closed with a shared definition rather than two literals
 * kept in sync by hand.
 *
 * The AUDIT rule wins, deliberately: `^\d+\.(?!\d)` admits `### 3.` and
 * `### 3.Foo` (a heading missing or squishing its name still contributes to
 * `headingsSeen`/items instead of vanishing from BOTH — the same silent-drop
 * symptom the parse-gap flag exists to catch) while the `(?!\d)` lookahead keeps
 * a DOTTED-SECTION heading like `### 1.2.3 Overview` out, since that is a
 * document outline number, not test row 1. `TEST_HEADING_LINE_RE` /
 * `INDENTED_TEST_HEADING_LINE_RE` are the raw-source-line twins of this same
 * rule and carry the identical `\d+\.(?!\d)` core.
 */
const TEST_ROW_HEADING_TEXT_RE = /^\d+\.(?!\d)/;

/** True when a level-3 heading's TEXT is a UAT test row. See `TEST_ROW_HEADING_TEXT_RE`. */
function isTestRowHeadingText(text: string): boolean {
  return TEST_ROW_HEADING_TEXT_RE.test(text);
}

/**
 * Split a test-row heading's text into its number and display name — the
 * extraction twin of `isTestRowHeadingText`, shared by both parse paths for the
 * same anti-divergence reason. Returns `null` for text the predicate rejects.
 *
 * A bare `### 3.` (no trailing name) falls back to the heading's own trimmed
 * text (`3.`) rather than yielding an empty name.
 */
function parseTestRowHeadingText(text: string): { number: number; name: string } | null {
  if (!isTestRowHeadingText(text)) return null;
  const parts = text.match(/^(\d+)\.\s*(.*)$/);
  if (!parts) return null;
  return { number: parseInt(parts[1], 10), name: parts[2].trim() || text.trim() };
}

/**
 * The INDENTED (1-3 leading spaces, CommonMark-legal) twin of
 * `TEST_HEADING_LINE_RE` — used by the SHORTFALL SCAN ONLY, never by the parse
 * gate.
 *
 * #3078 round-4 MAJOR 2: `isColumnZeroHeading` refusing to PARSE an indented
 * `### N.` row is deliberate and stays (no `*UAT*.md` in the tree indents one).
 * But the COUNTING side inherited that anchor through
 * `TEST_HEADING_LINE_RE`, so a heading the parse gate rejected could never
 * reach `headingsSeen` either: `  ### 1. Indented Row` with `result: pending`
 * — which origin/next's unanchored `###\s*(\d+)\.` did surface — yielded no
 * item, no gap, no count and no trace at all. Refusing to parse is defensible;
 * vanishing silently is the exact defect class this issue exists to close, so
 * the row now surfaces as a PARSE GAP instead.
 */
const INDENTED_TEST_HEADING_LINE_RE = /^[ \t]+#{3}(?!#)[ \t]+\d+\.(?!\d)/;

/**
 * True when `heading` starts at COLUMN 0 of its source line in `content`.
 *
 * The UAT test-row contract (#3078): a `### N.` row heading is structure ONLY
 * at column 0. `tokenizeHeadings` implements CommonMark, which tolerates up to
 * 3 leading spaces on an ATX heading — and that single over-permissive rule is
 * what let a `### 3. Fake Row` line sitting INSIDE an `expected: |` value
 * register as a phantom heading, open a block, and STEAL the real row's
 * `result:` line, dropping a genuinely outstanding row from `items`. A scalar
 * body is indented BY CONSTRUCTION (that is what makes it a body), so requiring
 * column 0 makes every such line inert without the parser needing any notion of
 * YAML block scalars at all. The shipped `templates/UAT.md` writes every `### N.`
 * heading at column 0, and no UAT document in the tree indents one.
 *
 * `HeadingToken.offset` is the offset of the heading LINE's first character, so
 * a column-0 heading is exactly one whose first character is the `#` itself.
 */
function isColumnZeroHeading(content: string, heading: { offset: number }): boolean {
  return content.charCodeAt(heading.offset) === 0x23 /* '#' */;
}

/**
 * An INDENTED (1-3 leading spaces, never 0) fenced-code delimiter line.
 * Column 0 is intentionally EXCLUDED — a column-0 fence is real document
 * structure and `tokenizeHeadings` handling it is correct; only the
 * CommonMark-legal 1-3-space tolerance is the problem this targets.
 */
const INDENTED_FENCE_DELIM_RE = /^ {1,3}(?:`{3,}|~{3,})/;

/**
 * Return `content` with the two DELIMITER LINES of every wholly-INDENTED
 * fenced block overwritten by spaces, byte-length- and line-count-preserving,
 * so every downstream offset and line index still lines up against the
 * original document. The block's BODY is left verbatim — see "COLUMN 0 IS
 * STRUCTURE, INDENTATION IS CONTENT" below for why that is the point, not an
 * oversight.
 *
 * Why (#3078 follow-up, escalated design call, answered as option (b)):
 * dropping `maskBlockScalarBodies` in favor of the column-0 heading filter
 * (`isColumnZeroHeading`) fixed the phantom-heading theft, but it silently
 * dropped a SECOND thing masking used to do — hide an INDENTED fence
 * delimiter from `tokenizeHeadings` itself. `tokenizeHeadings` is a
 * CommonMark scanner with its own {0,3}-space fence tolerance; a 1-3-space
 * ` ``` ` inside an `expected: |` scalar body still opens a fence AS FAR AS
 * THAT SCANNER IS CONCERNED, and every heading between it and its matching
 * (or absent) closer — including a LATER, genuinely column-0 `### N.` row —
 * is hidden from the token stream entirely, not merely mis-filtered. The
 * column-0 heading filter cannot recover a heading the tokenizer never
 * returned in the first place.
 *
 * This is deliberately the SAME "column 0 is structure, anything else is
 * value text" rule already applied to headings (`isColumnZeroHeading`) and to
 * this module's own raw-text fence scans (`FENCE_OPENER_RE`,
 * `dropTopLevelFencedRegions`'s `delimRe`) — extended to the one place that
 * rule cannot be expressed as a post-hoc filter, because the tokenizer
 * consumes the fence delimiter before this module ever sees a token for it.
 * It carries no YAML knowledge whatsoever (no notion of `expected:`, `|`,
 * indentation width, or scalar bodies) — it blanks an indented delimiter LINE
 * unconditionally, wherever it appears, the same context-free way the other
 * column-0 rules do.
 *
 * PAIRED, NOT UNCONDITIONAL (#3078 round-4 MAJOR 1). Blanking every indented
 * delimiter LINE on sight perturbs fence PAIRING in BOTH directions, because
 * CommonMark lets a COLUMN-0 fence be closed by a delimiter indented up to
 * three spaces:
 *   - a column-0 opener closed by an INDENTED closer had its closer blanked,
 *     so the fence never closed for `tokenizeHeadings` and every later row —
 *     including a genuinely column-0 `### N.` with an outstanding `result:` —
 *     was swallowed;
 *   - the mirror, an INDENTED opener closed by a COLUMN-0 closer, had its
 *     opener blanked, PROMOTING that closer into an opener and swallowing
 *     everything after it instead.
 * Both documents are legal CommonMark that renders correctly, so neither may
 * lose content. The decision is therefore made per FENCED BLOCK, not per line:
 * a block is neutralised only when it is indented at BOTH ends (or is an
 * indented opener that never closes at all) — i.e. when nothing about it is
 * column-0 document structure. That is exactly the intended case, an indented
 * fence pair living wholly inside an `expected: |` block-scalar value, which
 * is why the helper exists; any block with a column-0 delimiter at either end
 * is left completely alone so its pairing reaches the tokenizer unchanged.
 *
 * COLUMN 0 IS STRUCTURE, INDENTATION IS CONTENT — and that rule is applied in
 * ONE direction only, to the DELIMITERS. Only the two delimiter lines of a
 * neutralised block are blanked; its body is left exactly as written. A
 * column-0 `### N.` sitting between two indented delimiters therefore becomes
 * a real heading, and a `result:` line after it belongs to that heading. That
 * is CORRECT under this rule, not theft: by the very rule that selected the
 * block for neutralisation, an indented delimiter is not a fence at all, so
 * there is no fence for the column-0 line to be "inside" of. The document is
 * malformed; reading it this way is the consistent reading, and it is PINNED
 * by test (see "#3078 round 5: column 0 is structure" in tests/uat.test.cjs).
 * Blanking the whole block open-to-close was tried and REVERTED: it destroys
 * content legitimately living between the delimiters, and — for the
 * unterminated-opener case, where the "body" runs to EOF — silently deletes
 * the entire remainder of the document, dropping every later row.
 *
 * NO SECOND FENCE DIALECT: the blocks come from `scanFencedBlocks`
 * (markdown-sectionizer.cts), the SAME exported CommonMark state machine
 * `stripFencedCode` — and therefore `tokenizeHeadings` — runs. Backtick AND
 * tilde runs, run length >= 3, the <= 3-space indent tolerance, a closer of
 * the same char with run length >= the opener and no trailing text, info
 * strings (including the "a backtick fence's info string may not contain a
 * backtick" rule), and the unterminated-at-EOF case are all classified by that
 * engine, not re-derived here. This module contributes only the column-0
 * question — which delimiter lines are structure — via
 * `INDENTED_FENCE_DELIM_RE`.
 *
 * LINE-BASED by construction (`content.split('\n')` / `.join('\n')`), never
 * character-array splicing — the exact bug class (`Array.from(content)`
 * code-point indexing against UTF-16 offsets) that made the original
 * `maskBlockScalarBodies` corrupt astral-character documents. A line's own
 * `.length` and `' '.repeat(line.length)` are measured in the same (UTF-16)
 * units as the string itself, so this cannot misalign regardless of
 * code-point framing, and CRLF survives untouched: `split('\n')` leaves any
 * `\r` attached to the end of its line, and blanking that line replaces the
 * `\r` with a space exactly like every other character on it — `join('\n')`
 * then reproduces the original line count and total length exactly.
 */
function blankIndentedFenceDelimiters(content: string): string {
  const lines = content.split('\n');
  const isIndentedDelimiter = (idx: number): boolean =>
    idx >= 0 && idx < lines.length && INDENTED_FENCE_DELIM_RE.test(lines[idx].replace(/\r$/, ''));

  const blank = new Set<number>();
  for (const block of scanFencedBlocks(lines)) {
    // A column-0 OPENER is real document structure: leave the whole block
    // alone, closer included, so an indented closer still closes it.
    if (!isIndentedDelimiter(block.openLineIdx)) continue;
    // An indented opener paired with a COLUMN-0 closer is likewise real
    // structure at its far end — blanking the opener would promote that closer
    // into an opener and hide everything after it.
    if (block.closeLineIdx !== -1 && !isIndentedDelimiter(block.closeLineIdx)) continue;
    // DELIMITERS ONLY — never the body. THE RULE: column 0 is structure,
    // indentation is content. An indented delimiter therefore neutralises
    // ITSELF, but it never hides column-0 structure sitting between
    // delimiters: a column-0 `### N.` there IS a heading, and a `result:`
    // after it IS that heading's. Widening this to the whole block was tried
    // (#3078 round 5) and reverted — it deletes content that legitimately
    // lives between the delimiters, and on an UNTERMINATED indented opener it
    // blanks to EOF, taking every later row with it. Pinned by test; do not
    // "fix" it back.
    blank.add(block.openLineIdx);
    if (block.closeLineIdx !== -1) blank.add(block.closeLineIdx);

    // #3078 round-6 MAJOR: the two fence engines must not disagree about the
    // text handed downstream. `scanFencedBlocks` classified the ORIGINAL
    // lines, but `tokenizeHeadings` re-runs its own CommonMark state machine
    // over this MUTATED copy. A COLUMN-0 delimiter-shaped line that was mere
    // fence CONTENT in the original — e.g. a ```-run inside an indented
    // ````-pair — is PROMOTED to a real opener the instant its enclosing
    // delimiters are blanked, hiding every later heading to EOF. Blank those
    // too, so the mutation cannot manufacture structure that the classifying
    // engine never saw.
    //
    // DELIMITER-SHAPED LINES ONLY. A column-0 `### N.` heading between
    // neutralised delimiters stays a heading (the pinned "column 0 is
    // structure" behaviour), and the field lines of a row living between two
    // rows' scalars survive untouched — both are pinned by test. This adds
    // exactly one shape to the blank set: a line that would itself be read as
    // a fence delimiter.
    const inner = block.closeLineIdx === -1 ? lines.length : block.closeLineIdx;
    for (let i = block.openLineIdx + 1; i < inner; i += 1) {
      if (INDENT_TOLERANT_DELIM_RE.test(lines[i].replace(/\r$/, ''))) blank.add(i);
    }
  }
  if (blank.size === 0) return content;

  return lines.map((line, i) => (blank.has(i) ? ' '.repeat(line.length) : line)).join('\n');
}

/**
 * Truncate `block` at its first TOP-LEVEL fenced-code opener (#3078 blocker).
 *
 * `parseExpectedFromTestBlock` must read the RAW block (an `expected: |` scalar
 * may legitimately reproduce fenced-looking text verbatim, so a fence-STRIPPED
 * copy would corrupt the field). But a raw block slice can run straight into
 * content that `tokenizeHeadings` correctly hid inside a fence — including a
 * LATER test row's own `expected:` line, which the earlier row then published
 * as its own. Clipping at the fence opener bounds the raw read to the part of
 * the block the tokenizer also considered visible.
 *
 * Column-0 fences only (`FENCE_OPENER_RE`): a fenced sample nested inside a
 * legitimate `expected: |` value is indented by construction, so it is invisible
 * here and cannot clip the very field this exists to preserve.
 */
function clipBlockAtFirstFence(block: string): string {
  const rawLines = block.split('\n');

  let firstFenceLine = -1;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (FENCE_OPENER_RE.test(rawLines[i])) {
      firstFenceLine = i;
      break;
    }
  }
  if (firstFenceLine === -1) return block;

  const beforeFence = rawLines.slice(0, firstFenceLine).join('\n');
  if (parseExpectedFromTestBlock(beforeFence)) return beforeFence;

  // #3078 follow-up MINOR 2: an `expected:` field appearing AFTER a fence has
  // CLOSED is not a theft risk — only content strictly INSIDE the fence must
  // stay hidden. The plain "clip at first opener" result above silently
  // discards a late `expected:` even when it sits outside every fence.
  // Reconstruct the block with every top-level FENCED REGION dropped, keeping
  // RAW text everywhere else. This exposes a late `expected:` living after a
  // fence closes, while an `expected:` living strictly inside the fence is
  // dropped along with it and stays unreachable — the "inside a fence" vs.
  // "after a closed fence" split falls straight out of whether the
  // fence-tracking state machine below is OPEN or CLOSED at that line, not out
  // of position relative to the FIRST fence opener alone.
  const visible = dropTopLevelFencedRegions(rawLines);
  if (parseExpectedFromTestBlock(visible)) return visible;

  return beforeFence;
}

/**
 * Reconstruct `rawLines` with every TOP-LEVEL fenced region removed. Mirrors
 * `stripFencedCode`'s own delimiter algorithm — a fence run of the SAME
 * character and at least the SAME length, with no trailing content, is what
 * closes an open fence — so "inside a fence" here means the same thing it means
 * to the rest of this module's fence handling. An UNTERMINATED fence (open at
 * EOF) drops everything from its opener to the end, same as `stripFencedCode`.
 *
 * Delimiters are recognised at COLUMN 0 only, for the reason given on
 * `FENCE_OPENER_RE`: an INDENTED fence run belongs to an `expected: |` value,
 * not to document structure, and must not open a region here.
 */
function dropTopLevelFencedRegions(rawLines: string[]): string {
  const kept: string[] = [];
  let openFence: { char: string; len: number } | null = null;
  const delimRe = /^(`{3,}|~{3,})(.*)$/;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].replace(/\r$/, '');
    const m = delimRe.exec(line);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      const trailing = m[2];
      if (openFence === null) {
        if (char === '`' && trailing.includes('`')) {
          // Not a valid fence opener (CommonMark: backtick info string must
          // not contain a backtick) — ordinary content.
          kept.push(rawLines[i]);
          continue;
        }
        openFence = { char, len };
      } else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
        openFence = null;
      }
      continue; // all delimiter lines are dropped, opener or closer
    }
    if (openFence === null) kept.push(rawLines[i]);
    // Lines inside an open fence are silently dropped.
  }

  return kept.join('\n');
}

/**
 * Count the INDENTED (1-3 space) `### N.` heading-shaped lines in `surface`
 * that are NOT the value text of a preceding `expected:` block scalar.
 *
 * Why the exclusion (#3078 round-4 MAJOR 2): the parse gate refuses BOTH
 * shapes for the same reason (column 0 is structure), but only one of them is
 * a lost ROW. A `### 3. Fake Row` line sitting inside an `expected: |` value is
 * the row's own published `expected:` string — already surfaced, verbatim, on
 * the item — so counting it would flag a parse gap against a document with
 * nothing missing (the pinned scalar-body behaviour). A `  ### 1. Indented
 * Row` that no scalar owns is a row the parser declined to read, and must be
 * visible as an unparsed block instead of silently clean.
 *
 * Attribution is structural and cheap: walk BACK from the indented heading to
 * the first non-blank line at column 0 (a block-scalar body is indented by
 * construction, and blank lines are legal inside one). The heading is scalar
 * VALUE exactly when that line is ANY `key:` scalar header — not `expected:`
 * only (#3078 MINOR 1: testing the `expected:`-only grammar false-positived
 * on an indented heading-shaped line inside a DIFFERENT block scalar, e.g. a
 * template-sanctioned `reported: |` holding verbatim user prose, or a
 * `reason: |` body) — per `ANY_KEY_SCALAR_HEADER_LINE_RE`, derived from the
 * SAME `[|>]`-family opener grammar the reader itself uses. No second opener
 * dialect, and no attempt to model YAML indentation levels.
 */
function countUnattributedIndentedRows(surface: string): number {
  const lines = surface.split('\n');

  // LINEAR, not quadratic (#3078 round-6 MINOR 2). The walk-back above was
  // re-scanned per indented row, so a document of N rows and N lines cost
  // O(N^2) — measured 4x per 2x on real input (1000 rows 20ms → 16000 rows
  // 3.6s). The walk only ever asks ONE question of the prefix — "which is the
  // nearest preceding non-blank COLUMN-0 line?" — and that is a running value,
  // so a single forward pass computes it for every line at once. The
  // ATTRIBUTION RULE IS UNCHANGED: a blank line and an indented line are both
  // transparent (a block-scalar body is indented by construction and may
  // contain blank lines), and the first line that is neither terminates the
  // scalar; the heading is value text exactly when THAT line is any key's
  // block-scalar header.
  const stripped = lines.map((line) => line.replace(/\r$/, ''));
  const nearestColumnZero: number[] = new Array<number>(lines.length);
  let last = -1;
  for (let i = 0; i < stripped.length; i += 1) {
    nearestColumnZero[i] = last;
    const line = stripped[i];
    if (line.trim() !== '' && !/^[ \t]/.test(line)) last = i;
  }

  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!INDENTED_TEST_HEADING_LINE_RE.test(lines[i])) continue;
    const owner = nearestColumnZero[i];
    const ownedByScalar = owner !== -1 && ANY_KEY_SCALAR_HEADER_LINE_RE.test(stripped[owner]);
    if (!ownedByScalar) count += 1;
  }

  return count;
}

/**
 * `headingsSeen` is the TOTAL parse-gap tally (every heading-shaped thing this
 * parser could not turn into an item). `shortfallBlocks` is the SUBSET of it
 * contributed by the fence-suppression shortfall scan below — the one gap class
 * this module documents as carrying an ACCEPTED OVER-REPORT (a closed-fence
 * documentation sample written with literal digits is indistinguishable from a
 * genuinely fence-straddled row; see the long comment at the scan itself).
 * Reported separately so a consumer that must decide whether to WITHHOLD a
 * derived number — as opposed to merely REPORT the gap — can tell "a row I
 * definitely could not read" from "a row I possibly mis-counted".
 *
 * #3707-CR: `src/planning-inspect.cts`'s `buildUatRows` does NOT destructure
 * this field (verified — it and `cmdAuditUat` both consume only `items` and
 * `headingsSeen`), correcting an earlier stated instruction that it did.
 * `shortfallBlocks` currently has NO production consumer outside this
 * function's own computation. It is retained on the return value anyway,
 * deliberately, as part of this function's published stats contract — tests
 * assert on the full `{ items, headingsSeen, shortfallBlocks }` shape, and
 * dropping a returned field is a wider, unrelated change than a line-ending
 * fix warrants. A future consumer that needs to distinguish an
 * accepted-over-report shortfall from the rest of `headingsSeen` (the
 * original design intent above) can still do so.
 */
function parseUatItemsWithStats(content: string): { items: UatItem[]; headingsSeen: number; shortfallBlocks: number } {
  content = normalizeLineEndings(content);
  const items: UatItem[] = [];
  let headingsSeen = 0;
  let shortfallBlocks = 0;

  // Locate every `### N. Name` test heading across the WHOLE document (not
  // adjacency-matched against `result:`, #3707 defect 2) and slice each one's
  // own block from its heading to the next heading OF ANY LEVEL (or EOF) —
  // a trailing `## Gaps` section or an interleaved `### Notes` heading must
  // not be absorbed into the preceding test's block, else its unanchored
  // `reason:`/`blocked_by:` scans below bleed a Gaps entry's fields onto the
  // last test row.
  // #3078 blocker: only a COLUMN-0 heading is document structure here (see
  // `isColumnZeroHeading`). The filter is applied to the WHOLE token stream,
  // not just to the `### N.` rows, because an indented heading must not act as
  // a block BOUNDARY either — a `### 3. Fake Row` line inside an `expected: |`
  // value would otherwise truncate its own row's block just before the real
  // `result:` line and drop a genuinely outstanding row from `items`.
  //
  // #3078 follow-up: tokenize a copy with every indented fence delimiter
  // blanked out (`blankIndentedFenceDelimiters`) BEFORE the column-0 filter
  // ever runs. Otherwise an indented ` ``` ` opener inside an `expected: |`
  // value still opens a real fence as far as `tokenizeHeadings` (a
  // CommonMark scanner, {0,3}-space fence tolerance) is concerned, hiding
  // every heading up to its closer from the token stream entirely — a LATER,
  // genuinely column-0 `### N.` row is never returned as a token at all, so
  // no post-hoc filter over the token stream could recover it.
  const allHeadings = tokenizeHeadings(blankIndentedFenceDelimiters(content)).filter((h) => isColumnZeroHeading(content, h));
  // #3707 follow-up MINOR: `^\d+\.` alone — a trailing name is OPTIONAL
  // (`### 3.` and `### 3.Foo`, without the space the old `\s+`-anchored
  // pattern required, both count) so a heading missing or squishing its name
  // still contributes to `headingsSeen`/items rather than being silently
  // excluded from BOTH — the same vanishing-row symptom the parse-gap flag
  // exists to catch, reachable here at the heading-filter layer instead.
  // #3078 round-5 MAJOR: that rule now lives in `isTestRowHeadingText` and is
  // shared verbatim with `parseFirstPendingTest`, which used to disagree.
  // Carry each match's own index into `allHeadings` from the filter pass
  // itself (security review finding 3) rather than re-deriving it via
  // `allHeadings.indexOf(current)` inside the loop below — the latter is an
  // O(n) scan per heading, making the whole loop O(n^2) in document size.
  const subHeadings: { heading: (typeof allHeadings)[number]; index: number }[] = [];
  allHeadings.forEach((h, index) => {
    if (h.level === 3 && isTestRowHeadingText(h.text)) subHeadings.push({ heading: h, index });
  });

  // #3078 blocker: `tokenizeHeadings` is fence-aware, so a BALANCED fence pair
  // that opens after one test row and closes after a later one makes every
  // `### N.` heading between them invisible — the rows are not merely
  // unparseable, they are absent from the token stream, so the loop below can
  // never count them and the file reports as CLEAN with an outstanding
  // `result: blocked` inside it. (origin/next's old whole-file regex did
  // surface those rows, making the silent drop a regression.) Comparing the
  // count of heading-SHAPED source lines against the headings the tokenizer
  // actually returned recovers the shortfall; each suppressed row counts
  // toward `headingsSeen`, so the file is flagged as a parse gap rather than
  // silently clean. The line scan is anchored at COLUMN 0 (`TEST_HEADING_LINE_RE`)
  // by the same rule the token filter uses, so a `### N.`-shaped line living
  // inside an `expected: |` value — which is value text, not a suppressed row —
  // cannot inflate the tally.
  //
  // #3078 round-7 HIGH — SYMMETRY IS THE INVARIANT. BOTH SIDES OF THIS
  // COMPARISON ARE WHOLE-DOCUMENT. DO NOT SCOPE EITHER ONE. Read this whole
  // comment before "optimising" the `## Notes` noise back out; three separate
  // HIGH-severity silent false-cleans have been produced by three separate
  // attempts to be clever about scope here, and every one of them was a
  // regression against origin/next's plain whole-file regex.
  //
  // History of the failures, so they are not re-derived:
  //   - round-6 HIGH: the raw line scan was SECTION-SCOPED to the `## Tests`
  //     body while `subHeadings` stayed whole-document, so a legal
  //     `### 9. Old / result: pass` row in a preceding `## Prior` section
  //     decremented the shortfall by one and SILENTLY DISABLED the
  //     fence-straddle detector.
  //   - round-7 HIGH: "equalising" that by ALSO scoping the token side to the
  //     section's offset span made the two counters agree with each other but
  //     left the PARSE side whole-document — so a `### N.` row living OUTSIDE
  //     the first `## Tests` section was parsed and surfaced normally when
  //     visible, yet vanished with NO item AND NO parse_gap the moment a fence
  //     straddled it: neither side of the comparison covered it. Reproduced
  //     three ways — a straddle inside a `## Regression Tests` section, a
  //     straddle inside a SECOND `## Tests` section (`collectSection` takes the
  //     FIRST match only), and, as control, the identical straddle in a file
  //     with no `## Tests` heading at all, which alone reported correctly.
  //
  // THE RULE: the parse side reads rows wherever they live in the document, so
  // the counting side must too. Scan shaped `### N.` lines over the ENTIRE
  // document and compare against ALL tokenized row headings. Any narrowing of
  // one side that is not matched by the other manufactures a blind spot, and a
  // blind spot here is a SILENT FALSE CLEAN — a file with an outstanding
  // `result: blocked` in it that never even enters `results`.
  //
  // ACCEPTED CONSEQUENCE, DELIBERATELY TRADED (this replaces the #3078
  // follow-up MINOR 1 scoping): a `### N.`-shaped line inside a properly
  // CLOSED fence in a `## Notes` section — a documentation sample of the row
  // format. NOTE the shape needs LITERAL DIGITS — the scan requires `\d+`, so the
  // conventional placeholder `### N. Name` does NOT trigger it; only a sample written
  // with real numbers (`### 1. Example Row`) does. On FREQUENCY, claim only what is
  // measurable here: the SHAPE is uncommon (it takes a literal-digit row inside a
  // CLOSED fence), and that is a claim about the shape, NOT a measurement across real
  // projects. The in-tree sample size for it is ZERO PHASE FILES — the only `*UAT*.md`
  // anywhere in this repo is the shipped template (which `selectPhaseUatFiles` never
  // scans, and which itself scores headingsSeen=11, six of them literal-digit example
  // rows), so "no phase UAT file in-tree triggers it" is vacuously true and proves
  // nothing about rarity in the field. Do not restate it as evidence. If you test the
  // placeholder form, see no over-report, and conclude this pin is stale: it is not.
  // The ordinary way to explain the syntax inside a UAT file — is
  // counted as a suppressed row and raises a parse gap on a file with nothing
  // actually missing. That is an OVER-report: noisy, but VISIBLE and FAIL-SAFE
  // (an agent reads the file and dismisses it). Fence-closedness cannot
  // distinguish it from a genuinely hidden row, because the fence-straddle
  // case this scan exists to catch is ALSO a properly closed fence — so the
  // only lever left is scope, and scope is exactly what produced the two
  // silent false-cleans above. This entire issue exists to eliminate false
  // cleans, so the trade goes this way ON PURPOSE: an extra noisy row beats an
  // invisible missing one. The behaviour is pinned by test; do not "fix" it.
  let shapedHeadingLines = 0;
  for (const line of content.split('\n')) {
    if (TEST_HEADING_LINE_RE.test(line)) shapedHeadingLines += 1;
  }
  if (shapedHeadingLines > subHeadings.length) {
    shortfallBlocks = shapedHeadingLines - subHeadings.length;
    headingsSeen += shortfallBlocks;
  }

  // #3078 round-4 MAJOR 2: an INDENTED `### N.` row is refused by the parse
  // gate (`isColumnZeroHeading`) — correct — but must not therefore vanish
  // without a trace. See `countUnattributedIndentedRows` for why an indented
  // heading that is the VALUE of a preceding `expected:` block scalar is
  // excluded from this tally (it is value text, not a row), keeping the
  // scalar-body pins intact while a genuinely indented ROW surfaces as a gap.
  //
  // WHOLE-DOCUMENT, for the same reason as the shortfall scan above: this
  // counter has no token-side twin to disagree with, but scoping it to a
  // `## Tests` body would silently drop an indented row living anywhere else
  // in the file — the identical vanishing-row class. Its own false-positive
  // guard is STRUCTURAL (scalar attribution via
  // `ANY_KEY_SCALAR_HEADER_LINE_RE`) — with ONE positional caveat: the walk stops at the
  // nearest COLUMN-0 line, so a block scalar nested inside a `## Gaps` bullet (a
  // `- truth:` entry carrying an indented `note: |`) is transparent to it and a
  // heading-shaped line inside that value is counted. That is another instance of the
  // accepted over-report above, not a separate defect, not positional, so it needs no scope.
  headingsSeen += countUnattributedIndentedRows(content);

  // #3078: an UNTERMINATED fence swallows the entire remainder of the
  // document — every later test row AND a trailing `## Gaps` section — so the
  // file yields nothing at all and never even enters `results`: a whole-file
  // false clean. Mirrors the per-file malformed-markdown guard
  // `evaluateUatPassed` already applies via `analyzeMarkdown`
  // (src/uat-predicate.cts:278), which likewise gates on
  // `stripFencedCode(raw).unterminatedFence`. Deliberately measured on the RAW
  // document: a fence opened inside an `expected:` scalar is still an
  // unterminated fence for every downstream markdown consumer, and the masked
  // copy would hide it.
  if (stripFencedCode(content).unterminatedFence) {
    headingsSeen += 1;
  }

  for (let i = 0; i < subHeadings.length; i += 1) {
    const { heading: current, index: currentIdx } = subHeadings[i];
    const next = allHeadings[currentIdx + 1];
    const block = next ? content.slice(current.offset, next.offset) : content.slice(current.offset);
    // Fence-stripped copy for the `result:`/`reason:`/`blocked_by:` field
    // scans below (#3707 follow-up MAJOR/regression): `block` is raw slice
    // text, and a fenced code sample inside a test block (a legitimate way to
    // document expected output) can contain a line that LOOKS like a field
    // declaration (e.g. an example ` ```\nresult: pending\n``` `). Scanning
    // raw text reads that sample's `result:` as the test's real outcome —
    // origin/next returned null here, so an unstripped scan is a regression,
    // not a pre-existing behavior to preserve. `parseExpectedFromTestBlock`
    // below still receives the RAW `block`, not this stripped copy: an
    // `expected: |` block-scalar value may legitimately reproduce
    // fenced-looking text verbatim, and stripping it would corrupt that field.
    // #3707 round-3 MINOR: an UNTERMINATED fence (EOF inside a fence, or —
    // here, scoped per test block — the closing delimiter living in a LATER
    // block, so from this block's own slice the fence never closes) makes
    // `stripFencedCode` drop everything from the opener to the end of the
    // block, including a real `result:`/`reason:`/`blocked_by:` line that
    // follows it. Falling back to the RAW (unstripped) block in that case
    // means a legitimate fenced-code false-positive (a `result:`-shaped line
    // INSIDE a properly-closed sample) is still guarded against in the common
    // case, while a malformed/unterminated fence no longer silently swallows
    // a real field line into a false parse_gap.
    const stripResult = stripFencedCode(block);
    const fenceStrippedBlock = stripResult.unterminatedFence ? block : stripResult.text;

    // A block with no `result:` line at all is not a test row (e.g. still
    // being drafted) — no item, no false positive. It IS, however, a heading
    // that failed to yield an item for a reason other than a PASS token, so
    // it counts toward `headingsSeen` (used to detect a genuine parse gap).
    // Deliberately NOT end-anchored (regression fix, #3707 blocker 1): a
    // trailing comment/clause after the token (`result: pending (blocked on
    // staging)`, `result: [skipped] # no device`, `result: blocked -
    // waiting`) must still match and surface the row instead of being
    // silently dropped. The trailing text itself is matched-and-ignored
    // (#3707 follow-up MINOR): it is NOT synthesized into `reason` — a real
    // `reason:` line is the only source for that field (see below) — because
    // doing so previously changed `categorizeItem`'s classification for
    // shapes origin/next categorized differently (an unpinned behavior
    // change, not something the blocker required).
    // #3078-CR defect A fix, split-then-match scan: the previous `.match()`
    // against `/^result:.../im` ran a MULTILINE regex anchor directly over
    // unsplit block text. ECMA-262's LineTerminator set for `^`/`$` under
    // `/m` includes U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, but
    // `content.split('\n')` and this module's own heading tokenizer do NOT
    // treat either as a boundary. A `result:`-shaped line inside an
    // `expected: |` scalar body, sitting immediately after one of these
    // separators instead of an ordinary character, was therefore read as a
    // genuine line start by the regex engine even though it is not
    // `\n`-delimited from anything — it is exactly as much "one line" to
    // every other consumer as the ordinary-character control case.
    // Splitting on `\n` FIRST and testing each already-split line against a
    // single-line (`/im`-anchor-free) pattern fixes this: a line is never
    // split by U+2028/U+2029 (`String.prototype.split` matches only its
    // literal separator argument, never the wider ECMA-262 LineTerminator
    // set), so a `result:`-shaped line reachable only via one of those
    // separators can never register as its own split line — the split view
    // and the regex view are back in agreement, by construction, exactly the
    // way `splitLines` module is documented to be immune to the sibling `\r`
    // bug.
    //
    // FIRST MATCH WINS (byte-identical to origin/next otherwise): a block
    // with more than one column-0 `result:` line resolves to the FIRST one
    // encountered, same as the pre-existing `.match()` behaviour without
    // `/g` — this is deliberately NOT an ambiguity/parse-gap case (that
    // variant was tried and reverted: its boundary-truncation heuristic
    // mistook an indented `### N.` living inside a legitimate block scalar
    // for a heading boundary, corrupting every scalar/indent guard in this
    // module — see tests/uat.test.cjs's #3078 scalar guard family).
    // Trailing text is matched with `[^]*` rather than `.*` (final review
    // MINOR 1): `.` never matches U+2028/U+2029, so a column-0 `result:`
    // line whose trailing text contains one of those separators would
    // otherwise never reach `$`, and the whole line would fail to match —
    // an unpinned regression against origin/next, which parses it.
    const RESULT_LINE_RE = /^result:\s*\[?(\w+)\]?[^]*$/i;
    const resultLineMatch = fenceStrippedBlock
      .split('\n')
      .map((line) => line.match(RESULT_LINE_RE))
      .find((m): m is RegExpMatchArray => m !== null);
    if (!resultLineMatch) {
      headingsSeen += 1;
      continue;
    }
    // Security review finding 2: store the token lower-cased so the published
    // `result` field agrees with `category` (which categorizeItem already
    // lower-cases internally, below). No consumer needs the original casing —
    // `uat-predicate.cts` runs its own independent parser and already
    // lower-cases too — so the raw-cased form is kept nowhere.
    const result = resultLineMatch[1].toLowerCase();

    // #3707 defect 1: invert the old DROP-list filter to a PASS set — see
    // UAT_PASS_RESULTS's doc comment for why this direction was chosen.
    // A recognised PASS token is the ONLY reason a heading is excluded from
    // `headingsSeen` without producing an item — every other non-yielding
    // case (missing `result:` line, above) is a genuine parse gap.
    // `result` is already lower-cased at its extraction above, which is the
    // single point of normalization for this value — re-lowercasing here was
    // dead work and implied a second, independent normalization that does not
    // exist (#3078 round-5 MINOR).
    if (UAT_PASS_RESULTS.has(result)) continue;

    // #3707 follow-up MINOR: the heading filter above now admits `### 3.`
    // (no name at all) and `### 3.Foo` (no space before the name), so this
    // extraction is loosened in lockstep — a bare number with no trailing
    // name falls back to the heading's own trimmed text (`3.`). #3078 round-5
    // MAJOR: shared with `parseFirstPendingTest` via `parseTestRowHeadingText`.
    const headingParts = parseTestRowHeadingText(current.text)!;
    const testNumber = headingParts.number;
    const testName = headingParts.name;

    // Reuse the existing block-scalar/inline `expected:` grammar rather than
    // re-deriving a second one (#3707 defect 2). #3078 blocker: the block is
    // CLIPPED at its first top-level fence opener first — still raw text (a
    // legitimate `expected: |` scalar must be read verbatim, fences and all),
    // but bounded to what the tokenizer also treated as visible, so this row
    // cannot reach past a fence into a LATER row's `expected:` line and
    // publish it as its own. See `clipBlockAtFirstFence`.
    const expected = parseExpectedFromTestBlock(clipBlockAtFirstFence(block));

    // #3078 MINOR 2: `reason:`/`blocked_by:` previously had no block-scalar
    // grammar at all (only a plain `/key:\s*(.+)/` single-line match), so a
    // `reason: |`/`reason: >`/`blocked_by: |` value silently published as the
    // literal string `"|"` / `">"`, discarding the real multi-line value the
    // author wrote — and `categorizeItem` below reads exactly this field, so a
    // discarded `reason` could silently change an item's category. Routed
    // through the SAME `extractScalarField` machinery `expected:` already
    // uses rather than adding a third hand-rolled opener dialect.
    const reason = extractScalarField(fenceStrippedBlock, 'reason') ?? undefined;
    const blockedBy = extractScalarField(fenceStrippedBlock, 'blocked_by') ?? undefined;

    const item: UatItem = {
      test: testNumber,
      name: testName,
      result,
      category: categorizeItem(result, reason, blockedBy),
    };
    if (expected) item.expected = expected;
    if (reason) item.reason = reason;
    if (blockedBy) item.blocked_by = blockedBy;
    items.push(item);
  }

  items.push(...parseGapsItems(content));
  return { items, headingsSeen, shortfallBlocks };
}

/**
 * ITEMS-ONLY convenience form over `parseUatItemsWithStats` — the same parse,
 * with the `headingsSeen` parse-gap counter dropped, for a caller that only
 * wants the rows.
 *
 * Deliberately RETAINED with no in-tree caller (#3078 round-5 MINOR): both
 * `cmdAuditUat` and `src/planning-inspect.cts` need the stats form, so this is
 * currently used only from outside. It is a public export of a shipped module,
 * and removing an exported symbol is a CONTRACT change, out of scope for a bug
 * fix — so it stays, as the documented thin wrapper it has always been, with a
 * direct test of its own rather than as untested dead weight.
 */
function parseUatItems(content: string): UatItem[] {
  return parseUatItemsWithStats(content).items;
}

// ─── parseGapsItems ───────────────────────────────────────────────────────────

/**
 * Extract unresolved entries from a UAT file's `## Gaps` section (#2286).
 *
 * `## Gaps` records open findings as a YAML-lite bullet list (see
 * `templates/UAT.md`'s `## Gaps` block: `- truth: "..."` followed by indented
 * continuation lines `status:` / `reason:` / `severity:` / `test:` / etc.,
 * and — for `artifacts:` / `missing:` — a further-nested `- ` sub-list).
 * `parseUatItems`'s `### N.` test-block regex never looks at this section at
 * all, so a UAT file whose only outstanding findings live in `## Gaps` was
 * silently invisible — the false-negative this fix addresses.
 *
 * Reuses the existing `collectSection` seam (already used elsewhere in this
 * file for `## Current Test` / `## Tests`) to locate the section. Field
 * extraction is deliberately NOT done via `iterateBullets`: that seam folds
 * every continuation line onto ONE space-joined `text` string per bullet,
 * which erases line boundaries — a `key:` scan against that flattened text
 * matches the FIRST `key:`-shaped substring anywhere, including one that
 * happens to appear inside an EARLIER field's own quoted free-text value
 * (e.g. `truth: "The status: resolved workflow should trigger"` — a real
 * `status: failed` on the next line would never be reached, silently
 * DROPPING a genuinely open gap — the exact false-negative class #2286
 * exists to fix, so the fix must not reintroduce it). `splitGapsEntries` /
 * `extractGapEntryFields` below instead walk the section PER LINE and only
 * recognise a field at the START of its own (trimmed) line, so a `key:`
 * embedded inside another field's quoted value can never be mistaken for a
 * field declaration.
 *
 * Every entry whose `status` is present and NOT `resolved` (case-insensitive)
 * is surfaced — mirroring the "ignore passing/resolved" convention already
 * used for `### N.` test blocks (`result: pass` is never surfaced) and the
 * VERIFICATION table-row PASS/resolved skip (`hasPassResult`, below). An
 * entry with NO parseable `status:` field is surfaced too, as `result:
 * 'unknown'` — #2286 is a false-NEGATIVE bug, and a `## Gaps` entry only
 * exists to record an outstanding finding (a template-conformant RESOLVED
 * entry always carries an explicit `status: resolved`); a garbled or
 * non-conformant entry is far more likely to be an unresolved finding whose
 * `status:` line failed to parse than a genuinely resolved one, so the
 * fail-safe direction is to surface it rather than silently drop it.
 */
function parseGapsItems(content: string): UatItem[] {
  const gapsSection = collectSection(
    content,
    (h) => /^gaps$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (!gapsSection) return [];

  const items: UatItem[] = [];

  for (const entryLines of splitGapsEntries(gapsSection.body)) {
    const fields = extractGapEntryFields(entryLines);
    const rawStatus = fields.status;
    if (rawStatus && rawStatus.toLowerCase() === 'resolved') continue;
    // Fail-safe: missing/garbled status surfaces as 'unknown' rather than
    // being dropped (see doc comment above).
    const status = rawStatus || 'unknown';

    const truth = fields.truth;
    const reason = fields.reason;
    const testNum = fields.test;

    const item: UatItem = {
      name: truth || rawGapEntryText(entryLines),
      result: status,
      category: categorizeItem(status, reason, undefined),
    };
    if (testNum && /^\d+$/.test(testNum)) item.test = parseInt(testNum, 10);
    if (reason) item.reason = reason;
    items.push(item);
  }

  // #2766: union with the table form. A `|`-leading line is never a `- ` bullet
  // opener, so a section mixing bullet entries and a table surfaces both with no
  // double-counting.
  items.push(...parseGapsTableItems(gapsSection.body));

  return items;
}

/**
 * Split a section body into its GFM pipe tables, one entry per table (#2766).
 *
 * Shared by `parseGapsTableItems` and `parseDeferredTableItems` so the
 * header/delimiter/table-boundary handling — the fiddly part — lives in exactly
 * one place, and the two consumers only decide what a data row MEANS.
 *
 * Header detection is lookahead-free: the last data-shaped row is held in
 * `pending` until the NEXT line decides its fate — a delimiter row
 * (`|---|---|`) proves the held row was a header, anything else promotes it to a
 * data row. So a conventional table drops exactly its header, a HEADERLESS table
 * keeps every row (hand-authored planning tables often omit the delimiter), and
 * a header with no data rows yields nothing. A prose or blank line ends the
 * current table, so two tables separated by text are read independently and each
 * drops its own header.
 *
 * Reuses the canonical `isDelimiterRow` shape check from markdown-table.cts
 * rather than re-deriving it. Deliberately NOT routed through
 * `parseMarkdownTable`, which reads only the FIRST table in a body and treats
 * ragged/headerless shapes as errors (ADR-2143 §3) — correct for the mandated
 * tables in STATE.md/ROADMAP.md, but the wrong contract here, where a malformed
 * hand-written table must still surface its rows rather than be dropped.
 */
function collectTableRows(sectionBody: string): { header: string[] | null; rows: string[][] }[] {
  const tables: { header: string[] | null; rows: string[][] }[] = [];
  let current: { header: string[] | null; rows: string[][] } | null = null;
  let pending: string[] | null = null;

  const ensure = (): void => {
    if (!current) current = { header: null, rows: [] };
  };
  const flushPending = (): void => {
    if (pending) {
      ensure();
      current!.rows.push(pending);
      pending = null;
    }
  };
  const endTable = (): void => {
    flushPending();
    if (current) {
      tables.push(current);
      current = null;
    }
  };

  for (const rawLine of sectionBody.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line.startsWith('|')) {
      endTable();
      continue;
    }
    const cells = splitTableRow(line);
    if (cells.length === 0) continue;
    if (isDelimiterRow(cells)) {
      ensure();
      current!.header = pending; // may be null for a delimiter-first table
      pending = null;
      continue;
    }
    flushPending();
    pending = cells;
  }
  endTable();

  return tables;
}

/**
 * Header-name → canonical Gaps field (#2766).
 *
 * Anchored on the `## Gaps` field vocabulary `templates/UAT.md` mandates for the
 * YAML-lite bullet form (truth/status/reason/severity/test), plus the obvious
 * synonyms a human writing the same information as a table reaches for instead.
 */
const GAPS_COLUMN_ALIASES: Record<string, 'truth' | 'status' | 'reason' | 'severity' | 'test'> = {
  truth: 'truth', gap: 'truth', finding: 'truth', item: 'truth',
  description: 'truth', issue: 'truth', name: 'truth',
  status: 'status', result: 'status', state: 'status',
  reason: 'reason', note: 'reason', notes: 'reason',
  detail: 'reason', details: 'reason', evidence: 'reason',
  severity: 'severity',
  test: 'test', '#': 'test', 'test #': 'test', 'test number': 'test',
};

function mapGapsHeader(header: string[] | null): Record<string, number> | null {
  if (!header) return null;
  const columns: Record<string, number> = {};
  header.forEach((cell, idx) => {
    const key = GAPS_COLUMN_ALIASES[cell.trim().toLowerCase().replace(/\*+/g, '')];
    if (key && !(key in columns)) columns[key] = idx;
  });
  return Object.keys(columns).length > 0 ? columns : null;
}

/**
 * Extract gap entries from GFM pipe tables in a `## Gaps` section (#2766) — a
 * UNION with the YAML-lite bullet scan in `parseGapsItems`, for the same reason
 * `parseDeferredTableItems` exists: `splitGapsEntries` keys entirely on `- `
 * bullet openers, so a table-shaped `## Gaps` section yielded ZERO items and
 * every finding in it was silently invisible.
 *
 * Neither `templates/UAT.md` nor `templates/verification-report.md` documents a
 * table for this section (both mandate the bullet/numbered form), so a table
 * here is off-template hand-authoring — which is precisely why it must not fail
 * silently. Note `parseVerificationItems` in this same file already reads table
 * rows AND numbered AND bullet items as a union because the live sections mix
 * shapes; the Gaps and deferred parsers never got the same treatment.
 *
 * When a header row is present its columns are mapped by name against the
 * template's own field vocabulary (see GAPS_COLUMN_ALIASES) so a tabled gap
 * carries the same status/reason/test fields as its bullet equivalent and
 * `categorizeItem` classifies it identically. With no recognizable header, the
 * row degrades to a joined-cells name with status `unknown` — surfaced, not
 * dropped, matching this module's established fail-safe stance.
 *
 * Resolution follows the bullet path exactly: an entry is skipped ONLY on an
 * explicit resolved marker — the mapped `status` column reading `resolved`, or,
 * absent a status column, any cell reading exactly `resolved`. A gap with no
 * parseable status is NEVER treated as resolved.
 */
function parseGapsTableItems(sectionBody: string): UatItem[] {
  const items: UatItem[] = [];

  for (const { header, rows } of collectTableRows(sectionBody)) {
    const columns = mapGapsHeader(header);
    for (const cells of rows) {
      const at = (key: string): string =>
        (columns && key in columns ? (cells[columns[key]] ?? '').trim() : '');

      const rawStatus = at('status');
      if (rawStatus && rawStatus.toLowerCase() === 'resolved') continue;
      // No status column: fall back to an explicit resolved marker in any cell
      // (the headerless-table equivalent of `status: resolved`).
      if (!columns || !('status' in columns)) {
        if (cells.some(c => /^resolved$/i.test(c.trim()))) continue;
      }

      const truth = at('truth');
      const reason = at('reason');
      const testNum = at('test');
      const name = truth || cells.filter(c => c !== '').join(' — ');
      if (!name) continue;

      const status = rawStatus || 'unknown';
      const item: UatItem = {
        name,
        result: status,
        category: categorizeItem(status, reason || undefined, undefined),
      };
      if (testNum && /^\d+$/.test(testNum)) item.test = parseInt(testNum, 10);
      if (reason) item.reason = reason;
      items.push(item);
    }
  }

  return items;
}

// ─── parseDeferredItems ────────────────────────────────────────────────────────

/**
 * Extract unresolved entries from a phase directory's `deferred-items.md`
 * (#2287) — the SCOPE BOUNDARY convention `agents/gsd-executor.md` instructs
 * the executor to follow: "Log out-of-scope discoveries to `deferred-items.md`
 * in the phase directory". Nothing previously read this file back, so a
 * deferred entry was permanently invisible outside the phase directory.
 *
 * The writer convention (unchanged by this fix, per the issue's stated
 * out-of-scope) emits a plain bullet list, typically under a `## Deferred
 * Items` heading (see the issue's own reproduction fixture), one entry per
 * top-level `- ` line with optional indented continuation lines. There is no
 * mandated heading text, so if no `## Deferred Items`-shaped level-2 heading
 * is found, the WHOLE file is scanned as the entry list — fail-safe, so an
 * agent writing a differently-headed (or headless) deferred-items.md still
 * has its entries surfaced rather than silently skipped.
 *
 * Reuses the same per-line field/entry-splitting seams as `parseGapsItems`
 * (`splitGapsEntries`, `extractGapEntryFields`, `rawGapEntryText`) — an entry
 * is RESOLVED only when it carries an explicit `status: resolved` field
 * (case-insensitive), mirroring the established Gaps convention so a human or
 * follow-up agent can mark a deferred item done in place, keeping
 * `deferred-items.md` the single source of truth (no duplicate
 * `.planning/todos/pending/*.md` entry required). Every other entry —
 * including one with no `status:` field at all — is UNRESOLVED and is
 * surfaced.
 *
 * #3457: when the section body contains headings, entries are delimited by
 * LEAF headings (see `splitDeferredHeadingEntriesDetailed`) rather than by bullets —
 * the executor convention writes one deferred item as a heading followed by
 * sibling `- **Field:** …` bullets, which the bullet-only split mis-counted as
 * one item PER BULLET. A body with no headings keeps the original
 * one-bullet-per-item split unchanged.
 */
/**
 * One `deferred-items.md` entry with its RAW (un-lowercased) `status:` field
 * value (`''` when the entry carries no parseable status). #3458 follow-up:
 * `parseDeferredItems` (below) is now DEFINED IN TERMS OF this — it filters
 * to `status !== 'resolved'` — and `audit.cts`'s `scanDeferredItems` also
 * consumes this directly so it can tell `resolved` (fixed for real, never
 * counted), the newer `acknowledged` (suppressed-but-tallied, #3458
 * follow-up), and everything else (open) apart WITHOUT a second,
 * independent entry-boundary/field-extraction pass that could drift from
 * this one.
 */
function parseDeferredItemsWithStatus(content: string): Array<{ name: string; status: string }> {
  const deferredSection = collectSection(
    content,
    (h) => /^deferred\s+items$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  const sectionBody = deferredSection ? deferredSection.body : content;

  const items: Array<{ name: string; status: string }> = [];

  // #3457: heading-delimited shape — an entry's fields live in sibling bullets
  // (`- **Status:** resolved`), so the bullet marker is stripped on EVERY line
  // before field extraction, not just line 0 (which `extractGapEntryFields`
  // does for the headless/Gaps shape, where a later `- ` line is a nested
  // sub-list, not a field).
  const headingEntries = splitDeferredHeadingEntriesDetailed(sectionBody);
  // The opener flags are HANDED DOWN rather than pre-applied (#3702 round 3,
  // m7/m8). Marker-stripping the lines here and passing the result meant the
  // reader's fence scan ran over text the splitter never saw, and the namer
  // stripped a marker off the heading TEXT. Both consumers now take the raw
  // lines plus the splitter's own per-line verdict — a rejected ordinal
  // ("3. status: resolved" as prose) still keeps its `3. ` and yields no field,
  // because that verdict is what carries the rejection.
  const entries = headingEntries !== null
    ? headingEntries.map((entry) => ({
      lines: entry.lines,
      opener: entry.opener,
      fields: extractGapEntryFields(entry.lines, DEFERRED_BULLET_MARKERS, entry.opener),
    }))
    : splitGapsEntries(sectionBody, DEFERRED_BULLET_MARKERS).map((entryLines) => ({
      lines: entryLines,
      opener: undefined,
      fields: extractGapEntryFields(entryLines, DEFERRED_BULLET_MARKERS),
    }));

  for (const { lines: entryLines, opener, fields } of entries) {
    const text = rawGapEntryText(entryLines, DEFERRED_BULLET_MARKERS, opener);
    if (!text) continue;

    items.push({ name: text, status: fields.status || '' });
  }

  // #2766: union with the table form — see parseDeferredTableItems. Executors
  // write this file by hand with no mandated shape, and a GFM table is a natural
  // choice for the common "test → failing seeds" case, which produced ZERO items.
  // Table rows carry no independently-parseable status column in general —
  // `parseDeferredTableItems` already excludes resolved/done/pass rows at its
  // own layer (any cell reading exactly one of those three) — so anything it
  // returns here is inherently open; `acknowledge` (#3458 follow-up) has no
  // representable field to write for a table row, so those are reported with
  // status `''` (never `resolved`/`acknowledged`) and remain permanently
  // un-acknowledgeable via the CLI writer — a known, deliberate limitation
  // (see `acknowledgeDeferredItem`'s doc comment).
  items.push(...parseDeferredTableItems(sectionBody).map((item) => ({ name: item.name, status: '' })));

  return items;
}

function parseDeferredItems(content: string): UatItem[] {
  return parseDeferredItemsWithStatus(content)
    .filter((entry) => !(entry.status && entry.status.toLowerCase() === 'resolved'))
    .map((entry) => ({
      name: entry.name,
      result: 'unresolved',
      category: 'deferred',
    }));
}

/**
 * The line ending for an entry that ends the FILE, where the entry is a single
 * line and therefore carries no terminator of its own to copy. No entry-local
 * evidence exists here — the separator before the entry terminates the
 * PREVIOUS line, not this one — so this asks the weaker question that CAN be
 * answered: does anything before the entry, within the scope the caller passes,
 * contradict CRLF? Uniform CRLF across that scope is the one case where
 * appending a `\r\n` cannot make the file more irregular. It fails CLOSED:
 * any bare `\n` in scope, or no scope at all, yields LF.
 *
 * Adopted from #3773 (`crlfAtEof`), whose four counterexamples fixed the scope
 * and are ported alongside it. Every simpler choice is refuted by a named test:
 * the separator immediately PRECEDING the entry propagates an isolated CRLF
 * into an LF-dominant list, because it terminates the previous line rather than
 * this one — that is the algorithm this PR shipped through round 3 and it is
 * withdrawn here. The whole DOCUMENT rejects CRLF over an unrelated bare `\n`
 * elsewhere, inside a fenced block say. The deferred-items SECTION body is
 * right when a heading delimits one, and becomes the whole document when it
 * does not.
 *
 * Scope, therefore: the section body when `## Deferred Items` delimits one (its
 * own preamble belongs to that section), else the entry-list region, where only
 * the entries can be trusted.
 *
 * WITH ONE CORRECTION to #3773, which is its B4. The entry-list region goes
 * EMPTY exactly when the list is undelimited AND holds a single entry, since
 * the region runs from the first entry's start to the insertion point and those
 * coincide. `crlfAtEof('')` is `false`, so a bare `\n` was inserted into a CRLF
 * document — `'preamble\r\n\r\n- alpha'` gained one — which is the very defect
 * the fallback exists to close, and it breaks the fix's own uniform-CRLF
 * invariant. When the preferred region is empty the caller widens to everything
 * preceding the insertion point rather than asserting LF from no evidence. That
 * can only ever loosen a scope that was carrying zero information, and the
 * predicate stays fail-closed over the wider one, so a contradicting bare `\n`
 * still yields LF. An entry at offset 0 of an undelimited document has no
 * evidence under either scope and stays LF, rather than inventing an ending
 * from nothing.
 */
function crlfAtEof(before: string): boolean {
  return before.length > 0 && !/(^|[^\r])\n/.test(before);
}

// ─── acknowledgeDeferredItem ───────────────────────────────────────────────────

/** Result of `acknowledgeDeferredItem`. */
interface AcknowledgeDeferredItemResult {
  content: string;
  status: 'ok' | 'not_found' | 'ambiguous' | 'unsupported_heading_shape' | 'already_resolved' | 'match_verification_failed';
}

/**
 * CLI-writer half of the #3458 follow-up deferred_items suppression seam.
 * Sets the ONE deferred entry whose rendered text (`rawGapEntryText`, the
 * same value `parseDeferredItemsWithStatus`/the audit's JSON output surface
 * as `name`/`text`) exactly equals `targetText` to `status: acknowledged` —
 * a NEW terminal value, distinct from the existing `resolved` (which keeps
 * meaning "actually fixed"). This is the marker for this category: unlike
 * every other audit category (a sibling `audit_acknowledged` frontmatter map
 * that never touches the artifact's own `status:`), a deferred-items.md
 * entry's `status:` field carries no OTHER meaning, so the field itself
 * doubles as the marker — self-invalidating for free: edit the entry's
 * `status:` away from `acknowledged` (or delete the field) and it resurfaces
 * with no separate cleanup step, exactly like every other category's marker.
 *
 * #3781: the heading-delimited (#3457) entry shape is SUPPORTED. The
 * reader's own walk, `splitDeferredHeadingEntriesDetailed`, records each
 * entry's (start, end) character span in the SAME pass that groups its
 * lines — the technique `splitGapsEntriesWithSpans` already uses for the
 * headless shape — so there is no second walk for the writer to drift from
 * (#3702 round 5: upstream's fix shipped a hyphen-only sibling walk, and this
 * PR's widened grammar would have left it reading a different set of
 * entries than the reader; folding the spans into the one walk is what
 * keeps the writer and the reader on one grammar). The heading half,
 * `acknowledgeHeadingShapedEntry`, shares this function's guards and its
 * rewrite/insert machinery through the same `entryFieldLines` seam, with two
 * shape-specific rules: the status search runs over the READER-form lines
 * (the heading TEXT on a leaf's line 0 — including the corner where that
 * text itself parses as a status field, rewritten with its ATX prefix
 * preserved), and the insert branch inserts after the entry's LAST NON-BLANK
 * line, because a heading entry's body is frequently a soft-wrapped
 * sentence and splicing after line 0 would split it (#3781's sentence-split
 * trap). Entries whose span embeds a GFM table row are non-contiguous (table
 * lines are excluded from entries) and still refuse
 * (`unsupported_heading_shape`) rather than risk a wrong-entry write; the
 * fully-headless shape below is byte-for-byte the pre-#3781 path.
 *
 * Also refuses `ambiguous` (2+ entries share the exact same text — status must
 * be unique to identify one) and `not_found`, and is a no-op
 * (`already_resolved`) on an entry already carrying `status: resolved` — the
 * verdict-preserving direction: acknowledging a genuinely-fixed item would
 * silently downgrade its terminal state.
 *
 * SPAN-CARRIED, not re-searched (F1, #3458 follow-up review — see
 * `splitGapsEntriesWithSpans`'s doc comment): the target entry's location
 * within `sectionBody` is the (start, end) character span recorded by
 * `splitGapsEntriesWithSpans` in the SAME pass that produced `entryLines` /
 * `targetText` above — never re-derived afterwards by searching. The
 * previous implementation re-found the entry with a regex anchored on its
 * own (escaped) exact text; that regex necessarily matches the FIRST
 * occurrence of that text within `sectionBody`, which is not always the
 * entry that was actually selected (a continuation/quoted line inside an
 * EARLIER or LATER entry can carry byte-identical text) — and because the
 * mis-targeted span is byte-identical to `targetText`, no downstream check
 * on the WRITTEN text could ever distinguish a wrong-entry write from a
 * correct one. Carrying the span removes the re-derivation step entirely:
 * there is no second search to mis-target.
 *
 * Section-anchored (BLOCKER 1, #3458 follow-up review): the span is
 * `sectionBody`-relative — the SAME string `matches`/the `ambiguous` guard
 * were computed over — not `content`-relative, so an identical bullet living
 * outside `## Deferred Items` (e.g. in an unrelated `# Notes` or a
 * UAT/VERIFICATION body) can never steal the write. The span is translated
 * into `content`-relative offsets via `deferredSection.bodyStart` (the
 * section's own start offset, an invariant `collectSection` guarantees:
 * `content.slice(bodyStart, bodyEnd) === body`). Before writing, the
 * spanned text's own raw entry is re-derived and compared against
 * `targetText` one more time — this is now a GENUINE invariant check (the
 * span was computed by `splitGapsEntriesCore`'s independent offset
 * bookkeeping, a different code path than the `entryLines`/`targetText`
 * comparison above), not a no-op — if it does not match, the write is
 * refused with `match_verification_failed` rather than risk touching the
 * wrong span.
 */
function acknowledgeDeferredItem(content: string, targetText: string): AcknowledgeDeferredItemResult {
  const deferredSection = collectSection(
    content,
    (h) => /^deferred\s+items$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  const sectionBody = deferredSection ? deferredSection.body : content;

  // #3781: the heading-delimited shape carries its own spans, recorded by
  // the reader's walk; the headless path below is unchanged.
  const headingEntries = splitDeferredHeadingEntriesDetailed(sectionBody);
  if (headingEntries !== null) {
    return acknowledgeHeadingShapedEntry({ content, sectionBody, deferredSection, headingEntries, targetText });
  }

  const entries = splitGapsEntriesWithSpans(sectionBody, DEFERRED_BULLET_MARKERS);
  const matches = entries
    .map((entry) => ({ entry, text: rawGapEntryText(entry.lines, DEFERRED_BULLET_MARKERS) }))
    .filter((e) => e.text === targetText);

  if (matches.length === 0) return { content, status: 'not_found' };
  if (matches.length > 1) return { content, status: 'ambiguous' };

  const { entry } = matches[0];
  const { lines: entryLines, start, end } = entry;
  const fields = extractGapEntryFields(entryLines, DEFERRED_BULLET_MARKERS);
  if (fields.status && fields.status.toLowerCase() === 'resolved') {
    return { content, status: 'already_resolved' };
  }

  // Anchor to the SAME section body `matches`/the `ambiguous` guard above
  // were computed over (BLOCKER 1) — never the whole `content`, which could
  // contain an identical bullet elsewhere. `start`/`end` are the entry's own
  // span, carried directly from `splitGapsEntriesWithSpans` — no re-search.
  const sectionOffset = deferredSection ? deferredSection.bodyStart : 0;
  const matchedLines = sectionBody.slice(start, end).split('\n');

  // Genuine invariant re-verification (see doc comment above): the span was
  // computed by a code path independent of the `entryLines`/`targetText`
  // comparison that selected this entry — this catches real drift between
  // the two rather than a regex trivially guaranteed to agree with itself.
  const strippedForVerify = matchedLines.map((l) => l.replace(/\r$/, ''));
  if (rawGapEntryText(strippedForVerify, DEFERRED_BULLET_MARKERS) !== targetText) {
    return { content, status: 'match_verification_failed' };
  }

  const matchIndexInContent = sectionOffset + start;
  // Locate the status line with the READER'S OWN classifier, never a
  // writer-side regex (#3702 round 3, B1/B3 — the shape is #3773's,
  // parameterised here by the widened marker set per the round-3 review's
  // prescribed end state). The only line worth rewriting in place is one the
  // reader will read back as `fields.status`.
  //
  // What this closes: round 2 widened the writer's finder to the deferred
  // marker set while `extractGapEntryFields` still read a marker only on line
  // 0. A nested `  * status: pending` was therefore SELECTED by the writer and
  // invisible to the reader — acknowledge rewrote it, returned `ok`, and the
  // item stayed outstanding forever. Measured against a `next` build: `*`, `+`
  // and `1.` all resolved on base and stopped resolving here, so it was a
  // regression, not a gap in new behaviour. The hyphen form of the same shape
  // (`  - status:`) was already broken on `next`; it is fixed here too, since
  // one classifier cannot be right for three markers and wrong for the fourth.
  //
  // A line the reader skips falls through to the INSERT branch, which writes a
  // line the reader does read — the fail-safe direction. That covers a bare
  // capitalised `Status:` (the reader stores it under `Status`, not `status`)
  // and a `status:` line inside a fenced block, both of which the writer must
  // NOT rewrite in place. Selecting either one produced an entry that could not
  // be acknowledged at all; that is why the selection goes through
  // `entryFieldLines` rather than the classifier directly.
  const statusLineIdx = entryFieldLines(matchedLines, DEFERRED_BULLET_MARKERS)
    .findIndex((field) => field?.key === 'status');

  // Per-line CRLF preservation is the honest in-memory contract. The lines
  // here are RAW — `audit acknowledge` hands this function the `readFileSync`
  // content of an on-disk `deferred-items.md`, and `_normalizeMd` runs only on
  // WRITE — so on a CRLF document every line but the span's last still carries
  // its `\r`. The write path's whole-file normalization still decides what
  // reaches disk; this function does not duplicate that decision, and it no
  // longer silently drops the `\r` either. (Round 2's comment here argued the
  // opposite contract. It is withdrawn: #3773 documents per-line preservation
  // in this same function, and two opposite contracts in one function was a
  // round-3 blocker in its own right.)
  let newMatchedLines: string[];
  if (statusLineIdx === -1) {
    const bulletIndentMatch = matchedLines[0].replace(/\r$/, '').match(DEFERRED_BULLET_MARKERS.strip);
    // The entry's own indent CHARACTERS, never a count of them — a tab counted
    // as one column and re-emitted as one space puts a 3-space continuation
    // under a tab-indented bullet. Identical output for all-space indents.
    const continuationIndent = `${bulletIndentMatch ? bulletIndentMatch[1] : ''}  `;
    // The new line goes right after line 0, so line 0 stops being the span's
    // last line. Under CRLF the span's last line is the one WITHOUT a `\r`
    // (the file's own `\r\n` follows the span), so the ending is read from the
    // entry's OWN boundary and never sniffed from the whole document — a
    // mixed-ending file must keep its LF opener. At end-of-file there is no
    // following separator, so the boundary immediately PRECEDING the entry is
    // the remaining local evidence; an entry at offset 0 has neither and stays
    // LF rather than inventing an ending from nothing.
    const line0HadCr = matchedLines[0].endsWith('\r');
    // A single-line entry's line 0 IS the span's last line, so its own
    // terminator sits OUTSIDE the span and the separator FOLLOWING the span is
    // the evidence. At end-of-file there is no such separator, and reading its
    // absence as "not CRLF" is what joined a CRLF entry to its inserted line
    // with a bare `\n`. `crlfAtEof` answers the weaker question that remains,
    // over the entry's own SECTION when one is delimited and the entry list
    // alone when none is — widening to everything before the insertion point
    // only where that region is empty, which is #3773's B4. See its doc comment.
    const spanEnd = matchIndexInContent + (end - start);
    const eofScope = sectionBody.slice(deferredSection ? 0 : entries[0].start, start)
      || sectionBody.slice(0, start);
    const crlf = matchedLines.length > 1
      ? line0HadCr
      : content.startsWith('\r\n', spanEnd)
        || (spanEnd >= content.length && crlfAtEof(eofScope));
    newMatchedLines = [
      crlf ? `${matchedLines[0].replace(/\r$/, '')}\r` : matchedLines[0],
      `${continuationIndent}status: acknowledged${line0HadCr ? '\r' : ''}`,
      ...matchedLines.slice(1),
    ];
  } else {
    // Rewrite at the offset the CLASSIFIER reported, rather than through a
    // second regex of the writer's own. This is what makes the selection and
    // the rewrite structurally incapable of disagreeing: a status line the
    // classifier can select is one whose value offset it has already
    // computed, so there is no shape it selects and then fails to rewrite.
    // (A widened classifier over a hyphen-only rewrite regex is exactly that
    // failure — it would select `* status: open` and hand back the line
    // untouched.) The key's own spelling and any `**bold**` wrapper survive
    // because only the value is replaced.
    const raw = matchedLines[statusLineIdx];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = raw.slice(0, raw.length - cr.length);
    const field = parseGapEntryFieldLine(line, DEFERRED_BULLET_MARKERS, statusLineIdx === 0)!;
    const prefix = line.slice(0, field.valueStart);
    // `status:acknowledged` reads back fine, but a bare colon with no
    // separator is not what this file's convention looks like; supply one only
    // when the source had none.
    const sep = /[ \t]$/.test(prefix) ? '' : ' ';
    newMatchedLines = matchedLines.slice();
    newMatchedLines[statusLineIdx] = `${prefix}${sep}acknowledged${cr}`;
  }

  // NO post-write read-back guard here, deliberately (round 4, B3). Round 3
  // added one — `rewrite_not_readable` — after a fenced `status:` line proved
  // the writer could select a line the reader would not read back. Round 3
  // then closed that divergence STRUCTURALLY, by routing the writer's line
  // selection and the reader's field extraction through the one
  // `entryFieldLines` seam above, and the guard became unreachable from the
  // public API: 21 document shapes were driven against it (fence openers on
  // the bullet line for every marker, duplicate and triplicate `status:`
  // lines, bolded and nested variants, fences between duplicates) and none
  // reached it.
  //
  // An unreachable branch is not free here. This repo's own
  // `RULESET.TESTS.mutation-score` runs Stryker incrementally over changed
  // files at an 80% threshold and says to "treat surviving mutant as a failing
  // test specification"; an undriven `if` is exactly that. The only seam that
  // would drive it is routing this call through the module's exports so a test
  // could stub it — production surface reshaped for a test, which is a worse
  // trade than the guard is worth now that construction, not assertion,
  // enforces the invariant.
  //
  // What that gives up, stated plainly rather than hidden: if a future change
  // re-splits the writer's selection from the reader's extraction, this
  // function returns `ok` over an item that stays outstanding — the original
  // #3702 defect class. `match_verification_failed` does NOT backfill it; that
  // check runs BEFORE the write and compares the matched span to the target,
  // so it cannot see a post-write read-back failure. The protection against
  // re-splitting is the shared seam plus the round-3 tests that pin it, not a
  // runtime assertion.

  const newContent = content.slice(0, matchIndexInContent) + newMatchedLines.join('\n') + content.slice(matchIndexInContent + (end - start));
  return { content: newContent, status: 'ok' };
}

/**
 * #3781 — strip an ATX heading prefix, mirroring `tokenizeHeadings`' own ATX
 * regex (≤3 leading spaces, 1–6 `#`, space/tab separator, optional closing
 * `#` sequence) so the raw heading line reconciles byte-exactly with the
 * hash-stripped `text` the reader exposes. Returns null when the line is not
 * an ATX heading line.
 */
function stripAtxPrefix(line: string): string | null {
  const m = /^( {0,3})(#{1,6})([ \t]+.*|[ \t]*)?$/.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  return m[3] === undefined
    ? ''
    : m[3].replace(/^[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
}

/**
 * #3781 — the heading-shaped half of `acknowledgeDeferredItem`, sharing the
 * headless path's guards (not_found / ambiguous / already_resolved /
 * match_verification_failed) and its rewrite/insert machinery, with the two
 * shape-specific rules documented on `acknowledgeDeferredItem` (reader-form
 * status search incl. the leaf line-0 ATX corner; insert after the entry's
 * last non-blank line). Extracted so the headless path stays byte-identical.
 *
 * Every question about an entry is asked of the READER'S OWN answer (#3702
 * round 3, B1/B3 — restated here rather than re-implemented): identity is
 * `rawGapEntryText` over the walk's lines and opener flags, exactly as
 * `parseDeferredItemsWithStatus` names the entry; the status line is whichever
 * line `entryFieldLines` classifies as `status`, so a fenced `status:` or a
 * rejected-ordinal prose line is never selected; and the rewrite lands at the
 * offset the classifier reported. Upstream's #3781 carried its own
 * hyphen-only walk and its own status regexes for this shape; under the
 * widened marker grammar those would have read a different entry set than
 * the reader and re-opened the writer/reader drift this PR closes.
 */
function acknowledgeHeadingShapedEntry({ content, sectionBody, deferredSection, headingEntries, targetText }: {
  content: string;
  sectionBody: string;
  deferredSection: { body: string; bodyStart: number } | null;
  headingEntries: DeferredHeadingEntry[];
  targetText: string;
}): AcknowledgeDeferredItemResult {
  const matches = headingEntries.filter(
    (e) => rawGapEntryText(e.lines, DEFERRED_BULLET_MARKERS, e.opener) === targetText,
  );
  if (matches.length === 0) return { content, status: 'not_found' };
  if (matches.length > 1) return { content, status: 'ambiguous' };
  const entry = matches[0];
  // A table row inside the span: the walk skipped it, so `lines` is not 1:1
  // with the raw slice and no write can be anchored. Refuse, as before #3781.
  if (entry.embeddedTable) return { content, status: 'unsupported_heading_shape' };
  const fields = extractGapEntryFields(entry.lines, DEFERRED_BULLET_MARKERS, entry.opener);
  if (fields.status && fields.status.toLowerCase() === 'resolved') {
    return { content, status: 'already_resolved' };
  }

  const sectionOffset = deferredSection ? deferredSection.bodyStart : 0;
  const rawLines = sectionBody.slice(entry.start, entry.end).split('\n');
  // The reader-form of the raw slice, index-aligned with it: a leaf's line 0
  // is the heading TEXT (re-derived from the span's own bytes, not copied
  // from the walk, so the verification below is genuine), every other line
  // CR-stripped. Markers stay on the lines — the classifier strips them per
  // the opener flags, exactly as the reader does.
  const readerLines = rawLines.map((raw, i) => {
    const line = raw.replace(/\r$/, '');
    return i === 0 && entry.kind === 'leaf' ? (stripAtxPrefix(line) ?? line) : line;
  });
  // Genuine invariant re-verification: the identity re-derived from the
  // span's bytes must be the identity that selected the entry — the span was
  // recorded by offset bookkeeping independent of that comparison.
  if (readerLines.length !== entry.lines.length
    || rawGapEntryText(readerLines, DEFERRED_BULLET_MARKERS, entry.opener) !== targetText) {
    return { content, status: 'match_verification_failed' };
  }

  const statusLineIdx = entryFieldLines(readerLines, DEFERRED_BULLET_MARKERS, entry.opener)
    .findIndex((field) => field?.key === 'status');

  let newRawLines: string[];
  if (statusLineIdx === -1) {
    // Insert branch: after the entry's LAST NON-BLANK line — a heading
    // entry's body is frequently a soft-wrapped sentence, and splicing after
    // line 0 would split it in half (#3781's sentence trap). The headless
    // (no-heading-anywhere) path keeps its own splice-after-line-0 shape.
    // …and never INSIDE a fence (round 5, RV6.5 review): an entry whose body
    // ends in a fenced block — closed or, worse, unclosed and so running to
    // the entry's end — would otherwise receive its marker as fence content,
    // a line the reader never reads: `ok` returned, item still outstanding.
    // Walk back over blank and fenced lines alike, classified exactly as the
    // reader classifies them, so the marker lands on a line the reader reads.
    const fencedInEntry = entryFencedLines(readerLines, DEFERRED_BULLET_MARKERS, entry.opener);
    let last = rawLines.length - 1;
    while (last > 0 && (readerLines[last].trim() === '' || fencedInEntry.has(last))) last--;
    // A pending entry's continuation sits two columns inside its own marker
    // indent (the entry's indent CHARACTERS, as the headless path does); a
    // leaf's body lines are sibling bullets, and an indented bare field line
    // among them is what the reader reads on that shape.
    const indent = entry.kind === 'pending'
      ? `${rawLines[0].replace(/\r$/, '').match(DEFERRED_BULLET_MARKERS.strip)?.[1] ?? ''}  `
      : '  ';
    // The inserted line copies the ending of the line it follows. When that
    // line is the span's LAST, its terminator sits outside the span: the
    // separator following the span decides, else (end of file) the section's
    // own evidence — the same rule the headless path applies to line 0.
    const followsLast = last === rawLines.length - 1;
    const spanEnd = sectionOffset + entry.end;
    const prevCr = followsLast
      ? content.startsWith('\r\n', spanEnd) || (spanEnd >= content.length && crlfAtEof(sectionBody.slice(0, entry.start)))
      : rawLines[last].endsWith('\r');
    newRawLines = rawLines.slice();
    if (followsLast && prevCr) newRawLines[last] = `${rawLines[last].replace(/\r$/, '')}\r`;
    newRawLines.splice(last + 1, 0, `${indent}status: acknowledged${!followsLast && prevCr ? '\r' : ''}`);
  } else {
    // Rewrite at the offset the CLASSIFIER reported, on the RAW line — the
    // marker, the indent, the key's spelling and any `**bold**` wrapper all
    // survive because only the value is replaced. A leaf's line 0 is the
    // heading line, so its ATX prefix is put back in front of the rewritten
    // text (the reader reads the heading text itself as the field there).
    const raw = rawLines[statusLineIdx];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = raw.slice(0, raw.length - cr.length);
    const reader = readerLines[statusLineIdx];
    const field = parseGapEntryFieldLine(reader, DEFERRED_BULLET_MARKERS, stripsMarkerAt(statusLineIdx, entry.opener))!;
    const prefix = reader.slice(0, field.valueStart);
    const sep = /[ \t]$/.test(prefix) ? '' : ' ';
    const leafLine0 = statusLineIdx === 0 && entry.kind === 'leaf';
    const atx = leafLine0 ? (/^( {0,3}#{1,6}[ \t]+)/.exec(line)?.[1] ?? '') : '';
    // A closing `#` sequence is Markdown the reader ignores; keep it (RV6.5).
    const closing = leafLine0 ? (/[ \t]+#+[ \t]*$/.exec(line)?.[0] ?? '') : '';
    newRawLines = rawLines.slice();
    newRawLines[statusLineIdx] = `${atx}${prefix}${sep}acknowledged${closing}${cr}`;
  }

  const matchIndexInContent = sectionOffset + entry.start;
  const newContent = content.slice(0, matchIndexInContent) + newRawLines.join('\n') + content.slice(matchIndexInContent + (entry.end - entry.start));
  return { content: newContent, status: 'ok' };
}

/**
 * The two regex shapes a bullet-aware walk needs over one marker set: `open`
 * detects an entry-opening marker, `strip` additionally captures the line's
 * remaining content. Carrying both in ONE object is what keeps a detection
 * site and its matching strip site from drifting to different marker sets —
 * the asymmetry #3702 warns about (widen what OPENS an entry without widening
 * what is STRIPPED before field extraction, and a status field written under
 * the new marker never resolves its entry).
 */
interface BulletMarkers {
  /** `^(indent)(<marker>)\s` — group 1 is the indent, group 2 the marker token. */
  open: RegExp;
  /** `^(indent)<marker>\s+(rest)$` — group 1 indent, group 2 rest-of-line. */
  strip: RegExp;
  /**
   * Honour Markdown block structure — thematic breaks close the list, fenced
   * code neither opens an entry nor carries a field (#3702 round 2, M1/M2),
   * and indents are measured in CommonMark columns rather than raw characters.
   * `false` for the Gaps grammar, which #3702's ruling keeps byte-for-byte on
   * its `next` behaviour; `true` for the deferred-items grammar. Carried on the
   * marker set rather than as a second parameter so a caller cannot widen one
   * without the other.
   */
  blockStructure: boolean;
}

/**
 * Hyphen-only markers — the `## Gaps` form, unchanged by #3702. Gaps entries
 * come from a template that mandates the hyphen YAML-lite shape, so widening
 * that section's grammar is not what the deferred-items ruling required; the
 * shared splitting seam is parameterised rather than widened wholesale so the
 * Gaps path stays byte-for-byte on its existing behaviour.
 */
const HYPHEN_BULLET_MARKERS: BulletMarkers = {
  open: /^(\s*)(-)\s/,
  strip: /^(\s*)-\s+(.*)$/,
  blockStructure: false,
};

/**
 * Deferred-items markers (#3702): the standard Markdown list markers, not the
 * hyphen alone. `deferred-items.md` has NO template and no mandated shape —
 * executors write it by hand (the same premise that justified the #2766 table
 * union) — so an author reaching for `*`, `+` or `1.` wrote a list by every
 * Markdown definition while this parser contributed ZERO entries for it. The
 * hyphen restriction was a regex literal inherited from the Gaps seam, never a
 * stated decision: measured in the wild, non-empty records parsed to a clean
 * zero, and a MIXED file dropped its non-hyphen entries while keeping their
 * hyphenated siblings — under-reporting without ever looking empty.
 *
 * Deliberately NOT widened to prose: "prose is not an item" is this parser's
 * pre-existing, test-asserted contract (the `# Notes` case) and is untouched
 * here. An asterisk bullet is not prose, and a `|` row is not a list marker —
 * table lines are still skipped before the body-bullet flag can be set, so
 * `parseDeferredTableItems` keeps sole ownership of table bodies and the
 * #2766 anti-double-count property holds unchanged.
 *
 * The paren-terminated ordered form (`1)`) is out of scope for this fix: the
 * #3702 ruling scopes the widening to `*`, `+` and the dot-terminated ordered
 * marker.
 *
 * `DEFERRED_MARKER_ALT` is THE source every deferred-items marker regex is
 * built from (#3702 round 2, M3). Since round 3 that is the splitter's
 * `open`/`strip` pair here and nothing else: `acknowledgeDeferredItem`'s two
 * status-line shapes used to be derived from it too, and are now deleted in
 * favour of the reader's classifier. CommonMark
 * §5.2: bullet markers `-`, `*`, `+`; an ordered marker is 1-9 digits and a
 * `.` (round-1's `\d+` was uncapped). The marker is followed by a space or a
 * tab — `[ \t]`, where round 1 wrote `\s`, which also accepted `\r`.
 * `markdown-sectionizer`'s `iterateBullets` is the repo's other list-marker
 * grammar; the `#3702 round 2: marker-grammar parity` test pins this one to
 * it on the shared vocabulary and names the two points they deliberately
 * differ (tab after the marker, the 9-digit cap).
 */
const DEFERRED_MARKER_ALT = '(?:[-*+]|\\d{1,9}\\.)';
const DEFERRED_BULLET_MARKERS: BulletMarkers = {
  open: new RegExp(`^(\\s*)(${DEFERRED_MARKER_ALT})[ \\t]`),
  strip: new RegExp(`^(\\s*)${DEFERRED_MARKER_ALT}[ \\t]+(.*?)\\r?$`),
  blockStructure: true,
};

// `acknowledgeDeferredItem` carries NO status-line regex of its own (#3702
// round 3, B1/B3). It used to hold two — a finder and a rewrite — derived
// from `DEFERRED_MARKER_ALT` so the two WRITER shapes could not drift from
// each other. That kept the wrong pair in step: the finder's peer is the
// READER, and widening detection without widening the read is what made a
// nested `  * status:` line selectable by the writer and invisible to
// `extractGapEntryFields`. Both are gone; the writer now locates its line
// through `parseGapEntryFieldLine`, the reader's own classifier, and rewrites
// at the offset that classifier reports. See `parseGapEntryFieldLine`.

/**
 * CommonMark §4.1 thematic break: up to 3 spaces of indent, then three or
 * more of the SAME `-`, `*` or `_`, optionally space/tab-separated, and
 * nothing else. `- - -`, `* * *` and `+ + +` all also match a list opener —
 * `- - -` was a phantom `"- -"` entry on base, and #3702's widening added the
 * other two (#3702 round 2, M1). `+ + +` is not a CommonMark break, but it is
 * the same authoring gesture and no less garbage as an entry name, so the
 * class here is "three-or-more of one marker character, nothing else". The
 * indent is unbounded, not CommonMark's `{0,3}`: this parser reads a list at
 * any indent (see `#3702 round 2` m1), so a separator drawn at any indent is
 * a separator too — otherwise `    * * *` is a phantom entry named `* *`.
 */
const THEMATIC_BREAK_RE = /^[ \t]*([-*+_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * The deferred grammar's line view for fence classification: the SAME lines,
 * with leading whitespace removed (#3702 round 4, M2).
 *
 * `scanFencedBlocks` is CommonMark, and CommonMark caps a fence delimiter's
 * indent at three spaces — a fourth makes it an indented code block instead.
 * The deferred grammar deliberately opted out of that cliff everywhere else:
 * an entry opener is `[ \t]*`-indented and `THEMATIC_BREAK_RE` is
 * `^[ \t]*`. Leaving the fence rule at CommonMark's cap while items and
 * breaks are unbounded is not a conservative choice, it is an inconsistent
 * one, and it is REACHED BY ORDINARY DOCUMENTS: a fenced block written under a
 * nested bullet sits at four spaces, so its `status: resolved` line resolved
 * the entry containing it. That is the #3702 silent-resolution defect class in
 * a new place — driven, at indents 4, 5, 8 and a leading tab, before this fix.
 *
 * Still NO second fence dialect (the rule `blankIndentedFenceDelimiters`
 * states): the classification is done by `scanFencedBlocks`, the one exported
 * CommonMark state machine, over a de-indented view. Run lengths, backtick
 * vs tilde, closer-must-match-and-not-trail and info-string rules are all
 * still that engine's answers, not re-derived here; the unterminated case is
 * its answer too, bounded by the walk (round 5, B1 — see `scanFencesFrom`). Indent is the only dimension this hides from it, and it is
 * the exact dimension the deferred grammar has already declared it does not
 * measure. Index alignment is 1:1 by construction — `map` preserves length —
 * so every line index the engine returns still addresses the original line.
 *
 * Scope: the deferred grammar only. Both marker-parameterised call sites gate
 * on `markers.blockStructure`, which the `## Gaps` set does not set, so Gaps
 * reaches an empty set and is untouched by this — the same opt-out
 * `indentWidth` documents for the indent half.
 */
function deindentedForFences(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^[ \t]+/, ''));
}

/**
 * Indices (into `lines`) of every line that sits inside a fenced code block,
 * delimiters included — by the sectionizer's own fence state machine, so a
 * `~~~` fence, an indented fence and an unterminated fence (runs to the end)
 * are classified exactly as `stripFencedCode` would (#3702 round 2, M2), at
 * ANY indent (round 4, M2 — see `deindentedForFences`).
 * #3702's wild records carry reproduction blocks; `+`-prefixed diff lines and
 * `1.`-numbered steps are their normal content, not entries.
 *
 * ENTRY-scoped: `lines` are ONE entry's lines (`entryFieldLines`), so an
 * unterminated fence "running to the end" runs to the end of that entry —
 * exactly the bound the section-level walks give it (round 5, B1; see
 * `scanFencesFrom`). The two classifications agree by construction.
 */
function fencedLineSet(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  for (const block of scanFencedBlocks(deindentedForFences(lines))) {
    const last = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
    for (let i = block.openLineIdx; i <= last; i++) fenced.add(i);
  }
  return fenced;
}

/**
 * Fence classification for a SECTION-level walk (round 5, B1). Terminated
 * fences are classified wholesale, as `fencedLineSet` does. The UNTERMINATED
 * fence is the difference: `scanFencedBlocks` runs it to the end of the
 * document, and so did round 4 — at any indent, since round 4's M2 — so one
 * stray delimiter swallowed every entry after it into the entry before it.
 * `- a` / blank / four-space ``` / blank / `- b` yielded ONE entry where
 * `next` yields two: a widening that made an already-counted item vanish,
 * in the direction of silent data loss, on the exact mixed-file shape #3702
 * exists to close.
 *
 * The rule now: an unterminated fence runs to the end of its ENTRY, never
 * past it. That is CommonMark's own answer for a fence inside a list item —
 * the fence closes when its container does, and the container closes at the
 * next item at its level — extended to a document-level stray delimiter,
 * where CommonMark would swallow to end-of-file and this parser's fail-safe
 * rule (surface a questionable entry rather than drop a real one) will not.
 * The scan therefore reports the unterminated opener's index and leaves the
 * bound to the walk, which knows what a top-level item is: on reaching one,
 * the walk RESCANS from that line, so a delimiter after the bound is read on
 * its own terms rather than as the content of a fence that has ended. Still
 * no second fence dialect — every block boundary is `scanFencedBlocks`'
 * answer; the walk contributes only the bound.
 */
interface FenceScan {
  /** Lines inside a TERMINATED fence, delimiters included. */
  fenced: Set<number>;
  /** Every fence opener, terminated or not — an opener ends the list runs at its level, as a paragraph does. */
  openers: Set<number>;
  /** Opener index of the one unterminated fence in scope, else -1. Lines from it onward are fenced until the walk bounds it. */
  unterminatedFrom: number;
}

function scanFencesFrom(lines: string[], from: number): FenceScan {
  const scan: FenceScan = { fenced: new Set<number>(), openers: new Set<number>(), unterminatedFrom: -1 };
  for (const block of scanFencedBlocks(deindentedForFences(lines.slice(from)))) {
    const open = block.openLineIdx + from;
    scan.openers.add(open);
    if (block.closeLineIdx === -1) {
      scan.unterminatedFrom = open; // always the scan's last block
      break;
    }
    for (let i = open; i <= block.closeLineIdx + from; i++) scan.fenced.add(i);
  }
  return scan;
}

/** The scan a grammar without block structure (`## Gaps`) walks under: nothing is fenced. Never mutated. */
const NO_FENCES: FenceScan = { fenced: new Set<number>(), openers: new Set<number>(), unterminatedFrom: -1 };

/**
 * Does `line` LOOK like a top-level list item under `markers` — a marker at
 * or above the base indent, start value ignored? The bound an unterminated
 * fence runs to (round 5, B1; see `scanFencesFrom`). Shape rather than the
 * ordered-start rule, because the list memory inside a fence is not evidence
 * of anything, and closing a stray fence one line early errs in the
 * surfacing direction.
 */
function topLevelItemShape(line: string, markers: BulletMarkers, baseIndent: number | null): boolean {
  const m = line.match(markers.open);
  return m !== null && (baseIndent === null || indentWidth(m[1], markers) <= baseIndent);
}

/**
 * Per-indent LIST memory (#3702 round 2, round review; widened round 5, M2):
 * each list level remembers whether a list is OPEN there, so an ordered
 * marker that does not start at `0.`/`1.` is an item when it continues or
 * follows a list at its level, and prose otherwise. A new opener at indent
 * `d` resets every deeper level (a new item starts new sub-lists); a
 * paragraph after a blank at indent `d` ends the lists at `d` and deeper; a
 * thematic break or a heading clears everything.
 *
 * Round 2 keyed this on whether the previous opener was ORDERED, so a bullet
 * item closed the run and `1. a` / `- b` / `5. c` folded `5. c` into `b` —
 * the mixed-file under-report #3702 names as the shape that bites. In
 * CommonMark `5. c` there opens a fresh ordered list (`start=5`): a non-1
 * ordinal is refused only where it would INTERRUPT A PARAGRAPH (§5.3), and
 * after a list item it interrupts nothing. Keying on "a list is open here"
 * is that rule as far as this parser can state it without a paragraph model.
 */
class ListRuns {
  private readonly byIndent = new Set<number>();
  at(indent: number): boolean { return this.byIndent.has(indent); }
  opened(indent: number): void {
    for (const d of [...this.byIndent]) if (d > indent) this.byIndent.delete(d);
    this.byIndent.add(indent);
  }
  endedAt(indent: number): void {
    for (const d of [...this.byIndent]) if (d >= indent) this.byIndent.delete(d);
  }
  clear(): void { this.byIndent.clear(); }
}

/**
 * Leading-whitespace width of a line in CommonMark COLUMNS (§2.2: a tab
 * advances to the next multiple of 4), so `\t` and ` ` are different levels
 * and `\t` equals four spaces — character counting aliased them.
 */
/**
 * Indent WIDTH under a grammar (#3702 round 2, review round 6). The deferred
 * grammar measures CommonMark columns; the Gaps grammar keeps `next`'s raw
 * character count, because its `blockStructure: false` opt-out promises
 * byte-for-byte parity and a column measure silently breaks it — a
 * tab-indented Gaps item followed by a two-space one split into two entries
 * where `next` folded them into one, and the reverse pair folded where `next`
 * split. The opt-out now covers indent semantics, not only fences and breaks.
 */
function indentWidth(indent: string, markers: BulletMarkers): number {
  return markers.blockStructure ? indentOf(indent) : indent.length;
}

function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** A line classified as a list-item opener by `matchListOpener`. */
interface ListOpener {
  /** Width of the indent before the marker. */
  indent: number;
}

/**
 * Classify `line` as a list-item opener under `markers`, applying the
 * ORDERED-START rule (#3702 round 2, B2; round 5, M1/M2): a dot-terminated
 * ordered marker opens an item when it starts at `0.` or `1.` (`01.`
 * included), or when a list is already open at its level (`inList` — the
 * caller's per-indent memory).
 *
 * Why: `\d{1,9}\.` alone reads ordinary prose as a list. "2026. was a bad
 * year for this module" and, under a `### Notes` heading, "3. is the number
 * of retries we settled on." are both sentences, and both opened an entry on
 * round 1 — the second one straight through the "prose is not an item"
 * contract that round claimed to preserve. CommonMark §5.3 faces the same
 * ambiguity when an ordered list would interrupt a paragraph and resolves it
 * the same way: the list must start with 1. This parser has no paragraph
 * model, so it applies that rule wherever NO list is open at the line's
 * level — the positions a sentence can occupy. Where a list IS open,
 * CommonMark accepts any start (a list item interrupts no paragraph), and so
 * does this. Numbers after the first are ignored, as CommonMark ignores
 * them, so `1. / 3. / 7.` is a three-item run.
 *
 * `0.` is accepted as a start (round 5, M1): CommonMark §5.2 permits any
 * 1-9-digit start number and a `0.`-numbered list is ordinary; refusing it
 * dropped ONLY the first item, since the run then started at `1.` — the
 * under-report that looks like a clean parse. A sentence opening with "0."
 * is not a shape anyone writes.
 *
 * Stated cost, pinned by test: a list whose first ordinal is 2 or more, at a
 * paragraph position, reads as prose UNTIL its first `0.`/`1.` line — the
 * loss is that prefix, not the whole list. Every ordered record the #3702
 * scan found starts at 1, and the hyphen-style `- ` alternative loses
 * nothing, so the trade buys the prose contract back at no measured cost.
 *
 * Bullet markers carry no rule — an asterisk bullet is not prose.
 */
function matchListOpener(line: string, markers: BulletMarkers, inList: boolean): ListOpener | null {
  const m = line.match(markers.open);
  if (!m) return null;
  const token = m[2];
  if (/^\d/.test(token) && !inList && parseInt(token, 10) > 1) return null;
  return { indent: indentWidth(m[1], markers) };
}

/**
 * Split a deferred-items section body into entries delimited by LEAF headings
 * (#3457). Returns `null` when the body contains no heading at all — the
 * caller then falls back to `splitGapsEntries`, keeping headless
 * one-bullet-per-item files byte-for-byte on the pre-#3457 path.
 *
 * A heading is a CONTAINER (group/provenance/title label, contributes no
 * entry) iff the NEXT heading is deeper — a deeper heading lives inside its
 * span. Otherwise it is a LEAF: an entry boundary. This handles all three
 * corpus shapes without hardcoding a depth: flat `#` title + `##` entries
 * (title's next heading is deeper → container; each `##` followed by a
 * same-or-shallower heading → leaf), a `##` container with `###` entries
 * (container's next heading is deeper), and mixed-depth files where a
 * childless `##` entry sits alongside a `##` group with `###` children — every
 * childless heading is a leaf at whatever depth it is written. The shallower
 * rules the issue reports as already tried (split on every heading; shallowest
 * level; deepest level) each mis-count one of these shapes.
 *
 * A leaf entry is [heading text, ...body lines up to the next heading] and is
 * kept only when its body (minus table lines) contains at least one list item
 * — any of `-`, `*`, `+` or a dot-terminated ordered marker (#3702; the
 * hyphen-only form silently dropped `*`/`+`/ordered bodies), where an
 * ordered marker counts only under `matchListOpener`'s ordered-start rule:
 * - a prose-only or bare heading contributes nothing — "prose is not an item"
 *   is this parser's pre-existing contract (see the `# Notes` case);
 * - a table-only body is left entirely to `parseDeferredTableItems`, which
 *   unions over the same section body, so the heading cannot double-count the
 *   table's rows.
 *
 * Lines before the first heading, and lines directly under a container heading
 * (before its first child), are split one-bullet-per-item by the unchanged
 * `splitGapsEntries` — headless parity, so loose bullets before a later
 * heading group (the mixed shape) stay one item each.
 */
/**
 * A heading-path entry: its lines, the splitter's per-line opener verdict,
 * and — since #3781 — where it sits in the section body, so the writer can
 * anchor a rewrite without a second walk.
 */
interface DeferredHeadingEntry {
  lines: string[];
  /** `opener[i]` — line `i` opened a list item under `matchListOpener`'s rules. */
  opener: boolean[];
  /** `leaf` — a childless heading's entry, `lines[0]` its heading TEXT; `pending` — a headless bullet in the preamble or directly under a container heading. */
  kind: 'leaf' | 'pending';
  /** Character span within the section body — `sectionBody.slice(start, end)` is the entry's own raw text, CRLF intact, its lines 1:1 with `lines`. Both -1 when `embeddedTable`. */
  start: number;
  end: number;
  /** A GFM table row sat inside the span. Table lines belong to `parseDeferredTableItems` and are never entry lines, so the raw slice and `lines` disagree and no write can be anchored (#3781). */
  embeddedTable: boolean;
}

/** Character offset of each line's start and end within the text they were split from (on `\n`). */
function lineOffsets(lines: string[]): { lineStarts: number[]; lineEnds: number[] } {
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length;
    lineEnds.push(cursor);
    cursor += 1; // the '\n' separator — absent after the final line, but nothing reads past it
  }
  return { lineStarts, lineEnds };
}

/**
 * The heading-delimited split, carrying the per-line opener flags the deferred
 * field-extraction path needs (#3702 round 2, round review): the heading path
 * strips the marker off EVERY body line before field extraction (#3457), and a
 * line whose ordinal `matchListOpener` REJECTED must not be stripped — or
 * "3. status: resolved" as prose loses its `3. ` and reads as a resolved field.
 *
 * Since #3781 it also records each entry's character span (see
 * `DeferredHeadingEntry`) in this same pass — the reader's walk IS the
 * writer's walk, so there is no second copy of the grouping rules to drift.
 */
function splitDeferredHeadingEntriesDetailed(sectionBody: string): DeferredHeadingEntry[] | null {
  const headings = tokenizeHeadings(sectionBody);
  if (headings.length === 0) return null;

  const lines = sectionBody.split('\n');
  const { lineStarts, lineEnds } = lineOffsets(lines);
  const headingByLine = new Map<number, { text: string; isContainer: boolean }>();
  for (let i = 0; i < headings.length; i++) {
    // Container iff the next heading is deeper (see doc comment). An empty
    // heading text (`##` alone) does not itself mean container — the flag is
    // carried explicitly so a bare LEAF heading still opens an entry.
    const isContainer = i + 1 < headings.length && headings[i + 1].level > headings[i].level;
    headingByLine.set(headings[i].line, { text: headings[i].text, isContainer });
  }

  const entries: DeferredHeadingEntry[] = [];
  // The leaf entry being accumulated, with the raw line range it spans.
  let current: { lines: string[]; opener: boolean[]; startLine: number; endLine: number } | null = null;
  let currentHasBullet = false;
  // The headless-shaped region being accumulated (preamble / a container
  // heading's direct lines): the reader's table-filtered, CR-stripped view,
  // plus the raw line range it spans.
  let pending: string[] = [];
  let pendingStartLine = -1;
  let pendingEndLine = -1;
  // Table lines are never entry lines; where one sits INSIDE an entry's raw
  // range, that entry's span is non-contiguous (#3781, `embeddedTable`).
  const tableLines: number[] = [];
  const tableWithin = (from: number, to: number): boolean => tableLines.some((t) => t >= from && t <= to);
  // List memory for the leaf body being accumulated (#3702 round 2, B2) —
  // reset at every heading, so `### Notes` + "3. is the number…" is prose
  // while `### Steps` + "1. do / 2. then" is a list. A blank line then a
  // non-indented non-list line is a PARAGRAPH, which ends the list
  // (CommonMark §5.3); a non-indented line with no blank before it is lazy
  // continuation and keeps it open.
  const runs = new ListRuns();
  let blankSeen = false;
  // Same level rule as the headless splitter: the first opener in a leaf body
  // sets the base, and every indent at or shallower than it is one level.
  let bodyBase: number | null = null;
  const levelOf = (line: string): number => {
    const ind = indentOf(line);
    return bodyBase !== null && ind <= bodyBase ? bodyBase : ind;
  };
  let scan = scanFencesFrom(lines, 0);

  const flushCurrent = (): void => {
    // Keep the leaf entry only when its body carries a list item; the heading
    // text line itself (element 0) never counts as one.
    if (current !== null && currentHasBullet) {
      const table = tableWithin(current.startLine, current.endLine);
      entries.push({
        lines: current.lines,
        opener: current.opener,
        kind: 'leaf',
        start: table ? -1 : lineStarts[current.startLine],
        end: table ? -1 : lineEnds[current.endLine],
        embeddedTable: table,
      });
    }
    current = null;
    currentHasBullet = false;
  };
  const flushPending = (): void => {
    if (pendingStartLine !== -1) {
      // Headless-region entries carry the splitter's own opener flags — the
      // same run state (ordered start, paragraph reset) that split them. The
      // region is contiguous (a heading flushes it), so the core's
      // region-relative spans translate by the region's own offset — unless a
      // table row was skipped inside it, where the reader's view and the raw
      // region disagree and no span is claimed. Both views split identically
      // otherwise: the core CR-strips per line, and a table row is the only
      // line the reader's view omits.
      const table = tableWithin(pendingStartLine, pendingEndLine);
      const region = table ? pending.join('\n') : lines.slice(pendingStartLine, pendingEndLine + 1).join('\n');
      const base = lineStarts[pendingStartLine];
      for (const { lines: entryLines, opener, start, end } of splitGapsEntriesCore(region, DEFERRED_BULLET_MARKERS)) {
        entries.push({
          lines: entryLines,
          opener,
          kind: 'pending',
          start: table ? -1 : base + start,
          end: table ? -1 : base + end,
          embeddedTable: table,
        });
      }
    }
    pending = [];
    pendingStartLine = -1;
    pendingEndLine = -1;
  };
  const push = (line: string, i: number, opener: boolean): void => {
    if (current !== null) {
      current.lines.push(line);
      current.opener.push(opener);
      current.endLine = i;
    } else {
      pending.push(line);
      if (pendingStartLine === -1) pendingStartLine = i;
      pendingEndLine = i;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const heading = headingByLine.get(lineNo);
    if (heading !== undefined) {
      flushCurrent();
      // Headless-shaped region (preamble / container-direct bullets) ends at
      // ANY heading; flushing here keeps entries in document order even when
      // a container's direct bullets precede its first child entry.
      flushPending();
      runs.clear();
      blankSeen = false;
      bodyBase = null;
      // A heading ends the entry, and with it any unterminated fence (B1).
      scan = scanFencesFrom(lines, i + 1);
      if (!heading.isContainer) {
        // Leaf heading: open an entry with the heading text as line 0.
        current = { lines: [heading.text], opener: [false], startLine: i, endLine: i };
        currentHasBullet = false;
      }
      continue;
    }
    // CR-strip ONCE and carry the stripped line everywhere below — into the
    // entry itself included (#3702 round 2, B1). `collectSection` slices raw
    // `\n`-split lines, so on a CRLF file every body line but the last still
    // carries its `\r`; the per-line marker strip feeding field extraction is
    // `$`-anchored and fails on such a line, the marker survives into
    // `extractGapEntryFields`, and the field is silently lost — a `**Status:**`
    // that is not the file's final line then resurfaces its entry as open.
    // The headless path (`splitGapsEntriesCore`) already stores stripped lines.
    const line = lines[i].replace(/\r$/, '');
    // B1: an unterminated fence runs to the end of its entry. The next line
    // shaped like a top-level item ends it — rescan from there, so a later
    // delimiter is read on its own terms (see `scanFencesFrom`).
    if (scan.unterminatedFrom !== -1 && i > scan.unterminatedFrom && topLevelItemShape(line, DEFERRED_BULLET_MARKERS, bodyBase)) {
      scan = scanFencesFrom(lines, i);
    }
    if (scan.fenced.has(i) || (scan.unterminatedFrom !== -1 && i >= scan.unterminatedFrom)) {
      // Fence content is body text, never list-item evidence (M2) — and
      // never an opener, so it is never marker-stripped for fields either.
      // Its opener ends the runs at its level and deeper, as a paragraph does.
      if (scan.openers.has(i)) runs.endedAt(levelOf(line));
      push(line, i, false);
      continue;
    }
    // A thematic break is a separator: not evidence, and it clears the list
    // memory (M1). It stays a BODY line — the entry's span must stay
    // contiguous for the writer, and the entry's name stays what `next`
    // reported for a body containing one (round 5, m3).
    if (THEMATIC_BREAK_RE.test(line)) {
      runs.clear();
      blankSeen = false;
      push(line, i, false);
      continue;
    }
    // Table lines belong to parseDeferredTableItems, never to a heading entry.
    if (/^\s*\|/.test(line)) {
      tableLines.push(i);
      continue;
    }
    if (current !== null) {
      const opener = matchListOpener(line, DEFERRED_BULLET_MARKERS, runs.at(levelOf(line)));
      push(line, i, opener !== null);
      if (opener !== null) {
        currentHasBullet = true;
        if (bodyBase === null) bodyBase = opener.indent;
        runs.opened(levelOf(line));
      } else if (blankSeen && line.trim() !== '') {
        runs.endedAt(levelOf(line)); // a paragraph after a blank line ends the lists at its level and deeper
      }
      blankSeen = line.trim() === '';
    } else {
      push(line, i, false); // the core derives its own opener verdicts for the region
    }
  }
  flushCurrent();
  flushPending();

  return entries;
}

/**
 * Extract deferred entries from GFM pipe tables in a deferred-items.md body
 * (#2766) — a UNION with the bullet scan in `parseDeferredItems`.
 *
 * Cells are joined with ` — ` rather than taking only the first: these tables
 * carry the useful detail in the later columns (the failing seeds, the reason,
 * the owner), and dropping them would surface a name with no context.
 *
 * A row is skipped when any cell reads exactly `resolved`/`done`/`pass`
 * (case-insensitive), mirroring the "explicit resolution only" convention
 * `parseGapsItems` uses for `status: resolved` and `parseVerificationItems` uses
 * for its `hasPassResult` cell scan — so a human can close a tabled deferred
 * item in place and keep deferred-items.md the single source of truth.
 *
 * Deliberately permissive: an unrelated table in a deferred-items.md (say a
 * table of environment notes) will surface as deferred entries. That is the
 * correct fail-safe direction for a false-NEGATIVE bug — the whole file exists to
 * record outstanding work, and this module's established stance (see
 * parseGapsItems' 'unknown'-status fallback) is to surface a questionable entry
 * rather than silently drop a real one.
 */
function parseDeferredTableItems(sectionBody: string): UatItem[] {
  const items: UatItem[] = [];

  for (const { rows } of collectTableRows(sectionBody)) {
    for (const cells of rows) {
      if (cells.some(c => /^(resolved|done|pass)$/i.test(c))) continue;
      const name = cells.filter(c => c !== '').join(' — ');
      if (!name) continue;
      items.push({
        name,
        result: 'unresolved',
        category: 'deferred',
      });
    }
  }

  return items;
}

/**
 * One `splitGapsEntries` entry together with the exact character SPAN it
 * occupies within the `sectionBody` it was derived from —
 * `sectionBody.slice(start, end)` is the entry's own original text,
 * byte-for-byte (CRLF preserved, unlike `lines`, which strips a trailing
 * `\r` off every line). See `splitGapsEntriesWithSpans`'s doc comment for why
 * a caller would want this over the plain `lines` shape.
 */
interface GapsEntrySpan {
  lines: string[];
  /** `opener[i]` — line `i` was an ACCEPTED list opener (line 0 always; a nested one when accepted). */
  opener: boolean[];
  start: number;
  end: number;
}

/**
 * Shared walk behind `splitGapsEntries` and `splitGapsEntriesWithSpans` — ONE
 * pass over `sectionBody` that both groups its lines into entries (see
 * `splitGapsEntries`'s doc comment for the grouping rule) AND records each
 * entry's (start, end) character offset within `sectionBody`. Extracted so
 * the two public shapes can never drift apart on what counts as an entry
 * boundary — a second, independently-written grouping pass is exactly how a
 * span-carrying sibling could disagree with the plain-lines version it is
 * supposed to be span-annotating.
 *
 * `markers` selects the marker set an entry may OPEN with (#3702). It defaults
 * to the hyphen-only Gaps form, so every pre-existing caller is unaffected;
 * the deferred-items callers pass `DEFERRED_BULLET_MARKERS`. Parameterising
 * the shared seam — rather than widening it in place — is what keeps the
 * template-mandated Gaps grammar out of the deferred-items ruling's blast
 * radius while still leaving exactly ONE grouping pass in the module.
 */
function splitGapsEntriesCore(
  sectionBody: string,
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
): GapsEntrySpan[] {
  const rawLines = sectionBody.split('\n');
  const { lineStarts, lineEnds } = lineOffsets(rawLines);

  const entries: GapsEntrySpan[] = [];
  let current: string[] | null = null;
  let currentStartLine = -1;
  let currentEndLine = -1;
  let baseIndent: number | null = null;
  // List memory per indent (#3702 round 2, B2 + round review; round 5, M2) —
  // the top level decides entry boundaries; nested levels decide only which
  // continuation lines count as accepted openers for field stripping.
  const runs = new ListRuns();
  // Per-line opener flags for `current`, recorded HERE — the one place the
  // run state is known — so the heading path's strip-only-openers rule reads
  // the splitter's own verdict instead of re-deriving it (round review: a
  // re-derivation without the paragraph reset re-accepted a rejected ordinal).
  let currentOpeners: boolean[] = [];

  const flush = (): void => {
    if (current !== null) {
      entries.push({ lines: current, opener: currentOpeners, start: lineStarts[currentStartLine], end: lineEnds[currentEndLine] });
    }
  };

  // #3898 (from `next`): a spaced-hyphen thematic break (`- - -`, `- -`,
  // `-  -  -`, …) in `## Gaps` is a SEPARATOR, not an entry. The hyphen opener
  // matches it (hyphen + whitespace), which fabricated a gap named `- -` with
  // result 'unknown' — an item no edit can clear, because there is no entry,
  // only the separator the author wrote deliberately. A line whose content
  // after the opening marker is solely hyphens and spaces (with at least one
  // further hyphen) is skipped: it neither opens an entry nor folds into the
  // current one. Deliberately NOT a full thematic-break concept (option 2 in
  // the issue): a break does not close the Gaps list — entries after it keep
  // parsing. The deferred grammar (`blockStructure`) has its own, CommonMark
  // reading of the same line through THEMATIC_BREAK_RE below, where a break
  // CLOSES the list; this helper is consulted only for the Gaps set.
  const isSeparatorShaped = (line: string, bulletPrefixLen: number): boolean => {
    const remainder = line.slice(bulletPrefixLen);
    return /^[-\s]*$/.test(remainder) && remainder.includes('-');
  };

  // Block structure (M1/M2 + column indents) is a property of the GRAMMAR,
  // not of this seam: the Gaps set opts out and stays byte-for-byte on its
  // `next` behaviour — see `indentWidth` for the indent half of that opt-out.
  let scan = markers.blockStructure ? scanFencesFrom(rawLines, 0) : NO_FENCES;
  let blankSeen = false;
  // The run LEVEL of a line: every indent at or shallower than the list's
  // base is the one top level (a dedenting list keeps its entry boundaries);
  // deeper indents are their own nested levels.
  const levelOf = (line: string): number => {
    const ind = indentWidth(line.match(/^[ \t]*/)![0], markers);
    return baseIndent !== null && ind <= baseIndent ? baseIndent : ind;
  };
  rawLines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\r$/, '');
    // B1: an unterminated fence runs to the end of its entry — the next line
    // shaped like a top-level item ends it; rescan from there so a later
    // delimiter is read on its own terms (see `scanFencesFrom`).
    if (scan.unterminatedFrom !== -1 && idx > scan.unterminatedFrom && topLevelItemShape(line, markers, baseIndent)) {
      scan = scanFencesFrom(rawLines, idx);
    }
    if (scan.fenced.has(idx) || (scan.unterminatedFrom !== -1 && idx >= scan.unterminatedFrom)) {
      // Fence content never opens an entry (M2). Inside an open entry it is
      // continuation — pushed, so the span invariant `acknowledgeDeferredItem`
      // re-verifies still holds; before the first entry it is discarded. A
      // fence is a non-list block: its opener ends the runs at its level and
      // deeper, exactly as a paragraph does.
      if (scan.openers.has(idx)) runs.endedAt(levelOf(line));
      if (current !== null) {
        current.push(line);
        currentOpeners.push(false);
        currentEndLine = idx;
      }
      return;
    }
    if (markers.blockStructure && THEMATIC_BREAK_RE.test(line)) {
      // A thematic break closes the list (M1): the open entry ends here, the
      // break itself is neither an item nor a continuation, and nothing after
      // it joins the closed entry — the next opener starts fresh.
      flush();
      current = null;
      runs.clear();
      blankSeen = false;
      return;
    }
    // #3898 narrowed skip (review disposition a), Gaps set only: a
    // separator-shaped line is skipped when it sits BETWEEN entries (nothing
    // open yet, or it would open a top-level entry — where the phantom came
    // from). One landing strictly INSIDE a live entry (indent > baseIndent)
    // folds back as a continuation line, so the entry's GapsEntrySpan stays
    // byte-contiguous — the span invariant below and the ack writer's identity
    // re-verification both hold. The indent compare is the raw character
    // count, which is what `indentWidth` measures for the Gaps set.
    if (!markers.blockStructure) {
      const bulletMatch = line.match(/^(\s*)-\s/);
      if (
        bulletMatch && isSeparatorShaped(line, bulletMatch[0].length) &&
        (current === null || bulletMatch[1].length <= (baseIndent ?? 0))
      ) {
        return; // separator line between entries — neither an opener nor a continuation
      }
    }
    const opener = matchListOpener(line, markers, runs.at(levelOf(line)));
    if (opener !== null) {
      const { indent } = opener;
      if (baseIndent === null) baseIndent = indent;
      runs.opened(levelOf(line));
      if (indent <= baseIndent) {
        flush();
        current = [line];
        currentOpeners = [true];
        currentStartLine = idx;
        currentEndLine = idx;
        blankSeen = false; // an opener is not blank — the memory must not survive it
        return;
      }
    }
    if (current !== null) {
      current.push(line);
      currentOpeners.push(opener !== null);
      currentEndLine = idx;
      // A blank line then a top-level non-list line is a PARAGRAPH: the list
      // is over (CommonMark §5.3) and a later `5. x` is prose. Without the
      // blank it is lazy continuation and the run stays open.
      const blank = line.trim() === '';
      if (!blank && blankSeen && opener === null) runs.endedAt(levelOf(line));
      blankSeen = opener === null && blank;
    }
    // else: pre-first-bullet content (e.g. the template's HTML comment) — discarded.
  });
  flush();

  return entries;
}

/**
 * Split a `## Gaps` section body into per-entry line groups on TOP-LEVEL
 * bullet openers — `- ` for Gaps, or whichever set `markers` names (#3702:
 * the deferred-items callers pass the widened CommonMark set).
 *
 * The indentation of the FIRST bullet line encountered establishes the
 * "top-level" indent for the whole section; any subsequent `- `-opening line
 * at that same indent (or shallower) starts a NEW entry, while everything
 * more deeply indented — field continuation lines (`  status: ...`) AND
 * nested sub-lists (`    - src/foo.ts` under `  artifacts:`) — is folded into
 * the CURRENT entry. This keeps a `artifacts:`/`missing:` sub-list's `- `
 * items from being mis-split into spurious standalone entries (#2286 review
 * LOW finding).
 *
 * Lines before the first bullet (e.g. the `<!-- YAML format ... -->` comment
 * the template emits) are discarded. An empty/whitespace-only section body
 * (heading present, no bullets) returns `[]`. Fenced code never opens an
 * entry and a thematic break closes the open one (#3702 round 2, M1/M2).
 */
function splitGapsEntries(
  sectionBody: string,
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
): string[][] {
  return splitGapsEntriesCore(sectionBody, markers).map((entry) => entry.lines);
}

/**
 * Sibling of `splitGapsEntries` (F1, #3458 follow-up review) that ADDITIVELY
 * carries each entry's character span — every existing `splitGapsEntries`
 * caller (`parseGapsItems`, `parseDeferredItemsWithStatus`,
 * `splitDeferredHeadingEntriesDetailed`'s `flushPending`) is unaffected and keeps
 * using the plain `lines`-only shape. `acknowledgeDeferredItem` is the one
 * caller that needs a span: it used to select an entry via `splitGapsEntries`
 * and then RE-FIND that entry's location with a fresh regex search over
 * `sectionBody` — matching the FIRST occurrence of the entry's exact text,
 * not necessarily the entry actually selected (a continuation/quoted line
 * inside a DIFFERENT entry can carry byte-identical text). Because the
 * mis-targeted span is byte-identical to the target text, no check on the
 * WRITTEN result could ever tell a wrong-entry write apart from a correct
 * one. Carrying the span out of THIS same pass — the one that already knows
 * exactly where the entry lives — removes the re-derivation step entirely.
 */
function splitGapsEntriesWithSpans(
  sectionBody: string,
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
): GapsEntrySpan[] {
  return splitGapsEntriesCore(sectionBody, markers);
}

/**
 * Extract `key: value` fields from one Gaps entry's lines, anchored to the
 * START of each (bullet-marker-stripped, trimmed) line — never scanning the
 * REST of a line, so a colon-bearing phrase inside a quoted `truth`/`reason`
 * value is never misread as a field declaration (see `parseGapsItems`'s doc
 * comment for the false-negative this specifically guards against).
 *
 * Recognises a double-quoted value (`truth: "..."`, stripped of its wrapping
 * quotes — the value may itself contain any character, including `:`) or a
 * bare value (`status: open`, `test: 2`, `artifacts: []`) taken verbatim.
 * The FIRST occurrence of a given key wins (top-level fields always precede
 * any nested sub-list content in the template's field ordering); later
 * `key:`-shaped nested-list content is captured, if it parses as one, but
 * never overrides an already-seen top-level field.
 *
 * #3457: markdown emphasis around the KEY (`**Status:** resolved` — the
 * deferred-items convention bolds every field, and a bolded resolution marker
 * previously failed this regex outright and surfaced as its own bogus
 * unresolved entry) is unwrapped before the match, still anchored at the
 * start of the line. The unwrapped key is lower-cased, because the bolded
 * convention form is Title-cased (`**Status:**`) while the field vocabulary
 * this module reads is lowercase (`status`) — the same normalization
 * `mapGapsHeader` already applies to table header cells. Bare (unbolded) keys
 * keep their literal case, and mid-line emphasis is untouched, preserving the
 * start-anchored decoy invariant above.
 */
function extractGapEntryFields(
  entryLines: string[],
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
  openerFlags?: boolean[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  // A fenced line is content, not a field (#3702 round 2, round review): the
  // splitters already keep fence lines from OPENING an entry, and a
  // `status: resolved` quoted inside a code block must not resolve one either.
  // An entry is a contiguous slice and a fence never spans two entries (the
  // opener of the next entry would be fence content), so scanning the entry's
  // own lines classifies exactly what the splitter classified.
  //
  // RAW lines, and that is the fix for #3702 round 3, m7. The heading path
  // used to marker-strip its lines BEFORE calling this function, so the scan
  // below ran over text the splitter never saw: `- ```sh` is an ordinary
  // bullet to the splitter, but strips to ```` ```sh ````, which opens a
  // fence here that exists in no other pass. A `**Status:** resolved` line
  // after it was then suppressed as fence content and its resolved entry
  // resurfaced as open. The stripping now happens INSIDE this function, after
  // the fence scan, driven by the splitter's own per-line opener verdict.
  entryFieldLines(entryLines, markers, openerFlags).forEach((field) => {
    if (!field) return;
    if (!(field.key in fields)) fields[field.key] = field.value;
  });

  return fields;
}

/**
 * Per line of an entry, the field it declares — or `null` where it declares
 * none, INCLUDING because it is fenced.
 *
 * This is the seam, and it exists because `parseGapEntryFieldLine` alone was
 * not it (#3702 round 3, pre-push review). The reader applied the fence gate
 * before classifying and the acknowledge writer did not, so a `status:` line
 * inside a fenced block was selected by the writer and skipped by the reader:
 * the write produced a line nothing reads, the read-back guard refused it, and
 * the entry became impossible to acknowledge at all — `audit acknowledge`
 * surfaced an internal error and `complete-milestone` halted on it. That shape
 * acknowledged cleanly on `next`, so it was a regression introduced by the fix
 * for the nested-marker one, and the claim "the writer cannot select a line the
 * reader will not read back" was false while the fence gate lived on one side.
 *
 * Both sides call this now, so the claim is structural rather than asserted.
 */
function entryFieldLines(
  entryLines: string[],
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
  openerFlags?: boolean[],
): ({ key: string; value: string; valueStart: number } | null)[] {
  const fenced = entryFencedLines(entryLines, markers, openerFlags);
  return entryLines.map((rawLine, idx) => (
    fenced.has(idx) ? null : parseGapEntryFieldLine(rawLine, markers, stripsMarkerAt(idx, openerFlags))
  ));
}

/**
 * The fenced lines of ONE entry, as the reader and the writer both see them.
 * A leaf's line 0 is its heading TEXT, not a Markdown line: a heading that
 * reads ``` or ~~~ is a heading, and must not open a fence over the body
 * beneath it (round 5, RV6.5 — it fenced every field line, so the reader
 * read nothing and the writer's marker landed on a line nothing reads).
 * `openerFlags[0] === false` is the leaf tell: a pending or headless entry's
 * line 0 is an accepted opener, and a marker line is never a delimiter.
 */
function entryFencedLines(entryLines: string[], markers: BulletMarkers, openerFlags?: boolean[]): Set<number> {
  if (!markers.blockStructure) return new Set<number>();
  const leaf = openerFlags !== undefined && openerFlags[0] === false;
  return fencedLineSet(leaf ? ['', ...entryLines.slice(1)] : entryLines);
}

/**
 * Which lines of an entry carry an entry-opening marker to be stripped before
 * the line is read as a field.
 *
 * Without flags — the headless and `## Gaps` shapes — that is line 0 alone: a
 * marker on a later line belongs to a nested sub-list (`splitGapsEntries`
 * already folded it in) and is not a field line unless it independently
 * matches `key: value` after a plain trim.
 *
 * With flags — the heading shape — it is whichever lines the SPLITTER accepted
 * as list openers, because there every body line may be a sibling bullet
 * carrying a field (#3457) while line 0 is the heading TEXT and carries no
 * marker at all. Reading the splitter's verdict rather than re-deriving it is
 * what keeps a rejected ordinal (`3. status: resolved` as prose) from being
 * stripped into a field.
 */
function stripsMarkerAt(idx: number, openerFlags?: boolean[]): boolean {
  return openerFlags ? openerFlags[idx] === true : idx === 0;
}

/**
 * The ONE place an entry line is classified as a `key: value` field line.
 * `extractGapEntryFields` reads through it, and `acknowledgeDeferredItem`
 * locates the line it will rewrite through it.
 *
 * Sharing the classifier is what makes the writer structurally unable to
 * select a line the reader will not read back (#3702 round 3, B1; the shape
 * is #3773's, parameterised here by `markers` per the round-3 review's
 * prescribed end state). The writer used to carry its own marker-widened
 * status regex, so a nested `  * status: pending` was selectable by the
 * writer and invisible to this reader: acknowledge rewrote it in place,
 * returned `ok`, and the item stayed outstanding forever. A single classifier
 * has no second copy to drift from.
 *
 * `valueStart` is the offset, in the CR-stripped line, at which the VALUE
 * begins — so a rewrite can replace the value without a second regex of its
 * own. The bolded-key unwrap below is a PREFIX rewrite, so the tail of the
 * rewritten content is byte-identical to the tail of the original and the
 * offset maps back directly.
 *
 * Returns `null` for a non-field line.
 */
function parseGapEntryFieldLine(
  rawLine: string,
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
  stripMarker = true,
): { key: string; value: string; valueStart: number } | null {
  const fieldLineRe = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;
  const boldedKeyRe = /^\*+([A-Za-z_][A-Za-z0-9_-]*):\*+/;

  const line = rawLine.replace(/\r$/, '');
  const bulletStripped = stripMarker ? line.match(markers.strip) : null;
  const bare = bulletStripped ? bulletStripped[2] : line.trim();
  // Where `bare` begins in `line`. The two branches differ: the marker strip's
  // group 2 runs to end-of-line, so it is a plain suffix; `trim()` also cuts
  // the tail, so its offset is the LEADING run alone. Computing one from the
  // other's shape under-counts by the trailing whitespace.
  const headLen = bulletStripped ? line.length - bare.length : line.length - line.trimStart().length;
  const content = bare.replace(boldedKeyRe, (_m, key: string) => `${key.toLowerCase()}:`);

  const m = fieldLineRe.exec(content);
  if (!m) return null;
  let value = m[2].trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return { key: m[1], value, valueStart: headLen + (bare.length - m[2].length) };
}

/**
 * Fallback display text for a Gaps entry with no parseable `truth:` field.
 *
 * `markers` selects which opening marker is stripped (#3702) — hyphen-only by
 * default, the widened set for deferred-items callers, so a `*`-opened entry
 * renders the same name its hyphen twin would. That name is the key
 * `acknowledgeDeferredItem` matches on, so the two MUST use the same set:
 * rendering `* alpha` where the parse surfaced `alpha` would make the entry
 * un-acknowledgeable.
 *
 * `openerFlags` decides WHICH lines are stripped, and on the heading shape
 * line 0 is not one of them (#3702 round 3, m8). There line 0 is the heading
 * TEXT, so an unconditional strip renamed `### 1. Race in the writer` to
 * `Race in the writer` and `### * starred title` to `starred title` — both
 * silent renames of the very key acknowledge matches on, and both a change
 * from this parser's behaviour on `next`.
 */
function rawGapEntryText(
  entryLines: string[],
  markers: BulletMarkers = HYPHEN_BULLET_MARKERS,
  openerFlags?: boolean[],
): string {
  return entryLines
    // Line 0 ONLY, and only if the splitter accepted it as an opener. The
    // opener flags say which lines carry a marker; the entry's NAME is a
    // different question, and stripping a body line's marker out of it changes
    // the key `acknowledgeDeferredItem` matches on.
    .map((l, i) => (i === 0 && stripsMarkerAt(0, openerFlags) ? l.replace(markers.strip, '$2') : l.trim()))
    .join(' ')
    .trim();
}

// ─── parseVerificationItems ───────────────────────────────────────────────────

/**
 * The entry's `status:`, lowercased, or undefined when absent/blank/non-scalar.
 *
 * The entry is a PARSED OBJECT, so this reads a named field rather than
 * matching prose. That distinction is the whole point: against the
 * display-flattened string, a `truth:` whose text mentions "status: resolved"
 * is indistinguishable from an entry that carries the field.
 */
function frontmatterEntryStatus(entry: Record<string, unknown>): string | undefined {
  const status = entry['status'];
  if (typeof status !== 'string' || status.trim() === '') return undefined;
  return status.trim().toLowerCase();
}

/**
 * Is this `gaps:` frontmatter entry already closed? (#3850)
 *
 * `status: resolved`, and nothing else. Byte-identical to the rule
 * `parseGapsItems` applies to a `## Gaps` markdown section, deliberately: the
 * two readers see the SAME authored vocabulary in two places, and a closure
 * rule that differed between them would let one entry read closed in one
 * reader and open in the other. `parseVerificationGapsItems`' docstring claims
 * it mirrors `parseGapsItems`' fail-safe status handling; this is the line
 * that makes that claim true rather than approximately true.
 *
 * So a `gaps:` entry carrying `resolution:` and no `status:` SURFACES, via the
 * same 'unknown'-status fallback `parseGapsItems` already gives it (#3879
 * review round 4, Major).
 */
function isGapsEntryResolved(entry: Record<string, unknown> | undefined): boolean {
  if (!entry) return false;
  return frontmatterEntryStatus(entry) === 'resolved';
}

/**
 * Is this `human_verification:` frontmatter entry already closed? (#3850)
 *
 * Verifier-written entries record closure as a `resolution:` field with no
 * `status:` at all, so `resolution:` closes — but ONLY when no `status:`
 * contradicts it. `status:` is authoritative wherever it is readable.
 *
 * The contradiction guard is the #3879 round-4 Major fix. Without it,
 * `status: failed` + `resolution: "attempted retry, still failing"` — a
 * plausible informational note, not a closure assertion — is silently dropped
 * from the report, which is the exact silently-vanishing-item defect class
 * #3850 exists to close, reached by field COMBINATION instead of file STATUS.
 *
 * This is not a judgment call about YAML: it is the rule this codebase already
 * applies to the same field pair one module over. `validateResolution`
 * (`probe-core.cts`) rejects a populated `resolution:` on a non-resolved status
 * outright — "a populated payload is an authoring mistake (the author meant
 * resolved/dismissed) that would otherwise be silently dropped into the
 * unresolved count with no error pointing at it. Reject it so the mistake
 * surfaces." A reporter cannot throw, so the fail-safe equivalent of surfacing
 * the mistake is to surface the ITEM.
 *
 * #3850's suggested fix (2) states the skip unconditionally — "Skip entries
 * carrying a `resolution:` field" — and its named scenario (one file with 14 of
 * 16 entries resolved) is unaffected by the guard: those entries close either
 * on `resolution:` with no contradicting status, or on `status: resolved`.
 * Both still skip. The guard only changes entries whose own two fields
 * disagree, and for those the fail-safe direction on a false-NEGATIVE bug is to
 * report, not to drop.
 */
function isHumanVerificationEntryResolved(entry: Record<string, unknown> | undefined): boolean {
  if (!entry) return false;
  const status = frontmatterEntryStatus(entry);
  if (status !== undefined) return status === 'resolved';
  const resolution = entry['resolution'];
  return typeof resolution === 'string' && resolution.trim() !== '';
}

/**
 * A named string field of a parsed entry, or undefined when absent/non-scalar.
 *
 * A whitespace-only value counts as absent, but a present value is returned
 * VERBATIM — trimming it here would silently rewrite an author's `truth:` on
 * its way to becoming the item's display name, which is a different string from
 * the one in the file.
 */
function isFrontmatterObjectEntry(entry: unknown): entry is Record<string, unknown> {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry);
}

/**
 * The PARSED object behind each element of a frontmatter array, positionally
 * aligned with that array's DISPLAY renderings — `null` at any index whose
 * entry is not an object (#3850).
 *
 * Both frontmatter readers below need the same two things about one array: the
 * string each entry has always displayed as, and the fields it actually
 * carries. `extractFrontmatter` gives the first, `frontmatterListEntries` the
 * second, and the ONLY safe way to use them together is by index — so the
 * pairing is done once, here, rather than open-coded twice.
 *
 * Alignment is checked, not assumed. Both arrays come from one parse of one
 * region (they share a fence parser), so they agree in practice; if they ever
 * did not, an index would name a DIFFERENT entry's fields and the resolved-skip
 * would close the wrong row. All-`null` is the correct degradation: no entry is
 * skipped as closed, which over-reports rather than mis-attributes.
 *
 * The length check is UNREACHABLE through content today and is kept anyway
 * (#3879 review round 4, Minor 2). It was verified unreachable rather than
 * assumed: both readers enter through `frontmatterRegion`, `extractFrontmatter`'s
 * only extra argument (`sourcePath`) gates a warning and nothing else, and the
 * display step — `normalizeParsedValue`'s `value.map(...)` — is 1:1 and drops no
 * element. So the guard is a drift alarm for a future edit to either parser, not
 * a live branch. That makes it untestable through the two readers, which is why
 * this helper is exported for tests: the degradation is asserted against the
 * function directly rather than left as the one unpinned branch in the family.
 */
function parsedEntriesFor(
  content: string,
  key: string,
  flattened: unknown[],
): Array<Record<string, unknown> | null> {
  const parsed = frontmatterListEntries(content, key);
  if (!parsed || parsed.length !== flattened.length) return flattened.map(() => null);
  return parsed.map((entry) => (isFrontmatterObjectEntry(entry) ? entry : null));
}

function entryField(entry: Record<string, unknown>, key: string): string | undefined {
  const v = entry[key];
  if (typeof v === 'string') return v.trim() === '' ? undefined : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * One parsed `gaps:` entry -> one `UatItem`.
 *
 * ONE call site, `parseVerificationGapsItems` (#3850 review round 3, Minor 1 —
 * an earlier revision's comment claimed both frontmatter readers shared this,
 * and a dead `forcedResult` option existed to serve the second one; neither was
 * ever true, and the claim made a deliberate difference read as an accident).
 *
 * WHY the two frontmatter readers derive fields differently, since they sit
 * side by side and it is a fair question: each mirrors its OWN established
 * sibling rather than each other.
 *
 *   - This one mirrors `parseGapsItems`, the `## Gaps` markdown reader, field
 *     for field: `status:` supplies `result` with the module's documented
 *     fail-safe `'unknown'` when absent (surface a questionable entry rather
 *     than drop a real one), `test` is taken ONLY when the entry declares one,
 *     and `reason` passes through. A `gaps:` entry carries its own status, so
 *     inventing one would be a lie.
 *   - `parseHumanVerificationItems` mirrors #2286's `human_verification:`
 *     behaviour: the array IS the outstanding list, so every surviving entry is
 *     `human_needed` by construction and its `test` is its ROW, because those
 *     entries carry no number of their own.
 *
 * Converging them would mean changing one of those two established contracts
 * for the convenience of symmetry. See `parseVerificationItems` for the one
 * consequence that is genuinely open (a `test` number is unique per array, not
 * per report).
 *
 * The display name falls back to `flattenObjectListItem` — the SAME renderer
 * `extractFrontmatter` applies — so an entry with no `truth:` reads exactly as
 * it always did, byte for byte.
 */
function frontmatterEntryToUatItem(entry: Record<string, unknown>): UatItem {
  const status = entryField(entry, 'status') ?? 'unknown';
  const reason = entryField(entry, 'reason');
  const item: UatItem = {
    name: entryField(entry, 'truth') || flattenObjectListItem(entry),
    result: status,
    category: categorizeItem(status, reason, undefined),
  };
  // No `test:` read (#3879 review round 4, Minor 4). A `gaps:` entry has no
  // `test:` in its vocabulary — the verification template's entries carry
  // `truth` / `status` / `reason` / `artifacts` / `missing` — so reading one was
  // speculative support for a field this shape does not have. It also collided:
  // `parseHumanVerificationItems` numbers its items 1..N by array POSITION,
  // so a `gaps:` entry that did carry `test: 1` produced two items numbered 1
  // in one file's combined list. Not reading it makes the collision impossible
  // rather than unlikely, and does not renumber anything: an offset would have
  // rewritten an authored value, which is the opposite of `entryField`'s
  // verbatim contract.
  if (reason) item.reason = reason;
  return item;
}

/**
 * Surface a `gaps_found` report's frontmatter `gaps:` array (#3850).
 *
 * Mirrors `parseGapsItems`' field vocabulary and fail-safe status handling, but
 * reads the FRONTMATTER array rather than a `## Gaps` markdown section —
 * `parseGapsItems` is reached only from `parseUatItems`, and the verification
 * template puts gaps in frontmatter, so no existing reader covers this shape.
 */
function parseVerificationGapsItems(content: string): UatItem[] {
  const flattened = extractFrontmatter(content)['gaps'];
  if (!Array.isArray(flattened)) return [];
  const parsed = parsedEntriesFor(content, 'gaps', flattened);

  const items: UatItem[] = [];
  flattened.forEach((display, idx) => {
    const entry = parsed[idx];
    // A non-object entry (a bare scalar, a null from a `- ` with nothing after
    // it, a nested sequence) still surfaces, named by the SAME renderer every
    // other frontmatter reader names it by. Dropping it would be this module's
    // wrong direction on a false-NEGATIVE bug: `parseGapsItems`' own
    // 'unknown'-status fallback exists to surface a questionable entry rather
    // than lose a real one, and an entry with no readable status is exactly
    // that. It carries no fields, so it can never be skipped as closed.
    if (!entry) {
      items.push({
        name: normalizeHumanVerificationEntry(display),
        result: 'unknown',
        category: categorizeItem('unknown'),
      });
      return;
    }
    if (isGapsEntryResolved(entry)) return;
    items.push(frontmatterEntryToUatItem(entry));
  });
  return items;
}

/**
 * #3850: `gaps_found` is as outstanding as `human_needed`.
 *
 * `cmdAuditUat` admits BOTH statuses, then this function honoured only one and
 * returned an empty array for the other. Because `cmdAuditUat` pushes a file
 * into `results` only when `items.length > 0`, a `gaps_found` report did not
 * merely under-report — it VANISHED, taking its phase's row out of `by_phase`
 * with it, so a clean-looking total gave the reader no cue that anything was
 * skipped. The trailing `plan-phase --gaps` note that stood in for a
 * `gaps_found` branch pointed at a DIFFERENT command that `audit-uat` never
 * reaches.
 *
 * Eligibility now has ONE owner — the caller — and this function reports what
 * the file says.
 *
 * Resolved entries are skipped on BOTH statuses (#3850 review m8). An earlier
 * revision skipped them only on `gaps_found`, citing an acceptance criterion
 * that the issue does not contain: #3850 has no AC section, and its suggested
 * fix (2) states the skip unconditionally — "Skip entries carrying a
 * `resolution:` field, or the fix trades one wrong number for another — one
 * file here has 14 of 16 entries resolved". That file is `human_needed`, so the
 * asymmetry left the reporter's own named scenario over-reporting by 14. The
 * SKIP applies on both paths.
 *
 * WHAT COUNTS AS RESOLVED is per-key, not universal (#3879 review round 4,
 * Major): `isGapsEntryResolved` takes `parseGapsItems`' `status: resolved` rule
 * verbatim so the two `gaps` readers cannot disagree, and
 * `isHumanVerificationEntryResolved` honours the `resolution:`-only closure the
 * issue names, guarded so a `status:` that contradicts it wins. The issue's
 * "skip entries carrying a `resolution:` field" is quoted above as written; it
 * holds for every entry whose fields agree, which is every entry the reporter's
 * own scenario contains.
 */
function parseVerificationItems(content: string, status: string, sourcePath?: string): UatItem[] {
  const items: UatItem[] = [];
  if (status === 'gaps_found') {
    items.push(...parseHumanVerificationItems(content, sourcePath));
    items.push(...parseVerificationGapsItems(content));
    return items;
  }
  if (status === 'human_needed') {
    return parseHumanVerificationItems(content, sourcePath);
  }
  return items;
}

/**
 * The `human_verification:` reader, extracted from `parseVerificationItems` so
 * `gaps_found` and `human_needed` share ONE implementation rather than a second
 * copy that drifts (ref `DEFECT.GENERATIVE-FIX`). Both statuses now take the
 * identical path, resolved-entry skip included — see the dispatcher above.
 */
function parseHumanVerificationItems(content: string, sourcePath?: string): UatItem[] {
  const items: UatItem[] = [];
  // #2286: the frontmatter's structured `human_verification:` YAML array
  // (extractFrontmatter) is the PRIMARY source of truth when present and
  // non-empty — it fully bypasses the body-shape scan below, so a file
  // whose frontmatter declares the array doesn't require any particular
  // `## Human Verification` body shape at all. An absent or empty array
  // (length 0) falls back to the body scan unchanged.
  const frontmatter = extractFrontmatter(content, sourcePath);
  const humanVerification = frontmatter.human_verification;
  if (Array.isArray(humanVerification) && humanVerification.length > 0) {
    // #3850: ONE source for both the display name and the sibling fields.
    //
    // `extractFrontmatter` renders each object entry for humans
    // (`flattenObjectListItem`), which is right for printing and wrong for
    // branching: `resolution:` is recoverable from that string only by matching
    // prose, and prose cannot tell a real field from the same text quoted
    // inside `truth:`. `frontmatterListEntries` returns the same entries one
    // step earlier, off the same parse.
    //
    // The flattened array stays the #2286 GATE — a non-empty
    // `human_verification:` fully bypasses the body-shape scan below — but the
    // raw entries are the source of the items, so there is no second reader to
    // desynchronise against.
    //
    // WALK THE FLATTENED ARRAY, and use the parsed one only to answer "is this
    // entry closed?" (#3850 review round 3, Blocker).
    //
    // This is base's loop — every element, at its own index, named by the
    // renderer it has always been named by — plus one skip. It is deliberately
    // NOT "iterate the parsed entries": an earlier revision did that against an
    // object-FILTERED array, which compacted it, so a list mixing object and
    // non-object entries lost the non-object rows outright and renumbered the
    // survivors. That is the silently-vanishing row this issue exists to close,
    // reintroduced by entry SHAPE instead of file STATUS. Numbering off the
    // flattened array cannot drift from what the file says, because that array
    // is the one #2286 already gated on.
    //
    // The name therefore stays byte-identical to base for every entry shape,
    // including the ones with no object to read: a YAML null renders `''`, a
    // nested sequence renders `[nested]`. Re-deriving those from the parsed
    // value would have printed `["nested"]` — a rendering nobody asked this
    // change to alter.
    //
    // `parsedEntriesFor` owns the pairing and its alignment check.
    const parsed = parsedEntriesFor(content, 'human_verification', humanVerification);
    humanVerification.forEach((flattened, idx) => {
      const object = parsed[idx];
      if (object && isHumanVerificationEntryResolved(object)) return;
      items.push({
        // The entry's ORIGINAL 1-based position, so a surfaced item still
        // names its row in the file when a closed sibling was skipped.
        test: idx + 1,
        name: normalizeHumanVerificationEntry(flattened),
        result: 'human_needed',
        category: 'human_uat',
      });
    });
    return items;
  }

  // Use the seam to locate the ## Human Verification section (ADR-1372 T5).
  const hvSection = collectSection(
    content,
    (h) => /^human\s+verification/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (hvSection) {
    // #2245 review Fix 3: reverted to the pre-Phase-4 (HEAD 2cbf18642)
    // implementation. The live Human Verification section is NOT a strict
    // GFM table — the planner/verifier templates mix table rows, numbered
    // items, and bullet items in the same section (and a `### N.` heading
    // format is common too), so a table-XOR-list read (parse a table, and
    // if it parses, suppress numbered/bullet items entirely) silently
    // dropped items on any mixed or malformed section: a malformed
    // `| N | … |` table with no valid header/delimiter yielded ZERO items
    // instead of reading the rows positionally. This per-line scan reads
    // table rows AND numbered items AND bullet items as a UNION (whichever
    // pattern a given line matches), exactly like OLD, and reads
    // `| N | desc |` rows even without a valid table header/delimiter.
    //
    // #2245 audit: the table-row branch's CELL SPLIT is name/position-
    // addressed via `splitTableRow` (escape-aware, canonical) instead of a
    // hand-rolled pipe regex — candidacy itself is decided WITHOUT a table
    // regex (a leading `|` plus a purely-numeric first cell), so this no
    // longer needs an allow-adhoc-markdown suppression at all.
    const lines = hvSection.body.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      // Match table rows: | N | description | ... — candidacy requires a
      // leading pipe and a purely-numeric first cell (mirrors what the old
      // regex effectively required: a "|digit|" cell immediately followed
      // by more content), with at least 2 physical cells so a bare "| N |"
      // with nothing after it is NOT treated as a row.
      //
      // #2245 review Fix 9: this is NOT the same as OLD for a row whose
      // ONLY content past the digit cell is trailing whitespace (e.g.
      // "| N | ", no second delimiting `|`). OLD's `([^|]+)` regex ran
      // against the RAW (untrimmed) line and its `\s*` would backtrack to
      // let `[^|]+` swallow that trailing whitespace, so OLD matched and
      // pushed an item with an EMPTY (`.trim()`-collapsed) name. Here,
      // `trimmedLine = line.trim()` strips that trailing whitespace BEFORE
      // `splitTableRow` ever sees it, collapsing the line to a single cell
      // (`candidateCells.length === 1`), which fails the `>= 2` check —
      // the item is silently dropped instead. A real, acceptable behaviour
      // change (an empty-named UAT item is not useful either way), but the
      // two implementations are NOT equivalent on this input.
      let tableCells: string[] | null = null;
      if (trimmedLine.startsWith('|')) {
        const candidateCells = splitTableRow(trimmedLine);
        if (candidateCells.length >= 2 && /^\d+$/.test(candidateCells[0])) {
          tableCells = candidateCells;
        }
      }
      // Match bullet items: - description
      const bulletMatch = line.match(/^[-*]\s+(.+)/);
      // Match numbered items: 1. description
      const numberedMatch = line.match(/^(\d+)\.\s+(.+)/);

      if (tableCells) {
        // Skip rows that already have a passing result (PASS, pass, resolved, etc.)
        // — checked over every cell AFTER the description column, mirroring
        // OLD's rowRemainder scan (which only ever saw cells past the
        // description, the description itself having already been consumed).
        const hasPassResult = tableCells.slice(2).some(c => /^pass$/i.test(c) || /^resolved$/i.test(c));
        if (hasPassResult) continue;
        items.push({
          test: parseInt(tableCells[0], 10),
          name: tableCells[1] ?? '',
          result: 'human_needed',
          category: 'human_uat',
        });
      } else if (numberedMatch) {
        items.push({
          test: parseInt(numberedMatch[1], 10),
          name: numberedMatch[2].trim(),
          result: 'human_needed',
          category: 'human_uat',
        });
      } else if (bulletMatch && bulletMatch[1].length > 10) {
        items.push({
          name: bulletMatch[1].trim(),
          result: 'human_needed',
          category: 'human_uat',
        });
      }
    }

    // #2286: fall back to the `### N. <label>` heading + bold-led paragraph
    // shape (the canonical form emitted by `templates/verification-report.md`
    // — `### 1. {Test Name}` followed by `**Test:** ... **Expected:** ...
    // **Why human:** ...`), which the table/bullet/numbered per-line scan
    // above never recognises (a `###`-prefixed line matches none of those
    // three patterns). Uses the same `tokenizeHeadings` seam
    // `parseFirstPendingTest` already uses for `### N.` sub-headings,
    // applied here to the Human Verification section body. Runs in
    // addition to (a union with) the scan above — the two shapes don't
    // collide, so this only adds items a `###` heading page would have
    // silently produced zero for.
    const hvSubHeadings = tokenizeHeadings(hvSection.body).filter(
      (h) => h.level === 3 && /^\d+\.\s+/.test(h.text),
    );
    for (let i = 0; i < hvSubHeadings.length; i += 1) {
      const current = hvSubHeadings[i];
      const next = hvSubHeadings[i + 1];
      const block = next
        ? hvSection.body.slice(current.offset, next.offset)
        : hvSection.body.slice(current.offset);
      const bodyAfterHeading = block.slice(block.indexOf('\n') + 1);
      // Require a bold-led paragraph body (`**Test:** ...`) to distinguish
      // a genuine verification item from an unrelated numbered heading.
      if (!/^\s*\*\*/.test(bodyAfterHeading)) continue;

      const headingParts = current.text.match(/^(\d+)\.\s+(.+)$/);
      if (!headingParts) continue;
      items.push({
        test: parseInt(headingParts[1], 10),
        name: headingParts[2].trim(),
        result: 'human_needed',
        category: 'human_uat',
      });
    }
  }
  return items;
}

/**
 * Normalize a single `human_verification:` frontmatter array entry (#2286)
 * into a display-ready name.
 *
 * #2286 review (LOW finding): `extractFrontmatter`'s generic array-item
 * parser (`src/frontmatter.cts`, the `line.trim().startsWith('- ')` branch)
 * has NO notion of nested key/value objects — regardless of whether the
 * source YAML was authored as `- test: "..."` (an implied-but-unsupported
 * shorthand) or `- "plain string"`, it ALWAYS pushes the raw post-`- ` text
 * (with only a single layer of wrapping quotes stripped) as a plain string.
 * There is therefore no reliable signal here to distinguish a genuine
 * `key: value`-shaped pseudo-field from a legitimate plain string that
 * itself happens to start with a word and a colon (e.g. `"Confirm: the
 * button responds"`). A prior version of this function stripped a leading
 * `word:` prefix on the assumption it was always a flattened nested-object
 * key — that assumption is false, and it silently truncated real plain-string
 * content. No such stripping is applied: any residual wrapping-quote noise
 * left by `extractFrontmatter`'s own (anchor-only) quote handling is cleaned
 * up, and everything else is preserved verbatim.
 */
function normalizeHumanVerificationEntry(raw: unknown): string {
  if (typeof raw !== 'string') {
    return raw === null || raw === undefined ? '' : JSON.stringify(raw);
  }
  const s = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  return s || raw.trim();
}

// ─── categorizeItem ───────────────────────────────────────────────────────────

function categorizeItem(rawResult: string, reason?: string, blockedBy?: string): UatCategory {
  // Normalize once so this comparison agrees with the PASS-token check
  // (`UAT_PASS_RESULTS.has(result)`, over an already-lower-cased token):
  // `result: PENDING` and
  // `result: Blocked` must categorize the same as their lowercase forms,
  // not fall through to 'unknown'.
  const result = rawResult.toLowerCase();
  if (result === 'blocked' || blockedBy) {
    if (blockedBy) {
      if (/server/i.test(blockedBy)) return 'server_blocked';
      if (/device|physical/i.test(blockedBy)) return 'device_needed';
      if (/build|release|preview/i.test(blockedBy)) return 'build_needed';
      if (/third.party|twilio|stripe/i.test(blockedBy)) return 'third_party';
    }
    return 'blocked';
  }
  if (result === 'skipped') {
    if (reason) {
      if (/server|not running|not available/i.test(reason)) return 'server_blocked';
      if (/simulator|physical|device/i.test(reason)) return 'device_needed';
      if (/build|release|preview/i.test(reason)) return 'build_needed';
    }
    return 'skipped_unresolved';
  }
  if (result === 'pending') return 'pending';
  if (result === 'human_needed') return 'human_uat';
  // #3707: the template-sanctioned `result: issue` token (templates/UAT.md)
  // has no UatCategory branch here, so a surfaced issue row previously fell
  // through to 'unknown' — placed AFTER the blocked/skipped/pending checks
  // above so it never shadows their more specific categorization.
  if (result === 'issue') return 'issue';
  return 'unknown';
}

export = {
  cmdAuditUat,
  cmdRenderCheckpoint,
  parseCurrentTest,
  parseUatItems,
  parseUatItemsWithStats,
  selectPhaseUatFiles,
  buildCheckpoint,
  CHECKPOINT_FRAMES,
  CHECKPOINT_LANGUAGE_ALIASES,
  resolveCheckpointFrame,
  parseDeferredItems,
  parseDeferredItemsWithStatus,
  acknowledgeDeferredItem,
  // #3702 round 2 (M3): exposed for the marker-grammar parity test only.
  // Narrowed in round 3 (M6): the two status-line regexes are gone from the
  // module, so nothing exports them, and the parity test they were widened for
  // could not reach the defect it was meant to guard anyway — it asserted the
  // four WRITER regexes shared a source string, which is true of a detect/read
  // asymmetry too. The pair below is what the behavioural parity test against
  // `iterateBullets` actually reads.
  DEFERRED_MARKER_ALT,
  DEFERRED_BULLET_MARKERS,
  // #3850: exported so the `gaps_found` partition invariant is asserted
  // against the parser itself rather than only through a CLI round-trip
  // (RULESET.TESTS.property-based-testing).
  parseVerificationItems,
  // #3879 review round 4, Minor 2: exported for tests so the degrade-to-all-null
  // branch is asserted directly. It cannot be reached through the two readers —
  // see the alignment note on the function.
  parsedEntriesFor,
};
