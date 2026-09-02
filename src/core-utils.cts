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
 *
 * #3883 (ADR-3473 §8.3): two of this module's cyclic partners require
 * generateSlugInternal, the canonical slug formula:
 *   - phase-id.cjs requires this module directly.
 *   - planning-workspace.cjs is a cyclic partner via a longer path:
 *     core-utils.cjs -> planning-workspace.cjs -> active-workstream-store.cjs
 *     -> workstream-name-policy.cjs -> core-utils.cjs.
 * Both are genuine circular requires. They are safe ONLY because every side
 * accesses the other's exports lazily, through the live module-namespace
 * object (`phaseIdModule.foo(...)` / `planningWorkspace.foo(...)`) inside a
 * function body, never via a top-level destructure — a top-level
 * `const { foo } = require(...)` copies the binding at import time and would
 * silently capture `undefined` whichever module loses the load-order race.
 * This is an absolute rule with no exception in this file: every cyclic
 * partner's export is accessed through its module-namespace object, never
 * destructured at the top level.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCommandProjection = require('./shell-command-projection.cjs');
// planning-scope.cjs is a leaf module (no imports of its own — see its file
// header), so importing it here directly cannot introduce a cycle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

// ─── Line-ending normalization ─────────────────────────────────────────────────

/**
 * Normalize every line ending in `content` to a bare `\n`, ONCE — the shared
 * seam every document-READ boundary in this codebase should route through
 * (#3707-CR follow-up MAJOR).
 *
 * CommonMark treats a lone CR (no paired LF) as a line ending — such a
 * document RENDERS as separate lines to a human reader — but a parser that
 * splits/tokenizes/scans on `\n` alone treats a lone-CR-separated document as
 * ONE unbroken line, hiding every row boundary in it. `src/uat.cts` originally
 * carried this exact fix as a PRIVATE, unexported function applied inside two
 * of its own parse functions (`parseUatItemsWithStats`, `parseCurrentTest`) —
 * which is why two OTHER read sites in the same module (`cmdAuditUat`'s
 * VERIFICATION and deferred-items.md ingresses) were missed: normalizing
 * per-parser means every new parser must remember to call it. Promoted here,
 * to the shared leaf module every document consumer can reach without a new
 * dependency edge, so normalization can be applied at the READ boundary
 * instead — every current and future parser fed from a boundary that calls
 * this gets normalized text by construction.
 *
 * `/\r\n?/g` is deliberately ONE alternation, not two separate replaces: a
 * two-pass `replace(/\r\n/g,'\n').replace(/\r/g,'\n')` is equivalent here
 * because the first pass already consumes every CRLF pair before the second
 * pass ever runs, but a single regex avoids relying on pass ORDER and matches
 * greedily left-to-right in one scan, so a CRLF is always consumed as ONE
 * unit (never left as a stray trailing `\r` after the `\n` half is matched
 * first) and a lone CR — including one immediately followed by nothing, i.e.
 * at EOF, or by another lone CR — is still replaced.
 *
 * This is deliberately NOT a length-preserving transform (CRLF, two UTF-16
 * units, becomes LF, one), so any offsets a caller computes must be compared
 * only against THIS normalized string, never against the original raw text.
 *
 * U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR (#3078-CR) are
 * DELIBERATELY NOT folded here, unlike `\r`/`\r\n`. Folding is unnecessary:
 * `String.prototype.split('\n')` never treats U+2028/U+2029 as a delimiter,
 * so an exotic separator can never manufacture a fake line start for a
 * consumer that scans lines produced by `split('\n')`, rather than anchoring
 * a multiline (`/m`) regex directly over unsplit text. Only the latter
 * pattern is vulnerable to the ECMA-262 LineTerminator set including these
 * two code points. This module performs no line-anchored matching of its
 * own; a caller that scans lines should split first and match per-line
 * rather than anchor `/m` over unsplit text — this comment makes no claim
 * about whether any particular caller currently does so.
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

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
  const body = normalized.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
  // #3170: anchor to a summary-shaped heading (Summary / Overview /
  // Accomplishments) so an incidental first heading (a rule list, task
  // breakdown, deviation note) does not contribute its first bold run as the
  // deliverable one-liner. Iterate headings in document order and extract from
  // the first summary-shaped one that has a bold run; fall back to null (not the
  // wrong text) when no such heading exists.
  const headingRe = /^#+\s*([^\n]*)\n+\*\*([^*\n]+)\*\*([^\n]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(body)) !== null) {
    if (!/summary|overview|accomplish/i.test(match[1])) continue;
    const boldInner = match[2].trim();
    const afterBold = match[3];
    if (/:\s*$/.test(boldInner)) {
      const prose = afterBold.trim();
      if (prose.length > 0) return prose;
    } else if (boldInner.length > 0) {
      return boldInner;
    }
  }
  return null;
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
 * #3883 (ADR-3473 §8.3 remediation): `maxLen` lets a caller state its own
 * truncation contract instead of being forced into this function's
 * historical 60-char cap. Some call sites truncated at 60 before the #3883
 * consolidation (commands.cts:cmdGenerateSlug) and some never truncated at
 * all (phase-id.cts toDir/getPhaseDirFromPhaseId, the init.cts/phase-locator
 * phase_slug sites, workstream-name-policy.cts toWorkstreamSlug) — collapsing
 * every caller onto a single hard-coded 60 introduced two identity
 * collisions (distinct >60-char names/phase-slugs truncating to the same
 * value) that did not exist pre-migration. `maxLen: 60` remains the default
 * so untouched callers keep prior behavior; pass `null` for no truncation.
 */
