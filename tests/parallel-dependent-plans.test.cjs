// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Tests for bug #1587: parallel agents for dependent plans
 *
 * Validates that:
 * 1. gsd-planner.md assign_waves step explicitly checks files_modified overlap
 *    and mandates a later wave for any plan that shares files with a prior plan.
 * 2. execute-phase.md has a pre-spawn intra-wave files_modified overlap check
 *    and directs sequential execution when overlap is detected.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const PLANNER_AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const EXECUTE_PHASE_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);

// ---------------------------------------------------------------------------
// Anchored same-wave overlap gate (#3761)
//
// The test this replaces accepted six whole-file substrings, five of which have
// never appeared in agents/gsd-planner.md (`validate_waves`, `wave_validation`,
// `same wave` — the last killing the entire quality-gate arm, since the file has
// no quality_gate block at all). The sixth, `files_modified overlap`, matched one
// incidental pseudocode comment, so deleting the whole gate left the suite green.
// RULESET.TESTS.delete-bad-tests (CONTEXT.md:595): a vacuous-truth test is DELETED
// and replaced, not patched.
//
// The replacement anchors on the step's normative `**Rule:**` paragraph — the
// deliberate, documented declaration of the gate — scoped to the
// <step name="assign_waves"> block rather than to the document as a whole.
// ---------------------------------------------------------------------------

/**
 * Slice out the body of a named `<step name="…">` block.
 *
 * Index-based rather than regex-based: no backtracking surface over
 * caller-supplied document content, so no `local/no-unbounded-quantifier`
 * suppression is needed.
 *
 * @param {string} content Full agent `.md` document.
 * @param {string} stepName Value of the step's `name` attribute.
 * @returns {string|null} The body, or `null` when the block is absent or unterminated.
 */
function extractStepBody(content, stepName) {
  const open = `<step name="${stepName}">`;
  const start = content.indexOf(open);
  if (start === -1) return null;
  const bodyStart = start + open.length;
  const end = content.indexOf('</step>', bodyStart);
  if (end === -1) return null;
  return content.slice(bodyStart, end);
}

/**
 * The normative `**Rule:**` paragraph of a step body: the marker line plus every
 * continuation line up to the next blank line, joined into one string. CRLF-safe.
 *
 * @param {string} stepBody
 * @returns {string|null}
 */
function ruleParagraph(stepBody) {
  const lines = stepBody.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trimStart().startsWith('**Rule:**'));
  if (first === -1) return null;
  const paragraph = [];
  for (let i = first; i < lines.length && lines[i].trim() !== ''; i += 1) {
    paragraph.push(lines[i].trim());
  }
  return paragraph.join(' ');
}

/** Split a rule paragraph into sentences on `.` / `;` boundaries. */
function ruleSentences(paragraph) {
  return paragraph.split(/(?<=[.;])\s+/).filter((sentence) => sentence.trim() !== '');
}

/**
 * The four clauses that together make the rule a same-wave file-overlap GATE
 * rather than incidental prose. Liberal in spelling so that rewording under the
 * agent file's size-cap pressure does not red the suite; strict about all four
 * being present, so that gutting the gate does.
 */
const SAME_WAVE_RULE_CLAUSES = [
  { name: 'wave scope', pattern: /\bwave\b/i },
  { name: 'files_modified subject', pattern: /files_modified/ },
  { name: 'prohibition', pattern: /\b(?:zero|no|not|never)\b/i },
  { name: 'overlap predicate', pattern: /overlap|shar(?:e|es|ing)|conflict|touch(?:es|ing)?/i },
];

/**
 * @param {string|null} stepBody Output of {@link extractStepBody}.
 * @returns {string[]} Names of the required clauses the step's rule fails to
 *   satisfy. `[]` means the gate is declared.
 *
 * All four clauses must hold in ONE sentence. Four clauses scattered across a
 * paragraph are co-occurrence, not a rule — that is #3761's defect in miniature,
 * one level down, and it is what a whole-paragraph conjunction would let through.
 */
