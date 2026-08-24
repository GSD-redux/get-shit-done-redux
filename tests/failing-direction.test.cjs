'use strict';

/**
 * Stated failing direction (#3172).
 *
 * Module: gsd-core/bin/lib/verify-command-grounding.cjs
 * Exported (added by #3172): extractFailingDirections, resolveFailingDirection,
 *                            probePhaseFailingDirections
 *
 * #3172: `gsd-planner` emitted 21 `<automated>` acceptance commands that could
 * not run at all. A command with no expressible failure mode is not an
 * acceptance test — it reads as rigour and is not falsifiable. The approved fix
 * (maintainer verdict on the issue, "shape 3") is to require the plan to STATE
 * what output constitutes failure, in a `<fails_when>` sibling of `<automated>`.
 *
 * This probe answers "does each runnable `<automated>` command have a stated
 * failing direction?" It is a PRESENCE recognizer, not a judge of the
 * statement's quality: whether the statement names the RIGHT failure signal
 * stays plan-checker (LLM) judgment. It never executes command text — PLAN.md is
 * model-authored untrusted input — and it never PRESCRIBES a statement, because
 * a prescribed statement would be copied verbatim and carry zero information
 * (Goodhart), reproducing #3172 one level up.
 *
 * Pairing rule: within one `<task>` body, each `<fails_when>` binds to the
 * nearest PRECEDING `<automated>`; a command's binding statement is the FIRST
 * one that follows it before the next command. A statement with no preceding
 * command is an `orphan` WARNING, never a blocker.
 *
 * Row numbers below map to
 * `.gsd/phase/feat-3172-stated-failing-direction/50-test-matrix.md`.
 *
 * IO-failure rows monkeypatch the `fs` method and restore in `finally` — never
 * `chmod 0o000`, which root bypasses in Docker/CI so the test would pass with
 * zero coverage.
 *
 * The final `describe('property-based invariants', …)` block carries the
 * fast-check properties (P1-P4 in the matrix): closed-enum totality, the
 * pairing walk at generated command counts, CRLF invariance, and the sentinel
 * exemption's guarantee that a blocker is never reported for a sentinel.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, runGsdTools } = require('./helpers.cjs');

const {
  extractAutomatedCommands,
  probePhaseVerifyCommands,
  extractFailingDirections,
  resolveFailingDirection,
  probePhaseFailingDirections,
} = require('../gsd-core/bin/lib/verify-command-grounding.cjs');

const KNOWN_STATUSES = new Set(['ok', 'missing', 'empty', 'placeholder', 'sentinel', 'orphan']);
const KNOWN_SEVERITIES = new Set(['blocker', 'warning', 'none']);

/** Every placeholder atom the probe refuses, per 40-design.md. */
const PLACEHOLDER_ATOMS = ['tbd', 'todo', 'n/a', 'na', 'none', 'unknown', 'tba', '?', '-'];

const SENTINEL = 'MISSING — Wave 0 must create tests/auth.test.ts first';

/** Root for every fixture built by this file; removed in `after`. */
let ROOT = '';

/**
 * Build a PLAN.md whose single task contains `parts` verbatim, in order.
 * A part is `{ automated }` or `{ failsWhen }`, so a row can place statements
 * before, between, or after commands and assert the pairing walk directly.
 */
function taskWith(parts, { eol = '\n', name = 'task-0' } = {}) {
  const body = parts.map((p) =>
    'automated' in p
      ? `  <verify><automated>${p.automated}</automated></verify>`
      : `  <fails_when>${p.failsWhen}</fails_when>`,
  );
  return [
    '# Plan',
    '',
    '<task type="auto">',
    `  <name>${name}</name>`,
    '  <action>do the thing</action>',
    ...body,
    '  <done>committed</done>',
    '</task>',
  ].join(eol);
}

/** `parts` per task, so a row can prove pairing never crosses a task boundary. */
function planWithTasks(taskParts, { eol = '\n' } = {}) {
  return taskParts
    .map((parts, i) => taskWith(parts, { eol, name: `task-${i}` }).split(eol).slice(2).join(eol))
    .reduce((acc, t) => `${acc}${eol}${t}`, ['# Plan', ''].join(eol));
}

function statuses(entries) {
  return entries.map((e) => e.status);
}

/**
 * Fixture matching the real `.planning/phases/<dir>/` layout findPhaseInternal
 * resolves against.
 */