function generateSlugInternal(text: string | null | undefined, maxLen: number | null = 60): string | null {
  if (!text) return null;
  // #2849: strip leading/trailing hyphens AFTER truncation, not only before.
  // .substring(0, 60) can land on a separator, re-introducing a trailing hyphen
  // the strip step exists to prevent. Truncation cannot add a leading hyphen, so
  // running the full ^-+|-+$ pass last is equivalent for leading hyphens and
  // fixes the trailing-hyphen-after-truncation case.
  const collapsed = transliterateForSlug(text).replace(/[^a-z0-9]+/g, '-');
  const truncated = maxLen === null ? collapsed : collapsed.substring(0, maxLen);
  return truncated.replace(/^-+|-+$/g, '');
}

// ─── Transliteration (#2848) ─────────────────────────────────────────────────
//
// Non-Latin titles used to reduce to an empty slug: the `[^a-z0-9]+` strip
// removed every character of an all-Cyrillic title and the hyphen cleanup left
// "". Callers then created unnamed phase directories (`01-`) and empty
// `milestone_slug` init JSON. The fix transliterates Cyrillic to ASCII BEFORE
// the existing ASCII filter, so a non-Latin title yields a usable ASCII slug
// while Latin-script text (which hits zero map entries) is byte-for-byte
// unchanged — the negative control is satisfied by construction.
//
// Multi-letter mappings (ж→zh, ч→ch, ш→sh, щ→sch, ю→yu, я→ya) are applied as a
// single pass; soft/hard signs (ъ, ь) drop to nothing rather than a hyphen.
// Scope is Cyrillic (Russian + the reported Ukrainian/Belarusian extras
// і ї є ґ ў) per the issue's confirmed-working patch. CJK and other
// non-transliterated scripts keep the existing strip-to-ASCII behavior.
const CYRILLIC_TRANSLITERATION: Readonly<Record<string, string>> = {
  // multi-letter first (longest-match-safe within a single pass via ordered keys)
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
  // Ukrainian / Belarusian extras reported in #2848
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g', ў: 'u',
};

const CYRILLIC_TRANSLITERATION_KEYS = Object.keys(CYRILLIC_TRANSLITERATION);

/**
 * Lowercase + transliterate Cyrillic characters to ASCII. The output still
 * contains non-ASCII for scripts outside the map (CJK, etc.) — the caller's
 * existing `[^a-z0-9]+` filter handles those. Latin-script input is returned
 * lowercased with no other change.
 *
 * Shared by `generateSlugInternal` (core-utils) and `slugify` (gsd2-import) so
 * the transliteration step is not duplicated across the two slug helpers (#2848
 * explicitly requires both be fixed).
 */
function transliterateForSlug(text: string): string {
  const lowered = text.toLowerCase();
  let out = '';
  for (const ch of lowered) {
    out += CYRILLIC_TRANSLITERATION_KEYS.includes(ch)
      ? CYRILLIC_TRANSLITERATION[ch]
      : ch;
  }
  return out;
}

