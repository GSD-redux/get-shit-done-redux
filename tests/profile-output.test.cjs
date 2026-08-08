// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Profile Output Tests
 *
 * Tests for profile rendering commands and PROFILING_QUESTIONS data.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runGsdTools,
  createTempProject,
  createTempGitProject,
  cleanup,
  withIsolatedProcessState,
} = require('./helpers.cjs');

const {
  PROFILING_QUESTIONS,
  CLAUDE_INSTRUCTIONS,
} = require('../gsd-core/bin/lib/profile-output.cjs');

// ─── PROFILING_QUESTIONS data ─────────────────────────────────────────────────

describe('PROFILING_QUESTIONS', () => {
  test('is a non-empty array', () => {
    assert.ok(Array.isArray(PROFILING_QUESTIONS));
    assert.ok(PROFILING_QUESTIONS.length > 0);
  });

  test('each question has required fields', () => {
    for (const q of PROFILING_QUESTIONS) {
      assert.ok(q.dimension, `question missing dimension`);
      assert.ok(q.header, `${q.dimension} missing header`);
      assert.ok(q.question, `${q.dimension} missing question`);
      assert.ok(Array.isArray(q.options), `${q.dimension} options should be array`);
      assert.ok(q.options.length >= 2, `${q.dimension} should have at least 2 options`);
    }
  });

  test('each option has label, value, and rating', () => {
    for (const q of PROFILING_QUESTIONS) {
      for (const opt of q.options) {
        assert.ok(opt.label, `${q.dimension} option missing label`);
        assert.ok(opt.value, `${q.dimension} option missing value`);
        assert.ok(opt.rating, `${q.dimension} option missing rating`);
      }
    }
  });

  test('all dimension keys are unique', () => {
    const dims = PROFILING_QUESTIONS.map(q => q.dimension);
    const unique = [...new Set(dims)];
    assert.strictEqual(dims.length, unique.length);
  });
});

// ─── CLAUDE_INSTRUCTIONS ──────────────────────────────────────────────────────

describe('CLAUDE_INSTRUCTIONS', () => {
  test('is a non-empty object', () => {
    assert.ok(typeof CLAUDE_INSTRUCTIONS === 'object');
    assert.ok(Object.keys(CLAUDE_INSTRUCTIONS).length > 0);
  });

  test('each dimension has at least one instruction', () => {
    for (const [dim, instructions] of Object.entries(CLAUDE_INSTRUCTIONS)) {
      assert.ok(typeof instructions === 'object', `${dim} should be an object`);
      assert.ok(Object.keys(instructions).length > 0, `${dim} should have instructions`);
    }
  });

  test('every PROFILING_QUESTIONS dimension has CLAUDE_INSTRUCTIONS', () => {
    for (const q of PROFILING_QUESTIONS) {
      assert.ok(
        CLAUDE_INSTRUCTIONS[q.dimension],
        `${q.dimension} has questions but no CLAUDE_INSTRUCTIONS`
      );
    }
  });
});

// ─── write-profile command ────────────────────────────────────────────────────

