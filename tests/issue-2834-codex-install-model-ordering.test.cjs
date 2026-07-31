// allow-test-rule: structural-implementation-guard (#2834)
'use strict';

// Regression guard for #2834: on a clean Codex install, agent TOMLs contained no
// model-routing fields because defaults.json (resolve_model_ids + runtime) was written
// AFTER installCodexConfig generated the TOMLs. The fix extracts writeNonClaudeDefaults
// and calls it BEFORE installCodexConfig. This test asserts the ordering invariant in
// the install source so a future edit can't silently re-introduce the gap.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');

test('writeNonClaudeDefaults is called before installCodexConfig in the Codex install flow (#2834)', () => {
  const src = fs.readFileSync(INSTALL_JS, 'utf8');

  // Find the call to writeNonClaudeDefaults that precedes installCodexConfig.
  const writeIdx = src.indexOf('writeNonClaudeDefaults(runtime);');
  assert.ok(writeIdx !== -1, 'writeNonClaudeDefaults(runtime) must be called in the install flow');

  // Find the FIRST installCodexConfig call AFTER the writeNonClaudeDefaults call.
  const codexGenIdx = src.indexOf('installCodexConfig(targetDir', writeIdx);
  assert.ok(codexGenIdx !== -1 && codexGenIdx > writeIdx,
    'installCodexConfig must be called AFTER writeNonClaudeDefaults so defaults.json ' +
    '(resolve_model_ids + runtime) exists before agent TOML generation reads it (#2834)');

  // The #2834 comment must be present at the call site.
  const callSite = src.slice(writeIdx - 300, writeIdx + 100);
  assert.ok(/#2834/.test(callSite), 'the writeNonClaudeDefaults call must carry the #2834 rationale comment');
});

test('writeNonClaudeDefaults function exists and is a no-op for Claude (#2834)', () => {
  const src = fs.readFileSync(INSTALL_JS, 'utf8');
  const fnIdx = src.indexOf('function writeNonClaudeDefaults(');
  assert.ok(fnIdx !== -1, 'writeNonClaudeDefaults must be defined as a function');
  const fnBody = src.slice(fnIdx, fnIdx + 1200);
  assert.ok(/nativeModelAliases/.test(fnBody), 'writeNonClaudeDefaults must early-return for Claude (nativeModelAliases check)');
  assert.ok(/resolve_model_ids/.test(fnBody), 'writeNonClaudeDefaults must write resolve_model_ids');
  assert.ok(/defaults\.runtime/.test(fnBody), 'writeNonClaudeDefaults must write runtime');
});
