// Guards the responsive-separator convention defined in
// gsd-core/references/ui-brand.md § "Separators and Banners".
//
// Shipped content (gsd-core/, agents/, commands/) is runtime-loaded text: an
// agent reads it and emits the banners it describes. A fixed-width run of
// box-drawing characters is ordinary text to a Markdown-rendering host, so in a
// narrower pane it wraps and leaves orphan glyphs on a second line, coming apart
// from the heading it was meant to frame. Markdown headings and thematic breaks
// adapt to the available width instead.
//
// Enhancement for https://github.com/open-gsd/gsd-core/issues/3028.
//
// SCOPE - deliberately narrow, see the negative-space cases below:
//   * A "rule line" is a line whose trimmed content is composed ENTIRELY of
//     U+2500, U+2501 or U+2550, three or more of them. Tree glyphs, boxed-table
//     rows, progress bars and inline art all carry other characters and are
//     never flagged.
//   * A "panel character" is one of U+2554 U+2557 U+255A U+255D U+2551 anywhere
//     on a line.
//   * docs/ is NOT scanned: a documentation page may legitimately quote the old
//     form while explaining the change. src/ is not scanned either - its
//     section-divider comments are read in an editor, never emitted.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// Runtime-loaded text: an agent reads these and emits what they describe.
const SHIPPED_ROOTS = ['gsd-core', 'agents', 'commands'];

// A shorter run than MIN_RULE_RUN is a glyph fragment, not a rule.
const MIN_RULE_RUN = 3;
const RULE_LINE_RE = /^[─━═]{3,}$/;

// Double-line box vocabulary only. Single-line characters (└ ├ │ ...) are
// deliberately absent: they are legitimate tree glyphs, not panel borders.
const PANEL_CHAR_RE = /[╔╗╚╝║╠╣╦╩╬]/;

const HEAVY = '━';
const LIGHT = '─';
const DOUBLE = '═';

// `trim()` also strips a trailing \r, so CRLF files are handled without a
// separate newline split dialect.
function isFixedWidthRuleLine(line) {
  return RULE_LINE_RE.test(line.trim());
}

function hasPanelCharacter(line) {
  return PANEL_CHAR_RE.test(line);
}

function findMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function shippedMarkdownFiles() {
  const files = [];
  for (const root of SHIPPED_ROOTS) {
    files.push(...findMarkdownFiles(path.join(REPO_ROOT, root)));
  }
  return files;
}

function scan(files, predicate) {
  const violations = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (predicate(lines[i])) {
        violations.push(
          `${path.relative(REPO_ROOT, filePath)}:${i + 1}: ${lines[i].trim().slice(0, 40)}`
        );
      }
    }
  }
  return violations;
}

const REMEDY =
  '\n\nPer gsd-core/references/ui-brand.md "Separators and Banners":\n' +
  '  - a stage banner is an ATX heading with no rule lines;\n' +
  '  - a panel becomes a heading followed by its rows as plain lines;\n' +
  '  - a divider between sections is --- with a blank line above and below.\n' +
  'A fixed-width run wraps in a narrow pane and comes apart from its heading.\n' +
  'See https://github.com/open-gsd/gsd-core/issues/3028';

