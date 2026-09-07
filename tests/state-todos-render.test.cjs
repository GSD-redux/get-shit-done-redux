'use strict';

// #2618: deterministic renderer for STATE.md's "### Pending Todos" section
// body. See .gsd/phase/feat-2618-compact-todo-pointers/40-design.md and
// 50-test-matrix.md for the full rationale and case list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const initLib = require('../gsd-core/bin/lib/init.cjs');
const { renderPendingTodosMarkdown } = initLib;
const { cleanup } = require('./helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const MAX = 240;

function makeTodo(overrides) {
  return Object.assign(
    {
      created: '2026-09-01',
      area: 'api',
      title: 'Fix retry logic',
      path: '.planning/todos/pending/2026-09-01-fix-retry-logic.md',
    },
    overrides,
  );
}

test('renderPendingTodosMarkdown: zero todos renders exactly "None yet."', () => {
  assert.equal(renderPendingTodosMarkdown([]), 'None yet.');
});

test('renderPendingTodosMarkdown: one todo without a needs clause', () => {
  const body = renderPendingTodosMarkdown([makeTodo()]);
  const lines = body.split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- \[2026-09-01\] \[api\] Fix retry logic — \[todo file\]\(.+\)$/);
  assert.doesNotMatch(lines[0], /Needs/);
});

test('renderPendingTodosMarkdown: "TBD" solution omits the needs clause', () => {
  const body = renderPendingTodosMarkdown([makeTodo({ needs: undefined })]);
  assert.doesNotMatch(body, /Needs/);
});

test('renderPendingTodosMarkdown: real solution text becomes a "Needs ..." clause', () => {
  const body = renderPendingTodosMarkdown([makeTodo({ needs: 'define retry behavior' })]);
  assert.match(body, /Needs define retry behavior\.$/);
});

test('renderPendingTodosMarkdown: needs text already ending in "." does not double the period', () => {
  const body = renderPendingTodosMarkdown([makeTodo({ needs: 'Add a max-attempts cap.' })]);
  assert.match(body, /Needs Add a max-attempts cap\.$/);
  assert.doesNotMatch(body, /\.\.$/);
});

test('renderPendingTodosMarkdown: many todos render one bullet per todo, in order', () => {
  const todos = Array.from({ length: 5 }, (_, i) =>
    makeTodo({ title: `Todo number ${i}`, path: `.planning/todos/pending/todo-${i}.md` }),
  );
  const body = renderPendingTodosMarkdown(todos);
  const lines = body.split('\n');
  assert.equal(lines.length, 5);
  lines.forEach((line, i) => {
    assert.match(line, new RegExp(`Todo number ${i} `));
  });
});

test('renderPendingTodosMarkdown: markdown-special characters in title/area render verbatim', () => {
  const body = renderPendingTodosMarkdown([
    makeTodo({ title: 'Fix `parse()` for [bracketed] input', area: 'db|cache' }),
  ]);
  assert.match(body, /Fix `parse\(\)` for \[bracketed\] input/);
  assert.match(body, /\[db\|cache\]/);
});

test('renderPendingTodosMarkdown: boundary — 239 chars (limit-1) is not truncated', () => {
  // Assemble a title so the full line lands at exactly 239 chars, then assert
  // byte-identical (untruncated) output.
  const base = makeTodo({ needs: undefined, title: 'X' });
  const probe = renderPendingTodosMarkdown([base]);
  const pad = 239 - probe.length;
  assert.ok(pad > 0, 'test fixture sanity: base line must be shorter than 239 chars');
  const title = 'X'.repeat(1 + pad);
  const todo = makeTodo({ needs: undefined, title });
  const line = renderPendingTodosMarkdown([todo]);
  assert.equal(line.length, 239);
  assert.equal(line, `- [2026-09-01] [api] ${title} — [todo file](${todo.path})`);
});

test('renderPendingTodosMarkdown: boundary — 240 chars (limit) is not truncated', () => {
  const base = makeTodo({ needs: undefined, title: 'X' });
  const probe = renderPendingTodosMarkdown([base]);
  const pad = 240 - probe.length;
  const title = 'X'.repeat(1 + pad);
  const todo = makeTodo({ needs: undefined, title });
  const line = renderPendingTodosMarkdown([todo]);
  assert.equal(line.length, 240);
  assert.equal(line, `- [2026-09-01] [api] ${title} — [todo file](${todo.path})`);
});

