#!/usr/bin/env node
/**
 * lint-docs-command-form.cjs
 *
 * Enforces the human-facing command form in docs/ (#2903).
 *
 * `/gsd:<cmd>` (and bare `gsd:<cmd>`) is a SOURCE-AUTHORING token: install-time
 * converters (`transformContentToHyphen`, `convertSlashCommandsTo<Runtime>SkillMentions`)
 * rewrite it to `/gsd-<cmd>` per-runtime. It is correct in `commands/gsd/**`,
 * `gsd-core/workflows/**`, and `agents/**` — but docs are never passed through a
 * converter, so a doc telling a reader to type `/gsd:<cmd>` names a command no
 * runtime registers. The real user-facing form is `/gsd-<cmd>`.
 *
 * This guard fails any `docs/**\/*.md` file that still contains `/gsd:<cmd>` or
 * bare `gsd:<cmd>` where `<cmd>` is a real command name (drawn from the
 * `commands/gsd/*.md` roster). It explicitly permits `/gsd-core:<cmd>` (the
 * Claude Code plugin namespace) and any `gsd:<token>` whose `<token>` is not a
 * real command (e.g. the `gsd:section` / `gsd:loop-host` workflow-fragment
 * marker syntax documented in docs/reference/workflow-fragments.md, or
 * `gsd:command-name` used as a placeholder while explaining the Gemini CLI
 * colon-form convention).
 *
 * Exclusions (never checked):
 *   - docs/adr/**                  (historical record)
 *   - docs/RELEASE-NOTES-LEGACY.md (maintainer question still open)
 *   - commands/gsd/**, gsd-core/workflows/**, agents/** — never touched by this
 *     guard at all; the colon form is correct there.
 *
 * Exemption — `name:` frontmatter key citations: source command files
 * (`commands/gsd/*.md`) carry the colon form in their `name:` YAML frontmatter
 * key (e.g. `name: gsd:next`). A doc that quotes that key verbatim — e.g.
 * `` `name: gsd:next` `` or `name: gsd:next` — is citing the real source file,
 * not telling a reader what to type. Rewriting that citation to `gsd-next`
 * would make the doc lie about the source it's quoting, so a `gsd:<cmd>` token
 * immediately preceded by `name:` (optionally with a backtick/whitespace in
 * between) is permitted. This is narrow: it does not exempt `gsd:<cmd>`
 * anywhere else on the line or file, including the reader-facing `/gsd-<cmd>`
 * form that may appear later in the same sentence.
 *
 * Detection is case-insensitive (`/GSD:next`, `Gsd:Next`, etc. are all
 * flagged) since the install-time converters and runtimes treat command names
 * case-insensitively in practice, and a doc typo in casing is still a lie
 * about the real command form.
 *
 * Exit 0 if no violations; exit 1 if any are found (with stderr diagnostics).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const SELF_PATH = path.resolve(__filename);
// GSD_LINT_DOCS_COMMAND_FORM_REPO_ROOT is used by tests to redirect the guard to
// a temporary fixture git repo without touching the real working tree.
const REPO_ROOT = process.env.GSD_LINT_DOCS_COMMAND_FORM_REPO_ROOT
  ? path.resolve(process.env.GSD_LINT_DOCS_COMMAND_FORM_REPO_ROOT)
  : path.resolve(__dirname, '..');

const DOCS_PREFIX = 'docs/';
const ADR_PREFIX = 'docs/adr/';
const RELEASE_NOTES_LEGACY = 'docs/RELEASE-NOTES-LEGACY.md';
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands/gsd');

// Matches `/gsd:<cmd>` and bare `gsd:<cmd>` (not part of `/gsd-core:<cmd>`,
// which does not contain the substring `gsd:` — the hyphen breaks it).
// Case-insensitive so `/GSD:next` / `Gsd:Next` are also caught.
const COMMAND_FORM_RE = /(^|[^A-Za-z0-9_-])(\/)?gsd:([A-Za-z0-9_-]+)/gi;

// A `gsd:<cmd>` token is exempt when it is a citation of a source file's
// YAML `name:` frontmatter key — i.e. the text immediately before the match
// (ending exactly where the match begins) is `name:` followed by optional
// whitespace and/or a backtick. Only applies to the bare (non-`/`) form,
// since the real frontmatter key never carries a leading slash.
const NAME_KEY_CITATION_RE = /name:\s*`?\s*$/i;

function loadRoster() {
  let entries;
  try {
    entries = fs.readdirSync(COMMANDS_DIR);
  } catch (err) {
    throw new ExitError(1, 'ERROR lint-docs-command-form: could not read commands/gsd: ' + err.message);
  }
  return new Set(
    entries.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
  );
}

function isCheckedDocsFile(relPath) {
  if (!relPath.startsWith(DOCS_PREFIX)) return false;
  if (relPath.startsWith(ADR_PREFIX)) return false;
  if (relPath === RELEASE_NOTES_LEGACY) return false;
  return relPath.endsWith('.md');
}

/**
 * Pure scan — no fs, no git. Returns violations for a single file's content.
 *
 * @param {string} relPath  file path (used only in violation records)
 * @param {string} content  file contents
 * @param {Set<string>} roster  valid command names
 * @returns {Array<{file:string, line:number, col:number, text:string}>}
 */
