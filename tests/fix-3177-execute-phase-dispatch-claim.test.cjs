/**
 * #3177 — `gsd-core/workflows/execute-phase.md` asserted that Claude Code's
 * `Agent(...)` "blocks until complete, returns result", and restated the same
 * claim further down as "Claude Code's Agent() normally returns synchronously".
 *
 * Both were stale. Claude Code runs subagents in the BACKGROUND by default as of
 * v2.1.198; `run_in_background: false` is the explicit opt-out when an immediate
 * result is needed (code.claude.com/docs/en/sub-agents,
 * /agent-sdk/subagents, /tools-reference).
 *
 * This package already recorded the true value: `capabilities/claude/capability.json`
 * declares `dispatch.background: true` and `docs/reference/host-integration-capability-matrix.md`
 * renders it. So the SHIPPED PROSE and the SHIPPED MATRIX disagreed about the same
 * runtime — and the prose is the copy loaded verbatim into the orchestrator's context
 * on every `/gsd-execute-phase` run, where it is the premise a spawn-safety conclusion
 * leans on (#3159 documents a host where that difference cost a wave of executor work).
 *
 * The durable guard is therefore NOT a snapshot of today's wording: it is a PARITY
 * assertion (tests 3 and 4) that reds whenever the prose, the matrix, and the descriptor
 * stop agreeing about `dispatch.background` — in either direction. Tests 5 and 6 pin the
 * negative space so a future correction cannot over-sweep: Codex dispatch genuinely IS
 * synchronous, and its orchestrator rules must survive a fix aimed at Claude Code.
 */

// allow-test-rule: runtime-contract-is-the-product #3177 — the workflow markdown is loaded
// verbatim into the agent's context and the matrix/descriptor ARE the negotiated host
// contract; asserting agreement between those documents is behavioral, not source-grep.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');
const DESCRIPTOR = path.join(ROOT, 'capabilities', 'claude', 'capability.json');

const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8');

/**
 * Value of `| <field> | <value> | …` inside the `## <host>` section of the matrix.
 *
 * Anchored on a whole heading LINE, not a substring: `## claude` must never match
 * `## claude-local`, and the section must end at the next `## ` heading so a field
 * absent from this host can never be answered from the next host's table.
 *
 * @param {string} matrix - full matrix document text
 * @param {string} host - section name, e.g. `claude`
 * @param {string} field - row label, e.g. `dispatch.background`
 * @returns {string|null} trimmed cell value, or null when the section or row is absent
 */
function matrixField(matrix, host, field) {
  const lines = matrix.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${host}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const row = lines.slice(start + 1, end).find((l) => l.startsWith(`| ${field} |`));
  if (!row) return null;
  return row.split('|')[2].trim();
}