function missingSameWaveRuleClauses(stepBody) {
  if (stepBody === null) return ['<step name="assign_waves"> block'];
  const paragraph = ruleParagraph(stepBody);
  if (paragraph === null) return ['**Rule:** paragraph'];
  // Report the closest sentence's shortfall: it names what the rule is actually
  // missing rather than the union of every sentence's gaps.
  let closest = SAME_WAVE_RULE_CLAUSES.map((clause) => clause.name);
  for (const sentence of ruleSentences(paragraph)) {
    const missing = SAME_WAVE_RULE_CLAUSES.filter(
      (clause) => !clause.pattern.test(sentence)
    ).map((clause) => clause.name);
    if (missing.length < closest.length) closest = missing;
    if (closest.length === 0) break;
  }
  return closest;
}

/** Wrap a body in a named step block. */
function namedStep(name, body, eol = '\n') {
  return [`<step name="${name}">`, body, '</step>'].join(eol);
}

/** Wrap a body in an `assign_waves` step block. */
function assignWavesStep(body, eol = '\n') {
  return namedStep('assign_waves', body, eol);
}

/** The rule sentence as `agents/gsd-planner.md` currently declares it. */
const CANONICAL_RULE =
  '**Rule:** Same-wave plans must have zero `files_modified`/`files_deleted` overlap. ' +
  'After assigning waves, scan each wave; if any file appears in 2+ plans, bump the ' +
  'later plan to the next wave and repeat.';

// ---------------------------------------------------------------------------
// gsd-planner.md — wave assignment must account for files_modified overlap
// ---------------------------------------------------------------------------

describe('gsd-planner agent: files_modified wave ordering', () => {
  test('planner agent file exists', () => {
    assert.ok(fs.existsSync(PLANNER_AGENT_PATH), 'agents/gsd-planner.md should exist');
  });

  test('assign_waves step checks files_modified overlap', () => {
    const content = fs.readFileSync(PLANNER_AGENT_PATH, 'utf-8');
    // The assign_waves step must mention files_modified overlap as a wave-bumping condition
    assert.ok(
      content.includes('files_modified'),
      'assign_waves step should reference files_modified'
    );
    // Must state that overlap forces a later wave (not just "same plan or sequential")
    assert.ok(
      content.includes('files_modified overlap') ||
        content.includes('files_modified') &&
          (content.includes('later wave') || content.includes('strictly later wave')),
      'assign_waves step should explicitly require a later wave when files_modified overlap exists'
    );
  });

  test('assign_waves step contains explicit overlap → later-wave rule', () => {
    const content = fs.readFileSync(PLANNER_AGENT_PATH, 'utf-8');
    // Look for the assign_waves step block
    const assignWavesMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own agent .md content, fixed-size author-controlled content
      /<step name="assign_waves">([\s\S]*?)<\/step>/
    );
    assert.ok(assignWavesMatch, 'assign_waves step should exist in gsd-planner.md');

    const stepContent = assignWavesMatch[1];

    // Must mention files_modified as a wave-ordering factor inside the step
    assert.ok(
      stepContent.includes('files_modified'),
      'assign_waves step body must reference files_modified as a wave-assignment factor'
    );
  });

  test('assign_waves step treats files_modified overlap same as depends_on dependency', () => {
    const content = fs.readFileSync(PLANNER_AGENT_PATH, 'utf-8');
    const assignWavesMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own agent .md content, fixed-size author-controlled content
      /<step name="assign_waves">([\s\S]*?)<\/step>/
    );
    assert.ok(assignWavesMatch, 'assign_waves step should exist');

    const stepContent = assignWavesMatch[1];

    // The step must bump the wave when files_modified overlap exists
    assert.ok(
      stepContent.includes('overlap') || stepContent.includes('shared file'),
      'assign_waves step must handle file overlap as a wave-bumping condition'
    );
  });

  test('the real planner declares the same-wave zero-overlap rule inside assign_waves', () => {
    const content = fs.readFileSync(PLANNER_AGENT_PATH, 'utf-8');
    const stepBody = extractStepBody(content, 'assign_waves');
    assert.notEqual(stepBody, null, 'assign_waves step should exist in gsd-planner.md');
    assert.deepEqual(
      missingSameWaveRuleClauses(stepBody),
      [],
      'the assign_waves step must carry a normative **Rule:** paragraph stating that ' +
        'same-wave plans have zero files_modified overlap'
    );
  });
});

