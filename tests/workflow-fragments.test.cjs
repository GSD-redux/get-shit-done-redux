'use strict';

/**
 * Example-based unit tests for src/workflow-fragments.cts (compiled to
 * gsd-core/bin/lib/workflow-fragments.cjs) — issue #2930 (epic #1671 Phase 3).
 *
 * Covers 50-test-matrix.md rows 1-29 and 37 (unit level). Rows 30/31
 * (property) live in workflow-fragments.property.test.cjs; rows 32-36
 * (install-level, real spawn-install) are out of scope for this module's
 * unit suite per ADR-1671 "Architecture and contracts".
 *
 * No source-grep (CONTRIBUTING.md): every assertion is on typed values
 * (WorkflowSection records, ComposeResult metadata, byte counts) — never on
 * rendered text via `.includes()`/`.match()`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  parseWorkflowSections,
  toFragments,
  renderFragments,
  composeWorkflow,
  WHEN_VOCABULARY,
  REASON,
} = require('../gsd-core/bin/lib/workflow-fragments.cjs');
const { composeWithinBudget } = require('../gsd-core/bin/lib/context-composer.cjs');
const { selectSections } = require('../gsd-core/bin/lib/section-manifest.cjs');

const measureBytes = (text) => Buffer.byteLength(text, 'utf8');

/** Compose a document string from an array of lines, joined with '\n'. */
const doc = (...lines) => lines.join('\n');

/** Minimal InvocationFacts factory for the real-plan-phase.md D4 test below. */
function facts(overrides) {
  return { flags: new Set(), phaseNumber: null, hasPriorPhases: false, ...overrides };
}

// ─── Row 1: unmarked document (the 88/89 production shape) ─────────────────

describe('unmarked document round trip', () => {
  test('unmarkedDocumentRoundTripsByteIdentical', () => {
    const source = doc(
      '# Some Workflow',
      '',
      'Ordinary prose describing the workflow.',
      '',
      '## A heading',
      'More prose.',
      '',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].id, 'gap-0');
    assert.equal(sections[0].body, source);

    const rendered = composeWorkflow(source);
    assert.equal(rendered, source);
  });
});

// ─── Row 2: single well-formed marker pair ──────────────────────────────────

describe('single marker pair', () => {
  test('singleMarkerPairStripsMarkersAndPreservesBody', () => {
    const source = doc(
      'before prose',
      '<!-- gsd:section id="sec-a" when="flag:--wave" -->',
      'body line 1',
      'body line 2',
      '<!-- /gsd:section -->',
      'after prose',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, 'before prose\n');
    assert.equal(sections[1].explicit, true);
    assert.equal(sections[1].id, 'sec-a');
    assert.equal(sections[1].when, 'flag:--wave');
    assert.equal(sections[1].body, 'body line 1\nbody line 2\n');
    assert.equal(sections[2].explicit, false);
    assert.equal(sections[2].body, 'after prose');

    const rendered = composeWorkflow(source);
    assert.equal(rendered, 'before prose\nbody line 1\nbody line 2\nafter prose');
  });
});

// ─── Row 3: several disjoint pairs + unmarked gaps ─────────────────────────

describe('multiple disjoint marker pairs', () => {
  test('multiplePairsPartitionDocumentExactly', () => {
    const source = doc(
      'gap0',
      '<!-- gsd:section id="a" when="always" -->',
      'bodyA',
      '<!-- /gsd:section -->',
      'gap1',
      '<!-- gsd:section id="b" when="state:has-prior-phases" -->',
      'bodyB',
      '<!-- /gsd:section -->',
      'gap2',
    );
    const sections = parseWorkflowSections(source);
    assert.deepEqual(
      sections.map((s) => ({ id: s.id, explicit: s.explicit })),
      [
        { id: 'gap-0', explicit: false },
        { id: 'a', explicit: true },
        { id: 'gap-1', explicit: false },
        { id: 'b', explicit: true },
        { id: 'gap-2', explicit: false },
      ],
    );

    const markerLineRe = /^<!--\s*\/?gsd:section.*-->\s*$/;
    const expected = source
      .split('\n')
      .filter((line) => !markerLineRe.test(line))
      .join('\n');
    assert.equal(composeWorkflow(source), expected);
  });
});

// ─── Row 4: the real pilot workflow ─────────────────────────────────────────

