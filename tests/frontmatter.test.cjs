/**
 * GSD Tools Tests - frontmatter.cjs
 *
 * Tests for the hand-rolled YAML parser's pure function exports:
 * extractFrontmatter, reconstructFrontmatter, spliceFrontmatter,
 * parseMustHavesBlock, and FRONTMATTER_SCHEMAS.
 *
 * Includes REG-04 regression: quoted comma inline array edge case.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  stripFrontmatter,
  parseMustHavesBlock,
} = require('../gsd-core/bin/lib/frontmatter.cjs');

// ─── extractFrontmatter ─────────────────────────────────────────────────────

describe('extractFrontmatter', () => {
  test('parses simple key-value pairs', () => {
    const content = '---\nname: foo\ntype: execute\n---\nbody';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.name, 'foo');
    assert.strictEqual(result.type, 'execute');
  });

  test('strips quotes from values', () => {
    const doubleQuoted = '---\nname: "foo"\n---\n';
    const singleQuoted = '---\nname: \'foo\'\n---\n';
    assert.strictEqual(extractFrontmatter(doubleQuoted).name, 'foo');
    assert.strictEqual(extractFrontmatter(singleQuoted).name, 'foo');
  });

  test('parses nested objects', () => {
    const content = '---\ntechstack:\n  added: prisma\n  patterns: repository\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.techstack, { added: 'prisma', patterns: 'repository' });
  });

  test('parses block arrays', () => {
    const content = '---\nitems:\n  - alpha\n  - beta\n  - gamma\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.items, ['alpha', 'beta', 'gamma']);
  });

  test('parses inline arrays', () => {
    const content = '---\nkey: [a, b, c]\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.key, ['a', 'b', 'c']);
  });

  test('handles quoted commas in inline arrays — REG-04 fixed', () => {
    const content = '---\nkey: ["a, b", c]\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.key, ['a, b', 'c']);
  });

  test('handles single-quoted commas in inline arrays', () => {
    const content = "---\nkey: ['x, y', z]\n---\n";
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.key, ['x, y', 'z']);
  });

  test('handles mixed quotes in inline arrays', () => {
    const content = '---\nkey: ["a, b", \'c, d\', e]\n---\n';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result.key, ['a, b', 'c, d', 'e']);
  });

  test('returns empty object for no frontmatter', () => {
    const content = 'Just plain content, no frontmatter.';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result, {});
  });

  test('returns empty object for empty frontmatter', () => {
    const content = '---\n---\nBody text.';
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result, {});
  });

  test('parses frontmatter-only content', () => {
    const content = '---\nkey: val\n---';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.key, 'val');
  });

  test('handles emoji and non-ASCII in values', () => {
    const content = '---\nname: "Hello World"\nlabel: "cafe"\n---\n';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.name, 'Hello World');
    assert.strictEqual(result.label, 'cafe');
  });

  test('converts empty-object placeholders to arrays when dash items follow', () => {
    // When a key has no value, it gets an empty {} placeholder.
    // When "- item" lines follow, the parser converts {} to [].
    const content = '---\nrequirements:\n  - REQ-01\n  - REQ-02\n---\n';
    const result = extractFrontmatter(content);
    assert.ok(Array.isArray(result.requirements), 'should convert placeholder object to array');
    assert.deepStrictEqual(result.requirements, ['REQ-01', 'REQ-02']);
  });

  test('skips empty lines in YAML body', () => {
    const content = '---\nfirst: one\n\nsecond: two\n\nthird: three\n---\n';
    const result = extractFrontmatter(content);
    assert.strictEqual(result.first, 'one');
    assert.strictEqual(result.second, 'two');
    assert.strictEqual(result.third, 'three');
  });

  // ─── Bug #2130: body --- sequence mis-parse ──────────────────────────────

  test('#2130: frontmatter at top with YAML example block in body — returns top frontmatter', () => {
    const content = [
      '---',
      'name: my-agent',
      'type: execute',
      '---',
      '',
      '# Documentation',
      '',
      'Here is a YAML example:',
      '',
      '```yaml',
      '---',
      'key: value',
      'other: stuff',
      '---',
      '```',
      '',
      'End of doc.',
    ].join('\n');
    const result = extractFrontmatter(content);
    assert.strictEqual(result.name, 'my-agent', 'should extract name from TOP frontmatter');
    assert.strictEqual(result.type, 'execute', 'should extract type from TOP frontmatter');
    assert.strictEqual(result.key, undefined, 'should NOT extract key from body YAML block');
    assert.strictEqual(result.other, undefined, 'should NOT extract other from body YAML block');
  });

  test('#2130: frontmatter at top with horizontal rules in body — returns top frontmatter', () => {
    const content = [
      '---',
      'title: My Doc',
      'status: active',
      '---',
      '',
      '# Section One',
      '',
      'Some text.',
      '',
      '---',
      '',
      '# Section Two',
      '',
      'More text.',
      '',
      '---',
      '',
      '# Section Three',
    ].join('\n');
    const result = extractFrontmatter(content);
    assert.strictEqual(result.title, 'My Doc', 'should extract title from TOP frontmatter');
    assert.strictEqual(result.status, 'active', 'should extract status from TOP frontmatter');
  });

  test('#2130: body-only --- block with no frontmatter at byte 0 — returns empty', () => {
    const content = [
      '# My Document',
      '',
      'Some intro text.',
      '',
      '---',
      'key: value',
      'other: stuff',
      '---',
      '',
      'End of doc.',
    ].join('\n');
    const result = extractFrontmatter(content);
    assert.deepStrictEqual(result, {}, 'should return empty object when --- block is not at byte 0');
  });

  test('#2130: valid frontmatter at byte 0 still works (regression guard)', () => {
    const content = [
      '---',
      'phase: 01',
      'plan: 03',
      'type: execute',
      'wave: 1',
      'depends_on: ["01-01", "01-02"]',
      'files_modified:',
      '  - src/auth.ts',
      '  - src/middleware.ts',
      'autonomous: true',
      '---',
      '',
      '# Plan body here',
    ].join('\n');
    const result = extractFrontmatter(content);
    assert.strictEqual(result.phase, '01');
    assert.strictEqual(result.plan, '03');
    assert.strictEqual(result.type, 'execute');
    assert.strictEqual(result.wave, '1');
    assert.deepStrictEqual(result.depends_on, ['01-01', '01-02']);
    assert.deepStrictEqual(result.files_modified, ['src/auth.ts', 'src/middleware.ts']);
    assert.strictEqual(result.autonomous, 'true');
  });
});

// ─── reconstructFrontmatter ─────────────────────────────────────────────────

describe('reconstructFrontmatter', () => {
  test('serializes simple key-value', () => {
    const result = reconstructFrontmatter({ name: 'foo' });
    assert.strictEqual(result, 'name: foo');
  });

  test('serializes empty array as inline []', () => {
    const result = reconstructFrontmatter({ items: [] });
    assert.strictEqual(result, 'items: []');
  });

  test('serializes short string arrays inline', () => {
    const result = reconstructFrontmatter({ key: ['a', 'b', 'c'] });
    assert.strictEqual(result, 'key: [a, b, c]');
  });

  test('serializes long arrays as block', () => {
    const result = reconstructFrontmatter({ key: ['one', 'two', 'three', 'four'] });
    assert.ok(result.includes('key:'), 'should have key header');
    assert.ok(result.includes('  - one'), 'should have block array items');
    assert.ok(result.includes('  - four'), 'should have last item');
  });

  test('quotes values containing colons or hashes', () => {
    const result = reconstructFrontmatter({ url: 'http://example.com' });
    assert.ok(result.includes('"http://example.com"'), 'should quote value with colon');

    const hashResult = reconstructFrontmatter({ comment: 'value # note' });
    assert.ok(hashResult.includes('"value # note"'), 'should quote value with hash');
  });

  test('serializes nested objects with proper indentation', () => {
    const result = reconstructFrontmatter({ tech: { added: 'prisma', patterns: 'repo' } });
    assert.ok(result.includes('tech:'), 'should have parent key');
    assert.ok(result.includes('  added: prisma'), 'should have indented child');
    assert.ok(result.includes('  patterns: repo'), 'should have indented child');
  });

  test('serializes nested arrays within objects', () => {
    const result = reconstructFrontmatter({
      tech: { added: ['prisma', 'jose'] },
    });
    assert.ok(result.includes('tech:'), 'should have parent key');
    assert.ok(result.includes('  added: [prisma, jose]'), 'should serialize nested short array inline');
  });

  test('skips null and undefined values', () => {
    const result = reconstructFrontmatter({ name: 'foo', skip: null, also: undefined, keep: 'bar' });
    assert.ok(!result.includes('skip'), 'should not include null key');
    assert.ok(!result.includes('also'), 'should not include undefined key');
    assert.ok(result.includes('name: foo'), 'should include non-null key');
    assert.ok(result.includes('keep: bar'), 'should include non-null key');
  });

  test('round-trip: simple frontmatter', () => {
    const original = '---\nname: test\ntype: execute\nwave: 1\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve data identity');
  });

  test('round-trip: nested with arrays', () => {
    const original = '---\nphase: 01\ntech:\n  added:\n    - prisma\n    - jose\n  patterns:\n    - repository\n    - jwt\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve nested structures');
  });

  test('round-trip: multiple data types', () => {
    const original = '---\nname: testplan\nwave: 2\ntags: [auth, api, db]\ndeps:\n  - dep1\n  - dep2\nconfig:\n  enabled: true\n  count: 5\n---\n';
    const extracted1 = extractFrontmatter(original);
    const reconstructed = reconstructFrontmatter(extracted1);
    const roundTrip = `---\n${reconstructed}\n---\n`;
    const extracted2 = extractFrontmatter(roundTrip);
    assert.deepStrictEqual(extracted2, extracted1, 'round-trip should preserve multiple data types');
  });
});

// ─── spliceFrontmatter ──────────────────────────────────────────────────────

describe('spliceFrontmatter', () => {
  test('replaces existing frontmatter preserving body', () => {
    const content = '---\nphase: 01\ntype: execute\n---\n\n# Body Content\n\nParagraph here.';
    const newObj = { phase: '02', type: 'tdd', wave: '1' };
    const result = spliceFrontmatter(content, newObj);

    // New frontmatter should be present
    const extracted = extractFrontmatter(result);
    assert.strictEqual(extracted.phase, '02');
    assert.strictEqual(extracted.type, 'tdd');
    assert.strictEqual(extracted.wave, '1');

    // Body should be preserved
    assert.ok(result.includes('# Body Content'), 'body heading should be preserved');
    assert.ok(result.includes('Paragraph here.'), 'body paragraph should be preserved');
  });

  test('adds frontmatter to content without any', () => {
    const content = 'Plain text with no frontmatter.';
    const newObj = { phase: '01', plan: '01' };
    const result = spliceFrontmatter(content, newObj);

    // Should start with frontmatter delimiters
    assert.ok(result.startsWith('---\n'), 'should start with opening delimiter');
    assert.ok(result.includes('\n---\n'), 'should have closing delimiter');

    // Original content should follow
    assert.ok(result.includes('Plain text with no frontmatter.'), 'original content should be preserved');

    // Frontmatter should be extractable
    const extracted = extractFrontmatter(result);
    assert.strictEqual(extracted.phase, '01');
    assert.strictEqual(extracted.plan, '01');
  });

  test('preserves content after frontmatter delimiters exactly', () => {
    const body = '\n\nExact content with special chars: $, %, &, <, >\nLine 2\nLine 3';
    const content = '---\nold: value\n---' + body;
    const newObj = { new: 'value' };
    const result = spliceFrontmatter(content, newObj);

    // The body after the closing --- should be exactly preserved
    const closingIdx = result.indexOf('\n---', 4); // skip the opening ---
    const resultBody = result.slice(closingIdx + 4); // skip \n---
    assert.strictEqual(resultBody, body, 'body content after frontmatter should be exactly preserved');
  });
});

// ─── parseMustHavesBlock ────────────────────────────────────────────────────

describe('parseMustHavesBlock', () => {
  test('extracts truths as string array', () => {
    const content = `---
phase: 01
must_haves:
    truths:
      - "All tests pass on CI"
      - "Coverage exceeds 80%"
---

Body content.`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], 'All tests pass on CI');
    assert.strictEqual(result[1], 'Coverage exceeds 80%');
  });

  test('trims a continuation-KV value so a quoted trailing space does not survive (#1905, root cause of the #1154 false-pass)', () => {
    // A quoted value like `"backstop "` captures the inner trailing space in group 2; left untrimmed,
    // a hand-authored non-inferable `backstop` marker (#1820 spec-optional rail) degrades to `'backstop '`,
    // which `truthVerification` no longer recognizes → the truth silently grades green instead of abstaining.
    // Whitespace is never semantic in a scalar KV value, so the parser must trim it.
    const content = `---
must_haves:
  truths:
    - statement: user data is never logged
      verification: "backstop "
---
Body.`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.strictEqual(result[0].verification, 'backstop', 'the captured value is trimmed, not left as "backstop "');
  });

  test('extracts artifacts as object array', () => {
    const content = `---
phase: 01
must_haves:
    artifacts:
      - path: "src/auth.ts"
        provides: "JWT authentication"
        min_lines: 100
      - path: "src/middleware.ts"
        provides: "Route protection"
        min_lines: 50
---

Body.`;
    const result = parseMustHavesBlock(content, 'artifacts');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].path, 'src/auth.ts');
    assert.strictEqual(result[0].provides, 'JWT authentication');
    assert.strictEqual(result[0].min_lines, 100);
    assert.strictEqual(result[1].path, 'src/middleware.ts');
    assert.strictEqual(result[1].min_lines, 50);
  });

  test('extracts key_links with from/to/via/pattern fields', () => {
    const content = `---
phase: 01
must_haves:
    key_links:
      - from: "tests/auth.test.ts"
        to: "src/auth.ts"
        via: "import statement"
        pattern: "import.*auth"
---
`;
    const result = parseMustHavesBlock(content, 'key_links');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].from, 'tests/auth.test.ts');
    assert.strictEqual(result[0].to, 'src/auth.ts');
    assert.strictEqual(result[0].via, 'import statement');
    assert.strictEqual(result[0].pattern, 'import.*auth');
  });

  test('returns empty array when block not found', () => {
    const content = `---
phase: 01
must_haves:
    truths:
      - "Some truth"
---
`;
    const result = parseMustHavesBlock(content, 'nonexistent_block');
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array when no frontmatter', () => {
    const content = 'Plain text without any frontmatter delimiters.';
    const result = parseMustHavesBlock(content, 'truths');
    assert.deepStrictEqual(result, []);
  });

  test('parses key_links with 2-space indentation — issue #1356', () => {
    // Real-world YAML uses 2-space indentation, not 4-space.
    // The parser was hardcoded to expect 4-space indentation which caused
    // "No must_haves.key_links found in frontmatter" for valid YAML.
    const content = `---
phase: 01-conversion-engine-iva-correctness
plan: 02
type: execute
wave: 2
depends_on: ["01-01"]
files_modified:
  - src/features/currency/exchange-rate-store.ts
  - src/features/currency/use-currency-config.ts
autonomous: true
requirements:
  - CONV-02
  - CONV-03

must_haves:
  truths:
    - "All tests pass"
  artifacts:
    - path: "src/features/currency/use-currency-config.ts"
  key_links:
    - from: "src/features/currency/use-currency-config.ts"
      to: "src/api/generated/company-config/company-config.ts"
      via: "getCompanyConfigControllerFindAllQueryOptions"
      pattern: "getCompanyConfigControllerFindAllQueryOptions"
    - from: "src/features/currency/use-currency-config.ts"
      to: "src/features/currency/exchange-rate-store.ts"
      via: "useExchangeRateStore for MMKV persist"
      pattern: "useExchangeRateStore"
---

# Plan body
`;
    const result = parseMustHavesBlock(content, 'key_links');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2, `expected 2 key_links, got ${result.length}: ${JSON.stringify(result)}`);
    assert.strictEqual(result[0].from, 'src/features/currency/use-currency-config.ts');
    assert.strictEqual(result[0].to, 'src/api/generated/company-config/company-config.ts');
    assert.strictEqual(result[0].via, 'getCompanyConfigControllerFindAllQueryOptions');
    assert.strictEqual(result[0].pattern, 'getCompanyConfigControllerFindAllQueryOptions');
    assert.strictEqual(result[1].from, 'src/features/currency/use-currency-config.ts');
    assert.strictEqual(result[1].to, 'src/features/currency/exchange-rate-store.ts');
    assert.strictEqual(result[1].via, 'useExchangeRateStore for MMKV persist');
    assert.strictEqual(result[1].pattern, 'useExchangeRateStore');
  });

  test('parses truths with 2-space indentation — issue #1356', () => {
    const content = `---
phase: 01
must_haves:
  truths:
    - "All tests pass on CI"
    - "Coverage exceeds 80%"
---
`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], 'All tests pass on CI');
    assert.strictEqual(result[1], 'Coverage exceeds 80%');
  });

  test('parses artifacts with 2-space indentation — issue #1356', () => {
    const content = `---
phase: 01
must_haves:
  artifacts:
    - path: "src/auth.ts"
      provides: "JWT authentication"
      min_lines: 100
---
`;
    const result = parseMustHavesBlock(content, 'artifacts');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, 'src/auth.ts');
    assert.strictEqual(result[0].provides, 'JWT authentication');
    assert.strictEqual(result[0].min_lines, 100);
  });

  test('#2734: quoted truth containing ":" is preserved as a string — not dropped', () => {
    // When a dash-item is a fully-quoted string that contains ':', the old code
    // fell into the key-value branch, failed the kvMatch regex (because the value
    // started with '"'), and silently left current as {}, losing the string.
    const content = `---
phase: 01
must_haves:
  truths:
    - "App-side UUIDv4: generated locally"
    - "No colon in this one"
    - "Another colon: example"
---
`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 3, `expected 3 truths, got ${result.length}: ${JSON.stringify(result)}`);
    assert.strictEqual(result[0], 'App-side UUIDv4: generated locally');
    assert.strictEqual(result[1], 'No colon in this one');
    assert.strictEqual(result[2], 'Another colon: example');
  });

  test('#2734: single-quoted truth containing ":" is preserved as a string', () => {
    const content = `---
phase: 01
must_haves:
  truths:
    - 'Key: value pattern preserved'
---
`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], 'Key: value pattern preserved');
  });

  test('#2757: unquoted truth containing ":" is preserved as a string — not left as {}', () => {
    // Unquoted strings with colons (e.g. Rails idioms) were falling through the KV
    // regex and leaving current as {}, which caused t.trim() to throw in roadmap.cjs.
    const content = `---
phase: 01
must_haves:
  truths:
    - GET /foo/:id resolves to controller#show
    - Service.call(arg:, key:) returns a record
    - Class::Method is idempotent
---
`;
    const result = parseMustHavesBlock(content, 'truths');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 3, `expected 3, got ${result.length}: ${JSON.stringify(result)}`);
    assert.ok(typeof result[0] === 'string', `result[0] should be string, got ${typeof result[0]}`);
    assert.ok(typeof result[1] === 'string', `result[1] should be string, got ${typeof result[1]}`);
    assert.ok(typeof result[2] === 'string', `result[2] should be string, got ${typeof result[2]}`);
    assert.ok(result[0].includes(':'), 'colon should be preserved in the string');
  });

  test('handles nested arrays within artifact objects', () => {
    const content = `---
phase: 01
must_haves:
    artifacts:
      - path: "src/api.ts"
        provides: "REST endpoints"
        exports:
          - "GET"
          - "POST"
---
`;
    const result = parseMustHavesBlock(content, 'artifacts');
    assert.ok(Array.isArray(result), 'should return an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, 'src/api.ts');
    // The nested array should be captured
    assert.ok(result[0].exports !== undefined, 'should have exports field');
  });
});

// ─── stripFrontmatter ───────────────────────────────────────────────────────
// #2143 audit dedup: stripFrontmatter was byte-identically duplicated in both
// state.cts and state-transition.cts. Both call sites now import this single
// canonical implementation from frontmatter.cts.

describe('stripFrontmatter', () => {
  test('strips a single frontmatter block, leaving the body', () => {
    const content = '---\nname: foo\ntype: execute\n---\nBody text.\n';
    assert.strictEqual(stripFrontmatter(content), 'Body text.\n');
  });

  test('returns content unchanged when no frontmatter is present', () => {
    const content = '# Just a heading\n\nSome body text.\n';
    assert.strictEqual(stripFrontmatter(content), content);
  });

  test('handles CRLF line endings', () => {
    const content = '---\r\nname: foo\r\n---\r\nBody text.\r\n';
    assert.strictEqual(stripFrontmatter(content), 'Body text.\r\n');
  });

  test('greedily strips multiple stacked frontmatter blocks (corruption recovery)', () => {
    const content = '---\nname: foo\n---\n---\nname: bar\n---\nBody text.\n';
    assert.strictEqual(stripFrontmatter(content), 'Body text.\n');
  });

  test('leaves a body-only "---" horizontal rule (not at byte 0) untouched', () => {
    const content = 'Body text.\n\n---\n\nMore text.\n';
    assert.strictEqual(stripFrontmatter(content), content);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1695-state-patch-clobbers-phase-name.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1695-state-patch-clobbers-phase-name (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// Regression test for issue #1695 — `state patch` of an unrelated field clobbers
// the curated `current_phase_name` frontmatter scalar.
//
// Root cause: readModifyWriteStateMd({resync:false}) still runs syncStateFrontmatter,
// which re-derives EVERY body-derived scalar from body prose. The #1264 restore
// covers `progress` only and #1230 covers `status`/`stopped_at`; `current_phase_name`
// was left exposed, and parseProsePhaseField's paren-over-dash preference made the
// re-derived value wrong (harvesting a parenthetical aside as the phase name).
//
// ADR-1769 Phase 6 fix: extend the #1230 delta heuristic to current_phase_name
// (gated by the field-classification table's preserve-always row). When the
// transform did NOT change the body Current Phase / Phase source line, the curated
// frontmatter value wins.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

function buildStateWithCuratedPhaseName({ phaseName = 'Native Global Hotkey', aside = 'next; Phase 15 landed, UAT deferred' } = {}) {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Test',
    'current_phase: "16"',
    `current_phase_name: "${phaseName}"`,
    'status: executing',
    'progress:',
    '  total_phases: 20',
    '  completed_phases: 15',
    '  total_plans: 40',
    '  completed_plans: 30',
    '  percent: 75',
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 16',
    'Total Plans in Phase: 4',
    'Current Plan: 2',
    'Status: Executing Phase 16',
    'Last Activity: 2026-06-20',
    '',
    '## Current Position',
    '',
    `Phase: 16 — ${phaseName} (${aside})`,
    'Plan: 2 of 4',
    'Status: Executing Phase 16',
    'Last activity: 2026-06-20 — mid-flight',
    '',
  ].join('\n');
}

function readFm(statePath) {
  return extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
}

describe('#1695: state patch of an unrelated field preserves curated current_phase_name', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('patching Status does NOT clobber the curated current_phase_name', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Paused for review' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    assert.strictEqual(
      fm.current_phase_name,
      'Native Global Hotkey',
      `current_phase_name must be preserved on an unrelated patch; got ${JSON.stringify(fm.current_phase_name)} (the paren-over-dash re-derivation clobbered it — #1695)`,
    );
  });

  test('patching Current Plan does NOT clobber the curated current_phase_name', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ 'Current Plan': '3' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    assert.strictEqual(fm.current_phase_name, 'Native Global Hotkey');
  });

  test('explicitly patching the body Phase name-source line still advances (delta does not over-pin)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    // Patching the body 'Phase' field (the parseProsePhaseField source for
    // current_phase_name) changes the source line, so the #1230 delta must NOT
    // fire — syncStateFrontmatter re-derives current_phase_name from the new line.
    // (Acceptance criterion from #1743: the guard must not pin a scalar whose body
    // source genuinely changed.)
    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ Phase: '17 — Brand New Phase Name' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    // current_phase_name should be re-derived from the new body 'Phase' line
    // (not pinned to the old curated value).
    assert.notStrictEqual(fm.current_phase_name, 'Native Global Hotkey',
      `current_phase_name must advance when the body Phase source changed; got ${JSON.stringify(fm.current_phase_name)}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2770-annotate-deps-int-coerce.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2770-annotate-deps-int-coerce (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2770)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Regression — issue #2770
 *
 * `roadmap.annotate-dependencies` crashes with
 * `TypeError: t.trim is not a function` when must_haves.truths contains a
 * non-string scalar (e.g., a YAML int like `- 3` interpreted by an upstream
 * parser as a number, or a kv-shaped item whose value is numeric).
 *
 * The original guard `if (typeof t !== 'string') continue` skipped silently —
 * which avoids the crash but **drops the constraint from cross-cutting
 * analysis**. The required behaviour is to **coerce, not skip**: a numeric
 * scalar `3` must be surfaced as the string "3", and a kv-shaped truth like
 * `{ title: "X", count: 3 }` must contribute its title to the analysis.
 *
 * The two literal cases called out in the issue title (bare-int `depends_on`
 * values) are also exercised here as regression guards on the frontmatter
 * parser to prove the dependency is preserved as a string and never dropped.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

function makePlanProject(files = {}) {
  const dir = createTempProject();
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '');
  fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

const ROADMAP = [
  '# Roadmap',
  '',
  '### Phase 1: Foundation',
  '**Goal:** Set up project',
  '**Plans:** 2 plans',
  '',
  'Plans:',
  '- [ ] 01-01-PLAN.md — Set up DB',
  '- [ ] 01-02-PLAN.md — Build API',
  '',
].join('\n');

// PLAN where must_haves.truths includes a bare numeric scalar AND a kv-shaped
// item whose value is numeric — both must be surfaced as cross-cutting
// constraints when shared across plans, not silently dropped.
const PLAN_NUMERIC_TRUTH = (wave, sharedTitle) => [
  '---',
  'phase: "1"',
  `plan: "01-0${wave}"`,
  'type: standard',
  `wave: ${wave}`,
  'depends_on: []',
  'files_modified: []',
  'autonomous: true',
  'must_haves:',
  '  truths:',
  `    - title: ${sharedTitle}`,
  '      count: 3',
  '    - 42',
  '  artifacts: []',
  '  key_links: []',
  '---',
  '',
  `<objective>Plan ${wave}</objective>`,
  '',
].join('\n');

describe('bug #2770 — non-string truths must be coerced, not dropped', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('numeric scalar truth shared across 2+ plans is surfaced as cross-cutting constraint', () => {
    // Both plans share the numeric truth `42`. Pre-fix: silently dropped by
    // `typeof t !== 'string' continue`, so cross_cutting_constraints == 0.
    // Post-fix: coerced to "42" and surfaced as a constraint.
    const PLAN_BARE_INT_TRUTH = (wave) => [
      '---',
      'phase: "1"',
      `plan: "01-0${wave}"`,
      'type: standard',
      `wave: ${wave}`,
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - 42',
      '  artifacts: []',
      '  key_links: []',
      '---',
      '',
      `<objective>Plan ${wave}</objective>`,
      '',
    ].join('\n');
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': ROADMAP,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_BARE_INT_TRUTH(1),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_BARE_INT_TRUTH(2),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.cross_cutting_constraints,
      1,
      'numeric truth shared across plans must be surfaced (coerced), not dropped'
    );

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Cross-cutting constraints:'),
      'cross-cutting subsection present');
    assert.ok(/-\s*42\b/.test(roadmap),
      'numeric truth "42" surfaced as a string in the roadmap');
  });

  test('kv-shaped truth with numeric value uses title and contributes to cross-cutting analysis', () => {
    // Both plans share `{ title: 'shared-rule', count: 3 }`. Pre-fix:
    // typeof === 'object' so silently skipped → constraint dropped.
    // Post-fix: title extracted, surfaced in cross-cutting subsection.
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': ROADMAP,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_NUMERIC_TRUTH(1, 'shared-rule'),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_NUMERIC_TRUTH(2, 'shared-rule'),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    // Both plans share two truths: the kv-shaped { title: 'shared-rule', ... }
    // and the bare numeric 42. Pre-fix neither would survive the typeof guard;
    // post-fix both are coerced and surfaced.
    assert.strictEqual(
      out.cross_cutting_constraints,
      2,
      'kv-shaped truth and numeric truth both surface, not dropped'
    );

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('shared-rule'),
      'title from kv-shaped truth surfaced in cross-cutting list');
    assert.ok(/-\s*42\b/.test(roadmap),
      'numeric truth surfaced as a string');
  });
});

describe('bug #2770 — bare-int depends_on values parse as preserved strings', () => {
  test('scalar bare-int depends_on parses as string "3" (not dropped, not numeric)', () => {
    // Per issue title: a YAML scalar `depends_on: 3` must be preserved as the
    // string "3". The frontmatter parser already returns strings here; this
    // test pins the behaviour so a future "convert YAML scalars to numbers"
    // optimization cannot silently regress dependency tracking.
    const fm = extractFrontmatter([
      '---',
      'phase: "1"',
      'plan: "01"',
      'depends_on: 3',
      '---',
      'body',
      '',
    ].join('\n'));
    assert.strictEqual(typeof fm.depends_on, 'string',
      'scalar depends_on must remain a string after parse');
    assert.strictEqual(fm.depends_on, '3',
      'bare int 3 must be preserved as the string "3"');
  });

  test('inline-array bare-int depends_on parses to ["3","4"] (preserved as strings)', () => {
    const fm = extractFrontmatter([
      '---',
      'phase: "1"',
      'plan: "01"',
      'depends_on: [3, 4]',
      '---',
      'body',
      '',
    ].join('\n'));
    assert.ok(Array.isArray(fm.depends_on),
      'inline array depends_on must be an array');
    assert.deepStrictEqual(fm.depends_on, ['3', '4'],
      'bare ints in inline array must be preserved as strings — never dropped');
    // Critical: assert *length* matches input. A naive `if (typeof !== string) continue`
    // would silently drop entries; we must coerce, not skip.
    assert.strictEqual(fm.depends_on.length, 2,
      'no dependency may be silently dropped during coercion');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3242-state-update-progress-trample.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3242-state-update-progress-trample (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// Regression tests for issue #3242 — two distinct bugs in state.cjs:
//
// Bug A: cmdStateUpdate("Last Activity", date) triggers a full disk-derived
// progress.* block rebuild via readModifyWriteStateMd → syncStateFrontmatter →
// buildStateFrontmatter, which tramples manually-curated cross-milestone counters
// in STATE.md frontmatter. A body-only field update must not modify progress.*.
//
// Bug B: buildStateFrontmatter (and the duplicate in cmdStateSync) derives
// progress.percent = completedPlans / totalPlans. When ROADMAP declares more
// phases than have dirs on disk, all plans being summarised gives percent: 100
// even though half the phases are unrealised. The formula must be
// min(plan_fraction, phase_fraction) to reflect true completion.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal STATE.md body with frontmatter that has curated progress.*.
 * The progress values are cross-milestone aggregates that must NOT be overwritten
 * by a body-only field update.
 */
