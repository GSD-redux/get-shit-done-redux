'use strict';

// allow-test-rule: source-text-is-the-product (#4032) — these assertions read
// emitted installer artifacts, the deployed agent contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { installerEnv, RUNTIME_META } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const { appendAgentTools, buildKimiAgentArtifacts, convertClaudeAgentToQwenAgent, convertClaudeAgentToZcodeAgent, _decodeToolScalar } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { parseFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

function parseTools(content) {
  const tools = parseFrontmatter(content).tools;
  if (tools === undefined || tools === null) return [];
  if (typeof tools === 'object' && !Array.isArray(tools)) return [];
  return (Array.isArray(tools) ? tools : [tools])
    .flatMap((value) => String(value).replace(/\s+#.*$/, '').split(/[,\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function installClaude(t, { defaults, projectConfig, root = createTempDir('gsd-4032-claude-') } = {}) {
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

function installRuntime(t, runtime, { defaults, projectConfig, repeat = false, scope = 'local' } = {}) {
  const root = createTempDir(`gsd-4032-${runtime}-project-`);
  const home = createTempDir(`gsd-4032-${runtime}-home-`);
  t.after(() => {
    cleanup(root);
    cleanup(home);
  });
  if (defaults !== undefined) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify(defaults), 'utf8');
  }
  if (projectConfig !== undefined) {
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(projectConfig), 'utf8');
  }
  const configDir = scope === 'global'
    ? path.join(home, RUNTIME_META[runtime].globalSuffix)
    : path.join(root, RUNTIME_META[runtime].localDir);
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', path.join(REPO_ROOT, 'bin', 'install.js'), `--${runtime}`];
  if (scope === 'global') args.push('--global', '--config-dir', configDir);
  else args.push('--local');
  const run = () => runNode(args, {
    cwd: root,
    env: installerEnv({ HOME: home, USERPROFILE: home }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const result = run();
  assert.strictEqual(result.exitCode, 0, `${runtime} install failed:\n${result.stderr}`);
  if (repeat) {
    const rerun = run();
    assert.strictEqual(rerun.exitCode, 0, `${runtime} reinstall failed:\n${rerun.stderr}`);
  }
  return { root, home, configDir };
}

function emittedAgentArtifacts(install, agentName, root = install.configDir) {
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
  visit(root);
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
  assert.match(
    installed.agent('gsd-executor'),
    /^tools:.*mcp__global__one, mcp__shared__tool, mcp__agent__two$/m,
    'Claude inline tools must remain plain comma-separated tool names',
  );
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

test('an invalid project agent_tools container suppresses global grants (#4032)', (t) => {
  const installed = installClaude(t, {
    defaults: { agent_tools: { '*': ['mcp__global__wildcard'] } },
    projectConfig: { agent_tools: ['not-an-object'] },
  });

  assert.ok(!parseTools(installed.agent('gsd-executor')).includes('mcp__global__wildcard'));
});

test('config-set accepts named and wildcard agent_tools selectors (#4032)', (t) => {
  const root = createTempDir('gsd-4032-config-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n', 'utf8');
  const env = { HOME: root, USERPROFILE: root };

  for (const selector of ['gsd-executor', '*']) {
    const result = runGsdTools(
      ['config-set', `agent_tools.${selector}`, '["mcp__configured__grant"]'],
      root,
      env,
    );
    assert.ok(result.success, `config-set agent_tools.${selector} failed: ${result.error}`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8'));
  assert.deepStrictEqual(config.agent_tools, {
    'gsd-executor': ['mcp__configured__grant'],
    '*': ['mcp__configured__grant'],
  });
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
  const baseline = baselineInstall.agent('gsd-executor');
  const invalidInstall = installClaude(t, {
    root: baselineInstall.root,
    defaults: { agent_tools: { '*': [null, '', '  '] } },
  });
  const invalid = invalidInstall.agent('gsd-executor');
  assert.strictEqual(invalid, baseline);
});

test('host converters receive canonical grants without changing their omissions (#4032)', (t) => {
  const defaults = { agent_tools: { 'gsd-executor': ['mcp__configured__grant', 'mcp__first__*'] } };
  for (const runtime of ['claude', 'codex']) {
    const artifacts = emittedAgentArtifacts(installRuntime(t, runtime, { defaults }), 'gsd-executor');
    assert.ok(artifacts.some((artifact) => artifact.includes('mcp__configured__grant')),
      `${runtime} must expose the configured canonical grant in its existing host form`);
  }
  const kiloArtifacts = emittedAgentArtifacts(installRuntime(t, 'kilo', { defaults }), 'gsd-executor');
  assert.ok(kiloArtifacts.some((artifact) => {
    const configured = artifact.indexOf('  configured_grant: allow');
    const wildcard = artifact.indexOf('  first_*: allow');
    return configured >= 0 && wildcard > configured;
  }),
    'Kilo must translate safe canonical MCP grants into native permission keys in first-seen order');
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

test('Kimi project selectors override matching global selectors (#4032)', (t) => {
  const install = installRuntime(t, 'kimi', {
    defaults: { agent_tools: { 'gsd-executor': ['WebFetch'] } },
    projectConfig: { agent_tools: { 'gsd-executor': ['WebSearch'] } },
    scope: 'global',
  });
  const artifacts = emittedAgentArtifacts(install, 'gsd-executor');
  assert.ok(artifacts.some((artifact) => artifact.includes('kimi_cli.tools.web:SearchWeb')),
    'Kimi must map the project grant through its existing converter');
  assert.ok(artifacts.every((artifact) => !artifact.includes('kimi_cli.tools.web:FetchURL')),
    'the matching global selector must not survive the project override');
});

test('Kimi neutralizes ~/.claude/gsd-core references instead of leaking a repointed path (#4032)', (t) => {
  // Routing Kimi through the ADR-1235 pre-converter pipeline (needed so
  // project-scoped agent_tools selectors reach it, see the test above) also
  // runs _applyAgentPathRewrites. Kimi's own neutralizeKimiAgentPrompt expects
  // to see the ORIGINAL `~/.claude/gsd-core` text; kimi/kimi-code capability.json
  // now opt out via hostBehaviors.noPathRewrite so that still holds.
  const install = installRuntime(t, 'kimi', { scope: 'global' });
  // Inspect generated prompts, not the installation-owned raw source corpus.
  const artifacts = emittedAgentArtifacts(install, 'gsd-executor', path.join(install.configDir, 'agents'));
  assert.ok(artifacts.some((artifact) => artifact.includes('GSD core')),
    'a ~/.claude/gsd-core reference must neutralize to prose, not a repointed Kimi path');
  assert.ok(artifacts.every((artifact) =>
    !artifact.includes('~/.claude/gsd-core') &&
    !artifact.includes('$HOME/.claude/gsd-core') &&
    !artifact.includes('config/agents/gsd-core/references')),
    'no raw Claude- or Kimi-prefixed gsd-core path may leak into the Kimi prompt body');
});

test('Kilo global install resolves project agent_tools from the working directory (#4032)', (t) => {
  const install = installRuntime(t, 'kilo', {
    defaults: { agent_tools: { 'gsd-executor': ['mcp__global__loser'] } },
    projectConfig: { agent_tools: { 'gsd-executor': ['mcp__project__winner'] } },
    scope: 'global',
  });
  const artifacts = emittedAgentArtifacts(install, 'gsd-executor');
  assert.ok(artifacts.some((artifact) => artifact.includes('  project_winner: allow')),
    'the combined-family path must discover project config from cwd during a global install');
  assert.ok(artifacts.every((artifact) => !artifact.includes('global_loser')),
    'the matching global selector must not survive the project override');
});

test('Kilo permission-key collision resolves deterministically to first-seen (#4032)', (t) => {
  // mcp__a_b__c and mcp__a__b_c both derive Kilo's native "a_b_c" key — the
  // `{server}_{tool}` format is Kilo's own fixed contract, not ours to widen.
  const install = installRuntime(t, 'kilo', {
    defaults: { agent_tools: { 'gsd-executor': ['mcp__a_b__c', 'mcp__a__b_c'] } },
  });
  const artifacts = emittedAgentArtifacts(install, 'gsd-executor');
  assert.ok(artifacts.some((artifact) => (artifact.match(/^ {2}a_b_c: allow$/gm) || []).length === 1),
    'a colliding pair must still emit exactly one permission line');
});

test('every installable runtime accepts a configured MCP grant without crashing (#4032)', (t) => {
  // Shallow, broad: appendAgentTools runs pre-converter for every runtime, but
  // only 6 have deep per-runtime assertions elsewhere in this file. This locks
  // in that the other runtimes' own converters don't choke or mangle output
  // when a canonical grant is appended into their frontmatter dialect.
  // scope: 'global' — universally supported (cline is global-only; local
  // support varies per runtime, global does not). Search from `install.home`,
  // not `install.configDir`: a nested-home runtime (e.g. antigravity) places
  // agents in a sibling directory outside its own configDir subtree.
  const NO_SUBAGENT_TOOLKIT = new Set(['pi']); // programmatic dispatch, no named-dispatch agent files
  // Runtimes empirically verified (see PR #4238 remediation) to pass an
  // arbitrary mcp__ grant through recognizably — either verbatim or via
  // Kilo's {server}_{tool} transform. Every other runtime filters unknown
  // tool names through its own built-in vocabulary (a legitimate, unrelated
  // per-runtime design choice, not an agent_tools omission) and is checked
  // for a clean, non-crashing install only. This is an allowlist, not a
  // guess-based omit-list, so it can't silently drift as runtimes are added.
  const GRANT_SURVIVES_RECOGNIZABLY = new Set(['claude', 'codex', 'copilot', 'hermes', 'kimi-code', 'kilo', 'qwen']);
  for (const runtime of Object.keys(RUNTIME_META)) {
    if (NO_SUBAGENT_TOOLKIT.has(runtime)) continue;
    const install = installRuntime(t, runtime, {
      defaults: { agent_tools: { 'gsd-executor': ['mcp__smoke__probe'] } },
      scope: 'global',
    });
    const artifacts = emittedAgentArtifacts(install, 'gsd-executor', install.home);
    assert.ok(artifacts.every((artifact) => artifact.length > 0), `${runtime} must emit non-empty gsd-executor artifact(s)`);
    if (!GRANT_SURVIVES_RECOGNIZABLY.has(runtime)) continue;
    assert.ok(artifacts.some((artifact) => artifact.includes('mcp__smoke__probe') || artifact.includes('smoke_probe')),
      `${runtime} must carry the configured grant (raw or Kilo-style transformed) — this must fail if agent_tools is reverted`);
  }
});

test('Codex grants do not widen the generated TOML sandbox (#4032)', (t) => {
  const install = installRuntime(t, 'codex', {
    defaults: { agent_tools: { 'gsd-plan-checker': ['Write'] } },
  });
  const toml = fs.readFileSync(path.join(install.configDir, 'agents', 'gsd-plan-checker.toml'), 'utf8');
  assert.match(toml, /^sandbox_mode = "read-only"$/m);
  assert.doesNotMatch(toml, /Write/,
    'Codex tool availability is inherited from the parent session, not encoded in agent TOML');
});

test('hostile values fail closed while inline Claude tools remain valid tokens (#4032)', (t) => {
  const rejected = [
    null, 1, '', '  ', 'mcp__bad,comma', 'mcp__bad\0nul', 'mcp__bad\nline', 'mcp__bad\u0085nel', 'mcp__bad\u2028line',
    '#comment', 'tool:', 'tool: value', 'Bash(git log:*)', '"quote"', "'quote'",
  ];
  const accepted = ['mcp__safe__:terminal', 'Agent(worker)', '\\backslash'];
  const installed = installClaude(t, { defaults: { agent_tools: { '*': [...rejected, ...accepted] } } });
  const content = installed.agent('gsd-executor');
  const frontmatter = content.slice(4, content.indexOf('\n---', 4));
  const parsed = require('js-yaml').load(frontmatter);
  assert.strictEqual(typeof parsed.tools, 'string', 'the emitted inline tools scalar must remain valid YAML');
  assert.deepStrictEqual(parseTools(content).slice(-accepted.length), accepted);
  assert.ok(rejected.every((value) => typeof value !== 'string' || !parseTools(content).includes(value)));
  assert.ok(rejected.every((value) => typeof value !== 'string' || !value.trim() || !content.includes(value.trim())),
    'rejected entries must not leak into the installed artifact under a different tokenization');
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
  for (const [raw, expected] of [
    ['"\\x6dcp__server__tool"', 'mcp__server__tool'],
    ['"\\u006dcp__server__tool"', 'mcp__server__tool'],
    ['"\\U0000006dcp__server__tool"', 'mcp__server__tool'],
    ['"\\x6gcp__server__tool"', null],
  ]) {
    assert.strictEqual(_decodeToolScalar(raw), expected);
  }

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
    assert.match(qwen, /^ {2}- WebFetch$/m);
    assert.match(qwen, /^ {2}- WebSearch$/m);
    assert.doesNotMatch(qwen, /unterminated/);
  }
});

test('appendAgentTools preserves inline YAML comments without swallowing grants (#4032)', () => {
  const content = '---\nname: gsd-test\ntools: Read # keep this note\n---\n';
  const augmented = appendAgentTools(content, ['WebFetch']);
  assert.match(augmented, /^tools: Read, WebFetch # keep this note$/m);
  assert.deepStrictEqual(parseTools(augmented), ['Read', 'WebFetch']);
});

test('appendAgentTools leaves agents without a tools key unchanged (#4032)', () => {
  const content = '---\nname: gsd-test\ndescription: inherits the runtime tool surface\n---\n';
  assert.strictEqual(appendAgentTools(content, ['WebFetch']), content);
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

test('appendAgentTools applies grants under a comment-only tools: header (#4032)', () => {
  const frontmatter = '---\ntools: # TODO: fill in\n  - Read\n---\n';
  const once = appendAgentTools(frontmatter, ['Write']);
  assert.deepStrictEqual(parseTools(once), ['Read', 'Write']);
  assert.match(once, /^tools: # TODO: fill in$/m, 'the comment-only header line must survive untouched');
});

test('appendAgentTools does not tear a quoted scalar containing a literal comma (#4032)', () => {
  // parseTools (this file's own helper) naive-splits on comma/space too, so it
  // can't round-trip a quoted comma scalar — assert the raw line instead.
  const frontmatter = '---\ntools: Read, "mcp__x, y"\n---\n';
  const once = appendAgentTools(frontmatter, ['Write']);
  assert.match(once, /^tools: Read, "mcp__x, y", Write$/m,
    'the quoted scalar must survive intact and Write must be appended once');
  const twice = appendAgentTools(once, ['Write']);
  assert.strictEqual(twice, once, 'reapplying the same grant must be a no-op (Write not duplicated)');
});

test('appendAgentTools refuses to extend a value that IS a leading quoted scalar (#4032)', () => {
  // Regression found in PR #4238 remediation (Opus review): a YAML quoted
  // scalar occupies the whole node — `tools: "Read"` is valid, but
  // `tools: "Read", Write` is not, even before this function touches it.
  // Naively appending after it produced invalid frontmatter. There is no
  // safe line-surgical rewrite here (that would require re-serializing the
  // scalar), so the correct behavior is to leave the line untouched.
  const frontmatter = '---\ntools: "Read"\n---\n';
  const once = appendAgentTools(frontmatter, ['Write']);
  assert.strictEqual(once, frontmatter, 'a leading quoted scalar must be left byte-identical, not corrupted');
});

test('appendAgentTools refuses to extend a value that IS a YAML flow sequence (#4032)', () => {
  // Regression found in PR #4238 remediation (CodeRabbit review): a flow
  // sequence occupies the whole node — `tools: [Bash, Read]` is valid, but
  // `tools: [Bash, Read], Write` is not (content cannot follow a closed flow
  // collection on the same line). The naive append produced invalid
  // frontmatter, same failure mode as the leading-quoted-scalar case above.
  const frontmatter = '---\ntools: [Bash, Read]\n---\n';
  const once = appendAgentTools(frontmatter, ['Write']);
  assert.strictEqual(once, frontmatter, 'a leading flow sequence must be left byte-identical, not corrupted');
});

test('appendAgentTools recognizes an existing block item with a trailing comment (no duplicate) (#4032)', () => {
  // Regression found in PR #4238 remediation: decodeToolScalar did not strip
  // a trailing ` # note` from a bare block-list item, so `- Read # note`
  // decoded to `'Read # note'` — `present.has('Read')` then missed, and a
  // second `- "Read"` item was inserted alongside the original.
  const frontmatter = '---\ntools:\n  - Read # note\n---\n';
  const once = appendAgentTools(frontmatter, ['Read', 'Write']);
  assert.doesNotMatch(once, /- "Read"/, 'Read must not be duplicated as a new quoted item');
  assert.match(once, /^ {2}- Read # note$/m, 'the original commented item must survive untouched');
  assert.match(once, /^ {2}- "Write"$/m, 'the genuinely new grant must still be appended');
});

test('parseFrontmatterTools (Qwen conversion) does not silently drop a block list under a comment-only header (#4032)', () => {
  // Sibling of the appendAgentTools fix (finding 4): parseFrontmatterTools's
  // own comment-only-header check (`if (value) {...}` treated `# note` as
  // truthy content instead of falling through to `collecting = true`) is a
  // separate parser reached by Kimi and Qwen conversion, downstream of
  // appendAgentTools's own output.
  const agent = '---\nname: gsd-executor\ndescription: test\ntools: # note\n  - Read\n  - Write\n---\nbody\n';
  const qwen = convertClaudeAgentToQwenAgent(agent);
  assert.match(qwen, /- Read/);
  assert.match(qwen, /- Write/);
});

test('parseFrontmatterTools (Qwen conversion) does not tear a quoted scalar containing a literal comma (#4032)', () => {
  const agent = appendAgentTools(
    '---\nname: gsd-executor\ndescription: test\ntools: Read, "mcp__x, y"\n---\nbody\n',
    [],
  );
  const qwen = convertClaudeAgentToQwenAgent(agent);
  assert.match(qwen, /- "mcp__x, y"/, 'the quoted scalar must survive as one tool, not torn on its internal comma');
});

test('ZCode strips an undecodable mcp__ scalar instead of keeping it (fail-closed) (#4032)', () => {
  // An unterminated quote makes decodeToolScalar return null. ZCode's contract
  // is "never emit mcp__*" (a required-MCP-server hard-fail otherwise), so a
  // decode failure must be treated as unsafe-and-stripped, never safe-and-kept.
  const inline = '---\ntools: Read, "mcp__server__tool\n---\n';
  assert.doesNotMatch(convertClaudeAgentToZcodeAgent(inline), /mcp__/,
    'an undecodable inline scalar must not survive ZCode conversion');

  const block = '---\ntools:\n  - Read\n  - "mcp__server__tool\n---\n';
  assert.doesNotMatch(convertClaudeAgentToZcodeAgent(block), /mcp__/,
    'an undecodable block-list scalar must not survive ZCode conversion');
});

test('ZCode strips a block-list mcp__ item under a comment-only tools: header (#4032)', () => {
  // Regression found in PR #4238 remediation: a `tools: # comment` header line
  // matched the INLINE-value regex (comment text treated as content), so the
  // block-list scan below it never ran and `mcp__server__tool` leaked through
  // verbatim — breaking ZCode's "never emit mcp__*" invariant.
  const content = '---\ntools: # comment-only header\n  - Read\n  - mcp__server__tool\n---\n';
  const converted = convertClaudeAgentToZcodeAgent(content);
  assert.doesNotMatch(converted, /mcp__/, 'mcp__server__tool must be stripped, not leaked through');
  assert.match(converted, /^tools: # comment-only header$/m, 'the comment-only header line must survive untouched');
  assert.match(converted, /^ {2}- Read$/m, 'the non-mcp__ item must be kept');
});
