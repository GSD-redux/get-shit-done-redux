/**
 * Core Utilities — Shared low-level utility primitives
 *
 * ADR-857 rollout phase 2c: extracted from core.cts (issue #877).
 * Owns POSIX path normalization, sub-repo/subdirectory scanning,
 * phase file stats, slug/one-liner/plan-id helpers, and time-ago.
 * Behaviour is preserved byte-for-behaviour from the prior location;
 * only the module boundary moved. core.cjs re-exports every public symbol
 * here under its own `export =` object so existing consumers are unaffected.
 *
 * New imports should pull core-utils helpers from core-utils.cjs directly.
 *
 * Dependencies (leaf modules only — no core.cjs, no loadConfig):
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs       (comparePhaseNum, used by readSubdirectories)
 *   - ./planning-workspace.cjs (findContextMdIn, used by getPhaseFileStats)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { comparePhaseNum } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { findContextMdIn } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCommandProjection = require('./shell-command-projection.cjs');

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a relative path to always use forward slashes (cross-platform).
 * Delegates to the single separator seam in shell-command-projection so there is
 * exactly one implementation of native→POSIX conversion across the codebase.
 */
function toPosixPath(p: string): string {
  return shellCommandProjection.toPosixPath(p);
}

/**
 * Scan immediate child directories for separate git repos.
 * Returns a sorted array of directory names that have their own `.git`.
 * Excludes hidden directories and node_modules.
 */
