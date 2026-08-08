/**
 * Tests for the milestone-window single-owner contract (#3184, epic #3180
 * Phase 2, ADR-3180). Matrix: .gsd/phase/refactor-3184-milestone-window-single-owner/50-test-matrix.md
 *
 * Covers:
 *   - src/roadmap-parser.cts `classifyMilestoneWindow` / `extractCurrentMilestoneScoped`
 *     — the SCOPE discriminator decision table (section A).
 *   - src/roadmap-parser.cts `computeMilestoneSectionEnd` — the sole section-end
 *     owner, replacing three former byte-identical copies (section B).
 *   - Consumer-output identity (ADR-3180 Decision 4c): `roadmap analyze`,
 *     `milestone complete --dry-run`, `getMilestonePhaseFilter`, `state sync`,
 *     and `phase complete`'s raw-range write scoping all asserted at the
 *     CONSUMER's own observable output, never the owner's return value alone
 *     (section C).
 *   - Destructive-consumer refusal: `milestone complete` refuses to archive a
 *     TRUNCATED window without `--force`, with the negative proof that
 *     nothing on disk moved (section D).
 *   - `state.cts`'s two `isMilestoneBoundedInRoadmap` call sites (section E).
 *   - `scripts/lint-milestone-window-drift.cjs` — the whole-repo drift guard
 *     (section F).
 *   - fast-check document-shaped property tests (section G, #2371 provenance).
 *
 * Uses helpers.cjs createTempDir/cleanup per CONTRIBUTING.md — never inline
 * mkdtemp. IO failure injection uses mock.method(shellProj, 'platformReadSync', ...)
 * restored via t.after(), never fs.chmodSync (root bypasses 000 in Docker/CI).
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const roadmapParser = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const shellProj = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const driftGuard = require('../scripts/lint-milestone-window-drift.cjs');
const { sanitizeForReport } = require('../scripts/lib/drift-scan.cjs');

const {
  classifyMilestoneWindow,
  extractCurrentMilestoneScoped,
  computeMilestoneSectionEnd,
  locateMilestoneHeadings,
  isMilestoneBoundedInRoadmap,
  currentMilestoneRawRanges,
  getMilestonePhaseFilter,
  stripShippedMilestones,
} = roadmapParser;

// ─── Fixture helpers ───────────────────────────────────────────────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ═════════════════════════════════════════════════════════════════════════
// Section A — Scope classification (classifyMilestoneWindow + extractCurrentMilestoneScoped)
// ═════════════════════════════════════════════════════════════════════════

test('unscoped read by design reports COMPLETE', () => {
  const content = ['# Roadmap', '', '## v1.0 Old ✅ SHIPPED', '', '### Phase 1: Foo'].join('\n');
  const result = extractCurrentMilestoneScoped(content);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value, stripShippedMilestones(content));
});

test('scoped window with phases reports COMPLETE', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('genuinely empty milestone is COMPLETE not TRUNCATED', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = ['# Roadmap', '', '## v1.0 Current 🚧', '', 'Nothing planned yet.'].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('window closed before the phase region reports TRUNCATED', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.0' });
  const content = [
    '# Roadmap',
    '',
    '## v3.0 In Progress 🚧',
    '',
    'Some preamble notes. No phase headings here.',
    '',
    '## v4.0 Next',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.TRUNCATED);
});

test('free-form roadmap is COMPLETE not UNSCOPED', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // No STATE.md milestone field at all -- no version resolvable, and the
  // roadmap carries no versioned milestone headings anywhere.
  const content = ['# Roadmap', '', '## Overview', '', '### Phase 1: Foo'].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('versioned roadmap with no resolvable milestone is UNSCOPED', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // No STATE.md milestone field -- no version resolvable -- but the roadmap
  // DOES carry versioned milestone headings elsewhere.
  const content = ['# Roadmap', '', '## v1.0 Old ✅ SHIPPED', '', '### Phase 1: Foo'].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.UNSCOPED);
});

test('absent milestone section is UNSCOPED', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v9.9' });
  const content = ['# Roadmap', '', '## v1.0 Old ✅ SHIPPED', '', '### Phase 1: Foo'].join('\n');
  writeRoadmap(cwd, content);

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.UNSCOPED);

  // missingExplicitVersion is a getMilestonePhaseFilter-only field (not on
  // ScopedResult) -- confirm the SAME "absent section" disposition is
  // preserved there too, for the explicit-version-override argument shape.
  const filter = getMilestonePhaseFilter(cwd, 'v9.9');
  assert.strictEqual(filter.missingExplicitVersion, true);
  assert.strictEqual(filter.scope, SCOPE.UNSCOPED);
});

test('unreadable roadmap reports UNREADABLE', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  writeRoadmap(cwd, ['# Roadmap', '', '## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
  writeState(cwd, { milestone: 'v1.0' });

  mock.method(shellProj, 'platformReadSync', () => {
    throw new Error('EIO: simulated unreadable ROADMAP.md');
  });
  t.after(() => {
    mock.restoreAll();
    cleanup(cwd);
  });

  const filter = getMilestonePhaseFilter(cwd);
  assert.strictEqual(filter.scope, SCOPE.UNREADABLE);
  // The filter still degrades pass-all -- it is not a destructive consumer.
  assert.strictEqual(filter('anything-01'), true);
  assert.strictEqual(filter.phaseCount, 0);
});

test('empty roadmap is COMPLETE', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // No STATE.md -- no version resolvable on empty content either.
  const result = extractCurrentMilestoneScoped('', cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('bullet-style phase entries count as phases', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '- [ ] **Phase 1 — Foo**',
    '- [ ] **Phase 2 — Bar**',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('bullet-only doc still detects truncation', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    'No phases yet.',
    '',
    '## v2.0 Next',
    '',
    '- [ ] **Phase 1 — Foo**',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.TRUNCATED);
});

// #3184 review finding: `hasPhaseEntries`'s bullet fallback was not
// fence-aware (unlike its ATX-heading path, which uses `tokenizeHeadings`).
// A FENCED example of the bullet syntax -- e.g. documentation showing the
// convention inside a non-<details>-wrapped SHIPPED milestone section --
// inflated `documentHasPhaseEntries` and misclassified a genuinely-empty
// active milestone TRUNCATED instead of COMPLETE, which then made
// `cmdMilestoneComplete` refuse a legitimate archive without --force.
test('fenced bullet-phase example is not a phase entry', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v0.9 Old ✅ SHIPPED',
    '',
    'Example bullet-phase syntax for reference:',
    '',
    '```markdown',
    '- [ ] **Phase 3 — Name**',
    '```',
    '',
    '## v1.0 Current 🚧',
    '',
    'Nothing planned yet.',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  // Genuinely empty active milestone: the only bullet-phase-shaped text
  // anywhere in the document is fenced, so it must not count as a real
  // phase entry on either side of the row-8 comparison -- COMPLETE, not
  // TRUNCATED.
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

// Companion to the fenced case above: a real (unfenced) bullet phase entry
// outside the window must still classify TRUNCATED, proving the fence-aware
// fix strips fences rather than disabling bullet detection outright. This is
// the same fixture as 'bullet-only doc still detects truncation' above,
// asserted again here to pin both directions of the fix in one place.
test('unfenced bullet-phase entry outside the window still truncates', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    'No phases yet.',
    '',
    '## v2.0 Next',
    '',
    '- [ ] **Phase 1 — Foo**',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.TRUNCATED);
});

test('shipped-details phases do not fake a truncation', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  const content = [
    '# Roadmap',
    '',
    '<details>',
    '<summary>✅ v1.0 SHIPPED</summary>',
    '',
    '### Phase 1: Foo',
    '',
    '</details>',
    '',
    '## v2.0 Current 🚧',
    '',
    'No phases yet.',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('sentinel-only window is COMPLETE', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = ['# Roadmap', '', '## v1.0 Current 🚧', '', '### Phase 999.1: Backlog item'].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('phase prose and horizontal rules are not phase entries', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    'As discussed in Phase 3, we will revisit this.',
    '',
    '---',
    '',
    'More notes.',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  // Neither the prose mention nor the `---` rule is a phase entry, so this
  // reduces to the "genuinely empty milestone" shape -- COMPLETE, not TRUNCATED.
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('fenced milestone heading is not a boundary', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '```markdown',
    '## v9.9 milestone',
    '```',
    '',
    '### Phase 1: Foo',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  // The fenced heading must not stop the window early -- Phase 1 stays
  // inside it, so the window has phase entries and reads COMPLETE.
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

test('partial truncation is not detected (documented limit)', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '## v2.0 Next',
    '',
    '### Phase 2: Bar',
  ].join('\n');

  const result = extractCurrentMilestoneScoped(content, cwd);
  // The window has SOME phases (Phase 1), so this reads COMPLETE even
  // though the document has more (Phase 2) outside the window -- design's
  // documented "partial truncation is invisible" limit.
  assert.strictEqual(result.scope, SCOPE.COMPLETE);
});

// ─── A17: CRLF variants classify identically (table-driven) ───────────────

const CRLF_TABLE = [
  {
    name: 'A2 scoped-window-with-phases',
    version: 'v1.0',
    lines: ['# Roadmap', '', '## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'],
  },
  {
    name: 'A3 genuinely-empty-milestone',
    version: 'v1.0',
    lines: ['# Roadmap', '', '## v1.0 Current 🚧', '', 'Nothing planned yet.'],
  },
  {
    name: 'A4 window-closed-before-phases',
    version: 'v3.0',
    lines: [
      '# Roadmap', '', '## v3.0 In Progress 🚧', '', 'Some preamble notes. No phase headings here.',
      '', '## v4.0 Next', '', '### Phase 1: Foo', '', '### Phase 2: Bar',
    ],
  },
  {
    name: 'A5 free-form-legacy',
    version: null,
    lines: ['# Roadmap', '', '## Overview', '', '### Phase 1: Foo'],
  },
  {
    name: 'A6 versioned-unscoped',
    version: null,
    lines: ['# Roadmap', '', '## v1.0 Old ✅ SHIPPED', '', '### Phase 1: Foo'],
  },
  {
    name: 'A10 bullet-in-window',
    version: 'v1.0',
    lines: ['# Roadmap', '', '## v1.0 Current 🚧', '', '- [ ] **Phase 1 — Foo**', '- [ ] **Phase 2 — Bar**'],
  },
  {
    name: 'A11 bullet-only-truncated',
    version: 'v1.0',
    lines: [
      '# Roadmap', '', '## v1.0 Current 🚧', '', 'No phases yet.', '',
      '## v2.0 Next', '', '- [ ] **Phase 1 — Foo**',
    ],
  },
  {
    name: 'A12 shipped-details-trap',
    version: 'v2.0',
    lines: [
      '# Roadmap', '', '<details>', '<summary>✅ v1.0 SHIPPED</summary>', '',
      '### Phase 1: Foo', '', '</details>', '', '## v2.0 Current 🚧', '', 'No phases yet.',
    ],
  },
  {
    name: 'A13 sentinel-only-window',
    version: 'v1.0',
    lines: ['# Roadmap', '', '## v1.0 Current 🚧', '', '### Phase 999.1: Backlog item'],
  },
  {
    name: 'A15 fenced-heading-not-boundary',
    version: 'v1.0',
    lines: [
      '# Roadmap', '', '## v1.0 Current 🚧', '', '```markdown', '## v9.9 milestone', '```',
      '', '### Phase 1: Foo',
    ],
  },
];

test('CRLF variants classify identically', (t) => {
  const tmpDirs = [];
  t.after(() => {
    for (const dir of tmpDirs) cleanup(dir);
  });

  for (const row of CRLF_TABLE) {
    const lfContent = row.lines.join('\n');
    const crlfContent = row.lines.join('\n').replace(/\n/g, '\r\n');

    const lfCwd = createTempDir('gsd-milestone-window-crlf-lf-');
    const crlfCwd = createTempDir('gsd-milestone-window-crlf-crlf-');
    tmpDirs.push(lfCwd, crlfCwd);

    if (row.version) {
      writeState(lfCwd, { milestone: row.version });
      writeState(crlfCwd, { milestone: row.version });
    }
    const lfScope = extractCurrentMilestoneScoped(lfContent, lfCwd).scope;
    const crlfScope = extractCurrentMilestoneScoped(crlfContent, crlfCwd).scope;
    assert.strictEqual(crlfScope, lfScope, `CRLF mismatch for ${row.name}: LF=${lfScope} CRLF=${crlfScope}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Section B — Section-end owner (computeMilestoneSectionEnd)
// ═════════════════════════════════════════════════════════════════════════

test('stops at the next same-level milestone heading', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '## v2.0 Next 📋', 'more'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.indexOf('## v2.0 Next 📋'));
});

test('runs to end of document when no boundary follows', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body forever'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.length);
});

test('level-2 boundary stops a level-2 section', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '## v2.0 Next 📋'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.indexOf('## v2.0 Next 📋'));
  assert.notStrictEqual(end, content.length);
});

test('level-3 boundary stops a level-3 section', () => {
  const headingLine = '### v1.0 Current 🚧';
  const content = [headingLine, 'body', '### v2.0 Next 📋'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.indexOf('### v2.0 Next 📋'));
  assert.notStrictEqual(end, content.length);
});

test('level-4 heading is not a milestone boundary', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '#### v2.0 Next 📋', 'tail marker here'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  // #{1,3} is the owner's level ceiling -- a level-4 heading is outside it
  // and must never stop the window, regardless of the marker it carries.
  assert.strictEqual(end, content.length);
});

test('deeper heading is not a boundary', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '### v2.0 Sub 📋', 'tail'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.length);
});

test('phase heading is never a boundary', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '## Phase 2: v2.0 Launch 📋', 'tail'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.length);
});

test('unmarked heading is not a boundary', () => {
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body', '## Notes', 'tail'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.length);
});

test('own heading is not its own boundary', () => {
  // A single heading with no other content: the only tokenizeHeadings
  // candidate is the heading itself (offset === headingStart), which the
  // `h.offset <= headingStart` skip must exclude, forcing a fall-through to
  // content.length rather than a zero-length section.
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, 'body'].join('\n');
  const headingStart = content.indexOf(headingLine);
  const end = computeMilestoneSectionEnd(content, headingLine, headingStart);
  assert.strictEqual(end, content.length);
  assert.notStrictEqual(end, headingStart);
});

test('offset inside the heading line is not a boundary', () => {
  // Defensive-seam test: production callers always pass a headingText whose
  // length matches the real heading LINE, so afterHeading never legitimately
  // overlaps a DIFFERENT heading's offset. This exercises the seam directly
  // by passing an artificially long headingText that extends afterHeading
  // past a second, real heading's own offset -- that second heading's
  // candidacy must be skipped as "inside the heading span", not picked up
  // as a boundary.
  const headingLine = '## v1.0 Current 🚧';
  const content = [headingLine, '## v2.0 Next 📋', 'tail'].join('\n');
  const realStart = content.indexOf(headingLine);
  const paddedHeadingText = headingLine + '\n## v2.0 Next 📋';
  const end = computeMilestoneSectionEnd(content, paddedHeadingText, realStart);
  assert.strictEqual(end, content.length);
});

test('three former copies agree via one owner', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  // No preamble before the milestone heading and no "(Phase Details)"
  // append, so extractCurrentMilestoneScoped's `.value` is EXACTLY
  // content.slice(sectionStart, sectionEnd) -- letting all three former
  // call sites be cross-checked against the SAME owner offset.
  const content = ['## v1.0 Current 🚧', '', '### Phase 1: Foo', ''].join('\n');

  const headingMatches = locateMilestoneHeadings(content, 'v1.0');
  assert.strictEqual(headingMatches.length, 1);
  const selected = headingMatches[0];
  const ownerEnd = computeMilestoneSectionEnd(content, selected[0], selected.index);

  // Consumer 1: currentMilestoneRawRanges.
  const ranges = currentMilestoneRawRanges(content, cwd);
  assert.ok(ranges);
  assert.strictEqual(ranges.primary.end, ownerEnd);
  assert.strictEqual(ranges.primary.start, selected.index);

  // Consumer 2: extractCurrentMilestoneScoped -- with no preamble and no
  // details append, `.value` equals the same [start,end) slice exactly.
  const scoped = extractCurrentMilestoneScoped(content, cwd);
  assert.strictEqual(scoped.value, content.slice(selected.index, ownerEnd));

  // Consumer 3: getMilestonePhaseFilter's versionOverride branch -- same
  // phase set as slicing [start,end) directly would produce.
  const filter = getMilestonePhaseFilter(cwd, 'v1.0');
  assert.strictEqual(filter('01-foo'), true);
});

// ═════════════════════════════════════════════════════════════════════════
// Section C — Consumer-output identity (ADR-3180 Decision 4c)
// ═════════════════════════════════════════════════════════════════════════

test('roadmap.analyze phase set matches the owner window', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, [
    '<details>',
    '<summary>✅ v1.0 SHIPPED</summary>',
    '',
    '### Phase 1: Foo',
    '',
    '</details>',
    '',
    '## v2.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });

  const analyzeResult = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(analyzeResult.success, true, analyzeResult.error);
  const analyzed = JSON.parse(analyzeResult.output);
  const analyzedNumbers = analyzed.phases.map((p) => p.number).sort();

  // Owner window: getMilestonePhaseFilter membership for the SAME cwd/version.
  const filter = getMilestonePhaseFilter(cwd, 'v2.0');
  assert.strictEqual(filter('01-foo'), true);
  assert.strictEqual(filter('02-bar'), true);
  assert.deepStrictEqual(analyzedNumbers, ['1', '2']);
  assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
});

test('roadmap analyze reports scope truncated on a truncated window', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // #3165 layout: an ACTIVE milestone heading for STATE.md's version,
  // immediately followed by a CLOSED milestone heading at the SAME heading
  // level before any `### Phase N:` section -- the phase sections live
  // under the CLOSED heading, outside the ACTIVE window.
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 Current 🚧',
    '',
    '## v2.0 Old ✅ SHIPPED',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  assert.strictEqual(analyzed.scope, SCOPE.TRUNCATED);
  // Deliberately unchanged: the count stays 0 either way -- `scope` is what
  // carries the truncation signal, not `phase_count`.
  assert.strictEqual(analyzed.phase_count, 0);
});

test('roadmap analyze reports scope complete on a genuinely empty milestone', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // Same shape as the truncated fixture above, but the document carries no
  // phase entries anywhere -- the negative proof that the truncated
  // assertion above is not just "any zero-phase roadmap reports truncated".
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 Current 🚧',
    '',
    '## v2.0 Old ✅ SHIPPED',
    '',
    'Nothing here either.',
  ].join('\n'));

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
  assert.strictEqual(analyzed.phase_count, 0);
});

test('roadmap analyze emits a scope field on every result', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, ['## v2.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  assert.strictEqual(Object.hasOwn(analyzed, 'scope'), true);
  assert.strictEqual(Object.values(SCOPE).includes(analyzed.scope), true);
});

test('milestone.complete scoping matches the owner window', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  // #3184 review finding: the shipped v1.0 phase MUST use a phase NUMBER
  // that does not also appear in v2.0's own window. getMilestonePhaseFilter
  // scopes by matching a directory's NUMERIC phase-id prefix against the
  // set of phase numbers found inside the target milestone's own sliced
  // window -- it has no notion of "which milestone section a directory
  // came from" beyond that number. The original fixture gave both the
  // shipped v1.0 phase and the current v2.0 phase the SAME number ("1"),
  // so both `01-old-shipped` and `01-foo` matched by numeric-prefix
  // coincidence regardless of windowing -- that tested directory-naming
  // overlap, not window scoping, and encoded a wrong expectation.
  writeRoadmap(cwd, [
    '<details>',
    '<summary>✅ v1.0 SHIPPED</summary>',
    '',
    '### Phase 5: Foo',
    '',
    '</details>',
    '',
    '## v2.0 Current 🚧',
    '',
    '### Phase 1: Foo',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '05-old-shipped'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });

  const dryRun = runGsdTools(['milestone', 'complete', 'v2.0', '--dry-run', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(dryRun.success, true, dryRun.error);
  const parsed = JSON.parse(dryRun.output);

  const filter = getMilestonePhaseFilter(cwd, 'v2.0');
  const expectedArchived = ['05-old-shipped', '01-foo'].filter((name) => filter(name)).sort();
  assert.deepStrictEqual([...parsed.would_archive.phases].sort(), expectedArchived);
  assert.strictEqual(expectedArchived.includes('01-foo'), true);
  assert.strictEqual(expectedArchived.includes('05-old-shipped'), false);
});

test('filter membership matches the owner window', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n');
  writeRoadmap(cwd, content);

  const filter = getMilestonePhaseFilter(cwd);
  assert.strictEqual(filter.phaseCount, 2);
  assert.strictEqual(filter('01-foo'), true);
  assert.strictEqual(filter('02-bar'), true);
  assert.strictEqual(filter('03-baz'), false);
  assert.strictEqual(filter.scope, SCOPE.COMPLETE);
});

// #3184 review finding: `getMilestonePhaseFilter`'s #2199 bullet scan ran
// against un-stripped window content, so a fenced bullet-phase example
// inflated `milestonePhaseNums` / `phaseCount` the same way it inflated
// `hasPhaseEntries` above.
test('fenced bullet-phase example does not inflate phaseCount', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  const content = [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    'Example bullet-phase syntax for reference:',
    '',
    '```markdown',
    '- [ ] **Phase 3 — Name**',
    '```',
  ].join('\n');
  writeRoadmap(cwd, content);

  const filter = getMilestonePhaseFilter(cwd, 'v1.0');
  // Only the real heading (Phase 1) counts -- the fenced bullet example
  // (Phase 3) must not.
  assert.strictEqual(filter.phaseCount, 1);
  assert.strictEqual(filter('01-foo'), true);
  assert.strictEqual(filter('03-name'), false);
});

test('state bounding matches the owner predicate', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  writeFile(cwd, '.planning/phases/01-foo/01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-SUMMARY.md', '# Summary\n');
  writeState(cwd, { milestone: 'v2.0.1' });

  // Unbound case: asserted v2.0.1, heading only has v2.0 -- exercises the
  // exact #2562-class boundary defect (row 17).
  writeRoadmap(cwd, ['## v2.0 Launch', '', '### Phase 1: Foo'].join('\n'));
  const roadmapUnbound = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
  assert.strictEqual(isMilestoneBoundedInRoadmap(roadmapUnbound, 'v2.0.1'), false);

  const jsonUnbound = runGsdTools(['state', 'json', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(jsonUnbound.success, true, jsonUnbound.error);
  const parsedUnbound = JSON.parse(jsonUnbound.output);
  assert.strictEqual('percent' in (parsedUnbound.progress || {}), false);

  const syncUnbound = runGsdTools(['state', 'sync', '--verify', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(syncUnbound.success, true, syncUnbound.error);
  const syncParsedUnbound = JSON.parse(syncUnbound.output);
  assert.strictEqual(syncParsedUnbound.changes.length, 1);

  // Bound case: heading matches exactly.
  writeRoadmap(cwd, ['## v2.0.1 Launch', '', '### Phase 1: Foo'].join('\n'));
  const roadmapBound = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
  assert.strictEqual(isMilestoneBoundedInRoadmap(roadmapBound, 'v2.0.1'), true);

  const jsonBound = runGsdTools(['state', 'json', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(jsonBound.success, true, jsonBound.error);
  const parsedBound = JSON.parse(jsonBound.output);
  assert.strictEqual('percent' in (parsedBound.progress || {}), true);

  const syncBound = runGsdTools(['state', 'sync', '--verify', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(syncBound.success, true, syncBound.error);
  const syncParsedBound = JSON.parse(syncBound.output);
  assert.strictEqual(syncParsedBound.changes.length, 0);
});

test('raw ranges match the owner window', (t) => {
  // NOTE: 40-design.md's blast-radius table (line ~92) names cmdPhaseInsert
  // as currentMilestoneRawRanges's sole dependent. The current source
  // (src/phase.cts:2250) shows the actual call site is inside
  // cmdPhaseComplete instead -- a real discrepancy between the design doc
  // and the code, reported back per the dispatch brief rather than silently
  // adjusted around.
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, [
    '<details>',
    '<summary>✅ v1.0 SHIPPED</summary>',
    '',
    '### Phase 1: Foo',
    '',
    '**Plans**: 0/1 plans complete',
    '',
    '</details>',
    '',
    '## v2.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '**Plans**: 0/1 plans complete',
  ].join('\n'));
  writeFile(cwd, '.planning/phases/01-foo/01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-SUMMARY.md', '---\none-liner: did the thing\n---\n# Summary\n');
  writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: passed\n---\n# Verification\n');

  const before = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
  const ranges = currentMilestoneRawRanges(before, cwd);
  assert.ok(ranges, 'expected a resolvable milestone window');
  assert.ok(ranges.primary.start > 0, 'fixture must have a non-empty preamble to protect');

  const result = runGsdTools(['phase', 'complete', '1', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);

  const after = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
  // Negative proof: the SHIPPED v1.0 section -- which lies entirely BEFORE
  // the owner's computed window start -- is byte-identical after the write.
  // A consumer that re-derived its own (potentially wrong) window boundary
  // instead of consuming currentMilestoneRawRanges could leak the mutation
  // into this identically-shaped sibling "Phase 1" section; this is exactly
  // the regression currentMilestoneRawRanges exists to prevent.
  assert.strictEqual(after.slice(0, ranges.primary.start), before.slice(0, ranges.primary.start));
});

// ═════════════════════════════════════════════════════════════════════════
// Section D — Destructive-consumer refusal (Tier-2)
// ═════════════════════════════════════════════════════════════════════════

function buildTruncatedFixture(cwd) {
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 In Progress 🚧',
    '',
    'Some preamble notes. No phase headings here.',
    '',
    '## v4.0 Next',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '1-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '2-bar'), { recursive: true });
}

test('milestone complete refuses to archive a truncated window', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  buildTruncatedFixture(cwd);

  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, false);
  assert.notStrictEqual(result.exitCode, 0);
});

test('refusal leaves the phases directory untouched', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  buildTruncatedFixture(cwd);

  const before = fs.readdirSync(path.join(cwd, '.planning', 'phases')).sort();
  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, false);
  const after = fs.readdirSync(path.join(cwd, '.planning', 'phases')).sort();
  assert.deepStrictEqual(after, before);
});

test('--force overrides the truncation refusal', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  buildTruncatedFixture(cwd);

  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--force', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const parsed = JSON.parse(result.output);
  assert.strictEqual(parsed.archived.phases, true);
});

test('genuinely empty milestone still completes', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, ['# Roadmap', '', '## v1.0 Current 🚧', '', 'Nothing planned yet.'].join('\n'));

  const filter = getMilestonePhaseFilter(cwd, 'v1.0');
  assert.strictEqual(filter.scope, SCOPE.COMPLETE);

  const result = runGsdTools(['milestone', 'complete', 'v1.0', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
});

// ═════════════════════════════════════════════════════════════════════════
// Section E — state.cts boundary defect (design rows 17)
// ═════════════════════════════════════════════════════════════════════════

test('version token is boundary-matched not substring-matched', () => {
  const content = ['## v2.0 Launch', '', '### Phase 1: Foo'].join('\n');
  assert.strictEqual(isMilestoneBoundedInRoadmap(content, 'v2.0.1'), false);
});

test('exact version matches', () => {
  const content = ['## v2.0.1 Launch', '', '### Phase 1: Foo'].join('\n');
  assert.strictEqual(isMilestoneBoundedInRoadmap(content, 'v2.0.1'), true);
});

test('both state bounding sites agree', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  writeFile(cwd, '.planning/phases/01-foo/01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-SUMMARY.md', '# Summary\n');

  for (const [heading, expectBound] of [['## v2.0 Launch', false], ['## v2.0.1 Launch', true]]) {
    writeState(cwd, { milestone: 'v2.0.1' });
    writeRoadmap(cwd, [heading, '', '### Phase 1: Foo'].join('\n'));
    const roadmapRaw = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
    const ownerVerdict = isMilestoneBoundedInRoadmap(roadmapRaw, 'v2.0.1');
    assert.strictEqual(ownerVerdict, expectBound);

    // Site 1: buildStateFrontmatter, reached via `state json` -- typed via
    // progress.percent presence/absence.
    const jsonResult = runGsdTools(['state', 'json', '--cwd', cwd, '--raw'], cwd);
    assert.strictEqual(jsonResult.success, true, jsonResult.error);
    const parsedJson = JSON.parse(jsonResult.output);
    assert.strictEqual('percent' in (parsedJson.progress || {}), expectBound, `state json site for ${heading}`);

    // Site 2: cmdStateSync's own direct isMilestoneBoundedInRoadmap call --
    // typed via the structural (numeric) changes[] length: an unbound
    // milestone unconditionally pushes exactly one "Progress: skipped"
    // change; a bound, already-in-sync fixture pushes none.
    const syncResult = runGsdTools(['state', 'sync', '--verify', '--cwd', cwd, '--raw'], cwd);
    assert.strictEqual(syncResult.success, true, syncResult.error);
    const parsedSync = JSON.parse(syncResult.output);
    assert.strictEqual(parsedSync.changes.length, expectBound ? 0 : 1, `state sync site for ${heading}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Section F — Drift guard (scripts/lint-milestone-window-drift.cjs)
// ═════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.join(__dirname, '..');

// A single line carrying BOTH the heading-quantifier token (a) and the
// phase-lookahead token (b1) -- the narrowest shape findMilestoneWindowDrift
// flags, independent of any version/marker pairing.
function violatingLine() {
  return "const RE = /^#{1,3}\\s+(?!Phase\\s+\\S).*/;\n";
}