function writePhase(root, phaseName, plans) {
  const phaseDir = path.join(root, '.planning', 'phases', phaseName);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [file, body] of Object.entries(plans)) {
    fs.writeFileSync(path.join(phaseDir, file), body, 'utf8');
  }
  return phaseDir;
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3172-'));
});

after(() => {
  if (ROOT) cleanup(ROOT);
});

describe('extractFailingDirections — pairing', () => {
  test('row 1 — pairs a single statement to its preceding command', () => {
    const out = extractFailingDirections(
      taskWith([{ automated: 'npm test' }, { failsWhen: 'non-zero exit' }]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
    assert.equal(out[0].statement, 'non-zero exit');
    assert.equal(out[0].status, 'ok');
    assert.equal(out[0].severity, 'none');
    assert.equal(out[0].task, 'task-0');
  });

  test('row 2 — blocks a command with no failing direction', () => {
    const out = extractFailingDirections(taskWith([{ automated: 'npm test' }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'missing');
    assert.equal(out[0].severity, 'blocker');
    assert.equal(out[0].statement, null);
    // The command is quoted verbatim so the checker can report it without
    // re-deriving it (the "report, never prescribe" rule).
    assert.equal(out[0].command, 'npm test');
  });

  test('row 9 — attributes a statement to the command it follows, not the next one', () => {
    const out = extractFailingDirections(
      taskWith([
        { automated: 'npm test' },
        { failsWhen: 'non-zero exit' },
        { automated: 'npm run lint' },
      ]),
    );
    assert.deepEqual(statuses(out), ['ok', 'missing']);
  });

  test('row 10 — does not credit a later statement to an earlier command', () => {
    const out = extractFailingDirections(
      taskWith([
        { automated: 'npm test' },
        { automated: 'npm run lint' },
        { failsWhen: 'any eslint error' },
      ]),
    );
    assert.deepEqual(statuses(out), ['missing', 'ok']);
  });

  test('row 11 — pairs N statements to N commands in order', () => {
    const out = extractFailingDirections(
      taskWith([
        { automated: 'a' },
        { failsWhen: 'a fails on non-zero exit' },
        { automated: 'b' },
        { failsWhen: 'b fails when stderr is non-empty' },
      ]),
    );
    assert.deepEqual(statuses(out), ['ok', 'ok']);
    assert.deepEqual(
      out.map((e) => e.statement),
      ['a fails on non-zero exit', 'b fails when stderr is non-empty'],
    );
  });

  test('row 12 — statement count at limit-1, limit and limit+1', () => {
    const cmds = ['a', 'b', 'c'];
    const build = (n) => {
      const parts = [];
      cmds.forEach((c, i) => {
        parts.push({ automated: c });
        if (i < n) parts.push({ failsWhen: `${c} fails on non-zero exit` });
      });
      // limit+1: an extra statement trailing the last command.
      if (n > cmds.length) parts.push({ failsWhen: 'redundant but harmless' });
      return parts;
    };

    // limit-1 — two statements for three commands.
    assert.deepEqual(statuses(extractFailingDirections(taskWith(build(2)))), [
      'ok',
      'ok',
      'missing',
    ]);
    // limit — one each.
    assert.deepEqual(statuses(extractFailingDirections(taskWith(build(3)))), ['ok', 'ok', 'ok']);
    // limit+1 — the extra statement HAS a preceding command, so it is redundant,
    // not an orphan, and adds no row.
    const over = extractFailingDirections(taskWith(build(4)));
    assert.deepEqual(statuses(over), ['ok', 'ok', 'ok']);
    assert.equal(over.length, 3);
  });

  test('row 12b — the first statement after a command is the binding one', () => {
    const out = extractFailingDirections(
      taskWith([
        { automated: 'npm test' },
        { failsWhen: 'TBD' },
        { failsWhen: 'non-zero exit, or "0 passed" in the summary' },
      ]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'placeholder');
    assert.equal(out[0].severity, 'blocker');
  });

  test('row 13 — warns on a statement bound to no command', () => {
    const out = extractFailingDirections(
      taskWith([{ failsWhen: 'non-zero exit' }, { automated: 'npm test' }]),
    );
    assert.equal(out.length, 2);
    const orphan = out.find((e) => e.status === 'orphan');
    assert.ok(orphan, 'expected an orphan row');
    assert.equal(orphan.severity, 'warning');
    assert.equal(orphan.command, '');
    // The command that follows it is still unstated — the orphan does not
    // satisfy it.
    assert.equal(out.find((e) => e.command === 'npm test').status, 'missing');
  });

  test('row 16 — pairs commands that sit outside any task block', () => {
    const md = [
      '# Plan',
      '',
      '<verify><automated>npm run build</automated></verify>',
      '<fails_when>a non-zero tsc exit</fails_when>',
      '<verify><automated>npm run lint</automated></verify>',
    ].join('\n');
    const out = extractFailingDirections(md);
    assert.deepEqual(statuses(out), ['ok', 'missing']);
    assert.equal(out[0].task, '');
  });

  test('row 17 — pairing does not leak across task boundaries', () => {
    const md = planWithTasks([
      [{ automated: 'a' }, { failsWhen: 'a fails on non-zero exit' }],
      [{ automated: 'b' }],
    ]);
    const out = extractFailingDirections(md);
    assert.deepEqual(statuses(out), ['ok', 'missing']);
    assert.equal(out[1].task, 'task-1');
  });

  test('row 20 — tolerates attributes on the automated opening tag', () => {
    const md = [
      '<task><name>t</name>',
      '<verify><automated tier="fast">npm test</automated></verify>',
      '<fails_when>non-zero exit</fails_when>',
      '</task>',
    ].join('\n');
    const out = extractFailingDirections(md);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'ok');
  });

  test('row 21 — non-string plan text yields an empty list without throwing', () => {
    for (const bad of [0, '', [], null, undefined, true, {}]) {
      assert.deepEqual(extractFailingDirections(bad), [], `input ${JSON.stringify(bad)}`);
    }
  });

  test('row 22 — bounded walk on pathological unclosed tags', () => {
    // The non-crossing body (`(?!<(?:automated|fails_when)\b)`) is what keeps
    // this LINEAR rather than quadratic; the repeat count was reduced from
    // 30000 to 5000 (#3172 review Fix 2) — the quadratic blowup this probed
    // for is fixed, so 30000 only burns suite time now.
    const md = '<automated>'.repeat(5000) + '<fails_when>'.repeat(5000);
    const out = extractFailingDirections(md);
    assert.ok(Array.isArray(out));
  });

  // #3172 review Fix 2: the non-crossing body must not let an unclosed
  // opener swallow a later well-formed block.
  test('row 36 — an unclosed automated opener does not swallow a later block', () => {
    // Both the unclosed opener and the well-formed pair sit in the SAME task
    // body, so a single VERIFY_TOKEN_RE scan must not let the unclosed
    // opener's lazy body cross the later `<automated>` and consume it.
    const md = [
      '<task><name>t</name>',
      '<verify><automated>',
      '<verify><automated>npm test</automated></verify>',
      '<fails_when>non-zero exit</fails_when>',
      '</task>',
    ].join('\n');
    const out = extractFailingDirections(md);
    const recovered = out.find((e) => e.command === 'npm test');
    assert.ok(recovered, 'expected the well-formed command to be recovered');
    assert.equal(recovered.status, 'ok');
  });

  test('row 14 — an empty automated body is not a failing-direction finding', () => {
    const out = extractFailingDirections(
      taskWith([{ automated: '' }, { automated: '   ' }, { automated: 'npm test' }]),
    );
    // The extractor drops empty bodies (Dimension 8a owns presence), so only
    // the real command is judged here.
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
  });

  test('row 15 — a verify block with no automated command reports nothing', () => {
    const md = taskWith([]).replace('<done>committed</done>', '<verify>eyeball it</verify>');
    assert.deepEqual(extractFailingDirections(md), []);
  });

  test('row 18 — CRLF plan text produces identical verdicts', () => {
    const parts = [
      { automated: 'a' },
      { failsWhen: 'a fails on non-zero exit' },
      { automated: 'b' },
    ];
    const lf = extractFailingDirections(taskWith(parts, { eol: '\n' }));
    const crlf = extractFailingDirections(taskWith(parts, { eol: '\r\n' }));
    assert.deepEqual(
      crlf.map((e) => ({ c: e.command, s: e.statement, st: e.status })),
      lf.map((e) => ({ c: e.command, s: e.statement, st: e.status })),
    );
  });
});

describe('resolveFailingDirection — statement verdicts', () => {
  test('row 3 — treats a whitespace-only statement as empty', () => {
    for (const blank of [' ', '\t', '\n', '  \r\n  ']) {
      const r = resolveFailingDirection('npm test', blank);
      assert.equal(r.status, 'empty', `blank ${JSON.stringify(blank)}`);
      assert.equal(r.severity, 'blocker');
    }
  });

  test('row 4 — rejects every placeholder atom, case-insensitively', () => {
    for (const atom of PLACEHOLDER_ATOMS) {
      for (const cased of [atom, atom.toUpperCase(), `  ${atom}  `]) {
        const r = resolveFailingDirection('npm test', cased);
        assert.equal(r.status, 'placeholder', `atom ${JSON.stringify(cased)}`);
        assert.equal(r.severity, 'blocker');
      }
    }
  });

  test('row 5 — accepts prose that merely starts with a placeholder word', () => {
    for (const prose of [
      'TBD in the harness output is printed instead of a count',
      'none of the assertions print, so the summary line is absent',
      '- a missing summary line',
    ]) {
      const r = resolveFailingDirection('npm test', prose);
      assert.equal(r.status, 'ok', `prose ${JSON.stringify(prose)}`);
      assert.equal(r.severity, 'none');
    }
  });

  test('row 19 — accepts a statement containing angle brackets and quotes', () => {
    for (const stmt of [
      'exit code > 0',
      'stderr contains "FAIL" && exit != 0',
      "the line 'ok 0' appears",
      'a non-zero exit,\nor an empty summary',
    ]) {
      const r = resolveFailingDirection('npm test', stmt);
      assert.equal(r.status, 'ok', `statement ${JSON.stringify(stmt)}`);
    }
  });

  test('row 6 — exempts the MISSING Wave-0 sentinel', () => {
    const r = resolveFailingDirection(SENTINEL, null);
    assert.equal(r.status, 'sentinel');
    assert.equal(r.severity, 'none');
  });

  test('row 7 — keeps a sentinel silent even when a statement follows it', () => {
    const r = resolveFailingDirection(SENTINEL, 'non-zero exit');
    assert.equal(r.status, 'sentinel');
    assert.equal(r.severity, 'none');
  });

  test('row 8 — a sentinel does not consume the following statement', () => {
    const out = extractFailingDirections(
      taskWith([
        { automated: SENTINEL },
        { automated: 'npm test' },
        { failsWhen: 'non-zero exit' },
      ]),
    );
    assert.deepEqual(statuses(out), ['sentinel', 'ok']);
  });

  test('returns a closed-enum shape for non-string input', () => {
    for (const bad of [null, undefined, 0, [], {}, true]) {
      const r = resolveFailingDirection(bad, bad);
      assert.ok(KNOWN_STATUSES.has(r.status), `status for ${JSON.stringify(bad)}`);
      assert.ok(KNOWN_SEVERITIES.has(r.severity), `severity for ${JSON.stringify(bad)}`);
    }
  });

  // #3172 review finding: a blocking gate must not be bypassed by a command
  // that merely starts with the letters MISSING — the pre-fix `\b` anchor
  // also matched an env-var assignment prefix (`=` is a non-word char).
  test('row 34 — an env-var assignment prefixed MISSING= is judged, not exempted', () => {
    const r = resolveFailingDirection('MISSING=true npm test && echo done', undefined);
    assert.equal(r.status, 'missing');
    assert.equal(r.severity, 'blocker');
    for (const cmd of ['MISSING_FOO=1 npm test', 'MISSINGLY npm test']) {
      const r2 = resolveFailingDirection(cmd, undefined);
      assert.equal(r2.status, 'missing', `command ${JSON.stringify(cmd)}`);
    }
  });

  // Negative-space partner of row 34 — the tightening must not break the
  // exemption it exists to preserve.
  test('row 35 — the real Wave-0 sentinel forms stay exempt', () => {
    for (const cmd of ['MISSING', 'MISSING — Wave 0 must create tests/x.test.ts']) {
      const r = resolveFailingDirection(cmd, undefined);
      assert.equal(r.status, 'sentinel', `command ${JSON.stringify(cmd)}`);
      assert.equal(r.severity, 'none', `command ${JSON.stringify(cmd)}`);
    }
  });
});

describe('probePhaseFailingDirections', () => {
  test('row 25 — aggregates counts across every plan in the phase', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'agg-'));
    const phaseDir = writePhase(root, 'phase-1', {
      '01-01-PLAN.md': taskWith([{ automated: 'a' }, { failsWhen: 'a fails on non-zero exit' }]),
      '01-02-PLAN.md': taskWith([{ automated: 'b' }]),
    });
    const out = probePhaseFailingDirections({ phaseDir });
    assert.equal(out.readError, null);
    assert.equal(out.counts.total, 2);
    assert.equal(out.counts.blocker, 1);
    assert.equal(out.status, 'blocked');
    const plans = out.commands.map((c) => c.plan).sort();
    assert.deepEqual(plans, ['01-01-PLAN.md', '01-02-PLAN.md']);
  });

  test('a phase whose every command is stated reports ok', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'clean-'));
    const phaseDir = writePhase(root, 'phase-2', {
      '02-01-PLAN.md': taskWith([{ automated: 'a' }, { failsWhen: 'a fails on non-zero exit' }]),
    });
    const out = probePhaseFailingDirections({ phaseDir });
    assert.equal(out.status, 'ok');
    assert.equal(out.counts.blocker, 0);
  });

  test('row 23 — an unreadable plan reports readError rather than a clean pass', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'ioerr-'));
    const phaseDir = writePhase(root, 'phase-3', {
      '03-01-PLAN.md': taskWith([{ automated: 'a' }]),
    });
    const realRead = fs.readFileSync;
    try {
      fs.readFileSync = (p, ...rest) => {
        if (String(p).endsWith('03-01-PLAN.md')) {
          const err = new Error('EACCES: simulated read failure');
          err.code = 'EACCES';
          throw err;
        }
        return realRead(p, ...rest);
      };
      const out = probePhaseFailingDirections({ phaseDir });
      assert.ok(out.readError, 'expected a populated readError');
      assert.deepEqual(out.commands, []);
      // "could not look" must never render as "nothing to report".
      assert.notEqual(out.status, 'ok');
    } finally {
      fs.readFileSync = realRead;
    }
  });

  test('row 24 — an unresolvable phase emits a degraded payload', () => {
    const out = probePhaseFailingDirections({ phaseDir: path.join(ROOT, 'does-not-exist') });
    assert.ok(out.readError, 'expected a populated readError');
    assert.deepEqual(out.commands, []);
    assert.deepEqual(out.counts, { blocker: 0, warning: 0, total: 0 });
  });
});

