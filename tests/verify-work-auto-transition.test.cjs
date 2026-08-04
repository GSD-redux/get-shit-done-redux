// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * verify-work auto-transition tests (#2018)
 *
 * Validates that verify-work.md calls the transition workflow to mark the
 * phase complete in ROADMAP.md and STATE.md when UAT passes with 0 issues.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VERIFY_WORK = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');

describe('verify-work.md — auto-transition after UAT passes with 0 issues', () => {
  test('workflow reads transition.md when issues == 0 and security gate cleared', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    assert.ok(
      content.includes('transition.md'),
      'verify-work.md must reference transition.md for phase completion when issues == 0'
    );
  });

  test('transition call appears after complete_session section', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const completeSessionIdx = content.indexOf('complete_session');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      completeSessionIdx !== -1,
      'verify-work.md must contain a complete_session section'
    );
    assert.ok(
      transitionIdx !== -1,
      'verify-work.md must reference transition.md'
    );
    assert.ok(
      transitionIdx > completeSessionIdx,
      'transition.md reference must appear after the complete_session section'
    );
  });

  test('security gate check gates the transition (no auto-transition when security pending)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The capability-resolved security check must appear before the transition reference.
    const securityHookIdx = content.indexOf('loop render-hooks verify:post');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      securityHookIdx !== -1,
      'verify-work.md must resolve verify:post capability hooks before transitioning'
    );
    assert.ok(
      securityHookIdx < transitionIdx,
      'verify:post capability hook check must appear before transition.md reference'
    );
  });

  test('transition is only invoked when security gate is cleared or disabled', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // Transition must be guarded by security check:
    // Either no active secure-phase hook exists, or security file exists with 0 open threats.
    const hasGuardedTransition =
      content.includes('transition.md') &&
      (
        content.includes('loop render-hooks verify:post') &&
        content.includes('ref.skill == "secure-phase"') &&
        (content.includes('threats_open') || content.includes('SECURITY_FILE'))
      );
    assert.ok(
      hasGuardedTransition,
      'transition.md invocation must be guarded by security gate checks'
    );
  });

  test('auto-transition is gated by UAT plus canonical verification predicate', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const predicateIdx = content.indexOf('phase uat-passed');
    const requireVerificationIdx = content.indexOf('--require-verification');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(predicateIdx !== -1, 'verify-work.md must call phase uat-passed before transition');
    assert.ok(
      requireVerificationIdx > predicateIdx,
      'verify-work.md must require canonical verification in the UAT predicate'
    );
    assert.ok(
      predicateIdx < transitionIdx,
      'UAT-plus-verification predicate must run before transition.md'
    );
  });

  test('human_needed verification is promoted to passed only after successful human UAT', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const statusIdx = content.indexOf('VERIFICATION_STATUS=$(gsd_run query verification.status "$PHASE_DIR"');
    const humanNeededIdx = content.indexOf('if [ "$VERIFICATION_STATUS_VALUE" = "human_needed" ]; then');
    const setPassedIdx = content.indexOf('gsd_run query frontmatter.set "$VERIFICATION_FILE" --field status --value passed');
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');

    assert.ok(statusIdx !== -1, 'verify-work.md must inspect canonical verification status');
    assert.ok(humanNeededIdx > statusIdx, 'status=passed promotion must be restricted to human_needed');
    assert.ok(setPassedIdx > humanNeededIdx, 'human_needed verification must be promoted after status check');
    assert.ok(setPassedIdx < predicateIdx, 'verification must be canonicalized before the required predicate runs');
  });

  test('stale verification blocks before phase transition', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const staleIdx = content.indexOf('If `PHASE_VERIFICATION_STATUS` is `stale`');
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(staleIdx !== -1, 'verify-work.md must stop on stale verification');
    assert.ok(staleIdx < predicateIdx, 'stale verification must be checked before the required predicate');
    assert.ok(staleIdx < transitionIdx, 'stale verification must be checked before transition');
  });

  test('transition is NOT suggested when security enforcement is enabled and no SECURITY.md exists', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The workflow should suggest /gsd-secure-phase when security is enabled but no file exists
    assert.ok(
      content.includes('gsd-secure-phase') || content.includes('gsd:secure-phase'),
      'verify-work.md must suggest /gsd:secure-phase when security gate blocks transition'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3381-verify-work-workstream.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3381-verify-work-workstream (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product — verify-work.md is a runtime workflow contract. (see #3381)

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #1716: resume_from_file routes to complete_session when no [pending] tests remain', () => {
  test('resume_from_file step contains guard clause for zero-pending (all-blocked) case', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md'),
      'utf8',
    );

    const stepStart = workflow.indexOf('<step name="resume_from_file">');
    assert.ok(stepStart !== -1, 'resume_from_file step must exist');

    const stepEnd = workflow.indexOf('</step>', stepStart);
    const stepBody = workflow.slice(stepStart, stepEnd);

    // Guard must appear immediately after the find-pending instruction.
    // Without it, all-blocked sessions (pending_count==0, blocked_count>0)
    // silently terminate and never reach complete_session (#1716).
    const findIdx = stepBody.indexOf("Find first test with `result: [pending]`.");
    const guardIdx = stepBody.indexOf("If no `[pending]` test found → go to `complete_session`.");

    assert.ok(findIdx !== -1, 'find-pending instruction must be present');
    assert.ok(guardIdx !== -1, 'guard clause for zero-pending case must be present');
    assert.ok(guardIdx > findIdx, 'guard must appear after find-pending instruction');

    const between = stepBody
      .slice(findIdx + "Find first test with `result: [pending]`.".length, guardIdx)
      .trim();
    assert.strictEqual(between, '', 'guard must be the next non-whitespace line after find-pending');
  });
});

