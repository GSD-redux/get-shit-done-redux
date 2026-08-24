'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const {
  EXACT_INLINE_DIRECTIVE_WORKFLOWS,
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  REFERENCE_ROOT,
  WORKFLOWS_DIR,
  carriesInlineDirective,
  findBrokenDirectiveReferences,
  findMarkdownFilesRecursive,
  findViolations,
  hasResponseLanguageCoverage,
  inheritsParentCoverage,
  namesFragmentAsEntryPoint,
  main,
} = require('../scripts/lint-response-language-coverage.cjs');

describe('response-language workflow coverage lint (#2529)', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanup(dir);
  });

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'nested', 'modes'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'covered-by-reference.md'),
      '@~/.claude/gsd-core/references/response-language-directive.md\n',
    );
    fs.writeFileSync(
      path.join(root, 'nested', 'covered-inline.md'),
      'Use config.response_language for all prose, narration included.\n',
    );
    fs.writeFileSync(
      path.join(root, 'nested', 'mere-field-mention.md'),
      'Parse JSON for: phase_number, response_language.\n',
    );
    fs.writeFileSync(path.join(root, 'nested', 'modes', 'uncovered.md'), '# English-only mode\n');
    fs.writeFileSync(path.join(root, 'nested', 'ignored.txt'), 'not a workflow');
    return root;
  }

  test('walks nested workflow directories recursively and ignores non-Markdown files', () => {
    const root = fixture();
    const relative = findMarkdownFilesRecursive(root)
      .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(relative, [
      'covered-by-reference.md',
      'nested/covered-inline.md',
      'nested/mere-field-mention.md',
      'nested/modes/uncovered.md',
    ]);
  });

  test('reports an uncovered nested workflow while accepting both coverage forms', () => {
    const root = fixture();
    const violations = findViolations(root)
      .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(violations, [
      'nested/mere-field-mention.md',
      'nested/modes/uncovered.md',
    ]);
  });

  test('pins every shared inline directive site to one exact canonical line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-parity-'));
    tempDirs.push(root);
    for (const relative of EXACT_INLINE_DIRECTIVE_WORKFLOWS) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${INLINE_RESPONSE_LANGUAGE_DIRECTIVE}\n`);
    }

    assert.strictEqual(EXACT_INLINE_DIRECTIVE_WORKFLOWS.size, 35);
    assert.deepStrictEqual(findViolations(root), []);

    const drifted = path.join(root, 'discuss-phase', 'modes', 'advisor.md');
    fs.writeFileSync(
      drifted,
      'Apply response_language to all user-facing prose; preserve code and paths.\n',
    );
    assert.deepStrictEqual(findViolations(root), [drifted]);
  });

  // #1671 keeps extracting workflow prose into fragments. A fragment carries no
  // directive of its own, so without inheritance every extraction reds this lint
  // for prose that was already covered where it used to live.
  function fragmentFixture({ parentCovered = true, parentNamesFragment = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-fragment-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'autonomous', 'steps'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'autonomous.md'),
      [
        parentCovered
          ? '@~/.claude/gsd-core/references/response-language-directive.md'
          : '# No directive here',
        parentNamesFragment
          ? 'read and execute `gsd-core/workflows/autonomous/steps/converge-banner.md`'
          : 'read and execute `gsd-core/workflows/autonomous/steps/something-else.md`',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(root, 'autonomous', 'steps', 'converge-banner.md'),
      'Display: `Planning: convergence enabled`\n',
    );
    return root;
  }

  test('a fragment inherits coverage from the parent that names it', () => {
    const root = fragmentFixture();

    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/steps/converge-banner.md'),
      true,
    );
    assert.deepStrictEqual(findViolations(root), []);
  });

  test('inheritance is refused when the parent is uncovered or does not name the fragment', () => {
    const uncoveredParent = fragmentFixture({ parentCovered: false });
    assert.deepStrictEqual(
      findViolations(uncoveredParent).map((file) => path.relative(uncoveredParent, file).replaceAll(path.sep, '/')),
      ['autonomous.md', 'autonomous/steps/converge-banner.md'],
    );

    const unreferenced = fragmentFixture({ parentNamesFragment: false });
    assert.deepStrictEqual(
      findViolations(unreferenced).map((file) => path.relative(unreferenced, file).replaceAll(path.sep, '/')),
      ['autonomous/steps/converge-banner.md'],
    );
  });

  // #2558 round 10, Minor D. `inheritsParentCoverage` used to prove the parent
  // "is the way in" with a bare substring test, so any mention of the fragment
  // path — a changelog line, a deprecation note, a sentence about the file —
  // granted the fragment its parent's coverage. Inheritance is only sound when
  // the parent DISPATCHES the fragment, since that is what guarantees the
  // parent's directive is loaded when the fragment runs.
  test('inheritance requires a dispatching read/execute context, not a bare mention', () => {
    const dispatches = [
      'If `section_manifest` is `null`: read and execute `gsd-core/workflows/a/steps/b.md`. Otherwise skip.',
      'Read and execute `gsd-core/workflows/a/steps/b.md`.',
      'Read+execute `gsd-core/workflows/a/steps/b.md` (defines the helpers).',
      'Read `gsd-core/workflows/a/steps/b.md` if planning freezes on Windows.',
      // #1689's per-plan executor routing dispatches with `run`, not read/execute.
      '**Executor routing.** Per plan, run `gsd-core/workflows/a/steps/b.md` to set `EXECUTOR_TYPE`.',
    ];
    for (const line of dispatches) {
      assert.strictEqual(
        namesFragmentAsEntryPoint(`${line}\n`, 'a/steps/b.md'),
        true,
        `dispatch stub not recognized: ${line}`,
      );
    }

    const mentions = [
      '- #1234: extracted the wave logic into `gsd-core/workflows/a/steps/b.md`.',
      'The prose below used to live in `gsd-core/workflows/a/steps/b.md`.',
      '`gsd-core/workflows/a/steps/b.md` is deprecated and no longer dispatched.',
      // The verb is on a different line: it governs nothing here.
      'Read and execute the step below.\nSee `gsd-core/workflows/a/steps/b.md`.',
      // The verb is on the same line but a whole clause away, so it belongs to a
      // different sentence — the window is what keeps it from vouching.
      'Read the roadmap first, then decide whether any of this still applies to `gsd-core/workflows/a/steps/b.md`.',
    ];
    for (const line of mentions) {
      assert.strictEqual(
        namesFragmentAsEntryPoint(`${line}\n`, 'a/steps/b.md'),
        false,
        `bare mention accepted as a dispatch: ${line}`,
      );
    }
  });

  test('a fragment mentioned but never dispatched does not inherit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-mention-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'autonomous', 'steps'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'autonomous.md'),
      '@~/.claude/gsd-core/references/response-language-directive.md\n'
      + '- #1671: the banner prose moved to `gsd-core/workflows/autonomous/steps/converge-banner.md`.\n',
    );
    fs.writeFileSync(
      path.join(root, 'autonomous', 'steps', 'converge-banner.md'),
      'Display: `Planning: convergence enabled`\n',
    );

    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/steps/converge-banner.md'),
      false,
    );
    assert.deepStrictEqual(
      findViolations(root).map((file) => path.relative(root, file).replaceAll(path.sep, '/')),
      ['autonomous/steps/converge-banner.md'],
    );
  });

  // #2558 round 10 (Minor C), narrowed in round 13. The `gsd-verifier` subagent
  // emits user-facing prose but reads no workflow file of its own, so its
  // coverage lives entirely in the dispatch prompt execute-phase.md builds: the
  // reference tells the orchestrator to carry the directive "immediately after
  // `Create VERIFICATION.md.`", and that anchor lives in the workflow.
  //
  // Round 13 removed the lint's side of this: it hung off `verify-phase.md`, a
  // catalog file `next` deleted in #3421. The contract outlived the file — the
  // verifier still runs — but nothing in the workflows tree carries it any more,
  // so the lint cannot see it and this test is now the only thing holding the two
  // halves together. Asserted against the REAL tree, not a fixture: a fixture
  // would only prove the assertion can pass.
  const VERIFIER_DISPATCH_CONTRACT = {
    reference: '../references/execute-phase-response-language.md',
    directive: 'Use response_language {response_language} for all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code and paths.',
    anchor: 'Create VERIFICATION.md.',
    anchorIn: 'execute-phase.md',
  };

  test('the gsd-verifier dispatch contract still has both of its halves', () => {
    const { reference, directive, anchor, anchorIn } = VERIFIER_DISPATCH_CONTRACT;

    const referencePath = path.join(WORKFLOWS_DIR, reference);
    assert.ok(fs.existsSync(referencePath), `reference is stale: ${reference}`);
    const referenceFile = fs.readFileSync(referencePath, 'utf8');
    assert.ok(
      referenceFile.includes(directive),
      `${reference} no longer carries the directive the verifier dispatch must inject`,
    );

    const anchorPath = path.join(WORKFLOWS_DIR, anchorIn);
    assert.ok(fs.existsSync(anchorPath), `anchor file is stale: ${anchorIn}`);
    assert.ok(
      fs.readFileSync(anchorPath, 'utf8').split(/\r?\n/).some((line) => line.includes(anchor)),
      `${anchorIn} no longer carries the anchor "${anchor}" that the injected `
      + `response-language directive is positioned against. Re-anchor it in ${reference}.`,
    );

    // The reference must keep naming the same anchor, or the two halves drift
    // apart while each stays individually true.
    assert.ok(
      referenceFile.includes(anchor),
      `${reference} no longer names the anchor "${anchor}"`,
    );
  });

  test('inheritance reaches fragment directories only, never a nested workflow tree', () => {
    const root = fragmentFixture();
    // Depth and directory name are both load-bearing: a two-segment path has no
    // parent workflow, and a directory outside the fragment set is not a section.
    assert.strictEqual(inheritsParentCoverage(root, 'autonomous.md'), false);
    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/steps/nested/converge-banner.md'),
      false,
    );
    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/references/converge-banner.md'),
      false,
    );
  });

  test('rejects a bare config mention and accepts an actionable inline directive', () => {
    assert.strictEqual(hasResponseLanguageCoverage('response_language\n'), false);
    assert.strictEqual(
      hasResponseLanguageCoverage(
        'Apply response_language to all user-facing prose, narration included.\n',
      ),
      true,
    );
  });

  // The regression guard for the fix in #2558 round 13, and the sibling of the
  // dispatch-vs-mention test above. Before it, the reference check was a bare
  // `content.includes(ref)`: a workflow whose changelog merely NAMED the shared
  // directive was certified covered while shipping no import at all — the same
  // false-positive class, one level up.
  test('coverage by reference requires an @-import, not a mention of the path', () => {
    const imports = [
      '@~/.claude/gsd-core/references/response-language-directive.md',
      '@$HOME/.claude/gsd-core/references/response-language-directive.md',
      '@~/.claude/gsd-core/references/execute-phase-response-language.md',
      // Leading/trailing whitespace is still an import line.
      '  @~/.claude/gsd-core/references/response-language-directive.md  ',
    ];
    for (const line of imports) {
      assert.strictEqual(
        hasResponseLanguageCoverage(`${line}\n`),
        true,
        `import line not recognized: ${line}`,
      );
    }

    const mentions = [
      '- #2529: added the shared references/response-language-directive.md reference.',
      'The directive lives in `gsd-core/references/response-language-directive.md`.',
      'references/response-language-directive.md is deprecated; do not import it.',
      // An import that is only quoted as an example, mid-sentence, loads nothing.
      'Add `@~/.claude/gsd-core/references/response-language-directive.md` to new workflows.',
    ];
    for (const line of mentions) {
      assert.strictEqual(
        hasResponseLanguageCoverage(`${line}\n`),
        false,
        `bare mention accepted as coverage: ${line}`,
      );
    }
  });

  // The regression guard for the fix in #2558 round 10. Before it, the lint
  // certified 45 workflows whose directive named only "questions, prompts, and
  // explanations" — the exact wording #2529 filed as the DEFECT, because it
  // leaves the model's between-tool-call narration in English while the answers
  // around it are translated. Certifying that wording made the gate legitimise
  // the bug it exists to catch, so the old sentence must now FAIL.
  test('the pre-#2558 weak wording is no longer coverage; naming narration is', () => {
    const weak =
      '**If `response_language` is set:** All user-facing questions, prompts, and '
      + 'explanations in this workflow MUST be presented in `{response_language}`. '
      + 'Technical terms, code, file paths, and subagent prompts stay in English — '
      + 'only user-facing output is translated.\n';
    assert.strictEqual(
      hasResponseLanguageCoverage(weak),
      false,
      'a directive naming only the question/prompt surface must not count as coverage',
    );

    // Every narration-class form the lint accepts, each asserted on its own so a
    // future edit to the alternation cannot silently drop one while the others
    // keep the suite green.
    for (const token of [
      'narration between tool calls',
      'narration',
      'output between tool calls',
    ]) {
      assert.strictEqual(
        hasResponseLanguageCoverage(
          `Apply response_language to all user-facing output — ${token} included.\n`,
        ),
        true,
        `"${token}" must satisfy the narration-class requirement`,
      );
    }

    // Round 21: a word that merely APPEARS in the canonical phrasing does not
    // name the class. REQ-LANG-04 requires the directive to name inter-tool
    // narration; "report status" names a surface the model already reports in
    // English and says nothing about the commentary between tool calls, so the
    // earlier token list was weaker than the requirement it enforced.
    for (const weakToken of ['status updates', 'progress notes', 'findings']) {
      assert.strictEqual(
        hasResponseLanguageCoverage(
          `Apply response_language to all user-facing output — ${weakToken} included.\n`,
        ),
        false,
        `"${weakToken}" alone must not satisfy the narration-class requirement`,
      );
    }

    // The narration token alone is not a directive either: the line still has to
    // name response_language and act on it, so the tightening did not swap one
    // half of the predicate for the other.
    assert.strictEqual(
      hasResponseLanguageCoverage('Narration between tool calls is emitted here.\n'),
      false,
    );

    // Both halves must land on the SAME line. A workflow that mentions narration
    // in one paragraph and response_language in another has stated no rule.
    assert.strictEqual(
      hasResponseLanguageCoverage(
        'Apply response_language to all user-facing prose.\nNarration is emitted between tool calls.\n',
      ),
      false,
    );
  });

  // The wording migration is only real if it actually landed in the catalog: the
  // lint could pass on a tree where every file still carried the weak sentence if
  // the tightening above were ever reverted. Assert the catalog directly.
  // Round 21 widened the scan from the workflow catalog to the references
  // directory as well. The predicate check on imported references (above) is the
  // durable guard; this is the cheap independent one, and the two fail for
  // different reasons — the predicate asks whether a directive is present and
  // actionable, this asks whether the specific sentence #2529 filed as the
  // defect has come back. A shared reference carrying that sentence would be
  // the single highest-blast-radius regression in the catalog: 43 workflows
  // hold no directive of their own.
  test('no shipped workflow or reference still carries the pre-#2558 weak directive sentence', () => {
    const WEAK_SENTENCE =
      'All user-facing questions, prompts, and explanations in this workflow MUST be presented in';
    const scanned = [
      ...findMarkdownFilesRecursive(WORKFLOWS_DIR),
      ...findMarkdownFilesRecursive(path.join(REFERENCE_ROOT, 'references')),
    ];
    const offenders = scanned
      .filter((file) => fs.readFileSync(file, 'utf8').includes(WEAK_SENTENCE))
      .map((file) => path.relative(REFERENCE_ROOT, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(offenders, []);
    // A scan that inspected nothing proves nothing — the same rule main() applies.
    assert.ok(scanned.length > 152, `scan covered only ${scanned.length} file(s)`);
  });

  test('main returns a failure code and reports each violation', () => {
    const root = fixture();
    const errors = [];
    const logs = [];
    const exitCode = main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(logs.length, 0);
    assert.match(errors[0], /2 workflow\(s\) have no response-language coverage/);
    assert.match(errors[0], /nested\/mere-field-mention\.md/);
    assert.match(errors[0], /nested\/modes\/uncovered\.md/);
  });

  test('main returns success and emits the covered workflow count', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-ok-'));
    tempDirs.push(root);
    fs.writeFileSync(
      path.join(root, 'covered.md'),
      'Apply response_language to all user-facing prose, narration included.\n',
    );
    const errors = [];
    const logs = [];

    assert.strictEqual(main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    }), 0);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(logs, [
      'lint-response-language-coverage: OK (1 workflows covered)',
    ]);
  });

  test('main fails instead of passing vacuously when discovery finds no workflow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-empty-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'not-a-workflow'), { recursive: true });
    fs.writeFileSync(path.join(root, 'not-a-workflow', 'notes.txt'), 'not Markdown');
    const errors = [];
    const logs = [];

    assert.strictEqual(main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    }), 1);
    assert.deepStrictEqual(logs, []);
    assert.match(errors[0], /no workflow files found/);
  });

  test('main fails closed on an unreadable workflow directory rather than throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-absent-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, 'file-not-dir.md'), 'Apply response_language to all prose.\n');
    const errors = [];
    const logs = [];
    const io = {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    };

    assert.strictEqual(main(path.join(root, 'does-not-exist'), io), 1);
    assert.match(errors[0], /cannot read the workflow directory/);
    assert.match(errors[0], /ENOENT/);

    assert.strictEqual(main(path.join(root, 'file-not-dir.md'), io), 1);
    assert.match(errors[1], /cannot read the workflow directory/);
    assert.deepStrictEqual(logs, []);
  });

  // #2558 round 21, Blocker. 43 workflows hold no directive of their own and take
  // ALL of their coverage from one shared file. The lint checked only that the
  // @-import LINE existed, so rewriting that file back to the pre-#2529 sentence
  // left every one of them "covered" with the whole suite green — the same
  // "the gate certifies the defect" failure the round-10 fix closed, one level up.
  // These tests fail on the unfixed lint.
  function referenceFixture(referenceText) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-ref-'));
    tempDirs.push(root);
    const workflows = path.join(root, 'workflows');
    fs.mkdirSync(path.join(root, 'references'), { recursive: true });
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, 'takes-the-reference.md'),
      '@~/.claude/gsd-core/references/response-language-directive.md\n',
    );
    if (referenceText !== null) {
      fs.writeFileSync(
        path.join(root, 'references', 'response-language-directive.md'),
        referenceText,
      );
    }
    return { root, workflows };
  }

  const STRONG_REFERENCE =
    'ALL user-facing output of this workflow MUST be in `response_language` — '
    + 'narration between tool calls, findings, and report prose.\n';
  const WEAK_REFERENCE =
    '**If `response_language` is set:** All user-facing questions, prompts, and '
    + 'explanations in this workflow MUST be presented in `{response_language}`.\n';

  test('an imported reference that no longer carries a directive uncovers its importers', () => {
    const strong = referenceFixture(STRONG_REFERENCE);
    assert.deepStrictEqual(findViolations(strong.workflows, strong.root), []);
    assert.deepStrictEqual(findBrokenDirectiveReferences(
      findMarkdownFilesRecursive(strong.workflows), strong.root,
    ), []);

    // The reviewer's mutation: the shared file reworded back to the defect.
    const weak = referenceFixture(WEAK_REFERENCE);
    assert.deepStrictEqual(
      findViolations(weak.workflows, weak.root).map((file) => path.basename(file)),
      ['takes-the-reference.md'],
    );

    // ...and the same for a reference that is missing outright.
    const missing = referenceFixture(null);
    assert.deepStrictEqual(
      findViolations(missing.workflows, missing.root).map((file) => path.basename(file)),
      ['takes-the-reference.md'],
    );
  });

  test('main reports a weakened reference as one systemic failure, not per importer', () => {
    const weak = referenceFixture(WEAK_REFERENCE);
    const errors = [];
    const logs = [];
    const exitCode = main(weak.workflows, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    }, weak.root);

    assert.strictEqual(exitCode, 1);
    assert.deepStrictEqual(logs, []);
    assert.match(errors[0], /shared directive reference\(s\) no longer carry an actionable directive/);
    assert.match(errors[0], /references\/response-language-directive\.md/);
    // The cause, not its 43 symptoms.
    assert.doesNotMatch(errors[0], /workflow\(s\) have no response-language coverage/);
  });

  test('every shipped directive reference carries an actionable directive', () => {
    // The real tree, not a fixture: this is the assertion that would have caught
    // the hole, and it holds for both references the catalog imports.
    for (const ref of ['response-language-directive.md', 'execute-phase-response-language.md']) {
      const file = path.join(REFERENCE_ROOT, 'references', ref);
      assert.ok(fs.existsSync(file), `missing shipped reference: ${ref}`);
      assert.strictEqual(
        carriesInlineDirective(fs.readFileSync(file, 'utf8')),
        true,
        `${ref} must itself name the narration class alongside response_language`,
      );
    }
    assert.deepStrictEqual(
      findBrokenDirectiveReferences(findMarkdownFilesRecursive(WORKFLOWS_DIR)),
      [],
    );
  });

  // #2558 round 21, Minor 1. Dirent uses lstat semantics, so a symlinked
  // directory answers false to both isDirectory() and isFile() — the walk used
  // to skip such a subtree in silence while files.length > 0 kept the run green,
  // which is precisely what main()'s comment claims cannot happen.
  test('the walk follows a symlinked subtree instead of skipping it silently', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-symlink-'));
    tempDirs.push(root);
    const workflows = path.join(root, 'workflows');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workflows, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, 'covered.md'),
      'Apply response_language to all user-facing prose, narration included.\n',
    );
    fs.writeFileSync(path.join(outside, 'uncovered.md'), '# English-only mode\n');
    try {
      fs.symlinkSync(outside, path.join(workflows, 'linked'), 'junction');
    } catch {
      // Unprivileged Windows without Developer Mode cannot create links at all.
      t.skip('symlink creation not permitted in this environment');
      return;
    }

    assert.deepStrictEqual(
      findMarkdownFilesRecursive(workflows)
        .map((file) => path.relative(workflows, file).replaceAll(path.sep, '/'))
        .sort(),
      ['covered.md', 'linked/uncovered.md'],
    );
    assert.deepStrictEqual(
      findViolations(workflows).map((file) => path.basename(file)),
      ['uncovered.md'],
    );
  });

  test('REQ-LANG-04 offers authors only forms the lint accepts', () => {
    // Round 22: the requirement text is the shipped contract, so every form it
    // hands an author must pass the lint that enforces it. The earlier wording
    // enumerated four items joined by `or`, but only two of them name the
    // narration class — an author copying `status updates` straight out of the
    // requirement got a red lint for following it. Pin text and matcher
    // together so the next reword of either cannot drift from the other.
    const features = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'FEATURES.md'),
      'utf8',
    );
    const requirement = features
      .split(/\r?\n/)
      .find((line) => line.startsWith('- REQ-LANG-04:'));
    assert.ok(requirement, 'REQ-LANG-04 must be present in docs/FEATURES.md');

    // Round 23: scoped to the CLAUSE that states how the class is named, not to
    // every quoted span on the line. Reading the whole line cannot tell an OFFER
    // from a MENTION, so quoting the defective wording in order to warn against
    // it — or quoting the class members descriptively — would have failed the
    // document for offering the thing it warns against. That is the same
    // mention-vs-claim confusion #3752 just repaired in the parity guard.
    // Bounded quantifiers throughout: the scan runs over file content
    // (local/no-unbounded-quantifier).
    const offeredForms = (line) => {
      const clause = line.match(/A directive names it by using ([^;.]{1,200})/);
      return clause
        ? [...clause[1].matchAll(/"([^"]{1,40})"/g)].map((match) => match[1])
        : [];
    };

    const offered = offeredForms(requirement);
    assert.ok(
      offered.length >= 2,
      'REQ-LANG-04 must state how a directive names the class, quoting each accepted form',
    );
    for (const form of offered) {
      assert.strictEqual(
        hasResponseLanguageCoverage(
          `Apply response_language to all user-facing output — ${form} included.\n`,
        ),
        true,
        `REQ-LANG-04 offers "${form}", so the lint must accept it`,
      );
    }

    // The class members it lists are described as insufficient alone, which is
    // what NARRATION_CLASS_RE enforces and what the assertions above at the
    // weak-token loop prove.
    assert.match(requirement, /does not satisfy the rule/);
    for (const member of ['status updates', 'progress notes', 'findings']) {
      assert.ok(
        !offered.includes(member),
        `REQ-LANG-04 must not offer "${member}" as a standalone form`,
      );
    }

    // The extraction reads the offering clause, so a quoted span elsewhere on
    // the line is a mention and not an offer. Each addition below is a correct
    // edit to the requirement that the round-22 whole-line scan rejected.
    // Asserted last so a genuine drift in the line above fails on its own
    // message rather than on this guard.
    for (const mention of [
      ' A directive saying "questions, prompts, and explanations" is the defect.',
      ' The class covers "status updates" and "progress notes" as members.',
      ' See also "response-language coverage".',
    ]) {
      assert.deepStrictEqual(
        offeredForms(requirement + mention),
        offered,
        `a mention must not read as an offer: ${mention.trim()}`,
      );
    }
  });

  test('every pinned workflow path is live in the real catalog', () => {
    // The pinned sets are enforced by exact path. A rename that leaves a stale
    // entry behind does not fail the lint — the moved file quietly falls back
    // to the loose coverage check, so the exact-line pin stops being enforced
    // without anything going red. Assert the pins still resolve.
    const discovered = new Set(
      findMarkdownFilesRecursive(WORKFLOWS_DIR)
        .map((file) => path.relative(WORKFLOWS_DIR, file).replaceAll(path.sep, '/')),
    );
    const pinned = [...EXACT_INLINE_DIRECTIVE_WORKFLOWS].sort();

    assert.deepStrictEqual(pinned.filter((relative) => !discovered.has(relative)), []);
  });
});
