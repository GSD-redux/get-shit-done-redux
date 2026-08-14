process.env.GSD_TEST_MODE = '1';

/**
 * Per-plan executor routing via `agent_hint:` frontmatter (#1689, Option A).
 *
 * Coverage:
 *   - resolveAgentHint() unit: resolves specialists present in the active
 *     runtime's agent dir(s); falls back to null for absent names. Filename
 *     variants (.md, .agent.md, .toml).
 *   - `gsd-tools resolve-agent` route: --raw / --json output, fail-closed to
 *     gsd-executor.
 *   - phase-plan-index data path: `agent_hint` is parsed into plan JSON (null
 *     when unset) so the orchestrator reads it from plan_json.
 *   - execute-phase.md host wiring: a lean per-plan reference + the
 *     `{EXECUTOR_TYPE}` placeholder, with all detail in the step fragment
 *     (ADR-857 Phase 6 byte-budget conformance).
 *   - workflow.agent_hint_routing config key: default-on (SCHEMA_DEFAULTS),
 *     boolean-validated, settable.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const FRAGMENT_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'per-plan-executor-routing.md');
const { resolveAgentHint } = require('../gsd-core/bin/lib/agent-install-check.cjs');

// A name unlikely to collide with a real shipped agent, so the global agent dir
// (~/.claude/agents) never produces a false positive during resolution tests.
const SPECIALIST = 'zzz-test-specialist-1689';
const SPECIALIST_TOML = 'zzz-test-specialist-toml-1689';

let tmpAgentsRoot;
let savedAgentsDir;

before(() => {
  tmpAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-1689-'));
  savedAgentsDir = process.env.GSD_AGENTS_DIR;
});

after(() => {
  if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
  else process.env.GSD_AGENTS_DIR = savedAgentsDir;
  cleanup(tmpAgentsRoot);
});

describe('#1689 resolveAgentHint() — runtime agent-dir resolution', () => {
  test('empty / whitespace name never resolves (returns null)', () => {
    process.env.GSD_AGENTS_DIR = tmpAgentsRoot;
    assert.equal(resolveAgentHint('', 'claude'), null);
    assert.equal(resolveAgentHint('   ', 'claude'), null);
  });

  test('resolves a specialist present as <name>.md in the agent dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-md-'));
    process.env.GSD_AGENTS_DIR = dir;
    fs.writeFileSync(path.join(dir, `${SPECIALIST}.md`), '---\nname: ' + SPECIALIST + '\n---\nbody\n');
    try {
      assert.equal(resolveAgentHint(SPECIALIST, 'claude'), SPECIALIST);
    } finally {
      cleanup(dir);
    }
  });

  test('resolves a specialist present as <name>.toml (codex variant)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-toml-'));
    process.env.GSD_AGENTS_DIR = dir;
    fs.writeFileSync(path.join(dir, `${SPECIALIST_TOML}.toml`), 'name = "' + SPECIALIST_TOML + '"\n');
    try {
      assert.equal(resolveAgentHint(SPECIALIST_TOML, 'codex'), SPECIALIST_TOML);
    } finally {
      cleanup(dir);
    }
  });

  test('returns null when the named agent does not resolve (fallback signal)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-empty-'));
    process.env.GSD_AGENTS_DIR = dir;
    try {
      assert.equal(resolveAgentHint('definitely-not-installed-1689', 'claude'), null);
    } finally {
      cleanup(dir);
    }
  });

  test('resolves a specialist present as <name>.agent.md (copilot variant)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-copilot-'));
    process.env.GSD_AGENTS_DIR = dir;
    const name = 'zzz-test-specialist-copilot-1689';
    fs.writeFileSync(path.join(dir, `${name}.agent.md`), '---\nname: ' + name + '\n---\n');
    try {
      assert.equal(resolveAgentHint(name, 'copilot'), name);
    } finally {
      cleanup(dir);
    }
  });

  test('rejects path-traversing names so they cannot escape the agents dir', () => {
    process.env.GSD_AGENTS_DIR = tmpAgentsRoot;
    assert.equal(resolveAgentHint('../../README', 'claude'), null);
    assert.equal(resolveAgentHint('a/b', 'claude'), null);
    assert.equal(resolveAgentHint('..', 'claude'), null);
  });
});

describe('#1689 gsd-tools resolve-agent route', () => {
  test('--raw: echoes the name when the specialist resolves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-route-'));
    fs.writeFileSync(path.join(dir, `${SPECIALIST}.md`), '---\nname: ' + SPECIALIST + '\n---\n');
    try {
      const r = runGsdTools(['resolve-agent', '--name', SPECIALIST, '--raw'], dir, { GSD_AGENTS_DIR: dir });
      assert.equal(r.exitCode, 0);
      assert.equal(r.output.trim(), SPECIALIST);
    } finally {
      cleanup(dir);
    }
  });

  test('--raw: falls back to gsd-executor when the name does not resolve', () => {
    const r = runGsdTools(['resolve-agent', '--name', 'no-such-agent-1689', '--raw'], tmpAgentsRoot, { GSD_AGENTS_DIR: tmpAgentsRoot });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.trim(), 'gsd-executor');
  });

  test('--raw: falls back to gsd-executor for a path-traversing name (fail-closed)', () => {
    const r = runGsdTools(['resolve-agent', '--name', '../../README', '--raw'], tmpAgentsRoot, { GSD_AGENTS_DIR: tmpAgentsRoot });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.trim(), 'gsd-executor');
  });

  test('--raw: falls back to gsd-executor when --name is missing', () => {
    const r = runGsdTools(['resolve-agent', '--raw'], tmpAgentsRoot, { GSD_AGENTS_DIR: tmpAgentsRoot });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.trim(), 'gsd-executor');
  });

  test('--json: resolved (fallback=false) vs fell-back (fallback=true)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agents-json-'));
    fs.writeFileSync(path.join(dir, `${SPECIALIST}.md`), '---\nname: ' + SPECIALIST + '\n---\n');
    try {
      const ok = runGsdTools(['resolve-agent', '--name', SPECIALIST, '--json'], dir, { GSD_AGENTS_DIR: dir });
      const okJson = JSON.parse(ok.output);
      assert.equal(okJson.resolved, SPECIALIST);
      assert.equal(okJson.fallback, false);

      const bad = runGsdTools(['resolve-agent', '--name', 'no-such-agent-1689', '--json'], dir, { GSD_AGENTS_DIR: dir });
      const badJson = JSON.parse(bad.output);
      assert.equal(badJson.resolved, 'gsd-executor');
      assert.equal(badJson.fallback, true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('#1689 phase-plan-index data path — agent_hint flows into plan JSON', () => {
  function writePlan(projectDir, phase, file, fmFields) {
    const phaseDir = path.join(projectDir, '.planning', 'phases', phase);
    fs.mkdirSync(phaseDir, { recursive: true });
    const entries = Object.entries({ phase, plan: '"01"', type: 'execute', wave: 1, depends_on: '[]', files_modified: '[]', autonomous: true, ...fmFields });
    const fm = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
    const body =
      '---\n' +
      fm + '\n' +
      'must_haves:\n' +
      '  truths: []\n' +
      '  artifacts: []\n' +
      '---\n# plan\n';
    fs.writeFileSync(path.join(phaseDir, file), body);
  }

  test('a plan with agent_hint surfaces the value; a plan without surfaces null', () => {
    const project = createTempProject('gsd-1689-planidx-');
    try {
      writePlan(project, '01-test', '01-01-PLAN.md', { agent_hint: 'well-me-flutter-engineer' });
      writePlan(project, '01-test', '01-02-PLAN.md', {});
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const byId = Object.fromEntries(idx.plans.map((p) => [p.id, p]));
      assert.equal(byId['01-01'].agent_hint, 'well-me-flutter-engineer');
      assert.equal(byId['01-02'].agent_hint, null);
    } finally {
      cleanup(project);
    }
  });
});

describe('#1689 execute-phase.md host wiring (byte-budget-lean; detail in fragment)', () => {
  test('host references the per-plan routing fragment and uses the {EXECUTOR_TYPE} placeholder', () => {
    const host = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(host.includes('per-plan-executor-routing.md'), 'host must reference the routing fragment');
    assert.ok(host.includes('subagent_type="{EXECUTOR_TYPE}"'), 'host dispatch template must use the {EXECUTOR_TYPE} placeholder');
    // The bulky resolution logic lives in the fragment, NOT inline (ADR-857 Phase 6).
    assert.ok(!/\bgsd_run query resolve-agent\b/.test(host), 'resolution detail (resolve-agent call) must live in the fragment, not the host');
  });

  test('the routing fragment exists and carries the resolution contract', () => {
    assert.ok(fs.existsSync(FRAGMENT_PATH), 'per-plan-executor-routing.md fragment must exist');
    const frag = fs.readFileSync(FRAGMENT_PATH, 'utf-8');
    assert.ok(frag.includes('EXECUTOR_TYPE'), 'fragment must set EXECUTOR_TYPE');
    assert.ok(frag.includes('gsd_run query resolve-agent'), 'fragment must call the resolve-agent query');
    assert.ok(frag.includes('agent_hint'), 'fragment must read plan_json.agent_hint');
    assert.ok(frag.includes('workflow.agent_hint_routing'), 'fragment must honor the config gate');
    // Fallback is the byte-identical default.
    assert.ok(frag.includes('gsd-executor'));
  });
});

describe('#1689 workflow.agent_hint_routing config key', () => {
  test('default-on: config-get resolves true in a project that does not set it', () => {
    const project = createTempProject('gsd-1689-cfg-');
    try {
      const r = runGsdTools(['config-get', 'workflow.agent_hint_routing', '--raw'], project);
      assert.equal(r.exitCode, 0, r.output);
      assert.equal(r.output.trim(), 'true');
    } finally {
      cleanup(project);
    }
  });

  test('settable + opt-out round-trip (config-set false then config-get false)', () => {
    const project = createTempProject('gsd-1689-cfgset-');
    try {
      const set = runGsdTools(['config-set', 'workflow.agent_hint_routing', 'false'], project);
      assert.equal(set.exitCode, 0, set.output);
      const get = runGsdTools(['config-get', 'workflow.agent_hint_routing', '--raw'], project);
      assert.equal(get.output.trim(), 'false');
    } finally {
      cleanup(project);
    }
  });

  test('boolean-validated: a non-boolean value is rejected', () => {
    const project = createTempProject('gsd-1689-cfgvalid-');
    try {
      const set = runGsdTools(['config-set', 'workflow.agent_hint_routing', 'maybe'], project);
      assert.notEqual(set.exitCode, 0, 'non-boolean must be rejected');
    } finally {
      cleanup(project);
    }
  });
});
