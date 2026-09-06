/**
 * roadmap-parser.cjs — unit tests
 *
 * Covers the 6 functions extracted from core.cjs per ADR-857 rollout
 * phase 2b (#870): stripShippedMilestones, extractCurrentMilestone,
 * replaceInCurrentMilestone, getRoadmapPhaseInternal, getMilestoneInfo,
 * getMilestonePhaseFilter.
 *
 * Includes:
 *   - Behavioral tests against realistic ROADMAP.md content
 *   - Adversarial fixtures (malformed frontmatter, unclosed fences,
 *     headings inside fences, unicode headings, repeated/decimal phase
 *     IDs, mixed CRLF/LF)
 *   - Shim-identity assertions verifying core.cjs re-exports are the
 *     same function objects as roadmap-parser.cjs exports
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const roadmapParser = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  isMilestoneShippedInRoadmap,
  withPhaseSection,
} = roadmapParser;

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function writeState(tmpDir, fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lines.join('\n') + '\n');
}


// ─── stripShippedMilestones ───────────────────────────────────────────────────

describe('roadmap-parser: stripShippedMilestones', () => {
  test('strips a single <details> block', () => {
    const input = 'before\n<details>\nsome shipped content\n</details>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('<details>'), 'details tag should be removed');
    assert.ok(!result.includes('shipped content'), 'shipped content should be removed');
    assert.ok(result.includes('before'), 'before content preserved');
    assert.ok(result.includes('after'), 'after content preserved');
  });

  test('strips multiple <details> blocks', () => {
    const input = '<details>\nA\n</details>\nmiddle\n<details>\nB\n</details>\nend';
    const result = stripShippedMilestones(input);
    assert.ok(result.includes('middle'), 'middle content preserved');
    assert.ok(result.includes('end'), 'end content preserved');
    assert.ok(!result.includes('<details>'), 'all details tags removed');
  });

  test('returns unchanged string when no <details> blocks', () => {
    const input = '## v1.0: Launch\n### Phase 1: Setup\n**Goal:** init\n';
    assert.strictEqual(stripShippedMilestones(input), input);
  });

  test('handles case-insensitive <DETAILS> tags', () => {
    const input = '<DETAILS>\nclosed content\n</DETAILS>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('closed content'), 'content removed');
    assert.ok(result.includes('after'), 'after content preserved');
  });

  test('#557: preserves an active <details open> block while stripping shipped bare <details>', () => {
    // <details open> marks the ACTIVE milestone (roadmap.analyze must still see its
    // phases); only closed/shipped bare <details> blocks are stripped. Regression for
    // #557, which the #2128 shared-seam migration briefly reintroduced via the seam's
    // attribute-tolerance — the details strip is now attr-INTOLERANT to keep #557 fixed.
    const input = '<details>\nshipped phase\n</details>\n<details open>\n- [ ] **Phase 9: Active**\n</details>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('shipped phase'), 'shipped bare <details> stripped');
    assert.ok(result.includes('<details open>'), 'active <details open> tag preserved');
    assert.ok(result.includes('Phase 9: Active'), 'active-milestone phases preserved');
    assert.ok(result.includes('after'), 'trailing content preserved');
  });
});

// ─── extractCurrentMilestone ──────────────────────────────────────────────────

describe('roadmap-parser: extractCurrentMilestone', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no cwd — strips <details> only', () => {
    const input = '<details>\nshipped\n</details>\n## v2.0: Next\n### Phase 1: Setup\n';
    const result = extractCurrentMilestone(input);
    assert.ok(!result.includes('<details>'), 'details stripped');
    assert.ok(result.includes('v2.0'), 'version heading preserved');
  });

  test('newest-first layout: archived details below the active milestone do not leak into the window (#3982)', () => {
    // The archived milestone's title lives in the <summary> TAG, not a
    // heading, so no milestone-shaped heading bounds the section walk and the
    // raw currentSection used to swallow the whole <details> block — feeding
    // archived phases to phase.complete's lowest-outstanding scan.
    writeState(tmpDir, { milestone: 'v0.3' });
    const content = [
      '# Roadmap',
      '',
      '### 🚧 v0.3 — Third Milestone (Phases 20-22) — ACTIVE',
      '',
      '- [x] **Phase 20: First Thing** - does the first thing.',
      '- [ ] **Phase 21: Second Thing** - does the second thing.',
      '- [ ] **Phase 22: Third Thing** - does the third thing.',
      '',
      '<details>',
      '<summary>✅ v0.2 Second Milestone (Phases 10-12) — ARCHIVED</summary>',
      '',
      '- [ ] **Phase 10: Never Finished** - was left unchecked when v0.2 closed.',
      '- [x] **Phase 11: Done Thing** - completed.',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>✅ v0.1 First Milestone (Phases 1-2) — ARCHIVED</summary>',
      '',
      '- [x] **Phase 1: Done** - completed.',
      '',
      '</details>',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 21'), 'the real next phase stays in the window');
    assert.ok(result.includes('Phase 22'), 'the last current phase stays in the window');
    assert.ok(!result.includes('Phase 10'), 'an archived milestone\'s unchecked phase must not leak into the current window (#3982)');
    assert.ok(!result.includes('Never Finished'), 'archived milestone content must not leak (#3982)');
    assert.ok(!result.includes('Phase 1: Done'), 'a second archived details block must not leak either');
  });

  test('active milestone own collapsed details are preserved by the closed-only strip (#3982)', () => {
    // The issue's adversarial fixture: the ACTIVE milestone holds its own
    // collapsed <details> (deferred scope). A blanket strip would delete
    // phases 21/22 and reproduce the phase_count: 0 class (#557/#2947).
    writeState(tmpDir, { milestone: 'v0.3' });
    const content = [
      '# Roadmap', '',
      '### 🚧 v0.3 — Third Milestone (Phases 20-22) — ACTIVE', '',
      '- [x] **Phase 20: First Thing** - done.',
      '',
      '<details>',
      '<summary>Deferred scope for v0.3</summary>', '',
      '- [ ] **Phase 21: Second Thing** - deferred.',
      '- [ ] **Phase 22: Third Thing** - deferred.',
      '',
      '</details>', '',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 21'), 'the active milestone\'s own collapsed phases must survive (#3982)');
    assert.ok(result.includes('Phase 22'), 'the active milestone\'s own collapsed phases must survive (#3982)');
  });

  test('reads milestone from STATE.md and extracts that section', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    const content = [
      '<details>',
      '<summary>v1.0</summary>',
      '### Phase 1: Old',
      '</details>',
      '## v2.0: Current',
      '### Phase 2-01: Setup',
      '**Goal:** build',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v2.0'), 'current milestone section included');
    assert.ok(!result.includes('Old'), 'shipped milestone section excluded');
  });

  test('falls back to 🚧 marker when STATE.md has no milestone field', () => {
    writeState(tmpDir, { phase: 'some-phase' });
    const content = [
      '## 🚧 **v2.0 Work in Progress**',
      '### Phase 1: Active',
      '**Goal:** do work',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v2.0'), 'inferred v2.0 milestone section included');
  });

  test('strips shipped milestones when no STATE.md and no 🚧 marker', () => {
    const content = [
      '<details>',
      '<summary>v1.0 done</summary>',
      '### Phase 1: Done',
      '</details>',
      '## v2.0: Next (no WIP marker)',
      '### Phase 2: Future',
    ].join('\n');

    const result = extractCurrentMilestone(content);
    assert.ok(!result.includes('<details>'), 'details stripped');
    assert.ok(result.includes('v2.0'), 'remaining content preserved');
  });

  test('unicode heading — emoji-prefixed milestone', () => {
    writeState(tmpDir, { milestone: 'v3.0' });
    const content = [
      '## ✅ v1.0: Shipped',
      '## 🚧 v3.0: In Progress',
      '### Phase 3-01: Unicode Héros',
      '**Goal:** тест',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v3.0'), 'v3.0 heading included');
    assert.ok(result.includes('Unicode'), 'unicode phase name included');
  });

  test('CRLF line endings are handled', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    const content = '## v1.0: CRLF\r\n### Phase 1: Setup\r\n**Goal:** crlf goal\r\n';
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v1.0'), 'section found despite CRLF');
  });

  test('heading inside fenced code block not confused for milestone boundary', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    const content = [
      '## v1.0: Current Milestone',
      '### Phase 1: Real Phase',
      '**Goal:** real goal',
      '```markdown',
      '## v2.0: Fake Heading Inside Fence',
      '```',
      '### Phase 2: Also Real',
      '**Goal:** also real',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    // The section should include Phase 1 content; the fenced heading should not terminate section early
    assert.ok(result.includes('real goal'), 'phase 1 content included');
    assert.ok(result.includes('Also Real'), 'phase 2 content also included');
  });

  // ─── #2947: milestone anchor must prefer the heading whose section contains
  // Phase details, not just the first version-bearing heading anywhere. ────────

  test('#2947 — prefers the heading whose section contains Phase details over a later version-bearing progress heading', () => {
    // The shipped greenfield template's `## Phases` is NOT version-bearing,
    // but a later `### v9.0 phase progress` heading (under `## Progress`) is.
    // The anchor must not latch onto the progress heading and drop the phases.
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Milestones',
      '',
      '- 🚧 **v9.0 Test Milestone** — Phases 1-2 (in progress)',
      '',
      '## Phases',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
      '### Phase 2: Beta',
      '',
      '**Goal:** do beta',
      '',
      '## Progress',
      '',
      '### v9.0 phase progress',
      '',
      '| Phase | Status |',
      '|-------|--------|',
      '| 1     | Planned |',
      '| 2     | Planned |',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    // The Phase detail headings must be inside the extracted section.
    assert.ok(result.includes('Phase 1: Alpha'), 'Phase 1 detail must be in scope (got dropped — #2947)');
    assert.ok(result.includes('Phase 2: Beta'), 'Phase 2 detail must be in scope (got dropped — #2947)');
    // The progress heading should NOT be the anchor (it has no phase details).
    assert.ok(!result.startsWith('### v9.0 phase progress'), 'progress heading must not be the anchor');
  });

  test('#2947 — version-bearing phase-listing heading still resolves (control, no regression)', () => {
    // The one-word control from the issue: rename `## Phases` → `## v9.0 Phases`.
    // This already works today and must keep working after the fix.
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## v9.0 Phases',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
      '### Phase 2: Beta',
      '',
      '**Goal:** do beta',
      '',
      '## Progress',
      '',
      '### v9.0 phase progress',
      '',
      '| Phase | Status |',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 1: Alpha'), 'control: Phase 1 in scope');
    assert.ok(result.includes('Phase 2: Beta'), 'control: Phase 2 in scope');
  });

  test('#2947 — falls back to first non-closed when no candidate section has Phase details', () => {
    // No `### Phase N:` details anywhere — the fix's fallback must preserve
    // today's behavior (no crash, returns a section).
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## v9.0 Milestone',
      '',
      'Some prose, no phase detail headings.',
      '',
      '### v9.0 notes',
      '',
      'More prose.',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(typeof result === 'string', 'fallback returns a string section without throwing');
    assert.ok(result.includes('v9.0'), 'fallback still includes the milestone content');
  });

  test('#2947 — closed milestone heading is not preferred over an open one with phase details', () => {
    // A closed (✅) version-bearing heading must not win over an open one
    // whose section contains the phase details.
    writeState(tmpDir, { milestone: 'v2.0' });
    const content = [
      '# ROADMAP',
      '',
      '## ✅ v1.0 Shipped',
      '',
      '### Phase 1: Old',
      '',
      '## 🚧 v2.0 Current',
      '',
      '### Phase 2: New',
      '',
      '**Goal:** new work',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 2: New'), 'open milestone phase selected');
    assert.ok(!result.includes('Phase 1: Old'), 'closed milestone phase excluded');
  });

  test('#2947 — roadmap.analyze on the issue fixture reports phase_count 2 (end-to-end)', () => {
    writeState(tmpDir, { milestone: 'v9.0', gsd_state_version: '1.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Milestones',
      '',
      '- 🚧 **v9.0 Test Milestone** — Phases 1-2 (in progress)',
      '',
      '## Phases',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
      '### Phase 2: Beta',
      '',
      '**Goal:** do beta',
      '',
      '## Progress',
      '',
      '### v9.0 phase progress',
      '',
      '| Phase | Status |',
      '|-------|--------|',
      '| 1     | Planned |',
      '| 2     | Planned |',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const result = runGsdTools(['query', 'roadmap.analyze', '--raw'], tmpDir);
    assert.ok(result.success, `roadmap.analyze should succeed; got: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.phase_count, 2, `expected phase_count 2, got ${payload.phase_count} (phases dropped — #2947)`);
  });

  // ─── #3235: the preamble strip's conditional wraps the REPLACE, not the pattern.
  // The previous form selected between the strip regex and a `/$/` sentinel, making
  // the do-not-strip branch an identity replacement (CodeQL js/identity-replacement,
  // alert 53). These pin BOTH branches so the restructure cannot move behavior. ──────

  test('#3235 — Phase Details heading is stripped even when preamble phase details are preserved', () => {
    // The do-not-strip branch must leave `### Phase N:` blocks alone WITHOUT also
    // disabling the unconditional `Phase Details` heading strip. Pulling that second
    // replace inside the conditional would regress #730 invisibly: no existing #2947
    // fixture carries a `Phase Details` heading, so the suite would stay green.
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Milestones',
      '',
      '- 🚧 **v9.0 Test Milestone** — Phases 1-2 (in progress)',
      '',
      '## Phase Details',
      '',
      '## Phases',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
      '### Phase 2: Beta',
      '',
      '**Goal:** do beta',
      '',
      '## Progress',
      '',
      '### v9.0 phase progress',
      '',
      '| Phase | Status |',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 1: Alpha'), 'do-not-strip branch preserves preamble phase details');
    assert.ok(result.includes('Phase 2: Beta'), 'do-not-strip branch preserves every preamble phase detail');
    assert.ok(!result.includes('## Phase Details'), 'the Phase Details heading strip is unconditional and must still run');
  });

  test('#3235 — preamble phase details are still stripped when the milestone section has its own', () => {
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Preamble',
      '',
      '### Phase 7: PreambleGhost',
      '',
      '**Goal:** should be stripped',
      '',
      '## 🚧 v9.0 Current',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 1: Alpha'), 'selected milestone phases retained');
    assert.ok(!result.includes('PreambleGhost'), 'preamble phase-detail heading stripped on the strip branch');
    assert.ok(!result.includes('should be stripped'), 'the stripped heading takes its body with it');
    assert.ok(result.includes('## Preamble'), 'a non-Phase preamble heading is untouched');
  });

  test('#3235 — preamble strip honors the #{2,4} heading-depth bounds', () => {
    // Boundary coverage: limit-1 (h1) and limit+1 (h5) survive; h2 and h4 are stripped.
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '# Phase 90: DepthOne',
      '',
      '## Phase 91: DepthTwo',
      '',
      '#### Phase 93: DepthFour',
      '',
      '##### Phase 94: DepthFive',
      '',
      '## 🚧 v9.0 Current',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('DepthOne'), 'h1 is below the #{2,4} floor and survives');
    assert.ok(!result.includes('DepthTwo'), 'h2 is at the floor and is stripped');
    assert.ok(!result.includes('DepthFour'), 'h4 is at the ceiling and is stripped');
    assert.ok(result.includes('DepthFive'), 'h5 is above the #{2,4} ceiling and survives');
  });

  test('#3235 — #1729 pre-colon tag tolerance survives in the hoisted strip', () => {
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Preamble',
      '',
      '### Phase 8 (deferred): TaggedGhost',
      '',
      '**Goal:** should be stripped',
      '',
      '## 🚧 v9.0 Current',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(!result.includes('TaggedGhost'), '`### Phase 8 (deferred):` still matches the strip (#1729)');
    assert.ok(result.includes('Phase 1: Alpha'), 'selected milestone phases retained');
  });

  // The fixture below carries its own `## Phase Details` heading in the preamble.
  // The LF-only sibling test above can't catch a CRLF-specific regression in the
  // `[^\n]*` / `\n?` tail of the Phase Details strip regex — those tail tokens are
  // LF-anchored, so only a CRLF document can prove the strip still consumes the
  // heading (and only the heading, leaving no orphaned `\r`) when line endings are
  // `\r\n` throughout.
  test('#3235 — CRLF roadmap preserves preamble phases on the do-not-strip branch', () => {
    writeState(tmpDir, { milestone: 'v9.0' });
    const content = [
      '# ROADMAP',
      '',
      '## Milestones',
      '',
      '- 🚧 **v9.0 Test Milestone**',
      '',
      '## Phase Details',
      '',
      '## Phases',
      '',
      '### Phase 1: Alpha',
      '',
      '**Goal:** do alpha',
      '',
      '## Progress',
      '',
      '### v9.0 phase progress',
      '',
      '| Phase | Status |',
    ].join('\n').replace(/\n/g, '\r\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('Phase 1: Alpha'), 'CRLF preamble phases preserved');
    assert.ok(result.includes('\r\n'), 'CRLF line endings preserved in the extracted section');
    assert.ok(!/^#{1,4}[ \t]*Phase Details\b/m.test(result), 'the unconditional Phase Details strip also runs under CRLF');
    assert.ok(!/\r(?!\n)/.test(result), 'the CRLF strip leaves no orphaned CR behind');
  });

  test('#3235 — property: Phase Details strip is unconditional and #{2,4} bounds hold across generated preambles', () => {
    writeState(tmpDir, { milestone: 'v9.0' });

    // The alphabet below is deliberately a fixed list of literal line shapes, NOT
    // derived from the parser's own regexes (CONTRIBUTING.md #2371: document-shaped,
    // not writer-seeded).
    const PREAMBLE_LINE = fc.constantFrom(
      '## Phase 11: PreTwo',
      '### Phase 12: PreThree',
      '#### Phase 13: PreFour',
      '# Phase 14: PreOne',
      '##### Phase 15: PreFive',
      '## Phase Details',
      '#### Phase Details — trailing',
      'prose line',
      '**Goal:** something',
      '',
      '---',
      '| Phase | Status |',
    );

    for (const hasOwnDetails of [true, false]) {
      const prop = fc.property(
        fc.array(PREAMBLE_LINE, { minLength: 0, maxLength: 12 }),
        (preambleLines) => {
          const doc = [
            '# ROADMAP',
            '',
            ...preambleLines,
            '',
            '## 🚧 v9.0 Current',
            '',
            ...(hasOwnDetails
              ? ['### Phase 1: OwnPhase', '', '**Goal:** own goal']
              : ['just prose, no phase headings']),
          ].join('\n');

          writeRoadmap(tmpDir, doc);
          const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
          const result = extractCurrentMilestone(roadmap, tmpDir);

          // Invariant 1 (ALWAYS): no Phase Details heading survives, on either branch.
          if (/^#{1,4}[ \t]*Phase Details\b/m.test(result)) return false;

          // Invariant 2 (ALWAYS): markers outside the strip regex's #{2,4} bound
          // survive if they were present in the input.
          if (preambleLines.includes('# Phase 14: PreOne') && !result.includes('PreOne')) return false;
          if (preambleLines.includes('##### Phase 15: PreFive') && !result.includes('PreFive')) return false;

          if (hasOwnDetails) {
            // Invariant 3: the milestone section has its own Phase headings, so
            // every preamble Phase heading (#{2,4}) must be stripped.
            if (result.includes('PreTwo') || result.includes('PreThree') || result.includes('PreFour')) {
              return false;
            }
          } else {
            // Invariant 4: the milestone section has no Phase headings of its own,
            // so preamble Phase headings (#{2,4}) are preserved on the do-not-strip branch.
            for (const marker of ['PreTwo', 'PreThree', 'PreFour']) {
              const appeared = preambleLines.some((line) => line.includes(marker));
              if (appeared && !result.includes(marker)) return false;
            }
          }

          return true;
        },
      );

      fc.assert(prop, { seed: 20260809, numRuns: 300, verbose: true });
    }
  });
});

// ─── replaceInCurrentMilestone ────────────────────────────────────────────────

describe('roadmap-parser: replaceInCurrentMilestone', () => {
  test('replaces in content after last </details> when present', () => {
    const content = '<details>\nold\n</details>\n**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    assert.ok(result.includes('1/1 plans complete'), 'replacement applied after </details>');
    assert.ok(result.includes('<details>'), 'details block untouched');
  });

  test('replaces anywhere when no </details> present', () => {
    const content = '**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    assert.strictEqual(result, '**Plans:** 1/1 plans complete');
  });

  test('does not replace in shipped sections', () => {
    const content = '<details>\n**Plans:** 0/1 plans\n</details>\n## v2.0\n**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    // Only the SECOND occurrence (after </details>) should be replaced
    assert.ok(result.includes('<details>\n**Plans:** 0/1 plans\n</details>'), 'shipped section unchanged');
    assert.ok(result.includes('## v2.0\n**Plans:** 1/1 plans complete'), 'current section updated');
  });
});

// ─── getRoadmapPhaseInternal ──────────────────────────────────────────────────

describe('roadmap-parser: getRoadmapPhaseInternal', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns null when ROADMAP.md missing', () => {
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('returns null when phaseNum is falsy', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foo\n**Goal:** bar\n');
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, null), null);
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, ''), null);
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, 0), null);
  });

  test('finds a phase by number', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 1: Foundation',
      '**Goal:** Set up infrastructure',
      '',
      '### Phase 2: API',
      '**Goal:** Build the API',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.ok(result !== null, 'result should not be null');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Foundation');
    assert.strictEqual(result.goal, 'Set up infrastructure');
  });

  test('finds drifted project-code-prefixed headings by bare number (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Recover from roadmapper heading drift',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '117');
    assert.ok(result !== null, 'bare number lookup should tolerate a prefixed heading');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '117');
    assert.strictEqual(result.phase_name, 'Prefixed Heading');
    assert.strictEqual(result.goal, 'Recover from roadmapper heading drift');
  });

  test('finds drifted project-code-prefixed headings by prefixed query (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Exact prefixed lookup works on init resolver',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, 'MANIFOLD-117');
    assert.ok(result !== null, 'prefixed lookup should resolve the matching prefixed heading');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, 'MANIFOLD-117');
    assert.strictEqual(result.phase_name, 'Prefixed Heading');
    assert.strictEqual(result.goal, 'Exact prefixed lookup works on init resolver');
  });

  test('prefers canonical bare heading before prefixed drift fallback (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Drift fallback',
      '',
      '### Phase 117: Bare Heading',
      '**Goal:** Canonical bare',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '117');
    assert.ok(result !== null, 'bare lookup should resolve');
    assert.strictEqual(result.phase_name, 'Bare Heading');
    assert.strictEqual(result.goal, 'Canonical bare');
  });

  test('returns null for missing phase number', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foo\n**Goal:** bar\n');
    const result = getRoadmapPhaseInternal(tmpDir, '99');
    assert.strictEqual(result, null);
  });

  test('finds milestone-prefixed phase ID (e.g. 2-01)', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** first alpha phase',
      '',
      '### Phase 2-02: Beta',
      '**Goal:** beta phase',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '2-01');
    assert.ok(result !== null);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Alpha');
    assert.strictEqual(result.goal, 'first alpha phase');
  });

  test('decimal phase ID (e.g. 1.5)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 1.5: Intermediate',
      '**Goal:** interstitial step',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '1.5');
    assert.ok(result !== null);
    assert.strictEqual(result.phase_name, 'Intermediate');
  });
});

// ─── getMilestoneInfo ─────────────────────────────────────────────────────────

describe('roadmap-parser: getMilestoneInfo', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns UNREADABLE scope (value null) when ROADMAP.md missing (#3216: the v1.0/"milestone" default was deleted per ADR-3180 §7.2 rule 4)', () => {
    const info = getMilestoneInfo(tmpDir);
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNREADABLE });
  });

  test('reads version from STATE.md and heading name', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, '## v2.0: The Big Launch\n### Phase 1: Setup\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v2.0');
    assert.match(info.value.name, /Big Launch/);
  });

  test('falls back to 🚧 WIP marker when STATE.md has no milestone', () => {
    writeRoadmap(tmpDir, '## 🚧 **v1.5 Work In Progress**\n### Phase 1: Do stuff\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v1.5');
    assert.match(info.value.name, /Work In Progress/i);
  });

  test('extracts from heading when no STATE.md and no WIP marker', () => {
    writeRoadmap(tmpDir, [
      '## v3.0: Future Milestone',
      '### Phase 1: Not started',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v3.0');
    assert.match(info.value.name, /Future Milestone/);
  });

  test('skips completed ✅ milestones', () => {
    writeRoadmap(tmpDir, [
      '## ✅ v1.0: Shipped Already',
      '## v2.0: Next Up',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    // Should not use the ✅-prefixed version as the current milestone
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v2.0');
  });
});

// ─── getMilestoneInfo — #2135 milestone_name clobber ──────────────────────────
// The `##` heading regex was unanchored (no `^`/`m`), so it matched a `##`
// quoted mid-line inside a Milestones bullet and captured a delimiter-led
// fragment into `milestone_name`. The fix: consult the 🚧 name-bearing marker
// FIRST, anchor the `##` regex to line start, and strip a leading delimiter.

describe('roadmap-parser: getMilestoneInfo #2135 — milestone_name clobber', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('case A: 🚧 bullet quoting a nameless ## heading in backticks', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v1.8' });
    writeRoadmap(tmpDir, [
      '# Roadmap',
      '',
      '## Milestones',
      '',
      '- 🚧 **v1.8 user session cleanup** — Phases 36-41 — see `## v1.8 — Active Milestone` below',
      '',
      '## v1.8 — Active Milestone',
      '',
      '### Phase 36: Something',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v1.8');
    assert.strictEqual(info.value.name, 'user session cleanup');
  });

  test('case B: nameless ## heading + 🚧 marker carries the real name', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v1.9' });
    writeRoadmap(tmpDir, [
      '## v1.9 — Active Milestone',
      '',
      '### 🚧 v1.9 — Falsifiability',
      '',
      '### Phase 1: Hypothesis',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v1.9');
    assert.strictEqual(info.value.name, 'Falsifiability');
  });

  test('case C: canonical ## vX.Y: Name (no regression)', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v2.0' });
    writeRoadmap(tmpDir, '## v2.0: The Big Launch\n### Phase 1: Setup\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v2.0');
    assert.strictEqual(info.value.name, 'The Big Launch');
  });

  test('case D: canonical ## vX.Y — Name (em-dash delimiter stripped)', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v2.5' });
    writeRoadmap(tmpDir, '## v2.5 — Galaxy Release\n### Phase 1: Start\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v2.5');
    assert.strictEqual(info.value.name, 'Galaxy Release');
  });

  test('case E: 🚧 bullet only, no ## heading (no regression)', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v1.5' });
    writeRoadmap(tmpDir, 'Some intro text.\n\n- 🚧 **v1.5 Quick Fix** — minor\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.version, 'v1.5');
    assert.strictEqual(info.value.name, 'Quick Fix');
  });

  test('anchored regex never matches a ## heading quoted inside backticks mid-line', () => {
    writeState(tmpDir, { gsd_state_version: '1.0', milestone: 'v3.0' });
    writeRoadmap(tmpDir, [
      '# Roadmap',
      '',
      'See `## v3.0 — Active Milestone` referenced here.',
      '',
      '## v3.0: Real Name',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.name, 'Real Name');
  });
});

// ─── getMilestoneInfo — #4134 punctuation-fragment name refusal ───────────────
// The §7.2 pinned rule takes everything AFTER the heading's own version token
// as the name. For a name-then-version heading (`# Roadmap: Project — Name
// (v1.13)` — the shape a first-ever ROADMAP.md drifts into, since nothing
// templates its H1) that remainder is literally `)`, which the rule used to
// return as a COMPLETE-scope "name". ADR-3180 §7.2 rule 6 is the floor this
// violates: a version known but a name unresolvable is TRUNCATED carrying
// `name: null` — a punctuation-only remainder is heading structure, not a
// curated name (#4134).

describe('roadmap-parser: getMilestoneInfo #4134 — name-then-version heading', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('#4134 — name-then-version H1 never yields a punctuation-fragment name (rule 6: TRUNCATED, name null)', () => {
    writeState(tmpDir, { milestone: 'v1.13' });
    writeRoadmap(tmpDir, [
      '# Roadmap: GSD Core — Native OMP Runtime Support (v1.13)',
      '',
      '### Phase 1: Runtime Adapter Interface',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.TRUNCATED, `scope: ${JSON.stringify(info)}`);
    assert.strictEqual(info.value.version, 'v1.13');
    assert.strictEqual(info.value.name, null);
  });

  test('#4134 — ROADMAP-only fallback path also refuses the ")" fragment', () => {
    // No STATE.md: the first open milestone heading supplies the version.
    writeRoadmap(tmpDir, [
      '# Roadmap: GSD Core — Native OMP Runtime Support (v1.13)',
      '',
      '### Phase 1: Runtime Adapter Interface',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.TRUNCATED, `scope: ${JSON.stringify(info)}`);
    assert.strictEqual(info.value.version, 'v1.13');
    assert.strictEqual(info.value.name, null);
  });

  test('#4134 — the refusal is level-agnostic (H2/H3 carry the same fragment)', () => {
    for (const [level, heading] of [
      [2, '## Native OMP Runtime Support (v1.13)'],
      [3, '### Native OMP Runtime Support (v1.13)'],
    ]) {
      writeState(tmpDir, { milestone: 'v1.13' });
      writeRoadmap(tmpDir, `${heading}\n\n### Phase 1: Setup\n`);
      const info = getMilestoneInfo(tmpDir);
      assert.strictEqual(info.scope, SCOPE.TRUNCATED, `H${level}: ${JSON.stringify(info)}`);
      assert.strictEqual(info.value.version, 'v1.13');
      assert.strictEqual(info.value.name, null);
    }
  });

  test('#4134 — every punctuation-only remainder is refused (garbage family)', () => {
    // Each fragment survives stripLeadingDelimiter (it does not START with a
    // delimiter char) and carries no letter or digit anywhere — the exact
    // shape that used to be returned as a "name".
    const fragments = [')', '()', '**', '.,;:', ']}', '🎉'];
    for (const fragment of fragments) {
      writeState(tmpDir, { milestone: 'v1.2' });
      writeRoadmap(tmpDir, `## v1.2 — ${fragment}\n\n### Phase 1: Setup\n`);
      const info = getMilestoneInfo(tmpDir);
      assert.strictEqual(info.scope, SCOPE.TRUNCATED, `fragment ${JSON.stringify(fragment)}: ${JSON.stringify(info)}`);
      assert.strictEqual(info.value.version, 'v1.2');
      assert.strictEqual(info.value.name, null, `fragment ${JSON.stringify(fragment)} must not become a name`);
    }
  });

  test('#4134 control — version-last without parens was already name:null and stays so', () => {
    writeState(tmpDir, { milestone: 'v1.2.3' });
    writeRoadmap(tmpDir, '# Milestone Name v1.2.3\n\n### Phase 1: Setup\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.value.version, 'v1.2.3');
    assert.strictEqual(info.value.name, null);
    assert.strictEqual(info.scope, SCOPE.TRUNCATED);
  });

  test('#4134 negative space — canonical delimiter forms parse identically', () => {
    const cases = [
      ['## v2.0: The Big Launch', 'The Big Launch'],
      ['## v2.5 — Galaxy Release', 'Galaxy Release'],
      ['## v2.6 – En Dash Form', 'En Dash Form'],
      ['## v2.7 - Hyphen Form', 'Hyphen Form'],
      ['## v2.8 Space Only Form', 'Space Only Form'],
    ];
    for (const [heading, expected] of cases) {
      writeState(tmpDir, { milestone: heading.match(/v\d+(?:\.\d+)*/)[0] });
      writeRoadmap(tmpDir, `${heading}\n\n### Phase 1: Setup\n`);
      const info = getMilestoneInfo(tmpDir);
      assert.strictEqual(info.scope, SCOPE.COMPLETE, `${heading}: ${JSON.stringify(info)}`);
      assert.strictEqual(info.value.name, expected, `${heading}: ${JSON.stringify(info.value)}`);
    }
  });

  test('#4134 negative space — parenthetical names are retained (#3171)', () => {
    writeState(tmpDir, { milestone: 'v1.2' });
    writeRoadmap(tmpDir, '## v1.2 — Name (Part 2)\n\n### Phase 1: Setup\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.name, 'Name (Part 2)');
  });

  test('#4134 negative space — markers, digit-only names, CRLF headings unchanged', () => {
    // Trailing status marker still stripped, not treated as a "name" (a ✅
    // TRAILING marker would make the heading closed and skipped — 📋 does not).
    writeState(tmpDir, { milestone: 'v3.0' });
    writeRoadmap(tmpDir, '## v3.0 — Planned 📋\n\n### Phase 1: Setup\n');
    let info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.name, 'Planned');

    // A digit-only name IS a name (\p{N} counts as a word character).
    writeState(tmpDir, { milestone: 'v4.0' });
    writeRoadmap(tmpDir, '## v4.0 — 42\n\n### Phase 1: Setup\n');
    info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.name, '42');

    // CRLF heading: the trailing \r must never become part of the verdict.
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, '## v2.0 — CRLF Name\r\n\r\n### Phase 1: Setup\r\n');
    info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.scope, SCOPE.COMPLETE);
    assert.strictEqual(info.value.name, 'CRLF Name');
  });

  test('#4134 — property: a word-char remainder is always a name, a punctuation-only remainder never is', () => {
    // Document-shaped generator (#2371): fixed literal token alphabets, NOT
    // derived from the parser's own regexes. Fragments are token lists joined
    // with single spaces, so no token can glue onto the version token and
    // trigger the sub-milestone continuation grammar (`v1.3-B`).
    const WORD = fc.constantFrom('Alpha', 'Beta', 'R2D2', '42', '名称', 'küche');
    const PUNCT = fc.constantFrom(')', '(', '—', ':', '.', '**', ']');
    const minor = fc.integer({ min: 0, max: 9 });
    const tokens = fc.array(fc.oneof(WORD, PUNCT), { minLength: 1, maxLength: 6 });

    const prop = fc.property(minor, tokens, (m, toks) => {
      const version = `v1.${m}`;
      const fragment = toks.join(' ').trim();
      const hasWordChar = /[\p{L}\p{N}]/u.test(fragment);
      const out = roadmapParser.listMilestoneHeadings(`## ${version} ${fragment}\n`);
      assert.strictEqual(out.length, 1, `heading not enumerated: ${version} ${fragment}`);
      assert.strictEqual(out[0].version, version, `continuation grammar leaked into the version: ${JSON.stringify(out[0])}`);
      // The biconditional IS the #4134 contract: a remainder with at least one
      // letter/digit is a curated name; one with none is heading structure.
      assert.strictEqual(
        out[0].name !== null,
        hasWordChar,
        `fragment ${JSON.stringify(fragment)} (hasWordChar=${hasWordChar}) yielded name ${JSON.stringify(out[0].name)}`,
      );
    });

    const result = fc.check(prop, { seed: 20260905, numRuns: 300 });
    if (result.failed) {
      assert.fail(`#4134 property violated (replay seed=20260905): ${JSON.stringify(result.counterexample)}`);
    }
  });
});