test('zero independent re-derivations remain', () => {
  const violations = driftGuard.scanRepo(REPO_ROOT);
  assert.deepStrictEqual(violations, []);
});

test('a new re-derivation is reported', (t) => {
  const root = createTempDir('gsd-milestone-window-drift-root-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'fake.cts'), violatingLine());

  const violations = driftGuard.scanRepo(root);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].file, path.join('src', 'fake.cts'));
  assert.strictEqual(violations[0].line, 1);
});

test('function-scoped exemption suppresses only its own function', (t) => {
  const root = createTempDir('gsd-milestone-window-drift-root-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const content = [
    'function checkW021() {',
    `  ${violatingLine().trim()}`,
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'src', 'roadmap-command-router.cts'), content);

  const violations = driftGuard.scanRepo(root);
  assert.deepStrictEqual(violations, []);
});

test('exemption is function-scoped, not file-scoped', (t) => {
  const root = createTempDir('gsd-milestone-window-drift-root-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const content = [
    'function checkW021() {',
    `  ${violatingLine().trim()}`,
    '}',
    '',
    'function someOtherFunction() {',
    `  ${violatingLine().trim()}`,
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'src', 'roadmap-command-router.cts'), content);

  const violations = driftGuard.scanRepo(root);
  // The exempted function's line is suppressed; the SAME shape inside a
  // DIFFERENT function in the same exempted FILE is still reported.
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].line, 6);
});

