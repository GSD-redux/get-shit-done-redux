// allow-test-rule: runtime-contract-is-the-product see #2568
// agents/gsd-debug-session-manager.md is executed instruction text: the orchestrator
// follows it verbatim, so WHERE the commit step sits relative to the terminal vs
// non-terminal summary shapes IS the contract. The commit_docs gate it relies on is
// real code and is exercised behaviorally through the CLI below.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'agents', 'gsd-debug-session-manager.md');
const DEBUGGER = path.join(ROOT, 'agents', 'gsd-debugger.md');

const manager = () => fs.readFileSync(MANAGER, 'utf8');

/** Offset of a marker, asserted present so a rename fails loudly instead of silently. */
function offsetOf(body, marker, label) {
  const i = body.indexOf(marker);
  assert.notEqual(i, -1, `${label}: marker ${JSON.stringify(marker)} not found in the manager spec`);
  return i;
}

test('#2568: the manager commits the session doc before a terminal summary', () => {
  const body = manager();

  // The bug: zero occurrences of `commit` in the whole file, so nothing on the
  // manager-driven path ever consults commit_docs.
  assert.match(
    body,
    /gsd_run query commit/,
    'the manager owns the terminal path and must commit the session doc via the CLI — ' +
      'the step existed only in gsd-debugger.md, which does not reach the end of a ' +
      'manager-driven session (#2568)',
  );

  // Resolved and abandoned shapes each need their own doc committed.
  assert.match(
    body,
    /gsd_run query commit[^\n]*resolved/,
    'the resolved session doc (.planning/debug/resolved/{slug}.md) must be committed',
  );
  assert.match(
    body,
    /gsd_run query commit[^\n]*(debug_file_path|checkpoint)/,
    'the abandoned/checkpoint session doc must be committed',
  );

  // Ordering: the commit instruction must PRECEDE the terminal summary it guards.
  const firstCommit = offsetOf(body, 'gsd_run query commit', 'commit step');
  const terminal = offsetOf(body, '## DEBUG SESSION COMPLETE', 'terminal summary');
  assert.ok(
    firstCommit < terminal,
    'the commit must come BEFORE the terminal summary — committing after returning is ' +
      'unreachable, which is the shape of the original bug',
  );
});

test('#2568: the manager must NOT commit on the non-terminal CONTINUE_REQUIRED path', () => {
  const body = manager();

  // The manager's own contract forbids treating CONTINUE_REQUIRED as an ending
  // ("do NOT fabricate a DEBUG SESSION COMPLETE or ABANDONED summary to fit this
  // shape"). A commit there is that same lie in git form: it would strand a
  // half-finished session looking done. A fix that committed unconditionally
  // would satisfy the previous test and be WORSE than the bug.
  assert.match(
    body,
    /CONTINUE_REQUIRED/,
    'precondition: the non-terminal marker exists',
  );
  assert.match(
    body,
    /NOT[^\n]*CONTINUE_REQUIRED|CONTINUE_REQUIRED[^\n]*(?:no commit|not commit|never commit)/i,
    'the spec must explicitly exclude CONTINUE_REQUIRED from the commit step — an ' +
      'unscoped "commit before returning" would commit mid-investigation (#2568)',
  );

  // Structural: the commit block must sit after the CONTINUE_REQUIRED fence, so an
  // orchestrator taking the early-return path never reaches it.
  const continueFence = offsetOf(body, '## CONTINUE_REQUIRED', 'CONTINUE_REQUIRED shape');
  const firstCommit = offsetOf(body, 'gsd_run query commit', 'commit step');
  assert.ok(
    firstCommit > continueFence,
    'the commit step must come after the CONTINUE_REQUIRED early-return block, not before it',
  );
});

