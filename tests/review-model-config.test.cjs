/**
 * Review Model Config Tests (#1849)
 *
 * Verifies the review.models.<cli> dynamic config key pattern:
 *   - isValidConfigKey accepts review.models.<cli-name>
 *   - validateKnownConfigKeyPath suggests review.models.<cli-name> for review.model
 *   - End-to-end round-trip via config-set / config-get for model IDs and the
 *     null "Clear" action (#2046 — config-set <key> null unsets the key)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('review.models.<cli> config key', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Ensure config exists for set/get
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('isValidConfigKey accepts review.models.gemini', () => {
    // Exercised via config-set, which calls isValidConfigKey internally and
    // errors out if the key is not valid.
    const result = runGsdTools(
      ['config-set', 'review.models.gemini', 'gemini-3.1-pro-preview'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `config-set should succeed for review.models.gemini: ${result.error}`);
  });

  test('isValidConfigKey accepts review.models.codex', () => {
    const result = runGsdTools(
      ['config-set', 'review.models.codex', 'gpt-5-codex'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `config-set should succeed for review.models.codex: ${result.error}`);
  });

  test('isValidConfigKey accepts review.models.claude (#2688)', () => {
    const result = runGsdTools(
      ['config-set', 'review.models.claude', 'claude-opus-4-6'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `config-set should succeed for review.models.claude: ${result.error}`);
  });

  test('round-trip: review.models.claude config-set then config-get (#2688)', () => {
    const setResult = runGsdTools(
      ['config-set', 'review.models.claude', 'claude-opus-4-6'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const getResult = runGsdTools(
      ['config-get', 'review.models.claude', '--raw'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(getResult.success, `config-get failed: ${getResult.error}`);
    assert.strictEqual(
      getResult.output,
      'claude-opus-4-6',
      'config-get should return the model ID set via config-set'
    );
  });

  test('review.model is rejected and suggests review.models.<cli-name>', () => {
    // The suggestion path goes through validateKnownConfigKeyPath, which is
    // called before isValidConfigKey in cmdConfigSet.
    const result = runGsdTools(
      ['config-set', 'review.model', 'gemini-3.1-pro-preview'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(!result.success, 'config-set should fail for review.model');
    assert.ok(
      result.error.includes('review.models.<cli-name>'),
      `error should suggest review.models.<cli-name>, got: ${result.error}`
    );
  });

  test('round-trip: config-set then config-get for a model ID', () => {
    const setResult = runGsdTools(
      ['config-set', 'review.models.gemini', 'gemini-3.1-pro-preview'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const getResult = runGsdTools(
      ['config-get', 'review.models.gemini', '--raw'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(getResult.success, `config-get failed: ${getResult.error}`);
    assert.strictEqual(
      getResult.output,
      'gemini-3.1-pro-preview',
      'config-get should return the value set via config-set'
    );
  });

  test('round-trip: config-set null UNSETS the model key (#2046 — the "Clear" action)', () => {
    // #2046: `config-set <key> null` now DELETES the key (the documented "Clear"
    // action) instead of persisting the literal string "null". A previously-set
    // model override is removed cleanly; config-get then reports key-not-found.
    // The review workflow's guard (`[ -n "$VAR" ] && [ "$VAR" != "null" ]`,
    // review.md:259) treats the resulting empty read as "no override → use the
    // reviewer's default", exactly as it treated the old "null" sentinel.
    const setResult = runGsdTools(
      ['config-set', 'review.models.gemini', 'gemini-3.1-pro-preview'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const clearResult = runGsdTools(
      ['config-set', 'review.models.gemini', 'null'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(clearResult.success, `config-set null failed: ${clearResult.error}`);

    // The key is gone from disk — not persisted as the string "null".
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const rawText = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawText);
    assert.ok(
      !config.review || !config.review.models ||
        !Object.prototype.hasOwnProperty.call(config.review.models, 'gemini'),
      `review.models.gemini must be absent after clear, got: ${rawText}`
    );
    assert.doesNotMatch(rawText, /"gemini":\s*"null"/,
      'must never persist review.models.gemini as the literal string "null"');

    // config-get on the removed key yields EMPTY (the review workflow reads it as
    // `... 2>/dev/null || echo ""` → empty → the `[ -n "$VAR" ]` guard falls back
    // to the reviewer default).
    //
    // #2797: this key is now federated to the `gemini` lane capability, and a
    // federated key always resolves to its declared default — so config-get exits
    // 0 with empty output rather than exiting non-zero with "Key not found". The
    // WORKFLOW outcome is unchanged: the guard above sees empty either way, which
    // is exactly what this test's own rationale (the comment above) turns on.
    //
    // What #2046 actually protects is asserted below and is untouched: clearing
    // must never yield the literal string "null", which would be handed to the
    // CLI as a model name.
    const getResult = runGsdTools(
      ['config-get', 'review.models.gemini', '--raw'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.strictEqual((getResult.output || '').trim(), '',
      'config-get on a cleared key must yield empty output');
    assert.notStrictEqual(getResult.output && getResult.output.trim(), 'null',
      'config-get must not emit the literal string "null" for a cleared key');
  });
});
