// ADR-3473 §8.1 (#3881) — consequence and boundary coverage for the js-yaml migration.
// See .gsd/phase/feat-3881-one-yaml-parser/50-test-matrix.md sections A and F. Each row
// pins a consequence of swapping the hand-rolled line scanner for the vendored js-yaml
// (§40-design.md §0.2) that is otherwise invisible to the existing suite.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  UNTERMINATED_KEY_THRESHOLD,
  FRONTMATTER_UNPARSEABLE,
} = require('../gsd-core/bin/lib/frontmatter.cjs');
const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
const {
  _resetUnusableInputWarningsForTests,
  _unusableInputEmissionCountForTests,
} = require('../gsd-core/bin/lib/unusable-input.cjs');
const { createTempDir, cleanup, runGsdTools, createTempProject } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-27',
  localToday: () => '2026-06-27',
  nowIso: () => '2026-06-27T12:00:00.000Z',
});

function withTempDir(fn) {
  const dir = createTempDir('feat-3881-consequences-');
  try {
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

// ─── A. Consequences ────────────────────────────────────────────────────────

describe('A1 emptyValuedKeySurvivesAWrite', () => {
  test('a key with no value round-trips through parse -> reconstruct -> re-parse with the key still present', () => {
    const doc = '---\nphase: 3\nprogress:\n---\n\nbody\n';

    const parsed = extractFrontmatter(doc);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'progress'),
      'an empty-valued key must survive the initial parse'
    );

    // reconstructFrontmatter omits null-valued keys (frontmatter.cjs: `if (value === null ...) continue`),
    // so the empty-value contract only survives a write if extractFrontmatter never hands one back —
    // this is what pins that guarantee rather than reconstructFrontmatter's own omission logic.
    const reconstructed = reconstructFrontmatter(parsed);
    const rewritten = `---\n${reconstructed}\n---\n\nbody\n`;
    const reparsed = extractFrontmatter(rewritten);

    assert.ok(
      Object.prototype.hasOwnProperty.call(reparsed, 'progress'),
      `progress must survive a write; reconstructed frontmatter was ${JSON.stringify(reconstructed)}`
    );
  });
});

