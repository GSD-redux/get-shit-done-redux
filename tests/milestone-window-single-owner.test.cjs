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
  // No phase directories on disk here, so #3165's on-disk-evidence fallback
  // does not fire and phase_count stays 0 -- `scope` carries the truncation
  // signal. The WITH-dirs companion below proves the recovery path.
  assert.strictEqual(analyzed.phase_count, 0);
});

test('roadmap analyze recovers phase_count when phase dirs exist on disk (#3165)', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // #3165 layout: the ACTIVE milestone's own `### Phase N:` detail sections
  // sit AFTER an intervening CLOSED milestone heading, so the scoped window
  // closes over prose only. Phase directories on disk are the on-disk evidence
  // that phases really exist -- the fallback re-scans the shipped-stripped
  // document so the consuming resume gate (workflows/next.md Route 0) sees a
  // non-empty `.phases[]` it can actually iterate.
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 Current 🚧',
    '',
    'Active milestone prose.',
    '',
    '## v2.0 Old ✅ SHIPPED',
    '',
    'Archived prose.',
    '',
    '### Phase 1: Foo',
    '',
    '**Goal:** Do foo',
    '',
    '### Phase 2: Bar',
    '',
    '**Goal:** Do bar',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  // Acceptance criterion 1: correct phase count + resolved current/next, not
  // an empty result.
  assert.strictEqual(analyzed.phase_count, 2);
  assert.deepStrictEqual(analyzed.phases.map((p) => p.number).sort(), ['1', '2']);
  assert.notStrictEqual(analyzed.next_phase, null, 'next_phase must resolve to a real phase');
  // Acceptance criterion 3: scope stays non-COMPLETE so consumers can still
  // tell this is a best-effort count, not a cleanly scoped one.
  assert.strictEqual(analyzed.scope, SCOPE.TRUNCATED);
});

test('roadmap analyze fallback does not over-fire on a well-formed sectioned roadmap (#3165)', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // Well-formed: the ACTIVE milestone's phases come right after its heading,
  // BEFORE the CLOSED milestone. The scoped window is correct (COMPLETE), so
  // the fallback must NOT fire -- phase_count reflects ACTIVE's phases only.
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
    '',
    '## v2.0 Old ✅ SHIPPED',
    '',
    '### Phase 3: Archived',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  assert.strictEqual(analyzed.phase_count, 2);
  assert.deepStrictEqual(analyzed.phases.map((p) => p.number).sort(), ['1', '2']);
  assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
});

test('roadmap analyze fallback respects shipped <details> milestone stripping (#3165)', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  // #3165 layout + a <details> shipped block holding OTHER phases. The
  // fallback scans stripShippedMilestones(rawContent), so phases inside a
  // collapsed shipped <details> are NOT counted -- only the ACTIVE milestone's
  // loose phase headings are.
  writeState(cwd, { milestone: 'v3.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 Current 🚧',
    '',
    '## v2.0 Old ✅ SHIPPED',
    '',
    '<details>',
    '<summary>v1.0 shipped</summary>',
    '',
    '### Phase 9: Legacy',
    '',
    '</details>',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const analyzed = JSON.parse(result.output);
  assert.strictEqual(analyzed.phase_count, 2);
  assert.deepStrictEqual(analyzed.phases.map((p) => p.number).sort(), ['1', '2']);
  assert.notStrictEqual(analyzed.scope, SCOPE.COMPLETE);
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

  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--cwd', cwd, '--raw', '--confirm'], cwd);
  assert.strictEqual(result.success, false);
  assert.notStrictEqual(result.exitCode, 0);
});

test('refusal leaves the phases directory untouched', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  buildTruncatedFixture(cwd);

  const before = fs.readdirSync(path.join(cwd, '.planning', 'phases')).sort();
  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--cwd', cwd, '--raw', '--confirm'], cwd);
  assert.strictEqual(result.success, false);
  const after = fs.readdirSync(path.join(cwd, '.planning', 'phases')).sort();
  assert.deepStrictEqual(after, before);
});

test('--force overrides the truncation refusal', (t) => {
  const cwd = createTempDir('gsd-milestone-window-');
  t.after(() => cleanup(cwd));
  buildTruncatedFixture(cwd);

  const result = runGsdTools(['milestone', 'complete', 'v3.0', '--force', '--cwd', cwd, '--raw', '--confirm'], cwd);
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

  const result = runGsdTools(['milestone', 'complete', 'v1.0', '--cwd', cwd, '--raw', '--confirm'], cwd);
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

// The guard's owner file (src/roadmap-parser.cts) is no longer exempt as a
// whole file — only its named canonical functions are (FUNCTION_SCOPED_EXEMPTIONS).
// These synthesize a relPath of 'src/roadmap-parser.cts' WITHOUT touching the
// real source file, exercising findMilestoneWindowDrift directly.
test('a non-exempt top-level function in src/roadmap-parser.cts IS reported', () => {
  const relPath = path.join('src', 'roadmap-parser.cts');
  const text = [
    'function someOtherFunction() {',
    `  ${violatingLine().trim()}`,
    '}',
  ].join('\n');
  const violations = driftGuard.findMilestoneWindowDrift(text, relPath);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].line, 2);
});

const OWNER_FILE_EXEMPT_FUNCTIONS = [
  'isMilestoneShippedInRoadmap',
  'locateMilestoneHeadings',
  'hasMilestoneSectioning',
  'extractCurrentMilestoneScoped',
];

for (const fnName of OWNER_FILE_EXEMPT_FUNCTIONS) {
  test(`owner-file exempt function ${fnName} in src/roadmap-parser.cts is NOT reported`, () => {
    const relPath = path.join('src', 'roadmap-parser.cts');
    const text = [
      `function ${fnName}() {`,
      `  ${violatingLine().trim()}`,
      '}',
    ].join('\n');
    const violations = driftGuard.findMilestoneWindowDrift(text, relPath);
    assert.deepStrictEqual(violations, []);
  });
}

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

