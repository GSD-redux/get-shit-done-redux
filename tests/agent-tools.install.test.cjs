'use strict';

// allow-test-rule: source-text-is-the-product (#4032) — these assertions read
// emitted installer artifacts, the deployed agent contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { installerEnv, RUNTIME_META } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const { appendAgentTools, buildKimiAgentArtifacts, convertClaudeAgentToQwenAgent } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

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

function installRuntime(t, runtime, { defaults, repeat = false, scope = 'local' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-4032-${runtime}-`));
  t.after(() => cleanup(root));
  if (defaults !== undefined) {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'defaults.json'), JSON.stringify(defaults), 'utf8');
  }
  const configDir = scope === 'global'
    ? path.join(root, RUNTIME_META[runtime].globalSuffix)
    : path.join(root, RUNTIME_META[runtime].localDir);
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', path.join(REPO_ROOT, 'bin', 'install.js'), `--${runtime}`];
  if (scope === 'global') args.push('--global', '--config-dir', configDir);
  else args.push('--local');
  const run = () => runNode(args, {
    cwd: root,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const result = run();
  assert.strictEqual(result.exitCode, 0, `${runtime} install failed:\n${result.stderr}`);
  if (repeat) {
    const rerun = run();
    assert.strictEqual(rerun.exitCode, 0, `${runtime} reinstall failed:\n${rerun.stderr}`);
  }
  return { root, configDir };
}

function emittedAgentArtifacts(install, agentName) {
  const artifacts = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && new RegExp(`^${agentName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\.|$)`).test(entry.name)) {
        artifacts.push(fs.readFileSync(candidate, 'utf8'));
      }
    }
  };
  visit(install.configDir);
  assert.ok(artifacts.length > 0, `install must emit at least one ${agentName} artifact`);
  return artifacts;
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

test('host converters receive canonical grants without changing their omissions (#4032)', (t) => {
  const defaults = { agent_tools: { 'gsd-executor': ['mcp__configured__grant'] } };
  for (const runtime of ['claude', 'codex', 'qwen']) {
    const artifacts = emittedAgentArtifacts(installRuntime(t, runtime, { defaults }), 'gsd-executor');
    assert.ok(artifacts.some((artifact) => artifact.includes('mcp__configured__grant')),
      `${runtime} must expose the configured canonical grant in its existing host form`);
  }
  for (const runtime of ['zcode', 'opencode']) {
    const artifacts = emittedAgentArtifacts(installRuntime(t, runtime, { defaults }), 'gsd-executor');
    assert.ok(artifacts.every((artifact) => !artifact.includes('mcp__configured__grant')),
      `${runtime} must preserve its existing tool omission policy`);
  }
});

test('Kimi receives canonical grants before its existing mapper runs (#4032)', (t) => {
  const install = installRuntime(t, 'kimi', {
    defaults: { agent_tools: { 'gsd-executor': ['WebFetch'] } },
    scope: 'global',
  });
  const artifacts = emittedAgentArtifacts(install, 'gsd-executor');
  assert.ok(artifacts.some((artifact) => artifact.includes('kimi_cli.tools.web:FetchURL')),
    'Kimi must map a configured canonical WebFetch tool through its existing converter');
});

test('hostile values fail closed while quoted scalar data remains parseable (#4032)', (t) => {
  const rejected = [null, 1, '', '  ', 'mcp__bad,comma', 'mcp__bad\nline', 'mcp__bad\u0085nel', 'mcp__bad\u2028line'];
  const accepted = ['mcp__safe__:terminal', '#comment', '"quote"', '\\backslash'];
  const installed = installClaude(t, { defaults: { agent_tools: { '*': [...rejected, ...accepted] } } });
  const content = installed.agent('gsd-executor');
  const frontmatter = content.slice(4, content.indexOf('\n---', 4));
  const parsed = require('js-yaml').load(frontmatter);
  assert.strictEqual(typeof parsed.tools, 'string', 'the emitted inline tools scalar must remain valid YAML');
  assert.deepStrictEqual(parseTools(content).slice(-accepted.length), accepted);
  assert.ok(rejected.every((value) => typeof value !== 'string' || !parseTools(content).includes(value)));
});

test('reinstall remains idempotent and preserves Claude read-only restrictions (#4032)', (t) => {
  const install = installRuntime(t, 'claude', {
    defaults: { agent_tools: { '*': ['mcp__idempotent__grant'] } },
    repeat: true,
  });
  const artifacts = emittedAgentArtifacts(install, 'gsd-plan-checker');
  assert.ok(artifacts.every((artifact) => parseTools(artifact).filter((tool) => tool === 'mcp__idempotent__grant').length === 1));
  assert.ok(artifacts.some((artifact) => artifact.includes('disallowedTools:')),
    'the existing Claude read-only deny-list must survive augmentation');
});

test('quoted scalar identity is shared by append, Kimi, and Qwen (#4191)', () => {
  const inline = '---\nname: gsd-test\ndescription: test\ntools: "WebFetch", \'WebSearch\', "unterminated\n---\n';
  const block = '---\nname: gsd-test\ndescription: test\ntools:\n  - "WebFetch"\n  - \'WebSearch\'\n  - "unterminated\n---\n';

  for (const content of [inline, block]) {
    const once = appendAgentTools(content, ['WebFetch', 'WebSearch']);
    assert.strictEqual(once, content, 'quoted values must already satisfy append idempotency');

    const kimi = buildKimiAgentArtifacts({ subagents: [{ path: 'agents/gsd-test.md', content }] });
    assert.ok(kimi.subagents[0].yaml.includes('kimi_cli.tools.web:FetchURL'));
    assert.ok(kimi.subagents[0].yaml.includes('kimi_cli.tools.web:SearchWeb'));
    assert.ok(!kimi.subagents[0].yaml.includes('unterminated'));

    const qwen = convertClaudeAgentToQwenAgent(content);
    assert.match(qwen, /^  - WebFetch$/m);
    assert.match(qwen, /^  - WebSearch$/m);
    assert.doesNotMatch(qwen, /unterminated/);
  }
});

test('fast-check: append preserves stable first-seen order and converges (#4032)', () => {
  const token = fc.constantFrom('Read', 'Write', 'WebFetch', 'mcp__server__tool', 'Skill');
  fc.assert(
    fc.property(
      fc.constantFrom('inline', 'block'),
      fc.array(token, { maxLength: 8 }),
      fc.array(token, { maxLength: 8 }),
      fc.array(token, { maxLength: 8 }),
      (form, existing, wildcard, named) => {
        const frontmatter = form === 'inline'
          ? `---\ntools: ${existing.join(', ')}\n---\n`
          : `---\ntools:\n${existing.map((tool) => `  - ${tool}`).join('\n')}\n---\n`;
        const present = new Set(existing);
        const additions = [...wildcard, ...named].filter((tool) => !present.has(tool) && (present.add(tool), true));
        const expected = [...existing, ...additions];
        const once = appendAgentTools(frontmatter, [...wildcard, ...named]);
        assert.deepStrictEqual(parseTools(once), expected);
        assert.strictEqual(appendAgentTools(once, [...wildcard, ...named]), once);
      },
    ),
    { numRuns: 100 },
  );
});
