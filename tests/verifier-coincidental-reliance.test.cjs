// allow-test-rule: source-text-is-the-product (see #1955)
// Agent .md / template .md / docs .md files — their text IS what the runtime
// loads, so asserting on the text asserts the deployed contract. Same category
// tests/verifier-behavior-unverified.test.cjs uses for the sibling #966 axis.
// Per CONTRIBUTING.md exception matrix.

'use strict';

/**
 * Issue #1955 — the verifier grades THAT a truth holds, never WHY.
 *
 * This suite locks the `coincidental-reliance` advisory: for a truth that
 * already reached ✓ VERIFIED, the verifier additionally classifies whether it
 * holds for a guaranteed reason or an incidental one, and names the incidental
 * ones so they can be hardened instead of shipping invisibly.
 *
 * The load-bearing assertions are the INVARIANTS, not the feature:
 *   - the advisory changes neither the verified score nor the overall status;
 *   - it never emits a human-verification item (Step 9 rule 2 would escalate a
 *     passing phase to `human_needed`, contradicting "the phase can still pass");
 *   - ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (#966) stays the ONLY truth state excluded
 *     from `verified_truths`;
 *   - the per-truth token never enters the overall-status vocabulary;
 *   - the qualifier SUFFIXES `✓ VERIFIED` rather than replacing it, so every
 *     substring matcher on the old verdict still hits (Hyrum's Law).
 *
 * Deliberately absent: any assertion on the model's verdict. ADR-550 Decision 5
 * rejects that as vacuous — the CI-testable surface is the deterministic
 * contract, which for a prose rubric is the shipped text.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Canonical sources of truth (CONTRIBUTING.md "Source of truth for agents") —
// never .claude/agents/, which is a gitignored install-sync output and would
// false-pass against a stale local sync.
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

const verifier = read('agents', 'gsd-verifier.md');
const template = read('gsd-core', 'templates', 'verification-report.md');
const agentsDoc = read('docs', 'AGENTS.md');

const QUALIFIER = '✓ VERIFIED (coincidental-reliance)';
const REASONS = ['undeclared-precondition', 'incidental-ordering', 'fixture-only'];

/**
 * Return a window of `source` centred on the first occurrence of `needle`,
 * extending `radius` characters either side. Used to assert that a clause sits
 * WITH the rule rather than anywhere in a 47 KB file — a bare
 * `assert.match(verifier, /score/)` would pass on unrelated prose.
 */