// ═════════════════════════════════════════════════════════════════════════
// Section H — Milestone identity has one owner (#3216, epic #3180 Phase 6)
// Matrix: .gsd/phase/refactor-3216-milestone-identity-single-owner/50-test-matrix.md
// ═════════════════════════════════════════════════════════════════════════
//
// `getMilestoneInfo(cwd)` moves from a bare `{version, name}` return (with a
// `{v1.0,'milestone'}` failure default output-identical to a genuine v1.0
// project) to `ScopedResult<MilestoneInfo | null>` -- `{value, scope}`, scope
// drawn from the same frozen SCOPE enum Section A uses. `listMilestoneHeadings`
// is a new version-agnostic sibling of `locateMilestoneHeadings`, consolidating
// the THIRD copy the widened drift guard found at `roadmap.cts:454`
// (`cmdRoadmapAnalyze`'s inline milestone-heading regex).
//
// Neither symbol exists in this shape yet -- every test below is failing-first
// by construction, not only the rows the matrix marks (RED). Both are
// destructured locally (not added to the top-of-file import block) so this
// section is a pure append.

const {
  getMilestoneInfo,
  listMilestoneHeadings,
} = roadmapParser;
const unusableInputMod = require('../gsd-core/bin/lib/unusable-input.cjs');
const {
  _resetUnusableInputWarningsForTests,
  _unusableInputEmissionCountForTests,
} = unusableInputMod;
// `createTempGitProject`/`gitOrThrow` (not added to the top-of-file import
// block, same "pure append" rationale as above): the four destructive
// `phases clear --confirm` tests below need a real, clean git repo so the
// command's own uncommitted-changes guard behaves deterministically instead
// of being bypassed with `--force`.
const { createTempGitProject } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

// ─── Shared CRLF-twinned fixture table (rows 1, 3, 4, 5, 18, 19, 24) ──────

const H_CRLF_TABLE = [
  {
    label: 'H1 named-heading',
    version: 'v3.3',
    lines: ['# Roadmap', '', '## v3.3 — Portability', '', 'body text'],
  },
  {
    label: 'H3 parenthetical-name',
    version: 'v3.3',
    lines: ['# Roadmap', '', '## v3.3 — Portability (Windows)', '', 'body text'],
  },
  {
    label: 'H4 phase-heading-only',
    version: 'v3.3',
    lines: ['# Roadmap', '', '### Phase 7: Close v3.3 gaps', '', 'body text'],
  },
  {
    label: 'H5 phase-heading-only-unscoped',
    version: null,
    lines: ['# Roadmap', '', '### Phase 7: Close v3.3 gaps', '', 'body text'],
  },
  {
    label: 'H18 phase-and-real-heading',
    version: 'v3.3',
    lines: ['# Roadmap', '', '### Phase 7: Close v3.3 gaps', '', '## v3.3 — Real Name', '', 'body text'],
  },
  {
    label: 'H19 closed-then-live',
    version: 'v3.3',
    lines: ['# Roadmap', '', '## v3.3 — Old ✅ SHIPPED', '', '## v3.3 — New', '', 'body text'],
  },
];

function buildHFixture(t, entry, crlf = false) {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  if (entry.version) writeState(cwd, { milestone: entry.version });
  const content = entry.lines.join('\n');
  writeRoadmap(cwd, crlf ? content.replace(/\n/g, '\r\n') : content);
  return cwd;
}

test('stateVersionWithNamedHeadingReportsBothAndCompleteScope', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[0]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: 'Portability' });
});

test('progressMarkerBulletIsConsultedBeforeHeading', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  const content = [
    '# Roadmap',
    '',
    '🚧 **v3.3** Bullet Name (Windows)',
    '',
    '## v3.3 — Decoy Heading Name',
  ].join('\n');
  writeRoadmap(cwd, content);

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  // The 🚧 bullet is consulted BEFORE the heading (#2135) -- its name wins
  // even though a differently-named heading for the same version exists too.
  assert.strictEqual(result.value.name, 'Bullet Name (Windows)');
});

// (RED) #3171: the heading-name capture must not truncate at '('.
test('headingNameRetainsParentheticalInsteadOfTruncating', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[1]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'Portability (Windows)');
});

// (RED) #3197: a Phase heading mentioning the milestone's version is never a
// milestone heading -- even on the STATE-anchored path.
test('phaseHeadingIsNeverAcceptedAsTheMilestoneHeadingOnStatePath', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[2]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.TRUNCATED);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: null });
});

// (RED) #3197: same defect, the UNANCHORED `:806` fallback path (no STATE
// version to anchor on).
test('phaseHeadingIsNeverAcceptedAsTheMilestoneHeadingOnFallbackPath', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[3]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNSCOPED);
  assert.strictEqual(result.value, null);
});

test('shippedHeadingIsNotReportedAsCurrentMilestone', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['# Roadmap', '', '## v3.3 — Old ✅ SHIPPED', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  // A shipped heading for the STATE-stored version is not "current" -- this
  // reduces to the same disposition as "no live heading found".
  assert.equal(result.scope, SCOPE.TRUNCATED);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: null });
});

test('knownVersionWithNoHeadingReportsVersionAndNullName', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['# Roadmap', '', '## Overview', '', 'No milestone headings here.'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.TRUNCATED);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: null });
});

// #3216 review Finding 4 / design row 10: no STATE `milestone:` field, no
// milestone heading anywhere, but a bare version token appears in plain
// prose (outside any Phase heading). That is weak-but-real evidence -- the
// version is retained, the name stays `null` (never fabricated), scope
// TRUNCATED. Sibling negative case (no version token anywhere) is
// `freeFormRoadmapWithNoVersionYieldsUnscopedNotV1Default` immediately below.
test('bareVersionInProseYieldsTruncatedWithNoName', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, ['# Roadmap', '', '## Overview', '', 'Targeting v3.3 for the next release.'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.TRUNCATED);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: null });
});

// (RED) #3197: free-form legacy ROADMAP with zero version tokens anywhere --
// the version is genuinely unresolvable and must not be invented.
test('freeFormRoadmapWithNoVersionYieldsUnscopedNotV1Default', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, ['# Roadmap', '', '## Overview', '', '### Phase 1: Foo'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNSCOPED);
  assert.strictEqual(result.value, null);
});

