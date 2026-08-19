/**
 * Verify-command grounding probe (#2401).
 *
 * #2401: a planner authored `<automated>cd ../../frontend && npm run lint</automated>`
 * whose target did not resolve from the executor's cwd, and the plan-checker —
 * lacking a deterministic probe — hand-reasoned the filesystem and prescribed two
 * successively-wrong replacement paths.
 *
 * This module answers "can this `<automated>` verify command's target directory be
 * grounded?" WITHOUT ever executing the command. PLAN.md is LLM-authored untrusted
 * text, so this module never `exec`s, `spawn`s, or otherwise shells out — it reads
 * only via `fs.statSync`, `fs.existsSync`, `fs.readFileSync`, `fs.readdirSync`.
 *
 * It is a RECOGNIZER, not a shell interpreter (deliberate, per Greenspun's Tenth
 * Rule — the fix for #2401 is refusing to guess, not writing a bigger shell
 * parser): exactly two forms are grounded (`cd <literal>` and
 * `npm --prefix <literal>`), and anything this probe cannot ground returns
 * `unresolvable`, which is a warning and never a blocker.
 *
 * A bare ancestor climb (`cd ../..`, no trailing named segment) is genuinely
 * ambiguous under parallel-worktree execution — the checker's root and the
 * executor's root differ, so "my grandparent directory" cannot be asserted
 * about, and it is reported `outside_root` without touching the filesystem.
 * A climb that names a concrete sibling (`cd ../../frontend`, the exact #2401
 * shape) still names something checkable, so it is resolved and probed like any
 * other target.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractTaggedBlocks, stripTaggedBlocks } from './markdown-sectionizer.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const { stripProjectCodePrefix, extractPhaseToken, comparePhaseNum } = phaseIdMod;

// ─── Types ────────────────────────────────────────────────────────────────────

type VerifyCommandStatus = 'ok' | 'broken' | 'unresolvable' | 'not_applicable' | 'pending_creation';
type VerifyCommandSeverity = 'blocker' | 'warning' | 'none';
type VerifyCommandReason =
  | 'missing_dir'
  | 'no_manifest'
  | 'script_missing'
  | 'dynamic_path'
  | 'outside_root'
  | 'manifest_unreadable'
  | null;
type VerifyCommandForm = 'cd' | 'prefix' | null;

interface AutomatedCommand {
  plan: string;
  task: string;
  command: string;
}

interface ResolveOptions {
  projectRoot?: string;
  declaredPaths?: string[];
}

interface ResolvedVerifyCommand {
  command: string;
  status: VerifyCommandStatus;
  severity: VerifyCommandSeverity;
  reason: VerifyCommandReason;
  form: VerifyCommandForm;
  rawTarget: string | null;
  target: string | null;
  manifest: string | null;
  script: string | null;
  sentinel: boolean;
  base: string;
}

interface ProbedVerifyCommand extends ResolvedVerifyCommand {
  plan: string;
  task: string;
}

interface ProbeCounts {
  blocker: number;
  warning: number;
  total: number;
}

interface ProbePhaseResult {
  status: VerifyCommandStatus;
  commands: ProbedVerifyCommand[];
  counts: ProbeCounts;
  readError: string | null;
}

interface ProbePhaseOptions {
  phaseDir: string;
  projectRoot: string;
}

interface HarvestedCommand {
  phase: string;
  plan: string;
  task: string;
  command: string;
}

interface HarvestResult {
  commands: HarvestedCommand[];
  readError: string | null;
}

interface HarvestOptions {
  planningDir: string;
  /**
   * A phase-id token (`phase-id.cjs`'s grammar) or a plain number. Accepting
   * either lets callers pass a decimal/lettered token (`'2.1'`, `'12A'`)
   * without lossy `Number()` coercion; a plain number is stringified before
   * comparison via `comparePhaseNum`.
   */
  beforePhase: number | string;
  limit?: number;
  lookback?: number;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

const TASK_NAME_RE = /<name>([\s\S]*?)<\/name>/;
const AUTOMATED_BLOCK_RE = /<automated[^>]{0,200}>([\s\S]*?)<\/automated>/g;

