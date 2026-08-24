// docs-guard-exempt: 'docs/guide.md' is a synthetic tool_input fixture path for a hook probe, not a real repo doc.
// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1991
 *
 * Cline is listed in GSD documentation as a supported runtime but was
 * completely absent from bin/install.js. Running `npx @opengsd/gsd-core`
 * did not show Cline as an option in the interactive menu.
 *
 * Fixed: Cline is now a first-class runtime that:
 * - Appears in the interactive menu and --all flag
 * - Supports the --cline CLI flag
 * - Writes .clinerules to the install directory
 * - Installs gsd-core/ engine with path replacement
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
// #3145: class-norm timeouts, not per-suite values — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');

const {
  getConfigDirFromHome,
  convertClaudeToCliineMarkdown,
  install,
  finishInstall,
  uninstall,
  stripGsdFromAgentsMd,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,
} = require('../bin/install.js');

const { getDirName } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const {
  buildClineRulesBody,
  buildClinePreToolUseHook,
  buildClineAgentsMdBody,
  mergeGsdAgentsMd,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

describe('Cline runtime directory mapping', () => {
  test('getDirName returns .cline for local installs', () => {
    assert.strictEqual(getDirName('cline'), '.cline');
  });

  test('getGlobalConfigDir returns ~/.cline for global installs', () => {
    assert.strictEqual(getGlobalConfigDir('cline'), path.join(os.homedir(), '.cline'));
  });

  test('getConfigDirFromHome returns .cline fragment', () => {
    assert.strictEqual(getConfigDirFromHome('cline', false), "'.cline'");
    assert.strictEqual(getConfigDirFromHome('cline', true), "'.cline'");
  });
});

describe('getGlobalConfigDir (Cline)', () => {
  let originalClineConfigDir;

  beforeEach(() => {
    originalClineConfigDir = process.env.CLINE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalClineConfigDir !== undefined) {
      process.env.CLINE_CONFIG_DIR = originalClineConfigDir;
    } else {
      delete process.env.CLINE_CONFIG_DIR;
    }
  });

  test('returns ~/.cline with no env var or explicit dir', () => {
    delete process.env.CLINE_CONFIG_DIR;
    const result = getGlobalConfigDir('cline');
    assert.strictEqual(result, path.join(os.homedir(), '.cline'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalConfigDir('cline', '/custom/cline-path');
    assert.strictEqual(result, '/custom/cline-path');
  });

  test('respects CLINE_CONFIG_DIR env var', () => {
    process.env.CLINE_CONFIG_DIR = '~/custom-cline';
    const result = getGlobalConfigDir('cline');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-cline'));
  });

  test('explicit dir takes priority over CLINE_CONFIG_DIR', () => {
    process.env.CLINE_CONFIG_DIR = '~/from-env';
    const result = getGlobalConfigDir('cline', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalConfigDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalConfigDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('Cline markdown conversion', () => {
  test('convertClaudeToCliineMarkdown exists and is a function', () => {
    assert.strictEqual(typeof convertClaudeToCliineMarkdown, 'function');
  });

  test('replaces Claude Code brand with Cline', () => {
    const result = convertClaudeToCliineMarkdown('Use Claude Code to run');
    assert.ok(!result.includes('Claude Code'));
    assert.ok(result.includes('Cline'));
  });

  test('replaces .claude/ paths with .cline/', () => {
    const result = convertClaudeToCliineMarkdown('See ~/.claude/gsd-core/');
    assert.ok(!result.includes('.claude/'), `Expected no .claude/ in: ${result}`);
    assert.ok(result.includes('.cline/'));
  });

  test('replaces CLAUDE.md references', () => {
    const result = convertClaudeToCliineMarkdown('See CLAUDE.md for config');
    assert.ok(!result.includes('CLAUDE.md'));
    assert.ok(result.includes('.clinerules'));
  });

  test('replaces .claude/skills/ with .cline/skills/', () => {
    const result = convertClaudeToCliineMarkdown('skills at .claude/skills/gsd-executor');
    assert.ok(!result.includes('.claude/skills/'));
    assert.ok(result.includes('.cline/skills/'));
  });
});

describe('Cline install (local)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-cline-test-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install creates .clinerules directory with gsd.md (#787 directory form)', () => {
    install(false, 'cline');
    const clinerulesDir = path.join(tmpDir, '.clinerules');
    assert.ok(fs.existsSync(clinerulesDir), '.clinerules must exist after cline install');
    assert.ok(fs.statSync(clinerulesDir).isDirectory(), '.clinerules must be a directory (#787)');
    assert.ok(fs.existsSync(path.join(clinerulesDir, 'gsd.md')), '.clinerules/gsd.md must exist');
  });

  test('.clinerules/gsd.md contains GSD instructions', () => {
    install(false, 'cline');
    const ruleFile = path.join(tmpDir, '.clinerules', 'gsd.md');
    const content = fs.readFileSync(ruleFile, 'utf8');
    assert.ok(content.includes('GSD') || content.includes('gsd'), '.clinerules/gsd.md must reference GSD');
  });

  test('install creates gsd-core engine directory', () => {
    install(false, 'cline');
    const engineDir = path.join(tmpDir, 'gsd-core');
    assert.ok(fs.existsSync(engineDir), 'gsd-core directory must exist after install');
  });

  test('finishInstall does not throw ERR_INVALID_ARG_TYPE for cline runtime (regression: null settingsPath guard)', () => {
    // install() returns settingsPath: null for cline — finishInstall() must not call
    // writeSettings(null, ...) or it crashes with ERR_INVALID_ARG_TYPE.
    // Before fix: isCline was missing from the writeSettings guard in finishInstall().
    // After fix:  !isCline is in the guard, matching codex/copilot/cursor/windsurf/trae.
    assert.doesNotThrow(
      () => finishInstall(null, null, null, false, 'cline', false, tmpDir),
      'finishInstall must not throw when called with null settingsPath for cline runtime'
    );
  });

  test('settings.json is not written for cline runtime', () => {
    finishInstall(null, null, null, false, 'cline', false, tmpDir);
    const settingsJson = path.join(tmpDir, 'settings.json');
    assert.ok(!fs.existsSync(settingsJson), 'settings.json must not be written for cline runtime');
  });

  test('install writes agents/gsd-*.md locally (regression: agents dropped when the inline agent-staging loop was deleted, #2875 Part 2)', () => {
    install(false, 'cline');
    const agentsDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist after cline local install');
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'cline local install must write at least one gsd-*.md agent file');
    const sample = fs.readFileSync(path.join(agentsDir, agentFiles[0]), 'utf8');
    assert.match(sample, /^---\r?\nname: /, 'cline agent frontmatter must be Cline-dialect (name + description only)');
  });

  test('installed engine files have no leaked .claude paths', () => {
    install(false, 'cline');
    const engineDir = path.join(tmpDir, 'gsd-core');
    if (!fs.existsSync(engineDir)) return; // skip if engine not installed

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) {
          // CHANGELOG.md is a historical record and is not path-converted — skip it
          if (entry.name === 'CHANGELOG.md') continue;
          // Converter source contains literal Claude source-path templates used before
          // runtime-specific install rewrites; this test is only for deployed Cline payload leaks.
          if (entry.name === 'runtime-artifact-conversion.cjs') continue;
          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for GSD install paths that should have been substituted.
          // profile-pipeline.cjs intentionally references ~/.claude/projects (Claude Code
          // session data) as a runtime feature — that is not a leaked install path.
          const hasLeaked = /~\/\.claude\/(?:gsd-core|commands|agents|hooks)|HOME\/\.claude\/(?:gsd-core|commands|agents|hooks)/.test(content);
          assert.ok(!hasLeaked, `Found leaked GSD .claude install path in ${fullPath}`);
        }
      }
    }
    scanDir(engineDir);
  });
});

// ─── Folded from tests/issue-787-cline-hooks-agents.test.cjs ────────────────────
// Issue #787 — elevate Cline: write hooks (.clinerules/hooks/) + AGENTS.md.
// Verifies the installer emits Cline directory-form rules, a PreToolUse
// lifecycle hook (Cline JSON stdin -> {cancel,errorMessage,contextModification}
// protocol), and a global ~/.agents/AGENTS.md instruction target.
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-787-cline-hooks-agents', () => {

describe('#787 Cline pure helpers', () => {
  test('buildClineRulesBody returns GSD directory-form rules markdown', () => {
    const body = buildClineRulesBody();
    assert.equal(typeof body, 'string');
    assert.match(body, /GSD workflows live in `gsd-core\/workflows\/`/);
    assert.ok(body.endsWith('\n'), 'rules body should end with a trailing newline');
  });

  test('buildClinePreToolUseHook returns a syntactically valid Node script', () => {
    const script = buildClinePreToolUseHook();
    assert.match(script, /^#!\/usr\/bin\/env node/, 'must carry a node shebang');
    // Cline protocol fields must be present in the emitted decision surface.
    assert.match(script, /cancel/);
    assert.match(script, /errorMessage/);
    const tmp = createTempDir('gsd-787-hookcheck-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, script);
      const res = runNode(['--check', p], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(res.exitCode, 0, `node --check failed: ${res.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook allows a normal tool call (cancel:false)', () => {
    const tmp = createTempDir('gsd-787-hookrun-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = runNode([p], {
        input: JSON.stringify({ toolName: 'read_file', toolInput: { path: 'src/index.ts' } }),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(res.exitCode, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.cancel, false);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook cancels a write into .planning/ with an errorMessage', () => {
    const tmp = createTempDir('gsd-787-hookguard-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = runNode([p], {
        input: JSON.stringify({ toolName: 'write_to_file', toolInput: { path: '.planning/ROADMAP.md', content: 'x' } }),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(res.exitCode, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.cancel, true);
      assert.match(out.errorMessage, /\.planning/);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook does NOT cancel a write to a non-planning path whose CONTENT mentions .planning/', () => {
    const tmp = createTempDir('gsd-787-hookfp-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = runNode([p], {
        input: JSON.stringify({
          toolName: 'write_to_file',
          toolInput: { path: 'docs/guide.md', content: 'Edit your .planning/ROADMAP.md via /gsd commands.' },
        }),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(res.exitCode, 0);
      assert.equal(JSON.parse(res.stdout).cancel, false, 'content mentioning .planning must not trigger a cancel');
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook fails open on malformed stdin', () => {
    const tmp = createTempDir('gsd-787-hookbad-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = runNode([p], { input: 'not json{', timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(res.exitCode, 0);
      assert.equal(JSON.parse(res.stdout).cancel, false);
    } finally {
      cleanup(tmp);
    }
  });

  test('mergeGsdAgentsMd creates a marker-delimited block when no file exists', () => {
    const tmp = createTempDir('gsd-787-agents-new-');
    try {
      const p = path.join(tmp, 'AGENTS.md');
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const content = fs.readFileSync(p, 'utf8');
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      assert.ok(content.includes(GSD_AGENTS_MD_CLOSE_MARKER));
      assert.match(content, /GSD/);
    } finally {
      cleanup(tmp);
    }
  });

  test('mergeGsdAgentsMd preserves pre-existing user content', () => {
    const tmp = createTempDir('gsd-787-agents-merge-');
    try {
      const p = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(p, '# My rules\n\nKeep me.\n');
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const content = fs.readFileSync(p, 'utf8');
      assert.match(content, /Keep me\./);
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      // Idempotent: second merge does not duplicate the block.
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const twice = fs.readFileSync(p, 'utf8');
      const occurrences = twice.split(GSD_AGENTS_MD_MARKER).length - 1;
      assert.equal(occurrences, 1, 'GSD block must not duplicate on re-merge');
      assert.match(twice, /Keep me\./);
    } finally {
      cleanup(tmp);
    }
  });

  test('stripGsdFromAgentsMd returns null when file was GSD-only, else cleaned content', () => {
    const onlyGsd = `${GSD_AGENTS_MD_MARKER}\nhi\n${GSD_AGENTS_MD_CLOSE_MARKER}\n`;
    assert.equal(stripGsdFromAgentsMd(onlyGsd), null);
    const mixed = `# Keep\n\n${GSD_AGENTS_MD_MARKER}\nhi\n${GSD_AGENTS_MD_CLOSE_MARKER}\n`;
    const cleaned = stripGsdFromAgentsMd(mixed);
    assert.match(cleaned, /# Keep/);
    assert.ok(!cleaned.includes(GSD_AGENTS_MD_MARKER));
  });
});

// ─── Local install: directory form + hook ───────────────────────────────────────

describe('#787 Cline local install — directory form + PreToolUse hook', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-787-cline-local-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('writes .clinerules/ as a directory containing gsd.md', () => {
    install(false, 'cline');
    const dir = path.join(tmpDir, '.clinerules');
    assert.ok(fs.statSync(dir).isDirectory(), '.clinerules must be a directory');
    const ruleFile = path.join(dir, 'gsd.md');
    assert.ok(fs.existsSync(ruleFile), '.clinerules/gsd.md must exist');
    assert.match(fs.readFileSync(ruleFile, 'utf8'), /gsd-core\/workflows\//);
  });

  test('writes an executable PreToolUse hook with no extension', () => {
    install(false, 'cline');
    const hook = path.join(tmpDir, '.clinerules', 'hooks', 'PreToolUse');
    assert.ok(fs.existsSync(hook), '.clinerules/hooks/PreToolUse must exist');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(hook).mode;
      assert.ok((mode & 0o111) !== 0, 'PreToolUse must be executable');
    }
  });

  test('migrates a legacy single-file .clinerules into the directory form', () => {
    // Simulate a pre-#787 install that wrote a .clinerules FILE.
    fs.writeFileSync(path.join(tmpDir, '.clinerules'), '# legacy file\n');
    install(false, 'cline');
    const dir = path.join(tmpDir, '.clinerules');
    assert.ok(fs.statSync(dir).isDirectory(), 'legacy file must be replaced by a directory');
    assert.ok(fs.existsSync(path.join(dir, 'gsd.md')));
  });

  test('does not follow a symlinked .clinerules (writes the real directory in place)', () => {
    if (process.platform === 'win32') return; // symlink perms differ on Windows
    // Point .clinerules at an external directory via symlink; install must NOT
    // write GSD files through the link.
    const external = path.join(tmpDir, 'external-target');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(tmpDir, '.clinerules'));
    install(false, 'cline');
    const dir = path.join(tmpDir, '.clinerules');
    assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(),
      '.clinerules must be a real directory, not the symlink');
    assert.ok(!fs.existsSync(path.join(external, 'gsd.md')), 'must not write through the symlink target');
    assert.ok(fs.existsSync(path.join(dir, 'gsd.md')));
  });

  test('manifest tracks the new directory-form artifacts', () => {
    install(false, 'cline');
    const manifestPath = path.join(tmpDir, 'gsd-file-manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.files['.clinerules/gsd.md'], 'manifest should track .clinerules/gsd.md');
    assert.ok(manifest.files['.clinerules/hooks/PreToolUse'], 'manifest should track the hook');
  });
});

// ─── Global install: ~/.agents/AGENTS.md (subprocess, HOME-isolated) ─────────────

describe('#787 Cline global install — ~/.agents/AGENTS.md', () => {
  function runGlobalClineInstall() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-787-cline-global-'));
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.GSD_TEST_MODE;
    const res = runNode(
      [INSTALL_SCRIPT, '--cline', '--global', '--config-dir', path.join(root, '.cline')],
      { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    return { root, res };
  }

  test('writes ~/.agents/AGENTS.md with a GSD marker block', () => {
    const { root, res } = runGlobalClineInstall();
    try {
      assert.equal(res.exitCode, 0, `installer failed: ${res.stderr}`);
      const agents = path.join(root, '.agents', 'AGENTS.md');
      assert.ok(fs.existsSync(agents), '~/.agents/AGENTS.md must exist after a global Cline install');
      const content = fs.readFileSync(agents, 'utf8');
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      assert.match(content, /GSD/);
    } finally {
      cleanup(root);
    }
  });
});

// ─── Uninstall symmetry ─────────────────────────────────────────────────────────

describe('#787 Cline uninstall removes managed artifacts', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-787-cline-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('local uninstall removes .clinerules/gsd.md and the hook', () => {
    install(false, 'cline');
    assert.ok(fs.existsSync(path.join(tmpDir, '.clinerules', 'gsd.md')));
    uninstall(false, 'cline');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.clinerules', 'gsd.md')), 'gsd.md should be removed');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.clinerules', 'hooks', 'PreToolUse')), 'hook should be removed');
  });
});
  });
}
