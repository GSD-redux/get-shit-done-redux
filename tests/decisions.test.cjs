'use strict';

/**
 * decisions.test.cjs — regression tests for parseDecisions / extractDecisions
 *   and the check.decision-coverage-plan gate fail-loud behavior.
 *
 * Bug #1364: parseDecisions returns [] when decisions appear under markdown headers
 * (## Locked decisions / ## Implementation decisions) instead of a
 * <decisions>...</decisions> block. Also, em-dash bullets
 * '- **D-1 — title** body' are dropped as unparseable.
 *
 * Bug #1365: check.decision-coverage-plan silently returns passed:true when
 * CONTEXT.md is decision-shaped (has <decisions> block or D- tokens) but 0
 * decisions are extracted — gate now returns passed:false with format-mismatch
 * reason (could-not-parse outcome).
 *
 * Parser QA matrix (CONTRIBUTING.md 'Parser and project-file inputs'):
 *   - CRLF newlines
 *   - Unicode in a heading
 *   - Decisions-looking heading inside a fenced code block (must be ignored)
 *   - Both bullet forms: colon ('- **D-1:** ...') and em-dash ('- **D-1 — ...**')
 *   - Genuinely empty / no-decisions case (still [])
 *   - Pre-existing <decisions> block behaviour is unaffected (regression guard)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fc = require('./helpers/fast-check-setup.cjs');

const { parseDecisions, extractDecisions } = require('../gsd-core/bin/lib/decisions.cjs');
const { iterateBullets } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Regression #1364: markdown-header fallback ───────────────────────────────

describe('parseDecisions — markdown header fallback (#1364)', () => {
  test('extracts D-NN from ## Locked decisions header (em-dash bullets)', () => {
    const md = '## Locked decisions\n- **D-1 — a** x\n- **D-2 — b** y\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(
      ds.map(d => d.id),
      ['D-1', 'D-2'],
      'should extract D-1 and D-2 from em-dash bullets under markdown header'
    );
  });

  test('extracts D-NN from ## Implementation decisions header (colon bullets)', () => {
    const md = '## Implementation decisions\n- **D-01:** Use OAuth 2.0\n- **D-02:** Redis sessions\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01', 'D-02']);
    assert.strictEqual(ds[0].text, 'Use OAuth 2.0');
  });

  test('extracts D-NN from ### Decisions header (mixed bullets)', () => {
    const md = '### Decisions\n- **D-1:** colon form\n- **D-2 — em-dash form** body text\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1', 'D-2']);
  });

  test('extracts from header with case variation (## DECISIONS)', () => {
    const md = '## DECISIONS\n- **D-10:** uppercase heading\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-10']);
  });

  test('extracts from heading with Unicode in surrounding text (## \u{1F512} Locked decisions)', () => {
    // Unicode chars before "decisions" must not break the heading matcher.
    const md = '## \u{1F512} Locked decisions\n- **D-3 — unicode heading** value\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-3']);
  });

  test('CRLF newlines work for markdown-header path', () => {
    const md = '## Locked decisions\r\n- **D-5:** crlf bullet\r\n- **D-6 — em dash** crlf em\r\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-5', 'D-6']);
  });

  test('decisions-looking heading inside a fenced code block is ignored', () => {
    const md = [
      '```',
      '## Locked decisions',
      '- **D-99:** fake',
      '```',
      '',
      '## Real decisions',
      '- **D-1:** real',
    ].join('\n');
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
  });

  test('generic prose heading does not produce false positives', () => {
    const md = '## Context\n- some bullet\n\n## Architecture\n- another bullet\n';
    assert.deepStrictEqual(parseDecisions(md), []);
  });

  test('no decisions anywhere returns [] (no false positives)', () => {
    assert.deepStrictEqual(parseDecisions('## Locked decisions\n\nNo bullets here.\n'), []);
  });

  test('content with no decisions heading and no block returns []', () => {
    assert.deepStrictEqual(parseDecisions('# Just a title\nsome prose\n'), []);
  });
});

// ─── Regression #1364: em-dash bullet inside existing <decisions> block ───────

describe('parseDecisions — em-dash bullet form inside <decisions> block (#1364)', () => {
  test('em-dash bullet is parsed inside a <decisions> block', () => {
    const md = '<decisions>\n- **D-1 — my title** body text\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
    assert.ok(ds[0].text.length > 0, 'text must not be empty');
  });

  test('em-dash bullet with alphanumeric ID is parsed', () => {
    const md = '<decisions>\n- **D-INFRA-01 — infra decision** body\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-INFRA-01']);
  });
});

// ─── Regression guard: pre-existing <decisions> block behaviour unchanged ─────

describe('parseDecisions — existing <decisions> block still works (#1364 guard)', () => {
  test('colon form inside <decisions> block still parses', () => {
    const md = '<decisions>\n- **D-1:** colon form\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
    assert.strictEqual(ds[0].text, 'colon form');
  });

  test('multiple D-NN in block with categories still works', () => {
    const md = `<decisions>\n### Auth\n- **D-01:** OAuth\n### Storage\n- **D-02:** Postgres\n</decisions>\n`;
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01', 'D-02']);
    assert.strictEqual(ds[0].category, 'Auth');
  });

  test('D-IDs outside the block are still ignored when a block is present', () => {
    const md = '- **D-99:** outside\n<decisions>\n- **D-01:** inside\n</decisions>\n- **D-77:** after\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('empty / null / undefined still return []', () => {
    assert.deepStrictEqual(parseDecisions(''), []);
    assert.deepStrictEqual(parseDecisions(null), []);
    assert.deepStrictEqual(parseDecisions(undefined), []);
  });
});

// ─── extractDecisions outcome: 'none-present' and 'could-not-parse' ──────────

describe('extractDecisions — typed outcome (#1364 + #1365)', () => {
  test('returns outcome:parsed with decisions array when block present', () => {
    const md = '<decisions>\n- **D-1:** OAuth 2.0\n</decisions>\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed');
    assert.strictEqual(result.decisions.length, 1);
    assert.strictEqual(result.decisions[0].id, 'D-1');
  });

  test('returns outcome:parsed for markdown-header path', () => {
    const md = '## Locked decisions\n- **D-2:** use Redis\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed');
    assert.strictEqual(result.decisions.length, 1);
  });

  test('returns outcome:none-present for genuinely empty content', () => {
    const result = extractDecisions('# Just a title\nsome prose without decisions\n');
    assert.strictEqual(result.outcome, 'none-present');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:none-present for empty string', () => {
    const result = extractDecisions('');
    assert.strictEqual(result.outcome, 'none-present');
  });

  test('returns outcome:could-not-parse when <decisions> block present but yields 0 decisions', () => {
    // A <decisions> block with no parseable bullets is decision-shaped
    const md = '<decisions>\n\nJust prose, no D-NN bullets\n\n</decisions>\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:could-not-parse when D- token present but no parseable decisions', () => {
    // Content references D-01 in prose but it's malformed — not in a parseable bullet
    const md = '# Context\n\nSee also D-01 for background. No block, no heading.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:could-not-parse when /decisions?/i heading present but 0 decisions extracted', () => {
    // Header present but no actual D-NN bullets under it
    const md = '## Locked decisions\n\nNo D-NN bullets here, just prose.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:none-present for generic prose with no decision signals', () => {
    // No block, no /decisions?/i heading, no \bD- token — genuinely no decisions
    const md = '## Context\n\nSome architecture notes.\n\n## Goals\n\nBe fast.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'none-present');
  });

  test('parseDecisions delegates correctly (thin wrapper)', () => {
    // parseDecisions is a thin delegate that returns extractDecisions().decisions
    const md = '<decisions>\n- **D-1:** foo\n</decisions>\n';
    const fromExtract = extractDecisions(md).decisions;
    const fromParse = parseDecisions(md);
    assert.deepStrictEqual(fromParse, fromExtract);
  });
});

// ─── #2347: evidence test must not reuse the parser's own D- grammar ──────────
// #1365's fail-loud guard used `/\bD-[A-Za-z0-9]/` as its "is this decision-
// shaped?" evidence test — the SAME D- prefix the parser requires. So for any
// ID prefix the parser can't read (e.g. `D5-01`), BOTH the parser and the guard
// see nothing, the outcome collapses to none-present (clean pass) instead of
// could-not-parse, and the gate fails OPEN against a populated block of real
// decisions. Fix: a bold-lead-in bullet (`- **...**`, any ID) is format-agnostic
// evidence of a decision entry. Note none of these bullet texts contain a
// literal "D-" token, so they isolate the bold-bullet evidence from the old
// D--token path.
describe('extractDecisions — format-agnostic evidence test (#2347)', () => {
  // #4130 note: this fixture originally used the D5-NN phase-prefixed shape
  // from #2347's own reproduction. #4130 made the digit-run phase prefix LEGAL
  // (see the #4130 blocks below — D5-01 now parses), so the "prefix the parser
  // cannot read" fixture here uses a DEC-NN multi-letter prefix instead: still
  // an ID-shaped bold lead-in, still outside the parser's D-prefixed universe,
  // so the fail-loud contract this describe-block pins is unchanged.
  test('populated <decisions> block with a non-D- ID prefix is could-not-parse, not none-present', () => {
    const md = '<decisions>\n'
      + '- **DEC-01:** choose the primary datastore\n'
      + '- **DEC-02:** pick the queue technology\n'
      + '- **DEC-03:** settle on the auth model\n'
      + '</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.decisions.length, 0, 'parser cannot read the DEC- prefix (0 extracted)');
    assert.strictEqual(r.outcome, 'could-not-parse',
      'a populated block the parser cannot read must FAIL LOUD, not pass as none-present');
  });

  test('decisions HEADING section with a non-D- ID prefix is could-not-parse', () => {
    const md = '## Decisions\n\n- **DEC-01: the chosen approach** rationale\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.decisions.length, 0);
    assert.strictEqual(r.outcome, 'could-not-parse',
      'a decision-shaped heading section the parser cannot read must fail loud');
  });

  test('em-dash bullet with a non-D- ID prefix is still evidence (could-not-parse)', () => {
    const md = '<decisions>\n- **DEC-02 — the chosen approach** body\n</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'could-not-parse');
  });

  // ── Regression guards: the broadened evidence must NOT create false fail-loud ─
  test('empty <decisions> scaffold stays none-present (no false fail-loud)', () => {
    assert.strictEqual(extractDecisions('<decisions>\n</decisions>\n').outcome, 'none-present');
    assert.strictEqual(
      extractDecisions('<decisions>\n\n(no decisions this phase)\n\n</decisions>\n').outcome,
      'none-present',
      'a prose-only scaffold with no bold-lead-in bullet must still pass cleanly');
  });

  test('an all-prose decisions block with no bold bullet stays none-present', () => {
    const md = '<decisions>\n\nThis phase inherits every prior decision; nothing new.\n\n</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present');
  });

  test('canonical D- decisions still parse (no regression)', () => {
    const md = '<decisions>\n- **D-01:** a real decision\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.strictEqual(r.decisions.length, 1);
  });

  // ── The evidence must be ID-SHAPED, not "any bold bullet" ────────────────────
  // A decisions block / discretion section legitimately uses bold LABELS on prose
  // bullets (- **Why:** …, - **Scope:** …). Those are not decision entries; a
  // false could-not-parse here hard-blocks the plan gate. Guards against the
  // over-broad evidence regex an earlier iteration shipped.
  test('bold prose-label bullets (Why/Note/Scope) are NOT evidence — stay none-present', () => {
    const md = '<decisions>\n'
      + '- **Why:** rationale for inheriting prior decisions\n'
      + '- **Scope:** everything from the previous phase carries over\n'
      + '- **Note:** nothing new was decided here\n'
      + '</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present',
      'bold LABELS on prose bullets must not be mistaken for decision entries');
  });

  test("a Claude's Discretion sub-section with bold-label bullets stays none-present", () => {
    const md = '<decisions>\n'
      + "### Claude's Discretion\n"
      + '- **Scope:** left to judgment, no specific preference\n'
      + '- **Follow-up:** revisit if performance regresses\n'
      + '</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present',
      'a discretion section of bold-label prose bullets must pass the gate cleanly');
  });

  test('a bold ALL-CAPS label with no id-shape (TODO/NOTE) is not evidence', () => {
    const md = '<decisions>\n- **TODO:** decide the datastore next phase\n- **NOTE:** blocked on infra\n</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present',
      'a bold ALL-CAPS label with no -<alnum> id structure is not a decision entry');
  });

  test('heading path: bold prose-label bullets under a Decisions heading stay none-present', () => {
    const md = '## Decisions\n\n- **Why:** we kept the prior stack\n- **Scope:** no new choices this phase\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present');
  });
});

// ─── QA matrix for parser correctness ────────────────────────────────────────

describe('parseDecisions — parser QA matrix', () => {
  test('### category headings inside a decisions block set category', () => {
    const md = '<decisions>\n### Auth\n- **D-01:** OAuth 2.0\n### Storage\n- **D-02:** Postgres\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].category, 'Auth');
    assert.strictEqual(ds[1].category, 'Storage');
  });

  test("### Claude's Discretion section sets trackable:false", () => {
    const md = "<decisions>\n### Claude's Discretion\n- **D-01:** internal\n</decisions>";
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('[informational] tag sets trackable:false', () => {
    const md = '<decisions>\n- **D-01 [informational]:** ref only\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('[deferred] tag sets trackable:false', () => {
    const md = '<decisions>\n- **D-01 [deferred]:** not yet\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('continuation lines append to text (tab-indented)', () => {
    const md = '<decisions>\n- **D-01:** first line\n\tcontinued here\n</decisions>';
    const ds = parseDecisions(md);
    assert.ok(ds[0].text.includes('first line'), 'must include first line');
    assert.ok(ds[0].text.includes('continued here'), 'must include continuation');
  });

  test('CRLF inside a <decisions> block still parses', () => {
    const md = '<decisions>\r\n- **D-01:** crlf decision\r\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('fenced code block inside document does not pollute decisions', () => {
    const md = [
      '```',
      '<decisions>',
      '- **D-99:** fake in fence',
      '</decisions>',
      '```',
      '',
      '<decisions>',
      '- **D-01:** real',
      '</decisions>',
    ].join('\n');
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('alphanumeric IDs (D-INFRA-01) are accepted', () => {
    const md = '<decisions>\n- **D-INFRA-01:** infra call\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-INFRA-01']);
  });

  test('em-dash bullet form with tags still sets tags', () => {
    const md = '<decisions>\n- **D-01 [informational] — title** body\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
    assert.ok(ds[0].tags.includes('informational'));
  });
});

// ─── #1365: fail-loud gate — check.decision-coverage-plan ────────────────────

/**
 * Gate-level tests for the could-not-parse fail-loud behavior (#1365).
 * These exercise cmdDecisionCoveragePlan via the real CLI (check decision-coverage-plan).
 *
 * Naming: check.decision-coverage-plan is invoked as `query check.decision-coverage-plan`.
 * The gate lives in check-command-router.cts; outcome flows from decisions.cts extractDecisions.
 */

function writeContextFile(phaseDir, content) {
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), content);
}

function writePlanFile(phaseDir, name, body) {
  fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
}

function writePlanningConfig(planningDir, config) {
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config));
}

