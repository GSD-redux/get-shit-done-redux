'use strict';

/**
 * Broken-windows ledger — behavioral + property tests.
 *
 * Module: gsd-core/bin/lib/broken-windows.cjs (compiled from src/broken-windows.cts)
 * CLI:    gsd-tools windows <status|append|waive|fixed>
 *
 * Issue: #1950 — enforced cross-phase defect register gating /gsd-ship.
 *
 * Coverage map (acceptance criteria from #1950):
 *   - Executor writes stubs to ledger          → append (CLI + pure)
 *   - /gsd-ship fails while any entry is open   → openCount + cmdWindowsStatus
 *   - Waive requires non-empty reason           → markWaived / cmdWindowsWaive
 *   - Marking fixed removes from blocking set   → markFixed / cmdWindowsMarkFixed
 *   - Open-window count in progress surface     → cmdWindowsStatus emits open_count
 *   - Tests cover all four + clean-on-empty     → empty ledger + full lifecycle
 *
 * Hermetic: each CLI test uses its own tmpdir via createTempDir and cleans up
 * via t.after() (CONTRIBUTING.md pattern 2). No shared state between tests.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  REASON,
  WindowsError,
  LEDGER_FILE_NAME,
  emptyLedger,
  parseLedger,
  renderLedger,
  appendWindow,
  markWaived,
  markFixed,
  openCount,
} = require('../gsd-core/bin/lib/broken-windows.cjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Construct a minimal valid WindowEntry input for tests. */
function makeEntry(overrides = {}) {
  return {
    kind: 'stub',
    phase: '2',
    description: 'hardcoded empty list',
    ...overrides,
  };
}

/** Validator: matches a WindowsError carrying a specific REASON code. */
function reasonIs(code) {
  return (err) => err instanceof WindowsError && err.reason === code;
}

// ---------------------------------------------------------------------------
// Pure: emptyLedger + openCount
// ---------------------------------------------------------------------------

describe('broken-windows: emptyLedger + openCount', () => {
  test('emptyLedger returns a ledger with zero counts and schema_version 1', () => {
    const led = emptyLedger('2026-07-19T00:00:00Z');
    assert.equal(led.schema_version, 1);
    assert.equal(led.open_count, 0);
    assert.equal(led.waived_count, 0);
    assert.equal(led.fixed_count, 0);
    assert.equal(led.total_count, 0);
    assert.equal(led.last_updated, '2026-07-19T00:00:00Z');
    assert.deepEqual(led.entries, []);
  });

  test('openCount of empty ledger is 0 (clean-ship baseline)', () => {
    assert.equal(openCount(emptyLedger('now')), 0);
  });
});

// ---------------------------------------------------------------------------
// Pure: appendWindow
// ---------------------------------------------------------------------------

