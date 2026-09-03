'use strict';

/**
 * Behavioral tests for markdown-table.cjs
 *
 * Module: gsd-core/bin/lib/markdown-table.cjs
 * Exports: parseMarkdownTable, matchTableSchema, TABLE_SCHEMAS
 *
 * Covers:
 *   - parseMarkdownTable happy path (4-col + 5-col headers, cells addressed by name)
 *   - BOUNDARY coverage: ragged data rows at limit-1 / limit / limit+1 cell counts
 *   - malformed-input error paths (empty, non-string, no table, missing delimiter row)
 *   - matchTableSchema resolving every canonical variant + null for unknown headers
 *   - fast-check round-trip property test
 *   - registry <-> template/workflow parity guard (ADR-2143 §3 Generative-Fix-
 *     Divergence guard) — every TABLE_SCHEMAS header must appear verbatim in the
 *     source file that generates it
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  migrateQuickTasksTable, parseMarkdownTable, matchTableSchema, TABLE_SCHEMAS, appendQuickTaskRow, findTableBySchema, findTableWithColumns, updateTableCell, deleteTableRow, resetQuickTaskRows, QUICK_TASKS_SECTION_ABSENT } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { buildHeader, normalize } = require('../scripts/lint-table-schema-drift.cjs');

const ROOT = path.join(__dirname, '..');

// ─── parseMarkdownTable: happy path ───────────────────────────────────────────

describe('parseMarkdownTable: happy path', () => {
  test('parses a 4-column flat RoadmapProgress table, cells addressed by name', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(result.value.rows.length, 2);
    assert.equal(result.value.rows[0]['Phase'], '1. Alpha');
    assert.equal(result.value.rows[0]['Plans Complete'], '2/2');
    assert.equal(result.value.rows[0]['Status'], 'Complete');
    assert.equal(result.value.rows[1]['Status'], 'In Progress');
  });

  test('parses a 5-column milestone-grouped RoadmapProgress table, cells addressed by name', () => {
    const src = [
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '|---|---|---|---|---|',
      '| 1. Alpha | v1.0 | 2/2 | Complete | ✅ |',
      '| 2. Beta | v1.1 | 0/3 | Planned | |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Phase', 'Milestone', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(result.value.rows[0]['Milestone'], 'v1.0');
    assert.equal(result.value.rows[1]['Milestone'], 'v1.1');
    assert.equal(result.value.rows[1]['Status'], 'Planned');
  });

  test('finds the FIRST table when the section has leading prose', () => {
    const src = [
      'Some intro prose before the table.',
      '',
      '| Requirement | Phase | Status |',
      '| --- | --- | --- |',
      '| R1 | 1 | Done |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Requirement', 'Phase', 'Status']);
    assert.equal(result.value.rows[0]['Requirement'], 'R1');
  });
});

// ─── BOUNDARY coverage: ragged data rows ──────────────────────────────────────

describe('parseMarkdownTable: boundary coverage (ragged rows)', () => {
  const header = '| Phase | Plans Complete | Status | Completed |';
  const delimiter = '| --- | --- | --- | --- |';

  test('limit-1: a 3-cell data row (one short of the 4-column header) is a typed error', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.match(result.reason, /row 1 has 3 cells, expected 4/);
  });

  test('limit: a 4-cell data row (exactly matching the 4-column header) parses ok', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete | ✅ |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.equal(result.value.rows.length, 1);
  });

  test('limit+1: a 5-cell data row (one over the 4-column header) is a typed error', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete | ✅ | extra |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.match(result.reason, /row 1 has 5 cells, expected 4/);
  });
});

// ─── Malformed input ──────────────────────────────────────────────────────────

describe('parseMarkdownTable: malformed input', () => {
  test('empty string returns a typed error', () => {
    const result = parseMarkdownTable('');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('whitespace-only string returns a typed error', () => {
    const result = parseMarkdownTable('   \n  \n  ');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('non-string input returns a typed error, does not throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseMarkdownTable(42);
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('content with no pipe table returns a typed error', () => {
    const result = parseMarkdownTable('# Heading\n\nJust some prose, no table here.\n');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no table found');
  });

  test('missing delimiter row returns a typed error', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing delimiter row');
  });

  test('delimiter row present but column count mismatch returns a typed error', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'delimiter/header column count mismatch');
  });
});

// ─── matchTableSchema ──────────────────────────────────────────────────────────

describe('matchTableSchema', () => {
  test('resolves every canonical variant header to its {id,label}', () => {
    for (const [id, variants] of Object.entries(TABLE_SCHEMAS)) {
      for (const variant of variants) {
        const match = matchTableSchema(variant.columns);
        assert.deepEqual(
          match,
          { id, label: variant.label },
          `expected ${id}/${variant.label} to resolve for columns ${JSON.stringify(variant.columns)}`,
        );
      }
    }
  });

  test('returns null for an unknown header', () => {
    const match = matchTableSchema(['Foo', 'Bar', 'Baz']);
    assert.equal(match, null);
  });

  test('returns null when column order differs from every variant', () => {
    const match = matchTableSchema(['Status', 'Phase', 'Plans Complete', 'Completed']);
    assert.equal(match, null);
  });

  test('returns null when column count differs from every variant', () => {
    const match = matchTableSchema(['Phase', 'Plans Complete', 'Status']);
    assert.equal(match, null);
  });
});

// ─── Property test: round-trip render -> parse ────────────────────────────────

describe('parseMarkdownTable: property-based round-trip', () => {
  // Safe cell text: no '|' or newline, non-empty, bounded length.
  const safeCell = fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((s) => !s.includes('|') && !s.includes('\n') && !s.includes('\r') && s.trim().length > 0)
    .map((s) => s.trim());

  const safeColumnName = fc
    .string({ minLength: 1, maxLength: 6 })
    .filter((s) => !s.includes('|') && !s.includes('\n') && !s.includes('\r') && s.trim().length > 0)
    .map((s) => s.trim());

  function renderTable(columns, rows) {
    const lines = [];
    lines.push(`| ${columns.join(' | ')} |`);
    lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      lines.push(`| ${row.join(' | ')} |`);
    }
    return lines.join('\n');
  }

  // A table's rows depend on its column count, so derive the rows arbitrary
  // from the generated columns via .chain() (dependent arbitrary generation) —
  // never fc.sample() inside a property, which breaks shrinking/reproducibility.
  const tableArb = fc.uniqueArray(safeColumnName, { minLength: 1, maxLength: 4 }).chain((columns) =>
    fc.tuple(
      fc.constant(columns),
      fc.array(fc.array(safeCell, { minLength: columns.length, maxLength: columns.length }), { maxLength: 4 }),
    ),
  );

  test('property: rendering a table then parsing it round-trips columns and row values', () => {
    fc.assert(
      fc.property(tableArb, ([columns, rows]) => {
        const src = renderTable(columns, rows);

        const result = parseMarkdownTable(src);
        assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
        assert.deepEqual(result.value.columns, columns);
        assert.equal(result.value.rows.length, rows.length);
        rows.forEach((cells, i) => {
          columns.forEach((col, j) => {
            assert.equal(result.value.rows[i][col], cells[j]);
          });
        });
      }),
    );
  });
});

// ─── appendQuickTaskRow (#2133) ────────────────────────────────────────────────

describe('appendQuickTaskRow (#2133)', () => {
  const noStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  const withStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Status | Directory |',
    '|---|-------------|------|--------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | Pass | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  test('5-col no-status table: appends a 5-cell row, content contains it, variant is no-status', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'add missing import',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.variant, 'no-status');
    assert.equal(result.value.row, '| 2 | add missing import | 2026-07-13 | a574966 | — |');
    assert.ok(result.value.content.includes(result.value.row));
  });

  test('6-col with-status table: appends a 6-cell row, variant is with-status', () => {
    const result = appendQuickTaskRow(withStatusState, {
      description: 'bump version',
      date: '2026-07-13',
      commit: 'b6fc5f6',
      status: 'Needs Review',
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.variant, 'with-status');
    assert.equal(result.value.row, '| 2 | bump version | 2026-07-13 | b6fc5f6 | Needs Review | — |');
    assert.ok(result.value.content.includes(result.value.row));
  });

  test('unknown/garbled header (4-col table): fails loud with a reason instead of silently skipping', () => {
    const garbled = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| Foo | Bar | Baz | Qux |',
      '|---|---|---|---|',
      '| 1 | 2 | 3 | 4 |',
    ].join('\n');
    const result = appendQuickTaskRow(garbled, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unrecognized Quick Tasks schema/);
  });

  test('no "Quick Tasks Completed" section: fails loud with a reason', () => {
    const noSection = '# STATE\n\n### Blockers/Concerns\nNone\n';
    const result = appendQuickTaskRow(noSection, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, QUICK_TASKS_SECTION_ABSENT);
  });

  test('boundary: next row number is 1 with zero data rows, 3 with two data rows', () => {
    const zeroRows = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
    ].join('\n');
    const zeroResult = appendQuickTaskRow(zeroRows, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(zeroResult.ok, true);
    assert.match(zeroResult.value.row, /^\| 1 \|/);

    const twoRows = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | first | 2026-01-01 | aaa1111 | — |',
      '| 2 | second | 2026-01-02 | bbb2222 | — |',
    ].join('\n');
    const twoResult = appendQuickTaskRow(twoRows, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(twoResult.ok, true);
    assert.match(twoResult.value.row, /^\| 3 \|/);
  });

  test('appended row cell count equals the header column count (round-trips via parseMarkdownTable)', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'round trip check',
      date: '2026-07-13',
      commit: 'ccc3333',
    });
    assert.equal(result.ok, true);
    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows.length, 2);
    for (const row of reparsed.value.rows) {
      assert.equal(Object.keys(row).length, reparsed.value.columns.length);
    }
  });

  // ─── Regression: cell-value escaping (#2242 review Fix 1) ──────────────────
  // A raw `|` or newline in `description` used to be inserted verbatim,
  // corrupting the table (extra column / a fake extra row) — the now-fail-loud
  // parseMarkdownTable rejects the resulting ragged row.

  test('description containing "|" round-trips: ok:true, no ragged row, cell value preserved', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'fix a | b bug',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'fix a | b bug');
  });

  // ─── Regression: backslash escaping (CodeQL js/incomplete-sanitization) ────
  // escapeCell used to escape `|` -> `\|` without first escaping a literal `\`,
  // so a description with a raw backslash (e.g. a Windows path) could produce
  // an escape sequence that splitTableRow misreads on unescape. escapeCell now
  // escapes `\` -> `\\` before `|` -> `\|`, and splitTableRow reverses both.

  test('description containing a literal backslash round-trips byte-for-byte', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'fix C:\\path bug',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'fix C:\\path bug');
  });

  test('description containing backslash-pipe ("a\\|b") round-trips to exactly "a\\|b"', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'a\\|b',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'a\\|b');
  });

  test('description containing a newline collapses to a single-line cell and round-trips', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'line one\nline two',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);
    // Collapsed to a single line: the row itself must not contain a newline.
    assert.ok(!result.value.row.includes('\n'));

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'line one line two');
  });

  // ─── Regression: CRLF preservation (#2242 review Fix 3) ─────────────────────
  // section.body used to be split on /\r?\n/ and rejoined with '\n', downgrading
  // a CRLF section to mixed EOL.

  test('CRLF-input STATE.md keeps \\r\\n in the touched section (no mixed EOL)', () => {
    const crlfState = noStatusState.replace(/\n/g, '\r\n');
    const result = appendQuickTaskRow(crlfState, {
      description: 'crlf check',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    // No mixed EOL: every line break in the touched section is \r\n, and there
    // must be no bare \n (i.e. no \n NOT preceded by \r).
    assert.ok(!/(?<!\r)\n/.test(section), 'expected no bare \\n (mixed EOL) in the touched section');
    assert.ok(section.includes('\r\n'), 'expected \\r\\n to be preserved in the touched section');
  });
});

// ─── quick-tasks-append: canonical row + no forced progress re-derive (#3356) ──
//
// #3356 named two independent, silent (exit 0, ok:true) defects in
// `routeQuickTasksAppend` (gsd-core/bin/gsd-tools.cjs): (1) the emitted `#`
// cell was hardcoded to a positional ordinal and `Directory` hardcoded to
// `'—'`, so the row could never match the canonical row `workflows/
// quick.md`'s Step 7c documents even though quick.md:635 (pre-fix :617)
// claimed the CLI performs "the equivalent write"; (2) the route called
// `readModifyWriteStateMd` with no `options`, so `resync` defaulted `true`
// and a single Quick Tasks body-table row append forced a full disk
// re-derive of the `progress.*` frontmatter block, silently overwriting any
// curated counters that diverge from what's on disk.
//
// Both are fixed here: `appendQuickTaskRow`'s `QuickTaskFields.quickId`
// widens the pure row constructor (unit-level, this describe block), and
// `routeQuickTasksAppend` now (a) accepts `--quick-id`/`--slug`/`--directory`
// to render the canonical row, and (b) passes `{ resync: false }`. Per
// ADR-3180 Decision 4(b) / epic #3473 B7, the two CLI-level tests below drive
// the real `gsd-tools quick-tasks-append` subcommand and assert on ITS
// emitted output / the STATE.md it writes — not on `appendQuickTaskRow`'s
// return value alone, which a helper-only test would leave unproven at the
// consumer boundary.
describe('appendQuickTaskRow quickId widening (#3356 defect 1, unit)', () => {
  const emptyState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  test('a supplied quickId renders in the `#` cell instead of the positional ordinal', () => {
    const result = appendQuickTaskRow(emptyState, {
      description: 'Arreglar quick-tasks-append',
      date: '2026-08-11',
      commit: '0d3c644',
      quickId: '260811-gfl',
      directory: '[260811-gfl-arreglar-quick-tasks-append](./quick/260811-gfl-arreglar-quick-tasks-append/)',
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.value.row,
      '| 260811-gfl | Arreglar quick-tasks-append | 2026-08-11 | 0d3c644 | [260811-gfl-arreglar-quick-tasks-append](./quick/260811-gfl-arreglar-quick-tasks-append/) |',
    );
  });

  test('omitting quickId keeps the pre-existing ordinal + \'—\' Directory fallback (fast.md, #2133, unchanged)', () => {
    const result = appendQuickTaskRow(emptyState, {
      description: 'no id supplied',
      date: '2026-08-11',
      commit: 'abc1234',
    });
    assert.equal(result.ok, true);
    assert.ok(result.value.row.startsWith('| 1 | no id supplied |'), `expected the ordinal fallback, got: ${result.value.row}`);
    assert.ok(result.value.row.endsWith('| — |'), `expected the '—' Directory fallback, got: ${result.value.row}`);
  });
});

describe('CLI: quick-tasks-append (#3356)', () => {
  const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

  /** Minimal STATE.md with a Quick Tasks table and a curated progress block. */
  function writeState(tmpDir, totalPhases) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      'progress:',
      `  total_phases: ${totalPhases}`,
      '  completed_phases: 3',
      '  total_plans: ' + totalPhases,
      '  completed_plans: 3',
      '  percent: 12',
      '---',
      '',
      '### Blockers/Concerns',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '',
    ].join('\n'));
  }

  test('defect 1: --quick-id/--slug produce the canonical quick.md Step 7c row shape', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, 25);

    const r = runGsdTools(
      ['quick-tasks-append', '--task', 'Fix thing', '--quick-id', '260811-gfl', '--slug', 'fix-thing'],
      tmpDir,
    );
    assert.ok(r.success, `quick-tasks-append should succeed: ${r.error}`);
    const out = JSON.parse(r.output);

    assert.ok(out.row.startsWith('| 260811-gfl | Fix thing |'), `expected the '#' cell to carry the quick id, got: ${out.row}`);
    assert.ok(
      out.row.endsWith('| [260811-gfl-fix-thing](./quick/260811-gfl-fix-thing/) |'),
      `expected the canonical directory permalink, got: ${out.row}`,
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    assert.ok(stateContent.includes('| 260811-gfl | Fix thing |'), 'STATE.md itself must carry the same canonical row');
  });

  test('bare --task (no id) keeps the fast.md-compatible ordinal + \'—\' row, unchanged', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, 25);

    const r = runGsdTools(['quick-tasks-append', '--task', 'Fix thing'], tmpDir);
    assert.ok(r.success, `quick-tasks-append should succeed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.ok(/^\| 1 \| Fix thing \| .* \| — \|$/.test(out.row), `expected the ordinal + em-dash fallback, got: ${out.row}`);
  });

  test('defect 2: a body-only append does not force a full progress re-derive — a curated total_phases divergent from disk survives', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Curated progress (25) deliberately diverges from what a fresh disk scan
    // would measure from the phases actually on disk (2) — the #3242 Bug A /
    // #3356 defect 2 shape: a real project whose rollup total does not match
    // this snapshot's own two phase dirs.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Alpha\n## Phase 2: Beta\n');
    writeState(tmpDir, 25);

    const r = runGsdTools(['quick-tasks-append', '--task', 'Fix thing'], tmpDir);
    assert.ok(r.success, `quick-tasks-append should succeed: ${r.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    const match = stateContent.match(/total_phases:\s*(\d+)/);
    assert.equal(
      match && match[1], '25',
      `a body-only Quick Tasks append must not re-derive progress.total_phases from disk; ` +
      `expected the curated 25 to survive, got: ${JSON.stringify(stateContent)}`,
    );
  });
});