function runDecisionCoveragePlan(phaseDir, contextPath, cwd) {
  return runGsdTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath], cwd);
}

describe('check.decision-coverage-plan — fail-loud on could-not-parse (#1365)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1365-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('decision-shaped CONTEXT.md with <decisions> block but 0 parseable decisions → passed:false (not silent skip)', () => {
    // #1365 bug: gate used to return passed:true/skipped for this case.
    writeContextFile(phaseDir, [
      '# Phase 1',
      '',
      '<decisions>',
      '',
      'See the ADR for architecture choices. No D-NN bullets here.',
      '',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Objective\nImplement feature.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, false,
      `Gate must return passed:false for decision-shaped but 0-extracted content. Got: ${JSON.stringify(parsed)}`);
    const msg = (parsed.message || parsed.reason || '').toLowerCase();
    assert.ok(
      msg.includes('format') || msg.includes('mismatch') || msg.includes('could not parse') || msg.includes('parse'),
      `Message must mention format mismatch or parsing issue. Got: "${parsed.message}"`
    );
  });

  test('CONTEXT.md with \\bD- token in prose but no parseable decisions → passed:false', () => {
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      'See D-01 for the authentication decision and D-02 for storage.',
      'These are just prose references, not structured decisions.',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\nRef D-01.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, false,
      `Gate must return passed:false for D-token-but-no-parseable content. Got: ${JSON.stringify(parsed)}`);
  });

  test('genuinely empty CONTEXT.md (no decision signals) → passed:true/skipped (no false alarm)', () => {
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      '## Goals',
      'Build the feature.',
      '',
      '## Architecture',
      'Use Node.js and TypeScript.',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\nImplement the feature.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Gate must NOT false-alarm on genuinely empty content. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, true,
      `Gate must skip when there are no decisions. Got: ${JSON.stringify(parsed)}`);
  });

  test('well-formed CONTEXT.md with real decisions all covered → passed:true (normal case)', () => {
    writeContextFile(phaseDir, [
      '# Context',
      '',
      '<decisions>',
      '### Implementation',
      '- **D-01:** Use OAuth 2.0 for authentication',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D-01: Implement OAuth 2.0\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Real decisions covered → must pass. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, false);
  });

  test('well-formed CONTEXT.md with decisions heading (markdown-header) all covered → passed:true', () => {
    // After #1364 fix: markdown-header decisions are now extractable and coverable
    writeContextFile(phaseDir, [
      '# Context',
      '',
      '## Implementation decisions',
      '',
      '- **D-01:** Use Redis for caching',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D-01: Implement Redis caching\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Markdown-header decisions covered → must pass. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, false);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 1);
  });

  test('CONTEXT.md missing → passed:true/skipped (unchanged behavior)', () => {
    const contextPath = path.join(phaseDir, 'NONEXISTENT-CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, true);
  });

  test('gate disabled by config → passed:true/skipped (unchanged behavior)', () => {
    writeContextFile(phaseDir, '<decisions>\nNo D-NN bullets\n</decisions>');
    writePlanningConfig(planningDir, { workflow: { context_coverage_gate: false } });

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, true);
  });
});

