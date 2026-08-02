/**
 * GSD Tools Tests - docs-update
 *
 * Integration tests for the docs-init gsd-tools subcommand.
 * Covers: JSON output shape, project type detection, existing doc scanning,
 * GSD marker detection, and doc tooling detection.
 *
 * Requirements: VERF-03
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const MODEL_PROFILES = require('../gsd-core/bin/lib/model-profiles.cjs').MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

function createCompleteCodexAgents(projectRoot) {
  const agentsDir = path.join(projectRoot, '.codex', 'agents');
  const files = {};
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), `# ${name}\n`);
    fs.writeFileSync(path.join(agentsDir, `${name}.toml`), `name = "${name}"\n`);
    files[`agents/${name}.md`] = {};
    files[`agents/${name}.toml`] = {};
  }
  fs.writeFileSync(path.join(projectRoot, '.codex', 'gsd-file-manifest.json'), JSON.stringify({ files }));
}

// ─── JSON output shape ────────────────────────────────────────────────────────

describe('docs-init command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns expected JSON shape', () => {
    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);

    // Top-level scalar fields
    assert.strictEqual(typeof data.doc_writer_model, 'string');
    assert.strictEqual(typeof data.commit_docs, 'boolean');
    assert.strictEqual(typeof data.planning_exists, 'boolean');
    assert.strictEqual(typeof data.project_root, 'string');
    assert.strictEqual(typeof data.agents_installed, 'boolean');

    // Array fields
    assert.ok(Array.isArray(data.existing_docs), 'existing_docs should be an array');
    assert.ok(Array.isArray(data.monorepo_workspaces), 'monorepo_workspaces should be an array');
    assert.ok(Array.isArray(data.missing_agents), 'missing_agents should be an array');

    // project_type object with 7 boolean fields
    assert.ok(data.project_type && typeof data.project_type === 'object', 'project_type should be an object');
    assert.strictEqual(typeof data.project_type.has_package_json, 'boolean');
    assert.strictEqual(typeof data.project_type.has_api_routes, 'boolean');
    assert.strictEqual(typeof data.project_type.has_cli_bin, 'boolean');
    assert.strictEqual(typeof data.project_type.is_open_source, 'boolean');
    assert.strictEqual(typeof data.project_type.has_deploy_config, 'boolean');
    assert.strictEqual(typeof data.project_type.is_monorepo, 'boolean');
    assert.strictEqual(typeof data.project_type.has_tests, 'boolean');

    // doc_tooling object with 4 boolean fields
    assert.ok(data.doc_tooling && typeof data.doc_tooling === 'object', 'doc_tooling should be an object');
    assert.strictEqual(typeof data.doc_tooling.docusaurus, 'boolean');
    assert.strictEqual(typeof data.doc_tooling.vitepress, 'boolean');
    assert.strictEqual(typeof data.doc_tooling.mkdocs, 'boolean');
    assert.strictEqual(typeof data.doc_tooling.storybook, 'boolean');

    // planning_exists is true since createTempProject creates .planning/
    assert.strictEqual(data.planning_exists, true);
  });

  test('bare project returns all false signals', () => {
    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);

    // All project_type fields should be false for a bare project
    assert.strictEqual(data.project_type.has_package_json, false);
    assert.strictEqual(data.project_type.has_api_routes, false);
    assert.strictEqual(data.project_type.has_cli_bin, false);
    assert.strictEqual(data.project_type.is_open_source, false);
    assert.strictEqual(data.project_type.has_deploy_config, false);
    assert.strictEqual(data.project_type.is_monorepo, false);
    assert.strictEqual(data.project_type.has_tests, false);

    // No docs, no workspaces, no doc tooling
    assert.deepEqual(data.existing_docs, []);
    assert.deepEqual(data.monorepo_workspaces, []);
    assert.strictEqual(data.doc_tooling.docusaurus, false);
    assert.strictEqual(data.doc_tooling.vitepress, false);
    assert.strictEqual(data.doc_tooling.mkdocs, false);
    assert.strictEqual(data.doc_tooling.storybook, false);
  });
});

describe('docs-init Codex project-local agent status', () => {
  let tmpDir;
  let globalHome;

  beforeEach(() => {
    tmpDir = createTempProject();
    globalHome = path.join(tmpDir, 'global-codex');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ runtime: 'codex' }));
    fs.mkdirSync(path.join(globalHome, 'agents'), { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(globalHome, 'agents', `${name}.md`), `# global-${name}\n`);
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports a complete local Codex installation instead of a global fixture', () => {
    createCompleteCodexAgents(tmpDir);

    const result = runGsdTools('docs-init --raw', tmpDir, { CODEX_HOME: globalHome });
    assert.ok(result.success, `docs-init failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.project_root, fs.realpathSync(tmpDir));
    assert.strictEqual(output.agents_installed, true);
    assert.deepStrictEqual(output.missing_agents, []);
  });

  test('reports an empty local Codex directory as unhealthy even with global agents', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.codex', 'gsd-file-manifest.json'), JSON.stringify({ files: {} }));

    const result = runGsdTools('docs-init --raw', tmpDir, { CODEX_HOME: globalHome });
    assert.ok(result.success, `docs-init failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, false);
    assert.deepStrictEqual(output.missing_agents, EXPECTED_AGENTS);
  });
});

// ─── response_language wiring (#2402) ─────────────────────────────────────────
//
// cmdDocsInit predates withProjectRoot (init.cts) and never picked up
// response_language, so docs-update's orchestrator-owned prompts silently
// stayed English even with response_language configured. Mirrors the
// established `init manager` response_language coverage pattern
// (tests/init-manager.test.cjs).

describe('docs-init response_language wiring (#2402)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('output includes response_language when configured', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ response_language: 'Japanese' })
    );

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.response_language, 'Japanese');
  });

  test('output omits response_language when not configured', () => {
    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.response_language, undefined);
  });
});

// ─── project type detection ───────────────────────────────────────────────────

describe('project type detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects CLI tool from package.json bin field', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-cli', bin: { mycli: 'bin/cli.js' } }),
      'utf-8'
    );

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.has_cli_bin, true);
    assert.strictEqual(data.project_type.has_package_json, true);
  });

  test('detects open source from LICENSE file', () => {
    fs.writeFileSync(path.join(tmpDir, 'LICENSE'), 'MIT License', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.is_open_source, true);
  });

  test('detects monorepo from package.json workspaces', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      'utf-8'
    );

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.is_monorepo, true);
    assert.ok(data.monorepo_workspaces.includes('packages/*'), 'monorepo_workspaces should contain packages/*');
  });

  test('detects tests from tests directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.has_tests, true);
  });

  test('detects deploy config from Dockerfile', () => {
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.has_deploy_config, true);
  });

  test('detects API routes from src/app/api directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'app', 'api'), { recursive: true });

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.project_type.has_api_routes, true);
  });
});

// ─── existing doc scanning ────────────────────────────────────────────────────

describe('existing doc scanning', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('scans .md files in project root', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# README\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'ARCHITECTURE.md'), '# Architecture\n', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.ok(data.existing_docs.length >= 2, 'existing_docs should contain at least 2 entries');

    const paths = data.existing_docs.map(d => d.path);
    assert.ok(paths.includes('README.md'), 'existing_docs should contain README.md');
    assert.ok(paths.includes('ARCHITECTURE.md'), 'existing_docs should contain ARCHITECTURE.md');
  });

  test('detects GSD marker in existing docs', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '<!-- generated-by: gsd-doc-writer -->\n# README\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(tmpDir, 'NOTES.md'), '# Notes\n', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);

    const readmeEntry = data.existing_docs.find(d => d.path === 'README.md');
    assert.ok(readmeEntry, 'README.md should appear in existing_docs');
    assert.strictEqual(readmeEntry.has_gsd_marker, true, 'README.md should have GSD marker');

    const notesEntry = data.existing_docs.find(d => d.path === 'NOTES.md');
    assert.ok(notesEntry, 'NOTES.md should appear in existing_docs');
    assert.strictEqual(notesEntry.has_gsd_marker, false, 'NOTES.md should not have GSD marker');
  });
});

// ─── doc tooling detection ────────────────────────────────────────────────────

describe('doc tooling detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects Docusaurus config', () => {
    fs.writeFileSync(path.join(tmpDir, 'docusaurus.config.js'), 'module.exports = {};', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.doc_tooling.docusaurus, true);
  });

  test('detects VitePress config', () => {
    fs.mkdirSync(path.join(tmpDir, '.vitepress'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vitepress', 'config.ts'), 'export default {};', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.doc_tooling.vitepress, true);
  });

  test('detects MkDocs config', () => {
    fs.writeFileSync(path.join(tmpDir, 'mkdocs.yml'), 'site_name: test', 'utf-8');

    const result = runGsdTools(['docs-init'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    assert.strictEqual(data.doc_tooling.mkdocs, true);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3135-capture-backlog-workflow.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3135-capture-backlog-workflow (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product — workflow and command .md files (see #3135)
// ARE what the runtime loads; asserting their existence and behavioral content
// tests the deployed skill surface contract, not implementation internals.

'use strict';

// Regression tests for bug #3135.
//
// PR #2824 consolidated add-backlog into `gsd-capture --backlog` by creating
// a routing wrapper in commands/gsd/capture.md that delegates to
// workflows/add-backlog.md via execution_context. The workflow file was never
// created. Same gap class as reapply-patches.md (found and fixed in the same PR).
//
// Fix: create gsd-core/workflows/add-backlog.md with the full process
// ported from the deleted commands/gsd/add-backlog.md (git ref 87917131^).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'add-backlog.md');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

// ─── #3135: add-backlog workflow ─────────────────────────────────────────────

describe('#3135: gsd-core/workflows/add-backlog.md', () => {
  test('file exists', () => {
    assert.ok(
      fs.existsSync(WORKFLOW),
      'gsd-core/workflows/add-backlog.md does not exist — capture --backlog has no implementation to load',
    );
  });

  test('uses gsd-sdk query phase.next-decimal to find next 999.x slot', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('phase.next-decimal'),
      'add-backlog.md must use gsd-sdk query phase.next-decimal to find the next 999.x number',
    );
  });

  test('writes to ROADMAP.md', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(src.includes('ROADMAP.md'), 'add-backlog.md must write to ROADMAP.md');
  });

  test('creates a .planning/phases/ directory', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('.planning/phases') || src.includes('planning/phases'),
      'add-backlog.md must create a phase directory under .planning/phases/',
    );
  });

  test('uses generate-slug for the directory name', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('generate-slug'),
      'add-backlog.md must use gsd-sdk query generate-slug to build the phase directory slug',
    );
  });

  test('commits via gsd-sdk query commit', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('gsd-sdk query commit') || src.includes('query commit'),
      'add-backlog.md must commit via gsd-sdk query commit',
    );
  });

  test('writes ROADMAP entry before creating directory (#2280 ordering invariant)', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    const roadmapIdx = src.indexOf('ROADMAP.md');
    const mkdirIdx = src.search(/mkdir|\.gitkeep/);
    assert.ok(roadmapIdx !== -1, 'ROADMAP.md write step not found');
    assert.ok(mkdirIdx !== -1, 'directory creation step not found');
    assert.ok(
      roadmapIdx < mkdirIdx,
      'ROADMAP.md entry must be written BEFORE the phase directory is created (#2280 ordering invariant)',
    );
  });

  test('uses 999.x numbering for backlog items', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('999'),
      'add-backlog.md must document 999.x numbering scheme for backlog items',
    );
  });

  test('documents /gsd-review-backlog for promotion', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(
      src.includes('review-backlog') || src.includes('gsd-review-backlog'),
      'add-backlog.md should mention /gsd-review-backlog for promoting items to active milestone',
    );
  });
});

// ─── capture.md routing integrity ────────────────────────────────────────────

describe('#3135: capture.md correctly routes --backlog to add-backlog workflow', () => {
  function executionContextIncludes(body) {
    const blocks = [
      ...body.matchAll(/<execution_context(?:_extended)?>([\s\S]*?)<\/execution_context(?:_extended)?>/g),
    ].map((m) => m[1]);
    const targets = [];
    for (const blk of blocks) {
      for (const line of blk.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('@')) continue;
        const rel = t.replace(/^@~?\/?(?:\.claude\/)?(?:gsd-core\/)?/, '');
        targets.push(rel);
      }
    }
    return targets;
  }

  test('capture.md execution_context @-includes add-backlog.md', () => {
    const body = fs.readFileSync(path.join(COMMANDS_DIR, 'capture.md'), 'utf8');
    const targets = executionContextIncludes(body);
    assert.ok(
      targets.some((t) => /(^|\/)workflows\/add-backlog\.md$/.test(t)),
      `capture.md execution_context must @-include workflows/add-backlog.md; got: ${JSON.stringify(targets)}`,
    );
  });
});

  });
}
