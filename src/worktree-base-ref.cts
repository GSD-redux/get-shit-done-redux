/**
 * Worktree base-ref detection and degradation logic (issue #683).
 *
 * Determines whether a worktree's HEAD has drifted from the fork base that the
 * Claude Code harness would use to create a 'fresh' parallel worktree. When
 * drift is detected the caller should fall back to sequential execution on the
 * main working tree to avoid a base mismatch.
 *
 * Pure/testable module: all I/O is injectable via the `deps` argument so unit
 * tests can run without touching the real filesystem or spawning real git.
 */

import fs from 'node:fs';
import path from 'node:path';

import { execGit as execGitSeam, isSpawnTimeout } from './shell-command-projection.cjs';
import { getGlobalConfigDir } from './runtime-homes.cjs';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Strip JSONC comments (line and block forms) from a string to produce valid JSON.
 * Handles comments inside strings correctly (does not strip them).
 * Mirrors the same logic in bin/install.js:stripJsonComments.
 */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    // Handle string literals — don't strip comments inside strings
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] || '');
        i += 2;
        continue;
      }
      if (text[i] === stringChar) {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    // Start of string
    if (text[i] === '"' || text[i] === "'") {
      inString = true;
      stringChar = text[i];
      result += text[i];
      i++;
      continue;
    }
    // Line comment
    if (text[i] === '/' && text[i + 1] === '/') {
      // Skip to end of line
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ] (common in JSONC)
  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse a string as JSONC (JSON with comments). Returns the parsed value or
 * throws a SyntaxError if the content is genuinely malformed.
 */
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}

// ─── Internal types ───────────────────────────────────────────────────────────

type ExecGitFn = typeof execGitSeam;

// Who creates the isolated worktree — the two worktree-creating members of
// host-integration.cts's DispatchIsolation vocabulary ('none' creates none and
// never reaches this check).
type BaseCheckIsolationMode = 'harness-worktree' | 'orchestrator-worktree';

// ─── Message constants (verbatim — downstream docs/tests depend on these) ─────

function buildMsgDiverged(headSha: string | null, forkRef: string | null, forkSha: string | null): string {
  return `⚠ Worktree base mismatch: HEAD (${shortSha(headSha)}) differs from ${forkRef} (${shortSha(forkSha)}). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so ${forkRef} matches it. (worktree.baseRef:"head" applies only where GSD itself creates the worktree — the runtime harness does not read it; #48, #3659.)`;
}

const MSG_UNKNOWN = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. Parallel worktrees return once origin/HEAD resolves and matches HEAD. See #683, #3659.`;

function buildMsgBaserefHeadIgnored(headSha: string | null, forkRef: string | null, forkSha: string | null): string {
  return `⚠ Worktree base mismatch: worktree.baseRef:"head" is set, but the runtime harness does not honor it for isolated dispatch — the fork base stays ${forkRef} (${shortSha(forkSha)}) while HEAD is ${shortSha(headSha)} (#48; upstream claude-code#44965). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so ${forkRef} matches it, or on runtimes where GSD itself manages worktree creation. See #3659.`;
}

const MSG_HEAD_UNRESOLVABLE = `⚠ Cannot determine the worktree base (git rev-parse HEAD did not return a definitive answer). Running this phase sequentially on the main working tree to avoid an unverified base mismatch. Note: worktree.baseRef:"head" silences this check only where GSD itself creates the worktree (orchestrator-managed runtimes) — in harness mode it never applied (#48, #3659). Retry; if it persists, check for a stalled filesystem mount or a stale git index lock (.git/index.lock). See #683, #3050.`;

/**
 * Returns true when an execGit result indicates the subprocess was killed by
 * a timeout. A timeout means the command genuinely could not complete — it
 * must never be treated the same as a clean non-zero exit (e.g. "not a git
 * repository"), which DID complete and reported a real answer.
 *
 * Delegates to the single shared predicate in shell-command-projection.cts
 * (#3050 — "Generative Fix Divergence"); do not reimplement this locally.
 */