describe('check.decision-coverage-plan — boundary/threshold tests (#1365)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1365-bva-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('exactly 1 decision extracted (limit == 1) → not could-not-parse', () => {
    writeContextFile(phaseDir, '<decisions>\n- **D-01:** single decision\n</decisions>');
    writePlanFile(phaseDir, '01', '# Plan\n## Objective\nRef D-01.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, false);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 1);
  });

  test('FIX A: empty <decisions></decisions> scaffold (limit - 1 == 0, no D- token) → none-present → passed:true/skipped (NOT blocked)', () => {
    // FIX A: An empty scaffold has no D- tokens → none-present, gate passes.
    // REGRESSION: previously returned could-not-parse → passed:false, blocking legitimate phases.
    writeContextFile(phaseDir, '<decisions>\n\n</decisions>');
    writePlanFile(phaseDir, '01', '# Plan\nSome plan.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, true,
      `Empty scaffold → none-present → passed:true. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, true,
      `Empty scaffold → none-present → skipped:true. Got: ${JSON.stringify(parsed)}`);
  });

  test('FIX A: <decisions> block with D- token in prose (not a bullet) → could-not-parse → passed:false', () => {
    // If the block contains a D- token but not as a parseable bullet → could-not-parse
    writeContextFile(phaseDir, '<decisions>\nD-01 is mentioned in prose but not as a bullet.\n</decisions>');
    writePlanFile(phaseDir, '01', '# Plan\nSome plan.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, false,
      `D-token-in-prose → could-not-parse → passed:false. Got: ${JSON.stringify(parsed)}`);
  });
});

// ─── FIX A regressions: tighten could-not-parse (empty scaffold / none-present) ───

describe('FIX A: tighten could-not-parse — empty scaffolds must not block (#1372)', () => {
  test('empty <decisions></decisions> scaffold → none-present (gate clean)', () => {
    // REGRESSION: previously returned could-not-parse, blocking legitimate phases
    const result = extractDecisions('<decisions></decisions>');
    assert.strictEqual(result.outcome, 'none-present',
      `Empty scaffold must be none-present. Got: ${result.outcome}`);
    assert.deepStrictEqual(result.decisions, []);
  });

  test('## Decisions heading with prose only, no D- bullets → none-present', () => {
    // A heading with only prose and no D- tokens is not decision-shaped
    const md = '## Decisions\n\nArchitecture is handled via ADR-001.\n\nSee docs.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'none-present',
      `Prose-only decisions heading must be none-present. Got: ${result.outcome}`);
  });

  test('all-discretion block (### Claude’s Discretion, no D- bullets) → none-present', () => {
    // An all-discretion block with no D- tokens is a legitimate empty context
    const curlySingle = '’';
    const md = '<decisions>\n### Claude' + curlySingle + 's Discretion\n\nAll implementation details left to Claude.\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'none-present',
      `All-discretion block with no D- bullets must be none-present. Got: ${result.outcome}`);
  });

  test('<decisions> block with D- token in prose (not bullet) → still could-not-parse', () => {
    // A D- token that is NOT in a parseable bullet format still signals format mismatch
    const md = '<decisions>\nSee D-01 for the decision.\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `D-token in block prose must be could-not-parse. Got: ${result.outcome}`);
  });
});

// ─── FIX B regressions: parse-miss must fail loud ────────────────────────────

describe('FIX B: parse-miss on malformed D-NN bullet → could-not-parse (#1372)', () => {
  test('valid D-01 + malformed D-02 bullet → outcome could-not-parse (not silent pass)', () => {
    // REGRESSION: previously returned outcome:parsed (silently dropped D-02)
    const md = '<decisions>\n- **D-01:** Use OAuth 2.0\n- **D-02 malformed no colon or dash** text\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `Mixed valid+malformed must be could-not-parse. Got: ${result.outcome}`);
  });

  test('valid D-01 + malformed D-02 bullet → gate passed:false (not silent skip)', () => {
    // Gate-level regression: a parse-miss must propagate as passed:false
    // Uses extractDecisions directly to confirm gate-layer behavior
    const md = '<decisions>\n- **D-01:** Use OAuth 2.0\n- **D-02 malformed no colon or dash** text\n</decisions>';
    const result = extractDecisions(md);
    // The check-command-router uses outcome === 'could-not-parse' && decisions.length where
    // trackable.length === 0 → passed:false. Confirm outcome propagates correctly.
    assert.strictEqual(result.outcome, 'could-not-parse');
    // D-01 was parsed (it was valid); the result still contains it for context
    // but the overall outcome is could-not-parse because of the parse-miss on D-02.
    assert.ok(result.decisions.some(d => d.id === 'D-01'),
      `D-01 (valid) must still be in decisions. Got: ${JSON.stringify(result.decisions)}`);
  });

  test('only malformed D-NN bullet (no valid ones) → could-not-parse', () => {
    const md = '<decisions>\n- **D-01 no colon no dash here** just text\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `Only-malformed-bullet must be could-not-parse. Got: ${result.outcome}`);
  });
});

// ─── FIX B gate-level: parse-miss silently swallowed when covered decision exists ─

describe('FIX B gate-level: parse-miss → passed:false regardless of covered decisions (#1365)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1365-fixb-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('FAIL-FIRST: valid D-01 covered + malformed D-02 → gate must return passed:false (parse-miss wins)', () => {
    // CONTEXT.md: D-01 is valid colon-form; D-02 has no colon and no em-dash → parse-miss
    // PLAN.md: covers D-01 via ## Must Haves so coverage of D-01 would pass on its own.
    // Before fix: decisions.length === 1 (D-01), outcome === 'could-not-parse' →
    //   guard `decisions.length === 0 && outcome === 'could-not-parse'` is FALSE →
    //   gate proceeds to coverage → D-01 is covered → passed:true  [BUG]
    // After fix: outcome === 'could-not-parse' fires regardless of decisions.length →
    //   gate returns passed:false with reason:'could-not-parse'     [CORRECT]
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      '<decisions>',
      '### Implementation',
      '- **D-01:** use JWT tokens',
      '- **D-02** ratio 3:1',
      '</decisions>',
    ].join('\n'));
    // D-02 bullet has no colon and no em-dash → parse-miss → outcome:'could-not-parse'
    // but D-01 is in decisions with trackable:true

    // Plan covers D-01 explicitly via ## Must Haves (DESIGNATED_HEADINGS_RE match)
    writePlanFile(phaseDir, '01', [
      '# Plan',
      '',
      '## Must Haves',
      '',
      '- D-01: implement JWT token issuance and validation',
    ].join('\n'));

    // Pre-check: confirm extractDecisions outcome so we know what the gate is receiving
    const extraction = extractDecisions([
      '<decisions>',
      '### Implementation',
      '- **D-01:** use JWT tokens',
      '- **D-02** ratio 3:1',
      '</decisions>',
    ].join('\n'));
    assert.strictEqual(extraction.outcome, 'could-not-parse',
      `Pre-check: extractDecisions must return could-not-parse. Got: ${extraction.outcome}`);
    assert.ok(extraction.decisions.some(d => d.id === 'D-01'),
      `Pre-check: D-01 must be in decisions (coverage would pass for D-01 alone). Got: ${JSON.stringify(extraction.decisions)}`);
    assert.strictEqual(extraction.decisions.filter(d => d.trackable).length, 1,
      'Pre-check: exactly 1 trackable decision (D-01) — confirms decisions.length === 1 path');

    // Gate call: with the old guard `decisions.length === 0 && outcome === 'could-not-parse'`
    // this would be skipped (length is 1) and coverage would find D-01 covered → passed:true.
    // With the fix this must return passed:false.
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, false,
      `Gate must return passed:false when parse-miss present, even if covered decisions exist. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.reason, 'could-not-parse',
      `Gate must report reason:'could-not-parse'. Got: ${JSON.stringify(parsed)}`);
    // Message must indicate a format/parse problem (not a coverage gap on D-01)
    const msg = (parsed.message || '').toLowerCase();
    assert.ok(
      msg.includes('could not') || msg.includes('format') || msg.includes('mismatch') || msg.includes('parse'),
      `Message must indicate parse/format issue, not D-01 coverage gap. Got: "${parsed.message}"`
    );
    // Confirm D-01 is NOT in uncovered[] — the failure is parse-miss, not a coverage gap
    assert.deepStrictEqual(parsed.uncovered, [],
      `uncovered must be empty (D-01 is covered; failure is parse-miss). Got: ${JSON.stringify(parsed.uncovered)}`);
  });

  test('verify-side: valid D-01 covered + malformed D-02 → verify advisory surfaces could-not-parse', () => {
    // Same scenario but via decision-coverage-verify (non-blocking advisory)
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      '<decisions>',
      '- **D-01:** use JWT tokens',
      '- **D-02** ratio 3:1',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n\n## Must Haves\n\n- D-01: implement JWT\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runGsdTools(
      ['query', 'check.decision-coverage-verify', phaseDir, contextPath],
      tmpDir
    );
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.reason, 'could-not-parse',
      `Verify must surface could-not-parse reason. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.blocking, false,
      `Verify is always non-blocking. Got: ${JSON.stringify(parsed)}`);
  });
});

// ─── #3169: nested cross-reference bullet must not zero out coverage (#3212 Phase 3) ─
//
// parseDecisionLines' parse-miss guard fires on any line whose bold run starts
// with `D-`, including a cross-reference bullet NESTED (deeper-indented) under
// an already-open decision — e.g. a decision's own body elaborating on how it
// relates to a sibling decision. A single such miss forces the whole extraction
// to `could-not-parse`, discarding every decision that DID parse correctly.
//
// Fix (design doc §1.3): track the indent width of the currently-open decision's
// bullet. A subsequent bulleted line indented DEEPER than that is nested content
// under the open decision (append to its text, like a continuation line) rather
// than a fresh declaration attempt — never tested against the parse-miss guard.
// A bullet at the same-or-shallower indent is unchanged (still tested normally),
// which is what keeps the existing FIX-B fixtures (`D-02`, "no colon no dash")
// still failing as genuine misses — see rows 21-22 below.

describe('#3169: nested cross-reference bullet does not increment parseMisses', () => {
  test('FAIL-FIRST row 18: a bullet nested under an open decision is elaboration, not a fresh declaration attempt', () => {
    const md = [
      '<decisions>',
      "- **D-15:** some decision",
      "  - **D-06's fix does not close this.** Gating the Passed arm on the derived status passes cleanly here.",
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `Nested cross-reference must not force could-not-parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-15'],
      `Only D-15 should be extracted as a decision — the nested bullet is elaboration, not a second entry. Got: ${JSON.stringify(result.decisions.map((d) => d.id))}`);
    assert.ok(
      result.decisions[0].text.includes("D-06's fix does not close this"),
      `The nested bullet's text should be folded into D-15's own text (continuation-style). Got: ${JSON.stringify(result.decisions[0].text)}`,
    );
  });

  test('FAIL-FIRST row 19: a second nested bullet under the same open decision is also elaboration', () => {
    const md = [
      '<decisions>',
      "- **D-15:** some decision",
      "  - **D-06's fix does not close this.** first note.",
      '  - **D-13 (999.76) must not land without this fix.** second note.',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `Two nested cross-references must not force could-not-parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-15']);
  });

  test('FAIL-FIRST row 20: end-to-end — /gsd-plan-phase §13a gate reports full coverage with nested cross-reference bullets present', () => {
    const tmpDir = createTempProject('gsd-3169-');
    const planningDir = path.join(tmpDir, '.planning');
    const phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
    try {
      // Compact 3-decision analog of the issue's 15-decision repro: D-03 carries
      // the same nested-cross-reference shape that zeroed coverage in the report.
      writeContextFile(phaseDir, [
        '<decisions>',
        '- **D-01:** use JWT tokens',
        '- **D-02:** use Redis sessions',
        '- **D-03:** derive status from the Passed arm',
        "  - **D-01's token choice does not close this.** Criterion 3 and criterion 4 are separate deliverables.",
        '  - **D-02 (session store) must not land without this fix.** Moving discovery to the execution root makes this common.',
        '</decisions>',
      ].join('\n'));
      writePlanFile(phaseDir, '01', [
        '# Plan',
        '',
        '## Must Haves',
        '',
        '- D-01: implement JWT token issuance and validation',
        '- D-02: wire Redis session storage',
        '- D-03: derive status from the Passed arm',
      ].join('\n'));

      const contextPath = path.join(phaseDir, 'CONTEXT.md');
      const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
      const parsed = JSON.parse(result.output || '');
      assert.strictEqual(parsed.passed, true,
        `Gate must pass — all 3 decisions are covered and the nested bullets are not parse-misses. Got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.total, 3, `Got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.covered, 3,
        `Must report 3/3 covered, not the false 0/3 #3169 reports today. Got: ${JSON.stringify(parsed)}`);
      assert.deepStrictEqual(parsed.uncovered, [], `Got: ${JSON.stringify(parsed)}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('row 21 (negative control, disproven-design record): a top-level malformed bullet with no open decision above it still forces could-not-parse', () => {
    // This is tests/decisions.test.cjs's OWN existing FIX-B fixture (line ~651/709),
    // re-asserted here to record it as the case that disproved an earlier
    // bold-run-content-classification design for #3169 (design doc §1.3) — a
    // content-only rule cannot distinguish this from the #3169 cross-reference
    // shape above; indentation (0, nothing open to nest under) is what does.
    const md = '<decisions>\n- **D-01:** Use OAuth 2.0\n- **D-02** ratio 3:1\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A standalone top-level malformed bullet must still be a genuine miss. Got: ${JSON.stringify(result)}`);
  });

  test('row 22: another standalone top-level malformed bullet still forces could-not-parse', () => {
    const md = '<decisions>\n- **D-01 no colon no dash here** just text\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `Got: ${JSON.stringify(result)}`);
  });

  test('row 23: a bullet indented as if nested, but with no decision open above it, falls through to normal handling', () => {
    // No `current` is open when this line is reached, so the nesting check
    // cannot apply (there is nothing to nest under) — it must be tested as an
    // ordinary top-level bullet, exactly as before this fix.
    const md = '<decisions>\n  - **D-01** malformed, nothing open above it\n</decisions>';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A leading indented bullet with nothing open above it must still be tested normally. Got: ${JSON.stringify(result)}`);
  });
});

// ─── FIX C regressions: curly-quote Claude's Discretion ───────────────────────

describe('FIX C: curly-quote Claude’s Discretion → trackable:false (#1372)', () => {
  test('### Claude’s Discretion (U+2019 curly apostrophe) sets trackable:false', () => {
    // REGRESSION: curly apostrophe was not stripped from category, so
    // "claudes discretion" key was not in DISCRETION_HEADINGS → trackable:true
    const curlySingle = '’';
    const md = '<decisions>\n### Claude' + curlySingle + 's Discretion\n- **D-01:** internal decision\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1, 'one decision must be parsed');
    assert.strictEqual(ds[0].trackable, false,
      `Curly-apostrophe discretion heading must yield trackable:false. Got trackable:${ds[0].trackable}`);
  });

  test('### Claude‘s Discretion (U+2018 opening quote) sets trackable:false', () => {
    const openSingle = '‘';
    const md = '<decisions>\n### Claude' + openSingle + 's Discretion\n- **D-01:** internal decision\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].trackable, false,
      `Open-single-quote discretion heading must yield trackable:false. Got trackable:${ds[0].trackable}`);
  });

  test('[folded] tag sets trackable:false (coverage gap fix)', () => {
    // Previously NON_TRACKABLE_TAGS included 'folded' but had no dedicated test
    const md = '<decisions>\n- **D-01 [folded]:** folded decision\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].trackable, false,
      `[folded] tag must yield trackable:false. Got trackable:${ds[0].trackable}`);
    assert.ok(ds[0].tags.includes('folded'), 'tags must include "folded"');
  });
});

// ─── FIX D regressions: gap-checker surfaces decision parse failure independently ─

describe('FIX D: gap-checker surfaces decision could-not-parse even when requirements exist (#1372)', () => {
  const { runGapAnalysis } = require('../gsd-core/bin/lib/gap-checker.cjs');

  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1372-fixd-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({}));
  });

  afterEach(() => cleanup(tmpDir));

  test('REQUIREMENTS.md with 1 req + unparseable CONTEXT.md → gap report includes format-mismatch signal', () => {
    // REGRESSION: previously the could-not-parse signal was silently masked
    // inside `if (items.length === 0)` — when requirements existed, it never fired.
    const reqPath = path.join(planningDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '- [ ] **REQ-01** Some requirement\n');

    const ctxMd = '<decisions>\nSome prose about decisions but no D-NN bullets.\n</decisions>\n';
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), ctxMd);
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '# Plan\nREQ-01 is covered here.\n');

    const result = runGapAnalysis(tmpDir, phaseDir);
    assert.ok(
      result.summary.includes('format mismatch') || result.summary.includes('possible format'),
      `Summary must mention format mismatch. Got: "${result.summary}"`
    );
    assert.ok(
      result.table.includes('format mismatch') || result.table.includes('possible format'),
      `Table must include format mismatch note. Got: "${result.table}"`
    );
  });

  test('no REQUIREMENTS.md + unparseable CONTEXT.md → gap report includes format-mismatch signal', () => {
    // Pre-existing behavior (items.length === 0 path) must still work
    const ctxMd = '<decisions>\nSome prose about decisions but no D-NN bullets.\n</decisions>\n';
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), ctxMd);
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '# Plan\nSome plan.\n');

    const result = runGapAnalysis(tmpDir, phaseDir);
    assert.ok(
      result.summary.includes('format mismatch') || result.summary.includes('possible format'),
      `Summary must mention format mismatch. Got: "${result.summary}"`
    );
  });

  test('REQUIREMENTS.md with 1 req + valid CONTEXT.md → no mismatch signal (clean path)', () => {
    // Ensure the fix does not introduce false positives on valid input
    const reqPath = path.join(planningDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '- [ ] **REQ-01** Some requirement\n');

    const ctxMd = '<decisions>\n- **D-01:** Use OAuth 2.0\n</decisions>\n';
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), ctxMd);
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '# Plan\nREQ-01 is covered. D-01 is covered.\n');

    const result = runGapAnalysis(tmpDir, phaseDir);
    assert.ok(
      !result.summary.includes('format mismatch') && !result.summary.includes('possible format'),
      `Valid input must NOT show format mismatch. Got: "${result.summary}"`
    );
  });
});

// ─── Regression #1639: titled-colon bullet form '- **D-NN: Title.** body' ─────
// Both bulletColonRe (':**' anchor) and bulletEmDashRe (em-dash) miss the form where a
// title sits between the colon and the closing **, so it was dropped by the parse-miss
// guard and check.decision-coverage-plan passed vacuously when all decisions were titled.
describe('parseDecisions — titled-colon bullet form (#1639)', () => {
  test('titled-colon bullet is parsed, not dropped', () => {
    const md = '## Locked decisions\n- **D-01: Default sandbox ON.** body\n- **D-02: Reject unsigned.** body two\n';
    const out = parseDecisions(md);
    assert.equal(out.length, 2, 'should extract both titled-colon decisions (not 0)');
    assert.equal(out[0].id, 'D-01');
    assert.equal(out[1].id, 'D-02');
  });

  test('titled-colon coexists with colon-immediate and em-dash forms', () => {
    const md = '## Locked decisions\n- **D-01:** plain colon\n- **D-02 — emdash** body\n- **D-03: Titled.** body\n';
    const out = parseDecisions(md);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((d) => d.id), ['D-01', 'D-02', 'D-03']);
  });

  test('titled-colon with [tags] still parses id and tags', () => {
    const md = '## Locked decisions\n- **D-01 [informational]: Title.** body\n';
    const out = parseDecisions(md);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'D-01');
    assert.ok(out[0].tags.includes('informational'), `tags should include informational, got ${JSON.stringify(out[0].tags)}`);
  });

  test('all-titled CONTEXT.md parses every decision (no vacuous 0)', () => {
    // The reporter case: 13 decisions all titled → previously all dropped → gate passed vacuously.
    let md = '## Locked decisions\n';
    for (let i = 1; i <= 13; i++) md += `- **D-${String(i).padStart(2, '0')}: Decision ${i}.** body\n`;
    const out = parseDecisions(md);
    assert.equal(out.length, 13, 'all 13 titled-colon decisions must parse (not vacuously 0)');
  });
});

// ─── #2372: decision-coverage-plan must scan planner-canonical tag bodies ─────
//
// Bug: buildPlanMessage() told the user to cite decisions "(or body)" but
// extractPlanDesignatedSections() only scanned <objective>/<tasks>/<task>/<action>.
// A decision cited in <read_first>, <behavior>, <verify>, <acceptance_criteria>,
// or <done> was invisible — false BLOCKING coverage gap, and the message sent the
// fixer to "the body", where a re-citation still failed. Fix widens the scan to
// the planner-canonical tag set AND corrects the message to name scanned surfaces.

describe('check.decision-coverage-plan — planner-canonical tag scanning (#2372)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2372-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  // Common CONTEXT.md with a single trackable decision D-01.
  const CONTEXT_WITH_D01 = [
    '# Context',
    '',
    '<decisions>',
    '- **D-01:** Use OAuth 2.0 for authentication',
    '</decisions>',
  ].join('\n');

  // Helper: write CONTEXT + a PLAN whose body wraps `innerTagBody` in `tagName`.
  function writeContextAndPlan(tagName, innerTagBody) {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    writePlanFile(phaseDir, '01', `# Plan\n\n<tasks>\n<task>\n  <${tagName}>\n${innerTagBody}\n  </${tagName}>\n</task>\n</tasks>\n`);
  }

  const cases = [
    { tag: 'read_first', citation: '- path/to/CONTEXT.md (D-01 — auth decision)' },
    { tag: 'behavior', citation: 'Honor D-01: redirect unauthenticated users to OAuth flow.' },
    { tag: 'verify', citation: 'Verify D-01: token exchange returns 200 with access_token.' },
    { tag: 'acceptance_criteria', citation: 'D-01 honored: every protected route requires a valid OAuth token.' },
    { tag: 'done', citation: 'D-01 implemented — OAuth 2.0 flow live.' },
  ];

  for (const { tag, citation } of cases) {
    test(`D-NN cited in <${tag}> body → covered (no false gap)`, () => {
      writeContextAndPlan(tag, citation);

      const contextPath = path.join(phaseDir, 'CONTEXT.md');
      const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
      const parsed = JSON.parse(result.output || '{}');

      assert.strictEqual(parsed.total, 1, `expected total=1, got ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.covered, 1, `D-01 cited in <${tag}> must count as covered. Got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.passed, true, `gate must pass when D-01 is cited in <${tag}>. Got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.uncovered.length, 0, `uncovered must be empty. Got: ${JSON.stringify(parsed.uncovered)}`);
    });
  }

  test('control: D-NN cited nowhere → still uncovered (no false green from widening)', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    writePlanFile(phaseDir, '01', '# Plan\n\n<tasks>\n<task>\n  <action>\n    Implement the feature.\n  </action>\n</task>\n</tasks>\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 0);
    assert.strictEqual(parsed.passed, false);
    assert.strictEqual(parsed.uncovered.length, 1);
    assert.strictEqual(parsed.uncovered[0].id, 'D-01');
  });

  // Message/extractor parity: the remediation text must name ONLY the surfaces the
  // extractor actually scans. Asserts no "(or body)" claim it doesn't back, AND
  // that every newly-scanned tag is named in the message — so the two cannot drift
  // apart again. The reporter's bug was exactly this drift.
  test('buildPlanMessage names every scanned surface (no "(or body)" drift, #2372)', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    writePlanFile(phaseDir, '01', '# Plan\nNo decision citation in any scanned surface.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.passed, false, 'fixture intentionally leaves D-01 uncovered');
    const msg = parsed.message || '';

    // The misleading "(or body)" clause that promised a scope the extractor didn't implement is gone.
    assert.ok(!/\(or body\)/i.test(msg), `message must not claim "(or body)" — that was the bug. Got: "${msg}"`);

    // Every surface the extractor now scans MUST appear by name in the message — if any is
    // missing, the message has drifted from the scan again.
    const requiredSurfaceNames = [
      'must_haves', 'truths', 'objective',
      '<objective>', '<tasks>', '<task>', '<action>',
      '<read_first>', '<behavior>', '<verify>', '<acceptance_criteria>', '<done>',
    ];
    for (const surface of requiredSurfaceNames) {
      assert.ok(
        msg.includes(surface),
        `message must name scanned surface "${surface}" — otherwise the message/extractor drift apart. Got: "${msg}"`
      );
    }
  });

  // Reviewer-driven edge cases (code review on the initial widening flagged these):
  //
  // 1. Nested scanned tag inside another scanned tag: a citation in the OUTER tag's
  //    prefix prose must still count. Initial widening used a single alternation whose
  //    negative lookahead halted the outer tag's body at any inner scanned tag — losing
  //    the prefix citation. Switched to per-tag matching so each tag's body terminates
  //    only at its own closing tag (other scanned tags pass through as text into this body).
  // 2. Non-scanned tag bearing a D-NN citation must NOT count toward coverage — guards
  //    against future over-widening.
  // 3. Self-closing form `<read_first />` has no body and must not error or match.
  // 4. Attribute form `<verify type="automated">D-01</verify>` is the canonical planner
  //    shape for <verify> and must match.
  // 5. CRLF newlines inside tag bodies must not break capture.

  test('D-NN in outer scanned tag prefix is not lost when inner scanned tag follows (per-tag capture)', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    // The bug shape: <action>per D-01 <verify>...</verify></action> — D-01 lives in <action>'s prefix.
    writePlanFile(phaseDir, '01', [
      '# Plan',
      '',
      '<tasks>',
      '<task>',
      '  <action>',
      '    Implement per D-01 — OAuth 2.0 flow.',
      '    <verify>token exchange returns 200</verify>',
      '  </action>',
      '</task>',
      '</tasks>',
    ].join('\n'));

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.covered, 1, `D-01 in <action> prefix must be caught (per-tag capture). Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.passed, true);
  });

  test('D-NN inside a non-scanned tag body does NOT count toward coverage', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    // <name> is not in the scanned set — citation here must not be picked up.
    writePlanFile(phaseDir, '01', '# Plan\n\n<name>per D-01</name>\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 0, 'non-scanned tag body must not count. Got: ' + JSON.stringify(parsed));
    assert.strictEqual(parsed.passed, false);
    assert.strictEqual(parsed.uncovered.length, 1);
  });

  test('self-closing scanned tag form is safely ignored (no body to scan)', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    // Self-closing form has no body. The gate must not crash and must not match the (absent) body.
    writePlanFile(phaseDir, '01', '# Plan\n\n<tasks>\n<task>\n<read_first />\n<action>Implement feature.</action>\n</task>\n</tasks>\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 0);
    assert.strictEqual(parsed.passed, false);
  });

  test('attribute form `<verify type="...">D-NN</verify>` is scanned (canonical planner shape)', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    writePlanFile(phaseDir, '01', '# Plan\n\n<tasks>\n<task>\n<verify type="automated">Run npm test per D-01</verify>\n</task>\n</tasks>\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.covered, 1, 'attribute form on scanned tag must match. Got: ' + JSON.stringify(parsed));
    assert.strictEqual(parsed.passed, true);
  });

  test('CRLF newlines inside scanned tag body do not break capture', () => {
    writeContextFile(phaseDir, CONTEXT_WITH_D01);
    const planBody = ['# Plan', '', '<tasks>', '<task>', '  <action>', '    Implement per D-01.', '  </action>', '</task>', '</tasks>', ''].join('\r\n');
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), planBody);

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');

    assert.strictEqual(parsed.covered, 1, 'CRLF body must not break capture. Got: ' + JSON.stringify(parsed));
    assert.strictEqual(parsed.passed, true);
  });
});