describe('real execute-phase.md', () => {
  // NOTE (chore/2930 retarget): the pilot moved from plan-phase.md to
  // execute-phase.md — plan-phase.md sits 36 B under the ADR-857 Phase-6
  // PRE_PHASE6 gate (tests/phase6-capstone-conformance.test.cjs) and cannot
  // absorb marker overhead, so the maintainer retargeted the pilot to
  // execute-phase.md (partial-wave, gap-closure-artifacts, regression-gate).
  test('pilotWorkflowParsesAndRendersToSourceMinusMarkers', () => {
    const pilotPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
    const original = fs.readFileSync(pilotPath, 'utf8');

    // execute-phase.md carries the pilot's real marker pairs today: parsing
    // it must recognize exactly those three explicit sections, in document
    // order, and composing it must strip every marker line while leaving
    // every byte of body content untouched.
    const baselineSections = parseWorkflowSections(original, pilotPath);
    const baselineExplicit = baselineSections.filter((s) => s.explicit);
    assert.deepEqual(
      baselineExplicit.map((s) => s.id),
      ['partial-wave', 'gap-closure-artifacts', 'regression-gate'],
    );
    const composedOriginal = composeWorkflow(original, { sourcePath: pilotPath });
    assert.equal(composedOriginal.includes('gsd:section'), false);
    assert.ok(Buffer.byteLength(composedOriginal, 'utf8') < Buffer.byteLength(original, 'utf8'));

    // Wrap an ADDITIONAL, disjoint marker pair around an arbitrary interior
    // slice of real content that sits outside every existing marker pair
    // (lines 11-15, well before "partial-wave") and confirm it parses as a
    // fourth explicit section and composes to the SAME final output as the
    // unmodified file — every fragment is `verbatim` (row 23), so wrapping
    // already-included content in a new marker pair can never change what
    // is emitted, only how it is partitioned internally.
    const lines = original.split(/\r?\n/);
    const sliceStart = 10;
    const sliceEnd = 15;
    const markedLines = [
      ...lines.slice(0, sliceStart),
      '<!-- gsd:section id="pilot-slice" when="always" -->',
      ...lines.slice(sliceStart, sliceEnd),
      '<!-- /gsd:section -->',
      ...lines.slice(sliceEnd),
    ];
    const marked = markedLines.join('\n');

    const sections = parseWorkflowSections(marked, pilotPath);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.deepEqual(
      explicitSections.map((s) => s.id),
      ['pilot-slice', 'partial-wave', 'gap-closure-artifacts', 'regression-gate'],
    );
    assert.equal(explicitSections[0].body, lines.slice(sliceStart, sliceEnd).join('\n') + '\n');

    const rendered = composeWorkflow(marked, { sourcePath: pilotPath });
    assert.equal(rendered, composedOriginal);
    assert.equal(measureBytes(rendered), measureBytes(composedOriginal));
  });
});

// ─── #2993 (epic #1671 Phase 6.2): real plan-phase.md — C1/D1/D4/D5 ───────