function isExecGitTimeout(result: { signal: string | null; error: unknown }): boolean {
  return isSpawnTimeout(result);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Returns the first 8 characters of a SHA, or '' if null/empty.
 */
export function shortSha(sha: string | null): string {
  if (!sha) return '';
  return sha.slice(0, 8);
}

/**
 * Extracts settings.worktree.baseRef if it is a string; otherwise null.
 * Defensive: settings may be null/undefined, worktree may be missing or
 * not an object.
 */
export function readBaseRefFromSettings(settings: unknown): string | null {
  if (settings == null || typeof settings !== 'object') return null;
  const s = settings as Record<string, unknown>;
  if (s.worktree == null || typeof s.worktree !== 'object' || Array.isArray(s.worktree)) return null;
  const worktree = s.worktree as Record<string, unknown>;
  if (typeof worktree.baseRef !== 'string') return null;
  return worktree.baseRef;
}

/**
 * No-clobber application of worktree.baseRef = 'head'.
 *
 * - If baseRef is absent/null/undefined → set to 'head', return changed:true.
 * - If already 'head' → skip, return skipped:'already-head'.
 * - If any other string → skip without overwriting, return skipped:'explicit-other'.
 *
 * Mutates `settings` in place and also returns it.
 */
export function applyWorktreeBaseRef(settings: Record<string, unknown>): {
  changed: boolean;
  settings: object;
  skipped: null | 'already-head' | 'explicit-other';
  previous: string | null;
} {
  // Defensive: caller must pass a plain object — reject null, arrays, and primitives.
  if (settings === null || Array.isArray(settings) || typeof settings !== 'object') {
    throw new TypeError(`applyWorktreeBaseRef: expected a plain object, got ${settings === null ? 'null' : Array.isArray(settings) ? 'array' : typeof settings}`);
  }
  // Ensure worktree object exists, preserving any existing keys
  if (settings.worktree == null || typeof settings.worktree !== 'object' || Array.isArray(settings.worktree)) {
    settings.worktree = {};
  }
  const worktree = settings.worktree as Record<string, unknown>;
  const current = typeof worktree.baseRef === 'string' ? worktree.baseRef : null;

  if (current === 'head') {
    return { changed: false, settings, skipped: 'already-head', previous: 'head' };
  }
  if (current !== null) {
    // Some other explicit string value — don't overwrite
    return { changed: false, settings, skipped: 'explicit-other', previous: current };
  }
  // Absent/null/undefined → set to 'head'
  worktree.baseRef = 'head';
  return { changed: true, settings, skipped: null, previous: null };
}

/**
 * Reads settings files in a 3-layer cascade and extracts worktree.baseRef from
 * the first layer that provides a non-null string value. Layers (highest to lowest
 * precedence):
 *   1. project local  — <claudeDir>/settings.local.json
 *   2. project shared — <claudeDir>/settings.json
 *   3. user/global    — <userClaudeDir>/settings.json  (only when userClaudeDir is
 *                       provided AND resolves to a different path than claudeDir)
 *
 * deps.readFile(path) must return the file contents or null on any error.
 * userClaudeDir is optional; when absent/null the user/global layer is skipped.
 */
export function resolveEffectiveBaseRef(
  claudeDir: string,
  deps?: { readFile?: (p: string) => string | null },
  userClaudeDir?: string | null
): string | null {
  const readFile: (p: string) => string | null = deps?.readFile ?? ((p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });

  const localPath = path.join(claudeDir, 'settings.local.json');
  const sharedPath = path.join(claudeDir, 'settings.json');

  function parseBaseRef(filePath: string): string | null {
    const contents = readFile(filePath);
    if (contents == null) return null;
    try {
      const parsed: unknown = parseJsonc(contents);
      return readBaseRefFromSettings(parsed);
    } catch {
      return null;
    }
  }

  // Layer 1: project local
  const localRef = parseBaseRef(localPath);
  if (localRef !== null) return localRef;

  // Layer 2: project shared
  const sharedRef = parseBaseRef(sharedPath);
  if (sharedRef !== null) return sharedRef;

  // Layer 3: user/global (only when provided and not the same directory as claudeDir)
  if (userClaudeDir && path.resolve(userClaudeDir) !== path.resolve(claudeDir)) {
    const userSharedPath = path.join(userClaudeDir, 'settings.json');
    const userRef = parseBaseRef(userSharedPath);
    if (userRef !== null) return userRef;
  }

  return null;
}

/**
 * The base-check evaluation for a project directory — exactly what
 * `cmdWorktreeBaseCheck` computes, minus the stdout emit and the `--mode`
 * argv parse (#4222). Resolves the effective baseRef from `<cwd>/.claude`
 * settings (project local → project shared → user/global) and evaluates the
 * #683 divergence against it.
 *
 * Extracted so `routeDispatchIsolation` (gsd-tools.cjs) can re-derive the
 * base-check degrade in-process before it records the dispatch decision,
 * the way it already re-derives the #3737 `use_worktrees` opt-out. The CLI
 * subcommand and the resolver share this one derivation so the two can
 * never disagree about what the fork base is.
 *
 * deps.userClaudeDir overrides the user/global config directory resolution
 * (default: getGlobalConfigDir('claude'), which honours CLAUDE_CONFIG_DIR).
 */
export function evaluateWorktreeBaseDegradeForCwd(
  cwd: string,
  isolationMode: BaseCheckIsolationMode = 'harness-worktree',
  deps?: { execGit?: ExecGitFn; readFile?: (p: string) => string | null; userClaudeDir?: string | null }
): ReturnType<typeof evaluateWorktreeBaseDegrade> {
  const claudeDir = path.join(cwd, '.claude');
  const userClaudeDir = Object.prototype.hasOwnProperty.call(deps ?? {}, 'userClaudeDir')
    ? (deps as { userClaudeDir?: string | null }).userClaudeDir
    : getGlobalConfigDir('claude');
  const effectiveBaseRef = resolveEffectiveBaseRef(
    claudeDir,
    deps?.readFile ? { readFile: deps.readFile } : undefined,
    userClaudeDir
  );
  return evaluateWorktreeBaseDegrade({
    cwd,
    effectiveBaseRef,
    execGit: deps?.execGit,
    isolationMode,
  });
}

/**
 * CLI command: check current worktree base-ref degradation status.
 *
 * Reads effective baseRef from <cwd>/.claude settings (3-layer cascade:
 * project local → project shared → user/global), runs degradation evaluation,
 * writes JSON result to stdout (or injected write), and returns the result object.
 *
 * deps.userClaudeDir overrides the user/global config directory resolution
 * (default: getGlobalConfigDir('claude'), which honours CLAUDE_CONFIG_DIR).
 */
export function cmdWorktreeBaseCheck(
  cwd: string,
  args: string[],
  deps?: { execGit?: ExecGitFn; readFile?: (p: string) => string | null; write?: (s: string) => void; userClaudeDir?: string | null }
): ReturnType<typeof evaluateWorktreeBaseDegrade> {
  // --mode threads the dispatch isolation mode through to the evaluation
  // (#3659): 'harness-worktree' (default) or 'orchestrator-worktree'. Invalid
  // or missing values after --mode fail closed — a silently defaulted typo
  // would re-open the hole the flag exists to close.
  let isolationMode: BaseCheckIsolationMode = 'harness-worktree';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1) {
    const value = args[modeIdx + 1];
    if (value !== 'harness-worktree' && value !== 'orchestrator-worktree') {
      throw new Error(`worktree base-check: --mode must be harness-worktree or orchestrator-worktree, got ${JSON.stringify(value ?? null)}`);
    }
    isolationMode = value;
  }
  const result = evaluateWorktreeBaseDegradeForCwd(cwd, isolationMode, deps);
  // Default emit goes through fs.writeSync(1, …), NOT process.stdout.write:
  // the CLI's --pick capture intercepts writeSync, and command substitution
  // is a pipe — via process.stdout.write a `$(gsd-tools … --pick x)` capture
  // received the full JSON instead of the picked field, so the workflow
  // auto-degrade guards never matched (#3659 review). Short-count loop per
  // io.cjs writeAllSync's rationale (a non-blocking pipe can accept partial
  // writes).
  const write = deps?.write ?? ((s: string) => {
    const buf = Buffer.from(s, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    }
  });
  write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

/**
 * CLI command: write worktree.baseRef = 'head' into <cwd>/.claude/settings.local.json.
 *
 * No-clobber: if the file already has an explicit baseRef that is not 'head',
 * the existing value is preserved and output reflects skipped:'explicit-other'.
 * If the file contains malformed JSON, throws a clear error rather than
 * silently clobbering the user's file.
 */
export function cmdWorktreeSetBaseRef(
  cwd: string,
  _args: string[],
  deps?: {
    readFile?: (p: string) => string | null;
    writeFile?: (p: string, content: string) => void;
    mkdir?: (p: string, opts: { recursive: boolean }) => void;
    existsSync?: (p: string) => boolean;
    write?: (s: string) => void;
  }
): { changed: boolean; skipped: null | 'already-head' | 'explicit-other'; previous: string | null; file: string; baseRef: string } {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  const readFile: (p: string) => string | null = deps?.readFile ??
    ((p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });

  const raw = readFile(file);
  let settings: Record<string, unknown> = {};
  if (raw != null) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch {
      throw new Error(`Refusing to modify ${file}: existing JSON is malformed`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`Refusing to modify ${file}: expected a JSON object at the top level`);
    }
    settings = parsed as Record<string, unknown>;
  }

  const apply = applyWorktreeBaseRef(settings);

  if (apply.changed) {
    const dir = path.dirname(file);
    const existsSync: (p: string) => boolean = deps?.existsSync ?? fs.existsSync;
    const mkdirFn: (p: string, opts: { recursive: boolean }) => void = deps?.mkdir ??
      ((p: string, opts: { recursive: boolean }) => { fs.mkdirSync(p, opts); });
    if (!existsSync(dir)) {
      mkdirFn(dir, { recursive: true });
    }
    const writeFile: (p: string, content: string) => void = deps?.writeFile ??
      ((p: string, content: string) => { fs.writeFileSync(p, content, 'utf8'); });
    writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  }

  const output = {
    changed: apply.changed,
    skipped: apply.skipped,
    previous: apply.previous,
    baseRef: 'head' as const,
    file,
  };
  // Default emit goes through fs.writeSync(1, …), NOT process.stdout.write:
  // the CLI's --pick capture intercepts writeSync, and command substitution
  // is a pipe — via process.stdout.write a `$(gsd-tools … --pick x)` capture
  // received the full JSON instead of the picked field, so the workflow
  // auto-degrade guards never matched (#3659 review). Short-count loop per
  // io.cjs writeAllSync's rationale (a non-blocking pipe can accept partial
  // writes).
  const write = deps?.write ?? ((s: string) => {
    const buf = Buffer.from(s, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    }
  });
  write(JSON.stringify(output, null, 2) + '\n');
  return output;
}

