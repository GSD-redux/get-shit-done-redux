'use strict';

/**
 * PR-2 (#2761 / epic #612) — verify.cts: the advisory bracket-coherence W021 and
 * the milestone-complete (B6) read.
 *
 * Postures differ on purpose. checkBracketCoherence is a CHECK THAT CAN FAIL A
 * REPO, so it is gated on `phase_id_convention === 'bracket'`. B6 is pinned by
 * bug-557 with an empty config, so it fires on every repo — but its heading
 * grammar is still SELECTED, never inferred: an earlier design read 'bracket'
 * off the shape of a matched bracket, which ran a repo-failing check against a
 * legacy ROADMAP that merely contained `### [RFC.2119] 5:`.
 *
 * Both commands resolve the convention through the SAME federated
 * workstream->root resolver. Reading it from two different bases split
 * `validate consistency` from `validate health` on workstream repos: one widened
 * the ROADMAP read while the other kept the directory read narrow, so every
 * bracket phase was reported either missing from disk or malformed on disk
 * depending on which side you looked at.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

let tmpDir;

function writeProject({ roadmap, convention, status = 'executing', phaseDirs = [], ws = null }) {
  const root = path.join(tmpDir, '.planning');
  const base = ws ? path.join(root, 'workstreams', ws) : root;
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(path.join(base, 'STATE.md'), ['---', 'gsd_state_version: 1.0',
    'milestone: v2.0', 'milestone_name: Expansion', `status: ${status}`, '---', '',
    '# Project State', '', '**Phase:** 05', ''].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify(convention === undefined ? {} : { phase_id_convention: convention }), 'utf-8');
  const phasesDir = path.join(base, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  for (const d of phaseDirs) fs.mkdirSync(path.join(phasesDir, d), { recursive: true });
}

const codes = (code, env = {}) => {
  const r = runGsdTools(['validate', 'health'], tmpDir, env);
  const out = JSON.parse(r.output);
  return [...(out.issues || []), ...(out.warnings || [])]
    .filter(i => i.code === code).map(i => i.message);
};
const w021 = (env) => codes('W021', env);

const COHERENT = `# Roadmap

## [GSD.02] v2.0 — Expansion

### [GSD.02] 05: Real work
**Goal:** Build it

### [GSD.02] 06: Follow-up
**Goal:** Polish it
`;

// ─── B6 / the ungated milestone-complete warning ───────────────────────────

describe('#612 PR-2: bracket phases resolve to their dirs, so W021 stays silent', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b6-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('milestone complete + every bracket dir present => NO W021', () => {
    writeProject({ roadmap: COHERENT, convention: 'bracket', status: 'milestone complete',
      phaseDirs: ['GSD.02-05-real-work', 'GSD.02-06-follow-up'] });
    assert.deepEqual(w021(), []);
  });

  test('a missing dir still fires — the check is not merely disabled', () => {
    writeProject({ roadmap: COHERENT, convention: 'bracket', status: 'milestone complete',
      phaseDirs: ['GSD.02-05-real-work'] });
    const m = w021();
    assert.equal(m.length, 1, JSON.stringify(m));
    assert.match(m[0], /ROADMAP lists 1 unstarted phase/);
  });

  test('a legacy repo containing a citation heading gains NOTHING', () => {
    // The shape-inference design ran this repo-failing check against a repo that
    // never opted in: base emitted nothing, the branch emitted W006 + W021.
    writeProject({ roadmap: `# Roadmap

## v2.0

### [RFC.2119] 5: Keyword definitions
**Goal:** not a phase
`, convention: undefined, status: 'milestone complete' });
    assert.deepEqual(w021(), []);
    assert.deepEqual(codes('W006'), []);
  });

  test('a bracket SENTINEL heading is not an unstarted phase', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### [GSD.999] 01: Icebox item
**Goal:** Someday

### [GSD.02] 05: Real work
**Goal:** Build it
`, convention: 'bracket', status: 'milestone complete', phaseDirs: ['GSD.02-05-real-work'] });
    assert.deepEqual(w021(), []);
  });

  test('DISCLOSED: a bracket roadmap with the convention unset is invisible, not false-firing', () => {
    writeProject({ roadmap: COHERENT, convention: undefined, status: 'milestone complete' });
    assert.deepEqual(w021(), [], 'silent invisibility, never a phantom unstarted phase');
  });
});

// ─── The federated resolver, end to end ────────────────────────────────────

describe('#612 PR-2: workstream repos resolve one convention, not two', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-ws-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('root config + active workstream: consistency and health agree', () => {
    writeProject({ roadmap: COHERENT, convention: 'bracket', ws: 'ws1',
      phaseDirs: ['GSD.02-05-real-work', 'GSD.02-06-follow-up'] });
    const env = { GSD_WORKSTREAM: 'ws1' };
    const consistency = JSON.parse(runGsdTools(['validate', 'consistency'], tmpDir, env).output);
    assert.deepEqual(
      (consistency.warnings || []).filter(w => /no directory on disk/.test(w)), [],
      'the ROADMAP read and the directory read must resolve from the same config',
    );
    assert.deepEqual(codes('W005', env), [], 'and health must not call the same dirs malformed');
  });
});

// ─── checkBracketCoherence: the gate ───────────────────────────────────────

describe('#612 PR-2: bracket-coherence is gated on the active convention', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-gate-'); });
  afterEach(() => { cleanup(tmpDir); });

  const INCOHERENT = `# Roadmap

## [GSD.02] v2.0 — Expansion

### [GSD.03] 05: Wrong milestone
**Goal:** Build it
`;

  test('fires under the bracket convention, with the field names the right way round', () => {
    writeProject({ roadmap: INCOHERENT, convention: 'bracket' });
    const m = w021();
    assert.equal(m.length, 1, JSON.stringify(m));
    assert.match(m[0], /bracket milestone 03 does not match its section milestone 02/);
  });

  for (const convention of [undefined, 'milestone-prefixed', 'Bracket']) {
    test(`SILENT when the convention is ${JSON.stringify(convention)}`, () => {
      writeProject({ roadmap: INCOHERENT, convention });
      assert.deepEqual(w021().filter(m => /bracket/.test(m)), []);
    });
  }

  test('a coherent bracket roadmap is silent', () => {
    writeProject({ roadmap: COHERENT, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });
});

// ─── Scope rules ───────────────────────────────────────────────────────────

describe('#612 PR-2: coherence scope rules', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-scope-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('a non-phase level-3 heading does NOT clear the section', () => {
    // `### Notes` used to reset the scope and silently disable both sub-checks
    // for every phase after it.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### [GSD.02] 01: Setup
**Goal:** a

### Notes
Some prose.

### [GSD.03] 05: WRONG MILESTONE
**Goal:** b
`, convention: 'bracket' });
    const m = w021();
    assert.equal(m.length, 1, `a prose heading must not disable the check: ${JSON.stringify(m)}`);
    assert.match(m[0], /bracket milestone 03 does not match its section milestone 02/);
  });

  test('an M-NN phase heading raises missing-bracket AND does not end the section', () => {
    // A single M-NN heading — the mid-migration content this epic targets — used
    // to be treated as a section reset and silenced everything after it.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### Phase 2-01: Mnn Legacy
**Goal:** a

### [GSD.03] 05: WRONG MILESTONE
**Goal:** b
`, convention: 'bracket' });
    const m = w021();
    assert.equal(m.length, 2, JSON.stringify(m));
    assert.match(m[0], /Phase 2-01: heading is not in bracket form/);
    assert.match(m[1], /bracket milestone 03 does not match its section milestone 02/);
  });

  test('a legacy MILESTONE heading DOES close the bracket section', () => {
    // Phases under `## v3.0` are out of scope, not compared against — and
    // reported against — a section they are not in.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### [GSD.02] 05: Real
**Goal:** a

## v3.0 — Legacy milestone

### Phase 7: Legacy phase
**Goal:** b
`, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });

  test('a bare `N:` heading is not a phase and raises nothing', () => {
    // `#### 2026: Timeline` and `### 3.5: Rollout` were flagged as phases
    // needing migration.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

#### 2026: Timeline
### 3.5: Rollout options

### [GSD.02] 05: Real
**Goal:** a
`, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });

  test('h5 and h6 phase headings are checked, like every other reader counts them', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

##### [GSD.03] 08: Deep mismatch
**Goal:** a
`, convention: 'bracket' });
    const m = w021();
    assert.equal(m.length, 1, `h5 must not be invisible here: ${JSON.stringify(m)}`);
    assert.match(m[0], /bracket milestone 03 does not match its section milestone 02/);
  });

  test('sentinel sections are exempt', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.999] Backlog

### Phase 1: Icebox in legacy form
**Goal:** a

### [GSD.02] 07: Wrong milestone in an icebox section
**Goal:** b
`, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });

  test('a fenced code block raises nothing', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

\`\`\`markdown
### [GSD.09] 42: An example heading in docs
### Phase 7: A legacy example
\`\`\`

### [GSD.02] 05: Real work
**Goal:** a
`, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });

  test('BOUNDARY: a flat, section-less bracket roadmap gets no checking', () => {
    writeProject({ roadmap: `# Roadmap

### [GSD.03] 05: No enclosing section
**Goal:** a

### Phase 6: Also legacy form
**Goal:** b
`, convention: 'bracket' });
    assert.deepEqual(w021(), []);
  });

  test('the ADR-canonical name-only milestone heading opens a section', () => {
    // `## [GSD.02] Foundation` — name, no version — is the form ADR-612 pins.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] Foundation

### [GSD.03] 05: Wrong milestone
**Goal:** a
`, convention: 'bracket' });
    const m = w021();
    assert.equal(m.length, 1, JSON.stringify(m));
    assert.match(m[0], /section milestone 02/);
  });

  test('a milestone section heading is not mistaken for a phase heading', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### [GSD.03] 05: Wrong
**Goal:** a

### [GSD.04] 06: Also wrong
**Goal:** b
`, convention: 'bracket' });
    assert.equal(w021().length, 2);
  });
});

// ─── G1: the shipped milestone-prefixed W021 gate stays root-only ──────────

describe('#612 PR-2: the M-NN W021 gate is unmoved by workstream config', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-mnn-'); });
  afterEach(() => { cleanup(tmpDir); });

  const MNN_ROADMAP = `# Roadmap

## [GSD] v2.0

### Phase 1-01: Setup
**Goal:** a
`;

  const writeSplit = (rootCfg, wsCfg) => {
    const root = path.join(tmpDir, '.planning');
    const ws = path.join(root, 'workstreams', 'ws1');
    fs.mkdirSync(path.join(ws, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'ROADMAP.md'), MNN_ROADMAP, 'utf-8');
    fs.writeFileSync(path.join(ws, 'STATE.md'), ['---', 'gsd_state_version: 1.0',
      'milestone: v2.0', 'status: executing', '---', '', '# Project State', '',
      '**Phase:** 1-01', ''].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(rootCfg), 'utf-8');
    if (wsCfg !== undefined) {
      fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify(wsCfg), 'utf-8');
    }
  };
  const mnnW021 = () => w021({ GSD_WORKSTREAM: 'ws1' })
    .filter(m => /integer prefix implies/.test(m));

  test('ADDED-warning direction: a workstream M-NN config must not switch the gate on', () => {
    // Root has no convention, so base is silent. Federating this gate made the
    // workstream config turn a shipped legacy check on.
    writeSplit({}, { phase_id_convention: 'milestone-prefixed' });
    assert.deepEqual(mnnW021(), [], 'root config governs this gate');
  });

  test('VANISHING-warning direction: a workstream override must not switch it off', () => {
    // Worse direction — a warning that fires at base disappears, so the repo
    // looks healthier than it is.
    writeSplit({ phase_id_convention: 'milestone-prefixed' }, { phase_id_convention: 'bracket' });
    const m = mnnW021();
    assert.equal(m.length, 1, `the root-configured gate must still fire: ${JSON.stringify(m)}`);
    assert.match(m[0], /Phase 1-01: integer prefix implies v1\.0 but listed under v2\.0/);
  });

  test('root-configured, no workstream config: fires (base parity)', () => {
    writeSplit({ phase_id_convention: 'milestone-prefixed' }, undefined);
    assert.equal(mnnW021().length, 1);
  });
});

// ─── G2: an unpadded bracket milestone is uniformly malformed ──────────────

describe('#612 PR-2: unpadded bracket milestones scope nothing', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-unpadded-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('an unpadded phase heading does not re-scope the coherence check', () => {
    // `### [GSD.3] 05:` was not a phase (id grammar) but WAS a section (section
    // grammar), so it silently re-scoped every warning after it to milestone 03.
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### [GSD.3] 05: Unpadded
**Goal:** a

### [GSD.05] 06: Real mismatch
**Goal:** b
`, convention: 'bracket' });
    const m = w021();
    const mismatch = m.filter(x => /does not match its section milestone/.test(x));
    assert.equal(mismatch.length, 1, JSON.stringify(m));
    assert.match(mismatch[0], /section milestone 02/, 'scope must stay on the real section');
  });
});

describe('#612 PR-2: B6 keeps its narrow baseline behaviourally', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b6-mode-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('an any-bracket phantom does not reach the milestone-complete check', () => {
    // Behavioural companion to the source-level call-site pin: flipping this
    // site to the wider baseline makes `### [v1.2] Phase 3:` a phase, which has
    // no directory, so the ungated W021 fires on a repo whose real phases are
    // all on disk. The source pin catches the edit; this catches the effect.
    writeProject({
      roadmap: `# Roadmap

## [GSD.02] v2.0

### [v1.2] Phase 3: Not a phase heading
Some prose.

### [GSD.02] 05: Real work
**Goal:** a
`,
      convention: 'bracket',
      status: 'milestone complete',
      phaseDirs: ['GSD.02-05-real-work'],
    });
    assert.deepEqual(w021(), [], 'the phantom must not be counted as unstarted');
  });
});

// ─── G3: adversarial malformed bracket tokens reaching the coherence check ──

/**
 * `checkBracketCoherence` compares a phase's OWN bracket milestone against the
 * milestone of the section enclosing it, so it consumes two independently
 * matched brackets. A structurally broken one — non-numeric, unclosed, nested —
 * is the input most likely to make those two disagree about what they matched,
 * and W021 is a check that can fail a repo.
 *
 * The contract: a malformed token is not a phase and not a section, so it can
 * neither raise a W021 of its own nor re-scope the W021s around it (the G2
 * failure mode, arrived at from a different shape), and `validate health` still
 * exits cleanly. G2 above pins the unpadded case; these pin the broken ones.
 */