describe('real plan-phase.md (#2993)', () => {
  const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
  const STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase', 'steps');

  // The 6 sections the #2993 design survey names, in document order.
  const EXPECTED_SECTIONS = Object.freeze([
    { id: 'reviews-prerequisite', when: 'flag:--reviews' },
    { id: 'prd-express-gate', when: 'flag:--prd' },
    { id: 'adr-ingest-express-path', when: 'flag:--ingest' },
    { id: 'research-only-modifiers', when: 'flag:--research-phase' },
    { id: 'research-only-early-exit', when: 'flag:--research-phase' },
    { id: 'chunked-planning-mode', when: 'state:chunked-mode' },
  ]);

  test('parsesExactlySixSectionsInDocumentOrder (row C1)', () => {
    const source = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
    const sections = parseWorkflowSections(source, PLAN_PHASE_PATH);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.deepEqual(
      explicitSections.map((s) => ({ id: s.id, when: s.when })),
      [...EXPECTED_SECTIONS],
    );
  });

  test('parsesAndRendersWithoutThrowingAndStripsEveryMarker', () => {
    const source = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
    const composed = composeWorkflow(source, { sourcePath: PLAN_PHASE_PATH });
    assert.equal(composed.includes('gsd:section'), false);
    assert.ok(Buffer.byteLength(composed, 'utf8') < Buffer.byteLength(source, 'utf8'));
  });

  test('everyExtractedStepFileExistsIsNonEmptyAndTheHostNoLongerCarriesItsBody (row D1)', () => {
    // Behavioral, never a source-grep substring match: for each of the 6
    // sections, the step file on disk (1) exists, (2) is non-empty, and (3)
    // is EXACTLY the section's own parsed body (the bytes the marker pair
    // wraps in the host) is a stub/reference line, not a re-paste of the
    // step file's content — the host's marker body and the step file's
    // content are two DIFFERENT, disjoint pieces of text after the move.
    const source = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
    const sections = parseWorkflowSections(source, PLAN_PHASE_PATH);
    const byId = new Map(sections.filter((s) => s.explicit).map((s) => [s.id, s]));

    for (const { id } of EXPECTED_SECTIONS) {
      const stepPath = path.join(STEPS_DIR, `${id}.md`);
      assert.ok(fs.existsSync(stepPath), `expected step file to exist: ${stepPath}`);
      const stepContent = fs.readFileSync(stepPath, 'utf8');
      assert.ok(stepContent.length > 0, `expected non-empty step file: ${stepPath}`);

      const hostSection = byId.get(id);
      assert.ok(hostSection, `expected an explicit host section for id="${id}"`);
      // The host's marker body is a short stub (the conditional read-and-execute
      // instruction), never the step file's own moved content — proves the
      // body actually left the host rather than being duplicated in place.
      assert.ok(
        hostSection.body.length < stepContent.length,
        `expected host stub body for "${id}" to be shorter than the extracted step file`,
      );
      assert.equal(
        hostSection.body.includes(stepContent.trim()),
        false,
        `host stub body for "${id}" must not still contain the moved step file's content verbatim`,
      );
    }
  });

  test('prdExpressPathIsReadOnlyWhenPrdSectionIsIncluded (row D4)', () => {
    // prd-express-path.md was previously read unconditionally; the #2993
    // wrapper (prd-express-gate, when="flag:--prd") is what now actually
    // gates it. Prove the gate via the real evaluator: absent --prd excludes
    // prd-express-gate; present --prd includes it.
    const source = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
    const sections = parseWorkflowSections(source, PLAN_PHASE_PATH).filter((s) => s.explicit);
    const withoutPrd = selectSections(sections, facts({}));
    assert.ok(withoutPrd.excluded.includes('prd-express-gate'), 'prd-express-gate must be excluded when --prd is absent');
    assert.ok(!withoutPrd.included.includes('prd-express-gate'));

    const withPrd = selectSections(sections, facts({ flags: new Set(['--prd']) }));
    assert.ok(withPrd.included.includes('prd-express-gate'), 'prd-express-gate must be included when --prd is present');
    assert.ok(!withPrd.excluded.includes('prd-express-gate'));

    // The host's marker body is a stub that reads plan-phase/steps/prd-express-gate.md
    // ONLY when the section is included; THAT step file (nested, one hop
    // further — the reachability shape gen-section-manifest.cjs's own
    // "nested step reference" precedent covers) is what references
    // prd-express-path.md — proving the express-path read is reachable only
    // through the now-conditional wrapper, never as a second, independent
    // unconditional read site elsewhere in the host.
    const gateSection = sections.find((s) => s.id === 'prd-express-gate');
    assert.ok(gateSection.body.includes('prd-express-gate.md'), 'prd-express-gate\'s host stub must read its own step file');
    const gateStepContent = fs.readFileSync(path.join(STEPS_DIR, 'prd-express-gate.md'), 'utf8');
    assert.ok(
      gateStepContent.includes('prd-express-path.md'),
      'prd-express-gate.md must be the (nested) step that references prd-express-path.md',
    );
  });

  test('skipIfProseAppearsExactlyOnceAcrossHostAndStepFile (row D5)', () => {
    // For each section, the "Skip if:" gating prose must live in exactly ONE
    // place — either the host stub or the step file — never duplicated in
    // both after the move.
    const source = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
    const sections = parseWorkflowSections(source, PLAN_PHASE_PATH);
    const byId = new Map(sections.filter((s) => s.explicit).map((s) => [s.id, s]));

    for (const { id } of EXPECTED_SECTIONS) {
      const stepContent = fs.readFileSync(path.join(STEPS_DIR, `${id}.md`), 'utf8');
      const hostBody = byId.get(id).body;
      const hostHasSkipIf = /Skip if:/.test(hostBody);
      const stepHasSkipIf = /Skip if:/.test(stepContent);
      assert.notEqual(
        hostHasSkipIf && stepHasSkipIf,
        true,
        `"Skip if:" prose for "${id}" must not appear in BOTH the host stub and the step file`,
      );
    }
  });
});

// ─── Row 5/6: fence negative space ──────────────────────────────────────────

describe('marker lookalikes inside fences', () => {
  test('markerInsideFencedBlockIsLiteral', () => {
    const source = doc(
      'prose before',
      '```',
      '<!-- gsd:section id="fake" when="always" -->',
      '```',
      'prose after',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });

  test('markerInsideFenceInsideSectionStaysLiteral', () => {
    const source = doc(
      '<!-- gsd:section id="real" when="always" -->',
      'intro',
      '```',
      '<!-- gsd:section id="fake" when="always" -->',
      '<!-- /gsd:section -->',
      '```',
      'outro',
      '<!-- /gsd:section -->',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, true);
    assert.equal(sections[0].id, 'real');
    assert.equal(
      sections[0].body,
      ['intro', '```', '<!-- gsd:section id="fake" when="always" -->', '<!-- /gsd:section -->', '```', 'outro', ''].join(
        '\n',
      ),
    );
  });
});

// ─── Row 7/8: fence/comment mutual precedence ───────────────────────────────

describe('fence and comment mutual precedence', () => {
  test('fenceDelimiterInsideCommentDoesNotOpenFence', () => {
    const source = doc(
      '<!-- unrelated comment',
      '```',
      'still commented',
      '-->',
      '<!-- gsd:section id="after-comment" when="always" -->',
      'body',
      '<!-- /gsd:section -->',
    );
    // If the fence delimiter on line 2 had wrongly opened a fence, the real
    // marker pair below would never be recognized (it would be swallowed as
    // "fence content" all the way to EOF).
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].id, 'after-comment');
    assert.equal(explicitSections[0].body, 'body\n');
  });

  test('commentTokenInsideFenceDoesNotOpenComment', () => {
    const source = doc(
      '```',
      '<!-- unclosed comment token inside fence',
      '```',
      '<!-- gsd:section id="after-fence" when="always" -->',
      'body',
      '<!-- /gsd:section -->',
    );
    // If the `<!--` inside the fence had wrongly opened a real comment, the
    // real marker pair below would never be recognized (swallowed as
    // "comment content" to EOF).
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].id, 'after-fence');
    assert.equal(explicitSections[0].body, 'body\n');
  });
});