describe('A2 unparseableDocumentKeepsItsFrontmatterBlock', () => {
  test('a STATE.md with a git merge-conflict marker in its frontmatter keeps the block through beginPhase', () => {
    const fmBlock = [
      '---',
      '<<<<<<< HEAD',
      'status: foo',
      '=======',
      'status: bar',
      '>>>>>>> feature',
      '---',
      '',
    ].join('\n');
    const body = [
      '# Project State',
      '',
      '**Status:** Planning',
      '',
      '## Current Position',
      '',
      'Phase: 2 — DONE',
      'Plan: —',
      'Status: Planning',
      '',
    ].join('\n');
    const content = fmBlock + body;

    // Verify reachability first: the conflicted region parses to zero keys with the
    // unparseable marker set, exercising the exact branch beginPhaseCore relies on.
    const fm = extractFrontmatter(content);
    assert.equal(Object.keys(fm).length, 0);
    assert.equal(fm[FRONTMATTER_UNPARSEABLE], true);

    const result = transitionCore(
      content,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock: fixedClock }
    );

    assert.ok(
      result.content.includes('<<<<<<< HEAD') &&
        result.content.includes('=======') &&
        result.content.includes('>>>>>>> feature'),
      `frontmatter conflict markers must survive the write; got ${JSON.stringify(result.content)}`
    );
  });

  // Post-#3881-review, finding 7: this describe block exercised only ONE of the 8 call sites
  // that route through `beginFrontmatterReassembly` (frontmatter.cts's docblock names all 8:
  // 7 `*Core` functions in state-transition.cts, dispatched by `transitionCore`, plus 1 more
  // hand-verified separately in `state.cts`'s `cmdStateCompletePhase`). Table-driven over the
  // remaining 6 `transitionCore` kinds that share the same preservation contract.
  const OTHER_TRANSITION_KINDS = [
    ['advancePlan', { kind: 'advancePlan' }],
    ['completePhase', { kind: 'completePhase', phaseNum: '2', nextPhaseNum: '3', nextPhaseName: 'Next Phase', isLastPhase: false, planCount: 1, summaryCount: 1 }],
    ['plannedPhase', { kind: 'plannedPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 }],
    ['milestoneComplete', { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd:new-milestone' }],
    ['patch', { kind: 'patch', patches: { Status: 'Paused' } }],
    ['update', { kind: 'update', field: 'Status', value: 'Paused' }],
  ];

  const fmBlock = [
    '---',
    '<<<<<<< HEAD',
    'status: foo',
    '=======',
    'status: bar',
    '>>>>>>> feature',
    '---',
    '',
  ].join('\n');
  const body = [
    '# Project State',
    '',
    '**Status:** Planning',
    '',
    '## Current Position',
    '',
    'Phase: 2 — DONE',
    'Plan: —',
    'Status: Planning',
    '',
  ].join('\n');
  const content = fmBlock + body;

  for (const [label, intent] of OTHER_TRANSITION_KINDS) {
    test(`a git merge-conflict marker in the frontmatter keeps the block through ${label}`, () => {
      const result = transitionCore(content, intent, { clock: fixedClock, roadmapProvider: () => null });
      assert.ok(
        result.content.includes('<<<<<<< HEAD')
          && result.content.includes('=======')
          && result.content.includes('>>>>>>> feature'),
        `${label}: frontmatter conflict markers must survive the write; got ${JSON.stringify(result.content)}`
      );
    });
  }

});

// ─── A2b. The 8th reassemble site — the real CLI path, not just the pure transform ─────────
//
// Post-#3881-review, second round: the 7 `transitionCore` kinds above preserve an unparseable
// block at the PURE-TRANSFORM layer, but `state.cts`'s CLI adapters wrap every transform in
// `readModifyWriteStateMd` -> `syncAndPreserveStateMd`, which reruns `extractFrontmatter` on
// the (already-preserved) result and — before this fix — unconditionally re-derived a FRESH
// frontmatter block, discarding the raw one a second time. Confirmed by execution: BEFORE the
// fix, `state complete-phase` on a conflict-marker STATE.md returned success with the markers
// GONE, replaced by a freshly-derived well-formed block (re-derivation, not fence deletion —
// case (b), not (a)). Table-driven over the CLI verbs found to share the same
// `readModifyWriteStateMd` path, plus a control proving the ADR-3408 §8.3 CLOSED-list "body
// wins" contract (`state sync`) is untouched.
describe('A2b unparseableFrontmatterSurvivesTheRealCliPath', () => {
  const CONFLICT_FM_BLOCK = [
    '---',
    '<<<<<<< HEAD',
    'status: foo',
    '=======',
    'status: bar',
    '>>>>>>> feature',
    '---',
    '',
  ].join('\n');
  const CONFLICT_BODY = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 — Foundation',
    'Plan: 1 of 1',
    'Status: Executing Phase 1',
    'Last activity: 2026-07-01 — mid-flight',
    '',
  ].join('\n');

  function writeConflictFixture(tmpDir) {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-foundation'), { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      ['# Roadmap', '', '### Phase 1: Foundation', '**Goal:** Setup', ''].join('\n'),
    );
    const statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, CONFLICT_FM_BLOCK + CONFLICT_BODY);
    return statePath;
  }

  const NON_SANCTIONED_VERBS = [
    ['state complete-phase', ['state', 'complete-phase']],
    ['state update', ['state', 'update', 'Last Activity', '2026-08-26']],
    ['query state.patch', ['query', 'state.patch', JSON.stringify({ Status: 'Paused for review' })]],
    ['state begin-phase', ['state', 'begin-phase', '--phase', '2', '--name', 'Next Phase']],
  ];

  for (const [label, args] of NON_SANCTIONED_VERBS) {
    test(`${label}: a git merge-conflict-marked frontmatter block survives the real CLI write`, () => {
      const tmpDir = createTempProject();
      try {
        const statePath = writeConflictFixture(tmpDir);
        const result = runGsdTools(args, tmpDir);
        assert.ok(result.success, `${label} failed: ${result.error}`);
        const after = fs.readFileSync(statePath, 'utf-8');
        assert.ok(
          after.includes('<<<<<<< HEAD') && after.includes('=======') && after.includes('>>>>>>> feature'),
          `${label}: conflict markers must survive; got:\n${after}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  test('control: state sync (ADR-3408 §8.3 CLOSED list — body wins) still overwrites unparseable frontmatter, unchanged', () => {
    // The one command that MUST keep clobbering it — a regression here would mean the fix
    // widened the closed list, which the review explicitly forbids.
    const tmpDir = createTempProject();
    try {
      const statePath = writeConflictFixture(tmpDir);
      const result = runGsdTools(['state', 'sync'], tmpDir);
      assert.ok(result.success, `state sync failed: ${result.error}`);
      const after = fs.readFileSync(statePath, 'utf-8');
      assert.ok(
        !after.includes('<<<<<<< HEAD'),
        'state sync must still re-derive frontmatter from the body (its documented contract) — conflict markers must NOT survive',
      );
      assert.ok(/^---\r?\n/.test(after), 'state sync must still produce a well-formed frontmatter block');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// #3881 ADR-3473 §8.5: `state sync`'s "body wins" regeneration over an unparseable
// frontmatter block (control test above, A2b) is correct and must not change — but it was
// SILENT: `synced: true`, exit 0, no signal that the existing block (including any
// merge-conflict markers) was unreadable and destroyed. §8.5: "a derived conclusion may not
// be reported as authoritative when the derivation dropped input it could not resolve."
// Table-driven per the dispatch brief's instruction to check sibling verbs on the same
// ADR-3408 §8.3 sanctioned-regenerate list: `REGENERATE_STATE` (`/gsd-health --repair`) is
// on that list too, but is DESTRUCTIVE-risk and unconditionally REFUSED by `applyRepairs`'s
// dispatcher (src/health-diagnostic.cts) before `runRepairAction` is ever invoked — so
// `state sync` is the only LIVE verb on the sanctioned path today. No table needed; a single
// verb, driven through the real CLI, is the whole live surface.
describe('A2c stateSyncWarnsOnUnparseableFrontmatterRegeneration', () => {
  const CONFLICT_FM_BLOCK = [
    '---',
    '<<<<<<< HEAD',
    'status: foo',
    '=======',
    'status: bar',
    '>>>>>>> feature',
    '---',
    '',
  ].join('\n');
  const CONFLICT_BODY = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 — Foundation',
    'Plan: 1 of 1',
    'Status: Executing Phase 1',
    'Last activity: 2026-07-01 — mid-flight',
    '',
  ].join('\n');

  function seedPhaseDirs(tmpDir) {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(planningDir, 'phases', '02-next-phase'), { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      ['# Roadmap', '', '### Phase 1: Foundation', '**Goal:** Setup', '', '### Phase 2: Next', '**Goal:** More', ''].join('\n'),
    );
  }

  function writeConflictState(tmpDir) {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, CONFLICT_FM_BLOCK + CONFLICT_BODY);
    return statePath;
  }

  function writeValidState(tmpDir) {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const validFm = [
      '---',
      'gsd_state_version: \'1.0\'',
      'status: executing',
      'current_phase: 1',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, validFm + CONFLICT_BODY);
    return statePath;
  }

  test('RED (pre-fix) proof: unparseable frontmatter — stderr carries the gsd: warning line and the JSON result surfaces it in `changes`', () => {
    const tmpDir = createTempProject();
    try {
      seedPhaseDirs(tmpDir);
      const statePath = writeConflictState(tmpDir);
      const r = runNode([TOOLS_PATH, 'state', 'sync', '--raw'], { cwd: tmpDir, timeoutMs: PROBE_TIMEOUT_MS });
      throwIfFailed(r, 'gsd-tools state sync --raw');

      // Regeneration still happened (unchanged contract — the control test above pins this
      // for the general case; re-asserted here on the same fixture this warning covers).
      const after = fs.readFileSync(statePath, 'utf-8');
      assert.ok(!after.includes('<<<<<<< HEAD'), 'state sync must still regenerate over the unparseable block');

      // Human channel: matches the existing `gsd: warning — ... (#NNNN)` precedent (#3573).
      assert.match(
        r.stderr,
        /gsd: warning — .*frontmatter.*could not be parsed.*regenerated.*\(#3881\)/s,
        `expected a gsd: warning on stderr naming the unparseable frontmatter; got stderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
      );

      // Machine channel: the JSON result's existing `changes` array (the mechanism this
      // codebase already uses to surface sync-time signals — see the "Progress: skipped —
      // ..." entries in src/state.cts) must carry the same disclosure.
      const parsed = JSON.parse(r.stdout);
      assert.ok(Array.isArray(parsed.changes), `expected a changes array in JSON result; got ${r.stdout}`);
      assert.ok(
        parsed.changes.some((c) => typeof c === 'string' && c.includes('could not be parsed') && c.includes('#3881')),
        `expected 'changes' to include the unparseable-frontmatter warning; got ${JSON.stringify(parsed.changes)}`,
      );
      assert.strictEqual(parsed.synced, true, 'exit-0/synced:true stays correct — sync did what its contract says');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('control (cannot pass vacuously): valid, parseable frontmatter emits NO such warning', () => {
    const tmpDir = createTempProject();
    try {
      seedPhaseDirs(tmpDir);
      const statePath = writeValidState(tmpDir);
      const r = runNode([TOOLS_PATH, 'state', 'sync', '--raw'], { cwd: tmpDir, timeoutMs: PROBE_TIMEOUT_MS });
      throwIfFailed(r, 'gsd-tools state sync --raw');

      assert.doesNotMatch(
        r.stderr,
        /#3881/,
        `valid frontmatter must not trigger the unparseable-frontmatter warning; got stderr:\n${r.stderr}`,
      );
      const parsed = JSON.parse(r.stdout);
      assert.ok(
        !parsed.changes.some((c) => typeof c === 'string' && c.includes('#3881')),
        `expected no #3881 warning in changes for valid frontmatter; got ${JSON.stringify(parsed.changes)}`,
      );
      void statePath;
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('A3 unparseableIsDistinguishableFromEmpty', () => {
  test('both an empty and an unparseable block yield zero keys, but only the unparseable one carries the marker', () => {
    const empty = extractFrontmatter('---\n---\n\nbody\n');
    const unparseable = extractFrontmatter('---\nfoo: [unclosed\n---\n\nbody\n');

    assert.equal(Object.keys(empty).length, 0);
    assert.equal(Object.keys(unparseable).length, 0);

    assert.notEqual(
      empty[FRONTMATTER_UNPARSEABLE],
      true,
      'a genuinely empty frontmatter block must not carry the unparseable marker'
    );
    assert.equal(
      unparseable[FRONTMATTER_UNPARSEABLE],
      true,
      'a malformed frontmatter block must carry the unparseable marker'
    );
  });
});

describe('A4 nonScalarValuesCanonicalize', () => {
  test('the four spellings of an object-list scalar canonicalize to one value', () => {
    const spellings = [
      '- test: "a b"',
      '- test: a b',
      "- test: 'a b'",
      '- {test: a b}',
    ];
    const CANONICAL = ['test: a b'];

    for (const spelling of spellings) {
      const doc = `---\nkey:\n${spelling}\n---\n\nbody\n`;
      const parsed = extractFrontmatter(doc);
      assert.deepEqual(
        parsed.key,
        CANONICAL,
        `spelling ${JSON.stringify(spelling)} must canonicalize to ${JSON.stringify(CANONICAL)}; got ${JSON.stringify(parsed.key)}`
      );
    }
  });
});

describe('A5 truncationProbeStillFiresOnAnOpenFence', () => {
  test('fires on the dominant real truncation shape: opening fence, well-formed keys, then nothing', () => {
    _resetUnusableInputWarningsForTests();
    const truncated = '---\nphase: 3\nplan: 2\n';
    extractFrontmatter(truncated);
    assert.equal(
      _unusableInputEmissionCountForTests(),
      1,
      'the #1882 probe must fire on a well-formed-but-unterminated frontmatter region'
    );
  });

  test('does NOT fire on the documented false-positive shape: a rule followed by ordinary prose', () => {
    _resetUnusableInputWarningsForTests();
    const rule = '---\nNote: this is a paragraph.\n\nJust ordinary prose after a thematic break.\n';
    extractFrontmatter(rule);
    assert.equal(
      _unusableInputEmissionCountForTests(),
      0,
      'a document that merely opens with a thematic break above prose must not be flagged as truncated'
    );
  });

  // Post-#3881-review, finding 5: the trivially-parseable dominant shape above was the ONLY
  // shape this row exercised — vacuous for the risk it names, since it never touched
  // `countKeysBeforeTruncation`'s failure/recovery path at all (that whole-region text is
  // valid YAML; the probe fires purely from a successful parse). Table-driven over every real
  // truncation shape confirmed regressed by execution during review: an unquoted colon inside
  // a value, an open (unterminated) flow collection, a mis-indented sibling key, and an
  // anchor/alias whose refusal throws a mark-less exception. Each must still fire the #1882
  // diagnostic exactly once.
  const REGRESSED_TRUNCATION_SHAPES = [
    ['unquoted colon in a value', '---\nphase: 3\ntitle: a: b\n'],
    ['open (unterminated) flow collection', '---\nphase: 3\nlist: [a, b\n'],
    ['mis-indented sibling key', '---\nphase: 3\n  plan: 2\n'],
    ['anchor/alias — refusal throws a mark-less exception', '---\nphase: 3\nfoo: &a bar\n'],
  ];

  for (const [label, doc] of REGRESSED_TRUNCATION_SHAPES) {
    test(`fires on a real truncation shape the mark-based recovery regressed on: ${label}`, () => {
      _resetUnusableInputWarningsForTests();
      extractFrontmatter(doc);
      assert.equal(
        _unusableInputEmissionCountForTests(),
        1,
        `the #1882 probe must fire on an unterminated region shaped like: ${label}; doc=${JSON.stringify(doc)}`
      );
    });
  }
});

describe('A6 commentsStayOnTheirOwnKey', () => {
  test('a column-0 comment above a Unicode key attaches to that key and survives a round-trip', () => {
    const doc = '---\nfoo: bar\n# note\n相: baz\n---\n\nbody\n';

    const parsed = extractFrontmatter(doc);
    assert.deepEqual(Object.keys(parsed), ['foo', '相']);
    assert.equal(parsed['相'], 'baz');

    const reconstructed = reconstructFrontmatter(parsed);
    const commentLine = reconstructed.split('\n').find((l) => l.startsWith('#'));
    const keyLine = reconstructed.split('\n').find((l) => l.startsWith('相:'));
    assert.ok(commentLine, `reconstructed frontmatter must carry the comment; got ${JSON.stringify(reconstructed)}`);
    const commentIdx = reconstructed.split('\n').indexOf(commentLine);
    const keyIdx = reconstructed.split('\n').indexOf(keyLine);
    assert.equal(keyIdx, commentIdx + 1, 'the comment must sit immediately above the 相 key, not the following one');

    // Round-trip: reparsing the reconstructed block and reconstructing again is byte-identical.
    const rewritten = `---\n${reconstructed}\n---\n\nbody\n`;
    const reparsed = extractFrontmatter(rewritten);
    assert.equal(reconstructFrontmatter(reparsed), reconstructed);
  });
});

describe('A7 anchorsAndAliasesAreRefused', () => {
  // #3881 review, finding 1: the original refusal was a raw-line regex matching only the
  // bare-key spelling (`key: &x`). A quoted key, a flow mapping and a flow sequence all
  // define/use the SAME anchor mechanics while never matching that line shape — table-driven
  // over every spelling that was confirmed bypassable, plus the original passing case, so a
  // future regression in any one spelling fails loudly rather than hiding behind the others.
  const SPELLINGS = [
    ['plain', '---\nfoo: &a bar\nbaz: *a\n---\n\nbody\n'],
    ['quoted key', '---\n"foo": &a bar\n"baz": *a\n---\n\nbody\n'],
    ['flow mapping', '---\na: {b: &a 1, c: *a}\n---\n\nbody\n'],
    ['flow sequence', '---\na: [&a "q", *a]\n---\n\nbody\n'],
    ['merge key (<<:) with an alias', '---\nbase: &b\n  x: "1"\nfoo:\n  <<: *b\n  y: "2"\n---\n\nbody\n'],
  ];

  for (const [label, doc] of SPELLINGS) {
    test(`${label}: refused rather than expanded`, () => {
      const parsed = extractFrontmatter(doc);
      assert.equal(Object.keys(parsed).length, 0, `${label} must parse to zero keys`);
      assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true, `${label} must carry the unparseable marker`);
    });
  }

  test('a bare merge key with NO alias is not itself refused (no anchor, no expansion risk)', () => {
    // Under FAILSAFE_SCHEMA (no !!merge type resolution) this never actually merges — it
    // parses as an ordinary, non-expanding literal "<<" string key. Documented behavior
    // change from the pre-review regex (which refused every `<<:`-shaped line regardless of
    // whether an alias was present) — see frontmatter.cts refuseAnchorsAndAliases docblock.
    const doc = '---\na:\n  <<: {b: 1}\n  c: 2\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.notEqual(parsed[FRONTMATTER_UNPARSEABLE], true);
    assert.deepEqual(parsed.a, { '<<': { b: '1' }, c: '2' });
  });
});

describe('A8 aliasExpansionCannotExhaustMemory', () => {
  test('a billion-laughs frontmatter is refused, bounded on the RESULT, never on elapsed time', () => {
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    const doc = `---\n${bomb}\n---\n\nbody\n`;

    const parsed = extractFrontmatter(doc);

    // Assertions are on the RESULT SHAPE (zero keys, bounded serialized size), never on
    // wall-clock elapsed time — this repo forbids elapsed-time assertions in tests.
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    const serializedSize = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    assert.ok(
      serializedSize < 1024,
      `a refused parse must stay tiny (would be ~22.8MB if expanded); got ${serializedSize} bytes`
    );
  });

  test('the same billion-laughs bomb, quoted-key-spelled, is ALSO refused (#3881 review, finding 1)', () => {
    // The exact bypass the review found: the pre-fix raw-text regex matched only bare
    // (unquoted) keys, so this 303-byte quoted-key spelling of the identical bomb went
    // straight through unrefused and expanded to ~35.8MB. Pinned here on the RESULT shape.
    const bomb = [
      '"a": &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      '"b": &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      '"c": &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      '"d": &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      '"e": &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      '"f": &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      '"g": [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    const doc = `---\n${bomb}\n---\n\nbody\n`;

    const parsed = extractFrontmatter(doc);

    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    const serializedSize = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    assert.ok(
      serializedSize < 1024,
      `a refused parse must stay tiny (would be ~35.8MB if expanded); got ${serializedSize} bytes`
    );
  });
});

describe('finding 3: null-byte sentinel round-trip is injective', () => {
  const E000 = String.fromCharCode(0xE000);

  test('a real NUL is preserved exactly when no pre-existing U+E000 is present', () => {
    const doc = '---\nfoo: "has null"\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(parsed.foo, 'has null');
  });

  test('a document containing a literal U+E000 (the sentinel itself) is refused, not silently corrupted', () => {
    // Before the fix, restoreNullBytesDeep rewrote EVERY U+E000 in the parsed tree back to
    // U+0000 unconditionally — including one the document author legitimately wrote — so this
    // document's own U+E000 silently became a NUL. It must now be refused instead.
    const doc = `---\nfoo: "pre${E000}existing"\n---\n\nbody\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });

  test('a literal U+E000 alongside a real NUL is refused rather than merging the two into one byte', () => {
    // The exact corruption case from the review: escaping the real NUL to U+E000 makes it
    // indistinguishable from the pre-existing U+E000, and restoring converts BOTH back to NUL.
    const doc = `---\nfoo: "has null"\nbar: "pre${E000}existing"\n---\n\nbody\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });
});

// ─── F. Boundaries ──────────────────────────────────────────────────────────

describe('F1 UNTERMINATED_KEY_THRESHOLD boundary', () => {
  function unterminatedRegionWithKeys(n) {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(`k${i}: v${i}`);
    return `---\n${lines.join('\n')}\n`;
  }

  test('threshold-1 keys: no diagnostic', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD - 1));
    assert.equal(_unusableInputEmissionCountForTests(), 0);
  });

  test('threshold keys: fires', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD));
    assert.equal(_unusableInputEmissionCountForTests(), 1);
  });

  test('threshold+1 keys: fires', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD + 1));
    assert.equal(_unusableInputEmissionCountForTests(), 1);
  });
});