// (RED) THE load-bearing row. Every other row in this section can pass while
// the scope wiring is inverted (e.g. COMPLETE and UNREADABLE swapped) -- only
// a genuine v1.0 project reporting {v1.0, <its real name>}/COMPLETE proves the
// old `{version:'v1.0', name:'milestone'}` failure default is actually GONE,
// rather than renamed to a scope label nobody checks.
test('genuineV1ProjectIsDistinguishableFromTheOldFailureDefault', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, ['# Roadmap', '', '## v1.0 — Foundation Release', '', '### Phase 1: Bootstrap'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.deepStrictEqual(result.value, { version: 'v1.0', name: 'Foundation Release' });
  // The name is deliberately NOT the literal string 'milestone' -- that is the
  // old failure default's signature, and a project that legitimately named
  // its v1.0 milestone "milestone" is not this test's concern.
  assert.notStrictEqual(result.value.name, 'milestone');
});

test('absentRoadmapIsUnreadableScopeAndStaysSilent', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  // No ROADMAP.md written at all -- ENOENT.
  _resetUnusableInputWarningsForTests();

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNREADABLE);
  assert.strictEqual(result.value, null);
  // #1881: absence alone must never be reported -- every brand-new project
  // has no ROADMAP.md yet, and flagging that as corrupt would be noise.
  assert.strictEqual(_unusableInputEmissionCountForTests(), 0);
});

test('unreadableRoadmapReportsDiagnosticAndUnreadableScope', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  writeRoadmap(cwd, ['# Roadmap', '', '## v3.3 — Name'].join('\n'));
  writeState(cwd, { milestone: 'v3.3' });
  _resetUnusableInputWarningsForTests();

  mock.method(shellProj, 'platformReadSync', () => {
    const err = new Error('EACCES: simulated permission denied');
    err.code = 'EACCES';
    throw err;
  });
  t.after(() => {
    mock.restoreAll();
    cleanup(cwd);
  });

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNREADABLE);
  assert.strictEqual(result.value, null);
  // ADR-1411: unlike absence, a genuine read fault IS reported.
  assert.strictEqual(_unusableInputEmissionCountForTests(), 1);
});

test('unreadableStateFallsBackWithoutFabricatingAVersion', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  // No versioned milestones anywhere in the ROADMAP, so the fallback path
  // (once STATE.md is unreachable) has no version evidence to find either.
  writeRoadmap(cwd, ['# Roadmap', '', '## Overview', '', '### Phase 1: Foo'].join('\n'));
  writeState(cwd, { milestone: 'v3.3' });

  const originalRead = shellProj.platformReadSync;
  mock.method(shellProj, 'platformReadSync', (targetPath) => {
    if (typeof targetPath === 'string' && targetPath.endsWith('STATE.md')) {
      const err = new Error('EACCES: simulated permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return originalRead(targetPath);
  });
  t.after(() => {
    mock.restoreAll();
    cleanup(cwd);
  });

  const result = getMilestoneInfo(cwd);
  // Falls back to ROADMAP-only heuristics -- which find no version -- rather
  // than fabricating v1.0 or trusting a version it could not actually read.
  assert.equal(result.scope, SCOPE.UNSCOPED);
  assert.strictEqual(result.value, null);
});

test('emptyRoadmapYieldsUnscoped', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, '');

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNSCOPED);
  assert.strictEqual(result.value, null);
});

test('whitespaceOnlyRoadmapYieldsUnscoped', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, '   \n\n\t  \n');

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.UNSCOPED);
  assert.strictEqual(result.value, null);
});

test('headingLevelsOneThroughThreeAreAllAccepted', (t) => {
  const tmpDirs = [];
  t.after(() => { for (const d of tmpDirs) cleanup(d); });

  for (const level of [1, 2, 3]) {
    const cwd = createTempDir('gsd-milestone-identity-');
    tmpDirs.push(cwd);
    writeState(cwd, { milestone: 'v3.3' });
    writeRoadmap(cwd, [`${'#'.repeat(level)} v3.3 — Name`, '', 'body'].join('\n'));

    const result = getMilestoneInfo(cwd);
    assert.equal(result.scope, SCOPE.COMPLETE, `level ${level}`);
    assert.strictEqual(result.value.name, 'Name', `level ${level}`);
  }
});

test('headingLevelFourIsRejected', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['#### v3.3 — Name', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  // #{1,3} is the owner's level ceiling -- a level-4 heading is invisible to
  // it, same as no heading at all.
  assert.equal(result.scope, SCOPE.TRUNCATED);
  assert.deepStrictEqual(result.value, { version: 'v3.3', name: null });
});

test('versionSegmentCountsAtAndAroundTwoAreHandled', (t) => {
  const tmpDirs = [];
  t.after(() => { for (const d of tmpDirs) cleanup(d); });

  for (const version of ['v3', 'v3.3', 'v3.3.3']) {
    const cwd = createTempDir('gsd-milestone-identity-');
    tmpDirs.push(cwd);
    writeState(cwd, { milestone: version });
    writeRoadmap(cwd, [`## ${version} — Name`, '', 'body'].join('\n'));

    const result = getMilestoneInfo(cwd);
    assert.equal(result.scope, SCOPE.COMPLETE, version);
    assert.deepStrictEqual(result.value, { version, name: 'Name' }, version);
  }
});

test('realMilestoneHeadingWinsOverAPhaseHeadingMentioningTheSameVersion', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[4]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'Real Name');
});

test('prefersTheNonClosedHeadingWhenAVersionAppearsTwice', (t) => {
  const cwd = buildHFixture(t, H_CRLF_TABLE[5]);
  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'New');
});

// #730 regression guard: `v8.0` (STATE) must select the LIVE `v8.0-B`
// sub-milestone heading over the CLOSED `v8.0-A` one -- the `\b` boundary
// that makes this possible is deliberate, load-bearing behavior (§7.1).
test('subMilestoneSelectionIsPreservedForBoundaryWordChars', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v8.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v8.0-A — Old ✅ SHIPPED',
    '',
    '## v8.0-B — LiveMarker',
  ].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.version, 'v8.0');
  // Exact equality, not .includes(): the name derives from the heading's OWN
  // version token (v8.0-B), not the requested v8.0 -- an .includes() check
  // would also pass on a leaked prefix from the closed v8.0-A heading, which
  // is the specific misselection this row guards against (pinned rule,
  // .gsd/phase/refactor-3216-milestone-identity-single-owner/40-design.md).
  assert.equal(result.value.name, 'LiveMarker', `expected exact name LiveMarker, got ${JSON.stringify(result.value.name)}`);
});