function detectSubRepos(cwd: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const gitPath = path.join(cwd, entry.name, '.git');
      try {
        if (fs.existsSync(gitPath)) {
          results.push(entry.name);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return results.sort();
}

// ─── Summary body helpers ─────────────────────────────────────────────────

/**
 * Extract a one-liner from the summary body when it's not in frontmatter.
 */
function extractOneLinerFromBody(content: string | null | undefined): string | null {
  if (!content) return null;
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const match = body.match(/^#[^\n]*\n+\*\*([^*\n]+)\*\*([^\n]*)/m);
  if (!match) return null;
  const boldInner = match[1].trim();
  const afterBold = match[2];
  if (/:\s*$/.test(boldInner)) {
    const prose = afterBold.trim();
    return prose.length > 0 ? prose : null;
  }
  return boldInner.length > 0 ? boldInner : null;
}

// ─── Misc utilities ───────────────────────────────────────────────────────────

function pathExistsInternal(cwd: string, targetPath: string): boolean {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cyrillic → ASCII transliteration table (#2848).
 *
 * Every key is a SINGLE code point and the table is applied in ONE pass
 * (Array.from + map lookup), never as a chain of `.replace()` calls. That
 * removes the ordering trap a chained implementation has, where `щ`→`sch` must
 * run before `ш`→`sh` or the shorter rule corrupts the longer one's output: a
 * single-pass map cannot feed one substitution's output into another's input,
 * so the table needs no ordering discipline at all.
 */
const CYRILLIC_TRANSLITERATION: Readonly<Record<string, string>> = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian / Belarusian / Serbian letters absent from the Russian alphabet.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ђ: 'dj', ј: 'j', љ: 'lj', њ: 'nj',
  ћ: 'c', џ: 'dz',
});

const DEFAULT_SLUG_MAX_LENGTH = 60;

/**
 * The single slug implementation (#2848). Every slug in this codebase is
 * produced here — call sites re-export or delegate, never re-implement.
 *
 * Non-Latin input used to collapse to `''`, which callers then wrote into path
 * segments as a nameless `phases/01-` directory. Cyrillic is transliterated to
 * ASCII; a script with no ASCII spelling leaves nothing the filter can keep, so
 * the result is the empty string — the contract `next` pins in
 * tests/core-utils.test.cjs ('not null, not `-`'). Callers that cannot use an
 * empty path segment check for it explicitly; see slugify in gsd2-import.
 *
 * Truncation happens HERE and nowhere else: callers pass their own limit via
 * `maxLength` instead of re-cutting the result, so a slug can never be cut
 * twice against two different limits. Cutting is done over code POINTS rather
 * than UTF-16 code units so a truncation cannot leave a lone surrogate behind,
 * and the hyphen trim runs again AFTER the cut so truncation cannot resurrect
 * the trailing hyphen the first trim removed (#2849).
 *
 * @returns the slug; `null` when `text` itself is falsy, and `''` when `text`
 * is non-empty but contains no slug-safe characters.
 */
function generateSlugInternal(
  text: string | null | undefined,
  maxLength: number = DEFAULT_SLUG_MAX_LENGTH,
): string | null {
  if (!text) return null;
  // Transliteration runs BEFORE the NFKD fold, not after. `ё` and `ї` are
  // precomposed: NFKD splits them into a base letter plus a combining
  // diaeresis, so folding first would strip the mark and quietly downgrade
  // `ё`→`e` and `ї`→`i` before the table ever sees them.
  //
  // The table itself lives in `transliterateForSlug` (landed with #2934) and is
  // called here rather than re-implemented: a second copy of the same rule is
  // exactly the failure mode this consolidation exists to end.
  const transliterated = transliterateForSlug(text);
  // With Cyrillic already ASCII, the fold only has Latin diacritics left to
  // deal with: `Café` → `cafe` rather than `caf-`.
  const ascii = transliterated.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const collapsed = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const points = Array.from(collapsed);
  // Clamp a negative limit to 0 rather than letting `.slice(0, maxLength)`
  // read it as "count back from the end" — a negative limit is a caller bug,
  // not a request for the last N characters, and treating it as the latter
  // silently trimmed the trailing character instead of refusing everything.
  const clampedMaxLength = Math.max(0, maxLength);
  const cut = points.length <= clampedMaxLength ? collapsed : points.slice(0, clampedMaxLength).join('');
  // Contract preserved from next, which pins it in tests: a FALSY input yields
  // null (handled above), while a non-empty input whose characters are all
  // separators yields '' — not null and not a stray '-'. This PR consolidates
  // the implementation; it does not redefine what the implementation returns.
  return cut.replace(/^-+|-+$/g, '');
}

/**
 * Lowercase + transliterate Cyrillic to ASCII against the single table above.
 *
 * Shared by `generateSlugInternal` here and by `slugify` in gsd2-import, so the
 * transliteration step exists exactly once in the tree — the property this PR
 * is about. Scripts outside the table (CJK and the like) pass through unchanged
 * and are handled by the caller's `[^a-z0-9]+` filter.
 */
function transliterateForSlug(text: string): string {
  return Array.from(text.toLowerCase())
    .map((ch) => (Object.prototype.hasOwnProperty.call(CYRILLIC_TRANSLITERATION, ch)
      ? CYRILLIC_TRANSLITERATION[ch]
      : ch))
    .join('');
}

// ─── Phase file helpers ──────────────────────────────────────────────────────

/** Filter a file list to just PLAN.md / *-PLAN.md entries. */
function filterPlanFiles(files: string[]): string[] {
  return files.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
}

/** Filter a file list to just SUMMARY.md / *-SUMMARY.md entries. */
function filterSummaryFiles(files: string[]): string[] {
  return files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
}

interface PhaseFileStats {
  plans: string[];
  summaries: string[];
  hasResearch: boolean;
  hasContext: boolean;
  hasVerification: boolean;
  hasReviews: boolean;
}

/**
 * Read a phase directory and return counts/flags for common file types.
 */
function getPhaseFileStats(phaseDir: string): PhaseFileStats {
  const files = fs.readdirSync(phaseDir);
  return {
    plans: filterPlanFiles(files),
    summaries: filterSummaryFiles(files),
    hasResearch: files.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
    hasContext: findContextMdIn(files) !== null,
    hasVerification: files.some(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md'),
    hasReviews: files.some(f => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md'),
  };
}

/**
 * Read immediate child directories from a path.
 * Returns [] if the path doesn't exist or can't be read.
 * Pass sort=true to apply comparePhaseNum ordering.
 */
function readSubdirectories(dirPath: string, sort = false): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    return sort ? dirs.sort((a, b) => comparePhaseNum(a, b)) : dirs;
  } catch {
    return [];
  }
}

/**
 * Format a Date as a fuzzy relative time string (e.g. "5 minutes ago").
 */
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  if (years === 1) return '1 year ago';
  return `${years} years ago`;
}

// ─── Plan ID helpers ─────────────────────────────────────────────────────────

/**
 * Extract the canonical plan ID from a filename.
 * Private to the core cluster — exported so core.cjs:searchPhaseInDir can
 * import it from this leaf without circular dependency, but NOT re-exported
 * from core.cjs's public `export =` block.
 */
function extractCanonicalPlanId(filename: string): string {
  const base = filename.replace(/-PLAN\.md$/i, '').replace(/-SUMMARY\.md$/i, '').replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  // #2043: a phase/plan token component is either a zero-padded number (≥2 digits)
  // or a single-digit-plus-letter id ("3A"); a *bare* single digit is a slug word,
  // so "46-6-rs-…" is not paired into a "46-6" id while "3A-01" stays intact.
  const tokenRe = /^(?:\d{2,}[A-Z]?|\d[A-Z])(?:\.\d+)*$/i;
  // #2232: the PAIRED plan component is a zero-padded continuation segment
  // (exactly 2 digits), so a ≥3-digit slug word (a year) is not paired into a
  // bogus "14-2026" id. The leading phase component keeps tokenRe's unbounded
  // \d{2,} — phase numbers ≥100 are legitimate; only continuations are capped.
  const planTokenRe = new RegExp(
    `^(?:${phaseIdModule.PHASE_CONTINUATION_SEGMENT_SOURCE}[A-Z]?|\\d[A-Z])(?:\\.\\d+)*$`,
    'i',
  );
  const phaseIdx = parts.findIndex(p => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && planTokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
}

/**
 * Count summaries that correspond to a real plan (#1988).
 *
 * A summary counts toward phase completion iff it pairs with an existing plan
 * file. This excludes stray non-plan summaries — e.g. `30-FIX-CR02-SUMMARY.md`,
 * `30-GAPCLOSURE-SUMMARY.md` — that inflate the raw `*-SUMMARY.md` count and
 * silently flip a phase to Complete when plans are actually missing summaries.
 *
 * Pairing is layout-agnostic. For each plan, up to three candidate summary
 * filenames are generated and any match suffices:
 *   1. marker swap `PLAN`→`SUMMARY` on the basename — root padded
 *      (`30-01-PLAN.md`↔`30-01-SUMMARY.md`), nested (`PLAN-01.md`↔
 *      `SUMMARY-01.md`, incl. a `plans/` prefix), and bare (`PLAN.md`↔
 *      `SUMMARY.md`);
 *   2. `<stem>-SUMMARY.md` — bare (`PLAN.md`↔`PLAN-SUMMARY.md`) and legacy
 *      (`14-PLAN-01.md`↔`14-PLAN-01-SUMMARY.md`);
 *   3. extended `<n>-PLAN-<m>…`→`<n>-<m>-SUMMARY.md`
 *      (`3-PLAN-01-setup.md`↔`3-01-SUMMARY.md`).
 * The swap is applied to the basename only so a lowercase `plans/` dir prefix
 * isn't corrupted to `SUMMARYs/…`.
 */
function countMatchedSummaries(planFiles: string[], summaryFiles: string[]): number {
  const summarySet = new Set(summaryFiles);
  let matched = 0;
  for (const plan of planFiles) {
    if (summaryCandidates(plan).some((c) => summarySet.has(c))) matched++;
  }
  return matched;
}

/**
 * The candidate `*-SUMMARY.md` filenames a single plan's completion record
 * could take, per the three naming conventions documented above
 * `countMatchedSummaries`. Extracted so `findUnsummarizedPlans` can reuse the
 * exact same matching rule without duplicating it (a divergence between the
 * count and the list would let a plan be counted as matched while still
 * appearing in the unsummarized set, or vice versa).
 */
function summaryCandidates(plan: string): string[] {
  const slashIdx = plan.lastIndexOf('/');
  const dir = slashIdx >= 0 ? plan.slice(0, slashIdx + 1) : '';
  const base = (dir ? plan.slice(dir.length) : plan).replace(/\.md$/i, '');
  const candidates: string[] = [
    dir + base.replace(/PLAN/i, 'SUMMARY') + '.md',
    dir + base + '-SUMMARY.md',
  ];
  const extended = base.match(/^(\d+)-PLAN-(\d+)/i);
  if (extended) candidates.push(dir + extended[1] + '-' + extended[2] + '-SUMMARY.md');
  return candidates;
}

/**
 * #2648: the plan files in `planFiles` that have NO matching completion record
 * in `summaryFiles`, using the identical matching rule as `countMatchedSummaries`
 * (so the count and the named list can never disagree). Callers that must NAME
 * the missing plans — e.g. phase.complete's fail-closed coverage gate, which
 * refuses completion when any non-retired plan lacks a SUMMARY — need the list,
 * not just the count. `planFiles` is expected to be already superseded-filtered
 * (the caller passes `scanPhasePlans(...).planFiles`, which drops
 * `status: superseded` plans), so a deliberately-retired plan never appears
 * here and never blocks completion.
 */
function findUnsummarizedPlans(planFiles: string[], summaryFiles: string[]): string[] {
  const summarySet = new Set(summaryFiles);
  return planFiles.filter((plan) => !summaryCandidates(plan).some((c) => summarySet.has(c)));
}

export = {
  toPosixPath,
  detectSubRepos,
  extractOneLinerFromBody,
  pathExistsInternal,
  generateSlugInternal,
  transliterateForSlug,
  DEFAULT_SLUG_MAX_LENGTH,
  filterPlanFiles,
  filterSummaryFiles,
  getPhaseFileStats,
  readSubdirectories,
  timeAgo,
  extractCanonicalPlanId,
  countMatchedSummaries,
  findUnsummarizedPlans,
};
