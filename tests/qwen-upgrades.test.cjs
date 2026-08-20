'use strict';

/**
 * qwen capability UPGRADES — ADR-1239 Phase D / #2092 (EoS/qwen).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) to prove the two real upgrades qwen contributes beyond
 * the hermes migration (#2091):
 *
 *   UPGRADE 1 — native `agents` artifact-layout kind: GSD specialist agents
 *   project into `<configDir>/agents/gsd-*.md` as native Qwen subagents
 *   (`name:`/`description:`/`tools:` YAML-block frontmatter — Qwen's own
 *   subagent schema, converted by `convertClaudeAgentToQwenAgent`).
 *
 *   UPGRADE 2 — `SubagentStart` hook: wired symmetrically with the existing
 *   `SubagentStop` hook (same command + timeout), and proven to be
 *   descriptor-gated — a runtime whose `extendedHookEvents` omits
 *   `SubagentStart` (e.g. claude) must NOT get the hook, even though it does
 *   get `SubagentStop`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

const QWEN_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'qwen', 'capability.json'), 'utf8'),
);

/** Extract the YAML frontmatter block (between the first pair of `---` lines), or null. */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// -- UPGRADE 1: native agents artifact-layout kind ---------------------------

for (const scope of ['global', 'local']) {
  test(`qwen --${scope}: native .qwen/agents/*.md subagent projection (UPGRADE 1)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'qwen', scope });
    t.after(() => cleanup(root));

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), `${agentsDir} must exist`);

    const expectedNames = listAgentFiles(); // dynamically derived source roster
    assert.equal(expectedNames.length, 35,
      'sanity: shipped GSD agent roster is 35 files — update this boundary if the roster changes');

    const installedFiles = fs.readdirSync(agentsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    // Boundary-safe: at least the full expected roster, AND every expected
    // name present by NAME (not just count) — a mis-copy that drops one
    // agent while adding a stray file would still satisfy a bare >= count.
    assert.ok(installedFiles.length >= expectedNames.length,
      `expected at least ${expectedNames.length} installed agents under ${agentsDir}, got ${installedFiles.length}`);
    for (const name of expectedNames) {
      assert.ok(installedFiles.includes(`${name}.md`), `${name}.md must be installed under ${agentsDir}`);
    }

    // A couple of named agents, explicitly, spanning both source frontmatter
    // styles (single-line `tools:` vs YAML block `tools:`) to exercise
    // parseFrontmatterTools' dual-format tolerance end to end.
    for (const known of ['gsd-code-reviewer', 'gsd-security-auditor', 'gsd-nyquist-auditor']) {
      const filePath = path.join(agentsDir, `${known}.md`);
      assert.ok(fs.existsSync(filePath), `${filePath} must exist`);

      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content);
      assert.ok(fm, `${known}.md must have YAML frontmatter — resolvable by Qwen's subagent loader`);

      assert.match(fm, /^name:\s*\S+/m, `${known}.md frontmatter must declare name:`);
      assert.match(fm, /^description:\s*\S/m, `${known}.md frontmatter must declare description:`);

      // tools:, when present, must be a YAML block list (Qwen's documented
      // schema — https://qwenlm.github.io/qwen-code-docs — not Claude's
      // single-line comma-separated string.
      if (/^tools:/m.test(fm)) {
        assert.match(fm, /^tools:\r?\n(?: {2}- .+\r?\n?)+/m,
          `${known}.md tools: must be emitted as a YAML block list`);
      }

      // color: is a documented Claude-Code-compatibility field in Qwen's
      // native subagent schema — it must be preserved, not dropped.
      assert.match(fm, /^color:\s*\S+/m, `${known}.md frontmatter must carry a preserved color: field`);

      // No branding residue from the Claude Code source.
      assert.ok(!content.includes('CLAUDE.md'), `${known}.md must not contain residual "CLAUDE.md"`);
      assert.ok(!content.includes('Claude Code'), `${known}.md must not contain residual "Claude Code"`);
      assert.ok(!content.includes('.claude/'), `${known}.md must not contain residual ".claude/"`);
    }
  });
}

// -- UPGRADE 2: SubagentStart hook fires symmetrically with SubagentStop ----

test('qwen --global: settings.json SubagentStart mirrors SubagentStop (UPGRADE 2)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'qwen', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const subagentStart = settings.hooks && settings.hooks.SubagentStart;
  const subagentStop = settings.hooks && settings.hooks.SubagentStop;
  assert.ok(Array.isArray(subagentStart) && subagentStart.length > 0,
    'settings.hooks.SubagentStart must exist and be non-empty');
  assert.ok(Array.isArray(subagentStop) && subagentStop.length > 0,
    'settings.hooks.SubagentStop must exist and be non-empty');

  const startEntry = subagentStart[0].hooks[0];
  const stopEntry = subagentStop[0].hooks[0];
  assert.equal(startEntry.command, stopEntry.command, 'SubagentStart must wire the same command as SubagentStop');
  assert.equal(startEntry.timeout, 10);
  assert.equal(stopEntry.timeout, 10);
});

test('a non-qwen runtime that does not declare SubagentStart does NOT get a SubagentStart hook (descriptor-gated, not global)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // claude DOES get SubagentStop (sanity — proves hooks are wired at all for
  // this runtime) but must NOT get SubagentStart — claude's
  // extendedHookEvents omits it, proving the loop extension is
  // descriptor-gated, not a global default applied to every runtime.
  assert.ok(
    settings.hooks && Array.isArray(settings.hooks.SubagentStop) && settings.hooks.SubagentStop.length > 0,
    'claude must have SubagentStop wired (sanity — proves hooks ARE configured)',
  );
  assert.ok(
    !settings.hooks || settings.hooks.SubagentStart === undefined,
    "claude must NOT have SubagentStart wired — it is not in claude's extendedHookEvents",
  );
});

// -- boundary/negative: extendedHookEvents is exactly the 4 documented events

test('capabilities/qwen/capability.json extendedHookEvents contains exactly the 4 documented events', () => {
  const events = QWEN_CAP.runtime.extendedHookEvents;
  assert.deepEqual(events, ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);
  assert.equal(events.length, 4);
});