describe('the #2401 path probe is not disturbed (Hyrum consequences)', () => {
  test('row 28 — adding fails_when does not change extractAutomatedCommands output', () => {
    const withStatements = taskWith([
      { automated: 'npm test' },
      { failsWhen: 'non-zero exit' },
      { automated: 'npm run lint' },
      { failsWhen: 'any eslint error' },
    ]);
    const withoutStatements = taskWith([{ automated: 'npm test' }, { automated: 'npm run lint' }]);
    assert.deepEqual(
      extractAutomatedCommands(withStatements).map((c) => ({ t: c.task, c: c.command })),
      extractAutomatedCommands(withoutStatements).map((c) => ({ t: c.task, c: c.command })),
    );
  });

  test('row 29 — a missing failing direction does not alter the path probe verdict', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'undisturbed-'));
    const stated = writePhase(root, 'phase-a', {
      '01-PLAN.md': taskWith([{ automated: 'npm test' }, { failsWhen: 'non-zero exit' }]),
    });
    const unstated = writePhase(root, 'phase-b', {
      '01-PLAN.md': taskWith([{ automated: 'npm test' }]),
    });
    const a = probePhaseVerifyCommands({ phaseDir: stated, projectRoot: root });
    const b = probePhaseVerifyCommands({ phaseDir: unstated, projectRoot: root });
    assert.deepEqual(a.counts, b.counts);
    assert.equal(a.status, b.status);
  });
});