describe('broken-windows: appendWindow', () => {
  test('appending to an empty ledger assigns id=1, status=open, records timestamps', () => {
    const led0 = emptyLedger('2026-07-19T00:00:00Z');
    const { ledger, entry } = appendWindow(led0, makeEntry(), { now: '2026-07-19T12:00:00Z' });

    assert.equal(entry.id, 1);
    assert.equal(entry.status, 'open');
    assert.equal(entry.recorded_at, '2026-07-19T12:00:00Z');
    assert.equal(entry.resolved_at, null);
    assert.equal(ledger.open_count, 1);
    assert.equal(ledger.total_count, 1);
    assert.equal(ledger.last_updated, '2026-07-19T12:00:00Z');
  });

  test('second append gets id=2 (ids are dense and monotonic)', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry({ description: 'first' }), { now: 't1' }));
    ({ ledger: led } = appendWindow(led, makeEntry({ description: 'second' }), { now: 't2' }));
    assert.equal(led.entries[0].id, 1);
    assert.equal(led.entries[1].id, 2);
    assert.equal(led.total_count, 2);
    assert.equal(openCount(led), 2);
  });

  test('append rejects unknown kind (fail-closed on schema drift)', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => appendWindow(led, makeEntry({ kind: 'bogus' })),
      reasonIs(REASON.WINDOWS_INVALID_KIND),
    );
  });

  test('append rejects empty description (no vacuous windows)', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => appendWindow(led, makeEntry({ description: '' })),
      reasonIs(REASON.WINDOWS_APPEND_MISSING_FIELD),
    );
    assert.throws(
      () => appendWindow(led, makeEntry({ description: '   ' })),
      reasonIs(REASON.WINDOWS_APPEND_MISSING_FIELD),
    );
  });

  test('append rejects path-traversal in --file (security boundary)', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => appendWindow(led, makeEntry({ file: '../../etc/passwd' })),
      reasonIs(REASON.WINDOWS_INVALID_FILE),
    );
  });

  test('append rejects 4-backtick run in description (H1 regression — would brick the JSON fence)', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => appendWindow(led, makeEntry({ description: 'see ```` four backticks' })),
      reasonIs(REASON.WINDOWS_INVALID_TEXT),
    );
    // 3-backtick run is fine — the fence is 4-tick so 3-tick content is safe.
    const led2 = emptyLedger('now');
    const { ledger } = appendWindow(led2, makeEntry({ description: 'see ```js``` inline' }), { now: 't' });
    assert.equal(ledger.entries[0].description, 'see ```js``` inline');
    // And reparses cleanly:
    assert.doesNotThrow(() => parseLedger(renderLedger(ledger)));
  });

  test('renderTable escapes backslash before pipe (CodeQL: incomplete-sanitization — PR #2441)', () => {
    // A description containing `\|` must NOT split the markdown table cell.
    // Escape order: `\` → `\\` first, then `|` → `\|`. If pipe is escaped first,
    // `\|` in input becomes `\\|` in output which markdown renders as `\` + cell-sep.
    const led0 = emptyLedger('2026-07-19T00:00:00Z');
    const { ledger } = appendWindow(
      led0,
      makeEntry({ description: 'path with \\| separator and | pipe and \\ backslash' }),
      { now: '2026-07-19T12:00:00Z' },
    );
    const rendered = renderLedger(ledger);

    // The JSON block (source of truth) preserves the description verbatim and reparses.
    const reparsed = parseLedger(rendered);
    assert.equal(reparsed.entries[0].description, 'path with \\| separator and | pipe and \\ backslash');

    // The table row for this entry has exactly 10 cells (one per column). Counting
    // unescaped pipes inside the row would surface a split. The cell's rendered
    // form is `path with \\| separator and \| pipe and \\ backslash` — every pipe
    // is preceded by a backslash, so splitting on /(?<!\\)\|/ yields 10 cells.
    const tableLine = rendered.split('\n').find((l) => l.includes('path with'));
    assert.ok(tableLine, 'table row for the test entry must exist');
    // Walk the line and count pipes that are NOT preceded by a backslash.
    let unescapedPipes = 0;
    for (let i = 0; i < tableLine.length; i++) {
      if (tableLine[i] === '|' && tableLine[i - 1] !== '\\') unescapedPipes++;
    }
    // 10 cells = 11 cell-separator pipes per row (leading + 9 internal + trailing).
    assert.equal(unescapedPipes, 11, 'table row must have exactly 11 unescaped pipes (10 cells) — backslash-pipe in description must NOT add a split');
  });
});

// ---------------------------------------------------------------------------
// Pure: markWaived (acceptance: waive requires non-empty reason)
// ---------------------------------------------------------------------------

describe('broken-windows: markWaived', () => {
  test('waive with non-empty reason succeeds; waived_count increments; open_count decrements', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    led = markWaived(led, 1, 'Manual QA covers it', { now: 't2' });

    assert.equal(led.entries[0].status, 'waived');
    assert.equal(led.entries[0].reason, 'Manual QA covers it');
    assert.equal(led.entries[0].resolved_at, 't2');
    assert.equal(led.open_count, 0);
    assert.equal(led.waived_count, 1);
    assert.equal(openCount(led), 0); // waived does not block
  });

  test('waive with empty reason throws (boundary: limit-1 = 0 chars)', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    assert.throws(
      () => markWaived(led, 1, ''),
      reasonIs(REASON.WINDOWS_WAIVE_REASON_EMPTY),
    );
  });

  test('waive with whitespace-only reason throws (boundary: limit = spaces)', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    assert.throws(
      () => markWaived(led, 1, '   '),
      reasonIs(REASON.WINDOWS_WAIVE_REASON_EMPTY),
    );
  });

  test('waive with single-char reason succeeds (boundary: limit+1 = 1 char)', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    led = markWaived(led, 1, 'x', { now: 't2' });
    assert.equal(led.entries[0].status, 'waived');
  });

  test('waive unknown id throws', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => markWaived(led, 999, 'reason'),
      reasonIs(REASON.WINDOWS_ID_NOT_FOUND),
    );
  });

  test('waive on already-resolved entry throws (no double-resolution)', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    led = markFixed(led, 1, { now: 't2' });
    assert.throws(
      () => markWaived(led, 1, 'late', { now: 't3' }),
      reasonIs(REASON.WINDOWS_ALREADY_RESOLVED),
    );
  });
});

