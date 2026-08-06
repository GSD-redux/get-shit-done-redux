'use strict';

/**
 * Failing-first unit tests for src/mcp-catalog.cts (compiled to
 * gsd-core/bin/lib/mcp-catalog.cjs) — issue #3072 (epic #1671 Phase B),
 * `.gsd/phase/feat-3072-mcp-served-catalog/40-design.md`.
 *
 * Covers 50-test-matrix.md rows 4-30 and 37-47: the catalog module's own
 * surface (buildCatalog / readResource / listResources / getPrompt /
 * shouldCompose) exercised over INJECTED `readFile`/`readDir` seams, never
 * real filesystem permission tricks (`chmod 0o000` is forbidden — root
 * bypasses mode bits and the test would silently pass with zero coverage in
 * CI; CONTRIBUTING.md, `40-design.md` "Known-defect gauntlet").
 *
 * `listResources` is a delegation surface this suite requires beyond the
 * design's four headline exports (`buildCatalog`, `readResource`,
 * `getPrompt`, `shouldCompose`) — see the module doc comment in
 * `src/mcp-catalog.cts` for why: pagination over the resource index is
 * catalog-module responsibility so `handleMessage` stays thin (design
 * "Shape" section).
 *
 * The module is a SKELETON right now — every function throws
 * `'not implemented'` — so every test below fails on BEHAVIOR, not on
 * `MODULE_NOT_FOUND`. No source-grep (CONTRIBUTING.md): every assertion is
 * on typed values (`REASON` codes, structured Map/array shapes) — never on
 * rendered text via `.includes()`/`.match()`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  buildCatalog,
  readResource,
  listResources,
  shouldCompose,
  REASON,
} = require('../gsd-core/bin/lib/mcp-catalog.cjs');
const { composeWorkflow } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

// ─── Fixture helpers ────────────────────────────────────────────────────────

/** Build a `gsd://<segment>/<relPath>` resource uri, matching the design's `gsd://workflows/...` hostile-input examples. */
function resourceUri(segment, relPath) {
  return `gsd://${segment}/${relPath}`;
}

function dirEntry(name, isDir) {
  return { name, isDirectory: () => isDir };
}

/**
 * Build an injected `readFile`/`readDir` seam pair over an in-memory file
 * map (POSIX relative paths -> content), so IO faults are testable by
 * monkeypatching the returned functions directly — never `chmod 0o000`.
 *
 * @param {string} root - a POSIX-style fake root path, never touched on real disk
 * @param {Record<string, string>} files - relative-path -> file content
 */
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
    if (!m) {
      const err = new Error(`ENOENT (fake fs): ${absPath}`);
      throw err;
    }
    return [...m.values()];
  };
  const readFile = (absPath) => {
    const key = norm(absPath);
    if (!fileMap.has(key)) {
      const err = new Error(`ENOENT (fake fs): ${absPath}`);
      throw err;
    }
    return fileMap.get(key);
  };
  return { root, readFile, readDir };
}

/** Save/restore `process.cwd` around `fn`. Standalone helper — try/finally is permitted here (CONTRIBUTING.md "Setup and Cleanup"). */
function withMockedCwd(fakeCwd, fn) {
  const original = process.cwd;
  process.cwd = () => fakeCwd;
  try {
    return fn();
  } finally {
    process.cwd = original;
  }
}

/**
 * Attempt to build a root containing a symlink that escapes it. Standalone
 * helper — try/catch for environment-capability probing (not cleanup
 * masking) lives here, out of the test body.
 */
function setupSymlinkEscapeFixture() {
  const fs = require('node:fs');
  const path = require('node:path');
  try {
    const root = createTempDir('mcp-catalog-symlink-root-');
    const outsideTarget = createTempDir('mcp-catalog-symlink-outside-');
    fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(outsideTarget, 'secret.md'), 'top secret');
    fs.symlinkSync(path.join(outsideTarget, 'secret.md'), path.join(root, 'gsd-core', 'workflows', 'evil.md'));
    return { ok: true, root, outsideTarget };
  } catch {
    return { ok: false };
  }
}

// A small marked workflow + a small marked-syntax-documenting reference,
// reused by several rows below.
const markedWorkflow = [
  'before prose',
  '<!-- gsd:section id="sec-a" when="always" -->',
  'body line',
  '<!-- /gsd:section -->',
  'after prose',
].join('\n');