describe('gsd-tools check verify-failure-directions', () => {
  test('row 26 — the check arm emits the probe JSON', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'cli-'));
    writePhase(root, '01-test-phase', {
      '01-01-PLAN.md': taskWith([{ automated: 'npm test' }]),
    });
    const result = runGsdTools(['check', 'verify-failure-directions', '1', '--raw'], root);
    assert.ok(result.success, `check verify-failure-directions should succeed. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.counts.blocker, 1);
    assert.equal(parsed.commands[0].status, 'missing');
  });

  test('row 27 — the check arm degrades when the phase argument is absent', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'cli-noarg-'));
    fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });
    const result = runGsdTools(['check', 'verify-failure-directions', '--raw'], root);
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.readError, 'expected a populated readError');
    assert.match(parsed.readError, /phase/i);
    assert.deepEqual(parsed.commands, []);
  });
});

describe('the plan-authoring contract text (#3172)', () => {
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  test('row 30 — the planner spawn contract requires a failing direction', () => {
    // #3172's planner-side rule is projected onto the spawn contract, not
    // written into the agent file — see row 30b. Assert the block exists and
    // governs what it must.
    const block = read('gsd-core/workflows/plan-phase.md')
      .split('<failing_direction_contract>')[1]
      ?.split('</failing_direction_contract>')[0];
    assert.ok(block, 'plan-phase.md must carry the <failing_direction_contract> block in the planner spawn prompt (#3172)');
    assert.match(block, /<fails_when>/);
    assert.match(block, /planner-failing-direction\.md/);
    // The rule is worthless if it does not name the sentinel exemption and
    // the placeholder rejection — those are the two edges a planner gets wrong.
    assert.match(block, /MISSING/);
    assert.match(block, /TBD/);
    // The reference the contract points at must exist and name the element.
    assert.match(read('gsd-core/references/planner-failing-direction.md'), /<fails_when>/);
  });

  test('row 30b — the frozen planner agent file is untouched by #3172', () => {
    // agents/gsd-planner.md is pinned under a 49152-LF-char cap by four
    // suites; #3297/#3645 established that a planner-side rule goes in the
    // spawn contract instead. Guard the freeze in both directions: the cap
    // itself, and the absence of this issue's rule from the agent file.
    const src = read('agents/gsd-planner.md');
    const lf = src.replace(/\r\n/g, '\n').length;
    assert.ok(lf < 49152, `gsd-planner.md is ${lf} LF chars — must stay < 49152 (#3172 keeps the planner frozen; the rule lives in plan-phase.md's spawn contract)`);
    assert.ok(!src.includes('fails_when'),
      'the failing-direction rule belongs in the spawn contract, not the frozen agent file (#3172)');
  });

  test('row 31 — the extracted Nyquist detail survives the move', () => {
    const checker = read('agents/gsd-plan-checker.md');
    const nyquist = read('gsd-core/references/nyquist-compliance.md');
    // The new check lives in the agent as a pointer; its detail and the
    // extracted 8a-8e detail live in references.
    assert.match(checker, /nyquist-compliance\.md/);
    assert.match(checker, /failing-direction\.md/);
    for (const check of ['8a', '8b', '8c', '8d', '8e']) {
      assert.match(nyquist, new RegExp(`Check ${check}`), `Check ${check} detail`);
    }
    assert.match(read('gsd-core/references/failing-direction.md'), /blocker/);
  });

  test('row 32 — plan-phase dispatches the failing-direction probe', () => {
    const workflow = read('gsd-core/workflows/plan-phase.md');
    assert.match(workflow, /check verify-failure-directions/);
    assert.match(workflow, /failing_direction_probe/);
  });
});

