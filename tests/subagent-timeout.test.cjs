// Migrated (#455): all runGsdTools assertions parse JSON and assert on typed
// fields (parsed.subagent_timeout, parsed.context_window). The workflow/reference
// file checks are source-text-is-the-product (deployed file content is the product).
// allow-test-rule: source-text-is-the-product

/**
 * GSD Tools Tests - subagent timeout configuration
 *
 * Validates that workflow.subagent_timeout is properly registered,
 * loaded from config, and emitted in init context.
 *
 * Closes: #1472
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, readWorkflowCombined } = require('./helpers.cjs');

// ─── config key registration ─────────────────────────────────────────────────

describe('workflow.subagent_timeout config key (#1472)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('subagent_timeout has correct default value (300000ms)', () => {
    // Write a minimal config.json
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ model_profile: 'balanced' }, null, 2));

    // Load config via init and check the value propagates
    // Use config-get to verify the field is recognized
    const result = runGsdTools(['config-set', 'workflow.subagent_timeout', '600000'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.subagent_timeout: ${result.error}`);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.workflow.subagent_timeout, 600000);
  });

  test('config-set rejects invalid config keys but accepts subagent_timeout', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

    // Valid key should succeed
    const valid = runGsdTools(['config-set', 'workflow.subagent_timeout', '900000'], tmpDir);
    assert.ok(valid.success, `workflow.subagent_timeout should be a valid key: ${valid.error}`);

    // Invalid key should fail
    const invalid = runGsdTools(['config-set', 'workflow.nonexistent_key', 'true'], tmpDir);
    assert.ok(!invalid.success, 'nonexistent key should be rejected');
  });

  test('subagent_timeout appears in map-codebase init context', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      workflow: { subagent_timeout: 600000 }
    }, null, 2));

    const result = runGsdTools('init map-codebase', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init map-codebase should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.subagent_timeout, 600000, 'init context should include configured timeout');
  });

  test('subagent_timeout defaults to 300000 when not configured', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

    const result = runGsdTools('init map-codebase', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init map-codebase should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.subagent_timeout, 300000, 'default should be 300000ms (5 minutes)');
  });
});

describe('map-codebase workflow references configurable timeout (#1472)', () => {
  test('workflow file references subagent_timeout from init context', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'map-codebase.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    assert.ok(
      content.includes('subagent_timeout'),
      'map-codebase.md should reference subagent_timeout from init context'
    );
    assert.ok(
      content.includes('workflow.subagent_timeout'),
      'map-codebase.md should document the config key'
    );
  });

  test('workflow file no longer has hardcoded 300000 timeout', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'map-codebase.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    // The timeout line should reference the config variable, not a hardcoded value
    const timeoutLines = content.split(/\r?\n/).filter(l => l.includes('timeout:'));
    for (const line of timeoutLines) {
      assert.ok(
        !line.match(/timeout:\s*300000\s*$/),
        `found hardcoded timeout: "${line.trim()}". Should reference subagent_timeout from init context.`
      );
    }
  });
});

// ─── #1359: background-subagent collection migrated off deprecated TaskOutput ──
// Anthropic deprecated the Claude Code `TaskOutput` tool (prefer `Read` on the
// task's output file) and `TaskOutput(block=true)` has a confirmed main-session
// hang (anthropics/claude-code#20236). The collect steps must spawn with
// `run_in_background=true` then `Read` each agent's `outputFile` (from the
// `async_launched` result). The non-Claude runtime fallbacks must be preserved
// and must not reference TaskOutput either.

describe('#1359: workflows collect background subagents via Read(outputFile), not TaskOutput', () => {
  const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

  function readWorkflow(name) {
    return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
  }

  function stepBlock(content, stepName) {
    const start = content.indexOf(`<step name="${stepName}"`);
    assert.ok(start !== -1, `step "${stepName}" must exist`);
    const end = content.indexOf('</step>', start);
    assert.ok(end !== -1, `step "${stepName}" must be closed`);
    return content.slice(start, end);
  }

  describe('map-codebase.md', () => {
    const content = readWorkflow('map-codebase.md');

    test('contains no deprecated TaskOutput tool references', () => {
      assert.ok(
        !content.includes('TaskOutput'),
        'map-codebase.md must not reference the deprecated TaskOutput tool (claude-code#20236 hang)'
      );
    });

    test('collect_confirmations reads each agent outputFile', () => {
      const block = stepBlock(content, 'collect_confirmations');
      assert.ok(block.includes('outputFile'), 'collect_confirmations must read each agent outputFile');
      assert.ok(/Read tool:/.test(block), 'collect_confirmations must instruct a Read tool call');
      assert.ok(block.includes('async_launched'), 'collect_confirmations must reference the async_launched result');
      assert.ok(!/block:\s*true/.test(block), 'collect_confirmations must not use a blocking collect call');
    });

    test('still spawns mappers with run_in_background=true', () => {
      assert.ok(content.includes('run_in_background=true'), 'background spawn must be preserved');
    });

    test('preserves the non-Agent runtime fallback (sequential_mapping)', () => {
      assert.ok(content.includes('<step name="sequential_mapping"'), 'sequential_mapping fallback must be preserved');
      assert.ok(content.includes('<step name="detect_runtime_capabilities"'), 'runtime capability detection must be preserved');
      assert.ok(!stepBlock(content, 'sequential_mapping').includes('TaskOutput'), 'sequential_mapping fallback must not reference TaskOutput');
    });

    test('keeps the mapper completion marker contract', () => {
      assert.ok(content.includes('## Mapping Complete'), 'mapper completion marker must remain documented');
    });
  });

  describe('docs-update.md', () => {
    // #2994: dispatch_monorepo_packages was extracted to
    // gsd-core/workflows/docs-update/steps/dispatch-monorepo-packages.md behind a
    // <!-- gsd:section --> stub, so the bare host file no longer contains that
    // <step> block. readWorkflowCombined follows the host + its step fragments so
    // the property below still evaluates against the step's real content.
    const content = readWorkflowCombined(path.join(WORKFLOWS_DIR, 'docs-update.md'));

    test('contains no deprecated TaskOutput tool references', () => {
      assert.ok(
        !content.includes('TaskOutput'),
        'docs-update.md must not reference the deprecated TaskOutput tool (claude-code#20236 hang)'
      );
    });

    for (const step of ['collect_wave_1', 'collect_wave_2']) {
      test(`${step} reads each agent outputFile`, () => {
        const block = stepBlock(content, step);
        assert.ok(block.includes('outputFile'), `${step} must read each agent outputFile`);
        assert.ok(block.includes('async_launched'), `${step} must reference the async_launched result`);
        assert.ok(/Read tool:/.test(block), `${step} must instruct a Read tool call`);
        assert.ok(!/block:\s*true/.test(block), `${step} must not use a blocking collect call`);
      });
    }

    test('dispatch_monorepo_packages collects per-package READMEs via outputFile', () => {
      const block = stepBlock(content, 'dispatch_monorepo_packages');
      assert.ok(block.includes('outputFile'), 'per-package collection must read each agent outputFile');
      assert.ok(block.includes('async_launched'), 'per-package collection must reference the async_launched result');
      assert.ok(!/block:\s*true/.test(block), 'per-package collection must not use a blocking collect call');
    });

    test('still spawns doc-writers with run_in_background=true', () => {
      assert.ok(content.includes('run_in_background=true'), 'background spawn must be preserved');
    });

    test('preserves the non-Task runtime fallback (sequential_generation)', () => {
      assert.ok(content.includes('<step name="sequential_generation"'), 'sequential_generation fallback must be preserved');
      assert.ok(!stepBlock(content, 'sequential_generation').includes('TaskOutput'), 'sequential_generation fallback must not reference TaskOutput');
    });

    test('keeps the doc-writer completion marker contract', () => {
      assert.ok(content.includes('## Doc Generation Complete'), 'doc-writer completion marker must remain documented');
    });
  });
});

describe('planning-config.md documents subagent_timeout (#1472)', () => {
  test('reference doc includes subagent_timeout entry', () => {
    const refPath = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');
    const content = fs.readFileSync(refPath, 'utf8');

    assert.ok(
      content.includes('workflow.subagent_timeout'),
      'planning-config.md should document workflow.subagent_timeout'
    );
    assert.ok(
      content.includes('300000'),
      'planning-config.md should document the default value (300000)'
    );
  });
});

// ─── init execute-phase includes context_window ─────────────────────────────

describe('init execute-phase context_window (#1472)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init execute-phase output includes context_window from config', () => {
    // Write config with a custom context_window value (1M for Opus/Sonnet 4.6)
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      context_window: 1000000,
    }, null, 2));

    // Create a phase directory with a plan so init execute-phase succeeds
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init execute-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.context_window, 1000000, 'context_window should reflect configured value');
  });

  test('init execute-phase uses default context_window when not configured', () => {
    // Write minimal config without context_window
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init execute-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.context_window, 200000, 'default context_window should be 200000');
  });
});

// ─── config-get context_window ──────────────────────────────────────────────

describe('config-get context_window (#1472)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-get context_window returns the configured value', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      context_window: 1000000,
    }, null, 2));

    const result = runGsdTools('config-get context_window', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 1000000);
  });

  test('config-get context_window returns schema default (200000) when key is absent', () => {
    // Bug #2943: context_window has a schema-level default of 200000.
    // config-get must return it (exit 0) rather than "Key not found" (exit 1).
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

    const result = runGsdTools('config-get context_window', tmpDir);
    assert.ok(result.success, `Expected success but got: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 200000, 'schema default for context_window should be 200000');
  });
});

// ─── config-set workflow.subagent_timeout numeric coercion ──────────────────

describe('config-set workflow.subagent_timeout numeric values (#1472)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set workflow.subagent_timeout coerces string to number', () => {
    const result = runGsdTools(['config-set', 'workflow.subagent_timeout', '900000'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.key, 'workflow.subagent_timeout');
    assert.strictEqual(output.value, 900000);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.workflow.subagent_timeout, 900000);
    assert.strictEqual(typeof config.workflow.subagent_timeout, 'number');
  });

  test('config-set workflow.subagent_timeout round-trips through config-get', () => {
    runGsdTools(['config-set', 'workflow.subagent_timeout', '1200000'], tmpDir);

    const result = runGsdTools('config-get workflow.subagent_timeout', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 1200000);
  });
});
