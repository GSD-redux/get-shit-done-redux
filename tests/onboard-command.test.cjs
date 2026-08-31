// docs-guard-exempt: docs/adr/0001-runtime.md fixtures are synthetic files written into a tmpDir, never the shipped docs/ tree.
// allow-test-rule: source-text-is-the-product (see #1990)
// Command/workflow markdown is deployed runtime product; source-text assertions
// below verify the installed command contract. CLI assertions exercise real
// gsd-tools behavior through the public command boundary.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, cleanup, absPlanningPath } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');

const ROOT = path.join(__dirname, '..');
const CMD_PATH = path.join(ROOT, 'commands', 'gsd', 'onboard.md');
const WF_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'onboard.md');

describe('init onboard public CLI projection', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: realpath the fixture root so absolute path-field
    // assertions (absPlanningPath comparisons below) match the code's
    // process.cwd()-anchored output — macOS's tmpdir is a symlink
    // (/var/... -> /private/var/...) that a spawned child resolves via
    // realpath but createFixture() does not. No-op on Linux (no symlink).
    tmpDir = fs.realpathSync(createFixture({ planning: false, projectDoc: false }));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports brownfield code, docs, and missing planning state', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'server.ts'), 'export const server = true;\n');
    fs.mkdirSync(path.join(tmpDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'adr', '0001-runtime.md'), '# ADR: Runtime\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.planning_exists, false);
    assert.strictEqual(parsed.project_exists, false);
    assert.strictEqual(parsed.has_existing_code, true);
    assert.strictEqual(parsed.has_codebase_map, false);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 1);
    assert.deepStrictEqual(parsed.codebase_map_files_present, []);
    assert.ok(parsed.doc_candidates.includes('docs/adr/0001-runtime.md'));
    for (const file of ['STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md']) {
      assert.ok(parsed.missing_codebase_map_files.includes(file), `missing map files should include ${file}`);
    }
    assert.strictEqual(parsed.onboarding_summary_exists, false);
    assert.strictEqual(parsed.text_mode, false);
  });

  test('detects planning docs in top-level ADR, PRD, and RFC folders', () => {
    fs.mkdirSync(path.join(tmpDir, 'prd'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'prd', 'product.md'), '# Product Requirements\n');
    fs.mkdirSync(path.join(tmpDir, 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'adr', 'decision.md'), '# Architecture Decision\n');
    fs.mkdirSync(path.join(tmpDir, 'rfc'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'rfc', 'proposal.md'), '# Request for Comments\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 3);
    assert.deepStrictEqual(parsed.doc_candidates, [
      'adr/decision.md',
      'prd/product.md',
      'rfc/proposal.md',
    ]);
  });

  test('detects root-level planning docs without broad repo scan', () => {
    fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '# Product Requirements\n');
    fs.writeFileSync(path.join(tmpDir, 'SPEC.md'), '# Specification\n');
    fs.writeFileSync(path.join(tmpDir, 'RFC.md'), '# Request for Comments\n');
    fs.writeFileSync(path.join(tmpDir, 'ADR.md'), '# Architecture Decision\n');
    fs.writeFileSync(path.join(tmpDir, 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(tmpDir, '0001-decision.md'), '# Decision\n');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'PRD.md'), '# Nested Product Requirements\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 6);
    assert.deepStrictEqual(parsed.doc_candidates, [
      '0001-decision.md',
      'ADR.md',
      'PRD.md',
      'REQUIREMENTS.md',
      'RFC.md',
      'SPEC.md',
    ]);
  });

  test('forwards the --text flag into the public projection', () => {
    const result = runGsdTools(['init', 'onboard', '--text', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.text_mode, true);
  });

  test('reports complete codebase map and onboarding summary in existing planning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'ARCHITECTURE', 'STRUCTURE', 'CONVENTIONS', 'TESTING', 'INTEGRATIONS', 'CONCERNS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.mkdirSync(path.join(tmpDir, '.planning', 'onboarding'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'onboarding', 'SUMMARY.md'), '# Onboarding Summary\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ workflow: { text_mode: true } }));

    const trackedFiles = [
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      path.join(tmpDir, '.planning', 'STATE.md'),
      path.join(tmpDir, '.planning', 'onboarding', 'SUMMARY.md'),
    ];
    const before = new Map(trackedFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    for (const file of trackedFiles) {
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before.get(file), `${path.basename(file)} must not be mutated by init onboard`);
    }

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.planning_exists, true);
    assert.strictEqual(parsed.project_exists, true);
    assert.strictEqual(parsed.requirements_exists, true);
    assert.strictEqual(parsed.roadmap_exists, true);
    assert.strictEqual(parsed.state_exists, true);
    assert.strictEqual(parsed.has_codebase_map, true);
    assert.deepStrictEqual(parsed.missing_codebase_map_files, []);
    assert.strictEqual(parsed.onboarding_summary_exists, true);
    assert.strictEqual(parsed.onboarding_summary_path, absPlanningPath(tmpDir, 'onboarding', 'SUMMARY.md'));
    assert.strictEqual(parsed.text_mode, true);
  });

  test('reports fast codebase map readiness and a complete-map handoff before new-project', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'INTEGRATIONS', 'ARCHITECTURE', 'STRUCTURE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const result = runGsdTools(['init', 'onboard', '--fast', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.map_readiness, 'fast');
    assert.strictEqual(parsed.has_codebase_map, false);
    assert.strictEqual(parsed.has_fast_codebase_map, true);
    assert.strictEqual(parsed.needs_codebase_map, true);
    assert.strictEqual(parsed.needs_fast_codebase_map, false);
    assert.strictEqual(parsed.next_action.kind, 'complete-map-before-new-project');
    assert.strictEqual(parsed.next_action.command, '/gsd-map-codebase');
    assert.match(parsed.next_action.reason, /complete codebase map/i);
    assert.deepStrictEqual(parsed.fast_codebase_map_files_required, [
      'STACK.md',
      'INTEGRATIONS.md',
      'ARCHITECTURE.md',
      'STRUCTURE.md',
    ]);
    assert.deepStrictEqual(parsed.missing_fast_codebase_map_files, []);
  });

  test('routes fast mapped repositories with planning docs to complete map before ingest', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'INTEGRATIONS', 'ARCHITECTURE', 'STRUCTURE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');
    fs.mkdirSync(path.join(tmpDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'adr', '0001-runtime.md'), '# ADR: Runtime\n');

    const result = runGsdTools(['init', 'onboard', '--fast', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.next_action.kind, 'complete-map-before-new-project');
    assert.strictEqual(parsed.next_action.command, '/gsd-map-codebase');
  });

  test('routes planning artifacts without PROJECT.md to partial planning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.next_action.kind, 'partial-planning');
    assert.deepStrictEqual(parsed.next_action.missing, ['PROJECT.md']);
  });

  test('fast mode leaves a fully set-up project at write-summary instead of the complete-map gate (regression #1990: fast map gate misroute)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'INTEGRATIONS', 'ARCHITECTURE', 'STRUCTURE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');
    for (const name of ['PROJECT', 'REQUIREMENTS', 'ROADMAP', 'STATE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', `${name}.md`), `# ${name}\n`);
    }

    const result = runGsdTools(['init', 'onboard', '--fast', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.map_readiness, 'fast');
    assert.strictEqual(parsed.project_exists, true);
    // Once project setup is complete, a fast map must not misroute back to the
    // pre-new-project complete-map handoff; onboarding advances to the summary.
    assert.strictEqual(parsed.next_action.kind, 'write-summary');
    assert.strictEqual(parsed.next_action.summary_path, absPlanningPath(tmpDir, 'onboarding', 'SUMMARY.md'));
  });

  test('fast mode routes incomplete planning to partial-planning before the complete-map gate (regression #1990: fast map gate misroute)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'INTEGRATIONS', 'ARCHITECTURE', 'STRUCTURE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');

    const result = runGsdTools(['init', 'onboard', '--fast', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.map_readiness, 'fast');
    // Incomplete planning must surface before the fast-map complete-map handoff.
    assert.strictEqual(parsed.next_action.kind, 'partial-planning');
    assert.deepStrictEqual(parsed.next_action.missing, ['REQUIREMENTS.md']);
  });

  test('projects the next action for code, docs, greenfield, partial planning, and summary states', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'server.ts'), 'export const server = true;\n');
    let result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output).next_action, {
      kind: 'map-codebase',
      command: '/gsd-map-codebase',
      reason: 'Existing code was detected, but the required .planning/codebase/ map is missing.',
    });

    cleanup(tmpDir);
    // #2376 macOS fix: see beforeEach above.
    tmpDir = fs.realpathSync(createFixture({ planning: false, projectDoc: false }));
    fs.mkdirSync(path.join(tmpDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'adr', '0001-runtime.md'), '# ADR: Runtime\n');
    result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output).next_action, {
      kind: 'ingest-docs',
      command: '/gsd-ingest-docs',
      reason: 'Detected existing ADR/PRD/SPEC/RFC document(s) before project setup.',
    });

    cleanup(tmpDir);
    // #2376 macOS fix: see beforeEach above.
    tmpDir = fs.realpathSync(createFixture({ planning: false, projectDoc: false }));
    result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output).next_action, {
      kind: 'new-project',
      command: '/gsd-new-project',
      reason: 'No existing code or planning docs were detected.',
    });

    cleanup(tmpDir);
    // #2376 macOS fix: see beforeEach above.
    tmpDir = fs.realpathSync(createFixture({ planning: false, projectDoc: false }));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    const partial = JSON.parse(result.output);
    assert.strictEqual(partial.next_action.kind, 'partial-planning');
    assert.deepStrictEqual(partial.next_action.missing, ['REQUIREMENTS.md']);

    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'ARCHITECTURE', 'STRUCTURE', 'CONVENTIONS', 'TESTING', 'INTEGRATIONS', 'CONCERNS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output).next_action, {
      kind: 'write-summary',
      summary_path: absPlanningPath(tmpDir, 'onboarding', 'SUMMARY.md'),
      reason: 'Onboarding summary is missing.',
    });

    fs.mkdirSync(path.join(tmpDir, '.planning', 'onboarding'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'onboarding', 'SUMMARY.md'), '# Onboarding Summary\n');
    result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output).next_action, {
      kind: 'ready',
      reason: 'Onboarding summary already exists.',
    });
  });

  test('reports missing requirements in otherwise existing planning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.project_exists, true);
    assert.strictEqual(parsed.requirements_exists, false);
    assert.strictEqual(parsed.roadmap_exists, true);
    assert.strictEqual(parsed.state_exists, true);
  });

  test('ignores generated and vendor directories when detecting existing code', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'export const ignored = true;\n');
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'console.log("ignored");\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_existing_code, false);
    assert.strictEqual(parsed.has_package_file, false);
    assert.strictEqual(parsed.is_brownfield, false);
    assert.strictEqual(parsed.needs_codebase_map, false);
  });

  test('treats package manifests as brownfield even without source files', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_existing_code, false);
    assert.strictEqual(parsed.has_package_file, true);
    assert.strictEqual(parsed.is_brownfield, true);
    assert.strictEqual(parsed.needs_codebase_map, true);
  });


  test('formats onboard handoff commands for the resolved runtime', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const result = runGsdTools(['init', 'onboard', '--raw'], tmpDir, {
      HOME: tmpDir,
      GSD_RUNTIME: 'codex',
    });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.next_action.kind, 'map-codebase');
    assert.strictEqual(parsed.next_action.command, '$gsd-map-codebase');
    assert.deepStrictEqual(parsed.handoff_commands, {
      map_codebase: '$gsd-map-codebase',
      map_codebase_fast: '$gsd-map-codebase --fast',
      ingest_docs: '$gsd-ingest-docs',
      manager: '$gsd-manager',
      new_project: '$gsd-new-project',
      onboard: '$gsd-onboard',
    });
  });

  test('dotted query init.onboard matches direct init onboard', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const direct = runGsdTools(['init', 'onboard', '--raw'], tmpDir, { HOME: tmpDir });
    const query = runGsdTools(['query', 'init.onboard', '--raw'], tmpDir, { HOME: tmpDir });
    assert.equal(direct.success, true, direct.error || direct.output);
    assert.equal(query.success, true, query.error || query.output);
    assert.deepStrictEqual(JSON.parse(query.output), JSON.parse(direct.output));
  });

});