// ─── Row 9/10: other negative space ─────────────────────────────────────────

describe('loop-host and backtick negative space', () => {
  test('loopHostMarkerIsNotASectionMarker', () => {
    const source = doc(
      '<!-- gsd:loop-host',
      'step: plan',
      'points: plan:pre, plan:post',
      '-->',
      '<purpose>Do the thing.</purpose>',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });

  test('backtickedMarkerMentionIsNotAMarker', () => {
    const source = doc(
      'See `<!-- gsd:section id="x" when="always" -->` for the marker syntax.',
      'And the close form is `<!-- /gsd:section -->` on its own line.',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });
});

// ─── Rows 11-14: structural negatives with location ────────────────────────

describe('structural negatives throw with file + line', () => {
  test('unclosedSectionThrowsWithLocation', () => {
    const source = doc('prose', '<!-- gsd:section id="a" when="always" -->', 'body, never closed');
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.reason === REASON.UNCLOSED_SECTION,
    );
  });

  test('unmatchedCloseThrowsWithLocation', () => {
    const source = doc('prose', '<!-- /gsd:section -->', 'more prose');
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.reason === REASON.UNMATCHED_CLOSE,
    );
  });

  test('nestedSectionThrows', () => {
    const source = doc(
      '<!-- gsd:section id="outer" when="always" -->',
      '<!-- gsd:section id="inner" when="always" -->',
      'body',
      '<!-- /gsd:section -->',
      '<!-- /gsd:section -->',
    );
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.reason === REASON.NESTED_SECTION,
    );
  });

  test('duplicateSectionIdThrows', () => {
    const source = doc(
      '<!-- gsd:section id="dup" when="always" -->',
      'first',
      '<!-- /gsd:section -->',
      '<!-- gsd:section id="dup" when="flag:--wave" -->',
      'second',
      '<!-- /gsd:section -->',
    );
    // Throws on the SECOND occurrence's line, not the first.
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:4') && err.reason === REASON.DUPLICATE_ID,
    );
  });
});

// ─── Rows 15-18: attribute-shape negatives ─────────────────────────────────

describe('attribute-shape negatives', () => {
  test('missingIdAttributeThrows', () => {
    const source = '<!-- gsd:section when="always" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.MISSING_ID,
    );
  });

  test('missingWhenAttributeThrows', () => {
    const source = '<!-- gsd:section id="x" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.MISSING_WHEN,
    );
  });

  test('unknownWhenValueThrows', () => {
    const source = '<!-- gsd:section id="x" when="flag:--nonexistent" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
    );
  });

  test('whenValueWithBooleanOperatorThrows', () => {
    for (const when of ['flag:--wave && state:has-prior-phases', 'flag:--wave || state:has-prior-phases', '!flag:--wave']) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      assert.throws(
        () => parseWorkflowSections(source, 'workflow.md'),
        (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
        `expected throw for when="${when}"`,
      );
    }
  });

  test('malformedAttributesThrows', () => {
    const source = '<!-- gsd:section id="x" when -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.MALFORMED_ATTRIBUTES,
    );
  });

  test('unrecognizedAttributeThrows', () => {
    const source = '<!-- gsd:section id="x" when="always" bogus="1" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.UNRECOGNIZED_ATTRIBUTE,
    );
  });

  test('malformedIdValueThrows', () => {
    const source = '<!-- gsd:section id="-bad-" when="always" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.MALFORMED_ID,
    );
  });

  test('closeMarkerWithAttributesThrows', () => {
    const source = '<!-- gsd:section id="x" when="always" -->\nbody\n<!-- /gsd:section foo="1" -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.reason === REASON.CLOSE_WITH_ATTRIBUTES,
    );
  });
});

// ─── FIX 2/3 (chore/2930 review): REASON enum shape is locked ─────────────

describe('REASON enum is frozen and its shape is locked', () => {
  test('reasonEnumKeysAreLocked', () => {
    assert.equal(Object.isFrozen(REASON), true);
    assert.deepEqual(Object.keys(REASON).sort(), [
      'CLOSE_WITH_ATTRIBUTES',
      'DUPLICATE_ID',
      'MALFORMED_ATTRIBUTES',
      'MALFORMED_ID',
      'MISSING_ID',
      'MISSING_WHEN',
      'NESTED_SECTION',
      'UNCLOSED_SECTION',
      'UNKNOWN_WHEN',
      'UNMATCHED_CLOSE',
      'UNRECOGNIZED_ATTRIBUTE',
    ]);
  });
});

// ─── Doc/enum parity guard (DEFECT.GENERATIVE-FIX, code review #2930) ──────