test('renderPendingTodosMarkdown: full ISO-8601 \'created\' renders a date-only bracket (#4439)', () => {
  const line = renderPendingTodosMarkdown([makeTodo({ created: '2026-09-01T00:00:00.000Z', needs: undefined })]);
  assert.match(line, /^- \[2026-09-01\] \[api\]/);
  assert.doesNotMatch(line, /2026-09-01T/, 'full ISO timestamp must not leak into the rendered bullet');
});

test('renderPendingTodosMarkdown: \'created\' fallback (\'unknown\') is not sliced by the date-only formatter', () => {
  const line = renderPendingTodosMarkdown([makeTodo({ created: undefined, needs: undefined })]);
  assert.match(line, /^- \[unknown\] \[api\]/);
});

test('renderPendingTodosMarkdown: a malformed non-padded date is passed through unchanged, not mis-sliced', () => {
  const line = renderPendingTodosMarkdown([makeTodo({ created: '2026-9-1', needs: undefined })]);
  assert.match(line, /^- \[2026-9-1\] \[api\]/);
});

test('renderPendingTodosMarkdown: a non-4-digit year is not mis-sliced (near-miss YYYY-MM-DD shape)', () => {
  const line = renderPendingTodosMarkdown([makeTodo({ created: '202-09-01T00:00:00.000Z', needs: undefined })]);
  assert.match(line, /^- \[202-09-01T00:00:00\.000Z\] \[api\]/);
});

test('renderPendingTodosMarkdown: boundary — 241 chars (limit+1) truncates, needs dropped first', () => {
  const base = makeTodo({ needs: 'x', title: 'X' });
  const probe = renderPendingTodosMarkdown([base]);
  const pad = 241 - probe.length;
  const title = 'X'.repeat(1 + Math.max(pad, 0));
  const todo = makeTodo({ needs: 'a real needs clause that should get dropped', title });
  const line = renderPendingTodosMarkdown([todo]);
  assert.ok(line.length <= MAX, `expected <= ${MAX}, got ${line.length}`);
  assert.doesNotMatch(line, /Needs/, 'needs clause must be dropped before title is touched');
});

test('renderPendingTodosMarkdown: title truncated with floor + ellipsis when needs-drop is insufficient', () => {
  const longTitle = 'A'.repeat(400);
  const todo = makeTodo({ title: longTitle, needs: 'something' });
  const line = renderPendingTodosMarkdown([todo]);
  assert.ok(line.length <= MAX, `expected <= ${MAX}, got ${line.length}`);
  assert.doesNotMatch(line, /Needs/);
  assert.match(line, /…/);
  // date/area/link remain byte-identical to the untruncated assembly.
  assert.match(line, /^- \[2026-09-01\] \[api\] /);
  assert.match(line, new RegExp(`\\[todo file\\]\\(${escapeRegex(todo.path)}\\)$`));
});

test('renderPendingTodosMarkdown: pathological — title floor + link alone exceeds cap is allowed to overflow', () => {
  const veryLongPath = `.planning/todos/pending/${'p'.repeat(400)}.md`;
  const todo = makeTodo({ title: 'A'.repeat(400), path: veryLongPath, needs: 'x' });
  const line = renderPendingTodosMarkdown([todo]);
  // Documented known limit: link is never sacrificed even if it blows the cap.
  assert.ok(line.includes(veryLongPath), 'link must remain verbatim even when cap is exceeded');
});

