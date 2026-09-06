
/**
 * Remediation binding-ness across the revision contract (#3771).
 *
 * The remediation channel used to fuse "what property failed" with "how to fix it"
 * into a single `fix_hint` and never said which half binds. The checker rendered
 * every hint under a "must fix" heading, the orchestrators injected the issues
 * verbatim and ordered targeted updates, and the shared revision references mapped
 * each hint to a prescriptive strategy. A contract-following planner therefore
 * applied a hint literally even when a smaller mechanism satisfied the same
 * property, or when the hint contradicted a locked decision — with no channel to
 * report the conflict, and each attempt burning a revision iteration.
 *
 * ## What this suite locks
 *
 * The separation, at every link in the chain that carries it:
 *   - checker side  — `required_property` + evidence + severity bind; `fix_hint` is
 *     marked non-binding, including in the human-facing blocker rendering
 *   - planner side  — constraints are re-checked before editing, a smaller
 *     mechanism counts as addressing, and conflicts return `REVISION_CONFLICT`
 *   - orchestrators — the conflict is routed to the user or to the configured
 *     convergence loop WITHOUT consuming retry budget
 *   - field naming  — the generic pattern and the plan-checker schema agree on
 *     `fix_hint`; `suggested_fix` is retired
 *
 * It also pins what must NOT have been weakened: blockers still block, severity
 * still gates, the iteration caps and stall escalation still fire.
 *
 * ## What it cannot prove
 *
 * That a model acts on the text. The subject is a set of LLM prompts; no test in
 * this repo can prove behavior for the checker's other dimensions either. Stated so
 * the coverage claim is honest rather than implied.
 *
 * Multi-line phrases are asserted against a whitespace-normalized copy (`flat`), which
 * is CRLF-tolerant and survives a re-wrap of the same words — the runtime loads these
 * files whole, including on a checkout that produced CRLF.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Project rules: temp dirs and their removal go through the shared helpers (cleanup carries the
// Windows-EBUSY retry budget), and every synchronous spawn is bounded.
const { createTempDir, cleanup } = require('./helpers.cjs');

// runConflictGate()/withReviews() spawn bash against a Node-native temp path built by
// createTempDir(); on win32 that path is backslash-separated and handed to Git Bash, which
// is not guaranteed present on every runner (DEFECT.WINDOWS-TEST-PORTABILITY). POSIX-sh
// execution semantics of the extracted gate are proven on the POSIX lanes.
const IS_WINDOWS = process.platform === 'win32';

/** Bound for the extracted-gate subprocess: it runs one grep over a small fixture. */
const GATE_TIMEOUT_MS = 30_000;

const ROOT = path.join(__dirname, '..');

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

/**
 * Collapse every whitespace run to one space. Multi-line phrases are asserted against
 * this form so a re-wrap of the prose — which changes nothing the runtime reads — cannot
 * red the suite, while the words themselves stay pinned. CRLF folds out here too.
 */
const flat = (content) => content.replace(/\s+/g, ' ');

const PLAN_CHECKER = read('agents', 'gsd-plan-checker.md');
const UI_CHECKER = read('agents', 'gsd-ui-checker.md');
const PLANNER_REVISION = read('gsd-core', 'references', 'planner-revision.md');
const REVISION_LOOP = read('gsd-core', 'references', 'revision-loop.md');
const FEW_SHOT = read('gsd-core', 'references', 'few-shot-examples', 'plan-checker.md');
const PLAN_PHASE = read('gsd-core', 'workflows', 'plan-phase.md');
const QUICK_LOOP = read('gsd-core', 'workflows', 'quick', 'steps', 'plan-checker-loop.md');
const QUICK_BATCH_LOOP = read('gsd-core', 'workflows', 'quick-batch', 'steps', 'plan-checker-loop.md');
const UI_PHASE = read('gsd-core', 'workflows', 'ui-phase.md');
const DIAGNOSE = read('gsd-core', 'workflows', 'diagnose-issues.md');
const CONVERGENCE = read('gsd-core', 'workflows', 'plan-review-convergence.md');
const VERIFY_WORK = read('gsd-core', 'workflows', 'verify-work.md');
const PLANNER = read('agents', 'gsd-planner.md');
const UI_RESEARCHER = read('agents', 'gsd-ui-researcher.md');
const CONTRACTS = read('gsd-core', 'references', 'agent-contracts.md');
const REVIEW = read('gsd-core', 'workflows', 'review.md');
const COMMANDS = read('docs', 'COMMANDS.md');

// ── Helpers ────────────────────────────────────────────────────────

/**
 * The convergence conflict gate, extracted from the workflow and RUN.
 *
 * Everything else in this suite asserts on prose. That is the right instrument for a prompt,
 * but this one block is real shell that an orchestrator executes, and it has been wrong four
 * times — a heading-truncated scan, a laundered read error, an inverted status, and a global
 * line-shape scan that let raw reviewer text forge blocking state.
 * Every one of those passed the text assertions that existed at the time. So this block gets
 * executed against fixtures instead of read.
 *
 * Located by content (the fence containing the OPEN_CONFLICTS assignment), not by line number,
 * so re-ordering the document cannot silently point this at the wrong block.
 */
