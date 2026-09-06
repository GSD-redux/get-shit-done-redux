#!/usr/bin/env node
'use strict';

/**
 * lint-allowed-tools-parity.cjs — catch `allowed-tools` frontmatter that
 * declares `Bash` but omits `Grep` (#4394, follow-up to #3085).
 *
 * ## Why
 *
 * `gen-plugin-skills.cjs --check` already guarantees `skills/*` /SKILL.md`
 * matches byte-for-byte what `commands/gsd/*.md` generates, so the two trees
 * cannot silently diverge FROM EACH OTHER. Nothing guarded the shape #3085
 * actually found: a command shipping `Bash` without `Grep` purely by
 * omission, identical in both trees and therefore invisible to a parity
 * check that only compares them to each other.
 *
 * That drift ran long enough for 29 of 71 skills to lack a tool most of
 * their siblings already declared, and it surfaced through a manual audit
 * rather than any gate. A command that can shell out but cannot Grep does
 * not fail loudly — it quietly reaches for `Bash` + `grep` instead, which is
 * slower, less structured, and (per `lint-portable-grep.cjs`) a portability
 * hazard of its own on hosts without GNU grep.
 *
 * ## The rule
 *
 * A command whose `allowed-tools` includes `Bash` must also include `Grep`,
 * unless it is on the exemption list below.
 *
 * Detection only. This lint never edits a command's `allowed-tools`.
 *
 * ## Why an exemption list rather than a heuristic
 *
 * The alternative — inferring from a command's body whether it "really"
 * needs Grep — would make the rule's verdict depend on prose that changes
 * constantly, and produce a lint whose failures nobody can predict. A short
 * literal list keeps every exemption a reviewable one-line diff, and the
 * staleness check below stops it becoming a dumping ground: an entry that no
 * longer needs to be there fails just as loudly as a missing tool.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = 'commands/gsd';

/**
 * Commands allowed to declare `Bash` without `Grep`.
 *
 * Keyed by command stem (the filename without `.md`), with the reason inline
 * so changing the set is a one-line, reviewable diff.
 *
 * #4394 named eight candidates from the #3085 review: the six `gsd-ns-*`
 * namespace dispatchers, `gsd-help`, and `gsd-surface`. Seven of those turn
 * out not to need an entry at all — they do not declare `Bash` in the first
 * place, so the rule never reaches them:
 *
 *   ns-context/ns-ideate/ns-manage/ns-project/ns-review/ns-workflow  Read + Skill
 *   help                                                             Read
 *
 * Listing them anyway would be seven pre-forgiven commands: the day one of
 * them gained `Bash`, the omission it was granted an exemption for would
 * pass silently. The staleness check in `scan()` below is what surfaced
 * this, and it is why the list stays minimal — an exemption is a real
 * suppression, not documentation.
 */
const EXEMPT = new Map([
  // Toggles which skills are surfaced. Mutates the install tree through the
  // installer's own seams rather than by searching project files, so `Bash`
  // here is not standing in for a search it cannot perform.
  ['surface', 'mutates the install surface via installer seams, not by searching the project'],
]);

/**
 * Parse an `allowed-tools` frontmatter value.
 *
 * Handles both shapes the corpus uses: a YAML block sequence
 *
 *     allowed-tools:
 *       - Read
 *       - Bash
 *
 * and an inline scalar or flow sequence (`allowed-tools: Read, Bash` /
 * `allowed-tools: [Read, Bash]`). Returns `null` when the key is absent,
 * which is NOT a violation — a command with no `allowed-tools` at all
 * declares no `Bash` either, so this rule has nothing to say about it.
 *
 * Deliberately not a YAML parser: the frontmatter here is a fixed, shallow
 * shape, and pulling in a parser to read one list would be a dependency
 * bought for a single key.
 *
 * @param {string} text  full file contents
 * @returns {string[] | null}  declared tool names, or null when the key is absent
 */
