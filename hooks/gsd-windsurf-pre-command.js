#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-windsurf-pre-command.js — Windsurf/Cascade pre_run_command hook (ADR-1239 / #2100)
//
// Cascade (Windsurf's agent) invokes this script before each shell-command
// tool call executes, via the workspace/global hooks.json hook bus.
//
// Input schema (Cascade pre_run_command envelope, JSON on stdin):
//   { agent_action_name: 'pre_run_command', trajectory_id, execution_id,
//     timestamp, model_name,
//     tool_info: { command_line } }
//
// Decision protocol — DISTINCT from Cursor's stdout-JSON form:
//   - exit 0  -> allow the command to run (no stdout contract)
//   - exit 2  -> BLOCK the command; the printed stderr text is the reason
//                shown to the agent/user
//
// Behaviour: blocks a small, CONSERVATIVE, well-scoped, BEST-EFFORT deny-list
// of obviously destructive commands. This is intentionally not exhaustive —
// a broad deny-list would false-positive on legitimate agent/tooling work,
// and Cascade honors exit 2 unconditionally, so a false positive blocks the
// user's real work. When in doubt, this script allows:
//   - a fork-bomb pattern
//   - `rm -rf` (or equivalent combined/long flags), including through common
//     prefixed forms (`sudo rm -rf /`, `/bin/rm -rf /`, `env FOO=1 rm -rf /`),
//     targeting the filesystem root, the user's home directory, or a Windows
//     drive root/profile root
//   - `git push` with a force flag (`-f`/`--force`/`--force-with-lease`) or a
//     `+`-prefixed refspec, explicitly targeting a protected branch
//     (main / master / next) as the push destination — not merely mentioning
//     that name elsewhere in a longer branch name or a trailing comment
// Everything else — including force-pushes to feature branches and `rm -rf`
// against ordinary project subdirectories — is intentionally left alone.
// Fails OPEN on any error, timeout, or unrecognized shape — a hook bug must
// never wedge Cascade.
//
// Classification is TOKENIZE-based (split into shell segments, then
// whitespace-split tokens), not a single mega-regex over the raw string —
// this keeps every check linear in input length. `command_line` longer than
// MAX_COMMAND_LENGTH is allowed outright before any pattern matching runs:
// no realistic destructive command is anywhere near that long, so the cap
// both fails open on pathological input and bounds the worst-case cost of
// every classifier below (defense-in-depth against regex-based DoS).
//
// Cascade hooks docs (reference): https://docs.windsurf.com/llms-full.txt ,
//                                  https://docs.devin.ai/desktop/cascade/hooks

'use strict';

const { allow, deny } = require('./lib/hook-exit.js');

// #3911 (ADR-3889 Phase 7): the exit(2) call site (block(), below) is
// migrated to hook-exit.js's deny(undefined, reason) now that
// hooks/lib/cli-exit.js's terminateNow emits fd 1 and fd 2 (stderrPayload)
// in INDEPENDENT try/catch blocks — `payload=undefined` cleanly skips the
// fd 1 write (preserving "nothing written to stdout") instead of throwing
// into a shared catch that used to also swallow the fd 2 write, which is
// what silently dropped the deny reason before this fix.

// No realistic destructive command comes anywhere close to this length.
const MAX_COMMAND_LENGTH = 4096;

// Classic bash fork bomb: `:(){ :|:& };:`
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

// Command-prefix wrappers to look through when locating the "real" command at
// the head of a segment: `sudo rm -rf /`, `/bin/rm -rf /` (basename strip),
// `env FOO=1 rm -rf /` (env's leading VAR=val args are skipped too).
const CMD_PREFIXES = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'doas']);

// Bare filesystem-root-class tokens for `rm`'s target. Ordinary paths like
// `/tmp/foo` or `/home/user/project` never match this set.
const ROOT_SENTINELS = new Set(['/', '/*', '~', '~/', '$HOME', '${HOME}']);

const PROTECTED_BRANCHES = new Set(['main', 'master', 'next']);

// ---------------------------------------------------------------------------
// Tokenizing helpers
// ---------------------------------------------------------------------------

// Split a command line into shell segments on `;`, `&&`, `||`, `|`, newline —
// each segment is classified independently.
function splitSegments(cmd) {
  return cmd.split(/\|\||&&|[;\n|]/);
}