// ─── isMilestoneShippedInRoadmap ──────────────────────────────────────────────

// #2562: this module owns milestone-heading classification, so its own shipped
// detection is unit-tested here rather than only through the workstream
// inventory that consumes it.
describe('roadmap-parser: isMilestoneShippedInRoadmap', () => {
  test('a shipped marker on the milestone heading counts', () => {
    assert.strictEqual(isMilestoneShippedInRoadmap('## v2.0 Launch — ✅ SHIPPED\n', 'v2.0'), true);
  });

  test('a collapsed <summary> shipped marker counts', () => {
    const roadmap = '<details><summary>✅ v2.0 Launch — SHIPPED</summary>\n\ncontent\n</details>\n';
    assert.strictEqual(isMilestoneShippedInRoadmap(roadmap, 'v2.0'), true);
  });

  test('a bullet merely naming the version does NOT count', () => {
    assert.strictEqual(isMilestoneShippedInRoadmap('- ✅ v2.0 Launch — SHIPPED\n', 'v2.0'), false);
  });

  test('version tokens are boundary-matched (v2.0.1 is not v2.0)', () => {
    assert.strictEqual(isMilestoneShippedInRoadmap('## v2.0.1 Patch — ✅ SHIPPED\n', 'v2.0'), false);
  });

  test('an in-progress marker on the heading beats a shipped one', () => {
    assert.strictEqual(isMilestoneShippedInRoadmap('## 🚧 v2.0 Launch — ✅ SHIPPED\n', 'v2.0'), false);
  });

  test('another milestone being shipped says nothing about this one', () => {
    assert.strictEqual(isMilestoneShippedInRoadmap('## v1.0 Old — ✅ SHIPPED\n', 'v2.0'), false);
  });
});

