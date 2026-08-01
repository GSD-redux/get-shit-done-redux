'use strict';

// Regression guard for #2943 — the context7 MCP server registers exactly two
// tools (`resolve-library-id` and `query-docs`); it does NOT register
// `get-library-docs`. That stale name survived in shipped prose (copied from
// upstream's own stale README), so agents were instructed to call a tool the
// server does not register — they errored, fell through to the ctx7 CLI
// fallback, or fabricated a result.
//
// This is the SECOND context7 naming drift after #2017 (which guarded the
// plugin-marketplace PREFIX). #2017's guard (context7-plugin-grant-parity) only
// checks `tools:` frontmatter lines; it does not scan prose bodies, which is
// where the broken tool NAME lived. This guard scans the shipped prose surface
// and fails if any artifact tells an agent to call the nonexistent tool.
//
// Allowed (registered upstream): mcp__context7__resolve-library-id,
// mcp__context7__query-docs, and the mcp__context7__* / plugin-marketplace
// grants. Banned: mcp__context7__get-library-docs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Shipped prose directories an agent can be instructed by. Tests/, CHANGELOG,
// RELEASE-NOTES-LEGACY (historical record), and node_modules are deliberately
// excluded — a test fixture may use the banned name as a negative input, and
// history must not be rewritten.
const SCAN_DIRS = [
  'agents',
  'gsd-core/references',
  'gsd-core/workflows',
  'commands/gsd',
  'skills',
  'docs',
];

// Files that are historical record (must not be rewritten to satisfy this
// guard) or generated changelog. RELEASE-NOTES-LEGACY.md carries the old #13898
// attribution as shipped history; it is out of scope.
const EXCLUDED_FILES = new Set([
  path.join(REPO_ROOT, 'docs', 'RELEASE-NOTES-LEGACY.md'),
  path.join(REPO_ROOT, 'CHANGELOG.md'),
]);

const BANNED = 'mcp__context7__get-library-docs';

function listMarkdown(dir) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('#2943 — no shipped artifact references the nonexistent get-library-docs tool', () => {
  const files = SCAN_DIRS.flatMap(listMarkdown)
    .filter((f) => !EXCLUDED_FILES.has(f));
  assert.ok(files.length > 50, `scan surface sanity check (found ${files.length} markdown files)`);

  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(BANNED)) {
      // Report every offending line for actionable failures.
      const rel = path.relative(REPO_ROOT, file);
      for (const [i, line] of content.split(/\r?\n/).entries()) {
        if (line.includes(BANNED)) offenders.push(`${rel}:${i + 1}`);
      }
    }
  }

  test(`no shipped prose references ${BANNED}`, () => {
    assert.deepEqual(offenders, [],
      `Shipped artifacts must not instruct agents to call ${BANNED} — the ` +
      `context7 MCP server does not register it (only resolve-library-id and ` +
      `query-docs exist). Offending sites:\n${offenders.join('\n')}`);
  });

  test('the canonical reference names the registered query-docs tool', () => {
    const ref = path.join(REPO_ROOT, 'gsd-core', 'references', 'research-documentation-lookup.md');
    const content = fs.readFileSync(ref, 'utf8');
    assert.ok(content.includes('mcp__context7__query-docs'),
      'research-documentation-lookup.md must name mcp__context7__query-docs');
    // The canonical param names (upstream query-docs: libraryId + query). The
    // alias context7CompatibleLibraryID is tolerated upstream but the canonical
    // spelling removes the drift source.
    assert.ok(/query-docs` with `libraryId`/.test(content) || /libraryId` and `query`/.test(content),
      'query-docs must be documented with the libraryId / query params');
  });

  test('resolve-library-id tool name is preserved (still registered upstream)', () => {
    // Negative-space guard: this fix renames get-library-docs only.
    // resolve-library-id is a different, still-valid tool and must survive.
    let any = false;
    for (const file of files) {
      if (fs.readFileSync(file, 'utf8').includes('mcp__context7__resolve-library-id')) {
        any = true;
        break;
      }
    }
    assert.ok(any, 'mcp__context7__resolve-library-id must still appear in shipped artifacts');
  });
});
