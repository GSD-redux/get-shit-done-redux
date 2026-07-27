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
const { collectSection, tokenizeHeadings } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownTable = require('./markdown-table.cjs');
const { splitTableRow } = markdownTable;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParser = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter } = roadmapParser;
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
const { PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
import { requireSafePath, sanitizeForDisplay } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoader = require('./config-loader.cjs');
const { loadConfig } = configLoader;

// ─── Types ────────────────────────────────────────────────────────────────────

type UatResult = string;
type UatCategory = 'server_blocked' | 'device_needed' | 'build_needed' | 'third_party' | 'blocked' | 'skipped_unresolved' | 'pending' | 'human_uat' | 'unknown' | 'deferred';

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
  items: UatItem[];
}

interface CurrentTest {
  complete: boolean;
  number?: number;
  name?: string;
  expected?: string;
}

// ─── cmdAuditUat ─────────────────────────────────────────────────────────────

function cmdAuditUat(cwd: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  if (!fs.existsSync(phasesDir)) {
    error('No phases directory found in planning directory');
  }

  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  const results: UatFileResult[] = [];

  // Scan all phase directories
  const dirs = fs.readdirSync(phasesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(isDirInMilestone)
    .sort();

  for (const dir of dirs) {
    const phaseMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    const phaseDir = path.join(phasesDir, dir);
    const files = fs.readdirSync(phaseDir);

    // Process UAT files
    for (const file of files.filter(f => f.includes('-UAT') && f.endsWith('.md'))) {
      const uatFilePath = path.join(phaseDir, file);
      const content = fs.readFileSync(uatFilePath, 'utf-8');
      const items = parseUatItems(content);
      if (items.length > 0) {
        results.push({
          phase: phaseNum,
          phase_dir: dir,
          file,
          file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
          type: 'uat',
          status: (extractFrontmatter(content, uatFilePath).status as string || 'unknown'),
          items,
        });
      }
    }

    // Process VERIFICATION files
    for (const file of files.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md'))) {
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
          items,
        });
      }
    }
  }

  // Compute summary
  const summary: {
    total_files: number;
    total_items: number;
    by_category: Record<string, number>;
    by_phase: Record<string, number>;
  } = {
    total_files: results.length,
    total_items: results.reduce((sum, r) => sum + r.items.length, 0),
    by_category: {},
    by_phase: {},
  };

  for (const r of results) {
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

  // Within the Tests section body, find ### N. Name sub-headings.
  // tokenizeHeadings operates on the section body as a standalone document,
  // filtering to level-3 headings matching the UAT-specific "N. Name" pattern.
  // The UAT-specific item parsing (number extraction, result parsing) stays caller-side.
  const subHeadings = tokenizeHeadings(sectionBody).filter(
    (h) => h.level === 3 && /^\d+\.\s+/.test(h.text),
  );

  for (let i = 0; i < subHeadings.length; i += 1) {
    const current = subHeadings[i];
    const next = subHeadings[i + 1];
    // Slice the block for this sub-test from the section body text
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

    const expected = parseExpectedFromTestBlock(block);
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

function parseExpectedFromTestBlock(block: string): string | null {
  const expectedBlockMatch = block.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m)
    || block.match(/^expected:\s*\|\n([\s\S]+)/m);
  if (expectedBlockMatch) {
    return expectedBlockMatch[1]
      .split('\n')
      .map((line: string) => line.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
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
}

const CHECKPOINT_BOX_WIDTH = 64; // total column width of the ╔══...╗ border, borders stay byte-identical

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
};

function resolveCheckpointFrame(responseLanguage: string | undefined): CheckpointFrame {
  if (!responseLanguage) return CHECKPOINT_FRAMES.english;
  const key = CHECKPOINT_LANGUAGE_ALIASES[responseLanguage.trim().toLowerCase()];
  return (key && CHECKPOINT_FRAMES[key]) || CHECKPOINT_FRAMES.english;
}

// Approximate East Asian Width ranges (Unicode property values W and F) — the
// CJK scripts CHECKPOINT_FRAMES ships (Japanese/Chinese/Korean) render each
// matching code point at 2 terminal/display columns, not 1. Padding computed
// from `.length` (UTF-16 code units) undercounts these by one column per
// wide character, visually misaligning the box's right border (#2402 review
// medium finding). Latin-script frames (English/Spanish/French/German/
// Portuguese/Italian) contain no wide code points, so displayWidth === length
// for them — no behavior change there.
function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals .. CJK Symbols and Punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Hiragana .. CJK Compatibility
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi Syllables
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK Compatibility Forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK Unified Ideographs Extension B+ / supplementary
  );
}

// Iterates by Unicode code point (not UTF-16 code unit) so astral characters
// are measured once, not as two surrogate units.
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += isWideCodePoint(ch.codePointAt(0) as number) ? 2 : 1;
  }
  return width;
}