const unmarkedContent = ['# Plain document', '', 'Ordinary prose, no markers here.', ''].join('\n');

// A reference doc that DOCUMENTS marker syntax with an unfenced example —
// the exact F1 defect class (design "F1" / row 13).
const documentsMarkerSyntax = [
  '# How markers work',
  '',
  'A section marker pair looks like this:',
  '',
  '<!-- gsd:section id="example" when="always" -->',
  'example body',
  '<!-- /gsd:section -->',
  '',
  'That is the whole grammar.',
  '',
].join('\n');

// ─── resources/list (rows 4-10) ─────────────────────────────────────────────

describe('resources/list — catalog module', () => {
  test('lists every catalog resource with required fields (row 4)', () => {
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/a.md': unmarkedContent,
      'gsd-core/references/b.md': unmarkedContent,
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    assert.equal(catalog.resources.size, 2);
    for (const entry of catalog.resources.values()) {
      assert.equal(typeof entry.uri, 'string');
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.title, 'string');
      assert.equal(typeof entry.description, 'string');
      assert.equal(typeof entry.mimeType, 'string');
      assert.ok(entry.mimeType.length > 0);
    }
  });

  test('listing order is deterministic across calls (row 5)', () => {
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/z.md': unmarkedContent,
      'gsd-core/workflows/a.md': unmarkedContent,
      'gsd-core/references/m.md': unmarkedContent,
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const first = listResources(catalog).resources.map((r) => r.uri);
    const second = listResources(catalog).resources.map((r) => r.uri);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort(), 'order must be sorted by uri, not readdir order');
  });

  test('pagination at page-1 / page / page+1 (row 6)', () => {
    const makeCatalogOfSize = (n) => {
      const files = {};
      for (let i = 0; i < n; i++) files[`gsd-core/workflows/w${i}.md`] = unmarkedContent;
      const fake = makeFakeFs('/fake-root', files);
      return buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    };

    const pageSize = 2;

    const below = listResources(makeCatalogOfSize(pageSize - 1), { pageSize });
    assert.equal(below.resources.length, pageSize - 1);
    assert.equal(below.nextCursor, undefined, 'a page under the page size is already the last page');

    const exact = listResources(makeCatalogOfSize(pageSize), { pageSize });
    assert.equal(exact.resources.length, pageSize);
    assert.equal(exact.nextCursor, undefined, 'a full final page omits nextCursor');

    const over = listResources(makeCatalogOfSize(pageSize + 1), { pageSize });
    assert.equal(over.resources.length, pageSize);
    assert.notEqual(over.nextCursor, undefined, 'a page short of the total must carry nextCursor');
  });

  test('paginated pages reassemble the full list (row 7)', () => {
    const files = {};
    for (let i = 0; i < 7; i++) files[`gsd-core/workflows/w${i}.md`] = unmarkedContent;
    const fake = makeFakeFs('/fake-root', files);
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });

    const full = listResources(catalog, { pageSize: 100 }).resources.map((r) => r.uri);

    const collected = [];
    let cursor;
    for (let guard = 0; guard < 20; guard++) {
      const page = listResources(catalog, { pageSize: 3, cursor });
      collected.push(...page.resources.map((r) => r.uri));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    assert.deepEqual(collected, full, 'concatenated pages must equal the unpaginated list exactly once, no dupes, no gaps');
  });

  test('unknown cursor errors rather than restarting (row 8)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/a.md': unmarkedContent });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    assert.throws(
      () => listResources(catalog, { cursor: 'not-a-real-cursor' }),
      (err) => err.reason === REASON.UNKNOWN_CURSOR
    );
  });

  test('empty catalog lists empty (row 9)', () => {
    const fake = makeFakeFs('/fake-root', {});
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const page = listResources(catalog);
    assert.deepEqual(page.resources, []);
    assert.equal(page.nextCursor, undefined);
  });

  test('single-entry catalog needs no cursor (row 10)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/only.md': unmarkedContent });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const page = listResources(catalog);
    assert.equal(page.resources.length, 1);
    assert.equal(page.nextCursor, undefined);
  });
});

// ─── resources/read (rows 11-30) ────────────────────────────────────────────

