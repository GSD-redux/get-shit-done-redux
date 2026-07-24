/**
 * Qoder conversion regression tests.
 *
 * Locks the three Qoder converters exported from bin/install.js:
 *  - convertClaudeToQoderMarkdown: path/brand rewrites, CLAUDE_CONFIG_DIR →
 *    QODER_CONFIG_DIR, compound-token (.claudeignore) preservation.
 *  - convertClaudeCommandToQoderSkill: emits sanitized name+description
 *    SKILL.md frontmatter, hyphen-normalises /gsd:<cmd> → gsd-<cmd>.
 *  - convertClaudeAgentToQoderAgent: sanitizes to the 2-field name+description
 *    frontmatter contract (ADR-3660 addendum) — NO tools:/color:/hook passthrough
 *    (the round-1 regression).
 */

// allow-test-rule: source-text-is-the-product (see #860) — converter output IS the shipped markdown

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  convertClaudeCommandToQoderSkill,
  convertClaudeAgentToQoderAgent,
  convertClaudeToQoderMarkdown,
} = require('../bin/install.js');

describe('convertClaudeToQoderMarkdown', () => {
  test('rewrites .claude slash-form paths to .qoder', () => {
    const input = 'See ~/.claude/skills/ and ./.claude/commands/ and .claude/hooks/';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('~/.qoder/skills/'), '~/.claude/skills/ → ~/.qoder/skills/');
    assert.ok(result.includes('./.qoder/'), './.claude/ → ./.qoder/');
    assert.ok(result.includes('.qoder/hooks/'), '.claude/hooks/ → .qoder/hooks/');
    assert.ok(!result.includes('.claude/'), 'no .claude/ remains');
  });

  test('rewrites bare ~/.claude and $HOME/.claude (no trailing slash)', () => {
    const input = 'configDir = ~/.claude or $HOME/.claude';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('~/.qoder'), '~/.claude → ~/.qoder');
    assert.ok(result.includes('$HOME/.qoder'), '$HOME/.claude → $HOME/.qoder');
    assert.ok(!result.includes('.claude'), 'no .claude remains');
  });

  test('preserves compound tokens .claudeignore and .claude-plugin (negative lookahead)', () => {
    const input = 'honors .claudeignore and loads .claude-plugin config';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('.claudeignore'), '.claudeignore preserved');
    assert.ok(result.includes('.claude-plugin'), '.claude-plugin preserved');
  });

  test('rewrites CLAUDE_CONFIG_DIR → QODER_CONFIG_DIR (matches descriptor env)', () => {
    const input = 'export RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('QODER_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR → QODER_CONFIG_DIR');
    assert.ok(!result.includes('CLAUDE_CONFIG_DIR'), 'no CLAUDE_CONFIG_DIR remains');
  });

  test('rewrites CLAUDE.md → AGENTS.md and Claude Code → Qoder', () => {
    const input = 'See CLAUDE.md and `./CLAUDE.md`. Powered by Claude Code.';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('AGENTS.md'), 'CLAUDE.md → AGENTS.md');
    assert.ok(result.includes('Qoder'), 'Claude Code → Qoder');
    assert.ok(!result.includes('Claude Code'), 'no "Claude Code" remains');
    assert.ok(!result.includes('CLAUDE.md'), 'no CLAUDE.md remains');
  });

  test('hyphen-normalises /gsd:<cmd> → /gsd-<cmd> references', () => {
    const input = 'Next: /gsd:execute-phase 17 then /gsd:plan-phase';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('/gsd-execute-phase 17'), '/gsd:execute-phase → /gsd-execute-phase');
    assert.ok(result.includes('/gsd-plan-phase'), '/gsd:plan-phase → /gsd-plan-phase');
  });

  test('content without frontmatter passes through with rewrites applied', () => {
    const input = 'No frontmatter here. ~/.claude/ and Claude Code.';
    const result = convertClaudeToQoderMarkdown(input);
    assert.ok(result.includes('~/.qoder/'), 'rewrites applied to frontmatter-less body');
    assert.ok(result.includes('Qoder'), 'brand rewrite applied');
  });

  test('is idempotent — applying twice equals once (fast-check property)', () => {
    // Every regex replacement produces output that no subsequent replacement
    // matches (.qoder/, AGENTS.md, Qoder, /gsd-), so a second pass is a no-op.
    fc.assert(fc.property(
      fc.string({ maxLength: 2000 }),
      (s) => convertClaudeToQoderMarkdown(s) === convertClaudeToQoderMarkdown(convertClaudeToQoderMarkdown(s))
    ));
  });
});

