'use strict';

// Phase 1 tests for the `rebuild` transition (ADR-1817).
//
// Covers the four drift classes from epic #1817:
//   #1  ## Current Position prose contradicts frontmatter
//   #2  ## Performance Metrics → **By Phase:** table has orphaned rows
//   #3  Template-placeholder field values ([X], [date], etc.) left in place
//   #4  Duplicate ## Session Continuity archived-session H3 blocks
//
// Plus the cross-cutting contracts:
//   #6  Idempotency: rebuild twice on a clean file = byte-identical
//   #7  Regression guard: sync/prune unchanged when rebuild is not invoked
//
// Discipline (CONTRIBUTING.md): tests assert on typed structured values via
// the public `transitionCore` API, never on rendered text via raw grep.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  transitionCore,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');
const { parseMarkdownTable } = require('../gsd-core/bin/lib/markdown-table.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-29',
  localToday: () => '2026-06-29',
  nowIso: () => '2026-06-29T12:00:00.000Z',
});

const noProgress = () => null;
// #3057 B1: `phaseInventoryProvider` returns a discriminated result, never a
// bare array-or-null — `{ ok: true, phases: [] }` is the genuinely-empty
// benign case ("nothing to reconcile"), distinct from `{ ok: false, reason }`
// (a scan that could not complete). See tests/helpers/faulty-deps.cjs and the
// dedicated describe block below for the failure-path coverage.
const noPhases = () => ({ ok: true, phases: [] });