// ─── #2770: empty contextPath argument must fail closed, not green-skip ──────
// The handler conflated "empty argument" (a CALLER ERROR — the workflow forgot to
// pass the path) with "file missing" (a LEGITIMATE green skip). An empty arg
// returned passed:true/skipped/reason:"CONTEXT.md missing", silently certifying a
// blocking gate. Must fail closed (mirrors #1365 fail-loud).

describe('check.decision-coverage-plan — empty contextPath argument fails closed (#2770)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2770-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('empty contextPath argument → passed:false (caller error, fail closed)', () => {
    const result = runDecisionCoveragePlan(phaseDir, '', tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, false,
      `Empty contextPath argument must fail closed (caller error), not green-skip. Got: ${JSON.stringify(parsed)}`);
    const reason = (parsed.reason || '').toLowerCase();
    assert.ok(
      reason.includes('missing') && reason.includes('argument'),
      `Reason must identify the missing argument. Got: "${parsed.reason}"`
    );
  });

  test('real path to a genuinely-absent CONTEXT.md → legitimate green skip preserved (#2770)', () => {
    // Negative space: a REAL path whose file does not exist is the legitimate skip.
    const absentPath = path.join(phaseDir, 'CONTEXT.md'); // never written
    const result = runDecisionCoveragePlan(phaseDir, absentPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, true,
      `A real path to a genuinely-absent CONTEXT.md is a legitimate green skip. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, true);
    assert.ok(
      (parsed.reason || '').toLowerCase().includes('context.md missing'),
      `Reason must be the legitimate CONTEXT.md-missing skip. Got: "${parsed.reason}"`
    );
  });

  test('undefined-ish argument omitted entirely → passed:false (fail closed)', () => {
    // The CLI invocation drops a trailing empty arg in some shells; the handler must
    // still fail closed when args[3] is absent (not just empty string).
    const result = runGsdTools(['query', 'check.decision-coverage-plan', phaseDir], tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, false,
      `Missing contextPath argument must fail closed. Got: ${JSON.stringify(parsed)}`);
  });
});

// ─── #3939: decision bullet whose bold lead-in wraps across a line break ──────
//
// parseDecisionLines matched each PHYSICAL line against the three bullet
// grammars, and all three require the closing `**` on the same line as the
// opening one. A decision bullet whose bold lead-in wraps — the shape GSD's own
// discuss-phase writer emits whenever a title runs past the wrap column — closes
// its bold run on a line the grammars never see together with the `- **D-`
// anchor, so all three miss and the #1365 parse-miss guard fires. One such miss
// forces `could-not-parse`, which hard-blocks check.decision-coverage-plan.
//
// Fix: assemble the LOGICAL bullet before matching. A decision bullet whose bold
// run is still open at end-of-line absorbs following lines until the run closes;
// only then do the three grammars (unchanged) see it. Joining is bounded — a
// blank line, a new bullet, a heading, or end-of-block stops it — so a genuinely
// malformed bullet (an unterminated bold run) still reaches the parse-miss guard
// and still fails loud. The wrapped bullet must parse to exactly what the same
// bullet written on one physical line parses to (parity, not a new grammar).

describe('#3939: decision bullet with a wrapped bold lead-in parses as one logical bullet', () => {
  test('titled-colon form wrapped across a line break is parsed, not a parse-miss', () => {
    const md = [
      '<decisions>',
      '- **D-01: A titled-colon decision whose bold title wraps onto the',
      '  next line.** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `A wrapped bold lead-in must not force could-not-parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-01'],
      `D-01 must be extracted. Got: ${JSON.stringify(result.decisions)}`);
    assert.strictEqual(result.decisions[0].text, 'body text',
      `Text is the body after the closing bold run. Got: ${JSON.stringify(result.decisions[0].text)}`);
  });

  test('em-dash form wrapped across a line break is parsed, not a parse-miss', () => {
    const md = [
      '<decisions>',
      '- **D-02 — an em-dash title that wraps onto the',
      '  next line** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `A wrapped em-dash lead-in must not force could-not-parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-02']);
    assert.strictEqual(result.decisions[0].text, 'body text');
  });

  test('colon-immediate form wrapped across a line break is parsed, not a parse-miss', () => {
    const md = [
      '<decisions>',
      '- **D-03 a long pre-colon prose run that keeps',
      '  going:** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `A wrapped colon-immediate lead-in must not force could-not-parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-03']);
    assert.strictEqual(result.decisions[0].text, 'body text');
  });

  test('a wrapped bullet parses to exactly what the same bullet on one line parses to', () => {
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-04 [informational]: A title that wraps',
      '  here.** body text continues',
      '</decisions>',
    ].join('\n'));
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-04 [informational]: A title that wraps here.** body text continues',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(wrapped, oneLine,
      `Wrapping must be markdown-insignificant: the wrapped bullet must parse identically to the same bullet on one physical line. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
    assert.strictEqual(wrapped.decisions[0].trackable, false,
      'the [informational] tag must survive the join (non-trackable)');
  });

  test('a bold lead-in wrapped across three physical lines is parsed', () => {
    const md = [
      '<decisions>',
      '- **D-05: A very long title that',
      '  keeps going and',
      '  going.** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `A lead-in wrapped over three lines must parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-05']);
  });

  test('body continuation lines after a wrapped lead-in still fold into the decision text', () => {
    const md = [
      '<decisions>',
      '- **D-06: A title that wraps onto the',
      '  next line.** first body line',
      '  second body line',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed');
    assert.strictEqual(result.decisions[0].text, 'first body line second body line',
      `Continuation handling must be unchanged after the join. Got: ${JSON.stringify(result.decisions[0].text)}`);
  });

  test('wrapped and single-line bullets in one block all parse (the reported field shape)', () => {
    const md = [
      '<decisions>',
      '### Implementation',
      '- **D-01: A decision whose bold title wraps onto the',
      '  next line.** body one',
      '- **D-02:** a single-line colon-immediate decision',
      '- **D-03 — an em-dash title that wraps onto the',
      '  next line** body three',
      '- **D-04: A single-line titled decision.** body four',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `A block mixing wrapped and single-line bullets must parse. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-01', 'D-02', 'D-03', 'D-04'],
      `Every bullet must be extracted in document order. Got: ${JSON.stringify(result.decisions.map((d) => d.id))}`);
    assert.strictEqual(result.decisions[0].category, 'Implementation',
      'the category heading must still attach to a wrapped bullet');
  });

  test('CRLF newlines: a wrapped bold lead-in is parsed (cross-platform)', () => {
    const md = [
      '<decisions>',
      '- **D-01: A title that wraps onto the',
      '  next line.** body text',
      '</decisions>',
    ].join('\r\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `CRLF content must join identically to LF. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-01']);
    assert.strictEqual(result.decisions[0].text, 'body text',
      `No stray carriage return may survive the join. Got: ${JSON.stringify(result.decisions[0].text)}`);
  });

  test('markdown-header fallback path also parses a wrapped bold lead-in (#1364 path)', () => {
    const md = [
      '## Locked decisions',
      '- **D-01: A title that wraps onto the',
      '  next line.** body text',
      '- **D-02:** single line',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `The header-fallback path shares parseDecisionLines and must behave identically. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-01', 'D-02']);
  });

  // ── Negative proof: the #1365 fail-loud guard must still fire ───────────────

  test('NEGATIVE: an unterminated bold run is still a parse-miss (fail-loud preserved)', () => {
    const md = [
      '<decisions>',
      '- **D-01: a bold run that never closes',
      '  more prose that never closes it either',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A genuinely malformed bullet must still fail loud, not be swallowed by the join. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions, [],
      `No decision may be manufactured from an unterminated bold run. Got: ${JSON.stringify(result.decisions)}`);
  });

  test('NEGATIVE: a blank line stops the join — closing ** after it is still a parse-miss', () => {
    const md = [
      '<decisions>',
      '- **D-01: a title interrupted by a blank line',
      '',
      '  closes here.** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A blank line terminates a bullet; the join must not reach across it. Got: ${JSON.stringify(result)}`);
  });

  test('NEGATIVE: a whitespace-only line stops the join', () => {
    const md = [
      '<decisions>',
      '- **D-01: a title interrupted by a whitespace-only line',
      '   ',
      '  closes here.** body text',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A whitespace-only line must terminate the bullet exactly like a blank one. Got: ${JSON.stringify(result)}`);
  });

  test('NEGATIVE: a following bullet stops the join and is still parsed on its own', () => {
    const md = [
      '<decisions>',
      '- **D-01: a title whose bold run never closes',
      '- **D-02:** a well-formed sibling',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `The unterminated D-01 must still fail loud. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-02'],
      `The join must not swallow the sibling bullet. Got: ${JSON.stringify(result.decisions.map((d) => d.id))}`);
  });

  test('NEGATIVE: a heading stops the join', () => {
    const md = [
      '<decisions>',
      '- **D-01: a title whose bold run never closes',
      '### Implementation',
      '- **D-02:** a well-formed decision under the heading',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `The unterminated D-01 must still fail loud. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-02']);
    assert.strictEqual(result.decisions[0].category, 'Implementation',
      `The heading must not be swallowed into the open bullet. Got: ${JSON.stringify(result.decisions[0].category)}`);
  });

  test('NEGATIVE: a numbered list item stops the join — its inline ** must not close the run', () => {
    // Without the full block-construct terminator set the join would absorb the
    // list item and "close" on the OPENING ** of its inline bold, manufacturing a
    // decision out of a bullet whose own bold run never closes.
    const md = [
      '<decisions>',
      '- **D-01: a title whose bold run never closes',
      '  1. step with **em** here',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A nested ordered-list item is a new block; the unterminated bullet must still fail loud. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions, [],
      `No decision may be manufactured from the list item's inline bold. Got: ${JSON.stringify(result.decisions)}`);
  });

  test('NEGATIVE: star and plus list markers stop the join', () => {
    for (const marker of ['*', '+']) {
      const md = [
        '<decisions>',
        '- **D-01: a title whose bold run never closes',
        `  ${marker} item with **em** here`,
        '</decisions>',
      ].join('\n');
      const result = extractDecisions(md);
      assert.strictEqual(result.outcome, 'could-not-parse',
        `A '${marker}' list marker is a new block; the unterminated bullet must still fail loud. Got: ${JSON.stringify(result)}`);
    }
  });

  test('NEGATIVE: a table row and a blockquote stop the join', () => {
    for (const block of ['| col **x** | y |', '> quoted **em** text']) {
      const md = [
        '<decisions>',
        '- **D-01: a title whose bold run never closes',
        `  ${block}`,
        '</decisions>',
      ].join('\n');
      const result = extractDecisions(md);
      assert.strictEqual(result.outcome, 'could-not-parse',
        `A block-level construct must stop the join. Got for ${JSON.stringify(block)}: ${JSON.stringify(result)}`);
    }
  });

  test('a continuation line opening with emphasis is text, not a list marker', () => {
    // `*in*` has no space after the `*`, so it is emphasis — the join must absorb
    // it. (The joined title then contains `*`, which the titled-colon grammar's
    // `[^:*]*` discipline rejects, exactly as it does on one physical line.)
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-01: sanitised on the way',
      '  *in*.** body text',
      '</decisions>',
    ].join('\n'));
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01: sanitised on the way *in*.** body text',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(wrapped, oneLine,
      `An emphasis-opening continuation line must join, giving the same verdict as the one-line form. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
  });

  test('an inline **bold** inside a wrapped title gives the same result as on one line', () => {
    // Absorption stops at the first ** on a continuation line, so an inline bold
    // inside the title closes the run early. Parity with the one-line form is the
    // contract — the text past the early close re-attaches via continuation folding.
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-01: a title that',
      '  has **inline bold** inside.** body text',
      '</decisions>',
    ].join('\n'));
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01: a title that has **inline bold** inside.** body text',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(wrapped, oneLine,
      `Wrapping must stay markdown-insignificant even when the title carries inline bold. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
  });

  test('NEGATIVE: a long unterminated run still fails loud (scan is bounded, not quadratic)', () => {
    // The join scans each absorbed line ONCE (per-segment search, no re-scan of
    // the accumulated candidate), so a pathological block degrades linearly
    // instead of quadratically — this runs on the plan gate's hot path over
    // user-authored files.
    const lines = ['<decisions>', '- **D-01: a bold run that never closes'];
    for (let i = 0; i < 5000; i += 1) lines.push(`  filler prose line ${i} that never closes the run`);
    lines.push('</decisions>');
    const result = extractDecisions(lines.join('\n'));
    assert.strictEqual(result.outcome, 'could-not-parse',
      `A long unterminated run must still fail loud. Got: ${JSON.stringify(result.outcome)}`);
    assert.deepStrictEqual(result.decisions, []);
  });

  test('NEGATIVE GUARD: the single-line malformed bullet of FIX B is still a parse-miss', () => {
    // `- **D-02** ratio 3:1` closes its bold run on the same line with neither a
    // colon-before-`**` nor an em-dash — a genuine miss, unrelated to wrapping.
    const md = [
      '<decisions>',
      '- **D-01:** use JWT tokens',
      '- **D-02** ratio 3:1',
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse',
      `FIX B behaviour must be unchanged. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-01']);
  });

  test('NEGATIVE GUARD: a nested cross-reference bullet is still elaboration, not a join target (#3169)', () => {
    const md = [
      '<decisions>',
      '- **D-15: A title that wraps onto the',
      '  next line.** some decision',
      "  - **D-06's fix does not close this.** a nested cross-reference",
      '</decisions>',
    ].join('\n');
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed',
      `#3169 handling must survive the join. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions.map((d) => d.id), ['D-15'],
      `The nested bullet is elaboration, not a second entry. Got: ${JSON.stringify(result.decisions.map((d) => d.id))}`);
    assert.ok(result.decisions[0].text.includes("D-06's fix does not close this"),
      `The nested bullet must still fold into D-15's text. Got: ${JSON.stringify(result.decisions[0].text)}`);
  });

  // ── Review round 3: the id-adjacent [tags] bracket ───────────────────────
  //
  // Folding a soft line break to a single space is markdown's own rule, and it
  // is invisible everywhere in a bullet EXCEPT inside the `[tags]` bracket the
  // grammars turn into `trackable`. There a spliced space would split one tag
  // token into two (`[defer` + `red]` → `defer red`), which does not fail — it
  // parses to a DIFFERENT tag, silently flipping whether the decision-coverage
  // gate demands coverage. The join refuses that splice so the bullet reaches
  // the #1365 guard and fails loud instead.

  test('NEGATIVE: a wrap that splices a tag token fails loud, never a silent re-classification', () => {
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-01 [defer',
      '  red]: Use the thing.** body text',
      '</decisions>',
    ].join('\n'));
    assert.strictEqual(wrapped.outcome, 'could-not-parse',
      `A wrap inside a tag token must fail loud, not guess. Got: ${JSON.stringify(wrapped)}`);
    assert.deepStrictEqual(wrapped.decisions, [],
      `No decision may be manufactured from a spliced tag. Got: ${JSON.stringify(wrapped.decisions)}`);

    // The failure mode this prevents: [deferred] is non-trackable, [defer red]
    // is trackable — the gate's answer about this decision would silently flip.
    const intended = extractDecisions([
      '<decisions>',
      '- **D-01 [deferred]: Use the thing.** body text',
      '</decisions>',
    ].join('\n'));
    assert.strictEqual(intended.decisions[0].trackable, false,
      'guard fixture: the intended one-line bullet is non-trackable');
  });

  test('a wrap at a tag-list delimiter joins and parses identically to the one-line bullet', () => {
    // A space landing next to `[`, `,` or `]` survives the parser's comma-split
    // and trim, so these wraps are safe and must NOT be refused.
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01 [informational, deferred]: A title.** body text',
      '</decisions>',
    ].join('\n'));
    const variants = {
      'comma at end of line': ['- **D-01 [informational,', '  deferred]: A title.** body text'],
      'comma at start of line': ['- **D-01 [informational', '  , deferred]: A title.** body text'],
    };
    for (const [label, lines] of Object.entries(variants)) {
      const wrapped = extractDecisions(['<decisions>', ...lines, '</decisions>'].join('\n'));
      assert.deepStrictEqual(wrapped, oneLine,
        `A delimiter-adjacent wrap (${label}) must parse like the one-line bullet. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
    }

    // …across more than two physical lines, too.
    const threeLine = extractDecisions([
      '<decisions>',
      '- **D-01 [informational,',
      '  deferred,',
      '  folded]: A title.** body text',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(threeLine.decisions.map((d) => d.tags), [['informational', 'deferred', 'folded']],
      `A tag list wrapped over three lines must keep every tag. Got: ${JSON.stringify(threeLine)}`);
    assert.strictEqual(threeLine.decisions[0].trackable, false);
  });

  test('NEGATIVE: a tag token spliced on a LATER continuation line also fails loud', () => {
    const result = extractDecisions([
      '<decisions>',
      '- **D-01 [informational,',
      '  defer',
      '  red]: A title.** body text',
      '</decisions>',
    ].join('\n'));
    assert.strictEqual(result.outcome, 'could-not-parse',
      `The splice check must hold for every absorbed line, not just the first. Got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.decisions, []);
  });

  test('a bracket in the TITLE is not the tag bracket — the join is unaffected', () => {
    // Only the id-adjacent bracket becomes `tags`; a bracket further along the
    // title is ordinary text and must not restrict wrapping.
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-01: prefer [the new',
      '  API] here.** body text',
      '</decisions>',
    ].join('\n'));
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01: prefer [the new API] here.** body text',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(wrapped, oneLine,
      `A title bracket must not trigger the tag-splice guard. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
    assert.strictEqual(wrapped.outcome, 'parsed');
  });

  // ── Review round 2: the `N)` ordered-list terminator ─────────────────────

  test('NEGATIVE: an `N)` ordered list item stops the join, like `N.`', () => {
    for (const marker of ['1.', '1)', '10.', '10)']) {
      const result = extractDecisions([
        '<decisions>',
        '- **D-01: a title whose bold run never closes',
        `  ${marker} step with **em** here`,
        '</decisions>',
      ].join('\n'));
      assert.strictEqual(result.outcome, 'could-not-parse',
        `An '${marker}' ordered-list marker is a new block; the unterminated bullet must still fail loud. Got: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(result.decisions, [],
        `No decision may be manufactured from the '${marker}' item's inline bold.`);
    }
  });

  test('DRIFT GUARD: the sectionizer seam still does not treat `N)` as a bullet', () => {
    // blockConstructRe stops at both `N. ` and `N) `; the seam's iterateBullets
    // (ADR-1372) yields only `N. `. That divergence is deliberate and
    // one-directional — a terminator set may recognise MORE block openers than
    // the bullet iterator, since a spare terminator can only make a malformed
    // bullet fail loud, never manufacture a decision. This test fails if the
    // seam starts yielding `N)`, so the two are re-reconciled on purpose rather
    // than drifting silently.
    assert.deepStrictEqual(iterateBullets('1. numbered item').map((b) => b.text), ['numbered item'],
      'guard fixture: the seam yields the `N. ` ordered form');
    assert.deepStrictEqual(iterateBullets('1) numbered item'), [],
      'The seam does not yield `N) `. If this now fails, revisit blockConstructRe’s documented divergence in src/decisions.cts.');
  });

  test('accepted over-termination: continuation prose opening `10.` or `|` stops the join', () => {
    // Inherent markdown ambiguity: prose that happens to start with a numbered
    // marker or a pipe is indistinguishable from a new block. Pinned as accepted
    // behaviour — the bullet fails loud rather than being guessed at (#1365).
    for (const continuation of ['10. really keeps going.** body', '| pipes open a table row.** body']) {
      const result = extractDecisions([
        '<decisions>',
        '- **D-01: a title that wraps and then',
        `  ${continuation}`,
        '</decisions>',
      ].join('\n'));
      assert.strictEqual(result.outcome, 'could-not-parse',
        `Over-termination must fail loud, not silently drop the bullet. Got for ${JSON.stringify(continuation)}: ${JSON.stringify(result)}`);
    }
  });

  // ── Review round 3: whitespace fidelity and #3169 nesting ────────────────

  test('a double space inside the title survives every wrap position around it', () => {
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01: Title  with double space.** body',
      '</decisions>',
    ].join('\n'));
    const variants = {
      'wrapped before both spaces': ['- **D-01: Title', '  with double space.** body'],
      'wrapped between the two spaces': ['- **D-01: Title ', ' with double space.** body'],
      'wrapped after both spaces': ['- **D-01: Title  ', 'with double space.** body'],
    };
    for (const [label, lines] of Object.entries(variants)) {
      const wrapped = extractDecisions(['<decisions>', ...lines, '</decisions>'].join('\n'));
      assert.deepStrictEqual(wrapped, oneLine,
        `Interior title whitespace must not change the parse (${label}). Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
    }
  });

  test('a double space inside the BODY is preserved verbatim across a wrapped lead-in', () => {
    // The body sits past the closing `**`; the join must not touch it.
    const result = extractDecisions([
      '<decisions>',
      '- **D-01: A title that wraps onto the',
      '  next line.** body  with double space',
      '</decisions>',
    ].join('\n'));
    assert.strictEqual(result.decisions[0].text, 'body  with double space',
      `Body whitespace must survive the join byte-for-byte. Got: ${JSON.stringify(result.decisions[0].text)}`);
  });

  test('a WRAPPED bullet nested under an already-open decision behaves like the one-line nested form (#3169)', () => {
    // The existing #3169 guard above uses an already-single-line nested bullet.
    // This pins the case the join actually touches: the nested bullet's own bold
    // lead-in wraps. It must still be elaboration folded into the open decision,
    // never a second entry and never a parse-miss.
    const wrapped = extractDecisions([
      '<decisions>',
      '- **D-01: First decision.** Body of first.',
      '  - **D-02: A nested cross-reference whose title',
      '    wraps.** nested body',
      '</decisions>',
    ].join('\n'));
    const oneLine = extractDecisions([
      '<decisions>',
      '- **D-01: First decision.** Body of first.',
      '  - **D-02: A nested cross-reference whose title wraps.** nested body',
      '</decisions>',
    ].join('\n'));
    assert.deepStrictEqual(wrapped, oneLine,
      `A wrapped NESTED bullet must parse like its one-line form. Wrapped: ${JSON.stringify(wrapped)} One-line: ${JSON.stringify(oneLine)}`);
    assert.strictEqual(wrapped.outcome, 'parsed');
    assert.deepStrictEqual(wrapped.decisions.map((d) => d.id), ['D-01'],
      `The nested bullet stays elaboration, not a second entry. Got: ${JSON.stringify(wrapped.decisions.map((d) => d.id))}`);
    assert.ok(wrapped.decisions[0].text.includes('wraps.'),
      `The wrapped nested bullet must fold into D-01's text in one piece. Got: ${JSON.stringify(wrapped.decisions[0].text)}`);
  });
});