// ---------------------------------------------------------------------------
// The gate's own teeth (#3761)
//
// These drive the same predicate the test above uses, against planner content
// the DELETED test wrongly accepted. Row 1 is the failing-first regression: it
// is the exact shape PR #3758 produces — the pseudocode comment that carried
// `files_modified overlap` is gone, an unrelated pointer line carries the same
// substring, and the gate itself has been removed.
// ---------------------------------------------------------------------------

describe('gsd-planner agent: same-wave overlap gate has teeth', () => {
  test('a gutted assign_waves step is rejected even when an incidental "files_modified overlap" phrase survives', () => {
    const gutted = assignWavesStep(
      [
        '```',
        'waves = {}',
        'for each plan in plan_order:',
        '  plan.wave = 1',
        '```',
        '',
        'Beyond files_modified overlap: @~/.claude/gsd-core/references/planner-coupling.md',
      ].join('\n')
    );
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(gutted, 'assign_waves')),
      ['**Rule:** paragraph'],
      'the wave-ordering gate was deleted; an incidental substring must not stand in for it'
    );
  });

  test('a pseudocode comment is not the anchor — the normative Rule paragraph is', () => {
    const commentOnly = assignWavesStep(
      [
        '```',
        '# Implicit dependency: files_modified overlap forces a later wave.',
        'waves = {}',
        '```',
      ].join('\n')
    );
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(commentOnly, 'assign_waves')),
      ['**Rule:** paragraph'],
      'a comment inside a fenced block is illustrative, not a declared gate'
    );
  });

  test('the rule must live inside assign_waves — a whole-file match does not count', () => {
    const misplaced = [
      assignWavesStep(['```', 'waves = {}', '```'].join('\n')),
      '',
      CANONICAL_RULE,
    ].join('\n');
    assert.ok(
      misplaced.includes('Same-wave plans must have zero'),
      'precondition: the rule text IS present somewhere in the document'
    );
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(misplaced, 'assign_waves')),
      ['**Rule:** paragraph'],
      'the check is step-scoped; a rule stranded outside assign_waves is not the gate'
    );
  });

  test('dropping any single required clause from the rule reds the gate', () => {
    // limit-1: each variant satisfies exactly three of the four clauses.
    const variants = [
      {
        missing: 'wave scope',
        rule: '**Rule:** Plans must have zero `files_modified`/`files_deleted` overlap.',
      },
      {
        missing: 'files_modified subject',
        rule: '**Rule:** Same-wave plans must have zero file overlap.',
      },
      {
        missing: 'prohibition',
        rule: '**Rule:** Same-wave plans tolerate `files_modified` overlap.',
      },
      {
        missing: 'overlap predicate',
        rule: '**Rule:** Same-wave plans must have zero `files_modified` entries in common.',
      },
    ];
    for (const variant of variants) {
      assert.deepEqual(
        missingSameWaveRuleClauses(extractStepBody(assignWavesStep(variant.rule), 'assign_waves')),
        [variant.missing],
        `dropping "${variant.missing}" must be reported by name`
      );
    }
  });

  test('equivalent rewordings still satisfy the gate', () => {
    // limit: four clauses present in each, spelled differently. Between them these
    // exercise every alternative in every clause pattern, so a mutant that drops one
    // alternative from `prohibition` or `overlap predicate` is killed here rather than
    // surviving as an untested branch.
    const equivalents = [
      '**Rule:** Same-wave plans must have zero `files_modified`/`files_deleted` overlap.',
      '**Rule:** Same wave plans must never share `files_modified` or `files_deleted` entries.',
      '**Rule:** No two same-wave plans may end up sharing `files_modified` entries.',
      '**Rule:** Same-wave plans must not conflict on `files_modified` entries.',
      '**Rule:** A same-wave plan never shares `files_modified` entries with a sibling.',
      '**Rule:** No wave may contain two plans that touch the same `files_modified` path.',
    ];
    for (const rule of equivalents) {
      assert.deepEqual(
        missingSameWaveRuleClauses(extractStepBody(assignWavesStep(rule), 'assign_waves')),
        [],
        `rewording under the agent file size cap must not red the suite: ${rule}`
      );
    }
  });

  test('extra prose alongside the rule does not break the gate', () => {
    // limit+1: the four clauses plus an unrelated continuation line.
    const withExtra = assignWavesStep(
      [CANONICAL_RULE, 'Ties break toward the lower plan id for determinism.'].join('\n')
    );
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(withExtra, 'assign_waves')),
      [],
      'a longer rule paragraph is still a rule paragraph'
    );
  });

  test('CRLF line endings do not defeat the rule scan', () => {
    const crlf = assignWavesStep(['```', 'waves = {}', '```', '', CANONICAL_RULE].join('\r\n'), '\r\n');
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(crlf, 'assign_waves')),
      [],
      'a Windows checkout must read the gate the same way'
    );
  });

  test('an empty step body is rejected', () => {
    assert.deepEqual(
      missingSameWaveRuleClauses(''),
      ['**Rule:** paragraph'],
      'the predicate must not be vacuously true on nothing'
    );
  });

  test('a missing step is reported, not thrown', () => {
    const doc = assignWavesStep(CANONICAL_RULE);
    assert.equal(extractStepBody(doc, 'group_into_plans'), null);
    assert.deepEqual(missingSameWaveRuleClauses(extractStepBody(doc, 'group_into_plans')), [
      '<step name="assign_waves"> block',
    ]);
  });

  test('an unterminated step block yields null', () => {
    assert.equal(extractStepBody('<step name="assign_waves">\nwaves = {}\n', 'assign_waves'), null);
  });

  test('the right step is extracted when earlier steps precede it', () => {
    // gsd-planner.md carries 22 step blocks; the terminator search must start at the
    // TARGET step's body, not at the document head, or every step but the first
    // resolves to an empty body.
    const document = [
      namedStep('build_dependency_graph', 'placeholder'),
      '',
      assignWavesStep(CANONICAL_RULE),
      '',
      namedStep('group_into_plans', 'placeholder'),
    ].join('\n');
    const body = extractStepBody(document, 'assign_waves');
    assert.ok(body !== null && body.includes('**Rule:**'), 'assign_waves body should be found');
    assert.ok(
      !body.includes('placeholder'),
      'extraction must not bleed into a neighbouring step block'
    );
    assert.deepEqual(missingSameWaveRuleClauses(body), []);
  });

  test('clauses scattered across separate sentences are not a rule', () => {
    // The four clauses co-occurring in one paragraph is exactly the shape of the
    // defect this suite replaced, one level down: nothing here states that same-wave
    // plans must not share files_modified entries.
    const soup =
      '**Rule:** Same-wave plans never overlap in scope; see `files_modified` for details.';
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(assignWavesStep(soup), 'assign_waves')),
      ['files_modified subject'],
      'the gate must hold within a single sentence, not across a paragraph'
    );
  });

  test('a paragraph that explicitly disclaims the gate is rejected', () => {
    // Adversarial: every required word is present, and the paragraph says the opposite
    // of the rule. Sentence-scoping is what rejects it — a paragraph-wide conjunction
    // would score this as "gate present".
    const disclaimers = [
      '**Rule:** In the same wave, plans should never overlap in scope of ambition. This ' +
        'paragraph is not describing `files_modified` sharing as a problem; ' +
        '`files_modified` conflict between sibling plans is fine and requires no action, ' +
        'never mind resolution.',
      '**Rule:** Same-wave plans are great. Never mind `files_modified` for now. No ' +
        'overlap discussion needed here since this is just a scheduling nicety.',
    ];
    for (const paragraph of disclaimers) {
      assert.notDeepEqual(
        missingSameWaveRuleClauses(extractStepBody(assignWavesStep(paragraph), 'assign_waves')),
        [],
        `a paragraph that permits the thing the gate forbids must not pass: ${paragraph}`
      );
    }
  });

  test('a whitespace-only line ends the rule paragraph', () => {
    // Otherwise a later, unrelated line is absorbed into the paragraph and can supply a
    // clause the rule itself does not state — re-creating the #3761 defect one level down.
    const body = [
      '**Rule:** Same-wave plans must have zero `files_modified` entries in common.',
      '   ',
      'Plans that overlap are bumped by the executor instead.',
    ].join('\n');
    assert.deepEqual(
      missingSameWaveRuleClauses(extractStepBody(assignWavesStep(body), 'assign_waves')),
      ['overlap predicate'],
      'a clause stated outside the rule paragraph must not satisfy the rule'
    );
  });

  test('property: extractStepBody round-trips any rendered step block', () => {
    const stepName = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !/["<>]/.test(s));
    const stepBody = fc.string({ maxLength: 200 }).filter((s) => !s.includes('</step>'));
    fc.assert(
      fc.property(stepName, stepBody, (name, body) => {
        const doc = `intro\n<step name="${name}">${body}</step>\noutro`;
        return extractStepBody(doc, name) === body;
      }),
      { numRuns: 200, seed: 3761 }
    );
  });
});

