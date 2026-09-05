// allow-test-rule: source-text-is-the-product (see #3244)
// Reads the installed .toml agent files whose deployed text IS what Codex
// loads at session start — testing that text tests the deployed contract.
// (Row 7/10 additionally assert on Phase 2's parsed IR — see below — the raw
// text reads here are for the fields that IR does not expose per-agent.)

/**
 * Phase 4 smoke test — Codex passive model posture, end-to-end (#3244).
 *
 * Test-only; no production change. Drives a REAL install through
 * `install()` (the same entry point every user hits) and then feeds the
 * emitted tree to Phase 2's validator (`checkCodexModelPosture`,
 * gsd-core/bin/lib/agent-install-check.cjs). This is the only place in the
 * epic where the emitter (#3241) and the validator (#3242) are exercised
 * against the same bytes — every phase before this tested its own half
 * against fixtures it authored (#2371).
 *
 * Row-to-classification map (see .gsd/phase/test-3244-codex-inherit-smoke/
 * 50-test-matrix.md for the full rationale):
 *   Row 1, 2, 3   — regression guard (passes today; would have failed pre-#3241)
 *   Row 4         — regression guard — the unchanged `inherit` control
 *   Row 5, 6      — regression guard — negative proof (posture removes a pin,
 *                   not an agent; #774 service_tier/model_verbosity decoupled)
 *   Row 7         — cross-phase integration (emitter -> validator)
 *   Row 8         — cross-phase integration (emitter -> repairer, dry-run,
 *                   posture-clean tree needs zero changes)
 *   Row 9         — regression guard — explicit pin survives
 *   Row 10        — cross-phase integration (emitter -> validator, legal pin)
 *   Row 11        — cross-phase integration (emitter -> repairer, dry-run,
 *                   legal pin reported skipped and left byte-identical)
 *
 * Rows 8 and 11 exercise Phase 3's repair sync (#3243: "sync installed codex
 * .toml model/effort to the passive posture") against a REAL emitted tree —
 * `cmdEffortSync` (src/commands.cts) is driven the same way Phase 3's own
 * `tests/commands.test.cjs` (describe('#3243 (ADR-2313 D7): Codex .toml
 * effort sync')) drives it: `require('../gsd-core/bin/lib/commands.cjs')`,
 * called as `cmdEffortSync(cwd, raw=false, {dryRun, configDir, runtime:
 * 'codex'})`, with its `output()` JSON captured off fd 1 (see
 * `captureOutput` below — same technique as commands.test.cjs's own helper).
 * Both rows are expected to PASS today (Phase 3 is merged) — cross-phase
 * integration, not red-first; see 50-test-matrix.md's "Red-before-green"
 * section.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install } = require('../bin/install.js');
const { checkCodexModelPosture } = require('../gsd-core/bin/lib/agent-install-check.cjs');
const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
const { parseCodexAgentToml } = require('../gsd-core/bin/lib/codex-agent-toml.cjs');
const { cleanup, captureFdSync } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run a global Codex install, redirecting CODEX_HOME to codexHome. Mirrors
 * the `runGlobalInstall` helper in tests/install-runtime-artifacts.test.cjs
 * (reused pattern, not reused code — that helper is not exported). HOME is
 * isolated so install.js code that calls os.homedir() never touches the
 * real $HOME, and GSD_SKIP_STALE_SDK_CHECK=1 suppresses the `npm ls -g`
 * subprocess (irrelevant to posture assertions, and a subprocess this test
 * does not want to be timeout-bound on).
 */
function runCodexInstall(codexHome) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3244-home-'));

  const prevCodexHome = process.env.CODEX_HOME;
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env.CODEX_HOME = codexHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, 'codex');
  } finally {
    process.chdir(prevCwd);
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }
}

function writeProjectConfig(projectDir, config) {
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'config.json'),
    JSON.stringify(config, null, 2),
  );
}

function readToml(codexHome, agentName) {
  return fs.readFileSync(path.join(codexHome, 'agents', `${agentName}.toml`), 'utf8');
}

/**
 * Lines before the `developer_instructions = '''` marker — the header
 * region generateCodexAgentToml always emits model/effort/service_tier/etc.
 * into (bin/install.js's `lines` array construction). Scoping to this
 * region, rather than scanning the whole file, is required: GSD agent
 * prompts discuss "model" constantly, so a bare substring/whole-file scan
 * would false-match prose inside the developer_instructions block. Same
 * convention already established in tests/install-runtime-artifacts.test.cjs
 * (describe('#3241 ...')).
 */
