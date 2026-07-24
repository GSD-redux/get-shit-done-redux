/**
 * Tests for multi-runtime selection in the interactive installer prompt.
 * Verifies that promptRuntime accepts comma-separated, space-separated,
 * and single-choice inputs, deduplicates, and falls back to claude.
 * See issue #1281.
 *
 * Per CONTRIBUTING.md "no-source-grep" testing standard, prompt + parser
 * behavior is asserted via the install module's exported pure functions
 * (`runtimeMap`, `allRuntimes`, `parseRuntimeInput`, `buildRuntimePromptText`)
 * instead of regexing bin/install.js source text.
 *
 * #1928: Google sunset Gemini CLI (2026-06-18) and the `gemini` runtime was
 * removed from GSD (Antigravity CLI is the successor). The runtime option
 * numbering below is renumbered accordingly — option 9 (formerly gemini) is
 * now hermes.
 *
 * #1925: ZCode (Z.ai) added as option 16; the "All" shortcut moved from 16 to 17.
 *
 * #2102: pi added as option 13 (alphabetical slot between opencode and qwen) —
 * qwen/trae/windsurf/zcode each shift up one slot (14/15/16/17).
 * #860: Qoder added as option 15 (alphabetical slot between pi and qwen) —
 * qwen/trae/windsurf/zcode each shift up one slot (16/17/18/19); "All" is now 20.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  runtimeMap,
  allRuntimes,
  selectRuntimesFromArgs,
  parseRuntimeInput,
  buildRuntimePromptText,
} = require('../bin/install.js');

// Strip ANSI color codes for human-readable assertions on prompt text.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('multi-runtime selection parsing', () => {
  test('single choice returns single runtime', () => {
    assert.deepStrictEqual(parseRuntimeInput('1'), ['claude']);
    assert.deepStrictEqual(parseRuntimeInput('2'), ['antigravity']);
    assert.deepStrictEqual(parseRuntimeInput('3'), ['augment']);
    assert.deepStrictEqual(parseRuntimeInput('4'), ['cline']);
    assert.deepStrictEqual(parseRuntimeInput('5'), ['codebuddy']);
    assert.deepStrictEqual(parseRuntimeInput('6'), ['codex']);
    assert.deepStrictEqual(parseRuntimeInput('7'), ['copilot']);
    assert.deepStrictEqual(parseRuntimeInput('8'), ['cursor']);
  });

  test('comma-separated choices return multiple runtimes', () => {
    assert.deepStrictEqual(parseRuntimeInput('1,7,9'), ['claude', 'copilot', 'hermes']);
    assert.deepStrictEqual(parseRuntimeInput('2,3'), ['antigravity', 'augment']);
    assert.deepStrictEqual(parseRuntimeInput('3,6'), ['augment', 'codex']);
  });

  test('space-separated choices return multiple runtimes', () => {
    assert.deepStrictEqual(parseRuntimeInput('1 7 9'), ['claude', 'copilot', 'hermes']);
    assert.deepStrictEqual(parseRuntimeInput('8 12'), ['cursor', 'kilo']);
  });

  test('mixed comma and space separators work', () => {
    assert.deepStrictEqual(parseRuntimeInput('1, 7, 9'), ['claude', 'copilot', 'hermes']);
    assert.deepStrictEqual(parseRuntimeInput('2 , 8'), ['antigravity', 'cursor']);
  });

  test('single choice for hermes', () => {
    assert.deepStrictEqual(parseRuntimeInput('9'), ['hermes']);
  });

  test('single choice for kilo', () => {
    assert.deepStrictEqual(parseRuntimeInput('12'), ['kilo']);
  });

  test('single choice for opencode', () => {
    assert.deepStrictEqual(parseRuntimeInput('13'), ['opencode']);
  });

  test('single choice for pi', () => {
    assert.deepStrictEqual(parseRuntimeInput('14'), ['pi']);
  });

  test('single choice for qwen', () => {
    assert.deepStrictEqual(parseRuntimeInput('16'), ['qwen']);
  });

  test('single choice for trae', () => {
    assert.deepStrictEqual(parseRuntimeInput('17'), ['trae']);
  });

  test('single choice for windsurf', () => {
    assert.deepStrictEqual(parseRuntimeInput('18'), ['windsurf']);
  });

  test('single choice for zcode', () => {
    assert.deepStrictEqual(parseRuntimeInput('19'), ['zcode']);
  });

  test('single choice for kimi', () => {
    assert.deepStrictEqual(parseRuntimeInput('10'), ['kimi']);
  });

  test('single choice for kimi-code (#2454)', () => {
    assert.deepStrictEqual(parseRuntimeInput('11'), ['kimi-code']);
  });

  test('single choice for qoder', () => {
    assert.deepStrictEqual(parseRuntimeInput('15'), ['qoder']);
  });

  test('choice 20 returns all runtimes', () => {
    assert.deepStrictEqual(parseRuntimeInput('20'), allRuntimes);
  });

  test('choice 20 returns all runtimes when mixed with separators or other tokens', () => {
    // CR feedback: tokenized inputs that include 20 (e.g. trailing comma, or
    // alongside other choices) must still expand to all-runtimes — previously
    // only the bare all-runtimes option matched, so "20," or "20 1" silently installed a
    // subset.
    assert.deepStrictEqual(parseRuntimeInput('20,'), allRuntimes);
    assert.deepStrictEqual(parseRuntimeInput('20 1'), allRuntimes);
    assert.deepStrictEqual(parseRuntimeInput('1,20'), allRuntimes);
    assert.deepStrictEqual(parseRuntimeInput('  20  '), allRuntimes);
  });

  test('empty input defaults to claude', () => {
    assert.deepStrictEqual(parseRuntimeInput(''), ['claude']);
    assert.deepStrictEqual(parseRuntimeInput('   '), ['claude']);
  });

  test('invalid choices are ignored, falls back to claude if all invalid', () => {
    assert.deepStrictEqual(parseRuntimeInput('21'), ['claude']);
    assert.deepStrictEqual(parseRuntimeInput('0'), ['claude']);
    assert.deepStrictEqual(parseRuntimeInput('abc'), ['claude']);
  });

  test('invalid choices mixed with valid are filtered out', () => {
    assert.deepStrictEqual(parseRuntimeInput('1,21,7'), ['claude', 'copilot']);
    assert.deepStrictEqual(parseRuntimeInput('abc 3 xyz'), ['augment']);
  });

  test('duplicate choices are deduplicated', () => {
    assert.deepStrictEqual(parseRuntimeInput('1,1,1'), ['claude']);
    assert.deepStrictEqual(parseRuntimeInput('7,7,9,9'), ['copilot', 'hermes']);
  });

  test('preserves selection order', () => {
    assert.deepStrictEqual(parseRuntimeInput('9,1,7'), ['hermes', 'claude', 'copilot']);
    assert.deepStrictEqual(parseRuntimeInput('12,2,8'), ['kilo', 'antigravity', 'cursor']);
  });
});

describe('install.js exports multi-select runtime metadata', () => {
  const expectedRuntimeMap = {
    '1': 'claude',
    '2': 'antigravity',
    '3': 'augment',
    '4': 'cline',
    '5': 'codebuddy',
    '6': 'codex',
    '7': 'copilot',
    '8': 'cursor',
    '9': 'hermes',
    '10': 'kimi',
    '11': 'kimi-code',
    '12': 'kilo',
    '13': 'opencode',
    '14': 'pi',
    '15': 'qoder',
    '16': 'qwen',
    '17': 'trae',
    '18': 'windsurf',
    '19': 'zcode',
  };
  const expectedRuntimes = [
    'claude', 'antigravity', 'augment', 'cline', 'codebuddy', 'codex',
    'copilot', 'cursor', 'hermes', 'kimi', 'kimi-code', 'kilo', 'opencode', 'pi',
    'qoder', 'qwen', 'trae', 'windsurf', 'zcode',
  ];

  test('runtimeMap exports every option key bound to the right runtime', () => {
    assert.deepStrictEqual(runtimeMap, expectedRuntimeMap,
      'exported runtimeMap matches the canonical option list');
  });

  test('allRuntimes contains every runtime exactly once', () => {
    assert.strictEqual(allRuntimes.length, expectedRuntimes.length);
    for (const rt of expectedRuntimes) {
      assert.ok(allRuntimes.includes(rt), `allRuntimes contains ${rt}`);
    }
    assert.strictEqual(new Set(allRuntimes).size, allRuntimes.length,
      'allRuntimes has no duplicates');
  });

  test('--qoder flag selects Qoder without interactive prompt', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--qoder']), ['qoder']);
  });

  test('"All" shortcut (option 20) selects every runtime', () => {
    assert.deepStrictEqual(parseRuntimeInput('20'), allRuntimes);
  });

  test('--kimi flag selects Kimi (Python kimi-cli) without interactive prompt', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--kimi']), ['kimi']);
  });

  test('--kimi-code flag selects Kimi Code (Node CLI) without interactive prompt (#2454)', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--kimi-code']), ['kimi-code']);
  });

  test('--zcode flag selects ZCode without interactive prompt', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--zcode']), ['zcode']);
  });

  test('--pi flag selects pi without interactive prompt', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--pi']), ['pi']);
  });

  test('--all flag includes Kimi exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('kimi'), '--all includes kimi');
    assert.strictEqual(selected.filter((runtime) => runtime === 'kimi').length, 1,
      '--all includes kimi exactly once');
  });

  test('--all flag includes ZCode exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('zcode'), '--all includes zcode');
    assert.strictEqual(selected.filter((runtime) => runtime === 'zcode').length, 1,
      '--all includes zcode exactly once');
  });

  test('--all flag includes pi exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('pi'), '--all includes pi');
    assert.strictEqual(selected.filter((runtime) => runtime === 'pi').length, 1,
      '--all includes pi exactly once');
  });

  test('--all flag includes Qoder exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('qoder'), '--all includes qoder');
    assert.strictEqual(selected.filter((runtime) => runtime === 'qoder').length, 1,
      '--all includes qoder exactly once');
  });

  test('prompt lists pi (14), Qoder (15), ZCode (19), and All (20)', () => {
    const prompt = stripAnsi(buildRuntimePromptText());
    assert.ok(/\b9\)\s*Hermes Agent\b/.test(prompt),
      'prompt lists Hermes Agent as option 9');
    assert.ok(/\b10\)\s*Kimi\b/.test(prompt),
      'prompt lists Kimi as option 10');
    assert.ok(/Kimi\s+\(~\/\.config\/agents, then ~\/\.agents if existing\)/.test(prompt),
      'prompt shows the Kimi first-existing generic root policy');
    assert.ok(/\b11\)\s*Kimi Code\b/.test(prompt),
      'prompt lists Kimi Code as option 11 (#2454)');
    assert.ok(/\b14\)\s*pi\b/.test(prompt),
      'prompt lists pi as option 14');
    assert.ok(/\b15\)\s*Qoder\b/.test(prompt),
      'prompt lists Qoder as option 15');
    assert.ok(/\b16\)\s*Qwen Code\b/.test(prompt),
      'prompt lists Qwen Code as option 16');
    assert.ok(/\b17\)\s*Trae\b/.test(prompt),
      'prompt lists Trae as option 17');
    assert.ok(/\b19\)\s*ZCode\b/.test(prompt),
      'prompt lists ZCode as option 19');
    assert.ok(/\b20\)\s*All\b/.test(prompt),
      'prompt lists All as option 20');
  });

  test('prompt does not list Gemini (removed #1928)', () => {
    const prompt = stripAnsi(buildRuntimePromptText());
    assert.ok(!/Gemini/.test(prompt), 'prompt must not mention Gemini');
  });

  test('prompt text shows multi-select hint', () => {
    const prompt = stripAnsi(buildRuntimePromptText());
    assert.ok(/Select multiple/i.test(prompt),
      'prompt includes multi-select instructions');
  });

  test('parser splits on commas and whitespace and deduplicates', () => {
    // Behavioral assertion: same set of choices in different separators
    // produces the same selection, and duplicates collapse.
    assert.deepStrictEqual(
      parseRuntimeInput('1,7,9'),
      parseRuntimeInput('1 7 9'),
      'comma- and space-separated input yield identical selections'
    );
    assert.deepStrictEqual(parseRuntimeInput('1,1,7,7'), ['claude', 'copilot'],
      'duplicates collapsed in order');
  });
});
