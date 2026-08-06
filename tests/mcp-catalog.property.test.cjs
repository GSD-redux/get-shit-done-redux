'use strict';

/**
 * Failing-first property-based tests for src/mcp-catalog.cts (compiled to
 * gsd-core/bin/lib/mcp-catalog.cjs) — issue #3072 (epic #1671 Phase B),
 * `.gsd/phase/feat-3072-mcp-served-catalog/40-design.md`.
 *
 * Covers 50-test-matrix.md rows 53-55:
 *   (a) every indexed uri round-trips through readResource
 *   (b) no generated traversal-shaped string ever resolves to a read
 *   (c) pagination partitions the resource list for any page size
 *
 * Uses the shared `fast-check` global config (`tests/helpers/
 * fast-check-setup.cjs`: numRuns 200, seed 42, overridable via
 * `GSD_FC_SEED`) — same pattern as `tests/adr-parser.property.test.cjs`.
 * Fixtures are built over the SAME injected `readFile`/`readDir` seam used
 * throughout `tests/mcp-catalog.test.cjs` — never real filesystem
 * permission tricks.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { buildCatalog, readResource, listResources, getPrompt } = require('../gsd-core/bin/lib/mcp-catalog.cjs');

// ─── shared fixture: a small, fixed catalog over injected seams ────────────

function dirEntry(name, isDir) {
  return { name, isDirectory: () => isDir };
}

function makeFakeFs(root, files) {
  const abs = (rel) => (rel ? `${root}/${rel}` : root);
  const fileMap = new Map(Object.entries(files).map(([rel, content]) => [abs(rel), content]));
  const dirMap = new Map();
  for (const rel of Object.keys(files)) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dirRel = parts.slice(0, i).join('/');
      const dirAbs = abs(dirRel);
      const isLast = i === parts.length - 1;
      if (!dirMap.has(dirAbs)) dirMap.set(dirAbs, new Map());
      dirMap.get(dirAbs).set(parts[i], dirEntry(parts[i], !isLast));
    }
  }
  // Production (`buildCatalog`) resolves paths via `path.join`, which is
  // backslash-separated on Windows; this fake's maps are keyed POSIX. A real
  // `fs` accepts both separators, so the fake must too — normalize the
  // incoming lookup key unconditionally (never process.platform-gated).
  // Caught by CI on windows-latest: every lookup missed, the fake indexed
  // zero entries, and the anti-vacuity guards correctly flagged it.
  const norm = (p) => String(p).replace(/\\/g, '/');
  const readDir = (absPath) => {
    const m = dirMap.get(norm(absPath));
    if (!m) throw new Error(`ENOENT (fake fs): ${absPath}`);
    return [...m.values()];
  };
  const readFile = (absPath) => {
    const key = norm(absPath);
    if (!fileMap.has(key)) throw new Error(`ENOENT (fake fs): ${absPath}`);
    return fileMap.get(key);
  };
  return { root, readFile, readDir };
}

const FIXTURE_RESOURCE_COUNT = 9;
const FIXTURE_PROMPT_COUNT = 4;

function buildFixtureCatalog() {
  const files = {};
  for (let i = 0; i < FIXTURE_RESOURCE_COUNT; i++) {
    const segment = i % 2 === 0 ? 'workflows' : 'references';
    files[`gsd-core/${segment}/entry-${i}.md`] = `# entry ${i}\n\nbody text for entry ${i}\n`;
  }
  for (let i = 0; i < FIXTURE_PROMPT_COUNT; i++) {
    files[`commands/gsd/cmd-${i}.md`] = `# cmd ${i}\n\nprompt body ${i}\n`;
  }
  const fake = makeFakeFs('/fake-root-property', files);
  return buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
}

// ─── row 53: every indexed uri round-trips ──────────────────────────────────

describe('property: every indexed uri round-trips (row 53)', () => {
  test('readResource succeeds and returns the same uri for every indexed resource', () => {
    const catalog = buildFixtureCatalog();
    const uris = [...catalog.resources.keys()];
    assert.ok(uris.length > 0, 'fixture catalog must actually index resources for this property to mean anything');

    fc.assert(
      fc.property(fc.constantFrom(...uris), (uri) => {
        const result = readResource(catalog, uri);
        assert.equal(result.uri, uri);
        assert.equal(typeof result.text, 'string');
      })
    );
  });

  test('getPrompt succeeds and returns the same name for every indexed prompt', () => {
    const catalog = buildFixtureCatalog();
    const names = [...catalog.prompts.keys()];
    assert.ok(names.length > 0, 'fixture catalog must actually index prompts for this property to mean anything');

    fc.assert(
      fc.property(fc.constantFrom(...names), (name) => {
        const result = getPrompt(catalog, name);
        assert.equal(typeof result.description, 'string');
        assert.ok(Array.isArray(result.messages) && result.messages.length >= 1);
      })
    );
  });
});

// ─── row 54: no generated traversal string ever resolves ───────────────────

describe('property: generated traversal strings never resolve (row 54)', () => {
  test('readResource always refuses arbitrary traversal-shaped uris', () => {
    const catalog = buildFixtureCatalog();

    const traversalSegment = fc.constantFrom('..', '..%2f', '%2e%2e', '..\\', '%252e%252e%252f');
    const rootSegment = fc.constantFrom('workflows', 'references');
    const suffix = fc.stringMatching(/^[a-z0-9-]{0,12}$/);

    const traversalUri = fc
      .tuple(rootSegment, fc.array(traversalSegment, { minLength: 1, maxLength: 6 }), suffix)
      .map(([root, segments, tail]) => `gsd://${root}/${segments.join('/')}${tail}.md`);

    fc.assert(
      fc.property(traversalUri, (uri) => {
        assert.throws(
          () => readResource(catalog, uri),
          undefined,
          `a traversal-shaped uri must never resolve to a successful read: ${uri}`
        );
      })
    );
  });

  test('readResource always refuses arbitrary absolute-path-shaped uris', () => {
    const catalog = buildFixtureCatalog();

    const absolutePath = fc.oneof(
      fc.stringMatching(/^\/[a-z0-9/_-]{1,40}$/),
      fc.stringMatching(/^[A-Z]:\\[A-Za-z0-9\\_-]{1,40}$/)
    );

    fc.assert(
      fc.property(absolutePath, (p) => {
        assert.throws(() => readResource(catalog, p), undefined, `an absolute-path-shaped uri must never resolve to a successful read: ${p}`);
      })
    );
  });
});

// ─── row 55: pagination is a partition ──────────────────────────────────────

describe('property: pagination partitions the list for any page size (row 55)', () => {
  test('pages concatenate to the full list with no dupes and no gaps, for any page size >= 1', () => {
    const catalog = buildFixtureCatalog();
    const full = listResources(catalog, { pageSize: 10_000 }).resources.map((r) => r.uri);
    assert.ok(full.length > 0);

    fc.assert(
      fc.property(fc.integer({ min: 1, max: full.length + 3 }), (pageSize) => {
        const collected = [];
        let cursor;
        for (let guard = 0; guard < full.length + 5; guard++) {
          const page = listResources(catalog, { pageSize, cursor });
          assert.ok(page.resources.length <= pageSize, `a page must never exceed the requested pageSize ${pageSize}`);
          collected.push(...page.resources.map((r) => r.uri));
          if (page.nextCursor === undefined) break;
          cursor = page.nextCursor;
        }
        assert.deepEqual(collected, full, `pages for pageSize=${pageSize} must reassemble the full list with no dupes/gaps`);
      })
    );
  });
});
