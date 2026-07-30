/**
 * GSD Tools Tests - config.cjs
 *
 * CLI integration tests for config-ensure-section, config-set, and config-get
 * commands exercised through gsd-tools.cjs via execSync.
 *
 * Requirements: TEST-13
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, delay } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

async function runConfigEnsureSectionWithRetry(tmpDir, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = runGsdTools('config-ensure-section', tmpDir);
    if (last.success) return last;

    const detail = `${last.error || ''}\n${last.output || ''}`;
    const transient = /(EPERM|EBUSY|EACCES|ENOTEMPTY|resource busy|used by another process|permission denied)/i.test(detail);
    if (!transient || i === attempts - 1) return last;
    await delay(150 * (i + 1));
  }
  return last;
}

/**
 * Seed `.planning/config.json` for a test and guarantee it lands on disk
 * before the test body runs.
 *
 * `config-ensure-section` is invoked through a spawned `gsd-tools.cjs` child.
 * On the scoped CI lane (`--test-concurrency=4`, config.test.cjs scheduled
 * alongside the heavy install/tarball suites) that child can be transiently
 * killed under resource pressure — surfacing as a non-zero exit with empty
 * stderr (an OS-level kill, not a gsd-tools application error; see the
 * `runGsdTools` catch). A bare `runGsdTools('config-ensure-section')` in
 * `beforeEach` swallows that failure, leaving config.json absent so the first
 * subtest's `readConfig()` throws a confusing ENOENT (#770 scoped-lane flake).
 *
 * This retries on ANY failure or missing file (not just the EPERM/EBUSY class
 * `runConfigEnsureSectionWithRetry` covers) and throws a clear diagnostic if it
 * still cannot create the file, so setup is deterministic under load.
 */
async function ensureConfigReady(tmpDir, attempts = 5) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = runGsdTools('config-ensure-section', tmpDir);
    if (last.success && fs.existsSync(configPath)) return last;
    if (i < attempts - 1) await delay(150 * (i + 1));
  }
  throw new Error(
    `config-ensure-section failed to create ${configPath} after ${attempts} attempts: ` +
      `${(last && last.error) || 'unknown error'}`,
  );
}

// ─── config-ensure-section ───────────────────────────────────────────────────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates config.json with expected structure and types', () => {
    const result = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const config = readConfig(tmpDir);
    // Verify structure and types — exact values may vary if ~/.gsd/defaults.json exists
    assert.strictEqual(typeof config.model_profile, 'string');
    assert.strictEqual(typeof config.commit_docs, 'boolean');
    assert.strictEqual(typeof config.parallelization, 'boolean');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string');
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow should be an object');
    assert.strictEqual(typeof config.workflow.research, 'boolean');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean');
    assert.strictEqual(typeof config.workflow.nyquist_validation, 'boolean');
    // These hardcoded defaults are always present (may be overridden by user defaults)
    assert.ok('model_profile' in config, 'model_profile should exist');
    assert.ok('brave_search' in config, 'brave_search should exist');
    assert.ok('search_gitignored' in config, 'search_gitignored should exist');
  });

  test('is idempotent — returns already_exists on second call', async () => {
    const first = await runConfigEnsureSectionWithRetry(tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOutput = JSON.parse(first.output);
    assert.strictEqual(firstOutput.created, true);

    const second = await runConfigEnsureSectionWithRetry(tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOutput = JSON.parse(second.output);
    assert.strictEqual(secondOutput.created, false);
    assert.strictEqual(secondOutput.reason, 'already_exists');
  });

  test('detects Brave Search from file-based key', () => {
    // runGsdTools sandboxes HOME=tmpDir, so brave_api_key is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brave_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.brave_search, true);
  });

  test('detects Tavily Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('tavily_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, false);
  });

  test('detects Tavily Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'tavily_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('detects Ref Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('ref_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, false);
  });

  test('detects Ref Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'ref_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('detects Perplexity from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('perplexity is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, false);
  });

  test('detects Perplexity from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'perplexity_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('detects Jina from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('jina is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, false);
  });

  test('detects Jina from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'jina_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('merges user defaults from defaults.json', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      model_profile: 'quality',
      commit_docs: false,
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality', 'model_profile should be overridden');
    assert.strictEqual(config.commit_docs, false, 'commit_docs should be overridden');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string', 'git.branching_strategy should be a string');
  });

  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      workflow: { research: false },
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false, 'research should be overridden');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean', 'plan_check should be a boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean', 'verifier should be a boolean');
  });
});

// ─── config-set ──────────────────────────────────────────────────────────────

describe('config-set command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create initial config
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a top-level string value', () => {
    const result = runGsdTools('config-set model_profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.key, 'model_profile');
    assert.strictEqual(output.value, 'quality');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('coerces true to boolean', () => {
    const result = runGsdTools('config-set commit_docs true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces false to boolean', () => {
    const result = runGsdTools('config-set commit_docs false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces numeric strings to numbers', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.granularity, 42);
    assert.strictEqual(typeof config.granularity, 'number');
  });

  test('preserves plain strings', () => {
    const result = runGsdTools('config-set model_profile hello', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'hello');
    assert.strictEqual(typeof config.model_profile, 'string');
  });

  test('sets nested values via dot-notation', () => {
    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
  });

  test('auto-creates nested objects for dot-notation', () => {
    // Start with empty config
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(typeof config.workflow, 'object');
  });

  test('rejects unknown config keys', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });

  test('sets workflow.text_mode for remote session support', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.text_mode true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.text_mode, true);
  });

  test('sets workflow.use_worktrees to disable worktree isolation', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.use_worktrees, false);
  });

  test('sets git.base_branch for non-main default branches', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set git.base_branch master', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.base_branch, 'master');
  });

  test('sets intel.enabled to opt into the intel subsystem', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set intel.enabled true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.intel.enabled, true);
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-set', tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejects known invalid nyquist alias keys with a suggestion', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: workflow\.nyquist_validation_enabled/);
    assert.match(result.error, /workflow\.nyquist_validation/);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.nyquist_validation_enabled, undefined);
    assert.strictEqual(config.workflow.nyquist_validation, true);
  });
});

// ─── config-get ──────────────────────────────────────────────────────────────

