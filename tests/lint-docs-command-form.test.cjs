'use strict';

/**
 * TDD tests for scripts/lint-docs-command-form.cjs (#2903).
 *
 * Uses spawnSync to invoke the guard script against a temporary git repo so
 * we can inject fixtures without touching the real repo. Mirrors the fixture
 * pattern in tests/lint-legacy-dir-name.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const GUARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'lint-docs-command-form.cjs');

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-docs-command-form-test-'));
  gitOrThrow(['init', '--initial-branch=main'], { cwd: dir });
  gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
  // Roster source: the guard reads commands/gsd/*.md filenames as valid
  // command names, regardless of tracked/staged status.
  writeFile(dir, 'commands/gsd/plan-phase.md', '# plan-phase\n');
  return dir;
}

function writeFile(dir, relPath, content) {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function gitAdd(dir, relPath) {
  gitOrThrow(['add', relPath], { cwd: dir });
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in lint test; no helpers import available
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Returns an object shaped like the raw spawnSync() result (status/stdout/
 * stderr) because every call site in this file was written against that
 * shape; the seam itself returns exitCode, not status, so it is mapped here.
 * 30_000ms: matches the sibling-suite default for guard scripts that shell
 * out to git (the guard runs `git ls-files` over the fixture repo), which
 * is comparable workload to this script's own `git ls-files` invocation.
 */
function runGuard(cwd) {
  const r = runNode([GUARD_SCRIPT], {
    cwd,
    env: { ...process.env, GSD_LINT_DOCS_COMMAND_FORM_REPO_ROOT: cwd },
    timeoutMs: 30_000,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe('lint-docs-command-form — colon slash form flagged', () => {
  test('exits non-zero and names the file when docs contain /gsd:<cmd>', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/how-to/example.md', 'Run `/gsd:plan-phase` to start.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(result.stderr.includes('docs/how-to/example.md'), `stderr should name the file: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — plugin namespace permitted', () => {
  test('exits 0 when docs contain /gsd-core:<cmd>', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/how-to/example.md', 'Run `/gsd-core:plan-phase` to start.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 for /gsd-core:, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — docs/adr exempt', () => {
  test('exits 0 for a fixture under docs/adr/', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/adr/999-example.md', 'Historically we typed `/gsd:plan-phase`.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'docs/adr/999-example.md');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 under docs/adr/, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — source trees never checked', () => {
  test('exits 0 for a fixture under gsd-core/workflows/ (colon form is correct there)', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'gsd-core/workflows/example.md', 'Dispatch `/gsd:plan-phase`.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'gsd-core/workflows/example.md');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 under gsd-core/workflows/, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — bare colon form flagged', () => {
  test('exits non-zero when docs contain bare gsd:<cmd>', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/how-to/example.md', 'The command is gsd:plan-phase.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(result.stderr.includes('docs/how-to/example.md'), `stderr should name the file: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — name: frontmatter key citation exempt', () => {
  test('exits 0 when docs quote `name: gsd:next` as a source frontmatter citation', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'commands/gsd/next.md', '---\nname: gsd:next\n---\n');
      writeFile(
        dir,
        'docs/how-to/example.md',
        'Frontmatter:\n- `name: gsd:next` (surfaces as `/gsd-next`)\n',
      );
      gitAdd(dir, 'commands/gsd/next.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.equal(
        result.status,
        0,
        `expected exit 0 for a name: frontmatter citation, got ${result.status}; stderr: ${result.stderr}`,
      );
      assert.ok(result.stdout.includes('0 violations'), `stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — name: exemption is narrow, not a blanket hole', () => {
  test('exits non-zero when bare gsd:next appears without a preceding name: key', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'commands/gsd/next.md', '---\nname: gsd:next\n---\n');
      writeFile(dir, 'docs/how-to/example.md', 'Just type gsd:next to run it.\n');
      gitAdd(dir, 'commands/gsd/next.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(result.stderr.includes('docs/how-to/example.md'), `stderr should name the file: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — case-insensitive detection', () => {
  test('exits non-zero when docs contain /GSD:next (mixed case)', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'commands/gsd/next.md', '---\nname: gsd:next\n---\n');
      writeFile(dir, 'docs/how-to/example.md', 'Run `/GSD:next` to start.\n');
      gitAdd(dir, 'commands/gsd/next.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(result.stderr.includes('docs/how-to/example.md'), `stderr should name the file: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-docs-command-form — clean docs tree', () => {
  test('exits 0 on a clean fixture repo with no colon-form commands', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/how-to/example.md', 'Run `/gsd-plan-phase` to start.\n');
      gitAdd(dir, 'commands/gsd/plan-phase.md');
      gitAdd(dir, 'docs/how-to/example.md');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('0 violations'), `stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });
});