// ─── Phase file helpers ──────────────────────────────────────────────────────

interface PhaseFileStats {
  plans: string[];
  summaries: string[];
  hasResearch: boolean;
  hasContext: boolean;
  hasVerification: boolean;
  hasReviews: boolean;
  scope: Scope;
}

// Minimal shape this module needs from plan-scan.cjs's scanPhasePlans result.
interface PlanScanResultShape {
  planFiles: string[];
  summaryFiles: string[];
  scope: Scope;
}

/**
 * Read a phase directory and return counts/flags for common file types.
 *
 * #3183 (ADR-3180 Decision 2): `plans`/`summaries` are derived from the
 * canonical `scanPhasePlans` rather than a local re-derivation, so this
 * primitive can no longer diverge from the single owner of live-plan
 * counting. `scanPhasePlans`
 * lives in plan-scan.cjs, which itself imports `countMatchedSummaries` from
 * THIS module — a top-level import here would be circular, so the require
 * is deferred (lazy, inside the function body) to break the cycle at load
 * time. This mirrors the lazy-require seam already used elsewhere in this
 * repo (see src/audit-command-router.cts) for the same "module A needs
 * module B which needs module A" shape.
 *
 * `hasResearch`/`hasContext`/`hasVerification`/`hasReviews` stay on the raw
 * `readdirSync` listing — they are not plan-scan concerns.
 *
 * #3511 BLOCKER-2: the raw listing is scoped through `scopeToPhase` (keyed on
 * `path.basename(phaseDir)`) before any of the four artifact predicates run,
 * so a stray cross-phase file (e.g. `04-VERIFICATION.md` sitting inside phase
 * 03's directory) cannot flip `hasResearch`/`hasContext`/`hasVerification`/
 * `hasReviews` true for a phase it does not belong to — the same membership
 * rule every other aggregate phase-directory scan (`uat.cts`, `audit.cts`,
 * `phase.cts`, `state.cts`) already routes through. `hasContext` is scoped by
 * passing the already-scoped array into `findContextMdIn` at this call site
 * only — `findContextMdIn` itself is unchanged and its other 4 call sites
 * (roadmap.cts, gap-checker.cts, init.cts) are unaffected.
 *
 * Degrades on an unreadable directory instead of throwing: empty arrays,
 * every flag false, scope UNREADABLE (mirroring scanPhasePlans's own
 * degrade path).
 *
 * #4014 (epic #3473 B4-unreadable): this function's OWN readdirSync used to
 * catch its own failure and then return `scope: scan.scope` — the scope of
 * the UNRELATED, already-successful scanPhasePlans call — silently dropping
 * that THIS read failed. The own-readdirSync is now routed through
 * findContextMdIn's directory-string form (which never throws and reports
 * its own SCOPE.UNREADABLE), and the two independently-scoped answers are
 * combined into the worse of the two below — never letting a successful
 * scan.scope mask this function's own failed read.
 *
 * The combination is written out as a two-value comparison rather than
 * calling planning-snapshot.cts's `worstScope` directly: that module
 * requires core-utils.cjs (for `findOrphanSummaries`) at its own top level,
 * so importing it back here would create a tight, direct
 * core-utils.cjs <-> planning-snapshot.cjs cycle — a materially different
 * (and riskier) shape than this file's existing, documented lazy-access
 * cyclic partners (planning-workspace.cjs, phase-id.cjs), which
 * planning-snapshot.cts sits *above* in the dependency graph, not beside.
 * `findContextMdIn`'s directory-string form can only ever report
 * SCOPE.COMPLETE or SCOPE.UNREADABLE (a single readdirSync is binary — see
 * its own doc comment), so per planning-snapshot.cts's SCOPE_SEVERITY
 * ordering (UNREADABLE is maximal), `worstScope(scan.scope, ownScope)` is
 * exactly `ownScope === UNREADABLE ? UNREADABLE : scan.scope` — the
 * expression below is that identity, not a re-derivation of the ordering.
 */
