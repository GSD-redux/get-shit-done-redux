// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard for #1777: product names must not have parenthetical descriptions.
 *
 * Community PRs repeatedly add editorial commentary in parentheses next to
 * product names (licensing, parent company, architecture). This test scans
 * all README files and ensures install-block comment lines contain only the
 * product name — no parenthetical text of any kind.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const ROOT = path.join(__dirname, '..');

// Product names that appear in install blocks as comment headers
const PRODUCTS = [
  'Claude Code', 'Claude', 'OpenCode', 'Kilo', 'Codex', 'Copilot',
  'Cursor', 'Windsurf', 'Antigravity', 'Trae', 'Cline', 'Augment',
  'Gemini', 'Gemini CLI',
];

// README files to scan (root + i18n variants + docs)
const README_FILES = [
  'README.md',
  'README.ko-KR.md',
  'README.ja-JP.md',
  'README.zh-CN.md',
  'README.pt-BR.md',
  'docs/zh-CN/README.md',
  'docs/ko-KR/README.md',
  'docs/ja-JP/README.md',
  'docs/pt-BR/README.md',
  'docs/README.md',
].filter(f => fs.existsSync(path.join(ROOT, f)));

// Detect "ProductName (description)" parentheticals in arbitrary prose, skipping
// version references like "Claude Code (v1.32.0)" / "Claude (1.5.0)". Returns the
// matched substrings so callers can report them. Shared by the CHANGELOG and the
// changeset-fragment scans so both apply identical rules.
function findProductParentheticals(content) {
  const found = [];
  for (const product of PRODUCTS) {
    // Match "ProductName (something)" but not "ProductName (v1.2.3)" (version refs are ok)
    const pattern = new RegExp(
      escapeRegex(product) +
      '\\s*\\([^)]*(?!v?\\d+\\.\\d)[^)]*\\)',
      'g'
    );
    const matches = content.match(pattern);
    if (!matches) continue;
    for (const m of matches) {
      // Skip version references like "Claude Code (v1.32.0)"
      if (/\(v?\d+\.\d+/.test(m)) continue;
      found.push(m);
    }
  }
  return found;
}

describe('product name purity (#1777)', () => {
  // Pin the shared detector's contract so neither the CHANGELOG nor the
  // fragment scan can pass vacuously: a silently-broken helper that always
  // returned [] would otherwise go undetected whenever the scanned files
  // happen to be clean.
  test('findProductParentheticals catches a real violation and allows version refs', () => {
    assert.deepEqual(
      findProductParentheticals('see Claude Code (the Anthropic CLI) for details'),
      ['Claude Code (the Anthropic CLI)'],
    );
    assert.deepEqual(
      findProductParentheticals('upgraded to Claude Code (v1.32.0)'),
      [],
    );
  });

  test('no README install-block comments contain parenthetical descriptions', () => {
    const violations = [];

    for (const file of README_FILES) {
      const content = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match shell comment lines that start with # followed by a product name
        // and then have parenthetical text: # ProductName (something)
        // Also match fullwidth parens used in CJK: # ProductName（something）
        const match = line.match(/^#\s+(\S+(?:\s+\S+)?)\s*[（(].+[）)]/);
        if (!match) continue;

        const name = match[1];
        // Check if this is actually a product name line (not a random comment)
        const isProduct = PRODUCTS.some(p =>
          name === p || name.startsWith(p)
        );
        if (isProduct) {
          violations.push([
            file + ':' + (i + 1),
            line.trim(),
          ].join(' — '));
        }
      }
    }

    assert.strictEqual(
      violations.length, 0,
      [
        'Product names in README install blocks must not have parenthetical descriptions.',
        'Found violations:',
        ...violations.map(v => '  ' + v),
      ].join('\n')
    );
  });

  test('CHANGELOG does not include parenthetical product descriptions', () => {
    const changelog = path.join(ROOT, 'CHANGELOG.md');
    if (!fs.existsSync(changelog)) return;

    const content = fs.readFileSync(changelog, 'utf-8');
    const violations = findProductParentheticals(content);

    assert.strictEqual(
      violations.length, 0,
      [
        'CHANGELOG must not include parenthetical product descriptions.',
        'Found:',
        ...violations.map(v => '  ' + v),
      ].join('\n')
    );
  });

  test('live changeset fragments do not include parenthetical product descriptions', () => {
    const changesetDir = path.join(ROOT, '.changeset');
    if (!fs.existsSync(changesetDir)) return;

    // Only LIVE fragments (.changeset/*.md) render into CHANGELOG.md at release
    // time, so an impure fragment silently re-introduces a #1777 violation at the
    // next release / back-merge even after CHANGELOG.md itself was hand-fixed.
    // Archived fragments (.changeset/archived/) never re-render and are out of scope.
    const fragments = fs.readdirSync(changesetDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.md') && d.name !== 'README.md')
      .map(d => d.name);

    const violations = [];
    for (const frag of fragments) {
      const content = fs.readFileSync(path.join(changesetDir, frag), 'utf-8');
      for (const m of findProductParentheticals(content)) {
        violations.push(frag + ' — ' + m);
      }
    }

    assert.strictEqual(
      violations.length, 0,
      [
        'Changeset fragments must not include parenthetical product descriptions',
        '(fragment prose renders verbatim into CHANGELOG.md at release time):',
        ...violations.map(v => '  ' + v),
      ].join('\n')
    );
  });
});