test('symlinked source is not an evasion', { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false }, (t) => {
  const root = createTempDir('gsd-milestone-window-drift-root-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
  const realFile = path.join(root, 'vendor', 'real-target.cts');
  fs.writeFileSync(realFile, violatingLine());
  fs.symlinkSync(realFile, path.join(root, 'src', 'linked.cts'));

  const violations = driftGuard.scanRepo(root);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].file, path.join('vendor', 'real-target.cts'));
});

test('root confinement holds', { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false }, (t) => {
  const root = createTempDir('gsd-milestone-window-drift-root-');
  const outside = createTempDir('gsd-milestone-window-drift-outside-');
  t.after(() => {
    cleanup(root);
    cleanup(outside);
  });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const outsideDir = path.join(outside, 'dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'evil.cts'), violatingLine());
  fs.symlinkSync(outsideDir, path.join(root, 'src', 'outdir'), 'dir');

  const violations = driftGuard.scanRepo(root);
  assert.strictEqual(violations.length, 0);
});

test('report output is sanitized', () => {
  // findMilestoneWindowDrift returns the RAW fragment; main() sanitizes both
  // `file` and `found` at the reporting boundary via the shared
  // sanitizeForReport (scripts/lib/drift-scan.cjs) before writing to stderr.
  // Assert that boundary actually escapes the hazardous classes a violating
  // line/path could carry: C0/C1 control bytes and bidi override codepoints.
  assert.strictEqual(sanitizeForReport(String.fromCharCode(0x1b)), '\\x1b');
  assert.strictEqual(sanitizeForReport('‮'), '\\u202e');
  const text = violatingLine().trim();
  assert.strictEqual(sanitizeForReport(text), text, 'ordinary regex-literal punctuation must pass through unchanged');
});

// ═════════════════════════════════════════════════════════════════════════
// Section G — Property tests (fast-check, document-shaped, #2371)
// ═════════════════════════════════════════════════════════════════════════
//
// Generators build documents from a heading/prose/fence/bullet alphabet,
// tracking each block's own offset/level/marker/phase-ness as it is
// assembled -- never by calling tokenizeHeadings, the milestone regexes, or
// any ROADMAP writer. The oracle (expected boundary) is computed from that
// SAME independently-tracked block metadata, not from the parser under
// test, so the property can fail against a real regression.

const SAFE_WORD = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/);

