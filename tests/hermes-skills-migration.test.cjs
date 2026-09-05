// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Hermes Agent Skills Migration
 *
 * Tests for installing GSD for Hermes Agent using the standard
 * skills/gsd-xxx/SKILL.md format (same open standard as Claude Code 2.1.88+).
 *
 * Uses node:test and node:assert (NOT Jest).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  convertClaudeCommandToClaudeSkill,
  convertClaudeToHermesMarkdown,
  projectNamedDispatchToStructuralDelegate,
  _hostIntegrationDispatch,
  _resolveAvailableGsdRoles,
  HERMES_DISPATCH_TOOL_CONFIG,
  maskStringLiterals,
  findDispatchCallSpans,
  _assertProjectionComplete,
  install,
  uninstall,
} = require('../bin/install.js');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const {
  applyClaudeCodeBrandSwap,
  convertClaudeToWindsurfMarkdown,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { parseFrontmatter, cleanup } = require('./helpers.cjs');
const { nestedSkillPath } = require('./helpers/nested-layout.cjs');
const pkg = require('../package.json');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const manifest = loadSkillsManifest();
const resolvedProfileFull = resolveProfile({ modes: [], manifest });

// ─── #2284 shared fixtures/helpers (delegate_task dispatch projection) ──────
const HERMES_DISPATCH = _hostIntegrationDispatch('hermes');

// Representative fixture prose mirroring the real shape found in
// gsd-core/workflows/plan-phase.md — the "Agent tool IS available" contract
// assertion followed by a literal, multi-arg Agent(...) dispatch call whose
// subagent_type resolves to a real shipped role.
const FIXTURE_ASSERTION_AND_CALL = [
  'The Agent tool IS available in a top-level Hermes Agent session. Always spawn',
  'gsd-phase-researcher, gsd-planner, and gsd-plan-checker as separate Agent() calls.',
  '',
  '```',
  'Agent(',
  '  prompt=filled_research_hook_fragment,',
  '  subagent_type="gsd-planner",',
  '  model="{researcher_model}",',
  '  description="Research Phase {phase}"',
  ')',
  '```',
  '',
  '> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately.',
  'Wait for the subagent to return its result. Only resume when the subagent result is available.',
].join('\n');

function hermesToolConfig(overrides = {}) {
  return Object.assign({}, HERMES_DISPATCH_TOOL_CONFIG, {
    availableRoles: _resolveAvailableGsdRoles(),
    runtime: 'hermes',
  }, overrides);
}

// ─── convertClaudeCommandToClaudeSkill (used by Hermes via copyCommandsAsClaudeSkills) ──

describe('Hermes Agent: convertClaudeCommandToClaudeSkill', () => {
  test('preserves allowed-tools multiline YAML list', () => {
    const input = [
      '---',
      'name: gsd:next',
      'description: Advance to the next step',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '  - Grep',
      '---',
      '',
      'Body content here.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-next');
    assert.ok(result.includes('allowed-tools:'), 'allowed-tools field is present');
    assert.ok(result.includes('Read'), 'Read tool preserved');
    assert.ok(result.includes('Bash'), 'Bash tool preserved');
    assert.ok(result.includes('Grep'), 'Grep tool preserved');
  });

  test('preserves argument-hint', () => {
    const input = [
      '---',
      'name: gsd:debug',
      'description: Debug issues',
      'argument-hint: "[issue description]"',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Debug body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-debug');
    assert.ok(result.includes('argument-hint:'), 'argument-hint field is present');
    assert.ok(
      result.includes('[issue description]'),
      'argument-hint value preserved'
    );
  });

  test('emits hyphen-form name (gsd-<cmd>) from hyphen-form dir (#2808)', () => {
    const input = [
      '---',
      'name: gsd:next',
      'description: Advance workflow',
      '---',
      '',
      'Body.',
    ].join('\n');

    // Directory name is gsd-next (hyphen, Windows-safe), frontmatter name is
    // gsd-next (hyphen, #2808 — canonical invocation form for Claude Code autocomplete).
    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-next');
    assert.ok(result.includes('name: gsd-next'), 'frontmatter name uses hyphen form (#2808)');
  });

  test('preserves body content unchanged', () => {
    const body = '\n<objective>\nDo the thing.\n</objective>\n\n<process>\nStep 1.\nStep 2.\n</process>\n';
    const input = [
      '---',
      'name: gsd:test',
      'description: Test command',
      '---',
      body,
    ].join('');

    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-test');
    assert.ok(result.includes('<objective>'), 'objective tag preserved');
    assert.ok(result.includes('Do the thing.'), 'body text preserved');
    assert.ok(result.includes('<process>'), 'process tag preserved');
  });

  test('produces valid SKILL.md frontmatter starting with ---', () => {
    const input = [
      '---',
      'name: gsd:plan',
      'description: Plan a phase',
      '---',
      '',
      'Plan body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-plan');
    assert.ok(result.startsWith('---\n'), 'frontmatter starts with ---');
    assert.ok(result.includes('\n---\n'), 'frontmatter closes with ---');
  });
});

// ─── installRuntimeArtifacts (used for Hermes skills install) ────────────────

describe('Hermes Agent: installRuntimeArtifacts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hermes-test-'));
    // Hermes consumes commands and agents from one source provider. Keep the
    // compatibility-marker fixture complete even when an assertion exercises
    // only its command-to-skill output.
    const agentsDir = path.join(tmpDir, 'src', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'fixture-agent.md'), '# Fixture agent\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates skills/gsd/gsd-quick/SKILL.md directory structure (Hermes prefixed layout, #947)', () => {
    // Create source command files
    const srcDir = path.join(tmpDir, 'src', 'commands', 'gsd');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'quick.md'), [
      '---',
      'name: gsd:quick',
      'description: Execute a quick task',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      '<objective>Quick task body</objective>',
    ].join('\n'));

    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    // Redirect findInstallSourceRoot to the test's custom srcDir
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', resolvedProfileFull);

    // Hermes layout: skills/gsd/gsd-<stem>/SKILL.md (#947 — canonical gsd- prefix restored)
    const skillPath = path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'skills/gsd/gsd-quick/SKILL.md exists');

    // Verify content (structural — parse frontmatter, don't substring-grep)
    // Hermes prefix='gsd-': skillName passed to converter = 'gsd-quick'
    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(fm.name, 'gsd-quick', 'frontmatter name uses canonical gsd- prefix (#947)');
    assert.ok(fm.description && fm.description.length > 0, 'description present and non-empty');
    assert.strictEqual(fm.version, pkg.version,
      `Hermes SKILL.md must declare version (got ${JSON.stringify(fm.version)})`);
    assert.ok(/^allowed-tools:\s*\r?\n(?:\s+-\s+\S+\r?\n?)+/m.test(content),
      'allowed-tools rendered as YAML block list');
    assert.ok(content.includes('<objective>'), 'body content preserved');
  });

  test('replaces ~/.claude/ paths via applyRuntimeContentRewritesInPlace', () => {
    const srcDir = path.join(tmpDir, 'src', 'commands', 'gsd');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'next.md'), [
      '---',
      'name: gsd:next',
      'description: Next step',
      '---',
      '',
      'Reference: @~/.claude/gsd-core/workflows/next.md',
    ].join('\n'));

    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', resolvedProfileFull);

    // Hermes layout: skills/gsd/gsd-<stem>/SKILL.md (#947 — canonical gsd- prefix)
    const content = fs.readFileSync(path.join(configDir, 'skills', 'gsd', 'gsd-next', 'SKILL.md'), 'utf8');
    assert.ok(!content.includes('~/.claude/'), 'old claude tilde-path removed');
    assert.ok(!content.includes('$HOME/.claude/'), 'old claude $HOME-path not present');
  });

  test('replaces $HOME/.claude/ paths via applyRuntimeContentRewritesInPlace', () => {
    const srcDir = path.join(tmpDir, 'src', 'commands', 'gsd');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'plan.md'), [
      '---',
      'name: gsd:plan',
      'description: Plan phase',
      '---',
      '',
      'Reference: $HOME/.claude/gsd-core/workflows/plan.md',
    ].join('\n'));

    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', resolvedProfileFull);

    // Hermes layout: skills/gsd/gsd-<stem>/SKILL.md (#947 — canonical gsd- prefix)
    const content = fs.readFileSync(path.join(configDir, 'skills', 'gsd', 'gsd-plan', 'SKILL.md'), 'utf8');
    assert.ok(!content.includes('$HOME/.claude/'), 'old claude $HOME-path removed');
    assert.ok(!content.includes('~/.claude/'), 'old claude tilde-path not present');
  });

  test('removes stale gsd- skills before installing new ones', () => {
    const srcDir = path.join(tmpDir, 'src', 'commands', 'gsd');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'quick.md'), [
      '---',
      'name: gsd:quick',
      'description: Quick task',
      '---',
      '',
      'Body',
    ].join('\n'));

    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Pre-create a stale flat skill (skills/gsd-old-skill) — legacy Hermes layout
    const staleFlatSkillDir = path.join(configDir, 'skills', 'gsd-old-skill');
    fs.mkdirSync(staleFlatSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleFlatSkillDir, 'SKILL.md'), 'old');

    installRuntimeArtifacts('hermes', configDir, 'global', resolvedProfileFull);

    // _runLegacyInstallMigrations removes skills/gsd-* flat dirs for hermes
    assert.ok(!fs.existsSync(staleFlatSkillDir), 'stale flat gsd- skill removed');
    // New Hermes layout: skills/gsd/gsd-<stem>/SKILL.md (#947 — canonical gsd- prefix)
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md')), 'new skill installed at skills/gsd/gsd-quick/SKILL.md');
  });

  test('preserves agent field in frontmatter', () => {
    const srcDir = path.join(tmpDir, 'src', 'commands', 'gsd');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'execute.md'), [
      '---',
      'name: gsd:execute',
      'description: Execute phase',
      'agent: gsd-executor',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '  - Task',
      '---',
      '',
      'Execute body',
    ].join('\n'));

    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', resolvedProfileFull);

    // Hermes layout: skills/gsd/gsd-<stem>/SKILL.md (#947 — canonical gsd- prefix)
    const content = fs.readFileSync(path.join(configDir, 'skills', 'gsd', 'gsd-execute', 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(fm.agent, 'gsd-executor', 'agent field preserved');
  });
});

