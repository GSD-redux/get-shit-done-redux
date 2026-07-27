/**
 * UAT Predicate — Pure-computation UAT pass/fail evaluation
 *
 * Evaluates all *-UAT.md and *-VERIFICATION.md files in a phase directory and
 * returns a typed report. Used by `phase uat-passed` to harden against the
 * naive whole-file regex in cmdPhaseComplete which false-matches `result:` lines
 * inside frontmatter, fenced code blocks, blockquotes, and HTML comments.
 *
 * Issue #247 — phase uat-passed predicate
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/uat-predicate.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownSectionizer = require('./markdown-sectionizer.cjs');
const { stripFencedCode } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verification = require('./verification.cjs');
const { readVerificationStatus } = verification;

// ─── Types ────────────────────────────────────────────────────────────────────

interface UatCheckItem {
  file: string;
  test: number;
  name: string;
  result: string;
  passing: boolean;
}

interface UatPassedReport {
  passed: boolean;
  uat_files: string[];
  verification_files: string[];
  checks: UatCheckItem[];
  blockers: string[];
  no_uat_artifacts: boolean;
  policy: {
    require_verification: boolean;
  };
}

// ─── Blocking state sets (documented for maintainability) ─────────────────────

// UAT file frontmatter `status` values that indicate the file is not fully done
const BLOCKING_UAT_FM_STATUSES = new Set([
  'partial', 'diagnosed', 'pending', 'blocked', 'in_progress', 'failed',
]);

// UAT file frontmatter `result` values that indicate failure
const BLOCKING_UAT_FM_RESULTS = new Set(['pending', 'blocked', 'failed']);

// Canonical VERIFICATION frontmatter `status` value that indicates passing.
const PASSING_VERIFICATION_STATUSES = new Set(['passed']);

// VERIFICATION file frontmatter `status` values that explicitly block
const BLOCKING_VERIFICATION_FM_STATUSES = new Set([
  'human_needed', 'gaps_found', 'pending', 'blocked', 'partial',
  'failed', 'in_progress',
]);

// UAT test-item `result` values that count as passing
const PASSING_RESULTS = new Set(['passed', 'pass']);

// ─── stripFalsePositiveContexts ───────────────────────────────────────────────

/**
 * Remove contexts that can contain `result: ...` lines that are NOT real test results:
 *   (a) leading frontmatter block at byte 0
 *   (b) HTML comments (unterminated comments swallow to EOF — fail-closed)
 *   (c) fenced code blocks (backtick and tilde, indented too) via CommonMark state machine
 *   (d) blockquote lines
 *
 * Each step is a composable function (Kernighan's Law — independently testable).
 * Returns surviving lines joined by '\n'. Robust to CRLF input.
 */
function stripFalsePositiveContexts(content: string): string {
  // Step (a): strip leading frontmatter block only at byte 0
  let stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');

  // Step (b): remove HTML comments anywhere; unterminated comment swallows to EOF
  stripped = stripped.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

  // Step (c): remove fenced code blocks via the canonical seam (ADR-1372 T5)
  stripped = stripFencedCode(stripped).text;

  // Step (d): remove blockquote lines
  stripped = stripped
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n');

  return stripped;
}

/**
 * Analyse raw markdown for structural anomalies (unterminated fence / comment).
 * Exported for unit-testability and used by evaluateUatPassed for per-file malformed detection.
 *
 * FIX C: properly balanced comments are stripped before checking for a dangling <!--,
 * so an earlier closed comment does not mask a later unterminated one.
 */
function analyzeMarkdown(raw: string): { unterminatedFence: boolean; unterminatedComment: boolean } {
  // Detect an unterminated HTML comment via a paired scan: every `<!--` must
  // have a following `-->`. Using indexOf (not a regex .replace of the comment
  // token) avoids the js/incomplete-multi-character-sanitization pattern — and
  // is exact: a closed earlier comment never masks a later unterminated one.
  let unterminatedComment = false;
  for (let i = 0; ; ) {
    const open = raw.indexOf('<!--', i);
    if (open === -1) break;
    const close = raw.indexOf('-->', open + 4);
    if (close === -1) { unterminatedComment = true; break; }
    i = close + 3;
  }

  // Fence state machine gives the accurate unterminated-fence signal (seam, ADR-1372 T5).
  const { unterminatedFence } = stripFencedCode(raw);

  return { unterminatedFence, unterminatedComment };
}

