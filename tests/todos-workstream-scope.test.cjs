'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #4256 — todos are root-scoped shared state; readers must read the root.
//
// The migrateToWorkstreams contract (src/workstream.cts) keeps todos among the
// SHARED files that "stay in place" at .planning/todos/, and every workflow
// writer writes that literal root path. But all six code readers composed
// their todos path from the workstream-aware planningDir(cwd), so under a
// workstream they read .planning/workstreams/<ws>/todos/pending/ — a directory
// nothing creates — and each reader's ENOENT guard turned "wrong directory"
// into a legitimate-looking zero: invisible todos, `todo complete` refusing
// files that exist, and `audit-open` (a milestone-close gate) printing "All
// artifact types clear" with pending todos on disk.
//
// The fix converges every reader on the root-scoped todosDir(cwd) resolver
// (src/planning-workspace.cts, beside quickDirFrom per #2142/#3149), and moves
// audit acknowledge's requireSafePath boundary with it. These rows pin the
// converged behavior under a workstream AND the byte-identical flat-mode
// control (planningDir === planningRoot with no project/workstream active).
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools, toPosixPath } = require('./helpers.cjs');
const planningWorkspace = require('../gsd-core/bin/lib/planning-workspace.cjs');

const TODO_A = '2026-09-01-one.md';
const TODO_B = '2026-09-02-two.md';

function seedRootTodos(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'completed'), { recursive: true });
  for (const [file, title, created] of [[TODO_A, 'One', '2026-09-01'], [TODO_B, 'Two', '2026-09-02']]) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'todos', 'pending', file),
      `---\ntitle: ${title}\ncreated: ${created}\narea: general\npriority: high\n---\nbody\n`,
    );
  }
}

function seedWorkstreamDir(tmpDir, ws) {
  // Minimal workstream layout — enough for the ws discriminator to resolve a
  // real directory; nothing more is needed to reproduce the scope split.
  fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', ws, 'phases'), { recursive: true });
}

function queryJson(args, cwd, env = {}) {
  const r = runGsdTools(args, cwd, env);
  assert.ok(r.success, `gsd-tools ${args.join(' ')} failed: ${r.error}`);
  return JSON.parse(r.output);
}

