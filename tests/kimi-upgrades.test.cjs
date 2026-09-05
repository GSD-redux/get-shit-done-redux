// docs-guard-exempt: docs/reference/host-integration-capability-matrix.md is cited only in a comment; never read.
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
const { runNode } = require('./helpers/process-seam.cjs');

const { runMinimalInstall, INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { cleanup, createTempDir, toPosixPath } = require('./helpers.cjs');
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
const { COMMONJS_MARKER_CONTENT } = require('../gsd-core/bin/lib/commonjs-marker.cjs');
const fc = require('fast-check');

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
  const reinstall = runNode([INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', root], {
    cwd: process.cwd(),
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: 120000,
  });
  assert.strictEqual(reinstall.exitCode, 0,
    `reinstall exited with status ${reinstall.exitCode}\nstdout: ${reinstall.stdout}\nstderr: ${reinstall.stderr}`);
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

test('UPGRADE 2: negotiateHostCapabilities against kimi axes yields effective.dispatch.backgroundDispatch === true, but shouldFlattenDispatch is true (#2939: nested:false cannot host a nesting orchestrator)', () => {
  const KIMI_AXES = KIMI_CAP.runtime.hostIntegration;
  const { effective } = negotiateHostCapabilities(KIMI_AXES);
  // UPGRADE 2 still holds: the descriptor declares backgroundDispatch:true (kimi CAN background
  // a single agent). #2939 changes only the FLATTEN consequence: kimi's nested:false means a
  // backgrounded kimi agent cannot itself nest the plan-checker/executor/verifier pipeline the
  // workflows require, so the orchestrator must run inline (flatten) even though backgrounding
  // a single agent is possible.
  assert.equal(effective.dispatch.backgroundDispatch, true);
  assert.equal(shouldFlattenDispatch(effective.dispatch), true,
    '#2939: kimi nested:false → a backgrounded orchestrator cannot nest the pipeline → flatten');
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
    const { configDir, root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
    t.after(() => cleanup(root));

    // #3547 — the root agent lives under the runtime's real global config
    // home (<root>/.config/agents), not the sandbox HOME itself.
    const rootYamlPath = path.join(configDir, 'agents', 'gsd.yaml');
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

test('kimi: the secret read guard is wired on the native bus with the translated ReadFile|Grep|Shell matcher (#4221)', (t) => {
  const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
  t.after(() => cleanup(root));

  const toml = fs.readFileSync(path.join(root, '.kimi', 'config.toml'), 'utf8');
  // One [[hooks]] table per entry: event, then matcher, then command. Locate
  // the guard's table by its command and read its matcher from the same table.
  const tables = toml.split('[[hooks]]').filter((t) => t.includes('gsd-secret-read-guard.js'));
  assert.equal(tables.length, 1, 'exactly one [[hooks]] table must reference gsd-secret-read-guard.js');
  assert.match(tables[0], /event = "PreToolUse"/, 'the secret read guard is a PreToolUse hook');
  assert.match(tables[0], /matcher = "ReadFile\|Grep\|Shell"/,
    'Kimi vocabulary: Read -> ReadFile, Bash -> Shell; Grep keeps its name');
});

// ---------------------------------------------------------------------------
// #2755: the hooks-TOML root is per-runtime, not a shared ~/.kimi
// ---------------------------------------------------------------------------

/**
 * Whether GSD's managed block is present, decided by the module's OWN parser
 * rather than a substring probe: stripping is a no-op exactly when there is no
 * block to strip.
 */
function hasGsdHooksBlock(tomlPath) {
  if (!fs.existsSync(tomlPath)) return false;
  const content = fs.readFileSync(tomlPath, 'utf8');
  return stripKimiHooksTomlBlock(content) !== content;
}

/**
 * Spawn the real installer for one Kimi variant against a shared sandbox HOME.
 *
 * `extraArgs` (#3031) appends installer flags beyond the uninstall switch — the
 * opt-in `--reclaim-kimi-legacy` path needs them, and threading them here keeps
 * every Kimi test on one spawn helper.
 */
function runKimiInstall(root, runtime, { extraEnv = {}, uninstall = false, extraArgs = [] } = {}) {
  return runMinimalInstall({
    runtime,
    scope: 'global',
    root,
    extraEnv,
    extraArgs: [...(uninstall ? ['--uninstall'] : []), ...extraArgs],
  });
}

function sandboxHome(t, prefix = 'gsd-2755-') {
  const root = createTempDir(prefix);
  t.after(() => cleanup(root));
  return root;
}

describe('kimi vs kimi-code hooks-TOML root (#2755)', () => {
  test('--kimi-code --global writes its hooks into ~/.kimi-code and never creates ~/.kimi', (t) => {
    const root = sandboxHome(t);
    runKimiInstall(root, 'kimi-code');

    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      "the GSD [[hooks]] block must land in Kimi Code's own config.toml");
    assert.ok(!fs.existsSync(path.join(root, '.kimi')),
      "a --kimi-code install must not create Kimi CLI's ~/.kimi root at all");
  });

  test('--kimi-code --global installs its hook bundle under ~/.kimi-code/hooks', (t) => {
    const root = sandboxHome(t);
    runKimiInstall(root, 'kimi-code');

    const hooksDir = path.join(root, '.kimi-code', 'hooks');
    assert.ok(fs.existsSync(path.join(hooksDir, 'gsd-check-update.js')),
      'the shared hook bundle must be self-contained under the kimi-code root');
    assert.ok(fs.existsSync(path.join(hooksDir, 'lib')),
      'hooks/lib must ship alongside it');
    assert.ok(fs.existsSync(path.join(hooksDir, 'package.json')),
      "the CommonJS marker must sit under kimi-code's hooks/ dir (#2544 shape)");

    // The emitted [[hooks]] command paths must reference the same root the
    // bundle was installed into, or every hook resolves to a missing script.
    const toml = fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8');
    const managed = toml.slice(
      toml.indexOf(KIMI_HOOKS_TOML_MARKER_BEGIN),
      toml.indexOf(KIMI_HOOKS_TOML_MARKER_END),
    );
    const commandPaths = [...managed.matchAll(/^command = "(.*)"$/gm)].map((m) => m[1]);
    assert.ok(commandPaths.length > 0, 'the managed block must emit at least one command');
    for (const cmd of commandPaths) {
      assert.ok(toPosixPath(cmd).includes('/.kimi-code/hooks/'),
        `hook command must reference the kimi-code hooks dir: ${cmd}`);
      assert.ok(!toPosixPath(cmd).includes('/.kimi/hooks/'),
        `hook command must not reference Kimi CLI's hooks dir: ${cmd}`);
    }
  });

  test('--kimi --global still writes into ~/.kimi and never creates ~/.kimi-code', (t) => {
    const root = sandboxHome(t);
    runKimiInstall(root, 'kimi');

    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi', 'config.toml')),
      "kimi's own destination must be unchanged by #2755");
    assert.ok(!fs.existsSync(path.join(root, '.kimi-code')),
      "a --kimi install must not create Kimi Code's root");
  });

  test('KIMI_CODE_HOME redirects the kimi-code hooks destination', (t) => {
    const root = sandboxHome(t);
    const altHome = sandboxHome(t, 'gsd-2755-kch-');
    runKimiInstall(root, 'kimi-code', { extraEnv: { KIMI_CODE_HOME: altHome } });

    assert.ok(hasGsdHooksBlock(path.join(altHome, 'config.toml')),
      'KIMI_CODE_HOME must redirect the hooks block');
    // #3547 — <root>/.kimi-code legitimately exists as kimi-code's GSD config
    // home in the harness's real global shape; what must NOT happen is the
    // DEFAULT hooks root receiving the GSD block while the override is set.
    assert.ok(!hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      'the default kimi-code hooks root must not receive the GSD hooks block when the env var is set');
    assert.ok(!fs.existsSync(path.join(root, '.kimi')),
      "Kimi CLI's root must not be touched either");
  });

  test('KIMI_SHARE_DIR still redirects the kimi hooks destination', (t) => {
    const root = sandboxHome(t);
    const altHome = sandboxHome(t, 'gsd-2755-ksd-');
    runKimiInstall(root, 'kimi', { extraEnv: { KIMI_SHARE_DIR: altHome } });

    assert.ok(hasGsdHooksBlock(path.join(altHome, 'config.toml')),
      "KIMI_SHARE_DIR must keep redirecting kimi's hooks block");
    assert.ok(!fs.existsSync(path.join(root, '.kimi-code')),
      "kimi-code's root must not be touched");
  });

  test('uninstalling kimi-code leaves kimi hooks intact', (t) => {
    const root = sandboxHome(t);
    runKimiInstall(root, 'kimi');
    runKimiInstall(root, 'kimi-code');

    const kimiToml = path.join(root, '.kimi', 'config.toml');
    const kimiCodeToml = path.join(root, '.kimi-code', 'config.toml');
    const kimiBefore = fs.readFileSync(kimiToml, 'utf8');

    runKimiInstall(root, 'kimi-code', { uninstall: true });

    assert.equal(fs.readFileSync(kimiToml, 'utf8'), kimiBefore,
      "a --kimi-code uninstall must leave Kimi CLI's config.toml byte-identical");
    assert.ok(!hasGsdHooksBlock(kimiCodeToml),
      "kimi-code's own block must be removed by its own uninstall");
  });

  test('uninstalling kimi leaves kimi-code hooks intact', (t) => {
    const root = sandboxHome(t);
    runKimiInstall(root, 'kimi');
    runKimiInstall(root, 'kimi-code');

    const kimiToml = path.join(root, '.kimi', 'config.toml');
    const kimiCodeToml = path.join(root, '.kimi-code', 'config.toml');
    const kimiCodeBefore = fs.readFileSync(kimiCodeToml, 'utf8');

    runKimiInstall(root, 'kimi', { uninstall: true });

    assert.equal(fs.readFileSync(kimiCodeToml, 'utf8'), kimiCodeBefore,
      "a --kimi uninstall must leave Kimi Code's config.toml byte-identical");
    assert.ok(!hasGsdHooksBlock(kimiToml),
      "kimi's own block must be removed by its own uninstall");
  });

  test('KIMI_SHARE_DIR and KIMI_CODE_HOME set together do not interfere', (t) => {
    // Both products' overrides live in one environment in practice. Each must
    // honor only its own variable — proven through the real installer, not just
    // the resolver unit.
    const root = sandboxHome(t);
    const kimiAlt = sandboxHome(t, 'gsd-2755-both-kimi-');
    const codeAlt = sandboxHome(t, 'gsd-2755-both-code-');
    const both = { KIMI_SHARE_DIR: kimiAlt, KIMI_CODE_HOME: codeAlt };

    runKimiInstall(root, 'kimi', { extraEnv: both });
    runKimiInstall(root, 'kimi-code', { extraEnv: both });

    assert.ok(hasGsdHooksBlock(path.join(kimiAlt, 'config.toml')),
      'kimi must honor KIMI_SHARE_DIR while KIMI_CODE_HOME is also set');
    assert.ok(hasGsdHooksBlock(path.join(codeAlt, 'config.toml')),
      'kimi-code must honor KIMI_CODE_HOME while KIMI_SHARE_DIR is also set');
    assert.ok(!fs.existsSync(path.join(root, '.kimi')),
      'neither default hooks root may be used when both overrides are set');
    // #3547 — <root>/.kimi-code is kimi-code's GSD config home now; assert the
    // hooks BLOCK stayed off the default root instead of directory absence.
    assert.ok(!hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      'neither default hooks root may receive the GSD block when both overrides are set');
  });
});


// ---------------------------------------------------------------------------
// #3031: opt-in reclaim of the ~/.kimi artifacts a pre-#2755 install orphaned
// ---------------------------------------------------------------------------

/**
 * The GSD hook script name the bundle really installs, so seeded wreckage
 * matches what the pre-#2755 installer actually left behind.
 */
const SEEDED_GSD_HOOK = 'gsd-check-update.js';
const RECLAIM_FLAG = '--reclaim-kimi-legacy';

/**
 * Seed a sandbox HOME with exactly what a pre-#2755 `--kimi-code` install left
 * in `~/.kimi`: GSD's managed block in the native config.toml, a hook script,
 * and the CommonJS marker inside hooks/.
 */
function seedLegacyKimiRoot(home, { userTomlPre = '', userTomlPost = '' } = {}) {
  const root = path.join(home, '.kimi');
  const hooksDir = path.join(root, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const block = [
    KIMI_HOOKS_TOML_MARKER_BEGIN,
    '',
    '[[hooks]]',
    'event = "SessionStart"',
    `command = "node \\"${toPosixPath(root)}/hooks/${SEEDED_GSD_HOOK}\\""`,
    '',
    KIMI_HOOKS_TOML_MARKER_END,
  ].join('\n');

  const parts = [userTomlPre, block, userTomlPost].filter((part) => part !== '');
  fs.writeFileSync(path.join(root, 'config.toml'), `${parts.join('\n\n')}\n`);
  fs.writeFileSync(path.join(hooksDir, SEEDED_GSD_HOOK), '// GSD hook\n');
  fs.writeFileSync(path.join(hooksDir, 'package.json'), COMMONJS_MARKER_CONTENT);

  return { root, hooksDir, tomlPath: path.join(root, 'config.toml') };
}

describe('#3031 — opt-in reclaim of orphaned ~/.kimi GSD artifacts', () => {
  test('reclaims the legacy ~/.kimi GSD artifacts when --reclaim-kimi-legacy is passed', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const legacy = seedLegacyKimiRoot(root);

    runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });

    assert.ok(!hasGsdHooksBlock(legacy.tomlPath),
      'the stale GSD [[hooks]] block must be gone from ~/.kimi/config.toml');
    assert.ok(!fs.existsSync(path.join(legacy.hooksDir, SEEDED_GSD_HOOK)),
      'the orphaned GSD hook script must be removed from ~/.kimi/hooks/');
    assert.ok(!fs.existsSync(path.join(legacy.hooksDir, 'package.json')),
      'the orphaned CommonJS marker must be removed from ~/.kimi/hooks/');
    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      'the kimi-code install itself must still have written its own GSD block');
  });

  test('leaves ~/.kimi untouched without the flag (cleanup is opt-in)', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const legacy = seedLegacyKimiRoot(root);
    const before = fs.readFileSync(legacy.tomlPath, 'utf8');

    runKimiInstall(root, 'kimi-code');

    assert.equal(fs.readFileSync(legacy.tomlPath, 'utf8'), before,
      '~/.kimi/config.toml must be byte-identical when the flag is absent');
    assert.ok(fs.existsSync(path.join(legacy.hooksDir, SEEDED_GSD_HOOK)),
      'the hook bundle must survive when the flag is absent');
  });

  test('preserves user-authored config.toml sections and non-GSD hook files', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const legacy = seedLegacyKimiRoot(root, {
      userTomlPre: '[providers.moonshot]\napi_key = "USER-OWNED"',
      userTomlPost: '[ui]\ntheme = "dark"',
    });
    const userHook = path.join(legacy.hooksDir, 'my-own-hook.js');
    fs.writeFileSync(userHook, '// authored by the user\n');

    runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });

    const after = fs.readFileSync(legacy.tomlPath, 'utf8');
    assert.ok(!hasGsdHooksBlock(legacy.tomlPath), 'the GSD block must be gone');
    assert.match(after, /api_key = "USER-OWNED"/, 'user provider section must survive');
    assert.match(after, /theme = "dark"/, 'user ui section must survive');
    assert.ok(fs.existsSync(userHook), 'a user-authored hook script must never be removed');
  });

  test('never reclaims when the install runtime is kimi itself', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const legacy = seedLegacyKimiRoot(root);

    runKimiInstall(root, 'kimi', { extraArgs: [RECLAIM_FLAG] });

    assert.ok(hasGsdHooksBlock(legacy.tomlPath),
      'a --kimi install must never reclaim ~/.kimi — that is its own hooks root');
  });

  test('skips reclaim when the legacy root resolves to the install root', (t) => {
    // Both overrides pointed at ONE directory collapse "the legacy root" onto
    // "the root this install just wrote". An unguarded reclaim would delete its
    // own output.
    const root = sandboxHome(t, 'gsd-3031-');
    const shared = sandboxHome(t, 'gsd-3031-shared-');

    runKimiInstall(root, 'kimi-code', {
      extraArgs: [RECLAIM_FLAG],
      extraEnv: { KIMI_SHARE_DIR: shared, KIMI_CODE_HOME: shared },
    });

    assert.ok(hasGsdHooksBlock(path.join(shared, 'config.toml')),
      'reclaim must not delete the hooks block this very install just wrote');
  });

  test('never reclaims when the same invocation also installs kimi', (t) => {
    // The flag asserts "I only use Kimi Code". `--all` — or an explicit
    // `--kimi --kimi-code` — falsifies that, and selectRuntimesFromArgs puts
    // `kimi` BEFORE `kimi-code` in both, so an unguarded reclaim installs Kimi
    // CLI's hooks and deletes them moments later in the same run, exiting 0.
    const root = sandboxHome(t, 'gsd-3031-');

    // Adding `--kimi` to a kimi-code install makes selectRuntimesFromArgs
    // return BOTH runtimes, exactly as `--all` does.
    runKimiInstall(root, 'kimi-code', { extraArgs: ['--kimi', RECLAIM_FLAG] });

    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi', 'config.toml')),
      'Kimi CLI hooks installed by this same run must survive the reclaim');
    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      'the kimi-code install itself must still succeed');
  });

  test('skips reclaim when the two roots differ only by a symlink alias', (t) => {
    // The roots come from user-controlled env vars, so "same directory" and
    // "same string" are not the same question. A resolve-only comparison
    // returns false here and the reclaim would delete the hooks this very
    // install just wrote.
    if (process.platform === 'win32') {
      t.skip('symlink creation requires elevated privileges on Windows');
      return;
    }
    const root = sandboxHome(t, 'gsd-3031-');
    const real = path.join(root, 'realkimi');
    const link = path.join(root, 'linkkimi');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);

    runKimiInstall(root, 'kimi-code', {
      extraArgs: [RECLAIM_FLAG],
      extraEnv: { KIMI_CODE_HOME: real, KIMI_SHARE_DIR: link },
    });

    assert.ok(hasGsdHooksBlock(path.join(real, 'config.toml')),
      'a symlinked alias of the install root must not be reclaimed');
  });

  test('skips reclaim when the two roots differ only by case on a case-insensitive filesystem', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const real = path.join(root, 'casekimi');
    const upper = path.join(root, 'CASEKIMI');
    fs.mkdirSync(real, { recursive: true });

    // Probe the ACTUAL filesystem rather than inferring from process.platform:
    // macOS can be formatted case-sensitively and Linux can mount otherwise.
    if (!fs.existsSync(upper)) {
      t.skip('filesystem is case-sensitive — these are genuinely two directories');
      return;
    }

    runKimiInstall(root, 'kimi-code', {
      extraArgs: [RECLAIM_FLAG],
      extraEnv: { KIMI_CODE_HOME: real, KIMI_SHARE_DIR: upper },
    });

    assert.ok(hasGsdHooksBlock(path.join(real, 'config.toml')),
      'a case-variant alias of the install root must not be reclaimed');
  });

  test('is a no-op when no legacy ~/.kimi root exists', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');

    runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });

    assert.ok(!fs.existsSync(path.join(root, '.kimi')),
      'reclaim must not create a legacy root that never existed');
    assert.ok(hasGsdHooksBlock(path.join(root, '.kimi-code', 'config.toml')),
      'the kimi-code install itself must still succeed');
  });

  test('is idempotent across repeated reclaims', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    const legacy = seedLegacyKimiRoot(root);
    const read = () => (fs.existsSync(legacy.tomlPath)
      ? fs.readFileSync(legacy.tomlPath, 'utf8')
      : null);

    // runKimiInstall asserts exit 0, so a crash on the second pass fails here.
    runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });
    const afterFirst = read();
    runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });

    assert.equal(read(), afterFirst, 'a second reclaim must change nothing further');
  });

  test('warns instead of silently no-opping when the flag cannot apply', (t) => {
    // The flag only ever acts inside the kimi-code GLOBAL branch. Consuming it
    // in silence is indistinguishable from "it ran and found nothing", which
    // for a cleanup the user explicitly asked for is the wrong answer.
    const wrongRuntime = runMinimalInstall({
      runtime: 'claude',
      scope: 'global',
      root: sandboxHome(t, 'gsd-3031-'),
      extraArgs: [RECLAIM_FLAG],
    });
    assert.match(`${wrongRuntime.stdout}${wrongRuntime.stderr}`, /--reclaim-kimi-legacy ignored/,
      'a non-kimi-code install must say the flag did nothing');

    // kimi-code declares hostBehaviors.localInstallDeferred, so install()
    // returns before the hooks branch — the scope warning has to be raised
    // before that early return, not inside it.
    const localScope = runMinimalInstall({
      runtime: 'kimi-code',
      scope: 'local',
      root: sandboxHome(t, 'gsd-3031-'),
      extraArgs: [RECLAIM_FLAG],
    });
    assert.match(`${localScope.stdout}${localScope.stderr}`, /--reclaim-kimi-legacy ignored/,
      'a local install must say the flag did nothing');
  });

  test('does not warn on the happy path', (t) => {
    const root = sandboxHome(t, 'gsd-3031-');
    seedLegacyKimiRoot(root);

    const result = runKimiInstall(root, 'kimi-code', { extraArgs: [RECLAIM_FLAG] });

    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /--reclaim-kimi-legacy ignored/,
      'the warning must not fire when the reclaim actually runs');
  });

  test('property: stripping the GSD block never destroys user content', () => {
    const userText = fc.stringMatching(/^[A-Za-z0-9_= ."[\]]{1,40}$/);

    fc.assert(
      fc.property(userText, userText, (pre, post) => {
        const block = [
          KIMI_HOOKS_TOML_MARKER_BEGIN,
          '',
          '[[hooks]]',
          'event = "SessionStart"',
          '',
          KIMI_HOOKS_TOML_MARKER_END,
        ].join('\n');
        const stripped = stripKimiHooksTomlBlock(`${pre}\n\n${block}\n\n${post}\n`);

        assert.ok(stripped === null || !stripped.includes(KIMI_HOOKS_TOML_MARKER_BEGIN),
          'the managed block itself must always be removed');

        const survives = (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return true;
          return stripped !== null && stripped.includes(trimmed);
        };
        assert.ok(survives(pre), `user prefix lost: ${JSON.stringify(pre)}`);
        assert.ok(survives(post), `user suffix lost: ${JSON.stringify(post)}`);
      }),
      { numRuns: 100 },
    );
  });
});