describe('responsive-separators', () => {
  const tmpDirs = [];
  afterEach(() => {
    while (tmpDirs.length) cleanup(tmpDirs.pop());
  });

  function tempFile(name, content) {
    const dir = createTempDir('responsive-separators');
    tmpDirs.push(dir);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  test('the shipped-content walk actually finds files', () => {
    const files = shippedMarkdownFiles();
    // Without this the two repo-wide scans below would pass vacuously if the
    // roots were ever renamed out from under them.
    assert.ok(
      files.length > 100,
      `expected the shipped roots (${SHIPPED_ROOTS.join(', ')}) to hold markdown, found ${files.length}`
    );
    for (const root of SHIPPED_ROOTS) {
      assert.ok(
        files.some((f) => f.startsWith(path.join(REPO_ROOT, root) + path.sep)),
        `no markdown found under shipped root "${root}"`
      );
    }
  });

  test('no shipped content emits a fixed-width rule line', () => {
    const violations = scan(shippedMarkdownFiles(), isFixedWidthRuleLine);
    assert.deepStrictEqual(
      violations,
      [],
      'Fixed-width box-drawing rule lines found in shipped content:\n' +
        violations.map((v) => `  - ${v}`).join('\n') +
        REMEDY
    );
  });

  test('no shipped content emits box-panel characters', () => {
    const violations = scan(shippedMarkdownFiles(), hasPanelCharacter);
    assert.deepStrictEqual(
      violations,
      [],
      'Box-panel characters found in shipped content:\n' +
        violations.map((v) => `  - ${v}`).join('\n') +
        REMEDY
    );
  });

  test(`run of ${MIN_RULE_RUN - 1} is not a rule (limit-1)`, () => {
    assert.equal(isFixedWidthRuleLine(HEAVY.repeat(MIN_RULE_RUN - 1)), false);
    assert.equal(isFixedWidthRuleLine(LIGHT.repeat(MIN_RULE_RUN - 1)), false);
    assert.equal(isFixedWidthRuleLine(DOUBLE.repeat(MIN_RULE_RUN - 1)), false);
  });

  test(`run of ${MIN_RULE_RUN} is a rule (limit)`, () => {
    assert.equal(isFixedWidthRuleLine(HEAVY.repeat(MIN_RULE_RUN)), true);
    assert.equal(isFixedWidthRuleLine(LIGHT.repeat(MIN_RULE_RUN)), true);
    assert.equal(isFixedWidthRuleLine(DOUBLE.repeat(MIN_RULE_RUN)), true);
  });

  test(`run of ${MIN_RULE_RUN + 1} is a rule (limit+1)`, () => {
    assert.equal(isFixedWidthRuleLine(HEAVY.repeat(MIN_RULE_RUN + 1)), true);
  });

  test('run of 1 is not a rule', () => {
    assert.equal(isFixedWidthRuleLine(HEAVY), false);
  });

  test('lines that merely contain box-drawing glyphs are not rules', () => {
    const notRules = [
      '└── file.md',
      '├── dir/',
      '├────┼────┤',
      'Progress: ████░░ 80%',
      '| --- | --- |',
      '---',
      '### GSD ► EXECUTING WAVE 8',
      '',
      '   \t  ',
      `a${HEAVY.repeat(3)}`,
      `${HEAVY.repeat(3)}a`,
    ];
    for (const line of notRules) {
      assert.equal(
        isFixedWidthRuleLine(line),
        false,
        `should not be a rule: ${JSON.stringify(line)}`
      );
    }
  });

  test('an indented rule line is still a rule', () => {
    assert.equal(isFixedWidthRuleLine(`   ${HEAVY.repeat(4)}  `), true);
    assert.equal(isFixedWidthRuleLine(`\t${LIGHT.repeat(3)}\t`), true);
  });

  test('mixed rule characters still count as a rule', () => {
    assert.equal(isFixedWidthRuleLine(`${LIGHT}${LIGHT}${LIGHT}${HEAVY}${HEAVY}${DOUBLE}`), true);
  });

  test('panel characters are detected anywhere on the line', () => {
    assert.equal(hasPanelCharacter('╔══╗'), true);
    assert.equal(hasPanelCharacter('║  CHECKPOINT: Verification Required   ║'), true);
    assert.equal(hasPanelCharacter('╚══╝'), true);
    assert.equal(hasPanelCharacter('╠══╣'), true);
    assert.equal(hasPanelCharacter('├──┤'), false);
    assert.equal(hasPanelCharacter('│  tree'), false);
    assert.equal(hasPanelCharacter('### CHECKPOINT: Verification Required'), false);
    assert.equal(hasPanelCharacter('└── file.md'), false);
  });

  test('the scan flags a heavy fixed-width rule line, with path and line number', () => {
    const filePath = tempFile(
      'banner.md',
      ['Display banner:', '', HEAVY.repeat(53), ' GSD ► PLANNING', ''].join('\n')
    );
    const violations = scan([filePath], isFixedWidthRuleLine);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /banner\.md:3: /);
  });

  test('the scan flags box-panel characters', () => {
    const filePath = tempFile(
      'panel.md',
      ['╔══╗', '║ ERROR ║', '╚══╝'].join('\n')
    );
    const violations = scan([filePath], hasPanelCharacter);
    assert.equal(violations.length, 3);
  });

  test('CRLF files are scanned identically to LF files', () => {
    const crlf = tempFile(
      'crlf.md',
      ['Display:', HEAVY.repeat(53), '└── file.md', ''].join('\r\n')
    );
    const violations = scan([crlf], isFixedWidthRuleLine);
    assert.equal(violations.length, 1, 'the \\r must not defeat the rule-line trim');
    assert.match(violations[0], /crlf\.md:2: /);
  });

  test('a file with no separators produces no violations', () => {
    const filePath = tempFile(
      'clean.md',
      ['# Title', '', '### GSD ► PLANNING', '', '---', '', 'Body.'].join('\n')
    );
    assert.deepStrictEqual(scan([filePath], isFixedWidthRuleLine), []);
    assert.deepStrictEqual(scan([filePath], hasPanelCharacter), []);
  });

  test('an empty shipped file produces no violations', () => {
    const filePath = tempFile('empty.md', '');
    assert.deepStrictEqual(scan([filePath], isFixedWidthRuleLine), []);
    assert.deepStrictEqual(scan([filePath], hasPanelCharacter), []);
  });

  const RULE_CHAR = fc.constantFrom(LIGHT, HEAVY, DOUBLE);

  test(`property: any pure run of ${MIN_RULE_RUN}+ rule characters is flagged`, () => {
    fc.assert(
      fc.property(
        fc.array(RULE_CHAR, { minLength: MIN_RULE_RUN, maxLength: 120 }),
        fc.constantFrom('', ' ', '  ', '\t', ' \t '),
        fc.constantFrom('', ' ', '  ', '\t', '\r'),
        (chars, lead, trail) => isFixedWidthRuleLine(`${lead}${chars.join('')}${trail}`)
      ),
      { seed: 3028, numRuns: 300 }
    );
  });

  test('property: a line carrying any non-rule, non-whitespace character is never flagged', () => {
    fc.assert(
      fc.property(
        fc.array(RULE_CHAR, { minLength: 0, maxLength: 60 }),
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => /\S/.test(s) && !/^[─━═\s]*$/.test(s)),
        fc.array(RULE_CHAR, { minLength: 0, maxLength: 60 }),
        (before, intruder, after) =>
          isFixedWidthRuleLine(`${before.join('')}${intruder}${after.join('')}`) === false
      ),
      { seed: 3028, numRuns: 300 }
    );
  });
});