// ─── findTableBySchema (#2242 review Fix 4) ────────────────────────────────────

describe('findTableBySchema', () => {
  test('finds a RoadmapProgress table that appears after other content, not under a "## Progress" heading', () => {
    const doc = [
      '# Roadmap',
      '',
      '## Overview',
      '',
      'Some prose describing the roadmap. No table here.',
      '',
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
    ].join('\n');

    const table = findTableBySchema(doc, 'RoadmapProgress');
    assert.notEqual(table, null);
    assert.deepEqual(table.columns, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
  });

  test('finds a RoadmapProgress table that is not the first table in the document', () => {
    const doc = [
      '# Roadmap',
      '',
      '## Legend',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');

    const table = findTableBySchema(doc, 'RoadmapProgress');
    assert.notEqual(table, null);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
  });

  test('returns null when no table matches the given schema', () => {
    const doc = [
      '# Roadmap',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
    ].join('\n');

    assert.equal(findTableBySchema(doc, 'RoadmapProgress'), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(findTableBySchema(undefined, 'RoadmapProgress'), null);
  });
});

// ─── findTableWithColumns (#2242: column-order/count-invariant reader seam) ──

describe('findTableWithColumns', () => {
  test('finds a table whose header has the required columns in shuffled order, plus extra/injected columns', () => {
    const doc = [
      '## Progress',
      '',
      '| Status | Foo | Phase | Plans Complete | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| Complete | x | 1. Alpha | 2/2 | ✅ |',
      '| In Progress | x | 2. Beta | 1/2 | |',
    ].join('\n');

    const table = findTableWithColumns(doc, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.notEqual(table, null);
    assert.deepEqual(table.columns, ['Status', 'Foo', 'Phase', 'Plans Complete', 'Completed']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
    assert.equal(table.rows[0]['Status'], 'Complete');
    assert.equal(table.rows[1]['Plans Complete'], '1/2');
  });

  test('returns null when a required column is absent from every table header', () => {
    const doc = [
      '## Progress',
      '',
      '| Phase | Owner | Completed |',
      '| --- | --- | --- |',
      '| 1. Alpha | jo | ✅ |',
    ].join('\n');

    assert.equal(findTableWithColumns(doc, ['Phase', 'Plans Complete', 'Status', 'Completed']), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(findTableWithColumns(undefined, ['Phase']), null);
  });
});

// ─── updateTableCell (ADR-2143 §7 formatting-preserving cell write) ──────────

describe('updateTableCell', () => {
  const fourCol = [
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|-----------------|--------|-----------|',
    '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
    '| 2. Beta  | 1/2 | In Progress |            |',
  ].join('\n');

  const fiveCol = [
    '| Phase | Milestone | Plans Complete | Status | Completed |',
    '|-------|-----------|-----------------|--------|-----------|',
    '| 1. Alpha | v1.0 | 2/2 | Complete    | 2026-01-01 |',
    '| 2. Beta  | v1.0 | 1/2 | In Progress |            |',
  ].join('\n');

  test('single-cell update leaves every other byte of the table identical', () => {
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    const result = updateTableCell(fourCol, byPhase, 'Status', ' Complete    ');
    assert.equal(result.ok, true);

    // Every line except the touched row's Status cell must be byte-identical.
    const beforeLines = fourCol.split('\n');
    const afterLines = result.value.split('\n');
    assert.equal(afterLines.length, beforeLines.length);
    assert.equal(afterLines[0], beforeLines[0], 'header must be untouched');
    assert.equal(afterLines[1], beforeLines[1], 'delimiter row must be untouched');
    assert.equal(afterLines[2], beforeLines[2], 'unrelated data row must be untouched');
    assert.equal(
      afterLines[3],
      '| 2. Beta  | 1/2 | Complete    |            |',
      'only the Status cell text changed, all padding/other cells preserved',
    );

    // Re-parsing still yields a valid, name-addressable table.
    const reparsed = parseMarkdownTable(result.value);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows[1]['Status'], 'Complete');
    assert.equal(reparsed.value.rows[0]['Status'], 'Complete', 'row 0 (untouched) keeps its own value');
  });

  test('function transformer receives the CURRENT trimmed cell value and its return is spliced verbatim', () => {
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    let seenCurrent = null;
    const result = updateTableCell(fourCol, byPhase, 'Completed', (current) => {
      seenCurrent = current;
      return /^\d{4}-\d{2}-\d{2}$/.test(current) ? ' NEW-DATE ' : current;
    });
    assert.equal(result.ok, true);
    assert.equal(seenCurrent, '2026-01-01');
    assert.ok(result.value.includes('NEW-DATE'));
    // The other row's Completed cell (blank) is untouched.
    assert.ok(result.value.includes('| 2. Beta  | 1/2 | In Progress |            |'));
  });

  test('unknown column returns {ok:false} without mutating anything', () => {
    const result = updateTableCell(fourCol, () => true, 'Nonexistent', 'x');
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown column/);
  });

  test('no matching row returns {ok:false}', () => {
    const result = updateTableCell(fourCol, (row) => row['Phase'] === 'does not exist', 'Status', 'x');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no matching row/);
  });

  test('no table found returns {ok:false} (delegates parseMarkdownTable\'s reason)', () => {
    const result = updateTableCell('just some prose, no table here', () => true, 'Status', 'x');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no table found/);
  });

  test('#3255: reaches a later table when the first table lacks the requested column', () => {
    // A ## Traceability section holding a phase-summary table (no Status) ABOVE
    // the requirement table (with Status). The prior code bound to the FIRST
    // table and returned 'unknown column: Status' without ever reaching the
    // requirement table, so requirements.mark-complete left the row at Pending.
    const multiTable = [
      '| Phase | Name | Requirements |',
      '|-------|------|--------------|',
      '| 1 | Portal Spec | 4 (PORTAL-01..04) |',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| AUTHZ-02 | Phase 02.2 | Pending |',
    ].join('\n');
    const byReq = (row) => (Object.values(row)[0] ?? '').trim().toLowerCase() === 'authz-02';
    const result = updateTableCell(multiTable, byReq, 'Status', ' Complete ');

    assert.equal(result.ok, true, `expected ok:true (should reach the requirement table); got: ${result && result.reason}`);
    assert.ok(result.value.includes('| Phase | Name | Requirements |'), 'first (summary) table header untouched');
    assert.ok(result.value.includes('| 1 | Portal Spec | 4 (PORTAL-01..04) |'), 'first (summary) data row untouched');
    assert.ok(/AUTHZ-02 \| Phase 02\.2 \| Complete/.test(result.value), 'second table Status cell flipped Pending → Complete');
  });

  test('5-column milestone table: Milestone cell and other columns stay byte-identical', () => {
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(fiveCol, byPhase, 'Plans Complete', ' 2/2 ');
    assert.equal(result.ok, true);
    const lines = result.value.split('\n');
    assert.equal(lines[0], fiveCol.split('\n')[0]);
    assert.equal(lines[1], fiveCol.split('\n')[1]);
    assert.equal(lines[3], fiveCol.split('\n')[3], 'row 2 (Beta) is fully untouched');
    assert.ok(lines[2].includes('v1.0'), 'Milestone cell preserved');
    assert.ok(lines[2].includes('Complete    '), 'Status cell preserved verbatim');
  });

  test('CRLF line endings are preserved (no mixed EOL introduced)', () => {
    const crlfTable = fourCol.replace(/\n/g, '\r\n');
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    const result = updateTableCell(crlfTable, byPhase, 'Status', ' Complete    ');
    assert.equal(result.ok, true);
    assert.ok(!/(?<!\r)\n/.test(result.value), 'no bare \\n introduced');
    assert.ok(result.value.includes('\r\n'));
    const reparsed = parseMarkdownTable(result.value);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows[1]['Status'], 'Complete');
  });

  test('match receives (row, index) — index is the 0-based DATA-row position', () => {
    const seenIndices = [];
    updateTableCell(fourCol, (row, i) => { seenIndices.push(i); return i === 1; }, 'Status', ' Complete    ');
    assert.deepEqual(seenIndices, [0, 1]);
  });

  // ─── Ragged-tolerance (#2245 review Fix 2) ──────────────────────────────────
  // A single sibling row whose cell count doesn't match the header must never
  // abort the whole write — updateTableCell does its own header→column→
  // per-row scan and no longer gates on parseMarkdownTable(tableText).ok.

  test('a ragged SIBLING row (extra cell) does not block updating a well-formed row', () => {
    const raggedSibling = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
      '| 2. Beta  | 1/2 | In Progress |            | extra |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(raggedSibling, byPhase, 'Status', ' Complete    ');
    assert.equal(result.ok, true, `expected the ragged sibling not to block the write, got ${JSON.stringify(result)}`);
    // The ragged row itself is untouched, byte-for-byte.
    assert.ok(result.value.includes('| 2. Beta  | 1/2 | In Progress |            | extra |'));
  });

  test('a ragged SIBLING row (missing cell) does not block updating a well-formed row', () => {
    const raggedSibling = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 2. Beta  | 1/2 | In Progress |',
      '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(raggedSibling, byPhase, 'Status', ' Complete    ');
    assert.equal(result.ok, true, `expected the ragged sibling not to block the write, got ${JSON.stringify(result)}`);
    assert.ok(result.value.includes('| 2. Beta  | 1/2 | In Progress |'));
    assert.ok(result.value.includes('| 1. Alpha | 2/2 | Complete    | 2026-01-01 |'));
  });

  test('a row matching on content but too short to physically contain the target column is skipped, not selected', () => {
    // The Beta row matches `byPhase` but has only 3 cells — no "Completed" cell
    // to splice into. It must be skipped (not selected) rather than erroring or
    // splicing garbage; a LATER well-formed row for the same match predicate
    // (here none exists) would still be reachable.
    const shortRow = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 2. Beta  | 1/2 | In Progress |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    const result = updateTableCell(shortRow, byPhase, 'Completed', ' 2026-01-01 ');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no matching row/);
  });

  // BOUNDARY coverage (limit-1 / limit / limit+1): a data row's cell count
  // relative to the 4-column header must never gate the write — only whether
  // the TARGET column is physically present in the matched row does.
  test('boundary: limit-1 (3-cell row, one short of 4 columns) still updates a present column', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 1. Alpha | 2/2 | Complete |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(src, byPhase, 'Status', ' In Progress ');
    assert.equal(result.ok, true);
    assert.ok(result.value.includes('| 1. Alpha | 2/2 | In Progress |'));
  });

  test('boundary: limit (4-cell row, exactly matching 4 columns) updates normally', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 1. Alpha | 2/2 | Complete | 2026-01-01 |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(src, byPhase, 'Completed', ' 2026-02-02 ');
    assert.equal(result.ok, true);
    assert.ok(result.value.includes('| 1. Alpha | 2/2 | Complete | 2026-02-02 |'));
  });

  test('boundary: limit+1 (5-cell row, one over 4 columns) still updates a present column, extra cell ignored', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 1. Alpha | 2/2 | Complete | 2026-01-01 | extra |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = updateTableCell(src, byPhase, 'Plans Complete', ' 3/3 ');
    assert.equal(result.ok, true);
    assert.ok(result.value.includes('| 1. Alpha | 3/3 | Complete | 2026-01-01 | extra |'));
  });

  test('newValue as a no-op-probe function reports ok:true and the current (trimmed) value', () => {
    // The callback receives the CURRENT value already trimmed/unescaped (same
    // contract as `match`'s row argument) — returning it verbatim reproduces
    // the semantic value (re-parses to the same trimmed cell text) but is NOT
    // required to reproduce the original cell's raw padding, since the
    // callback never sees that padding. This is the documented, pre-existing
    // contract (unchanged by the #2245 ragged-tolerance rewrite) — it lets a
    // caller probe "does a row match, and what's its current value" via a
    // single updateTableCell call without a separate read-only lookup.
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    let seenCurrent = null;
    const result = updateTableCell(fourCol, byPhase, 'Status', (current) => {
      seenCurrent = current;
      return current;
    });
    assert.equal(result.ok, true);
    assert.equal(seenCurrent, 'In Progress');
    const reparsed = parseMarkdownTable(result.value);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows[1]['Status'], 'In Progress', 'the probed value round-trips to the same trimmed cell text');
  });
});