describe('F2 alias/nesting refusal bound', () => {
  // refuseAnchorsAndAliases (frontmatter.cjs) is a raw-text pre-scan that refuses on ANY
  // line carrying an anchor/alias/merge-key marker — there is no numeric count threshold
  // in this implementation. The real boundary it exercises is therefore an occurrence
  // COUNT: 0 (below the refusal trigger) parses; 1 (the trigger) is refused; 2 (over) stays
  // refused, proving the refusal is not a first-occurrence artifact that a second alias
  // could slip past.
  test('0 anchor/alias lines: parses normally', () => {
    const doc = '---\nfoo: bar\nbaz: qux\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.deepEqual(parsed, { foo: 'bar', baz: 'qux' });
  });

  test('1 anchor/alias line: refused', () => {
    const doc = '---\nfoo: &a bar\nbaz: qux\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });

  test('2 anchor/alias lines: still refused', () => {
    const doc = '---\nfoo: &a bar\nbaz: *a\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });
});

describe('F3 frontmatter size boundary', () => {
  const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'adversarial', 'frontmatter', 'huge-bounded.md');

  test('~30KB fixture (huge-bounded.md) completes with a typed result', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const parsed = extractFrontmatter(content, FIXTURE_PATH);
    assert.equal(typeof parsed, 'object');
    assert.ok(Array.isArray(parsed.plans));
    assert.ok(parsed.plans.length > 0);
  });

  test('a larger (~640KB) frontmatter block also completes with a typed result', () => {
    withTempDir((dir) => {
      const lines = ['---', 'phase: "06"', 'plans:'];
      // ~640KB of array items — an order of magnitude above the committed ~30KB fixture,
      // isolated in a per-test temp file rather than a new committed fixture.
      for (let i = 0; i < 40000; i++) {
        lines.push(`  - item-${String(i).padStart(5, '0')}`);
      }
      lines.push('---', '', 'Body.', '');
      const content = lines.join('\n');
      assert.ok(Buffer.byteLength(content, 'utf8') > 500 * 1024, 'fixture must exceed the committed one by an order of magnitude');

      const filePath = path.join(dir, 'huge-bounded-larger.md');
      fs.writeFileSync(filePath, content, 'utf8');
      const readBack = fs.readFileSync(filePath, 'utf8');

      const parsed = extractFrontmatter(readBack, filePath);
      assert.equal(typeof parsed, 'object');
      assert.ok(Array.isArray(parsed.plans));
      assert.equal(parsed.plans.length, 40000);
      assert.equal(parsed.plans[0], 'item-00000');
      assert.equal(parsed.plans[39999], 'item-39999');
    });
  });
});

// Relocated from tests/frontmatter.test.cjs (mutation-matrix piece 1, #3881 follow-up): the
// mutation shard dropped tests/frontmatter.test.cjs (2932 lines, 3132ms of the shard's 4800ms
// per-run cost, ~96 minutes of the frontmatter shard's 180-minute budget for that one file) to
// stay inside CI's time budget, but that file was the ONLY place two assertion classes lived —
// the anchor-alias-bomb refusal (ADR-3473 §8.1 consequence 6, row A8) and the B1/B2 block-scalar
// assertions. Both are relocated here verbatim (not re-derived) so the mutants they kill stay
// killed after frontmatter.test.cjs leaves the shard's `tests` list. frontmatter.test.cjs itself
// keeps these exact assertions too (not deleted there) — it still runs in the normal (non-mutation)
// suite, so this is a second, mutation-scoped copy, not a move.
describe('anchor-alias-bomb refusal (relocated from tests/frontmatter.test.cjs for mutation-matrix piece 1)', () => {
  const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'frontmatter');
  function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  }

  test('anchor-alias-bomb.md: refused rather than expanded (ADR-3473 §8.1 consequence 6, row A8)', () => {
    const parsed = extractFrontmatter(readFixture('anchor-alias-bomb.md'), 'anchor-alias-bomb.md');
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    assert.ok(Buffer.byteLength(JSON.stringify(parsed), 'utf8') < 1024);
  });

  test('anchor-alias-bomb-quoted.md: refused identically, even quoted-key-spelled (#3881 review, finding 1)', () => {
    const parsed = extractFrontmatter(readFixture('anchor-alias-bomb-quoted.md'), 'anchor-alias-bomb-quoted.md');
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    assert.ok(Buffer.byteLength(JSON.stringify(parsed), 'utf8') < 1024);
  });
});

