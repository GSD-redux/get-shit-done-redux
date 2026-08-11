#!/usr/bin/env node
'use strict';

/**
 * lint-frontmatter-scalar-broad-grep.cjs — DEFECT.FRONTMATTER-SCALAR-BROAD-GREP
 * (CONTEXT.md).
 *
 * ## Why
 *
 * A YAML-frontmatter scalar (e.g. VERIFICATION.md `status:`) read with
 * `grep "^key:"` over the WHOLE markdown report instead of the frontmatter
 * block returns extra matches whenever a `key:` line also appears in the
 * body (a code block, a copied artifact, an example). Piped into
 * `cut`/`tr`, those extra matches concatenate into a value that matches no
 * expected token, silently misrouting a valid state (#586/PR #650:
 * `grep "^status:"` also matched body `status:` lines, yielding
 * `passed+gaps_found+human_needed` instead of `passed` and blocking a
 * passed phase).
 *
 * The fix-forward is to scope the grep to the leading frontmatter block and
 * take only the first match:
 *   sed -n '/^---$/,/^---$/p' "$f" | grep -m1 "^<key>:" | cut -d: -f2 | tr -d ' '
 *
 * ## What this scans
 *
 * Every fenced ```bash / ```sh code block in `gsd-core/workflows/*.md`,
 * `agents/*.md`, and `commands/**\/*.md`. Within each block, flags a
 * `grep "^key:"` / `grep '^key:'` invocation that:
 *   - is NOT preceded (earlier in the SAME block) by a frontmatter-scoping
 *     idiom (`sed -n '/^---$/,/^---$/p'`, a JS `/^---\n([\s\S]*?)\n---/`
 *     extraction, or an equivalent range over the `---` delimiter), AND
 *   - does NOT carry a `-m1` (or `-m 1`) flag, and is NOT immediately piped
 *     into `head -1`/`head -n 1` (frontmatter always precedes the body in
 *     these generated reports, so `head -1` on the whole file is the same
 *     single-match guarantee as `-m1`), AND
 *   - is used for exact-token comparison: piped (same line) into
 *     `cut`/`tr`, or captured into a shell variable that is later compared
 *     via `==`/`case` elsewhere in the same block.
 *
 * ## False-positive risk (moderate-to-high, per audit)
 *
 * Some `grep "^key:"` uses are intentionally whole-body (scanning multiple
 * report files at once, not one frontmatter block) and are not a bug. Add
 * `# lint-allow: frontmatter-scalar-broad-grep — <reason>` on the same line
 * (or the line immediately above) to suppress a specific invocation.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ROOTS = ['gsd-core/workflows', 'agents', 'commands'];

const FENCE_RE = /^```(bash|sh)\s*$/;
const FENCE_END_RE = /^```\s*$/;

// A `grep "^key:"` / `grep '^key:'` invocation. Captures the key name and the
// full option string preceding the pattern (so callers can check for -m1).
const GREP_KEY_RE = /grep\s+((?:-\S+\s+)*)(["'])\^([A-Za-z_][\w-]*):\2/;

// A frontmatter-scoping idiom: a delimiter-range extraction anchored on the
// `---` frontmatter fence, opened by `^---` (sed/awk `/^---$/,/^---$/p`, or a
// JS regex like `/^---\n([\s\S]*?)\n---/`) and closed by a second `---`
// within a short window. Matches both idioms without caring which language
// wrote the delimiter.
const FRONTMATTER_SCOPE_RE = /\^---[\s\S]{0,300}?---/;

const ALLOW_RE = /#\s*lint-allow:\s*frontmatter-scalar-broad-grep/;

// `| head -1` / `| head -n 1` immediately after the grep is functionally
// equivalent to `-m1` for this check: frontmatter always precedes the body
// in these generated reports, so the first grep match is always the
// frontmatter's, and `head -1` discards every later (body) match exactly
// like `-m1` would.
function hasSingleMatchGuard(line, optionString) {
  if (/(^|\s)-m\s*1(\s|$)/.test(optionString) || /(^|\s)--max-count[= ]1(\s|$)/.test(optionString)) return true;
  return /\|\s*head\s+(-1|-n\s*1)\b/.test(line);
}

function isSuppressed(lines, idx) {
  if (ALLOW_RE.test(lines[idx])) return true;
  if (idx > 0 && ALLOW_RE.test(lines[idx - 1])) return true;
  return false;
}

/**
 * Extract fenced ```bash/```sh code blocks from markdown text.
 * @param {string} text
 * @returns {{ startLine: number, lines: string[] }[]}
 */