// ─── getMilestonePhaseFilter ──────────────────────────────────────────────────

describe('roadmap-parser: getMilestonePhaseFilter', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns passAll (phaseCount=0) when ROADMAP.md missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 0);
    assert.strictEqual(filter('anything'), true);
  });

  // #2562 added a trailing optional `ws` param. Every pre-existing call site in
  // the codebase passes 1–3 args, so what has to hold is that omitting the 4th
  // is INDISTINGUISHABLE from the prior resolution — including its
  // `GSD_WORKSTREAM` env fallback. Characterises the legacy call surface
  // directly; it does not stand in for coverage of the individual callers.
  test('#2562: omitting the ws param preserves the prior path resolution exactly', () => {
    const ROADMAP = ['## v1.0: Launch', '### Phase 1: Setup', '**Goal:** setup'].join('\n');
    writeRoadmap(tmpDir, ROADMAP);

    const omitted = getMilestonePhaseFilter(tmpDir);
    const explicitUndefined = getMilestonePhaseFilter(tmpDir, undefined, undefined, undefined);
    const explicitNull = getMilestonePhaseFilter(tmpDir, null, null, null);

    for (const [label, filter] of [['omitted', omitted], ['undefined', explicitUndefined], ['null', explicitNull]]) {
      assert.strictEqual(filter.phaseCount, 1, `${label}: same phase count`);
      assert.strictEqual(filter('01-setup'), true, `${label}: same membership`);
      assert.strictEqual(filter('02-other'), false, `${label}: same exclusion`);
      assert.strictEqual(typeof filter.versionScoped, 'boolean', `${label}: new flag is present, not undefined`);
    }
  });

  test('#2562: the GSD_WORKSTREAM env fallback still resolves when ws is omitted', () => {
    const wsRoadmap = ['## v1.0: WS', '### Phase 7: Only', '**Goal:** only'].join('\n');
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), wsRoadmap);
    writeRoadmap(tmpDir, ['## v1.0: Root', '### Phase 1: Setup', '**Goal:** setup'].join('\n'));

    const previous = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'alpha';
    try {
      const filter = getMilestonePhaseFilter(tmpDir);
      assert.strictEqual(filter('07-only'), true, 'env fallback must still reach the workstream roadmap');
      assert.strictEqual(filter('01-setup'), false, 'and must not read the root roadmap');
    } finally {
      if (previous === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = previous;
    }
  });

  test('basic milestone phase filter — matches dirs by phase number', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Launch',
      '### Phase 1: Setup',
      '**Goal:** setup',
      '',
      '### Phase 2: Build',
      '**Goal:** build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 2);
    assert.strictEqual(filter('01-setup'), true, '01-setup matches Phase 1');
    assert.strictEqual(filter('02-build'), true, '02-build matches Phase 2');
    assert.strictEqual(filter('03-deploy'), false, '03-deploy not in milestone');
  });

  test('milestone-prefixed phase IDs (e.g. 2-01)', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Current',
      '### Phase 2-01: Alpha',
      '### Phase 2-02: Beta',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('02-01-alpha'), true, '02-01 matches Phase 2-01');
    assert.strictEqual(filter('02-02-beta'), true, '02-02 matches Phase 2-02');
    assert.strictEqual(filter('02-03-other'), false, '02-03 not in milestone');
  });

  test('single-digit slug word after a phase number is not wrongly excluded (#2043)', () => {
    // The roadmap uses milestone-prefixed hyphenated phase IDs (e.g. "2-01"),
    // which switches getMilestonePhaseFilter's dir-matching regex into
    // hyphenated mode. Phase 46's roadmap name "6 Rs Pipeline Orchestrator"
    // slugifies to a dir starting with a single-digit word ("46-6-rs-…").
    // Before #2043, the hyphenated-mode regex over-collected that single
    // digit into the phase token ("46-6"), which never matched the roadmap's
    // "46" phase number, so the dir was wrongly excluded from the milestone.
    writeState(tmpDir, { milestone: 'v1.0' });
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** first alpha phase',
      '',
      '### Phase 46: 6 Rs Pipeline Orchestrator',
      '**Goal:** orchestrate the rs',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filter('46-6-rs-pipeline-orchestrator'),
      true,
      '46-6-rs-pipeline-orchestrator (phase 46, single-digit slug word "6") must match Phase 46',
    );
    // Legit milestone-prefixed dir still matches as before.
    assert.strictEqual(filter('02-01-alpha'), true, '02-01-alpha matches Phase 2-01');
  });

  test('year-leading slug word after a phase number is not wrongly excluded (#2232)', () => {
    // Same hyphenated-mode collision as #2043 but with a ≥3-digit slug word:
    // phase 14's roadmap name "2026 Photos & Performance" slugifies to a dir
    // starting with a year ("14-2026-photos-…"). The ≥2-digit continuation
    // gate over-collected the year into the phase token ("14-2026"), which
    // never matched the roadmap's "14", so the dir was wrongly excluded.
    writeState(tmpDir, { milestone: 'v1.0' });
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** first alpha phase',
      '',
      '### Phase 14: 2026 Photos & Performance',
      '**Goal:** ship the photos and performance work',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filter('14-2026-photos-performance'),
      true,
      '14-2026-photos-performance (phase 14, year-leading slug) must match Phase 14',
    );
    // Legit milestone-prefixed dir still matches as before.
    assert.strictEqual(filter('02-01-alpha'), true, '02-01-alpha matches Phase 2-01');
  });

  test('versionOverride uses specified version slice', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Old',
      '### Phase 1: Old Phase',
      '',
      '## v2.0: Current',
      '### Phase 2: New Phase',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir, 'v2.0');
    assert.strictEqual(filter('02-new-phase'), true, 'phase 2 in v2.0 slice');
    assert.strictEqual(filter('01-old-phase'), false, 'phase 1 not in v2.0 slice');
  });

  test('missingExplicitVersion set when version not found in versioned roadmap', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Only Milestone',
      '### Phase 1: Foo',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir, 'v9.9');
    assert.strictEqual(filter.missingExplicitVersion, true, 'missingExplicitVersion should be true');
    assert.strictEqual(filter.phaseCount, 0);
  });

  test('zero-padded phase IDs match unpadded dirs and vice versa', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Padded Test',
      '### Phase 01: Setup',
      '### Phase 02: Build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('1-setup'), true, 'unpadded dir matches padded Phase 01');
    assert.strictEqual(filter('02-build'), true, 'padded dir matches padded Phase 02');
  });

  test('decimal phase IDs in ROADMAP filter correctly', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Decimal Test',
      '### Phase 1.5: Interstitial',
      '### Phase 2: Normal',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.ok(filter.phaseCount >= 1, 'at least one phase found');
    // Decimal phase IDs are non-numeric so filter should handle them
    assert.strictEqual(filter('1.5-interstitial'), true, 'decimal phase dir matches');
  });

  test('repeated phase IDs — deduplication (no double count)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Repeated',
      '### Phase 1: First',
      '### Phase 1: Duplicate heading',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase 1 appears twice but should only count once
    assert.strictEqual(filter.phaseCount, 1, 'deduplication: only 1 unique phase');
  });

  test('adversarial: phase heading inside backtick fence is excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Real',
      '```',
      '### Phase 999: Fake Phase Inside Fence',
      '```',
      '### Phase 1: Real Phase',
      '**Goal:** real',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase headings inside fenced code blocks must NOT be counted as real phases.
    // getMilestonePhaseFilter is fence-aware (fix #875).
    assert.strictEqual(filter('01-real'), true, 'real phase matches');
    assert.strictEqual(filter('999-fake'), false, 'fenced phase heading is correctly excluded');
  });

  test('adversarial: unclosed fence block — does not crash', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Unclosed',
      '```',
      '### Phase 1: Inside unclosed fence',
      '**Goal:** unreachable',
      // Intentionally no closing ``` — adversarial fixture
    ].join('\n'));

    // Should not throw regardless of fence parsing behavior
    let filter;
    assert.doesNotThrow(() => {
      filter = getMilestonePhaseFilter(tmpDir);
    }, 'unclosed fence should not throw');
    assert.ok(typeof filter === 'function', 'filter is a function');
  });

  test('adversarial: phase heading inside tilde fence is excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Tilde',
      '~~~',
      '### Phase 999: Fake',
      '~~~',
      '### Phase 1: Real',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase headings inside tilde-fenced code blocks must NOT be counted as real phases.
    // getMilestonePhaseFilter is fence-aware (fix #875).
    assert.strictEqual(filter('01-real'), true, 'real phase matches despite tilde fence');
    assert.strictEqual(filter('999-fake'), false, 'tilde-fenced phase heading is correctly excluded');
  });

  test('adversarial: phase heading inside fence is excluded with CRLF endings (fix #875)', () => {
    const crlf = '## v1.0: CRLF Fence\r\n```\r\n### Phase 999: Fake\r\n```\r\n### Phase 1: Real\r\n';
    writeRoadmap(tmpDir, crlf);
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-real'), true, 'real phase matches in CRLF file');
    assert.strictEqual(filter('999-fake'), false, 'fenced phase excluded in CRLF file');
  });

  test('adversarial: phase headings in back-to-back fences are excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Adjacent',
      '```',
      '### Phase 998: Fake A',
      '```',
      '```',
      '### Phase 999: Fake B',
      '```',
      '### Phase 1: Real',
    ].join('\n'));
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-real'), true, 'real phase matches');
    assert.strictEqual(filter('998-fake'), false, 'first fenced phase excluded');
    assert.strictEqual(filter('999-fake'), false, 'second fenced phase excluded');
  });

  test('adversarial: CRLF line endings in roadmap', () => {
    const crlf = '## v1.0: CRLF\r\n### Phase 1: Setup\r\n### Phase 2: Build\r\n';
    writeRoadmap(tmpDir, crlf);
    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.ok(filter.phaseCount >= 1, 'phases found despite CRLF');
  });

  test('adversarial: mixed CRLF and LF in same file', () => {
    const mixed = '## v1.0: Mixed\r\n### Phase 1: A\n### Phase 2: B\r\n### Phase 3: C\n';
    writeRoadmap(tmpDir, mixed);
    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.ok(filter.phaseCount >= 1, 'phases found in mixed CRLF/LF');
  });

  test('adversarial: unicode headings', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    writeRoadmap(tmpDir, [
      '## v1.0: 日本語マイルストーン',
      '### Phase 1: Héros Réalité',
      '### Phase 2: Тест',
    ].join('\n'));

    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.strictEqual(filter.phaseCount, 2, '2 unicode phases found');
    assert.strictEqual(filter('01-setup'), true, 'phase 1 dir matches');
  });

  test('adversarial: bracket-prefixed phase heading ### [GSD] Phase 2-01:', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Bracket',
      '### [GSD] Phase 2-01: Setup',
      '### [GSD] Phase 2-02: Build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('02-01-setup'), true, 'bracket-prefixed phase 2-01 matched');
    assert.strictEqual(filter('02-02-build'), true, 'bracket-prefixed phase 2-02 matched');
  });

  // #3213: the custom-ID branch used a greedy capture
  // `^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)` that swallowed the whole
  // hyphenated directory name (A-tool-output-contract → captured
  // "A-tool-output-contract", not "A"). Every letter-named phase directory
  // (GSD's own Phase A:..Phase L: convention; ADR-612 first-class non-numeric
  // IDs) was silently excluded and milestone counts were fabricated over
  // whatever numeric dir survived. The fix is a segment-boundary membership
  // test: a dir belongs if it equals a declared phase ID or begins with id + "-".
  test('#3213: letter-named phase dir is included in the milestone', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Letters',
      '### Phase A: Tool Output Contract',
      '**Goal:** contract',
      '',
      '### Phase 01: Inventory',
      '**Goal:** inventory',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 2, 'Phase A + Phase 01 declared');
    assert.strictEqual(filter('A-tool-output-contract'), true, 'letter phase A dir must be in-milestone (#3213)');
    assert.strictEqual(filter('01-inventory'), true, 'numeric phase 01 dir still matches');
    assert.strictEqual(filter('B-evidence-artifact-contract'), false, 'undeclared letter phase B stays excluded');
  });

  test('#3213: letter-named phases A..L all count (not just the numeric dir)', () => {
    const headings = ['## v1.0: Alpha', '### Phase 00: Inventory', '**Goal:** inv', ''];
    for (const letter of ['A','B','C','D','E','F','G','H','I','J','K','L']) {
      headings.push(`### Phase ${letter}: Phase ${letter}`, '**Goal:** g', '');
    }
    writeRoadmap(tmpDir, headings.join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 13, 'Phase 00 + A..L = 13 phases');
    assert.strictEqual(filter('00-inventory-approval-gate'), true, '00 in-milestone');
    const dirFor = {
      A: 'A-tool-output-contract',
      B: 'B-evidence-artifact-contract',
      C: 'C-attention-triage',
      L: 'L-framework-distribution',
    };
    for (const [letter, dir] of Object.entries(dirFor)) {
      assert.strictEqual(filter(dir), true, `letter phase ${letter} dir "${dir}" must be in-milestone (#3213)`);
    }
    assert.strictEqual(filter('M-not-declared'), false, 'undeclared letter M stays excluded');
  });
});

