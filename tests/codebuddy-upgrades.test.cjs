// docs-guard-exempt: codebuddy.ai/docs/... is an external URL citation in a comment, not a repo path.
'use strict';

/**
 * CodeBuddy capability UPGRADES — ADR-1239 / #2098 (EoS/codebuddy).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) plus a direct negotiation-contract check to prove the
 * two real upgrades CodeBuddy contributes as part of the EoS migration:
 *
 *   UPGRADE 1 — extended hook events: CodeBuddy's `extendedHookEvents` was
 *   previously `[]` (none of the 4 extended events were wired). This PR
 *   wires all four — `SubagentStop`/`Stop`/`PreCompact`/`SubagentStart` —
 *   into `extendedHookEvents` (mirrors qwen #2092 / kimi exactly — same 4
 *   events), so a live install registers all four as hooks in settings.json
 *   routed through gsd-context-monitor.js, giving CodeBuddy the
 *   subagent-lifecycle + stop/compact hooks it previously lacked.
 *
 *   UPGRADE 2 — dispatch.background: CodeBuddy's capability.json already
 *   declares `dispatch.background: true`, which legitimately EXCEEDS the
 *   `declarative-cli` profile baseline (`false`, per
 *   `PROFILE_BASELINES['declarative-cli']` in src/host-integration.cts).
 *   NO agent-file/frontmatter change is involved — the CodeBuddy CLI has no
 *   background-dispatch frontmatter field (agentMode/enabledAutoRun are
 *   IDE-only; verified via codebuddy.ai/docs/cli/sub-agents). This is
 *   surfaced purely through the negotiated contract: a documented `true`
 *   value must survive negotiation without a downgrade warning.
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

const CODEBUDDY_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'codebuddy', 'capability.json'), 'utf8'),
);
const CODEBUDDY_AXES = CODEBUDDY_CAP.runtime.hostIntegration;

// ---------------------------------------------------------------------------
// UPGRADE 1: extended hook events — all 4 newly-wired events' live-install coverage
// ---------------------------------------------------------------------------

test('capabilities/codebuddy/capability.json extendedHookEvents contains exactly the 4 documented events', () => {
  const events = CODEBUDDY_CAP.runtime.extendedHookEvents;
  assert.deepEqual(events, ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);
  assert.equal(events.length, 4);
});

test('codebuddy --global: settings.json wires all 4 newly-added extended hook events to the GSD context-monitor hook (UPGRADE 1)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'codebuddy', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // All 4 events were newly wired by this PR — codebuddy's extendedHookEvents
  // was previously [], so none of these existed before #2098.
  const NEWLY_WIRED_EXTENDED_EVENTS = ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart'];

  const entries = NEWLY_WIRED_EXTENDED_EVENTS.map((eventName) => {
    const eventHooks = settings.hooks && settings.hooks[eventName];
    assert.ok(Array.isArray(eventHooks) && eventHooks.length > 0,
      `settings.hooks.${eventName} must exist and be non-empty`);
    const entry = eventHooks[0].hooks[0];
    assert.ok(entry.command.includes('gsd-context-monitor'),
      `${eventName} command must reference gsd-context-monitor.js, got: ${entry.command}`);
    assert.equal(entry.timeout, 10, `${eventName} entry must have timeout 10`);
    return entry;
  });

  const [stopEntry, ...restEntries] = entries;
  for (const entry of restEntries) {
    assert.equal(entry.command, stopEntry.command,
      'all 4 newly-wired extended events must wire the same gsd-context-monitor command');
  }
});

test('a runtime whose extendedHookEvents omits SubagentStart does NOT get one (descriptor-gated, not a global default)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.ok(
    settings.hooks && Array.isArray(settings.hooks.SubagentStop) && settings.hooks.SubagentStop.length > 0,
    'claude must have SubagentStop wired (sanity — proves hooks ARE configured)',
  );
  assert.ok(
    !settings.hooks || settings.hooks.SubagentStart === undefined,
    "claude must NOT have SubagentStart wired — it is not in claude's extendedHookEvents",
  );
});

// ---------------------------------------------------------------------------
// UPGRADE 2: dispatch.background negotiation — documented true survives,
// exceeding the declarative-cli profile baseline. No agent-file/frontmatter
// change; caller-side invocation param only (no code path emits it).
// ---------------------------------------------------------------------------

test("codebuddy classifies as the 'declarative-cli' profile, whose baseline dispatch.background is false", () => {
  assert.equal(profileOf(CODEBUDDY_AXES), 'declarative-cli');
  assert.equal(PROFILE_BASELINES['declarative-cli'].dispatch.background, false,
    'sanity: the declarative-cli baseline is false — codebuddy legitimately exceeds it');
});

test('negotiateHostCapabilities surfaces codebuddy\'s documented dispatch.background:true with no downgrade warning (UPGRADE 2)', () => {
  assert.equal(CODEBUDDY_AXES.dispatch.background, true,
    'sanity: the descriptor declares dispatch.background: true (documented, not undocumented)');

  const { effective, warnings } = negotiateHostCapabilities(CODEBUDDY_AXES);

  assert.equal(effective.dispatch.background, true,
    'a documented true value must survive negotiation, exceeding the declarative-cli baseline of false');
  assert.ok(
    !warnings.some((w) => w.includes('dispatch.background')),
    `no warning may be raised for the documented dispatch.background axis, got: ${JSON.stringify(warnings)}`,
  );
});
