'use strict';
/**
 * command-contract-helpers.cjs  (ADR-0002)
 *
 * Single source of truth for the commands/gsd/*.md contract constants and
 * parsers shared by scripts/lint-command-contract.cjs and
 * tests/command-contract.test.cjs.
 *
 * Keeping these in one place ensures the lint script and the test suite
 * always agree on what constitutes a valid tool, a valid @-ref, and a valid
 * frontmatter structure. A new canonical tool added here is automatically
 * enforced by both consumers.
 */

const CANONICAL_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'Agent', 'Skill', 'SlashCommand',
  'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__context7__*',
]);

function parseFrontmatter(content) {
  // CRLF-tolerant split: Windows checkouts (autocrlf=true) leave a trailing
  // \r on every line, making lines.indexOf('---', 1) return -1 (the value
  // would be '---\r', not '---') → returns {} → every field appears missing.
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end === -1) return {};
  const fm = {};
  let key = null;
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kv) { key = kv[1]; fm[key] = kv[2].trim(); }
    else if (key && line.match(/^\s+-\s+/)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      fm[key] = fm[key] ? fm[key] + '\n' + val : val;
    }
  }
  return fm;
}

function executionContextRefs(content) {
  const refs = [];
  const re = /<execution_context(?:_extended)?>([\s\S]*?)<\/execution_context(?:_extended)?>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('@')) continue;
      const token = line.split(/\s+/)[0];
      const trailingProse = line.length > token.length;
      const normalized = token
        .replace(/^@(?:~|\$HOME)\//, '')
        .replace(/^(?:\.claude\/)?(?:gsd-core\/)?/, '');
      refs.push({ token, normalized, trailingProse });
    }
  }
  return refs;
}

/**
 * workflowPathRefs(content)
 *
 * Locates every gsd-core-relative workflow path referenced in a markdown
 * string, whether the reference is an eager @-include (already covered by
 * executionContextRefs) or a *lazy* path mentioned only in prose/code — a
 * path a command reads on demand via Read/Bash rather than an @-inclusion
 * the harness inlines automatically. Both kinds are load-bearing: the
 * progressive-disclosure split (#717) deliberately keeps most workflow
 * content out of the eager path so the common case stays cheap, but that
 * means a command naming a workflow only in prose is invisible to
 * executionContextRefs even though the runtime still needs the file to
 * exist. Recognizes three reference shapes:
 *
 *   A. Any path whose segments include `workflows/`, optionally preceded by
 *      an eager `@`, a home-dir prefix (`~/` or `$HOME/`), `.claude/`, and/or
 *      `gsd-core/` — e.g. `@~/.claude/gsd-core/workflows/scan.md`,
 *      `gsd-core/workflows/x.md`, or a bare `workflows/x.md`.
 *   B. Same as A but without the eager `@` — a lazy reference read on
 *      demand rather than inlined at load time.
 *   C. Parent-relative sub-file paths with no `workflows/` prefix at all —
 *      `execute-phase/steps/post-merge-gate.md` — implicitly rooted under
 *      `workflows/` because that's the only place `steps/`, `modes/`, and
 *      `templates/` subdirectories live.
 *
 * Traversal segments (`..`) are dropped rather than surfaced: this resolver
 * only ever reports paths under `workflows/`, never something a `..` could
 * walk outside of it. Results are de-duplicated, first-seen order preserved.
 */
function workflowPathRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(normalized) {
    if (normalized.split('/').includes('..')) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    refs.push(normalized);
  }

  const shapeARe = /@?(?:(?:~|\$HOME)\/)?(?:\.claude\/)?(?:gsd-core\/)?workflows\/[A-Za-z0-9._/-]+\.md/g;
  let m;
  while ((m = shapeARe.exec(content)) !== null) {
    const normalized = m[0]
      .replace(/^@/, '')
      .replace(/^(?:~|\$HOME)\//, '')
      .replace(/^\.claude\//, '')
      .replace(/^gsd-core\//, '');
    addRef(normalized);
  }

  const shapeCRe = /(?:^|[\s`("'>])([A-Za-z0-9._-]+\/(?:steps|modes|templates)\/[A-Za-z0-9._-]+\.md)/gm;
  while ((m = shapeCRe.exec(content)) !== null) {
    addRef('workflows/' + m[1]);
  }

  return refs;
}

module.exports = { CANONICAL_TOOLS, parseFrontmatter, executionContextRefs, workflowPathRefs };