// ─── deleteTableRow (ADR-2143 §7 row-removal sibling of updateTableCell) ────

describe('deleteTableRow', () => {
  const fourCol = [
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|-----------------|--------|-----------|',
    '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
    '| 2. Beta  | 1/2 | In Progress |            |',
    '| 3. Gamma | 0/2 | Planned     |            |',
  ].join('\n');

  test('deletes only the matched row; header/delimiter/other rows byte-preserved', () => {
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    const result = deleteTableRow(fourCol, byPhase);
    assert.equal(result.ok, true);

    const beforeLines = fourCol.split('\n');
    const afterLines = result.value.split('\n');
    assert.equal(afterLines.length, beforeLines.length - 1, 'exactly one line removed');
    assert.equal(afterLines[0], beforeLines[0], 'header must be untouched');
    assert.equal(afterLines[1], beforeLines[1], 'delimiter row must be untouched');
    assert.equal(afterLines[2], beforeLines[2], 'row 0 (Alpha) untouched');
    assert.equal(afterLines[3], beforeLines[4], 'row 2 (Gamma) untouched, now shifted up');
    assert.ok(!result.value.includes('2. Beta'), 'the matched row is gone');

    const reparsed = parseMarkdownTable(result.value);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows.length, 2);
  });

  test('surrounding prose (before header, after last row) is preserved byte-for-byte', () => {
    const withProse = [
      'Some intro prose.',
      '',
      fourCol,
      '',
      'Some trailing prose.',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = deleteTableRow(withProse, byPhase);
    assert.equal(result.ok, true);
    assert.ok(result.value.startsWith('Some intro prose.\n\n'), 'leading prose preserved');
    assert.ok(result.value.endsWith('\nSome trailing prose.'), 'trailing prose preserved');
    assert.ok(!result.value.includes('1. Alpha'), 'matched row gone');
    assert.ok(result.value.includes('2. Beta'), 'sibling row preserved');
    assert.ok(result.value.includes('3. Gamma'), 'sibling row preserved');
  });

  test('a ragged SIBLING row (extra cell) is tolerated and does not block deleting a well-formed row', () => {
    const raggedSibling = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
      '| 2. Beta  | 1/2 | In Progress |            | extra |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = deleteTableRow(raggedSibling, byPhase);
    assert.equal(result.ok, true, `expected the ragged sibling not to block the delete, got ${JSON.stringify(result)}`);
    assert.ok(!result.value.includes('1. Alpha'));
    assert.ok(result.value.includes('| 2. Beta  | 1/2 | In Progress |            | extra |'), 'ragged sibling untouched');
  });

  test('a ragged SIBLING row (missing cell) is tolerated and does not block deleting the target row', () => {
    const raggedSibling = [
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|-----------------|--------|-----------|',
      '| 2. Beta  | 1/2 | In Progress |',
      '| 1. Alpha | 2/2 | Complete    | 2026-01-01 |',
    ].join('\n');
    const byPhase = (row) => row['Phase'].trim() === '1. Alpha';
    const result = deleteTableRow(raggedSibling, byPhase);
    assert.equal(result.ok, true, `expected the ragged sibling not to block the delete, got ${JSON.stringify(result)}`);
    assert.ok(result.value.includes('| 2. Beta  | 1/2 | In Progress |'), 'ragged sibling preserved verbatim');
    assert.ok(!result.value.includes('1. Alpha'));
  });

  test('no matching row returns {ok:false}', () => {
    const result = deleteTableRow(fourCol, (row) => row['Phase'] === 'does not exist');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no matching row/);
  });

  test('no table found returns {ok:false}', () => {
    const result = deleteTableRow('just some prose, no table here', () => true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no table found/);
  });

  test('match receives (row, index) — index is the 0-based DATA-row position', () => {
    const seenIndices = [];
    deleteTableRow(fourCol, (row, i) => { seenIndices.push(i); return i === 1; });
    assert.deepEqual(seenIndices, [0, 1]);
  });

  test('CRLF line endings are preserved (no mixed EOL introduced), including the deleted row\'s own CRLF', () => {
    const crlfTable = fourCol.replace(/\n/g, '\r\n');
    const byPhase = (row) => row['Phase'].trim() === '2. Beta';
    const result = deleteTableRow(crlfTable, byPhase);
    assert.equal(result.ok, true);
    assert.ok(!/(?<!\r)\n/.test(result.value), 'no bare \\n introduced');
    assert.ok(result.value.includes('\r\n'));
    const reparsed = parseMarkdownTable(result.value);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[0]['Phase'], '1. Alpha');
    assert.equal(reparsed.value.rows[1]['Phase'], '3. Gamma');
  });

  test('deleting the LAST row (no trailing EOL after it) still works and leaves no dangling newline', () => {
    const noTrailingEol = fourCol; // fourCol's last line has no trailing \n
    const byPhase = (row) => row['Phase'].trim() === '3. Gamma';
    const result = deleteTableRow(noTrailingEol, byPhase);
    assert.equal(result.ok, true);
    assert.ok(result.value.endsWith('In Progress |            |'), 'ends right after the new last row, no dangling newline');
    assert.ok(!result.value.includes('3. Gamma'));
  });

  test('first-cell-value match works for a COMPACT unpadded row (no spaces around pipes)', () => {
    const compact = [
      '|Phase|Plans Complete|Status|Completed|',
      '|---|---|---|---|',
      '|1|Foo|0/2|Planned|',
      '|3|Foo|0/2|Planned|',
      '|4|Foo|0/2|Planned|',
    ].join('\n');
    const byFirstCell = (row) => (Object.values(row)[0] ?? '').trim() === '3';
    const result = deleteTableRow(compact, byFirstCell);
    assert.equal(result.ok, true, `expected the compact row to match, got ${JSON.stringify(result)}`);
    assert.ok(!result.value.includes('|3|Foo|0/2|Planned|'), 'the compact matched row is gone');
    assert.ok(result.value.includes('|1|Foo|0/2|Planned|'), 'sibling row 1 preserved');
    assert.ok(result.value.includes('|4|Foo|0/2|Planned|'), 'sibling row 4 preserved');
  });
});

