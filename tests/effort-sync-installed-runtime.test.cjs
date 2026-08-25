'use strict';

/**
 * #2071 — `gsd-tools effort sync` crashed in an INSTALLED runtime because
 * commands.cjs did `require('../../../bin/install.js')`, but the installer only
 * copies the `gsd-core/` subtree into a runtime home — the package-root
 * `bin/install.js` is never present there, so the require threw MODULE_NOT_FOUND.
 *
 * This does a real minimal install into a temp home (the same helper the
 * golden-parity suite uses) and runs the exact repro from the issue against the
 * installed shim: `node <configDir>/gsd-core/bin/gsd-tools.cjs effort sync`. Pre-fix
 * this throws `Cannot find module '../../../bin/install.js'`; post-fix the
 * install-time resolvers live in the shipped sibling
 * `gsd-core/bin/lib/install-effort-resolver.cjs` and the require resolves.
 *
 * `--config-dir <temp>` keeps it hermetic (targets the temp install, never the
 * developer's real ~/.claude); effort sync defaults to dry-run so nothing is written.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

// Absolute path to the built module, spawned in a child process below so the
// JSON `cmdEffortSync` writes straight to fd 1 (via io.cjs's writeAllSync) can
// actually be captured — overriding process.stdout.write in-process does not
// intercept that write.
const COMMANDS_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'commands.cjs');

describe('#2071: effort sync runs in an installed runtime (no package-root bin/install.js)', () => {
  test('effort sync does not crash reaching for the un-shipped bin/install.js', () => {
    if (process.platform === 'win32') return; // install layout is POSIX-path-shaped

    const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
    try {
      // Installed layout invariant: the package-root installer is never copied in.
      assert.ok(!fs.existsSync(path.join(root, 'bin', 'install.js')), 'installed home must not contain bin/install.js');
      assert.ok(!fs.existsSync(path.join(configDir, 'bin', 'install.js')), 'no bin/install.js beside gsd-core');

      // A project effort config gives the sync something to resolve.
      fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.planning', 'config.json'),
        JSON.stringify({ effort: { default: 'high' } }),
      );

      const gsdTools = path.join(configDir, 'gsd-core', 'bin', 'gsd-tools.cjs');
      const result = runNode(
        [gsdTools, 'effort', 'sync', '--config-dir', configDir],
        { cwd: root, env: { ...process.env, HOME: root }, timeoutMs: 15000 },
      );
      const combined = `${result.stdout || ''}${result.stderr || ''}`;

      assert.doesNotMatch(
        combined,
        /Cannot find module[^\n]*install\.js|'\.\.\/\.\.\/\.\.\/bin\/install\.js'/,
        `effort sync must not reach for the un-shipped bin/install.js:\n${combined}`,
      );
      assert.doesNotMatch(
        combined,
        /MODULE_NOT_FOUND/,
        `effort sync must not crash on module resolution in an installed runtime:\n${combined}`,
      );
    } finally {
      cleanup(root);
    }
  });
});

// #3706 — OpenCode's `effort sync` path (cmdEffortSyncOpencode) maintains the
// `variant:` frontmatter key install bakes into `~/.config/opencode/agents/
// gsd-*.md`, mirroring the pre-existing claude/`effort:` and codex branches.
// Each case is run against a fresh sandbox: a project `cwd` (holding
// `.planning/config.json`), a `configDir` (holding `agents/`), and an
// isolated `home` (HOME env, so `~/.gsd/defaults.json` can never leak in from
// the real developer machine) — cmdEffortSync merges home defaults with the
// project config, so a hermetic test must control both sources.
describe('#3706: effort sync maintains OpenCode variant: frontmatter', () => {
  function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-effort-sync-opencode-'));
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'runtime-home');
    const agentsDir = path.join(configDir, 'agents');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    return { root, cwd, configDir, agentsDir, home };
  }

  function writeProjectEffortConfig(cwd, effort) {
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.planning', 'config.json'),
      JSON.stringify(effort === undefined ? {} : { effort }),
    );
  }

  function writeAgent(agentsDir, name, lines) {
    const filePath = path.join(agentsDir, name);
    fs.writeFileSync(filePath, lines.join('\n'));
    return filePath;
  }

  /**
   * Invokes `cmdEffortSync(cwd, false, opts)` in a CHILD process (required
   * per module — see COMMANDS_CJS comment above) and parses the JSON result
   * `output()` writes to fd 1. Callers that only need the on-disk effect of
   * the sync (most cases below) still go through this so the harness stays
   * single-shaped, but only cases 2 and 6 actually assert on the returned
   * `result`.
   */
  function runEffortSync({ cwd, home, configDir, runtime, dryRun }) {
    const opts = { dryRun, configDir, runtime };
    const script = [
      `const { cmdEffortSync } = require(${JSON.stringify(COMMANDS_CJS)});`,
      `cmdEffortSync(${JSON.stringify(cwd)}, false, ${JSON.stringify(opts)});`,
    ].join('\n');
    const spawned = runNode(['-e', script], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.strictEqual(
      spawned.exitCode, 0,
      `cmdEffortSync child process failed (outcome=${spawned.outcome}):\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
    );
    const jsonStart = spawned.stdout.indexOf('{');
    assert.notStrictEqual(jsonStart, -1, `expected JSON output on stdout, got:\n${spawned.stdout}`);
    return JSON.parse(spawned.stdout.slice(jsonStart));
  }

  test('writes the resolved variant into an agent that has none', () => {
    // Protects: cmdEffortSyncOpencode's happy-path write — a fresh agent
    // with no `variant:` key gets the resolved effort injected verbatim.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /^variant: xhigh$/m);
    } finally {
      cleanup(root);
    }
  });

  test('reports the change without writing under dry run', () => {
    // Protects: dry-run reports the pending change but leaves the file
    // byte-identical — no write happens until dryRun is explicitly false.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      const before = fs.readFileSync(filePath);
      const result = runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: true });
      const after = fs.readFileSync(filePath);
      assert.ok(before.equals(after), 'dry run must not touch the file on disk');
      assert.strictEqual(result.synced, 1);
      assert.deepStrictEqual(result.changes[0], { agent: 'gsd-executor', from: null, to: 'xhigh' });
    } finally {
      cleanup(root);
    }
  });

  test('an already-correct agent is skipped, not rewritten', () => {
    // Protects: an agent already carrying the resolved variant is reported
    // skipped and its bytes are left completely untouched (no rewrite churn).
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'high' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant: high', '---', '', 'Body.',
      ]);
      const before = fs.readFileSync(filePath);
      const result = runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const after = fs.readFileSync(filePath);
      assert.ok(before.equals(after), 'an in-sync agent must not be rewritten');
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.synced, 0);
    } finally {
      cleanup(root);
    }
  });

  test('inherit strips the key rather than writing it literally', () => {
    // #3533 (10d) — inherit means the key must not exist; writing
    // `variant: inherit` would name a variant that cannot resolve.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'inherit' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant: high', '---', '', 'Body.',
      ]);
      const result = runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(content, /^variant:/m);
      assert.match(content, /^name: gsd-executor$/m);
      assert.match(content, /^description: x$/m);
      assert.match(content, /^mode: subagent$/m);
      assert.deepStrictEqual(result.changes[0], { agent: 'gsd-executor', from: 'high', to: null });
    } finally {
      cleanup(root);
    }
  });

  test('no effort config at all strips a stale key', () => {
    // Matches what install bakes with no config: an agent that carries a
    // stale `variant:` key from a prior sync must lose it, not keep it.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, undefined);
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant: high', '---', '', 'Body.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(content, /^variant:/m);
    } finally {
      cleanup(root);
    }
  });

  test('a missing agents directory is reported, not thrown', () => {
    // Protects: an install with no agents/ subdir under configDir must
    // report the condition structurally, never throw out of cmdEffortSync.
    const { root, cwd, configDir, home } = makeSandbox();
    try {
      cleanup(path.join(configDir, 'agents'));
      const result = runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      assert.strictEqual(result.reason, 'agents directory not found');
    } finally {
      cleanup(root);
    }
  });

  test('files that are not gsd-*.md are ignored', () => {
    // Protects: the gsd-*.md filter — a non-gsd file sitting in agents/ must
    // never be synced or skipped, i.e. never even enter the loop.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      writeAgent(agentsDir, 'not-gsd.md', [
        '---', 'name: not-gsd', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      const result = runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      assert.strictEqual(result.synced, 0);
      assert.strictEqual(result.skipped, 0);
    } finally {
      cleanup(root);
    }
  });

  test('the document body is untouched', () => {
    // Protects: the frontmatter line-editors only ever touch the frontmatter
    // span — a body containing a colon, a `#`, and a `---` rule must survive
    // byte-identical past the closing frontmatter delimiter.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'max' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', '---', '',
        'Body with: colons #hash and a --- rule.', '', 'more.',
      ]);
      const before = fs.readFileSync(filePath, 'utf8');
      const beforeBody = before.slice(before.indexOf('---', 3) + 3);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const after = fs.readFileSync(filePath, 'utf8');
      const afterBody = after.slice(after.indexOf('---', 3) + 3);
      assert.strictEqual(afterBody, beforeBody);
      assert.match(after, /^variant: max$/m);
    } finally {
      cleanup(root);
    }
  });

  test('the claude path still writes effort:, not variant:', () => {
    // The frontmatter line-editors were key-parameterised for #3706; this is
    // the control that the pre-existing claude behavior did not move.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'claude', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /^effort: xhigh$/m);
      assert.doesNotMatch(content, /^variant:/m);
    } finally {
      cleanup(root);
    }
  });
});