// ADR-3180 §7.1 locks the `\b` boundary deliberately: `v2.0` (STATE) matching
// `## v2.0.1 — Name` is CORRECT, not a bug. Amendment 2 tried the stricter
// `(?![\w.-])` boundary specifically to stop this and REVERTED it because it
// breaks #730 sub-milestone selection (the row above). Do not "fix" this.
test('versionPrefixMatchInsideLongerVersionIsRetainedDeliberately', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, ['## v2.0.1 — Name', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.version, 'v2.0');
  // Exact equality, not .includes(): the name derives from the heading's OWN
  // version token (v2.0.1), not the requested v2.0 -- an .includes() check
  // would also pass on the '.1 — Name' leftover that stripping the
  // *requested* token (instead of the heading's own) would produce, which is
  // precisely the defect the pinned name-extraction rule excludes
  // (.gsd/phase/refactor-3216-milestone-identity-single-owner/40-design.md).
  assert.equal(result.value.name, 'Name', `expected exact name Name, got ${JSON.stringify(result.value.name)}`);
});

test('leadingDelimiterIsStrippedFromName', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['## v3.3 — Delimited Name', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'Delimited Name');
});

// #2135: a name beginning with '#' is a heading-parse failure -- it must stay
// loud (unstripped) rather than being silently cleaned, unlike a whitespace/
// dash/colon/em-dash leading delimiter.
test('hashLedNameIsLeftLoudRatherThanCleaned', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['## v3.3 #HashName', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, '#HashName');
});

test('crlfRoadmapsProduceIdenticalIdentityToLf', (t) => {
  const tmpDirs = [];
  t.after(() => { for (const d of tmpDirs) cleanup(d); });

  for (const entry of H_CRLF_TABLE) {
    const lfCwd = createTempDir('gsd-milestone-identity-crlf-lf-');
    const crlfCwd = createTempDir('gsd-milestone-identity-crlf-crlf-');
    tmpDirs.push(lfCwd, crlfCwd);
    if (entry.version) {
      writeState(lfCwd, { milestone: entry.version });
      writeState(crlfCwd, { milestone: entry.version });
    }
    const lfContent = entry.lines.join('\n');
    writeRoadmap(lfCwd, lfContent);
    writeRoadmap(crlfCwd, lfContent.replace(/\n/g, '\r\n'));

    const lfResult = getMilestoneInfo(lfCwd);
    const crlfResult = getMilestoneInfo(crlfCwd);
    assert.equal(crlfResult.scope, lfResult.scope, `scope mismatch for ${entry.label}`);
    assert.strictEqual(crlfResult.value?.name ?? null, lfResult.value?.name ?? null, `name mismatch for ${entry.label}`);
    if (crlfResult.value?.name) {
      assert.ok(!crlfResult.value.name.includes('\r'), `CRLF leaked into name for ${entry.label}: ${JSON.stringify(crlfResult.value.name)}`);
    }
  }
});

test('unicodeNameIsPreserved', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['## v3.3 — Ünïcode ▲', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'Ünïcode ▲');
});

test('veryLongNameIsNotTruncated', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  const longName = 'X'.repeat(4096);
  writeRoadmap(cwd, [`## v3.3 — ${longName}`, '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name.length, 4096);
  assert.strictEqual(result.value.name, longName);
});

// #2143: fence-awareness is explicitly out of scope for this phase (Decision
// 6) -- a milestone-shaped heading at line-start INSIDE a fenced code block
// still matches. Documented known limit, not a regression to fix here.
test('fencedHeadingStillMatchesAsADocumentedKnownLimit', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['# Roadmap', '', '```markdown', '## v3.3 — Fenced Name', '```', '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.name, 'Fenced Name');
});

// #40-design.md row 28's actual requirement: `escapeRegex` holds -- no
// crash, no catastrophic match. It does NOT require a hostile version ending
// in regex metacharacters to successfully RESOLVE to a milestone (with `\b`
// restored per ADR-3180 §7.1, `v1.0+(x)` sits between two non-word
// characters on both sides of its own boundary and structurally cannot
// match there -- that is the LOCKED `\b` semantics, not a defect).
test('versionWithRegexMetacharactersIsEscaped', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  const hostileVersion = 'v1.0+(x)';
  writeState(cwd, { milestone: hostileVersion });
  writeRoadmap(cwd, [`## ${hostileVersion} — Name`, '', 'body'].join('\n'));

  // 1. No crash.
  assert.doesNotThrow(() => getMilestoneInfo(cwd));
  const result = getMilestoneInfo(cwd);
  assert.strictEqual(result.value.version, hostileVersion, 'the raw hostile version is preserved verbatim');

  // 2. Metacharacters are treated as literals, never as regex operators. If
  // `+` and `(x)` were left unescaped, `v1.0+(x)` would compile to "v1",
  // then literal ".", then "one-or-more '0'", then a capturing group
  // matching literal "x" -- which would falsely match a document like
  // "v1.00000(x)" that the ESCAPED literal string must never match.
  const unescapedWouldFalselyMatch = ['## v1.00000(x) — Wrong Match', '', 'body'].join('\n');
  assert.strictEqual(
    locateMilestoneHeadings(unescapedWouldFalselyMatch, hostileVersion).length,
    0,
    'escaped metacharacters must not act as regex operators against an unrelated document',
  );

  // 3. Completes promptly -- no catastrophic backtracking. No elapsed-time
  // bound is asserted (see normalize-test-command.test.cjs's identical
  // rationale): a real ReDoS regression manifests as the run hanging /
  // being killed, which is a louder, more reliable signal than a threshold.
  const hostileRepeated = 'v1.0+(x)'.repeat(5000);
  writeState(cwd, { milestone: hostileRepeated });
  writeRoadmap(cwd, [`## ${hostileRepeated} — Name`, '', 'body'].join('\n'));
  assert.doesNotThrow(() => getMilestoneInfo(cwd));
});