// ─── PARITY / DRIFT guard: registry <-> template/workflow source files ───────

describe('TABLE_SCHEMAS parity: registry headers must appear verbatim in their source templates', () => {
  /**
   * Build the `| a | b | c |` header line for a variant and assert the given
   * source file contains it verbatim (whitespace around pipes normalized so
   * template formatting quirks don't cause false failures).
   *
   * Delegates header-building and normalization to `buildHeader`/`normalize`
   * from scripts/lint-table-schema-drift.cjs — the SAME logic the standalone
   * `lint:table-schema-drift` check runs — rather than re-implementing it
   * here, so the two can never silently diverge (ADR-2143 §3
   * Generative-Fix-Divergence guard, applied to the guard itself).
   */
  function assertHeaderInFile(relPath, variant) {
    const fullPath = path.join(ROOT, relPath);
    const content = fs.readFileSync(fullPath, 'utf8'); // allow-test-rule: source-text-is-the-product — template/registry parity (#2242)
    const expectedHeader = buildHeader(variant);
    const normalizedExpected = normalize(expectedHeader);
    const found = content
      .split(/\r?\n/)
      .some((line) => normalize(line) === normalizedExpected);
    assert.ok(
      found,
      `expected header ${JSON.stringify(expectedHeader)} to appear verbatim in ${relPath}`,
    );
  }

  test('RoadmapProgress variants appear in gsd-core/templates/roadmap.md', () => {
    for (const variant of TABLE_SCHEMAS.RoadmapProgress) {
      assertHeaderInFile('gsd-core/templates/roadmap.md', variant);
    }
  });

  test('RequirementsTraceability variant appears in gsd-core/templates/requirements.md', () => {
    for (const variant of TABLE_SCHEMAS.RequirementsTraceability) {
      assertHeaderInFile('gsd-core/templates/requirements.md', variant);
    }
  });

  test('QuickTasks variants appear in gsd-core/workflows/quick.md', () => {
    for (const variant of TABLE_SCHEMAS.QuickTasks) {
      assertHeaderInFile('gsd-core/workflows/quick.md', variant);
    }
  });

  test('Security variants appear in gsd-core/templates/SECURITY.md', () => {
    for (const variant of TABLE_SCHEMAS.Security) {
      assertHeaderInFile('gsd-core/templates/SECURITY.md', variant);
    }
  });
});

