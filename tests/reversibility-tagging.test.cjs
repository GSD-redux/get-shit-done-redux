// allow-test-rule: source-text-is-the-product [#1951]
// Agent .md, workflow .md, command .md, reference .md and docs/reference/*.md —
// their text IS what the runtime loads, so asserting they document the
// reversibility contract tests the deployed surface, not derived behavior.
// Per the CONTRIBUTING.md exception matrix. The behavioral half
// (cmdVerifyPlanStructure) asserts the structural validator stays additive.
// Issue #1951.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { scanFencedBlocks, collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLANNER = path.join(ROOT, 'agents', 'gsd-planner.md');
const PLAN_MD_DOC = path.join(ROOT, 'docs', 'reference', 'plan-md.md');
const REVERSIBILITY_REF = path.join(ROOT, 'gsd-core', 'references', 'planner-reversibility.md');
const ANTIPATTERNS_REF = path.join(ROOT, 'gsd-core', 'references', 'planner-antipatterns.md');
const THINKING_MODELS = path.join(ROOT, 'gsd-core', 'references', 'thinking-models-planning.md');
const PLAN_PHASE_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const PLAN_PHASE_CMD = path.join(ROOT, 'commands', 'gsd', 'plan-phase.md');
const HELP_FULL = path.join(ROOT, 'gsd-core', 'workflows', 'help', 'modes', 'full.md');
const DISCUSS_CONTEXT_TEMPLATE = path.join(
  ROOT, 'gsd-core', 'workflows', 'discuss-phase', 'templates', 'context.md',
);

/** The canonical three-level taxonomy. Single source of truth for this suite. */
const RATINGS = ['reversible', 'costly', 'one-way'];

/** Agent-file hard red line (tests/agent-size-budget.test.cjs LARGE_CAP). */
const LARGE_CAP = 49152;

function read(file) {
  return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Word-boundary rating match. A plain `.includes('reversible')` also matches
 * inside "irreversible"/"irreversibility", which appear in anti-pattern prose —
 * so a surface that dropped the real taxonomy entry could still pass.
 */
function namesRating(text, rating) {
  // Escape every regex metacharacter, backslash included — a partial escape is
  // js/incomplete-sanitization (CodeQL, high). `-` needs no escaping outside a
  // character class, so the previous `-`-only replace was both incomplete and
  // unnecessary.
  const escaped = escapeRegex(rating);
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/** The fenced ```bash blocks of a workflow file, so prose cannot satisfy a
 *  test that claims to assert on the parser. */
function bashBlocks(md) {
  const lines = md.split(/\r?\n/);
  return scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
}

/** The body of the "## N. Reversibility Test" section (heading excluded), or '' if absent. */
function reversibilityTestSection(md) {
  const section = collectSection(md, (h) => /^\d+\. Reversibility Test\b/.test(h.text));
  return section ? section.body : '';
}

// ─── Acceptance #1: discuss-phase decisions carry a rating + rationale ───────

describe('#1951 discuss-phase: decisions carry a reversibility rating', () => {
  test('CONTEXT.md template documents a Reversibility field on decisions', () => {
    const tpl = read(DISCUSS_CONTEXT_TEMPLATE);
    assert.match(
      tpl,
      /\*\*Reversibility:\*\*/,
      'discuss-phase/templates/context.md must document a **Reversibility:** field on captured decisions',
    );
  });

  test('template names all three ratings', () => {
    const tpl = read(DISCUSS_CONTEXT_TEMPLATE);
    for (const rating of RATINGS) {
      assert.ok(
        namesRating(tpl, rating),
        `context.md template must name the "${rating}" rating`,
      );
    }
  });

  test('template pairs the rating with a rationale', () => {
    const tpl = read(DISCUSS_CONTEXT_TEMPLATE);
    assert.match(
      tpl,
      /\*\*Reversibility:\*\*[^\n]*rationale/i,
      'the rating must be recorded together with its rationale, not bare',
    );
  });

  test('rating is optional — decisions without one stay valid (back-compat)', () => {
    const tpl = read(DISCUSS_CONTEXT_TEMPLATE);
    assert.match(
      tpl,
      /reversibilit\w*[^\n]*optional|optional[^\n]*reversibilit/i,
      'context.md template must state the reversibility field is optional',
    );
  });
});

// ─── Acceptance #2 + #3: planner checkpoint-insertion rules ─────────────────

describe('#1951 gsd-planner: one-way inserts a checkpoint, reversible does not', () => {
  test('planner @-references the reversibility reference file', () => {
    assert.ok(
      read(PLANNER).includes('planner-reversibility.md'),
      'gsd-planner.md must @-reference planner-reversibility.md (progressive disclosure)',
    );
  });

  test(`planner stays under the ${LARGE_CAP}-char agent cap`, () => {
    const planner = read(PLANNER);
    assert.ok(
      planner.length < LARGE_CAP,
      `gsd-planner.md is ${planner.length} chars, must be < ${LARGE_CAP} (LF-normalized). `
      + 'Crossing the cap means EXTRACT to a reference file, not bump.',
    );
  });

  test('planner states that a one-way decision inserts a checkpoint:decision', () => {
    const planner = read(PLANNER);
    assert.match(
      planner,
      /one-way[^\n]*checkpoint:decision|checkpoint:decision[^\n]*one-way/,
      'gsd-planner.md must state that a one-way rating inserts a checkpoint:decision',
    );
  });

  test('reference file states the checkpoint precedes the dependent task', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /before[^\n]*(dependent|the task)/i,
      'planner-reversibility.md must state the checkpoint is inserted BEFORE the dependent task',
    );
  });

  test('reference file states reversible decisions insert no checkpoint', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /reversible[^\n]*no checkpoint|no checkpoint[^\n]*reversible/i,
      'planner-reversibility.md must state reversible ratings do NOT trigger a checkpoint',
    );
  });

  test('reference file states costly is flagged but not blocking', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /costly[^\n]*(flag|visible)[^\n]*not (block|gat)/i,
      'planner-reversibility.md must state costly ratings are flagged in the plan but never block',
    );
  });

  test('reference file requires autonomous:false when a checkpoint is inserted', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /autonomous:\s*false/,
      'inserting a checkpoint flips the plan out of autonomous mode — the reference must say so',
    );
  });

  test('reference file defaults to reversible when unsure (checkpoint-fatigue guard)', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /default[^\n]*reversible|when (unsure|in doubt)[^\n]*reversible/i,
      'the taxonomy must default to reversible when unsure, or every decision becomes a gate',
    );
  });
});