describe('#4256: todos readers resolve the root under a workstream', () => {
  test('init.todos counts root todos with GSD_WORKSTREAM set (regression)', (t) => {
    const tmpDir = createTempProject('gsd-4256-initws-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'init.todos', '--raw'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });

    assert.equal(out.todo_count, 2, `root todos must be visible under a workstream; got ${out.todo_count}`);
    assert.ok(
      toPosixPath(out.pending_dir).endsWith('.planning/todos/pending'),
      `pending_dir must be the ROOT pending dir, got ${out.pending_dir}`,
    );
    assert.equal(out.todos_dir_exists, true, 'todos_dir_exists must probe the root todos dir');
    assert.equal(out.pending_dir_exists, true, 'pending_dir_exists must probe the root pending dir');
    assert.ok(
      Array.isArray(out.todos) && out.todos.length === 2,
      'the todo list itself must carry both root files',
    );
    assert.ok(
      toPosixPath(out.todos[0].path).includes(`.planning/todos/pending/${TODO_A}`),
      `per-todo path must point at the root file, got ${out.todos[0].path}`,
    );
  });

  test('init.todos counts root todos via explicit --ws flag', (t) => {
    const tmpDir = createTempProject('gsd-4256-initflag-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'init.todos', '--ws', 'feature-a', '--raw'], tmpDir);

    assert.equal(out.todo_count, 2, '--ws must not hide root todos');
    assert.ok(
      toPosixPath(out.pending_dir).endsWith('.planning/todos/pending'),
      `pending_dir must stay root-scoped under --ws, got ${out.pending_dir}`,
    );
  });

  test('list-todos returns root todos under a workstream', (t) => {
    const tmpDir = createTempProject('gsd-4256-listws-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'list-todos'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });

    assert.equal(out.count, 2, `list-todos must see root todos under a workstream; got ${out.count}`);
    const files = out.todos.map((x) => x.file).sort();
    assert.deepEqual(files, [TODO_A, TODO_B]);
    assert.ok(
      toPosixPath(out.todos[0].path).startsWith('.planning/todos/pending/'),
      `list-todos paths must be root-relative, got ${out.todos[0].path}`,
    );
  });

  test('todo match-phase sees the root todo set under a workstream', (t) => {
    const tmpDir = createTempProject('gsd-4256-matchws-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'todo', 'match-phase', '1', '--raw'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });

    assert.equal(out.todo_count, 2, `match-phase must scan the root todo set; got ${out.todo_count}`);
  });

  test('todo complete moves the ROOT file pending -> completed under a workstream', (t) => {
    const tmpDir = createTempProject('gsd-4256-complete-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'todo', 'complete', TODO_A], tmpDir, { GSD_WORKSTREAM: 'feature-a' });
    assert.equal(out.completed, true);

    const rootPending = path.join(tmpDir, '.planning', 'todos', 'pending', TODO_A);
    const rootCompleted = path.join(tmpDir, '.planning', 'todos', 'completed', TODO_A);
    assert.ok(!fs.existsSync(rootPending), 'source must be removed from the ROOT pending dir');
    assert.ok(fs.existsSync(rootCompleted), 'target must land in the ROOT completed dir');
    const content = fs.readFileSync(rootCompleted, 'utf8');
    assert.match(content, /^status: completed$/m, 'completion fields must be written into frontmatter');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'feature-a', 'todos')),
      'complete must NOT materialize the divergent workstream todos dir',
    );
  });

  test('todo complete --dry-run finds the root todo and mutates nothing (#4096 fence intact)', (t) => {
    const tmpDir = createTempProject('gsd-4256-dryrun-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['query', 'todo', 'complete', TODO_A, '--dry-run'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });

    assert.equal(out.dry_run, true);
    assert.equal(out.would_complete, true);
    assert.ok(
      toPosixPath(out.would_move.source).endsWith(`.planning/todos/pending/${TODO_A}`),
      `dry-run source must be the ROOT pending file, got ${out.would_move.source}`,
    );
    assert.ok(
      toPosixPath(out.would_move.target).endsWith(`.planning/todos/completed/${TODO_A}`),
      `dry-run target must be the ROOT completed file, got ${out.would_move.target}`,
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'pending', TODO_A)) &&
      fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'pending', TODO_B)),
      'a dry run must leave both root files untouched',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'completed', TODO_A)),
      'a dry run must not write the completed copy',
    );
  });

  test('audit-open counts root pending todos under a workstream — the close gate FAILS', (t) => {
    const tmpDir = createTempProject('gsd-4256-gate-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    const out = queryJson(['audit-open', '--json'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });

    assert.equal(out.counts.todos, 2, `the close gate must count the root todos; got ${out.counts.todos}`);
    assert.equal(out.has_open_items, true, 'pending root todos must block the milestone close');
    const names = out.items.todos.map((i) => i.filename).sort();
    assert.deepEqual(names, [TODO_A, TODO_B]);
  });

  test('audit acknowledge writes the marker into the ROOT todo under a workstream (boundary moved)', (t) => {
    const tmpDir = createTempProject('gsd-4256-ack-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');
    const env = { GSD_WORKSTREAM: 'feature-a' };

    const ack = queryJson(
      ['audit-open', 'acknowledge', '--category', 'todos', '--milestone', 'v1.0', '--filename', TODO_A],
      tmpDir,
      env,
    );
    assert.equal(ack.acknowledged, true);

    const rootFile = path.join(tmpDir, '.planning', 'todos', 'pending', TODO_A);
    assert.ok(fs.existsSync(rootFile), 'the acknowledged todo stays in the ROOT pending dir');
    const content = fs.readFileSync(rootFile, 'utf8');
    assert.match(content, /^audit_acknowledged:/m, 'the marker must be spliced into the ROOT file');

    const after = queryJson(['audit-open', '--json'], tmpDir, env);
    assert.equal(after.acknowledged.todos, 1, 'the acknowledged root todo must be tallied, not open');
    assert.equal(after.counts.todos, 1, 'only the unacknowledged root todo stays open');
  });
});

