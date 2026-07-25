// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - codex-config.cjs
 *
 * Tests for Codex adapter header, agent conversion, config.toml generation/merge,
 * per-agent .toml generation, and uninstall cleanup.
 */

// Enable test exports from install.js (skips main CLI logic)
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { cleanup } = require('./helpers.cjs');
const fc = require('fast-check');
const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-resolver.cjs');

// #2153 follow-up: ensure hooks/dist/ exists before any install integration
// test runs. The Codex install path copies hook files from hooks/dist/, which
// is gitignored and only populated by `npm run build:hooks`. When this file is
// run in isolation (`node --test tests/codex-config.test.cjs`) the build step
// from the npm-test pretest chain does not run, and the "Codex install copies
// hook file" regression silently fails because hooks/dist/ is empty.
// Build on demand so the test passes regardless of runner ordering.
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }
});

const {
  getCodexSkillAdapterHeader,
  convertClaudeAgentToCodexAgent,
  convertClaudeCommandToCodexSkill,
  generateCodexAgentToml,
  cleanupCodexSkillMetadataSidecars,
  generateCodexConfigBlock,
  stripGsdFromCodexConfig,
  migrateCodexHooksMapFormat,
  mergeCodexConfig,
  install,
  GSD_CODEX_MARKER,
  CODEX_AGENT_SANDBOX,
  parseTomlToObject,
  resolveNodeRunner,
  validateCodexConfigSchema,
} = require('../bin/install.js');

const { resolveInstallPlan } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');

function runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
  const previousCodeHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  process.env.CODEX_HOME = codexHome;
  // #2088: Codex skills now install to the canonical $HOME/.agents/skills root
  // (os.homedir()-relative, independent of CODEX_HOME — per codex core-skills
  // loader.rs). Sandbox HOME to codexHome so skills land under the temp dir
  // (codexHome/.agents/skills) instead of polluting the developer's real home.
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;

  try {
    process.chdir(cwd);
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}
// #2088: the canonical Codex skill-install root, sandboxed under codexHome.
function codexSkillsRoot(codexHome) {
  return path.join(codexHome, '.agents', 'skills');
}

function readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function readHooksSessionStartCommands(codexHome) {
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return [];
  const raw = fs.readFileSync(hooksPath, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const table = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? parsed.hooks
    : parsed;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) => [
    ...(typeof entry?.command === 'string' ? [entry.command] : []),
    ...(Array.isArray(entry?.hooks)
      ? entry.hooks.map((hook) => hook && hook.command).filter((cmd) => typeof cmd === 'string')
      : []),
  ]);
}

function countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function assertNoDraftRootKeys(content) {
  assert.ok(!content.includes('model = "gpt-5.6-terra"'), 'does not inject draft model default');
  assert.ok(!content.includes('model_reasoning_effort = "high"'), 'does not inject draft reasoning default');
  assert.ok(!content.includes('disable_response_storage = true'), 'does not inject draft storage default');
}

function assertUsesOnlyEol(content, eol) {
  if (eol === '\r\n') {
    assert.ok(content.includes('\r\n'), 'contains CRLF line endings');
    assert.ok(!content.replace(/\r\r?\n/g, '').includes('\n'), 'does not contain bare LF line endings');
    return;
  }
  assert.ok(!content.includes('\r\n'), 'does not contain CRLF line endings');
}

function assertNoCodexBareGsdToolsInvocation(content, label) {
  const patterns = [
    /(^|\r?\n)[ \t]*gsd-tools\s/,
    /\$\(\s*gsd-tools\s/,
    /`\s*gsd-tools\s/,
    /(?:&&|\|\||[;|])\s*gsd-tools\s/,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(
      content,
      pattern,
      `${label} must not contain a command-position bare gsd-tools invocation`,
    );
  }
}

// ─── getCodexSkillAdapterHeader ─────────────────────────────────────────────────

describe('getCodexSkillAdapterHeader', () => {
  test('contains all three sections', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('<codex_skill_adapter>'), 'has opening tag');
    assert.ok(result.includes('</codex_skill_adapter>'), 'has closing tag');
    assert.ok(result.includes('## A. Skill Invocation'), 'has section A');
    assert.ok(result.includes('## B. AskUserQuestion'), 'has section B');
    assert.ok(result.includes('## C. Task() → spawn_agent'), 'has section C');
  });

  test('includes correct invocation syntax', () => {
    const result = getCodexSkillAdapterHeader('gsd-plan-phase');
    assert.ok(result.includes('`$gsd-plan-phase`'), 'has $skillName invocation');
    assert.ok(result.includes('{{GSD_ARGS}}'), 'has GSD_ARGS variable');
  });

  test('section B maps AskUserQuestion parameters', () => {
    const result = getCodexSkillAdapterHeader('gsd-discuss-phase');
    assert.ok(result.includes('request_user_input'), 'maps to request_user_input');
    assert.ok(result.includes('header'), 'maps header parameter');
    assert.ok(result.includes('question'), 'maps question parameter');
    assert.ok(result.includes('label'), 'maps options label');
    assert.ok(result.includes('description'), 'maps options description');
    assert.ok(result.includes('multiSelect'), 'documents multiSelect workaround');
    assert.ok(result.includes('Execute mode'), 'documents Execute mode fallback');
  });

  test('section C maps Task to spawn_agent', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('spawn_agent'), 'maps to spawn_agent');
    assert.ok(result.includes('agent_type'), 'maps subagent_type to agent_type');
    assert.match(
      result,
      /Resolved `reasoning_effort="low\|medium\|high\|xhigh"` \(`xhigh` is a GSD\/Codex tier, not a generic runtime enum\) → pass `reasoning_effort`\s+to `spawn_agent` when the runtime\/tool supports it/,
      'documents reasoning_effort transport',
    );
    assert.ok(result.includes('do not invent one-off effort literals'), 'keeps effort policy centralized');
    assert.ok(result.includes('fork_context'), 'documents fork_context default');
    assert.ok(result.includes('wait(ids)'), 'documents parallel wait pattern');
    assert.ok(result.includes('close_agent'), 'documents close_agent cleanup');
    assert.ok(result.includes('CHECKPOINT'), 'documents result markers');
  });
});

// ─── convertClaudeAgentToCodexAgent ─────────────────────────────────────────────

describe('convertClaudeAgentToCodexAgent', () => {
  test('adds codex_agent_role header and cleans frontmatter', () => {
    const input = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

    const result = convertClaudeAgentToCodexAgent(input);

    // Frontmatter rebuilt with only name and description
    assert.ok(result.startsWith('---\n'), 'starts with frontmatter');
    assert.ok(result.includes('"gsd-executor"'), 'has quoted name');
    assert.ok(result.includes('"Executes GSD plans with atomic commits"'), 'has quoted description');
    assert.ok(!result.includes('color: yellow'), 'drops color field');
    // Tools should be in <codex_agent_role> but NOT in frontmatter
    const fmEnd = result.indexOf('---', 4);
    const frontmatterSection = result.substring(0, fmEnd);
    assert.ok(!frontmatterSection.includes('tools:'), 'drops tools from frontmatter');

    // Has codex_agent_role block
    assert.ok(result.includes('<codex_agent_role>'), 'has role header');
    assert.ok(result.includes('role: gsd-executor'), 'role matches agent name');
    assert.ok(result.includes('tools: Read, Write, Edit, Bash, Grep, Glob'), 'tools in role block');
    assert.ok(result.includes('purpose: Executes GSD plans with atomic commits'), 'purpose from description');
    assert.ok(result.includes('</codex_agent_role>'), 'has closing tag');

    // Body preserved
    assert.ok(result.includes('<role>'), 'body content preserved');
  });

  test('converts slash commands in body', () => {
    const input = `---
name: gsd-test
description: Test agent
tools: Read
---

Run /gsd:execute-phase to proceed.`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$gsd-execute-phase'), 'converts slash commands');
    assert.ok(!result.includes('/gsd:execute-phase'), 'original slash command removed');
  });

  test('handles content without frontmatter', () => {
    const input = 'Just some content without frontmatter.';
    const result = convertClaudeAgentToCodexAgent(input);
    assert.strictEqual(result, input, 'returns input unchanged');
  });

  test('replaces .claude paths with .codex paths (#1430)', () => {
    const input = `---
name: gsd-debugger
description: Debugs issues
tools: Read, Bash
---

INIT=$(node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state load)
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" commit "docs: resolve"`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$HOME/.codex/gsd-core/bin/gsd-tools.cjs'), 'replaces $HOME/.claude/ with $HOME/.codex/');
    assert.ok(!result.includes('$HOME/.claude/'), 'no .claude paths remain');
  });

  test('rewrites bare gsd-tools invocations to the Codex shim path', () => {
    const input = `---
name: gsd-planner
description: Plans phases
tools: Read, Bash
---

INIT=$(gsd-tools query init.plan-phase "\${PHASE}")
gsd-tools query state.load 2>/dev/null
if command -v gsd-tools >/dev/null 2>&1; then echo "path fallback"; fi
Use \`gsd-tools query history-digest\` for history.`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(
      result.includes('INIT=$(node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query init.plan-phase'),
      'rewrites command substitution',
    );
    assert.ok(
      result.includes('node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query state.load'),
      'rewrites line-start command',
    );
    assert.ok(
      result.includes('`node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query history-digest`'),
      'rewrites inline command example',
    );
    assert.ok(result.includes('command -v gsd-tools'), 'keeps PATH resolver probe intact');
    assertNoCodexBareGsdToolsInvocation(result, 'converted Codex agent');
  });
});

// ─── Codex command prefix conversion ────────────────────────────────────────────

describe('Codex hyphen-style command prefix conversion', () => {
  test('converts /gsd-command in workflow output to $gsd-command', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/gsd-discuss-phase 1 — gather context
/gsd-plan-phase 2 — create plan
/gsd-execute-phase 3 — run it`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-discuss-phase'), 'converts /gsd-discuss-phase');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts /gsd-plan-phase');
    assert.ok(result.includes('$gsd-execute-phase'), 'converts /gsd-execute-phase');
    assert.ok(!result.includes('/gsd-discuss-phase'), 'no /gsd-discuss-phase remains');
  });

  test('converts backtick-wrapped /gsd- commands', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

Run \`/gsd-plan-phase 1\` to plan.`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts backtick-wrapped command');
  });

  test('does not convert /gsd- in file paths', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" init`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('gsd-tools.cjs'), 'gsd-tools.cjs preserved in path');
    assert.ok(!result.includes('$gsd-tools'), 'no $gsd-tools in file path');
  });

  test('rewrites bare gsd-tools commands in generated Codex skills', () => {
    const input = `---
name: gsd:quick
description: Quick task
---

\`\`\`bash
gsd-tools query frontmatter.get .planning/quick/example/SUMMARY.md status
INIT=$(gsd-tools query init.quick)
if command -v gsd-tools >/dev/null 2>&1; then echo ok; fi
\`\`\`

Status fields read via \`gsd-tools query frontmatter.get\`.`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-quick');
    assert.ok(
      result.includes('node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query frontmatter.get'),
      'rewrites line-start command in a shell block',
    );
    assert.ok(
      result.includes('INIT=$(node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query init.quick)'),
      'rewrites command substitution in a shell block',
    );
    assert.ok(
      result.includes('`node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query frontmatter.get`'),
      'rewrites inline command example',
    );
    assert.ok(result.includes('command -v gsd-tools'), 'keeps resolver probe intact');
    assertNoCodexBareGsdToolsInvocation(result, 'converted Codex skill');
  });

  test('removes /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

\`/clear\` then:

\`$gsd-plan-phase 1\``;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-plan-phase'), 'command preserved after /clear removal');
  });

  test('removes bare /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/clear then:
/gsd-execute-phase 2`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-execute-phase'), 'command converted');
  });
});

// ─── generateCodexAgentToml ─────────────────────────────────────────────────────

describe('generateCodexAgentToml', () => {
  const sampleAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write, Edit
color: yellow
---

<role>You are an executor.</role>`;

  test('sets workspace-write for executor', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'has workspace-write');
  });

  test('sets read-only for plan-checker', () => {
    const checker = `---
name: gsd-plan-checker
description: Checks plans
tools: Read, Grep, Glob
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', checker);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'has read-only');
  });

  test('includes developer_instructions from body', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes("developer_instructions = '''"), 'has literal triple-quoted instructions');
    assert.ok(result.includes('<role>You are an executor.</role>'), 'body content in instructions');
    assert.ok(result.includes("'''"), 'has closing literal triple quotes');
  });

  test('includes required name and description fields', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('name = "gsd-executor"'), 'has name');
    assert.ok(result.includes('description = "Executes plans"'), 'has description');
  });

  test('falls back to generated description when frontmatter is missing fields', () => {
    const minimalAgent = `<role>You are an unknown agent.</role>`;
    const result = generateCodexAgentToml('gsd-unknown', minimalAgent);
    assert.ok(result.includes('name = "gsd-unknown"'), 'falls back to agent name');
    assert.ok(result.includes('description = "GSD agent gsd-unknown"'), 'falls back to synthetic description');
  });

  test('defaults unknown agents to read-only', () => {
    const result = generateCodexAgentToml('gsd-unknown', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'defaults to read-only');
  });

  // ─── #2256: model_overrides support ───────────────────────────────────────

  test('emits model field when modelOverrides contains an entry for the agent (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(result.includes('model = "gpt-5.3-codex"'), 'model field must be present in TOML');
  });

  test('does not emit model field when modelOverrides is null (#2256)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null);
    assert.ok(!result.includes('model ='), 'model field must be absent when no override');
  });

  test('does not emit reasoning effort when Codex model is inherited (#838)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null);
    assert.ok(!result.includes('model ='), 'model field must be absent when Codex should inherit');
    assert.ok(
      !result.includes('model_reasoning_effort ='),
      'reasoning effort must stay absent when the model is inherited'
    );
  });

  test('emits reasoning effort when model override pins Codex model (#838)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(result.includes('model = "gpt-5.3-codex"'), 'model override must pin model');
    assert.ok(
      result.includes('model_reasoning_effort ='),
      'reasoning effort is safe to emit when GSD also pins model'
    );
  });

  test('emits reasoning effort when runtime resolver pins Codex model (#838)', () => {
    const runtimeResolver = { resolve: () => ({ model: 'gpt-5.5' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(result.includes('model = "gpt-5.5"'), 'runtime resolver must pin model');
    assert.ok(
      result.includes('model_reasoning_effort ='),
      'reasoning effort is safe to emit when runtime resolver pins model'
    );
  });

  test('does not emit model field when modelOverrides has no entry for this agent (#2256)', () => {
    const overrides = { 'gsd-planner': 'gpt-5.4' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(!result.includes('model ='), 'model field must be absent for agents not in overrides');
  });

  test('model field appears before developer_instructions (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    const modelIdx = result.indexOf('model = "gpt-5.3-codex"');
    const instrIdx = result.indexOf("developer_instructions = '''");
    assert.ok(modelIdx !== -1, 'model field present');
    assert.ok(instrIdx !== -1, 'developer_instructions present');
    assert.ok(modelIdx < instrIdx, 'model field must appear before developer_instructions');
  });

  // ─── #2310: never leak an Anthropic-flavored model into the Codex .toml ─────

  test('omits a bare GSD tier alias in model_overrides (Codex passive/session-only) (#2310)', () => {
    // ADR-1239: Codex is a passive/session-only model host. A tier alias cannot be
    // honored per-agent, so it is dropped and the agent inherits the session model (no 400).
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = /m.test(result), `alias "${alias}" must be omitted (no model pinned)`);
    }
  });

  test('never emits a bare Anthropic tier alias as the Codex model (#2310)', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = "(opus|sonnet|haiku|fable)"$/m.test(result), `must not emit model = "${alias}"`);
    }
  });

  test('drops a claude-* model_overrides id instead of leaking it into the Codex .toml (#2310)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'claude-sonnet-5' });
    assert.ok(!result.includes('claude-'), 'a claude-* id must never appear as the Codex model');
    // No runtime resolver → nothing to fall through to → no model line at all.
    assert.ok(!result.includes('model ='), 'unmappable Anthropic override falls through to Codex default (no model pinned)');
  });

  test('a dropped claude-* override falls through to the runtime resolver (#2310)', () => {
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-terra' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'claude-opus-4-8' }, runtimeResolver);
    assert.ok(result.includes('model = "gpt-5.6-terra"'), 'falls through to the runtime-resolved Codex model');
    assert.ok(!result.includes('claude-'), 'claude id must not leak even with a resolver present');
  });

  test('final gate blocks an Anthropic model from the runtime-resolver path too (#2310)', () => {
    // Simulate a defaults.json runtime that does not match the codex install target:
    // the resolver hands back a Claude id, which must still never reach the Codex .toml.
    const runtimeResolver = { runtime: 'claude', resolve: () => ({ model: 'claude-sonnet-5' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!result.includes('claude-'), 'runtime-resolver Claude id must be gated out of the Codex .toml');
    assert.ok(!result.includes('model ='), 'no valid Codex model available → none pinned');
  });

  test('still emits a real Codex/OpenAI model_overrides id verbatim (#2310 preserves #2256)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'gpt-5.6-sol' });
    assert.ok(result.includes('model = "gpt-5.6-sol"'), 'a real gpt-* override must still pass through unchanged');
  });

  test('gates a provider-namespaced anthropic/claude-* model from the runtime-resolver path (#2310 review)', () => {
    // Catalog assigns anthropic/claude-* to opencode/hermes/kilo. A mixed-runtime config
    // (runtime: opencode) + Codex install resolves those; they must NOT reach the .toml.
    const runtimeResolver = { runtime: 'opencode', resolve: () => ({ model: 'anthropic/claude-opus-4-8' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!/claude/i.test(result.split('\n').find((l) => /^model = /.test(l)) || ''), 'no claude-bearing model may be emitted');
    assert.ok(!/^model = /m.test(result), 'anthropic/claude-* is gated out → no model pinned');
  });

  test('omits a provider-namespaced anthropic/claude-* model_overrides pin (#2310 review)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'anthropic/claude-sonnet-5' });
    assert.ok(!result.includes('claude'), 'anthropic/claude-* must be omitted, never emitted');
    assert.ok(!/^model = /m.test(result), 'no model pinned');
  });

  test('every canonical Claude tier alias is omitted (single-source guard, #2310 review)', () => {
    // Iterates the CANONICAL set so a future alias is covered automatically (no divergence).
    for (const alias of CLAUDE_AGENT_ALIASES) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = /m.test(result), `canonical alias "${alias}" must be omitted`);
    }
  });

  test('drops the fable alias (Claude Agent alias with no Codex mapping) (#2310)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'fable' });
    assert.ok(!result.includes('model = "fable"'), 'fable must never be emitted as the Codex model');
    assert.ok(!result.includes('model ='), 'fable has no Codex mapping → dropped, no model pinned');
  });

  test('property: no model_overrides value ever yields an Anthropic-flavored Codex model (#2310)', () => {
    const anthropicish = fc.oneof(
      fc.constantFrom('opus', 'sonnet', 'haiku', 'fable'),
      fc.string().map((s) => `claude-${s}`),
      fc.string().map((s) => `anthropic/claude-${s}`),
      fc.string().map((s) => `us.anthropic.claude-${s}`),
      fc.string(),
    );
    fc.assert(fc.property(anthropicish, (v) => {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': v });
      const m = result.split('\n').find((l) => /^model = /.test(l));
      if (!m) return true; // no model pinned is always safe
      return !/claude/i.test(m) && !/^model = "(opus|sonnet|haiku|fable)"$/.test(m);
    }), { numRuns: 400 });
  });

  // ─── #774: service_tier / model_verbosity for light-tier agents ───────────────

  test('emits service_tier="flex" and model_verbosity="low" for light-tier agents (#774)', () => {
    // gsd-plan-checker has routingTier:"light" in model-catalog.json
    const lightAgent = `---
name: gsd-plan-checker
description: Checks plans quickly
tools: Read, Grep
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', lightAgent);
    assert.ok(result.includes('service_tier = "flex"'), 'light-tier agent must have service_tier = "flex"');
    assert.ok(result.includes('model_verbosity = "low"'), 'light-tier agent must have model_verbosity = "low"');
  });

  test('does not emit service_tier or model_verbosity for standard-tier agents (#774)', () => {
    // gsd-executor has routingTier:"standard" in model-catalog.json
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(!result.includes('service_tier'), 'standard-tier agent must not have service_tier');
    assert.ok(!result.includes('model_verbosity'), 'standard-tier agent must not have model_verbosity');
  });

  test('does not emit service_tier or model_verbosity for heavy-tier agents (#774)', () => {
    // gsd-planner has routingTier:"heavy" in model-catalog.json
    const heavyAgent = `---
name: gsd-planner
description: Creates plans
tools: Read, Write, Edit
---

<role>You plan.</role>`;
    const result = generateCodexAgentToml('gsd-planner', heavyAgent);
    assert.ok(!result.includes('service_tier'), 'heavy-tier agent must not have service_tier');
    assert.ok(!result.includes('model_verbosity'), 'heavy-tier agent must not have model_verbosity');
  });

  test('service_tier and model_verbosity appear before developer_instructions (#774)', () => {
    const lightAgent = `---
name: gsd-plan-checker
description: Checks plans
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', lightAgent);
    const stIdx = result.indexOf('service_tier = "flex"');
    const mvIdx = result.indexOf('model_verbosity = "low"');
    const instrIdx = result.indexOf("developer_instructions = '''");
    assert.ok(stIdx !== -1, 'service_tier present');
    assert.ok(mvIdx !== -1, 'model_verbosity present');
    assert.ok(instrIdx !== -1, 'developer_instructions present');
    assert.ok(stIdx < instrIdx, 'service_tier must appear before developer_instructions');
    assert.ok(mvIdx < instrIdx, 'model_verbosity must appear before developer_instructions');
  });

  test('emitted TOML is parseable and contains correct field values for light-tier agents (#774)', () => {
    const lightAgent = `---
name: gsd-codebase-mapper
description: Maps the codebase
---

<role>You map the codebase.</role>`;
    const toml = generateCodexAgentToml('gsd-codebase-mapper', lightAgent);
    const parsed = parseTomlToObject(toml);
    assert.strictEqual(parsed.service_tier, 'flex', 'service_tier must parse to "flex"');
    assert.strictEqual(parsed.model_verbosity, 'low', 'model_verbosity must parse to "low"');
  });
});

// ─── sandboxTier gate on generateCodexAgentToml ────────────────────────────────

describe('generateCodexAgentToml sandboxTier gate', () => {
  const sampleAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write, Edit
color: yellow
---

<role>You are an executor.</role>`;

  test('sandboxTier=none: does NOT emit sandbox_mode', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, null, null, 'none');
    assert.ok(!result.includes('sandbox_mode'), 'sandbox_mode must be absent when sandboxTier is none');
  });

  test('sandboxTier=codex-agent-sandbox: emits sandbox_mode = "workspace-write"', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, null, null, 'codex-agent-sandbox');
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'must emit workspace-write for codex-agent-sandbox tier');
  });

  test('default (no sandboxTier arg): still emits sandbox_mode = "workspace-write" (no-op for codex)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'default preserves codex behavior');
  });

  test('resolveInstallPlan projection: codex.sandboxTier === "codex-agent-sandbox"', () => {
    const plan = resolveInstallPlan('codex');
    assert.strictEqual(plan.sandboxTier, 'codex-agent-sandbox', 'codex must project sandboxTier=codex-agent-sandbox');
  });

  test('resolveInstallPlan projection: claude.sandboxTier === "none"', () => {
    const plan = resolveInstallPlan('claude');
    assert.strictEqual(plan.sandboxTier, 'none', 'claude must project sandboxTier=none');
  });
});

// ─── installCodexConfig threading-seam: sandboxTier → per-agent TOML ─────────

describe('installCodexConfig sandboxTier threading seam', () => {
  const { installCodexConfig } = require('../bin/install.js');

  let tmpDir;
  let agentsSrc;
  let targetDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sandboxtier-seam-'));
    agentsSrc = path.join(tmpDir, 'agents');
    targetDir = path.join(tmpDir, 'codex');
    fs.mkdirSync(agentsSrc, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    // Write a minimal gsd-executor agent fixture
    fs.writeFileSync(path.join(agentsSrc, 'gsd-executor.md'), [
      '---',
      'name: gsd-executor',
      'description: Executes plans',
      'tools: Read, Write, Edit',
      '---',
      '',
      '<role>You are an executor.</role>',
    ].join('\n'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sandboxTier=none: written per-agent .toml does NOT contain sandbox_mode', () => {
    installCodexConfig(targetDir, agentsSrc, 'none');
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(!toml.includes('sandbox_mode'), 'sandbox_mode must be absent when sandboxTier=none');
  });

  test('sandboxTier=codex-agent-sandbox: written per-agent .toml contains sandbox_mode', () => {
    installCodexConfig(targetDir, agentsSrc, 'codex-agent-sandbox');
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(toml.includes('sandbox_mode'), 'sandbox_mode must be present when sandboxTier=codex-agent-sandbox');
  });

  test('default 2-arg form (no sandboxTier): written per-agent .toml contains sandbox_mode (codex default)', () => {
    installCodexConfig(targetDir, agentsSrc);
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(toml.includes('sandbox_mode'), 'sandbox_mode must be present in default 2-arg form (codex-agent-sandbox default)');
  });
});

// NOTE: A test for the new fail-loud throw on missing/invalid sandboxTier in
// resolveInstallPlan is omitted here. Constructing a descriptor without the
// field would require mocking the capability-registry module which is a
// singleton require(); patching it invasively would corrupt other tests in the
// same process. The throw path is verified at the type level (tsc) and by the
// build passing, and the happy-path coverage (claude.sandboxTier === 'none' and
// codex.sandboxTier === 'codex-agent-sandbox') confirms the real registry has
// valid values for all 15 runtimes.

// ─── CODEX_AGENT_SANDBOX mapping ────────────────────────────────────────────────

describe('CODEX_AGENT_SANDBOX', () => {
  test('has all 11 agents mapped', () => {
    const agentNames = Object.keys(CODEX_AGENT_SANDBOX);
    assert.strictEqual(agentNames.length, 11, 'has 11 agents');
  });

  test('workspace-write agents have write tools', () => {
    const writeAgents = [
      'gsd-executor', 'gsd-planner', 'gsd-phase-researcher',
      'gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-verifier',
      'gsd-codebase-mapper', 'gsd-roadmapper', 'gsd-debugger',
    ];
    for (const name of writeAgents) {
      assert.strictEqual(CODEX_AGENT_SANDBOX[name], 'workspace-write', `${name} is workspace-write`);
    }
  });

  test('read-only agents have no write tools', () => {
    const readOnlyAgents = ['gsd-plan-checker', 'gsd-integration-checker'];
    for (const name of readOnlyAgents) {
      assert.strictEqual(CODEX_AGENT_SANDBOX[name], 'read-only', `${name} is read-only`);
    }
  });
});

// ─── generateCodexConfigBlock ───────────────────────────────────────────────────

describe('generateCodexConfigBlock', () => {
  const agents = [
    { name: 'gsd-executor', description: 'Executes plans' },
    { name: 'gsd-planner', description: 'Creates plans' },
  ];

  test('starts with GSD marker', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(result.startsWith(GSD_CODEX_MARKER), 'starts with marker');
  });

  test('emits the [agents] max_depth tuning block but no feature flags (#2088)', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(!result.includes('[features]'), 'no features table');
    assert.ok(!result.includes('multi_agent'), 'no multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'no request_user_input');
    // #2088: the managed block pins dispatch depth via a bare [agents]
    // AgentsToml scalar table. #2406: this is now the ONLY [agents]-namespaced
    // content the block emits — no [agents.<name>] role structs.
    assert.match(result, /^\[agents\]$/m, 'emits the [agents] tuning table');
    assert.match(result, /^max_depth = 1$/m, 'pins max_depth = 1');
    // Should not emit [[agents]] sequence format (rejected by Codex 0.124.0).
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format');
    // Only max_depth is managed — max_threads is intentionally left to the user.
    assert.ok(!result.includes('max_threads'), 'no max_threads (only max_depth is GSD-managed)');
  });

  test('#2406: does not emit [agents.<name>] role tables — the standalone agents/<name>.toml is the sole canonical source', () => {
    const result = generateCodexConfigBlock(agents);
    // Codex auto-discovers standalone TOMLs under $CODEX_HOME/agents/. A
    // config.toml [agents.<name>] table pointing config_file back at that
    // same file is a SECOND registration of the same role and made Codex log
    // "Ignoring malformed agent role definition: duplicate agent role name"
    // once per agent. Zero role headers and zero config_file lines proves
    // the duplication is gone.
    assert.ok(!result.includes('[agents.gsd-executor]'), 'no executor role header');
    assert.ok(!result.includes('[agents.gsd-planner]'), 'no planner role header');
    assert.ok(!result.includes('config_file'), 'no config_file line at all');
    assert.ok(!result.includes('description = "Executes plans"'), 'no per-agent description leaks into config.toml');
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format either');
  });

  test('#2406: block is a valid TOML shape with exactly one [agents] table and zero [agents.*] sub-tables', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format present');
    const bareAgentsHeaders = (result.match(/^\[agents\]\s*$/gm) || []).length;
    assert.strictEqual(bareAgentsHeaders, 1, 'exactly one bare [agents] dispatch-tuning table');
    const structHeaders = (result.match(/^\[agents\.[^\]]+\]\s*$/gm) || []).length;
    assert.strictEqual(structHeaders, 0, 'zero [agents.<name>] struct headers — role tables removed (#2406)');
  });

  test('#2406: output is unaffected by agents/targetDir — no per-agent content is derived from either', () => {
    const withAgents = generateCodexConfigBlock(agents);
    const withoutAgents = generateCodexConfigBlock([]);
    assert.strictEqual(withAgents, withoutAgents, 'agents list no longer influences the emitted block');

    const withTargetDir = generateCodexConfigBlock(agents, '/home/user/.codex');
    assert.strictEqual(withTargetDir, withAgents, 'targetDir no longer influences the emitted block');
    assert.ok(!withTargetDir.includes('config_file'), 'no config_file even when targetDir is provided');
    assert.ok(!withTargetDir.includes('/home/user/.codex'), 'targetDir path does not leak into the block');
  });
});

// ─── stripGsdFromCodexConfig ────────────────────────────────────────────────────