// ─── Integration: SKILL.md format validation ────────────────────────────────

describe('Hermes Agent: SKILL.md format validation', () => {
  test('SKILL.md frontmatter parses with required Hermes fields', () => {
    const input = [
      '---',
      'name: gsd:review',
      'description: Code review with quality checks',
      'argument-hint: "[PR number or branch]"',
      'agent: gsd-code-reviewer',
      'allowed-tools:',
      '  - Read',
      '  - Grep',
      '  - Bash',
      '---',
      '',
      '<objective>Review code</objective>',
    ].join('\n');

    // Pass runtime='hermes' so the version field is injected per Hermes spec.
    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-review', 'hermes');
    const fm = parseFrontmatter(result);

    assert.strictEqual(fm.name, 'gsd-review', 'name uses hyphen form');
    assert.ok(fm.description && fm.description.length > 0, 'description non-empty');
    assert.strictEqual(fm.version, pkg.version, 'version matches package.json');
    assert.strictEqual(fm.agent, 'gsd-code-reviewer', 'agent preserved');
    assert.strictEqual(fm['argument-hint'], '[PR number or branch]', 'argument-hint preserved and unquoted');
    assert.ok(/^allowed-tools:\s*\r?\n(?:\s+-\s+\S+\r?\n?)+/m.test(result),
      'allowed-tools rendered as YAML block list');
  });

  test('omits version field when runtime is not hermes (parity with non-Hermes skill consumers)', () => {
    const input = [
      '---',
      'name: gsd:plan',
      'description: Plan a phase',
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-plan');
    const fm = parseFrontmatter(result);
    assert.strictEqual(fm.version, undefined, 'no version key for non-hermes skills');
    assert.strictEqual(fm.name, 'gsd-plan');
  });
});

// ─── #1383 regression: version lookup must not require a runtime-root package.json ──
// The extracted conversion module sits in the gsd-tools loader chain, so its old
// top-level `require('../../../package.json')` crashed EVERY gsd-tools command on
// Codex — whose runtime root has no package.json — with
// `Cannot find module '../../../package.json'`. The Hermes `version:` field (the
// require's only consumer) must instead be sourced from the installed
// gsd-core/VERSION, lazily and defensively, so the module loads everywhere and
// the emitted version is a real semver, never `undefined`.
describe('#1383 regression: gsd-tools version lookup without a runtime-root package.json', () => {
  // Require the EXTRACTED module that the gsd-tools chain loads (not install.js's
  // in-process copy), to assert the crash path itself is gone.
  const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1383-')); });
  afterEach(() => { cleanup(tmp); });

  // Build a fake install layout <tmp>/gsd-core/bin/lib and return that libDir.
  // `version` writes <tmp>/gsd-core/VERSION; `rootPkg` writes <tmp>/package.json.
  function layout({ version, rootPkg } = {}) {
    const libDir = path.join(tmp, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    if (version !== undefined) fs.writeFileSync(path.join(tmp, 'gsd-core', 'VERSION'), version);
    if (rootPkg !== undefined) fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(rootPkg));
    return libDir;
  }

  test('reads gsd-core/VERSION when the runtime root has no package.json (Codex layout)', () => {
    const libDir = layout({ version: '9.9.9\n' }); // deliberately NO root package.json
    assert.ok(!fs.existsSync(path.join(tmp, 'package.json')),
      'precondition: Codex layout has no runtime-root package.json');
    let v;
    assert.doesNotThrow(() => { v = conversion.resolveVersionFrom(libDir); },
      'version lookup must not throw on a layout without a runtime-root package.json');
    assert.strictEqual(v, '9.9.9', 'version is read (trimmed) from the installed VERSION file');
  });

  test('falls back to the runtime-root package.json when no VERSION file exists (source/npm layout)', () => {
    const libDir = layout({ rootPkg: { version: '1.2.3' } }); // no VERSION file
    assert.strictEqual(conversion.resolveVersionFrom(libDir), '1.2.3',
      'source/npm tree has a real package.json three dirs up');
  });

  test('degrades to "" (never throws, never emits undefined) when neither source exists', () => {
    const libDir = layout({}); // neither VERSION nor package.json
    let v;
    assert.doesNotThrow(() => { v = conversion.resolveVersionFrom(libDir); });
    assert.strictEqual(v, '', 'no source -> empty string, so the caller omits the version field');
  });

  test('rejects a non-semver VERSION file rather than emitting it verbatim', () => {
    const libDir = layout({ version: 'not-a-version\n' }); // malformed, no package.json fallback
    let v;
    assert.doesNotThrow(() => { v = conversion.resolveVersionFrom(libDir); });
    assert.strictEqual(v, '', 'garbled VERSION is rejected, so the caller omits the field');
  });
});

// ─── #2284: Hermes named-dispatch → delegate_task projection ────────────────
// Folded from tests/fix-2284-hermes-agent-delegate-task-projection.test.cjs
// (test-hygiene consolidation, issue #3333). The Hermes installer previously
// only brand-swapped "Claude Code" → "Hermes Agent" in shipped
// `gsd-core/workflows/*.md`, leaving a false "The Agent tool IS available"
// assertion and literal `Agent(...)` call syntax installed verbatim — Hermes
// exposes `delegate_task`, not `Agent`.
//
// Covers:
//   1. Direct converter contract — projectNamedDispatchToStructuralDelegate /
//      convertClaudeToHermesMarkdown against representative fixture prose,
//      across ALL THREE real corpus call-argument shapes: multi-line
//      one-key-per-line, single-line object-literal (`Agent({...})` —
//      import.md/ingest-docs.md), and single-line compact
//      (`Agent(subagent_type="x", model="y", prompt="...")` —
//      code-review-fix.md/ship.md/etc).
//   2. Real disposable-HOME `--hermes --global` e2e install — no literal
//      `Agent(` survives, `delegate_task` is present, commands→skill path
//      (convertClaudeCommandToClaudeSkill) still works unregressed; spot-
//      checks import.md, ingest-docs.md, and code-review-fix.md specifically
//      (the object-literal and single-line-compact sites).
//   3. Fail-closed role resolution — a referenced gsd-* role prompt missing
//      from the shipped agents/ directory aborts install with an explicit
//      error, in EVERY call-argument shape, both at the converter level and
//      through the real install path (deterministic fs.readdirSync
//      injection per the repo's cross-platform IO-failure-injection
//      convention — never chmod/permission tricks).
//   4. The post-projection guard (belt-and-suspenders) — fails loud on any
//      residual subagent_type / leaked model= / unprojected Agent( the
//      projection above did not anticipate, rather than silently shipping it.

// ─── 1. Direct converter contract ────────────────────────────────────────────

describe('#2284 convertClaudeToHermesMarkdown / projectNamedDispatchToStructuralDelegate — converter contract', () => {
  test('capabilities/hermes/capability.json dispatch facts are unchanged (docs-sourced, not touched by this fix)', () => {
    // Locks in the maintainer-confirmed constraint: this fix reads the
    // existing sourced facts, it never edits them.
    assert.strictEqual(HERMES_DISPATCH.namedDispatch, false);
    assert.strictEqual(HERMES_DISPATCH.background, true);
    assert.strictEqual(HERMES_DISPATCH.backgroundDispatch, false);
    assert.strictEqual(HERMES_DISPATCH.subagentToolkit, 'read-only');
    assert.strictEqual(HERMES_DISPATCH.maxDepth, 1);
    assert.strictEqual(HERMES_DISPATCH.nested, true);
  });

  test('no literal Agent( call syntax survives the projection', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(!/\bAgent\(/.test(out), `literal Agent( survived:\n${out}`);
  });

  test('emits a delegate_task-shaped dispatch call with the resolved role reference', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(/delegate_task\(/.test(out), 'delegate_task( call syntax present');
    assert.ok(/gsd_role="gsd-planner"/.test(out), 'gsd_role carries the resolved role identifier');
    assert.ok(/gsd_role_prompt=/.test(out), 'gsd_role_prompt carries the loaded-content instruction');
    assert.ok(/role="leaf"/.test(out), 'structural role pinned to Hermes\'s non-orchestrating leaf value');
  });

  test('drops per-call model forwarding (host-model inheritance is explicit)', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(!/model="\{researcher_model\}"/.test(out), 'per-call model="{researcher_model}" line stripped');
    assert.ok(!/\bmodel=/.test(out), 'no model= parameter forwarded anywhere in the projected call');
  });

  test('the "Agent tool IS available" assertion becomes an accurate delegate_task statement', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(!/Agent tool IS available/.test(out), 'false Claude-shaped assertion removed');
    assert.ok(/delegate_task/.test(out), 'assertion references the real Hermes dispatch primitive');
    assert.ok(/no concept of a named subagent identity/i.test(out), 'assertion states the roleless-lookup contract (namedDispatch: false)');
  });

  test('async halt/resume wording is preserved (no busy-poll)', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(/stop working on this task immediately/.test(out), 'halt-after-dispatch instruction preserved');
    assert.ok(/Wait for the subagent to return its result/.test(out), 'resume-on-completion instruction preserved');
  });

  test('fail-closed wording is present for the role-resolution step', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'hermes' });
    assert.ok(/FAIL CLOSED/.test(out), 'explicit FAIL CLOSED instruction present');
    assert.ok(/never execute the role inline/i.test(out), 'explicit prohibition on silent inline execution');
  });

  test('run_in_background= maps onto Hermes\'s native background= (dispatch.background: true)', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  run_in_background=true,\n  description="d"\n)';
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(/\bbackground=true\b/.test(out), 'background=true present');
    assert.ok(!/run_in_background=/.test(out), 'Claude-native run_in_background= param name gone');
  });

  test('genuinely branches on dispatch.background: false — strips (never renames) the background flag', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  run_in_background=true,\n  description="d"\n)';
    const out = projectNamedDispatchToStructuralDelegate(
      fixture,
      Object.assign({}, HERMES_DISPATCH, { background: false }),
      hermesToolConfig(),
    );
    assert.ok(!/run_in_background=/.test(out), 'unsupported flag not left in Claude form');
    assert.ok(!/\bbackground=true\b/.test(out), 'flag not forwarded when dispatch.background is false');
  });

  test('genuinely branches on dispatch.namedDispatch: true — passes named dispatch through unprojected', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  description="d"\n)';
    const out = projectNamedDispatchToStructuralDelegate(
      fixture,
      Object.assign({}, HERMES_DISPATCH, { namedDispatch: true }),
      hermesToolConfig(),
    );
    // No role-prompt-embedding machinery should be injected when the target
    // primitive can resolve named agents itself.
    assert.ok(!/gsd_role_prompt=/.test(out), 'no prompt-content-embedding injected when namedDispatch is true');
    assert.ok(!/FAIL CLOSED/.test(out), 'no fail-closed role-resolution injected when namedDispatch is true');
    assert.ok(/delegate_task\(/.test(out), 'call syntax still renamed to the target tool name');
  });

  test('genuinely branches on subagentToolkit/maxDepth — omits the depth/toolkit caveat when the target can orchestrate', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  description="d"\n)';
    const restrictedOut = projectNamedDispatchToStructuralDelegate(
      fixture, HERMES_DISPATCH, hermesToolConfig(),
    );
    assert.ok(/nested delegation is unavailable/.test(restrictedOut), 'read-only/depth-1 caveat present for the real sourced facts');

    const orchestrateCapableOut = projectNamedDispatchToStructuralDelegate(
      fixture,
      Object.assign({}, HERMES_DISPATCH, { subagentToolkit: 'full', maxDepth: -1 }),
      hermesToolConfig(),
    );
    assert.ok(!/nested delegation is unavailable/.test(orchestrateCapableOut), 'caveat omitted when the target genuinely supports nested delegation');
  });

  test('preserves body content and prose the projection does not target', () => {
    const fixture = 'Some unrelated prose.\n\nAgent(\n  prompt=x,\n  subagent_type="gsd-verifier",\n  description="d"\n)\n\nMore unrelated prose.';
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(out.includes('Some unrelated prose.'));
    assert.ok(out.includes('More unrelated prose.'));
  });
});