function headerLines(tomlContent) {
  const lines = tomlContent.split(/\r?\n/);
  const bodyStart = lines.findIndex((line) => line.startsWith("developer_instructions = '''"));
  assert.notStrictEqual(bodyStart, -1,
    `expected a developer_instructions = ''' marker to scope the header scan against\nActual:\n${tomlContent.slice(0, 500)}`);
  return lines.slice(0, bodyStart);
}

function findKeyLine(header, key) {
  const re = new RegExp(`^${key}\\s*=`);
  return header.find((line) => re.test(line));
}

/**
 * Runs Phase 3's `cmdEffortSync` codex branch against `codexHome` and returns
 * the parsed structured result. Mirrors `syncCodex` in tests/commands.test.cjs
 * (describe('#3243 (ADR-2313 D7): Codex .toml effort sync')) — `configDir` is
 * the agents dir's PARENT (cmdEffortSync joins 'agents' itself), `raw` is
 * false so `output()` emits JSON, and `output()`'s `fs.writeSync(1, ...)` is
 * intercepted rather than parsed from stdout text, so this asserts on
 * structure, never prose.
 */
function runEffortSyncDryRun(codexHome) {
  const captured = captureFdSync(1, () =>
    cmdEffortSync(codexHome, false, { dryRun: true, configDir: codexHome, runtime: 'codex' })
  );
  return JSON.parse(captured);
}

/**
 * Runs `fn()` with `GSD_AGENTS_DIR` set to `dir`, restoring the prior value
 * (or deleting it, if previously unset) in a `finally` inside this helper —
 * never inside a test body, per CONTRIBUTING.md's try/finally-in-tests ban.
 * Returns `fn`'s result.
 */
function withAgentsDir(dir, fn) {
  const prevAgentsDir = process.env.GSD_AGENTS_DIR;
  process.env.GSD_AGENTS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prevAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = prevAgentsDir;
  }
}

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    restore() { process.stderr.write = original; },
    text() { return chunks.join(''); },
    noticeLines() {
      return chunks.join('').split(/\r?\n/).filter((line) => line.startsWith('gsd: notice — '));
    },
  };
}

// ─── Rows 1, 2, 3, 5a, 6, 7: model_profile "balanced" (the default) ─────────
// This is the path that changed. `readGsdRuntimeProfileResolver` resolves a
// per-tier Codex model for "balanced" (bin/install.js:1666-1682) — under
// Phase 1 (#3241) that resolved model is no longer embedded, only warned
// about via the one-time notice. `model_profile: "inherit"` (row 4, below)
// short-circuits the resolver to null (bin/install.js:1667) and would have
// omitted the model even before #3241 — asserting it alone would be vacuous.