// ---------------------------------------------------------------------------
// Pure: markFixed (acceptance: fixed removes from blocking set)
// ---------------------------------------------------------------------------

describe('broken-windows: markFixed', () => {
  test('fixed decrements open_count and increments fixed_count', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    led = markFixed(led, 1, { now: 't2' });

    assert.equal(led.entries[0].status, 'fixed');
    assert.equal(led.entries[0].resolved_at, 't2');
    assert.equal(led.open_count, 0);
    assert.equal(led.fixed_count, 1);
    assert.equal(openCount(led), 0);
  });

  test('fixed on unknown id throws', () => {
    const led = emptyLedger('now');
    assert.throws(
      () => markFixed(led, 999),
      reasonIs(REASON.WINDOWS_ID_NOT_FOUND),
    );
  });

  test('fixed on already-resolved throws', () => {
    let led = emptyLedger('now');
    ({ ledger: led } = appendWindow(led, makeEntry(), { now: 't1' }));
    led = markWaived(led, 1, 'have it', { now: 't2' });
    assert.throws(
      () => markFixed(led, 1, { now: 't3' }),
      reasonIs(REASON.WINDOWS_ALREADY_RESOLVED),
    );
  });
});

// ---------------------------------------------------------------------------
// Pure: parseLedger / renderLedger roundtrip (property test, fast-check)
// ---------------------------------------------------------------------------

describe('broken-windows: parse/render roundtrip property', () => {
  const arbKind = fc.constantFrom('stub', 'todo', 'fixme', 'skipped-test', 'lint-warning', 'unmet-truth', 'unrun-verify', 'deviation');
  const arbStatus = fc.constantFrom('open', 'waived', 'fixed');
  const arbPhase = fc.integer({ min: 1, max: 99 }).map(n => String(n));
  const arbText = fc.string({ minLength: 1, maxLength: 80 }).map(s => s.replace(/[\r\n\t|]/g, ' ').trim() || 'x');

  const arbEntry = fc.record({
    id: fc.integer({ min: 1, max: 1000 }),
    kind: arbKind,
    phase: arbPhase,
    description: arbText,
    status: arbStatus,
  }).map((e) => ({
    id: e.id,
    kind: e.kind,
    phase: e.phase,
    file: e.id % 2 === 0 ? '' : `src/file${e.id}.ts`,
    line: e.id % 2 === 0 ? null : e.id * 10,
    description: e.description,
    status: e.status,
    reason: e.status === 'waived' ? 'justified' : '',
    recorded_at: '2026-07-19T00:00:00Z',
    resolved_at: e.status === 'open' ? null : '2026-07-19T01:00:00Z',
  }));

  const arbLedger = fc.array(arbEntry, { maxLength: 6 }).map((entries) => {
    const open = entries.filter(e => e.status === 'open').length;
    const waived = entries.filter(e => e.status === 'waived').length;
    const fixed = entries.filter(e => e.status === 'fixed').length;
    return {
      schema_version: 1,
      open_count: open,
      waived_count: waived,
      fixed_count: fixed,
      total_count: entries.length,
      last_updated: '2026-07-19T00:00:00Z',
      entries,
    };
  });

  test('property: render(parse(render(ledger))) === render(ledger)', () => {
    fc.assert(fc.property(arbLedger, (ledger) => {
      const rendered1 = renderLedger(ledger);
      const parsed = parseLedger(rendered1);
      const rendered2 = renderLedger(parsed);
      assert.equal(rendered2, rendered1, 'roundtrip must be stable');
    }));
  });

  test('property: parseLedger never hangs or crashes on arbitrary unicode strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (raw) => {
      try { parseLedger(raw); } catch { /* malformed input is allowed to throw */ }
    }));
  });
});

// ---------------------------------------------------------------------------
// Pure: parseLedger fail-closed on malformed input
// ---------------------------------------------------------------------------

