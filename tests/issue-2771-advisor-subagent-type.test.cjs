// allow-test-rule: structural-implementation-guard (#2771)
'use strict';

// Regression guard for #2771: the discuss-phase advisor mode must spawn the REGISTERED
// `gsd-advisor-researcher` subagent (auto-loads the agent def), not `general-purpose` —
// which contradicts universal-anti-patterns rule 10 (injected into discuss-phase via
// <required_reading>): "NEVER use non-GSD agent types — ALWAYS use gsd-{agent}".
// Spawning general-purpose + a manual "read the agent def" prompt re-specifies what the
// def already owns (a drift risk; the same shape assumptions's answer_validation hit).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ADVISOR_MD = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'discuss-phase', 'modes', 'advisor.md'
);

test('advisor mode spawns the registered gsd-advisor-researcher subagent, not general-purpose (#2771)', () => {
  const src = fs.readFileSync(ADVISOR_MD, 'utf8');

  // Locate the Agent() block that researches gray areas.
  const agentIdx = src.indexOf('subagent_type=');
  assert.ok(agentIdx !== -1, 'advisor.md must contain an Agent() subagent_type declaration');

  assert.ok(
    src.includes('subagent_type="gsd-advisor-researcher"'),
    'advisor mode must spawn subagent_type="gsd-advisor-researcher" (the registered agent def auto-loads) — not general-purpose (#2771, universal-anti-patterns rule 10)'
  );
  assert.ok(
    !src.includes('subagent_type="general-purpose"'),
    'advisor mode must NOT spawn subagent_type="general-purpose" (contradicts universal-anti-patterns rule 10, injected into the same context) (#2771)'
  );
  // The manual "read @.../gsd-advisor-researcher.md" prompt line must be gone —
  // spawning by type auto-loads the def; re-specifying it is a drift risk. Deny the
  // full class (any "read @" lead-in, case-insensitive) so a phrasing variant can't
  // sneak the drift back in.
  assert.ok(
    !/read\s+@.*gsd-advisor-researcher\.md/i.test(src),
    'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)'
  );
});
