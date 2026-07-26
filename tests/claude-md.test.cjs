// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * CLAUDE.md generation and new-project workflow tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('generate-claude-md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates CLAUDE.md with workflow enforcement section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA small test project.\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.action, 'created');
    assert.strictEqual(output.sections_total, 6);
    assert.ok(output.sections_generated.includes('workflow'));

    const claudePath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    const content = fs.readFileSync(claudePath, 'utf-8');
    assert.ok(content.includes('## GSD Workflow Enforcement'));
    // #3584: generated CLAUDE.md must emit the runtime-routable hyphen-form
    // (Claude/Cursor/OpenCode/Kilo etc.); the legacy colon form is no longer
    // dispatched by current skill installs.
    assert.ok(content.includes('/gsd-quick'));
    assert.ok(content.includes('/gsd-debug'));
    assert.ok(content.includes('/gsd-execute-phase'));
    assert.ok(!content.includes('/gsd:quick'));
    assert.ok(!content.includes('/gsd:execute-phase'));
    assert.ok(content.includes('Do not make direct repo edits outside a GSD workflow'));
  });

  test('adds workflow enforcement section when force-updating an existing marker-less CLAUDE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA small test project.\n'
    );
    // #1098: a hand-crafted file (no GSD markers) is only overwritten with --force.
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), '## Local Notes\n\nKeep this intro.\n');

    const result = runGsdTools('generate-claude-md --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.action, 'updated');

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('## Local Notes'));
    assert.ok(content.includes('## GSD Workflow Enforcement'));
  });

  test('#1098: does NOT clobber an existing marker-less CLAUDE.md without --force', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA small test project.\n'
    );
    const handCrafted = '## My Hand-Crafted Instructions\n\nDo exactly what I say.\n';
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), handCrafted);

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.action, 'skipped', 'must skip a hand-crafted file without --force');

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.strictEqual(content, handCrafted, 'hand-crafted file must be left byte-identical');
    assert.ok(!content.includes('## GSD Workflow Enforcement'), 'GSD sections must NOT be injected');
  });

  test('#1098: updates an existing GSD-managed CLAUDE.md (has markers) without --force', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA small test project.\n'
    );
    // First generation creates a GSD-managed file (with markers).
    const first = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(first.success, `Command failed: ${first.error}`);
    assert.strictEqual(JSON.parse(first.output).action, 'created');

    // Re-running updates it in place — markers present, so no --force needed.
    const second = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(second.success, `Command failed: ${second.error}`);
    assert.strictEqual(JSON.parse(second.output).action, 'updated');
  });

  test('#1098: defaults the Claude-runtime output to .claude/CLAUDE.md (not repo root)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA small test project.\n'
    );
    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(
      output.claude_md_path.replace(/\\/g, '/').endsWith('/.claude/CLAUDE.md'),
      `default output must be .claude/CLAUDE.md; got ${output.claude_md_path}`
    );
    assert.ok(!fs.existsSync(path.join(tmpDir, 'CLAUDE.md')), 'must NOT create a repo-root CLAUDE.md');
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md')), 'must create .claude/CLAUDE.md');
  });
});

describe('new-project workflow includes CLAUDE.md generation', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-project.md');
  const commandsPath = path.join(__dirname, '..', 'docs', 'COMMANDS.md');

  test('new-project workflow generates instruction file before final commit', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('generate-claude-md'));
    // Codex fix: workflow now uses $INSTRUCTION_FILE (AGENTS.md for Codex, CLAUDE.md otherwise)
    assert.ok(
      content.includes('.planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md "$INSTRUCTION_FILE"'),
      'final roadmap commit should stage ROADMAP, STATE, REQUIREMENTS, and instruction file'
    );
  });

  test('new-project artifacts reference instruction file variable', () => {
    const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
    const commandsContent = fs.readFileSync(commandsPath, 'utf-8');

    // Codex fix: hardcoded CLAUDE.md replaced with $INSTRUCTION_FILE variable
    assert.ok(workflowContent.includes('| Project guide  | `$INSTRUCTION_FILE`'));
    assert.ok(workflowContent.includes('- `$INSTRUCTION_FILE`'));
    assert.ok(commandsContent.includes('`CLAUDE.md`'));
  });
});