// ─── #3939 properties: wrapping is markdown-insignificant ────────────────────
//
// RULESET.TESTS.property-based-testing (CONTEXT.md): a parsing/transformation
// contract needs at least one fast-check property asserting a domain invariant.
// The invariant this fix rests on is a round-trip one — where a bold lead-in
// happens to wrap is not information, so a wrapped bullet must parse to exactly
// what the same bullet written on one physical line parses to, for EVERY grammar,
// every tag/category combination, and every wrap column. The example-based tests
// above pin four hand-picked wrap points; this generalizes over all of them.

// Word corpus deliberately free of markdown metacharacters: `:` and `*` change
// which grammar matches (the `[^:*]*` discipline of #1639), and a generated
// token opening a block construct (`-`, `#`, `>`, `|`, …) would legitimately
// terminate the join. Those are separate, example-tested behaviors — this
// property isolates the wrap-position dimension.
const PROSE_WORDS = [
  'persist', 'raw', 'delivery', 'headers', 'resumable', 'backfill', 'inline',
  'sync', 'column', 'migration', 'denylisted', 'triage', 'payload', 'budget',
  'structural', 'fixture', 'corpus', 'resolver', 'idempotent', 'verbatim',
];

const proseArb = (minWords, maxWords) =>
  fc.array(fc.constantFrom(...PROSE_WORDS), { minLength: minWords, maxLength: maxWords })
    .map((words) => words.join(' '));

const decisionIdArb = fc.oneof(
  fc.integer({ min: 1, max: 99 }).map((n) => `D-${String(n).padStart(2, '0')}`),
  fc.constantFrom('D-INFRA-01', 'D-CARRY-2', 'D-7'),
);

const tagsArb = fc.constantFrom('', ' [informational]', ' [deferred]', ' [folded]');

/** The three declaration grammars, each rendered on ONE physical line. */
const BULLET_FORMS = {
  colonImmediate: (id, tags, title, body) => `- **${id}${tags} ${title}:** ${body}`,
  titledColon: (id, tags, title, body) => `- **${id}${tags}: ${title}.** ${body}`,
  emDash: (id, tags, title, body) => `- **${id}${tags} — ${title}** ${body}`,
};

/**
 * Render one declaration line, failing the property outright on an unknown form
 * rather than letting `undefined` propagate. `form` is drawn from
 * `Object.keys(BULLET_FORMS)`, so this can only fire if the generator and the
 * table are edited apart — which is exactly when it should.
 */
function renderBullet(form, id, tags, title, body) {
  const render = BULLET_FORMS[form];
  assert.ok(typeof render === 'function', `unknown bullet form: ${JSON.stringify(form)}`);
  return render(id, tags, title, body);
}

/**
 * Re-render a one-line bullet with its bold lead-in wrapped at the space
 * selected by `seed`, continuation indented like discuss-phase writes it.
 * Returns null when the lead-in holds no interior space to wrap at.
 */
function wrapBoldLeadIn(line, seed) {
  const open = line.indexOf('**');
  const close = line.indexOf('**', open + 2);
  const spaces = [];
  for (let i = open + 2; i < close; i += 1) {
    if (line[i] === ' ') spaces.push(i);
  }
  if (spaces.length === 0) return null;
  const at = spaces[seed % spaces.length];
  return `${line.slice(0, at)}\n  ${line.slice(at + 1)}`;
}

/**
 * Like `wrapBoldLeadIn`, but breaks the lead-in at two or more DISTINCT
 * positions chosen by `seeds`, and at ANY position — not only at a space.
 *
 * Both generalizations are load-bearing for the #3953 review Blocker, and
 * neither is reachable through `wrapBoldLeadIn`:
 *
 *   - Two-plus breaks let the id-adjacent `[tags]` bracket open on a segment
 *     that is NOT the declaration line, which is the state whose splice guard
 *     was never armed. A single break always left the bracket either wholly on
 *     line 1 or wholly on line 2.
 *   - Breaking mid-token is what makes that state OBSERVABLE. A break at a
 *     space round-trips exactly (the join re-inserts the space it replaced), so
 *     a disarmed guard is indistinguishable from an armed one; a hard break
 *     inside a tag token is the case where the inserted space changes the token
 *     — `[inform` / `ational]` folding to the tag `inform ational` — and so
 *     changes `trackable`.
 *
 * A break AT a space replaces it (a markdown soft break renders as one space);
 * a break anywhere else inserts the newline, which is the hard-wrapped shape a
 * fixed-column writer produces.
 *
 * Breaks start AFTER the decision id, which every form renders flush against
 * the opening `**`. Breaking inside the id is excluded because it lands in
 * behavior this property is not about, in two different ways: a break inside
 * `**`, or between `D` and `-01`, leaves the block with no `D-` token at all,
 * so `extractDecisions` reports `none-present` — correctly, since nothing there
 * is decision-shaped; and a break inside the id's own characters (`D-0` / `1`)
 * yields a bullet that parses under a TRUNCATED id, which is pre-existing
 * behavior identical before and after this fix. Both are generator artifacts.
 * Everything the Blocker needs is downstream of the id: the space before `[`,
 * the bracket interior, and the title. Returns null when fewer than two
 * distinct positions were drawn.
 */
function wrapBoldLeadInMulti(line, id, seeds) {
  const open = line.indexOf('**');
  const close = line.indexOf('**', open + 2);
  const start = open + 2 + id.length;
  const span = close - start;
  if (span < 2) return null;

  const cuts = [...new Set(seeds.map((seed) => start + (seed % span)))]
    .sort((a, b) => b - a);
  if (cuts.length < 2) return null;

  // Highest index first, so each break leaves the earlier indices valid.
  let out = line;
  for (const at of cuts) {
    const drop = out[at] === ' ' ? 1 : 0;
    out = `${out.slice(0, at)}\n  ${out.slice(at + drop)}`;
  }
  return out;
}

const inBlock = (body) => ['<decisions>', body, '</decisions>'].join('\n');