describe('B1/B2 block-scalar assertions (relocated from tests/frontmatter.test.cjs for mutation-matrix piece 1)', () => {
  const ADD_TESTS_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'add-tests.md');

  test('B1 blockScalarValueIsNotTheBlockIndicator: argument-instructions is the instruction text, not "|"', () => {
    const content = fs.readFileSync(ADD_TESTS_PATH, 'utf8');
    const parsed = extractFrontmatter(content, ADD_TESTS_PATH);
    const value = parsed['argument-instructions'];
    assert.equal(typeof value, 'string');
    assert.notEqual(value, '|');
    assert.ok(value.length > 1, 'block scalar value must be the multi-line instruction body');
    assert.ok(value.includes('Parse the argument as a phase number'), 'block scalar value must retain the source instruction text');
  });

  test('B2 blockScalarDoesNotInventATopLevelKey: parsing add-tests.md produces no phantom "Example" key', () => {
    const content = fs.readFileSync(ADD_TESTS_PATH, 'utf8');
    const parsed = extractFrontmatter(content, ADD_TESTS_PATH);
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'Example'), 'parser must not scrape a top-level "Example" key out of the block scalar body');
  });
});

// Frontmatter mutation-gap closure (#3881 follow-up, CI run 33012034388): the frontmatter
// shard measured 63.03% against its 65 floor. These tests close the gap by constraining real
// behavior in the four highest-value survivor clusters — canonical flattening's no-op guard
// (frontmatterDeepEqual, gates spliceFrontmatter's whole-document identity check), the writer's
// double-quoting decision (scalarNeedsDoubleQuoting), the reader's ambiguous-colon repair
// (repairAmbiguousColonValues), and the null-byte round-trip (escapeNullBytesForParse). Each
// case below is paired with a documented near-miss so a mutant that weakens the real condition
// (not just a syntactically different one) is observably wrong, not merely re-typed.

