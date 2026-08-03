'use strict';

/**
 * kimi capability UPGRADES — ADR-1239 Phase D / #2095 (EoS/kimi).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) plus targeted unit coverage to prove the two real
 * upgrades kimi contributes as part of the imperative-adapter migration:
 *
 *   UPGRADE 1 — native hook bus: `hooksSurface` moved from `"none"` to
 *   `"kimi-hooks-toml"`. GSD's lifecycle hook scripts (session-state,
 *   phase-boundary, graphify, context monitor, the prompt/read/workflow/
 *   worktree guards, commit validation) are now registered as `[[hooks]]`
 *   array-of-tables entries inside Kimi's own native config.toml (default
 *   `~/.kimi/config.toml`, overridable via Kimi's `KIMI_SHARE_DIR`), wrapped
 *   in `# GSD Hooks BEGIN`/`END` marker comments so a reinstall only ever
 *   rewrites GSD's own block (idempotency contract). `hooks/`, `hooks/lib/`,
 *   and the CommonJS `package.json` marker now also install for kimi — but
 *   SELF-CONTAINED under `~/.kimi/` (alongside config.toml), never under the
 *   generic Agent-Skills configDir GSD installs skills/agents into. Kimi's
 *   contract forbids hooks/ or package.json under that generic root (see
 *   capabilities/kimi/capability.json hostBehaviors.skipSharedHooksInstall,
 *   and tests/kimi-imperative-reference.test.cjs's source-grep guard).
 *
 *   Kimi's local install is intentionally deferred (Phase 2): `--kimi
 *   --local` exits 0 and writes nothing (`hostBehaviors.localInstallDeferred:
 *   true`, verified by manual spawn during authoring — see PR description).
 *   This file therefore only exercises `--global`.
 *
 *   UPGRADE 2 — background dispatch: `hostIntegration.dispatch.backgroundDispatch`
 *   flipped `false` → `true` (Kimi's `Agent` tool takes a call-time
 *   `run_in_background` param), which flips `shouldFlattenDispatch` to
 *   `false` for kimi — a negotiation-only axis with no install-output effect.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runMinimalInstall, INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  negotiateHostCapabilities,
  shouldFlattenDispatch,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const {
  stripKimiHooksTomlBlock,
  writeKimiHooksToml,
  removeKimiHooksToml,
  KIMI_HOOKS_TOML_MARKER_BEGIN,
  KIMI_HOOKS_TOML_MARKER_END,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const KIMI_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'kimi', 'capability.json'), 'utf8'),
);

// ---------------------------------------------------------------------------
// UPGRADE 1: native hook bus (~/.kimi/config.toml [[hooks]])
// ---------------------------------------------------------------------------

test('kimi --global: native config.toml [[hooks]] bus wired at <HOME>/.kimi/config.toml (UPGRADE 1)', (t) => {
  const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
  t.after(() => cleanup(root));

  // FACTS: root === sandbox HOME for this helper (env HOME/USERPROFILE are
  // both pointed at `root`), and Kimi's native hook config is a sibling of
  // the generic-agents-root GSD installs skills/agents into: <HOME>/.kimi/config.toml.
  const tomlPath = path.join(root, '.kimi', 'config.toml');
  assert.ok(fs.existsSync(tomlPath), `${tomlPath} must exist`);

  const toml = fs.readFileSync(tomlPath, 'utf8');

  // Idempotency contract: GSD's block is delimited by these exact markers so
  // a reinstall can strip-and-rewrite only its own content.
  assert.match(toml, /^# GSD Hooks BEGIN — managed by GSD, do not edit between these markers$/m,
    'config.toml must carry the GSD Hooks BEGIN marker');
  assert.match(toml, /^# GSD Hooks END$/m,
    'config.toml must carry the GSD Hooks END marker');

  const beginIdx = toml.indexOf('# GSD Hooks BEGIN');
  const endIdx = toml.indexOf('# GSD Hooks END');
  assert.ok(beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx,
    'both markers must be present and correctly ordered');
  const managedBlock = toml.slice(beginIdx, endIdx);

  // Minimal TOML parse-check: an array-of-tables ([[hooks]]), each with an
  // event key — not a single [hooks] table.
  const hooksTables = managedBlock.match(/^\[\[hooks\]\]$/gm) || [];
  assert.ok(hooksTables.length > 0, 'the managed block must contain at least one [[hooks]] array-of-tables entry');
  const eventLines = managedBlock.match(/^event = ".+"$/gm) || [];
  assert.equal(eventLines.length, hooksTables.length,
    'every [[hooks]] table must declare an event key (array-of-tables shape, not a bare [hooks] map)');

  // A SessionStart [[hooks]] entry must exist inside the markers.
  assert.match(managedBlock, /\[\[hooks\]\]\nevent = "SessionStart"/,
    'a [[hooks]] block with event = "SessionStart" must be inside the GSD markers');

  // At least one hook command references an installed hook script path.
  assert.match(managedBlock, /command = ".*gsd-check-update\.js.*"/,
    'a hook command must reference the installed gsd-check-update.js script');

  // The hooks/ scripts themselves are installed under Kimi's OWN native hook
  // root (~/.kimi/hooks) — NOT under the generic Agent-Skills configDir
  // (targetDir) GSD installs skills/agents into. Kimi's contract forbids
  // hooks/ or package.json under that generic root (capabilities/kimi/
  // capability.json declares hostBehaviors.skipSharedHooksInstall:true), so
  // the shared hook bundle is self-contained alongside config.toml instead.
  const hooksDir = path.join(root, '.kimi', 'hooks');
  assert.ok(fs.existsSync(path.join(hooksDir, 'gsd-check-update.js')),
    'hooks/gsd-check-update.js must be installed under ~/.kimi/hooks — the command above references it by path');
  assert.ok(fs.existsSync(path.join(hooksDir, 'lib')),
    'hooks/lib/ helpers must also install for kimi, under ~/.kimi/hooks/lib');
  assert.ok(!fs.existsSync(path.join(root, 'hooks')),
    'hooks/ must NOT be installed under the generic Agent-Skills configDir for kimi');
  assert.ok(!fs.existsSync(path.join(root, 'package.json')),
    'package.json (CommonJS marker) must NOT be installed under the generic Agent-Skills configDir for kimi');
  // #2544: the marker moved INSIDE hooks/ — the directory GSD itself creates
  // and fills — so kimi's own config home (~/.kimi) is never written to. The
  // pre-#2544 root marker is retired by uninstall; a fresh install writes none.
  assert.ok(fs.existsSync(path.join(hooksDir, 'package.json')),
    'package.json (CommonJS marker) must be installed inside ~/.kimi/hooks — the GSD-owned dir (#2544)');
  assert.ok(!fs.existsSync(path.join(root, '.kimi', 'package.json')),
    'package.json (CommonJS marker) must NOT be written at ~/.kimi root — kimi\'s config home is not GSD territory (#2544)');
});

test('kimi --global: reinstalling is idempotent — the GSD [[hooks]] block is not duplicated', (t) => {
  const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
  t.after(() => cleanup(root));

  const tomlPath = path.join(root, '.kimi', 'config.toml');
  const first = fs.readFileSync(tomlPath, 'utf8');

  const beginMarkers = (content) => (content.match(/# GSD Hooks BEGIN/g) || []).length;
  const endMarkers = (content) => (content.match(/# GSD Hooks END/g) || []).length;
  assert.equal(beginMarkers(first), 1, 'exactly one BEGIN marker after a fresh install');
  assert.equal(endMarkers(first), 1, 'exactly one END marker after a fresh install');

  // Reinstall over the SAME root/config (runMinimalInstall always mkdtemps a
  // fresh root, so the reinstall is driven directly against this test's root
  // exactly the way runMinimalInstall drives its own install internally).
  const reinstall = spawnSync(process.execPath, [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', root], {
    cwd: process.cwd(), encoding: 'utf8',
    env: installerEnv({ HOME: root, USERPROFILE: root }),
  });
  assert.strictEqual(reinstall.status, 0,
    `reinstall exited with status ${reinstall.status}\nstdout: ${reinstall.stdout}\nstderr: ${reinstall.stderr}`);
  const second = fs.readFileSync(tomlPath, 'utf8');
  assert.equal(beginMarkers(second), 1, 'reinstall must not duplicate the BEGIN marker');
  assert.equal(endMarkers(second), 1, 'reinstall must not duplicate the END marker');
});

// ---------------------------------------------------------------------------
// Code-review regression: stripKimiHooksTomlBlock must never glue two user
// TOML sections together when the GSD block sits between them, and must
// never delete to EOF when the marker pair is malformed (BEGIN without a
// matching END). Exercised directly against the exported pure function
// (unit-level) and via writeKimiHooksToml/removeKimiHooksToml (the real
// install/uninstall callers), so both the read seam and both call sites are
// covered.
// ---------------------------------------------------------------------------

function gsdHooksBlock(entry = '[[hooks]]\nevent = "SessionStart"\ncommand = "x"') {
  return `${KIMI_HOOKS_TOML_MARKER_BEGIN}\n\n${entry}\n\n${KIMI_HOOKS_TOML_MARKER_END}`;
}

describe('stripKimiHooksTomlBlock (code-review regression)', () => {
  test('block at EOF is stripped cleanly (existing idempotent case still works)', () => {
    const input = `[providers]\nx = 1\n\n${gsdHooksBlock()}\n`;
    const result = stripKimiHooksTomlBlock(input);
    assert.equal(result, '[providers]\nx = 1');
  });

  test('block BETWEEN two user sections is stripped WITHOUT gluing the sections together', () => {
    const input = `[providers]\nx = 1\n\n${gsdHooksBlock()}\n\n[models]\ny = 2\n`;
    const result = stripKimiHooksTomlBlock(input);
    assert.equal(result, '[providers]\nx = 1\n\n[models]\ny = 2\n');
    assert.doesNotMatch(result, /x = 1\[models\]/, 'the two user sections must not be glued onto one line');
  });

  test('block at START with user content after is stripped without a stray leading blank line', () => {
    const input = `${gsdHooksBlock()}\n\n[models]\ny = 2\n`;
    const result = stripKimiHooksTomlBlock(input);
    assert.equal(result, '[models]\ny = 2\n');
  });

  test('BEGIN present but END missing leaves content UNCHANGED (never deletes to EOF)', () => {
    const input = `[providers]\nx = 1\n\n${KIMI_HOOKS_TOML_MARKER_BEGIN}\n\n[[hooks]]\nevent = "SessionStart"\n\n[models]\ny = 2\n`;
    const result = stripKimiHooksTomlBlock(input);
    assert.equal(result, input, 'a malformed marker pair (no END) must be a no-op, not a deletion to EOF');
  });

  test('no markers at all is a no-op', () => {
    const input = '[providers]\nx = 1\n\n[models]\ny = 2\n';
    const result = stripKimiHooksTomlBlock(input);
    assert.equal(result, input);
  });
});

describe('writeKimiHooksToml / removeKimiHooksToml (code-review regression: surrounding user content)', () => {
  function makeHooksDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hooksdir-'));
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'gsd-check-update.js'), '// stub');
    return dir;
  }

  test('reinstall over a config.toml with user sections BEFORE and AFTER the GSD block preserves both, un-glued', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-toml-'));
    t.after(() => cleanup(tmp));
    const configPath = path.join(tmp, 'config.toml');
    fs.writeFileSync(configPath, '[providers]\nx = 1\n\n[models]\ny = 2\n');
    const hooksDir = makeHooksDir(t);
    const hookOpts = { platform: 'linux', node: 'node', bash: '/bin/bash' };

    writeKimiHooksToml(configPath, hooksDir, { hookOpts });
    // Re-seed a user section AFTER the newly-written GSD block, mirroring a
    // hand-edited config.toml, then reinstall on top of it.
    fs.appendFileSync(configPath, '\n[extra]\nz = 3\n');
    writeKimiHooksToml(configPath, hooksDir, { hookOpts });

    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(content, /\[providers\]\s*\nx = 1/, 'the earlier [providers] section must survive');
    assert.match(content, /\[extra\]\s*\nz = 3/, 'the later [extra] section must survive');
    assert.doesNotMatch(content, /GSD Hooks END\s*\[extra\]/, 'GSD Hooks END must not glue directly onto [extra]');
  });

  test('uninstall (removeKimiHooksToml) with user content on both sides of the block preserves it, un-glued', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-toml-remove-'));
    t.after(() => cleanup(tmp));
    const configPath = path.join(tmp, 'config.toml');
    const block = gsdHooksBlock();
    fs.writeFileSync(configPath, `[providers]\nx = 1\n\n${block}\n\n[models]\ny = 2\n`);

    const result = removeKimiHooksToml(configPath);
    assert.equal(result.changed, true);
    const content = fs.readFileSync(configPath, 'utf8');
    assert.equal(content, '[providers]\nx = 1\n\n[models]\ny = 2\n');
  });
});

// ---------------------------------------------------------------------------
// UPGRADE 2: background dispatch (backgroundDispatch: false -> true)
// ---------------------------------------------------------------------------

test('UPGRADE 2: capabilities/kimi/capability.json declares dispatch.background && dispatch.backgroundDispatch as true', () => {
  const d = KIMI_CAP.runtime.hostIntegration.dispatch;
  assert.equal(d.background, true);
  assert.equal(d.backgroundDispatch, true);
});

test('UPGRADE 2: negotiateHostCapabilities against kimi axes yields effective.dispatch.backgroundDispatch === true, and shouldFlattenDispatch is false (background now allowed)', () => {
  const KIMI_AXES = KIMI_CAP.runtime.hostIntegration;
  const { effective } = negotiateHostCapabilities(KIMI_AXES);
  assert.equal(effective.dispatch.backgroundDispatch, true);
  assert.equal(shouldFlattenDispatch(effective.dispatch), false,
    'kimi may now background — dispatch must not be flattened to inline');
});

test('UPGRADE 2: a corrupted/undeclared dispatch still fails closed to inline (shouldFlattenDispatch === true)', () => {
  assert.equal(shouldFlattenDispatch(null), true, 'null dispatch must flatten (fail-closed)');
  assert.equal(shouldFlattenDispatch(undefined), true, 'undefined dispatch must flatten (fail-closed)');
  assert.equal(shouldFlattenDispatch({ background: true, backgroundDispatch: 'undocumented' }), true,
    'a non-boolean-true backgroundDispatch must still flatten');
});

// Code-review AC4 follow-up: negotiating backgroundDispatch=true is necessary
// but not sufficient — Kimi's run_in_background dispatch (moonshotai.github.io
// /kimi-cli/en/customization/agents.html) is only reachable through a root
// agent whose YAML `tools:` list actually grants kimi_cli.tools.agent:Agent.
// This is the installer-testable proxy for UPGRADE 2: a real `--kimi --global`
// install (which generates subagents from GSD's own agents/ dir) must emit
// that tool grant on the root agent. Exercising the actual run_in_background
// call is Kimi's own runtime behavior, out of the installer's test scope (see
// docs/reference/host-integration-capability-matrix.md's kimi EoS-status
// paragraph) — the installer's deliverable stops at the Agent-tool grant plus
// the negotiated backgroundDispatch axis asserted above.
test('UPGRADE 2 (installer-testable proxy): kimi --global install with subagents present grants kimi_cli.tools.agent:Agent on the root agent', (t) => {
  const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
  t.after(() => cleanup(root));

  const rootYamlPath = path.join(root, 'agents', 'gsd.yaml');
  assert.ok(fs.existsSync(rootYamlPath), 'kimi: agents/gsd.yaml must exist');
  const rootYaml = fs.readFileSync(rootYamlPath, 'utf8');

  // Sanity: subagents must actually be present, otherwise this assertion
  // would prove nothing about the background-dispatch grant.
  assert.match(rootYaml, /^\s*subagents:\s*$/m,
    'a real kimi install must generate at least one subagent for this proxy to be meaningful');
  assert.match(rootYaml, /kimi_cli\.tools\.agent:Agent/,
    'root agent YAML must grant kimi_cli.tools.agent:Agent — the tool grant that enables run_in_background dispatch');
});

// ---------------------------------------------------------------------------
// Boundary: extendedHookEvents is exactly the 4 documented events, and each
// one is a real, wired Kimi event — not merely declared in capability.json.
// ---------------------------------------------------------------------------

test('capabilities/kimi/capability.json extendedHookEvents contains exactly the 4 documented events', () => {
  const events = KIMI_CAP.runtime.extendedHookEvents;
  assert.deepEqual(events, ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);
  assert.equal(events.length, 4);
});

test('boundary: every capability-declared extendedHookEvent is wired as a real event = "..." entry in config.toml, not merely declared', (t) => {
  const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
  t.after(() => cleanup(root));

  const tomlPath = path.join(root, '.kimi', 'config.toml');
  const toml = fs.readFileSync(tomlPath, 'utf8');

  for (const event of KIMI_CAP.runtime.extendedHookEvents) {
    assert.match(toml, new RegExp(`event = "${event}"`),
      `${event} must be wired as an actual [[hooks]] entry, not merely declared in capability.json`);
  }
  // Sanity: the base (non-extended) claude-dialect events are also wired,
  // since kimi's hookEvents dialect is "claude" (SessionStart/PreToolUse/PostToolUse).
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse']) {
    assert.match(toml, new RegExp(`event = "${event}"`),
      `base claude-dialect event ${event} must also be wired for kimi`);
  }
});
