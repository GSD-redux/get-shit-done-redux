// allow-test-rule: runtime-contract-is-the-product — docs/AGENTS.md section layout + docs/INVENTORY.md table ARE the classification surface being validated
'use strict';

/**
 * Agent classification parity test (#1171)
 *
 * Makes docs/AGENTS.md section structure the single source of truth for
 * primary-vs-advanced agent classification, and fails when docs/INVENTORY.md
 * or the AGENTS.md prose counts drift from it.
 *
 * Classification rules (derived from AGENTS.md section placement):
 *   - ### gsd-<name> headings BEFORE "## Advanced and Specialized Agents" → "primary"
 *   - ### gsd-<name> headings INSIDE/AFTER that section → "advanced stub"
 *   - agents/gsd-*.md files with NO heading in AGENTS.md → "inventory only"
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_MD = path.join(ROOT, 'docs', 'AGENTS.md');
const INVENTORY_MD = path.join(ROOT, 'docs', 'INVENTORY.md');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse AGENTS.md and return two arrays:
 *   primaryHeadings  — agent names (without "gsd-" prefix) before the advanced section
 *   advancedHeadings — agent names inside "## Advanced and Specialized Agents"
 *
 * We work with the full "gsd-<name>" slug so the names are unambiguous.
 *
 * State machine (three-state):
 *   'before'   — before "## Advanced and Specialized Agents"
 *   'advanced' — inside that section
 *   'past'     — after a subsequent ## heading that follows the advanced section
 *
 * A "## " heading (h2, NOT h3) that appears BEFORE the advanced section does NOT
 * trigger 'past'. Only a "## " heading encountered WHILE in 'advanced' does.
 * ### gsd-* headings are counted: primary if 'before', advanced if 'advanced',
 * ignored if 'past'.
 */
function parseAgentsMd(raw) {
  const lines = raw.split('\n');
  const ADVANCED_SECTION = /^##\s+Advanced and Specialized Agents\s*$/;
  // Matches an h2 heading (exactly two hashes, not three or more)
  const H2 = /^##(?!#)\s+\S/;
  const GSD_H3 = /^###\s+(gsd-[\w-]+)\s*$/;

  const primaryHeadings = [];
  const advancedHeadings = [];
  // 'before' | 'advanced' | 'past'
  let state = 'before';

  for (const line of lines) {
    if (ADVANCED_SECTION.test(line)) {
      state = 'advanced';
      continue;
    }
    // Any other h2 heading while in 'advanced' terminates the advanced region
    if (state === 'advanced' && H2.test(line)) {
      state = 'past';
      continue;
    }
    const m = GSD_H3.exec(line);
    if (m) {
      if (state === 'before') {
        primaryHeadings.push(m[1]);
      } else if (state === 'advanced') {
        advancedHeadings.push(m[1]);
      }
      // state === 'past': silently ignored
    }
  }

  return { primaryHeadings, advancedHeadings };
}

/**
 * Parse INVENTORY.md agent table.
 * Returns a Map<agentSlug, primaryDocValue> e.g. "primary" | "advanced stub" | "inventory only"
 *
 * Scoping: only rows that fall between the "## Agents" heading and the NEXT
 * "## " heading are considered. This prevents a future non-agent table that
 * happens to contain a "| gsd-..." row from polluting the result.
 *
 * Column resolution: the header row "| Agent | ... | Primary doc |" is parsed
 * to find the 0-based index of the "Primary doc" column. Rows are split on "|"
 * and only the leading/trailing empty edge cells are dropped (slice(1,-1)) so
 * that empty middle cells do NOT shift column positions.
 */