describe('frontmatterDeepEqual (via spliceFrontmatter no-op detection)', () => {
  test('key order is insignificant for objects: a same-value, reordered-keys write is a byte-exact no-op', () => {
    const doc = '---\na: 1\nb: 2\n---\n\nbody\n';
    assert.equal(spliceFrontmatter(doc, { b: '2', a: '1' }), doc);
  });

  test('array order IS significant: same elements in a different order is NOT a no-op', () => {
    // Near-miss for the .every -> .some mutant: index 0 matches ("x"==="x") but index 1 does
    // not ("y" !== "z"). The real .every-based comparison must see this as unequal (regenerate);
    // a .some-based mutant would short-circuit true on the matching index-0 element alone and
    // wrongly report a no-op.
    const doc = '---\ntags:\n  - x\n  - y\n---\n\nbody\n';
    const result = spliceFrontmatter(doc, { tags: ['x', 'z'] });
    assert.notEqual(result, doc, 'a value-changed array must not be treated as a no-op write');
  });

  test('a new array value that differs only in length is NOT a no-op', () => {
    const doc = '---\ntags:\n  - x\n---\n\nbody\n';
    assert.notEqual(spliceFrontmatter(doc, { tags: ['x', 'y'] }), doc);
  });

  test('two empty arrays of matching (zero) length ARE a no-op', () => {
    const doc = '---\ntags: []\n---\n\nbody\n';
    assert.equal(spliceFrontmatter(doc, { tags: [] }), doc);
  });

  test('an array-valued field replaced with a same-text scalar is NOT a no-op (array vs non-array must never compare equal)', () => {
    const doc = '---\ntags:\n  - x\n---\n\nbody\n';
    assert.notEqual(spliceFrontmatter(doc, { tags: 'x' }), doc);
  });

  test('nested-object key order is insignificant: a same-value, reordered-keys nested object is a no-op', () => {
    const doc = '---\nmeta:\n  a: "1"\n  b: "2"\n---\n\nbody\n';
    assert.equal(spliceFrontmatter(doc, { meta: { b: '2', a: '1' } }), doc);
  });

  test('a nested object with a genuinely different key set is NOT a no-op', () => {
    const doc = '---\nmeta:\n  a: "1"\n  b: "2"\n---\n\nbody\n';
    assert.notEqual(spliceFrontmatter(doc, { meta: { a: '1', c: '2' } }), doc);
  });
});

