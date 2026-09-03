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
import { textEncodingError } from './validate.cjs';
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
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { findOrphanSummaries, findUnsummarizedPlans } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
import worktreeSafetyMod = require('./worktree-safety.cjs');
// Single owner of git C-quoted-path decoding (see #4081 note at the
// codebase-drift --name-status parse loop).
const { decodeGitQuotedPath } = worktreeSafetyMod;
import { execGit, platformReadSync as safeReadFile } from './shell-command-projection.cjs';
import { validatePath } from './security.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { detectSchemaFiles, checkSchemaDrift } from './schema-detect.cjs';
import { extractTaggedBlocks } from './markdown-sectionizer.cjs';
import { compileUserPattern, MAX_USER_PATTERN_LEN } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheck = require('./agent-install-check.cjs');
const { checkAgentsInstalled, checkCodexModelPosture, checkCodexSandboxPosture } = agentInstallCheck;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { normalizePhaseName, matchPhaseDirs } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { stripShippedMilestones } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- health-diagnostic.cjs is an export= CommonJS module
import healthDiagnosticMod = require('./health-diagnostic.cjs');
const { SEVERITY: HEALTH_SEVERITY, REMEDY_ACTION, REMEDY_RISK, evaluateRules, evaluateConsistencyRules, applyRepairs } = healthDiagnosticMod;
type HealthDiagnostic = healthDiagnosticMod.Diagnostic;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-snapshot.cjs is an export= CommonJS module
import planningSnapshotMod = require('./planning-snapshot.cjs');
const { buildPlanningSnapshot } = planningSnapshotMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- onboard-projection.cjs is an export= CommonJS module
import onboardProjectionMod = require('./onboard-projection.cjs');
const { REQUIRED_CODEBASE_MAP_FILES } = onboardProjectionMod;
import { realClock } from './clock.cjs';

const { planningDir, planningRoot, withPlanningLock } = planningWorkspace;
const { defaultPhaseCleanCommitTimesMs } = verificationMod;
const { extractFrontmatter, parseMustHavesBlock } = frontmatterMod;
const { readStateHeadFreshness } = stateMod;

/**
 * W024 (#2573) threshold — how many commits STATE.md may lag HEAD before
 * `validate.health` mentions it.
 *
 * Deliberately coarse. `state_head` restamps on every state write, so a small
 * count is normal for any active project; firing near zero would make health
 * noisy for healthy projects without telling anyone anything. This is a
 * freshness proxy, not a drift measurement — see readStateHeadFreshness.
 */
