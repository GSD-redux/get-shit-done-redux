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
const { extractFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE, scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocator = require('./phase-locator.cjs');
const { getArchivedPhaseDirs, listMilestonePhaseDirs } = phaseLocator;
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
  // Reuses the canonical `getArchivedPhaseDirs` seam (phase-locator.cts), which
  // `findPhaseInternal` already uses for this same fallback, so the archive
  // layout convention stays owned by one module.
  const archivedDirs = getArchivedPhaseDirs(cwd);
  if (!hasActivePhases && archivedDirs.length === 0) {
    error('No phases directory found in planning directory');
  }

  const results: UatFileResult[] = [];

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
      const status = (extractFrontmatter(content, uatFilePath).status as string || 'unknown');
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
      const status = extractFrontmatter(content, verificationFilePath).status as string || 'unknown';
      if (status === 'human_needed' || status === 'gaps_found') {
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

  output({ results, summary }, raw, undefined);
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
 * `normalizeLineEndings` itself now lives in `core-utils.cts` (#3707-CR
 * follow-up MAJOR) and is imported above alongside `toPosixPath`, so it can
 * also be applied at the READ boundary in `cmdAuditUat` (see
 * `readNormalizedDocument`) — not just inside this module's own parsers. See
 * that shared copy's doc comment for the full CommonMark lone-CR rationale.
 *
 * It is still called directly inside `parseUatItemsWithStats` and
 * `parseCurrentTest` below: `parseUatItemsWithStats` is also reached from
 * `src/planning-inspect.cts`'s `buildUatRows` via its own `readDocument` seam
 * (a DIFFERENT read boundary this module does not own), and
 * `parseCurrentTest` is reached from `cmdRenderCheckpoint`'s own independent
 * `readFileSync` (a third read site, never touched by `cmdAuditUat`'s
 * boundary). Both calls stay so neither ingress can regress if its own
 * boundary is ever skipped.
 */

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
    const resultLineMatch = fenceStrippedBlock.match(/^result:\s*\[?(\w+)\]?.*$/im);
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
 * LEAF headings (see `splitDeferredHeadingEntries`) rather than by bullets —
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
  const headingEntries = splitDeferredHeadingEntries(sectionBody);
  const entries = headingEntries !== null
    ? headingEntries.map((entryLines) => ({
      lines: entryLines,
      fields: extractGapEntryFields(entryLines.map(stripLeadingBulletMarker)),
    }))
    : splitGapsEntries(sectionBody).map((entryLines) => ({
      lines: entryLines,
      fields: extractGapEntryFields(entryLines),
    }));

  for (const { lines: entryLines, fields } of entries) {
    const text = rawGapEntryText(entryLines);
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
 * Deliberately refuses (`unsupported_heading_shape`) rather than guess when
 * the section uses the heading-delimited (#3457) entry shape: reliably
 * mapping a `splitDeferredHeadingEntries` entry back to its EXACT source line
 * span is not safely derivable without re-deriving that function's
 * leaf/container walk against a document that may also mix in headless
 * (`splitGapsEntries`-derived) entries between headings — attempting it risks
 * writing into the WRONG entry. The bullet-only (headless) shape below is the
 * primary, documented SCOPE BOUNDARY convention and is handled precisely.
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

  if (splitDeferredHeadingEntries(sectionBody) !== null) {
    return { content, status: 'unsupported_heading_shape' };
  }

  const entries = splitGapsEntriesWithSpans(sectionBody);
  const matches = entries
    .map((entry) => ({ entry, text: rawGapEntryText(entry.lines) }))
    .filter((e) => e.text === targetText);

  if (matches.length === 0) return { content, status: 'not_found' };
  if (matches.length > 1) return { content, status: 'ambiguous' };

  const { entry } = matches[0];
  const { lines: entryLines, start, end } = entry;
  const fields = extractGapEntryFields(entryLines);
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
  if (rawGapEntryText(strippedForVerify) !== targetText) {
    return { content, status: 'match_verification_failed' };
  }

  const matchIndexInContent = sectionOffset + start;
  const statusFieldRe = /^\s*(?:-\s+)?(\*+status:\*+|status:)/i;
  const statusLineIdx = matchedLines.findIndex((rawLine) => statusFieldRe.test(rawLine.replace(/\r$/, '')));

  // No CRLF-preservation branch here (WARNING 1, #3458 follow-up review):
  // every write goes through `platformWriteSync` → `normalizeContent`, which
  // for a `.md` path unconditionally runs `_normalizeMd` — whole-file
  // `\r\n` → `\n`, plus blank-line normalization around headings/lists — on
  // EVERY write, not just this one. That is this codebase's single,
  // deliberate OS-facing I/O seam (`shell-command-projection.cts`), applied
  // uniformly to every `.md` writer; carving out one exception here would
  // fight it rather than follow it, for a guarantee (byte-identical CRLF on
  // disk) the seam already makes impossible. A marker write on a CRLF
  // `deferred-items.md` normalizes the WHOLE file to LF, same as any other
  // `.md` write in this codebase — expected, not a regression to guard
  // against. Where a source line still carries a trailing `\r` (read from an
  // on-disk CRLF document before normalization), `String.prototype.replace`
  // consumes it as part of `.*$` and the replacement text does not
  // reproduce it, so it is dropped here too — consistent with the eventual
  // whole-file normalization rather than duplicating it.
  let newMatchedLines: string[];
  if (statusLineIdx === -1) {
    const bulletIndentMatch = matchedLines[0].match(/^(\s*)-\s+/);
    const continuationIndent = ' '.repeat((bulletIndentMatch ? bulletIndentMatch[1].length : 0) + 2);
    newMatchedLines = [
      matchedLines[0],
      `${continuationIndent}status: acknowledged`,
      ...matchedLines.slice(1),
    ];
  } else {
    const original = matchedLines[statusLineIdx];
    const replaced = original.replace(
      /^(\s*(?:-\s+)?)(\*+status:\*+|status:)(\s*).*$/i,
      (_m, indent: string, key: string, ws: string) => `${indent}${key}${ws}acknowledged`,
    );
    newMatchedLines = matchedLines.slice();
    newMatchedLines[statusLineIdx] = replaced;
  }

  const newContent = content.slice(0, matchIndexInContent) + newMatchedLines.join('\n') + content.slice(matchIndexInContent + (end - start));
  return { content: newContent, status: 'ok' };
}

/**
 * Strip one leading `- ` bullet marker (#3457). Heading-delimited deferred
 * entries carry their fields as sibling bullets; `extractGapEntryFields` only
 * de-bullets line 0 (Gaps-protective — there, a later `- ` line is a nested
 * sub-list), so the deferred heading path de-bullets every line itself before
 * field extraction. Non-bullet lines pass through untouched.
 */
function stripLeadingBulletMarker(line: string): string {
  return line.replace(/^(\s*)-\s+/, '');
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
 * kept only when its body (minus table lines) contains at least one `- `
 * bullet:
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
function splitDeferredHeadingEntries(sectionBody: string): string[][] | null {
  const headings = tokenizeHeadings(sectionBody);
  if (headings.length === 0) return null;

  const lines = sectionBody.split('\n');
  const headingByLine = new Map<number, { text: string; isContainer: boolean }>();
  for (let i = 0; i < headings.length; i++) {
    // Container iff the next heading is deeper (see doc comment). An empty
    // heading text (`##` alone) does not itself mean container — the flag is
    // carried explicitly so a bare LEAF heading still opens an entry.
    const isContainer = i + 1 < headings.length && headings[i + 1].level > headings[i].level;
    headingByLine.set(headings[i].line, { text: headings[i].text, isContainer });
  }

  const entries: string[][] = [];
  let current: string[] | null = null; // accumulating a leaf heading's entry
  let pending: string[] = []; // preamble / container-heading body lines
  let currentHasBullet = false;

  const flushCurrent = (): void => {
    // Keep the leaf entry only when its body carries a bullet; the heading
    // text line itself (element 0) never counts as one.
    if (current !== null && currentHasBullet) entries.push(current);
    current = null;
    currentHasBullet = false;
  };
  const flushPending = (): void => {
    entries.push(...splitGapsEntries(pending.join('\n')));
    pending = [];
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
      if (!heading.isContainer) {
        // Leaf heading: open an entry with the heading text as line 0.
        current = [heading.text];
        currentHasBullet = false;
      }
      continue;
    }
    // Table lines belong to parseDeferredTableItems, never to a heading entry.
    if (/^\s*\|/.test(lines[i].replace(/\r$/, ''))) continue;
    if (current !== null) {
      current.push(lines[i]);
      if (/^\s*-\s/.test(lines[i].replace(/\r$/, ''))) currentHasBullet = true;
    } else {
      pending.push(lines[i]);
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
 */
function splitGapsEntriesCore(sectionBody: string): GapsEntrySpan[] {
  const rawLines = sectionBody.split('\n');
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  let cursor = 0;
  for (const rawLine of rawLines) {
    lineStarts.push(cursor);
    cursor += rawLine.length;
    lineEnds.push(cursor);
    cursor += 1; // the '\n' separator — absent after the final line, but nothing reads past it
  }

  const entries: GapsEntrySpan[] = [];
  let current: string[] | null = null;
  let currentStartLine = -1;
  let currentEndLine = -1;
  let baseIndent: number | null = null;

  const flush = (): void => {
    if (current !== null) {
      entries.push({ lines: current, start: lineStarts[currentStartLine], end: lineEnds[currentEndLine] });
    }
  };

  rawLines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\r$/, '');
    const bulletMatch = line.match(/^(\s*)-\s/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      if (baseIndent === null) baseIndent = indent;
      if (indent <= baseIndent) {
        flush();
        current = [line];
        currentStartLine = idx;
        currentEndLine = idx;
        return;
      }
    }
    if (current !== null) {
      current.push(line);
      currentEndLine = idx;
    }
    // else: pre-first-bullet content (e.g. the template's HTML comment) — discarded.
  });
  flush();

  return entries;
}

/**
 * Split a `## Gaps` section body into per-entry line groups on TOP-LEVEL
 * `- ` bullet openers.
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
 * (heading present, no bullets) returns `[]`.
 */
function splitGapsEntries(sectionBody: string): string[][] {
  return splitGapsEntriesCore(sectionBody).map((entry) => entry.lines);
}

/**
 * Sibling of `splitGapsEntries` (F1, #3458 follow-up review) that ADDITIVELY
 * carries each entry's character span — every existing `splitGapsEntries`
 * caller (`parseGapsItems`, `parseDeferredItemsWithStatus`,
 * `splitDeferredHeadingEntries`'s `flushPending`) is unaffected and keeps
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
function splitGapsEntriesWithSpans(sectionBody: string): GapsEntrySpan[] {
  return splitGapsEntriesCore(sectionBody);
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
function extractGapEntryFields(entryLines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  const fieldLineRe = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;
  const boldedKeyRe = /^\*+([A-Za-z_][A-Za-z0-9_-]*):\*+/;

  entryLines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\r$/, '');
    // Strip ONLY the entry-opening bullet marker (idx 0); a bullet marker on
    // a later line belongs to a nested sub-list and is handled by
    // `splitGapsEntries` already folding it in — it is not itself a field
    // line unless it independently matches `key: value` after stripping.
    const bulletStripped = line.match(/^(\s*)-\s+(.*)$/);
    const content = (idx === 0 && bulletStripped ? bulletStripped[2] : line.trim())
      .replace(boldedKeyRe, (_m, key: string) => `${key.toLowerCase()}:`);

    const m = fieldLineRe.exec(content);
    if (!m) return;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (!(key in fields)) fields[key] = value;
  });

  return fields;
}

/** Fallback display text for a Gaps entry with no parseable `truth:` field. */
function rawGapEntryText(entryLines: string[]): string {
  return entryLines
    .map((l, i) => (i === 0 ? l.replace(/^(\s*)-\s+/, '') : l.trim()))
    .join(' ')
    .trim();
}

// ─── parseVerificationItems ───────────────────────────────────────────────────

function parseVerificationItems(content: string, status: string, sourcePath?: string): UatItem[] {
  const items: UatItem[] = [];
  if (status === 'human_needed') {
    // #2286: the frontmatter's structured `human_verification:` YAML array
    // (extractFrontmatter) is the PRIMARY source of truth when present and
    // non-empty — it fully bypasses the body-shape scan below, so a file
    // whose frontmatter declares the array doesn't require any particular
    // `## Human Verification` body shape at all. An absent or empty array
    // (length 0) falls back to the body scan unchanged.
    const frontmatter = extractFrontmatter(content, sourcePath);
    const humanVerification = frontmatter.human_verification;
    if (Array.isArray(humanVerification) && humanVerification.length > 0) {
      humanVerification.forEach((entry, idx) => {
        items.push({
          test: idx + 1,
          name: normalizeHumanVerificationEntry(entry),
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
  }
  // gaps_found items are already handled by plan-phase --gaps pipeline
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
};
