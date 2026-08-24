'use strict';

/**
 * #3664 — `--config-dir` aimed at a directory that is not a supported runtime's
 * config home must never be a SILENT success: the installer emits the selected
 * runtime's artifacts verbatim (Claude-only `Skill` tool IDs, `mcp__server__tool`
 * grants), which are inert or invalid in a foreign harness and only surface at
 * dispatch time. The fix warns-and-proceeds when the destination already holds
 * foreign (non-GSD) agent files — the fingerprint of another harness or a
 * hand-curated agents dir. Fresh custom dirs, gsd-only dirs (updates, the --all
 * shared dir), default-home installs, and test temp dirs stay silent.
 *
 * All rows are behavioral: real filesystem fixtures, the real layout resolver,
 * console.log observed via t.mock.method — no source reading. The end-to-end row
 * spawns the real installer under a hermetic HOME + GSD_TEST_MODE=1 + GSD_HOME
 * (the #3547 in-process-install sandbox pattern).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const installer = require('../bin/install.js');
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');

const INSTALLER_ENTRY = path.join(__dirname, '..', 'bin', 'install.js');

function capturedLogs(t, fn) {
  const lines = [];
  const mock = t.mock.method(console, 'log', (...args) => {
    lines.push(args.join(' '));
  });
  const result = fn();
  mock.mock.restore();
  return { lines, result };
}

function makeDest(t, name, agentFiles) {
  const dest = createTempDir(`gsd-3664-${name}-`);
  const agentsDir = path.join(dest, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const file of agentFiles) {
    fs.writeFileSync(path.join(agentsDir, file), '---\ntools: Read\n---\nbody\n');
  }
  t.after(() => cleanup(dest));
  return { dest, agentsDir };
}

describe('#3664 — config-dir foreign-agent destination warning', () => {
  test('warns when the destination holds foreign agent files', (t) => {
    const { dest } = makeDest(t, 'foreign', ['junie-guide.md']);
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: true }),
    );
    const warning = lines.find((l) => l.includes('(#3664)'));
    assert.ok(warning, `expected a #3664 warning, got: ${lines.join(' | ') || '(none)'}`);
    assert.ok(warning.includes('claude'), `warning must name the selected runtime: ${warning}`);
    assert.ok(
      /tool IDs and MCP grants may (be inert|not apply)/.test(warning),
      `warning must name the tool/MCP risk: ${warning}`,
    );
  });

  test('installer warns and proceeds on a foreign-agent destination', (t) => {
    const home = createTempDir('gsd-3664-e2e-home-');
    t.after(() => cleanup(home));
    const dest = createTempDir('gsd-3664-e2e-dest-');
    t.after(() => cleanup(dest));
    fs.mkdirSync(path.join(dest, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'agents', 'junie-guide.md'), '---\ntools: Read\n---\nbody\n');

    const result = runNode(
      [INSTALLER_ENTRY, '--claude', '--global', '--config-dir', dest],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          GSD_HOME: home,
          GSD_TEST_MODE: '1',
          CI: '1',
        },
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    assert.equal(result.exitCode, 0, `warn-and-proceed must exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    assert.ok(
      result.stdout.includes('(#3664)'),
      `stdout must carry the #3664 warning: ${result.stdout.slice(-800)}`,
    );
    const emitted = fs.existsSync(path.join(dest, 'agents'))
      ? fs.readdirSync(path.join(dest, 'agents')).filter((f) => /^gsd-.*\.md$/.test(f))
      : [];
    assert.ok(emitted.length > 0, 'install must still emit the gsd-* agents');
    // The foreign file survives — warn-and-proceed never touches it.
    assert.ok(fs.existsSync(path.join(dest, 'agents', 'junie-guide.md')));
  });

  test('silent on a fresh custom dir', (t) => {
    const { dest, agentsDir } = makeDest(t, 'fresh', []);
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: true }),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `fresh dir must be silent: ${lines.join(' | ')}`);
    assert.ok(fs.existsSync(agentsDir));
  });

  test('silent on a gsd-only agents dir', (t) => {
    const { dest } = makeDest(t, 'gsdonly', ['gsd-executor.md', 'gsd-verifier.md']);
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: true }),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `gsd-only dir must be silent: ${lines.join(' | ')}`);
  });

  test('silent when the config-dir flag was not passed', (t) => {
    // A default-home install with the user's personal agents present is the
    // NORMAL Claude case — the gate is scoped to the --config-dir flag.
    const { dest } = makeDest(t, 'noflag', ['personal-agent.md']);
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: false }),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `no-flag path must be silent: ${lines.join(' | ')}`);
  });

  test('warns on mixed gsd and personal agents', (t) => {
    const { dest } = makeDest(t, 'mixed', ['gsd-executor.md', 'my-own-agent.md']);
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: true }),
    );
    const warning = lines.find((l) => l.includes('(#3664)'));
    assert.ok(warning, 'mixed dir with a foreign agent must warn');
    assert.ok(warning.includes('1'), `warning reports the foreign count: ${warning}`);
  });

  test('ignores non-markdown files', (t) => {
    const { dest } = makeDest(t, 'nonmd', []);
    fs.writeFileSync(path.join(dest, 'agents', 'notes.txt'), 'not an agent');
    const scope = resolveScope({ id: 'global', runtime: 'claude' });
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('claude', dest, scope, { explicitConfigDir: true }),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `non-agent files are not harness evidence: ${lines.join(' | ')}`);
  });

  test('degrades silently when the layout cannot resolve', (t) => {
    const dest = createTempDir('gsd-3664-unknown-');
    t.after(() => cleanup(dest));
    const { lines } = capturedLogs(t, () =>
      installer.warnIfForeignAgentDest('not-a-registered-runtime', dest, null, { explicitConfigDir: true }),
    );
    assert.ok(
      !lines.some((l) => l.includes('(#3664)')),
      `unresolvable layout must degrade silently: ${lines.join(' | ')}`,
    );
  });
});