describe('#3177: execute-phase.md states Claude Code dispatch truthfully', () => {
  test('execute-phase.md never claims Claude Code Agent() blocks or returns synchronously', () => {
    // Row 1 — the failing-first regression. Both stale sentences, by their own text.
    const text = workflowText();
    const stale = ['blocks until complete', 'returns synchronously'];
    const present = stale.filter((phrase) => text.includes(phrase));
    assert.deepEqual(
      present, [],
      'execute-phase.md still asserts synchronous Claude Code dispatch. Claude Code backgrounds '
      + 'subagents by default (v2.1.198+); `run_in_background: false` is the opt-out.',
    );
  });

  test('the Claude Code dispatch bullet states the background-by-default model', () => {
    // Row 2 — the corrected sentence must actually SAY the true thing, not merely
    // omit the false one. A deletion would pass row 1 while teaching nothing.
    const bullet = workflowText()
      .split('\n')
      .find((l) => l.startsWith('- **Claude Code:**'));
    assert.ok(bullet, 'the <runtime_compatibility> Claude Code bullet must exist');
    assert.match(
      bullet, /backgrounded by default/,
      'the bullet must state that dispatch is backgrounded by default',
    );
    assert.match(
      bullet, /run_in_background/,
      'the bullet must name the `run_in_background` opt-out that makes the call blocking',
    );
    assert.ok(
      bullet.includes('Agent(subagent_type="gsd-executor"'),
      'the bullet must still carry the dispatch mechanism the rest of the file depends on',
    );
  });

  test('the workflow prose and the capability matrix agree on claude dispatch.background', () => {
    // Row 3 — the parity guard. This is the assertion that outlives the wording:
    // flip the matrix to `false` without touching the prose (or vice versa) and this reds.
    const declared = matrixField(fs.readFileSync(MATRIX, 'utf8'), 'claude', 'dispatch.background');
    assert.equal(declared, 'true', 'matrix must document claude dispatch.background');

    const bullet = workflowText()
      .split('\n')
      .find((l) => l.startsWith('- **Claude Code:**'));
    const proseSaysBackground = /backgrounded by default/.test(bullet ?? '');
    assert.equal(
      proseSaysBackground, declared === 'true',
      'execute-phase.md and the host-integration matrix disagree about whether claude backgrounds '
      + 'its subagent dispatch. They describe the same runtime; exactly one of them is wrong (#3177).',
    );
  });

  test('the claude descriptor and the matrix agree on dispatch.background', () => {
    // Row 4 — the other half of the divergence class. The matrix is generated from
    // the descriptor, so this pins the generator's output to its input.
    const descriptor = JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8'));
    const declared = matrixField(fs.readFileSync(MATRIX, 'utf8'), 'claude', 'dispatch.background');
    assert.equal(
      String(descriptor.runtime.hostIntegration.dispatch.background), declared,
      'capabilities/claude/capability.json and the rendered matrix disagree',
    );
  });

  test('the Codex orchestrator rule is not swept by the Claude Code correction', () => {
    // Row 5 — negative space. Codex dispatch IS synchronous. A regex sweep for
    // "return its result" would introduce a NEW falsehood here; this catches that.
    const text = workflowText();
    const codexRules = text
      .split('\n')
      .filter((l) => l.includes('ORCHESTRATOR RULE — CODEX RUNTIME'));
    assert.ok(codexRules.length >= 2, 'both Codex orchestrator rules must survive');
    for (const rule of codexRules) {
      assert.ok(
        rule.includes('Wait for the subagent to return its result'),
        'Codex dispatch is genuinely synchronous — its wait rule must not be corrected away',
      );
    }
  });

  test('the Copilot and multi-plan dispatch rules survive the correction', () => {
    // Row 6 — negative space. These were already true and are adjacent to the edit.
    const text = workflowText();
    assert.ok(
      text.includes('- **Copilot:** Subagent spawning does not reliably return completion signals.'),
      'the Copilot bullet must survive verbatim',
    );
    assert.ok(
      text.includes('one at a time with `run_in_background: true`'),
      'the multi-plan wave prescription must survive verbatim',
    );
    assert.ok(
      text.includes('If `Agent` IS available (top-level Claude'),
      'the spawn mandate is derived from TOOL AVAILABILITY, not from blocking — it must survive',
    );
  });
});

describe('#3177: matrix section extraction is bounded by its heading', () => {
  const matrix = () => fs.readFileSync(MATRIX, 'utf8');

  test('section extraction — first row of the section', () => {
    // limit-1: the row immediately after the `## claude` heading is INSIDE.
    assert.equal(matrixField(matrix(), 'claude', 'embeddingMode'), 'imperative');
  });

  test('section extraction — last row before the next heading', () => {
    // limit: the final row of `## claude` is still INSIDE.
    assert.ok(matrixField(matrix(), 'claude', 'dispatch.isolation').startsWith('harness-worktree'));
  });

  test('section extraction — a row in the next section never leaks in', () => {
    // limit+1: a field absent from claude must be null rather than silently
    // resolved from `## codex` below it, and two hosts with different values
    // must never resolve to the same cell.
    const doc = matrix();
    assert.equal(matrixField(doc, 'claude', 'dispatch.background'), 'true');
    assert.equal(matrixField(doc, 'claude', '__definitely_not_a_field__'), null);
    assert.notEqual(
      matrixField(doc, 'claude', 'effortSurface'),
      matrixField(doc, 'kilo', 'effortSurface'),
      'two hosts with different values must not resolve to the same cell',
    );
  });

  test('fc property: field extraction never leaks across ## boundaries', () => {
    const hostArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
    const valueArb = fc.stringMatching(/^[a-z0-9]{1,10}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(hostArb, valueArb), {
          minLength: 2, maxLength: 6, selector: ([h]) => h,
        }),
        fc.nat(),
        (sections, pick) => {
          const doc = sections
            .map(([host, value]) => `## ${host}\n\n| axis | value |\n| f | ${value} |\n`)
            .join('\n');
          const [host, value] = sections[pick % sections.length];
          // Exactly the requested section's value, never a neighbor's.
          assert.equal(matrixField(doc, host, 'f'), value);
          // A heading that only PREFIXES a real one resolves to nothing.
          assert.equal(matrixField(doc, `${host}-local`, 'f'), null);
        },
      ),
      { numRuns: 200 },
    );
  });
});
