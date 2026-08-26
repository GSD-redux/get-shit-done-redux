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
const { collectSection, tokenizeHeadings, stripFencedCode } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownTable = require('./markdown-table.cjs');
const { splitTableRow, isDelimiterRow } = markdownTable;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath } = coreUtils;
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
      const content = fs.readFileSync(uatFilePath, 'utf-8');
      const { items, headingsSeen } = parseUatItemsWithStats(content);
      const status = (extractFrontmatter(content, uatFilePath).status as string || 'unknown');
      // `parse_gap` means the file contained `### N.` test blocks that
      // yielded no items — NOT merely "zero items and not complete" (#3707
      // MAJOR: that broader signal false-positived on an all-pass file and on
      // a Gaps-only file with everything resolved). A file whose blocks all
      // passed, or that has no test blocks at all, never sets `headingsSeen`,
      // so it never sets the flag regardless of status. The `status !==
      // 'complete'` guard is kept alongside `headingsSeen` (rather than
      // replacing it) so a file explicitly marked terminal stays unflagged
      // even if a stray unparseable block remains in it.
      //
      // This check is deliberately UNCONDITIONAL on `items.length` (#3707
      // follow-up BLOCKER): a MIXED file — some parseable rows plus some
      // unparseable blocks — must report BOTH the real items AND the parse
      // gap, quantified via `unparsed_blocks`. The previous `else if` only
      // ever flagged a file with ZERO items, silently discarding
      // `headingsSeen` (and every unparseable row it counted) the instant any
      // single item existed anywhere in the file, including via the Gaps
      // union.
      if (items.length > 0 || (headingsSeen > 0 && status !== 'complete')) {
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
        if (headingsSeen > 0 && status !== 'complete') {
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
      const content = fs.readFileSync(verificationFilePath, 'utf-8');
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
      const content = fs.readFileSync(path.join(phaseDir, deferredFile), 'utf-8');
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

  // #3078 blocker (same exposure as `parseUatItemsWithStats`): tokenize a
  // SCALAR-MASKED copy, never the raw section body, so a `### N.` line
  // indented <= 3 spaces INSIDE an `expected: |` value cannot register as a
  // phantom heading and steal the real row's `result:` token. The masked
  // copy is byte-length-identical, so offsets still index `sectionBody`.
  const maskedSectionBody = maskBlockScalarBodies(sectionBody);

  // Within the Tests section body, find ### N. Name sub-headings.
  // tokenizeHeadings operates on the section body as a standalone document,
  // filtering to level-3 headings matching the UAT-specific "N. Name" pattern.
  // The UAT-specific item parsing (number extraction, result parsing) stays caller-side.
  const subHeadings = tokenizeHeadings(maskedSectionBody).filter(
    (h) => h.level === 3 && /^\d+\.\s+/.test(h.text),
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

    // Extract the UAT-specific number and name from the heading text
    const headingParts = current.text.match(/^(\d+)\.\s+(.+)$/);
    if (!headingParts) continue;
    const testNumber = parseInt(headingParts[1], 10);
    const testName = headingParts[2].trim();

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
 * with `BLOCK_SCALAR_OPENER_RE` (which already masks their bodies) —
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
 */
const EXPECTED_SCALAR_OPENER = String.raw`^expected:[ \t]*([|>])(?:[1-9][+-]?|[+-][1-9]?)?[ \t]*\r?\n`;

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

function parseExpectedFromTestBlock(block: string): string | null {
  const expectedBlockMatch = block.match(new RegExp(`${EXPECTED_SCALAR_OPENER}([\\s\\S]*?)(?=^\\w[\\w-]*:\\s)`, 'm'))
    || block.match(new RegExp(`${EXPECTED_SCALAR_OPENER}([\\s\\S]+)`, 'm'));
  if (expectedBlockMatch) {
    const opener = expectedBlockMatch[1];
    const dedented = expectedBlockMatch[2]
      .split('\n')
      .map((line: string) => line.replace(/\r$/, '').replace(/^ {2}/, ''))
      .join('\n')
      .trim();
    return opener === '>' ? foldScalarBody(dedented) : dedented;
  }

  const expectedInlineMatch = block.match(/^expected:\s*(.+)\s*$/m);
  return expectedInlineMatch ? expectedInlineMatch[1].trim() : null;
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
 * Visual column width of a line's leading whitespace (tab = 4), used to compare
 * indentation between a block-scalar key line and its candidate body lines.
 */
function indentWidthOf(prefix: string): number {
  let width = 0;
  for (const ch of prefix) width += ch === '\t' ? 4 : 1;
  return width;
}

/**
 * A `<key>: |` (or `|-`, `|+`, `>`, `>-`, `>+`, and the explicit-indentation-
 * indicator forms `|2`, `|2-`, `|-2`, `>2`, `>2+`, ...) block-scalar OPENER
 * line — the only shape whose following, more-indented lines are opaque VALUE
 * text rather than document structure. Per the YAML block-scalar header
 * grammar, the indentation indicator (`1`-`9`, never `0`) and the chomping
 * indicator (`+`/`-`) are each optional and may appear in EITHER order
 * (`|2-` and `|-2` are both valid). The optional `- ` allows the bullet-borne
 * form (`- expected: |`); the key column is measured AFTER the bullet marker
 * so the body test stays strict (a line must out-indent the KEY, not the
 * dash).
 */
const BLOCK_SCALAR_OPENER_RE = /^([ \t]*(?:-[ \t]+)?)[A-Za-z_][\w-]*[ \t]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*\r?$/;

/** A fenced-code OPENER line (``` or ~~~, up to 3 leading spaces). */
const FENCE_OPENER_RE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * A raw source line whose shape is a UAT `### N.` test heading — the line-level
 * twin of the `h.level === 3 && /^\d+\.(?!\d)/` token filter in
 * `parseUatItemsWithStats`. Used ONLY to count headings that `tokenizeHeadings`
 * suppressed (see `maskBlockScalarBodies`'s callers), never to parse one.
 */
const TEST_HEADING_LINE_RE = /^ {0,3}#{3}(?!#)[ \t]+\d+\.(?!\d)/;

/**
 * Return `content` with the BODY of every block scalar overwritten by spaces,
 * character-for-character, so the result has byte-identical length and every
 * offset into it also indexes the original document.
 *
 * Why (#3078 blocker): `tokenizeHeadings` is a pure markdown scanner — it has
 * no notion of YAML block scalars, so a line like `  ### 3. Fake Row` sitting
 * INSIDE an `expected: |` value is a perfectly valid ATX heading to it
 * (markdown tolerates up to 3 leading spaces). That phantom heading then opens
 * a block that STEALS the real row's `result:` line, and the real row vanishes
 * from `items` entirely — a silently-dropped outstanding row, which is exactly
 * the false-clean this parser exists to prevent. Masking the scalar body before
 * tokenizing makes value text structurally inert. Length preservation (spaces,
 * not deletion) is load-bearing: the heading offsets returned from the masked
 * copy are used to slice block text out of the RAW document, which
 * `parseExpectedFromTestBlock` must still see verbatim.
 *
 * Body extent follows the YAML rule: the run of lines more indented than the
 * key line, ending at the first non-blank line whose indent is <= the key's.
 * Blank lines never terminate a scalar (they belong to it), but trailing blanks
 * are not counted as part of it either.
 */
function maskBlockScalarBodies(content: string): string {
  // #3078 follow-up BLOCKER: this used to compute `lineStart[]` offsets and
  // `lines[k].length` (both UTF-16 units) and splice them into `Array.from(content)`
  // (a CODE POINT array). Every astral character (surrogate pair) earlier in the
  // document shifted every later mask write one slot too far right, blanking the
  // wrong characters and spilling a body's mask past its own newline into the
  // next line. Rebuilding BY LINE is frame-agnostic: `lines[i].length` and
  // `' '.repeat(lines[i].length)` are both measured in the SAME (UTF-16) units as
  // the string itself, and `.join('\n')` reproduces the exact original length and
  // line count regardless of code-point/code-unit framing. This also handles CRLF
  // correctly without special-casing it: `content.split('\n')` leaves any `\r`
  // attached to the end of its line (never stripped here), so a masked CRLF line's
  // trailing `\r` is replaced by a space exactly as it always was pre-fix, and an
  // unmasked line's `\r` round-trips untouched through the rejoin.
  const lines = content.split('\n');
  const shouldMask = new Array<boolean>(lines.length).fill(false);
  let masked = false;

  for (let i = 0; i < lines.length; i += 1) {
    const opener = BLOCK_SCALAR_OPENER_RE.exec(lines[i]);
    if (!opener) continue;
    const keyIndent = indentWidthOf(opener[1]);

    let lastBodyLine = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue; // blank lines never close a scalar
      if (indentWidthOf(/^[ \t]*/.exec(line)![0]) <= keyIndent) break;
      lastBodyLine = j;
    }

    for (let k = i + 1; k <= lastBodyLine; k += 1) {
      shouldMask[k] = true;
      if (lines[k].length > 0) masked = true;
    }
    i = lastBodyLine;
  }

  if (!masked) return content;
  return lines.map((line, i) => (shouldMask[i] ? ' '.repeat(line.length) : line)).join('\n');
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
 * The opener search runs over the SCALAR-MASKED copy, not the raw text, so a
 * fenced sample nested inside a legitimate `expected: |` value is invisible
 * here and does not clip the very field this exists to preserve. Masking is
 * length-preserving, so line indices agree between the two copies.
 */
function clipBlockAtFirstFence(block: string): string {
  const maskedLines = maskBlockScalarBodies(block).split('\n');
  const rawLines = block.split('\n');

  let firstFenceLine = -1;
  for (let i = 0; i < maskedLines.length; i += 1) {
    if (FENCE_OPENER_RE.test(maskedLines[i])) {
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
  // Reconstruct the block with every top-level FENCED REGION dropped (fence
  // boundaries tracked on the MASKED copy — the same anti-theft rule as above,
  // so a fenced-looking line living inside a legitimate `expected: |` value can
  // never be mistaken for a real fence), keeping RAW text everywhere else. This
  // exposes a late `expected:` living after a fence closes, while an
  // `expected:` living strictly inside the fence is dropped along with it and
  // stays unreachable — the "inside a fence" vs. "after a closed fence" split
  // falls straight out of whether the fence-tracking state machine below is
  // OPEN or CLOSED at that line, not out of position relative to the FIRST
  // fence opener alone.
  const visible = dropTopLevelFencedRegions(rawLines, maskedLines);
  if (parseExpectedFromTestBlock(visible)) return visible;

  return beforeFence;
}

/**
 * Reconstruct `rawLines` with every TOP-LEVEL fenced region removed, tracking
 * fence open/close state on the parallel `maskedLines` (so a fence-shaped line
 * living inside a masked block-scalar body can never be mistaken for a real
 * fence). Mirrors `stripFencedCode`'s own delimiter algorithm exactly — a
 * fence run of the SAME character and at least the SAME length, with no
 * trailing content, is what closes an open fence — so "inside a fence" here
 * means the same thing it means to the rest of this module's fence handling.
 * An UNTERMINATED fence (open at EOF) drops everything from its opener to the
 * end, same as `stripFencedCode`.
 */
function dropTopLevelFencedRegions(rawLines: string[], maskedLines: string[]): string {
  const kept: string[] = [];
  let openFence: { char: string; len: number } | null = null;
  const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;

  for (let i = 0; i < maskedLines.length; i += 1) {
    const line = maskedLines[i].replace(/\r$/, '');
    const m = delimRe.exec(line);
    if (m) {
      const char = m[2][0];
      const len = m[2].length;
      const trailing = m[3];
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

function parseUatItemsWithStats(content: string): { items: UatItem[]; headingsSeen: number } {
  const items: UatItem[] = [];
  let headingsSeen = 0;

  // Locate every `### N. Name` test heading across the WHOLE document (not
  // adjacency-matched against `result:`, #3707 defect 2) and slice each one's
  // own block from its heading to the next heading OF ANY LEVEL (or EOF) —
  // a trailing `## Gaps` section or an interleaved `### Notes` heading must
  // not be absorbed into the preceding test's block, else its unanchored
  // `reason:`/`blocked_by:` scans below bleed a Gaps entry's fields onto the
  // last test row.
  // #3078 blocker: tokenize a SCALAR-MASKED copy, never the raw document —
  // see `maskBlockScalarBodies`. The copy is byte-length-identical, so every
  // offset it yields still indexes `content`, and block slicing below stays on
  // the RAW text that `parseExpectedFromTestBlock` needs.
  const maskedContent = maskBlockScalarBodies(content);
  const allHeadings = tokenizeHeadings(maskedContent);
  // #3707 follow-up MINOR: `^\d+\.` alone — a trailing name is OPTIONAL
  // (`### 3.` and `### 3.Foo`, without the space the old `\s+`-anchored
  // pattern required, both count) so a heading missing or squishing its name
  // still contributes to `headingsSeen`/items rather than being silently
  // excluded from BOTH — the same vanishing-row symptom the parse-gap flag
  // exists to catch, reachable here at the heading-filter layer instead.
  // Carry each match's own index into `allHeadings` from the filter pass
  // itself (security review finding 3) rather than re-deriving it via
  // `allHeadings.indexOf(current)` inside the loop below — the latter is an
  // O(n) scan per heading, making the whole loop O(n^2) in document size.
  const subHeadings: { heading: (typeof allHeadings)[number]; index: number }[] = [];
  allHeadings.forEach((h, index) => {
    if (h.level === 3 && /^\d+\.(?!\d)/.test(h.text)) subHeadings.push({ heading: h, index });
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
  // silently clean. Counted over the MASKED copy, not the raw document, so a
  // `### N.`-shaped line living inside an `expected: |` value — which is value
  // text, not a suppressed row — cannot inflate the tally.
  //
  // #3078 follow-up MINOR 1: a `### N.`-shaped line living inside a properly
  // CLOSED fenced code sample used to document the UAT row format — the
  // ordinary way to explain the syntax inside a UAT file, typically in prose
  // like a `## Notes` section — was still counted by this raw-text scan even
  // though `tokenizeHeadings` correctly hid it (it is documentation, not a
  // suppressed row). Fence-stripping the WHOLE document is NOT a safe fix
  // here: the exact case this scan exists to catch (the fence-straddle
  // BLOCKER above) is ALSO a "properly closed" fence — fence-closedness alone
  // cannot distinguish a documentation sample from a genuinely hidden row.
  // What differs between them is SECTION: a `### N.`-shaped line only ever
  // means a test row inside `## Tests` itself, so scoping this raw scan to
  // that section's own body (the same `collectSection` seam
  // `parseFirstPendingTest` already uses to locate `## Tests`) excludes a
  // fenced sample living elsewhere in the file while leaving the in-section
  // straddle detection above completely intact. Falls back to the WHOLE
  // masked document when no `## Tests` heading exists at all, preserving
  // prior behavior for a non-conformant file that never had one.
  const testsSectionForShapeScan = collectSection(
    maskedContent,
    (h) => /^tests$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  const shapeScanSurface = testsSectionForShapeScan ? testsSectionForShapeScan.body : maskedContent;
  let shapedHeadingLines = 0;
  for (const line of shapeScanSurface.split('\n')) {
    if (TEST_HEADING_LINE_RE.test(line)) shapedHeadingLines += 1;
  }
  if (shapedHeadingLines > subHeadings.length) {
    headingsSeen += shapedHeadingLines - subHeadings.length;
  }

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
    if (UAT_PASS_RESULTS.has(result.toLowerCase())) continue;

    // #3707 follow-up MINOR: the heading filter above now admits `### 3.`
    // (no name at all) and `### 3.Foo` (no space before the name), so this
    // extraction is loosened in lockstep — a bare number with no trailing
    // name falls back to the heading's own trimmed text (`3.`) rather than
    // crashing the non-null assertion the old name-mandatory pattern used.
    const headingParts = current.text.match(/^(\d+)\.\s*(.*)$/)!;
    const testNumber = parseInt(headingParts[1], 10);
    const testName = headingParts[2].trim() || current.text.trim();

    // Reuse the existing block-scalar/inline `expected:` grammar rather than
    // re-deriving a second one (#3707 defect 2). #3078 blocker: the block is
    // CLIPPED at its first top-level fence opener first — still raw text (a
    // legitimate `expected: |` scalar must be read verbatim, fences and all),
    // but bounded to what the tokenizer also treated as visible, so this row
    // cannot reach past a fence into a LATER row's `expected:` line and
    // publish it as its own. See `clipBlockAtFirstFence`.
    const expected = parseExpectedFromTestBlock(clipBlockAtFirstFence(block));

    const reasonMatch = fenceStrippedBlock.match(/reason:\s*(.+)/);
    const blockedByMatch = fenceStrippedBlock.match(/blocked_by:\s*(.+)/);
    const reason = reasonMatch?.[1]?.trim();

    const item: UatItem = {
      test: testNumber,
      name: testName,
      result,
      category: categorizeItem(result, reason, blockedByMatch?.[1]),
    };
    if (expected) item.expected = expected;
    if (reason) item.reason = reason;
    if (blockedByMatch) item.blocked_by = blockedByMatch[1].trim();
    items.push(item);
  }

  items.push(...parseGapsItems(content));
  return { items, headingsSeen };
}

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
  // (UAT_PASS_RESULTS.has(result.toLowerCase())): `result: PENDING` and
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
  maskBlockScalarBodies,
  selectPhaseUatFiles,
  buildCheckpoint,
  CHECKPOINT_FRAMES,
  CHECKPOINT_LANGUAGE_ALIASES,
  resolveCheckpointFrame,
  parseDeferredItems,
  parseDeferredItemsWithStatus,
  acknowledgeDeferredItem,
};
