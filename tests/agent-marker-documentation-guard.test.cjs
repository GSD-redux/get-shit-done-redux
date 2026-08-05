'use strict';

// allow-test-rule: source-text-is-the-product see #2995 — parses the literal text of shipped
// agent .md files, which IS the deployed contract that composeWorkflow consumes at install time.

/**
 * agent-marker-documentation-guard.test.cjs — 50-test-matrix.md rows 11 and 12
 * (issue #2995, epic #1671 Phase 6.4).
 *
 * #2930 scoped `composeWorkflow` to `gsd-core/workflows/` for one specific
 * reason: a document that merely DOCUMENTS the marker syntax with an UNFENCED
 * example is indistinguishable from a real marker, so the composer would treat
 * it as one and drop that line from the emitted artifact. `docs/reference/
 * workflow-fragments.md` was named as the live instance of that class.
 *
 * #2995 widens the composed scope to `agents/`, which makes the class reachable
 * for agent files for the first time. These two rows are the guard.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseWorkflowSections, composeWorkflow } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

// ─── Row 11: a FENCED marker example is literal, not a marker ─────────────────

test('row 11 — a fenced marker example in an agent survives composition verbatim', () => {
  const doc = [
    '---',
    'name: gsd-example',
    '---',
    '',
    '# Example agent',
    '',
    'To gate a section, write:',
    '',
    '```markdown',
    '<!-- gsd:section id="demo" when="always" -->',
    'body',
    '<!-- /gsd:section -->',
    '```',
    '',
    'That is the whole grammar.',
    '',
  ].join('\n');

  const sections = parseWorkflowSections(doc, 'agents/gsd-example.md');
  assert.deepStrictEqual(
    sections.filter((s) => s.explicit).map((s) => s.id),
    [],
    'a fenced example must produce NO explicit section — it is documentation, not a marker',
  );

  const composed = composeWorkflow(doc, { sourcePath: 'agents/gsd-example.md' });
  assert.equal(
    composed,
    doc,
    'a document whose only marker-shaped lines are fenced must compose byte-identically',
  );
});

// ─── Row 12: no shipped agent carries a marker-shaped line outside a fence ────
//
// This is the guard that makes row 11's protection load-bearing. If someone adds
// an UNFENCED marker example to an agent as documentation, the composer parses it
// as a real marker and silently swallows the line at emit. Parsing every shipped
// agent and requiring zero EXPLICIT sections catches that at test time instead of
// in a user's installed tree.
//
// It is deliberately an equality-to-empty assertion rather than a count: when the
// per-agent manifest family that would make agent gating admissible eventually
// lands, this test must be revisited on purpose, not silently satisfied.

test('row 12 — no shipped agent carries an unfenced gsd:section marker', () => {
  const offenders = [];
  for (const name of fs.readdirSync(AGENTS_DIR).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = path.posix.join('agents', name);
    const content = fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
    const explicit = parseWorkflowSections(content, rel).filter((s) => s.explicit);
    if (explicit.length > 0) offenders.push(`${rel}: ${explicit.map((s) => s.id).join(', ')}`);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'An agent carries a gsd:section marker outside a fence. If it is DOCUMENTATION, fence it — ' +
      'the composer cannot tell an unfenced example from a real marker and will drop the line ' +
      'from the emitted agent. If it is meant as real gating, it will not work: ' +
      'gen-section-manifest.cjs scans only gsd-core/workflows/, so an agent atom has no consumer ' +
      'and evaluates false forever (see ADR-1671, "the grammar does NOT extend to agents/").\n' +
      `Offenders:\n  ${offenders.join('\n  ')}`,
  );
});

// ─── Row 12b: the guard is not vacuous — a whole-line unfenced marker IS a marker ──
//
// Refined by a real failure: the grammar is WHOLE-LINE only. An open marker placed
// INLINE inside a sentence is NOT recognised as an open — so the hazard row 12
// guards against is specifically an unfenced marker on its OWN line, which is
// exactly how a documentation example is normally written.

test('row 12b — a whole-line unfenced marker in agent prose is detected as a real marker', () => {
  const doc = [
    '---',
    'name: gsd-example',
    '---',
    '',
    'To open a section, write:',
    '',
    '<!-- gsd:section id="demo" when="always" -->',
    'body',
    '<!-- /gsd:section -->',
    '',
  ].join('\n');

  const explicit = parseWorkflowSections(doc, 'agents/gsd-example.md').filter((s) => s.explicit);
  assert.deepStrictEqual(
    explicit.map((s) => s.id),
    ['demo'],
    'a whole-line UNFENCED marker must parse as a real marker — this is precisely why row 12 ' +
      'exists; if this assertion ever fails, row 12 is guarding against nothing',
  );
});

// ─── Row 12c: an INLINE marker-shaped span is not a marker ───────────────────

test('row 12c — an inline marker-shaped span mid-sentence is not treated as an open marker', () => {
  const doc = [
    '---',
    'name: gsd-example',
    '---',
    '',
    'Write <!-- gsd:section id="demo" when="always" --> to open a section.',
    '',
  ].join('\n');

  const explicit = parseWorkflowSections(doc, 'agents/gsd-example.md').filter((s) => s.explicit);
  assert.deepStrictEqual(
    explicit.map((s) => s.id),
    [],
    'an inline marker-shaped span is prose, not a marker — the grammar is whole-line only',
  );
});
