'use strict';

// allow-test-rule: source-text-is-the-product see #2994 — this file asserts that
// specific prose/resolver LINES remain physically outside a `<!-- gsd:section
// -->` marker pair in the HOST workflow .md files. The deployed contract IS
// the exact text and its position relative to the marker boundary (a runtime
// that reads only the gated fragment must still see the flag-absent
// fallback), so asserting on rendered text is the only meaningful check here
// — a typed/structural assertion on `parseWorkflowSections` output could not
// distinguish "the fallback text survived, in the right gap" from "the
// fallback text was deleted entirely along with the surrounding gap".

/**
 * Inversion-guard tests — #2994 (epic #1671 Phase 6.3) matrix §F, the
 * highest-risk edit in the PR (`.gsd/phase/chore-2994-fragment-model-workflows/
 * 50-test-matrix.md`): gating `discuss-phase-assumptions.md`'s `auto_advance`
 * step WHOLE would delete the flag-absent fallback ("End here — confirm_creation
 * already ran; do not route back to it."), removing text needed EXACTLY when
 * `--auto` is absent — the inverse of what a `when=` gate is supposed to do.
 * The design's split is at `:651/652`: only `auto-advance-dispatch` itself is
 * gated (`state:auto-advance-active`); the resolvers above it and the
 * flag-absent fallback below it stay outside the marker pair, in the host
 * file, unconditionally composed regardless of `section_manifest`.
 *
 * The same class — "an always-relevant note living immediately adjacent to a
 * gated section must not itself be swallowed by the marker" — applies to
 * `verify-work.md`'s MVP false-branch note (row "Same class applies").
 *
 * Parses each host file with the REAL `parseWorkflowSections` (never a
 * second ad-hoc marker scan) to get the marker's exact byte boundaries, then
 * asserts the fallback/resolver text is NOT inside the gated section's body
 * and IS present in the surrounding (always-composed) gap text.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseWorkflowSections } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function readWorkflow(name) {
  const filePath = path.join(WORKFLOWS_DIR, `${name}.md`);
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
}

/** The gated section's own body, by id — must equal exactly one parsed section. */
function bodyOf(sections, id) {
  const match = sections.filter((s) => s.id === id);
  assert.equal(match.length, 1, `expected exactly one parsed section with id "${id}"`);
  return match[0].body;
}

/** Every gap-section body concatenated (i.e., everything OUTSIDE any explicit marker), preserving the "never inside a gate" question. */
function outsideGatedText(sections) {
  return sections.filter((s) => !s.explicit).map((s) => s.body).join('');
}

// ─── F1/F2/F3: discuss-phase-assumptions.md's auto-advance-dispatch split ──

describe('discuss-phase-assumptions.md: the flag-absent fallback survives exclusion (matrix §F, highest-risk edit)', () => {
  const { content } = readWorkflow('discuss-phase-assumptions');
  const sections = parseWorkflowSections(content, 'gsd-core/workflows/discuss-phase-assumptions.md');

  const GATED_ID = 'auto-advance-dispatch';
  const FALLBACK_TEXT = 'End here — `confirm_creation` already ran; do not route back to it.';
  const RESOLVER_MARKERS = [
    'Parse `--auto` flag from $ARGUMENTS',
    'gsd_run query config-set workflow._auto_chain_active',
    'AUTO_MODE=$(gsd_run query check auto-mode --pick active',
  ];

  test('the gated section exists and is when="state:auto-advance-active" (sanity)', () => {
    const gated = sections.find((s) => s.id === GATED_ID);
    assert.ok(gated, `expected a "${GATED_ID}" section to exist`);
    assert.equal(gated.when, 'state:auto-advance-active');
  });

  test('the flag-absent "End here" fallback is present in the composed HOST output (row F1 — the inversion)', () => {
    assert.ok(content.includes(FALLBACK_TEXT), 'the fallback text must exist verbatim in the host file at all');
  });

  test('the flag-absent fallback is NOT inside the gated section\'s own body (row F1/F3)', () => {
    const gatedBody = bodyOf(sections, GATED_ID);
    assert.ok(
      !gatedBody.includes(FALLBACK_TEXT),
      'the fallback must live OUTSIDE the gated marker — gating it away would delete the text needed exactly when --auto is absent',
    );
  });

  test('the flag-absent fallback IS present in the unconditionally-composed gap text (row F2 — dispatch body included path also composes the surrounding text unconditionally)', () => {
    const gapText = outsideGatedText(sections);
    assert.ok(gapText.includes(FALLBACK_TEXT), 'the fallback must be part of an always-composed gap section, not lost between gaps');
  });

  test('every resolver line (--auto parse, config-set, AUTO_MODE read) lies OUTSIDE the gated marker (row F3)', () => {
    const gatedBody = bodyOf(sections, GATED_ID);
    for (const marker of RESOLVER_MARKERS) {
      assert.ok(!gatedBody.includes(marker), `resolver text "${marker}" must not live inside the gated "${GATED_ID}" section`);
    }
    const gapText = outsideGatedText(sections);
    for (const marker of RESOLVER_MARKERS) {
      assert.ok(gapText.includes(marker), `resolver text "${marker}" must be present in the unconditionally-composed surrounding text`);
    }
  });

  test('composing the document with every section INCLUDED still contains the fallback (row F2 sanity — inclusion never deletes it either)', () => {
    // The stub instructs conditional reading of steps/auto-advance-dispatch.md,
    // but the fallback sentence itself is literal HOST text either way — this
    // asserts the host's raw byte content carries it once, regardless of
    // section_manifest, which composeWorkflow (verbatim strategy, #2930)
    // preserves unconditionally.
    const occurrences = content.split(FALLBACK_TEXT).length - 1;
    assert.equal(occurrences, 1, 'the fallback text must appear exactly once in the host file');
  });
});

// ─── Same class: verify-work.md's MVP false-branch note ────────────────────

describe('verify-work.md: the MVP false-branch note survives exclusion of mvp-uat-framing (same class as §F)', () => {
  const { content } = readWorkflow('verify-work');
  const sections = parseWorkflowSections(content, 'gsd-core/workflows/verify-work.md');

  const GATED_ID = 'mvp-uat-framing';
  const FALSE_BRANCH_NOTE = 'When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change.';

  test('the gated section exists and is when="state:phase-mvp-mode" (sanity)', () => {
    const gated = sections.find((s) => s.id === GATED_ID);
    assert.ok(gated, `expected a "${GATED_ID}" section to exist`);
    assert.equal(gated.when, 'state:phase-mvp-mode');
  });

  test('the MVP=false fallback note is present in the host file at all', () => {
    assert.ok(content.includes(FALSE_BRANCH_NOTE));
  });

  test('the MVP=false fallback note is NOT inside the gated mvp-uat-framing section body', () => {
    const gatedBody = bodyOf(sections, GATED_ID);
    assert.ok(
      !gatedBody.includes(FALSE_BRANCH_NOTE),
      'gating mvp-uat-framing away (MVP_MODE=false) must not delete the note that documents exactly that fallback',
    );
  });

  test('the MVP=false fallback note IS present in the unconditionally-composed gap text', () => {
    const gapText = outsideGatedText(sections);
    assert.ok(gapText.includes(FALSE_BRANCH_NOTE));
  });
});