test('versionWithReplacementPatternIsTreatedLiterally', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  const hostileVersion = 'v1.0$&$1';
  writeState(cwd, { milestone: hostileVersion });
  writeRoadmap(cwd, [`## ${hostileVersion} — Name`, '', 'body'].join('\n'));

  const result = getMilestoneInfo(cwd);
  assert.equal(result.scope, SCOPE.COMPLETE);
  assert.strictEqual(result.value.version, hostileVersion);
  // '$&'/'$1' must never be interpreted as a String.replace() substitution
  // pattern -- the extracted name must be exactly 'Name', not a corrupted
  // expansion of the hostile version token.
  assert.strictEqual(result.value.name, 'Name');
});

// Hostile / sink (#2288 defense in depth): a traversal-shaped STATE
// `milestone:` value must never let `archivePhaseDirectories` move phase
// history outside `.planning/milestones/`.
test('traversalVersionNeverEscapesTheMilestonesDirectory', (t) => {
  // `createTempGitProject` (git init + initial commit) gives the command's
  // own uncommitted-changes guard a deterministic clean repo, so the test
  // proves the real destructive-command guard rather than bypassing it with
  // `--force` -- `--force` is exactly the safety this row exercises.
  const cwd = createTempGitProject('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, ['# Roadmap', '', 'No milestone headings here.'].join('\n'));
  const hostileVersion = '../../etc/passwd';
  writeState(cwd, { milestone: hostileVersion });
  writeFile(cwd, path.join('.planning', 'phases', '01-example', 'PLAN.md'), '# Plan');
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', 'seed fixture'], { cwd });

  const escapeTarget = path.resolve(cwd, '.planning', 'milestones', '..', '..', 'etc', 'passwd-phases');
  assert.strictEqual(fs.existsSync(escapeTarget), false, 'precondition: escape target must not pre-exist');

  const result = runGsdTools(['phases', 'clear', '--confirm', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);

  // Negative proof: the traversal string never left `.planning/milestones/`.
  assert.strictEqual(fs.existsSync(escapeTarget), false);
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const entries = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
  assert.ok(entries.length > 0, 'expected the dated-fallback archive dir to exist');
  for (const entry of entries) {
    assert.ok(!entry.includes('etc') && !entry.includes('passwd'), `traversal string leaked into archive dir name: ${entry}`);
    // ARCHIVE_VERSION_LABEL_RE rejects the traversal string, so the archive
    // falls back to the dated label -- never the hostile STATE value.
    assert.match(entry, /^archived-\d{8}-phases$/);
  }
});

test('controlCharacterVersionIsRefusedAsAPathComponent', (t) => {
  // `createTempGitProject`, not a bare temp dir + `--force`: see rationale on
  // `traversalVersionNeverEscapesTheMilestonesDirectory` above.
  const cwd = createTempGitProject('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeRoadmap(cwd, ['# Roadmap', '', 'No milestone headings here.'].join('\n'));
  const ESC = String.fromCharCode(0x1b);
  const hostileVersion = `v1.0${ESC}[31mHACK`;
  writeState(cwd, { milestone: hostileVersion });
  writeFile(cwd, path.join('.planning', 'phases', '01-example', 'PLAN.md'), '# Plan');
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', 'seed fixture'], { cwd });

  const result = runGsdTools(['phases', 'clear', '--confirm', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  // Nothing replayed to the terminal: the hostile version never reaches the
  // command's own output.
  assert.strictEqual((result.output || '').includes(ESC), false);

  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const entries = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
  assert.ok(entries.length > 0, 'expected the dated-fallback archive dir to exist');
  for (const entry of entries) {
    assert.ok(!entry.includes(ESC), `control character leaked into archive dir name: ${JSON.stringify(entry)}`);
    assert.match(entry, /^archived-\d{8}-phases$/);
  }
});

test('undefinedCwdDoesNotThrow', () => {
  // The shipping caller shape: buildStateFrontmatter guards `if (cwd)` before
  // calling getMilestoneInfo, but getMilestoneInfo itself must survive being
  // called with cwd === undefined directly (#2245).
  let result;
  assert.doesNotThrow(() => { result = getMilestoneInfo(undefined); });
  assert.ok(result && typeof result === 'object' && 'scope' in result && 'value' in result);
  assert.ok(Object.values(SCOPE).includes(result.scope));
});

test('getMilestoneInfoNeverThrowsAcrossEveryInputClass', (t) => {
  const tmpDirs = [];
  t.after(() => { for (const d of tmpDirs) cleanup(d); });

  function freshDir() {
    const cwd = createTempDir('gsd-milestone-identity-');
    tmpDirs.push(cwd);
    return cwd;
  }

  const inputClasses = [
    // 1. No ROADMAP.md at all (ENOENT).
    () => freshDir(),
    // 2. Empty ROADMAP.
    () => { const c = freshDir(); writeRoadmap(c, ''); return c; },
    // 3. Whitespace-only ROADMAP.
    () => { const c = freshDir(); writeRoadmap(c, '   \n\t\n'); return c; },
    // 4. Phase-heading-only, V set.
    () => {
      const c = freshDir();
      writeState(c, { milestone: 'v3.3' });
      writeRoadmap(c, '### Phase 7: Close v3.3 gaps');
      return c;
    },
    // 5. Free-form legacy, no version anywhere.
    () => { const c = freshDir(); writeRoadmap(c, '## Overview\n### Phase 1: Foo'); return c; },
    // 6. Hostile regex-metacharacter version.
    () => {
      const c = freshDir();
      writeState(c, { milestone: 'v1.0+(x)[y]' });
      writeRoadmap(c, '## v1.0+(x)[y] — Name');
      return c;
    },
    // 7. Control-character version.
    () => {
      const c = freshDir();
      writeState(c, { milestone: `v1.0${String.fromCharCode(0x1b)}HACK` });
      writeRoadmap(c, '## Overview');
      return c;
    },
    // 8. Traversal-shaped version.
    () => {
      const c = freshDir();
      writeState(c, { milestone: '../../etc/passwd' });
      writeRoadmap(c, '## Overview');
      return c;
    },
    // 9. CRLF roadmap.
    () => {
      const c = freshDir();
      writeState(c, { milestone: 'v3.3' });
      writeRoadmap(c, '## v3.3 — Name\r\n\r\nbody\r\n');
      return c;
    },
    // 10. Sub-milestone selection shape.
    () => {
      const c = freshDir();
      writeState(c, { milestone: 'v8.0' });
      writeRoadmap(c, '## v8.0-A — Old ✅ SHIPPED\n\n## v8.0-B — Live');
      return c;
    },
    // 11. cwd === undefined.
    () => undefined,
    // 12. cwd pointing at a nonexistent directory.
    () => path.join(freshDir(), 'does-not-exist-subdir'),
  ];

  for (const build of inputClasses) {
    const cwd = build();
    assert.doesNotThrow(() => getMilestoneInfo(cwd), `getMilestoneInfo threw for input class producing cwd=${cwd}`);
  }
});

// Identity (4c): the consumers' OBSERVABLE output must agree with the
// owner's ScopedResult for the same fixture -- not a locally-reassembled
// copy of it (ADR-3180 Decision 4c: "post-filtering the canonical result" is
// itself a bypass this row is designed to catch).
test('consumerOutputsMatchTheOwnersScopedResultForTheSameFixture', (t) => {
  // `createTempGitProject`, not a bare temp dir + `--force`: see rationale on
  // `traversalVersionNeverEscapesTheMilestonesDirectory` above.
  const cwd = createTempGitProject('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  writeRoadmap(cwd, ['# Roadmap', '', '## v3.3 — Consolidated Name', '', 'body'].join('\n'));
  writeFile(cwd, path.join('.planning', 'phases', '01-example', 'PLAN.md'), '# Plan');
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', 'seed fixture'], { cwd });

  const owner = getMilestoneInfo(cwd);
  assert.equal(owner.scope, SCOPE.COMPLETE);

  // Consumer 1: buildStateFrontmatter, via `state sync` -> `state json`.
  const syncResult = runGsdTools(['state', 'sync', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(syncResult.success, true, syncResult.error);
  const jsonResult = runGsdTools(['state', 'json', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(jsonResult.success, true, jsonResult.error);
  const parsedJson = JSON.parse(jsonResult.output);
  assert.strictEqual(parsedJson.milestone, owner.value.version);
  assert.strictEqual(parsedJson.milestone_name, owner.value.name);

  // Consumer 2: archivePhaseDirectories, via `phases clear --confirm`.
  const clearResult = runGsdTools(['phases', 'clear', '--confirm', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(clearResult.success, true, clearResult.error);
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const entries = fs.readdirSync(milestonesDir);
  assert.deepStrictEqual(entries, [`${owner.value.version}-phases`]);
});

// (RED) Identity (4c), CLI: the full untruncated name must PERSIST through
// `state sync`, and a non-COMPLETE identity must never persist a fabricated
// name.
test('stateSyncPersistsTheOwnersIdentityNotAFabricatedOne', (t) => {
  const tmpDirs = [];
  t.after(() => { for (const d of tmpDirs) cleanup(d); });

  // Row-3 fixture: parenthetical name must persist UNTRUNCATED.
  const cwd3 = createTempDir('gsd-milestone-identity-');
  tmpDirs.push(cwd3);
  writeState(cwd3, { milestone: 'v3.3' });
  writeRoadmap(cwd3, ['# Roadmap', '', '## v3.3 — Portability (Windows)', '', 'body'].join('\n'));
  const sync3 = runGsdTools(['state', 'sync', '--cwd', cwd3, '--raw'], cwd3);
  assert.strictEqual(sync3.success, true, sync3.error);
  const json3result = runGsdTools(['state', 'json', '--cwd', cwd3, '--raw'], cwd3);
  assert.strictEqual(json3result.success, true, json3result.error);
  const json3 = JSON.parse(json3result.output);
  assert.strictEqual(json3.milestone_name, 'Portability (Windows)');

  // Row-4 fixture: only a Phase heading -- must persist NO fabricated name.
  const cwd4 = createTempDir('gsd-milestone-identity-');
  tmpDirs.push(cwd4);
  writeState(cwd4, { milestone: 'v3.3' });
  writeRoadmap(cwd4, ['# Roadmap', '', '### Phase 7: Close v3.3 gaps', '', 'body'].join('\n'));
  const sync4 = runGsdTools(['state', 'sync', '--cwd', cwd4, '--raw'], cwd4);
  assert.strictEqual(sync4.success, true, sync4.error);
  const json4result = runGsdTools(['state', 'json', '--cwd', cwd4, '--raw'], cwd4);
  assert.strictEqual(json4result.success, true, json4result.error);
  const json4 = JSON.parse(json4result.output);
  assert.strictEqual(json4.milestone, 'v3.3');
  assert.strictEqual('milestone_name' in json4, false, `milestone_name must be absent, not fabricated: ${JSON.stringify(json4.milestone_name)}`);
});

// (RED) Identity (4c), CLI: `archivePhaseDirectories` must refuse a
// syntactically-valid-but-not-COMPLETE version and fall back to the dated
// label instead -- #3197's exact bug (a fabricated-but-well-formed 'v3.3'
// passing ARCHIVE_VERSION_LABEL_RE and misfiling phase history).
test('phasesClearFallsBackToDatedLabelWhenIdentityIsNotComplete', (t) => {
  // `createTempGitProject`, not a bare temp dir + `--force`: see rationale on
  // `traversalVersionNeverEscapesTheMilestonesDirectory` above.
  const cwd = createTempGitProject('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  // Row-4 fixture: only a Phase heading -- scope is TRUNCATED, not COMPLETE,
  // even though 'v3.3' alone is a syntactically VALID archive label.
  writeRoadmap(cwd, ['# Roadmap', '', '### Phase 7: Close v3.3 gaps', '', 'body'].join('\n'));
  writeFile(cwd, path.join('.planning', 'phases', '01-example', 'PLAN.md'), '# Plan');
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', 'seed fixture'], { cwd });

  const owner = getMilestoneInfo(cwd);
  assert.notEqual(owner.scope, SCOPE.COMPLETE);

  const result = runGsdTools(['phases', 'clear', '--confirm', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const entries = fs.readdirSync(path.join(cwd, '.planning', 'milestones'));
  assert.strictEqual(entries.length, 1);
  // Must NOT be 'v3.3-phases' -- that is #3197's fabricated-but-well-formed
  // label misfiling phase history under the wrong milestone.
  assert.notStrictEqual(entries[0], 'v3.3-phases');
  assert.match(entries[0], /^archived-\d{8}-phases$/);
});

// (RED) Property: any name without a newline, rendered into a
// `## <v> — <name>` heading, round-trips through getMilestoneInfo with no
// truncation -- document-shaped (#2371): built from a local grammar here,
// never via any renderer in roadmap-parser.cjs.
test('propertyHeadingNameRoundTripsWithoutTruncation', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-property-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });

  // Starts with a letter so it can never collide with a leading-delimiter
  // strip; letters/digits/spaces/parens exercise the #3171 parenthetical
  // retention without ambiguity about what "round-trips" means.
  const nameGen = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ()]{0,60}$/).filter((s) => s.trim() === s && s.length > 0);

  const report = fc.check(
    fc.property(nameGen, (name) => {
      writeRoadmap(cwd, [`## v3.3 — ${name}`, '', 'body'].join('\n'));
      const result = getMilestoneInfo(cwd);
      return result.scope === SCOPE.COMPLETE && result.value.name === name;
    }),
    { seed: 3216, numRuns: 100 },
  );
  if (report.failed) {
    t.diagnostic(`H43 counterexample (replay seed=3216): ${JSON.stringify(report.counterexample)}`);
  }
  assert.strictEqual(report.failed, false, 'heading name must round-trip without truncation');
});

// Property: no generated `### Phase N …` heading -- with or without an
// embedded version token -- ever yields COMPLETE from getMilestoneInfo when
// it is the only heading in the document.
test('propertyPhaseHeadingsNeverYieldCompleteScope', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-property-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });

  const phaseWordGen = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/);
  const phaseNumGen = fc.integer({ min: 1, max: 999 });

  const report = fc.check(
    fc.property(phaseNumGen, phaseWordGen, (num, word) => {
      writeRoadmap(cwd, [`### Phase ${num}: Close v3.3 ${word}`, '', 'body'].join('\n'));
      const result = getMilestoneInfo(cwd);
      return result.scope !== SCOPE.COMPLETE;
    }),
    { seed: 3216, numRuns: 100 },
  );
  if (report.failed) {
    t.diagnostic(`H44 counterexample (replay seed=3216): ${JSON.stringify(report.counterexample)}`);
  }
  assert.strictEqual(report.failed, false, 'a Phase heading alone must never yield COMPLETE');
});

test('listMilestoneHeadingsEnumeratesEveryMilestoneInDocumentOrder', () => {
  const content = [
    '# Roadmap',
    '',
    '## v1.0 — First ✅ SHIPPED',
    '',
    '## v2.0 — Second',
    '',
    '### Phase 1: Foo',
    '',
    '## v3.0 — Third 🚧',
  ].join('\n');

  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].version, 'v1.0');
  assert.strictEqual(result[0].closed, true);
  assert.strictEqual(result[1].version, 'v2.0');
  assert.strictEqual(result[1].closed, false);
  assert.strictEqual(result[2].version, 'v3.0');
  assert.strictEqual(result[2].closed, false);
});

// (RED) #3197: a phase heading is never a milestone -- this is the SAME
// consolidation defect as site 1/2, in the THIRD copy (`roadmap.cts:454`).
test('listMilestoneHeadingsExcludesPhaseHeadings', () => {
  const content = ['# Roadmap', '', '### Phase 7: Close v3.3 gaps'].join('\n');
  const result = listMilestoneHeadings(content);
  assert.deepStrictEqual(result, []);
});

// (RED) #3171: the enumerated heading text must not be cut at a parenthetical.
test('listMilestoneHeadingsRetainsParentheticalNames', () => {
  const content = ['# Roadmap', '', '## v3.3 — Portability (Windows)'].join('\n');
  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].heading.includes('Portability (Windows)'), result[0].heading);
});

// (RED) #3216 review Finding 4: the shared grammar's `[^\n]*` captures a
// trailing `\r` on a CRLF-encoded ROADMAP, and unlike the inline
// `cmdRoadmapAnalyze` regex this replaced (which called `.trim()`),
// `listMilestoneHeadings` did not trim its `heading` extraction -- so a CRLF
// ROADMAP's `heading` field carried a stray trailing `\r` a LF ROADMAP never
// would. Every entry's `heading` must be `\r`-free and carry no leading/
// trailing whitespace, for every milestone in the document, not just one.
test('listMilestoneHeadingsHeadingFieldIsCrlfFreeAndTrimmed', () => {
  const content = ['## v3.3 — Portability (Windows)', '', '## v2.0 — Old ✅'].join('\r\n');
  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 2);
  for (const entry of result) {
    assert.ok(!entry.heading.includes('\r'), `CRLF leaked into heading: ${JSON.stringify(entry.heading)}`);
    assert.strictEqual(entry.heading, entry.heading.trim(), `heading not trimmed: ${JSON.stringify(entry.heading)}`);
  }
  assert.strictEqual(result[0].name, 'Portability (Windows)');
  assert.strictEqual(result[1].name, 'Old');
});

// (RED) #4134: the §7.2 pinned rule takes everything after the heading's OWN
// version token as the name, so a name-then-version heading (`… (v1.13)`) --
// the shape a first-ever ROADMAP.md drifts into when nothing templates its H1
// -- leaves exactly `)` after the token, which used to be enumerated as the
// milestone's "name". ADR-3180 §7.2 rule 6: a remainder with no letter or
// digit anywhere is heading structure, not a curated name -- enumerate it as
// `name: null` and let consumers report the honest TRUNCATED identity. The
// enumeration itself (which headings, which version, closed status) is
// unchanged; only the garbage "name" is refused.
test('listMilestoneHeadingsRefusesPunctuationOnlyNames', () => {
  const content = [
    '# Roadmap: GSD Core — Native OMP Runtime Support (v1.13)',
    '',
    '### Phase 1: Runtime Adapter Interface',
  ].join('\n');
  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].version, 'v1.13');
  assert.strictEqual(result[0].closed, false);
  assert.strictEqual(result[0].name, null, `name must be null, not ${JSON.stringify(result[0].name)}`);
});