describe('resources/read — catalog module (client-controlled path surface)', () => {
  test('reads a workflow with markers stripped (row 11)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/w.md': markedWorkflow });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('workflows', 'w.md'));
    assert.equal(result.text, composeWorkflow(markedWorkflow, { sourcePath: 'gsd-core/workflows/w.md' }));
    assert.equal(result.uri, resourceUri('workflows', 'w.md'));
  });

  test('reads a reference verbatim (row 12)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/r.md': unmarkedContent });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'r.md'));
    assert.equal(result.text, unmarkedContent);
  });

  test('a doc documenting marker syntax is never composed (row 13 — the F1 defect)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/documents-markers.md': documentsMarkerSyntax });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'documents-markers.md'));
    assert.equal(result.text, documentsMarkerSyntax, 'a reference that documents marker syntax must be served byte-identical, never composed');
  });

  test('markers are stripped only under workflows/ (row 14)', () => {
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/w.md': markedWorkflow,
      'gsd-core/references/r.md': markedWorkflow,
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const workflowText = readResource(catalog, resourceUri('workflows', 'w.md')).text;
    const referenceText = readResource(catalog, resourceUri('references', 'r.md')).text;
    assert.notEqual(workflowText, markedWorkflow, 'the workflow copy must be composed (markers stripped)');
    assert.equal(referenceText, markedWorkflow, 'the identical text under references/ must be served verbatim');
  });

  test('unmarked workflow composes byte-identical (row 15)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/w.md': unmarkedContent });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('workflows', 'w.md'));
    assert.equal(result.text, unmarkedContent, 'composing an unmarked document is a structural no-op, not a budget trick');
  });

  test('unknown uri errors rather than returning empty (row 16)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/a.md': unmarkedContent });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    assert.throws(
      () => readResource(catalog, resourceUri('workflows', 'totally-made-up.md')),
      (err) => err.reason === REASON.UNKNOWN_RESOURCE
    );
  });

  const catalogForHostileUris = () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/a.md': unmarkedContent });
    return buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
  };

  test('rejects dot-dot traversal (row 17)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://workflows/../../../etc/passwd'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects backslash traversal (row 18)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://workflows/..\\..\\secrets.md'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects percent-encoded traversal (row 19)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://workflows/%2e%2e%2fsecrets.md'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects double-encoded traversal (row 20)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://workflows/%252e%252e%252fsecrets.md'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects absolute posix path (row 21)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, '/etc/passwd'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects absolute windows path (row 22)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'C:\\Windows\\win.ini'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects a file:// uri (row 23)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'file:///etc/passwd'),
      (err) => err.reason === REASON.INVALID_URI
    );
  });

  test('rejects a uri containing a null byte (row 24)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://workflows/a.md\u0000.txt'),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('rejects a symlink escaping the root (row 25)', (t) => {
    const fixture = setupSymlinkEscapeFixture();
    if (!fixture.ok) {
      t.skip('symlink creation not permitted on this platform/environment');
      return;
    }
    t.after(() => {
      cleanup(fixture.root);
      cleanup(fixture.outsideTarget);
    });

    const catalog = buildCatalog({ root: fixture.root });
    assert.throws(
      () => readResource(catalog, resourceUri('workflows', 'evil.md')),
      (err) => err.reason === REASON.TRAVERSAL_REFUSED
    );
  });

  test('an unindexed sibling is not readable (row 26)', () => {
    // "c.md" is never part of the build-time file map — it is not on the
    // catalog's disk snapshot at all, simulating a file added post-startup.
    // Index membership, not disk existence, is the sole authority.
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/a.md': unmarkedContent,
      'gsd-core/workflows/b.md': unmarkedContent,
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    assert.throws(
      () => readResource(catalog, resourceUri('workflows', 'c.md')),
      (err) => err.reason === REASON.UNKNOWN_RESOURCE
    );
  });

  test('non-indexed file types are not served (row 27)', () => {
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/a.md': unmarkedContent,
      'gsd-core/workflows/section-manifest.json': '{}',
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    assert.equal(catalog.resources.size, 1, 'the .json sibling must not be indexed');
    assert.throws(
      () => readResource(catalog, resourceUri('workflows', 'section-manifest.json')),
      (err) => err.reason === REASON.UNKNOWN_RESOURCE
    );
  });

  test('non-string uri is rejected as invalid params (row 28)', () => {
    const catalog = catalogForHostileUris();
    for (const bad of [42, {}, null, undefined, [], true]) {
      assert.throws(
        () => readResource(catalog, bad),
        (err) => err.reason === REASON.INVALID_PARAMS,
        `expected INVALID_PARAMS for uri=${JSON.stringify(bad)}`
      );
    }
  });

  test('empty uri is rejected (row 29)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, ''),
      (err) => err.reason === REASON.INVALID_URI
    );
  });

  test('unknown root segment is rejected (row 30)', () => {
    const catalog = catalogForHostileUris();
    assert.throws(
      () => readResource(catalog, 'gsd://bogus-root-segment/a.md'),
      (err) => err.reason === REASON.UNKNOWN_ROOT
    );
  });
});