describe('config-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create config with known values — sandbox HOME to avoid global defaults
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gets a top-level value', () => {
    const result = runGsdTools('config-get model_profile', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'balanced');
  });

  test('gets a nested value via dot-notation', () => {
    const result = runGsdTools('config-get workflow.research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('errors for nonexistent key', () => {
    const result = runGsdTools('config-get nonexistent_key', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors for deeply nested nonexistent key', () => {
    const result = runGsdTools('config-get workflow.nonexistent', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  describe('when config.json does not exist', () => {
    let emptyTmpDir;

    beforeEach(() => {
      emptyTmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyTmpDir);
    });

    test('errors when config.json does not exist', () => {
      const result = runGsdTools('config-get model_profile', emptyTmpDir);
      assert.strictEqual(result.success, false);
      assert.ok(
        result.error.includes('No config.json'),
        `Expected "No config.json" in error: ${result.error}`
      );
    });
  });

  test('gets git.base_branch after it is set', () => {
    runGsdTools('config-set git.base_branch master', tmpDir);
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'master');
  });

  test('errors for git.base_branch when not explicitly set', () => {
    // Default config from config-ensure-section does not include git.base_branch,
    // so config-get should return "Key not found" — this triggers auto-detect
    // fallback in the workflow (origin/HEAD detection).
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-get', tmpDir);
    assert.strictEqual(result.success, false);
  });
});

// ─── config-new-project ───────────────────────────────────────────────────────

describe('config-new-project command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates full config with all expected keys', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'standard',
      parallelization: true,
      commit_docs: true,
      model_profile: 'balanced',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);

    // User choices present
    assert.strictEqual(config.mode, 'interactive');
    assert.strictEqual(config.granularity, 'standard');
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.model_profile, 'balanced');

    // Defaults materialized — these were silently missing before
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
    assert.strictEqual(typeof config.brave_search, 'boolean');

    // git section present with all three keys
    assert.ok(config.git && typeof config.git === 'object', 'git section should exist');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(config.git.phase_branch_template, 'gsd/phase-{phase}-{slug}');
    assert.strictEqual(config.git.milestone_branch_template, 'gsd/{milestone}-{slug}');

    // workflow section present with all keys
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow section should exist');
    assert.strictEqual(config.workflow.research, true);
    assert.strictEqual(config.workflow.plan_check, true);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);

    // hooks section present
    assert.ok(config.hooks && typeof config.hooks === 'object', 'hooks section should exist');
    assert.strictEqual(config.hooks.context_warnings, true);
  });

  test('user choices override defaults', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'coarse',
      parallelization: false,
      commit_docs: false,
      model_profile: 'quality',
      workflow: { research: false, plan_check: false, verifier: true, nyquist_validation: false },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'coarse');
    assert.strictEqual(config.parallelization, false);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(config.workflow.plan_check, false);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, false);
    // Defaults still present for non-chosen keys
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
  });

  test('works with empty choices — all defaults materialized', () => {
    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.search_gitignored, false);
    assert.ok(config.git && typeof config.git === 'object');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.ok(config.workflow && typeof config.workflow === 'object');
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);
    assert.ok(config.hooks && typeof config.hooks === 'object');
    assert.strictEqual(config.hooks.context_warnings, true);
  });

  test('is idempotent — returns already_exists if config exists', () => {
    const choices = JSON.stringify({ mode: 'yolo', granularity: 'fine' });

    const first = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOut = JSON.parse(first.output);
    assert.strictEqual(firstOut.created, true);

    const second = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOut = JSON.parse(second.output);
    assert.strictEqual(secondOut.created, false);
    assert.strictEqual(secondOut.reason, 'already_exists');

    // Config unchanged
    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'fine');
  });

  test('auto_advance in workflow choices is preserved', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'standard',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true, auto_advance: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.auto_advance, true);
  });

  test('rejects invalid JSON choices', () => {
    const result = runGsdTools(['config-new-project', '{not-json}'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Invalid JSON'), `Expected "Invalid JSON" in: ${result.error}`);
  });

  test('output has created:true and path on success', () => {
    const choices = JSON.stringify({ mode: 'interactive', granularity: 'standard' });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.path, '.planning/config.json');
  });
});

// ─── config-set silent coercion (#1581) ──────────────────────────────────────

describe('config-set — no silent coercion (#1581)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('context_window Infinity is rejected (no null-on-disk / output≠disk divergence)', () => {
    const result = runGsdTools('config-set context_window Infinity', tmpDir);
    assert.strictEqual(result.success, false, 'Infinity must be rejected');
    assert.match(result.error, /context_window/i);
    // The old bug number-coerced Infinity, then JSON.stringify rendered it as
    // `null` on disk while the CLI echoed 'Infinity'. The fix rejects before
    // any write, so config.json is left untouched (no null entry written).
    assert.doesNotThrow(() => {
      const configPath = path.join(tmpDir, '.planning', 'config.json');
      if (!fs.existsSync(configPath)) return; // never written — the rejection path
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.ok(cfg.context_window !== null && cfg.context_window !== Infinity,
        'context_window must not be written as null/Infinity');
    });
  });

  test('context_window 0 is rejected (must be a positive integer)', () => {
    const result = runGsdTools('config-set context_window 0', tmpDir);
    assert.strictEqual(result.success, false, '0 must be rejected');
    assert.match(result.error, /positive integer/i);
  });

  test('context_window <positive integer> is accepted and persisted as a finite number', () => {
    const result = runGsdTools('config-set context_window 200000', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.context_window, 200000);
    assert.strictEqual(typeof config.context_window, 'number');
    assert.ok(Number.isFinite(config.context_window), 'must be finite on disk');
  });

  test('project_code 007 persists as the string "007" (leading zero preserved, not coerced to 7)', () => {
    const result = runGsdTools('config-set project_code 007', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.project_code, '007');
    assert.strictEqual(typeof config.project_code, 'string',
      'project_code is an identifier string — must not be number-coerced');
  });

  test('regression guard: numeric coercion still works for numeric keys (granularity 42)', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(readConfig(tmpDir).granularity, 42);
  });
});

// ─── config-set <key> null — unset/clear (#2046) ─────────────────────────────

describe('config-set <key> null — unset/clear (#2046)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('non-secret routing key: config-set <key> null removes the key (not the string "null")', () => {
    const setResult = runGsdTools('config-set review.models.gemini foo', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).review.models.gemini, 'foo');

    const unsetResult = runGsdTools('config-set review.models.gemini null', tmpDir);
    assert.ok(unsetResult.success, `Command failed: ${unsetResult.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.review || !config.review.models || !Object.prototype.hasOwnProperty.call(config.review.models, 'gemini'),
      'review.models.gemini must be absent on disk after unset, not the string "null"'
    );

    // #2797: review.models.<slug> is federated to its lane capability now, and a
    // federated key always resolves to its declared default — so a cleared key
    // reads back as the empty string (rendered `""` by the non-raw formatter)
    // instead of erroring. The property this test actually guards is unchanged
    // and asserted above: the key is REMOVED from disk, never persisted as the
    // literal string "null".
    const getResult = runGsdTools('config-get review.models.gemini', tmpDir);
    const shown = (getResult.output || '').trim();
    assert.ok(
      shown === '' || shown === '""' || shown === 'undefined',
      `config-get should return empty/undefined after unset, got: ${getResult.output}`
    );
    assert.notStrictEqual(shown, 'null');
    assert.notStrictEqual(shown, '"null"');
  });

  test('secret key: config-set brave_search null removes the key (never persists "null")', () => {
    const setResult = runGsdTools('config-set brave_search sk-test-1234', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).brave_search, 'sk-test-1234');

    const unsetResult = runGsdTools('config-set brave_search null', tmpDir);
    assert.ok(unsetResult.success, `Command failed: ${unsetResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const rawText = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawText);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(config, 'brave_search'),
      'brave_search must be absent on disk after unset'
    );
    assert.doesNotMatch(rawText, /"brave_search":\s*"null"/,
      'raw config.json must never contain brave_search mapped to the literal string "null"');
  });

  test('typed-key bypass: config-set context null clears an enum-typed key without validator rejection', () => {
    const setResult = runGsdTools('config-set context dev', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).context, 'dev');

    const unsetResult = runGsdTools('config-set context null', tmpDir);
    assert.ok(unsetResult.success, `config-set context null must succeed (bypass enum validator), got error: ${unsetResult.error}`);

    const config = readConfig(tmpDir);
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'context'),
      'context key must be removed after unset');
  });

  test('idempotent: config-set <never-set key> null succeeds with no crash and no key written', () => {
    const result = runGsdTools('config-set git.base_branch null', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.git || !Object.prototype.hasOwnProperty.call(config.git, 'base_branch'),
      'git.base_branch must not be present after unsetting a key that was never set'
    );
  });

  test('literal-"null" guard: no config-set <key> null ever persists the literal string "null" on disk', () => {
    runGsdTools('config-set review.models.gemini foo', tmpDir);
    runGsdTools('config-set review.models.gemini null', tmpDir);
    runGsdTools('config-set brave_search sk-test-1234', tmpDir);
    runGsdTools('config-set brave_search null', tmpDir);
    runGsdTools('config-set context dev', tmpDir);
    runGsdTools('config-set context null', tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const rawText = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotMatch(rawText, /:\s*"null"/,
      `config.json must never contain a key mapped to the literal string "null": ${rawText}`);
  });

  test('prototype-pollution guard: unsetting a __proto__ leaf is rejected, no pollution (alert #26 parity)', () => {
    // Create the intermediate so the unset walk reaches the leaf guard (a bare
    // dynamic-prefix key passes the schema gate, so this exercises the
    // _unsetNestedValue guard, not the schema gate — mirrors the set-path test).
    const seed = runGsdTools('config-set agent_skills.sonnet-coder true', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const result = runGsdTools('config-set agent_skills.__proto__ null', tmpDir);
    assert.strictEqual(result.success, false, `Expected rejection, got: ${result.output}`);
    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected pollution-guard error, got: ${result.error}`,
    );
    // No prototype pollution occurred via the unset path.
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  test('deep (4-segment) nested key: config-set <deep> null removes only the leaf', () => {
    const set = runGsdTools('config-set review.reviewer_instances.myinst.model some-model', tmpDir);
    assert.ok(set.success, `deep set failed: ${set.error}`);
    assert.strictEqual(readConfig(tmpDir).review.reviewer_instances.myinst.model, 'some-model');

    const unset = runGsdTools('config-set review.reviewer_instances.myinst.model null', tmpDir);
    assert.ok(unset.success, `deep unset failed: ${unset.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.review.reviewer_instances.myinst ||
        !Object.prototype.hasOwnProperty.call(config.review.reviewer_instances.myinst, 'model'),
      'the leaf model key must be removed',
    );
    // Parent objects along the path are preserved (unset removes only the leaf).
    assert.ok(config.review && config.review.reviewer_instances,
      'parent objects on the path must remain after leaf unset');
  });
});

