// allow-test-rule: source-text-is-the-product
// The Cline rules markdown, the PreToolUse hook script, and the AGENTS.md block
// ARE the deployed contract that the Cline runtime loads/executes — testing their
// text/behavior tests the shipped artifact. Per CONTRIBUTING.md exception matrix.

/**
 * Issue #787 — elevate Cline: write hooks (.clinerules/hooks/) + AGENTS.md.
 *
 * Verifies the installer now emits the Cline directory-form rules, a
 * PreToolUse lifecycle hook (Cline JSON stdin → {cancel,errorMessage,
 * contextModification} protocol), and a global ~/.agents/AGENTS.md instruction
 * target. Self-contained: does NOT depend on the #782 Cline skills work.
 *
 * Primary sources adjudicated:
 *  - https://cline.bot/blog/cline-v3-36-hooks
 *      hooks live at .clinerules/hooks/<EventName> (project) and
 *      ~/Documents/Cline/Rules/Hooks/ (global); executable scripts named
 *      exactly after the event with no extension; JSON stdin → JSON stdout
 *      with cancel / errorMessage / contextModification.
 *  - https://docs.cline.bot/customization/cline-rules
 *      Cline processes all .md/.txt files inside a .clinerules/ directory and
 *      reads cross-tool global instructions from ~/.agents/AGENTS.md.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');

// #3145: class-norm timeouts, not per-suite values — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  install,
  uninstall,
  buildClineRulesBody,
  buildClinePreToolUseHook,
  buildClineAgentsMdBody,
  mergeGsdAgentsMd,
  stripGsdFromAgentsMd,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,
} = require('../bin/install.js');

// ─── Pure helpers ─────────────────────────────────────────────────────────────

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