// ─── content correctness / CRLF (rows 37-41) ────────────────────────────────

describe('content correctness — catalog module', () => {
  test('CRLF content survives serving (row 37)', () => {
    const content = ['line one', 'line two', 'line three', ''].join('\r\n');
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/r.md': content });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'r.md'));
    assert.equal(result.text, content);
  });

  test('mixed line endings survive serving (row 38)', () => {
    const content = 'line one\r\nline two\nline three\r\nline four\n';
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/r.md': content });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'r.md'));
    assert.equal(result.text, content);
  });

  test('missing trailing newline is preserved (row 39)', () => {
    const content = ['line one', 'line two, no trailing newline after this'].join('\n');
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/r.md': content });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'r.md'));
    assert.equal(result.text, content);
    assert.equal(result.text.endsWith('\n'), false);
  });

  test('an empty file serves as empty text (row 40)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/empty.md': '' });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'empty.md'));
    assert.equal(result.text, '');
  });

  test('unicode content is preserved (row 41)', () => {
    const content = ['# 日本語のタイトル', '', 'emoji check: 🎉🚀 café naïve', ''].join('\n');
    const fake = makeFakeFs('/fake-root', { 'gsd-core/references/r.md': content });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });
    const result = readResource(catalog, resourceUri('references', 'r.md'));
    assert.equal(result.text, content);
    assert.equal(Buffer.byteLength(result.text, 'utf8'), Buffer.byteLength(content, 'utf8'));
  });
});

// ─── IO faults, injected via the seam (rows 42-45) ──────────────────────────