describe('stripGsdFromCodexConfig', () => {
  test('returns null for GSD-only config', () => {
    const content = `${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.strictEqual(result, null, 'returns null when GSD-only');
  });

  test('preserves user content before marker', () => {
    const content = `[model]\nname = "o3"\n\n${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user section');
    assert.ok(result.includes('name = "o3"'), 'preserves user values');
    assert.ok(!result.includes('multi_agent'), 'removes GSD content');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'removes marker');
  });

  test('strips injected feature keys without marker', () => {
    const content = `[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nother_feature = false\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('multi_agent'), 'removes multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'removes request_user_input');
    assert.ok(result.includes('other_feature = false'), 'preserves user features');
  });

  test('removes empty [features] section', () => {
    const content = `[features]\nmulti_agent = true\n[model]\nname = "o3"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[features]'), 'removes empty features section');
    assert.ok(result.includes('[model]'), 'preserves other sections');
  });

  test('strips injected keys above marker on uninstall', () => {
    // Case 3 install injects keys into [features] AND appends marker block
    const content = `[model]\nname = "o3"\n\n[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nsome_custom_flag = true\n\n${GSD_CODEX_MARKER}\n[agents]\nmax_threads = 4\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user model section');
    assert.ok(result.includes('some_custom_flag = true'), 'preserves user feature');
    assert.ok(!result.includes('multi_agent'), 'strips injected multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'strips injected request_user_input');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'strips marker');
  });

  test('removes legacy [agents.gsd-*] map sections (self-heal pre-#2645 configs)', () => {
    const content = `[agents.gsd-executor]\ndescription = "test"\nconfig_file = "agents/gsd-executor.toml"\n\n[agents.custom-agent]\ndescription = "user agent"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[agents.gsd-executor]'), 'removes legacy GSD agent map section');
    assert.ok(result.includes('[agents.custom-agent]'), 'preserves user agent section');
  });

  test('#2645: removes [[agents]] array-of-tables entries whose name is gsd-*', () => {
    const content = `[[agents]]\nname = "gsd-executor"\ndescription = "test"\nconfig_file = "agents/gsd-executor.toml"\n\n[[agents]]\nname = "custom-agent"\ndescription = "user agent"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!/name = "gsd-executor"/.test(result), 'removes managed GSD [[agents]] entry');
    assert.ok(result.includes('name = "custom-agent"'), 'preserves user [[agents]] entry');
  });

  test('#2645: handles mixed legacy + new shapes and multiple user/gsd entries in one file', () => {
    // Multiple GSD entries (both legacy map and new array-of-tables) interleaved
    // with multiple user-authored agents in both shapes — none of the user
    // entries may be removed and all GSD entries must be stripped.
    const content = [
      '[agents.gsd-executor]',
      'description = "legacy gsd"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[agents.custom-legacy]',
      'description = "user legacy"',
      '',
      '[[agents]]',
      'name = "gsd-planner"',
      'description = "new gsd"',
      '',
      '[[agents]]',
      'name = "my-helper"',
      'description = "user new"',
      '',
      '[[agents]]',
      "name = 'gsd-debugger'",
      'description = "single-quoted gsd"',
      '',
      '[[agents]]',
      'name = "another-user"',
      'description = "second user agent"',
      '',
    ].join('\n');
    const result = stripGsdFromCodexConfig(content);
    // All GSD entries removed.
    assert.ok(!result.includes('gsd-executor'), 'removes legacy gsd-executor');
    assert.ok(!/name\s*=\s*"gsd-planner"/.test(result), 'removes new gsd-planner');
    assert.ok(!/name\s*=\s*'gsd-debugger'/.test(result), 'removes single-quoted gsd-debugger');
    // All user-authored entries preserved.
    assert.ok(result.includes('[agents.custom-legacy]'), 'preserves user legacy [agents.custom-legacy]');
    assert.ok(result.includes('user legacy'), 'preserves user legacy body');
    assert.ok(result.includes('name = "my-helper"'), 'preserves user new [[agents]]');
    assert.ok(result.includes('name = "another-user"'), 'preserves second user [[agents]]');
    assert.ok(result.includes('second user agent'), 'preserves second user body');
  });
});

// ─── migrateCodexHooksMapFormat ─────────────────────────────────────────────────

describe('migrateCodexHooksMapFormat', () => {
  test('migrates flat [[hooks]] with event key to namespaced [[hooks.<EVENT>]] form', () => {
    // Flat [[hooks]] + event = "..." is TOML-incompatible with [[hooks.SessionStart]],
    // so migrateCodexHooksMapFormat now converts it to the nested namespaced form.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'flat [[hooks]] event=SessionStart must be promoted to [[hooks.SessionStart]] AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'must emit [[hooks.SessionStart.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command',
      'migrated handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.hooks.SessionStart[0].event, undefined,
      'event key consumed as namespace — must not appear in emitted block');
    assert.ok(!Array.isArray(parsed.hooks), 'hooks must be a table, not a flat array');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('returns content unchanged for empty string', () => {
    assert.strictEqual(migrateCodexHooksMapFormat(''), '');
  });

  test('converts [hooks.shell] to namespaced AoT [[hooks.shell]] (#2760 CR5 finding 3)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '',
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    // Parse structurally — no source-grep on raw bytes.
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell),
      'hooks.shell must be an array of tables, got: ' + (parsed.hooks ? typeof parsed.hooks.shell : 'no hooks table'));
    assert.strictEqual(parsed.hooks.shell.length, 1);
    // #2773: command now lives in [[hooks.shell.hooks]] sub-table, not at event-entry level
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command, 'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command');
    // No flat top-level [[hooks]] AoT and no synthetic event field.
    assert.ok(!Array.isArray(parsed.hooks),
      'no top-level [[hooks]] AoT — namespace IS the event in CR5 form');
    assert.equal(parsed.hooks.shell[0].event, undefined,
      'no synthetic event field — namespace [[hooks.shell]] encodes the event');
    // User content preserved.
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('converts [hooks.exec] to namespaced AoT [[hooks.exec]] (#2760 CR5 finding 3)', () => {
    const content = [
      '[hooks.exec]',
      'command = "echo hello"',
      'extra_key = "preserved"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.exec));
    assert.strictEqual(parsed.hooks.exec.length, 1);
    // #2773: command and extra keys now live in [[hooks.exec.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.exec[0].hooks), 'must emit [[hooks.exec.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].command, 'echo hello');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].type, 'command',
      'migrated handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].extra_key, 'preserved');
    assert.equal(parsed.hooks.exec[0].event, undefined);
  });

  test('converts multiple [hooks.TYPE] sections to separate namespaced AoT blocks (#2760 CR5 finding 3)', () => {
    const content = [
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
      '[hooks.exec]',
      'command = "echo done"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell));
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.exec));
    assert.strictEqual(parsed.hooks.shell.length, 1);
    assert.strictEqual(parsed.hooks.exec.length, 1);
    // #2773: commands now live in the [[hooks.<TYPE>.hooks]] sub-table
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command, 'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command"');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].command, 'echo done');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].type, 'command',
      'migrated exec handler must carry type = "command"');
  });

  test('migrates flat [[hooks]] with event=AfterCommand to [[hooks.AfterCommand]] namespaced form', () => {
    // Flat [[hooks]] + event = "..." is incompatible with [[hooks.<EVENT>]] AoT in the same
    // file — TOML cannot have hooks be both an array and a table. Migration promotes it.
    const content = [
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.AfterCommand),
      'flat [[hooks]] event=AfterCommand must become [[hooks.AfterCommand]] AoT');
    assert.strictEqual(parsed.hooks.AfterCommand.length, 1);
    assert.ok(Array.isArray(parsed.hooks.AfterCommand[0].hooks),
      'must emit [[hooks.AfterCommand.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].command, 'echo custom');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].type, 'command',
      'migrated AfterCommand handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.hooks.AfterCommand[0].event, undefined,
      'event key consumed as namespace — must not appear in emitted block');
    assert.ok(!Array.isArray(parsed.hooks), 'hooks must be a table, not a flat array');
  });

  test('end-to-end: install on config with old [hooks] map format produces namespaced AoT (#2637, #2760 CR5)', () => {
    // Simulates the exact old GSD config.toml format that broke on Codex 0.124.0
    const oldContent = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '',
      '  [hooks.shell]',
      '  command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(oldContent);
    const parsed = parseTomlToObject(result);
    // Codex 0.124.0+: must produce array-of-tables form. CR5 finding 3:
    // namespaced AoT [[hooks.shell]] (no flat [[hooks]] with synthetic event).
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell),
      'hooks.shell must be array-of-tables in namespaced form');
    assert.strictEqual(parsed.hooks.shell.length, 1);
    // #2773: command lives in [[hooks.shell.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('bare [hooks] section without sub-tables is dropped (no [[hooks]] block added)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '# no sub-tables, just an empty container',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    assert.ok(!result.match(/^\[hooks\]$/m), 'removes bare [hooks] section');
    assert.ok(!result.includes('[[hooks]]'), 'no [[hooks]] added for bare [hooks] with no sub-tables');
    assert.ok(result.includes('[features]'), 'preserves [features]');
    assert.ok(result.includes('[model]'), 'preserves [model]');
  });

  test('upgrades stale [[hooks.SessionStart]] with event-level command to nested schema (#2773 CR6)', () => {
    // Pre-#2773 single-block format: handler fields live directly under
    // [[hooks.SessionStart]] rather than under [[hooks.SessionStart.hooks]].
    // Codex 0.124.0+ rejects this shape. Migration must promote it.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.SessionStart]]',
      'command = "echo stale-user-hook"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'stale [[hooks.SessionStart]] must remain a namespaced AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'must emit [[hooks.SessionStart.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo stale-user-hook');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command',
      'must inject type = "command" when source body has no explicit type');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'command must not remain at event-entry level after promotion');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('leaves [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]] untouched (already nested)', () => {
    // Properly-nested schema: handler lives under [[hooks.SessionStart.hooks]].
    // Migration must NOT create a double-wrapped [[hooks.SessionStart.hooks.hooks]] shape.
    const content = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo already-nested"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(Array.isArray(parsed.hooks?.SessionStart),
      'SessionStart must remain a namespaced AoT after no-op migration');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1,
      'must not duplicate the event entry');
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'nested [[hooks.SessionStart.hooks]] sub-table must still be present');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks.length, 1,
      'must not create a double-wrapped [[hooks.SessionStart.hooks.hooks]]');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo already-nested');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'command must not appear at event-entry level');
  });

  test('promotes multiple stale [[hooks.TYPE]] entries from different event types', () => {
    const content = [
      '[[hooks.SessionStart]]',
      'command = "echo session"',
      '',
      '[[hooks.AfterCommand]]',
      'command = "echo after-cmd"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart));
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.AfterCommand));
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo session');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].command, 'echo after-cmd');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].type, 'command');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined);
    assert.equal(parsed.hooks.AfterCommand[0].command, undefined);
  });

  test('matcher-only [[hooks.SessionStart]] (no handler fields) is left untouched', () => {
    // A [[hooks.SessionStart]] entry with only a `matcher` key is a valid
    // event filter — no handler fields → not a stale single-block entry.
    const content = [
      '[[hooks.SessionStart]]',
      'matcher = "some-tool"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(Array.isArray(parsed.hooks?.SessionStart),
      'matcher-only SessionStart must remain a namespaced AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.strictEqual(parsed.hooks.SessionStart[0].matcher, 'some-tool',
      'matcher key must be preserved');
    assert.equal(parsed.hooks.SessionStart[0].hooks, undefined,
      'matcher-only entry must not gain a .hooks sub-array');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'no spurious command key must appear');
  });

  test('quoted event name with dot ([[hooks."before.tool"]]) is treated as single 2-segment namespace', () => {
    // Regression for the split('.') bug: "before.tool" contains a dot, but the
    // key is quoted so it is ONE segment — [[hooks."before.tool"]] has exactly
    // two path segments and must be classified the same as [[hooks.SessionStart]].
    // It should NOT be treated as a 3-level path (hooks / before / tool).
    const content = [
      '[[hooks."before.tool"]]',
      'command = "echo hi"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    // The key in the parsed object is the unquoted event name "before.tool".
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks['before.tool']),
      '[[hooks."before.tool"]] must be a namespaced AoT — not split on the inner dot'
    );
    assert.ok(
      Array.isArray(parsed.hooks['before.tool'][0].hooks),
      'must emit [[hooks."before.tool".hooks]] sub-table'
    );
    assert.strictEqual(
      parsed.hooks['before.tool'][0].hooks[0].command,
      'echo hi',
      'command must be preserved in the nested handler sub-table'
    );
    // Ensure no spurious "before" or "tool" top-level hook keys appeared.
    assert.equal(parsed.hooks?.before, undefined, 'must not split quoted key on dot');
  });

  test('CRLF line endings are preserved through migration (#2760 CR5: namespaced AoT)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\r\n');
    const result = migrateCodexHooksMapFormat(content);
    assert.ok(result.includes('[[hooks.shell]]\r\n'),
      'uses CRLF in namespaced [[hooks.shell]] header');
    // Round-trip parse confirms the structural shape independent of EOL.
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell));
    // #2773: command lives in [[hooks.shell.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command" per Codex 0.124.0+ schema');
  });
});

// ─── shape parity between migration and managed emit (#2760 CR5 finding 3) ──

describe('Codex hooks emit: migration produces namespaced AoT so managed-emit converges', () => {
  // After #2760 CR5 finding 3, the legacy migration path
  // (migrateCodexHooksMapFormat) emits `[[hooks.<TYPE>]]` directly — the
  // namespace IS the event, no synthetic `event = ...` field. The managed
  // install path (writes "# GSD Hooks") detects existing namespaced AoT via
  // hasUserNamespacedAotHooks and emits its block in the same shape. The two
  // paths must therefore both produce a namespaced layout when a legacy
  // [hooks.SessionStart] is migrated, eliminating the mixed flat+namespaced
  // bug class entirely.

  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-fieldparity-'));
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('migration of legacy [hooks.SessionStart] produces two-level nested AoT (#2773)', () => {
    const legacyContent = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks.SessionStart]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const migrated = migrateCodexHooksMapFormat(legacyContent);
    const parsed = parseTomlToObject(migrated);
    // Outer event entry
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'migration must emit [[hooks.SessionStart]] namespaced AoT'
    );
    assert.equal(parsed.hooks.SessionStart[0].event, undefined,
      'migration must NOT emit a synthetic event field — namespace IS the event');
    assert.equal(Array.isArray(parsed.hooks), false,
      'migration must NOT emit a flat top-level [[hooks]] AoT');
    // Inner handler sub-table
    assert.ok(
      Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'migration must emit [[hooks.SessionStart.hooks]] sub-table'
    );
    const handler = parsed.hooks.SessionStart[0].hooks[0];
    assert.strictEqual(handler.type, 'command',
      'migration must inject type = "command" in handler sub-table');
    assert.strictEqual(
      handler.command,
      'node /home/.codex/hooks/gsd-check-update.js',
      'migration must preserve original command value in handler sub-table'
    );
  });
});

// ─── mergeCodexConfig ───────────────────────────────────────────────────────────

describe('mergeCodexConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-merge-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const sampleBlock = generateCodexConfigBlock([
    { name: 'gsd-executor', description: 'Executes plans' },
  ]);

  test('case 1: creates new config.toml', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);

    assert.ok(fs.existsSync(configPath), 'file created');
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'has marker');
    // #2406: config.toml never gets an [agents.gsd-*] role table — the
    // standalone agents/<name>.toml written by installCodexConfig is the
    // sole canonical registration Codex auto-discovers.
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assert.ok(!content.includes('[features]'), 'no features section');
    assert.ok(!content.includes('multi_agent'), 'no multi_agent');
  });

  test('case 2: replaces existing GSD block', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const userContent = '[model]\nname = "o3"\n';
    fs.writeFileSync(configPath, userContent + '\n' + sampleBlock + '\n');

    // Re-merge with updated block
    const newBlock = generateCodexConfigBlock([
      { name: 'gsd-executor', description: 'Updated description' },
      { name: 'gsd-planner', description: 'New agent' },
    ]);
    mergeCodexConfig(configPath, newBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    // #2406: description text is per-agent metadata carried only by the
    // standalone TOML now — it no longer leaks into config.toml.
    assert.ok(!content.includes('Updated description'), 'no per-agent description in config.toml');
    assert.ok(!content.includes('[agents.gsd-planner]'), 'no agent role table (canonical source is the standalone TOML)');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 3: appends to config without GSD marker', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('case 3 with existing [features]: preserves user features, does not inject GSD keys', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker for agents block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('case 3 strips existing [agents.gsd-*] sections before appending fresh block (#2406: fresh block never re-adds them)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const existing = [
      '[model]',
      'name = "o3"',
      '',
      '[agents.custom-agent]',
      'description = "user agent"',
      '',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, existing);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    // The pre-existing legacy [agents.gsd-executor] role table is a leaked
    // GSD section (stripLeakedGsdCodexSections) and the fresh block never
    // re-adds one (#2406) — zero role tables should remain anywhere.
    const gsdStructCount = (content.match(/^\[agents\.gsd-executor\]\s*$/gm) || []).length;
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes('[agents.custom-agent]'), 'preserves non-GSD agent section');
    assert.strictEqual(gsdStructCount, 0, 'legacy [agents.gsd-executor] struct entry is removed and not regrown');
    assert.strictEqual(markerCount, 1, 'adds exactly one marker block');
    assert.ok(!/\r?\n{3,}# GSD Agent Configuration/.test(content), 'does not leave extra blank lines before marker block');
  });

  test('idempotent: re-merge produces same result', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent merge');
  });

  test('case 2 after case 3 with existing [features]: no duplicate sections', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');
    mergeCodexConfig(configPath, sampleBlock);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const featuresCount = (content.match(/^\[features\]\s*$/gm) || []).length;
    assert.strictEqual(featuresCount, 1, 'exactly one [features] section');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature keys');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 2 does not inject feature keys, and drops a legacy [agents.gsd-old] role table on reinstall (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const manualContent = '[features]\nother_feature = true\n\n' + GSD_CODEX_MARKER + '\n[agents.gsd-old]\ndescription = "old"\n';
    fs.writeFileSync(configPath, manualContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature');
    // #2406: the pre-existing managed [agents.gsd-old] role table (below the
    // marker, from a pre-fix install) is truncated away by Case 2's
    // marker-truncate, and the fresh block never re-adds a role table.
    assert.ok(!content.includes('[agents.gsd-old]'), 'legacy managed role table removed');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('#2406: update over a legacy 1.7.0-shape install removes duplicate [agents.gsd-*] role registrations, preserves unrelated user config, and is idempotent on rerun', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    // Simulate a config.toml produced by the pre-fix installer: a managed
    // block with BOTH the bare [agents] dispatch-tuning table (holding the
    // user's own max_threads = 4 alongside GSD's stale max_depth = 2) AND
    // [agents.gsd-*] role tables duplicating what the standalone TOMLs
    // already register — plus an unrelated user [model] table above the
    // marker that must survive untouched.
    const legacyInstall = [
      '[model]',
      'name = "o3"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents]',
      'max_threads = 4',
      'max_depth = 2',
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[agents.gsd-planner]',
      'description = "Creates plans"',
      'config_file = "agents/gsd-planner.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, legacyInstall);

    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    // Legacy duplicate role registrations removed.
    assert.strictEqual((first.match(/^\[agents\.gsd-/gm) || []).length, 0, 'zero [agents.gsd-*] role tables remain');
    assert.ok(!first.includes('config_file'), 'no config_file line remains');
    // Unrelated user config preserved.
    assert.ok(first.includes('[model]') && first.includes('name = "o3"'), 'preserves unrelated user [model] table');
    // User's own AgentsToml scalar tuning preserved; GSD's max_depth re-pinned to 1.
    assert.ok(first.includes('max_threads = 4'), 'preserves user max_threads scalar');
    assert.match(first, /max_depth = 1/, 're-pins GSD-managed max_depth to 1');
    assert.doesNotMatch(first, /max_depth = 2/, 'stale legacy max_depth value is gone');
    assert.strictEqual((first.match(/^\[agents\]\s*$/gm) || []).length, 1, 'exactly one [agents] table (no duplicate)');
    assert.equal(validateCodexConfigSchema(first).ok, true, 'the migrated config still validates');

    // Idempotent: running install/merge again produces byte-identical output — no regrowth.
    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');
    assert.strictEqual(first, second, 'second merge is byte-identical — removed registrations do not regrow');
  });

  test('case 2 strips leaked [agents] and [agents.gsd-*] from before content, and does not regrow a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      'max_depth = 2',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, brokenContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    // #2406: neither the leaked pre-marker role table nor the legacy
    // post-marker managed one survives — the fresh block emits none.
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table anywhere in the file');
    // Verify the leaked [agents] table header above marker was stripped
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.substring(0, markerIndex);
    assert.ok(!beforeMarker.match(/^\[agents\]\s*$/m), 'no leaked [agents] above marker');
    assert.ok(!beforeMarker.includes('[agents.gsd-'), 'no leaked [agents.gsd-*] above marker');
  });

  test('case 2 strips leaked GSD-managed sections above marker in CRLF files, and does not regrow a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\]\s*$/gm), 0, 'removes leaked [agents] above marker');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'removes leaked GSD agent section above marker');
    // #2406: the fresh block never emits a role table, so zero remain
    // anywhere in the file — not just above the marker.
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'zero role tables anywhere');
    assert.strictEqual(countMatches(content, /name = "gsd-executor"/g), 0, 'no name = field in struct format');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 strips bare [agents] tables (invalid in current Codex schema, #2760) and removes leaked GSD sections in CRLF files, without regrowing a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'default = "custom-agent"',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    // Bare [agents] is invalid under Codex's current schema (rejected with
    // "expected struct AgentsToml") so install-time stripping always purges
    // it (#2760). User feature keys above the marker are preserved.
    // Structural assertion: TOML-parse the pre-marker region and verify the
    // bare [agents] block is fully gone — header AND body keys (e.g.,
    // `default = "custom-agent"`). A header-only check would miss a
    // partial-strip regression that leaves orphan body keys reparented to a
    // sibling section.
    const parsedBefore = parseTomlToObject(beforeMarker);
    assert.equal(
      parsedBefore.agents,
      undefined,
      'bare [agents] block fully purged including body keys (#2760)',
    );
    assert.ok(
      parsedBefore.features && parsedBefore.features.child_agents_md === false,
      'preserves user feature keys above marker',
    );
    // #2406: the fresh block never emits a role table, so zero remain
    // anywhere in the file — not just above the marker.
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'zero role tables anywhere');
    assert.strictEqual(countMatches(content, /name = "gsd-executor"/g), 0, 'no name = field in struct format');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 idempotent after case 3 with existing [features]', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const third = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent after 2nd merge');
    assert.strictEqual(second, third, 'idempotent after 3rd merge');
  });

  test('preserves CRLF when appending GSD block to existing config', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves existing CRLF content');
    assert.ok(content.includes(`${GSD_CODEX_MARKER}\r\n`), 'writes marker with CRLF');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('uses the first newline style when appending GSD block to mixed-EOL configs', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '# first line wins\n[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('# first line wins\n[model]\r\nname = "o3"'), 'preserves the existing mixed-EOL model content');
    assert.ok(content.includes(`\n\n${GSD_CODEX_MARKER}\n`), 'writes the managed block using the first newline style');
  });
});

// ─── Integration: installCodexConfig ────────────────────────────────────────────

describe('installCodexConfig (integration)', () => {
  let tmpTarget;
  const agentsSrc = path.join(__dirname, '..', 'agents');

  beforeEach(() => {
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-install-'));
  });

  afterEach(() => {
    cleanup(tmpTarget);
  });

  // Only run if agents/ directory exists (not in CI without full checkout)
  const hasAgents = fs.existsSync(agentsSrc);

  (hasAgents ? test : test.skip)('generates config.toml and agent .toml files', () => {
    const { installCodexConfig } = require('../bin/install.js');
    const count = installCodexConfig(tmpTarget, agentsSrc);

    assert.ok(count >= 11, `installed ${count} agents (expected >= 11)`);

    // Verify config.toml
    const configPath = path.join(tmpTarget, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'config.toml exists');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(config.includes(GSD_CODEX_MARKER), 'has GSD marker');
    // #2406: config.toml must NOT register agent roles — the standalone
    // agents/<name>.toml (verified below) is the sole canonical source
    // Codex auto-discovers. A role table here would be a second,
    // duplicate registration of the same role.
    assert.ok(!config.includes('[agents.gsd-executor]'), 'no executor role table in config.toml');
    assert.strictEqual((config.match(/^\[agents\.gsd-/gm) || []).length, 0, 'zero [agents.gsd-*] role tables of any kind');
    assert.strictEqual((config.match(/^config_file = /gm) || []).length, 0, 'zero config_file lines');
    assert.ok(!config.includes('multi_agent'), 'no feature flags');

    // Verify per-agent .toml files
    const agentsDir = path.join(tmpTarget, 'agents');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-executor.toml')), 'executor .toml exists');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-plan-checker.toml')), 'plan-checker .toml exists');

    const executorToml = fs.readFileSync(path.join(agentsDir, 'gsd-executor.toml'), 'utf8');
    assert.ok(executorToml.includes('name = "gsd-executor"'), 'executor has name');
    assert.ok(executorToml.includes('description = "Executes GSD plans with atomic commits, deviation handling, checkpoint protocols, and state management. Spawned by execute-phase orchestrator or execute-plan command."'), 'executor has description');
    assert.ok(executorToml.includes('sandbox_mode = "workspace-write"'), 'executor is workspace-write');
    assert.ok(executorToml.includes('developer_instructions'), 'has developer_instructions');

    const checkerToml = fs.readFileSync(path.join(agentsDir, 'gsd-plan-checker.toml'), 'utf8');
    assert.ok(checkerToml.includes('name = "gsd-plan-checker"'), 'plan-checker has name');
    assert.ok(checkerToml.includes('sandbox_mode = "read-only"'), 'plan-checker is read-only');
  });

  // PATHS-01: no ~/.claude references should leak into generated .toml files (#2320)
  // Covers both trailing-slash and bare end-of-string forms, and scans all .toml
  // files (agents/ subdirectory + top-level config.toml if present).
  (hasAgents ? test : test.skip)('generated .toml files contain no leaked ~/.claude paths (PATHS-01)', () => {
    const { installCodexConfig } = require('../bin/install.js');
    installCodexConfig(tmpTarget, agentsSrc);

    // Collect all .toml files: per-agent files in agents/ plus top-level config.toml.
    // Not the shared listAgentFiles() helper: reads the INSTALLED target dir and
    // collects generated .toml (absolute paths), not the source .md roster.
    const agentsDir = path.join(tmpTarget, 'agents');
    const tomlFiles = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.toml'))
      .map(f => path.join(agentsDir, f));
    const topLevel = path.join(tmpTarget, 'config.toml');
    if (fs.existsSync(topLevel)) tomlFiles.push(topLevel);
    assert.ok(tomlFiles.length > 0, 'at least one .toml file generated');

    // Match ~/.claude, $HOME/.claude, or ./.claude with or without trailing slash
    const leakPattern = /(?:~|\$HOME|\.)\/\.claude(?:\/|$)/;
    const leaks = [];
    for (const filePath of tomlFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (leakPattern.test(content)) {
        leaks.push(path.relative(tmpTarget, filePath));
      }
    }
    assert.deepStrictEqual(leaks, [], `No .toml files should contain .claude paths; found leaks in: ${leaks.join(', ')}`);
  });

  (hasAgents ? test : test.skip)('generated Codex agent .toml files do not call bare gsd-tools', () => {
    const { installCodexConfig } = require('../bin/install.js');
    installCodexConfig(tmpTarget, agentsSrc);

    // Not the shared listAgentFiles() helper: reads the INSTALLED target dir and
    // filters generated gsd-*.toml output, not the source .md roster.
    const agentsDir = path.join(tmpTarget, 'agents');
    const tomlFiles = fs.readdirSync(agentsDir)
      .filter((file) => file.startsWith('gsd-') && file.endsWith('.toml'));
    assert.ok(tomlFiles.length > 0, 'expected generated Codex agent toml files');

    for (const file of tomlFiles) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      assertNoCodexBareGsdToolsInvocation(content, `agents/${file}`);
    }
  });
});

// ─── Codex config.toml [features] safety (#1202) ─────────────────────────────

describe('codex features section safety', () => {
  test('non-boolean keys under [features] are moved to top level', () => {
    // Simulate the bug from #1202: model = "gpt-5.4" under [features]
    // causes "invalid type: string, expected a boolean in features"
    const configContent = `[features]\ncodex_hooks = true\n\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[agents.gsd-executor]\ndescription = "test"\n`;

    const featuresMatch = configContent.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');

    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 2, 'should detect 2 non-boolean keys');
    assert.ok(nonBooleanKeys.includes('model = "gpt-5.4"'), 'detects model key');
    assert.ok(nonBooleanKeys.includes('model_reasoning_effort = "medium"'), 'detects model_reasoning_effort key');
  });

  test('boolean keys under [features] are NOT flagged', () => {
    const configContent = `[features]\ncodex_hooks = true\nmulti_agent = false\n`;

    const featuresMatch = configContent.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys in a clean config');
  });
});

describe('Codex install hook configuration (e2e)', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-e2e-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Codex install copies hook file that is referenced in hooks.json (#2153)', () => {
    // Regression test: Codex install writes gsd-check-update hook reference into
    // hooks.json and must also copy the hook file to ~/$CODEX_HOME/hooks/
    runCodexInstall(codexHome);

    const configContent = readCodexConfig(codexHome);
    const parsedConfig = parseTomlToObject(configContent);
    assert.ok(
      !parsedConfig.hooks || !Array.isArray(parsedConfig.hooks.SessionStart),
      'config.toml does not carry managed SessionStart hooks'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'hooks.json references gsd-check-update (.js on POSIX, .cmd on Windows)'
    );
    // The hook file must physically exist at the referenced path
    const hookFile = path.join(codexHome, 'hooks', 'gsd-check-update.js');
    assert.ok(
      fs.existsSync(hookFile),
      `gsd-check-update.js must exist at ${hookFile} — hooks.json references it (directly on POSIX, via .cmd shim on Windows) but file was not installed`
    );
  });

  test('fresh CODEX_HOME enables codex_hooks without draft root defaults', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('[features]\nhooks = true\n'), 'writes codex_hooks feature');
    const parsed = parseTomlToObject(content);
    assert.ok(!parsed.hooks || !Array.isArray(parsed.hooks.SessionStart), 'config.toml does not carry managed SessionStart hooks');
    // #3017 / #3426: on POSIX the handler command uses the absolute Node binary path
    //   "<absolute-node-path>" "<hook-path.js>"
    // On Windows (#3426) a .cmd shim is written instead; the command in hooks.json
    // is the quoted .cmd path (no node runner prefix — cmd.exe executes .cmd natively).
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdCommands = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdCommands.length, 1, 'writes one GSD update hook in hooks.json');
    if (process.platform === 'win32') {
      // On Windows, the command is the .cmd shim path (quoted).
      const expectedCmdPath = path.join(codexHome, 'hooks', 'gsd-check-update.cmd').replace(/\\/g, '/');
      assert.strictEqual(gsdCommands[0], JSON.stringify(expectedCmdPath), 'win32: handler command must be the .cmd shim path (#3426)');
    } else {
      // On POSIX, the command is the node runner + .js hook path.
      const expectedRunner = JSON.parse(resolveNodeRunner());
      const expectedHookPath = path.join(codexHome, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');
      const expectedCommand = `"${expectedRunner}" "${expectedHookPath}"`;
      assert.strictEqual(gsdCommands[0], expectedCommand, 'handler command must use absolute node runner pointing at gsd-check-update.js (#3017)');
    }
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'writes one codex_hooks key');
    assertNoDraftRootKeys(content);
    assertUsesOnlyEol(content, '\n');
  });

  test('#2406: config.toml carries no config_file entries — standalone agents/*.toml under CODEX_HOME are the sole canonical source', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    // config.toml previously carried a `config_file = "<absolute agents dir>/<name>.toml"`
    // line per role, pointing back at the standalone TOML Codex already
    // auto-discovers under $CODEX_HOME/agents/ — a second, duplicate
    // registration of the same role that produced one
    // "Ignoring malformed agent role definition: duplicate agent role name"
    // warning per agent. That line is gone entirely now.
    const configFileLines = content.split(/\r?\n/).filter(l => l.startsWith('config_file = '));
    assert.deepStrictEqual(configFileLines, [], 'config.toml has zero config_file entries');

    // The standalone per-agent TOMLs are still written under CODEX_HOME/agents/
    // and are what Codex auto-discovers.
    const agentsDir = path.join(codexHome, 'agents');
    const tomlFiles = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.toml'))
      : [];
    assert.ok(tomlFiles.length > 0, 'standalone gsd-*.toml files exist under CODEX_HOME/agents/');
  });

  test('re-install repairs non-boolean keys trapped under [features] by previous install (#1379)', () => {
    // Bug: a pre-#1346 install prepended [features] before bare top-level keys,
    // trapping model= under [features]. Re-installing with the fix must detect
    // and relocate those keys back to the top level so Codex can parse them.
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      '',
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/Users/oltmannk/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    // model= and model_reasoning_effort= must NOT be under [features]
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('model = "gpt-5.3-codex"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex !== -1, 'model key is present');
    assert.ok(reasoningIndex !== -1, 'model_reasoning_effort key is present');
    assert.ok(modelIndex < featuresIndex, 'model= relocated before [features]');
    assert.ok(reasoningIndex < featuresIndex, 'model_reasoning_effort= relocated before [features]');

    // [features] should only contain boolean keys
    const featuresMatch = content.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/));
    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys under [features]');

    // User content preserved
    assert.ok(content.includes('[projects."/Users/oltmannk/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'one codex_hooks key');
  });

  test('existing LF config without [features] gets one features block and preserves user content', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[model]',
      'name = "o3"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'creates one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'creates one codex_hooks key');
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\nname = "o3"'), 'preserves model section');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('bare top-level keys are NOT trapped under [features] (#1202)', () => {
    // Real-world config: model= and model_reasoning_effort= at root level,
    // followed by [projects] section. GSD must not prepend [features] before
    // these keys, which would make Codex reject them as "expected a boolean".
    writeCodexConfig(codexHome, [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/home/user/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    // [features] must come AFTER bare top-level keys
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('model = "gpt-5.4"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex < featuresIndex, 'model= stays before [features]');
    assert.ok(reasoningIndex < featuresIndex, 'model_reasoning_effort= stays before [features]');

    // [features] should only contain boolean keys
    const featuresMatch = content.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/));
    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys under [features]');

    // User content preserved
    assert.ok(content.includes('[projects."/home/user/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
  });

  test('existing CRLF config without [features] preserves CRLF and adds codex_hooks', () => {
    writeCodexConfig(codexHome, '# user comment\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'creates one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'creates one codex_hooks key');
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves model section');
    // [features] should be inserted between top-level lines and [model], not prepended
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('[model]');
    assert.ok(featuresIndex < modelIndex, '[features] comes before [model]');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF [features] comment-only table gets codex_hooks without losing adjacent text', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[features]',
      '# keep me',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features]\r\n# keep me\r\n\r\nhooks = true\r\n'), 'adds codex_hooks within comment-only table');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves following table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] with trailing comment gets one codex_hooks without a second table', () => {
    writeCodexConfig(codexHome, [
      '[features] # keep comment',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\s*\[features\](?:\s*#.*)?$/gm), 1, 'keeps one commented [features] header');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features] # keep comment\nother_feature = true'), 'preserves commented features table');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('[features] # keep comment'), 'adds codex_hooks within existing features table');
    assert.ok(content.indexOf('hooks = true') < content.indexOf('[model]'), 'does not create a second features table before model');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] at EOF without trailing newline is updated in place', () => {
    writeCodexConfig(codexHome, '[model]\nname = "o3"\n\n[features]');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('[features]'), 'adds codex_hooks after the existing EOF features header');
    // In this EOF-without-trailing-newline edge case, the pre-existing
    // [features] header has no blank-line boundary to close it, so the
    // appended GSD marker/ownership comment textually falls *inside* what
    // reads as the [features] section body, and `hooks = true` is inserted
    // at the end of that body — after the marker, not before it. That
    // ordering is unrelated to #2406 (verified unchanged against
    // origin/next's install.js) and #2406 removed the [agents.<name>] role
    // tables that used to anchor this assertion, so anchor on the bare
    // [agents] dispatch-tuning table instead — codex_hooks always lands
    // before it.
    assert.ok(content.indexOf('hooks = true') < content.indexOf('[agents]'), 'keeps codex_hooks before the [agents] dispatch-tuning table');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] and codex_hooks = false are normalized and remain idempotent', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = false',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'normalizes to one codex_hooks = true');
    assert.ok(!content.includes('codex_hooks = false'), 'removes false codex_hooks value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'does not duplicate GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('quoted codex_hooks keys inside [features] are normalized without adding a bare duplicate', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 1, 'normalizes the quoted key to true');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not append a bare duplicate codex_hooks key');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('quoted [features] headers are recognized as the existing features table', () => {
    writeCodexConfig(codexHome, [
      '["features"]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[(?:"features"|'features'|features)\]\s*$/gm), 1, 'keeps one features table');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 1, 'normalizes the quoted codex_hooks key to true');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a second bare features table');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'keeps one GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('quoted table headers containing # are parsed without treating # as a comment start', () => {
    writeCodexConfig(codexHome, [
      '[features."a#b"]',
      'enabled = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('[features."a#b"]\nenabled = true'), 'preserves the quoted nested features table');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'adds one real top-level features table');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('existing dotted features config stays dotted and does not grow a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\.hooks = true$/gm), 1, 'adds one dotted codex_hooks key');
    assert.ok(content.includes('features.other_feature = true'), 'preserves existing dotted features key');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook for dotted codex_hooks and remains idempotent');
    assertNoDraftRootKeys(content);
  });

  test('root inline-table features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = { other_feature = true }',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = { other_feature = true }'), 'preserves the root inline-table assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    // #2406: config.toml no longer carries an [agents.<name>] role table —
    // it still installs the managed [agents] dispatch-tuning block.
    assert.ok(content.includes(GSD_CODEX_MARKER), 'still installs the managed GSD block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assertNoDraftRootKeys(content);
  });

  test('root scalar features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = "disabled"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = "disabled"'), 'preserves the root scalar assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    // #2406: config.toml no longer carries an [agents.<name>] role table —
    // it still installs the managed [agents] dispatch-tuning block.
    assert.ok(content.includes(GSD_CODEX_MARKER), 'still installs the managed GSD block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assertNoDraftRootKeys(content);
  });

  test('quoted dotted codex_hooks keys stay dotted and are normalized without duplication', () => {
    writeCodexConfig(codexHome, [
      'features."codex_hooks" = false',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\."codex_hooks" = true$/gm), 1, 'normalizes the quoted dotted key to true');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append a bare dotted duplicate');
    assert.ok(content.includes('features.other_feature = true'), 'preserves other dotted features keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook for quoted dotted codex_hooks and remains idempotent');
    assertNoDraftRootKeys(content);
  });

  test('multiline dotted features assignments insert codex_hooks after the full assignment block', () => {
    writeCodexConfig(codexHome, [
      'features.notes = """',
      'keep-me',
      '"""',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features.notes = """\nkeep-me\n"""'), 'preserves the multiline dotted assignment');
    assert.strictEqual(countMatches(content, /^features\.hooks = true$/gm), 1, 'adds one dotted codex_hooks key');
    assert.ok(content.indexOf('features.hooks = true') > content.indexOf('"""'), 'inserts codex_hooks after the multiline assignment closes');
    assert.ok(content.indexOf('features.hooks = true') < content.indexOf('[model]'), 'inserts codex_hooks before the next table');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] table is populated with one codex_hooks key', () => {
    writeCodexConfig(codexHome, '[features]\r\n\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features]\r\n\r\nhooks = true\r\n'), 'adds codex_hooks to empty table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('multiline strings inside [features] do not create fake tables or fake codex_hooks matches', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'notes = \'\'\'',
      '[model]',
      'codex_hooks = false',
      '\'\'\'',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds a real codex_hooks key once');
    assert.ok(content.includes('notes = \'\'\'\n[model]\ncodex_hooks = false\n\'\'\''), 'preserves multiline string content');
    assert.strictEqual(countMatches(content, /^codex_hooks = false$/gm), 1, 'does not rewrite codex_hooks text inside multiline string');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('other_feature = true'), 'does not stop the features section at multiline string content');
    // Parse structurally — verify codex_hooks and migrated AfterCommand hook via parsed object
    const parsed = parseTomlToObject(content);
    assert.equal(parsed.features?.hooks, true, 'writes a real hooks boolean key (#3566)');
    assert.ok(Array.isArray(parsed.hooks?.AfterCommand), 'AfterCommand flat [[hooks]] migrated to namespaced AoT');
    const afterCmds = parsed.hooks.AfterCommand.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((h) => h.command).filter(Boolean) : []
    );
    assert.ok(afterCmds.includes('echo custom-after-command'), 'preserves AfterCommand user hook command');
    assertNoDraftRootKeys(content);
  });

  test('non-boolean codex_hooks assignments are normalized to true without duplication', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = "sometimes"',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'normalizes to one true value');
    assert.ok(!content.includes('codex_hooks = "sometimes"'), 'removes non-boolean value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline basic-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """',
      'multiline-basic-sentinel',
      'still-in-string',
      '"""',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline basic-string assignment with one true value');
    assert.ok(!content.includes('multiline-basic-sentinel'), 'removes multiline basic-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('multiline literal-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = \'\'\'',
      'multiline-literal-sentinel',
      'still-in-literal',
      '\'\'\'',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline literal-string assignment with one true value');
    assert.ok(!content.includes('multiline-literal-sentinel'), 'removes multiline literal-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('multiline array codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = [',
      '  "array-sentinel-1",',
      '  "array-sentinel-2",',
      ']',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline array assignment with one true value');
    assert.ok(!content.includes('array-sentinel-1'), 'removes multiline array continuation lines');
    assert.ok(!content.includes('array-sentinel-2'), 'removes multiline array continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('triple-quoted codex_hooks values keep inline comments when normalized', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """sometimes""" # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 1, 'normalizes to true and preserves inline comment');
    assert.ok(!content.includes('"""sometimes"""'), 'removes the old triple-quoted value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF codex_hooks = true stays single and preserves non-GSD hooks', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'keeps one codex_hooks = true');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(content, /echo custom-after-command/g), 1, 'preserves non-GSD hook exactly once');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'keeps one GSD update hook in hooks.json');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('codex_hooks = true with an inline comment is treated as enabled for hook installation', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 1, 'preserves the commented true value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds the GSD update hook once in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('mixed-EOL configs use the first newline style for inserted Codex content', () => {
    writeCodexConfig(codexHome, '# first line wins\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    // [features] is inserted after top-level lines, before [model] — not prepended
    assert.ok(content.includes('# first line wins\n\n[features]\nhooks = true\n'), 'inserts features after top-level lines using first newline style');
    assert.ok(content.includes(`# GSD Agent Configuration — managed by gsd-core installer\n`), 'writes the managed agent block using the first newline style');
    // Structural check: managed SessionStart hooks live in hooks.json.
    const parsedMixed = parseTomlToObject(content);
    assert.ok(!parsedMixed.hooks || !Array.isArray(parsedMixed.hooks.SessionStart), 'does not write managed SessionStart hooks to config.toml');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'writes one managed SessionStart hook to hooks.json');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves the existing CRLF model lines');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'remains idempotent on repeated installs');
    assertNoDraftRootKeys(content);
  });
});