// (RED) #4134 negative space: a name that merely CONTAINS punctuation is a
// name -- `(` is an ordinary name character and never a terminator (#3171).
// Only a remainder with zero word characters is refused.
test('listMilestoneHeadingsKeepsNamesThatContainPunctuation', () => {
  const content = ['# Roadmap', '', '## v3.3 — Name (Part 2: Revenge)'].join('\n');
  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'Name (Part 2: Revenge)');
});

test('listMilestoneHeadingsRespectsTheOneToThreeLevelBound', () => {
  const content = [
    '# v1.0 — Level One',
    '',
    '## v2.0 — Level Two',
    '',
    '### v3.0 — Level Three',
    '',
    '#### v4.0 — Level Four',
  ].join('\n');

  const result = listMilestoneHeadings(content);
  const versions = result.map((h) => h.version);
  assert.deepStrictEqual(versions, ['v1.0', 'v2.0', 'v3.0']);
});

test('listMilestoneHeadingsFlagsClosedMilestones', () => {
  const content = ['## v1.0 — Closed ✅ SHIPPED', '', '## v2.0 — Live 🚧'].join('\n');
  const result = listMilestoneHeadings(content);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].closed, true);
  assert.strictEqual(result[1].closed, false);
});

// (RED) Identity (4c), CLI: `roadmap analyze`'s `milestones[]` must agree
// with `listMilestoneHeadings` over the SAME scoped content the consumer
// actually used (extractCurrentMilestoneScoped's `.value`), not a
// re-derivation of it.
test('roadmapAnalyzeMilestonesMatchTheOwnersEnumeration', (t) => {
  const cwd = createTempDir('gsd-milestone-identity-');
  t.after(() => cleanup(cwd));
  writeState(cwd, { milestone: 'v3.3' });
  const rawContent = [
    '# Roadmap',
    '',
    '## v3.3 — Portability (Windows)',
    '',
    '### Phase 7: Close v3.3 gaps',
    '',
    '### Phase 1: Foo',
  ].join('\n');
  writeRoadmap(cwd, rawContent);

  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  const parsed = JSON.parse(result.output);

  assert.strictEqual(parsed.milestones.length, 1);
  assert.ok(parsed.milestones[0].heading.includes('Portability (Windows)'), parsed.milestones[0].heading);
  assert.ok(!parsed.milestones.some((m) => /Phase\s+7/.test(m.heading)), 'a Phase heading must never be reported as a milestone');

  // Agreement with the owner's enumeration over the SAME scoped content the
  // consumer actually used.
  const ownerContent = extractCurrentMilestoneScoped(rawContent, cwd).value;
  const ownerHeadings = listMilestoneHeadings(ownerContent);
  assert.strictEqual(parsed.milestones.length, ownerHeadings.length);
  for (let i = 0; i < ownerHeadings.length; i += 1) {
    assert.strictEqual(parsed.milestones[i].version, ownerHeadings[i].version);
  }
});

