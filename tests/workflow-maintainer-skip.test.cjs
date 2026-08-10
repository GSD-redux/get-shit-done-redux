// allow-test-rule: source-text-is-the-product
// These workflow files are deployed policy; the tests lock the maintainer
// carve-out so future edits do not accidentally re-enable enforcement.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { evaluateIssueLink, ISSUE_LINK_REASON } = require('../scripts/require-issue-link-policy.cjs');

const MAINTAINER_SKIP_EXPR = 'contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.pull_request.author_association) == false';

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

// Comment-stripped view of a workflow, for assertions about CODE STRUCTURE.
// These files document their own rationale, so prose routinely names the very
// symbols a positional assertion looks for (e.g. "...and core.setFailed never
// runs"). Matching raw source makes such an assertion measure the comment
// rather than the call — the #2331 ordering test did exactly that and failed
// against correct code. Drop whole-line YAML (`#`) and JS (`//`) comments so
// positional checks see only executable text.
function readWorkflowCode(relativePath) {
  return readWorkflow(relativePath)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('#') && !t.startsWith('//');
    })
    .join('\n');
}

// True when the verdict call sits AFTER the comment-posting catch block — i.e.
// a thrown/403'd comment cannot skip the gate (#2331). Takes comment-stripped
// code. Extracted so the predicate itself can be exercised against a known-bad
// sample below; a presence-only check would pass on the inverted arrangement.
function verdictSurvivesCommentFailure(code) {
  const catchWarning = code.indexOf('Could not post');
  const verdict = code.indexOf('core.setFailed(');
  if (catchWarning === -1 || verdict === -1) return false;
  return verdict > catchWarning;
}

function assertMaintainerSkip(source) {
  assert.ok(
    source.includes(MAINTAINER_SKIP_EXPR),
    `Expected workflow to include maintainer skip expression: ${MAINTAINER_SKIP_EXPR}`
  );
}