describe('REASON enum and docs "Fails closed" bullets stay in parity', () => {
  test('everyReasonMemberIsDocumentedAndNoStaleBulletsRemain', () => {
    // allow-test-rule: docs-parity — the doc text IS the contract being checked here (#2930)
    const docPath = path.join(__dirname, '..', 'docs', 'reference', 'workflow-fragments.md');
    const docText = fs.readFileSync(docPath, 'utf8');

    const sectionMatch = /## Fails closed\r?\n([\s\S]*?)\r?\n## /.exec(docText);
    assert.ok(sectionMatch, 'docs/reference/workflow-fragments.md must have a "## Fails closed" section');
    const sectionText = sectionMatch[1];

    const enumMembers = Object.keys(REASON);
    // Key on the reason IDENTIFIER (e.g. `MALFORMED_ATTRIBUTES`) appearing in
    // a bullet, never on bullet prose — a reword of the human-readable
    // sentence must never falsely trip or falsely clear this guard.
    const undocumented = enumMembers.filter((name) => !sectionText.includes(name));

    const mentionedIdentifiers = [...sectionText.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]);
    const staleMentions = mentionedIdentifiers.filter((name) => !enumMembers.includes(name));

    assert.deepEqual(
      undocumented,
      [],
      `REASON member(s) missing a "Fails closed" bullet in docs/reference/workflow-fragments.md: ${undocumented.join(', ')}`,
    );
    assert.deepEqual(
      staleMentions,
      [],
      `"Fails closed" section mentions identifier(s) that are not REASON members (stale bullet?): ${staleMentions.join(', ')}`,
    );
  });
});

// ─── Row 19: frozen vocabulary ──────────────────────────────────────────────

describe('frozen when= vocabulary', () => {
  test('whenVocabularyIsFrozenAndLocked', () => {
    // WHEN_VOCABULARY is a frozen array (not an enum object) per the shipped
    // public API — lock the actual VALUES (sorted), not Object.keys() (which
    // for an array only reflects index positions '0','1',... and would not
    // catch a value being silently renamed). See the dispatch report for
    // this deliberate deviation from the test matrix's literal wording.
    //
    // #2993 (epic #1671 Phase 6.2, matrix row A3) widens this lock 14 -> 19:
    // flag:--ingest, flag:--prd, flag:--research-phase, flag:--reviews,
    // state:chunked-mode. This is the row the lock exists to force — a
    // deliberate, coordinated update, never a silent drift (Greenspun's
    // Tenth Rule / ADR-1671:69).
    assert.equal(Object.isFrozen(WHEN_VOCABULARY), true);
    assert.deepEqual(
      [...WHEN_VOCABULARY].sort(),
      [
        'always',
        'flag:--auto',
        'flag:--discuss',
        'flag:--forensic',
        'flag:--full',
        'flag:--ingest',
        'flag:--prd',
        'flag:--research',
        'flag:--research-phase',
        'flag:--reset-phase-numbers',
        'flag:--reviews',
        'flag:--validate',
        'flag:--wave',
        'state:chunked-mode',
        'state:gap-closure-phase',
        'state:has-prior-phases',
        'state:needs-codebase-map',
        'state:phase-mvp-mode',
        'state:worktrees-enabled',
      ],
    );
  });
});

// ─── #2993 (epic #1671 Phase 6.2): widened when= vocabulary (19 atoms) ─────
// 50-test-matrix.md rows A1/A6.

describe('widened when= vocabulary (#2993)', () => {
  // The 5 net-new atoms shipped by #2993, fragmentizing plan-phase.md.
  const NET_NEW_ATOMS_2993 = Object.freeze([
    'flag:--ingest',
    'flag:--prd',
    'flag:--research-phase',
    'flag:--reviews',
    'state:chunked-mode',
  ]);

  test('everyNetNewAtomIsInWhenVocabulary', () => {
    for (const atom of NET_NEW_ATOMS_2993) {
      assert.ok(WHEN_VOCABULARY.includes(atom), `expected "${atom}" in WHEN_VOCABULARY`);
    }
  });

  test('acceptsEveryWidenedAtom (row A1)', () => {
    for (const when of NET_NEW_ATOMS_2993) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      const sections = parseWorkflowSections(source);
      const explicitSections = sections.filter((s) => s.explicit);
      assert.equal(explicitSections.length, 1, `expected acceptance for when="${when}"`);
      assert.equal(explicitSections[0].when, when);
      assert.equal(composeWorkflow(source), 'body\n');
    }
  });

  test('researchPhaseAndResearchAreDistinctAtomsAtTheParserLevel (row A6)', () => {
    // flag:--research-phase (net-new, #2993) and flag:--research (pre-existing,
    // #2992) are DISTINCT vocabulary entries — the parser must accept both,
    // as different `when` values, on sections that sit side by side, and must
    // never conflate one for the other (e.g. via prefix-matching or a shared
    // token derivation). See section-manifest.test.cjs for the predicate-level
    // half of this guard (no aliasing at evaluation time).
    const source = doc(
      '<!-- gsd:section id="research-section" when="flag:--research" -->',
      'researchBody',
      '<!-- /gsd:section -->',
      '<!-- gsd:section id="research-phase-section" when="flag:--research-phase" -->',
      'researchPhaseBody',
      '<!-- /gsd:section -->',
    );
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.deepEqual(
      explicitSections.map((s) => ({ id: s.id, when: s.when })),
      [
        { id: 'research-section', when: 'flag:--research' },
        { id: 'research-phase-section', when: 'flag:--research-phase' },
      ],
    );
  });
});

