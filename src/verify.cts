/**
 * Verify — Verification suite, consistency, and health validation
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/verify.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { phaseVariants, buildRoadmapPhaseVariants, buildNotStartedPhaseVariants } from './validate.cjs';
import { realClock } from './clock.cjs';
import { phaseDirNameRe, PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE, canonicalPlanStem, textEncodingError } from './validate.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-profiles.cjs is an export= CommonJS module
import modelProfilesMod = require('./model-profiles.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
import { execGit, platformReadSync as safeReadFile, platformWriteSync, posixNormalize } from './shell-command-projection.cjs';
import { PACKAGE_NAME } from './package-identity.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { detectSchemaFiles, checkSchemaDrift } from './schema-detect.cjs';
import { isCanonicalPlanningFile } from './artifacts.cjs';
import { extractTaggedBlocks } from './markdown-sectionizer.cjs';
import { VALID_PROFILES, VALID_TIERS, VALID_PHASE_TYPES } from './model-catalog.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheck = require('./agent-install-check.cjs');
const { checkAgentsInstalled } = agentInstallCheck;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig, CONFIG_DEFAULTS } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { normalizePhaseName, phaseTokenMatches, escapeRegex, getMilestoneFromPhaseId, OPTIONAL_PHASE_TAG_SOURCE, PHASE_NUMBER_TOKEN_SOURCE, extractPhaseToken, comparePhaseNum } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo, stripShippedMilestones, extractCurrentMilestone } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeSafetyMod = require('./worktree-safety.cjs');
const { inspectWorktreeHealth } = worktreeSafetyMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- commands.cjs is an export= CommonJS module
import commandsMod = require('./commands.cjs');
const { determinePhaseStatus } = commandsMod;

const { planningDir, planningRoot } = planningWorkspace;
const { extractFrontmatter, parseMustHavesBlock } = frontmatterMod;
const { writeStateMd } = stateMod;
const { MODEL_PROFILES } = modelProfilesMod;

// Unused but imported for structural parity
void stripShippedMilestones;
void detectSchemaFiles;

interface SummaryVerification {
  passed: boolean;
  checks: {
    summary_exists: boolean;
    files_created: { checked: number; found: number; missing: string[] };
    commits_exist: boolean;
    self_check: string;
  };
  errors: string[];
}

/**
 * Pure core of `verify-summary` (#2572).
 *
 * Same artifact↔git checks the CLI verb has always run, lifted out of the
 * `output()` wrapper so other verbs can consume the structured
 * `{ passed, checks, errors }` contract directly instead of shelling out and
 * re-parsing JSON. `cmdVerifySummary` is now a thin adapter over this.
 *
 * Never throws and never writes to stdout: a missing SUMMARY, a non-repo, or an
 * unresolvable commit all come back as structured `false`/`missing` values.
 *
 * Caveat for callers surfacing `commits_exist`: the hash pattern is a loose
 * `\b[0-9a-f]{7,40}\b`, so any hex-shaped token in the prose counts as a
 * candidate. That is cheap as an advisory signal and unacceptable as a gate.
 *
 * @param checkFileCount How many extracted candidates to probe. Defaults to 2 —
 *   the value the CLI verb has always used. Pass `Infinity` to probe every
 *   candidate (see `cmdPhaseComplete`, which reports on all of them).
 * @param opts.checkCommits When `false`, the `git cat-file` probes are skipped
 *   entirely and `commits_exist` comes back `false` meaning *not checked*.
 *   Callers that do not surface `commits_exist` should pass `false` so this
 *   stays a pure-filesystem check with no subprocess cost.
 */
function verifySummaryCore(
  cwd: string,
  summaryPath: string,
  checkFileCount?: number,
  opts?: { checkCommits?: boolean },
): SummaryVerification {
  const fullPath = path.join(cwd, summaryPath);
  const checkCount = checkFileCount || 2;
  const checkCommits = opts?.checkCommits !== false;

  if (!fs.existsSync(fullPath)) {
    return {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const errors: string[] = [];

  const projectRoot = path.resolve(cwd);

  /**
   * Is `candidate` plausibly a repo-relative file this check should probe?
   *
   * Deliberately narrowing. This is an ADVISORY, so the two error directions are
   * not symmetric: a false positive tells a user their healthy project is
   * missing a file that was never claimed, while a false negative just means one
   * reference goes unprobed. Every rejection below is a noise class confirmed on
   * #2685; when in doubt, skip rather than warn.
   */
  const isProbableProjectFile = (candidate: string): boolean => {
    // Only repo-relative paths — a bare filename is too ambiguous to locate.
    if (!candidate.includes('/')) return false;
    // URLs, protocol-relative links, and any other scheme.
    if (candidate.startsWith('http') || candidate.startsWith('//')) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return false;
    // Globs name a set, not a file: `src/**/*.cts` is never "missing".
    if (/[*?]/.test(candidate)) return false;
    // Bare hostnames (`docs.example.com/guide.html`). A repo-relative path's
    // first segment is a directory name, which in practice contains a dot only
    // when it is a dotfile directory (`.github/`, `.changeset/`, `.planning/`)
    // — i.e. the dot is at index 0. A dot anywhere later marks a hostname.
    const firstSegment = candidate.split('/')[0] || '';
    if (firstSegment.indexOf('.') > 0) return false;
    // Containment guard: a `../`-bearing reference must not turn this advisory
    // into a filesystem existence probe outside the project.
    const resolved = path.resolve(projectRoot, candidate);
    if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) return false;
    return true;
  };

  // Pattern 2 excludes `[` and `]` from its path class (#2685 Blocker 1). All
  // three SUMMARY templates prescribe a YAML flow sequence for `key-files`:
  //
  //     key-files:
  //       created: [src/auth/login.ts, src/auth/session.ts]
  //
  // and the label matches `(?:Created|Modified|…):` case-insensitively. Without
  // the bracket exclusion the class captures the literal `[` as part of the
  // first path, yielding `[src/auth/login.ts` — a candidate that can never exist
  // on disk. That fired on healthy projects built from GSD's own shipped
  // template. The exclusion also stops a markdown list in the body from
  // reintroducing the same artifact.
  //
  // Stripping frontmatter first was the other remedy offered on #2685. It is a
  // verified no-op on top of this exclusion — measured identical extraction
  // across all three shipped templates — because the exclusion already makes a
  // flow-sequence line contribute nothing. Consequence worth naming: the
  // `key-files` block, the most authoritative statement of what a phase created,
  // is still not read. Recovering it needs a real frontmatter parse, which is
  // deliberately left as a follow-up rather than smuggled in here.
  const mentionedFiles = new Set<string>();
  const patterns = [
    /`([^`]+\.[a-zA-Z]+)`/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*`?([^\s`[\]]+\.[a-zA-Z]+)`?/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const filePath = m[1];
      if (filePath && isProbableProjectFile(filePath)) {
        mentionedFiles.add(filePath);
      }
    }
  }

  const filesToCheck = Array.from(mentionedFiles).slice(0, checkCount);
  const missing: string[] = [];
  for (const file of filesToCheck) {
    if (!fs.existsSync(path.resolve(projectRoot, file))) {
      missing.push(file);
    }
  }

  const commitHashPattern = /\b[0-9a-f]{7,40}\b/g;
  const hashes = checkCommits ? content.match(commitHashPattern) || [] : [];
  let commitsExist = false;
  if (hashes.length > 0) {
    for (const hash of hashes.slice(0, 3)) {
      const result = execGit(['cat-file', '-t', hash], { cwd }) as unknown as { exitCode: number; stdout: string };
      if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
        commitsExist = true;
        break;
      }
    }
  }

  let selfCheck = 'not_found';
  const selfCheckPattern = /##\s*(?:Self[- ]?Check|Verification|Quality Check)/i;
  if (selfCheckPattern.test(content)) {
    const passPattern = /(?:all\s+)?(?:pass|✓|✅|complete|succeeded)/i;
    const failPattern = /(?:fail|✗|❌|incomplete|blocked)/i;
    const checkSection = content.slice(content.search(selfCheckPattern));
    if (failPattern.test(checkSection)) {
      selfCheck = 'failed';
    } else if (passPattern.test(checkSection)) {
      selfCheck = 'passed';
    }
  }

  if (missing.length > 0) errors.push('Missing files: ' + missing.join(', '));
  if (!commitsExist && hashes.length > 0)
    errors.push('Referenced commit hashes not found in git history');
  if (selfCheck === 'failed') errors.push('Self-check section indicates failure');

  const checks = {
    summary_exists: true,
    files_created: { checked: filesToCheck.length, found: filesToCheck.length - missing.length, missing },
    commits_exist: commitsExist,
    self_check: selfCheck,
  };

  const passed = missing.length === 0 && selfCheck !== 'failed';
  return { passed, checks, errors };
}

/** CLI adapter over verifySummaryCore — arg guard + output shaping only. */
function cmdVerifySummary(
  cwd: string,
  summaryPath: string,
  checkFileCount: number | undefined,
  raw: boolean,
): void {
  if (!summaryPath) {
    error('summary-path required');
  }
  const result = verifySummaryCore(cwd, summaryPath, checkFileCount);
  output(result, raw, result.passed ? 'passed' : 'failed');
}

/**
 * Issue #429 — negative-grep comment-text echo gate.
 * A literal that an acceptance criterion negative-greps for (grep -c 'LIT' file == 0)
 * must not also appear verbatim inside an <action> body, or the executor's commit-time
 * verify gate fails on the comment echo rather than a real regression. Conservative:
 * errors only on a confidently-extracted QUOTED literal; ambiguous (bareword) → warning.
 */