describe('scalarNeedsDoubleQuoting (via reconstructFrontmatter double-quoting decisions)', () => {
  test('a value with internal (non-leading, non-trailing) whitespace is NOT quoted', () => {
    // Near-miss for the /^\s|\s$/ -> /^\s|\s/ mutant (dropped end-anchor): a mutant that tests
    // for whitespace ANYWHERE rather than only leading/trailing would wrongly quote this.
    assert.equal(reconstructFrontmatter({ key: 'mid dle' }), 'key: mid dle');
  });

  test('trailing whitespace alone (no leading whitespace) IS quoted', () => {
    assert.equal(reconstructFrontmatter({ key: 'trailing ' }), 'key: "trailing "');
  });

  test('a leading dash followed by a space IS quoted (reads as a YAML list indicator)', () => {
    assert.equal(reconstructFrontmatter({ key: '- item' }), 'key: "- item"');
  });

  test('a leading dash with NO following space is NOT quoted (near-miss control for the above)', () => {
    assert.equal(reconstructFrontmatter({ key: '-item' }), 'key: -item');
  });

  test('a lone UTF-16 surrogate is quoted (bare emission is invalid YAML and would not re-parse)', () => {
    const reconstructed = reconstructFrontmatter({ key: '\uD800' });
    assert.equal(reconstructed, 'key: "\\uD800"');
  });
});