// ─── #2992 (epic #1671 Phase 6.1): widened when= vocabulary (14 atoms) ─────
// 50-test-matrix.md rows A2/A5/A6/A14/A19.

describe('widened when= vocabulary (#2992)', () => {
  // The 10 net-new atoms shipped by #2992, independent of the pre-existing 4
  // (Object.keys-style derivation of the diff would be tokenization of the
  // vocabulary itself, so this list is a deliberate hand-written literal,
  // mirroring the discipline WHEN_PREDICATES already applies).
  const NET_NEW_ATOMS = Object.freeze([
    'flag:--auto',
    'flag:--discuss',
    'flag:--forensic',
    'flag:--full',
    'flag:--research',
    'flag:--reset-phase-numbers',
    'flag:--validate',
    'state:needs-codebase-map',
    'state:phase-mvp-mode',
    'state:worktrees-enabled',
  ]);

  test('everyNetNewAtomIsInWhenVocabulary', () => {
    // Sanity that the hand-written NET_NEW_ATOMS list above has not drifted
    // from the module's own frozen export.
    for (const atom of NET_NEW_ATOMS) {
      assert.ok(WHEN_VOCABULARY.includes(atom), `expected "${atom}" in WHEN_VOCABULARY`);
    }
  });

  test('acceptsEveryWidenedAtom (row A2)', () => {
    for (const when of NET_NEW_ATOMS) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      const sections = parseWorkflowSections(source);
      const explicitSections = sections.filter((s) => s.explicit);
      assert.equal(explicitSections.length, 1, `expected acceptance for when="${when}"`);
      assert.equal(explicitSections[0].when, when);
      assert.equal(composeWorkflow(source), 'body\n');
    }
  });

  test('sameAtomOnTwoDifferentSectionsIsLegal (row A19)', () => {
    // Atom reuse is legal; only `id` must be unique.
    const source = doc(
      '<!-- gsd:section id="first" when="flag:--auto" -->',
      'bodyA',
      '<!-- /gsd:section -->',
      '<!-- gsd:section id="second" when="flag:--auto" -->',
      'bodyB',
      '<!-- /gsd:section -->',
    );
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.deepEqual(
      explicitSections.map((s) => ({ id: s.id, when: s.when })),
      [
        { id: 'first', when: 'flag:--auto' },
        { id: 'second', when: 'flag:--auto' },
      ],
    );
  });

  test('atomMatchIsCaseSensitive (row A5)', () => {
    // A case variant of a real net-new atom must still throw — exact `===`,
    // no case folding.
    for (const when of ['Flag:--auto', 'flag:--Auto', 'FLAG:--AUTO', 'flag:--RESEARCH']) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      assert.throws(
        () => parseWorkflowSections(source, 'workflow.md'),
        (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
        `expected throw for when="${when}"`,
      );
    }
  });

  test('atomValueIsNotTrimmed (row A6)', () => {
    // A padded value must still throw — the value is not trimmed before the
    // vocabulary membership check.
    for (const when of [' flag:--auto', 'flag:--auto ', ' state:worktrees-enabled ']) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      assert.throws(
        () => parseWorkflowSections(source, 'workflow.md'),
        (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
        `expected throw for when="${when}"`,
      );
    }
  });

  test('crlfMarkerLineCarryingAWidenedAtomRoundTripsExactly (row A14)', () => {
    const source = [
      'prose one',
      '<!-- gsd:section id="x" when="flag:--forensic" -->',
      'crlf body',
      '<!-- /gsd:section -->',
      'prose two',
    ].join('\r\n');
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].when, 'flag:--forensic');
    assert.equal(explicitSections[0].body, 'crlf body\r\n');

    const rendered = composeWorkflow(source);
    const expected = source
      .split('\r\n')
      .filter((line) => !/^<!--\s*\/?gsd:section.*-->\s*$/.test(line))
      .join('\r\n');
    assert.equal(rendered, expected);
  });
});

// ─── Rows 20-22: boundary documents ─────────────────────────────────────────

describe('boundary documents', () => {
  test('emptyDocumentProducesNoFragments', () => {
    const sections = parseWorkflowSections('');
    assert.deepEqual(sections, []);
    assert.equal(composeWorkflow(''), '');
  });

  test('documentOfOnlyAMarkerPairYieldsEmptyBody', () => {
    const source = '<!-- gsd:section id="x" when="always" -->\n<!-- /gsd:section -->';
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, true);
    assert.equal(sections[0].id, 'x');
    assert.equal(sections[0].body, '');
    assert.equal(composeWorkflow(source), '');
  });

  test('unclosedFenceAtEofDoesNotThrow', () => {
    const source = doc('prose', '```', 'never closed', '<!-- gsd:section id="x" when="always" -->');
    assert.doesNotThrow(() => parseWorkflowSections(source));
    const sections = parseWorkflowSections(source);
    // The whole document, including the marker-shaped line, is literal
    // fence content — one implicit gap fragment, byte-identical.
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
  });
});