describe('bug #3381: verify-work forwards workstream context', () => {
  test('workflow forwards ${GSD_WS} to workstream-sensitive SDK queries', () => {
    // #2994 fragmentization moved the roadmap.get-phase user-story-format-guard
    // bash block out of verify-work.md into
    // gsd-core/workflows/verify-work/steps/mvp-uat-framing.md behind a section
    // marker (`state:phase-mvp-mode`). Read host + every step file combined so
    // this GSD_WS-forwarding guard keeps seeing the moved query.
    const VERIFY_WORK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');
    const VERIFY_WORK_STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work', 'steps');
    let workflow = fs.readFileSync(VERIFY_WORK_MD, 'utf8');
    if (fs.existsSync(VERIFY_WORK_STEPS_DIR)) {
      for (const entry of fs.readdirSync(VERIFY_WORK_STEPS_DIR).sort()) {
        if (entry.endsWith('.md')) {
          workflow += '\n' + fs.readFileSync(path.join(VERIFY_WORK_STEPS_DIR, entry), 'utf8');
        }
      }
    }

    // The --ws capture character class was deliberately narrowed from
    // `[^[:space:]]+` to `[A-Za-z0-9._-]+` (workstream slugs are
    // alphanumeric/dot/underscore/hyphen; the old class captured any
    // non-space run, including shell metacharacters). Forwarding itself
    // (GSD_WS reaching every workstream-sensitive query below) is
    // unaffected by the narrower class, so only the literal pattern here
    // is updated — the asserted forwarding property is unchanged.
    assert.match(workflow, /GSD_WS=""/, 'verify-work must initialize GSD_WS');
    assert.match(
      workflow,
      /grep -qE -- '--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+'/,
      'verify-work must detect --ws in $ARGUMENTS',
    );
    assert.match(
      workflow,
      /grep -oE -- '--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+'/,
      'verify-work must extract the --ws flag pair from $ARGUMENTS',
    );
    assert.match(
      workflow,
      /PHASE_ARG=\$\(echo "\$ARGUMENTS" \| sed -E 's\/--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+\/\/g' \| xargs\)/,
      'verify-work must derive PHASE_ARG after removing --ws',
    );
    // After #3797 architectural fix, callsites use gsd_run
    assert.match(
      workflow,
      /gsd_run query init\.verify-work "\$\{PHASE_ARG\}" \$\{GSD_WS\}/,
      'init.verify-work must receive GSD_WS so phase_dir resolves in workstreams',
    );
    assert.match(
      workflow,
      /gsd_run query phase\.mvp-mode "\$\{phase_number\}" \$\{GSD_WS\} --pick active/,
      'phase.mvp-mode must receive GSD_WS so roadmap mode is workstream-scoped',
    );
    assert.match(
      workflow,
      /gsd_run query roadmap\.get-phase "\$\{phase_number\}" \$\{GSD_WS\} --pick goal/,
      'roadmap.get-phase must receive GSD_WS so goals are workstream-scoped',
    );
  });
});
  });
}