const STATE_HEAD_ADVISORY_COMMITS = 20;
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
  // #2844: Pattern 1 matches any backticked path-like token. A SUMMARY body is
  // predominantly about what the phase DID, so a backticked path in prose ("Built
  // `src/kept.ts`", a `- \`src/x.ts\`` list item) is a legitimate claim (#2685
  // pins this). The false-positive class #2844 fixes is a path mentioned as a
  // FUTURE/CONDITIONAL deliverable — "next phase will add `shared/types.ts`",
  // "planned", "would", "to be created" — which is NOT a claim about this phase.
  // Exclude those lines rather than requiring an explicit claim verb (which would
  // drop the legitimate "Built …" / list-item forms #2685 protects).
  const isFutureMention = (line: string): boolean =>
    /\b(?:will(?:\s+(?:add|create|build|land))?(?:[^.])?|(?:next|later|future)\s+phase|planned?|would\s+(?:be|add|create|build)|to\s+be\s+(?:added|created|built)|eventually|not\s+yet)\b/i.test(line);
  const patterns = [
    /`([^`]+\.[a-zA-Z]+)`/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*`?([^\s`[\]]+\.[a-zA-Z]+)`?/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const filePath = m[1];
      if (!filePath || !isProbableProjectFile(filePath)) continue;
      // #2844: skip a backticked path on a future/conditional line — it names a
      // deliverable this phase did NOT produce, so probing it is a false positive.
      const lineStart = content.lastIndexOf('\n', m.index) + 1;
      const lineEnd = content.indexOf('\n', m.index);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (isFutureMention(line)) continue;
      mentionedFiles.add(filePath);
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
/**
 * Decode entity-escaped ampersands (&amp; → &) — #3611. Planners emit
 * <automated> bodies with `&amp;&amp;` as the chain operator (66 occurrences
 * vs 0 literal in the reporting repo), and the executing agent reads the
 * decoded (rendered) form. Every downstream scan — segment split,
 * zero-comparison, literal harvest, echo matching — must operate on the same
 * decoded text or a negative clause (`= 0`) poisons the literals of a
 * POSITIVE clause (-ge 3) joined to it. Shared by both plan-discipline
 * scanners so the two gates cannot drift apart again.
 */
function decodeEntityAmps(s: string): string {
  return s.replace(/&amp;/g, '&');
}

/**
 * Split one shell line into &&/|| segments, QUOTE-AWARE (#3611 adversarial
 * review): an operator inside a quoted literal (`grep -c 'a&&b'`) is part of
 * the pattern, not a chain operator — a quote-blind split destroys the
 * literal and silently disarms the gate for exactly the plans that spell
 * patterns with ampersands. Backslash escapes count inside double quotes
 * (POSIX single quotes have none, and over-staying a single-quoted span can
 * only miss a split, never invent one).
 */
function splitShellSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        current += ch + (line[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '&' && line[i + 1] === '&') || (ch === '|' && line[i + 1] === '|')) {
      segments.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  segments.push(current.trim());
  return segments.filter((s) => s !== '');
}

function scanNegativeGrepCommentEcho(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Normalize newlines; join backslash line-continuations so a verify command wrapped
  // across lines (grep ... \ <newline> == 0) is still seen as one segment.
  // #3611: decode entity-escaped ampersands (see decodeEntityAmps) so every
  // downstream scan reads the same decoded text the executing agent reads.
  const text = decodeEntityAmps((content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\\n/g, ' '));

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
  const segments = text.split('\n').flatMap(splitShellSegments);
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
  // #3611: the SAME entity decode as the #429 scanner — the two gates share
  // the caller and the input; a decode on one side only let an entity-escaped
  // chain poison this detector's harvest exactly the same way.
  const text = decodeEntityAmps((content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\\n/g, ' '));

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

    // Split gate text into shell segments (quote-aware, shared with #429 — #3611).
    const segments = taskA.gateText.split('\n').flatMap(splitShellSegments);

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

/**
 * Issue #4024 — quantitative-criteria trap-shape scanner, the third plan-discipline
 * gate in this family (after #429's comment-echo gate and #968's file-wide
 * negative-gate conflict detector). #429/#968 judge `grep -c … == 0` shapes; this
 * scanner judges the OTHER quantitative criterion shapes that are provably traps
 * at HEAD, so a plan whose criteria are unsatisfiable-or-vacuous before any
 * executor touches them no longer passes `verify plan-structure` clean.
 *
 * Scope: criteria text only — `<acceptance_criteria>`, `<automated>`, and
 * `<verify>` blocks. Prose elsewhere in the plan (e.g. an explanatory
 * `<action>`) is not judged (fail-open; see the negative-space section of the
 * #4024 diagnosis).
 *
 * Ban list, each rule with a corrected arm asserted in tests (a rule that fires
 * on its own fix is a refusal, not a rule):
 *   R1 (error) exact count out of `grep -c` with N ≥ 2 — `grep -c` counts LINES,
 *       not matches. Hedged counts (`>=`, "at least"), `== 0` (the #429/#968
 *       family) and the `== 1` presence idiom stay clean.
 *   R2 (error) bulk observed-failing claims — "all N tests … observed failing" /
 *       "tests N through M … each … observed failing". A test asserting a
 *       non-change cannot go red before the change exists. Per-test
 *       "discriminates" wording and subset claims stay clean.
 *   R3 (error) `$VAR` unquoted in command position — zsh does not word-split an
 *       unquoted expansion, the command exits 127, and any arm reading its
 *       status passes vacuously.
 *   R4 (warn)  a fallible command (`git …`) in a non-final pipeline stage — the
 *       pipeline reports the LAST stage's status, so the failure is swallowed.
 *       Warn-only: the shape is ambiguous unless the criterion reads the status.
 *   R5 (error) `wc` output compared by string equality (`… | wc -l | grep -x 0`)
 *       — BSD `wc` pads its output, so the comparison never matches.
 *   R6 (error) `git diff`/`git log` with a relative `HEAD~N` anchor — it names
 *       whatever commit happened to land (another session's). Bare `git diff`
 *       with no range is a WARNING: a committed change produces no output and
 *       the check passes, but an uncommitted-tree check is a legitimate idiom.
 *
 * Legitimate exit: `<!-- plan-criteria-allow: R# - reason -->` (house style of
 * `planner-discipline-allow`); the reason must be non-empty. Fail open: no
 * criteria zones → no findings; every parse is text-only, nothing executes.
 */
function scanQuantitativeCriteria(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Criteria zones: <acceptance_criteria>, <automated>, <verify>. A <verify>
  // block contains its <automated> child, so the same segment may be harvested
  // twice — dedupe findings by message below.
  const zones: { text: string; prose: boolean }[] = [];
  for (const tag of ['acceptance_criteria', 'automated', 'verify'] as const) {
    for (const block of extractTaggedBlocks(content || '', tag)) {
      zones.push({ text: block, prose: tag === 'acceptance_criteria' });
    }
  }
  if (zones.length === 0) return { errors, warnings };

  // Allow markers may sit anywhere in the plan (same as the sibling scanners).
  // The reason must be non-empty: `R1 - -->` is not an auditable exit.
  const allow = new Set<string>();
  const allowRe = /<!--\s*plan-criteria-allow:\s*(R[1-6])\s+-\s+([^>]*\S)\s*-->/g;
  let am: RegExpExecArray | null;
  while ((am = allowRe.exec(content || '')) !== null) allow.add(am[1]);

  const record = (bucket: string[], rule: string, message: string, seen: Set<string>): void => {
    if (allow.has(rule) || seen.has(message)) return;
    seen.add(message);
    bucket.push(message);
  };

  // A count-grep invocation (grep with -c / --count), per the #429 idiom.
  const countGrepRe =
    /grep((?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+)\s+(?:'[^']*'|"[^"]*"|[^\s|>&;]+)/g;
  const optsHaveCount = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*c[A-Za-z]*(?=\s|$)/.test(opts) || /--count\b/.test(opts);
  const hasCountGrep = (s: string): boolean => {
    countGrepRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = countGrepRe.exec(s)) !== null) {
      if (optsHaveCount(m[1])) return true;
    }
    return false;
  };

  const seenErr = new Set<string>();
  const seenWarn = new Set<string>();

  for (const zone of zones) {
    // Same normalization as the sibling scanners (#3611): newline join,
    // backslash continuation join, entity-amp decode.
    const text = decodeEntityAmps(zone.text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\\\n/g, ' '));

    // R2 — bulk observed-failing prose (acceptance_criteria only). The gap
    // [^\n.]{0,120} keeps the subject and the claim adjacent within one
    // sentence, so the corrected arm (a subset claim, or "each test
    // discriminates") never fires.
    if (zone.prose) {
      const bulkRedRes = [
        /\ball\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+tests\b[^\n.]{0,120}?observed\s+fail/i,
        /\btests\s+\d+\s+through\s+\d+\b[^\n.]{0,120}?observed\s+fail/i,
      ];
      for (const re of bulkRedRes) {
        if (re.test(text)) {
          record(
            errors,
            'R2',
            '[plan-criteria R2] A bulk "all N tests / tests N through M were observed failing" criterion is ' +
              'unsatisfiable whenever any of the N tests asserts a non-change, which cannot go red before the ' +
              'change exists. Say "each test discriminates" (fails before the change, passes after), and attach a ' +
              'mutation record for any test that cannot be seen red.',
            seenErr,
          );
        }
      }
    }

    for (const seg of text.split('\n').flatMap(splitShellSegments)) {
      // R1 — exact count out of `grep -c` (N ≥ 2). Spaced `==`/`-eq` (the
      // #429 zeroCmp idiom, excluding assignments and >=/<=/!=), or the prose
      // "returns exactly N".
      if (hasCountGrep(seg)) {
        const exact: number[] = [];
        let m: RegExpExecArray | null;
        const shellCmp = /\s==?\s*(\d+)\b/g;
        while ((m = shellCmp.exec(seg)) !== null) exact.push(parseInt(m[1], 10));
        const eqCmp = /-eq\s+(\d+)\b/g;
        while ((m = eqCmp.exec(seg)) !== null) exact.push(parseInt(m[1], 10));
        const proseCmp = /\breturns?\s+exactly\s+(\d+)\b/gi;
        while ((m = proseCmp.exec(seg)) !== null) exact.push(parseInt(m[1], 10));
        if (exact.some((n) => n >= 2)) {
          record(
            errors,
            'R1',
            '[plan-criteria R1] An exact count out of `grep -c` is a trap: `grep -c` counts LINES, not matches, ' +
              'so the criterion can be false at HEAD before any executor touches it. Use `>= 1`, `== 0`, or ' +
              '`grep -n` and read the line numbers.',
            seenErr,
          );
        }
      }

      // R3 — unquoted $VAR in command position (zsh does not word-split; the
      // command exits 127 and any arm reading its status passes vacuously).
      // The anchor tolerates a markdown list bullet and/or an inline-code
      // backtick before the command — criteria are prose lines like
      // "- `$NOKEY npx tsx x.ts` exits 0" — but nothing else: the expansion
      // must still be the FIRST token of the command itself.
      if (/^(?:[-*]\s*)?\u0060?\$[A-Z_][A-Z0-9_]*\s/.test(seg)) {
        record(
          errors,
          'R3',
          '[plan-criteria R3] `$VAR` unquoted in command position does not word-split under zsh — the shell ' +
            'looks for a command literally named by the whole expansion and exits 127, so any arm reading its ' +
            'status passes vacuously. Write the prefix inline or use a shell function.',
          seenErr,
        );
      }

      // R4 — a fallible `git …` in a non-final pipeline stage: the pipeline
      // reports the LAST stage's status, so git's failure is swallowed.
      // Warn-only: without a status assertion the shape is ambiguous.
      // Not a markdown table: the negated-pipe class matches a SHELL pipeline
      // stage boundary (git before the next `|`), the same shape the
      // #429/#968 scanners use; there is no table row to parse.
      // allow-adhoc-markdown: shell pipeline stage boundary, not a table cell (#4024)
      if (/\bgit\s+[a-z][^\n|]*\|/.test(seg)) {
        record(
          warnings,
          'R4',
          '[plan-criteria R4] A fallible `git` in a non-final pipeline stage is swallowed — the pipeline reports ' +
            'the last stage\'s status, so a broken command reads as clean. Capture the status first.',
          seenWarn,
        );
      }

      // R5 — `wc` output compared by string equality: BSD `wc` pads its output
      // (seven spaces then the number), so `grep -x 0` can never match.
      if (/\bwc\b/.test(seg) && /\bgrep\s+(?:-{1,2}[A-Za-z]*x[A-Za-z]*|--line-regexp)\s+['"]?\d+['"]?/.test(seg)) {
        record(
          errors,
          'R5',
          '[plan-criteria R5] `wc` output compared by string equality is unsatisfiable on BSD `wc`, which pads ' +
            'its output before the number. Compare numerically: `test "$n" -eq 0`, or `tr -d \' \'` first.',
          seenErr,
        );
      }

      // R6 — relative HEAD~N anchors name whatever commit happened to land;
      // a bare `git diff` with no range makes a committed change invisible.
      if (/\bgit\s+(?:diff|log)\b[^\n|;&]*\bHEAD~\d+/.test(seg)) {
        record(
          errors,
          'R6',
          '[plan-criteria R6] `git diff`/`git log` with a relative `HEAD~N` anchor names whatever commit ' +
            'happened to land last — in a repository with parallel sessions that is another session\'s commit. ' +
            'Pin an explicit range: `<sha>^..<sha>`.',
          seenErr,
        );
      } else {
        // The argument span ends at the closing backtick of an inline-code
        // span ("`git diff` shows ..."), at a redirection, or at a chain
        // operator — trailing prose must never read as diff arguments.
        const bareDiff = /\bgit\s+diff\b([^\u0060\n|;&<>]*)/.exec(seg);
        if (bareDiff) {
          const rest = bareDiff[1].trim();
          // Bare or flags-only (no rev, range, or path): ambiguous between an
          // uncommitted-tree check (legitimate) and a committed-change check
          // (vacuously clean) — warn, never error.
          if (rest === '' || /^-{1,2}[A-Za-z-]+$/.test(rest)) {
            record(
              warnings,
              'R6',
              '[plan-criteria R6] Bare `git diff` with no revision range produces no output for a COMMITTED ' +
                'change, so the criterion passes vacuously. Pin an explicit range (`<sha>^..<sha>`) unless the ' +
                'check is intentionally about the uncommitted tree.',
              seenWarn,
            );
          }
        }
      }
    }
  }

  return { errors, warnings };
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
      // #3193: child-tag presence uses /<tag[\s>]/ (attribute-tolerant) so an
      // opener like <verify type="auto"> still counts as present, matching how
      // the parent <task type="…"> is read by PLAN_TASK_BLOCK_RE. The [\s>]
      // terminator (not \b) keeps <verify> from satisfying <verification> and
      // prevents a hyphenated sibling like <verify-mode> from masking <verify>.
      hasFiles: /<files[\s>]/.test(body),
      hasAction: /<action[\s>]/.test(body),
      hasVerify: /<verify[\s>]/.test(body),
      hasDone: /<done[\s>]/.test(body),
      hasWhatBuilt: /<what-built[\s>]/.test(body),
      hasHowToVerify: /<how-to-verify[\s>]/.test(body),
      hasDecision: /<decision[\s>]/.test(body),
      hasOptions: /<options[\s>]/.test(body),
      hasInstructions: /<instructions[\s>]/.test(body),
      hasVerification: /<verification[\s>]/.test(body),
      hasResumeSignal: /<resume-signal[\s>]/.test(body),
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

  // #4024: quantitative-criteria trap shapes (exact grep -c counts, bulk
  // observed-failing claims, $VAR command position, swallowed pipeline
  // stages, wc string-equality, relative git anchors).
  const quantScan = scanQuantitativeCriteria(content);
  errors.push(...quantScan.errors);
  warnings.push(...quantScan.warnings);

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

  // #3183 (lint-plan-count-drift / ADR-3180 Decision 2): source plans/
  // summaries and their pairing from the single owner (scanPhasePlans +
  // findUnsummarizedPlans/findOrphanSummaries) instead of a bespoke
  // root-only `-PLAN.md`/`-SUMMARY.md` filter and exact-suffix-stem
  // Set-diff. The prior pairing missed bare PLAN.md/SUMMARY.md, nested
  // (#3139 layout) plans, and any of the canonical pairing's other
  // recognized naming forms — producing false "Plans without summaries" /
  // "Summaries without plans" for names it could not recognize as paired
  // (the same failure class #1988/#2648 fixed for the owner's own callers).
  const scan = planScanMod.scanPhasePlans(phaseDir);
  if (scan.scope === SCOPE.UNREADABLE) {
    output({ error: 'Cannot read phase directory' }, raw);
    return;
  }
  const { planFiles, summaryFiles } = scan;

  const incompletePlans = findUnsummarizedPlans(planFiles, summaryFiles);
  if (incompletePlans.length > 0) {
    errors.push(`Plans without summaries: ${incompletePlans.join(', ')}`);
  }

  const orphanSummaries = findOrphanSummaries(planFiles, summaryFiles);
  if (orphanSummaries.length > 0) {
    warnings.push(`Summaries without plans: ${orphanSummaries.join(', ')}`);
  }

  output(
    {
      complete: errors.length === 0,
      phase: phaseInfo['phase_number'],
      plan_count: planFiles.length,
      summary_count: summaryFiles.length,
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
  // Positive-evidence floor (#3956): a non-empty artifacts block whose items are
  // all bare strings / path-less objects is item-by-item skipped, leaving results
  // empty; `passed === results.length` would then be `0 === 0` → a vacuous GREEN
  // over zero checks. Require at least one checked artifact, mirroring the
  // no-vacuous-pass rule at src/uat-predicate.cts. The fully-empty block is still
  // caught earlier by the `artifacts.length === 0` guard and returns its error.
  const allPassed = results.length > 0 && passed === results.length;
  output(
    {
      all_passed: allPassed,
      passed,
      total: results.length,
      artifacts: results,
    },
    raw,
    allPassed ? 'valid' : 'invalid',
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

    const fromRaw = link['from'];
    const fromPath = typeof fromRaw === 'string' ? fromRaw : '';
    let sourceContent: string | null = null;
    if (fromPath !== '') {
      // An empty/missing `from:` is a malformed plan, not a path-confinement
      // violation — validatePath's traversal check (and path_rejected) only
      // applies to a non-empty path that actually resolves outside the
      // project. Leave sourceContent as null so the existing not-found /
      // pending classification below runs unchanged. Note this guard is
      // narrower than it may look: `from: "."` is a non-empty string, so it
      // still reaches validatePath and safeReadFile below, and DOES read the
      // cwd directory (yielding "Source read failed: EISDIR") — this branch
      // only short-circuits the true empty-string case.
      const fromCheck = validatePath(fromPath, cwd);
      if (!fromCheck.safe) {
        // Do not echo result.error — it embeds absolute host paths.
        check['path_rejected'] = 'from';
        check['detail'] = 'Source path rejected — resolves outside the project directory';
        results.push(check);
        continue;
      }
      try {
        sourceContent = safeReadFile(fromCheck.resolved);
      } catch (err) {
        // Report the errno only — never the message or path (untrusted `from:`
        // can trigger EISDIR/EACCES, which platformReadSync re-throws for any
        // non-ENOENT errno). A single bad link must not abort the whole command.
        const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
        check['detail'] = `Source read failed: ${code}`;
        results.push(check);
        continue;
      }
    }
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
      const pat = compileUserPattern(link['pattern']);
      if (pat.neutralized !== null) {
        // A neutralized pattern was refused and never compiled — that is NOT
        // the check the plan author wrote, so it must never report verified
        // regardless of what an unrelated fallback might otherwise have
        // matched (#3477 regression: pattern "(" previously neutralized to a
        // literal-escaped match that matched nearly any source file,
        // producing a false verified: true / all_verified: true). The engine
        // itself now guarantees `test()` returns false for a refused
        // pattern; this explicit branch exists to produce the good message.
        // The match-and-report path below is skipped entirely rather than
        // run and then overwritten, which used to leave a misleading
        // "Pattern found in source" detail alongside the neutralization note.
        check['pattern_neutralized'] = pat.neutralized;
        let reason: string;
        switch (pat.neutralized) {
          case 'empty':
            reason = 'pattern is not a usable string — no match attempted';
            break;
          case 'too-long':
            reason = `pattern exceeded ${MAX_USER_PATTERN_LEN} chars — not evaluated`;
            break;
          case 'unsupported':
            reason = 'pattern is not valid RE2 syntax — backreferences and look-around are not supported';
            break;
        }
        check['detail'] = `Pattern not verified (${reason})`;
      } else {
        try {
          if (pat.test(sourceContent)) {
            check['verified'] = true;
            check['detail'] = 'Pattern found in source';
          } else {
            const toRaw = link['to'];
            const toPath = typeof toRaw === 'string' ? toRaw : '';
            let targetContent: string | null = null;
            if (toPath !== '') {
              // An empty/missing `to:` is a malformed plan, not a
              // path-confinement violation — only a non-empty path that
              // actually resolves outside the project is path_rejected.
              const toCheck = validatePath(toPath, cwd);
              if (!toCheck.safe) {
                // Do not read a rejected `to:` — treat as no target content
                // and do not echo result.error, which embeds absolute host
                // paths.
                check['path_rejected'] = 'to';
                check['detail'] = `Pattern "${link['pattern'] as string}" not found in source; target path rejected — resolves outside the project directory`;
              } else {
                targetContent = safeReadFile(toCheck.resolved);
              }
            }
            if (targetContent && pat.test(targetContent)) {
              check['verified'] = true;
              check['detail'] = 'Pattern found in target';
            } else if (!check['path_rejected']) {
              check['detail'] = `Pattern "${link['pattern'] as string}" not found in source or target`;
            }
          }
        } catch (err) {
          // Report the errno only — never the full error/message, which for a
          // re-thrown non-ENOENT platformReadSync failure (e.g. EISDIR from an
          // untrusted `to:` like "../..") embeds an absolute filesystem path.
          const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
          check['detail'] = `Pattern check failed: ${code}`;
        }
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
  // Positive-evidence floor (#3956): an all-bare-string key_links block skips
  // every item (only `typeof link === 'string'` items are continue-skipped
  // above), leaving results empty; `hardFailed === 0` would then be a vacuous
  // GREEN over zero checks. Require at least one checked link. (A `from:`-less
  // object is NOT skipped, unlike a path-less object on the artifacts side — it
  // falls through to a `verified: false` result and hard-fails, so it was never
  // part of the vacuous-pass surface; only the all-bare-string case is.) A
  // pending link IS pushed to results (with pending: true), so an all-pending
  // block still satisfies results.length > 0 and its #1202 non-hard-failing
  // semantics are unchanged — the floor only rejects the zero-result case.
  const allVerified = results.length > 0 && hardFailed === 0;
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

interface IssueEntry {
  code: string;
  message: string;
  fix: string;
  repairable: boolean;
}

/**
 * Wrapper-level fix-text table for `cmdValidateHealth`'s migrated
 * `HealthDiagnostic` -> `IssueEntry` mapping (Phase 11, #3309). Rules cannot
 * call `slash()` (forbidden ambient I/O, §8.1 rule 1) so every REPAIRABLE
 * (non-ADVISE) diagnostic's `fix` text — which the pre-migration code always
 * built via `${slash('health')} --repair|--backfill ...` — is reconstructed
 * HERE instead, keyed by `remedy.action`. Each real repair action maps 1:1
 * back to exactly one pre-migration code (confirmed: no `REMEDY_ACTION`
 * other than `ADVISE` is used by more than one rule in the migrated table),
 * so this table reproduces the original `fix` text byte-for-byte, including
 * its `slash()` calls, without the RULE ever needing to know about `slash`.
 * Source line refs are the exact pre-migration `addIssue(...)` call each
 * text was copied from:
 *   - createConfig      — verify.cts:1782 (W003)
 *   - resetConfig        — verify.cts:1830 (E005)
 *   - regenerateState     — verify.cts:1702 (E004)
 *   - addNyquistKey       — verify.cts:1847 (W008)
 *   - addAiIntegrationPhaseKey — verify.cts:1857 (W016)
 *   - backfillMilestones  — verify.cts:2326 (W018)
 * ADVISE diagnostics do NOT go through this table — their `fix` is
 * `diagnostic.remedy.args.command` directly (already a complete, final
 * string baked in by the rule, confirmed via
 * `src/health-diagnostic-rules/root-existence.cts`/`config-validation.cts`).
 */
function repairFixText(slash: (name: string) => string, action: string): string {
  switch (action) {
    case REMEDY_ACTION.CREATE_CONFIG:
      return `Run ${slash('health')} --repair to create with defaults`;
    case REMEDY_ACTION.RESET_CONFIG:
      return `Run ${slash('health')} --repair to reset to defaults`;
    case REMEDY_ACTION.REGENERATE_STATE:
      return `Run ${slash('health')} --repair to regenerate`;
    case REMEDY_ACTION.ADD_NYQUIST_KEY:
    case REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY:
      return `Run ${slash('health')} --repair to add key`;
    case REMEDY_ACTION.BACKFILL_MILESTONES:
      return `Run ${slash('health')} --backfill to synthesize missing entries from archive snapshots`;
    default:
      return '';
  }
}

/**
 * Map one `HealthDiagnostic` (rule-table shape) back onto the legacy
 * `IssueEntry` shape `cmdValidateHealth` has always returned (design doc,
 * "Output-shape preservation" section).
 *
 * `repairable` for a DESTRUCTIVE-risk remedy (regenerateState/resetConfig)
 * is `false` here — NOT the pre-migration `true` those two codes always
 * carried. This is a deliberate, disclosed decision (see this batch's
 * dispatch report): the design doc's own "`--repair` behavior change"
 * section establishes that `--repair` never actually applies a DESTRUCTIVE
 * remedy post-migration, so marking it `repairable: true` would mislead a
 * caller that uses this field to decide whether re-running with `--repair`
 * will fix anything. `repairable` now means "an automatic repair will
 * actually run", not merely "a remedy exists to describe" — the more
 * conservative of the two readings the brief identified, chosen because the
 * question was genuinely ambiguous and this reading cannot itself cause a
 * caller to skip a fix that would have worked.
 */
function diagnosticToIssueEntry(diagnostic: HealthDiagnostic, slash: (name: string) => string): IssueEntry {
  const { code, message, remedy } = diagnostic;
  if (remedy.action === REMEDY_ACTION.ADVISE) {
    return { code, message, fix: remedy.args['command'] as string, repairable: false };
  }
  return {
    code,
    message,
    fix: repairFixText(slash, remedy.action),
    repairable: remedy.risk !== REMEDY_RISK.DESTRUCTIVE,
  };
}

function cmdValidateConsistency(cwd: string, raw: boolean): void {
  const planBase = planningDir(cwd);
  const roadmapPath = path.join(planBase, 'ROADMAP.md');
  const errors: string[] = [];
  const warnings: IssueEntry[] = [];

  // Pre-check, stays OUTSIDE the rule table — same shape as `validate.health`'s
  // E001/E010/I010 (design doc, "Which rules run where"). `.planning/` cannot
  // build a `PlanningSnapshot` worth evaluating without a ROADMAP.md to read.
  if (!fs.existsSync(roadmapPath)) {
    errors.push('ROADMAP.md not found');
    output({ passed: false, errors, warnings }, raw, 'failed');
    return;
  }

  // ─── Rule-table evaluation (Phase 12, #3310) ───────────────────────────────
  // Replaces this function's entire hand-rolled disk-vs-roadmap /
  // numbering-gap / orphan-summary / wave-missing scan — see the design
  // doc's "Which rules run where" section. `evaluateConsistencyRules` runs
  // W006/W007 (the SAME `Rule` objects `validate.health` evaluates, reused
  // verbatim — not a second, independently-drifting copy) plus the four new
  // C001-C004 rules, against the same `PlanningSnapshot` `validate.health`
  // builds.
  const snapshot = buildPlanningSnapshot(cwd);
  const diagnostics = evaluateConsistencyRules(snapshot);

  // Every current C0NN/W006/W007 diagnostic is `SEVERITY.WARNING` (confirmed
  // by direct read of `consistency.cts`/`roadmap-disk-consistency.cts`) —
  // matching the pre-migration shape, where only the ROADMAP-missing
  // pre-check above ever populated `errors`. Bucketed defensively by
  // severity anyway, mirroring `cmdValidateHealth`'s own pattern, so a
  // future ERROR-severity rule added to `CONSISTENCY_RULES` lands in the
  // right bucket without another migration.
  const _slashRuntime = resolveRuntime(cwd);
  const slash = (name: string) => formatGsdSlash(name, _slashRuntime) as string;
  for (const diagnostic of diagnostics) {
    const entry = diagnosticToIssueEntry(diagnostic, slash);
    if (diagnostic.severity === HEALTH_SEVERITY.ERROR) errors.push(entry.message);
    else warnings.push(entry);
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

  // rootBase resolves to the PROJECT-scoped planning root (`.planning[/<project>]`
  // — PROJECT.md, config.json live here; #3749). Workstream-free by construction:
  // planningDir(cwd, null) honors GSD_PROJECT and suppresses GSD_WORKSTREAM.
  const rootBase = planningDir(cwd, null);
  const _slashRuntime = resolveRuntime(cwd);
  const slash = (name: string) => formatGsdSlash(name, _slashRuntime) as string;

  // Second (and last) pre-check that stays OUTSIDE the rule table entirely
  // (design doc, "Two guards that stay OUTSIDE the rule table entirely" —
  // this one must run BEFORE any snapshot is built, since a flat
  // `evaluateRules` pass over an entirely-absent `.planning/` would produce
  // spurious per-rule clutter no one asked for, not a clean E001-only
  // report).
  if (!fs.existsSync(rootBase)) {
    const errors: IssueEntry[] = [
      {
        code: 'E001',
        message: '.planning/ directory not found',
        fix: `Run ${slash('new-project')} to initialize`,
        repairable: false,
      },
    ];
    output({ status: 'broken', errors, warnings: [], info: [], repairable_count: 0 }, raw);
    return;
  }

  // ─── Rule-table evaluation (Phase 11, #3309) ───────────────────────────────
  // Replaces the entire hand-rolled addIssue/switch accumulation this
  // function used to run inline (verify.cts, pre-migration) — see the
  // design doc's "Output-shape preservation" section for the exact
  // Diagnostic -> IssueEntry mapping contract this reproduces.
  const snapshot = buildPlanningSnapshot(cwd);
  const diagnostics = evaluateRules(snapshot);

  const errors: IssueEntry[] = [];
  const warnings: IssueEntry[] = [];
  const info: IssueEntry[] = [];
  for (const diagnostic of diagnostics) {
    const entry = diagnosticToIssueEntry(diagnostic, slash);
    if (diagnostic.severity === HEALTH_SEVERITY.ERROR) errors.push(entry);
    else if (diagnostic.severity === HEALTH_SEVERITY.WARNING) warnings.push(entry);
    else info.push(entry);
  }

  // W024 (#2573): STATE.md commit-age freshness — kept OUTSIDE the rule
  // table, exactly like E001/E010/I010 above. NOT a preservation nicety: the
  // committed `RULE_W024` (`src/health-diagnostic-rules/state-consistency.cts`)
  // is a documented PERMANENT no-op (`check` always returns `[]`) because
  // `readStateHeadFreshness`'s `git log` shell-out is ambient I/O a
  // `Rule.check(snapshot)` may never perform (§8.1 rule 1) and no
  // `PlanningSnapshot` field carries a commits-behind count. Migrating
  // `cmdValidateHealth` onto the rule table as designed would silently
  // regress `tests/health-validation.test.cjs`'s "W024 — STATE.md commit-age
  // freshness advisory" suite (7 currently-passing tests exercising the REAL
  // git-based check end-to-end) — found while wiring this function to the
  // rule table, fixed inline per this repo's no-defer policy rather than
  // silently accepting the loss. `cmdValidateHealth` itself (unlike a Rule)
  // is licensed to perform its own bounded I/O — the same license
  // `applyRepairs` already relies on (see `health-diagnostic.cts`'s header
  // comment) — so this reproduces the exact pre-migration check
  // (`verify.cts`, W024) verbatim, advisory-only: it only ever appends to
  // `warnings`, never touches `status`/`errors`/the repair set.
  {
    const wsBase = planningDir(cwd);
    const statePath = path.join(wsBase, 'STATE.md');
    if (fs.existsSync(statePath)) {
      try {
        const stateContent = fs.readFileSync(statePath, 'utf-8');
        const fm = extractFrontmatter(stateContent) as Record<string, unknown>;
        const freshness = readStateHeadFreshness(cwd, fm['state_head']);
        if (
          freshness.commits_behind !== null &&
          freshness.commits_behind >= STATE_HEAD_ADVISORY_COMMITS
        ) {
          warnings.push({
            code: 'W024',
            message: `STATE.md was written ${freshness.commits_behind} commits ago (at ${freshness.state_head}) — treat its contents as approximate`,
            fix: 'Re-read the current phase artifacts before relying on STATE.md, or run a GSD command that refreshes it',
            repairable: false,
          });
        }
      } catch {
        /* intentionally empty — W024 is advisory */
      }
    }
  }

  // ─── Perform repairs if requested ─────────────────────────────────────────
  // `applyRepairs` internally no-ops (produces zero `details` rows, no
  // filesystem writes) when both `repair` and `backfill` are falsy, so this
  // call is unconditional — mirroring the original's own
  // `if (options['repair'] && repairs.length > 0)` gate without needing to
  // duplicate that condition here. `backfill` is threaded through as its own
  // boolean (not folded into `repair`), which is what makes `--backfill`
  // alone now actually trigger `backfillMilestones` — the disclosed latent-
  // bug fix from `verify.cts:2504`'s previously-unreachable inner gate (see
  // design doc "Known limits").
  const repairResult = applyRepairs(cwd, diagnostics, Boolean(options['repair']), Boolean(options['backfill']));
  // The legacy `repairs_performed` shape never carried a `code` field —
  // strip it before it reaches JSON output.
  const repairActions = repairResult.details.map(({ code: _code, ...rest }) => rest);

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
  const runtime = resolveRuntime(cwd);
  const agentStatus = checkAgentsInstalled(runtime, cwd);
  const expected = Object.keys(MODEL_PROFILES);
  // #3242 ADR-2313 D6 — additive: validates posture (never an Anthropic-flavored
  // model or an orphaned reasoning-effort pin in a Codex agent .toml), not just
  // presence. checkAgentsInstalled above is untouched.
  const codexPosture = checkCodexModelPosture(runtime, cwd);
  // #3897 rung 3 (ADR-3473 §8.3 criterion 3) — sibling posture check, additive
  // alongside codex_posture (never nested inside it, never replacing it): a
  // TOML's `sandbox_mode` disagreeing with its role's derived expectation is a
  // different defect class than an Anthropic-flavored model. Same short-circuits,
  // same read-only posture as checkCodexModelPosture above; checkAgentsInstalled
  // and codex_posture are both left untouched.
  //
  // Failure semantics: matches the checkCodexModelPosture precedent exactly.
  // Neither posture check makes `validate agents` exit non-zero on its own —
  // both are report-only fields inspected by the caller (or a human) via the
  // JSON payload. A `validate` verb whose two posture checks disagreed on
  // fatality would be its own defect (#3897 dispatch note); this keeps them
  // consistent rather than inventing new exit-code behavior for only one of
  // the two siblings.
  const sandboxPosture = checkCodexSandboxPosture(runtime, cwd);

  output(
    {
      agents_dir: agentStatus.agents_dir,
      agents_found: agentStatus.agents_installed,
      installed: agentStatus.installed_agents,
      missing: agentStatus.missing_agents,
      incomplete: agentStatus.incomplete_agents,
      expected,
      codex_posture: codexPosture,
      sandbox_posture: sandboxPosture,
    },
    raw,
  );
}

// ─── Context drift (#3348) ───────────────────────────────────────────────────

/**
 * Resolve a phase directory under `phasesDir` from a user-supplied `phaseArg`,
 * via the canonical phase-directory matcher (phase-id.cjs::matchPhaseDirs) rather
 * than a naive substring test — a bare `.includes(phaseArg)` lets a non-existent
 * phase silently match a different phase whose directory name merely contains the
 * requested token (e.g. "1" matching "11-expansion"). Falls back to an exact
 * directory-name match. Returns null if neither resolves. (#1571, #2528)
 */
function resolvePhaseDirByToken(phasesDir: string, phaseArg: string): string | null {
  const normalizedPhase = normalizePhaseName(phaseArg);
  const dirEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
  const dirNames = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  const matched = matchPhaseDirs(dirNames, normalizedPhase).matches[0];
  if (matched) return path.join(phasesDir, matched);
  const check = validatePath(phaseArg, phasesDir);
  if (check.safe && fs.existsSync(check.resolved)) return check.resolved;
  return null;
}

interface ContextDriftEntry {
  file: string;
  effectiveMs: number;
}

/**
 * Pure comparator: which of `entries` have an effective last-changed time
 * STRICTLY BEFORE `contextEffectiveMs` (CONTEXT.md's own effective time)? Strict
 * `<` is "stale" (matches findStaleVerificationSummary's own strict `>` convention
 * for "newer than" elsewhere in this codebase — an artifact committed in the SAME
 * commit/second as CONTEXT.md is in sync, not stale).
 */
function computeContextDrift(contextEffectiveMs: number, entries: ContextDriftEntry[]): string[] {
  return entries.filter((e) => e.effectiveMs < contextEffectiveMs).map((e) => e.file);
}

function buildContextDriftMessage(staleArtifacts: string[], phaseArg: string): string {
  const parts = [`CONTEXT.md decisions are newer than: ${staleArtifacts.join(', ')}.`];
  if (staleArtifacts.some((f) => f.endsWith('-RESEARCH.md'))) {
    parts.push(`Regenerate research: /gsd:plan-phase ${phaseArg} --research.`);
  }
  if (staleArtifacts.some((f) => f.endsWith('-PATTERNS.md'))) {
    parts.push('Regenerate patterns: delete the PATTERNS.md file, then re-run /gsd:plan-phase.');
  }
  if (
    staleArtifacts.some(
      (f) => f.endsWith('-VALIDATION.md') || (f.endsWith('-SPEC.md') && !f.endsWith('-AI-SPEC.md') && !f.endsWith('-UI-SPEC.md')),
    )
  ) {
    parts.push('Regenerate or manually reconcile VALIDATION.md / SPEC.md against the current decisions.');
  }
  parts.push('Do not hand-inject the newer decisions into a prompt as a substitute for regenerating — that carries the staleness forward.');
  return parts.join(' ');
}

function cmdVerifyContextDrift(cwd: string, phaseArg: string | undefined, raw: boolean): void {
  if (!phaseArg) {
    error('Usage: verify context-drift <phase>');
    return;
  }

  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  const emitSkip = (reason: string, message = ''): void => {
    output({ block: false, skipped: true, reason, stale_artifacts: [], message }, raw);
  };

  if (!fs.existsSync(phasesDir)) {
    emitSkip('phase-not-found', `Phase directory not found: ${phaseArg}`);
    return;
  }

  // Same phase-directory resolution rule cmdVerifySchemaDrift uses (#1571, #2528):
  // matchPhaseDirs, never a naive substring test.
  const phaseDir = resolvePhaseDirByToken(phasesDir, phaseArg);
  if (!phaseDir) {
    emitSkip('phase-not-found', `Phase directory not found: ${phaseArg}`);
    return;
  }

  let phaseFiles: string[];
  try {
    phaseFiles = fs.readdirSync(phaseDir).slice().sort();
  } catch {
    emitSkip('phase-not-found', `Phase directory not found: ${phaseArg}`);
    return;
  }

  const contextFile = phaseFiles.find((f) => f.endsWith('-CONTEXT.md'));
  if (!contextFile) {
    emitSkip('no-context-md');
    return;
  }

  const researchFile = phaseFiles.find((f) => f.endsWith('-RESEARCH.md'));
  const patternsFile = phaseFiles.find((f) => f.endsWith('-PATTERNS.md'));
  const validationFile = phaseFiles.find((f) => f.endsWith('-VALIDATION.md'));
  const specFile = phaseFiles.find(
    (f) => f.endsWith('-SPEC.md') && !f.endsWith('-AI-SPEC.md') && !f.endsWith('-UI-SPEC.md'),
  );
  const upstreamFiles = [researchFile, patternsFile, validationFile, specFile].filter(
    (f): f is string => !!f,
  );

  if (upstreamFiles.length === 0) {
    emitSkip('no-upstream-artifacts');
    return;
  }

  const allFiles = [contextFile, ...upstreamFiles];
  const cleanCommitMs = defaultPhaseCleanCommitTimesMs(phaseDir, allFiles);
  const effectiveTimeMs = (file: string): number =>
    cleanCommitMs.has(file)
      ? (cleanCommitMs.get(file) as number)
      : fs.statSync(path.join(phaseDir, file)).mtimeMs;

  const contextMs = effectiveTimeMs(contextFile);
  const driftEntries: ContextDriftEntry[] = upstreamFiles.map((f) => ({ file: f, effectiveMs: effectiveTimeMs(f) }));
  const staleArtifacts = computeContextDrift(contextMs, driftEntries);

  let wf: Record<string, unknown> | undefined;
  try {
    const rawCfg = JSON.parse(fs.readFileSync(path.join(pDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    wf = rawCfg['workflow'] as Record<string, unknown> | undefined;
  } catch {
    wf = undefined;
  }
  const action = wf?.context_drift_action === 'block' ? 'block' : 'warn';
  const block = staleArtifacts.length > 0 && action === 'block';
  const message = staleArtifacts.length > 0 ? buildContextDriftMessage(staleArtifacts, phaseArg) : '';

  output(
    {
      block,
      skipped: false,
      stale_artifacts: staleArtifacts,
      action,
      message,
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

  // Resolve the phase directory with the canonical phase-directory matcher
  // (phase-id.cjs::matchPhaseDirs), not a naive substring test. A bare
  // `.includes(phaseArg)` lets a non-existent phase silently match a different
  // phase whose directory name merely contains the requested token (e.g. "1"
  // matching "11-expansion"), making the drift gate inspect the wrong phase.
  // This shares the one selection rule with find-phase / verify
  // phase-completeness rather than restating it. (#1571, #2528)
  const phaseDir = resolvePhaseDirByToken(phasesDir, phaseArg);

  if (!phaseDir) {
    output(
      { block: false, drift_detected: false, blocking: false, message: `Phase directory not found: ${phaseArg}` },
      raw,
    );
    return;
  }

  // #3183: canonical LIVE plan/summary sets (root+nested,
  // status: superseded EXCLUDED) from the single owner, rather than a
  // root-only readdirSync filter — a superseded plan's claimed
  // files_modified is no longer treated as an expected drift target, and
  // nested (#3139 layout) plans/summaries are no longer invisible to the
  // drift check.
  const { planFiles, summaryFiles } = planScanMod.scanPhasePlans(phaseDir);

  const allFiles: string[] = [];
  for (const pf of planFiles) {
    const content = fs.readFileSync(path.join(phaseDir, pf), 'utf-8');
    const fmMatch = content.match(/files_modified:\s*\[([^\]]{0,8000})\]/);
    if (fmMatch) {
      const files = fmMatch[1].split(',').map((f) => f.trim()).filter(Boolean);
      allFiles.push(...files);
    }
  }

  let executionLog = '';
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

/**
 * Stamp `last_mapped_commit` (plus `last_mapped_at`) into the frontmatter of
 * every codebase-map document that exists on disk, using the current HEAD sha.
 *
 * #3418: `drift.cjs` shipped a correct `writeMappedCommit` with no production
 * caller, so no full `/gsd:map-codebase` run ever wrote the machine-readable
 * baseline that `cmdVerifyCodebaseDrift` reads. The stamp lives in CODE rather
 * than in a prose instruction to the mapper agent on purpose: an agent that
 * decides its work is already done skips a prose step silently, which is the
 * exact class of failure the stamp exists to detect.
 *
 * Only documents that already exist are stamped -- a `--fast` map produces four
 * of the seven, and this must not conjure the missing three as frontmatter-only
 * stubs that would then satisfy the seven-file completeness probe. `only`
 * (`--files a.md,b.md`) narrows further, for a caller that refreshed a subset.
 *
 * Non-blocking by contract, like every other drift surface: any failure emits
 * `skipped` with a reason and exits 0.
 */
function cmdStampCodebaseMap(cwd: string, raw: boolean, only?: string[]): void {
  // Non-hoisted: load-order matters for circular dep guard
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- drift.cjs is an export= CommonJS module
  const drift = require('./drift.cjs') as Record<string, unknown>;

  const emit = (payload: unknown) => output(payload, raw);

  const skip = (reason: string) => ({
    stamped: [],
    commit: null,
    stamped_at: null,
    skipped: true,
    reason,
  });

  try {
    // Probed outside the lock on purpose: taking the lock creates `.planning/`
    // if absent, and a stamp against a project that has no codebase map at all
    // must not conjure the directory. The per-document existence check inside
    // the lock is the one that matters -- a map deleted after this probe lands
    // on `no-codebase-map` there rather than being recreated as stubs.
    const codebaseDir = path.join(planningDir(cwd), 'codebase');
    if (!fs.existsSync(codebaseDir)) {
      emit(skip('no-codebase-dir'));
      return;
    }

    // `--files` restricts the stamp to the documents a caller actually
    // refreshed. The execute-phase auto-remap path rewrites STRUCTURE.md and
    // ARCHITECTURE.md only; stamping the other five at HEAD there would claim a
    // currency they do not have. Membership is checked against the closed
    // seven-document set, so an unknown name is a fail-loud non-answer rather
    // than a path this function tries to resolve. An empty value is refused
    // rather than read as "no filter": a caller that meant to narrow the scope
    // must not silently widen it to all seven.
    let candidates = REQUIRED_CODEBASE_MAP_FILES;
    if (only) {
      if (only.length === 0) {
        emit(skip('empty-codebase-map-file-filter'));
        return;
      }
      const unknown = only.filter((file) => !candidates.includes(file));
      if (unknown.length > 0) {
        emit(skip('unknown-codebase-map-file: ' + unknown.join(',')));
        return;
      }
      candidates = candidates.filter((file) => only.includes(file));
    }

    // Everything the stamp reads is read under the lock it writes under, the
    // same lock the rest of the .planning/ writers take. Two stampers can run
    // at once (the full map-codebase run and the execute-phase auto-remap);
    // one that resolved HEAD or listed the present documents before waiting on
    // the lock would write its now-stale sha over the newer one, or recreate a
    // document deleted while it waited as a frontmatter-only stub.
    const result = withPlanningLock(cwd, () => {
      const revProbe = execGit(['rev-parse', 'HEAD'], { cwd }) as unknown as { exitCode: number; stdout: string };
      if (revProbe.exitCode !== 0) return skip('not-a-git-repo');
      const commit = revProbe.stdout.trim();
      if (!/^[0-9a-f]{7,40}$/.test(commit)) return skip('unreadable-head');

      const present = candidates.filter((file) =>
        fs.existsSync(path.join(codebaseDir, file)),
      );
      if (present.length === 0) return skip('no-codebase-map');

      // Host-local calendar day, matching the `**Analysis Date:**` line the
      // mapper agent writes -- the two freshness markers must not disagree by
      // a timezone.
      const stampedAt = realClock.localToday();
      const write = drift['writeMappedCommit'] as (f: string, sha: string, iso: string) => void;

      const stamped: string[] = [];
      const failed: { file: string; reason: string }[] = [];
      for (const file of present) {
        try {
          write(path.join(codebaseDir, file), commit, stampedAt);
          stamped.push(file);
        } catch (err) {
          // One unwritable document must not cost the stamp on the other six.
          failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      return { stamped, failed, commit, stamped_at: stampedAt, skipped: false, reason: null };
    });

    emit(result);
  } catch (err) {
    emit(skip('exception: ' + (err instanceof Error ? err.message : String(err))));
  }
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

    // #3418: an absent or unresolvable baseline means NO COMPARISON IS POSSIBLE.
    // It is neither zero drift nor total drift, and reporting it as either is a
    // lie the consumer cannot detect. The former fallback diffed HEAD against
    // the empty tree, so every tracked file read as newly added and the gate
    // reported maximum drift identically on every run -- which made a genuinely
    // stale map indistinguishable from a fresh one, and let `spawn_mapper` fire
    // a whole-repo remap while presenting itself as an incremental one.
    if (!lastMapped) {
      emit({
        block: false,
        skipped: true,
        reason: 'no-mapped-commit',
        action_required: false,
        directive: 'none',
        elements: [],
        last_mapped_commit: null,
      });
      return;
    }
    const baseProbe = execGit(['cat-file', '-t', lastMapped], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (baseProbe.exitCode !== 0) {
      // A stamp git cannot resolve: history rewrite, GC, or a shallow clone.
      // Distinct reason from 'no-mapped-commit' -- the map claims a baseline,
      // this repository just cannot see it, which is an operator-actionable
      // difference (re-map vs. unshallow).
      emit({
        block: false,
        skipped: true,
        reason: 'unresolvable-mapped-commit',
        action_required: false,
        directive: 'none',
        elements: [],
        last_mapped_commit: lastMapped,
      });
      return;
    }
    const base = lastMapped;

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

    // #3418: GSD's own planning artifacts are not codebase structure. A
    // map-codebase run commits `.planning/codebase/*.md`, so a correctly
    // stamped baseline would be re-poisoned by the very commit that carries
    // the stamp -- the next gate invocation would report the map's own seven
    // documents as seven new directories, back over the default threshold of
    // three. Derived from planningRoot() rather than a hardcoded literal so a
    // repoint of the planning root cannot leave this filter behind.
    //
    // `git diff --name-status` always prints repo-root-relative paths, so a cwd
    // below the root needs the `sub/` prefix or the filter matches nothing.
    // That prefix comes from git (`--show-prefix`: root-relative, forward
    // slashes, trailing slash, empty at the root). The rejected alternative was
    // path.relative(`--show-toplevel`, cwd), which mixes two path producers: on
    // Windows os.tmpdir() hands back the 8.3 short form while git resolves the
    // long one, so relative() between them yields a `../..` chain that matches
    // nothing. The `.planning` half below is safe to compute with relative()
    // because both of its sides are the same cwd string.
    const prefixProbe = execGit(['rev-parse', '--show-prefix'], { cwd }) as unknown as { exitCode: number; stdout: string };
    const repoPrefix = prefixProbe.exitCode === 0 ? prefixProbe.stdout.trim() : '';
    const planningPrefix = repoPrefix + path.relative(cwd, planningRoot(cwd)).split(path.sep).join('/') + '/';
    const isPlanningArtifact = (file: string) => file.split('\\').join('/').startsWith(planningPrefix);

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const line of diff.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^([A-Z])\d*\t(.+?)(?:\t(.+))?$/);
      if (!m) continue;
      const status = m[1];
      // execGit sets no core.quotepath config, so git's default `true` applies:
      // any path containing non-ASCII bytes (or `"`, `\`, control bytes) is
      // C-quoted — `"docs/\350\256\276…/overview.md"`. Capturing that verbatim
      // garbles affected_paths/elements and makes isPathMapped compare the
      // quoted prefix (`"docs`) against STRUCTURE.md, misclassifying DOCUMENTED
      // directories as new_dir (#4081). Decode with the single owner of the
      // git C-quote seam (worktree-safety.cjs); a non-quoted value — the plain
      // ASCII common case — passes through untouched. Both capture groups are
      // decoded: R/C lines carry old AND new paths, either may be quoted.
      const file = decodeGitQuotedPath(m[3] || m[2]);
      if (isPlanningArtifact(file)) continue;
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
  scanQuantitativeCriteria,
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
  computeContextDrift,
  cmdVerifyContextDrift,
  cmdStampCodebaseMap,
  STATE_HEAD_ADVISORY_COMMITS,
};