// ─── Acceptance #4: the rating is persisted to the plan ─────────────────────

describe('#1951 plan-md.md documents the <reversibility> element', () => {
  test('plan-md.md documents the element', () => {
    assert.match(
      read(PLAN_MD_DOC),
      /<reversibility/,
      'docs/reference/plan-md.md must document the <reversibility> task element',
    );
  });

  test('plan-md.md documents all three ratings', () => {
    const doc = read(PLAN_MD_DOC);
    for (const rating of RATINGS) {
      assert.ok(
        namesRating(doc, rating),
        `plan-md.md must document the "${rating}" rating`,
      );
    }
  });

  test('plan-md.md states the element is optional', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /<reversibility[\s\S]{0,600}?optional|optional[\s\S]{0,600}?<reversibility/,
      'plan-md.md must describe <reversibility> as an optional element',
    );
  });
});

// ─── Acceptance #5: the override ────────────────────────────────────────────

describe('#1951 --no-reversibility-gates override', () => {
  // Asserted against the fenced bash blocks, NOT the whole file: the workflow's
  // own prose mentions `--no-reversibility-gates` and `REVERSIBILITY_GATES=false`
  // in one sentence, so a whole-file substring check would still pass with the
  // conditional deleted — it would be testing the documentation, not the parser.
  test('plan-phase workflow defaults REVERSIBILITY_GATES to true (in bash)', () => {
    assert.ok(
      bashBlocks(read(PLAN_PHASE_WORKFLOW)).some((b) => /^REVERSIBILITY_GATES=true$/m.test(b)),
      'a bash block in plan-phase.md must assign REVERSIBILITY_GATES=true',
    );
  });

  test('plan-phase workflow parses --no-reversibility-gates to false (in bash)', () => {
    // One physical line: `if [[ ... --no-reversibility-gates ... ]]; then REVERSIBILITY_GATES=false; fi`
    const conditional = /^if \[\[.*--no-reversibility-gates.*\]\];\s*then\s+REVERSIBILITY_GATES=false;\s*fi\s*$/m;
    assert.ok(
      bashBlocks(read(PLAN_PHASE_WORKFLOW)).some((b) => conditional.test(b)),
      'a bash block in plan-phase.md must contain the --no-reversibility-gates -> '
      + 'REVERSIBILITY_GATES=false conditional (prose mentioning both tokens is not the parser)',
    );
  });

  test('plan-phase workflow injects REVERSIBILITY_GATES into the planner prompt', () => {
    assert.match(
      read(PLAN_PHASE_WORKFLOW),
      /\*\*REVERSIBILITY_GATES:\*\* \$\{REVERSIBILITY_GATES\}/,
      'plan-phase.md must inject **REVERSIBILITY_GATES:** ${REVERSIBILITY_GATES} into the planner prompt',
    );
  });

  test('command argument-hint advertises the flag', () => {
    const md = read(PLAN_PHASE_CMD);
    const argHint = (md.match(/^argument-hint:.*$/m) || [''])[0];
    assert.ok(
      argHint.includes('--no-reversibility-gates'),
      'commands/gsd/plan-phase.md argument-hint must list --no-reversibility-gates',
    );
  });

  test('command documents the flag in its flag list', () => {
    assert.match(
      read(PLAN_PHASE_CMD),
      /- `--no-reversibility-gates` —/,
      'commands/gsd/plan-phase.md must document --no-reversibility-gates in its flag list',
    );
  });

  test('help full mode lists the flag (argument-hint ↔ help parity)', () => {
    assert.ok(
      read(HELP_FULL).includes('--no-reversibility-gates'),
      'workflows/help/modes/full.md must list --no-reversibility-gates',
    );
  });

  test('override suppresses the gate but NOT the rating', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /REVERSIBILITY_GATES=false[\s\S]{0,400}?(still|record|persist|emit)/i,
      'the override must suppress checkpoint insertion while still persisting the rating — '
      + 'the signal survives an unattended run',
    );
  });
});