// ─── withPhaseSection (ADR-2143 §4 — bounded mutation) ────────────────────────

describe('roadmap-parser: withPhaseSection', () => {
  test('mutating phase k leaves phase j (j≠k) byte-identical', () => {
    const content = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '**Goal:** Setup',
      '**Plans:** 1 plans',
      '',
      '### Phase 2: API',
      '**Goal:** Build API',
      '**Plans:** 1 plans',
      '',
      '### Phase 3: Polish',
      '**Goal:** Harden',
      '**Plans:** 1 plans',
      '',
    ].join('\n');

    const result = withPhaseSection(content, '2', (body) =>
      body.replace(/(\*\*Plans:\*\*\s*)[^\n]+/i, '$11/1 plans complete'),
    );

    assert.ok(
      result.includes('### Phase 2: API\n**Goal:** Build API\n**Plans:** 1/1 plans complete'),
      'phase 2 (the target) is updated',
    );
    assert.ok(
      result.includes('### Phase 1: Foundation\n**Goal:** Setup\n**Plans:** 1 plans'),
      'phase 1 (j≠k) is byte-identical',
    );
    assert.ok(
      result.includes('### Phase 3: Polish\n**Goal:** Harden\n**Plans:** 1 plans'),
      'phase 3 (j≠k) is byte-identical',
    );
  });

  test('a greedy edit callback cannot escape phase N\'s own section', () => {
    const content = [
      '### Phase 1: Alpha',
      'alpha body',
      '### Phase 2: Beta',
      'beta body',
      '### Phase 3: Gamma',
      'gamma body',
    ].join('\n') + '\n';

    const result = withPhaseSection(content, '2', (body) => body.replace(/[\s\S]*/, 'REPLACED'));
    assert.ok(result.includes('### Phase 1: Alpha\nalpha body'), 'Phase 1 untouched by a greedy regex targeting Phase 2');
    assert.ok(result.includes('### Phase 3: Gamma\ngamma body'), 'Phase 3 untouched by a greedy regex targeting Phase 2');
    assert.ok(result.includes('### Phase 2: Beta\nREPLACED'), 'Phase 2 was the intended target');
  });

  test('no matching phase heading -> content unchanged (bounded no-op)', () => {
    const content = '### Phase 1: Foundation\n**Plans:** 1 plans\n';
    const result = withPhaseSection(content, '99', (body) => body + ' MUTATED');
    assert.equal(result, content, 'no Phase 99 heading -> unchanged');
  });

  test('resolves the phase heading via the #2121 phase-id source (zero-padding tolerant)', () => {
    const content = [
      '### Phase 02: Padded',
      '**Plans:** 1 plans',
      '### Phase 3: Next',
      '**Plans:** 1 plans',
    ].join('\n') + '\n';

    // Query with the un-padded form ("2") — must still resolve "Phase 02".
    const result = withPhaseSection(content, '2', (body) => body.replace('1 plans', '1/1 plans complete'));
    assert.ok(result.includes('### Phase 02: Padded\n**Plans:** 1/1 plans complete'), 'un-padded query resolves padded heading');
    assert.ok(result.includes('### Phase 3: Next\n**Plans:** 1 plans'), 'Phase 3 untouched');
  });

  test('a query for phase "1" does not prefix-match a decimal sub-phase heading "Phase 1.1"', () => {
    // Sub-phase appears BEFORE the parent phase in the document, so a bare
    // `\b`-terminated regex (which would match "1" as a prefix of "1.1")
    // could resolve the wrong (first-encountered) section.
    const content = [
      '### Phase 1.1: Sub',
      'sub body',
      '### Phase 1: Base',
      'base body',
    ].join('\n') + '\n';

    const result = withPhaseSection(content, '1', (body) => body + ' EDITED');
    assert.ok(result.includes('### Phase 1.1: Sub\nsub body\n'), 'Phase 1.1 body is byte-identical (untouched)');
    assert.ok(!result.includes('sub body EDITED'), 'the edit did not land in Phase 1.1');
    assert.ok(result.includes('### Phase 1: Base\nbase body EDITED'), "Phase 1's own body received the edit");

    const subResult = withPhaseSection(content, '1.1', (body) => body + ' EDITED');
    assert.ok(subResult.includes('### Phase 1.1: Sub\nsub body EDITED'), "Phase 1.1's own body received the edit");
    assert.ok(subResult.includes('### Phase 1: Base\nbase body\n'), 'Phase 1 body is byte-identical (untouched)');
  });

  test('Blocker 1 regression: a query for phase "1" is not hijacked by a sibling phase whose TITLE mentions "Phase 1"', () => {
    // Phase 3's own title mentions "Phase 1" ("Migrate off Phase 1 pipeline")
    // and appears BEFORE the real Phase 1 heading in document order. Under the
    // OLD unanchored regex (`(?:^|\s)Phase\s+1(?=[\s:(]|$)`), that substring
    // inside Phase 3's heading text would match first — and because
    // `collectSection` picks the FIRST matching heading, `withPhaseSection`
    // would edit Phase 3's section instead of Phase 1's.
    const content = [
      '### Phase 3: Migrate off Phase 1 pipeline',
      '**Plans:** 1 plans',
      '### Phase 1: Foundation',
      '**Plans:** 1 plans',
    ].join('\n') + '\n';

    const result = withPhaseSection(content, '1', (body) =>
      body.replace(/(\*\*Plans:\*\*\s*)[^\n]+/, '$1DONE'),
    );

    assert.ok(
      result.includes('### Phase 1: Foundation\n**Plans:** DONE'),
      "Phase 1's own Plans line is edited",
    );
    assert.ok(
      result.includes('### Phase 3: Migrate off Phase 1 pipeline\n**Plans:** 1 plans'),
      'Phase 3 (title mentions "Phase 1") is byte-identical — not hijacked',
    );
  });

  test('Blocker 2 regression: a following DEEPER heading is not folded into phase 1\'s section body', () => {
    // Phase 1 is `###` (level 3); the very next heading, `#### Phase 2: API`
    // (level 4), is DEEPER than Phase 1. Under the default `levelBounded: true`
    // stop rule, a deeper heading does not terminate the section (it only stops
    // at a heading whose level <= the target's own level), so Phase 2's whole
    // section — including its `**Plans:**` line — would be folded into Phase
    // 1's body and reachable by `edit`.
    const content = [
      '### Phase 1: Foundation',
      '#### Phase 2: API',
      '**Plans:** 1 plans',
      '### Phase 3: Polish',
      '**Plans:** 1 plans',
    ].join('\n') + '\n';

    const phase2Snippet = '#### Phase 2: API\n**Plans:** 1 plans';
    assert.ok(content.includes(phase2Snippet), 'sanity: fixture contains the expected Phase 2 snippet');

    const result = withPhaseSection(content, '1', (body) => `${body}[EDITED]`);

    assert.ok(
      result.includes(phase2Snippet),
      "Phase 2's heading + Plans line stay contiguous and byte-identical — Phase 1's edit did not reach into it",
    );
    assert.ok(!result.includes('1 plans[EDITED]'), "the edit did not land inside Phase 2's Plans line");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2554-decimal-phase-filter.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2554-decimal-phase-filter (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2554:
 * state disk-scan excludes decimal phase dirs (e.g. "00.1") from progress counts.
 *
 * Root cause: getMilestonePhaseFilter normalized phase IDs with `replace(/^0+/, '')`,
 * which over-strips on decimals: "00.1" → ".1", while the disk-side extractor
 * applied to "00.1-<slug>" yields "0.1" — so the dir is excluded from the milestone.
 *
 * Fix: strip leading zeros only when followed by a digit (`replace(/^0+(?=\d)/, '')`),
 * preserving the zero before the decimal point.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { getMilestonePhaseFilter } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

describe('bug #2554 — getMilestonePhaseFilter decimal phase dirs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('matches decimal phase directory like "00.1-<slug>" against ROADMAP phase "00.1"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v1.0: Current',
        '',
        '### Phase 0: Foundation',
        '**Goal:** foundation',
        '',
        '### Phase 00.1: Inserted urgent work',
        '**Goal:** inserted',
        '',
        '### Phase 1: Feature',
        '**Goal:** feature',
      ].join('\n')
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    // Phase 00.1 inserted between Phase 0 and Phase 1 must match its on-disk dir.
    assert.strictEqual(
      filter('00.1-app-namespace-rename'),
      true,
      'decimal phase dir "00.1-<slug>" must be counted in the milestone'
    );

    // Neighbours should still match (no regression).
    assert.strictEqual(filter('0-foundation'), true);
    assert.strictEqual(filter('1-feature'), true);
  });

  test('preserves existing behavior for zero-padded integer phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v1.0: Current',
        '',
        '### Phase 01: One',
        '**Goal:** g',
        '',
        '### Phase 10: Ten',
        '**Goal:** g',
      ].join('\n')
    );

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-one'), true);
    assert.strictEqual(filter('10-ten'), true);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-730-milestone-phase-details-scope.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-730-milestone-phase-details-scope (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #730: phase details defined under a milestone-scoped
 * "## Milestone vX.Y — … (Phase Details)" section are invisible to phase
 * resolution (getRoadmapPhaseInternal / init phase-op) when the flat shared
 * "## Phase Details" section for an earlier milestone sits between the shared
 * ## Phases checklist and the per-milestone Phase Details section.
 *
 * The bug manifests ONLY before any .planning/phases/ directory exists because
 * findPhaseInternal masks it once the dir is created. RED step — tests 1 and 3
 * are expected to fail against current code.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup, absPlanningPath } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Shared fixture content
// ---------------------------------------------------------------------------

const STATE_CONTENT = `---
milestone: v1.1
---
`;

const ROADMAP_CONTENT = `# Roadmap: Example

## Phases

- [x] **Phase 1: Setup** — initial scaffold

### Milestone v1.1 — Second milestone (added 2026-01-01)

- [ ] **Phase 2: Feature** — the new thing

## Phase Details

### Phase 1: Setup
**Goal:** scaffold the app.

## Milestone v1.1 — Second milestone (Phase Details)

### Phase 2: Feature
**Goal:** build the new thing.
`;

// ---------------------------------------------------------------------------
// Helper: create a bare project with .planning/ but NO .planning/phases/ dir
// ---------------------------------------------------------------------------

function createBareProject() {
  // #2376 macOS fix: realpath the fixture root so absolute path-field
  // assertions (absPlanningPath comparisons below) match the code's
  // process.cwd()-anchored output — macOS's tmpdir is a symlink
  // (/var/... -> /private/var/...) that a spawned child resolves via
  // realpath but a bare mkdtempSync() does not. No-op on Linux (no symlink).
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-')));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('bug #730 — milestone (Phase Details) section scope resolution', () => {
  let dir;

  beforeEach(() => {
    dir = createBareProject();
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE_CONTENT, 'utf-8');
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), ROADMAP_CONTENT, 'utf-8');
  });

  afterEach(() => {
    cleanup(dir);
  });

  // -------------------------------------------------------------------------
  // Test 1 (AC1): init phase-op resolves phase defined only under its
  // per-milestone "(Phase Details)" section
  // -------------------------------------------------------------------------
  test('init phase-op resolves a current-milestone phase defined only under its (Phase Details) section', () => {
    const r = runGsdTools('init phase-op 2', dir);
    assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, expected_phase_dir=${out.expected_phase_dir}`);
    assert.strictEqual(out.phase_name, 'Feature', `phase_name should be 'Feature'; got '${out.phase_name}'`);
    assert.strictEqual(out.padded_phase, '02', `padded_phase should be '02'; got '${out.padded_phase}'`);
    assert.strictEqual(out.expected_phase_dir, absPlanningPath(dir, 'phases', '02-feature'), `expected_phase_dir should be '${absPlanningPath(dir, 'phases', '02-feature')}'; got '${out.expected_phase_dir}'`);
  });

  // -------------------------------------------------------------------------
  // Test 2 (AC4): first-milestone phase still resolves via the flat
  // "## Phase Details" section — no regression
  // -------------------------------------------------------------------------
  test('init phase-op still resolves a first-milestone phase (no regression on flat Phase Details)', () => {
    const r = runGsdTools('init phase-op 1', dir);
    assert.ok(r.success, `init phase-op 1 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true for phase 1; got ${out.phase_found}`);
    assert.strictEqual(out.phase_name, 'Setup', `phase_name should be 'Setup'; got '${out.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 3 (AC5): getRoadmapPhaseInternal resolves the current-milestone phase
  // directly before any phases/ dir exists
  // -------------------------------------------------------------------------
  test('getRoadmapPhaseInternal resolves the current-milestone phase directly before any dir exists', () => {
    const { getRoadmapPhaseInternal } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

    const res = getRoadmapPhaseInternal(dir, '2');
    assert.ok(res !== null && res !== undefined, `getRoadmapPhaseInternal returned null/undefined for phase 2`);
    assert.strictEqual(res.found, true, `res.found should be true; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.phase_name, 'Feature', `res.phase_name should be 'Feature'; got '${res.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 4 (AC3): validate health raises W006 for a current-milestone phase
  // defined under (Phase Details) with no directory on disk.
  //
  // Before the fix, extractCurrentMilestone's slice stopped before the
  // "## Milestone v1.1 — … (Phase Details)" section, so phase 2's
  // "### Phase 2: Feature" header was invisible and W006 was never raised.
  // After the fix the slice includes that section and W006 is emitted.
  //
  // This test uses its OWN local fixture (separate tmpdir) so it does not
  // disturb the shared beforeEach/afterEach fixture used by tests 1–3.
  // -------------------------------------------------------------------------
  test('validate health raises W006 for a started current-milestone phase defined under (Phase Details) with no directory', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t4-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v1.1
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.1\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — phase 2 is [x] (started/complete) so the not-started
      // guard does NOT suppress W006.  Phase 2's details live exclusively in
      // the per-milestone "(Phase Details)" section (the blind-spot pre-fix).
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — initial scaffold\n\n### Milestone v1.1 — Second milestone (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — the new thing\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold the app.\n\n## Milestone v1.1 — Second milestone (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build the new thing.\n`,
        'utf-8',
      );

      // Create the phase 1 directory so phase 1 does NOT trigger W006.
      // Phase 2 has NO directory — that's the missing-dir condition under test.
      fs.mkdirSync(path.join(planning, 'phases', '01-setup'), { recursive: true });

      const result = runGsdTools(['validate', 'health'], localDir);
      const payload = JSON.parse(result.output);
      const warnings = payload.warnings || [];

      // Find a W006 entry whose message references phase 2 (by number or name).
      const w006ForPhase2 = warnings.find(
        (w) =>
          w.code === 'W006' &&
          (/\b2\b/.test(w.message) || /\b02\b/.test(w.message) || /Feature/i.test(w.message)),
      );

      assert.ok(
        w006ForPhase2 != null,
        `Expected a W006 warning referencing phase 2 (Feature) — phase 2 is started ([x]) and has no directory on disk, ` +
          `but its ### Phase 2: header lives in the Milestone v1.1 (Phase Details) section which was invisible before the fix. ` +
          `Got warnings: ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: three-milestone roadmap, current = latest (v1.2)
  // -------------------------------------------------------------------------
  test('init phase-op resolves the latest milestone phase in a 3-milestone roadmap', () => {
    // #2376 macOS fix: see createBareProject() above.
    const localDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t5-')));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.2\n---\n`,
        'utf-8',
      );

      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — done\n\n### Milestone v1.1 — Second (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — done\n\n### Milestone v1.2 — Third (added 2026-02-01)\n\n- [ ] **Phase 3: Polish** — current\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold.\n\n## Milestone v1.1 — Second (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build.\n\n## Milestone v1.2 — Third (Phase Details)\n\n### Phase 3: Polish\n**Goal:** refine.\n`,
        'utf-8',
      );

      const r = runGsdTools('init phase-op 3', localDir);
      assert.ok(r.success, `init phase-op 3 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}`);
      assert.strictEqual(out.phase_name, 'Polish', `phase_name should be 'Polish'; got '${out.phase_name}'`);
      assert.strictEqual(out.padded_phase, '03', `padded_phase should be '03'; got '${out.padded_phase}'`);
      assert.strictEqual(out.expected_phase_dir, absPlanningPath(localDir, 'phases', '03-polish'), `expected_phase_dir should be '${absPlanningPath(localDir, 'phases', '03-polish')}'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: sub-milestone sharing a version prefix — closed sibling must NOT
  // cross-pollinate into the active milestone's Phase Details lookup (#730)
  // -------------------------------------------------------------------------
  test('init phase-op anchors Phase Details to the selected sub-milestone, not a closed same-prefix sibling', () => {
    // #2376 macOS fix: see createBareProject() above.
    const localDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t6-')));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v3.0 (matches v3.0-B active slice)
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v3.0\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — v3.0-A is SHIPPED (closed), v3.0-B is active.
      // The Phase Details for v3.0-A comes FIRST — without version-boundary
      // anchoring the old code would grab it (first non-closed (Phase Details)
      // heading outside the window), returning phase_name='Alpha' instead of 'Beta'.
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        [
          '# Roadmap: Example',
          '',
          '## Phases',
          '',
          '### Milestone v3.0-A — First slice (added 2026-01-01) ✅ SHIPPED',
          '',
          '- [x] **Phase 1: Alpha** — done',
          '',
          '### Milestone v3.0-B — Second slice (added 2026-02-01)',
          '',
          '- [ ] **Phase 2: Beta** — current',
          '',
          '## Phase Details',
          '',
          '## Milestone v3.0-A — First slice (Phase Details)',
          '',
          '### Phase 1: Alpha',
          '**Goal:** alpha goal.',
          '',
          '## Milestone v3.0-B — Second slice (Phase Details)',
          '',
          '### Phase 2: Beta',
          '**Goal:** beta goal.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const r = runGsdTools('init phase-op 2', localDir);
      assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, output=${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_name, 'Beta', `phase_name should be 'Beta' (v3.0-B section), not '${out.phase_name}' (would indicate v3.0-A cross-pollination)`);
      assert.strictEqual(out.expected_phase_dir, absPlanningPath(localDir, 'phases', '02-beta'), `expected_phase_dir should be '${absPlanningPath(localDir, 'phases', '02-beta')}'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3128-roadmap-plan-count-slug-layout.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3128-roadmap-plan-count-slug-layout (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// allow-test-rule: structural-regression-guard (see #3128)
// Reads roadmap.cjs source to verify isPlanFile pattern was adopted —
// structural contract prevents silent regression to the old filter.

// Regression guard for bug #3128.
//
// roadmap.cjs countPhasePlansAndSummaries() used to filter plan files with:
//   f.endsWith('-PLAN.md') || f === 'PLAN.md'
// This misses the {N}-PLAN-{NN}-{slug}.md layout that gsd-plan-phase
// actually writes (e.g. 5-PLAN-01-setup-database.md), ending in -database.md.
// Result: init manager returned plan_count=0 and disk_status='discussed' for
// fully-planned phases, triggering unnecessary background planner agents.
//
// Root cause: same regex flaw as #2893 (fixed in phase.cjs via #2896), but
// the manager-dashboard path in roadmap.cjs was not updated alongside it.
//
// Fix: apply the same looksLikePlanFile logic from phase.cjs to roadmap.cjs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
// Require the module under test directly
const planScanLib = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'plan-scan.cjs');

// We test countPhasePlansAndSummaries indirectly via getManagerInfo since
// it is not exported. We build a real phaseDir on disk and call the full
// roadmap.cjs init manager path via its exported helper, or fall back to
// direct filesystem inspection of what the filter would produce.
// The simplest correct seam: inspect the source for the regex pattern and
// validate with a synthetic directory that the manager path returns correct counts.


// Import countPhasePlansAndSummaries by monkey-patching: we inline the
// fixed filter logic and verify it matches the file on disk.
// Since the function is module-private, we validate via its public caller
// by using the exported analyzeRoadmap / getPhaseInfo path with a
// synthetic .planning/ directory tree.

describe('bug #3128: roadmap.cjs plan-count for {N}-PLAN-{NN}-{slug}.md layout', () => {

  test('isPlanFile rejects PLAN-OUTLINE and pre-bounce derivatives', () => {
    // Inlined from fix — mirrors the exact logic in the fix
    const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
    const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
    const isPlanFile = (f) =>
      (f.endsWith('-PLAN.md') || f === 'PLAN.md') ||
      (/\.md$/i.test(f) && /PLAN/i.test(f) && !PLAN_OUTLINE_RE.test(f) && !PLAN_PRE_BOUNCE_RE.test(f));

    // canonical forms — must match
    assert.ok(isPlanFile('PLAN.md'),              'PLAN.md must match');
    assert.ok(isPlanFile('5-PLAN.md'),            '5-PLAN.md must match');
    assert.ok(isPlanFile('05-PLAN.md'),           '05-PLAN.md must match');

    // slug form — was the bug; must now match
    assert.ok(isPlanFile('5-PLAN-01-setup.md'),          '5-PLAN-01-setup.md must match');
    assert.ok(isPlanFile('05-PLAN-02-database.md'),       '05-PLAN-02-database.md must match');
    assert.ok(isPlanFile('5-PLAN-DELTA-2026-05-05.md'),  '5-PLAN-DELTA-2026-05-05.md must match');

    // derivative files — must NOT match
    assert.ok(!isPlanFile('5-PLAN-OUTLINE.md'),             'PLAN-OUTLINE must not match');
    assert.ok(!isPlanFile('5-PLAN-01.pre-bounce.md'),       'pre-bounce must not match');
    assert.ok(!isPlanFile('CONTEXT.md'),                    'CONTEXT.md must not match');
    assert.ok(!isPlanFile('SUMMARY.md'),                    'SUMMARY.md must not match');
    assert.ok(!isPlanFile('5-RESEARCH.md'),                 'RESEARCH.md must not match');
  });

  test('roadmap.cjs source uses the extended isPlanFile filter', (t) => {
    // roadmap.cjs's countPhasePlansAndSummaries (module-private) delegates its
    // plan counting to plan-scan.cjs's scanPhasePlans/isRootPlanFile -- exercise
    // the REAL exported module directly instead of grepping roadmap.cjs's source
    // text for the delegation.
    const planScan = require(planScanLib);

    // isRootPlanFile must recognize the {N}-PLAN-{NN}-{slug}.md layout (#3128)
    // that the old inline `f.endsWith('-PLAN.md') || f === 'PLAN.md'` filter missed.
    assert.ok(
      planScan.isRootPlanFile('5-PLAN-01-setup-database.md'),
      'isRootPlanFile must recognize the slug-form plan filename from bug #3128',
    );

    // Exercise scanPhasePlans against a synthetic phase directory containing
    // only a slug-form plan file -- this is the SAME production function
    // roadmap.cjs's countPhasePlansAndSummaries calls, so a correct count here
    // proves the extended filter is what actually runs, not a copy of it.
    const tmpDir = createTempDir('roadmap-plan-scan-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '5-PLAN-01-setup-database.md'), '# plan\n');
    const scanResult = planScan(tmpDir);
    assert.equal(scanResult.planCount, 1, 'scanPhasePlans must count the slug-form plan file');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-500-planned-phase-progress-corruption.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-500-planned-phase-progress-corruption (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #500: `state planned-phase` corrupts STATE.md milestone progress.* counters.
 *
 * Two independent defects:
 *
 * RC1 — plan-phase resyncs progress it should not touch.
 *   cmdStatePlannedPhase wrote via writeStateMd, which unconditionally runs
 *   syncStateFrontmatter and rebuilds progress.* from a half-planned disk
 *   snapshot, trampling curated counters. It must route through
 *   readModifyWriteStateMd(..., { resync: false }) like other body-only writes.
 *
 * RC2 — isRootPlanFile double-counts legacy `<N>-PLAN-<NN>-SUMMARY.md` as a plan.
 *   The final `/PLAN/i` fallback matches the substring "PLAN" inside a legacy
 *   summary name, so a 4-plan/4-summary phase scans as planCount:8 / completed:false
 *   instead of planCount:4 / completed:true. A summary is never a plan.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const { isRootPlanFile, scanPhasePlans } = planScan;

describe('isRootPlanFile does not count legacy summaries as plans (#500 RC2)', () => {
  test('legacy <N>-PLAN-<NN>-SUMMARY.md is not a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01-SUMMARY.md'), false);
  });

  test('legacy <N>-PLAN-<NN>.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01.md'), true);
  });

  test('canonical -PLAN.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('01-PLAN.md'), true);
  });

  test('a 4-plan / 4-summary legacy phase scans as planCount:4 completed:true', () => {
    const tmp = createTempProject();
    const phaseDir = path.join(tmp, '.planning', 'phases', '14-legacy');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const nn = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}.md`), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}-SUMMARY.md`), '# Summary\n', 'utf-8');
    }
    try {
      const scan = scanPhasePlans(phaseDir);
      assert.equal(scan.planCount, 4, `expected 4 plans, got ${scan.planCount}`);
      assert.equal(scan.summaryCount, 4, `expected 4 summaries, got ${scan.summaryCount}`);
      assert.equal(scan.completed, true, 'a fully-summarized phase must scan as completed');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('state planned-phase preserves curated milestone progress.* (#500 RC1)', () => {
  let tmpDir;

  // Curated progress counters that deliberately do NOT match what a disk scan
  // would derive (disk has only one near-empty phase dir). The bug rebuilds
  // progress.* from that disk snapshot, trampling these values.
  const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active
status: in_progress
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 99
  completed_plans: 88
  percent: 88
---

# Project State

## Configuration
Current Phase: 2
Current Phase Name: builder
Total Plans in Phase: 0
Status: Not started
Last Activity: TBD
Last Activity Description: pending

## Current Position

Phase: 2 (builder)
Status: Not started
Last activity: TBD
`;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      '# Roadmap\n\n## 🚧 v3.0: Active\n\n### Phase 2: builder\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // One sparse phase dir so a disk resync would derive small/zero counters.
    const dir = path.join(planning, 'phases', '02-builder');
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function readProgress() {
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const block = md.split('---')[1] || '';
    const num = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    return {
      total_plans: num('total_plans'),
      completed_plans: num('completed_plans'),
      total_phases: num('total_phases'),
      completed_phases: num('completed_phases'),
    };
  }

  test('planned-phase updates per-phase body fields but leaves milestone progress.* untouched', () => {
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '3'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    // The command did its real job: per-phase "Total Plans in Phase" was set.
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(md, /Total Plans in Phase:\s*3/, 'per-phase Total Plans in Phase should be updated to 3');

    // #2440: total_plans now takes the derived value (it must correct in both
    // directions). It must NOT be the stale curated 99 — that was the bug.
    // completed_plans and completed_phases keep curated protection (#500/#3242).
    const progress = readProgress();
    assert.notEqual(progress.total_plans, 99,
      'total_plans must NOT be the stale curated 99 — it should correct to the derived value (#2440)');
    assert.strictEqual(progress.completed_plans, 88,
      'completed_plans must stay curated (88) — #3242/#500 protection still in force');
    assert.strictEqual(progress.completed_phases, 5,
      'completed_phases must stay curated (5) — #3242/#500 protection still in force');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3262-scan-phase-plans.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3262-scan-phase-plans (consolidation epic #1969 B3 #1972)", () => {
/**
 * Tests for the shared scanPhasePlans() helper (k014).
 *
 * Covers:
 *   - Top-level plans only (flat layout)
 *   - Top-level + nested layout (post-#3139)
 *   - Completed-summary detection (summaries >= plans)
 *   - Ignored files (OUTLINE, pre-bounce, CONTEXT, RESEARCH)
 *   - Empty phase dir → { planCount: 0, summaryCount: 0 }
 *   - Parity: helper produces correct counts for mixed flat+nested fixture tree
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

// Helper under test — must exist at this path (GREEN phase wires it up)
const scanPhasePlans = require('../gsd-core/bin/lib/plan-scan.cjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir;

function phaseDir(name = 'phase') {
  const d = path.join(tmpDir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function touch(dir, ...filenames) {
  for (const f of filenames) {
    fs.writeFileSync(path.join(dir, f), '');
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-scan-'));
});

afterEach(() => {
  cleanup(tmpDir);
});

// ---------------------------------------------------------------------------
// Basic shapes
// ---------------------------------------------------------------------------

describe('scanPhasePlans — flat layout', () => {
  test('empty directory → zero counts', () => {
    const dir = phaseDir();
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 0, 'planCount');
    assert.strictEqual(result.summaryCount, 0, 'summaryCount');
  });

  test('bare PLAN.md counts as one plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'planCount');
    assert.strictEqual(result.summaryCount, 0, 'summaryCount');
  });

  test('canonical padded plan file (01-01-PLAN.md)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'planCount');
  });

  test('canonical padded plan + matching summary → completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, true, 'phase should be complete when summaries >= plans');
  });

  test('plan without summary → not completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.completed, false);
  });

  test('multiple plans all summarized → completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-02-PLAN.md', '01-01-SUMMARY.md', '01-02-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2);
    assert.strictEqual(result.summaryCount, 2);
    assert.strictEqual(result.completed, true);
  });

  test('bare SUMMARY.md counts as one summary', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
  });

  test('extended-layout root file (5-PLAN-01-setup.md style)', () => {
    // roadmap.cjs isPlanFile explicitly matches any .md with PLAN in name at root
    // (not just ending with -PLAN.md). The canonical helper must too.
    // e.g. gsd-plan-phase writes "5-PLAN-01-setup.md".
    const dir = phaseDir();
    // The summary for this file follows the canonical *-SUMMARY.md suffix convention.
    touch(dir, '3-PLAN-01-setup.md', '3-01-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'extended-layout root plan counted');
    assert.strictEqual(result.summaryCount, 1, 'extended-layout root summary counted');
  });
});

// ---------------------------------------------------------------------------
// Ignored files
// ---------------------------------------------------------------------------

describe('scanPhasePlans — ignored files', () => {
  test('PLAN-OUTLINE file is ignored (flat)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-PLAN-OUTLINE.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'OUTLINE should not count as a plan');
  });

  test('pre-bounce file is ignored (flat)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-PLAN.pre-bounce.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'pre-bounce should not count as a plan');
  });

  test('CONTEXT.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'CONTEXT.md', '01-01-CONTEXT.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'CONTEXT files should not be plans');
  });

  test('RESEARCH.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'RESEARCH.md', '01-01-RESEARCH.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'RESEARCH files should not be plans');
  });

  test('VERIFICATION.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'VERIFICATION.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'VERIFICATION files should not be plans');
  });

  // #2252: *-PLAN-REVIEW.md is a review artifact, not an executable plan.
  test('PLAN-REVIEW file is not counted as a plan (#2252)', () => {
    const dir = phaseDir();
    touch(dir, '42-01-PLAN.md', '42-PLAN-REVIEW.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'PLAN-REVIEW should not count as a plan');
    assert.ok(result.planFiles.includes('42-01-PLAN.md'));
    assert.ok(!result.planFiles.includes('42-PLAN-REVIEW.md'));
  });

  test('PLAN-REVIEW is excluded even with no real plans (#2252)', () => {
    const dir = phaseDir();
    touch(dir, '42-PLAN-REVIEW.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 0, 'a lone PLAN-REVIEW must not count as a plan');
  });
});

// ---------------------------------------------------------------------------
// Nested layout (post-#3139)
// ---------------------------------------------------------------------------

describe('scanPhasePlans — nested layout', () => {
  test('nested PLAN-NN-slug.md files counted', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-02-impl.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2, 'nested plans counted');
    assert.strictEqual(result.hasNestedPlans, true, 'hasNestedPlans flag set');
  });

  test('nested SUMMARY-NN-slug.md files counted', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'SUMMARY-01-setup.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, true);
    assert.deepStrictEqual(result.planFiles, ['plans/PLAN-01-setup.md']);
    assert.deepStrictEqual(result.summaryFiles, ['plans/SUMMARY-01-setup.md']);
  });

  test('flat root + nested plans combined', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    // root: 1 plan, 1 summary
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md');
    // nested: 2 plans, 1 summary
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-02-impl.md', 'SUMMARY-01-setup.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 3, 'root + nested plans');
    assert.strictEqual(result.summaryCount, 2, 'root + nested summaries');
    assert.strictEqual(result.completed, false, 'not all plans have summaries');
  });

  test('hasNestedPlans is false when plans/ directory absent', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.hasNestedPlans, false);
  });

  test('nested OUTLINE files are ignored', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-01-OUTLINE.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'OUTLINE excluded in nested');
  });

  test('nested pre-bounce files are ignored', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-01.pre-bounce.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'pre-bounce excluded in nested');
  });

  test('plans/ that is not readable as directory does not throw', () => {
    const dir = phaseDir();
    // Create plans/ as a file (unreadable as directory)
    fs.writeFileSync(path.join(dir, 'plans'), 'not-a-directory');
    touch(dir, 'PLAN.md');
    // Should not throw
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.hasNestedPlans, false);
  });
});

// ---------------------------------------------------------------------------
// Parity: helper output shape and mixed fixture
// ---------------------------------------------------------------------------

describe('scanPhasePlans — call-site parity on mixed fixture', () => {
  // Build a fixture tree that exercises both flat and nested layout:
  // 01-foundation/
  //   01-01-PLAN.md
  //   01-01-SUMMARY.md
  //   01-01-PLAN-OUTLINE.md   (should be ignored)
  //   01-02-PLAN.md
  //   plans/
  //     PLAN-01-setup.md
  //     SUMMARY-01-setup.md

  function buildMixedPhase() {
    const dir = phaseDir('01-foundation');
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md', '01-01-PLAN-OUTLINE.md', '01-02-PLAN.md');
    touch(plansDir, 'PLAN-01-setup.md', 'SUMMARY-01-setup.md');
    return dir;
  }

  test('scanPhasePlans() counts match expected values for mixed fixture', () => {
    const dir = buildMixedPhase();
    const result = scanPhasePlans(dir);
    // flat: 01-01-PLAN.md + 01-02-PLAN.md = 2 (OUTLINE ignored)
    // nested: PLAN-01-setup.md = 1
    assert.strictEqual(result.planCount, 3, 'planCount should be 3');
    // flat: 01-01-SUMMARY.md = 1; nested: SUMMARY-01-setup.md = 1
    assert.strictEqual(result.summaryCount, 2, 'summaryCount should be 2');
    assert.strictEqual(result.completed, false, 'not all plans have summaries');
    assert.strictEqual(result.hasNestedPlans, true, 'nested layout present');
  });

  test('scanPhasePlans() output shape has required fields', () => {
    const dir = buildMixedPhase();
    const result = scanPhasePlans(dir);
    assert.ok('planCount' in result, 'planCount field present');
    assert.ok('summaryCount' in result, 'summaryCount field present');
    assert.ok('completed' in result, 'completed field present');
    assert.ok('hasNestedPlans' in result, 'hasNestedPlans field present');
    assert.ok('planFiles' in result, 'planFiles field present');
    assert.ok('summaryFiles' in result, 'summaryFiles field present');
    assert.ok(Array.isArray(result.planFiles), 'planFiles is array');
    assert.ok(Array.isArray(result.summaryFiles), 'summaryFiles is array');
  });

  test('parity baseline: 2 flat + 1 nested plans across all call sites', () => {
    // This test documents the exact expected counts for a representative fixture.
    // After the GREEN phase ports roadmap.cjs/state.cjs/init.cjs to use
    // scanPhasePlans, those call sites delegate here and this assertion is
    // the single contract all of them must satisfy.
    const dir = phaseDir('02-api');
    touch(dir, '02-01-PLAN.md', '02-02-PLAN.md', '02-01-SUMMARY.md');
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-impl.md', 'SUMMARY-01-impl.md');

    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 3, 'helper: 2 flat + 1 nested');
    assert.strictEqual(result.summaryCount, 2, 'helper: 1 flat + 1 nested');
    assert.strictEqual(result.completed, false, '2 summaries < 3 plans');
    assert.strictEqual(result.hasNestedPlans, true, 'plans/ dir exists with plans');
  });
});

// ---------------------------------------------------------------------------
// #2349: plan-level supersession. A plan whose frontmatter declares
// `status: superseded` was deliberately reassigned / never executed and can
// never gain a matching SUMMARY. Like a retired phase (#1514, one level up) it
// must be excluded from BOTH the plan and summary counts, so the phase can still
// read 100% complete instead of being pinned below it forever. A plan WITHOUT
// the marker must be counted exactly as before (no over-exclusion).
// ---------------------------------------------------------------------------

describe('scanPhasePlans — superseded plans (#2349)', () => {
  const SUPERSEDED_FM =
    '---\nphase: "1"\nplan: "6"\ntype: implementation\nstatus: superseded\n---\n\n# Superseded plan\n';

  function writePlan(dir, name, body) {
    fs.writeFileSync(path.join(dir, name), body);
  }

  test('a plan marked status: superseded is excluded from planCount and planFiles', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md');
    writePlan(dir, '01-06-PLAN.md', SUPERSEDED_FM);
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'superseded plan not counted in planCount');
    assert.strictEqual(result.summaryCount, 1, 'summaryCount honest at 1');
    assert.strictEqual(result.completed, true, 'phase completes despite the summary-less superseded plan');
    assert.ok(!result.planFiles.includes('01-06-PLAN.md'), 'superseded plan absent from planFiles');
    assert.ok(result.planFiles.includes('01-01-PLAN.md'), 'live plan still present');
  });

  test('reported case: 13 plans, 2 superseded, 11 summaries → 11/11 completed', () => {
    const dir = phaseDir();
    // 11 executed plans, each with its matching summary
    for (let i = 1; i <= 11; i++) {
      const n = String(i).padStart(2, '0');
      touch(dir, `05-${n}-PLAN.md`, `05-${n}-SUMMARY.md`);
    }
    // 2 superseded plans, no summaries (work reassigned to later plans)
    writePlan(dir, '05-12-PLAN.md', SUPERSEDED_FM);
    writePlan(dir, '05-13-PLAN.md', SUPERSEDED_FM);
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 11, 'denominator excludes the 2 superseded plans');
    assert.strictEqual(result.summaryCount, 11, 'numerator honest at 11');
    assert.strictEqual(result.completed, true, 'phase reads complete — no longer pinned below 100%');
  });

  test('boundary: a live unsummarized plan still blocks completion (limit+1)', () => {
    const dir = phaseDir();
    touch(dir, '02-01-PLAN.md', '02-01-SUMMARY.md');
    touch(dir, '02-02-PLAN.md'); // live plan, no summary → must still block
    writePlan(dir, '02-09-PLAN.md', SUPERSEDED_FM); // superseded, excluded
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2, 'only the superseded plan is excluded');
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, false, 'a live unsummarized plan still blocks completion');
  });

  test('no over-exclusion: a plan without the marker (or with a non-superseded status) is counted', () => {
    const dir = phaseDir();
    touch(dir, '03-01-PLAN.md'); // empty file, no frontmatter at all
    writePlan(dir, '03-02-PLAN.md', '---\nphase: "3"\nplan: "2"\nstatus: complete\n---\n\n# done\n');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2, 'only status: superseded is excluded; other/absent statuses count');
    assert.ok(result.planFiles.includes('03-01-PLAN.md'));
    assert.ok(result.planFiles.includes('03-02-PLAN.md'));
  });

  test('superseded marker is case-insensitive and whitespace-tolerant', () => {
    const dir = phaseDir();
    touch(dir, '04-01-PLAN.md', '04-01-SUMMARY.md');
    writePlan(dir, '04-07-PLAN.md', '---\nphase: "4"\nplan: "7"\nstatus:   Superseded  \n---\n\n# x\n');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'Superseded (mixed-case, padded) still excluded');
    assert.strictEqual(result.completed, true);
  });

  test('nested layout: a superseded nested plan is excluded too', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'SUMMARY-01-setup.md');
    writePlan(plansDir, 'PLAN-02-dropped.md', SUPERSEDED_FM);
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'nested superseded plan excluded');
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, true);
    assert.ok(!result.planFiles.includes('plans/PLAN-02-dropped.md'));
  });

  test('fail-safe: an unreadable plan path (a directory named *-PLAN.md) is counted, not treated as superseded', () => {
    const dir = phaseDir();
    touch(dir, '06-01-PLAN.md', '06-01-SUMMARY.md');
    // A *directory* whose name matches a plan file: readdir lists it, but reading
    // it as a file throws EISDIR on every platform (root-independent, leak-safe).
    // The read-failure path must fail safe to "not superseded" (counted) — never
    // silently drop a plan whose frontmatter simply could not be read.
    fs.mkdirSync(path.join(dir, '06-02-PLAN.md'));
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2, 'unreadable plan still counted (fail-safe, not excluded)');
    assert.strictEqual(result.completed, false, 'the unreadable plan has no summary → still blocks');
  });

  test('all plans superseded → phase reads complete, not pinned below 100% (0 >= 0)', () => {
    const dir = phaseDir();
    // Every plan in the phase was reassigned elsewhere: nothing left to execute.
    writePlan(dir, '08-01-PLAN.md', SUPERSEDED_FM);
    writePlan(dir, '08-02-PLAN.md', SUPERSEDED_FM);
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 0, 'all plans excluded');
    assert.strictEqual(result.summaryCount, 0);
    assert.strictEqual(result.completed, true, 'a fully-superseded phase has no remaining work → complete');
  });

  test('a genuinely empty phase (no plans authored) still reads NOT complete', () => {
    // Regression guard for the all-superseded fix: the completion guard keys off
    // whether any plans existed on disk, so a phase with zero plans is unaffected.
    const result = scanPhasePlans(phaseDir());
    assert.strictEqual(result.planCount, 0);
    assert.strictEqual(result.completed, false, 'no plans authored → not complete (unchanged)');
  });

  test('a superseded marker is detected even when the plan body is very large', () => {
    // Frontmatter sits at byte 0; the scan reads only a bounded prefix, so a large
    // body must neither hide the marker nor force reading the whole file.
    const dir = phaseDir();
    touch(dir, '09-01-PLAN.md', '09-01-SUMMARY.md');
    const bigBody = 'x'.repeat(200 * 1024); // 200 KB body, well past the read cap
    writePlan(dir, '09-09-PLAN.md', `---\nphase: "9"\nplan: "9"\nstatus: superseded\n---\n\n${bigBody}\n`);
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'superseded plan with a large body still excluded');
    assert.strictEqual(result.completed, true);
  });

  test('property: K superseded plans never change the completed verdict of N summarized plans', () => {
    const fc = require('fast-check');
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 5 }), (n, k) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-scan-prop-'));
        try {
          for (let i = 1; i <= n; i++) {
            const idx = String(i).padStart(2, '0');
            fs.writeFileSync(path.join(dir, `07-${idx}-PLAN.md`), '');
            fs.writeFileSync(path.join(dir, `07-${idx}-SUMMARY.md`), '');
          }
          for (let j = 1; j <= k; j++) {
            fs.writeFileSync(path.join(dir, `07-${String(50 + j)}-PLAN.md`), SUPERSEDED_FM);
          }
          const result = scanPhasePlans(dir);
          assert.strictEqual(result.planCount, n, 'planCount ignores the K superseded plans');
          assert.strictEqual(result.completed, true, 'N fully-summarized plans stay complete regardless of K');
        } finally {
          cleanup(dir);
        }
      }),
      { numRuns: 40 },
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3594-parser-adversarial-roadmap.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3594-parser-adversarial-roadmap (consolidation epic #1969 B8 #1977)", () => {
/**
 * Adversarial roadmap-parser tests (#3594).
 *
 * Loads each fixture in `tests/fixtures/adversarial/roadmap/` as the
 * project's `.planning/ROADMAP.md` and pins invariants on the public
 * `gsd-tools roadmap get-phase <N>` surface — which routes through the
 * SDK bridge when available and the CJS handler otherwise.
 *
 * Per CONTRIBUTING.md §"Testing Standards / Parser and project-file
 * inputs", the assertion target is the typed JSON shape the CLI emits,
 * not stderr prose. The harness in `tests/helpers/cli-negative.cjs`
 * (introduced by #3627 / #3593) is reused here for consistency.
 *
 * Several fixtures encode known historical regressions:
 *   - fenced-code-block headings shadowing real phases (#2787)
 *   - decimal phase prefix collisions (#3537)
 *   - HTML-comment heading false positives
 *
 * Pre-existing parser bugs surfaced by these fixtures are NOT fixed in
 * this PR — fixing them is out of scope for "add adversarial test
 * coverage." Where a fixture exposes a still-open bug, the test
 * asserts the *currently observed* behavior with a comment naming the
 * open issue, so the flip from RED→GREEN is a one-line change the day
 * the real fix lands.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'roadmap');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

/**
 * Create a temp project whose ROADMAP.md is the named fixture's content.
 * Returns the project directory; caller is responsible for cleanup.
 */
function projectWithFixture(t, fixtureName) {
  const projectDir = createTempProject('roadmap-adv-' + fixtureName.replace(/\W+/g, '-') + '-');
  t.after(() => cleanup(projectDir));
  fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), loadFixture(fixtureName));
  return projectDir;
}

/**
 * Run `gsd-tools roadmap get-phase <N>` and parse the JSON payload.
 * Returns `{ ok, exit, parsed, raw }` so tests can assert on either
 * the exit code or the structured payload.
 */
function getPhase(projectDir, phaseNum) {
  // No --json-errors — the get-phase command outputs JSON on success
  // via the normal stdout path. Reading the parsed payload is what the
  // workflows downstream do, so that's what we test.
  const result = runCli(['roadmap', 'get-phase', phaseNum], { cwd: projectDir, jsonErrors: false });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Leave parsed null; tests that depend on it must handle that.
  }
  return {
    exit: result.status,
    ok: result.status === 0,
    parsed,
    raw: result.stdout,
    stderr: result.stderr,
    hasStackTrace: result.hasStackTrace,
  };
}

// ─── Fenced code block heading shadowing ────────────────────────────────────

describe('feat-3594: roadmap parser and fenced-code-block headings (#2787)', () => {
  test('phase 1 in real prose is found even when ## Phase 999 appears inside a ``` block', (t) => {
    const projectDir = projectWithFixture(t, 'phase-heading-inside-fenced-code.md');
    const result = getPhase(projectDir, '1');
    assert.equal(result.hasStackTrace, false, 'no V8 stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true, 'phase 1 must be found');
    assert.equal(result.parsed.phase_number, '1');
    assert.match(result.parsed.phase_name, /real phase one/);
  });

  test('phase 999 inside a fenced block is ignored', (t) => {
    const projectDir = projectWithFixture(t, 'phase-heading-inside-fenced-code.md');
    const result = getPhase(projectDir, '999');
    assert.equal(result.hasStackTrace, false, 'no stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, false, 'phase headings inside fenced blocks must not be parsed');
  });

  test('fenced example heading does not shadow the real phase details and backlog phase stays unresolved (#1588)', (t) => {
    const projectDir = createTempProject('roadmap-1588-');
    t.after(() => cleanup(projectDir));
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.1',
        'status: planning',
        '---',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details open>',
        '<summary>v1.1 Current (Phases 8-9) - PLANNED</summary>',
        '',
        '- [ ] **Phase 9: Real Phase**',
        '',
        '</details>',
        '',
        '## Phase Details',
        '',
        '```markdown',
        '### Phase 9: Fenced Example Phase',
        '**Goal:** This example must not be treated as roadmap structure.',
        '```',
        '',
        '### Phase 9: Real Phase',
        '**Goal:** Use the real phase details outside the fenced block.',
        '**Requirements:** REAL-01',
        '',
        '## Backlog',
        '',
        '### Phase 999.1: Backlog Thing',
        '**Goal:** Future backlog item.',
        '',
      ].join('\n')
    );

    const phase9 = getPhase(projectDir, '9');
    assert.ok(phase9.parsed, `expected JSON payload, got: ${phase9.raw}`);
    assert.equal(phase9.parsed.found, true, 'phase 9 must be found');
    assert.equal(phase9.parsed.phase_name, 'Real Phase');
    assert.equal(phase9.parsed.goal, 'Use the real phase details outside the fenced block.');
    assert.match(phase9.parsed.section, /REAL-01/, 'real phase section must be returned');

    const backlog = getPhase(projectDir, '999.1');
    assert.ok(backlog.parsed, `expected JSON payload, got: ${backlog.raw}`);
    assert.equal(backlog.parsed.found, false, 'backlog sentinel phase must not resolve as an active roadmap phase');
  });
});

// ─── Decimal phase prefix collisions ────────────────────────────────────────

describe('feat-3594: roadmap parser handles decimal phase prefix collisions (#3537)', () => {
  test('asking for phase "2" returns the integer phase, NOT phase 2.1 or 2.10', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2');
    assert.match(result.parsed.phase_name, /integer phase two/);
  });

  test('asking for phase "2.1" returns the decimal child', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2.1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2.1');
    assert.match(result.parsed.phase_name, /decimal child/);
  });

  test('asking for phase "2.10" returns the decimal sibling, NOT phase 2.1', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2.10');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2.10');
    assert.match(result.parsed.phase_name, /decimal phase 2\.10/);
  });

  test('asking for phase "21" returns phase 21, NOT phase 2 (prefix-collision guard)', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '21');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '21');
    assert.match(result.parsed.phase_name, /phase twenty-one/);
  });
});