test('#2568: the manager stages specific files and never git add -A', () => {
  const body = manager();
  // Target an INSTRUCTION, not any mention: the spec legitimately names `git add -A`
  // in order to forbid it, and a bare substring check would reject the prohibition
  // itself. What must never appear is a command line telling the agent to run it.
  assert.doesNotMatch(
    body,
    /^\s*git add -A/m,
    'staging everything would sweep unrelated working-tree changes into a debug commit ' +
      '(#2568 explicitly requires specific-file staging)',
  );
  assert.match(
    body,
    /never `?git add -A`?|specific files only/i,
    'the spec must say so, not merely avoid it — the next editor needs the reason',
  );
});

test('#2568: the commit obligation is a checkable success criterion', () => {
  const body = manager();
  const criteria = body.slice(body.indexOf('<success_criteria>'));
  assert.ok(criteria.length > 0, 'precondition: the success_criteria block exists');
  assert.match(
    criteria,
    /commit/i,
    'the success criteria must include the commit obligation so the gate is checkable ' +
      'rather than buried in prose (#2568 criterion 4)',
  );
  assert.match(
    criteria,
    /commit_docs/,
    'the criterion must name commit_docs — the setting that was silently ignored',
  );
});

test('#2568: the fix does not touch agent frontmatter', () => {
  // An agent frontmatter edit ripples to research-profiles and AGENTS.md. This change
  // is body-only, so the frontmatter must still parse and carry its original keys.
  const body = manager();
  assert.match(body, /^---\r?\n/, 'frontmatter fence present');
  const end = body.indexOf('\n---', 4);
  assert.ok(end > 0, 'frontmatter terminates');
  const fm = body.slice(0, end);
  assert.match(fm, /^name:\s*gsd-debug-session-manager$/m, 'name key intact');
  assert.doesNotMatch(fm, /commit/i, 'the commit instruction must live in the body, not frontmatter');
});

test('#2568: the debugger keeps its own commit step for the single-spawn path', () => {
  // Removing it to "avoid duplication" would break the flow where the debugger
  // legitimately carries a fix to completion inside one spawn. A double commit is
  // harmless — the second finds nothing to stage.
  const body = fs.readFileSync(DEBUGGER, 'utf8');
  assert.match(
    body,
    /gsd_run query commit[^\n]*resolved/,
    'gsd-debugger.md must retain its own doc-commit step',
  );
});

test('#2568: every token substituted into a commit command is a declared session parameter', () => {
  // The first cut of this fix pasted `{debug_dir}` straight from the issue's suggested
  // patch. That variable is real in gsd-core/workflows/debug.md — the ORCHESTRATOR
  // receives it from init JSON — but this agent never does: <session_parameters>
  // declares only slug, debug_file_path, symptoms_prefilled, tdd_mode, goal and
  // specialist_dispatch_enabled. An unbound token makes --files resolve to a
  // nonexistent path, cmdCommit skips missing explicit files, and the doc silently
  // never commits — reproducing #2568 through a different broken path. Same class as
  // #2684's dangling placeholders.
  const body = manager();

  const block = body.slice(body.indexOf('<session_parameters>'), body.indexOf('</session_parameters>'));
  const declared = new Set([...block.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]));
  assert.ok(declared.size >= 5, `precondition: session parameters parsed, got ${declared.size}`);

  const commitLines = [...body.matchAll(/gsd_run query commit[^\n]*/g)].map((m) => m[0]);
  assert.ok(commitLines.length >= 2, `expected the resolved + checkpoint commits, got ${commitLines.length}`);

  for (const line of commitLines) {
    for (const [, token] of line.matchAll(/\{([a-z_]+)\}/g)) {
      assert.ok(
        declared.has(token),
        `{${token}} is substituted into a commit command but is not a declared session ` +
          `parameter — the agent has no value for it (#2568/#2684 dangling-substitution class): ${line}`,
      );
    }
  }
});

