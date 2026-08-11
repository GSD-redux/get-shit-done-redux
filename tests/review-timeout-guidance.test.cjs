'use strict';

/**
 * #2194 — review.md prompt-fed reviewers (Gemini/Claude/Codex) need explicit
 * Bash timeout guidance.
 *
 * Without it each lane inherits the host default (~2 min on Claude Code), so a
 * source-grounded review (~570s Codex xhigh, ~525s headless Claude) is killed
 * mid-review, its output is empty, and the cross-AI review silently proceeds
 * with fewer lanes. CodeRabbit and OpenCode already documented a timeout; the
 * four main lanes did not. review.md IS the product the runtime loads, so this asserts the
 * deployed text carries the guidance.
 *
 * Phase 5b (#2799) replaced the per-lane blocks with a loop, so the anchor moved from the old
 * "invoke in sequence" prose to the step itself — but the guidance is MORE load-bearing now, not
 * less: one Bash call wraps the whole loop, so a host timeout kills every remaining lane rather
 * than one.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

describe('#2194 review.md prompt-fed reviewer timeout guidance', () => {
  const content = fs.readFileSync(REVIEW_MD, 'utf-8');
  const sectionStart = content.indexOf('<step name="invoke_reviewers">');
  const sectionEnd = content.indexOf('</step>', sectionStart);
  const section = sectionStart !== -1 ? content.slice(sectionStart, sectionEnd) : '';

  test('review.md has the reviewer-invocation step', () => {
    assert.notEqual(sectionStart, -1, 'review.md must contain the invoke_reviewers step');
  });

  test('lanes are invoked sequentially, not in parallel', () => {
    // Concurrent invocation trips provider rate limits; the original prose said so and the loop
    // must keep saying so, since a future reader could otherwise "optimize" it into a fan-out.
    assert.ok(/sequential|in sequence|not in parallel/i.test(section),
      'the step must state that lanes run sequentially');
  });

  test('the section carries Bash timeout guidance for the prompt-fed lanes', () => {
    assert.ok(/timeout/i.test(section),
      'the Gemini/Claude/Codex reviewer blocks must carry Bash timeout guidance');
    assert.ok(/900000|1200000/.test(section),
      'timeout guidance must recommend a high ms value (>= 900000) so a slow lane is not killed');
  });

  test('a slow-lane empty output is framed as a timeout, not a crash', () => {
    assert.ok(/timeout.+not.+crash|not a crash/i.test(section),
      'the guidance must distinguish a timeout kill from a crash so operators do not misdiagnose (e.g. the Codex 0xc0000142 misattribution)');
  });
});
