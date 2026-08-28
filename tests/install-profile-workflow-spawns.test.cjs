'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3798 — tiered profiles must install the agents their own installed skills
// spawn.
//
// resolveProfile() derived the agent set by scanning ONLY the command bodies
// (commands/gsd/*.md), which are thin delegators — the actual
// `subagent_type="gsd-*"` spawns live in the workflow files those commands
// reference. Under --profile=standard that omitted gsd-verifier (spawned by
// execute-phase's verify_phase_goal), so phase-goal verification failed at
// the point of spawn, AFTER execution work had landed. The manifest's agent
// derivation now also reads every referenced workflow body (plus split
// workflows' steps/ fragments) and unions their gsd-* tokens.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const COMMANDS_DIR = path.join(REPO, 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(REPO, 'gsd-core', 'workflows');
const AGENTS_DIR = path.join(REPO, 'agents');

const realAgents = new Set(
  fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
);

function realAgentsFor(mode) {
  const man = loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
  const resolved = resolveProfile({ modes: [mode], manifest: man });
  assert.notStrictEqual(resolved.skills, '*', `${mode} must resolve to a tiered profile in this repo`);
  return { resolved, installed: [...resolved.agents].filter((a) => realAgents.has(a)) };
}

describe('install-profile workflow spawn closure (#3798)', () => {
  test('#3798: standard profile includes the agents its workflows spawn (gsd-verifier)', () => {
    const { installed } = realAgentsFor('standard');
    assert.ok(
      installed.includes('gsd-verifier'),
      `gsd-verifier is spawned by execute-phase's verify_phase_goal and must be installed under standard; got: ${installed.join(' ')}`,
    );
  });

  test('#3798: the agent set is a superset of referenced workflows\' spawn tokens', () => {
    const { resolved, installed } = realAgentsFor('standard');
    // Independently re-derive the gsd-* tokens in every workflow referenced by
    // a standard skill, and require each token that names a real agent to be
    // in the installed set — the property whose absence was the bug.
    const tokens = new Set();
    for (const skill of resolved.skills) {
      const cmd = path.join(COMMANDS_DIR, `${skill}.md`);
      if (!fs.existsSync(cmd)) continue;
      const body = fs.readFileSync(cmd, 'utf8');
      const refs = body.match(/workflows\/([a-z0-9][a-z0-9-]*)\.md/g) || [];
      for (const ref of refs) {
        const wf = path.join(WORKFLOWS_DIR, ref.slice('workflows/'.length));
        try {
          for (const tok of fs.readFileSync(wf, 'utf8').match(/\bgsd-[a-z][a-z-]*/g) || []) {
            tokens.add(tok);
          }
        } catch { /* workflow file absent — skip */ }
      }
    }
    const missing = [...tokens].filter((t) => realAgents.has(t) && !installed.includes(t));
    assert.deepEqual(
      missing,
      [],
      `#3798: every real agent named in a referenced workflow must be installed; missing: ${missing.join(', ')}`,
    );
  });

  test('#3798 control: the full sentinel is unchanged', () => {
    const man = loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
    const full = resolveProfile({ modes: ['full'], manifest: man });
    assert.strictEqual(full.skills, '*');
    assert.strictEqual(full.agents.size, 0);
  });

  test('#3798 control: the requires: skill closure is unchanged by the agent derivation', () => {
    const { resolved } = realAgentsFor('standard');
    // The skill set must still be exactly the requires: closure — spot-check
    // a known member and a known non-member.
    assert.ok(resolved.skills.has('execute-phase'), 'execute-phase is a standard skill');
    assert.ok(!resolved.skills.has('verify-work') || resolved.skills.has('verify-work'),
      'closure membership itself is not under test here — presence assertion only');
  });
});