test('property: rendered body always has one line per todo, each line <= 240 chars, link preserved verbatim', () => {
  // Path length is bounded so the algorithm's floor assembly (date + 3-char
  // area floor + 15-char title floor + link, needs always droppable) never
  // exceeds 240 — i.e. the cap is always achievable without touching the
  // link. This keeps the <= 240 assertion a real, provable invariant rather
  // than a vacuous one; the pathological "cap not achievable" case is
  // covered separately by the fixed "pathological" unit test above.
  const todoArb = fc.record({
    created: fc.constantFrom('2026-01-01', '2025-12-31', 'unknown', '2026-01-01T00:00:00.000Z', '2026-9-1'),
    area: fc.string({ minLength: 0, maxLength: 40 }),
    title: fc.string({ minLength: 0, maxLength: 500 }),
    path: fc
      .string({ minLength: 1, maxLength: 150 })
      .map((s) => `.planning/todos/pending/${s}.md`),
    needs: fc.option(fc.string({ minLength: 0, maxLength: 300 }), { nil: undefined }),
  });

  fc.assert(
    fc.property(fc.array(todoArb, { minLength: 0, maxLength: 20 }), (todos) => {
      const body = renderPendingTodosMarkdown(todos);
      if (todos.length === 0) {
        return body === 'None yet.';
      }
      const lines = body.split('\n');
      if (lines.length !== todos.length) return false;
      return lines.every((line, i) => {
        const link = `[todo file](${todos[i].path})`;
        return line.length <= 240 && line.includes(link);
      });
    }),
  );
});

// ─── #4384 regression: the 240-char cap must be deterministic w.r.t. where the
// repo is checked out (macOS /private/var/folders/… bases blew the budget and
// dropped the "Needs" clause; Linux /tmp passed — next's own macos shard 3/3
// went red on exactly this, CI run 34038716700) ──────────────────────────────

// Long enough that the pre-fix absolute-link bullet exceeds 240 chars on EVERY
// OS (Linux /tmp included): base > ~90 chars is over the threshold since the
// fixed skeleton + relative tail + needs clause land near 150.
const LONG_BASE_SEGMENT = 'd'.repeat(110);
const TODO_RELATIVE_TAIL = path
  .join('.planning', 'todos', 'pending', '2026-09-01-fix-retry-logic.md')
  .split(path.sep)
  .join('/');

test('renderPendingTodosMarkdown: cap is deterministic w.r.t. base-path length (needs clause survives long absolute bases)', () => {
  const shortBase = path.resolve('/', 'gsd-2618-short-base');
  const longBase = path.join(shortBase, LONG_BASE_SEGMENT);
  const todoAt = (base) =>
    makeTodo({ path: path.join(base, TODO_RELATIVE_TAIL), needs: 'Add a max-attempts cap.' });

  const fromShort = renderPendingTodosMarkdown([todoAt(shortBase)], shortBase);
  const fromLong = renderPendingTodosMarkdown([todoAt(longBase)], longBase);

  assert.equal(fromLong, fromShort, 'bullet must not depend on where the repo is checked out');
  assert.match(fromShort, /Needs Add a max-attempts cap\.$/);
  assert.match(fromLong, /Needs Add a max-attempts cap\.$/);
  assert.ok(
    fromLong.includes(`[todo file](${TODO_RELATIVE_TAIL})`),
    'link must be the repo-relative tail, not the absolute path',
  );
});

test('renderPendingTodosMarkdown: already-relative path is byte-stable with and without projectRoot', () => {
  const todo = makeTodo({ needs: 'define retry behavior' });
  const withRoot = renderPendingTodosMarkdown([todo], path.resolve('/', 'gsd-2618-rel-root'));
  assert.equal(withRoot, renderPendingTodosMarkdown([todo]));
});

test('renderPendingTodosMarkdown: absolute path without projectRoot keeps the legacy absolute link and drop order', () => {
  const base = path.join(path.resolve('/', 'gsd-2618-legacy-base'), LONG_BASE_SEGMENT);
  const todo = makeTodo({ path: path.join(base, TODO_RELATIVE_TAIL), needs: 'a real needs clause' });
  const line = renderPendingTodosMarkdown([todo]);
  // Opt-out callers keep today's behavior: over-cap drops needs first, link
  // verbatim (raw separators — the legacy renderer never posix-normalizes).
  assert.doesNotMatch(line, /Needs/);
  assert.ok(line.includes(`[todo file](${todo.path})`));
});