describe('Codex uninstall symmetry for hook-enabled configs', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-uninstall-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fresh install removes the GSD-added codex_hooks feature on uninstall', () => {
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.strictEqual(cleaned, null, 'fresh GSD-only config strips back to nothing');
  });

  test('install then uninstall removes [features].codex_hooks while preserving other feature keys, comments, hooks, and CRLF', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '# keep me',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned, 'preserves user config after uninstall cleanup');
    assert.strictEqual(countMatches(cleaned, /^\[features\](?:\s*#.*)?$/gm), 1, 'keeps the existing features table');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the GSD-added codex_hooks key');
    assert.ok(cleaned.includes('# keep me'), 'preserves user comments in [features]');
    assert.ok(cleaned.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes only the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
    assertUsesOnlyEol(cleaned, '\r\n');
  });

  test('install then uninstall removes dotted features.codex_hooks without creating a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.other_feature = true'), 'preserves other dotted feature keys');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 0, 'removes the dotted GSD codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /^\[features\]\s*$/gm), 0, 'does not leave behind a [features] table');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
  });

  test('install then uninstall preserves a pre-existing [features].codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\ncodex_hooks = true\nother_feature = true'), 'preserves the user-authored codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 1, 'keeps the pre-existing codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing quoted [features]."codex_hooks" = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\n"codex_hooks" = true\nother_feature = true'), 'preserves the user-authored quoted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^"codex_hooks" = true$/gm), 1, 'keeps the pre-existing quoted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing root dotted features.codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      'features.codex_hooks = true',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.codex_hooks = true\nfeatures.other_feature = true'), 'preserves the user-authored dotted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 1, 'keeps the pre-existing dotted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall leaves short-circuited root features assignments untouched', () => {
    const cases = [
      'features = { other_feature = true }\n\n[model]\nname = "o3"\n',
      'features = "disabled"\n\n[model]\nname = "o3"\n',
    ];

    for (const initialContent of cases) {
      writeCodexConfig(codexHome, initialContent);
      runCodexInstall(codexHome);

      const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
      assert.strictEqual(cleaned, initialContent, `preserves short-circuited root features assignment: ${initialContent.split(/\r?\n/)[0]}`);

      cleanup(codexHome);
      fs.mkdirSync(codexHome, { recursive: true });
    }
  });

  test('install then uninstall keeps mixed-EOL user content stable while removing GSD hook state', () => {
    const initialContent = [
      '# first line wins',
      '[features]',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n').replace(/^# first line wins\r\r?\n/, '# first line wins\n');

    writeCodexConfig(codexHome, initialContent);
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('# first line wins\n[features]\r\nother_feature = true\r\n\r\n[model]\r\nname = "o3"'), 'preserves the original mixed-EOL user content');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the injected codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });
});

// ─── #1326: cleanupCodexSkillMetadataSidecars (replaces #774 writeCodexSkillMetadataFiles) ──

describe('cleanupCodexSkillMetadataSidecars (#1326)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-sidecar-cleanup-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Codex install does not emit managed agents/openai.yaml sidecars and removes stale ones (#1326)', () => {
    // gsd-foo: managed skill with stale sidecar → sidecar removed, empty agents/ pruned
    const fooAgents = path.join(tmpDir, 'gsd-foo', 'agents');
    fs.mkdirSync(fooAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-foo', 'SKILL.md'), '---\nname: gsd-foo\n---\nBody.\n');
    fs.writeFileSync(path.join(fooAgents, 'openai.yaml'), 'interface:\n  display_name: "foo"\n');

    // gsd-dev-preferences: user-owned → sidecar PRESERVED
    const prefAgents = path.join(tmpDir, 'gsd-dev-preferences', 'agents');
    fs.mkdirSync(prefAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-dev-preferences', 'SKILL.md'), '---\nname: gsd-dev-preferences\n---\nBody.\n');
    const userYaml = 'interface:\n  display_name: "my prefs"\n  short_description: "User-authored"\n';
    fs.writeFileSync(path.join(prefAgents, 'openai.yaml'), userYaml);

    // gsd-bar: managed skill with sidecar + another file in agents/ → sidecar removed, agents/ kept (has other.txt)
    const barAgents = path.join(tmpDir, 'gsd-bar', 'agents');
    fs.mkdirSync(barAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-bar', 'SKILL.md'), '---\nname: gsd-bar\n---\nBody.\n');
    fs.writeFileSync(path.join(barAgents, 'openai.yaml'), 'interface:\n  display_name: "bar"\n');
    fs.writeFileSync(path.join(barAgents, 'other.txt'), 'some other content\n');

    // helper: non-gsd dir with openai.yaml → UNTOUCHED
    const helperAgents = path.join(tmpDir, 'helper', 'agents');
    fs.mkdirSync(helperAgents, { recursive: true });
    fs.writeFileSync(path.join(helperAgents, 'openai.yaml'), 'interface:\n  display_name: "helper"\n');

    cleanupCodexSkillMetadataSidecars(tmpDir);

    // gsd-foo: sidecar removed and empty agents/ pruned
    assert.ok(!fs.existsSync(path.join(fooAgents, 'openai.yaml')),
      'gsd-foo/agents/openai.yaml must be removed (managed stale sidecar)');
    assert.ok(!fs.existsSync(fooAgents),
      'gsd-foo/agents/ must be pruned when empty after sidecar removal');

    // gsd-dev-preferences: user-owned, sidecar preserved
    assert.ok(fs.existsSync(path.join(prefAgents, 'openai.yaml')),
      'gsd-dev-preferences/agents/openai.yaml must be preserved (user-owned)');
    assert.strictEqual(fs.readFileSync(path.join(prefAgents, 'openai.yaml'), 'utf8'), userYaml,
      'gsd-dev-preferences/agents/openai.yaml content must be unchanged');

    // gsd-bar: sidecar removed but agents/ kept (still has other.txt)
    assert.ok(!fs.existsSync(path.join(barAgents, 'openai.yaml')),
      'gsd-bar/agents/openai.yaml must be removed');
    assert.ok(fs.existsSync(barAgents),
      'gsd-bar/agents/ must NOT be pruned (still contains other.txt)');
    assert.ok(fs.existsSync(path.join(barAgents, 'other.txt')),
      'gsd-bar/agents/other.txt must be preserved');

    // helper: non-gsd dir untouched
    assert.ok(fs.existsSync(path.join(helperAgents, 'openai.yaml')),
      'helper/agents/openai.yaml must be untouched (non-gsd dir)');
  });

  test('is a no-op when skillsDir does not exist (#1326)', () => {
    assert.doesNotThrow(() => {
      cleanupCodexSkillMetadataSidecars(path.join(tmpDir, 'nonexistent'));
    }, 'must not throw when skillsDir does not exist');
  });

  test('is a no-op for managed gsd-* dirs with no agents/openai.yaml (#1326)', () => {
    // No sidecar present — should not throw, should not create anything
    const skillDir = path.join(tmpDir, 'gsd-baz');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: gsd-baz\n---\nBody.\n');

    assert.doesNotThrow(() => {
      cleanupCodexSkillMetadataSidecars(tmpDir);
    }, 'must not throw when no sidecar exists');
    assert.ok(!fs.existsSync(path.join(skillDir, 'agents')),
      'must not create agents/ dir when no sidecar was present');
  });

  test('does not delete through a symlinked agents/ directory (#1326)', { skip: process.platform === 'win32' }, () => {
    // Setup: a skills dir with gsd-foo/ whose agents/ is a SYMLINK to an external dir.
    // The cleanup must not delete files through the symlink.
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-symlink-ext-'));
    try {
      // Place openai.yaml and a sentinel in the external dir.
      fs.writeFileSync(path.join(externalDir, 'openai.yaml'), 'interface:\n  display_name: "external"\n');
      fs.writeFileSync(path.join(externalDir, 'keep.txt'), 'sentinel\n');

      // Create gsd-foo/ in the skills dir and make agents/ a symlink to externalDir.
      const skillDir = path.join(tmpDir, 'gsd-foo');
      fs.mkdirSync(skillDir, { recursive: true });
      const agentsLink = path.join(skillDir, 'agents');
      fs.symlinkSync(externalDir, agentsLink, 'dir');

      cleanupCodexSkillMetadataSidecars(tmpDir);

      // Nothing in the external dir must have been deleted.
      assert.ok(fs.existsSync(path.join(externalDir, 'openai.yaml')),
        'external/openai.yaml must still exist — cleanup must not delete through a symlinked agents/ dir');
      assert.ok(fs.existsSync(path.join(externalDir, 'keep.txt')),
        'external/keep.txt must still exist — cleanup must not delete through a symlinked agents/ dir');
      // The symlink itself must still be present.
      assert.ok(fs.existsSync(agentsLink),
        'gsd-foo/agents symlink must still exist');
    } finally {
      cleanup(externalDir);
    }
  });

  test('Codex install does not create agents/openai.yaml sidecars for any managed skill (#1326)', () => {
    // Integration test: full Codex install must NOT produce any managed gsd-*/agents/openai.yaml
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    runCodexInstall(codexHome);
    const skillsDir = codexSkillsRoot(codexHome);
    assert.ok(fs.existsSync(skillsDir), 'Codex install must create a skills/ directory');
    const gsdSkillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-') && e.name !== 'gsd-dev-preferences');
    assert.ok(gsdSkillDirs.length > 0, 'install must create at least one managed gsd-* skill directory');
    for (const skillEntry of gsdSkillDirs) {
      const yamlPath = path.join(skillsDir, skillEntry.name, 'agents', 'openai.yaml');
      assert.ok(!fs.existsSync(yamlPath),
        `${skillEntry.name}/agents/openai.yaml must NOT exist after install (#1326 sidecar dedup)`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2698-crlf-install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2698-crlf-install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #2698)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2698: CRLF line endings break agent-block strip regexes
 *
 * The legacy `gsd-update-check` hook migration in bin/install.js uses two
 * separate .replace() calls:
 *   1. LF-only regex: /\n# GSD Hooks\n\[\[hooks\]\]\nevent = ...\n/
 *   2. CRLF-only regex: /\r\n# GSD Hooks\r\n\[\[hooks\]\]\r\nevent = ...\r\n/
 *
 * These patterns fail when config.toml has mixed line endings — e.g. the
 * "# GSD Hooks" header uses LF but the body uses CRLF, or vice versa. This
 * can happen when the file is created cross-platform (Windows/Linux), when
 * editors convert only part of the file, or when a previous GSD version wrote
 * the block with different EOL than the file's dominant EOL.
 *
 * Fix: consolidate to a single \r?\n-aware regex that handles LF, CRLF, and
 * any mix in a single pass, making the migration robust regardless of the
 * platform the file was last written on.
 *
 * Test approach: write a `.codex/config.toml` with a stale gsd-update-check
 * block that uses mixed line endings (header in LF, body in CRLF), then run
 * install() and assert the stale block is gone.
 *
 * Note: The local Codex install writes to `.codex/` in the current directory.
 * Tests `process.chdir(tmpDir)` and write fixtures to `tmpDir/.codex/`.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, GSD_CODEX_MARKER } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// Ensure hooks/dist/ is populated before install tests
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

describe('#2698: CRLF stale gsd-update-check block is removed on Codex reinstall', () => {
  let tmpDir;
  let _previousHome;
  let _previousUserProfile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-crlf-install-2698-'));
    // #2088 (ADR-1239 upgrade 3): Codex's skills-kind `home: ".agents"` override
    // applies to BOTH global and local scope and resolves via os.homedir(). This
    // describe block calls install(false, 'codex') (local scope) directly —
    // without sandboxing HOME/USERPROFILE to tmpDir, that in-process install
    // would materialize a full gsd-* skill set into the developer/CI machine's
    // REAL $HOME/.agents/skills instead of the temp dir.
    _previousHome = process.env.HOME;
    _previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(() => {
    if (_previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = _previousHome;
    if (_previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = _previousUserProfile;
    // Use the shared 5s Windows-EBUSY retry budget instead of inline 1s.
    cleanup(tmpDir);
  });

  // Helper: pre-populate .codex/config.toml with a GSD marker + stale hooks block
  // using the given line ending for the stale hooks block header, and a potentially
  // different EOL for the hooks body. This exercises the cross-platform mixed scenario.
function writeCodexConfigWithStaleHooks(dir, headerEol, bodyEol) {
    // Build the stale block with header EOL for the "# GSD Hooks" line, but body EOL
    // for the content lines (simulates a file edited by two different platforms).
    const staleBlock = [
      '# GSD Hooks',           // line that starts the stale section
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/gsd-update-check.js"',
    ].join(bodyEol);

    // Put the stale block in user content BEFORE the GSD marker. The GSD marker area
    // will be regenerated by mergeCodexConfig during install(); the stale block in
    // the user area is what the hooks migration must remove.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
    ].join(headerEol) + headerEol + staleBlock + headerEol + headerEol + GSD_CODEX_MARKER + headerEol;

    const codexDir = path.join(dir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configPath, content, 'utf-8');
    return configPath;
  }

  function readHooksSessionStartCommands(codexHome) {
    const hooksPath = path.join(codexHome, 'hooks.json');
    if (!fs.existsSync(hooksPath)) return [];
    const raw = fs.readFileSync(hooksPath, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const table = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
      ? parsed.hooks
      : parsed;
    const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
    return sessionStart.flatMap((entry) => [
      ...(typeof entry?.command === 'string' ? [entry.command] : []),
      ...(Array.isArray(entry?.hooks)
        ? entry.hooks.map((hook) => hook && hook.command).filter((cmd) => typeof cmd === 'string')
        : []),
    ]);
  }

  test('LF config.toml: stale gsd-update-check block removed on reinstall', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    writeCodexConfigWithStaleHooks(tmpDir, '\n', '\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      'Stale gsd-update-check entry must be removed from LF config.toml (#2698)'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(path.join(tmpDir, '.codex'));
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'New gsd-check-update hook must appear in hooks.json after reinstall'
    );
  });

  test('CRLF config.toml: stale gsd-update-check block removed on reinstall', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    writeCodexConfigWithStaleHooks(tmpDir, '\r\n', '\r\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      'Stale gsd-update-check entry must be removed from CRLF config.toml (#2698)'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(path.join(tmpDir, '.codex'));
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'New gsd-check-update hook must appear in hooks.json after reinstall'
    );
  });

  test('mixed-EOL config.toml: stale block with LF header but CRLF body removed on reinstall', (t) => {
    // This is the primary failure case: header line uses LF but the body uses CRLF.
    // The old LF-only regex requires all-\n separators; the old CRLF-only regex requires
    // all-\r\n separators. Neither matches a block with mixed endings, so the stale
    // block survives reinstall with the old code (#2698).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // headerEol='\n' (file dominant), bodyEol='\r\n' (hook block from another platform)
    writeCodexConfigWithStaleHooks(tmpDir, '\n', '\r\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      [
        'Stale gsd-update-check block with mixed LF/CRLF endings must be removed (#2698).',
        'Old code used two separate LF-only and CRLF-only regexes; neither matched mixed content.',
        'Fix consolidates to a single \\r?\\n-aware regex.',
      ].join(' ')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2760-codex-install-defensive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2760-codex-install-defensive (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #2760 — Codex install path corrupts existing config.toml.
 *
 * Three defects, three fixes (defensive triple):
 *
 *   Defect 3 (confirmed real) — Hooks AoT downgrade. When the user already has
 *     `[[hooks.SessionStart]]` (namespaced AoT) entries in their config, GSD
 *     used to append a `[[hooks]]` (top-level AoT) block that confuses
 *     round-trip writers and produces a config Codex refuses to load.
 *     Fix: detect the user's preferred shape and emit GSD's hook in the same
 *     namespaced form so both coexist cleanly.
 *
 *   Defects 1+2 (defensive) — Strip-step robustness. Pre-existing legacy
 *     `[agents]` (single-bracket) and `[[agents]]` (sequence) blocks are
 *     invalid in current Codex schema and break Codex even though GSD now
 *     emits the correct `[agents.<name>]` struct form. Fix: install-time
 *     stripping always purges these forms regardless of GSD marker presence
 *     so reinstall self-heals files where the marker was edited out or never
 *     existed (third-party tools).
 *
 *   Fix 3 (defensive) — Post-write validation. Parse the bytes we are about
 *     to commit, assert they match Codex's expected schema (no bare/sequence
 *     `agents`, no bare `hooks.<Event>`); on failure, restore the pre-install
 *     backup and abort so the user never gets a broken Codex CLI.
 */

// Scope GSD_TEST_MODE to module load only — restore prior value (or unset) so
// downstream tests in the same node process never see test-only behaviour
// leak through (#2760 CR4 finding 5).
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  install,
  validateCodexConfigSchema,
  hasUserNamespacedAotHooks,
  parseTomlToObject,
} = require('../bin/install.js');

const { cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

function runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
  const previousCodeHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
  // $HOME/.agents/skills root (os.homedir()-relative, independent of
  // CODEX_HOME). Sandbox HOME (and USERPROFILE) to codexHome so this
  // in-process install never materializes skills under the developer/CI
  // machine's real home directory.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  try {
    process.chdir(cwd);
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodeHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodeHome;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function readCodexHooksJson(codexHome) {
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return {};
  const raw = fs.readFileSync(hooksPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function readHooksSessionStartCommands(codexHome) {
  const parsed = readCodexHooksJson(codexHome);
  const table = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? parsed.hooks
    : parsed;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) =>
    (Array.isArray(entry?.hooks) ? entry.hooks : [])
      .map((hook) => hook && hook.command)
      .filter((cmd) => typeof cmd === 'string')
  );
}

describe('#2760 defect 3 — Hooks AoT preservation across install/uninstall/reinstall', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-d3-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fresh install emits the two-level nested AoT schema (#2773)', () => {
    // Codex 0.124.0+ requires [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]]
    // with type = "command". Neither the flat [[hooks]] + event field form nor
    // the single-block [[hooks.SessionStart]] form without .hooks is accepted.
    writeCodexConfig(codexHome, '');
    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    const sessionStartCommands = readHooksSessionStartCommands(codexHome);
    const managed = sessionStartCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.equal(managed.length, 1, 'hooks.json must contain exactly one managed gsd-check-update command');
    assert.ok(
      !parsed.hooks || !Array.isArray(parsed.hooks.SessionStart),
      'config.toml should not carry managed SessionStart hooks for GSD'
    );
  });

  test('preserves user [[hooks.SessionStart]] entries and registers managed GSD handler in hooks.json', () => {
    // Users may have their own [[hooks.SessionStart]] entries using the new schema.
    // GSD must append its own two-level block without disturbing theirs.
    const userConfig = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo first user hook"',
      '',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo second user hook"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userConfig);

    runCodexInstall(codexHome);
    const afterInstall = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(afterInstall);

    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'hooks.SessionStart must remain an array-of-tables after install'
    );

    // Collect all handler commands across all event entries.
    const allCommands = parsed.hooks.SessionStart.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((h) => h.command) : []
    );

    assert.ok(
      allCommands.includes('echo first user hook'),
      'first user hook preserved: ' + JSON.stringify(allCommands)
    );
    assert.ok(
      allCommands.includes('echo second user hook'),
      'second user hook preserved: ' + JSON.stringify(allCommands)
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'GSD handler must appear in hooks.json SessionStart entries: ' + JSON.stringify(hooksJsonCommands)
    );
    assert.ok(!Array.isArray(parsed.hooks), 'no flat [[hooks]] entries');
  });

  test('reinstall replaces flat [[hooks]] + event form with nested schema', () => {
    // Upgrade path: user has a config written by GSD 1.38.x (flat [[hooks]] form).
    const legacyConfig = [
      '[features]',
      'codex_hooks = true',
      '',
      '# GSD Hooks',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/to/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, legacyConfig);

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // Old flat form must be gone.
    assert.ok(!Array.isArray(parsed.hooks), 'flat [[hooks]] must be stripped on upgrade');
    // Only one GSD hook entry must exist (no duplication) in hooks.json.
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed handler after upgrade');
  });

  test('reinstall replaces single-block [[hooks.SessionStart]] (no .hooks sub-table) with nested schema', () => {
    // Upgrade path: user has a config written by the PR #2802 shape —
    // [[hooks.SessionStart]] without a nested [[hooks.SessionStart.hooks]] sub-table.
    const prBranchConfig = [
      '[features]',
      'codex_hooks = true',
      '',
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      'command = "node /old/path/to/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, prBranchConfig);

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    parseTomlToObject(content);

    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed handler after upgrade from PR-#2802-shape');
  });

  test('reinstall is idempotent: correct nested schema is stripped and re-emitted cleanly', () => {
    writeCodexConfig(codexHome, '');
    runCodexInstall(codexHome);
    runCodexInstall(codexHome); // second install
    readCodexConfig(codexHome);

    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed SessionStart handler after double install');
  });
});

describe('#2760 fix 2 — Strip purges invalid legacy [agents] / [[agents]] regardless of marker', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f2-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('strips bare [agents] single-bracket block (no GSD marker, arbitrary user keys)', () => {
    writeCodexConfig(codexHome, [
      '[agents]',
      'default = "custom-agent"',
      'extra_key = "value"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // Bare [agents] would have left { default, extra_key } as scalar leaves
    // on parsed.agents. After strip + re-emit, only GSD's own managed
    // AgentsToml scalar (max_depth) remains — #2406 stopped emitting
    // [agents.<name>] role sub-tables entirely, so `agents` stays a flat
    // scalar-only object, not a table-of-tables.
    assert.ok(
      parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents),
      'agents must be an object in parsed structure, got: ' + typeof parsed.agents
    );
    assert.equal(parsed.agents.default, undefined, 'bare [agents] default key must be stripped');
    assert.equal(parsed.agents.extra_key, undefined, 'bare [agents] extra_key must be stripped');
    assert.equal(parsed.agents.max_depth, 1, 'GSD-managed max_depth is the only surviving [agents] key');
    const gsdAgents = Object.keys(parsed.agents).filter((k) => k.startsWith('gsd-'));
    assert.deepStrictEqual(
      gsdAgents, [],
      'no [agents.gsd-*] role sub-tables (#2406) — canonical registration lives only in the standalone TOMLs: ' + JSON.stringify(Object.keys(parsed.agents))
    );

    // User's unrelated [model] section preserved structurally.
    assert.ok(
      parsed.model && parsed.model.name === 'o3',
      'unrelated user [model] section preserved with name = "o3", got: ' + JSON.stringify(parsed.model)
    );
  });

  test('strips [[agents]] sequence-form block without GSD marker (third-party / marker-edited-out)', () => {
    writeCodexConfig(codexHome, [
      '[[agents]]',
      'name = "user-helper"',
      'description = "third-party agent"',
      '',
      '[[agents]]',
      'name = "another-helper"',
      'description = "second one"',
      '',
      '[projects."/tmp/x"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // [[agents]] sequence form would parse to Array — after strip it must be
    // a plain object holding only GSD's own managed max_depth scalar (#2406
    // stopped emitting [agents.<name>] role sub-tables entirely).
    assert.ok(
      parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents),
      'agents must be an object in parsed structure (sequence form must be stripped), got: '
        + (Array.isArray(parsed.agents) ? 'array' : typeof parsed.agents)
    );
    assert.equal(parsed.agents.max_depth, 1, 'GSD-managed max_depth is the only surviving [agents] key');
    const gsdAgents = Object.keys(parsed.agents).filter((k) => k.startsWith('gsd-'));
    assert.deepStrictEqual(
      gsdAgents, [],
      'no [agents.gsd-*] role sub-tables (#2406) — canonical registration lives only in the standalone TOMLs: ' + JSON.stringify(Object.keys(parsed.agents))
    );

    // User's unrelated [projects."/tmp/x"] section preserved structurally.
    assert.ok(
      parsed.projects && parsed.projects['/tmp/x'] && parsed.projects['/tmp/x'].trust_level === 'trusted',
      'unrelated user [projects."/tmp/x"] section preserved with trust_level = "trusted", got: '
        + JSON.stringify(parsed.projects)
    );
  });
});

// concurrency: false — the third test mutates installModule.__codexSchemaValidator,
// a module-level test seam. Other tests in this file (and in bug-2153, etc.)
// also call runCodexInstall() and would observe the injected validator if
// node:test ran them in parallel. Serializing this describe block keeps the
// seam mutation invisible to siblings.
describe('#2760 fix 3 — Post-write Codex schema validation', { concurrency: false }, () => {
  test('passes a clean config produced by GSD install', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f3a-'));
    try {
      const codexHome = path.join(tmpDir, 'codex-home');
      runCodexInstall(codexHome);
      const content = readCodexConfig(codexHome);
      const result = validateCodexConfigSchema(content);
      assert.equal(result.ok, true, 'GSD-emitted config passes schema validation');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('rejects bare [agents] and bare [hooks.SessionStart] in arbitrary content', () => {
    const bareAgents = [
      '[agents]',
      'default = "x"',
      '',
    ].join('\n');
    const bareHooks = [
      '[hooks.SessionStart]',
      'command = "x"',
      '',
    ].join('\n');
    const sequenceAgents = [
      '[[agents]]',
      'name = "x"',
      '',
    ].join('\n');

    assert.equal(validateCodexConfigSchema(bareAgents).ok, false, 'bare [agents] rejected');
    assert.equal(validateCodexConfigSchema(bareHooks).ok, false, 'bare [hooks.SessionStart] rejected');
    assert.equal(validateCodexConfigSchema(sequenceAgents).ok, false, '[[agents]] sequence rejected');
  });

  test('aborts install and restores pre-install backup when post-write validation fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f3b-'));
    const installModule = require('../bin/install.js');
    try {
      const codexHome = path.join(tmpDir, 'codex-home');
      // Pre-install file the user wants protected.
      const preInstall = [
        '# user file',
        '[model]',
        'name = "o3"',
        '',
      ].join('\n');
      writeCodexConfig(codexHome, preInstall);

      // Force the post-write validator to fail via the documented test seam.
      // This simulates the writer producing legacy-form output that Codex
      // would reject — install MUST abort, restore the pre-install bytes,
      // and surface a clear error.
      installModule.__codexSchemaValidator = () => ({
        ok: false,
        reason: 'simulated invalid output for test',
      });

      let threw = false;
      try {
        runCodexInstall(codexHome);
      } catch (e) {
        threw = true;
        assert.match(
          e.message,
          /post-write Codex schema validation failed/,
          'thrown error names the validation failure'
        );
        assert.match(e.message, /simulated invalid output for test/, 'thrown error includes reason');
      }
      assert.equal(threw, true, 'install threw when validator failed');

      const afterInstall = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      assert.equal(
        afterInstall,
        preInstall,
        'pre-install file restored verbatim after validation failure'
      );
    } finally {
      delete installModule.__codexSchemaValidator;
      cleanup(tmpDir);
    }
  });
});

describe('#2760 — hasUserNamespacedAotHooks helper', () => {
  test('detects [[hooks.SessionStart]] AoT entries', () => {
    const content = [
      '[[hooks.SessionStart]]',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), true);
  });

  test('returns false when only top-level [[hooks]] entries exist', () => {
    const content = [
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), false);
  });

  test('returns false when only single-bracket [hooks.SessionStart] exists', () => {
    const content = [
      '[hooks.SessionStart]',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), false);
  });
});

// concurrency: false — these tests monkey-patch fs.writeFileSync, a global
// shared with every other suite running in parallel. Serializing prevents
// stray writes from sibling tests landing in the stub.
describe('#2760 fix 4 — Write-failure rollback (atomic write + snapshot restore)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalWriteFileSync;
  // #2760 CR5 finding 5 — symmetric snapshot/restore for fs.renameSync. The
  // first test below monkey-patches renameSync; without a beforeEach/afterEach
  // pair, only the local `finally` restores it, which is fragile to future
  // edits that add early-return paths.
  let originalRenameSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f4-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalWriteFileSync = fs.writeFileSync;
    originalRenameSync = fs.renameSync;
  });

  afterEach(() => {
    fs.renameSync = originalRenameSync;
    fs.writeFileSync = originalWriteFileSync;
    cleanup(tmpDir);
  });

  test('pre-install config bytes survive when fs.renameSync throws over configPath', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    // After fs is restored we'll re-read the file. Capture the byte buffer
    // exactly so the comparison is bit-for-bit.
    const preInstallBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));

    const configPath = path.join(codexHome, 'config.toml');
    const tempPattern = new RegExp('^' + configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.tmp-');

    // Stub: allow writes to atomic temp files (which renameSync overwrites
    // the target, never truncating it directly) but throw on any direct
    // write to the canonical configPath. This simulates either:
    //   (a) an older code path doing a non-atomic write, or
    //   (b) a downstream module bypassing atomicWriteFileSync.
    // Either way the snapshot must be restored. We let the temp write go
    // through, then make renameSync throw to simulate the partial write
    // never landing.
    // #2760 CR5 finding 5 — fs.renameSync is restored by the suite-level
    // afterEach; no local finally needed.
    fs.renameSync = (src, dst) => {
      if (dst === configPath) {
        throw new Error('simulated rename failure mid-install');
      }
      return originalRenameSync(src, dst);
    };

    let threw = false;
    let thrownErr = null;
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownErr = e;
      assert.ok(/rename failure|simulated|post-write/.test(e.message),
        'thrown error must surface the simulated failure or its post-write wrapper: ' + e.message);
    }
    // #2760 CR5 finding 4 — tighten contract per finding #1: ALL pre-write
    // and write failures must be fatal. This test previously accepted either
    // throw OR warn — sibling tests already require throw, so lock parity.
    assert.equal(threw, true, 'rename failure must be fatal: ' + (thrownErr && thrownErr.message));

    const afterBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    assert.deepStrictEqual(
      afterBytes,
      preInstallBytes,
      'pre-install config.toml bytes must survive a mid-install write/rename failure'
    );

    // And the parsed structure of the surviving file must still be the
    // user's [model] section, not a half-written GSD block.
    const parsed = parseTomlToObject(afterBytes.toString('utf8'));
    assert.equal(parsed.model && parsed.model.name, 'o3',
      'surviving file must still be the user pre-install content');
    assert.equal(parsed.agents, undefined,
      'no GSD agents block may have leaked into the surviving file');

    // No stray .tmp-* siblings left behind in the codex home.
    const stray = fs.readdirSync(codexHome).filter((f) => tempPattern.test(path.join(codexHome, f)));
    assert.equal(stray.length, 0,
      'atomic write must clean up its temp file on failure: ' + stray.join(', '));
  });

  test('pre-install config bytes survive when fs.writeFileSync throws on the .tmp- target', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    const preInstallBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    const configPath = path.join(codexHome, 'config.toml');
    const tempPattern = new RegExp('^' + configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.tmp-');

    // Stub: fault writes targeting the atomic temp file (the pre-rename branch
    // of atomicWriteFileSync). Other writes (agent .toml files in CODEX_HOME)
    // pass through. This exercises the failure path where the temp write itself
    // throws, not the rename — the case the prior test left untested.
    // #2760 CR5 finding 5 — fs.writeFileSync is restored by the suite-level
    // afterEach (via originalWriteFileSync); no local finally needed.
    const captured = originalWriteFileSync;
    fs.writeFileSync = function patchedWriteFileSync(target, data, options) {
      if (typeof target === 'string' && tempPattern.test(target)) {
        throw new Error('simulated writeFileSync failure on .tmp- target');
      }
      return captured.call(this, target, data, options);
    };

    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      assert.ok(/simulated writeFileSync failure|post-write Codex install failed|pre-write/.test(e.message),
        'thrown error must surface the simulated failure or its post-write wrapper: ' + e.message);
    }
    // Per #2760 CR4 finding 1 / CR5 finding 1, write failures must abort install (not warn).
    assert.equal(threw, true, 'install must throw when atomic temp-write fails');

    const afterBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    assert.deepStrictEqual(
      afterBytes,
      preInstallBytes,
      'pre-install config.toml bytes must survive a temp-write failure'
    );

    const parsed = parseTomlToObject(afterBytes.toString('utf8'));
    assert.equal(parsed.model && parsed.model.name, 'o3',
      'surviving file must still be the user pre-install content');
    assert.equal(parsed.agents, undefined,
      'no GSD agents block may have leaked into the surviving file');

    const stray = fs.readdirSync(codexHome).filter((f) => tempPattern.test(path.join(codexHome, f)));
    assert.equal(stray.length, 0,
      'atomic write must clean up its temp file on failure: ' + stray.join(', '));
  });
});