function sectionAround(source, needle, radius) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected to find '${needle}' in the source`);
  return source.slice(Math.max(0, at - radius), at + needle.length + radius);
}

describe('#1955: coincidental-reliance advisory — the rule', () => {
  test('defines the coincidental-reliance advisory', () => {
    assert.match(verifier, /coincidental-reliance/);
  });

  test('names the three reliance triggers', () => {
    for (const reason of REASONS) {
      assert.ok(
        verifier.includes(reason),
        `verifier must name the '${reason}' trigger`,
      );
    }
  });

  test('advisory applies only to truths that reached VERIFIED', () => {
    // The advisory explains why a PASSING truth passes. A truth that never
    // reached ✓ VERIFIED has nothing to explain. Asserted on the window around
    // the rule rather than a forward-only regex: the scoping clause precedes
    // the first `coincidental-reliance` token, so `token[\s\S]{0,N}?✓ VERIFIED`
    // structurally cannot see it.
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /✓ VERIFIED truth/);
  });

  test('does not double-report truths already routed to human verification', () => {
    // PRESENT_BEHAVIOR_UNVERIFIED (#966) and insufficient_spec (honest-verifier)
    // already route to human_needed; re-flagging them is noise.
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /PRESENT_BEHAVIOR_UNVERIFIED/);
    assert.match(window, /insufficient_spec/);
  });

  test('an accepted override is not re-flagged', () => {
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /override/i);
  });

  test('carries a do-not-flag list bounding the false-positive surface', () => {
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /(do not flag|don't flag|never flag)/i);
    // The negative space must name at least the two cases that most look like
    // the trigger and are not: code-established preconditions and enforced
    // ordering.
    assert.match(window, /(enforce|await|explicit sequenc)/i);
    assert.match(window, /default/i);
  });

  test('rule routes on recorded evidence, not self-rated confidence', () => {
    // The .out-of-scope/general-purpose-agent-prompt-skills.md reason-4 bar:
    // self-rated confidence is measured weak (honest-verifier.md:25-29). The
    // shipped prose must carry that constraint, not just the design doc.
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /honest-verifier/);
    assert.match(window, /confiden/i);
  });
});

describe('#1955: coincidental-reliance advisory — the invariants', () => {
  test('advisory does not change the verified score', () => {
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /score/i);
    assert.match(window, /(not the score|never the score|does not (change|affect) the score|no score)/i);
  });

  test('advisory does not change the overall status', () => {
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /(not the status|never the status|does not (change|affect) the status|status is unchanged)/i);
  });

  test('advisory never emits a human-verification item', () => {
    // Step 9 rule 2: ANY human-verification item forces `human_needed`. An
    // advisory that emitted one would stop a passing phase from passing, which
    // is precisely what issue #1955 says must NOT happen.
    const window = sectionAround(verifier, 'coincidental-reliance', 1400);
    assert.match(window, /never[^.]{0,80}human-verification item/i);
  });

  test('PRESENT_BEHAVIOR_UNVERIFIED remains the only score-excluded truth state', () => {
    // #966's invariant, asserted here so #1955 cannot silently erode it.
    assert.match(
      verifier,
      /PRESENT_BEHAVIOR_UNVERIFIED truths are the \*only\* ones excluded from `verified_truths`/,
    );
  });

  test('PARITY: the per-truth advisory never leaks into the status vocabulary', () => {
    const unionLines = verifier.match(/^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$/gm) || [];
    assert.ok(unionLines.length > 0, 'expected at least one status union line');
    for (const line of unionLines) {
      assert.doesNotMatch(line, /coincidental/i);
      for (const s of ['passed', 'gaps_found', 'human_needed']) {
        assert.ok(line.includes(s), `status union must still contain ${s}: ${line}`);
      }
    }
  });

  test('overall-status enum in verification.cts is unchanged', () => {
    const cts = read('src', 'verification.cts');
    const m = cts.match(/VERIFIER_STATUSES[^=]*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'VERIFIER_STATUSES array must be present');
    assert.doesNotMatch(m[1], /coincidental/i);
    for (const s of ['passed', 'gaps_found', 'human_needed']) {
      assert.match(m[1], new RegExp(`'${s}'`));
    }
  });

  test('qualifier suffixes VERIFIED, never replaces it (Hyrum)', () => {
    // Every rendered verdict carrying the qualifier must keep the `✓ VERIFIED`
    // token verbatim and leading, so a consumer matching the old verdict as a
    // substring still hits. A bare `(coincidental-reliance)` verdict cell, or
    // any form that puts the qualifier before the token, is a break.
    for (const source of [verifier, template]) {
      const verdictCells = source.match(/\|\s*[^|\n]*coincidental-reliance[^|\n]*\|/g) || [];
      for (const cell of verdictCells) {
        assert.ok(
          cell.includes(QUALIFIER),
          `verdict cell must render as "${QUALIFIER}": ${cell.trim()}`,
        );
      }
    }
    assert.ok(
      verifier.includes(QUALIFIER),
      'the agent must show the suffixed verdict form at least once',
    );
  });
});

describe('#1955: coincidental-reliance advisory — the report surface', () => {
  test('report frontmatter carries coincidental_reliance_items', () => {
    assert.match(verifier, /coincidental_reliance_items/);
  });

  test('items list is omitted when nothing is flagged', () => {
    // 0-flag boundary: the key follows the `overrides:` / `deferred:` "only if"
    // convention rather than emitting an empty array.
    assert.match(verifier, /coincidental_reliance_items:[^\n]*(only if|Only if)/);
  });

  test('item shape names the truth, the reason, and the hardening', () => {
    // 1-flag boundary: an advisory that names no fix is not actionable.
    // `coincidental_reliance_items: #` anchors the FRONTMATTER block. The bare
    // key also appears earlier in the rule prose, and a window around that
    // occurrence contains none of the item fields.
    const window = sectionAround(verifier, 'coincidental_reliance_items: #', 500);
    assert.match(window, /truth:/);
    assert.match(window, /reason:/);
    assert.match(window, /(harden|fix|precondition)/i);
  });

  test('items survive a gaps_found phase', () => {
    // many-flag / mixed boundary: same survival rule behavior_unverified_items
    // carries, so an advisory is not lost when the phase also has gaps.
    const window = sectionAround(verifier, 'coincidental_reliance_items: #', 500);
    assert.match(window, /(regardless of (overall )?status|survive|never lost)/i);
  });
});

describe('#1955: cross-surface parity', () => {
  test('PARITY: agent and standalone template agree on the advisory vocabulary', () => {
    // Generative-fix-divergence gate: two surfaces render the same report, so a
    // token added to one and not the other is the defect this test exists for.
    for (const token of ['coincidental-reliance', ...REASONS]) {
      assert.ok(verifier.includes(token), `agent must carry '${token}'`);
      assert.ok(template.includes(token), `standalone template must carry '${token}'`);
    }
    assert.ok(
      template.includes('coincidental_reliance_items'),
      'standalone template must carry the frontmatter items list',
    );
  });

  test('template guidelines document the advisory per-truth state', () => {
    const guidelines = template.slice(template.indexOf('**Per-truth states'));
    assert.ok(guidelines.length > 0, 'template must keep its per-truth states guideline');
    assert.match(guidelines, /coincidental-reliance/);
  });

  test('docs/AGENTS.md documents the coincidental-reliance advisory', () => {
    assert.match(agentsDoc, /coincidental-reliance/);
  });
});