function scanNegativeGrepCommentEcho(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Normalize newlines; join backslash line-continuations so a verify command wrapped
  // across lines (grep ... \ <newline> == 0) is still seen as one segment.
  const text = (content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\\n/g, ' ');

  // 1. Allowlisted literals: <!-- planner-discipline-allow: LIT -->
  const allow = new Set<string>();
  const allowRe = /<!--\s*planner-discipline-allow:\s*(.+?)\s*-->/g;
  let am: RegExpExecArray | null;
  while ((am = allowRe.exec(text)) !== null) allow.add(am[1]);

  // Zero-equality comparison (the negative grep). The required leading whitespace
  // before the operator distinguishes a shell comparison (`[ $c == 0 ]`, `... == 0`,
  // always spaced) from an assignment (`VAR=0`, never spaced) and naturally excludes
  // `>= 0`, `<= 0`, `!= 0`, `!== 0`, `=== 0`.
  const zeroCmp = (s: string): boolean =>
    /\s==?\s*0\b/.test(s) || /-eq\s+0\b/.test(s) || /\bequals\s+0\b/.test(s);

  // A grep invocation using a count flag (-c / -cF / -Fc / --count), capturing the
  // search pattern (first quoted token, else first bareword) after a run of options.
  // The options run lets `grep -c -F 'LIT'`, `grep -F -c 'LIT'`, `grep -c -e 'LIT'`
  // and `grep --count 'LIT'` all resolve to the LIT pattern.
  const countGrepRe =
    /grep((?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+)\s+(?:'([^']*)'|"([^"]*)"|([^\s'"|>&;]+))/g;
  const optsHaveCount = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*c[A-Za-z]*(?=\s|$)/.test(opts) || /--count\b/.test(opts);
  // `grep -cv 'pat' == 0` counts NON-matching lines, so == 0 there asserts "all lines
  // match" — a POSITIVE gate, not our negative gate. Skip inverted greps.
  const optsHaveInvert = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*v[A-Za-z]*(?=\s|$)/.test(opts) || /--invert-match\b/.test(opts);
  // Bareword sanity: a real grep target, not a stray operator/number/flag.
  const plausibleBare = (s: string): boolean => /[A-Za-z0-9_]/.test(s) && !/^[-=!<>0-9]+$/.test(s);

  // 2. <action> text to scan, with negative-grep COMMAND SPANS removed (only the
  //    command, not the whole line) so a pasted verify command does not self-flag
  //    while a prose echo on the same line is still caught.
  const cmdSpanRe =
    /grep(?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+\s+(?:'[^']*'|"[^"]*"|[^\s'"|>&;]+)[^\n]*?(?:==|-eq|=)\s*0\b/g;
  // Security scan: must see the FULL text up to the first </action> — including a
  // malformed inner <action> — so a grep-echo-0 trick cannot hide behind a
  // deliberately-unclosed tag. Use a bounded to-first-close scan (ReDoS-safe via
  // the {0,20000} cap, #2128), NOT the stop-at-next-open extractTaggedBlocks seam
  // (which would drop the span before an unterminated inner <action>).
  const actionZones: string[] = [];
  const actionRe = /<action>([\s\S]{0,20000}?)<\/action>/g;
  let acm: RegExpExecArray | null;
  while ((acm = actionRe.exec(text)) !== null) actionZones.push(acm[1]);
  const scannableActionText = actionZones.map((zone) => zone.replace(cmdSpanRe, ' ')).join('\n');

  // 3. Per shell SEGMENT (split lines on && / ||) extract count-grep literals and
  //    check echoes. Per-segment splitting keeps a positive gate (`== 1`) from
  //    poisoning a negative gate (`== 0`) sharing the same physical line.
  const seenErr = new Set<string>();
  const seenWarn = new Set<string>();
  const segments = text.split('\n').flatMap((line) => line.split(/\s*(?:&&|\|\|)\s*/));
  for (const seg of segments) {
    if (!/grep(?:\s+-{1,2}[A-Za-z])/.test(seg) || !zeroCmp(seg)) continue;
    countGrepRe.lastIndex = 0;
    const quotedLits: string[] = [];
    const bareLits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = countGrepRe.exec(seg)) !== null) {
      if (!optsHaveCount(m[1]) || optsHaveInvert(m[1])) continue; // need count, not invert (-cv is positive)
      if (m[2] !== undefined) quotedLits.push(m[2]);
      else if (m[3] !== undefined) quotedLits.push(m[3]);
      else if (m[4] !== undefined && plausibleBare(m[4])) bareLits.push(m[4]);
    }
    for (const quoted of quotedLits) {
      if (!quoted || allow.has(quoted) || seenErr.has(quoted)) continue;
      if (scannableActionText.includes(quoted)) {
        seenErr.add(quoted);
        errors.push(
          `Plan body contains forbidden literal "${quoted}" in an <action> block, but an acceptance criterion negative-greps for it (grep -c ... == 0). Rephrase the literal by concept, remove it from the plan body, or add <!-- planner-discipline-allow: ${quoted} --> if it must legitimately appear.`,
        );
      }
    }
    if (quotedLits.length === 0) {
      for (const bare of bareLits) {
        if (allow.has(bare) || seenWarn.has(bare)) continue;
        if (scannableActionText.includes(bare)) {
          seenWarn.add(bare);
          warnings.push(
            `Possible comment-text echo (#429): negative-grep target "${bare}" is unquoted so its literal could not be extracted unambiguously, but it appears in an <action> block. Quote the grep literal and add an allowlist marker if the echo is intended, or rephrase by concept.`,
          );
        }
      }
    }
  }
  return { errors, warnings };
}

/**
 * Issue #968 — file-wide negative-grep sibling conflict detector.
 * A file-wide negative grep gate (! grep -Eq 'PAT' FILE or grep -c 'PAT' FILE == 0)
 * bans a construct across the WHOLE file. When a sibling task in the same plan
 * legitimately requires the same construct in the same file, the two gates are
 * mutually unsatisfiable. This is a WARN-only check (never changes valid:false).
 */