describe('Row 1/2/3/5a/6/7 — codex install, model_profile: balanced (default), no model_overrides', () => {
  let tmpDir;
  let codexHome;
  let stderr;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-3244-balanced-');
    const projectDir = path.join(tmpDir, 'project');
    codexHome = path.join(projectDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    // runtime:"codex" with no model_profile key resolves to "balanced"
    // (bin/install.js:1657) and no model_overrides — the default shipping
    // shape.
    writeProjectConfig(projectDir, { runtime: 'codex' });
    stderr = captureStderr();
    runCodexInstall(codexHome);
  });

  afterEach(() => {
    stderr.restore();
    cleanup(tmpDir);
  });

  test('row 1: researcher/planner/checker .toml carry no model', () => {
    for (const agent of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
      const header = headerLines(readToml(codexHome, agent));
      assert.strictEqual(findKeyLine(header, 'model'), undefined,
        `${agent}.toml must not pin a model under the default balanced profile\nheader:\n${header.join('\n')}`);
    }
  });

  test('row 2: researcher/planner/checker .toml carry no model_reasoning_effort (#838 coupling)', () => {
    for (const agent of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
      const header = headerLines(readToml(codexHome, agent));
      assert.strictEqual(findKeyLine(header, 'model_reasoning_effort'), undefined,
        `${agent}.toml must not emit model_reasoning_effort with no model pinned\nheader:\n${header.join('\n')}`);
    }
  });

  test('row 3: exactly one "gsd: notice — " line on stderr', () => {
    const notices = stderr.noticeLines();
    assert.strictEqual(notices.length, 1,
      `expected exactly one notice line across the whole install, got ${notices.length}\nstderr:\n${stderr.text()}`);
  });

  test('row 5a: gsd-planner.toml keeps name/description/sandbox_mode/developer_instructions intact', () => {
    const content = readToml(codexHome, 'gsd-planner');
    const header = headerLines(content);
    const nameLine = findKeyLine(header, 'name');
    const descLine = findKeyLine(header, 'description');
    const sandboxLine = findKeyLine(header, 'sandbox_mode');
    assert.ok(nameLine && /=\s*".+"/.test(nameLine), `name must be present and non-empty\nActual:\n${nameLine}`);
    assert.ok(descLine && /=\s*".+"/.test(descLine), `description must be present and non-empty\nActual:\n${descLine}`);
    assert.ok(sandboxLine && /=\s*".+"/.test(sandboxLine), `sandbox_mode must be present and non-empty\nActual:\n${sandboxLine}`);
    assert.match(content, /developer_instructions = '''[\s\S]+'''/,
      'developer_instructions block must be present and non-empty');
  });

  test('row 6: gsd-plan-checker.toml (light tier) still emits service_tier/model_verbosity (#774, decoupled)', () => {
    const header = headerLines(readToml(codexHome, 'gsd-plan-checker'));
    const serviceTierLine = findKeyLine(header, 'service_tier');
    const verbosityLine = findKeyLine(header, 'model_verbosity');
    assert.match(serviceTierLine || '', /=\s*"flex"$/,
      `gsd-plan-checker.toml must still emit service_tier = "flex"\nheader:\n${header.join('\n')}`);
    assert.match(verbosityLine || '', /=\s*"low"$/,
      `gsd-plan-checker.toml must still emit model_verbosity = "low"\nheader:\n${header.join('\n')}`);
  });

  test('row 7: checkCodexModelPosture reports the freshly-installed tree clean (emit -> validate)', () => {
    const result = withAgentsDir(path.join(codexHome, 'agents'), () => checkCodexModelPosture('codex'));
    assert.strictEqual(result.ok, true,
      `Phase 2's validator must report the tree Phase 1's emitter just produced as clean\nviolations:\n${JSON.stringify(result.violations, null, 2)}`);
    assert.deepStrictEqual(result.violations, []);
    assert.ok(result.checked.includes('gsd-planner'), 'sanity: gsd-planner.toml must have been checked');
  });

  test('row 8: effort sync (dry-run) reports zero changes on the freshly-installed tree (emit -> repair)', () => {
    const result = runEffortSyncDryRun(codexHome);
    assert.strictEqual(result.synced, 0,
      `Phase 3's repairer must find nothing to fix in the tree Phase 1's emitter just produced\nchanges:\n${JSON.stringify(result.changes, null, 2)}`);
    assert.deepStrictEqual(result.changes, []);
    assert.deepStrictEqual(result.refused, []);
    assert.deepStrictEqual(result.write_failures, []);
    assert.ok(result.skipped > 0, 'sanity: at least one agent must have been examined and reported skipped (clean)');
  });
});

// ─── Row 4/5b — model_profile "inherit": the unchanged control ─────────────
// readGsdRuntimeProfileResolver returns null for "inherit" (bin/install.js:
// 1667) — a Codex install under inherit omitted the model before #3241 too.
// This row alone would be vacuous (would pass identically pre/post-epic);
// it exists as the negative control alongside row 1's positive case.

describe('Row 4/5b — codex install, model_profile: inherit (unchanged control)', () => {
  let tmpDir;
  let codexHome;
  let stderr;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-3244-inherit-');
    const projectDir = path.join(tmpDir, 'project');
    codexHome = path.join(projectDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    writeProjectConfig(projectDir, { runtime: 'codex', model_profile: 'inherit' });
    stderr = captureStderr();
    runCodexInstall(codexHome);
  });

  afterEach(() => {
    stderr.restore();
    cleanup(tmpDir);
  });

  test('row 4: no model, no effort, and no notice — nothing was lost', () => {
    const header = headerLines(readToml(codexHome, 'gsd-planner'));
    assert.strictEqual(findKeyLine(header, 'model'), undefined,
      'gsd-planner.toml must not pin a model under model_profile: inherit');
    assert.strictEqual(findKeyLine(header, 'model_reasoning_effort'), undefined,
      'gsd-planner.toml must not emit model_reasoning_effort under model_profile: inherit');
    assert.strictEqual(stderr.noticeLines().length, 0,
      `inherit must never fire the #3241 notice — nothing was lost\nstderr:\n${stderr.text()}`);
  });

  test('row 5b: gsd-planner.toml keeps name/description/sandbox_mode/developer_instructions intact', () => {
    const content = readToml(codexHome, 'gsd-planner');
    const header = headerLines(content);
    const nameLine = findKeyLine(header, 'name');
    const descLine = findKeyLine(header, 'description');
    const sandboxLine = findKeyLine(header, 'sandbox_mode');
    assert.ok(nameLine && /=\s*".+"/.test(nameLine), `name must be present and non-empty\nActual:\n${nameLine}`);
    assert.ok(descLine && /=\s*".+"/.test(descLine), `description must be present and non-empty\nActual:\n${descLine}`);
    assert.ok(sandboxLine && /=\s*".+"/.test(sandboxLine), `sandbox_mode must be present and non-empty\nActual:\n${sandboxLine}`);
    assert.match(content, /developer_instructions = '''[\s\S]+'''/,
      'developer_instructions block must be present and non-empty');
  });
});