describe('write-profile command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes USER-PROFILE.md from analysis JSON', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: {
        communication_style: { rating: 'terse-direct', confidence: 'HIGH' },
        decision_speed: { rating: 'fast-intuitive', confidence: 'MEDIUM' },
        explanation_depth: { rating: 'concise', confidence: 'HIGH' },
        debugging_approach: { rating: 'fix-first', confidence: 'LOW' },
        ux_philosophy: { rating: 'function-first', confidence: 'MEDIUM' },
        vendor_philosophy: { rating: 'pragmatic', confidence: 'HIGH' },
        frustration_triggers: { rating: 'over-explanation', confidence: 'LOW' },
        learning_style: { rating: 'hands-on', confidence: 'MEDIUM' },
      },
    };

    const analysisPath = path.join(tmpDir, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(['write-profile', '--input', analysisPath, '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.profile_path, 'should return profile_path');
    assert.ok(out.dimensions_scored > 0, 'should have scored dimensions');
  });

  test('#1114: default output resolves the active runtime config home (codex)', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: { communication_style: { rating: 'terse-direct', confidence: 'HIGH' } },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(
      ['write-profile', '--input', analysisPath, '--raw'],
      tmpDir,
      { CODEX_HOME: codexHome, GSD_RUNTIME: 'codex' }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    // Must land in the Codex home (so Codex advisor-mode finds it), NOT .claude.
    assert.strictEqual(out.profile_path, path.join(codexHome, 'gsd-core', 'USER-PROFILE.md'));
    assert.ok(!out.profile_path.includes(`${path.sep}.claude${path.sep}`),
      `codex profile must not be written under .claude; got ${out.profile_path}`);
    assert.ok(fs.existsSync(out.profile_path), 'runtime-aware profile should be written to disk');
  });

  test('#1114: default output is the .claude config home for the claude runtime', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: { communication_style: { rating: 'terse-direct', confidence: 'HIGH' } },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    // Clear ambient runtime vars so the test is hermetic regardless of the
    // developer's shell (a stray GSD_RUNTIME/CLAUDE_CONFIG_DIR would redirect it).
    const result = runGsdTools(['write-profile', '--input', analysisPath, '--raw'], tmpDir,
      { HOME: tmpDir, GSD_RUNTIME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' });
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    // os.homedir() returns HOME verbatim, so assert on the suffix to stay
    // robust against macOS /var → /private/var symlink normalization.
    assert.ok(
      out.profile_path.endsWith(path.join('.claude', 'gsd-core', 'USER-PROFILE.md')),
      `claude profile must be under .claude/gsd-core; got ${out.profile_path}`
    );
    assert.ok(fs.existsSync(out.profile_path), 'profile should be written to disk');
  });

  test('#1114: config.runtime=codex (no GSD_RUNTIME) also resolves the Codex home', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: { communication_style: { rating: 'terse-direct', confidence: 'HIGH' } },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ runtime: 'codex' }));

    // No GSD_RUNTIME — the runtime must be read from config.runtime.
    const result = runGsdTools(
      ['write-profile', '--input', analysisPath, '--raw'],
      tmpDir,
      { CODEX_HOME: codexHome, GSD_RUNTIME: '' }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.profile_path, path.join(codexHome, 'gsd-core', 'USER-PROFILE.md'));
  });

  test('#2665: ambient CLAUDE_CONFIG_DIR cannot escape a HOME-only sandbox', () => {
    // The defect: TEST_ENV_BASE blanked session-identity vars but none of the
    // config-LOCATION vars, and the dot-home resolver is env-first. So an
    // ambient CLAUDE_CONFIG_DIR in the DEVELOPER'S shell beat `{ HOME: tmpDir }`
    // and the suite wrote into their real config directory. Setting it on the
    // PARENT process is the actual vector — passing it in the per-call env
    // argument would test nothing, because that path was never broken.
    const analysis = {
      profile_version: '1.0',
      dimensions: { communication_style: { rating: 'terse-direct', confidence: 'HIGH' } },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const ambientConfigDir = path.join(tmpDir, 'ambient-live-config');
    fs.mkdirSync(ambientConfigDir, { recursive: true });

    const out = withIsolatedProcessState(() => {
      process.env.CLAUDE_CONFIG_DIR = ambientConfigDir;
      const result = runGsdTools(
        ['write-profile', '--input', analysisPath, '--raw'],
        tmpDir,
        { HOME: tmpDir }
      );
      assert.ok(result.success, `Failed: ${result.error}`);
      return JSON.parse(result.output);
    });

    assert.deepStrictEqual(
      fs.readdirSync(ambientConfigDir),
      [],
      'a call site that sandboxes HOME must not write into an ambient CLAUDE_CONFIG_DIR'
    );
    // Containment via path.relative, not startsWith: startsWith(ambientConfigDir)
    // also matches a SIBLING like `<tmp>/ambient-live-config-2`, so it can report
    // a false leak. A path is inside the dir iff the relative path neither escapes
    // with '..' nor is absolute.
    const rel = path.relative(ambientConfigDir, out.profile_path);
    assert.ok(
      rel.startsWith('..') || path.isAbsolute(rel),
      `profile must not resolve under the ambient config dir, got: ${out.profile_path}`
    );
  });

  test('errors when --input is missing', () => {
    const result = runGsdTools('write-profile --raw', tmpDir);
    assert.ok(!result.success, 'should fail without --input');
    assert.ok(result.error.includes('--input'), 'should mention --input');
  });
});

// ─── generate-claude-md command ───────────────────────────────────────────────