// Pads `text` into a `║  text…  ║` line matching CHECKPOINT_BOX_WIDTH. Content
// that overflows the box (a longer translated string) is left unpadded rather
// than truncated — a slightly ragged border beats losing text.
function checkpointBoxLine(text: string): string {
  const innerWidth = CHECKPOINT_BOX_WIDTH - 2;
  const content = `  ${text}`;
  const padLength = innerWidth - displayWidth(content);
  const padded = padLength > 0 ? content + ' '.repeat(padLength) : content;
  return `║${padded}║`;
}

function buildCheckpoint(currentTest: { number: number; name: string; expected: string }, responseLanguage?: string): string {
  const frame = resolveCheckpointFrame(responseLanguage);
  return [
    '╔══════════════════════════════════════════════════════════════╗',
    checkpointBoxLine(frame.banner),
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `**Test ${currentTest.number}: ${currentTest.name}**`,
    '',
    currentTest.expected,
    '',
    '──────────────────────────────────────────────────────────────',
    frame.instruction,
    '──────────────────────────────────────────────────────────────',
  ].join('\n');
}

// ─── parseUatItems ────────────────────────────────────────────────────────────

function parseUatItems(content: string): UatItem[] {
  const items: UatItem[] = [];
  // Match test blocks: ### N. Name\nexpected: ...\nresult: ...\n
  // Accept both bare (result: pending) and bracketed (result: [pending]) formats (#2273)
  const testPattern = /###\s*(\d+)\.\s*([^\n]+)\nexpected:\s*([^\n]+)\nresult:\s*\[?(\w+)\]?(?:\n(?:reported|reason|blocked_by):\s*[^\n]*)?/g;
  let match: RegExpExecArray | null;
  while ((match = testPattern.exec(content)) !== null) {
    const [, num, name, expected, result] = match;
    if (result === 'pending' || result === 'skipped' || result === 'blocked') {
      // Extract optional fields — limit to current test block (up to next ### or EOF)
      const afterMatch = content.slice(match.index);
      const nextHeading = afterMatch.indexOf('\n###', 1);
      const blockText = nextHeading > 0 ? afterMatch.slice(0, nextHeading) : afterMatch;
      const reasonMatch = blockText.match(/reason:\s*(.+)/);
      const blockedByMatch = blockText.match(/blocked_by:\s*(.+)/);

      const item: UatItem = {
        test: parseInt(num, 10),
        name: name.trim(),
        expected: expected.trim(),
        result,
        category: categorizeItem(result, reasonMatch?.[1], blockedByMatch?.[1]),
      };
      if (reasonMatch) item.reason = reasonMatch[1].trim();
      if (blockedByMatch) item.blocked_by = blockedByMatch[1].trim();
      items.push(item);
    }
  }
  items.push(...parseGapsItems(content));
  return items;
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
 */
function parseDeferredItems(content: string): UatItem[] {
  const deferredSection = collectSection(
    content,
    (h) => /^deferred\s+items$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  const sectionBody = deferredSection ? deferredSection.body : content;

  const items: UatItem[] = [];

  for (const entryLines of splitGapsEntries(sectionBody)) {
    const fields = extractGapEntryFields(entryLines);
    const rawStatus = fields.status;
    if (rawStatus && rawStatus.toLowerCase() === 'resolved') continue;

    const text = rawGapEntryText(entryLines);
    if (!text) continue;

    items.push({
      name: text,
      result: 'unresolved',
      category: 'deferred',
    });
  }

  return items;
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
  const lines = sectionBody.split('\n');
  const entries: string[][] = [];
  let current: string[] | null = null;
  let baseIndent: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const bulletMatch = line.match(/^(\s*)-\s/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      if (baseIndent === null) baseIndent = indent;
      if (indent <= baseIndent) {
        if (current) entries.push(current);
        current = [line];
        continue;
      }
    }
    if (current) current.push(line);
    // else: pre-first-bullet content (e.g. the template's HTML comment) — discarded.
  }
  if (current) entries.push(current);

  return entries;
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
 */
function extractGapEntryFields(entryLines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  const fieldLineRe = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

  entryLines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\r$/, '');
    // Strip ONLY the entry-opening bullet marker (idx 0); a bullet marker on
    // a later line belongs to a nested sub-list and is handled by
    // `splitGapsEntries` already folding it in — it is not itself a field
    // line unless it independently matches `key: value` after stripping.
    const bulletStripped = line.match(/^(\s*)-\s+(.*)$/);
    const content = idx === 0 && bulletStripped ? bulletStripped[2] : line.trim();

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

function categorizeItem(result: string, reason?: string, blockedBy?: string): UatCategory {
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
  return 'unknown';
}

export = {
  cmdAuditUat,
  cmdRenderCheckpoint,
  parseCurrentTest,
  buildCheckpoint,
  parseDeferredItems,
};