// ─── Unicode phase titles ───────────────────────────────────────────────────

describe('feat-3594: roadmap parser preserves Unicode phase titles', () => {
  test('Japanese title round-trips through phase_name', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.phase_name, '日本語フェーズ — initial setup');
  });

  test('emoji + smart-quote title survives', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '2');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.match(result.parsed.phase_name, /🚧/);
    assert.match(result.parsed.phase_name, /Émile/);
  });

  test('Greek-letter title survives', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '3');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.phase_name, 'αβγ δεζ ηθι');
  });
});

// ─── Repeated phase IDs ─────────────────────────────────────────────────────

describe('feat-3594: roadmap parser handles repeated phase IDs deterministically', () => {
  test('two declarations of phase 1: parser returns the FIRST match (current behavior)', (t) => {
    const projectDir = projectWithFixture(t, 'repeated-phase-ids.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    // The regex uses `content.match(...)` which returns the FIRST match.
    // Pin that — a future change to last-wins or de-dup would fire.
    assert.match(result.parsed.phase_name, /first declaration/);
  });
});

// ─── HTML comments ──────────────────────────────────────────────────────────

describe('feat-3594: roadmap parser and HTML-commented headings', () => {
  test('phase 1 in real prose is found even when phase 998/999 appear inside <!-- ... -->', (t) => {
    const projectDir = projectWithFixture(t, 'markdown-headings-inside-html-comment.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_name, 'real phase');
  });

  test('phase 999 inside an HTML comment remains ignored because backlog sentinels never resolve', (t) => {
    const projectDir = projectWithFixture(t, 'markdown-headings-inside-html-comment.md');
    const result = getPhase(projectDir, '999');
    assert.equal(result.hasStackTrace, false, 'no stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, false, 'backlog sentinel phases must not resolve');
  });
});

// ─── Cross-corpus invariant ────────────────────────────────────────────────

describe('feat-3594: roadmap parser does not crash on ANY corpus fixture', () => {
  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const fixture of fixtures) {
    test(`fixture "${fixture}" — get-phase with arbitrary IDs must not crash`, (t) => {
      const projectDir = projectWithFixture(t, fixture);
      for (const id of ['1', '2', '99', '999', '0', '2.1']) {
        const result = getPhase(projectDir, id);
        assert.equal(result.hasStackTrace, false, `${fixture} id=${id}: no V8 stack frame allowed`);
        // exit status varies (0 for found, non-zero for not-found —
        // both are valid). What's pinned: the parser produced SOME output
        // (either valid JSON or a clean stderr) without crashing.
      }
    });
  }
});
  });
}

