'use strict';

/**
 * Issue #4139: Compact Content mode — workflow.compact_content config key
 *
 * Verifies:
 *   1. config-set workflow.compact_content true → exits success, persisted as
 *      the boolean `true` (not the string "true").
 *   2. config-set workflow.compact_content false → exits success, persisted
 *      as the boolean `false`.
 *   3. config-set workflow.compact_content banana → exits failure, message
 *      matches /boolean|true|false/i.
 *   4. config-set workflow.compact_content "" → exits failure.
 *   5. config-get workflow.compact_content --raw before any set → exits
 *      non-zero (so the documented `|| echo "false"` shell fallback resolves
 *      to the literal `false`).
 *   6. Setting true twice → .planning/config.json content is identical to
 *      the single-set result (idempotency).
 *   7. Setting the key preserves every other pre-existing key/value in
 *      .planning/config.json (ordering/preservation).
 *   8. VALID_CONFIG_KEYS (gsd-core/bin/lib/config-schema.cjs) has
 *      'workflow.compact_content'.
 *   9. config-new-project omitting compact_content from its workflow object
 *      still materializes workflow.compact_content === false in
 *      .planning/config.json (CONF-01 fallback default,
 *      buildNewProjectConfig's hardcoded workflow object).
 *   10. config-new-project with an explicit compact_content: true/false
 *       persists that boolean (not a string).
 *   11. config-get workflow.compact_content --raw after config-new-project
 *       exits zero and prints the persisted value.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('workflow.compact_content config (#4139)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });
  afterEach(() => { cleanup(tmpDir); });

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
  }

  test('config-set workflow.compact_content true → persisted as boolean true', () => {
    const r = runGsdTools(['config-set', 'workflow.compact_content', 'true'], tmpDir);
    assert.ok(r.success, r.error);
    const config = readConfig();
    assert.strictEqual(config.workflow.compact_content, true);
  });

  test('config-set workflow.compact_content false → persisted as boolean false', () => {
    const r = runGsdTools(['config-set', 'workflow.compact_content', 'false'], tmpDir);
    assert.ok(r.success, r.error);
    const config = readConfig();
    assert.strictEqual(config.workflow.compact_content, false);
  });

  test('config-set workflow.compact_content banana → rejected', () => {
    const r = runGsdTools(['config-set', 'workflow.compact_content', 'banana'], tmpDir);
    assert.ok(!r.success, 'non-boolean value must be rejected');
    assert.match(r.error || r.output, /boolean|true|false/i);
  });

  test('config-set workflow.compact_content "" → rejected', () => {
    const r = runGsdTools(['config-set', 'workflow.compact_content', ''], tmpDir);
    assert.ok(!r.success, 'empty value must be rejected');
  });

  test('config-get workflow.compact_content --raw before any explicit set → succeeds with the materialized default', () => {
    // As of plan 02-02 (CONF-01), buildNewProjectConfig's hardcoded workflow
    // object carries compact_content: false, so any freshly materialized
    // config.json (including the one config-ensure-section writes in
    // beforeEach) already has the key — config-get succeeds and returns the
    // default "false" rather than exiting non-zero. The workflow-side
    // `... --raw 2>/dev/null || echo "false"` fallback still resolves to the
    // same string either way, so gate hooks are unaffected by this change.
    const r = runGsdTools(['config-get', 'workflow.compact_content', '--raw'], tmpDir);
    assert.ok(r.success, 'config-get on the materialized default must exit zero');
    assert.strictEqual(r.output.trim(), 'false');
  });

  test('setting true twice is idempotent — identical config.json content', () => {
    const first = runGsdTools(['config-set', 'workflow.compact_content', 'true'], tmpDir);
    assert.ok(first.success, first.error);
    const afterFirst = fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8');

    const second = runGsdTools(['config-set', 'workflow.compact_content', 'true'], tmpDir);
    assert.ok(second.success, second.error);
    const afterSecond = fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8');

    assert.strictEqual(afterSecond, afterFirst);
  });

  test('setting the key preserves every other pre-existing key/value', () => {
    const cfgPath = path.join(tmpDir, '.planning', 'config.json');
    const before = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    before.workflow.text_mode = true;
    before.mode = 'yolo';
    fs.writeFileSync(cfgPath, JSON.stringify(before, null, 2));

    const r = runGsdTools(['config-set', 'workflow.compact_content', 'true'], tmpDir);
    assert.ok(r.success, r.error);

    const after = readConfig();
    assert.strictEqual(after.workflow.text_mode, true, 'workflow.text_mode must survive unrelated key write');
    assert.strictEqual(after.mode, 'yolo', 'top-level mode must survive unrelated key write');
    assert.strictEqual(after.workflow.compact_content, true);
  });

  test('VALID_CONFIG_KEYS has workflow.compact_content', () => {
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
    assert.strictEqual(VALID_CONFIG_KEYS.has('workflow.compact_content'), true);
  });

  test('config-set workflow.compact_content 42 → rejected, message names the key', () => {
    const r = runGsdTools(['config-set', 'workflow.compact_content', '42'], tmpDir);
    assert.ok(!r.success, 'numeric value must be rejected');
    assert.match(r.error || r.output, /workflow\.compact_content/);
  });

  test('config-set workflow.compact_content null → unsets the key (universal #2046 clear semantics, not a type-rejection)', () => {
    // A bare `null` is the documented "clear this key" shortcut (#2046) and is
    // short-circuited before every typed per-key validator runs — this is
    // true for every config key, not something this plan introduces or may
    // change. Verified against the analogous git.protected_branches and
    // context-key coverage in tests/config.test.cjs ("config-set <key> null —
    // unset/clear (#2046)"). So `null` exits zero and removes the key rather
    // than being rejected like `42`/`banana`/`""`.
    const r = runGsdTools(['config-set', 'workflow.compact_content', 'null'], tmpDir);
    assert.ok(r.success, `unset must succeed: ${r.error}`);
    const config = readConfig();
    assert.ok(
      !Object.prototype.hasOwnProperty.call(config.workflow, 'compact_content'),
      'workflow.compact_content must be absent after unset',
    );
  });

  test('config-defaults.manifest.json carries workflow.compact_content', () => {
    const manifest = require('../gsd-core/bin/shared/config-defaults.manifest.json');
    assert.strictEqual(manifest.workflow.compact_content, false);
  });
});

// ─── D-03: absent-key resolution against a config that omits the key ─────────

describe('workflow.compact_content absent-key resolution (#4139, D-03)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => { cleanup(tmpDir); });

  test('absent key: a config.json omitting compact_content resolves to the manifest default', () => {
    const cfgDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ version: '1.0', mode: 'interactive', workflow: { research: true } }, null, 2),
    );

    const manifest = require('../gsd-core/bin/shared/config-defaults.manifest.json');
    const r = runGsdTools(['config-get', 'workflow.compact_content', '--raw'], tmpDir);
    assert.strictEqual(r.exitCode, 0, r.error || r.output);
    assert.strictEqual(r.output.trim(), String(manifest.workflow.compact_content));
  });
});

// ─── CONF-01: buildNewProjectConfig default + config-new-project wiring ───────

describe('workflow.compact_content via config-new-project (#4139, CONF-01)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => { cleanup(tmpDir); });

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
  }

  test('config-new-project omitting compact_content → hardcoded default false lands in config.json', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'coarse',
      parallelization: true,
      commit_docs: false,
      model_profile: 'adaptive',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: false },
    });
    const r = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(r.success, r.error);
    const config = readConfig();
    assert.strictEqual(config.workflow.compact_content, false);
  });

  test('config-new-project with compact_content: true → persisted as boolean true', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'coarse',
      parallelization: true,
      commit_docs: false,
      model_profile: 'adaptive',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: false, compact_content: true },
    });
    const r = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(r.success, r.error);
    const config = readConfig();
    assert.strictEqual(config.workflow.compact_content, true);
  });

  test('config-new-project with compact_content: false → persisted as boolean false, not string', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'coarse',
      parallelization: true,
      commit_docs: false,
      model_profile: 'adaptive',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: false, compact_content: false },
    });
    const r = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(r.success, r.error);
    const config = readConfig();
    assert.strictEqual(config.workflow.compact_content, false);
    assert.notStrictEqual(config.workflow.compact_content, 'false');
  });

  test('config-get workflow.compact_content --raw after config-new-project prints the persisted value', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'coarse',
      parallelization: true,
      commit_docs: false,
      model_profile: 'adaptive',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: false, compact_content: true },
    });
    const setup = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(setup.success, setup.error);

    const r = runGsdTools(['config-get', 'workflow.compact_content', '--raw'], tmpDir);
    assert.ok(r.success, 'config-get must exit zero once config-new-project has materialized the key');
    assert.strictEqual(r.output.trim(), 'true');
  });
});

// ─── D-06: doc-row shape assertions for both config reference tables ─────────

describe('workflow.compact_content documentation rows (#4139, D-06)', () => {
  const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');
  const KEY_CELL = '`workflow.compact_content`';

  function findRow(filePath) {
    const lines = fs.readFileSync(path.join(__dirname, '..', filePath), 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim().startsWith('|')) continue;
      const cells = splitTableRow(line);
      if (cells && cells[0] === KEY_CELL) return cells;
    }
    return undefined;
  }

  test('docs/CONFIGURATION.md documents workflow.compact_content as a 4-cell boolean row', () => {
    const cells = findRow('docs/CONFIGURATION.md');
    assert.ok(cells, 'workflow.compact_content row not found in docs/CONFIGURATION.md');
    assert.strictEqual(cells.length, 4);
    assert.strictEqual(cells[1], 'boolean');
    assert.strictEqual(cells[2], '`false`');
  });

  test('planning-config.md documents workflow.compact_content as a 5-cell boolean row', () => {
    const cells = findRow('gsd-core/references/planning-config.md');
    assert.ok(cells, 'workflow.compact_content row not found in planning-config.md');
    assert.strictEqual(cells.length, 5);
    assert.strictEqual(cells[1], 'boolean');
    assert.strictEqual(cells[2], '`false`');
    assert.match(cells[3], /`true`/);
    assert.match(cells[3], /`false`/);
  });

  test('both doc rows sit under the Workflow section they belong to', () => {
    const planningConfigPath = path.join(__dirname, '..', 'gsd-core/references/planning-config.md');
    const planningConfigContent = fs.readFileSync(planningConfigPath, 'utf-8');
    const keyIdx = planningConfigContent.indexOf('`workflow.compact_content`');
    const fieldRefIdx = planningConfigContent.indexOf('## Complete Field Reference');
    const workflowFieldsIdx = planningConfigContent.indexOf('### Workflow Fields');
    assert.ok(keyIdx > -1, 'key not found in planning-config.md');
    assert.ok(keyIdx > fieldRefIdx, 'row must sit after ## Complete Field Reference heading');
    assert.ok(keyIdx > workflowFieldsIdx, 'row must sit after ### Workflow Fields heading');

    const configurationMdPath = path.join(__dirname, '..', 'docs/CONFIGURATION.md');
    const configurationMdContent = fs.readFileSync(configurationMdPath, 'utf-8');
    const compactIdx = configurationMdContent.indexOf('`workflow.compact_content`');
    const textModeIdx = configurationMdContent.indexOf('`workflow.text_mode`');
    assert.ok(compactIdx > -1, 'key not found in docs/CONFIGURATION.md');
    assert.ok(compactIdx > textModeIdx, 'row must sit inside the workflow.* run, after workflow.text_mode');
  });
});