function buildStateWithCuratedProgress(opts) {
  const {
    completedPlans = 22,
    totalPlans = 22,
    completedPhases = 6,
    totalPhases = 12,
    percent = 50,
    lastActivity = '2026-01-01',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: executing',
    'progress:',
    `  total_phases: ${totalPhases}`,
    `  completed_phases: ${completedPhases}`,
    `  total_plans: ${totalPlans}`,
    `  completed_plans: ${completedPlans}`,
    `  percent: ${percent}`,
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 6',
    'Current Phase Name: test-phase',
    'Total Plans in Phase: 4',
    'Current Plan: 1',
    'Status: Executing Phase 6',
    `Last Activity: ${lastActivity}`,
    '',
  ].join('\n');
}

/**
 * Write a ROADMAP.md with `numPhases` phase headings (matching `## Phase N:` pattern).
 * Only `numRealizedDirs` phase dirs will have plan/summary files on disk.
 */
function buildRoadmap(numPhases) {
  const lines = ['# ROADMAP', '', '## Milestone v1.0', ''];
  for (let i = 1; i <= numPhases; i++) {
    lines.push(`### Phase ${i}: phase-${i}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Create phase dirs with full plan+summary coverage for the first `count` phases.
 * Each dir gets 1 PLAN + 1 SUMMARY so the disk-scan treats them as complete.
 */
function createPhaseDirs(phasesDir, count) {
  for (let i = 1; i <= count; i++) {
    const dir = path.join(phasesDir, String(i).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `01-PLAN.md`), `# Plan\n`);
    fs.writeFileSync(path.join(dir, `01-SUMMARY.md`), `# Summary\n`);
  }
}

function createPhasePlanOnlyDirs(phasesDir, count) {
  for (let i = 1; i <= count; i++) {
    const dir = path.join(phasesDir, String(i).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `01-PLAN.md`), `# Plan\n`);
  }
}