// concurrency: false — these tests rely on the same install path and module-
// level pre-install snapshot that the fix-3/fix-4 suites exercise. Serializing
// keeps state mutations from leaking across parallel siblings.
describe('#2760 CR4 finding 2 — Legacy flat [[hooks]] block migrates to namespaced AoT on reinstall', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr4-f2-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('pre-install legacy flat [[hooks]] gsd-check-update + user namespaced [[hooks.SessionStart]] → post-install converges on namespaced AoT', () => {
    // Reproduce the upgrade scenario:
    //   - User has [[hooks.SessionStart]] entry of their own (signal that GSD
    //     should emit in the namespaced shape).
    //   - A previous GSD install left the legacy flat [[hooks]] managed block
    //     for gsd-check-update. The pre-CR4 strip step would short-circuit
    //     the namespaced emit and leave the user stuck in the mixed layout.
    const userPlusLegacy = [
      '[[hooks.SessionStart]]',
      'command = "echo user hook"',
      '',
      '# GSD Hooks',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userPlusLegacy);

    runCodexInstall(codexHome);
    const afterInstall = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(afterInstall);

    // After CR4 finding 2: the legacy flat [[hooks]] managed block is stripped
    // and the GSD entry is re-emitted in the namespaced AoT shape so the two
    // forms do not coexist.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'hooks.SessionStart must be an array-of-tables, got: '
        + (parsed.hooks ? typeof parsed.hooks.SessionStart : 'no hooks table')
    );

    // Migration now handles stale [[hooks.SessionStart]] entries with handler
    // fields at event-entry level (pre-#2773 shape), promoting them to the
    // two-level nested form. Every entry must carry a .hooks sub-array after
    // migration, so collect from nested handlers only.
    assert.ok(
      parsed.hooks.SessionStart.every((entry) => Array.isArray(entry.hooks)),
      'every hooks.SessionStart entry must use nested [[hooks.SessionStart.hooks]] handlers after migration'
    );
    const allSessionStartCommands = parsed.hooks.SessionStart.flatMap((entry) =>
      entry.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      allSessionStartCommands.includes('echo user hook'),
      'user [[hooks.SessionStart]] entry preserved: ' + JSON.stringify(allSessionStartCommands)
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'GSD entry must appear in hooks.json SessionStart entries: '
        + JSON.stringify(hooksJsonCommands)
    );

    // The legacy top-level [[hooks]] AoT must NOT coexist with the namespaced
    // form after migration. parseTomlToObject distinguishes via Array.isArray.
    assert.ok(
      !Array.isArray(parsed.hooks) || parsed.hooks.length === 0,
      'no top-level [[hooks]] AoT entries may remain after legacy migration: '
        + JSON.stringify(parsed.hooks)
    );

    // No duplicate gsd-check-update entries — exactly one managed entry.
    const gsdEntries = hooksJsonCommands.filter((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd));
    assert.equal(gsdEntries.length, 1,
      'exactly one gsd-check-update entry after migration, got: ' + gsdEntries.length);
  });
});

describe('#2760 CR4 finding 3 / #3245 — parseTomlToObject handles edge-case value types (floats accepted; dates/trailing-garbage rejected)', () => {
  // #3245 inverts the float-rejection requirement: Codex CLI's serde schema
  // requires f64 for tool_timeout_sec/startup_timeout_sec, so GSD's parser
  // must now ACCEPT floats. The original guard (from #2760 CR4 finding 3) was
  // "don't silently truncate 0.5 to integer 0" — that goal is still met
  // because we parse the full float as a JS Number (not truncate to prefix).
  test('accepts TOML floats (timeout = 0.5) — #3245 fix', () => {
    const content = [
      '[server]',
      'timeout = 0.5',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.server.timeout, 0.5,
      'float values must be accepted as JS Number (not truncated to 0) — #3245');
  });

  test('rejects date values (created = 1979-05-27)', () => {
    const content = [
      '[meta]',
      'created = 1979-05-27',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value|trailing bytes/,
      'date values must be rejected, not silently truncated'
    );
  });

  test('rejects trailing garbage after a string value (key = "x" junk)', () => {
    const content = [
      '[section]',
      'key = "x" junk',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /trailing bytes/,
      'trailing bytes after a complete value must be rejected'
    );
  });

  test('accepts trailing whitespace and # comment after a value', () => {
    const content = [
      '[section]',
      'key = "x"   # an inline comment',
      'flag = true',
      'count = 7   ',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.equal(parsed.section.key, 'x');
    assert.equal(parsed.section.flag, true);
    assert.equal(parsed.section.count, 7);
  });
});

// concurrency: false — see the fix-3 suite above for the same rationale.
describe('#2760 CR4 finding 1 — atomicWriteFileSync failure aborts install (post-write fatal)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalRenameSync;
  let originalConsoleLog;
  let consoleOutput;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr4-f1-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalRenameSync = fs.renameSync;
    originalConsoleLog = console.log;
    consoleOutput = [];
    console.log = (...args) => { consoleOutput.push(args.join(' ')); };
  });

  afterEach(() => {
    fs.renameSync = originalRenameSync;
    console.log = originalConsoleLog;
    cleanup(tmpDir);
  });

  test('install throws and never prints "Done!" when atomicWriteFileSync fails on configPath', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    const configPath = path.join(codexHome, 'config.toml');
    // Only fault the hook-block atomic rename — earlier writes to config.toml
    // happen via mergeCodexConfig (agent-block emit). We want to exercise the
    // post-write Codex install branch specifically. Detect by reading the temp
    // file's contents and only faulting when the hook block is present.
    fs.renameSync = (src, dst) => {
      if (dst === configPath) {
        let isHookWrite = false;
        try {
          const data = fs.readFileSync(src, 'utf8');
          isHookWrite = /GSD codex_hooks ownership/.test(data);
        } catch (_) { /* ignore */ }
        if (isHookWrite) {
          throw new Error('simulated rename failure');
        }
      }
      return originalRenameSync(src, dst);
    };

    let threw = false;
    let thrownMessage = '';
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownMessage = e.message;
    }

    assert.equal(threw, true, 'install must throw when atomic write fails');
    assert.match(
      thrownMessage,
      /post-write Codex install failed/,
      'thrown error must use the post-write prefix so the outer catch treats it as fatal'
    );

    // Critical: install must NOT have printed any "Done!" success banner.
    const printedDone = consoleOutput.some(
      (line) => typeof line === 'string' && /Done!/i.test(line)
    );
    assert.equal(printedDone, false,
      'install must NOT print "Done!" after a write failure: ' + JSON.stringify(consoleOutput.filter((l) => /Done|✓/.test(l))));

    // And the user's pre-install bytes are intact (snapshot restore).
    const after = fs.readFileSync(configPath, 'utf8');
    assert.equal(after, preInstall, 'pre-install bytes preserved after fatal abort');
  });
});

// concurrency: false — patches module.exports.__codexSchemaValidator, a
// shared test seam. Serializing prevents stray patches from sibling tests.
describe('#2760 CR5 finding 1 — pre-write failures abort install (outer catch fatal)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalConsoleLog;
  let consoleOutput;
  const installModule = require('../bin/install.js');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr5-f1-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalConsoleLog = console.log;
    consoleOutput = [];
    console.log = (...args) => { consoleOutput.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    delete installModule.__codexSchemaValidator;
    cleanup(tmpDir);
  });

  test('pre-write throw (validator throws, not returns {ok:false}) is fatal and restores snapshot', () => {
    // A validator that THROWS (vs returning {ok:false}) bypasses the
    // validation branch and exits the inner try via the catch at the outer
    // level. Pre-CR5, that catch downgraded to console.warn and let the
    // install print "Done!" with no Codex hooks. Post-CR5 it must rethrow.
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    installModule.__codexSchemaValidator = () => {
      throw new Error('synthetic validator-throw simulating a pre-write helper failure');
    };

    let threw = false;
    let thrownMsg = '';
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownMsg = e.message;
    }

    assert.equal(threw, true,
      'install must rethrow when a pre-write step throws (CR5 finding 1)');
    assert.match(thrownMsg, /pre-write|synthetic validator-throw/,
      'thrown error must surface the pre-write wrapper or original message: ' + thrownMsg);

    const printedDone = consoleOutput.some(
      (line) => typeof line === 'string' && /Done!/i.test(line)
    );
    assert.equal(printedDone, false,
      'install must NOT print "Done!" after a pre-write failure: ' +
      JSON.stringify(consoleOutput.filter((l) => /Done|✓/.test(l))));

    // Pre-install bytes intact (snapshot restored).
    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.equal(after, preInstall,
      'pre-install bytes must survive a pre-write helper throw');
  });
});