// Parity (anti-drift seam): `listMilestoneHeadings` (version-agnostic
// enumeration) and `locateMilestoneHeadings` (version-filtered locator) must
// agree on WHICH milestone headings are selected for a given version — NOT
// on raw heading text. The two are legitimately different representations:
// `locateMilestoneHeadings` returns raw `RegExpExecArray`s (`m[1]` is the
// full matched line, `#`s included), while `listMilestoneHeadings` returns
// structured entries whose `heading` field has the `#{1,3}` prefix and
// following whitespace stripped (matching the inline `cmdRoadmapAnalyze`
// regex this replaced). Comparing raw strings between the two would make
// this test assert an accidental implementation detail rather than the
// actual parity contract, and would silently regress if either owner's
// textual representation ever changed for an unrelated reason.
test('versionFilteredEnumerationMatchesTheLocator', () => {
  const content = [
    '# Roadmap',
    '',
    '## v1.0 — First ✅ SHIPPED',
    '',
    '## v2.0 — Second',
    '',
    '## v2.0 — Second Redux 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '## v3.0 — Third',
  ].join('\n');

  const enumerated = listMilestoneHeadings(content);
  const versions = [...new Set(enumerated.map((h) => h.version))];
  assert.ok(versions.length > 1, 'fixture must exercise more than one version');

  for (const version of versions) {
    const enumeratedCount = enumerated.filter((h) => h.version === version).length;
    const located = locateMilestoneHeadings(content, version);
    assert.strictEqual(
      located.length > 0,
      enumeratedCount > 0,
      `selection disagreement for ${version}: listMilestoneHeadings found ${enumeratedCount}, locateMilestoneHeadings found ${located.length}`,
    );
    assert.strictEqual(
      located.length,
      enumeratedCount,
      `selection count mismatch for ${version}`,
    );
  }
});

