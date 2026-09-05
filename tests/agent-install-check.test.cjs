'use strict';

/**
 * Agent Install Check Module — behaviour tests (#1268 T0, T1 #1277)
 *
 * Seam: gsd-core/bin/lib/agent-install-check.cjs
 * Interface: getAgentsDir, checkAgentsInstalled
 *
 * Verifies:
 *   1. getAgentsDir behaviour: GSD_AGENTS_DIR override, claude path, non-claude path
 *   2. checkAgentsInstalled behaviour against temp dirs via GSD_AGENTS_DIR:
 *      - missing dir → agents_installed:false, missing_agents = all expected
 *      - existing-but-empty dir → installed_agents:[], agents_installed:false
 *      - no manifest → completeness skipped (incomplete_agents empty)
 *      - partial manifest (agent.toml absent, agent.md present) → incomplete_agents includes agent
 *      - malformed manifest → no throw, completeness skipped
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, captureFdSync } = require('./helpers.cjs');

const AGENT_INSTALL_CHECK_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'agent-install-check.cjs'
);
const RUNTIME_HOMES_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'
);

const agentInstallCheck = require(AGENT_INSTALL_CHECK_PATH);
const { getGlobalConfigDir } = require(RUNTIME_HOMES_PATH);
const { getDirName } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

// Get EXPECTED_AGENTS from model-profiles (same source of truth)
const MODEL_PROFILES = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'model-profiles.cjs')).MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

// #3242 — single source of truth for the Anthropic-flavored alias/id set (Phase 1
// moved the predicate here), so the posture tests below can't silently drift from
// what the posture check is actually supposed to reject.
const { CLAUDE_AGENT_ALIASES } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'model-catalog.cjs'),
);

// ─── Environment isolation ────────────────────────────────────────────────────

let savedAgentsDir;
let savedRuntime;
let savedCodexHome;

beforeEach(() => {
  savedAgentsDir = process.env['GSD_AGENTS_DIR'];
  savedRuntime = process.env['GSD_RUNTIME'];
  savedCodexHome = process.env['CODEX_HOME'];
  delete process.env['GSD_AGENTS_DIR'];
  delete process.env['GSD_RUNTIME'];
  delete process.env['CODEX_HOME'];
});

afterEach(() => {
  if (savedAgentsDir === undefined) {
    delete process.env['GSD_AGENTS_DIR'];
  } else {
    process.env['GSD_AGENTS_DIR'] = savedAgentsDir;
  }
  if (savedRuntime === undefined) {
    delete process.env['GSD_RUNTIME'];
  } else {
    process.env['GSD_RUNTIME'] = savedRuntime;
  }
  if (savedCodexHome === undefined) {
    delete process.env['CODEX_HOME'];
  } else {
    process.env['CODEX_HOME'] = savedCodexHome;
  }
});

function createCompleteAgents(agentsDir) {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const agent of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
  }
}

function markLocalGsdInstall(configDir) {
  fs.writeFileSync(
    path.join(configDir, 'gsd-file-manifest.json'),
    JSON.stringify({ files: {} }),
  );
}

function createCompleteLocalGsdInstall(configDir) {
  const agentsDir = path.join(configDir, 'agents');
  createCompleteAgents(agentsDir);
  markLocalGsdInstall(configDir);
  return agentsDir;
}

// ─── 1. getAgentsDir behaviour ────────────────────────────────────────────────

describe('getAgentsDir', () => {
  test('GSD_AGENTS_DIR override takes priority', () => {
    process.env['GSD_AGENTS_DIR'] = '/tmp/x';
    assert.strictEqual(agentInstallCheck.getAgentsDir(), '/tmp/x');
    assert.strictEqual(agentInstallCheck.getAgentsDir('cursor'), '/tmp/x');
  });

  test('claude runtime outside node_modules returns the install-relative path', () => {
    // Repo runs and runtime-config-dir installs: the sibling agents/ IS the
    // user's agents dir, so install-relative resolution is correct there.
    const expected = path.resolve(
      path.dirname(AGENT_INSTALL_CHECK_PATH), '..', '..', '..', 'agents'
    );
    assert.strictEqual(agentInstallCheck.getAgentsDir('claude'), expected);
  });

  test('npm-global install resolves the config dir, never the bundled agents (#3203)', (t) => {
    // Mirror the published npm-global layout: the package sits inside a
    // node_modules tree and ships its own agents/. Pre-fix, getAgentsDir
    // resolved that bundled copy, so checkAgentsInstalled validated the
    // package against itself and agents_installed could never be false.
    const tmp = createTempDir('gsd-npm-global-');
    const savedClaudeDir = process.env['CLAUDE_CONFIG_DIR'];
    t.after(() => cleanup(tmp));
    t.after(() => {
      if (savedClaudeDir === undefined) {
        delete process.env['CLAUDE_CONFIG_DIR'];
      } else {
        process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir;
      }
    });

    const pkgRoot = path.join(tmp, 'node_modules', '@opengsd', 'gsd-core');
    fs.cpSync(
      path.join(__dirname, '..', 'gsd-core', 'bin'),
      path.join(pkgRoot, 'gsd-core', 'bin'),
      { recursive: true }
    );
    // Bundled agents/ is always complete — that is exactly why the pre-fix
    // self-validation could never report a missing agent.
    const bundledAgents = path.join(pkgRoot, 'agents');
    fs.mkdirSync(bundledAgents, { recursive: true });
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(bundledAgents, `${agent}.md`), `# ${agent}\n`);
    }

    // Config dir carries every expected agent except the first — the issue
    // repro's negative control (gsd-verifier removed from ~/.claude/agents).
    const configDir = path.join(tmp, 'claude-config');
    const agentsDir = path.join(configDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const [removedAgent, ...presentAgents] = EXPECTED_AGENTS;
    for (const agent of presentAgents) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }
    process.env['CLAUDE_CONFIG_DIR'] = configDir;

    const globalInstallCheck = require(
      path.join(pkgRoot, 'gsd-core', 'bin', 'lib', 'agent-install-check.cjs')
    );
    // Pin the resolved directory, not just an /agents suffix — the pre-fix
    // resolver also ended with /agents, which is how the bug survived.
    assert.strictEqual(globalInstallCheck.getAgentsDir('claude'), agentsDir);

    const result = globalInstallCheck.checkAgentsInstalled('claude');
    assert.strictEqual(result.agents_dir, agentsDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, [removedAgent]);
  });

  test('non-claude runtime returns getGlobalConfigDir(runtime)/agents', () => {
    const runtime = 'cursor';
    const expected = path.join(getGlobalConfigDir(runtime), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(runtime), expected);
  });

  test('GSD_RUNTIME env var is respected when no argument provided', () => {
    process.env['GSD_RUNTIME'] = 'codex';
    const expected = path.join(getGlobalConfigDir('codex'), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(), expected);
  });

  test('defaults to claude when no arg and no GSD_RUNTIME', () => {
    const fromModule = agentInstallCheck.getAgentsDir();
    const fromClaude = agentInstallCheck.getAgentsDir('claude');
    assert.strictEqual(fromModule, fromClaude);
  });

  test('a manifest-backed local runtime installation wins over global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    assert.strictEqual(agentInstallCheck.getAgentsDir('codex', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('codex', projectRoot).agents_installed, true);
  });

  test('GSD_AGENTS_DIR remains terminal when a local Codex installation exists', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const overrideDir = path.join(projectRoot, 'override-agents');
    createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));
    t.after(() => cleanup(projectRoot));
    fs.mkdirSync(overrideDir, { recursive: true });
    process.env['GSD_AGENTS_DIR'] = overrideDir;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, overrideDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
  });

  test('a manifest-backed empty local directory is authoritative over complete global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(localAgentsDir, { recursive: true });
    markLocalGsdInstall(path.dirname(localAgentsDir));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, localAgentsDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
  });

  test('Codex falls back to global agents when no local directory exists', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex falls back to global agents when the local candidate is a regular file', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localCandidate = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(path.dirname(localCandidate), { recursive: true });
    fs.writeFileSync(localCandidate, 'not an agents directory\n');
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex falls back to global agents when the local candidate cannot be inspected', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    const realLstatSync = fs.lstatSync;
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(localAgentsDir, { recursive: true });
    markLocalGsdInstall(path.dirname(localAgentsDir));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;
    t.mock.method(fs, 'lstatSync', function injectedLocalProbeFailure(target, ...args) {
      if (target === localAgentsDir) {
        throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      }
      return realLstatSync.call(fs, target, ...args);
    });

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex does not follow a symlinked local agents directory', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localConfigDir = path.join(projectRoot, '.codex');
    const localAgentsDir = path.join(localConfigDir, 'agents');
    const symlinkTarget = path.join(projectRoot, 'shared-agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(symlinkTarget);
    fs.mkdirSync(localConfigDir, { recursive: true });
    markLocalGsdInstall(localConfigDir);
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;
    try {
      fs.symlinkSync(symlinkTarget, localAgentsDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw error;
    }

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('a project-native agents directory without a GSD manifest does not override global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(localAgentsDir);
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('a manifest-backed Cursor installation resolves from the project root', (t) => {
    const projectRoot = createTempDir('gsd-local-cursor-');
    const localAgentsDir = createCompleteLocalGsdInstall(path.join(projectRoot, getDirName('cursor')));
    t.after(() => cleanup(projectRoot));

    assert.strictEqual(agentInstallCheck.getAgentsDir('cursor', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('cursor', projectRoot).agents_installed, true);
  });

  test('a manifest-backed Cline installation resolves from the project root', (t) => {
    const projectRoot = createTempDir('gsd-local-cline-');
    const localAgentsDir = createCompleteLocalGsdInstall(projectRoot);
    t.after(() => cleanup(projectRoot));

    assert.strictEqual(agentInstallCheck.getAgentsDir('cline', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('cline', projectRoot).agents_installed, true);
  });

  test('a partial manifest-backed local installation remains selected and incomplete', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const localConfigDir = path.join(projectRoot, '.codex');
    const localAgentsDir = createCompleteLocalGsdInstall(localConfigDir);
    const partialAgent = EXPECTED_AGENTS[0];
    t.after(() => cleanup(projectRoot));
    fs.writeFileSync(path.join(localAgentsDir, `${partialAgent}.md`), `# ${partialAgent}\n`);
    fs.unlinkSync(path.join(localAgentsDir, `${partialAgent}.toml`));
    fs.writeFileSync(
      path.join(localConfigDir, 'gsd-file-manifest.json'),
      JSON.stringify({ files: { [`agents/${partialAgent}.md`]: {}, [`agents/${partialAgent}.toml`]: {} } }),
    );

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, localAgentsDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, []);
    assert.deepStrictEqual(result.incomplete_agents, [partialAgent]);
  });

  test('Claude and other runtimes ignore a supplied Codex-local candidate', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    t.after(() => cleanup(projectRoot));
    createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));

    assert.strictEqual(
      agentInstallCheck.getAgentsDir('claude', projectRoot),
      agentInstallCheck.getAgentsDir('claude'),
    );
    assert.strictEqual(
      agentInstallCheck.getAgentsDir('cursor', projectRoot),
      path.join(getGlobalConfigDir('cursor'), 'agents'),
    );
  });
});

// ─── 2. checkAgentsInstalled behaviour ───────────────────────────────────────

describe('checkAgentsInstalled', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-agent-check-');
    // Point GSD_AGENTS_DIR at a path we control
    process.env['GSD_AGENTS_DIR'] = path.join(tmpDir, 'agents');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing dir → agents_installed:false, missing_agents = all expected', () => {
    // agents dir does not exist
    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('existing-but-empty dir → installed_agents:[], agents_installed:false', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.ok(result.missing_agents.length > 0, 'missing_agents should not be empty');
    // No manifest → completeness skipped
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('all agents present, no manifest → agents_installed:true, incomplete_agents:[]', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all expected agent .md files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, true);
    assert.deepStrictEqual(result.missing_agents, []);
    assert.deepStrictEqual(result.installed_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('partial manifest: agent.toml absent but agent.md present → incomplete_agents includes agent', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write all agent .md files so presence check passes
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Pick the first expected agent to make "incomplete" via manifest
    const targetAgent = EXPECTED_AGENTS[0];

    // Write manifest that tracks agent.toml for targetAgent (absent on disk)
    // and tracks agent.md for all others (present)
    const manifestFiles = {};
    for (const agent of EXPECTED_AGENTS) {
      manifestFiles[`agents/${agent}.md`] = {};
    }
    // Add a .toml for targetAgent to manifest (not present on disk)
    manifestFiles[`agents/${targetAgent}.toml`] = {};

    const manifest = { files: manifestFiles };
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(manifest)
    );

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.ok(result.incomplete_agents.includes(targetAgent),
      `Expected ${targetAgent} in incomplete_agents, got: ${JSON.stringify(result.incomplete_agents)}`);
    assert.strictEqual(result.agents_installed, false,
      'agents_installed must be false when any agent is incomplete');
  });

  test('malformed manifest → no throw, completeness skipped (incomplete_agents:[])', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all agent files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Write malformed manifest
    fs.writeFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), '{not json"');

    let result;
    assert.doesNotThrow(() => {
      result = agentInstallCheck.checkAgentsInstalled();
    });
    // Malformed → completeness skipped → incomplete_agents empty
    assert.deepStrictEqual(result.incomplete_agents, []);
    // But presence check still passed
    assert.strictEqual(result.agents_installed, true);
  });

  test('agents_dir and agent_runtime are returned in result', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled('cursor');
    // GSD_AGENTS_DIR overrides, so agents_dir = our tmp path
    assert.strictEqual(result.agents_dir, agentsDir);
    assert.strictEqual(result.agent_runtime, 'cursor');
  });
});

// ─── 3. checkCodexModelPosture behaviour (#3242, ADR-2313 D6) ─────────────────
//
// Spec: .gsd/phase/feat-3242-codex-posture-health-check/{40-design,50-test-matrix}.md
// Interface (not yet implemented — every test below is red until it lands):
//   POSTURE_REASON: frozen enum { ANTHROPIC_FLAVORED_MODEL, ORPHANED_REASONING_EFFORT,
//     UNREADABLE, NOT_CODEX, AGENTS_DIR_MISSING }
//   checkCodexModelPosture(runtime?, projectRoot?) => {
//     ok, violations: [{ agent, file, reason, value? }], checked, agents_dir,
//     agent_runtime, reason?
//   }
//
// Row numbers below (# N) map 1:1 to 50-test-matrix.md. Rows 12, 13, 14, 15, 16, 25
// are the negative proofs the matrix calls out as the ones that actually discriminate
// a correct implementation from a naive whole-file `/model\s*=/` scan; each of those
// test names states the specific implementation mistake it catches.

const POSTURE_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'toml');

function writeAgentToml(agentsDir, agentName, content) {
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${agentName}.toml`), content);
}

// Loads a hand-authored fixture (tests/fixtures/adversarial/toml/, #2371 provenance)
// as raw bytes so CRLF / BOM content is copied byte-for-byte, not re-encoded through
// a JS string round-trip that could normalize either.
function copyFixtureToml(agentsDir, agentName, fixtureFile) {
  fs.mkdirSync(agentsDir, { recursive: true });
  const raw = fs.readFileSync(path.join(POSTURE_FIXTURES_DIR, fixtureFile));
  fs.writeFileSync(path.join(agentsDir, `${agentName}.toml`), raw);
}

// Row 18a's CRLF fixture is derived at test runtime, never read from a committed file.
// `.gitattributes:2` is `* text=auto eol=lf`, repo-wide and deliberate, so a `\r\n`
// fixture committed to disk is normalized to LF on every commit and every checkout —
// a whole-file CRLF fixture proves nothing about CRLF handling once git has touched it.
// Authoring the LF content inline and converting it here keeps the CRLF-ness under the
// test's control instead of git's. (The BOM fixture is unaffected by eol=lf — a BOM is
// not a line ending — so it stays a committed file.)
function toCrlf(lfContent) {
  return lfContent.replace(/\n/g, '\r\n');
}

// Fault injection for row 21 — monkeypatches node:fs's readFileSync and restores it
// in a `finally` INSIDE this helper (never in a test body, and never chmod 0o000,
// which root bypasses under Docker/CI and would give the test zero real coverage).
function withInjectedReadFailure(targetPath, injectedError, fn) {
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function poisonedReadFileSync(target, ...args) {
    const targetStr = typeof target === 'string' ? target : String(target);
    if (targetStr === targetPath || path.resolve(targetStr) === path.resolve(targetPath)) {
      throw injectedError;
    }
    return realReadFileSync.apply(fs, [target, ...args]);
  };
  try {
    return fn();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

describe('checkCodexModelPosture', () => {
  let tmpDir;
  let agentsDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-posture-check-');
    agentsDir = path.join(tmpDir, 'agents');
    process.env['GSD_AGENTS_DIR'] = agentsDir;
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // # 1 — runtime is not codex: a no-op, not a failure, and it must not even read
  // the filesystem to get there (checkAgentsInstalled's job is presence; this
  // function's job starts only once the runtime is actually codex).
  test('row 1: non-codex runtime (claude) is a no-op — NOT_CODEX, no violations, no fs.readFileSync call', (t) => {
    const reads = [];
    t.mock.method(fs, 'readFileSync', (...args) => {
      reads.push(args[0]);
      throw new Error('unreachable: readFileSync must not be called for a non-codex runtime');
    });

    const result = agentInstallCheck.checkCodexModelPosture('claude', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.strictEqual(result.reason, agentInstallCheck.POSTURE_REASON.NOT_CODEX);
    assert.deepStrictEqual(reads, [], 'non-codex runtime must short-circuit before any file read');
  });

  // # 2 — codex runtime, agents dir absent: distinct from row-3 empty-dir and
  // distinct from a violation. Presence is checkAgentsInstalled's job.
  test('row 2: codex + agents dir absent — AGENTS_DIR_MISSING, not a violation', () => {
    // agentsDir intentionally not created
    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.strictEqual(result.reason, agentInstallCheck.POSTURE_REASON.AGENTS_DIR_MISSING);
  });

  // # 3 — codex runtime, agents dir exists but is empty.
  test('row 3: codex + empty agents dir — ok:true, checked:[]', () => {
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.deepStrictEqual(result.checked, []);
  });

  // # 4 — one clean .toml (no model, no effort key at all).
  test('row 4: clean .toml (no model, no effort) — ok:true, no violations', () => {
    writeAgentToml(
      agentsDir,
      'gsd-clean',
      'name = "gsd-clean"\ndescription = "a clean agent"\ndeveloper_instructions = \'\'\'\nDo the work.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 5 — the base case: a bare Claude tier alias pinned as `model`.
  test('row 5: model = "sonnet" — ANTHROPIC_FLAVORED_MODEL naming the agent and the value', () => {
    writeAgentToml(
      agentsDir,
      'gsd-planner',
      'name = "gsd-planner"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nPlan.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].agent, 'gsd-planner');
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
    assert.ok(result.violations[0].file.endsWith('gsd-planner.toml'));
  });

  // # 6 — table-driven over the full bare-alias set, sourced from model-catalog's
  // CLAUDE_AGENT_ALIASES (not hardcoded) so this can't silently drift from the
  // predicate the design says the posture check consumes.
  for (const alias of CLAUDE_AGENT_ALIASES) {
    test(`row 6: bare Claude alias "${alias}" — ANTHROPIC_FLAVORED_MODEL`, () => {
      writeAgentToml(
        agentsDir,
        'gsd-alias-agent',
        `name = "gsd-alias-agent"\nmodel = "${alias}"\ndeveloper_instructions = '''\nWork.\n'''\n`,
      );

      const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

      assert.strictEqual(result.violations.length, 1);
      assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
      assert.strictEqual(result.violations[0].value, alias);
    });
  }

  // # 7 — table-driven over full Claude model ids across provider namespacings,
  // plus a case-insensitivity check.
  for (const modelId of ['claude-opus-4-5', 'anthropic/claude-x', 'us.anthropic.claude-x', 'CLAUDE-X']) {
    test(`row 7: Claude model id "${modelId}" — ANTHROPIC_FLAVORED_MODEL`, () => {
      writeAgentToml(
        agentsDir,
        'gsd-id-agent',
        `name = "gsd-id-agent"\nmodel = "${modelId}"\ndeveloper_instructions = '''\nWork.\n'''\n`,
      );

      const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

      assert.strictEqual(result.violations.length, 1);
      assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    });
  }

  // # 8 — the rule is Anthropic-flavored, never an allowlist: a real Codex/OpenAI id
  // must never be flagged, however unfamiliar it looks.
  test('row 8: model = "gpt-5.6-sol" — no violation (not an allowlist)', () => {
    writeAgentToml(
      agentsDir,
      'gsd-gpt-agent',
      'name = "gsd-gpt-agent"\nmodel = "gpt-5.6-sol"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 9 — must not go stale on a hypothetical future OpenAI release id.
  test('row 9: model = "some-future-model-id" — no violation', () => {
    writeAgentToml(
      agentsDir,
      'gsd-future-agent',
      'name = "gsd-future-agent"\nmodel = "some-future-model-id"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 10 — #838 coupling: a static reasoning-effort with no model pin means Codex
  // is inheriting the session model while GSD's effort pin silently disagrees.
  test('row 10: model_reasoning_effort with no model — ORPHANED_REASONING_EFFORT', () => {
    writeAgentToml(
      agentsDir,
      'gsd-orphan-agent',
      'name = "gsd-orphan-agent"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ORPHANED_REASONING_EFFORT);
    assert.strictEqual(result.violations[0].agent, 'gsd-orphan-agent');
  });

  // # 11 — the legal pinned pair: model + matching reasoning effort is intentional.
  test('row 11: model + model_reasoning_effort, model legal — no violation', () => {
    writeAgentToml(
      agentsDir,
      'gsd-pinned-agent',
      'name = "gsd-pinned-agent"\nmodel = "gpt-5-codex"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 12 — NEGATIVE PROOF. Catches: over-generalizing the #838 model/effort
  // coupling rule to service_tier/model_verbosity too. Those are #774's
  // cost/verbosity knobs and are decoupled from `model` by design — an
  // implementation that treats "any knob present without model" as orphaned
  // fails this row.
  test('row 12 (negative proof): service_tier + model_verbosity, no model — no violation', () => {
    writeAgentToml(
      agentsDir,
      'gsd-light-agent',
      'name = "gsd-light-agent"\nservice_tier = "flex"\nmodel_verbosity = "low"\ndeveloper_instructions = \'\'\'\nWork fast.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 13 — NEGATIVE PROOF. Catches: implementing the check as a whitelist over the
  // whole TOML document (flagging any key GSD doesn't itself emit) instead of a
  // predicate on exactly the two fields the posture owns (`model`,
  // `model_reasoning_effort`). A hand-added `approval_policy` is legitimate and
  // must never be flagged.
  test('row 13 (negative proof): extra hand-added key (approval_policy) — no violation', () => {
    writeAgentToml(
      agentsDir,
      'gsd-custom-agent',
      'name = "gsd-custom-agent"\napproval_policy = "on-request"\ndeveloper_instructions = \'\'\'\nFollow policy.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 14 — NEGATIVE PROOF, the headline trap. Catches: scanning the WHOLE file with
  // a line-oriented `/^model\s*=/m` instead of only the header slice (the lines
  // before `developer_instructions = '''`). The fixture below contains a literal,
  // unindented `model = "sonnet"` line INSIDE the developer_instructions block —
  // verified (see PR description / dispatch notes) to trip a naive whole-file
  // regex scan (`/^model\s*=/m.test(wholeFile) === true`) while the correct
  // header-slice scan sees nothing (`/^model\s*=/m.test(headerOnly) === false`).
  // If this test passed against a whole-file scanner it would prove nothing; it
  // must fail against one.
  test('row 14 (negative proof, headline): model = inside developer_instructions block — no violation', () => {
    copyFixtureToml(agentsDir, 'gsd-planner', 'model-in-developer-instructions.toml');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 15 — NEGATIVE PROOF. Catches: a header-slice scan that doesn't skip comment
  // lines, so a commented-out `# model = "sonnet"` still counts as a live pin.
  test('row 15 (negative proof): commented-out model pin — no violation', () => {
    copyFixtureToml(agentsDir, 'gsd-reviewer', 'commented-model-pin.toml');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 16 — NEGATIVE PROOF. Catches: probing for the key by substring/prefix
  // (e.g. a bare `/model/` test) instead of anchoring on the full key name, so
  // `model_verbosity` gets misidentified as a `model` pin.
  test('row 16 (negative proof): model_verbosity only (key-prefix collision) — no violation', () => {
    copyFixtureToml(agentsDir, 'gsd-analyst', 'model-verbosity-prefix-collision.toml');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 17 — boundary: whitespace around a REAL key must still be recognized as a pin.
  test('row 17: indented / inner-spaced model pin — IS a violation', () => {
    copyFixtureToml(agentsDir, 'gsd-tester', 'whitespace-indented-model-pin.toml');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // # 18 — cross-platform: CRLF and BOM must parse identically to plain LF.
  test('row 18a: CRLF file with a pinned model — parsed identically to LF (still a violation)', () => {
    const lfContent =
      'name = "gsd-scribe"\ndescription = "Writes changelog entries from merged PRs"\n' +
      'model = "sonnet"\ndeveloper_instructions = \'\'\'\n' +
      'Write a changelog entry summarizing the merged pull request.\n\'\'\'\n';
    writeAgentToml(agentsDir, 'gsd-scribe', toCrlf(lfContent));

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  test('row 18b: BOM-prefixed file with a pinned model — parsed identically to a BOM-free file', () => {
    copyFixtureToml(agentsDir, 'gsd-archivist', 'bom-pinned-model.toml');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // # 19 — independence: multiple agents, some violating; deterministic order;
  // clean agents are simply absent from violations (not present-but-empty).
  test('row 19: several agents, some violating — one entry per offender, deterministic order, clean absent', () => {
    writeAgentToml(
      agentsDir,
      'gsd-alpha',
      'name = "gsd-alpha"\ndeveloper_instructions = \'\'\'\nClean.\n\'\'\'\n',
    );
    writeAgentToml(
      agentsDir,
      'gsd-bravo',
      'name = "gsd-bravo"\nmodel = "opus"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );
    writeAgentToml(
      agentsDir,
      'gsd-charlie',
      'name = "gsd-charlie"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 2);
    assert.strictEqual(result.violations[0].agent, 'gsd-bravo');
    assert.strictEqual(result.violations[1].agent, 'gsd-charlie');
    assert.ok(
      !result.violations.some((v) => v.agent === 'gsd-alpha'),
      'clean agent must not appear in violations at all',
    );
    assert.strictEqual(result.checked.length, 3);
  });

  // ─── Reviewer-found false negatives (quoted keys; block-marker truncation) ──
  //
  // Both defects are false negatives — checkCodexModelPosture reported ok:true
  // when a real pin was present. Each test below is red against the
  // implementation this PR replaces; see the PR description for exactly which
  // assertion fails against each.

  // Defect 1: a quoted TOML key (`"model" = ...`) is legal TOML and was invisible
  // to a key regex that required a bare identifier.
  test('quoted key "model" = "sonnet" (double-quoted) — still ANTHROPIC_FLAVORED_MODEL', () => {
    writeAgentToml(
      agentsDir,
      'gsd-quoted-double',
      'name = "gsd-quoted-double"\n"model" = "sonnet"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  test("quoted key 'model' = \"sonnet\" (single-quoted) — still ANTHROPIC_FLAVORED_MODEL", () => {
    writeAgentToml(
      agentsDir,
      'gsd-quoted-single',
      'name = "gsd-quoted-single"\n\'model\' = "sonnet"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // Defect 2a: the block marker used to be found by an unanchored whole-content
  // search, so a `description` value that merely quotes the marker text earlier
  // in the file truncated the header before a real, later `model` pin.
  test('a description value quoting the marker text does not hide a real model pin before it', () => {
    writeAgentToml(
      agentsDir,
      'gsd-decoy-marker',
      'name = "gsd-decoy-marker"\n' +
        'description = "mentions developer_instructions = \'\'\' as an example string"\n' +
        'model = "sonnet"\n' +
        'developer_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // Defect 2b: the old implementation only ever scanned the slice BEFORE the
  // marker, so a hand-reordered file with `model` placed AFTER the
  // developer_instructions block (still legal TOML) was never scanned at all.
  test('a model pin placed AFTER the developer_instructions block is still flagged', () => {
    writeAgentToml(
      agentsDir,
      'gsd-reordered',
      'name = "gsd-reordered"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\nmodel = "sonnet"\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // Defect-2 boundary: no developer_instructions block at all — every line must
  // be scanned. NOTE: a bare-key version of this fixture is already green
  // against the pre-fix implementation (its no-marker fallback already scanned
  // the whole file), so this uses a quoted key to keep the assertion genuinely
  // red pre-fix (via defect 1) while proving the no-block path is fully scanned.
  test('a file with no developer_instructions block at all is fully scanned', () => {
    writeAgentToml(
      agentsDir,
      'gsd-noblock',
      'name = "gsd-noblock"\ndescription = "no prompt block on this agent"\n"model" = "sonnet"\n',
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // # 21 — filesystem failure: an unreadable .toml is reported, not thrown, and
  // does not abort checking the rest of the agents. Injected via fs.readFileSync
  // monkeypatch/restore (see withInjectedReadFailure) rather than chmod 0o000,
  // which root bypasses under Docker/CI.
  test('row 21: unreadable .toml (EACCES) — UNREADABLE violation naming the file, other agents still checked, no throw', () => {
    writeAgentToml(agentsDir, 'gsd-bad', 'name = "gsd-bad"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');
    writeAgentToml(agentsDir, 'gsd-good', 'name = "gsd-good"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');
    const badPath = path.join(agentsDir, 'gsd-bad.toml');
    const injected = Object.assign(new Error('injected EACCES'), { code: 'EACCES' });

    const result = withInjectedReadFailure(badPath, injected, () =>
      agentInstallCheck.checkCodexModelPosture('codex', tmpDir),
    );

    assert.strictEqual(result.ok, false);
    const unreadable = result.violations.find((v) => v.agent === 'gsd-bad');
    assert.ok(unreadable, 'unreadable file must produce a named violation, not a silent skip');
    assert.strictEqual(unreadable.reason, agentInstallCheck.POSTURE_REASON.UNREADABLE);
    assert.ok(unreadable.file.endsWith('gsd-bad.toml'));
    assert.strictEqual(result.checked.length, 2, 'the unreadable file must still be counted as checked');
    assert.ok(
      !result.violations.some((v) => v.agent === 'gsd-good'),
      'the still-readable sibling must be checked and found clean',
    );
  });

  // Security review (#3242, MEDIUM): readdirSync + readFileSync followed symlinks,
  // so a symlink in the agents directory pointing at an arbitrary file could have
  // that file's content echoed into a violation's `value` field. Fixed by lstat-
  // filtering to regular files only, matching cmdEffortSync's existing symlink
  // guard in commands.cts. Symlinks are silently excluded (not reported), same
  // as cmdEffortSync — see agent-install-check.cts inline comment for why.
  test('symlink pointing at a file containing model = "sonnet" is never read — no violation names that value', (t) => {
    const targetPath = path.join(tmpDir, 'outside-target.toml');
    fs.writeFileSync(targetPath, 'model = "sonnet"\n');
    fs.mkdirSync(agentsDir, { recursive: true });
    const symlinkPath = path.join(agentsDir, 'gsd-linked.toml');
    try {
      fs.symlinkSync(targetPath, symlinkPath, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw error;
    }

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.deepStrictEqual(result.checked, [], 'the symlinked entry must not appear in checked');
  });

  test('broken symlink in agents dir does not crash the scan — other agents still checked', (t) => {
    fs.mkdirSync(agentsDir, { recursive: true });
    const brokenTarget = path.join(tmpDir, 'does-not-exist.toml');
    const brokenSymlink = path.join(agentsDir, 'gsd-broken.toml');
    try {
      fs.symlinkSync(brokenTarget, brokenSymlink, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw error;
    }
    writeAgentToml(agentsDir, 'gsd-good', 'name = "gsd-good"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');

    let result;
    assert.doesNotThrow(() => {
      result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.deepStrictEqual(result.checked, ['gsd-good'], 'the broken symlink must be excluded, the other agent still checked');
  });

  test('a regular .toml file is still scanned normally (guard against over-filtering)', () => {
    writeAgentToml(agentsDir, 'gsd-planner', 'name = "gsd-planner"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.checked, ['gsd-planner']);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].reason, agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL);
    assert.strictEqual(result.violations[0].value, 'sonnet');
  });

  // # 22 — boundary: empty / whitespace-only .toml pins nothing.
  test('row 22: empty / whitespace-only .toml — no violation', () => {
    writeAgentToml(agentsDir, 'gsd-blank', '   \n\n\t\n');

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
  });

  // # 23 — hostile: an oversized (secret-shaped) model value must be truncated at
  // 64 chars, matching bin/install.js's _warnCodexModelOverrideDropped truncation
  // (`slice(0, 64) + '…'`) so an oversized/secret-shaped value cannot reach logs
  // in full.
  test('row 23: oversized model value — truncated at 64 chars, matching the installer cap', () => {
    const oversized = `claude-${'x'.repeat(80)}`; // 87 chars, Anthropic-flavored (contains "claude")
    writeAgentToml(
      agentsDir,
      'gsd-oversized-agent',
      `name = "gsd-oversized-agent"\nmodel = "${oversized}"\ndeveloper_instructions = '''\nWork.\n'''\n`,
    );

    const result = agentInstallCheck.checkCodexModelPosture('codex', tmpDir);

    assert.strictEqual(result.violations.length, 1);
    const { value } = result.violations[0];
    assert.ok(value.length <= 65, `expected value capped at 64 chars (+ ellipsis), got length ${value.length}`);
    assert.notStrictEqual(value, oversized, 'the full oversized value must not reach the violation untruncated');
    assert.strictEqual(value, `${oversized.slice(0, 64)}…`);
  });

  // # 25 — NEGATIVE PROOF. Catches: gating the runtime no-op AFTER already
  // scanning the agents directory (e.g. deciding what to report only at the end),
  // instead of short-circuiting before any file is read. A stray .toml that WOULD
  // trip a violation if inspected must never be inspected for a non-codex runtime.
  test('row 25 (negative proof): non-codex runtime with a stray violating .toml present — still NOT_CODEX, file never inspected', (t) => {
    writeAgentToml(
      agentsDir,
      'gsd-stray',
      'name = "gsd-stray"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );
    const reads = [];
    t.mock.method(fs, 'readFileSync', (...args) => {
      reads.push(args[0]);
      throw new Error('unreachable: readFileSync must not be called for a non-codex runtime');
    });

    const result = agentInstallCheck.checkCodexModelPosture('opencode', tmpDir);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.strictEqual(result.reason, agentInstallCheck.POSTURE_REASON.NOT_CODEX);
    assert.deepStrictEqual(reads, [], 'the stray violating file must never be read for a non-codex runtime');
  });
});

// # 24 — enum lock: adding a POSTURE_REASON value is a deliberate three-way
// coordinated change (enum, emitting site, this test), not a silent drift. Locks
// the exact key set, matching the repo's established shape for reason enums
// (see verify-reapply-patches.cjs's REASON).
describe('POSTURE_REASON enum', () => {
  test('row 24: Object.keys(POSTURE_REASON).sort() is locked', () => {
    assert.deepStrictEqual(
      Object.keys(agentInstallCheck.POSTURE_REASON).sort(),
      [
        'AGENTS_DIR_MISSING',
        'ANTHROPIC_FLAVORED_MODEL',
        'NOT_CODEX',
        'ORPHANED_REASONING_EFFORT',
        'UNREADABLE',
      ].sort(),
    );
  });

  test('POSTURE_REASON values are the frozen snake_case wire form, not prose', () => {
    assert.strictEqual(agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL, 'anthropic_flavored_model');
    assert.strictEqual(agentInstallCheck.POSTURE_REASON.ORPHANED_REASONING_EFFORT, 'orphaned_reasoning_effort');
    assert.strictEqual(agentInstallCheck.POSTURE_REASON.UNREADABLE, 'unreadable');
    assert.strictEqual(agentInstallCheck.POSTURE_REASON.NOT_CODEX, 'not_codex');
    assert.strictEqual(agentInstallCheck.POSTURE_REASON.AGENTS_DIR_MISSING, 'agents_dir_missing');
    assert.ok(Object.isFrozen(agentInstallCheck.POSTURE_REASON));
  });
});

// # 20 — keystone wiring: a library that works but is never called from the
// user-reachable command surface is the keystone-unwired failure the coverage
// gate exists to catch. Drives cmdValidateAgents directly (the same seam
// tests/verify.test.cjs already uses for cmdValidateHealth) and asserts through
// the command's structured JSON output — captured by monkeypatching
// node:fs.writeSync, the exact seam tests/io.test.cjs already establishes for
// io.cjs's output(), which writes via writeAllSync(1, ...) → fs.writeSync, NOT
// console.log — rather than calling checkCodexModelPosture a second time.
describe('cmdValidateAgents surfaces the Codex posture result (#3242 row 20)', () => {
  let tmpDir;
  let agentsDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-posture-wiring-');
    agentsDir = path.join(tmpDir, 'agents');
    process.env['GSD_AGENTS_DIR'] = agentsDir;
    process.env['GSD_RUNTIME'] = 'codex';
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('row 20: validate agents output carries the posture result for a violating install', () => {
    const { cmdValidateAgents } = require(
      path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs'),
    );
    writeAgentToml(
      agentsDir,
      EXPECTED_AGENTS[0],
      `name = "${EXPECTED_AGENTS[0]}"\nmodel = "sonnet"\ndeveloper_instructions = '''\nWork.\n'''\n`,
    );

    const written = captureFdSync(1, () => cmdValidateAgents(tmpDir, false));

    const parsed = JSON.parse(written);
    assert.ok(
      parsed.codex_posture,
      `expected cmdValidateAgents output to carry a codex_posture key, got keys: ${Object.keys(parsed).join(', ')}`,
    );
    assert.strictEqual(parsed.codex_posture.ok, false);
    assert.strictEqual(parsed.codex_posture.violations.length, 1);
    assert.strictEqual(parsed.codex_posture.violations[0].agent, EXPECTED_AGENTS[0]);
    assert.strictEqual(
      parsed.codex_posture.violations[0].reason,
      agentInstallCheck.POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL,
    );
  });
});

// ─── #2872 (ADR-2866 Phase 3): checkAgentsInstalled unchanged by the ──────
// manifest-reader de-duplication (50-test-matrix.md section 5, rows A1-A5)
//
// installer-migrations.cts's readInstallManifest now records manifestVersion
// /runtime/scope, but checkAgentsInstalled only ever consumed `.files`
// before AND after the substitution (agent-install-check.cts:191-194
// swapped an inlined try/readFileSync/JSON.parse for the shared reader,
// zero new branches) — see 40-design.md's "Rejected" #4 for why this
// function is not rewired onto the two-scope resolver instead. These rows
// prove the substitution changed nothing observable here.
describe('checkAgentsInstalled — unchanged by the manifest-reader substitution (#2872 A1-A5)', () => {
  describe('A1-A4: v1/v2 manifest parity', () => {
    let tmpDir;
    let agentsDir;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-agent-check-schema-');
      agentsDir = path.join(tmpDir, 'agents');
      process.env['GSD_AGENTS_DIR'] = agentsDir;
      fs.mkdirSync(agentsDir, { recursive: true });
      for (const agent of EXPECTED_AGENTS) {
        fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
      }
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    // A1 — a v1 manifest (no manifestVersion/runtime/scope key at all)
    // beside the agents dir: result identical to pre-#2872 behavior.
    test('A1: checkAgentsInstalled is unchanged for a v1 manifest', () => {
      const manifestFiles = {};
      for (const agent of EXPECTED_AGENTS) manifestFiles[`agents/${agent}.md`] = 'somehash';
      fs.writeFileSync(
        path.join(tmpDir, 'gsd-file-manifest.json'),
        JSON.stringify({
          version: '1.49.0',
          timestamp: '2026-05-10T00:00:00.000Z',
          mode: 'full',
          files: manifestFiles,
        }),
      );

      const result = agentInstallCheck.checkAgentsInstalled();
      assert.strictEqual(result.agents_installed, true);
      assert.deepStrictEqual(result.missing_agents, []);
      assert.deepStrictEqual(result.incomplete_agents, []);
    });

    // A2 — a v2 manifest (carrying manifestVersion/runtime/scope) produces
    // the exact same result: the new fields change nothing here.
    test('A2: checkAgentsInstalled is unchanged for a v2 manifest', () => {
      const manifestFiles = {};
      for (const agent of EXPECTED_AGENTS) manifestFiles[`agents/${agent}.md`] = 'somehash';
      fs.writeFileSync(
        path.join(tmpDir, 'gsd-file-manifest.json'),
        JSON.stringify({
          manifestVersion: 2,
          version: '1.60.0',
          timestamp: '2026-08-01T00:00:00.000Z',
          mode: 'full',
          runtime: 'claude',
          scope: 'global',
          files: manifestFiles,
        }),
      );

      const result = agentInstallCheck.checkAgentsInstalled();
      assert.strictEqual(result.agents_installed, true);
      assert.deepStrictEqual(result.missing_agents, []);
      assert.deepStrictEqual(result.incomplete_agents, []);
    });

    // A3 — no manifest at all (readInstallManifest's absent-file branch):
    // the completeness check is skipped, no throw — today's behavior.
    // Presence (the .md files above) still makes the install look complete.
    test('A3: an unreadable/absent manifest still skips the completeness check', () => {
      let result;
      assert.doesNotThrow(() => {
        result = agentInstallCheck.checkAgentsInstalled();
      });
      assert.deepStrictEqual(result.incomplete_agents, []);
      assert.strictEqual(result.agents_installed, true);
    });

    // A4 — manifest present, one agent's .toml tracked but absent on disk:
    // still reported as incomplete, same as before the substitution.
    test('A4: still reports an incomplete agent', () => {
      const targetAgent = EXPECTED_AGENTS[0];
      const manifestFiles = {};
      for (const agent of EXPECTED_AGENTS) manifestFiles[`agents/${agent}.md`] = 'somehash';
      manifestFiles[`agents/${targetAgent}.toml`] = 'somehash';
      fs.writeFileSync(
        path.join(tmpDir, 'gsd-file-manifest.json'),
        JSON.stringify({
          manifestVersion: 2,
          version: '1.60.0',
          timestamp: '2026-08-01T00:00:00.000Z',
          mode: 'full',
          runtime: 'claude',
          scope: 'global',
          files: manifestFiles,
        }),
      );

      const result = agentInstallCheck.checkAgentsInstalled();
      assert.ok(
        result.incomplete_agents.includes(targetAgent),
        `expected ${targetAgent} in incomplete_agents, got: ${JSON.stringify(result.incomplete_agents)}`,
      );
      assert.strictEqual(result.agents_installed, false);
    });
  });

  // A5 — getAgentsDir's local-install probe is deliberately NOT rewired to
  // readInstallManifest: it stays an lstat-based (symlink-unaware) presence
  // check (agent-install-check.cts:123, "Not touched" in 40-design.md's
  // blast-radius table), so a manifest path that is itself a SYMLINK is
  // still ignored, exactly as before the substitution.
  test('A5: getAgentsDir still ignores a symlinked manifest', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-schema-');
    const globalHome = createTempDir('gsd-global-codex-schema-');
    const localConfigDir = path.join(projectRoot, '.codex');
    const localAgentsDir = path.join(localConfigDir, 'agents');
    const realManifestTarget = path.join(projectRoot, 'real-manifest.json');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(localAgentsDir, { recursive: true });
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(localAgentsDir, `${agent}.toml`), `name = "${agent}"\n`);
    }
    fs.writeFileSync(realManifestTarget, JSON.stringify({ files: {} }));
    const manifestPath = path.join(localConfigDir, 'gsd-file-manifest.json');
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;
    try {
      fs.symlinkSync(realManifestTarget, manifestPath, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw error;
    }

    // getAgentsDir's own probe (`fs.lstatSync(manifestPath).isFile()`) sees
    // the manifest path as a symlink, not a regular file — isFile() is false
    // for the link itself even though its target is a regular file — so the
    // local install is NOT selected; the global fallback wins instead.
    assert.strictEqual(agentInstallCheck.getAgentsDir('codex', projectRoot), path.join(globalHome, 'agents'));
    assert.notStrictEqual(agentInstallCheck.getAgentsDir('codex', projectRoot), localAgentsDir);
  });
});

// ─── 4. Sandbox-mode drift (#3897 rung 3, ADR-3473 §8.3 criterion 3) ──────────
//
// Spec: .gsd/phase/feat-3897-adr3473-83-rungs/{40-design,50-test-matrix}.md, S8/T28.
//
// `checkAgentsInstalled` above (and `checkCodexModelPosture`, the established
// sibling pattern for a codex-only posture check — #3242, "A new sibling
// export... presence is checkAgentsInstalled's job; this function's job starts
// only once the runtime is confirmed codex and only inspects posture") checks
// FILE PRESENCE and MANIFEST COMPLETENESS only. Neither inspects whether an
// installed .toml's `sandbox_mode` line agrees with what that role's tool
// contract says it should be — a TOML that disagrees passes `validate agents`
// today. `checkCodexSandboxPosture` is this test's anticipated name for the new
// sibling check (mirroring `checkCodexModelPosture`'s exact shape); the exact
// export name is the implementer's call, but the export MUST exist for this
// row's acceptance criterion (§8.3 criterion 3) to be met.
//
// RED today: the export does not exist at all.
describe('checkCodexSandboxPosture (#3897 rung 3 — not yet implemented, RED until it lands)', () => {
  test('T28 validateAgentsFailsOnSandboxDrift_3897: a TOML whose sandbox_mode disagrees with the derived expectation must fail, naming role/expected/found', (t) => {
    const globalHome = createTempDir('gsd-sandbox-drift-');
    t.after(() => cleanup(globalHome));
    const agentsDir = path.join(globalHome, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // gsd-executor declares tools: Read, Write, Edit (agents/gsd-executor.md) —
    // it MUST derive workspace-write. Install a drifted TOML claiming
    // read-only instead, matching the shape generateCodexAgentToml emits.
    fs.writeFileSync(
      path.join(agentsDir, 'gsd-executor.toml'),
      'name = "gsd-executor"\ndescription = "Executes plans"\nsandbox_mode = "read-only"\n' +
      "developer_instructions = '''\nExecute.\n'''\n",
    );
    for (const agent of EXPECTED_AGENTS) {
      if (agent === 'gsd-executor') continue;
      fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
    }
    process.env['CODEX_HOME'] = globalHome;

    assert.equal(
      typeof agentInstallCheck.checkCodexSandboxPosture,
      'function',
      'agent-install-check.cjs must export a sandbox-posture check (#3897 rung 3, ADR-3473 §8.3 criterion 3) — it does not exist yet, so a drifted sandbox_mode currently passes validate agents silently',
    );

    const result = agentInstallCheck.checkCodexSandboxPosture('codex');
    assert.equal(
      result.ok,
      false,
      'a TOML whose sandbox_mode disagrees with the expected derived value must fail the check',
    );
    const violation = result.violations.find((v) => v.agent === 'gsd-executor');
    assert.ok(violation, 'the violation must name the drifted agent');
    assert.equal(violation.expected, 'workspace-write', 'the violation must name the EXPECTED sandbox_mode');
    assert.equal(violation.found, 'read-only', 'the violation must name the FOUND (installed) sandbox_mode');
  });

  // #3897 rung 4 (isolated correctness review, MINOR finding 2): `found` used
  // to be read via a naive whole-file regex, unlike the block-aware scanner
  // the sibling checkCodexModelPosture uses. Reviewer's fixture: no header
  // sandbox_mode pin at all, but a `sandbox_mode = "..."`-shaped line INSIDE
  // the developer_instructions block (prose a role's own prompt might
  // legitimately discuss). The naive regex misread that prose as a live
  // value and manufactured a FALSE violation.
  test('a sandbox_mode-shaped line INSIDE developer_instructions is never read as a live value (no false violation)', (t) => {
    const globalHome = createTempDir('gsd-sandbox-block-aware-');
    t.after(() => cleanup(globalHome));
    const agentsDir = path.join(globalHome, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // gsd-nyquist-auditor's real canonical tools: declares Write/Edit, so the
    // derived expectation is workspace-write. Install a TOML that correctly
    // has NO header sandbox_mode pin, but whose developer_instructions block
    // contains a line that is shaped exactly like a live sandbox_mode pin.
    fs.writeFileSync(
      path.join(agentsDir, 'gsd-nyquist-auditor.toml'),
      'name = "gsd-nyquist-auditor"\ndescription = "Fills Nyquist validation gaps"\n' +
      "developer_instructions = '''\n" +
      'When configuring the sandbox, use:\n' +
      'sandbox_mode = "workspace-write"\n' +
      "'''\n",
    );
    for (const agent of EXPECTED_AGENTS) {
      if (agent === 'gsd-nyquist-auditor') continue;
      fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
    }
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkCodexSandboxPosture('codex');
    const violation = result.violations.find((v) => v.agent === 'gsd-nyquist-auditor');
    assert.equal(
      violation,
      undefined,
      'a sandbox_mode-shaped line inside developer_instructions must never be read as the installed value — it must not manufacture a violation for an agent with no real header pin',
    );
  });

  // #3897 rung 4 (isolated correctness review, MINOR finding 3):
  // truncatePostureValue exists at agent-install-check.cts precisely for
  // this, and the model-posture sibling applies it — the sandbox check did
  // not, so an oversized (or secret-shaped) sandbox_mode value could reach
  // `validate agents --raw` output at full length.
  test('an oversized sandbox_mode value is truncated in the emitted violation (CLI JSON)', (t) => {
    const globalHome = createTempDir('gsd-sandbox-truncate-');
    t.after(() => cleanup(globalHome));
    const agentsDir = path.join(globalHome, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const oversized = 'x'.repeat(300);
    fs.writeFileSync(
      path.join(agentsDir, 'gsd-executor.toml'),
      `name = "gsd-executor"\ndescription = "Executes plans"\nsandbox_mode = "${oversized}"\n` +
      "developer_instructions = '''\nExecute.\n'''\n",
    );
    for (const agent of EXPECTED_AGENTS) {
      if (agent === 'gsd-executor') continue;
      fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
    }
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkCodexSandboxPosture('codex');
    const violation = result.violations.find((v) => v.agent === 'gsd-executor');
    assert.ok(violation, 'the violation must name the drifted agent');
    assert.ok(
      violation.found.length <= 65,
      `violation.found must be truncated (<=64 chars + ellipsis), got length ${violation.found.length}`,
    );
    assert.ok(violation.found.endsWith('…'), 'a truncated value must end with the ellipsis marker');

    // The full-length value must never reach the emitted JSON at all.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(oversized), 'the untruncated 300-char value must never appear in the emitted CLI JSON');
  });
});

// T29 (validate agents still fails when a file is missing, S9) is intentionally
// NOT duplicated here — it is already covered by the existing "missing dir"
// coverage documented in this file's own header comment ("missing dir →
// agents_installed:false, missing_agents = all expected") and exercised above.
// It must stay green; nothing in this rung touches that path.