// ─── config-set (research_before_questions and discuss_mode) ──────────────────

describe('config-set research_before_questions and discuss_mode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.research_before_questions is a valid config key', () => {
    const result = runGsdTools('config-set workflow.research_before_questions true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, true);
  });

  test('workflow.discuss_mode is a valid config key', () => {
    const result = runGsdTools('config-set workflow.discuss_mode assumptions', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'assumptions');
  });

  test('research_before_questions defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, false);
  });

  test('discuss_mode defaults to discuss in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'discuss');
  });

  test('hooks.research_questions is rejected with suggestion', () => {
    const result = runGsdTools('config-set hooks.research_questions true', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
    assert.ok(
      result.error.includes('workflow.research_before_questions'),
      `Expected suggestion for workflow.research_before_questions in error: ${result.error}`
    );
  });
});

// ─── config-set (additional coverage) ────────────────────────────────────────

describe('config-set unknown key (no suggestion)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a key that has no suggestion', () => {
    const result = runGsdTools('config-set totally.unknown.key value', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });
});

// ─── config-get (additional coverage) ────────────────────────────────────────

describe('config-get edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when traversing a dot-path through a non-object value', () => {
    // model_profile is a string — requesting model_profile.something traverses into a non-object
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const result = runGsdTools('config-get model_profile.something', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when config.json contains malformed JSON', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(configPath, '{not valid json', 'utf-8');
    const result = runGsdTools('config-get model_profile', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Failed to read config.json'),
      `Expected "Failed to read config.json" in error: ${result.error}`
    );
  });
});

// ─── config-set-model-profile ─────────────────────────────────────────────────

describe('config-set-model-profile command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a valid profile and updates config', () => {
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.profile, 'quality');
    assert.ok(out.agentToModelMap && typeof out.agentToModelMap === 'object');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('reports previous profile in output', () => {
    const result = runGsdTools('config-set-model-profile budget', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.previousProfile, 'balanced'); // default was balanced
    assert.strictEqual(out.profile, 'budget');
  });

  test('setting the same profile is a no-op on config but still succeeds', () => {
    // Set to quality first, then set to quality again
    runGsdTools('config-set-model-profile quality', tmpDir);
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.profile, 'quality');
    assert.strictEqual(out.previousProfile, 'quality');
  });

  test('is case-insensitive', () => {
    const result = runGsdTools('config-set-model-profile BALANCED', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
  });

  test('rejects invalid profile', () => {
    const result = runGsdTools('config-set-model-profile turbo', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid profile'),
      `Expected "Invalid profile" in error: ${result.error}`
    );
  });

  test('errors when no profile provided', () => {
    const result = runGsdTools('config-set-model-profile', tmpDir);
    assert.strictEqual(result.success, false);
  });

  describe('when config is missing', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('creates config if missing before setting profile', () => {
      const result = runGsdTools('config-set-model-profile budget', emptyDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.model_profile, 'budget');
    });
  });
});

// ─── config-set (workflow.skip_discuss) ───────────────────────────────────────

describe('config-set workflow.skip_discuss', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.skip_discuss is a valid config key', () => {
    const result = runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, true);
  });

  test('skip_discuss defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  test('skip_discuss can be toggled back to false', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-set workflow.skip_discuss false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  describe('skip_discuss in config-new-project', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('skip_discuss is present in config-new-project output', () => {
      const result = runGsdTools(['config-new-project', '{}'], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, false, 'skip_discuss should default to false');
    });

    test('skip_discuss can be set via config-new-project choices', () => {
      const choices = JSON.stringify({
        workflow: { skip_discuss: true },
      });
      const result = runGsdTools(['config-new-project', choices], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, true);
    });
  });

  test('config-get workflow.skip_discuss returns the set value', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-get workflow.skip_discuss', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get workflow.use_worktrees ────────────────────────────

describe('config-set/config-get workflow.use_worktrees', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-get workflow.use_worktrees returns false after setting to false', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, false);
  });

  test('config-get workflow.use_worktrees errors when not set (default config)', () => {
    // config-ensure-section does NOT include use_worktrees in hardcoded defaults,
    // so config-get should error with "Key not found". This is the expected behavior
    // that workflows rely on: the shell fallback `|| echo "true"` provides the default.
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('config-get workflow.use_worktrees returns true after setting to true', () => {
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('use_worktrees can be toggled back and forth', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get context ─────────────────────────────────────────

describe('config-set/config-get context', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config set context dev succeeds', () => {
    const result = runGsdTools('config-set context dev', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'dev');
  });

  test('config set context research succeeds', () => {
    const result = runGsdTools('config-set context research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'research');
  });

  test('config set context review succeeds', () => {
    const result = runGsdTools('config-set context review', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'review');
  });

  test('config get context returns the set value', () => {
    runGsdTools('config-set context dev', tmpDir);
    const result = runGsdTools('config-get context', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'dev');
  });

  test('config set context rejects invalid values', () => {
    const result = runGsdTools('config-set context foobar', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid context value'),
      `Expected "Invalid context value" in error: ${result.error}`
    );
  });

  test('all three context profile files exist', () => {
    const contextsDir = path.join(__dirname, '..', 'gsd-core', 'contexts');
    assert.ok(fs.existsSync(path.join(contextsDir, 'dev.md')), 'dev.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'research.md')), 'research.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'review.md')), 'review.md should exist');
  });
});

// ─── config-path (#2282) ────────────────────────────────────────────────────

describe('config-path command (#2282)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns root config path when no workstream is active', () => {
    const result = runGsdTools('config-path', tmpDir);
    assert.ok(result.success, `config-path failed: ${result.error}`);
    // Normalize separators: Windows emits backslashes in the resolved path.
    assert.ok(result.output.trim().replace(/\\/g, '/').endsWith('.planning/config.json'), `expected root config path, got: ${result.output}`);
    assert.ok(!result.output.includes('workstreams'), 'should not include workstreams in path');
  });

  test('returns workstream config path when GSD_WORKSTREAM is set', () => {
    const result = runGsdTools('config-path', tmpDir, { GSD_WORKSTREAM: 'my-stream' });
    assert.ok(result.success, `config-path failed: ${result.error}`);
    assert.ok(result.output.trim().replace(/\\/g, '/').includes('workstreams/my-stream/config.json'), `expected workstream config path, got: ${result.output}`);
  });

  test('config-path and config-get agree on the active path', () => {
    // Write a value via config-set (uses planningDir internally)
    runGsdTools('config-set model_profile quality', tmpDir);
    // config-path should point to a file containing that value
    const pathResult = runGsdTools('config-path', tmpDir);
    const configPath = pathResult.output.trim();
    const configContent = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    assert.strictEqual(configContent.model_profile, 'quality', 'config-path should point to the file config-set wrote');
  });
});

// ─── config-set prototype-pollution guard (#663) ─────────────────────────────

