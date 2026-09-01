#!/usr/bin/env node
'use strict';

/**
 * lint-portable-grep.cjs — ban GNU-only `grep -P`/`--perl-regexp` in gsd
 * workflow / agent / reference / command markdown (#4112 macOS regression).
 *
 * ## Why
 *
 * `-P`/`--perl-regexp` selects GNU grep's PCRE engine. Stock macOS ships BSD
 * grep, which does not implement `-P` at all — the call errors out ("grep:
 * invalid option -- P" or "unknown option") on that host, and a pipeline like
 * `... | grep -oP '...' || true` swallows that error and silently resolves to
 * an empty string instead of failing loudly.
 *
 * This is exactly what happened in `gsd-core/workflows/pause-work.md`'s
 * Context Detection step (#4112, merged as #4140): the fix for the `$((`
 * shell-syntax bug left `grep -oP 'phases/\K[^/]+'` in place. That construct
 * had never been exercised on macOS before (the syntax error masked it), so
 * fixing the syntax bug newly exposed a second, pre-existing macOS-only
 * defect — phase/spike/sketch detection silently resolving to "" on macOS —
 * which the PR's own new regression test then caught, but only in the
 * post-merge `full test (macos-latest, ...)` matrix. That lane runs on push
 * to the base branch, not on the pull_request event, so nothing pre-merge
 * (gsd-test's Linux-only benches included) could have caught it before `next`
 * went red.
 *
 * This is the same class of defect `lint-portable-timeout.cjs` (#2351) exists
 * for: a GNU-coreutils assumption baked into workflow markdown that every
 * pre-merge gate is blind to because none of them run on macOS. The fix here
 * is the same shape — a static ratchet that catches the assumption in the
 * markdown itself, before a shell ever executes it on the platform that lacks
 * the flag.
 *
 * ## What PASSES
 *
 * - `grep -o '...'`, `grep -E '...'`, `egrep`/`fgrep` without `-P`.
 * - `-P` appearing as part of an unrelated long option (`--path`, `--perl`) —
 *   only a `-P`/short-cluster-containing-`P` token or the literal
 *   `--perl-regexp` counts.
 * - Prose that merely mentions "grep -P" outside of a fenced command context
 *   is still flagged (this lint does not parse fences) — the roots below are
 *   restricted to directive markdown where a `grep -P` mention is always
 *   either a real invocation or a specimen to fix, never neutral prose.
 *
 * ## What FAILS
 *
 * A `grep`/`egrep`/`fgrep` invocation whose flag cluster includes `P`
 * (`-P`, `-oP`, `-Po`, `-iP`, ...) or the long form `--perl-regexp`.
 *
 * ## Portable replacements
 *
 * - Extracting a path component: `basename "$(dirname "$path")")` instead of
 *   `grep -oP 'seam/\K[^/]+'`.
 * - Extracting a token after a flag: `sed -E 's#.*--flag[[:space:]]+([^[:space:]]+).*#\1#'`
 *   instead of `grep -oP '(?<=--flag )\S+'` — POSIX ERE (`-E`) has no
 *   lookbehind, so capture the group and let `sed` emit just it. `-E` (not
 *   GNU-only `-r`) is supported by both BSD and GNU `sed`. (A `/`-delimited
 *   sed command ending in a star-quantifier would place a star immediately
 *   before a slash, closing this very JSDoc block comment early — hence the
 *   `#`-delimited form used above.)
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

// Surfaces whose markdown carries agent-executed bash. Mirrors
// lint-portable-timeout.cjs's roots — the same files that can ship shell
// snippets which a bash/zsh host on macOS actually executes.
const DEFAULT_ROOTS = ['gsd-core/workflows', 'gsd-core/references', 'agents', 'commands'];

// A `grep`/`egrep`/`fgrep` token, anchored to a command position (line start,
// right after `| & ; ( \` {`, or right after a shell keyword that opens a new
// command — `then`/`do`/`else`/`elif`) so prose mentioning "grep -P" in
// running text is still caught in these directive-markdown roots (see file
// header) without also matching an unrelated word ending in "grep". The
// keyword alternative is `\b`-bounded on both sides, so a bare mention of the
// word "then"/"do"/etc. with no following grep never matches on its own.
const GREP_INVOCATION_RE = /(?:^|[|&;(`{]|\b(?:then|do|else|elif)\b)[ \t]*(?:e|f)?grep\b/g;

// A `-P` short-flag cluster (e.g. `-P`, `-oP`, `-Po`, `-iP`) or the long form
// `--perl-regexp`, as a standalone token.
const PERL_FLAG_RE = /(?:^|\s)-[a-zA-Z]*P[a-zA-Z]*(?=\s|$)|--perl-regexp\b/;

/**
 * Locate `grep -P`/`--perl-regexp` invocations in a block of text.
 *
 * Pure (no I/O): callers pass file contents; the caller reads files. For each
 * `grep`-family invocation on a line, inspects only the segment from that
 * invocation to the next `|`/`;`/end-of-line, so a `-P`-bearing token in a
 * later, unrelated command on the same line is never mistaken for a grep flag.
 *
 * @param {string} text  file contents
 * @returns {{ line: number, snippet: string }[]}  findings (empty array = clean)
 */
function findPerlGrepInvocations(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    GREP_INVOCATION_RE.lastIndex = 0;
    let match;
    while ((match = GREP_INVOCATION_RE.exec(line)) !== null) {
      const startAt = match.index + match[0].length;
      const rest = line.slice(startAt);
      const nextPipe = rest.search(/[|;`]/);
      const segment = nextPipe === -1 ? rest : rest.slice(0, nextPipe);
      if (PERL_FLAG_RE.test(segment)) {
        findings.push({ line: i + 1, snippet: line.trim() });
        break; // one finding per line is enough context to fix it
      }
    }
  }
  return findings;
}

function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a missing root is not an error — some surfaces are optional
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Scan the given roots (repo-relative) for `grep -P`/`--perl-regexp` invocations.
 * @param {string[]} roots
 * @returns {{ file: string, line: number, snippet: string }[]}
 */
function scan(roots = DEFAULT_ROOTS) {
  const offenders = [];
  for (const rel of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    for (const file of walkMarkdown(abs)) {
      const findings = findPerlGrepInvocations(fs.readFileSync(file, 'utf8'));
      for (const f of findings) {
        offenders.push({ file: path.relative(ROOT, file), line: f.line, snippet: f.snippet });
      }
    }
  }
  return offenders;
}

function main() {
  const rootsEnv = process.env.GSD_LINT_PORTABLE_GREP_ROOTS;
  const roots = rootsEnv ? rootsEnv.split(path.delimiter).filter(Boolean) : DEFAULT_ROOTS;
  const offenders = scan(roots);
  if (offenders.length > 0) {
    const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join('\n');
    throw new ExitError(
      1,
      'lint-portable-grep: `grep -P`/`--perl-regexp` is not portable — stock macOS ships\n' +
        'BSD grep, which has no `-P`, so the call errors and a `|| true`/`$(...)` fallback\n' +
        'silently resolves to empty output instead of failing loudly (#4112). Use\n' +
        '`basename "$(dirname "$path")")` for path-component extraction, or\n' +
        '`sed -E \'s/.../\\1/\'` (POSIX ERE, no lookbehind needed) for token extraction:\n' +
        detail,
    );
  }
  console.log(`ok lint-portable-grep: no GNU-only grep -P invocations in ${roots.length} root(s)`);
}

module.exports = { findPerlGrepInvocations, scan, DEFAULT_ROOTS };

if (require.main === module) runMain(main);