describe('generate-claude-md skills section', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## What This Is\n\nA test project.\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('includes skills fallback when no skills directories exist', () => {
    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.sections_fallback.includes('skills'));

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('<!-- GSD:skills-start'));
    assert.ok(content.includes('<!-- GSD:skills-end -->'));
    assert.ok(content.includes('No project skills found. Add skills to any of'));
  });

  test('discovers skills from .claude/skills/ directory', () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'api-payments');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: api-payments\ndescription: Payment gateway integration.\n---\n\n# API Payments\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.sections_generated.includes('skills'));
    assert.ok(!output.sections_fallback.includes('skills'));

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('api-payments'));
    assert.ok(content.includes('Payment gateway integration'));
    assert.ok(content.includes('## Project Skills'));
  });

  test('discovers skills from .agents/skills/ directory', () => {
    const skillDir = path.join(tmpDir, '.agents', 'skills', 'data-sync');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: data-sync\ndescription: ERP synchronization flows.\n---\n\n# Data Sync\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('data-sync'));
    assert.ok(content.includes('ERP synchronization flows'));
  });

  test('discovers skills from .codex/skills/ directory and ignores deprecated import-only roots', () => {
    const codexSkillDir = path.join(tmpDir, '.codex', 'skills', 'automation');
    fs.mkdirSync(codexSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexSkillDir, 'SKILL.md'),
      '---\nname: automation\ndescription: Project Codex skill.\n---\n\n# Automation\n'
    );

    const homeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-claude-skills-home-'));
    fs.mkdirSync(path.join(homeDir, '.claude', 'gsd-core', 'skills', 'import-only'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'gsd-core', 'skills', 'import-only', 'SKILL.md'),
      '---\nname: import-only\ndescription: Deprecated import-only skill.\n---\n'
    );

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const result = runGsdTools('generate-claude-md', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
      assert.ok(content.includes('automation'));
      assert.ok(content.includes('Project Codex skill'));
      assert.ok(!content.includes('import-only'));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      cleanup(homeDir);
    }
  });

  test('skips gsd- prefixed skill directories', () => {
    const gsdSkillDir = path.join(tmpDir, '.claude', 'skills', 'gsd-plan-phase');
    const userSkillDir = path.join(tmpDir, '.claude', 'skills', 'my-feature');
    fs.mkdirSync(gsdSkillDir, { recursive: true });
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdSkillDir, 'SKILL.md'),
      '---\nname: gsd-plan-phase\ndescription: GSD internal skill.\n---\n'
    );
    fs.writeFileSync(
      path.join(userSkillDir, 'SKILL.md'),
      '---\nname: my-feature\ndescription: Custom project skill.\n---\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(!content.includes('gsd-plan-phase'));
    assert.ok(content.includes('my-feature'));
    assert.ok(content.includes('Custom project skill'));
  });

  test('handles multi-line description in frontmatter', () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'complex-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: complex-skill\ndescription: First line of description.\n  Continued on second line.\n  And a third line.\n---\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('First line of description'));
    assert.ok(content.includes('Continued on second line'));
    assert.ok(content.includes('And a third line'));
  });

  test('deduplicates skills found in multiple directories', () => {
    // Same skill in both .claude/skills/ and .agents/skills/
    const dir1 = path.join(tmpDir, '.claude', 'skills', 'shared-skill');
    const dir2 = path.join(tmpDir, '.agents', 'skills', 'shared-skill');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    const skillContent = '---\nname: shared-skill\ndescription: Appears twice.\n---\n';
    fs.writeFileSync(path.join(dir1, 'SKILL.md'), skillContent);
    fs.writeFileSync(path.join(dir2, 'SKILL.md'), skillContent);

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    const matches = content.match(/shared-skill/g);
    // Should appear exactly twice: once in name column, once in path column (single row)
    assert.strictEqual(matches.length, 2);
  });

  test('updates existing skills section on regeneration', () => {
    // First generation — no skills
    runGsdTools('generate-claude-md', tmpDir);
    let content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('No project skills found'));

    // Add a skill and regenerate
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'new-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: new-skill\ndescription: Just added.\n---\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    assert.ok(!content.includes('No project skills found'));
    assert.ok(content.includes('new-skill'));
    assert.ok(content.includes('Just added'));
  });

  test('skills section appears between architecture and workflow', () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'ordering-test');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: ordering-test\ndescription: Verify section order.\n---\n'
    );

    const result = runGsdTools('generate-claude-md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    const archIdx = content.indexOf('## Architecture');
    const skillsIdx = content.indexOf('## Project Skills');
    const workflowIdx = content.indexOf('## GSD Workflow Enforcement');
    assert.ok(archIdx < skillsIdx, 'Skills section should come after Architecture');
    assert.ok(skillsIdx < workflowIdx, 'Skills section should come before Workflow Enforcement');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3163-codex-agents-md.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3163-codex-agents-md (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Bug #3163: generate-claude-md should write to AGENTS.md on Codex runtime.
 *
 * When config.runtime === 'codex' (or GSD_RUNTIME=codex), the generate-claude-md
 * handler must resolve the output path to AGENTS.md, not CLAUDE.md.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #3163: generate-claude-md uses AGENTS.md for Codex runtime', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\nA Codex-hosted project.\n',
      'utf-8'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes to AGENTS.md when config.runtime is codex and no --output given', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtime: 'codex', claude_md_path: './CLAUDE.md' }),
      'utf-8'
    );

    const result = runGsdTools('generate-claude-md', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    const expectedAgentsPath = path.join(realTmpDir, 'AGENTS.md');

    // The returned path must be AGENTS.md, not CLAUDE.md
    assert.strictEqual(parsed.claude_md_path, expectedAgentsPath,
      `Expected output path to be AGENTS.md but got: ${parsed.claude_md_path}`
    );
    // AGENTS.md must exist on disk
    assert.ok(fs.existsSync(expectedAgentsPath), 'AGENTS.md must exist after generation');
    // CLAUDE.md must NOT be created
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'CLAUDE.md')), 'CLAUDE.md must not be created for Codex runtime');
  });

  test('writes to AGENTS.md when GSD_RUNTIME=codex env var is set (env takes precedence over config)', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    // Config says runtime: claude but env overrides to codex
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtime: 'claude', claude_md_path: './CLAUDE.md' }),
      'utf-8'
    );

    const result = runGsdTools('generate-claude-md', tmpDir, { HOME: tmpDir, GSD_RUNTIME: 'codex' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    const expectedAgentsPath = path.join(realTmpDir, 'AGENTS.md');

    assert.strictEqual(parsed.claude_md_path, expectedAgentsPath,
      `Expected output path to be AGENTS.md but got: ${parsed.claude_md_path}`
    );
    assert.ok(fs.existsSync(expectedAgentsPath), 'AGENTS.md must exist after generation');
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'CLAUDE.md')), 'CLAUDE.md must not be created when GSD_RUNTIME=codex');
  });

  test('--output flag overrides runtime detection when explicitly provided', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtime: 'codex', claude_md_path: './CLAUDE.md' }),
      'utf-8'
    );

    // When --output is explicitly provided, it must be honoured regardless of runtime
    const result = runGsdTools(
      ['generate-claude-md', '--output', 'EXPLICIT-OUTPUT.md'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    assert.strictEqual(
      parsed.claude_md_path,
      path.join(realTmpDir, 'EXPLICIT-OUTPUT.md'),
      `Expected explicit --output to be honoured, got: ${parsed.claude_md_path}`
    );
  });

  test('non-codex runtime still writes to CLAUDE.md', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtime: 'claude', claude_md_path: './CLAUDE.md' }),
      'utf-8'
    );

    const result = runGsdTools('generate-claude-md', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    assert.strictEqual(
      parsed.claude_md_path,
      path.join(realTmpDir, 'CLAUDE.md'),
      `Expected CLAUDE.md for claude runtime, got: ${parsed.claude_md_path}`
    );
    assert.ok(fs.existsSync(path.join(realTmpDir, 'CLAUDE.md')), 'CLAUDE.md must exist for claude runtime');
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'AGENTS.md')), 'AGENTS.md must not be created for claude runtime');
  });
});
  });
}

