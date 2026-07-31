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

const { parseDecisions, extractDecisions } = require('../gsd-core/bin/lib/decisions.cjs');
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
  test('populated <decisions> block with a non-D- ID prefix is could-not-parse, not none-present', () => {
    const md = '<decisions>\n'
      + '- **D5-01:** choose the primary datastore\n'
      + '- **D5-02:** pick the queue technology\n'
      + '- **D5-03:** settle on the auth model\n'
      + '</decisions>\n';
    const r = extractDecisions(md);
    assert.strictEqual(r.decisions.length, 0, 'parser cannot read the D5- prefix (0 extracted)');
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