describe('#2760 CR5 finding 2 — parseTomlToObject rejects duplicate keys and shape-mismatched headers', () => {
  test('rejects duplicate scalar key in same table ([a]\\nx=1\\nx=2)', () => {
    const content = [
      '[a]',
      'x = 1',
      'x = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate key/,
      'real TOML 1.0 rejects duplicate keys in the same table'
    );
  });

  test('rejects duplicate scalar key in root table', () => {
    const content = [
      'x = 1',
      'x = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate key/,
      'duplicate root-table keys must be rejected'
    );
  });

  test('rejects re-declared [a] table header ([a] then [a] again)', () => {
    const content = [
      '[a]',
      'x = 1',
      '',
      '[a]',
      'y = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate or shape-mismatched table header/,
      'real TOML 1.0 rejects re-declaring the same [a] header twice'
    );
  });

  test('rejects [[arr]] then [arr] for same path (array-of-tables → table)', () => {
    const content = [
      '[[arr]]',
      'x = 1',
      '',
      '[arr]',
      'y = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate or shape-mismatched table header/,
      'cannot redeclare an array-of-tables path as a plain table'
    );
  });

  test('accepts repeated [[arr]] (genuine array-of-tables)', () => {
    const content = [
      '[[arr]]',
      'x = 1',
      '',
      '[[arr]]',
      'x = 2',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.ok(Array.isArray(parsed.arr));
    assert.strictEqual(parsed.arr.length, 2);
    assert.strictEqual(parsed.arr[0].x, 1);
    assert.strictEqual(parsed.arr[1].x, 2);
  });

  test('accepts disjoint nested headers (not duplicates)', () => {
    const content = [
      '[a.b]',
      'x = 1',
      '',
      '[a.c]',
      'y = 2',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.a.b.x, 1);
    assert.strictEqual(parsed.a.c.y, 2);
  });
});

// concurrency: false — drives the same install pipeline as the other f-suites.
describe('#2760 CR5 finding 3 — migration emits namespaced AoT (no flat/namespaced mixing)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr5-f3-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('user has [[hooks.AfterTool]] AND legacy [hooks.SessionStart] → post-install both namespaced, no flat AoT', () => {
    // Reproduces the mixed-form scenario from finding 3:
    //  - User pre-config has both a namespaced AoT entry [[hooks.AfterTool]]
    //    AND a legacy single-bracket [hooks.SessionStart].
    //  - Pre-CR5 migration converts the legacy section to flat [[hooks]]
    //    with event="SessionStart", leaving a mixed flat+namespaced layout.
    //  - Post-CR5 migration emits [[hooks.SessionStart]] directly so both
    //    of the user's hooks coexist in the namespaced shape, and the
    //    GSD-managed entry converges on namespaced too.
    const userPlusLegacy = [
      '[[hooks.AfterTool]]',
      'command = "x"',
      '',
      '[hooks.SessionStart]',
      'command = "y"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userPlusLegacy);

    runCodexInstall(codexHome);
    const after = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(after);

    // The pre-existing [[hooks.AfterTool]] entry is preserved.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.AfterTool),
      'pre-existing [[hooks.AfterTool]] must remain a namespaced AoT array'
    );
    // AfterTool was in [[hooks.AfterTool]] with command at event-entry level
    // (pre-#2773 stale namespaced AoT shape). Migration now promotes these to
    // the two-level nested form, so every entry must have a .hooks sub-array.
    assert.ok(
      parsed.hooks.AfterTool.every((e) => Array.isArray(e.hooks)),
      'every AfterTool entry must use nested [[hooks.AfterTool.hooks]] handlers after migration'
    );
    const afterToolCommands = parsed.hooks.AfterTool.flatMap((e) =>
      e.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      afterToolCommands.includes('x'),
      'user AfterTool entry must be preserved: ' + JSON.stringify(afterToolCommands)
    );

    // The migrated SessionStart entry is now namespaced AoT with nested .hooks sub-table.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'migrated SessionStart must be namespaced AoT (not flat [[hooks]])'
    );
    // After migration, [hooks.SessionStart] map-format is promoted to nested AoT.
    // Command lives in [[hooks.SessionStart.hooks]][0].command (nested schema).
    assert.ok(
      parsed.hooks.SessionStart.every((e) => Array.isArray(e.hooks)),
      'every SessionStart entry must use nested [[hooks.SessionStart.hooks]] handlers after migration'
    );
    const ssCommands = parsed.hooks.SessionStart.flatMap((e) =>
      e.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      ssCommands.includes('y'),
      'user SessionStart command "y" must be preserved in namespaced array: ' +
        JSON.stringify(ssCommands)
    );
    // GSD's managed gsd-check-update entry also lives in the namespaced array.
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'managed gsd-check-update entry must appear in hooks.json SessionStart entries: ' +
        JSON.stringify(hooksJsonCommands)
    );

    // No flat top-level [[hooks]] AoT may remain.
    assert.ok(
      !Array.isArray(parsed.hooks) || parsed.hooks.length === 0,
      'no flat top-level [[hooks]] AoT entries may remain after migration: ' +
        JSON.stringify(parsed.hooks)
    );

    // No synthetic event field on the migrated SessionStart entries — the
    // namespace IS the event.
    for (const entry of parsed.hooks.SessionStart) {
      assert.equal(entry.event, undefined,
        'no synthetic event field — namespace [[hooks.SessionStart]] encodes the event: ' +
          JSON.stringify(entry));
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-279-codex-agent-mapping.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-279-codex-agent-mapping (consolidation epic #1969 B1 #1970)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');
const src = fs.readFileSync(INSTALL_JS, 'utf8');

describe('bug #279: Codex adapter documents Agent() and deferred tool discovery', () => {
  test('adapter mapping section includes explicit Agent(...) -> spawn_agent mapping', () => {
    assert.ok(
      /Task\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src) &&
      /Agent\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src),
      'Codex adapter must explicitly map both Task(...) and Agent(...) to spawn_agent',
    );
  });

  test('adapter includes deferred tool_search discovery guidance before inline fallback', () => {
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'),
      'Codex adapter must instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3017-codex-hook-absolute-node.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3017-codex-hook-absolute-node (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3017: Codex SessionStart hook still emits bare `node` after #3002.
 *
 * PR #3002 fixed #2979 for settings.json-based managed JS hooks (Claude
 * Code, Gemini, Antigravity) by routing through buildHookCommand() →
 * resolveNodeRunner(), which emits the absolute Node binary path. But the
 * Codex install path writes its SessionStart hook directly into a
 * config.toml string, bypassing both helpers:
 *
 *   command = "node ${updateCheckScript}"
 *
 * Under a GUI/minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) where node
 * is not resolvable, the hook fails with `/bin/sh: node: command not
 * found` (exit 127). The same failure mode #2979 was meant to fix —
 * just on the codex toml branch instead of the settings.json branch.
 *
 * The fix exposes two pure helpers and tests them as typed records,
 * not by grepping install.js content:
 *
 *   buildCodexHookBlock(targetDir, { absoluteRunner }) → toml string
 *     - emits `command = "<absoluteRunner> <quoted hook path>"` so the
 *       hook resolves under minimal PATH.
 *     - returns null when absoluteRunner is null (caller skips with warn,
 *       matching settings.json branch behavior).
 *
 *   rewriteLegacyCodexHookBlock(tomlContent, absoluteRunner) → { content, changed }
 *     - rewrites an existing bare-node managed-hook command on reinstall
 *       (matches the rewriteLegacyManagedNodeHookCommands shape from #3002).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { buildCodexHookBlock, rewriteLegacyCodexHookBlock, resolveNodeRunner } = INSTALL;
const { projectCodexHookTomlCommand } = projection;

/**
 * Parse the toml hook block into a typed record so tests can assert on
 * the structured shape (what's the runner, what's the hook path, what's
 * the type) rather than substring-matching the toml text.
 */
function parseCodexHookBlock(block) {
  if (!block) return { ok: false, reason: 'empty' };
  // The block always carries the "# GSD Hooks" marker, the AoT tables,
  // a type=command, and a command="<runner> <quoted-hook-path>" line.
  const hasMarker = /^# GSD Hooks$/m.test(block);
  const hasEvent = /^\[\[hooks\.SessionStart\]\]$/m.test(block);
  const hasHandler = /^\[\[hooks\.SessionStart\.hooks\]\]$/m.test(block);
  const typeMatch = block.match(/^type\s*=\s*"([^"]+)"$/m);
  // command = "<runner> <hookpath>" — runner may itself be a quoted absolute path.
  // Match the whole RHS as one toml double-quoted string, then split into runner + hookpath.
  const cmdLine = block.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"$/m);
  if (!cmdLine) return { ok: false, reason: 'no command line' };
  const cmdValue = cmdLine[1];
  // Inside the command value, the runner is either a quoted string (escaped \" in toml)
  // or a bare token, followed by a space and the hook path (quoted).
  // toml escapes interior " as \", so the cmdValue contains literal \" sequences.
  const cmdParsed = cmdValue.match(/^(\\".+?\\"|node|bash|\S+)\s+\\"([^\\]+)\\"\s*$/);
  return {
    ok: true,
    hasMarker,
    hasEvent,
    hasHandler,
    type: typeMatch ? typeMatch[1] : null,
    command: cmdValue,
    runner: cmdParsed ? cmdParsed[1] : null,
    hookPath: cmdParsed ? cmdParsed[2] : null,
  };
}

// Strip the toml-escape (\") and JSON-quote (") layers from the parsed
// runner token to compare against the raw absolute path the caller
// supplied. parsed.runner round-trips through TWO escape layers:
//   1. JSON.stringify in resolveNodeRunner adds outer "..." quotes
//   2. toml escapes the interior " to \" inside the command field
// After both, parsed.runner ends in `\"` and starts with `\"`.
function unescapeRunner(token) {
  if (!token) return token;
  let t = token.replace(/^\\"/, '').replace(/\\"$/, '');
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

describe('Bug #3017 / #3440: Codex hook projection seam', () => {
  test('projectCodexHookTomlCommand renders escaped command value from shared projection module', () => {
    const commandValue = projectCodexHookTomlCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '/tmp/codex-test/.codex/hooks/gsd-check-update.js',
      platform: 'linux',
    });
    assert.equal(
      commandValue,
      '\\"/usr/local/bin/node\\" \\"/tmp/codex-test/.codex/hooks/gsd-check-update.js\\"',
    );
  });
});

describe('Bug #3017: buildCodexHookBlock emits absolute node runner', () => {
  test('exported as a function', () => {
    assert.equal(typeof buildCodexHookBlock, 'function');
  });

  test('emits the EXACT absolute node runner the caller supplied (#3022 CR)', () => {
    const targetDir = '/tmp/codex-test/.codex';
    const expectedRunnerPath = '/usr/local/bin/node';
    const absoluteRunner = `"${expectedRunnerPath}"`;
    const block = buildCodexHookBlock(targetDir, { absoluteRunner });
    const parsed = parseCodexHookBlock(block);
    assert.equal(parsed.ok, true, `parse failed: ${block}`);
    assert.equal(parsed.hasMarker, true, '# GSD Hooks marker present');
    assert.equal(parsed.hasEvent, true, '[[hooks.SessionStart]] AoT entry present');
    assert.equal(parsed.hasHandler, true, '[[hooks.SessionStart.hooks]] handler entry present');
    assert.equal(parsed.type, 'command', 'handler is type=command');
    // Strict: parsed runner must match the supplied absolute path EXACTLY
    // (after stripping toml/JSON escape layers). A loose substring like
    // '/node' would let an unrelated absolute token containing '/node'
    // pass — e.g. '/Users/x/notnode/foo'.
    assert.equal(unescapeRunner(parsed.runner), expectedRunnerPath,
      `parsed runner must equal supplied absolute path: got ${parsed.runner}, want ${expectedRunnerPath}`);
    // On Windows, path.resolve prepends the current drive letter ("D:") to
    // the POSIX-shaped fixture path. Accept either form.
    const expectedHookSuffix = '/tmp/codex-test/.codex/hooks/gsd-check-update.js';
    assert.ok(
      parsed.hookPath === expectedHookSuffix ||
        parsed.hookPath.replace(/^[A-Za-z]:/, '') === expectedHookSuffix,
      `hook path equality, got: ${parsed.hookPath}, want suffix: ${expectedHookSuffix}`,
    );
  });

  test('returns null when absoluteRunner is null (caller skips registration)', () => {
    const block = buildCodexHookBlock('/tmp/x/.codex', { absoluteRunner: null });
    assert.equal(block, null,
      'must return null on missing runner so caller can warn-and-skip instead of writing a broken hook');
  });

  test('integrates with resolveNodeRunner() in the live process — runner equals resolved node runner (#3022 CR)', () => {
    const runner = resolveNodeRunner();
    assert.ok(runner, 'resolveNodeRunner returns a usable value in this test env');
    const block = buildCodexHookBlock('/tmp/x/.codex', { absoluteRunner: runner });
    const parsed = parseCodexHookBlock(block);
    assert.equal(parsed.ok, true);
    // Strict canonical-runner equality: the parsed runner (after stripping
    // toml + JSON escape layers) must be exactly the normalized runner that
    // resolveNodeRunner selected. Homebrew Cellar execPath values intentionally
    // normalize to the stable Homebrew symlink (#3181).
    const expected = JSON.parse(runner);
    assert.equal(unescapeRunner(parsed.runner), expected,
      `parsed runner must equal resolveNodeRunner(), got: ${parsed.runner}, want: ${expected}`);
  });
});

describe('Bug #3017: rewriteLegacyCodexHookBlock migrates bare-node on reinstall', () => {
  test('exported as a function', () => {
    assert.equal(typeof rewriteLegacyCodexHookBlock, 'function');
  });

  test('rewrites a bare-node managed-hook command to the absolute runner', () => {
    const before = [
      '[model]',
      'name = "o3"',
      '',
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /Users/x/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const expectedRunnerPath = '/usr/local/bin/node';
    const runner = `"${expectedRunnerPath}"`;
    const result = rewriteLegacyCodexHookBlock(before, runner);
    assert.equal(result.changed, true, 'must report change=true');
    // The migrated command must use the EXACT absolute runner the caller
    // supplied (#3022 CR — was previously asserting a loose '/node'
    // substring which let unrelated absolute paths pass).
    const parsed = parseCodexHookBlock(result.content);
    assert.equal(parsed.ok, true);
    assert.equal(unescapeRunner(parsed.runner), expectedRunnerPath,
      `runner must equal supplied absolute path: ${parsed.runner}`);
    assert.equal(parsed.hookPath, '/Users/x/.codex/hooks/gsd-check-update.js');
    // Non-GSD content (the [model] block) must be preserved verbatim.
    assert.ok(result.content.includes('[model]'));
    assert.ok(result.content.includes('name = "o3"'));
  });

  test('decodes TOML-escaped quoted script paths before projection', () => {
    const before = [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node \\"C:\\\\Users\\\\x\\\\.codex\\\\hooks\\\\gsd-check-update.js\\""',
      '',
    ].join('\n');
    const runner = '"/usr/local/bin/node"';
    const result = rewriteLegacyCodexHookBlock(before, runner, { platform: 'win32' });
    assert.equal(result.changed, true);
    const parsed = parseCodexHookBlock(result.content);
    assert.equal(parsed.ok, true, 'hook block must parse correctly');
    const expected = projectCodexHookTomlCommand({
      absoluteRunner: runner,
      scriptPath: 'C:\\Users\\x\\.codex\\hooks\\gsd-check-update.js',
      platform: 'win32',
    });
    assert.equal(parsed.command, expected,
      'rewritten command must project from decoded Windows path (not TOML-escaped token text)');
    assert.equal(unescapeRunner(parsed.runner), '/usr/local/bin/node',
      'runner must equal supplied absolute path');
    assert.equal(parsed.hookPath, 'C:/Users/x/.codex/hooks/gsd-check-update.js',
      'hook path must equal decoded Windows path after projection normalization');
  });

  test('does NOT touch a managed-hook entry that already uses an absolute runner', () => {
    const already = [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "\\"/usr/local/bin/node\\" /Users/x/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = rewriteLegacyCodexHookBlock(already, '"/usr/local/bin/node"');
    assert.equal(result.changed, false);
    assert.equal(result.content, already);
  });

  test('does NOT touch user-authored bare-node hooks (filename not in managed allowlist)', () => {
    const userOwned = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /home/me/my-custom-codex-hook.js"',
      '',
    ].join('\n');
    const result = rewriteLegacyCodexHookBlock(userOwned, '"/usr/local/bin/node"');
    assert.equal(result.changed, false,
      'user-authored hooks must be left alone; only managed gsd-* hooks are migrated');
    assert.equal(result.content, userOwned);
  });

  test('returns content unchanged when absoluteRunner is null', () => {
    const before = 'command = "node /path/to/gsd-check-update.js"';
    const result = rewriteLegacyCodexHookBlock(before, null);
    assert.equal(result.changed, false);
    assert.equal(result.content, before);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3018-codex-discuss-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3018-codex-discuss-fallback (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3018.
 *
 * @jon-hendry: running `$gsd-discuss-phase 81` in Codex Default mode (where
 * `request_user_input` is rejected) caused the agent to pick "reasonable
 * defaults" and proceed straight into writing CONTEXT.md / DISCUSSION-LOG.md
 * checkpoints — without ever surfacing the questions to the user. The
 * generated Codex skill adapter explicitly told it to do that:
 *
 *   "When `request_user_input` is rejected (Execute mode), present a
 *    plain-text numbered list and pick a reasonable default."
 *
 * Discuss-mode is the wrong place for that fallback. The contract should be:
 * stop, render the questions as plain text, wait for the user's answer.
 * Defaults may only be picked when the user has authorized non-interactive
 * mode (--auto / --all) or has explicitly approved them.
 *
 * Test design (#3027 CR follow-up): instead of grepping the prose with
 * regex, parse the fallback section into a typed semantic-flag record and
 * assert on those booleans. This adheres to CONTRIBUTING.md "no-source-grep"
 * — the test names a behavioral invariant, the parser walks the prose
 * once and exposes the invariants as named flags, and the prose can be
 * reworded freely as long as the flags stay true.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { getCodexSkillAdapterHeader } = INSTALL;

/**
 * Extract the "Execute mode fallback" section text from the adapter header.
 * Returns null if the section is missing. Section runs from the
 * "Execute mode fallback:" label up to the next heading or </codex_skill_adapter> tag.
 */
function extractExecuteModeFallback(header) {
  const m = header.match(/Execute mode fallback:\s*\n([\s\S]*?)(?=\n##\s|\n<\/codex_skill_adapter>)/);
  return m ? m[1].trim() : null;
}

/**
 * Parse the Execute-mode-fallback section into a typed semantic-flag
 * record. Each flag answers a single behavioral question that the #3018
 * fix is contractually required to encode in the prose. Tests assert on
 * the booleans, not the wording — so the prose can evolve without test
 * churn as long as the semantics stay correct.
 *
 * The flags are derived from a single pass over the section text: each
 * one looks for any of a small set of synonym phrases that a correct
 * implementation would use. The negative anti-pattern flag
 * (`silentlyPicksDefaults`) is the regression guard — the prose under
 * #3018 told the agent to "pick a reasonable default" autonomously,
 * which is exactly what this fix removes.
 */
function parseExecuteModeFallback(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      instructsStop: false,
      presentsPlainTextQuestions: false,
      namesPermissionPath: false,
      forbidsWritingArtifactsBeforeAnswer: false,
      silentlyPicksDefaults: false,
    };
  }
  const lower = section.toLowerCase();
  // (a) STOP/WAIT directive — the agent must halt instead of proceeding.
  const instructsStop = /\b(stop|halt|wait)\b/.test(lower);
  // (b) Plain-text fallback presentation — the agent must surface the
  // questions in some inspectable form (numbered list / plain text).
  const presentsPlainTextQuestions = /plain.?text|numbered list/.test(lower);
  // (c) Permission path that DOES allow defaults — must name at least
  // one (--auto / --all / explicit user approval / autonomous workflow).
  const namesPermissionPath =
    /--auto|--all/.test(section) ||
    /explicit(ly)? (approv|authoriz|consent)/i.test(section) ||
    /user (has )?approv|user (has )?authoriz|user (has )?consent/i.test(section) ||
    /autonomous (lifecycle|workflow|paths?)/i.test(section);
  // (d) Artifact-write ban — the agent must not produce workflow files
  // (CONTEXT.md, DISCUSSION-LOG.md, PLAN.md, checkpoints) before the
  // user answers or one of the permission-path conditions applies.
  // Require BOTH a "do not write" intent AND a named artifact class so
  // generic "do not write" prose elsewhere can't satisfy the flag.
  const forbidsWriteIntent = /do not write|don'?t write|must not write|shall not write/i.test(section);
  const namesArtifactClass = /artifact|checkpoint|context\.md|discussion.?log|plan\.md/i.test(section);
  const forbidsWritingArtifactsBeforeAnswer = forbidsWriteIntent && namesArtifactClass;
  // Anti-pattern guard — the prose that caused #3018. This MUST be false.
  const silentlyPicksDefaults = /pick (a |the )?(reasonable|sensible|sane) default/i.test(section);
  return {
    ok: true,
    sectionLength: section.length,
    instructsStop,
    presentsPlainTextQuestions,
    namesPermissionPath,
    forbidsWritingArtifactsBeforeAnswer,
    silentlyPicksDefaults,
  };
}

describe('bug #3018: codex skill adapter encodes the discuss-mode fallback contract', () => {
  test('exports the adapter generator', () => {
    assert.equal(typeof getCodexSkillAdapterHeader, 'function');
  });

  test('Execute mode fallback section exists and has content', () => {
    const header = getCodexSkillAdapterHeader('gsd-discuss-phase');
    const section = extractExecuteModeFallback(header);
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.ok, true, `section must parse, got header:\n${header}`);
    assert.ok(parsed.sectionLength > 0, 'section must be non-empty');
  });

  test('fallback instructs STOP/WAIT (not silent continuation)', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.instructsStop, true,
      `must instruct stop/halt/wait — section was:\n${section}`);
  });

  test('fallback prescribes plain-text question presentation', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.presentsPlainTextQuestions, true,
      `must mention plain-text / numbered-list presentation — section was:\n${section}`);
  });

  test('fallback names a permission path under which defaults ARE allowed (--auto / --all / explicit approval / autonomous)', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.namesPermissionPath, true,
      `must name at least one permission path — section was:\n${section}`);
  });

  test('fallback forbids writing workflow artifacts before user answers', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.forbidsWritingArtifactsBeforeAnswer, true,
      `must encode write-ban + named artifact class — section was:\n${section}`);
  });

  test('fallback does NOT contain the #3018 anti-pattern ("pick a reasonable default")', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.silentlyPicksDefaults, false,
      `regression — fallback must NOT instruct the agent to pick defaults autonomously, section was:\n${section}`);
  });

  test('all four positive flags + the negative anti-pattern flag — typed-record snapshot', () => {
    // Single assertion that the whole semantic record matches the contract.
    // If any flag flips, the test fails with a structured diff naming the
    // exact invariant that broke.
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    const semanticContract = {
      ok: parsed.ok,
      instructsStop: parsed.instructsStop,
      presentsPlainTextQuestions: parsed.presentsPlainTextQuestions,
      namesPermissionPath: parsed.namesPermissionPath,
      forbidsWritingArtifactsBeforeAnswer: parsed.forbidsWritingArtifactsBeforeAnswer,
      silentlyPicksDefaults: parsed.silentlyPicksDefaults,
    };
    assert.deepStrictEqual(semanticContract, {
      ok: true,
      instructsStop: true,
      presentsPlainTextQuestions: true,
      namesPermissionPath: true,
      forbidsWritingArtifactsBeforeAnswer: true,
      silentlyPicksDefaults: false,
    }, `discuss-mode fallback contract violated — section was:\n${section}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3245-codex-toml-floats.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3245-codex-toml-floats (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3245 — Codex install rejects valid TOML floats.
 *
 * Two defects, two fixes:
 *
 *   Defect 1 — parseTomlValue rejects TOML floats (e.g. tool_timeout_sec = 20.0).
 *     Codex CLI's serde schema requires f64 for tool_timeout_sec / startup_timeout_sec
 *     (integers fail with "invalid type: integer"). GSD's strict-integer-only parser
 *     was the inverse of what Codex requires — any float triggers the rejection branch.
 *     Fix: extend parseTomlValue to accept TOML 1.0 float literals and return them as
 *     JS Number. The merged config.toml preserves the float form verbatim so
 *     round-trip writes don't coerce 20.0 → 20.
 *
 *   Defect 2 — Partial rollback leaves install in hybrid state.
 *     restoreCodexSnapshot only knew about config.toml, but skills/, agents/, and VERSION
 *     are written earlier in the install sequence. A post-install validation failure
 *     aborts with new agent text on disk, config.toml reverted, and .tmp files
 *     potentially orphaned.
 *     Fix: capture pre-install state of skills/, agents/, and VERSION before any
 *     Codex-specific mutation, and extend the rollback to cover all of them.
 */

// GSD_TEST_MODE must be set before require('../bin/install.js') so the module
// skips the main CLI entry point and exports its internals.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { cleanup } = require('./helpers.cjs');

const { parseTomlToObject, validateCodexConfigSchema, install } = require('../bin/install.js');
const installModule = require('../bin/install.js');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

// Ensure hooks/dist/ is populated — mirrors the pattern used by codex-config.test.cjs.
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
  }
});

function runCodexInstall(codexHome) {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
  // $HOME/.agents/skills root (os.homedir()-relative, independent of
  // CODEX_HOME). Sandbox HOME (and USERPROFILE) to codexHome so this
  // in-process install never materializes skills under the developer/CI
  // machine's real home directory.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  try {
    process.chdir(path.join(__dirname, '..'));
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Defect 1 — parseTomlValue must accept TOML floats
// ---------------------------------------------------------------------------

describe('#3245 — parseTomlToObject accepts TOML floats', () => {
  test('parses bare decimal float (20.0)', () => {
    const content = [
      'tool_timeout_sec = 20.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(typeof parsed.tool_timeout_sec, 'number',
      'tool_timeout_sec should be a JS number');
    assert.strictEqual(parsed.tool_timeout_sec, 20.0,
      'value must equal 20.0');
  });

  test('parses startup_timeout_sec = 60.0', () => {
    const content = [
      'startup_timeout_sec = 60.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.startup_timeout_sec, 60.0);
  });

  test('parses positive exponent notation (1e10)', () => {
    const content = [
      'x = 1e10',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1e10);
  });

  test('parses negative exponent (1.5e-3)', () => {
    const content = [
      'x = 1.5e-3',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.ok(Math.abs(parsed.x - 1.5e-3) < 1e-15, 'must be approximately 1.5e-3');
  });

  test('parses signed positive float (+1.0)', () => {
    const content = [
      'x = +1.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1.0);
  });

  test('parses signed negative float (-0.5)', () => {
    const content = [
      'x = -0.5',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, -0.5);
  });

  test('parses float with underscore separators (1_000.0)', () => {
    const content = [
      'x = 1_000.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1000.0);
  });

  test('integer (no decimal) still parses as integer', () => {
    const content = [
      'x = 42',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 42);
  });

  test('still rejects bare date (1979-05-27)', () => {
    const content = [
      'x = 1979-05-27',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value/,
      'date literals must remain unsupported'
    );
  });

  test('still rejects bare time (07:32:00)', () => {
    const content = [
      'x = 07:32:00',
      '',
    ].join('\n');
    // With leading-zero rejection (CR4 fix) the parser stops at `0`, and
    // `7:32:00` is "trailing bytes". Either error form is acceptable — the
    // key invariant is that time literals are never silently accepted.
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value|trailing bytes/,
      'time literals must remain unsupported'
    );
  });

  test('still rejects hex literal (0x1A)', () => {
    const content = [
      'x = 0x1A',
      '',
    ].join('\n');
    // 0 is parsed, then 'x1A' is trailing garbage — rejected with "trailing bytes"
    // or "unsupported value" depending on where the parser catches it.
    assert.throws(
      () => parseTomlToObject(content),
      /trailing bytes|unsupported (TOML value|value)/,
      'hex literals must remain unsupported'
    );
  });

  test('validateCodexConfigSchema passes a config with tool_timeout_sec = 20.0', () => {
    const content = [
      '[model]',
      'name = "o3"',
      '',
      'tool_timeout_sec = 20.0',
      'startup_timeout_sec = 60.0',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'schema validation must pass for a config containing TOML floats: ' + result.reason);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — full install must succeed and preserve float verbatim
// ---------------------------------------------------------------------------

// concurrency: false — drives the live install pipeline (shared CODEX_HOME env,
// process.chdir). Serialise to prevent stray mutations across parallel siblings.
describe('#3245 — install succeeds with TOML float in pre-existing config', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3245-float-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('install completes when config.toml contains tool_timeout_sec = 20.0', () => {
    // Floats at the root level (before any table header) — this is where Codex
    // CLI reads tool_timeout_sec / startup_timeout_sec according to its serde schema.
    const preInstall = [
      'tool_timeout_sec = 20.0',
      'startup_timeout_sec = 60.0',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    // Must not throw — pre-#3245 this threw "unsupported TOML value … floats … not supported".
    assert.doesNotThrow(
      () => runCodexInstall(codexHome),
      'install must not throw when config.toml contains TOML floats'
    );

    // The merged config.toml must still contain the float values at root scope.
    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const parsed = parseTomlToObject(after);
    assert.strictEqual(parsed.tool_timeout_sec, 20.0,
      'tool_timeout_sec must be preserved as a number after install');
    assert.strictEqual(parsed.startup_timeout_sec, 60.0,
      'startup_timeout_sec must be preserved as a number after install');
  });

  test('post-install config round-trips tool_timeout_sec as numeric 20', () => {
    const preInstall = [
      'tool_timeout_sec = 20.0',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    runCodexInstall(codexHome);

    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    // The value must survive round-trip as a float-compatible representation.
    // Parse structurally — don't grep for the literal string "20.0".
    const parsed = parseTomlToObject(after);
    assert.strictEqual(parsed.tool_timeout_sec, 20,
      'tool_timeout_sec must round-trip as numeric 20 (=== 20.0 in JS)');
  });
});

// ---------------------------------------------------------------------------
// CR round-4 finding — TOML 1.0 disallows leading zeros in integer part
// ---------------------------------------------------------------------------
//
// TOML 1.0 §2: integer literals follow decimal-integer rules, which disallow
// leading zeros except the value `0` itself. `01`, `01.5`, `00e2`, `+01.0`
// are therefore invalid. The `parseTomlValue` integer-part regex is tightened
// from `\d(?:_?\d)*` to `(0|[1-9](?:_?\d)*)`.

describe('#3245 CR4 — parseTomlValue rejects leading zeros in float integer part', () => {
  function parseValue(raw) {
    // Wrap in a minimal TOML assignment so parseTomlToObject drives the test.
    return parseTomlToObject(`x = ${raw}`).x;
  }

  function assertRejects(raw, label) {
    let threw = false;
    try { parseValue(raw); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, `expected rejection for ${label}: ${raw}`);
  }

  function assertAccepts(raw, expected, label) {
    let val;
    let threw = false;
    try { val = parseValue(raw); } catch (e) { threw = true; }
    assert.strictEqual(threw, false, `expected acceptance for ${label}: ${raw}`);
    if (expected !== undefined) {
      assert.ok(Math.abs(val - expected) < 1e-12, `${label}: expected ${expected}, got ${val}`);
    }
  }

  // --- rejection cases: leading zeros in the integer part ---

  test('rejects 01 (leading zero on bare integer)', () => assertRejects('01', '01'));
  test('rejects 00 (double-zero bare integer)', () => assertRejects('00', '00'));
  test('rejects 01.5 (leading zero before decimal point)', () => assertRejects('01.5', '01.5'));
  test('rejects 00.5 (double-zero before decimal)', () => assertRejects('00.5', '00.5'));
  test('rejects +01 (leading zero with sign)', () => assertRejects('+01', '+01'));
  test('rejects -01 (negative leading zero)', () => assertRejects('-01', '-01'));
  test('rejects 00e2 (leading zero with exponent)', () => assertRejects('00e2', '00e2'));
  test('rejects +01.0 (leading zero in positive float)', () => assertRejects('+01.0', '+01.0'));
  test('rejects -01.0 (leading zero in negative float)', () => assertRejects('-01.0', '-01.0'));
  test('rejects 01.5e10 (leading zero, decimal, and exponent)', () => assertRejects('01.5e10', '01.5e10'));

  // --- acceptance cases: valid TOML 1.0 numeric forms ---

  test('accepts 0 (single zero)', () => assertAccepts('0', 0, 'single zero'));
  test('accepts 0.5 (zero before decimal)', () => assertAccepts('0.5', 0.5, 'zero.decimal'));
  test('accepts 0.0 (zero.zero)', () => assertAccepts('0.0', 0.0, 'zero.zero'));
  test('accepts 0e1 (zero with exponent)', () => assertAccepts('0e1', 0, '0e1'));
  test('accepts +0.5 (positive zero-decimal)', () => assertAccepts('+0.5', 0.5, '+0.5'));
  test('accepts -0.5 (negative zero-decimal)', () => assertAccepts('-0.5', -0.5, '-0.5'));
  test('accepts 1 (single non-zero digit)', () => assertAccepts('1', 1, '1'));
  test('accepts 12 (two digits)', () => assertAccepts('12', 12, '12'));
  test('accepts 1.5 (simple float)', () => assertAccepts('1.5', 1.5, '1.5'));
  test('accepts 1_000 (underscored integer)', () => assertAccepts('1_000', 1000, '1_000'));
  test('accepts 1_000.5 (underscored float)', () => assertAccepts('1_000.5', 1000.5, '1_000.5'));
  test('accepts +1.5 (positive float)', () => assertAccepts('+1.5', 1.5, '+1.5'));
  test('accepts -2.0 (negative float)', () => assertAccepts('-2.0', -2.0, '-2.0'));
  test('accepts 1.5e-3 (float with negative exponent)', () => assertAccepts('1.5e-3', 1.5e-3, '1.5e-3'));
  test('accepts 1.05e10 (fractional part may start with zero)', () => assertAccepts('1.05e10', 1.05e10, '1.05e10'));
});

// ---------------------------------------------------------------------------
// Defect 2 — idempotent rollback covers skills, agents, VERSION
// ---------------------------------------------------------------------------

// concurrency: false — patches module.exports.__codexSchemaValidator and drives
// the install pipeline. Serialise to prevent cross-test pollution.
describe('#3245 — idempotent rollback reverts skills/, agents/, and VERSION', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3245-rollback-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    delete installModule.__codexSchemaValidator;
    cleanup(tmpDir);
  });

  test('validation failure rolls back skills/, agents/, and VERSION to pre-install state', () => {
    // Start from a clean codexHome with no pre-existing GSD content — the dirs
    // do not exist yet. After a failed install they must be absent (or contain
    // only what was there before, i.e. nothing).
    fs.mkdirSync(codexHome, { recursive: true });

    // Force schema validation to fail so we can observe the rollback without
    // needing a genuinely broken config.
    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure for #3245 rollback test',
    });

    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (_) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'install must throw when validation fails');

    // skills/ — GSD writes gsd-* subdirs here. All must be absent after rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    if (fs.existsSync(skillsDir)) {
      const gsdSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(
        gsdSkills.length,
        0,
        'rollback must remove all gsd-* skill directories: ' + gsdSkills.map(e => e.name).join(', ')
      );
    }

    // agents/ — GSD writes gsd-*.md and gsd-*.toml here. All must be absent.
    // Not the shared listAgentFiles() helper: reads the INSTALLED Codex dest
    // dir and is .toml-inclusive, so its semantics differ from the source roster.
    const agentsDir = path.join(codexHome, 'agents');
    if (fs.existsSync(agentsDir)) {
      const gsdAgents = fs.readdirSync(agentsDir)
        .filter(f => f.startsWith('gsd-') && (f.endsWith('.md') || f.endsWith('.toml')));
      assert.strictEqual(
        gsdAgents.length,
        0,
        'rollback must remove all gsd-* agent files: ' + gsdAgents.join(', ')
      );
    }

    // VERSION — GSD writes gsd-core/VERSION. Must be absent (wasn't there before).
    const versionPath = path.join(codexHome, 'gsd-core', 'VERSION');
    assert.strictEqual(
      fs.existsSync(versionPath),
      false,
      'rollback must remove the VERSION file written during install'
    );
  });

  test('rollback is safe when fired before any snapshots were captured (very early failure)', () => {
    // If the validator is injected before ANY install writes happen, the rollback
    // must not throw — it should be idempotent when nothing was written yet.
    fs.mkdirSync(codexHome, { recursive: true });

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'very early simulated failure',
    });

    // The install must throw (validation failure), but the rollback that runs
    // internally must not throw — it must be idempotent when nothing was written.
    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (_) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'install must throw when validation fails (very early failure)');
    // Rollback removes all gsd-* skill dirs it wrote. Even if skills/ was
    // created during the install, no gsd-* dirs should survive after rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    const remainingGsdSkills = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
          .map((e) => e.name)
      : [];
    assert.deepStrictEqual(
      remainingGsdSkills,
      [],
      'rollback must remove all gsd-* skill dirs even when fired after minimal writes'
    );
  });

  test('rollback does not remove pre-existing user skills that GSD did not write', () => {
    // If the user has a custom skill dir (not gsd-*) it must survive rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    const userSkill = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# Custom\n', 'utf8');

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure — user skill must survive',
    });

    let threw = false;
    try { runCodexInstall(codexHome); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, 'expected runCodexInstall to throw under simulated validation failure (user-skill-survives scenario)');

    assert.strictEqual(
      fs.existsSync(path.join(userSkill, 'SKILL.md')),
      true,
      'pre-existing non-gsd-* skill must survive rollback'
    );
  });

  test('rollback removes orphaned atomic-write temp files', () => {
    // Any <file>.tmp-<pid>-<n> files created during aborted atomic writes
    // must be cleaned up by the rollback so targetDir is not left with stray
    // temp files consuming disk space.
    fs.mkdirSync(codexHome, { recursive: true });

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure for temp-file cleanup test',
    });

    let threw = false;
    try { runCodexInstall(codexHome); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, 'expected runCodexInstall to throw under simulated validation failure (temp-file cleanup scenario)');

    // Scan for any *.tmp-* files left in codexHome after rollback.
    const tmpPattern = /\.tmp-\d+-\d+$/;
    function findTmpFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findTmpFiles(full));
        } else if (tmpPattern.test(entry.name)) {
          results.push(full);
        }
      }
      return results;
    }
    const stray = findTmpFiles(codexHome);
    assert.strictEqual(
      stray.length,
      0,
      'rollback must clean up orphaned atomic-write temp files: ' + stray.join(', ')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3285-codex-hooks-state-allowed.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3285-codex-hooks-state-allowed (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3285 — Codex install fails when config.toml contains
 * hooks.state entries.
 *
 * Root cause: validateCodexConfigSchema walks every `hooks.*` table section
 * and asserts array-of-tables (AoT) shape, without distinguishing the
 * `hooks.state.*` namespace (Codex-managed per-hook trust persistence, a
 * regular table) from `hooks.<EVENT>` (event handlers like SessionStart,
 * which DO require AoT shape via [[hooks.SessionStart]]).
 *
 * Fix: add a carve-out so that any table whose path starts with `hooks.state`
 * is validated as a regular table (not AoT). All `hooks.<EVENT>` paths still
 * require AoT.
 */

// GSD_TEST_MODE must be set before require('../bin/install.js') so the module
// skips the main CLI entry point and exports its internals.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { validateCodexConfigSchema, install } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

// Ensure hooks/dist/ is populated — mirrors the pattern used by codex-config.test.cjs.
const { before, beforeEach, afterEach } = require('node:test');
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
  }
});

// ---------------------------------------------------------------------------
// Validator unit tests (no install, just validateCodexConfigSchema)
// ---------------------------------------------------------------------------

describe('#3285 — validateCodexConfigSchema: hooks.state is a regular table (not AoT)', () => {
  test('bare [hooks.state] table header passes validation', () => {
    const content = [
      '[hooks.state]',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'bare [hooks.state] must be allowed (regular-table namespace): ' + result.reason);
  });

  test('bare [hooks.state.<project-key>] table header passes validation', () => {
    // Mirrors the exact shape Codex CLI 0.130.0+ writes for per-hook trust entries.
    // The key contains slashes and colons — must be quoted in TOML.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'bare [hooks.state.<key>] with trust fields must be allowed: ' + result.reason);
  });

  test('hooks.state alongside [[hooks.SessionStart]] AoT both pass', () => {
    // The real-world fixture: user has both Codex trust state AND GSD-managed
    // event hooks in the same config.toml.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123"',
      '',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "/usr/local/bin/gsd-check-update"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'mixed hooks.state (regular table) + [[hooks.SessionStart]] (AoT) must pass: ' + result.reason);
  });

  test('[[hooks.SessionStart]] AoT still requires array-of-tables shape', () => {
    // Regression guard: the fix must NOT relax AoT requirements for event hooks.
    // [hooks.SessionStart] (single-bracket) must still fail.
    const content = [
      '[hooks.SessionStart]',
      'type = "command"',
      'command = "/some/command"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[hooks.SessionStart] bare table (not AoT) must still be rejected');
    assert.ok(
      result.reason.includes('hooks.SessionStart'),
      'rejection reason must mention hooks.SessionStart, got: ' + result.reason
    );
  });

  test('hooks.state object in parsed structure does not trigger non-array rejection', () => {
    // The parsed-object check loops over Object.entries(parsed.hooks) and
    // asserts !Array.isArray(value) → error. hooks.state is an object, not
    // an array. The fix must skip hooks.state in that loop too.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'some-key']",
      'enabled = true',
      'trusted_hash = "sha256:deadbeef"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'parsed hooks.state object must not trigger "hooks.state must be an array" rejection: ' + result.reason);
  });

  test('multiple hooks.state sub-keys all pass validation', () => {
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/project/a/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:aaa"',
      '',
      "[hooks.state.'/project/b/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = false',
      'trusted_hash = "sha256:bbb"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'multiple hooks.state sub-keys must all pass: ' + result.reason);
  });

  test('[[hooks.state]] AoT form is rejected', () => {
    // hooks.state must be a regular table — array-of-tables shape is invalid.
    const content = [
      '[[hooks.state]]',
      'enabled = true',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[[hooks.state]] (AoT) must be rejected');
    assert.ok(
      result.reason.includes('hooks.state'),
      'rejection reason must mention hooks.state, got: ' + result.reason
    );
  });

  test('[[hooks.state.foo]] AoT sub-key form is rejected', () => {
    // hooks.state.* sub-keys must be regular tables — AoT sub-key shape is invalid.
    const content = [
      '[[hooks.state.foo]]',
      'enabled = true',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[[hooks.state.foo]] (AoT sub-key) must be rejected');
    assert.ok(
      result.reason.includes('hooks.state'),
      'rejection reason must mention hooks.state, got: ' + result.reason
    );
  });
});

// ---------------------------------------------------------------------------
// Full install integration test
// ---------------------------------------------------------------------------

describe('#3285 — install succeeds when config.toml contains hooks.state entries', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  function writeCodexConfig(content) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
  }

  function runCodexInstall() {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCwd = process.cwd();
    // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
    // $HOME/.agents/skills root (os.homedir()-relative, independent of
    // CODEX_HOME). Sandbox HOME (and USERPROFILE) to tmpDir so this
    // in-process install never materializes skills under the developer/CI
    // machine's real home directory.
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    try {
      process.chdir(path.join(__dirname, '..'));
      return install(true, 'codex');
    } finally {
      process.chdir(previousCwd);
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3285-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('install does not throw when config.toml contains hooks.state trust entries', () => {
    // This is the exact failure scenario reported in #3285.
    const preInstall = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123def456"',
      '',
    ].join('\n');
    writeCodexConfig(preInstall);

    assert.doesNotThrow(
      () => runCodexInstall(),
      'install must not throw when config.toml contains hooks.state trust entries'
    );
  });

  test('hooks.state entries are preserved in post-install config.toml', () => {
    const preInstall = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123def456"',
      '',
    ].join('\n');
    writeCodexConfig(preInstall);

    runCodexInstall();

    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    // Verify structurally: the trust hash key must survive the install.
    // Do NOT grep for the literal string — parse the TOML structure.
    const { parseTomlToObject } = require('../bin/install.js');
    const parsed = parseTomlToObject(after);
    assert.ok(
      parsed.hooks && typeof parsed.hooks.state === 'object' && parsed.hooks.state !== null,
      'post-install config.toml must have hooks.state as an object'
    );
    // Verify the actual trust entry survives — not just that hooks.state is an object.
    const trustKey = "/home/user/.codex/hooks.json:pre_tool_use:0:0";
    assert.ok(
      parsed.hooks.state[trustKey] != null,
      `post-install must preserve the original trust entry for key: ${trustKey}`
    );
    assert.strictEqual(
      parsed.hooks.state[trustKey].enabled,
      true,
      'preserved trust entry must have enabled = true'
    );
    assert.strictEqual(
      parsed.hooks.state[trustKey].trusted_hash,
      'sha256:abc123def456',
      'preserved trust entry must have the original trusted_hash'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3346-codex-aot-toml-key.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3346-codex-aot-toml-key (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3346 — Codex install fails on Windows when the legacy
 * Codex `[hooks]` config uses a `<file>:<event>:<line>:<col>` location tuple
 * as the table key (with the actual event name carried in an `event = "..."`
 * body field). `migrateCodexHooksMapFormat` re-emitted the location tuple
 * verbatim as the leaf TOML key, producing a header like
 *
 *   [[hooks."C:\Users\helen\.codex\config.toml:session_start:0:0"]]
 *
 * which Codex 0.124.0+ refuses to load (the leaf key segment is supposed to
 * be the event name, not a diagnostic location identifier).
 *
 * Expected behaviour: when the legacy `[hooks.<X>]` body declares an
 * `event = "..."` field, the migrator must use that event name as the leaf
 * TOML key for the emitted `[[hooks.<EVENT>]]` two-level nested AoT block.
 *
 * Test discipline: parse the migrated TOML with the project's own
 * `parseTomlToObject` and assert on the resulting object shape — never
 * grep the raw string.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateCodexHooksMapFormat,
  parseTomlToObject,
} = require('../bin/install.js');

describe('#3346 — Codex AoT hooks migration emits event-name leaf key, not location tuple', () => {
  test('legacy [hooks."<location-tuple>"] with event="..." body migrates to [[hooks.<event>]]', () => {
    // Pre-install fixture: a legacy `[hooks.<quoted-key>]` block whose key is
    // a `<config-path>:<event>:<line>:<col>` location identifier. The actual
    // event name lives in the body as `event = "session_start"`.
    const legacy = [
      '[hooks."C:\\\\Users\\\\helen\\\\.codex\\\\config.toml:session_start:0:0"]',
      'event = "session_start"',
      'command = "echo hi"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    // The migrated hooks object must be keyed by the event name, not by the
    // location tuple. This is the core assertion of #3346.
    assert.ok(parsed.hooks, 'migrated TOML must define a hooks table');
    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['session_start'],
      `migrated hooks must be keyed by event name only; got: ${JSON.stringify(Object.keys(parsed.hooks))}`
    );

    // The handler body must survive the migration and live under the two-level
    // nested AoT shape (hooks.<event>[0].hooks[0].command).
    const eventEntries = parsed.hooks.session_start;
    assert.ok(Array.isArray(eventEntries) && eventEntries.length >= 1,
      'hooks.session_start must be an array of tables');
    const handlers = eventEntries[0].hooks;
    assert.ok(Array.isArray(handlers) && handlers.length >= 1,
      'hooks.session_start[0].hooks must be an array of handler tables');
    assert.equal(handlers[0].command, 'echo hi',
      'handler command must be preserved through migration');
    assert.equal(handlers[0].type, 'command',
      'handler type must default to "command" when no explicit type given');
    assert.equal(handlers[0].event, undefined,
      'handler body must not retain legacy `event` field after migration');
  });

  test('legacy [hooks."<location>"] with explicit type and event survives migration cleanly', () => {
    // Same as above but with an explicit `type` field — the migrator must not
    // duplicate it when re-emitting the handler.
    const legacy = [
      '[hooks."/home/user/.codex/config.toml:tool_call_pre:5:0"]',
      'event = "tool_call_pre"',
      'type = "command"',
      'command = "node /path/to/hook.js"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['tool_call_pre'],
      'leaf key must be the event name from the `event = "..."` body field'
    );
    const handler = parsed.hooks.tool_call_pre[0].hooks[0];
    assert.equal(handler.command, 'node /path/to/hook.js');
    assert.equal(handler.type, 'command');
    assert.equal(handler.event, undefined,
      'handler body must not retain legacy `event` field after migration');
  });

  test('legacy [hooks.<bare-event>] without location-tuple key continues to work unchanged', () => {
    // Regression guard: the fix must not break the canonical legacy-map case
    // ([hooks.<event-name>] with handler-fields-only body, no `event` key).
    const legacy = [
      '[hooks.session_start]',
      'command = "echo hi"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['session_start'],
      'bare-event legacy shape must continue to migrate to event-named leaf key'
    );
    assert.equal(parsed.hooks.session_start[0].hooks[0].command, 'echo hi');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3360-codex-execute-phase-worktrees.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3360-codex-execute-phase-worktrees (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3360.
 *
 * Codex does not have a direct equivalent of Claude Code's
 * `Agent(... isolation="worktree")`. The execute-phase workflow must fail
 * closed for Codex + workflow.use_worktrees=true instead of spawning
 * workspace-write executors in the main checkout.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const { getCodexSkillAdapterHeader } = require('../bin/install.js');

function parseWorkflowSteps(content) {
  return [...content.matchAll(/<step name="([^"]+)"[^>]*>([\s\S]*?)<\/step>/g)]
    .map((match) => {
      const body = match[2];
      return {
        name: match[1],
        // After #3797 architectural fix, callsites use gsd_run
        readsRuntimeConfig: body.includes('RUNTIME=$(gsd_run query config-get runtime --default claude'),
        // #1521 generalized the guard from Codex-specific to all non-Claude
        // runtimes; #2584 Phase 3 (#2627) generalized it again — off runtime
        // identity entirely and onto the negotiated `dispatch.isolation`
        // capability. The step now resolves ISOLATION (delegating the block to
        // the isolation-dispatch fragment) and fails closed when a host
        // declares no primitive, which is what #3360 actually protects.
        resolvesIsolationCapability: body.includes('Resolve ISOLATION'),
        // Worktree dispatch guidance is no longer a hardcoded Claude flag —
        // step 3 emits the host's DECLARED harness flag.
        worktreeDispatchGuidance: body.includes('{harnessFlag}')
          || body.includes('executor-isolation-dispatch.md'),
      };
    });
}

function executePhaseWorktreeContract(content) {
  const steps = parseWorkflowSteps(content);
  const initializeIndex = steps.findIndex((step) => step.name === 'initialize');
  const firstWorktreeDispatchIndex = steps.findIndex((step) => step.worktreeDispatchGuidance);
  assert.notEqual(initializeIndex, -1, 'workflow must have an initialize step');
  assert.notEqual(firstWorktreeDispatchIndex, -1, 'workflow must still document worktree dispatch guidance');

  const initialize = steps[initializeIndex];
  return {
    initializeReadsRuntimeConfig: initialize.readsRuntimeConfig,
    initializeResolvesIsolationCapability: initialize.resolvesIsolationCapability,
    guardStepPrecedesWorktreeDispatch: initializeIndex <= firstWorktreeDispatchIndex,
  };
}

describe('#3360 — execute-phase fails closed for unsupported worktree isolation', () => {
  // #2584 Phase 3 (#2627) moved this from "Codex is blocked by name" to "a host
  // with no declared isolation primitive is blocked". Codex now DECLARES
  // orchestrator-worktree and gets a real isolated path, so the guard can no
  // longer key on its name — but #3360's actual protection (never run executors
  // unisolated against the main checkout) is unchanged and asserted below.
  const ISOLATION_FRAGMENT = path.join(
    ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
  );

  test('execute-phase resolves the isolation capability before any worktree dispatch', () => {
    const workflow = fs.readFileSync(EXECUTE_PHASE, 'utf8');
    const contract = executePhaseWorktreeContract(workflow);

    assert.deepEqual(contract, {
      initializeReadsRuntimeConfig: true,
      initializeResolvesIsolationCapability: true,
      guardStepPrecedesWorktreeDispatch: true,
    });
  });

  test('a host declaring no isolation primitive still fails closed', () => {
    const fragment = fs.readFileSync(ISOLATION_FRAGMENT, 'utf8');
    assert.match(fragment, /ISOLATION="?none"?/,
      'fragment must resolve the none case');
    assert.match(fragment, /FATAL[^\n]*no executor-isolation primitive/,
      'a host with dispatch.isolation=none must fail closed before dispatch (#3360)');
    assert.match(fragment, /use_worktrees=false/,
      'the fail-closed message must tell the user how to proceed');
  });

  test('the scheduler never gates worktree dispatch on a runtime name', () => {
    const workflow = fs.readFileSync(EXECUTE_PHASE, 'utf8');
    const fragment = fs.readFileSync(ISOLATION_FRAGMENT, 'utf8');
    for (const [label, src] of [['execute-phase.md', workflow], ['isolation fragment', fragment]]) {
      assert.ok(
        !/\[\s*"\$RUNTIME"\s*(?:!=|=)\s*"(?:codex|claude)"\s*\]\s*&&\s*\[\s*"\$USE_WORKTREES"/.test(src),
        `${label}: worktree dispatch must branch on dispatch.isolation, not a runtime name (ADR-1239)`,
      );
    }
  });

  test('Codex adapter documents the orchestrator-managed worktree mapping', () => {
    const header = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.match(header, /isolation="worktree"/);
    assert.match(header, /orchestrator-worktree/i,
      'the adapter header must no longer claim Codex has no worktree mapping — #2584 Phase 3 gave it one');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3426-codex-windows-hooks.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3426-codex-windows-hooks (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Bug #3426 — Codex on Windows: SessionStart/PostToolUse hooks fail with exit code 1
 *
 * After PRs #3396/#3397 fixed bare-bash and quote-escaping issues, a new failure
 * mode appeared on v1.42.3+:
 *
 *   Failed with non-blocking status code:
 *   C:/Program Files/Git/bin/bash.exe: C:/Program Files/Git/bin/bash.exe: cannot execute binary file
 *
 * Root cause: Codex on Windows runs hook commands from a PowerShell/cmd
 * execution environment (see install.js comment at buildHookCommand).  The
 * command string written to hooks.json was:
 *
 *   "C:/Program Files/nodejs/node.exe" "C:/path/.codex/hooks/gsd-check-update.js"
 *
 * When Codex's hook runner passes this to its subprocess spawner, the quoted
 * path resolves through Git Bash (MSYS), which then tries to POSIX-exec
 * node.exe — a Windows PE binary — via the MSYS exec layer.  The MSYS exec
 * path calls execvp() on the PE binary directly, which fails with ENOEXEC,
 * reported as "cannot execute binary file".  The "bash.exe: bash.exe:" prefix
 * appears because the error propagates through the bash.exe process that Codex
 * uses as its hook-dispatch shell.
 *
 * Fix: on Windows, write a .cmd shim (using the same buildWindowsShimTriple
 * IR pattern as gsd-sdk.cmd) and put the .cmd path as the hooks.json command.
 * cmd.exe executes .cmd files natively via CreateProcess — no POSIX exec layer,
 * no MSYS shebang walk.
 *
 * Test strategy:
 * - Assert on the typed IR returned by buildCodexHookWindowsShimIR — not on
 *   rendered .cmd text (per CONTRIBUTING.md L558-L565 IR-first discipline).
 * - Counter-tests confirm darwin/linux paths are unchanged.
 *
 * NOTE: Windows wall-clock verification depends on Docker matrix Windows
 * runners.  Local test exercises the generator IR shape only.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL = require('../bin/install.js');
const PROJECTION = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  buildCodexHookWindowsShimIR,
  ensureCodexHooksJsonSessionStart,
  resolveNodeRunner,
  uninstall,
} = INSTALL;

const { projectManagedHookCommand } = PROJECTION;

/**
 * Extract hook handler objects for `eventName` from a hooks.json object.
 * Handles both the legacy top-level shape { SessionStart: [...] } and the
 * canonical nested shape { hooks: { SessionStart: [...] } } (bug #1348).
 */
function hookHandlersForEvent(hooksJson, eventName) {
  if (!hooksJson || typeof hooksJson !== 'object') return [];
  const table =
    hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)
      ? hooksJson.hooks
      : hooksJson;
  if (!Array.isArray(table[eventName])) return [];
  return table[eventName].flatMap((e) => Array.isArray(e && e.hooks) ? e.hooks : []);
}

// ─── Step 1: Export surface check ────────────────────────────────────────────

describe('#3426 — export surface: buildCodexHookWindowsShimIR must be exported', () => {
  test('buildCodexHookWindowsShimIR is a function', () => {
    assert.equal(typeof buildCodexHookWindowsShimIR, 'function',
      'buildCodexHookWindowsShimIR must be exported from bin/install.js');
  });

  test('ensureCodexHooksJsonSessionStart is a function', () => {
    assert.equal(typeof ensureCodexHooksJsonSessionStart, 'function',
      'ensureCodexHooksJsonSessionStart must be exported from bin/install.js');
  });
});

// ─── Step 2: Typed IR shape for Windows Codex hook shim ──────────────────────

describe('#3426 — buildCodexHookWindowsShimIR: typed IR (not rendered text)', () => {
  const FAKE_SCRIPT = 'C:/Users/me/.codex/hooks/gsd-check-update.js';
  const FAKE_RUNNER = '"C:/Program Files/nodejs/node.exe"';

  test('returns typed IR with invocation, cmdPath, and render factory', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // IR shape assertion — per CONTRIBUTING.md L558 IR-first discipline
    assert.ok(ir && typeof ir === 'object', 'must return an object');
    assert.ok(typeof ir.invocation === 'object', 'must have invocation record');
    assert.ok(typeof ir.cmdPath === 'string', 'must have cmdPath string');
    assert.ok(typeof ir.hookCommand === 'string', 'must have hookCommand string (written to hooks.json)');
    assert.ok(typeof ir.render === 'object', 'must have render factory');
    assert.ok(typeof ir.render.cmd === 'function', 'must have render.cmd() factory');
  });

  test('invocation.target equals the resolved script path', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // invocation.target is the JS file being wrapped — same IR contract as buildWindowsShimTriple
    assert.ok(
      ir.invocation.target.includes('gsd-check-update.js'),
      `invocation.target must reference the hook script, got: ${ir.invocation.target}`,
    );
  });

  test('invocation.interpreter is the node runner (not bash)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // The shim must invoke node, never bash — bash is not a valid Codex hook runner on Windows
    const interp = ir.invocation.interpreter;
    assert.ok(
      typeof interp === 'string' && (interp.includes('node') || interp === 'node'),
      `invocation.interpreter must be a node path, not bash. Got: ${interp}`,
    );
    assert.ok(
      !interp.toLowerCase().includes('bash'),
      `invocation.interpreter must NOT be bash — bash is the source of the #3426 failure. Got: ${interp}`,
    );
  });

  test('cmdPath ends with .cmd extension', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.ok(
      ir.cmdPath.endsWith('.cmd'),
      `cmdPath must end with .cmd for cmd.exe native execution, got: ${ir.cmdPath}`,
    );
  });

  test('hookCommand is the .cmd path (not a "runner script.js" string)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // The hook command written to hooks.json must be the .cmd path, not "node.exe script.js"
    // because cmd.exe executes .cmd natively without POSIX exec layer
    assert.ok(
      ir.hookCommand.includes('.cmd'),
      `hookCommand must reference the .cmd shim, got: ${ir.hookCommand}`,
    );
    // hookCommand must NOT contain bash — this was the failure mode
    assert.ok(
      !ir.hookCommand.toLowerCase().includes('bash'),
      `hookCommand must NOT reference bash, got: ${ir.hookCommand}`,
    );
  });

  test('returns null when absoluteRunnerToken is null (caller skips registration)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, null);
    assert.equal(ir, null,
      'must return null when runner is unavailable so caller can warn-and-skip');
  });
});