// ─── Behavioral: the structural validator stays additive ────────────────────
//
// cmdVerifyPlanStructure checks for PRESENCE of required tags and must not
// reject the new optional element. Covers every rating plus the absent case
// (the enum-boundary analog: each valid value, and the omitted value).

function planWith({ reversibility = null, precedingCheckpoint = false } = {}) {
  const task = [];
  if (precedingCheckpoint) {
    task.push(
      // Per #2444, cmdVerifyPlanStructure branches on task type: a
      // checkpoint:decision requires <name> + <resume-signal> + <decision> +
      // <options>, and is exempt from the <action>/<verify>/<done>/<files> set
      // that auto/tracer tasks carry. This fixture mirrors that contract
      // exactly rather than padding it with fields checkpoints do not need.
      '<task type="checkpoint:decision" gate="blocking">',
      '  <name>Task 0: Confirm the on-disk format</name>',
      '  <decision>Pick the on-disk format</decision>',
      '  <context>Later phases read this file.</context>',
      '  <options>',
      '    <option id="option-a">',
      '      <name>Newline-delimited JSON</name>',
      '      <pros>Streamable, appendable, greppable</pros>',
      '      <cons>Larger on disk than a binary frame</cons>',
      '    </option>',
      '    <option id="option-b">',
      '      <name>Length-prefixed binary</name>',
      '      <pros>Compact, fast to seek</pros>',
      '      <cons>Opaque to standard tooling</cons>',
      '    </option>',
      '  </options>',
      '  <resume-signal>Select: option-a or option-b</resume-signal>',
      '</task>',
      '',
    );
  }
  task.push(
    '<task type="auto">',
    '  <name>Task 1: Test</name>',
  );
  if (reversibility !== null) {
    task.push(`  <reversibility rating="${reversibility}">rationale text</reversibility>`);
  }
  task.push(
    '  <files>src/x.ts</files>',
    '  <action>Do the thing.</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '',
  );
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/x.ts]',
    // A plan containing any checkpoint must declare autonomous: false — the
    // validator already errors otherwise, and inserting a reversibility gate
    // is precisely what flips this field.
    `autonomous: ${precedingCheckpoint ? 'false' : 'true'}`,
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    ...task,
    '</tasks>',
  ].join('\n');
}

