// allow-test-rule: structural-regression-guard see #2517
// Guards the omit-when-inherit fix: plan-phase.md and execute-phase.md must instruct
// the agent to OMIT the model= param from Agent() calls when the *_model var is
// "inherit" or empty. Without it, model="" is passed verbatim and 404s on non-Claude
// runtimes (resolve_model_ids:"omit" + model_profile:"inherit" → empty model string).
// execute-phase had the fix; plan-phase was missing it (#2517).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Each orchestrator that spawns model-tagged subagents must carry the rule.
const GUARDED = [
  'gsd-core/workflows/plan-phase.md',
  'gsd-core/workflows/execute-phase.md',
];

test('#2517: plan-phase/execute-phase document omitting model= when *_model is inherit/empty', () => {
  for (const rel of GUARDED) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // The rule: "omit the model= param ... when *_model is inherit/empty".
    // Require "omit" near "model=" AND "inherit" present — the three signals of the rule.
    const omitNearModel = /omit[\s\S]{0,200}model=|model=[\s\S]{0,200}omit/i.test(content);
    assert.ok(
      omitNearModel && /inherit/i.test(content),
      `${rel}: must instruct the agent to OMIT the model= param from Agent() calls when the ` +
        `*_model var is "inherit" or empty (#2517) — else model="" 404s on non-Claude runtimes ` +
        `(resolve_model_ids:"omit" + model_profile:"inherit" yields an empty model string).`,
    );
  }
});