/**
 * Evaluates whether the current worktree HEAD has diverged from the fork base
 * (origin/HEAD) that the Claude Code harness would use when creating a 'fresh'
 * parallel worktree.
 *
 * Returns a structured result with shouldDegrade, reason, and a user-visible
 * message when degradation is warranted.
 */
export function evaluateWorktreeBaseDegrade(deps?: {
  execGit?: ExecGitFn;
  effectiveBaseRef?: string | null;
  cwd?: string;
  /**
   * Who creates the isolated worktree (#3659). 'harness-worktree' (default):
   * the runtime harness forks it and does NOT route through project-settings
   * baseRef (#48, verified 5/5; upstream claude-code#44965) — 'head' must not
   * suppress the comparison. 'orchestrator-worktree': GSD itself runs
   * `git worktree add <path> <start-point>` with the orchestrator HEAD, so
   * 'head' is honored by construction and still suppresses.
   */
  isolationMode?: BaseCheckIsolationMode;
}): {
  shouldDegrade: boolean;
  reason: string;
  message: string | null;
  headSha: string | null;
  forkRef: string | null;
  forkSha: string | null;
  /**
   * Only meaningful when `reason === 'no-head'` (both non-degrade outcomes);
   * `null` for every other reason. `true` for exit 128 — git's definitive
   * "not a git repository" answer. `false` for exit 0 with empty stdout: git
   * completed but did NOT give a confirmed "no HEAD" answer, unlike exit 128
   * — this outcome is left `shouldDegrade:false` unchanged (pinned by an
   * existing regression guard; the underlying product question of whether it
   * SHOULD degrade is still open, see #3050 review), but a caller can now
   * tell the two `'no-head'` causes apart instead of treating them as the
   * same verified answer. (#3057 B8)
   */
  headAbsenceVerified: boolean | null;
} {
  const execGit: ExecGitFn = deps?.execGit ?? execGitSeam;
  const cwd = deps?.cwd;
  const cwdOpts = cwd ? { cwd } : {};

  // a. baseRef 'head' suppresses ONLY where GSD controls the fork start-point
  // (#3659). The former unconditional suppress trusted the harness to honor the
  // setting; #48 verified 5/5 that the Agent-isolation dispatch path never
  // routes through project settings (upstream claude-code#44965), so in
  // harness mode the fork base is always origin/HEAD and 'head' must fall
  // through to the same comparison the fresh path runs. In
  // orchestrator-worktree mode GSD itself runs `git worktree add <path>
  // <start-point>` with the orchestrator HEAD — 'head' is honored by
  // construction there and the suppress is correct. Any non-"head" value
  // (including "fresh" and absent/null) has fresh/origin-HEAD semantics and is
  // evaluated against origin/HEAD as before. (Reference: #683, #48, #3659.)
  const headIgnoredByHarness = deps?.effectiveBaseRef === 'head';
  if (headIgnoredByHarness && (deps?.isolationMode ?? 'harness-worktree') === 'orchestrator-worktree') {
    return { shouldDegrade: false, reason: 'baseref-head', message: null, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }

  // b. Resolve HEAD sha.
  const headResult = execGit(['rev-parse', 'HEAD'], cwdOpts);
  // A TIMEOUT means the command never completed — it is not evidence of "not a
  // git repository" and must fail closed (distinct from the clean-exit-128
  // "no-head" case below, which genuinely completed and reported no HEAD).
  if (isExecGitTimeout(headResult)) {
    return { shouldDegrade: true, reason: 'head-unresolvable', message: MSG_HEAD_UNRESOLVABLE, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  const headStdout = headResult.stdout ? headResult.stdout.trim() : '';
  // exit 128 is git's definitive "not a git repository" answer — it completed
  // and genuinely reported no HEAD. Only this specific, confirmed outcome
  // stays a benign non-degrade; every other non-success outcome below is
  // NOT a definitive answer from git and must fail closed (#3050).
  if (headResult.exitCode === 128) {
    return { shouldDegrade: false, reason: 'no-head', message: null, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: true };
  }
  // Exit 0 with empty stdout is pinned as benign no-degrade by an existing
  // regression guard (tests/worktree-base-ref.test.cjs — "git rev-parse HEAD
  // returns empty stdout"). Left unchanged deliberately; flagged in the
  // #3050 review for a product-intent call rather than silently flipped.
  // Unlike the exit-128 case above, git did NOT give a definitive "no HEAD"
  // answer here — `headAbsenceVerified:false` names that gap explicitly
  // instead of leaving it folded into an identical-looking 'no-head' reason
  // (#3057 B8; the product question of whether this SHOULD degrade is
  // unchanged and still open).
  if (headResult.exitCode === 0 && !headStdout) {
    return { shouldDegrade: false, reason: 'no-head', message: null, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: false };
  }
  if (headResult.exitCode !== 0) {
    // Any other non-success outcome (e.g. exit 127 — git missing — or any
    // other non-zero, non-128 exit) is not a definitive "not a repo" answer.
    // Fail closed instead of silently treating it as benign.
    // (`!headStdout` was previously OR'd in here but is unreachable: the
    // exitCode===0 && !headStdout case is already handled above, and every
    // other branch here has exitCode!==0 already true — #3050 review.)
    return { shouldDegrade: true, reason: 'head-unresolvable', message: MSG_HEAD_UNRESOLVABLE, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  const headSha = headStdout;

  // c. Resolve fork base (what the harness forks 'fresh' worktrees from = origin/HEAD).
  let forkRef: string | null = null;
  let forkSha: string | null = null;

  // Try direct origin/HEAD rev-parse first.
  const directResult = execGit(['rev-parse', '--verify', '--quiet', 'origin/HEAD'], cwdOpts);
  const directStdout = directResult.stdout ? directResult.stdout.trim() : '';
  if (directResult.exitCode === 0 && directStdout) {
    forkRef = 'origin/HEAD';
    forkSha = directStdout;
  } else {
    // Fall back via symbolic-ref → refs/remotes/origin/HEAD
    const symResult = execGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwdOpts);
    const symStdout = symResult.stdout ? symResult.stdout.trim() : '';
    if (symResult.exitCode === 0 && symStdout) {
      const ref = symStdout;
      const symShaResult = execGit(['rev-parse', '--verify', '--quiet', ref], cwdOpts);
      const symShaStdout = symShaResult.stdout ? symShaResult.stdout.trim() : '';
      if (symShaResult.exitCode === 0 && symShaStdout) {
        // Strip leading 'refs/remotes/' to get e.g. 'origin/next'
        forkRef = ref.replace(/^refs\/remotes\//, '');
        forkSha = symShaStdout;
      }
    }
  }

  // d. Evaluate.
  if (forkSha === null) {
    return { shouldDegrade: true, reason: 'fork-ref-unknown', message: MSG_UNKNOWN, headSha, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  if (forkSha === headSha) {
    return { shouldDegrade: false, reason: 'head-matches-fork', message: null, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  if (headIgnoredByHarness) {
    const message = buildMsgBaserefHeadIgnored(headSha, forkRef, forkSha);
    return { shouldDegrade: true, reason: 'baseref-head-ignored-by-harness', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  const message = buildMsgDiverged(headSha, forkRef, forkSha);
  return { shouldDegrade: true, reason: 'head-diverged-from-fork', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
}