describe('#3939 properties: a wrapped bold lead-in parses like the one-line bullet', () => {
  test('property: wrapping a bold lead-in anywhere is indistinguishable from not wrapping it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        decisionIdArb,
        tagsArb,
        proseArb(2, 8),
        proseArb(1, 6),
        fc.nat(),
        fc.boolean(),
        (form, id, tags, title, body, seed, withCategory) => {
          const line = renderBullet(form, id, tags, title, body);
          const wrappedLine = wrapBoldLeadIn(line, seed);
          if (wrappedLine === null) return true;

          const heading = withCategory ? '### Implementation\n' : '';
          const oneLine = extractDecisions(inBlock(heading + line));
          const wrapped = extractDecisions(inBlock(heading + wrappedLine));

          assert.deepStrictEqual(wrapped, oneLine,
            `Wrap position must carry no information. form=${form} id=${id} tags=${JSON.stringify(tags)}\nONE-LINE: ${JSON.stringify(line)} → ${JSON.stringify(oneLine)}\nWRAPPED:  ${JSON.stringify(wrappedLine)} → ${JSON.stringify(wrapped)}`);
          return true;
        },
      ),
    );
  });

  test('property: a wrapped declaration is never a parse-miss (outcome parsed, id preserved)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        decisionIdArb,
        tagsArb,
        proseArb(2, 8),
        proseArb(1, 6),
        fc.nat(),
        (form, id, tags, title, body, seed) => {
          const wrappedLine = wrapBoldLeadIn(renderBullet(form, id, tags, title, body), seed);
          if (wrappedLine === null) return true;

          const result = extractDecisions(inBlock(wrappedLine));
          assert.strictEqual(result.outcome, 'parsed',
            `A well-formed wrapped declaration must never reach the parse-miss guard. form=${form} line=${JSON.stringify(wrappedLine)} → ${JSON.stringify(result)}`);
          assert.deepStrictEqual(result.decisions.map((d) => d.id), [id],
            `The declared id must survive the join. form=${form} line=${JSON.stringify(wrappedLine)} → ${JSON.stringify(result.decisions)}`);
          return true;
        },
      ),
    );
  });

  test('property: a lead-in that never closes still fails loud, however long the run', (t) => {
    // The join must not manufacture a decision out of an unterminated bold run,
    // no matter how many lines it would have to absorb before giving up.
    const originalWarn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = originalWarn; });

    fc.assert(
      fc.property(
        decisionIdArb,
        proseArb(2, 8),
        fc.array(proseArb(1, 6), { minLength: 0, maxLength: 12 }),
        (id, title, trailing) => {
          const lines = [`- **${id}: ${title}`, ...trailing.map((t2) => `  ${t2}`)];
          const result = extractDecisions(inBlock(lines.join('\n')));
          assert.strictEqual(result.outcome, 'could-not-parse',
            `An unterminated bold run must stay fail-loud. lines=${JSON.stringify(lines)} → ${JSON.stringify(result)}`);
          assert.deepStrictEqual(result.decisions, [],
            `No decision may be manufactured from an unterminated run. → ${JSON.stringify(result.decisions)}`);
          return true;
        },
      ),
    );
  });

  test('property: a wrap inside the [tags] bracket never silently re-classifies a decision', (t) => {
    // The one place a spliced space is NOT invisible. The invariant is a
    // disjunction, deliberately: wherever the wrap lands, the parse either
    // matches the one-line bullet exactly, or it fails loud with nothing
    // extracted. What it must never do is yield a decision whose tags — and so
    // whose `trackable` verdict, which decides if the gate demands coverage —
    // differ from the one-line form. Multi-word tags are in the corpus so both
    // branches are reached (a wrap inside such a tag cannot be told apart from a
    // mid-token splice, so it takes the fail-loud branch).
    const originalWarn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = originalWarn; });

    const tagTokenArb = fc.constantFrom(
      'informational', 'deferred', 'folded', 'carried', 'deferred to phase 3',
    );

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        decisionIdArb,
        fc.array(tagTokenArb, { minLength: 1, maxLength: 3 }),
        proseArb(2, 6),
        proseArb(1, 4),
        fc.nat(),
        (form, id, tagTokens, title, body, seed) => {
          const tags = ` [${tagTokens.join(', ')}]`;
          const line = renderBullet(form, id, tags, title, body);
          const wrappedLine = wrapBoldLeadIn(line, seed);
          if (wrappedLine === null) return true;

          const oneLine = extractDecisions(inBlock(line));
          const wrapped = extractDecisions(inBlock(wrappedLine));

          if (wrapped.decisions.length === 0) {
            assert.strictEqual(wrapped.outcome, 'could-not-parse',
              `Extracting nothing must be the fail-loud outcome, never a silent pass. line=${JSON.stringify(wrappedLine)} → ${JSON.stringify(wrapped)}`);
            return true;
          }
          assert.deepStrictEqual(wrapped, oneLine,
            `A wrap that DOES parse must parse exactly like the one-line bullet — tags and trackable included.\nONE-LINE: ${JSON.stringify(line)} → ${JSON.stringify(oneLine)}\nWRAPPED:  ${JSON.stringify(wrappedLine)} → ${JSON.stringify(wrapped)}`);
          return true;
        },
      ),
    );
  });

  test('property: the same holds when the lead-in wraps at two or more points', (t) => {
    // #3953 review (Blocker): the splice guard was armed only from the bullet's
    // FIRST physical line, so a `[` that opened on a later absorbed segment left
    // it a no-op — `- **D-01` / `[inform` / `ational]: …**` yielded
    // tags `['inform ational']`, trackable `true`, where the one-line form gives
    // `['informational']`, trackable `false`. A silently wrong coverage-gate
    // answer, with no thrown error and no parse-miss to signal it.
    //
    // Every generator above wraps at exactly one point (`wrapBoldLeadIn` inserts
    // a single `\n`), which is why three review rounds and the property suite all
    // missed it. This one wraps at two or more, so the bracket-opens-later state
    // is reachable, and asserts the SAME disjunction: parse identically to the
    // one-line bullet, or fail loud with nothing extracted.
    const originalWarn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = originalWarn; });

    const tagTokenArb = fc.constantFrom(
      'informational', 'deferred', 'folded', 'carried', 'deferred to phase 3',
    );

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        decisionIdArb,
        fc.array(tagTokenArb, { minLength: 1, maxLength: 3 }),
        proseArb(2, 6),
        proseArb(1, 4),
        fc.array(fc.nat(), { minLength: 2, maxLength: 4 }),
        (form, id, tagTokens, title, body, seeds) => {
          const tags = ` [${tagTokens.join(', ')}]`;
          const line = renderBullet(form, id, tags, title, body);
          const wrappedLine = wrapBoldLeadInMulti(line, id, seeds);
          if (wrappedLine === null) return true;

          const oneLine = extractDecisions(inBlock(line));
          const wrapped = extractDecisions(inBlock(wrappedLine));

          if (wrapped.decisions.length === 0) {
            assert.strictEqual(wrapped.outcome, 'could-not-parse',
              `Extracting nothing must be the fail-loud outcome, never a silent pass. line=${JSON.stringify(wrappedLine)} → ${JSON.stringify(wrapped)}`);
            return true;
          }
          assert.deepStrictEqual(wrapped, oneLine,
            `A multi-wrap that DOES parse must parse exactly like the one-line bullet — tags and trackable included.\nONE-LINE: ${JSON.stringify(line)} → ${JSON.stringify(oneLine)}\nWRAPPED:  ${JSON.stringify(wrappedLine)} → ${JSON.stringify(wrapped)}`);
          return true;
        },
      ),
    );
  });
});

// ─── #3939 gate-level: a wrapped bold lead-in must not hard-block the gate ────

describe('check.decision-coverage-plan — wrapped bold lead-in does not hard-block (#3939)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3939-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('FAIL-FIRST: CONTEXT.md whose decision titles wrap → gate reports real coverage, not could-not-parse', () => {
    // Before the fix: both bullets are parse-misses → outcome could-not-parse →
    // the gate hard-blocks with passed:false even though the plan covers both.
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      '<decisions>',
      '### Implementation',
      '- **D-01: Persist the raw delivery headers. Do not resolve by a second',
      '  round-trip.** JSON arrays preserve repeated headers in order.',
      '- **D-02: A one-time, resumable backfill fills the new columns for already',
      '  indexed rows.** Sync fills them inline going forward.',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', [
      '# Plan',
      '',
      '## Must Haves',
      '',
      '- D-01: persist the raw delivery headers',
      '- D-02: implement the resumable backfill command',
    ].join('\n'));

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, true,
      `A CONTEXT.md whose decision titles merely wrap must not hard-block the gate. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.total, 2,
      `Both wrapped decisions must be counted. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.covered, 2,
      `Both wrapped decisions must be seen as covered by the plan. Got: ${JSON.stringify(parsed)}`);
  });
});

// ─── #4130: phase-prefixed decision IDs (D4-01) must parse ───────────────────
//
// The three declaration grammars all anchored on the literal `**D-`, so an ID
// carrying a phase-number prefix between the leading letter and the hyphen
// (D4-01, D12-01 — the reporter's D3-NN/D4-NN/D5-NN multi-phase convention,
// where bare D-01 collides across 18 phases) matched none of them — and none
// of the parse-miss guard or the #3939 join regexes either, so such a bullet
// was INVISIBLE to the extractor while the #2347 evidence detector correctly
// called the file decision-shaped. Net effect: the whole CONTEXT.md collapsed
// to could-not-parse with 0 extracted and the gate reported a format problem
// instead of a coverage result. The extractor now accepts an optional
// digit-run phase prefix on the same grammar the detector already recognized.

describe('parseDecisions — phase-prefixed IDs parse in every form (#4130)', () => {
  test('FAIL-FIRST: - **D4-01:** single-line colon form with a phase prefix parses', () => {
    // Before the fix: outcome could-not-parse, 0 extracted (the issue's own
    // b-phase-prefix fixture — the only variable vs the parsing baseline is
    // the `4` in the ID).
    const md = '<decisions>\n- **D4-01:** a short single-line decision.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed',
      `A phase-prefixed colon bullet must parse. Got: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D4-01'],
      `The full prefixed id must be reported. Got: ${JSON.stringify(r.decisions)}`);
    assert.strictEqual(r.decisions[0].text, 'a short single-line decision.');
  });

  test('- **D12-01:** two-digit phase prefix parses', () => {
    const md = '<decisions>\n- **D12-01:** two-digit phase.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D12-01']);
  });

  test('em-dash form - **D4-01 — title** body parses with a phase prefix', () => {
    const md = '<decisions>\n- **D4-01 — the chosen datastore** use Postgres.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D4-01']);
  });

  test('titled-colon form - **D4-01: Title.** body parses with a phase prefix', () => {
    const md = '<decisions>\n- **D4-01: The chosen datastore.** use Postgres.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D4-01']);
  });

  test('D5-NN (the #2347 reproduction shape) now parses — the multi-phase convention is legal', () => {
    const md = '<decisions>\n'
      + '- **D5-01:** choose the primary datastore\n'
      + '- **D5-02:** pick the queue technology\n'
      + '- **D5-03:** settle on the auth model\n'
      + '</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed',
      `The exact #2347 fixture grammar must now be readable. Got: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D5-01', 'D5-02', 'D5-03']);
  });

  test('phase prefix + [tags] honors tags and trackable:false', () => {
    const md = '<decisions>\n- **D4-01 [informational]:** reference only.\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map((d) => d.id), ['D4-01']);
    assert.ok(ds[0].tags.includes('informational'),
      `Tags must survive the prefixed grammar. Got: ${JSON.stringify(ds[0])}`);
    assert.strictEqual(ds[0].trackable, false);
  });

  test("phase-prefixed decision under ### Claude's Discretion is non-trackable", () => {
    const md = "<decisions>\n### Claude's Discretion\n- **D4-01:** internal choice.\n</decisions>\n";
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map((d) => d.id), ['D4-01']);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('phase-prefixed bullet with a wrapped bold lead-in parses like the one-line form (#4130 x #3939)', () => {
    const oneLine = extractDecisions(inBlock('- **D4-01: Persist the raw delivery headers.** JSON arrays preserve order.'));
    const wrapped = extractDecisions(inBlock(
      '- **D4-01: Persist the raw delivery\n  headers.** JSON arrays preserve order.'));
    assert.strictEqual(oneLine.outcome, 'parsed');
    assert.strictEqual(wrapped.outcome, 'parsed',
      `A wrapped prefixed declaration must join and parse. Got: ${JSON.stringify(wrapped)}`);
    assert.deepStrictEqual(wrapped.decisions.map((d) => d.id), ['D4-01']);
    assert.deepStrictEqual(wrapped.decisions[0].text, oneLine.decisions[0].text,
      'Wrapping must stay markdown-insignificant for prefixed ids too.');
  });
});

describe('parseDecisions — phase-prefix failure modes stay loud, prose stays prose (#4130)', () => {
  test('- **D4x-01:** (non-digit inside the prefix) is a genuine parse-miss → could-not-parse', () => {
    const md = '<decisions>\n- **D4x-01:** a typo in the phase prefix.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'could-not-parse',
      `A malformed phase prefix must fail loud, not silently extract or vanish. Got: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.decisions, [],
      'A malformed prefix must never be extracted as a decision.');
  });

  test('a malformed phase-prefixed bullet poisons a file that also has valid decisions (FIX B parity)', () => {
    // Before the fix this file was outcome:parsed with D-01 only — D4x-02 was
    // silently invisible to the extractor AND the guard (the exact silent-drop
    // class #1365 FIX B exists to prevent, surviving for prefixed ids).
    const md = '<decisions>\n- **D-01:** valid.\n- **D4x-02:** malformed prefix.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'could-not-parse',
      `A parse-miss on a prefixed bullet must block, not silently drop. Got: ${JSON.stringify(r)}`);
  });

  test('D-initial hyphenated prose labels stay none-present (the widened guard must not reach prose)', () => {
    // `Deferred-until-later` is `D` + letters + `-`: the letter-initial run is
    // a prose word, not a digit-run phase prefix, so it must stay invisible to
    // the parse-miss guard exactly as before #4130.
    const md = '<decisions>\n'
      + '- **Deferred-until-later:** we revisit the queue choice next phase.\n'
      + '- **Note:** nothing else was decided here.\n'
      + '</decisions>\n';
    assert.strictEqual(extractDecisions(md).outcome, 'none-present',
      'D-initial hyphenated prose labels must not become parse-misses.');
  });

  test('bare D-01 baseline and D-INFRA-01 alnum tail parse unchanged', () => {
    const md = '<decisions>\n- **D-01:** bare.\n- **D-INFRA-01:** alnum tail.\n</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.deepStrictEqual(r.decisions.map((d) => d.id), ['D-01', 'D-INFRA-01']);
  });
});

// ─── #4130 properties: detector/extractor ID-grammar parity ─────────────────
//
// The bug was a grammar DISAGREEMENT: the #2347 evidence detector accepted
// `D4-01` as decision-shaped while the extractor's `**D-` anchor rejected it,
// so the file failed loud as a whole instead of being read. These properties
// pin the parity invariant in both directions for the D-prefixed universe:
// every well-formed digit-prefixed id (the shape the detector already calls
// decision-shaped) must PARSE to its exact id in every bullet form, and every
// malformed variant of that shape (a non-digit inside the digit-run prefix)
// must FAIL LOUD — never a silent none-present, never a silent extraction.
// If either grammar drifts from the other again, one of these fires.

describe('#4130 properties: digit-prefixed ids parse or fail loud, never vanish', () => {
  const phasePrefixedIdArb = fc
    .tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }))
    .map(([phase, seq]) => `D${phase}-${String(seq).padStart(2, '0')}`);

  test('property: every well-formed phase-prefixed bullet parses to its exact id, in every form', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        phasePrefixedIdArb,
        tagsArb,
        proseArb(2, 8),
        proseArb(1, 6),
        fc.boolean(),
        (form, id, tags, title, body, withCategory) => {
          const heading = withCategory ? '### Implementation\n' : '';
          const line = renderBullet(form, id, tags, title, body);
          const r = extractDecisions(inBlock(heading + line));
          assert.strictEqual(r.outcome, 'parsed',
            `A well-formed phase-prefixed declaration must parse. form=${form} line=${JSON.stringify(line)} → ${JSON.stringify(r)}`);
          assert.deepStrictEqual(r.decisions.map((d) => d.id), [id],
            `The prefixed id must round-trip exactly. form=${form} id=${id} → ${JSON.stringify(r.decisions)}`);
          return true;
        },
      ),
    );
  });

  test('property: a non-digit injected into the phase prefix fails loud, never silently', (t) => {
    const originalWarn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = originalWarn; });

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BULLET_FORMS)),
        phasePrefixedIdArb,
        fc.constantFrom('x', 'X', 'z'),
        (form, id, junk) => {
          const badId = id.replace(/^(D\d)/, `$1${junk}`);
          const line = renderBullet(form, badId, '', 'title', 'body');
          const r = extractDecisions(inBlock(line));
          assert.strictEqual(r.outcome, 'could-not-parse',
            `A malformed phase prefix must fail loud. form=${form} line=${JSON.stringify(line)} → ${JSON.stringify(r)}`);
          assert.deepStrictEqual(r.decisions, [],
            `A malformed phase prefix must never be extracted. form=${form} line=${JSON.stringify(line)}`);
          return true;
        },
      ),
    );
  });
});

// ─── #4130 gate-level: the gates read phase-prefixed decisions end-to-end ────

describe('check.decision-coverage-plan — phase-prefixed decisions are readable (#4130)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-4130-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('FAIL-FIRST: CONTEXT.md with D4-01 covered by the plan → passed:true, total:1, covered:1', () => {
    // Before the fix: reason could-not-parse, total 0 — the gate reported a
    // format problem for the whole file instead of a coverage result.
    writeContextFile(phaseDir, [
      '# Phase 4 Context',
      '',
      '<decisions>',
      '### Implementation',
      '- **D4-01:** use the phase-scoped datastore',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D4-01: provision the datastore\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, true,
      `A plan covering the prefixed decision must pass. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.total, 1,
      `The prefixed decision must be counted. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.covered, 1,
      `The prefixed decision must be seen as covered. Got: ${JSON.stringify(parsed)}`);
  });

  test('D4-01 not covered → passed:false with the uncovered id, NOT could-not-parse', () => {
    writeContextFile(phaseDir, [
      '# Phase 4 Context',
      '',
      '<decisions>',
      '- **D4-01:** use the phase-scoped datastore',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- Something unrelated.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '{}');
    assert.strictEqual(parsed.passed, false,
      `An uncovered prefixed decision must fail on coverage. Got: ${JSON.stringify(parsed)}`);
    assert.notStrictEqual(parsed.reason, 'could-not-parse',
      `The gate must report a coverage result, not a format problem. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 0);
    assert.deepStrictEqual(
      (parsed.uncovered || []).map((u) => u.id),
      ['D4-01'],
      `The uncovered row must carry the prefixed id. Got: ${JSON.stringify(parsed.uncovered)}`,
    );
  });
});