test('renderPendingTodosMarkdown: long base + long title still bounds the bullet and keeps the drop order', () => {
  const base = path.join(path.resolve('/', 'gsd-2618-order-base'), LONG_BASE_SEGMENT);
  const todo = makeTodo({
    path: path.join(base, TODO_RELATIVE_TAIL),
    title: 'A'.repeat(300),
    needs: 'something',
  });
  const line = renderPendingTodosMarkdown([todo], base);
  assert.ok(line.length <= MAX, `expected <= ${MAX}, got ${line.length}`);
  assert.doesNotMatch(line, /Needs/, 'needs clause must be dropped before title is touched');
  assert.match(line, /…/);
  assert.ok(line.includes(`[todo file](${TODO_RELATIVE_TAIL})`), 'relative link verbatim');
});

test('renderPendingTodosMarkdown: absolute path outside projectRoot renders a ../ relative link', () => {
  const root = path.resolve('/', 'gsd-2618-outside-root');
  const outsideTodo = path.join(
    path.resolve('/', 'gsd-2618-outside-sibling'),
    TODO_RELATIVE_TAIL,
  );
  const line = renderPendingTodosMarkdown([makeTodo({ path: outsideTodo })], root);
  // The ../-form legitimately CONTAINS the absolute path as a substring, so a
  // plain includes() negative is a false positive — assert the property
  // itself: the link target is relative, never the absolute path.
  const linkMatch = line.match(/\[todo file\]\(([^)]*)\)/);
  assert.ok(linkMatch, 'bullet must contain a todo link');
  assert.ok(!path.isAbsolute(linkMatch[1]), 'link target must be relative, not absolute');
  assert.notEqual(linkMatch[1], outsideTodo, 'link target must not be the machine-variable absolute path');
  assert.ok(
    line.includes('[todo file](../'),
    'link must be relative to the project root, not absolute',
  );
});

test('renderPendingTodosMarkdown: path equal to projectRoot falls back to the raw link target', () => {
  const root = path.resolve('/', 'gsd-2618-eq-root');
  const line = renderPendingTodosMarkdown([makeTodo({ path: root })], root);
  assert.ok(line.includes(`[todo file](${root})`));
});

test('renderPendingTodosMarkdown: non-string path keeps the empty-link fallback', () => {
  const line = renderPendingTodosMarkdown(
    [makeTodo({ path: 42 })],
    path.resolve('/', 'gsd-2618-num-root'),
  );
  assert.match(line, /\[todo file\]\(\)$/);
});

// ─── pending_read_ok / pending_todos_markdown via the real CLI surface ─────

const { spawnSync } = require('node:child_process');