describe('broken-windows: parseLedger fail-closed', () => {
  test('rejects frontmatter with wrong schema_version', () => {
    const raw = [
      '---',
      'schema_version: 99',
      'open_count: 0',
      'waived_count: 0',
      'fixed_count: 0',
      'total_count: 0',
      'last_updated: 2026-07-19T00:00:00Z',
      '---',
      '',
      '```json',
      '[]',
      '```',
      '',
    ].join('\n');
    assert.throws(() => parseLedger(raw), reasonIs(REASON.WINDOWS_LEDGER_MALFORMED));
  });

  test('rejects frontmatter missing open_count', () => {
    const raw = [
      '---',
      'schema_version: 1',
      '---',
      '',
      '```json',
      '[]',
      '```',
      '',
    ].join('\n');
    assert.throws(() => parseLedger(raw), reasonIs(REASON.WINDOWS_LEDGER_MALFORMED));
  });

  test('rejects frontmatter with non-numeric open_count', () => {
    const raw = [
      '---',
      'schema_version: 1',
      'open_count: "zero"',
      '---',
      '',
      '```json',
      '[]',
      '```',
      '',
    ].join('\n');
    assert.throws(() => parseLedger(raw), reasonIs(REASON.WINDOWS_LEDGER_MALFORMED));
  });
});

// ---------------------------------------------------------------------------
// CLI: gsd-tools windows status (acceptance: clean-ship on empty)
// ---------------------------------------------------------------------------