// ─── Row 9/10 — an explicit real-Codex model_overrides pin survives ────────
// model_profile: inherit (nullifying the resolver, per row 4) plus an
// explicit model_overrides pin for gsd-planner only: model_overrides is
// checked before, and independently of, the runtime resolver
// (bin/install.js:4220-4237), so the pin embeds regardless of profile, while
// inherit guarantees no OTHER agent's notice fires. This isolates "does an
// explicit pin survive" from "does the resolver's notice fire" — the two
// things row 9 asserts.

describe('Row 9/10 — codex install with an explicit real-Codex model_overrides pin', () => {
  let tmpDir;
  let codexHome;
  let stderr;
  const PINNED_MODEL = 'gpt-5.6-sol';

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-3244-pinned-');
    const projectDir = path.join(tmpDir, 'project');
    codexHome = path.join(projectDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    writeProjectConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'inherit',
      model_overrides: { 'gsd-planner': PINNED_MODEL },
    });
    stderr = captureStderr();
    runCodexInstall(codexHome);
  });

  afterEach(() => {
    stderr.restore();
    cleanup(tmpDir);
  });

  test('row 9: the pin is present, its coupled effort is present, and the notice does not fire', () => {
    const header = headerLines(readToml(codexHome, 'gsd-planner'));
    const modelLine = findKeyLine(header, 'model');
    const effortLine = findKeyLine(header, 'model_reasoning_effort');
    assert.match(modelLine || '', new RegExp(`=\\s*"${PINNED_MODEL}"$`),
      `gsd-planner.toml must pin the explicit real-Codex model\nheader:\n${header.join('\n')}`);
    assert.ok(effortLine, `gsd-planner.toml must emit model_reasoning_effort alongside an explicit model pin (#838 coupling)\nheader:\n${header.join('\n')}`);
    assert.strictEqual(stderr.noticeLines().length, 0,
      `an explicit pin must never fire the #3241 "resolver model omitted" notice\nstderr:\n${stderr.text()}`);
  });

  test('row 10: checkCodexModelPosture reports the pinned tree clean — a legal pin is not a violation', () => {
    const result = withAgentsDir(path.join(codexHome, 'agents'), () => checkCodexModelPosture('codex'));
    assert.strictEqual(result.ok, true,
      `Phase 2's validator must not flag a legal explicit model_overrides pin\nviolations:\n${JSON.stringify(result.violations, null, 2)}`);
    assert.deepStrictEqual(result.violations, []);
  });

  test('row 11: effort sync (dry-run) reports the pinned agent skipped, not synced, and the file is byte-identical', () => {
    const filePath = path.join(codexHome, 'agents', 'gsd-planner.toml');
    const before = fs.readFileSync(filePath, 'utf8');

    const result = runEffortSyncDryRun(codexHome);

    const plannerChange = result.changes.find((c) => c.agent === 'gsd-planner');
    assert.strictEqual(plannerChange, undefined,
      `a legal pin must never be reported as a change\nchanges:\n${JSON.stringify(result.changes, null, 2)}`);
    assert.strictEqual(result.synced, 0,
      'an over-eager stripper would report this agent synced; a legal pin must be skipped instead');
    assert.ok(result.skipped > 0);

    const after = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(after, before,
      'file contents must be byte-identical after a dry-run — comparing bytes, not mtime, per the phase brief');

    // Confirm via Phase 3's own IR (parseCodexAgentToml), not just the raw
    // text compare above: the pin and its coupled effort must still be
    // present in the parsed structure, not merely absent from `changes`.
    const parsed = parseCodexAgentToml(after);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.doc.model, PINNED_MODEL,
      'the legal pin must still be present in the parsed IR after a dry-run sync');
    assert.strictEqual(parsed.doc.reasoningEffort !== null, true,
      'the coupled effort must still be present in the parsed IR after a dry-run sync');
  });
});