// `repairAmbiguousColonValues` (and its sibling `repairMalformedInlineArrays` +
// `splitLegacyInlineArrayItems`) was deleted (#3881 follow-up): a sweep of every tracked
// `*.md` file with a frontmatter fence (910 files) found ZERO documents whose parse result
// changed with the repair disabled — it was hand-rolled YAML leniency kept alive on a fallback
// path, the exact thing ADR-3473 §8.1 exists to remove. `extractFrontmatter` now surfaces
// `unparseableResult()` (via `FRONTMATTER_UNPARSEABLE`) for the ambiguous-colon shapes this
// block used to pin instead of silently repairing them.

describe('escapeNullBytesForParse (null-byte round-trip through the sentinel swap)', () => {
  test('a NUL byte inside a key survives extractFrontmatter byte-for-byte, including at region offset 1', () => {
    // Region offset 1 specifically distinguishes the `indexOf(...) === -1` -> `=== +1` mutant:
    // for THIS input the mutant's condition is true (index really is 1), so it takes the
    // "no substitution needed" branch and hands js-yaml a raw, unescaped NUL — which js-yaml
    // rejects outright under every schema, collapsing the whole parse to {}. The same input
    // also kills the sentinel StringLiteral "" mutant (deletes the byte instead of escaping it):
    // that mutant would parse successfully but produce key "x" instead of "x ".
    const NUL = ' ';
    const doc = `---\nx${NUL}: y\n---\n\nbody\n`;
    const parsed = extractFrontmatter(doc);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, `x${NUL}`),
      `NUL byte must survive as part of the key, not be dropped or crash the parse; got keys ${JSON.stringify(Object.keys(parsed))}`
    );
    assert.equal(parsed[`x${NUL}`], 'y');
  });
});
