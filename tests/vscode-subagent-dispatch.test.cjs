'use strict';

/**
 * VS Code #runSubagent wiring test — #2103 UPGRADE 2.
 *
 * VS Code 1.105+ lets the primary chat agent invoke registered chat
 * participants / Language Model Tools as a nested agent turn via
 * `#runSubagent`, gated by the `chat.subagents.allowInvocationsFromSubagents`
 * setting (default off; nested depth max 5 when enabled — docs/agents/subagents.md,
 * release-notes/v1_105.md). There is no separate extension-side "subagent
 * contribution" registration API: VS Code's chat engine surfaces the already
 * -registered chat participant + languageModelTools directly. This extension's
 * own contribution is `registerSubagentDispatch` — availability detection
 * (fail-soft on older/Insiders-gated hosts) plus a belt-and-suspenders
 * maxDepth:5 ceiling (dispatchAsSubagent) that mirrors
 * capabilities/vscode/capability.json's hostIntegration.dispatch.maxDepth,
 * independent of whatever the host itself enforces.
 *
 * Mock vscode only — no real VS Code host in CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = require('../vscode/extension.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

function mockVscodeWithSubagentSupport(allow) {
  return {
    workspace: {
      getConfiguration(section) {
        return {
          get(key) {
            if (section === 'chat.subagents' && key === 'allowInvocationsFromSubagents') return allow;
            return undefined;
          },
        };
      },
    },
  };
}

test('registerSubagentDispatch reports maxDepth matching capabilities/vscode/capability.json (dispatch.maxDepth:5)', () => {
  const cap = require('../capabilities/vscode/capability.json');
  const wiring = extension.registerSubagentDispatch(mockVscodeWithSubagentSupport(true));
  assert.equal(wiring.maxDepth, cap.runtime.hostIntegration.dispatch.maxDepth,
    'the extension-side depth cap must mirror the descriptor-declared maxDepth');
  assert.equal(extension.GSD_MAX_SUBAGENT_DEPTH, cap.runtime.hostIntegration.dispatch.maxDepth);
});

test('registerSubagentDispatch: available:true when chat.subagents.allowInvocationsFromSubagents is configured', () => {
  const wiring = extension.registerSubagentDispatch(mockVscodeWithSubagentSupport(true));
  assert.equal(wiring.available, true);
  assert.equal(typeof wiring.dispatchAsSubagent, 'function');
});

test('registerSubagentDispatch: available:false (fail-soft, no throw) when the setting is absent (older/Insiders-gated VS Code)', () => {
  assert.doesNotThrow(() => {
    const wiring = extension.registerSubagentDispatch({});
    assert.equal(wiring.available, false);
  });
});

test('registerSubagentDispatch: available:false (fail-soft) when vscode.workspace.getConfiguration itself throws', () => {
  const throwingVscode = {
    workspace: { getConfiguration() { throw new Error('simulated host failure'); } },
  };
  assert.doesNotThrow(() => {
    const wiring = extension.registerSubagentDispatch(throwingVscode);
    assert.equal(wiring.available, false);
  });
});

test('REACHABILITY: a background-eligible dispatchAsSubagent call at depth 0 dispatches through the shared hub and returns REAL output', async () => {
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version
    // token) is COMPLETE scope for windowing (§7.1) — without this, a
    // bare temp dir has no ROADMAP.md at all (UNREADABLE) and `percent`
    // is withheld (null), breaking this reachability proxy.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const result = JSON.parse(await extension.dispatchAsSubagent({
      family: 'progress', subcommand: 'json', cwd: dir, depth: 0,
    }));
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.percent, 'number', 'the real progress command ran (engine reached)');
  } finally {
    cleanup(dir);
  }
});

// #2103 FIX (adversarial review, MINOR — boundary gap): the repo's own
// TESTING-STANDARDS mandate exercising limit-1/limit/limit+1 around a boundary.
// The maxDepth:5 ceiling previously covered only 5 (limit) and 6 (limit+1) —
// this completes the triple with depth 4 (limit-1).
test('dispatchAsSubagent enforces the maxDepth:5 ceiling — depth 4 (limit-1) still dispatches', async () => {
  const dir = createTempDir();
  try {
    const result = JSON.parse(await extension.dispatchAsSubagent({
      family: 'progress', subcommand: 'json', cwd: dir, depth: 4,
    }));
    assert.equal(result.ok, true, 'depth one below the ceiling must be allowed');
  } finally {
    cleanup(dir);
  }
});

test('dispatchAsSubagent enforces the maxDepth:5 ceiling — depth 5 (at limit) still dispatches', async () => {
  const dir = createTempDir();
  try {
    const result = JSON.parse(await extension.dispatchAsSubagent({
      family: 'progress', subcommand: 'json', cwd: dir, depth: 5,
    }));
    assert.equal(result.ok, true, 'depth exactly at the ceiling must still be allowed');
  } finally {
    cleanup(dir);
  }
});

test('dispatchAsSubagent enforces the maxDepth:5 ceiling — depth 6 (over limit) is refused, never throws', async () => {
  const result = JSON.parse(await extension.dispatchAsSubagent({
    family: 'progress', subcommand: 'json', depth: 6,
  }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /exceeds maxDepth/);
  assert.equal(result.code, null);
});

test('dispatchAsSubagent defaults depth to 0 when omitted (a direct, non-nested call is always allowed)', async () => {
  const dir = createTempDir();
  try {
    const result = JSON.parse(await extension.dispatchAsSubagent({ family: 'progress', subcommand: 'json', cwd: dir }));
    assert.equal(result.ok, true);
  } finally {
    cleanup(dir);
  }
});

// ── Web mode: #runSubagent availability detection is registered identically,
// but there is no dispatchAsSubagent on web (no engine dispatch at all — see
// browser.js's header comment). ─────────────────────────────────────────────
test('WEB MODE: browser.js detectSubagentSupport uses the same fail-soft availability contract', () => {
  const browser = require('../vscode/browser.js');
  assert.doesNotThrow(() => {
    const wiring = browser.detectSubagentSupport(mockVscodeWithSubagentSupport(true));
    assert.equal(wiring.available, true);
  });
  assert.doesNotThrow(() => {
    const wiring = browser.detectSubagentSupport({});
    assert.equal(wiring.available, false);
  });
});