const headingBlockGen = fc.record({
  kind: fc.constant('heading'),
  level: fc.integer({ min: 1, max: 6 }),
  isPhase: fc.boolean(),
  hasMarker: fc.boolean(),
  word: SAFE_WORD,
}).map((b) => ({
  ...b,
  render() {
    const prefix = '#'.repeat(this.level);
    const phasePart = this.isPhase ? `Phase 3: ` : '';
    const markerPart = this.hasMarker ? ' v2.0' : '';
    return `${prefix} ${phasePart}${this.word}${markerPart}`;
  },
}));

const proseBlockGen = SAFE_WORD.map((word) => ({
  kind: 'prose',
  render() { return `prose ${word} line`; },
}));

const fenceBlockGen = SAFE_WORD.map((word) => ({
  kind: 'fence',
  render() { return ['```text', `## fake ${word} v9.9`, '```'].join('\n'); },
}));

const bulletBlockGen = SAFE_WORD.map((word) => ({
  kind: 'bullet',
  render() { return `- [ ] ${word}`; },
}));

const blockGen = fc.oneof(headingBlockGen, proseBlockGen, fenceBlockGen, bulletBlockGen);

// G1: computeMilestoneSectionEnd always returns content.length or a valid
// same-or-shallower, non-Phase, marker-carrying heading offset, and always
// strictly after headingStart.
test('section end is always a valid boundary or EOF', () => {
  const documentGen = fc.record({
    before: fc.array(blockGen, { maxLength: 4 }),
    // The target heading itself must be a valid milestone-heading shape
    // (level 1-3, mirrors locateMilestoneHeadings's own #{1,3} precondition
    // -- computeMilestoneSectionEnd is never called in production with a
    // deeper headingText).
    target: fc.record({
      kind: fc.constant('heading'),
      level: fc.integer({ min: 1, max: 3 }),
      isPhase: fc.constant(false),
      hasMarker: fc.constant(true),
      word: SAFE_WORD,
    }).map((b) => ({ ...b, render() { return `${'#'.repeat(this.level)} ${this.word} v1.0`; } })),
    after: fc.array(blockGen, { minLength: 1, maxLength: 6 }),
  });

  fc.assert(
    fc.property(documentGen, ({ before, target, after }) => {
      const blocks = [...before, target, ...after];
      let offset = 0;
      const rendered = [];
      const withOffsets = blocks.map((b) => {
        const text = b.render();
        const o = offset;
        rendered.push(text);
        offset += text.length + 1; // +1 for the '\n' join separator
        return { ...b, text, offset: o };
      });
      const content = rendered.join('\n');
      const targetEntry = withOffsets[before.length];

      const end = computeMilestoneSectionEnd(content, targetEntry.text, targetEntry.offset);

      assert.ok(end > targetEntry.offset, `end (${end}) must be strictly after headingStart (${targetEntry.offset})`);

      if (end === content.length) return true;

      const expectedBoundary = withOffsets
        .slice(before.length + 1)
        .find((b) => b.kind === 'heading' && b.level <= targetEntry.level && !b.isPhase && b.hasMarker);
      assert.ok(expectedBoundary, `expected a boundary block at end=${end} but none was tracked`);
      assert.strictEqual(end, expectedBoundary.offset);
      return true;
    }),
    { seed: 3184, numRuns: 200 },
  );
});