describe('convertClaudeCommandToQoderSkill', () => {
  test('emits sanitized name+description SKILL.md frontmatter', () => {
    const input = `---
name: gsd:help
description: Show available GSD commands
argument-hint: "[--brief | --full]"
---

# Help body
`;
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-help');
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'has frontmatter block');
    const fm = fmMatch[1];
    assert.ok(/^name: gsd-help$/m.test(fm), 'name field is the skill name');
    assert.ok(/^description: /m.test(fm), 'description field present');
    // Claude-specific fields must NOT pass through to the skill frontmatter.
    assert.ok(!/^argument-hint:/m.test(fm), 'argument-hint dropped (Claude-specific)');
  });

  test('falls back to a generic description when source lacks one', () => {
    const input = `---
name: bare
---

Body.
`;
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-bare');
    assert.ok(result.includes('Run GSD workflow gsd-bare.'), 'generic description fallback');
  });

  test('preserves 179-char description (below truncation boundary)', () => {
    const desc = 'a'.repeat(179);
    const input = `---\nname: gsd:test\ndescription: ${desc}\n---\n\nBody.\n`;
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-test');
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const descLine = fmMatch[1].match(/^description: (.*)$/m)[1];
    assert.equal(JSON.parse(descLine).length, 179, '179-char description not truncated');
  });

  test('preserves 180-char description (at truncation boundary)', () => {
    const desc = 'a'.repeat(180);
    const input = `---\nname: gsd:test\ndescription: ${desc}\n---\n\nBody.\n`;
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-test');
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const descLine = fmMatch[1].match(/^description: (.*)$/m)[1];
    assert.equal(JSON.parse(descLine).length, 180, '180-char description not truncated');
  });

  test('truncates 181-char description to 180 (177 + ellipsis)', () => {
    const desc = 'a'.repeat(181);
    const input = `---\nname: gsd:test\ndescription: ${desc}\n---\n\nBody.\n`;
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-test');
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const descLine = fmMatch[1].match(/^description: (.*)$/m)[1];
    const parsed = JSON.parse(descLine);
    assert.equal(parsed.length, 180, '181-char description truncated to 180');
    assert.ok(parsed.endsWith('...'), 'truncated with ellipsis');
  });
});

describe('convertClaudeAgentToQoderAgent', () => {
  test('sanitizes to 2-field name+description frontmatter (round-1 regression)', () => {
    // This is the exact defect from PR #852/#1021 round 1: Claude-specific
    // tools:/color:/commented hook blocks passed through verbatim. The ADR-3660
    // addendum normative contract: agents emit ONLY name+description, rebuilt
    // via yamlIdentifier/yamlQuote(toSingleLine(...)).
    const input = `---
name: gsd-executor
description: Executes GSD plans with atomic commits.
tools: Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*
color: yellow
# hooks:
#   PostToolUse:
#     - matcher: "Write|Edit"
---

<role>
You execute plans.
</role>
`;
    const result = convertClaudeAgentToQoderAgent(input);
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'has frontmatter block');
    const fm = fmMatch[1];
    assert.ok(/^name: gsd-executor$/m.test(fm), 'name preserved');
    assert.ok(/^description: /m.test(fm), 'description present');
    // Claude-specific frontmatter MUST NOT leak.
    assert.ok(!/^tools:/m.test(fm), 'tools: dropped (the round-1 bug)');
    assert.ok(!/^color:/m.test(fm), 'color: dropped');
    assert.ok(!fm.includes('hooks:'), 'commented hook block dropped');
    assert.ok(!fm.includes('mcp__context7__'), 'mcp tool list dropped');
    // Body is preserved (the role content survives).
    assert.ok(result.includes('You execute plans.'), 'agent body preserved');
  });

  test('passes through unchanged (minus rewrites) when no frontmatter', () => {
    const input = 'Agent body mentioning ~/.claude/ and Claude Code.';
    const result = convertClaudeAgentToQoderAgent(input);
    assert.ok(result.includes('~/.qoder/'), 'path rewrite applied');
    assert.ok(result.includes('Qoder'), 'brand rewrite applied');
    assert.ok(!result.startsWith('---'), 'no frontmatter injected');
  });

  test('command converter applies rewrites when no frontmatter', () => {
    const input = 'Command body mentioning ~/.claude/ and Claude Code.';
    const result = convertClaudeCommandToQoderSkill(input, 'gsd-test');
    assert.ok(result.includes('~/.qoder/'), 'path rewrite applied');
    assert.ok(result.includes('Qoder'), 'brand rewrite applied');
    assert.ok(!result.startsWith('---'), 'no frontmatter injected');
  });
});