function verifyPlan(tmpDir, content) {
  const rel = path.join('.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), content);
  const result = runGsdTools(`verify plan-structure ${rel}`, tmpDir);
  assert.ok(result.success, `verify plan-structure failed to run: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#1951 cmdVerifyPlanStructure accepts <reversibility> (additive)', () => {
  for (const rating of RATINGS) {
    test(`plan with rating="${rating}" passes structural validation`, (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));

      // one-way needs its gate present, or the ungated-one-way warning fires
      // (that path is asserted separately below).
      const out = verifyPlan(tmp, planWith({
        reversibility: rating,
        precedingCheckpoint: rating === 'one-way',
      }));
      assert.strictEqual(
        out.valid, true,
        `plan with rating="${rating}" must be valid, errors: ${JSON.stringify(out.errors)}`,
      );
      assert.deepStrictEqual(out.errors, [], 'no validation path may reject a <reversibility> task');
      assert.ok(
        !(out.warnings || []).some((w) => /reversibilit/i.test(w)),
        `a well-formed rating="${rating}" task must not be flagged`,
      );
    });
  }

  test('plan without <reversibility> still passes (back-compat)', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ reversibility: null }));
    assert.strictEqual(
      out.valid, true,
      `plan without <reversibility> must be valid (back-compat), errors: ${JSON.stringify(out.errors)}`,
    );
    assert.ok(
      !(out.warnings || []).some((w) => /reversibilit/i.test(w)),
      'an unrated plan must not be flagged',
    );
  });
});

// ─── The gate is machine-detectable, not prose-only ─────────────────────────
//
// The feature's whole promise is that a one-way door gets confirmed before it
// is walked through. A planner that emits the rating but skips the checkpoint
// silently reopens exactly the gap this feature closes, so the validator says
// so. It warns rather than errors: <reversibility> stays additive and the plan
// stays valid.

// Each verifyPlan() spawns gsd-tools, which is the dominant cost of this file
// (measured 5.6s, the 18x-under-median entry that motivated adding it to
// tests/test-timings.json). Assertions are grouped per distinct plan shape so
// the suite spawns once per shape rather than once per assertion.
describe('#1951 ungated one-way rating is flagged', () => {
  test('one-way with NO preceding checkpoint:decision warns, and stays valid', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ reversibility: 'one-way', precedingCheckpoint: false }));
    assert.ok(
      (out.warnings || []).some((w) => /one-way/.test(w) && /checkpoint:decision/.test(w)),
      `an ungated one-way rating must warn; got warnings: ${JSON.stringify(out.warnings)}`,
    );
    assert.strictEqual(
      out.valid, true,
      `an ungated one-way rating must warn, never error; errors: ${JSON.stringify(out.errors)}`,
    );
  });

  test('one-way WITH a preceding checkpoint:decision does not warn', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ reversibility: 'one-way', precedingCheckpoint: true }));
    assert.ok(
      !(out.warnings || []).some((w) => /one-way/.test(w)),
      `a gated one-way rating must not warn; got warnings: ${JSON.stringify(out.warnings)}`,
    );
  });

  // `reversible` and `costly` are covered by the additive suite above: those
  // ratings run there with precedingCheckpoint=false (ungated) and assert no
  // /reversibilit/ warning at all. The gate warning's text contains both
  // "reversibility" and "one-way", so that assertion strictly subsumes a
  // separate never-flagged-as-ungated check — which would only re-spawn
  // gsd-tools twice to prove the same thing.
});

// ─── Parity: one taxonomy, not two ──────────────────────────────────────────
//
// DEFECT.GENERATIVE-FIX-DIVERGENCE. thinking-models-planning.md #4 shipped a
// BINARY REVERSIBLE/IRREVERSIBLE classification before this feature existed.
// Two overlapping taxonomies in files both loaded by gsd-planner is the exact
// divergence class this guard exists to prevent.

describe('#1951 taxonomy parity: a single three-level vocabulary', () => {
  test('the Reversibility Test thinking model uses the canonical three ratings', () => {
    const tm = read(THINKING_MODELS);
    const section = reversibilityTestSection(tm);
    assert.ok(section.length > 0, 'thinking-models-planning.md must retain a Reversibility Test model');
    for (const rating of RATINGS) {
      assert.ok(
        namesRating(section, rating),
        `the Reversibility Test model must use the canonical "${rating}" rating`,
      );
    }
  });

  test('the legacy binary IRREVERSIBLE vocabulary is gone', () => {
    const section = reversibilityTestSection(read(THINKING_MODELS));
    assert.ok(
      !/IRREVERSIBLE/.test(section),
      'the binary REVERSIBLE/IRREVERSIBLE vocabulary must be replaced by the three-level taxonomy, '
      + 'not shipped alongside it',
    );
  });

  test('thinking model points at the canonical taxonomy owner', () => {
    const section = reversibilityTestSection(read(THINKING_MODELS));
    assert.ok(
      section.includes('planner-reversibility.md'),
      'the thinking model must point at planner-reversibility.md as the taxonomy owner',
    );
  });

  test('plan-md.md and planner-reversibility.md agree on the canonical tag spelling', () => {
    assert.ok(read(PLAN_MD_DOC).includes('<reversibility'), 'plan-md.md must spell <reversibility');
    assert.ok(read(REVERSIBILITY_REF).includes('<reversibility'), 'planner-reversibility.md must spell <reversibility');
  });

  test('every surface naming a rating uses the same three values', () => {
    const surfaces = {
      'planner-reversibility.md': read(REVERSIBILITY_REF),
      'plan-md.md': read(PLAN_MD_DOC),
      'context.md template': read(DISCUSS_CONTEXT_TEMPLATE),
    };
    for (const [name, text] of Object.entries(surfaces)) {
      for (const rating of RATINGS) {
        assert.ok(namesRating(text, rating), `${name} must name the "${rating}" rating`);
      }
    }
  });
});

// ─── Untrusted-input boundary on the rationale (ADR-1577) ───────────────────
//
// The rationale originates in conversation and flows CONTEXT.md -> planner ->
// PLAN.md -> executor, each hop an LLM reading the previous hop's output. Both
// authoring surfaces must say the text is data, and must name the closing-tag
// hazard specifically — a rationale that terminates its own element injects
// sibling structure the executor reads as real tasks.

describe('#1951 rationale is treated as untrusted data', () => {
  test('reference file forbids following directives inside a rationale', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /never follow[^\n]*directives|rationale is data, never instructions/i,
      'planner-reversibility.md must state a rationale is data, not instructions to follow',
    );
  });

  test('reference file names the closing-tag injection hazard', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.ok(
      ref.includes('</reversibility>'),
      'planner-reversibility.md must name the </reversibility> early-termination hazard explicitly',
    );
  });

  test('reference file cites the untrusted-input boundary standard', () => {
    const ref = read(REVERSIBILITY_REF);
    assert.match(
      ref,
      /ADR-1577|untrusted-input-boundary/,
      'the guidance must cite the repo standard (ADR-1577 / untrusted-input-boundary.md), not invent its own',
    );
  });

  test('discuss-phase template carries the same boundary instruction', () => {
    const tpl = read(DISCUSS_CONTEXT_TEMPLATE);
    assert.match(
      tpl,
      /never as an instruction|as data, never/i,
      'context.md template must instruct the discuss agent to record the rationale as data',
    );
    assert.ok(
      tpl.includes('</reversibility>'),
      'context.md template must name the plan-tag stripping requirement explicitly',
    );
  });
});

// ─── No content loss from the planner extraction ────────────────────────────
//
// Making room under the agent cap relocated the checkpoint DO/DON'T guidance
// into planner-antipatterns.md (already @-referenced by gsd-planner.md, so the
// planner still loads it). Guard that the relocation preserved the guidance
// rather than dropping it.

describe('#1951 planner checkpoint guidance survived the extraction', () => {
  test('relocated DO/DON\'T guidance lives in planner-antipatterns.md', () => {
    const ref = read(ANTIPATTERNS_REF);
    for (const phrase of [
      'Automate everything before',
      'mix multiple verifications',
      'before automation completes',
    ]) {
      assert.ok(
        ref.includes(phrase),
        `planner-antipatterns.md must carry the relocated guidance: "${phrase}"`,
      );
    }
  });

  test('gsd-planner.md still reaches that guidance via its @-reference', () => {
    assert.ok(
      read(PLANNER).includes('planner-antipatterns.md'),
      'gsd-planner.md must keep the @-reference that loads the relocated guidance',
    );
  });
});