describe('IO faults — injected via the seam, never chmod', () => {
  test('one unreadable file does not break the catalog (row 42)', () => {
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/good.md': unmarkedContent,
      'gsd-core/workflows/bad.md': unmarkedContent,
    });
    const badAbsPath = `${fake.root}/gsd-core/workflows/bad.md`;
    const realReadFile = fake.readFile;
    const faultyReadFile = (absPath) => {
      // Same separator-normalization as makeFakeFs: a production-supplied
      // absPath may be backslash-joined on Windows.
      if (String(absPath).replace(/\\/g, '/') === badAbsPath) throw new Error('injected read failure');
      return realReadFile(absPath);
    };

    const catalog = buildCatalog({ root: fake.root, readFile: faultyReadFile, readDir: fake.readDir });

    const goodUri = resourceUri('workflows', 'good.md');
    const badUri = resourceUri('workflows', 'bad.md');

    assert.doesNotThrow(() => readResource(catalog, goodUri), 'the healthy resource must remain readable');
    assert.throws(
      () => readResource(catalog, badUri),
      (err) => err.reason === REASON.READ_FAILED
    );

    const listedUris = listResources(catalog).resources.map((r) => r.uri);
    assert.ok(listedUris.includes(goodUri));
    assert.ok(listedUris.includes(badUri), 'the failing resource must stay listable even though it cannot be read');
  });

  test('a directory read failure fails closed (row 43)', () => {
    const fake = makeFakeFs('/fake-root', { 'gsd-core/workflows/a.md': unmarkedContent });
    const workflowsDirAbs = `${fake.root}/gsd-core/workflows`;
    const realReadDir = fake.readDir;
    const faultyReadDir = (absPath) => {
      // Same separator-normalization as makeFakeFs: a production-supplied
      // absPath may be backslash-joined on Windows.
      if (String(absPath).replace(/\\/g, '/') === workflowsDirAbs) throw new Error('injected directory read failure');
      return realReadDir(absPath);
    };
    assert.throws(
      () => buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: faultyReadDir }),
      (err) => err.reason === REASON.READ_FAILED,
      'a directory listing failure must surface as a typed error, never a silently partial catalog'
    );
  });

  test('a malformed marker is contained to its file (row 44)', () => {
    const malformed = ['before', '<!-- gsd:section id="x" when="always" -->', 'never closed'].join('\n');
    const fake = makeFakeFs('/fake-root', {
      'gsd-core/workflows/good.md': unmarkedContent,
      'gsd-core/workflows/bad.md': malformed,
    });
    const catalog = buildCatalog({ root: fake.root, readFile: fake.readFile, readDir: fake.readDir });

    const goodUri = resourceUri('workflows', 'good.md');
    const badUri = resourceUri('workflows', 'bad.md');

    assert.doesNotThrow(() => readResource(catalog, goodUri));
    assert.throws(
      () => readResource(catalog, badUri),
      (err) => err.reason === REASON.READ_FAILED
    );

    const listedUris = listResources(catalog).resources.map((r) => r.uri);
    assert.ok(listedUris.includes(goodUri));
    assert.ok(listedUris.includes(badUri), 'the other 325 resources must stay listable and readable — one bad file must not take down the catalog');
  });

  test('absent root does not fall back to cwd (row 45)', () => {
    const calledPaths = [];
    const missingRoot = '/fake-root-that-does-not-exist-anywhere';
    const recordingReadDir = (absPath) => {
      calledPaths.push(absPath);
      throw new Error(`ENOENT (fake fs): ${absPath}`);
    };
    const recordingReadFile = (absPath) => {
      calledPaths.push(absPath);
      throw new Error(`ENOENT (fake fs): ${absPath}`);
    };

    let threw = false;
    let catalog;
    try {
      catalog = buildCatalog({ root: missingRoot, readFile: recordingReadFile, readDir: recordingReadDir });
    } catch (err) {
      threw = true;
      assert.equal(typeof err.reason, 'string', 'a build failure for an absent root must be a typed CatalogError, never a bare crash');
    }
    if (!threw) {
      assert.equal(catalog.resources.size, 0);
      assert.equal(catalog.prompts.size, 0);
    }

    const realCwd = process.cwd();
    for (const p of calledPaths) {
      assert.notEqual(String(p).replace(/\\/g, '/'), realCwd.replace(/\\/g, '/'), 'buildCatalog must never fall back to reading process.cwd()');
    }
  });
});

// ─── resolution / scoping (rows 46-47) ──────────────────────────────────────

describe('resolution / scoping — module location vs cwd', () => {
  test('catalog resolves from module location not cwd (row 46)', (t) => {
    const decoyCwd = createTempDir('mcp-catalog-decoy-cwd-');
    t.after(() => cleanup(decoyCwd));

    const catalog = withMockedCwd(decoyCwd, () => buildCatalog({}));
    assert.ok(
      catalog.resources.size > 50,
      `expected the real package's ~110 workflows + ~103 references regardless of a decoy cwd, got ${catalog.resources.size}`
    );
  });

  test('a project-local gsd-core is never a catalog root (row 47)', (t) => {
    const decoyCwd = createTempDir('mcp-catalog-decoy-project-');
    t.after(() => cleanup(decoyCwd));

    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(path.join(decoyCwd, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(decoyCwd, 'gsd-core', 'workflows', 'trap.md'), 'decoy content that must never be served');

    const catalog = withMockedCwd(decoyCwd, () => buildCatalog({}));

    const uris = [...catalog.resources.keys()];
    assert.equal(
      uris.includes(resourceUri('workflows', 'trap.md')),
      false,
      "a project-local gsd-core/ present at ctx.cwd's decoy location must never become a catalog root"
    );
  });
});

// ─── shouldCompose — the F1 predicate (exercised directly, supplements rows 12-15) ──

describe('shouldCompose — the shared F1 predicate', () => {
  test('shouldCompose is true only for paths under gsd-core/workflows/', () => {
    assert.equal(shouldCompose('gsd-core/workflows/plan-phase.md'), true);
    assert.equal(shouldCompose('gsd-core/references/foo.md'), false);
    assert.equal(shouldCompose('commands/gsd/plan-phase.md'), false);
  });
});
