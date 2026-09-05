'use strict';

// allow-test-rule: source-text-is-the-product (see #3384) — this suite asserts on the literal
// frontmatter of EMITTED install artifacts (installed agent .md files), which ARE the deployed
// contract: an mcp__* grant that survives install is treated by ZCode's dispatcher as a
// required-but-must-be-connected MCP server and hard-fails every subagent spawn.

/**
 * zcode-agent-mcp-grants.install.test.cjs — 50-test-matrix.md rows 1-4 (issue #3384).
 *
 * ZCode's subagent dispatcher treats every `mcp__<server>__*` entry in an agent's
 * `tools:` frontmatter as a REQUIRED MCP server and throws CONFIGURATION_ERROR on
 * spawn when it is not connected. Claude Code treats the same grants as an optional
 * allowlist, which is why the GSD sources carry them. The install must therefore
 * filter `mcp__*` entries out of the tools list for ZCode — the same outcome Kimi
 * already gets via its own conversion path — while leaving Claude Code's verbatim
 * copy untouched.
 *
 * Every row spawns a REAL installer and asserts on the parsed frontmatter of what
 * actually reached disk (behavioral seam — never on which internal converter ran).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');
const { buildOverlayRepo } = require('./helpers/overlay-repo.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');

/** The 8 MCP-granted agents named in the issue. Every one hard-fails spawn on
 *  ZCode with zero MCP servers configured, so every one must install clean. */
const MCP_GRANTED_AGENTS = [
  'gsd-phase-researcher',
  'gsd-project-researcher',
  'gsd-ui-researcher',
  'gsd-advisor-researcher',
  'gsd-domain-researcher',
  'gsd-ai-researcher',
  'gsd-planner',
  'gsd-executor',
];

/** Parse the `tools:` grant list out of an agent .md's YAML frontmatter.
 *  Handles both shapes GSD emits: inline comma list (`tools: A, B, C`) and
 *  YAML block list (`tools:\n  - A\n  - B`). Returns [] when the agent
 *  declares no tools. */
function parseFrontmatterTools(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return [];
  const tools = [];
  let collecting = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break; // end of frontmatter
    if (collecting) {
      const itemMatch = /^(\s*)-\s*(\S.*)$/.exec(line);
      if (itemMatch && itemMatch[1].length <= 2) {
        tools.push(itemMatch[2].trim());
        continue;
      }
      collecting = false; // a non-list line ends the block list
    }
    const inlineMatch = /^tools:[ \t]*(.*)$/.exec(line);
    if (inlineMatch) {
      const value = inlineMatch[1].trim();
      if (value) {
        for (const tool of value.split(',')) {
          const name = tool.trim();
          if (name) tools.push(name);
        }
      } else {
        collecting = true; // `tools:` alone starts a block list
      }
    }
  }
  return tools;
}

/** Spawn a real install of one runtime at one scope. Mirrors the seam shape of
 *  tests/agent-fragments-emission.install.test.cjs. Returns { result, root }
 *  where root is the install root (config dir for global, project cwd for local). */
function spawnInstall(runtime, scope, repoRoot = REPO_ROOT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-3384-${runtime}-${scope}-`));
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', path.join(repoRoot, 'bin', 'install.js'), `--${runtime}`];
  if (scope === 'global') {
    args.push('--global', '--config-dir', root);
  } else {
    args.push('--local');
  }
  const seamResult = runNode(args, {
    cwd: root,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return { result: seamResult, root };
}

/** Locate an installed agent file for a runtime install root: global installs
 *  land at <configDir>/agents/<name>.md, local installs at <cwd>/.zcode/agents/<name>.md. */
function installedAgentPath(root, scope, agentName) {
  return scope === 'global'
    ? path.join(root, 'agents', `${agentName}.md`)
    : path.join(root, '.zcode', 'agents', `${agentName}.md`);
}

/** Rows 1/2 + row 3 (anti-vacuity) for one scope. Caller owns root cleanup. */
function assertZcodeAgentsClean(t, scope) {
  const { result, root } = spawnInstall('zcode', scope);
  t.after(() => cleanup(root));

  assert.strictEqual(result.exitCode, 0,
    `zcode ${scope} install must succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  for (const agentName of MCP_GRANTED_AGENTS) {
    const agentPath = installedAgentPath(root, scope, agentName);
    assert.ok(fs.existsSync(agentPath), `zcode ${scope} install must write ${path.relative(root, agentPath)}`);
    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.startsWith('---\n'),
      `${agentName} (${scope}): installed agent must carry YAML frontmatter (starts: ${JSON.stringify(content.slice(0, 20))})`);
    const tools = parseFrontmatterTools(content);
    assert.ok(tools.length > 0,
      `${agentName} (${scope}): tools list must not be emptied by the mcp__ filter`);

    const mcpGrants = tools.filter((tool) => tool.startsWith('mcp__'));
    assert.deepStrictEqual(mcpGrants, [],
      `${agentName} (${scope}): installed tools must declare zero mcp__* grants — ZCode's dispatcher ` +
      `treats each as a required MCP server and hard-fails the spawn when unconnected. Found: ${mcpGrants.join(', ')}`);

    // Row 3 anti-vacuity: the filter must strip ONLY the mcp__* entries, never the
    // whole grant list — every one of these agents needs its core tools to function.
    for (const coreTool of ['Read', 'Bash']) {
      assert.ok(tools.includes(coreTool),
        `${agentName} (${scope}): non-MCP tool '${coreTool}' must survive the filter (found: ${tools.join(', ')})`);
    }
  }
}