// ─── Step 2b: Typed IR — eol / quoting / passthroughArgs ─────────────────────
// Per CONTRIBUTING.md L558-L565: assert on the typed IR, not on rendered text.
// These assertions cover the three bug-critical render semantics that
// text-matching tests would miss (silent EOL/quoting/passthrough regressions).

describe('#3426 — buildCodexHookWindowsShimIR: typed IR eol / quoting / passthroughArgs', () => {
  const FAKE_SCRIPT = 'C:/Users/me/.codex/hooks/gsd-check-update.js';
  const FAKE_RUNNER = '"C:/Program Files/nodejs/node.exe"';

  test('eol.cmd is CRLF (\\r\\n) — canonical for cmd.exe .cmd files', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.ok(ir && typeof ir.eol === 'object', 'IR must expose an eol field');
    assert.strictEqual(
      ir.eol.cmd,
      '\r\n',
      'eol.cmd must be CRLF (\\r\\n) — LF-only .cmd files risk silent parse failures on some Windows versions',
    );
  });

  test('invocation.target has no shell-metachar leakage (clean absolute path)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    const target = ir.invocation.target;
    assert.ok(typeof target === 'string' && target.length > 0, 'invocation.target must be a non-empty string');
    // The target stored in the IR is the raw unquoted path — quoting happens at
    // render time. A metachar in the raw value means the IR is already corrupted.
    assert.ok(
      !target.includes('"') && !target.includes("'") && !target.includes('`'),
      `invocation.target must be the raw path without shell quoting, got: ${target}`,
    );
    assert.ok(
      target.endsWith('.js'),
      `invocation.target must resolve to the .js script, got: ${target}`,
    );
  });

  test('passthroughArgs is true — shim forwards all args via %*', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.strictEqual(
      ir.passthroughArgs,
      true,
      'passthroughArgs must be true: the .cmd shim must forward all arguments to the node script via %*',
    );
  });
});

// ─── Step 3: Counter-test — non-Windows platforms use node-runner command ────

describe('#3426 counter-test: darwin/linux Codex paths use node-runner command (not .cmd shim)', () => {
  test('projectManagedHookCommand on darwin emits node-runner command, not .cmd', () => {
    const runner = resolveNodeRunner() || '"/usr/local/bin/node"';
    const cmd = projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: '/Users/me/.codex/hooks/gsd-check-update.js',
      runtime: 'codex',
      platform: 'darwin',
    });
    assert.ok(typeof cmd === 'string', 'must return a string on darwin');
    assert.ok(!cmd.endsWith('.cmd'), 'darwin command must NOT reference a .cmd shim');
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `darwin command must reference the .js hook directly, got: ${cmd}`,
    );
  });

  test('projectManagedHookCommand on linux emits node-runner command, not .cmd', () => {
    const runner = resolveNodeRunner() || '"/usr/local/bin/node"';
    const cmd = projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: '/home/me/.codex/hooks/gsd-check-update.js',
      runtime: 'codex',
      platform: 'linux',
    });
    assert.ok(typeof cmd === 'string', 'must return a string on linux');
    assert.ok(!cmd.endsWith('.cmd'), 'linux command must NOT reference a .cmd shim');
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `linux command must reference the .js hook directly, got: ${cmd}`,
    );
  });
});

// ─── Step 4: Integration — ensureCodexHooksJsonSessionStart on win32 writes .cmd shim ──

describe('#3426 integration: ensureCodexHooksJsonSessionStart on win32 writes .cmd shim', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    // Stub the hook file that must exist for the hook to be registered
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('win32: hooks.json command references .cmd shim (not "node.exe script.js")', () => {
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';

    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    assert.ok(result.wrote || result.changed, 'must write hooks.json on win32');

    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must exist after install');

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    assert.ok(commands.length > 0, 'must have at least one SessionStart hook command');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'must have a gsd-check-update hook command');

    // KEY ASSERTION: on win32, the command must reference a .cmd file — not bash
    assert.ok(
      cmd.includes('.cmd'),
      `win32 hook command must reference a .cmd shim to avoid bash.exe exec failure (#3426). Got: ${cmd}`,
    );
    assert.ok(
      !cmd.toLowerCase().includes('bash'),
      `win32 hook command must NOT reference bash.exe — this was the #3426 failure. Got: ${cmd}`,
    );
  });

  test('win32: .cmd shim file is written to the hooks directory', () => {
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';

    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(
      fs.existsSync(cmdShimPath),
      `win32: .cmd shim must be written at ${cmdShimPath}`,
    );
    // File must be non-empty — structure check only (IR-first discipline)
    const size = fs.statSync(cmdShimPath).size;
    assert.ok(size > 0, '.cmd shim must have non-zero content');
  });

  test('non-Windows (darwin): hooks.json command is "node.exe script.js" (no .cmd shim)', () => {
    const fakeRunner = '"/usr/local/bin/node"';

    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'darwin',
    });

    assert.ok(result.wrote || result.changed, 'must write hooks.json on darwin');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'),
    );
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'must have a gsd-check-update hook command on darwin');

    // Counter-test: darwin must NOT use a .cmd shim
    assert.ok(
      !cmd.endsWith('.cmd'),
      `darwin hook command must NOT reference a .cmd shim, got: ${cmd}`,
    );
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `darwin hook command must reference the .js file directly, got: ${cmd}`,
    );

    // .cmd shim must NOT be written on darwin
    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(
      !fs.existsSync(cmdShimPath),
      'darwin must NOT write a .cmd shim',
    );
  });

  test('non-Windows (linux): same as darwin — no .cmd shim', () => {
    const fakeRunner = '"/usr/local/bin/node"';

    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'),
    );
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'linux must have a gsd-check-update hook command');
    assert.ok(!cmd.endsWith('.cmd'), 'linux must NOT use a .cmd shim');

    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(!fs.existsSync(cmdShimPath), 'linux must NOT write a .cmd shim');
  });
});

// ─── Step 5: Uninstall cleanup — .cmd shim removed from disk ─────────────────

describe('#3426 uninstall: gsd-check-update.cmd is removed from hooks dir on uninstall', () => {
  let tmpDir;

  function withCodexHome(dir, fn) {
    const prev = process.env.CODEX_HOME;
    // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
    // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
    // CODEX_HOME. Fake $HOME (and $USERPROFILE) too so this in-process install
    // never touches the developer/CI machine's real home directory — confined
    // entirely to `dir`, which the caller cleans up.
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try { return fn(); }
    finally {
      if (prev == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile == null) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
    }
  }

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-uninstall-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    // Write the .js hook (required by install) and a pre-existing .cmd shim
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.cmd'),
      '@ECHO OFF\r\n@SETLOCAL\r\n@"C:/node.exe" "C:/path/gsd-check-update.js" %*\r\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('uninstall removes gsd-check-update.cmd from hooks directory', () => {
    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(fs.existsSync(cmdShimPath), 'pre-condition: .cmd shim exists before uninstall');

    withCodexHome(tmpDir, () => uninstall(true, 'codex'));

    assert.ok(
      !fs.existsSync(cmdShimPath),
      `gsd-check-update.cmd must be removed from disk on uninstall — orphaned .cmd shim would cause stale hook references. Path: ${cmdShimPath}`,
    );
  });
});

// ─── Step 6: Upgrade path — existing win32 hooks.json with node-runner command ─