describe('/gsd:onboard command contract', () => {
  test('command file declares the onboard command and loads its workflow', () => {
    const content = fs.readFileSync(CMD_PATH, 'utf8');
    assert.match(content, /^name:\s*gsd:onboard$/m);
    assert.match(content, /^description:\s*.*(?:existing codebase|brownfield|onboard).*$/mi);
    assert.match(content, /^\s*- AskUserQuestion$/m);
    assert.match(content, /^\s*- Agent$/m);
    assert.ok(content.includes('@~/.claude/gsd-core/workflows/onboard.md'));
    assert.ok(content.includes('@~/.claude/gsd-core/references/ui-brand.md'));
    assert.ok(content.includes('@~/.claude/gsd-core/references/gate-prompts.md'));
  });

  test('workflow renders the init projection without owning the route state machine', () => {
    const content = fs.readFileSync(WF_PATH, 'utf8');

    assert.ok(content.includes('@~/.claude/gsd-core/references/gsd-run-resolver.md'));
    assert.ok(
      !content.includes('_GSD_SHIM_NAME="gsd-tools.cjs"'),
      'workflow must reference the shared resolver instead of inlining it',
    );
    assert.match(content, /init onboard --fast --raw/);
    assert.match(content, /init onboard --raw/);
    assert.match(content, /next_action\.kind/);
    assert.match(content, /map_readiness/);
    assert.match(content, /codebase_map_summary_status/);
    assert.match(content, /ONBOARDING_ROOT=\{git_worktree_root \|\| _GSD_RUNTIME_ROOT\}/);

    for (const action of [
      'map-codebase',
      'ingest-docs',
      'complete-map-before-new-project',
      'new-project',
      'partial-planning',
      'write-summary',
      'ready',
    ]) {
      assert.ok(content.includes(`next_action.kind == "${action}"`), `workflow must render ${action}`);
    }

    assert.ok(content.includes('AskUserQuestion'), 'workflow must still support interactive choices');
    assert.ok(content.includes('--text'), 'workflow must document text-mode fallback');
    assert.ok(
      content.includes('Exit. If the user skips mapping:'),
      'skip mapping must hand off explicitly instead of falling through to summary creation',
    );
    const partialPlanningSkipGuard =
      'If `(project_exists || requirements_exists || roadmap_exists || state_exists) && (!project_exists || !requirements_exists || !roadmap_exists || !state_exists)`, route the skip to the partial planning guard instead:';
    const docsIngestSkipGuard =
      'If `has_docs_candidates && !project_exists`, route the skip to docs ingest instead:';
    assert.ok(
      content.includes(partialPlanningSkipGuard),
      'skip mapping must preserve the partial-planning guard when incomplete planning artifacts are present',
    );
    assert.ok(
      content.includes(docsIngestSkipGuard),
      'skip mapping must preserve the docs-ingest gate when planning docs are present',
    );
    assert.ok(
      content.indexOf(partialPlanningSkipGuard) < content.indexOf(docsIngestSkipGuard),
      'skip mapping must check partial planning before docs ingest',
    );
    assert.ok(
      content.includes('{handoff_commands.ingest_docs}'),
      'skip mapping docs-preserving handoff must use the projected docs ingest command',
    );
    assert.ok(
      content.includes('Skipping codebase mapping may give {handoff_commands.new_project} weaker context.'),
      'skip mapping must warn about weaker context',
    );
    assert.ok(
      content.includes('Exit. If the user skips docs ingest, print:'),
      'skip docs ingest must hand off explicitly instead of falling through to summary creation',
    );
    assert.ok(
      content.includes('Skipping docs ingest may omit existing ADR/PRD/SPEC/RFC context from {handoff_commands.new_project}.'),
      'skip docs ingest must warn about omitted docs context',
    );
    assert.match(content, /do not overwrite/i, 'workflow must protect existing summary/planning');
    assert.match(content, /query commit "docs: create onboarding summary" --files \.planning\/onboarding\/SUMMARY\.md/);
    assert.ok(!content.includes('execute-phase'), 'onboarding must not execute implementation phases');
    assert.ok(!content.includes('gsd:ship'), 'onboarding must not ship work');
    assert.ok(content.includes('Next recommended command: {handoff_commands.manager}'));
    assert.ok(!content.includes('/gsd:ingest-docs'), 'skip handoffs must not hard-code legacy ingest command');
    assert.ok(!content.includes('/gsd:new-project'), 'skip handoffs must not hard-code legacy new-project command');
  });
});