describe('config-set prototype-pollution guard (#663)', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = createTempProject();
    // Initialise config so there is a config.json to write to. Retry + assert
    // so a transient config-ensure-section child failure under scoped-lane load
    // cannot leave config.json absent (#770).
    await ensureConfigReady(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects __proto__ key segment and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set __proto__.polluted true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    // No prototype pollution.
    assert.strictEqual(({}).polluted, undefined, '__proto__ pollution: {}.polluted should be undefined');
    assert.strictEqual(Object.prototype.polluted, undefined, '__proto__ pollution: Object.prototype.polluted should be undefined');

    // Confirm .planning/config.json does not have a 'polluted' property at any level.
    const config = readConfig(tmpDir);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'polluted'), false,
      'config.json root must not gain a "polluted" key');
  });

  test('rejects constructor.prototype key and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set constructor.prototype.polluted2 true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.strictEqual(({}).polluted2, undefined, 'constructor chain pollution: {}.polluted2 should be undefined');
    assert.strictEqual(Object.prototype.polluted2, undefined,
      'constructor chain pollution: Object.prototype.polluted2 should be undefined');
  });

  test('rejects bare prototype key segment', () => {
    const result = runGsdTools('config-set prototype.x true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);
    assert.strictEqual(Object.prototype.x, undefined, 'prototype.x should not leak onto Object.prototype');
  });

  test('positive control: legitimate nested key workflow.research succeeds', () => {
    const result = runGsdTools('config-set workflow.research true', tmpDir);

    assert.ok(result.success, `Legitimate key rejected unexpectedly: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, true, 'workflow.research should be written to config.json');
  });
});

// ─── config-set prototype-pollution guard via dynamic-key prefixes (alert #26) ─

describe('config-set prototype-pollution guard via dynamic-key prefixes (alert #26)', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = createTempProject();
    // Initialise config so there is a config.json to write to. Retry + assert
    // so a transient config-ensure-section child failure under scoped-lane load
    // cannot leave config.json absent (#770).
    await ensureConfigReady(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('agent_skills.__proto__ is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.__proto__ somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    // Must be the pollution guard, not the schema gate.
    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    // No schema-gate message.
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    // No prototype pollution occurred.
    assert.strictEqual(({}).somevalue, undefined, 'agent_skills.__proto__: {}.somevalue should be undefined');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.__proto__: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.constructor is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.constructor: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.prototype is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.prototype somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.prototype: Object.prototype should not gain "somevalue"');
  });

  test('features.__proto__ is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set features.__proto__ somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(({}).somevalue, undefined, 'features.__proto__: {}.somevalue should be undefined');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'features.__proto__: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.constructor is blocked by setConfigValue guard (not schema gate)', () => {
    // #2797: this case used `review.models.constructor`, which reached the
    // setConfigValue guard only because the central pattern
    // ^review\.models\.[a-zA-Z0-9_-]+$ accepted it first. That pattern is now
    // federated to the lane capabilities and gone from the central schema, so
    // the key is rejected at the schema gate instead (asserted separately below).
    //
    // The GUARD still needs coverage, so this exercises it through a surviving
    // dynamic prefix. Losing this assertion would have quietly deleted the
    // regression test for alert #26 rather than relocating it.
    const result = runGsdTools('config-set agent_skills.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.constructor: Object.prototype should not gain "somevalue"');
  });

  test('review.models.constructor is now rejected at the schema gate (#2797)', () => {
    // Defence in depth: after federation the key never reaches setConfigValue at
    // all, because no lane declares `review.models.constructor`. Rejecting
    // earlier is strictly safer than rejecting later — this locks that it is
    // still rejected, by whichever gate gets there first.
    const result = runGsdTools('config-set review.models.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'Object.prototype must not gain "somevalue"');
  });

  test('positive control: agent_skills.sonnet-coder with valid value succeeds', () => {
    const result = runGsdTools('config-set agent_skills.sonnet-coder true', tmpDir);

    assert.ok(result.success, `Legitimate agent_skills key rejected unexpectedly: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.agent_skills['sonnet-coder'], true,
      'agent_skills.sonnet-coder should be written to config.json');
  });
});

// ─── plan_review.source_grounding + _authority (#22) ─────────────────────────

describe('plan_review.source_grounding and plan_review.source_grounding_authority (#22)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) Default of plan_review.source_grounding is true
  test('plan_review.source_grounding defaults to true when not set in config.json', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.plan_review?.source_grounding,
      true,
      'plan_review.source_grounding must default to true'
    );
  });

  // (b) Default of plan_review.source_grounding_authority is "grep"
  test('plan_review.source_grounding_authority defaults to "grep" when not set in config.json', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.plan_review?.source_grounding_authority,
      'grep',
      'plan_review.source_grounding_authority must default to "grep"'
    );
  });

  // (c) Both keys are recognized as valid config keys
  test('plan_review.source_grounding is a valid config key accepted by config-set', () => {
    const result = runGsdTools('config-set plan_review.source_grounding false', tmpDir);
    assert.ok(result.success, `config-set plan_review.source_grounding failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.plan_review.source_grounding, false);
  });

  test('plan_review.source_grounding_authority is a valid config key accepted by config-set', () => {
    const result = runGsdTools('config-set plan_review.source_grounding_authority intel', tmpDir);
    assert.ok(result.success, `config-set plan_review.source_grounding_authority failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.plan_review.source_grounding_authority, 'intel');
  });

  // Enum positive: all valid authority values
  test('plan_review.source_grounding_authority accepts all valid enum values', () => {
    const validValues = ['grep', 'intel', 'treesitter', 'lsp', 'scip'];
    for (const v of validValues) {
      const result = runGsdTools(`config-set plan_review.source_grounding_authority ${v}`, tmpDir);
      assert.ok(result.success, `config-set plan_review.source_grounding_authority ${v} failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(config.plan_review.source_grounding_authority, v);
    }
  });

  // (d) NEGATIVE MATRIX — invalid enum values are rejected
  test('plan_review.source_grounding_authority rejects invalid value "bogus"', () => {
    const result = runGsdTools('config-set plan_review.source_grounding_authority bogus', tmpDir);
    assert.strictEqual(result.success, false, 'bogus should be rejected');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding_authority'),
      `Expected "Invalid plan_review.source_grounding_authority" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding_authority rejects flag-looking value "--grep"', () => {
    const result = runGsdTools(['config-set', 'plan_review.source_grounding_authority', '--grep'], tmpDir);
    assert.strictEqual(result.success, false, '--grep should be rejected');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding_authority'),
      `Expected "Invalid plan_review.source_grounding_authority" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding_authority rejects empty string', () => {
    const result = runGsdTools(['config-set', 'plan_review.source_grounding_authority', ''], tmpDir);
    assert.strictEqual(result.success, false, 'empty string should be rejected');
  });

  test('plan_review.source_grounding rejects non-boolean value "yes"', () => {
    const result = runGsdTools('config-set plan_review.source_grounding yes', tmpDir);
    assert.strictEqual(result.success, false, '"yes" should be rejected as non-boolean');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding'),
      `Expected "Invalid plan_review.source_grounding" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding rejects numeric value 1', () => {
    const result = runGsdTools('config-set plan_review.source_grounding 1', tmpDir);
    assert.strictEqual(result.success, false, 'numeric 1 should be rejected as non-boolean');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding'),
      `Expected "Invalid plan_review.source_grounding" in error: ${result.error}`
    );
  });
});

// ─── config-set workflow.test_command (#1216) ────────────────────────────────