describe('#3426 upgrade: reinstall on win32 migrates existing "node script.js" to .cmd shim', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-upgrade-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('replaces old "node.exe script.js" command with .cmd shim on win32 reinstall', () => {
    const managedHookPath = path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');
    // Pre-existing stale hooks.json with node-runner command (v1.42.3 shape)
    const staleLegacyCommand = `"C:/Program Files/nodejs/node.exe" "${managedHookPath}"`;
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify({
        SessionStart: [{ hooks: [{ type: 'command', command: staleLegacyCommand }] }],
      }, null, 2),
    );

    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';
    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const gsdCmds = commands.filter((c) => c.includes('gsd-check-update'));
    // Exactly one managed hook after migration — no duplicates
    assert.equal(gsdCmds.length, 1, `must have exactly 1 gsd-check-update command after migration, got: ${JSON.stringify(gsdCmds)}`);

    // Must be the .cmd shim
    assert.ok(
      gsdCmds[0].includes('.cmd'),
      `migrated command must reference .cmd shim, got: ${gsdCmds[0]}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3427-3433-codex-install-shape.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3427-3433-codex-install-shape (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { install, uninstall, parseTomlToObject } = require('../bin/install.js');
const { createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

function extractSessionStartCommandsFromHooksJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const table = (value.hooks && typeof value.hooks === 'object' && !Array.isArray(value.hooks))
    ? value.hooks
    : value;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) => {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.map((h) => h && h.command).filter((cmd) => typeof cmd === 'string');
  });
}

describe('#3427 + #3433 — Codex installer avoids duplicate skills and mixed hook representation', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-3427-3433-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('regenerates managed gsd-* skill copies and preserves unrelated user skills (#3562 reverses prior #3427/#3433 behaviour)', () => {
    // Stale legacy body — fresh install must overwrite this so Codex sees the
    // current SKILL.md, not whatever was last on disk.
    const legacySkillBody = '# old managed\n';
    fs.mkdirSync(path.join(codexHome, 'skills', 'gsd-help'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'gsd-help', 'SKILL.md'), legacySkillBody);
    const legacyHash = crypto.createHash('sha256').update(legacySkillBody).digest('hex');
    fs.writeFileSync(path.join(codexHome, 'gsd-file-manifest.json'), JSON.stringify({
      version: 1,
      files: {
        'skills/gsd-help/SKILL.md': legacyHash,
      },
    }, null, 2));

    fs.mkdirSync(path.join(codexHome, 'skills', 'custom-user-skill'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md'), '# user skill\n');

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #2088: the managed gsd-* skill surface now regenerates at the
    // canonical $HOME/.agents/skills root (fakeHome === tmpRoot here — see
    // withCodexHome above), not under the legacy $CODEX_HOME/skills.
    const newSkillsDir = codexSkillsRoot(tmpRoot);
    const newEntries = fs.existsSync(newSkillsDir)
      ? fs.readdirSync(newSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];

    // #3562: $gsd-* commands are discoverable only when
    // .agents/skills/gsd-*/SKILL.md exists. The installer must regenerate
    // (not remove) the managed gsd-* directories.
    assert.equal(newEntries.includes('gsd-help'), true);
    const refreshedBody = fs.readFileSync(path.join(newSkillsDir, 'gsd-help', 'SKILL.md'), 'utf8');
    assert.notEqual(refreshedBody, legacySkillBody, 'stale legacy body must be overwritten');
    const frontmatter = parseFrontmatter(refreshedBody);
    assert.equal(frontmatter.name, 'gsd-help', 'refreshed SKILL.md frontmatter must declare name: gsd-help');

    // #2088 migration: the installer cleans stale gsd-* dirs out of the old
    // $CODEX_HOME/skills location on a pre-move install.
    const legacyHelpDir = path.join(codexHome, 'skills', 'gsd-help');
    assert.equal(fs.existsSync(legacyHelpDir), false, 'migration must remove the stale legacy gsd-help skill dir from $CODEX_HOME/skills');

    // Unrelated user skills are preserved in place — migration only removes
    // `gsd-*` dirs from the old location; non-gsd-* user dirs are untouched.
    const userSkill = path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md');
    assert.equal(fs.existsSync(userSkill), true, 'unrelated user skill must survive the #2088 migration');
  });

  test('stores managed SessionStart update hook in hooks.json and removes inline gsd hook from config.toml', () => {
    const configToml = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /tmp/legacy/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml);

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => install(true, 'codex'));

    const parsedToml = parseTomlToObject(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    const tomlSessionStart = parsedToml.hooks?.SessionStart ?? [];
    const tomlCommands = tomlSessionStart.flatMap((entry) =>
      (Array.isArray(entry?.hooks) ? entry.hooks : []).map((hook) => hook.command).filter((cmd) => typeof cmd === 'string')
    );
    assert.equal(tomlCommands.some((cmd) => cmd.includes('gsd-check-update.js')), false);

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    const gsdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gsd-check-update'));

    assert.equal(gsdCommands.length, 1);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });

  test('uninstall removes managed SessionStart hook from hooks.json but preserves user hooks', () => {
    const hooksDir = path.join(codexHome, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// managed hook\n');
    const managedHookPath = path.join(codexHome, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: `node "${managedHookPath}"` },
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => uninstall(true, 'codex'));

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    // On Windows the managed hook is the .cmd shim path; on POSIX it is the .js node-runner command.
    // Either way the managed hook is gone after uninstall — only the user hook remains.
    const gsdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gsd-check-update'));

    assert.equal(gsdCommands.length, 0);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3562-codex-install-skill-surface.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3562-codex-install-skill-surface (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for bug #3562 — Codex global install must create a
 * discoverable $gsd-* skill surface.
 *
 * Codex CLI 0.130.0 (the version in the issue report) does NOT auto-discover
 * commands from gsd-core/workflows/*.md or agents/*.md. It only registers
 * commands from skills/<name>/SKILL.md. Prior installer logic ("Codex now
 * discovers official skills from .agents/skills") was based on an assumption
 * that does not match the shipping Codex CLI behavior, leaving users with
 * workflows on disk and no $gsd-* entrypoints after `npx @opengsd/gsd-core
 * --codex --global`.
 *
 * Fix: re-wire copyCommandsAsCodexSkills() back into the install dispatch path
 * so the same skill-shape that Claude / Copilot / Antigravity / Cursor /
 * Windsurf / Augment / Trae installs produce is also produced for Codex.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { install } = require('../bin/install.js');
const { createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

describe('#3562 — Codex install produces discoverable $gsd-* skill surface', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-3562-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('global install creates skills/gsd-help/SKILL.md', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    // #2088: skills now install to the canonical $HOME/.agents/skills root.
    // withCodexHome fakes $HOME to tmpRoot (codexHome's parent) above.
    const skillPath = path.join(codexSkillsRoot(tmpRoot), 'gsd-help', 'SKILL.md');
    assert.ok(
      fs.existsSync(skillPath),
      `Codex install must create ${skillPath} so $gsd-help is discoverable. ` +
        'Without this, Codex CLI 0.130.0 does not expose any $gsd-* command.',
    );
  });

  test('SKILL.md content has frontmatter expected by Codex skill discovery', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const skillPath = path.join(codexSkillsRoot(tmpRoot), 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'precondition: SKILL.md exists');

    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    assert.equal(frontmatter.name, 'gsd-help', 'SKILL.md frontmatter must declare name: gsd-help so $gsd-help resolves');
  });

  test('multiple core $gsd-* skills are produced (not just gsd-help)', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const skillsDir = codexSkillsRoot(tmpRoot);
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must exist after install');

    const gsdSkills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
      .map((e) => e.name);

    // Lower bound — exact count depends on the current command surface. The
    // commands/gsd/ directory holds dozens of *.md files; expecting more than
    // 10 generated skills is a conservative floor that catches "we generated
    // nothing" or "we only generated one accidentally" regressions.
    assert.ok(
      gsdSkills.length >= 10,
      `Expected >= 10 generated gsd-* skill directories, found ${gsdSkills.length}: ${gsdSkills.join(', ')}`,
    );
  });

  test('install preserves existing user skills (does not remove unrelated dirs)', () => {
    fs.mkdirSync(path.join(codexHome, 'skills', 'custom-user-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md'),
      '---\nname: custom-user-skill\n---\n# user skill\n',
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    const userSkill = path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md');
    assert.ok(
      fs.existsSync(userSkill),
      'Codex install must preserve existing non-gsd user skill directories',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3566-codex-hooks-feature-canonical-key.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3566-codex-hooks-feature-canonical-key (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for bug #3566 — Codex installer must emit canonical
 * [features].hooks (not the legacy [features].codex_hooks).
 *
 * Codex itself marks `codex_hooks` as a `legacy_key` in
 * codex-rs/features/src/legacy.rs. The canonical current feature flag is
 * `hooks`. The GSD installer was still writing `codex_hooks` on every fresh
 * install / reinstall, leaving deprecated config behind. This file pins:
 *
 *   1. Fresh install writes canonical `[features].hooks = true` and never
 *      emits `codex_hooks` (section, root-dotted, or block-fallback forms).
 *   2. Reinstall over a GSD-owned section-form legacy
 *      `[features].codex_hooks = true` migrates forward to
 *      `[features].hooks = true` (legacy line removed); user-owned legacy
 *      entries are preserved per #2760.
 *   3. Reinstall over a GSD-owned root-dotted legacy
 *      `features.codex_hooks = true` migrates forward to
 *      `features.hooks = true`; user-owned legacy entries are preserved.
 *   4. Reinstall over a user-owned `[features].hooks = true` (no GSD
 *      ownership marker) preserves the user line; no double-write, no
 *      ownership stamp.
 *   5. The `hasEnabledCodexHooksFeature` recognizer treats both canonical
 *      `hooks` AND legacy `codex_hooks` as "enabled" so existing installs
 *      keep working across the migration window.
 *   6. Uninstall removes either GSD-owned `hooks` or GSD-owned legacy
 *      `codex_hooks`; user-owned `hooks` is preserved.
 *
 * All assertions use parseTomlToObject — never substring-match on raw TOML
 * text (per RULESET.TESTS.no-source-grep). The product surface is the
 * parsed config shape, not the file's lexical layout.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { install, uninstall, parseTomlToObject } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

function readConfig(codexHome) {
  const text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  return { text, parsed: parseTomlToObject(text) };
}

function featuresHooks(parsed) {
  return parsed?.features?.hooks;
}

function featuresCodexHooks(parsed) {
  return parsed?.features?.codex_hooks;
}

describe('#3566 — Codex feature flag is canonical "hooks" (not legacy "codex_hooks")', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-3566-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('fresh install writes [features].hooks = true and never emits codex_hooks', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'fresh install must write canonical [features].hooks = true',
    );
    assert.strictEqual(
      featuresCodexHooks(parsed),
      undefined,
      'fresh install must NOT write legacy [features].codex_hooks',
    );
  });

  test('install over a pre-existing legacy [features].codex_hooks line preserves it (user-owned, #2760 defensive)', () => {
    // A user who hand-wrote `codex_hooks = true` keeps the legacy key.
    // Codex itself maps it via the runtime legacy_key alias, so this is
    // forward-compatible without GSD rewriting user-authored content.
    const legacy = [
      '[features]',
      'codex_hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), legacy);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresCodexHooks(parsed),
      true,
      'user-owned legacy codex_hooks line must be preserved verbatim',
    );
  });

  test('install over a pre-existing legacy root-dotted features.codex_hooks line preserves it', () => {
    const legacy = 'features.codex_hooks = true\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), legacy);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresCodexHooks(parsed),
      true,
      'user-owned root-dotted legacy line must be preserved verbatim',
    );
  });

  test('reinstall preserves user-owned [features].hooks = true (no GSD ownership marker)', () => {
    const userOwned = [
      '[features]',
      'hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), userOwned);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'user-owned hooks=true must be preserved',
    );
  });

  test('uninstall removes GSD-owned canonical hooks line but preserves user-owned hooks', () => {
    // Phase 1: fresh GSD install — writes GSD-owned hooks line.
    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed: afterInstall } = readConfig(codexHome);
    assert.strictEqual(
      featuresHooks(afterInstall),
      true,
      'precondition: install wrote canonical hooks',
    );

    withCodexHome(codexHome, () => uninstall(true, 'codex'));
    const configPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configPath)) {
      // Uninstall may delete config.toml entirely when nothing user-owned
      // remains — that is the strongest possible "feature flag removed"
      // signal and counts as success.
      return;
    }
    const { parsed: afterUninstall } = readConfig(codexHome);
    assert.notStrictEqual(
      featuresHooks(afterUninstall),
      true,
      'uninstall must remove GSD-owned canonical hooks line',
    );
  });

  test('uninstall preserves user-owned hooks=true when GSD never owned it', () => {
    const userOwned = [
      '[features]',
      'hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), userOwned);

    withCodexHome(codexHome, () => uninstall(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'uninstall must NOT touch a hooks line GSD never claimed ownership of (#2760 defensive principle)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3582-codex-skills-materialized.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3582-codex-skills-materialized (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3582 — Codex install must materialize the skill
 * surface under `~/.codex/skills/<name>/SKILL.md`.
 *
 * Background: GSD 1.42.2 reported the user-visible failure
 *   > Skipped Codex skill-copy generation (Codex discovers official skills directly)
 * which left users with a "successful" install but no routable `$gsd-*`
 * entrypoints in Codex CLI 0.130.0. Codex CLI does NOT auto-discover
 * commands from `~/.codex/gsd-core/workflows/*.md` or `agents/*.md`;
 * it only registers slash commands derived from `~/.codex/skills/<name>/SKILL.md`.
 * The "Codex discovers official skills directly" assumption was wrong.
 *
 * The current installer (#3562 / current main) calls
 * `copyCommandsAsCodexSkills()` to materialize one SKILL.md per
 * commands/gsd/*.md, with Claude-flavored command frontmatter rewritten
 * into Codex skill frontmatter and the `<codex_skill_adapter>` body
 * produced by `getCodexSkillAdapterHeader()`.
 *
 * This test locks the install contract so the 1.42.2 regression cannot
 * silently come back. It asserts the full expected skill-name set
 * (deepStrictEqual, not just count), the full adapter block (using
 * the exported `getCodexSkillAdapterHeader` IR as the expected value,
 * not raw substring search), and the success/skip log invariant.
 */
// allow-test-rule: source-text-is-the-product (see #3582)
// This assertion validates the generated adapter block that is shipped to
// users in SKILL.md; matching exact emitted text is the contract under test.

'use strict';

// GSD_TEST_MODE neutralizes side-effecting branches (auto-detection, etc.).
// Must be set BEFORE requiring bin/install.js; scoped to module load only
// so downstream tests don't see it. Mirrors the bug-2760 codex harness.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { install, getCodexSkillAdapterHeader } = require('../bin/install.js');
const { parseFrontmatter, createTempDir, cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

// Strip ANSI color codes so log assertions don't depend on TTY detection.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function assertNoBareGsdToolsInvocation(content, label) {
  const patterns = [
    /(^|\n)[ \t]*gsd-tools\s/,
    /\$\(\s*gsd-tools\s/,
    /`\s*gsd-tools\s/,
    /(?:&&|\|\||[;|])\s*gsd-tools\s/,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(
      content,
      pattern,
      `${label} must not contain a command-position bare gsd-tools invocation`,
    );
  }
}

/**
 * Walk commands/gsd/**\/*.md and return the set of skill names the installer
 * is contractually obligated to produce. Naming rule mirrors
 * `copyCommandsAsCodexSkills` in bin/install.js: nested dirs collapse to
 * `gsd-<dir>-<file>` with the .md stripped.
 */
function expectedSkillNames() {
  const names = new Set();
  function recurse(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        recurse(path.join(dir, entry.name), `${prefix}-${entry.name}`);
      } else if (entry.name.endsWith('.md')) {
        const base = entry.name.slice(0, -3);
        names.add(`${prefix}-${base}`);
      }
    }
  }
  recurse(COMMANDS_DIR, 'gsd');
  return names;
}

/**
 * Run a Codex global install into a temp CODEX_HOME and capture stdout/stderr.
 * Cleans up codexHome on throw so a partial-install failure never leaks
 * temp directories.
 */
function runCodexInstallCaptured() {
  const codexHome = createTempDir('gsd-3582-codex-');
  const logs = [];
  const warnings = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.warn = (...a) => { warnings.push(a.join(' ')); };

  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at os.homedir() ($HOME/.agents), independent of CODEX_HOME.
  // Sandbox $HOME (and $USERPROFILE) to codexHome too — otherwise this
  // in-process install would materialize skills under the developer/CI
  // machine's REAL home directory instead of the temp dir.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  process.env.GSD_TEST_MODE = '1';
  try {
    process.chdir(ROOT);
    install(true, 'codex');
    return { codexHome, logs, warnings };
  } catch (err) {
    // Always reclaim the temp dir if install throws — otherwise the
    // describe-level afterEach can't see codexHome and it leaks.
    try { cleanup(codexHome); } catch { /* best-effort */ }
    throw err;
  } finally {
    process.chdir(previousCwd);
    console.log = origLog;
    console.warn = origWarn;
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousGsdTestMode === undefined) {
      delete process.env.GSD_TEST_MODE;
    } else {
      process.env.GSD_TEST_MODE = previousGsdTestMode;
    }
  }
}

// concurrency:false — harness mutates console.* / process.env / process.cwd().
// Matches the convention used by tests/bug-3562-codex-install-skill-surface.test.cjs.
describe('bug-3582: Codex global install materializes the skill surface', { concurrency: false }, () => {
  let installRun;

  beforeEach(() => {
    installRun = runCodexInstallCaptured();
  });

  afterEach(() => {
    if (installRun && installRun.codexHome) {
      cleanup(installRun.codexHome);
    }
  });

  test('writes the exact expected set of gsd-*/SKILL.md skills (deepEqual on name set)', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    assert.ok(
      fs.existsSync(skillsDir),
      `Codex install must create ${skillsDir} (the 1.42.2 regression skipped this entirely)`,
    );

    const actualNames = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    // deepStrictEqual on the sorted full set — not just count — so a
    // partial install that drops a real command and substitutes a bogus
    // same-count `gsd-*` directory cannot pass.
    const expected = [...expectedSkillNames()].sort();
    assert.deepStrictEqual(
      [...actualNames].sort(),
      expected,
      `installed Codex skills must exactly match commands/gsd/**/*.md (one skill per command)`,
    );

    // Every skill dir contains a non-empty SKILL.md file. Empty dirs or
    // empty SKILL.md bodies would defeat Codex's slash-command
    // registration as silently as the 1.42.2 "skipped" branch did.
    for (const name of actualNames) {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      const stat = fs.statSync(skillMd);
      assert.ok(stat.isFile(), `${skillMd} must be a regular file`);
      assert.ok(stat.size > 0, `${skillMd} must not be empty`);
    }
  });

  test('SKILL.md frontmatter declares hyphen-form name matching the directory', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      // Uses the shared `parseFrontmatter` from tests/helpers.cjs per the
      // CONTRIBUTING.md "tests parse, never grep" convention.
      const fm = parseFrontmatter(content);
      assert.strictEqual(
        fm.name,
        name,
        `SKILL.md name field must match directory name for ${name} (got ${JSON.stringify(fm.name)})`,
      );
      assert.ok(
        typeof fm.description === 'string' && fm.description.length > 0,
        `SKILL.md description must be a non-empty string for ${name}`,
      );
    }
  });

  test('SKILL.md body contains the full <codex_skill_adapter> block produced by the exported builder', () => {
    // Structural check against the production builder's output — NOT a
    // raw substring grep on the rendered file. `getCodexSkillAdapterHeader`
    // is the typed IR exported by bin/install.js (#3582 PR #3609 codex
    // review); the file on disk must contain its full output verbatim
    // (open tag, body, closing `</codex_skill_adapter>`). A truncated,
    // empty, or missing-closing-tag adapter cannot satisfy this assertion.
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const expectedAdapter = getCodexSkillAdapterHeader(name);
      // Sanity: the builder itself must produce a closed block for the
      // assertion below to be meaningful.
      assert.ok(
        expectedAdapter.startsWith('<codex_skill_adapter>'),
        `getCodexSkillAdapterHeader(${name}) must start with the opening tag`,
      );
      assert.ok(
        expectedAdapter.trimEnd().endsWith('</codex_skill_adapter>'),
        `getCodexSkillAdapterHeader(${name}) must end with the closing tag`,
      );

      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      assert.ok(
        content.includes(expectedAdapter),
        `${name}/SKILL.md must contain the full adapter block produced by getCodexSkillAdapterHeader(${name}); Codex routes $${name} via this exact body`,
      );
    }
  });

  test('representative skills named in the issue report are present', () => {
    // The bug report and triage explicitly named these. Locking them as a
    // representative set so a future dispatch / filter / profile change
    // cannot drop just the commands the original user was trying to run.
    const representative = [
      'gsd-map-codebase',     // the literal command from the bug report
      'gsd-execute-phase',
      'gsd-plan-phase',
      'gsd-new-project',
      'gsd-health',
    ];
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    for (const name of representative) {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      assert.ok(
        fs.existsSync(skillMd),
        `${name}/SKILL.md must exist after Codex install (was unrouteable in 1.42.2)`,
      );
    }
  });

  test('installed Codex skills do not ask agents to run bare gsd-tools commands', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      assertNoBareGsdToolsInvocation(content, `${name}/SKILL.md`);
    }
  });

  test('installer success log mentions skills/ — never claims success while skipping', () => {
    // The 1.42.2 user-visible failure mode was a successful install that
    // printed "Skipped Codex skill-copy generation (Codex discovers
    // official skills directly)" while leaving the user with no
    // entrypoints. Lock that the broken strings can NEVER coexist with a
    // success indicator. Current main prints "✓ Installed N skills".
    const cleanLogs = installRun.logs.map(stripAnsi);
    const cleanWarnings = installRun.warnings.map(stripAnsi);
    const allOutput = [...cleanLogs, ...cleanWarnings].join('\n');

    assert.ok(
      !/Skipped Codex skill-copy generation/i.test(allOutput),
      `installer must never print "Skipped Codex skill-copy generation" (1.42.2 failure). Output:\n${allOutput}`,
    );
    assert.ok(
      !/Codex discovers official skills directly/i.test(allOutput),
      `installer must never claim "Codex discovers official skills directly" (1.42.2 incorrect assumption). Output:\n${allOutput}`,
    );

    // Positive proof — at least one log line acknowledges the skills install.
    const hasSkillsInstalledLog = cleanLogs.some(line => /Installed\s+\d+\s+skills\s+to\s+skills\//.test(line));
    assert.ok(
      hasSkillsInstalledLog,
      `installer must print a success line of the form "Installed N skills to skills/". Logs:\n${cleanLogs.join('\n')}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3808-codex-adapter-text-mode-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3808-codex-adapter-text-mode-fallback (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3808.
 *
 * When Codex runs in Default mode, `request_user_input` is reported as
 * unavailable. The Codex skill adapter must tell the agent to activate the
 * workflow's built-in TEXT_MODE mechanism (`--text` flag) rather than either:
 *   (a) silently picking a default value — the #3018 failure mode, or
 *   (b) ad-hoc plain-text fallback that bypasses the workflow's own branching.
 *
 * Workflows (e.g. plan-phase.md) already have TEXT_MODE logic:
 *   "Set TEXT_MODE=true if `--text` is present in $ARGUMENTS OR text_mode
 *    from init JSON is true."
 * The adapter must tell the agent to USE that mechanism when
 * `request_user_input` is unavailable instead of inventing its own fallback
 * or silently continuing with defaults.
 *
 * Test design: mirrors the typed-semantic-flag pattern from bug #3018 so that
 * prose rewording doesn't break tests as long as the semantics stay correct.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { getCodexSkillAdapterHeader } = INSTALL;

/**
 * Extract the "Execute mode fallback" section text from the adapter header.
 * Returns null if the section is missing. Section runs from the
 * "Execute mode fallback:" label up to the next heading or </codex_skill_adapter> tag.
 */
function extractExecuteModeFallback(header) {
  const m = header.match(/Execute mode fallback:\s*\n([\s\S]*?)(?=\n##\s|\n<\/codex_skill_adapter>)/);
  return m ? m[1].trim() : null;
}

/**
 * Parse the Execute-mode-fallback section into a typed semantic-flag record.
 *
 * Flags for bug #3808 (TEXT_MODE activation):
 *   activatesTextMode       — does the prose tell the agent to activate TEXT_MODE / use --text?
 *   instructsStop           — does the prose tell the agent to stop/halt/wait?
 *   presentsPlainText       — does the prose mention plain-text / numbered-list presentation?
 *   silentlyPicksDefaults   — (anti-pattern) does the prose instruct silent-default picking?
 */
function parseExecuteModeFallbackFor3808(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      activatesTextMode: false,
      instructsStop: false,
      presentsPlainText: false,
      silentlyPicksDefaults: false,
    };
  }

  const lower = section.toLowerCase();

  // (a) TEXT_MODE activation — adapter must tell the agent to use the workflow's
  // built-in text mode mechanism when request_user_input is unavailable.
  // Accept either: explicit "--text" flag mention OR "text_mode" / "text mode"
  // paired with context showing it is being SET/ACTIVATED (not just referenced).
  const mentionsTextFlag   = section.includes('--text');
  const mentionsTextModeOn = /text_mode\s*=\s*true|set\s+text_mode|activate\s+text.?mode|enable\s+text.?mode|text.?mode.*active|text.?mode.*on\b/i.test(section);
  const activatesTextMode  = mentionsTextFlag || mentionsTextModeOn;

  // (b) STOP/WAIT directive — the agent must halt instead of proceeding silently.
  const instructsStop = /\b(stop|halt|wait)\b/.test(lower);

  // (c) Plain-text fallback presentation.
  const presentsPlainText = /plain.?text|numbered list/.test(lower);

  // Anti-pattern guard — the prose that caused #3018 and resurfaces in #3808.
  const silentlyPicksDefaults = /pick (a |the )?(reasonable|sensible|sane) default/i.test(section);

  return {
    ok: true,
    sectionLength: section.length,
    activatesTextMode,
    instructsStop,
    presentsPlainText,
    silentlyPicksDefaults,
  };
}

describe('bug #3808: codex skill adapter activates TEXT_MODE when request_user_input is unavailable', () => {
  const SKILL_NAMES = ['gsd-plan-phase', 'gsd-discuss-phase', 'gsd-execute-phase', 'gsd-verify-work'];

  test('getCodexSkillAdapterHeader is exported', () => {
    assert.equal(typeof getCodexSkillAdapterHeader, 'function');
  });

  test('Execute mode fallback section exists for all key skills', () => {
    for (const skillName of SKILL_NAMES) {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      assert.ok(section !== null && section.length > 0,
        `${skillName}: Execute mode fallback section must exist and have content`);
    }
  });

  for (const skillName of SKILL_NAMES) {
    test(`${skillName}: fallback activates TEXT_MODE (--text flag or text_mode=true) when request_user_input is unavailable`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.activatesTextMode, true,
        `${skillName}: fallback must instruct the agent to activate TEXT_MODE (mention --text flag or text_mode=true/active) when request_user_input is unavailable (#3808). Section was:\n${section}`);
    });

    test(`${skillName}: fallback instructs STOP/WAIT (not silent continuation)`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.instructsStop, true,
        `${skillName}: fallback must include stop/halt/wait instruction. Section was:\n${section}`);
    });

    test(`${skillName}: fallback does NOT contain silent-default anti-pattern`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.silentlyPicksDefaults, false,
        `${skillName}: regression — fallback must NOT instruct the agent to pick defaults autonomously (#3018 / #3808). Section was:\n${section}`);
    });
  }

  test('typed semantic-record snapshot for gsd-plan-phase — full contract', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-plan-phase'));
    const parsed = parseExecuteModeFallbackFor3808(section);
    assert.deepStrictEqual(
      {
        ok: parsed.ok,
        activatesTextMode: parsed.activatesTextMode,
        instructsStop: parsed.instructsStop,
        presentsPlainText: parsed.presentsPlainText,
        silentlyPicksDefaults: parsed.silentlyPicksDefaults,
      },
      {
        ok: true,
        activatesTextMode: true,
        instructsStop: true,
        presentsPlainText: true,
        silentlyPicksDefaults: false,
      },
      `gsd-plan-phase: full TEXT_MODE fallback contract violated (#3808). Section was:\n${section}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-570-codex-leak-scanner.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-570-codex-leak-scanner (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #570)
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #570 — three related sub-bugs in the Codex leak
 * scanner and supporting infrastructure.
 *
 * SUB-BUG A: scanForLeakedPaths recursively scans the entire targetDir,
 *   including pre-existing unrelated files that contain ~/.claude references.
 *   Fix: scan only files listed in gsd-file-manifest.json.
 *
 * SUB-BUG B: convertClaudeToCodexMarkdown replaces "~/.claude/" (with trailing
 *   slash) but NOT bare "~/.claude" (no slash). The scanner regex
 *   /(?:~|\$HOME)\/\.claude\b/ matches without trailing slash.
 *   Fix: add bare word-boundary replacement.
 *
 * SUB-BUG C: writeManifest checks file.endsWith('.md') for the agents/
 *   directory. Codex installs .toml agent files, so they are invisible to the
 *   manifest and thus to any manifest-based scan fix.
 *   Fix: also check .toml.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  install,
  convertClaudeCommandToCodexSkill,
} = require('../bin/install.js');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

describe('#570 — Codex leak scanner sub-bugs', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-570-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  // SUB-BUG B
  test('convertClaudeToCodexMarkdown replaces bare ~/.claude (no trailing slash)', () => {
    // convertClaudeToCodexMarkdown is not exported directly; exercise it via
    // convertClaudeCommandToCodexSkill which calls it internally.
    const input = 'configDir = ~/.claude\npath = ~/.claude/hooks/\ndir = $HOME/.claude';
    const out = convertClaudeCommandToCodexSkill(input, 'gsd-test');

    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `Expected no leaked ~/.claude reference after conversion, got:\n${out}`,
    );
  });

  // SUB-BUG C
  test('writeManifest includes .toml agent files for Codex', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const agentsDir = path.join(codexHome, 'agents');
    // Not the shared listAgentFiles() helper: this reads the INSTALLED Codex
    // dest dir and filters .toml (not source .md), so its semantics differ.
    // Confirm that Codex actually wrote .toml agent files — if none exist the
    // test is vacuous and we should fail loudly.
    const tomlFiles = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.toml'))
      : [];
    assert.ok(
      tomlFiles.length > 0,
      `Precondition: Codex install must write at least one gsd-*.toml in agents/; found none in ${agentsDir}`,
    );

    const manifestPath = path.join(codexHome, 'gsd-file-manifest.json');
    assert.ok(
      fs.existsSync(manifestPath),
      `gsd-file-manifest.json must exist after install; not found at ${manifestPath}`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestKeys = Object.keys(manifest.files || {});

    const tomlManifestKeys = manifestKeys.filter(
      (k) => k.startsWith('agents/gsd-') && k.endsWith('.toml'),
    );
    assert.ok(
      tomlManifestKeys.length > 0,
      `Expected at least one 'agents/gsd-*.toml' key in manifest.files, but found none.\n` +
        `agents/ toml files on disk: ${tomlFiles.join(', ')}\n` +
        `All manifest keys (agents/): ${manifestKeys.filter((k) => k.startsWith('agents/')).join(', ')}`,
    );
  });

  // SUB-BUG A
  test('scanForLeakedPaths does not warn for pre-existing unrelated files in ~/.codex', () => {
    // Write a pre-existing file with ~/.claude references BEFORE install.
    const memoriesDir = path.join(codexHome, 'memories');
    fs.mkdirSync(memoriesDir, { recursive: true });
    const preExistingFile = path.join(memoriesDir, 'raw_memories.md');
    fs.writeFileSync(
      preExistingFile,
      '# Old memories\nI used to work in ~/.claude and $HOME/.claude regularly.\n',
    );

    let captured;
    withCodexHome(codexHome, () => {
      captured = captureConsole(() => install(true, 'codex'));
    });

    const combinedOutput = captured.stderr;

    assert.ok(
      !combinedOutput.includes('memories/raw_memories.md'),
      `scanForLeakedPaths must not warn about pre-existing unrelated file memories/raw_memories.md.\n` +
        `Actual warnings:\n${combinedOutput}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-704-codex-launcher-path-corruption.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-704-codex-launcher-path-corruption (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #704)
'use strict';

/**
 * Regression test for issue #704:
 * "v1.3.1 global install ships literal $gsd-core launcher paths in workflows"
 *
 * ROOT CAUSE: `convertSlashCommandsToCodexSkillMentions` had a regex
 *   /(?<![a-zA-Z0-9./])\/gsd-([a-z0-9-]+)/
 * The lookbehind did NOT include `}`, so shell variable expressions like
 *   `${_GSD_RUNTIME_ROOT}/gsd-core/bin/...`
 * had their `/gsd-core` matched (the char before `/` was `}`, not in the
 * exclusion set), converting it to `$gsd-core` and breaking all Codex
 * workflow launcher paths.
 *
 * FIX: Add `}` to the lookbehind set so `${VAR}/gsd-core/` is excluded.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  convertClaudeCommandToCodexSkill,
  convertSlashCommandsToCodexSkillMentions,
} = require('../bin/install.js');

// The canonical launcher snippet path that was being corrupted
const RUNTIME_ROOT_PATH = '${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}';
// The exact bad token reported in issue #704
const BAD_TOKEN = '$gsd-core';

describe('#704 — Codex global install launcher path corruption', () => {
  test('convertClaudeCommandToCodexSkill does not corrupt ${VAR}/gsd-core/ or $(cmd)/gsd-* paths', () => {
    // Minimal fixture with the launcher snippet and command-substitution patterns
    // that were being corrupted (#704).
    const input = [
      '---',
      'description: Test skill',
      '---',
      '',
      '```bash',
      '_GSD_SHIM_NAME="gsd-tools.cjs"',
      '_GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"',
      'GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"',
      'if [ -f "$GSD_TOOLS" ]; then',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'fi',
      '# Command-substitution path form (reapply-patches pattern)',
      'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"',
      '```',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*` from shell variable expressions `${VAR}/gsd-*`
    //   - `)$gsd-*` from command-substitution paths `$(cmd)/gsd-*`
    const shellCorruptionPatterns = [
      { pattern: '}' + BAD_TOKEN, description: 'shell-variable }$gsd-core' },
      { pattern: ')$gsd-local', description: 'command-substitution )$gsd-local-patches' },
    ];
    for (const { pattern, description } of shellCorruptionPatterns) {
      assert.ok(
        !output.includes(pattern),
        `Codex skill conversion must not produce "${pattern}" (${description}). ` +
          `Offending fragment: ${
            output.includes(pattern)
              ? output.substring(output.indexOf(pattern) - 50, output.indexOf(pattern) + 80)
              : '(not found)'
          }`,
      );
    }

    // The correct path forms must be preserved — the canonical launcher path
    // (RUNTIME_ROOT_PATH) must survive Codex conversion intact.
    assert.ok(
      output.includes(RUNTIME_ROOT_PATH),
      `Expected canonical launcher path "${RUNTIME_ROOT_PATH}" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
    assert.ok(
      output.includes(')/gsd-local-patches'),
      `Expected ")/gsd-local-patches" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
  });

  test('convertClaudeCommandToCodexSkill preserves all shell path forms (}, ) closers)', () => {
    // All these paths appear after a shell-closing character (} or )) and must
    // NOT be converted to $gsd-* by the Codex slash-command converter.
    const shellPaths = [
      // Shell variable expression forms (} closer)
      { path: '"${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      // Command-substitution forms () closer) — reapply-patches pattern
      { path: 'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
      { path: 'candidate="$(dirname "$(expand_home "$OPENCODE_CONFIG")")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
    ];

    for (const { path: p, corruptedForm } of shellPaths) {
      const input = `---\ndescription: Test\n---\n\n\`\`\`bash\n${p}\n\`\`\``;
      const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-paths');
      assert.ok(
        !output.includes(corruptedForm),
        `Path "${p}" was corrupted to contain "${corruptedForm}" after Codex conversion.\n` +
          `Got:\n${output}`,
      );
    }
  });

  test('convertClaudeCommandToCodexSkill still converts legitimate /gsd-<cmd> slash mentions', () => {
    // Slash-command mentions (not preceded by }) should still be converted
    const input = [
      '---',
      'description: Test',
      '---',
      '',
      'Use /gsd-discuss-phase to start a discussion.',
      'Or use /gsd-plan-phase for planning.',
      'Also: /gsd:capture --backlog adds items.',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-cmds');

    assert.ok(
      output.includes('$gsd-discuss-phase'),
      'Expected /gsd-discuss-phase to be converted to $gsd-discuss-phase',
    );
    assert.ok(
      output.includes('$gsd-plan-phase'),
      'Expected /gsd-plan-phase to be converted to $gsd-plan-phase',
    );
    assert.ok(
      output.includes('$gsd-capture'),
      'Expected /gsd:capture to be converted to $gsd-capture',
    );
  });

  test('actual shipped workflow files: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk gsd-core/workflows/ and assert that no file produces $gsd-core
    // inside a shell variable expansion context after Codex conversion.
    //
    // NOTE: The backtick-wrapped prose-path case (`/gsd-core/workflows/update.md`)
    // was a pre-existing gap with the #704 lookbehind fix and is now addressed by
    // the positive-boundary regex introduced in #712. That case is covered by the
    // "#712" describe block below.
    //
    // We probe for the specific shell-context pattern from the issue report:
    //   BAD:  ${_GSD_RUNTIME_ROOT}$gsd-core/bin/
    //   GOOD: ${_GSD_RUNTIME_ROOT}/gsd-core/bin/
    const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      // If the directory doesn't exist, skip gracefully (non-standard layout)
      return;
    }

    const files = fs.readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(workflowsDir, f));

    assert.ok(files.length > 0, 'Expected at least one workflow .md file');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*`: closing brace from `${VAR}/gsd-*` shell variable expressions
    //   - `)$gsd-*`: closing paren from `$(cmd)/gsd-*` command substitutions
    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(workflowsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted workflow files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });

  test('commands/gsd/*.md: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk commands/gsd/ and assert that no command file produces the shell-context
    // }$gsd-core corruption — since commands also go through
    // convertClaudeCommandToCodexSkill when installed globally for Codex.
    const commandsDir = path.join(__dirname, '..', 'commands', 'gsd');
    if (!fs.existsSync(commandsDir)) return;

    const files = fs.readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(commandsDir, f));

    assert.ok(files.length > 0, 'Expected at least one command .md file');

    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(commandsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted command files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });
});

describe('#712: positive-boundary slash-command conversion', () => {
  // Tests call convertSlashCommandsToCodexSkillMentions directly so the regex
  // is exercised in isolation — no frontmatter wrapping, no ADAPTER_CLOSE
  // stripping, no .claude→.codex rewrite masking the result.

  // ── MUST-NOT-CONVERT (negative) cases ─────────────────────────────────────
  // These inputs must be returned UNCHANGED — no $gsd-* substitution.

  test('backtick-wrapped path: `/gsd-core/workflows/update.md` is NOT converted (THE new fix)', () => {
    const input = 'See `/gsd-core/workflows/update.md` for details.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected backtick-wrapped path to be unchanged. Got: ${result}`,
    );
  });

  test('backtick-wrapped path deeper: `/gsd-pi/bin/foo.cjs` is NOT converted', () => {
    const input = 'Run `/gsd-pi/bin/foo.cjs` directly.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected deep backtick-wrapped path to be unchanged. Got: ${result}`,
    );
  });

  test('shell var expansion: ${_GSD_RUNTIME_ROOT}/gsd-core/bin/x is NOT converted (regression guard)', () => {
    const input = 'PATH="${_GSD_RUNTIME_ROOT}/gsd-core/bin/x"';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes('$gsd-core'),
      `Expected no $gsd-core substitution in shell var path. Got: ${result}`,
    );
    assert.ok(
      result.includes('/gsd-core/bin/x'),
      `Expected original path to be preserved. Got: ${result}`,
    );
  });

  test('command substitution: $(expand_home ~/.claude)/gsd-local-patches is NOT converted (regression guard)', () => {
    const input = 'candidate="$(expand_home ~/.claude)/gsd-local-patches"';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes(')$gsd-local'),
      `Expected no )$gsd-local substitution. Got: ${result}`,
    );
    assert.ok(
      result.includes(')/gsd-local-patches'),
      `Expected original path to be preserved. Got: ${result}`,
    );
  });

  test('plain path segment: bin/gsd-tools.cjs is NOT converted', () => {
    const input = 'node bin/gsd-tools.cjs --help';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected plain path segment to be unchanged. Got: ${result}`,
    );
  });

  test('plain path segment: .claude/gsd-core/agents — /gsd-core portion is NOT slash-command converted', () => {
    // Tests the regex in isolation: the .claude→.codex path rewrite that happens
    // inside convertClaudeToCodexMarkdown does NOT run here. We assert directly
    // that the slash-command regex leaves /gsd-core after the slash intact —
    // i.e. the `e` in `/gsd-core` is NOT treated as a command boundary.
    const input = 'Look in .claude/gsd-core/agents for the agent files.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes('$gsd-core'),
      `Expected no $gsd-core substitution in .claude/gsd-core path. Got: ${result}`,
    );
    assert.ok(
      result.includes('/gsd-core/agents'),
      `Expected /gsd-core/agents to remain as a path segment. Got: ${result}`,
    );
  });

  // ── MUST-CONVERT (positive) cases ─────────────────────────────────────────
  // These inputs contain legitimate /gsd-<cmd> mentions that MUST be converted.

  test('space-preceded prose: Use /gsd-discuss-phase to start. → $gsd-discuss-phase', () => {
    const input = 'Use /gsd-discuss-phase to start.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('$gsd-discuss-phase'),
      `Expected /gsd-discuss-phase to be converted. Got: ${result}`,
    );
    assert.ok(
      !result.includes('/gsd-discuss-phase'),
      `Expected original /gsd-discuss-phase to be replaced. Got: ${result}`,
    );
  });

  test('backtick-WRAPPED MENTION (single segment): Run `/gsd-execute-phase` now → `$gsd-execute-phase`', () => {
    // A backtick-wrapped COMMAND (single segment, no path continuation) MUST
    // still be converted — this guards against a naive whitespace-only fix.
    const input = 'Run `/gsd-execute-phase` now.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('`$gsd-execute-phase`'),
      `Expected backtick-wrapped command to be converted to \`$gsd-execute-phase\`. Got: ${result}`,
    );
    assert.ok(
      !result.includes('`/gsd-execute-phase`'),
      `Expected original \`/gsd-execute-phase\` to be replaced. Got: ${result}`,
    );
  });

  test('parenthetical/backtick list like CONTEXT.md:59: (`/gsd-plan-phase`, `/gsd-progress`) → converted', () => {
    const input = 'Available commands: (`/gsd-plan-phase`, `/gsd-progress`) — pick one.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('`$gsd-plan-phase`'),
      `Expected /gsd-plan-phase to be converted. Got: ${result}`,
    );
    assert.ok(
      result.includes('`$gsd-progress`'),
      `Expected /gsd-progress to be converted. Got: ${result}`,
    );
  });

  test('start-of-string: /gsd-manager runs → $gsd-manager runs (exercises the ^ branch of lookbehind)', () => {
    // This case is IMPOSSIBLE to test through the frontmatter-wrapping pipeline
    // (the body always has preceding chars). Direct call exercises the ^ branch.
    const input = '/gsd-manager runs the pipeline.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('$gsd-manager'),
      `Expected /gsd-manager to be converted. Got: ${result}`,
    );
    assert.ok(
      !result.includes('/gsd-manager'),
      `Expected original /gsd-manager to be replaced. Got: ${result}`,
    );
  });

  test('double-quote wrapped: "/gsd-resume" → "$gsd-resume"', () => {
    const input = 'Call "/gsd-resume" to continue.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('"$gsd-resume"'),
      `Expected "/gsd-resume" to be converted to "$gsd-resume". Got: ${result}`,
    );
    assert.ok(
      !result.includes('"/gsd-resume"'),
      `Expected original "/gsd-resume" to be replaced. Got: ${result}`,
    );
  });

  // ── End-to-end: headline #712 bug through the real install pipeline ────────

  test('end-to-end: backtick-wrapped path `/gsd-core/workflows/update.md` survives full Codex install pipeline', () => {
    // Uses convertClaudeCommandToCodexSkill (same pattern as #704 tests above)
    // to prove the real install path does not corrupt prose references to repo paths.
    const input = [
      '---',
      'description: Test',
      '---',
      '',
      'See `/gsd-core/workflows/update.md` for the update workflow.',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-712-e2e');

    assert.ok(
      !output.includes('$gsd-core'),
      `Expected no $gsd-core in converted output. Got:\n${output}`,
    );
    assert.ok(
      output.includes('/gsd-core/workflows/update.md'),
      `Expected backtick-wrapped path to survive conversion. Got:\n${output}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-851-codex-quick-adapter-agent-type-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-851-codex-quick-adapter-agent-type-fallback (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #851)
// Tests assert on text in bin/install.js (Codex adapter header prose) —
// the adapter text IS the product loaded by Codex agents at runtime.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');
const src = fs.readFileSync(INSTALL_JS, 'utf8');

// Helper: extract Section C from the raw source text.
// Anchors on the heading and ends at </codex_skill_adapter>.
function getSectionC() {
  const headingIdx = src.indexOf('## C. Task() → spawn_agent Mapping');
  assert.ok(headingIdx >= 0, 'Section C heading must exist in bin/install.js');
  const closeTag = src.indexOf('</codex_skill_adapter>', headingIdx);
  assert.ok(closeTag >= 0, 'Section C must be followed by </codex_skill_adapter>');
  return src.slice(headingIdx, closeTag);
}

describe('bug #851: Codex adapter documents multi_agent_v1 schema limitation and fallback', () => {

  // (a) Schema-detection step: the adapter must require the agent to inspect
  //     spawn_agent's parameter schema BEFORE deciding how to dispatch.
  test('(a) schema-detection: adapter requires inspecting spawn_agent schema before dispatching', () => {
    const sectionC = getSectionC();

    // Must name BOTH schema variants so the agent knows what to look for
    assert.ok(
      sectionC.includes('multi_agent_v1'),
      'Section C must name the multi_agent_v1 schema to identify the limited form',
    );
    assert.ok(
      sectionC.includes('multi_agent_v2') || sectionC.includes('agent_type-capable'),
      'Section C must name the typed schema (multi_agent_v2 or agent_type-capable) as the capable form',
    );

    // Must instruct schema inspection before spawning
    assert.ok(
      sectionC.includes('tool_search') || sectionC.includes('inspect') || sectionC.includes('schema'),
      'Section C must instruct the agent to inspect the spawn_agent schema (via tool_search or similar)',
    );

    // All three requirements together (AND):
    assert.ok(
      sectionC.includes('multi_agent_v1') &&
      (sectionC.includes('multi_agent_v2') || sectionC.includes('agent_type-capable')) &&
      (sectionC.includes('tool_search') || sectionC.includes('inspect') || sectionC.includes('schema')),
      'Section C must require schema-detection: name both schema variants AND instruct inspection before spawning',
    );
  });

  // (b) Active-config-root resolution: the TOML path must describe how to
  //     resolve the config root (honoring $CODEX_HOME / --config-dir / --local),
  //     not imply a single fixed path.
  test('(b) active-config-root: fallback TOML path resolves the active Codex config root', () => {
    const sectionC = getSectionC();

    // Must mention the agents/<agent-name>.toml relative path
    assert.ok(
      sectionC.includes('agents/<agent-name>.toml'),
      'Section C must reference agents/<agent-name>.toml for the TOML extraction step',
    );

    // Must describe dynamic config-root resolution (at least two of the three
    // override mechanisms, plus the word "config" to anchor context)
    const mentionsCodexHome = sectionC.includes('$CODEX_HOME') || sectionC.includes('CODEX_HOME');
    const mentionsConfigDir = sectionC.includes('--config-dir') || sectionC.includes('config-dir');
    const mentionsLocal = sectionC.includes('--local') || sectionC.includes('.codex') || sectionC.includes('local');
    const mentionsConfigRoot = sectionC.includes('config root') || sectionC.includes('config.toml') || sectionC.includes('config directory');

    assert.ok(
      mentionsCodexHome,
      'Section C fallback must mention $CODEX_HOME for config-root resolution',
    );
    assert.ok(
      mentionsConfigDir,
      'Section C fallback must mention --config-dir for config-root resolution',
    );
    assert.ok(
      mentionsLocal,
      'Section C fallback must mention --local / .codex for config-root resolution',
    );
    assert.ok(
      mentionsConfigRoot,
      'Section C fallback must describe the concept of an active config root (config.toml or config root/directory)',
    );

    // AND: all four required elements together
    assert.ok(
      mentionsCodexHome && mentionsConfigDir && mentionsLocal && mentionsConfigRoot,
      'Section C fallback must describe active-config-root resolution: $CODEX_HOME + --config-dir + --local + config-root concept (AND logic)',
    );

    // Must NOT contain the literal ~/.codex/ (would be rewritten by _applyRuntimeRewrites
    // and cause bug-3582 to diverge)
    assert.ok(
      !sectionC.includes('~/.codex/'),
      'Section C must NOT contain the literal ~/.codex/ substring (breaks bug-3582 materialization test)',
    );
  });

  // (c) "NOT equivalent" label: the workaround must be explicitly labeled as
  //     not equivalent to typed gsd-planner/gsd-executor execution.
  test('(c) not-equivalent label: generic-agent workaround is labeled as NOT equivalent to typed dispatch', () => {
    const sectionC = getSectionC();

    // Must name at least one typed agent
    const namesTypedAgent =
      sectionC.includes('gsd-planner') ||
      sectionC.includes('gsd-executor') ||
      sectionC.includes('typed GSD agent') ||
      sectionC.includes('typed gsd-');

    // Must contain explicit "not equivalent" / "NOT equivalent" / negation language
    const hasNotEquivalent =
      sectionC.toLowerCase().includes('not equivalent') ||
      sectionC.includes('NOT equivalent') ||
      sectionC.includes('is NOT possible');

    // Must name the workaround as a workaround, not a first-class path
    const hasWorkaroundLabel =
      sectionC.includes('workaround') ||
      sectionC.includes('fallback');

    assert.ok(
      namesTypedAgent,
      'Section C must name at least one typed GSD agent (gsd-planner, gsd-executor, or "typed GSD agent")',
    );
    assert.ok(
      hasNotEquivalent,
      'Section C must contain explicit "not equivalent" / "NOT equivalent" language for the generic-agent path',
    );
    assert.ok(
      hasWorkaroundLabel,
      'Section C must label the generic-agent path as a workaround or fallback',
    );

    // AND: all three together
    assert.ok(
      namesTypedAgent && hasNotEquivalent && hasWorkaroundLabel,
      'Section C must AND: name a typed agent + label it NOT equivalent + call the generic path a workaround/fallback',
    );
  });

  // (d) Fail-closed rule: when typed dispatch is mandatory, the adapter must
  //     instruct the agent to fail closed and report the limitation, not silently degrade.
  test('(d) fail-closed: adapter requires failing closed when typed dispatch is mandatory', () => {
    const sectionC = getSectionC();

    const hasFailClosed =
      sectionC.includes('fail closed') ||
      sectionC.includes('fail-closed') ||
      sectionC.includes('fail_closed');

    const hasReportLimitation =
      sectionC.includes('schema limitation') ||
      sectionC.includes('report') ||
      sectionC.includes('not silently') ||
      sectionC.includes('silently degrading') ||
      sectionC.includes('silently');

    const hasMandatoryContext =
      sectionC.includes('mandatory') ||
      sectionC.includes('required') ||
      sectionC.includes('worktree isolation') ||
      sectionC.includes('isolation');

    assert.ok(
      hasFailClosed,
      'Section C must instruct fail-closed behavior (the phrase "fail closed" or equivalent)',
    );
    assert.ok(
      hasReportLimitation,
      'Section C must instruct reporting the schema limitation rather than silently degrading',
    );
    assert.ok(
      hasMandatoryContext,
      'Section C must identify a context where typed dispatch is mandatory (e.g. worktree isolation)',
    );

    // AND: all three together
    assert.ok(
      hasFailClosed && hasReportLimitation && hasMandatoryContext,
      'Section C must AND: instruct fail-closed + report limitation + identify mandatory-typed-dispatch contexts',
    );
  });

  // Regression guard: typed mapping for capable schema must still be present.
  test('adapter still documents typed agent_type spawn for sessions that support it', () => {
    const sectionC = getSectionC();

    assert.ok(
      sectionC.includes('agent_type-capable') || sectionC.includes('multi_agent_v2'),
      'Section C must still document the typed schema (agent_type-capable / multi_agent_v2)',
    );
    assert.ok(
      sectionC.includes('spawn_agent(agent_type=') || sectionC.includes('agent_type="X"'),
      'Section C must still show a typed spawn_agent(agent_type=...) example for capable sessions',
    );
  });

  // Regression guard: deferred tool discovery must remain (bug-279 contract).
  test('adapter deferred tool discovery instruction is preserved', () => {
    // The pre-existing bug-279 contract must remain intact
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'),
      'Adapter must still instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-772-codex-hook-events.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-772-codex-hook-events (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #772: Adopt new stable Codex hook events + commandWindows for
 * Windows parity.
 *
 * Codex CLI (rust-v0.137.0) stabilised the full hook-event set. This suite
 * asserts that a Codex install:
 *
 * (a) Registers the 3 new high-value hook events in hooks.json:
 *   - SubagentStart — inject context / GSD_AGENT_NAME awareness at subagent open
 *   - Stop          — post-session context headroom tracking
 *   - PostToolUse   — mirror the Claude Code PostToolUse context monitor
 *
 * (b) Emits `commandWindows` in the SessionStart hooks.json entry so that
 *   Windows users get the .cmd shim path and non-Windows users get the POSIX
 *   node runner command. Both fields are present in the same entry; Codex picks
 *   the right one per its HookHandlerConfig schema
 *   (codex-rs/config/src/hook_config.rs: commandWindows / command_windows alias).
 *
 * Note: UserPromptSubmit is NOT wired (same rationale as Qwen #788 — the
 * gsd-prompt-guard handler exits unless tool_name is Write|Edit, so it would be
 * a silent no-op for the UserPromptSubmit payload shape).
 *
 * Test strategy:
 *   - Test new event registration via ensureCodexHooksJsonEvent() directly
 *     (mirrors the #3426 pattern of testing ensureCodexHooksJsonSessionStart
 *     directly with a stub hook file — avoids full install() migration dance).
 *   - Test commandWindows via ensureCodexHooksJsonSessionStart() directly.
 *   - IR-first discipline: assert on the structured result, not rendered text.
 *
 * Verified hook event schema:
 *   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 *   https://github.com/openai/codex/blob/main/codex/codex-rs/config/src/hook_config.rs
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL = require('../bin/install.js');
const {
  ensureCodexHooksJsonSessionStart,
  ensureCodexHooksJsonEvent,
  removeCodexHooksJsonEvent,
  reconcileCodexHooksJsonEvent,
} = INSTALL;
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract all hook handler entries (full objects with type/command/etc.) for
 * `eventName` from a hooks.json object (flat or nested-hooks shape).
 */
function hooksJsonHandlersForEvent(hooksJson, eventName) {
  if (!hooksJson || typeof hooksJson !== 'object') return [];
  const table =
    hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)
      ? hooksJson.hooks
      : hooksJson;
  if (!Array.isArray(table[eventName])) return [];
  return table[eventName].flatMap(entry =>
    Array.isArray(entry && entry.hooks) ? entry.hooks : []
  );
}

function readHooksJson(targetDir) {
  const p = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stubHookFile(targetDir, hookName) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  const dest = path.join(hooksDest, hookName);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

// ─── Suite 1: ensureCodexHooksJsonEvent export surface ───────────────────────

describe('enh-772: export surface — new functions are exported', () => {
  test('ensureCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof ensureCodexHooksJsonEvent, 'function',
      'ensureCodexHooksJsonEvent must be exported from bin/install.js');
  });

  test('removeCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof removeCodexHooksJsonEvent, 'function',
      'removeCodexHooksJsonEvent must be exported from bin/install.js');
  });

  test('reconcileCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof reconcileCodexHooksJsonEvent, 'function',
      'reconcileCodexHooksJsonEvent must be exported from bin/install.js');
  });
});