/**
 * Bounds walking pathological input (e.g. hundreds of unclosed `<automated>`
 * openers). `extractTaggedBlocks`/`stripTaggedBlocks` (task-block grammar
 * owner, `./markdown-sectionizer.cjs`) already use a ReDoS-safe
 * stop-at-next-open pattern with no separate iteration cap of their own — a
 * document full of unclosed `<task>` openers never matches, so their walk is
 * a single linear scan regardless. This guard only bounds the `<automated>`
 * scan this module still runs directly, matching the pre-existing behavior.
 */
const MAX_BLOCK_WALK = 20000;

/**
 * Run `AUTOMATED_BLOCK_RE` over `text`, pushing `{plan: '', task, command}`
 * for each non-empty trimmed block onto `out`, in order. Shares `guard`
 * across every caller in one `extractAutomatedCommands` invocation so the
 * MAX_BLOCK_WALK bound applies to the WHOLE document's `<automated>` count,
 * not per task body. Returns `false` when the bound was hit (caller stops
 * walking further task bodies immediately); `true` otherwise.
 */
function extractAutomatedFromText(
  text: string,
  task: string,
  out: AutomatedCommand[],
  guard: { n: number },
): boolean {
  AUTOMATED_BLOCK_RE.lastIndex = 0;
  let aMatch: RegExpExecArray | null;
  while ((aMatch = AUTOMATED_BLOCK_RE.exec(text)) !== null) {
    const raw = (aMatch[1] ?? '').trim();
    if (raw !== '') out.push({ plan: '', task, command: raw });
    if (aMatch.index === AUTOMATED_BLOCK_RE.lastIndex) AUTOMATED_BLOCK_RE.lastIndex += 1;
    guard.n += 1;
    if (guard.n > MAX_BLOCK_WALK) return false;
  }
  return true;
}

/**
 * Extract every `<automated>…</automated>` command from PLAN.md text,
 * attaching the owning `<task><name>` when the block sits inside a
 * `<task>…</task>`. Never throws; a non-string or blank plan yields `[]`.
 * `plan` is left `''` — callers (`probePhaseVerifyCommands`,
 * `harvestPriorVerifyCommands`) set it from the filename they read.
 *
 * Task-block bodies are obtained from the canonical sectionizer
 * (`extractTaggedBlocks`/`stripTaggedBlocks`, `./markdown-sectionizer.cjs`)
 * rather than a fourth hand-rolled `<task>` grammar copy (review finding,
 * generative fix divergence class). This module only needs each task's
 * `<name>` and its `<automated>` blocks — never the opening tag's `type=`
 * attribute — so, unlike `src/verify.cts`'s `PLAN_TASK_BLOCK_RE` (which keeps
 * its own copy specifically to read `type=`), it can share the owner
 * outright. Ordering: every in-task command is emitted first, task by task
 * in document order (`extractTaggedBlocks` returns bodies in document
 * order); every command sitting OUTSIDE any `<task>` is emitted after, in
 * the order it appears in the task-stripped remainder. No existing caller or
 * test depends on interleaving an outside-task block between two in-task
 * blocks that surround it in the raw document.
 */