function readPersistedProgress(statePath) {
  const fm = extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
  assert.ok(fm.progress, 'persisted frontmatter must have a progress block');
  return Object.fromEntries(
    Object.entries(fm.progress).map(([key, value]) => [key, Number(value)]),
  );
}

function assertProgressEquals(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(
      actual[key],
      value,
      `persisted progress.${key} expected ${value}, got ${actual[key]}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug A: state.update must not trample curated progress.* frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('#3242 Bug A: body-only state.update preserves curated progress frontmatter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state.update "Last Activity" does not overwrite progress.completed_plans', (_t) => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedProgress({
      completedPlans: 22,
      totalPlans: 22,
      completedPhases: 6,
      totalPhases: 12,
      percent: 50,
      lastActivity: '2026-01-01',
    }));

    // Write 6 phase dirs with full coverage — disk would report 6/6 phases done,
    // 6/6 plans done (percent=100 from plans-only formula), but frontmatter says 50%.
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    createPhaseDirs(phasesDir, 6);

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-05-07'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    // Read back and assert via state json (JSON return value, not raw file grep)
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must have a progress block');

    // completed_plans must NOT have been trampled to 6 (disk reality) from the
    // curated 22 that was stored in the frontmatter before the update.
    assert.strictEqual(
      fm.progress.completed_plans,
      22,
      `state.update "Last Activity" must not overwrite curated progress.completed_plans ` +
      `(was 22, got ${fm.progress.completed_plans})`,
    );

    // total_phases must NOT have been trampled to 6 (disk dirs) from curated 12.
    assert.strictEqual(
      fm.progress.total_phases,
      12,
      `state.update "Last Activity" must not overwrite curated progress.total_phases ` +
      `(was 12, got ${fm.progress.total_phases})`,
    );

    // percent must NOT have been trampled to 100 (plan-only formula on 6 realized dirs).
    assert.strictEqual(
      fm.progress.percent,
      50,
      `state.update "Last Activity" must not overwrite curated progress.percent ` +
      `(was 50, got ${fm.progress.percent})`,
    );
  });

  test('state.update "Last Activity" updates the body field itself', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedProgress({ lastActivity: '2026-01-01' }));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-05-07'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    // Assert via structured JSON output — not raw file text scanning.
    // state json extracts Last Activity from the body and surfaces it as
    // fm.last_activity, matching the no-source-grep testing standard.
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.last_activity,
      '2026-05-07',
      'state.update should have written the new date to the Last Activity body field',
    );
  });

  test('state.update "Progress" resyncs progress frontmatter from the updated body', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedProgress({
      completedPlans: 22,
      totalPlans: 22,
      completedPhases: 6,
      totalPhases: 12,
      percent: 50,
    }).replace('Last Activity: 2026-01-01\n', 'Last Activity: 2026-01-01\nProgress: [█████░░░░░] 50%\n'));

    const updateResult = runGsdTools(
      ['state', 'update', 'Progress', '[████████░░] 80%'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(fm.progress.percent, 80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1264: state.patch must apply the same progress preservation policy
// ─────────────────────────────────────────────────────────────────────────────

describe('#1264: state.patch preserves curated progress frontmatter for non-progress fields', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('query state.patch of Current Phase preserves persisted progress.* values', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const curatedProgress = {
      total_phases: 4,
      completed_phases: 3,
      total_plans: 11,
      completed_plans: 11,
      percent: 75,
    };
    fs.writeFileSync(statePath, buildStateWithCuratedProgress({
      completedPlans: curatedProgress.completed_plans,
      totalPlans: curatedProgress.total_plans,
      completedPhases: curatedProgress.completed_phases,
      totalPhases: curatedProgress.total_phases,
      percent: curatedProgress.percent,
    }));

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      buildRoadmap(5),
    );
    createPhasePlanOnlyDirs(path.join(tmpDir, '.planning', 'phases'), 5);

    const patchResult = runGsdTools([
      'query',
      'state.patch',
      JSON.stringify({ 'Current Phase': '08.2' }),
    ], tmpDir);
    assert.ok(patchResult.success, `state patch failed: ${patchResult.error}`);

    const output = JSON.parse(patchResult.output);
    assert.deepEqual(output.updated, ['Current Phase']);

    const progress = readPersistedProgress(statePath);
    assertProgressEquals(progress, curatedProgress);
  });

  test('query state.patch of Total Plans in Phase still resyncs persisted progress.* from the updated body', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedProgress({
      completedPlans: 22,
      totalPlans: 22,
      completedPhases: 6,
      totalPhases: 12,
      percent: 50,
    }));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      buildRoadmap(8),
    );
    createPhasePlanOnlyDirs(path.join(tmpDir, '.planning', 'phases'), 8);

    const patchResult = runGsdTools([
      'query',
      'state.patch',
      JSON.stringify({ 'Total Plans in Phase': '8' }),
    ], tmpDir);
    assert.ok(patchResult.success, `state patch failed: ${patchResult.error}`);

    const output = JSON.parse(patchResult.output);
    assert.deepEqual(output.updated, ['Total Plans in Phase']);

    const progress = readPersistedProgress(statePath);
    assert.strictEqual(progress.total_plans, 8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug B: progress.percent must use min(plan_fraction, phase_fraction)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3242 Bug B: progress.percent reflects phase fraction when ROADMAP declares future phases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('12 declared phases / 6 realized / 6/6 plans done → percent is 50, not 100', (_t) => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');

    // Body: 6 realized phases visible to disk scan.
    // Frontmatter: intentionally absent so buildStateFrontmatter runs fresh.
    fs.writeFileSync(statePath, [
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 6',
      'Current Phase Name: test-phase-6',
      'Total Plans in Phase: 1',
      'Current Plan: 1',
      'Status: Executing Phase 6',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n'));

    // ROADMAP with 12 phase headings — only 6 will have dirs on disk
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      buildRoadmap(12),
    );

    // 6 fully-realized phases (all plans have summaries)
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    createPhaseDirs(phasesDir, 6);

    // state json rebuilds frontmatter from disk+body — this exercises buildStateFrontmatter
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must have a progress block');

    // ROADMAP declares 12 phases; only 6 exist on disk → totalPhases = 12
    assert.strictEqual(
      fm.progress.total_phases,
      12,
      `total_phases must reflect ROADMAP-declared count (12), got ${fm.progress.total_phases}`,
    );

    // 6 of 12 phases realized → phase_fraction = 50%
    // 6/6 plans done → plan_fraction = 100%
    // percent = min(100, 50) = 50
    assert.strictEqual(
      fm.progress.percent,
      50,
      `percent must be 50 (phase fraction), not 100 (plan fraction) — ` +
      `6 of 12 ROADMAP phases realized. Got ${fm.progress.percent}`,
    );
  });

  test('all phases realized: percent equals plan fraction (no artificial cap)', (_t) => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');

    fs.writeFileSync(statePath, [
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 3',
      'Current Phase Name: final-phase',
      'Total Plans in Phase: 1',
      'Current Plan: 1',
      'Status: Executing Phase 3',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n'));

    // ROADMAP declares 3 phases; all 3 have dirs and full plan+summary coverage
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      buildRoadmap(3),
    );

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    createPhaseDirs(phasesDir, 3);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must have progress block');

    // 3/3 phases done → phase_fraction = 100%
    // 3/3 plans done → plan_fraction = 100%
    // percent = min(100, 100) = 100
    assert.strictEqual(
      fm.progress.percent,
      100,
      `percent must be 100 when all phases are realized and all plans summarized`,
    );
  });

  test('state sync also reflects phase-fraction-capped percent in body Progress field', () => {
    // state sync updates the body's Progress: field — it must use the same capped formula
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');

    fs.writeFileSync(statePath, [
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 6',
      'Current Phase Name: phase-6',
      'Total Plans in Phase: 1',
      'Current Plan: 1',
      'Status: Executing Phase 6',
      'Last Activity: 2026-01-01',
      'Progress: [░░░░░░░░░░] 0%',
      '',
    ].join('\n'));

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      buildRoadmap(12),
    );

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    createPhaseDirs(phasesDir, 6);

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Read the body's Progress field via state json (JSON output is authoritative)
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must have progress block');

    // state sync wrote a Progress: body field; state json re-derives percent from disk.
    // Both must agree: 50%, not 100%.
    assert.strictEqual(
      fm.progress.percent,
      50,
      `state sync must cap percent at phase fraction (50%), got ${fm.progress.percent}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3594-parser-adversarial-frontmatter.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3594-parser-adversarial-frontmatter (consolidation epic #1969 B3 #1972)", () => {
/**
 * Adversarial frontmatter-parser tests (#3594).
 *
 * Loads each file in `tests/fixtures/adversarial/frontmatter/` and pins
 * the invariants `extractFrontmatter()` must satisfy. The fixtures
 * encode hostile-but-realistic input shapes (duplicate keys, CRLF
 * endings, unclosed blocks, Unicode, null bytes, huge but bounded
 * payloads) that the parser will see in the wild because users edit
 * planning files with multiple tools.
 *
 * Per CONTRIBUTING.md §"Testing Standards / Parser and project-file
 * inputs", these are typed-IR assertions on parser return values —
 * not prose-grep on rendered output. Property-style invariants for
 * the roadmap parser live in
 * `tests/feat-3594-parser-property-style.test.cjs`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'frontmatter');

function loadFixture(name) {
  // Read as buffer first so null bytes survive into the string. The
  // CRLF fixture also requires we do NOT normalize line endings on read.
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('feat-3594: frontmatter parser handles duplicate keys deterministically', () => {
  test('duplicate keys collapse to a single deterministic winner (last-wins is the current contract)', () => {
    const content = loadFixture('duplicate-keys.md');
    const fm = extractFrontmatter(content);

    // The parser MUST return a single value per key — not an array of
    // both, not a half-formed entry. Whichever value wins, the test pins
    // the current behavior so a silent semantics change is a test failure.
    assert.equal(typeof fm.title, 'string', 'title must be a string, not an array or object');
    assert.equal(typeof fm.status, 'string', 'status must be a string');
    // Current parser behavior: the second occurrence wins because each
    // key: line overwrites the previous in the same indent context.
    // Pin it so a change to first-wins becomes visible.
    assert.equal(fm.title, 'Second', 'duplicate-key collapse must be last-wins (current contract)');
    assert.equal(fm.status, 'blocked', 'duplicate-key collapse must be last-wins (current contract)');
    // Untouched keys round-trip cleanly.
    assert.equal(fm.phase, '01');
  });
});

describe('feat-3594: frontmatter parser handles CRLF endings without bleed', () => {
  test('CRLF-terminated frontmatter parses without trailing \\r in values', () => {
    const content = loadFixture('crlf-mixed.md');
    const fm = extractFrontmatter(content);
    // Each value MUST be \r-free. A bug in `\r?\n` handling would leak
    // \r into the captured group.
    assert.equal(fm.title, 'CRLF Title');
    assert.equal(fm.phase, '02');
    assert.ok(!/\r/.test(JSON.stringify(fm)), 'no \\r should appear in any parsed value');
    // Array items must also be \r-free.
    assert.deepEqual(fm.plans, ['02-01', '02-02']);
  });
});

describe('feat-3594: frontmatter parser handles unclosed blocks safely', () => {
  test('unclosed frontmatter block returns empty object, not partial parse', () => {
    const content = loadFixture('unclosed-block.md');
    const fm = extractFrontmatter(content);
    // The current contract: if the closing `---` is missing, the regex
    // doesn't match and the parser returns {}. The test pins that —
    // a partial parse (returning {title: 'Unclosed Block'}) would be a
    // silent data-leak from the body into "frontmatter."
    assert.deepEqual(fm, {}, 'unclosed block must yield empty frontmatter, not a partial parse');
  });
});

describe('feat-3594: frontmatter parser preserves Unicode round-trip', () => {
  test('non-ASCII keys and values survive parsing', () => {
    const content = loadFixture('unicode-keys-and-values.md');
    const fm = extractFrontmatter(content);
    assert.equal(fm.title, '日本語のタイトル');
    // The parser's key regex is /^(\s*)([a-zA-Z0-9_-]+):.../ so non-ASCII
    // keys (like `相:`) won't be captured. Pin that current behavior so
    // a future broadening to allow Unicode keys is visible (and so the
    // ASCII-only contract is asserted, not silently relied on).
    assert.equal(fm['相'], undefined, 'parser currently only recognizes ASCII keys (regression guard)');
    // The status field has an emoji — must survive.
    assert.equal(fm.status, '🚧 in-flight');
    // Inline array with Greek letters.
    assert.deepEqual(fm.tags, ['α', 'β', 'γ']);
  });
});

describe('feat-3594: frontmatter parser handles null bytes without truncation', () => {
  test('null byte in a value is preserved or normalized, never silently truncates the rest', () => {
    const content = loadFixture('null-byte-value.md');
    const fm = extractFrontmatter(content);
    // The parser MUST NOT crash. It MUST NOT truncate the value at the
    // null byte AND continue parsing as if the rest of the line never
    // existed. We pin: (a) the title still parses, (b) the phase key
    // following the null-byte line still parses (no early-termination),
    // (c) the null-byte value itself is a string.
    assert.equal(fm.title, 'Has null byte');
    assert.equal(fm.phase, '05', 'parser must continue past the null-byte line, not silently stop');
    assert.equal(typeof fm.weird, 'string');
    // The exact null-handling is documented by whatever the current
    // parser does: either preserve the \x00 or strip it. Test pins one.
    assert.ok(fm.weird.includes('before'), 'value before the null byte must be retained');
  });
});

describe('feat-3594: frontmatter parser handles bounded-large inputs in reasonable time', () => {
  test('64KB frontmatter with 2000 array items parses and returns the right shape', () => {
    const content = loadFixture('huge-bounded.md');
    const fm = extractFrontmatter(content);
    assert.equal(fm.phase, '06');
    assert.ok(Array.isArray(fm.plans), 'plans must be parsed as an array');
    assert.equal(fm.plans.length, 2000, 'all 2000 array items must be captured');
    assert.equal(fm.plans[0], 'item-00000');
    assert.equal(fm.plans[1999], 'item-01999');
  });
});

// ─── Cross-cutting invariants over the whole fixture corpus ────────────────

describe('feat-3594: frontmatter parser does not throw on ANY corpus fixture', () => {
  // Property-style: whatever weirdness lives in the corpus, extractFrontmatter
  // must return an object — never throw, never return undefined/null. This is
  // the floor every individual fixture also satisfies, but checking it as a
  // sweep catches a future fixture addition where the author forgets to write
  // a per-file test.
  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const fixture of fixtures) {
    test(`fixture "${fixture}" — extractFrontmatter returns a plain object without throwing`, () => {
      const content = loadFixture(fixture);
      let fm;
      assert.doesNotThrow(() => { fm = extractFrontmatter(content); }, `extractFrontmatter must not throw on ${fixture}`);
      assert.equal(typeof fm, 'object', `${fixture}: result must be an object`);
      assert.notEqual(fm, null, `${fixture}: result must not be null`);
      assert.equal(Array.isArray(fm), false, `${fixture}: result must not be an array`);
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3594-parser-property-style.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3594-parser-property-style (consolidation epic #1969 B3 #1972)", () => {
/**
 * Deterministic property-style parser tests (#3594).
 *
 * Follows TEST-EXAMPLES.md §"Deterministic Property-Style Parser Test":
 * a bounded, seeded loop generates many malformed inputs and asserts a
 * single invariant against each. On failure the seed and case index
 * are printed so the failing input can be reproduced exactly.
 *
 * The generator is a small mulberry32 PRNG so this file has zero
 * external dependencies and is fully reproducible across Node versions.
 * Each test pins its own seed and case count; bumping either is a
 * deliberate test change, not a flake source.
 *
 * Invariant tested (frontmatter): for any random text the parser must
 * either return a plain object or throw — never return null/undefined,
 * never hang, never propagate "Cannot read properties of …" V8 prose.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

/**
 * mulberry32 — small fast deterministic PRNG. Seed in, [0,1) out.
 * Same input always produces the same sequence across Node versions.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a single malformed-ish frontmatter input. Components are mixed
 * deterministically by the supplied PRNG.
 */
function makeInput(rng) {
  const fragments = [
    '---\n',
    'title: Generated\n',
    'phase: 99\n',
    'plans:\n  - a\n  - b\n',
    'extra: \xff\xfe\xfd\n',          // invalid UTF-8 bytes
    'unicode: 日本語\n',
    'crlf: ends\r\nin\rcr\n',
    '   indented_key: value\n',
    'duplicate: first\nduplicate: second\n',
    'sparse:\n\n\n',
    'malformed_array: [a, "b", c\n',  // unclosed inline array
    'null_byte: before\x00after\n',
  ];
  // Pick a random subset of fragments in random order. Always include
  // the opening `---`. Closing `---` is included by 50% of cases so we
  // exercise both well-formed and unclosed shapes.
  const head = fragments[0];
  const rest = shuffle(fragments.slice(1), rng).slice(0, 1 + Math.floor(rng() * 6));
  const closing = rng() < 0.5 ? '---\n' : '';
  return head + rest.join('') + closing + '\nBody.\n';
}

/**
 * Fisher-Yates shuffle driven by the supplied PRNG. Returns a new
 * array; does not mutate the input. Replaces the previous
 * `arr.sort(() => rng() - 0.5)` which was non-transitive — the
 * resulting order depended on V8's sort implementation, not only on
 * the seed, so failing cases were unreproducible across Node versions.
 * Fisher-Yates is O(n), transitive (no comparator), and depends only
 * on the RNG output. Codex review on PR #3633 / #3594.
 */
function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

test('extractFrontmatter is total over 500 deterministic random inputs (seed=1234)', () => {
  const seed = 1234;
  const rng = mulberry32(seed);
  const count = 500;
  for (let i = 0; i < count; i++) {
    const input = makeInput(rng);
    let result;
    try {
      result = extractFrontmatter(input);
    } catch (err) {
      // If the parser throws, the failure must be a controlled one —
      // not a V8 "Cannot read properties of undefined" that signals a
      // null-deref bug. Print the seed and case index so the input
      // can be reproduced exactly.
      const msg = String((err && err.message) || err);
      assert.doesNotMatch(
        msg,
        /Cannot read propert/i,
        `seed=${seed} case=${i}: parser must not propagate null-deref TypeError; input=${JSON.stringify(input)}`,
      );
      continue;
    }
    // No throw: result MUST be a plain object (not null, not array, not
    // primitive). Print enough on failure to reproduce.
    assert.equal(typeof result, 'object', `seed=${seed} case=${i}: result must be object, got ${typeof result}`);
    assert.notEqual(result, null, `seed=${seed} case=${i}: result must not be null`);
    assert.equal(Array.isArray(result), false, `seed=${seed} case=${i}: result must not be an array`);
  }
});

test('extractFrontmatter handles large frontmatter blocks without body bleed', () => {
  // Deterministic large-input coverage replaces the former wall-clock ratio
  // guard. Timing assertions are host-sensitive; this pins the parser contract
  // instead: parse every frontmatter line once and stop at the first closing
  // delimiter before the body.

  /** Build a frontmatter string with exactly `lineCount` key:value lines. */
  function buildScaleInput(lineCount) {
    let s = '---\n';
    for (let i = 0; i < lineCount; i++) {
      s += `key${i}: value${i}\n`;
    }
    return s + '---\nBody.\n';
  }

  for (const lineCount of [20, 200, 2000]) {
    const result = extractFrontmatter(buildScaleInput(lineCount) + 'body_key: not-frontmatter\n');
    assert.equal(Object.keys(result).length, lineCount);
    assert.equal(result.key0, 'value0');
    assert.equal(result[`key${lineCount - 1}`], `value${lineCount - 1}`);
    assert.equal(result.body_key, undefined);
  }
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #2736 regressions — `phase complete` / `state begin-phase` rewrite
// current_phase_name to the name's own parenthetical. Placed here beside the
// #1695 delta-gate suite (the same defect family): the transition holds the
// exact display name, then the post-transform syncStateFrontmatter re-derives
// the scalar from body prose via the lossy parsePhaseFromProse. The fix is
// intent-first: adapters pass the intent-held name as an authoritative
// override (completePhase directly, beginPhase via readModifyWriteStateMd
// options), re-asserted after the #1695 preservation so neither the prose
// re-derivation nor the curated restore can destroy it. Parser-precedence
// cases live in tests/phase-id.test.cjs.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __d2736, test: __t2736, beforeEach: __be2736, afterEach: __ae2736 } = require('node:test');
  const __assert2736 = require('node:assert/strict');
  const __fs2736 = require('node:fs');
  const __path2736 = require('node:path');
  const { runGsdTools: __run2736, createTempProject: __mk2736, cleanup: __rm2736 } = require('./helpers.cjs');
  const __state2736 = require('../gsd-core/bin/lib/state.cjs');

  const PAREN_NAME_2736 = 'Closer-ruling measurement (D1a)';

  // The issue's repro (a) fixture: curated frontmatter name present, body
  // `Phase:` line exactly as completePhaseCore writes it, and no
  // `Current Phase Name:` body field (the common STATE.md shape, where the
  // replace-only body-field write is a no-op).
  function postAdvanceState2736() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.10',
      'current_phase: 48',
      'current_phase_name: Harness debt clearance',
      'status: planning',
      '---',
      '',
      '# Project State',
      '',
      '**Status:** Ready to plan',
      '',
      '## Current Position',
      '',
      `Phase: 48 — ${PAREN_NAME_2736}`,
      'Plan: Not started',
      '',
    ].join('\n');
  }

  __d2736('#2736: syncStateFrontmatter authoritative override (unit)', () => {
    __t2736('an intent-first override survives the prose round-trip verbatim', () => {
      const out = __state2736.syncStateFrontmatter(postAdvanceState2736(), undefined, {
        current_phase_name: PAREN_NAME_2736,
      });
      const fm = extractFrontmatter(out);
      __assert2736.strictEqual(
        fm.current_phase_name,
        PAREN_NAME_2736,
        `authoritative current_phase_name must win over the prose re-derivation; got ${JSON.stringify(fm.current_phase_name)}`,
      );
    });

    __t2736('without an override, the dash name wins (secondary fix), but the paren aside is still dropped', () => {
      // Documents the residual lossiness that makes the intent-first override
      // necessary: for `N — Name (aside)` prose where the aside IS part of the
      // name, no precedence can recover the full name from prose alone.
      const out = __state2736.syncStateFrontmatter(postAdvanceState2736(), undefined);
      const fm = extractFrontmatter(out);
      __assert2736.strictEqual(
        fm.current_phase_name,
        'Closer-ruling measurement',
        `the paren-over-dash harvest ('D1a') must be gone; got ${JSON.stringify(fm.current_phase_name)}`,
      );
    });

    __t2736('an empty/blank override entry is ignored (no clearing an existing value)', () => {
      const out = __state2736.syncStateFrontmatter(postAdvanceState2736(), undefined, {
        current_phase_name: '   ',
      });
      const fm = extractFrontmatter(out);
      __assert2736.notStrictEqual(fm.current_phase_name, '   ');
    });
  });

  __d2736('#2736: phase complete preserves a paren-containing next-phase name (e2e)', () => {
    let tmpDir;
    __be2736(() => { tmpDir = __mk2736(); });
    __ae2736(() => { __rm2736(tmpDir); });

    __t2736('current_phase_name lands as the exact roadmap display name, not its parenthetical', () => {
      const planningDir = __path2736.join(tmpDir, '.planning');
      const phase1Dir = __path2736.join(planningDir, 'phases', '01-foundation');
      __fs2736.mkdirSync(phase1Dir, { recursive: true });

      __fs2736.writeFileSync(
        __path2736.join(planningDir, 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '- [ ] Phase 1: Foundation',
          `- [ ] Phase 2: ${PAREN_NAME_2736}`,
          '',
          '### Phase 1: Foundation',
          '**Goal:** Setup',
          '**Plans:** 1 plans',
          '',
          `### Phase 2: ${PAREN_NAME_2736}`,
          '**Goal:** Measure closer rulings',
          '',
        ].join('\n'),
      );

      // The in-the-wild STATE.md shape: frontmatter + ## Current Position with
      // a `Phase:` line, and NO `Current Phase Name:` body field.
      __fs2736.writeFileSync(
        __path2736.join(planningDir, 'STATE.md'),
        [
          '---',
          'gsd_state_version: 1.0',
          'current_phase: 1',
          'current_phase_name: Foundation',
          'status: executing',
          '---',
          '',
          '# Project State',
          '',
          '## Current Position',
          '',
          'Phase: 1 — Foundation',
          'Plan: 1 of 1',
          'Status: Executing Phase 1',
          'Last activity: 2026-07-01 — mid-flight',
          '',
        ].join('\n'),
      );

      __fs2736.writeFileSync(__path2736.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
      __fs2736.writeFileSync(__path2736.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');
      __fs2736.writeFileSync(
        __path2736.join(phase1Dir, '01-VERIFICATION.md'),
        ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
      );

      const result = __run2736(['phase', 'complete', '1'], tmpDir);
      __assert2736.ok(result.success, `phase complete failed: ${result.error}`);

      const stateContent = __fs2736.readFileSync(__path2736.join(planningDir, 'STATE.md'), 'utf-8');
      const fm = extractFrontmatter(stateContent);
      __assert2736.strictEqual(
        fm.current_phase_name,
        PAREN_NAME_2736,
        `current_phase_name must be the exact next-phase display name; got ${JSON.stringify(fm.current_phase_name)} ` +
        '(the prose round-trip harvested the parenthetical — #2736)',
      );
      // The body prose the transition wrote stays as designed.
      __assert2736.match(stateContent, /Phase: 2 — Closer-ruling measurement \(D1a\)/);
    });
  });

  __d2736('#2736 sibling: state begin-phase preserves a paren-containing name (e2e)', () => {
    let tmpDir;
    __be2736(() => { tmpDir = __mk2736(); });
    __ae2736(() => { __rm2736(tmpDir); });

    function writeBeginFixture2736(lines) {
      __fs2736.writeFileSync(__path2736.join(tmpDir, '.planning', 'STATE.md'), lines.join('\n'));
    }

    __t2736('the intent-held name survives the begin-phase sync verbatim', () => {
      writeBeginFixture2736([
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 1',
        'current_phase_name: Foundation',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 1 — Foundation',
        'Plan: Not started',
        'Status: Ready to execute',
        'Last activity: 2026-07-01 — planned',
        '',
      ]);

      const result = __run2736(
        ['state', 'begin-phase', '--phase', '2', '--name', PAREN_NAME_2736, '--plans', '1'],
        tmpDir,
      );
      __assert2736.ok(result.success, `state begin-phase failed: ${result.error}`);

      const fm = extractFrontmatter(__fs2736.readFileSync(__path2736.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
      __assert2736.strictEqual(
        fm.current_phase_name,
        PAREN_NAME_2736,
        `current_phase_name must be the exact intent-held name; got ${JSON.stringify(fm.current_phase_name)} ` +
        '(the `N (Name) — EXECUTING` round-trip truncates paren-containing names — #2736)',
      );
    });

    __t2736('the override outlives the #1695 preservation restore when no body Phase: line exists', () => {
      // Cross-AI review finding (P4.6 round 1): with no `Phase:` body line the
      // pre/post phase-source snapshots are both null (equal), so the #1695
      // restore fires after the sync and used to put the stale pre-transition
      // name back over the authoritative one. The re-assert after
      // applyStatePreservation is what this pins.
      writeBeginFixture2736([
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 1',
        'current_phase_name: Foundation',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 1',
        '**Status:** Ready to execute',
        '**Last Activity:** 2026-07-01',
        '',
      ]);

      const result = __run2736(
        ['state', 'begin-phase', '--phase', '2', '--name', PAREN_NAME_2736, '--plans', '1'],
        tmpDir,
      );
      __assert2736.ok(result.success, `state begin-phase failed: ${result.error}`);

      const fm = extractFrontmatter(__fs2736.readFileSync(__path2736.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
      __assert2736.strictEqual(
        fm.current_phase_name,
        PAREN_NAME_2736,
        `the intent-held name must outlive the preservation restore; got ${JSON.stringify(fm.current_phase_name)}`,
      );
    });

    __t2736('a #3127 resume does NOT override the preserved mid-flight name', () => {
      // Cross-AI review finding (P4.6 round 2): on a resume (Status already
      // `Executing Phase N`), beginPhaseCore deliberately preserves the
      // mid-flight Current Phase Name — the adapter must drop the intent-first
      // override so frontmatter tracks the preserved body value instead of the
      // resume invocation's --name.
      writeBeginFixture2736([
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 2',
        `current_phase_name: ${PAREN_NAME_2736}`,
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        `Phase: 2 — ${PAREN_NAME_2736}`,
        'Plan: 1 of 1',
        'Status: Executing Phase 2',
        'Last activity: 2026-07-01 — mid-flight',
        '',
      ]);

      const result = __run2736(
        ['state', 'begin-phase', '--phase', '2', '--name', 'A Different Name', '--plans', '1'],
        tmpDir,
      );
      __assert2736.ok(result.success, `state begin-phase (resume) failed: ${result.error}`);

      const fm = extractFrontmatter(__fs2736.readFileSync(__path2736.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
      __assert2736.strictEqual(
        fm.current_phase_name,
        PAREN_NAME_2736,
        `a resume must keep the preserved mid-flight name, not the resume's --name; got ${JSON.stringify(fm.current_phase_name)}`,
      );
    });
  });
}