// ─── Rows 23-25: cross-platform + liberal formatting ───────────────────────

describe('cross-platform line endings and liberal marker formatting', () => {
  test('crlfDocumentRoundTripsByteIdentical', () => {
    const source = ['prose one', '<!-- gsd:section id="x" when="always" -->', 'crlf body', '<!-- /gsd:section -->', 'prose two'].join(
      '\r\n',
    );
    const rendered = composeWorkflow(source);
    const expected = source
      .split('\r\n')
      .filter((line) => !/^<!--\s*\/?gsd:section.*-->\s*$/.test(line))
      .join('\r\n');
    assert.equal(rendered, expected);
  });

  test('mixedLineEndingsPreservedExactly', () => {
    const source = 'prose\r\n<!-- gsd:section id="x" when="always" -->\r\nbody one\nbody two\n<!-- /gsd:section -->\nprose two';
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].body, 'body one\nbody two\n');
    const rendered = composeWorkflow(source);
    assert.equal(rendered, 'prose\r\nbody one\nbody two\nprose two');
  });

  test('attributeOrderAndSpacingAreAccepted', () => {
    const variants = [
      '<!-- gsd:section id="x" when="always" -->',
      '<!--gsd:section id="x" when="always"-->',
      '<!--   gsd:section    when="always"     id="x"    -->',
      '  <!-- gsd:section when="always" id="x" -->  ',
      '<!--gsd:section when="always"id="x"-->',
    ];
    for (const openLine of variants) {
      const source = `${openLine}\nbody\n<!-- /gsd:section -->`;
      const sections = parseWorkflowSections(source);
      const explicitSections = sections.filter((s) => s.explicit);
      assert.equal(explicitSections.length, 1, `expected recognition for: ${openLine}`);
      assert.equal(explicitSections[0].id, 'x');
      assert.equal(explicitSections[0].when, 'always');
      // Re-render never leaks the original spacing — the marker is dropped
      // entirely, so only the body survives.
      assert.equal(composeWorkflow(source), 'body\n');
    }
  });
});

// ─── Rows 26-29: budget boundary set (non-lossiness is structural) ─────────

describe('budget boundary set: nothing is ever trimmed', () => {
  const source = doc(
    'gap prose',
    '<!-- gsd:section id="a" when="always" -->',
    'section a body',
    '<!-- /gsd:section -->',
    'more gap prose',
  );

  function composeAt(budget) {
    const sections = parseWorkflowSections(source);
    const fragments = toFragments(sections);
    return composeWithinBudget({ fragments, budget, measure: measureBytes, options: { charsPerUnit: 1 } });
  }

  const baseline = (() => {
    const sections = parseWorkflowSections(source);
    const fragments = toFragments(sections);
    return fragments.reduce((sum, f) => sum + measureBytes(f.content), 0);
  })();

  const expectedRendered = composeWorkflow(source);

  test('nothingTrimmedWhenBudgetEqualsContent', () => {
    const result = composeAt(baseline);
    assert.deepEqual(result.metadata.omitted, []);
    assert.deepEqual(result.metadata.shrunk, []);
    assert.equal(renderFragments(result), expectedRendered);
  });

  test('nothingTrimmedWhenBudgetIsOneUnderContent', () => {
    const result = composeAt(baseline - 1);
    assert.deepEqual(result.metadata.omitted, []);
    assert.deepEqual(result.metadata.shrunk, []);
    assert.equal(renderFragments(result), expectedRendered);
  });

  test('nothingTrimmedWhenBudgetIsOneOverContent', () => {
    const result = composeAt(baseline + 1);
    assert.deepEqual(result.metadata.omitted, []);
    assert.deepEqual(result.metadata.shrunk, []);
    assert.equal(renderFragments(result), expectedRendered);
  });

  test('nothingTrimmedUnderAbsurdBudgetPressure', () => {
    const result = composeAt(1);
    assert.deepEqual(result.metadata.omitted, []);
    assert.deepEqual(result.metadata.shrunk, []);
    assert.equal(result.metadata.hardFailed, false);
    assert.equal(renderFragments(result), expectedRendered);
  });
});

// ─── Row 37: fs.readFileSync fault injection ───────────────────────────────

/**
 * Simulate the realistic caller shape (read a workflow file, compose it,
 * write the composed result elsewhere) with `fs.readFileSync` monkeypatched
 * to throw. The monkeypatch is saved/restored HERE, in a helper, inside a
 * `finally` — never inside a test body, and never via chmod/permission
 * tricks (CLAUDE.md cross-platform fault-injection rule).
 */
function withInjectedReadFailure(fn) {
  const original = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error('injected read failure');
  };
  try {
    return fn();
  } finally {
    fs.readFileSync = original;
  }
}

