'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2940 — `gsd-update` overwrites `~/.codex/config.toml`,
 * removing any user/Codex-CLI settings added after the GSD-managed marker block.
 *
 * Root cause: `mergeCodexConfig`'s Case 2 (marker present) preserved content
 * BEFORE the marker but unconditionally discarded everything from the marker to
 * EOF, replacing it with a freshly generated GSD block. Since a fresh install
 * writes the GSD block as the file's entire content, any settings the user or
 * Codex CLI later adds (`[model]`, `[mcp_servers.*]`, `[profiles.*]`) land AFTER
 * the block, and every subsequent update wiped them.
 *
 * The fix preserves genuine trailing TOML by routing the post-marker region
 * through the existing `stripLeakedGsdCodexSections` (which removes GSD's own
 * managed/leaked sections while keeping user tables), then re-appending it after
 * the regenerated GSD block — without regressing #2406's de-dup.
 *
 * Matrix: .gsd/bug/fix/2940-codex-config-merge-preserves-trailing-content/50-test-matrix.md
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const {
  generateCodexConfigBlock,
  mergeCodexConfig,
  GSD_CODEX_MARKER,
} = require('../bin/install.js');

describe('mergeCodexConfig trailing-content preservation (#2940)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2940-merge-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** A GSD block with one agent (the shape installCodexConfig passes). */
  const block = () =>
    generateCodexConfigBlock([{ name: 'gsd-executor', description: 'Executes plans' }]);

  test('trailingUserModelSectionPreserved', () => {
    // Row 1 (failing-first regression): a config with the GSD block FIRST, then a user
    // [model] section after it (the real-world layout — fresh install fills the file,
    // user settings land after). Re-merge must preserve [model] byte-for-byte.
    const configPath = path.join(tmpDir, 'config.toml');
    const trailing = '[model]\nname = "gpt-5.4"\n';
    // First write: GSD block + user content after it (no content before the marker).
    fs.writeFileSync(configPath, block() + '\n' + trailing);

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'user [model] section preserved after re-merge');
    assert.ok(content.includes('name = "gpt-5.4"'), 'user model value preserved verbatim');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'GSD marker still present');
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker (no duplication)');
    assert.ok(content.includes('max_depth ='), 'GSD-managed [agents] block regenerated');
  });

  test('multipleTrailingTablesPreserved', () => {
    // Row 2: multiple trailing user tables ([mcp_servers.*], [profiles.*]).
    const configPath = path.join(tmpDir, 'config.toml');
    const trailing = [
      '[mcp_servers.figma]',
      'command = "npx"',
      'args = ["-y", "figma-mcp"]',
      '',
      '[profiles.dev]',
      'model = "o3"',
      'sandbox_mode = "workspace-write"',
    ].join('\n');
    fs.writeFileSync(configPath, block() + '\n' + trailing + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[mcp_servers.figma]'), 'mcp_servers table preserved');
    assert.ok(content.includes('[profiles.dev]'), 'profiles table preserved');
    assert.ok(content.includes('sandbox_mode = "workspace-write"'), 'profile value preserved');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'GSD block regenerated');
  });

  test('reMergeIsIdempotent', () => {
    // Row 3 (acceptance #2): merging the result of a merge again yields identical content.
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, block() + '\n[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, block());
    const afterFirst = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, block());
    const afterSecond = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(afterSecond, afterFirst, 'second merge is idempotent (no further change)');
  });

  test('leakedGsdSectionAfterMarkerStillStripped', () => {
    // Row 4 (#2406 non-regression): a leaked GSD-managed [agents.gsd-*] section AFTER the
    // marker is still REMOVED (not regrown), while genuine user content after it is preserved.
    const configPath = path.join(tmpDir, 'config.toml');
    const leakedAndUser = [
      '[agents.gsd-executor]',
      'description = "stale leaked"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[model]',
      'name = "o3"',
    ].join('\n');
    fs.writeFileSync(configPath, block() + '\n' + leakedAndUser + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    const gsdStructCount = (content.match(/^\[agents\.gsd-executor\]\s*$/gm) || []).length;
    assert.strictEqual(gsdStructCount, 0, 'leaked [agents.gsd-executor] after marker is stripped (not regrown)');
    assert.ok(content.includes('[model]'), 'genuine user [model] after the leaked section still preserved');
  });

  test('bareAgentsAfterMarkerHandled', () => {
    // Row 5: a user AgentsToml scalar (max_threads) the user folded INTO the managed [agents]
    // block (the valid, realistic shape — two [agents] tables would be invalid TOML), PLUS a
    // separate trailing [model] section. The fix must preserve the user scalar via the existing
    // spliceCodexAgentsScalars path AND preserve the trailing [model] via the new trailing-region
    // logic, while regenerating exactly one managed [agents] table.
    const configPath = path.join(tmpDir, 'config.toml');
    // Simulate: fresh install wrote the GSD block; the user then added max_threads into the
    // [agents] table and added a [model] section after it.
    const existing = [
      GSD_CODEX_MARKER,
      '',
      '[agents]',
      'max_depth = 1',
      'max_threads = 4',
      '',
      '[model]',
      'name = "o3"',
    ].join('\n');
    fs.writeFileSync(configPath, existing + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    // The user's max_threads scalar is preserved (spliced into the regenerated managed [agents]);
    // there is exactly one [agents] table (the managed one).
    assert.ok(content.includes('max_threads = 4'), 'user AgentsToml scalar (max_threads) preserved in managed block');
    const agentsHeaders = (content.match(/^\[agents\]\s*$/gm) || []).length;
    assert.strictEqual(agentsHeaders, 1, 'exactly one [agents] table (the managed one)');
    assert.ok(content.includes('max_depth = 1'), 'GSD-managed max_depth still present');
    assert.ok(content.includes('[model]'), 'trailing [model] still preserved');
  });

  test('beforeAndAfterMarkerBothPreserved', () => {
    // Row 6: content both BEFORE and AFTER the marker is preserved; GSD block regenerated once.
    const configPath = path.join(tmpDir, 'config.toml');
    const before = '[profiles.work]\nmodel = "gpt-5.4"\n';
    const after = '[mcp_servers.github]\ncommand = "gh-mcp"\n';
    fs.writeFileSync(configPath, before + '\n' + block() + '\n' + after + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[profiles.work]'), 'content before marker preserved');
    assert.ok(content.includes('[mcp_servers.github]'), 'content after marker preserved');
    const markerCount = (content.match(new RegExp(GSD_CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('noTrailingContentUnchanged', () => {
    // Row 7 (zero-trailing boundary): a config with ONLY the GSD block (fresh-install case)
    // re-merges to just the regenerated block — no spurious blank-line artifacts introduced
    // by the trailing-preservation logic.
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, block() + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    // No spurious trailing blank lines beyond the single trailing newline. Use a CRLF-safe
    // pattern (\r?\n) so the assertion holds under Windows git-autocrlf line endings.
    assert.ok(!/(?:\r?\n){3,}$/.test(content), 'no spurious run of blank lines at end of file');
    assert.strictEqual(content.trim(), block().trim(), 'content is exactly the regenerated block (whitespace-trimmed)');
  });
});