// ─── Quick Tasks heading tolerance (#3860) ────────────────────────────────────

describe('Quick Tasks heading tolerance (#3860)', () => {
  // Byte-identical table body to the bare-heading control — only the heading
  // suffix differs, which is exactly the reporter's isolation.
  const suffixedState = [
    '# STATE',
    '',
    '### Quick Tasks Completed (v1.1+)',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  const multiMilestoneState = [
    '# STATE',
    '',
    '### Quick Tasks Completed (v1.1+)',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 250101-abc | first v1.1 task | 2025-01-01 | 0123abc | [dir](./quick/250101-abc/) |',
    '',
    '### Quick Tasks Completed (v1.0)',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | legacy v1.0 task | 2024-06-01 | old1234 | — |',
  ].join('\n');

  // v1.0 first in document order with a LEGACY (unrecognized) schema — the
  // usable v1.1+ table below it must not be shadowed (#3860 "worth deciding
  // deliberately rather than inheriting from document order").
  const legacyFirstState = [
    '# STATE',
    '',
    '### Quick Tasks Completed (v1.0)',
    '',
    '| Date | Slug | Scope | Artifacts |',
    '|------|------|-------|-----------|',
    '| 2024-06-01 | old | full | — |',
    '',
    '### Quick Tasks Completed (v1.1+)',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
  ].join('\n');

  test('appendQuickTaskRow locates a milestone-suffixed heading', () => {
    const result = appendQuickTaskRow(suffixedState, {
      description: 'probe',
      date: '2026-08-25',
      commit: 'deadbee',
    });
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    assert.ok(result.value.content.includes('| 2 | probe | 2026-08-25 | deadbee | — |'));
    assert.ok(result.value.content.includes('### Quick Tasks Completed (v1.1+)'), 'the suffixed heading itself is untouched');
  });

  test('resetQuickTaskRows clears a milestone-suffixed heading', () => {
    const result = resetQuickTaskRows(suffixedState);
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    assert.equal(result.value.cleared, 1);
    assert.ok(!result.value.content.includes('fix typo'));
    assert.ok(result.value.content.includes('### Quick Tasks Completed (v1.1+)'));
  });

  test('bare "Quick Tasks Completedness" is NOT matched (word boundary holds)', () => {
    const notQuick = suffixedState.replace(
      '### Quick Tasks Completed (v1.1+)',
      '### Quick Tasks Completedness (v1.1+)',
    );
    const result = appendQuickTaskRow(notQuick, { description: 'x', date: '2026-08-25', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, QUICK_TASKS_SECTION_ABSENT, 'a different section name must still be absent');
  });

  test('multiple milestone sections: appends to the one holding the canonical table', () => {
    const result = appendQuickTaskRow(multiMilestoneState, {
      description: 'second v1.1 task',
      date: '2025-02-02',
      commit: '0456def',
    });
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    assert.ok(result.value.content.includes('second v1.1 task'));
    const v11 = result.value.content.indexOf('### Quick Tasks Completed (v1.1+)');
    const v10 = result.value.content.indexOf('### Quick Tasks Completed (v1.0)');
    assert.ok(
      result.value.content.indexOf('second v1.1 task') > v11 && result.value.content.indexOf('second v1.1 task') < v10,
      'the row lands in the v1.1+ section (the one whose table matched the canonical schema), not the v1.0 section'
    );
    assert.ok(
      result.value.content.includes('| 1 | legacy v1.0 task | 2024-06-01 | old1234 | — |'),
      'the v1.0 row is present byte-identical (only the v1.1+ table gained a row)'
    );
  });

  test('a legacy-schema section first in document order does not shadow a usable one', () => {
    const result = appendQuickTaskRow(legacyFirstState, {
      description: 'new task',
      date: '2026-08-25',
      commit: 'deadbee',
    });
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    assert.ok(
      result.value.content.includes('| 2 | new task | 2026-08-25 | deadbee | — |'),
      'appends to the v1.1+ canonical table below the legacy v1.0 one'
    );
    assert.ok(!result.value.content.includes('unrecognized'), 'no schema complaint when a usable section exists');
  });

  test('when NO matching section is usable, the error names the real problem (first section\'s)', () => {
    const onlyLegacy = legacyFirstState.slice(0, legacyFirstState.indexOf('### Quick Tasks Completed (v1.1+)'));
    const result = appendQuickTaskRow(onlyLegacy, { description: 'x', date: '2026-08-25', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.ok(
      result.reason.includes('unrecognized Quick Tasks schema'),
      `the failure must describe the legacy table, not claim the section is absent; got: ${result.reason}`
    );
  });

  test('#3860 review: a later ## Deferred Items pipe table is NOT the splice target', () => {
    // The canonical STATE.md layout (templates/state.md + workflows/quick.md)
    // puts a pipe table AFTER the Quick Tasks section. A section-body
    // collection that only stops at the next matching heading would swallow
    // it, and the append's last-table-line scan would splice the quick-task
    // row into the Deferred Items table.
    const canonicalLayout = [
      '# STATE',
      '',
      '### Quick Tasks Completed (v1.1+)',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
      '',
      '### Blockers/Concerns',
      'None',
      '',
      '## Deferred Items',
      '',
      '| Category | Item | Status | Deferred At | Milestone |',
      '|----------|------|--------|-------------|-----------|',
      '| scope | extra thing | deferred | 2026-01-02 | v1.1 |',
      '',
    ].join('\n');
    const result = appendQuickTaskRow(canonicalLayout, {
      description: 'probe',
      date: '2026-08-25',
      commit: 'deadbee',
    });
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    const content = result.value.content;
    const quickRow = '| 2 | probe | 2026-08-25 | deadbee | — |';
    assert.ok(content.includes(quickRow), 'the new row exists');
    assert.ok(
      content.indexOf(quickRow) < content.indexOf('## Deferred Items'),
      'the row lands INSIDE the Quick Tasks table, before the Deferred Items section'
    );
    assert.ok(
      content.includes('| scope | extra thing | deferred | 2026-01-02 | v1.1 |'),
      'the Deferred Items table is byte-identical (no row spliced after its last line)'
    );
    const deferred = content.slice(content.indexOf('## Deferred Items'));
    assert.ok(!deferred.includes(quickRow), 'the Deferred Items section contains no quick-task row');
  });

  test('#3860 convention: several schema-valid sections — document order (newest-on-top) wins', () => {
    // The archive flow preserves a recognized header-only table under the old
    // heading (workflows/complete-milestone.md), so both sections can be
    // schema-valid. This layer has no active-milestone signal; the pinned
    // tie-break is document order — first section — matching the issue's own
    // newest-on-top layout.
    const bothValid = [
      '# STATE',
      '',
      '### Quick Tasks Completed (v1.1+)',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | current task | 2026-01-01 | abc1234 | — |',
      '',
      '### Quick Tasks Completed (v1.0)',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 99 | archived task | 2025-01-01 | old1234 | — |',
    ].join('\n');
    const result = appendQuickTaskRow(bothValid, {
      description: 'new task',
      date: '2026-08-25',
      commit: 'deadbee',
    });
    assert.equal(result.ok, true, `reason: ${result.reason}`);
    const v11 = result.value.content.indexOf('### Quick Tasks Completed (v1.1+)');
    const v10 = result.value.content.indexOf('### Quick Tasks Completed (v1.0)');
    assert.ok(
      result.value.content.indexOf('| 2 | new task | 2026-08-25 | deadbee | — |') > v11
        && result.value.content.indexOf('| 2 | new task | 2026-08-25 | deadbee | — |') < v10,
      'the row lands in the FIRST (newest-on-top) section'
    );
  });
});

// ─── resetQuickTaskRows (#2142) ─────────────────────────────────────────────

describe('resetQuickTaskRows (#2142)', () => {
  const noStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
    '| 2 | bump version | 2026-01-02 | def5678 | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  const withStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Status | Directory |',
    '|---|-------------|------|--------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | Pass | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  const emptyNoStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  test('reset clears all rows in a 5-col no-status table; header/delimiter byte-identical, variant no-status, cleared=2', () => {
    const beforeLines = noStatusState.split('\n');
    const result = resetQuickTaskRows(noStatusState);
    assert.equal(result.ok, true);
    assert.equal(result.value.cleared, 2);
    assert.equal(result.value.variant, 'no-status');

    const afterLines = result.value.content.split('\n');
    assert.equal(afterLines[4], beforeLines[4], 'header row byte-identical');
    assert.equal(afterLines[5], beforeLines[5], 'delimiter row byte-identical');
    assert.ok(!result.value.content.includes('fix typo'));
    assert.ok(!result.value.content.includes('bump version'));

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows.length, 0);
  });

  test('reset preserves the 6-col with-status header; variant with-status', () => {
    const result = resetQuickTaskRows(withStatusState);
    assert.equal(result.ok, true);
    assert.equal(result.value.variant, 'with-status');
    assert.equal(result.value.cleared, 1);
    assert.ok(!result.value.content.includes('fix typo'));

    const headerLine = withStatusState.split('\n')[4];
    assert.ok(result.value.content.includes(headerLine), 'the 6-col header must survive verbatim');
  });

  test('reset is a no-op on an already-empty Quick Tasks table', () => {
    const result = resetQuickTaskRows(emptyNoStatusState);
    assert.equal(result.ok, true);
    assert.equal(result.value.cleared, 0);
    assert.equal(result.value.content, emptyNoStatusState, 'content must be byte-identical when there were zero rows');
  });

  test('refuses to reset an unrecognized Quick Tasks schema, leaving rows intact', () => {
    const garbled = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Thing | When |',
      '|---|-------|------|',
      '| 1 | fix typo | 2026-01-01 |',
    ].join('\n');
    const before = garbled;

    const result = resetQuickTaskRows(garbled);
    assert.equal(result.ok, false);
    assert.match(result.reason, /unrecognized/);
    // The caller-owned content must never be mutated on a refused write.
    assert.equal(garbled, before);
    assert.ok(garbled.includes('| 1 | fix typo | 2026-01-01 |'), 'the original row must still be present — no write occurred');
  });

  test('empty input and non-string input both return a typed failure, never throw', () => {
    let r1;
    let r2;
    assert.doesNotThrow(() => { r1 = resetQuickTaskRows(''); });
    assert.equal(r1.ok, false);
    assert.doesNotThrow(() => { r2 = resetQuickTaskRows(42); });
    assert.equal(r2.ok, false);
  });

  test('fails loud with a reason when the Quick Tasks Completed section is absent', () => {
    const noSection = '# STATE\n\n### Blockers/Concerns\nNone\n';
    const result = resetQuickTaskRows(noSection);
    assert.equal(result.ok, false);
    assert.equal(result.reason, QUICK_TASKS_SECTION_ABSENT);
  });

  test('CRLF input keeps \\r\\n in the touched section (no mixed EOL)', () => {
    const crlfState = noStatusState.replace(/\n/g, '\r\n');
    const result = resetQuickTaskRows(crlfState);
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    assert.ok(!/(?<!\r)\n/.test(section), 'expected no bare \\n (mixed EOL) in the touched section');
    assert.ok(section.includes('\r\n'), 'expected \\r\\n to be preserved');
  });

  test('an unrelated preceding table (different schema) is untouched; only the quick table is cleared', () => {
    const doc = [
      '# STATE',
      '',
      '## Roadmap Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
      '',
      '### Blockers/Concerns',
      'None',
    ].join('\n');

    const result = resetQuickTaskRows(doc);
    assert.equal(result.ok, true);
    assert.equal(result.value.cleared, 1);
    assert.ok(
      result.value.content.includes('| 1. Alpha | 2/2 | Complete | ✅ |'),
      'the unrelated RoadmapProgress row must survive untouched',
    );
    assert.ok(!result.value.content.includes('fix typo'));
  });

  test('property: reset always clears exactly the input row count and never touches the header line', () => {
    const rowCountArb = fc.integer({ min: 0, max: 50 });
    fc.assert(
      fc.property(rowCountArb, (n) => {
        const rows = [];
        for (let i = 1; i <= n; i++) {
          rows.push(`| ${i} | task ${i} | 2026-01-01 | abc${String(i).padStart(4, '0')} | — |`);
        }
        const state = [
          '# STATE',
          '',
          '### Quick Tasks Completed',
          '',
          '| # | Description | Date | Commit | Directory |',
          '|---|-------------|------|--------|-----------|',
          ...rows,
          '',
          '### Blockers/Concerns',
          'None',
        ].join('\n');
        const headerLine = state.split('\n')[4];

        const result = resetQuickTaskRows(state);
        assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
        assert.equal(result.value.cleared, n);
        assert.ok(result.value.content.includes(headerLine), 'header line must be unchanged');
      }),
      { seed: 20260817, numRuns: 50 },
    );
  });
});