function extractConflictGate() {
  const fences = CONVERGENCE.split(/```/);
  const block = fences.find((f) => /^bash\r?\n/.test(f) && /OPEN_CONFLICTS=\$\(awk/.test(f));
  assert.ok(block, 'could not find the bash fence containing the OPEN_CONFLICTS gate');
  return block.replace(/^bash\r?\n/, '');
}

/** Run the extracted gate with REVIEWS_FILE set. Returns { status, stdout, stderr }. */
function runConflictGate(reviewsFile) {
  const dir = createTempDir('gsd-3771-gate-');
  try {
    const script = path.join(dir, 'gate.sh');
    fs.writeFileSync(script, `${extractConflictGate()}\nprintf '%s' "\${OPEN_CONFLICTS}"\n`);
    try {
      const stdout = execFileSync('bash', [script], {
        env: { ...process.env, REVIEWS_FILE: reviewsFile },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GATE_TIMEOUT_MS,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  } finally {
    cleanup(dir);
  }
}

/**
 * The writer-side sanitize+insert gate (#3916), extracted from plan-phase.md and RUN —
 * same rationale as `extractConflictGate` above: this is real shell an orchestrator
 * executes, not prose an LLM applies by hand, so it is proven against fixtures.
 * Located by content (the fence assigning `LINE="- [ ] REVISION_CONFLICT`).
 */
function extractWriterGate() {
  const fences = PLAN_PHASE.split(/```/);
  const block = fences.find((f) => /^bash\r?\n/.test(f) && /LINE="- \[ \] REVISION_CONFLICT/.test(f));
  assert.ok(block, 'could not find the bash fence containing the writer-side sanitize+insert gate');
  return block.replace(/^bash\r?\n/, '');
}

/** Run the writer gate against `reviewsFile` with the five conflict fields as env. Mutates the file. */
function runWriterGate(reviewsFile, fields) {
  const dir = createTempDir('gsd-3916-writer-');
  try {
    const script = path.join(dir, 'writer.sh');
    fs.writeFileSync(script, extractWriterGate());
    try {
      execFileSync('bash', [script], {
        env: {
          ...process.env,
          CONVERGENCE_ENABLED: 'true',
          REVIEWS_FILE: reviewsFile,
          CONFLICT_DIMENSION: fields.dimension ?? '',
          CONFLICT_PLAN: fields.plan ?? '',
          CONFLICT_PROPERTY: fields.property ?? '',
          CONFLICT_CONSTRAINT: fields.constraint ?? '',
          CONFLICT_ALTERNATIVES: fields.alternatives ?? '',
        },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GATE_TIMEOUT_MS,
      });
      return { status: 0 };
    } catch (err) {
      return { status: err.status, stderr: err.stderr || '' };
    }
  } finally {
    cleanup(dir);
  }
}

/**
 * The close-on-resolve gate (#3916 adversarial-review fix, redesigned in round 4 to match by
 * CONFLICT_DIMENSION/CONFLICT_PLAN identity instead of the full sanitized line -- an agent
 * re-deriving five sanitized fields byte-for-byte across a multi-minute subagent dispatch is far
 * more failure-prone than re-supplying two short identifiers it already tracks), extracted from
 * plan-phase.md's `**Otherwise (revised plans...` branch and RUN. Located by content (the fence
 * assigning `PREFIX="- [ ] REVISION_CONFLICT`).
 */
function extractCloseGate() {
  const fences = PLAN_PHASE.split(/```/);
  const block = fences.find((f) => /^bash\r?\n/.test(f) && /PREFIX="- \[ \] REVISION_CONFLICT/.test(f));
  assert.ok(block, 'could not find the bash fence containing the close-on-resolve gate');
  return block.replace(/^bash\r?\n/, '');
}

/** Run the close gate against `reviewsFile`, closing the open `dimension`/`plan` conflict with `resolution`. */
function runCloseGate(reviewsFile, dimension, plan, resolution) {
  const dir = createTempDir('gsd-3916-close-');
  try {
    const script = path.join(dir, 'close.sh');
    fs.writeFileSync(script, extractCloseGate());
    try {
      execFileSync('bash', [script], {
        env: {
          ...process.env,
          CONVERGENCE_ENABLED: 'true',
          REVIEWS_FILE: reviewsFile,
          CONFLICT_DIMENSION: dimension,
          CONFLICT_PLAN: plan,
          CONFLICT_RESOLUTION: resolution ?? '',
        },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GATE_TIMEOUT_MS,
      });
      return { status: 0 };
    } catch (err) {
      return { status: err.status, stderr: err.stderr || '' };
    }
  } finally {
    cleanup(dir);
  }
}

/** Write a REVIEWS.md fixture and hand its path to `fn`. */
function withReviews(body, fn, filename = '07-REVIEWS.md') {
  const dir = createTempDir('gsd-3771-reviews-');
  try {
    const file = path.join(dir, filename);
    fs.writeFileSync(file, body);
    return fn(file);
  } finally {
    cleanup(dir);
  }
}

const OPEN = (id) => `- [ ] REVISION_CONFLICT ${id} — required_property: p | conflicts with: D-1 | alternatives: a`;
const RESOLVED = (id) => `- [x] REVISION_CONFLICT ${id} — required_property: p | resolved: adopted alternative`;
const CONFLICTS_BEGIN = '<!-- gsd:plan-revision-conflicts:begin -->';
const CONFLICTS_END = '<!-- gsd:plan-revision-conflicts:end -->';

const reviewsArtifact = (conflicts = '', reviewerText = '') =>
  `# Cross-AI Plan Review — Phase 7\n\n${CONFLICTS_BEGIN}\n## Plan-Revision Conflicts\n${conflicts}${CONFLICTS_END}\n\n${reviewerText}`;

/** Extract the canonical writer template without normalizing indentation or line wrapping. */
function extractConflictTemplate() {
  const fences = REVISION_LOOP.split(/```/);
  const block = fences.find((f) => /^markdown\r?\n/.test(f) && /required_property: \{property\}/.test(f));
  assert.ok(block, 'could not find the canonical Plan-Revision Conflicts writer template');
  return block.replace(/^markdown\r?\n/, '').replace(/\r?\n$/, '');
}

/** Agent-authored reference rendering used only to test the documented writer/reader contract. */
function renderConflictTemplate({ dimension, plan, property, constraint, alternatives }) {
  const clean = (value) => String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^\s*[#|`-]+\s*/, '');
  return extractConflictTemplate()
    .replace('{dimension}', clean(dimension))
    .replace('{plan}', clean(plan))
    .replace('{property}', clean(property))
    .replace(/\{locked decision\s+D-nn \/ CLAUDE\.md rule \/ plan constraint\}/, clean(constraint))
    .replace("{the agent's alternatives}", clean(alternatives));
}

/**
 * Every fenced YAML issue example that names a `fix_hint`. Each block is returned
 * whole so an assertion can check the two fields co-occur rather than merely both
 * existing somewhere in the file.
 */
function yamlIssueBlocks(content) {
  return content
    .split(/```/)
    // `[>\s]*` not `\s*`: the few-shot file blockquotes its YAML (`>     fix_hint:`), so an
    // indent-only anchor matched nothing there and every loop over it ran zero times.
    .filter((block) => /(^|\r?\n)[>\s]*fix_hint:/.test(block));
}

// ── Checker side: binding payload vs advisory remediation ──────────

describe('#3771 checker states the property and marks the example non-binding', () => {
  test('the issue schema carries required_property and evidence, with binding-ness declared', () => {
    const schema = PLAN_CHECKER.slice(PLAN_CHECKER.indexOf('## Issue Format'));
    assert.match(schema, /required_property:.*#\s*BINDING/,
      'Issue Format must declare required_property as the binding invariant');
    assert.match(schema, /description:.*#\s*BINDING.*evidence/i,
      'Issue Format must declare description as the binding evidence field');
    assert.match(schema, /fix_hint:.*#\s*NON-BINDING/,
      'Issue Format must declare fix_hint as non-binding');
  });

  test('a smaller mechanism counts as addressing, and a conflicting hint is never authored', () => {
    assert.match(PLAN_CHECKER, /smaller or different mechanism has addressed the issue in full/,
      'the checker must concede that a smaller valid mechanism fully addresses the issue');
    assert.match(flat(PLAN_CHECKER), /Never author a `fix_hint` you can see contradicts/,
      'the checker must not emit remediation that contradicts a constraint it can see');
  });

  test('every YAML issue example carries required_property alongside its fix_hint', () => {
    const blocks = yamlIssueBlocks(PLAN_CHECKER);
    assert.ok(blocks.length >= 15, `expected the dimension examples to be present, found ${blocks.length}`);
    for (const block of blocks) {
      assert.match(
        block,
        /(^|\r?\n)[>\s]*required_property:/,
        `issue example names fix_hint but no required_property:\n${block.trim().slice(0, 240)}`
      );
    }
  });

  test('progressive-disclosure issue examples carry the same binding schema', () => {
    const examplesPath = path.join(
      ROOT,
      'gsd-core',
      'references',
      'plan-checker-examples.md'
    );
    assert.ok(
      fs.existsSync(examplesPath),
      'the current-base plan-checker examples reference must be present after integration'
    );
    const blocks = yamlIssueBlocks(fs.readFileSync(examplesPath, 'utf-8'));
    assert.ok(blocks.length > 0, 'the progressive-disclosure reference must contain an issue example');
    for (const block of blocks) {
      assert.match(
        block,
        /(^|\r?\n)[>\s]*required_property:/,
        `progressive-disclosure issue example lacks required_property:\n${block.trim().slice(0, 200)}`
      );
    }
  });

  test('the blocker rendering names the property, not the example, as what must be fixed', () => {
    assert.match(
      PLAN_CHECKER,
      /### Blockers — these properties must hold \("must fix" is the property, never the example\)/,
      '"must fix" must unambiguously refer to the required property'
    );
    assert.match(PLAN_CHECKER, /- Evidence: \{description\}/,
      'the blocker rendering must surface the evidence');
    assert.match(
      PLAN_CHECKER,
      /- Example fix \(non-binding — any mechanism reaching the property counts\): \{fix_hint\}/,
      'the blocker rendering must label the hint non-binding at the point of display'
    );
    assert.doesNotMatch(PLAN_CHECKER, /(^|\r?\n)- Fix: \{fix_hint\}/,
      'the bare "Fix: {fix_hint}" rendering reads as a prescription and must be gone');
  });

  test('the adversarial stance requires the property and evidence, not just severity', () => {
    assert.match(
      flat(PLAN_CHECKER),
      /Neither are issues without a `required_property`/,
      'a missing required_property must invalidate the finding the same way a missing severity does'
    );
  });

  test('the success checklist gates on the binding/advisory split', () => {
    assert.match(
      flat(PLAN_CHECKER),
      /binding `required_property` \+ evidence \+ severity, with `fix_hint` rendered as a non-binding example/,
      'success_criteria must require the split, or the checker is never told to produce it'
    );
  });

  test('the calibration examples model the split and a smaller-alternative acceptance', () => {
    assert.doesNotMatch(FEW_SHOT, /suggested_fix|(^|\n)>?\s*finding:|affected_field/,
      'few-shot examples must use the plan-checker schema field names, not the drifted ones');
    const fewShotBlocks = yamlIssueBlocks(FEW_SHOT);
    assert.ok(fewShotBlocks.length >= 3,
      `expected the few-shot issue examples to be found, got ${fewShotBlocks.length} — ` +
      'a zero here means the block filter stopped matching, not that the file is clean');
    for (const block of fewShotBlocks) {
      assert.match(block, /(^|\r?\n)[>\s]*required_property:/,
        `few-shot issue example lacks required_property:\n${block.trim().slice(0, 200)}`);
    }
    // The smaller-alternative rule is NOT demonstrated here on purpose: this file is the
    // CHECKER's calibration set, fixed by tests/few-shot-calibration.test.cjs at 2 positive +
    // 2 negative, and the rule is about what the PLANNER may do with a hint. It is normative in
    // the checker and in planner-revision.md, and pinned by the assertions in this suite.
    assert.match(flat(FEW_SHOT), /because the binding payload is the property rather than the example, the planner may satisfy it a different way/,
      'the calibration commentary must still teach that the hint does not bind');
  });
});

// ── Planner side: re-check, smaller alternative, conflict channel ───

describe('#3771 revision re-checks constraints and has a conflict path', () => {
  test('constraints are re-read before any edit', () => {
    const stepAt = PLANNER_REVISION.indexOf('### Step 2.5');
    assert.ok(stepAt > 0, 'a constraint re-check step must exist before Step 3');
    const step = PLANNER_REVISION.slice(stepAt);
    assert.match(step, /Locked decisions in CONTEXT\.md/, 'locked decisions must be re-checked');
    assert.match(step, /capability \/ project guidance/i, 'capability guidance must be re-checked');
    assert.match(step, /Constraints the existing plans already encode/, 'plan constraints must be re-checked');
  });

  test('binding-ness of each field is stated to the planner', () => {
    assert.match(flat(PLANNER_REVISION), /`fix_hint` is \*\*one example\*\*/,
      'the planner must be told the hint is an example');
    assert.match(
      flat(PLANNER_REVISION),
      /Never treat the absence of the field as licence to apply `fix_hint` literally/,
      'an older checker return without required_property must not fall back to literal application'
    );
  });

  test('a smaller sufficient mechanism is preferred and reported as addressed', () => {
    assert.match(flat(PLANNER_REVISION), /must be reported as addressed, naming the property satisfied and the mechanism used/);
  });

  // A marker four workflows dispatch on must be declared and emitted where the agent is
  // defined, not only in the shared reference — otherwise nothing produces what they match.
  test('the producing agents declare and emit REVISION_CONFLICT', () => {
    for (const [name, agent] of [['gsd-planner', PLANNER], ['gsd-ui-researcher', UI_RESEARCHER]]) {
      assert.match(agent, /```markdown\r?\n## REVISION_CONFLICT/,
        `${name} must emit the marker in-fence, or check:contract-drift reports an orphan consumer`);
    }
    const plannerRow = CONTRACTS.split(/\r?\n/).find((l) => l.startsWith('| gsd-planner |'));
    const uiRow = CONTRACTS.split(/\r?\n/).find((l) => l.startsWith('| gsd-ui-researcher |'));
    assert.ok(plannerRow && uiRow, 'both registry rows must exist');
    for (const [name, row] of [['gsd-planner', plannerRow], ['gsd-ui-researcher', uiRow]]) {
      assert.match(row, /`## REVISION_CONFLICT`/, `${name}'s registry row must declare the marker`);
    }
    for (const consumer of ['quick/steps/plan-checker-loop.md', 'verify-work.md']) {
      assert.ok(plannerRow.includes(consumer),
        `gsd-planner's Consumed by must list ${consumer} — it dispatches on the marker`);
    }
  });

  test('conflicts return REVISION_CONFLICT carrying conflicts and alternatives', () => {
    assert.match(PLANNER_REVISION, /## REVISION_CONFLICT/);
    const block = PLANNER_REVISION.slice(PLANNER_REVISION.indexOf('### Step 7b'));
    assert.match(block, /### Alternatives Considered/, 'the conflict must carry alternatives');
    assert.match(block, /Conflicts with/, 'the conflict must name what it conflicts with');
    assert.match(block, /it does not count as a failed revision iteration/,
      'a conflict must not consume retry budget');
  });

  test('the completion checklist accepts a smaller mechanism and rejects conflicting application', () => {
    const checklist = PLANNER_REVISION.slice(PLANNER_REVISION.indexOf('### Step 5: Validate Changes'));
    assert.match(checklist, /smaller\/different mechanism \(both count as addressed\)/);
    assert.match(checklist, /No `fix_hint` applied that contradicts a locked decision/);
    assert.doesNotMatch(checklist, /- \[ \] All flagged issues addressed\r?\n/,
      'the old "all flagged issues addressed" line implies literal application and must be replaced');
  });
});

// ── Generic pattern: naming reconciled, literal-application removed ─

describe('#3771 generic revision pattern carries the same separation', () => {
  test('the field list matches the plan-checker schema', () => {
    assert.match(flat(REVISION_LOOP), /`plan`, `dimension`, `severity`, `required_property`, `description`, `task`, `fix_hint`/,
      'the generic pattern must advertise exactly the plan-checker schema');
  });

  test('BLOCKERs are satisfied by property, not by literal application of the hint', () => {
    assert.doesNotMatch(REVISION_LOOP, /For each BLOCKER: make the required change/,
      '"make the required change" orders the example applied and must be gone');
    assert.match(REVISION_LOOP, /For each BLOCKER: make required_property true/);
    assert.match(REVISION_LOOP, /a smaller or different mechanism that makes the same property true/);
  });

  test('the conflict return is handled before the iteration counter and stall check', () => {
    const section = REVISION_LOOP.slice(REVISION_LOOP.indexOf('### Conflict Return'));
    assert.ok(section.length > 0, 'the pattern must define a conflict return');
    assert.match(section, /has not failed and has not stalled/);
    assert.match(flat(section), /Do NOT increment the iteration counter and do NOT update `prev_issue_count`/);
    assert.match(flat(REVISION_LOOP), /The increment is step g, AFTER the producing agent returns/,
      'the canonical flow must place the increment on the return path, or the rule above is unreachable');
    assert.doesNotMatch(flat(REVISION_LOOP), /a\. iteration \+= 1/,
      'the pre-dispatch increment is the ordering defect and must be gone');
    assert.match(flat(section), /Accepting the output with the blocker still open is NOT offered here/,
      'the conflict gate must not become an early exit from a blocker');
  });

  test('the shared contract does not describe a hand-off that no workflow performs', () => {
    assert.match(flat(REVISION_LOOP), /recording is in addition to asking, never instead of it/,
      'after #3771 round 2 no workflow hands a conflict to a loop and returns');
    assert.doesNotMatch(flat(REVISION_LOOP), /it may route there instead of asking directly/,
      'the superseded routing description must not survive as drift');
  });

  // The conflict text is agent-authored and lands inside a writer-owned slot. Newlines are
  // still a trust boundary: an embedded record-shaped line could forge an extra blocker.
  test('agent-authored conflict text is sanitized at the write boundary', () => {
    assert.match(flat(REVISION_LOOP), /Sanitize before writing — the conflict text is agent-authored/,
      'the shared protocol must sanitize where the untrusted text enters the file');
    assert.match(flat(REVISION_LOOP), /collapse every newline and tab to a single space, and strip any leading `#`/,
      'the rule must name the exact transform, or it is advice rather than a control');
    assert.match(flat(REVISION_LOOP), /embedded newline can forge an extra conflict-shaped record inside the owned slot/,
      'the contract must state the concrete forgery sanitization prevents');
    assert.match(flat(PLAN_PHASE), /Sanitize-then-insert is real shell/,
      'the workflow that does the appending must run the rule, not restate it as prose (#3916)');
    for (const [name, agent] of [['planner-revision', PLANNER_REVISION], ['gsd-ui-researcher', UI_RESEARCHER]]) {
      assert.match(flat(agent), /\*\*Every field is one line of plain text\.\*\*/,
        `${name} must forbid the shapes the writer would otherwise have to strip`);
    }
    assert.match(flat(CONVERGENCE), /reader counts only the first fixed slot at that position/,
      'the reader must state the ownership boundary that excludes raw reviewer text');
  });

  // A missing or non-file artifact must never read as "no conflicts".
  // Unverifiable is not the same as clean.
  test('the convergence gate fails CLOSED when it cannot read or parse REVIEWS.md', () => {
    assert.match(CONVERGENCE, /if \[ ! -f "\$\{REVIEWS_FILE\}" \]; then/,
      'the gate must require a regular file before trusting a count of zero');
    assert.match(flat(CONVERGENCE), /Refusing to declare convergence on an unverifiable gate/,
      'an unreadable or malformed gate input must block, not pass');
    assert.match(CONVERGENCE, /OPEN_CONFLICTS=\$\(awk/,
      'the executable reader must parse the owned slot');
    assert.match(CONVERGENCE, /awk_status=\$\?/,
      'a parser failure must remain distinguishable from a legitimate zero');
    assert.doesNotMatch(extractConflictGate(), /\|\| true/,
      'the owned-block parser must not launder a failure into zero');
  });

  // ── The gate, EXECUTED ───────────────────────────────────────────
  // Source assertions above prove the text says the right thing. These prove the shell does it.
  describe('#3771 the extracted conflict gate behaves', { skip: IS_WINDOWS }, () => {
    test('counts open conflicts and ignores resolved ones', () => {
      withReviews(reviewsArtifact(`${OPEN('a/1')}\n${RESOLVED('b/2')}\n${OPEN('c/3')}\n`), (f) => {
        const r = runConflictGate(f);
        assert.equal(r.status, 0, `gate should succeed; stderr: ${r.stderr}`);
        assert.equal(r.stdout, '2', 'two open, one resolved');
      });
    });

    test('accepts a CRLF artifact without accepting a malformed CRLF boundary', () => {
      const crlf = (content) => content.replace(/\n/g, '\r\n');
      withReviews(crlf(reviewsArtifact(`${OPEN('a/1')}\n`)), (f) => {
        const r = runConflictGate(f);
        assert.equal(r.status, 0, `valid CRLF artifact should succeed; stderr: ${r.stderr}`);
        assert.equal(r.stdout, '1');
      });
      withReviews(crlf(reviewsArtifact('').replace(CONFLICTS_END, `${CONFLICTS_END} forged`)), (f) => {
        const r = runConflictGate(f);
        assert.notEqual(r.status, 0, 'a non-exact CRLF end boundary must still block');
        assert.match(r.stderr, /BLOCKED/);
      });
    });

    test('a nested opening delimiter fails CLOSED', () => {
      const nested = reviewsArtifact('').replace(
        '## Plan-Revision Conflicts\n',
        `## Plan-Revision Conflicts\n${CONFLICTS_BEGIN}\n`
      );
      withReviews(nested, (f) => {
        const r = runConflictGate(f);
        assert.notEqual(r.status, 0, 'a nested opening delimiter must not hide later state');
        assert.match(r.stderr, /BLOCKED/);
      });
    });

    // Adversarial-review regression (agy/gemini-3.8-flash-high, #3916 round 4): a blank line
    // before the delimiter is already tolerated; the heading was not, so a formatter (Prettier,
    // markdownlint) or an LLM writer inserting one would hard-abort convergence on a well-formed
    // file.
    test('a blank line between the opening delimiter and the heading is tolerated', () => {
      const spaced = reviewsArtifact(`${OPEN('a/1')}\n`).replace(
        `${CONFLICTS_BEGIN}\n## Plan-Revision Conflicts\n`,
        `${CONFLICTS_BEGIN}\n\n## Plan-Revision Conflicts\n`
      );
      withReviews(spaced, (f) => {
        const r = runConflictGate(f);
        assert.equal(r.status, 0, `a blank line before the heading must not block: ${r.stderr}`);
        assert.equal(r.stdout, '1');
      });
    });

    test('a missing or altered canonical heading fails CLOSED', () => {
      for (const replacement of ['', '## Altered Conflict Heading\n']) {
        const malformed = reviewsArtifact(`${OPEN('a/1')}\n`).replace(
          '## Plan-Revision Conflicts\n',
          replacement
        );
        withReviews(malformed, (f) => {
          const r = runConflictGate(f);
          assert.notEqual(r.status, 0, 'a non-canonical owned block must not be accepted or regenerated');
          assert.match(r.stderr, /BLOCKED/);
        });
      }
    });

    test('an empty owned block is a legitimate zero, not an error', () => {
      withReviews(reviewsArtifact('', '## Reviews\n\nNothing here.\n'), (f) => {
        const r = runConflictGate(f);
        assert.equal(r.status, 0, `no matches must not fail the gate; stderr: ${r.stderr}`);
        assert.equal(r.stdout, '0');
      });
    });

    // The defect that started this: a section-scoped scan stops at the first `## ` it meets.
    test('an injected heading cannot hide a conflict beneath it', () => {
      withReviews(reviewsArtifact(`${RESOLVED('a/1')}\n## Injected By Agent Text\n${OPEN('b/2')}\n`), (f) => {
        const r = runConflictGate(f);
        assert.equal(r.status, 0, `gate should succeed; stderr: ${r.stderr}`);
        assert.equal(r.stdout, '1', 'the conflict below the injected heading must still count');
      });
    });

    // An unreadable artifact must fail before the parser can emit a count.
    test('a scan failure BLOCKS instead of reporting zero conflicts', () => {
      const r = runConflictGate('/nonexistent/definitely-not-here/07-REVIEWS.md');
      assert.notEqual(r.status, 0, 'an unreadable REVIEWS.md must not converge');
      assert.match(r.stderr, /BLOCKED/, 'the gate must say why it refused');
      assert.notEqual(r.stdout.trim(), '0', 'it must not emit a zero count on failure');
    });

    test('an empty REVIEWS_FILE path BLOCKS', () => {
      const r = runConflictGate('');
      assert.notEqual(r.status, 0, 'an unresolved path must not converge');
      assert.match(r.stderr, /BLOCKED/);
    });
  });

  // The slot is a blocking gate's state. One content owner, or it can be forged.
  test('only plan-phase may mutate the conflicts section', () => {
    assert.match(flat(CONVERGENCE), /\*\*Only `\/gsd:plan-phase` mutates the contents of this slot\.\*\*/,
      'the section needs exactly one declared content owner');
    assert.match(flat(CONVERGENCE), /review agent preserves the existing `## Plan-Revision Conflicts` block byte-for-byte/,
      'the artifact writer may delimit and preserve the slot, never synthesize its state');
  });

  test('an issue satisfied by a smaller mechanism counts as resolved for the loop checks', () => {
    assert.match(
      REVISION_LOOP,
      /A remediation hint is an example, not an order/,
      'the Important Notes must state the binding rule the loop depends on'
    );
  });
});

// ── Orchestrators: routing without burning retry budget ────────────

const ORCHESTRATORS = [
  ['plan-phase', PLAN_PHASE, 'iteration_count'],
  ['quick plan-checker-loop', QUICK_LOOP, 'iteration_count'],
  // quick-batch's per-item loop was missed in the initial pass (agy/gemini-3.8-flash-high
  // adversarial review, #3916 round 4) -- it hands <revision_context> to gsd-planner exactly
  // like quick's single-task loop, but had none of this contract until that review caught it.
  ['quick-batch plan-checker-loop', QUICK_BATCH_LOOP, 'iteration_count'],
  ['ui-phase', UI_PHASE, 'revision_count'],
  // verify-work's gap-plan revision hands <revision_context> to gsd-planner, so it inherits the
  // contract whether or not it states it. It was missed in the first pass (#3771 round-2 review).
  ['verify-work gap-plan revision', VERIFY_WORK, 'iteration_count'],
];

describe('#3771 every revision orchestrator routes conflicts instead of retrying', () => {
  // plan-phase @-imports revision-loop.md, so the shared Conflict Return protocol really is in
  // its loaded context and it states only its own bindings. The other three do not import it and
  // must carry the rules inline. `loadedFor` is what the runtime actually puts in front of each
  // orchestrator — the honest surface to assert a shared rule against.
  const importsShared = (content) => /@~\/\.claude\/gsd-core\/references\/revision-loop\.md/.test(content);
  const loadedFor = (content) => (importsShared(content) ? flat(content + '\n' + REVISION_LOOP) : flat(content));

  test('plan-phase delegates the shared protocol rather than duplicating it', () => {
    assert.ok(importsShared(PLAN_PHASE), 'plan-phase must @-import the reference it defers to');
    assert.match(flat(PLAN_PHASE), /follow the shared Conflict Return protocol in `gsd-core\/references\/revision-loop\.md`/,
      'the delegation must be explicit, or the bindings have no protocol to bind to');
  });

  for (const [name, content, counter] of ORCHESTRATORS) {
    const loaded = loadedFor(content);

    test(`${name} tells the reviser the hint is non-binding`, () => {
      assert.match(loaded, /`fix_hint` is ONE non-binding example route/,
        `${name} must mark the remediation example non-binding in its revision prompt`);
      assert.match(loaded, /smaller or different mechanism reaching the same property/,
        `${name} must accept a smaller alternative`);
    });

    test(`${name} orders a constraint re-check before editing`, () => {
      assert.match(loaded, /BEFORE editing/,
        `${name} must order the constraint re-check before any edit`);
      assert.match(loaded, /return `## REVISION_CONFLICT` with the conflict and\s+the alternatives rather than applying or working around it/,
        `${name} must forbid applying a conflicting hint`);
    });

    // Four prompts state this contract; planner-revision.md is the authority they must agree
    // with. Each must name where that authority is, or the next editor updates one of five.
    test(`${name} names the authority its inline statement summarises`, () => {
      assert.match(loaded, /Full contract:\s+`gsd-core\/references\/planner-revision\.md`|see your `## Revision Conflict`\s+section/,
        `${name} must point at the contract its prompt paraphrases`);
    });

    test(`${name} routes REVISION_CONFLICT without consuming ${counter}`, () => {
      assert.match(loaded, /## REVISION_CONFLICT/,
        `${name} must handle the conflict return`);
      assert.match(
        loaded,
        new RegExp(`[Dd]o NOT increment (the iteration counter|\`?${counter}\`?)`),
        `${name} must not spend a revision iteration on an unresolvable conflict`
      );
    });

    // A counter incremented BEFORE dispatch is already spent when the conflict comes back, so
    // "do NOT increment" would be unreachable prose. The increment must sit on the return path.
    test(`${name} increments ${counter} on the return, not before dispatch`, () => {
      assert.doesNotMatch(
        flat(content),
        new RegExp(`- Increment \`${counter}\` - Re-spawn`),
        `${name} must not increment ${counter} before the reviser is dispatched`
      );
      assert.match(loaded, new RegExp(`(returns|return) [^.]*increment \`?${counter}\`?|increment \`?${counter}\`?, then re-spawn|Counter not spent: \`${counter}\``, 'i'),
        `${name} must increment ${counter} only once the reviser has returned`);
    });

    // Not incrementing the counter removes the bound the counter provided. Something must
    // replace it, or an agent returning the same conflict forever loops unattended.
    // Two bounds, because one is evadable: an agent alternating property names never trips the
    // repeat rule, so the repeat rule alone leaves the un-incremented path unbounded.
    test(`${name} bounds conflict recurrence so the un-incremented path cannot spin`, () => {
      assert.match(
        loaded,
        /same `required_property` (a second time in a row|twice in a row)/i,
        `${name} must detect a repeated conflict rather than re-spawning forever`
      );
      assert.match(
        loaded,
        /THIRD conflict return of this loop whatever property it names/,
        `${name} must cap TOTAL conflict returns — round-robin across property names evades the repeat rule`
      );
    });

    // The conflict gate resolves the conflict; it must not become an early exit from a blocker.
    test(`${name} re-evaluates a second conflict instead of falling through to the checker`, () => {
      assert.match(
        loaded,
        /re-evaluate (its|the [a-z]+'s|the) return (from the top of this handler|here)|return to this step/,
        `${name} must loop back on the re-spawn, not fall through to the checker spawn`
      );
    });

    test(`${name} does not offer accepting the output with the blocker still open`, () => {
      assert.match(
        loaded,
        /is NOT offered here/,
        `${name} must state that accepting an unaddressed blocker is not one of the conflict options`
      );
      assert.match(loaded, /amend the constraint/,
        `${name} must offer amending the constraint as the third resolving option`);
    });
  }

  test('plan-phase checker retry is explicitly the non-conflict return path', () => {
    const handler = PLAN_PHASE.slice(
      PLAN_PHASE.indexOf('**If the planner returns `## REVISION_CONFLICT`:**'),
      PLAN_PHASE.indexOf('## 12.5. Plan Bounce')
    );
    assert.match(
      handler,
      /\*\*Otherwise \(revised plans, not `## REVISION_CONFLICT`\):\*\*[\s\S]*?Spawn checker again \(step 10\), then increment `iteration_count`\./,
      'the normal checker path must be disjoint from the conflict re-entry path'
    );
    assert.doesNotMatch(handler, /\nAfter planner returns ->/,
      'an unconditional post-return instruction textually falls through from REVISION_CONFLICT');
  });

  test('plan-phase records the conflict on a channel it can actually test for', () => {
    assert.match(PLAN_PHASE, /workflow\.plan_review_convergence/,
      'plan-phase must consult the convergence config');
    assert.match(PLAN_PHASE, /REVIEWS_FILE="\$\{REVIEWS_PATH\}"/,
      'conflict persistence must use the path initialized by the workflow');
    assert.doesNotMatch(PLAN_PHASE, /REVIEWS_FILE=\$\(ls "\$\{PHASE_DIR\}"\/\*-REVIEWS\.md/,
      'a second glob lookup can select a different review artifact');
    assert.match(flat(PLAN_PHASE), /CONVERGENCE_ENABLED.*true.*\[ ! -f "\$\{REVIEWS_FILE\}" \].*BLOCKED: cannot persist plan-revision conflict/i,
      'enabled persistence must fail closed unless REVIEWS_PATH is a regular file');
    // #3916: a phase's FIRST revision cycle can hit REVISION_CONFLICT before any REVIEWS.md
    // exists, so REVIEWS_PATH is legitimately empty there — that must not hard-block the return.
    assert.match(flat(PLAN_PHASE), /CONVERGENCE_ENABLED.*true.*\[ -n "\$\{REVIEWS_FILE\}" \].*\[ ! -f "\$\{REVIEWS_FILE\}" \].*BLOCKED: cannot persist plan-revision conflict/i,
      'the hard-block must require a NON-EMPTY REVIEWS_FILE, or a brand-new phase with no reviews yet can never return a conflict at all');
    assert.match(flat(PLAN_PHASE), /plan-phase wrote the line, so plan-phase closes it/,
      'closure must have exactly one named owner, or a line can be orphaned open');
    assert.match(flat(REVISION_LOOP), /never invokes `\/gsd:plan-review-convergence`/,
      'plan-phase runs inside that loop; invoking it would be a cycle');
    // A markdown table cannot be counted by any simple filter — its header and separator rows
    // look like data. The recorded shape must be one the reader can match exactly.
    assert.match(flat(REVISION_LOOP), /A checkbox, not a table row/,
      'the recorded conflict must be countable without parsing a table');
    assert.match(REVISION_LOOP, /- \[ \] REVISION_CONFLICT \{dimension\}\/\{plan\} — required_property:/,
      'the shared protocol must define the open form the convergence gate matches');
    assert.match(flat(REVISION_LOOP), /owns flipping it to `- \[x\]`/,
      'the close step must produce the resolved form the gate excludes');
  });

  test('convergence gates on the conflicts BEFORE it writes state or prints success', () => {
    assert.match(CONVERGENCE, /## Plan-Revision Conflicts/,
      'the convergence loop must know about the section plan-phase writes');
    assert.match(CONVERGENCE, /OPEN_CONFLICTS=/,
      'the count must be read from REVIEWS.md — CYCLE_SUMMARY does not carry it');
    // The counter and writer must agree on both marker and ownership boundary.
    assert.match(CONVERGENCE, /in_owned && \/\^- \\\[ \\\] REVISION_CONFLICT \.\*required_property:\//,
      'the gate must count the conflict line shape only while inside the owned slot');
    assert.match(CONVERGENCE, /gsd:plan-revision-conflicts:begin/);
    assert.match(CONVERGENCE, /gsd:plan-revision-conflicts:end/);
    assert.doesNotMatch(CONVERGENCE, /grep -c/,
      'the superseded global scan would count raw reviewer text and must not return');
    assert.match(flat(CONVERGENCE), /escalates rather than deadlocking/,
      'the gate must state that an unresolvable conflict still terminates at MAX_CYCLES');
    assert.match(
      CONVERGENCE,
      /\*\*If HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0 and OPEN_CONFLICTS == 0 \(converged\):\*\*/,
      'an open conflict must be part of the converged CONDITION, not a note after the banner'
    );
    // Ordering is the whole finding: the gate placed after `state planned-phase` would write
    // and announce convergence over a conflict nobody resolved.
    const gateAt = CONVERGENCE.indexOf('OPEN_CONFLICTS=$(awk');
    const writeAt = CONVERGENCE.indexOf('gsd_run state planned-phase');
    const bannerAt = CONVERGENCE.indexOf('GSD ► CONVERGENCE COMPLETE');
    assert.ok(gateAt > 0 && writeAt > 0 && bannerAt > 0, 'all three anchors must exist');
    assert.ok(gateAt < writeAt, 'the conflict gate must precede the planned-phase state write');
    assert.ok(gateAt < bannerAt, 'the conflict gate must precede the convergence banner');
    assert.match(flat(CONVERGENCE), /Re-running the planner against an unchanged conflict cannot resolve it/,
      'the replan step must be told that re-running alone cannot clear a conflict');
  });

  test('quick does not advertise a convergence route it has no artifact for', () => {
    assert.match(flat(QUICK_LOOP), /A quick task has no REVIEWS\.md and no phase/,
      'quick must say why the convergence route does not apply, rather than dangling a dead branch');
  });

  test('the conflict is surfaced to the user with its alternatives', () => {
    for (const [name, content] of ORCHESTRATORS) {
      assert.match(loadedFor(content), /alternatives to the user|conflict and its alternatives to the user/,
        `${name} must present the alternatives rather than deciding silently`);
    }
  });
});

// ── UI-spec loop and the gap-plan hint ─────────────────────────────

describe('#3771 the UI-spec and gap-plan hints are marked non-binding too', () => {
  test('the UI checker states the property and marks its hint an example', () => {
    assert.match(UI_CHECKER, /\*\*`fix_hint` is an example, never an order\.\*\*/);
    assert.match(flat(UI_CHECKER), /reaches the same property by a smaller or different mechanism has resolved the issue in full/);
    const uiBlocks = yamlIssueBlocks(UI_CHECKER);
    assert.ok(uiBlocks.length >= 6, `expected the UI dimension examples, got ${uiBlocks.length}`);
    assert.doesNotMatch(UI_CHECKER, /exact fix required/,
      'the UI verdict must not order an exact fix — that is the prescription this fix removes');
    assert.match(flat(UI_CHECKER), /- \*\*Dimension \{N\} — \{name\}:\*\* \{required_property\} Evidence: \{description\} Example fix \(non-binding/,
      'the UI ISSUES FOUND rendering must name the property, its evidence, and a non-binding example');
    for (const block of uiBlocks) {
      assert.match(block, /(^|\r?\n)[>\s]*required_property:/,
        `UI checker issue example lacks required_property:\n${block.trim().slice(0, 200)}`);
    }
  });

  test('the UI-spec revision resolves listed issues rather than applying listed fixes', () => {
    assert.doesNotMatch(UI_PHASE, /fix ONLY the listed issues/,
      '"fix ONLY the listed issues" pairs with a prescriptive hint; it must read as resolve');
    assert.match(UI_PHASE, /resolve ONLY the listed issues/);
  });

  test('the gap-plan hint is bound to the root cause, not to the suggested direction', () => {
    assert.doesNotMatch(DIAGNOSE, /- suggested_fix: Hint for gap closure plan/,
      'the gap-closure hint must not read as the binding payload');
    assert.match(DIAGNOSE, /fix_hint: NON-BINDING example route for the gap closure plan/);
    assert.match(flat(DIAGNOSE), /the binding payload is `root_cause`/);
  });
});

// ── Preservation: nothing legitimately binding was weakened ────────

describe('#3771 preserves everything that legitimately binds', () => {
  test('blockers still block and severity still gates', () => {
    assert.match(PLAN_CHECKER, /Issues without a severity classification are not valid output/);
    assert.match(PLAN_CHECKER, /\*\*blocker\*\* - The `required_property` must hold before execution/);
    assert.match(PLAN_CHECKER, /\*\*BLOCKER\*\* — the phase goal will not be achieved if this is not fixed before execution/);
  });

  test('iteration caps and stall escalation still fire', () => {
    assert.match(REVISION_LOOP, /## Pattern: Check-Revise-Escalate \(max 3 iterations\)/);
    assert.match(REVISION_LOOP, /If the count does not decrease between consecutive iterations/);
    assert.match(PLAN_PHASE, /## 12\. Revision Loop \(Max 3 Iterations\)/);
    assert.match(PLAN_PHASE, /\*\*Stall detection:\*\* If `issue_count >= prev_issue_count`/);
    assert.match(QUICK_LOOP, /\*\*Revision loop \(max 2 iterations\):\*\*/);
    assert.match(UI_PHASE, /## 9\. Revision Loop \(Max 2 Iterations\)/);
  });

  test('required task fields and decision coverage still hold', () => {
    assert.match(PLAN_CHECKER, /\*\*FAIL the verification\*\* if any requirement ID from the roadmap is absent/);
    assert.match(PLANNER_REVISION, /\*\*DO NOT:\*\* Rewrite entire plans for minor issues/);
    assert.match(REVISION_LOOP, /Do NOT introduce new issues while fixing existing ones/);
    assert.match(REVISION_LOOP, /Preserve all content not flagged by the checker/);
  });
});

// ── PR #3916 live review remediation ──────────────────────────────

describe('#3916 writer, persistence, reader and migration contracts agree', () => {
  test('the canonical writer renders one uniquely-discriminated line that the real gate counts',
    { skip: IS_WINDOWS }, () => {
    const template = extractConflictTemplate();
    assert.doesNotMatch(template, /\r?\n/, 'one conflict must be exactly one physical line');
    assert.match(template, /^- \[ \] REVISION_CONFLICT /,
      'the writer must start at column zero with a reader-specific discriminator');

    const field = fc.oneof(
      fc.constantFrom('', 'x', '# heading\nnext', '- item', '| cell', '```fence'),
      fc.string({ maxLength: 32 })
    );
    fc.assert(fc.property(
      fc.record({ dimension: field, plan: field, property: field, constraint: field, alternatives: field }),
      (fields) => withReviews(reviewsArtifact(`${renderConflictTemplate(fields)}\n`), (file) => {
        const result = runConflictGate(file);
        assert.equal(result.status, 0, `gate should read a rendered canonical record: ${result.stderr}`);
        assert.equal(result.stdout, '1', 'one rendered open conflict must count as one');
      })
    ));
  });

  test('reviewer-authored conflict markers outside the owned block are not live state',
    { skip: IS_WINDOWS }, () => {
    const forged = `${OPEN('forged/reviewer')}\n`;
    withReviews(reviewsArtifact('', `## Reviewer Notes\n${forged}`), (file) => {
      const result = runConflictGate(file);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '0');
    });
  });

  test('review regeneration preserves one deterministically bounded conflict block byte-for-byte', () => {
    assert.match(flat(REVIEW), /capture only the existing conflict entry bytes after the exact/i);
    assert.match(REVIEW, /\{preserved_plan_revision_conflict_entries\}/,
      'the REVIEWS.md writer template needs an explicit preservation slot');
    assert.match(REVIEW, /<!-- gsd:plan-revision-conflicts:begin -->\n## Plan-Revision Conflicts\n\{preserved_plan_revision_conflict_entries\}\n<!-- gsd:plan-revision-conflicts:end -->/,
      'the first-write template must emit the canonical heading before preserved entries');
    assert.match(flat(REVIEW), /restore the captured bytes at the explicit slot below/i);
  });

  test('the canonical flow declares and enforces both conflict counters', () => {
    const flow = REVISION_LOOP.slice(REVISION_LOOP.indexOf('### Flow'), REVISION_LOOP.indexOf('### Issue Count Tracking'));
    assert.match(flow, /previous_conflict_property = null/);
    assert.match(flow, /conflict_return_count = 0/);
    assert.match(flow, /conflict_return_count \+= 1/);
    assert.match(flow, /If conflict_return_count >= 3/,
      'alternating properties must still hit the total-conflict cap');
    assert.doesNotMatch(flow, /same required_property[\s\S]*bounds this path/,
      'the repeat-only rule must not claim it bounds alternating conflicts');
    assert.match(flow, /Else: previous_conflict_property = current required_property[\s\S]*resolve it/,
      'a non-repeat resolution must advance the property compared by the next return');
  });

  test('persisted conflicts are idempotent records and reviews-mode replanning closes them', () => {
    assert.match(flat(REVISION_LOOP), /reuse the existing open line instead of appending a duplicate/i,
      'identical open state needs idempotency, not a second event identity');
    assert.match(flat(PLAN_PHASE), /before replanning from `--reviews`, scan `REVIEWS_PATH` for open plan-revision conflicts/i);
    const initAt = PLAN_PHASE.indexOf('REVIEWS_PATH=$(_gsd_field "$INIT" reviews_path)');
    const scanAt = PLAN_PHASE.indexOf('**If plans exist AND the `--reviews` flag is set:**');
    assert.ok(initAt > 0 && scanAt > 0, 'both REVIEWS_PATH initialization and reviews-mode scan must exist');
    assert.ok(initAt < scanAt, 'REVIEWS_PATH must be initialized before reviews-mode scans it');
    assert.match(flat(PLAN_PHASE), /flip the matching line to `- \[x\]` once the chosen resolution is applied/i);
  });

  test('REVIEWS_FILE is a quoted direct path and must be a regular file', () => {
    assert.match(CONVERGENCE, /REVIEWS_FILE="\$\{phase_dir\}\/\$\{padded_phase\}-REVIEWS\.md"/);
    assert.doesNotMatch(CONVERGENCE, /REVIEWS_FILE=\$\(ls \$\{phase_dir\}/,
      'word-splitting and glob expansion must not select the gate input');
    assert.match(CONVERGENCE, /\[ ! -f "\$\{REVIEWS_FILE\}" \]/,
      'directories and other readable non-files are not valid review artifacts');
  });

  test('a config query failure blocks persistence instead of reading as disabled', () => {
    assert.doesNotMatch(PLAN_PHASE, /config-get workflow\.plan_review_convergence 2>\/dev\/null \|\| echo "false"/);
    assert.match(flat(PLAN_PHASE), /BLOCKED: cannot read workflow\.plan_review_convergence/i);
  });

  test('the gate reads a literal-backslash POSIX filename without rewriting it',
    { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(`${OPEN('a/1')}\n`), (file) => {
      const result = runConflictGate(file);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '1');
    }, '07\\-REVIEWS.md');
    assert.doesNotMatch(CONVERGENCE, /tr '\\\\' '\/'/,
      'a quoted POSIX path is already exact; rewriting backslashes corrupts a valid filename');
  });

  test('the scope calibration stays inside a declared threshold band', () => {
    assert.match(PLAN_CHECKER, /tasks: 4\r?\n\s+files: 8/,
      'the warning is triggered by 4 tasks; its file count should remain in the 5-8 target band');
  });

  test('quick mode names locked decisions only when CONTEXT.md exists', () => {
    assert.match(QUICK_LOOP, /\$\{DISCUSS_MODE \? 'locked decisions in ' \+ quick_id \+ '-CONTEXT\.md, ' : ''\}capability guidance/);
  });

  test('the command docs include open conflicts in the exit condition', () => {
    const section = COMMANDS.slice(COMMANDS.indexOf('### `/gsd-plan-review-convergence`'));
    assert.match(flat(section), /open `## Plan-Revision Conflicts` entries.*must also be zero/i);
  });

  // The writer-side sanitize+insert step used to be a prose instruction for the
  // orchestrator LLM to apply by hand (flagged as Minor across two review rounds).
  // #3916 makes it real shell; these tests RUN it, composing with the existing
  // reader gate, so a regression here reds the suite instead of only the prose.
  test('the writer gate sanitizes hostile fields and the reader counts exactly one',
    { skip: IS_WINDOWS }, () => {
    const field = fc.oneof(
      fc.constantFrom('', 'x', '# heading\nnext', '- item', '| cell', '```fence', 'a\tb\nc'),
      fc.string({ maxLength: 32 })
    );
    fc.assert(fc.property(
      fc.record({ dimension: field, plan: field, property: field, constraint: field, alternatives: field }),
      (fields) => withReviews(reviewsArtifact(), (file) => {
        const before = fs.readFileSync(file, 'utf-8');
        const result = runWriterGate(file, fields);
        assert.equal(result.status, 0, `writer gate should succeed: ${result.stderr}`);
        const after = fs.readFileSync(file, 'utf-8');
        const added = after.slice(before.lastIndexOf(CONFLICTS_END));
        assert.doesNotMatch(added.replace(CONFLICTS_END, ''), /\r?\n.*\S/,
          'exactly one physical line must be inserted before the end delimiter');
        const reader = runConflictGate(file);
        assert.equal(reader.status, 0, reader.stderr);
        assert.equal(reader.stdout, '1', 'the reader must count the sanitized insert as one open conflict');
      })
    ));
  });

  test('the writer gate is idempotent on a repeated identical conflict',
    { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(), (file) => {
      const fields = { dimension: 'd', plan: 'p1', property: 'prop', constraint: 'D-1', alternatives: 'alt' };
      assert.equal(runWriterGate(file, fields).status, 0);
      assert.equal(runWriterGate(file, fields).status, 0);
      const reader = runConflictGate(file);
      assert.equal(reader.status, 0, reader.stderr);
      assert.equal(reader.stdout, '1', 'the same conflict recorded twice must not duplicate the line');
    });
  });

  test('the writer gate fails closed and leaves the file untouched when the owned slot is missing',
    { skip: IS_WINDOWS }, () => {
    withReviews('# Cross-AI Plan Review — Phase 7\n\nno owned slot here\n', (file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const fields = { dimension: 'd', plan: 'p1', property: 'prop', constraint: 'D-1', alternatives: 'alt' };
      const result = runWriterGate(file, fields);
      assert.notEqual(result.status, 0, 'a missing end delimiter must not silently succeed');
      assert.equal(fs.readFileSync(file, 'utf-8'), before,
        'a failed write must never partially mutate REVIEWS.md');
    });
  });

  // Adversarial-review regression (agy/gemini-3.8-flash-high, #3916): `awk -v line="$LINE"`
  // decodes a literal two-character `\n` in agent text into a real newline — a forgery `tr`
  // (which only touches actual control bytes) cannot catch. ENVIRON does not decode escapes.
  test('a literal backslash-n in agent text stays on one line (awk -v escape-decoding forgery)',
    { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(), (file) => {
      const fields = {
        dimension: 'dim with literal \\n mid-text', plan: 'p1', property: 'prop',
        constraint: 'D-1', alternatives: 'alt',
      };
      const result = runWriterGate(file, fields);
      assert.equal(result.status, 0, result.stderr);
      const reader = runConflictGate(file);
      assert.equal(reader.status, 0, reader.stderr);
      assert.equal(reader.stdout, '1', 'a literal backslash-n must not split the record into two lines');
    });
  });

  // Adversarial-review regression (#3916): a resolved conflict must actually get flipped to
  // `- [x]` in the SAME session that resolved it — nothing else in plan-phase revisits it, so
  // an unclosed record blocks convergence forever.
  test('the close gate flips a resolved conflict to [x] and the reader no longer counts it',
    { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(), (file) => {
      const fields = { dimension: 'd', plan: 'p1', property: 'prop', constraint: 'D-1', alternatives: 'alt' };
      assert.equal(runWriterGate(file, fields).status, 0);
      assert.equal(runConflictGate(file).stdout, '1');
      const result = runCloseGate(file, fields.dimension, fields.plan, 'adopted alternative');
      assert.equal(result.status, 0, result.stderr);
      const after = fs.readFileSync(file, 'utf-8');
      assert.match(after, /^- \[x\] REVISION_CONFLICT .*\| resolved: adopted alternative$/m);
      assert.doesNotMatch(after, /^- \[ \] REVISION_CONFLICT/m, 'no open line may survive a close');
      const reader = runConflictGate(file);
      assert.equal(reader.status, 0, reader.stderr);
      assert.equal(reader.stdout, '0', 'a closed conflict must no longer count as open');
    });
  });

  // Adversarial-review regression (agy/gemini-3.8-flash-high, #3916 round 4): with more than one
  // conflict open at once, closing by identity must touch only the matching record -- a design
  // that closed by a single remembered full-line string would drop whichever conflict it
  // overwrote last.
  test('the close gate with two open conflicts closes only the matching one', { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(`${OPEN('a/1')}\n${OPEN('b/2')}\n`), (file) => {
      const result = runCloseGate(file, 'a', '1', 'adopted alternative');
      assert.equal(result.status, 0, result.stderr);
      const after = fs.readFileSync(file, 'utf-8');
      assert.match(after, /^- \[x\] REVISION_CONFLICT a\/1 .*\| resolved: adopted alternative$/m);
      assert.match(after, /^- \[ \] REVISION_CONFLICT b\/2 /m, 'the unrelated open conflict must survive untouched');
      assert.equal(runConflictGate(file).stdout, '1', 'exactly one conflict must remain open');
    });
  });

  test('the close gate fails closed when the pending conflict line is not found',
    { skip: IS_WINDOWS }, () => {
    withReviews(reviewsArtifact(`${OPEN('a/1')}\n`), (file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const result = runCloseGate(file, 'never', 'written', 'x');
      assert.notEqual(result.status, 0, 'closing a conflict that was never recorded must not silently succeed');
      assert.equal(fs.readFileSync(file, 'utf-8'), before,
        'a failed close must never partially mutate REVIEWS.md');
    });
  });

  // Adversarial-review regression (#3916): the reader gate strips a trailing \r before
  // comparing lines; both writer-side awk gates did not, so a CRLF REVIEWS.md (a Windows
  // checkout) made every `$0 == ENVIRON[...]` comparison miss and fail closed forever.
  test('the writer gate matches the owned end delimiter on a CRLF REVIEWS.md', { skip: IS_WINDOWS }, () => {
    const crlf = (content) => content.replace(/\n/g, '\r\n');
    withReviews(crlf(reviewsArtifact()), (file) => {
      const fields = { dimension: 'd', plan: 'p1', property: 'prop', constraint: 'D-1', alternatives: 'alt' };
      const result = runWriterGate(file, fields);
      assert.equal(result.status, 0, `writer gate must match a CRLF end delimiter: ${result.stderr}`);
      assert.equal(runConflictGate(file).stdout, '1');
    });
  });

  test('the close gate matches the pending conflict line on a CRLF REVIEWS.md', { skip: IS_WINDOWS }, () => {
    const crlf = (content) => content.replace(/\n/g, '\r\n');
    withReviews(crlf(reviewsArtifact(`${OPEN('a/1')}\n`)), (file) => {
      const result = runCloseGate(file, 'a', '1', 'adopted alternative');
      assert.equal(result.status, 0, `close gate must match a CRLF-terminated open line: ${result.stderr}`);
      assert.equal(runConflictGate(file).stdout, '0');
    });
  });

  // Adversarial-review regression (#3916): the CRLF fix above must compare a CR-stripped COPY,
  // not mutate `$0` in place -- `sub(/\r$/, "")` on `$0` itself silently rewrites every
  // passed-through line's ending to LF on any insert or close, corrupting an unrelated file.
  test('the writer gate on a CRLF REVIEWS.md leaves unrelated lines CRLF-terminated', { skip: IS_WINDOWS }, () => {
    const crlf = (content) => content.replace(/\n/g, '\r\n');
    withReviews(crlf(reviewsArtifact()), (file) => {
      const fields = { dimension: 'd', plan: 'p1', property: 'prop', constraint: 'D-1', alternatives: 'alt' };
      assert.equal(runWriterGate(file, fields).status, 0);
      const after = fs.readFileSync(file, 'utf-8');
      assert.ok(after.startsWith('# Cross-AI Plan Review — Phase 7\r\n'),
        'a pre-existing line must keep its original CRLF ending');
      assert.match(after, /- \[ \] REVISION_CONFLICT d\/p1/, 'the record must actually be inserted');
    });
  });

});