describe('config-set workflow.test_command (#1216)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set accepts workflow.test_command', () => {
    const result = runGsdTools(['config-set', 'workflow.test_command', 'npm test'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.test_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.test_command, 'npm test', 'value must be persisted');
  });

  test('config-set workflow.test_command persists a custom make command', () => {
    const result = runGsdTools(['config-set', 'workflow.test_command', 'make test'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.test_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.test_command, 'make test', 'make test must be persisted');
  });

  test('config-get workflow.test_command returns the set value', () => {
    runGsdTools(['config-set', 'workflow.test_command', 'cargo test'], tmpDir);
    const result = runGsdTools('config-get workflow.test_command', tmpDir);
    assert.ok(result.success, `config-get should return workflow.test_command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'cargo test', 'config-get must return the persisted value');
  });

  test('config-set accepts workflow.build_command', () => {
    const result = runGsdTools(['config-set', 'workflow.build_command', 'npm run build'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.build_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.build_command, 'npm run build', 'value must be persisted');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2601-inherit-model-profile.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2601-inherit-model-profile (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for bug #2601
 *
 * `config-set-model-profile inherit` (and `config-set model_profile inherit`)
 * was rejected by the validator even though the runtime accepts 'inherit' as a
 * valid model_profile value meaning "inherit from parent configuration".
 *
 * Root cause: VALID_PROFILES in model-profiles.cjs is derived from
 * Object.keys(MODEL_PROFILES['gsd-planner']), which does not include 'inherit'.
 * cmdConfigSetModelProfile() rejects any value not in VALID_PROFILES.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #2601: config-set-model-profile accepts inherit', () => {
  test('config-set-model-profile inherit succeeds', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set-model-profile', 'inherit'], tmpDir);
    assert.ok(result.success, `should accept inherit: ${result.error}`);
  });

  test('config-set model_profile inherit succeeds', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'model_profile', 'inherit'], tmpDir);
    assert.ok(result.success, `config-set model_profile inherit should succeed: ${result.error}`);
  });

  test('config-set-model-profile inherit writes inherit to config', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    runGsdTools(['config-set-model-profile', 'inherit'], tmpDir);
    const getResult = runGsdTools(['config-get', 'model_profile'], tmpDir);
    assert.ok(getResult.success, `config-get should succeed: ${getResult.error}`);
    assert.strictEqual(JSON.parse(getResult.output), 'inherit');
  });

  test('config-set-model-profile still rejects truly invalid profiles', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set-model-profile', 'not-a-real-profile'], tmpDir);
    assert.ok(!result.success, 'should reject invalid profiles');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3197-gsd-tools-config-whitelist.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3197-gsd-tools-config-whitelist (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for #3197 — gsd-tools config-set rejects workflow._auto_chain_active.
 *
 * Root cause: RUNTIME_STATE_KEYS was added to sdk/src/query/config-schema.ts in #3162
 * but not to gsd-core/bin/lib/config-schema.cjs, so gsd-tools.cjs users still hit
 * "Unknown config key" when setting workflow._auto_chain_active.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('#3197 — gsd-tools.cjs config-set workflow._auto_chain_active', () => {
  test('config-set workflow._auto_chain_active true succeeds via gsd-tools.cjs (CJS path)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'workflow._auto_chain_active', 'true'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow._auto_chain_active true should succeed, got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
  });

  test('config-set workflow._auto_chain_active true writes value to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'workflow._auto_chain_active', 'true'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.workflow !== undefined && config.workflow._auto_chain_active === true,
      `Expected workflow._auto_chain_active: true in config.json, got: ${JSON.stringify(config)}`
    );
  });

  test('config-set workflow._auto_chain_active false writes false to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'workflow._auto_chain_active', 'false'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.workflow !== undefined && config.workflow._auto_chain_active === false,
      `Expected workflow._auto_chain_active: false in config.json, got: ${JSON.stringify(config)}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3086-git-create-tag-config-gate.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3086-git-create-tag-config-gate (consolidation epic #1969 B2 #1971)", () => {
// allow-test-rule: workflow-markdown-is-the-runtime-contract (see #3086)
// Justification: complete-milestone.md IS the runtime — the agent reads and
// follows it directly. Asserting the <config-check> block is present in the
// markdown is the only way to verify the gate is wired. Per CONTEXT.md L611.
'use strict';

/**
 * #3086 — git.create_tag config gate for milestone tagging.
 *
 * Tests:
 *   A. Default value: fresh project returns `true` for git.create_tag
 *   B. config-set false → config-get returns false
 *   C. Invalid value (e.g. "maybe") is rejected by schema validator
 *   D. complete-milestone.md workflow contains the <config-check> gate for git.create_tag
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'complete-milestone.md',
);

describe('#3086: git.create_tag config key', () => {
  test('A. fresh project: config-get git.create_tag returns true (default)', (t) => {
    const tmpDir = createTempProject('gsd-3086-default-');
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-get', 'git.create_tag'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `config-get git.create_tag failed:\n${result.error}`);
    assert.strictEqual(
      result.output.trim(),
      'true',
      `Expected default value 'true', got: '${result.output.trim()}'`,
    );
  });

  test('B. config-set git.create_tag false → config-get returns false', (t) => {
    const tmpDir = createTempProject('gsd-3086-set-false-');
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools(['config-set', 'git.create_tag', 'false'], tmpDir, {
      HOME: tmpDir,
    });
    assert.ok(setResult.success, `config-set git.create_tag false failed:\n${setResult.error}`);

    const getResult = runGsdTools(['config-get', 'git.create_tag'], tmpDir, { HOME: tmpDir });
    assert.ok(getResult.success, `config-get after set failed:\n${getResult.error}`);
    assert.strictEqual(
      getResult.output.trim(),
      'false',
      `Expected 'false' after set, got: '${getResult.output.trim()}'`,
    );
  });

  test('C. config-set git.create_tag with invalid value "maybe" is rejected', (t) => {
    const tmpDir = createTempProject('gsd-3086-invalid-');
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'git.create_tag', 'maybe'], tmpDir, {
      HOME: tmpDir,
    });
    assert.ok(
      !result.success,
      `Expected config-set to fail for invalid value "maybe", but it succeeded`,
    );
  });

  test('D. complete-milestone.md contains <config-check> gate for git.create_tag', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      content.includes('git.create_tag'),
      'complete-milestone.md must reference git.create_tag in a <config-check> block',
    );
    assert.ok(
      content.includes('<config-check>'),
      'complete-milestone.md must have a <config-check> block in the git_tag step',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3167-ship-pr-body-sections.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3167-ship-pr-body-sections (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for issue #3167: configurable /gsd-ship PR body sections.
 */

// allow-test-rule: source-text-is-the-product (see #3167)
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test, afterEach } = require('node:test');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const repoRoot = path.resolve(__dirname, '..');
const tmpDirs = [];

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function makeProject() {
  const tmpDir = createTempProject('gsd-3167-');
  tmpDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  while (tmpDirs.length) {
    cleanup(tmpDirs.pop());
  }
});

describe('ship.pr_body_sections config (#3167)', () => {
  test('CLI config-set accepts additional PR body section arrays', () => {
    const cwd = makeProject();
    const value = JSON.stringify([
      {
        heading: 'Risks & Rollback',
        enabled: true,
        source: 'PLAN.md ## Risks || PLAN.md ## Rollback',
        fallback: '- Rollback: revert this PR.',
      },
      {
        heading: 'Stakeholder Sign-off',
        enabled: false,
        template: '- Product owner: pending',
      },
    ]);

    const result = runGsdTools(['config-set', 'ship.pr_body_sections', value, '--raw'], cwd, { HOME: cwd });

    assert.equal(result.success, true, result.error);
    const config = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    assert.deepEqual(config.ship.pr_body_sections, [
      {
        heading: 'Risks & Rollback',
        enabled: true,
        source: 'PLAN.md ## Risks || PLAN.md ## Rollback',
        fallback: '- Rollback: revert this PR.',
      },
      {
        heading: 'Stakeholder Sign-off',
        enabled: false,
        template: '- Product owner: pending',
      },
    ]);
  });

  test('CLI config-set rejects malformed PR body section values before writing config', () => {
    const cwd = makeProject();

    const notArray = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify({ heading: 'Not an array' }), '--raw'],
      cwd,
      { HOME: cwd }
    );
    assert.equal(notArray.success, false);
    assert.match(notArray.error, /ship\.pr_body_sections.*JSON array/);

    const missingHeading = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify([{ fallback: '- Missing heading' }]), '--raw'],
      cwd,
      { HOME: cwd }
    );
    assert.equal(missingHeading.success, false);
    assert.match(missingHeading.error, /heading/);

    const invalidEnabled = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify([{ heading: 'Toggle', enabled: 'yes', fallback: '- item' }]), '--raw'],
      cwd,
      { HOME: cwd }
    );
    assert.equal(invalidEnabled.success, false);
    assert.match(invalidEnabled.error, /enabled/);

    assert.equal(fs.existsSync(path.join(cwd, '.planning', 'config.json')), false);
  });

  test('CLI config-new-project validates onboarded PR body sections before writing config', () => {
    const cwd = makeProject();
    const choices = JSON.stringify({
      ship: {
        pr_body_sections: [
          {
            heading: 'Invalid source',
            source: 'package.json ## Scripts',
          },
        ],
      },
    });

    const result = runGsdTools(['config-new-project', choices], cwd, { HOME: cwd });

    assert.equal(result.success, false);
    assert.match(result.error, /source must use selectors/);
    assert.equal(fs.existsSync(path.join(cwd, '.planning', 'config.json')), false);
  });

  test('ship workflow composes configured sections as append-only extensions', () => {
    const workflow = readRepoFile('gsd-core/workflows/ship.md');

    assert.match(workflow, /config-get ship\.pr_body_sections --default '\[\]'/);
    assert.match(workflow, /append-only/i);
    assert.match(workflow, /enabled.*false/i);
    assert.match(workflow, /cannot replace/i);
    assert.match(workflow, /Summary[\s\S]*Changes[\s\S]*Requirements Addressed[\s\S]*Verification[\s\S]*Key Decisions/);
    assert.match(workflow, /\{phase_number\}[\s\S]*\{phase_name\}[\s\S]*\{phase_dir\}[\s\S]*\{base_branch\}[\s\S]*\{padded_phase\}/);
    assert.match(workflow, /User Stories & Acceptance Criteria/);
    assert.match(workflow, /Definition of Done/);
    assert.match(workflow, /--body-file/);
    assert.match(workflow, /trap 'rm -f "\$\{PR_BODY_FILE:-\}"' EXIT/);
  });

  test('default config and documentation describe ship.pr_body_sections', () => {
    const template = JSON.parse(readRepoFile('gsd-core/templates/config.json'));
    assert.deepEqual(template.ship.pr_body_sections, []);

    const docs = readRepoFile('docs/CONFIGURATION.md');
    assert.match(docs, /`ship\.pr_body_sections`/);
    assert.match(docs, /additional PR body sections/i);
    assert.match(docs, /append-only/i);
    assert.match(docs, /lean\/agile PRD/i);
    assert.match(docs, /Definition of Done/);

    const planningConfig = readRepoFile('gsd-core/references/planning-config.md');
    assert.match(planningConfig, /ship\.pr_body_sections/);
  });

  test('new-project onboarding can seed enabled or disabled PR body sections', () => {
    const workflow = readRepoFile('gsd-core/workflows/new-project.md');

    assert.match(workflow, /ship\.pr_body_sections/);
    assert.match(workflow, /enabled.*true/);
    assert.match(workflow, /enabled.*false/);
    assert.match(workflow, /User Stories & Acceptance Criteria/);
    assert.match(workflow, /Risks & Dependencies/);
    assert.match(workflow, /Success Metrics & Release Criteria/);
    assert.match(workflow, /Stakeholder Review & Approval/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3210-fallow-schema-enum.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3210-fallow-schema-enum (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Enum validation for code_quality.fallow.scope and code_quality.fallow.profile.
 *
 * Fixes H5 from #3424 review: config-set silently accepted invalid enum values
 * (e.g. scope=fullrepo) and fell through to default behavior. This test asserts
 * that invalid values are rejected with a helpful error, and valid values pass.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('feat-3210 / H5: enum validation for code_quality.fallow.scope and .profile', () => {
  // --- code_quality.fallow.scope ---

  test('config-set code_quality.fallow.scope=fullrepo is REJECTED with helpful error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'fullrepo'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.scope=fullrepo must fail, but it succeeded'
    );
    const combined = (result.output || '') + (result.error || '');
    assert.ok(
      combined.includes('phase') && combined.includes('repo'),
      `Error message must mention valid values "phase" and "repo", got: ${combined}`
    );
  });

  test('config-set code_quality.fallow.scope=phase is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'phase'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.scope=phase must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.scope=repo is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'repo'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.scope=repo must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.scope=PHASE (wrong case) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'PHASE'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.scope=PHASE must fail (values are case-sensitive)'
    );
  });

  // --- code_quality.fallow.profile ---

  test('config-set code_quality.fallow.profile=aggressive is REJECTED with helpful error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'aggressive'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.profile=aggressive must fail, but it succeeded'
    );
    const combined = (result.output || '') + (result.error || '');
    assert.ok(
      combined.includes('minimal') && combined.includes('standard') && combined.includes('strict'),
      `Error message must mention valid values "minimal", "standard", "strict", got: ${combined}`
    );
  });

  test('config-set code_quality.fallow.profile=minimal is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'minimal'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=minimal must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=standard is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'standard'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=standard must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=strict is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'strict'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=strict must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=unknown is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'unknown'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.profile=unknown must fail'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3212-execute-phase-stall-safe-resume.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3212-execute-phase-stall-safe-resume (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-product [#3212]
// The bug is in workflow/config contracts consumed by agents at runtime.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function runGsd(args, cwd) {
  return spawnSync(process.execPath, [path.join(ROOT, 'gsd-core/bin/gsd-tools.cjs'), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('bug #3212 execute-phase stall detection and safe resume', () => {
  test('config schemas register executor stall detector keys', () => {
    // After Cycle 5 (#3536), both CJS and SDK source from the manifest.
    // Use the CJS runtime Set for CJS; use the manifest directly for SDK-side
    // verification (since config-schema.ts no longer has inline literals).
    const { VALID_CONFIG_KEYS: cjsKeys } = require('../gsd-core/bin/lib/config-schema.cjs');
    const manifest = JSON.parse(read('gsd-core/bin/shared/config-schema.manifest.json'));
    const manifestKeys = new Set(manifest.validKeys);

    for (const key of ['executor.stall_detect_interval_minutes', 'executor.stall_threshold_minutes']) {
      assert.ok(cjsKeys.has(key), `CJS VALID_CONFIG_KEYS must include ${key}`);
      assert.ok(manifestKeys.has(key), `Manifest validKeys must include ${key} (SDK sources from manifest)`);
    }
  });

  test('configuration docs describe stall detector defaults', () => {
    const docs = read('docs/CONFIGURATION.md');

    assert.match(docs, /`executor\.stall_detect_interval_minutes`\s*\|\s*number\s*\|\s*`5`/);
    assert.match(docs, /`executor\.stall_threshold_minutes`\s*\|\s*number\s*\|\s*`10`/);
  });

  test('config-get returns schema defaults for executor stall detector keys', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3212-'));
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'));
    fs.writeFileSync(path.join(tmp, '.planning/config.json'), '{}\n');

    const interval = runGsd(['config-get', 'executor.stall_detect_interval_minutes', '--raw'], tmp);
    const threshold = runGsd(['config-get', 'executor.stall_threshold_minutes', '--raw'], tmp);

    assert.equal(interval.status, 0, interval.stderr);
    assert.equal(interval.stdout.trim(), '5');
    assert.equal(threshold.status, 0, threshold.stderr);
    assert.equal(threshold.stdout.trim(), '10');
  });

  test('execute-phase verifies partial-plan drift before dispatch', () => {
    const workflow = read('gsd-core/workflows/execute-phase.md');

    assert.match(workflow, /<step name="safe_resume_gate"/, 'execute-phase must define a safe_resume_gate step');
    assert.match(workflow, /git log --oneline --grep="\$\{CURRENT_PLAN_ID\}"/, 'safe resume gate must check commits for the current plan id');
    assert.match(workflow, /SUMMARY.md is missing/, 'safe resume gate must detect production commits with missing SUMMARY.md');
    assert.match(workflow, /close out manually/, 'safe resume gate must offer manual close-out recovery');
    assert.match(workflow, /re-execute from scratch/, 'safe resume gate must offer re-execute recovery');
    assert.match(workflow, /mark-and-skip/, 'safe resume gate must offer mark-and-skip recovery');
  });

  test('execute-phase has configurable executor stall surveillance after dispatch', () => {
    const workflow = read('gsd-core/workflows/execute-phase.md');

    assert.match(workflow, /EXECUTOR_STALL_INTERVAL_MINUTES=.*executor\.stall_detect_interval_minutes/);
    assert.match(workflow, /EXECUTOR_STALL_THRESHOLD_MINUTES=.*executor\.stall_threshold_minutes/);
    assert.match(workflow, /DISPATCH_TS=/, 'execute-phase must record dispatch timestamp');
    assert.match(workflow, /EXPECTED_BRANCH=/, 'execute-phase must record expected branch');
    assert.match(workflow, /git log "\$\{EXPECTED_BRANCH\}" --since="\$\{DISPATCH_TS\}"/, 'stall check must inspect branch commits since dispatch');
    assert.match(workflow, /continue waiting/, 'stall warning must offer continue waiting');
    assert.match(workflow, /kill and retry/, 'stall warning must offer kill and retry');
    assert.match(workflow, /kill and switch to inline execution/, 'stall warning must offer inline fallback');
  });

  test('execute-plan documents atomic close-out invariant', () => {
    const workflow = read('gsd-core/workflows/execute-plan.md');

    assert.match(workflow, /<atomic_close_out_invariant>/, 'execute-plan must contain a formal atomic close-out invariant');
    assert.match(workflow, /production-code commit\(s\) -> SUMMARY commit -> STATE\/ROADMAP update/, 'invariant must name the legal close-out sequence');
    assert.match(workflow, /only legal half-state is mid-production-commits/, 'invariant must define the only legal half-state');
  });

  test('forensics includes the partial-plan drift detector', () => {
    const workflow = read('gsd-core/workflows/forensics.md');

    assert.match(workflow, /Partial-plan Drift Detection/);
    assert.match(workflow, /commits exist but SUMMARY.md is missing/);
    assert.match(workflow, /safe-resume verifier/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3227-config-set-model-overrides.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3227-config-set-model-overrides (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression test for bug #3227 — config-set rejects model_overrides.<agent-id>.
 *
 * `gsd-sdk query config-set model_overrides.gsd-plan-checker opus` was
 * rejected with "Unknown config key" because `model_overrides.<agent-id>` was
 * missing from DYNAMIC_KEY_PATTERNS in both the CJS schema and the SDK schema.
 *
 * The override mechanism itself worked correctly (resolve-model returned the
 * override after a direct file edit). Only the write path was gated wrong.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { DYNAMIC_KEY_PATTERNS, isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

describe('#3227 — config-set accepts model_overrides.<agent-id>', () => {
  test('isValidConfigKey accepts model_overrides.gsd-plan-checker', () => {
    assert.ok(
      isValidConfigKey('model_overrides.gsd-plan-checker'),
      'model_overrides.gsd-plan-checker must be accepted by isValidConfigKey'
    );
  });

  test('isValidConfigKey accepts model_overrides with various agent-id formats', () => {
    const validKeys = [
      'model_overrides.gsd-executor',
      'model_overrides.gsd-planner',
      'model_overrides.gsd-codebase-mapper',
      'model_overrides.my_custom_agent',
      'model_overrides.agent123',
    ];
    for (const key of validKeys) {
      assert.ok(isValidConfigKey(key), `isValidConfigKey must accept ${key}`);
    }
  });

  test('isValidConfigKey rejects bare model_overrides (no agent-id)', () => {
    assert.ok(
      !isValidConfigKey('model_overrides'),
      'bare model_overrides must be rejected (use model_overrides.<agent-id>)'
    );
  });

  test('DYNAMIC_KEY_PATTERNS includes an entry for model_overrides', () => {
    const hasPattern = DYNAMIC_KEY_PATTERNS.some(
      (p) => p.description && p.description.includes('model_overrides')
    );
    assert.ok(hasPattern, 'DYNAMIC_KEY_PATTERNS must have an entry covering model_overrides.<agent-id>');
  });

  test('config-set model_overrides.gsd-plan-checker opus succeeds via gsd-tools.cjs', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'model_overrides.gsd-plan-checker', 'opus'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set model_overrides.gsd-plan-checker opus should succeed,',
        'got:',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set model_overrides.gsd-plan-checker opus writes to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'model_overrides.gsd-plan-checker', 'opus'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.model_overrides !== undefined &&
        config.model_overrides['gsd-plan-checker'] === 'opus',
      [
        'Expected model_overrides["gsd-plan-checker"]: "opus" in config.json,',
        'got: ' + JSON.stringify(config),
      ].join('\n')
    );
  });

  test('config-get model_overrides.gsd-plan-checker returns opus after config-set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'model_overrides.gsd-plan-checker', 'opus'], tmpDir);

    const getResult = runGsdTools(
      ['config-get', 'model_overrides.gsd-plan-checker'],
      tmpDir
    );
    assert.ok(
      getResult.success,
      [
        'config-get model_overrides.gsd-plan-checker should succeed,',
        'got:',
        'stdout: ' + getResult.output,
        'stderr: ' + getResult.error,
      ].join('\n')
    );
    assert.ok(
      getResult.output.includes('opus'),
      'config-get output should contain "opus", got: ' + getResult.output
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-1452-context-guard-mode.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-1452-context-guard-mode (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product see #1452
// The execute-phase.md workflow and context-budget.md reference ARE the runtime
// contract loaded by AI runtimes. Asserting that the canonical wording for
// `workflow.context_guard_mode` is present in those files is the only way to
// verify runtimes will respect the flag at runtime.

/**
 * Enhancement #1452: workflow.context_guard_mode
 *
 * Guards long execute-phase workflows from driving the host session to context
 * exhaustion (ctx 100%). Before each wave, the orchestrator self-assesses
 * context pressure using the degradation signals defined in context-budget.md.
 *
 * Modes:
 *   "warn"  (default) — emit a structured warning + recommend /gsd:pause-work
 *   "auto"            — auto-invoke pause-work before the next wave
 *   "off"             — disable the guard entirely
 *
 * The check fires at wave boundaries ONLY (before spawning), never mid-wave.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const REPO_ROOT = path.join(__dirname, '..');

// ─── Schema registration ──────────────────────────────────────────────────────

describe('workflow.context_guard_mode in VALID_CONFIG_KEYS', () => {
  test('is a recognized config key', () => {
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config.cjs');
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.context_guard_mode'),
      'workflow.context_guard_mode should be in VALID_CONFIG_KEYS',
    );
  });
});

// ─── Default value ────────────────────────────────────────────────────────────

describe('workflow.context_guard_mode default value', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('defaults to warn in new project config', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `config-ensure-section failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.workflow.context_guard_mode,
      'warn',
      'workflow.context_guard_mode should default to "warn" — proactive checkpoint warning without auto-pausing workflows',
    );
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('workflow.context_guard_mode config round-trip', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
  });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set warn persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode warn', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'warn');
  });

  test('config-set auto persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode auto', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'auto');
  });

  test('config-set off persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode off', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'off');
  });

  test('persists in config.json as string', () => {
    runGsdTools('config-set workflow.context_guard_mode warn', tmpDir);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'warn');
    assert.strictEqual(typeof config.workflow.context_guard_mode, 'string');
  });

  test('rejects unknown mode values with clear error', () => {
    const result = runGsdTools('config-set workflow.context_guard_mode aggressive', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.context_guard_mode 'aggressive'/);
    assert.match(result.error, /auto, warn, off/);
  });

  test('rejects partial match values', () => {
    const result = runGsdTools('config-set workflow.context_guard_mode warnmode', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.context_guard_mode 'warnmode'/);
  });
});

// ─── execute-phase contract ───────────────────────────────────────────────────

describe('execute-phase.md documents the context_guard step', () => {
  let executePhase;
  let contextGuardRef;

  beforeEach(() => {
    executePhase = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md'),
      'utf-8',
    );
    // The step body is extracted to a reference file loaded via @-ref in execute-phase.md.
    // Both files together constitute the execute-phase wave-boundary contract.
    const refPath = path.join(REPO_ROOT, 'gsd-core', 'references', 'execute-phase-context-guard.md');
    contextGuardRef = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf-8') : '';
  });

  test('references workflow.context_guard_mode by canonical name', () => {
    const combined = executePhase + '\n' + contextGuardRef;
    assert.ok(
      combined.includes('workflow.context_guard_mode'),
      'execute-phase.md (or its @-referenced execute-phase-context-guard.md) must reference workflow.context_guard_mode so runtimes resolve the config-driven behavior',
    );
  });

  test('defines context_guard step at wave boundaries', () => {
    assert.ok(
      executePhase.includes('context_guard') || executePhase.includes('context-guard'),
      'execute-phase.md must define a context_guard step (or @-ref to it) that fires before each wave',
    );
  });

  test('references context-budget.md tiers in the guard step', () => {
    const combined = executePhase + '\n' + contextGuardRef;
    assert.ok(
      combined.includes('context-budget') || combined.includes('POOR') || combined.includes('DEGRADING'),
      'execute-phase.md context_guard (or its @-referenced file) must reference context-budget.md degradation tiers',
    );
  });
});

// ─── context-budget.md contract ──────────────────────────────────────────────

describe('context-budget.md documents POOR-tier trigger action', () => {
  let contextBudget;

  beforeEach(() => {
    contextBudget = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'context-budget.md'),
      'utf-8',
    );
  });

  test('defines POOR tier', () => {
    assert.ok(
      contextBudget.includes('POOR'),
      'context-budget.md must define the POOR tier',
    );
  });

  test('connects POOR tier to pause-work', () => {
    assert.ok(
      contextBudget.includes('pause-work') || contextBudget.includes('pause_work'),
      'context-budget.md POOR-tier rule must reference pause-work as the trigger action',
    );
  });

  test('documents context_guard_mode values', () => {
    assert.ok(
      contextBudget.includes('context_guard_mode'),
      'context-budget.md must document the workflow.context_guard_mode config key',
    );
  });
});

// ─── planning-config.md reference parity ─────────────────────────────────────

describe('planning-config.md documents workflow.context_guard_mode', () => {
  test('includes the key in the reference table', () => {
    const planningConfig = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'planning-config.md'),
      'utf-8',
    );
    assert.ok(
      planningConfig.includes('workflow.context_guard_mode'),
      'planning-config.md reference must include workflow.context_guard_mode so users know the config knob exists',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3309-human-verify-mode.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3309-human-verify-mode (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3309)
// Planner and verifier agent .md files ARE the runtime contract loaded by
// the AI runtimes. Asserting that the canonical wording for the new
// `workflow.human_verify_mode` flag is present in those files is the only
// way to verify the agents will respect the flag at runtime.

/**
 * Enhancement #3309: workflow.human_verify_mode = end-of-phase
 *
 * "mid-flight" preserves the pre-#3309 behavior — the planner emits
 * `<task type="checkpoint:human-verify">` tasks, and the executor halts at
 * each one. Each halt costs a full executor cold-start (CLAUDE.md, MEMORY.md,
 * STATE.md, plan re-read) because subagent context is discarded across the
 * pause.
 *
 * "end-of-phase" (the new default) instructs the planner NOT to emit
 * `checkpoint:human-verify` tasks and instead embed the verification details
 * into the relevant `auto` task's `<verify><human-check>` block. The verifier
 * (Step 8) harvests these blocks at end-of-phase and consolidates them into the existing
 * `human_needed` → HUMAN-UAT.md path, restoring the v1.35-shaped behavior
 * the reporter wanted without resurrecting the v1.35 writer.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const REPO_ROOT = path.join(__dirname, '..');

// ─── Schema registration ──────────────────────────────────────────────────────

describe('workflow.human_verify_mode in VALID_CONFIG_KEYS', () => {
  test('is a recognized config key', () => {
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config.cjs');
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.human_verify_mode'),
      'workflow.human_verify_mode should be in VALID_CONFIG_KEYS',
    );
  });
});

// ─── Default value (CJS) ──────────────────────────────────────────────────────

describe('workflow.human_verify_mode default value', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('defaults to end-of-phase in new project config', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `config-ensure-section failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.workflow.human_verify_mode,
      'end-of-phase',
      'workflow.human_verify_mode should default to "end-of-phase" — the cost-control mode is the project default; opt back into the pre-#3309 mid-flight behavior with config-set',
    );
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('workflow.human_verify_mode config round-trip', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
  });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set end-of-phase persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'end-of-phase');
  });

  test('config-set mid-flight overwrites end-of-phase in config.json', () => {
    runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);

    const setResult = runGsdTools('config-set workflow.human_verify_mode mid-flight', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'mid-flight');
  });

  test('persists in config.json as string', () => {
    runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'end-of-phase');
    assert.strictEqual(typeof config.workflow.human_verify_mode, 'string');
  });

  test('rejects invalid mode values', () => {
    const result = runGsdTools('config-set workflow.human_verify_mode midflight', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.human_verify_mode 'midflight'/);
    assert.match(result.error, /mid-flight, end-of-phase/);
  });
});

// ─── Planner agent contract ──────────────────────────────────────────────────

describe('agents/gsd-planner.md acknowledges workflow.human_verify_mode', () => {
  let plannerSrc;

  test('loads', () => {
    plannerSrc = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(plannerSrc.length > 0);
  });

  test('mentions workflow.human_verify_mode by canonical name', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(
      plannerSrc.includes('workflow.human_verify_mode'),
      'planner must reference the flag by canonical key so the runtime can resolve config-driven behavior',
    );
  });

  test('explains the end-of-phase behavior (do NOT emit checkpoint:human-verify)', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    // The planner must instruct: when end-of-phase, do NOT emit checkpoint:human-verify
    assert.ok(
      /end-of-phase[\s\S]{0,400}checkpoint:human-verify/i.test(plannerSrc) ||
      /checkpoint:human-verify[\s\S]{0,400}end-of-phase/i.test(plannerSrc),
      'planner must couple "end-of-phase" mode with the rule that checkpoint:human-verify tasks are not emitted',
    );
  });

  test('routes deferred verification through the <verify><human-check> block on auto tasks', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /`?<verify>`?\s*[\s\S]{0,200}`?<human-check>`?/i.test(plannerSrc) ||
      plannerSrc.includes('<verify><human-check>') ||
      plannerSrc.includes('`<verify><human-check>`'),
      'planner must document the <verify><human-check>...</human-check></verify> shape so the verifier can harvest deferred items',
    );
  });
});

// ─── Verifier agent contract ─────────────────────────────────────────────────

describe('agents/gsd-verifier.md harvests deferred human verification items', () => {
  test('Step 8 mentions harvesting <verify><human-check> blocks from PLAN.md', () => {
    const verifierSrc = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      verifierSrc.includes('<verify><human-check>') || /<verify>[\s\S]{0,200}<human-check>/i.test(verifierSrc),
      'verifier must instruct itself to harvest <verify><human-check> blocks from PLAN.md when human_verify_mode = end-of-phase',
    );
    assert.ok(
      verifierSrc.includes('human_verify_mode'),
      'verifier must reference the flag by canonical key',
    );
  });
});

// ─── References doc parity ───────────────────────────────────────────────────

describe('references/checkpoints.md documents the flag', () => {
  test('mentions workflow.human_verify_mode in the human-verify section', () => {
    const refSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'checkpoints.md'),
      'utf-8',
    );
    assert.ok(
      refSrc.includes('workflow.human_verify_mode'),
      'checkpoints reference must document the new flag so users know the cost-control alternative exists',
    );
  });
});
  });
}
