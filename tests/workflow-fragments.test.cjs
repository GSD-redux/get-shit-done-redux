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
} = require('../gsd-core/bin/lib/workflow-fragments.cjs');
const { composeWithinBudget } = require('../gsd-core/bin/lib/context-composer.cjs');

const measureBytes = (text) => Buffer.byteLength(text, 'utf8');

/** Compose a document string from an array of lines, joined with '\n'. */
const doc = (...lines) => lines.join('\n');

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
      '<!-- gsd:section id="sec-a" when="flag:--prd" -->',
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
    assert.equal(sections[1].when, 'flag:--prd');
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
      '<!-- gsd:section id="b" when="flag:--chunked" -->',
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

describe('real plan-phase.md', () => {
  test('pilotWorkflowParsesAndRendersToSourceMinusMarkers', () => {
    const pilotPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
    const original = fs.readFileSync(pilotPath, 'utf8');

    // plan-phase.md ships unmarked today (design 40-design.md OQ2): parsing
    // it must yield exactly one implicit gap fragment and compose back
    // byte-identical — the production shape this module must never regress.
    const baselineSections = parseWorkflowSections(original, pilotPath);
    assert.equal(baselineSections.length, 1);
    assert.equal(baselineSections[0].explicit, false);
    assert.equal(composeWorkflow(original, { sourcePath: pilotPath }), original);

    // Now mark up the loop-host block's own line 1 comment region is left
    // alone; wrap an arbitrary interior slice of the real content in a
    // marker pair and confirm it parses + renders to source-minus-markers.
    const lines = original.split(/\r?\n/);
    const sliceStart = 10;
    const sliceEnd = 15;
    const markedLines = [
      ...lines.slice(0, sliceStart),
      '<!-- gsd:section id="pilot-slice" when="flag:--prd" -->',
      ...lines.slice(sliceStart, sliceEnd),
      '<!-- /gsd:section -->',
      ...lines.slice(sliceEnd),
    ];
    const marked = markedLines.join('\n');

    const sections = parseWorkflowSections(marked, pilotPath);
    const explicitSections = sections.filter((s) => s.explicit);
    assert.equal(explicitSections.length, 1);
    assert.equal(explicitSections[0].id, 'pilot-slice');
    assert.equal(explicitSections[0].body, lines.slice(sliceStart, sliceEnd).join('\n') + '\n');

    const rendered = composeWorkflow(marked, { sourcePath: pilotPath });
    assert.equal(rendered, original);
    assert.equal(measureBytes(rendered), measureBytes(original));
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
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.message.includes('unclosed'),
    );
  });

  test('unmatchedCloseThrowsWithLocation', () => {
    const source = doc('prose', '<!-- /gsd:section -->', 'more prose');
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.message.includes('unmatched'),
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
      (err) => err instanceof TypeError && err.message.includes('workflow.md:2') && err.message.includes('nested'),
    );
  });

  test('duplicateSectionIdThrows', () => {
    const source = doc(
      '<!-- gsd:section id="dup" when="always" -->',
      'first',
      '<!-- /gsd:section -->',
      '<!-- gsd:section id="dup" when="flag:--chunked" -->',
      'second',
      '<!-- /gsd:section -->',
    );
    // Throws on the SECOND occurrence's line, not the first.
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('workflow.md:4') && err.message.includes('duplicate'),
    );
  });
});

// ─── Rows 15-18: attribute-shape negatives ─────────────────────────────────

describe('attribute-shape negatives', () => {
  test('missingIdAttributeThrows', () => {
    const source = '<!-- gsd:section when="always" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('"id"'),
    );
  });

  test('missingWhenAttributeThrows', () => {
    const source = '<!-- gsd:section id="x" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('"when"'),
    );
  });

  test('unknownWhenValueThrows', () => {
    const source = '<!-- gsd:section id="x" when="flag:--nonexistent" -->\nbody\n<!-- /gsd:section -->';
    assert.throws(
      () => parseWorkflowSections(source, 'workflow.md'),
      (err) => err instanceof TypeError && err.message.includes('WHEN_VOCABULARY'),
    );
  });

  test('whenValueWithBooleanOperatorThrows', () => {
    for (const when of ['flag:--prd && flag:--chunked', 'flag:--prd || flag:--chunked', '!flag:--prd']) {
      const source = `<!-- gsd:section id="x" when="${when}" -->\nbody\n<!-- /gsd:section -->`;
      assert.throws(
        () => parseWorkflowSections(source, 'workflow.md'),
        (err) => err instanceof TypeError && err.message.includes('WHEN_VOCABULARY'),
        `expected throw for when="${when}"`,
      );
    }
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
    assert.equal(Object.isFrozen(WHEN_VOCABULARY), true);
    assert.deepEqual(
      [...WHEN_VOCABULARY].sort(),
      ['always', 'flag:--chunked', 'flag:--ingest', 'flag:--prd', 'flag:--reviews'],
    );
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
