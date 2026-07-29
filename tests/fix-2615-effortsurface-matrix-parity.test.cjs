// allow-test-rule: runtime-contract-is-the-product #2615 — the host-integration matrix
// IS the cited source of truth for every descriptor axis (ADR-1239); asserting that a
// shipped axis value appears there, and matches, is a contract assertion.

/**
 * Regression test for #2615 — `effortSurface` was a shipped `hostIntegration` axis
 * with NO presence in the matrix that is supposed to be its cited source of truth.
 *
 * #2481 added the axis and wrote docs-sourced values into 18 descriptors
 * (`claude`/`codex`/`opencode` -> `argv`, 15 others -> `undocumented`) but never
 * touched `docs/reference/host-integration-capability-matrix.md`: the axes legend
 * omitted it and not one per-runtime table carried a row. `src/host-integration.cts`
 * states "every value is documented or explicitly 'undocumented'" — for this axis
 * that was false for every runtime.
 *
 * This test is deliberately GENERIC rather than a hardcoded list: it derives the
 * runtimes from the registry, so a runtime added later fails here until its matrix
 * row exists. That is the ratchet the original gap needed — #2481 added an axis and
 * nothing caught the missing documentation.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');
const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

// Normalize CRLF so the row regexes hold on a Windows autocrlf checkout.
const MATRIX_TEXT = fs.readFileSync(MATRIX, 'utf-8').replace(/\r\n/g, '\n');

/** Extract a `## <host>` section body, stopping at the next top-level host heading. */
function section(host) {
  const start = MATRIX_TEXT.indexOf(`\n## ${host}\n`);
  if (start === -1) return null;
  const rest = MATRIX_TEXT.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Read the value cell of a `| <axis> | <value> | …` row. */
function axisValue(body, axis) {
  const row = body.split(/\r?\n/).find((l) => l.startsWith(`| ${axis} |`));
  return row ? row.split('|')[2].trim() : null;
}

const RUNTIMES = Object.keys(registry.runtimes).filter(
  (id) => registry.runtimes[id]?.runtime?.hostIntegration,
);

describe('#2615: the matrix documents the effortSurface axis', () => {
  test('the axes legend defines effortSurface and its vocabulary', () => {
    const legendRow = MATRIX_TEXT.split(/\r?\n/).find((l) => l.startsWith('| `effortSurface` |'));
    assert.ok(legendRow, 'the axes legend must define effortSurface (#2615)');
    for (const member of ['`argv`', '`none`', '`undocumented`']) {
      assert.ok(legendRow.includes(member),
        `the legend must document the ${member} vocabulary member (#2615)`);
    }
  });

  test('there is at least one runtime to check', () => {
    // Guards the loops below against silently asserting nothing.
    assert.ok(RUNTIMES.length >= 18, `expected the full runtime corpus, got ${RUNTIMES.length}`);
  });

  for (const id of RUNTIMES) {
    describe(`runtime: ${id}`, () => {
      test('has a matrix section', () => {
        assert.ok(section(id), `${id}: every installed runtime needs a matrix section (ADR-1239)`);
      });

      test('documents effortSurface, and the value matches the descriptor', () => {
        const body = section(id);
        assert.ok(body, `${id}: missing matrix section`);

        const documented = axisValue(body, 'effortSurface');
        assert.ok(documented, `${id}: the matrix must carry an effortSurface row (#2615)`);

        const declared = registry.runtimes[id].runtime.hostIntegration.effortSurface;
        if (declared === undefined) {
          // kimi-code declares no value: its mechanism (`/effort`) is interactive-only
          // and neither `argv` nor `none` describes it. The matrix must say so rather
          // than invent a value.
          assert.match(documented, /not declared/i,
            `${id}: an absent descriptor value must be documented as absent, not guessed (#2615)`);
        } else {
          assert.equal(documented, declared,
            `${id}: the matrix effortSurface value must match the shipped descriptor`);
        }
      });
    });
  }
});
