// allow-test-rule: integration-test-input
// Reads shipped source files (commands/gsd/*.md, agents/*.md, bin/install.js) as
// real test fixture input for installer/converter functions like
// convertClaudeToCopilotContent() and the install.js plumbing. Those files are
// not inspected for string presence; they are inputs whose *transformation* or
// installation behavior is being asserted. The converter-purity test on
// bin/lib/*.cjs uses a synthetic input string instead (per #3584:
// runtime-slash.cjs eliminated literal /gsd: refs from runtime CJS, so reading
// verify.cjs is no longer a meaningful fixture for testing the converter).

/**
 * GSD Tools Tests - Copilot Install Plumbing
 *
 * Tests for Copilot runtime directory resolution, config paths,
 * and integration with the multi-runtime installer.
 *
 * Requirements: CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, CLI-06
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseFrontmatter, createTempDir, cleanup } = require('./helpers.cjs');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

const {
  getDirName,
  getConfigDirFromHome,
  claudeToCopilotTools,
  convertCopilotToolName,
  convertClaudeToCopilotContent,
  convertClaudeCommandToCopilotSkill,
  convertClaudeAgentToCopilotAgent,
  GSD_COPILOT_INSTRUCTIONS_MARKER,
  GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER,
  mergeCopilotInstructions,
  stripGsdFromCopilotInstructions,
  GSD_COPILOT_HOOK_FILE,
  buildCopilotHookConfig,
  writeCopilotHookConfig,
  writeManifest,
  reportLocalPatches,
  runtimeMap,
  allRuntimes,
  parseRuntimeInput,
  buildRuntimePromptText,
} = require('../bin/install.js');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

// ─── Profile resolution for installRuntimeArtifacts tests ────────────────────
const _gsdLibDir = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const { loadSkillsManifest, resolveProfile } = require(path.join(_gsdLibDir, 'install-profiles.cjs'));
const _manifest = loadSkillsManifest();
const resolvedProfileFull = resolveProfile({ modes: [], manifest: _manifest });

// ─── getDirName ─────────────────────────────────────────────────────────────────

describe('getDirName (Copilot)', () => {
  test('returns .github for copilot', () => {
    assert.strictEqual(getDirName('copilot'), '.github');
  });

  test('does not break existing runtimes', () => {
    assert.strictEqual(getDirName('claude'), '.claude');
    assert.strictEqual(getDirName('opencode'), '.opencode');
    assert.strictEqual(getDirName('antigravity'), '.agents');
    assert.strictEqual(getDirName('kilo'), '.kilo');
    assert.strictEqual(getDirName('codex'), '.codex');
  });
});

// ─── getGlobalConfigDir ──────────────────────────────────────────────────────────

describe('getGlobalConfigDir (Copilot)', () => {
  let originalCopilotConfigDir;
  let originalCopilotHome;

  beforeEach(() => {
    originalCopilotConfigDir = process.env.COPILOT_CONFIG_DIR;
    originalCopilotHome = process.env.COPILOT_HOME;
  });

  afterEach(() => {
    if (originalCopilotConfigDir !== undefined) {
      process.env.COPILOT_CONFIG_DIR = originalCopilotConfigDir;
    } else {
      delete process.env.COPILOT_CONFIG_DIR;
    }
    if (originalCopilotHome !== undefined) {
      process.env.COPILOT_HOME = originalCopilotHome;
    } else {
      delete process.env.COPILOT_HOME;
    }
  });

  test('returns ~/.copilot with no env var or explicit dir', () => {
    delete process.env.COPILOT_CONFIG_DIR;
    delete process.env.COPILOT_HOME;
    const result = getGlobalConfigDir('copilot');
    assert.strictEqual(result, path.join(os.homedir(), '.copilot'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalConfigDir('copilot', '/custom/path');
    assert.strictEqual(result, '/custom/path');
  });

  test('respects COPILOT_CONFIG_DIR env var', () => {
    process.env.COPILOT_CONFIG_DIR = '~/custom-copilot';
    const result = getGlobalConfigDir('copilot');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-copilot'));
  });

  test('explicit dir takes priority over COPILOT_CONFIG_DIR', () => {
    process.env.COPILOT_CONFIG_DIR = '~/env-path';
    const result = getGlobalConfigDir('copilot', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('respects COPILOT_HOME env var', () => {
    delete process.env.COPILOT_CONFIG_DIR;
    process.env.COPILOT_HOME = '/custom/copilot-home';
    const result = getGlobalConfigDir('copilot');
    assert.strictEqual(result, '/custom/copilot-home');
  });

  test('COPILOT_HOME supports tilde expansion', () => {
    delete process.env.COPILOT_CONFIG_DIR;
    process.env.COPILOT_HOME = '~/my-copilot';
    const result = getGlobalConfigDir('copilot');
    assert.strictEqual(result, path.join(os.homedir(), 'my-copilot'));
  });

  test('COPILOT_CONFIG_DIR takes priority over COPILOT_HOME', () => {
    process.env.COPILOT_CONFIG_DIR = '/config-dir-path';
    process.env.COPILOT_HOME = '/home-path';
    const result = getGlobalConfigDir('copilot');
    assert.strictEqual(result, '/config-dir-path');
  });

  test('explicit dir takes priority over COPILOT_HOME', () => {
    delete process.env.COPILOT_CONFIG_DIR;
    process.env.COPILOT_HOME = '/home-path';
    const result = getGlobalConfigDir('copilot', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break existing runtimes', () => {
    assert.strictEqual(getGlobalConfigDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalConfigDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

// ─── getConfigDirFromHome ───────────────────────────────────────────────────────

describe('getConfigDirFromHome (Copilot)', () => {
  test('returns .github path string for local (isGlobal=false)', () => {
    assert.strictEqual(getConfigDirFromHome('copilot', false), "'.github'");
  });

  test('returns .copilot path string for global (isGlobal=true)', () => {
    assert.strictEqual(getConfigDirFromHome('copilot', true), "'.copilot'");
  });

  test('does not break existing runtimes', () => {
    assert.strictEqual(getConfigDirFromHome('opencode', true), "'.config', 'opencode'");
    assert.strictEqual(getConfigDirFromHome('claude', true), "'.claude'");
    assert.strictEqual(getConfigDirFromHome('cursor', true), "'.cursor'");
    assert.strictEqual(getConfigDirFromHome('kilo', true), "'.config', 'kilo'");
    assert.strictEqual(getConfigDirFromHome('codex', true), "'.codex'");
  });
});

// ─── Typed runtime registry checks (Copilot) ─────────────────────────────────
// Migrated (#455): uses typed exports (runtimeMap, allRuntimes, parseRuntimeInput,
// buildRuntimePromptText) instead of source-grep on bin/install.js.

describe('Runtime registry integration (Copilot)', () => {
  test('CLI-02: runtimeMap has Copilot as option 7', () => {
    assert.strictEqual(runtimeMap['7'], 'copilot', 'runtimeMap must map 7 to copilot');
  });

  test('CLI-03: allRuntimes array includes copilot', () => {
    assert.ok(Array.isArray(allRuntimes), 'allRuntimes must be an array');
    assert.ok(allRuntimes.includes('copilot'), 'allRuntimes must include copilot');
  });

  test('CLI-02: allRuntimes keeps kilo above opencode', () => {
    const kiloIdx = allRuntimes.indexOf('kilo');
    const opencodeIdx = allRuntimes.indexOf('opencode');
    assert.ok(kiloIdx !== -1, 'allRuntimes must contain kilo');
    assert.ok(opencodeIdx !== -1, 'allRuntimes must contain opencode');
    assert.ok(kiloIdx < opencodeIdx, 'kilo must appear before opencode in allRuntimes');
  });

  test('CLI-01: parseRuntimeInput resolves option 7 to copilot runtime', () => {
    // Copilot is option 7 in the runtime menu. parseRuntimeInput('7') must resolve to ['copilot'].
    const result = parseRuntimeInput('7');
    assert.ok(Array.isArray(result), 'parseRuntimeInput must return an array');
    assert.ok(result.includes('copilot'), `parseRuntimeInput('7') must resolve to copilot, got: ${JSON.stringify(result)}`);
  });

  test('CLI-06: buildRuntimePromptText includes Copilot in the prompt', () => {
    const text = buildRuntimePromptText();
    assert.ok(typeof text === 'string' && text.length > 0, 'buildRuntimePromptText must return a non-empty string');
    assert.ok(text.includes('Copilot') || text.includes('copilot'), 'runtime prompt must mention Copilot');
  });

  test('CLI-06: buildRuntimePromptText includes --copilot option text', () => {
    const text = buildRuntimePromptText();
    // Copilot is in the runtime map, so the prompt must list it
    assert.ok(
      text.includes('copilot') || text.includes('Copilot'),
      'runtime selection prompt must list copilot as an option'
    );
  });

  test('runtimeMap and allRuntimes are consistent (every allRuntimes entry has a map key)', () => {
    const mapValues = Object.values(runtimeMap);
    for (const runtime of allRuntimes) {
      assert.ok(
        mapValues.includes(runtime),
        `allRuntimes entry '${runtime}' must have a corresponding key in runtimeMap`
      );
    }
  });

  test('allRuntimes does not put copilot ahead of claude and opencode', () => {
    // copilot is a supplementary runtime — claude and opencode are the primary pair.
    // The allRuntimes list must contain both claude (idx 0) and copilot.
    assert.ok(allRuntimes.includes('claude'), 'allRuntimes must include claude');
    assert.ok(allRuntimes.includes('opencode'), 'allRuntimes must include opencode');
    // copilot is present but must NOT displace claude as the default (first entry)
    assert.strictEqual(allRuntimes[0], 'claude', 'claude must be first in allRuntimes (the default runtime)');
  });
});

// ─── convertCopilotToolName ─────────────────────────────────────────────────────

describe('convertCopilotToolName', () => {
  test('maps Read to read', () => {
    assert.strictEqual(convertCopilotToolName('Read'), 'read');
  });

  test('maps Write to edit', () => {
    assert.strictEqual(convertCopilotToolName('Write'), 'edit');
  });

  test('maps Edit to edit (same as Write)', () => {
    assert.strictEqual(convertCopilotToolName('Edit'), 'edit');
  });

  test('maps Bash to execute', () => {
    assert.strictEqual(convertCopilotToolName('Bash'), 'execute');
  });

  test('maps Grep to search', () => {
    assert.strictEqual(convertCopilotToolName('Grep'), 'search');
  });

  test('maps Glob to search (same as Grep)', () => {
    assert.strictEqual(convertCopilotToolName('Glob'), 'search');
  });

  test('maps Task to agent', () => {
    assert.strictEqual(convertCopilotToolName('Task'), 'agent');
  });

  test('maps WebSearch to web', () => {
    assert.strictEqual(convertCopilotToolName('WebSearch'), 'web');
  });

  test('maps WebFetch to web (same as WebSearch)', () => {
    assert.strictEqual(convertCopilotToolName('WebFetch'), 'web');
  });

  test('maps TodoWrite to todo', () => {
    assert.strictEqual(convertCopilotToolName('TodoWrite'), 'todo');
  });

  test('maps AskUserQuestion to ask_user', () => {
    assert.strictEqual(convertCopilotToolName('AskUserQuestion'), 'ask_user');
  });

  test('maps SlashCommand to skill', () => {
    assert.strictEqual(convertCopilotToolName('SlashCommand'), 'skill');
  });

  test('maps mcp__context7__ prefix to io.github.upstash/context7/', () => {
    assert.strictEqual(
      convertCopilotToolName('mcp__context7__resolve-library-id'),
      'io.github.upstash/context7/resolve-library-id'
    );
  });

  test('maps mcp__context7__* wildcard', () => {
    assert.strictEqual(
      convertCopilotToolName('mcp__context7__*'),
      'io.github.upstash/context7/*'
    );
  });

  test('lowercases unknown tools as fallback', () => {
    assert.strictEqual(convertCopilotToolName('SomeNewTool'), 'somenewtool');
  });

  test('mapping constant has 13 entries (12 direct + mcp handled separately)', () => {
    assert.strictEqual(Object.keys(claudeToCopilotTools).length, 12);
  });

  // Regression: mcp__tavily/ref/jina use the same generic passthrough as exa/firecrawl (#657)
  // No explicit io.github.* registry ID is known for these providers; they lower-case passthrough.
  const genericMcpCases = [
    ['mcp__exa__*',        'mcp__exa__*'],
    ['mcp__firecrawl__*',  'mcp__firecrawl__*'],
    ['mcp__tavily__*',     'mcp__tavily__*'],
    ['mcp__ref__*',        'mcp__ref__*'],
    ['mcp__jina__*',       'mcp__jina__*'],
    ['mcp__exa__web_search_exa',   'mcp__exa__web_search_exa'],
    ['mcp__firecrawl__scrape',     'mcp__firecrawl__scrape'],
    ['mcp__tavily__search',        'mcp__tavily__search'],
    ['mcp__ref__get',              'mcp__ref__get'],
    ['mcp__jina__read_url',        'mcp__jina__read_url'],
  ];

  for (const [input, expected] of genericMcpCases) {
    test(`generic MCP passthrough: ${input} → ${expected}`, () => {
      assert.strictEqual(convertCopilotToolName(input), expected);
    });
  }

  test('mcp__context7__* still gets the explicit io.github.upstash mapping (not generic passthrough)', () => {
    // Confirm the context7 special-case is NOT affected by the generic path
    assert.strictEqual(convertCopilotToolName('mcp__context7__*'), 'io.github.upstash/context7/*');
    assert.strictEqual(
      convertCopilotToolName('mcp__context7__resolve-library-id'),
      'io.github.upstash/context7/resolve-library-id'
    );
  });
});

// ─── convertClaudeToCopilotContent ──────────────────────────────────────────────

describe('convertClaudeToCopilotContent', () => {
  test('replaces ~/.claude/ with .github/ in local mode (default)', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('see ~/.claude/foo'),
      'see .github/foo'
    );
  });

  test('replaces ~/.claude/ with ~/.copilot/ in global mode', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('see ~/.claude/foo', true),
      'see ~/.copilot/foo'
    );
  });

  test('replaces ./.claude/ with ./.github/', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('at ./.claude/bar'),
      'at ./.github/bar'
    );
  });

  test('replaces bare .claude/ with .github/', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('in .claude/baz'),
      'in .github/baz'
    );
  });

  test('replaces $HOME/.claude/ with .github/ in local mode (default)', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('"$HOME/.claude/config"'),
      '".github/config"'
    );
  });

  test('replaces $HOME/.claude/ with $HOME/.copilot/ in global mode', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('"$HOME/.claude/config"', true),
      '"$HOME/.copilot/config"'
    );
  });

  test('converts gsd: to gsd- in command names', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('run /gsd:health or gsd:progress'),
      'run /gsd-health or gsd-progress'
    );
  });

  test('handles mixed content in local mode', () => {
    const input = 'Config at ~/.claude/settings and $HOME/.claude/config.\n' +
      'Local at ./.claude/data and .claude/commands.\n' +
      'Run gsd:health and /gsd:progress.';
    const result = convertClaudeToCopilotContent(input);
    assert.ok(result.includes('.github/settings'), 'tilde path converted to local');
    assert.ok(!result.includes('$HOME/.claude/'), '$HOME path converted');
    assert.ok(result.includes('./.github/data'), 'dot-slash path converted');
    assert.ok(result.includes('.github/commands'), 'bare path converted');
    assert.ok(result.includes('gsd-health'), 'command name converted');
    assert.ok(result.includes('/gsd-progress'), 'slash command converted');
  });

  test('handles mixed content in global mode', () => {
    const input = 'Config at ~/.claude/settings and $HOME/.claude/config.\n' +
      'Local at ./.claude/data and .claude/commands.\n' +
      'Run gsd:health and /gsd:progress.';
    const result = convertClaudeToCopilotContent(input, true);
    assert.ok(result.includes('~/.copilot/settings'), 'tilde path converted to global');
    assert.ok(result.includes('$HOME/.copilot/config'), '$HOME path converted to global');
    assert.ok(result.includes('./.github/data'), 'dot-slash path converted');
    assert.ok(result.includes('.github/commands'), 'bare path converted');
  });

  test('does not double-replace in local mode', () => {
    const input = '~/.claude/foo and ./.claude/bar and .claude/baz';
    const result = convertClaudeToCopilotContent(input);
    assert.ok(!result.includes('.github/.github/'), 'no .github/.github/ artifact');
    assert.strictEqual(result, '.github/foo and ./.github/bar and .github/baz');
  });

  test('does not double-replace in global mode', () => {
    const input = '~/.claude/foo and ./.claude/bar and .claude/baz';
    const result = convertClaudeToCopilotContent(input, true);
    assert.ok(!result.includes('.copilot/.github/'), 'no .copilot/.github/ artifact');
    assert.strictEqual(result, '~/.copilot/foo and ./.github/bar and .github/baz');
  });

  test('preserves content with no matches', () => {
    assert.strictEqual(
      convertClaudeToCopilotContent('hello world'),
      'hello world'
    );
  });
});

// ─── convertClaudeCommandToCopilotSkill ─────────────────────────────────────────

describe('convertClaudeCommandToCopilotSkill', () => {
  test('converts frontmatter with all fields', () => {
    const input = `---
name: gsd:health
description: Diagnose planning directory health
argument-hint: [--repair]
allowed-tools:
  - Read
  - Bash
  - Write
  - AskUserQuestion
---

Body content here referencing ~/.claude/foo and gsd:health.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-health');
    const fm = parseFrontmatter(result);
    assert.equal(fm.name, 'gsd-health', 'name uses param');
    assert.equal(fm.description, 'Diagnose planning directory health', 'description preserved (quoted per #2876)');
    assert.equal(fm['argument-hint'], '[--repair]', 'argument-hint round-trips');
    assert.ok(result.includes('allowed-tools: Read, Bash, Write, AskUserQuestion'), 'tools comma-separated');
    assert.ok(result.includes('.github/foo'), 'CONV-06 applied to body (local mode default)');
    assert.ok(result.includes('gsd-health'), 'CONV-07 applied to body');
    assert.ok(!result.includes('gsd:health'), 'no gsd: references remain');
  });

  test('handles skill without allowed-tools', () => {
    const input = `---
name: gsd:help
description: Show available GSD commands
---

Help content.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-help');
    const fm = parseFrontmatter(result);
    assert.equal(fm.name, 'gsd-help', 'name set');
    assert.equal(fm.description, 'Show available GSD commands', 'description preserved');
    assert.ok(!('allowed-tools' in fm), 'no allowed-tools line');
  });

  test('handles skill without argument-hint', () => {
    const input = `---
name: gsd:progress
description: Show project progress
allowed-tools:
  - Read
  - Bash
---

Progress body.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-progress');
    assert.ok(!result.includes('argument-hint:'), 'no argument-hint line');
    assert.ok(result.includes('allowed-tools: Read, Bash'), 'tools present');
  });

  test('argument-hint with inner single quotes uses double-quote YAML delimiter', () => {
    const input = `---
name: gsd:new-milestone
description: Start milestone
argument-hint: "[milestone name, e.g., 'v1.1 Notifications']"
allowed-tools:
  - Read
---

Body.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-new-milestone');
    assert.ok(result.includes(`argument-hint: "[milestone name, e.g., 'v1.1 Notifications']"`), 'inner single quotes preserved with double-quote delimiter');
  });

  test('applies CONV-06 path conversion to body (local mode)', () => {
    const input = `---
name: gsd:test
description: Test skill
---

Check ~/.claude/settings and ./.claude/local and $HOME/.claude/global.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-test');
    assert.ok(result.includes('.github/settings'), 'tilde path converted to local');
    assert.ok(result.includes('./.github/local'), 'dot-slash path converted');
    assert.ok(result.includes('.github/global'), '$HOME path converted to local');
  });

  test('applies CONV-06 path conversion to body (global mode)', () => {
    const input = `---
name: gsd:test
description: Test skill
---

Check ~/.claude/settings and ./.claude/local and $HOME/.claude/global.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-test', null, null, true);
    assert.ok(result.includes('~/.copilot/settings'), 'tilde path converted to global');
    assert.ok(result.includes('./.github/local'), 'dot-slash path converted');
    assert.ok(result.includes('$HOME/.copilot/global'), '$HOME path converted to global');
  });

  test('applies CONV-07 command name conversion to body', () => {
    const input = `---
name: gsd:test
description: Test skill
---

Run gsd:health and /gsd:progress for diagnostics.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-test');
    assert.ok(result.includes('gsd-health'), 'gsd:health converted');
    assert.ok(result.includes('/gsd-progress'), '/gsd:progress converted');
    assert.ok(!result.match(/gsd:[a-z]/), 'no gsd: command refs remain');
  });

  test('handles content without frontmatter (local mode)', () => {
    const input = 'Just some markdown with ~/.claude/path and gsd:health.';
    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-test');
    assert.ok(result.includes('.github/path'), 'CONV-06 applied (local)');
    assert.ok(result.includes('gsd-health'), 'CONV-07 applied');
    assert.ok(!result.includes('---'), 'no frontmatter added');
  });

  test('preserves agent field in frontmatter', () => {
    const input = `---
name: gsd:execute-phase
description: Execute a phase
agent: gsd-planner
allowed-tools:
  - Read
  - Bash
---

Body.`;

    const result = convertClaudeCommandToCopilotSkill(input, 'gsd-execute-phase');
    assert.ok(result.includes('agent: gsd-planner'), 'agent field preserved');
  });
});

// ─── convertClaudeAgentToCopilotAgent ───────────────────────────────────────────

describe('convertClaudeAgentToCopilotAgent', () => {
  test('maps and deduplicates tools', () => {
    const input = `---
name: gsd-executor
description: Executes GSD plans
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

Agent body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.includes("tools: ['read', 'edit', 'execute', 'search']"), 'tools mapped and deduped');
  });

  test('#2540 regression: a block-list tools: contract keeps every tool', () => {
    // Pre-fix, the single-line `tools:` regex plus split(',') read the whole
    // block list as the one literal "- Read": convertCopilotToolName did not
    // recognise it, fell through to its .toLowerCase() default, and Write,
    // Edit, Bash, Glob, Grep and Skill were silently dropped — the same
    // functional break #2540 reports for Codex, live on Copilot. The shape is
    // agents/gsd-nyquist-auditor.md's, this PR's own motivating agent.
    const input = `---
name: gsd-nyquist-auditor
description: Fills Nyquist validation gaps
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Skill
color: purple
---

Agent body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    const toolsLine = result.split('\n').find(l => l.startsWith('tools:'));
    assert.strictEqual(toolsLine, "tools: ['read', 'edit', 'execute', 'search', 'skill']");
    assert.ok(!result.includes("'- read'"), 'the block-list marker must never reach the emitted contract');
  });

  test('formats tools as JSON array', () => {
    const input = `---
name: gsd-test
description: Test agent
tools: Read, Bash
---

Body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.match(/tools: \['[a-z_]+'(, '[a-z_]+')*\]/), 'tools formatted as JSON array');
  });

  test('preserves name description and color', () => {
    const input = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Bash
color: yellow
---

Body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    const fm = parseFrontmatter(result);
    assert.equal(fm.name, 'gsd-executor', 'name preserved');
    assert.equal(fm.description, 'Executes GSD plans with atomic commits', 'description preserved');
    assert.equal(fm.color, 'yellow', 'color preserved');
  });

  test('handles mcp__context7__ tools', () => {
    const input = `---
name: gsd-researcher
description: Research agent
tools: Read, Bash, mcp__context7__resolve-library-id
color: cyan
---

Body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.includes('io.github.upstash/context7/resolve-library-id'), 'mcp tool mapped');
    assert.ok(!result.includes('mcp__context7__'), 'no mcp__ prefix remains');
  });

  test('handles agent with no tools field', () => {
    const input = `---
name: gsd-empty
description: Empty agent
color: green
---

Body.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.includes('tools: []'), 'missing tools produces []');
  });

  test('applies CONV-06 and CONV-07 to body (local mode)', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

Check ~/.claude/settings and run gsd:health.`;

    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.includes('.github/settings'), 'CONV-06 applied (local)');
    assert.ok(result.includes('gsd-health'), 'CONV-07 applied');
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ remains');
    assert.ok(!result.match(/gsd:[a-z]/), 'no gsd: command refs remain');
  });

  test('applies CONV-06 and CONV-07 to body (global mode)', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

Check ~/.claude/settings and run gsd:health.`;

    const result = convertClaudeAgentToCopilotAgent(input, true);
    assert.ok(result.includes('~/.copilot/settings'), 'CONV-06 applied (global)');
    assert.ok(result.includes('gsd-health'), 'CONV-07 applied');
  });

  test('handles content without frontmatter (local mode)', () => {
    const input = 'Just markdown with ~/.claude/path and gsd:test.';
    const result = convertClaudeAgentToCopilotAgent(input);
    assert.ok(result.includes('.github/path'), 'CONV-06 applied (local)');
    assert.ok(result.includes('gsd-test'), 'CONV-07 applied');
    assert.ok(!result.includes('---'), 'no frontmatter added');
  });
});

// ─── installRuntimeArtifacts (copilot integration) ─────────────────────────────

describe('installRuntimeArtifacts (copilot integration)', () => {
  // Pivoted from copyCommandsAsCopilotSkills(srcDir, tempDir, 'gsd') shim to
  // installRuntimeArtifacts('copilot', configDir, 'global', resolvedProfileFull).
  // Output layout: <configDir>/skills/gsd-<stem>/SKILL.md (destSubpath='skills', prefix='gsd-').
  const srcDir = path.join(__dirname, '..', 'commands', 'gsd');
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-copilot-skills-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('creates skill folders from source commands', () => {
    installRuntimeArtifacts('copilot', configDir, 'global', resolvedProfileFull);

    const skillsDir = path.join(configDir, 'skills');
    // Check specific folders exist
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-health')), 'gsd-health folder exists');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-health', 'SKILL.md')), 'gsd-health/SKILL.md exists');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help')), 'gsd-help folder exists');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-progress')), 'gsd-progress folder exists');

    // Count gsd-* directories — should match number of source command files
    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    const expectedSkillCount = fs.readdirSync(srcDir)
      .filter(f => f.endsWith('.md')).length;
    assert.strictEqual(dirs.length, expectedSkillCount, `expected ${expectedSkillCount} skill folders, got ${dirs.length}`);
  });

  test('skill content has Copilot frontmatter format', () => {
    installRuntimeArtifacts('copilot', configDir, 'global', resolvedProfileFull);

    const skillsDir = path.join(configDir, 'skills');
    const skillContent = fs.readFileSync(path.join(skillsDir, 'gsd-health', 'SKILL.md'), 'utf8');
    // Frontmatter format checks
    assert.ok(skillContent.startsWith('---\nname: gsd-health\n'), 'starts with name: gsd-health');
    assert.ok(skillContent.includes('allowed-tools: Read, Bash, Write, AskUserQuestion'),
      'allowed-tools is comma-separated');
    assert.ok(!skillContent.includes('allowed-tools:\n  -'), 'NOT YAML multiline format');
    // CONV-06/07 applied
    assert.ok(!skillContent.includes('~/.claude/'), 'no ~/.claude/ references');
    assert.ok(!skillContent.match(/gsd:[a-z]/), 'no gsd: command references');
  });

  test('generates gsd-autonomous skill from autonomous.md command', () => {
    // Fail-fast: source command must exist
    const srcFile = path.join(srcDir, 'autonomous.md');
    assert.ok(fs.existsSync(srcFile), 'commands/gsd/autonomous.md must exist as source');

    installRuntimeArtifacts('copilot', configDir, 'global', resolvedProfileFull);

    const skillsDir = path.join(configDir, 'skills');
    // Skill folder and file created
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-autonomous')), 'gsd-autonomous folder exists');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-autonomous', 'SKILL.md')), 'gsd-autonomous/SKILL.md exists');

    const skillContent = fs.readFileSync(path.join(skillsDir, 'gsd-autonomous', 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(skillContent);

    // Frontmatter: name converted from gsd:autonomous to gsd-autonomous
    assert.equal(fm.name, 'gsd-autonomous', 'name is gsd-autonomous');
    assert.equal(
      fm.description,
      'Run all remaining phases autonomously — discuss→plan→execute per phase',
      'description preserved (round-trips through #2876 yamlQuote)',
    );
    // argument-hint round-trips
    assert.equal(fm['argument-hint'], '[--from N] [--to N] [--only N] [--interactive] [--converge]', 'argument-hint round-trips');
    // allowed-tools comma-separated
    assert.ok(skillContent.includes('allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, Agent'),
      'allowed-tools is comma-separated');
    // No Claude-format remnants
    assert.ok(!skillContent.includes('allowed-tools:\n  -'), 'NOT YAML multiline format');
    assert.ok(!skillContent.includes('~/.claude/'), 'no ~/.claude/ references in body');
  });

  test('autonomous skill body converts gsd: to gsd- (CONV-07)', () => {
    // Use convertClaudeToCopilotContent directly on the command body content
    const srcContent = fs.readFileSync(path.join(srcDir, 'autonomous.md'), 'utf8');
    const result = convertClaudeToCopilotContent(srcContent);

    // gsd:autonomous references should be converted to gsd-autonomous
    assert.ok(!result.match(/gsd:[a-z]/), 'no gsd: command references remain after conversion');
    // Specific: gsd:discuss-phase, gsd:plan-phase, gsd:execute-phase mentioned in body
    // The body references gsd-tools.cjs (not a gsd: command) — those should be unaffected
    // But /gsd:autonomous → /gsd-autonomous, gsd:discuss-phase → gsd-discuss-phase etc.
    if (srcContent.includes('gsd:autonomous')) {
      assert.ok(result.includes('gsd-autonomous'), 'gsd:autonomous converted to gsd-autonomous');
    }
    // Path conversion: ~/.claude/ → .github/
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ paths remain');
  });

  test('cleans up old skill directories on re-run', () => {
    const skillsDir = path.join(configDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Stale GSD-managed dir must be pruned
    const staleDir = path.join(skillsDir, 'gsd-old-stale-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), 'stale content');

    // Non-GSD dir should survive (installRuntimeArtifacts never prunes non-gsd-*)
    fs.mkdirSync(path.join(skillsDir, 'user-custom'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'user-custom', 'SKILL.md'), 'user content');

    installRuntimeArtifacts('copilot', configDir, 'global', resolvedProfileFull);

    // Real skills are present after install
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-health')), 'real dirs still exist');
    // Stale GSD-prefixed dir is removed by pre-prune
    assert.ok(!fs.existsSync(staleDir), 'stale gsd-* dir removed by pre-prune');
    // Non-GSD dir is preserved
    assert.ok(fs.existsSync(path.join(skillsDir, 'user-custom')), 'non-GSD dir preserved');
  });
});

// ─── Copilot agent conversion - real files ──────────────────────────────────────

describe('Copilot agent conversion - real files', () => {
  const agentsSrc = path.join(__dirname, '..', 'agents');

  test('converts gsd-executor agent correctly', () => {
    const content = fs.readFileSync(path.join(agentsSrc, 'gsd-executor.md'), 'utf8');
    const result = convertClaudeAgentToCopilotAgent(content);

    assert.ok(result.startsWith('---\nname: gsd-executor\n'), 'starts with correct name');
    // Verify deduplication happened and core tools are present (not hardcoded exact list)
    const toolsLine = result.split('\n').find(l => l.startsWith('tools:'));
    assert.ok(toolsLine, 'tools line present in converted output');
    assert.ok(toolsLine.includes("'read'"), 'Read mapped to read');
    assert.ok(toolsLine.includes("'edit'"), 'Write/Edit deduplicated to edit');
    assert.ok(toolsLine.includes("'execute'"), 'Bash mapped to execute');
    assert.ok(toolsLine.includes("'search'"), 'Grep/Glob deduplicated to search');
    // Input tools count > output tools count (deduplication occurred)
    const inputTools = content.match(/^tools:\s*\[([^\]]+)\]/m)?.[1].split(',').length ?? 0;
    const outputTools = toolsLine.replace(/^tools:\s*\[/, '').replace(/\].*$/, '').split(',').length;
    assert.ok(inputTools === 0 || outputTools <= inputTools, 'deduplication reduced or preserved tool count');
    assert.ok(result.includes('color: yellow'), 'color preserved');
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ in body');
  });

  test('converts agent with mcp wildcard tools correctly', () => {
    const content = fs.readFileSync(path.join(agentsSrc, 'gsd-phase-researcher.md'), 'utf8');
    const result = convertClaudeAgentToCopilotAgent(content);

    const toolsLine = result.split('\n').find(l => l.startsWith('tools:'));
    assert.ok(toolsLine.includes('io.github.upstash/context7/*'), 'mcp wildcard mapped in tools');
    assert.ok(!toolsLine.includes('mcp__context7__'), 'no mcp__ prefix in tools line');
    assert.ok(toolsLine.includes("'web'"), 'WebSearch/WebFetch deduplicated to web');
    assert.ok(toolsLine.includes("'read'"), 'Read mapped');
  });

  test('all 18 agents convert without error', () => {
    // Not the shared listAgentFiles() helper: this needs full `.md` filenames
    // (not stripped basenames) to readFileSync each agent below.
    const agents = fs.readdirSync(agentsSrc)
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    const expectedAgentCount = listAgentFiles(agentsSrc).length;
    assert.strictEqual(agents.length, expectedAgentCount, `expected ${expectedAgentCount} agents, got ${agents.length}`);

    for (const agentFile of agents) {
      const content = fs.readFileSync(path.join(agentsSrc, agentFile), 'utf8');
      const result = convertClaudeAgentToCopilotAgent(content);
      assert.ok(result.startsWith('---\n'), `${agentFile} should have frontmatter`);
      assert.ok(result.includes('tools:'), `${agentFile} should have tools field`);
      assert.ok(!result.includes('~/.claude/'), `${agentFile} should not contain ~/.claude/`);
    }
  });
});

// ─── Copilot content conversion - engine files ─────────────────────────────────

describe('Copilot content conversion - engine files', () => {
  test('converts engine .md files correctly (local mode default)', () => {
    const healthMd = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'health.md'), 'utf8'
    );
    const result = convertClaudeToCopilotContent(healthMd);

    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ references remain');
    assert.ok(!result.includes('$HOME/.claude/'), 'no $HOME/.claude/ references remain');
    assert.ok(!result.match(/\/gsd:[a-z]/), 'no /gsd: command references remain');
    assert.ok(!result.match(/(?<!\/)gsd:[a-z]/), 'no bare gsd: command references remain');
    // Local mode: ~ and $HOME resolve to .github (repo-relative, no ./ prefix)
    assert.ok(result.includes('.github/'), 'paths converted to .github for local');
    assert.ok(result.includes('gsd-health'), 'command name converted');
  });

  test('converts engine .md files correctly (global mode)', () => {
    const healthMd = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'health.md'), 'utf8'
    );
    const result = convertClaudeToCopilotContent(healthMd, true);

    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ references remain');
    assert.ok(!result.includes('$HOME/.claude/'), 'no $HOME/.claude/ references remain');
    // Global mode: ~ and $HOME resolve to .copilot
    if (healthMd.includes('$HOME/.claude/')) {
      assert.ok(result.includes('$HOME/.copilot/'), '$HOME path converted to .copilot');
    }
    assert.ok(result.includes('gsd-health'), 'command name converted');
  });

  test('converts engine .cjs files correctly', () => {
    // #3584: bin/lib/*.cjs no longer hardcodes `/gsd:<cmd>` literals — runtime
    // emissions now flow through `runtime-slash.cjs::formatGsdSlash()` which
    // already produces the runtime-routable shape. The Copilot install
    // converter still needs to handle source files that DO contain literal
    // colon-form references (commands/gsd/*.md, workflow .md files, etc.), so
    // assert the converter contract against a synthetic input that mirrors the
    // shape those files have.
    const synthetic = [
      'Run /gsd:new-project to initialize.',
      'On error, run /gsd:health --repair to regenerate.',
      'For phase work, use /gsd:execute-phase 1.',
    ].join('\n');
    const result = convertClaudeToCopilotContent(synthetic);

    assert.ok(!result.match(/gsd:[a-z]/), 'no gsd: references remain after conversion');
    assert.ok(result.includes('gsd-new-project'), 'gsd:new-project converted to hyphen form');
    assert.ok(result.includes('gsd-health'), 'gsd:health converted to hyphen form');
    assert.ok(result.includes('gsd-execute-phase'), 'gsd:execute-phase converted to hyphen form');
  });
});

// ─── Copilot instructions merge/strip ──────────────────────────────────────────

describe('Copilot instructions merge/strip', () => {
  const gsdContent = '- Follow project conventions\n- Use structured workflows';

  function makeGsdBlock(content) {
    return GSD_COPILOT_INSTRUCTIONS_MARKER + '\n' + content.trim() + '\n' + GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER;
  }

  describe('mergeCopilotInstructions', () => {
    let tmpMergeDir;

    beforeEach(() => {
      tmpMergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-merge-'));
    });

    afterEach(() => {
      cleanup(tmpMergeDir);
    });

    test('creates file from scratch when none exists', () => {
      const filePath = path.join(tmpMergeDir, 'copilot-instructions.md');
      mergeCopilotInstructions(filePath, gsdContent);

      assert.ok(fs.existsSync(filePath), 'file was created');
      const result = fs.readFileSync(filePath, 'utf8');
      assert.ok(result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'has opening marker');
      assert.ok(result.includes(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER), 'has closing marker');
      assert.ok(result.includes('Follow project conventions'), 'has GSD content');
    });

    test('replaces GSD section when both markers present', () => {
      const filePath = path.join(tmpMergeDir, 'copilot-instructions.md');
      const oldContent = '# User Setup\n\n' +
        makeGsdBlock('- Old GSD content') +
        '\n\n# User Notes\n';
      fs.writeFileSync(filePath, oldContent);

      mergeCopilotInstructions(filePath, gsdContent);
      const result = fs.readFileSync(filePath, 'utf8');

      assert.ok(result.includes('# User Setup'), 'user content before preserved');
      assert.ok(result.includes('# User Notes'), 'user content after preserved');
      assert.ok(!result.includes('Old GSD content'), 'old GSD content removed');
      assert.ok(result.includes('Follow project conventions'), 'new GSD content inserted');
    });

    test('appends to existing file when no markers present', () => {
      const filePath = path.join(tmpMergeDir, 'copilot-instructions.md');
      const userContent = '# My Custom Instructions\n\nDo things my way.\n';
      fs.writeFileSync(filePath, userContent);

      mergeCopilotInstructions(filePath, gsdContent);
      const result = fs.readFileSync(filePath, 'utf8');

      assert.ok(result.includes('# My Custom Instructions'), 'original content preserved');
      assert.ok(result.includes('Do things my way.'), 'original text preserved');
      assert.ok(result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'GSD block appended');
      assert.ok(result.includes('Follow project conventions'), 'GSD content appended');
      // Verify separator exists
      assert.ok(result.includes('Do things my way.\n\n' + GSD_COPILOT_INSTRUCTIONS_MARKER),
        'double newline separator before GSD block');
    });

    test('handles file that is GSD-only (re-creates cleanly)', () => {
      const filePath = path.join(tmpMergeDir, 'copilot-instructions.md');
      const gsdOnly = makeGsdBlock('- Old instructions') + '\n';
      fs.writeFileSync(filePath, gsdOnly);

      const newContent = '- Updated instructions';
      mergeCopilotInstructions(filePath, newContent);
      const result = fs.readFileSync(filePath, 'utf8');

      assert.ok(!result.includes('Old instructions'), 'old content removed');
      assert.ok(result.includes('Updated instructions'), 'new content present');
      assert.ok(result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'has opening marker');
      assert.ok(result.includes(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER), 'has closing marker');
    });

    test('preserves user content before and after markers', () => {
      const filePath = path.join(tmpMergeDir, 'copilot-instructions.md');
      const content = '# My Setup\n\n' +
        makeGsdBlock('- old content') +
        '\n\n# My Notes\n';
      fs.writeFileSync(filePath, content);

      mergeCopilotInstructions(filePath, gsdContent);
      const result = fs.readFileSync(filePath, 'utf8');

      assert.ok(result.includes('# My Setup'), 'content before markers preserved');
      assert.ok(result.includes('# My Notes'), 'content after markers preserved');
      assert.ok(result.includes('Follow project conventions'), 'new GSD content between markers');
      // Verify ordering: before → GSD → after
      const setupIdx = result.indexOf('# My Setup');
      const markerIdx = result.indexOf(GSD_COPILOT_INSTRUCTIONS_MARKER);
      const notesIdx = result.indexOf('# My Notes');
      assert.ok(setupIdx < markerIdx, 'user setup comes before GSD block');
      assert.ok(markerIdx < notesIdx, 'GSD block comes before user notes');
    });
  });

  describe('stripGsdFromCopilotInstructions', () => {
    test('returns null when content is GSD-only', () => {
      const content = makeGsdBlock('- GSD instructions only') + '\n';
      const result = stripGsdFromCopilotInstructions(content);
      assert.strictEqual(result, null, 'returns null for GSD-only content');
    });

    test('returns cleaned content when user content exists before markers', () => {
      const content = '# My Setup\n\nCustom rules here.\n\n' +
        makeGsdBlock('- GSD stuff') + '\n';
      const result = stripGsdFromCopilotInstructions(content);

      assert.ok(result !== null, 'does not return null');
      assert.ok(result.includes('# My Setup'), 'user content preserved');
      assert.ok(result.includes('Custom rules here.'), 'user text preserved');
      assert.ok(!result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'opening marker removed');
      assert.ok(!result.includes(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER), 'closing marker removed');
      assert.ok(!result.includes('GSD stuff'), 'GSD content removed');
    });

    test('returns cleaned content when user content exists after markers', () => {
      const content = makeGsdBlock('- GSD stuff') + '\n\n# My Notes\n\nPersonal notes.\n';
      const result = stripGsdFromCopilotInstructions(content);

      assert.ok(result !== null, 'does not return null');
      assert.ok(result.includes('# My Notes'), 'user content after preserved');
      assert.ok(result.includes('Personal notes.'), 'user text after preserved');
      assert.ok(!result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'opening marker removed');
      assert.ok(!result.includes('GSD stuff'), 'GSD content removed');
    });

    test('returns cleaned content preserving both before and after', () => {
      const content = '# Before\n\n' + makeGsdBlock('- GSD middle') + '\n\n# After\n';
      const result = stripGsdFromCopilotInstructions(content);

      assert.ok(result !== null, 'does not return null');
      assert.ok(result.includes('# Before'), 'content before preserved');
      assert.ok(result.includes('# After'), 'content after preserved');
      assert.ok(!result.includes('GSD middle'), 'GSD content removed');
      assert.ok(!result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'markers removed');
    });

    test('returns original content when no markers found', () => {
      const content = '# Just user content\n\nNo GSD markers here.\n';
      const result = stripGsdFromCopilotInstructions(content);
      assert.strictEqual(result, content, 'returns content unchanged');
    });
  });
});

// ─── Copilot lifecycle hooks (#786) ────────────────────────────────────────────

describe('Copilot lifecycle hook config (#786)', () => {
  describe('buildCopilotHookConfig', () => {
    test('emits the documented Copilot hooks-config shape', () => {
      const cfg = buildCopilotHookConfig();
      assert.strictEqual(cfg.version, 1, 'version must be 1 per Copilot hooks schema');
      assert.ok(cfg.hooks && typeof cfg.hooks === 'object', 'has hooks object');
      assert.ok(Array.isArray(cfg.hooks.sessionStart), 'sessionStart is an array (camelCase event name)');
      assert.strictEqual(cfg.hooks.sessionStart.length, 1, 'one sessionStart entry');
    });

    test('sessionStart entry is a self-contained inline command hook', () => {
      const [entry] = buildCopilotHookConfig().hooks.sessionStart;
      assert.strictEqual(entry.type, 'command', 'type is command');
      assert.ok(typeof entry.bash === 'string' && entry.bash.length > 0, 'has inline bash body');
      assert.ok(typeof entry.powershell === 'string' && entry.powershell.length > 0, 'has inline powershell body');
      assert.strictEqual(entry.timeoutSec, 10, 'uses timeoutSec (Copilot field), not timeout');
    });

    test('command bodies emit the Copilot sessionStart JSON envelope (additionalContext)', () => {
      // Copilot parses command-hook stdout as JSON; sessionStart schema is
      // { additionalContext?: string }. Bare text would be invalid hook output.
      const [entry] = buildCopilotHookConfig().hooks.sessionStart;
      assert.ok(entry.bash.includes('"additionalContext"'), 'bash body emits additionalContext JSON');
      assert.ok(entry.powershell.includes('"additionalContext"'), 'powershell body emits additionalContext JSON');
    });

    test('executing the bash hook body produces valid sessionStart JSON', { skip: process.platform === 'win32' }, () => {
      const [entry] = buildCopilotHookConfig().hooks.sessionStart;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hook-exec-'));
      try {
        // No .planning/STATE.md → absent branch
        const rAbsent = runHook('-c', [entry.bash], { interpreter: 'bash', cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS });
        throwIfFailed(rAbsent, 'bash -c <sessionStart hook body> (absent branch)');
        const parsedAbsent = JSON.parse(rAbsent.stdout);
        assert.ok(typeof parsedAbsent.additionalContext === 'string', 'absent branch yields additionalContext string');
        assert.ok(/gsd-new-project/.test(parsedAbsent.additionalContext), 'absent branch suggests gsd-new-project');

        // With .planning/STATE.md → present branch
        fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), '# state\n');
        const rPresent = runHook('-c', [entry.bash], { interpreter: 'bash', cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS });
        throwIfFailed(rPresent, 'bash -c <sessionStart hook body> (present branch)');
        const parsedPresent = JSON.parse(rPresent.stdout);
        assert.ok(/STATE\.md present/.test(parsedPresent.additionalContext), 'present branch references STATE.md');
      } finally {
        cleanup(tmp);
      }
    });

    test('hook command references no external script path (cannot dangle)', () => {
      const [entry] = buildCopilotHookConfig().hooks.sessionStart;
      // A dangling hook points at a hook SCRIPT file the installer never wrote.
      // The GSD Copilot hook is inline, so it must not reference hooks/gsd-*.js|sh.
      assert.ok(!/hooks\/gsd-[\w-]+\.(js|cjs|sh)/.test(entry.bash), 'bash body references no gsd hook script file');
      assert.ok(!/hooks\/gsd-[\w-]+\.(js|cjs|sh)/.test(entry.powershell), 'powershell body references no gsd hook script file');
    });

    test('produces valid JSON', () => {
      const json = JSON.stringify(buildCopilotHookConfig());
      assert.doesNotThrow(() => JSON.parse(json), 'config round-trips through JSON');
    });
  });

  describe('writeCopilotHookConfig', () => {
    let tmpHookDir;

    beforeEach(() => {
      tmpHookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-copilot-hook-'));
    });

    afterEach(() => {
      cleanup(tmpHookDir);
    });

    test('writes hooks/gsd-session.json under the config dir', () => {
      const written = writeCopilotHookConfig(tmpHookDir);
      const expected = path.join(tmpHookDir, 'hooks', GSD_COPILOT_HOOK_FILE);
      assert.strictEqual(written, expected, 'returns the written path');
      assert.ok(fs.existsSync(expected), 'hook config file exists');
      const parsed = JSON.parse(fs.readFileSync(expected, 'utf8'));
      assert.strictEqual(parsed.version, 1, 'written file has version 1');
      assert.ok(Array.isArray(parsed.hooks.sessionStart), 'written file has sessionStart array');
    });

    test('is idempotent and overwrites the managed file in place', () => {
      writeCopilotHookConfig(tmpHookDir);
      const hookPath = path.join(tmpHookDir, 'hooks', GSD_COPILOT_HOOK_FILE);
      fs.writeFileSync(hookPath, '{"stale":true}\n');
      writeCopilotHookConfig(tmpHookDir);
      const parsed = JSON.parse(fs.readFileSync(hookPath, 'utf8'));
      assert.strictEqual(parsed.stale, undefined, 'stale content replaced');
      assert.strictEqual(parsed.version, 1, 'managed content restored');
    });

    test('preserves sibling user-authored hook files', () => {
      const hooksDir = path.join(tmpHookDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const userHook = path.join(hooksDir, 'my-hook.json');
      fs.writeFileSync(userHook, '{"version":1,"hooks":{}}\n');
      writeCopilotHookConfig(tmpHookDir);
      assert.ok(fs.existsSync(userHook), 'user hook file untouched');
    });
  });
});

// ─── Copilot uninstall skill removal ───────────────────────────────────────────

describe('Copilot uninstall skill removal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('identifies gsd-* skill directories for removal', () => {
    // Create Copilot-like skills directory structure
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'gsd-foo'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'gsd-foo', 'SKILL.md'), '# Foo');
    fs.mkdirSync(path.join(skillsDir, 'gsd-bar'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'gsd-bar', 'SKILL.md'), '# Bar');
    fs.mkdirSync(path.join(skillsDir, 'custom-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'custom-skill', 'SKILL.md'), '# Custom');

    // Test the pattern: read skills, filter gsd-* entries
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const gsdSkills = entries
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);
    const nonGsdSkills = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('gsd-'))
      .map(e => e.name);

    assert.deepStrictEqual(gsdSkills.sort(), ['gsd-bar', 'gsd-foo'], 'identifies gsd-* skills');
    assert.deepStrictEqual(nonGsdSkills, ['custom-skill'], 'preserves non-gsd skills');
  });

  test('cleans GSD section from copilot-instructions.md on uninstall', () => {
    const content = '# My Setup\n\nMy custom rules.\n\n' +
      GSD_COPILOT_INSTRUCTIONS_MARKER + '\n' +
      '- GSD managed content\n' +
      GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER + '\n';

    const result = stripGsdFromCopilotInstructions(content);

    assert.ok(result !== null, 'does not return null when user content exists');
    assert.ok(result.includes('# My Setup'), 'user content preserved');
    assert.ok(result.includes('My custom rules.'), 'user text preserved');
    assert.ok(!result.includes('GSD managed content'), 'GSD content removed');
    assert.ok(!result.includes(GSD_COPILOT_INSTRUCTIONS_MARKER), 'markers removed');
  });

  test('deletes copilot-instructions.md when GSD-only on uninstall', () => {
    const content = GSD_COPILOT_INSTRUCTIONS_MARKER + '\n' +
      '- Only GSD content\n' +
      GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER + '\n';

    const result = stripGsdFromCopilotInstructions(content);

    assert.strictEqual(result, null, 'returns null signaling file deletion');
  });
});

// ─── Copilot manifest and patches fixes ────────────────────────────────────────

describe('Copilot manifest and patches fixes', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-manifest-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writeManifest hashes skills for Copilot runtime', () => {
    // Create minimal gsd-core dir (required by writeManifest)
    const gsdDir = path.join(tmpDir, 'gsd-core', 'bin');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'verify.cjs'), '// verify stub');

    // Create Copilot skills directory
    const skillDir = path.join(tmpDir, 'skills', 'gsd-test');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n\nA test skill.');

    writeManifest(tmpDir, 'copilot');

    // Check manifest file was written
    const manifestPath = path.join(tmpDir, 'gsd-file-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest file created');

    // Read and verify skills are hashed
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const skillKey = 'skills/gsd-test/SKILL.md';
    assert.ok(data.files[skillKey], 'skill file hashed in manifest');
    assert.ok(typeof data.files[skillKey] === 'string', 'hash is a string');
    assert.ok(data.files[skillKey].length === 64, 'hash is SHA-256 (64 hex chars)');
  });

  describe('reportLocalPatches', () => {
    let originalLog;
    let logs;

    beforeEach(() => {
      originalLog = console.log;
      logs = [];
      console.log = (...args) => logs.push(args.join(' '));
    });

    afterEach(() => {
      console.log = originalLog;
    });

    test('reportLocalPatches shows /gsd-update --reapply for Copilot', () => {
      // Create patches directory with metadata
      const patchesDir = path.join(tmpDir, 'gsd-local-patches');
      fs.mkdirSync(patchesDir, { recursive: true });
      fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({
        from_version: '1.0',
        files: ['skills/gsd-test/SKILL.md']
      }));

      const result = reportLocalPatches(tmpDir, 'copilot');

      assert.ok(result.length > 0, 'returns patched files list');
      const output = logs.join('\n');
      // Asserts the consolidated form. /gsd-reapply-patches was removed in
      // 1.39 (PR #2824) and folded into a flag on /gsd-update — see #3010.
      // Negative assertion guards against regression to the dead command.
      assert.ok(output.includes('/gsd-update --reapply'), 'uses consolidated /gsd-update --reapply form for Copilot');
      assert.ok(!output.includes('/gsd-reapply-patches'), 'does not reference removed /gsd-reapply-patches command');
      assert.ok(!output.includes('/gsd:reapply-patches'), 'does not use colon format');
    });

    test('reportLocalPatches shows /gsd-update --reapply for Claude', () => {
      // Create patches directory with metadata
      const patchesDir = path.join(tmpDir, 'gsd-local-patches');
      fs.mkdirSync(patchesDir, { recursive: true });
      fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({
        from_version: '1.0',
        files: ['gsd-core/bin/verify.cjs']
      }));

      const result = reportLocalPatches(tmpDir, 'claude');

      assert.ok(result.length > 0, 'returns patched files list');
      const output = logs.join('\n');
      assert.ok(output.includes('/gsd-update --reapply'), 'uses consolidated /gsd-update --reapply form for Claude');
      assert.ok(!output.includes('/gsd-reapply-patches'), 'does not reference removed /gsd-reapply-patches command');
      assert.ok(!output.includes('/gsd:reapply-patches'), 'does not use colon format for Claude');
    });
  });
});

// ============================================================================
// E2E Integration Tests — Copilot Install & Uninstall
// ============================================================================

const crypto = require('crypto');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const INSTALL_PATH = path.join(__dirname, '..', 'bin', 'install.js');
const EXPECTED_SKILLS = fs.readdirSync(path.join(__dirname, '..', 'commands', 'gsd'))
  .filter(f => f.endsWith('.md')).length;
// Source-roster count (gsd-*.md basenames) — shared helper.
const EXPECTED_AGENTS = listAgentFiles().length;

// #3145: class-norm timeouts, not per-suite values — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function runCopilotInstall(cwd) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--copilot', '--local', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --copilot --local --no-sdk`);
  return r.stdout;
}

function runCopilotUninstall(cwd) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--copilot', '--local', '--uninstall', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --copilot --local --uninstall --no-sdk`);
  return r.stdout;
}

describe('E2E: Copilot full install verification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-'));
    runCopilotInstall(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('installs expected number of skill directories', () => {
    const skillsDir = path.join(tmpDir, '.github', 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const gsdSkills = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.strictEqual(gsdSkills.length, EXPECTED_SKILLS,
      `Expected ${EXPECTED_SKILLS} skill directories, got ${gsdSkills.length}`);
  });

  test('each skill directory contains SKILL.md', () => {
    const skillsDir = path.join(tmpDir, '.github', 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const gsdSkills = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    for (const skill of gsdSkills) {
      const skillMdPath = path.join(skillsDir, skill.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillMdPath),
        `Missing SKILL.md in ${skill.name}`);
    }
  });

  test('installs expected number of agent files', () => {
    const agentsDir = path.join(tmpDir, '.github', 'agents');
    const files = fs.readdirSync(agentsDir);
    const gsdAgents = files.filter(f => f.startsWith('gsd-') && f.endsWith('.agent.md'));
    assert.strictEqual(gsdAgents.length, EXPECTED_AGENTS,
      `Expected ${EXPECTED_AGENTS} agent files, got ${gsdAgents.length}`);
  });

  test('installs all expected agent files', () => {
    const agentsDir = path.join(tmpDir, '.github', 'agents');
    const files = fs.readdirSync(agentsDir);
    const gsdAgents = files.filter(f => f.startsWith('gsd-') && f.endsWith('.agent.md')).sort();
    const expected = [
      'gsd-advisor-researcher.agent.md',
      'gsd-ai-researcher.agent.md',
      'gsd-assumptions-analyzer.agent.md',
      'gsd-code-fixer.agent.md',
      'gsd-code-reviewer.agent.md',
      'gsd-codebase-mapper.agent.md',
      'gsd-debug-session-manager.agent.md',
      'gsd-debugger.agent.md',
      'gsd-doc-classifier.agent.md',
      'gsd-doc-synthesizer.agent.md',
      'gsd-doc-verifier.agent.md',
      'gsd-doc-writer.agent.md',
      'gsd-domain-researcher.agent.md',
      'gsd-eval-auditor.agent.md',
      'gsd-eval-planner.agent.md',
      'gsd-executor.agent.md',
      'gsd-framework-selector.agent.md',
      'gsd-integration-checker.agent.md',
      'gsd-intel-updater.agent.md',
      'gsd-mempalace-curator.agent.md',
      'gsd-nyquist-auditor.agent.md',
      'gsd-pattern-mapper.agent.md',
      'gsd-phase-researcher.agent.md',
      'gsd-plan-checker.agent.md',
      'gsd-planner.agent.md',
      'gsd-project-researcher.agent.md',
      'gsd-research-synthesizer.agent.md',
      'gsd-roadmapper.agent.md',
      'gsd-security-auditor.agent.md',
      'gsd-ui-auditor.agent.md',
      'gsd-ui-checker.agent.md',
      'gsd-ui-researcher.agent.md',
      'gsd-user-profiler.agent.md',
      'gsd-verifier.agent.md',
    ].sort();
    assert.deepStrictEqual(gsdAgents, expected);
  });

  test('generates copilot-instructions.md with GSD markers', () => {
    const instrPath = path.join(tmpDir, '.github', 'copilot-instructions.md');
    assert.ok(fs.existsSync(instrPath), 'copilot-instructions.md should exist');
    const content = fs.readFileSync(instrPath, 'utf-8');
    assert.ok(content.includes('<!-- GSD Configuration'),
      'Should contain GSD Configuration open marker');
    assert.ok(content.includes('<!-- /GSD Configuration -->'),
      'Should contain GSD Configuration close marker');
  });

  test('emits AGENTS.md at the repo root with GSD markers (#786)', () => {
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    assert.ok(fs.existsSync(agentsMdPath), 'AGENTS.md should exist at repo root for local install');
    const content = fs.readFileSync(agentsMdPath, 'utf-8');
    assert.ok(content.includes('<!-- GSD Configuration'), 'AGENTS.md has GSD open marker');
    assert.ok(content.includes('<!-- /GSD Configuration -->'), 'AGENTS.md has GSD close marker');
  });

  test('emits a Copilot lifecycle hook config (#786)', () => {
    const hookPath = path.join(tmpDir, '.github', 'hooks', 'gsd-session.json');
    assert.ok(fs.existsSync(hookPath), '.github/hooks/gsd-session.json should exist');
    const cfg = JSON.parse(fs.readFileSync(hookPath, 'utf-8'));
    assert.strictEqual(cfg.version, 1, 'hook config has version 1');
    assert.ok(Array.isArray(cfg.hooks.sessionStart), 'hook config has sessionStart array');
    assert.strictEqual(cfg.hooks.sessionStart[0].type, 'command', 'sessionStart is a command hook');
  });

  test('creates manifest with correct structure', () => {
    const manifestPath = path.join(tmpDir, '.github', 'gsd-file-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'gsd-file-manifest.json should exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(manifest.version, 'manifest should have version');
    assert.ok(manifest.timestamp, 'manifest should have timestamp');
    assert.ok(manifest.files && typeof manifest.files === 'object',
      'manifest should have files object');
    assert.ok(Object.keys(manifest.files).length > 0,
      'manifest files should not be empty');
  });

  test('manifest contains expected file categories', () => {
    const manifestPath = path.join(tmpDir, '.github', 'gsd-file-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const keys = Object.keys(manifest.files);

    const skillEntries = keys.filter(k => k.startsWith('skills/'));
    const agentEntries = keys.filter(k => k.startsWith('agents/'));
    const engineEntries = keys.filter(k => k.startsWith('gsd-core/'));

    assert.strictEqual(skillEntries.length, EXPECTED_SKILLS,
      `Expected ${EXPECTED_SKILLS} skill manifest entries, got ${skillEntries.length}`);
    assert.strictEqual(agentEntries.length, EXPECTED_AGENTS,
      `Expected ${EXPECTED_AGENTS} agent manifest entries, got ${agentEntries.length}`);
    assert.ok(engineEntries.length > 0,
      'Should have gsd-core/ engine manifest entries');
  });

  test('manifest SHA256 hashes match actual file contents', () => {
    const manifestPath = path.join(tmpDir, '.github', 'gsd-file-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const githubDir = path.join(tmpDir, '.github');

    for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
      const filePath = path.join(githubDir, relPath);
      assert.ok(fs.existsSync(filePath),
        `Manifest references ${relPath} but file does not exist`);
      const content = fs.readFileSync(filePath);
      const actualHash = crypto.createHash('sha256').update(content).digest('hex');
      assert.strictEqual(actualHash, expectedHash,
        `SHA256 mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`);
    }
  });

  test('engine directory contains required subdirectories and files', () => {
    const engineDir = path.join(tmpDir, '.github', 'gsd-core');
    const requiredDirs = ['bin', 'references', 'templates', 'workflows'];
    const requiredFiles = ['CHANGELOG.md', 'VERSION'];

    for (const dir of requiredDirs) {
      const dirPath = path.join(engineDir, dir);
      assert.ok(fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory(),
        `Engine should contain directory: ${dir}`);
    }
    for (const file of requiredFiles) {
      const filePath = path.join(engineDir, file);
      assert.ok(fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
        `Engine should contain file: ${file}`);
    }
  });
});

describe('E2E: Copilot uninstall verification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-'));
    runCopilotInstall(tmpDir);
    runCopilotUninstall(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes engine directory', () => {
    const engineDir = path.join(tmpDir, '.github', 'gsd-core');
    assert.ok(!fs.existsSync(engineDir),
      'gsd-core directory should not exist after uninstall');
  });

  test('removes copilot-instructions.md', () => {
    const instrPath = path.join(tmpDir, '.github', 'copilot-instructions.md');
    assert.ok(!fs.existsSync(instrPath),
      'copilot-instructions.md should not exist after uninstall');
  });

  test('removes all GSD skill directories', () => {
    const skillsDir = path.join(tmpDir, '.github', 'skills');
    if (fs.existsSync(skillsDir)) {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const gsdSkills = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(gsdSkills.length, 0,
        `Expected 0 GSD skill directories after uninstall, found: ${gsdSkills.map(e => e.name).join(', ')}`);
    }
  });

  test('removes all GSD agent files', () => {
    const agentsDir = path.join(tmpDir, '.github', 'agents');
    if (fs.existsSync(agentsDir)) {
      const files = fs.readdirSync(agentsDir);
      const gsdAgents = files.filter(f => f.startsWith('gsd-') && f.endsWith('.agent.md'));
      assert.strictEqual(gsdAgents.length, 0,
        `Expected 0 GSD agent files after uninstall, found: ${gsdAgents.join(', ')}`);
    }
  });

  test('removes the Copilot lifecycle hook config (#786)', () => {
    const hookPath = path.join(tmpDir, '.github', 'hooks', 'gsd-session.json');
    assert.ok(!fs.existsSync(hookPath), 'gsd-session.json should not exist after uninstall');
  });

  test('removes GSD-only AGENTS.md (#786)', () => {
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    assert.ok(!fs.existsSync(agentsMdPath), 'GSD-only AGENTS.md should be removed after uninstall');
  });

  describe('preserves non-GSD content', () => {
    let td;

    beforeEach(() => {
      td = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-preserve-'));
      runCopilotInstall(td);
    });

    afterEach(() => {
      cleanup(td);
    });

    test('preserves non-GSD content in skills directory', () => {
      // Add non-GSD custom skill
      const customSkillDir = path.join(td, '.github', 'skills', 'my-custom-skill');
      fs.mkdirSync(customSkillDir, { recursive: true });
      fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');
      // Uninstall
      runCopilotUninstall(td);
      // Verify custom content preserved
      assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')),
        'Non-GSD skill directory and SKILL.md should be preserved after uninstall');
    });

    test('preserves non-GSD content in agents directory', () => {
      // Add non-GSD custom agent
      const customAgentPath = path.join(td, '.github', 'agents', 'my-agent.md');
      fs.writeFileSync(customAgentPath, '# My Custom Agent\n');
      // Uninstall
      runCopilotUninstall(td);
      // Verify custom content preserved
      assert.ok(fs.existsSync(customAgentPath),
        'Non-GSD agent file should be preserved after uninstall');
    });

    test('preserves user-authored content in AGENTS.md on uninstall (#786)', () => {
      // After install, AGENTS.md exists with the GSD block. Prepend user content.
      const agentsMdPath = path.join(td, 'AGENTS.md');
      assert.ok(fs.existsSync(agentsMdPath), 'AGENTS.md created by install');
      const gsdBlock = fs.readFileSync(agentsMdPath, 'utf-8');
      fs.writeFileSync(agentsMdPath, '# My Project Notes\n\nKeep these.\n\n' + gsdBlock);
      // Uninstall strips only the GSD section
      runCopilotUninstall(td);
      assert.ok(fs.existsSync(agentsMdPath), 'AGENTS.md preserved (had user content)');
      const after = fs.readFileSync(agentsMdPath, 'utf-8');
      assert.ok(after.includes('# My Project Notes'), 'user content preserved');
      assert.ok(!after.includes('<!-- GSD Configuration'), 'GSD section stripped');
    });

    test('preserves a user-authored sibling hook file on uninstall (#786)', () => {
      const userHook = path.join(td, '.github', 'hooks', 'user-hook.json');
      fs.writeFileSync(userHook, '{"version":1,"hooks":{}}\n');
      runCopilotUninstall(td);
      assert.ok(fs.existsSync(userHook), 'user-authored hook file preserved');
    });
  });
});

// ─── E2E: Copilot global scope (#786) ──────────────────────────────────────────

function runCopilotInstallGlobal(cwd, configDir) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode(
    [INSTALL_PATH, '--copilot', '--global', '--config-dir', configDir, '--no-sdk'],
    { cwd, env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  throwIfFailed(r, `node ${INSTALL_PATH} --copilot --global --config-dir ${configDir} --no-sdk`);
  return r.stdout;
}

function runCopilotUninstallGlobal(cwd, configDir) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode(
    [INSTALL_PATH, '--copilot', '--global', '--config-dir', configDir, '--uninstall', '--no-sdk'],
    { cwd, env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  throwIfFailed(r, `node ${INSTALL_PATH} --copilot --global --config-dir ${configDir} --uninstall --no-sdk`);
  return r.stdout;
}

describe('E2E: Copilot global install (#786)', () => {
  let projectDir;
  let configDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-gproj-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-gcfg-'));
    runCopilotInstallGlobal(projectDir, configDir);
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(configDir);
  });

  test('writes the lifecycle hook config under the global config dir', () => {
    const hookPath = path.join(configDir, 'hooks', 'gsd-session.json');
    assert.ok(fs.existsSync(hookPath), 'global hook config should exist under config dir');
    const cfg = JSON.parse(fs.readFileSync(hookPath, 'utf-8'));
    assert.strictEqual(cfg.version, 1, 'hook config version is 1');
    assert.ok(Array.isArray(cfg.hooks.sessionStart), 'has sessionStart array');
  });

  test('does NOT emit AGENTS.md for global scope (no repo-root home)', () => {
    assert.ok(!fs.existsSync(path.join(projectDir, 'AGENTS.md')),
      'global install must not write AGENTS.md into the working directory');
    assert.ok(!fs.existsSync(path.join(configDir, 'AGENTS.md')),
      'global install must not write AGENTS.md into the config directory');
  });

  test('global uninstall removes the lifecycle hook config', () => {
    runCopilotUninstallGlobal(projectDir, configDir);
    const hookPath = path.join(configDir, 'hooks', 'gsd-session.json');
    assert.ok(!fs.existsSync(hookPath), 'global hook config removed after uninstall');
  });
});

// ─── Claude uninstall: user file preservation (#1423) ─────────────────────────

function runClaudeInstall(cwd) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--claude', '--local', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --claude --local --no-sdk`);
  return r.stdout;
}

function runClaudeUninstall(cwd) {
  // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
  // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
  const { installSpawnEnv } = require('./helpers.cjs');
  const env = installSpawnEnv();
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--claude', '--local', '--uninstall', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --claude --local --uninstall --no-sdk`);
  return r.stdout;
}

describe('Claude uninstall preserves user-generated files (#1423)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-preserve-'));
    runClaudeInstall(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('preserves USER-PROFILE.md across uninstall', () => {
    const profilePath = path.join(tmpDir, '.claude', 'gsd-core', 'USER-PROFILE.md');
    const content = '# Developer Profile\n\nAutonomy: High\nGenerated: 2026-03-29\n';
    fs.writeFileSync(profilePath, content);

    runClaudeUninstall(tmpDir);

    assert.ok(fs.existsSync(profilePath), 'USER-PROFILE.md should survive uninstall');
    assert.strictEqual(fs.readFileSync(profilePath, 'utf-8'), content, 'content should be identical');
  });

  test('preserves dev-preferences.md across uninstall', () => {
    const prefsDir = path.join(tmpDir, '.claude', 'commands', 'gsd');
    fs.mkdirSync(prefsDir, { recursive: true });
    const prefsPath = path.join(prefsDir, 'dev-preferences.md');
    const content = '---\nname: dev-preferences\n---\n# Preferences\nUse TypeScript strict.\n';
    fs.writeFileSync(prefsPath, content);

    runClaudeUninstall(tmpDir);

    assert.ok(fs.existsSync(prefsPath), 'dev-preferences.md should survive uninstall');
    assert.strictEqual(fs.readFileSync(prefsPath, 'utf-8'), content, 'content should be identical');
  });

  test('still removes GSD engine files during uninstall', () => {
    const profilePath = path.join(tmpDir, '.claude', 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# Profile\n');

    // Verify engine files exist before uninstall
    const binDir = path.join(tmpDir, '.claude', 'gsd-core', 'bin');
    assert.ok(fs.existsSync(binDir), 'bin/ should exist before uninstall');

    runClaudeUninstall(tmpDir);

    // Engine files gone, user file preserved
    assert.ok(!fs.existsSync(binDir), 'bin/ should be removed after uninstall');
    assert.ok(fs.existsSync(profilePath), 'USER-PROFILE.md should survive');
  });

  test('clean uninstall when no user files exist', () => {
    runClaudeUninstall(tmpDir);

    const gsdDir = path.join(tmpDir, '.claude', 'gsd-core');
    const cmdDir = path.join(tmpDir, '.claude', 'commands', 'gsd');
    // Directories should be fully removed when no user files to preserve
    assert.ok(!fs.existsSync(gsdDir), 'gsd-core/ should not exist after clean uninstall');
    assert.ok(!fs.existsSync(cmdDir), 'commands/gsd/ should not exist after clean uninstall');
  });
});

// ─── #1182 regression: agent converters accessible via module path ────────────
// These tests require convertClaudeAgentToCopilotAgent and its dependency closure
// (claudeToCopilotTools, convertCopilotToolName) THROUGH the runtime-artifact-conversion
// module export — not via bin/install.js. Before the fix, the module returned
// undefined for all three, causing ReferenceError when called.

describe('#1182 convertClaudeAgentToCopilotAgent exported from runtime-artifact-conversion module', () => {
  const _gsdLibDirModule = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
  const conversionModule = require(path.join(_gsdLibDirModule, 'runtime-artifact-conversion.cjs'));

  test('module exports claudeToCopilotTools table', () => {
    assert.strictEqual(typeof conversionModule.claudeToCopilotTools, 'object', 'claudeToCopilotTools must be exported');
    assert.ok(conversionModule.claudeToCopilotTools !== null, 'not null');
    assert.strictEqual(conversionModule.claudeToCopilotTools['Read'], 'read', 'Read maps to read');
    assert.strictEqual(conversionModule.claudeToCopilotTools['Bash'], 'execute', 'Bash maps to execute');
  });

  test('module exports convertCopilotToolName function', () => {
    assert.strictEqual(typeof conversionModule.convertCopilotToolName, 'function', 'convertCopilotToolName must be exported');
    assert.strictEqual(conversionModule.convertCopilotToolName('Read'), 'read', 'maps Read -> read');
    assert.strictEqual(conversionModule.convertCopilotToolName('Bash'), 'execute', 'maps Bash -> execute');
    assert.strictEqual(conversionModule.convertCopilotToolName('mcp__context7__resolve-library-id'), 'io.github.upstash/context7/resolve-library-id', 'mcp__context7__ prefix mapped');
  });

  test('module exports convertClaudeAgentToCopilotAgent function', () => {
    assert.strictEqual(typeof conversionModule.convertClaudeAgentToCopilotAgent, 'function', 'convertClaudeAgentToCopilotAgent must be exported');
  });

  test('convertClaudeAgentToCopilotAgent via module produces correct output (local mode)', () => {
    const input = `---\nname: gsd-executor\ndescription: Executes GSD plans\ntools: Read, Write, Edit, Bash, Grep, Glob\ncolor: yellow\n---\n\nAgent body.`;
    const result = conversionModule.convertClaudeAgentToCopilotAgent(input);
    // Tools must be mapped and deduplicated
    assert.ok(result.includes("tools: ['read', 'edit', 'execute', 'search']"), `expected mapped tools in: ${result}`);
    assert.ok(result.includes('name: gsd-executor'), 'name preserved');
    assert.ok(result.includes('color: yellow'), 'color preserved');
  });

  test('convertClaudeAgentToCopilotAgent via module applies path/command conversions (global mode)', () => {
    const input = `---\nname: gsd-test\ndescription: Test\ntools: Read\n---\n\nCheck ~/.claude/settings and run gsd:health.`;
    const result = conversionModule.convertClaudeAgentToCopilotAgent(input, true);
    assert.ok(result.includes('~/.copilot/settings'), 'CONV-06 applied in global mode');
    assert.ok(result.includes('gsd-health'), 'CONV-07 applied');
  });

  // Parity assertion: claudeToCopilotTools in module matches the table in bin/install.js
  // Per DEFECT.GENERATIVE-FIX: shared constant across two surfaces needs a parity guard.
  test('claudeToCopilotTools parity: module table matches bin/install.js table', () => {
    const installJs = require('../bin/install.js');
    const moduleTable = conversionModule.claudeToCopilotTools;
    const installTable = installJs.claudeToCopilotTools;
    assert.deepStrictEqual(
      moduleTable,
      installTable,
      'claudeToCopilotTools must be identical in module and bin/install.js',
    );
  });
});