const baseDeps = Object.freeze({
  progressProvider: noProgress,
  clock: fixedClock,
  phaseInventoryProvider: noPhases,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A clean, fully-reconciled STATE.md body — the canonical post-rebuild shape.
 * Used as the starting point for drift fixtures and as the idempotency
 * baseline (running rebuild on this must produce no mutation).
 */
function cleanState() {
  return [
    '---',
    'gsd_state_version: \'1.0\'',
    'status: executing',
    'milestone: 1.0.0',
    'milestone_name: Test Milestone',
    'current_phase: 3',
    'current_phase_name: Test Phase',
    'current_plan: 2',
    'progress:',
    '  total_phases: 5',
    '  completed_phases: 2',
    '  total_plans: 10',
    '  completed_plans: 4',
    '  percent: 40',
    '---',
    '',
    '# Project State',
    '',
    '## Project Reference',
    '',
    'See: .planning/PROJECT.md (updated 2026-06-01)',
    '',
    '**Core value:** A test project',
    '**Current focus:** Test Phase',
    '',
    '## Current Position',
    '',
    '**Current Phase:** 3',
    '**Current Phase Name:** Test Phase',
    '**Current Plan:** 2',
    '**Total Plans in Phase:** 5',
    '**Status:** executing',
    '**Last Activity:** 2026-06-29',
    '**Last Activity Description:** mid-flight context from plan 3-02',
    '',
    'Phase: 3 of 5 (Test Phase)',
    'Plan: 2 of 5',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-29 — mid-flight context',
    '',
    '**Progress:** [████░░░░░░] 40%',
    '',
    '## Performance Metrics',
    '',
    '**By Phase:**',
    '',
    '| Phase | Plans | Total | Avg/Plan |',
    '|-------|-------|-------|----------|',
    '| 1 | 2 | - | - |',
    '| 2 | 3 | - | - |',
    '| 3 | 5 | - | - |',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Phase 1: chose option A',
    '- Phase 2: chose option B',
    '',
    '### Pending Todos',
    '',
    'None yet.',
    '',
    '## Deferred Items',
    '',
    '| Category | Item | Status | Deferred At |',
    '|----------|------|--------|-------------|',
    '| *(none)* | | | |',
    '',
    '## Session Continuity',
    '',
    'Last session: 2026-06-29 12:00',
    'Stopped at: mid-flight context',
    'Resume file: None',
    '',
  ].join('\n');
}

/** Drift fixture #1: body `**Current Phase:**` and `**Current Phase Name:**`
 * contradict frontmatter (e.g. after a milestone switch). */
function driftedCurrentPosition() {
  // Take the clean state and inject stale body prose.
  const c = cleanState();
  return c
    .replace('**Current Phase:** 3', '**Current Phase:** 2')
    .replace('**Current Phase Name:** Test Phase', '**Current Phase Name:** Old Phase Name');
}

/** Drift fixture #3: template placeholder values left in body fields. */
function driftedPlaceholders() {
  const c = cleanState();
  // Inject placeholders into a couple of fields. Don't touch the fields
  // syncCore actively maintains (Last Activity) — those would be reconciled
  // by sync, not rebuild.
  return c
    .replace('**Current focus:** Test Phase', '**Current focus:** [Current phase name]')
    .replace('See: .planning/PROJECT.md (updated 2026-06-01)', 'See: .planning/PROJECT.md (updated [date])');
}

/** Count LIVE `### Session —` headings, excluding any occurrences inside the
 * `## Rebuild Log` audit section (the log's `before:` field captures dropped
 * content verbatim, which would otherwise inflate the count). */
function countLiveSessionHeadings(content) {
  // Strip everything from `## Rebuild Log` to EOF, then count.
  const stripped = content.replace(/^## Rebuild Log[\s\S]*$/m, '');
  return (stripped.match(/^###\s+Session\s+—/gm) || []).length;
}

/** Drift fixture #4: six duplicate `### Session —` archived blocks under
 * `## Session Continuity` (more than the default 3-most-recent retention). */
function driftedSessionArchiveDuplicates() {
  // Replace the canonical short Session Continuity block with one that has
  // six archived sub-blocks.
  const c = cleanState();
  const archiveBlock = [
    '## Session Continuity',
    '',
    'Last session: 2026-06-29 12:00',
    'Stopped at: mid-flight context',
    'Resume file: None',
    '',
    '### Session — 2026-06-20',
    '',
    'oldest session — should be dropped',
    '',
    '### Session — 2026-06-22',
    '',
    'second-oldest — should be dropped',
    '',
    '### Session — 2026-06-25',
    '',
    'third — kept',
    '',
    '### Session — 2026-06-27',
    '',
    'fourth — kept',
    '',
    '### Session — 2026-06-28',
    '',
    'fifth — kept',
    '',
    '### Session — 2026-06-29',
    '',
    'sixth — kept',
    '',
  ].join('\n');
  return c.replace(/## Session Continuity[\s\S]*$/, archiveBlock);
}

// ---------------------------------------------------------------------------
// Tests — dispatch + idempotency contract
// ---------------------------------------------------------------------------

describe('ADR-1817 `rebuild` intent: dispatch + idempotency (§1, §4)', () => {
  test('transitionCore dispatches `rebuild` without throwing', () => {
    const result = transitionCore(cleanState(), { kind: 'rebuild' }, baseDeps);
    assert.ok(result, 'rebuild must return a result');
    assert.ok(Array.isArray(result.updated), 'updated must be an array');
    assert.ok(result.data && typeof result.data === 'object', 'data must be an object');
  });

  test('rebuild on a clean file is a no-op: content byte-identical, no log, no `updated`', () => {
    const clean = cleanState();
    const result = transitionCore(clean, { kind: 'rebuild' }, baseDeps);
    assert.strictEqual(result.content, clean, 'content must be byte-identical on a clean file');
    assert.deepStrictEqual(result.updated, [], 'no fields should be marked updated on a clean file');
    assert.strictEqual(result.data && result.data.mutated, false, 'mutated flag must be false');
    assert.strictEqual(result.content.includes('## Rebuild Log'), false,
      'a no-op rebuild must NOT append a ## Rebuild Log section (idempotency)');
  });

  test('running rebuild twice on a drifted file converges: second run is a no-op', () => {
    const drifted = driftedCurrentPosition();
    const first = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    assert.notStrictEqual(first.content, drifted, 'first run must mutate drifted content');
    const second = transitionCore(first.content, { kind: 'rebuild' }, baseDeps);
    assert.strictEqual(second.content, first.content,
      'second run on the just-rebuilt content must be byte-identical (idempotency)');
    assert.deepStrictEqual(second.updated, [], 'second run must mark nothing updated');
    assert.strictEqual(second.data && second.data.mutated, false,
      'second run must report mutated=false');
  });
});

// ---------------------------------------------------------------------------
// Tests — drift class #1: Current Position prose reconciliation
// ---------------------------------------------------------------------------

describe('ADR-1817 §2: rebuild reconciles ## Current Position prose with frontmatter (#1817 criterion #1)', () => {
  test('body `**Current Phase:**` is re-derived from frontmatter.current_phase when drifted', () => {
    const drifted = driftedCurrentPosition();
    assert.strictEqual(stateExtractField(drifted, 'Current Phase'), '2',
      'fixture sanity: drifted body must have stale phase 2');
    const result = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    assert.strictEqual(
      stateExtractField(result.content, 'Current Phase'),
      '3',
      'body Current Phase must be reconciled to frontmatter value 3',
    );
  });

  test('body `**Current Phase Name:**` is re-derived from frontmatter.current_phase_name when drifted', () => {
    const drifted = driftedCurrentPosition();
    assert.strictEqual(stateExtractField(drifted, 'Current Phase Name'), 'Old Phase Name',
      'fixture sanity: drifted body must have stale name');
    const result = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    assert.strictEqual(
      stateExtractField(result.content, 'Current Phase Name'),
      'Test Phase',
      'body Current Phase Name must be reconciled to frontmatter value',
    );
  });

  test('each reconciliation produces an audit-log entry in ## Rebuild Log', () => {
    const result = transitionCore(driftedCurrentPosition(), { kind: 'rebuild' }, baseDeps);
    assert.ok(result.content.includes('## Rebuild Log'),
      'rebuild that mutated must create ## Rebuild Log section');
    assert.ok(result.content.includes('kind: current-position-reconciled'),
      'log must contain a current-position-reconciled entry');
    assert.ok(result.content.includes('reason:'),
      'every log entry must carry a reason field (ADR-1411 provenance)');
  });
});

// ---------------------------------------------------------------------------
// Tests — drift class #3: template-placeholder removal
// ---------------------------------------------------------------------------

describe('ADR-1817 §2: rebuild strips template-placeholder field values (#1817 criterion #3)', () => {
  test('`**Field:** [placeholder]` lines are replaced with `**Field:** (pending)`', () => {
    const drifted = driftedPlaceholders();
    const result = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    assert.ok(result.content.includes('**Current focus:** (pending)'),
      'placeholder Current focus must be replaced with (pending)');
    assert.ok(result.content.includes('**Last Activity:** 2026-06-29'),
      'fixture sanity: syncCore-maintained fields are untouched by rebuild');
  });

  test('a placeholder-removed audit-log entry is recorded', () => {
    const result = transitionCore(driftedPlaceholders(), { kind: 'rebuild' }, baseDeps);
    assert.ok(result.content.includes('kind: placeholder-removed'),
      'log must contain a placeholder-removed entry');
  });

  test('a clean body with no placeholders produces no placeholder-removed log entry', () => {
    const result = transitionCore(cleanState(), { kind: 'rebuild' }, baseDeps);
    assert.ok(!result.content.includes('kind: placeholder-removed'),
      'clean file must not log placeholder removal');
  });
});

// ---------------------------------------------------------------------------
// Tests — drift class #4: Session Continuity Archive de-duplication
// ---------------------------------------------------------------------------

describe('ADR-1817 §2: rebuild de-duplicates ## Session Continuity archive blocks (#1817 criterion #4)', () => {
  test('when > 3 archived sessions, the oldest are dropped down to the 3 most-recent', () => {
    const drifted = driftedSessionArchiveDuplicates();
    // Fixture sanity: six archived H3 blocks
    const before = countLiveSessionHeadings(drifted);
    assert.strictEqual(before, 6, 'fixture must have 6 archived sessions');

    const result = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    const after = countLiveSessionHeadings(result.content);
    assert.strictEqual(after, 3, 'rebuild must keep exactly 3 most-recent archived sessions');
  });

  test('each dropped session produces a session-archive-deduplicated log entry', () => {
    const result = transitionCore(driftedSessionArchiveDuplicates(), { kind: 'rebuild' }, baseDeps);
    const dropEntries = (result.content.match(/kind: session-archive-deduplicated/g) || []).length;
    assert.strictEqual(dropEntries, 3, 'three dropped sessions → three log entries');
  });

  test('the kept sessions are the most-recent three (by document order — template convention)', () => {
    const result = transitionCore(driftedSessionArchiveDuplicates(), { kind: 'rebuild' }, baseDeps);
    // Strip the audit log so we only inspect LIVE content (the log's `before:`
    // field legitimately preserves dropped text per ADR-1817 §3).
    const live = result.content.replace(/^## Rebuild Log[\s\S]*$/m, '');
    // DEFAULT_MAX_SESSION_ARCHIVES = 3 → drop the 3 oldest, keep 06-27/28/29.
    assert.ok(!live.includes('### Session — 2026-06-20'), 'dropped: 06-20 (oldest)');
    assert.ok(!live.includes('### Session — 2026-06-22'), 'dropped: 06-22 (2nd oldest)');
    assert.ok(!live.includes('### Session — 2026-06-25'), 'dropped: 06-25 (3rd oldest)');
    assert.ok(live.includes('### Session — 2026-06-27'), 'kept: 06-27');
    assert.ok(live.includes('### Session — 2026-06-28'), 'kept: 06-28');
    assert.ok(live.includes('### Session — 2026-06-29'), 'kept: 06-29 (newest)');
    assert.ok(!live.includes('oldest session — should be dropped'),
      'oldest session content must be gone from the live section');
    assert.ok(!live.includes('second-oldest — should be dropped'),
      'second-oldest session content must be gone from the live section');
  });

  test('when <= 3 archived sessions, rebuild is a no-op on the archive', () => {
    const clean = cleanState();  // has zero archived H3 sessions
    const result = transitionCore(clean, { kind: 'rebuild' }, baseDeps);
    assert.ok(!result.content.includes('kind: session-archive-deduplicated'),
      'no dedup log entry when archive is within retention');
  });
});

// ---------------------------------------------------------------------------
// Tests — drift class #2: By Phase table reconciliation (via dep)
// ---------------------------------------------------------------------------

describe('ADR-1817 §2: rebuild reconciles **By Phase:** table via phaseInventoryProvider (#1817 criterion #2)', () => {
  test('orphaned rows for phases missing from the inventory are dropped', () => {
    // Inventory: only phases 1, 2, 3 exist on disk. Drifted body has rows for
    // 1, 2, 3, AND an orphan row for phase 99 (prior milestone).
    const drifted = cleanState().replace(
      /\| 3 \| 5 \| - \| - \|\n/,
      '| 3 | 5 | - | - |\n| 99 | 1 | - | - |\n',
    );
    const deps = {
      ...baseDeps,
      phaseInventoryProvider: () => ({
        ok: true,
        phases: [
          { number: '1', name: 'Phase 1', planCount: 2, summaryCount: 2 },
          { number: '2', name: 'Phase 2', planCount: 3, summaryCount: 3 },
          { number: '3', name: 'Test Phase', planCount: 5, summaryCount: 4 },
        ],
      }),
    };
    // First call with no phaseInventoryProvider → no-op (covered by its own test below).
    // Re-run with the provider-wired deps:
    const result2 = transitionCore(drifted, { kind: 'rebuild' }, deps);
    // Strip the audit log so we only inspect LIVE table rows (the log's
    // `before:` field legitimately preserves the pre-rebuild table per
    // ADR-1817 §3).
    const live = result2.content.replace(/^## Rebuild Log[\s\S]*$/m, '');
    assert.ok(!live.includes('| 99 |'),
      'orphan row for phase 99 (not on disk) must be dropped when phaseInventoryProvider is wired');
    assert.ok(live.includes('| 1 |'), 'kept: phase 1');
    assert.ok(live.includes('| 2 |'), 'kept: phase 2');
    assert.ok(live.includes('| 3 |'), 'kept: phase 3');
  });

  test('rebuild logs a by-phase-table-reconciled entry when the table changes', () => {
    const drifted = cleanState().replace(
      /\| 3 \| 5 \| - \| - \|\n/,
      '| 3 | 5 | - | - |\n| 99 | 1 | - | - |\n',
    );
    const deps = {
      ...baseDeps,
      phaseInventoryProvider: () => ({
        ok: true,
        phases: [
          { number: '1', name: 'Phase 1', planCount: 2, summaryCount: 2 },
          { number: '2', name: 'Phase 2', planCount: 3, summaryCount: 3 },
          { number: '3', name: 'Test Phase', planCount: 5, summaryCount: 4 },
        ],
      }),
    };
    const result = transitionCore(drifted, { kind: 'rebuild' }, deps);
    assert.ok(result.content.includes('kind: by-phase-table-reconciled'),
      'rebuild that mutated the table must log a by-phase-table-reconciled entry');
  });

  test('Leaky-Abstractions guard: when phaseInventoryProvider is absent, table is preserved verbatim', () => {
    const drifted = cleanState().replace(
      /\| 3 \| 5 \| - \| - \|\n/,
      '| 3 | 5 | - | - |\n| 99 | 1 | - | - |\n',
    );
    // baseDeps.phaseInventoryProvider = noPhases ({ ok: true, phases: [] }) → step is no-op.
    const result = transitionCore(drifted, { kind: 'rebuild' }, baseDeps);
    assert.ok(result.content.includes('| 99 |'),
      'orphan row must be preserved when no canonical source is wired');
    assert.ok(!result.content.includes('kind: by-phase-table-reconciled'),
      'no log entry when step is a no-op');
  });
});

// ---------------------------------------------------------------------------
// Tests — #3057 B1: a phase-inventory scan FAILURE must be distinguishable
// from a genuinely-empty scan. Before the fix both were `null`, so a real
// disk-scan failure and "no phases on disk" produced the identical result:
// `state rebuild` could report success while by-phase-table reconciliation
// silently never ran.
// ---------------------------------------------------------------------------

describe('#3057 B1: phaseInventoryProvider scan-failure is distinguishable from genuinely-empty', () => {
  const drifted = () => cleanState().replace(
    /\| 3 \| 5 \| - \| - \|\n/,
    '| 3 | 5 | - | - |\n| 99 | 1 | - | - |\n',
  );

  test('FAILURE path: ok:false surfaces phase_inventory_scan_failed and leaves the table untouched', () => {
    const deps = {
      ...baseDeps,
      phaseInventoryProvider: () => ({ ok: false, reason: 'EACCES: permission denied, readdir .planning/phases' }),
    };
    const result = transitionCore(drifted(), { kind: 'rebuild' }, deps);
    assert.strictEqual(result.data.phase_inventory_scan_failed, true,
      'a scan failure must set phase_inventory_scan_failed:true on the result data');
    assert.strictEqual(result.data.phase_inventory_scan_reason,
      'EACCES: permission denied, readdir .planning/phases',
      'the failure reason must be threaded through to the caller');
    const table = parseMarkdownTable(result.content);
    assert.ok(table.ok, `By Phase table must parse; reason: ${table.ok ? '' : table.reason}`);
    const phaseIds = table.value.rows.map((r) => r.Phase);
    assert.ok(phaseIds.includes('99'),
      'orphan row must be preserved — a failed scan is not a trustworthy inventory to reconcile against');
    assert.ok(!result.data.log.some((e) => e.kind === 'by-phase-table-reconciled'),
      'a failed scan must not log a by-phase-table-reconciled entry (nothing was actually reconciled)');
  });

  test('BENIGN path: ok:true with an empty phases array reports no failure and no reconciliation', () => {
    const deps = {
      ...baseDeps,
      phaseInventoryProvider: () => ({ ok: true, phases: [] }),
    };
    const result = transitionCore(drifted(), { kind: 'rebuild' }, deps);
    assert.strictEqual(result.data.phase_inventory_scan_failed, false,
      'a genuinely-empty successful scan must report phase_inventory_scan_failed:false');
    assert.strictEqual(result.data.phase_inventory_scan_reason, undefined,
      'no reason field when the scan did not fail');
    const table = parseMarkdownTable(result.content);
    assert.ok(table.ok, `By Phase table must parse; reason: ${table.ok ? '' : table.reason}`);
    const phaseIds = table.value.rows.map((r) => r.Phase);
    assert.ok(phaseIds.includes('99'),
      'orphan row is preserved (same visible outcome as the failure case — the DATA field is what distinguishes them)');
    assert.ok(!result.data.log.some((e) => e.kind === 'by-phase-table-reconciled'),
      'an empty inventory logs no reconciliation entry, same as the failure case');
  });
});

// ---------------------------------------------------------------------------
// Tests — §5 + §6: regression guard (sync/prune unchanged by rebuild presence)
// ---------------------------------------------------------------------------

describe('ADR-1817 §5/§6: rebuild does not affect sync or prune (regression guard, criterion #7)', () => {
  test('sync still patches its three frontmatter fields when rebuild is also available', () => {
    const state = cleanState();
    const result = transitionCore(
      state,
      { kind: 'sync', totalPlansInPhase: 7, percent: 50 },
      baseDeps,
    );
    // sync should have updated Total Plans in Phase and Progress and Last Activity.
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '7',
      'sync must still patch Total Plans in Phase');
    assert.ok(stateExtractField(result.content, 'Progress').includes('50%'),
      'sync must still patch Progress percent');
  });

  test('prune still archives by cutoff when rebuild is also available', () => {
    // Smoke: prune on a body with at least one Decisions row at phase 1 should
    // archive that row when cutoff=0. The exact byte shape is covered by the
    // dedicated state-transition tests; this test only asserts prune is NOT
    // broken by adding the rebuild case to the switch.
    const state = cleanState();
    const result = transitionCore(state, { kind: 'prune', cutoff: 0 }, baseDeps);
    assert.ok(result, 'prune must still return a result');
    assert.ok(result.updated !== undefined, 'prune must still return an updated array');
  });
});