describe('PR policy workflow maintainer carve-outs', () => {
  test('draft PR auto-close does not run for maintainer-authored PRs', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs.yml');

    assert.match(workflow, /github\.event\.pull_request\.draft == true/);
    assertMaintainerSkip(workflow);
  });

  test('draft PR auto-close triggers on pull_request_target so fork PRs cannot bypass it', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs.yml');

    // A bare `pull_request` trigger hands fork PRs (how first-time/external
    // contributors contribute) a read-only GITHUB_TOKEN, so the close/comment
    // API calls 403 and the draft PR survives — bypassing the auto-close.
    // `pull_request_target` runs in the base-repo context with a write-capable
    // token. Guard against a regression back to the bypassable trigger.
    assert.match(workflow, /^\s*pull_request_target:/m);
    assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  });

  test('PR target validator does not run for maintainer-authored PRs', () => {
    const workflow = readWorkflow('.github/workflows/pr-target-validator.yml');

    assertMaintainerSkip(workflow);
  });

  // #2331: same defect class as the close-draft-prs.yml trigger lock above,
  // swept across the three PR-policy workflows it had never covered. Each one
  // comments on the PR and THEN emits its verdict; on a bare `pull_request`
  // trigger a fork PR's read-only GITHUB_TOKEN 403s the comment call, the
  // unhandled rejection kills the github-script step, and the verdict
  // (core.setFailed) never runs — the contributor gets an API stack trace
  // instead of the instructions the comment exists to deliver.
  for (const { file, name, scope, otherScope } of [
    { file: '.github/workflows/pr-title-validator.yml', name: 'PR title validator', scope: 'pull-requests', otherScope: 'issues' },
    { file: '.github/workflows/pr-target-validator.yml', name: 'PR target validator', scope: 'pull-requests', otherScope: 'issues' },
    { file: '.github/workflows/require-issue-link.yml', name: 'Require issue link', scope: 'issues', otherScope: 'pull-requests' },
  ]) {
    test(`${name} triggers on pull_request_target so fork PRs get the verdict, not a 403`, () => {
      const workflow = readWorkflow(file);

      assert.match(workflow, /^\s*pull_request_target:/m);
      assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
    });

    test(`${name} keeps exactly the one write scope its comment call needs`, () => {
      const workflow = readWorkflow(file);

      // pull_request_target only grants what `permissions:` declares, so the
      // write scope must be present or the trigger change alone would not fix
      // the 403. Assert the SPECIFIC scope, not an `(issues|pull-requests)`
      // alternation — an alternation is satisfied by whichever scope happens to
      // be there and would not catch its removal.
      //
      // Each file needs only ONE: GitHub accepts either `issues: write` or
      // `pull-requests: write` for issues.createComment when the target is a
      // PR. Verified from this repo's history, not the docs — pr-title-validator
      // has posted on `pull-requests: write` alone, require-issue-link on
      // `issues: write` alone. The 403 was the fork downgrade, not the scope.
      //
      // The negative half is the point of this test: a pull_request_target
      // workflow must not carry privilege it never exercises, so adding the
      // other scope "to be safe" is a regression this catches.
      assert.match(workflow, new RegExp(`^\\s*${scope}:\\s*write\\s*$`, 'm'));
      assert.doesNotMatch(
        workflow,
        new RegExp(`^\\s*${otherScope}:\\s*write\\s*$`, 'm'),
        `${file} does not call a ${otherScope}.* API — do not grant it write on a pull_request_target workflow`
      );
    });

    test(`${name} cannot let a failed comment suppress its verdict`, () => {
      const workflow = readWorkflow(file);

      // Defense in depth: the comment is a courtesy, the verdict is the gate.
      // Guard the inversion (comment throws -> setFailed skipped) that #2331
      // fixed, so a future permission change degrades the diagnostic only.
      assert.match(workflow, /\btry\s*\{/);
      assert.match(workflow, /catch\s*\(err\)\s*\{[\s\S]*?core\.warning/);

      // Assert the ORDER, not just the presence: the verdict must appear AFTER
      // the catch block's core.warning. If it were moved inside the try, it
      // would textually precede the catch — exactly the regression this locks.
      // Presence-only assertions pass either way.
      //
      // Read the comment-stripped view: these workflows' own prose names
      // `core.setFailed` while explaining the bug, and matching raw source made
      // this assertion compare a comment instead of the call.
      assert.equal(
        verdictSurvivesCommentFailure(readWorkflowCode(file)),
        true,
        'core.setFailed must sit AFTER the catch block, not inside the try — ' +
          'otherwise a thrown comment error skips the verdict (#2331)'
      );
    });
  }

  // #2331: these two workflows echo attacker-controlled text (PR title / fork
  // branch name) into a bot-authored comment posted with a write token. Raw
  // interpolation into an inline-code span lets a single backtick close the span
  // so the remainder renders as live Markdown — on a PR title (no charset limit)
  // that is enough to autolink an arbitrary URL from github-actions[bot].
  for (const { file, name, varName } of [
    { file: '.github/workflows/pr-title-validator.yml', name: 'PR title validator', varName: 'titleForMarkdown' },
    { file: '.github/workflows/pr-target-validator.yml', name: 'PR target validator', varName: 'headForMarkdown' },
  ]) {
    test(`${name} strips backticks before echoing untrusted text into the comment`, () => {
      const workflow = readWorkflow(file);

      // The sanitizer exists and removes the one character that can break out
      // of an inline-code span.
      assert.match(workflow, new RegExp(`const ${varName} = String\\(\\w+\\)\\.replace\\(/\`/g, "'"\\)`));
      // The rendered comment interpolates the SANITIZED value, never the raw one.
      assert.match(workflow, new RegExp(`\\\\\`\\$\\{${varName}\\}`));
    });
  }

  test('the verdict-ordering predicate rejects the inversion it exists to catch', () => {
    // Non-vacuity: prove the guard fails on the bad arrangement, not just that
    // it passes on the current (good) one.
    const good = [
      'try {',
      '  await github.rest.issues.createComment({});',
      '} catch (err) {',
      '  core.warning(`Could not post the comment (${err.status}).`);',
      '}',
      "core.setFailed('nope');",
    ].join('\n');
    const inverted = [
      'try {',
      '  await github.rest.issues.createComment({});',
      "  core.setFailed('nope');", // <-- swallowed by the catch
      '} catch (err) {',
      '  core.warning(`Could not post the comment (${err.status}).`);',
      '}',
    ].join('\n');

    assert.equal(verdictSurvivesCommentFailure(good), true);
    assert.equal(verdictSurvivesCommentFailure(inverted), false);
    // Missing either half is not a pass.
    assert.equal(verdictSurvivesCommentFailure("core.setFailed('x');"), false);
    assert.equal(verdictSurvivesCommentFailure('core.warning(`Could not post`);'), false);
  });

  test('readWorkflowCode strips prose that would confuse a positional assertion', () => {
    // The exact trap that made the first cut of the ordering test fail against
    // correct code: these workflows name `core.setFailed` in their own comments,
    // before the call, so a raw-source indexOf compares the comment.
    const raw = readWorkflow('.github/workflows/pr-title-validator.yml');
    const code = readWorkflowCode('.github/workflows/pr-title-validator.yml');

    assert.ok(
      raw.indexOf('core.setFailed') < raw.indexOf('Could not post'),
      'precondition: raw source mentions core.setFailed in prose before the catch'
    );
    assert.ok(
      code.indexOf('core.setFailed(') > code.indexOf('Could not post'),
      'comment-stripped code puts the real call after the catch'
    );
    assert.doesNotMatch(code, /^\s*#/m, 'no YAML comment lines survive');
    assert.doesNotMatch(code, /^\s*\/\//m, 'no JS comment lines survive');
  });

  test('the backtick sanitizer actually neutralizes the inline-code breakout', () => {
    // Behavioral check of the transform the workflows apply, rather than only
    // asserting the source text contains it.
    const sanitize = (v) => String(v).replace(/`/g, "'");
    const hostile = 'bad`See https://evil.example/ci-status for details x';

    assert.match('`' + hostile + '`', /`bad`See/, 'pre-fix: the span breaks out');
    assert.doesNotMatch('`' + sanitize(hostile) + '`', /`bad`/, 'post-fix: it cannot');
    assert.equal(sanitize(hostile).includes('`'), false, 'no backtick survives');
    // Boundary: no backtick, one backtick, many backticks.
    assert.equal(sanitize('plain'), 'plain');
    assert.equal(sanitize('`'), "'");
    assert.equal(sanitize('``a``'), "''a''");
  });

  test('draft PR sweep enforces the same policy as the event-driven close', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs-sweep.yml');

    // Timer-driven in base-repo context, plus a manual dispatch for testing.
    // It must NOT be a fork-triggered event (no pull_request / pull_request_target trigger).
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron:\s*'0 \*\/6 \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^\s*pull_request(_target)?:/m);

    // Write-capable token (needed to close PRs from base context). Tolerant of
    // intervening blank lines or additional permission keys.
    assert.match(workflow, /permissions:\s+pull-requests:\s*write/);

    // Identical maintainer carve-out to close-draft-prs.yml — a Set membership
    // test over author_association, negated (no github.event.pull_request in a
    // scheduled run).
    assert.match(workflow, /new Set\(\['OWNER', 'MEMBER', 'COLLABORATOR'\]\)/);
    assert.match(workflow, /!MAINTAINER_ASSOCIATIONS\.has\([^)]*\.author_association\)/);

    // Paginates over open PRs and filters to drafts.
    assert.match(workflow, /github\.paginate\(github\.rest\.pulls\.list/);
    assert.match(workflow, /state:\s*'open'/);
    assert.match(workflow, /pr\.draft === true/);

    // Same user-facing policy message as close-draft-prs.yml (locks the core
    // content so the sweep cannot silently drift to a weaker message).
    assert.match(workflow, /## Draft PRs are not accepted/);
    assert.match(workflow, /npm run test:coverage/);
    assert.match(workflow, /CONTRIBUTING\.md#pull-request-guidelines/);
  });
});

describe('Require Issue Link back-merge automation carve-out', () => {
  // #3211 moved the whole verdict — including the #1389 backmerge carve-out —
  // out of the YAML `if:` and into scripts/require-issue-link-policy.cjs
  // (evaluateIssueLink), renaming the step from `check`/`found` to
  // `policy`/`ok`. The old assertions here measured the carve-out's PREVIOUS
  // location (raw `startsWith(github.head_ref, ...)` / `head.repo.full_name`
  // text inside the workflow's `if:`) and went stale once that logic
  // relocated — the property they guarded still holds, just not at that
  // text. This test locks the property at its new home: (a)+(b) assert the
  // workflow now delegates to the policy module at the correct step-level
  // `if:`, (c) asserts the carve-out itself BEHAVIORALLY against the real
  // module, and (d) keeps the bootstrap fallback's legacy grep locked so the
  // introducing-PR path (before the module exists on the base branch) is
  // never silently open.
  test('the backmerge carve-out survives the move into the policy module', () => {
    const workflow = readWorkflow('.github/workflows/require-issue-link.yml');

    // (a) The failing step's `if:` is keyed on the policy output and is
    // STEP-level, not job-level. A job-level `if:` would make the required
    // "Issue link required" check report `skipped` instead of `success` on
    // an exempt PR, which blocks branch protection (#1389).
    assert.match(workflow, /if: steps\.policy\.outputs\.ok != 'true'/);

    const doc = yaml.load(workflow);
    assert.equal(
      doc.jobs['check-issue-link'].if,
      undefined,
      'job-level `if:` would report "skipped" on an exempt PR and block branch protection (#1389)'
    );

    // (b) The workflow delegates the verdict to the policy module.
    assert.match(workflow, /node scripts\/require-issue-link-policy\.cjs/);

    // (c) The carve-out itself still holds — asserted BEHAVIORALLY against
    // the real module rather than by grepping YAML, since the verdict no
    // longer lives in the YAML text at all.
    const backmergeArgs = {
      prBody: 'Automated backmerge.',
      headRef: 'chore/backmerge-main-to-next-20260101',
      changedFiles: ['src/a.cts'],
      changedFilesTotal: 1,
    };
    assert.equal(
      evaluateIssueLink({ ...backmergeArgs, sameRepo: true }).reason,
      ISSUE_LINK_REASON.OK_BACKMERGE_EXEMPT
    );
    // #1389 anti-forgery: a fork must not be able to forge the exemption by
    // branch name alone — dropping the `sameRepo` conjunct would let a fork
    // PR name its branch `chore/backmerge-main-to-next-*` and bypass the
    // issue-link requirement entirely.
    assert.equal(
      evaluateIssueLink({ ...backmergeArgs, sameRepo: false }).reason,
      ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE
    );

    // (d) The bootstrap fallback (used only on the PR that first introduces
    // the policy module, before it exists on the base branch) still carries
    // the legacy closing-keyword grep, so the gate is never silently open
    // during the changeover.
    assert.match(workflow, /\(closes\|fixes\|resolves\)/);
  });
});

describe('Auto-backmerge needs_review version-manifest carve-out (#1404)', () => {
  const workflow = readWorkflow('.github/workflows/auto-backmerge.yml');

  test('all version-bearing manifests are filtered via version-only detection', () => {
    // package.json / package-lock.json / plugin.json / marketplace.json
    // diverge every release; a drop that is ONLY "version" lines must not park
    // (parking is what lets the back-merge go stale). A substantive change
    // still parks. The grep matches the indented "version": line for
    // marketplace.json's plugins[0].version too. (#1404 / #1855)
    // #1928: gemini-extension.json was removed with the sunset gemini runtime.
    assert.ok(
      workflow.includes("VERSION_STAMP_MANIFESTS='package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json'"),
      'auto-backmerge.yml must version-only-filter all version-bearing manifests (incl. marketplace.json #1855)'
    );
    assert.ok(
      workflow.includes(`grep -vE '^[+-][[:space:]]*"version":'`),
      'auto-backmerge.yml must filter version-only diffs via the "version" grep'
    );
  });

  test('package-lock.json is NOT blindly excluded (lockfile-only changes still park)', () => {
    // A lockfile-only substantive change (e.g. npm audit fix) rewrites
    // resolved/integrity lines, so version-only filtering lets it through to
    // review rather than dropping it silently. Guard against regression to a
    // blanket exclude. (#1404)
    assert.ok(
      !workflow.includes(":(exclude)package-lock.json"),
      'package-lock.json must not be globally excluded; rely on version-only filtering'
    );
  });
});
