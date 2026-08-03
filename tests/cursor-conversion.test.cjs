/**
 * Cursor conversion regression tests.
 *
 * Ensures Cursor frontmatter names are emitted as plain identifiers
 * (without surrounding quotes), so Cursor does not treat quotes as
 * literal parts of skill/subagent names.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeCommandToCursorSkill,
  convertClaudeAgentToCursorAgent,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

describe('convertClaudeCommandToCursorSkill', () => {
  test('writes unquoted Cursor skill name in frontmatter', () => {
    const input = `---
name: quick
description: Execute a quick task
---

<objective>
Test body
</objective>
`;

    const result = convertClaudeCommandToCursorSkill(input, 'gsd-quick');
    const nameMatch = result.match(/^name:\s*(.+)$/m);

    assert.ok(nameMatch, 'frontmatter contains name field');
    assert.strictEqual(nameMatch[1], 'gsd-quick', 'skill name is plain scalar');
    assert.ok(!result.includes('name: "gsd-quick"'), 'quoted skill name is not emitted');
  });

  test('preserves slash for slash commands in markdown body', () => {
    const input = `---
name: gsd:plan-phase
description: Plan a phase
---

Next:
/gsd:execute-phase 17
/gsd-help
gsd:progress
`;

    const result = convertClaudeCommandToCursorSkill(input, 'gsd-plan-phase');

    assert.ok(result.includes('/gsd-execute-phase 17'), 'slash command remains slash-prefixed');
    assert.ok(result.includes('/gsd-help'), 'existing slash command is preserved');
    assert.ok(result.includes('gsd-progress'), 'non-slash gsd: references still normalize');
    assert.ok(!result.includes('/gsd:execute-phase'), 'legacy colon command form is removed');
  });
});

describe('convertClaudeAgentToCursorAgent', () => {
  test('writes unquoted Cursor agent name in frontmatter', () => {
    const input = `---
name: gsd-planner
description: Planner agent
tools: Read, Write
color: green
---

<role>
Planner body
</role>
`;

    const result = convertClaudeAgentToCursorAgent(input);
    const nameMatch = result.match(/^name:\s*(.+)$/m);

    assert.ok(nameMatch, 'frontmatter contains name field');
    assert.strictEqual(nameMatch[1], 'gsd-planner', 'agent name is plain scalar');
    assert.ok(!result.includes('name: "gsd-planner"'), 'quoted agent name is not emitted');
  });
});

// ─── _applyRuntimeRewrites(cursor) — bare-form regression (#1356) ────────────
//
// Prior to this fix the cursor branch only rewrote trailing-slash ~/.claude/
// and $HOME/.claude/ forms.  Bare end-of-token references (end of line,
// inside backtick spans, before punctuation) survived and triggered the
// post-install audit "Found N unreplaced .claude path reference(s)".
//
// Fix: add three bare-form rewrites (mirroring augment/windsurf/trae) using
// (?![\w-]) to avoid corrupting .claude-plugin / .claudeignore.
//
// TDD proof: these assertions FAIL before the fix and PASS after.

describe('_applyRuntimeRewrites(cursor) — bare-form ~/.claude regression (#1356)', () => {
  const CURSOR_PATH_PREFIX = '~/.cursor/';

  // Compound input that exercises every bare and slash ~/.claude / $HOME/.claude
  // form the fix must handle.  .claude-plugin is intentionally excluded here
  // because \b fires before the hyphen — its preservation is tested separately.
  const COMPOUND_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/gsd-core/foo.md',
    'Inline: paths `~/.claude`, `~/.cursor`',
  ].join('\n');

  // Input for the preservation test only — includes .claude-plugin.
  const COMPOUND_INPUT_WITH_PLUGIN = COMPOUND_INPUT + '\nPlugin installed at: ~/.claude-plugin/plugin.json';

  test('bare ~/.claude at end of line is rewritten (no trailing slash)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'cursor', CURSOR_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude\b/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
    assert.ok(result.includes('~/.cursor'), `cursor prefix must appear; got:\n${result}`);
  });

  test('bare $HOME/.claude at end of line is rewritten', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'cursor', CURSOR_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude\b/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('bare ~/.claude inside a code span (before punctuation) is rewritten', () => {
    const input = 'paths: `~/.claude`, `~/.cursor`';
    const result = _applyRuntimeRewrites(input, 'cursor', CURSOR_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude\b/.test(result),
      `bare ~/.claude before punctuation must be gone; got:\n${result}`,
    );
  });

  test('trailing-slash ~/.claude/gsd-core/foo.md is rewritten exactly once (no doubling)', () => {
    const input = '~/.claude/gsd-core/foo.md';
    const result = _applyRuntimeRewrites(input, 'cursor', CURSOR_PATH_PREFIX);
    assert.ok(result.includes('~/.cursor/gsd-core/foo.md'), `slash form must be rewritten; got: ${result}`);
    assert.ok(!result.includes('cursor/cursor'), `path must not be doubled; got: ${result}`);
    assert.ok(!result.includes('.claude'), `no .claude must survive; got: ${result}`);
  });

  test('zero surviving bare ~/.claude or $HOME/.claude refs in compound input', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'cursor', CURSOR_PATH_PREFIX);
    const bareClaudePattern = /(?:~|\$HOME)\/\.claude\b/;
    assert.ok(
      !bareClaudePattern.test(result),
      `no bare ~/.claude / $HOME/.claude must survive; got:\n${result}`,
    );
  });

  test('~/.claude-plugin is NOT corrupted — (?![\\w-]) lookahead preserves it', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT_WITH_PLUGIN, 'cursor', CURSOR_PATH_PREFIX);
    assert.ok(
      result.includes('~/.claude-plugin'),
      `~/.claude-plugin must be preserved; got:\n${result}`,
    );
    assert.ok(
      !result.includes('~/.cursor-plugin'),
      `~/.cursor-plugin must NOT appear; got:\n${result}`,
    );
  });

  test('bare relative ./.claude (end-of-token) is rewritten to ./.cursor', () => {
    // The relative bare form ./.claude (no trailing slash) must also be caught.
    // End-of-line, inside a code span, and before punctuation variants.
    // The cursor dir name derived from pathPrefix '~/.cursor/' is '.cursor',
    // so ./.claude → ./.cursor (the ./${dotDirName} form).
    const pathPrefix = '~/.cursor/';
    const isGlobal = false;

    const input = [
      'see ./.claude for config',
      'also `./.claude` in a code span',
    ].join('\n');

    const result = _applyRuntimeRewrites(input, 'cursor', pathPrefix, isGlobal);

    assert.ok(
      result.includes('./.cursor'),
      `bare ./.claude must be rewritten to ./.cursor; got:\n${result}`,
    );
    assert.ok(
      !/\/\.claude\b/.test(result),
      `no bare ./.claude (end-of-token) must survive; got:\n${result}`,
    );
  });
});