describe('broken-windows CLI: windows status', () => {
  test('status on a project with no ledger returns open_count=0 (backward-compat baseline)', (t) => {
    const tmp = createTempDir('bw-status-empty-');
    t.after(() => cleanup(tmp));

    const res = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(res.success, true, `stderr: ${res.error || ''}`);
    const obj = JSON.parse(res.output);
    assert.equal(obj.ok, true);
    assert.equal(obj.ledger.open_count, 0);
    assert.deepEqual(obj.ledger.entries, []);
  });

  test('status on a malformed ledger fails closed', (t) => {
    const tmp = createTempDir('bw-status-malformed-');
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', LEDGER_FILE_NAME),
      'not valid markdown or frontmatter',
    );

    const res = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(res.success, false);
    assert.ok(res.exitCode !== 0);
    assert.match(res.error, /malformed|invalid frontmatter|missing frontmatter/i);
  });

  test('status on an UNREADABLE ledger fails closed (H2 regression — EACCES must not be silently empty)', (t) => {
    // Skip on Windows where chmod 000 doesn't apply to root/admin or where the FS
    // ignores mode bits; CI lanes run as non-root so the EACCES path is real.
    const tmp = createTempDir('bw-status-eacces-');
    t.after(() => {
      try { fs.chmodSync(path.join(tmp, '.planning', LEDGER_FILE_NAME), 0o644); } catch { /* best-effort */ }
      cleanup(tmp);
    });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    // A ledger with open_count=1 — if EACCES silently returned empty, ship gate would pass.
    const validLedger = [
      '---',
      'schema_version: 1',
      'open_count: 1',
      'waived_count: 0',
      'fixed_count: 0',
      'total_count: 1',
      'last_updated: 2026-07-19T00:00:00Z',
      '---',
      '',
      '````json',
      JSON.stringify([{
        id: 1, kind: 'stub', phase: '2', file: '', line: null,
        description: 'unreadable-test', status: 'open', reason: '',
        recorded_at: 't', resolved_at: null,
      }]),
      '````',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, '.planning', LEDGER_FILE_NAME), validLedger);
    try { fs.chmodSync(path.join(tmp, '.planning', LEDGER_FILE_NAME), 0o000); } catch { return; }

    const res = runGsdTools(['windows', 'status', '--raw'], tmp);
    // If the chmod actually took (non-root), the read must fail. If running as
    // root (CI rarely does), the read may succeed — either way, the test must
    // never see a false-green "open_count: 0" from a file we KNOW has open_count=1.
    if (res.success) {
      const obj = JSON.parse(res.output);
      assert.notEqual(obj.ledger.open_count, 0, 'EACCES must NOT silently coerce an open_count=1 ledger to 0');
    } else {
      assert.match(res.error, /could not read|EACCES|malformed/i);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI: gsd-tools windows append (acceptance: executor writes stubs)
// ---------------------------------------------------------------------------

describe('broken-windows CLI: windows append', () => {
  test('append creates the ledger if absent and records the entry', (t) => {
    const tmp = createTempDir('bw-append-create-');
    t.after(() => cleanup(tmp));

    const res = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2',
       '--file', 'src/auth.ts', '--line', '42',
       '--description', 'hardcoded empty list in UserService.list'],
      tmp,
    );
    assert.equal(res.success, true, `stderr: ${res.error || ''}`);
    const obj = JSON.parse(res.output);
    assert.equal(obj.ok, true);
    assert.equal(obj.entry.id, 1);
    assert.equal(obj.entry.status, 'open');
    assert.equal(obj.ledger.open_count, 1);

    // File exists with the right frontmatter and is re-readable.
    const ledgerPath = path.join(tmp, '.planning', LEDGER_FILE_NAME);
    assert.equal(fs.existsSync(ledgerPath), true);

    // Second invocation observes the persisted entry (idempotent read).
    const res2 = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(res2.success, true);
    const obj2 = JSON.parse(res2.output);
    assert.equal(obj2.ledger.open_count, 1);
    assert.equal(obj2.ledger.entries[0].id, 1);
  });

  test('append a second entry gets id=2', (t) => {
    const tmp = createTempDir('bw-append-second-');
    t.after(() => cleanup(tmp));

    const r1 = runGsdTools(
      ['windows', 'append', '--kind', 'todo', '--phase', '2', '--description', 'first todo'],
      tmp,
    );
    assert.equal(r1.success, true, `stderr: ${r1.error || ''}`);
    const r2 = runGsdTools(
      ['windows', 'append', '--kind', 'todo', '--phase', '2', '--description', 'second todo'],
      tmp,
    );
    assert.equal(r2.success, true);
    const obj2 = JSON.parse(r2.output);
    assert.equal(obj2.entry.id, 2);
    assert.equal(obj2.ledger.total_count, 2);
  });

  test('append rejects unknown kind', (t) => {
    const tmp = createTempDir('bw-append-badkind-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(
      ['windows', 'append', '--kind', 'bogus', '--phase', '2', '--description', 'x'],
      tmp,
    );
    assert.equal(res.success, false);
    assert.match(res.error, /invalid kind|allowed:/i);
  });

  test('append rejects path-traversal in --file', (t) => {
    const tmp = createTempDir('bw-append-traversal-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2',
       '--file', '../../etc/passwd', '--description', 'x'],
      tmp,
    );
    assert.equal(res.success, false);
    assert.match(res.error, /traversal|absolute|file/i);
  });

  test('append rejects missing description', (t) => {
    const tmp = createTempDir('bw-append-nodesc-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2'],
      tmp,
    );
    assert.equal(res.success, false);
    assert.match(res.error, /description|required|missing/i);
  });

  test('append --line boundary: 0 / 1 / large int (limit-1 / limit / limit+1)', (t) => {
    const tmp = createTempDir('bw-append-line-bva-');
    t.after(() => cleanup(tmp));

    // line=1: smallest valid line — limit boundary.
    const r1 = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--line', '1', '--description', 'b'], tmp);
    assert.equal(r1.success, true, `--line 1 should succeed: ${r1.error || ''}`);
    assert.equal(JSON.parse(r1.output).entry.line, 1);

    // line=large: limit+1 boundary (just confirm it accepts arbitrary positive int).
    const r2 = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--line', '999999', '--description', 'c'], tmp);
    assert.equal(r2.success, true, `--line 999999 should succeed: ${r2.error || ''}`);
    assert.equal(JSON.parse(r2.output).entry.line, 999999);

    // line=0: limit-1 boundary — invalid (lines are 1-indexed; 0 is not a line).
    // M2 fix: validateLine no longer treats 0 as omit; it rejects as non-positive.
    const rZero = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--line', '0', '--description', 'a'], tmp);
    assert.equal(rZero.success, false, '--line 0 must fail (positive integers only)');
    assert.match(rZero.error, /line|positive integer/i);

    // line=-1 and line=abc: also invalid — fail closed.
    const rNeg = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--line', '-1', '--description', 'd'], tmp);
    assert.equal(rNeg.success, false);
    assert.match(rNeg.error, /line|positive integer/i);
    const rGarbage = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--line', 'abc', '--description', 'e'], tmp);
    assert.equal(rGarbage.success, false);
    assert.match(rGarbage.error, /line|positive integer/i);

    // line OMITTED entirely: valid, line is null.
    const rOmit = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'f'], tmp);
    assert.equal(rOmit.success, true, `--line omitted should succeed: ${rOmit.error || ''}`);
    assert.equal(JSON.parse(rOmit.output).entry.line, null);
  });

  test('append rejects 4-backtick description via CLI (H1 regression)', (t) => {
    const tmp = createTempDir('bw-append-4tick-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'has ```` four backticks'],
      tmp,
    );
    assert.equal(res.success, false);
    assert.match(res.error, /4-backtick|fence|invalid_text/i);
  });

  // ─── #2893: append must not destroy prose below the JSON ledger ──────────

  test('#2893 — append preserves prose below the JSON ledger block', (t) => {
    const tmp = createTempDir('bw-append-prose-');
    t.after(() => cleanup(tmp));

    // Create a WINDOWS.md with a NON-EMPTY ledger + prose below the JSON block.
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    const lp = path.join(tmp, '.planning', LEDGER_FILE_NAME);
    const initial = renderLedger({
      schema_version: 1, open_count: 1, waived_count: 0, fixed_count: 0, total_count: 1,
      last_updated: '2026-01-01T00:00:00Z',
      entries: [{ id: 1, phase: '1', kind: 'stub', file: '', line: null, description: 'pre-existing', status: 'open', reason: '', recorded_at: '2026-01-01T00:00:00Z', resolved_at: null }],
    });
    const prose = [
      '',
      '## Investigation Notes',
      '',
      'This window was opened because the flaky test in thread-status.test.ts',
      'turned out to be a real race condition against live data, not a pre-existing break.',
      '',
      '## ACPT-M03',
      '',
      'Went red on a green that PREDATED the diff — checkpoint refused, then fixed.',
    ].join('\n');
    fs.writeFileSync(lp, initial + prose, 'utf8');

    // First append.
    const res = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'test entry'],
      tmp,
    );
    assert.equal(res.success, true, `stderr: ${res.error || ''}`);
    assert.equal(JSON.parse(res.output).ok, true);

    // Second append — idempotency: prose must appear exactly once, not duplicated.
    const res2 = runGsdTools(
      ['windows', 'append', '--kind', 'todo', '--phase', '3', '--description', 'second entry'],
      tmp,
    );
    assert.equal(res2.success, true);

    const after = fs.readFileSync(lp, 'utf8');
    // Prose must survive.
    assert.match(after, /Investigation Notes/, 'prose heading must survive');
    assert.match(after, /thread-status\.test\.ts/, 'prose body must survive');
    assert.match(after, /ACPT-M03/, 'second prose heading must survive');
    assert.match(after, /PREDATED the diff/, 'second prose body must survive');
    // Prose must appear exactly once (not duplicated by the second write).
    assert.equal((after.match(/Investigation Notes/g) || []).length, 1,
      'prose heading must appear exactly once after two appends (idempotency)');
    // The old JSON body must NOT be duplicated as prose (the indexOf(open-fence) bug).
    // Count JSON fence opens — there must be exactly one.
    assert.equal((after.match(/````json/g) || []).length, 1,
      'exactly one JSON fence open must exist (no duplicated JSON body)');
    // The file must re-parse cleanly with the correct entry count.
    const reParsed = parseLedger(after);
    assert.equal(reParsed.entries.length, 3, 'ledger must have 3 entries after two appends');
  });
});