function parseInventoryMd(raw) {
  const lines = raw.split('\n');
  // Matches any h2 heading (exactly two hashes, not three or more)
  const H2 = /^##(?!#)\s+\S/;
  // Matches the Agents section heading (e.g. "## Agents (33 shipped)")
  const AGENTS_SECTION = /^##\s+Agents\b/;

  const result = new Map();
  let inAgentsSection = false;
  let primaryDocColIndex = -1; // column index within the trimmed, edge-stripped cell array

  for (const line of lines) {
    if (AGENTS_SECTION.test(line)) {
      inAgentsSection = true;
      primaryDocColIndex = -1; // reset in case file is re-parsed
      continue;
    }
    // Any subsequent h2 heading ends the agents section
    if (inAgentsSection && H2.test(line)) {
      break;
    }
    if (!inAgentsSection) continue;

    // Every table row starts and ends with "|"
    if (!line.startsWith('|')) continue;

    // Split on "|", drop the leading and trailing empty strings that result
    // from the leading/trailing "|", but preserve empty middle cells so column
    // indices stay stable.
    const rawCells = line.split('|');
    // rawCells[0] is '' (before the first |), rawCells[last] is '' (after last |)
    const cells = rawCells.slice(1, -1).map((c) => c.trim());

    // Detect the header row by looking for an "Agent" cell followed by a "Primary doc" cell
    if (primaryDocColIndex === -1) {
      const pdIdx = cells.findIndex((c) => c === 'Primary doc');
      if (pdIdx !== -1 && cells[0] === 'Agent') {
        primaryDocColIndex = pdIdx;
      }
      continue; // header row (or rows before the header is found) — not a data row
    }

    // Skip separator rows (---|---|...)
    if (cells.every((c) => /^[-: ]+$/.test(c))) continue;

    // Data rows: first cell must be a gsd-* slug
    if (!cells[0].startsWith('gsd-')) continue;
    if (cells.length <= primaryDocColIndex) continue;

    const agentSlug = cells[0];
    const primaryDoc = cells[primaryDocColIndex];
    result.set(agentSlug, primaryDoc);
  }

  assert.ok(
    primaryDocColIndex !== -1,
    'INVENTORY.md: "Primary doc" column header not found in the Agents table — check the ## Agents section heading and table header row',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Load and parse
// ---------------------------------------------------------------------------

const rawAgentsMd = fs.readFileSync(AGENTS_MD, 'utf8');
const rawInventoryMd = fs.readFileSync(INVENTORY_MD, 'utf8');

const { primaryHeadings, advancedHeadings } = parseAgentsMd(rawAgentsMd);
const inventoryMap = parseInventoryMd(rawInventoryMd);
// Canonical source roster (sorted gsd-* basenames without .md) — shared helper.
const agentFiles = listAgentFiles(AGENTS_DIR);

// ---------------------------------------------------------------------------
// Robustness guards — must pass before any assertion block runs
// ---------------------------------------------------------------------------

assert.ok(
  primaryHeadings.length > 0,
  'AGENTS.md: no ### gsd-* headings found before Advanced section — raw head:\n' + rawAgentsMd.slice(0, 300),
);

assert.ok(
  advancedHeadings.length > 0,
  'AGENTS.md: no ### gsd-* headings found inside Advanced section — raw head:\n' + rawAgentsMd.slice(0, 300),
);

assert.ok(
  inventoryMap.size > 0,
  'INVENTORY.md: no | gsd-* | rows parsed — raw head:\n' + rawInventoryMd.slice(0, 300),
);

assert.ok(
  agentFiles.length > 0,
  'agents/: no gsd-*.md files found — check AGENTS_DIR path: ' + AGENTS_DIR,
);

// ---------------------------------------------------------------------------
// Derived sets
// ---------------------------------------------------------------------------

const primarySet = new Set(primaryHeadings);
const advancedSet = new Set(advancedHeadings);
const agentFileSet = new Set(agentFiles);

// Agents that exist on disk but have no heading in AGENTS.md
const inventoryOnly = agentFiles.filter(
  (a) => !primarySet.has(a) && !advancedSet.has(a),
);
const inventoryOnlySet = new Set(inventoryOnly);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-classification-parity: AGENTS.md section structure is the single source of truth', () => {

  /**
   * Test 1 — INVENTORY.md "Primary doc" column matches AGENTS.md-derived class.
   * For every agent, the column value must equal:
   *   "primary"       if the agent's ### heading is before ## Advanced and Specialized Agents
   *   "advanced stub" if the agent's ### heading is inside/after that section
   *   "inventory only" if the agent has no ### heading in AGENTS.md
   */
  test('INVENTORY.md "Primary doc" values match AGENTS.md section placement', () => {
    const mismatches = [];

    for (const [slug, inventoryValue] of inventoryMap) {
      let expected;
      if (primarySet.has(slug)) {
        expected = 'primary';
      } else if (advancedSet.has(slug)) {
        expected = 'advanced stub';
      } else if (inventoryOnlySet.has(slug)) {
        expected = 'inventory only';
      } else {
        // Row in INVENTORY.md for an agent with no file — handled in test 3
        continue;
      }

      if (inventoryValue !== expected) {
        mismatches.push(`  ${slug}: INVENTORY.md="${inventoryValue}" but AGENTS.md section says "${expected}"`);
      }
    }

    assert.strictEqual(
      mismatches.length,
      0,
      'INVENTORY.md "Primary doc" column disagrees with AGENTS.md section placement:\n' + mismatches.join('\n'),
    );
  });

  /**
   * Test 2 — AGENTS.md prose counts and parenthetical list are accurate.
   *
   * Checks three sub-facts from line ~13:
   *   a) "21 primary agents" → count of primary headings
   *   b) "Twelve additional" → count of advanced headings
   *   c) The parenthetical slug list → equals the set of advanced heading names
   *      (slugs without the "gsd-" prefix, as the prose uses)
   */
  test('AGENTS.md prose counts and advanced-agent parenthetical list are accurate', () => {

    // --- (a) prose primary count ---
    const primaryCountMatch = rawAgentsMd.match(/\*\*(\d+)\s+primary\s+agents?\*\*/);
    assert.ok(
      primaryCountMatch,
      'AGENTS.md: could not find "**N primary agents**" in prose — raw head:\n' + rawAgentsMd.slice(0, 500),
    );
    const prosePrimaryCount = parseInt(primaryCountMatch[1], 10);
    assert.strictEqual(
      prosePrimaryCount,
      primaryHeadings.length,
      `AGENTS.md prose says "${prosePrimaryCount} primary agents" but there are ${primaryHeadings.length} ### gsd-* headings before the Advanced section`,
    );

    // --- (b) prose advanced count (cardinal word or digit) ---
    // Look for "Twelve additional" or "12 additional" (case-insensitive cardinal)
    const CARDINALS = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    };
    const advancedCountMatch = rawAgentsMd.match(
      /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen))\s+additional\s+shipped\s+agents?\b/i,
    );
    assert.ok(
      advancedCountMatch,
      'AGENTS.md: could not find "N additional shipped agents" in prose — raw head:\n' + rawAgentsMd.slice(0, 500),
    );
    const advancedCountRaw = advancedCountMatch[1].toLowerCase();
    const proseAdvancedCount = CARDINALS[advancedCountRaw] !== undefined
      ? CARDINALS[advancedCountRaw]
      : parseInt(advancedCountRaw, 10);
    assert.strictEqual(
      proseAdvancedCount,
      advancedHeadings.length,
      `AGENTS.md prose says "${advancedCountRaw} additional shipped agents" but there are ${advancedHeadings.length} ### gsd-* headings in the Advanced section`,
    );

    // --- (c) parenthetical slug list ---
    // The prose lists short slugs without "gsd-" prefix, e.g.:
    //   (pattern-mapper, debug-session-manager, ...)
    const parenMatch = rawAgentsMd.match(/\(([^)]+)\)\s+have concise stubs/);
    assert.ok(
      parenMatch,
      'AGENTS.md: could not find parenthetical advanced-agent list "(slug, slug, ...) have concise stubs" — raw head:\n' + rawAgentsMd.slice(0, 500),
    );
    const proseSlugs = parenMatch[1].split(',').map((s) => s.trim().toLowerCase());
    const proseSlugsSet = new Set(proseSlugs);

    // Derive expected slugs from AGENTS.md headings (strip "gsd-" prefix)
    const expectedSlugs = new Set(advancedHeadings.map((h) => h.replace(/^gsd-/, '')));

    const missingFromProse = [...expectedSlugs].filter((s) => !proseSlugsSet.has(s));
    const extraInProse = [...proseSlugsSet].filter((s) => !expectedSlugs.has(s));

    assert.deepStrictEqual(
      { missingFromProse, extraInProse },
      { missingFromProse: [], extraInProse: [] },
      'AGENTS.md parenthetical slug list disagrees with ### headings in the Advanced section.\n' +
        `  Missing from prose: ${JSON.stringify(missingFromProse)}\n` +
        `  Extra in prose:     ${JSON.stringify(extraInProse)}`,
    );
  });

  /**
   * Test 3 — Roster completeness.
   *
   * Sub-checks:
   *   a) Every agents/gsd-*.md appears exactly once in (primary ∪ advanced ∪ inventoryOnly)
   *      — i.e. no agent is double-classified.
   *   b) INVENTORY.md has a row for every agent file.
   *   c) INVENTORY.md has no row for a non-existent agent file.
   *   d) primary.length + advanced.length + inventoryOnly.length === total agent file count
   */
  test('Roster completeness: every agent file is classified exactly once', () => {

    // (a) no agent appears in more than one classification bucket
    const overlap = primaryHeadings.filter((a) => advancedSet.has(a));
    assert.deepStrictEqual(
      overlap,
      [],
      'Agents appear in BOTH primary and advanced heading sections: ' + JSON.stringify(overlap),
    );

    // (b) INVENTORY.md has a row for every agent file
    const missingFromInventory = agentFiles.filter((a) => !inventoryMap.has(a));
    assert.deepStrictEqual(
      missingFromInventory,
      [],
      'agents/gsd-*.md files missing from INVENTORY.md: ' + JSON.stringify(missingFromInventory),
    );

    // (c) INVENTORY.md has no row for a non-existent agent file
    const phantomRows = [...inventoryMap.keys()].filter((slug) => !agentFileSet.has(slug));
    assert.deepStrictEqual(
      phantomRows,
      [],
      'INVENTORY.md rows reference agents that have no agents/gsd-*.md file: ' + JSON.stringify(phantomRows),
    );

    // (d) counts add up
    const total = primaryHeadings.length + advancedHeadings.length + inventoryOnly.length;
    assert.strictEqual(
      total,
      agentFiles.length,
      `primary(${primaryHeadings.length}) + advanced(${advancedHeadings.length}) + inventoryOnly(${inventoryOnly.length}) = ${total} ≠ ${agentFiles.length} agent files`,
    );
  });

  /**
   * Test 4 — AGENTS.md **Tools** rows match agent frontmatter verbatim (#2526).
   *
   * Same defect class as #2526 itself, one layer out: there, an agent's body
   * documented a capability its `tools:` allowlist withheld; here, the role
   * card documents a tool set its frontmatter disagrees with. When the review
   * that found it was written, 26 of 34 rows had drifted: 22 omitted `Skill`
   * and 7 omitted `Edit`; 8 omitted MCP grants entirely (7 of them writing
   * "mcp (context7)" for what was up to eight distinct servers, and
   * gsd-executor naming none at all); and one still read `Task`, a tool that
   * no longer exists. Nothing asserted the two agreed, so the drift was free.
   *
   * The row must equal the frontmatter value verbatim rather than as a set:
   * a set comparison would accept the "mcp (context7)" shorthand class of
   * under-documentation this test exists to stop, and an exact string is what
   * makes the check cheap to satisfy — copy the line.
   *
   * The row-count assertion is the discovery guard (mirroring #2526's own):
   * without it, deleting a **Tools** row would silently retire its assertion
   * while the remaining rows kept the test green.
   */
  test('AGENTS.md **Tools** rows match each agent\'s tools: frontmatter (#2526)', () => {
    const { parseFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const TOOLS_ROW = /^\|\s*\*\*Tools\*\*\s*\|\s*(.*?)\s*\|\s*$/;
    const H3 = /^###\s+(gsd-[\w-]+)\s*$/;

    // /\r?\n/, not '\n': Windows autocrlf yields CRLF, and a trailing \r would
    // survive into the row's last cell and fail every comparison (local/no-crlf-fragile-split).
    const lines = rawAgentsMd.split(/\r?\n/);
    const sections = [];
    lines.forEach((line, i) => {
      const m = H3.exec(line);
      if (m) sections.push({ slug: m[1], start: i });
    });
    sections.forEach((s, i) => {
      s.end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
    });

    const mismatches = [];
    const missingRow = [];

    for (const section of sections) {
      const agentPath = path.join(AGENTS_DIR, `${section.slug}.md`);
      if (!fs.existsSync(agentPath)) continue; // phantom headings are test 3's job

      const fm = parseFrontmatter(fs.readFileSync(agentPath, 'utf8')) || {};
      // No `tools:` key at all means "inherits everything" — there is no
      // declared set for the row to agree with, so nothing to assert.
      if (fm.tools === undefined || fm.tools === null) continue;
      const declared = Array.isArray(fm.tools) ? fm.tools.join(', ') : String(fm.tools);

      let row = null;
      for (let i = section.start; i < section.end; i += 1) {
        const m = TOOLS_ROW.exec(lines[i]);
        if (m) { row = { value: m[1], line: i + 1 }; break; }
      }

      if (row === null) { missingRow.push(section.slug); continue; }
      if (row.value !== declared) {
        mismatches.push(
          `  ${section.slug} (docs/AGENTS.md:${row.line})\n` +
          `    doc:         ${row.value}\n` +
          `    frontmatter: ${declared}`,
        );
      }
    }

    assert.deepStrictEqual(
      missingRow,
      [],
      'AGENTS.md sections with a granted tools: frontmatter but no "| **Tools** |" row — ' +
      'the row cannot be allowed to vanish, or its parity assertion vanishes with it: ' +
      JSON.stringify(missingRow),
    );

    assert.strictEqual(
      mismatches.length,
      0,
      'docs/AGENTS.md **Tools** rows disagree with the agents\' tools: frontmatter.\n' +
      'The role card documents a tool set the agent does not have (or omits one it does) — ' +
      'the #2526 drift class at the doc layer. Copy the frontmatter value verbatim:\n' +
      mismatches.join('\n'),
    );
  });

});