describe('check.decision-coverage-verify — phase-prefixed decisions are readable (#4130)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-4130v-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('verify reads D4-01 and honors it when the plan mentions it (no could-not-parse)', () => {
    writeContextFile(phaseDir, [
      '# Phase 4 Context',
      '',
      '<decisions>',
      '- **D4-01:** use the phase-scoped datastore',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D4-01: provision the datastore\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runGsdTools(
      ['query', 'check.decision-coverage-verify', phaseDir, contextPath],
      tmpDir,
    );
    const parsed = JSON.parse(result.output || '{}');
    assert.notStrictEqual(parsed.reason, 'could-not-parse',
      `Verify must read prefixed decisions, not report a format mismatch. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.total, 1,
      `The prefixed decision must be counted. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.honored, 1,
      `A plan mentioning D4-01 honors it. Got: ${JSON.stringify(parsed)}`);
  });
});

// ─── #4130 follow-up: check decision-coverage-plan --context <path> ──────────

/**
 * Row-1 failing-first regression for the --context flag (maintainer-directed
 * follow-up to #4130, merged as #4357).
 *
 * Convention mirrored from the ONE flag-driven sibling check verb
 * (`check predicate`, src/check-command-router.cts): `--flag value` pairs
 * parsed with parsePredicateFlags semantics, `--context <path>` supplying the
 * CONTEXT.md path, the flag WINNING over a same-purpose positional, and the
 * positional form kept working (no sibling deprecates positionals; the
 * plan-phase workflow caller passes positionals).
 *
 * Before the fix (probed on the base build):
 *   - `--context <path>` alone landed `--context` in the args[2] phase slot →
 *     plans scanned in a nonexistent `<project>/--context` dir → every
 *     decision falsely uncovered (passed:false where the positional form
 *     passes).
 *   - `<phase> --context <path>` put the literal `--context` in the context
 *     slot → silent "CONTEXT.md missing" green skip.
 */
describe('check.decision-coverage-plan — --context flag matches the positional form (#4130 follow-up)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-4130fu-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  /** Invoke the gate with a raw arg vector (after the subcommand). */
  const runDcp = (args) => runGsdTools(['query', 'check.decision-coverage-plan', ...args], tmpDir);

  const coveredContext = () => [
    '# Phase 4 Context',
    '',
    '<decisions>',
    '- **D4-01:** use the phase-scoped datastore',
    '</decisions>',
    '',
  ].join('\n');

  const coveredPlan = () => '# Plan\n## Must Haves\n- D4-01: provision the datastore\n';

  test('--context <path> alone routes the path into the context slot (no stray flag token anywhere)', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    // The phase dir is a SEPARATE positional; `--context`-only means no phase
    // was given, which routes exactly like an empty phase positional. The
    // assertion that matters: the flag's VALUE reaches the gate (the decision
    // is counted and reported uncovered — parsed from the flag's path), and
    // the output is identical to the equivalent positional invocation.
    const viaFlag = JSON.parse(runDcp(['--context', contextPath]).output || '{}');
    const viaEmptyPhasePositional = JSON.parse(runDcp(['', contextPath]).output || '{}');

    assert.deepStrictEqual(viaFlag, viaEmptyPhasePositional,
      `--context-only must route like the empty-phase positional.\nflag: ${JSON.stringify(viaFlag)}\npos:  ${JSON.stringify(viaEmptyPhasePositional)}`);
    assert.strictEqual(viaFlag.total, 1,
      `the decision must be read from the flag's path. Got: ${JSON.stringify(viaFlag)}`);
    assert.strictEqual(viaFlag.passed, false, 'no phase → no plans scanned → coverage gap, not a parse accident');
    assert.deepStrictEqual((viaFlag.uncovered || []).map((u) => u.id), ['D4-01']);
  });

  test('ROW-1 RED: <phase> --context <path> composes (flag value reaches the gate, not the phase slot)', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    const viaFlag = JSON.parse(runDcp([phaseDir, '--context', contextPath]).output || '{}');
    const viaPositional = JSON.parse(runDcp([phaseDir, contextPath]).output || '{}');

    // Before the fix: the literal `--context` was taken as the context path →
    // silent "CONTEXT.md missing" green skip.
    assert.deepStrictEqual(viaFlag, viaPositional,
      `phase + --context must compose.\nflag: ${JSON.stringify(viaFlag)}\npos:  ${JSON.stringify(viaPositional)}`);
    assert.strictEqual(viaFlag.passed, true);
  });

  test('ROW-1 RED: --context <path> <phase> (flag first) is order-independent', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    const viaFlagFirst = JSON.parse(runDcp(['--context', contextPath, phaseDir]).output || '{}');
    const viaPositional = JSON.parse(runDcp([phaseDir, contextPath]).output || '{}');
    assert.deepStrictEqual(viaFlagFirst, viaPositional);
    assert.strictEqual(viaFlagFirst.passed, true);
    assert.strictEqual(viaFlagFirst.covered, 1);
  });

  test('ROW-1 RED: --context wins when both flag and positional context are supplied', () => {
    // Flag file: one covered decision (passed:true, total:1).
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const flagContext = path.join(phaseDir, 'CONTEXT.md');
    // Positional decoy: a none-present file (would skip with total:0).
    const decoyContext = path.join(phaseDir, 'DECOY-CONTEXT.md');
    fs.writeFileSync(decoyContext, '# Nothing decision-shaped here.\n');

    // Hold the PHASE constant so the comparison isolates WHICH context file
    // was read: decoy-positional + flag must equal flag-alone-with-phase.
    const viaBoth = JSON.parse(runDcp([phaseDir, decoyContext, '--context', flagContext]).output || '{}');
    const viaFlag = JSON.parse(runDcp([phaseDir, '--context', flagContext]).output || '{}');

    assert.deepStrictEqual(viaBoth, viaFlag,
      `--context must win over the positional context.\nboth: ${JSON.stringify(viaBoth)}\nflag: ${JSON.stringify(viaFlag)}`);
    assert.strictEqual(viaBoth.passed, true, 'the flag file (covered decision) must be the one read');
    assert.strictEqual(viaBoth.total, 1);
  });

  test('uncovered decision via --context reports the coverage gap (no false pass, no false fail)', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- Something unrelated.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    const viaFlag = JSON.parse(runDcp(['--context', contextPath]).output || '{}');
    const viaPositional = JSON.parse(runDcp([phaseDir, contextPath]).output || '{}');
    assert.deepStrictEqual(viaFlag, viaPositional);
    assert.strictEqual(viaFlag.passed, false);
    assert.deepStrictEqual((viaFlag.uncovered || []).map((u) => u.id), ['D4-01']);
  });

  test('could-not-parse CONTEXT via --context fails loud exactly like the positional form', () => {
    writeContextFile(phaseDir, [
      '<decisions>',
      '- **DEC-01:** an ID grammar the parser does not support',
      '</decisions>',
      '',
    ].join('\n'));
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    const viaFlag = JSON.parse(runDcp(['--context', contextPath]).output || '{}');
    const viaPositional = JSON.parse(runDcp([phaseDir, contextPath]).output || '{}');
    assert.deepStrictEqual(viaFlag, viaPositional);
    assert.strictEqual(viaFlag.passed, false);
    assert.strictEqual(viaFlag.reason, 'could-not-parse');
  });

  test('back-compat: the positional form is byte-identical to a no-flag run (control row)', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    const a = runDcp([phaseDir, contextPath]).output;
    const b = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir).output;
    assert.strictEqual(a, b);
    assert.strictEqual(JSON.parse(a || '{}').passed, true);
  });

  test('--context <nonexistent-path> keeps the legitimate green skip', () => {
    const missing = path.join(phaseDir, 'NOPE-CONTEXT.md');
    const viaFlag = JSON.parse(runDcp(['--context', missing]).output || '{}');
    const viaPositional = JSON.parse(runDcp([phaseDir, missing]).output || '{}');
    assert.deepStrictEqual(viaFlag, viaPositional);
    assert.strictEqual(viaFlag.passed, true);
    assert.strictEqual(viaFlag.skipped, true);
    assert.strictEqual(viaFlag.reason, 'CONTEXT.md missing');
  });

  test('valueless trailing --context falls through to the #2770 fail-closed caller error', () => {
    // Mirrors the sibling parser (parsePredicateFlags): a `--flag` with no
    // value is a boolean, never a path. The caller supplied no context path,
    // which #2770 treats as a caller error — NOT as "no CONTEXT.md".
    const viaFlag = JSON.parse(runDcp([phaseDir, '--context']).output || '{}');
    assert.strictEqual(viaFlag.passed, false,
      `A valueless --context is a caller error, not a green skip. Got: ${JSON.stringify(viaFlag)}`);
    assert.strictEqual(viaFlag.reason, 'missing context path argument');
  });

  test('negative space: decision-coverage-verify keeps its positional arg surface (flag is plan-only)', () => {
    writeContextFile(phaseDir, coveredContext());
    writePlanFile(phaseDir, '01', coveredPlan());
    const contextPath = path.join(phaseDir, 'CONTEXT.md');

    // The verify gate is out of scope by directive: its positional contract
    // is unchanged, and it does not gain --context handling.
    const verify = JSON.parse(runGsdTools(['query', 'check.decision-coverage-verify', phaseDir, contextPath], tmpDir).output || '{}');
    assert.strictEqual(verify.total, 1);
    assert.strictEqual(verify.honored, 1);

    const verifyFlagForm = JSON.parse(runGsdTools(['query', 'check.decision-coverage-verify', phaseDir, '--context', contextPath], tmpDir).output || '{}');
    assert.strictEqual(verifyFlagForm.skipped, true,
      `verify must keep reading args[3] positionally (unchanged base behavior). Got: ${JSON.stringify(verifyFlagForm)}`);
    assert.strictEqual(verifyFlagForm.reason, 'CONTEXT.md missing');
  });
});

// ─── #4130 follow-up: parseDecisions regex hardening (quadratic backtracking) ─

/**
 * Row-1 failing-first regression for the regex-seam hardening.
 *
 * The #4357 security review measured ~740ms @ 40k chars on pathological
 * single bullets and deferred the fix here. Mechanism (10-diagnosis.md):
 * (1) the ID tail `[A-Za-z0-9][A-Za-z0-9_-]*` overlaps the pre-separator
 *     class `[^:*]*`, so a failing match re-splits the tail O(n) times with
 *     an O(n) scan each — O(n²);
 * (2) the em-dash form's `[^*]*[—–]` first separator can retry at every dash
 *     position with an O(n) scan after each — O(n²).
 *
 * Hardening under test (byte-identical on all legal inputs):
 * - atomic ID via the `(?=(X))\1` lookahead emulation (group 1 unchanged);
 * - em-dash first separator narrowed to `[^*—–]*[—–]` (FIRST dash, unique
 *   split point).
 *
 * Repo rule: no wall-time asserts. Node's RegExp engine exposes no injectable
 * step counter, so no honest deterministic op-count proxy exists (documented
 * in 10-diagnosis.md); the pin is structural (lattice), differential (vs the
 * frozen pre-hardening reference below), and correctness-at-scale.
 */