function scanFileWideNegativeGateConflict(content: string): { warnings: string[]; valid: true } {
  const warnings: string[] = [];

  // Normalize newlines; join backslash line-continuations (same as #429).
  const text = (content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\\n/g, ' ');

  // Allowlisted patterns: <!-- planner-region-allow: PAT -->
  const allow = new Set<string>();
  const allowRe = /<!--\s*planner-region-allow:\s*(.+?)\s*-->/g;
  let am: RegExpExecArray | null;
  while ((am = allowRe.exec(text)) !== null) allow.add(am[1]);

  // Helper predicates (reused from #429 style).
  // Zero-equality comparison: spaced == 0 or -eq 0.
  const zeroCmp = (s: string): boolean =>
    /\s==?\s*0\b/.test(s) || /-eq\s+0\b/.test(s) || /\bequals\s+0\b/.test(s);

  // grep options include -c / --count
  const optsHaveCount = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*c[A-Za-z]*(?=\s|$)/.test(opts) || /--count\b/.test(opts);

  // grep options include -v / --invert-match (inverted count is NOT a negative gate)
  const optsHaveInvert = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*v[A-Za-z]*(?=\s|$)/.test(opts) || /--invert-match\b/.test(opts);

  // A bareword that is a plausible grep pattern (not a stray flag/number).
  const plausibleBare = (s: string): boolean => /[A-Za-z0-9_]/.test(s) && !/^[-=!<>0-9]+$/.test(s);

  // Regex to extract grep arguments: opts run then PAT (quoted or bare).
  const grepArgRe =
    /grep((?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+)\s+(?:'([^']*)'|"([^"]*)"|([^\s'"|>&;$()\[\]]+))/g;

  // FIX 1 (ReDoS): Linear-time "does reqText satisfy the grep pattern" — no RegExp execution.
  // Never calls new RegExp, so no catastrophic backtracking is possible.
  //
  // Handles literal patterns and `.`/`.*/`.+`/`\s`-style wildcard gaps and `^`/`$` anchors.
  // Patterns using character classes (`[…]`), alternation (`a|b`), or other regex constructs
  // fall back to a conservative literal-substring check, so the detector may NOT warn on those
  // (false-negative is the safe direction for a warn-only advisory).
  const patternRequiredIn = (pat: string, reqText: string): boolean => {
    const hay = (reqText || '').slice(0, 8000); // bound the haystack
    if (!pat) return false;
    // Strip ERE anchors — position constraints don't change whether the construct is required.
    pat = pat.replace(/^\^/, '').replace(/\$$/, '');
    if (!pat) return false;
    // Pure literal (no regex metacharacters): direct substring.
    if (!/[.*+?^${}()|[\]\\]/.test(pat)) return hay.includes(pat);
    const SENT = ' ';
    // Replace simple wildcard gaps (\s* \w+ .* .+ .? bare .) with a sentinel.
    let work = pat
      .replace(/\\[sSwWdD][*+?]?/g, SENT)
      .replace(/\.[*+?]/g, SENT)
      .replace(/\./g, SENT);
    work = work.replace(/\\(.)/g, '$1'); // de-escape \( \. etc → literal char
    const joined = work.split(SENT).join('');
    // Unhandled regex constructs remain → safe literal-substring fallback on the raw pattern.
    if (/[*+?^${}()|[\]]/.test(joined)) return hay.includes(pat);
    const frags = work.split(SENT).filter(Boolean);
    if (!frags.length) return false; // all-wildcard pattern → no meaningful requirement
    let pos = 0;
    for (const f of frags) {
      const idx = hay.indexOf(f, pos);
      if (idx === -1) return false;
      pos = idx + f.length;
    }
    return true;
  };

  // FIX 2 (file basename over-match): exact normalized match; basename fallback ONLY for
  // unqualified gate files (no path separator).
  const normPath = (p: string): string => p.replace(/^\.\//, '').trim();

  // File-wide discriminator: a token AFTER PAT that looks like a path.
  // Paths have /, a file extension, or match a known task <files> entry.
  // Globs (containing *) are excluded (unresolvable — no warn).
  const looksLikePath = (token: string): boolean =>
    !token.includes('*') &&
    (token.includes('/') || /\.[a-zA-Z]{1,6}$/.test(token));

  // FIX 5 (hasLeadingNot): collapse to one command-boundary-anchored regex.
  // Negation at a command boundary: start of segment, or after ; & | ( newline / then / do.

  // FIX 4 (isRegionScoped tightened): return true ONLY when grep is downstream of a
  // sed line-range or awk range producer. Other pipe sources (cat, tac, etc.) are file-wide.
  const isRegionScoped = (seg: string): boolean => {
    if (!seg.includes('|')) return false;
    const before = seg.slice(0, seg.lastIndexOf('|'));
    // sed -n line/range extraction, e.g. sed -n '12,40p' FILE  or  sed -n '/a/,/b/p' FILE
    if (/\bsed\s+-n\b/.test(before)) return true;
    // awk range pattern, e.g. awk '/start/,/end/' FILE
    if (/\bawk\b[^|]*\/[^/]*\/\s*,\s*\/[^/]*\//.test(before)) return true;
    return false;
  };

  // Parse all <task> blocks.
  interface TaskInfo {
    name: string;
    files: string[];   // entries from <files>
    gateText: string;  // <verify>+<automated>+<acceptance_criteria> text
    reqText: string;   // <action>+<acceptance_criteria> text (requirement side)
  }
  const tasks: TaskInfo[] = [];
  for (const tc of extractTaggedBlocks(text, 'task', true)) {
    // Extract task name.
    const namem = extractTaggedBlocks(tc, 'name');
    const name = namem.length ? namem[0].trim() : 'unnamed';
    // Extract <files> entries.
    const filesArr = extractTaggedBlocks(tc, 'files');
    const filesText = filesArr.length ? filesArr[0] : '';
    const files = filesText.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    // Gate text: <verify>/<automated>/<acceptance_criteria>.
    const gateFragments: string[] = [];
    for (const tag of ['verify', 'automated', 'acceptance_criteria']) gateFragments.push(...extractTaggedBlocks(tc, tag));
    // Requirement text: <action>/<acceptance_criteria>.
    const reqFragments: string[] = [];
    for (const tag of ['action', 'acceptance_criteria']) reqFragments.push(...extractTaggedBlocks(tc, tag));
    // Strip XML tags from gate text so segments containing embedded
    // XML closing tags (e.g. <automated>cmd</automated> nested inside <verify>)
    // don't bleed into the file-path token extraction.
    const rawGateText = gateFragments.join('\n');
    const gateText = rawGateText.replace(/<[^>]+>/g, ' ');
    tasks.push({
      name,
      files,
      gateText,
      reqText: reqFragments.join('\n'),
    });
  }

  if (tasks.length < 2) return { warnings, valid: true };

  // FIX 3 (extensionless known files): build a normalized set of ALL tasks' <files> entries
  // so that extensionless filenames like Dockerfile are also recognized as valid file tokens.
  const knownFiles = new Set<string>();
  for (const t of tasks) {
    for (const f of t.files) knownFiles.add(normPath(f));
  }

  // Extended looksLikePath: accepts known <files> entries even without an extension.
  const isFileLike = (token: string): boolean => {
    if (token.includes('*')) return false; // exclude globs
    if (looksLikePath(token)) return true;
    return knownFiles.has(normPath(token));
  };

  // Dedup key: (taskAIdx, taskBIdx, pat, file)
  const seen = new Set<string>();

  // For each task A, scan gate text for file-wide negative grep bans.
  for (let ai = 0; ai < tasks.length; ai++) {
    const taskA = tasks[ai];

    // Split gate text into shell segments (split on && / || within lines).
    const segments = taskA.gateText.split('\n').flatMap(line =>
      line.split(/\s*(?:&&|\|\|)\s*/),
    );

    for (const seg of segments) {
      if (!/grep/.test(seg)) continue;

      // FIX 5: Negation at a command boundary: start of segment, or after ; & | ( newline / then / do.
      // Also handles ! negating an entire pipeline (e.g. ! cat FILE | grep ...).
      const hasLeadingNot =
        // Direct ! grep: negation immediately before grep keyword
        /(?:^|[\n;&|(]|\bthen\b|\bdo\b)\s*!\s*grep/.test(seg) ||
        // Pipeline negation: ! at command boundary, grep appears in pipeline after |
        (/(?:^|[\n;&|(]|\bthen\b|\bdo\b)\s*!\s*\w/.test(seg) && /\|\s*grep\b/.test(seg));

      const hasCountZero = zeroCmp(seg);

      // Extract grep invocation and check for count.
      grepArgRe.lastIndex = 0;
      let pat: string | null = null;
      let file: string | null = null;
      let isBan = false;

      // FIX 4 helper: given a segment and the grep match end position, find the
      // file argument. First try the token immediately after PAT; if none qualifies,
      // try a cat/tac producer or < FILE redirect from the full segment.
      const resolveFileArg = (segment: string, afterPatStr: string): string | null => {
        // Primary: token immediately after PAT in the grep command
        const fileM = afterPatStr.match(/^\s+([^\s'"|>&;$()\[\]]+)/);
        const rawFile = fileM ? fileM[1] : null;
        if (rawFile && isFileLike(rawFile)) return rawFile;
        // FIX 4: For NON-region segments, also look for cat/tac producer or < FILE redirect
        const catM = segment.match(/\b(?:cat|tac)\s+([^\s'"|>&;()]+)/);
        if (catM && isFileLike(catM[1])) return catM[1];
        const redirM = segment.match(/<\s*([^\s'"|>&;()]+)/);
        if (redirM && isFileLike(redirM[1])) return redirM[1];
        return null;
      };

      // If leading !, it might be a count or a direct !grep
      if (hasLeadingNot && !hasCountZero) {
        // Direct ! grep PAT FILE form: grep opts PAT FILE
        // Extract PAT and FILE from the grep invocation
        grepArgRe.lastIndex = 0;
        let gm: RegExpExecArray | null;
        while ((gm = grepArgRe.exec(seg)) !== null) {
          const opts = gm[1];
          if (optsHaveInvert(opts)) continue; // -v form: not a ban
          // PAT
          const rawPat = gm[2] !== undefined ? gm[2] :
                         gm[3] !== undefined ? gm[3] :
                         gm[4] !== undefined && plausibleBare(gm[4]) ? gm[4] : null;
          if (!rawPat) continue;
          // FILE: next non-option token after PAT (or cat/tac/redirect in segment)
          const afterPat = seg.slice((gm.index || 0) + gm[0].length);
          const rawFile = resolveFileArg(seg, afterPat);
          if (rawFile) {
            pat = rawPat;
            file = rawFile;
            isBan = true;
          }
        }
      }

      if (!isBan && hasCountZero) {
        // count grep form: grep -c PAT FILE == 0 or [ $(grep -c PAT FILE) -eq 0 ]
        grepArgRe.lastIndex = 0;
        let gm: RegExpExecArray | null;
        while ((gm = grepArgRe.exec(seg)) !== null) {
          const opts = gm[1];
          if (!optsHaveCount(opts) || optsHaveInvert(opts)) continue;
          const rawPat = gm[2] !== undefined ? gm[2] :
                         gm[3] !== undefined ? gm[3] :
                         gm[4] !== undefined && plausibleBare(gm[4]) ? gm[4] : null;
          if (!rawPat) continue;
          const afterPat = seg.slice((gm.index || 0) + gm[0].length);
          const rawFile = resolveFileArg(seg, afterPat);
          if (rawFile) {
            pat = rawPat;
            file = rawFile;
            isBan = true;
          }
        }
      }

      if (!isBan || !pat || !file) continue;
      if (allow.has(pat)) continue;
      // Skip if region-scoped (grep downstream of a sed/awk pipe — region extracted)
      if (isRegionScoped(seg)) continue;

      // For each other task B: check if B's <files> includes FILE AND B's reqText contains PAT
      for (let bi = 0; bi < tasks.length; bi++) {
        if (bi === ai) continue;
        const taskB = tasks[bi];

        // FIX 2: Exact normalized match; basename fallback ONLY for unqualified gate files.
        const gateFile = normPath(file);
        const bMatchesFile = taskB.files.some((bf) => {
          const nbf = normPath(bf);
          if (nbf === gateFile) return true;
          // basename fallback only when the gate file is an unqualified bare filename (no dir separator)
          if (!gateFile.includes('/') && path.basename(nbf) === gateFile) return true;
          return false;
        });
        if (!bMatchesFile) continue;

        // FIX 1: Use linear-time patternRequiredIn instead of new RegExp (ReDoS-safe).
        const bRequiresPat = patternRequiredIn(pat, taskB.reqText);
        if (!bRequiresPat) continue;

        const dedupeKey = `${ai}:${bi}:${pat}:${file}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        warnings.push(
          `Region-scope conflict (#968): task "${taskA.name}" negative-greps "${pat}" file-wide on ${file}, ` +
          `but sibling task "${taskB.name}" requires it in the same file. ` +
          `A file-wide ban is unsatisfiable when a sibling needs the construct elsewhere — ` +
          `region-scope task "${taskA.name}"'s gate (sed -n/awk range then grep) or use an AST/test check. ` +
          `See planner-antipatterns.md "Region-Scoped Negative Gates", or add ` +
          `<!-- planner-region-allow: ${pat} --> if intentional.`,
        );
      }
    }
  }

  // This detector is warn-only: it never sets valid=false.
  return { warnings, valid: true as const };
}

// ─── Plan-task structure validation (#2444) ──────────────────────────────────

/**
 * Per-task structural information extracted from a PLAN.md `<tasks>` block.
 * Captures the task's `type` attribute (so `checkpoint:*` tasks validate
 * against their type-specific canonical field set per
 * `gsd-core/references/checkpoints.md`) plus presence flags for every tag the
 * validator cares about. Pure data — no I/O.
 */
interface PlanTaskInfo {
  name: string;
  /** Lowercased `type` attribute value, or '' when the opening tag has no type. */
  type: string;
  hasName: boolean;
  // auto-task fields
  hasFiles: boolean;
  hasAction: boolean;
  hasVerify: boolean;
  hasDone: boolean;
  // checkpoint:human-verify fields
  hasWhatBuilt: boolean;
  hasHowToVerify: boolean;
  // checkpoint:decision fields
  hasDecision: boolean;
  hasOptions: boolean;
  // checkpoint:human-action fields
  hasInstructions: boolean;
  hasVerification: boolean;
  // cross-checkpoint common
  hasResumeSignal: boolean;
}

/**
 * Single pass over `<task ...>…</task>` blocks. The body pattern is
 * ReDoS-safe stop-at-next-open (mirrors `taggedBlockPattern` in
 * markdown-sectionizer.cts): bounded attributes (`[^>]{0,1000}`) and a body
 * boundary that terminates at the NEXT `<task[\s>]` opening, so a document
 * full of unclosed `<task>` openings scans linearly. Captures both the
 * attribute string (group 1, so the `type=` selector is not lost the way it is
 * with `extractTaggedBlocks`) and the body (group 2).
 */
const PLAN_TASK_BLOCK_RE = /<task(\s[^>]{0,1000})?>((?:(?!<task[\s>])[\s\S])*?)<\/task>/g;

/**
 * Extract one `PlanTaskInfo` per `<task …>…</task>` block in `content`.
 *
 * Why a dedicated regex instead of `extractTaggedBlocks('task', true)`:
 * `extractTaggedBlocks` discards the opening tag, so the task's `type=`
 * attribute (which selects the validation branch) is lost. This helper
 * captures both the attribute string and the body in one pass, then reuses
 * `extractTaggedBlocks` on the body for sub-element extraction.
 */
function extractPlanTaskInfos(content: string): PlanTaskInfo[] {
  const infos: PlanTaskInfo[] = [];
  if (typeof content !== 'string' || content.length === 0) return infos;

  PLAN_TASK_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAN_TASK_BLOCK_RE.exec(content)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';

    const typeMatch = attrs.match(/\btype\s*=\s*["']?([\w:-]+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';

    const nameArr = extractTaggedBlocks(body, 'name');
    const hasName = nameArr.length > 0;
    const name = hasName ? nameArr[0].trim() : '';

    infos.push({
      name,
      type,
      hasName,
      hasFiles: /<files>/.test(body),
      hasAction: /<action>/.test(body),
      hasVerify: /<verify>/.test(body),
      hasDone: /<done>/.test(body),
      hasWhatBuilt: /<what-built>/.test(body),
      hasHowToVerify: /<how-to-verify>/.test(body),
      hasDecision: /<decision>/.test(body),
      hasOptions: /<options>/.test(body),
      hasInstructions: /<instructions>/.test(body),
      hasVerification: /<verification>/.test(body),
      hasResumeSignal: /<resume-signal>/.test(body),
    });

    // Guard against zero-length matches looping forever.
    if (match.index === PLAN_TASK_BLOCK_RE.lastIndex) {
      PLAN_TASK_BLOCK_RE.lastIndex++;
    }
  }
  return infos;
}

function isCheckpointType(type: string): boolean {
  return type.startsWith('checkpoint:');
}

/**
 * Validate one plan task's structure against its type-specific canonical field
 * set (per `gsd-core/references/checkpoints.md`):
 *   - `checkpoint:human-verify` requires `<what-built>` / `<how-to-verify>` /
 *      `<resume-signal>` (the "checkpoint triple").
 *   - `checkpoint:decision` requires `<decision>` / `<options>` /
 *      `<resume-signal>`.
 *   - `checkpoint:human-action` requires `<action>` / `<instructions>` /
 *      `<verification>` / `<resume-signal>`.
 *   - Unknown `checkpoint:*` subtypes require only the universal
 *      `<resume-signal>` (forward-compat — newer checkpoint types registered
 *      in the reference don't need a verifier change to pass structure
 *      validation).
 *   - All other types (`auto`, `tracer`, `manual`, bare `<task>`, …) keep the
 *      historical `<action>` / `<verify>` / `<done>` / `<files>` requirements.
 */
function validatePlanTaskStructure(task: PlanTaskInfo): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskName = task.hasName ? task.name : 'unnamed';

  if (!task.hasName) {
    errors.push('Task missing <name> element');
  }

  if (isCheckpointType(task.type)) {
    if (!task.hasResumeSignal) {
      errors.push(`Task '${taskName}' missing <resume-signal>`);
    }
    switch (task.type) {
      case 'checkpoint:human-verify':
        if (!task.hasWhatBuilt) errors.push(`Task '${taskName}' missing <what-built>`);
        if (!task.hasHowToVerify) errors.push(`Task '${taskName}' missing <how-to-verify>`);
        break;
      case 'checkpoint:decision':
        if (!task.hasDecision) errors.push(`Task '${taskName}' missing <decision>`);
        if (!task.hasOptions) errors.push(`Task '${taskName}' missing <options>`);
        break;
      case 'checkpoint:human-action':
        if (!task.hasAction) errors.push(`Task '${taskName}' missing <action>`);
        if (!task.hasInstructions) errors.push(`Task '${taskName}' missing <instructions>`);
        if (!task.hasVerification) errors.push(`Task '${taskName}' missing <verification>`);
        break;
      default:
        // Unknown checkpoint:* subtype: <resume-signal> is the only universal
        // requirement (forward-compat).
        break;
    }
  } else {
    if (!task.hasAction) errors.push(`Task '${taskName}' missing <action>`);
    if (!task.hasVerify) warnings.push(`Task '${taskName}' missing <verify>`);
    if (!task.hasDone) warnings.push(`Task '${taskName}' missing <done>`);
    if (!task.hasFiles) warnings.push(`Task '${taskName}' missing <files>`);
  }

  return { errors, warnings };
}

function cmdVerifyPlanStructure(cwd: string, filePath: string, raw: boolean): void {
  if (!filePath) {
    error('file path required');
  }
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath }, raw);
    return;
  }

  // #2701: fail loud on NUL/binary corruption before structure checks. A
  // structurally intact-but-NUL-corrupted plan otherwise passes as valid and is
  // silently skipped by recursive/binary-skipping searchers downstream.
  const encErr = textEncodingError(content, filePath);
  if (encErr) {
    output({ valid: false, errors: [encErr] }, raw);
    return;
  }

  const fm = extractFrontmatter(content, fullPath);
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];
  for (const field of required) {
    if (fm[field] === undefined) errors.push(`Missing required frontmatter field: ${field}`);
  }

  const extractedTasks = extractPlanTaskInfos(content);
  const tasks: Record<string, unknown>[] = [];
  for (const task of extractedTasks) {
    const verdict = validatePlanTaskStructure(task);
    errors.push(...verdict.errors);
    warnings.push(...verdict.warnings);
    tasks.push({
      name: task.hasName ? task.name : 'unnamed',
      type: task.type,
      hasFiles: task.hasFiles,
      hasAction: task.hasAction,
      hasVerify: task.hasVerify,
      hasDone: task.hasDone,
    });
  }

  if (tasks.length === 0) warnings.push('No <task> elements found');

  if (
    fm['wave'] &&
    parseInt(fm['wave'] as string) > 1 &&
    (!fm['depends_on'] ||
      (Array.isArray(fm['depends_on']) && (fm['depends_on'] as unknown[]).length === 0))
  ) {
    warnings.push('Wave > 1 but depends_on is empty');
  }

  const hasCheckpoints = /<task\s+type=["']?checkpoint/.test(content);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
  if (hasCheckpoints && fm['autonomous'] !== 'false' && String(fm['autonomous']) !== 'false') {
    errors.push('Has checkpoint tasks but autonomous is not false');
  }

  // #1951: a decision rated one-way is supposed to be confirmed before it is
  // walked through. Warn (never error — <reversibility> stays additive) when a
  // one-way rating has no checkpoint:decision anywhere ahead of it in the plan,
  // which is the planner emitting the rating but skipping the gate.
  const decisionCheckpointOffsets: number[] = [];
  for (const m of content.matchAll(/<task\s+type=["']?checkpoint:decision/g)) {
    if (m.index !== undefined) decisionCheckpointOffsets.push(m.index);
  }
  for (const m of content.matchAll(/<reversibility\s[^>]*rating=["']?one-way/g)) {
    const at = m.index;
    if (at === undefined) continue;
    if (!decisionCheckpointOffsets.some((offset) => offset < at)) {
      warnings.push(
        'Task rated <reversibility rating="one-way"> has no preceding checkpoint:decision — '
          + 'a one-way door must be confirmed before the agent walks through it',
      );
    }
  }

  const echoScan = scanNegativeGrepCommentEcho(content);
  errors.push(...echoScan.errors);
  warnings.push(...echoScan.warnings);

  const conflictScan = scanFileWideNegativeGateConflict(content);
  warnings.push(...conflictScan.warnings);

  output(
    {
      valid: errors.length === 0,
      errors,
      warnings,
      task_count: tasks.length,
      tasks,
      frontmatter_fields: Object.keys(fm),
    },
    raw,
    errors.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyPhaseCompleteness(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required');
  }
  const phaseInfoRaw = findPhaseInternal(cwd, phase);
  if (!phaseInfoRaw || !(phaseInfoRaw as unknown as Record<string, unknown>)['found']) {
    output({ error: 'Phase not found', phase }, raw);
    return;
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;

  const errors: string[] = [];
  const warnings: string[] = [];
  const phaseDir = path.join(cwd, phaseInfo['directory'] as string);

  let files: string[];
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    output({ error: 'Cannot read phase directory' }, raw);
    return;
  }

  const plans = files.filter((f) => f.match(/-PLAN\.md$/i));
  const summaries = files.filter((f) => f.match(/-SUMMARY\.md$/i));

  const planIds = new Set(plans.map((p) => p.replace(/-PLAN\.md$/i, '')));
  const summaryIds = new Set(summaries.map((s) => s.replace(/-SUMMARY\.md$/i, '')));

  const incompletePlans = [...planIds].filter((id) => !summaryIds.has(id));
  if (incompletePlans.length > 0) {
    errors.push(`Plans without summaries: ${incompletePlans.join(', ')}`);
  }

  const orphanSummaries = [...summaryIds].filter((id) => !planIds.has(id));
  if (orphanSummaries.length > 0) {
    warnings.push(`Summaries without plans: ${orphanSummaries.join(', ')}`);
  }

  output(
    {
      complete: errors.length === 0,
      phase: phaseInfo['phase_number'],
      plan_count: plans.length,
      summary_count: summaries.length,
      incomplete_plans: incompletePlans,
      orphan_summaries: orphanSummaries,
      errors,
      warnings,
    },
    raw,
    errors.length === 0 ? 'complete' : 'incomplete',
  );
}

function cmdVerifyReferences(cwd: string, filePath: string, raw: boolean): void {
  if (!filePath) {
    error('file path required');
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath }, raw);
    return;
  }

  const found: string[] = [];
  const missing: string[] = [];

  const atRefs = content.match(/@([^\s\n,)]+\/[^\s\n,)]+)/g) || [];
  for (const ref of atRefs) {
    const cleanRef = ref.slice(1);
    const resolved = cleanRef.startsWith('~/')
      ? path.join(process.env['HOME'] || '', cleanRef.slice(2))
      : path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  const backtickRefs = content.match(/`([^`]+\/[^`]+\.[a-zA-Z]{1,10})`/g) || [];
  for (const ref of backtickRefs) {
    const cleanRef = ref.slice(1, -1);
    if (cleanRef.startsWith('http') || cleanRef.includes('${') || cleanRef.includes('{{')) continue;
    if (found.includes(cleanRef) || missing.includes(cleanRef)) continue;
    const resolved = path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  output(
    {
      valid: missing.length === 0,
      found: found.length,
      missing,
      total: found.length + missing.length,
    },
    raw,
    missing.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyCommits(cwd: string, hashes: string[], raw: boolean): void {
  if (!hashes || hashes.length === 0) {
    error('At least one commit hash required');
  }

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const hash of hashes) {
    const result = execGit(['cat-file', '-t', hash], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
      valid.push(hash);
    } else {
      invalid.push(hash);
    }
  }

  output(
    {
      all_valid: invalid.length === 0,
      valid,
      invalid,
      total: hashes.length,
    },
    raw,
    invalid.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyArtifacts(cwd: string, planFilePath: string, raw: boolean): void {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath }, raw);
    return;
  }

  const artifacts = parseMustHavesBlock(content, 'artifacts') as Record<string, unknown>[];
  if (artifacts.length === 0) {
    output({ error: 'No must_haves.artifacts found in frontmatter', path: planFilePath }, raw);
    return;
  }

  const results: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    if (typeof artifact === 'string') continue;
    const artPath = artifact['path'] as string | undefined;
    if (!artPath) continue;

    const artFullPath = path.join(cwd, artPath);
    const exists = fs.existsSync(artFullPath);
    const check: Record<string, unknown> = { path: artPath, exists, issues: [], passed: false };

    if (exists) {
      const fileContent = safeReadFile(artFullPath) || '';
      const lineCount = fileContent.split('\n').length;

      if (artifact['min_lines'] && lineCount < (artifact['min_lines'] as number)) {
        (check['issues'] as string[]).push(`Only ${lineCount} lines, need ${artifact['min_lines'] as number}`);
      }
      if (artifact['contains'] && !fileContent.includes(artifact['contains'] as string)) {
        (check['issues'] as string[]).push(`Missing pattern: ${artifact['contains'] as string}`);
      }
      if (artifact['exports']) {
        const exports = Array.isArray(artifact['exports'])
          ? artifact['exports']
          : [artifact['exports']];
        for (const exp of exports) {
          if (!fileContent.includes(exp as string)) (check['issues'] as string[]).push(`Missing export: ${exp as string}`);
        }
      }
      check['passed'] = (check['issues'] as string[]).length === 0;
    } else {
      (check['issues'] as string[]).push('File not found');
    }

    results.push(check);
  }

  const passed = results.filter((r) => r['passed']).length;
  output(
    {
      all_passed: passed === results.length,
      passed,
      total: results.length,
      artifacts: results,
    },
    raw,
    passed === results.length ? 'valid' : 'invalid',
  );
}

/**
 * Returns a Set of file paths (relative to cwd) that are promised by plans in
 * the same phase directory at a wave number >= minWave.
 *
 * Used by cmdVerifyKeyLinks to avoid hard-failing a missing `from:` file that
 * is a planned future artifact (fix #1202).
 */
function collectPromisedFilesAtOrAfterWave(phaseDir: string, minWave: number): Set<string> {
  const promised = new Set<string>();
  const { planFiles } = planScanMod.scanPhasePlans(phaseDir);
  for (const planFile of planFiles) {
    const planFullPath = path.join(phaseDir, planFile);
    const planContent = safeReadFile(planFullPath);
    if (!planContent) continue;
    const fm = extractFrontmatter(planContent, planFullPath);
    const waveRaw = fm['wave'];
    const wave = typeof waveRaw === 'string' ? parseInt(waveRaw, 10) : (typeof waveRaw === 'number' ? waveRaw : NaN);
    if (isNaN(wave) || wave < minWave) continue;
    const filesModified = fm['files_modified'];
    if (!filesModified) continue;
    const files: unknown[] = Array.isArray(filesModified)
      ? filesModified
      : (typeof filesModified === 'string' ? [filesModified] : []);
    for (const f of files) {
      if (typeof f === 'string' && f.trim()) promised.add(f.trim());
    }
  }
  return promised;
}

function cmdVerifyKeyLinks(cwd: string, planFilePath: string, raw: boolean): void {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath }, raw);
    return;
  }

  const keyLinks = parseMustHavesBlock(content, 'key_links') as Record<string, unknown>[];
  if (keyLinks.length === 0) {
    output({ error: 'No must_haves.key_links found in frontmatter', path: planFilePath }, raw);
    return;
  }

  // Derive the current plan's wave number and phase directory for wave-aware
  // missing-file handling (fix #1202).
  const currentFm = extractFrontmatter(content, fullPath);
  const currentWaveRaw = currentFm['wave'];
  const currentWave = typeof currentWaveRaw === 'string'
    ? parseInt(currentWaveRaw, 10)
    : (typeof currentWaveRaw === 'number' ? currentWaveRaw : 1);
  const phaseDir = path.dirname(fullPath);

  // Collect files promised by plans at wave >= currentWave (lazy: computed once
  // the first time a missing source is encountered).
  let promisedFiles: Set<string> | null = null;
  function getPromisedFiles(): Set<string> {
    if (promisedFiles === null) {
      promisedFiles = collectPromisedFilesAtOrAfterWave(phaseDir, isNaN(currentWave) ? 1 : currentWave);
    }
    return promisedFiles;
  }

  const results: Record<string, unknown>[] = [];
  let pendingCount = 0;
  for (const link of keyLinks) {
    if (typeof link === 'string') continue;
    const check: Record<string, unknown> = {
      from: link['from'],
      to: link['to'],
      via: link['via'] || '',
      verified: false,
      detail: '',
    };

    const fromPath = (link['from'] as string) || '';
    const sourceContent = safeReadFile(path.join(cwd, fromPath));
    if (!sourceContent) {
      // Check if the missing file is promised by a plan at the same or later wave.
      const promised = getPromisedFiles();
      const isPromised = fromPath.trim() !== '' && promised.has(fromPath.trim());
      if (isPromised) {
        check['pending'] = true;
        check['detail'] = 'Source file not yet created — declared in files_modified of a same-or-later-wave plan';
        pendingCount++;
      } else {
        check['detail'] = 'Source file not found (from: must be a relative file path; describe components/endpoints in via:)';
      }
    } else if (link['pattern']) {
      try {
        const regex = new RegExp(link['pattern'] as string);
        if (regex.test(sourceContent)) {
          check['verified'] = true;
          check['detail'] = 'Pattern found in source';
        } else {
          const targetContent = safeReadFile(path.join(cwd, (link['to'] as string) || ''));
          if (targetContent && regex.test(targetContent)) {
            check['verified'] = true;
            check['detail'] = 'Pattern found in target';
          } else {
            check['detail'] = `Pattern "${link['pattern'] as string}" not found in source or target`;
          }
        }
      } catch {
        check['detail'] = `Invalid regex pattern: ${link['pattern'] as string}`;
      }
    } else {
      if (sourceContent.includes((link['to'] as string) || '')) {
        check['verified'] = true;
        check['detail'] = 'Target referenced in source';
      } else {
        check['detail'] = 'Target not referenced in source';
      }
    }

    results.push(check);
  }

  const verified = results.filter((r) => r['verified']).length;
  // A pending link (from: file promised by a same-or-later-wave plan) is not a
  // hard failure — it should not count against the all_verified gate (#1202).
  const hardFailed = results.filter((r) => !r['verified'] && !r['pending']).length;
  const allVerified = hardFailed === 0;
  output(
    {
      all_verified: allVerified,
      verified,
      pending: pendingCount,
      total: results.length,
      links: results,
    },
    raw,
    allVerified ? 'valid' : 'invalid',
  );
}

function listMilestoneArchiveDirs(planBase: string): string[] {
  const milestonesDir = path.join(planBase, 'milestones');
  try {
    return fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && MILESTONE_ARCHIVE_DIR_RE.test(e.name))
      .map((e) => path.join(milestonesDir, e.name))
      .sort((a, b) =>
        path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }),
      );
  } catch (err) {
    // #1883: distinguish genuine absence from a permission/I-O failure. ENOENT
    // (no milestones/ dir yet) keeps the long-standing [] contract that
    // collectPhaseRoots / forEachArchivedPhaseToken depend on for "no archives";
    // every other error (EACCES, EIO, …) must propagate — otherwise an unreadable
    // milestones/ dir is silently reported as "no archives" and active-milestone
    // resolution / archived-phase filtering misbehaves.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function forEachArchivedPhaseToken(planBase: string, onPhase: (token: string) => void): void {
  for (const archiveDir of listMilestoneArchiveDirs(planBase)) {
    try {
      const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(PHASE_TOKEN_FROM_DIR_RE);
        if (m) onPhase(m[1]);
      }
    } catch {
      /* archive dir absent/unreadable */
    }
  }
}

function getActiveMilestoneArchiveDir(planBase: string): string | null {
  const archiveDirs = listMilestoneArchiveDirs(planBase);
  if (archiveDirs.length === 0) return null;

  try {
    const statePath = path.join(planBase, 'STATE.md');
    if (fs.existsSync(statePath)) {
      const state = fs.readFileSync(statePath, 'utf-8');
      const m = state.match(
        /^\s*(?:\*\*)?milestone(?:\*\*)?:\s*\*{0,2}\s*([^\s*\r\n#][^\s\r\n#]*)/mi,
      );
      if (m && m[1]) {
        const milestone = m[1].trim();
        const candidate = path.join(planBase, 'milestones', `${milestone}-phases`);
        return archiveDirs.includes(candidate) ? candidate : null;
      }
    }
  } catch {
    /* intentionally empty — fall through to version-sort below */
  }

  return archiveDirs[archiveDirs.length - 1];
}

function collectPhaseRoots(planBase: string): string[] {
  const roots: string[] = [];
  const flatPhasesDir = path.join(planBase, 'phases');
  if (fs.existsSync(flatPhasesDir)) roots.push(flatPhasesDir);
  const activeArchive = getActiveMilestoneArchiveDir(planBase);
  if (activeArchive) roots.push(activeArchive);
  return roots;
}

function collectDiskPhases(planBase: string): Set<string> {
  const diskPhases = new Set<string>();
  const phaseRoots = collectPhaseRoots(planBase);
  const scanDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const m = e.name.match(PHASE_TOKEN_FROM_DIR_RE);
          if (m) diskPhases.add(m[1]);
        }
      }
    } catch {
      /* dir absent */
    }
  };

  for (const root of phaseRoots) scanDir(root);

  return diskPhases;
}

interface MilestoneMismatch {
  phaseId: string;
  foundInMilestone: string;
  expectedMilestone: string;
}

function checkMilestonePrefixMismatches(
  roadmapContent: string,
  { getMilestoneFromPhaseId }: { getMilestoneFromPhaseId: (id: string) => string | null },
): MilestoneMismatch[] {
  const mismatches: MilestoneMismatch[] = [];
  const sections: { version: string; start: number; end: number }[] = [];
  const sectionRx = /^#{1,3}\s+(?:\[[^\]]{1,200}\]\s*)?.*v(\d+\.\d+)/gim;
  let m: RegExpExecArray | null;
  while ((m = sectionRx.exec(roadmapContent)) !== null) {
    if (sections.length > 0) sections[sections.length - 1].end = m.index;
    sections.push({ version: `v${m[1]}`, start: m.index, end: roadmapContent.length });
  }
  for (const section of sections) {
    const content = roadmapContent.slice(section.start, section.end);
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    const phaseRx = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRx.exec(content)) !== null) {
      const phaseId = pm[1];
      const expectedMilestone = getMilestoneFromPhaseId(phaseId);
      if (expectedMilestone !== null && expectedMilestone !== section.version) {
        mismatches.push({
          phaseId,
          foundInMilestone: section.version,
          expectedMilestone,
        });
      }
    }
  }
  return mismatches;
}

interface IssueEntry {
  code: string;
  message: string;
  fix: string;
  repairable: boolean;
}

function cmdValidateConsistency(cwd: string, raw: boolean): void {
  const planBase = planningDir(cwd);
  const roadmapPath = path.join(planBase, 'ROADMAP.md');
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(roadmapPath)) {
    errors.push('ROADMAP.md not found');
    output({ passed: false, errors, warnings }, raw, 'failed');
    return;
  }

  const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmapContent = extractCurrentMilestone(roadmapContentRaw, cwd);

  const { roadmapPhases } = buildRoadmapPhaseVariants(roadmapContent);
  const { roadmapPhaseVariants: fullRoadmapPhaseVariants } = buildRoadmapPhaseVariants(roadmapContentRaw);

  const diskPhases = collectDiskPhases(planBase);

  for (const p of roadmapPhases) {
    if (!diskPhases.has(p) && !diskPhases.has(normalizePhaseName(p))) {
      warnings.push(`Phase ${p} in ROADMAP.md but no directory on disk`);
    }
  }

  for (const p of diskPhases) {
    const variants = phaseVariants(p);
    if (![...variants].some((v) => fullRoadmapPhaseVariants.has(v))) {
      warnings.push(`Phase ${p} exists on disk but not in ROADMAP.md`);
    }
  }

  const config = loadConfig(cwd);
  if (config.phase_naming !== 'custom') {
    const integerPhases = [...diskPhases]
      .filter((p) => !p.includes('.'))
      .map((p) => parseInt(p, 10))
      .sort((a, b) => a - b);

    for (let i = 1; i < integerPhases.length; i++) {
      if (integerPhases[i] !== integerPhases[i - 1] + 1) {
        warnings.push(`Gap in phase numbering: ${integerPhases[i - 1]} → ${integerPhases[i]}`);
      }
    }
  }

  const phaseRoots = collectPhaseRoots(planBase);
  for (const phaseRoot of phaseRoots) {
    try {
      const entries = fs.readdirSync(phaseRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const dir of dirs) {
        const phasePath = path.join(phaseRoot, dir);
        const phaseLabel = posixNormalize(path.relative(planBase, phasePath));
        const phaseFiles = fs.readdirSync(phasePath);
        const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md')).sort();

        const planNums = plans
          .map((p) => {
            const pm = p.match(/-(\d{2})-PLAN\.md$/);
            return pm ? parseInt(pm[1], 10) : null;
          })
          .filter((n): n is number => n !== null);

        for (let i = 1; i < planNums.length; i++) {
          if (planNums[i] !== planNums[i - 1] + 1) {
            warnings.push(
              `Gap in plan numbering in ${phaseLabel}: plan ${planNums[i - 1]} → ${planNums[i]}`,
            );
          }
        }

        const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md'));
        const planIds = new Set(plans.map((p) => p.replace('-PLAN.md', '')));
        const summaryIds = new Set(summaries.map((s) => s.replace('-SUMMARY.md', '')));

        for (const sid of summaryIds) {
          if (!planIds.has(sid)) {
            warnings.push(`Summary ${sid}-SUMMARY.md in ${phaseLabel} has no matching PLAN.md`);
          }
        }

        for (const plan of plans) {
          const planFilePath = path.join(phasePath, plan);
          const content = fs.readFileSync(planFilePath, 'utf-8');
          const fmData = extractFrontmatter(content, planFilePath);
          if (!fmData['wave']) {
            warnings.push(`${phaseLabel}/${plan}: missing 'wave' in frontmatter`);
          }
        }
      }
    } catch {
      /* intentionally empty */
    }
  }

  const passed = errors.length === 0;
  output({ passed, errors, warnings, warning_count: warnings.length }, raw, passed ? 'passed' : 'failed');
}

function cmdValidateHealth(
  cwd: string,
  options: Record<string, unknown>,
  raw: boolean,
): Record<string, unknown> | undefined {
  const resolved = path.resolve(cwd);
  if (resolved === os.homedir()) {
    output(
      {
        status: 'error',
        errors: [
          {
            code: 'E010',
            message: `CWD is home directory (${resolved}) — health check would read the wrong .planning/ directory. Run from your project root instead.`,
            fix: 'cd into your project directory and retry',
          },
        ],
        warnings: [],
        info: [{ code: 'I010', message: `Resolved CWD: ${resolved}` }],
        repairable_count: 0,
      },
      raw,
    );
    return;
  }

  // rootBase always resolves to .planning/ (shared root — PROJECT.md, config.json live here)
  // wsBase resolves to .planning/workstreams/<ws>/ when GSD_WORKSTREAM is set (STATE.md, ROADMAP.md, phases/)
  const rootBase = planningRoot(cwd);
  const wsBase = planningDir(cwd);
  // planBase is kept as an alias for wsBase for all the internal helpers (collectDiskPhases, etc.)
  // that are already parameterised on the workstream-aware path.
  const planBase = wsBase;
  const projectPath = path.join(rootBase, 'PROJECT.md');
  const roadmapPath = path.join(wsBase, 'ROADMAP.md');
  const statePath = path.join(wsBase, 'STATE.md');
  const configPath = path.join(rootBase, 'config.json');
  const phasesDir = path.join(wsBase, 'phases');
  const _slashRuntime = resolveRuntime(cwd);
  const slash = (name: string) => formatGsdSlash(name, _slashRuntime) as string;

  const errors: IssueEntry[] = [];
  const warnings: IssueEntry[] = [];
  const info: IssueEntry[] = [];
  const repairs: string[] = [];

  const addIssue = (
    severity: 'error' | 'warning' | 'info',
    code: string,
    message: string,
    fix: string,
    repairable = false,
  ) => {
    const issue: IssueEntry = { code, message, fix, repairable };
    if (severity === 'error') errors.push(issue);
    else if (severity === 'warning') warnings.push(issue);
    else info.push(issue);
  };

  if (!fs.existsSync(rootBase)) {
    addIssue('error', 'E001', '.planning/ directory not found', `Run ${slash('new-project')} to initialize`);
    output({ status: 'broken', errors, warnings, info, repairable_count: 0 }, raw);
    return;
  }

  if (!fs.existsSync(projectPath)) {
    addIssue('error', 'E002', 'PROJECT.md not found', `Run ${slash('new-project')} to create`);
  } else {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const requiredSections = ['## What This Is', '## Core Value', '## Requirements'];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        addIssue('warning', 'W001', `PROJECT.md missing section: ${section}`, 'Add section manually');
      }
    }
  }

  if (!fs.existsSync(roadmapPath)) {
    addIssue('error', 'E003', 'ROADMAP.md not found', `Run ${slash('new-milestone')} to create roadmap`);
  }

  if (!fs.existsSync(statePath)) {
    addIssue(
      'error',
      'E004',
      'STATE.md not found',
      `Run ${slash('health')} --repair to regenerate`,
      true,
    );
    repairs.push('regenerateState');
  } else {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    const phaseRefs = [
      ...stateContent.matchAll(new RegExp(`[Pp]hase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`, 'g')),
    ].map(
      (m) => m[1],
    );
    const validPhases = collectDiskPhases(planBase);
    try {
      if (fs.existsSync(roadmapPath)) {
        const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
        const all = [
          ...roadmapRaw.matchAll(new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`, 'gi')),
        ];
        for (const m of all) validPhases.add(m[1]);
      }
    } catch {
      /* intentionally empty */
    }
    forEachArchivedPhaseToken(planBase, (token) => validPhases.add(token));
    const normalizedValid = new Set<string>();
    for (const p of validPhases) {
      normalizedValid.add(p);
      const dotIdx = p.indexOf('.');
      const head = dotIdx === -1 ? p : p.slice(0, dotIdx);
      const tail = dotIdx === -1 ? '' : p.slice(dotIdx);
      if (/^\d+$/.test(head)) {
        normalizedValid.add(head.padStart(2, '0') + tail);
      }
    }
    for (const ref of phaseRefs) {
      const dotIdx = ref.indexOf('.');
      const head = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
      const tail = dotIdx === -1 ? '' : ref.slice(dotIdx);
      const padded = /^\d+$/.test(head) ? head.padStart(2, '0') + tail : ref;
      if (!normalizedValid.has(ref) && !normalizedValid.has(padded)) {
        if (normalizedValid.size > 0) {
          addIssue(
            'warning',
            'W002',
            `STATE.md references phase ${ref}, but only phases ${[...validPhases].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')} are declared`,
            `Review STATE.md manually before changing it; ${slash('health')} --repair will not overwrite an existing STATE.md for phase mismatches`,
          );
        }
      }
    }
  }

  if (!fs.existsSync(configPath)) {
    addIssue(
      'warning',
      'W003',
      'config.json not found',
      `Run ${slash('health')} --repair to create with defaults`,
      true,
    );
    repairs.push('createConfig');
  } else {
    try {
      const rawCfg = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(rawCfg) as Record<string, unknown>;
      if (parsed['model_profile'] && !VALID_PROFILES.includes(parsed['model_profile'] as string)) {
        addIssue(
          'warning',
          'W004',
          `config.json: invalid model_profile "${parsed['model_profile'] as string}"`,
          `Valid values: ${VALID_PROFILES.join(', ')}`,
        );
      }
      const configModels = parsed['models'];
      if (configModels && typeof configModels === 'object' && !Array.isArray(configModels)) {
        for (const [phaseType, tierValue] of Object.entries(configModels as Record<string, unknown>)) {
          if (!VALID_PHASE_TYPES.has(phaseType)) {
            addIssue(
              'warning',
              'W022',
              `config.json: models has an unknown phase type "${phaseType}" which will be ignored`,
              `Valid phase types: ${[...VALID_PHASE_TYPES].join(', ')}`,
            );
          } else if (typeof tierValue !== 'string' || !VALID_TIERS.has(tierValue)) {
            addIssue(
              'warning',
              'W022',
              `config.json: models.${phaseType} has an invalid tier value ${JSON.stringify(tierValue)} which will be ignored`,
              `Valid tiers: ${[...VALID_TIERS].join(', ')}`,
            );
          }
        }
      } else if (configModels !== undefined && configModels !== null) {
        addIssue(
          'warning',
          'W022',
          `config.json: models is set to ${JSON.stringify(configModels)}, but must be an object mapping phase types to tiers — this value will be ignored`,
          `Set models to an object like {"planning": "sonnet"}, or remove the key to use profile defaults`,
        );
      }
    } catch (err) {
      addIssue(
        'error',
        'E005',
        `config.json: JSON parse error - ${err instanceof Error ? err.message : String(err)}`,
        `Run ${slash('health')} --repair to reset to defaults`,
        true,
      );
      repairs.push('resetConfig');
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
      const workflow = configParsed['workflow'] as Record<string, unknown> | undefined;
      if (workflow && workflow['nyquist_validation'] === undefined) {
        addIssue(
          'warning',
          'W008',
          'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
          `Run ${slash('health')} --repair to add key`,
          true,
        );
        if (!repairs.includes('addNyquistKey')) repairs.push('addNyquistKey');
      }
      if (workflow && workflow['ai_integration_phase'] === undefined) {
        addIssue(
          'warning',
          'W016',
          `config.json: workflow.ai_integration_phase absent (defaults to enabled — run ${slash('ai-integration-phase')} before planning AI system phases)`,
          `Run ${slash('health')} --repair to add key`,
          true,
        );
        if (!repairs.includes('addAiIntegrationPhaseKey')) repairs.push('addAiIntegrationPhaseKey');
      }
    } catch {
      /* intentionally empty */
    }
  }

  let phaseDirEntries: fs.Dirent[] = [];
  const phaseDirFiles = new Map<string, string[]>();
  try {
    phaseDirEntries = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const e of phaseDirEntries) {
      try {
        phaseDirFiles.set(e.name, fs.readdirSync(path.join(phasesDir, e.name)));
      } catch {
        phaseDirFiles.set(e.name, []);
      }
    }
  } catch {
    /* intentionally empty */
  }

  for (const e of phaseDirEntries) {
    if (!e.name.match(phaseDirNameRe)) {
      addIssue(
        'warning',
        'W005',
        `Phase directory "${e.name}" doesn't follow NN-name format`,
        'Rename to match pattern (e.g., 01-setup)',
      );
    }
  }

  // W023 (#2408): detect two or more real on-disk phase directories that
  // normalize to the same phase key (e.g. `05-real/` + `05-real-stray/`).
  // The collision silently breaks /gsd-stats status accuracy (now folded by
  // precedence — see commands.cts foldPhaseStatus) and forces an operator
  // decision. Wording is neutral — never guesses which directory is "real".
  {
    const groups = new Map<string, string[]>();
    for (const e of phaseDirEntries) {
      // extractPhaseToken never returns empty — for unparseable dir names it
      // falls back to the dir name itself. Two distinct unparseable names
      // therefore normalize to distinct keys and cannot false-positive here;
      // only dirs whose tokens collapse to the same key (e.g. `05-real` and
      // `05-real-stray` → token `05`) produce a collision group.
      const token = extractPhaseToken(e.name);
      const key = normalizePhaseName(token);
      const list = groups.get(key);
      if (list) list.push(e.name);
      else groups.set(key, [e.name]);
    }
    for (const [key, dirs] of groups) {
      if (dirs.length < 2) continue;
      // Compute each dir's status independently so the warning is informative.
      // Sort by phase id for stable output regardless of readdir order; tie-
      // break on the dir name itself so two dirs sharing the same phase token
      // (the collision case itself) still sort deterministically (V8's stable
      // sort would otherwise fall back to non-portable fs.readdirSync order).
      const described = dirs
        .slice()
        .sort((a, b) => comparePhaseNum(a, b) || String(a).localeCompare(String(b)))
        .map((d) => {
          const files = phaseDirFiles.get(d) || [];
          const plans = files.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
          const summaries = files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;
          const status = determinePhaseStatus(plans, summaries, path.join(phasesDir, d), 'Not Started');
          return `${d} (${status})`;
        })
        .join(', ');
      addIssue(
        'warning',
        'W023',
        `Phase directories collide on normalized key "${key}": ${described}`,
        'Inspect each directory; rename or remove the duplicate so only one directory maps to this phase key',
      );
    }
  }

  for (const e of phaseDirEntries) {
    const phaseFiles = phaseDirFiles.get(e.name) || [];
    const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md');
    const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    const summaryBases = new Set<string>();
    for (const s of summaries) {
      const summaryBase = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      summaryBases.add(summaryBase);
      summaryBases.add(canonicalPlanStem(summaryBase));
    }

    for (const plan of plans) {
      const planBase = plan.replace('-PLAN.md', '').replace('PLAN.md', '');
      const canonicalBase = canonicalPlanStem(planBase);
      if (!summaryBases.has(planBase) && !summaryBases.has(canonicalBase)) {
        addIssue('info', 'I001', `${e.name}/${plan} has no SUMMARY.md`, 'May be in progress');
      }
    }
  }

  for (const e of phaseDirEntries) {
    const phaseFiles = phaseDirFiles.get(e.name) || [];
    const hasResearch = phaseFiles.some((f) => f.endsWith('-RESEARCH.md'));
    const hasValidation = phaseFiles.some((f) => f.endsWith('-VALIDATION.md'));
    if (hasResearch && !hasValidation) {
      const researchFile = phaseFiles.find((f) => f.endsWith('-RESEARCH.md'));
      try {
        const researchContent = fs.readFileSync(
          path.join(phasesDir, e.name, researchFile!),
          'utf-8',
        );
        if (researchContent.includes('## Validation Architecture')) {
          addIssue(
            'warning',
            'W009',
            `Phase ${e.name}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
            `Re-run ${slash('plan-phase')} with --research to regenerate`,
          );
        }
      } catch {
        /* intentionally empty */
      }
    }
  }

  try {
    const agentStatus = checkAgentsInstalled();
    if (!agentStatus.agents_installed) {
      if ((agentStatus.installed_agents).length === 0) {
        addIssue(
          'warning',
          'W010',
          `No GSD agents found in ${agentStatus.agents_dir} — Task(subagent_type="gsd-*") will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      } else if ((agentStatus.incomplete_agents).length > 0 && (agentStatus.missing_agents).length === 0) {
        addIssue(
          'warning',
          'W010',
          `Incomplete agent installs (missing generated file): ${(agentStatus.incomplete_agents).join(', ')} — affected workflows may fall back to general-purpose`,
          `Re-run the GSD installer to complete the install: npx ${PACKAGE_NAME}@latest`,
        );
      } else if ((agentStatus.incomplete_agents).length > 0) {
        addIssue(
          'warning',
          'W010',
          `Missing ${(agentStatus.missing_agents).length} GSD agents: ${(agentStatus.missing_agents).join(', ')}; incomplete agent installs (missing generated file): ${(agentStatus.incomplete_agents).join(', ')} — affected workflows will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      } else {
        addIssue(
          'warning',
          'W010',
          `Missing ${(agentStatus.missing_agents).length} GSD agents: ${(agentStatus.missing_agents).join(', ')} — affected workflows will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      }
    }
  } catch {
    /* intentionally empty — agent check is non-blocking */
  }

  if (fs.existsSync(roadmapPath)) {
    const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
    const roadmapContent = extractCurrentMilestone(roadmapContentRaw, cwd);

    const { roadmapPhases } = buildRoadmapPhaseVariants(roadmapContent);
    const { roadmapPhaseVariants: fullRoadmapPhaseVariants } =
      buildRoadmapPhaseVariants(roadmapContentRaw);

    const diskPhases = collectDiskPhases(planBase);
    forEachArchivedPhaseToken(planBase, (token) => diskPhases.add(token));

    const activeDiskPhases = collectDiskPhases(planBase);

    const notStartedPhases = buildNotStartedPhaseVariants(roadmapContent);

    for (const p of roadmapPhases) {
      const variants = phaseVariants(p);
      const existsOnDisk = [...variants].some((v) => diskPhases.has(v));
      if (!existsOnDisk) {
        const isNotStarted = [...variants].some((v) => notStartedPhases.has(v));
        if (isNotStarted) continue;
        addIssue(
          'warning',
          'W006',
          `Phase ${p} in ROADMAP.md but no directory on disk`,
          'Create phase directory or remove from roadmap',
        );
      }
    }

    for (const p of activeDiskPhases) {
      const variants = phaseVariants(p);
      if (![...variants].some((v) => fullRoadmapPhaseVariants.has(v))) {
        addIssue(
          'warning',
          'W007',
          `Phase ${p} exists on disk but not in ROADMAP.md`,
          'Add to roadmap or remove directory',
        );
      }
    }
  }

  if (fs.existsSync(statePath) && fs.existsSync(roadmapPath)) {
    try {
      const stateContent = fs.readFileSync(statePath, 'utf-8');
      const roadmapContentFull = fs.readFileSync(roadmapPath, 'utf-8');

      const currentPhaseMatch =
        stateContent.match(/\*\*Current Phase:\*\*\s*(\S+)/i) ||
        stateContent.match(/Current Phase:\s*(\S+)/i);
      if (currentPhaseMatch) {
        const statePhase = currentPhaseMatch[1].replace(/^0+/, '');
        const phaseCheckboxRe = new RegExp(
          `-\\s*\\[x\\].*Phase\\s+0*${escapeRegex(statePhase)}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
          'i',
        );
        if (phaseCheckboxRe.test(roadmapContentFull)) {
          const stateStatus = stateContent.match(/\*\*Status:\*\*\s*(.+)/i);
          const statusVal = stateStatus ? stateStatus[1].trim().toLowerCase() : '';
          if (statusVal !== 'complete' && statusVal !== 'done') {
            addIssue(
              'warning',
              'W011',
              `STATE.md says current phase is ${statePhase} (status: ${statusVal || 'unknown'}) but ROADMAP.md shows it as [x] complete — state files may be out of sync`,
              `Run ${slash('progress')} to re-derive current position, or manually update STATE.md`,
            );
          }
        }
      }
    } catch {
      /* intentionally empty — cross-validation is advisory */
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw) as Record<string, unknown>;

      const validStrategies = ['none', 'phase', 'milestone'];
      if (
        configParsed['branching_strategy'] &&
        !validStrategies.includes(configParsed['branching_strategy'] as string)
      ) {
        addIssue(
          'warning',
          'W012',
          `config.json: invalid branching_strategy "${configParsed['branching_strategy'] as string}"`,
          `Valid values: ${validStrategies.join(', ')}`,
        );
      }

      if (configParsed['context_window'] !== undefined) {
        const cw = configParsed['context_window'];
        if (typeof cw !== 'number' || cw <= 0 || !Number.isInteger(cw)) {
          addIssue(
            'warning',
            'W013',
            `config.json: context_window should be a positive integer, got "${cw as string}"`,
            'Set to 200000 (default) or 1000000 (for 1M models)',
          );
        }
      }

      if (
        configParsed['phase_branch_template'] &&
        !(configParsed['phase_branch_template'] as string).includes('{phase}')
      ) {
        addIssue(
          'warning',
          'W014',
          'config.json: phase_branch_template missing {phase} placeholder',
          'Template must include {phase} for phase number substitution',
        );
      }
      if (
        configParsed['milestone_branch_template'] &&
        !(configParsed['milestone_branch_template'] as string).includes('{milestone}')
      ) {
        addIssue(
          'warning',
          'W015',
          'config.json: milestone_branch_template missing {milestone} placeholder',
          'Template must include {milestone} for version substitution',
        );
      }
    } catch {
      /* parse error already caught in Check 5 */
    }
  }

  try {
    const worktreeHealth = (inspectWorktreeHealth as unknown as (
      cwd: string,
      opts: { staleAfterMs: number },
      deps: { execGit: unknown; existsSync: unknown; statSync: unknown },
    ) => Record<string, unknown>)(
      cwd,
      { staleAfterMs: 60 * 60 * 1000 },
      { execGit, existsSync: fs.existsSync, statSync: fs.statSync },
    );
    if (!(worktreeHealth['ok'] as boolean)) {
      if (worktreeHealth['reason'] === 'git_timed_out') {
        addIssue(
          'warning',
          'W020',
          'Worktree health check degraded: git worktree list timed out after 10s — orphan/stale worktrees could not be inspected',
          'Run: git worktree list --porcelain to diagnose; check for .git/index.lock or a hung git process',
        );
      }
      if (worktreeHealth['reason'] === 'git_list_failed') {
        addIssue(
          'warning',
          'W020',
          'Worktree health check degraded: git worktree list failed — orphan/stale worktrees could not be inspected',
          'Run: git worktree list --porcelain to diagnose; check git repository state and permissions',
        );
      }
    } else {
      for (const finding of worktreeHealth['findings'] as Record<string, unknown>[]) {
        if (finding['kind'] === 'orphan') {
          addIssue(
            'warning',
            'W017',
            `Orphan git worktree: ${finding['path'] as string} (path no longer exists on disk)`,
            'Run: git worktree prune',
          );
          continue;
        }

        if (finding['kind'] === 'stale') {
          // Do not flag the active session's worktree — removing it would be harmful.
          const worktreePath = finding['path'] as string;
          const activeCwd = process.cwd();
          const normalizedWorktree = path.resolve(worktreePath);
          const normalizedCwd = path.resolve(activeCwd);
          // Skip if the worktree IS the cwd or is an ancestor of it.
          const isActiveWorktree =
            normalizedCwd === normalizedWorktree ||
            normalizedCwd.startsWith(normalizedWorktree + path.sep);
          if (isActiveWorktree) continue;
          addIssue(
            'warning',
            'W017',
            `Stale git worktree: ${worktreePath} (last modified ${finding['ageMinutes'] as number} minutes ago)`,
            `Run: git worktree remove ${worktreePath} --force`,
          );
        }
      }
    }
  } catch {
    /* git worktree not available or not a git repo — skip silently */
  }

  try {
    const phaseConvention = (() => {
      if (!fs.existsSync(configPath)) return null;
      try {
        const configRaw = fs.readFileSync(configPath, 'utf-8');
        const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
        return (configParsed['phase_id_convention'] as string | undefined) || null;
      } catch {
        return null;
      }
    })();
    if (phaseConvention === 'milestone-prefixed') {
      if (fs.existsSync(roadmapPath)) {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const mismatches = checkMilestonePrefixMismatches(roadmapContent, {
          getMilestoneFromPhaseId: getMilestoneFromPhaseId,
        });
        for (const mm of mismatches) {
          addIssue(
            'warning',
            'W021',
            `Phase ${mm.phaseId}: integer prefix implies ${mm.expectedMilestone} but listed under ${mm.foundInMilestone}`,
            'Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate (dry-run by default)',
          );
        }
      }
    }
  } catch {
    /* W021 check is advisory — skip on error */
  }

  const milestonesPath = path.join(rootBase, 'MILESTONES.md');
  const milestonesArchiveDir = path.join(rootBase, 'milestones');
  const missingFromRegistry: string[] = [];
  try {
    if (fs.existsSync(milestonesArchiveDir)) {
      const archiveFiles = fs.readdirSync(milestonesArchiveDir);
      const archivedVersions = archiveFiles
        .map((f) => f.match(/^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$/))
        .filter(Boolean)
        .map((m) => m![1]);

      if (archivedVersions.length > 0) {
        const registryContent = fs.existsSync(milestonesPath)
          ? fs.readFileSync(milestonesPath, 'utf-8')
          : '';
        for (const ver of archivedVersions) {
          if (!registryContent.includes(`## ${ver}`)) {
            missingFromRegistry.push(ver);
          }
        }
        if (missingFromRegistry.length > 0) {
          addIssue(
            'warning',
            'W018',
            `MILESTONES.md missing ${missingFromRegistry.length} archived milestone(s): ${missingFromRegistry.join(', ')}`,
            `Run ${slash('health')} --backfill to synthesize missing entries from archive snapshots`,
            true,
          );
          repairs.push('backfillMilestones');
        }
      }
    }
  } catch {
    /* intentionally empty — milestone sync check is advisory */
  }

  try {
    const entries = fs.readdirSync(rootBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (!isCanonicalPlanningFile(entry.name)) {
        addIssue(
          'warning',
          'W019',
          `Unrecognized .planning/ file: ${entry.name} — not a canonical GSD artifact`,
          'Move to .planning/milestones/ archive subdir or delete if stale. See templates/README.md for the canonical artifact list.',
          false,
        );
      }
    }
  } catch {
    /* artifact check is advisory — skip on error */
  }

  try {
    if (fs.existsSync(statePath) && fs.existsSync(roadmapPath)) {
      const stateRaw = fs.readFileSync(statePath, 'utf-8');
      const statusMatch = stateRaw.match(/^status:\s*(.+)/im);
      const stateStatus = statusMatch ? statusMatch[1].trim().toLowerCase() : '';
      const isMarkedComplete = /milestone complete|archived/.test(stateStatus);
      if (isMarkedComplete) {
        const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
        const scopedContent = extractCurrentMilestone(roadmapRaw, cwd);
        // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
        const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gi');
        const unstarted: string[] = [];
        let pm: RegExpExecArray | null;
        // Non-hoisted: load-order matters (circular dep guard)
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
        const planningWorkspace2 = require('./planning-workspace.cjs') as typeof planningWorkspace;
        const phasesDir2 = planningWorkspace2.planningPaths(cwd).phases;
        const phaseDirNames2 = (() => {
          try {
            return fs
              .readdirSync(phasesDir2, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name);
          } catch {
            return [];
          }
        })();
        while ((pm = phasePattern.exec(scopedContent)) !== null) {
          const phaseNum = pm[1];
          const normalizedPh = normalizePhaseName(phaseNum);
          const hasDirectory = phaseDirNames2.some((d) => phaseTokenMatches(d, normalizedPh));
          if (!hasDirectory) {
            unstarted.push(phaseNum);
          }
        }
        if (unstarted.length > 0) {
          addIssue(
            'warning',
            'W021',
            `STATE says milestone complete but ROADMAP lists ${unstarted.length} unstarted phase(s) (e.g. Phase ${unstarted[0]})`,
            'Run validate consistency or re-run complete-milestone after verifying all phases are done',
          );
        }
      }
    }
  } catch {
    /* W021 check is advisory — skip on error */
  }

  // ─── Perform repairs if requested ─────────────────────────────────────────
  const repairActions: Record<string, unknown>[] = [];
  if (options['repair'] && repairs.length > 0) {
    for (const repair of repairs) {
      try {
        switch (repair) {
          case 'createConfig':
          case 'resetConfig': {
            const defaults = {
              model_profile: CONFIG_DEFAULTS.model_profile,
              commit_docs: CONFIG_DEFAULTS.commit_docs,
              search_gitignored: CONFIG_DEFAULTS.search_gitignored,
              branching_strategy: CONFIG_DEFAULTS.branching_strategy,
              phase_branch_template: CONFIG_DEFAULTS.phase_branch_template,
              milestone_branch_template: CONFIG_DEFAULTS.milestone_branch_template,
              quick_branch_template: CONFIG_DEFAULTS.quick_branch_template,
              workflow: {
                research: CONFIG_DEFAULTS.research,
                plan_check: CONFIG_DEFAULTS.plan_checker,
                verifier: CONFIG_DEFAULTS.verifier,
                nyquist_validation: CONFIG_DEFAULTS.nyquist_validation,
              },
              parallelization: CONFIG_DEFAULTS.parallelization,
              brave_search: CONFIG_DEFAULTS.brave_search,
            };
            platformWriteSync(configPath, JSON.stringify(defaults, null, 2));
            repairActions.push({ action: repair, success: true, path: 'config.json' });
            break;
          }
          case 'regenerateState': {
            if (fs.existsSync(statePath)) {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const backupPath = `${statePath}.bak-${timestamp}`;
              fs.copyFileSync(statePath, backupPath);
              repairActions.push({ action: 'backupState', success: true, path: backupPath });
            }
            const milestone = getMilestoneInfo(cwd);
            const projectRef = path
              .relative(cwd, path.join(rootBase, 'PROJECT.md'))
              .split(path.sep)
              .join('/');
            let stateContent = `# Session State\n\n`;
            stateContent += `## Project Reference\n\n`;
            stateContent += `See: ${projectRef}\n\n`;
            stateContent += `## Position\n\n`;
            stateContent += `**Milestone:** ${milestone.version} ${milestone.name}\n`;
            stateContent += `**Current phase:** (determining...)\n`;
            stateContent += `**Status:** Resuming\n\n`;
            stateContent += `## Session Log\n\n`;
            stateContent += `- ${realClock.localToday()}: STATE.md regenerated by ${slash('health')} --repair\n`;
            writeStateMd(statePath, stateContent, cwd);
            repairActions.push({ action: repair, success: true, path: 'STATE.md' });
            break;
          }
          case 'addNyquistKey': {
            if (fs.existsSync(configPath)) {
              try {
                const configRaw = fs.readFileSync(configPath, 'utf-8');
                const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
                if (!configParsed['workflow']) configParsed['workflow'] = {};
                const wf = configParsed['workflow'] as Record<string, unknown>;
                if (wf['nyquist_validation'] === undefined) {
                  wf['nyquist_validation'] = true;
                  platformWriteSync(configPath, JSON.stringify(configParsed, null, 2));
                }
                repairActions.push({ action: repair, success: true, path: 'config.json' });
              } catch (err) {
                repairActions.push({
                  action: repair,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break;
          }
          case 'addAiIntegrationPhaseKey': {
            if (fs.existsSync(configPath)) {
              try {
                const configRaw = fs.readFileSync(configPath, 'utf-8');
                const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
                if (!configParsed['workflow']) configParsed['workflow'] = {};
                const wf = configParsed['workflow'] as Record<string, unknown>;
                if (wf['ai_integration_phase'] === undefined) {
                  wf['ai_integration_phase'] = true;
                  platformWriteSync(configPath, JSON.stringify(configParsed, null, 2));
                }
                repairActions.push({ action: repair, success: true, path: 'config.json' });
              } catch (err) {
                repairActions.push({
                  action: repair,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break;
          }
          case 'backfillMilestones': {
            if (!options['backfill'] && !options['repair']) break;
            const today = realClock.localToday();
            let backfilled = 0;
            for (const ver of missingFromRegistry) {
              try {
                const snapshotPath = path.join(milestonesArchiveDir, `${ver}-ROADMAP.md`);
                const snapshot = safeReadFile(snapshotPath);
                const titleMatch = snapshot && snapshot.match(/^#\s+(.+)$/m);
                const milestoneName = titleMatch
                  ? titleMatch[1].replace(/^Milestone\s+/i, '').replace(/^v[\d.]+\s*/, '').trim()
                  : ver;
                const entry =
                  `## ${ver}${milestoneName && milestoneName !== ver ? ` ${milestoneName}` : ''} (Backfilled: ${today})\n\n**Note:** Synthesized from archive snapshot by \`${slash('health')} --backfill\`. Original completion date unknown.\n\n---\n\n`;
                const milestonesContent = fs.existsSync(milestonesPath)
                  ? fs.readFileSync(milestonesPath, 'utf-8')
                  : '';
                if (!milestonesContent.trim()) {
                  platformWriteSync(milestonesPath, `# Milestones\n\n${entry}`);
                } else {
                  const headerMatch = milestonesContent.match(/^(#{1,3}\s+[^\n]*\n\n?)/);
                  if (headerMatch) {
                    const header = headerMatch[1];
                    const rest = milestonesContent.slice(header.length);
                    platformWriteSync(milestonesPath, header + entry + rest);
                  } else {
                    platformWriteSync(milestonesPath, entry + milestonesContent);
                  }
                }
                backfilled++;
              } catch {
                /* intentionally empty — partial backfill is acceptable */
              }
            }
            repairActions.push({
              action: repair,
              success: true,
              detail: `Backfilled ${backfilled} milestone(s) into MILESTONES.md`,
            });
            break;
          }
        }
      } catch (err) {
        repairActions.push({
          action: repair,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  let status: string;
  if (errors.length > 0) {
    status = 'broken';
  } else if (warnings.length > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const repairableCount =
    errors.filter((e) => e.repairable).length + warnings.filter((w) => w.repairable).length;

  const result: Record<string, unknown> = {
    status,
    errors,
    warnings,
    info,
    repairable_count: repairableCount,
    repairs_performed: repairActions.length > 0 ? repairActions : undefined,
  };
  output(result, raw);
  return result;
}

function cmdValidateAgents(cwd: string, raw: boolean): void {
  const agentStatus = checkAgentsInstalled();
  const expected = Object.keys(MODEL_PROFILES);

  output(
    {
      agents_dir: agentStatus.agents_dir,
      agents_found: agentStatus.agents_installed,
      installed: agentStatus.installed_agents,
      missing: agentStatus.missing_agents,
      incomplete: agentStatus.incomplete_agents,
      expected,
    },
    raw,
  );
}

function cmdVerifySchemaDrift(
  cwd: string,
  phaseArg: string,
  skipFlag: boolean | undefined,
  raw: boolean,
): void {
  if (!phaseArg) {
    error('Usage: verify schema-drift <phase> [--skip]');
    return;
  }

  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  if (!fs.existsSync(phasesDir)) {
    output({ block: false, drift_detected: false, blocking: false, message: 'No phases directory' }, raw);
    return;
  }

  // Resolve the phase directory with the canonical phase-token matcher
  // (phase-id.cjs), not a naive substring test. A bare `.includes(phaseArg)`
  // lets a non-existent phase silently match a different phase whose directory
  // name merely contains the requested token (e.g. "1" matching "11-expansion"),
  // making the drift gate inspect the wrong phase. This mirrors find-phase /
  // verify phase-completeness, which both use phaseTokenMatches. (#1571)
  let phaseDir: string | null = null;
  const normalizedPhase = normalizePhaseName(phaseArg);
  const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && phaseTokenMatches(entry.name, normalizedPhase)) {
      phaseDir = path.join(phasesDir, entry.name);
      break;
    }
  }

  if (!phaseDir) {
    const exact = path.join(phasesDir, phaseArg);
    if (fs.existsSync(exact)) phaseDir = exact;
  }

  if (!phaseDir) {
    output(
      { block: false, drift_detected: false, blocking: false, message: `Phase directory not found: ${phaseArg}` },
      raw,
    );
    return;
  }

  const allFiles: string[] = [];
  const planFiles = fs.readdirSync(phaseDir).filter((f) => f.endsWith('-PLAN.md'));
  for (const pf of planFiles) {
    const content = fs.readFileSync(path.join(phaseDir, pf), 'utf-8');
    const fmMatch = content.match(/files_modified:\s*\[([^\]]{0,8000})\]/);
    if (fmMatch) {
      const files = fmMatch[1].split(',').map((f) => f.trim()).filter(Boolean);
      allFiles.push(...files);
    }
  }

  let executionLog = '';
  const summaryFiles = fs.readdirSync(phaseDir).filter((f) => f.endsWith('-SUMMARY.md'));
  for (const sf of summaryFiles) {
    executionLog += fs.readFileSync(path.join(phaseDir, sf), 'utf-8') + '\n';
  }

  const gitLog = execGit(['log', '--oneline', '--all', '-50'], { cwd }) as unknown as { exitCode: number; stdout: string };
  if (gitLog.exitCode === 0) {
    executionLog += '\n' + gitLog.stdout;
  }

  const result = checkSchemaDrift(allFiles, executionLog, { skipCheck: !!skipFlag }) as unknown as Record<string, unknown>;

  const isSkipped = !!result['skipped'];
  output(
    {
      // Uniform gate contract: `block` = true means "this gate's bad condition is met".
      // When skipCheck is true (GSD_SKIP_SCHEMA_CHECK=true), the gate is bypassed —
      // block must be false regardless of whether drift was detected.
      // drift_detected and blocking are kept for compatibility.
      block: isSkipped ? false : !!result['driftDetected'],
      drift_detected: result['driftDetected'],
      blocking: result['blocking'],
      schema_files: result['schemaFiles'],
      orms: result['orms'],
      unpushed_orms: result['unpushedOrms'],
      message: result['message'],
      skipped: isSkipped,
    },
    raw,
  );
}

function cmdVerifyCodebaseDrift(cwd: string, raw: boolean): void {
  // Non-hoisted: load-order matters for circular dep guard
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- drift.cjs is an export= CommonJS module
  const drift = require('./drift.cjs') as Record<string, unknown>;

  const emit = (payload: unknown) => output(payload, raw);

  try {
    const codebaseDir = path.join(planningDir(cwd), 'codebase');
    const structurePath = path.join(codebaseDir, 'STRUCTURE.md');
    if (!fs.existsSync(structurePath)) {
      emit({
        // Uniform gate contract: block = action_required (false when skipped).
        block: false,
        skipped: true,
        reason: 'no-structure-md',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    let structureMd: string;
    try {
      structureMd = fs.readFileSync(structurePath, 'utf-8');
    } catch (err) {
      emit({
        block: false,
        skipped: true,
        reason: 'cannot-read-structure-md: ' + (err instanceof Error ? err.message : String(err)),
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const lastMapped = (drift['readMappedCommit'] as (p: string) => string | null)(structurePath);

    const revProbe = execGit(['rev-parse', 'HEAD'], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (revProbe.exitCode !== 0) {
      emit({
        block: false,
        skipped: true,
        reason: 'not-a-git-repo',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    let base = lastMapped;
    if (!base) {
      base = EMPTY_TREE;
    } else {
      const verify = execGit(['cat-file', '-t', base], { cwd }) as unknown as { exitCode: number; stdout: string };
      if (verify.exitCode !== 0) base = EMPTY_TREE;
    }

    const diff = execGit(['diff', '--name-status', base, 'HEAD'], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (diff.exitCode !== 0) {
      emit({
        block: false,
        skipped: true,
        reason: 'git-diff-failed',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const line of diff.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^([A-Z])\d*\t(.+?)(?:\t(.+))?$/);
      if (!m) continue;
      const status = m[1];
      const file = m[3] || m[2];
      if (status === 'A' || status === 'R' || status === 'C') added.push(file);
      else if (status === 'M') modified.push(file);
      else if (status === 'D') deleted.push(file);
    }

    // loadConfig() returns a flattened object — there is no nested `workflow`
    // key. Read the raw config.json directly to access workflow-scoped keys,
    // matching the pattern used in check-command-router.cts:readWorkflowConfig.
    let wf: Record<string, unknown> | undefined;
    try {
      const rawCfg = JSON.parse(
        fs.readFileSync(path.join(planningDir(cwd), 'config.json'), 'utf-8'),
      ) as Record<string, unknown>;
      wf = rawCfg['workflow'] as Record<string, unknown> | undefined;
    } catch {
      wf = undefined;
    }
    const threshold =
      Number.isInteger(wf?.drift_threshold) && (wf?.drift_threshold as number) >= 1
        ? (wf?.drift_threshold as number)
        : 3;
    const action = wf?.drift_action === 'auto-remap' ? 'auto-remap' : 'warn';

    const driftResult = (drift['detectDrift'] as (opts: unknown) => Record<string, unknown>)({
      addedFiles: added,
      modifiedFiles: modified,
      deletedFiles: deleted,
      structureMd,
      threshold,
      action,
      runtime: resolveRuntime(cwd),
    });

    const actionRequired = !!driftResult['actionRequired'];
    emit({
      // Uniform gate contract: block = action_required.
      block: actionRequired,
      skipped: !!driftResult['skipped'],
      reason: driftResult['reason'] || null,
      action_required: actionRequired,
      directive: driftResult['directive'],
      spawn_mapper: !!driftResult['spawnMapper'],
      affected_paths: driftResult['affectedPaths'] || [],
      elements: driftResult['elements'] || [],
      threshold,
      action,
      last_mapped_commit: lastMapped,
      message: driftResult['message'] || '',
    });
  } catch (err) {
    emit({
      block: false,
      skipped: true,
      reason: 'exception: ' + (err && err instanceof Error ? err.message : String(err)),
      action_required: false,
      directive: 'none',
      elements: [],
    });
  }
}

export = {
  scanNegativeGrepCommentEcho,
  scanFileWideNegativeGateConflict,
  cmdVerifySummary,
  verifySummaryCore,
  cmdVerifyPlanStructure,
  cmdVerifyPhaseCompleteness,
  cmdVerifyReferences,
  cmdVerifyCommits,
  cmdVerifyArtifacts,
  cmdVerifyKeyLinks,
  cmdValidateConsistency,
  cmdValidateHealth,
  cmdValidateAgents,
  cmdVerifySchemaDrift,
  cmdVerifyCodebaseDrift,
  // Test seam (#1883): listMilestoneArchiveDirs is private and exercised through
  // the validate command, which runs in a subprocess — an fs monkeypatch in the
  // test process cannot reach it. Exposed under a leading underscore so the
  // permission-error path can be unit-tested directly (no chmod 0o000).
  _listMilestoneArchiveDirs: listMilestoneArchiveDirs,
};