describe('generate-claude-md command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# My Project\n\nA test project.\n\n## Tech Stack\n\n- Node.js\n- TypeScript\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('generates CLAUDE.md with --auto flag', () => {
    const outputPath = path.join(tmpDir, 'CLAUDE.md');
    const result = runGsdTools(['generate-claude-md', '--output', outputPath, '--auto', '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);

    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      assert.ok(content.length > 0, 'should have content');
    }
  });

  test('does not overwrite existing marker-less CLAUDE.md without --force (#1098)', () => {
    const outputPath = path.join(tmpDir, 'CLAUDE.md');
    const original = '# Custom CLAUDE.md\n\nUser content.\n';
    fs.writeFileSync(outputPath, original);

    // No GSD markers in the file → the #1098 guard must leave it untouched.
    const result = runGsdTools(['generate-claude-md', '--output', outputPath, '--auto'], tmpDir);
    assert.ok(result.success, `command should exit 0 even when skipping: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).action, 'skipped');

    const content = fs.readFileSync(outputPath, 'utf-8');
    assert.strictEqual(content, original, 'hand-crafted file must be byte-identical (not overwritten)');
  });

  test('overwrites existing marker-less CLAUDE.md with --force (#1098)', () => {
    const outputPath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(outputPath, '# Custom CLAUDE.md\n\nUser content.\n');

    const result = runGsdTools(['generate-claude-md', '--output', outputPath, '--force'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).action, 'updated');

    const content = fs.readFileSync(outputPath, 'utf-8');
    assert.ok(content.includes('User content.'), '--force preserves existing content while adding sections');
    assert.ok(content.includes('## GSD Workflow Enforcement'), '--force injects GSD sections');
  });

  test('skills fallback mentions the normalized project roots', () => {
    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);

    // #1098: default Claude output is now .claude/CLAUDE.md
    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('.claude/skills/'));
    assert.ok(content.includes('.agents/skills/'));
    assert.ok(content.includes('.cursor/skills/'));
    assert.ok(content.includes('.github/skills/'));
    assert.ok(content.includes('.codex/skills/'));
    assert.ok(!content.includes('gsd-core/skills'));
  });

  test('codex runtime aliases default output to AGENTS.md', () => {
    const result = runGsdTools(
      ['generate-claude-md', '--auto', '--raw'],
      tmpDir,
      { GSD_RUNTIME: 'codex-cli' }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')), 'AGENTS.md should be generated for codex aliases');
  });
});

// ─── generate-dev-preferences ─────────────────────────────────────────────────

describe('generate-dev-preferences command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when --analysis is missing', () => {
    const result = runGsdTools('generate-dev-preferences --raw', tmpDir);
    assert.ok(!result.success, 'should fail without --analysis');
    assert.ok(result.error.includes('--analysis'), 'should mention --analysis');
  });

  test('generates preferences from analysis file', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: {
        communication_style: { rating: 'terse-direct', confidence: 'HIGH' },
        decision_speed: { rating: 'fast-intuitive', confidence: 'MEDIUM' },
      },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(
      ['generate-dev-preferences', '--analysis', analysisPath, '--raw'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.command_path || out.command_name, 'should return command output');
  });

  test('uses runtime-aware skills dir for codex by default', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: {
        communication_style: { rating: 'terse-direct', confidence: 'HIGH' },
      },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(
      ['generate-dev-preferences', '--analysis', analysisPath, '--raw'],
      tmpDir,
      // #2088 (ADR-1239 upgrade 3): Codex skills resolve to $HOME/.agents/skills
      // (HOME-relative), so sandbox HOME to keep the dev-preferences write inside
      // the temp dir rather than the developer's real ~/.agents/skills.
      { CODEX_HOME: codexHome, GSD_RUNTIME: 'codex', HOME: codexHome, USERPROFILE: codexHome }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.command_path, path.join(codexHome, '.agents', 'skills', 'gsd-dev-preferences', 'SKILL.md'));
    assert.ok(fs.existsSync(out.command_path), 'runtime-aware output should be written');
  });

  test('canonicalizes codex runtime aliases for skills output path', () => {
    const analysis = {
      profile_version: '1.0',
      dimensions: {
        communication_style: { rating: 'terse-direct', confidence: 'HIGH' },
      },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(
      ['generate-dev-preferences', '--analysis', analysisPath, '--raw'],
      tmpDir,
      // #2088: codex-app alias canonicalizes to codex → $HOME/.agents/skills.
      { CODEX_HOME: codexHome, GSD_RUNTIME: 'codex-app', HOME: codexHome, USERPROFILE: codexHome }
    );
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.command_path, path.join(codexHome, '.agents', 'skills', 'gsd-dev-preferences', 'SKILL.md'));
  });

  test('uses runtime-aware skills dir for cline by default (#782)', () => {
    // Cline >= v3.48.0 is skills-capable: ~/.cline/skills/<name>/SKILL.md
    const analysis = {
      profile_version: '1.0',
      dimensions: {
        communication_style: { rating: 'terse-direct', confidence: 'HIGH' },
      },
    };
    const analysisPath = path.join(tmpDir, 'analysis.json');
    const clineHome = path.join(tmpDir, 'cline-home');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));

    const result = runGsdTools(
      ['generate-dev-preferences', '--analysis', analysisPath, '--raw'],
      tmpDir,
      { CLINE_CONFIG_DIR: clineHome, GSD_RUNTIME: 'cline' }
    );
    assert.ok(result.success, `cline skills output should succeed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.command_path, path.join(clineHome, 'skills', 'gsd-dev-preferences', 'SKILL.md'));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2415-claude-md-link-mode.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2415-claude-md-link-mode (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2415)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for claude_md_assembly "link" mode (#2415).
 * Verifies that generate-claude-md writes @-references instead of inlined
 * content when claude_md_assembly.mode is "link".
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const helpers = require('./helpers.cjs');

const { cmdGenerateClaudeMd } = require('../gsd-core/bin/lib/profile-output.cjs');

const _dirsToClean = [];
after(() => { for (const d of _dirsToClean) helpers.cleanup(d); });

function makeTempProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2415-'));
  _dirsToClean.push(dir);
  fs.mkdirSync(path.join(dir, '.planning', 'codebase'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

test('link mode writes @-reference for architecture section', () => {
  const dir = makeTempProject({
    '.planning/codebase/ARCHITECTURE.md': '# Architecture\n\n- layered\n',
    '.planning/config.json': JSON.stringify({ claude_md_assembly: { mode: 'link' } }),
  });

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  assert.ok(content.includes('@.planning/codebase/ARCHITECTURE.md'), 'should contain @-reference');
  assert.ok(!content.includes('- layered'), 'should not inline architecture content');
});

test('link mode writes @-reference for project section', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# My Project\n\n## What This Is\n\nA great app.\n',
    '.planning/config.json': JSON.stringify({ claude_md_assembly: { mode: 'link' } }),
  });

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  assert.ok(content.includes('@.planning/PROJECT.md'), 'should contain @-reference for project');
  assert.ok(!content.includes('A great app.'), 'should not inline project content');
});

test('embed mode (default) inlines content as before', () => {
  const dir = makeTempProject({
    '.planning/codebase/ARCHITECTURE.md': '# Architecture\n\n- monolith\n',
  });

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  assert.ok(content.includes('- monolith'), 'embed mode should inline content');
  assert.ok(!content.includes('@.planning/codebase/ARCHITECTURE.md'), 'embed mode should not write @-reference');
});

test('per-block override: link only architecture, embed others', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# Proj\n\n## What This Is\n\nApp.\n',
    '.planning/codebase/ARCHITECTURE.md': '# Arch\n\n- layers\n',
    '.planning/config.json': JSON.stringify({ claude_md_assembly: { mode: 'embed', blocks: { architecture: 'link' } } }),
  });

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  assert.ok(content.includes('@.planning/codebase/ARCHITECTURE.md'), 'architecture should use link');
  assert.ok(!content.includes('@.planning/PROJECT.md'), 'project should use embed');
  assert.ok(content.includes('App.'), 'project content should be inlined');
});

test('link mode falls back to embed for workflow section (no linkable source)', () => {
  const dir = makeTempProject({
    '.planning/config.json': JSON.stringify({ claude_md_assembly: { mode: 'link' } }),
  });

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  // workflow section should still be inlined (it has no linkPath)
  assert.ok(!content.includes('@GSD defaults'), 'workflow should not write @GSD defaults');
  assert.ok(content.includes('GSD Workflow Enforcement'), 'workflow content should be embedded inline');
});

test('link mode falls back to embed when source file is missing (hasFallback)', () => {
  const dir = makeTempProject({
    '.planning/config.json': JSON.stringify({ claude_md_assembly: { mode: 'link' } }),
  });
  // No .planning/codebase/ARCHITECTURE.md — generator will use fallback

  cmdGenerateClaudeMd(dir, { output: path.join(dir, 'CLAUDE.md') }, false);

  const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  assert.ok(!content.includes('@.planning/codebase/ARCHITECTURE.md'), 'fallback section should not write @-reference');
});
  });
}