// ─── Bug #2565: generate-claude-profile runtime-aware target ─────────────
// #2565 is the same divergence class as #3163 above, but in the sibling
// handler cmdGenerateClaudeProfile (the /gsd-profile-user surface) instead
// of cmdGenerateClaudeMd. The #3163 fix did not propagate here, so
// generate-claude-profile kept writing .claude/CLAUDE.md on Codex installs.
// These tests pin the parity contract: both handlers MUST resolve the
// project instruction file through getProjectInstructionFile for non-claude
// runtimes, and the final test asserts the two never diverge again
// (the "generative fix divergence" guard from CLAUDE.md).
describe('bug #2565: generate-claude-profile uses AGENTS.md for Codex runtime', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\nA Codex-hosted project.\n',
      'utf-8'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeAnalysis() {
    const analysisPath = path.join(tmpDir, '.planning', 'analysis.json');
    fs.writeFileSync(
      analysisPath,
      JSON.stringify({
        dimensions: { communication_style: { rating: 'terse-direct', confidence: 'HIGH' } },
        data_source: 'test',
      }),
      'utf-8'
    );
    return analysisPath;
  }

  function writeConfig(obj) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(obj),
      'utf-8'
    );
  }

  test('project scope writes AGENTS.md when config.runtime is codex (stale claude_md_path overridden)', () => {
    writeConfig({ runtime: 'codex', claude_md_path: './CLAUDE.md' });
    const analysisPath = writeAnalysis();

    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    const expectedAgentsPath = path.join(realTmpDir, 'AGENTS.md');

    assert.strictEqual(parsed.claude_md_path, expectedAgentsPath,
      `Expected output path to be AGENTS.md but got: ${parsed.claude_md_path}`);
    assert.ok(fs.existsSync(expectedAgentsPath), 'AGENTS.md must exist after generation');
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'CLAUDE.md')),
      'CLAUDE.md must not be created for Codex runtime');
  });

  test('project scope: GSD_RUNTIME=codex env var overrides config.runtime=claude', () => {
    writeConfig({ runtime: 'claude', claude_md_path: './CLAUDE.md' });
    const analysisPath = writeAnalysis();

    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath],
      tmpDir,
      { HOME: tmpDir, GSD_RUNTIME: 'codex' }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    assert.strictEqual(parsed.claude_md_path, path.join(realTmpDir, 'AGENTS.md'),
      `Expected AGENTS.md under GSD_RUNTIME=codex but got: ${parsed.claude_md_path}`);
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'CLAUDE.md')),
      'CLAUDE.md must not be created when GSD_RUNTIME=codex');
  });

  test('project scope: --output flag overrides runtime detection when explicitly provided', () => {
    writeConfig({ runtime: 'codex', claude_md_path: './CLAUDE.md' });
    const analysisPath = writeAnalysis();

    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath, '--output', 'EXPLICIT-OUTPUT.md'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    assert.strictEqual(parsed.claude_md_path, path.join(realTmpDir, 'EXPLICIT-OUTPUT.md'),
      `Expected explicit --output honoured but got: ${parsed.claude_md_path}`);
  });

  test('project scope: claude runtime still writes .claude/CLAUDE.md', () => {
    writeConfig({ runtime: 'claude', claude_md_path: './.claude/CLAUDE.md' });
    const analysisPath = writeAnalysis();

    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const realTmpDir = fs.realpathSync(tmpDir);
    assert.strictEqual(parsed.claude_md_path, path.join(realTmpDir, '.claude', 'CLAUDE.md'),
      `Expected .claude/CLAUDE.md for claude runtime but got: ${parsed.claude_md_path}`);
    assert.ok(fs.existsSync(path.join(realTmpDir, '.claude', 'CLAUDE.md')),
      '.claude/CLAUDE.md must exist for claude runtime');
    assert.ok(!fs.existsSync(path.join(realTmpDir, 'AGENTS.md')),
      'AGENTS.md must not be created for claude runtime');
  });

  test('global scope: codex runtime writes to <CODEX_HOME>/AGENTS.md', () => {
    writeConfig({ runtime: 'codex' });
    const analysisPath = writeAnalysis();
    const codexHome = path.join(tmpDir, 'codex-config');

    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath, '--global'],
      tmpDir,
      { HOME: tmpDir, CODEX_HOME: codexHome }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    const expected = path.join(codexHome, 'AGENTS.md');
    assert.strictEqual(parsed.claude_md_path, expected,
      `Expected <CODEX_HOME>/AGENTS.md but got: ${parsed.claude_md_path}`);
    assert.ok(fs.existsSync(expected), '<CODEX_HOME>/AGENTS.md must exist after generation');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md')),
      '~/.claude/CLAUDE.md must not be created for Codex global profile');
  });

  test('global scope: claude runtime writes to ~/.claude/CLAUDE.md (preserved, no env drift)', () => {
    writeConfig({ runtime: 'claude' });
    const analysisPath = writeAnalysis();

    // #2659: set USERPROFILE alongside HOME so os.homedir() resolves to tmpDir
    // on Windows too — Node's os.homedir() reads USERPROFILE on Windows and
    // HOME on POSIX, so HOME alone leaves the real user profile in place on
    // Windows and the path assertion fails cross-platform.
    const result = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath, '--global'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.claude_md_path, path.join(tmpDir, '.claude', 'CLAUDE.md'),
      `Expected ~/.claude/CLAUDE.md for claude global but got: ${parsed.claude_md_path}`);
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md')),
      '~/.claude/CLAUDE.md must exist for claude global profile');
  });

  // Parity guard (CLAUDE.md "Generative Fix Divergence"): both
  // generate-claude-md and generate-claude-profile MUST resolve the SAME
  // project instruction path for the same runtime. Fails loudly if either
  // handler re-diverges (the original #3163 -> #2565 drift).
  test('parity: generate-claude-md and generate-claude-profile agree on project instruction path for codex', () => {
    writeConfig({ runtime: 'codex' });
    const analysisPath = writeAnalysis();

    const mdResult = runGsdTools('generate-claude-md', tmpDir, { HOME: tmpDir });
    assert.ok(mdResult.success, `generate-claude-md failed: ${mdResult.error}`);
    const mdParsed = JSON.parse(mdResult.output);

    // generate-claude-md created AGENTS.md; remove it so generate-claude-profile
    // starts from the same empty-project state (independent parity read).
    try { fs.unlinkSync(mdParsed.claude_md_path); } catch { /* already gone */ }

    const profileResult = runGsdTools(
      ['generate-claude-profile', '--analysis', analysisPath],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(profileResult.success, `generate-claude-profile failed: ${profileResult.error}`);
    const profileParsed = JSON.parse(profileResult.output);

    assert.strictEqual(profileParsed.claude_md_path, mdParsed.claude_md_path,
      `Divergence: generate-claude-md targeted ${mdParsed.claude_md_path} but ` +
      `generate-claude-profile targeted ${profileParsed.claude_md_path}. ` +
      `Both handlers must share the runtime-aware instruction-file policy.`);
  });
});
