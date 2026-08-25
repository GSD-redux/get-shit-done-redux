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

  test('a synced agent keeps its original file mode', () => {
    // The tmp-file + rename publish does not preserve mode the way an
    // in-place writeFileSync would — cmdEffortSyncOpencode stat+chmods the
    // tmp file before the rename specifically to compensate. Mode bits are
    // not meaningful on Windows (no POSIX permission model), so skip there.
    if (process.platform === 'win32') return;
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      fs.chmodSync(filePath, 0o600);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /^variant: xhigh$/m, 'the sync must have actually rewritten the file');
      assert.strictEqual(
        fs.statSync(filePath).mode & 0o777, 0o600,
        'the published file must keep the original file mode',
      );
    } finally {
      cleanup(root);
    }
  });

  test('the temp file is never more permissive than the agent it replaces', () => {
    // A plain `writeFileSync(tmpPath, data)` creates the tmp file at the
    // default `0666 & ~umask`, then only tightens it afterward via chmod —
    // for a 0600 agent that briefly leaves its contents world-readable
    // inside agents/. Assert the mode is correct at CREATION, not just
    // after the later chmod, by monkeypatching fs.writeFileSync in the
    // child process to record the on-disk mode immediately after the real
    // write runs. Mode bits are not meaningful on Windows, so skip there.
    if (process.platform === 'win32') return;
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      fs.chmodSync(filePath, 0o600);

      const opts = { dryRun: false, configDir, runtime: 'opencode' };
      const script = [
        "const fs = require('node:fs');",
        'const captures = [];',
        'const originalWriteFileSync = fs.writeFileSync;',
        'fs.writeFileSync = function (targetPath, data, options) {',
        '  const result = originalWriteFileSync.call(fs, targetPath, data, options);',
        '  if (typeof targetPath === "string" && /\\.tmp\\.\\d+$/.test(targetPath)) {',
        '    captures.push({ options: options || null, modeAfterWrite: fs.statSync(targetPath).mode & 0o777 });',
        '  }',
        '  return result;',
        '};',
        `const { cmdEffortSync } = require(${JSON.stringify(COMMANDS_CJS)});`,
        `cmdEffortSync(${JSON.stringify(cwd)}, false, ${JSON.stringify(opts)});`,
        'process.stdout.write("###CAPTURE_START###" + JSON.stringify(captures) + "###CAPTURE_END###");',
      ].join('\n');
      const spawned = runNode(['-e', script], {
        cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.strictEqual(
        spawned.exitCode, 0,
        `capture child process failed (outcome=${spawned.outcome}):\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
      );
      const match = /###CAPTURE_START###([\s\S]*?)###CAPTURE_END###/.exec(spawned.stdout);
      assert.ok(match, `expected capture marker on stdout, got:\n${spawned.stdout}`);
      const captures = JSON.parse(match[1]);
      assert.strictEqual(captures.length, 1, `expected exactly one tmp-file write, got:\n${JSON.stringify(captures)}`);

      // The tmp file's mode immediately after creation must already match
      // the target agent's 0600, not the default 0644 a bare writeFileSync
      // would produce.
      assert.strictEqual(
        captures[0].modeAfterWrite, 0o600,
        'the tmp file must never be created more permissive than the agent it replaces',
      );

      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /^variant: xhigh$/m, 'the sync must have actually rewritten the file');
      assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600, 'the published file must keep the original file mode');
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

  test('a key present with an empty value is removed, not mistaken for absent', () => {
    // The value regex's `(.+?)` requires at least one character, so a bare
    // `variant:` line (zero-width value) used to read as "key absent" rather
    // than "key present, value empty" — presence and value are now distinct
    // questions, and a stale empty-valued key must still be stripped when no
    // effort config resolves one.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, undefined);
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant:', '---', '', 'Body.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(content, /^variant:/m);
    } finally {
      cleanup(root);
    }
  });

  test('a key present with a whitespace-only value is removed too (the spelling that always worked)', () => {
    // Trailing whitespace after the colon always matched the old regex (it is
    // not zero-width), so this spelling never exhibited the absent-vs-empty
    // bug above — pinned as the control that makes the bug look like a
    // whitespace lottery rather than a real presence/value distinction.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, undefined);
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant:   ', '---', '', 'Body.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(content, /^variant:/m);
    } finally {
      cleanup(root);
    }
  });

  test('CRLF agents keep their line endings through a write and a strip', () => {
    // Key-parameterising the frontmatter editors (claude's effort: vs
    // opencode's variant:) is exactly the kind of change that would regress
    // CRLF handling if the line ending were baked in per-key rather than
    // detected from the matched frontmatter block.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = path.join(agentsDir, 'gsd-executor.md');
      const beforeWrite = [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ].join('\r\n');
      fs.writeFileSync(filePath, beforeWrite);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const afterWrite = fs.readFileSync(filePath, 'utf8');
      assert.match(afterWrite, /^variant: xhigh\r$/m);
      assert.doesNotMatch(afterWrite, /(?<!\r)\n/, 'no lone LF must appear in a CRLF document');

      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'inherit' } });
      const beforeStrip = [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'variant: high', '---', '', 'Body.',
      ].join('\r\n');
      fs.writeFileSync(filePath, beforeStrip);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const afterStrip = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(afterStrip, /^variant:/m);
      assert.doesNotMatch(afterStrip, /(?<!\r)\n/, 'no lone LF must appear in a CRLF document');
    } finally {
      cleanup(root);
    }
  });

  test('a symlinked agent file is skipped, never followed', () => {
    // A symlinked gsd-*.md must never have its TARGET file rewritten — the
    // sync must skip it structurally (readdir's Dirent reports a symlink
    // entry as not-a-file), not follow it and edit whatever it points to.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      const targetPath = path.join(root, 'outside-target.md');
      const targetContent = [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ].join('\n');
      fs.writeFileSync(targetPath, targetContent);
      const linkPath = path.join(agentsDir, 'gsd-executor.md');
      try {
        fs.symlinkSync(targetPath, linkPath);
      } catch {
        return; // platform cannot create symlinks (e.g. unprivileged Windows) — skip
      }
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const after = fs.readFileSync(targetPath, 'utf8');
      assert.strictEqual(after, targetContent, 'the symlink target must be left untouched');
    } finally {
      cleanup(root);
    }
  });

  test('a body line starting with variant: is never the line edited', () => {
    // Scoping-by-content, not a whole-file /m replace: a body line that
    // happens to start with `variant:` must survive untouched while the
    // frontmatter gains its own key.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '',
        'variant: in-the-body', '', 'more.',
      ]);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('variant: in-the-body'), 'the body line must survive untouched');
      const fmEnd = content.indexOf('\n---', 4);
      assert.match(content.slice(0, fmEnd), /^variant: xhigh$/m, 'the frontmatter must gain its own variant: line');
    } finally {
      cleanup(root);
    }
  });

  test('a file with no frontmatter at all is skipped, not corrupted', () => {
    // No `---` fences at all: the sync must leave the file byte-identical
    // rather than guessing where a frontmatter block would go.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-executor': 'xhigh' } });
      const filePath = writeAgent(agentsDir, 'gsd-executor.md', [
        'Just a body, no frontmatter fences at all.',
      ]);
      const before = fs.readFileSync(filePath);
      runEffortSync({ cwd, home, configDir, runtime: 'opencode', dryRun: false });
      const after = fs.readFileSync(filePath);
      assert.ok(before.equals(after), 'a file with no frontmatter must be byte-identical afterward');
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

  test('a write failure on one agent is reported and does not stop the sweep', () => {
    // Protects: cmdEffortSyncOpencode's atomic tmp-write + rename can fail
    // mid-sync (fs fault). The failure must be reported per-agent in
    // write_failures, the remaining agents must still be processed, the
    // failing agent's file must be byte-unchanged, and cmdEffortSync must
    // never throw. Injected deterministically by monkeypatching
    // fs.writeFileSync inside the child script — per this repo's CLAUDE.md
    // §4, chmod-based injection is forbidden (root bypasses mode bits under
    // Docker/CI and it leaks resources).
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-broken': 'xhigh', 'gsd-executor': 'xhigh' } });
      const brokenPath = writeAgent(agentsDir, 'gsd-broken.md', [
        '---', 'name: gsd-broken', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      const okPath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      const brokenBefore = fs.readFileSync(brokenPath);

      const opts = { dryRun: false, configDir, runtime: 'opencode' };
      const script = [
        `const fs = require('node:fs');`,
        `const originalWriteFileSync = fs.writeFileSync;`,
        // The tmp-write + rename publish (cmdEffortSyncOpencode) writes to
        // `<filePath>.tmp.<pid>` before renaming over the real path — throw
        // only for that one agent's tmp file, so every other write (and any
        // fs machinery the require chain itself performs) passes through
        // unmodified.
        `fs.writeFileSync = function (targetPath, ...rest) {`,
        `  if (typeof targetPath === 'string' && targetPath.includes('gsd-broken.md.tmp.')) {`,
        `    throw new Error('injected write failure');`,
        `  }`,
        `  return originalWriteFileSync.call(fs, targetPath, ...rest);`,
        `};`,
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
      const result = JSON.parse(spawned.stdout.slice(jsonStart));

      assert.strictEqual(result.write_failures.length, 1);
      assert.strictEqual(result.write_failures[0].agent, 'gsd-broken');

      const brokenAfter = fs.readFileSync(brokenPath);
      assert.ok(brokenBefore.equals(brokenAfter), 'the failing agent file must be byte-unchanged');

      const okContent = fs.readFileSync(okPath, 'utf8');
      assert.match(okContent, /^variant: xhigh$/m, 'the sweep must continue past the failing agent');
    } finally {
      cleanup(root);
    }
  });

  test('an unreadable agent file is reported and does not abort the sweep', () => {
    // Protects: cmdEffortSyncOpencode's fs.readFileSync used to sit outside
    // any try, so a single unreadable agent file threw and aborted the
    // entire sweep, unlike the write path in the same loop which degrades
    // into write_failures. Injected deterministically by monkeypatching
    // fs.readFileSync inside the child script — per this repo's CLAUDE.md
    // §4, chmod-based injection is forbidden (root bypasses mode bits under
    // Docker/CI and it leaks resources).
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, { agent_overrides: { 'gsd-unreadable': 'xhigh', 'gsd-executor': 'xhigh' } });
      writeAgent(agentsDir, 'gsd-unreadable.md', [
        '---', 'name: gsd-unreadable', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);
      const okPath = writeAgent(agentsDir, 'gsd-executor.md', [
        '---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.',
      ]);

      const opts = { dryRun: false, configDir, runtime: 'opencode' };
      const script = [
        `const fs = require('node:fs');`,
        `const originalReadFileSync = fs.readFileSync;`,
        `fs.readFileSync = function (targetPath, ...rest) {`,
        `  if (typeof targetPath === 'string' && targetPath.includes('gsd-unreadable.md')) {`,
        `    throw new Error('injected read failure');`,
        `  }`,
        `  return originalReadFileSync.call(fs, targetPath, ...rest);`,
        `};`,
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
      const result = JSON.parse(spawned.stdout.slice(jsonStart));

      assert.strictEqual(result.read_failures.length, 1);
      assert.strictEqual(result.read_failures[0].agent, 'gsd-unreadable');

      const okContent = fs.readFileSync(okPath, 'utf8');
      assert.match(okContent, /^variant: xhigh$/m, 'the sweep must continue past the unreadable agent');
    } finally {
      cleanup(root);
    }
  });
});

// ADR-2313 D7 (#3243) — the Codex branch (cmdEffortSyncCodex) strips a stale
// Anthropic-flavored `model` pin (and its coupled `model_reasoning_effort`)
// from every installed `~/.codex/agents/<agent>.toml`, publishing via the same
// tmp-file + chmod + retryRenameSync discipline as the OpenCode branch above.
describe('#3243: effort sync strips Anthropic-flavored model pins from Codex agents', () => {
  function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-effort-sync-codex-'));
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'runtime-home');
    const agentsDir = path.join(configDir, 'agents');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    return { root, cwd, configDir, agentsDir, home };
  }

  function writeAgent(agentsDir, name, lines) {
    const filePath = path.join(agentsDir, name);
    fs.writeFileSync(filePath, lines.join('\n'));
    return filePath;
  }

  test('a synced codex agent keeps its original file mode', () => {
    // The tmp-file + rename publish does not preserve mode the way an
    // in-place writeFileSync would — cmdEffortSyncCodex stat+chmods the tmp
    // file before the rename specifically to compensate, same discipline as
    // the OpenCode branch. Mode bits are not meaningful on Windows, so skip
    // there. The reachable rewrite path is the Anthropic-model-strip: a
    // `.toml` agent carrying an Anthropic-flavored `model` value.
    if (process.platform === 'win32') return;
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      const before = ['model = "claude-sonnet-4"', 'model_reasoning_effort = "high"', ''].join('\n');
      const filePath = writeAgent(agentsDir, 'gsd-executor.toml', [before]);
      fs.chmodSync(filePath, 0o600);

      const opts = { dryRun: false, configDir, runtime: 'codex' };
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

      const after = fs.readFileSync(filePath, 'utf8');
      assert.notStrictEqual(after, before, 'the sync must have actually rewritten the file');
      assert.doesNotMatch(after, /claude/i, 'the Anthropic-flavored model pin must have been stripped');
      assert.strictEqual(
        fs.statSync(filePath).mode & 0o777, 0o600,
        'the published file must keep the original file mode',
      );
    } finally {
      cleanup(root);
    }
  });
});

// #3706 — setFrontmatterKeyLine / removeFrontmatterKeyLine are not exported
// directly; they are reached through the exported cmdEffortSync (claude
// runtime, `effort:` key), the only public entry point that exercises them.
describe('#3706: frontmatter line editors are scoped to the matched block', () => {
  function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-effort-sync-fm-scope-'));
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'runtime-home');
    const agentsDir = path.join(configDir, 'agents');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    return { root, cwd, configDir, agentsDir, home };
  }

  function writeProjectEffortConfig(cwd, override) {
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.planning', 'config.json'),
      JSON.stringify({ effort: { agent_overrides: { 'gsd-executor': override } } }),
    );
  }

  function runEffortSync({ cwd, home, configDir }) {
    const opts = { dryRun: false, configDir, runtime: 'claude' };
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
  }

  test('a CRLF document with a preamble keeps its opening fence intact', () => {
    // Pre-fix: openLen was derived from `/^---\r\n/.test(content)` (start of
    // file, which here is "Preamble line", not CRLF) rather than from the
    // matched frontmatter block, so the CRLF fence misaligned by one byte.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, 'inherit');
      const filePath = path.join(agentsDir, 'gsd-executor.md');
      const before = 'Preamble line\r\n\r\n---\r\nname: x\r\neffort: high\r\n---\r\n\r\nBody.\r\n';
      fs.writeFileSync(filePath, before);
      runEffortSync({ cwd, home, configDir });
      const after = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(after, 'Preamble line\r\n\r\n---\r\nname: x\r\n---\r\n\r\nBody.\r\n');
      assert.ok(after.includes('---\r\nname: x\r\n'), 'the CRLF opening fence must survive intact');
      assert.ok(after.startsWith('Preamble line\r\n\r\n'), 'preamble must survive untouched');
      assert.ok(after.endsWith('\r\n\r\nBody.\r\n'), 'body must survive untouched');
      assert.doesNotMatch(after, /^-{1,2}\r?\n/m, 'no truncated/stray fence');
    } finally {
      cleanup(root);
    }
  });

  test('a preamble line starting with the key is not the line rewritten', () => {
    // Pre-fix: `content.replace(keyLineRe, ...)` was a whole-file /m replace
    // gated only on the key being present in fmBody, so the FIRST matching
    // line in the whole file (the preamble) was rewritten instead of the
    // frontmatter line.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, 'xhigh');
      const filePath = path.join(agentsDir, 'gsd-executor.md');
      const before = 'effort: not-the-frontmatter\n\n---\nname: x\neffort: high\n---\n\nBody.\n';
      fs.writeFileSync(filePath, before);
      runEffortSync({ cwd, home, configDir });
      const after = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(after, 'effort: not-the-frontmatter\n\n---\nname: x\neffort: xhigh\n---\n\nBody.\n');
      // Bytes-based scoping (not a whole-file regex): the preamble line must
      // precede the first `---` fence, and only the line AFTER that fence may
      // read `effort: xhigh`.
      const firstFence = after.indexOf('---');
      assert.ok(after.slice(0, firstFence).includes('effort: not-the-frontmatter'), 'preamble line must be untouched');
      assert.ok(after.slice(firstFence).includes('effort: xhigh'), 'frontmatter line must carry the new value');
    } finally {
      cleanup(root);
    }
  });

  test('a document whose frontmatter starts at byte 0 is byte-identical to before', () => {
    // No-regression control: a normal install-written agent (frontmatter at
    // byte 0, LF) must see only the one targeted line change, nothing else.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, 'xhigh');
      const filePath = path.join(agentsDir, 'gsd-executor.md');
      const before = ['---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.'].join('\n');
      fs.writeFileSync(filePath, before);
      runEffortSync({ cwd, home, configDir });
      const afterSet = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(
        afterSet,
        ['---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'effort: xhigh', '---', '', 'Body.'].join('\n'),
      );

      writeProjectEffortConfig(cwd, 'inherit');
      const beforeRemove = ['---', 'name: gsd-executor', 'description: x', 'mode: subagent', 'effort: high', '---', '', 'Body.'].join('\n');
      fs.writeFileSync(filePath, beforeRemove);
      runEffortSync({ cwd, home, configDir });
      const afterRemove = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(
        afterRemove,
        ['---', 'name: gsd-executor', 'description: x', 'mode: subagent', '---', '', 'Body.'].join('\n'),
      );
    } finally {
      cleanup(root);
    }
  });

  test('a duplicated key converges to one occurrence on a single set', () => {
    // Protects: setFrontmatterKeyLine used to rewrite only the FIRST
    // occurrence of a duplicated key, leaving a stale second occurrence in
    // place. A last-wins YAML reader would then honour the stale value while
    // this function's own first-occurrence read reports "in sync" — a
    // permanently non-converging state. One run must collapse a duplicated
    // key to exactly one occurrence, carrying the new value, in the position
    // of the FIRST occurrence.
    const { root, cwd, configDir, agentsDir, home } = makeSandbox();
    try {
      writeProjectEffortConfig(cwd, 'xhigh');
      const filePath = path.join(agentsDir, 'gsd-executor.md');
      const before = [
        '---', 'name: gsd-executor', 'effort: low', 'description: x', 'effort: high', '---', '', 'Body.',
      ].join('\n');
      fs.writeFileSync(filePath, before);
      runEffortSync({ cwd, home, configDir });
      const after = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(
        after,
        ['---', 'name: gsd-executor', 'effort: xhigh', 'description: x', '---', '', 'Body.'].join('\n'),
        'exactly one effort: line must remain, at the position of the first occurrence, carrying the resolved value',
      );
      const occurrences = after.match(/^effort:/gm) || [];
      assert.strictEqual(occurrences.length, 1, 'exactly one effort: line must remain');
    } finally {
      cleanup(root);
    }
  });
});