describe('migrateQuickTasksTable (#3730 option b)', () => {
  const legacyState = (eol = '\n') => [
    '# State',
    '',
    '## Quick Tasks Completed',
    '',
    '| Date | Slug | Scope | Artifacts |',
    '|------|------|-------|-----------|',
    '| 2026-04-17 | 260417-abc | bootstrap | roles/x |',
    '| 2026-05-02 | 260502-def | cli | quick/y |',
  ].join(eol) + eol;

  test('migrates the legacy pre-registry schema', () => {
    const r = migrateQuickTasksTable(legacyState());
    assert.equal(r.ok, true, `migrate failed: ${r.reason}`);
    assert.equal(r.value.migrated, true);
    assert.ok(r.value.content.includes('| # | Description | Date | Commit | Status | Directory |'),
      'canonical with-status header is written');
    assert.ok(r.value.content.includes('| 1 | 260417-abc · bootstrap | 2026-04-17 | — | — | roles/x |'),
      'Slug+Scope bucket into Description; Artifacts maps to Directory; # renumbered');
    assert.ok(r.value.content.includes('| 2 | 260502-def · cli | 2026-05-02 | — | — | quick/y |'),
      'every data row migrates');
    assert.ok(!r.value.content.includes('| Date | Slug |'), 'the legacy header is gone');
  });

  test('keeps unknown-named columns losslessly in the Description bucket', () => {
    const state = [
      '# State', '', '## Quick Tasks Completed', '',
      '| Date | Owner |', '|------|-------|', '| 2026-04-17 | sim |',
    ].join('\n');
    const r = migrateQuickTasksTable(state);
    assert.equal(r.ok, true);
    assert.ok(r.value.content.includes('Owner: sim'), 'unknown column keeps its name: value');
  });

  test('no-ops a canonical table (byte-identical)', () => {
    const canonical = [
      '# State', '', '## Quick Tasks Completed', '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | existing | 2026-04-17 | deadbee | ./quick/a/ |',
    ].join('\n');
    const r = migrateQuickTasksTable(canonical);
    assert.equal(r.ok, true);
    assert.equal(r.value.migrated, false);
    assert.equal(r.value.content, canonical);
  });

  test('no-ops an absent section (absence is normal, #2142)', () => {
    const r = migrateQuickTasksTable('# State\n\n## Other\n');
    assert.equal(r.ok, true);
    assert.equal(r.value.migrated, false);
  });

  test('fails loud on an unparseable table', () => {
    const state = '# State\n\n## Quick Tasks Completed\n\nnot a table\n';
    const r = migrateQuickTasksTable(state);
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0, 'carries the parse failure reason');
  });

  test('preserves CRLF section endings', () => {
    const r = migrateQuickTasksTable(legacyState('\r\n'));
    assert.equal(r.ok, true);
    assert.ok(r.value.content.includes('\r\n'), 'CRLF preserved');
    assert.ok(!/[^\r]\n/.test(r.value.content.split('## Quick Tasks Completed')[1] || ''),
      'no mixed EOL introduced into the section');
  });

  test('a migrated table is appendable (round-trip)', () => {
    const migrated = migrateQuickTasksTable(legacyState());
    const appended = appendQuickTaskRow(migrated.value.content, {
      description: 'probe', date: '2026-08-20', commit: 'deadbee', directory: './quick/probe/',
    });
    assert.equal(appended.ok, true, `append after migrate failed: ${appended.reason}`);
    assert.ok(appended.value.row.includes('probe'));
  });
});