describe('parseDecisions hardening — regex lattice pins the mechanism (#4130 follow-up)', () => {
  const SRC = path.resolve(__dirname, '../src/decisions.cts');

  /** Extract a `const NAME = '<value>';` single-quoted string literal. */
  function readStringConst(source, name) {
    const m = source.match(new RegExp(`^const ${name} = '([^']*)';$`, 'm'));
    assert.ok(m, `source must declare const ${name} as a plain string literal`);
    return m[1];
  }

  /**
   * Extract a `new RegExp(`...`)` template body, substitute ${CONSTS}, and
   * unescape the template-literal double backslashes — the result is the
   * exact regex SOURCE STRING the module compiles.
   */
  function readRegExpTemplate(source, varName, consts) {
    const m = source.match(new RegExp(`^const ${varName} = new RegExp\\(\n  \`([^\`]+)\`,?\n?\\);?`, 'm'));
    assert.ok(m, `source must declare ${varName} as a template-literal RegExp`);
    let out = m[1];
    for (const [name, value] of Object.entries(consts)) {
      out = out.split(`\${${name}}`).join(value);
    }
    assert.ok(!out.includes('$' + '{'), `unsubstituted template placeholder in ${varName}`);
    return out.replace(/\\\\/g, '\\');
  }

  const source = fs.readFileSync(SRC, 'utf8');
  const idSource = readStringConst(source, 'DECISION_ID_SOURCE');
  const idAttempt = readStringConst(source, 'ID_ATTEMPT_SOURCE');
  const consts = { DECISION_ID_SOURCE: idSource, ID_ATTEMPT_SOURCE: idAttempt };
  const colonSrc = readRegExpTemplate(source, 'bulletColonRe', consts);
  const emDashSrc = readRegExpTemplate(source, 'bulletEmDashRe', consts);
  const titledSrc = readRegExpTemplate(source, 'bulletTitledColonRe', consts);

  test('ROW-1 RED: the ID grammar constants are unchanged (the parity pin survives hardening)', () => {
    assert.strictEqual(idSource, 'D[0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*');
    assert.strictEqual(idAttempt, 'D(?:[0-9][A-Za-z0-9]*)?-');
  });

  test('ROW-1 RED: all three bullet grammars consume the ID atomically (no tail re-split)', () => {
    // The (?=(X))\1 lookahead emulation is what makes the ID give-back
    // impossible: lookarounds are atomic in ECMAScript, and the backreference
    // must replay exactly what the lookahead captured. On the base the
    // sources had `(D...-...)` bare — the quadratic driver #1.
    const atomic = `(?=(${idSource}))\\1`;
    for (const [name, src] of [['bulletColonRe', colonSrc], ['bulletEmDashRe', emDashSrc], ['bulletTitledColonRe', titledSrc]]) {
      assert.ok(src.includes(atomic), `${name} must wrap the ID in the atomic (?=(X))\\1 emulation:\n${src}`);
    }
  });

  test('ROW-1 RED: the em-dash first separator is narrowed to the FIRST dash (no dash re-split)', () => {
    // `[^*]*[—–]` admits O(k) separator split points on a dash-laden title;
    // `[^*—–]*[—–]` has exactly one. The narrowing is behavior-preserving
    // because every candidate dash lies before the first `*` and the second
    // `[^*]*` scan reaches that same first star from any candidate.
    assert.ok(emDashSrc.includes('[^*—–]*[—–]'),
      `bulletEmDashRe must use the narrowed first separator:\n${emDashSrc}`);
    assert.ok(!emDashSrc.includes('[^*]*[—–]'),
      `bulletEmDashRe must not retain the overlapping first separator:\n${emDashSrc}`);
  });

  test('lattice: no unbounded class quantifier is immediately followed by an atom its class accepts', () => {
    // The adjacency that admitted both quadratic drivers: `C*` directly
    // followed by an atom that can start with a char C also accepts lets the
    // engine trade characters between the two — O(n) splits × O(n) rescans.
    // After the hardening every unbounded bracketed class run in the three
    // grammars is followed by a token disjoint from its class (or by a group
    // boundary / the atomic backreference replay, which cannot re-split).
    const joined = `${colonSrc}\n${emDashSrc}\n${titledSrc}`;
    const quantifiers = [...joined.matchAll(/\[((?:[^\]\\]|\\.)*)\](\*|\+)/g)];
    assert.ok(quantifiers.length >= 6, 'expected the seam\'s class quantifiers to be found');

    /** Membership predicate for a class BODY, honoring ranges and escapes. */
    function classPredicate(body) {
      const negated = body.startsWith('^');
      const inner = negated ? body.slice(1) : body;
      const members = new Set();
      const chars = [...inner];
      for (let i = 0; i < chars.length; i++) {
        let ch = chars[i];
        if (ch === '\\' && i + 1 < chars.length) ch = chars[++i];
        // Range: a-b where a and b are single member chars.
        if (chars[i + 1] === '-' && chars[i + 2] !== undefined && chars[i + 2] !== ']') {
          const lo = ch;
          let hi = chars[i + 2];
          if (hi === '\\' && chars[i + 3] !== undefined) { i += 3; hi = chars[i]; } else { i += 2; }
          for (let c = lo.charCodeAt(0); c <= hi.charCodeAt(0); c++) members.add(String.fromCharCode(c));
          continue;
        }
        members.add(ch);
      }
      return (ch) => (negated ? !members.has(ch) : members.has(ch));
    }

    /**
     * First-set of the atom that follows a quantified class, as a membership
     * predicate. `null` = boundary — group close, anchor, end, or the `\1`
     * backreference of the atomic wrapper (its first-set is the captured id
     * run, replayed verbatim: it cannot trade characters with the quantifier,
     * which is the entire point of the wrapper).
     */
    function nextAtomFirstSet(src, at) {
      if (at >= src.length) return null;
      const c = src[at];
      if (c === ')' || c === '$' || c === '|') return null;
      if (c === '\\') {
        const nxt = src[at + 1];
        if (nxt >= '0' && nxt <= '9') return null; // backreference replay — skip
        return (ch) => ch === nxt;
      }
      if (c === '[') {
        const close = src.indexOf(']', at);
        return classPredicate(src.slice(at + 1, close));
      }
      return (ch) => ch === c;
    }

    for (const m of quantifiers) {
      const body = m[1];
      const quant = m[2];
      const classAccepts = classPredicate(body);
      const firstSet = nextAtomFirstSet(joined, m.index + m[0].length);
      if (firstSet === null) continue;
      // A witness char the class accepts that the following atom also accepts.
      const ALPHABET = '*:-[]()Ds01_—–\\ \tnA';
      const witness = [...ALPHABET].find((ch) => classAccepts(ch) && firstSet(ch));
      assert.ok(witness === undefined,
        `unbounded quantifier [${body}]${quant} is followed by an atom accepting '${witness}' which its class also accepts — adjacency overlap:\n${joined.slice(m.index, m.index + m[0].length + 10)}`);
    }
  });

  test('lattice: capture-group indices are preserved (id, tags, body)', () => {
    // (?=(X))\1 keeps group 1 = the full id (the lookahead's capture IS group
    // 1), so the handlers' match[1]/[2]/[3] reads stay untouched. Pin the
    // count so a refactor cannot silently renumber the groups.
    for (const [name, src] of [['bulletColonRe', colonSrc], ['bulletEmDashRe', emDashSrc], ['bulletTitledColonRe', titledSrc]]) {
      const groups = (src.match(/\(/g) || []).length - (src.match(/\(\?:/g) || []).length - (src.match(/\(\?=/g) || []).length;
      assert.strictEqual(groups, 3, `${name} must keep exactly 3 capturing groups (id/tags/body):\n${src}`);
    }
  });
});

describe('parseDecisions hardening — byte-identical vs the pre-hardening reference (#4130 follow-up)', () => {
  /**
   * FROZEN REFERENCE — the three bullet grammars exactly as they shipped on
   * origin/next @ e6d047decc (PR #4357). The hardened module must agree with
   * this reference on match/no-match AND all capture groups for every input
   * the generator can produce. If the reference and the module ever disagree,
   * behavior drifted — this is the "pure hardening" contract.
   */
  const REF_ID = 'D[0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*';
  const refColon = new RegExp(`^\\s*-\\s+\\*\\*(${REF_ID})(?:\\s*\\[([^\\]]+)\\])?[^:*]*:\\*\\*\\s*(.*)$`);
  const refEmDash = new RegExp(`^\\s*-\\s+\\*\\*(${REF_ID})(?:\\s*\\[([^\\]]+)\\])?[^*]*[—–][^*]*\\*\\*\\s*(.*)$`);
  const refTitled = new RegExp(`^\\s*-\\s+\\*\\*(${REF_ID})(?:\\s*\\[([^\\]]+)\\])?[^:*]*:[^:*]*\\*\\*\\s*(.*)$`);
  const refGuard = /^\s*-\s+\*\*D(?:[0-9][A-Za-z0-9]*)?-/;
  const refBoldLeadIn = /^\s*-\s+\*\*[A-Z]+[0-9]*-[A-Za-z0-9]/m;
  const refToken = /\bD[0-9]*-[A-Za-z0-9]/m;

  /**
   * The expected single-bullet outcome, computed by the frozen reference:
   * the three grammars in the module's precedence order, then the parse-miss
   * guard, then the FIX A evidence detectors (bold-lead-in / bare token) —
   * exactly the module's single-line block-path decision order.
   */
  function referenceOutcome(line) {
    const m = refColon.exec(line) || refEmDash.exec(line) || refTitled.exec(line);
    if (m) {
      const tags = m[2] ? m[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
      return {
        outcome: 'parsed',
        decisions: [{
          id: m[1],
          text: (m[3] || '').trim(),
          category: '',
          tags,
          trackable: !tags.some((t) => ['informational', 'folded', 'deferred'].includes(t)),
        }],
      };
    }
    if (refGuard.test(line)) return { outcome: 'could-not-parse', decisions: [] };
    if (refBoldLeadIn.test(line) || refToken.test(line)) return { outcome: 'could-not-parse', decisions: [] };
    return { outcome: 'none-present', decisions: [] };
  }

  // Generator: adversarial single-line bullets around the seam's alphabet.
  const idArb = fc.oneof(
    fc.integer({ min: 1, max: 99 }).map((n) => `D-${String(n).padStart(2, '0')}`),
    fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 99 }))
      .map(([p, n]) => `D${p}-${String(n).padStart(2, '0')}`),
    fc.constantFrom('D-INFRA-01', 'D-7', 'D-carry_2', 'D4x-01', 'DEC-01', 'D-notes'),
  );
  const fuzzArb = (maxWords) => fc.array(
    fc.constantFrom('use', 'the:', 'a*', '**', '—', '–', '[x]', 'y]', 'ratio 3:1', '-', 'D4-01', 'x,', 'why', 'ok', '**D-99:', 'until'),
    { maxLength: maxWords },
  ).map((w) => w.join(' '));
  const sepArb = fc.constantFrom(':', ' — ', ': ', ' —', ':** ', ' ');
  const leadArb = fc.constantFrom('', '  ', '\t');

  const lineArb = fc.tuple(leadArb, idArb, fc.constantFrom('', ' [informational]', ' [a, b]', ' [unterminated'), sepArb, fuzzArb(14), fuzzArb(10), fc.boolean())
    .map(([lead, id, tags, sep, mid, tail, boldClose]) => {
      const close = boldClose ? '**' : '';
      return `${lead}- **${id}${tags}${sep}${mid}${close} ${tail}`;
    });

  test('property: hardened module === frozen pre-hardening reference on every generated bullet', () => {
    fc.assert(fc.property(lineArb, (line) => {
      const expected = referenceOutcome(line);
      const got = extractDecisions(inBlock(line));
      assert.strictEqual(got.outcome, expected.outcome,
        `outcome drifted on ${JSON.stringify(line)}: got ${got.outcome}, want ${expected.outcome}`);
      assert.deepStrictEqual(got.decisions, expected.decisions,
        `decisions drifted on ${JSON.stringify(line)}:\ngot:  ${JSON.stringify(got.decisions)}\nwant: ${JSON.stringify(expected.decisions)}`);
      return true;
    }));
  });

  test('em-dash titles with MULTIPLE dashes capture identically to the reference (first-dash narrowing)', () => {
    fc.assert(fc.property(
      decisionIdArb,
      fuzzArb(6),
      fuzzArb(6),
      (id, title, body) => {
        const line = `- **${id} — ${title} — ${title}** ${body}`;
        const expected = referenceOutcome(line);
        const got = extractDecisions(inBlock(line));
        assert.strictEqual(got.outcome, expected.outcome);
        assert.deepStrictEqual(got.decisions, expected.decisions,
          `multi-dash title drifted on ${JSON.stringify(line)}`);
        return true;
      },
    ));
  });

  test('the #4130/#3939/#1639 fixture grammar round-trips byte-identically', () => {
    const fixtures = [
      ['- **D-01:** a short single-line decision.', 'D-01', 'a short single-line decision.'],
      ['- **D4-01:** phase-prefixed.', 'D4-01', 'phase-prefixed.'],
      ['- **D12-01:** two-digit phase.', 'D12-01', 'two-digit phase.'],
      ['- **D-INFRA-01:** alnum tail.', 'D-INFRA-01', 'alnum tail.'],
      ['- **D-01 [informational]:** tagged.', 'D-01', 'tagged.'],
      ['- **D4-01 — title** body here', 'D4-01', 'body here'],
      ['- **D-01 — a — b — c** body', 'D-01', 'body'],
      ['- **D-01: Title.** body', 'D-01', 'body'],
      ['- **D-01 pre-colon prose:** text', 'D-01', 'text'],
    ];
    for (const [line, wantId, wantText] of fixtures) {
      const r = extractDecisions(inBlock(line));
      assert.strictEqual(r.outcome, 'parsed', `fixture must still parse: ${JSON.stringify(line)}`);
      assert.strictEqual(r.decisions[0].id, wantId, `id drifted on ${JSON.stringify(line)}`);
      assert.strictEqual(r.decisions[0].text, wantText, `text drifted on ${JSON.stringify(line)}`);
    }
    // Typo'd prefix and prose labels keep their #4130 outcomes.
    assert.strictEqual(extractDecisions(inBlock('- **D4x-01:** typo')).outcome, 'could-not-parse');
    assert.strictEqual(extractDecisions(inBlock('- **Deferred-until-X:** prose')).outcome, 'none-present');
  });
});

describe('parseDecisions hardening — pathological single bullets terminate correctly (#4130 follow-up)', () => {
  // The #4357 cliff shapes at full scale. NO wall-time assert (repo rule):
  // under the hardening these complete in well under a millisecond each; if
  // the quadratic ambiguity is ever reintroduced these become CI timeouts,
  // never false passes. What is asserted is the CORRECT outcome.
  test('40k hyphen-laden ID tail (colon cliff shape) → could-not-parse via the guard', () => {
    const bullet = '- **D-' + 'a-'.repeat(20000);
    const r = extractDecisions(inBlock(bullet));
    assert.strictEqual(r.outcome, 'could-not-parse',
      'the malformed mega-bullet must fail loud (parse-miss guard), not hang or vanish');
    assert.deepStrictEqual(r.decisions, []);
  });

  test('40k dash run after the separator (em-dash cliff shape) → could-not-parse via the guard', () => {
    const bullet = '- **D-01 —' + '–'.repeat(40000 - 10);
    const r = extractDecisions(inBlock(bullet));
    assert.strictEqual(r.outcome, 'could-not-parse');
    assert.deepStrictEqual(r.decisions, []);
  });

  test('40k colon run (titled-colon cliff shape) → could-not-parse via the guard', () => {
    const bullet = '- **D-01: ' + 'x: '.repeat(13000);
    const r = extractDecisions(inBlock(bullet));
    assert.strictEqual(r.outcome, 'could-not-parse');
  });

  test('40k LEGAL single-line decision parses with its text byte-identical (no clamp)', () => {
    const text = 'use the phase-scoped datastore '.repeat(1400).trim();
    const bullet = `- **D4-01:** ${text}`;
    const r = extractDecisions(inBlock(bullet));
    assert.strictEqual(r.outcome, 'parsed', 'a legal mega-bullet must parse — no line-length clamp exists');
    assert.strictEqual(r.decisions.length, 1);
    assert.strictEqual(r.decisions[0].id, 'D4-01');
    assert.strictEqual(r.decisions[0].text, text);
  });

  test('40k LEGAL wrapped-form decision still joins and parses (cliff shapes do not regress #3939)', () => {
    const text = 'provision the datastore '.repeat(1500).trim();
    const md = `<decisions>\n- **D4-01:** ${text}\n</decisions>\n`;
    const r = extractDecisions(md);
    assert.strictEqual(r.outcome, 'parsed');
    assert.strictEqual(r.decisions[0].text, text);
  });
});