function extractAutomatedCommands(planText: unknown): AutomatedCommand[] {
  if (typeof planText !== 'string' || planText.length === 0) return [];

  const out: AutomatedCommand[] = [];
  const guard = { n: 0 };

  const taskBodies = extractTaggedBlocks(planText, 'task', true);
  for (const body of taskBodies) {
    const nameMatch = TASK_NAME_RE.exec(body);
    const task = nameMatch ? nameMatch[1].trim() : '';
    if (!extractAutomatedFromText(body, task, out, guard)) return out;
  }

  const remainder = stripTaggedBlocks(planText, 'task', true);
  extractAutomatedFromText(remainder, '', out, guard);

  return out;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * `$`, backtick, `*`, `?`, or a newline — a path this recognizer refuses to
 * guess at anywhere in the string. `$`/backtick are substitution, `*`/`?` are
 * shell globs (and illegal in Windows path components regardless), and a
 * newline is never a valid single path.
 */
const DYNAMIC_PATH_ANYWHERE_RE = /[$`*?\n]/;
/**
 * A LEADING `~` is shell home-expansion (`~/web`, `~user/web`) and is refused
 * as dynamic; the dynamic check runs BEFORE quote stripping (so `cd
 * "$FRONTEND"` is still caught), so this tolerates one leading quote char
 * before the `~`. A `~` anywhere else in a path is an ordinary literal
 * character — e.g. Windows 8.3 short names like `RUNNER~1` — and must resolve
 * normally rather than being refused (#2401 CI regression).
 */
const DYNAMIC_PATH_LEADING_TILDE_RE = /^["']?~/;
const CD_SEGMENT_RE = /^cd\s+(.+)$/;
/**
 * Quote-aware `--prefix` value capture (#2401 review Finding 2): a bare
 * `\S+` capture truncates a quoted path containing a space (`--prefix "my
 * dir"` → `"my`). Alternation order is double-quoted, single-quoted,
 * unquoted — the surrounding quote pair (if any) is removed downstream by
 * the existing `stripQuotes`.
 */
const PREFIX_FLAG_RE = /(?:^|\s)--prefix(?:=|\s+)("[^"]*"|'[^']*'|\S+)/;
/** Same value grammar as `PREFIX_FLAG_RE`, `g`-flagged for stripping (Finding 1). */
const PREFIX_FLAG_STRIP_RE = /(?:^|\s)--prefix(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g;
const NEEDS_NPM_RE = /^(npm|npx|pnpm|yarn|bun)\b/;
const NEEDS_MAKE_RE = /^make\b/;
const NPM_RUN_SCRIPT_RE = /\bnpm\s+run\s+([\w:@./-]+)/;
const MISSING_SENTINEL_RE = /^MISSING\b/;
const MAX_MANIFEST_BYTES = 512 * 1024;

function emptyResult(base: string): ResolvedVerifyCommand {
  return {
    command: '',
    status: 'not_applicable',
    severity: 'none',
    reason: null,
    form: null,
    rawTarget: null,
    target: null,
    manifest: null,
    script: null,
    sentinel: false,
    base,
  };
}

/** Split on `&&`, `||`, `;`, and newlines; trim each segment; drop empties. No quote-awareness. */
function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Strip a single matching pair of surrounding quotes, if present. */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Backslash → forward-slash, applied unconditionally (backslash paths arrive on Linux too). */
function toSlash(s: string): string {
  return s.replace(/\\/g, '/');
}

/**
 * `NPM_RUN_SCRIPT_RE` requires `npm` and `run` adjacent, so `npm --prefix
 * ./web run lint` (the form this feature's own docs prefer) never matches
 * (#2401 review Finding 1). Strip the `--prefix <value>` / `--prefix=<value>`
 * flag (either ordering, quote-aware) before running the script-name match.
 */
function stripPrefixFlag(s: string): string {
  return s.replace(PREFIX_FLAG_STRIP_RE, ' ');
}

/** Is `raw` (after the same quote-stripping/slash-normalization used elsewhere) an absolute path? */
function isAbsoluteCdSegment(raw: string): boolean {
  return path.isAbsolute(toSlash(stripQuotes(raw)));
}

/**
 * Fold chained `cd` segments left-to-right with absolute-reset semantics
 * (#2401 review Finding 3): a relative segment appends onto the
 * accumulator; an absolute segment discards everything accumulated so far
 * and becomes the new accumulator (matching real shell `cd` semantics —
 * `cd sub && cd /abs/path` ends up at `/abs/path`, not `sub//abs/path`).
 * A single segment (the overwhelmingly common case) always returns that
 * segment verbatim, byte-identical to the pre-fix `cdArgs[0]` behavior.
 */
function foldCdArgs(args: string[]): string {
  let acc = '';
  for (const raw of args) {
    if (acc === '' || isAbsoluteCdSegment(raw)) {
      acc = raw;
    } else {
      acc = `${acc}/${raw}`;
    }
  }
  return acc;
}

function stripLeadingDotSlash(s: string): string {
  return s.replace(/^\.\//, '');
}

/**
 * A relative escape whose every segment is `..` (a bare ancestor climb, e.g.
 * `cd ../..`) is inherently ambiguous across worktrees — flagged `outside_root`
 * without touching the filesystem. A climb that names a concrete sibling (e.g.
 * `cd ../../frontend`, the exact #2401 shape) still names something checkable
 * and falls through to the normal filesystem probe below.
 */
function isPureAncestorClimb(rel: string): boolean {
  if (rel.length === 0) return false;
  const segs = rel.split(/[\\/]/).filter(s => s.length > 0);
  return segs.length > 0 && segs.every(s => s === '..');
}

function declaredPathCovers(declaredPaths: string[] | undefined, norm: string): boolean {
  if (!Array.isArray(declaredPaths)) return false;
  const target = stripLeadingDotSlash(norm);
  return declaredPaths.some(p => {
    if (typeof p !== 'string') return false;
    const dp = stripLeadingDotSlash(toSlash(p));
    return dp === target || dp.startsWith(target + '/');
  });
}

/**
 * Read a package.json manifest bounded by size and guarded end-to-end; never
 * throws. Returns `null` when the manifest cannot be read/parsed/shaped, or
 * the parsed value when it is usable.
 */
function readManifestObject(manifestPath: string): Record<string, unknown> | null {
  let size = 0;
  try {
    size = fs.statSync(manifestPath).size;
  } catch {
    return null;
  }
  if (size > MAX_MANIFEST_BYTES) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Resolve a single `<automated>` command's target directory WITHOUT ever
 * executing it. Every `fs` call is individually guarded, so this function
 * never throws for any input — including a bare call with no options.
 */
function resolveVerifyCommandTarget(command: unknown, options?: ResolveOptions): ResolvedVerifyCommand {
  const opts = options && typeof options === 'object' ? options : {};
  const base = typeof opts.projectRoot === 'string' && opts.projectRoot !== '' ? opts.projectRoot : process.cwd();
  const result = emptyResult(base);

  if (typeof command !== 'string') return result;
  result.command = command;

  const trimmed = command.trim();
  if (trimmed === '') return result;

  // Nyquist "MISSING — Wave 0 must create …" sentinel; Dimension 8 owns it.
  if (MISSING_SENTINEL_RE.test(trimmed)) {
    result.sentinel = true;
    return result;
  }

  const segments = splitSegments(trimmed);

  let form: VerifyCommandForm = null;
  let rawTarget: string | null = null;
  let rest: string;

  const cdArgs: string[] = [];
  let i = 0;
  while (i < segments.length) {
    const m = CD_SEGMENT_RE.exec(segments[i]);
    if (!m) break;
    cdArgs.push(m[1].trim());
    i += 1;
  }

  if (cdArgs.length > 0) {
    form = 'cd';
    rawTarget = foldCdArgs(cdArgs);
    rest = segments.slice(i).join(' && ');
  } else {
    const prefixMatch = PREFIX_FLAG_RE.exec(trimmed);
    if (!prefixMatch) return result; // not_applicable — neither form matched
    form = 'prefix';
    rawTarget = prefixMatch[1];
    rest = trimmed;
  }

  // Dynamic-path refusal, tested against rawTarget BEFORE any unquoting.
  if (DYNAMIC_PATH_ANYWHERE_RE.test(rawTarget) || DYNAMIC_PATH_LEADING_TILDE_RE.test(rawTarget)) {
    result.status = 'unresolvable';
    result.reason = 'dynamic_path';
    result.severity = 'warning';
    result.form = form;
    result.rawTarget = rawTarget;
    return result;
  }

  const norm = toSlash(stripQuotes(rawTarget));
  const isAbs = path.isAbsolute(norm);
  const target = isAbs ? path.normalize(norm) : path.resolve(base, norm);

  result.form = form;
  result.rawTarget = rawTarget;
  result.target = target;

  if (!isAbs) {
    const rel = path.relative(base, target);
    if (isPureAncestorClimb(rel)) {
      result.status = 'ok';
      result.severity = 'warning';
      result.reason = 'outside_root';
      return result;
    }
  }

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(target, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }

  if (!stat || !stat.isDirectory()) {
    if (declaredPathCovers(opts.declaredPaths, norm)) {
      result.status = 'pending_creation';
      result.severity = 'none';
      result.reason = null;
    } else {
      result.status = 'broken';
      result.reason = 'missing_dir';
      result.severity = 'blocker';
    }
    return result;
  }

  const restTrimmed = rest.trim();
  let neededManifest: 'package.json' | 'Makefile' | null = null;
  if (NEEDS_NPM_RE.test(restTrimmed)) neededManifest = 'package.json';
  else if (NEEDS_MAKE_RE.test(restTrimmed)) neededManifest = 'Makefile';

  if (!neededManifest) {
    result.status = 'ok';
    result.severity = 'none';
    return result;
  }

  const manifestPath = path.join(target, neededManifest);
  let manifestExists = false;
  try {
    manifestExists = fs.existsSync(manifestPath);
  } catch {
    manifestExists = false;
  }

  if (!manifestExists) {
    result.status = 'broken';
    result.reason = 'no_manifest';
    result.severity = 'blocker';
    return result;
  }

  result.manifest = neededManifest;

  if (neededManifest === 'Makefile') {
    result.status = 'ok';
    result.severity = 'none';
    return result;
  }

  const parsed = readManifestObject(manifestPath);
  if (!parsed) {
    result.status = 'ok';
    result.reason = 'manifest_unreadable';
    result.severity = 'warning';
    return result;
  }

  const scriptMatch = NPM_RUN_SCRIPT_RE.exec(stripPrefixFlag(restTrimmed));
  if (scriptMatch) {
    const scriptName = scriptMatch[1];
    result.script = scriptName;
    const scripts = parsed['scripts'];
    const hasScript =
      scripts !== null &&
      typeof scripts === 'object' &&
      !Array.isArray(scripts) &&
      Object.prototype.hasOwnProperty.call(scripts, scriptName);
    if (!hasScript) {
      result.status = 'ok';
      result.reason = 'script_missing';
      result.severity = 'warning';
      return result;
    }
  }

  result.status = 'ok';
  result.severity = 'none';
  return result;
}

// ─── Phase probing ────────────────────────────────────────────────────────────

const PLAN_FILE_RE = /-PLAN\.md$/i;
const ARTIFACTS_HEADING_RE = /^##[ \t]+Artifacts this phase produces\s*$/m;
const NEXT_HEADING_RE = /^##[ \t]+/m;
const FILES_BLOCK_RE = /<files>([\s\S]*?)<\/files>/g;
const ARTIFACT_BULLET_RE = /^-[ \t]+(.+)$/gm;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every `<files>…</files>` body (split on commas/whitespace/newlines) plus
 * every `- ` bullet under a `## Artifacts this phase produces` heading (up to
 * the next `## ` heading), scanned across the WHOLE plan text.
 */
function extractDeclaredPaths(text: string): string[] {
  const out: string[] = [];

  FILES_BLOCK_RE.lastIndex = 0;
  let fMatch: RegExpExecArray | null;
  while ((fMatch = FILES_BLOCK_RE.exec(text)) !== null) {
    const body = fMatch[1] ?? '';
    for (const tok of body.split(/[,\s]+/)) {
      const t = tok.trim();
      if (t) out.push(t);
    }
  }

  const headingMatch = ARTIFACTS_HEADING_RE.exec(text);
  if (headingMatch) {
    const after = text.slice(headingMatch.index + headingMatch[0].length);
    const nextIdx = after.search(NEXT_HEADING_RE);
    const section = nextIdx === -1 ? after : after.slice(0, nextIdx);
    ARTIFACT_BULLET_RE.lastIndex = 0;
    let bMatch: RegExpExecArray | null;
    while ((bMatch = ARTIFACT_BULLET_RE.exec(section)) !== null) {
      const t = (bMatch[1] ?? '').trim();
      if (t) out.push(t);
    }
  }

  return out;
}

const STATUS_PRIORITY: VerifyCommandStatus[] = ['broken', 'unresolvable', 'pending_creation', 'ok', 'not_applicable'];

/**
 * Probe every `<automated>` command in a phase directory's `-PLAN.md` files
 * against the filesystem. Never throws — a read failure degrades to
 * `readError` with the offending file skipped.
 */
function probePhaseVerifyCommands(options: ProbePhaseOptions): ProbePhaseResult {
  const { phaseDir, projectRoot } = options;

  let entries: string[];
  try {
    entries = fs.readdirSync(phaseDir);
  } catch (err) {
    return {
      status: 'unresolvable',
      commands: [],
      counts: { blocker: 0, warning: 0, total: 0 },
      readError: toMessage(err),
    };
  }

  const planFiles = entries.filter(f => PLAN_FILE_RE.test(f)).sort();
  const commands: ProbedVerifyCommand[] = [];
  const readErrors: string[] = [];

  for (const file of planFiles) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(phaseDir, file), 'utf-8');
    } catch (err) {
      readErrors.push(toMessage(err));
      continue;
    }

    const declaredPaths = extractDeclaredPaths(text);
    const extracted = extractAutomatedCommands(text);
    for (const cmd of extracted) {
      const resolved = resolveVerifyCommandTarget(cmd.command, { projectRoot, declaredPaths });
      commands.push({ ...resolved, plan: file, task: cmd.task });
    }
  }

  const counts: ProbeCounts = { blocker: 0, warning: 0, total: commands.length };
  for (const c of commands) {
    if (c.severity === 'blocker') counts.blocker += 1;
    else if (c.severity === 'warning') counts.warning += 1;
  }

  let status: VerifyCommandStatus = 'ok';
  if (commands.length > 0) {
    const present = new Set(commands.map(c => c.status));
    status = STATUS_PRIORITY.find(s => present.has(s)) ?? 'ok';
  }

  return {
    status,
    commands,
    counts,
    readError: readErrors.length > 0 ? readErrors.join('; ') : null,
  };
}

// ─── Prior-phase harvesting ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const DEFAULT_LOOKBACK = 3;

/**
 * Walk backward from `beforePhase` (descending, at most `lookback` phase
 * directories) looking for the nearest prior phase whose plans carry any
 * `<automated>` command. Returns that phase's commands, deduped by command
 * text (first-seen order) and capped at `limit`. Never throws.
 *
 * Phase directories are enumerated and ordered via the canonical grammar in
 * `phase-id.cjs` (#2401 review fix) rather than a bespoke `phase-N-slug`
 * regex — real GSD phase directories are `01-foundation`, `3-thing`,
 * `2.1-thing`, `12A-thing`, or project-code-prefixed (`CK-01-name`), never
 * `phase-N-slug`. A directory name is treated as a phase directory only when
 * it (after stripping an optional project-code prefix) starts with a digit;
 * `notes`, `archive`, etc. are ignored. `extractPhaseToken` reads each
 * directory's phase token and `comparePhaseNum` both filters (`< beforePhase`)
 * and orders (descending) so decimal/lettered/sentinel tokens (`2.1`, `12A`,
 * `999.1`) compare correctly instead of via lossy `Number()` parsing.
 */
function harvestPriorVerifyCommands(options: HarvestOptions): HarvestResult {
  const { planningDir, beforePhase, limit = DEFAULT_LIMIT, lookback = DEFAULT_LOOKBACK } = options;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(planningDir, { withFileTypes: true });
  } catch (err) {
    return { commands: [], readError: toMessage(err) };
  }

  const beforePhaseStr = String(beforePhase);
  const candidates: Array<{ token: string; dir: string }> = [];
  for (const ent of entries) {
    let isDir = false;
    try {
      isDir = ent.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    // Not a phase directory at all (e.g. 'notes', 'archive') — no reliable
    // phase token can be read from a name that doesn't start with a digit
    // once any project-code prefix ('CK-', 'PROJ-') is stripped.
    if (!/^\d/.test(stripProjectCodePrefix(ent.name))) continue;
    const token = extractPhaseToken(ent.name);
    if (comparePhaseNum(token, beforePhaseStr) < 0) {
      candidates.push({ token, dir: ent.name });
    }
  }
  candidates.sort((a, b) => comparePhaseNum(b.token, a.token));

  const readErrors: string[] = [];
  let examined = 0;

  for (const candidate of candidates) {
    if (examined >= lookback) break;
    examined += 1;

    const phaseDirPath = path.join(planningDir, candidate.dir);
    let planFiles: string[];
    try {
      planFiles = fs.readdirSync(phaseDirPath).filter(f => PLAN_FILE_RE.test(f)).sort();
    } catch (err) {
      readErrors.push(toMessage(err));
      continue;
    }

    const seen = new Set<string>();
    const found: HarvestedCommand[] = [];
    for (const file of planFiles) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(phaseDirPath, file), 'utf-8');
      } catch (err) {
        readErrors.push(toMessage(err));
        continue;
      }
      for (const cmd of extractAutomatedCommands(text)) {
        if (seen.has(cmd.command)) continue;
        seen.add(cmd.command);
        found.push({
          phase: candidate.token,
          plan: path.join(phaseDirPath, file),
          task: cmd.task,
          command: cmd.command,
        });
      }
    }

    if (found.length > 0) {
      return {
        commands: found.slice(0, limit),
        readError: readErrors.length > 0 ? readErrors.join('; ') : null,
      };
    }
  }

  return { commands: [], readError: readErrors.length > 0 ? readErrors.join('; ') : null };
}

export = {
  extractAutomatedCommands,
  resolveVerifyCommandTarget,
  probePhaseVerifyCommands,
  harvestPriorVerifyCommands,
};