// ─── parseUatResultItems ──────────────────────────────────────────────────────

/**
 * HEADING-BLOCK parser: scan the CLEANED body (after stripFalsePositiveContexts)
 * for UAT test blocks.
 *
 * For each ### N. Name heading, the block spans until the next ### heading or EOF.
 * Within each block, find a column-0 anchored result line (rejects indented YAML
 * block-scalar bodies and inline/quoted fakes).
 *
 * - If a heading block has NO column-0 result line → emit result:'missing' (blocker).
 * - Support bracketed [passed] and bare passed (#2273).
 * - Returns ALL items (both passing and non-passing).
 */
function parseUatResultItems(cleanContent: string): Array<{ test: number; name: string; result: string }> {
  const items: Array<{ test: number; name: string; result: string }> = [];

  // Find all ### N. Name headings (line-anchored)
  const headingPattern = /^###\s*(\d+)\.\s*(.+)$/gm;
  const headings: Array<{ index: number; test: number; name: string }> = [];
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingPattern.exec(cleanContent)) !== null) {
    headings.push({
      index: hMatch.index + hMatch[0].length,
      test: parseInt(hMatch[1], 10),
      name: hMatch[2].trim(),
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const blockStart = h.index;
    // More precise: find next heading's position in the original string
    // We'll slice from current heading end to the position just before next heading's "###"
    const nextHeadingMatch = i + 1 < headings.length
      ? cleanContent.lastIndexOf('\n###', headings[i + 1].index)
      : -1;
    const blockContent = nextHeadingMatch >= blockStart
      ? cleanContent.slice(blockStart, nextHeadingMatch)
      : cleanContent.slice(blockStart);

    // Column-0 anchored result line: /^result:[ \t]*\[?([\w-]+)\]?/mi
    // Uses [ \t]* (not \s*) so the captured value must sit on the SAME line as result:.
    // A result: key with the value on a subsequent line yields no match → 'missing' (blocker).
    const resultMatch = /^result:[ \t]*\[?([\w-]+)\]?/mi.exec(blockContent);
    if (resultMatch) {
      items.push({
        test: h.test,
        name: h.name,
        result: resultMatch[1].toLowerCase(),
      });
    } else {
      // No column-0 result line → emit 'missing' (a non-passing state)
      items.push({
        test: h.test,
        name: h.name,
        result: 'missing',
      });
    }
  }

  return items;
}

// ─── evaluateUatPassed ────────────────────────────────────────────────────────

/**
 * Evaluate all UAT/VERIFICATION files in a phase directory.
 * Returns a UatPassedReport with the locked, stable shape defined by the interface.
 *
 * FAIL-CLOSED: any absence/ambiguity/malformed input → NOT passed.
 * Pass requires at least one real passing check AND no blockers.
 */
function evaluateUatPassed(
  phaseFullDir: string,
  opts?: { policy?: { requireVerification?: boolean } },
): UatPassedReport {
  const requireVerification = opts?.policy?.requireVerification === true;

  const blockers: string[] = [];
  const checks: UatCheckItem[] = [];
  const uatFiles: string[] = [];
  const verificationFiles: string[] = [];

  // Read the directory — if unreadable, treat as no files (fail-closed: no artifacts → not passed)
  let dirEntries: string[] = [];
  try {
    dirEntries = fs.readdirSync(phaseFullDir);
  } catch {
    // Unreadable dir — no_uat_artifacts:true, passed:false
    const no_uat_artifacts = true;
    if (requireVerification) {
      blockers.push('policy: verification required but no passing *-VERIFICATION.md found');
    }
    return {
      passed: false,
      uat_files: [],
      verification_files: [],
      checks: [],
      blockers,
      no_uat_artifacts,
      policy: { require_verification: requireVerification },
    };
  }

  // Filter UAT and VERIFICATION files using the same filter as cmdPhaseComplete
  const uatFileNames = dirEntries.filter(f => f.includes('-UAT') && f.endsWith('.md'));
  const verFileNames = dirEntries.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md'));

  // ── Process UAT files ──────────────────────────────────────────────────────
  for (const file of uatFileNames) {
    uatFiles.push(file);
    const uatFilePath = path.join(phaseFullDir, file);
    let raw = '';
    try {
      raw = fs.readFileSync(uatFilePath, 'utf-8');
    } catch {
      blockers.push(`${file}: could not read file`);
      continue;
    }

    // ── Per-file malformed markdown guard ──────────────────────────────────
    // FIX D: use accurate signals from analyzeMarkdown instead of heuristics.
    // unterminatedFence: CommonMark state machine detects a genuinely unclosed fence.
    // unterminatedComment: strips balanced comments first, then checks for leftover <!--.
    const { unterminatedFence, unterminatedComment } = analyzeMarkdown(raw);
    if (unterminatedFence || unterminatedComment) {
      blockers.push(`${file}: malformed markdown (unterminated fence or comment)`);
    }

    const fm = extractFrontmatter(raw, uatFilePath) as Record<string, unknown>;

    // File-level frontmatter status check
    if (fm['status'] && BLOCKING_UAT_FM_STATUSES.has(fm['status'] as string)) {
      blockers.push(`${file}: frontmatter status=${fm['status'] as string}`);
    }
    // File-level frontmatter result check
    if (fm['result'] && BLOCKING_UAT_FM_RESULTS.has(fm['result'] as string)) {
      blockers.push(`${file}: frontmatter result=${fm['result'] as string}`);
    }

    // Parse test items from the cleaned body (hardened against false positives)
    const cleanContent = stripFalsePositiveContexts(raw);
    const items = parseUatResultItems(cleanContent);

    for (const item of items) {
      const passing = PASSING_RESULTS.has(item.result);
      checks.push({
        file,
        test: item.test,
        name: item.name,
        result: item.result,
        passing,
      });
      if (!passing) {
        blockers.push(`${file}: test ${item.test} (${item.result})`);
      }
    }
  }

  // ── Process VERIFICATION files ─────────────────────────────────────────────
  let hasPassingVerification = false;
  for (const file of verFileNames) {
    verificationFiles.push(file);
    const verificationFilePath = path.join(phaseFullDir, file);
    let raw = '';
    try {
      raw = fs.readFileSync(verificationFilePath, 'utf-8');
    } catch {
      blockers.push(`${file}: could not read verification file`);
      continue;
    }

    const vfm = extractFrontmatter(raw, verificationFilePath) as Record<string, unknown>;
    const vStatus = vfm['status'] as string | undefined;

    if (vStatus && BLOCKING_VERIFICATION_FM_STATUSES.has(vStatus)) {
      blockers.push(`${file}: verification status=${vStatus}`);
    } else if (vStatus && PASSING_VERIFICATION_STATUSES.has(vStatus)) {
      // Allowlist: only explicitly-passing statuses count
      hasPassingVerification = true;
    }
    // Missing or unknown status: does NOT count as passing, does NOT push a blocker
    // (handled by the requireVerification policy check below if needed)
  }

  // ── Policy: requireVerification ───────────────────────────────────────────
  if (requireVerification) {
    const verificationStatus = readVerificationStatus(phaseFullDir).status;
    if (verificationStatus === 'stale') {
      blockers.push('policy: verification status=stale');
    } else if (verificationStatus !== 'passed' || !hasPassingVerification) {
      blockers.push('policy: verification required but no passing *-VERIFICATION.md found');
    }
  }

  // ── Determine no_uat_artifacts and passed ─────────────────────────────────
  // no_uat_artifacts: true when no real UAT test items were parsed from any file
  const no_uat_artifacts = checks.length === 0;

  // FIX 1: require positive passing evidence; no vacuous pass
  // passed = no blockers AND at least one check AND all checks passing
  const passed = blockers.length === 0 && checks.length > 0 && checks.every(c => c.passing);

  return {
    passed,
    uat_files: uatFiles,
    verification_files: verificationFiles,
    checks,
    blockers,
    no_uat_artifacts,
    policy: {
      require_verification: requireVerification,
    },
  };
}

export = {
  stripFalsePositiveContexts,
  parseUatResultItems,
  analyzeMarkdown,
  evaluateUatPassed,
};