function scanContent(relPath, content, roster) {
  const violations = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    COMMAND_FORM_RE.lastIndex = 0;
    let match;
    while ((match = COMMAND_FORM_RE.exec(line)) !== null) {
      const [, pre, slash, cmd] = match;
      if (!roster.has(cmd.toLowerCase())) continue;
      if (!slash) {
        const preContext = line.slice(0, match.index + pre.length);
        if (NAME_KEY_CITATION_RE.test(preContext)) continue;
      }
      const matchedToken = (slash || '') + 'gsd:' + cmd;
      violations.push({
        file: relPath,
        line: i + 1,
        col: match.index + pre.length + 1,
        text: matchedToken,
      });
    }
  }
  return violations;
}

function main() {
  const roster = loadRoster();

  let trackedFiles;
  try {
    trackedFiles = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch (err) {
    throw new ExitError(1, 'ERROR lint-docs-command-form: git ls-files failed: ' + err.message);
  }

  const docsFiles = trackedFiles.filter(isCheckedDocsFile);
  const violations = [];

  for (const relPath of docsFiles) {
    const fullPath = path.join(REPO_ROOT, relPath);
    if (path.resolve(fullPath) === SELF_PATH) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      // Unreadable/deleted files — skip silently.
      continue;
    }

    violations.push(...scanContent(relPath, content, roster));
  }

  if (violations.length === 0) {
    process.stdout.write(
      'ok lint-docs-command-form: ' + docsFiles.length + ' file(s) checked, 0 violations\n',
    );
    return 0;
  }

  process.stderr.write('\nERROR lint-docs-command-form: ' + violations.length + ' violation(s) found\n\n');
  for (const v of violations) {
    process.stderr.write('  ' + v.file + ':' + v.line + ':' + v.col + ' — ' + JSON.stringify(v.text) + '\n');
  }
  process.stderr.write('\n');
  process.stderr.write(
    'Fix: docs are never passed through the install-time slash-form converters, so the\n',
  );
  process.stderr.write(
    '      colon form names a command no runtime registers. Rewrite to the hyphen form\n',
  );
  process.stderr.write(
    '      (`/gsd-<cmd>`), or `/gsd-core:<cmd>` if this is genuinely the Claude Code\n',
  );
  process.stderr.write('      plugin namespace.\n\n');
  return 1;
}

if (require.main === module) runMain(main);

module.exports = {
  scanContent,
  isCheckedDocsFile,
  loadRoster,
  COMMAND_FORM_RE,
};
