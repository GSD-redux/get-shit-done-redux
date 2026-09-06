'use strict';

// #4394: unit tests for the allowed-tools parity lint. The rule reads command
// frontmatter, so every arm below drives it against a synthetic commands
// directory rather than the live corpus — a test that asserted "the real tree
// is clean" would say nothing about whether the rule can DETECT anything, and
// that is exactly the failure mode this lint exists to close (the pre-existing
// generated-sync check compares the two trees only to each other, so a shared
// omission was invisible to it).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseAllowedTools, scan, EXEMPT } = require('../scripts/lint-allowed-tools-parity.cjs');
const { cleanup } = require('./helpers.cjs');

/** Write a synthetic commands dir; returns its absolute path. */
function fixture(commands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4394-'));
  for (const [stem, tools] of Object.entries(commands)) {
    const frontmatter = tools === null
      ? ['---', `name: gsd:${stem}`, '---', '']
      : ['---', `name: gsd:${stem}`, 'allowed-tools:', ...tools.map((t) => `  - ${t}`), 'requires: []', '---', ''];
    fs.writeFileSync(path.join(dir, `${stem}.md`), `${frontmatter.join('\n')}\nbody\n`);
  }
  return dir;
}

describe('#4394 parseAllowedTools', () => {
  test('reads a YAML block sequence', () => {
    const text = ['---', 'name: gsd:x', 'allowed-tools:', '  - Read', '  - Bash', 'requires: []', '---'].join('\n');
    assert.deepEqual(parseAllowedTools(text), ['Read', 'Bash']);
  });

  test('stops at the next frontmatter key, not at the end of the file', () => {
    // A body bullet list must not be swallowed into the tool set.
    const text = [
      '---', 'allowed-tools:', '  - Read', 'requires: [review]', '---', '', 'Steps:', '  - Bash', '',
    ].join('\n');
    assert.deepEqual(parseAllowedTools(text), ['Read']);
  });

  test('reads an inline flow sequence and a bare inline list', () => {
    assert.deepEqual(parseAllowedTools('allowed-tools: [Read, Bash]'), ['Read', 'Bash']);
    assert.deepEqual(parseAllowedTools('allowed-tools: Read, Bash'), ['Read', 'Bash']);
  });

  test('strips quotes around tool names', () => {
    assert.deepEqual(parseAllowedTools("allowed-tools: ['Read', \"Bash\"]"), ['Read', 'Bash']);
  });

  test('returns null when the key is absent', () => {
    // Absent is NOT a violation: a command with no allowed-tools declares no
    // Bash either, so the rule has nothing to say about it. Returning [] here
    // would be indistinguishable from "declared, but empty".
    assert.equal(parseAllowedTools('---\nname: gsd:x\n---\n'), null);
  });
});

describe('#4394 scan — the rule detects, and only what it should', () => {
  test('flags Bash without Grep', () => {
    const dir = fixture({ offender: ['Read', 'Bash'] });
    try {
      const { violations } = scan(dir);
      assert.deepEqual(violations.map((v) => v.stem), ['offender']);
      // The message has to carry the declared set, or the fix is a guess.
      assert.deepEqual(violations[0].tools, ['Read', 'Bash']);
    } finally { cleanup(dir); }
  });

  test('accepts Bash WITH Grep', () => {
    const dir = fixture({ fine: ['Read', 'Bash', 'Grep'] });
    try {
      assert.deepEqual(scan(dir).violations, []);
    } finally { cleanup(dir); }
  });

  test('ignores a command that declares no Bash', () => {
    // The rule is about Bash standing in for a search the command cannot
    // perform. No Bash, no substitution, nothing to say.
    const dir = fixture({ reader: ['Read', 'Skill'] });
    try {
      assert.deepEqual(scan(dir).violations, []);
    } finally { cleanup(dir); }
  });

  test('ignores a command with no allowed-tools key at all', () => {
    const dir = fixture({ bare: null });
    try {
      assert.deepEqual(scan(dir).violations, []);
    } finally { cleanup(dir); }
  });

  test('reports every offender, not just the first', () => {
    const dir = fixture({ a: ['Bash'], b: ['Bash'], c: ['Bash', 'Grep'] });
    try {
      assert.deepEqual(scan(dir).violations.map((v) => v.stem), ['a', 'b']);
    } finally { cleanup(dir); }
  });
});

describe('#4394 scan — the exemption list cannot rot', () => {
  // An exemption list that can only grow becomes a list of things nobody
  // re-examined. These arms are what keep an exemption a real suppression
  // rather than a comment.
  const exemptStem = [...EXEMPT.keys()][0];

  test('an exempt command that still needs its entry is silent', () => {
    const dir = fixture({ [exemptStem]: ['Read', 'Write', 'Bash'] });
    try {
      const { violations, staleExemptions } = scan(dir);
      assert.deepEqual(violations, []);
      assert.deepEqual(staleExemptions, []);
    } finally { cleanup(dir); }
  });

  test('an exempt command that gained Grep is reported as stale', () => {
    const dir = fixture({ [exemptStem]: ['Read', 'Bash', 'Grep'] });
    try {
      const { staleExemptions } = scan(dir);
      assert.deepEqual(staleExemptions.map((s) => s.stem), [exemptStem]);
      assert.match(staleExemptions[0].reason, /no longer declares Bash without Grep/);
    } finally { cleanup(dir); }
  });

  test('an exemption for a command that no longer exists is reported as stale', () => {
    const dir = fixture({ unrelated: ['Read'] });
    try {
      const { staleExemptions } = scan(dir);
      assert.deepEqual(staleExemptions.map((s) => s.stem), [exemptStem]);
      assert.match(staleExemptions[0].reason, /no such command/);
    } finally { cleanup(dir); }
  });

  test('every exemption carries a non-empty reason', () => {
    // The reason is what makes changing the set reviewable. An entry without
    // one is a suppression nobody can evaluate.
    for (const [stem, reason] of EXEMPT) {
      assert.equal(typeof reason, 'string', `${stem} must carry a reason`);
      assert.ok(reason.trim().length > 10, `${stem}'s reason must say something: ${JSON.stringify(reason)}`);
    }
  });
});

describe('#4394 scan — against the live corpus', () => {
  test('the exemption list has no stale entries on the real tree', () => {
    // Kept separate from the violations count, which is deliberately NOT
    // asserted here: the 21 commands #3085 identified are fixed by its own PR,
    // and pinning a number would make this test a baseline that every such fix
    // has to update. Staleness is different — it is a property of THIS
    // script's list, and it is always this script's job to keep true.
    assert.deepEqual(scan().staleExemptions, []);
  });
});