// ─── FIX 4 (chore/2930 review): adversarial parser-input fixtures ─────────
// CONTRIBUTING.md:484-513 requires adversarial fixtures for a new parser's
// inputs. Each case here either round-trips byte-identical or produces the
// correct typed REASON — never a message-text match.

describe('adversarial content bytes', () => {
  test('unicodeHeadingRoundTripsByteIdentical', () => {
    const source = doc(
      '# 見出し — Ünïcödé Hëading 🚀',
      '<!-- gsd:section id="sec" when="always" -->',
      'body with 中文, кириллица, emoji 🎉',
      '<!-- /gsd:section -->',
      'trailing プロース',
    );
    const expected = doc('# 見出し — Ünïcödé Hëading 🚀', 'body with 中文, кириллица, emoji 🎉', 'trailing プロース');
    const rendered = composeWorkflow(source);
    assert.equal(rendered, expected);
    assert.equal(measureBytes(rendered), measureBytes(expected));
  });

  test('nulByteInBodyRoundTripsByteIdentical', () => {
    const source = `prose\0more\n<!-- gsd:section id="x" when="always" -->\nbody\0with\0nul\n<!-- /gsd:section -->\nafter\0`;
    const sections = parseWorkflowSections(source);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].body, 'body\0with\0nul\n');
    const rendered = composeWorkflow(source);
    assert.equal(rendered, 'prose\0more\nbody\0with\0nul\nafter\0');
  });

  test('unicodeReplacementCharacterRoundTripsByteIdentical', () => {
    const source = `prose � end\n<!-- gsd:section id="x" when="always" -->\nbody ��\n<!-- /gsd:section -->\nafter �`;
    const rendered = composeWorkflow(source);
    assert.equal(rendered, 'prose � end\nbody ��\nafter �');
  });

  test('leadingByteOrderMarkRoundTripsByteIdentical', () => {
    const source = '﻿# Heading\n<!-- gsd:section id="x" when="always" -->\nbody\n<!-- /gsd:section -->\ntail';
    const sections = parseWorkflowSections(source);
    const gaps = sections.filter((s) => !s.explicit);
    // The BOM is ordinary content of the leading gap — never stripped or
    // otherwise special-cased by this parser.
    assert.equal(gaps[0].body, '﻿# Heading\n');
    const rendered = composeWorkflow(source);
    assert.equal(rendered, '﻿# Heading\nbody\ntail');
  });
});

describe('adversarial fence shapes', () => {
  test('fenceWithinFenceStaysLiteralUntilOuterCloser', () => {
    const source = doc(
      'prose before',
      '````',
      '```',
      '<!-- gsd:section id="fake" when="always" -->',
      '```',
      '````',
      'prose after',
    );
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });

  test('tildeFenceHidesMarkerLookalike', () => {
    const source = doc('prose', '~~~', '<!-- gsd:section id="fake" when="always" -->', '~~~', 'prose after');
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });

  test('indentedFenceUpToThreeSpacesHidesMarkerLookalike', () => {
    const source = doc('prose', '   ```', '<!-- gsd:section id="fake" when="always" -->', '   ```', 'prose after');
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });
});

describe('adversarial line-ending shapes', () => {
  test('markerLineTerminatedByLoneCrIsNotRecognizedAsAMarker', () => {
    // A bare `\r` with no accompanying `\n` anywhere in the document is not
    // an EOL this grammar recognizes (only '' / '\n' / '\r\n' — see the
    // module doc comment). The marker-shaped text is therefore never on its
    // "own line" and must be left as ordinary literal content, not parsed
    // as an open marker.
    const source = '<!-- gsd:section id="x" when="always" -->\rbody, never a real line break';
    const sections = parseWorkflowSections(source);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].explicit, false);
    assert.equal(sections[0].body, source);
    assert.equal(composeWorkflow(source), source);
  });
});

describe('fs.readFileSync fault injection mid-compose', () => {
  test('readFailureDuringCompositionLeavesNoPartialArtifact', (t) => {
    const tmpDir = createTempDir('gsd-wf-fault-');
    t.after(() => cleanup(tmpDir));

    const srcPath = path.join(tmpDir, 'source.md');
    const destPath = path.join(tmpDir, 'composed.md');
    fs.writeFileSync(srcPath, '<!-- gsd:section id="x" when="always" -->\nbody\n<!-- /gsd:section -->\n');

    function readComposeWrite() {
      const content = fs.readFileSync(srcPath, 'utf8');
      const result = composeWorkflow(content, { sourcePath: srcPath });
      fs.writeFileSync(destPath, result);
      return result;
    }

    assert.throws(
      () => withInjectedReadFailure(() => readComposeWrite()),
      (err) => err instanceof Error && err.message === 'injected read failure',
    );
    assert.equal(fs.existsSync(destPath), false, 'no partial artifact must be written when the read fails');

    // Restored correctly: a subsequent real call succeeds and DOES write.
    const result = readComposeWrite();
    assert.equal(fs.existsSync(destPath), true);
    assert.equal(result, 'body\n');
  });
});