// ─── Rows 1/2: a fresh ZCode install carries zero mcp__* grants (both scopes) ──

test('zcode global install: all 8 MCP-granted agents install with zero mcp__* tool grants (#3384)', (t) => {
  assertZcodeAgentsClean(t, 'global');
});

test('zcode local install: all 8 MCP-granted agents install with zero mcp__* tool grants (#3384)', (t) => {
  assertZcodeAgentsClean(t, 'local');
});

function zcodeFixture(tools) {
  return `---\nname: gsd-phase-researcher\ndescription: ZCode quoted-MCP fixture\ntools: ${tools}\n---\n\nfixture body survives\n`;
}

function zcodeBlockFixture(items) {
  return `---\nname: gsd-phase-researcher\ndescription: ZCode quoted-MCP fixture\ntools:\n${items.map((item) => `  - ${item}`).join('\n')}\n---\n\nfixture body survives\n`;
}

test('zcode treats quoted MCP scalars as equivalent to plain scalars (#4189)', (t) => {
  const cases = [
    { name: 'mixed inline', source: zcodeFixture('Read, mcp__server__plain, \'mcp__server__single\', "mcp__server__double"'), expected: 'tools: Read' },
    { name: 'escaped inline', source: zcodeFixture('Read, "\\x6dcp__server__tool"'), expected: 'tools: Read' },
    { name: 'escaped inline unicode-16', source: zcodeFixture('Read, "\\u006dcp__server__tool"'), expected: 'tools: Read' },
    { name: 'escaped inline unicode-32', source: zcodeFixture('Read, "\\U0000006dcp__server__tool"'), expected: 'tools: Read' },
    { name: 'commented inline', source: zcodeFixture('Read, "mcp__server__double" # note'), expected: 'tools: Read' },
    { name: 'all inline', source: zcodeFixture('\'mcp__server__single\', "mcp__server__double"'), expected: null },
    { name: 'mixed block', source: zcodeBlockFixture(['Read', 'mcp__server__plain', "'mcp__server__single'", '"mcp__server__double"']), expected: 'tools:\n  - Read' },
    { name: 'escaped block', source: zcodeBlockFixture(['Read', '"\\x6dcp__server__tool"']), expected: 'tools:\n  - Read' },
    { name: 'escaped block unicode-16', source: zcodeBlockFixture(['Read', '"\\u006dcp__server__tool"']), expected: 'tools:\n  - Read' },
    { name: 'escaped block unicode-32', source: zcodeBlockFixture(['Read', '"\\U0000006dcp__server__tool"']), expected: 'tools:\n  - Read' },
    { name: 'commented block', source: zcodeBlockFixture(['Read', '"mcp__server__double" # note']), expected: 'tools:\n  - Read' },
    { name: 'all block', source: zcodeBlockFixture(["'mcp__server__single'", '"mcp__server__double"']), expected: null },
  ];

  for (const row of cases) {
    const overlay = buildOverlayRepo({ 'agents/gsd-phase-researcher.md': row.source });
    t.after(() => cleanup(overlay));
    const { result, root } = spawnInstall('zcode', 'global', overlay);
    t.after(() => cleanup(root));
    assert.strictEqual(result.exitCode, 0, `${row.name}: zcode install must succeed\n${result.stderr}`);
    const emitted = fs.readFileSync(path.join(root, 'agents', 'gsd-phase-researcher.md'), 'utf8');
    assert.ok(!emitted.includes('mcp__server__'), `${row.name}: all semantic MCP entries must be removed`);
    assert.ok(!emitted.includes('\\x6dcp__server__'), `${row.name}: YAML-escaped semantic MCP entries must be removed`);
    assert.ok(emitted.includes('fixture body survives'), `${row.name}: unrelated body bytes must survive`);
    if (row.expected === null) assert.ok(!/^tools:/m.test(emitted), `${row.name}: all-MCP lists must drop tools`);
    else assert.ok(emitted.includes(row.expected), `${row.name}: non-MCP tool formatting must survive`);
  }
});

// ─── Row 4: Claude Code parity — its mcp__* grants are an OPTIONAL allowlist ───

test('claude global install still carries mcp__* grants (optional-allowlist semantics untouched by #3384)', (t) => {
  const { result, root } = spawnInstall('claude', 'global');
  t.after(() => cleanup(root));
  assert.strictEqual(result.exitCode, 0,
    `claude global install must succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const agentPath = path.join(root, 'agents', 'gsd-phase-researcher.md');
  assert.ok(fs.existsSync(agentPath), 'claude global install must write agents/gsd-phase-researcher.md');
  const tools = parseFrontmatterTools(fs.readFileSync(agentPath, 'utf8'));
  assert.ok(
    tools.some((tool) => tool.startsWith('mcp__')),
    `claude's own install must keep its mcp__* optional-allowlist grants verbatim (found tools: ${tools.join(', ')})`,
  );
});