describe('#612 PR-2: malformed bracket tokens neither warn nor re-scope', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-malformed-w021-'); });
  afterEach(() => { cleanup(tmpDir); });

  const BROKEN_HEADINGS = [
    ['non-numeric milestone', '### [GSD.AB] 05: Broken'],
    ['unclosed bracket', '### [GSD.02 05: Broken'],
    ['nested bracket', '### [GSD.[02]] 05: Broken'],
    ['empty bracket', '### [] 05: Broken'],
    ['dot, no milestone', '### [GSD.] 05: Broken'],
    ['double dot', '### [GSD..02] 05: Broken'],
  ];

  for (const [label, broken] of BROKEN_HEADINGS) {
    test(`${label}: raises no W021 of its own`, () => {
      writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0 — Expansion

${broken}
**Goal:** a
`, convention: 'bracket' });
      assert.deepEqual(w021(), [], `${label} warned`);
    });

    test(`${label}: does not re-scope the W021 that follows it`, () => {
      // The G2 shape: a heading that is not a phase but IS read as a section
      // silently moves every later warning onto the wrong milestone.
      writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0 — Expansion

${broken}
**Goal:** a

### [GSD.07] 06: Real mismatch
**Goal:** b
`, convention: 'bracket' });
      const mismatch = w021().filter(x => /does not match its section milestone/.test(x));
      assert.equal(mismatch.length, 1, `${label}: ${JSON.stringify(w021())}`);
      assert.match(mismatch[0], /section milestone 02/, `${label}: scope moved off the real section`);
    });
  }

  test('the whole broken corpus in one ROADMAP leaves validate health clean', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0 — Expansion

${BROKEN_HEADINGS.map(([, h]) => `${h}\n**Goal:** x\n`).join('\n')}
### [GSD.02] 05: Real work
**Goal:** ok
`, convention: 'bracket', phaseDirs: ['GSD.02-05-real-work'] });
    const r = runGsdTools(['validate', 'health'], tmpDir);
    assert.ok(r.success, `validate health failed on the broken corpus: ${r.error}`);
    assert.deepEqual(w021(), []);
  });

  test('a pathological unclosed bracket does not stall validate health', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0 — Expansion

### [${'A'.repeat(4000)} 05: Attack
**Goal:** a

### [GSD.02] 05: Real work
**Goal:** ok
`, convention: 'bracket', phaseDirs: ['GSD.02-05-real-work'] });
    const started = Date.now();
    const r = runGsdTools(['validate', 'health'], tmpDir);
    const ms = Date.now() - started;
    assert.ok(r.success, `validate health failed: ${r.error}`);
    assert.ok(ms < 20000, `validate health took ${ms}ms on a pathological bracket`);
    assert.deepEqual(w021(), []);
  });
});