describe('property-based invariants', () => {
  test('P1 — resolveFailingDirection is total over arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (command, statement) => {
        const r = resolveFailingDirection(command, statement);
        return KNOWN_STATUSES.has(r.status) && KNOWN_SEVERITIES.has(r.severity);
      }),
    );
  });

  test('P2 — the pairing walk is exact at generated command counts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.boolean(), (k, stated) => {
        const parts = [];
        for (let i = 0; i < k; i += 1) {
          parts.push({ automated: `cmd-${i}` });
          if (stated) parts.push({ failsWhen: `cmd-${i} fails on a non-zero exit` });
        }
        const out = extractFailingDirections(taskWith(parts));
        if (out.length !== k) return false;
        return out.every((e) => e.status === (stated ? 'ok' : 'missing'));
      }),
    );
  });

  test('P3 — CRLF invariance over generated plans', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (k) => {
        const parts = [];
        for (let i = 0; i < k; i += 1) {
          parts.push({ automated: `cmd-${i}` });
          parts.push({ failsWhen: `cmd-${i} fails on a non-zero exit` });
        }
        const lf = extractFailingDirections(taskWith(parts, { eol: '\n' }));
        const crlf = extractFailingDirections(taskWith(parts, { eol: '\r\n' }));
        return (
          lf.length === crlf.length &&
          lf.every((e, i) => e.status === crlf[i].status && e.statement === crlf[i].statement)
        );
      }),
    );
  });

  test('P4 — a sentinel command never yields a blocker', () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (suffix, statement) => {
        const r = resolveFailingDirection(`MISSING ${suffix}`, statement);
        return r.severity !== 'blocker';
      }),
    );
  });
});