// H-P: document-shaped generator (#2371) local to this section -- built from
// a heading/prose grammar, never by calling any renderer in
// roadmap-parser.cjs. Deliberately independent of Section G's blockGen so a
// regression in one generator cannot mask a regression in the other.
const H_SAFE_WORD = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/);

const hHeadingBlockGen = fc.record({
  level: fc.integer({ min: 1, max: 4 }),
  isPhase: fc.boolean(),
  hasVersion: fc.boolean(),
  word: H_SAFE_WORD,
}).map((b) => ({
  render() {
    const prefix = '#'.repeat(b.level);
    const phasePart = b.isPhase ? 'Phase 3: ' : '';
    const versionPart = b.hasVersion ? ' v2.0' : '';
    return `${prefix} ${phasePart}${b.word}${versionPart}`;
  },
}));

const hProseBlockGen = H_SAFE_WORD.map((word) => ({ render() { return `prose ${word} line`; } }));

const hBlockGen = fc.oneof(hHeadingBlockGen, hProseBlockGen);

// Property: for any generated document, no entry `listMilestoneHeadings`
// returns ever has a heading beginning with 'Phase '.
test('propertyEnumerationNeverReturnsAPhaseHeading', (t) => {
  const documentGen = fc.array(hBlockGen, { minLength: 1, maxLength: 12 });

  const report = fc.check(
    fc.property(documentGen, (blocks) => {
      const content = blocks.map((b) => b.render()).join('\n');
      const result = listMilestoneHeadings(content);
      return result.every((h) => !/^Phase\s/i.test(h.heading.replace(/^#{1,3}\s+/, '').trim()));
    }),
    { seed: 3216, numRuns: 100 },
  );
  if (report.failed) {
    t.diagnostic(`H54 counterexample (replay seed=3216): ${JSON.stringify(report.counterexample)}`);
  }
  assert.strictEqual(report.failed, false, 'listMilestoneHeadings must never enumerate a Phase heading');
});
