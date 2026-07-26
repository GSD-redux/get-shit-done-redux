/**
 * Agent tools-contract parsing — the single seam for reading an agent's
 * declared `tools:` contract (#2540 review).
 *
 * `tools:` frontmatter appears in two YAML shapes across agents/*.md:
 *
 *   inline      tools: Read, Write, Edit
 *   block list  tools:
 *                 - Read
 *                 - Write
 *
 * The previous single-line regex (`/^tools:\s*(.+)$/m`) reduced a block list
 * to the literal string "- <first item>" because `\s*` consumed the newline —
 * so gsd-nyquist-auditor (block list, declares Write/Edit) derived a
 * `read-only` Codex sandbox while the semantic validator, sharing the same
 * regex, reported it clean. Every consumer of the contract (the install-time
 * sandbox derivation and role-header emit in bin/install.js, the Codex agent
 * converter in runtime-artifact-conversion.cts, and the semantic validator in
 * agent-install-check.cts) must parse through this module so the shapes can
 * never diverge again.
 *
 * Parsing contract (deliberately bounded): tool names are simple identifiers
 * (`Read`, `mcp__context7__*`, `Agent(...)`) — this parser handles the YAML
 * shapes those realistically appear in (plain/quoted scalars, comments,
 * inline/block/flow lists) and does NOT implement full YAML scalar semantics
 * (escape sequences inside quotes, commas inside quoted flow items). Exotic
 * scalars cannot silently mis-derive a sandbox: the repo-gate parity test
 * (tests/codex-config.test.cjs) compares this parser against js-yaml over
 * every real agents/*.md, so any agent introducing such a shape fails CI
 * loudly, at which point either the name is simplified or this parser grows.
 */

// File-mutating tools whose presence in an agent's `tools:` contract requires
// a write-capable Codex sandbox (#2540).
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Cut a trailing YAML comment off a line, quote-aware: a `#` inside single or
 * double quotes is data; outside quotes it starts a comment when it opens the
 * line or follows whitespace (js-yaml parity).
 */
function _stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function _cleanItem(value: string): string {
  const trimmed = _stripLineComment(value).trim();
  // Quoted values keep their content verbatim (a `#` inside quotes is data).
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  if (quoted) return quoted[2] ?? '';
  return trimmed;
}

/**
 * Parse the `tools:` contract out of a YAML-shaped scope (agent frontmatter
 * or a <codex_agent_role> header body) into the list of declared tool names.
 *
 * Handles the inline comma-separated form, the block-list form (any item
 * indentation, blank lines between items allowed), and the bracketed flow
 * form (`tools: [Read, Write]`). Returns [] when no contract is declared.
 */
function parseToolsContract(scope: string): string[] {
  const lines = (scope ?? '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^tools:/.test(l));
  if (idx === -1) return [];
  // Cut a trailing comment BEFORE the bracket check so `tools: [A, B] # note`
  // still takes the flow branch (js-yaml parity).
  let inline = _stripLineComment((lines[idx] ?? '').slice('tools:'.length)).trim();
  if (inline) {
    if (inline.startsWith('[') && inline.endsWith(']')) {
      inline = inline.slice(1, -1);
    }
    return inline
      .split(',')
      .map((t) => _cleanItem(t))
      .filter(Boolean);
  }
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue; // blank lines inside a block sequence are valid YAML
    // A comment line between items must not terminate the scan — the module
    // contract lists comments as in scope, and truncating here silently
    // dropped every tool after the comment (review round 2).
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (!m) break; // next mapping key (or end of the sequence scope)
    const item = _cleanItem(m[1] ?? '');
    if (item) items.push(item);
  }
  return items;
}

/**
 * Whether a declared tool list requires a write-capable sandbox.
 */
function toolsRequireWrite(tools: readonly string[]): boolean {
  return tools.some((t) => WRITE_TOOLS.has(t));
}

export = {
  parseToolsContract,
  toolsRequireWrite,
};
