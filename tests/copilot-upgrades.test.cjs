'use strict';

/**
 * Copilot capability UPGRADES — ADR-1239 / #2099 (EoS/copilot).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) plus a direct negotiation-contract check to prove the
 * two real upgrades Copilot contributes as part of the EoS migration:
 *
 *   UPGRADE 1 — multi-event hook bus: buildCopilotHookConfig() previously
 *   emitted only `sessionStart`. This PR wires four additional events —
 *   `preToolUse`, `postToolUse`, `userPromptSubmitted`, `sessionEnd` — each a
 *   static, deterministic advisory command (no node-runner invocation), so a
 *   live install's hooks/gsd-session.json registers all five events.
 *
 *   UPGRADE 2 — dispatch.background: Copilot's capability.json already
 *   declares `dispatch.background: true`, which legitimately EXCEEDS the
 *   `declarative-cli` profile baseline (`false`, per
 *   `PROFILE_BASELINES['declarative-cli']` in src/host-integration.cts).
 *   NO agent-file/frontmatter change is involved — Copilot's .agent.md
 *   frontmatter has no background-dispatch field (fields are
 *   description/infer/mcp-servers/model/name/tools). This is surfaced
 *   purely through the negotiated contract: a documented `true` value must
 *   survive negotiation without a downgrade warning.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const COPILOT_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'copilot', 'capability.json'), 'utf8'),
);
const COPILOT_AXES = COPILOT_CAP.runtime.hostIntegration;

// ---------------------------------------------------------------------------
// UPGRADE 1: multi-event hook bus — all 4 newly-wired events' live-install
// coverage, on top of the pre-existing sessionStart.
// ---------------------------------------------------------------------------

const NEWLY_WIRED_EVENTS = ['preToolUse', 'postToolUse', 'userPromptSubmitted', 'sessionEnd'];
const ALL_EXPECTED_EVENTS = ['sessionStart', ...NEWLY_WIRED_EVENTS];

test('copilot --global: hooks/gsd-session.json wires sessionStart plus all 4 newly-added events (UPGRADE 1)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'copilot', scope: 'global' });
  t.after(() => cleanup(root));

  const hookPath = path.join(configDir, 'hooks', 'gsd-session.json');
  assert.ok(fs.existsSync(hookPath), `${hookPath} must exist`);
  const parsed = JSON.parse(fs.readFileSync(hookPath, 'utf8'));

  assert.strictEqual(parsed.version, 1, 'hook config version must be 1');
  assert.ok(parsed.hooks && typeof parsed.hooks === 'object', 'has hooks object');

  for (const eventName of ALL_EXPECTED_EVENTS) {
    const eventHooks = parsed.hooks[eventName];
    assert.ok(Array.isArray(eventHooks) && eventHooks.length > 0,
      `hooks.${eventName} must exist and be non-empty`);
    const entry = eventHooks[0];
    assert.strictEqual(entry.type, 'command', `${eventName} entry type must be 'command'`);
    assert.ok(typeof entry.bash === 'string' && entry.bash.length > 0,
      `${eventName} entry must have a non-empty inline bash body`);
    assert.ok(typeof entry.powershell === 'string' && entry.powershell.length > 0,
      `${eventName} entry must have a non-empty inline powershell body`);
    assert.strictEqual(entry.timeoutSec, 10, `${eventName} entry must use timeoutSec 10`);
  }
});

test('each newly-wired event emits a distinct static advisory (no shared boilerplate, no node-runner invocation)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'copilot', scope: 'global' });
  t.after(() => cleanup(root));

  const hookPath = path.join(configDir, 'hooks', 'gsd-session.json');
  const parsed = JSON.parse(fs.readFileSync(hookPath, 'utf8'));

  const bashBodies = new Set();
  for (const eventName of ALL_EXPECTED_EVENTS) {
    const entry = parsed.hooks[eventName][0];
    assert.ok(entry.bash.includes('"additionalContext"'),
      `${eventName} bash body must emit the additionalContext JSON envelope`);
    assert.ok(!/hooks\/gsd-[\w-]+\.(js|cjs|sh)/.test(entry.bash),
      `${eventName} bash body must not reference an external hook script (cannot dangle)`);
    bashBodies.add(entry.bash);
  }
  assert.strictEqual(bashBodies.size, ALL_EXPECTED_EVENTS.length,
    'each event must emit its own distinct advisory command, not a copy-pasted duplicate');
});

test('a runtime whose hook config omits the new events does NOT get them (descriptor-gated, not a global default)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));

  // Claude uses settings.json, not hooks/gsd-session.json — the Copilot
  // multi-event bus additions are self-contained to buildCopilotHookConfig
  // and must not leak into another runtime's hook surface.
  const copilotHookPath = path.join(configDir, 'hooks', 'gsd-session.json');
  assert.ok(!fs.existsSync(copilotHookPath),
    'claude must not have a Copilot-style hooks/gsd-session.json file');
});

// ---------------------------------------------------------------------------
// UPGRADE 2: dispatch.background negotiation — documented true survives,
// exceeding the declarative-cli profile baseline. No agent-file/frontmatter
// change; negotiated-contract only (Copilot .agent.md has no background field).
// ---------------------------------------------------------------------------

test("copilot classifies as the 'declarative-cli' profile, whose baseline dispatch.background is false", () => {
  assert.equal(profileOf(COPILOT_AXES), 'declarative-cli');
  assert.equal(PROFILE_BASELINES['declarative-cli'].dispatch.background, false,
    'sanity: the declarative-cli baseline is false — copilot legitimately exceeds it');
});

test('negotiateHostCapabilities surfaces copilot\'s documented dispatch.background:true with no downgrade warning (UPGRADE 2)', () => {
  assert.equal(COPILOT_AXES.dispatch.background, true,
    'sanity: the descriptor declares dispatch.background: true (documented, not undocumented)');

  const { effective, warnings } = negotiateHostCapabilities(COPILOT_AXES);

  assert.equal(effective.dispatch.background, true,
    'a documented true value must survive negotiation, exceeding the declarative-cli baseline of false');
  assert.ok(
    !warnings.some((w) => w.includes('dispatch.background')),
    `no warning may be raised for the documented dispatch.background axis, got: ${JSON.stringify(warnings)}`,
  );
});

test('copilot .agent.md frontmatter has no background-dispatch field (negotiated contract only, sanity)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'copilot', scope: 'global' });
  t.after(() => cleanup(root));

  const agentsDir = path.join(configDir, 'agents');
  const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.agent.md'));
  assert.ok(agentFiles.length > 0, 'at least one .agent.md must be installed');

  const sample = fs.readFileSync(path.join(agentsDir, agentFiles[0]), 'utf8');
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own installed agent .md frontmatter, fixed-size author-controlled content
  const frontmatterMatch = sample.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatterMatch, 'agent file must have a frontmatter block');
  assert.ok(!/^background:/m.test(frontmatterMatch[1]),
    'UPGRADE 2 must not add a background: frontmatter field — Copilot .agent.md has no such field');
});
