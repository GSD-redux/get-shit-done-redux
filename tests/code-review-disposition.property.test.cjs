'use strict';

/**
 * code-review-disposition.property.test.cjs
 *
 * RULESET.TESTS.property-based-testing — the disposition ledger is a
 * parse/transformation contract with a render/re-parse fixed point, which is
 * the textbook case for a property rather than a fixture.
 *
 * The step file states the contract in prose: "Re-running the gate preserves
 * every disposition except `open`", and it rewrites nothing when nothing
 * changed. Both are invariants over an input space that fixtures sample at a
 * handful of points — id ordering, severity mix, hand-edited source cells with
 * escaped AND bare pipes, carried rows from a review that no longer reports them.
 *
 * Four properties, all over the SHIPPED script (extracted from the step file
 * and executed), never over a model of it. The header said "two" while three
 * were running — the vocabulary property arrived without it, so the count is
 * now stated per property rather than in a lump:
 *
 *   idempotency — running the gate twice leaves the ledger byte-identical and
 *                 the second run reports `unchanged`.
 *   round-trip  — every decided disposition and its source cell survives that
 *                 second run, i.e. render → re-parse → render is the identity
 *                 on the decision.
 *   vocabulary  — a disposition outside the documented enum is coerced to
 *                 `open` rather than treated as a decision, and the `open:`
 *                 headline agrees with the rows it renders.
 *   titles      — a finding's TITLE survives the same cycle, through
 *                 JSON.stringify into the frontmatter and JSON.parse back out.
 *                 This is the contract that decides whether a reused id names
 *                 the same finding, so a lossy round-trip does not corrupt a
 *                 title — it DESTROYS a human's recorded triage, silently. The
 *                 property asserts the consequence, not the JSON.
 *
 * Every arbitrary here is built at module scope, not in a `describe` body —
 * the fast-check v4 trap that cancels a whole block.
 *
 * numRuns is lowered from the shared 200 because each case spawns the shipped
 * script twice through the process seam; the seed stays pinned, so failures
 * still reproduce. Deviating silently would be the worse trade.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const DISPOSITION_STEP_PATH = path.join(
  ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'code-review-disposition.md'
);

const RUNS = { numRuns: 40 };

// The SHIPPED node script, undoing exactly the two escapes its surrounding
// double-quoted shell string requires. Deliberately not a model of it.
function shippedDispositionScript() {
  const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8').replace(/\r\n/g, '\n');
  const open = src.indexOf('node -e "');
  assert.ok(open !== -1, 'the disposition step must still embed a node -e script');
  const body = src.slice(open + 'node -e "'.length);
  const end = body.indexOf('\n" || echo ');
  assert.ok(end !== -1, 'the node -e script must still be closed by its || echo fallback');
  return body.slice(0, end).replace(/\\([\\$`"])/g, '$1');
}

const SCRIPT = shippedDispositionScript();

function runOnce(dir, padded) {
  const res = runNode(['-e', SCRIPT], {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      REVIEW_FILE: path.join(dir, padded + '-REVIEW.md'),
      DISPOSITION_FILE: path.join(dir, padded + '-REVIEW-DISPOSITION.md'),
      FIX_REPORT_FILE: path.join(dir, padded + '-REVIEW-FIX.md'),
      PADDED: padded,
    },
  });
  assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the shipped script must run to completion');
  assert.strictEqual(res.exitCode, 0, 'the shipped script must exit 0: ' + res.stderr);
  const p = path.join(dir, padded + '-REVIEW-DISPOSITION.md');
  return {
    ledger: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
    unchanged: /disposition unchanged/.test(res.stdout),
    // The reuse report is a CONSOLE note, not a ledger key — the round-trip property below
    // asserts on it, and asserting `^reused:` against the ledger would have been vacuously
    // true forever, which is the shape of a test that cannot fail.
    stdout: res.stdout,
  };
}

// The id prefixes gsd-code-reviewer.md's body template and its Label-equivalence
// paragraph can emit — the domain the step's own enumeration is a subset of.
const PREFIX = fc.constantFrom('CR', 'BL', 'WR', 'IN');
const DECIDED = fc.constantFrom('fixed', 'skipped', 'deferred');

// The vocabulary the ledger documents, and a generator for its COMPLEMENT.
// DECIDED is drawn from the vocabulary, so no property built on it can ever present the parser
// with an out-of-vocabulary token — the round-trip property below is structurally unable to fail
// on one, which is precisely how a bare ([a-z]+) capture shipped past it. JUNK is the arbitrary
// that reaches the class DECIDED cannot: lowercase, so it stays inside the old capture's own
// character set, because a token OUTSIDE it ('Deferred') already failed safe. The unsafe half is
// the one that looks like a decision and is not.
const VOCABULARY = ['open', 'fixed', 'skipped', 'deferred'];
const JUNK = fc.stringMatching(/^[a-z]{2,10}$/).filter((s) => !VOCABULARY.includes(s));

// A hand-written Source cell: the one place a human writes prose into the
// ledger, so it carries the escaped pipe the rendered instruction asks for — AND the bare
// pipe a human actually types. Round 3 of #3861 found that this generator only ever emitted
// the escaped form, so the property built to stress this cell was structurally unable to
// reach the one input that broke it: a bare | failed the whole-line prior-row match, the
// finding reset to open and the reason was destroyed. A generator that reaches only the
// inputs the parser was written for is a fixture with extra steps.
// The reserved suffix is generated DELIBERATELY. The gate strips a carried marker before storing
// it, so a hand-written reason that merely ENDS in that phrase is the input most likely to be
// eaten — and a generator drawn only from innocuous characters can never produce it. Found by
// adversarial review of this file's first cut, which is the argument for putting it in.
const SOURCE_CELL = fc.stringMatching(/^[A-Za-z0-9 .,()-]{0,24}$/)
  .map((s) => s.trim() || 'recorded')
  .chain((s) => fc.boolean().map((withPipe) => (withPipe ? s + ' \\| see ADR-9' : s)))
  .chain((s) => fc.boolean().map((barePipe) => (barePipe ? s + ' | team B to align' : s)))
  // Adjacent pipes and a backslash of either parity before a pipe: the first render escape got both
  // wrong while passing every input above (round 3, adversarial pass over the fix).
  .chain((s) => fc.constantFrom('', ' A||B', ' C\\\\|D', ' E\\\\\\|F').map((t) => s + t))
  .chain((s) => fc.boolean().map((reserved) => (reserved ? s + ' (not in the current review)' : s)));

const IDS = fc.uniqueArray(
  fc.tuple(PREFIX, fc.integer({ min: 1, max: 99 })).map(([p, n]) => p + '-' + String(n).padStart(2, '0')),
  { minLength: 1, maxLength: 6 }
);

// A finding TITLE, which is a parsed and re-serialized value and therefore an input space,
// not decoration. Titles entered this file's contract when the ledger began carrying them to
// tell a reused id from the same finding; the generator did not follow, and every heading was
// built as the fixed string 'finding number <i>' — no colon, quote, backslash, or empty string.
// That is the same shape as this PR's round-3 blocker, where SOURCE_CELL emitted only a
// PRE-ESCAPED pipe and so could never reach the bare one that broke the parser. A generator
// drawn only from safe characters is a fixture with extra steps, and it cannot fail on the one
// input the code under test was written for.
//
// The class is chosen from what the render's own comments say the escaping is FOR:
//   `:`  the reason yv() exists at all — a bare `title: Parser: loses data` is not YAML.
//   `"`  and `\`  what JSON.stringify must escape and JSON.parse must give back unchanged.
//   ``   the empty string — 'known-empty vs NOT KNOWN' is a distinction the render draws
//        explicitly (`typeof r.t === 'string'`), and conflating them was a stated leak.
//   `#`  a YAML comment leader in scalar position.
// plus scalars that MIMIC the ledger's own frontmatter grammar (`findings:`, `titles: json`,
// a nested `    title: ` line), because the re-parser walks that grammar by line shape and a
// title is the one field a human-visible artifact copies verbatim out of a review.
//
// BOUND, stated rather than silently omitted: no CR or LF. A `###` heading is one line by
// definition, so a newline is not an input the heading parser can be handed at all — oneLine()
// guards the value's other producers, not this one. Widening here would generate a review this
// repo's own reviewer agent cannot emit.
const TITLE_CHARS = fc.constantFrom(
  'a', 'Z', '9', ' ', '\t', ':', '"', '\\', '#', '|', "'", '{', '}', '[', ']', ',', '-', '_', '.',
  'é', '✓', '—'
);
const TITLE = fc.oneof(
  fc.array(TITLE_CHARS, { maxLength: 24 }).map((a) => a.join('')),
  fc.constantFrom(
    '',
    'Parser: loses data',
    'a "quoted" title',
    'a backslash \\ and a quote "',
    'title: not a key',
    'findings:',
    'titles: json',
    '    title: "nested"',
    '  - id: CR-99',
    'null',
    '"null"',
    '#3829 leading hash',
    '   surrounded by space   ',
    'unicode — é ✓ 中文',
    'ends with a backslash \\',
    'a title long enough to outrun a scanner that assumes short scalars: ' + 'x'.repeat(200)
  )
);

// One TITLE per id, so every property below runs the render/re-parse cycle over the title
// contract rather than over a constant.
const FINDINGS = IDS.chain((ids) =>
  fc.array(TITLE, { minLength: ids.length, maxLength: ids.length })
    .map((titles) => ids.map((id, i) => ({ id, title: titles[i] })))
);

function reviewFor(findings) {
  return ['---', 'phase: 01', 'status: issues_found', '---', '']
    .concat(findings.map((f) => '### ' + f.id + ': ' + f.title + '\n')).join('\n');
}

// What the ledger MUST hold for a title, derived from the heading grammar rather than copied
// from the render. ID_RE's `:\s*` eats the leading whitespace and its `.trim()` the trailing, so
// the stored value is the trimmed title; oneLine() is then the identity on it, because this
// generator emits no CR or LF (the bound above).
//
// TRIM, NOT A `\s+` COLLAPSE — the distinction is load-bearing and easy to get backwards.
// Internal runs of whitespace are collapsed by sameTitle(), which is the COMPARISON rule, and are
// preserved by oneLine(), which is the STORAGE rule. This asserts storage. Writing the collapse
// here would fail on an internal tab against entirely correct code, which is the shape of a test
// that gets weakened rather than believed the first time it goes red.
const expectedTitle = (t) => String(t).trim();

describe('#3829 — the disposition ledger is a render/re-parse fixed point', () => {
  test('re-running the gate rewrites nothing and changes nothing', () => {
    fc.assert(fc.property(FINDINGS, (findings) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3829-prop-'));
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), reviewFor(findings));
        const first = runOnce(dir, '01');
        assert.ok(first.ledger !== null, 'a review with findings must produce a ledger');
        const second = runOnce(dir, '01');
        // Idempotency: the second run is a no-op, and says so. The timestamp is
        // the one field that always differs, so a gate that stamped it
        // unconditionally would dirty the tree on every phase re-run.
        assert.ok(second.unchanged, 'the second run must report the ledger unchanged');
        assert.strictEqual(second.ledger, first.ledger, 'the second run must not rewrite the ledger');
      } finally {
        cleanup(dir);
      }
    }), RUNS);
  });

  test('a recorded decision and its reason survive re-rendering', () => {
    fc.assert(fc.property(FINDINGS, DECIDED, SOURCE_CELL, (findings, decision, source) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3829-prop-'));
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), reviewFor(findings));
        // A human decides the first finding by hand, reason included — the case
        // the Source cell exists for.
        const target = findings[0].id;
        fs.writeFileSync(
          path.join(dir, '01-REVIEW-DISPOSITION.md'),
          '| ' + target + ' | critical | ' + decision + ' | ' + source + ' |\n'
        );
        const out = runOnce(dir, '01');
        const row = out.ledger.split('\n').find((l) => l.startsWith('| ' + target + ' '));
        assert.ok(row, 'the decided finding must still have a row');
        const cells = row.split(/\s\|\s/).map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim());
        // Round-trip: render -> re-parse -> render is the identity on the
        // decision AND on the reason. `open` never overwrites either.
        assert.strictEqual(cells[2], decision, 'the recorded disposition must survive');
        // The reason survives verbatim EXCEPT for one trailing carried marker, which the parse
        // removes because it is indistinguishable from the one the render appends. That is the
        // contract, not a weakened assertion: leaving a stored marker in place makes the ledger
        // claim a finding is 'not in the current review' on the very run that reports it, and
        // stripping unboundedly ate the cell. One occurrence, one direction, stated here so the
        // trade is visible rather than discovered.
        const MARK = /\s*\(not in the current review\)\s*$/;
        // A bare | in the reason is kept as prose and ESCAPED on re-render, so the rendered
        // cell is the escaped form of what the human wrote — same text under any markdown
        // renderer, and the file converges on the second run. Before this the row simply
        // failed to parse and the decision was lost, which is the defect this arbitrary now reaches.
        // An INDEPENDENT oracle, deliberately not the render's own scan: a pipe is escaped iff an
        // EVEN number of backslashes (including zero) immediately precedes it, counted by walking
        // the string. A copy of the production regex here would agree with it when both are wrong
        // (the round-3 adversarial pass refused exactly that shape), and a single-character
        // look-behind agreed with the first, wrong render -- the negative control caught the mirror.
        const escapePipes = (t) => {
          let out = '', run = 0;
          for (const ch of t) {
            if (ch === '\\') { run += 1; out += ch; continue; }
            if (ch === '|' && run % 2 === 0) out += '\\|'; else out += ch;
            run = 0;
          }
          return out;
        };
        assert.strictEqual(
          cells[3], escapePipes(source.replace(MARK, '')),
          'the reason survives, bare pipes escaped, less at most one trailing carried marker'
        );
        assert.doesNotMatch(cells[3], MARK, 'and a current finding is never marked as carried');
      } finally {
        cleanup(dir);
      }
    }), RUNS);
  });

  test('an out-of-vocabulary disposition is coerced to open, never treated as a decision', () => {
    fc.assert(fc.property(FINDINGS, JUNK, SOURCE_CELL, (findings, junk, source) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3829-prop-'));
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), reviewFor(findings));
        const target = findings[0].id;
        // One transposed character is the whole input. Under ([a-z]+) this was stored as a
        // decision: not the literal 'open', so it beat the default, was excluded from the open:
        // headline count, and was carried forward forever — a ledger reporting a phase fully
        // triaged off a typo. ADR-227's rule is that a value failing the enum check is coerced
        // to the contract's safe default, and 'open' is that default.
        fs.writeFileSync(
          path.join(dir, '01-REVIEW-DISPOSITION.md'),
          '| ' + target + ' | critical | ' + junk + ' | ' + source + ' |\n'
        );
        const out = runOnce(dir, '01');
        const row = out.ledger.split('\n').find((l) => l.startsWith('| ' + target + ' '));
        assert.ok(row, 'the finding must still have a row');
        const cells = row.split(/\s\|\s/).map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim());
        assert.strictEqual(cells[2], 'open', 'a junk token is not a decision');
        // And the headline count must AGREE with the row it renders. This is the half the
        // original defect actually reported wrongly: the row said one thing, `open: N` another.
        assert.match(out.ledger, /^open: (\d+)$/m);
        const open = Number(/^open: (\d+)$/m.exec(out.ledger)[1]);
        assert.strictEqual(open, findings.length, 'every finding is open, and the count says so');
      } finally {
        cleanup(dir);
      }
    }), RUNS);
  });

  test('a title survives the ledger round-trip, so a decision is not lost to its own title', () => {
    fc.assert(fc.property(FINDINGS, DECIDED, (findings, decision) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3829-prop-'));
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), reviewFor(findings));
        const first = runOnce(dir, '01');
        assert.ok(first.ledger !== null, 'a review with findings must produce a ledger');
        const target = findings[0].id;

        // (1) THE STORED FORM. `title: <scalar>` must JSON.parse back to the trimmed heading
        // title. A bare scalar would have shipped `title: Parser: loses data`, which a real YAML
        // reader rejects — that is why yv() is JSON.stringify and not the value itself.
        const fmLine = first.ledger.split('\n')
          .find((l, i, all) => l.startsWith('    title: ')
            && all.slice(0, i).reverse().find((p) => p.startsWith('  - id: ')) === '  - id: ' + target);
        assert.ok(fmLine, 'the ledger must carry a title for ' + target);
        assert.strictEqual(
          JSON.parse(fmLine.slice('    title: '.length)), expectedTitle(findings[0].title),
          'the stored title must JSON.parse back to the title the heading carried'
        );

        // (2) THE CONSEQUENCE, which is what makes this a property and not an assertion about
        // JSON. Decide the finding by EDITING THE RENDERED LEDGER IN PLACE — never by writing a
        // bare row. A bare row carries no frontmatter, so priorTitle is empty, sameFinding()
        // returns true through its `!priorTitle.has(id)` back-compat arm, and the title contract
        // is never consulted at all: the test would pass over a completely broken round-trip.
        // That collapse is the reason this property is written this way.
        const decided = first.ledger.replace(
          new RegExp('^\\| ' + target + ' \\| ([a-z]+) \\| open \\|', 'm'),
          '| ' + target + ' | $1 | ' + decision + ' |'
        );
        assert.notStrictEqual(decided, first.ledger, 'the hand-edit must actually change the row');
        fs.writeFileSync(path.join(dir, '01-REVIEW-DISPOSITION.md'), decided);

        // The review is UNCHANGED, so the id still names the same finding and the decision must be
        // inherited. A lossy round-trip is observable exactly here: priorTitle would disagree with
        // the heading, sameFinding() would go false, and the row would reset to `open` — a human's
        // recorded triage destroyed by nothing but the shape of its own title.
        const second = runOnce(dir, '01');
        const row = second.ledger.split('\n').find((l) => l.startsWith('| ' + target + ' '));
        assert.ok(row, 'the decided finding must still have a row');
        const cells = row.split(/\s\|\s/).map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim());
        assert.strictEqual(cells[2], decision, 'the decision survives its own title');
        assert.doesNotMatch(
          second.stdout, /DROPPED/,
          'and no decision is reported dropped — the id still names the same finding'
        );

        // (3) FIXED POINT. Third run rewrites nothing — the re-parsed title re-renders to itself.
        const third = runOnce(dir, '01');
        assert.ok(third.unchanged, 'the third run must report the ledger unchanged');
        assert.strictEqual(third.ledger, second.ledger, 'render -> re-parse -> render is a fixed point');
      } finally {
        cleanup(dir);
      }
    }), RUNS);
  });
});