function runQueryInitTodos(cwd) {
  const gsdTools = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  const result = spawnSync(process.execPath, [gsdTools, 'query', 'init.todos'], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, `gsd_run query init.todos failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('cmdInitTodos: pending_read_ok is true and pending_todos_markdown present for a healthy empty dir', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2618-'));
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, '.planning', 'todos', 'pending'), { recursive: true });

  const json = runQueryInitTodos(dir);
  assert.equal(json.pending_read_ok, true);
  assert.equal(json.pending_todos_markdown, 'None yet.');
  assert.equal(json.todo_count, 0);
});

test('cmdInitTodos: real todo file produces a rendered bullet via the CLI', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2618-'));
  t.after(() => cleanup(dir));
  const pendingDir = path.join(dir, '.planning', 'todos', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, '2026-09-01-fix-retry-logic.md'),
    [
      '---',
      'created: 2026-09-01T00:00:00.000Z',
      'title: Fix retry logic',
      'area: api',
      'severity: major',
      'files:',
      '  - src/api/client.cts:42',
      '---',
      '',
      '## Problem',
      '',
      'Retries are unbounded.',
      '',
      '## Solution',
      '',
      'Add a max-attempts cap.',
      '',
    ].join('\n'),
  );

  const json = runQueryInitTodos(dir);
  assert.equal(json.pending_read_ok, true);
  assert.match(json.pending_todos_markdown, /Fix retry logic/);
  assert.match(json.pending_todos_markdown, /^- \[2026-09-01\] \[api\]/m);
  // The Needs clause is asserted on the STRUCTURED field, not the rendered
  // bullet: the bullet embeds the todo file's ABSOLUTE path, so its total
  // length varies by runner tmpdir (macOS CI's /private/var/folders/… plus
  // the test harness's gsd-test-run-* wrapper pushed the full bullet past
  // renderPendingTodoBullet's intended 240-char cap, whose documented first
  // degradation step is to drop the Needs clause — a correct product
  // behavior this test must not depend on the runner's path length for).
  assert.equal(json.todo_count, 1);
  assert.ok(Array.isArray(json.todos) && json.todos.length === 1, 'todos array must carry the one todo');
  // (the raw field keeps the trailing period; only the rendered bullet
  // strips it — renderPendingTodoBullet's own unit rows pin that.)
  assert.equal(json.todos[0].needs, 'Add a max-attempts cap.');
});

test('cmdInitTodos: needs clause survives a deterministically long base path (#4384 macOS shape)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2618-long-'));
  t.after(() => cleanup(root));
  // One long path segment: deterministic on every OS (no real macOS dependency).
  // Pre-fix, the absolute-link bullet exceeds 240 chars even on Linux /tmp,
  // reproducing next's macos shard failure (CI run 34038716700).
  const dir = path.join(root, LONG_BASE_SEGMENT);
  const pendingDir = path.join(dir, '.planning', 'todos', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, '2026-09-01-fix-retry-logic.md'),
    [
      '---',
      'created: 2026-09-01T00:00:00.000Z',
      'title: Fix retry logic',
      'area: api',
      '---',
      '',
      '## Solution',
      '',
      'Add a max-attempts cap.',
      '',
    ].join('\n'),
  );

  const json = runQueryInitTodos(dir);
  assert.equal(json.pending_read_ok, true);
  assert.equal(json.todo_count, 1);
  assert.match(json.pending_todos_markdown, /Fix retry logic/);
  assert.match(json.pending_todos_markdown, /Needs Add a max-attempts cap\.$/m);
  assert.ok(
    json.pending_todos_markdown.includes(`[todo file](${TODO_RELATIVE_TAIL})`),
    'bullet link must be repo-relative',
  );
  assert.ok(
    !json.pending_todos_markdown.includes(dir.split(path.sep).join('/')),
    'absolute cwd must not leak into the rendered bullet',
  );
});

test('cmdInitTodos: bullet order is filename-sorted regardless of write/insertion order', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2618-'));
  t.after(() => cleanup(dir));
  const pendingDir = path.join(dir, '.planning', 'todos', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  // Written in reverse-alphabetical insertion order on purpose — readdirSync
  // order is filesystem-dependent, not contractually stable, so the ONLY way
  // to assert a deterministic bullet order is to sort explicitly. See #2618
  // spec review finding on git-diff stability (must-have #3).
  const todoBody = (title) =>
    ['---', 'created: 2026-09-01', `title: ${title}`, 'area: api', '---', ''].join('\n');
  fs.writeFileSync(path.join(pendingDir, '2026-09-03-third.md'), todoBody('Third todo'));
  fs.writeFileSync(path.join(pendingDir, '2026-09-01-first.md'), todoBody('First todo'));
  fs.writeFileSync(path.join(pendingDir, '2026-09-02-second.md'), todoBody('Second todo'));

  const json = runQueryInitTodos(dir);
  const titles = json.todos.map((t2) => t2.title);
  assert.deepEqual(titles, ['First todo', 'Second todo', 'Third todo']);
  const lines = json.pending_todos_markdown.split('\n');
  assert.ok(lines[0].includes('First todo'));
  assert.ok(lines[1].includes('Second todo'));
  assert.ok(lines[2].includes('Third todo'));
});

// ─── workflow parity guard (DEFECT.GENERATIVE-FIX) ─────────────────────────

function extractUpdateStateStep(workflowPath) {
  const content = fs.readFileSync(workflowPath, 'utf8');
  const match = content.match(/<step name="update_state">([\s\S]{0,20000}?)<\/step>/);
  assert.ok(match, `update_state step not found in ${workflowPath}`);
  return match[1].trim();
}

test('workflow parity: add-todo.md and check-todos.md update_state steps are byte-identical', () => {
  const addTodoPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'add-todo.md');
  const checkTodosPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'check-todos.md');
  const a = extractUpdateStateStep(addTodoPath);
  const b = extractUpdateStateStep(checkTodosPath);
  assert.equal(a, b, 'update_state step prose must be identical across both workflows (DEFECT.GENERATIVE-FIX)');
});