function getPhaseFileStats(phaseDir: string): PhaseFileStats {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const scanPhasePlans: (dir: string) => PlanScanResultShape = require('./plan-scan.cjs');
  const scan = scanPhasePlans(phaseDir);

  const { files, scope: ownScope } = planningWorkspace.findContextMdIn(phaseDir);
  const scope: Scope = ownScope === SCOPE.UNREADABLE ? SCOPE.UNREADABLE : scan.scope;

  if (ownScope === SCOPE.UNREADABLE) {
    return {
      plans: scan.planFiles,
      summaries: scan.summaryFiles,
      hasResearch: false,
      hasContext: false,
      hasVerification: false,
      hasReviews: false,
      scope,
    };
  }

  const scopedFiles = phaseIdModule.scopeToPhase(files, path.basename(phaseDir));

  return {
    plans: scan.planFiles,
    summaries: scan.summaryFiles,
    hasResearch: scopedFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
    hasContext: planningWorkspace.findContextMdIn(scopedFiles) !== null,
    hasVerification: scopedFiles.some(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md'),
    hasReviews: scopedFiles.some(f => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md'),
    scope,
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
    return sort ? dirs.sort((a, b) => phaseIdModule.comparePhaseNum(a, b)) : dirs;
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
  // #3183: canonical-id form. Restores the coverage of the pre-migration
  // bespoke I001 rule (verify.cts, pre-#3183, via validate.cjs's now-unused
  // `canonicalPlanStem` — behaviourally identical to `extractCanonicalPlanId`,
  // confirmed empirically), which matched a plan carrying a descriptive slug
  // after its <phase>-<plan> id — e.g. `68-01-scaffolding-PLAN.md` — against
  // a summary named only by the bare id — `68-01-SUMMARY.md`. None of the
  // three candidates above produce that filename.
  //
  // Narrowed to the case `extractCanonicalPlanId` actually extracted an
  // <id>-<id> pair (its result differs from the plan's own PLAN-stripped
  // base). When no pair is found it falls back to returning that same base
  // unchanged, which would otherwise push a redundant candidate identical to
  // the `<stem>-SUMMARY.md` form above (e.g. `setup-PLAN.md` -> canonical
  // 'setup' -> 'setup-SUMMARY.md', already candidate #2) rather than the
  // original rule's actual behavior of matching only real id pairs.
  //
  // Collision, matching the original rule byte-for-behaviour: two plans that
  // share the same <phase>-<plan> id but differ only in their descriptive
  // slug (`68-01-alpha-PLAN.md` + `68-01-beta-PLAN.md`) both generate the
  // SAME candidate `68-01-SUMMARY.md` and therefore BOTH read as summarized
  // off one shared summary file. This is not a new regression: the
  // pre-migration bespoke rule collapsed the same way (it populated one
  // `summaryBases` Set keyed by canonical stem, so any plan whose canonical
  // stem hit the set counted as matched, with no cardinality check against
  // how many plans shared that stem).
  const planStem = base.replace(/-PLAN$/i, '');
  const canonicalId = extractCanonicalPlanId(base + '.md');
  if (canonicalId !== planStem) candidates.push(dir + canonicalId + '-SUMMARY.md');
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

/**
 * #3183: the mirror image of `findUnsummarizedPlans` — the summary files in
 * `summaryFiles` that do NOT pair with ANY plan in `planFiles`, using the
 * identical `summaryCandidates` matching rule as `countMatchedSummaries` /
 * `findUnsummarizedPlans`. Callers that must name orphaned summaries (a
 * stray non-plan summary, or a summary whose plan was renamed/removed) need
 * this instead of a bespoke exact-suffix Set-diff, which cannot recognize
 * the nested or extended naming forms `summaryCandidates` already handles —
 * a divergence that produced false "orphan summary" warnings.
 */
function findOrphanSummaries(planFiles: string[], summaryFiles: string[]): string[] {
  const claimed = new Set<string>();
  for (const plan of planFiles) {
    for (const candidate of summaryCandidates(plan)) claimed.add(candidate);
  }
  return summaryFiles.filter((s) => !claimed.has(s));
}

export = {
  toPosixPath,
  normalizeLineEndings,
  detectSubRepos,
  extractOneLinerFromBody,
  pathExistsInternal,
  generateSlugInternal,
  transliterateForSlug,
  getPhaseFileStats,
  readSubdirectories,
  timeAgo,
  extractCanonicalPlanId,
  countMatchedSummaries,
  findUnsummarizedPlans,
  findOrphanSummaries,
};
