'use strict';

/**
 * #3637 — the orchestrator-worktree process spawn must carry the gsd-executor
 * identity and execution contract, not a short objective-only prompt.
 *
 * The process-spawned child has NO host subagent machinery: nothing loads the
 * gsd-executor agent definition or the execute-plan workflow unless the
 * EXECUTOR_PROMPT carries them. A short prompt forced both reporters' executors
 * to reconstruct their role from repository search AND left them unaware of the
 * gitignored-planning skip semantics — so they force-staged gitignored
 * SUMMARY.md files (`git add -f`) to satisfy an unconditional
 * "SUMMARY.md created AND committed" criterion.
 *
 * These are source-text-is-the-product assertions: the workflow markdown IS
 * what the orchestrator runtime loads. The contract checked here is the
 * documented dispatch text, per the issue's acceptance list.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

/** The EXECUTOR_PROMPT single-quoted assignment body. */
function promptBody() {
  const start = content.indexOf("EXECUTOR_PROMPT='<objective>");
  const end = content.indexOf("</success_criteria>'", start);
  assert.ok(start !== -1 && end !== -1, 'EXECUTOR_PROMPT assignment must exist');
  return content.slice(start, end);
}

test('#3637: the executor prompt carries the required-reading contract with the explicit plan path', () => {
  const body = promptBody();
  assert.match(body, /<required_reading>/, 'the prompt must carry the required-reading contract');
  assert.match(body, /\{phase_dir\}\/\{plan_file\}/, 'the prompt must name the explicit plan path');
  assert.match(body, /PROJECT\.md/, 'project context is required reading');
});

test('#3637: the executor prompt carries the execution-context build-time embeds', () => {
  const body = promptBody();
  assert.match(body, /<execution_context>/, 'the prompt must carry an execution_context block');
  assert.match(body, /execute-plan\.md/, 'execute-plan.md must be embedded (the executor workflow)');
  assert.match(body, /worktree-path-safety\.md/, 'worktree path safety must be embedded');
});

test('#3637: the success criteria make an intentional gitignored skip a success path and forbid force-staging', () => {
  const body = promptBody();
  assert.match(body, /skipped_gitignored/, 'skipped_gitignored must be named as an intentional success path');
  assert.match(body, /git add -f/, 'force-staging must be explicitly forbidden');
  assert.doesNotMatch(
    body,
    /SUMMARY\.md created AND committed(?![^\n]*OR)/,
    'the unconditional "created AND committed" criterion that drove git add -f must not appear bare',
  );
});

test('#3637: the compose step fails closed when the embeds are missing', () => {
  assert.match(
    content,
    /grep -q '<required_reading>'[\s\S]{0,400}exit 1/,
    'a prompt missing the required-reading contract must halt before spawn',
  );
  assert.match(
    content,
    /grep -q 'skipped_gitignored'[\s\S]{0,400}exit 1/,
    'a prompt missing the skip semantics must halt before spawn',
  );
});

test('#3637: embed PERFORMANCE is gated — an un-embedded template halts before spawn', () => {
  // The two template-completeness greps above cannot detect skipped embeds
  // (the placeholders live in the template itself). The performance gates
  // catch the raw-template dispatch: the provenance parenthetical must be
  // GONE and the persona marker must be substituted (#3637 review finding).
  assert.match(
    content,
    /grep -q 'Inline the actual contents'[\s\S]{0,300}exit 1/,
    'a prompt still carrying its compose-time placeholder means the embeds were skipped — halt',
  );
  assert.match(
    content,
    /grep -q '\\\$\{AGENT_SKILLS\}'[\s\S]{0,300}exit 1/,
    'an un-substituted persona marker means the role definition was not spliced — halt',
  );
});

test('#4266: embed PERFORMANCE is gated — an un-substituted TDD_APPLICABLE marker halts before spawn', () => {
  // Matches the ${AGENT_SKILLS} gate immediately above: a third performance gate for
  // the #4266/#4272 TDD-applicability predicate, halting before worktree creation
  // when the marker survives composition.
  assert.match(
    content,
    /grep -q '\\\$\{TDD_APPLICABLE'[\s\S]{0,300}exit 1/,
    'an un-substituted TDD_APPLICABLE marker means the TDD-applicability decision was not resolved into the prompt — halt',
  );
});

test('#3637: the gsd-executor ROLE DEFINITION is a mandatory embed with provenance', () => {
  // The agent-skills query alone is conditional (its block is a skills list
  // whenever the project configures agent_skills; only unconfigured
  // non-Claude projects get the full agent file via the #2454 fallback).
  // The child has no host subagent machinery — the role definition itself
  // must ride the prompt (#3637 acceptance bullets 1 and 5).
  const body = promptBody();
  assert.match(body, /agents\/gsd-executor\.md/, 'the role definition file must be named as an embedded source');
  assert.match(body, /steps\s*0\/0a\/0b/, 'the per-commit HEAD/cwd-drift/path-guard discipline must be pointed at');
});

test('#3637: prior-wave summaries are required reading (parallel waves must not clobber siblings)', () => {
  const body = promptBody();
  assert.match(body, /prior_wave_summaries/, 'prior-wave SUMMARY files must be required reading on this parallel-wave backend');
});

test('#3637: the persona rides the prompt (${AGENT_SKILLS}), same as the harness path', () => {
  assert.match(promptBody(), /\$\{AGENT_SKILLS\}/, 'the gsd-executor persona variable must be spliced into the prompt');
});

test('#3637: the prompt body contains no single-quote character (single-quoted assignment)', () => {
  const body = promptBody();
  const startQuote = body.indexOf("'");
  const rest = body.slice(startQuote + 1);
  assert.ok(!rest.includes("'"), 'the prompt body must be free of apostrophes or the shell assignment breaks');
});