// G2: classifyMilestoneWindow never returns TRUNCATED when the document has
// zero phase entries -- a pure decision-table property, no document text at all.
test('truncation requires phases outside the window', () => {
  const inputGen = fc.record({
    readable: fc.boolean(),
    versionResolved: fc.boolean(),
    hasVersionedMilestones: fc.boolean(),
    headingFound: fc.boolean(),
    windowHasPhaseEntries: fc.boolean(),
    documentHasPhaseEntries: fc.constant(false),
  });
  fc.assert(
    fc.property(inputGen, (input) => {
      const scope = classifyMilestoneWindow(input);
      assert.notStrictEqual(scope, SCOPE.TRUNCATED);
      return true;
    }),
    { seed: 3184, numRuns: 200 },
  );
});

// G3: classification is invariant under LF<->CRLF conversion of the same document.
test('classification is newline-invariant', (t) => {
  const documentGen = fc.record({
    versioned: fc.boolean(),
    blocks: fc.array(blockGen, { minLength: 1, maxLength: 6 }),
  });

  const report = fc.check(
    fc.property(documentGen, ({ versioned, blocks }) => {
      const headingLine = versioned ? '## v1.0 Current 🚧' : null;
      const lines = headingLine ? [headingLine, ...blocks.map((b) => b.render())] : blocks.map((b) => b.render());
      const lfContent = lines.join('\n');
      const crlfContent = lines.join('\n').replace(/\n/g, '\r\n');

      const lfCwd = createTempDir('gsd-milestone-window-g3-lf-');
      const crlfCwd = createTempDir('gsd-milestone-window-g3-crlf-');
      if (versioned) {
        writeState(lfCwd, { milestone: 'v1.0' });
        writeState(crlfCwd, { milestone: 'v1.0' });
      }
      const lfScope = extractCurrentMilestoneScoped(lfContent, lfCwd).scope;
      const crlfScope = extractCurrentMilestoneScoped(crlfContent, crlfCwd).scope;
      cleanup(lfCwd);
      cleanup(crlfCwd);
      return lfScope === crlfScope;
    }),
    { seed: 3184, numRuns: 50 },
  );
  if (report.failed) {
    t.diagnostic(`G3 counterexample: ${JSON.stringify(report.counterexample)}`);
  }
  assert.strictEqual(report.failed, false, 'classification must be newline-invariant');
});