// ─── #2761 round-7 Minor 2: the W021 remediation hint must name no ────────
// ─── unsupported `--convention` value ───────────────────────────────────────
//
// `checkBracketCoherence`'s W021 previously attached a `fix` string telling
// users to run `gsd-tools roadmap upgrade --convention bracket` — but
// `roadmap-command-router.cts` only supports `--convention milestone-prefixed`
// (the bracket migrator is #612 PR-3, not yet landed); that command hard-errors
// with "Only --convention milestone-prefixed is supported". Nothing in the
// suite asserted the `fix` string's content, so the unfollowable hint shipped
// unpinned. This pins the corrected string and, more importantly, the
// invariant a future edit must not re-break: no unsupported `--convention`
// value named in remediation text users are expected to run verbatim.
describe('#612 PR-2 round-7 Minor 2: bracket W021 fix string names no unsupported --convention value', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r7m2-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('the fix string does not tell users to run `--convention bracket` (unsupported, hard-errors)', () => {
    writeProject({ roadmap: `# Roadmap

## [GSD.02] v2.0

### Phase 2-01: Mnn Legacy
**Goal:** a
`, convention: 'bracket' });
    const r = runGsdTools(['validate', 'health'], tmpDir);
    assert.ok(r.success, `validate health failed: ${r.error}`);
    const out = JSON.parse(r.output);
    const issues = [...(out.issues || []), ...(out.warnings || [])].filter((i) => i.code === 'W021');
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.doesNotMatch(issues[0].fix, /--convention bracket/,
      'pinned before this fix — the hint named a command that hard-errors: "Only --convention milestone-prefixed is supported"');
    assert.equal(
      issues[0].fix,
      'Bracket migration lands with the #612 migrator (PR-3); until then, manually align the bracket milestone in this heading to match the enclosing section.',
    );
  });
});
