'use strict';

// allow-test-rule: source-text-is-the-product (#4032) — these assertions read
// emitted installer artifacts, the deployed agent contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function parseTools(content) {
  const lines = content.split(/\r?\n/);
  const tools = [];
  let collecting = false;
  for (let index = 1; index < lines.length && lines[index] !== '---'; index += 1) {
    const line = lines[index];
    if (collecting) {
      const item = /^([ \t]*)-[ \t]*(\S.*)$/.exec(line);
      if (item) {
        tools.push(parseScalar(item[2].trim()));
        continue;
      }
      collecting = false;
    }
    const inline = /^tools:[ \t]*(.*)$/.exec(line);
    if (!inline) continue;
    if (inline[1].trim()) tools.push(...inline[1].split(',').map((value) => parseScalar(value.trim())));
    else collecting = true;
  }
  return tools;
}

function parseScalar(value) {
  return value.startsWith('"') ? JSON.parse(value) : value;
}

function installClaude(t, { defaults, projectConfig } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4032-claude-'));
  t.after(() => cleanup(root));
  if (defaults !== undefined) {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'defaults.json'), JSON.stringify(defaults), 'utf8');
  }
  if (projectConfig !== undefined) {
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(projectConfig), 'utf8');
  }
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', path.join(REPO_ROOT, 'bin', 'install.js'), '--claude', '--local'];
  const result = runNode(args, {
    cwd: root,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.strictEqual(result.exitCode, 0, `Claude install failed:\n${result.stderr}`);
  return {
    root,
    agent(name) {
      return fs.readFileSync(path.join(root, '.claude', 'agents', `${name}.md`), 'utf8');
    },
  };
}

test('Claude installer appends wildcard then named grants exactly once (#4032)', (t) => {
  const installed = installClaude(t, {
    defaults: {
      agent_tools: {
        '*': ['mcp__global__one', 'mcp__shared__tool'],
        'gsd-executor': ['mcp__agent__two', 'mcp__shared__tool'],
      },
    },
  });

  const tools = parseTools(installed.agent('gsd-executor'));
  assert.deepStrictEqual(
    tools.slice(-3),
    ['mcp__global__one', 'mcp__shared__tool', 'mcp__agent__two'],
  );
  assert.strictEqual(tools.filter((tool) => tool === 'mcp__shared__tool').length, 1);
});

test('project selectors override only their matching global selector (#4032)', (t) => {
  const installed = installClaude(t, {
    defaults: { agent_tools: { '*': ['mcp__global__wildcard'], 'gsd-executor': ['mcp__global__executor'] } },
    projectConfig: { agent_tools: { 'gsd-executor': ['mcp__project__executor'] } },
  });

  const tools = parseTools(installed.agent('gsd-executor'));
  assert.ok(tools.includes('mcp__global__wildcard'));
  assert.ok(tools.includes('mcp__project__executor'));
  assert.ok(!tools.includes('mcp__global__executor'));
});

test('an invalid project selector fails closed instead of restoring a global grant (#4032)', (t) => {
  const installed = installClaude(t, {
    defaults: { agent_tools: { 'gsd-executor': ['mcp__global__executor'] } },
    projectConfig: { agent_tools: { 'gsd-executor': 'not-an-array' } },
  });

  assert.ok(!parseTools(installed.agent('gsd-executor')).includes('mcp__global__executor'));
});

test('inline and block tools forms keep their form after installer augmentation (#4032)', (t) => {
  const installed = installClaude(t, {
    defaults: { agent_tools: { '*': ['mcp__form__grant'] } },
  });

  const inline = installed.agent('gsd-executor');
  const block = installed.agent('gsd-nyquist-auditor');
  assert.match(inline, /^tools:[^\n]+mcp__form__grant/m);
  assert.match(block, /^tools:\r?\n(?:[ \t]+- [^\n]+\r?\n)*[ \t]+- "mcp__form__grant"$/m);
});

test('missing or invalid agent_tools leave installed agent bytes unchanged (#4032)', (t) => {
  const baselineInstall = installClaude(t);
  const invalidInstall = installClaude(t, { defaults: { agent_tools: { '*': [null, '', '  '] } } });
  const baseline = baselineInstall.agent('gsd-executor').split(baselineInstall.root).join('<INSTALL_ROOT>');
  const invalid = invalidInstall.agent('gsd-executor').split(invalidInstall.root).join('<INSTALL_ROOT>');
  assert.strictEqual(invalid, baseline);
});