function parseAllowedTools(text) {
  const lines = String(text).split(/\r?\n/);
  const keyIndex = lines.findIndex((l) => /^allowed-tools:/.test(l));
  if (keyIndex === -1) return null;

  const inline = lines[keyIndex].replace(/^allowed-tools:/, '').trim();
  if (inline) {
    return inline
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  const tools = [];
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const item = line.match(/^\s*-\s+(.+?)\s*$/);
    if (item) {
      tools.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    // The first line that is neither a list item nor blank ends the block —
    // the next frontmatter key, or the closing `---`.
    if (line.trim() === '') continue;
    break;
  }
  return tools;
}

/**
 * List command stems under `dir`, sorted.
 *
 * @param {string} dir  absolute path to the commands directory
 * @returns {{ stem: string, file: string }[]}
 */
function listCommands(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ stem: e.name.replace(/\.md$/, ''), file: path.join(dir, e.name) }))
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

/**
 * Evaluate the corpus.
 *
 * Reports two independent failure classes, because an exemption list that
 * can only ever grow rots into a list of things nobody re-examined:
 *
 *   - `violations`: declares Bash, omits Grep, not exempt.
 *   - `staleExemptions`: on the list but no longer needs to be — either the
 *     command is gone, or it no longer declares Bash without Grep. Removing
 *     the entry is then a one-line diff, and the next omission in that
 *     command is caught rather than silently pre-forgiven.
 *
 * @param {string} [root]  repo-relative commands directory
 * @returns {{ scanned: number, violations: {stem: string, tools: string[]}[], staleExemptions: {stem: string, reason: string}[] }}
 */
function scan(root = DEFAULT_ROOT) {
  const abs = path.isAbsolute(root) ? root : path.join(ROOT, root);
  const commands = listCommands(abs);
  const violations = [];
  const seen = new Set();

  for (const { stem, file } of commands) {
    const tools = parseAllowedTools(fs.readFileSync(file, 'utf8'));
    if (!tools) continue;
    if (!tools.includes('Bash') || tools.includes('Grep')) continue;
    seen.add(stem);
    if (EXEMPT.has(stem)) continue;
    violations.push({ stem, tools });
  }

  const present = new Set(commands.map((c) => c.stem));
  const staleExemptions = [];
  for (const [stem, reason] of EXEMPT) {
    if (!present.has(stem)) {
      staleExemptions.push({ stem, reason: `no such command (${reason})` });
    } else if (!seen.has(stem)) {
      staleExemptions.push({ stem, reason: `no longer declares Bash without Grep (${reason})` });
    }
  }

  return { scanned: commands.length, violations, staleExemptions };
}

function main() {
  const root = process.env.GSD_LINT_ALLOWED_TOOLS_ROOT || DEFAULT_ROOT;
  const { scanned, violations, staleExemptions } = scan(root);

  if (violations.length > 0 || staleExemptions.length > 0) {
    const parts = [];
    if (violations.length > 0) {
      parts.push(
        'lint-allowed-tools-parity: these commands declare `Bash` but not `Grep` (#4394).\n' +
          'A command that can shell out but cannot Grep reaches for `Bash` + `grep` instead —\n' +
          'slower, unstructured, and a portability hazard on hosts without GNU grep. Add `Grep`\n' +
          'to the frontmatter, or add the command to EXEMPT in this script with a reason:\n' +
          violations.map((v) => `  ${root}/${v.stem}.md  [${v.tools.join(', ')}]`).join('\n'),
      );
    }
    if (staleExemptions.length > 0) {
      parts.push(
        'lint-allowed-tools-parity: these EXEMPT entries are stale — delete them so the next\n' +
          'omission in those commands is caught rather than silently pre-forgiven:\n' +
          staleExemptions.map((s) => `  ${s.stem}: ${s.reason}`).join('\n'),
      );
    }
    throw new ExitError(1, parts.join('\n\n'));
  }

  console.log(
    `ok lint-allowed-tools-parity: ${scanned} command(s) checked, ${EXEMPT.size} exemption(s) all still needed`,
  );
}

module.exports = { parseAllowedTools, scan, EXEMPT, DEFAULT_ROOT };

if (require.main === module) runMain(main);