describe('#4256: negative space — flat, project, and boundary scopes', () => {
  test('flat mode (no workstream) counts are unchanged', (t) => {
    const tmpDir = createTempProject('gsd-4256-flat-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);

    const init = queryJson(['query', 'init.todos', '--raw'], tmpDir);
    assert.equal(init.todo_count, 2);
    assert.ok(toPosixPath(init.pending_dir).endsWith('.planning/todos/pending'));

    const audit = queryJson(['audit-open', '--json'], tmpDir);
    assert.equal(audit.counts.todos, 2);
  });

  test('GSD_PROJECT mode also reads the cwd-relative root todos dir', (t) => {
    const tmpDir = createTempProject('gsd-4256-project-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);

    // Workflow writers use the literal cwd-relative `.planning/todos/...`, so
    // under a project scope the files live at the planning ROOT, not under
    // `.planning/<project>/todos/` — the reader must converge on the root.
    const out = queryJson(['query', 'init.todos', '--raw'], tmpDir, { GSD_PROJECT: 'myapp' });
    assert.equal(out.todo_count, 2, `root todos must be visible under GSD_PROJECT; got ${out.todo_count}`);
    assert.ok(
      toPosixPath(out.pending_dir).endsWith('.planning/todos/pending'),
      `pending_dir must stay at the root under GSD_PROJECT, got ${out.pending_dir}`,
    );
  });

  test('legacy per-workstream symlink workaround becomes inert — count stays correct', (t) => {
    const tmpDir = createTempProject('gsd-4256-symlink-');
    t.after(() => cleanup(tmpDir));
    seedRootTodos(tmpDir);
    seedWorkstreamDir(tmpDir, 'feature-a');

    // The pre-fix workaround: a relative symlink redirecting the workstream
    // path to the root. Post-fix readers never traverse the workstream
    // prefix, so it must neither break nor double-count.
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'feature-a');
    try {
      fs.symlinkSync('../../todos', path.join(wsDir, 'todos'), 'dir');
    } catch (err) {
      t.skip(`filesystem does not support symlinks: ${err.code}`);
      return;
    }

    const out = queryJson(['query', 'init.todos', '--raw'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });
    assert.equal(out.todo_count, 2, `count must stay exact with the workaround symlink present; got ${out.todo_count}`);
  });

  test('fresh project with no todos dir under a workstream is a legitimate zero', (t) => {
    const tmpDir = createTempProject('gsd-4256-empty-');
    t.after(() => cleanup(tmpDir));
    seedWorkstreamDir(tmpDir, 'feature-a');

    const init = queryJson(['query', 'init.todos', '--raw'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });
    assert.equal(init.todo_count, 0);
    assert.equal(init.pending_dir_exists, false);

    const list = queryJson(['query', 'list-todos'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });
    assert.equal(list.count, 0);

    const audit = queryJson(['audit-open', '--json'], tmpDir, { GSD_WORKSTREAM: 'feature-a' });
    assert.equal(audit.counts.todos, 0);
  });
});

describe('#4256: todosDir resolver owns the path (planning-workspace)', () => {
  const { todosDirFrom, todosDir, planningPaths, planningRoot } = planningWorkspace;

  test('todosDirFrom(base) composes <base>/todos', () => {
    assert.equal(todosDirFrom(path.join('/fake', 'planning')), path.join('/fake', 'planning', 'todos'));
  });

  test('todosDir(cwd) is root-scoped — GSD_WORKSTREAM does not move it', (t) => {
    const saved = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'feature-a';
    t.after(() => {
      if (saved === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved;
    });

    assert.equal(todosDir('/fake/repo'), path.join('/fake', 'repo', '.planning', 'todos'));
    assert.equal(todosDir('/fake/repo'), path.join(planningRoot('/fake/repo'), 'todos'));
  });

  test('planningPaths keeps workstream keys scoped while todos stays root-scoped', () => {
    const saved = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_WORKSTREAM;
    try {
      const paths = planningPaths('/fake/repo', 'feature-x');
      assert.ok(toPosixPath(paths.planning).endsWith('.planning/workstreams/feature-x'));
      assert.ok(toPosixPath(paths.state).endsWith('.planning/workstreams/feature-x/STATE.md'));
      assert.ok(toPosixPath(paths.quick).endsWith('.planning/workstreams/feature-x/quick'));
      assert.ok(
        toPosixPath(paths.todos).endsWith('.planning/todos'),
        `planningPaths().todos must be deliberately root-scoped, got ${paths.todos}`,
      );
    } finally {
      if (saved !== undefined) process.env.GSD_WORKSTREAM = saved;
    }
  });
});