// ---------------------------------------------------------------------------
// CLI: gsd-tools windows waive (acceptance: waive-with-reason)
// ---------------------------------------------------------------------------

describe('broken-windows CLI: windows waive', () => {
  test('waive with reason succeeds; subsequent status reports open_count=0', (t) => {
    const tmp = createTempDir('bw-waive-ok-');
    t.after(() => cleanup(tmp));

    const r1 = runGsdTools(
      ['windows', 'append', '--kind', 'skipped-test', '--phase', '3',
       '--file', 'tests/x.test.cjs', '--line', '18',
       '--description', 't.skip logout flow'],
      tmp,
    );
    assert.equal(r1.success, true, `stderr: ${r1.error || ''}`);

    const r2 = runGsdTools(
      ['windows', 'waive', '1', 'Manual QA covers it; CI cannot reach logout URL'],
      tmp,
    );
    assert.equal(r2.success, true, `stderr: ${r2.error || ''}`);
    const obj = JSON.parse(r2.output);
    assert.equal(obj.ok, true);
    assert.equal(obj.ledger.entries[0].status, 'waived');
    assert.equal(obj.ledger.entries[0].reason, 'Manual QA covers it; CI cannot reach logout URL');

    const r3 = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(r3.success, true);
    const status = JSON.parse(r3.output);
    assert.equal(status.ledger.open_count, 0); // waived does not block ship
    assert.equal(status.ledger.waived_count, 1);
  });

  test('waive with empty reason fails', (t) => {
    const tmp = createTempDir('bw-waive-empty-');
    t.after(() => cleanup(tmp));
    const r1 = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'x'],
      tmp,
    );
    assert.equal(r1.success, true, `stderr: ${r1.error || ''}`);

    const r2 = runGsdTools(['windows', 'waive', '1', ''], tmp);
    assert.equal(r2.success, false);
    assert.match(r2.error, /waive.*reason|non-empty|reason.*required/i);
  });

  test('waive unknown id fails', (t) => {
    const tmp = createTempDir('bw-waive-unknown-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(['windows', 'waive', '999', 'because'], tmp);
    assert.equal(res.success, false);
    assert.match(res.error, /no window|id 999|not found/i);
  });
});

