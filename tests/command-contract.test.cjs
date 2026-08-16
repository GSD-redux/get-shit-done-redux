// allow-test-rule: source-text-is-the-product
// commands/gsd/*.md files ARE the deployed skill surface. Testing their
// contract tests the runtime behaviour.

'use strict';

/**
 * Command Contract tests  (ADR-0002)
 *
 * Authoritative behavioral contract for every commands/gsd/*.md file.
 * Replaces scattered coverage in enh-2790-skill-consolidation and
 * bug-3135-capture-backlog-workflow for the full-surface contract checks.
 *
 * Contract:
 *   1. name:          present, non-empty, starts with gsd: or gsd-
 *   2. description:   present, non-empty
 *   3. allowed-tools: present, non-empty, all entries from CANONICAL_TOOLS
 *   4. execution_context @-refs: every reference resolves to an existing file
 *   5. execution_context @-refs: each on its own line (no trailing prose)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT         = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const GSD_ROOT     = path.join(ROOT, 'gsd-core');

const {
  CANONICAL_TOOLS,
  parseFrontmatter,
  executionContextRefs,
  workflowPathRefs,
  unreachableWorkflows,
} = require('../scripts/command-contract-helpers.cjs');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-command-contract.cjs');

const commandFiles = fs
  .readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ name: f, full: path.join(COMMANDS_DIR, f) }));

// ─── contract tests ───────────────────────────────────────────────────────────

describe('command contract: name field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: name: present and starts with gsd: or gsd-`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(fm.name && fm.name.trim(), `${name}: name: field missing or empty`);
      assert.ok(
        /^gsd[:-]/.test(fm.name.trim()),
        `${name}: name: must start with "gsd:" or "gsd-", got "${fm.name.trim()}"`,
      );
    });
  }
});

describe('command contract: description field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: description: present and non-empty`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm.description && fm.description.trim(),
        `${name}: description: field missing or empty`,
      );
    });
  }
});

describe('command contract: allowed-tools (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: allowed-tools: present, non-empty, all canonical`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm['allowed-tools'] && fm['allowed-tools'].trim(),
        `${name}: allowed-tools: block missing or empty`,
      );
      const tools = fm['allowed-tools'].split('\n').map(t => t.trim()).filter(Boolean);
      for (const tool of tools) {
        const valid =
          CANONICAL_TOOLS.has(tool) ||
          (tool.startsWith('mcp__context7__') && CANONICAL_TOOLS.has('mcp__context7__*'));
        assert.ok(valid, `${name}: unknown tool "${tool}" in allowed-tools`);
      }
    });
  }
});

describe('command contract: execution_context @-refs resolve (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: all execution_context @-refs exist on disk`, () => {
      const refs = executionContextRefs(fs.readFileSync(full, 'utf-8'));
      for (const { normalized } of refs) {
        assert.ok(
          fs.existsSync(path.join(GSD_ROOT, normalized)),
          `${name}: execution_context @-ref "${normalized}" does not exist — ` +
          'create the file or remove the reference',
        );
      }
    });
  }
});

describe('command contract: execution_context @-refs on own line (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: no @-refs with trailing prose in execution_context`, () => {
      const refs = executionContextRefs(fs.readFileSync(full, 'utf-8'));
      const bad = refs.filter(r => r.trailingProse);
      assert.equal(
        bad.length, 0,
        `${name}: @-refs with trailing prose in execution_context: ` +
        bad.map(r => r.token).join(', '),
      );
    });
  }
});

describe('#3561 — workflowPathRefs resolver', () => {
  test('eager @-include', () => {
    assert.deepEqual(
      workflowPathRefs('@~/.claude/gsd-core/workflows/x.md'),
      ['workflows/x.md'],
    );
  });

  test('lazy tilde path', () => {
    assert.deepEqual(
      workflowPathRefs('read `~/.claude/gsd-core/workflows/x.md` now'),
      ['workflows/x.md'],
    );
  });

  test('repo-relative path', () => {
    assert.deepEqual(
      workflowPathRefs('see gsd-core/workflows/x.md'),
      ['workflows/x.md'],
    );
  });

  test('bare workflows path', () => {
    assert.deepEqual(
      workflowPathRefs('see workflows/x.md'),
      ['workflows/x.md'],
    );
  });

  test('parent-relative steps path', () => {
    assert.deepEqual(
      workflowPathRefs('run execute-phase/steps/post-merge-gate.md'),
      ['workflows/execute-phase/steps/post-merge-gate.md'],
    );
  });

  test('parent-relative modes path', () => {
    assert.deepEqual(
      workflowPathRefs('use discuss-phase/modes/power.md'),
      ['workflows/discuss-phase/modes/power.md'],
    );
  });

  test('empty content yields no refs', () => {
    assert.deepEqual(workflowPathRefs(''), []);
  });

  test('unrelated prose yields no refs', () => {
    assert.deepEqual(workflowPathRefs('nothing to see here'), []);
  });

  test('whitespace-only yields no refs', () => {
    assert.deepEqual(workflowPathRefs('   \n\t \n'), []);
  });

  test('de-duplicates repeated refs', () => {
    const refs = workflowPathRefs('workflows/x.md and again workflows/x.md');
    assert.deepEqual(refs, ['workflows/x.md']);
    assert.equal(refs.length, 1);
  });

  test('CRLF-tolerant', () => {
    assert.deepEqual(
      workflowPathRefs('workflows/a.md\r\nworkflows/b.md'),
      ['workflows/a.md', 'workflows/b.md'],
    );
  });

  test('ignores non-workflow md paths', () => {
    assert.deepEqual(
      workflowPathRefs('docs/GUIDE.md README.md references/r.md'),
      [],
    );
  });

  test('surfaces a ref whose target is absent', () => {
    assert.deepEqual(
      workflowPathRefs('workflows/does-not-exist.md'),
      ['workflows/does-not-exist.md'],
    );
  });

  test('does not emit a traversing path', () => {
    const refs = workflowPathRefs('workflows/../../etc/passwd.md');
    for (const ref of refs) {
      assert.ok(!ref.includes('..'), `traversal path leaked: ${ref}`);
    }
  });

  test('tolerates an overlong path', () => {
    const content = 'workflows/' + 'a'.repeat(5000) + '.md';
    assert.doesNotThrow(() => workflowPathRefs(content));
  });

  test('rejects a .mdx path', () => {
    assert.deepEqual(workflowPathRefs('workflows/foobar.mdx'), []);
  });

  test('rejects a .md5 path', () => {
    assert.deepEqual(workflowPathRefs('workflows/foo.md5'), []);
  });

  test('still accepts a .md path followed by punctuation', () => {
    assert.deepEqual(
      workflowPathRefs('see workflows/x.md, then stop'),
      ['workflows/x.md'],
    );
  });

  test('binds to the --fast line, not the whole file', () => {
    const syntheticFile = [
      '- If it is `--fast`: strip the flag, run the scan workflow.',
      '<!-- see gsd-core/workflows/scan.md -->',
    ].join('\n');
    const fastLine = syntheticFile
      .split(/\r?\n/)
      .find(line => /^-\s*If it is\s*`--fast`/.test(line));
    assert.ok(fastLine, 'setup error: synthetic fixture missing --fast routing line');
    assert.ok(
      !workflowPathRefs(fastLine).includes('workflows/scan.md'),
      'regression guard: the --fast routing line itself names no resolvable path — ' +
      'an unrelated comment elsewhere in the file must not make this test pass',
    );
  });
});

describe('#3561 — /gsd-map-codebase --fast routes to a loadable workflow', () => {
  const mapCodebasePath = path.join(COMMANDS_DIR, 'map-codebase.md');
  const mapCodebaseContent = fs.readFileSync(mapCodebasePath, 'utf-8');

  test('map-codebase: --fast routing names a loadable scan.md', () => {
    const fastLine = mapCodebaseContent
      .split(/\r?\n/)
      .find(line => /^-\s*If it is\s*`--fast`/.test(line));
    assert.ok(
      fastLine,
      '#3561: commands/gsd/map-codebase.md has no "--fast" routing bullet ' +
      '(expected a line matching /^-\\s*If it is\\s*`--fast`/) — the routing logic is missing entirely',
    );
    const refs = workflowPathRefs(fastLine);
    assert.ok(
      refs.includes('workflows/scan.md'),
      '#3561: --fast routes to the scan workflow but the routing line names no path ' +
      'the runtime can resolve, so scan.md is never loaded',
    );
  });

  test('full map does not eagerly load scan.md', () => {
    const refs = executionContextRefs(mapCodebaseContent);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].normalized, 'workflows/map-codebase.md');
  });
});

describe('#3561 — every workflow path referenced by a command exists on disk', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: all workflowPathRefs paths exist on disk`, () => {
      const refs = workflowPathRefs(fs.readFileSync(full, 'utf-8'));
      for (const ref of refs) {
        assert.ok(
          fs.existsSync(path.join(GSD_ROOT, ref)),
          `${name}: referenced workflow path "${ref}" does not exist under ${GSD_ROOT}`,
        );
      }
    });
  }
});


describe('#3560 — unreachableWorkflows closure', () => {
  test('a planted orphan is reported', () => {
    const loaderContents = ['load workflows/live.md'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/live.md', 'workflows/orphan.md'];
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/orphan.md'],
    );
  });

  test('eager include reaches', () => {
    const loaderContents = ['@~/.claude/gsd-core/workflows/a.md'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/a.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('lazy path reaches', () => {
    const loaderContents = ['read `gsd-core/workflows/a.md`'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/a.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('parent-relative reaches', () => {
    const loaderContents = ['run execute-phase/steps/s.md'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/execute-phase/steps/s.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('reaches transitively', () => {
    const loaderContents = ['see workflows/a.md'];
    const gsdFiles = new Map([['workflows/a.md', 'see workflows/b.md']]);
    const workflowPaths = ['workflows/a.md', 'workflows/b.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('reaches at depth three', () => {
    const loaderContents = ['see workflows/a.md'];
    const gsdFiles = new Map([
      ['workflows/a.md', 'see workflows/b.md'],
      ['workflows/b.md', 'see workflows/c.md'],
    ]);
    const workflowPaths = ['workflows/a.md', 'workflows/b.md', 'workflows/c.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('a self-reference does not reach', () => {
    // Nothing in loaderContents mentions self.md; the fact that self.md's
    // own body references itself must not count as reachability.
    const loaderContents = [];
    const gsdFiles = new Map([['workflows/self.md', 'see workflows/self.md']]);
    const workflowPaths = ['workflows/self.md'];
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/self.md'],
    );
  });

  test('a mutual-reference island does not reach', () => {
    // x and y point only at each other; no loader points at either. The
    // island looks connected from the inside but no runtime ever opens it.
    const loaderContents = [];
    const gsdFiles = new Map([
      ['workflows/x.md', 'see workflows/y.md'],
      ['workflows/y.md', 'see workflows/x.md'],
    ]);
    const workflowPaths = ['workflows/x.md', 'workflows/y.md'];
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/x.md', 'workflows/y.md'],
    );
  });

  test('terminates on a cycle', () => {
    // a -> b -> c -> a. All three are reachable from the loader; the walk
    // must still terminate rather than looping forever on the cycle.
    const loaderContents = ['see workflows/a.md'];
    const gsdFiles = new Map([
      ['workflows/a.md', 'see workflows/b.md'],
      ['workflows/b.md', 'see workflows/c.md'],
      ['workflows/c.md', 'see workflows/a.md'],
    ]);
    const workflowPaths = ['workflows/a.md', 'workflows/b.md', 'workflows/c.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('a docs-only mention does not reach (Goodhart guard: mentioning a path is not the same as loading it)', () => {
    // Simulates a hypothetical prose/docs file that names orphan.md — that
    // string is simply never included in loaderContents (or gsdFiles), which
    // is exactly what "a docs mention" looks like to this function: absent.
    const loaderContents = [];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/orphan.md'];
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/orphan.md'],
    );
  });

  test('a dangling reference reaches nothing', () => {
    const loaderContents = ['see workflows/missing.md'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/real-orphan.md'];
    assert.doesNotThrow(() => unreachableWorkflows(loaderContents, gsdFiles, workflowPaths));
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/real-orphan.md'],
    );
  });

  test('empty workflow set', () => {
    const loaderContents = ['see workflows/a.md'];
    const gsdFiles = new Map();
    const workflowPaths = [];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('no loaders means nothing is reached', () => {
    const loaderContents = [];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/a.md'];
    assert.deepEqual(
      unreachableWorkflows(loaderContents, gsdFiles, workflowPaths),
      ['workflows/a.md'],
    );
  });

  test('CRLF-tolerant', () => {
    const loaderContents = ['workflows/a.md\r\nworkflows/b.md'];
    const gsdFiles = new Map();
    const workflowPaths = ['workflows/a.md', 'workflows/b.md'];
    assert.deepEqual(unreachableWorkflows(loaderContents, gsdFiles, workflowPaths), []);
  });

  test('reports exactly the orphan among many', () => {
    const reachable = Array.from({ length: 152 }, (_, i) => `workflows/gen-${i}.md`);
    const loaderContents = reachable.slice();
    const gsdFiles = new Map();
    const orphan = 'workflows/orphan-152.md';
    const workflowPaths = [...reachable, orphan];
    const result = unreachableWorkflows(loaderContents, gsdFiles, workflowPaths);
    assert.equal(result.length, 1);
    assert.deepEqual(result, [orphan]);
  });
});

describe('#3560 — rule 6 fails the build on a real orphan', () => {
  // Builds the minimal fixture tree the lint CLI needs to satisfy rules 1-5
  // for a single command file, plus an eagerly-loaded live.md workflow.
  // `extra` lets each test layer on exactly the additional state it needs
  // without coupling test execution order to shared mutable fixture state.
  function buildBaseFixture(dir) {
    fs.mkdirSync(path.join(dir, 'commands', 'gsd'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'gsd-core', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'commands', 'gsd', 'fixture-command.md'),
      [
        '---',
        'name: gsd:fixture-command',
        'description: Fixture command for the #3560 rule-6 regression tests.',
        'allowed-tools:',
        '  - Read',
        '  - Bash',
        '---',
        '',
        '<execution_context>',
        '@~/.claude/gsd-core/workflows/live.md',
        '</execution_context>',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'workflows', 'live.md'),
      '# live workflow\n\nNothing special here.\n',
    );
  }

  function runLint(dir) {
    return runNode([LINT_SCRIPT, '--root', dir], { timeoutMs: PROBE_TIMEOUT_MS });
  }

  test('clean fixture passes', (t) => {
    const dir = createTempDir('gsd-3560-clean-');
    t.after(() => cleanup(dir));
    buildBaseFixture(dir);

    const result = runLint(dir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
  });

  test('a planted orphan fails the build', (t) => {
    const dir = createTempDir('gsd-3560-orphan-');
    t.after(() => cleanup(dir));
    buildBaseFixture(dir);
    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'workflows', 'orphan.md'),
      '# orphan workflow\n\nNo loader references this file.\n',
    );

    const result = runLint(dir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
    assert.ok(
      (result.stdout + result.stderr).includes('gsd-core/workflows/orphan.md'),
      'diagnostic output must name the orphaned file path',
    );
  });

  test('an orphan referenced only from docs/ still fails', (t) => {
    const dir = createTempDir('gsd-3560-docs-only-');
    t.after(() => cleanup(dir));
    buildBaseFixture(dir);
    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'workflows', 'orphan.md'),
      '# orphan workflow\n\nNo loader references this file.\n',
    );
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'SOMETHING.md'),
      'See gsd-core/workflows/orphan.md for details.\n',
    );

    const result = runLint(dir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
  });

  test('an orphan reachable only transitively passes', (t) => {
    const dir = createTempDir('gsd-3560-transitive-');
    t.after(() => cleanup(dir));
    buildBaseFixture(dir);
    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'workflows', 'orphan.md'),
      '# orphan workflow\n\nReachable transitively via live.md.\n',
    );
    // live.md itself now names orphan.md; live.md is eagerly loaded by the
    // fixture command, so orphan.md becomes reachable one hop out.
    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'workflows', 'live.md'),
      '# live workflow\n\nSee workflows/orphan.md for the follow-up.\n',
    );

    const result = runLint(dir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
  });
});

describe('#3560 — deleted orphan workflows do not ship', () => {
  const deletedBasenames = ['discovery-phase.md', 'plan-milestone-gaps.md'];

  for (const basename of deletedBasenames) {
    test(`${basename}: does not exist under gsd-core/workflows/`, () => {
      assert.ok(
        !fs.existsSync(path.join(GSD_ROOT, 'workflows', basename)),
        `${basename}: expected file to be deleted from gsd-core/workflows/, but it still exists`,
      );
    });
  }

  const fixturesDir = path.join(ROOT, 'tests', 'fixtures', 'install-tree');
  const fixtureFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));

  for (const fixtureFile of fixtureFiles) {
    test(`${fixtureFile}: install-tree manifest contains no entry for a deleted workflow`, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, fixtureFile), 'utf-8'));
      for (const basename of deletedBasenames) {
        const gsdRelative = `gsd-core/workflows/${basename}`;
        assert.ok(
          !manifest.includes(gsdRelative),
          `${fixtureFile}: manifest still lists ${gsdRelative}`,
        );
      }
    });
  }

  test('scan.md is untouched by this PR', () => {
    assert.ok(
      fs.existsSync(path.join(GSD_ROOT, 'workflows', 'scan.md')),
      'gsd-core/workflows/scan.md is expected to still exist — this PR only deletes ' +
      'discovery-phase.md and plan-milestone-gaps.md',
    );
  });
});

describe('#3560 — INVENTORY carries no row for a deleted workflow', () => {
  const inventoryFiles = [
    'docs/INVENTORY.md',
    'docs/ja-JP/INVENTORY.md',
    'docs/ko-KR/INVENTORY.md',
    'docs/zh-CN/INVENTORY.md',
    'docs/pt-BR/INVENTORY.md',
  ];

  for (const rel of inventoryFiles) {
    test(`${rel}: mentions neither discovery-phase.md nor plan-milestone-gaps.md`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      assert.ok(!content.includes('discovery-phase.md'), `${rel}: still mentions discovery-phase.md`);
      assert.ok(!content.includes('plan-milestone-gaps.md'), `${rel}: still mentions plan-milestone-gaps.md`);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3168-task-to-agent-rename.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3168-task-to-agent-rename (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3168)
// commands/gsd/*.md, gsd-core/workflows/*.md, and agents/gsd-*.md are
// deployed product files. Checking their text IS checking the runtime contract.

/**
 * #3168 — Incomplete Task→Agent dispatcher rename causes silent inline fallback.
 *
 * The Claude Code subagent-dispatcher tool is named `Agent`. The `Task*` namespace
 * (TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop) is the task
 * tracker — a distinct tool set. GSD workflows were partially migrated and still
 * reference `Task(` and `- Task` in allowed-tools/tools frontmatter in most files.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const AGENTS_DIR = path.join(ROOT, 'agents');

// Task tracker names — these must NOT be renamed
const TASK_TRACKER_PATTERN = /\bTask(?:Create|List|Get|Update|Output|Stop)\b/;

function readMdFiles(dir, prefix) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && (!prefix || f.startsWith(prefix)))
    .map(f => ({ name: f, path: path.join(dir, f), content: fs.readFileSync(path.join(dir, f), 'utf-8') }));
}

function extractFrontmatterTools(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const toolsMatch = fm[1].match(/^allowed-tools:\s*\r?\n((?:[ \t]+-[^\n]*\n?)*)/m) ||
                     fm[1].match(/^tools:\s*(.+)$/m);
  if (!toolsMatch) return [];
  const toolsBlock = toolsMatch[1];
  if (toolsBlock.includes('\n')) {
    return toolsBlock.match(/[-\s]*([A-Za-z_*][A-Za-z0-9_*]*)/g)
      .map(t => t.replace(/^[-\s]+/, '').trim())
      .filter(Boolean);
  }
  return toolsBlock.split(',').map(t => t.trim()).filter(Boolean);
}

describe('#3168 — commands/gsd: allowed-tools must use Agent not Task', () => {
  const commands = readMdFiles(COMMANDS_DIR);

  for (const cmd of commands) {
    test(`${cmd.name}: allowed-tools must not list Task without Agent`, () => {
      const tools = extractFrontmatterTools(cmd.content);
      const hasTask = tools.includes('Task');
      const hasAgent = tools.includes('Agent');
      assert.ok(
        !hasTask || hasAgent,
        `${cmd.name}: allowed-tools lists "Task" but not "Agent" — dispatcher tool is "Agent", not "Task"\n  tools: [${tools.join(', ')}]`,
      );
      assert.ok(
        !hasTask,
        `${cmd.name}: allowed-tools still lists "Task" — remove it (Agent is the dispatcher tool)\n  tools: [${tools.join(', ')}]`,
      );
    });
  }
});

describe('#3168 — workflows: prose must use Agent( not Task( for dispatcher calls', () => {
  const workflows = [];
  function collectMd(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) collectMd(path.join(dir, entry.name));
      else if (entry.name.endsWith('.md')) workflows.push({ name: entry.name, path: path.join(dir, entry.name), content: fs.readFileSync(path.join(dir, entry.name), 'utf-8') });
    }
  }
  collectMd(WORKFLOWS_DIR);

  for (const wf of workflows) {
    test(`${wf.name}: must not contain dispatcher Task( calls`, () => {
      const lines = wf.content.split(/\r?\n/);
      const violations = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip code fences that show old examples
        if (line.trim().startsWith('```') || line.trim().startsWith('#')) continue;
        // Match Task( that is NOT a tracker call (TaskCreate, TaskList, etc.)
        if (/\bTask\(/.test(line) && !TASK_TRACKER_PATTERN.test(line)) {
          violations.push(`  line ${i + 1}: ${line.trim()}`);
        }
      }
      assert.deepStrictEqual(
        violations,
        [],
        `${wf.name}: found dispatcher Task( calls that should be Agent(:\n${violations.join('\n')}`,
      );
    });
  }
});

describe('#3168 — agents: tools frontmatter must use Agent not Task', () => {
  const agents = readMdFiles(AGENTS_DIR, 'gsd-');

  for (const agent of agents) {
    test(`${agent.name}: tools must not list Task`, () => {
      const tools = extractFrontmatterTools(agent.content);
      assert.ok(
        !tools.includes('Task'),
        `${agent.name}: tools frontmatter lists "Task" — should be "Agent"\n  tools: [${tools.join(', ')}]`,
      );
    });
  }
});
  });
}