// ─── #2200: currentMilestoneRawRanges scopes phase-complete writes ────────────
// The phase-complete roadmap mutators (checkbox-flip + Plans writer) must mutate
// only within the active milestone so they cannot touch a backticked prose
// literal, a Backlog entry, or a same-numbered phase in a shipped milestone.
// This tests the scoping helper the fix rests on (the mutators' command path is
// covered by the existing phase-complete suite; gsd-test confirms no regression).
{
  const { describe: d3, test: t3 } = require('node:test');
  const a3 = require('node:assert/strict');
  const fs3 = require('node:fs');
  const path3 = require('node:path');
  const { createTempProject: ctp3, cleanup: cu3 } = require('./helpers.cjs');
  const rp3 = require('../gsd-core/bin/lib/roadmap-parser.cjs');

  d3('#2200 currentMilestoneRawRanges — scopes writes to the active milestone', () => {
    t3('the active window contains the active phase bullet, excludes Backlog + prose + shipped', () => {
      const tmpDir = ctp3('fix-2200-');
      try {
        // Shipped milestone (in a <details> block) + Backlog + a backticked prose
        // literal all come BEFORE the active milestone — the typical layout.
        const roadmap = [
          '# Roadmap', '',
          '## Backlog', '- [ ] **Phase 1: Some Future Idea**', '',
          '> See `- [ ] **Phase 1: Alpha**` in the active milestone.', '',
          '<details><summary>✅ v0.9 Old</summary>',
          '- [x] **Phase 1: Legacy**',
          '### Phase 1: Legacy',
          '**Plans:** 9/9 plans complete',
          '</details>', '',
          '## v1.0 — Active', '',
          '- [ ] **Phase 1: Alpha**', '',
          '### Phase 1: Alpha',
          '**Plans:** 0/1 plans complete', '',
        ].join('\n');
        fs3.writeFileSync(path3.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
        fs3.writeFileSync(path3.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.0\ncurrent_phase: 1\n---\n');
        const ranges = rp3.currentMilestoneRawRanges(roadmap, tmpDir);
        a3.ok(ranges, 'a versioned active milestone must yield ranges');
        const primary = roadmap.slice(ranges.primary.start, ranges.primary.end);
        a3.ok(primary.includes('- [ ] **Phase 1: Alpha**'), 'active phase bullet is inside the window');
        a3.ok(!primary.includes('Some Future Idea'), 'a Backlog entry is outside the active window');
        a3.ok(!primary.includes('See `- [ ]'), 'a backticked prose literal is outside the active window');
        a3.ok(!primary.includes('9/9 plans complete'), 'a shipped milestone plan-count line is outside the active window');
      } finally {
        cu3(tmpDir);
      }
    });

    t3('returns null without a versioned active milestone (whole-content fallback)', () => {
      a3.strictEqual(rp3.currentMilestoneRawRanges('# Roadmap\n- [ ] **Phase 1: X**\n', undefined), null);
    });
  });
}
// ─── #2199: bullet/em-dash ROADMAP phase resolution ───────────────────────────
// Self-contained block: phase lookup + milestone filter must accept bullet/
// checkbox entries with an em-dash/en-dash/hyphen/colon separator, not just the
// ATX-heading + colon form. Previously such an entry resolved found:false and
// `Phase null` was written into STATE.md; a bullet-only ROADMAP collapsed the
// milestone filter to a zero-count pass-all.
{
  const { describe: d2, test: t2, beforeEach: be2, afterEach: ae2 } = require('node:test');
  const a2 = require('node:assert/strict');
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const { createTempProject: ctp2, cleanup: cu2 } = require('./helpers.cjs');
  const rp2 = require('../gsd-core/bin/lib/roadmap-parser.cjs');
  const writeRoadmap2 = (d, c) => fs2.writeFileSync(path2.join(d, '.planning', 'ROADMAP.md'), c);

  d2('#2199 roadmap bullet/em-dash phase resolution', () => {
    let tmpDir;
    be2(() => { tmpDir = ctp2('fix-2199-'); });
    ae2(() => { cu2(tmpDir); });

    t2('an all-bullet em-dash ROADMAP resolves each phase (no Phase null)', () => {
      writeRoadmap2(tmpDir, [
        '# Roadmap', '', '## v1.0 Active', '',
        '- [ ] **Phase 1 — Authentication**: login flow',
        '- [ ] **Phase 2 — Authorization**: RBAC',
        '- [x] **Phase 3 — Audit Logging**: events',
        '',
      ].join('\n'));
      const p1 = rp2.getRoadmapPhaseInternal(tmpDir, '1');
      a2.ok(p1 && p1.found, 'Phase 1 must resolve on a bullet ROADMAP');
      a2.strictEqual(p1.phase_name, 'Authentication');
      const p2 = rp2.getRoadmapPhaseInternal(tmpDir, '2');
      a2.ok(p2 && p2.found);
      a2.strictEqual(p2.phase_name, 'Authorization');
      const p3 = rp2.getRoadmapPhaseInternal(tmpDir, '3');
      a2.ok(p3 && p3.found, 'a checked [x] bullet must also resolve');
      a2.strictEqual(p3.phase_name, 'Audit Logging');
      const absent = rp2.getRoadmapPhaseInternal(tmpDir, '99');
      a2.ok(!absent || !absent.found, 'an absent phase must not resolve');
    });

    t2('bullet entries with colon / en-dash / hyphen separators all resolve', () => {
      writeRoadmap2(tmpDir, [
        '# Roadmap', '', '## v1.0 Active', '',
        '- [ ] **Phase 1: Colon Sep**: one',
        '- [ ] **Phase 2 – En Dash**: two',
        '- [ ] **Phase 3 - Hyphen Sep**: three',
        '',
      ].join('\n'));
      a2.strictEqual(rp2.getRoadmapPhaseInternal(tmpDir, '1').phase_name, 'Colon Sep');
      a2.strictEqual(rp2.getRoadmapPhaseInternal(tmpDir, '2').phase_name, 'En Dash');
      a2.strictEqual(rp2.getRoadmapPhaseInternal(tmpDir, '3').phase_name, 'Hyphen Sep');
    });

    t2('mixed heading + bullet forms both resolve', () => {
      writeRoadmap2(tmpDir, [
        '# Roadmap', '', '## v1.0 Active', '',
        '### Phase 1: Heading Form',
        'body',
        '- [ ] **Phase 2 — Bullet Form**: two',
        '',
      ].join('\n'));
      const p1 = rp2.getRoadmapPhaseInternal(tmpDir, '1');
      a2.ok(p1 && p1.found, 'heading form still resolves (no regression)');
      a2.ok(/Heading Form/.test(p1.phase_name));
      const p2 = rp2.getRoadmapPhaseInternal(tmpDir, '2');
      a2.ok(p2 && p2.found, 'bullet form resolves alongside heading form');
      a2.strictEqual(p2.phase_name, 'Bullet Form');
    });

    t2('milestone phase-count counts bullet-form phases (not zero)', () => {
      writeRoadmap2(tmpDir, [
        '# Roadmap', '', '## v1.0 Active', '',
        '- [ ] **Phase 1 — One**: a',
        '- [ ] **Phase 2 — Two**: b',
        '- [ ] **Phase 3 — Three**: c',
        '',
      ].join('\n'));
      const filter = rp2.getMilestonePhaseFilter(tmpDir);
      a2.strictEqual(filter.phaseCount, 3,
        'a bullet-only ROADMAP must populate the milestone phase set (was a zero-count pass-all before #2199)');
      a2.ok(filter('1'), 'phase 1 dir is in the milestone set');
      a2.ok(filter('2'), 'phase 2 dir is in the milestone set');
      a2.ok(!filter('99'), 'a non-listed phase is excluded');
    });

    t2('#2199 heading in Phase Details (full content) beats a bullet in the active scope', () => {
      // The exact first-attempt regression: a bullet for the phase exists in the
      // active-milestone scope, but the heading (carrying Requirements) lives in a
      // Phase Details section outside that scope (only in fullContent). The heading
      // MUST win — otherwise the bullet's single-line section yields null req_ids.
      writeRoadmap2(tmpDir, [
        '# Roadmap', '',
        '## Milestones', '',
        '- 🚧 **v1.0 Active** - Phases 10-11', '',
        '## v1.0 Active', '',
        '- [ ] **Phase 11 — Second Active Phase**',
        '',
        '## Phase Details', '',
        '### Phase 11: Second Active Phase',
        '**Requirements**: REQ-02, REQ-03',
        '',
      ].join('\n'));
      const p11 = rp2.getRoadmapPhaseInternal(tmpDir, '11');
      a2.ok(p11 && p11.found, 'phase 11 resolves');
      a2.ok(/REQ-02/.test(p11.section),
        'the heading section (with Requirements) must win over the scoped bullet line');
    });
  });
}

// ─── #1881: an unreadable ROADMAP is not an absent one ───────────────────────
//
// getRoadmapPhaseInternal returns null for a read failure exactly as it does for
// "phase not found", and getMilestoneInfo (#3216: now {value, scope}) returns
// {value:null, scope:SCOPE.UNREADABLE} for a read failure exactly as it does for
// "no ROADMAP yet" — the shared return shape stays sentinel-identical between the
// two causes; only the out-of-band diagnostic distinguishes them. Per ADR-1411's
// "corrupt is not absent" amendment both return values are preserved and the
// cause is surfaced out of band instead.
//
// The discriminator is the errno, and it is load-bearing in the silent direction:
// getMilestoneInfo has no existsSync guard, so platformReadSync's null-for-ENOENT
// is converted to a synthetic Error('missing') that lands in the SAME catch as a
// real EACCES. Reporting unconditionally there would flag every project that has
// no ROADMAP.md — i.e. every brand-new project — as corrupt. Half of these cases
// exist to hold that line.
//
// Faults are injected by overriding platformReadSync and restoring in t.after(),
// never chmod 0o000: root bypasses mode bits, so a permission-based version would
// silently pass with zero coverage in root Docker/CI.

describe('#1881 unreadable ROADMAP vs absent ROADMAP', () => {
  const scp = require('../gsd-core/bin/lib/shell-command-projection.cjs');
  const {
    UNUSABLE_REASON,
    _resetUnusableInputWarningsForTests,
    _unusableInputEmissionCountForTests,
  } = require('../gsd-core/bin/lib/unusable-input.cjs');

  const HEALTHY = [
    '# Roadmap',
    '',
    '## Milestone v2.3: Alpha',
    '',
    '### Phase 1: Alpha',
    '**Goal**: ship',
    '',
  ].join('\n');

  /** Write a project with the given ROADMAP content (or none when null). */
  function project(t, roadmap) {
    const dir = createTempProject('gsd-1881-');
    t.after(() => cleanup(dir));
    const planning = path.join(dir, '.planning');
    fs.mkdirSync(planning, { recursive: true });
    if (roadmap !== null) fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap);
    return dir;
  }

  /**
   * Make reads of files matching `match` fail with `err`, restoring in t.after().
   * Overrides the projection seam rather than the filesystem so the failure is
   * deterministic on every platform and under root.
   */
  function failReads(t, match, err) {
    const original = scp.platformReadSync;
    t.after(() => {
      Object.defineProperty(scp, 'platformReadSync', { value: original, configurable: true });
    });
    Object.defineProperty(scp, 'platformReadSync', {
      configurable: true,
      value: (p) => {
        if (match(String(p))) throw err;
        return original(p);
      },
    });
  }

  /** Silence stderr for the duration of `fn` and report how many diagnostics it wrote. */
  function emissionsDuring(fn) {
    const before = _unusableInputEmissionCountForTests();
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      fn();
    } finally {
      process.stderr.write = originalWrite;
    }
    return _unusableInputEmissionCountForTests() - before;
  }

  function eacces() {
    const e = new Error('EACCES: permission denied');
    e.code = 'EACCES';
    return e;
  }

  test('a healthy roadmap resolves a phase and stays silent', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    let result;
    const emitted = emissionsDuring(() => { result = getRoadmapPhaseInternal(dir, '1'); });
    assert.strictEqual(result.found, true);
    assert.strictEqual(emitted, 0);
  });

  test('a healthy roadmap resolves the milestone and stays silent', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    let info;
    const emitted = emissionsDuring(() => { info = getMilestoneInfo(dir); });
    assert.deepStrictEqual(info, { value: { version: 'v2.3', name: 'Alpha' }, scope: SCOPE.COMPLETE });
    assert.strictEqual(emitted, 0);
  });

  test('an unreadable roadmap is reported on a phase lookup, and still returns null', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eacces());
    let result;
    const emitted = emissionsDuring(() => { result = getRoadmapPhaseInternal(dir, '1'); });
    assert.strictEqual(result, null, 'the sentinel must be preserved exactly');
    assert.strictEqual(emitted, 1);
  });

  test('an unreadable roadmap is reported on a milestone lookup, and returns {value:null, scope:UNREADABLE} (#3216: the plausible-looking v1.0 default was deleted)', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eacces());
    let info;
    const emitted = emissionsDuring(() => { info = getMilestoneInfo(dir); });
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNREADABLE },
      'a read fault must surface as UNREADABLE, never a fabricated version/name');
    assert.strictEqual(emitted, 1);
  });

  test('a project with NO roadmap stays silent — absence is not corruption', (t) => {
    // The false-positive that would otherwise fire on every brand-new project.
    _resetUnusableInputWarningsForTests();
    const dir = project(t, null);
    let phase, info;
    const emitted = emissionsDuring(() => {
      phase = getRoadmapPhaseInternal(dir, '1');
      info = getMilestoneInfo(dir);
    });
    assert.strictEqual(phase, null);
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 0, 'a missing ROADMAP.md must never be reported as unreadable');
  });

  test('a phase that is genuinely not in the roadmap stays silent', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    let result;
    const emitted = emissionsDuring(() => { result = getRoadmapPhaseInternal(dir, '7'); });
    assert.strictEqual(result, null);
    assert.strictEqual(emitted, 0);
  });

  test('roadmap content that parses to nothing stays silent', (t) => {
    // The parse is regex over text and cannot throw, so unparseable content never
    // reaches the catch. Content that yields nothing is absent information, not an
    // unusable file.
    _resetUnusableInputWarningsForTests();
    const dir = project(t, 'just prose, no headings at all\n');
    let phase, info;
    const emitted = emissionsDuring(() => {
      phase = getRoadmapPhaseInternal(dir, '1');
      info = getMilestoneInfo(dir);
    });
    assert.strictEqual(phase, null);
    assert.strictEqual(emitted, 0);
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNSCOPED },
      'no version token anywhere reachable — UNSCOPED, not a fabricated version');
  });

  test('an unreadable STATE.md alone stays silent — the inner catch is deliberate', (t) => {
    // roadmap-parser.cts:394-400 records under the #2245 audit that STATE.md's
    // `milestone:` field is an OPTIONAL enhancement whose failure legitimately falls
    // back to ROADMAP-only heuristics. A diagnostic leaking from it would misreport
    // that fallback as roadmap corruption.
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), 'milestone: v2.3\n');
    failReads(t, (p) => p.endsWith('STATE.md'), eacces());
    let info;
    const emitted = emissionsDuring(() => { info = getMilestoneInfo(dir); });
    assert.deepStrictEqual(info, { value: { version: 'v2.3', name: 'Alpha' }, scope: SCOPE.COMPLETE });
    assert.strictEqual(emitted, 0);
  });

  test('any errno is reported, not just EACCES', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    const eio = new Error('EIO: i/o error');
    eio.code = 'EIO';
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eio);
    const emitted = emissionsDuring(() => { getRoadmapPhaseInternal(dir, '1'); });
    assert.strictEqual(emitted, 1, 'the discriminator is "has an errno", not a whitelist');
  });

  test('an error carrying no errno stays silent — that is the absence path', (t) => {
    // platformReadSync returns null for ENOENT and the caller converts it to a
    // synthetic Error with no .code. That error means "absent", not "unusable".
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), new Error('missing'));
    let result;
    const emitted = emissionsDuring(() => { result = getRoadmapPhaseInternal(dir, '1'); });
    assert.strictEqual(result, null);
    assert.strictEqual(emitted, 0);
  });

  test('a non-string errno is tolerated and stays silent', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    const weird = new Error('odd');
    weird.code = 42;
    failReads(t, (p) => p.endsWith('ROADMAP.md'), weird);
    let result;
    const emitted = emissionsDuring(() => { result = getRoadmapPhaseInternal(dir, '1'); });
    assert.strictEqual(result, null);
    assert.strictEqual(emitted, 0);
  });

  test('both lookups against one unreadable roadmap report once', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eacces());
    const emitted = emissionsDuring(() => {
      getRoadmapPhaseInternal(dir, '1');
      getMilestoneInfo(dir);
    });
    assert.strictEqual(emitted, 1, 'it is one unreadable file');
  });

  test('a repeated lookup of the same unreadable roadmap reports once', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eacces());
    const emitted = emissionsDuring(() => {
      getRoadmapPhaseInternal(dir, '1');
      getRoadmapPhaseInternal(dir, '1');
    });
    assert.strictEqual(emitted, 1);
  });

  test('two different unreadable roadmaps both report', (t) => {
    _resetUnusableInputWarningsForTests();
    const a = project(t, HEALTHY);
    const b = project(t, HEALTHY);
    failReads(t, (p) => p.endsWith('ROADMAP.md'), eacces());
    const emitted = emissionsDuring(() => {
      getRoadmapPhaseInternal(a, '1');
      getRoadmapPhaseInternal(b, '1');
    });
    assert.strictEqual(emitted, 2, 'a second file must never be suppressed by the first');
  });

  test('getMilestoneInfo does not throw when the read fails', (t) => {
    // ADR-1411 names this explicitly: src/state.cts removed a defensive try/catch
    // around getMilestoneInfo under the #2245 audit because it "never throws".
    // Introducing a throw here silently breaks that invariant.
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, () => true, eacces());
    let info;
    emissionsDuring(() => {
      assert.doesNotThrow(() => { info = getMilestoneInfo(dir); });
    });
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNREADABLE });
  });

  test('getRoadmapPhaseInternal does not throw when the read fails', (t) => {
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    failReads(t, () => true, eacces());
    let result;
    emissionsDuring(() => {
      assert.doesNotThrow(() => { result = getRoadmapPhaseInternal(dir, '1'); });
    });
    assert.strictEqual(result, null);
  });

  test('neither lookup throws when the planning path itself cannot be resolved', (t) => {
    // The regression this pair exists to catch. planningDir throws a plain Error for an
    // invalid GSD_WORKSTREAM segment. Resolving it OUTSIDE the try -- which is what naming
    // the file for the diagnostic naively required -- let that escape uncaught, crashing
    // every caller of getMilestoneInfo for a workstream name containing a slash, and
    // breaking the invariant #2245 relies on. The earlier 'does not throw' cases inject
    // only through platformReadSync and so could never have caught it.
    _resetUnusableInputWarningsForTests();
    const dir = project(t, HEALTHY);
    const previous = process.env.GSD_WORKSTREAM;
    t.after(() => {
      if (previous === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = previous;
    });
    process.env.GSD_WORKSTREAM = 'evil/../thing';
    let info, phase;
    const emitted = emissionsDuring(() => {
      assert.doesNotThrow(() => { info = getMilestoneInfo(dir); });
      assert.doesNotThrow(() => { phase = getRoadmapPhaseInternal(dir, '1'); });
    });
    assert.deepStrictEqual(info, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(phase, null);
    assert.strictEqual(emitted, 0,
      'the path never resolved, so there is no file to name');
  });

  test('the roadmap reason is present in the frozen vocabulary', () => {
    // The full key-set lock lives once, in tests/unusable-input.test.cjs. Duplicating it
    // here would mean two files to update every time a phase adds a reason, which defeats
    // the point of a single coordinated change. This asserts only what #1881 owns.
    assert.ok(Object.isFrozen(UNUSABLE_REASON));
    assert.strictEqual(UNUSABLE_REASON.ROADMAP_UNREADABLE, 'roadmap_unreadable');
  });
});