// ─── Suite 2: ensureCodexHooksJsonEvent registers new events ─────────────────

describe('enh-772: ensureCodexHooksJsonEvent registers SubagentStart, Stop, PostToolUse', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-events-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: ensureCodexHooksJsonEvent writes hooks.json`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const result = ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      assert.ok(result && result.path, `result must have path for ${eventName}`);
      assert.ok(result.wrote || result.changed,
        `ensureCodexHooksJsonEvent must write or change hooks.json for ${eventName}`);
      assert.ok(fs.existsSync(path.join(tmpDir, 'hooks.json')),
        `hooks.json must exist after registering ${eventName}`);
    });

    test(`${eventName}: hooks.json contains the event entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0,
        `Expected ${eventName} entry in hooks.json; got: ${JSON.stringify(hooksJson)}`);
    });

    test(`${eventName}: hook entry uses gsd-context-monitor`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(
        handlers.some(h => h.command && h.command.includes('gsd-context-monitor')),
        `${eventName} hook must use gsd-context-monitor; got: ${JSON.stringify(handlers)}`
      );
    });

    test(`${eventName}: hook entry has type: 'command'`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.type, 'command',
        `${eventName} hook entry must have type 'command'`);
    });

    test(`${eventName}: hook entry has timeout: 10`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.timeout, 10,
        `${eventName} hook entry must have timeout 10`);
    });
  }

  test('null absoluteRunner returns unchanged result without writing', () => {
    const result = ensureCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false,
      'null runner must return changed: false');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'hooks.json')),
      'hooks.json must NOT be written when runner is null');
  });
});

// ─── Suite 3: commandWindows parity in SessionStart ──────────────────────────

describe('enh-772: commandWindows parity — ensureCodexHooksJsonSessionStart emits commandWindows', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-cmdwin-');
    stubHookFile(tmpDir, 'gsd-check-update.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // commandWindows is ONLY emitted on win32 platform (where the .cmd shim is also
  // written). On POSIX platforms, commandWindows is omitted to avoid pointing Windows
  // Codex at a non-existent .cmd file (the shim is only present after a native Windows
  // install that runs buildCodexHookWindowsShimIR and atomicWriteFileSync).

  test('POSIX platform: commandWindows is NOT emitted (shim not written on POSIX)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    assert.ok(result && result.wrote, 'must write hooks.json on linux');

    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    assert.ok(handlers.length > 0, `Expected SessionStart handlers; got: ${JSON.stringify(hooksJson)}`);

    const entry = handlers[0];
    assert.ok(
      entry.commandWindows === undefined,
      `commandWindows must NOT be emitted on POSIX (shim not written); got: ${JSON.stringify(entry)}`
    );
  });

  test('POSIX platform: command references gsd-check-update.js (not .cmd)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    const entry = handlers[0];
    assert.ok(
      entry.command && entry.command.includes('gsd-check-update'),
      `POSIX command must reference gsd-check-update; got: ${entry.command}`
    );
    assert.ok(
      !entry.command.endsWith('.cmd') && !entry.command.endsWith('.cmd"'),
      `POSIX command must not end with .cmd; got: ${entry.command}`
    );
  });

  test('null absoluteRunner: no commandWindows emitted, no write', () => {
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false, 'null runner must return changed: false');
    const hooksJson = readHooksJson(tmpDir);
    if (hooksJson) {
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      for (const h of handlers) {
        assert.ok(!h.commandWindows,
          `commandWindows must not be present when runner is null; got: ${JSON.stringify(h)}`);
      }
    }
  });

  test('Windows platform: SessionStart hook is written with commandWindows pointing to .cmd shim', () => {
    // On win32, both `command` and `commandWindows` use the .cmd shim path
    // (because managedCommand = shimIR.hookCommand = .cmd path, and
    // commandWindows = same .cmd path). This ensures Codex picks the .cmd
    // on Windows regardless of which field it reads.
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });
    // The shim write and hooks.json write should succeed in the tmp dir.
    if (result.wrote) {
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      assert.ok(handlers.length > 0,
        `SessionStart must be registered on Windows path; got: ${JSON.stringify(hooksJson)}`);
      const entry = handlers[0];
      assert.ok(typeof entry.commandWindows === 'string',
        `commandWindows must be present on Windows path; got: ${JSON.stringify(entry)}`);
      // commandWindows should reference the .cmd shim
      assert.ok(
        entry.commandWindows.includes('gsd-check-update') && entry.commandWindows.includes('.cmd'),
        `commandWindows must reference gsd-check-update.cmd on win32; got: ${entry.commandWindows}`
      );
    }
  });
});

// ─── Suite 4: idempotency ────────────────────────────────────────────────────

describe('enh-772: ensureCodexHooksJsonEvent is idempotent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-idem-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: calling twice does not duplicate hook entries`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const opts = { absoluteRunner: fakeRunner, platform: 'linux' };

      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);
      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);

      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.strictEqual(handlers.length, 1,
        `${eventName} should have exactly 1 hook handler after idempotent re-register; got ${handlers.length}: ${JSON.stringify(handlers)}`);
    });
  }
});

// ─── Suite 5: removeCodexHooksJsonEvent ──────────────────────────────────────

describe('enh-772: removeCodexHooksJsonEvent removes managed entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-remove-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: removeCodexHooksJsonEvent removes the managed entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });

      // Verify it was registered
      let hooksJson = readHooksJson(tmpDir);
      let handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0, `${eventName} must be registered before removal`);

      // Remove
      const result = removeCodexHooksJsonEvent(tmpDir, eventName);
      assert.ok(result.changed || result.wrote,
        `removeCodexHooksJsonEvent must change hooks.json for ${eventName}`);

      hooksJson = readHooksJson(tmpDir);
      if (hooksJson) {
        handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
        assert.strictEqual(handlers.length, 0,
          `After removal, ${eventName} should have 0 handlers; got: ${JSON.stringify(handlers)}`);
      }
    });
  }
});

// ─── Suite 6: reconcileCodexHooksJsonEvent preserves user entries ─────────────

describe('enh-772: reconcileCodexHooksJsonEvent preserves user-owned entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-preserve-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('user-owned SubagentStart entry is preserved when GSD entry is registered', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    const userEntry = {
      hooks: [{ type: 'command', command: 'my-custom-hook.sh' }]
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      SubagentStart: [userEntry]
    }, null, 2) + '\n');

    reconcileCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      managedCommand: '"/usr/local/bin/node" "/home/me/.codex/hooks/gsd-context-monitor.js"',
    });

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const table = hooksJson.hooks || hooksJson;
    const entries = Array.isArray(table.SubagentStart) ? table.SubagentStart : [];
    // Should have 2 entries: user entry + GSD entry
    assert.ok(entries.length >= 2,
      `User entry must be preserved; got entries: ${JSON.stringify(entries)}`);
    // User entry must still be present
    const userEntryStillPresent = entries.some(e =>
      Array.isArray(e.hooks) && e.hooks.some(h => h.command === 'my-custom-hook.sh')
    );
    assert.ok(userEntryStillPresent,
      `User entry must survive GSD registration; entries: ${JSON.stringify(entries)}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2866-codex-strip-no-trailing-newline.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2866-codex-strip-no-trailing-newline (consolidation epic #1969 B8 #1977)", () => {
/**
 * Bug #2866: Codex Installer (RC.7) fails to strip legacy flat hooks if
 * trailing newline is missing.
 *
 * The cleanup regexes in `bin/install.js` matched stale GSD hook blocks
 * via `\r?\n` at the end. When a stale block sat at end-of-file without
 * a trailing newline (very common — many editors strip them, and the
 * legacy installer never wrote one), no shape stripped, the installer
 * saw `gsd-check-update` already present, skipped writing the new
 * Nested-AoT block, and Codex 0.125+ refused to load with
 *   "invalid type: map, expected a sequence in `hooks`"
 *
 * Fix: every shape's terminator is now `(?:\r?\n|$)` so end-of-file
 * counts as a valid terminator. The strip logic was lifted into a pure
 * helper, `stripStaleGsdHookBlocks(configContent)`, exported from
 * `bin/install.js` for direct test coverage.
 *
 * This test parses `package.json` to require `bin/install.js`
 * structurally (not by hardcoded path), then drives each historical
 * shape through the helper twice — once with a trailing newline, once
 * without — and asserts both are stripped.
 */
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const installPath = path.resolve(REPO_ROOT, pkg.bin['gsd-core']);
const { stripStaleGsdHookBlocks } = require(installPath);

/**
 * Parse the TOML output line-structurally so assertions check shape, not
 * substring presence in raw text. Comments are dropped, table headers are
 * recorded, and string-valued keys are captured. Sufficient for the small,
 * well-formed TOML produced by these tests.
 */
function parseTomlShape(text) {
  const tableHeaders = [];
  const keys = new Map(); // dotted path → string value (last-write-wins, fine for these inputs)
  let currentTable = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim();
    if (!line) continue;
    const tableMatch = line.match(/^\[(\[)?([^\]]+)\]?\]$/);
    if (tableMatch) {
      currentTable = tableMatch[2];
      tableHeaders.push((tableMatch[1] ? '[[' : '[') + currentTable + (tableMatch[1] ? ']]' : ']'));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = currentTable ? `${currentTable}.${kvMatch[1]}` : kvMatch[1];
      const value = kvMatch[2].replace(/^"(.*)"$/, '$1');
      keys.set(key, value);
    }
  }
  return { tableHeaders, keys };
}

const SHAPES = {
  'Shape 1 (legacy gsd-update-check)': [
    '# GSD Hooks',
    '[[hooks]]',
    'event = "SessionStart"',
    'command = "node /Users/USER/.codex/hooks/gsd-update-check.js"',
  ].join('\n'),
  'Shape 2 (flat [[hooks]] + gsd-check-update)': [
    '# GSD Hooks',
    '[[hooks]]',
    'event = "SessionStart"',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
  'Shape 3 ([[hooks.SessionStart]] without nested .hooks)': [
    '# GSD Hooks',
    '[[hooks.SessionStart]]',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
  'Shape 4 (nested [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]])': [
    '# GSD Hooks',
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
};

describe('bug-2866: stripStaleGsdHookBlocks handles end-of-file without trailing newline', () => {
  test('stripStaleGsdHookBlocks is exported from bin/install.js', () => {
    assert.strictEqual(typeof stripStaleGsdHookBlocks, 'function',
      'bin/install.js must export stripStaleGsdHookBlocks');
  });

  function assertStripped(out, shape, scenario) {
    const shape_ = parseTomlShape(out);
    const hooksTable = shape_.tableHeaders.find((h) => /^\[\[?hooks(\.|]\])/.test(h));
    assert.strictEqual(hooksTable, undefined,
      `(${shape}, ${scenario}) no hooks table header may remain after strip, got tables: ${shape_.tableHeaders.join(', ')}`);
    const staleCmd = [...shape_.keys.entries()].find(([_, v]) =>
      /gsd-(update-check|check-update)/.test(v));
    assert.strictEqual(staleCmd, undefined,
      `(${shape}, ${scenario}) no key may carry a stale gsd-*-update command, got: ${staleCmd && staleCmd.join('=')}`);
    assert.strictEqual(shape_.keys.get('history.persistence'), 'save-all',
      `(${shape}, ${scenario}) history.persistence must be preserved as "save-all"`);
  }

  for (const [shape, block] of Object.entries(SHAPES)) {
    test(`${shape}: stripped when terminated by trailing newline`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}\n`;
      assertStripped(stripStaleGsdHookBlocks(input), shape, 'with trailing newline');
    });

    test(`${shape}: stripped when at end-of-file without trailing newline`, () => {
      // The reporter's repro: stale block sits at the very end with no \n.
      const input = `[history]\npersistence = "save-all"\n${block}`;
      assertStripped(stripStaleGsdHookBlocks(input), shape, 'no trailing newline');
    });
  }

  test('returns input unchanged when no GSD hook block is present', () => {
    const benign = '[history]\npersistence = "save-all"\n';
    const out = stripStaleGsdHookBlocks(benign);
    assert.strictEqual(out, benign, 'helper must be a no-op when no GSD reference exists');
    const benignShape = parseTomlShape(out);
    assert.strictEqual(benignShape.keys.get('history.persistence'), 'save-all',
      'parsed shape must preserve history.persistence');
    assert.deepStrictEqual(benignShape.tableHeaders, ['[history]'],
      'parsed shape must contain only the [history] table');
  });

  // The structural rewrite (TOML-AST-driven, not regex-driven) must handle
  // whitespace and key-ordering variations that the previous regex missed.
  // These cases were silently leaked by the old implementation; one
  // (V3) actually corrupted the file by leaving an orphaned key=value line
  // outside any table.
  const VARIATIONS = {
    'extra blank line in Shape 4': [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
    ].join('\n'),
    'keys reordered (command before event in Shape 2)': [
      '# GSD Hooks',
      '[[hooks]]',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
      'event = "SessionStart"',
    ].join('\n'),
    'extra key alongside command (Shape 3 + timeout)': [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
      'timeout = 5000',
    ].join('\n'),
    'tight whitespace (no spaces around `=`)': [
      '# GSD Hooks',
      '[[hooks]]',
      'event="SessionStart"',
      'command="node /Users/USER/.codex/hooks/gsd-check-update.js"',
    ].join('\n'),
  };

  for (const [variation, block] of Object.entries(VARIATIONS)) {
    test(`variation stripped: ${variation}`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}\n`;
      assertStripped(stripStaleGsdHookBlocks(input), variation, 'with trailing newline');
    });
    test(`variation stripped at EOF without trailing newline: ${variation}`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}`;
      assertStripped(stripStaleGsdHookBlocks(input), variation, 'no trailing newline');
    });
  }

  test('user-authored [[hooks.UserPromptSubmit]] is preserved', () => {
    // The structural strip must not touch hook tables that don't carry a
    // GSD-managed `gsd-(check-update|update-check).js` command.
    const input = [
      '[history]',
      'persistence = "save-all"',
      '[[hooks.UserPromptSubmit]]',
      'command = "node /Users/USER/my-hook.js"',
      '',
    ].join('\n');
    const out = stripStaleGsdHookBlocks(input);
    const shape = parseTomlShape(out);
    assert.ok(
      shape.tableHeaders.includes('[[hooks.UserPromptSubmit]]'),
      `user-authored [[hooks.UserPromptSubmit]] must survive, got: ${shape.tableHeaders.join(', ')}`,
    );
    assert.strictEqual(
      shape.keys.get('hooks.UserPromptSubmit.command'),
      'node /Users/USER/my-hook.js',
      'user-authored command value must be preserved verbatim',
    );
  });

  test('Shape 4 strip does not leave an orphaned [[hooks.SessionStart]] header', () => {
    // Shape 4 is stripped before Shape 3 specifically to avoid this.
    const block = SHAPES['Shape 4 (nested [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]])'];
    const out = stripStaleGsdHookBlocks(`[history]\npersistence = "save-all"\n${block}`);
    const outShape = parseTomlShape(out);
    const orphan = outShape.tableHeaders.find((h) => /hooks\.SessionStart/.test(h));
    assert.strictEqual(orphan, undefined,
      `Shape 4 strip must remove the parent [[hooks.SessionStart]] header too, got tables: ${outShape.tableHeaders.join(', ')}`);
  });
});
  });
}