// ─── 1b. All three real corpus call-argument shapes ─────────────────────────

describe('#2284 all three real corpus Agent(...) call-argument shapes', () => {
  // (a) multi-line, one key= per line — plan-phase.md/execute-phase.md/etc.
  const MULTI_LINE = 'Agent(\n  prompt=x,\n  subagent_type="gsd-planner",\n  model="{researcher_model}",\n  description="d"\n)';
  // (b) single-line object-literal (colon syntax) — import.md/ingest-docs.md.
  const OBJECT_LITERAL = 'Agent({\n  subagent_type: "gsd-plan-checker",\n  prompt: "Validate the plan."\n})';
  // (c) single-line compact — code-review-fix.md/code-review.md/ship.md/etc.
  const SINGLE_LINE_COMPACT = 'Agent(subagent_type="gsd-code-fixer", model="{FIXER_MODEL}", prompt="Fix the findings.")';

  const forms = [
    ['multi-line one-key-per-line', MULTI_LINE, 'gsd-planner'],
    ['single-line object-literal', OBJECT_LITERAL, 'gsd-plan-checker'],
    ['single-line compact', SINGLE_LINE_COMPACT, 'gsd-code-fixer'],
  ];

  for (const [label, fixture, role] of forms) {
    test(`${label}: projects to delegate_task with gsd_role_prompt + role="leaf"`, () => {
      const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
      assert.ok(/delegate_task\(/.test(out), `${label}: delegate_task( present`);
      assert.ok(out.includes(`gsd_role="${role}"`), `${label}: gsd_role carries "${role}"`);
      assert.ok(/gsd_role_prompt=/.test(out), `${label}: gsd_role_prompt injected`);
      assert.ok(/role="leaf"/.test(out), `${label}: structural role="leaf" injected`);
      assert.ok(/FAIL CLOSED/.test(out), `${label}: fail-closed wording present`);
    });

    test(`${label}: no residual subagent_type (either = or : syntax)`, () => {
      const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
      assert.ok(!/\bsubagent_type\s*[=:]/.test(out), `${label}: subagent_type token gone:\n${out}`);
    });

    test(`${label}: no leaked model= (host-model inheritance, never forwarded)`, () => {
      const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
      const mask = maskStringLiterals(out);
      assert.ok(!/\bmodel\s*[=:]/.test(mask), `${label}: no model= or model: token survives:\n${out}`);
    });

    test(`${label}: a bogus role triggers the fail-closed throw`, () => {
      const bogusFixture = fixture.replace(role, 'gsd-totally-fake-role-2284');
      assert.throws(
        () => convertClaudeToHermesMarkdown(bogusFixture, { runtime: 'hermes' }),
        /gsd-totally-fake-role-2284/,
        `${label}: expected an explicit fail-closed error naming the bogus role`,
      );
    });
  }

  test('object-literal wrapper braces are stripped (Hermes delegate_task is a flat kwarg call)', () => {
    const out = convertClaudeToHermesMarkdown(OBJECT_LITERAL, { runtime: 'hermes' });
    assert.ok(!/delegate_task\(\s*\{/.test(out), 'no leftover "{" immediately after delegate_task(');
    assert.ok(!/\}\s*\)\s*$/.test(out.trim()), 'no leftover "}" immediately before the closing )');
  });

  test('object-literal form: non-role/model keys (e.g. prompt:) are left in their original colon style', () => {
    const out = convertClaudeToHermesMarkdown(OBJECT_LITERAL, { runtime: 'hermes' });
    assert.ok(out.includes('prompt: "Validate the plan."'), 'untouched arg keys keep their original syntax');
  });

  test('single-line-compact: a real corpus fixture identical to code-review-fix.md:201 shape (multi-line prompt body opened on the compact head)', () => {
    // code-review-fix.md's real shape: `Agent(subagent_type="x", model="y", prompt="` opens a
    // MULTI-LINE prompt body (no escaping) that closes many lines later with `")`.
    const fixture = [
      'Agent(subagent_type="gsd-code-fixer", model="{FIXER_MODEL}", prompt="',
      '<files_to_read>',
      '${REVIEW_PATH}',
      '</files_to_read>',
      '',
      'Read REVIEW.md findings, apply fixes.',
      '${AGENT_SKILLS_FIXER}")',
    ].join('\n');
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(!/\bAgent\(/.test(out), 'no literal Agent( survives a multi-line-body compact-head call');
    assert.ok(/delegate_task\(/.test(out));
    assert.ok(out.includes('gsd_role="gsd-code-fixer"'));
    assert.ok(!/\bmodel\s*[=:]/.test(maskStringLiterals(out)), 'model stripped even though the prompt body spans many lines');
    assert.ok(out.includes('<files_to_read>'), 'multi-line prompt BODY content is preserved verbatim');
    assert.ok(out.includes('${REVIEW_PATH}'), 'interpolation placeholders inside the prompt body are untouched');
  });

  test('disconnected prose mention (not part of any real Agent(...) call, e.g. map-codebase.md-style) is still renamed and validated', () => {
    const fixture = 'Use Agent tool with `subagent_type="gsd-codebase-mapper"` for parallel execution.';
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(out.includes('gsd_role="gsd-codebase-mapper"'), 'prose mention renamed to gsd_role=');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(out));
  });

  test('a documentation TEMPLATE placeholder role (curly-brace interpolation, e.g. universal-anti-patterns.md\'s subagent_type: "gsd-{agent}") is renamed but NOT fail-closed validated', () => {
    const fixture = 'ALWAYS use `subagent_type: "gsd-{agent}"` (e.g., `gsd-phase-researcher`, `gsd-executor`).';
    assert.doesNotThrow(() => convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' }));
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(out.includes('gsd_role: "gsd-{agent}"'), 'template placeholder renamed, value preserved verbatim');
  });

  test('run_in_background: true (colon-prose form, e.g. execute-phase.md) maps onto background: true, same as the = form', () => {
    const fixture = 'Dispatch each `Agent()` call one at a time with `run_in_background: true`.';
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(/background:\s*true/.test(out), 'colon-prose form mapped to the native background param');
    assert.ok(!/run_in_background/.test(out), 'Claude-native run_in_background token gone');
  });

  test('a call site preceded by explanatory comments describing the now-removed model= conditional strips both the arg AND the dead comments (Finding 5)', () => {
    const fixture = [
      'Agent(',
      '  subagent_type="gsd-executor",',
      '  description="Execute plan",',
      '  # Only include model= when executor_model is an explicit model name.',
      '  # When executor_model is "inherit", omit this parameter entirely so',
      '  # Claude Code inherits the orchestrator model automatically.',
      '  model="{executor_model}",  # omit this line when executor_model == "inherit"',
      '  isolation="worktree",',
      '  prompt="Execute the plan."',
      ')',
    ].join('\n');
    const out = convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' });
    assert.ok(!/model="\{executor_model\}"/.test(out), 'model= argument line removed');
    assert.ok(!/Only include model=/.test(out), 'dead explanatory comment (line 1) removed');
    assert.ok(!/omit this parameter entirely/.test(out), 'dead explanatory comment (line 2) removed');
    assert.ok(!/inherits the orchestrator model/.test(out), 'dead explanatory comment (line 3) removed');
    assert.ok(out.includes('isolation="worktree"'), 'unrelated surrounding arguments preserved');
  });
});

// ─── 1c. Post-projection guard (belt-and-suspenders, #2284 requirement 3) ───

describe('#2284 post-projection guard — fails loud on any unanticipated residual form', () => {
  const toolConfig = hermesToolConfig();

  test('throws when a residual subagent_type token survives (any syntax)', () => {
    assert.throws(
      () => _assertProjectionComplete('delegate_task(subagent_type="gsd-planner")', toolConfig),
      /residual subagent_type/i,
    );
    assert.throws(
      () => _assertProjectionComplete('delegate_task(subagent_type: "gsd-planner")', toolConfig),
      /residual subagent_type/i,
    );
  });

  test('throws when literal Agent( call syntax survives', () => {
    // Isolated from the subagent_type check above (which fires first and
    // would otherwise mask this assertion) — a bare Agent() mention with no
    // remaining subagent_type token.
    assert.throws(
      () => _assertProjectionComplete('Please call Agent() to dispatch.', toolConfig),
      /literal Agent\(/i,
    );
  });

  test('throws when a model= argument leaks inside a delegate_task(...) call', () => {
    assert.throws(
      () => _assertProjectionComplete('delegate_task(gsd_role="gsd-planner", model="{m}")', toolConfig),
      /leaked model=/i,
    );
  });

  test('does NOT throw on a clean, fully-projected document', () => {
    const clean = 'delegate_task(gsd_role="gsd-planner", gsd_role_prompt=<resolve...>, role="leaf", prompt="x")';
    assert.doesNotThrow(() => _assertProjectionComplete(clean, toolConfig));
  });

  test('does NOT flag Agent( or subagent_type mentioned INSIDE a quoted string (not real call syntax)', () => {
    // e.g. settings.md: `description: "Chain stages via Agent() subagents"`.
    const proseInsideString = 'delegate_task(description="Chain stages via Agent() subagents, not subagent_type=x")';
    assert.doesNotThrow(() => _assertProjectionComplete(proseInsideString, toolConfig));
  });

  test('findDispatchCallSpans correctly balances parens across a quoted prompt body containing its own parens', () => {
    // Mirrors discuss-phase-assumptions.md's real shape: parenthetical prose
    // ("(e.g., ...)") embedded inside a triple-quoted prompt body.
    const fixture = 'Agent(subagent_type="gsd-verifier", prompt="""\nAnalyze (e.g., "Technical Approach") the codebase.\n(3-5 areas, calibrated by tier)\n""")';
    const spans = findDispatchCallSpans(fixture, 'Agent');
    assert.strictEqual(spans.length, 1, 'exactly one call span found despite embedded parens');
    assert.strictEqual(spans[0].end, fixture.length, 'span correctly extends to the TRUE closing paren, not a premature one inside the string');
  });
});

// ─── 2. Real disposable-HOME e2e install ─────────────────────────────────────

describe('#2284 real disposable-HOME --hermes --global install', () => {
  let tmpHome;
  let savedHome;
  let savedUserProfile;
  let savedHermesHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2284-hermes-home-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedHermesHome = process.env.HERMES_HOME;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.HERMES_HOME = path.join(tmpHome, '.hermes');
  });

  afterEach(() => {
    try {
      uninstall(true, 'hermes');
    } catch (_e) {
      // best-effort — some fail-closed tests intentionally leave a partial install
    }
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedHermesHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = savedHermesHome;
    cleanup(tmpHome);
  });

  test('installed plan-phase.md has no literal Agent( and does contain delegate_task', () => {
    const result = install(true, 'hermes');
    assert.strictEqual(result.runtime, 'hermes');

    const planPhasePath = path.join(result.configDir, 'gsd-core', 'workflows', 'plan-phase.md');
    assert.ok(fs.existsSync(planPhasePath), `expected installed workflow at ${planPhasePath}`);
    const content = fs.readFileSync(planPhasePath, 'utf8');

    assert.ok(!/\bAgent\(/.test(content), 'no literal Agent( call syntax in installed plan-phase.md');
    assert.ok(/delegate_task\(/.test(content), 'delegate_task( present in installed plan-phase.md');
    assert.ok(!/Agent tool IS available/.test(content), 'false assertion not installed verbatim');
  });

  test('spot-check a second workflow (execute-phase.md) — same guarantees hold', () => {
    const result = install(true, 'hermes');
    const executePhasePath = path.join(result.configDir, 'gsd-core', 'workflows', 'execute-phase.md');
    assert.ok(fs.existsSync(executePhasePath));
    const content = fs.readFileSync(executePhasePath, 'utf8');

    assert.ok(!/\bAgent\(/.test(content), 'no literal Agent( call syntax in installed execute-phase.md');
    assert.ok(/delegate_task\(/.test(content), 'delegate_task( present in installed execute-phase.md');
  });

  test('spot-check import.md (object-literal Agent({...}) form) in the installed tree', () => {
    const result = install(true, 'hermes');
    const importPath = path.join(result.configDir, 'gsd-core', 'workflows', 'import.md');
    assert.ok(fs.existsSync(importPath));
    const content = fs.readFileSync(importPath, 'utf8');
    assert.ok(!/\bAgent\(/.test(content), 'no literal Agent( in installed import.md');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(content), 'no residual subagent_type in installed import.md');
    assert.ok(content.includes('gsd_role="gsd-plan-checker"'), 'gsd_role carries the resolved role');
    assert.ok(/gsd_role_prompt=/.test(content), 'role-prompt-resolution injected');
  });

  test('spot-check ingest-docs.md (object-literal Agent({...}) form, two call sites) in the installed tree', () => {
    const result = install(true, 'hermes');
    const ingestPath = path.join(result.configDir, 'gsd-core', 'workflows', 'ingest-docs.md');
    assert.ok(fs.existsSync(ingestPath));
    const content = fs.readFileSync(ingestPath, 'utf8');
    assert.ok(!/\bAgent\(/.test(content), 'no literal Agent( in installed ingest-docs.md');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(content), 'no residual subagent_type in installed ingest-docs.md');
    assert.ok(content.includes('gsd_role="gsd-doc-synthesizer"'), 'first call site role resolved');
    assert.ok(content.includes('gsd_role="gsd-roadmapper"'), 'second call site role resolved');
  });

  test('spot-check code-review-fix.md (single-line-compact Agent(subagent_type=..., model=..., prompt="multi-line body) form) in the installed tree', () => {
    const result = install(true, 'hermes');
    const crfPath = path.join(result.configDir, 'gsd-core', 'workflows', 'code-review-fix.md');
    assert.ok(fs.existsSync(crfPath));
    const content = fs.readFileSync(crfPath, 'utf8');
    assert.ok(!/\bAgent\(/.test(content), 'no literal Agent( in installed code-review-fix.md');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(content), 'no residual subagent_type in installed code-review-fix.md');
    const mask = maskStringLiterals(content);
    assert.ok(!/\bmodel\s*[=:]/.test(mask), 'no leaked model= inside any real call in installed code-review-fix.md');
    assert.ok(content.includes('gsd_role="gsd-code-fixer"'), 'gsd-code-fixer role resolved');
    assert.ok(content.includes('gsd_role="gsd-code-reviewer"'), 'gsd-code-reviewer role resolved (2nd/3rd call sites)');
  });

  test('EVERY installed workflow file is free of literal Agent( call syntax', () => {
    const result = install(true, 'hermes');
    const workflowsDir = path.join(result.configDir, 'gsd-core', 'workflows');
    assert.ok(fs.existsSync(workflowsDir));
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 10, 'sanity: a real corpus of workflow files was installed');
    for (const f of files) {
      const content = fs.readFileSync(path.join(workflowsDir, f), 'utf8');
      assert.ok(!/\bAgent\(/.test(content), `${f} still contains literal Agent( call syntax`);
    }
  });

  test('commands/gsd/*.md → Hermes-skill path (convertClaudeCommandToClaudeSkill) still works, unregressed', () => {
    const result = install(true, 'hermes');
    const categoryDir = path.join(result.configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryDir), 'skills/gsd category dir installed');

    const helpSkillPath = nestedSkillPath(categoryDir, 'gsd-', 'help');
    assert.ok(fs.existsSync(helpSkillPath), `expected nested skill at ${helpSkillPath}`);
    const skillContent = fs.readFileSync(helpSkillPath, 'utf8');
    assert.ok(/^---/.test(skillContent), 'skill file has YAML frontmatter');
    assert.ok(/name:\s*gsd-help/.test(skillContent), 'skill frontmatter name is the canonical gsd-help');
  });
});

// ─── 3. Fail-closed role resolution ──────────────────────────────────────────

describe('#2284 fail-closed role resolution', () => {
  test('converter throws when a literal gsd_role reference has no matching shipped role', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-totally-fake-role-2284",\n  description="d"\n)';
    assert.throws(
      () => convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' }),
      /gsd-totally-fake-role-2284/,
      'expected an explicit error naming the unresolvable role',
    );
  });

  test('converter throws (never silently installs) when the agents/ directory cannot be resolved at all', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-planner",\n  description="d"\n)';
    assert.throws(
      () => projectNamedDispatchToStructuralDelegate(fixture, HERMES_DISPATCH, hermesToolConfig({ availableRoles: null })),
      /could not resolve/i,
    );
  });

  test('a literal reference to a role that DOES exist never throws', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-verifier",\n  description="d"\n)';
    assert.doesNotThrow(() => convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' }));
  });

  test('dynamic (non-literal) role references are not statically checked and never throw', () => {
    // Mirrors the real plan-phase.md shape: subagent_type=research_hook.ref.agent
    // is resolved at runtime by the host, not a literal string install.js can verify.
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type=research_hook.ref.agent,\n  description="d"\n)';
    assert.doesNotThrow(() => convertClaudeToHermesMarkdown(fixture, { runtime: 'hermes' }));
  });

  describe('real install path — deterministic fs.readdirSync injection (never chmod/permission tricks)', () => {
    let tmpHome;
    let savedHome;
    let savedUserProfile;
    let savedHermesHome;
    let origReaddirSync;
    let injectedAgentsDir;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2284-hermes-failclosed-'));
      savedHome = process.env.HOME;
      savedUserProfile = process.env.USERPROFILE;
      savedHermesHome = process.env.HERMES_HOME;
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.HERMES_HOME = path.join(tmpHome, '.hermes');
      injectedAgentsDir = path.resolve(__dirname, '..', 'agents');
      origReaddirSync = fs.readdirSync;
    });

    afterEach(() => {
      fs.readdirSync = origReaddirSync;
      try {
        uninstall(true, 'hermes');
      } catch (_e) {
        // best-effort — the install intentionally failed partway through
      }
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      if (savedHermesHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = savedHermesHome;
      cleanup(tmpHome);
    });

    test('a real --hermes --global install aborts with an explicit error when the shipped agents/ dir is unreadable', () => {
      fs.readdirSync = function (p, opts) {
        if (typeof p === 'string' && path.resolve(p) === injectedAgentsDir) {
          throw new Error('#2284 injected fs.readdirSync failure — simulated unreadable agents/ dir');
        }
        return origReaddirSync.call(fs, p, opts);
      };

      assert.throws(
        () => install(true, 'hermes'),
        /could not resolve|refusing to install|source is unavailable or incomplete/i,
        'a real hermes install must fail closed, never silently install workflows with unverifiable role references',
      );
    });
  });
});

// ─── 5. Corpus-wide invariant (round-2 CRITICAL regression guard) ───────────
//
// #2284 round-2: `findDispatchCallSpans` originally relied on WHOLE-DOCUMENT
// cumulative quote parity (`maskStringLiterals` run once over the entire
// file). A markdown workflow mixes prose, ```bash fences full of their own
// double-quoted strings, and shell quoting — there is no single document-wide
// quote grammar. In the real corpus, a `"`-heavy bash block upstream of
// gsd-core/workflows/code-review.md's real
// `Agent(subagent_type="gsd-code-reviewer", model="{REVIEWER_MODEL}", ...)`
// call (~line 488) desynced that cumulative state, making the span detector
// blind to the call. It shipped completely unnormalized except for the
// catch-all's `subagent_type=`→`gsd_role=` rename: a Frankenstein
// `Agent(gsd_role="gsd-code-reviewer", model="{REVIEWER_MODEL}", ...)` — head
// still literal `Agent(`, `model=` leaked, no `gsd_role_prompt`/`role="leaf"`
// injected. A per-file/spot-check test suite did not exercise this file's
// exact shape and missed it; THIS is the real regression protection —
// hash-only goldens cannot catch a semantic defect like this.
describe('#2284 corpus-wide invariant — every shipped workflow/reference/template .md', () => {
  function walkMarkdown(dir) {
    if (!fs.existsSync(dir)) return [];
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walkMarkdown(full));
      else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
  }

  const CORPUS_ROOT = path.join(__dirname, '..', 'gsd-core');
  const CORPUS_FILES = ['workflows', 'references', 'templates', 'contexts']
    .flatMap((sub) => walkMarkdown(path.join(CORPUS_ROOT, sub)));

  test('sanity: a real, substantial corpus was found to scan', () => {
    assert.ok(CORPUS_FILES.length > 100, `expected >100 shipped .md files, found ${CORPUS_FILES.length}`);
  });

  test('every shipped .md file projects with ZERO residual Agent(, ZERO residual subagent_type, and ZERO leaked model= inside any delegate_task(...) call', () => {
    const failures = [];
    let totalDelegateTaskCalls = 0;
    for (const file of CORPUS_FILES) {
      const rel = path.relative(CORPUS_ROOT, file);
      const content = fs.readFileSync(file, 'utf8');
      let out;
      try {
        out = convertClaudeToHermesMarkdown(content, { runtime: 'hermes' });
      } catch (e) {
        failures.push(`${rel}: converter threw unexpectedly: ${e.message}`);
        continue;
      }
      if (/\bAgent\(/.test(out)) failures.push(`${rel}: residual literal Agent( survives`);
      if (/\bsubagent_type\s*[=:]/.test(out)) failures.push(`${rel}: residual subagent_type survives`);
      for (const span of findDispatchCallSpans(out, 'delegate_task')) {
        const rawSpanText = out.slice(span.start, span.end);
        if (/\bmodel\s*[=:]/.test(rawSpanText)) failures.push(`${rel}: leaked model= inside a delegate_task(...) call`);
      }
      totalDelegateTaskCalls += (out.match(/delegate_task\(/g) || []).length;
    }
    assert.deepStrictEqual(failures, [], `corpus-wide invariant violations:\n${failures.join('\n')}`);
    assert.ok(totalDelegateTaskCalls > 50, `sanity: expected a substantial number of real delegate_task( calls emitted, got ${totalDelegateTaskCalls}`);
  });

  test('code-review.md specifically: the real Agent(subagent_type="gsd-code-reviewer", model=..., prompt=...) call (~line 488) projects cleanly despite an upstream `"`-heavy bash fence', () => {
    const file = path.join(CORPUS_ROOT, 'workflows', 'code-review.md');
    const content = fs.readFileSync(file, 'utf8');
    const out = convertClaudeToHermesMarkdown(content, { runtime: 'hermes' });

    assert.ok(!/\bAgent\(/.test(out), 'no literal Agent( survives in code-review.md');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(out), 'no residual subagent_type in code-review.md');
    assert.ok(out.includes('gsd_role="gsd-code-reviewer"'), 'the real call\'s role is resolved, not just the catch-all rename');

    const callStart = out.indexOf('delegate_task(gsd_role="gsd-code-reviewer"');
    assert.ok(callStart !== -1, 'the real call head IS delegate_task( — not a bare catch-all-renamed Agent( survivor');
    const callSpans = findDispatchCallSpans(out, 'delegate_task');
    const realCallSpan = callSpans.find((s) => s.start === callStart);
    assert.ok(realCallSpan, 'the real call is detected as a complete, well-formed delegate_task(...) span');
    const rawCall = out.slice(realCallSpan.start, realCallSpan.end);
    assert.ok(/gsd_role_prompt=/.test(rawCall), 'gsd_role_prompt injected into the real call');
    assert.ok(/role="leaf"/.test(rawCall), 'role="leaf" injected into the real call');
    assert.ok(!/\bmodel\s*[=:]/.test(rawCall), 'no model= leaked inside the real call');
  });
});

// ─── 6. Bash-fence quote-imbalance regression (round-2 root cause) ──────────

describe('#2284 bash-fence quote-imbalance before a real call (round-2 root cause)', () => {
  // Minimal repro of code-review.md's real shape: a ```bash fence containing
  // an ODD/unbalanced count of literal double-quotes (ordinary, realistic
  // shell prose — `echo "..."` plus a nested escaped quote), followed by a
  // real Agent(...) call further down in the SAME document. Under the
  // round-1 whole-document cumulative-quote-parity bug, the fence's
  // unbalanced quoting flipped the parser's "am I inside a string" state by
  // the time it reached the real call, making the call invisible to
  // `findDispatchCallSpans` entirely.
  const FIXTURE = [
    '```bash',
    'echo "Warning: skipping structural findings embed (${SIZE} bytes). Re-run if needed."',
    'if [ -n "$X" ]; then echo "note: check the \\"quoted\\" value"; fi',
    '```',
    '',
    'Spawn the reviewer:',
    '',
    '```',
    'Agent(subagent_type="gsd-code-reviewer", model="{REVIEWER_MODEL}", prompt="',
    '<files_to_read>',
    '${FILES_TO_READ}',
    '</files_to_read>',
    'Review and report.',
    '")',
    '```',
  ].join('\n');

  test('findDispatchCallSpans finds the real call despite the upstream quote-heavy bash fence', () => {
    const spans = findDispatchCallSpans(FIXTURE, 'Agent');
    assert.strictEqual(spans.length, 1, 'exactly one Agent(...) call span found');
    assert.ok(FIXTURE.slice(spans[0].start, spans[0].end).startsWith('Agent(subagent_type="gsd-code-reviewer"'));
  });

  test('the fixture projects fully and correctly (delegate_task head, role injected, no model leak, no residual Agent()', () => {
    const out = convertClaudeToHermesMarkdown(FIXTURE, { runtime: 'hermes' });
    assert.ok(!/\bAgent\(/.test(out), 'no literal Agent( survives');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(out), 'no residual subagent_type');
    assert.ok(out.includes('delegate_task(gsd_role="gsd-code-reviewer"'), 'real call head IS delegate_task(, role resolved inline at the head — not a bare catch-all rename');
    assert.ok(/gsd_role_prompt=/.test(out), 'role-prompt-resolution injected');
    assert.ok(/role="leaf"/.test(out), 'structural role injected');
    const mask = maskStringLiterals(out);
    assert.ok(!/\bmodel\s*[=:]/.test(mask), 'no model= leaked');
  });

  test('the independent post-projection guard catches the deliberately-broken (un-normalized) output this exact fixture used to produce', () => {
    // The round-1/round-2 Frankenstein output: catch-all renamed
    // subagent_type=→gsd_role= but the head stayed literal Agent( and
    // model= leaked through, because the call was never detected as a span.
    const frankenstein = 'Agent(gsd_role="gsd-code-reviewer", model="{REVIEWER_MODEL}", prompt="Review and report.")';
    const toolConfig = hermesToolConfig();
    assert.throws(
      () => _assertProjectionComplete(frankenstein, toolConfig),
      /literal Agent\(/i,
      'the independent guard must fail loud on the exact Frankenstein shape the bug produced',
    );
  });
});

// ─── 7. plan-review-convergence.md dispatch-adjacent terminology (LOW finding a) ──
//
// The projection renamed `Agent(`→`delegate_task(` but originally left
// adjacent bare-word "Agent" references in the SAME sentence/paragraph
// un-normalized (gsd-core/workflows/plan-review-convergence.md ~lines 108,
// 347, 355), producing self-contradictory installed Hermes text (e.g.
// "...delegate_task(...)... the convergence orchestrator runs at depth 0
// with Agent available..."). Fixed via two narrowly-scoped exact-phrase
// replacements (NOT a broad bare-word `Agent` rename, which would corrupt
// legitimate `Agent`-adjacent prose elsewhere — role names, "Agent Brief",
// agent-file references).
describe('#2284 plan-review-convergence.md dispatch-adjacent terminology consistency (LOW finding a)', () => {
  const FILE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
  const CONTENT = fs.readFileSync(FILE, 'utf8');
  const OUT = convertClaudeToHermesMarkdown(CONTENT, { runtime: 'hermes' });

  test('sanity: the source file still contains the two flagged dispatch-adjacent phrases (regression canary for this test itself)', () => {
    assert.ok(/orchestrator runs at depth 0 with Agent available/.test(CONTENT), 'source phrase 1 present');
    assert.ok(/\(bug #936: depth-1 Agent has no Agent tool\)/.test(CONTENT), 'source phrase 2 present');
  });

  test('no literal Agent( survives and no residual bare "Agent available"/"Agent has no Agent tool" contradiction', () => {
    assert.ok(!/\bAgent\(/.test(OUT), 'no literal Agent( call syntax survives');
    assert.ok(!/\bAgent available\b/.test(OUT), 'no bare "Agent available" left adjacent to a renamed delegate_task( mention');
    assert.ok(!/depth-1 Agent has no/.test(OUT), 'no bare "depth-1 Agent" left adjacent to the renamed delegate_task(');
  });

  test('both flagged paragraphs (source ~lines 108, 347) consistently say "delegate_task available"', () => {
    const matches = OUT.match(/orchestrator runs at depth 0 with delegate_task available/g) || [];
    assert.strictEqual(matches.length, 2, 'both paragraphs (initial planning + replan) normalized consistently');
  });

  test('the success_criteria bullet (source ~line 355) reads consistently: "depth-1 delegate_task has no nested delegate_task"', () => {
    assert.ok(OUT.includes('(bug #936: depth-1 delegate_task has no nested delegate_task)'));
  });

  test('unrelated bare "Agent" mentions NOT adjacent to a renamed dispatch call are left untouched (no broad rename)', () => {
    // "Review via Agent → Skill(...)" (success_criteria) has no Agent(...)
    // call in the same bullet — the projection never touched it, so it must
    // not be renamed either.
    assert.ok(OUT.includes('Review via Agent → Skill("gsd-review")'), 'unrelated bare "Agent" prose left intact — no broad bare-word rename');
    // "Hermes Agent" is the runtime's own brand name (from brandingRewrites),
    // never the dispatch primitive — must never be touched by this fix.
    assert.ok(OUT.includes('the one level of nesting that works on Hermes Agent'), 'runtime brand name "Hermes Agent" untouched by the dispatch-terminology fix');
  });
});

// ─── 8. Branding protected-region — <runtime_compatibility> tables (finding b) ──
//
// The shared "Claude Code" → host-brand-name swap (applied by EVERY runtime
// that brands workflow content: cursor/windsurf/trae/cline/codebuddy
// hardcoded, qwen/hermes descriptor-driven) rewrote "Claude Code" even
// inside `<runtime_compatibility>` comparison tables
// (gsd-core/workflows/{plan-phase,execute-phase}.md), where "Claude Code" is
// a COMPARED-RUNTIME LABEL, not a host self-reference — mislabeling the
// comparison. Cross-cutting: reproduces on every branding runtime, not just
// Hermes. Fixed via `applyClaudeCodeBrandSwap`, a protected-region
// extract/restore wrapper used by every runtime's brand-swap call site.
describe('#2284(b) branding protected-region — <runtime_compatibility> comparison tables', () => {
  test('applyClaudeCodeBrandSwap leaves <runtime_compatibility> content byte-identical, but still swaps self-references outside it', () => {
    const fixture = [
      'This tool runs on Claude Code and other hosts.',
      '',
      '<runtime_compatibility>',
      '- **Claude Code:** Uses `Agent(...)` — blocks until complete',
      '- **Other runtimes:** sequential inline execution',
      '</runtime_compatibility>',
      '',
      'Claude Code users should also read CONTRIBUTING.md.',
    ].join('\n');

    const out = applyClaudeCodeBrandSwap(fixture, 'Windsurf');
    const block = out.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
    assert.ok(block.includes('**Claude Code:**'), 'compared-runtime label inside the block is untouched');
    assert.ok(!block.includes('Windsurf'), 'the block never gains the installing runtime\'s own brand name');
    assert.ok(out.includes('This tool runs on Windsurf and other hosts.'), 'genuine self-reference BEFORE the block is branded');
    assert.ok(out.includes('Windsurf users should also read CONTRIBUTING.md.'), 'genuine self-reference AFTER the block is branded');
  });

  test('a no-op brand name (falsy) returns content unchanged (fail-closed default, matches the qwen/hermes "guarded" no-op pattern)', () => {
    const fixture = 'Claude Code does the thing.';
    assert.strictEqual(applyClaudeCodeBrandSwap(fixture, undefined), fixture);
    assert.strictEqual(applyClaudeCodeBrandSwap(fixture, null), fixture);
    assert.strictEqual(applyClaudeCodeBrandSwap(fixture, ''), fixture);
  });

  test('multiple <runtime_compatibility> blocks in the same document are each protected independently', () => {
    const fixture = [
      '<runtime_compatibility>Claude Code: A</runtime_compatibility>',
      'Claude Code self-reference.',
      '<runtime_compatibility>Claude Code: B</runtime_compatibility>',
    ].join('\n');
    const out = applyClaudeCodeBrandSwap(fixture, 'Trae');
    assert.ok(out.includes('<runtime_compatibility>Claude Code: A</runtime_compatibility>'));
    assert.ok(out.includes('<runtime_compatibility>Claude Code: B</runtime_compatibility>'));
    assert.ok(out.includes('Trae self-reference.'));
  });

  test('collision-robust: arbitrary sentinel-like content in surrounding prose (NUL byte, <!--PLACEHOLDER--> token) round-trips untouched while genuine self-references are still swapped — the split-and-rejoin rewrite has no sentinel/placeholder to collide with', () => {
    const fixture = [
      'Claude Code embeds a literal NUL byte here: [\x00] and a placeholder-shaped token <!--PLACEHOLDER--> in its prose.',
      '',
      '<runtime_compatibility>',
      '- **Claude Code:** reference implementation',
      '</runtime_compatibility>',
      '',
      'Claude Code again, after the block.',
    ].join('\n');

    const out = applyClaudeCodeBrandSwap(fixture, 'Trae');

    // Genuine self-references outside the block ARE swapped.
    assert.ok(out.startsWith('Trae embeds'), 'leading self-reference swapped');
    assert.ok(out.includes('Trae again, after the block.'), 'trailing self-reference swapped');

    // The NUL byte survives verbatim, exactly once, with no corruption.
    assert.ok(out.includes('[\x00]'), 'NUL byte preserved verbatim');
    assert.strictEqual(out.split('\x00').length - 1, 1, 'NUL byte appears exactly once — not duplicated or leaked');

    // The placeholder-shaped token survives verbatim, exactly once — proving
    // there is no internal sentinel this content could collide with.
    assert.ok(out.includes('<!--PLACEHOLDER-->'), 'placeholder-shaped token preserved verbatim');
    assert.strictEqual((out.match(/<!--PLACEHOLDER-->/g) || []).length, 1, 'placeholder-shaped token appears exactly once — not duplicated or leaked');

    // The protected block is untouched, including its interior "Claude Code" label.
    const block = out.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
    assert.ok(block.includes('**Claude Code:**'), 'block interior "Claude Code" left verbatim');
    assert.ok(!block.includes('Trae'), 'block never gains the installing runtime\'s own brand name');
  });

  test('inside-AND-outside: a fixture with "Claude Code" both inside a <runtime_compatibility> block and in surrounding prose swaps only the outside occurrence', () => {
    const fixture = [
      'Claude Code is the host running this installer.',
      '<runtime_compatibility>',
      '- **Claude Code:** compared-runtime label, must stay verbatim',
      '</runtime_compatibility>',
      'This is still Claude Code speaking.',
    ].join('\n');

    const out = applyClaudeCodeBrandSwap(fixture, 'Cursor');

    assert.ok(out.includes('Cursor is the host running this installer.'), 'outside occurrence before the block is swapped');
    assert.ok(out.includes('This is still Cursor speaking.'), 'outside occurrence after the block is swapped');

    const block = out.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
    assert.ok(block.includes('**Claude Code:**'), 'inside occurrence is preserved verbatim');
    assert.ok(!block.includes('Cursor'), 'inside occurrence is never swapped');
  });

  describe('real corpus: gsd-core/workflows/execute-phase.md <runtime_compatibility> table', () => {
    const FILE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
    const CONTENT = fs.readFileSync(FILE, 'utf8');

    test('sanity: the source file has a <runtime_compatibility> block containing "Claude Code:" as a compared-runtime label', () => {
      assert.ok(/<runtime_compatibility>/.test(CONTENT));
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      const block = CONTENT.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
      assert.ok(/\*\*Claude Code:\*\*/.test(block));
    });

    test('Windsurf: the compared-runtime label "Claude Code:" is NOT swapped to "Windsurf:", but genuine self-references elsewhere ARE', () => {
      const out = convertClaudeToWindsurfMarkdown(CONTENT);
      const block = out.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
      assert.ok(/\*\*Claude Code:\*\*/.test(block), 'comparison-table label preserved for Windsurf');
      assert.ok(!/\*\*Windsurf:\*\*/.test(block), 'comparison table never mislabeled with the installing runtime\'s own name');
      const outsideBlock = out.replace(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/g, '');
      assert.ok(/\bWindsurf\b/.test(outsideBlock), 'genuine self-references outside the block ARE branded to Windsurf');
      assert.ok(!/\bClaude Code\b/.test(outsideBlock), 'no residual "Claude Code" self-reference survives outside the block');
    });

    test('Hermes: the compared-runtime label "Claude Code:" is NOT swapped to "Hermes Agent:", but genuine self-references elsewhere ARE', () => {
      const out = convertClaudeToHermesMarkdown(CONTENT, { runtime: 'hermes' });
      const block = out.match(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/)[0];
      assert.ok(/\*\*Claude Code:\*\*/.test(block), 'comparison-table label preserved for Hermes');
      assert.ok(!/\*\*Hermes Agent:\*\*/.test(block), 'comparison table never mislabeled with Hermes\'s own brand name');
      const outsideBlock = out.replace(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/g, '');
      assert.ok(/\bHermes Agent\b/.test(outsideBlock), 'genuine self-references outside the block ARE branded to Hermes Agent');
    });
  });
});