// ---------------------------------------------------------------------------
// CLI: gsd-tools windows fixed (acceptance: fixed removes from blocking set)
// ---------------------------------------------------------------------------

describe('broken-windows CLI: windows fixed', () => {
  test('fixed removes the entry from the blocking set', (t) => {
    const tmp = createTempDir('bw-fixed-');
    t.after(() => cleanup(tmp));

    const r1 = runGsdTools(
      ['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'x'],
      tmp,
    );
    assert.equal(r1.success, true, `stderr: ${r1.error || ''}`);

    const rBefore = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(rBefore.success, true);
    assert.equal(JSON.parse(rBefore.output).ledger.open_count, 1);

    const r2 = runGsdTools(['windows', 'fixed', '1'], tmp);
    assert.equal(r2.success, true, `stderr: ${r2.error || ''}`);
    const obj = JSON.parse(r2.output);
    assert.equal(obj.ledger.open_count, 0);
    assert.equal(obj.ledger.fixed_count, 1);
    assert.equal(obj.ledger.entries[0].status, 'fixed');
  });

  test('fixed on unknown id fails', (t) => {
    const tmp = createTempDir('bw-fixed-unknown-');
    t.after(() => cleanup(tmp));
    const res = runGsdTools(['windows', 'fixed', '999'], tmp);
    assert.equal(res.success, false);
    assert.match(res.error, /no window|id 999|not found/i);
  });
});

// ---------------------------------------------------------------------------
// CLI: full lifecycle — append → waive → append → fixed → clean ship
// ---------------------------------------------------------------------------

describe('broken-windows CLI: lifecycle', () => {
  test('append two, waive one, fix one, then ship is clean', (t) => {
    const tmp = createTempDir('bw-lifecycle-');
    t.after(() => cleanup(tmp));

    const r1 = runGsdTools(['windows', 'append', '--kind', 'stub', '--phase', '2', '--description', 'a'], tmp);
    const r2 = runGsdTools(['windows', 'append', '--kind', 'todo', '--phase', '2', '--description', 'b'], tmp);
    const r3 = runGsdTools(['windows', 'waive', '1', 'deferred to follow-up'], tmp);
    const r4 = runGsdTools(['windows', 'fixed', '2'], tmp);
    assert.equal(r1.success && r2.success && r3.success && r4.success, true,
      `lifecycle steps failed: r1=${r1.error || 'ok'} r2=${r2.error || 'ok'} r3=${r3.error || 'ok'} r4=${r4.error || 'ok'}`);

    const rFinal = runGsdTools(['windows', 'status', '--raw'], tmp);
    assert.equal(rFinal.success, true);
    const status = JSON.parse(rFinal.output);
    assert.equal(status.ledger.open_count, 0); // ship gate would pass
    assert.equal(status.ledger.waived_count, 1);
    assert.equal(status.ledger.fixed_count, 1);
    assert.equal(status.ledger.total_count, 2);
  });
});