// A `#` starts a bash comment when it's the first character of a "word"
// (preceded by whitespace, or at the very start of the segment). Strip it
// before classifying, so a comment mentioning a protected branch name never
// counts as a real command argument.
function stripBashComment(segment) {
  const m = segment.match(/(^|\s)#/);
  if (!m) return segment;
  const idx = m.index + m[1].length;
  return segment.slice(0, idx).replace(/\s+$/, '');
}

function tokenize(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

// Strip any directory path from a token: `/bin/rm` -> `rm`.
function basename(tok) {
  const parts = tok.split(/[\\/]/);
  return parts[parts.length - 1] || tok;
}

// Find the index of the "real" command token in a token list, skipping past
// known command-prefix wrappers (and, for `env`, its leading VAR=val args).
function indexOfCommandAfterPrefixes(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const base = basename(tokens[i]).toLowerCase();
    if (!CMD_PREFIXES.has(base)) return i;
    const wasEnv = base === 'env';
    i++;
    if (wasEnv) {
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    }
  }
  return i;
}

// True if `tokens` contains a flag matching either the exact long form, or a
// combined/short `-xyz` cluster containing `shortChar` (e.g. `-rf`, `-fr`,
// `-r`). A single `[a-zA-Z]+` quantifier with no nested ambiguity — linear,
// no catastrophic backtracking regardless of token length.
function hasFlag(tokens, shortChar, longFlag) {
  return tokens.some((t) => {
    if (t === longFlag) return true;
    if (t.length > 1 && t[0] === '-' && t[1] !== '-' && /^[a-zA-Z]+$/.test(t.slice(1))) {
      return t.slice(1).toLowerCase().includes(shortChar);
    }
    return false;
  });
}

function isRootSentinel(tok) {
  if (ROOT_SENTINELS.has(tok)) return true;
  // Bare Windows drive root: `C:\` or `C:/`.
  if (/^[A-Za-z]:[\\/]$/.test(tok)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Classifiers (each operates on one already comment-stripped segment)
// ---------------------------------------------------------------------------

// `rm` (any flag order/spelling, optionally through `sudo`/`env FOO=1`/an
// absolute path/etc.) with BOTH a recursive flag and a force flag, targeting
// a bare filesystem-root-class token.
function isDestructiveRmRf(segment) {
  const tokens = tokenize(segment);
  const cmdIdx = indexOfCommandAfterPrefixes(tokens);
  if (cmdIdx >= tokens.length) return null;
  if (basename(tokens[cmdIdx]) !== 'rm') return null;
  const args = tokens.slice(cmdIdx + 1);
  const hasRecursive = hasFlag(args, 'r', '--recursive');
  const hasForce = hasFlag(args, 'f', '--force');
  if (!hasRecursive || !hasForce) return null;
  const rootTok = args.find(isRootSentinel);
  if (rootTok) return `rm -rf targeting the filesystem root or home directory ('${rootTok}')`;
  return null;
}

function isWindowsRootSentinel(tok) {
  if (/^[A-Za-z]:\\?$/.test(tok)) return true;
  if (/^\$env:userprofile\\?$/i.test(tok)) return true;
  if (/^~\\?$/.test(tok)) return true;
  return false;
}

function isWindowsDriveRoot(tok) {
  return /^[A-Za-z]:\\?$/.test(tok);
}

// Windows equivalents: `Remove-Item -Recurse -Force <drive-root|profile-root>`
// and `rd /s /q <drive-root>` / `rmdir /s /q <drive-root>`.
function isDestructiveWindowsRmRf(segment) {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;
  const first = basename(tokens[0]).toLowerCase();
  const rest = tokens.slice(1);
  if (first === 'remove-item') {
    const hasRecurse = rest.some((t) => t.toLowerCase() === '-recurse');
    const hasForce = rest.some((t) => t.toLowerCase() === '-force');
    if (hasRecurse && hasForce && rest.some(isWindowsRootSentinel)) {
      return 'Remove-Item -Recurse -Force targeting a drive root or user-profile root';
    }
    return null;
  }
  if (first === 'rd' || first === 'rmdir') {
    const hasS = rest.some((t) => t.toLowerCase() === '/s');
    const hasQ = rest.some((t) => t.toLowerCase() === '/q');
    if (hasS && hasQ) {
      const rootTok = rest.find(isWindowsDriveRoot);
      if (rootTok) return `rd /s /q targeting drive root '${rootTok}'`;
    }
    return null;
  }
  return null;
}

function isForceToken(tok) {
  if (tok === '--force' || tok === '-f') return true;
  if (/^--force-with-lease(=.*)?$/i.test(tok)) return true;
  if (tok.startsWith('+')) return true;
  return false;
}

// Resolve the branch a push-argument token targets, honoring `+<dst>` and
// `<src>:<dst>` refspec forms and an optional `refs/heads/` prefix. Returns
// the lower-cased protected branch name, or null. Whole-token comparison
// only — `feature/main-fix` never matches `main`.
function protectedTargetFromToken(tok) {
  let t = tok;
  if (t.startsWith('+')) t = t.slice(1);
  const colonIdx = t.lastIndexOf(':');
  const candidate = colonIdx !== -1 ? t.slice(colonIdx + 1) : t;
  const stripped = candidate.replace(/^refs\/heads\//i, '');
  const lower = stripped.toLowerCase();
  return PROTECTED_BRANCHES.has(lower) ? lower : null;
}

// `git push` with a force flag/refspec AND an explicit protected-branch push
// target (main / master / next — see scripts/setup-branch-protection.sh).
function isProtectedBranchForcePush(segment) {
  const tokens = tokenize(segment);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].toLowerCase() === 'git' && tokens[i + 1].toLowerCase() === 'push') {
      const rest = tokens.slice(i + 2);
      if (!rest.some(isForceToken)) return null;
      for (const tok of rest) {
        const target = protectedTargetFromToken(tok);
        if (target) return `git push --force targeting protected branch '${target}'`;
      }
      return null;
    }
  }
  return null;
}

function destructiveReason(cmd) {
  if (FORK_BOMB_RE.test(cmd)) return 'fork-bomb pattern';
  for (const rawSegment of splitSegments(cmd)) {
    const segment = stripBashComment(rawSegment).trim();
    if (!segment) continue;
    const reason = isDestructiveRmRf(segment)
      || isDestructiveWindowsRmRf(segment)
      || isProtectedBranchForcePush(segment);
    if (reason) return reason;
  }
  return null;
}

function block(reason) {
  deny(undefined, `GSD windsurf pre_run_command guard: ${reason}\n`);
}

let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input || '{}');
    const toolInfo = (data && typeof data.tool_info === 'object' && data.tool_info) || {};
    const commandLine = typeof toolInfo.command_line === 'string' ? toolInfo.command_line : '';
    if (!commandLine) { allow(undefined); return; }
    if (commandLine.length > MAX_COMMAND_LENGTH) { allow(undefined); return; }

    const reason = destructiveReason(commandLine);
    if (reason) { block(reason); return; }
    allow(undefined);
  } catch {
    // Silent fail-open — never block a valid tool call due to a hook bug.
    allow(undefined);
  }
});