function extractBashBlocks(text) {
  const allLines = text.split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let blockLines = [];
  let blockStart = 0;
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (!inBlock && FENCE_RE.test(line.trim())) {
      inBlock = true;
      blockLines = [];
      blockStart = i + 2; // first line INSIDE the block is 1-indexed i+2
      continue;
    }
    if (inBlock && FENCE_END_RE.test(line.trim())) {
      blocks.push({ startLine: blockStart, lines: blockLines });
      inBlock = false;
      continue;
    }
    if (inBlock) blockLines.push(line);
  }
  return blocks;
}

/**
 * Pure: find every un-scoped, token-comparison `grep "^key:"` invocation in a
 * single fenced bash/sh block's lines. Returns `{ line, key, snippet }[]`
 * (line numbers relative to the block's startLine, already offset by caller).
 * @param {string[]} lines
 * @returns {{ lineIndex: number, key: string, snippet: string }[]}
 */
function findBroadGrepsInBlock(lines) {
  const findings = [];
  // Variables assigned from a grep-key capture on this block, so a later
  // `==`/`case` use of that variable (without an intervening scope/-m1) also
  // counts as "used for exact-token comparison".
  const capturedVars = new Set();
  let scopeSeenAt = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FRONTMATTER_SCOPE_RE.test(line)) {
      scopeSeenAt = i;
    }

    const m = line.match(GREP_KEY_RE);
    if (!m) continue;
    const [, options, , key] = m;
    if (hasSingleMatchGuard(line, options)) continue;
    if (isSuppressed(lines, i)) continue;
    // Scoping must appear strictly before this grep line in the same block.
    const scoped = scopeSeenAt !== -1 && scopeSeenAt <= i;
    if (scoped) continue;

    const pipedToTokenTool = /\|\s*(cut|tr)\b/.test(line);
    const assignMatch = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)=\$\(/);
    if (assignMatch) capturedVars.add(assignMatch[1]);

    let comparedLater = false;
    if (assignMatch) {
      const varName = assignMatch[1];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (
          new RegExp(`\\$\\{?${varName}\\}?"?\\s*(==|!=)`).test(lines[j])
          || new RegExp(`case\\s+"?\\$\\{?${varName}\\}?"?\\s+in`).test(lines[j])
        ) {
          comparedLater = true;
          break;
        }
      }
    }

    if (pipedToTokenTool || comparedLater) {
      findings.push({ lineIndex: i, key, snippet: line.trim() });
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
 * Scan the given roots (repo-relative) for un-scoped frontmatter-scalar
 * broad-greps.
 * @param {string[]} roots
 * @returns {{ file: string, line: number, key: string, snippet: string }[]}
 */
function scan(roots = DEFAULT_ROOTS) {
  const offenders = [];
  for (const rel of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    for (const file of walkMarkdown(abs)) {
      const blocks = extractBashBlocks(fs.readFileSync(file, 'utf8'));
      for (const block of blocks) {
        for (const finding of findBroadGrepsInBlock(block.lines)) {
          offenders.push({
            file: path.relative(ROOT, file),
            line: block.startLine + finding.lineIndex,
            key: finding.key,
            snippet: finding.snippet,
          });
        }
      }
    }
  }
  return offenders;
}

function main() {
  const rootsEnv = process.env.GSD_LINT_FRONTMATTER_SCALAR_ROOTS;
  const roots = rootsEnv ? rootsEnv.split(path.delimiter).filter(Boolean) : DEFAULT_ROOTS;
  const offenders = scan(roots);
  if (offenders.length > 0) {
    const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join('\n');
    throw new ExitError(
      1,
      'lint-frontmatter-scalar-broad-grep: `grep "^key:"` over the whole file, compared to an\n'
        + 'exact token, with no frontmatter scoping and no -m1 (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP).\n'
        + 'A body line beginning `key:` is enough to break this. Scope to the frontmatter block:\n'
        + '  sed -n \'/^---$/,/^---$/p\' "$f" | grep -m1 "^<key>:" | cut -d: -f2 | tr -d \' \'\n'
        + 'or add `# lint-allow: frontmatter-scalar-broad-grep — <reason>` if this is a genuine\n'
        + 'whole-body scan:\n'
        + detail,
    );
  }
  console.log(`ok lint-frontmatter-scalar-broad-grep: no un-scoped frontmatter-scalar greps in ${roots.length} root(s)`);
}

module.exports = { findBroadGrepsInBlock, extractBashBlocks, scan, DEFAULT_ROOTS };

if (require.main === module) runMain(main);