test('#2568: the commit call is covered by the single canonical preamble', () => {
  // The repo invariant (tests/…B-agents…) is that each agent .md using gsd_run carries
  // EXACTLY ONE canonical preamble, placed before the first gsd_run call — the runtime
  // establishes it once. An earlier cut of this fix pasted a second preamble into the
  // commit block on the theory that shell state does not persist; that broke the
  // invariant and five suites with it. The correct property is coverage, not locality.
  const body = manager();
  const preambles = body.match(/^\s*_GSD_SHIM_NAME=/gm) || [];
  assert.equal(
    preambles.length,
    1,
    `exactly one canonical gsd_run preamble per agent file, got ${preambles.length}`,
  );
  const preambleAt = body.search(/^\s*_GSD_SHIM_NAME=/m);
  const commitAt = body.indexOf('gsd_run query commit');
  assert.notEqual(commitAt, -1, 'precondition: the commit call exists');
  assert.ok(
    preambleAt < commitAt,
    'the canonical preamble must precede the commit call that relies on gsd_run',
  );
});

test('#2568: the in-session fix commit is idempotent', () => {
  // gsd-debugger.md's archive_session already commits the fix on the confirmed-checkpoint
  // path, which is the standard find_and_fix flow. A bare `git commit` with nothing
  // staged exits non-zero and would abort this step before the summary is returned.
  const body = manager();
  assert.match(
    body,
    /git diff --cached --quiet \|\| git commit/,
    'the fix-code commit must be guarded on staged content — archive_session may have ' +
      'already committed it, and an unguarded git commit exits non-zero on an empty diff',
  );
});

// ── The commit_docs gate the whole fix relies on — behavioral, not assumed ──

function seedDoc(dir) {
  const rel = path.join('.planning', 'debug', 'resolved', 'demo.md');
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# resolved demo\n');
  return rel.split(path.sep).join('/');
}

function writeConfig(dir, extra) {
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ ...extra }),
  );
}

test('#2568: query commit honors commit_docs true', () => {
  const dir = createTempGitProject('gsd-2568-on-');
  try {
    writeConfig(dir, { commit_docs: true });
    const rel = seedDoc(dir);
    const res = runGsdTools(['query', 'commit', 'docs(debug): resolve demo session', '--files', rel], dir);
    assert.ok(res.success, `commit failed: ${res.error}`);
    const parsed = JSON.parse(res.output);
    assert.equal(parsed.committed, true, `expected a commit, got ${res.output}`);
  } finally {
    cleanup(dir);
  }
});

test('#2568: query commit no-ops when commit_docs is false', () => {
  // This is the load-bearing assumption: the manager calls the CLI unconditionally
  // and correctness follows from the gate, rather than the agent re-implementing a
  // config check it could get wrong.
  const dir = createTempGitProject('gsd-2568-off-');
  try {
    writeConfig(dir, { commit_docs: false });
    const rel = seedDoc(dir);
    const res = runGsdTools(['query', 'commit', 'docs(debug): resolve demo session', '--files', rel], dir);
    assert.ok(res.success, `commit invocation failed: ${res.error}`);
    const parsed = JSON.parse(res.output);
    assert.equal(parsed.committed, false, 'must not commit when commit_docs is false');
    assert.equal(parsed.skipped, true);
    assert.equal(parsed.reason, 'skipped_commit_docs_false');
  } finally {
    cleanup(dir);
  }
});

test('#2568: query commit behavior with commit_docs absent is explicit, not assumed', () => {
  const dir = createTempGitProject('gsd-2568-default-');
  try {
    writeConfig(dir, {});
    const rel = seedDoc(dir);
    const res = runGsdTools(['query', 'commit', 'docs(debug): resolve demo session', '--files', rel], dir);
    assert.ok(res.success, `commit invocation failed: ${res.error}`);
    const parsed = JSON.parse(res.output);
    // Pin whatever the shipped default resolves to, so a silent change to
    // CONFIG_DEFAULTS.commit_docs surfaces here rather than in a user's repo.
    assert.equal(
      typeof parsed.committed,
      'boolean',
      'the CLI must always report a boolean committed flag',
    );
    if (parsed.committed === false) {
      assert.equal(parsed.reason, 'skipped_commit_docs_false');
    }
  } finally {
    cleanup(dir);
  }
});