describe('quick-tasks-migrate CLI and workflow wiring (#3730)', () => {
  const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
  const fs = require('node:fs');
  const path = require('node:path');

  test('quick-tasks-migrate CLI round-trip', (t) => {
    const tmpDir = createTempProject('gsd-3730-cli-');
    t.after(() => cleanup(tmpDir));
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '# State', '', '## Quick Tasks Completed', '',
      '| Date | Slug | Scope | Artifacts |',
      '|------|------|-------|-----------|',
      '| 2026-04-17 | 260417-abc | bootstrap | roles/x |',
    ].join('\n'));

    const first = runGsdTools('quick-tasks-migrate', tmpDir);
    assert.equal(first.success, true, `migrate failed: ${first.error}`);
    const firstOut = JSON.parse(first.output);
    assert.equal(firstOut.migrated, true);
    assert.deepEqual(firstOut.from, ['Date', 'Slug', 'Scope', 'Artifacts']);
    assert.ok(fs.readFileSync(statePath, 'utf8').includes('| # | Description | Date | Commit | Status | Directory |'),
      'STATE.md rewritten to canonical');

    const second = runGsdTools('quick-tasks-migrate', tmpDir);
    assert.equal(second.success, true, `second migrate failed: ${second.error}`);
    assert.equal(JSON.parse(second.output).migrated, false, 'a canonical table is a no-op');
  });

  test('quick and fast run the migration check first', () => {
    const fast = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'fast.md'), 'utf8');
    const quick = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md'), 'utf8');
    // Compare the INVOCATIONS, not first prose mentions — fast.md's prose
    // names the append helper (~line 77) before the bash block that runs both.
    const fastMigrate = fast.indexOf('gsd_run quick-tasks-migrate');
    const fastAppend = fast.indexOf('gsd_run quick-tasks-append');
    assert.ok(fastMigrate !== -1, 'fast.md invokes quick-tasks-migrate');
    assert.ok(fastAppend !== -1 && fastMigrate < fastAppend, 'the migration runs BEFORE the append');
    assert.ok(quick.includes('quick-tasks-migrate'),
      'quick.md documents and invokes the migration path (#3730)');
  });
});