// ---------------------------------------------------------------------------
// execute-phase.md — pre-spawn intra-wave overlap safety net
// ---------------------------------------------------------------------------

describe('execute-phase workflow: intra-wave files_modified overlap check', () => {
  test('execute-phase workflow file exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PHASE_PATH), 'workflows/execute-phase.md should exist');
  });

  test('execute_waves step contains intra-wave files_modified overlap check', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // The workflow must mention checking files_modified overlap before spawning
    assert.ok(
      content.includes('files_modified') &&
        (content.includes('overlap') || content.includes('intra-wave')),
      'execute-phase workflow should check for files_modified overlap within a wave before spawning'
    );
  });

  test('overlap detection is placed before agent spawning', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // Overlap check keyword must appear before the Task( spawn call
    const overlapIdx = content.indexOf('intra-wave') !== -1
      ? content.indexOf('intra-wave')
      : content.indexOf('files_modified overlap');
    const spawnIdx = content.indexOf('Spawn executor agents');
    assert.ok(overlapIdx !== -1, 'overlap check text should exist in execute-phase.md');
    assert.ok(spawnIdx !== -1, '"Spawn executor agents" heading should exist');
    assert.ok(
      overlapIdx < spawnIdx,
      'overlap check should appear before the "Spawn executor agents" section'
    );
  });

  test('workflow warns and switches to sequential when overlap detected', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // Must log a warning and force sequential execution for overlapping plans
    assert.ok(
      content.includes('sequentially') || content.includes('sequential'),
      'workflow should direct sequential execution when overlap is detected'
    );
    assert.ok(
      content.includes('overlap') && content.includes('warn'),
      'workflow should log a warning when files_modified overlap is detected in a wave'
    );
  });

  test('overlap check covers all plans in the wave, not just adjacent pairs', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // Must describe comparing all plans in the wave (set-intersection language)
    assert.ok(
      content.includes('all plans in') ||
        content.includes('all plans within') ||
        content.includes('each pair') ||
        content.includes('any two plans'),
      'overlap check should cover all plan pairs in the wave, not just adjacent ones'
    );
  });
});