// ─── #3577: markdown-table phase listings ────────────────────────────────────
// Self-contained block: a ROADMAP whose current-milestone phase listing is a
// GFM table (`| Phase | ... |` header, id in the first data cell) declared real
// phases that every enumeration surface reported as absent (phase_count: 0,
// found: false) — the #2199 bullet blind spot's table sibling. Surfaces: the
// lookup chain (get-phase/phase-op), scanMilestonePhaseIds (milestone filter +
// scope probe), hasPhaseEntries (window classification), and roadmap analyze's
// enumerator. The canonical RoadmapProgress table also leads with `Phase` —
// schema discrimination is load-bearing.
{
  const { describe: d3, test: t3, beforeEach: be3, afterEach: ae3 } = require('node:test');
  const a3 = require('node:assert/strict');
  const fs3 = require('node:fs');
  const path3 = require('node:path');
  const { createTempProject: ctp3, cleanup: cu3, runGsdTools: rgt3 } = require('./helpers.cjs');
  const rp3 = require('../gsd-core/bin/lib/roadmap-parser.cjs');
  const writeRoadmap3 = (d, c) => fs3.writeFileSync(path3.join(d, '.planning', 'ROADMAP.md'), c);

  const TABLE_ROADMAP = [
    '# Roadmap: Table Repro', '',
    '## Milestone v2.0', '',
    '| Phase | Focus | Requirements | Success criteria (preview) |',
    '| --- | --- | --- | --- |',
    '| 20 | Alpha focus | R1 | Works |',
    '| 21 | Beta focus | R2 | Works too |',
    '',
  ].join('\n');

  d3('#3577 markdown-table phase listings resolve across surfaces', () => {
    let tmpDir;
    be3(() => { tmpDir = ctp3('fix-3577-'); });
    ae3(() => { cu3(tmpDir); });

    t3('#3577: roadmap get-phase finds a table-declared phase', () => {
      writeRoadmap3(tmpDir, TABLE_ROADMAP);
      const p20 = rp3.getRoadmapPhaseInternal(tmpDir, '20');
      a3.ok(p20 && p20.found, 'phase 20 must resolve from its table row');
      a3.match(p20.phase_name, /Alpha focus/);
      const absent = rp3.getRoadmapPhaseInternal(tmpDir, '99');
      a3.ok(!absent || !absent.found, 'an absent phase must not resolve');
    });

    t3('#3577: init phase-op resolves a table-declared phase (third named tool)', () => {
      writeRoadmap3(tmpDir, TABLE_ROADMAP);
      const r = rgt3(['init', 'phase-op', '20'], tmpDir);
      a3.ok(r.success, `init phase-op failed: ${r.error}`);
      const out = JSON.parse(r.output);
      a3.ok(out.found !== false, `phase-op must resolve the table-declared phase; got ${r.output.slice(0, 200)}`);
    });

    t3('#3577: scanMilestonePhaseIds sees table-declared ids (milestone filter)', () => {
      writeRoadmap3(tmpDir, TABLE_ROADMAP);
      const scoped = rp3.extractCurrentMilestoneScoped(
        fs3.readFileSync(path3.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf8'),
        tmpDir,
      );
      // #612: pass the resolved convention explicitly. The public owner stays
      // a directly iterable Set; qualified bracket ids remain internal to the
      // milestone directory filter.
      const ids = rp3.scanMilestonePhaseIds(scoped.value, undefined);
      a3.ok(ids.has('20') || [...ids].some((i) => i.replace(/^0+/, '') === '20'), `ids must contain 20; got ${[...ids]}`);
      a3.ok(ids.has('21') || [...ids].some((i) => i.replace(/^0+/, '') === '21'), `ids must contain 21; got ${[...ids]}`);
    });

    t3('#3577: roadmap analyze counts table-declared phases', () => {
      writeRoadmap3(tmpDir, TABLE_ROADMAP);
      const r = rgt3(['roadmap', 'analyze', 'json'], tmpDir);
      a3.ok(r.success, `roadmap analyze json failed: ${r.error}`);
      const out = JSON.parse(r.output);
      a3.ok(Array.isArray(out.phases), `expected phases array; got ${r.output.slice(0, 200)}`);
      a3.strictEqual(out.phases.length, 2, `both table phases counted; got ${out.phases.length}`);
      a3.ok(out.phases.some((p) => /Alpha focus/.test(p.phase_name || p.name || '')), 'phase 20 named from column 2');
    });

    t3('#3577: the canonical progress table is not a phase listing; fenced examples excluded', () => {
      writeRoadmap3(tmpDir, [
        '# Roadmap', '', '## v1.0', '',
        '## Progress', '',
        '| Phase | Plans Complete | Status | Completed |',
        '| --- | --- | --- | --- |',
        '| 3 | 1/2 | In Progress | |',
        '',
        '```md',
        '| Phase | Focus |',
        '| --- | --- |',
        '| 77 | fenced example |',
        '```',
        '',
      ].join('\n'));
      const scoped = rp3.extractCurrentMilestoneScoped(
        fs3.readFileSync(path3.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf8'),
        tmpDir,
      );
      // #612: same explicit convention as the table-declared-ids test above.
      const ids = [...rp3.scanMilestonePhaseIds(scoped.value, undefined)].map((i) => i.replace(/^0+/, ''));
      a3.ok(!ids.includes('3'), `a RoadmapProgress row is a progress marker, not a declaration; got ${ids}`);
      a3.ok(!ids.includes('77'), `a fenced table example must not count; got ${ids}`);
      const p77 = rp3.getRoadmapPhaseInternal(tmpDir, '77');
      a3.ok(!p77 || !p77.found, 'a fenced table row must not resolve');
    });

    t3('#3577: heading and table declarations union without duplicates; decimals count, 999 excluded', () => {
      writeRoadmap3(tmpDir, [
        '# Roadmap', '', '## v1.0', '',
        '### Phase 1: Heading Form', '**Goal:** g', '',
        '| Phase | Focus |',
        '| --- | --- |',
        '| 1 | heading dup guard |',
        '| 2.5 | decimal row |',
        '| 999 | icebox row |',
        '',
      ].join('\n'));
      const r = rgt3(['roadmap', 'analyze', 'json'], tmpDir);
      a3.ok(r.success, `analyze failed: ${r.error}`);
      const out = JSON.parse(r.output);
      const nums = out.phases.map((p) => p.phase_number || p.number).sort();
      a3.ok(nums.includes('1'), 'heading phase present');
      a3.strictEqual(nums.filter((n) => n === '1' || n === '01').length, 1, `id declared in BOTH heading and table counts once; got ${nums}`);
      a3.ok(nums.some((n) => n.replace(/^0+/, '') === '2.5'), `decimal table id counted; got ${nums}`);
      a3.ok(!nums.some((n) => /^0*999/.test(n)), `icebox 999 excluded; got ${nums}`);
    });
  });
}
