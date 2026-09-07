// docs-guard-exempt: docs/CONFIGURATION.md and docs/reference/state-md.md are cited only in comments; never read.
// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - State
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, createTempDir, createTempProject, createTempGitProject, cleanup, captureFdSync } = require('./helpers.cjs');
const stateTestHelpers = require('./helpers.cjs');
const stateTestProcessSeam = require('./helpers/process-seam.cjs');
// runGsdTools's legacy shape DROPS stderr on a zero exit, and the #3862 contract
// is exactly that the divergence refusal is VISIBLE on stderr while still exiting
// 0. Drive the process seam directly for those assertions — the same adapter
// tests/milestone-lock.test.cjs uses for the sibling warning this one mirrors.
function runToolsWithStderr(args, cwd, env = {}) {
  return stateTestProcessSeam.runNode([stateTestHelpers.TOOLS_PATH, ...args], {
    cwd,
    // No `timeoutMs`: tests/helpers/process-seam.cjs owns this policy — omitting it
    // is that module's documented way to take its bounded DEFAULT_TIMEOUT_MS, and a
    // local copy would be a second place for the same value to drift.
    env: { ...process.env, ...stateTestHelpers.TEST_ENV_BASE, ...env },
  });
}
const { createFixture, seedWorkstream, writeState } = require('./fixtures/index.cjs');
// ADR-3473 §8.7 (#3872): git-fixture spawns for the state_head rows (10/11)
// go through the throw-preserving wrapper, never a raw execFileSync.
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3578 AC4 (MCP dispatch parity): drives the same `state complete-phase`
// command through the gsd_invoke_command MCP tool route instead of the CLI,
// mirroring the gsd-mcp-server.test.cjs `tools/call gsd_invoke_command`
// pattern (family/subcommand/args -> dispatchGsdCommand -> real subprocess).
const { handleMessage } = require('../gsd-core/bin/lib/mcp-server.cjs');
// ADR-3408 §8.3 Matrix A2/A3 (#3469): required fast-check property test — the
// composed cmdPhaseComplete/readModifyWriteStateMd write-seam identity.
const fc = require('fast-check');
// #3187 (ADR-3180 §7.7) matrix sections B/C: in-process access to the chain
// owner and its raw inputs, needed to compute the "owner's answer" a
// consumer's OBSERVABLE output is compared against (Decision 4c) — never the
// owner's return value against itself.
const stateLib = require('../gsd-core/bin/lib/state.cjs');
const stateTransitionMod = require('../gsd-core/bin/lib/state-transition.cjs');
const stateDocument = require('../gsd-core/bin/lib/state-document.cjs');
// #3699: the repo's one metacharacter-escape helper (local/no-adhoc-regex-escape).
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const frontmatterLib = require('../gsd-core/bin/lib/frontmatter.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const workstreamInventory = require('../gsd-core/bin/lib/workstream-inventory.cjs');
const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');

/**
 * Test-side helper mirroring the ad-hoc "## Heading ... up to next heading"
 * extraction previously hand-rolled at many call sites in this file — routes
 * through the canonical markdown-sectionizer seam instead. Returns an object
 * shaped like a regex exec match (`[1]` is the body) so existing call sites
 * that destructure `match[1]` keep working, or `null` when the heading is
 * absent (matching `String.prototype.match`'s null-on-no-match contract).
 */
function sectionMatchOf(text, headingName) {
  const section = collectSection(text, (h) => h.text.toLowerCase() === headingName.toLowerCase());
  return section ? [section.body, section.body] : null;
}

/**
 * Return the second cell of a headerless `| Label | Value |` row inside
 * `section` whose first cell equals `label` (case-insensitive), or null when
 * absent. STATE.md's Current Position/Configuration tables have no header/
 * delimiter row, so parseMarkdownTable's GFM-table contract does not apply —
 * splitTableRow is the correct-granularity seam call here.
 */
function pipeTableCell(section, label) {
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitTableRow(trimmed);
    if (cells[0] && cells[0].toLowerCase() === label.toLowerCase()) {
      return cells[1] !== undefined ? cells[1] : null;
    }
  }
  return null;
}
// Phase 12 (#3310, ADR-3180 §8.4 rule 3): `cmdStateValidate`'s `warnings` are
// now `Diagnostic[]` (S0NN codes), not bare strings, and `drift` is gone.
const { SEVERITY } = require('../gsd-core/bin/lib/health-diagnostic-types.cjs');
// #3468 matrix B8: distinguishes a controlled, structured CLI failure (an
// `error()` call, which always emits plain text even under --json-errors —
// see `#2979` in tests/cli-exit.test.cjs) from an uncaught internal crash
// (any non-ExitError throw, which under --json-errors emits a JSON envelope
// carrying `reason: ERROR_REASON.SDK_FAIL_FAST`). The §8.2 invariant throw is
// exactly the latter shape, so this is the structured, non-prose signal B8
// asserts against.
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

/** First `Diagnostic` in `output.warnings` carrying the given S0NN code, or `undefined`. */
function findWarning(output, code) {
  return (output.warnings || []).find((w) => w.code === code);
}

/** Phase 12 breaking-change proof (§8.4 rule 3, test matrix row 18): `drift` never appears. */
function assertNoDriftKey(output) {
  assert.ok(!Object.prototype.hasOwnProperty.call(output, 'drift'), 'output must not contain a drift key');
}

function writePassedVerification(tmpDir, phaseDirName, paddedPhase) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'phases', phaseDirName, `${paddedPhase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
}

/**
 * CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs" — extract
 * the body `Progress` field through the repo's own field extractor (never a
 * raw substring/regex match against the whole rendered STATE.md) and return
 * the parsed percent number, so `state update-progress` body-bar tests
 * assert on a typed value instead of the rendered text.
 */
function bodyProgressPercent(stateMdContent) {
  const raw = stateDocument.stateExtractField(stateMdContent, 'Progress');
  if (raw === null) return null;
  const match = raw.match(/(\d{1,3})%/);
  return match ? Number(match[1]) : null;
}

/**
 * Run `fn` while capturing every fd-1 write a `cmdState*` handler's
 * `output()` performs (it writes via a raw `fs.writeSync(1, ...)`, never
 * `console.log`/`process.stdout.write`). Standalone helper with no test
 * context, so the try/finally restore is CONTRIBUTING-compliant (mirrors
 * `tests/state-rebuild-cli.test.cjs`'s identical helper — needed here too
 * because the #3187 B6/B7 IO-failure-injection rows require `mock.method`
 * on `fs`, which only intercepts an IN-PROCESS call; a `runGsdTools`
 * subprocess would not observe the parent process's mock).
 */
function captureStdout(fn) {
  return captureFdSync(1, fn);
}

function readShippedStateTemplateBody(replacements) {
  const templatePath = path.join(__dirname, '..', 'gsd-core', 'templates', 'state.md');
  const template = fs.readFileSync(templatePath, 'utf-8');
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own state.md template, fixed-size author-controlled content
  const fencedDocument = template.match(/```markdown\r?\n([\s\S]*?)```/); // allow-adhoc-markdown: deliberately independent of the generator's own fence-handling — regresses #3873
  assert.ok(fencedDocument, 'gsd-core/templates/state.md must contain a fenced markdown document');

  let body = fencedDocument[1];
  for (const [target, replacement] of replacements) {
    assert.ok(body.includes(target), `shipped state template must contain replacement target: ${target}`);
    body = body.replace(target, replacement);
  }
  return body;
}
describe('state-snapshot command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('extracts basic fields from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Current Phase Name:** API Layer
**Total Phases:** 6
**Current Plan:** 03-02
**Total Plans in Phase:** 3
**Status:** In progress
**Progress:** 45%
**Last Activity:** 2024-01-15
**Last Activity Description:** Completed 03-01-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '03', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'API Layer', 'phase name extracted');
    assert.strictEqual(output.total_phases, 6, 'total phases extracted');
    assert.strictEqual(output.current_plan, '03-02', 'current plan extracted');
    assert.strictEqual(output.total_plans_in_phase, 3, 'total plans extracted');
    assert.strictEqual(output.status, 'In progress', 'status extracted');
    assert.strictEqual(output.progress_percent, 45, 'progress extracted');
    assert.strictEqual(output.last_activity, '2024-01-15', 'last activity date extracted');
  });

  test('extracts decisions table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| 01 | Use Prisma | Better DX than raw SQL |
| 02 | JWT auth | Stateless authentication |
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions.length, 2, 'should have 2 decisions');
    assert.strictEqual(output.decisions[0].phase, '01', 'first decision phase');
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'first decision summary');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than raw SQL', 'first decision rationale');
  });

  test('extracts blockers list', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Blockers

- Waiting for API credentials
- Need design review for dashboard
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.blockers, [
      'Waiting for API credentials',
      'Need design review for dashboard',
    ], 'blockers extracted');
  });

  test('extracts session continuity info', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Session

**Last Date:** 2024-01-15
**Stopped At:** Phase 3, Plan 2, Task 1
**Resume File:** .planning/phases/03-api/03-02-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.session.last_date, '2024-01-15', 'session date extracted');
    assert.strictEqual(output.session.stopped_at, 'Phase 3, Plan 2, Task 1', 'stopped at extracted');
    assert.strictEqual(output.session.resume_file, '.planning/phases/03-api/03-02-PLAN.md', 'resume file extracted');
  });

  test('handles paused_at field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Paused At:** Phase 3, Plan 1, Task 2 - mid-implementation
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, 'Phase 3, Plan 1, Task 2 - mid-implementation', 'paused_at extracted');
  });

  // ─── Regression: #2956 — Phase must be scoped to ## Current Position ──────
  // Third generation of #2444 / #2567. Stopped At / Paused At were scoped to
  // ## Session; Phase (which canonically lives in ## Current Position per
  // gsd-core/templates/state.md) was left unscoped, so a historical Phase: /
  // **Phase:** line in an archive section silently overwrote current_phase on
  // every write. Because current_phase is routing input for gsd-progress / --next,
  // the rewind routes work to the wrong phase — not merely a stale display.

  test('#2956 scopes Phase to ## Current Position — bold archive line below the section (shape B)', () => {
    // Bold **Phase:** 19 in an archive BELOW ## Current Position. The unscoped
    // extractor's bold pattern wins outright (it is tried first, unanchored),
    // so the read returns 19 instead of 22. Scoping to the section fixes it.
    const stateContent = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene) — COMPLETE',
      '',
      '## Archive — earlier milestones',
      '',
 '**Phase:** 19 **complete — shipped v2.43.0**',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '22', 'current_phase must come from ## Current Position, not the bold archive line');
  });

  test('#2956 scopes Phase to ## Current Position — plain archive line above the section (shape C)', () => {
    // Plain archive Phase: 19 ABOVE ## Current Position. Without scoping the
    // plain pattern (^Phase:, /im) matches the first line-start occurrence in
    // document order — the archive line — and returns 19 instead of 22.
    const stateContent = [
      '# Project State',
      '',
      '## Archive — earlier milestones',
      '',
      'Phase: 19 **complete — shipped v2.43.0**',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene) — COMPLETE',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '22', 'current_phase must come from ## Current Position, not the plain archive line above it');
  });

  test('#2956 scopes Phase to ### Current Position (bootstrap h3 variant)', () => {
    // gsd-core/templates/state.md ships a bootstrap layout that uses a level-3
    // ### Current Position heading. The section matcher must recognise BOTH h2
    // and h3, mirroring how matchSessionSection recognises ## Session and
    // ## Session Continuity — matching only h2 would silently drop the h3 shape.
    const stateContent = [
      '# Project State',
      '',
      '### Current Position',
      '',
      'Phase: 22 (Documentation hygiene)',
      '',
      '### Archive',
      '',
 '**Phase:** 19',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '22', 'current_phase must resolve from the h3 ### Current Position section');
  });

  test('#2956 scopes Phase to ## Current Position under CRLF', () => {
    // The #2444 seam was CRLF-fixed by migrating onto collectSection (which
    // strips the trailing \r before heading-text extraction). The Phase scope
    // must inherit that CRLF tolerance — a hand-rolled [ \t]*\n boundary would
    // silently fail to match a ## Current Position\r\n heading.
    const stateContent = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene)',
      '',
      '## Archive — earlier milestones',
      '',
 '**Phase:** 19',
      '',
    ].join('\r\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '22', 'current_phase must come from ## Current Position under CRLF');
  });

  test('#2956 ignores a Phase token in decisions prose outside ## Current Position', () => {
    // A decisions-table row or prose mention of "Phase 19" elsewhere is NOT the
    // current phase. Scoping it out is correct, not a regression — this is the
    // over-broad-fix guard.
    const stateContent = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene)',
      '',
      '### Decisions',
      '',
      '| Decided to defer Phase 19 to the next milestone | 2026-07-01 |',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '22', 'a Phase token in decisions prose must not leak into current_phase');
  });

  test('#2956 scopes Paused At to ## Session on the read path (parity with the write seam)', () => {
    // The WRITE seam (buildStateFrontmatter src/state.cts ~1576) already scopes
    // Paused At to ## Session. The READ seam (cmdStateSnapshot) read it
    // unscoped — a parity gap. A stale "Paused At:" in a Session Continuity
    // Archive below the real ## Session must not win on the read path.
    const stateContent = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene)',
      '',
      '## Session',
      '',
      '**Paused At:** Phase 22, Plan 1, Task 2 - mid-implementation',
      '',
      '## Session Continuity Archive',
      '',
      '**Paused At:** Phase 19, Plan 3 (stale)',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, 'Phase 22, Plan 1, Task 2 - mid-implementation', 'paused_at must come from ## Session, not the archive');
  });

  describe('--cwd override', () => {
    let outsideDir;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-test-outside-'));
    });

    afterEach(() => {
      cleanup(outsideDir);
    });

    test('supports --cwd override when command runs outside project root', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# Session State

**Current Phase:** 03
**Status:** Ready to plan
`
      );

      const result = runGsdTools(`state-snapshot --cwd "${tmpDir}"`, outsideDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.current_phase, '03', 'should read STATE.md from overridden cwd');
      assert.strictEqual(output.status, 'Ready to plan', 'should parse status from overridden cwd');
    });
  });

  test('returns error for invalid --cwd path', () => {
    const invalid = path.join(tmpDir, 'does-not-exist');
    const result = runGsdTools(`state-snapshot --cwd "${invalid}"`, tmpDir);
    assert.ok(!result.success, 'should fail for invalid --cwd');
    assert.ok(result.error.includes('Invalid --cwd'), 'error should mention invalid --cwd');
  });
});

// ─── Regression: #3265 — frontmatter wins over bold-body cell ─────────────

describe('state-snapshot — bug #3265 frontmatter precedence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns frontmatter status, not **Status:** value embedded in a body table cell', () => {
    // Reproduce the collision: frontmatter says "executing", but the body
    // contains a Markdown table cell with "**Status:** to ✅ COMPLETE ..."
    // which stateExtractField (bold pattern) would match before the YAML line.
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '## Recent Quick Tasks',
      '',
      '| Date | Task | Notes |',
      '|------|------|-------|',
      '| 2026-05-01 | Reopened Plan 19.5-05. **Status:** to ✅ COMPLETE | done |',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter status must win over the table cell's **Status:** match
    assert.strictEqual(output.status, 'executing', 'frontmatter status beats body table cell');
  });

  test('returns frontmatter current_plan, not bold body value when both present', () => {
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_plan, '19.5-05', 'frontmatter current_plan beats body bold value');
  });

  test('falls back to body extraction when no frontmatter block is present', () => {
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 07',
      '**Status:** paused',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // No frontmatter — body extraction must still work
    assert.strictEqual(output.status, 'paused', 'body extraction works without frontmatter');
    assert.strictEqual(output.current_phase, '07', 'body extraction works without frontmatter');
  });
});

describe('state mutation commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('add-decision preserves dollar amounts without corrupting Decisions section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '11-01', '--summary', 'Benchmark prices moved from $0.50 to $2.00 to $5.00', '--rationale', 'track cost growth'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-01\]: Benchmark prices moved from \$0\.50 to \$2\.00 to \$5\.00 — track cost growth/,
      'decision entry should preserve literal dollar values'
    );
    assert.strictEqual((state.match(/^## Decisions$/gm) || []).length, 1, 'Decisions heading should not be duplicated');
    assert.ok(!state.includes('No decisions yet.'), 'placeholder should be removed');
  });

  test('add-blocker preserves dollar strings without corrupting Blockers section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const result = runGsdTools(['state', 'add-blocker', '--text', 'Waiting on vendor quote $1.00 before approval'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Waiting on vendor quote \$1\.00 before approval/, 'blocker entry should preserve literal dollar values');
    assert.strictEqual((state.match(/^## Blockers$/gm) || []).length, 1, 'Blockers heading should not be duplicated');
  });

  test('add-decision supports file inputs to preserve shell-sensitive dollar text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const summaryPath = path.join(tmpDir, 'decision-summary.txt');
    const rationalePath = path.join(tmpDir, 'decision-rationale.txt');
    fs.writeFileSync(summaryPath, 'Price tiers: $0.50, $2.00, else $5.00\n');
    fs.writeFileSync(rationalePath, 'Keep exact currency literals for budgeting\n');

    const result = runGsdTools(
      `state add-decision --phase 11-02 --summary-file "${summaryPath}" --rationale-file "${rationalePath}"`,
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-02\]: Price tiers: \$0\.50, \$2\.00, else \$5\.00 — Keep exact currency literals for budgeting/,
      'file-based decision input should preserve literal dollar values'
    );
  });

  test('add-blocker supports --text-file for shell-sensitive text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const blockerPath = path.join(tmpDir, 'blocker.txt');
    fs.writeFileSync(blockerPath, 'Vendor quote updated from $1.00 to $2.00 pending approval\n');

    const result = runGsdTools(`state add-blocker --text-file "${blockerPath}"`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Vendor quote updated from \$1\.00 to \$2\.00 pending approval/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state json command (machine-readable STATE.md frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('state json command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('builds frontmatter on-the-fly from body when no frontmatter exists', () => {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version token)
    // is COMPLETE scope for windowing (§7.1) — without this, an absent
    // ROADMAP.md is UNREADABLE and the body-Progress-field fallback this
    // test exercises is withheld.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 05
**Current Phase Name:** Deployment
**Total Phases:** 8
**Current Plan:** 05-03
**Total Plans in Phase:** 4
**Status:** In progress
**Progress:** 60%
**Last Activity:** 2026-01-20
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'should have version 1.0');
    assert.strictEqual(output.current_phase, '05', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'Deployment', 'phase name extracted');
    assert.strictEqual(output.current_plan, '05-03', 'current plan extracted');
    assert.strictEqual(output.status, 'executing', 'status normalized to executing');
    assert.ok(output.last_updated, 'should have last_updated timestamp');
    assert.strictEqual(output.last_activity, '2026-01-20', 'last activity extracted');
    assert.ok(output.progress, 'should have progress object');
    assert.strictEqual(output.progress.percent, 60, 'progress percent extracted');
  });

  test('reads existing frontmatter when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: 1.0
current_phase: 03
status: paused
stopped_at: Plan 2 of Phase 3
---

# Project State

**Current Phase:** 03
**Status:** Paused
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'version from frontmatter');
    assert.strictEqual(output.current_phase, '03', 'phase from frontmatter');
    assert.strictEqual(output.status, 'paused', 'status from frontmatter');
    assert.strictEqual(output.stopped_at, 'Plan 2 of Phase 3', 'stopped_at from frontmatter');
  });

  test('normalizes various status values', () => {
    // #4186: recognition is an ANCHORED whole-field vocabulary match. The
    // vocabulary's own values normalize to their token; prefix/suffix NARRATIVE
    // prose ('Paused at Plan 3') passes through verbatim — a visible paragraph
    // beats a guessed token — and the legacy bare `Milestone complete` stays
    // recognized (reader-side legacy vocabulary, ADR-2207 removed the writers).
    const statusTests = [
      { input: 'In progress', expected: 'executing' },
      { input: 'Ready to execute', expected: 'executing' },
      { input: 'Paused', expected: 'paused' },
      { input: 'Paused at Plan 3', expected: 'Paused at Plan 3' },
      { input: 'Ready to plan', expected: 'planning' },
      { input: 'Phase complete — ready for verification', expected: 'verifying' },
      { input: 'Milestone complete', expected: 'completed' },
      { input: 'All phases complete', expected: 'completed' },
    ];

    for (const { input, expected } of statusTests) {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# State\n\n**Current Phase:** 01\n**Status:** ${input}\n`
      );

      const result = runGsdTools('state json', tmpDir);
      assert.ok(result.success, `Command failed for status "${input}": ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.status, expected, `"${input}" should normalize to "${expected}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md frontmatter sync (write operations add frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('STATE.md frontmatter sync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state update adds frontmatter to STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 02
**Status:** Ready to execute
`
    );

    const result = runGsdTools('state update Status "Executing Plan 1"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should start with frontmatter delimiter');
    assert.ok(content.includes('gsd_state_version: "1.0"'), 'should have version field');
    assert.ok(content.includes('current_phase: 02'), 'frontmatter should have current phase');
    assert.ok(content.includes('**Current Phase:** 02'), 'body field should be preserved');
    assert.ok(content.includes('**Status:** Executing Plan 1'), 'updated field in body');
  });

  test('state patch adds frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 04
**Status:** Planning
**Current Plan:** 04-01
`
    );

    const result = runGsdTools('state patch --Status "In progress" --"Current Plan" 04-02', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should have frontmatter after patch');
  });

  test('frontmatter is idempotent on multiple writes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01
**Status:** Ready to execute
`
    );

    runGsdTools('state update Status "In progress"', tmpDir);
    runGsdTools('state update Status "Paused"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const delimiterCount = (content.match(/^---$/gm) || []).length;
    assert.strictEqual(delimiterCount, 2, 'should have exactly one frontmatter block (2 delimiters)');
    assert.ok(content.includes('status: paused'), 'frontmatter should reflect latest status');
  });

  test('#2956 write-then-read does not rewind current_phase past an archive Phase line', () => {
    // The write seam (buildStateFrontmatter) and the read seam (cmdStateSnapshot)
    // must agree: a state write that re-syncs frontmatter must not pick up the
    // archive **Phase:** 19 line and write current_phase: 19, which the next
    // state-snapshot read would then surface. Round-trip must stay at 22.
    //
    // The fixture carries a **Status:** field so `state update Status` performs
    // a real field update (updated:true) and forces the frontmatter resync
    // through buildStateFrontmatter — without an existing Status field the
    // update is a no-op (updated:false) and no write occurs.
    const stateContent = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 22 (Documentation hygiene)',
      '',
      '**Status:** Ready',
      '',
      '## Archive — earlier milestones',
      '',
 '**Phase:** 19 **complete — shipped v2.43.0**',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    // state update forces a frontmatter sync through buildStateFrontmatter.
    const writeResult = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(writeResult.success, `write failed: ${writeResult.error}`);
    const writeOutput = JSON.parse(writeResult.output);
    assert.strictEqual(writeOutput.updated, true, 'state update must perform a real field update to force the resync');

    // The persisted frontmatter must not have rewound to the archive phase.
    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/current_phase:\s*22\b/m.test(written), 'written frontmatter current_phase must be 22 (not the archive 19)');
    assert.ok(!/^current_phase:\s*19\b/m.test(written), 'written frontmatter must NOT carry the archive phase 19');

    // And a fresh read must agree.
    const readResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(readResult.success, `read failed: ${readResult.error}`);
    const output = JSON.parse(readResult.output);
    assert.strictEqual(output.current_phase, '22', 'read-after-write current_phase must stay 22 (round-trip agreement)');
  });

  test('preserves frontmatter status when body Status field is missing', () => {
    // Simulate: frontmatter has status: executing, but body lost Status: field
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter — use state update on a field that exists
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('status: executing'), 'should preserve existing status, not overwrite with unknown');
    assert.ok(!content.includes('status: unknown'), 'should not contain unknown status');
  });

  test('#2202: preserves unknown frontmatter keys the schema does not own', () => {
    // Regression: a mutating verb rewrites STATE.md via syncStateFrontmatter,
    // which rebuilds frontmatter from the body + schema. Before #2202 it dropped
    // any frontmatter key the schema does not own; custom/tooling keys must
    // survive every write.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
custom_tracking_id: ABC-123
team: platform
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter.
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(content, /custom_tracking_id: ABC-123/, 'unknown key custom_tracking_id must be preserved');
    assert.match(content, /team: platform/, 'unknown key team must be preserved');
    // Schema-owned keys still win / survive alongside the carried-forward keys.
    assert.ok(content.includes('status: executing'), 'schema-owned status still preserved');
  });

  test('#3257: full-line frontmatter comments survive a mutating state verb', () => {
    // syncStateFrontmatter rebuilds frontmatter via buildStateFrontmatter (fresh object)
    // + an Object.keys carry-forward. Without propagating the comment channel, the
    // comment is lost HERE even though the parse→reconstruct pair preserves it in
    // isolation. This is the e2e path the issue is filed against.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
# NOTE: current_phase is hand-maintained here while the roadmap is in flux
current_phase: 3
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter.
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      content.includes('# NOTE: current_phase is hand-maintained here while the roadmap is in flux'),
      `full-line frontmatter comment must survive a mutating verb; got:\n${content}`,
    );
    // The mutation itself still applied.
    assert.ok(content.includes('03-03'), 'the state update still took effect');
  });

  // #3742 — comment survival must not depend on the document body: a
  // column-0 comment died whenever the body had no **Current Phase:** line
  // (the preservation restore re-added the key but nothing re-attached the
  // comment channel), and an indented comment under progress: died always
  // (the channel only ever knew top-level keys).
  test('#3742: comments survive begin-phase with and without a body Current Phase line', () => {
    const COL0 = '# PROVENANCE-COL0: hand-counted; do not resync';
    const NESTED = '# PROVENANCE-NESTED: nested under progress';
    for (const withBodyLine of [true, false]) {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        [
          '---',
          'gsd_state_version: 1.0',
          COL0,
          'current_phase: 01',
          'current_phase_name: probe-phase',
          'status: executing',
          'last_updated: "2026-08-10T00:00:00.000Z"',
          'progress:',
          '  ' + NESTED,
          '  total_phases: 2',
          '  completed_phases: 0',
          '  total_plans: 1',
          '  completed_plans: 0',
          '---',
          '',
          '## Current Position',
          '',
          '**Status:** Executing',
          ...(withBodyLine ? ['**Current Phase:** 01'] : []),
          '',
        ].join('\n'),
      );

      runGsdTools('state begin-phase --phase 01 --name probe-phase --plans 1', tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        content.includes(COL0),
        `#3742: column-0 comment must survive begin-phase (body Current Phase line: ${withBodyLine}); got:\n${content}`,
      );
      assert.ok(
        content.includes(NESTED),
        `#3742: indented comment under progress must survive begin-phase (body Current Phase line: ${withBodyLine}); got:\n${content}`,
      );
    }
  });

  test('#3742: comments survive state update (the issue\'s anomaly verb)', () => {
    const COL0 = '# PROVENANCE-COL0: do not resync';
    const NESTED = '# PROVENANCE-NESTED: nested under progress';
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        COL0,
        'current_phase: 3',
        'status: executing',
        'progress:',
        '  ' + NESTED,
        '  total_phases: 9',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** Executing',
        '',
      ].join('\n'),
    );

    runGsdTools('state update Status Paused', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes(COL0), `#3742: column-0 comment must survive state update; got:\n${content}`);
    assert.ok(content.includes(NESTED), `#3742: nested comment must survive state update; got:\n${content}`);
  });

  test('#3742: trailing comments do not duplicate across repeated writes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 3',
        'status: executing',
        '# TRAILING: do not resync',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** Executing',
        '',
      ].join('\n'),
    );

    for (let i = 0; i < 3; i++) {
      runGsdTools('state update Status Paused', tmpDir);
    }

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const count = (content.match(/# TRAILING: do not resync/g) || []).length;
    assert.strictEqual(count, 1, `#3742: trailing comment must appear exactly once after repeated writes, got ${count}:\n${content}`);
  });

  test('round-trip: write then read via state json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 07
**Current Phase Name:** Production
**Total Phases:** 10
**Status:** In progress
**Current Plan:** 07-05
**Progress:** 70%
`
    );

    // #4186: use the handler vocabulary's real form (`Executing Phase N`,
    // state-transition.cts:1216) — narrative variants are no longer guessed.
    runGsdTools('state update Status "Executing Phase 5"', tmpDir);

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '07', 'round-trip: phase preserved');
    assert.strictEqual(output.current_phase_name, 'Production', 'round-trip: phase name preserved');
    assert.strictEqual(output.status, 'executing', 'round-trip: status normalized');
    assert.ok(output.last_updated, 'round-trip: timestamp present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateExtractField and stateReplaceField helpers
// ─────────────────────────────────────────────────────────────────────────────

const { stateExtractField, stateReplaceField, stateReplaceFieldWithFallback } = require('../gsd-core/bin/lib/state.cjs');

describe('stateExtractField and stateReplaceField helpers', () => {
  // stateExtractField tests

  test('extracts simple field value', () => {
    const content = '# State\n\n**Status:** In progress\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'In progress', 'should extract simple field value');
  });

  test('extracts field with colon in value', () => {
    const content = '# State\n\n**Last Activity:** 2024-01-15 — Completed plan\n';
    const result = stateExtractField(content, 'Last Activity');
    assert.strictEqual(result, '2024-01-15 — Completed plan', 'should return full value after field pattern');
  });

  test('returns null for missing field', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('is case-insensitive on field name', () => {
    const content = '# State\n\n**status:** Active\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'Active', 'should match field name case-insensitively');
  });

  // (#3812) docs/reference/state-md.md's "### Current Position" section
  // promises: every field there is single-valued, and duplicates resolve by
  // FORM first (bold `**F:**` anywhere, then plain `^F:`, then pipe-table),
  // and only within the winning form does first-occurrence win. #2956 already
  // fixed the INTER-section case (a duplicate in a different section never
  // shadows the real one) by scoping to `## Current Position`; these rows
  // pin the INTRA-section case #2956 never addressed — every fixture here
  // duplicates the field WITHIN the same `## Current Position` section, so a
  // reader that merely scopes correctly (and gets first-occurrence right by
  // accident) cannot pass. Each row is exercised through the real production
  // chain — `stateCurrentPositionSlice` (the function `state.cts`'s private
  // `matchCurrentPositionSection` delegates to) feeding `stateExtractField`
  // — not bare `stateExtractField` over hand-scoped content, so section
  // scoping is genuinely exercised rather than assumed. See
  // .gsd/phase/docs-3812-current-position-cardinality/50-test-matrix.md.

  function extractViaProductionChain(body, fieldName) {
    const scope = stateDocument.stateCurrentPositionSlice(body) ?? body;
    return stateExtractField(scope, fieldName);
  }

  test('T1: plain-then-plain intra-section duplicate resolves to the first occurrence (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 5 (First, plain)',
      'Plan: 1 of 3',
      'Phase: 9 of 9 (Second, plain)',
    ].join('\n');

    const result = extractViaProductionChain(content, 'Phase');
    assert.strictEqual(
      result,
      '1 of 5 (First, plain)',
      'within one form (plain), a duplicated Phase field must resolve to the first occurrence'
    );
  });

  test('T2: mixed-form intra-section duplicate — later BOLD line beats an earlier plain line (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 5 (First, plain)',
      'Plan: 1 of 3',
      '**Phase:** 9 of 9 (Second, bold)',
    ].join('\n');

    const result = extractViaProductionChain(content, 'Phase');
    assert.strictEqual(
      result,
      '9 of 9 (Second, bold)',
      'bold form outranks plain form regardless of document order, per docs/reference/state-md.md'
    );
  });

  test('T3: an indented Phase line is invisible to the plain form; the later un-indented line wins (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      '    Phase: 1 of 5 (Indented, ignored)',
      'Phase: 9 of 9 (Un-indented, matches)',
      'Plan: 1 of 3',
    ].join('\n');

    const result = extractViaProductionChain(content, 'Phase');
    assert.strictEqual(
      result,
      '9 of 9 (Un-indented, matches)',
      'the plain form anchors at true line-start; an indented line never matches it'
    );
  });

  test('T4: a sibling field between duplicated Phase lines resolves to its own value (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 5 (First, plain)',
      'Plan: 2 of 3',
      'Phase: 9 of 9 (Second, plain)',
    ].join('\n');

    const phase = extractViaProductionChain(content, 'Phase');
    const plan = extractViaProductionChain(content, 'Plan');
    assert.strictEqual(
      phase,
      '1 of 5 (First, plain)',
      'Phase must still resolve to the first occurrence within its form with a sibling field in between'
    );
    assert.strictEqual(
      plan,
      '2 of 3',
      'Plan must resolve to its own value, not be affected by the duplicated Phase field'
    );
  });

  test('T5: a bold Phase line in a DIFFERENT section never shadows the plain value inside Current Position (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 5 (in section, plain)',
      'Plan: 1 of 3',
      '',
      '## Archive',
      '',
      '**Phase:** 88 (bold, other section — must NOT win)',
    ].join('\n');

    const result = extractViaProductionChain(content, 'Phase');
    assert.strictEqual(
      result,
      '1 of 5 (in section, plain)',
      'the form ranking applies only within the Current Position section — a bold line elsewhere must not outrank the in-section plain value'
    );

    // Discrimination: a reader that runs stateExtractField over the WHOLE
    // document (skipping the #2956 section scope) disagrees with production
    // here — it lets the out-of-section bold line win.
    const wholeDocumentResult = stateExtractField(content, 'Phase');
    assert.strictEqual(
      wholeDocumentResult,
      '88 (bold, other section — must NOT win)',
      'sanity check: an unscoped reader gets this case wrong, which is exactly the bug this row pins'
    );
    assert.notStrictEqual(result, wholeDocumentResult, 'the scoped and unscoped readers must disagree on this fixture');
  });

  test('T6: a bold Phase line with only trailing whitespace resolves to an empty string, not a fallthrough (#3812)', () => {
    const content = [
      '# STATE',
      '',
      '## Current Position',
      '',
      '**Phase:**   ',
      'Phase: 1 of 5 (plain, must NOT be used)',
      'Plan: 1 of 3',
    ].join('\n');

    const result = extractViaProductionChain(content, 'Phase');
    assert.strictEqual(
      result,
      '',
      'the bold form wins outright even when its captured value is only trailing whitespace; it must not fall through to the plain line below'
    );
  });

  // stateReplaceField tests

  test('replaces field value', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content, not null');
    assert.ok(result.includes('**Status:** New'), 'output should contain updated field value');
    assert.ok(!result.includes('**Status:** Old'), 'output should not contain old field value');
  });

  test('returns null when field not found', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('preserves surrounding content', () => {
    const content = [
      '# Project State',
      '',
      '**Phase:** 03',
      '**Status:** Old',
      '**Last Activity:** 2024-01-15',
      '',
      '## Notes',
      'Some notes here.',
    ].join('\n');

    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content');
    assert.ok(result.includes('**Phase:** 03'), 'Phase line should be unchanged');
    assert.ok(result.includes('**Status:** New'), 'Status should be updated');
    assert.ok(result.includes('**Last Activity:** 2024-01-15'), 'Last Activity line should be unchanged');
    assert.ok(result.includes('## Notes'), 'Notes heading should be unchanged');
    assert.ok(result.includes('Some notes here.'), 'Notes content should be unchanged');
  });

  test('round-trip: extract then replace then extract', () => {
    const content = '# State\n\n**Phase:** 3\n';
    const extracted = stateExtractField(content, 'Phase');
    assert.strictEqual(extracted, '3', 'initial extract should return "3"');

    const updated = stateReplaceField(content, 'Phase', '4');
    assert.ok(updated !== null, 'replace should succeed');

    const reExtracted = stateExtractField(updated, 'Phase');
    assert.strictEqual(reExtracted, '4', 'extract after replace should return "4"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateReplaceFieldWithFallback — consolidated fallback helper
// ─────────────────────────────────────────────────────────────────────────────

describe('stateReplaceFieldWithFallback', () => {
  test('replaces primary field when present', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', null, 'New');
    assert.ok(result.includes('**Status:** New'));
  });

  test('falls back to secondary field when primary not found', () => {
    const content = '# State\n\nLast activity: 2024-01-01\n';
    const result = stateReplaceFieldWithFallback(content, 'Last Activity', 'Last activity', '2025-03-19');
    assert.ok(result.includes('Last activity: 2025-03-19'), 'should update fallback field');
  });

  test('returns content unchanged when neither field matches', () => {
    const content = '# State\n\n**Phase:** 3\n';
    let warning = '';
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      warning += String(chunk);
      return true;
    };
    let result;
    try {
      result = stateReplaceFieldWithFallback(content, 'Status', 'state', 'New');
    } finally {
      process.stderr.write = origErrWrite;
    }
    assert.strictEqual(result, content, 'content should be unchanged');
    assert.match(warning, /STATE\.md field "Status"/, 'missing field warning should be emitted');
  });

  test('prefers primary over fallback when both exist', () => {
    const content = '# State\n\n**Status:** Old\nStatus: Also old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', 'Status', 'New');
    // Bold format is tried first by stateReplaceField
    assert.ok(result.includes('**Status:** New'), 'should replace bold (primary) format');
  });

  test('works with plain format fields', () => {
    const content = '# State\n\nPhase: 1 of 3 (Foundation)\nStatus: In progress\nPlan: 01-01\n';
    let updated = stateReplaceFieldWithFallback(content, 'Status', null, 'Complete');
    assert.ok(updated.includes('Status: Complete'), 'should update plain Status');
    updated = stateReplaceFieldWithFallback(updated, 'Current Plan', 'Plan', 'Not started');
    assert.ok(updated.includes('Plan: Not started'), 'should fall back to Plan field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateLoad, cmdStateGet, cmdStatePatch, cmdStateUpdate CLI tests
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateLoad (state load)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns config and state when STATE.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n'
    );

    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, true, 'state_exists should be true');
    assert.strictEqual(output.config_exists, true, 'config_exists should be true');
    assert.strictEqual(output.roadmap_exists, true, 'roadmap_exists should be true');
    assert.ok(output.state_raw.includes('**Status:** Active'), 'state_raw should contain STATE.md content');
  });

  test('returns state_exists false when STATE.md missing', () => {
    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, false, 'state_exists should be false');
    assert.strictEqual(output.state_raw, '', 'state_raw should be empty string');
  });

  test('returns raw key=value format with --raw flag', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );

    const result = runGsdTools('state load --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(result.output.includes('state_exists=true'), 'raw output should include state_exists=true');
    assert.ok(result.output.includes('config_exists=true'), 'raw output should include config_exists=true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2376: cmdStateLoad's *_dir/*_path fields must resolve regardless of the
// calling process's own cwd, not just the orchestrator's — debug.md has no
// init.* call of its own and reads debug_dir from `state load` to build
// debug_file_path for its gsd-debug-session-manager spawns instead of
// hardcoding '.planning/debug/{slug}.md'. See tests/init.test.cjs's matching
// '#2376 — init.* path fields resolve...' describe block for the established
// pattern (spawn gsd-tools with its OS-level process cwd pointed at an
// unrelated decoy directory while passing the real project root via --cwd).
// ─────────────────────────────────────────────────────────────────────────────

describe('#2376 — state load emits absolute debug_dir regardless of process cwd', () => {
  let projectDir;
  let decoyDir;

  beforeEach(() => {
    projectDir = createFixture();
    decoyDir = createTempDir('gsd-2376-decoy-');
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(decoyDir);
  });

  test('state load emits absolute debug_dir field that resolves from a different process cwd (previously absent)', () => {
    fs.mkdirSync(path.join(projectDir, '.planning', 'debug'), { recursive: true });

    const result = runGsdTools(['state', 'load', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('debug_dir' in output, 'cmdStateLoad must now emit debug_dir (#2376)');
    assert.ok(path.isAbsolute(output.debug_dir), `debug_dir must be absolute, got: "${output.debug_dir}"`);
    assert.ok(fs.existsSync(output.debug_dir), `debug_dir must resolve to the real directory: "${output.debug_dir}"`);
  });
});

describe('cmdStateGet (state get)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns full content when no section specified', () => {
    const stateContent = '# Project State\n\n**Status:** Active\n**Phase:** 03\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state get', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.content !== undefined, 'output should have content field');
    assert.ok(output.content.includes('**Status:** Active'), 'content should include full STATE.md text');
  });

  test('extracts bold field value', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output['Status'], 'Active', 'should extract Status field value');
  });

  test('extracts markdown section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n\n## Blockers\n\n- item1\n- item2\n'
    );

    const result = runGsdTools('state get Blockers', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output['Blockers'] !== undefined, 'should have Blockers key in output');
    assert.ok(output['Blockers'].includes('item1'), 'section content should include item1');
    assert.ok(output['Blockers'].includes('item2'), 'section content should include item2');
  });

  test('returns error for nonexistent field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Missing', tmpDir);
    assert.ok(result.success, `Command should exit 0 even for missing field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.toLowerCase().includes('not found'), 'error should mention "not found"');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(!result.success, 'command should fail when STATE.md is missing');
    assert.ok(
      result.error.includes('STATE.md') || result.output.includes('STATE.md'),
      'error message should mention STATE.md'
    );
  });
});

describe('cmdStatePatch and cmdStateUpdate (state patch, state update)', () => {
  let tmpDir;
  const stateMd = [
    '# Project State',
    '',
    '**Current Phase:** 03',
    '**Status:** In progress',
    '**Last Activity:** 2024-01-15',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state patch updates multiple fields at once', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Complete --"Current Phase" 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state patch accepts JSON object input from workflows', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools([
      'query',
      'state.patch',
      JSON.stringify({
        Status: 'Complete',
        'Current Phase': '04',
      }),
    ], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // MOVED under ADR-3473 §8.7 (#3872): this fixture's STATE.md has NO
    // frontmatter block at all before this write (`stateMd` above is a bare
    // body). `syncStateFrontmatter` synthesizes one for the first time,
    // adding `gsd_state_version` — a key going from ABSENT in the pre-write
    // snapshot to PRESENT in the persisted document, which design doc row 15
    // ("a field absent from snapshot, present in persisted -> reported") says
    // is a change like any other.
    assert.deepEqual(output.updated.slice().sort(), ['Current Phase', 'Status', 'gsd_state_version'].sort());

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Current Phase:** 04'), 'Current Phase should be updated to 04');
  });

  test('state patch reports failed fields that do not exist', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Done --Missing value', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.updated), 'updated should be an array');
    assert.ok(output.updated.includes('Status'), 'Status should be in updated list');
    assert.ok(Array.isArray(output.failed), 'failed should be an array');
    assert.ok(output.failed.includes('Missing'), 'Missing should be in failed list');
  });

  // #3351: state.patch's `updated`/`failed` report must reflect what actually
  // persisted to STATE.md after the write completes — not whether the internal
  // text-replace matched frontmatter text that the write pipeline then
  // re-derives away (syncStateFrontmatter re-derives current_phase /
  // current_phase_name from the body `Phase:` line on every write, and the
  // FIELD_CLASSIFICATION preservation rows restore the pre-write values when
  // the body source did not change).
  describe('#3351: state.patch report reconciled against persisted STATE.md', () => {
    const phaseStateMd = [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 1',
      'current_phase_name: alpha',
      'risk_level: low',
      'status: executing',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 1 (alpha)',
      '',
    ].join('\n');

    function readFm(dir) {
      return frontmatterLib.extractFrontmatter(
        fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf-8'),
      );
    }

    test('body-derived/curated frontmatter fields re-derived by the write are reported failed, not updated', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), phaseStateMd);

      const result = runGsdTools([
        'query',
        'state.patch',
        JSON.stringify({ current_phase: '7', current_phase_name: 'omega' }),
      ], tmpDir);
      assert.ok(result.success, `state patch failed: ${result.error}`);

      const report = JSON.parse(result.output);
      assert.deepEqual(report.updated, [], `phantom updates must not be reported: ${result.output}`);
      assert.deepEqual(report.failed.sort(), ['current_phase', 'current_phase_name'].sort());

      // On-disk truth: neither requested value persisted.
      const fm = readFm(tmpDir);
      assert.notEqual(String(fm.current_phase), '7', 'current_phase was re-derived away by the write pipeline');
      assert.notEqual(String(fm.current_phase_name), 'omega', 'current_phase_name was restored by the curated preservation row');
    });

    test('mixed patch reports an accurate updated/failed split (one lands, one is re-derived away)', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), phaseStateMd);

      const result = runGsdTools([
        'query',
        'state.patch',
        JSON.stringify({ risk_level: 'high', current_phase: '7' }),
      ], tmpDir);
      assert.ok(result.success, `state patch failed: ${result.error}`);

      const report = JSON.parse(result.output);
      assert.deepEqual(report.updated, ['risk_level']);
      assert.deepEqual(report.failed, ['current_phase']);

      const fm = readFm(tmpDir);
      assert.equal(String(fm.risk_level), 'high', 'the custom frontmatter key must still land');
      assert.notEqual(String(fm.current_phase), '7');
    });

    test('empty patch still reports both arrays empty', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), phaseStateMd);

      const result = runGsdTools(['query', 'state.patch', '{}'], tmpDir);
      assert.ok(result.success, `state patch failed: ${result.error}`);

      const report = JSON.parse(result.output);
      assert.deepEqual(report, { updated: [], failed: [] });
    });
  });

  test('state update changes a single field', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Status "Phase complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Phase complete'), 'Status should be updated');
    assert.ok(updated.includes('**Current Phase:** 03'), 'Current Phase should be unchanged');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state update reports field not found', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Missing value', tmpDir);
    assert.ok(result.success, `Command should exit 0 for not-found field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(output.reason !== undefined, 'should include a reason');
  });

  test('state update returns error when STATE.md missing', () => {
    const result = runGsdTools('state update Status value', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(
      output.reason.includes('STATE.md'),
      'reason should mention STATE.md'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateAdvancePlan, cmdStateRecordMetric, cmdStateUpdateProgress
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateAdvancePlan (state advance-plan)', () => {
  let tmpDir;

  const advanceFixture = [
    '# Project State',
    '',
    '**Current Plan:** 1',
    '**Total Plans in Phase:** 3',
    '**Status:** Executing',
    '**Last Activity:** 2024-01-10',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('advances plan counter when not on last plan', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), advanceFixture);

    const PINNED_MS = Date.parse('2020-06-15T12:00:00.000Z');
    const PINNED_DATE = '2020-06-15';
    const result = runGsdTools('state advance-plan', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 1, 'previous_plan should be 1');
    assert.strictEqual(output.current_plan, 2, 'current_plan should be 2');
    assert.strictEqual(output.total_plans, 3, 'total_plans should be 3');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Current Plan:** 2'), 'Current Plan should be updated to 2');
    assert.ok(updated.includes('**Status:** Ready to execute'), 'Status should be Ready to execute');
    assert.ok(
      updated.includes(`**Last Activity:** ${PINNED_DATE}`),
      `Last Activity should be the pinned date ${PINNED_DATE}`,
    );
  });

  test('marks phase complete on last plan', () => {
    const lastPlanFixture = advanceFixture.replace('**Current Plan:** 1', '**Current Plan:** 3');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lastPlanFixture);

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false, 'advanced should be false');
    assert.strictEqual(output.reason, 'last_plan', 'reason should be last_plan');
    assert.strictEqual(output.status, 'ready_for_verification', 'status should be ready_for_verification');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns error when plan fields not parseable', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    // Assert on what makes the message actionable, not on one literal phrase:
    // it must say the plan position could not be read AND name the shapes that
    // would work. The previous assertion only checked for "cannot parse", which
    // a message can satisfy while leaving the reader no idea what to write.
    assert.ok(
      /cannot read the plan position/i.test(output.error),
      `error should say the plan position could not be read; got: ${output.error}`,
    );
    // Coupling, not transcription: the message is DERIVED from
    // `STATE_FIELD_SCHEMA.current_plan.acceptedShapes`, so this walks the
    // schema rather than restating a list beside it. Widening the schema
    // without widening the message (or vice versa) goes red here.
    const { STATE_FIELD_SCHEMA } = require('../gsd-core/bin/lib/state-md-schema.cjs');
    const declared = STATE_FIELD_SCHEMA['current_plan'].acceptedShapes;
    assert.ok(declared.length > 0, 'schema must declare at least one shape, else this assertion is vacuous');
    for (const shape of declared) {
      const spelling = shape === 'N'
        ? 'Total Plans in Phase'
        : `Current Plan: ${shape}`;
      assert.ok(
        output.error.includes(spelling),
        `error should name declared shape ${JSON.stringify(shape)} as ${JSON.stringify(spelling)}; got: ${output.error}`,
      );
    }
    // The body-only `Plan` field has no schema row (buildStateFrontmatter never
    // reads it into frontmatter), so it is named explicitly.
    assert.ok(output.error.includes('`Plan: N of M`'),
      `error should name \`Plan: N of M\`; got: ${output.error}`);
    // ...and must NOT advertise a shape the parser refuses (#3791 review round
    // 6, M2). `Plan: N` paired with a `Total Plans in Phase: M` sibling and no
    // `Current Plan` is not an accepted shape; a message naming it would send
    // the reader to write a STATE.md this command still cannot read.
    assert.ok(!output.error.includes('`Plan: N` with'),
      `error must not advertise the unaccepted bare-Plan+sibling shape; got: ${output.error}`);
  });

  test('advances plan in compound "Plan: X of Y" format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 2 of 5 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 2);
    assert.strictEqual(output.current_plan, 3);
    assert.strictEqual(output.total_plans, 5);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Plan: 3 of 5 in current phase'),
      'should preserve compound format with updated plan number');
    assert.ok(updated.includes('Status: Ready to execute'),
      'Status should be updated');
  });

  test('marks phase complete on last plan in compound format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 3 of 3 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'last_plan');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });

  // #4067: advance-plan's phase-complete decision must be derived from disk
  // state (every plan in the phase directory has a SUMMARY.md, via the
  // scanPhasePlans single owner) rather than from STATE.md's scalar plan
  // counter. A serial counter cannot represent wave-parallel execution — a
  // stale counter from the prior phase (the reported trigger) or a racing
  // counter under N concurrent executors both let `X >= Y` fire the
  // phase-complete branch while sibling plans are mid-flight.
  describe('cmdStateAdvancePlan #4067 wave-parallel phase-complete guard', () => {
    const waveFixture = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 2 — Build out',
      'Plan: 7 of 7',
      'Status: Executing',
      'Last Activity: 2026-09-01',
      '',
    ].join('\n');

    const seedPhaseDir = (dir, planCount, summaryCount) => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= planCount; i++) {
        fs.writeFileSync(path.join(phaseDir, `02-0${i}-PLAN.md`), `# plan ${i}\n`);
      }
      for (let i = 1; i <= summaryCount; i++) {
        fs.writeFileSync(path.join(phaseDir, `02-0${i}-SUMMARY.md`), `# summary ${i}\n`);
      }
      return phaseDir;
    };

    test('declines phase-complete while plans lack summaries (stale counter)', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), waveFixture);
      seedPhaseDir('02-second', 3, 1);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.advanced, false, 'advanced should be false');
      assert.strictEqual(out.reason, 'plans_outstanding',
        `reason should be plans_outstanding; got: ${JSON.stringify(out)}`);
      assert.ok(Array.isArray(out.outstanding_plans) && out.outstanding_plans.length === 2,
        `outstanding_plans should name the 2 unsummarized plans; got: ${JSON.stringify(out.outstanding_plans)}`);

      const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(!updated.includes('Phase complete'),
        'STATE.md must NOT say Phase complete while plans are unsummarized');
      assert.ok(updated.includes('Status: Executing'),
        'STATE.md Status must be left unchanged by the decline');
    });

    test('fires phase-complete when every plan on disk has a summary', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), waveFixture);
      seedPhaseDir('02-second', 3, 3);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.advanced, false);
      assert.strictEqual(out.reason, 'last_plan',
        `a fully-summarized phase must still take the phase-complete branch; got: ${JSON.stringify(out)}`);

      const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
    });

    test('keeps counter-derived phase-complete when the phase directory cannot be determined', () => {
      // No phase directory matching Current Position's "Phase: 2" exists —
      // the disk answer is unavailable, so the guard fails open to the
      // counter-derived decision (existing pinned fixtures exercise the
      // no-Current-Position spelling; this one pins the no-matching-dir one).
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), waveFixture);
      seedPhaseDir('09-unrelated', 3, 0);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.reason, 'last_plan',
        `unresolvable phase dir must keep legacy counter behavior; got: ${JSON.stringify(out)}`);

      const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
    });

    test('is idempotent when re-run while plans are outstanding', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), waveFixture);
      seedPhaseDir('02-second', 3, 1);

      const first = runGsdTools('state advance-plan', tmpDir);
      assert.ok(first.success, `First call failed: ${first.error}`);
      const afterFirst = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

      const second = runGsdTools('state advance-plan', tmpDir);
      assert.ok(second.success, `Second call failed: ${second.error}`);
      const out = JSON.parse(second.output);
      assert.strictEqual(out.reason, 'plans_outstanding',
        `re-run must decline identically; got: ${JSON.stringify(out)}`);

      const afterSecond = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.strictEqual(afterSecond, afterFirst,
        'a declined advance-plan must leave STATE.md byte-identical (idempotent, race-safe)');
    });

    test('normal advance is untouched by the disk guard', () => {
      const midPhase = waveFixture.replace('Plan: 7 of 7', 'Plan: 1 of 3');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), midPhase);
      seedPhaseDir('02-second', 3, 0);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.advanced, true,
        `counter below total must still advance (display-only counter); got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.current_plan, 2);

      const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(updated.includes('Plan: 2 of 3'), 'Plan counter should advance to 2 of 3');
    });
  });

  describe('cmdStateAdvancePlan #4093 zero-labeled-fields recovery decline', () => {
    // The reporter's exact shape: ## Current Position has drifted to pure
    // narrative prose — zero matches for Phase:/Plan:/Current Plan:/Total
    // Plans in Phase: anywhere in the file, bold or plain — while frontmatter
    // still carries current_phase and the phase directory still holds the
    // plan/summary set that IS the position. advance-plan must not strand the
    // caller at a bare "cannot parse" error: the decline carries a
    // machine-readable reason plus the disk-derived facts needed to repair.
    const narrativeFixture = [
      '---',
      'status: Executing',
      'current_phase: 01',
      'current_phase_name: Implementation',
      'last_activity: 2026-09-01',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      '**Phase 1 plan 2** (auth flow): EXECUTED — token round-trip verified end to end.',
      "Follow-ups captured in plan 3's tasks.",
      '',
      '## Session',
      '',
      'Session ID: abc',
      '',
    ].join('\n');

    const seedPhaseDir = (dir, planCount, summaryCount) => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= planCount; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-0${i}-PLAN.md`), `# plan ${i}\n`);
      }
      for (let i = 1; i <= summaryCount; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-0${i}-SUMMARY.md`), `# summary ${i}\n`);
      }
      return phaseDir;
    };

    test('#4093 declines with disk-derived repair guidance when Current Position has zero labeled fields', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), narrativeFixture);
      seedPhaseDir('01-impl', 2, 1);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command should exit 0: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.ok(typeof out.error === 'string' && /cannot read the plan position/i.test(out.error),
        `error should still name the unreadable plan position; got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.reason, 'plan_position_unreadable',
        `reason should be plan_position_unreadable; got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_dir, '01-impl',
        `phase_dir should name the disk phase directory; got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.disk.plan_count, 2,
        `disk.plan_count should count the 2 plan files; got: ${JSON.stringify(out.disk)}`);
      assert.strictEqual(out.disk.summarized_count, 1,
        `disk.summarized_count should count the 1 summary; got: ${JSON.stringify(out.disk)}`);
      assert.strictEqual(out.suggested.current_plan, 2,
        `next plan after 1 summarized of 2 is 2; got: ${JSON.stringify(out.suggested)}`);
      assert.strictEqual(out.suggested.total_plans, 2,
        `suggested total is the on-disk plan count; got: ${JSON.stringify(out.suggested)}`);
      assert.ok(out.suggested.lines.includes('Current Plan: 2') && out.suggested.lines.includes('Total Plans in Phase: 2'),
        `suggested lines should name the legacy pair to re-insert; got: ${JSON.stringify(out.suggested)}`);

      const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.strictEqual(after, narrativeFixture,
        'a recovery decline must leave STATE.md byte-identical');
    });

    test('#4093 resolves the position phase from the Phase line when frontmatter has none', () => {
      const noFm = [
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 2 — Build out',
        '',
        'All narrative from here; the labeled plan lines were displaced by executor notes.',
        '',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), noFm);
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-second');
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(phaseDir, `02-0${i}-PLAN.md`), `# plan ${i}\n`);
      fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# summary 1\n');

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command should exit 0: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.reason, 'plan_position_unreadable', `got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_dir, '02-second',
        `phase should resolve from the Phase: prose line; got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.suggested.current_plan, 2, `got: ${JSON.stringify(out.suggested)}`);
      assert.strictEqual(out.suggested.total_plans, 3, `got: ${JSON.stringify(out.suggested)}`);
    });

    test('#4093 names the reason even when no phase can be resolved from disk or frontmatter', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        '# Project State\n\n## Current Position\n\nPure narrative, no labeled lines anywhere.\n',
      );

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command should exit 0: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.reason, 'plan_position_unreadable', `got: ${JSON.stringify(out)}`);
      assert.ok(/cannot read the plan position/i.test(out.error),
        `the accepted-shape sentence must survive; got: ${out.error}`);
      assert.strictEqual(out.phase_dir, undefined,
        `no resolvable phase means no phase_dir; got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.disk, undefined, `no resolvable phase means no disk block`);
    });

    test('#4093 omits suggested values when the phase directory has no plan files', () => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), narrativeFixture);
      seedPhaseDir('01-impl', 0, 0);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command should exit 0: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.reason, 'plan_position_unreadable', `got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_dir, '01-impl', `got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.disk.plan_count, 0, `got: ${JSON.stringify(out.disk)}`);
      assert.strictEqual(out.suggested, undefined,
        `zero plans on disk means nothing to suggest; got: ${JSON.stringify(out)}`);
    });

    test('#4093 gives the same recovery decline for a present-but-unreadable plan field', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        narrativeFixture.replace("Follow-ups captured in plan 3's tasks.", 'Plan: TBD'),
      );
      seedPhaseDir('01-impl', 2, 1);

      const result = runGsdTools('state advance-plan', tmpDir);
      assert.ok(result.success, `Command should exit 0: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.reason, 'plan_position_unreadable', `got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_dir, '01-impl', `got: ${JSON.stringify(out)}`);
      assert.strictEqual(out.suggested.current_plan, 2, `got: ${JSON.stringify(out.suggested)}`);
      assert.strictEqual(out.advanced, undefined, 'an unreadable position must never be advanced');
    });
  });
});

describe('#3830: state advance-plan checks its prose position against the plans on disk', () => {
  let tmpDir;

  // A phase whose Current Position names it, so the adapter has a phase to
  // resolve. `advance-plan` still takes no phase argument — this is the only
  // input it has, which is the whole point of the defect.
  const stateWith = (planLine) => [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 01 (Demo Phase) — EXECUTING',
    planLine,
    'Status: Ready to execute',
    'Last Activity: 2026-08-01',
    '',
  ].join('\n');

  const seedPhase = (dirName, planCount, summaryCount = planCount) => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', dirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= planCount; i++) {
      const id = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${id}-PLAN.md`), '---\nstatus: complete\n---\n# Plan\n');
      if (i <= summaryCount) {
        fs.writeFileSync(path.join(phaseDir, `01-${id}-SUMMARY.md`), '---\nstatus: complete\n---\n# Summary\n');
      }
    }
    return phaseDir;
  };

  const stateText = () => fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  const writeState = (planLine) =>
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateWith(planLine));

  beforeEach(() => { tmpDir = createFixture(); });
  afterEach(() => { cleanup(tmpDir); });

  test('refuses to advance stale prose and leaves STATE.md byte-identical', () => {
    // The issue's reproduction: twelve plans on disk, prose still "2 of 8".
    seedPhase('01-demo', 12);
    writeState('Plan: 2 of 8');
    const before = stateText();

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'position_diverged');
    assert.deepStrictEqual(output.prose, { current_plan: 2, total_plans: 8 });
    assert.strictEqual(output.disk.phase, '01');
    assert.strictEqual(output.disk.plan_count, 12);
    assert.deepStrictEqual(output.updated, []);
    assert.strictEqual(stateText(), before, 'a refusal must not write anything back');
  });

  // #3862 review (Major): the refusal has to be AUDIBLE, not merely reported.
  // Both first-party callers run `gsd_run query state.advance-plan` bare —
  // stdout discarded, exit code untested — so a stdout-only refusal is a silent
  // non-write. These pin the stderr channel, its content, and (critically) that
  // adding it did not pollute the JSON those same callers may `--pick` from.
  test('a divergence refusal is announced on stderr, not only on stdout', () => {
    seedPhase('01-demo', 12);
    writeState('Plan: 2 of 8');

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, `the refusal must still exit 0: ${result.stderr}`);

    const stderr = result.stderr || '';
    assert.match(stderr, /\[gsd-tools\] WARNING:/, `expected a [gsd-tools] WARNING on stderr; got: ${JSON.stringify(stderr)}`);
    assert.match(stderr, /REFUSED to advance/, 'the warning must say the advance did not happen');
    // Both sides of the disagreement, so the operator can act without re-running anything.
    assert.match(stderr, /2 of 8/, 'the warning must name the prose position');
    assert.match(stderr, /12/, 'the warning must name the disk plan count');
    // And the repair path, so the warning does not merely relocate the puzzle.
    assert.match(stderr, /phase-plan-index/, 'the warning must name how to see the real plan set');
  });

  test('the stderr warning does not pollute the JSON on stdout', () => {
    // The negative control for the test above: `--raw`/`--pick` consumers parse
    // stdout, so a warning written to the wrong channel would break them.
    seedPhase('01-demo', 12);
    writeState('Plan: 2 of 8');

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.reason, 'position_diverged');
    assert.ok(!result.stdout.includes('[gsd-tools] WARNING'), 'the warning must not reach stdout');
  });

  // #3862 RV6.5 adversarial review (MISSED finding): `advanced: false` is NOT
  // synonymous with "refused". The ordinary phase-complete answer is also
  // `advanced: false`, with `reason: 'last_plan'`. A caller keyed on `advanced`
  // alone therefore treats the LAST PLAN of every phase as a failure and skips
  // its progress and metric recording — which is exactly what the first cut of
  // this round's caller fix did. These pin the discriminator both callers now use.
  test('the last plan is advanced:false with reason last_plan, not a refusal', () => {
    seedPhase('01-demo', 12);
    writeState('Plan: 12 of 12');

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, `last plan must exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.advanced, false, 'the last plan does not advance');
    assert.strictEqual(parsed.reason, 'last_plan', 'and it must be distinguishable from a refusal');
    assert.notStrictEqual(parsed.reason, 'position_diverged');
    assert.ok(!(result.stderr || '').includes('REFUSED to advance'),
      `the last plan is not a refusal and must not warn; got: ${JSON.stringify(result.stderr)}`);
  });

  // #3862 review (Blocker 2): the first assertion here was VACUOUS — it checked
  // only that stdout was empty, so it passed just as readily when the command
  // FAILED. That mattered more than a style nit, because #3884 changed what this
  // invocation does: `--pick` on an absent field is now a hard failure
  // (`ERROR_REASON.PICK_FIELD_ABSENT`, gsd-core/bin/gsd-tools.cjs), and a normal
  // advance emits no `reason` key at all. So after the rebase this command exits
  // NON-ZERO on the advance case — and the old assertion stayed green over it.
  //
  // The contract is restated rather than deleted, because absence became a
  // SIGNAL under #3884 instead of an empty string. Every case now asserts the
  // exit status as well as the projection, so none of them can pass by failing.
  //
  // Note for callers: this is not how the first-party callers discriminate. Both
  // invoke the verb BARE and match the full JSON — pinned by the caller-guard
  // test and by the parity test below — so `--pick reason` is an operator
  // convenience here, not a caller contract.
  test('--pick reason: absence is a failure, and each reason projects exactly', () => {
    seedPhase('01-demo', 12);

    writeState('Plan: 3 of 12');
    const advance = runGsdTools('state advance-plan --pick reason', tmpDir);
    assert.ok(!advance.success,
      `#3884: a normal advance carries no reason, so --pick reason must FAIL, not return empty; got: ${advance.output}`);
    assert.ok(`${advance.output || ''}${advance.error || ''}`.includes('field not found'),
      'the failure must name the absent field rather than any other error');

    writeState('Plan: 12 of 12');
    const last = runGsdTools('state advance-plan --pick reason', tmpDir);
    assert.ok(last.success, `the last plan must still project: ${last.error}`);
    assert.strictEqual(last.output.trim(), 'last_plan');

    writeState('Plan: 2 of 8');
    const diverged = runGsdTools('state advance-plan --pick reason', tmpDir);
    assert.ok(diverged.success, `a divergence must still project: ${diverged.error}`);
    assert.strictEqual(diverged.output.trim(), 'position_diverged');
  });

  // #3862 RV6.5 pass 3 (CLAIM 7). The warning gained two explanatory branches and
  // NOTHING asserted them: reverting it to the old unconditional "matches neither"
  // sentence left every existing warning test green, so a behavioural fix was
  // shipping uncontrolled. The wording is behaviour here — it is the only thing that
  // tells an operator WHICH half of `Plan: N of M` to reconcile, and naming the wrong
  // half sends them to edit the number that is already correct.
  test('the divergence warning names which half of the position is wrong', () => {
    // Total AGREES with the live count, position is out of range.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      const id = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${id}-PLAN.md`),
        `---\nstatus: ${i <= 8 ? 'complete' : 'superseded'}\n---\n# Plan\n`);
    }
    writeState('Plan: 10 of 8');
    const ranged = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(ranged.exitCode, 0, `must still exit 0: ${ranged.stderr}`);
    assert.match(ranged.stderr, /total agrees with the plans on disk, but the position is outside it/,
      `a range refusal must not claim the total matches nothing; got: ${ranged.stderr}`);
    assert.ok(!/matches neither count/.test(ranged.stderr),
      `and it must not carry the total-mismatch wording; got: ${ranged.stderr}`);

    // Total matches the ALL-FILES count rather than the live one. Pass 4 of the round
    // review found the fixtures above exercise only `plan_count`, so a branch that
    // checked that count alone would pass every assertion here. 12 files, 8 live,
    // prose total 12: matches planCountAll and not planCount, position out of range.
    // The fixture above is already 12 files with 8 live, and the refusal wrote
    // nothing, so it stands unchanged — only the prose total moves. (No teardown
    // here on purpose: a raw fs.rmSync in a test is refused by
    // local/no-raw-rmsync-in-tests, and re-seeding an identical tree to change one
    // line of prose is work for its own sake.)
    writeState('Plan: 15 of 12');
    const allFiles = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(allFiles.exitCode, 0, `must still exit 0: ${allFiles.stderr}`);
    assert.match(allFiles.stderr, /total agrees with the plans on disk, but the position is outside it/,
      `a total matching plan_count_all also agrees; got: ${allFiles.stderr}`);

    // Total matches NEITHER count — the original case, still worded that way.
    seedPhase('01-demo', 12);
    writeState('Plan: 2 of 7');
    const mismatched = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(mismatched.exitCode, 0, `must still exit 0: ${mismatched.stderr}`);
    assert.match(mismatched.stderr, /prose total matches neither count/,
      `a total mismatch must say so; got: ${mismatched.stderr}`);
    assert.ok(!/position is outside it/.test(mismatched.stderr),
      `and it must not claim the total agrees; got: ${mismatched.stderr}`);
  });

  test('a normal advance emits no divergence warning', () => {
    // Negative control the other way: the warning must be specific to the
    // refusal, or it becomes noise every caller learns to ignore.
    seedPhase('01-demo', 8);
    writeState('Plan: 2 of 8');

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, `Command should exit 0: ${result.stderr}`);
    assert.strictEqual(JSON.parse(result.stdout).advanced, true);
    assert.ok(!(result.stderr || '').includes('REFUSED to advance'),
      `a successful advance must be silent on stderr; got: ${JSON.stringify(result.stderr)}`);
  });

  test('advances normally when the prose total matches the plans on disk', () => {
    seedPhase('01-demo', 8);
    writeState('Plan: 2 of 8');

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true);
    assert.strictEqual(output.current_plan, 3);
    const updated = stateText();
    assert.ok(updated.includes('Plan: 3 of 8'), `expected "Plan: 3 of 8"; got:\n${updated}`);
  });

  test('a phase with no plan files on disk yet is not blocked', () => {
    seedPhase('01-demo', 0);
    writeState('Plan: 1 of 3');

    const result = runGsdTools('state advance-plan', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'an empty phase directory is a real zero, not divergence');
    assert.strictEqual(output.current_plan, 2);
  });

  test('no phases directory at all is not blocked', () => {
    writeState('Plan: 1 of 3');

    const result = runGsdTools('state advance-plan', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'an unresolvable phase is unknown, not diverged');
  });

  test('an AMBIGUOUS phase number is unknown, not divergence — the verb still advances', () => {
    // #2237: two directories match bare "01". Which plan set belongs to this
    // position is genuinely undecidable, so the check must abstain rather than
    // first-match one and compare the prose against a coin flip.
    seedPhase('01-demo', 12);
    seedPhase('01-other', 4);
    writeState('Plan: 2 of 8');

    const result = runGsdTools('state advance-plan', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true);
    assert.strictEqual(output.reason, undefined);
  });

  // #3862 round 3 (Minor): the one on-disk `scope` the provider's own docblock
  // motivates by name — a nested `plans/` entry that exists but cannot be read —
  // was pinned only through a stubbed provider. This drives it through the real
  // CLI: a regular FILE named `plans` satisfies existsSync and makes readdirSync
  // throw ENOTDIR, which is scanPhasePlans's TRUNCATED path with no chmod (root
  // and Windows ignore it) and no mock (a child process cannot be mocked).
  test('a TRUNCATED plan scan (unreadable nested plans/) is unknown, not divergence — the verb still advances', () => {
    const phaseDir = seedPhase('01-demo', 3);
    fs.writeFileSync(path.join(phaseDir, 'plans'), '');
    writeState('Plan: 2 of 8');

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true,
      `three plans the scan could see is a FLOOR, not proof that 8 is wrong; got ${result.output}`);
    assert.strictEqual(output.current_plan, 3);
  });

  test('the same phase with a READABLE nested plans/ is a complete scan, and 3 vs 8 refuses', () => {
    // The negative control for the test above: the identical fixture with
    // `plans` a directory instead of a file. Without it the abstention above
    // passes for any reason at all — including the cross-check never running.
    const phaseDir = seedPhase('01-demo', 3);
    fs.mkdirSync(path.join(phaseDir, 'plans'));
    writeState('Plan: 2 of 8');
    const before = stateText();

    const output = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
    assert.strictEqual(output.reason, 'position_diverged');
    assert.strictEqual(output.disk.plan_count, 3);
    assert.strictEqual(stateText(), before, 'a refusal must not write anything back');
  });

  // #3862 round 3 (Minor): the fail-safe argument in resolvePlanSetForPhase's
  // docblock — an unscoped listing can only cause a MISS — has one shape it did
  // not name: a phase directory a SHIPPED milestone left behind, whose bare
  // number the current milestone reuses, when the current phase's own directory
  // does not exist yet. `matchPhaseDirs` then returns that one stale directory
  // and the cross-check reads a prior milestone's plan set as ground truth.
  //
  // Reachable, and constructed here rather than argued away: `milestone complete`
  // archives phase directories by default, but `--no-archive-phases` and an
  // unreadable milestone window both leave them in place. What these pin is
  // that the check does not DISAGREE with the repo's own readers about which
  // directory that is. Not because they share a listing — phase-plan-index
  // reads the phases directory raw, find-phase also walks archived milestones —
  // but because under this ROADMAP's plain numeric ids the milestone window
  // admits a directory by its phase number, so every listing carries the reused
  // number and the shared matchPhaseDirs picks the same stale directory in all
  // three. (Hyphenated ids narrow the window — getMilestonePhaseFilter — and are
  // not what this fixture claims.) The refusal reports the drift those readers would
  // report; it is non-mutating, and it dissolves the moment the stale directory
  // is archived.
  describe('a stale prior-milestone directory that is the sole bare-number match', () => {
    const ROADMAP = [
      '# Roadmap',
      '',
      '<details>',
      '<summary>v1.0 — Old Milestone (Shipped)</summary>',
      '',
      '## Roadmap v1.0: Old Milestone',
      '### Phase 1: Old Foundation',
      '### Phase 2: Old API',
      '### Phase 3: Old Deploy',
      '',
      '</details>',
      '',
      '## Roadmap v2.0: New Milestone',
      '### Phase 1: New Foundation',
      '### Phase 2: New API',
      '### Phase 3: Payments',
      '',
    ].join('\n');
    const stateAtPhase3 = (planLine) => [
      '---',
      'milestone: v2.0',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 03 (Payments) — EXECUTING',
      planLine,
      'Status: Ready to execute',
      '',
    ].join('\n');
    // v1.0's phase 3, never archived. v2.0's phase 3 has no directory yet.
    const seedStale = () => {
      const dir = path.join(tmpDir, '.planning', 'phases', '03-old-deploy');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(dir, `03-0${i}-PLAN.md`), '---\nstatus: complete\n---\n# Plan\n');
        fs.writeFileSync(path.join(dir, `03-0${i}-SUMMARY.md`), '---\nstatus: complete\n---\n# Summary\n');
      }
      return dir;
    };
    const seedProject = (planLine) => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP);
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateAtPhase3(planLine));
    };

    test('the cross-check and the read-only verbs select the SAME directory — the refusal is not a disagreement', () => {
      seedStale();
      seedProject('Plan: 1 of 3');
      const before = stateText();

      const advance = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
      const index = JSON.parse(runGsdTools('query phase-plan-index 3', tmpDir).output);
      const found = JSON.parse(runGsdTools('find-phase 3', tmpDir).output);

      assert.strictEqual(advance.reason, 'position_diverged');
      assert.strictEqual(advance.disk.plan_count, 5, 'the stale directory is what the cross-check read');
      assert.strictEqual(index.plans.length, 5, 'phase-plan-index reads the same stale directory');
      assert.match(found.directory, /03-old-deploy$/, 'find-phase selects it too, ahead of any archived milestone');
      assert.strictEqual(found.plan_count_all, 5);
      assert.strictEqual(stateText(), before, 'a refusal must not write anything back');
    });

    test('archiving the stale directory the way milestone-complete does dissolves the match — the verb abstains and advances', () => {
      const stale = seedStale();
      seedProject('Plan: 1 of 3');
      const archive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(stale, path.join(archive, '03-old-deploy'));

      const output = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
      assert.strictEqual(output.advanced, true, `no directory matches phase 03 now, so the check abstains; got ${JSON.stringify(output)}`);
      assert.strictEqual(output.current_plan, 2);
    });
  });

  // #3862 round 4 (Nit): the cross-check used to enumerate phase directories
  // through `listMilestonePhaseDirs` — milestone window plus sentinel filter —
  // while `phase-plan-index` enumerates the phases directory raw. A filtered
  // listing is a strict SUBSET of a raw one, so the two could disagree in both
  // directions. All three shapes below are constructed rather than argued away,
  // and each asserts the cross-check and the read-only verb now give the SAME
  // answer, which is the parity the docblock claims.
  describe('the cross-check enumerates the same directory listing its readers do', () => {
    const roadmapWith = (...phaseHeadings) => [
      '# Roadmap',
      '',
      '## Roadmap v1.0: Current Milestone',
      ...phaseHeadings,
      '',
    ].join('\n');
    const stateAt = (phaseLine, planLine) => [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      phaseLine,
      planLine,
      'Status: Ready to execute',
      '',
    ].join('\n');
    const seedDir = (dirName, prefix, count) => {
      const dir = path.join(tmpDir, '.planning', 'phases', dirName);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 1; i <= count; i++) {
        const id = String(i).padStart(2, '0');
        fs.writeFileSync(path.join(dir, `${prefix}-${id}-PLAN.md`), '---\nstatus: complete\n---\n# Plan\n');
        fs.writeFileSync(path.join(dir, `${prefix}-${id}-SUMMARY.md`), '---\nstatus: complete\n---\n# Summary\n');
      }
      return dir;
    };
    const seedProject = (roadmap, phaseLine, planLine) => {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateAt(phaseLine, planLine));
    };

    test('a phase outside the milestone WINDOW is still checked — the window is not the reader', () => {
      // The ROADMAP declares phases 1-2, so the filter's heading set is
      // non-empty and does NOT degrade pass-all; `03-payments` was therefore
      // dropped from the listing, no directory matched, and the check abstained
      // while five plans sat on disk. That abstention is #3830 recurring.
      seedDir('03-payments', '03', 5);
      seedProject(roadmapWith('### Phase 1: Foundation', '### Phase 2: API'),
        'Phase: 03 (Payments) — EXECUTING', 'Plan: 1 of 3');
      const before = stateText();

      const advance = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
      const index = JSON.parse(runGsdTools('query phase-plan-index 3', tmpDir).output);

      assert.strictEqual(advance.reason, 'position_diverged',
        `an out-of-window phase must still be checked; got ${JSON.stringify(advance)}`);
      assert.strictEqual(advance.disk.plan_count, 5);
      assert.strictEqual(index.plans.length, 5, 'phase-plan-index reads the same directory');
      assert.strictEqual(advance.disk.plan_count, index.plans.length,
        'the writing verb and the read-only verb must report the same count');
      assert.strictEqual(stateText(), before, 'a refusal must not write anything back');
    });

    test('a SENTINEL-numbered directory that is the real current phase is still checked', () => {
      // `isSentinelPhaseId` refuses leading 0 and 999 UNCONDITIONALLY — it
      // survives even the pass-all degrade — so a project whose Current
      // Position genuinely names phase 0 lost the cross-check entirely.
      seedDir('00-bootstrap', '00', 5);
      seedProject(roadmapWith('### Phase 0: Bootstrap', '### Phase 1: Foundation'),
        'Phase: 00 (Bootstrap) — EXECUTING', 'Plan: 1 of 3');
      const before = stateText();

      const advance = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
      const index = JSON.parse(runGsdTools('query phase-plan-index 0', tmpDir).output);

      assert.strictEqual(advance.reason, 'position_diverged',
        `a sentinel-numbered real phase must still be checked; got ${JSON.stringify(advance)}`);
      assert.strictEqual(advance.disk.plan_count, 5);
      assert.strictEqual(advance.disk.plan_count, index.plans.length);
      assert.strictEqual(stateText(), before, 'a refusal must not write anything back');
    });

    test('an ambiguous bare number abstains here exactly where phase-plan-index refuses', () => {
      // The other direction, and the one no review round named: under
      // hyphenated ids the window admits by continuation token, so it could
      // leave ONE of two bare-number-matching directories standing. The check
      // then reported a plan_count as ground truth for a token its own warning
      // told the operator to resolve with `phase-plan-index` — which refuses it
      // as ambiguous. Sharing the listing makes both see two matches: one
      // abstains, the other refuses to answer, and neither invents a number.
      //
      // This one COSTS coverage and the assertion below is what pins the cost:
      // the window was disambiguating, so before the listing change this fixture
      // REFUSED (`position_diverged`, plan_count 2) and now advances stale prose
      // 1 of 9 -> 2 of 9. Taken deliberately — the recovered refusal rested on a
      // token #2237 calls undecidable — but it is a trade, not a clean win, and
      // a future reader must not "restore" the refusal without reading the
      // docblock's named alternative.
      fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ phase_id_convention: 'milestone-prefixed' }));
      seedDir('03-01-alpha', '03-01', 2);
      seedDir('03-02-beta', '03-02', 7);
      seedProject(roadmapWith('### Phase 3-01: Alpha', '### Phase 4-01: Later'),
        'Phase: 3 (Alpha) — EXECUTING', 'Plan: 1 of 9');

      const advance = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
      const index = JSON.parse(runGsdTools('query phase-plan-index 3', tmpDir).output);

      assert.match(index.error, /ambiguous/, 'phase-plan-index refuses the token as ambiguous');
      assert.strictEqual(advance.reason ?? null, null,
        `an undecidable phase is no-evidence, never a named plan set; got ${JSON.stringify(advance)}`);
      assert.strictEqual(advance.advanced, true,
        'abstention advances, per ADR-3180 Decision 2 — and this is the coverage COST of sharing '
        + 'the listing: the window used to break this tie and refuse. Do not "fix" this to a refusal '
        + 'without reading resolvePlanSetForPhase\'s docblock on the trade.');
      assert.strictEqual(advance.disk, undefined,
        'the check must not report disk counts for a directory its readers refuse to name');
    });
  });

  test('a non-canonically-named plan-shaped file does not inflate the count', () => {
    // scanPhasePlans's own planFiles carry isRootPlanFile's loose /PLAN/i
    // fallback; phase-plan-index intersects with the strict predicate (#2893).
    // The cross-check must report the same number that verb does, or a stray
    // `notes-PLAN-draft.md` manufactures divergence out of nothing.
    const phaseDir = seedPhase('01-demo', 8);
    fs.writeFileSync(path.join(phaseDir, 'notes-PLAN-draft.md'), '# not a canonical plan\n');
    writeState('Plan: 2 of 8');

    const result = runGsdTools('state advance-plan', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, `stray plan-shaped file must not count; got ${result.output}`);
  });

  test('the reported plan_count matches what phase-plan-index reports', () => {
    // The issue's premise is that two commands in one CLI disagreed about the
    // same fact. A cross-check that introduced a THIRD number would be worse
    // than the defect it fixes.
    seedPhase('01-demo', 12);
    writeState('Plan: 2 of 8');

    const advance = JSON.parse(runGsdTools('state advance-plan', tmpDir).output);
    const index = JSON.parse(runGsdTools('query phase-plan-index 01', tmpDir).output);
    assert.strictEqual(advance.disk.plan_count, index.plans.length,
      'advance-plan and phase-plan-index must agree on the plan count');
  });

  // #3862 review (Major 3): the total agreeing with disk says nothing about where
  // the position sits inside it. Each case below has a prose total that MATCHES the
  // twelve plans on disk, so the total test passes and only the range check stands
  // between the input and a write.
  test('a current_plan BELOW the plan set is a divergence, even when the TOTAL agrees', () => {
    // `0 of 12` sits on the increment branch (0 < 12), where a diverged pair is
    // refused outright. The past-the-total cases (`20 of 12`, `13 of 12`) sit on
    // the completion branch and are covered two tests down: since #4067 that
    // branch is decided from disk, not refused on the counter.
    seedPhase('01-demo', 12);
    writeState('Plan: 0 of 12');
    const before = stateText();

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `the refusal must still exit 0: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.advanced, false, 'Plan: 0 of 12 must not advance');
    assert.strictEqual(output.reason, 'position_diverged',
      'Plan: 0 of 12 is out of range and must be reported as a divergence');
    assert.strictEqual(output.status, undefined,
      'Plan: 0 of 12 must not be allowed to claim ready_for_verification');
    assert.strictEqual(stateText(), before, 'Plan: 0 of 12 must leave STATE.md byte-identical');
  });

  // #4067 (on `next` since this PR's round 6) re-decides the phase-complete branch
  // from the plans on disk — every plan summarized completes the phase, anything
  // less declines the whole write as `plans_outstanding`. Its own fixture is a stale
  // `7 of 7` in a 3-plan phase, a total this cross-check calls diverged, so the two
  // fixes collide on exactly one branch. The reconciliation: on the completion branch
  // the counter is REPORTED as untrusted and the disk decides; on the increment
  // branch it is refused as before. These pin the reported half.
  test('a position past the total is not refused: a phase complete on disk completes (#4067)', () => {
    for (const planLine of ['Plan: 20 of 12', 'Plan: 13 of 12']) {
      // Every plan summarized -> the phase really is complete, and it completes.
      seedPhase('01-demo', 12);
      writeState(planLine);
      const done = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
      assert.strictEqual(done.exitCode, 0, `${planLine}: ${done.stderr}`);
      const out = JSON.parse(done.stdout);
      assert.strictEqual(out.reason, 'last_plan', `${planLine} with every plan summarized must complete; got ${done.stdout}`);
      assert.deepStrictEqual(out.prose_diverged && out.prose_diverged.prose,
        { current_plan: Number(planLine.match(/\d+/)[0]), total_plans: 12 },
        `${planLine} must carry the divergence it did not refuse on`);
      assert.match(done.stderr, /did NOT trust the plan counter/,
        `${planLine} must still be announced on stderr; got ${JSON.stringify(done.stderr)}`);
      assert.ok(stateText().includes('Phase complete'), `${planLine}: the phase is complete on disk, so Status moves`);
    }
  });

  test('a position past the total is not refused: outstanding plans decline it, byte-identical (#4067)', () => {
    // Seeded ONCE with seven of twelve summarized and never re-seeded fuller —
    // seedPhase only adds files, so a fully-summarized seed in the same fixture
    // would make this case unreachable (the first draft of this test did that).
    seedPhase('01-demo', 12, 7);
    for (const planLine of ['Plan: 20 of 12', 'Plan: 13 of 12']) {
      writeState(planLine);
      const before = stateText();
      const held = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
      assert.strictEqual(held.exitCode, 0, `${planLine}: ${held.stderr}`);
      const out = JSON.parse(held.stdout);
      assert.strictEqual(out.reason, 'plans_outstanding', `${planLine} with 5 unsummarized plans must be declined by #4067; got ${held.stdout}`);
      assert.strictEqual(out.outstanding_plans && out.outstanding_plans.length, 5);
      assert.strictEqual(stateText(), before, `${planLine}: a declined completion leaves STATE.md byte-identical`);
      // The divergence is STILL announced: the payload is #4067's, so stderr carries it.
      assert.match(held.stderr, /did NOT trust the plan counter/,
        `${planLine}: the divergence must be announced even when #4067 declines; got ${JSON.stringify(held.stderr)}`);
      assert.ok(!held.stderr.includes('REFUSED to advance'),
        'the completion branch does not refuse, so the refusal verb must not appear');
      // RV6.5 review of the round that added the yield: the warning must not tell the
      // operator to stop when the caller contract beside it says to proceed.
      assert.ok(!held.stderr.includes('before continuing'),
        `a yield does not stop the workflow, so its warning must not say "before continuing"; got ${JSON.stringify(held.stderr)}`);
      assert.match(held.stderr, /did not stop the workflow/,
        'the yielded warning must say the call did not stop anything');
    }
  });

  // `Plan: -1 of 12` used to sit in the loop above, refused by the range check as
  // `position_diverged`. It no longer reaches that check: #3791 (on `next`) tightened
  // the position parse, so a negative current is now rejected as an unreadable shape
  // BEFORE the cross-check runs. Round 2 of this PR's review flagged that same input as
  // hitting "a pre-existing advancePlanCore bug ... Present at base; flagged for the
  // record, not attributed to you" — this is that bug being fixed upstream, and the
  // case moves here rather than being dropped.
  //
  // What is asserted is the PROPERTY, which is unchanged and is what #3830 is about:
  // exit 0, no advance, and STATE.md byte-identical. The mechanism is asserted
  // separately and deliberately loosely — the accepted-shapes message belongs to
  // #3791, not to this PR, so this pins that a refusal happened and that it is NOT a
  // silent advance, without pinning another PR's wording.
  test('a negative current_plan is refused by the position parse, not by the range check', () => {
    seedPhase('01-demo', 12);
    writeState('Plan: -1 of 12');
    const before = stateText();

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `the refusal must still exit 0: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.ok(output.error, `a negative position must be refused, not advanced; got ${result.output}`);
    assert.strictEqual(output.advanced, undefined,
      'the parse refusal precedes the cross-check, so it carries no `advanced` key at all');
    assert.strictEqual(output.status, undefined,
      'a negative position must not be allowed to claim ready_for_verification');
    assert.strictEqual(stateText(), before,
      'a negative position must leave STATE.md byte-identical');
  });

  // #3862 RV6.5 review. The disk bound alone was not enough, and this is the case it
  // missed: 12 plan files of which 8 are live, prose `Plan: 10 of 8`. The total (8)
  // matches planCount, the position (10) sits UNDER planCountAll (12), so both disk
  // tests passed — and the verb then satisfied `currentPlan >= totalPlans`, returned
  // `{reason: "last_plan", status: "ready_for_verification"}` and WROTE the phase to
  // complete from a position past its own declared total. Driven at HEAD before the fix.
  test('a current_plan past its OWN declared total is a divergence, even when disk agrees', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      const id = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${id}-PLAN.md`),
        `---\nstatus: ${i <= 8 ? 'complete' : 'superseded'}\n---\n# Plan\n`);
    }
    writeState('Plan: 10 of 8');
    const before = stateText();

    // Post-#4067 the completion branch is decided from disk: none of the eight
    // live plans is summarized, so the write is declined as `plans_outstanding` —
    // byte-identical, exactly as the refusal was — and the incoherent position is
    // announced on stderr rather than being the reason itself.
    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, `must still exit 0: ${result.stderr}`);
    const output = JSON.parse(result.stdout);

    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'plans_outstanding',
      `with no plan summarized the disk must decline the completion; got ${result.stdout}`);
    assert.strictEqual(output.status, undefined,
      'it must NOT be allowed to claim ready_for_verification');
    assert.strictEqual(stateText(), before,
      'and it must not write — this case previously mutated STATE.md');
    assert.match(result.stderr, /did NOT trust the plan counter/,
      'a position past its own total is still announced as untrusted');
  });

  test('the range check does not fire on an all-superseded phase positioned past the LIVE count', () => {
    // The bound is planCountAll, not planCount, and this is the negative control
    // for that choice: eight plan FILES of which none is live, prose positioned at
    // 5 of 8. Bounding on the live count would manufacture a divergence out of
    // ordinary supersession — the same reason the total test accepts either count.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 8; i++) {
      const id = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${id}-PLAN.md`), '---\nstatus: superseded\n---\n# Plan\n');
    }
    writeState('Plan: 5 of 8');

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `must not fail: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true,
      'a position inside the full plan set is in range, whatever the live count is');
    assert.strictEqual(output.current_plan, 6);
  });

  test('the boundary is inclusive: current_plan == the plan count still advances', () => {
    // limit-1 / limit / limit+1 for the NEW predicate specifically. `12 of 12` is
    // the ordinary last plan and must reach last_plan, not the divergence arm — an
    // off-by-one in `currentPlan > planCountAll` would swallow every phase's final
    // plan into a refusal.
    seedPhase('01-demo', 12);
    writeState('Plan: 12 of 12');
    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `must not fail: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'last_plan',
      'the last plan is in range — it must reach last_plan, never position_diverged');
  });

  test('a diverged total does not complete a phase prematurely — the disk decides, and the divergence is announced', () => {
    // Pre-fix this took the currentPlan >= totalPlans branch and declared
    // ready_for_verification on a phase holding twelve plans of which seven were
    // summarized. Post-#4067 that branch is decided from disk: five outstanding ->
    // declined, byte-identical, and this check's warning still names `8 of 8` vs 12.
    seedPhase('01-demo', 12, 7);
    writeState('Plan: 8 of 8');
    const before = stateText();

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.reason, 'plans_outstanding', `got ${result.stdout}`);
    assert.strictEqual(output.status, undefined, 'must not claim ready_for_verification');
    assert.strictEqual(stateText(), before, 'the declined write must be byte-identical');
    assert.ok(!before.includes('Phase complete'), 'Status must not be moved to Phase complete');
    assert.match(result.stderr, /8 of 8/, 'the warning must name the prose position');
    assert.match(result.stderr, /12/, 'the warning must name the disk plan count');
    assert.match(result.stderr, /did NOT trust the plan counter/);
  });

  test('a diverged total on a phase that IS complete on disk completes it, and says the counter was not trusted', () => {
    // Same stale `8 of 8` over twelve plans, all twelve summarized. Refusing here
    // would send the operator to fix a number in order to finish a finished phase;
    // #4067 completes it and this check announces the stale line.
    seedPhase('01-demo', 12);
    writeState('Plan: 8 of 8');

    const result = runToolsWithStderr(['state', 'advance-plan'], tmpDir);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.reason, 'last_plan', `got ${result.stdout}`);
    assert.strictEqual(output.status, 'ready_for_verification');
    assert.deepStrictEqual(output.prose_diverged, {
      prose: { current_plan: 8, total_plans: 8 },
      disk: { phase: '01', plan_count: 12, plan_count_all: 12 },
    });
    assert.ok(stateText().includes('Phase complete'), 'Status moves: the phase is complete on disk');
    assert.match(result.stderr, /did NOT trust the plan counter/);
    assert.match(result.stderr, /matches neither count/, 'and it names which half of the line is wrong');
    assert.match(result.stderr, /did not stop the workflow/);
    assert.ok(!result.stderr.includes('before continuing'), 'a completed phase must not be told to stop');
  });
});

// allow-test-rule: source-text-is-the-product (#3830)
//
// #3862 RV6.5 adversarial review: the two CLI regression tests above pin
// `--pick reason`'s three outcomes, but they drive the BINARY — they would pass
// unchanged against the pre-rework caller snippets, so nothing tested the
// callers themselves. The deployed contract for a workflow/agent caller IS the
// markdown text the runtime loads, so a source-text guard is the available
// instrument, exactly as tests/no-bare-gsd-tools-command-position.test.cjs
// argues for its own class.
//
// The caller set is DERIVED, not hardcoded: every agents/*.md and
// gsd-core/workflows/*.md that actually invokes the verb is enumerated and each
// must discriminate on the reason. A third caller added later is covered the
// moment it lands — which matters, because this round's own review named
// "the sole in-repo caller" when there were two.
describe('#3830/#3862: every markdown caller of state.advance-plan discriminates on the reason', () => {
  const ROOT = path.resolve(__dirname, '..');
  const SCAN_ROOTS = [path.join(ROOT, 'agents'), path.join(ROOT, 'gsd-core', 'workflows')];

  // RECURSIVE. gsd-core/workflows/ is a tree — execute-phase/steps/, autonomous/steps/
  // and thirty-odd siblings — so a readdirSync of the top level alone is blind to
  // most of the surface a future caller would land in.
  const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, out);
      else if (ent.name.endsWith('.md')) out.push(full);
    }
    return out;
  };

  // The invocation, in any spelling: `gsd_run query state.advance-plan`, and the
  // bare `node .../gsd-tools.cjs query state.advance-plan` form the helper wraps.
  const INVOKES = /query\s+state\.advance-plan/;

  // Scope every structural assertion to the FENCED BLOCK that holds the call, not
  // to the whole file. A whole-file search cannot tell a guard next to the call
  // from a `position_diverged` mentioned four hundred lines away in prose.
  //
  // EVERY such block, not the first. An earlier draft returned on the first match
  // and adversarial review broke it in one move: a file whose first fence is fully
  // compliant and whose second fence invokes the verb unguarded passed every
  // assertion here, because the second fence was never looked at. One record per
  // BLOCK, so a caller with two invocations is two subjects.
  //
  // `\r?\n` deliberately: under Windows autocrlf these files arrive CRLF, a bare
  // `\n` here would match no fence at all, and a guard that finds no block to scan
  // reports PASS by vacuity. The sanity tests below are the backstop for exactly
  // that failure; this is the fix for it.
  // Each hit carries the fence's END offset as well as its body, because the halt
  // instruction this guard also checks lives in the prose AFTER the fence, not in it.
  const invocationBlocks = (text) => {
    const out = [];
    // Rule widened to tests/**/*.cjs by #3951 (15af0f553), so this pre-existing helper is
    // linted now. stripFencedCode() is the wrong shape here: it REMOVES fenced blocks, and
    // this needs to keep them with their end offsets so each assertion can be scoped to the
    // invocation's own fence.
    for (const m of text.matchAll(/^```bash\r?\n([\s\S]*?)^```/gm)) { // allow-adhoc-markdown: needs the fences kept + located, not stripped
      if (INVOKES.test(m[1])) out.push({ block: m[1], end: m.index + m[0].length });
    }
    return out;
  };

  const countInvocations = (text) => (text.match(new RegExp(INVOKES.source, 'g')) || []).length;

  // The window the halt instruction must appear in. Generous enough not to be a
  // formatting trap, tight enough that prose three sections away cannot satisfy it.
  const HALT_WINDOW = 900;

  // One entry per invocation-bearing BLOCK. `name` carries the block's ordinal so a
  // failure names which of a file's fences is at fault.
  const callerFiles = () => {
    const hits = [];
    for (const root of SCAN_ROOTS) {
      for (const full of walk(root)) {
        const text = fs.readFileSync(full, 'utf-8');
        if (!INVOKES.test(text)) continue;
        const rel = path.relative(ROOT, full);
        const blocks = invocationBlocks(text);
        blocks.forEach(({ block, end }, i) => {
          hits.push({
            full, text, block,
            after: text.slice(end, end + HALT_WINDOW),
            name: blocks.length > 1 ? `${rel} [fence ${i + 1}]` : rel,
          });
        });
      }
    }
    return hits;
  };

  test('sanity: at least two callers are found (else this guard is vacuous)', () => {
    const found = callerFiles();
    assert.ok(found.length >= 2,
      `expected >=2 markdown callers of state.advance-plan, found ${found.length}: ${found.map((f) => f.name).join(', ')}`);
  });

  test('sanity: every invocation in the file lands in a scanned fence (none escapes the guard)', () => {
    // The accounting check. A guard that inspects fences is blind to an invocation
    // outside every fence, and blind to a SECOND fence if it stops at the first —
    // adversarial review broke the earlier draft exactly that way. Requiring the
    // whole-file invocation count to equal the count inside the scanned blocks
    // closes both at once, and cannot itself pass vacuously: zero blocks against a
    // non-zero file count fails.
    const seen = new Set();
    for (const { full, text } of callerFiles()) {
      if (seen.has(full)) continue;
      seen.add(full);
      const inFile = countInvocations(text);
      const inBlocks = invocationBlocks(text).reduce((n, b) => n + countInvocations(b.block), 0);
      assert.strictEqual(inBlocks, inFile,
        `${path.relative(ROOT, full)} invokes state.advance-plan ${inFile} time(s) but only ${inBlocks} are inside a scanned \`\`\`bash fence — the rest are unguarded and invisible to every assertion below`);
    }
  });

  test('each caller invokes the verb BARE, so its answer keeps the shape the arms match', () => {
    // #3862 RV6.5 pass 4 (CLAIM A). The arms match on `"advanced": true` in the
    // verb's own JSON. `--raw` and `--pick advanced` are legal on this verb and
    // make a genuine advance print bare `true` at exit 0 — which matches no arm, so
    // the callers would stop recording on EVERY advance, forever, silently. That is
    // strictly worse than the bug being fixed. Nothing stops a later edit adding
    // one for terseness, so pin the bare form here rather than teaching the arms
    // three output shapes.
    for (const { name, block } of callerFiles()) {
      const line = block.split(/\r?\n/).find((l) => INVOKES.test(l)) || '';
      assert.ok(!/--raw\b|--pick\b|--json-errors\b/.test(line),
        `${name} invokes state.advance-plan with an output-shaping flag (${line.trim()}) — it changes the payload the arms match on`);
    }
  });

  test('each caller branches on position_diverged, never on `--pick advanced`', () => {
    for (const { name, block } of callerFiles()) {
      assert.ok(block.includes('position_diverged'),
        `${name}'s invocation block must read the refusal reason and name position_diverged as what it stops on`);
      assert.ok(/"error":/.test(block),
        `${name}'s invocation block must also handle the exit-0 {"error": ...} shape — it is equally not an advance`);
      // The regression this guard exists for: `advanced: false` is ALSO the
      // ordinary last-plan answer, so branching on it skips the final plan's
      // progress and metric write on every phase.
      assert.ok(!/--pick advanced/.test(block),
        `${name} must NOT branch on --pick advanced — last_plan is also advanced:false`);
    }
  });

  test('each caller ALLOW-LISTS the answers that owe recording, rather than deny-listing', () => {
    // #3862 RV6.5 pass 3 (MISSED) and its follow-through. The first shape here was
    // a deny-list — stop on position_diverged, stop on {"error": ...}, and let the
    // catch-all write. That writes on every shape it has not been taught about: a
    // crashed or missing gsd_run leaving the capture EMPTY (verified against the
    // pre-fix source — update-progress ran, no STOP printed), and equally any
    // refusal reason the verb grows later. Three answers mean this plan's work is
    // recorded — a real advance, the ordinary last plan, and #4067's
    // `plans_outstanding` (this plan done, siblings still writing) — so exactly
    // those three may record, and the arm names each one.
    for (const { name, block } of callerFiles()) {
      assert.ok(/^\s*\*'"advanced": true'\*\|\*'"reason": "last_plan"'\*\|\*'"reason": "plans_outstanding"'\*\)/m.test(block),
        `${name} must open its writing arm on the three recording answers explicitly, not on a catch-all`);
      const invIdx = block.search(INVOKES);
      const preCase = block.slice(invIdx, block.indexOf('case "', invIdx));
      assert.ok(/\$\?/.test(preCase),
        `${name} must capture the exit status so the refusal it reports can name it`);
    }
  });

  test('each caller CONTAINS its state writes in the advancing arm, and never in the catch-all', () => {
    // Containment proved structurally — every write between the allow arm and its
    // `;;`, and NONE between the bare `*)` catch-all and `esac` — rather than by a
    // character-distance window past the first guard mention. Both writes are
    // covered, not update-progress alone.
    const WRITES = ['state.update-progress', 'state.record-metric'];
    const allOccurrences = (hay, needle) => {
      const out = [];
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
      return out;
    };
    for (const { name, block } of callerFiles()) {
      const allowIdx = block.search(/^\s*\*'"advanced": true'\*/m);
      const allowEnd = block.indexOf(';;', allowIdx);
      const guardIdx = block.indexOf('position_diverged', allowEnd);
      const catchAll = block.search(/^\s*\*\)\s*$/m);
      const esacIdx = block.search(/^\s*esac\s*$/m);
      assert.ok(allowIdx >= 0 && allowEnd > allowIdx && guardIdx > allowEnd
                && catchAll > guardIdx && esacIdx > catchAll,
        `${name}: expected the allow arm, then the divergence arm, then a bare \`*)\` catch-all, then \`esac\``);
      for (const write of WRITES) {
        const at = allOccurrences(block, write);
        assert.ok(at.length > 0, `${name}'s invocation block must contain the ${write} call it protects`);
        for (const idx of at) {
          assert.ok(idx > allowIdx && idx < allowEnd,
            `${name} runs ${write} at offset ${idx}, outside the advancing arm (${allowIdx}..${allowEnd}) — it is unguarded`);
        }
      }
      const catchAllBody = block.slice(catchAll, esacIdx);
      for (const write of WRITES) {
        assert.ok(!catchAllBody.includes(write),
          `${name}'s catch-all arm runs ${write} — an unrecognized answer must never record state`);
      }
    }
  });

  test('each caller carries the HALT instruction the shell cannot enforce for it', () => {
    // #3862 RV9 claim audit. The comment drafted for that round claimed every
    // behavioural fix fails a named test on reversion; the auditor removed both
    // callers' halt paragraphs, kept the case guards, and every test here stayed
    // green. It was right — nothing pinned them.
    //
    // These paragraphs are behaviour, not commentary. A `case` arm suppresses only
    // its own block: it cannot stop the FENCED BLOCK THAT FOLLOWS, and in both
    // callers something follows that writes state (execute-plan's later steps,
    // gsd-executor's ROADMAP/requirements block). The arm handles the writes it
    // owns; the prose is the only thing that stops the rest. Delete it and the
    // guard silently covers half of what it is documented to cover.
    //
    // Pinned as three agreeing parts rather than as a quoted sentence, so rewording
    // is free and deleting is not.
    for (const { name, block, after } of callerFiles()) {
      // 1. The block emits a marker at all — otherwise the prose points at nothing.
      const marker = block.match(/echo "(STOP:)/);
      assert.ok(marker,
        `${name}'s refusal arms must print a STOP: marker for the halt instruction below to key on`);

      // 2. The prose after the fence refers to that same marker. This is what ties
      //    the instruction to THIS block rather than to generic advice elsewhere.
      assert.ok(after.includes('`STOP:`'),
        `${name} must follow its invocation fence with an instruction naming the \`STOP:\` marker the block prints; found none within ${HALT_WINDOW} chars`);

      // 3. It actually instructs a stop, and says WHY the shell did not do it —
      //    the clause a later editor prunes as verbose, which is precisely the one
      //    that makes the paragraph load-bearing rather than decorative.
      assert.ok(/\b(halt|do not run|do not proceed|do not continue)\b/i.test(after),
        `${name}'s halt instruction must tell the agent to stop, not merely describe the refusal`);
      assert.ok(/cannot stop|suppresses only|never a later|not the shell/i.test(after),
        `${name}'s halt instruction must say why the shell cannot enforce it — a \`case\` arm cannot stop a later fenced block, and that is the reason this prose exists`);
    }
  });

  // #3862 review (Major 5): every assertion above is SOURCE-TEXT — they prove the
  // arms exist and are shaped correctly, and prove nothing about whether they match
  // what the verb actually prints. The arms glob on the literal bytes
  // `"advanced": true`, with exactly one space, produced by serializeForOutput ->
  // JSON.stringify(result, null, 2) (src/io.cts). Switch output() to compact JSON,
  // add a space-stripping post-processor, or route this payload through a form the
  // wrapper does not re-expand, and BOTH first-party callers fall into the
  // catch-all on every successful advance — permanently, silently, and with no test
  // red anywhere. That is strictly worse than the bug being fixed, and it is the
  // same class the "invoke the verb BARE" test above was written to prevent: a
  // constant shared across parallel surfaces with no parity assertion.
  //
  // So execute the pairing rather than asserting about it. Produce each answer
  // shape from the REAL verb, then run each caller's OWN `case` block against that
  // real stdout under a REAL shell. Re-implementing glob matching in JS would test
  // this file's matcher instead of theirs; the arms are shell, so bash is the only
  // faithful matcher available.
  test('each caller\'s case arms match the verb\'s REAL output, shape by shape', () => {
    const { execFileSync } = require('child_process');

    const projectDir = createFixture();
    const stateWith = (planLine) => [
      '# Project State', '', '## Current Position', '',
      'Phase: 01 (Demo Phase) — EXECUTING', planLine,
      'Status: Ready to execute', 'Last Activity: 2026-08-01', '',
    ].join('\n');
    const seed = (planCount, summaries = true) => {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-demo');
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= planCount; i++) {
        const id = String(i).padStart(2, '0');
        fs.writeFileSync(path.join(phaseDir, `01-${id}-PLAN.md`), '---\nstatus: complete\n---\n# Plan\n');
        if (summaries) {
          fs.writeFileSync(path.join(phaseDir, `01-${id}-SUMMARY.md`), '---\nstatus: complete\n---\n# Summary\n');
        }
      }
    };
    const put = (planLine) =>
      fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), stateWith(planLine));
    const advanceOut = () => runGsdTools('state advance-plan', projectDir).output;

    // Eighth shape, and the first one the callers are TAUGHT rather than fail closed
    // on: #4292 (fix #4067) landed on next in round 7 and re-decides the completion
    // branch from disk, declining `plans_outstanding` while sibling plans have no
    // SUMMARY.md yet. That answer is the wave-parallel executor's ordinary end of a
    // plan, so it owes the recording — arm 0, with `advanced: true` and `last_plan`.
    // Produced FIRST, before seed() writes the summaries: seed only ever adds files.
    seed(12, false);
    put('Plan: 12 of 12'); const OUT_OUTSTANDING = advanceOut();

    seed(12);

    // The five shapes, each from the real binary except the non-answer, which is
    // BY DEFINITION what a crashed `gsd_run` leaves in the capture.
    put('Plan: 3 of 12');  const OUT_ADVANCED = advanceOut();
    put('Plan: 12 of 12'); const OUT_LAST     = advanceOut();
    put('Plan: 2 of 8');   const OUT_DIVERGED = advanceOut();
    put('Status: no plan line at all'); const OUT_ERROR = advanceOut();

    // Sixth shape, and it did not exist when this PR opened: #3807/#4028 landed on
    // next while this branch was in review and gave advancePlanCore a NEW refusal
    // (`ambiguous_position_phase`, for a Current Position carrying more than one
    // `Phase:` entry). It is exactly the case the allow-list was chosen for — a
    // reason the callers were never taught — so pin that it reaches the catch-all
    // rather than assuming the property still holds.
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), [
      '# Project State', '', '## Current Position', '',
      'Phase: 01 (Demo Phase) — EXECUTING',
      'Phase: 02 (Second Phase) — EXECUTING',
      'Plan: 3 of 12',
      'Status: Ready to execute', 'Last Activity: 2026-08-01', '',
    ].join('\n'));
    const OUT_AMBIGUOUS = advanceOut();

    // Seventh shape, and it arrived the same way the sixth did: #3791 landed on next
    // while this branch was in review and gave advancePlanCore ANOTHER new refusal
    // (`ambiguous_plan_position`, for a STATE.md carrying the legacy `Current Plan: N`
    // and the compound `Plan: X of Y` at DIFFERENT numbers). Pinned for the reason the
    // sixth is: the allow-list's whole claim is that a reason the callers were never
    // taught fails closed, and that claim is worth exactly as much as the number of
    // untaught reasons actually driven against it.
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), [
      '# Project State', '', '## Current Position', '',
      'Phase: 01 (Demo Phase) — EXECUTING',
      'Current Plan: 3',
      'Total Plans in Phase: 12',
      'Plan: 5 of 12',
      'Status: Ready to execute', 'Last Activity: 2026-08-01', '',
    ].join('\n'));
    const OUT_AMBIGUOUS_PLAN = advanceOut();

    const OUT_EMPTY = '';

    // Sanity: the fixtures really did produce the shapes this test is about. Without
    // this, a fixture that silently stopped producing (say) a divergence would make
    // every arm assertion below pass against an empty string.
    assert.match(OUT_ADVANCED, /"advanced":\s*true/, 'fixture did not produce a real advance');
    assert.match(OUT_LAST, /"reason":\s*"last_plan"/, 'fixture did not produce last_plan');
    assert.match(OUT_DIVERGED, /"reason":\s*"position_diverged"/, 'fixture did not produce a divergence');
    assert.match(OUT_ERROR, /"error"/, 'fixture did not produce an exit-0 error object');
    assert.match(OUT_AMBIGUOUS, /"reason":\s*"ambiguous_position_phase"/,
      'fixture did not produce #4028\'s ambiguous-position refusal');
    assert.match(OUT_AMBIGUOUS_PLAN, /"reason":\s*"ambiguous_plan_position"/,
      'fixture did not produce #3791\'s ambiguous-plan refusal');
    assert.match(OUT_OUTSTANDING, /"reason":\s*"plans_outstanding"/,
      'fixture did not produce #4067\'s plans_outstanding decline');

    // Lift the caller's own `case` block and replace each arm BODY with an echo of
    // its index, leaving every PATTERN byte-identical to what ships.
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const armPatterns = (block) => {
      const m = block.match(/case\s+"\$\{ADVANCE_OUT\}"\s+in\r?\n([\s\S]*?)\r?\n\s*esac/);
      assert.ok(m, 'could not locate the case block — the source-text guards above should have caught this first');
      return m[1].split(';;')
        .map((seg) => seg.split(/\r?\n/).map((l) => l.trim())
          .find((l) => l && !l.startsWith('#') && l.endsWith(')')))
        .filter(Boolean)
        .map((l) => l.slice(0, -1));
    };

    // Arm 0 records (advance + last_plan + #4067's plans_outstanding); arm 1 is the
    // named divergence stop; the final arm is the catch-all. An answer the callers
    // were never taught must reach the catch-all — that is the allow-list property,
    // checked against real bytes.
    const EXPECT = [
      ['a real advance',        OUT_ADVANCED, 0],
      ['the last plan',         OUT_LAST,     0],
      ['#4067 plans outstanding', OUT_OUTSTANDING, 0],
      ['a divergence refusal',  OUT_DIVERGED, 1],
      ['an exit-0 error object', OUT_ERROR,   'last'],
      ['#4028 ambiguous position', OUT_AMBIGUOUS, 'last'],
      ['#3791 ambiguous plan position', OUT_AMBIGUOUS_PLAN, 'last'],
      ['a non-answer (crash)',  OUT_EMPTY,    'last'],
    ];

    for (const { name, block } of callerFiles()) {
      const patterns = armPatterns(block);
      assert.ok(patterns.length >= 3, `${name}: expected at least three arms, got ${patterns.length}`);
      const script = 'case "$1" in\n'
        + patterns.map((p, i) => `${p}) echo ${i};;`).join('\n')
        + '\nesac\n';
      for (const [label, payload, want] of EXPECT) {
        const got = execFileSync('bash', ['-c', script, '_', payload],
          { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS }).trim();
        const expected = want === 'last' ? String(patterns.length - 1) : String(want);
        assert.strictEqual(got, expected,
          `${name}: ${label} matched arm ${got || '(none)'}, expected arm ${expected}. `
          + `The caller's arms and the verb's real output have drifted apart.`);
      }
    }
  });

});

describe('#3830 facet 2: state advance-plan rejects options instead of discarding them', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createFixture(); });
  afterEach(() => { cleanup(tmpDir); });

  const seedSimpleState = () =>
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\nPlan: 2 of 5 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n',
    );

  test('--plan / --total are rejected rather than silently ignored', () => {
    seedSimpleState();
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state advance-plan --plan 10 --total 10', tmpDir);
    assert.ok(!result.success, 'unrecognized options must fail, not return a confident wrong answer');

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'a rejected invocation must not mutate STATE.md');
  });

  test('the rejection names the offending options', () => {
    seedSimpleState();
    const result = runGsdTools('state advance-plan --bogus', tmpDir);
    const combined = `${result.output || ''}${result.error || ''}`;
    assert.ok(combined.includes('--bogus'), `rejection should name --bogus; got: ${combined}`);
  });

  test('a structured error carries a reason code for --json-errors callers', () => {
    seedSimpleState();
    const result = runGsdTools('state advance-plan --bogus --json-errors', tmpDir);
    const combined = `${result.output || ''}${result.error || ''}`;
    const line = combined.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `expected a JSON error object; got: ${combined}`);
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.ok, false);
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
  });

  test('--raw is not mistaken for a command option', () => {
    seedSimpleState();
    const result = runGsdTools('state advance-plan --raw', tmpDir);
    assert.ok(result.success, `--raw must still work: ${result.error}`);
    assert.strictEqual(result.output.trim(), 'true');
  });

  test('the other global flags are not mistaken for command options either', () => {
    // main() splices each of these out of argv before any router runs, so the
    // strict check must never see them. Exercised individually rather than
    // asserted collectively — a false rejection on any one breaks its callers.
    //
    // #3862 review (Minor): this asserted ONLY the negative, so it passed if the
    // command failed for any other reason at all. `result.success` is the
    // assertion that actually pins "was accepted"; the message check now just
    // localises a regression when it fires.
    //
    // The list is the whole splice set. It claimed to be that once before and was not:
    // the #3862 RV6.5 review found `--project-dir`/`--project-dir=` and
    // `--exit-contract=` also spliced by main() and covered by nothing here, so the
    // "whole splice set" comment was asserting its own completeness while short of it.
    // Now: --json-errors, --cwd, --cwd=, --default, --project-dir, --project-dir=,
    // --exit-contract= in the loop; --raw and --pick in their own tests below;
    // --ws/--ws= spliced by resolveActiveWorkstream. This test is the only guard that
    // the router's strict index-2 rule cannot falsely reject one of them.
    // #3862 RV6.5 review: `result.success` + "no rejection message" was VACUOUS, and
    // the review demonstrated it on this very list. `--ws default` redirects the read
    // to an unseeded workstream, so it exits 0 with `{"error":"STATE.md not found"}` —
    // the flag was accepted, `advance-plan` never ran, and both old assertions passed.
    // "Was not rejected" is not "did the work". Assert the ADVANCE.
    for (const flag of ['--json-errors', `--cwd ${tmpDir}`, `--cwd=${tmpDir}`, '--default x',
                        `--project-dir ${tmpDir}`, `--project-dir=${tmpDir}`, '--exit-contract=v1']) {
      seedSimpleState();
      const result = runGsdTools(`state advance-plan ${flag}`, tmpDir);
      const combined = `${result.output || ''}${result.error || ''}`;
      assert.ok(result.success, `${flag} must still be accepted; got: ${combined}`);
      assert.ok(!/unknown flag|unexpected positional argument/.test(combined),
        `${flag} must not be rejected as a command option; got: ${combined}`);
      const parsed = JSON.parse(result.output);
      assert.strictEqual(parsed.advanced, true,
        `${flag} must be spliced out and let the verb actually RUN, not merely be accepted; got: ${result.output}`);
    }
  });

  test('--ws and --ws= are spliced out, and the verb runs in the selected workstream', () => {
    // Split from the loop above because these two do not read the project root: they
    // redirect to .planning/workstreams/<name>/, which has to exist and carry its own
    // STATE.md or the verb legitimately reports "STATE.md not found" — the exact shape
    // that made the old assertion vacuous. Seed it, then assert the advance.
    for (const form of ['--ws wsone', '--ws=wsone']) {
      const dir = createFixture();
      seedWorkstream(dir, {
        name: 'wsone',
        state: [
          '# Project State', '', '## Current Position', '',
          'Phase: 01 (Demo Phase)', 'Plan: 2 of 5', 'Status: Ready to execute',
          'Last Activity: 2026-08-01', '',
        ].join('\n'),
      });

      const result = runGsdTools(`state advance-plan ${form}`, dir);
      const combined = `${result.output || ''}${result.error || ''}`;
      assert.ok(result.success, `${form} must be accepted; got: ${combined}`);
      assert.ok(!/unknown flag|unexpected positional argument/.test(combined),
        `${form} must not be rejected as a command option; got: ${combined}`);
      const parsed = JSON.parse(result.output);
      assert.strictEqual(parsed.advanced, true,
        `${form} must reach the workstream's own STATE.md and advance it; got: ${result.output}`);
      assert.strictEqual(parsed.current_plan, 3);
    }
  });

  // #3862 review (Blocker 1): the bespoke `--` carve-out is GONE, and with it the
  // three tests that pinned it. #3884 landed `parseNamedArgsOrExit` and wired it
  // through every other arm in src/state-command-router.cts, so this verb now
  // shares their contract instead of shipping a second one: `--` is an unknown
  // flag (`isFlagToken('--')` is true and its name is the empty string), and
  // there is no end-of-options handling to honour. Accepting a bare `--` here
  // while every sibling rejects it is the divergence the review named; if bare
  // `--` should be legal it belongs in the owner, where all the arms agree.
  test('`--` follows the canonical argv contract, like every sibling arm', () => {
    for (const argv of [['--'], ['--', '--plan'], ['--', '--']]) {
      seedSimpleState();
      const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      const result = runGsdTools(['state', 'advance-plan', ...argv], tmpDir);
      const combined = `${result.output || ''}${result.error || ''}`;
      assert.ok(!result.success, `${argv.join(' ')} must be rejected; got: ${combined}`);
      assert.ok(combined.includes('unknown flag'),
        `the rejection must use the canonical owner's wording; got: ${combined}`);
      assert.strictEqual(
        fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'), before,
        'a rejected invocation must not mutate STATE.md',
      );
    }
  });

  // #3862 review (Minor): operands and short options were silently discarded —
  // the identical #3830-facet-2 defect at a token shape the `--`-prefix filter
  // could not see. This verb takes no options and no operands, so each of these
  // is unambiguously invalid input that used to return a confident answer it had
  // not been asked for.
  test('bare operands are rejected rather than silently discarded', () => {
    for (const operand of ['5', '01']) {
      seedSimpleState();
      const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      const result = runGsdTools(['state', 'advance-plan', operand], tmpDir);
      const combined = `${result.output || ''}${result.error || ''}`;
      assert.ok(!result.success, `operand ${operand} must be rejected; got: ${combined}`);
      assert.ok(combined.includes(operand), `the rejection should name ${operand}; got: ${combined}`);
      assert.strictEqual(
        fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'), before,
        'a rejected invocation must not mutate STATE.md',
      );
    }
  });

  test('short options are rejected rather than silently discarded', () => {
    for (const argv of [['-x'], ['-p', '10']]) {
      seedSimpleState();
      const result = runGsdTools(['state', 'advance-plan', ...argv], tmpDir);
      const combined = `${result.output || ''}${result.error || ''}`;
      assert.ok(!result.success, `${argv.join(' ')} must be rejected; got: ${combined}`);
      assert.ok(combined.includes(argv[0]), `the rejection should name ${argv[0]}; got: ${combined}`);
    }
  });

  test('--pick still projects a field', () => {
    seedSimpleState();
    const result = runGsdTools('state advance-plan --pick advanced', tmpDir);
    assert.ok(result.success, `--pick must still work: ${result.error}`);
    assert.strictEqual(result.output.trim(), 'true');
  });
});

describe('cmdStateRecordMetric (state record-metric)', () => {
  let tmpDir;

  const metricsFixture = [
    '# Project State',
    '',
    '## Performance Metrics',
    '',
    '| Plan | Duration | Tasks | Files |',
    '|------|----------|-------|-------|',
    '| Phase 1 P1 | 3min | 2 tasks | 3 files |',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('appends metric row to existing table', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 2 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('| Phase 2 P1 | 5min | 3 tasks | 4 files |'), 'new row should be present');
    assert.ok(updated.includes('| Phase 1 P1 | 3min | 2 tasks | 3 files |'), 'existing row should still be present');
  });

  // #2245 Blocker 2: a RAGGED sibling data row (a hand-edited stray/extra
  // pipe) in the existing Performance Metrics table used to fail the
  // whole-table `parseMarkdownTable` gate, which fell through to the
  // "section absent (or malformed)" scaffold branch and appended a SECOND
  // "## Performance Metrics" heading — compounding on every per-plan
  // record-metric call. The append must be ragged-tolerant: it locates the
  // table's last existing row and splices the new row after it WITHOUT
  // requiring every sibling row to parse cleanly, and must never introduce a
  // duplicate heading when a (possibly ragged) table already exists.
  test('#2245 appends into a RAGGED existing table without duplicating the heading', () => {
    const raggedFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      '| Phase 1 P1 | 3min | 2 tasks | 3 files |',
      '| Phase 1 P2 | 4min | 3 tasks | 5 files | extra |',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), raggedFixture);

    const result = runGsdTools('state record-metric --phase 2 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(!output.created, 'created must be absent/false — an existing (ragged) section must not be treated as auto-created');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const headingMatches = updated.match(/^## Performance Metrics\s*$/gim) || [];
    assert.strictEqual(headingMatches.length, 1, `exactly ONE "## Performance Metrics" heading expected, got ${headingMatches.length}:\n${updated}`);
    assert.ok(updated.includes('| Phase 1 P2 | 4min | 3 tasks | 5 files | extra |'), 'existing ragged row must be preserved verbatim');
    assert.ok(updated.includes('| Phase 1 P1 | 3min | 2 tasks | 3 files |'), 'existing clean row should still be present');
    assert.ok(updated.includes('| Phase 2 P1 | 5min | 3 tasks | 4 files |'), 'new row should be appended into the existing table');
  });

  // #2245/#2143: a live STATE.md's "## Performance Metrics" section also
  // carries the "By Phase" velocity table (gsd-core/templates/state.md:48,
  // `| Phase | Plans | Total | Avg/Plan |`), which the prior "first table in
  // the section" targeting polluted with a mismatched per-plan row on EVERY
  // plan completion (execute-plan.md:414 calls record-metric per-plan). The
  // command must target ITS OWN `| Plan | Duration | Tasks | Files |` table
  // specifically, self-creating one when the section exists but doesn't
  // carry it yet.
  test('#2245/#2143: record-metric does not pollute the By-Phase velocity table (targets its own metrics table)', () => {
    const byPhaseFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '**Velocity:**',
      '- Total plans completed: 0',
      '- Average duration: 0 min',
      '- Total execution time: 0.0 hours',
      '',
      '**By Phase:**',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| - | - | - | - |',
      '',
      '**Recent Trend:**',
      '- Last 5 plans: none',
      '- Trend: Stable',
      '',
      '*Updated after each plan completion*',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), byPhaseFixture);

    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(!output.created, 'created must be absent/false — the section already existed');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // (a) By-Phase table unchanged — header + placeholder row intact, and no
    // metric row spliced in between the delimiter and the next blank line.
    const byPhaseIdx = updated.indexOf('| Phase | Plans | Total | Avg/Plan |');
    assert.ok(byPhaseIdx !== -1, 'By-Phase table header must still exist');
    const afterHeader = updated.slice(byPhaseIdx);
    const byPhaseBlock = afterHeader.slice(0, afterHeader.indexOf('\n\n'));
    assert.ok(byPhaseBlock.includes('|-------|-------|-------|----------|'), 'By-Phase delimiter must be intact');
    assert.ok(byPhaseBlock.includes('| - | - | - | - |'), 'By-Phase placeholder row must be intact');
    assert.ok(!byPhaseBlock.includes('Phase 1 P1'), 'the per-plan row must NOT be spliced into the By-Phase table block');
    assert.ok(!byPhaseBlock.includes('5min'), 'the per-plan duration must NOT appear in the By-Phase table block');

    // (b) A dedicated `| Plan | Duration | Tasks | Files |` table now exists,
    // containing the new row.
    const metricsIdx = updated.indexOf('| Plan | Duration | Tasks | Files |');
    assert.ok(metricsIdx !== -1, 'a Per-Plan Metrics table must now exist');
    assert.ok(updated.includes('| Phase 1 P1 | 5min | 3 tasks | 4 files |'), 'the new metric row must be present in the Per-Plan Metrics table');

    // (c) exactly ONE "## Performance Metrics" heading.
    const headingMatches = updated.match(/^## Performance Metrics\s*$/gim) || [];
    assert.strictEqual(headingMatches.length, 1, `exactly ONE "## Performance Metrics" heading expected, got ${headingMatches.length}:\n${updated}`);

    // (d) Recent Trend block + footer preserved.
    assert.ok(updated.includes('**Recent Trend:**'), 'Recent Trend block must be preserved');
    assert.ok(updated.includes('*Updated after each plan completion*'), 'footer must be preserved');
  });

  test('replaces None yet placeholder with first metric', () => {
    const noneYetFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      'None yet',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), noneYetFixture);

    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min --tasks 1 --files 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('None yet'), 'None yet placeholder should be removed');
    assert.ok(updated.includes('| Phase 1 P1 | 2min | 1 tasks | 2 files |'), 'new row should be present');
  });

  test('returns error when required fields missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 1', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.includes('phase') || output.error.includes('plan') || output.error.includes('duration'),
      'error should mention missing required fields'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });
});

describe('cmdStateUpdateProgress (state update-progress)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version token)
    // is COMPLETE scope for windowing (§7.1) — without this, an absent
    // ROADMAP.md is UNREADABLE and state update-progress withholds
    // (updated:false) instead of computing a percent.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('calculates progress from plan/summary counts', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Phase 01: 1 PLAN + 1 SUMMARY = completed
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');

    // Phase 02: 1 PLAN only = not completed
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');
    // #3583: percent is now min(plan_fraction, phase_fraction) — the SAME
    // value the frontmatter sync seam derives — not raw plan throughput.
    // Plan fraction is 1/2 (50%), but neither phase has a passing
    // *-VERIFICATION.md, so completed_phases is 0/2 (0%) and the min caps at 0.
    assert.strictEqual(output.percent, 0, 'percent should be 0 (min-capped: 0/2 phases verified)');
    assert.strictEqual(output.completed, 1, 'completed should be 1');
    assert.strictEqual(output.total, 2, 'total should be 2');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('0%'), 'STATE.md Progress should contain 0% (min-capped)');
  });

  test('#3233: zero plans (0/0) is a no-op — does not clobber the Progress record', () => {
    // Post-milestone-close: .planning/phases/ holds no plans (0/0). The buggy path
    // mapped 0/0 through clampPercent to 0% and rewrote the shipped 100% record.
    // The fix no-ops when there are zero plans to measure.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [██████████] 100% of v1.0\n'
    );
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'zero plans → no-op (updated:false)');
    assert.ok(
      /no plans found/i.test(String(output.reason)),
      `should explain the no-op; got reason: ${output.reason}`
    );

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'STATE.md must be unchanged when no plans are found (#3233)');
  });

  test('#3233 negative-space: plans exist but none done still writes 0%', () => {
    // The fix no-ops ONLY on totalPlans===0. A milestone with plans but none
    // summarized must still write a legitimate 0% (not be suppressed).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [██████████] 100%\n'
    );
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'plans exist → write (updated:true)');
    assert.strictEqual(output.percent, 0, 'none done → 0% (legitimate, not suppressed)');
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(after.includes('0%'), 'STATE.md Progress should reflect 0%');
  });

  test('returns error when Progress field missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    // #3233: give the scan a plan so totalPlans > 0 clears the zero-plans
    // no-op guard and this test reaches the 'no Progress: line found' branch
    // it is named for (otherwise the guard fires first and the branch is uncovered).
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    // #3957: the reason now names the actual miss — the BODY Progress: line
    // is what's absent, not the frontmatter progress data (which was already
    // confirmed present a few lines above in cmdStateUpdateProgress, via
    // computeUpdateProgressPreview). The old 'Progress field not found in
    // STATE.md' reason named the wrong layer.
    assert.strictEqual(
      output.reason,
      'no Progress: line found in STATE.md body to update (frontmatter progress data is unaffected)',
    );
  });

  // ── #2177: frontmatter `progress:` key must not shadow the body Progress: line ──

  test('#2177 frontmatter progress: key is not matched — body Progress: line is the target', () => {
    // A STATE.md carrying YAML frontmatter (which writeStateMd adds to every
    // STATE.md). The lowercase `progress:` key used to be matched first by the
    // case-insensitive pattern, mangling the frontmatter and leaving the body
    // line stale.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        'progress:',
        '  total_phases: 1',
        '  completed_phases: 0',
        '  total_plans: 2',
        '  completed_plans: 1',
        '  percent: 20',
        '---',
        '',
        '# Project State',
        '',
        'Progress: [██░░░░░░░░] 20% (1/2 plans complete)',
        '',
      ].join('\n')
    );
    // 1 of 2 plans complete → 50%.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    // #3583: min-capped, not raw plan throughput — phase 01 has no passing
    // *-VERIFICATION.md, so completed_phases is 0/1 and the min caps at 0.
    assert.strictEqual(out.percent, 0);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // The body line advanced to 0% (min-capped) AND its descriptive suffix survived.
    // CONTRIBUTING.md "Prohibited: Raw Text Matching" — assert on the field
    // extractor's parsed value, not a substring of the whole rendered file.
    assert.strictEqual(bodyProgressPercent(updated), 0, 'body Progress line must update to 0% (min-capped)');
    const progressField = stateDocument.stateExtractField(updated, 'Progress');
    assert.ok(progressField && progressField.includes('(1/2 plans complete)'),
      'descriptive suffix must survive on the extracted Progress field');
    // The frontmatter block is intact (not mangled by the old \s*-crosses-newline match).
    assert.ok(updated.includes('total_phases: 1'), 'frontmatter total_phases key must survive');
    assert.ok(updated.includes('percent:'), 'frontmatter percent key must survive');
  });

  test('#2177 descriptive suffix after the machine segment is preserved', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [█████░░░░░] 50% (2/4 plans done; blocked on API keys)\n'
    );
    // 1 of 1 plan summarized, but no passing *-VERIFICATION.md → 0% (min-capped, see below).
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success);
    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // #3583: min-capped, not raw plan throughput — phase 01 has no passing
    // *-VERIFICATION.md, so completed_phases is 0/1 and the min caps at 0
    // even though the single plan is fully summarized.
    // CONTRIBUTING.md "Prohibited: Raw Text Matching" — parsed value, not rendered text.
    assert.strictEqual(bodyProgressPercent(updated), 0, 'the machine segment updates to 0% (min-capped)');
    const progressField = stateDocument.stateExtractField(updated, 'Progress');
    assert.ok(progressField && progressField.includes('(2/4 plans done; blocked on API keys)'),
      'the descriptive suffix is preserved verbatim on the extracted Progress field');
  });

  test('#2177 no body Progress: line → updated:false even if frontmatter has a progress: key', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'progress:', '  percent: 0', '---', '', '# Project State', '', '**Status:** Active', ''].join('\n')
    );
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, false,
      'a frontmatter progress: key with no body Progress: line must not report a false success');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  // ── #3583: single-percent parity — stdout, body bar, and frontmatter must
  // agree, all derived through the SAME computeProgressPercent(min(plan,
  // phase)) call the frontmatter sync seam (buildStateFrontmatter) uses. ──

  test('#3583: 3/4 plans done, 1/2 phases verified -> stdout, frontmatter, body bar, and state json all agree at 50', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Phase 01: fully planned, fully summarized, and verified (passing).
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '01', '01');

    // Phase 02: 2 plans, 1 summary (not fully realized), no verification.
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');

    // 3/4 plans summarized (75%), 1/2 phases verified (50%) -> min = 50.
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.percent, 50, 'stdout percent should be min-capped at 50');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(updated), 50, 'body bar should read 50%');

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const jsonOutput = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(jsonOutput.progress.percent), 50, 'frontmatter/state json percent should also be 50');
  });

  test('#3583: 3/4 plans, 0/2 phases verified -> all four surfaces are 0', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [██████████] 100%\n'
    );

    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-SUMMARY.md'), '# Summary\n');
    // No VERIFICATION.md for phase 01.

    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    // No VERIFICATION.md for phase 02 either.

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.percent, 0, 'stdout percent should be 0 (0/2 phases verified caps the min)');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(updated), 0, 'body bar should read 0%');

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const jsonOutput = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(jsonOutput.progress.percent), 0, 'frontmatter/state json percent should also be 0');
  });

  test('#3583: fully planned but partially realized ROADMAP still caps — no false 100%', () => {
    // ROADMAP declares 4 phases; only 2 have directories on disk, and both
    // realized phases are fully summarized AND verified (plan fraction 100%).
    // total_phases must still come from the ROADMAP (4), so completed_phases
    // (2/4 = 50%) caps the result well under 100%.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 01: First',
        '### Phase 02: Second',
        '### Phase 03: Third',
        '### Phase 04: Fourth',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    for (const num of ['01', '02']) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', num);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${num}-01-PLAN.md`), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, `${num}-01-SUMMARY.md`), '# Summary\n');
      writePassedVerification(tmpDir, num, num);
    }

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    // Plan fraction is 2/2 = 100%, but completed_phases is 2/4 = 50% against
    // the ROADMAP-declared total — the min caps the result at 50, never 100.
    assert.strictEqual(output.percent, 50, 'ROADMAP-declared unrealized phases must cap the percent, not report false 100%');

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const jsonOutput = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(jsonOutput.progress.total_phases), 4, 'total_phases should come from the ROADMAP, not just realized dirs');
    assert.strictEqual(Number(jsonOutput.progress.percent), 50, 'frontmatter/state json percent should also cap at 50');
  });

  test('#3583: all plans done and all phases verified -> 100 everywhere', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    for (const num of ['01', '02']) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', num);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${num}-01-PLAN.md`), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, `${num}-01-SUMMARY.md`), '# Summary\n');
      writePassedVerification(tmpDir, num, num);
    }

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.percent, 100);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(updated), 100, 'body bar should read 100%');

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const jsonOutput = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(jsonOutput.progress.percent), 100, 'frontmatter/state json percent should also be 100');
  });

  test('#3583/#3217: non-COMPLETE phase scope withholds before any percent is computed', () => {
    // Absent ROADMAP.md is UNREADABLE scope (see beforeEach comment above).
    fs.unlinkSync(path.join(tmpDir, '.planning', 'ROADMAP.md'));

    const before = '# Project State\n\n**Progress:** [██████████] 100%\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), before);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    writePassedVerification(tmpDir, '01', '01');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'non-COMPLETE scope must withhold, not compute a percent');
    assert.ok(/not complete/i.test(String(output.reason)), `should explain the withhold; got: ${output.reason}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'STATE.md must be unchanged when the phase scope withholds (#3217)');
  });

  test('#3583 follow-up: buildStateFrontmatter withhold (#1761 milestone-unbounded) is not papered over with plan throughput', () => {
    // Neither #3217 (non-COMPLETE phase scope) nor #3233 (zero plans) fires
    // here: STATE.md has no explicit `milestone:` field and ROADMAP.md has no
    // versioned heading, so this verb's own `phaseScope` guard (and
    // buildStateFrontmatter's `diskScope`) both classify as SCOPE.COMPLETE
    // (row 3, "free-form legacy roadmap") — the guard above never fires, and
    // plans exist on disk. But ROADMAP.md mentions a bare version token
    // ("v2.0") in body prose (not a heading, not a 🚧 bullet).
    // getMilestoneInfo's own bare-version-token fallback (roadmap-parser.cts)
    // picks that up as `assertedMilestoneVersion` — a signal this verb's
    // `phaseScope`/`storedMilestone` derivation never sees — and
    // buildStateFrontmatter's #1761 guard finds no ROADMAP HEADING matching
    // 'v2.0', so it withholds `progress.percent` even though diskScope is
    // COMPLETE. Before the fix, this verb fell back to
    // clampPercent(totalSummaries, totalPlans) and printed a percent the
    // frontmatter never wrote — reintroducing the exact #3583 defect for
    // this rarer case.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        'Target release: v2.0',
        '',
        '### Phase 1: Foo',
        '### Phase 2: Bar',
        '',
      ].join('\n')
    );

    const before = '# Project State\n\n**Progress:** [██████████] 100%\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), before);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false,
      'buildStateFrontmatter withheld a percent (#1761 milestone-unbounded) — the verb must withhold too, not fall back to plan throughput');
    assert.strictEqual(output.percent, undefined, 'no percent may be reported when the frontmatter withheld one');
    assert.ok(/withheld/i.test(String(output.reason)), `should explain the withhold; got: ${output.reason}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'STATE.md must be unchanged — no bar/percent written when the frontmatter withheld');

    // Confirm this is genuinely the #1761 path and not #3217/#3233: state json
    // must ALSO omit progress.percent for the same reason (proves buildStateFrontmatter
    // really withheld here, not merely a divergent local computation).
    const jsonResult = runGsdTools('state json --raw', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const jsonOutput = JSON.parse(jsonResult.output);
    assert.ok(
      jsonOutput.progress === undefined || jsonOutput.progress.percent === undefined,
      `state json must also omit percent for this fixture; got progress=${JSON.stringify(jsonOutput.progress)}`,
    );
  });

  test('#3583: derivation parity — completed_phases is verification-passed, not summary parity', () => {
    // Phase 01 is fully planned AND fully summarized (a summary-parity
    // derivation would call it "complete"), but carries NO passing
    // *-VERIFICATION.md. If the verb ever re-derives completed_phases from
    // summary parity instead of routing through the same isPhaseComplete
    // (verification-passed) owner buildStateFrontmatter uses, this becomes a
    // false 100% (plan fraction 2/2 AND a summary-parity phase fraction 1/1
    // both read 100%). The correct min-capped answer is 0, because
    // completed_phases is 0/1 under the verification-passed definition.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    // Deliberately no VERIFICATION.md: summary-parity says "complete",
    // verification-passed says "not complete".

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(
      output.percent,
      0,
      'completed_phases must come from verification-passed status (isPhaseComplete), not summary parity — ' +
      'a summary-parity derivation would wrongly report 100 here'
    );

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(updated), 0, 'body bar must reflect the verification-passed derivation, not summary parity');
  });

  test('#3583 finding 1: percent and completed/total must come from the SAME (stored-milestone-scoped) window, not a differently-scoped auto-derive', () => {
    // Reproduces the exact divergence: `cmdStateUpdateProgress`'s own guard
    // scan calls `listMilestonePhaseDirs(phasesDir, { cwd })` with NO
    // versionOverride, so it falls back to auto-deriving "current" via
    // `extractCurrentMilestoneScoped`, which (per #730/#2947) merges the
    // PREAMBLE — everything before the first milestone heading — into its
    // window UNLESS the selected milestone's own section already carries a
    // `### Phase N:` heading directly (in which case the preamble is
    // stripped of phase headings to avoid duplicating them). This milestone
    // section deliberately carries ONLY a checklist bullet (no heading of
    // its own — the heading lives in the split "(Phase Details)" section),
    // so that strip never fires and Phase 03's preamble heading leaks into
    // the auto-derived window. `buildStateFrontmatter`'s scan, scoped via
    // `versionOverride: storedMilestone` ("v2.0"), calls `sliceMilestoneWindow`
    // instead, which never includes the preamble — so it correctly excludes
    // Phase 03. Both windows classify SCOPE.COMPLETE (verified directly
    // against `listMilestonePhaseDirs` before this test was written), so
    // neither the #3217 nor the #1761 withhold intercepts — before the fix,
    // this silently produced percent:0 (derived from the correct v2.0-only
    // window: 1/1 plan, capped to 0 by the missing phase verification)
    // alongside completed:1/total:2 (leaking Phase 03's unsummarized plan
    // into the denominator from the auto-derived window) — mutually
    // inconsistent in the SAME JSON object. Fixed: completed/total now come
    // from the identical buildStateFrontmatter call percent does.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 03: Legacy Preamble Phase',
        '',
        '## v2.0: Current',
        '',
        '- [ ] **Phase 2: Feature**',
        '',
        '## v2.0 (Phase Details)',
        '',
        '### Phase 2: Feature',
        '**Goal:** build it.',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'gsd_state_version: "1.0"', 'milestone: v2.0', 'status: executing', '---', '',
        '# Project State', '', '**Progress:** [░░░░░░░░░░] 0%', ''].join('\n')
    );

    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    // Phase 03 belongs to no milestone (preamble-only) and is NOT summarized —
    // if it leaks into the reported denominator, completed/total disagree
    // with the v2.0-scoped percent.
    const phase03Dir = path.join(tmpDir, '.planning', 'phases', '03');
    fs.mkdirSync(phase03Dir, { recursive: true });
    fs.writeFileSync(path.join(phase03Dir, '03-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'both windows are SCOPE.COMPLETE — neither withhold guard should fire');

    // The mutual-consistency assertion finding 1 requires: completed/total
    // must describe the SAME window percent was computed against (v2.0 only:
    // phase 02, 1 plan, not phase-verified → percent 0; NOT phase 03's leaked
    // unsummarized plan folded into the denominator).
    assert.strictEqual(output.percent, 0, 'v2.0-scoped plan fraction (1/1) is capped to 0 by the missing phase verification');
    assert.strictEqual(output.total, 1, 'total must be v2.0-scoped (phase 02 only) — Phase 03 must not leak in from the auto-derived scan');
    assert.strictEqual(output.completed, 1, 'completed must be v2.0-scoped (phase 02 only)');
  });
});

describe('#4213: resyncing state verbs keep body Progress bar equal to frontmatter progress.percent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    for (const num of ['01', '02', '03', '04']) {
      const dir = path.join(tmpDir, '.planning', 'phases', num);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${num}-PLAN.md`), '# Plan\n');
    }
  });

  afterEach(() => cleanup(tmpDir));

  function seedState(seededPercent = 50, withProgress = true) {
    const progressLine = withProgress
      ? `Progress: [█████░░░░░] ${seededPercent}% (2/4 plans done)`
      : '**Status:** Executing';
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: "1.0"\nstatus: executing\nprogress:\n  total_phases: 4\n  completed_phases: ${seededPercent / 25}\n  total_plans: 4\n  completed_plans: ${seededPercent / 25}\n  percent: ${seededPercent}\n---\n\n# Project State\n\n${progressLine}\n`
    );
  }

  function completePhasesOnDisk(count) {
    for (const num of ['01', '02', '03', '04'].slice(0, count)) {
      const dir = path.join(tmpDir, '.planning', 'phases', num);
      fs.writeFileSync(path.join(dir, `${num}-PLAN-SUMMARY.md`), '# Summary\n');
      writePassedVerification(tmpDir, num, num);
    }
  }
  function assertProgress(expected, suffix = false) {
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(state), expected);
    assert.strictEqual(Number(JSON.parse(runGsdTools('state json', tmpDir).output).progress.percent), expected);
    if (suffix) assert.match(stateDocument.stateExtractField(state, 'Progress'), /\(2\/4 plans done\)/);
  }
  test('resyncing verbs repair drift-up and preserve the body suffix', () => {
    for (const command of [['state', 'record-session', '--stopped-at', '2.3'], 'state sync']) {
      seedState();
      completePhasesOnDisk(3);
      assert.ok(runGsdTools(command, tmpDir).success, `${command} failed`);
      assertProgress(75, true);
    }
  });
  test('a no-drift write keeps both surfaces at the existing percent', () => {
    seedState(); completePhasesOnDisk(2);
    assert.ok(runGsdTools(['state', 'record-session', '--stopped-at', '2.3'], tmpDir).success);
    assertProgress(50);
  });
  test('resyncing verbs repair drift-down without inserting a missing bar', () => {
    seedState();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 01: A\n### Phase 02: B\n### Phase 03: C\n### Phase 04: D\n### Phase 05: E\n### Phase 06: F\n');
    completePhasesOnDisk(2);
    assert.ok(runGsdTools(['state', 'add-decision', '--phase', '3', '--summary', 's'], tmpDir).success);
    assertProgress(33);
    seedState(50, false);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    completePhasesOnDisk(3);
    assert.ok(runGsdTools(['state', 'record-session', '--stopped-at', '2.3'], tmpDir).success);
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(state), null);
    assert.strictEqual(Number(JSON.parse(runGsdTools('state json', tmpDir).output).progress.percent), 75);
  });
  test('a free-text plain Progress: line above the status line cannot capture the rewrite, and an out-of-range percent clamps', () => {
    // The #2177 bold-first priority restated for the shared helper (an earlier
    // free-text line starting with `Progress:` must stay byte-identical while
    // the bold status line is rewritten — a leftmost-match alternation got
    // this wrong), and the clamp case: a hand-edited body percent (105%) with
    // an unmeasured scan (no plans on disk, so the curated block stands)
    // reaches the helper through applyPostSyncPreservation and must render the
    // clamped 100% bar instead of throwing RangeError on repeat(-1).
    const freeText = 'Progress: tracked in the weekly thread, do not edit this line by hand';
    seedState(50);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: "1.0"\nstatus: executing\nprogress:\n  total_phases: 4\n  completed_phases: 2\n  total_plans: 4\n  completed_plans: 2\n  percent: 50\n---\n\n# Project State\n\n${freeText}\n\n**Progress:** [█████░░░░░] 50%\n`);
    completePhasesOnDisk(3);
    assert.ok(runGsdTools(['state', 'record-session', '--stopped-at', '2.3'], tmpDir).success);
    let state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes(freeText), 'the free-text plain line must stay byte-identical');
    assert.match(stateDocument.stateExtractField(state, 'Progress'), /^\[████████░░\] 75%$/, 'the bold status line is the one rewritten (extractor returns its value)');
    assert.strictEqual(bodyProgressPercent(state), 75);
    assert.strictEqual(Number(JSON.parse(runGsdTools('state json', tmpDir).output).progress.percent), 75);

    seedState(50);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'),
      '---\ngsd_state_version: "1.0"\nstatus: executing\nprogress:\n  total_phases: 0\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 0\n  percent: 105\n---\n\n# Project State\n\nProgress: [██████████░] 105% (2/4 plans done)\n');
    for (let n = 1; n <= 4; n++) {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing fixture phase dirs beforeEach created; helpers.cleanup owns the tmp root itself
      fs.rmSync(path.join(tmpDir, '.planning', 'phases', String(n).padStart(2, '0')), { recursive: true, force: true });
    }
    assert.ok(runGsdTools(['state', 'add-decision', '--phase', '3', '--summary', 's'], tmpDir).success);
    state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(bodyProgressPercent(state), 100, 'bar renders the clamped 100%');
    assert.match(stateDocument.stateExtractField(state, 'Progress'), /\(2\/4 plans done\)/, 'suffix survives');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateResolveBlocker, cmdStateRecordSession
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateResolveBlocker (state resolve-blocker)', () => {
  let tmpDir;

  const blockerFixture = [
    '# Project State',
    '',
    '## Blockers',
    '',
    '- Waiting for API credentials',
    '- Need design review for dashboard',
    '- Pending vendor approval',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes matching blocker line (case-insensitive substring match)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "api credentials"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, true, 'resolved should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('Waiting for API credentials'), 'matched blocker should be removed');
    assert.ok(updated.includes('Need design review for dashboard'), 'other blocker should still be present');
    assert.ok(updated.includes('Pending vendor approval'), 'other blocker should still be present');
  });

  test('adds None placeholder when last blocker resolved', () => {
    const singleBlockerFixture = [
      '# Project State',
      '',
      '## Blockers',
      '',
      '- Single blocker',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), singleBlockerFixture);

    const result = runGsdTools('state resolve-blocker --text "single blocker"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('- Single blocker'), 'resolved blocker should be removed');

    // Section should contain "None" placeholder, not be empty
    const sectionMatch = sectionMatchOf(updated, 'Blockers');
    assert.ok(sectionMatch, 'Blockers section should still exist');
    assert.ok(sectionMatch[1].includes('None'), 'Blockers section should contain None placeholder');
  });

  test('returns error when text not provided', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.toLowerCase().includes('text'),
      'error should mention text required'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state resolve-blocker --text "anything"', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  // #3957 (epic #3473 B9, signature D): previously `resolved` was set
  // unconditionally as soon as the Blockers/Concerns heading was located —
  // before checking whether any bullet line actually matched `text` — so a
  // call naming a non-existent blocker reported `resolved: true` (a false
  // success). The section here IS found (blockerFixture has a populated
  // `## Blockers` section), so the real defect this test pins is the
  // "section found, no bullet matched" case — distinct from "no
  // Blockers/Concerns section at all", which carries a different reason.
  test('returns resolved false when no line matches', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "nonexistent blocker text"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, false, 'resolved must be false when no line matches — not a false success');
    assert.strictEqual(
      output.reason,
      'no blocker matching nonexistent blocker text found in the Blockers section',
    );
  });
});

describe('cmdStateRecordSession (state record-session)', () => {
  let tmpDir;

  const sessionFixture = [
    '# Project State',
    '',
    '## Session Continuity',
    '',
    '**Last session:** 2024-01-10',
    '**Stopped at:** Phase 2, Plan 1',
    '**Resume file:** None',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('updates session fields with stopped-at and resume-file', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const PINNED_MS = Date.parse('2020-07-20T10:00:00.000Z');
    const PINNED_ISO = '2020-07-20T10:00:00.000Z';
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file ".planning/phases/03/03-02-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(Array.isArray(output.updated), 'updated should be an array');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 3, Plan 2'), 'Stopped at should be updated');
    assert.ok(updated.includes('.planning/phases/03/03-02-PLAN.md'), 'Resume file should be updated');
    assert.ok(updated.includes(PINNED_ISO), `Last session should be the pinned ISO timestamp ${PINNED_ISO}`);
  });

  // #4186: `state record-session` with NO arguments used to execute and write
  // `Last session` / `last_updated` to STATE.md (this test previously pinned
  // that bare-invocation write). It now follows the house pattern every other
  // required-arg verb uses (`state update`: `error('field and value required
  // for state update')`) — a bare invocation is a usage error, not a
  // heartbeat write. Documented signature (docs/CLI-TOOLS.md):
  // `state record-session --stopped-at "..." [--resume-file path]`.
  test('#4186: no args errors instead of writing (STATE.md byte-unchanged)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state record-session', tmpDir);

    assert.ok(!result.success, 'bare record-session must exit non-zero');
    assert.match(
      result.error,
      /stopped-at or resume-file required for state record-session/,
      'stderr must name the required flags',
    );
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'STATE.md must be byte-unchanged by a rejected bare call');
  });

  // #4186: validation precedes the STATE.md existence check (same ordering as
  // cmdStateUpdate), and a lone --resume-file still carries an explicit value.
  test('#4186: --resume-file alone is a valid explicit value and persists', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const result = runGsdTools('state record-session --resume-file ".continue-here.md"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('.continue-here.md'), 'Resume file should be updated');
  });

  test('sets Resume file to None when not specified', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const result = runGsdTools('state record-session --stopped-at "Phase 1 complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 1 complete'), 'Stopped at should be updated');
    // Resume file should be set to None (default)
    const resumeMatch = updated.match(/\*\*Resume file:\*\*\s*(.*)/i);
    assert.ok(resumeMatch, 'Resume file field should exist');
    assert.ok(resumeMatch[1].trim() === 'None', 'Resume file should be None when not specified');
  });

  test('returns error when STATE.md missing', () => {
    // #4186: supply a value so this test keeps exercising the STATE.md-missing
    // decline rather than the (now earlier) no-args usage error.
    const result = runGsdTools('state record-session --stopped-at "somewhere"', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  // #4186: a STATE.md with no session labels is no longer reachable bare
  // (the no-args usage error fires first, before the existence check even) —
  // the bare-call contract this test used to pin (recorded:false decline) is
  // now the error contract pinned above; this variant proves the validation
  // fires regardless of the body's shape.
  test('#4186: no args errors even against a STATE.md with no session fields', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n**Phase:** 03\n'
    );

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(!result.success, 'bare record-session must exit non-zero');
    assert.match(result.error, /stopped-at or resume-file required for state record-session/);
  });

  // #3374 Variant B: stateReplaceField returns the replaced string on any label
  // MATCH, including when the value is already the target — so `updated` used
  // to report 'Stopped At' for a write that never changed a byte (and that the
  // #948 no-op guard then discarded entirely), leaving a stale frontmatter
  // stopped_at undetectable to the caller. The report must reflect real change,
  // and a matched-but-identical value must NOT arm the #944 DWIM insertion
  // branch (which wholesale-rewrites the session section and would reset an
  // executor-authored resume file to 'None').
  test('#3374: --stopped-at with the value already in the body is not reported updated and writes nothing', () => {
    const PINNED_MS = Date.parse('2020-09-01T09:00:00.000Z');
    const PINNED_ISO = '2020-09-01T09:00:00.000Z';
    const executorResume = '.planning/phases/02/02-01-PLAN.md';
    const fixture = [
      '# Project State',
      '',
      '## Session Continuity',
      '',
      `**Last session:** ${PINNED_ISO}`,
      '**Stopped at:** Phase 2, Plan 1',
      `**Resume file:** ${executorResume}`,
    ].join('\n') + '\n';
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, fixture);

    const result = runGsdTools('state record-session --stopped-at "Phase 2, Plan 1"', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !((output.updated || []).includes('Stopped At')),
      `updated must not report a Stopped At write that changed nothing; got ${JSON.stringify(output.updated)} (#3374 Variant B)`,
    );

    // The pinned clock makes the Last-session replacement an identity too, so
    // the whole transform is a no-op and the #948 no-op guard must skip the
    // write entirely — the file must be byte-identical.
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(
      after,
      fixture,
      'no field changed, so no write may occur (#3374 Variant B)',
    );
    assert.strictEqual(
      stateDocument.stateExtractField(after, 'Resume file'),
      executorResume,
      'an identical --stopped-at must not arm the #944 DWIM section rewrite (executor-authored resume file reset to None)',
    );
  });

  test('#3374: --stopped-at with a new value still reports Stopped At and syncs the frontmatter', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const newValue = 'Phase 3 complete, ready to plan Phase 4';

    const result = runGsdTools(['state', 'record-session', '--stopped-at', newValue], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      (output.updated || []).includes('Stopped At'),
      `a real change must keep reporting Stopped At; got ${JSON.stringify(output.updated)}`,
    );

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(
      stateDocument.stateExtractField(after, 'Stopped at'),
      newValue,
      'the body Stopped at line should carry the new value',
    );
    const fm = frontmatterLib.extractFrontmatter(after);
    assert.strictEqual(
      fm.stopped_at,
      newValue,
      `the RMW sync must reflect the new value in frontmatter; got ${JSON.stringify(fm.stopped_at)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4186 — the write path must not derive the frontmatter `status` token from
// SUBSTRINGS of the free-prose body Status field. Every STATE.md write funnels
// through readModifyWriteStateMd → syncStateFrontmatter →
// buildStateFrontmatter → normalizeStateStatus, so exercising `state update`
// here covers the shared seam for all write paths.
// ─────────────────────────────────────────────────────────────────────────────

describe('#4186: state update does not rewrite status from prose substrings', () => {
  let tmpDir;

  function writeStateMd(statusValue) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      "gsd_state_version: '1.0'",
      'status: unknown',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 2 (Fondamenta)',
      'Status: ' + statusValue,
      'Last activity: 2026-09-02 — aggiornato lo stato',
      '',
    ].join('\n') + '\n');
  }

  function frontmatterStatus() {
    const text = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = text.split('---')[1] || '';
    const m = fm.match(/^status:(.*)$/m);
    assert.ok(m, 'frontmatter must still carry a status key');
    return m[1].trim().replace(/^['"]|['"]$/g, '');
  }

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('row 33: Italian prose mentioning .planning/ keeps the visible prose token', () => {
    writeStateMd('Lavoro sospeso, vedi .planning/STATE.md');
    const r = runGsdTools(['state', 'update', 'Last activity', '2026-09-03 — verifica del defect'], tmpDir);
    assert.ok(r.success, `state update failed: ${r.error}`);
    assert.strictEqual(
      frontmatterStatus(),
      'Lavoro sospeso, vedi .planning/STATE.md',
      'prose containing a .planning/ path must pass through verbatim, not become `planning`',
    );
  });

  test('row 34: a recognized handler status still lands its canonical token', () => {
    writeStateMd('Executing Phase 5');
    const r = runGsdTools(['state', 'update', 'Last activity', '2026-09-03 — executing'], tmpDir);
    assert.ok(r.success, `state update failed: ${r.error}`);
    assert.strictEqual(frontmatterStatus(), 'executing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4186 — progress recount pin (#1988, PR #2016): a *-SUMMARY.md without a
// plan twin must not inflate progress.completed_plans on any recount trigger
// (the issue measured `34-TRIAGE-SUMMARY.md` → completed_plans 62 → 63 on
// GSD 1.5.0; the pairing fix landed after). These rows pin the correct
// behavior so it cannot regress, composed with the #4129/#4359 ratchet.
// ─────────────────────────────────────────────────────────────────────────────

describe('#4186: progress recount ignores stray summaries (pin of #1988)', () => {
  let tmpDir;

  function seedStrayFixture() {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '34-triage');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (const n of ['01', '02', '03']) fs.writeFileSync(path.join(phaseDir, `34-${n}-PLAN.md`), '# plan\n');
    // Two PAIRED summaries + one stray with no plan twin.
    fs.writeFileSync(path.join(phaseDir, '34-01-SUMMARY.md'), '# summary\n');
    fs.writeFileSync(path.join(phaseDir, '34-02-SUMMARY.md'), '# summary\n');
    fs.writeFileSync(path.join(phaseDir, '34-TRIAGE-SUMMARY.md'), '# stray\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      "gsd_state_version: '1.0'",
      'status: executing',
      'progress:',
      '  total_phases: 1',
      '  completed_phases: 0',
      '  total_plans: 3',
      '  completed_plans: 0',
      '  percent: 0',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 34 of 34 (Triage)',
      'Plan: 3 of 3 in current phase',
      'Status: Executing Phase 34',
      'Last activity: 2026-09-02 — executing',
      '',
      'Progress: [..........] 0%',
      'Total Plans in Phase: 3',
      '',
    ].join('\n') + '\n');
  }

  function completedPlans() {
    const text = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Bounded scan (#2128 class): the progress block sits within a few hundred
    // bytes of its opening key in every fixture this suite writes.
    const m = text.match(/^progress:[\s\S]{0,400}?completed_plans:\s*(\d+)/m);
    assert.ok(m, 'progress.completed_plans must be present after a recount write');
    return Number(m[1]);
  }

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('row 36: update on the Progress field recounts paired summaries only', () => {
    seedStrayFixture();
    const r = runGsdTools(['state', 'update', 'Progress', '[..........] 0%'], tmpDir);
    assert.ok(r.success, `state update failed: ${r.error}`);
    assert.strictEqual(completedPlans(), 2,
      'the stray 34-TRIAGE-SUMMARY.md (no plan twin) must not inflate completed_plans');
  });

  test('row 37: record-session (the issue trigger) recounts paired summaries only', () => {
    seedStrayFixture();
    const r = runGsdTools(['state', 'record-session', '--stopped-at', 'after plan 34-02'], tmpDir);
    assert.ok(r.success, `record-session failed: ${r.error}`);
    assert.strictEqual(completedPlans(), 2,
      'record-session must derive completed_plans from plan-paired summaries, not raw *-SUMMARY.md counts');
  });

  test('row 38: scanPhasePlans keeps listing the stray file but does not count it', () => {
    seedStrayFixture();
    const scanPhasePlans = require('../gsd-core/bin/lib/plan-scan.cjs');
    const scan = scanPhasePlans(path.join(tmpDir, '.planning', 'phases', '34-triage'));
    assert.strictEqual(scan.planCount, 3);
    assert.strictEqual(scan.summaryCount, 2, 'paired summaries only');
    assert.ok(scan.summaryFiles.includes('34-TRIAGE-SUMMARY.md'),
      'the stray file stays visible in summaryFiles for callers that list summaries');
  });

  test('row 39: ratchet still preserves an existing higher completed_plans (#4129/#4359 semantics)', () => {
    seedStrayFixture();
    // Poison the frontmatter with a value ABOVE the derived paired count (2).
    // `state update Progress` EXPLICITLY names a progress field, which by
    // design (#3242 / ADR-3473 §8.6 early-out) makes the fresh derivation
    // authoritative — so the ratchet row must use an INCIDENTAL resync write
    // (record-session) instead: the curated higher counter survives there.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, fs.readFileSync(statePath, 'utf-8').replace('completed_plans: 0', 'completed_plans: 9'));
    const r = runGsdTools(['state', 'record-session', '--stopped-at', 'after plan 34-02'], tmpDir);
    assert.ok(r.success, `record-session failed: ${r.error}`);
    assert.strictEqual(completedPlans(), 9,
      'the progress ratchet (monotonic completed counts on incidental resyncs) is unchanged by #4186');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-scoped phase counting in frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone-scoped phase counting in frontmatter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('total_phases counts only current milestone phases', () => {
    // ROADMAP lists only phases 5-6 (current milestone)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Next Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
      ].join('\n')
    );

    // Disk has dirs 01-06 (01-04 are leftover from previous milestone)
    for (let i = 1; i <= 6; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      // Add a plan to each
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
      // Disk-strict completion (ADR-3180 §7.4, #3186): a plan+summary count no
      // longer implies "complete" — only a passing *-VERIFICATION.md does. Both
      // milestone phases (5 and 6) get one so this test still exercises milestone
      // SCOPING, not the (now-separate) completion predicate.
      if (i === 5 || i === 6) writePassedVerification(tmpDir, `${padded}-phase-${i}`, padded);
    }

    // Write a STATE.md and trigger a write that will sync frontmatter
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 05\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the state json to check frontmatter
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 2, 'should count only milestone phases (5 and 6), not all 6');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'both milestone phases have a passing verification');
  });

  test('total_phases includes ROADMAP phases without directories', () => {
    // ROADMAP lists 6 phases (5-10), but only 4 have directories on disk
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v3.0',
        '',
        '### Phase 5: Auth',
        '### Phase 6: Dashboard',
        '### Phase 7: API',
        '### Phase 8: Notifications',
        '### Phase 9: Analytics',
        '### Phase 10: Polish',
      ].join('\n')
    );

    // Only phases 5-8 have directories (9 and 10 not yet planned)
    for (let i = 5; i <= 8; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
      // Disk-strict completion (ADR-3180 §7.4, #3186): give each of the 4
      // phases-with-directories a passing verification so this test still
      // exercises ROADMAP-vs-disk SCOPING, not the completion predicate.
      writePassedVerification(tmpDir, `${padded}-phase-${i}`, padded);
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 08\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 6, 'should count all 6 ROADMAP phases, not just 4 with directories');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'only 4 phases have a passing verification');
  });

  test('without ROADMAP counts all phases (pass-all filter)', () => {
    // No ROADMAP.md — all phases should be counted
    for (let i = 1; i <= 4; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    const result = runGsdTools('state update Status "In progress"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 4, 'without ROADMAP should count all 4 phases');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// begin-phase — field preservation (#1365)
// ─────────────────────────────────────────────────────────────────────────────

describe('state begin-phase preserves Current Position fields (#1365)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('begin-phase preserves Status, Last activity, and Progress in Current Position', () => {
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );

    // Extract the Current Position section
    const posMatch = sectionMatchOf(content, 'Current Position');
    assert.ok(posMatch, 'Current Position section should exist');
    const posSection = posMatch[1];

    // Phase and Plan lines should be updated
    assert.ok(/^Phase:.*EXECUTING/m.test(posSection), 'Phase line should say EXECUTING');
    assert.ok(/^Plan:.*1 of 4/m.test(posSection), 'Plan line should show 1 of 4');

    // Status, Last activity, and Progress must still be present (the bug destroys these)
    assert.ok(/^Status:/m.test(posSection),
      'Status field must be preserved in Current Position');
    assert.ok(/^Last activity:/m.test(posSection),
      'Last activity field must be preserved in Current Position');
    assert.ok(/^Progress:/m.test(posSection),
      'Progress field must be preserved in Current Position');
  });

  test('#2245 F2: begin-phase does not clobber an H3 subsection nested under Current Position', () => {
    // A prior revision swapped `locateCurrentPosition` (stops at ANY heading
    // level >= 2) for `collectSection` with its default `levelBounded: true`
    // (stops only at H1/H2), so a `### Notes` subsection under
    // `## Current Position` was folded into the section body and the
    // field-write regexes (which use the `m` flag and match ANY line start)
    // clobbered a same-named line inside that subsection.
    const stateMd = `# Project State

## Current Position

Phase: 1 (Setup) — EXECUTING
Status: Executing Phase 1

### Notes

Plan: DO-NOT-TOUCH

## Next Steps

Do the thing.
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'Foo', '--plans', '3'],
      tmpDir,
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      content.includes('Plan: DO-NOT-TOUCH'),
      `the ### Notes subsection must not be rewritten by the Current Position field regexes:\n${content}`,
    );
    assert.ok(/^## Next Steps/m.test(content), 'the ## Next Steps section must remain untouched');
    assert.ok(/^Phase:.*EXECUTING/m.test(content), 'Phase line in Current Position should still update');
  });

  test('advance-plan can update Status after begin-phase', () => {
    // Simulates the full workflow: begin-phase then advance through all plans
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    // Step 1: begin-phase
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '2'],
      tmpDir
    );
    assert.ok(beginResult.success, `begin-phase failed: ${beginResult.error}`);

    // Step 2: advance-plan to go from plan 1 to plan 2
    const adv1 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv1.success, `advance-plan 1 failed: ${adv1.error}`);

    // Step 3: advance-plan again — plan 2 of 2 is the last, should set "Phase complete"
    const adv2 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv2.success, `advance-plan 2 failed: ${adv2.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );
    const posMatch = sectionMatchOf(content, 'Current Position');
    assert.ok(posMatch, 'Current Position section should exist after advance-plan');
    const posSection = posMatch[1];

    // After advancing past all plans, Status should say "Phase complete"
    assert.ok(/Status:.*Phase complete/i.test(posSection),
      'Status should be updated to "Phase complete" after last advance-plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1589 — progress counters not updated during plan execution
// ─────────────────────────────────────────────────────────────────────────────

describe('progress counters correct after plan execution (#1589)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version token)
    // is COMPLETE scope for windowing (§7.1) — without this, an absent
    // ROADMAP.md is UNREADABLE and the disk-derived percent this describe
    // exercises is withheld.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('percent in frontmatter is derived from disk counts, not stale Progress body field', () => {
    // STATE.md body still says 0% (update-progress was never called or was skipped),
    // but all 4 plans across 2 phases have SUMMARY.md files on disk.
    // After any STATE.md write, the frontmatter percent must reflect disk reality.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });

    // Phase 01: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-SUMMARY.md'), '# Summary\n');

    // Phase 02: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');

    // Disk-strict completion (ADR-3180 §7.4, #3186): a passing *-VERIFICATION.md
    // is what makes a phase complete now, not plan/summary parity — this test is
    // about percent DERIVATION, so give both phases one.
    writePassedVerification(tmpDir, '01-foundation', '01');
    writePassedVerification(tmpDir, '02-api', '02');

    // Body Progress: still says 0% (stale — never updated by update-progress)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 02\n**Status:** Phase complete — ready for verification\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Trigger a STATE.md write (e.g. state update Status)
    const result = runGsdTools('state update Status "All phases complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the frontmatter — percent must be derived from disk (4/4 = 100%), not from body "0%"
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 4, 'total_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 4, 'completed_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.total_phases), 2, 'total_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'completed_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (derived from disk counts, not stale body 0%)');
  });

  test('percent is 0 when no summaries exist even if Progress body says 100%', () => {
    // Inverse: body says 100% but disk has no summaries.
    // Frontmatter percent must come from disk, not body.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    // No summary files

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** In progress\n**Progress:** [██████████] 100%\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 1, 'total_plans must be 1 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 0, 'completed_plans must be 0 (no summaries)');
    assert.strictEqual(Number(output.progress.percent), 0, 'percent must be 0 (derived from disk, not stale body 100%)');
  });

  test('state json rebuilds stale frontmatter progress from disk after all plans complete', () => {
    // Reproduces the exact scenario from #1589:
    // Frontmatter was written early with stale counters.
    // All summaries now exist on disk.
    // state json must return fresh disk-derived progress.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-phase');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-phase');
    const phase03Dir = path.join(tmpDir, '.planning', 'phases', '03-phase');
    const phase04Dir = path.join(tmpDir, '.planning', 'phases', '04-phase');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.mkdirSync(phase03Dir, { recursive: true });
    fs.mkdirSync(phase04Dir, { recursive: true });

    // 4 phases, 6 total plans (as in the bug report)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-SUMMARY.md'), '# Summary\n');

    // Disk-strict completion (ADR-3180 §7.4, #3186): give all 4 phases a
    // passing verification so this test still exercises the STALE-FRONTMATTER
    // rebuild, not the (now-separate) completion predicate.
    writePassedVerification(tmpDir, '01-phase', '01');
    writePassedVerification(tmpDir, '02-phase', '02');
    writePassedVerification(tmpDir, '03-phase', '03');
    writePassedVerification(tmpDir, '04-phase', '04');

    // Write STATE.md with stale frontmatter matching the bug report exactly
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: '1.0'\nstatus: executing\nprogress:\n  total_phases: 4\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 4\n  percent: 0\n---\n\n# Project State\n\n**Current Phase:** 04\n**Status:** Ready to execute\n**Progress:** [░░░░░░░░░░] 0%\n`
    );

    // state json must return fresh progress derived from disk (all 6 plans complete across 4 phases)
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 6, 'total_plans must be 6 (not stale 0)');
    assert.strictEqual(Number(output.progress.completed_plans), 6, 'completed_plans must be 6 (not stale 4)');
    assert.strictEqual(Number(output.progress.total_phases), 4, 'total_phases must be 4');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'completed_phases must be 4 (not stale 0)');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (not stale 0)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePerformanceMetricsSection (Step 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('updatePerformanceMetricsSection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty Performance Metrics section rebuilds with zeros', () => {
    const content = `# Project State

**Status:** Executing Phase 3

## Performance Metrics

**Velocity:**
- Total plans completed: [N]
- Average duration: [X] min
- Total execution time: [X.X] hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

## Accumulated Context
`;

    // We test via the CLI: phase complete triggers updatePerformanceMetricsSection
    // But first let's test the helper directly via state planned-phase + phase complete flow
    // For a unit-style test, write STATE.md and call state validate to check metrics
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create a phase with 2 plans, 2 summaries
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-SUMMARY.md'), '# Summary 2\n');
    writePassedVerification(tmpDir, '03-api', '03');

    // Also need ROADMAP.md for phase complete
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 3: API\n\n- [ ] Phase 3: API Layer\n`
    );

    const result = runGsdTools('phase complete 3', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.includes('Total plans completed:'), 'Velocity section should have total plans');
    assert.ok(stateAfter.match(/Total plans completed:\s*2/), 'Total plans should be 2');
    assert.ok(stateAfter.includes('| 3'), 'By Phase table should have row for phase 3');
  });

  test('existing Plan Execution Times rows aggregated into Velocity/By Phase', () => {
    const content = `# Project State

**Current Phase:** 04
**Status:** Executing Phase 4

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 3 P1 | 12 min | 5 tasks | 3 files |
| Phase 3 P2 | 8 min | 3 tasks | 2 files |

**Velocity:**
- Total plans completed: 2
- Average duration: 10 min
- Total execution time: 0.3 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 3 | 2 | 20 min | 10 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create phase 4 with 1 plan, 1 summary
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '04-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '04-01-SUMMARY.md'), '# Summary 1\n');
    writePassedVerification(tmpDir, '04-ui', '04');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 4: UI\n\n- [ ] Phase 4: UI Layer\n`
    );

    const result = runGsdTools('phase complete 4', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.match(/Total plans completed:\s*3/), 'Total plans should be 3 (2 previous + 1 new)');
    assert.ok(stateAfter.includes('| 4'), 'By Phase table should have row for phase 4');
  });

  test('idempotent — running twice produces same result', () => {
    const content = `# Project State

**Current Phase:** 05
**Status:** Executing Phase 5

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '05-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '05-final', '05');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 5: Final\n\n- [ ] Phase 5: Final\n`
    );

    runGsdTools('phase complete 5', tmpDir);
    const afterFirst = fs.readFileSync(statePath, 'utf-8');

    // Reset state so we can complete again
    let resetContent = afterFirst.replace(/All phases complete|Ready to plan/, 'Executing Phase 5');
    resetContent = resetContent.replace(/Not started/, '1');
    fs.writeFileSync(statePath, resetContent);

    // Re-create plan files (they still exist)
    runGsdTools('phase complete 5', tmpDir);
    const afterSecond = fs.readFileSync(statePath, 'utf-8');

    // #1582: the velocity total must be IDEMPOTENT across re-runs of the same phase.
    // The old blind-add (prevTotal + summaryCount) double-counted on every re-run
    // (1 -> 2 here); the fix derives the total from the By-Phase Plans column, so
    // re-running the same phase upserts the same row and the sum stays stable.
    const firstCount = afterFirst.match(/Total plans completed:\s*(\d+)/);
    const secondCount = afterSecond.match(/Total plans completed:\s*(\d+)/);
    assert.ok(firstCount, 'First run should have total plans');
    assert.ok(secondCount, 'Second run should have total plans');
    assert.equal(
      firstCount[1],
      secondCount[1],
      `velocity total must be idempotent across re-runs of phase 5 (#1582): first=${firstCount[1]} second=${secondCount[1]}`,
    );
    assert.equal(firstCount[1], '1', 'phase 5 has 1 plan, so the velocity total must be 1');
    // The By Phase row for phase 5 should be updated, not duplicated.
    const phase5Rows = (afterSecond.match(/\|\s*5\s*\|/g) || []).length;
    assert.ok(phase5Rows <= 1, 'Phase 5 should appear at most once in By Phase table (no duplicates)');
  });

  test('#1582 — velocity self-heals a hand-inflated total down to the true By-Phase sum', () => {
    // A hand-edited STATE.md whose velocity line says 99 but whose By-Phase table
    // records the true completed plans. Completing a fresh phase must RECOMPUTE the
    // total from the table (derive, not accumulate), correcting the inflated value
    // downward rather than adding to it.
    const content = `# Project State

**Current Phase:** 02
**Status:** Executing Phase 2

## Performance Metrics

**Velocity:**
- Total plans completed: 99
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 2 | 10 min | 5 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-next');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '02-next', '02');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 2: Next\n\n- [ ] Phase 2: Next\n`
    );

    const result = runGsdTools('phase complete 2', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    // True sum = phase 1 (2) + phase 2 (1) = 3. Old blind-add would yield 99 + 1 = 100.
    assert.ok(
      stateAfter.match(/Total plans completed:\s*3\b/),
      'velocity total must self-heal to the true By-Phase sum (3), not accumulate from the inflated 99 (#1582)',
    );
  });

  test('#1582 — velocity sums indented By-Phase data rows too (codex review: byPhaseTablePattern allows [ \\t]* leading whitespace, so the sum must match it)', () => {
    // byPhaseTablePattern's data-row capture is `(?:[ \\t]*\\|...)*` — it ALLOWS leading
    // whitespace. The derive sum must tolerate the same, or a hand-edited/legacy indented
    // row is captured by the table but silently skipped by the sum (undercount).
    const content = `# Project State

**Current Phase:** 02
**Status:** Executing Phase 2

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
  | 1 | 2 | - | - |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-next');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '02-next', '02');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 2: Next\n\n- [ ] Phase 2: Next\n`
    );

    const result = runGsdTools('phase complete 2', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    // Indented phase-1 row (2) + new column-0 phase-2 row (1) = 3. A sum regex anchored
    // at ^\\| would skip the indented row and report 1.
    assert.ok(
      stateAfter.match(/Total plans completed:\s*3\b/),
      'velocity must sum indented By-Phase rows too (codex review, #1582): expected 3 (2 + 1)',
    );
  });

  test('byPhaseTablePattern behavior-lock (#320): By Phase table header preserved and phase row upserted after hoist to module scope', () => {
    // Exercises the byPhaseTablePattern match path directly: header must be preserved,
    // an existing phase row must be replaced (not duplicated), and a new phase row inserted.
    const content = `# Project State

**Current Phase:** 06
**Status:** Executing Phase 6

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 6 | 1 | 5 min | 5 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-lock');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '06-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '06-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-SUMMARY.md'), '# Summary 2\n');
    writePassedVerification(tmpDir, '06-lock', '06');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 6: Lock\n\n- [ ] Phase 6: Lock\n`
    );

    const result = runGsdTools('phase complete 6', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');

    // Header must be preserved
    assert.ok(stateAfter.includes('| Phase | Plans | Total | Avg/Plan |'), 'By Phase table header must be preserved');

    // Phase 6 row must appear exactly once (upserted, not duplicated)
    const phase6Rows = (stateAfter.match(/\|\s*6\s*\|/g) || []).length;
    assert.strictEqual(phase6Rows, 1, 'Phase 6 row must appear exactly once in By Phase table (upsert, not append)');

    // Total plans count = sum of the By-Phase Plans column after the upsert. Phase 6's
    // row is upserted to its current summaryCount (2), and it is the only row, so the
    // derived total is 2. (#1582: derived from the table, not blind-added onto the prior
    // velocity — which previously produced 1+2=3 by double-counting phase 6.)
    assert.ok(stateAfter.match(/Total plans completed:\s*2\b/), 'Total plans completed should equal the By-Phase Plans sum (2) after upsert (#1582)');
  });

  test('#1658 — By-Phase table row upserts on a CRLF STATE.md (byPhaseTablePattern must be CRLF-tolerant)', () => {
    const content = [
      '# Project State', '',
      '**Current Phase:** 07', '**Status:** Executing Phase 7', '',
      '## Performance Metrics', '',
      '**Velocity:**',
      '- Total plans completed: [N]',
      '- Average duration: N/A',
      '- Total execution time: 0 hours', '',
      '**By Phase:**', '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| - | - | - | - |', '',
      '## Accumulated Context', '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Force CRLF line endings across the whole STATE.md (Windows / hand-edited).
    fs.writeFileSync(statePath, content.replace(/\r?\n/g, '\r\n'), 'utf8');

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '07-crlf');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '07-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '07-01-SUMMARY.md'), '# Summary\n');
    // #1548 (#1522) enforces canonical verification before phase transition, so phase
    // complete fail-closes without a passed VERIFICATION.md. Add one so the test exercises
    // the By-Phase row upsert path (the actual #1658 concern) rather than the gate.
    writePassedVerification(tmpDir, '07-crlf', '07');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 7: CRLF\n\n- [ ] Phase 7\n');

    const result = runGsdTools('phase complete 7', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf8');
    // #1658: byPhaseTablePattern is CRLF-tolerant. #1668 (By-Phase row not persisted on a
    // CRLF STATE.md even though the pattern matches CRLF) was resolved by #1655's
    // restructure of updatePerformanceMetricsSection (table upsert now runs before the
    // velocity manipulation). Assert the full contract: row present, placeholder removed,
    // velocity derived — all on a CRLF STATE.md.
    assert.ok(
      /\|\s*7\s*\|\s*1\s*\|/.test(after),
      'By-Phase row for phase 7 must be upserted even on a CRLF STATE.md (#1658/#1668)',
    );
    assert.ok(
      !/\|\s*-\s*\|\s*-\s*\|\s*-\s*\|\s*-\s*\|/.test(after),
      'placeholder row must be removed on CRLF STATE.md once a real row is upserted',
    );
    assert.ok(
      /Total plans completed:\s*1\b/.test(after),
      'velocity total must derive from the CRLF By-Phase table (1 plan)',
    );
  });

  test('#1659 — completing an unpadded phase number upserts an existing zero-padded By-Phase row (no duplicate)', () => {
    const content = [
      '# Project State', '',
      '**Current Phase:** 05', '**Status:** Executing Phase 5', '',
      '## Performance Metrics', '',
      '**Velocity:**', '- Total plans completed: 1', '- Average duration: N/A', '- Total execution time: 0 hours', '',
      '**By Phase:**', '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| 05 | 1 | - | - |',   // seeded ZERO-PADDED row
      '',
      '## Accumulated Context', '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content, 'utf8');

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '05-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '05-final', '05');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 5: Final\n\n- [ ] Phase 5\n');

    // phase complete with the UNPADDED number "5" — must upsert the seeded "| 05 |" row,
    // not append a duplicate "| 5 |".
    const result = runGsdTools('phase complete 5', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf8');
    const rows05 = (after.match(/^\|\s*05\s*\|/gm) || []).length;
    const rows5 = (after.match(/^\|\s*5\s*\|/gm) || []).length;
    assert.equal(rows05 + rows5, 1, `phase 5 must appear exactly once in By Phase (got |05|=${rows05} |5|=${rows5}) — padded/unpadded must dedup (#1659)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state planned-phase (Step 3 — Gate 3a)
// ─────────────────────────────────────────────────────────────────────────────

describe('state planned-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('after call: Status is "Ready to execute"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning Phase 3\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 3\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '3', '--name', 'API', '--plans', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.includes('Ready to execute'), 'Status should be "Ready to execute"');
  });

  test('after call: Total Plans matches argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 2\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '7'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.match(/Total Plans in Phase.*7/), 'Total Plans should be 7');
  });

  test('after call: Last Activity is the pinned date (deterministic via GSD_NOW_MS)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 1\n`
    );

    const PINNED_MS = Date.parse('2020-09-10T15:00:00.000Z');
    const PINNED_DATE = '2020-09-10';
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '1', '--name', 'Setup', '--plans', '3'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      stateContent.includes(PINNED_DATE),
      `Last Activity should contain the pinned date ${PINNED_DATE}`,
    );
  });

  test('missing STATE.md returns graceful error', () => {
    // No STATE.md written
    const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Test', '--plans', '3'], tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3052: state planned-phase must not overwrite authoritative same-date
// last_activity_desc from stale body prose
// ─────────────────────────────────────────────────────────────────────────────

describe('#3052: planned-phase preserves same-date last_activity_desc', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('same-date conflicting desc: frontmatter desc is preserved', () => {
    // Frontmatter has authoritative desc; body has stale desc for the SAME date
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'last_activity: 2020-09-10',
        'last_activity_desc: authoritative description',
        '---',
        '',
        '# Project State',
        '',
        '**Status:** Planning',
        '**Last Activity:** 2020-09-10 — stale description',
        '**Current Phase:** 1',
        '',
      ].join('\n'),
    );

    // GSD_TEST_MODE is required alongside GSD_NOW_MS or the pin is silently dropped
    // (src/clock.cts `_pinnedNowMs`). Measured: this test's `last_activity` is derived
    // from the BODY's `**Last Activity:**` line, so the same-date branch it exercises is
    // reached either way — only `last_updated` was being stamped from the live wall
    // clock. Pinning it is hygiene rather than a live-defect fix: a declared pin that
    // silently does nothing is still wrong, and leaving it here teaches the pattern that
    // put a wall-clock timestamp into the #3395 block below.
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '1', '--plans', '3'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(Date.parse('2020-09-10T15:00:00.000Z')) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Extract only the frontmatter (between --- fences) to check the desc
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
    const fmMatch = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const frontmatter = fmMatch ? fmMatch[1] : '';
    assert.ok(
      frontmatter.includes('authoritative description'),
      'frontmatter last_activity_desc must be preserved when same-date body prose conflicts',
    );
    assert.ok(
      !frontmatter.includes('stale description'),
      'stale body desc must NOT appear in frontmatter (it may remain in body prose)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3395: state planned-phase must refresh the Current Position `Phase:` line
// (the body source the frontmatter resync and `state json` re-derive
// current_phase from) instead of leaving a stale one behind, and must persist
// its --name argument instead of silently dropping it.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3395: planned-phase refreshes the stale Phase line and persists --name', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // GSD_TEST_MODE is load-bearing here, not decoration. `_pinnedNowMs()` (src/clock.cts)
  // opens with `if (!process.env.GSD_TEST_MODE) return null;`, so GSD_NOW_MS ALONE is
  // silently discarded and every `last_updated` below is stamped from the live wall clock
  // instead. That is what put a real timestamp into a document this block asserts over,
  // and an instant ending `...:35.149Z` contains the substring `35.1` — reddening
  // `full test (windows-latest, 24, shard 2/3)` about 1 run in 600 (second == 35 AND
  // millisecond in 100..199). The pin is what makes that window unreachable; scoping the
  // assertion to `## Current Position` below is what makes it HARMLESS even when a pinned
  // value does collide. Both are needed: either alone leaves the defect latent.
  const PINNED_INSTANT = '2026-08-14T15:00:00.000Z';
  const PINNED_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(Date.parse(PINNED_INSTANT)) };

  // An instant chosen to sit INSIDE that collision window on purpose, so the regression
  // below reproduces the CI failure deterministically instead of 1-in-600.
  const COLLIDING_INSTANT = '2026-08-14T15:00:35.149Z';
  const COLLIDING_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(Date.parse(COLLIDING_INSTANT)) };

  function frontmatterBlock(stateContent) {
    const m = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : '';
  }

  // `## Current Position` is the body prose #3395 is about — the source `state json`
  // re-derives current_phase from. Frontmatter is NOT phase prose: `last_updated`,
  // `last_activity` and friends legitimately carry digit runs that can spell a phase id,
  // so scanning the WHOLE document for a stale id reports staleness that does not exist.
  // indexOf rather than a regex: nothing for local/no-unbounded-quantifier to flag, and
  // `\n## ` still matches under CRLF because the `\r` precedes the newline.
  function currentPositionBlock(stateContent) {
    const start = stateContent.indexOf('## Current Position');
    if (start === -1) return '';
    const rest = stateContent.slice(start);
    const nextHeading = rest.indexOf('\n## ', 1);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  }

  // One builder for every synthetic STATE.md below — the frontmatter + heading shape was
  // being rebuilt independently in three tests. `eol` is a parameter because the CRLF
  // behavior of currentPositionBlock is a claim under test, not an assumption.
  function stateDoc({ iso = PINNED_INSTANT, lines = [], eol = '\n' }) {
    return ['---', `last_updated: "${iso}"`, '---', '', '## Current Position', '', ...lines, ''].join(eol);
  }

  // The issue's repro shape: frontmatter already carries the correct decimal
  // sub-phase, but the body's `## Current Position` still describes the
  // PREVIOUS phase's completion prose.
  function writeStalePhaseLineFixture() {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "current_phase: '35.3'",
        'current_phase_name: unattended-launch-prerequisites',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 35.1 (unattended-launch-prerequisites) — COMPLETE (4/4 plans)',
        'Status: Planning',
        'Total Plans in Phase: 4',
        'Last Activity: 2026-08-01',
        '',
      ].join('\n'),
    );
  }

  test('issue repro: stale body Phase line is refreshed and current_phase stays coherent end to end', () => {
    writeStalePhaseLineFixture();
    const result = runGsdTools(['state', 'planned-phase', '--phase', '35.3', '--plans', '3'], tmpDir, PINNED_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterBlock(stateContent);
    // AC #1 outcome: the correct frontmatter value survives the write.
    assert.ok(/current_phase:[^\n]*35\.3/.test(fm),
      `frontmatter current_phase must stay 35.3; frontmatter was:\n${fm}`);
    // The stale body source must not survive the transition that just
    // declared 35.3 planned — it is the source every body-derived consumer
    // (state json included) re-reads.
    assert.ok(!currentPositionBlock(stateContent).includes('35.1'),
      `the stale 35.1 phase prose must be refreshed away from ## Current Position; STATE.md was:\n${stateContent}`);
    assert.ok(/Phase: 35\.3 — READY TO EXECUTE/m.test(stateContent),
      `Current Position Phase line must read "Phase: 35.3 — READY TO EXECUTE"; STATE.md was:\n${stateContent}`);
    // The read path must agree with the write path.
    const json = JSON.parse(runGsdTools(['state', 'json', '--raw'], tmpDir, PINNED_ENV).output);
    assert.strictEqual(json.current_phase, '35.3',
      `state json must report the refreshed phase, got: ${json.current_phase}`);
  });

  test('regression: PINNED_ENV actually pins the clock — GSD_NOW_MS needs GSD_TEST_MODE', () => {
    writeStalePhaseLineFixture();
    const result = runGsdTools(['state', 'planned-phase', '--phase', '35.3', '--plans', '3'], tmpDir, PINNED_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(fm.includes(PINNED_INSTANT),
      `last_updated must be the pinned instant ${PINNED_INSTANT} — GSD_NOW_MS is only honored when GSD_TEST_MODE is set too (src/clock.cts _pinnedNowMs); frontmatter was:\n${fm}`);
  });

  test('regression: a last_updated containing the phase-number substring does not trip the stale-prose check', () => {
    writeStalePhaseLineFixture();
    const result = runGsdTools(['state', 'planned-phase', '--phase', '35.3', '--plans', '3'], tmpDir, COLLIDING_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Precondition: we really are at the colliding instant. Fails loudly if the pin ever
    // stops working again, rather than degrading this back into a 1-in-600 coin flip.
    assert.ok(stateContent.includes(COLLIDING_INSTANT),
      `precondition: the clock must be pinned to ${COLLIDING_INSTANT}; STATE.md was:\n${stateContent}`);
    // Precondition: the OLD whole-file scan genuinely does match here. This is the exact
    // CI failure, reproduced deterministically.
    assert.ok(stateContent.includes('35.1'),
      `precondition: the whole-document scan must see 35.1 at this instant; STATE.md was:\n${stateContent}`);
    // The property actually under test.
    assert.ok(!currentPositionBlock(stateContent).includes('35.1'),
      `a timestamp containing 35.1 must not be read as stale phase prose; STATE.md was:\n${stateContent}`);
  });

  test('control: the narrowed scan still catches genuinely stale phase prose in the body', () => {
    // Both line endings, and both WITH a following `## ` heading — that combination is the
    // one the helper's CRLF claim actually rests on (`\n## ` matches inside `\r\n## `
    // because the `\r` precedes the newline). Testing CRLF only on a single-heading
    // document would leave exactly that claim unexercised.
    for (const eol of ['\n', '\r\n']) {
      const stale = stateDoc({
        lines: [
          'Phase: 35.1 (unattended-launch-prerequisites) — COMPLETE (4/4 plans)',
          '',
          '## Next',
          '',
          'unrelated 35.1 mention outside the block',
        ],
        eol,
      });
      // Narrowing must not defang the check the fix exists to keep.
      assert.ok(currentPositionBlock(stale).includes('35.1'),
        `genuinely stale phase prose inside ## Current Position must still be reported (eol=${JSON.stringify(eol)})`);
      // The slice stops at the next heading, so the trailing mention is out of scope.
      assert.ok(!currentPositionBlock(stale).includes('unrelated'),
        `the block must end at the next ## heading (eol=${JSON.stringify(eol)})`);
    }
    // Missing-input class: no heading at all yields an empty block, never a throw.
    assert.strictEqual(currentPositionBlock('# Project State\n\nno position heading\n'), '');
  });

  test('boundary: the 35.1 collision window is exactly milliseconds 100-199 at second 35', () => {
    // limit-1 / limit / limit+1 on BOTH axes of the collision. The scoped reader must be
    // blind to every one of them; the whole-document reader must match exactly the window.
    const cases = [
      { iso: '2026-08-14T15:00:35.099Z', collides: false, why: 'limit-1 (ms 099)' },
      { iso: '2026-08-14T15:00:35.100Z', collides: true, why: 'limit (ms 100)' },
      { iso: '2026-08-14T15:00:35.199Z', collides: true, why: 'limit (ms 199)' },
      { iso: '2026-08-14T15:00:35.200Z', collides: false, why: 'limit+1 (ms 200)' },
      { iso: '2026-08-14T15:00:34.149Z', collides: false, why: 'limit-1 (second 34)' },
      { iso: '2026-08-14T15:00:36.149Z', collides: false, why: 'limit+1 (second 36)' },
    ];
    for (const { iso, collides, why } of cases) {
      for (const eol of ['\n', '\r\n']) {
        const doc = stateDoc({ iso, lines: ['Phase: 35.3 — READY TO EXECUTE'], eol });
        assert.strictEqual(doc.includes('35.1'), collides,
          `whole-document scan for ${iso} (${why}, eol=${JSON.stringify(eol)})`);
        assert.ok(!currentPositionBlock(doc).includes('35.1'),
          `scoped scan must never match a timestamp: ${iso} (${why}, eol=${JSON.stringify(eol)})`);
      }
    }
  });

  test('property: no last_updated value can trip the scoped check, and real stale prose always does', () => {
    // Two arms against the SAME generated inputs. Arm 1 alone would be satisfied by a
    // helper that always returns ''; arm 2 is what makes that impossible.
    fc.assert(fc.property(
      // noInvalidDate is load-bearing: without it fc.date() emits an Invalid Date about
      // 1 sample in 300 and `.toISOString()` throws RangeError. Verified on fast-check
      // 4.8.0 — 0 invalid in 300 samples with the flag, 1 without.
      fc.date({
        min: new Date('2000-01-01T00:00:00.000Z'),
        max: new Date('2099-12-31T23:59:59.999Z'),
        noInvalidDate: true,
      }),
      fc.integer({ min: 1, max: 99 }),
      fc.integer({ min: 1, max: 9 }),
      (when, major, minor) => {
        const iso = when.toISOString();
        const clean = stateDoc({ iso, lines: [`Phase: ${major}.${minor} — READY TO EXECUTE`] });
        // Deterministic guard: the frontmatter instant is NEVER inside the block. If the
        // helper ever widened back to the whole document this fails on every run, not
        // only on the runs where the generated timestamp happens to spell a phase id.
        assert.ok(!currentPositionBlock(clean).includes(iso));
        // Arm 1: a clean block never reports the STALE id, whatever the timestamp is.
        const staleId = `${major}.${minor}9`;
        assert.ok(!currentPositionBlock(clean).includes(staleId));
        // Arm 2: inject genuinely stale prose and it is always reported.
        const dirty = stateDoc({ iso, lines: [`Phase: ${staleId} (x) — COMPLETE`] });
        assert.ok(currentPositionBlock(dirty).includes(staleId));
        return true;
      },
    ), { numRuns: 200 });
  });

  test('--name is persisted into the Phase line and frontmatter, not silently dropped', () => {
    writeStalePhaseLineFixture();
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '36', '--name', 'Core Foundation', '--plans', '5'],
      tmpDir,
      PINNED_ENV,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/Phase: 36 \(Core Foundation\) — READY TO EXECUTE/m.test(stateContent),
      `Current Position Phase line must carry the passed name; STATE.md was:\n${stateContent}`);
    const fm = frontmatterBlock(stateContent);
    // AC #2: the body phase source genuinely changed this transition, so
    // current_phase re-derives from the refreshed line.
    assert.ok(/current_phase:[^\n]*36/.test(fm),
      `current_phase must follow the genuinely changed body phase source (36); frontmatter was:\n${fm}`);
    assert.ok(/current_phase_name:[^\n]*Core Foundation/.test(fm),
      `current_phase_name must persist the passed name; frontmatter was:\n${fm}`);
  });

  test('--name containing a parenthetical survives intact in frontmatter (#2736 mirror)', () => {
    writeStalePhaseLineFixture();
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '36', '--name', 'auth (oauth) refresh', '--plans', '5'],
      tmpDir,
      PINNED_ENV,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(/current_phase_name:[^\n]*auth \(oauth\) refresh/.test(fm),
      `current_phase_name must carry the exact authoritative name (prose re-derivation is lossy for nested parens); frontmatter was:\n${fm}`);
  });

  test('canonical labeled fixture without frontmatter current_phase: Phase line still refreshed', () => {
    // No YAML frontmatter disagreement here — pins that the Phase-line refresh
    // also applies to the plain template shape (fields only, Current Position
    // `Phase: 1 of 5 (setup)` template form).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 0',
        '**Status:** Planning',
        '**Last Activity:** 2026-03-20',
        '',
        '## Current Position',
        'Phase: 1 of 5 (setup)',
        'Plan: 0 of 5 in current phase',
        'Status: Planning',
        'Last activity: 2026-03-20 -- Phase 1 complete',
        '',
      ].join('\n'),
    );
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir,
      PINNED_ENV,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/Phase: 2 \(Core\) — READY TO EXECUTE/m.test(stateContent),
      `Current Position Phase line must be refreshed from the template form; STATE.md was:\n${stateContent}`);
  });

  test('no Current Position section: command still succeeds and body Current Phase field is untouched', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Planning',
        '**Total Plans in Phase:** 0',
        '**Last Activity:** 2024-01-01',
        '**Current Phase:** 3',
        '',
      ].join('\n'),
    );
    const result = runGsdTools(['state', 'planned-phase', '--phase', '3', '--plans', '5'], tmpDir, PINNED_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/\*\*Current Phase:\*\* 3/.test(stateContent),
      `body **Current Phase:** field must be untouched when no Current Position section exists; STATE.md was:\n${stateContent}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #1070 regression: "Complete ✓" terminal status must yield to planned-phase
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1070: "Complete ✓" terminal status yields to Ready to execute on planned-phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Full STATE.md shape that matches the canonical fixture used across state tests.
  // Both **Status:** frontmatter and Current Position `Status:` are set to the given value.
  function makeStateMd(statusValue) {
    return `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** ${statusValue}
**Last Activity:** 2026-03-20
**Last Activity Description:** Phase 1 complete

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of 5 in current phase
Status: ${statusValue}
Last activity: 2026-03-20 -- Phase 1 complete
Progress: [##########] 20%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
  }

  // Case 1: the bug — Complete ✓ blocks the state machine
  test('case 1: Complete ✓ in both frontmatter and Current Position is overwritten by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Complete ✓')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);

    // The updated array must include Status (both paths ran the replacement)
    assert.ok(
      Array.isArray(output.updated) && output.updated.includes('Status'),
      `Expected output.updated to include "Status", got: ${JSON.stringify(output.updated)}`
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The checkmark form must be gone
    assert.ok(
      !stateContent.includes('Complete ✓'),
      'STATE.md must not contain "Complete ✓" after planned-phase'
    );

    // Frontmatter **Status:** line must now be "Ready to execute"
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Ready to execute',
      `Frontmatter **Status:** should be "Ready to execute", got: "${fmStatusMatch[1].trim()}"`
    );

    // Current Position Status: line must also be "Ready to execute"
    const posMatch = sectionMatchOf(stateContent, 'Current Position');
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Ready to execute',
      `Current Position Status should be "Ready to execute", got: "${posStatusMatch[1].trim()}"`
    );
  });

  // Case 2: a genuinely executor-authored non-terminal status must NOT be overwritten
  // (frontmatter **Status:** path via stateReplaceFieldIfTemplate)
  test('case 2: executor-authored non-terminal status is preserved by planned-phase (#397 narrowness check)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The executor-authored Status must survive in the frontmatter
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Blocked on infra review',
      `Frontmatter **Status:** should be preserved as "Blocked on infra review", got: "${fmStatusMatch[1].trim()}"`
    );
  });

  // Case 3: executor-authored non-terminal status in the Current Position section
  // must NOT be overwritten (exercises updateCurrentPositionFields in src/state.cts,
  // a separate code path from the frontmatter matcher).
  test('case 3: executor-authored non-terminal status in Current Position is preserved by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Locate the Current Position section and verify the Status line there.
    const posMatch = sectionMatchOf(stateContent, 'Current Position');
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Blocked on infra review',
      `Current Position Status should be preserved as "Blocked on infra review", got: "${posStatusMatch[1].trim()}"`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state validate (Step 4 — Gate 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('state validate command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('template frontmatter phase reaches passed-verification drift on disk', () => {
    const stateContent = readShippedStateTemplateBody([
      ['status: planning', ['current_phase: 2', 'status: executing'].join('\n')],
      ['Phase: [X] of [Y] ([Phase name])', 'Phase: 2 of 2 (State Validation Drift Diagnostics)'],
      ['Status: [Ready to plan / Planning / Ready to execute / In progress / Phase complete]', 'Status: Executing Phase 2'],
    ]);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-state-validation-drift-diagnostics');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePassedVerification(tmpDir, '02-state-validation-drift-diagnostics', '02');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'passed verification must invalidate executing state');
    assert.ok(output.warnings.length > 0, 'passed verification drift must emit a warning');
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'S006 must fire for passed verification against executing status');
    assert.strictEqual(s006.severity, SEVERITY.WARNING);
    assertNoDriftKey(output);
  });

  test('template-equivalent phase identities remain clean without disk drift', () => {
    const stateContent = readShippedStateTemplateBody([
      ['status: planning', ['current_phase: 2', 'status: planning'].join('\n')],
      ['Phase: [X] of [Y] ([Phase name])', 'Phase: 02 of 2 (State Validation Drift Diagnostics)'],
      ['Status: [Ready to plan / Planning / Ready to execute / In progress / Phase complete]', 'Status: Planning'],
    ]);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);
    fs.mkdirSync(
      path.join(tmpDir, '.planning', 'phases', '02-state-validation-drift-diagnostics'),
      { recursive: true },
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, 'equivalent phase identities without disk drift must stay valid');
    assert.deepStrictEqual(output.warnings, [], 'clean control must not emit warnings');
    assertNoDriftKey(output);
  });

  test('legacy Current Phase fallback reaches passed-verification drift on disk', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Current Phase:** 2',
        '**Status:** Executing Phase 2',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-legacy'), { recursive: true });
    writePassedVerification(tmpDir, '02-legacy', '02');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'legacy phase fallback must expose verification drift');
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'S006 must fire for legacy Current Phase fallback');
    assertNoDriftKey(output);
  });

  test('Current Position Phase fallback reaches passed-verification drift on disk', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 2 of 2 (State Validation Drift Diagnostics)',
        'Status: Executing Phase 2',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-canonical'), { recursive: true });
    writePassedVerification(tmpDir, '02-canonical', '02');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'canonical phase fallback must expose verification drift');
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'S006 must fire for Current Position Phase fallback');
    assertNoDriftKey(output);
  });

  test('frontmatter phase wins conflicts and scans its selected directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase: 2',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 1 of 2 (Foundation)',
        'Status: Executing Phase 2',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-state-validation'), { recursive: true });
    writePassedVerification(tmpDir, '02-state-validation', '02');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'conflicting sources must invalidate the result');
    const s003 = findWarning(output, 'S003');
    assert.ok(s003, 'S003 must fire for conflicting phase sources');
    // S003 names only the selected (authoritative) phase, not the individual
    // disagreeing sources; the old `drift.phase_reference.sources` structured
    // detail has no S0NN equivalent (disclosed breaking change, §8.4 rule 3).
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'disk evidence must come from the authoritative frontmatter phase');
    assertNoDriftKey(output);
  });

  test('missing phase sources fail closed with phase-reference drift', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['# Project State', '', 'Status: Planning', ''].join('\n'),
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'missing phase source must not validate cleanly');
    const s002 = findWarning(output, 'S002');
    assert.ok(s002, 'S002 must fire when no phase source resolves');
    assertNoDriftKey(output);
  });

  test('non-scalar frontmatter phase fails closed without a body fallback', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase:',
        '  nested: 2',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'non-scalar phase source must not validate cleanly');
    const s002 = findWarning(output, 'S002');
    assert.ok(s002, 'S002 must fire when the frontmatter phase source is non-scalar');
    assertNoDriftKey(output);
  });

  test('missing phases root fails closed with phase-directory drift', () => {
    cleanup(tmpDir);
    tmpDir = createFixture({ planning: false, projectDoc: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'current_phase: 2', 'status: planning', '---', '', '# Project State', ''].join('\n'),
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'missing phases root must not validate cleanly');
    const s004 = findWarning(output, 'S004');
    assert.ok(s004, 'S004 must fire when the phases directory is missing');
    assertNoDriftKey(output);
  });

  test('missing canonical phase-directory match fails closed', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'current_phase: 2', 'status: planning', '---', '', '# Project State', ''].join('\n'),
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'missing phase-directory match must not validate cleanly');
    const s004 = findWarning(output, 'S004');
    assert.ok(s004, 'S004 must fire when no phase directory matches');
    assertNoDriftKey(output);
  });

  test('crafted path-like phase cannot scan verification evidence outside phases root', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase: ../outside',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
      ].join('\n'),
    );
    const outsideDir = path.join(tmpDir, '.planning', 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, '02-VERIFICATION.md'),
      ['---', 'status: passed', '---', '', '# Outside verification', ''].join('\n'),
    );

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'crafted phase reference must fail closed');
    const s002 = findWarning(output, 'S002');
    assert.ok(s002, 'S002 must fire when the crafted phase value fails to resolve');
    assert.ok(!findWarning(output, 'S006'), 'outside-root verification evidence must not be scanned');
    assertNoDriftKey(output);
  });

  test('STATE says executing + VERIFICATION.md shows passed emits warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 2\n**Current Phase:** 2\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings when executing but verification passed');
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'S006 must fire when executing but verification passed');
    assertNoDriftKey(output);
  });

  test('STATE plan count 3 but 12 SUMMARY.md on disk emits mismatch warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 3\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Write 12 plans and summaries
    for (let i = 1; i <= 12; i++) {
      const padded = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-PLAN.md`), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-SUMMARY.md`), '# Summary\n');
    }

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings for plan count mismatch');
    const s005 = findWarning(output, 'S005');
    assert.ok(s005, 'S005 must fire for a plan count mismatch');
    // The specific counts are the thing under test (STATE.md-authored count
    // vs disk-scanned count); `.includes()` on the interpolated values, not
    // full-string message equality (CONTRIBUTING.md's "Prohibited: Raw Text
    // Matching on Test Outputs").
    assert.ok(s005.message.includes('STATE.md says 3 plans'), 'message must report the STATE.md count');
    assert.ok(s005.message.includes('disk has 12'), 'message must report the disk-scanned count');
    assertNoDriftKey(output);
  });

  test('perfect state returns valid: true, no warnings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, 'Should be valid');
    assert.strictEqual(output.warnings.length, 0, 'Should have no warnings');
  });

  test('archived "Current Phase:" line does not trigger false-positive conflict when frontmatter is correct', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ncurrent_phase: 2\n---\n# Project State\n\n## Current Position\n**Phase:** 2\n\n## Archive\n**Current Phase:** 1 (completed last week)\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, 'Should be valid, legacy extractor should not read the archive');
    assert.strictEqual(output.warnings.length, 0, 'Should have no phase_reference conflict warnings');
  });

  test('missing STATE.md returns graceful error', () => {
    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12 (#3310, ADR-3180 §8.4 rule 3) — S0NN coded-diagnostic fixtures for
// `cmdStateValidate`. `warnings` is now `Diagnostic[]` (not bare strings) and
// `drift` is gone from every output shape. One test per code, title naming
// the code (test-matrix §4 / §8.5's "known-bad fixture proves it can fire"
// discipline extended to the S0NN codes, which are NOT `Rule`-table entries —
// `cmdStateValidate` builds `Diagnostic[]` directly, per the design doc).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3310 state validate — S0NN coded diagnostics', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('S001: STATE.md corrupt (NUL byte) fires with the verbatim textEncodingError message', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), Buffer.from('# Project State\0corrupt'));

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    assert.strictEqual(output.warnings.length, 1);
    const [s001] = output.warnings;
    assert.strictEqual(s001.code, 'S001');
    assert.strictEqual(s001.severity, SEVERITY.ERROR);
    assert.strictEqual(s001.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('S002: no usable current-phase value fires the verbatim pre-migration message', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['# Project State', '', '**Status:** Planning', ''].join('\n'),
    );

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s002 = findWarning(output, 'S002');
    assert.ok(s002);
    assert.strictEqual(s002.severity, SEVERITY.WARNING);
    assert.strictEqual(s002.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('S003: conflicting phase-reference sources fires the verbatim template with interpolated phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase: 2',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 1',
        '**Status:** Executing Phase 2',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-core'), { recursive: true });

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s003 = findWarning(output, 'S003');
    assert.ok(s003);
    assert.strictEqual(s003.severity, SEVERITY.WARNING);
    assert.strictEqual(s003.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('S004: phases directory question collapses three sub-conditions to one code with distinct messages', () => {
    // (a) phases/ root missing entirely.
    cleanup(tmpDir);
    tmpDir = createFixture({ planning: false, projectDoc: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'current_phase: 2', 'status: planning', '---', '', '# Project State', ''].join('\n'),
    );
    const missingRootOutput = JSON.parse(runGsdTools('state validate', tmpDir).output);
    const missingRootS004 = findWarning(missingRootOutput, 'S004');
    assert.ok(missingRootS004, 'S004 must fire when phases/ root is missing');
    assert.strictEqual(missingRootS004.severity, SEVERITY.WARNING);
    assert.strictEqual(missingRootS004.remedy.action, 'advise');
    assertNoDriftKey(missingRootOutput);

    // (b) phases/ exists, no matching subdir for the current phase.
    cleanup(tmpDir);
    tmpDir = createFixture();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'current_phase: 2', 'status: planning', '---', '', '# Project State', ''].join('\n'),
    );
    const notFoundOutput = JSON.parse(runGsdTools('state validate', tmpDir).output);
    const notFoundS004 = findWarning(notFoundOutput, 'S004');
    assert.ok(notFoundS004, 'S004 must fire when no phase directory matches');
    assertNoDriftKey(notFoundOutput);

    // Same code, distinct message text per sub-condition — §8.2 rule 1. This
    // is a relative comparison (message A !== message B), not a literal
    // string match, so it stays within CONTRIBUTING.md's rule.
    assert.strictEqual(missingRootS004.code, notFoundS004.code);
    assert.notStrictEqual(missingRootS004.message, notFoundS004.message);
  });

  test('S005: plan-count mismatch fires the verbatim template with both counts interpolated', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 3\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s005 = findWarning(output, 'S005');
    assert.ok(s005);
    assert.strictEqual(s005.severity, SEVERITY.WARNING);
    assert.strictEqual(s005.remedy.action, 'advise');
    // The interpolated counts are what this test is proving; `.includes()`
    // on the specific values, not full-string message equality
    // (CONTRIBUTING.md's "Prohibited: Raw Text Matching on Test Outputs").
    assert.ok(s005.message.includes('STATE.md says 3 plans'), 'message must report the STATE.md count');
    assert.ok(s005.message.includes('disk has 2'), 'message must report the disk-scanned count');
    assertNoDriftKey(output);
  });

  test('S006: verification passed but status still executing fires the verbatim template', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s006 = findWarning(output, 'S006');
    assert.ok(s006);
    assert.strictEqual(s006.severity, SEVERITY.WARNING);
    assert.strictEqual(s006.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('S007: all plans have summaries but status still executing fires the verbatim template (never a drift entry pre-migration either)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary\n');
    // No VERIFICATION.md — otherwise S006 would cover it instead (see the
    // production code's own "Only warn if no verification exists" guard).

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s007 = findWarning(output, 'S007');
    assert.ok(s007);
    assert.strictEqual(s007.severity, SEVERITY.WARNING);
    assert.strictEqual(s007.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('#3511: S006 does not fire from a cross-phase stray VERIFICATION file; this phase\'s own file still fires it', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    // No summary — isolates this test from the S007 "all plans summarized" path.
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
    // Cross-phase stray sitting in phase 01's directory — token "02", not "01".
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s006Warnings = (output.warnings || []).filter((w) => w.code === 'S006');
    assert.strictEqual(s006Warnings.length, 1,
      `exactly one S006 must fire (this phase's own file only); got: ${JSON.stringify(s006Warnings)}`);
    assert.ok(s006Warnings[0].message.includes('01-VERIFICATION.md'),
      `S006 must name this phase's own file; got: ${s006Warnings[0].message}`);
    assert.ok(!s006Warnings[0].message.includes('02-VERIFICATION.md'),
      `S006 must not name the cross-phase stray; got: ${s006Warnings[0].message}`);
    assertNoDriftKey(output);
  });

  test('#3511: S007 fires when the only VERIFICATION.md present is a cross-phase stray (unscoped counting would have wrongly suppressed it)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary\n');
    // No own VERIFICATION.md — only a cross-phase stray (token "02"). Scoped
    // counting must treat this phase as having NO verification file, so S007
    // ("all plans summarized but still executing") must still fire.
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s007 = findWarning(output, 'S007');
    assert.ok(s007,
      'S007 must fire: the only VERIFICATION.md present belongs to a different phase, so this phase has none of its own');
    assert.ok(!findWarning(output, 'S006'), 'the cross-phase stray must not fire S006 either');
    assertNoDriftKey(output);
  });

  test('#3511 follow-up: S006 still fires from a NON-canonical dir shape "1-unpadded" (over-exclusion check)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\n**Current Plan:** 1\n`,
    );
    // "1-unpadded" tokenizes to literal "1"; scaffold writes the PADDED
    // "01-VERIFICATION.md" form. A literal token compare excluded it.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '1-unpadded');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, `S006 must still fire for the phase's own file in a non-canonical dir; got: ${JSON.stringify(output.warnings)}`);
    assert.ok(s006.message.includes('01-VERIFICATION.md'));
    assertNoDriftKey(output);
  });

  test('#3511 Fix 2: S006 fires from a bare "VERIFICATION.md" (no dash, no token of its own)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\n**Current Plan:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    // Bare form (no dash) — core-utils.cts, init.cts and verification.cts all
    // treat this as a valid report; a literal `<token>-` prefix check can
    // never match it, silently losing S006 drift detection.
    fs.writeFileSync(path.join(phaseDir, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, `S006 must fire for a bare VERIFICATION.md; got: ${JSON.stringify(output.warnings)}`);
    assert.ok(s006.message.includes('VERIFICATION.md'));
    assertNoDriftKey(output);
  });

  test('#3511 WARNING-4: an underscore-separated "03_VERIFICATION.md" (broader .includes(\'VERIFICATION\') grammar) still fires S006 in its own phase dir', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 3\n**Current Phase:** 3\n**Total Plans in Phase:** 1\n**Current Plan:** 1\n`,
    );
    // state.cts's own pre-filter (`.includes('VERIFICATION')`, no dash) is
    // deliberately broader than the `-VERIFICATION.md` grammar every other
    // #3511 site uses, so this underscore-separated name passes it.
    // `scopeToPhase`/`isPhaseArtifact` (`phase-id.cts`) accept `_` alongside
    // `-` and `.` as a candidate-boundary separator specifically so this
    // broader pre-filter's own-phase matches aren't dropped after the fact —
    // "03_VERIFICATION.md" in phase 03's directory IS this phase's own file,
    // and the aggregate scan must not report it as absent. S006 fires here.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '03_VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, `S006 must fire for "03_VERIFICATION.md" in its own phase dir; got: ${JSON.stringify(output.warnings)}`);
    const s007 = findWarning(output, 'S007');
    assert.ok(!s007, `S007 must not fire once S006 covers the passed own-phase verification; got: ${JSON.stringify(output.warnings)}`);
  });

  test('output never carries a drift key, across clean/warning/error shapes (breaking-change proof, test matrix row 18)', () => {
    // Clean shape.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    const clean = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.ok(!('drift' in clean));
    assert.ok(!Object.keys(clean).includes('drift'));

    // Warning shape (S005).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 5\n`,
    );
    const warned = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.ok(!('drift' in warned));
    assert.ok(!Object.keys(warned).includes('drift'));

    // Error shape (S001, corrupt STATE.md).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), Buffer.from('# Project State\0bad'));
    const corrupt = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.ok(!('drift' in corrupt));
    assert.ok(!Object.keys(corrupt).includes('drift'));

    // `{error: 'STATE.md not found'}` pre-check shape.
    cleanup(tmpDir);
    tmpDir = createFixture();
    const missing = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.ok(!('drift' in missing));
    assert.ok(!Object.keys(missing).includes('drift'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3696 — the `last_activity` invariant is CHECKABLE, and `--strict` makes it
// gateable.
//
// Before this, a STATE.md whose `Last activity:` value no reader can parse
// validated as `{valid:true, warnings:[], scope:"complete"}` — the scan ran
// fully and had nothing to say, because `cmdStateValidate` never read the field
// at all. And `valid:false` still exited 0, so no CI step or git hook could gate
// on state correctness without parsing JSON.
//
// S008 = the value is present but does not name a real calendar date.
// S009 = the description was truncated by a line wrap.
//
// Calendar validity (not merely `\d{4}-\d{2}-\d{2}` shape) is the invariant on
// purpose: `smart-entry`'s reader already rejects `2026-02-30` via
// `isRealCalendarDate` (ADR-227 — validate shape AND value). Accepting it here
// would leave the two surfaces disagreeing about whether the file is usable,
// which is the defect #3696 opens with, not a fix for it.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3696 state validate — last_activity invariant (S008/S009) and --strict', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // A document that validates CLEAN: phase resolves, phase dir exists, plan
  // count agrees, no verification file. Extra body lines are appended verbatim
  // so each case differs ONLY in the last_activity shape under test.
  function writeCleanState(extraBodyLines = [], opts = {}) {
    const eol = opts.crlf ? '\r\n' : '\n';
    const head = opts.frontmatter ? ['---', ...opts.frontmatter, '---', ''] : [];
    const lines = [
      '# Project State',
      '',
      '**Status:** Executing Phase 1',
      '**Current Phase:** 1',
      '**Total Plans in Phase:** 1',
      ...extraBodyLines,
      '',
    ];
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [...head, ...lines].join(eol));
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
  }

  function validate(args = 'state validate') {
    const result = runGsdTools(args, tmpDir);
    return { result, output: JSON.parse(result.output) };
  }

  // ── S008: the value must name a real calendar date ──────────────────────────

  test('S008: an unparseable last_activity is reported instead of validating clean', () => {
    writeCleanState(['Last activity: not-a-date — broke the date on purpose']);

    const { output } = validate();
    assert.strictEqual(output.scope, 'complete', 'the scan must have actually run — this is not a degraded-scope excuse');
    assert.strictEqual(output.valid, false, 'an unreadable last_activity must not validate clean');
    const s008 = findWarning(output, 'S008');
    assert.ok(s008, `S008 must fire for an unparseable last_activity; got: ${JSON.stringify(output.warnings)}`);
    assert.strictEqual(s008.severity, SEVERITY.WARNING);
    assert.strictEqual(s008.remedy.action, 'advise');
    assert.match(s008.message, /last activity/i);
    assertNoDriftKey(output);
  });

  test('S008: a well-formed last_activity with a description stays clean', () => {
    writeCleanState(['Last activity: 2026-08-19 — did a thing']);

    const { output } = validate();
    assert.strictEqual(output.valid, true, `well-formed control must stay clean; got: ${JSON.stringify(output.warnings)}`);
    assert.deepStrictEqual(output.warnings, []);
  });

  test('S008: a bare well-formed date with no description stays clean', () => {
    // parseProseLastActivityField returns description:null for this shape; it is
    // a legitimate value, not a truncation.
    writeCleanState(['Last activity: 2026-08-19']);

    const { output } = validate();
    assert.ok(!findWarning(output, 'S008'), `a bare date is a valid shape; got: ${JSON.stringify(output.warnings)}`);
    assert.ok(!findWarning(output, 'S009'), 'a bare date is not a truncated description');
  });

  test('S008: an absent last_activity is not a defect (a fresh project must stay clean)', () => {
    // The single most important negative case: a freshly-initialized STATE.md
    // has no activity yet. Flagging absence would fire on every new project.
    writeCleanState([]);

    const { output } = validate();
    assert.strictEqual(output.valid, true, `absence is not drift; got: ${JSON.stringify(output.warnings)}`);
    assert.ok(!findWarning(output, 'S008'));
  });

  test('S008: a frontmatter-only last_activity is validated through the same owner', () => {
    // Routes the read through stateFieldValue's frontmatter rung — the same owner
    // cmdStateValidate already uses for status/total_plans_in_phase, so the
    // fm-only shape is not a blind spot (ADR-3180 §7.7).
    writeCleanState([], { frontmatter: ['current_phase: 1', 'status: executing', 'last_activity: not-a-date'] });

    const { output } = validate();
    const s008 = findWarning(output, 'S008');
    assert.ok(s008, `S008 must fire for a frontmatter-only last_activity; got: ${JSON.stringify(output.warnings)}`);
  });

  test('S008: an ASCII-hyphen separator is accepted like an em dash', () => {
    writeCleanState(['Last activity: 2026-08-19 - did a thing']);

    const { output } = validate();
    assert.ok(!findWarning(output, 'S008'), `the owner regex accepts an ASCII hyphen; got: ${JSON.stringify(output.warnings)}`);
  });

  test('S008: a shape-valid but calendar-impossible date is rejected (the two surfaces must not disagree)', () => {
    // 2026-02-30 matches \d{4}-\d{2}-\d{2} but does not exist. smart-entry's
    // isRealCalendarDate already rejects it (ADR-227). If state validate accepted
    // it, the two readers would still disagree about whether the file is usable —
    // the exact complaint #3696 opens with.
    writeCleanState(['Last activity: 2026-02-30 — a day that does not exist']);

    const { output } = validate();
    const s008 = findWarning(output, 'S008');
    assert.ok(s008, `S008 must fire for an impossible calendar date; got: ${JSON.stringify(output.warnings)}`);
  });

  test('S008: month and day boundaries fire on limit-1 and limit+1 only', () => {
    const cases = [
      ['2026-00-15', true],   // month limit-1
      ['2026-01-15', false],  // month limit (low)
      ['2026-12-15', false],  // month limit (high)
      ['2026-13-15', true],   // month limit+1
      ['2026-01-00', true],   // day limit-1
      ['2026-01-01', false],  // day limit (low)
      ['2026-01-31', false],  // day limit (high, 31-day month)
      ['2026-01-32', true],   // day limit+1
    ];
    for (const [value, mustFire] of cases) {
      writeCleanState([`Last activity: ${value} — boundary probe`]);
      const { output } = validate();
      const fired = Boolean(findWarning(output, 'S008'));
      assert.strictEqual(fired, mustFire, `${value}: expected S008 fired=${mustFire}, got ${fired} (${JSON.stringify(output.warnings)})`);
    }
  });

  test('isRealCalendarDate: state validate and smart-entry agree on calendar validity', () => {
    // Parity assertion (CLAUDE.md "Generative Fix Divergence"): the predicate has
    // ONE owner and both surfaces import it. This fails the moment a second copy
    // appears and drifts.
    const smartEntry = require('../gsd-core/bin/lib/smart-entry.cjs');
    assert.strictEqual(
      typeof stateDocument.isRealCalendarDate,
      'function',
      'state-document.cjs must own isRealCalendarDate',
    );
    for (const [y, m, d, expected] of [
      [2026, 2, 30, false],
      [2026, 2, 28, true],
      [2024, 2, 29, true],
      [2026, 2, 29, false],
      [2026, 13, 1, false],
      [2026, 12, 31, true],
    ]) {
      assert.strictEqual(
        stateDocument.isRealCalendarDate(y, m, d),
        expected,
        `owner disagrees on ${y}-${m}-${d}`,
      );
    }
    assert.ok(
      !Object.prototype.hasOwnProperty.call(smartEntry, 'isRealCalendarDate')
        || smartEntry.isRealCalendarDate === stateDocument.isRealCalendarDate,
      'smart-entry must reuse the owner, never re-declare its own copy',
    );
  });

  test('property: no real calendar date ever raises S008', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2099, 11, 31)) }),
        (d) => {
          const iso = d.toISOString().slice(0, 10);
          // Suffix VARIES: a dashed description, a bare date, and a
          // separator-less description. A fixed `— probe` suffix is what
          // let the round-2 false positive through this property.
          const suffix = ['', ' — property probe', ' property probe'][d.getUTCDate() % 3];
          writeCleanState([`Last activity: ${iso}${suffix}`]);
          const { output } = validate();
          assert.ok(
            !findWarning(output, 'S008'),
            `S008 must never fire for the real calendar date ${iso}${suffix}; got: ${JSON.stringify(output.warnings)}`,
          );
        },
      ),
      { numRuns: 12 },
    );
  });

  // ── S009: a wrapped description must not vanish ─────────────────────────────

  test('S009: a wrapped last_activity description is reported instead of silently truncated', () => {
    writeCleanState([
      'Last activity: 2026-08-19 — Project initialized from ingest (SPEC-pal-restore.md); PROJECT.md,',
      'REQUIREMENTS.md, ROADMAP.md written',
    ]);

    const { output } = validate();
    assert.strictEqual(output.valid, false, 'a truncated description must not validate clean');
    const s009 = findWarning(output, 'S009');
    assert.ok(s009, `S009 must fire for a wrapped description; got: ${JSON.stringify(output.warnings)}`);
    assert.strictEqual(s009.severity, SEVERITY.WARNING);
    assert.strictEqual(s009.remedy.action, 'advise');
    assertNoDriftKey(output);
  });

  test('S009: a blank line after last_activity is structure, not a wrap', () => {
    writeCleanState(['Last activity: 2026-08-19 — done', '', 'Some later prose.']);

    const { output } = validate();
    assert.ok(!findWarning(output, 'S009'), `a blank line ends the field; got: ${JSON.stringify(output.warnings)}`);
  });

  test('S009: a following field line is structure, not a wrap', () => {
    writeCleanState(['Last activity: 2026-08-19 — done', 'Blockers: none']);
    assert.ok(!findWarning(validate().output, 'S009'), 'a sibling field is not a continuation');

    writeCleanState(['Last activity: 2026-08-19 — done', '**Blockers:** none']);
    assert.ok(!findWarning(validate().output, 'S009'), 'a bold sibling field is not a continuation');
  });

  test('S009: a following heading is structure, not a wrap', () => {
    writeCleanState(['Last activity: 2026-08-19 — done', '## Next Up']);

    assert.ok(!findWarning(validate().output, 'S009'));
  });

  test('S009: a following list marker is structure, not a wrap', () => {
    for (const marker of ['- item', '* item', '+ item', '1. item', '2) item']) {
      writeCleanState(['Last activity: 2026-08-19 — done', marker]);
      const { output } = validate();
      assert.ok(!findWarning(output, 'S009'), `"${marker}" is a list, not a continuation; got: ${JSON.stringify(output.warnings)}`);
    }
  });

  test('S009: a following table row or horizontal rule is structure, not a wrap', () => {
    // The `---` case is the horizontal-rule trap: a check that fires on
    // legitimate Markdown structure is worse than no check at all.
    for (const line of ['| Field | Value |', '---', '***', '___', '> quoted', '```']) {
      writeCleanState(['Last activity: 2026-08-19 — done', line]);
      const { output } = validate();
      assert.ok(!findWarning(output, 'S009'), `"${line}" is structure, not a continuation; got: ${JSON.stringify(output.warnings)}`);
    }
  });

  test('S009: last_activity as the final line with no trailing newline does not fire', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 1\nLast activity: 2026-08-19 — done',
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const { output } = validate();
    assert.ok(!findWarning(output, 'S009'), `end-of-file is not a continuation; got: ${JSON.stringify(output.warnings)}`);
  });

  test('S009: CRLF line endings produce the same verdict as LF', () => {
    writeCleanState([
      'Last activity: 2026-08-19 — Project initialized from ingest; PROJECT.md,',
      'REQUIREMENTS.md written',
    ], { crlf: true });
    assert.ok(findWarning(validate().output, 'S009'), 'a CRLF wrap must fire exactly like LF');

    writeCleanState(['Last activity: 2026-08-19 — done', 'Blockers: none'], { crlf: true });
    assert.ok(!findWarning(validate().output, 'S009'), 'a CRLF sibling field must not fire');
  });


  // ── Review round 2 — cross-surface agreement and structure false positives ──

  test('S008: a value the real reader parses is not reported unreadable (no separator before the description)', () => {
    // The first cut asserted through parseProseLastActivityField, whose grammar
    // is fully anchored and REQUIRES a dash separator. smart-entry's
    // parseActivityTimestamp needs only a leading date, so this value parses
    // fine there while S008 called it unreadable — the same
    // two-surfaces-disagree defect #3696 exists to close, pointing the other
    // way. Asserted against the real reader, not against a restatement of it.
    const smartEntry = require('../gsd-core/bin/lib/smart-entry.cjs');
    const value = '2026-08-24 Shipped feature X without a dash separator';

    if (typeof smartEntry.parseActivityTimestamp === 'function') {
      assert.ok(
        Number.isFinite(smartEntry.parseActivityTimestamp(value)),
        'precondition: the real reader must parse this value',
      );
    }

    writeCleanState([`Last activity: ${value}`]);
    const { output } = validate();
    assert.ok(
      !findWarning(output, 'S008'),
      `S008 must not fire on a value the reader parses; got: ${JSON.stringify(output.warnings)}`,
    );
  });

  test('S008: an ISO date-time prefix is accepted', () => {
    writeCleanState(['Last activity: 2026-08-24T09:00:00Z shipped it']);

    assert.ok(!findWarning(validate().output, 'S008'));
  });

  test('S008: a date-shaped run with no separators is still rejected', () => {
    // Boundary on the leading-token rule itself: `20260824` is eight digits, not
    // a date, and must not be admitted just because it starts with four.
    writeCleanState(['Last activity: 20260824 shipped it']);

    assert.ok(findWarning(validate().output, 'S008'), '`20260824` is not a leading ISO date token');
  });

  test('S009: a setext heading underneath last_activity is structure, not a wrap', () => {
    // Both underline styles. `===` was missed entirely by the first cut, and
    // `---` was missed differently: the rule stopped AT the underline, having
    // already swallowed the heading TITLE above it as prose. Detection has to
    // look ahead one line, so both are pinned here.
    for (const underline of ['===', '---', '======', '- - -'.replace(/ /g, '')]) {
      writeCleanState(['Last activity: 2026-08-19 — done', 'My Heading', underline]);
      const { output } = validate();
      assert.ok(
        !findWarning(output, 'S009'),
        `a setext heading underlined with "${underline}" is structure; got: ${JSON.stringify(output.warnings)}`,
      );
    }
  });

  test('S009: an indented code block is structure, not a wrap', () => {
    for (const indented of ['    const x = 1;', '\tconst x = 1;']) {
      writeCleanState(['Last activity: 2026-08-19 — done', indented]);
      const { output } = validate();
      assert.ok(
        !findWarning(output, 'S009'),
        `an indented code block is structure; got: ${JSON.stringify(output.warnings)}`,
      );
    }
  });

  test('S009: an HTML block is structure, not a wrap', () => {
    writeCleanState(['Last activity: 2026-08-19 — done', '<div>a note</div>']);

    assert.ok(!findWarning(validate().output, 'S009'));
  });


  test('S009: a frontmatter-sourced last_activity is not judged by a stale wrapped body line', () => {
    // The ladder prefers the frontmatter scalar, so when frontmatter supplies
    // last_activity NOBODY reads the body line. Scanning it anyway reported a
    // dropped remainder that no reader consumes — and under --strict exited 1 —
    // on a document whose actual last_activity is entirely valid.
    writeCleanState(
      [
        'Last activity: 2026-01-01 — a stale body line that',
        'wraps onto a second line',
      ],
      { frontmatter: ['current_phase: 1', 'status: executing', 'last_activity: 2026-08-19'] },
    );

    const { result, output } = validate('state validate --strict');
    assert.ok(
      !findWarning(output, 'S009'),
      `the body line is shadowed by frontmatter and must not be judged; got: ${JSON.stringify(output.warnings)}`,
    );
    assert.strictEqual(output.valid, true);
    assert.strictEqual(result.exitCode, 0, '--strict must not fail a document whose last_activity is valid');
  });

  test('S008: a frontmatter-sourced last_activity is still judged on its own value', () => {
    // The complement of the test above: shadowing must suppress the BODY scan,
    // never the check itself.
    writeCleanState(
      ['Last activity: 2026-08-19 — a clean body line'],
      { frontmatter: ['current_phase: 1', 'status: executing', 'last_activity: not-a-date'] },
    );

    assert.ok(
      findWarning(validate().output, 'S008'),
      'the frontmatter value is the one every reader uses, so it is the one that must be checked',
    );
  });

  test('S008: a last_activity line with only whitespace reads as not-yet-filled-in, not as drift', () => {
    // stateExtractField's `[ \t]*(.+)` backtracks to hand back a single space,
    // so the value arrives as '' — non-null, and it used to reach S008 and
    // report the empty string back at the reader.
    writeCleanState(['Last activity:   ']);

    const { output } = validate();
    assert.ok(
      !findWarning(output, 'S008'),
      `an empty value is indistinguishable from absence; got: ${JSON.stringify(output.warnings)}`,
    );
    assert.strictEqual(output.valid, true);
  });


  test('S008: the SHIPPED state template validates clean (its last_activity is an unfilled placeholder)', () => {
    // templates/state.md:35 ships `Last activity: [YYYY-MM-DD] — [What happened]`,
    // so this is the state of EVERY freshly-initialized project until something
    // records activity. The first cut of S008 spared only the ABSENT form and
    // fired on the shipped template itself — caught by the pre-existing
    // "template-equivalent phase identities remain clean without disk drift"
    // test. This pins the same invariant from the S008 side, where the
    // regression would actually be introduced.
    const stateContent = readShippedStateTemplateBody([
      ['status: planning', ['current_phase: 2', 'status: planning'].join('\n')],
      ['Phase: [X] of [Y] ([Phase name])', 'Phase: 02 of 2 (State Validation Drift Diagnostics)'],
      ['Status: [Ready to plan / Planning / Ready to execute / In progress / Phase complete]', 'Status: Planning'],
    ]);
    assert.match(
      stateContent,
      /Last activity: \[YYYY-MM-DD\]/,
      'precondition: the shipped template must still carry the placeholder this test is about',
    );
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);
    fs.mkdirSync(
      path.join(tmpDir, '.planning', 'phases', '02-state-validation-drift-diagnostics'),
      { recursive: true },
    );

    const { output } = validate();
    assert.strictEqual(output.valid, true, `the shipped template must validate clean; got: ${JSON.stringify(output.warnings)}`);
    assert.deepStrictEqual(output.warnings, []);
  });

  test('S008: a bracket placeholder only counts as unfilled at the START of the value', () => {
    // Guard against the over-broad reading. A real description that cites a
    // bracketed reference is a filled-in value, and its date must still be
    // checked — otherwise the placeholder rule silently swallows genuine drift.
    writeCleanState(['Last activity: not-a-date — see [#123] for context']);

    assert.ok(
      findWarning(validate().output, 'S008'),
      'a bracket later in the value does not make the value unfilled',
    );
  });

  // ── --strict: the exit status becomes gateable, opt-in only ─────────────────

  test('--strict: a document with warnings exits non-zero', () => {
    writeCleanState(['Last activity: not-a-date — broken']);

    const { result, output } = validate('state validate --strict');
    assert.strictEqual(output.valid, false);
    assert.strictEqual(result.exitCode, 1, 'a CI step must be able to gate on the exit status');
  });

  test('--strict: a clean document still exits zero', () => {
    writeCleanState(['Last activity: 2026-08-19 — done']);

    const { result, output } = validate('state validate --strict');
    assert.strictEqual(output.valid, true);
    assert.strictEqual(result.exitCode, 0);
  });

  test('--strict: the default exit status is unchanged when the flag is absent', () => {
    // Hyrum's Law guard (ADR-3180 Decision 3): state validate's exit status is
    // observable behaviour reaching downstream consumers that cannot be
    // enumerated. Flipping the DEFAULT would break every script that runs it
    // unconditionally, so the new behaviour is opt-in — and this test fails if
    // anyone later "simplifies" it into the default.
    writeCleanState(['Last activity: not-a-date — broken']);

    const { result, output } = validate();
    assert.strictEqual(output.valid, false);
    assert.strictEqual(result.exitCode, 0, 'the default exit status must NOT change');
  });

  test('--strict: the S001 early-return path also exits non-zero', () => {
    // S001 returns early from its own output(...) call; a fix that only set the
    // exit code at the end of the function would miss this branch.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), Buffer.from('# Project State\0corrupt'));

    const { result, output } = validate('state validate --strict');
    assert.strictEqual(output.valid, false);
    assert.strictEqual(result.exitCode, 1);
  });

  test('--strict: a missing STATE.md exits non-zero', () => {
    // createFixture() makes .planning/ but no STATE.md — the
    // {error:'STATE.md not found'} pre-check shape, a third early return.
    const { result, output } = validate('state validate --strict');
    assert.ok(output.error, 'the not-found shape is unchanged');
    assert.strictEqual(result.exitCode, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3187 (ADR-3180 §7.7) — matrix section B: `state validate`'s scope field,
// including the #3162 headline regression and #1255 frontmatter shadowing.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3187 state validate — scope field (matrix section B)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('B1: validate detects drift when phase is frontmatter-only (#3162 regression — must fail before the fix)', () => {
    // Phase lives ONLY in frontmatter; the body has no `Current Phase` field
    // at all. Pre-#3187, cmdStateValidate read `Current Phase` off the body
    // only, resolved null, and the ENTIRE drift block was skipped —
    // "could not look" was output-identical to "looked, all clean"
    // (originally {valid:true, warnings:[], drift:{}}; post-#3310 the
    // equivalent clean shape is {valid:true, warnings:[]}, `drift` removed).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase: 2',
        '---',
        '# Project State',
        '',
        '**Status:** Executing Phase 2',
        '**Total Plans in Phase:** 5',
        '**Current Plan:** 1',
        '',
      ].join('\n'),
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    // The RIGHT reason to fail before the fix: valid was true and no
    // plan-count warning was ever generated, not a crash.
    assert.strictEqual(output.valid, false, 'STATE.md says 5 plans, disk has 2 — drift must be reported');
    const s005 = findWarning(output, 'S005');
    assert.ok(s005, 'S005 must fire for the frontmatter-only phase drift');
    assert.ok(s005.message.includes('STATE.md says 5 plans'), 'message must report the STATE.md count');
    assert.ok(s005.message.includes('disk has 2'), 'message must report the disk-scanned count');
    assert.strictEqual(output.scope, SCOPE.COMPLETE);
    assertNoDriftKey(output);
  });

  test('B2: validate passes cleanly when it actually looked (frontmatter-only phase, counts match)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'current_phase: 2',
        '---',
        '# Project State',
        '',
        '**Status:** Executing Phase 2',
        '**Total Plans in Phase:** 2',
        '**Current Plan:** 1',
        '',
      ].join('\n'),
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state validate', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true);
    assert.strictEqual(output.warnings.length, 0);
    assert.strictEqual(output.scope, SCOPE.COMPLETE);
    assertNoDriftKey(output);
  });

  test('B3: validate still detects body-resolved drift (regression guard, unchanged today)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 1',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 3',
        '**Current Plan:** 1',
        '',
      ].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s005 = findWarning(output, 'S005');
    assert.ok(s005, 'S005 must fire for the body-resolved plan-count drift');
    assert.ok(s005.message.includes('STATE.md says 3 plans'), 'message must report the STATE.md count');
    assert.ok(s005.message.includes('disk has 1'), 'message must report the disk-scanned count');
    assert.strictEqual(output.scope, SCOPE.COMPLETE);
    assertNoDriftKey(output);
  });

  test('B4: unresolvable phase is not reported as clean (distinguishable from B2)', () => {
    // Neither frontmatter nor body carries a Current Phase field anywhere.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['# Project State', '', '**Status:** Planning', ''].join('\n'),
    );

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s002 = findWarning(output, 'S002');
    assert.ok(s002, 'S002 must fire when the phase is unresolvable');
    assertNoDriftKey(output);
  });

  test('B5: missing phase dir differs from could-not-look (distinguishable from B4)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 99',
        '**Current Phase:** 99',
        '**Total Plans in Phase:** 2',
        '',
      ].join('\n'),
    );
    // phases/ exists (createFixture) but has no matching 99-* directory.

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    const s004 = findWarning(output, 'S004');
    assert.ok(s004, 'S004 must fire when no phase directory matches');
    assertNoDriftKey(output);
  });

  test('B6: unreadable phases dir is surfaced, not swallowed', (t) => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 1',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 1',
        '',
      ].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const originalReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (p === phasesDir) {
        const err = new Error('EACCES: permission denied, scandir');
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.call(fs, p, ...rest);
    });
    t.after(() => mock.restoreAll());

    const raw = captureStdout(() => stateLib.cmdStateValidate(tmpDir, false));
    const output = JSON.parse(raw);
    assert.strictEqual(output.valid, false, 'an unreadable directory must not validate cleanly');
    const s004 = findWarning(output, 'S004');
    assert.ok(s004, 'S004 must fire when the phases directory itself is unreadable');
    assertNoDriftKey(output);
  });

  test('B6b: unreadable selected phase directory fails closed', (t) => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['# Project State', '', '**Status:** Executing Phase 1', '**Current Phase:** 1', ''].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });

    const originalReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (p === phaseDir) throw new Error('EACCES: permission denied, scandir');
      return originalReaddirSync.call(fs, p, ...rest);
    });
    t.after(() => mock.restoreAll());

    const output = JSON.parse(captureStdout(() => stateLib.cmdStateValidate(tmpDir, false)));
    assert.strictEqual(output.valid, false, 'an unreadable selected phase must not validate cleanly');
    const s004 = findWarning(output, 'S004');
    assert.ok(s004, 'S004 must fire when the selected phase directory itself is unreadable');
    assertNoDriftKey(output);
  });

  test('B7: one unreadable verification file does not abort the scan', (t) => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 1',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 1',
        '',
      ].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    const brokenPath = path.join(phaseDir, '01-A-VERIFICATION.md');
    const okPath = path.join(phaseDir, '01-B-VERIFICATION.md');
    fs.writeFileSync(brokenPath, ['---', 'status: passed', '---', ''].join('\n'));
    fs.writeFileSync(okPath, ['---', 'status: passed', '---', ''].join('\n'));

    const originalReadFileSync = fs.readFileSync;
    mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (p === brokenPath) {
        const err = new Error('EACCES: permission denied, open');
        err.code = 'EACCES';
        throw err;
      }
      return originalReadFileSync.call(fs, p, ...rest);
    });
    t.after(() => mock.restoreAll());

    const raw = captureStdout(() => stateLib.cmdStateValidate(tmpDir, false));
    const output = JSON.parse(raw);
    // Per-file swallow (#2245 audit) is unchanged: the other verification
    // file is still consulted, so its S006 diagnostic still fires, and the
    // whole scan is NOT degraded to UNREADABLE just because one file 404s.
    // Asserted on the S006 `Diagnostic`'s `code` alone, not its `message`
    // prose (CONTRIBUTING.md's "Prohibited: Raw Text Matching on Test
    // Outputs") — the vf filename isn't pinned since readdirSync order
    // across the two verification files isn't guaranteed.
    const s006 = findWarning(output, 'S006');
    assert.ok(s006, 'S006 must fire for the readable verification file despite the unreadable sibling');
    assert.strictEqual(output.scope, SCOPE.COMPLETE);
    assertNoDriftKey(output);
  });

  test('B8: absent STATE.md unchanged', () => {
    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.error, 'STATE.md not found');
    assert.strictEqual(output.scope, undefined);
  });

  test('B9: binary STATE.md still fails loud (existing #2701 path unchanged, no scope key added)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), Buffer.from('# State\0\0\0binary'));
    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false);
    assert.strictEqual(output.warnings.length, 1);
    const [s001] = output.warnings;
    assert.strictEqual(s001.code, 'S001');
    assert.strictEqual(s001.severity, SEVERITY.ERROR, 'S001 is error-class severity, not a mere warning');
    assert.strictEqual(output.scope, undefined, 'the #2701 early return is explicitly unchanged — no scope key');
    assertNoDriftKey(output);
  });

  test('B10: json and default output agree (validate has no distinct raw-text mode; --raw is a no-op for it)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 1',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 1',
        '',
      ].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const withoutFlag = runGsdTools('state validate', tmpDir).output;
    const withRaw = runGsdTools('state validate --raw', tmpDir).output;
    assert.deepEqual(JSON.parse(withoutFlag), JSON.parse(withRaw));
  });

  test('B11: plan-count boundary 0/1/2 — no false drift when counts match, real drift when they do not', () => {
    for (const n of [0, 1, 2]) {
      const dir = createFixture();
      fs.writeFileSync(
        path.join(dir, '.planning', 'STATE.md'),
        [
          '# Project State',
          '',
          '**Status:** Executing Phase 1',
          '**Current Phase:** 1',
          `**Total Plans in Phase:** ${n}`,
          '',
        ].join('\n'),
      );
      const phaseDir = path.join(dir, '.planning', 'phases', '01-setup');
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= n; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-${String(i).padStart(2, '0')}-PLAN.md`), '# Plan\n');
      }
      const output = JSON.parse(runGsdTools('state validate', dir).output);
      assert.strictEqual(output.valid, true, `n=${n} matching disk must be valid`);
      assert.strictEqual(output.warnings.length, 0, `n=${n} matching disk must have no warnings`);
      assert.strictEqual(output.scope, SCOPE.COMPLETE);
      cleanup(dir);
    }

    for (const n of [0, 1, 2]) {
      const dir = createFixture();
      fs.writeFileSync(
        path.join(dir, '.planning', 'STATE.md'),
        [
          '# Project State',
          '',
          '**Status:** Executing Phase 1',
          '**Current Phase:** 1',
          `**Total Plans in Phase:** ${n}`,
          '',
        ].join('\n'),
      );
      const phaseDir = path.join(dir, '.planning', 'phases', '01-setup');
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 1; i <= n + 1; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-${String(i).padStart(2, '0')}-PLAN.md`), '# Plan\n');
      }
      const output = JSON.parse(runGsdTools('state validate', dir).output);
      assert.strictEqual(output.valid, false, `n=${n} vs disk n+1 must be flagged`);
      // The boundary values (n, n+1) are what this loop proves flow through
      // correctly; `.includes()` on the interpolated counts, not full-string
      // message equality (CONTRIBUTING.md's "Prohibited: Raw Text Matching
      // on Test Outputs") — `code` establishes S005 fired.
      const s005 = findWarning(output, 'S005');
      assert.ok(s005, `n=${n}: S005 must fire for the plan-count mismatch`);
      assert.ok(s005.message.includes(`STATE.md says ${n} plans`), `n=${n}: message must report the STATE.md count`);
      assert.ok(s005.message.includes(`disk has ${n + 1}`), `n=${n}: message must report the disk-scanned count`);
      assertNoDriftKey(output);
      cleanup(dir);
    }
  });

  test('B12: a thrown extractFrontmatter degrades scope to UNREADABLE (frontmatter-parse catch, distinct from B6\'s phases-dir-scan-failure catch)', (t) => {
    // extractFrontmatter is documented never to throw (src/frontmatter.cts
    // has no `throw` in its extraction path), so this catch is a defensive
    // branch normally unreachable through any real STATE.md content. Drive
    // it directly by mocking the frontmatter module's export — since
    // src/state.cts destructures `extractFrontmatter` out of the frontmatter
    // module at REQUIRE time (`const { extractFrontmatter } = frontmatter;`),
    // mocking the already-cached `frontmatterLib.extractFrontmatter` has no
    // effect on a state.cjs module instance that was required BEFORE the
    // mock was installed (its local binding already captured the original
    // function). Busting state.cjs's own require-cache entry and re-requiring
    // it AFTER the mock is installed forces its destructuring to capture the
    // mocked function instead — the top-level `stateLib` binding used by
    // every other test in this file is untouched throughout (a fresh module
    // instance is a distinct exports object).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Status:** Executing Phase 1',
        '**Current Phase:** 1',
        '**Total Plans in Phase:** 1',
        '',
      ].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const stateCjsPath = require.resolve('../gsd-core/bin/lib/state.cjs');
    delete require.cache[stateCjsPath];
    mock.method(frontmatterLib, 'extractFrontmatter', () => {
      throw new Error('simulated frontmatter parse failure');
    });
    t.after(() => {
      mock.restoreAll();
      delete require.cache[stateCjsPath];
    });
    const freshStateLib = require(stateCjsPath);

    const raw = captureStdout(() => freshStateLib.cmdStateValidate(tmpDir, false));
    const output = JSON.parse(raw);
    assert.strictEqual(output.valid, true, 'a frontmatter-parse failure must not crash or fabricate a warning');
    assert.strictEqual(output.scope, SCOPE.UNREADABLE, 'a thrown extractFrontmatter must degrade scope, exactly like B6\'s phases-dir failure');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3187 (ADR-3180 §7.7, Decision 4c) — matrix section C: identity tests
// asserted at each CONSUMER's observable output vs the chain owner's answer
// for the SAME input, never the owner's return value against itself.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3187 chain-owner identity — every consumer agrees with stateFieldValue (matrix section C)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('C1: snapshot output matches the chain owner', () => {
    const content = [
      '---',
      'current_phase: 3',
      'status: verifying',
      '---',
      '# Project State',
      '',
      '**Current Phase:** 1', // shadowed by frontmatter — must NOT win
      '**Status:** Planning', // shadowed by frontmatter — must NOT win
      '**Total Plans in Phase:** 4',
      '**Current Plan:** 2',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const output = JSON.parse(runGsdTools('state-snapshot', tmpDir).output);
    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);

    assert.strictEqual(output.current_phase, stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value);
    assert.strictEqual(output.status, stateDocument.stateFieldValue(fm, body, 'status', 'Status').value);
    assert.strictEqual(String(output.total_plans_in_phase), stateDocument.stateFieldValue(fm, body, 'total_plans_in_phase', 'Total Plans in Phase').value);
    assert.strictEqual(output.current_plan, stateDocument.stateFieldValue(fm, body, 'current_plan', 'Current Plan').value);
  });

  test('C2: validate resolves the same phase as the owner', () => {
    const content = [
      '---',
      'current_phase: 2',
      '---',
      '# Project State',
      '',
      '**Current Phase:** 1', // shadowed — must NOT be the phase validate scans against
      '**Status:** Executing Phase 2',
      '**Total Plans in Phase:** 1',
      '**Current Plan:** 1',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    const ownerPhase = stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value;
    assert.strictEqual(ownerPhase, '2', 'sanity: owner must resolve frontmatter phase 2, not shadowed body phase 1');

    // Phase 1 (the wrong/shadowed candidate) gets a MISMATCHING disk count;
    // phase 2 (the owner's actual answer) gets a MATCHING disk count. Only
    // observable if validate scanned the owner's phase, not the shadowed one.
    const phase1Dir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase1Dir, '01-02-PLAN.md'), '# Plan\n');

    const phase2Dir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phase2Dir, { recursive: true });
    fs.writeFileSync(path.join(phase2Dir, '02-01-PLAN.md'), '# Plan\n');

    const output = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(output.valid, false, 'conflicting phase sources must not validate cleanly');
    const s003 = findWarning(output, 'S003');
    assert.ok(s003, 'S003 must fire for conflicting phase sources');
    assert.ok(!findWarning(output, 'S005'), 'validate must scan phase 2, not the shadowed phase 1 (no plan-count drift)');
    assertNoDriftKey(output);
  });

  test('C3: prune resolves the same phase as the owner', () => {
    const content = [
      '---',
      'current_phase: 7',
      '---',
      '# Project State',
      '',
      '**Current Phase:** 2', // shadowed
      '**Status:** Executing Phase 7',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    const ownerPhase = stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value;
    assert.strictEqual(ownerPhase, '7');

    const keepRecent = 2;
    const output = JSON.parse(runGsdTools(`state prune --keep-recent ${keepRecent} --dry-run`, tmpDir).output);
    assert.strictEqual(output.cutoff_phase, Number(ownerPhase) - keepRecent);
  });

  test('C4: smart-entry matches the owner under its own (deliberately unscoped) declared read', () => {
    const content = [
      '---',
      'current_phase: 5',
      '---',
      '# Project State',
      '',
      '**Current Phase:** 1', // shadowed
      '**Status:** Executing Phase 5',
      '**Total Phases:** 8',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    // smart-entry's own declared read is deliberately UNSCOPED over the whole
    // body (design's Rejected #3 — an explicit, written exemption, not a
    // silent fold) — same fm/body inputs, same fallback shape, just with the
    // body-only `Phase` prose step it also declares.
    const ownerPhaseRaw =
      stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value ??
      stateDocument.stateFieldValue(fm, body, null, 'Phase').value;

    const output = JSON.parse(runGsdTools('smart-entry --json', tmpDir).output);
    assert.strictEqual(output.signals.current_phase, ownerPhaseRaw);
  });

  test('C5: workstream projection matches the owner', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-c5' });
    // Divergent frontmatter vs. body (mirrors C3/C4): frontmatter says 4,
    // body says 1. `readStateProjection` (Derivation A site 6) is now routed
    // through `stateFieldValue`, so this proves the consumer actually
    // resolves the frontmatter-tier value rather than merely agreeing with
    // the owner on a fixture where the two tiers could never disagree.
    const content = [
      '---',
      'current_phase: 4',
      '---',
      '# Project State',
      '',
      '**Current Phase:** 1', // shadowed
      '**Status:** Executing Phase 4',
      '',
    ].join('\n');
    const statePath = path.join(wsDir, 'STATE.md');
    fs.writeFileSync(statePath, content);

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    const ownerPhase = stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value;
    assert.strictEqual(ownerPhase, '4');

    const inv = workstreamInventory.inspectWorkstream(tmpDir, 'ws-c5');
    assert.ok(inv, 'inspectWorkstream should find the seeded workstream');
    assert.strictEqual(inv.current_phase, ownerPhase);
  });

  test('C6: idempotency guard matches the owner', () => {
    // Divergent frontmatter vs. body (mirrors C3/C4): frontmatter says 5,
    // body says 1. `resolvePhaseIdForCompletePhase` / the complete-phase
    // idempotency guard (Derivation A site 5) is now routed through
    // `stateFieldValue`, so this proves the guard actually resolves the
    // frontmatter-tier value 5 (not the shadowed body value 1) when deciding
    // whether the requested phase 3 has already been superseded.
    const content = [
      '---',
      'current_phase: 5',
      '---',
      '# Project State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 1', // shadowed
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    const ownerPhase = stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value;
    assert.strictEqual(ownerPhase, '5');

    const output = JSON.parse(runGsdTools(['state', 'complete-phase', '--phase', '3'], tmpDir).output);
    assert.strictEqual(output.idempotent, true, 'requested phase 3 precedes the owner-resolved current phase 5 (from frontmatter, not the shadowed body value 1), so the guard must fire');
  });

  test('C7: every consumer agrees on the same STATE.md', () => {
    const content = [
      '# Project State',
      '',
      '**Status:** Executing Phase 6',
      '**Current Phase:** 6',
      '**Total Plans in Phase:** 2',
      '**Current Plan:** 1',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '06-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-PLAN.md'), '# Plan\n');

    const fm = frontmatterLib.extractFrontmatter(content, statePath);
    const body = frontmatterLib.stripFrontmatter(content);
    const ownerPhase = stateDocument.stateFieldValue(fm, body, 'current_phase', 'Current Phase').value;
    assert.strictEqual(ownerPhase, '6');

    // C1: state snapshot
    const snapshot = JSON.parse(runGsdTools('state-snapshot', tmpDir).output);
    assert.strictEqual(snapshot.current_phase, ownerPhase);

    // C2: state validate (indirect — valid+no-warnings only holds if phase 6 was used)
    const validate = JSON.parse(runGsdTools('state validate', tmpDir).output);
    assert.strictEqual(validate.valid, true);
    assert.strictEqual(validate.warnings.length, 0);
    assert.strictEqual(validate.scope, SCOPE.COMPLETE);

    // C3: state prune (cutoff_phase + keepRecent must equal the owner phase)
    const keepRecent = 2;
    const prune = JSON.parse(runGsdTools(`state prune --keep-recent ${keepRecent} --dry-run`, tmpDir).output);
    assert.strictEqual(prune.cutoff_phase + keepRecent, Number(ownerPhase));

    // C4: smart-entry
    const smartEntry = JSON.parse(runGsdTools('smart-entry --json', tmpDir).output);
    assert.strictEqual(smartEntry.signals.current_phase, ownerPhase);

    // C6: complete-phase idempotency guard (no frontmatter in this fixture,
    // so this row does not exercise the frontmatter tier — see C6's own test
    // for that divergent-frontmatter case).
    const complete = JSON.parse(runGsdTools(['state', 'complete-phase', '--phase', '3'], tmpDir).output);
    assert.strictEqual(complete.idempotent, true);

    // C5 (workstream inventory) is intentionally NOT folded into this
    // cross-consumer fixture: it reads a structurally different path
    // (`.planning/workstreams/<name>/STATE.md`), so it cannot be "the same
    // STATE.md" as the root-level consumers above without contradicting the
    // literal same-input premise this row is about. See C5's own test.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state sync (Step 5 — Gate 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('state sync command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('drifted STATE.md + correct filesystem: after sync, fields match disk', () => {
    // STATE says phase 1 with 0 plans, but disk has phase 2 with 3 plans
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phase1Dir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');

    const phase2Dir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phase2Dir, { recursive: true });
    fs.writeFileSync(path.join(phase2Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-03-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.synced, 'Should report synced');

    const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Total plans in current phase (phase 2 since it's highest with incomplete plans) should be 3
    assert.ok(stateAfter.match(/Total Plans in Phase.*3/), 'Total Plans should match disk (3)');
  });

  test('run sync twice is idempotent', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    runGsdTools('state sync', tmpDir);
    const afterFirst = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    runGsdTools('state sync', tmpDir);
    const afterSecond = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Strip frontmatter timestamps which will differ
    const stripTimestamps = (s) => s.replace(/last_updated:.*\r?\n/g, '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TS');
    assert.strictEqual(stripTimestamps(afterFirst), stripTimestamps(afterSecond), 'Two syncs should produce same result');
  });

  test('--verify flag reports changes without writing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.changes && output.changes.length > 0, 'Should report changes');
    assert.strictEqual(output.dry_run, true, 'Should indicate dry run');

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(before, after, 'File should not be modified in verify mode');
  });

  // ADR-3408 §8.3 Matrix C3 (#3469, extend): `--verify` stays a true dry run
  // for the sanctioned-exception path too — no write happens even though the
  // (unwritten) sync would have let the body win over a curated frontmatter
  // value.
  test('C3 (#3469): --verify does not write even when the body would win over a curated frontmatter value', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'stopped_at: "curated stale value"',
      '---',
      '',
      '# Project State',
      '',
      '## Session',
      '',
      '**Stopped at:** fresh body value',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, content, '--verify must not write, regardless of what a real sync would change');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3408 §8.3 Matrix C (#3469): cmdStateSync is a SANCTIONED EXCEPTION.
// The most important section of this phase's matrix — a regression here
// silently INVERTS a shipped feature (#905: "body annotation beats existing
// frontmatter when both are present") with every OTHER gate green. state
// sync exists to re-derive frontmatter FROM the body; routing it through
// preservation would defeat the command. Test matrix:
// .gsd/phase/refactor-3469-one-write-seam/50-test-matrix.md
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-3408 §8.3 Matrix C: cmdStateSync — the sanctioned exception (#3469)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createFixture(); });
  afterEach(() => { cleanup(tmpDir); });

  // C1 — the whole point: body annotation vs existing frontmatter, both
  // present, differing. `state sync` re-derives frontmatter FROM the body
  // (#905) — the body must win, never the curated frontmatter.
  test('C1: body annotation wins over existing (differing) frontmatter — the whole point of `state sync`', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'stopped_at: "curated stale value — must NOT survive"',
      '---',
      '',
      '# Project State',
      '',
      '## Session',
      '',
      '**Stopped at:** fresh body value — must win',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(state);
    assert.strictEqual(
      fm.stopped_at,
      'fresh body value — must win',
      `body must win over the curated frontmatter value; a preservation regression here would ` +
      `silently invert #905 with every other gate green; got ${JSON.stringify(fm.stopped_at)}`,
    );
  });

  // C2: a stale-LOOKING frontmatter value (a different field than C1, to pin
  // the contract on a second, independent field) loses to a fresh body value.
  test('C2: a stale-looking frontmatter current_phase_name loses to a fresh body Phase: name', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: "1"',
      'current_phase_name: Old Stale Name',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 1 (Fresh Correct Name)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(state);
    assert.strictEqual(
      fm.current_phase_name,
      'Fresh Correct Name',
      `body must win over the stale-looking curated name; got ${JSON.stringify(fm.current_phase_name)}`,
    );
  });

  // C4 — identity: cmdStateSync's output is byte-identical to pre-refactor —
  // no preservation artifact of any kind reaches it. Proven two ways: (a) the
  // command's own JSON report carries no `preservation_warnings` key (the
  // field ONLY cmdPhaseComplete/cmdMilestoneComplete now expose), and (b) the
  // SAME divergence C1 exercises resolves the SAME way (body wins, nothing
  // restored) — proving this phase's refactor did not quietly wire the seam
  // in here.
  test('C4: cmdStateSync carries no preservation_warnings key and never restores a curated value (unchanged by #3469)', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'stopped_at: "curated stale value — must NOT survive"',
      '---',
      '',
      '# Project State',
      '',
      '## Session',
      '',
      '**Stopped at:** fresh body value — must win',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(output, 'preservation_warnings'),
      'cmdStateSync must not gain the preservation_warnings channel this phase added to phase.complete/milestone.complete',
    );

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(state);
    assert.strictEqual(fm.stopped_at, 'fresh body value — must win', 'no curated value may be restored');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADR-3408 §8.5 Matrix (#3471): stale-but-present, and the report residue.
// Design: .gsd/phase/refactor-3471-stale-but-present/40-design.md
// Matrix: .gsd/phase/refactor-3471-stale-but-present/50-test-matrix.md
//
// As-built (probe-verified against gsd-core/bin/lib/state.cjs, not guessed):
//  - The six #905 empty-only guards in `syncStateFrontmatter` are GATED behind
//    a `sanctionedPermanentEmptyFallback` param, not deleted outright.
//    `writeStateMd` (state sync / REGENERATE_STATE) passes `true`;
//    `syncAndPreserveStateMd` (the write seam) passes nothing — so an empty
//    derived value reaches `applyStatePreservation` unmolested there.
//  - `cmdStateJson` routes exactly six fields (status, stopped_at, paused_at,
//    current_phase, current_plan, current_phase_name — NOT last_activity_desc)
//    through `applyPreserveWhenUnchanged` with a synthetic {pre,post} delta
//    (same value twice — a read is never a "write").
// ═════════════════════════════════════════════════════════════════════════════

describe('ADR-3408 §8.5 Matrix (#3471): stale-but-present, and the report residue', () => {
  // #3471: extractFrontmatter's mini-YAML parser returns nested `progress.*`
  // scalars as raw strings unless a caller runs them through
  // normalizeProgressNumbers (the sanctioned-permanent guard path does; the
  // write-seam merge exercised throughout this block does not). This exact
  // string-vs-number round-trip has bitten test authoring FOUR times in this
  // phase alone (twice self-caught before shipping, once as A4, now as
  // A2f) — route every progress-reading assertion in this block through this
  // helper rather than comparing against numeric literals. Mirrors
  // `tests/frontmatter.test.cjs`'s `readPersistedProgress` (which is
  // file-path based, reading from disk); this variant operates on an
  // already-extracted `fm.progress` object since not every case in this
  // block round-trips through a file.
  function numericProgress(fmProgress) {
    assert.ok(fmProgress, 'frontmatter must have a progress block');
    return Object.fromEntries(
      Object.entries(fmProgress).map(([key, value]) => [key, Number(value)]),
    );
  }

  // ─── Section A — deleting the six guards (D1) ──────────────────────────────
  // A1-A4/A7 assert on the write seam's own returned content (not required to
  // be consumer-level by the matrix's assertion rule). A5/A6 ARE in the
  // consumer-level list (ADR-3180 Decision 4(c)) so they write the result to a
  // real file and read it back, mirroring the existing A1/A2/A3 fast-check
  // property's own pattern (tests/state.test.cjs "ADR-3408 §8.3 Matrix
  // A1/A2/A3").
  describe('Section A — deleting the six guards (D1)', () => {
    test('A1: derived empty, body source UNCHANGED, curated frontmatter present — restored via the executor', (t) => {
      const tmp = createTempDir('gsd-3471-a1-');
      t.after(() => cleanup(tmp));
      const original = [
        '---', 'gsd_state_version: 1.0', 'current_phase: "5"', 'current_phase_name: Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Executing', '',
      ].join('\n');
      // Change something OTHER than the Phase line, so this is a real write
      // whose Phase-line body source is unchanged pre/post.
      const transformed = original.replace('Status: Executing', 'Status: Verifying');
      const statePath = path.join(tmp, 'STATE.md');
      const divergedFields = [];
      const out = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false, divergedFields });
      const fm = frontmatterLib.extractFrontmatter(out);
      assert.strictEqual(fm.current_phase, '5', 'current_phase must be restored by the executor, not lost');
      assert.strictEqual(fm.current_phase_name, 'Curated Name', 'current_phase_name must be restored by the executor, not lost');
      assert.deepStrictEqual(
        divergedFields.slice().sort(),
        ['current_phase', 'current_phase_name'],
        'both restores must be reported — preservation is visible',
      );
    });

    // A2 — deliberately SIX separate named tests, one per gated guard. A list
    // over these six field names is easy to quietly shorten; six named tests
    // are not (matrix's own stated rationale).
    function a2Case(curatedFrontmatterLine, body) {
      const original = ['---', 'gsd_state_version: 1.0', curatedFrontmatterLine, '---', '', '# Project State', '', ...body].join('\n');
      const transformed = original.replace('Executing', 'Verifying');
      const tmp = createTempDir('gsd-3471-a2-');
      const statePath = path.join(tmp, 'STATE.md');
      const divergedFields = [];
      const out = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false, divergedFields });
      cleanup(tmp);
      return { fm: frontmatterLib.extractFrontmatter(out), divergedFields };
    }

    test('A2a: stopped_at — restored', () => {
      const { fm, divergedFields } = a2Case(
        'stopped_at: "Phase 3, curated stop"',
        ['## Session', '', '**Last session:** 2026-01-01', ''],
      );
      assert.strictEqual(fm.stopped_at, 'Phase 3, curated stop');
      assert.deepStrictEqual(divergedFields, ['stopped_at']);
    });

    test('A2b: paused_at — restored', () => {
      const { fm, divergedFields } = a2Case(
        'paused_at: "Phase 3, curated pause"',
        ['## Session', '', '**Last session:** 2026-01-01', ''],
      );
      assert.strictEqual(fm.paused_at, 'Phase 3, curated pause');
      assert.deepStrictEqual(divergedFields, ['paused_at']);
    });

    test('A2c: current_phase — restored', () => {
      const { fm, divergedFields } = a2Case(
        'current_phase: "5"',
        ['## Current Position', '', 'Status: Executing', ''],
      );
      assert.strictEqual(fm.current_phase, '5');
      assert.deepStrictEqual(divergedFields, ['current_phase']);
    });

    test('A2d: current_phase_name — restored', () => {
      const { fm, divergedFields } = a2Case(
        'current_phase_name: Curated Name',
        ['## Current Position', '', 'Status: Executing', ''],
      );
      assert.strictEqual(fm.current_phase_name, 'Curated Name');
      assert.deepStrictEqual(divergedFields, ['current_phase_name']);
    });

    test('A2e: current_plan — restored', () => {
      const { fm, divergedFields } = a2Case(
        'current_plan: 03-02-curated',
        ['## Current Position', '', 'Status: Executing', ''],
      );
      assert.strictEqual(fm.current_plan, '03-02-curated');
      assert.deepStrictEqual(divergedFields, ['current_plan']);
    });

    test('A2f: progress — restored (resync:false — preserve-always is resync-gated, unlike the other five)', () => {
      const { fm, divergedFields } = a2Case(
        ['progress:', '  total_phases: 3', '  completed_phases: 2', '  total_plans: 5', '  completed_plans: 4', '  percent: 80'].join('\n'),
        ['## Current Position', '', 'Status: Executing', ''],
      );
      assert.deepStrictEqual(
        numericProgress(fm.progress),
        { total_phases: 3, completed_phases: 2, total_plans: 5, completed_plans: 4, percent: 80 },
      );
      assert.deepStrictEqual(divergedFields, ['progress']);
    });

    test('A3: derived empty, no curated value — stays empty, no throw', (t) => {
      const tmp = createTempDir('gsd-3471-a3-');
      t.after(() => cleanup(tmp));
      const original = ['---', 'gsd_state_version: 1.0', '---', '', '# Project State', '', '## Current Position', '', 'Status: Executing', ''].join('\n');
      const transformed = original.replace('Status: Executing', 'Status: Verifying');
      const statePath = path.join(tmp, 'STATE.md');
      const divergedFields = [];
      assert.doesNotThrow(() => {
        const out = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false, divergedFields });
        const fm = frontmatterLib.extractFrontmatter(out);
        assert.strictEqual(fm.current_phase, undefined);
        assert.strictEqual(fm.current_phase_name, undefined);
      });
      assert.deepStrictEqual(divergedFields, [], 'nothing curated existed, so nothing can have diverged');
    });

    // A4 — the subtlest row: `progress` is a sub-object. A block the disk scan
    // only PARTIALLY derived (here: only total_phases, from a body "Total
    // Phases:" line, no phase dirs on disk) is not "empty" — the deleted
    // empty-only guard's own condition (`!derivedFm['progress']`) never fired
    // for a partial block even before this phase, so a partial block is
    // governed purely by `applyPreserveAlways`'s existing #2440/#2969 merge
    // (deriveProgressKeys:true): the derive-flagged keys (total_phases here)
    // always take the freshly-derived value ("the derived block wins"), while
    // the ratchet-protected keys (completed_phases/completed_plans) keep the
    // curated value when the derived side lacks a greater one ("a partial
    // block must NOT clobber curated" — #3242). Empirically verified against
    // the compiled lib before writing this assertion.
    test('A4: progress partially derived (block present, some keys missing) vs curated — derived wins for derive-flagged keys, curated survives for ratchet-protected keys', (t) => {
      const tmp = createTempDir('gsd-3471-a4-');
      t.after(() => cleanup(tmp));
      const original = [
        '---', 'gsd_state_version: 1.0',
        'progress:', '  total_phases: 3', '  completed_phases: 2', '  total_plans: 5', '  completed_plans: 4', '  percent: 80',
        '---', '', '# Project State', '', '## Current Position', '', 'Total Phases: 3', '',
      ].join('\n');
      const transformed = original.replace('Total Phases: 3', 'Total Phases: 10');
      const statePath = path.join(tmp, 'STATE.md');
      const out = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false, deriveProgressKeys: true });
      const fm = frontmatterLib.extractFrontmatter(out);
      // #3471 review: extractFrontmatter's mini-YAML parser returns nested
      // `progress.*` scalars as raw strings — see `numericProgress` above
      // for why. Compare numerically, not by strict type.
      const progress = numericProgress(fm.progress);
      assert.strictEqual(progress.total_phases, 10, 'total_phases (derive-flagged) must take the freshly-derived disk value');
      assert.strictEqual(progress.completed_phases, 2, 'completed_phases (ratchet-protected) must keep curated — the partial derive must not clobber it');
      assert.strictEqual(progress.completed_plans, 4, 'completed_plans (ratchet-protected) must keep curated — the partial derive must not clobber it');
    });

    // A5 — the D1 defect itself, at the CONSUMER's output (ADR-3180 Decision
    // 4(c)): the transform DELETES the body Phase line (delta CHANGED, not
    // merely absent-and-unchanged like A1/A3) — derived (empty) must win per
    // the delta rule, AND the discard must be reported in `divergedFields`,
    // never silently persist the stale curated value (the bug D1 closes).
    test('A5: derived empty because the transform DELETED the body line (delta CHANGED) — derived wins, and the discard is reported', (t) => {
      const tmp = createTempDir('gsd-3471-a5-');
      t.after(() => cleanup(tmp));
      const original = [
        '---', 'gsd_state_version: 1.0', 'current_phase: "5"', 'current_phase_name: Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 5 (Curated Name)', '',
      ].join('\n');
      const transformed = original.replace('Phase: 5 (Curated Name)\n', '');
      const statePath = path.join(tmp, 'STATE.md');
      fs.writeFileSync(statePath, original);
      const divergedFields = [];
      const written = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false, divergedFields });
      fs.writeFileSync(statePath, written);

      // Consumer-level: read the real file back, never compare the owner's
      // return value to itself.
      const onDisk = fs.readFileSync(statePath, 'utf8');
      const fm = frontmatterLib.extractFrontmatter(onDisk);
      assert.strictEqual(fm.current_phase, undefined, 'the deleted body line must not leave a stale curated current_phase behind');
      assert.strictEqual(fm.current_phase_name, undefined, 'the deleted body line must not leave a stale curated current_phase_name behind');
      assert.deepStrictEqual(
        divergedFields.slice().sort(),
        ['current_phase', 'current_phase_name'],
        'the discard-to-empty must be visible in divergedFields — this is the D1 bug\'s exact silent-persistence shape, now closed',
      );
    });

    // A6 — the regression wall, at the CONSUMER's output: Phases 1-3 already
    // fixed the headline "non-empty stale body value, delta unchanged, loses
    // to fresher curated frontmatter" case. If this test goes red, Phase 4
    // broke what the epic was for.
    test('A6: derived non-empty and STALE, delta unchanged, fresher frontmatter wins — must not regress', (t) => {
      const tmp = createTempDir('gsd-3471-a6-');
      t.after(() => cleanup(tmp));
      const original = [
        '---', 'gsd_state_version: 1.0', 'current_phase_name: Fresh Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 3 (Stale Body Name)', '',
      ].join('\n');
      const statePath = path.join(tmp, 'STATE.md');
      fs.writeFileSync(statePath, original);
      const divergedFields = [];
      // No transform this write — delta unchanged (transformedContent === originalContent).
      const written = stateLib.syncAndPreserveStateMd(original, original, statePath, tmp, { resync: false, divergedFields });
      fs.writeFileSync(statePath, written);

      const onDisk = fs.readFileSync(statePath, 'utf8');
      const fm = frontmatterLib.extractFrontmatter(onDisk);
      assert.strictEqual(fm.current_phase_name, 'Fresh Curated Name', 'fresher curated frontmatter must win over the stale body value — unchanged from Phases 1-3');
      const onDiskBody = frontmatterLib.stripFrontmatter(onDisk);
      const originalBody = frontmatterLib.stripFrontmatter(original);
      assert.strictEqual(onDiskBody, originalBody, 'the stale body text itself is untouched (frontmatter wins, body prose is not rewritten)');
      assert.deepStrictEqual(divergedFields, ['current_phase_name'], 'the restore must be reported');
    });

    test('A7: #2202 unknown-key carry-forward still works on the write seam', (t) => {
      const tmp = createTempDir('gsd-3471-a7-');
      t.after(() => cleanup(tmp));
      const original = [
        '---', 'gsd_state_version: 1.0', 'custom_unknown_key: preserved-value', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Executing', '',
      ].join('\n');
      const transformed = original.replace('Executing', 'Verifying');
      const statePath = path.join(tmp, 'STATE.md');
      const out = stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, { resync: false });
      const fm = frontmatterLib.extractFrontmatter(out);
      assert.strictEqual(fm.custom_unknown_key, 'preserved-value', 'an unknown/custom frontmatter key must still carry forward — a different mechanism from the six deleted guards');
    });

    // A8 (#3471): the actual defect the 14-failure incident exposed — a
    // plain-.cjs caller passing the OLD positional `resync` boolean where the
    // options object now goes. `tsc` never catches this (it only
    // type-checks src/); before this guard the function silently proceeded
    // with every option `undefined`, producing a well-formed-looking but
    // empty `divergedFields: []` rather than failing loudly. Assert on the
    // structured `code`/`receivedType`, never on prose (CONTRIBUTING.md,
    // "Prohibited: Raw Text Matching on Test Outputs").
    test('A8: passing a boolean in the options slot throws a structured error instead of silently degrading', () => {
      const tmp = createTempDir('gsd-3471-a8-');
      const original = ['---', 'gsd_state_version: 1.0', '---', '', '# Project State', '', '## Current Position', '', 'Status: Executing', ''].join('\n');
      const transformed = original.replace('Status: Executing', 'Status: Verifying');
      const statePath = path.join(tmp, 'STATE.md');
      cleanup(tmp);

      assert.throws(
        () => stateLib.syncAndPreserveStateMd(original, transformed, statePath, tmp, false),
        (err) => {
          assert.strictEqual(err.code, 'STATE_PRESERVATION_OPTIONS_INVALID');
          assert.strictEqual(err.receivedType, 'boolean');
          return true;
        },
        'syncAndPreserveStateMd must throw a structured error, not silently return with every option undefined',
      );

      assert.throws(
        () => stateLib.applyPostSyncPreservation(original, transformed, transformed, statePath, false),
        (err) => {
          assert.strictEqual(err.code, 'STATE_PRESERVATION_OPTIONS_INVALID');
          assert.strictEqual(err.receivedType, 'boolean');
          return true;
        },
        'applyPostSyncPreservation must throw a structured error, not silently return with every option undefined',
      );
    });
  });

  // ─── Section C — cmdStateJson (D3) ─────────────────────────────────────────
  describe('Section C — cmdStateJson (D3)', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = createFixture(); });
    afterEach(() => { cleanup(tmpDir); });

    // C1 — the D3 defect, at the CONSUMER's output: a stale non-empty body
    // annotation must no longer automatically beat a fresher curated
    // frontmatter value in `state json` — governed by the SAME
    // preserve-when-unchanged executor the write path uses.
    test('C1a: stale non-empty body current_phase_name loses to fresher curated frontmatter in `state json`', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase_name: Fresh Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 3 (Stale Body Name)', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.current_phase_name, 'Fresh Curated Name', '#3395\'s shape, now closed outside the write seam too');
    });

    // C1b — the report's own call-out: `status` is a MATERIALLY LARGER change
    // than the design's examples (which only used current_phase). Before D3,
    // status only fell back on the literal sentinel 'unknown'; now curated
    // wins over ANY disagreeing derived value, same as the other five fields.
    test('C1b: a real (non-"unknown") curated status wins over a disagreeing derived body Status in `state json`', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'status: verifying', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Executing', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.status,
        'verifying',
        'curated status must win over ANY disagreeing derived value now, not just the literal \'unknown\' sentinel',
      );
    });

    test('C2: derived empty, curated present — falls back, unchanged', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase: "5"', 'current_phase_name: Curated Name', 'current_plan: 05-02', '---', '',
        '# Project State', '', '## Current Position', '', '(nothing recognizable here)', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.current_phase, '5');
      assert.strictEqual(output.current_phase_name, 'Curated Name');
      assert.strictEqual(output.current_plan, '05-02');
    });

    // C3 — independence: `shouldPreserveExistingProgress`'s cross-milestone
    // rule is a DIFFERENT policy from the six empty-only/D3 guards and must
    // survive untouched. Exercised in the SAME `state json` call as one of
    // D3's new six fields, proving the two coexist without interference.
    test('C3: shouldPreserveExistingProgress cross-milestone progress preservation survives D3 untouched, alongside a D3-governed field', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'stopped_at: "curated stop must survive"',
        'progress:', '  total_phases: 3', '  completed_phases: 2', '  total_plans: 20', '  completed_plans: 18', '  percent: 90',
        '---', '', '# Project State', '', '## Session', '', '**Last session:** 2026-01-01', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.progress.completed_plans, 18, 'shouldPreserveExistingProgress must still preserve the higher curated count');
      assert.strictEqual(output.stopped_at, 'curated stop must survive', 'D3\'s new six-field policy must still fire in the same read');
    });

    test('C4: `state json` never writes — STATE.md is byte-identical before and after', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase_name: Fresh Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 3 (Stale Body Name)', '',
      ].join('\n');
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, content);
      const before = fs.readFileSync(statePath, 'utf8');

      const result = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(statePath, 'utf8');
      assert.strictEqual(after, before, '`state json` must never write STATE.md, even when D3\'s policy decides a value');
    });
  });

  // ─── Section D — the sanctioned exceptions: the regression wall for §8.3 ──
  // D4 (ratchet: exactly 2 sanctioned-permanent entries, not 0) is already
  // covered by tests/state-write-path-drift-guard.test.cjs's E6/E7/E8 (the
  // boundary triple 2/1/3) — not duplicated here.
  describe('Section D — the sanctioned exceptions (regression wall for §8.3)', () => {
    // D1 — consumer-level: `state sync` must still let a fresh body value win
    // over a stale-but-EMPTY-only-fallback-eligible curated frontmatter value
    // — proven here on a body that has NO annotation at all for six curated
    // fields, so only the gated `sanctionedPermanentEmptyFallback` fallback
    // (not the deleted-on-the-write-seam guards) can be keeping them alive.
    test('D1: `state sync` still restores all six curated fields (plus last_activity_desc) from a blank body — the sanctioned fallback must survive D1\'s guard deletion', (t) => {
      const tmp = createTempDir('gsd-3471-d1-');
      t.after(() => cleanup(tmp));
      const statePath = path.join(tmp, 'STATE.md');
      const original = [
        '---', 'gsd_state_version: 1.0',
        'current_phase: "5"', 'current_phase_name: Curated Name', 'current_plan: 05-02-plan',
        'stopped_at: Phase 5, curated stop', 'paused_at: Phase 5, curated pause',
        'last_activity_desc: curated activity desc',
        '---', '', '# Project State', '', '## Current Position', '', '## Session', '',
      ].join('\n');
      fs.writeFileSync(statePath, original);

      stateLib.writeStateMd(statePath, original, stateTransitionMod.rebuildStateTransaction({
        snapshot: frontmatterLib.extractFrontmatter(original),
      }), tmp);

      const onDisk = fs.readFileSync(statePath, 'utf8');
      const fm = frontmatterLib.extractFrontmatter(onDisk);
      assert.strictEqual(fm.current_phase, '5');
      assert.strictEqual(fm.current_phase_name, 'Curated Name');
      assert.strictEqual(fm.current_plan, '05-02-plan');
      assert.strictEqual(fm.stopped_at, 'Phase 5, curated stop');
      assert.strictEqual(fm.paused_at, 'Phase 5, curated pause');
      assert.strictEqual(fm.last_activity_desc, 'curated activity desc');
    });

    // D2 — identity: `state sync`'s output is pinned byte-for-byte (frozen
    // clock, per CONTRIBUTING's clock-seam rule — mirrors the existing
    // "ADR-3408 §8.3 Matrix A1/A2/A3" property test's own PINNED_MS pattern).
    // Empirically derived from the compiled lib before being hardcoded here.
    test('D2: `state sync` output is byte-identical for a fixed input under a frozen clock', (t) => {
      const PINNED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
      t.mock.timers.enable(['Date']);
      t.mock.timers.setTime(PINNED_MS);

      const tmp = createTempDir('gsd-3471-d2-');
      t.after(() => cleanup(tmp));
      const statePath = path.join(tmp, 'STATE.md');
      const original = [
        '---', 'gsd_state_version: 1.0',
        'current_phase: "5"', 'current_phase_name: Curated Name', 'current_plan: 05-02-plan',
        'stopped_at: Phase 5, curated stop', 'paused_at: Phase 5, curated pause',
        'last_activity_desc: curated activity desc',
        '---', '', '# Project State', '', '## Current Position', '', '## Session', '',
      ].join('\n');
      fs.writeFileSync(statePath, original);

      stateLib.writeStateMd(statePath, original, stateTransitionMod.rebuildStateTransaction({
        snapshot: frontmatterLib.extractFrontmatter(original),
      }), tmp);

      const expected = [
        '---', 'gsd_state_version: "1.0"', 'status: unknown', 'last_updated: "2023-11-14T22:13:20.000Z"',
        'stopped_at: Phase 5, curated stop', 'paused_at: Phase 5, curated pause',
        'current_phase: 5', 'current_phase_name: Curated Name', 'current_plan: 05-02-plan',
        'last_activity_desc: curated activity desc',
        '---', '', '# Project State', '', '## Current Position', '', '## Session', '',
      ].join('\n');
      assert.strictEqual(fs.readFileSync(statePath, 'utf8'), expected);
    });

    // D3 — REGENERATE_STATE's exact call shape (health-diagnostic.cts:328-337):
    // a wholly fresh `stateContent` with NO frontmatter block, passed to
    // `writeStateMd` — it never re-reads the OLD statePath's frontmatter, so
    // none of the discarded curated values can leak through, regardless of
    // `sanctionedPermanentEmptyFallback`.
    test('D3: REGENERATE_STATE\'s writeStateMd shape discards ALL prior curated values — factory reset, no preservation', (t) => {
      const tmp = createTempDir('gsd-3471-d3-');
      t.after(() => cleanup(tmp));
      const statePath = path.join(tmp, 'STATE.md');
      const oldCurated = [
        '---', 'gsd_state_version: 1.0', 'current_phase: "5"',
        'current_phase_name: Curated Name To Discard', 'stopped_at: should not survive regenerate',
        'paused_at: should not survive regenerate', 'current_plan: should not survive regenerate',
        '---', '', '# Project State', '',
      ].join('\n');
      fs.writeFileSync(statePath, oldCurated);

      // The regenerated content health-diagnostic.cts builds: no frontmatter
      // block at all.
      const regenerated = [
        '# Session State', '', '## Position', '',
        '**Current phase:** (determining...)', '**Status:** Resuming', '',
      ].join('\n');

      stateLib.writeStateMd(statePath, regenerated, stateTransitionMod.rebuildStateTransaction({
        snapshot: frontmatterLib.extractFrontmatter(oldCurated),
      }), tmp);

      const onDisk = fs.readFileSync(statePath, 'utf8');
      const fm = frontmatterLib.extractFrontmatter(onDisk);
      assert.notStrictEqual(fm.current_phase_name, 'Curated Name To Discard', 'the factory reset must discard the old curated name');
      assert.notStrictEqual(fm.stopped_at, 'should not survive regenerate');
      assert.notStrictEqual(fm.paused_at, 'should not survive regenerate');
      assert.notStrictEqual(fm.current_plan, 'should not survive regenerate');
    });
  });

  // ─── Section E — report reconciliation (D4 — §8.4's residue) ──────────────
  // E7 (cmdStatePatch, independence — fix(#3351) not regressed) is already
  // covered by the existing "#3351: state.patch report reconciled against
  // persisted STATE.md" describe block above — not duplicated here.
  describe('Section E — report reconciliation (D4)', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = createFixture(); });
    afterEach(() => { cleanup(tmpDir); });

    // MOVED under ADR-3473 §8.7 (#3872): `current_phase_name` genuinely round-
    // trips here — `syncStateFrontmatter` re-derives it from the (unchanged)
    // body `Phase:` line, finds nothing, and `applyPreserveWhenUnchanged`
    // restores the SAME curated snapshot value ("Curated Name") that was
    // already on disk before this write. §8.7's rule is literal: a field
    // appears in `updated`/`preserved` IFF its PERSISTED value differs from
    // the pre-write SNAPSHOT — verified at the CLI, `current_phase_name` is
    // `"Curated Name"` both before and after. The OLD assertion pinned the
    // PRIOR (`ADR-3408 §8.4`) mechanism this phase replaces: it folded in any
    // field `divergedFields` saw preservation touch MID-PIPELINE, regardless
    // of whether the net effect was a real change — exactly the shape #1264
    // already forbids for `progress` (row 12 of `40-design.md`'s behavior
    // table: "an identical restore is not a change"). This test is the same
    // rule for a `preserve-when-unchanged` field instead of `preserve-always`.
    test('E1: cmdStateUpdate — `updated` reflects the persisted change, and a field restored to its ORIGINAL value is not reported', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase_name: Curated Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Executing', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'update', 'Status', 'Verifying'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.updated, true);
      assert.deepStrictEqual(output.preserved, [], '`current_phase_name` round-trips to its ORIGINAL curated value ("Curated Name" before and after) — not a change under the §8.7 diff');
    });

    // MOVED under ADR-3473 §8.7 (#3872): `Current Position` — advancePlanCore
    // rewrites text INSIDE the `## Current Position` section (the Current
    // Plan line), so the section genuinely changed on disk. It was silently
    // dropped before this phase (the same "Current Position undercount"
    // class as row 27/#3818, generalized here beyond `plannedPhaseCore` —
    // `reconcileReportedFields`'s `valueOf` could not resolve the
    // WHOLE-SECTION field name against a single `Label: value` line, so
    // `intended !== null` never held).
    //
    // This fixture's frontmatter has no `progress` block at all, and
    // `syncStateFrontmatter`'s disk-derived resync (an empty `.planning/
    // phases/` from `createFixture`) materializes one — every leaf
    // (`total_plans` included: `advancePlanCore` never pushes it to its own
    // `reported` list, so it has no caller-attributable source here at all)
    // is the generalized provenance rule's case (2): a declared derived leaf
    // (`source: 'disk'`, state-transition.cts:136-140) appearing from a
    // source that did not change during this write is the scanner catching a
    // never-synced document up, not the caller's action — the SAME principle
    // `STATE_UPDATED_PROVENANCE_EXCLUSION` applies to `last_updated`,
    // generalized rather than special-cased per leaf. None of the four
    // `progress.*` leaves are reported here.
    test('E2: cmdStateAdvancePlan — `updated` names only the fields whose persisted value actually changed (happy path)', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', '---', '',
        '# Project State', '', '## Current Position', '', 'Current Plan: 1', 'Total Plans in Phase: 3', 'Status: Executing', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'advance-plan'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated.slice().sort(), ['Current Plan', 'Current Position', 'Status']);
    });

    // MOVED under ADR-3473 §8.7 (#3872). advance-plan NEVER touches the body
    // `Phase:` line (the comment below), so for THIS command
    // `current_phase`/`current_phase_name`'s body-source delta is
    // UNCONDITIONALLY unchanged — preservation restores the curated snapshot
    // back to itself, byte for byte ("99" / "Curated Stale Name" both
    // before and after, confirmed by the `fm.*` assertions below, which are
    // unchanged). Under §8.7's literal rule ("a field appears iff its
    // PERSISTED value differs from the snapshot") that is NOT a reportable
    // change — the same "identical restore" rule #1264 already established
    // for `progress` (design doc row 12), now applied to a
    // `preserve-when-unchanged` field. This test's ORIGINAL premise (#3345's
    // "genuinely restored, transform never touched" direction) cannot be
    // demonstrated via `advance-plan` at all, precisely BECAUSE this command
    // never perturbs the Phase-line delta — that direction is what row 8's
    // `reportsCurrentPhaseWhenTheWriteAdvancedIt` test (via
    // `state planned-phase`, which DOES rewrite the Phase line) now covers.
    test('E6: cmdStateAdvancePlan — a curated field restored to its ORIGINAL value is not reported (that direction is covered by row 8 instead)', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase: "99"', 'current_phase_name: Curated Stale Name', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 1 (Old Name)', 'Current Plan: 3', 'Total Plans in Phase: 3', 'Status: Executing', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'advance-plan'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(!output.updated.includes('Current Phase'), `'Current Phase' round-trips to its original value and must not be reported: ${JSON.stringify(output.updated)}`);
      assert.ok(!output.updated.includes('Current Phase Name'), `'Current Phase Name' round-trips to its original value and must not be reported: ${JSON.stringify(output.updated)}`);
      // Generalized provenance rule (same as E2 above): this fixture also
      // starts with no `progress` block, `advancePlanCore` never pushes
      // `progress.total_plans` to its own `reported` list, and the disk
      // scan materializing a fresh (zero-valued) `progress` block is the
      // scanner catching up, not this write's action — none of the four
      // leaves are reported.
      assert.deepStrictEqual(output.updated.slice().sort(), ['Current Position', 'Status']);

      const fm = frontmatterLib.extractFrontmatter(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'));
      assert.strictEqual(fm.current_phase, '99', 'the curated value must still survive the write even though it is not reported as a change');
      assert.strictEqual(fm.current_phase_name, 'Curated Stale Name');
    });

    // MOVED under ADR-3473 §8.7 (#3872): `Status` lives INSIDE `## Current
    // Position` in this fixture, and `beginPhaseCore` mutates that section
    // (writes the Phase/Status/Last-activity lines) — so the section text
    // genuinely changed on disk. Same generalized "Current Position
    // undercount" fix as E2/row 27: previously silently dropped by
    // `valueOf`'s inability to resolve a whole-section field name.
    test('E3: cmdStateBeginPhase — `updated` names only the fields whose persisted value actually changed (happy path)', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Not started', '', '## Session', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'begin-phase', '--phase', '2', '--name', 'Build', '--plans', '4'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated.slice().sort(), ['Current Position', 'Status']);
    });

    // MOVED under ADR-3473 §8.7 (#3872): `stopped_at` round-trips to its
    // ORIGINAL curated value ("curated stop must survive" before and after —
    // begin-phase never touches the `## Session` `Stopped at:` line) so it is
    // correctly EXCLUDED under the literal "persisted differs from snapshot"
    // rule (the same class as E1/E6). `Current Position` is added for the
    // same reason as E3 above.
    test('E3 (preservation): cmdStateBeginPhase — a curated field round-tripped to its ORIGINAL value is not reported', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'stopped_at: "curated stop must survive"', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Not started', '', '## Session', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'begin-phase', '--phase', '2', '--name', 'Build', '--plans', '4'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated.slice().sort(), ['Current Position', 'Status']);

      const fm = frontmatterLib.extractFrontmatter(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'));
      assert.strictEqual(fm.stopped_at, 'curated stop must survive', 'the curated value must still survive the write even though it is not reported as a change');
    });

    test('E4: cmdStateRecordSession — `updated` names only the fields whose persisted value actually changed (happy path)', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', '---', '',
        '# Project State', '', '## Session', '', '**Last session:** old', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Phase 1 complete'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated.slice().sort(), ['Last session', 'Stopped At']);
    });

    // MOVED under ADR-3473 §8.7 (#3872): `current_phase_name` round-trips to
    // its ORIGINAL curated value ("Curated Name" before and after —
    // record-session never touches the body `Phase:` line) so it is
    // correctly EXCLUDED under the literal "persisted differs from snapshot"
    // rule — the same class as E1/E6.
    test('E4 (preservation): cmdStateRecordSession — a curated field round-tripped to its ORIGINAL value is not reported', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'current_phase_name: Curated Name', '---', '',
        '# Project State', '', '## Session', '', '**Last session:** old', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Phase 1 complete'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated.slice().sort(), ['Last session', 'Stopped At']);

      const fm = frontmatterLib.extractFrontmatter(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'));
      assert.strictEqual(fm.current_phase_name, 'Curated Name', 'the curated value must still survive the write even though it is not reported as a change');
    });

    // E8 — untraced in the design's own analysis pass: cmdStatePlannedPhase
    // and cmdStateCompletePhase (the DIFFERENT legacy hand-rolled one) are
    // traced here rather than assumed, per the design's own instruction.
    //
    // MOVED under ADR-3473 §8.7 (#3872): this fixture's `## Current Position`
    // has no recognized labels for `plannedPhaseCore` (no `Phase:`/`Total
    // Plans in Phase:` line), so the transition is a documented no-op
    // (`plannedPhaseCore`'s own `updated: []` plus a "no recognized labels"
    // warning — confirmed at the CLI). `stopped_at` round-trips to its
    // ORIGINAL curated value the same way as E3(preservation)/E4(preservation)
    // above, so `updated` is correctly empty — nothing on disk actually
    // differs from the pre-write snapshot.
    test('E8a: cmdStatePlannedPhase reconciles the same way as cmdStateBeginPhase (traced, not assumed)', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'stopped_at: "curated stop must survive"', '---', '',
        '# Project State', '', '## Current Position', '', 'Status: Not started', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--name', 'Build', '--plans', '4'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.deepStrictEqual(output.updated, []);

      const fm = frontmatterLib.extractFrontmatter(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'));
      assert.strictEqual(fm.stopped_at, 'curated stop must survive', 'the curated value must still survive the write even though it is not reported as a change');
    });

    // E8b — cmdStateCompletePhase (the legacy hand-rolled path, NOT the
    // transitionCore-based one cmdPhaseComplete uses): its `updated` mixes
    // FIELD names with the SECTION name 'Current Position'. Reconciliation
    // must apply only to the field-shaped entries and pass 'Current Position'
    // through unconditionally, never dropping it as a false negative.
    //
    // MOVED under ADR-3473 §8.7 (#3872): `paused_at` round-trips to its
    // ORIGINAL curated value ("curated pause must survive" before and
    // after — this fixture has no `## Session` section at all, so
    // complete-phase's write never perturbs its body source) — the same
    // "identical restore is not a change" class as E1/E3(preservation)/
    // E4(preservation)/E6/E8a. `fm.paused_at` below still proves the VALUE
    // survives the write; it is simply no longer reported as an "update".
    test('E8b: cmdStateCompletePhase (legacy) reconciles field entries and passes the "Current Position" section entry through unconditionally', () => {
      const content = [
        '---', 'gsd_state_version: 1.0', 'paused_at: "curated pause must survive"', 'current_phase: 1', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 1', 'Status: Executing', 'Last activity: 2026-01-01', '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

      const result = runGsdTools(['state', 'complete-phase'], tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(output.updated.includes('Current Position'), 'the whole-section entry must not be dropped as a false negative by field-shaped reconciliation');
      assert.ok(!output.updated.includes('Paused At'), '"curated pause must survive" round-trips to its ORIGINAL value and must not be reported');

      const fm = frontmatterLib.extractFrontmatter(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'));
      assert.strictEqual(fm.paused_at, 'curated pause must survive');
    });
  });

  // ─── Required fast-check property: D3's copy really is gone ───────────────
  // For any (curated frontmatter value, body-source value) pair on one of the
  // six D3-governed fields, with the body delta held UNCHANGED (cmdStateJson
  // is a read, never a write, so its synthetic delta is definitionally
  // unchanged — {pre:v, post:v}) — the value the write seam would PERSIST
  // equals the value `state json` REPORTS for the identical document. Both
  // sides now dispatch through the exact same `applyPreserveWhenUnchanged`
  // executor (state-transition.cts), so this is the "D3's copy really is
  // gone" identity the matrix requires, at the consumer's output on both
  // sides (write: the real persisted file; read: the real `state json` CLI).
  // Seed pinned, runs bounded, replay data printed on failure, frozen clock
  // (Phase 2's property could never pass without this — `last_updated` moves
  // between the two invocations otherwise).
  describe('Required property: write-seam persistence and `state json` agree for the same document (D3)', () => {
    const FIELD_BODY = {
      current_phase: (v) => ({ section: '## Current Position', line: `Current Phase: ${v}` }),
      current_phase_name: (v) => ({ section: '## Current Position', line: `Phase: 1 (${v})` }),
      current_plan: (v) => ({ section: '## Current Position', line: `Current Plan: ${v}` }),
      stopped_at: (v) => ({ section: '## Session', line: `Stopped At: ${v}` }),
      paused_at: (v) => ({ section: '## Session', line: `Paused At: ${v}` }),
      status: (v) => ({ section: '## Current Position', line: `Status: ${v}` }),
    };

    function buildDoc(field, curated, derived) {
      const fmLines = ['gsd_state_version: 1.0'];
      if (curated !== null) fmLines.push(`${field}: ${JSON.stringify(curated)}`);
      const spec = derived !== null ? FIELD_BODY[field](derived) : null;
      const sections = spec
        ? [spec.section, '', spec.line, '']
        : ['## Current Position', '', '(no annotation)', ''];
      return ['---', ...fmLines, '---', '', '# Project State', '', ...sections].join('\n');
    }

    test('property: write-seam persisted value equals `state json` reported value', (t) => {
      const PINNED_MS = 1_700_000_000_000;
      t.mock.timers.enable(['Date']);
      t.mock.timers.setTime(PINNED_MS);

      const safeString = fc.array(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('')),
        { minLength: 1, maxLength: 12 },
      ).map((chars) => chars.join(''));

      fc.assert(
        fc.property(
          fc.constantFrom('current_phase', 'current_phase_name', 'current_plan', 'stopped_at', 'paused_at', 'status'),
          fc.option(safeString, { nil: null }),
          fc.option(safeString, { nil: null }),
          (field, curated, derived) => {
            const tmp = createFixture();
            t.after(() => cleanup(tmp));
            const statePath = path.join(tmp, '.planning', 'STATE.md');
            const content = buildDoc(field, curated, derived);
            fs.writeFileSync(statePath, content);

            // Write-side: syncAndPreserveStateMd with an UNCHANGED delta
            // (transformedContent === originalContent) — the same regime
            // cmdStateJson's synthetic {pre,post} delta represents.
            const written = stateLib.syncAndPreserveStateMd(content, content, statePath, tmp, { resync: false });
            const writeFm = frontmatterLib.extractFrontmatter(written);
            const writeVal = writeFm[field] !== undefined && writeFm[field] !== null ? String(writeFm[field]) : null;

            // Read-side: the real `state json` CLI, on the SAME on-disk document.
            const jsonResult = runGsdTools(['state', 'json'], tmp);
            if (!jsonResult.success) {
              throw new Error(`state json failed: field=${field} curated=${JSON.stringify(curated)} derived=${JSON.stringify(derived)}\n${jsonResult.error}`);
            }
            const readFm = JSON.parse(jsonResult.output);
            const readVal = readFm[field] !== undefined && readFm[field] !== null ? String(readFm[field]) : null;

            if (writeVal !== readVal) {
              throw new Error(
                `D3 copy divergence: field=${field} curated=${JSON.stringify(curated)} derived=${JSON.stringify(derived)}\n` +
                `write-seam persisted=${JSON.stringify(writeVal)} vs state-json reported=${JSON.stringify(readVal)}\n` +
                `document:\n${content}`,
              );
            }
            return true;
          },
        ),
        { seed: 3471, numRuns: 40 },
      );
    });
  });

  // ─── Parity: FRONTMATTER_KEY_TO_BODY_LABEL vs FIELD_CLASSIFICATION (#3471 review) ─
  // A second hand-maintained table beside FIELD_CLASSIFICATION is exactly the
  // "policy declared in one table, a second table beside it drifting quietly"
  // shape this epic exists to remove — CLAUDE.md's "Generative Fix
  // Divergence" entry requires a parity assertion for any two surfaces
  // sharing a constant. `bodyLabelFor` (state.cts) throws for a
  // preserve-when-unchanged field missing here (mirrors `throwUnwiredRow` in
  // state-transition.cts) rather than silently falling back to the raw
  // snake_case name — this test is what keeps that throw unreachable.
  describe('Parity: every preserve-when-unchanged row has a FRONTMATTER_KEY_TO_BODY_LABEL entry (#3471 review)', () => {
    test('FRONTMATTER_KEY_TO_BODY_LABEL has a label for every FIELD_CLASSIFICATION preserve-when-unchanged row', () => {
      const preserveWhenUnchangedFields = Object.keys(stateTransitionMod.FIELD_CLASSIFICATION)
        .filter((field) => stateTransitionMod.FIELD_CLASSIFICATION[field].preservation === 'preserve-when-unchanged');

      // Sanity: the table this test pins is non-empty — a passing loop over
      // zero fields would be a vacuous-truth false green (CLAUDE.md's Test
      // Cleanup rule).
      assert.ok(preserveWhenUnchangedFields.length > 0, 'expected at least one preserve-when-unchanged row to pin');

      const missing = preserveWhenUnchangedFields.filter(
        (field) => !Object.prototype.hasOwnProperty.call(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL, field),
      );
      assert.deepStrictEqual(missing, [], `preserve-when-unchanged field(s) with no body label, would hit bodyLabelFor's throw: ${JSON.stringify(missing)}`);
    });

    // Reverse direction: every label row IS a real field, and is either
    // preserve-when-unchanged (the contract this table documents) or absent
    // from FIELD_CLASSIFICATION entirely — never a preserve-always /
    // preserve-if-placeholder field masquerading with a stale label.
    test('every FRONTMATTER_KEY_TO_BODY_LABEL row is a preserve-when-unchanged FIELD_CLASSIFICATION field', () => {
      const wrongPolicy = Object.keys(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL).filter((field) => {
        const cls = stateTransitionMod.getFieldClassification(field);
        return cls !== null && cls.preservation !== 'preserve-when-unchanged';
      });
      assert.deepStrictEqual(wrongPolicy, [], `FRONTMATTER_KEY_TO_BODY_LABEL row(s) whose FIELD_CLASSIFICATION policy is not preserve-when-unchanged: ${JSON.stringify(wrongPolicy)}`);
    });
  });

  // ─── #3873 row 3: FRONTMATTER_KEY_TO_BODY_LABEL is now a byte-identical ──────
  // projection of STATE_FIELD_SCHEMA (src/state-md-schema.cts). Comparand is
  // today's literal copied VERBATIM (not re-derived from the schema — see
  // 50-test-matrix.md's "writer-seeded fixture trap" note), captured by direct
  // read of `src/state.cts` on this branch's base before the projection
  // replaced it.
  describe('ADR-3473 §8.8 (#3873): FRONTMATTER_KEY_TO_BODY_LABEL is a byte-identical projection', () => {
    // This exact key order — deliberately NOT the same order as
    // FRONTMATTER_BODY_SOURCE (state-transition.cts): the two pre-existing
    // tables disagreed with each other's order (status sits AFTER
    // stopped_at/paused_at here, BEFORE them there).
    const TODAYS_FRONTMATTER_KEY_TO_BODY_LABEL = Object.freeze({
      current_phase: 'Current Phase',
      current_phase_name: 'Current Phase Name',
      current_plan: 'Current Plan',
      stopped_at: 'Stopped At',
      paused_at: 'Paused At',
      status: 'Status',
      last_activity_desc: 'Last Activity Description',
    });

    test('bodyLabelProjectionMatchesTodaysTable', () => {
      assert.deepStrictEqual(
        Object.keys(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL),
        Object.keys(TODAYS_FRONTMATTER_KEY_TO_BODY_LABEL),
        'FRONTMATTER_KEY_TO_BODY_LABEL key order must be unchanged',
      );
      assert.deepStrictEqual(
        stateLib._FRONTMATTER_KEY_TO_BODY_LABEL,
        TODAYS_FRONTMATTER_KEY_TO_BODY_LABEL,
      );
      // Byte-identical also means NOT null-prototype: this table was a plain
      // `Object.freeze({...})` object literal before #3873 (unlike
      // FIELD_CLASSIFICATION / FRONTMATTER_BODY_SOURCE, which are
      // null-prototype), and the projection reproduces that exactly.
      assert.ok(Object.isFrozen(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL));
      assert.strictEqual(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL['toString'], Object.prototype.toString);
    });
  });

  // ─── #3873 pin: last_activity's TWO-TABLE disagreement, resolved by what SHIPS ──
  // `FRONTMATTER_BODY_SOURCE` (state-transition.cts) carries a `last_activity`
  // row; `FRONTMATTER_KEY_TO_BODY_LABEL` (state.cts, above) does not. ADR-3473
  // §8.8 / issue #3873 Phase 3 collapses both tables into one schema and must
  // declare a single answer for `last_activity` rather than picking whichever
  // table looks tidier. This test pins the OBSERVED behavior that ships
  // today, so the consolidation cannot silently change it.
  //
  // Observed: `last_activity`'s `FIELD_CLASSIFICATION` policy is
  // `{ source: 'body', preservation: 'derive' }` — NOT `preserve-when-unchanged`.
  // `bodyLabelFor` (state.cts) is only ever invoked, inside
  // `reconcileReportedFields`'s `divergedFields` loop, for fields whose
  // classification IS `preserve-when-unchanged` (every other field is
  // `continue`d past before `bodyLabelFor` is reached). Because
  // `last_activity` is `derive`, `bodyLabelFor('last_activity')` is
  // unreachable in production today: the field never surfaces a Title-Case
  // body label through that path, regardless of `FRONTMATTER_KEY_TO_BODY_LABEL`
  // lacking a row for it. Meanwhile `FRONTMATTER_BODY_SOURCE['last_activity']`
  // IS populated and IS live — it drives body-value reads for the frontmatter
  // key (`getFrontmatterBodySource`, `frontmatterKeyForBodyField`). The two
  // tables' disagreement is real, but only one of them is reachable for this
  // key today; a consolidated schema resolves `last_activity` as "has a body
  // SOURCE, has no reportable body LABEL" — matching what ships, not the
  // tidier "it should have a label too" answer.
  describe('#3873: last_activity label resolution matches shipped behavior', () => {
    test('lastActivityLabelResolutionMatchesShippedBehavior', () => {
      const cls = stateTransitionMod.getFieldClassification('last_activity');
      assert.deepStrictEqual(
        cls,
        { source: 'body', preservation: 'derive' },
        'last_activity must remain classified as derive (never preserve-when-unchanged) — ' +
          'this is what makes bodyLabelFor unreachable for it today',
      );

      const bodySource = stateTransitionMod.getFrontmatterBodySource('last_activity');
      assert.deepStrictEqual(
        bodySource,
        ['Last Activity', 'Last activity'],
        'FRONTMATTER_BODY_SOURCE must still carry a body source for last_activity',
      );

      const hasBodyLabel = Object.prototype.hasOwnProperty.call(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL, 'last_activity');
      assert.strictEqual(
        hasBodyLabel,
        false,
        'FRONTMATTER_KEY_TO_BODY_LABEL must NOT carry a last_activity row — the schema resolves ' +
          'the two-table disagreement by declaring "no reportable body label", matching today\'s ' +
          'shipped behavior (unreachable via bodyLabelFor because the field is derive, not ' +
          'preserve-when-unchanged), not by inventing one because FRONTMATTER_BODY_SOURCE has an entry',
      );
    });
  });
});

// ─── #3873 row 9: bodyLabelFor still throws STATE_BODY_LABEL_UNWIRED_ROW for ──
// an unwired preserve-when-unchanged row, now that FRONTMATTER_KEY_TO_BODY_LABEL
// (state.cts) is a projection of STATE_FIELD_SCHEMA (src/state-md-schema.cts)
// rather than a hand-maintained literal. Every real preserve-when-unchanged
// row is fully wired today (pinned by the parity tests above), so this test
// cannot reach the throw through a genuine schema key — it simulates the
// "future row added to FIELD_CLASSIFICATION without a matching label" case
// #3471 review names, by overriding getFieldClassification on the shared,
// cached module object for the duration of one test, restored via t.after()
// (never try/finally in the test body per repo convention).
describe('#3873 row 9: bodyLabelFor still throws for an unwired preserve-when-unchanged row', () => {
  test('unwiredLabelRowStillThrowsFromTheSchema', (t) => {
    const FAKE_FIELD = '__gsd_3873_unwired_probe__';
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL, FAKE_FIELD),
      false,
      'probe field name must not collide with a real label row',
    );

    const original = stateTransitionMod.getFieldClassification;
    t.after(() => {
      stateTransitionMod.getFieldClassification = original;
    });
    stateTransitionMod.getFieldClassification = (field) =>
      (field === FAKE_FIELD
        ? { source: 'body', preservation: 'preserve-when-unchanged' }
        : original(field));

    assert.throws(
      () => stateLib._bodyLabelFor(FAKE_FIELD),
      (err) => {
        assert.strictEqual(err.code, 'STATE_BODY_LABEL_UNWIRED_ROW');
        assert.strictEqual(err.field, FAKE_FIELD);
        return true;
      },
    );
  });
});

// ─── #3873 row 29 (property): every projection agrees with its schema row ───
// For every STATE_FIELD_SCHEMA row, each of the three derived tables either
// omits the key entirely or agrees with that row's corresponding value —
// the bijective contract CLAUDE.md's property-test rule requires for a
// consolidation like this one. fast-check v4: the arbitrary is declared
// INSIDE the property (a describe-body arbitrary kills the whole block), the
// seed is pinned and numRuns bounded for a deterministic, bounded run, and a
// failure re-throws with the seed spelled out so it names its own replay.
describe('#3873 row 29 (property): every projection agrees with its schema row', () => {
  test('everyProjectionAgreesWithItsSchemaRow', () => {
    const { STATE_FIELD_SCHEMA } = require('../gsd-core/bin/lib/state-md-schema.cjs');
    const schemaKeys = Object.keys(STATE_FIELD_SCHEMA);
    // Sanity: a property over zero keys would pass vacuously (CLAUDE.md's
    // Test Cleanup rule against vacuous-truth tests).
    assert.ok(schemaKeys.length > 0, 'STATE_FIELD_SCHEMA must be non-empty for this property to be meaningful');

    const SEED = 38730029;
    try {
      fc.assert(
        fc.property(fc.constantFrom(...schemaKeys), (key) => {
          const row = STATE_FIELD_SCHEMA[key];

          if (Object.prototype.hasOwnProperty.call(stateTransitionMod.FIELD_CLASSIFICATION, key)) {
            const cls = stateTransitionMod.FIELD_CLASSIFICATION[key];
            assert.strictEqual(cls.source, row.source, `FIELD_CLASSIFICATION[${key}].source disagrees with schema`);
            assert.strictEqual(cls.preservation, row.preservation, `FIELD_CLASSIFICATION[${key}].preservation disagrees with schema`);
            assert.strictEqual(cls.guard, row.guard, `FIELD_CLASSIFICATION[${key}].guard disagrees with schema`);
            assert.strictEqual(cls.mergeStrategy, row.mergeStrategy, `FIELD_CLASSIFICATION[${key}].mergeStrategy disagrees with schema`);
          }
          if (Object.prototype.hasOwnProperty.call(stateTransitionMod.FRONTMATTER_BODY_SOURCE, key)) {
            assert.deepStrictEqual(
              Array.from(stateTransitionMod.FRONTMATTER_BODY_SOURCE[key]),
              Array.from(row.bodySource || []),
              `FRONTMATTER_BODY_SOURCE[${key}] disagrees with schema`,
            );
          }
          if (Object.prototype.hasOwnProperty.call(stateLib._FRONTMATTER_KEY_TO_BODY_LABEL, key)) {
            assert.strictEqual(
              stateLib._FRONTMATTER_KEY_TO_BODY_LABEL[key],
              row.bodyLabel,
              `FRONTMATTER_KEY_TO_BODY_LABEL[${key}] disagrees with schema`,
            );
          }
          return true;
        }),
        { seed: SEED, numRuns: 200 },
      );
    } catch (err) {
      throw new Error(`everyProjectionAgreesWithItsSchemaRow failed (seed=${SEED} — replay: fc.assert(..., { seed: ${SEED} })): ${err.message}`, { cause: err });
    }
  });
});

// ─── #3873 phase-3 row 26: statusEnumIsExactlyTheLifecycleSet ──────────────
// CORRECTED contract (verified by executing `normalizeStateStatus`, not by
// reading `STATUS_LIFECYCLE_ENUM`'s prior docstring claim): the enum's seven
// members are the values the normalizer maps recognized input TO — they are
// NOT a runtime-enforced closed set for the `status` key. `normalizeStateStatus`
// (`src/state-document.cts`) is deliberately lenient: its fallback is
// `status || 'unknown'`, so an input matching none of its substring branches
// passes straight through, unrejected and uncoerced. This test asserts the
// real, non-vacuous contract that IS true: every canonical value normalizes
// to itself, and an unrecognized value passes through unchanged — it does
// not assert a closure the normalizer does not enforce.
describe('#3873 phase-3 row 26: status enum matches the real normalizer contract', () => {
  test('statusEnumIsExactlyTheLifecycleSet', () => {
    const { STATUS_LIFECYCLE_ENUM } = require('../gsd-core/bin/lib/state-md-schema.cjs');
    const { normalizeStateStatus } = require('../gsd-core/bin/lib/state-document.cjs');

    assert.ok(STATUS_LIFECYCLE_ENUM.length > 0, 'STATUS_LIFECYCLE_ENUM must be non-empty for this test to be meaningful');

    for (const member of STATUS_LIFECYCLE_ENUM) {
      assert.strictEqual(
        normalizeStateStatus(member, null),
        member,
        `canonical value ${JSON.stringify(member)} must normalize to itself`,
      );
    }

    // A non-member is NOT rejected or coerced — it passes through unchanged,
    // because the normalizer is lenient, not closed.
    const nonMember = 'totally-unrecognized-status-text';
    assert.ok(!STATUS_LIFECYCLE_ENUM.includes(nonMember), 'probe value must genuinely be a non-member');
    assert.strictEqual(
      normalizeStateStatus(nonMember, null),
      nonMember,
      'an unrecognized status value must pass through unchanged, not be coerced into the enum',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2444: stopped_at frontmatter must not be overwritten by historical body prose
// ─────────────────────────────────────────────────────────────────────────────

describe('stopped_at frontmatter not overwritten by historical prose (bug #2444)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves correct stopped_at frontmatter when historical plain-text match appears before Session section', () => {
    // The bug: body has plain "Stopped at:" in old notes (no bold) — stateExtractField
    // uses a plain ^Stopped at:\s*(.+) pattern with /im which matches the first line,
    // returning the stale historical value. syncStateFrontmatter has no preservation
    // step for stopped_at like cmdStateJson does, so it overwrites the correct value.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
stopped_at: Phase 3, Plan 2 — current correct value
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Previous Session Notes

Stopped at: Phase 5 complete — v1.0 shipped (OLD stale historical note)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 2 — current correct value
`
    );

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // The correct frontmatter value must survive the sync
    assert.ok(
      stateContent.includes('Phase 3, Plan 2 — current correct value'),
      'stopped_at must retain the correct value from the ## Session section'
    );
    assert.ok(
      !stateContent.includes('stopped_at: Phase 5 complete'),
      'stopped_at must NOT be overwritten with the old historical note'
    );
  });

  test('state sync does not promote stale body prose to stopped_at frontmatter when frontmatter has no stopped_at', () => {
    // No existing stopped_at in frontmatter, body has plain Stopped at: in
    // a historical notes section appearing BEFORE the real ## Session entry.
    // buildStateFrontmatter should scope extraction to ## Session section, not
    // match the first occurrence anywhere in the body.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Old Notes

Stopped at: Phase 5 complete — v1.0 STALE (should never land in frontmatter)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 1 — real current value
`
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.strictEqual(output.stopped_at, 'Phase 3, Plan 1 — real current value',
      'stopped_at must be extracted from ## Session section, not the first plain-text match in the body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2567: current-state field extraction must be scoped so historical body
// prose in archive sections cannot overwrite frontmatter. Same divergence
// class as #2444 (which scoped Stopped At to ## Session): the #2444 fix did
// not propagate to Last Activity, Last Activity Description, Paused At, and
// the other current-state fields. These pin the scoped-extraction contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('last_activity / paused_at frontmatter not overwritten by historical prose (bug #2567)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Extract the YAML frontmatter block (between the --- fences) so assertions
  // target the frontmatter only, not field-shaped prose elsewhere in the body.
  function frontmatterBlock(stateContent) {
    const m = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : '';
  }

  test('state sync does not let a stale archive "Last activity:" leak into the last_activity frontmatter', () => {
    // The issue's repro: frontmatter holds the current value; the body has NO
    // current Last Activity line (only frontmatter does), but an archive
    // section further down contains a stale "Last activity:" line. Before the
    // fix, buildStateFrontmatter extracted the stale body value and overwrote
    // the correct frontmatter value on every sync. (state sync may also touch
    // the body's Last Activity line via syncCore; the assertion is therefore
    // on the frontmatter block specifically, and checks the stale value never
    // lands there regardless of any date mutation.)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "last_activity: '2026-07-23'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Previous Notes',
        '',
        'Last activity: 2026-06-20 - some older task',
        '',
        '## Session',
        '',
        'Last Date: 2026-07-22',
        'Stopped At: Phase 3, Plan 2 — current',
        '',
      ].join('\n')
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterBlock(stateContent);

    assert.ok(/last_activity:/.test(fm),
      'last_activity must remain in frontmatter after sync');
    assert.ok(!/last_activity:[^\n]*2026-06-20/.test(fm),
      `stale archive value must not leak into frontmatter; frontmatter was:\n${fm}`);
  });

  test('state sync does not let a stale archive "Paused At:" leak into the paused_at frontmatter', () => {
    // Paused At is a session field: scope to ## Session (same treatment as
    // Stopped At under #2444). A stale Paused At in an archive section that
    // appears BEFORE ## Session must not win over the current value.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "paused_at: '2026-07-22'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Old Session Notes',
        '',
        'Paused At: 2026-06-15 - old pause',
        '',
        '## Session',
        '',
        'Last Date: 2026-07-22',
        'Paused At: 2026-07-22',
        '',
      ].join('\n')
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterBlock(stateContent);

    assert.ok(!/paused_at:[^\n]*2026-06-15/.test(fm),
      `stale archive paused_at must not leak into frontmatter; frontmatter was:\n${fm}`);
    assert.ok(/paused_at:[^\n]*2026-07-22/.test(fm),
      `paused_at must retain the ## Session value (2026-07-22); frontmatter was:\n${fm}`);
  });

  test('state json surfaces the preserved last_activity, not undefined, when the body preamble lacks the field', () => {
    // Read-path guard for #2567 + the cmdStateJson preserve fix: when the body
    // preamble has no Last Activity (only the frontmatter holds it and the
    // body's sole copy is a stale archive line), `state json` must surface the
    // preserved frontmatter value, not undefined. Uses `state json` directly
    // (no preceding sync) so the frontmatter value is deterministic.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "last_activity: '2026-07-23'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Archive',
        '',
        'Last activity: 2026-06-20 - older',
        '',
      ].join('\n')
    );

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const parsed = JSON.parse(jsonResult.output);

    assert.strictEqual(parsed.last_activity, '2026-07-23',
      `state json must surface the preserved frontmatter last_activity (2026-07-23) but got ${parsed.last_activity}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3258: the FIELD_CLASSIFICATION preserve-when-unchanged rows for the Group 2
// fields (paused_at, current_phase, current_plan) are now honored by
// applyStatePreservation. Before the fix the only protection was the weaker
// #905 absent-fallback in syncStateFrontmatter, which restores a field ONLY when
// the derived value is falsy/absent — so a stale-but-present body value won
// over a curated frontmatter value on every body-only write. These pin the
// declared semantics end-to-end through the CLI: an unrelated `state update`
// (which does NOT touch the Group 2 body source) must leave the curated
// frontmatter values intact.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3258: Group 2 preserve-when-unchanged beats the weaker absent-fallback (paused_at / current_phase / current_plan)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function frontmatterBlock(stateContent) {
    const m = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : '';
  }

  // STATE.md with curated frontmatter values and stale-but-present body values
  // for all three Group 2 fields. A body-only write that does not touch any of
  // them must NOT let the stale derived value win.
  function writeGroup2Fixture() {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        "current_phase: '4'",
        "current_plan: '5'",
        "paused_at: '2026-02-02'",
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 2',
        '**Current Plan:** 3',
        '**Status:** In progress',
        '',
        '## Current Position',
        'Phase: 2',
        'Plan: 3',
        'Status: In progress',
        '',
        '## Session',
        '',
        'Last Date: 2026-02-01',
        'Paused At: 2026-01-01',
        '',
      ].join('\n'),
    );
  }

  test('paused_at: curated frontmatter value survives a body-only write that leaves the body source unchanged', () => {
    writeGroup2Fixture();
    // `state update` on Status is a body-only RMW write (resync=false) that does
    // NOT touch the Paused At body source. The stale body value (2026-01-01)
    // must not overwrite the curated frontmatter value (2026-02-02).
    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(/paused_at:[^\n]*2026-02-02/.test(fm),
      `paused_at must keep the curated value (2026-02-02); frontmatter was:\n${fm}`);
    assert.ok(!/paused_at:[^\n]*2026-01-01/.test(fm),
      `stale body-derived paused_at (2026-01-01) must not win; frontmatter was:\n${fm}`);
  });

  test('current_plan: curated frontmatter value survives a body-only write that leaves the body source unchanged', () => {
    writeGroup2Fixture();
    runGsdTools('state update Status "Executing"', tmpDir);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(/current_plan:[^\n]*5/.test(fm),
      `current_plan must keep the curated value (5); frontmatter was:\n${fm}`);
    assert.ok(!/current_plan:[^\n]*3\b/.test(fm),
      `stale body-derived current_plan (3) must not win; frontmatter was:\n${fm}`);
  });

  test('current_phase: curated frontmatter value survives a body-only write that leaves the body source unchanged', () => {
    writeGroup2Fixture();
    runGsdTools('state update Status "Executing"', tmpDir);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(/current_phase:[^\n]*4/.test(fm),
      `current_phase must keep the curated value (4); frontmatter was:\n${fm}`);
    assert.ok(!/current_phase:[^\n]*2\b/.test(fm),
      `stale body-derived current_phase (2) must not win; frontmatter was:\n${fm}`);
  });

  test('Group 2 fields still re-derive when the body source actually changes (no over-preservation)', () => {
    // When the transform DOES change the body source, the derived value must
    // win — preserve-when-unchanged must not freeze a field that a transition
    // intentionally moved. Drive it via `state update "Current Plan"`.
    writeGroup2Fixture();
    const result = runGsdTools('state update "Current Plan" "7"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const fm = frontmatterBlock(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'));
    assert.ok(/current_plan:[^\n]*7/.test(fm),
      `current_plan must take the new body value (7) when the body source changed; frontmatter was:\n${fm}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2445: stale phase dirs from closed milestone inflate phase counts
// ─────────────────────────────────────────────────────────────────────────────

describe('stale phase dirs do not corrupt phase counts (bug #2445)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json excludes stale prior-milestone phase dirs from phase count when ROADMAP scopes current milestone', () => {
    // Old milestone had phases 1-5; new milestone starts fresh with phases 1-2.
    // Stale dirs for old phases 3, 4, 5 remain in .planning/phases/ and must be
    // excluded by getMilestonePhaseFilter (new ROADMAP only lists phases 1 and 2).
    // Old phases 1 and 2 dirs are ambiguous (same number reused) but phase 3-5 dirs
    // must not inflate total_phases beyond the ROADMAP's phaseCount of 2.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Old Milestone (Shipped)</summary>',
        '',
        '## Roadmap v1.0: Old Milestone',
        '### Phase 1: Old Foundation',
        '### Phase 2: Old API',
        '### Phase 3: Old Deploy',
        '### Phase 4: Old Polish',
        '### Phase 5: Old Wrap',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New Milestone',
        '### Phase 1: New Foundation',
        '### Phase 2: New API',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    // Create stale v1.0 phase dirs 3, 4, 5 — these are NOT in the new ROADMAP
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['03-old-deploy', '04-old-polish', '05-old-wrap']) {
      const d = path.join(phasesDir, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${dir.slice(0, 2)}-01-PLAN.md`), '# stale plan\n');
    }

    // New milestone has only Phase 1 started so far
    const newPhaseDir = path.join(phasesDir, '01-new-foundation');
    fs.mkdirSync(newPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(newPhaseDir, '01-01-PLAN.md'), '# new plan\n');

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // total_phases must be bounded by the ROADMAP's 2 phases, not 4 total dirs
    // (the 3 stale dirs for phases 3-5 must be excluded by the milestone filter)
    assert.ok(
      output.progress && output.progress.total_phases <= 2,
      `total_phases should be ≤ 2 (new milestone phases 1-2 only), got ${output.progress?.total_phases}`
    );
    // total_plans must only count plans from current-milestone phase dirs
    assert.ok(
      output.progress && output.progress.total_plans <= 1,
      `total_plans should be 1 (only new phase 1 dir), got ${output.progress?.total_plans}`
    );
  });

  test('init new-milestone phase_dir_count excludes stale prior-milestone dirs', () => {
    // ROADMAP scoped to v2.0 with 2 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Shipped</summary>',
        '',
        '## Roadmap v1.0: Old',
        '### Phase 1: Old One',
        '### Phase 2: Old Two',
        '### Phase 3: Old Three',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New',
        '### Phase 1: New One',
        '### Phase 2: New Two',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Status:** Planning\n'
    );

    // Three stale phase dirs from the old milestone
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['01-old-one', '02-old-two', '03-old-three']) {
      fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
    }

    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // phase_dir_count should not include stale dirs from the old milestone
    assert.ok(
      output.phase_dir_count <= 2,
      `phase_dir_count should be ≤ 2 (only new-milestone dirs), got ${output.phase_dir_count}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state complete-phase: Phase-fallback decoration handling (PR #2761 nitpick)
// ─────────────────────────────────────────────────────────────────────────────
//
// When STATE.md is missing the canonical `**Current Phase:**` field but
// includes a decorated `## Current Position` body line, the fallback path used
// to leak the decoration into downstream Status/Phase strings — producing
// `**Status:** Phase 01 (Foo) — EXECUTING complete` instead of the expected
// `**Status:** Phase 01 complete`. CodeRabbit flagged this on PR #2761 and the
// Phase fallback now strips everything past the leading numeric/decimal token.
describe('state complete-phase: decorated Phase fallback (#2761 nitpick)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes clean Phase identifier when only Current Position decoration is present', () => {
    // STATE.md without the canonical `**Current Phase:**` field — the only
    // phase signal lives inside the `## Current Position` block as a decorated
    // line. This is the regression fixture.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      'Plan: bootstrap',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    // Status should reference the bare phase identifier (`01`), not the
    // decorated string. The negative assertion catches the regression
    // shape directly.
    assert.ok(
      updated.includes('**Status:** Phase 01 complete'),
      `Status should be "Phase 01 complete", got STATE.md:\n${updated}`,
    );
    assert.ok(
      !updated.includes('Phase 01 (Foo) — EXECUTING complete'),
      `Status must not embed Current Position decoration: ${updated}`,
    );
  });

  test('canonical Current Phase field is preferred over Current Position decoration', () => {
    // When both are present, Current Phase wins — same outcome as before, but
    // pinned here so a future refactor that flips precedence is caught.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Current Phase:** 03',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      updated.includes('**Status:** Phase 03 complete'),
      `Status should reference canonical Current Phase (03), got: ${updated}`,
    );
  });

  test('rejects unresolved literal Phase token and does not corrupt STATE.md (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, 'command should return JSON error payload, not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected clear resolution error');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!after.includes('Phase: Phase — COMPLETE'));
    assert.ok(!after.includes('Status: Phase Phase complete'));
  });

  test('rejects a milestone-closure Phase line, never mines the version token (#2111 / #2125)', () => {
    // After `milestone complete v0.5`, the only phase signal is the narrative
    // `Phase: Milestone v0.5 complete`. The old unanchored resolver mined "0.5"
    // and rewrote Status as "Phase 0.5 complete"; the anchored parser yields no
    // token, so complete-phase must reject rather than corrupt STATE.md.
    const stateMd = [
      '---',
      'milestone: v0.5',
      '---',
      '',
      '# State',
      '',
      '**Status:** Awaiting next milestone',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: Milestone v0.5 complete',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, 'command should return JSON error payload, not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected a resolution error, not a phase mined from the version string');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!after.includes('Phase 0.5 complete'), `must not mine "0.5" from the version: ${after}`);
    assert.ok(!after.includes('Phase: 0.5'), `must not rewrite Current Position to Phase 0.5: ${after}`);
  });

  test('supports explicit phase override for complete-phase disambiguation (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase --phase 3.3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Status:** Phase 3.3 complete'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summary-extract command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// state add-roadmap-evolution (regression: bug #1140)
//
// `query state.add-roadmap-evolution` was unreachable: the CJS state router
// listed it in its `unsupported` map with a message pointing back at the exact
// command that just failed ("...is SDK-only. Use: gsd-tools query
// state.add-roadmap-evolution ..."), and no CJS handler existed after the SDK
// retirement (ADR-0174). Every `/gsd:phase insert` and `/gsd:phase --edit` run
// hit a circular dead end. The fix re-implements `cmdStateAddRoadmapEvolution`
// in CJS and wires it into the state router. These cases follow the CLI/parser
// QA matrix in CONTRIBUTING.md (all invocations use argv arrays, no shell).
// ─────────────────────────────────────────────────────────────────────────────
describe('state add-roadmap-evolution (bug #1140)', () => {
  let tmpDir;

  const STATE_WITH_ACC_CONTEXT = `# Project State

## Current Status

**Current Phase:** 103.1

## Accumulated Context

### Decisions

- Some earlier decision
`;

  const writeState = (dir, body) => fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), body);
  const readState = (dir) => fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf-8');
  // Body of `## Accumulated Context` bounded by the next h2 (or EOF), so
  // placement assertions prove a subsection sits INSIDE that section.
  const accumulatedContextBody = (state) => {
    const m = sectionMatchOf(state, 'Accumulated Context');
    return m ? m[1] : null;
  };

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The literal issue repro: negative proof the circular dead end is gone.
  test('query state.add-roadmap-evolution no longer routes to the circular SDK-only rejection', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['query', 'state.add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'test', '--urgent'],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(
      !/SDK-only/i.test(result.output) && !/SDK-only/i.test(result.error || ''),
      `must not emit the circular "SDK-only" rejection; got output=${result.output} error=${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true);
    assert.match(parsed.entry, /\(URGENT\)$/);
  });

  test('appends an entry, creating the ### Roadmap Evolution subsection under ## Accumulated Context', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'Add OAuth login', '--urgent'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(
      state.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'),
      `entry not found in:\n${state}`
    );
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection must not be duplicated');
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('### Roadmap Evolution'), 'subsection must be inside Accumulated Context');
    assert.ok(accBody.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- Some earlier decision'), 'existing content preserved');
  });

  test('omitting --urgent and --after produces a plain entry', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'edited',
        '--note', 'edited fields: goal, depends_on'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 103.2 edited: edited fields: goal, depends_on'), `missing entry:\n${state}`);
    assert.ok(!/\(URGENT\)/.test(state), 'no URGENT suffix when --urgent absent');
  });

  test('creates ### Roadmap Evolution when ## Accumulated Context exists without it', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Next Steps

- do the thing
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'caching layer'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('### Roadmap Evolution'), 'subsection created');
    assert.ok(state.includes('- Phase 4 added: caching layer'), 'entry appended');
    const subIdx = state.indexOf('### Roadmap Evolution');
    const nextIdx = state.indexOf('## Next Steps');
    assert.ok(subIdx !== -1 && nextIdx !== -1 && subIdx < nextIdx, 'subsection must be inside Accumulated Context');
    assert.ok(state.includes('- do the thing'), 'sibling section preserved');
  });

  test('creates both ## Accumulated Context and ### Roadmap Evolution when neither exists', () => {
    writeState(tmpDir, `# Project State

## Current Status

**Current Phase:** 1
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'inserted', '--after', '1', '--note', 'bootstrap'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).added, true);

    const state = readState(tmpDir);
    assert.strictEqual((state.match(/^## Accumulated Context$/gm) || []).length, 1, 'Accumulated Context created once');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection created once');
    assert.ok(state.includes('- Phase 2 inserted after Phase 1: bootstrap'), 'entry appended');
  });

  test('targets the subsection under Accumulated Context, never a decoy heading elsewhere', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Reference Notes

### Roadmap Evolution

- DECOY entry that must never be touched
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '8', '--action', 'inserted', '--note', 'real entry'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('- Phase 8 inserted: real entry'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- DECOY entry that must never be touched'), 'decoy preserved');
    assert.ok(!accBody.includes('DECOY'), 'decoy must not be pulled into Accumulated Context');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 2, 'a new subsection is created under Accumulated Context; decoy heading remains');
  });

  test('flattens a multiline note into a single bullet so dedupe and rendering hold', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const notePath = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(notePath, 'line one\nline two\nline three\n');

    const first = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.ok(first.success, `Command failed: ${first.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 9 edited: line one line two line three'), `note not flattened:\n${state}`);
    assert.ok(!/\r?\n\s*line two/.test(state), 'continuation lines must not spill outside the bullet');

    const second = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.strictEqual(JSON.parse(second.output).reason, 'duplicate', 'flattened entry must dedupe on replay');
  });

  test('deduplicates an identical entry on replay', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const args = ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'inserted',
      '--after', '103.1', '--note', 'Add OAuth login', '--urgent'];

    const first = runGsdTools(args, tmpDir);
    assert.ok(first.success, `first call failed: ${first.error}`);
    assert.strictEqual(JSON.parse(first.output).added, true);

    const second = runGsdTools(args, tmpDir);
    assert.ok(second.success, `second call failed: ${second.error}`);
    const parsed = JSON.parse(second.output);
    assert.strictEqual(parsed.added, false, 'replay must not add');
    assert.strictEqual(parsed.reason, 'duplicate');

    const state = readState(tmpDir);
    const occurrences = (state.match(/- Phase 103\.2 inserted after Phase 103\.1: Add OAuth login \(URGENT\)/g) || []).length;
    assert.strictEqual(occurrences, 1, 'entry must appear exactly once after replay');
  });

  test('CRLF STATE.md: appends under Accumulated Context while preserving later sections', () => {
    const crlf = [
      '# Project State', '',
      '## Accumulated Context', '',
      '### Decisions', '',
      '- prior decision', '',
      '## Blockers', '',
      '- keep me', '',
      '## History', '',
      '- also keep me', '',
    ].join('\r\n');
    writeState(tmpDir, crlf);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'inserted', '--note', 'crlf safe'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('## Blockers'), '## Blockers must be preserved');
    assert.strictEqual((state.match(/^## Blockers/gm) || []).length, 1, '## Blockers not duplicated/corrupted');
    assert.ok(state.includes('- keep me'), 'Blockers content must be preserved');
    assert.ok(state.includes('## History'), '## History must be preserved');
    assert.ok(state.includes('- also keep me'), 'History content must be preserved');
    assert.ok(/### Roadmap Evolution/.test(state), 'subsection created');
    assert.ok(/- Phase 4 inserted: crlf safe/.test(state), 'entry appended');
  });

  test('missing --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /note required/, 'should report the missing-note error');
    assert.ok(!/"added"\s*:\s*true/.test(result.output), 'must not report added:true');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace in failure output');
    assert.strictEqual(readState(tmpDir), before, 'STATE.md not mutated on missing note');
  });

  test('empty --note "" is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', ''], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for empty note');
  });

  test('whitespace-only --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', '   '], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for whitespace-only note');
  });

  test('--note followed by a flag-shaped token is treated as missing note', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--note', '--weird'], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'flag-shaped value must not be consumed as the note');
  });

  test('duplicate --phase flags do not crash; first value wins', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '7', '--phase', '9', '--action', 'inserted', '--note', 'dup flags'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 7 inserted: dup flags'), `expected phase 7 entry:\n${state}`);
    assert.ok(!state.includes('Phase 9'), 'second --phase value must not be used');
  });

  test('shell metacharacters in --note are stored literally, never executed', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    // Probe path lives under the test's tmpDir (no hardcoded /tmp literal, which
    // the Windows-parity guard forbids). If command substitution executed, this
    // file would exist afterward.
    const probe = path.join(tmpDir, 'gsd-pwn-1140');
    const hostile = `pwn $(touch ${probe}) \`id\` ; rm -rf / && echo done`;
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', hostile],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes(hostile), 'hostile note must be stored verbatim');
    assert.ok(!fs.existsSync(probe), 'command substitution must not have executed');
  });

  test('Unicode note content is preserved', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const note = 'café — 日本語 — 🚀 reroute';
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'edited', '--note', note],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(readState(tmpDir).includes(note), 'Unicode preserved');
  });

  test('missing STATE.md returns a structured error, not a crash', () => {
    // Guarantee STATE.md is absent (force: no-op if the fixture didn't create one).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- deleting a single fixture file to simulate the missing-STATE.md case, not a temp-dir teardown
    fs.rmSync(path.join(tmpDir, '.planning', 'STATE.md'), { force: true });

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', 'x'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /STATE\.md not found/, 'should report STATE.md not found');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regressions: table-format STATE.md (#1162)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal STATE.md that uses a pipe-table for the Current Position section.
 * This is the format that triggered the "Field not found" silent failure.
 */
function buildTableFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
    planCount = '4',
    lastActivity = '2026-01-01',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${status} |`,
    `| Phase | ${phase} |`,
    `| Total Plans in Phase | ${planCount} |`,
    `| Last Activity | ${lastActivity} |`,
    '',
    '## Accumulated Context',
    '',
    'Some context here.',
    '',
  ].join('\n');
}

/**
 * STATE.md that uses bold inline format (the existing working format).
 * Included as a control case to confirm we did not break bold-field support.
 */
function buildBoldFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Status:** ${status}`,
    `**Phase:** ${phase}`,
    '',
  ].join('\n');
}

describe('regressions: table-format STATE.md (#1162)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Happy path: table-format field replacement ──────────────────────────

  test('state update rewrites table-cell Status value', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    // Command must report success
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true but got: ' + JSON.stringify(parsed));

    // The table cell must be rewritten on disk
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Table cell not rewritten. STATE.md content:\n' + written,
    );
    // Original value must be gone
    assert.ok(
      !written.includes('| Status | Ready to plan |'),
      'Old table cell value still present in STATE.md',
    );
  });

  test('state update rewrites table-cell value for arbitrary field', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ lastActivity: '2026-01-01' }));

    const result = runGsdTools(['state', 'update', 'Last Activity', '2026-06-13'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-06-13 |'),
      'Last Activity table cell not rewritten. Content:\n' + written,
    );
  });

  test('state update is case-insensitive for table field names', () => {
    // Table may have lowercase "status" in the first cell
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| status | Ready to plan |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'case-insensitive table match failed');
  });

  // ── Negative: separator row must NOT be treated as a field ───────────────

  test('separator row | --- | --- | is not matched as a field', () => {
    // The field name "---" is rejected by the field-name validator before
    // stateReplaceField is even called.  The command exits with a non-zero
    // status and a plain-text error, NOT a JSON { updated: false } result.
    // The key invariant is that the file is never corrupted.
    const originalContent = buildTableFormatState();
    fs.writeFileSync(statePath, originalContent);

    const result = runGsdTools(['state', 'update', '---', 'injected'], tmpDir);

    // The validator rejects '---' as an invalid field name — command must fail
    // OR, if somehow the command succeeds, updated must be false.
    if (result.success) {
      // Unlikely path — if the validator is relaxed in future, still must not update.
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { parsed = null; }
      if (parsed) {
        assert.equal(parsed.updated, false, 'separator row incorrectly matched as a field');
      }
    }
    // Either way: the file must be untouched (no 'injected' value written)
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!written.includes('injected'), 'separator row replacement leaked into file');
  });

  // ── Regression: bold-format still works after the fix ────────────────────

  test('state update bold-format still works after table support added', () => {
    fs.writeFileSync(statePath, buildBoldFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'bold-format update broken after fix');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('**Status:** Ready to execute'),
      'Bold-format field not rewritten. Content:\n' + written,
    );
  });

  // ── updateCurrentPositionFields table support ─────────────────────────────

  test('state planned-phase updates table-cell Status via updateCurrentPositionFields', () => {
    // cmdStatePlannedPhase uses updateCurrentPositionFields internally;
    // verify it also handles the table format.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-01-01',
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status | Ready to plan |',
      '| Last Activity | 2026-01-01 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Create a minimal phase dir so planned-phase can count plans
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '1-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '1-01-PLAN.md'), '# Plan 1');

    // #3884 (ADR-3473 §8.4): `--plan-count` was never a declared flag (the
    // real flag is `--plans`) and the bare '1' was never read as a phase
    // positional either — both were silently dropped by the pre-#3884
    // permissive parser. The command "worked" only because
    // cmdStatePlannedPhase falls back to STATE.md's own current phase (1
    // here) when no --phase is given, so the assertion below never actually
    // exercised phase/plan-count plumbing. Corrected to the real flags.
    const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--plans', '1'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    // The Current Position table cell should now be "Ready to execute"
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'planned-phase did not update table-cell Status. Content:\n' + written,
    );
  });

  // ── Adversarial / edge cases ──────────────────────────────────────────────

  test('table field with extra whitespace in cells is handled', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '|  Status  |  Ready to plan  |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'extra-whitespace table cell not matched');
  });

  test('updating one row in a multi-row table does not corrupt adjacent rows', () => {
    // Regression: updating `Status` must leave the `Phase` row untouched.
    // NOTE: values containing literal '|' (e.g., "blocked | waiting") are NOT
    // supported — the current value regex [^|\n]*? stops at the first pipe.
    // Escaped-pipe values are out of scope for single-token status fields.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Status | Ready to plan |',
      '| Phase | 3 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Normal replacement — verify Phase row is untouched
    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(written.includes('| Phase | 3 |'), 'Phase row was corrupted during Status update');
  });

  test('CRLF line endings in table format are handled', () => {
    const content = buildTableFormatState({ status: 'Ready to plan' }).replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF table format not handled');
  });

  test('missing STATE.md returns updated:false gracefully', () => {
    // No STATE.md written — verify the command does not throw
    const missingDir = createTempProject('gsd-1162-missing-');
    try {
      const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], missingDir);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.updated, false, 'missing STATE.md should return updated:false');
    } finally {
      cleanup(missingDir);
    }
  });
});

describe('regressions: table-format STATE.md (#1162) — updateCurrentPositionFields preserve-authored invariants', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-f2-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: a STATE.md with table-format Current Position section.
  // We use planned-phase to exercise updateCurrentPositionFields indirectly,
  // because that is the call-site that writes Status/Last Activity.
  function buildMixedFormatState(opts) {
    const {
      status = 'Ready to plan',
      lastActivity = '2026-01-01',
    } = opts || {};
    return [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      `**Last Activity:** ${lastActivity}`,
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Status | ${status} |`,
      `| Last Activity | ${lastActivity} |`,
      '',
    ].join('\n');
  }

  // (a) Custom Status in table format must NOT be overwritten by planned-phase.
  test('(Finding 2a) custom Status in table format is preserved by updateCurrentPositionFields', () => {
    // "Blocked: waiting on infra" is executor-authored — not in KNOWN_TEMPLATE_DEFAULTS.
    // planned-phase calls updateCurrentPositionFields with status="Ready to execute".
    // The table-format branch must honour the same guard as the inline branch:
    // only overwrite when the existing value is a known template default.
    const content = buildMixedFormatState({ status: 'Blocked: waiting on infra', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    // #3884: `--plan-count` / bare positional never worked — see the (a)
    // Finding-2a-sibling note on the earlier occurrence of this pattern.
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Blocked: waiting on infra |'),
      'Custom Status was overwritten by updateCurrentPositionFields table branch.\nContent:\n' + written,
    );
    assert.ok(
      !written.includes('| Status | Ready to execute |'),
      'Custom Status replaced with Ready to execute in table branch.\nContent:\n' + written,
    );
  });

  // (b) Narrative Last Activity in table format must NOT be overwritten.
  test('(Finding 2b) narrative Last Activity in table format is preserved', () => {
    // "2026-02-15 -- blocked" has trailing prose — executor-authored.
    // planned-phase calls updateCurrentPositionFields with today's ISO date.
    // Must be preserved.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-02-15 -- blocked' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    // #3884: `--plan-count` / bare positional never worked — see the note on
    // the first occurrence of this pattern above.
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-02-15 -- blocked |'),
      'Narrative Last Activity was overwritten in table branch.\nContent:\n' + written,
    );
  });

  // (c) Known-default Status and bare-date Last Activity ARE updated.
  test('(Finding 2c) known-default Status and bare-date Last Activity ARE updated in table format', () => {
    // "Ready to plan" is a known default; "2026-01-01" is a bare ISO date.
    // Both should be replaced by planned-phase.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    // #3884: `--plan-count` / bare positional never worked — see the note on
    // the first occurrence of this pattern above.
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Known-default Status not updated in table branch.\nContent:\n' + written,
    );
    // Last Activity should be today's date (not 2026-01-01)
    assert.ok(
      !written.includes('| Last Activity | 2026-01-01 |'),
      'Bare-date Last Activity was NOT updated in table branch.\nContent:\n' + written,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1255 — begin/complete-phase advance status for pipe-table STATE.md
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression tests for bug #1255.
 *
 * `state begin-phase` / `state complete-phase` do not advance the frontmatter
 * `status` when the body `Status` field is expressed as a pipe-table row
 * (`| Status | Planning |`) instead of an inline key-value pair
 * (`Status: Planning`).
 *
 * Root cause: `stateReplaceField(content, 'Status', ...)` is called with the
 * full file content (frontmatter + body). The plain-text pattern
 * (`^Status:\s*(.+)` with /im flag) matches `status: planning` in the YAML
 * frontmatter block rather than the body pipe-table row. The pipe-table row
 * is never updated. `syncStateFrontmatter` then re-derives from the body (which
 * still says 'Planning') and the #1230 delta heuristic preserves the old
 * frontmatter value ('planning'), so the status never advances to 'executing'.
 *
 * Fix: strip frontmatter before all body-field replacements in
 * `cmdStateBeginPhase` and `cmdStateCompletePhase`, then reassemble.
 *
 * Additional bugs fixed (#1255 follow-up):
 * 1. complete-phase Phase table cell had label-duplication: `Phase: 1 — COMPLETE`
 *    instead of bare `1 — COMPLETE`.
 * 2. begin-phase and complete-phase Last-activity table branches wrote bare date
 *    instead of date + narrative (inconsistent with inline branch).
 */

function make1255TempProject(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1255-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Minimal ROADMAP so buildStateFrontmatter can resolve phase counts
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# ROADMAP',
    '',
    '## Phase 1: setup:',
    '- [ ] Step 1',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

// STATE.md where Status lives entirely in pipe-table rows (no inline "Status: ..." anywhere)
// This is the form a hand-edited or legacy STATE.md might use, and is a
// supported body format (do NOT silently rewrite to inline).
const TABLE_STATUS_PLANNING_1255 = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 1 |
| Status | Planning |
| Last Activity | 2026-06-01 |
| Last Activity Description | Roadmap created |

## Current Position

| Phase | 1 (setup) |
| Plan | 1 of 3 |
| Status | Planning |
| Last activity | 2026-06-01 |
`;

// STATE.md with Status as pipe-table but execution already in progress (complete-phase scenario)
const TABLE_STATUS_EXECUTING_1255 = `---
gsd_state_version: '1.0'
status: executing
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 3 |
| Status | Executing Phase 1 |
| Last Activity | 2026-06-01 |
| Last Activity Description | Phase 1 execution started |

## Current Position

| Phase | 1 (setup) |
| Plan | 3 of 3 |
| Status | Executing Phase 1 |
| Last activity | 2026-06-01 |
`;

describe('#1255 — begin/complete-phase advance status for pipe-table STATE.md', () => {
  // begin-phase: planning → executing
  test('begin-phase advances frontmatter status planning→executing when body Status is pipe-table', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must advance to 'executing'
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after begin-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `frontmatter status must be 'executing' after begin-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: body pipe-table row must also be updated
  test('begin-phase updates body pipe-table Status cell to Executing Phase N', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // The pipe-table Status cell in the Configuration table must be updated
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Executing Phase 1'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: Current Position table cells — exact cell values
  test('begin-phase updates Current Position pipe-table Status and Last activity cells correctly', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = sectionMatchOf(after, 'Current Position');
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Status cell in Current Position: bare value, not prefixed
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Executing Phase 1'; got Current Position:\n${cpSection}`
      );

      // Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /—\s*Phase 1 execution started\s*$/i.test(pipeTableCell(cpSection, 'Last activity') || ''),
        `Current Position Last activity cell must include narrative '— Phase 1 execution started'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: executing → completed
  test('complete-phase advances frontmatter status executing→completed when body Status is pipe-table', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      const result = runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must be 'completed'
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after complete-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*completed\s*$/m.test(fm),
        `frontmatter status must be 'completed' after complete-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: body pipe-table row must also be updated
  test('complete-phase updates body pipe-table Status cell to Phase N complete', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Phase 1 complete'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: Current Position table cells — exact cell values (catches bugs 1 and 2)
  test('complete-phase updates Current Position pipe-table Phase/Status/Last-activity cells correctly', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = sectionMatchOf(after, 'Current Position');
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Bug 1: Phase cell must be bare '1 — COMPLETE', NOT 'Phase: 1 — COMPLETE'
      assert.ok(
        /\|\s*Phase\s*\|\s*1\s*—\s*COMPLETE\s*\|/.test(cpSection),
        `Current Position Phase cell must be '1 — COMPLETE' (no 'Phase:' prefix in cell value); got Current Position:\n${cpSection}`
      );
      assert.ok(
        !/\|\s*Phase\s*\|\s*Phase:\s*1/.test(cpSection),
        `Current Position Phase cell must NOT contain 'Phase: 1' (label-duplication bug); got Current Position:\n${cpSection}`
      );

      // Status cell in Current Position: bare value
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Phase 1 complete'; got Current Position:\n${cpSection}`
      );

      // Bug 2: Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /—\s*Phase 1 marked complete\s*$/i.test(pipeTableCell(cpSection, 'Last activity') || ''),
        `Current Position Last activity cell must include narrative '— Phase 1 marked complete'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // Regression guard: inline Status format must still work (existing behavior unchanged)
  test('begin-phase still works correctly with inline Status: format (regression guard)', () => {
    const inlineStateMd = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

Current Phase: 1
Current Phase Name: setup
Total Plans in Phase: 3
Current Plan: 1
Status: Planning
Last Activity: 2026-06-01
Last Activity Description: Roadmap created

## Current Position
Phase: 1 (setup)
Plan: 1 of 3
Status: Planning
Last activity: 2026-06-01 -- Roadmap created
`;
    const dir = make1255TempProject(inlineStateMd);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed on inline format: ${result.error || result.output}`);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'must have frontmatter');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `inline Status: format: frontmatter status must be 'executing'; got:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });
});

// #1257 — planned-phase + begin-phase pipe-table regressions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression tests for bug #1257.
 *
 * Finding 1 (INFERRED — reproduced here empirically):
 *   `cmdStatePlannedPhase` calls `stateReplaceFieldIfTemplate(content, 'Status', …)`
 *   on the FULL file content (including YAML frontmatter).  The plain-text pattern
 *   `^Status:\s*(.+)` (case-insensitive) matches the YAML frontmatter `status: planning`
 *   line BEFORE reaching the body pipe-table row `| Status | Planning |`.  The pipe-table
 *   cell is never updated.  `syncStateFrontmatter` re-derives from the unchanged body
 *   and the #1230 delta heuristic preserves the original frontmatter value, so the
 *   status never advances to 'Ready to execute'.
 *   Smoking-gun: src/state.cts:2015 — `stateReplaceFieldIfTemplate(content, 'Status', …)`
 *   where `content` is the full file (frontmatter + body), not stripped body.
 *
 * Finding 2 (OBSERVED):
 *   `cmdStateBeginPhase`'s `## Current Position` update block only has pipe-table
 *   else-branches for Status (#1255) and Last-activity (#1255), NOT for Phase or Plan.
 *   For a pipe-table STATE.md, the `| Phase | … |` and `| Plan | … |` rows are silently
 *   ignored: the else-branch instead INSERTS a new inline `Phase: N — EXECUTING` text
 *   line prepended to the section body (leaving the old table cells stale).
 *   Smoking-gun: src/state.cts:1833–1844 — `^Phase:` / `^Plan:` plain-text checks with
 *   else-branches that prepend text rather than calling stateReplaceField on the table.
 */

// STATE.md fixture for #1257 — pipe-table format with frontmatter status: planning
// After planned-phase the body Status should become 'Ready to execute' and
// frontmatter status should advance accordingly.
const TABLE_STATUS_PLANNING_1257 = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 1 |
| Status | Planning |
| Last Activity | 2026-06-01 |
| Last Activity Description | Roadmap created |

## Current Position

| Phase | 1 (setup) |
| Plan | 1 of 3 |
| Status | Planning |
| Last activity | 2026-06-01 |
`;

function make1257TempProject(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1257-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Minimal ROADMAP so phase resolution can proceed
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# ROADMAP',
    '',
    '## Phase 1: setup:',
    '- [ ] Step 1',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

describe('#1257 — planned-phase and begin-phase pipe-table regressions', () => {

  // ── Finding 1 ───────────────────────────────────────────────────────────────

  test('Finding 1: planned-phase advances Configuration pipe-table Status cell to Ready to execute', () => {
    // planned-phase should update the Configuration-section body | Status | … | cell.
    // Smoking-gun: state.cts:2015 calls stateReplaceFieldIfTemplate on full content,
    // so the frontmatter `status:` key shadows the body table cell and the cell is
    // never updated.  (updateCurrentPositionFields at line 2037 does correctly update
    // the Current Position table cell — this test specifically targets the Configuration
    // table cell, which has no pipe-table else-branch in planned-phase.)
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      const result = runGsdTools(
        ['state', 'planned-phase', '--phase', '1', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `planned-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Configuration section (stops before ## Current Position)
      // to avoid false-positive from the Current Position table (which IS updated
      // by updateCurrentPositionFields).
      const cfgMatch = sectionMatchOf(after, 'Configuration');
      assert.ok(cfgMatch, '## Configuration section must exist');
      const cfgSection = cfgMatch[1];

      // The Configuration section's pipe-table Status cell must be updated
      assert.ok(
        /\|\s*Status\s*\|\s*Ready to execute\s*\|/i.test(cfgSection),
        `Configuration pipe-table Status cell must be 'Ready to execute' after planned-phase; got Configuration:\n${cfgSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  test('Finding 1: planned-phase advances frontmatter status to executing when body Status is pipe-table', () => {
    // The frontmatter status must advance after planned-phase sets Status to 'Ready to execute'.
    // (syncStateFrontmatter maps 'ready to execute' → 'executing'.)
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      runGsdTools(
        ['state', 'planned-phase', '--phase', '1', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after planned-phase');
      const fm = fmMatch[1];
      // syncStateFrontmatter maps 'Ready to execute' → 'executing' in normalizeStateStatus
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `frontmatter status must be 'executing' after planned-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // ── Finding 2 ───────────────────────────────────────────────────────────────

  test('Finding 2: begin-phase updates Current Position pipe-table Phase cell (not prepend inline)', () => {
    // begin-phase must update the | Phase | … | cell in ## Current Position.
    // Smoking-gun: state.cts:1833 checks `^Phase:` (plain-text pattern) which
    // never matches a pipe-table row, so the else-branch at 1836 PREPENDS a new
    // inline `Phase: N — EXECUTING` line to the section instead of updating the cell.
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract ## Current Position section only
      const cpMatch = sectionMatchOf(after, 'Current Position');
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // The pipe-table Phase cell must be updated to reflect the executing phase
      assert.ok(
        /1[\s\S]*EXECUTING/i.test(pipeTableCell(cpSection, 'Phase') || ''),
        `Current Position pipe-table Phase cell must contain phase 1 EXECUTING; got Current Position:\n${cpSection}`
      );

      // Must NOT have a spurious prepended inline `Phase: …` text line
      assert.ok(
        !/^Phase:\s+\d/m.test(cpSection),
        `Current Position must NOT have a spuriously prepended inline 'Phase: N' text line; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  test('Finding 2: begin-phase updates Current Position pipe-table Plan cell (not prepend inline)', () => {
    // begin-phase must update the | Plan | … | cell in ## Current Position.
    // Smoking-gun: state.cts:1841 checks `^Plan:` which never matches a pipe-table row,
    // so the else-branch at 1843 replaces the (newly-prepended) inline Phase line with
    // Phase\nPlan, neither touching the existing table | Plan | cell.
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract ## Current Position section only
      const cpMatch = sectionMatchOf(after, 'Current Position');
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // The pipe-table Plan cell must be updated to '1 of 3'
      assert.ok(
        /\|\s*Plan\s*\|\s*1 of 3\s*\|/i.test(cpSection),
        `Current Position pipe-table Plan cell must be '1 of 3'; got Current Position:\n${cpSection}`
      );

      // Must NOT have a spurious prepended inline `Plan: …` text line
      assert.ok(
        !/^Plan:\s+\d/m.test(cpSection),
        `Current Position must NOT have a spuriously prepended inline 'Plan: N' text line; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 section-splice characterization tests (ADR-1372 / #1398)
//
// Covers the migrated cmdState* write-ops across a matrix of fixture variants:
//   inline (standard frontmatter + inline section text)
//   trailing-blanks (sections with extra blank lines)
//   CRLF (Windows line endings)
//   no-frontmatter (bare body only)
//   nested-acc (Accumulated Context with Session Notes subsection)
//   no-current-pos (absent Current Position section)
//   post-milestone (fresh milestone, prior progress=100%)
// ─────────────────────────────────────────────────────────────────────────────

describe('T6 section-splice characterization — record-session', () => {
  // Fixtures used across these tests
  const STATE_WITH_SESSION = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    "last_updated: '2026-01-01T00:00:00.000Z'",
    "last_activity: '2026-01-01'",
    '---',
    '',
    '# Project State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    '**Resume file:** None',
    '',
  ].join('\n');

  const STATE_NO_SESSION_LABELS = [
    '# Project State',
    '',
    '**Current focus:** Phase 2',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    'Plan: 1 of 4',
    'Status: Executing Phase 2',
    'Last Activity: 2026-01-01',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Chose PostgreSQL',
    '',
  ].join('\n');

  test('record-session no-op: bare call rejected, STATE.md byte-unchanged (#4186)', () => {
    // #4186: the bare call that used to reach the recorded:false decline is
    // now a usage error (stopped-at or resume-file required). The byte-
    // unchanged assertion below keeps guarding the #952 no-op posture — a
    // rejected call must not trample anything, milestone_name included.
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_SESSION_LABELS);
      const result = runGsdTools(['state', 'record-session'], d);
      assert.ok(!result.success, 'bare record-session must exit non-zero');
      assert.match(result.error, /stopped-at or resume-file required for state record-session/);
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.strictEqual(after, STATE_NO_SESSION_LABELS, 'STATE.md must be byte-unchanged by the rejected call');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --stopped-at updates Stopped at field in Session section', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_SESSION);
      const result = runGsdTools(['state', 'record-session', '--stopped-at', '14.3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.recorded, true, 'recorded must be true when session fields found');
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('**Stopped at:** 14.3'), 'Stopped at field must be updated to 14.3');
      // milestone_name must be preserved (not trampled)
      assert.ok(after.includes('milestone_name: TestMilestone'), 'milestone_name must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file updates Resume file field in Session section', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_SESSION);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-3.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.recorded, true, 'recorded must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('**Resume file:** plan-3.md'), 'Resume file field must be updated to plan-3.md');
    } finally {
      cleanup(d);
    }
  });

  // ─── #2450: CRLF STATE.md must not silently drop inserted session fields ─────
  //
  // Bug class: cmdStateRecordSession's section-rewrite regex used literal \n
  // for the `## Session` and `## Session Continuity` heading boundaries, which
  // cannot match a CRLF STATE.md (---\r\n style). The detector regex (using
  // /^## Session[ \t]*$/im) WAS CRLF-tolerant ($ under /m treats \r as a line
  // terminator), so the bug fired when a canonical session field was missing
  // and had to be INSERTED via the section-rewrite path: the detector entered
  // the branch, the writer regex silently no-op'd, but `updated.push('Resume File')`
  // ran unconditionally → reported as updated but never written to disk.
  //
  // With core.autocrlf=input, the CRLF working-tree file produces no git diff,
  // so the contributor cannot tell their STATE.md was misclassified.

  const STATE_CRLF_SESSION_MISSING_RESUME = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    "last_updated: '2026-01-01T00:00:00.000Z'",
    "last_activity: '2026-01-01'",
    '---',
    '',
    '# Project State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    // Resume file absent — forces the section-rewrite insert path (the buggy block)
    '',
  ].join('\r\n');

  test('record-session --resume-file on CRLF STATE.md with field absent: field IS written (#2450)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_SESSION_MISSING_RESUME);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-3.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      // Bug discriminator: command reported recorded:true + 'Resume File' in
      // updated, but the field was never written to disk. The disk assertion
      // below is what fails pre-fix and passes post-fix.
      assert.ok(Array.isArray(output.updated) && output.updated.includes('Resume File'),
        `updated must include 'Resume File': ${JSON.stringify(output.updated)}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-3\.md/.test(after),
        `Resume file field must be on disk after the call; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });

  test('record-session --stopped-at on CRLF STATE.md with field absent: field IS written (#2450)', () => {
    // Same bug class, different field. The bug fires whenever a canonical
    // session field must be INSERTED (vs. same-line replaced) on a CRLF STATE.md.
    const STATE_CRLF_SESSION_MISSING_STOPPED = [
      '---',
      'status: executing',
      '---',
      '',
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      // Stopped at absent — forces the section-rewrite insert path
      '**Resume file:** None',
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_SESSION_MISSING_STOPPED);
      const result = runGsdTools(['state', 'record-session', '--stopped-at', '14.3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Stopped at:\*\*\s*14\.3/.test(after),
        `Stopped at field must be on disk; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file on CRLF STATE.md with Session Continuity heading: field IS inserted (#2450)', () => {
    // Same bug class, different heading: `## Session Continuity` is the
    // bootstrap-template shape. The rewrite regex at the second bug site used
    // the same literal-\n pattern.
    const STATE_CRLF_CONTINUITY = [
      '---',
      'status: executing',
      '---',
      '',
      '## Session Continuity',
      '',
      'Next recommended action: resume phase 2.',
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_CONTINUITY);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-9.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-9\.md/.test(after),
        `Resume file field must be inserted under Session Continuity; STATE.md head:\n${after.slice(0, 500)}`,
      );
      // Existing prose must be preserved (#1101 invariant)
      assert.ok(/Next recommended action: resume phase 2\./.test(after),
        'Session Continuity prose must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file on mixed-ending STATE.md (LF frontmatter + CRLF body): field IS written (#2450)', () => {
    // CONTRIBUTING.md §"Parser and project-file inputs" lists "Mixed CRLF/LF
    // newlines" as a required adversarial fixture class. Realistic when a
    // Windows editor normalizes frontmatter bytes but preserves body text,
    // or when tooling concatenates LF + CRLF fragments. The bug class is
    // body-section-rewrite, so CRLF body + LF frontmatter is the worst case:
    // the frontmatter delimiter is LF (syncStateFrontmatter parses either)
    // but the `## Session` heading is CRLF, exercising the writer regex.
    const STATE_MIXED_LF_FM_CRLF_BODY = [
      '---',
      'status: executing',
      '---',
      '',  // LF after frontmatter
    ].join('\n') + [
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      '**Stopped at:** None',
      // Resume file absent
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_MIXED_LF_FM_CRLF_BODY);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-mix.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-mix\.md/.test(after),
        `Resume file field must be on disk despite mixed line endings; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-decision', () => {
  const STATE_INLINE = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use Node.js for tooling',
    '',
    '### Blockers',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_TRAILING_BLANKS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '',
    '### Blockers',
    '',
    '- Bug in auth service',
    '',
  ].join('\n');

  const STATE_NO_DECISIONS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('add-decision appends to existing Decisions Made section (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE);
      const result = runGsdTools(['state', 'add-decision', '--phase', '2', '--summary', 'Use Docker for builds'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 2]: Use Docker for builds'), 'new decision entry must be present');
      assert.ok(after.includes('- [Phase 1]: Use Node.js for tooling'), 'existing decision must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-decision appends to Decisions Made section with trailing blank lines (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_TRAILING_BLANKS);
      const result = runGsdTools(['state', 'add-decision', '--phase', '3', '--summary', 'Add monitoring'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 3]: Add monitoring'), 'new decision must be present');
      assert.ok(after.includes('- [Phase 1]: First decision'), 'original decision must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-decision creates Decisions section when absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_DECISIONS);
      const result = runGsdTools(['state', 'add-decision', '--phase', '1', '--summary', 'Use Node.js'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 1]: Use Node.js'), 'decision must be present even when section was absent');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-blocker', () => {
  const STATE_INLINE_WITH_BLOCKERS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use Node.js for tooling',
    '',
    '### Blockers',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_CRLF = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Current Position\r\n\r\nStatus: Executing Phase 2\r\nLast Activity: 2026-01-01\r\n\r\n### Blockers\r\n\r\nNone.\r\n';

  const STATE_NO_BLOCKERS_SECTION = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    '',
  ].join('\n');

  test('add-blocker appends to existing Blockers section (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_WITH_BLOCKERS);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'Flaky CI on Windows'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      assert.strictEqual(output.blocker, 'Flaky CI on Windows', 'blocker text must match');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Flaky CI on Windows'), 'blocker entry must be present');
    } finally {
      cleanup(d);
    }
  });

  test('add-blocker appends to existing Blockers section (CRLF fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'NFS mount issue'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('NFS mount issue'), 'blocker entry must be present in CRLF file');
    } finally {
      cleanup(d);
    }
  });

  test('add-blocker creates Blockers section when absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_BLOCKERS_SECTION);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'Build pipeline broken'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('Build pipeline broken'), 'blocker must be present even when section was absent');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — resolve-blocker', () => {
  const STATE_WITH_BLOCKERS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '',
    '### Blockers',
    '',
    '- Bug in auth service',
    '- Another blocker',
    '',
    '### Recently Completed',
    '',
    '- Phase 1 Plan 1',
    '',
  ].join('\n');

  test('resolve-blocker removes target blocker, preserves others (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_BLOCKERS);
      const result = runGsdTools(['state', 'resolve-blocker', '--text', 'Bug in auth service'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.resolved, true, 'resolved must be true');
      assert.strictEqual(output.blocker, 'Bug in auth service', 'resolved blocker text must match');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(!after.includes('- Bug in auth service'), 'resolved blocker must be removed');
      assert.ok(after.includes('Another blocker'), 'unrelated blocker must be preserved');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-roadmap-evolution', () => {
  const STATE_NESTED_ACC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 3',
    'Status: Executing Phase 3',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use TypeScript',
    '- [Phase 2]: Use Jest',
    '',
    '### Blockers',
    '',
    'None.',
    '',
    '## Accumulated Context',
    '',
    'Some context text here.',
    '',
    '### Roadmap Evolution',
    '',
    '- Phase 1 added: Initial planning',
    '- Phase 2 changed: Scope updated',
    '',
    '### Session Notes',
    '',
    'Some notes.',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    '**Resume file:** None',
    '',
  ].join('\n');

  const STATE_INLINE_WITH_ROAD_EVO = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Accumulated Context',
    '',
    '### Roadmap Evolution',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_NO_ACC_SECTION = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  const STATE_CRLF_ROAD = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Accumulated Context\r\n\r\n### Roadmap Evolution\r\n\r\n- Phase 1 added: Initial migration\r\n';

  const STATE_POST_MILESTONE = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v2.0',
    'milestone_name: NextMilestone',
    'status: planning',
    'progress:',
    '  total_phases: 4',
    '  completed_phases: 4',
    '  total_plans: 12',
    '  completed_plans: 12',
    '  percent: 100',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: Not started (defining requirements)',
    'Plan: —',
    'Status: Defining requirements',
    'Last activity: 2026-01-15 — Milestone v2.0 started',
    '',
    '## Accumulated Context',
    '',
    '### Roadmap Evolution',
    '',
    '- Phase 1 complete after Phase 1: Migration done',
    '',
  ].join('\n');

  test('add-roadmap-evolution appends to existing Roadmap Evolution subsection (nested-acc fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NESTED_ACC);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'New API endpoint'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      assert.ok(output.entry.includes('Phase 4 added'), 'entry must reference phase 4 added');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 4 added: New API endpoint'), 'new entry must be present');
      assert.ok(after.includes('- Phase 1 added: Initial planning'), 'existing entries must be preserved');
      assert.ok(after.includes('- Phase 2 changed: Scope updated'), 'second existing entry must be preserved');
      // Session Notes subsection must be preserved (not consumed by splice)
      assert.ok(after.includes('### Session Notes'), 'Session Notes subsection must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution creates Roadmap Evolution subsection when absent but acc section present', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_WITH_ROAD_EVO);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '3', '--action', 'changed', '--note', 'Scope updated significantly'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 3 changed: Scope updated significantly'), 'new entry must be present');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution creates Accumulated Context and subsection when both absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_ACC_SECTION);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '1', '--action', 'added', '--note', 'Initial setup'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 1 added: Initial setup'), 'new entry must be present');
      assert.ok(after.includes('### Roadmap Evolution'), 'Roadmap Evolution subsection must be created');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution appends to Roadmap Evolution in CRLF file', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_ROAD);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'changed', '--note', 'CRLF test case'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 2 changed: CRLF test case'), 'new CRLF entry must be present');
      assert.ok(after.includes('- Phase 1 added: Initial migration'), 'existing CRLF entry must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution appends to Roadmap Evolution in post-milestone STATE.md', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_POST_MILESTONE);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'added', '--note', 'New phase inserted'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 2 added: New phase inserted'), 'new entry must be present');
      assert.ok(after.includes('- Phase 1 complete after Phase 1: Migration done'), 'prior entry must be preserved');
      // Frontmatter milestone_name must NOT be trampled
      assert.ok(after.includes('milestone_name: NextMilestone'), 'milestone_name must be preserved');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — begin-phase', () => {
  const STATE_INLINE_POS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 2 of 3',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    'Last activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_NO_FRONTMATTER_POS = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    'Plan: 1 of 4',
    'Status: Executing Phase 2',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_NO_CURRENT_POS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('begin-phase updates Current Position and status (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '2', '--name', 'Build', '--plans', '4'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      // Phase line must reflect new phase
      assert.ok(/Phase:\s+2/.test(after), 'Phase line must reference phase 2');
      // Plan counter must reset to 1 of 4
      assert.ok(/Plan:\s+1 of 4/.test(after), 'Plan line must be reset to 1 of 4');
      // Frontmatter status must be executing
      assert.ok(/^status:\s+executing/m.test(after), 'frontmatter status must be executing');
    } finally {
      cleanup(d);
    }
  });

  test('begin-phase updates Current Position without frontmatter (no-frontmatter fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_FRONTMATTER_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--plans', '2'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/Phase:\s+3/.test(after), 'Phase line must reference phase 3');
    } finally {
      cleanup(d);
    }
  });

  test('begin-phase handles absent Current Position section gracefully', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_CURRENT_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'Setup', '--plans', '3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      // Expect phase, phase_name and plan_count in response even if fields weren't updated
      assert.strictEqual(output.phase, '1', 'phase must be reported in response');
      assert.strictEqual(output.plan_count, 3, 'plan_count must be reported in response');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — complete-phase', () => {
  const STATE_INLINE_EXEC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 2 of 3',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_TRAILING_BLANKS_EXEC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
  ].join('\n');

  const STATE_CRLF_EXEC = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Current Position\r\n\r\nStatus: Executing Phase 2\r\nLast Activity: 2026-01-01\r\n';

  test('complete-phase marks current phase complete and sets frontmatter status (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_EXEC);
      const result = runGsdTools(['state', 'complete-phase'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      assert.ok(output.updated.includes('Status'), 'Status must be in updated list');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed');
      assert.ok(/Status:\s+Phase\s+1\s+complete/i.test(after), 'body Status field must reflect phase complete');
    } finally {
      cleanup(d);
    }
  });

  test('complete-phase works correctly with trailing blank lines in Current Position (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_TRAILING_BLANKS_EXEC);
      const result = runGsdTools(['state', 'complete-phase'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed');
    } finally {
      cleanup(d);
    }
  });

  test('complete-phase works correctly on CRLF STATE.md', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_EXEC);
      const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed after CRLF complete-phase');
    } finally {
      cleanup(d);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3578 — state complete-phase must not overwrite milestone status when other
// phases remain open. `normalizeStateStatus` matches 'complete' as a
// substring, so the phase-completion prose `Phase ${N} complete` collapses to
// the milestone-level 'completed' status even though completed_phases /
// total_phases (computed by the same buildStateFrontmatter call) correctly
// show the milestone is not yet done.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3578: complete-phase does not overwrite milestone status when phases remain open', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const ROADMAP_4_PHASE = [
    '## Milestone v1.0: Test Milestone',
    '',
    '### Phase 01: Alpha',
    '**Goal:** first',
    '',
    '### Phase 02: Beta',
    '**Goal:** second',
    '',
    '### Phase 03: Gamma',
    '**Goal:** third',
    '',
    '### Phase 04: Delta',
    '**Goal:** fourth',
  ].join('\n');

  const PHASE_DIRS_4 = ['01-alpha', '02-beta', '03-gamma', '04-delta'];

  /**
   * Seed `.planning/phases/<NN-slug>` for phases 1..4. Every phase gets a
   * PLAN.md; phases numbered <= completeThrough additionally get a
   * SUMMARY.md and a passing VERIFICATION.md (disk-strict completion,
   * ADR-3180 §7.4 / #3186), so isPhaseComplete reports them done.
   */
  function seed4PhaseMilestone(completeThrough) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP_4_PHASE);
    PHASE_DIRS_4.forEach((dirName, idx) => {
      const n = idx + 1;
      const padded = String(n).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dirName);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan\n');
      if (n <= completeThrough) {
        fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary\n');
        writePassedVerification(tmpDir, dirName, padded);
      }
    });
  }

  function writeStateAtPhase(phase, extraBodyLines = []) {
    writeState(
      tmpDir,
      [
        '---',
        "gsd_state_version: '1.0'",
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        `Current Phase: ${phase}`,
        `Status: Executing Phase ${phase}`,
        'Last Activity: 2026-01-01',
        ...extraBodyLines,
        '',
      ].join('\n'),
    );
  }

  function frontmatterStatus(after) {
    const fm = frontmatterLib.extractFrontmatter(after);
    return fm.status;
  }

  test('2 of 4 phases complete on disk: --phase 2 must not set frontmatter status completed', () => {
    // On disk, phases 1-2 are already complete (matches the #3578 repro:
    // completed_phases/total_phases are correct while status wrongly collapses).
    seed4PhaseMilestone(2);
    writeStateAtPhase(2);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.notEqual(
      frontmatterStatus(after),
      'completed',
      `status must not be 'completed' while phases remain open; got frontmatter:\n${after}`,
    );

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'completed_phases must still be 2');
    assert.strictEqual(Number(output.progress.total_phases), 4, 'total_phases must still be 4');
  });

  test('3 of 4 phases complete on disk (limit-1): --phase 3 must not set frontmatter status completed', () => {
    seed4PhaseMilestone(3);
    writeStateAtPhase(3);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '3'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.notEqual(
      frontmatterStatus(after),
      'completed',
      `status must not be 'completed' with 3 of 4 phases done; got frontmatter:\n${after}`,
    );
  });

  test('4 of 4 phases complete on disk (limit): --phase 4 sets frontmatter status completed', () => {
    seed4PhaseMilestone(4);
    writeStateAtPhase(4);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '4'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(
      frontmatterStatus(after),
      'completed',
      `status must be 'completed' once all 4 phases are done; got frontmatter:\n${after}`,
    );
  });

  test('milestone_name is byte-identical before and after complete-phase (2 of 4 case)', () => {
    seed4PhaseMilestone(2);
    writeStateAtPhase(2);

    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const beforeName = frontmatterLib.extractFrontmatter(before).milestone_name;

    const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const afterName = frontmatterLib.extractFrontmatter(after).milestone_name;

    assert.strictEqual(beforeName, 'Test Milestone', 'precondition: milestone_name must start as Test Milestone');
    assert.strictEqual(
      afterName,
      beforeName,
      `milestone_name must be byte-identical before/after complete-phase; before=${beforeName}, after=${afterName}`,
    );
  });

  test('1-of-1 milestone: --phase 1 still sets frontmatter status completed (counter rule allows it)', () => {
    const ROADMAP_1_PHASE = [
      '## Milestone v2.0: Solo Milestone',
      '',
      '### Phase 01: Only',
      '**Goal:** the only phase',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP_1_PHASE);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-only');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '01-only', '01');

    writeState(
      tmpDir,
      [
        '---',
        "gsd_state_version: '1.0'",
        'milestone: v2.0',
        'milestone_name: Solo Milestone',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'),
    );

    const result = runGsdTools(['state', 'complete-phase', '--phase', '1'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(
      frontmatterStatus(after),
      'completed',
      `a genuinely 1-of-1-complete milestone must still report 'completed'; got frontmatter:\n${after}`,
    );
  });

  /**
   * Body Status field the guard's regex actually inspects (never the
   * frontmatter `status:` scalar the guard *writes*). Reads via the same
   * `stateFieldValue` fallback-chain owner (state-document.cjs) the guard's
   * caller (buildStateFrontmatter) is built on, scoped to the body only
   * (fmKey null) by stripping frontmatter first.
   */
  function bodyStatus(after) {
    const body = frontmatterLib.stripFrontmatter(after);
    return stateDocument.stateFieldValue({}, body, null, 'Status').value;
  }

  /**
   * Seed `.planning/phases/<NN-slug>` for phases 1..4 exactly like
   * `seed4PhaseMilestone`, but WITHOUT writing ROADMAP.md at all. Used to
   * drive `buildStateFrontmatter`'s roadmap-absent withhold path (#3573),
   * which is the only deterministic way to detach `totalPhases` from the
   * live disk-scanned total from a fixture.
   */
  function seed4PhaseDirsNoRoadmap(completeThrough) {
    PHASE_DIRS_4.forEach((dirName, idx) => {
      const n = idx + 1;
      const padded = String(n).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dirName);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan\n');
      if (n <= completeThrough) {
        fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary\n');
        writePassedVerification(tmpDir, dirName, padded);
      }
    });
  }

  // Parity assertion (repo rule: "Generative Fix Divergence" — a shared
  // constant/pattern between parallel surfaces needs a test that fails if
  // they diverge). The guard's anchored regex
  // /^\s*phase\s+\S+\s+complete\s*$/i lives in src/state.cts and hand-copies
  // the SHAPE of the prose cmdStateCompletePhase writes to the body Status
  // field (`Phase ${N} complete`, gsd-core/bin/lib/state.cjs) rather than
  // sharing a constant with it. If that prose is ever reworded, the guard
  // silently stops matching and the #3578 regression returns undetected by
  // every other test in this block (they only assert the guard's downstream
  // EFFECT on frontmatter status, never that its input pattern still fires).
  test("#3578 parity: complete-phase's emitted body Status prose still matches the guard's phase-complete pattern", () => {
    seed4PhaseMilestone(2);
    writeStateAtPhase(2);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const status = bodyStatus(after);
    assert.match(
      status,
      /^\s*phase\s+\S+\s+complete\s*$/i,
      `emitted body Status prose ("${status}") no longer matches the #3578 guard's pattern in src/state.cts — the guard would silently stop firing`,
    );
  });

  test('completed phase dirs on disk exceed a stale declared total (limit+1 on the completedPhases < totalPhases comparison): guard must not fire', () => {
    // No ROADMAP.md at all + a stale "Total Phases: 2" body annotation drives
    // the #3573 roadmap-absent withhold path: totalPhases stays pinned at the
    // stale body-declared value (2) instead of being replaced by the live
    // disk-scanned total. #4094 extended that withhold to completedPhases too
    // — it comes from the same phaseDirs walk and is equally untrustworthy
    // here — so completed_phases is withheld (omitted) alongside any
    // non-derivable counter, and the guard's `typeof completedPhases ===
    // 'number'` conjunct fails, so it cannot fire. Pre-#4094 completedPhases
    // was UNCONDITIONALLY set from the disk scan (4 > 2 made the
    // `completedPhases < totalPhases` conjunct false) — the exact
    // "completed_phases larger than a total_phases-consistent value" symptom
    // #4094's issue reports. Either way the guard does not demote; the row
    // still pins that conclusion. Note this fixture necessarily also drives
    // listMilestonePhaseDirs' own ROADMAP-absent scope to non-COMPLETE (same
    // missing file, independent read). Inconsistent/untrustworthy counters
    // deliberately fall through to normalizeStateStatus's answer rather than
    // guessing which of the two disagreeing numbers is correct.
    seed4PhaseDirsNoRoadmap(4);
    writeStateAtPhase(4, ['Total Phases: 2']);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '4'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(
      frontmatterStatus(after),
      'completed',
      `guard must not demote when the counters are withheld as untrustworthy; got frontmatter:\n${after}`,
    );

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(
      output.progress && output.progress.completed_phases,
      undefined,
      'completed_phases must be withheld under the #4094 roadmap-absent withhold (no trustworthy scan, no stored value)',
    );
    assert.strictEqual(Number(output.progress && output.progress.total_phases), 2, 'total_phases must stay pinned at the stale declared value (2)');
  });

  test('untrustworthy counters (no ROADMAP.md, no derivable total) must not demote status', () => {
    // ROADMAP.md absent entirely + an asserted milestone + no body "Total
    // Phases" annotation: buildStateFrontmatter's #3573 withhold path leaves
    // totalPhases at null (never a number) because there is nothing on disk
    // or in the body to derive a denominator from. The guard's
    // `typeof totalPhases === 'number' && Number.isFinite(totalPhases)`
    // conjunct fails, so it cannot fire regardless of the true completion
    // state — the counters are not trustworthy enough to demote on.
    seed4PhaseDirsNoRoadmap(2);
    writeStateAtPhase(2);

    const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], tmpDir);
    assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(
      frontmatterStatus(after),
      'completed',
      `guard must not fire without a trustworthy totalPhases; got frontmatter:\n${after}`,
    );

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);
    // #4094: the withhold now covers all four counters (same untrustworthy
    // phaseDirs walk), and this fixture stores none of them in frontmatter —
    // so the whole progress block may be absent, not just total_phases.
    assert.strictEqual(
      output.progress && output.progress.total_phases,
      undefined,
      'total_phases must be withheld (no ROADMAP to derive it from), proving the guard truly had no denominator to compare against',
    );
    assert.strictEqual(
      output.progress && output.progress.completed_phases,
      undefined,
      'completed_phases is withheld too under #4094 (same untrustworthy scan, no stored value)',
    );
  });

  test('#3578 AC4: gsd_invoke_command (MCP dispatch) yields the same non-completed status as the CLI route (2 of 4 case)', () => {
    seed4PhaseMilestone(2);
    writeStateAtPhase(2);

    const res = handleMessage(
      {
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: { name: 'gsd_invoke_command', arguments: { family: 'state', subcommand: 'complete-phase', args: ['--phase', '2'] } },
      },
      { cwd: tmpDir },
    );
    assert.notStrictEqual(res.result.isError, true, `MCP dispatch must succeed: ${JSON.stringify(res.result)}`);
    // Same command, reached through a different dispatch surface (real
    // subprocess spawn via dispatchGsdCommand -> gsd-tools.cjs), must produce
    // the same on-disk effect as the CLI route above.
    JSON.parse(res.result.content[0].text);

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.notEqual(
      frontmatterStatus(after),
      'completed',
      `MCP-dispatched complete-phase must not set status completed while phases remain open; got frontmatter:\n${after}`,
    );
  });
});

describe('T6 section-splice characterization — milestone-switch', () => {
  const STATE_INLINE_MS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: OldMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 1 of 3',
    'Status: Executing Phase 1',
    '',
  ].join('\n');

  const STATE_NO_POSITION_MS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: OldMilestone',
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('milestone-switch updates milestone and milestone_name in frontmatter (position present)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_MS);
      const result = runGsdTools(['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'NextMilestone'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.switched, true, 'switched must be true');
      assert.strictEqual(output.version, 'v2.0', 'version must be v2.0');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^milestone:\s+v2\.0/m.test(after), 'frontmatter milestone must be v2.0');
      assert.ok(/^milestone_name:\s+NextMilestone/m.test(after), 'frontmatter milestone_name must be NextMilestone');
      assert.ok(/^status:\s+planning/m.test(after), 'frontmatter status must be reset to planning on milestone switch');
    } finally {
      cleanup(d);
    }
  });

  test('milestone-switch updates frontmatter when Current Position is absent', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_POSITION_MS);
      const result = runGsdTools(['state', 'milestone-switch', '--milestone', 'v3.0'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.switched, true, 'switched must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^milestone:\s+v3\.0/m.test(after), 'frontmatter milestone must be v3.0');
    } finally {
      cleanup(d);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1761-state-sync-wrong-progress.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1761-state-sync-wrong-progress (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// Regression test for issue #1761 — `state sync` silently writes wrong progress
// when ROADMAP lacks versioned milestone headings.
//
// ADR-1769 Phase 7 fix: when getMilestonePhaseFilter().missingExplicitVersion is
// true (the current milestone cannot be bounded to a versioned phase set), the
// sync transition leaves Progress untouched (percent=null) rather than silently
// computing/writing values off a fallback milestone.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function buildStateWithProgress({ percent = 50 } = {}) {
  const barWidth = 10;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Test',
    'current_phase: "3"',
    'status: executing',
    'progress:',
    '  total_phases: 10',
    '  completed_phases: 5',
    `  percent: ${percent}`,
    '---',
    '',
    '# GSD State',
    '',
    '**Current Phase:** 3',
    '**Total Plans in Phase:** 4',
    '**Current Plan:** 2',
    '**Status:** Executing Phase 3',
    '**Last Activity:** 2026-06-20',
    `**Progress:** [${bar}] ${percent}%`,
    '',
  ].join('\n');
}

// ROADMAP with an UNVERSIONED milestone heading (no vX.Y) — the #1761 trigger.
function buildUnversionedRoadmap(numPhases) {
  const lines = ['# ROADMAP', '', '## Milestone 1: Test Milestone', ''];
  for (let i = 1; i <= numPhases; i++) {
    lines.push(`### Phase ${i}: phase-${i}`);
    lines.push('');
  }
  return lines.join('\n');
}

function readBodyProgress(statePath) {
  const m = fs.readFileSync(statePath, 'utf-8').match(/\*\*Progress:\*\*\s*(.*)/);
  return m ? m[1].trim() : null;
}

describe('#1761: state sync leaves Progress untouched when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('sync does NOT rewrite the Progress bar when ROADMAP lacks a versioned milestone heading', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithProgress({ percent: 50 }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), buildUnversionedRoadmap(10));

    // Seed disk: 2 of 10 phases fully summarized → if sync naively recomputes,
    // it would write ~20%, clobbering the curated 50% (#1761).
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (let i = 1; i <= 2; i++) {
      const dir = path.join(phasesDir, String(i).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), '# Summary\n');
    }

    const before = readBodyProgress(statePath);
    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);
    const after = readBodyProgress(statePath);

    assert.strictEqual(after, before,
      `Progress must be left untouched when the milestone is unbounded; before=${JSON.stringify(before)} after=${JSON.stringify(after)} (#1761)`);
  });
});

// #1761 read-path: the ADR-1769 Phase 7 fix (#1794) closed the `state sync`
// WRITE path, but `state json` (the READ path) rebuilds progress via
// buildStateFrontmatter, whose roadmapPhaseCount loop counts phase headings
// across the WHOLE document when extractCurrentMilestone can't bound the
// asserted milestone. Result: state json reported a conflated total_phases
// (sum of sibling milestones) + a derived percent, contradicting the sync
// guard. This block mirrors the write-path guard on the read path.
describe('#1761 read-path: state json does not conflate progress when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('state json omits percent and does NOT report the conflated whole-doc total_phases', () => {
    // Repro from the issue: STATE.md asserts milestone: v2.0; ROADMAP has two
    // UNVERSIONED sibling milestones (4 + 4 phases) — neither matches v2.0, so
    // the milestone is unbounded. One summarized phase dir on disk.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.0',
      'milestone_name: Second',
      'current_phase: "2"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 2',
      '**Status:** Executing Phase 2',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone',
      '### Phase 1: a',
      '### Phase 2: b',
      '### Phase 3: c',
      '### Phase 4: d',
      '## Milestone 2: Second Milestone',
      '### Phase 5: e',
      '### Phase 6: f',
      '### Phase 7: g',
      '### Phase 8: h',
      '',
    ].join('\n'));
    // One summarized phase dir on disk.
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // BEFORE the fix this printed progress.total_phases: 8 (4+4 sibling
    // milestones) and percent: 13 — exactly the conflated read-path the sync
    // guard was added to prevent.
    assert.ok(
      out.progress === undefined || out.progress.percent === undefined,
      `state json must omit percent when the milestone is unbounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.ok(
      !(out.progress && out.progress.total_phases === 8),
      `state json must NOT report the conflated whole-doc total_phases (8 = 4+4 sibling milestones); got total_phases=${out.progress && out.progress.total_phases}`,
    );
  });

  test('state json still reports percent + total_phases when the milestone IS bounded (versioned ROADMAP)', () => {
    // Control: a versioned ROADMAP heading matching the asserted milestone
    // keeps the read path unchanged — the guard only fires when unbounded.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: First',
      'current_phase: "1"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 1',
      '**Status:** Executing Phase 1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone v1.0',
      '### Phase 1: a',
      '### Phase 2: b',
      '',
    ].join('\n'));
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(
      out.progress && typeof out.progress.percent === 'number',
      `state json must report a numeric percent when the milestone is bounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.strictEqual(
      out.progress.total_phases,
      2,
      'bounded read path must report the versioned milestone phase count (2)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2630-state-frontmatter-milestone-switch.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2630-state-frontmatter-milestone-switch (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #2630
 *
 * Regression guard: `state milestone-switch` resets STATE.md YAML frontmatter
 * (milestone, milestone_name, status, progress.*) AND the `## Current Position`
 * body in a single atomic write. Prior to the fix, the `/gsd:new-milestone`
 * workflow rewrote the body but left the frontmatter pointing at the previous
 * milestone, so every downstream reader (state.json, getMilestoneInfo, etc.)
 * reported the stale milestone.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const STALE_STATE = `---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Foundation
status: completed
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 12
  completed_plans: 12
  percent: 100
---

# Project State

## Current Position

Phase: 5 (Foundation) — COMPLETED
Plan: 3 of 3
Status: v1.0 milestone complete
Last activity: 2026-04-20 -- v1.0 shipped

## Accumulated Context

### Decisions

- [Phase 1]: Use Node 20
`;

describe('state milestone-switch (#2630)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      STALE_STATE,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.1 Notifications\n\n### Phase 6: Notify\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{}',
      'utf-8',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes new milestone into frontmatter and resets progress + Current Position', () => {
    const result = runGsdTools(
      ['state', 'milestone-switch', '--milestone', 'v1.1', '--name', 'Notifications'],
      tmpDir,
    );
    assert.equal(result.success, true, result.error || result.output);

    const after = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    // Frontmatter reflects the NEW milestone — the core of bug #2630.
    assert.match(after, /^milestone:\s*v1\.1\s*$/m, 'frontmatter milestone not switched');
    assert.match(
      after,
      /^milestone_name:\s*Notifications\s*$/m,
      'frontmatter milestone_name not switched',
    );
    assert.match(after, /^status:\s*planning\s*$/m, 'status not reset to planning');
    // Progress counters reset to zero.
    assert.match(after, /^\s*completed_phases:\s*0\s*$/m, 'completed_phases not reset');
    assert.match(after, /^\s*completed_plans:\s*0\s*$/m, 'completed_plans not reset');
    assert.match(after, /^\s*percent:\s*0\s*$/m, 'percent not reset');

    // Body Current Position reset to the new-milestone template.
    assert.match(after, /Status:\s*Defining requirements/, 'body Status not reset');
    assert.match(
      after,
      /Phase:\s*Not started \(defining requirements\)/,
      'body Phase not reset',
    );

    // Accumulated Context is preserved.
    assert.match(after, /\[Phase 1\]:\s*Use Node 20/, 'Accumulated Context lost');
  });

  test('rejects missing --milestone', () => {
    const result = runGsdTools(
      ['state', 'milestone-switch', '--name', 'Something'],
      tmpDir,
    );
    // gsd-tools emits JSON with { error: ... } to stdout even on error paths.
    const combined = (result.output || '') + (result.error || '');
    assert.match(combined, /milestone required/i);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3286-state-write-routing.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3286-state-write-routing (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// Regression tests for issue #3286 — three bugs in state.cjs:
//
// Bug A: cmdStateRecordMetric / cmdStateAddDecision return { recorded: false }
//   with exit code 0 when their target section is absent. gsd-executor treats
//   exit 0 as success, silently losing metrics/decisions across an entire phase.
//   Fix: auto-create the missing section (Bug B subsumes A — silent no-op
//   disappears). When auto-created, JSON must include created: true.
//
// Bug B: A fresh STATE.md without ## Performance Metrics or ## Decisions causes
//   both verbs to silently no-op. DWIM: auto-create the canonical section scaffold
//   and then write the row/entry, matching state begin-phase / advance-plan behavior.
//
// Bug C: state record-metric and add-decision must honor --ws <name>, routing
//   writes to .planning/workstreams/<name>/STATE.md instead of root STATE.md.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal STATE.md with all canonical sections */
function buildFullStateMd() {
  return [
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 1',
    'Current Phase Name: bootstrap',
    'Total Plans in Phase: 3',
    'Current Plan: 1',
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
    '## Performance Metrics',
    '',
    '| Phase | Plan | Duration | Notes |',
    '|-------|------|----------|-------|',
    '',
    '## Decisions',
    '',
    'None yet.',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');
}

/** Build a STATE.md WITHOUT Performance Metrics or Decisions sections */
function buildBareboneStateMd() {
  return [
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 1',
    'Current Phase Name: bootstrap',
    'Total Plans in Phase: 3',
    'Current Plan: 1',
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Group B: auto-create missing sections (DWIM)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug B: record-metric auto-creates ## Performance Metrics when missing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric succeeds when ## Performance Metrics is absent', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '45min'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric must succeed (exit 0), got: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true, got: ${JSON.stringify(parsed)}`);
  });

  test('record-metric with created:true when section was auto-created', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '45min'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.created, true, `JSON must include created:true when section was auto-created`);
  });

  test('record-metric appends row into auto-created section — verifiable via state snapshot', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '2', '--duration', '30min', '--tasks', '5'],
      tmpDir,
    );
    assert.ok(result.success, `record-metric must succeed, got: ${result.error}`);

    // Verify the metric appeared in the file by calling state get to read the section
    const getResult = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(getResult.success, `state get must succeed, got: ${getResult.error}`);

    // Parse JSON to check structural content (no .includes on raw file)
    const sectionContent = JSON.parse(getResult.output);
    const sectionText = sectionContent['Performance Metrics'] || '';
    // Must contain a row referencing Phase 1 P2
    assert.ok(
      sectionText.includes('Phase 1 P2') || sectionText.includes('| Phase 1 P2'),
      `Performance Metrics section must contain the appended row. Got section: ${sectionText}`,
    );
  });

  test('record-metric on state with existing section still works (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildFullStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '2', '--plan', '1', '--duration', '1h'],
      tmpDir,
    );
    assert.ok(result.success, `record-metric must succeed on existing section, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);
    // created should be absent or false when section already existed
    assert.ok(!parsed.created, `created must be absent/false when section existed`);
  });
});

describe('#3286 Bug B: add-decision auto-creates ## Decisions when missing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('add-decision succeeds when ## Decisions is absent', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use TypeScript for type safety'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must succeed (exit 0), got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true, got: ${JSON.stringify(parsed)}`);
  });

  test('add-decision with created:true when section was auto-created', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use Redis for caching'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.created, true, `JSON must include created:true when Decisions section auto-created`);
  });

  test('add-decision appended entry is visible in state get', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const summary = 'Adopt PostgreSQL over MySQL for JSONB support';
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '2', '--summary', summary],
      tmpDir,
    );
    assert.ok(result.success, `add-decision must succeed, got: ${result.error}`);

    // Verify via state get (structured), not raw file grep
    const getResult = runGsdTools(['state', 'get', 'Decisions'], tmpDir);
    assert.ok(getResult.success, `state get Decisions must succeed, got: ${getResult.error}`);

    const sectionContent = JSON.parse(getResult.output);
    const sectionText = sectionContent['Decisions'] || '';
    assert.ok(
      sectionText.includes(summary),
      `Decisions section must contain the appended decision. Got: ${sectionText}`,
    );
  });

  test('add-decision on state with existing Decisions section works (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildFullStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use monorepo layout'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision must succeed on existing section, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true`);
    assert.ok(!parsed.created, `created must be absent/false when section already existed`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group A: exit code contract (covered by Bug B fix — no silent no-op)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug A: record-metric / add-decision never silently no-op', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric always has recorded:true (never silent false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Minimal state — no Performance Metrics section
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '20min'],
      tmpDir,
    );

    // Must exit 0 AND recorded must be true (auto-created or found)
    assert.ok(result.success, `record-metric must exit 0, got stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.recorded,
      true,
      `recorded must be true — section auto-create should prevent silent false. Got: ${JSON.stringify(parsed)}`,
    );
  });

  test('add-decision always has added:true (never silent false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Prefer composition over inheritance'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must exit 0, got stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.added,
      true,
      `added must be true — section auto-create should prevent silent false. Got: ${JSON.stringify(parsed)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group C: workstream routing — writes go to workstream STATE.md, not root
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug C: record-metric / add-decision honor --ws routing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();

    // Create root STATE.md with Performance Metrics + Decisions sections
    const rootStatePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(rootStatePath, buildFullStateMd());

    // Create workstream foo with its own STATE.md (full sections)
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'foo');
    fs.mkdirSync(wsDir, { recursive: true });
    const wsStatePath = path.join(wsDir, 'STATE.md');
    fs.writeFileSync(wsStatePath, buildFullStateMd());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric --ws foo writes to workstream STATE.md, not root', () => {
    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '10min', '--ws', 'foo'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric --ws foo must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);

    // Workstream STATE.md should have the row; root STATE.md should NOT
    const rootGet = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(rootGet.success, `state get root must succeed, got: ${rootGet.error}`);
    const rootContent = JSON.parse(rootGet.output)['Performance Metrics'] || '';
    assert.ok(
      !rootContent.includes('Phase 1 P1'),
      `Root STATE.md must NOT have the metric row. Got: ${rootContent}`,
    );

    const wsGet = runGsdTools(['state', 'get', 'Performance Metrics', '--ws', 'foo'], tmpDir);
    assert.ok(wsGet.success, `state get --ws foo must succeed, got: ${wsGet.error}`);
    const wsContent = JSON.parse(wsGet.output)['Performance Metrics'] || '';
    assert.ok(
      wsContent.includes('Phase 1 P1'),
      `Workstream foo STATE.md must have the metric row. Got: ${wsContent}`,
    );
  });

  test('add-decision --ws foo writes to workstream STATE.md, not root', () => {
    const summary = 'Adopt event-sourcing for audit trail';
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', summary, '--ws', 'foo'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision --ws foo must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true`);

    // Root STATE.md must NOT have the decision
    const rootGet = runGsdTools(['state', 'get', 'Decisions'], tmpDir);
    assert.ok(rootGet.success, `state get root must succeed, got: ${rootGet.error}`);
    const rootContent = JSON.parse(rootGet.output)['Decisions'] || '';
    assert.ok(
      !rootContent.includes(summary),
      `Root STATE.md must NOT have the decision. Got: ${rootContent}`,
    );

    // Workstream STATE.md must have the decision
    const wsGet = runGsdTools(['state', 'get', 'Decisions', '--ws', 'foo'], tmpDir);
    assert.ok(wsGet.success, `state get --ws foo must succeed, got: ${wsGet.error}`);
    const wsContent = JSON.parse(wsGet.output)['Decisions'] || '';
    assert.ok(
      wsContent.includes(summary),
      `Workstream foo STATE.md must have the decision. Got: ${wsContent}`,
    );
  });

  test('record-metric --ws foo auto-creates section in workstream STATE.md when missing', () => {
    // Create a workstream without Performance Metrics section
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'bar');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '5min', '--ws', 'bar'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric --ws bar must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);
    assert.strictEqual(parsed.created, true, `created must be true when section auto-created in workstream`);

    // Root STATE.md must remain untouched
    const rootGet = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(rootGet.success);
    const rootContent = JSON.parse(rootGet.output)['Performance Metrics'] || '';
    assert.ok(
      !rootContent.includes('Phase 1 P1'),
      `Root STATE.md must not be written when --ws bar is used`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3454-state-dollar-backreference-growth.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3454-state-dollar-backreference-growth (consolidation epic #1969 B2 #1971)", () => {
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function seedState(tmpDir, planLine = '1 of 2') {
  const state = `# Project State

**Status:** executing
**Current Phase:** 1

## Current Position
Phase: 1 of 1
Plan: ${planLine}
Status: Ready
Last activity: 2026-01-01
Budget: $2,500 max test

## Session Continuity
Last session: 2026-01-01
`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), state, 'utf8');
}

function parseStateFile(tmpDir) {
  const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
  const sections = {};
  const keyCountsBySection = {};
  let currentSection = '__root__';
  sections[currentSection] = {};
  keyCountsBySection[currentSection] = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const headingMatch = /^##\s+(.+)$/u.exec(rawLine);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      sections[currentSection] = sections[currentSection] || {};
      keyCountsBySection[currentSection] = keyCountsBySection[currentSection] || {};
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const boldFieldMatch = /^\*\*([^*]+)\*\*:\s*(.*)$/u.exec(trimmed);
    if (boldFieldMatch) {
      const key = boldFieldMatch[1].trim();
      const value = boldFieldMatch[2].trim();
      sections[currentSection][key] = value;
      keyCountsBySection[currentSection][key] = (keyCountsBySection[currentSection][key] || 0) + 1;
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    sections[currentSection][key] = value;
    keyCountsBySection[currentSection][key] = (keyCountsBySection[currentSection][key] || 0) + 1;
  }

  return { content, sections, keyCountsBySection };
}

describe('bug #3454: state mutation must preserve literal $N amounts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-3454-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state advance-plan keeps Current Position dollar amount literal', () => {
    seedState(tmpDir, '1 of 20');
    const result = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.equal(result.success, true, `state advance-plan failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('state begin-phase keeps Current Position dollar amount literal', () => {
    seedState(tmpDir);
    const result = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '2'], tmpDir);
    assert.equal(result.success, true, `state begin-phase failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('state complete-phase keeps Current Position dollar amount literal', () => {
    seedState(tmpDir);
    const result = runGsdTools(['state', 'complete-phase', '--phase', '1'], tmpDir);
    assert.equal(result.success, true, `state complete-phase failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('repeated state advance-plan stays size-bounded with dollar amounts', () => {
    seedState(tmpDir, '1 of 20');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    let stabilizedSize = null;
    for (let i = 0; i < 8; i += 1) {
      const result = runGsdTools(['state', 'advance-plan'], tmpDir);
      assert.equal(result.success, true, `iteration ${i + 1} failed: ${result.error || result.output}`);
      if (i === 0) stabilizedSize = fs.statSync(statePath).size;
    }

    const endSize = fs.statSync(statePath).size;
    const growth = endSize / stabilizedSize;
    assert.ok(growth <= 1.5, `expected <=1.5x growth after first write, got ${growth.toFixed(2)}x (${stabilizedSize} -> ${endSize})`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3489-complete-phase-idempotent.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3489-complete-phase-idempotent (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for #3489
 *
 *   `gsd state complete-phase --phase <N>` was non-idempotent. Re-invoking it
 *   on a phase already marked complete in STATE.md silently rolled STATE.md
 *   back to that phase's moment-of-completion — overwriting Status, Last
 *   Activity, Current Position and the body Status/Phase with stale values
 *   derived from the just-completed phase.
 *
 *   Expected: when the target phase is already marked complete (and STATE.md
 *   has clearly advanced past it — e.g. a later phase is now in progress or
 *   inserted), `complete-phase` must be a no-op. No STATE.md write at all.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

describe('bug #3489: state complete-phase must be idempotent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-3489-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('re-running complete-phase on an already-complete phase does not roll STATE.md back', () => {
    // STATE.md as it would appear AFTER phase 02.2 was legitimately completed
    // AND a follow-up Phase 02.2.1 has since been inserted as in-progress.
    // Re-invoking `state complete-phase --phase 02.2` from a downstream tool
    // (e.g. a re-run of /gsd-execute-phase) must NOT regress this content.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 02.2.1',
      '**Last Activity:** 2026-05-13',
      '**Last Activity Description:** Phase 02.2.1 inserted (urgent — gates Phase 5)',
      '',
      '## Current Position',
      '',
      'Phase: 02.2.1 — Not planned yet',
      'Status: Phase 02.2.1 inserted (urgent — gates Phase 5)',
      'Last activity: 2026-05-13 -- Phase 02.2.1 inserted (urgent — gates Phase 5)',
      '',
    ].join('\n');

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd, 'utf8');
    const before = fs.readFileSync(statePath, 'utf8');

    const result = runGsdTools(['state', 'complete-phase', '--phase', '02.2'], tmpDir);
    assert.ok(result.success, `command should not error, got: ${result.error || result.output}`);

    const after = fs.readFileSync(statePath, 'utf8');

    // Hard assertion: file is byte-identical to its pre-call snapshot.
    assert.equal(
      after,
      before,
      `STATE.md must not be rewritten when phase is already complete.\n\n--- before ---\n${before}\n--- after ---\n${after}`,
    );

    // Output should advertise the no-op so downstream consumers can detect it.
    let payload = null;
    try { payload = JSON.parse(result.output); } catch (_) { /* ignore */ }
    assert.ok(payload && typeof payload === 'object', `expected JSON payload, got: ${result.output}`);
    assert.deepEqual(payload.updated, [], `expected empty updated list, got: ${JSON.stringify(payload.updated)}`);
    assert.equal(payload.phase, '02.2');
    assert.equal(payload.idempotent, true, `expected idempotent:true flag, got: ${JSON.stringify(payload)}`);
  });

  test('completing the currently in-progress phase still works normally (no false-positive idempotency)', () => {
    // Sanity check: the guard must not fire on the legitimate first completion.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 03',
      '**Last Activity:** 2026-05-13',
      '',
      '## Current Position',
      '',
      'Phase: 03',
      'Status: Phase 03 executing',
      '',
    ].join('\n');

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd, 'utf8');

    const result = runGsdTools(['state', 'complete-phase', '--phase', '03'], tmpDir);
    assert.ok(result.success, `command failed: ${result.error || result.output}`);

    const after = fs.readFileSync(statePath, 'utf8');
    assert.equal(
      stateExtractField(after, 'Status'),
      'Phase 03 complete',
      `expected Status updated to "Phase 03 complete", got:\n${after}`,
    );

    const payload = JSON.parse(result.output);
    assert.notEqual(payload.idempotent, true, 'first completion must not be flagged idempotent');
    assert.ok(Array.isArray(payload.updated) && payload.updated.length > 0, 'expected non-empty updated list');
  });

  test('a thrown extractFrontmatter refuses complete-phase rather than risking a destructive rollback (#3489)', (t) => {
    // The fail-closed refusal this exercises: if the frontmatter half of the
    // chain cannot be consulted, `existingCurrentPhase` could read as null
    // even though the project's true current phase lives only in that
    // unreadable frontmatter, which would let the idempotency guard above
    // fail OPEN and re-run an already-completed phase. cmdStateCompletePhase
    // refuses outright instead. extractFrontmatter is documented never to
    // throw for real STATE.md content, so this is driven directly by
    // mocking the frontmatter module's export — see B12's identical
    // require-cache-busting rationale in tests/state.test.cjs (state.cts
    // destructures `extractFrontmatter` at require time, so mocking the
    // already-required `frontmatterLib` export has no effect on the
    // top-level `stateLib` binding; a fresh module instance, required AFTER
    // the mock is installed, is needed to observe it).
    const stateMd = [
      '# State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 03',
      '**Last Activity:** 2026-05-13',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd, 'utf8');
    const before = fs.readFileSync(statePath, 'utf8');

    const stateCjsPath = require.resolve('../gsd-core/bin/lib/state.cjs');
    delete require.cache[stateCjsPath];
    mock.method(frontmatterLib, 'extractFrontmatter', () => {
      throw new Error('simulated frontmatter parse failure');
    });
    t.after(() => {
      mock.restoreAll();
      delete require.cache[stateCjsPath];
    });
    const freshStateLib = require(stateCjsPath);

    const raw = captureStdout(() => freshStateLib.cmdStateCompletePhase(tmpDir, false, '03'));
    const output = JSON.parse(raw);
    assert.match(
      output.error || '',
      /refusing to run complete-phase/i,
      `expected the #3489 refuse-path error, got: ${raw}`,
    );

    const after = fs.readFileSync(statePath, 'utf8');
    assert.equal(after, before, 'STATE.md must not be rewritten when frontmatter could not be read');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-397-state-preserve-executor-authored.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-397-state-preserve-executor-authored (consolidation epic #1969 B2 #1971)", () => {
'use strict';

// Regression tests for bug #397.
//
// STATE.md fields edited by an executor (e.g. a hand-authored Resume File path,
// a custom Status value, or a custom Last Activity entry) were silently overwritten
// by the next call to record-session, advance-plan, or planned-phase because the
// handlers used unconditional stateReplaceField / stateReplaceFieldWithFallback
// calls, even when the option was not passed by the caller.
//
// Fix: introduce KNOWN_TEMPLATE_DEFAULTS (a per-field table of string values that
// are safe to replace because they came from a template) and
// stateReplaceFieldIfTemplate (a helper that only replaces when the current value
// is a template default or absent). Handlers must consult this table rather than
// writing unconditionally.
//
// The 7 baseline cases verified here:
//
//  1. record-session WITHOUT --resume-file when Resume File is executor-authored
//     → preserved (must NOT be replaced with 'None')
//  2. record-session WITHOUT --resume-file when Resume File is 'None'
//     → remains 'None' (template-default → template-default is fine)
//  3. record-session WITH --resume-file → explicit caller value wins (always)
//  4. advance-plan phase-complete when Status is executor-authored → preserved
//  5. advance-plan phase-complete when Status is a known default → replaced
//  6. advance-plan advance when Last Activity is executor-authored → preserved
//  7. updateCurrentPositionFields with executor-authored Current Position values
//     → preserved

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');
const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { stripFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPlanning(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-397-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

function readState(dir) {
  return fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
}

function runGsdState(args, cwd) {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const env = {
    ...process.env,
    GSD_SESSION_KEY: '',
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SSE_PORT: '',
    OPENCODE_SESSION_ID: '',
  };
  const r = runNode([TOOLS_PATH, 'state', ...args], { cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.exitCode === 0) return { success: true };
  return { success: false, error: r.stderr.trim() || `exited with outcome=${r.outcome} exitCode=${r.exitCode}` };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Case 1: Resume File is executor-authored (not a template default)
const STATE_EXECUTOR_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: /home/user/my-custom-context.md
Stopped At: Phase 2 Plan 1 complete
`;

// Case 2: Resume File is 'None' (the known template default)
const STATE_DEFAULT_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
Stopped At: Phase 2 Plan 1 complete
`;

// Cases 4 & 7: Status is executor-authored in both Configuration and Current Position.
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch of advance-plan.
const STATE_EXECUTOR_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Awaiting QA sign-off before proceeding

## Current Position
Phase: 3
Plan: 2 of 2
Status: Awaiting QA sign-off before proceeding
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 5: Status IS a known template default ('Ready to execute').
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch.
const STATE_DEFAULT_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 3
Plan: 2 of 2
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 6: The only Last Activity field in the document is executor-authored
// (a narrative, not a bare ISO date). Current Plan=1, Total=3 → advance branch.
const STATE_EXECUTOR_LAST_ACTIVITY = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 3
Current Plan: 1
Status: Ready to execute
Last Activity: Unblocked after infra fix — merged PR #88 manually

## Current Position
Phase: 2
Plan: 1 of 3
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 7: Current Position has executor-authored Status and Last activity.
// Current Plan=2, Total=3 → advance branch.
const STATE_EXECUTOR_CURRENT_POSITION = `# GSD State

## Configuration
Current Phase: 4
Total Plans in Phase: 3
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 4
Plan: 2 of 3
Status: On hold — waiting for upstream dependency merge
Last activity: 2026-02-15 -- blocked by infra; resume after merge

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #397: executor-authored STATE.md fields must be preserved', () => {

  // Case 1: record-session without --resume-file, Resume File is executor-authored
  test('case 1: record-session without --resume-file preserves executor-authored Resume File', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan 1 complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const resumeFile = stateExtractField(after, 'Resume File');
      assert.ok(resumeFile, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        resumeFile,
        '/home/user/my-custom-context.md',
        `record-session overwrote executor-authored Resume File with '${resumeFile}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 2: record-session without --resume-file, Resume File is 'None' (template default)
  test('case 2: record-session without --resume-file keeps "None" when it is already "None"', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const resumeFile = stateExtractField(after, 'Resume File');
      assert.ok(resumeFile, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        resumeFile,
        'None',
        `Expected 'None' to remain when it was already 'None', got: ${resumeFile}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 3: record-session WITH --resume-file — explicit value always wins
  test('case 3: record-session with --resume-file sets the explicit value', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--resume-file', '/tmp/new-resume.md'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const resumeFile = stateExtractField(after, 'Resume File');
      assert.ok(resumeFile, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        resumeFile,
        '/tmp/new-resume.md',
        `Expected explicit --resume-file value to be written, got: ${resumeFile}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 4: advance-plan phase-complete, Status is executor-authored → preserved
  test('case 4: advance-plan (phase-complete) preserves executor-authored Status', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The Configuration-level Status must not be clobbered. Scope extraction
      // to the body (frontmatter stripped): the frontmatter `status:` key and
      // the body `Status:` field name collide case-insensitively under
      // stateExtractField's plain-line pattern (#1255's landmine — see
      // state-transition.cts), and frontmatter's `status` is a normalized
      // enum (normalizeStateStatus), not the executor-authored prose this
      // assertion is proving was preserved.
      const status = stateExtractField(stripFrontmatter(after), 'Status');
      assert.ok(status, 'Status field not found after advance-plan');
      assert.strictEqual(
        status,
        'Awaiting QA sign-off before proceeding',
        `advance-plan overwrote executor-authored Status: got '${status}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 5: advance-plan phase-complete, Status is a known default → replaced
  test('case 5: advance-plan (phase-complete) replaces known-default Status with phase-complete value', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // Scope extraction to the body (frontmatter stripped): stateExtractField's
      // plain-line pattern matches the frontmatter `status:` key before the body
      // `Status:` field (case-insensitive collision — #1255). Frontmatter status
      // is normalizeStateStatus's coarser enum (e.g. both "Verifying Phase N"
      // and "Phase complete — ready for verification" normalize to the SAME
      // 'verifying' value), so asserting it here would be a WEAKER check than
      // the body prose this test exists to prove was replaced.
      const status = stateExtractField(stripFrontmatter(after), 'Status');
      assert.ok(status, 'Status field not found after advance-plan');
      // 'Ready to execute' is a known default and should be replaced
      assert.notStrictEqual(
        status,
        'Ready to execute',
        `Status should have been updated from 'Ready to execute' after phase-complete, but was not`,
      );
      assert.ok(
        status.includes('Phase complete') || status.includes('ready for verification'),
        `Expected phase-complete Status text, got: '${status}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 6: advance-plan normal advance, top-level Last Activity is executor-authored → preserved
  test('case 6: advance-plan (normal advance) preserves executor-authored Last Activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_LAST_ACTIVITY);
    try {
      // Current Plan=1, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The top-level Last Activity (in Configuration section) must be preserved
      const lastActivity = stateExtractField(after, 'Last Activity');
      assert.ok(lastActivity, 'Last Activity field not found after advance-plan');
      assert.strictEqual(
        lastActivity,
        'Unblocked after infra fix — merged PR #88 manually',
        `advance-plan overwrote executor-authored Last Activity: got '${lastActivity}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 7: advance-plan preserves executor-authored Status and Last activity in Current Position
  test('case 7: advance-plan preserves executor-authored Current Position Status and Last activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_CURRENT_POSITION);
    try {
      // Current Plan=2, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      const section = collectSection(after, (h) => h.text.trim() === 'Current Position');
      assert.ok(section, 'Current Position section not found after advance-plan');
      const posBody = section.body;
      const posStatus = stateExtractField(posBody, 'Status');
      assert.ok(posStatus, 'Status field not found in Current Position section');
      assert.strictEqual(
        posStatus,
        'On hold — waiting for upstream dependency merge',
        `advance-plan overwrote executor-authored Current Position Status: got '${posStatus}'`,
      );
      const posActivity = stateExtractField(posBody, 'Last activity');
      assert.ok(posActivity, 'Last activity field not found in Current Position section');
      assert.ok(
        posActivity.includes('blocked by infra'),
        `advance-plan overwrote executor-authored Current Position Last activity: got '${posActivity}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-905-state-syncstatefrontmatter-preserve-scalars.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-905-state-syncstatefrontmatter-preserve-scalars (consolidation epic #1969 B2 #1971)", () => {
'use strict';
/**
 * Regression guard for bug #905.
 *
 * `syncStateFrontmatter` (src/state.cts) only preserved `status` from existing
 * frontmatter when the body-derived value was missing/unknown. The scalars
 * `current_phase`, `current_phase_name`, `current_plan`, and `progress` were
 * silently stripped whenever `buildStateFrontmatter` could not extract them from
 * the body text — e.g. when an agent removed the bold `**Current Phase:**`
 * annotations.
 *
 * Fix: mirror the `cmdStateJson` fallback pattern in `syncStateFrontmatter` so
 * that all four scalars survive a `writeStateMd` / `state sync` call when the
 * body no longer carries the annotation but the existing frontmatter does.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A STATE.md whose YAML frontmatter holds all four scalars but whose body
 * does NOT contain the bold `**Current Phase:**` / `**Current Plan:**`
 * annotations that `buildStateFrontmatter` uses to re-derive them.
 *
 * This is the exact scenario that triggered the bug: the body has already lost
 * the annotations (e.g. because a CLI tool or agent overwrote it), but the
 * frontmatter still holds the ground-truth values. A subsequent `state sync`
 * (or any `writeStateMd` call) must not strip them.
 */
function buildStateMdWithoutBodyAnnotations(opts) {
  const {
    currentPhase = 3,
    currentPhaseName = 'Implementation',
    currentPlan = 2,
    progressPercent = 42,
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    `current_phase: ${currentPhase}`,
    `current_phase_name: ${currentPhaseName}`,
    `current_plan: ${currentPlan}`,
    'status: executing',
    'progress:',
    `  total_phases: 5`,
    `  completed_phases: 2`,
    `  total_plans: 10`,
    `  completed_plans: 4`,
    `  percent: ${progressPercent}`,
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    // Intentionally omitting "Current Phase:", "Current Phase Name:",
    // "Current Plan:" body annotations to reproduce the bug scenario.
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use Node 22',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('#905: syncStateFrontmatter preserves scalars when body annotations are absent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves current_phase from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 3 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '3',
      `current_phase must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('state sync preserves current_phase_name from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhaseName: 'Implementation' }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase_name,
      'Implementation',
      `current_phase_name must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase_name)})`,
    );
  });

  test('state sync preserves current_plan from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPlan: 2 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_plan,
      '2',
      `current_plan must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_plan)})`,
    );
  });

  test('state update (resync:false) preserves curated progress from existing frontmatter when body lacks disk-scan data', () => {
    // state update "Last Activity" calls readModifyWriteStateMd with resync:false.
    // That path runs syncStateFrontmatter and then explicitly re-applies the
    // pre-existing progress block (lines 1243-1253 of state.cts). The curated
    // progress values must survive even though the phases dir is empty.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ progressPercent: 42 }));

    // Add body annotation for Last Activity so state update can find and replace it
    const initial = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, initial.replace('Last Activity: 2026-01-01', 'Last Activity: 2026-01-01'));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must retain a progress block after body-only update');
    // shouldPreserveExistingProgress: existing completed_plans (4) > derived (0 from empty disk)
    // → curated block survives via cmdStateJson read-path fallback.
    assert.strictEqual(
      fm.progress.completed_plans,
      4,
      `progress.completed_plans must be preserved via shouldPreserveExistingProgress ` +
      `(got: ${JSON.stringify(fm.progress?.completed_plans)})`,
    );
  });

  test('state update field preserves current_phase frontmatter when body lacks annotation', () => {
    // Trigger the write path via `state update` (which calls readModifyWriteStateMd
    // with resync:true), confirming the fix covers every write path.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 7 }));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '7',
      `current_phase must survive a state.update write (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('body annotation beats existing frontmatter when both are present', () => {
    // When the body DOES carry the annotation, the derived value wins — we must
    // not accidentally lock stale frontmatter in place.
    // IMPORTANT: assert on the raw written STATE.md file (not just state json,
    // which rebuilds from the body and would return body-derived values regardless
    // of what syncStateFrontmatter wrote to disk).
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter says phase 3; body says phase 5. Body should win.
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 3',
      'current_phase_name: Old Phase',
      'current_plan: 1',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 5',
      'Current Phase Name: New Phase',
      'Current Plan: 2',
      'Status: Executing',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n'));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Assert on raw file: body-derived values must be written to frontmatter,
    // not the stale existing values. This guards against a fallback that locks
    // in stale data even when buildStateFrontmatter successfully derived values.
    const writtenContent = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(writtenContent);
    assert.strictEqual(
      rawFm.current_phase,
      '5',
      `body-derived current_phase (5) must be written to raw frontmatter (not stale 3), got: ${JSON.stringify(rawFm.current_phase)}`,
    );
    assert.strictEqual(
      rawFm.current_phase_name,
      'New Phase',
      `body-derived current_phase_name must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_phase_name)}`,
    );
    assert.strictEqual(
      rawFm.current_plan,
      '2',
      `body-derived current_plan must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_plan)}`,
    );
  });

  test('syncStateFrontmatter preserves progress from existing frontmatter when disk has no phases dir', () => {
    // Directly exercises the !derivedFm['progress'] fallback in syncStateFrontmatter.
    // Without a phases dir, buildStateFrontmatter returns no progress block at all
    // (the existsSync guard at line ~927 short-circuits the disk scan). The
    // existing frontmatter's progress must then survive the writeStateMd call.
    // Use createTempDir (no phases dir) and set up .planning/ manually.
    const dir = createTempDir('gsd-905-nophasesdir-');
    try {
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      const statePath = path.join(dir, '.planning', 'STATE.md');

      // Body has the "Current Phase:" annotation so cmdStateSync can proceed;
      // the progress block is ONLY in frontmatter (no ROADMAP, no phases dir).
      fs.writeFileSync(statePath, [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 2',
        'status: executing',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 1',
        '  total_plans: 8',
        '  completed_plans: 3',
        '  percent: 38',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 2',
        'Status: Executing',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'));

      // state update "Last Activity" → readModifyWriteStateMd (resync:true for
      // Progress/Total Phases/Total Plans fields, but resync:false for Last Activity)
      // This calls syncStateFrontmatter; without phases dir, buildStateFrontmatter
      // produces no progress → !derivedFm['progress'] guard fires → existing preserved.
      const updateResult = runGsdTools(
        ['state', 'update', 'Last Activity', '2026-06-08'],
        dir,
      );
      assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

      // Assert on the raw frontmatter file — cmdStateJson would apply
      // shouldPreserveExistingProgress separately, so we must verify the on-disk state.
      const written = fs.readFileSync(statePath, 'utf8');
      const rawFm = parseFrontmatter(written);

      // The progress block must be present in the written frontmatter.
      // parseFrontmatter returns flat keys, so check the presence indicator.
      assert.ok(
        written.includes('progress:'),
        'progress block must be preserved in raw frontmatter when disk has no phases dir',
      );
      // percent: 38 should survive (no disk scan to overwrite it)
      assert.ok(
        written.includes('percent: 38'),
        `progress.percent: 38 must survive syncStateFrontmatter when no phases dir exists (raw: ${rawFm.progress})`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1230 regression suite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a STATE.md where:
 *  - frontmatter has an explicit status (e.g. 'completed') and optional stopped_at
 *  - body has a Status: field that is STALE relative to the frontmatter
 *    (e.g. "Verifying Phase 3" would derive 'verifying')
 * A subsequent incidental write must NOT revert the hand-set frontmatter status.
 */
function buildStateMd1230({ fmStatus = 'completed', fmStoppedAt = null, bodyStatus = 'Verifying Phase 3', bodyStoppedAt = null } = {}) {
  const fmLines = [
    '---',
    'gsd_state_version: 1.0',
    `status: ${fmStatus}`,
  ];
  if (fmStoppedAt) fmLines.push(`stopped_at: "${fmStoppedAt}"`);
  fmLines.push('---');

  const bodyLines = [
    '',
    '# GSD State',
    '',
    '## Configuration',
    `Status: ${bodyStatus}`,
    'Last Activity: 2026-01-01',
    `Current Phase: 3`,
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
  ];
  if (bodyStoppedAt) bodyLines.push(`**Stopped at:** ${bodyStoppedAt}`);
  bodyLines.push('');

  return [...fmLines, ...bodyLines].join('\n');
}

describe('bug #1230: readModifyWriteStateMd preserves frontmatter status/stopped_at when write does not change body source field', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) CORE: record-session with stale body Status leaves frontmatter status: completed intact
  test('(a) record-session does NOT revert frontmatter status: completed when body Status is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // frontmatter status: completed; body Status: Verifying Phase 3 (derives 'verifying')
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'record-session', '--stopped-at', 'Phase 3 final review checkpoint'],
      tmpDir,
    );
    assert.ok(result.success, `record-session failed: ${result.error}`);

    // Assert on raw file frontmatter — not state json (which re-derives)
    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after record-session (body Status unchanged); got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (b) add-decision (resync:true) with frontmatter status: completed, stale body → status preserved
  test('(b) add-decision (resync:true) does NOT revert frontmatter status: completed when body Status unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Use Node 22'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after add-decision; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (c) LEGITIMATE UPDATE NOT FROZEN: begin-phase changes body Status → frontmatter re-derived correctly.
  //
  // stateReplaceField(content, 'Status', ...) replaces the FIRST ^Status: match in the
  // full content (frontmatter + body). When the frontmatter has NO 'status:' key, the
  // match falls through to the body 'Status:' line, which IS changed. The delta then
  // fires (preBodyStatus ≠ postBodyStatus), the preservation guard is skipped, and
  // syncStateFrontmatter re-derives from the new body value as intended.
  test('(c) begin-phase changes body Status → frontmatter status reflects new body-derived value', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter intentionally has NO 'status:' key so stateReplaceField targets the body
    // 'Status:' line. After the transform, body Status becomes "Executing Phase 3" →
    // normalizeStateStatus → 'executing' must be written to frontmatter.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Ready to execute',
      'Last Activity: 2026-01-01',
      'Current Phase: 2',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      '',
      '## Current Position',
      '',
      'Phase: 2 (Planning) — READY',
      'Plan: 1 of 1',
      'Status: Ready to execute',
      'Last activity: 2026-01-01 -- Phase 2 planning complete',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '3', '--name', 'Execution'],
      tmpDir,
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // begin-phase changed body Status to "Executing Phase 3" → delta fired → re-derived → 'executing'
    assert.strictEqual(
      rawFm.status,
      'executing',
      `frontmatter status must be updated to 'executing' when begin-phase changes body Status; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (d) stopped_at: TRUE RED — frontmatter stopped_at preserved when body Stopped at differs
  //
  // Change C: this is a TRUE regression guard. Frontmatter stopped_at ("Phase 7 verified PASS")
  // differs from the body ## Session "Stopped at:" value ("Phase 3 work"). The write operation
  // (add-decision) does NOT touch the Session Stopped at line. The delta heuristic must detect
  // that the Session Stopped at did NOT change (pre == post == "Phase 3 work") and therefore
  // preserve the frontmatter value "Phase 7 verified PASS". Pre-fix code would REVERT to
  // "Phase 3 work" (the body-derived value) — making this a genuine red.
  test('(d) add-decision preserves frontmatter stopped_at when body Session Stopped at differs from frontmatter and is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: completed',
      'stopped_at: "Phase 7 verified PASS"',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Phase 3 complete',
      'Last Activity: 2026-01-01',
      'Current Phase: 3',
      '',
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      // body Session Stopped at is STALE (different from frontmatter stopped_at)
      '**Stopped at:** Phase 3 work',
      '**Resume file:** None',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // add-decision does NOT touch ## Session Stopped at → pre and post body value identical
    // ("Phase 3 work" unchanged) → delta fires → frontmatter "Phase 7 verified PASS" preserved.
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Preserve stopped_at check'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.stopped_at,
      'Phase 7 verified PASS',
      `frontmatter stopped_at must be preserved ("Phase 7 verified PASS") when body Session Stopped at ` +
      `is unchanged (stale "Phase 3 work"); got: ${JSON.stringify(rawFm.stopped_at)}`,
    );
  });

  // (f) PRODUCTION-PATH: legitimate status transition is NOT frozen by the delta heuristic.
  //
  // Change A: prove that begin-phase on a STATE.md with inline "Status: Executing Phase 1"
  // (the standard template format) correctly transitions frontmatter status from
  // 'executing' to a new 'executing' value when the body Status CHANGES.
  // More critically: also verify a complete-phase → frontmatter becomes 'completed'
  // when the body Status field IS changed. This locks in that the delta heuristic
  // re-derives correctly whenever the body's Status source field actually changes.
  test('(f) begin-phase changes inline body Status → delta fires → frontmatter status updated (not frozen)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Realistic STATE.md: frontmatter status: executing, body Status: Executing Phase 1 (inline format)
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_phase: 1',
      'current_phase_name: Planning',
      'current_plan: 1',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      'Current Phase: 1',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      'Total Plans in Phase: 2',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // begin-phase 2 changes body Status from "Executing Phase 1" to "Executing Phase 2"
    // → pre and post body Status differ → delta does NOT fire → syncStateFrontmatter
    // re-derives status from new body value → frontmatter status must reflect 'executing'
    // (still 'executing' after begin-phase 2 is a correct transition).
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'Implementation'],
      tmpDir,
    );
    assert.ok(beginResult.success, `state begin-phase failed: ${beginResult.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // Frontmatter status must have been updated (not frozen at original 'executing' for phase 1).
    // After begin-phase 2, body Status becomes "Executing Phase 2" → re-derived → still 'executing'
    // but it must NOT be the stale body-derived value from before the transform; the key check is
    // that the write completed successfully and status is a known valid value.
    assert.ok(
      rawFm.status === 'executing',
      `frontmatter status must be 'executing' after begin-phase 2 (delta fires, re-derived); got: ${JSON.stringify(rawFm.status)}`,
    );

    // Stronger check: if we then run a command that changes Status to a DIFFERENT value,
    // the frontmatter MUST reflect the new body-derived status (not be frozen).
    // Use state update to change Status to "Phase 2 complete" → derives 'completed'.
    const updateResult = runGsdTools(
      ['state', 'update', 'Status', 'Phase 2 complete'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update Status failed: ${updateResult.error}`);

    const written2 = fs.readFileSync(statePath, 'utf8');
    const rawFm2 = parseFrontmatter(written2);
    assert.strictEqual(
      rawFm2.status,
      'completed',
      `frontmatter status must be 'completed' after body Status → 'Phase 2 complete' (delta fires, re-derived); ` +
      `got: ${JSON.stringify(rawFm2.status)}. The delta heuristic must NOT freeze status when the body field changes.`,
    );
  });

  // (e) milestone-switch uses platformWriteSync directly (not RMW) — check it still resets status correctly
  test('(e) milestone-switch still resets frontmatter status to planning (uses writeStateMd path, not RMW)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Phase 3 complete' }));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 Next\n\n### Phase 4: Next steps\n',
      'utf-8',
    );

    const result = runGsdTools(
      ['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'Next'],
      tmpDir,
    );
    assert.ok(result.success, `milestone-switch failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'planning',
      `milestone-switch must reset frontmatter status to 'planning'; got: ${JSON.stringify(rawFm.status)}`,
    );
  });
});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3408 §8.3 Matrix A1/A2/A3 (#3469): the ONE write-seam composition
// (`syncAndPreserveStateMd`) is now the single owner both `readModifyWriteStateMd`
// and `cmdPhaseComplete`'s atomic-commit adapter call — "the two compositions
// agree because they are one." Required fast-check property, per the matrix's
// closing bullet: for any (content, transform, resync, authoritativeFm),
// cmdPhaseComplete's composed output equals readModifyWriteStateMd's for the
// same inputs. Both sides persist to a REAL file and are compared by reading
// the file back (ADR-3180 Decision 4(c) — the consumer's output, never the
// owner's in-memory return value compared directly). Seed pinned, runs
// bounded, full replay data printed on failure (mirrors tests/state-transition
// .test.cjs's #3468 matrix C3 property).
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-3408 §8.3 Matrix A1/A2/A3 (property): the shared write-seam composition', () => {
  function baseStateMd(phaseNum, phaseName) {
    return [
      '---',
      'gsd_state_version: 1.0',
      `current_phase: "${phaseNum}"`,
      `current_phase_name: ${phaseName}`,
      'status: executing',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      `Phase: ${phaseNum} (${phaseName})`,
      'Plan: 1 of 1',
      'Status: Executing',
      '',
    ].join('\n');
  }

  test('property: syncAndPreserveStateMd persists the same bytes whether reached via cmdPhaseComplete\'s shape or readModifyWriteStateMd', (t) => {
    // Clock Seam: both paths stamp `last_updated` from `realClock.nowIso()`
    // (Date.now() under the hood — src/clock.cts). Without freezing `Date`,
    // the two invocations inside each property run happen milliseconds
    // apart and `last_updated` genuinely differs, defeating the byte-for-byte
    // comparison regardless of the composition itself. Both paths run
    // in-process (required directly, not subprocessed), so mocking the
    // global `Date` reaches `realClock` without any production change —
    // same pattern as tests/commands.test.cjs's HTTP-date pin.
    const PINNED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.constantFrom('Foundation', 'Execution', 'Wrap-up (final)'),
        fc.boolean(), // touchPhaseLine — A2 (false, Phase: unchanged) vs A3 (true, Phase: changed)
        fc.boolean(), // resync
        fc.boolean(), // withAuthoritativeFm
        (phaseNum, phaseName, touchPhaseLine, resync, withAuthoritativeFm) => {
          const tmp = createTempDir('gsd-a1a2a3-');
          t.after(() => cleanup(tmp));

          const original = baseStateMd(phaseNum, phaseName);
          // Always change SOMETHING (Status) so neither path's own no-op
          // guard short-circuits the comparison — the property is about the
          // shared COMPOSITION, not the two different no-op-skip policies
          // each adapter legitimately layers around it.
          let transformed = original.replace(/^Status: Executing$/m, `Status: Executing phase ${phaseNum}`);
          if (touchPhaseLine) {
            transformed = transformed.replace(/^Phase: .*/m, `Phase: ${phaseNum} (${phaseName}) — COMPLETE`);
          }
          const authoritativeFm = withAuthoritativeFm ? { current_phase_name: phaseName } : undefined;

          // Path A: cmdPhaseComplete's real adapter shape (phase.cts) —
          // syncAndPreserveStateMd, then the adapter's own write.
          const pathA = path.join(tmp, 'A.md');
          fs.writeFileSync(pathA, original);
          const composed = stateLib.syncAndPreserveStateMd(original, transformed, pathA, tmp, { resync, authoritativeFm });
          fs.writeFileSync(pathA, composed);

          // Path B: readModifyWriteStateMd's owner shape — same composition,
          // reached through the RMW wrapper every OTHER caller uses.
          const pathB = path.join(tmp, 'B.md');
          fs.writeFileSync(pathB, original);
          stateLib.readModifyWriteStateMd(pathB, () => transformed, tmp, { resync, authoritativeFm });

          const bytesA = fs.readFileSync(pathA, 'utf8');
          const bytesB = fs.readFileSync(pathB, 'utf8');
          if (bytesA !== bytesB) {
            throw new Error(
              `composition diverged: phaseNum=${phaseNum} phaseName=${JSON.stringify(phaseName)} ` +
              `touchPhaseLine=${touchPhaseLine} resync=${resync} withAuthoritativeFm=${withAuthoritativeFm}\n` +
              `--- pathA (cmdPhaseComplete shape) ---\n${bytesA}\n--- pathB (readModifyWriteStateMd) ---\n${bytesB}`,
            );
          }
          return true;
        },
      ),
      { seed: 3469, numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-948-state-noop-write-guard.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-948-state-noop-write-guard (consolidation epic #1969 B2 #1971)", () => {
'use strict';
/**
 * Regression guard for bugs #948 and #944.
 *
 * #948 (data loss): a `state patch` whose fields all fail to match still
 * rewrites STATE.md — bumping `last_updated`, resetting `milestone_name` to
 * the template placeholder, and resurrecting a stale `stopped_at` from an
 * old body `## Session` block (body-derived value overwrites a newer
 * frontmatter value written by `record-session`).
 *
 * #944: `state record-session --stopped-at X --resume-file Y` silently
 * drops the supplied values when the STATE.md body lacks the exact session
 * labels the in-place replace expects, returning `{"recorded": false}` at
 * exit 0 and only bumping `last_updated`.
 *
 * Shared root cause: `readModifyWriteStateMd` always writes STATE.md even
 * when the transform produced no change, and `syncStateFrontmatter`
 * re-derives frontmatter (including milestone_name / stopped_at) from the
 * possibly-stale body on every write.
 *
 * Fixes:
 *   1. No-op guard in `readModifyWriteStateMd`: when transform output ===
 *      input, skip the write entirely.
 *   2. `syncStateFrontmatter` preserves existing `milestone_name` / `milestone`
 *      when the derived value is the template placeholder `'milestone'`.
 *   3. `syncStateFrontmatter` prefers existing frontmatter `stopped_at` /
 *      `paused_at` over a body-derived value (frontmatter wins).
 *   4. `cmdStateRecordSession` auto-creates a canonical `## Session` section
 *      when `--stopped-at` / `--resume-file` are supplied but no labels exist.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STATE.md with:
 *  - real `milestone_name` in frontmatter (e.g. "My Real Milestone")
 *  - newer frontmatter `stopped_at` (written by a prior `record-session`)
 *  - stale `## Session` body section with an OLDER "Stopped at" line
 *
 * When a zero-match `state patch` runs on this file, NONE of these values
 * should be disturbed — the file must be byte-identical afterward.
 */
function buildStateMdWithStaleSectionAndRealFrontmatter(opts) {
  const {
    milestoneName = 'My Real Milestone',
    fmStoppedAt = 'Phase 3, Plan 2 — newer value',
    bodyStoppedAt = 'Phase 1, Plan 1 — stale historical value',
    lastUpdated = '2026-01-01T00:00:00.000Z',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v2.0',
    `milestone_name: ${milestoneName}`,
    'status: executing',
    `stopped_at: ${fmStoppedAt}`,
    `last_updated: ${lastUpdated}`,
    'progress:',
    '  total_phases: 5',
    '  completed_phases: 2',
    '  total_plans: 10',
    '  completed_plans: 4',
    '  percent: 40',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 3',
    'Last Activity: 2026-01-01',
    '',
    '## Session',
    '',
    `**Last session:** 2026-01-01T00:00:00.000Z`,
    `**Stopped at:** ${bodyStoppedAt}`,
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use Node 22',
    '',
  ].join('\n');
}

/**
 * STATE.md with NO session section at all — no "## Session" heading,
 * no Stopped at / Resume file labels. This is the #944 scenario.
 */
function buildStateMdWithoutSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use TypeScript',
    '',
  ].join('\n');
}

/**
 * STATE.md with a canonical session section (the success path — must not regress).
 */
function buildStateMdWithCanonicalSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** Phase 1, Plan 1',
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use TypeScript',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: zero-match patch must leave STATE.md byte-identical
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: zero-match state patch must not rewrite STATE.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md is byte-identical after a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({});
    fs.writeFileSync(statePath, original);

    // Patch a field that does NOT exist in the file — zero matches expected.
    const result = runGsdTools('state patch --NonExistentFieldXYZ "some value"', tmpDir);
    assert.ok(result.success, `state patch should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'updated should be empty');
    assert.ok(Array.isArray(patchOutput.failed), 'failed should be an array');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'STATE.md must be byte-identical after zero-match patch');
  });

  test('milestone_name is preserved after zero-match patch (not reset to template placeholder)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      milestoneName: 'My Real Milestone',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'My Real Milestone',
      'milestone_name must not be reset to template placeholder by zero-match patch');
  });

  test('stopped_at frontmatter value is preserved after zero-match patch (via byte-identity)', () => {
    // The no-op guard prevents ANY rewrite when nothing changed, so the
    // frontmatter stopped_at is preserved because the file is never touched.
    // The stale body value cannot win because syncStateFrontmatter is never called.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      fmStoppedAt: 'Phase 3, Plan 2 — newer value',
      bodyStoppedAt: 'Phase 1, Plan 1 — stale historical value',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    // The byte-identity test already covers this; this test confirms the key
    // field specifically is intact.
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original,
      'STATE.md must be byte-identical — stopped_at cannot be overwritten via a no-op patch');
  });

  test('last_updated is not bumped by a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['last_updated'], '2026-01-01T00:00:00.000Z',
      'last_updated must not be bumped when no fields were changed');
  });

  test('a matching patch STILL updates STATE.md correctly (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const fixture = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, fixture);

    const result = runGsdTools('state patch --Status "Phase complete — ready for verification"', tmpDir);
    assert.ok(result.success, `state patch should succeed: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.ok(patchOutput.updated.includes('Status'), 'Status should be in updated list');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase complete — ready for verification'),
      'matching patch should update the field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: syncStateFrontmatter — milestone_name placeholder preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: syncStateFrontmatter preserves milestone_name when derived is template placeholder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves real milestone_name when disk yields only template placeholder', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter has a real name, but no ROADMAP.md exists so getMilestoneInfo
    // will fall back to the 'milestone' placeholder — must not overwrite.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'milestone_name must not be reset to template placeholder by state sync');
  });

  test('state sync runs successfully and preserves milestone_name (no corruption)', () => {
    // state sync always rebuilds frontmatter from the body — the no-op guard
    // applies to commands whose transform produces no change. state sync always
    // writes because last_updated changes. This test verifies that a full sync
    // cycle does not corrupt milestone_name when the placeholder is derived.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'state sync must not reset milestone_name to template placeholder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #944: record-session with no session section must persist supplied values
// ─────────────────────────────────────────────────────────────────────────────

describe('#944: record-session persists values even when body lacks session labels', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('stopped-at and resume-file are present in STATE.md after record-session with no prior section', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 3" --resume-file ".planning/phases/02/02-03-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `state record-session should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values were supplied and persisted');
    assert.ok(!output.reason || output.reason !== 'No session fields found in STATE.md',
      'must not return the silent no-op reason when values were supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 3'),
      '--stopped-at value must appear in STATE.md');
    assert.ok(after.includes('.planning/phases/02/02-03-PLAN.md'),
      '--resume-file value must appear in STATE.md');
  });

  test('command does not silently no-op when values are supplied (recorded must not be false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 5, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    // The key contract: if values were supplied, recorded must be true.
    assert.notStrictEqual(output.recorded, false,
      'recorded must not be false when --stopped-at was explicitly supplied');
  });

  test('STATE.md with non-canonical session labels still persists supplied values', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Session section exists but uses non-canonical label shapes (table, alternate caps)
    const nonCanonical = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session Info',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonical);

    const PINNED_MS = Date.parse('2026-06-09T15:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values are persisted via auto-create fallback');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 3, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('none.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with no args against a body-less file errors (#4186 usage contract)', () => {
    // #4186 superseded the bare-call contract this test used to pin
    // (recorded:false decline): a no-values invocation is now a usage error
    // for every STATE.md shape, handler-side, before any read. The
    // value-supplied decline paths keep their own dedicated tests above
    // (#3374 Variant B, #3957).
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());
    const before = fs.readFileSync(statePath, 'utf-8');

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(!result.success, 'should exit non-zero: usage error');
    assert.match(result.error, /stopped-at or resume-file required for state record-session/);
    assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before,
      'a rejected bare call must not touch the file');
  });

  test('canonical session section still updates in place (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T18:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 4" --resume-file ".planning/phases/02/02-04-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 4'), 'stopped-at should be updated');
    assert.ok(after.includes('.planning/phases/02/02-04-PLAN.md'), 'resume-file should be updated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial fixtures: malformed frontmatter, missing fields, CRLF
// ─────────────────────────────────────────────────────────────────────────────

describe('#948/#944: adversarial fixture variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('zero-match patch on CRLF STATE.md leaves file unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Build with CRLF line endings
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({}).replace(/\n/g, '\r\n');
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentFieldXYZ "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'CRLF file must be byte-identical after zero-match patch');
  });

  test('zero-match patch on STATE.md with missing frontmatter fields does not corrupt', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const minimal = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, minimal);

    const result = runGsdTools('state patch --NonExistentField "value"', tmpDir);
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'no fields should be updated');
  });

  test('record-session with empty body still records when values supplied', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Body is entirely empty (only frontmatter)
    const emptyBody = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, emptyBody);

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'should persist even into a body-less STATE.md');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 1, Plan 1'),
      '--stopped-at value must appear in STATE.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial review findings: in-place update for existing ## Session heading
// ─────────────────────────────────────────────────────────────────────────────

describe('#944 adversarial: existing ## Session heading must be updated in place, not duplicated', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * HIGH finding: when a `## Session` heading already exists but uses
   * non-canonical rows (e.g. a markdown table), the DWIM code was appending
   * a second `## Session` block instead of normalizing the existing one.
   * buildStateFrontmatter / cmdStateSnapshot both read only the FIRST match,
   * so the newly-written Stopped at / Resume file end up in an ignored block.
   */
  test('record-session with existing non-canonical ## Session block: exactly one ## Session block afterward', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
      '## Accumulated Context',
      '',
      '- Decision: use TypeScript',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');

    // (a) exactly ONE ## Session block — no duplicate
    const sessionHeadingCount = (after.match(/^## Session\s*$/gm) || []).length;
    assert.strictEqual(sessionHeadingCount, 1,
      'exactly ONE ## Session block must exist after record-session (no duplicate appended)');

    // (b) supplied values are present in the file
    assert.ok(after.includes('Phase 4, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('resume.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with existing non-canonical ## Session block: state-snapshot sees supplied stopped_at', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:30:00.000Z');
    runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );

    // (c) state-snapshot must see the written stopped_at in the session block
    // (via buildStateFrontmatter frontmatter OR body Session section, first match)
    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.strictEqual(
      snapshot.session && snapshot.session.stopped_at,
      'Phase 4, Plan 2',
      `state-snapshot session.stopped_at must reflect "Phase 4, Plan 2", got: ${JSON.stringify(snapshot.session)}`,
    );
  });

  /**
   * LOW finding: auto-created scaffold writes `**Last session:**` but
   * cmdStateSnapshot only matched `**Last Date:**`, so session.last_date
   * was null after auto-create despite a valid timestamp being written.
   * Fix: teach the snapshot parser to also accept `**Last session:**`.
   */
  test('state-snapshot returns non-null session.last_date after auto-create on body-less file', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T21:00:00.000Z');
    const recResult = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(recResult.success, `record-session should exit 0: ${recResult.error}`);

    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.notStrictEqual(
      snapshot.session && snapshot.session.last_date,
      null,
      `state-snapshot session.last_date must not be null after auto-create; got: ${JSON.stringify(snapshot.session)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1101: record-session on a `## Session Continuity` bootstrap section must
// update IN PLACE, not append a duplicate `## Session` block.
//
// The reported symptom (recorded:false + frontmatter still mutated) is already
// fixed by #944/#948. The residual: the DWIM auto-create recognised only the
// canonical `## Session` heading, so a bootstrap `## Session Continuity` section
// (workstream.cts, gsd2-import.cts, templates/state.md) fell through to the
// append branch and produced a SECOND `## Session` block. The fix inserts the
// missing canonical fields into the existing `## Session Continuity` section,
// preserving the heading and any prose, and teaches the snapshot / frontmatter
// readers to recognise that heading.
// ─────────────────────────────────────────────────────────────────────────────

describe('#1101: record-session updates ## Session Continuity in place (no duplicate block)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  /** Workstream bootstrap shape: bold Stopped At/Resume File, no Last session. */
  function buildWorkstreamContinuity() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** N/A',
      '**Resume File:** None',
      '',
    ].join('\n');
  }

  test('workstream Session Continuity is updated in place — no duplicate ## Session appended', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildWorkstreamContinuity());

    const PINNED_MS = Date.parse('2026-06-12T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1 context gathered" --resume-file ".planning/phases/01/01-CONTEXT.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true when values are supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    // No duplicate bare `## Session` heading appended (the only heading stays
    // `## Session Continuity`).
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      `must not append a duplicate bare "## Session" block; got:\n${after}`);
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      `exactly one Session-family heading must remain; got:\n${after}`);
    // Missing canonical field inserted; supplied values present.
    assert.ok(after.includes('**Last session:**'), 'Last session field must be inserted');
    assert.ok(after.includes('Phase 1 context gathered'), '--stopped-at value must be present');
    assert.ok(after.includes('.planning/phases/01/01-CONTEXT.md'), '--resume-file value must be present');
    // The frontmatter reader recognises `## Session Continuity` and derives stopped_at.
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 1 context gathered',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
    // The cmdStateSnapshot reader (separate code path) must also resolve it.
    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'Phase 1 context gathered',
      'state-snapshot must read stopped_at from the ## Session Continuity section');
  });

  test('prose under ## Session Continuity is preserved (no data loss)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const withProse = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '',
      '**Next recommended action:** keep-me-intact',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, withProse);

    const PINNED_MS = Date.parse('2026-06-12T13:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2 done" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Next recommended action:** keep-me-intact'),
      `existing prose must be preserved (no data loss); got:\n${after}`);
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      'must not append a duplicate bare "## Session" block');
    assert.ok(after.includes('Phase 2 done'), '--stopped-at value must be present');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 2 done',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
  });

  test('canonical ## Session block path is unchanged (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-12T14:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 9, Plan 9" --resume-file "r.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      'canonical ## Session block must remain single');
    assert.ok(after.includes('Phase 9, Plan 9'), 'stopped-at value updated in canonical block');
  });

  test('legacy duplicate file: reader PREFERS canonical ## Session over ## Session Continuity (F1)', () => {
    // A file created by the OLD bug: a stale `## Session Continuity` first, then an
    // appended fresh `## Session`. The snapshot reader must read the canonical
    // `## Session` (fresh), matching the writer, not the stale Continuity block.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const duplicate = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** STALE-continuity-value',
      '**Resume File:** None',
      '',
      '## Session',
      '',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** FRESH-canonical-value',
      '**Resume file:** r.md',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, duplicate);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'FRESH-canonical-value',
      'reader must prefer the canonical ## Session block over the stale ## Session Continuity');
  });

  test('h3 ### Session Continuity is NOT read as the session section (F4)', () => {
    // The reader is line-anchored to `^## `, so an h3 subsection must not be picked
    // up as the session section.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const h3Only = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '### Session Continuity',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** h3-should-not-be-session',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, h3Only);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.last_date, null,
      'an h3 ### Session Continuity must not be treated as the ## Session section');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3275-fmstr-non-string-scalars.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3275-fmstr-non-string-scalars (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #3275 (CR finding)
 *
 * Regression guard: `state-snapshot` must prefer YAML frontmatter scalar
 * values even when those scalars are numeric (e.g. current_phase: 19) or
 * boolean — not just when they are strings.
 *
 * Prior to the fix, `fmStr` checked `typeof v === 'string'`, so a numeric
 * frontmatter value like `current_phase: 19` was treated as missing and the
 * snapshot fell back to body extraction, which could return a stale or
 * incorrect value.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('state-snapshot: fmStr accepts non-string YAML scalars (#3275 CR)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('numeric current_phase in frontmatter wins over body extraction', () => {
    // YAML parses bare integers as numbers, not strings.
    // fmStr must not drop the frontmatter value when it is a number.
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 19',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 03',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter numeric value must win over bold-body value
    assert.strictEqual(output.current_phase, '19', 'numeric frontmatter current_phase must be used');
  });

  test('numeric total_phases in frontmatter wins over body extraction', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'total_phases: 7',
      '---',
      '',
      '# Project State',
      '',
      '**Total Phases:** 3',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter says 7, body says 3 — frontmatter must win
    assert.strictEqual(output.total_phases, 7, 'numeric frontmatter total_phases must be used');
  });

  test('numeric total_plans_in_phase in frontmatter wins over body extraction', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'total_plans_in_phase: 5',
      '---',
      '',
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total_plans_in_phase, 5, 'numeric frontmatter total_plans_in_phase must be used');
  });

  test('string current_phase in frontmatter still works (no regression)', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      "current_phase: '19'",
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 03',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '19', 'string frontmatter current_phase still works');
  });

  test('no-frontmatter file still extracts from body (no regression)', () => {
    const stateMd = [
      '# Project State',
      '',
      '**Current Phase:** 05',
      '**Total Phases:** 8',
      '**Status:** paused',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '05', 'body extraction still works without frontmatter');
    assert.strictEqual(output.total_phases, 8, 'numeric body total_phases still extracted');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3257-nested-plans-undercount.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3257-nested-plans-undercount (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #3257
 *
 * Regression guard: `buildStateFrontmatter` must count plan/summary files in
 * the nested `phases/<N>-<slug>/plans/<N>-PLAN-<NN>-<slug>.md` layout (written
 * by gsd-plan-phase post-#3139). Prior to this fix, the loop did a flat
 * `readdirSync` on the phase directory and missed every file inside the
 * `plans/` subdirectory, so `progress.total_plans` and
 * `progress.completed_plans` were silently under-counted on every state
 * mutation that flows through `syncStateFrontmatter → buildStateFrontmatter`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a minimal STATE.md that will trigger syncStateFrontmatter on any write.
 */
function writeStateFile(tmpDir, overrides = {}) {
  const phase = overrides.phase || '01';
  const status = overrides.status || 'executing';
  const content = [
    '# Project State',
    '',
    `**Current Phase:** ${phase}`,
    `**Status:** ${status}`,
    '',
    '## Current Position',
    '',
    `Phase: ${phase} — In progress`,
    'Status: Executing',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content, 'utf-8');
}

/**
 * Write a ROADMAP.md listing the given phase numbers so the milestone-scoped
 * filter includes them (avoids needing a milestone header to count phases).
 */
function writeRoadmap(tmpDir, phaseNums) {
  // #3217 (ADR-3180 §7.6 rule 4): no version token — none of this helper's
  // callers write a STATE.md `milestone:` field, so a `vX.Y`-bearing heading
  // here would window as UNSCOPED (§7.1 row 4: "has versioned milestones,
  // but no version resolved"), not the free-form COMPLETE window the
  // percent/count assertions below depend on.
  const lines = ['## Roadmap'];
  for (const n of phaseNums) {
    lines.push('', `### Phase ${n}: Phase ${n}`);
  }
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    lines.join('\n'),
    'utf-8'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nested layout — core bug (#3257)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStateFrontmatter nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('counts plans and summaries in nested plans/ subdirectory', () => {
    // Layout: phases/01-init/plans/1-PLAN-01-setup.md etc.
    // 2 phases × 3 plans each, all completed (3 summaries each).
    for (let phase = 1; phase <= 2; phase++) {
      const phaseSlug = `0${phase}-phase-${phase}`;
      const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      for (let plan = 1; plan <= 3; plan++) {
        const planPad = String(plan).padStart(2, '0');
        // Reporter's format: {N}-PLAN-{NN}-{slug}.md
        const planFile = `${phase}-PLAN-${planPad}-step${plan}.md`;
        const summaryFile = `${phase}-SUMMARY-${planPad}-step${plan}.md`;
        fs.writeFileSync(path.join(plansDir, planFile), '# Plan\n');
        fs.writeFileSync(path.join(plansDir, summaryFile), '# Summary\n');
      }
      // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
      // *-VERIFICATION.md is what makes a phase complete, not plan/summary
      // parity — this test is about nested plans/ COUNTING, not the predicate.
      writePassedVerification(tmpDir, phaseSlug, `0${phase}`);
    }

    writeRoadmap(tmpDir, [1, 2]);
    writeStateFile(tmpDir, { phase: '02' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 6, 'total_plans must count nested plans/ files (2 phases × 3 plans)');
    assert.strictEqual(Number(progress.completed_plans), 6, 'completed_plans must count nested summary files (2 phases × 3 summaries)');
    assert.strictEqual(Number(progress.completed_phases), 2, 'completed_phases: both phases have a passing verification');
  });

  test('counts PLAN-NN-slug form (bare PLAN- prefix, no phase prefix)', () => {
    // roadmap.cjs uses /^PLAN-\d+.*\.md$/i — test that form too.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, 'PLAN-01-foundation.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, 'PLAN-02-infra.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, 'SUMMARY-01-foundation.md'), '# Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 2, 'bare PLAN-NN-slug.md files must be counted');
    assert.strictEqual(Number(progress.completed_plans), 1, 'SUMMARY-NN-slug.md files must be counted');
    // 1 summary < 2 plans → phase NOT completed
    assert.strictEqual(Number(progress.completed_phases), 0, 'phase not complete when summaries < plans');
  });

  test('flat-layout repos are unaffected (no plans/ subdirectory)', () => {
    // Pre-#3139 flat layout: plans live directly in the phase dir.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
    // *-VERIFICATION.md makes the phase complete now.
    writePassedVerification(tmpDir, '01-init', '01');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 2, 'flat layout: top-level *-PLAN.md files counted');
    assert.strictEqual(Number(progress.completed_plans), 2, 'flat layout: top-level *-SUMMARY.md files counted');
    assert.strictEqual(Number(progress.completed_phases), 1, 'flat layout: phase complete with a passing verification');
  });

  test('no double-count when both top-level and nested plan files coexist', () => {
    // Edge case: phase has a top-level plan AND a plans/ subdir.
    // Only the nested files should be counted (or both, depending on logic),
    // but the critical thing is no file is counted twice.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    // Top-level flat plan
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Top-level Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Top-level Summary\n');

    // Nested plan
    fs.writeFileSync(path.join(plansDir, '1-PLAN-02-nested.md'), '# Nested Plan\n');
    fs.writeFileSync(path.join(plansDir, '1-SUMMARY-02-nested.md'), '# Nested Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // 1 top-level + 1 nested = 2 total (not 4 from double-counting)
    assert.strictEqual(Number(progress.total_plans), 2, 'mixed layout: no double-counting of plan files');
    assert.strictEqual(Number(progress.completed_plans), 2, 'mixed layout: no double-counting of summary files');
  });

  test('empty plans/ directory is a no-op (does not break counting)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    // plans/ dir exists but is empty

    // One top-level plan
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
    // *-VERIFICATION.md makes the phase complete now.
    writePassedVerification(tmpDir, '01-init', '01');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 1, 'empty plans/ must not add phantom plan count');
    assert.strictEqual(Number(progress.completed_plans), 1, 'empty plans/ must not affect summary count');
    assert.strictEqual(Number(progress.completed_phases), 1, 'phase complete with a passing verification');
  });

  test('PLAN-OUTLINE.md files are excluded from nested plan count', () => {
    // phase.cjs explicitly excludes *-PLAN-OUTLINE.md (not real plans).
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Real Plan\n');
    // Outline file — should NOT count as a plan
    fs.writeFileSync(path.join(plansDir, '1-PLAN-OUTLINE.md'), '# Outline\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // Only the real plan should count; outline excluded.
    assert.strictEqual(Number(progress.total_plans), 1, 'PLAN-OUTLINE.md must not count as a plan');
  });

  test('pre-bounce files are excluded from nested plan count (bare PLAN- prefix)', () => {
    // CR finding: PLAN_PRE_BOUNCE_RE was /-PLAN.*\.pre-bounce\.md$/i which missed
    // bare-prefix files like PLAN-01-foo.pre-bounce.md. Fixed to /\.pre-bounce\.md$/i.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Real Plan\n');
    // Pre-bounce files — should NOT count as plans
    fs.writeFileSync(path.join(plansDir, 'PLAN-01-work.pre-bounce.md'), '# Pre-bounce\n');
    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.pre-bounce.md'), '# Pre-bounce\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // Only the real plan should count; pre-bounce files excluded.
    assert.strictEqual(Number(progress.total_plans), 1, 'pre-bounce files must not count as plans');
  });

  test('reporter scenario: 2 phases × multiple plans, all complete', () => {
    // Mirrors the reporter's observation: after a state mutation the progress
    // block should reflect the TRUE on-disk count, not an under-count.
    // Phase 1: 4 plans, all with summaries.
    // Phase 2: 3 plans, all with summaries.
    // Expected: total=7, completed=7, completed_phases=2.
    const phases = [
      { num: 1, plans: 4 },
      { num: 2, plans: 3 },
    ];

    for (const { num, plans } of phases) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `0${num}-phase-${num}`);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      for (let p = 1; p <= plans; p++) {
        const pad = String(p).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `${num}-PLAN-${pad}-task${p}.md`), '# Plan\n');
        fs.writeFileSync(path.join(plansDir, `${num}-SUMMARY-${pad}-task${p}.md`), '# Summary\n');
      }
      // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
      // *-VERIFICATION.md makes a phase complete now.
      writePassedVerification(tmpDir, `0${num}-phase-${num}`, `0${num}`);
    }

    writeRoadmap(tmpDir, [1, 2]);
    writeStateFile(tmpDir, { phase: '02' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 7, 'reporter scenario: total_plans must be 7');
    assert.strictEqual(Number(progress.completed_plans), 7, 'reporter scenario: completed_plans must be 7');
    assert.strictEqual(Number(progress.completed_phases), 2, 'reporter scenario: both phases have a passing verification');
    assert.strictEqual(Number(progress.percent), 100, 'reporter scenario: 100% when all plans have summaries');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateValidate nested plans/ layout (#3257 — CR finding)
//
// Prior to this fix, cmdStateValidate did a flat readdirSync on the phase dir
// and returned diskPlans=0 for nested layouts, causing false drift warnings
// when STATE.md correctly said "Total Plans in Phase: 3".
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateValidate nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no false drift warning when STATE.md plan count matches nested disk count', () => {
    // Phase 01-init: 3 nested plans, 0 summaries (still executing).
    // STATE.md says "Total Plans in Phase: 3" — after the fix, validate sees
    // diskPlans=3 and emits no plan_count drift warning.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 3; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    // Write STATE.md with correct plan count so validate can check for drift.
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 3',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.valid, `state validate should be valid; warnings: ${JSON.stringify(parsed.warnings)}`);
    assert.deepStrictEqual(parsed.warnings, [], 'no drift warnings for nested-layout phase with correct plan count');
    assert.ok(!findWarning(parsed, 'S005'), 'no S005 (plan-count drift) when nested scan matches STATE.md');
    assertNoDriftKey(parsed);
  });

  test('emits drift warning when STATE.md plan count does not match nested disk count', () => {
    // STATE.md says 5 but only 2 plans exist on disk — validate should catch it.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 2; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 5',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(!parsed.valid, 'state validate should report invalid when plan counts differ');
    assert.ok(parsed.warnings.length > 0, 'at least one drift warning expected');
    const s005 = findWarning(parsed, 'S005');
    assert.ok(s005, 'S005 diagnostic must be present');
    // `.includes()` on the interpolated counts (not full-string message
    // equality — CONTRIBUTING.md's "Prohibited: Raw Text Matching on Test
    // Outputs"): the disk count must reflect the nested scan (2 nested
    // plans), not the pre-fix flat-scan under-count.
    assert.ok(s005.message.includes('STATE.md says 5 plans'), 'message must report the STATE.md count');
    assert.ok(s005.message.includes('disk has 2'), 'disk count must reflect nested scan (2 nested plans)');
    assertNoDriftKey(parsed);
  });

  test('PLAN-OUTLINE.md excluded from nested count in validate', () => {
    // Outline files must not inflate diskPlans and cause false "too few" drift.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, '1-PLAN-OUTLINE.md'), '# Outline\n'); // must not count

    // STATE.md claims 1 plan — correct after exclusion.
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 1',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.valid, `should be valid (outline excluded); warnings: ${JSON.stringify(parsed.warnings)}`);
    assert.ok(!findWarning(parsed, 'S005'), 'no S005 (plan-count drift) when outline excluded from nested count');
    assertNoDriftKey(parsed);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateSync nested plans/ layout (#3257 — CR finding)
//
// Prior to this fix, cmdStateSync did a flat readdirSync on each phase dir,
// returning plans=0 for nested layouts. It would set "Total Plans in Phase"
// to 0 even when plans existed inside plans/ — an under-count that corrupts
// the STATE.md progress block.
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateSync nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('updates Total Plans in Phase from 0 to correct nested count on sync', () => {
    // Disk: phase 01-init with 3 nested plans, no summaries.
    // STATE.md says "Total Plans in Phase: 0" (stale / pre-fix value).
    // After sync, the field must be updated to 3.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 3; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.synced, 'sync must report synced: true');
    // The "Total Plans in Phase" change must appear in the changes list.
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `changes must include Total Plans in Phase update; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 3'), `Total Plans in Phase must update to 3; got: "${planCountChange}"`);
  });

  test('sync dry-run reports correct nested plan count without writing', () => {
    // --verify flag: sync must report what WOULD change but not write STATE.md.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 2; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `PLAN-${pad}-task${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `state sync --verify failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.dry_run, 'dry_run must be true with --verify flag');
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `dry-run changes must include Total Plans in Phase; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 2'), `dry-run must show correct count of 2; got: "${planCountChange}"`);

    // STATE.md must be unchanged (dry-run): re-run sync --verify and confirm the
    // same pending change is still reported (if STATE.md had been written, the
    // change would have been applied and the second run would show no changes).
    const result2 = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result2.success, `second dry-run failed: ${result2.error}`);
    const parsed2 = JSON.parse(result2.output);
    const planCountChange2 = parsed2.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange2, 'repeated dry-run must still report pending change (file was not mutated on disk)');
  });

  test('sync across multiple phases with nested plans sums correctly', () => {
    // Phase 01: 2 nested plans, 2 summaries (complete).
    // Phase 02: 3 nested plans, 1 summary (in progress).
    // Expected "Total Plans in Phase" = 3 (current/incomplete phase).
    const phases = [
      { dir: '01-alpha', plans: 2, summaries: 2 },
      { dir: '02-beta', plans: 3, summaries: 1 },
    ];
    for (const { dir, plans, summaries } of phases) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      for (let p = 1; p <= plans; p++) {
        const pad = String(p).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-t.md`), '# Plan\n');
      }
      for (let s = 1; s <= summaries; s++) {
        const pad = String(s).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `1-SUMMARY-${pad}-t.md`), '# Summary\n');
      }
    }
    // Disk-strict completion (ADR-3180 §7.4, #3186): a passing *-VERIFICATION.md
    // is what makes a phase complete now, not plan/summary counts alone. Phase
    // 01-alpha is the one this test intends to be "complete" (fully planned and
    // summarized), so give it a passing verification too — otherwise completed
    // phases = 0 and no Progress change is emitted, which isn't what this test
    // (nested plans/ summing correctly) is about.
    writePassedVerification(tmpDir, '01-alpha', '01');

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 02',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version token)
    // is COMPLETE scope for windowing (§7.1) — without this, an absent
    // ROADMAP.md is UNREADABLE and the Progress: field this test asserts on
    // is withheld ("milestone phase scope is unreadable, not COMPLETE").
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.synced, 'sync must succeed');
    // "Total Plans in Phase" reflects the current (incomplete) phase: 02-beta has 3 plans.
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `Total Plans in Phase change expected; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 3'), `current phase plan count must be 3; got: "${planCountChange}"`);
    // Progress: computeProgressPercent uses min(plan_fraction, phase_fraction).
    // plan_fraction = 3 summaries / 5 plans = 60%.
    // phase_fraction = 1 completed phase / 2 total phases = 50%.
    // min(60%, 50%) = 50% — the phase cap applies (#3242).
    const progressChange = parsed.changes.find(c => c.startsWith('Progress:'));
    assert.ok(progressChange, `Progress change expected; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(progressChange.includes('50%'), `progress must reflect nested counts (min(3/5, 1/2)=50%); got: "${progressChange}"`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-501-flat-phase-details-milestone-leak.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-501-flat-phase-details-milestone-leak (consolidation epic #1969 B2 #1971)", () => {
/**
 * Bug #501: extractCurrentMilestone leaks prior-milestone phases when the
 * ROADMAP uses a flat shared "## Phase Details" section.
 *
 * extractCurrentMilestone returns `preamble + currentSection`, where the
 * preamble is everything before the first milestone heading (only <details>
 * blocks stripped). A flat "## Phase Details" section listing every phase
 * across all milestones therefore leaks its `### Phase N:` headings into the
 * active-milestone scope, so getMilestonePhaseFilter / buildStateFrontmatter
 * count the whole project instead of just the active milestone.
 *
 * Maintainer direction (triage of #501): fix in code AND make
 * `validate consistency` milestone-aware so it does not flag shipped phase
 * dirs as orphans once the scope is correctly narrowed.
 *
 * Layout under test (mirrors the real repro):
 *   # Roadmap
 *   ## Phase Details        <- flat, BEFORE the first milestone heading
 *   ### Phase 1..3          <- shipped phases
 *   ## ✅ v2.0              <- shipped milestone
 *   ## 🚧 v3.0 (active)
 *   ### Phase 4..5          <- active-milestone phases
 * STATE.md milestone: v3.0  →  state json must report total_phases: 2.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROADMAP = `# Roadmap

Project overview prose that legitimately lives before the milestones.

## Phase Details

### Phase 1: Shipped One
Did a thing.

### Phase 2: Shipped Two
Did another thing.

### Phase 3: Shipped Three
Did a third thing.

## ✅ v2.0: Foundation (shipped)

Summary of the shipped milestone.

## 🚧 v3.0: Active Milestone

### Phase 4: Active One
Doing a thing.

### Phase 5: Active Two
Doing another thing.
`;

const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active Milestone
status: in_progress
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 4 (Active One)
`;

describe('flat "## Phase Details" milestone leak (#501)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // All five phase dirs exist on disk (the flat layout retains shipped dirs).
    const phaseDirs = ['01-shipped-one', '02-shipped-two', '03-shipped-three', '04-active-one', '05-active-two'];
    for (const d of phaseDirs) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n', 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json counts only the active milestone phases, not the flat Phase Details list', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const state = JSON.parse(result.output);
    assert.equal(
      state.progress.total_phases,
      2,
      `active milestone v3.0 has 2 phases (4,5); flat Phase Details (1-3) must not leak. Got total_phases=${state.progress.total_phases}`
    );
  });

  test('validate consistency does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // Once milestone scope is correctly narrowed (Test A), the shipped phase
    // dirs (1-3) are no longer in the SCOPED roadmap. They are, however, real
    // phases listed in the FULL roadmap, so they must NOT be reported as
    // "exists on disk but not in ROADMAP" orphans. (#501 — validate must be
    // milestone-aware.)
    const result = runGsdTools(['validate', 'consistency'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const orphanWarnings = warnings.filter((w) => /exists on disk but not in ROADMAP/i.test(w.message));
    assert.deepEqual(
      orphanWarnings,
      [],
      `shipped phase dirs (1-3) are in the full ROADMAP and must not be flagged as orphans. Got: ${JSON.stringify(orphanWarnings)}`
    );
    // W007 is REUSED verbatim from `validate.health`'s rule table (design doc,
    // "Which rules run where") — `validate consistency`'s own findings carry
    // the SAME code space for this subject, not a re-derived private label.
    const w007Orphans = warnings.filter((w) => w.code === 'W007');
    assert.deepEqual(
      w007Orphans,
      [],
      `shipped phase dirs (1-3) must not produce W007 via validate consistency either. Got: ${JSON.stringify(w007Orphans)}`
    );
  });

  test('validate health (W007) does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // cmdValidateHealth's Check 8 has the same coupling: its W007 membership
    // check compared active disk phases against the active-milestone scope.
    // Shipped phase dirs in the active phases/ dir must be checked against the
    // FULL roadmap so they are not false W007 orphans. (#501)
    const result = runGsdTools(['validate', 'health'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const w007Orphans = warnings.filter(
      (w) => w.code === 'W007' && /exists on disk but not in ROADMAP/i.test(w.message)
    );
    assert.deepEqual(
      w007Orphans,
      [],
      `shipped phase dirs (1-3) must not produce W007. Got: ${JSON.stringify(w007Orphans.map((w) => w.message))}`
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1967-cache-invalidation.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1967-cache-invalidation (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #1967)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for #1967 cache invalidation.
 *
 * The disk scan cache in buildStateFrontmatter must be invalidated on
 * writeStateMd to prevent stale reads if multiple state-mutating
 * operations occur within the same Node process. This matters for:
 *   - SDK callers that require() gsd-tools.cjs as a module
 *   - Future dispatcher extensions that handle compound operations
 *   - Tests that import state.cjs directly
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const state = require('../gsd-core/bin/lib/state.cjs');
const { cleanup } = require('./helpers.cjs');

describe('buildStateFrontmatter cache invalidation (#1967)', () => {
  let tmpDir;
  let planningDir;
  let phasesDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1967-cache-'));
    planningDir = path.join(tmpDir, '.planning');
    phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    // Create a minimal config and STATE.md
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: 'TEST' })
    );

    statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, [
      '# State',
      '',
      '**Current Phase:** 1',
      '**Status:** executing',
      '**Total Phases:** 2',
      '',
    ].join('\n'));

    // Start with one phase directory containing one PLAN
    const phase1 = path.join(phasesDir, '01-foo');
    fs.mkdirSync(phase1);
    fs.writeFileSync(path.join(phase1, '01-1-PLAN.md'), '---\nphase: 1\nplan: 1\n---\n# Plan\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writeStateMd invalidates cache so subsequent reads see new disk state', () => {
    // First write — populates cache via buildStateFrontmatter
    const content1 = fs.readFileSync(statePath, 'utf-8');
    state.writeStateMd(statePath, content1, stateTransitionMod.rebuildStateTransaction({
      snapshot: frontmatterLib.extractFrontmatter(content1),
    }), tmpDir);

    // Create a NEW phase directory AFTER the first write
    // Without cache invalidation, the second write would still see only 1 phase
    const phase2 = path.join(phasesDir, '02-bar');
    fs.mkdirSync(phase2);
    fs.writeFileSync(path.join(phase2, '02-1-PLAN.md'), '---\nphase: 2\nplan: 1\n---\n# Plan\n');
    fs.writeFileSync(path.join(phase2, '02-1-SUMMARY.md'), '---\nstatus: complete\n---\n# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
    // *-VERIFICATION.md makes a phase complete now — this test is about CACHE
    // invalidation, not the completion predicate, so give phase 2 one.
    fs.writeFileSync(path.join(phase2, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    // Second write in the SAME process — must see the new phase
    const content2 = fs.readFileSync(statePath, 'utf-8');
    state.writeStateMd(statePath, content2, stateTransitionMod.rebuildStateTransaction({
      snapshot: frontmatterLib.extractFrontmatter(content2),
    }), tmpDir);

    // Read back and parse frontmatter to verify it reflects 2 phases, not 1
    const result = fs.readFileSync(statePath, 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'STATE.md should have frontmatter after writeStateMd');

    const fm = fmMatch[1];
    // Should show 2 total phases (the new disk state), not 1 (stale cache)
    const totalPhasesMatch = fm.match(/total_phases:\s*(\d+)/);
    assert.ok(totalPhasesMatch, 'frontmatter should contain total_phases');
    assert.strictEqual(
      parseInt(totalPhasesMatch[1], 10),
      2,
      'total_phases should reflect new disk state (2), not stale cache (1)'
    );

    // Should show 1 completed phase (phase 2 has SUMMARY)
    const completedMatch = fm.match(/completed_phases:\s*(\d+)/);
    assert.ok(completedMatch, 'frontmatter should contain completed_phases');
    assert.strictEqual(
      parseInt(completedMatch[1], 10),
      1,
      'completed_phases should reflect new disk state (1 complete), not stale cache (0)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3127-state-begin-phase-idempotent.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3127-state-begin-phase-idempotent (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// Regression tests for bug #3127.
//
// state.begin-phase is non-idempotent: when execute-phase calls it on a phase
// that is already mid-flight (e.g. --wave N resume), the handler unconditionally
// overwrites execution-progress fields with stale values from the last plan-phase run:
//   - stopped_at / Last Activity Description reset to "context gathered; ready for plan-phase"
//   - Current Plan reset to 1 (from plan being executed, e.g. 3)
//   - Plan: N of M body line reset to "Plan: 1 of M"
//   - Last activity timestamp reverted to an older value
//   - progress.percent may decrease
//
// Fix: read the current Status field before writing. If the phase is already
// "Executing Phase N", skip the execution-progress fields (Current Plan, plan body
// line, Last Activity Description) and only update fields safe to overwrite on
// resume (Last Activity date, Status if somehow wrong).
// A --force flag bypasses the guard for intentional full resets.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

const ROOT = path.join(__dirname, '..');

// Load the state.cjs module internals via the command router
function requireStateCjs() {
  return require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'state.cjs'));
}

function makeTempPlanning(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3127-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

// A STATE.md that is mid-flight on Phase 5 (Plan 3 of 8 in progress)
const MID_FLIGHT_STATE = `# GSD State

## Configuration
Current Phase: 5
Current Phase Name: test-phase
Total Plans in Phase: 8
Current Plan: 3
Status: Executing Phase 5

## Current Position

Phase: 5 (test-phase) — EXECUTING
Plan: 3 of 8 (Plan 00 SHIPPED — wave 1 complete; Plan 01 SHIPPED; Plan 02 next)
Status: Executing Phase 5
Last activity: 2026-05-05 -- Plan 02 SHIPPED wave 2 GREEN

## Progress

progress:
  total_phases: 10
  completed_phases: 4
  percent: 89

stopped_at: Phase 5 Plan 02 SHIPPED — Wave 2 GREEN detailed narrative here; ready for Plan 03
`;

// A STATE.md that is NOT yet executing (plan-phase just ran)
const PRE_EXECUTE_STATE = `# GSD State

## Configuration
Current Phase: 5
Current Phase Name: test-phase
Total Plans in Phase: 8
Current Plan: 1
Status: Ready to execute

## Current Position

Phase: 5 (test-phase) — READY
Plan: 1 of 8
Status: Ready to execute
Last activity: 2026-05-04 -- context gathered; ready for plan-phase

stopped_at: Phase 5 context gathered; ready for plan-phase
`;

describe('bug #3127: state.begin-phase idempotency guard', () => {
  test('begin-phase on a mid-flight phase does not reset Current Plan', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) {
      // Skip if not exported — the guard may be inside a private function
      return;
    }
    const dir = makeTempPlanning(MID_FLIGHT_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // Current Plan must not have been reset to 1
      const currentPlan = stateExtractField(after, 'Current Plan');
      if (currentPlan !== null) {
        assert.notStrictEqual(currentPlan, '1',
          'begin-phase reset Current Plan to 1 on a mid-flight phase — idempotency guard not applied');
      }
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase on a mid-flight phase does not overwrite stopped_at narrative', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(MID_FLIGHT_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // The rich stopped_at narrative must be preserved
      const stoppedAt = stateExtractField(after, 'stopped_at');
      assert.ok(
        stoppedAt && (stoppedAt.includes('Plan 02 SHIPPED') || stoppedAt.includes('Wave 2 GREEN')),
        `begin-phase overwrote stopped_at narrative on a mid-flight phase; got: ${stoppedAt}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase on a NOT-yet-executing phase sets Current Plan to 1 (normal path)', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(PRE_EXECUTE_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // Normal path: Current Plan should become 1 (or stay 1)
      const currentPlan = stateExtractField(after, 'Current Plan');
      if (currentPlan !== null) {
        assert.strictEqual(currentPlan, '1',
          'begin-phase should set Current Plan to 1 on a fresh phase');
      }
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase always updates Last Activity date (safe on resume, pinned via GSD_NOW_MS)', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(MID_FLIGHT_STATE);

    const PINNED_MS = Date.parse('2020-11-25T09:00:00.000Z');
    const PINNED_DATE = '2020-11-25';
    // Pin the in-process clock via env vars before calling the function directly.
    const origTestMode = process.env.GSD_TEST_MODE;
    const origNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = String(PINNED_MS);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      const lastActivity = stateExtractField(after, 'Last activity');
      assert.ok(
        lastActivity && lastActivity.includes(PINNED_DATE),
        `begin-phase must update Last Activity date to the pinned date ${PINNED_DATE} even on resume (safe field); got: ${lastActivity}`,
      );
    } finally {
      // Restore env vars before cleanup to avoid leaking state to other tests.
      if (origTestMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origTestMode;
      if (origNowMs === undefined) delete process.env.GSD_NOW_MS;
      else process.env.GSD_NOW_MS = origNowMs;
      cleanup(dir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1445-999x-backlog-excluded-from-total-phases.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1445-999x-backlog-excluded-from-total-phases (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1445:
 * 999.x backlog phases must not be counted toward total_phases.
 *
 * Root cause:
 *   deriveProgressFromRoadmap (phase-lifecycle.cts) counted ALL data rows
 *   matching /^\|\s*\d+/ in the progress table, including 999.x backlog rows.
 *   Similarly, state.cts's roadmapPhaseCount loop (via extractCurrentMilestone)
 *   counted 999.x phase headings because it only checked /\d/.test(m[1]).
 *
 * Fix:
 *   Both sites now test /^999(?:\.|$)/.test(token) and skip matching rows.
 *   Mirrors the existing init.cts /^999(?:\.|$)/ filter.
 *
 * Scenarios:
 *   A. deriveProgressFromRoadmap with a progress table containing a 999.x row.
 *   B. state json total_phases via extractCurrentMilestone / roadmapPhaseCount.
 *
 * Follow-up #1580: the same `^999` (and Phase 0) sentinel exclusion was missing
 * in two more code paths — `milestone complete`'s unstarted-phase guard
 * (src/milestone.cts) and `roadmap analyze`'s next_phase routing + phase_count
 * (src/roadmap.cts). Scenarios C and D below cover those.
 *
 *   C. milestone complete is NOT blocked by a Phase 999 backlog heading.
 *   D. roadmap analyze never routes next_phase to 999 / never counts it.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');

// ─── Scenario A: deriveProgressFromRoadmap unit test ────────────────────────
//
// ADR-2143 (epic #2143) migrated deriveProgressFromRoadmap from position-based
// regexes to the markdown-table schema registry (TABLE_SCHEMAS.RoadmapProgress),
// which resolves the Progress table by exact column-name match. These fixtures'
// second column is renamed "Plans" -> "Plans Complete" to match the canonical
// header (gsd-core/templates/roadmap.md) the schema now requires; the assertions
// (999.x exclusion, Complete-row counting) are unchanged.

describe('bug #1445 — deriveProgressFromRoadmap excludes 999.x rows', () => {
  test('3 real phases + 1 999.x backlog row → total_phases: 3, not 4', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
      '| 999.1 Backlog: Future Idea | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      3,
      `total_phases must be 3 (not 4) — 999.1 backlog row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      1,
      `completed_phases must be 1. Got ${result.completedPhases}`,
    );
  });

  test('999 exact (no dot) row is also excluded', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 1/1 | Complete | ✅ |',
      '| 2. Beta | 1/1 | Complete | ✅ |',
      '| 999 Backlog | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      2,
      `total_phases must be 2 (not 3) — 999 row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      2,
      `completed_phases must be 2. Got ${result.completedPhases}`,
    );
  });

  test('all-backlog table yields null total_phases (no real phases)', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 999.1 Future A | 0/0 | Backlog | |',
      '| 999.2 Future B | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      null,
      `total_phases must be null when the only rows are 999.x backlog. Got ${result.totalPhases}`,
    );
  });
});

// ─── #2137: header-driven parse handles the milestone-grouped (5-col) table ──
//
// Regression for #2137: deriveProgressFromRoadmap read the `## Progress` table
// with two 4-column-only regexes. Every project past its v1.0 milestone uses the
// 5-column milestone-grouped shape the same template ships, so the reader (which
// only understood 4 columns) returned { null, null, null } while the writer
// (cmdPhaseComplete, with its explicit `cells.length === 5` branch) happily wrote
// it — and phase.complete then silently skipped the STATE progress update. The
// fix reads columns by NAME, so both shapes parse identically. These tests would
// fail against the pre-fix 4-column regexes (which returned all-null for 5-col).

describe('#2137 regression: deriveProgressFromRoadmap parses the milestone-grouped 5-column table', () => {
  test("the template's own 5-column milestone-grouped Progress block parses non-null", () => {
    // Byte-identical to gsd-core/templates/roadmap.md's "Milestone-Grouped
    // Roadmap" Progress block — the exact shape that silently returned all-null.
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '|-------|-----------|----------------|--------|-----------|',
      '| 1. Foundation | v1.0 | 3/3 | Complete | YYYY-MM-DD |',
      '| 2. Features | v1.0 | 2/2 | Complete | YYYY-MM-DD |',
      '| 5. Security | v1.1 | 0/2 | Not started | - |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 3, `totalPhases must be 3 (5-col table must parse). Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2 (Status is column 4 in the 5-col shape). Got ${result.completedPhases}`);
    assert.equal(result.totalPlans, 7, `totalPlans must be 3+2+2=7 (Plans is column 3 in the 5-col shape). Got ${result.totalPlans}`);
  });

  test('the 4-column greenfield and 5-column milestone-grouped shapes derive the same progress', () => {
    // The reader must agree with the writer on both shapes the template ships.
    const fiveCol = [
      '## Progress',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');
    const fourCol = [
      '## Progress',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Foundation | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');

    assert.deepEqual(
      deriveProgressFromRoadmap(fiveCol),
      deriveProgressFromRoadmap(fourCol),
      'the milestone-grouped and greenfield shapes must derive identical progress',
    );
    assert.deepEqual(deriveProgressFromRoadmap(fiveCol), {
      completedPhases: 2,
      totalPhases: 2,
      totalPlans: 5,
    });
  });

  test('999.x backlog rows stay excluded in the 5-column shape', () => {
    const roadmap = [
      '## Progress',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | 2026-01-01 |',
      '| 2. Beta | v1.0 | 1/1 | Complete | 2026-01-02 |',
      '| 999.1 Future | v2.0 | 0/0 | Backlog | - |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 2, `999.1 backlog row must be excluded in the 5-col shape too. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2. Got ${result.completedPhases}`);
  });

  test('binds to the ## Progress table, not an earlier Phase/Status/Completed-shaped table', () => {
    // A decoy table under a different heading shares the Phase/Status/Completed
    // header shape. The reader must scope to ## Progress (mirroring the writer's
    // #2012 scoping) rather than binding to the first matching table it sees.
    const roadmap = [
      '## Retrospective',
      '',
      '| Phase | Owner | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Old | jo | Complete | 2025-01-01 |',
      '',
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
      '| 3. Security | v1.1 | 0/2 | Not started | - |',
      '',
      '## Next',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 3, `must count the 3 rows of the ## Progress table, not the 1-row decoy. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `must count Complete rows in ## Progress (2), not the decoy's 1. Got ${result.completedPhases}`);
    assert.equal(result.totalPlans, 7, `must sum the ## Progress plans (3+2+2=7). Got ${result.totalPlans}`);
  });

  test('an h3 ### Progress decoy does not hijack the h2 ## Progress scope', () => {
    // Heading detection must be line-anchored to h2: "### Progress".indexOf("## Progress")
    // is 1, so a substring scan would start the slice inside the h3 subheading and
    // miss the real table below.
    const roadmap = [
      '### Progress notes',
      '',
      'Some prose about progress, no table here.',
      '',
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 2, `h2 ## Progress table must be found past the h3 decoy. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2. Got ${result.completedPhases}`);
  });

  // ── Boundary conditions (#2137 review) ──────────────────────────────────────
  // The header-driven walk terminates at the first non-`|` line and skips the
  // separator row, so these edges must not throw and must honour the "0 → null"
  // contract that lets the consumer leave the existing STATE value untouched.

  test('header + separator only (0 data rows) derives all-null', () => {
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.deepEqual(
      result,
      { completedPhases: null, totalPhases: null, totalPlans: null },
      `an empty table must report all-null (0 counts → null), got ${JSON.stringify(result)}`,
    );
  });

  test('exactly one data row derives that single row', () => {
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 4/4 | Complete | 2026-01-01 |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.deepEqual(
      result,
      { completedPhases: 1, totalPhases: 1, totalPlans: 4 },
      `a single Complete row must derive {1,1,4}, got ${JSON.stringify(result)}`,
    );
  });

  test('ragged rows (more/fewer cells than the header) are handled without throwing', () => {
    // (#2242 review Fix 5 / ADR-2143 §3): deriveProgressFromRoadmap now resolves
    // the Progress table via the markdown-table seam's parseMarkdownTable, which
    // is fail-loud on ragged data rows by design — "ragged rows are errors, not
    // silent" (src/markdown-table.cts) — rather than the pre-ADR-2143 reader's
    // graceful cell-count degradation this test used to assert. A ragged row
    // anywhere in the table now makes the WHOLE table unparseable, so the reader
    // falls through to its existing (null) values instead of throwing.
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | 2026-01-01 | stray-extra-column |', // 6 cells (extra)
      '| 2. Beta | v1.0 |', // 2 cells (short: Plans/Status/Completed absent)
    ].join('\n');

    let result;
    assert.doesNotThrow(() => {
      result = deriveProgressFromRoadmap(roadmap);
    }, 'ragged rows must not throw');
    assert.deepEqual(
      result,
      { completedPhases: null, totalPhases: null, totalPlans: null },
      `a ragged-row table must fail loud to all-null (no throw), got ${JSON.stringify(result)}`,
    );
  });
});

// ─── Scenario B: state json total_phases via roadmapPhaseCount ───────────────

describe('bug #1445 — state json excludes 999.x phase headings from total_phases', () => {
  let tmpDir;

  const ROADMAP = [
    '## Milestone v1.0: Test Milestone',
    '',
    '### Phase 01: Alpha',
    '**Goal:** first',
    '',
    '### Phase 02: Beta',
    '**Goal:** second',
    '',
    '### Phase 03: Gamma',
    '**Goal:** third',
    '',
    '### Phase 999.1: Backlog Item A',
    '**Goal:** future idea, not counted',
    '',
    '### Phase 999.2: Backlog Item B',
    '**Goal:** another future idea',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1445-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    }
    // 999.x dirs should exist on disk but must not inflate total_phases
    for (const d of ['999.1-backlog-a', '999.2-backlog-b']) {
      fs.mkdirSync(path.join(planning, 'phases', d), { recursive: true });
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json total_phases is 3, not 5 (999.x dirs and headings excluded)', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const state = JSON.parse(result.output);
    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be 3 (not 5). 999.x backlog phases must be excluded. Got ${state.progress.total_phases}`,
    );
  });
});

// ─── Scenario C: milestone complete not blocked by a 999 backlog heading ─────

describe('fix #1580 — milestone complete ignores the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-mc-');
    const planning = path.join(tmpDir, '.planning');
    // One real, on-disk phase + a directory-less Phase 999 backlog heading.
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('completes WITHOUT --force despite a Phase 999 backlog heading', () => {
    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression', '--confirm'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `milestone complete must not be blocked by the 999 sentinel; got error: ${result.error}`,
    );
    assert.ok(
      !/Cannot mark milestone complete/.test(result.error || ''),
      `the unstarted-phase guard must not fire on Phase 999. Got: ${result.error}`,
    );
  });
});

// ─── Scenario D: roadmap analyze never routes/ counts the 999 sentinel ────────

describe('fix #1580 — roadmap analyze excludes the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-ra-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('next_phase is never 999 and phase_count excludes the sentinel', () => {
    const result = runGsdTools(['roadmap', 'analyze', '--raw'], tmpDir);
    assert.ok(result.success, `roadmap analyze failed: ${result.error}`);
    const analysis = JSON.parse(result.output);
    assert.notEqual(
      String(analysis.next_phase),
      '999',
      `next_phase must never route to the 999 backlog sentinel. Got ${analysis.next_phase}`,
    );
    assert.equal(
      analysis.phase_count,
      1,
      `phase_count must exclude the 999 sentinel (expected 1). Got ${analysis.phase_count}`,
    );
    assert.ok(
      !(analysis.phases || []).some(p => String(p.number) === '999'),
      'the phases array must not include the 999 backlog sentinel',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1446-total-phases-corrects-downward.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1446-total-phases-corrects-downward (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1446:
 * total_phases must correct downward when re-derived; shouldPreserveExistingProgress
 * must NOT include total_phases in its ratchet check.
 *
 * Root cause:
 *   shouldPreserveExistingProgress (state-document.cts) returned true when
 *   existingProgress.total_phases > derivedProgress.total_phases, making the
 *   stored value sticky even when it was wrong (e.g. counted backlog phases).
 *
 * Fix:
 *   total_phases is removed from the "existing exceeds derived" check.
 *   Only completed_phases, total_plans, and completed_plans keep ratchet behaviour.
 *
 * Scenarios:
 *   A. shouldPreserveExistingProgress unit test — returns false when only total_phases differs.
 *   B. state sync re-derives a lower total_phases and writes the new value.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { shouldPreserveExistingProgress } = require('../gsd-core/bin/lib/state-document.cjs');

// ─── Scenario A: unit test ───────────────────────────────────────────────────

describe('bug #1446 — shouldPreserveExistingProgress does not ratchet total_phases', () => {
  test('existing total_phases:10 > derived total_phases:7 → returns false (no ratchet)', () => {
    const existing = { total_phases: 10, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'total_phases downward correction must NOT trigger shouldPreserveExistingProgress',
    );
  });

  test('existing completed_phases:5 > derived completed_phases:2 → returns true (ratchet still active)', () => {
    const existing = { total_phases: 7, completed_phases: 5, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 2, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      true,
      'completed_phases ratchet must still work',
    );
  });

  test('existing total_phases:10 > derived:7 AND completed_phases matches → false (total_phases alone does not preserve)', () => {
    const existing = { total_phases: 10, completed_phases: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'only-total_phases discrepancy must not trigger preservation',
    );
  });

  test('all derived values equal existing → returns false', () => {
    const existing = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false);
  });
});

// ─── Scenario B: end-to-end state sync overwrites inflated total_phases ──────

describe('bug #1446 — state sync writes corrected (lower) total_phases', () => {
  let tmpDir;

  // ROADMAP has 3 real phases only (no 999.x).
  const ROADMAP = [
    '## Milestone v1.0: Test',
    '',
    '### Phase 01: Alpha',
    '**Goal:** alpha',
    '',
    '### Phase 02: Beta',
    '**Goal:** beta',
    '',
    '### Phase 03: Gamma',
    '**Goal:** gamma',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1446-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');

    // STATE.md has a stale inflated total_phases:10 in frontmatter.
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        'progress:',
        '  total_phases: 10',
        '  completed_phases: 2',
        '  total_plans: 6',
        '  completed_plans: 4',
        '  percent: 40',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 3',
        'Status: Executing Phase 3',
        'Last Activity: 2026-01-01',
        'Progress: [████░░░░░░] 40%',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      // Mark 01 and 02 as complete: disk-strict completion (ADR-3180 §7.4,
      // #3186) requires a passing *-VERIFICATION.md, not just a summary — a
      // summary alone no longer implies completion.
      if (d !== '03-gamma') {
        fs.writeFileSync(path.join(dir, 'PLAN-SUMMARY.md'), '# Summary\n', 'utf-8');
        fs.writeFileSync(path.join(dir, `${d.slice(0, 2)}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n', 'utf-8');
      }
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync corrects total_phases from 10 to 3', () => {
    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const state = JSON.parse(jsonResult.output);

    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be corrected to 3 (derived), not kept at 10 (stale). Got ${state.progress.total_phases}`,
    );
    // Disk-strict (ADR-3180 §7.4, #3186): completed_phases is recomputed from
    // disk on every sync (resync=true bypasses the curated-progress ratchet),
    // so it must equal the number of phases with a passing *-VERIFICATION.md
    // (01 and 02), not a preserved/ratcheted stale frontmatter value.
    assert.equal(
      state.progress.completed_phases,
      2,
      `completed_phases must be 2 (01 and 02 have a passing verification). Got ${state.progress.completed_phases}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1514-retired-phase-excluded-from-total-phases.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1514-retired-phase-excluded-from-total-phases (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1514:
 * A retired/folded phase (struck through in ROADMAP, marked `[x]`, with a
 * directory but no completion artifact) must NOT be counted in
 * progress.total_phases. Otherwise it inflates the denominator without ever
 * satisfying the numerator (no SUMMARY → never "completed"), freezing a
 * fully-shipped milestone below 100%.
 *
 * Root cause:
 *   buildStateFrontmatter (state.cts) derived total_phases from
 *   max(phaseDirs.length, roadmapPhaseCount) — both of which counted the
 *   retired phase (its directory and its `### Phase NN:` heading) — while
 *   completed_phases came from a disk SUMMARY scan that the retired phase
 *   can never satisfy. Same counting family as #549 / #500 / #1445.
 *
 * Fix:
 *   buildStateFrontmatter now extracts retired phase numbers from the GFM
 *   strikethrough in the current-milestone ROADMAP scope and excludes them
 *   from BOTH the disk phase-dir set and the heading count, so a retired
 *   phase counts toward neither denominator nor numerator.
 *
 * Why integration (state json) not a unit test: the bug only manifests in the
 * assembled progress block a shipped milestone actually writes to STATE.md, so
 * the test reproduces that artifact rather than a helper in isolation.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { _extractRetiredPhaseNumbers } = require('../gsd-core/bin/lib/state.cjs');
const { normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');

// Six phases, all shipped, except Phase 04 which is retired/folded into 05.
// Phases 01-03,05,06 have PLAN+SUMMARY (complete); Phase 04 keeps a directory
// but no work (retired). `complete` flags which dirs get PLAN+SUMMARY.
function seedProject(prefix, roadmap, completeDirs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 6',
      'Status: shipped',
      'Last Activity: 2026-06-01',
    ].join('\n'),
    'utf-8',
  );
  const allDirs = ['01-alpha', '02-beta', '03-gamma', '04-delta', '05-epsilon', '06-zeta'];
  for (const d of allDirs) {
    const dir = path.join(planning, 'phases', d);
    fs.mkdirSync(dir, { recursive: true });
    if (completeDirs.includes(d)) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
      // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
      // *-VERIFICATION.md is what makes a phase complete now, not a summary
      // alone — this suite is about RETIRED-phase exclusion, not the
      // completion predicate itself.
      fs.writeFileSync(path.join(dir, `${d}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n', 'utf-8');
    }
  }
  return tmpDir;
}

const PHASE_DETAILS = [
  '### Phase 01: Alpha', '**Goal:** a', '',
  '### Phase 02: Beta', '**Goal:** b', '',
  '### Phase 03: Gamma', '**Goal:** c', '',
  '### Phase 04: Delta', '**Goal:** GOAL_04', '',
  '### Phase 05: Epsilon', '**Goal:** e', '',
  '### Phase 06: Zeta', '**Goal:** f',
];

function roadmap(checklist04, goal04) {
  return [
    '## Milestone v1.0: Repro',
    '',
    '### Phases',
    '- [x] **Phase 01: Alpha** — done',
    '- [x] **Phase 02: Beta** — done',
    '- [x] **Phase 03: Gamma** — done',
    checklist04,
    '- [x] **Phase 05: Epsilon** — done',
    '- [x] **Phase 06: Zeta** — done',
    '',
    ...PHASE_DETAILS.map((l) => (l === '**Goal:** GOAL_04' ? `**Goal:** ${goal04}` : l)),
  ].join('\n');
}

const ALL_COMPLETE = ['01-alpha', '02-beta', '03-gamma', '05-epsilon', '06-zeta'];

describe('bug #1514 — retired/folded phase excluded from progress.total_phases', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('struck `[x] ~~Phase 04~~ — folded into Phase 05` → 5/5, percent 100 (not 5/6, 83)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-a-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `total_phases must exclude the retired phase. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `shipped milestone must reach 100%. Got ${progress.percent}`);
  });

  test('fold TARGET is not retired: a struck goal line `~~folded into Phase 05~~` must not drop Phase 05', () => {
    // Phase 04 retired via checklist; Phase 04 *goal* also struck and mentions
    // the fold target. The target (Phase 05) must remain a counted phase.
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      '~~folded into Phase 05; retired~~',
    );
    tmpDir = seedProject('bug-1514-b-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `only Phase 04 is retired; Phase 05 must still count. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('regression: no strikethrough → all 6 phases counted (6/6, 100)', () => {
    const rm = roadmap('- [x] **Phase 04: Delta** — done', 'd');
    tmpDir = seedProject('bug-1514-c-', rm, [...ALL_COMPLETE, '04-delta']);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 6, `no retired phase: all 6 counted. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 6, `Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  // `state sync --verify` is the SECOND counting path (cmdStateSync). Before the
  // fix it re-derived the same inflated denominator and reported "no drift",
  // so a manual STATE edit was the only recourse (#1514). It must now agree
  // with state json and drive the stuck 83% Progress field to 100%.
  test('state sync --verify drives a stuck 83% Progress to 100% (cmdStateSync path)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-sync-', rm, ALL_COMPLETE);
    // Seed a stuck Progress line that the inflated denominator would "agree" with.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.appendFileSync(statePath, '\nProgress: [████████░░] 83%\n', 'utf-8');
    const result = runGsdTools(['state', 'sync', '--verify'], tmpDir);
    assert.ok(result.success, `state sync --verify failed: ${result.error}`);
    const { changes } = JSON.parse(result.output);
    const progressChange = (changes || []).find((c) => /Progress:/.test(c));
    assert.ok(progressChange, `expected a Progress drift, got changes: ${JSON.stringify(changes)}`);
    assert.match(progressChange, /-> .*100%/, `sync must want 100%, got: ${progressChange}`);
  });
});

// ─── Generic seeder for non-canonical phase shapes ──────────────────────────

/**
 * Seed a project from explicit phase specs so project-code, decimal,
 * no-directory, and shipped-then-retired shapes can be exercised.
 * spec: { id, retired?, dir?, shipped? }
 *   id      — ROADMAP phase id (e.g. '04', '05.1', 'PROJ-42')
 *   retired — strike the checklist entry (folded/retired)
 *   dir     — directory name to create (omit → no directory)
 *   shipped — write PLAN+SUMMARY into the directory (complete)
 */
function seedFromSpecs(prefix, specs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  const checklist = specs.map((s) =>
    s.retired
      ? `- [x] ~~**Phase ${s.id}: P${s.id}**~~ — retired`
      : `- [x] **Phase ${s.id}: P${s.id}** — done`,
  );
  const details = specs.flatMap((s) => [`### Phase ${s.id}: P${s.id}`, '**Goal:** g', '']);
  const roadmapText = ['## Milestone v1.0: Specs', '', '### Phases', ...checklist, '', ...details].join('\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 1'].join('\n'),
    'utf-8',
  );
  for (const s of specs) {
    if (!s.dir) continue;
    const dir = path.join(planning, 'phases', s.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (s.shipped) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
      // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
      // *-VERIFICATION.md makes a phase complete now.
      fs.writeFileSync(path.join(dir, `${s.dir}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n', 'utf-8');
    }
  }
  return tmpDir;
}

describe('bug #1514 — retired exclusion across phase shapes', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('project-code retired phase is dropped from the denominator (Phase PROJ-42)', () => {
    // Project-code dirs are not milestone-mapped for completion counts (a
    // separate pre-existing limitation), so assert only the total_phases
    // denominator, which #1514 governs: the struck PROJ-42 heading must not
    // be counted, while PROJ-41 / PROJ-43 still are.
    tmpDir = seedFromSpecs('bug-1514-pc-', [
      { id: 'PROJ-41', dir: 'PROJ-41-a', shipped: true },
      { id: 'PROJ-42', retired: true, dir: 'PROJ-42-d' },
      { id: 'PROJ-43', dir: 'PROJ-43-c', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 2, `retired project-code phase must be excluded. Got ${progress.total_phases}`);
  });

  test('decimal, multiple, shipped-then-retired, and no-directory retired phases all excluded', () => {
    // Retired: 02 (executed → has SUMMARY, then folded), 04 (no work),
    // 05.1 (decimal, no directory at all). Live: 01, 03, 06.
    tmpDir = seedFromSpecs('bug-1514-multi-', [
      { id: '01', dir: '01-a', shipped: true },
      { id: '02', retired: true, dir: '02-b', shipped: true },
      { id: '03', dir: '03-c', shipped: true },
      { id: '04', retired: true, dir: '04-d' },
      { id: '05.1', retired: true },
      { id: '06', dir: '06-f', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `3 retired of 6 → total 3. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `live phases 01/03/06 complete. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('boundary: every phase retired (k === n) → total_phases 0', () => {
    tmpDir = seedFromSpecs('bug-1514-all-', [
      { id: '01', retired: true, dir: '01-a' },
      { id: '02', retired: true, dir: '02-b' },
      { id: '03', retired: true, dir: '03-c' },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 0, `all phases retired → denominator 0. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 0, `Got ${progress.completed_phases}`);
  });

  test('strikethrough in a non-checklist/heading line (a goal) does NOT retire that phase', () => {
    // Detection is scoped to checklist/heading lines, so a struck GOAL line
    // that begins with a phase reference must not retire it.
    const tmp = createTempProject('bug-1514-prose-');
    const planning = path.join(tmp, '.planning');
    const roadmapText = [
      '## Milestone v1.0: Prose',
      '',
      '### Phases',
      '- [x] **Phase 01: A** — done',
      '- [x] **Phase 02: B** — done',
      '- [x] **Phase 03: C** — done',
      '',
      '### Phase 01: A', '**Goal:** g',
      '### Phase 02: B', '**Goal:** ~~Phase 02 was renamed from an earlier plan~~',
      '### Phase 03: C', '**Goal:** g',
    ].join('\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 3'].join('\n'),
      'utf-8',
    );
    for (const d of ['01-a', '02-b', '03-c']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
      // Disk-strict completion (ADR-3180 §7.4, #3186): only a passing
      // *-VERIFICATION.md makes a phase complete now.
      fs.writeFileSync(path.join(dir, `${d}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n', 'utf-8');
    }
    tmpDir = tmp;
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `struck prose in a goal line must not retire Phase 02. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `Got ${progress.completed_phases}`);
  });
});

// ─── Property: the strikethrough parser extracts exactly the struck set ──────

// extractRetiredPhaseNumbers is the parsing/transformation core of the fix, so
// per RULESET.TESTS.property-based-testing it carries a fast-check property:
// for a roadmap with k of n checklist phases struck, the parser must return
// exactly the canonical keys of those k phases — no more, no fewer — across
// randomized phase counts and numeric/zero-padded/project-code ID forms. This
// underpins the `total_phases === n - k` guarantee the integration tests assert.
describe('bug #1514 — extractRetiredPhaseNumbers property: returns exactly the struck set', () => {
  const idForm = (num, form) =>
    form === 'padded' ? String(num).padStart(2, '0')
      : form === 'project' ? `PROJ-${num}`
        : String(num);
  const keyOf = (num, form) => normalizePhaseName(idForm(num, form)).toUpperCase();

  test('k-of-n struck phases → exactly k canonical keys, for any n/form', () => {
    fc.assert(
      fc.property(
        // Distinct phase numbers so canonical keys don't collide within a run.
        fc.uniqueArray(fc.integer({ min: 1, max: 98 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        fc.constantFrom('plain', 'padded', 'project'),
        (nums, flagsRaw, form) => {
          const lines = ['## Milestone v1.0: M', '', '### Phases'];
          const struck = [];
          nums.forEach((num, i) => {
            const id = idForm(num, form);
            if (flagsRaw[i]) {
              lines.push(`- [x] ~~**Phase ${id}: P${num}**~~ — folded; retired`);
              struck.push(num);
            } else {
              lines.push(`- [x] **Phase ${id}: P${num}** — done`);
            }
          });

          const got = _extractRetiredPhaseNumbers(lines.join('\n'));
          const expected = new Set(struck.map((num) => keyOf(num, form)));

          assert.equal(got.size, expected.size, `size: got ${got.size}, expected ${expected.size}`);
          for (const k of expected) assert.ok(got.has(k), `missing struck key ${k}`);
          for (const k of got) assert.ok(expected.has(k), `extra (non-struck) key ${k}`);
        },
      ),
    );
  });
});

// ─── #2440: total_plans excluded from progress ratchet (per-counter) ──────────
//
// Pre-fix: shouldPreserveExistingProgress included total_plans in the ratchet.
// Fix: total_plans joins total_phases as always-derived (both move in both
// directions). Only completed_phases and completed_plans keep ratchet behaviour.

describe('bug #2440 — shouldPreserveExistingProgress does not ratchet total_plans', () => {
  const { shouldPreserveExistingProgress } = require('../gsd-core/bin/lib/state-document.cjs');

  test('existing total_plans:50 > derived:64 → returns false (upward correction)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 49 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 64, completed_plans: 49 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans upward correction must NOT trigger ratchet');
  });

  test('existing total_plans:50 > derived:30 → returns false (downward correction)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 30 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 30, completed_plans: 30 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans downward correction must NOT trigger ratchet');
  });

  test('boundary: existing total_plans == derived → false', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 50 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 50 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans equality must NOT trigger ratchet');
  });

  test('completed_plans:5 > derived:2 → true (ratchet still active for completed_plans)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 6, completed_plans: 5 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 6, completed_plans: 2 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), true,
      'completed_plans ratchet must still work');
  });
});
  });
}

// ─── #2573: state_head commit provenance on the write seam ───────────────────

describe('syncStateFrontmatter — state_head commit provenance (#2573)', () => {
  const { runGit } = require('./helpers/process-seam.cjs');
  const { syncStateFrontmatter } = require('../gsd-core/bin/lib/state.cjs');
  const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
  const { createTempGitProject: mkGit } = require('./helpers.cjs');

  const dirs = [];
  const track = (d) => { dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

  const MINIMAL_STATE = [
    '---',
    'status: executing',
    '---',
    '',
    '# Session State',
    '',
    'Status: executing',
    '',
  ].join('\n');

  test('stamps state_head with the full HEAD sha of the project repo', () => {
    const dir = track(mkGit('gsd-2573-'));
    const head = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    const synced = syncStateFrontmatter(MINIMAL_STATE, dir);
    const fm = extractFrontmatter(synced);

    assert.strictEqual(fm.state_head, head,
      'state_head must record the commit STATE.md was written against');
  });

  test('omits state_head entirely when the project is not a git repo (degrade, never throw)', () => {
    // trek-e's approval condition 3: degrade to no-signal rather than throwing
    // when the commit is unresolvable. A non-repo is the canonical case.
    const dir = track(createTempProject('gsd-2573-nogit-'));

    let synced;
    assert.doesNotThrow(() => { synced = syncStateFrontmatter(MINIMAL_STATE, dir); },
      'a non-git project must not throw');
    const fm = extractFrontmatter(synced);

    assert.ok(!('state_head' in fm),
      `state_head must be absent outside a git repo, got ${JSON.stringify(fm.state_head)}`);
  });

  test('drops a PRE-EXISTING state_head when the commit becomes unresolvable (never carried forward)', () => {
    // The omission test above feeds MINIMAL_STATE, which has no pre-existing
    // state_head — so it never reaches the #2202 carry-forward loop, which
    // copies any key absent from derivedFm straight back from the old file.
    // This fixture DOES carry a stamp, so it exercises that branch.
    //
    // state-transition.cts classifies state_head as { preservation: 'derive' }:
    // "Never preserved: a stale stamp would claim STATE.md was written against
    // a commit it wasn't." A carried-forward value contradicts that contract and
    // asserts provenance the file no longer has.
    const STAMPED_STATE = [
      '---',
      'status: executing',
      'state_head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '---',
      '',
      '# Session State',
      '',
      'Status: executing',
      '',
    ].join('\n');

    const dir = track(createTempProject('gsd-2573-stale-stamp-'));

    let synced;
    assert.doesNotThrow(() => { synced = syncStateFrontmatter(STAMPED_STATE, dir); },
      'a non-git project must not throw even with a pre-existing stamp');
    const fm = extractFrontmatter(synced);

    assert.ok(!('state_head' in fm),
      `a stale state_head must be DROPPED, not carried forward, when the commit is unresolvable — got ${JSON.stringify(fm.state_head)}`);
  });

  test('restamps state_head to the new HEAD after a commit (freshness proxy resets on write)', () => {
    // Goodhart guard, asserted rather than assumed: the counter resets as a
    // side effect of ANY state write, so state_head means "written at this
    // commit", never "STATE's content is accurate". Pinning it here so nobody
    // later builds a gate on the derived commit distance.
    const dir = track(mkGit('gsd-2573-restamp-'));
    const first = extractFrontmatter(syncStateFrontmatter(MINIMAL_STATE, dir)).state_head;

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'change\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-m', 'unrelated'], { cwd: dir });
    const second = extractFrontmatter(syncStateFrontmatter(MINIMAL_STATE, dir)).state_head;

    const head = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
    assert.notStrictEqual(second, first, 'a new commit must produce a new state_head');
    assert.strictEqual(second, head, 'state_head must track the current HEAD');
  });

  test('carries a body-absent last_activity forward instead of dropping it (#2622 B1)', () => {
    // #2622 B1: the #2202 carry-forward loop skips `source: 'free'` fields
    // (state_head) so an unresolvable stamp is never re-asserted — but it must
    // NOT skip `last_activity` ({source:'body', preservation:'derive'}). When the
    // body carries no "Last activity:" line, buildStateFrontmatter omits the
    // field, and the existing frontmatter value has to survive: dropping it is
    // silent frontmatter data loss and would defeat #2570's staleness signal
    // downstream. A non-git project keeps this on the carry-forward path
    // (state_head is simply absent) and needs no subprocess.
    const STATE_WITH_ACTIVITY = [
      '---',
      'status: executing',
      'last_activity: 2026-01-15',
      '---',
      '',
      '# Session State',
      '',
      'Status: executing',
      '',
    ].join('\n');

    const dir = track(createTempProject('gsd-2622-b1-'));
    const fm = extractFrontmatter(syncStateFrontmatter(STATE_WITH_ACTIVITY, dir));

    assert.strictEqual(fm.last_activity, '2026-01-15',
      'a body-absent last_activity must carry forward, not be dropped by the state_head narrowing');
  });
});


// ─── #2573: property invariants for the state_head fence ─────────────────────
//
// `state_head` is read from disk and then passed to git AS AN ARGUMENT, which
// makes this a parser with a security-relevant fence — the class the repo's
// testing standards require fast-check coverage for. Example-based tests pin
// the shapes we thought of; these pin the invariant for the ones we didn't.

describe('readStateHeadFreshness — property invariants (#2573)', () => {
  const fc = require('./helpers/fast-check-setup.cjs');
  const { runGit } = require('./helpers/process-seam.cjs');
  const { after } = require('node:test');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { cleanup } = require('./helpers.cjs');
  const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');

  const propDirs = [];
  after(() => { while (propDirs.length) cleanup(propDirs.pop()); });

  function gitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-prop-'));
    propDirs.push(dir);
    runGit(['init', '-q'], { cwd: dir });
    runGit(['config', 'user.email', 't@t.com'], { cwd: dir });
    runGit(['config', 'user.name', 'T'], { cwd: dir });
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-q', '-m', 'seed'], { cwd: dir });
    return dir;
  }

const HEX_RE = /^[0-9a-f]{4,40}$/i;

  const repo = gitRepo();

  test('(a) total function — never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        readStateHeadFreshness(repo, value);
        return true;
      }),
    );
  });

  test('(b) fence — non-hex input never yields a stamp', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = readStateHeadFreshness(repo, s);
        if (HEX_RE.test(s.trim())) return true; // valid shape: out of scope here
        return r.state_head === null && r.commits_behind === null && r.commit_stale === null;
      }),
    );
  });

  test('(c) tri-state integrity — unknown never reads as known-fresh', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = readStateHeadFreshness(repo, s);
        const validTri = r.commit_stale === null || r.commit_stale === true || r.commit_stale === false;
        const unknownIsNull = r.commits_behind === null ? r.commit_stale === null : true;
        const agreement = typeof r.commits_behind === 'number'
          ? r.commit_stale === (r.commits_behind > 0)
          : true;
        return validTri && unknownIsNull && agreement;
      }),
    );
  });

  test('(d) no git-argument injection — dash-led values are rejected by the fence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('--all', '-n', '--not', '--output=/tmp/pwn', '--help', '-- --all'),
        fc.string(),
        (flag, tail) => {
          const r = readStateHeadFreshness(repo, `${flag}${tail}`);
          return r.state_head === null && r.commits_behind === null && r.commit_stale === null;
        },
      ),
    );
  });

  test('(f) a NON-ANCESTOR stamp resolves to unknown, never to "known fresh"', () => {
    // `rev-list --count A..B` exits 0 with "0" when A is unreachable from B, so
    // reset --hard / rebase / squash / force-push past the stamp used to render
    // as commit_stale:false — "known fresh" for a codebase that was rewound.
    // That collapses the exact unknown-vs-fresh distinction the tri-state exists
    // to preserve, so a non-ancestor stamp must come back null.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-nonanc-'));
    propDirs.push(d);
    const g = (argv) => runGit(argv, { cwd: d }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'c1']);
    const tip = g(['rev-parse', 'HEAD']).trim();
    g(['reset', '--hard', '-q', base]);

    const r = readStateHeadFreshness(d, tip);
    assert.strictEqual(r.commits_behind, null, 'a non-ancestor stamp has no meaningful distance');
    assert.strictEqual(r.commit_stale, null, 'unknown must NOT report as false ("known fresh")');
  });

  test('(e) a real HEAD sha always resolves to zero commits behind', () => {
    const head = runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    const r = readStateHeadFreshness(repo, head);
    assert.strictEqual(r.commits_behind, 0);
    assert.strictEqual(r.commit_stale, false);
    assert.strictEqual(r.state_head, head.slice(0, 7));
  });

  test('(g) a project whose nearest .git is an ANCESTOR repo resolves to unknown, never "known fresh"', () => {
    // #2573 degrade path D5. `git rev-parse HEAD` walks UP from cwd to the
    // nearest enclosing .git — nothing pins that repo to the project. A GSD
    // project living under an unrelated repo (a dotfiles/notes checkout, or the
    // outer workspace of a planning.sub_repos layout) measures its freshness
    // against a repo it has no relationship to.
    //
    // The stamp below IS that ancestor repo's HEAD, so pre-fix the ancestry
    // check passes, rev-list returns 0, and the tri-state reports
    // commit_stale:false — "known fresh" for a directory that is not in that
    // repo at all. Same invariant violation as (f), reached by another route.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-ancestor-'));
    propDirs.push(outer);
    const g = (argv) => runGit(argv, { cwd: outer }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(outer, 'unrelated.txt'), 'x\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'outer']);
    const outerHead = g(['rev-parse', 'HEAD']).trim();

    // The project itself is NOT a git repo — it merely sits inside one.
    const project = path.join(outer, 'nested-project');
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });

    const r = readStateHeadFreshness(project, outerHead);
    assert.strictEqual(r.commit_stale, null,
      'a stamp resolved against an ancestor repo is UNKNOWN — it must not report false ("known fresh")');
    assert.strictEqual(r.commits_behind, null,
      'distance measured against an unrelated repo is not a meaningful count');
  });

  test('(h) a SYMLINKED project path still resolves — repo pinning compares identity, not spelling', () => {
    // Guard against over-tightening (g). `git rev-parse --show-toplevel` reports
    // the REAL path while the project root arrives as the caller spelled it, and
    // those differ routinely: macOS temp dirs (/var/folders → /private/var/folders),
    // any symlinked checkout, Windows casing. A raw string compare would report a
    // perfectly normal project as unknown — the inverse of the bug (g) fixes, and
    // exactly what broke the macOS and Windows CI shards.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symreal-'));
    propDirs.push(realDir);
    const g = (argv) => runGit(argv, { cwd: realDir }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(realDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symlink-')), 'proj');
    propDirs.push(path.dirname(linkDir));
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {
      return; // symlink creation unavailable (e.g. unprivileged Windows) — nothing to assert
    }

    const r = readStateHeadFreshness(linkDir, head);
    assert.strictEqual(r.commit_stale, false,
      'a symlinked project path is the SAME repo — it must resolve, not degrade to unknown');
    assert.strictEqual(r.commits_behind, 0);
  });

  test('(i) a sub_repos workspace resolves to unknown even though it owns its own repo', () => {
    // #2573 D5, sub_repos flavor. (g) covers the case where the project owns NO
    // .git. This is the harder one: the outer workspace owns BOTH .planning/ and
    // its own repo, so projectOwnsItsRepo passes — yet every code commit lands in
    // a nested child repo and the outer HEAD never advances.
    //
    // Pre-fix that stamps the outer HEAD, --is-ancestor passes trivially,
    // rev-list counts 0, and the tri-state reports commit_stale:false — "known
    // fresh" — no matter how far the children have moved. That is a WRONG answer,
    // not a missing one: the same invariant (g) protects, reached by a third
    // route. docs/CONFIGURATION.md describes sub_repos as scoping work per
    // sub-repo "instead of treating the outer repo as a monorepo", so an outer
    // wrapper that is itself a repo is a supported layout, not a contrived one.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-subrepos-'));
    propDirs.push(outer);
    const g = (argv) => runGit(argv, { cwd: outer }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(outer, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(outer, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['frontend'] } }, null, 2),
    );
    fs.writeFileSync(path.join(outer, 'wrapper.txt'), 'x\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'outer']);
    const outerHead = g(['rev-parse', 'HEAD']).trim();

    // A separately tracked child repo — where the real work happens. The outer
    // repo is deliberately NOT advanced past `outerHead` afterwards, which is
    // precisely the topology that makes the stale reading look fresh.
    const child = path.join(outer, 'frontend');
    fs.mkdirSync(child, { recursive: true });
    const gc = (argv) => runGit(argv, { cwd: child }).stdout;
    gc(['init', '-q']); gc(['config', 'user.email', 't@t.com']); gc(['config', 'user.name', 'T']);
    gc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(child, 'app.js'), 'let a = 1;\n');
    gc(['add', '-A']); gc(['commit', '-q', '-m', 'child']);

    const r = readStateHeadFreshness(outer, outerHead);
    assert.strictEqual(r.commit_stale, null,
      'a sub_repos workspace cannot substantiate a freshness claim from the outer ' +
      'HEAD — it must report unknown, never false ("known fresh")');
    assert.strictEqual(r.commits_behind, null,
      'a distance measured against the wrapper repo is not a meaningful count');
  });

  test('(j) a plain single-repo project is NOT degraded by the sub_repos check', () => {
    // Over-tightening guard for (i), mirroring what (h) does for (g). An empty or
    // absent sub_repos must leave the normal path untouched — a check that
    // degraded every project to unknown would "pass" (i) while destroying the
    // feature, which is the failure mode this pins.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-plain-'));
    propDirs.push(dir);
    const g = (argv) => runGit(argv, { cwd: dir }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: [] } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const r = readStateHeadFreshness(dir, head);
    assert.strictEqual(r.commit_stale, false,
      'an empty sub_repos list is a normal single-repo project — it must resolve');
    assert.strictEqual(r.commits_behind, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3468 matrix section B, rows B7/B8 — ADR-3408 §8.2's bright line, exercised
// through the REAL production write path rather than a hand-built
// applyStatePreservation input (CONTRIBUTING.md § Fixture provenance #2371:
// a test constructing its own convenient input proves a property no shipping
// caller exercises).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3468 B7: the production caller wires every declared preserve-when-unchanged row', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3468-b7-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('B7: readModifyWriteStateMd never throws the §8.2 invariant on a normal write', () => {
    // The real caller (state.cts:2744-2795, the ONLY call site of
    // applyStatePreservation) computes and wires bodyDeltas for every
    // declared preserve-when-unchanged row. Driving a normal transform
    // through the real function — not a hand-built applyStatePreservation
    // call — is what proves B1's throw can never fire in production.
    assert.doesNotThrow(() => {
      stateLib.readModifyWriteStateMd(
        statePath,
        (content) => `${content}\n<!-- #3468 B7 probe -->\n`,
        tmpDir,
      );
    });
    // Also exercise the resync:false (body-only) branch — a second,
    // independently-reachable call shape into the same pipeline.
    assert.doesNotThrow(() => {
      stateLib.readModifyWriteStateMd(
        statePath,
        (content) => `${content}\n<!-- #3468 B7 probe 2 -->\n`,
        tmpDir,
        { resync: false },
      );
    });
  });
});

describe('#3468 B8: a drifted / malformed / unparseable STATE.md never reaches the invariant throw (§8.2 bright line)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3468-b8-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Each fixture replaces the fixture-generated STATE.md with a document that
  // is drifted, malformed, or unparseable in a distinct way. None of these
  // are internal invariant violations — they are exactly the "ordinary,
  // expected user-document state" ADR-3408 §8.5 names, so the command must
  // never surface the §8.2 invariant (an uncaught internal Error).
  const fixtures = [
    {
      name: 'drifted: frontmatter current_phase disagrees with the body Phase: line',
      content: [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: "7"',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 2 (Stale Name) — EXECUTING',
        'Plan: 1 of 3',
        'Status: Executing Phase 2',
        '',
      ].join('\n'),
    },
    {
      name: 'malformed: frontmatter fields carry the wrong YAML type',
      content: [
        '---',
        'gsd_state_version: 1.0',
        'status: 42',
        'progress: "not-an-object"',
        'current_phase_name: [Unexpected, Array]',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 2 (Some Phase) — EXECUTING',
        'Plan: 1 of 3',
        'Status: Executing Phase 2',
        '',
      ].join('\n'),
    },
    {
      name: 'unparseable: frontmatter fence opens but never closes',
      content: [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        '',
        '# Project State (frontmatter never terminated above)',
        '',
        '## Current Position',
        '',
        'Phase: 2 (Some Phase) — EXECUTING',
        'Plan: 1 of 3',
        'Status: Executing Phase 2',
        '',
      ].join('\n'),
    },
  ];

  for (const fixture of fixtures) {
    test(`B8: ${fixture.name}`, () => {
      fs.writeFileSync(statePath, fixture.content);

      const result = runGsdTools(['state', 'sync', '--json-errors'], tmpDir);

      if (result.success) {
        assert.doesNotThrow(
          () => JSON.parse(result.output),
          `${fixture.name}: success output must be well-formed JSON; got: ${result.output}`,
        );
        return;
      }

      // A non-zero exit is allowed (a drifted document may be a legitimate
      // domain-level failure) — but it must be a CONTROLLED failure. Under
      // --json-errors, an ExitError (a deliberate error() call) always
      // writes PLAIN TEXT to stderr (never JSON — see tests/cli-exit.test.cjs
      // #2979), while an uncaught internal Error (what the §8.2 invariant
      // throw would be, since it is deliberately never caught by a discriminator
      // per ADR-3408 §8.2's "Rejected: Return a ScopedResult") is the ONLY
      // path that emits the JSON envelope with reason: SDK_FAIL_FAST. So: if
      // stderr parses as that envelope, the command crashed on an uncaught
      // internal error — the exact bright line B8 forbids.
      let structured = null;
      try { structured = JSON.parse(result.error); } catch { /* plain text — a controlled ExitError, expected */ }
      if (structured) {
        assert.notStrictEqual(
          structured.reason,
          ERROR_REASON.SDK_FAIL_FAST,
          `${fixture.name}: command crashed on an uncaught internal error instead of a controlled failure — ` +
          `this is the §8.2 invariant bright line: a user document must never trigger it. stderr: ${result.error}`,
        );
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #3481: `state add-roadmap-evolution` resolves the phase from STATE.md's own
// frontmatter/body when `--phase` is omitted, instead of persisting a literal
// `Phase ?`. This is the #3231 defect at a second call site — the sibling
// `add-decision` site (also currently unfixed on next, per the #3481 triage)
// is pinned here too, so the whole class is covered by one contract.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { describe, test, beforeEach, afterEach } = require('node:test');
  const assert = require('node:assert/strict');
  const path = require('path');

  describe('#3481 phase-labeled write commands resolve the phase from STATE.md when --phase is omitted', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = createTempProject(); });
    afterEach(() => { cleanup(tmpDir); });

    const statePathIn = (d) => path.join(d, '.planning', 'STATE.md');

    // Write a STATE.md verbatim, bypassing the project scaffold, so each test
    // controls exactly which rung of the resolution ladder is populated.
    const writeState = (d, content) => fs.writeFileSync(statePathIn(d), content);

    const run = (d, args) => {
      const result = runGsdTools(args, d);
      assert.ok(result.success, `command must succeed, got: ${result.error}`);
      return JSON.parse(result.output);
    };

    // Assert on the persisted file, not only the JSON echo — the defect in
    // #3481 is that the placeholder is written to disk permanently.
    const persistedLines = (d, prefix) =>
      fs.readFileSync(statePathIn(d), 'utf-8')
        .split(/\r?\n/)
        .filter(l => l.startsWith(prefix));

    const STATE_WITH_FM_PHASE = [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 3',
      'current_phase_name: Sourcing Coverage',
      'status: executing',
      '---',
      '',
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '### Decisions',
      '',
    ].join('\n');

    // ── add-roadmap-evolution (the site #3481 reports) ──────────────────────

    test('add-roadmap-evolution: frontmatter current_phase resolves the entry when --phase is omitted', () => {
      writeState(tmpDir, STATE_WITH_FM_PHASE);

      const parsed = run(tmpDir, ['state', 'add-roadmap-evolution', '--action', 'added', '--note', 'Phase 4.2 inserted for enrichment reach']);

      assert.strictEqual(
        parsed.entry,
        '- Phase 3 added: Phase 4.2 inserted for enrichment reach',
        'omitted --phase must resolve from frontmatter current_phase, not render "?"',
      );
      assert.deepStrictEqual(
        persistedLines(tmpDir, '- Phase 3 added:'),
        ['- Phase 3 added: Phase 4.2 inserted for enrichment reach'],
        'the resolved phase must be what lands in STATE.md',
      );
    });

    test('add-roadmap-evolution: explicit --phase wins over a resolvable frontmatter current_phase', () => {
      writeState(tmpDir, STATE_WITH_FM_PHASE);

      const parsed = run(tmpDir, ['state', 'add-roadmap-evolution', '--phase', '7', '--action', 'verified', '--note', 'Explicit wins']);

      assert.strictEqual(
        parsed.entry,
        '- Phase 7 verified: Explicit wins',
        'an explicitly passed --phase must never be overridden by the resolved value',
      );
    });

    test('add-roadmap-evolution: prose "Phase:" under ## Current Position resolves, preserving a non-integer id', () => {
      writeState(tmpDir, [
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 04.1 of 7',
        '',
        '## Accumulated Context',
        '',
      ].join('\n'));

      const parsed = run(tmpDir, ['state', 'add-roadmap-evolution', '--action', 'edited', '--note', 'Prose rung']);

      // Phase ids are not always integers — 04.1 must survive verbatim.
      assert.strictEqual(parsed.entry, '- Phase 04.1 edited: Prose rung');
    });

    // Counter-test (TESTING-STANDARDS.md contract 6): assert the specific
    // degraded verdict. When no rung resolves, the entry must still read "?"
    // — an unknown phase stays visibly unknown and is never guessed.
    test('add-roadmap-evolution CONTROL: no phase resolvable from any rung still writes a literal "?"', () => {
      writeState(tmpDir, [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Accumulated Context',
        '',
      ].join('\n'));

      const parsed = run(tmpDir, ['state', 'add-roadmap-evolution', '--action', 'added', '--note', 'Unresolvable stays unknown']);

      assert.strictEqual(
        parsed.entry,
        '- Phase ? added: Unresolvable stays unknown',
        'with no frontmatter current_phase, no body "Current Phase" field and no scoped prose Phase line, the entry must degrade to "?" — not to a default, an empty string, or a guessed number',
      );
      assert.deepStrictEqual(persistedLines(tmpDir, '- Phase ? added:'), ['- Phase ? added: Unresolvable stays unknown']);
    });

    // Counter-test pinning #1776: the write path must NOT adopt a phase-shaped
    // token from outside the designated current-position location. A stale
    // historical `| Phase | 7 |` table row is not this document's current phase.
    test('add-roadmap-evolution CONTROL: a historical Phase row outside Current Position must not resolve (#1776)', () => {
      writeState(tmpDir, [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Verification History',
        '',
        '| Field | Value |',
        '|---|---|',
        '| Phase | 7 |',
        '',
        '## Accumulated Context',
        '',
      ].join('\n'));

      const parsed = run(tmpDir, ['state', 'add-roadmap-evolution', '--action', 'added', '--note', 'Stale table must not win']);

      assert.strictEqual(
        parsed.entry,
        '- Phase ? added: Stale table must not win',
        'the prose rung is scoped to ## Current Position; a | Phase | N | row in a historical table must not be persisted as this entry\'s phase',
      );
    });

    // ── add-decision (the #3231 sibling site — same defect, same fix) ───────

    test('add-decision: frontmatter current_phase resolves the entry when --phase is omitted', () => {
      writeState(tmpDir, STATE_WITH_FM_PHASE);

      const parsed = run(tmpDir, ['state', 'add-decision', '--summary', 'Dedup threshold set to 0.85 by sweep']);

      assert.strictEqual(
        parsed.decision,
        '- [Phase 3]: Dedup threshold set to 0.85 by sweep',
        'omitted --phase must resolve from frontmatter current_phase, not render "?"',
      );
      assert.deepStrictEqual(
        persistedLines(tmpDir, '- [Phase 3]:'),
        ['- [Phase 3]: Dedup threshold set to 0.85 by sweep'],
        'the resolved phase must be what lands in STATE.md',
      );
    });

    test('add-decision: explicit --phase wins over a resolvable frontmatter current_phase', () => {
      writeState(tmpDir, STATE_WITH_FM_PHASE);

      const parsed = run(tmpDir, ['state', 'add-decision', '--phase', '7', '--summary', 'Explicit wins']);

      assert.strictEqual(parsed.decision, '- [Phase 7]: Explicit wins');
    });

    test('add-decision CONTROL: a historical Phase row outside Current Position must not resolve (#1776)', () => {
      writeState(tmpDir, [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Verification History',
        '',
        '| Field | Value |',
        '|---|---|',
        '| Phase | 7 |',
        '',
        '### Decisions',
        '',
      ].join('\n'));

      const parsed = run(tmpDir, ['state', 'add-decision', '--summary', 'Stale table must not win']);

      assert.strictEqual(
        parsed.decision,
        '- [Phase ?]: Stale table must not win',
        'the prose rung is scoped to ## Current Position; a | Phase | N | row in a historical table is not this document\'s current phase',
      );
    });

    // ── Guard (skill "Partial Fix Across Call Sites"): the #3481/#3231 defect
    // class is "entry text built from the RAW CLI phase flag with a '?' fallback,
    // never consulting the document being written". Behavioral tests above pin
    // the two known sites; this static sweep catches any NEW site that
    // regresses to the same shape — the fix routes every such site through the
    // resolved id, so the raw-flag pattern must not reappear in src/.
    test('GUARD: no phase-labeled entry is built from the raw CLI phase flag with a "?" fallback', () => {
      const SRC_DIR = path.join(__dirname, '..', 'src');
      const offenders = fs.readdirSync(SRC_DIR)
        .filter(f => f.endsWith('.cts'))
        .flatMap(f => {
          const rel = path.join('src', f);
          const lines = fs.readFileSync(path.join(SRC_DIR, f), 'utf-8').split(/\r?\n/);
          return lines
            .map((line, i) => ({ rel, i, line }))
            .filter(({ line }) => line.includes('Phase ${phase || \'?\'}'));
        })
        .map(({ rel, i }) => `${rel}:${i + 1}`);

      assert.deepStrictEqual(
        offenders,
        [],
        'raw `phase || \'?\'` placeholder in a phase-labeled entry — resolve the phase from the STATE.md being written '
          + '(see resolveCurrentPhaseId, #3231/#3481): ' + offenders.join(', '),
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// #3699 — `state update` told the truth about failure.
//
// A frontmatter key like `stopped_at` is a PROJECTION of a body field, and the
// body is the source of truth. Asking to update the key used to return
// `Field "stopped_at" not found in STATE.md` — byte-identical to what a
// genuinely absent field returns, and pointing away from the route that works.
//
// Case D is the one real capability gap: frontmatter carries the key, the body
// has no source line, and neither route can write. `updateCore` now falls back
// to writing the frontmatter key directly there (and only there).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3699 state update — derived frontmatter keys explain themselves', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const FM = [
    '---',
    'gsd_state_version: 1.0',
    'current_phase: 1',
    'current_phase_name: alpha',
    'status: executing',
    'stopped_at: "original value"',
    '---',
    '',
  ];
  const BODY = ['# Project State', '', '## Current Position', '', 'Phase: 1 (alpha)', 'Status: Executing', ''];
  const SESSION = ['## Session Continuity', '', 'Stopped at: original value', ''];

  function writeState(lines, opts = {}) {
    const eol = opts.crlf ? '\r\n' : '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lines.join(eol));
  }
  function update(field, value) {
    const result = runGsdTools(['state', 'update', field, value], tmpDir);
    return { result, output: JSON.parse(result.output) };
  }
  function stateText() {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  }
  function frontmatterStoppedAt() {
    const m = stateText().match(/^stopped_at:.*$/m);
    return m ? m[0] : null;
  }

  // ── the headline defect: present-but-derived vs genuinely absent ───────────

  test('a body-derived frontmatter key is reported as derived, and names its body source', () => {
    writeState([...FM, ...BODY, ...SESSION]);

    const { output } = update('stopped_at', 'NEW VALUE');
    assert.strictEqual(output.updated, false);
    assert.match(output.reason, /not directly writable/i);
    assert.match(output.reason, /Stopped At/i, 'the reason must name the body source that DOES work');
    assert.doesNotMatch(output.reason, /not found in STATE\.md/i, 'the key is present — reporting absence is the bug');
    assert.match(frontmatterStoppedAt(), /original value/, 'a refused update must not write');
  });

  test('a genuinely absent field still reports absence', () => {
    // The control that keeps the fix honest: if EVERY failure now says
    // "derived", the defect has been inverted, not closed.
    writeState([...FM, ...BODY, ...SESSION]);

    const { output } = update('definitely_not_a_field', 'NEW VALUE');
    assert.strictEqual(output.updated, false);
    assert.strictEqual(output.reason, 'Field "definitely_not_a_field" not found in STATE.md');
  });

  test('a present-but-derived key and a genuinely absent field no longer produce the same message', () => {
    // #3699 stated as a test: the two were byte-identical apart from the name.
    writeState([...FM, ...BODY, ...SESSION]);
    const derived = update('stopped_at', 'NEW VALUE').output.reason;

    writeState([...FM, ...BODY, ...SESSION]);
    const absent = update('definitely_not_a_field', 'NEW VALUE').output.reason;

    assert.notStrictEqual(
      derived.replace(/"stopped_at"/g, 'X'),
      absent.replace(/"definitely_not_a_field"/g, 'X'),
      'the two failures must be distinguishable by more than the field name',
    );
  });

  test('the body source route still works and still syncs to frontmatter', () => {
    writeState([...FM, ...BODY, ...SESSION]);

    const { output } = update('Stopped at', 'NEW VALUE');
    assert.strictEqual(output.updated, true);
    assert.match(frontmatterStoppedAt(), /NEW VALUE/);
  });

  // ── case D: the capability gap ────────────────────────────────────────────

  test('case D: with no body source, the frontmatter key becomes directly writable', () => {
    // Frontmatter carries stopped_at; the body has no `Stopped at:` line and no
    // `## Session` section. Before this, BOTH routes failed and the stale value
    // survived — the document was unrepairable through `state update`.
    writeState([...FM, ...BODY]);

    const { output } = update('stopped_at', 'NEW VALUE');
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.wrote, 'frontmatter');
    assert.match(
      frontmatterStoppedAt(),
      /NEW VALUE/,
      'the value must survive syncStateFrontmatter + applyStatePreservation, not just be written by the transition',
    );
  });

  test('case D: the fallback is idempotent across repeated writes', () => {
    writeState([...FM, ...BODY]);

    update('stopped_at', 'FIRST');
    assert.match(frontmatterStoppedAt(), /FIRST/);
    const { output } = update('stopped_at', 'SECOND');
    assert.strictEqual(output.updated, true);
    assert.match(frontmatterStoppedAt(), /SECOND/);
  });

  test('case D: preserved does not claim a restore that authoritativeFm overrode', () => {
    // Preservation DOES restore stopped_at's snapshot here (its body source is
    // unchanged — absent), and authoritativeFm then overrides it. Listing the
    // field in `preserved` would report a restore that did not survive: the
    // same unfalsifiable-success shape this issue is about, one field over.
    writeState([...FM, ...BODY]);

    const { output } = update('stopped_at', 'NEW VALUE');
    const claimed = (output.preserved || []).map((p) => String(p).toLowerCase());
    assert.ok(
      !claimed.includes('stopped at') && !claimed.includes('stopped_at'),
      `preserved must not claim this field; got: ${JSON.stringify(output.preserved)}`,
    );
  });

  test('case D via the body field name names the frontmatter key that still holds a value', () => {
    writeState([...FM, ...BODY]);

    const { output } = update('Stopped at', 'NEW VALUE');
    assert.strictEqual(output.updated, false);
    assert.match(output.reason, /stopped_at/, 'the reason must name the frontmatter key carrying the value');
  });

  // ── negative space: where the fallback must NOT fire ──────────────────────

  test('the fallback does not fire when frontmatter does not carry the key', () => {
    // Nothing to repair — inventing a key here would be fabricating state.
    writeState([...FM.filter((l) => !l.startsWith('stopped_at:')), ...BODY]);

    const { output } = update('stopped_at', 'NEW VALUE');
    assert.strictEqual(output.updated, false);
    assert.strictEqual(frontmatterStoppedAt(), null, 'no frontmatter key may be invented');
  });

  test('a stale body-source line OUTSIDE ## Session is not treated as the source', () => {
    // Reversed from this change's first cut, on evidence. That cut suppressed the
    // repair whenever ANY body line existed, reasoning "prefer a line the user can
    // edit". But `buildStateFrontmatter` harvests Stopped At from `## Session`
    // ONLY, so an archive line is not a source — suppressing on it left the
    // document unrepairable AND pointed the user at a command that rewrote the
    // wrong line. Read scope, write scope and probe scope now all agree.
    writeState([
      ...FM, ...BODY,
      '## Session', '', 'Notes: none', '',
      '## Session Continuity Archive', '', 'Stopped At: 2025-01-01 (old session)', '',
    ]);

    const { output } = update('stopped_at', '2026-08-24');
    assert.strictEqual(output.updated, true, 'an archive line must not block the repair');
    assert.strictEqual(output.wrote, 'frontmatter');
    assert.match(
      stateText(),
      /Stopped At: 2025-01-01 \(old session\)/,
      'the archived line is a historical record and must be left alone',
    );
  });

  test('updating a session field never rewrites a line outside ## Session', () => {
    // The defect this guards: `stateReplaceField` matches the FIRST occurrence
    // anywhere in the body, so with no `Stopped At:` in `## Session` and a stale
    // one in the archive, the update reported success while silently rewriting
    // the archived record and leaving the real field untouched. #3374 established
    // the scoped writer for exactly this; `updateCore` had not adopted it.
    writeState([
      ...FM, ...BODY,
      '## Session', '', 'Notes: none', '',
      '## Session Continuity Archive', '', 'Stopped At: 2025-01-01 (old session)', '',
    ]);

    const { output } = update('Stopped At', '2026-08-24');
    assert.strictEqual(output.updated, false, 'there is no Stopped At line in ## Session to write');
    assert.match(
      stateText(),
      /Stopped At: 2025-01-01 \(old session\)/,
      'the archived line must be byte-identical after a refused update',
    );
    assert.doesNotMatch(stateText(), /Stopped At: 2026-08-24/, 'nothing may have been written anywhere');
  });

  test('a session field inside ## Session is still writable and still syncs', () => {
    // The complement: scoping must not break the normal route.
    writeState([...FM, ...BODY, '## Session', '', 'Stopped at: original value', '']);

    const { output } = update('Stopped at', 'NEW VALUE');
    assert.strictEqual(output.updated, true);
    assert.match(stateText(), /^Stopped at: NEW VALUE$/m, 'the session line is the one that moved');
    assert.match(frontmatterStoppedAt(), /NEW VALUE/, 'and it synced to frontmatter');
  });

  test('case D behaves identically on a CRLF document', () => {
    writeState([...FM, ...BODY], { crlf: true });

    const { output } = update('stopped_at', 'NEW VALUE');
    assert.strictEqual(output.updated, true);
    assert.match(frontmatterStoppedAt(), /NEW VALUE/);
  });

  // ── keys with no body source must not be given one ───────────────────────

  test('keys derived from the clock, ROADMAP.md, or a disk scan say so instead of naming a body field', () => {
    const cases = [
      ['last_updated', /recomputed on every write/i],
      ['state_head', /recomputed on every write/i],
      ['gsd_state_version', /recomputed on every write/i],
      ['milestone', /ROADMAP\.md/i],
      ['milestone_name', /ROADMAP\.md/i],
      ['progress.percent', /scan of \.planning\/phases/i],
      ['progress.total_plans', /scan of \.planning\/phases/i],
    ];
    for (const [field, expected] of cases) {
      writeState([...FM, ...BODY, ...SESSION]);
      const { output } = update(field, 'X');
      assert.strictEqual(output.updated, false, `${field} must not be writable`);
      assert.match(output.reason, expected, `${field}: wrong derivation named`);
      assert.doesNotMatch(output.reason, /Update its body source/i, `${field} has no body source to name`);
    }
  });

  // ── the map cannot silently drift from the builder ───────────────────────

  test('every FRONTMATTER_BODY_SOURCE entry actually round-trips from its body field', () => {
    // Real parity, per key. An earlier cut asserted only SET MEMBERSHIP against
    // the emitted frontmatter — near-vacuous, because buildStateFrontmatter emits
    // the whole schema key set regardless of body derivation, so a wrong mapping
    // would still pass.
    //
    // This drives each mapped key's own BODY LABEL to a distinct value and
    // asserts that value arrives in that frontmatter key. A mapping naming the
    // wrong body field cannot survive it.
    //
    // Two fixtures, because `paused_at` is not independent: normalizeStateStatus
    // forces `status: paused` whenever Paused At is set, so a single fixture
    // could not assert both `status` and `paused_at`.
    const expected = {
      current_phase: '7',
      current_phase_name: 'sentinel-name',
      current_plan: '3',
      status: 'executing', // normalized from the update below
      stopped_at: 'sentinel-stopped',
      last_activity: '2026-08-19',
      last_activity_desc: 'sentinel-desc',
    };

    writeState([
      '---', 'gsd_state_version: 1.0', '---', '',
      '# Project State', '',
      '## Current Position', '',
      'Current Phase: 7',
      'Current Phase Name: sentinel-name',
      'Current Plan: 3',
      'Status: Planning', // deliberately != the update below, or the #948 no-op guard skips the sync
      'Last Activity: 2026-08-19',
      'Last Activity Description: sentinel-desc',
      '',
      '## Session', '',
      'Stopped at: sentinel-stopped',
      '',
    ]);
    update('Status', 'Executing');

    let fm = stateText().split('---')[1];
    assert.match(fm, /^last_updated:/m, 'precondition: the update must have actually synced frontmatter');

    for (const [key, want] of Object.entries(expected)) {
      const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
      assert.ok(hit, `${key} was not emitted from its mapped body field — the mapping is wrong`);
      assert.match(
        hit[1],
        new RegExp(escapeRegex(want)),
        `${key} did not carry the value written to its mapped body field`,
      );
    }

    // paused_at, in its own fixture for the reason above.
    writeState([
      '---', 'gsd_state_version: 1.0', '---', '',
      '# Project State', '',
      '## Current Position', '',
      'Current Phase: 7',
      'Status: Planning',
      '',
      '## Session', '',
      'Paused At: sentinel-paused',
      '',
    ]);
    update('Status', 'Executing');

    fm = stateText().split('---')[1];
    const paused = /^paused_at:\s*(.+)$/m.exec(fm);
    assert.ok(paused, 'paused_at was not emitted from its mapped body field');
    assert.match(paused[1], /sentinel-paused/);

    // And the fixtures above must have covered the whole map — otherwise a key
    // added to FRONTMATTER_BODY_SOURCE could go untested here forever.
    const covered = new Set([...Object.keys(expected), 'paused_at']);
    for (const key of Object.keys(stateTransitionMod.FRONTMATTER_BODY_SOURCE)) {
      assert.ok(covered.has(key), `FRONTMATTER_BODY_SOURCE maps "${key}" but this round-trip test does not exercise it`);
    }
  });

  test('no body-derived frontmatter key escapes FRONTMATTER_BODY_SOURCE', () => {
    // The reverse direction. Every key buildStateFrontmatter emits must be either
    // mapped, or a declared non-body-derived key. A NEW body-derived key added to
    // the builder without a map entry fails here.
    //
    // Known limit, stated rather than hidden: someone could add a key to the
    // exclusion set below instead of the map. That is a smaller and far more
    // visible edit than silently forgetting the map, which is what this guards.
    const NOT_BODY_DERIVED = new Set([
      'gsd_state_version', // schema constant
      'last_updated', 'state_head', // recomputed every write
      'milestone', 'milestone_name', // ROADMAP.md
      'progress', // disk scan
    ]);

    writeState([
      '---', 'gsd_state_version: 1.0', '---', '',
      '# Project State', '',
      '## Current Position', '',
      'Current Phase: 2', 'Current Phase Name: beta', 'Current Plan: 1',
      'Status: Planning',
      'Last Activity: 2026-08-19 — did a thing',
      '',
      '## Session', '', 'Stopped at: somewhere', 'Paused At: elsewhere', '',
    ]);
    update('Status', 'Executing');

    const fm = stateText().split('---')[1];
    assert.match(fm, /^last_updated:/m, 'precondition: the write must have synced frontmatter');

    const emitted = fm.split('\n')
      .filter((l) => /^[a-z_]+:/.test(l))
      .map((l) => l.split(':')[0].trim());
    const mapped = new Set(Object.keys(stateTransitionMod.FRONTMATTER_BODY_SOURCE));

    for (const key of emitted) {
      assert.ok(
        mapped.has(key) || NOT_BODY_DERIVED.has(key),
        `buildStateFrontmatter emits "${key}", which is neither mapped in FRONTMATTER_BODY_SOURCE nor declared non-body-derived — `
        + 'if it is body-derived, `state update` cannot name its body source',
      );
    }
    // And the map may not carry a key the builder never emits.
    for (const key of mapped) {
      assert.ok(emitted.includes(key), `FRONTMATTER_BODY_SOURCE maps "${key}", which the builder did not emit — the map has drifted`);
    }
  });

  test('property: every body label round-trips back to its frontmatter key', () => {
    const entries = Object.entries(stateTransitionMod.FRONTMATTER_BODY_SOURCE);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: entries.length - 1 }), fc.boolean(), (i, upper) => {
        const [key, labels] = entries[i];
        for (const label of labels) {
          const probe = upper ? label.toUpperCase() : label.toLowerCase();
          assert.strictEqual(
            stateTransitionMod.frontmatterKeyForBodyField(probe),
            key,
            `"${probe}" must resolve back to "${key}"`,
          );
        }
      }),
      { numRuns: 25 },
    );
  });

  test('inherited prototype members are not treated as fields', () => {
    // Both lookups are own-property only; a prototype member must not produce a
    // bogus "is a derived key" reason.
    for (const probe of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      assert.strictEqual(stateTransitionMod.getFrontmatterBodySource(probe), null, `${probe} is not a frontmatter key`);
      assert.strictEqual(stateTransitionMod.frontmatterKeyForBodyField(probe), null, `${probe} is not a body field`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// #3871 / #3756 (ADR-3473 §8.6): a curated `progress:` frontmatter block is
// LOST on a write by verbs that have nothing to do with progress (state
// record-session, state add-decision) once the CURRENT milestone's phase
// dirs have been archived to `.planning/milestones/<version>-phases/` while
// STATE.md/ROADMAP.md still identify that milestone as the current one
// (ROADMAP heading "Current", Phase entries still listed in the ROADMAP
// text — only the on-disk phase directories moved). The milestone-scoped
// disk scan then finds none of the current milestone's phase directories
// under `.planning/phases/` and derives an empty/zero progress projection —
// verified empirically (see repro3756.js, run against the built lib): the
// persisted frontmatter's `progress` key is dropped ENTIRELY after the
// write (not merely zeroed-with-percent-omitted). Root cause is unchanged:
// `applyPostSyncPreservation` (src/state.cts) computes
// `const preFm = resync ? null : extractFrontmatter(...)` while
// `readModifyWriteStateMd` defaults `resync` to `true`, so the declared
// `preserve-always` policy row for `progress` never runs on this write path
// and has no chance to restore the curated block before it is discarded.
//
// Fixture pattern mirrors `tests/health-validation.test.cjs`'s
// `mkArchivePhases` (`.planning/milestones/<version>-phases/<NN>-phase-N/`)
// and `tests/completion-ratio-scope-withholding.test.cjs`'s ROADMAP-heading
// fixture builders — a "Current" milestone heading (so scope classifies as
// SCOPE.COMPLETE / windowed rather than UNSCOPED — a "Shipped" heading gets
// stripped by `stripShippedMilestones` and reproduces rule-4 withholding
// instead, a different and pre-existing intentional behavior, NOT this
// defect), phase dirs that exist ONLY under the archive path, and nothing
// at all under `.planning/phases/` for the current milestone.
// ═════════════════════════════════════════════════════════════════════════

describe('#3871 / #3756: curated progress must survive a write on an archived milestone', () => {
  // Builds an archived-milestone fixture: STATE.md asserts milestone v1.0
  // and carries the curated progress block (5/5/32/32/100%) plus the body
  // sections `record-session` and `add-decision` each need (Session
  // Continuity, Decisions). ROADMAP.md shows v1.0 as the CURRENT milestone
  // ("Current 🚧" heading, with all 5 Phase entries still listed in the
  // ROADMAP text) with 5 phases. The phase dirs themselves live ONLY under
  // `.planning/milestones/v1.0-phases/` — `.planning/phases/` has nothing
  // for the current milestone, exactly as it is right after `milestone
  // complete --archive-phases` runs while STATE.md has not yet been
  // advanced to a new milestone.
  function buildArchivedMilestoneFixture(cwd) {
    const planningDir = path.join(cwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '## v1.0 Current 🚧',
        '',
        '### Phase 1: Foo',
        '### Phase 2: Bar',
        '### Phase 3: Baz',
        '### Phase 4: Qux',
        '### Phase 5: Quux',
        '',
      ].join('\n'),
    );

    // 5 archived phases totalling 32 plans, every plan paired with a
    // SUMMARY (all complete) — mirrors mkArchivePhases in
    // tests/health-validation.test.cjs, but with real PLAN/SUMMARY files
    // rather than empty dirs, since this fixture is about the DISK SCAN
    // finding zero CURRENT-milestone phases, not about archive discovery.
    const archiveDir = path.join(planningDir, 'milestones', 'v1.0-phases');
    const plansPerPhase = [7, 7, 6, 6, 6]; // sums to 32
    plansPerPhase.forEach((count, i) => {
      const phaseNum = String(i + 1).padStart(2, '0');
      const phaseDir = path.join(archiveDir, `${phaseNum}-phase-${i + 1}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let p = 1; p <= count; p += 1) {
        const planNum = String(p).padStart(2, '0');
        fs.writeFileSync(path.join(phaseDir, `${phaseNum}-${planNum}-PLAN.md`), '# Plan\n');
        fs.writeFileSync(path.join(phaseDir, `${phaseNum}-${planNum}-SUMMARY.md`), '# Summary\n');
      }
    });

    // Deliberately NO .planning/phases/ directory at all for the current
    // milestone — the archived-milestone shape this issue is about.

    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        'progress:',
        '  total_phases: 5',
        '  completed_phases: 5',
        '  total_plans: 32',
        '  completed_plans: 32',
        '  percent: 100',
        '---',
        '',
        '# Project State',
        '',
        '## Session Continuity',
        '',
        '**Last session:** 2024-01-10',
        '**Stopped at:** Phase 5, Plan 32',
        '**Resume file:** None',
        '',
        '## Decisions',
        'No decisions yet.',
        '',
        '## Blockers',
        'None',
        '',
      ].join('\n'),
    );
  }

  function assertCuratedProgressSurvived(cwd) {
    const statePath = path.join(cwd, '.planning', 'STATE.md');
    const content = fs.readFileSync(statePath, 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(content);
    assert.ok(fm && fm.progress, 'STATE.md frontmatter must still carry a progress block');
    assert.strictEqual(Number(fm.progress.total_phases), 5, 'total_phases must remain the curated 5, not zeroed by the archived-milestone disk scan');
    assert.strictEqual(Number(fm.progress.completed_phases), 5, 'completed_phases must remain the curated 5');
    assert.strictEqual(Number(fm.progress.total_plans), 32, 'total_plans must remain the curated 32');
    assert.strictEqual(Number(fm.progress.completed_plans), 32, 'completed_plans must remain the curated 32');
    assert.strictEqual(Number(fm.progress.percent), 100, 'percent must remain the curated 100, not go missing');
  }

  // THIS TEST MUST FAIL TODAY (#3756): `state record-session` resyncs
  // (readModifyWriteStateMd defaults resync:true), which forces `preFm` to
  // null in applyPostSyncPreservation, which starves the preserve-always
  // executor for `progress` of the one input (`ctx.preFm`) it actually
  // reads — so the curated block is never restored and the persisted
  // frontmatter's `progress` key is dropped entirely (verified via
  // repro3756.js against the built lib, not merely inferred).
  test('recordSessionOnArchivedMilestoneDoesNotZeroProgress', (t) => {
    const cwd = createTempDir('gsd-3871-record-session-');
    t.after(() => cleanup(cwd));
    buildArchivedMilestoneFixture(cwd);

    const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Phase 5 complete'], cwd);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assertCuratedProgressSurvived(cwd);
  });

  // Same fixture, same failure mode, via `state add-decision` instead —
  // pins that the defect is in the shared write seam (readModifyWriteStateMd
  // / applyPostSyncPreservation), not something specific to record-session.
  // THIS TEST MUST FAIL TODAY (#3756) for the same reason as above.
  test('addDecisionOnArchivedMilestoneDoesNotZeroProgress', (t) => {
    const cwd = createTempDir('gsd-3871-add-decision-');
    t.after(() => cleanup(cwd));
    buildArchivedMilestoneFixture(cwd);

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '05-01', '--summary', 'Ship v1.0', '--rationale', 'milestone complete'],
      cwd,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    assertCuratedProgressSurvived(cwd);
  });

  // The over-preservation guard: a genuinely empty project (no phases
  // anywhere, no curated progress block at all) must still report zeros
  // after the same verb — the fix for #3756 must not make
  // applyStatePreservation invent a nonzero progress block out of nothing.
  // This test MUST PASS both today and after the fix.
  test('newProjectWithNoPhasesKeepsZeroProgress', (t) => {
    const cwd = createTempProject('gsd-3871-empty-');
    t.after(() => cleanup(cwd));

    fs.writeFileSync(
      path.join(cwd, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '## Session Continuity',
        '',
        '**Last session:** 2024-01-10',
        '**Stopped at:** None',
        '**Resume file:** None',
        '',
      ].join('\n'),
    );

    const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Nothing started yet'], cwd);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const statePath = path.join(cwd, '.planning', 'STATE.md');
    const written = fs.readFileSync(statePath, 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(written);
    const progress = fm && fm.progress;

    // No curated progress ever existed, so exactly one deterministic outcome
    // is acceptable — the block is entirely absent, or every count in it is
    // a genuine, well-formed 0. Some assertion MUST run either way (no `if`
    // guard around the assertion itself); which branch it took is stated in
    // the failure message so a silent pass-through cannot hide which case
    // fired. `Number.isFinite` (not `Number(x) || 0`) so a garbage/NaN value
    // is caught rather than laundered into a false 0.
    if (!progress) {
      assert.strictEqual(progress, undefined, 'case: no progress block at all — this is the accepted degraded outcome for a project with no curated progress');
    } else {
      const counters = {
        total_phases: Number(progress.total_phases),
        completed_phases: Number(progress.completed_phases),
        total_plans: Number(progress.total_plans),
        completed_plans: Number(progress.completed_plans),
      };
      for (const [key, value] of Object.entries(counters)) {
        assert.ok(Number.isFinite(value), `case: progress block present — ${key} must coerce to a finite number, got ${JSON.stringify(progress[key])}`);
        assert.strictEqual(value, 0, `case: progress block present — ${key} must be exactly 0 on an empty project, not inflated`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// #4129: progress.completed_phases is recomputed to a WRONG value on every
// resyncing state write, and hand-fixes never survive (.gsd/bug/
// fix-4129-completed-phases-recompute/{10-diagnosis,50-test-matrix}.md).
//
// The repro shape (issue rows 1/4): a completed phase whose SUMMARY was
// touched after its verification passed — a later reformat/re-run commit, or
// any dirty working-tree edit — permanently stale-dates that phase's
// verification under the #2348 clean-commit-time clock. isPhaseComplete
// (#2957 disk-strict, correctly) refuses to count it, so
// buildStateFrontmatter's disk numerator UNDER-counts vs the ROADMAP
// Complete rows that `phase complete` itself maintains, and the resync arm
// of applyPreserveAlways wholesale-replaces the stored block with the
// under-count on every default-resync write (record-session / add-decision /
// begin-phase / ...), clobbering any hand-corrected value.
//
// The fixture below is git-free: outside a repo the #2348 clock falls back
// to filesystem mtimes, so a newer-mtime SUMMARY reproduces the exact stale
// routing the real git clock produces (verified against the same
// `verification status` CLI the reporter used).
// ═════════════════════════════════════════════════════════════════════════

describe('#4129: completed_phases derives from the ROADMAP authority and survives resyncing writes', () => {
  /**
   * The #4129 STALE shape: milestone v1.0, 18 phases, phases 1-3 Complete in
   * the ROADMAP (canonical 4-column Progress table + checklist), each with
   * plans/summaries and a passing verification; phase 1's SUMMARY carries a
   * NEWER mtime than its verification → `verification status` routes `stale`
   * → disk numerator 2, ROADMAP truth 3. STATE.md starts at the truth (3).
   * `includeStoredProgress: false` writes STATE.md with NO stored progress
   * block, so the reported counters are exactly what the derivation computes
   * (the read-path ratchet has no stored block to lean on).
   */
  function buildStaleVerificationFixture(cwd, initialCompleted = 3, includeStoredProgress = true) {
    const planningDir = path.join(cwd, '.planning');
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ project_code: 'REPRO' }));

    const roadmapLines = [
      '# Roadmap',
      '',
      '## Current Milestone: v1.0',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 1.    | 2/2            | Complete | 2026-01-01 |',
      '| 2.    | 2/2            | Complete | 2026-01-02 |',
      '| 3.    | 2/2            | Complete | 2026-01-03 |',
    ];
    for (let i = 4; i <= 18; i += 1) roadmapLines.push(`| ${i}.    | 0/2            | Not Started |  |`);
    roadmapLines.push('', '- [x] Phase 1: Alpha (completed 2026-01-01)', '- [x] Phase 2: Beta (completed 2026-01-02)', '- [x] Phase 3: Gamma (completed 2026-01-03)');
    for (let i = 4; i <= 18; i += 1) roadmapLines.push(`- [ ] Phase ${i}: P${i}`);
    for (let i = 1; i <= 18; i += 1) {
      roadmapLines.push('', `### Phase ${i}: P${i}`, '', '**Goal:** goal', '**Plans:** 2 plans', '');
    }
    fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmapLines.join('\n'));

    const stateLines = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Programme',
      'status: executing',
      'current_phase: 4',
      'last_updated: 2026-01-03T10:00:00.000Z',
    ];
    if (includeStoredProgress) {
      stateLines.push(
        'progress:',
        '  total_phases: 18',
        `  completed_phases: ${initialCompleted}`,
        '  total_plans: 6',
        '  completed_plans: 6',
        '  percent: 17',
      );
    }
    stateLines.push(
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 4 of 18 (P4) — EXECUTING',
      'Plan: 1 of 2',
      'Status: Executing Phase 4',
      'Last activity: 2026-01-03',
      '',
      '## Progress',
      '',
      `Progress: [██░░░░░░░░] 17% (${initialCompleted}/18 phases complete)`,
      '',
      '## Session',
      '',
      'Last session: 2026-01-03T10:00:00.000Z',
      'Stopped at: Finished phase 3',
      'Resume file: None',
      '',
    );
    fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateLines.join('\n'));

    for (const p of [1, 2, 3]) {
      const pp = String(p).padStart(2, '0');
      const dir = path.join(phasesDir, `${pp}-p${p}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const i of [1, 2]) {
        fs.writeFileSync(path.join(dir, `${pp}-0${i}-PLAN.md`), '# Plan\n');
        fs.writeFileSync(path.join(dir, `${pp}-0${i}-SUMMARY.md`), '# Summary\n');
      }
      writePassedVerification(cwd, `${pp}-p${p}`, pp);
    }

    // The drift: phase 1's summary edited AFTER the verification was written.
    // No git repo → the #2348 clock compares mtimes; the newer summary mtime
    // routes the phase-1 verification `stale` exactly as a later commit would.
    const verificationPath = path.join(phasesDir, '01-p1', '01-VERIFICATION.md');
    const driftedSummary = path.join(phasesDir, '01-p1', '01-01-SUMMARY.md');
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-03-01T00:00:00Z');
    fs.utimesSync(verificationPath, older, older);
    fs.utimesSync(driftedSummary, newer, newer);

    return { planningDir, phasesDir };
  }

  function readProgress(cwd) {
    const content = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(content);
    assert.ok(fm && fm.progress, 'STATE.md frontmatter must carry a progress block');
    return { progress: fm.progress, content };
  }

  // Row 1 of the 50-test-matrix — the failing-first regression. On current
  // `next` each of these verbs clobbers the stored 3 down to the
  // stale-verification disk count 2 (percent 17 → 11), which is the issue's
  // "any hand-correction is silently reverted by the next one".
  test('handFixedCompletedPhasesSurvivesEveryResyncingWrite', (t) => {
    const cwd = createTempDir('gsd-4129-handfix-');
    t.after(() => cleanup(cwd));
    buildStaleVerificationFixture(cwd, 3);

    // Precondition — the drift is really in place: phase 1 routes stale, so
    // the disk numerator is 2 while ROADMAP + stored say 3.
    const staleCheck = runGsdTools(['verification', 'status', path.join('.planning', 'phases', '01-p1')], cwd);
    assert.ok(staleCheck.success, `verification status failed: ${staleCheck.error}`);
    assert.strictEqual(JSON.parse(staleCheck.output).status, 'stale', 'fixture precondition: phase 1 verification must route stale (newer summary)');

    for (const [label, args] of [
      ['state record-session', ['state', 'record-session', '--stopped-at', 'Finished phase 3 verification']],
      ['state add-decision', ['state', 'add-decision', '--summary', 'Ship it']],
      ['state begin-phase', ['state', 'begin-phase', '--phase', '4', '--name', 'P4']],
    ]) {
      const result = runGsdTools(args, cwd);
      assert.ok(result.success, `${label} failed: ${result.error}`);
      const { progress, content } = readProgress(cwd);
      assert.strictEqual(
        Number(progress.completed_phases),
        3,
        `#4129: ${label} must not clobber the ROADMAP-correct completed_phases 3 down to the stale-verification disk count (${progress.completed_phases})`,
      );
      assert.strictEqual(Number(progress.percent), 17, `#4129: ${label} — percent follows the surviving counters (3/18), not the discarded disk count`);
      assert.strictEqual(bodyProgressPercent(content), 17, `#4129: ${label} — the body Progress bar must stay coherent with the persisted percent`);
    }
  });

  // Row 2 — the DERIVED block itself must carry the ROADMAP-floored numerator.
  // state json applies the read-path ratchet (shouldPreserveExistingProgress),
  // which would mask a still-wrong derivation whenever a stored block exists —
  // so this asserts on a STATE.md whose stored block is ABSENT: what json
  // reports is then exactly what buildStateFrontmatter derived.
  test('stateJsonDerivesCompletedPhasesFromRoadmapAuthority', (t) => {
    const cwd = createTempDir('gsd-4129-jsonfloor-');
    t.after(() => cleanup(cwd));
    buildStaleVerificationFixture(cwd, 3, false);

    const result = runGsdTools(['state', 'json'], cwd);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const reported = JSON.parse(result.output).progress;
    assert.strictEqual(
      Number(reported.completed_phases),
      3,
      `#4129: the derived completed_phases must agree with the ROADMAP Complete rows (3), not the stale-verification disk count (${reported.completed_phases})`,
    );
    assert.strictEqual(Number(reported.percent), 17, '#4129: percent derives from the floored numerator');
  });

  // Row 3 — the flip side: a counter STUCK LOW (the issue's row-1 aftermath)
  // must move UP to the ROADMAP truth on the next write, not stay pinned.
  test('stuckLowCounterIncrementsToRoadmapTruthOnNextWrite', (t) => {
    const cwd = createTempDir('gsd-4129-stucklow-');
    t.after(() => cleanup(cwd));
    buildStaleVerificationFixture(cwd, 2);

    const result = runGsdTools(['state', 'record-session', '--stopped-at', 'x'], cwd);
    assert.ok(result.success, `record-session failed: ${result.error}`);
    const { progress } = readProgress(cwd);
    assert.strictEqual(Number(progress.completed_phases), 3, '#4129: a stored 2 below the ROADMAP truth must rise to 3, not be re-derived as 2');
    assert.strictEqual(Number(progress.percent), 17, '#4129: percent follows the corrected numerator');
  });

  // Row 5 — negative space: no canonical Progress table (checklist-only
  // ROADMAP) → deriveProgressFromRoadmap resolves no table → the floor is
  // inert and the disk-verification count stands. The floor must not invent
  // a parser for checklist bullets (one-owner rule).
  test('floorIsInertWithoutCanonicalProgressTable', (t) => {
    const cwd = createTempDir('gsd-4129-notable-');
    t.after(() => cleanup(cwd));
    buildStaleVerificationFixture(cwd, 2, false);

    // Rewrite the ROADMAP with the table stripped — checklist only.
    // CRLF-tolerant line split (local/no-crlf-fragile-split).
    const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
    const withoutTable = fs
      .readFileSync(roadmapPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('|'))
      .join('\n');
    fs.writeFileSync(roadmapPath, withoutTable);

    const result = runGsdTools(['state', 'json'], cwd);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const reported = JSON.parse(result.output).progress;
    assert.strictEqual(
      Number(reported.completed_phases),
      2,
      '#4129 negative space: without a canonical Progress table the completed count stays the disk-verification count (the floor reuses deriveProgressFromRoadmap, which reads only the table)',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// #3872 / ADR-3473 §8.7: what a command reports it wrote
// (.gsd/phase/feat-3872-transaction-diff-reporting/{40-design,50-test-matrix}.md)
//
// `reconcileReportedFields` (src/state.cts:3726-3794) decides what a
// `state.*` command reports in its `updated` array. Rows below pin the
// currently-red rows (5, 4, 27) and the two guard rows that must stay green
// through any fix (12, 13).
// ═════════════════════════════════════════════════════════════════════════

describe('#3872 / ADR-3473 §8.7: what a command reports it wrote', () => {
  function buildPlannedPhaseFixture(cwd, { totalPlans, completedPlans, percent, planFiles }) {
    const planningDir = path.join(cwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      ['## v1.0 Current', '', '### Phase 1: Foo', ''].join('\n'),
    );
    const phaseDir = path.join(planningDir, 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let p = 1; p <= planFiles.total; p += 1) {
      const n = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${n}-PLAN.md`), '# Plan\n');
      if (p <= planFiles.completed) {
        fs.writeFileSync(path.join(phaseDir, `01-${n}-SUMMARY.md`), '# Summary\n');
      }
    }
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        'progress:',
        `  total_phases: 1`,
        `  completed_phases: 0`,
        `  total_plans: ${totalPlans}`,
        `  completed_plans: ${completedPlans}`,
        `  percent: ${percent}`,
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Status: Executing',
        'Phase: 1',
        '',
        '## Session Continuity',
        '',
        '**Last session:** 2024-01-10',
        '**Stopped at:** None',
        '**Resume file:** None',
        '',
      ].join('\n'),
    );
  }

  describe('row 5 (PROVEN RED, CLI): dotted leaf `progress.total_plans` is silently dropped from `updated`', () => {
    test('reportsDottedLeafWhenPlanCountChanges', (t) => {
      const cwd = createTempDir('gsd-3872-row5-');
      t.after(() => cleanup(cwd));
      // 5 real PLAN.md files on disk so the disk-scan-derived progress this
      // write's own ratchet-merge reads from (buildStateFrontmatter) actually
      // measures 5 plans — the curated block starts at 0.
      buildPlannedPhaseFixture(cwd, { totalPlans: 0, completedPlans: 0, percent: 0, planFiles: { total: 5, completed: 0 } });

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      const before = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(Number(before.progress.total_plans), 0, 'setup: curated total_plans starts at 0');

      const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Foo', '--plans', '5'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      const after = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      // The persisted value really moved — this can never pass vacuously by
      // the value not changing on disk.
      assert.strictEqual(Number(after.progress.total_plans), 5, 'progress.total_plans must actually change 0 -> 5 on disk for this test to mean anything');

      // TODAY: `updated` is `["Status"]` — `progress.total_plans` is absent
      // because `reconcileReportedFields`'s `valueOf` cannot resolve a dotted
      // key against the nested `fm.progress.total_plans` (src/state.cts:3758-3762).
      assert.ok(
        output.updated.includes('progress.total_plans'),
        `updated must contain "progress.total_plans" (the dotted leaf plannedPhaseCore itself pushed to its own success list — src/state-transition.cts:1752); ` +
        `got ${JSON.stringify(output.updated)}`,
      );
    });
  });

  describe('row 27 (regression, same run as row 5): `Current Position` changed on disk but is absent from `updated`', () => {
    test('reportsCurrentPositionWhenItActuallyMoved', (t) => {
      const cwd = createTempDir('gsd-3872-row27-');
      t.after(() => cleanup(cwd));
      buildPlannedPhaseFixture(cwd, { totalPlans: 0, completedPlans: 0, percent: 0, planFiles: { total: 5, completed: 0 } });

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      const before = fs.readFileSync(statePath, 'utf-8');
      assert.ok(before.includes('Phase: 1\n'), 'setup: Current Position starts with the bare pre-plan Phase line');

      const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Foo', '--plans', '5'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      const after = fs.readFileSync(statePath, 'utf-8');
      // The Current Position section really moved on disk (src/state-transition.cts:1741
      // pushes 'Current Position' into plannedPhaseCore's own `updated` precisely
      // when `body !== beforePos`; the persisted Phase line proves the byte-level
      // change independent of that push).
      assert.ok(
        after.includes('Phase: 1 (Foo) — READY TO EXECUTE'),
        'Current Position must actually change on disk for this test to mean anything',
      );

      // TODAY: `updated` is `["Status"]` — `Current Position` is absent even
      // though the section changed.
      assert.ok(
        output.updated.includes('Current Position'),
        `updated must contain "Current Position"; got ${JSON.stringify(output.updated)}`,
      );
    });
  });

  describe('row 4 (regression #3743/#3818): `progress` genuinely changed by this write is suppressed by the classification filter', () => {
    test('reportsProgressWhenItGenuinelyChanged', (t) => {
      const cwd = createTempDir('gsd-3872-row4-');
      t.after(() => cleanup(cwd));
      // 3 plans on disk, all complete — curated block under-reports
      // completed_plans (2 of 3) and a stale 66% (isolates this from row 5's
      // dotted-key bug: --plans is omitted, so plannedPhaseCore never pushes
      // 'progress.total_plans' to its own reported list at all).
      buildPlannedPhaseFixture(cwd, { totalPlans: 3, completedPlans: 2, percent: 66, planFiles: { total: 3, completed: 3 } });

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      const before = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(Number(before.progress.percent), 66, 'setup: curated percent starts at 66');

      const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Foo'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.plan_count, null, 'setup: no --plans was passed, so the dotted-leaf mechanism (row 5) never engages');

      const after = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.notStrictEqual(
        Number(after.progress.percent), 66,
        'progress.percent must actually change on disk (via the ratchet-merge in applyPreserveAlways) for this test to mean anything',
      );

      // TODAY: `updated` is `["Status"]` — `progress` (or a leaf naming the
      // changed value) is absent, filtered by reconcileReportedFields's
      // divergedFields loop (src/state.cts:3787-3792), which only folds in a
      // divergedFields entry when its classification is
      // 'preserve-when-unchanged' — `progress` is classified 'preserve-always'
      // (src/state-transition.cts:135) and so is unconditionally excluded
      // regardless of whether it merely preserved an unchanged value (#1264,
      // correct) or genuinely changed (#3743/#3818, this row).
      assert.ok(
        output.updated.some((f) => f === 'progress' || f.startsWith('progress.')),
        `updated must contain a field naming the changed progress leaf; got ${JSON.stringify(output.updated)}`,
      );
    });
  });

  describe('row 8 (#3818, CLI-proven): `current_phase` advanced by the write is unreported — not restored, so never in `divergedFields`', () => {
    // #3818's own report: a real `state planned-phase` run reported
    // `updated: ["progress.total_plans"]` while `current_phase` moved 203 -> 204
    // on disk, unreported. `plannedPhaseCore` unconditionally rewrites the
    // `## Current Position` `Phase:` line (system-derived, not template-gated),
    // so `applyPostSyncPreservation`'s #1230 body-source delta for `current_phase`
    // (src/state.cts:3369-3370, 3396-3397) sees pre != post THIS write and lets
    // the freshly re-derived value win — `applyPreserveWhenUnchanged` only ever
    // restores when the delta says unchanged, so a genuinely-advanced
    // `current_phase` is never a restoration and never enters `divergedFields`
    // (src/state.cts:3466-3473 diffs postFm before/after `applyStatePreservation`
    // ran — a field the sync alone changed, that preservation never touched,
    // produces no diff there). `plannedPhaseCore` also never pushes
    // `current_phase` (or a `Current Phase` label) onto its own `updated` list
    // (src/state-transition.cts:1655-1754) — it names `Status`, `Total Plans in
    // Phase`, `Last Activity`, `Last Activity Description`, `Current Position`,
    // `progress.total_plans`. So the field is in NEITHER candidate set.
    test('reportsCurrentPhaseWhenTheWriteAdvancedIt', (t) => {
      const cwd = createTempDir('gsd-3872-row8-');
      t.after(() => cleanup(cwd));
      const planningDir = path.join(cwd, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'ROADMAP.md'),
        ['## v1.0 Current', '', '### Phase 3: Foo', '### Phase 4: Bar', ''].join('\n'),
      );
      fs.mkdirSync(path.join(planningDir, 'phases', '03-foo'), { recursive: true });
      const phase4Dir = path.join(planningDir, 'phases', '04-bar');
      fs.mkdirSync(phase4Dir, { recursive: true });
      for (let p = 1; p <= 2; p += 1) {
        fs.writeFileSync(path.join(phase4Dir, `04-${String(p).padStart(2, '0')}-PLAN.md`), '# Plan\n');
      }
      const statePath = path.join(planningDir, 'STATE.md');
      fs.writeFileSync(
        statePath,
        [
          '---',
          'gsd_state_version: 1.0',
          'milestone: v1.0',
          'status: executing',
          'current_phase: "3"',
          'progress:',
          '  total_phases: 2',
          '  completed_phases: 0',
          '  total_plans: 0',
          '  completed_plans: 0',
          '  percent: 0',
          '---',
          '',
          '# Project State',
          '',
          '## Current Position',
          '',
          'Status: Executing',
          'Phase: 3 (Foo) — EXECUTING',
          '',
          '## Session Continuity',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '**Resume file:** None',
          '',
        ].join('\n'),
      );

      const before = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(String(before.current_phase), '3', 'setup: current_phase starts at 3');

      // Verified at the CLI (built lib):
      //   BEFORE current_phase: 3
      //   CLI output: {"updated":["Status"],"phase":"4","plan_count":2}
      //   AFTER  current_phase: 4
      const result = runGsdTools(['state', 'planned-phase', '--phase', '4', '--name', 'Bar', '--plans', '2'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      const after = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(
        String(after.current_phase), '4',
        'current_phase must actually advance 3 -> 4 on disk for this test to mean anything',
      );

      assert.ok(
        output.updated.includes('current_phase') || output.updated.includes('Current Phase'),
        `updated must name current_phase's advance; got ${JSON.stringify(output.updated)}`,
      );
    });
  });

  describe('row 13 (verdict guard, must PASS today and after): a fully-failed `state.patch` reports an empty `updated`', () => {
    test('aFullyFailedPatchStillReportsFailure', (t) => {
      const cwd = createTempProject('gsd-3872-row13-');
      t.after(() => cleanup(cwd));
      fs.writeFileSync(
        path.join(cwd, '.planning', 'STATE.md'),
        [
          '---',
          'gsd_state_version: 1.0',
          'status: planning',
          '---',
          '',
          '# Project State',
          '',
          '## Session Continuity',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '**Resume file:** None',
          '',
        ].join('\n'),
      );

      // "Totally Fake Field" passes security.cts's validateFieldName format
      // check but matches no body label and no frontmatter key, so
      // patchCore (src/state-transition.cts) routes it straight to `failed`
      // (never `updated`) — the every-field-fails case src/state.cts:607's
      // `updated.length > 0` success boolean guards against.
      const result = runGsdTools(['query', 'state.patch', JSON.stringify({ 'Totally Fake Field': 'x' })], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      assert.deepStrictEqual(output.updated, [], 'updated must be empty when every requested field failed');
      assert.ok(output.failed.includes('Totally Fake Field'), 'the failed field must be named in failed');
    });
  });

  describe('row 12 (independence guard, must PASS today and after): two content-identical writes differ only in `last_updated`', () => {
    // Corrected by this row's own CLI result: `state_head` is NOT ambient.
    // It is recomputed on every write, but its VALUE changes only when git
    // HEAD actually moved between the two writes — verified below at the CLI
    // (same git-backed fixture, HEAD held fixed): `state_head` was IDENTICAL
    // across both writes, so the provenance-exclusion set shrinks to the
    // single element `last_updated`. The companion test right after this one
    // pins the other half: `state_head` DOES change once HEAD moves.
    test('identicalWritesDifferOnlyInLastUpdated', (t) => {
      const { createTempGitProject: mkGit } = require('./helpers.cjs');
      const cwd = mkGit('gsd-3872-row12-');
      t.after(() => cleanup(cwd));

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      fs.writeFileSync(
        statePath,
        [
          '---',
          'gsd_state_version: 1.0',
          'status: planning',
          '---',
          '',
          '# Project State',
          '',
          '## Session Continuity',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '**Resume file:** None',
          '',
        ].join('\n'),
      );

      // Two content-identical `record-session` calls against the SAME
      // git-backed fixture, with HEAD held fixed between them — `state_head`
      // is only ever set in a git-backed tree (row 11's null-guard), so a
      // non-git fixture cannot exercise it.
      //
      // Verified at the CLI (built lib), HEAD never moved between the calls:
      //   r1 state_head: 672631f4bf5c7547b86239e83fce37b2473e83af
      //   r2 state_head: 672631f4bf5c7547b86239e83fce37b2473e83af  (identical)
      const result1 = runGsdTools(['state', 'record-session', '--stopped-at', 'Same stop text'], cwd);
      assert.ok(result1.success, `first write failed: ${result1.error}`);
      const fm1 = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));

      const result2 = runGsdTools(['state', 'record-session', '--stopped-at', 'Same stop text'], cwd);
      assert.ok(result2.success, `second write failed: ${result2.error}`);
      const fm2 = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));

      assert.strictEqual(
        fm1.state_head, fm2.state_head,
        'state_head must be identical across two writes with no intervening commit (it tracks a real fact, not an ambient stamp)',
      );

      const AMBIENT = new Set(['last_updated']);
      const keys = new Set([...Object.keys(fm1), ...Object.keys(fm2)]);
      const nonAmbientDiffs = [];
      for (const key of keys) {
        if (AMBIENT.has(key)) continue;
        if (JSON.stringify(fm1[key]) !== JSON.stringify(fm2[key])) nonAmbientDiffs.push(key);
      }
      assert.deepStrictEqual(
        nonAmbientDiffs, [],
        `two content-identical writes must differ only in last_updated; ` +
        `also differed in ${JSON.stringify(nonAmbientDiffs)} — fm1=${JSON.stringify(fm1)} fm2=${JSON.stringify(fm2)}`,
      );
    });
  });

  describe('row 12 companion (must PASS today and after): `state_head` changes when HEAD actually moves between writes', () => {
    // The other half of the row-12 correction: `state_head` is excluded from
    // provenance not because it is ambient, but because it is a faithful,
    // reportable projection of a real fact (git HEAD). This pins that it is
    // NOT a constant that a future reader could mistake for ambient.
    test('stateHeadChangesWhenHeadMoves', (t) => {
      const { createTempGitProject: mkGit } = require('./helpers.cjs');
      const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
      const cwd = mkGit('gsd-3872-row12-companion-');
      t.after(() => cleanup(cwd));

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      fs.writeFileSync(
        statePath,
        [
          '---',
          'gsd_state_version: 1.0',
          'status: planning',
          '---',
          '',
          '# Project State',
          '',
          '## Session Continuity',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '**Resume file:** None',
          '',
        ].join('\n'),
      );

      const result1 = runGsdTools(['state', 'record-session', '--stopped-at', 'First stop'], cwd);
      assert.ok(result1.success, `first write failed: ${result1.error}`);
      const fm1 = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));

      // Advance HEAD between the two writes.
      const gitOpts = { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS };
      fs.writeFileSync(path.join(cwd, 'NOTE.txt'), 'advance head\n');
      gitOrThrow(['add', '-A'], gitOpts);
      gitOrThrow(['commit', '-m', 'advance head'], gitOpts);
      // Bounded via `gitOrThrow` (tests/helpers/git-fixture.cjs), not a raw
      // `execFileSync` — every other git call in this fixture already goes
      // through the timeout-bounded seam; an unbounded spawn here is the
      // one call `local/no-unbounded-spawn` correctly flagged.
      const newHead = gitOrThrow(['rev-parse', 'HEAD'], gitOpts).trim();

      // Verified at the CLI (built lib):
      //   r1 state_head: 672631f4bf5c7547b86239e83fce37b2473e83af
      //   newHead:       ed5927d76a691323ef61d0a19573bb9f75dcd852
      //   r2 state_head: ed5927d76a691323ef61d0a19573bb9f75dcd852  (== newHead)
      const result2 = runGsdTools(['state', 'record-session', '--stopped-at', 'Second stop'], cwd);
      assert.ok(result2.success, `second write failed: ${result2.error}`);
      const fm2 = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));

      assert.notStrictEqual(fm1.state_head, fm2.state_head, 'state_head must change once HEAD actually moved');
      assert.strictEqual(fm2.state_head, newHead, 'state_head must track the real, current HEAD sha');
    });
  });

  // Generalized provenance rule (coordinator directive, folded into this
  // phase alongside rows 4/5/27 above): a DECLARED derived leaf
  // (`declaredLeavesOf`, e.g. every `progress.*` row — `source: 'disk'`,
  // state-transition.cts:136-140) materializing from ABSENT in the pre-write
  // snapshot to PRESENT in persisted is the disk scan catching a
  // never-synced document up, not the caller's action — the same
  // provenance principle `STATE_UPDATED_PROVENANCE_EXCLUSION` already
  // applies to `last_updated` one field up, generalized rather than turned
  // into a second `progress`-specific classification exclusion (that would
  // be exactly what §8.7 bans). A leaf already PRESENT in the snapshot gets
  // no such pass — a genuine move is still reported (the sibling test
  // below, and rows 4/5 above).
  describe('generalized provenance rule: a derived leaf materializing from nothing is not a change, but one that genuinely moves still is', () => {
    test('derivedLeafMaterializationIsNotAChange', (t) => {
      const cwd = createTempDir('gsd-3872-materialize-');
      t.after(() => cleanup(cwd));
      const planningDir = path.join(cwd, '.planning');
      // Empty phases/ dir (present, zero subdirectories) + a STATE.md with NO
      // `progress:` frontmatter block at all — the exact shape every one of
      // the 11 failing fixtures reproduced.
      fs.mkdirSync(path.join(planningDir, 'phases'), { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'STATE.md'),
        [
          '---',
          'gsd_state_version: 1.0',
          'status: executing',
          '---',
          '',
          '# Project State',
          '',
          '## Session',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '',
        ].join('\n'),
      );
      const statePath = path.join(planningDir, 'STATE.md');
      const before = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(before.progress, undefined, 'setup: no progress block before this write');

      const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Now stopped'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      // The block really did land on disk — this can never pass vacuously by
      // nothing being written; buildStateFrontmatter's disk scan of the empty
      // phases/ dir materializes a real (zero-valued) progress block.
      const after = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.ok(after.progress && typeof after.progress === 'object', 'progress must actually materialize on disk for this test to mean anything');

      assert.ok(
        !output.updated.some((f) => f === 'progress' || f.startsWith('progress.')),
        `materialization from an absent snapshot must not be reported; got ${JSON.stringify(output.updated)}`,
      );
    });

    test('changedDerivedLeafIsStillAChange', (t) => {
      const cwd = createTempDir('gsd-3872-genuine-change-');
      t.after(() => cleanup(cwd));
      const planningDir = path.join(cwd, '.planning');
      const phaseDir = path.join(planningDir, 'phases', '01-foo');
      fs.mkdirSync(phaseDir, { recursive: true });
      // 3 real PLAN.md files on disk — the curated block below UNDER-reports
      // total_plans (1), so this write's disk scan disagrees with it and
      // (source: 'disk', preserve-always/progress-ratchet) the fresh value wins.
      for (let p = 1; p <= 3; p += 1) {
        fs.writeFileSync(path.join(phaseDir, `01-${String(p).padStart(2, '0')}-PLAN.md`), '# Plan\n');
      }
      fs.writeFileSync(
        path.join(planningDir, 'ROADMAP.md'),
        ['## v1.0 Current', '', '### Phase 1: Foo', ''].join('\n'),
      );
      const statePath = path.join(planningDir, 'STATE.md');
      fs.writeFileSync(
        statePath,
        [
          '---',
          'gsd_state_version: 1.0',
          'milestone: v1.0',
          'status: executing',
          'progress:',
          '  total_phases: 1',
          '  completed_phases: 0',
          '  total_plans: 1',
          '  completed_plans: 0',
          '---',
          '',
          '# Project State',
          '',
          '## Session',
          '',
          '**Last session:** 2024-01-10',
          '**Stopped at:** None',
          '',
        ].join('\n'),
      );
      const before = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(Number(before.progress.total_plans), 1, 'setup: curated total_plans starts at 1, present in the snapshot');

      const result = runGsdTools(['state', 'record-session', '--stopped-at', 'Now stopped'], cwd);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      const after = frontmatterLib.extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
      assert.strictEqual(Number(after.progress.total_plans), 3, 'progress.total_plans must actually move 1 -> 3 on disk for this test to mean anything');

      assert.ok(
        output.updated.includes('progress.total_plans'),
        `a leaf already present in the snapshot that genuinely moved must still be reported; got ${JSON.stringify(output.updated)}`,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3473 §8.6 test matrix rows 31-33 (.gsd/phase/feat-3871-state-transaction-
// snapshot/50-test-matrix.md): consumer-output identity for the two
// sanctioned `rebuild()` exceptions (`state sync`, `/gsd-health --repair`'s
// REGENERATE_STATE) and the second producer of the same composition
// (`phase complete`'s atomic-commit adapter in src/phase.cts).
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-3473 §8.6 matrix row 31: state sync still lets the body win (#905, rebuild() did not invert the command)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createFixture(); });
  afterEach(() => { cleanup(tmpDir); });

  test('stateSyncStillLetsTheBodyWin', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'stopped_at: "curated stale value — must NOT survive"',
      '---',
      '',
      '# Project State',
      '',
      '## Session',
      '',
      '**Stopped at:** fresh body value from a contradicting body — must win',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(state);
    assert.strictEqual(
      fm.stopped_at,
      'fresh body value from a contradicting body — must win',
      'the body must win over the frontmatter it contradicts — proves routing cmdStateSync through rebuild() did not invert the command',
    );
  });
});

describe('ADR-3473 §8.6 matrix row 32: REGENERATE_STATE still factory-resets and tolerates NO frontmatter at all', () => {
  // NOTE — discrepancy from the brief's literal instruction, verified
  // empirically (not assumed): driving this through the real CLI
  // (`runGsdTools('validate health --repair', ...)`) cannot exercise this
  // row. Two independent reasons, both confirmed against the built lib:
  //   1. `REMEDY_ACTION.REGENERATE_STATE`'s risk is DESTRUCTIVE
  //      (health-diagnostic-rules/root-existence.cjs's E004 rule), and
  //      `applyRepairs`'s dispatch gate refuses every DESTRUCTIVE remedy
  //      unconditionally — `--repair` NEVER actually calls
  //      `rebuildStateTransaction` for it (see
  //      tests/verify-health.test.cjs "refuses to regenerate STATE.md when
  //      missing" and tests/health-diagnostic.test.cjs row 15, both pinning
  //      the refusal-only contract).
  //   2. Independently, E004 itself only fires when
  //      `snapshot.currentPhaseLabel.scope === SCOPE.UNREADABLE` — a STATE.md
  //      that exists, is readable, and simply has NO frontmatter block does
  //      NOT trip that scope. Verified live: `validate health --repair` json
  //      against exactly this fixture returns `"errors": []` and never
  //      surfaces a `regenerateState` action at all.
  // So the CLI can never reach this code path for this row, by policy (1)
  // and by detection (2) independently. The invocation shape that DOES
  // reach it is the one `runRepairAction`'s REGENERATE_STATE case (and the
  // existing "D3" test in this same file, ADR-3408 §8.5 Matrix, Section A)
  // already use: `stateLib.writeStateMd` + `stateTransitionMod
  // .rebuildStateTransaction({ snapshot: extractFrontmatter(priorState) })`
  // directly — the exact call `runRepairAction`'s REGENERATE_STATE case
  // makes. This test drives that shape with a prior STATE.md carrying
  // literally NO frontmatter block (not merely a missing file).
  test('regenerateStateStillFactoryResetsAndToleratesNoFrontmatter', (t) => {
    const tmp = createTempDir('gsd-3871-row32-');
    t.after(() => cleanup(tmp));
    const statePath = path.join(tmp, 'STATE.md');
    const noFrontmatterContent = [
      '# Session State',
      '',
      'No frontmatter here at all — a broken document, the usual reason',
      'REGENERATE_STATE fires in the first place.',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, noFrontmatterContent);

    const priorSnapshot = frontmatterLib.extractFrontmatter(noFrontmatterContent, statePath);
    assert.deepStrictEqual(priorSnapshot, {}, 'precondition: extractFrontmatter must return {} (never throw/null) for a document with no frontmatter');

    let tx;
    assert.doesNotThrow(() => {
      tx = stateTransitionMod.rebuildStateTransaction({ snapshot: priorSnapshot });
    }, 'rebuildStateTransaction must NOT raise a construction failure for the {} snapshot of a frontmatter-less document');

    const regenerated = [
      '# Session State', '', '## Position', '',
      '**Current phase:** (determining...)', '**Status:** Resuming', '',
    ].join('\n');

    stateLib.writeStateMd(statePath, regenerated, tx, tmp);

    const onDisk = fs.readFileSync(statePath, 'utf8');
    const fm = frontmatterLib.extractFrontmatter(onDisk);
    assert.ok(fm && fm.gsd_state_version, 'the factory reset must produce a fresh, well-formed frontmatter block');
    assert.strictEqual(fm.status, 'Resuming', 'the regenerated content must be what was written, not the old (nonexistent) curated content');
    assert.match(onDisk, /## Position/, 'the regenerated body must be the fresh factory-reset content, not the old prose');
  });
});

describe('ADR-3473 §8.6 matrix row 33: phase complete\'s adapter uses the identical transaction/preservation composition (#3374 Variant A stays fixed)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('phaseCompleteAdapterUsesTheSameTransaction', () => {
    const planningDir = path.join(tmpDir, '.planning');
    const phase1Dir = path.join(planningDir, 'phases', '01-foundation');
    const phase2Dir = path.join(planningDir, 'phases', '02-api');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.mkdirSync(phase2Dir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Foundation',
        '- [ ] Phase 2: API',
        '',
        '### Phase 1: Foundation',
        '**Goal:** Setup',
        '**Plans:** 1 plans',
        '',
        '### Phase 2: API',
        '**Goal:** Build API',
        '',
        '## Progress',
        '',
        '| Phase | Plans Complete | Status | Completed |',
        '|-------|----------------|--------|-----------|',
        '| 01. Foundation | 0/1 | Not started | - |',
        '| 02. API | 0/1 | Not started | - |',
        '',
      ].join('\n'),
    );

    // A curated `paused_at` frontmatter value with NO corresponding body
    // source line — its body delta compares as unchanged (nothing to
    // disagree with), so a stale/absent derived value would clobber it if
    // cmdPhaseComplete's adapter did NOT route through the identical
    // applyStatePreservation dispatch a `state` verb uses.
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'paused_at: "curated pause note — must survive phase complete"',
        '---',
        '',
        '# State',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** Foundation',
        '**Status:** In progress',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working on phase 1',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(
      path.join(phase1Dir, '01-VERIFICATION.md'),
      ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
    );

    const result = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(
      Array.isArray(output.preservation_warnings) && output.preservation_warnings.some((w) => w.field === 'paused_at'),
      `expected paused_at named in preservation_warnings — same policy a state verb reports; got ${JSON.stringify(output.preservation_warnings)}`,
    );

    const state = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(state);
    assert.strictEqual(
      fm.paused_at,
      'curated pause note — must survive phase complete',
      'the curated field must survive phase complete via the SAME composition (syncAndPreserveStateMd -> applyStatePreservation) a state verb uses',
    );
  });
});

// #3834/#3835/#3836 share the epic #3473 thesis: FIELD_CLASSIFICATION declares
// a field's preservation policy once (src/state-transition.cts), and each of
// these three is a call site that either defeats the delta heuristic by
// rewriting the exact body source it compares against in the same write
// (#3834, #3835), or maintains a hand-typed field list parallel to the table
// that had already drifted from it (#3836).
describe('#3834/#3835/#3836: current_phase_name / last_activity_desc preservation call-site gaps', () => {
  function buildCuratedNameFixture(cwd) {
    const planningDir = path.join(cwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## v1.0 Demo Milestone',
        '',
        '### Phase 1: First Phase',
        '**Goal:** demo',
        '',
        '### Phase 2: Second Phase Real Name',
        '**Goal:** demo',
        '',
        '### Phase 3: Third Phase',
        '**Goal:** demo',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'milestone_name: Demo Milestone',
        'current_phase: 1',
        'current_phase_name: Real Curated Name',
        'current_plan: 0',
        'status: executing',
        'stopped_at: "Phase 1 done"',
        'last_updated: "2026-08-25T00:00:00.000Z"',
        'last_activity: "2026-08-25"',
        'last_activity_desc: "Fresh curated description"',
        'progress:',
        '  total_phases: 3',
        '  completed_phases: 1',
        '  total_plans: 6',
        '  completed_plans: 2',
        '  percent: 33',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Phase:** 1 — Real Curated Name',
        '**Current Plan:** 0',
        '**Status:** executing',
        '',
        '## Session',
        '',
        '**Stopped At:** Phase 1 done',
        '**Last Activity:** 2026-08-25',
        '**Last Activity Description:** Fresh curated description',
        '',
      ].join('\n'),
    );
  }

  // THIS TEST MUST FAIL BEFORE THE #3834 FIX: `state planned-phase` without
  // `--name` rewrites the body `Phase:` source line to `N — READY TO EXECUTE`
  // in the same write the preserve-when-unchanged delta rule compares
  // against, so the rule cannot fire and the post-sync re-derivation harvests
  // the status fragment as if it were the curated name.
  test('plannedPhaseWithoutNameDoesNotClobberCuratedPhaseName', (t) => {
    const cwd = createTempDir('gsd-3834-planned-phase-');
    t.after(() => cleanup(cwd));
    buildCuratedNameFixture(cwd);

    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '3'], cwd);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const statePath = path.join(cwd, '.planning', 'STATE.md');
    const written = fs.readFileSync(statePath, 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(written);
    assert.strictEqual(
      fm.current_phase_name,
      'Real Curated Name',
      `current_phase_name must keep the curated value, not the status fragment "READY TO EXECUTE" — got ${JSON.stringify(fm.current_phase_name)}`,
    );
  });

  // THIS TEST MUST FAIL BEFORE THE #3835 FIX: `state complete-phase` rewrites
  // the body `Phase:` source line to `N — COMPLETE` unconditionally, which
  // defeats the same delta rule and DROPS the current_phase_name key from
  // persisted frontmatter entirely (not merely blanks it).
  test('completePhaseDoesNotDropCuratedPhaseName', (t) => {
    const cwd = createTempDir('gsd-3835-complete-phase-');
    t.after(() => cleanup(cwd));
    buildCuratedNameFixture(cwd);
    // Phase directories so `progress` is legitimately re-derived from disk
    // and does not confound the current_phase_name assertion below.
    const phasesDir = path.join(cwd, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-first-phase'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '02-second-phase'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '03-third-phase'), { recursive: true });
    fs.writeFileSync(path.join(phasesDir, '01-first-phase', '1-01-SUMMARY.md'), '---\nphase: 1\nplan: 01\nstatus: complete\n---\n# s\n');
    fs.writeFileSync(path.join(phasesDir, '01-first-phase', '1-01-PLAN.md'), '---\nphase: 1\nplan: 01\n---\n# p\n');
    fs.writeFileSync(path.join(phasesDir, '02-second-phase', '2-01-PLAN.md'), '---\nphase: 2\nplan: 01\n---\n# p\n');
    fs.writeFileSync(path.join(phasesDir, '03-third-phase', '3-01-PLAN.md'), '---\nphase: 3\nplan: 01\n---\n# p\n');

    const result = runGsdTools(['state', 'complete-phase', '1'], cwd);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const statePath = path.join(cwd, '.planning', 'STATE.md');
    const written = fs.readFileSync(statePath, 'utf-8');
    const fm = frontmatterLib.extractFrontmatter(written);
    assert.strictEqual(
      fm.current_phase_name,
      'Real Curated Name',
      `current_phase_name must survive complete-phase, not be deleted from frontmatter entirely — got ${JSON.stringify(fm.current_phase_name)}`,
    );
  });

  // THIS TEST MUST FAIL BEFORE THE #3836 FIX: `cmdStateJson`'s hand-maintained
  // preserve-when-unchanged field list omits `last_activity_desc` (declared
  // preserve-when-unchanged in FIELD_CLASSIFICATION and wired on the write
  // path per #3258), so a stale body-prose "Last Activity Description:" line
  // beats a fresher curated frontmatter value on every `state json` read.
  test('stateJsonPreservesCuratedLastActivityDescOverStaleBodyProse', (t) => {
    const cwd = createTempDir('gsd-3836-state-json-');
    t.after(() => cleanup(cwd));
    const planningDir = path.join(cwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## v1.0 Demo Milestone',
        '',
        '### Phase 1: First Phase',
        '**Goal:** demo',
        '',
        '### Phase 2: Second Phase Real Name',
        '**Goal:** demo',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'milestone_name: Demo Milestone',
        'current_phase: 2',
        'current_phase_name: Second Phase Real Name',
        'current_plan: 1',
        'status: executing',
        'stopped_at: "Phase 2 plan 1 in flight"',
        'last_updated: "2026-08-25T00:00:00.000Z"',
        'last_activity: "2026-08-25"',
        'last_activity_desc: "FRESH CURATED DESCRIPTION"',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        '**Phase:** 2 — Second Phase Real Name',
        '**Current Plan:** 1',
        '**Status:** executing',
        '',
        '## Session',
        '',
        '**Stopped At:** Phase 2 plan 1 in flight',
        '**Last Activity:** 2026-08-25',
        '',
        '## Session Continuity Archive',
        '',
        '**Last Activity Description:** STALE ARCHIVED DESCRIPTION FROM 2025',
        '',
      ].join('\n'),
    );

    const before = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf-8');
    const result = runGsdTools(['state', 'json'], cwd);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const after = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, '`state json` is read-only and must not mutate STATE.md');

    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.last_activity_desc,
      'FRESH CURATED DESCRIPTION',
      `last_activity_desc must report the curated frontmatter value, not the stale archived body prose — got ${JSON.stringify(parsed.last_activity_desc)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3473 §8.7 (#3872): the transaction diff — remaining test-matrix rows
// (`.gsd/phase/feat-3872-transaction-diff-reporting/50-test-matrix.md`). Rows
// 3, 4, 5, 8, 12, 13, 20, 27 and the row-12 companion are covered elsewhere
// (tests/frontmatter.test.cjs's #1264 pin, and existing state.test.cjs A2f/
// #3743/#3818 assertions) and are deliberately NOT duplicated here.
// ─────────────────────────────────────────────────────────────────────────────
describe('ADR-3473 §8.7 (#3872): reconcileReportedFields / the transaction diff', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3872-diff-');
    statePath = path.join(tmpDir, 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writePersisted(frontmatterLines, bodyLines) {
    fs.writeFileSync(
      statePath,
      ['---', ...frontmatterLines, '---', '', ...bodyLines].join('\n'),
    );
  }

  // Row 1
  test('reportsAFieldThatActuallyPersisted', () => {
    writePersisted(
      ['current_phase: "05"'],
      ['# State', '', '**Current Phase:** 05', ''],
    );
    const snapshotBody = ['# State', '', '**Current Phase:** 04', ''].join('\n');
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { current_phase: '04' }, body: snapshotBody },
      ['Current Phase'],
      [],
    );
    assert.deepEqual(updated, ['Current Phase'], 'a field the transform reported that genuinely persisted must be reported');
  });

  // Row 2 — #3351 stays closed
  test('doesNotReportAFieldTheWriteDiscarded', () => {
    const body = ['# State', '', '**Current Phase:** 05', ''].join('\n');
    writePersisted(['current_phase: "05"'], ['# State', '', '**Current Phase:** 05', '']);
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { current_phase: '05' }, body },
      ['Current Phase'],
      [],
    );
    assert.deepEqual(updated, [], '#3351: a field the transform claimed to write but sync/preservation discarded before the save must not be reported');
  });

  // Rows 6, 7, 9 — pure diff, no I/O: computeChangedFrontmatterFields
  test('doesNotReportAnUnchangedDottedLeaf / reportsOnlyTheLeafThatMoved / neverReportsAnUnconditionallyStampedField', () => {
    const snapshotFm = {
      progress: { total_plans: '0', completed_plans: '2' },
      last_updated: '2026-08-24T00:00:00.000Z',
    };
    const persistedFm = {
      progress: { total_plans: '5', completed_plans: '2' },
      last_updated: '2026-08-25T00:00:00.000Z',
    };
    const changed = stateLib._computeChangedFrontmatterFields(snapshotFm, persistedFm, undefined);
    assert.deepEqual(
      changed,
      ['progress.total_plans'],
      'total_plans moved and must be the only reported leaf: completed_plans (row 6) is unchanged so it must not appear, ' +
      'and last_updated (row 9) is the one-element provenance exclusion so it must never appear regardless of how much it moved',
    );
  });

  // Row 14 — preserve-always field restored to an identical value
  test('anIdenticalRestoreIsNotAChange', () => {
    writePersisted(['milestone: "v2"'], ['# State', '']);
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { milestone: 'v2' }, body: '# State\n' },
      [],
      [],
    );
    assert.deepEqual(updated, [], 'milestone restored to the SAME value it already held is not a change');
  });

  // Row 15 — the row that proves no classification-based exclusion survives
  test('reportsAPlaceholderRestoreThatChangedTheValue', () => {
    writePersisted(['milestone: "v2"'], ['# State', '']);
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { milestone: 'unreleased' }, body: '# State\n' },
      [],
      [],
    );
    assert.deepEqual(
      updated,
      ['milestone'],
      'a preserve-if-placeholder field (milestone/milestone_name) genuinely restored to a DIFFERENT value must be ' +
      'reported — the old classification filter would have suppressed it, so this is the row that proves the filter is gone',
    );
  });

  // Row 16 — deletion
  test('reportsADeletedKey', () => {
    writePersisted(['status: "executing"'], ['# State', '']);
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { status: 'executing', stale_key: 'x' }, body: '# State\n' },
      [],
      [],
    );
    assert.deepEqual(updated, ['stale_key'], 'a key present in the snapshot but absent from persisted is a deletion, which is a change');
  });

  // Row 17 — addition
  test('reportsAnAddedKey', () => {
    writePersisted(['status: "executing"', 'new_key: "y"'], ['# State', '']);
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { status: 'executing' }, body: '# State\n' },
      [],
      [],
    );
    assert.deepEqual(updated, ['new_key'], 'a key absent from the snapshot but present in persisted is an addition, which is a change');
  });

  // Row 18 — #1162: body-first, frontmatter-key-flat fallback second. A field
  // name that EXACT-MATCHES a frontmatter key must still resolve against the
  // body first — proven by making the frontmatter value stay constant while
  // only the body's label line moves, so a frontmatter-first reading would
  // wrongly report "unchanged".
  test('bodyLabelResolutionOrderUnchanged', () => {
    writePersisted(['status: "A"'], ['# State', '', '**Status:** C', '']);
    const snapshotBody = ['# State', '', '**Status:** B', ''].join('\n');
    const updated = stateLib._reconcileReportedFields(
      statePath,
      { fm: { status: 'A' }, body: snapshotBody },
      ['status'],
      [],
    );
    assert.deepEqual(
      updated,
      ['status'],
      '#1162: a lowercase field name that exact-matches a frontmatter key must still resolve against the BODY first — ' +
      'the frontmatter value (A) never changed, but the body label did (B -> C), and only body-first resolution reports that',
    );
  });

  // Row 19 — internal-invariant throw for a preserve-when-unchanged field
  // with no FRONTMATTER_KEY_TO_BODY_LABEL row. `getFieldClassification` is
  // consulted via `stateTransitionMod.getFieldClassification` (a property
  // read, not a destructured local), so mocking the shared module object is
  // observed by the compiled seam under test.
  test('unwiredLabelRowStillThrows', (t) => {
    const original = stateTransitionMod.getFieldClassification;
    mock.method(stateTransitionMod, 'getFieldClassification', (field) => {
      if (field === 'fake_preserve_field') return { preservation: 'preserve-when-unchanged' };
      return original(field);
    });
    t.after(() => mock.restoreAll());

    writePersisted(['fake_preserve_field: "x"'], ['# State', '']);
    assert.throws(
      () => stateLib._reconcileReportedFields(statePath, { fm: {}, body: '# State\n' }, [], []),
      (err) => err.code === 'STATE_BODY_LABEL_UNWIRED_ROW' && err.field === 'fake_preserve_field',
      'a preserve-when-unchanged field with no FRONTMATTER_KEY_TO_BODY_LABEL row must still throw STATE_BODY_LABEL_UNWIRED_ROW',
    );
  });

  // Row 21 — representation-insensitive equality (frontmatter scalars round-trip as strings)
  test('stringAndNumberOfTheSameValueIsNotAChange', () => {
    assert.equal(stateLib._stateFieldValuesDiffer('5', 5), false, '"5" vs 5 is the SAME value in two representations, not a change');
    assert.equal(stateLib._stateFieldValuesDiffer('0', 0), false, '"0" vs 0 is the SAME value, not a change');
    assert.equal(
      stateLib._stateFieldValuesDiffer('1.0', 1),
      true,
      '"1.0" and 1 stringify to DIFFERENT representations ("1.0" vs "1") — this is a genuine representation change, not the same-value case row 21 protects',
    );
    assert.equal(stateLib._stateFieldValuesDiffer('5', '6'), true, 'a genuine value change ("5" -> "6") must still count');
  });

  // Row 22 — structural, not reference, equality
  test('structuralEqualityForNestedValues', () => {
    assert.equal(
      stateLib._stateFieldValuesDiffer({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }),
      false,
      'two distinct object instances with the same structure are not a change',
    );
    assert.equal(
      stateLib._stateFieldValuesDiffer({ a: 1 }, { a: 2 }),
      true,
      'a structural difference is a change',
    );
  });

  // Row 23 — hostile: missing parent
  test('dottedPathWithMissingParentDoesNotThrow', () => {
    let resolved;
    assert.doesNotThrow(() => {
      resolved = stateLib._resolveFrontmatterPath({}, 'progress.total_plans');
    });
    assert.equal(typeof resolved, 'symbol', 'a missing parent must resolve to the absence SENTINEL (a symbol), not undefined/null by coincidence');
    assert.ok(
      resolved.toString().includes('state-field-absent'),
      `expected the state-field-absent sentinel, got ${resolved.toString()}`,
    );
    // Same input on both sides of the diff: absent-vs-absent is not a change.
    assert.equal(
      stateLib._computeChangedFrontmatterFields({}, {}, undefined).includes('progress.total_plans'),
      false,
      'a leaf whose parent is absent on BOTH sides is not a change',
    );
  });

  // Row 24 — hostile: dotted path into a scalar parent
  test('dottedPathIntoAScalarDoesNotThrow', () => {
    let resolved;
    assert.doesNotThrow(() => {
      resolved = stateLib._resolveFrontmatterPath({ status: 'executing' }, 'status.foo');
    });
    assert.equal(typeof resolved, 'symbol', 'a dotted path into a scalar parent must resolve to the absence SENTINEL, not throw or return the scalar itself');
    assert.ok(
      resolved.toString().includes('state-field-absent'),
      `expected the state-field-absent sentinel, got ${resolved.toString()}`,
    );
    assert.equal(
      stateLib._computeChangedFrontmatterFields(
        { status: 'executing' },
        { status: 'executing' },
        undefined,
      ).includes('status.foo'),
      false,
      'a dotted path into a scalar parent (unchanged on both sides) is not reported as a change',
    );
  });

  // Row 25 — security: prototype-pollution safety. Field names __proto__,
  // constructor, prototype, toString both as PATH SEGMENTS (nested under a
  // real object) and as actual frontmatter KEYS (own enumerable properties —
  // built via JSON.parse, which — unlike object-literal syntax — creates a
  // literal own property named "__proto__" rather than reassigning the
  // object's prototype).
  test('dottedResolutionDoesNotPollutePrototypes', () => {
    const hostileKeys = ['__proto__', 'constructor', 'prototype', 'toString'];

    assert.doesNotThrow(() => {
      // As path segments under a real nested object.
      for (const key of hostileKeys) {
        stateLib._resolveFrontmatterPath({ a: {} }, `a.${key}.polluted`);
      }
      // As flat top-level keys, and as own frontmatter keys via JSON.parse.
      const hostileFm = JSON.parse(
        '{"__proto__":"snap-proto","constructor":"snap-ctor","prototype":"snap-proto2","toString":"snap-tostr"}',
      );
      for (const key of hostileKeys) {
        stateLib._resolveFrontmatterPath(hostileFm, key);
      }
    }, 'hostile path segments and frontmatter keys must never throw');

    const hostileSnapshot = JSON.parse(
      '{"__proto__":"snap-proto","constructor":"snap-ctor","prototype":"snap-proto2","toString":"snap-tostr"}',
    );
    const hostilePersisted = JSON.parse(
      '{"__proto__":"persisted-proto","constructor":"snap-ctor","prototype":"snap-proto2","toString":"snap-tostr"}',
    );
    writePersisted(['status: "executing"'], ['# State', '']);
    stateLib._reconcileReportedFields(
      statePath,
      { fm: hostileSnapshot, body: '# State\n' },
      hostileKeys,
      [],
    );
    const changed = stateLib._computeChangedFrontmatterFields(hostileSnapshot, hostilePersisted, undefined);
    assert.deepEqual(
      changed,
      ['__proto__'],
      'only the hostile key whose value genuinely differs must be reported — the diff must still function correctly, not merely avoid throwing',
    );

    assert.strictEqual(({}).polluted, undefined, 'a plain object must never gain a "polluted" own or inherited property AFTER running the resolution and the full diff');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
      false,
      'Object.prototype itself must gain no new member from hostile field names',
    );
  });

  // Row 26 — a literal key containing a dot, resolved BEFORE path traversal
  // (pinned to the order `resolveFrontmatterPath` actually ships: a literal
  // flat own-property wins first; only when no such flat key exists is the
  // name split and walked as a dotted path).
  test('literalDottedKeyResolvesBeforePathTraversal', () => {
    const fm = { 'a.b': 'literal-value', a: { b: 'path-value' } };
    assert.equal(
      stateLib._resolveFrontmatterPath(fm, 'a.b'),
      'literal-value',
      'a stored flat key containing a literal dot must win over dotted-path traversal into a same-named nested structure',
    );
  });

  // Row 10 — state_head IS reportable: it changes only when git HEAD actually
  // moved, so a git-backed fixture across a real commit must surface it.
  test('reportsStateHeadWhenHeadMoved', () => {
    const dir = createTempGitProject('gsd-3872-statehead-');
    writeState(dir, ['---', 'status: "Paused"', '---', '', '# State', '', '**Status:** Paused', ''].join('\n'));
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'seed state'], { cwd: dir });

    // Stabilizing write: the very first patch on a freshly-seeded fixture
    // also reports gsd_state_version/progress.* from bootstrap resync noise,
    // which is not this row's concern.
    runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'In progress' })], dir);

    // Advance HEAD with a real commit, unrelated to STATE.md.
    fs.writeFileSync(path.join(dir, 'dummy.txt'), 'x');
    gitOrThrow(['add', 'dummy.txt'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'advance head'], { cwd: dir });

    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Executing' })], dir);
    assert.ok(result.success, `state.patch failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(
      output.updated.includes('state_head'),
      `state_head must be reported when git HEAD genuinely moved between writes; got updated=${JSON.stringify(output.updated)}`,
    );
  });

  // Row 11 — absence is not a change, in both of the matrix's named shapes:
  // (a) HEAD did not move between two writes in a git-backed tree, and
  // (b) the tree is not a git repo at all (state_head never appears at all).
  test('absentStateHeadIsNotAChange', () => {
    const gitDir = createTempGitProject('gsd-3872-statehead-unmoved-');
    writeState(gitDir, ['---', 'status: "Paused"', '---', '', '# State', '', '**Status:** Paused', ''].join('\n'));
    gitOrThrow(['add', '-A'], { cwd: gitDir });
    gitOrThrow(['commit', '-m', 'seed state'], { cwd: gitDir });

    runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'In progress' })], gitDir);
    const unmoved = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Executing' })], gitDir);
    assert.ok(unmoved.success, `state.patch failed: ${unmoved.error}`);
    const unmovedOutput = JSON.parse(unmoved.output);
    assert.ok(
      !unmovedOutput.updated.includes('state_head'),
      `state_head must NOT be reported when HEAD did not move; got updated=${JSON.stringify(unmovedOutput.updated)}`,
    );

    const plainDir = createTempProject('gsd-3872-statehead-nongit-');
    writeState(plainDir, ['---', 'status: "Paused"', '---', '', '# State', '', '**Status:** Paused', ''].join('\n'));
    runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'In progress' })], plainDir);
    const nonGit = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Executing' })], plainDir);
    assert.ok(nonGit.success, `state.patch failed: ${nonGit.error}`);
    const nonGitOutput = JSON.parse(nonGit.output);
    assert.ok(
      !nonGitOutput.updated.includes('state_head'),
      `an absent state_head (non-git tree) must not read as a deletion/change; got updated=${JSON.stringify(nonGitOutput.updated)}`,
    );
    cleanup(gitDir);
    cleanup(plainDir);
  });

  // Row 28 — every reconcileReportedFields call site still compiles and
  // reports coherently: one assertion per command family.
  test('everyReportingCommandStillReportsCoherently', () => {
    function assertArrayOfStrings(value, label) {
      assert.ok(Array.isArray(value), `${label}: expected an array, got ${JSON.stringify(value)}`);
      for (const entry of value) {
        assert.equal(typeof entry, 'string', `${label}: every entry must be a string field name, got ${JSON.stringify(entry)}`);
      }
    }

    // cmdStatePatch
    {
      const dir = createFixture();
      writeState(dir, '# Project State\n\n**Status:** Ready\n');
      const r = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Executing now' })], dir);
      assert.ok(r.success, `state.patch failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assertArrayOfStrings(out.updated, 'cmdStatePatch');
      assert.ok(out.updated.includes('Status'), 'cmdStatePatch: the field that genuinely changed must be reported');
      cleanup(dir);
    }

    // cmdStateUpdate
    {
      const dir = createFixture();
      writeState(dir, '# Project State\n\n**Status:** Ready\n');
      const r = runGsdTools(['state', 'update', 'Status', 'Executing now'], dir);
      assert.ok(r.success, `state update failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.equal(typeof out.updated, 'boolean', 'cmdStateUpdate: updated is a single-field boolean, not an array');
      assertArrayOfStrings(out.preserved, 'cmdStateUpdate.preserved');
      assert.equal(out.updated, true, 'cmdStateUpdate: the requested field genuinely changed and must report success');
      cleanup(dir);
    }

    // cmdStateAdvancePlan
    {
      const dir = createFixture();
      writeState(dir, [
        '# Project State', '', '**Current Plan:** 1', '**Total Plans in Phase:** 3',
        '**Status:** Executing', '**Last Activity:** 2024-01-10',
      ].join('\n') + '\n');
      const r = runGsdTools(['state', 'advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assertArrayOfStrings(out.updated, 'cmdStateAdvancePlan');
      assert.ok(out.updated.includes('Current Plan'), 'cmdStateAdvancePlan: the plan counter that genuinely advanced must be reported');
      cleanup(dir);
    }

    // cmdStateRecordSession
    {
      const dir = createFixture();
      writeState(dir, [
        '# Project State', '', '## Session Continuity', '',
        '**Last session:** 2024-01-10', '**Stopped at:** Phase 2, Plan 1', '**Resume file:** None',
      ].join('\n') + '\n');
      const r = runGsdTools(['state', 'record-session', '--stopped-at', 'Phase 3, Plan 2'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.equal(out.recorded, true, 'cmdStateRecordSession: a genuine field write must record');
      assertArrayOfStrings(out.updated, 'cmdStateRecordSession');
      assert.ok(out.updated.includes('Stopped At'), 'cmdStateRecordSession: the field that genuinely changed must be reported');
      cleanup(dir);
    }

    const phaseStateMd = [
      '# Project State', '', '**Current Phase:** 1', '**Current Phase Name:** setup', '**Total Phases:** 5',
      '**Current Plan:** 0', '**Total Plans in Phase:** 0', '**Status:** Ready to plan', '**Last Activity:** 2026-03-20',
      '**Last Activity Description:** Roadmap created', '', '## Current Position',
      'Phase: 1 of 5 (setup)', 'Plan: 0 of ? in current phase', 'Status: Ready to plan',
      'Last activity: 2026-03-20 -- Roadmap created', 'Progress: [..........] 0%', '',
    ].join('\n');

    // cmdStateBeginPhase
    {
      const dir = createFixture();
      writeState(dir, phaseStateMd);
      const r = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'], dir);
      assert.ok(r.success, `begin-phase failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assertArrayOfStrings(out.updated, 'cmdStateBeginPhase');
      assert.ok(out.updated.includes('Status'), 'cmdStateBeginPhase: Status genuinely changed and must be reported');
      cleanup(dir);
    }

    // cmdStatePlannedPhase
    {
      const dir = createFixture();
      writeState(dir, phaseStateMd);
      const r = runGsdTools(['state', 'planned-phase', '--phase', '3', '--name', 'API', '--plans', '5'], dir);
      assert.ok(r.success, `planned-phase failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assertArrayOfStrings(out.updated, 'cmdStatePlannedPhase');
      assert.ok(out.updated.includes('Total Plans in Phase'), 'cmdStatePlannedPhase: the plan count that genuinely changed must be reported');
      cleanup(dir);
    }

    // cmdStateCompletePhase
    {
      const dir = createFixture();
      writeState(dir, phaseStateMd);
      const r = runGsdTools(['state', 'complete-phase', '--phase', '1'], dir);
      assert.ok(r.success, `complete-phase failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assertArrayOfStrings(out.updated, 'cmdStateCompletePhase');
      assert.ok(out.updated.includes('Current Position'), 'cmdStateCompletePhase: Current Position genuinely changed and must be reported');
      cleanup(dir);
    }
  });

  // Row 29 — property: a field appears in the changed set IFF its persisted
  // value differs from the snapshot, over generated snapshot/persisted
  // frontmatter pairs, ambient keys (last_updated) excluded. Arbitraries are
  // declared INSIDE the property body (fast-check v4: a describe-body
  // arbitrary kills the whole block). Seed pinned, numRuns bounded; a failing
  // run's thrown error carries fast-check's own counterexample + seed for
  // replay.
  test('updatedIsExactlyTheChangedNonAmbientSet', () => {
    // A closed, deliberately small key alphabet — none of these are
    // body-sourced (current_phase/current_phase_name), declared-leaf parents
    // (progress), or the ambient exclusion (last_updated), so the reference
    // oracle below (plain hasOwnProperty + stateFieldValuesDiffer) is exactly
    // what computeChangedFrontmatterFields is contractually required to match.
    const KEYS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const scalarArb = fc.oneof(
      fc.string({ maxLength: 6 }),
      fc.integer({ min: -100, max: 100 }),
      fc.boolean(),
    );
    const fmArb = fc.dictionary(fc.constantFrom(...KEYS), scalarArb, { maxKeys: KEYS.length });

    fc.assert(
      fc.property(fmArb, fmArb, (snapshotFm, persistedFm) => {
        const changed = stateLib._computeChangedFrontmatterFields(snapshotFm, persistedFm, undefined);
        const changedSet = new Set(changed);
        const unionKeys = new Set([...Object.keys(snapshotFm), ...Object.keys(persistedFm)]);
        for (const key of unionKeys) {
          const inSnap = Object.prototype.hasOwnProperty.call(snapshotFm, key);
          const inPers = Object.prototype.hasOwnProperty.call(persistedFm, key);
          const expected = inSnap !== inPers
            ? true
            : stateLib._stateFieldValuesDiffer(snapshotFm[key], persistedFm[key]);
          assert.equal(
            changedSet.has(key),
            expected,
            `key=${key} expected changed=${expected} actual=${changedSet.has(key)} ` +
            `snapshot=${JSON.stringify(snapshotFm)} persisted=${JSON.stringify(persistedFm)}`,
          );
        }
      }),
      { seed: 20260825, numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Consumer-output identity (ADR-3180 Decision 4(b)) — #3358 / #3884
//
// For #3358 the consumer is `state planned-phase`'s EFFECT on STATE.md, not
// `parseNamedArgs`'s return value — a unit assertion on the parser alone
// would have passed throughout this defect's entire life. These rows spawn
// the real CLI against a temp project and assert on STATE.md's bytes.
// ────────────────────────────────────────────────────────────────────────
describe('state — consumer-output identity (ADR-3180 Decision 4(b), #3358)', () => {
  function stateMdWithPopulatedPhaseTwo() {
    return [
      '---',
      "gsd_state_version: '1.0'",
      'status: planning',
      'progress:',
      '  total_phases: 5',
      '  completed_phases: 1',
      '  total_plans: 10',
      '  completed_plans: 4',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 2 of 5 (Widget Support)',
      'Plan: 1 of 3 in current phase',
      'Status: Ready to execute',
      'Last activity: 2026-08-20 — Phase 2 planning complete',
      '',
      'Progress: [####------] 40%',
      '',
    ].join('\n');
  }

  // #3358: a stray positional (`3`) past `state planned-phase`'s declared
  // boundary is silently dropped by the CURRENT permissive parseNamedArgs —
  // every flag resolves to `null` — and the command still RUNS, overwriting
  // the previously-current phase block.
  //
  // Measured on this tree, 2026-08-26, against exactly this fixture:
  //   $ gsd-tools query state.planned-phase 3 --cwd <tmp>
  //   {"updated":["Current Position","Current Phase Name"],"phase":null,"plan_count":null}
  //   exit 0
  // STATE.md's `## Current Position` block changed from:
  //   Phase: 2 of 5 (Widget Support)
  // to:
  //   Phase: null — READY TO EXECUTE
  // (and frontmatter gained `current_phase_name: READY TO EXECUTE`, an
  // outright corruption of the curated phase name).
  test('positionalPlannedPhaseLeavesStateMdUntouched_3358', () => {
    const tmpDir = createTempProject();
    try {
      const statePath = writeState(tmpDir, stateMdWithPopulatedPhaseTwo());
      const before = fs.readFileSync(statePath);

      const result = runGsdTools('query state.planned-phase 3', tmpDir);

      assert.notStrictEqual(result.exitCode, 0, 'a positional argument past the boundary must exit non-zero');
      const after = fs.readFileSync(statePath);
      assert.ok(before.equals(after), 'STATE.md must be byte-identical to before the rejected call');
    } finally {
      cleanup(tmpDir);
    }
  });

  // Control: the flag form of the exact same intent must keep succeeding and
  // keep updating STATE.md — proves C1 above is not passing merely because
  // `state planned-phase` is broken outright.
  test('flagFormPlannedPhaseStillUpdatesStateMd', () => {
    const tmpDir = createTempProject();
    try {
      const statePath = writeState(tmpDir, stateMdWithPopulatedPhaseTwo());

      const result = runGsdTools('query state.planned-phase --phase 3 --name X --plans 2', tmpDir);

      assert.strictEqual(result.success, true, result.error);
      const after = fs.readFileSync(statePath, 'utf-8');
      assert.match(after, /Phase: 3 \(X\) — READY TO EXECUTE/);
    } finally {
      cleanup(tmpDir);
    }
  });

  // #3358, second call site: an extra positional token on `add-decision`
  // must not be silently absorbed into a successful write.
  test('positionalOnAddDecisionAppendsNothing', () => {
    const tmpDir = createTempProject();
    try {
      const statePath = writeState(tmpDir, [
        '---',
        "gsd_state_version: '1.0'",
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
        '## Accumulated Context',
        '',
        '### Decisions',
        '',
        '- none yet',
        '',
      ].join('\n'));
      const before = fs.readFileSync(statePath, 'utf-8');

      const result = runGsdTools(['query', 'state.add-decision', 'stray-token', '--summary', 'x'], tmpDir);

      assert.notStrictEqual(result.exitCode, 0, 'an extra positional argument must exit non-zero');
      const after = fs.readFileSync(statePath, 'utf-8');
      assert.ok(!after.includes('- [Phase'), 'no decision row should have been appended');
      assert.strictEqual(after, before, 'STATE.md must be unchanged when the call is rejected');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #3957 (epic #3473 B9) — a no-op decline reports the real condition.
// .gsd/phase/enhance-3957-noop-real-condition/{40-design,50-test-matrix}.md
// Rows 1-10 of the test matrix. Every `cmdState*` call here is IN-PROCESS
// (not via runGsdTools's subprocess) because a subprocess's legacy result
// shape drops stderr on a clean (exit 0) run — see tests/helpers.cjs
// toLegacyShape — and a no-op decline is exactly an exit-0 run that still
// needs its stderr disclosure asserted.
// ═══════════════════════════════════════════════════════════════════════════

describe('#3957 (epic #3473 B9): no-op decline reports the real condition', () => {
  const clockLib = require('../gsd-core/bin/lib/clock.cjs');

  /**
   * Mirrors captureStdout (top of file) but also captures any
   * `[gsd-tools] WARNING:` disclosure written via `process.stderr.write`
   * (declineNoOp's stderr mechanism, matching the pre-existing
   * cmdStateUpdateProgress decline arms and the
   * stateReplaceFieldWithFallback precedent above) — needed because
   * subprocess-based runGsdTools drops stderr on a clean exit.
   */
  function captureCliIO(fn) {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stdout = '';
    let stderr = '';
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      stdout = captureFdSync(1, fn);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    return { stdout, stderr };
  }

  describe('cmdStateUpdateProgress', () => {
    let tmpDir;
    afterEach(() => { if (tmpDir) cleanup(tmpDir); });

    // Row 1: frontmatter progress present (via the real disk scan), body has
    // no Progress:/**Progress:** line at all.
    test('update-progress reports the missing body line and carries computed values', () => {
      tmpDir = createTempProject();
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
        '# Roadmap', '', '## v1.0 Current', '', '### Phase 1: Foo', '',
      ].join('\n'));
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foo');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Status: Executing',
        'Phase: 1',
        '',
      ].join('\n'));

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateUpdateProgress(tmpDir, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.updated, false);
      assert.strictEqual(
        out.reason,
        'no Progress: line found in STATE.md body to update (frontmatter progress data is unaffected)',
      );
      assert.strictEqual(out.completed, 1, 'completed must be carried, not discarded');
      assert.strictEqual(out.total, 2, 'total must be carried, not discarded');
      assert.strictEqual(typeof out.percent, 'number', 'percent must be carried, not discarded');
      assert.match(stderr, /^\[gsd-tools\] WARNING: state update-progress skipped — no Progress: line found in STATE\.md body/);
    });

    // Row 2: phase scope is not COMPLETE — a project with STATE.md but no
    // ROADMAP.md at all resolves to SCOPE.UNREADABLE.
    test('update-progress phase-scope decline still discloses via stderr', () => {
      tmpDir = createFixture();
      writeState(tmpDir, '# Project State\n\n## Current Position\n\nPhase: 1\n');

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateUpdateProgress(tmpDir, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.updated, false);
      assert.strictEqual(out.reason, `phase scope is ${SCOPE.UNREADABLE}, not complete`);
      assert.match(stderr, /^\[gsd-tools\] WARNING: state update-progress skipped — phase scope is unreadable, not complete\./);
    });

    // Row 3: phase scope IS complete, but 0 plans exist in current-milestone phases.
    test('update-progress zero-plans decline still discloses via stderr', () => {
      tmpDir = createTempProject();
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
        '# Roadmap', '', '## v1.0 Current', '', '### Phase 1: Foo', '',
      ].join('\n'));
      // Phase directory exists (so the scan is a real COMPLETE scan) but has
      // zero plan files inside it.
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foo'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
        '---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '',
        '# Project State', '',
      ].join('\n'));

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateUpdateProgress(tmpDir, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.updated, false);
      assert.strictEqual(
        out.reason,
        'no plans found in current-milestone phases — STATE.md left unchanged (milestone archived?)',
      );
      assert.match(stderr, /^\[gsd-tools\] WARNING: state update-progress skipped — no plans found in current-milestone phases \(0 plans\)\./);
    });

    // Row 4: computeUpdateProgressPreview withholds (#1761). Mirrors the
    // already-proven fixture shape from the '#3583 follow-up' test above
    // (~line 2574): STATE.md has NO explicit `milestone:` frontmatter field
    // and ROADMAP.md has no `##` milestone heading wrapper — that absence is
    // exactly what lets the auto-derived scan at the top of
    // cmdStateUpdateProgress classify as SCOPE.COMPLETE ("free-form legacy
    // roadmap", #3583 finding 1) instead of UNSCOPED, so totalPlans > 0 and
    // the first two decline arms are passed. ROADMAP.md does mention a bare
    // version token ("v2.0") in body PROSE — not a heading, not a 🚧 bullet —
    // which getMilestoneInfo's bare-version-token fallback picks up as
    // `assertedMilestoneVersion`. buildStateFrontmatter's own #1761 guard
    // then finds no ROADMAP HEADING matching "v2.0" (isMilestoneBounded
    // requires a heading, not mere prose), so it nulls `progress.percent`
    // even though diskScope is COMPLETE — reaching exactly the THIRD decline
    // arm (computeUpdateProgressPreview.withheld), not the first
    // (phase-scope) or second (zero-plans) one. An earlier version of this
    // fixture used an explicit `milestone: v1.0` field with no matching
    // heading at all, which left the milestone UNSCOPED from the very first
    // arm instead of reaching this one.
    test('update-progress preview-withheld decline still discloses via stderr', () => {
      tmpDir = createTempProject();
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
        '# Roadmap',
        '',
        'Target release: v2.0',
        '',
        '### Phase 1: phase-1',
        '### Phase 2: phase-2',
        '',
      ].join('\n'));
      const phasesDir = path.join(tmpDir, '.planning', 'phases');
      for (let i = 1; i <= 2; i++) {
        const dir = path.join(phasesDir, String(i).padStart(2, '0'));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n');
        fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), '# Summary\n');
      }
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
        '---', 'gsd_state_version: 1.0', 'status: executing', '---', '',
        '# Project State', '', '**Progress:** [░░░░░░░░░░] 0%', '',
      ].join('\n'));

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateUpdateProgress(tmpDir, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.updated, false, `setup must reach the withheld arm; got ${stdout}`);
      assert.ok(out.reason, 'a withheld reason must be present');
      assert.match(stderr, new RegExp(`^\\[gsd-tools\\] WARNING: state update-progress skipped — ${escapeRegex(out.reason)}\\n$`));
    });
  });

  describe('cmdStateResolveBlocker', () => {
    let tmpDir;
    afterEach(() => { if (tmpDir) cleanup(tmpDir); });

    // Row 5
    test('resolve-blocker: no section reports section-not-found, not false success', () => {
      tmpDir = createFixture();
      const statePath = writeState(tmpDir, '# Project State\n\n## Session Continuity\n\n**Last session:** none\n');
      const before = fs.readFileSync(statePath, 'utf-8');

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateResolveBlocker(tmpDir, 'timeout', false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.resolved, false);
      assert.strictEqual(out.reason, 'no Blockers/Concerns section found in STATE.md');
      assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before, 'STATE.md must be unchanged');
      assert.match(stderr, /^\[gsd-tools\] WARNING: state resolve-blocker skipped — no Blockers\/Concerns section found in STATE\.md\./);
    });

    // Row 6 (signature D — the false-success this issue fixes)
    test('resolve-blocker: no matching bullet reports resolved:false, not a false success', () => {
      tmpDir = createFixture();
      const statePath = writeState(tmpDir, '# Project State\n\n### Blockers\n\n- Database connection timeout\n');
      const before = fs.readFileSync(statePath, 'utf-8');

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateResolveBlocker(tmpDir, 'nonexistent blocker', false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.resolved, false, 'must not be a false success');
      assert.strictEqual(out.reason, 'no blocker matching nonexistent blocker found in the Blockers section');
      assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before, 'STATE.md bytes must be unchanged');
      assert.match(stderr, /^\[gsd-tools\] WARNING: state resolve-blocker skipped — no blocker matching "nonexistent blocker" found in the Blockers section\./);
    });

    // Row 7 (boundary — case-insensitive match must still be preserved)
    test('resolve-blocker: case-insensitive match still resolves', () => {
      tmpDir = createFixture();
      const statePath = writeState(tmpDir, '# Project State\n\n### Blockers\n\n- Database Connection Timeout\n');

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateResolveBlocker(tmpDir, 'database connection timeout', false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.resolved, true);
      const after = fs.readFileSync(statePath, 'utf-8');
      assert.ok(!after.includes('Database Connection Timeout'), 'the matched blocker line must be removed');
      assert.strictEqual(stderr, '', 'a real resolve must not emit a decline disclosure');
    });
  });

  describe('cmdStateRecordSession', () => {
    let tmpDir;
    const originalNowIso = clockLib.realClock.nowIso;
    afterEach(() => {
      clockLib.realClock.nowIso = originalNowIso;
      if (tmpDir) cleanup(tmpDir);
    });

    // Row 8 — #4186 repurposed: the empty-options call that used to reach
    // the no-fields-found decline is now a usage error (handler-side guard,
    // same contract as cmdStateUpdate). The decline itself remains covered
    // for value-supplied calls by the matched-but-unchanged row below; what
    // this row now pins is that the SDK-level contract matches the CLI's and
    // that a rejected call never touches the file.
    test('record-session: no values supplied is a usage error, STATE.md unchanged (#4186)', () => {
      tmpDir = createFixture();
      const statePath = writeState(tmpDir, '# Project State\n\n## Decisions\n\n- none yet\n');
      const before = fs.readFileSync(statePath, 'utf-8');

      // error() writes the user-facing message to stderr and throws a bare
      // ExitError (v1: message 'process exit <code>' — the message itself is
      // NOT on the exception; asserted via the CLI-level tests above).
      assert.throws(
        () => stateLib.cmdStateRecordSession(tmpDir, {}, false),
        (err) => err && err.name === 'ExitError' && err.code === 1,
        'empty options must be rejected before any read or write',
      );
      assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before, 'STATE.md must be unchanged');
    });

    // Row 9 (hardest — signature B, collapsed reconciliation). A frozen clock
    // makes `now` match the ALREADY-ON-DISK `Last session` value, and the
    // supplied --stopped-at matches the already-on-disk `Stopped at` value
    // too, so the write is attempted (updated gets a pre-reconciliation
    // push) but reconciliation finds no bytes actually changed.
    test('record-session: matched-but-unchanged distinguished from nothing-found', () => {
      const FIXED_NOW = '2024-01-01T00:00:00.000Z';
      clockLib.realClock.nowIso = () => FIXED_NOW;
      tmpDir = createFixture();
      const statePath = writeState(tmpDir, [
        '# Project State', '',
        '## Session', '',
        `**Last session:** ${FIXED_NOW}`,
        '**Stopped at:** Phase 2 Plan 1 complete',
        '**Resume file:** None',
        '',
      ].join('\n'));
      const before = fs.readFileSync(statePath, 'utf-8');

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateRecordSession(tmpDir, { stopped_at: 'Phase 2 Plan 1 complete' }, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.recorded, false, `setup must reach the matched-but-unchanged arm; got ${stdout}`);
      assert.strictEqual(
        out.reason,
        'the matched session field(s) already held the reported value — no bytes changed',
      );
      assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), before, 'STATE.md bytes must be unchanged');
      assert.match(stderr, /^\[gsd-tools\] WARNING: state record-session skipped — the matched session field\(s\) already held the reported value; no bytes changed\./);
    });

    // Row 10 (pre-existing coverage; verify the split above did not break
    // the common, correct fast path — a real change still reports recorded:true).
    test('record-session: real change still reports recorded:true', () => {
      const FIXED_NOW = '2024-01-01T00:00:00.000Z';
      clockLib.realClock.nowIso = () => FIXED_NOW;
      tmpDir = createFixture();
      writeState(tmpDir, [
        '# Project State', '',
        '## Session', '',
        '**Last session:** 2023-01-01T00:00:00.000Z',
        '**Stopped at:** None',
        '**Resume file:** None',
        '',
      ].join('\n'));

      const { stdout, stderr } = captureCliIO(() => {
        stateLib.cmdStateRecordSession(tmpDir, { stopped_at: 'Phase 3 Plan 1 complete' }, false);
      });

      const out = JSON.parse(stdout);
      assert.strictEqual(out.recorded, true);
      assert.ok(Array.isArray(out.updated) && out.updated.length > 0, 'updated list must be populated');
      assert.strictEqual(stderr, '', 'a real change must not emit a decline disclosure');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// #4138: `state begin-phase` writes a null-phase STATE.md when the required
// --phase argument is missing (.gsd/bug/fix-4138-begin-phase-arg-validation/
// {10-diagnosis,50-test-matrix}.md). The verb's token validation rejects an
// unexpected positional but lets a MISSING --phase through as null, which the
// transition then serialises as the literal string "null" into three body
// locations while the post-sync frontmatter rebuild drops current_phase /
// current_phase_name entirely. The contract under test is the issue's Expected:
// exit non-zero with a usage message and write nothing.
// ═════════════════════════════════════════════════════════════════════════

describe('#4138: state begin-phase guards its required --phase argument', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The issue's clean shape: a milestone-bound ROADMAP, phase dirs on disk
  // (1-2 verification-passed), and a STATE.md whose progress block already
  // carries the correct counters — the exact state a null-phase write or a
  // counter zeroing would destroy.
  function seedBoundedProject() {
    const roadmap = [
      '# Roadmap',
      '',
      '## Milestone v1.0: Test Milestone',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 1.    | 1/1            | Complete | 2026-01-01 |',
      '| 2.    | 1/1            | Complete | 2026-01-02 |',
      '| 3.    | 0/1            | Not Started |  |',
      '| 4.    | 0/1            | Not Started |  |',
      '',
      '### Phase 1: Alpha',
      '**Goal:** first',
      '',
      '### Phase 2: Beta',
      '**Goal:** second',
      '',
      '### Phase 3: Gamma',
      '**Goal:** third',
      '',
      '### Phase 4: Delta',
      '**Goal:** fourth',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    ['01-alpha', '02-beta', '03-gamma', '04-delta'].forEach((dirName, idx) => {
      const n = idx + 1;
      const padded = String(n).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dirName);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan\n');
      if (n <= 2) {
        fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary\n');
        writePassedVerification(tmpDir, dirName, padded);
      }
    });
    writeState(
      tmpDir,
      [
        '---',
        "gsd_state_version: '1.0'",
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: executing',
        'current_phase: 2',
        'current_phase_name: Beta',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 2',
        '  total_plans: 4',
        '  completed_plans: 2',
        '  percent: 50',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 2 (Beta) — COMPLETE',
        'Plan: 1 of 1',
        'Status: Phase 2 complete',
        'Last activity: 2026-01-02 — Phase 2 execution complete',
        '',
        '## Progress',
        '',
        'Progress: [█████▓▓▓▓▓] 50% (2/4 phases complete)',
        '',
        '## Session Continuity',
        '',
        'Last session: 2026-01-02T10:00:00.000Z',
        '',
      ].join('\n'),
    );
    return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
  }

  // #4138 row 1 — the failing-first regression. A begin-phase that names no
  // phase must exit non-zero with a usage message and leave STATE.md
  // byte-identical: no "Phase null" prose, no current_phase removal, no
  // state.json publication, no milestone claim for the literal phase "null".
  test('beginPhaseWithoutPhaseFailsClosedAndWritesNothing', () => {
    const before = seedBoundedProject();
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');

    const result = runGsdTools(['state', 'begin-phase'], tmpDir);

    assert.strictEqual(result.success, false, '#4138: a missing --phase must fail the command');
    assert.notStrictEqual(result.exitCode, 0, '#4138: a usage error must exit non-zero');
    assert.match(result.error, /--phase/, `the usage message must name the required flag; got: ${result.error}`);
    assert.strictEqual(
      fs.readFileSync(statePath, 'utf8'),
      before,
      '#4138: an invalid invocation must not write STATE.md (no null-phase serialisation, no current_phase removal)',
    );
    assert.strictEqual(
      fs.existsSync(path.join(tmpDir, '.planning', 'state.json')),
      false,
      '#4138: an invalid invocation must not publish the state contract',
    );

    // Row 12: no milestone claim leaked for the literal phase "null" — the
    // next VALID begin-phase must report no conflict (#3311 claim point).
    const valid = runGsdTools(['state', 'begin-phase', '--phase', '3', '--name', 'gamma'], tmpDir);
    assert.ok(valid.success, `follow-up valid begin-phase failed: ${valid.error}`);
    const validOut = JSON.parse(valid.output);
    assert.strictEqual(validOut.milestone_conflict, null, '#4138: the errored call must not have claimed phase "null"');
  });

  // #4138 row 2 — a flag-shaped `--phase` value resolves to null in
  // parseNamedArgs (command-arg-projection.cjs: "a value flag whose next token
  // is absent or starts with `--` yields null"); the guard must catch it the
  // same way as an absent flag.
  test('beginPhaseFlagShapedPhaseValueFailsClosed', () => {
    const before = seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', '--name', 'gamma'], tmpDir);

    assert.strictEqual(result.success, false, '#4138: a flag-shaped --phase value is a missing phase');
    assert.notStrictEqual(result.exitCode, 0, '#4138: usage error must exit non-zero');
    assert.match(result.error, /--phase/, `the usage message must name the required flag; got: ${result.error}`);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
      before,
      '#4138: STATE.md must stay byte-identical',
    );
  });

  // #4138 row 3 — empty string. CONTRIBUTING's CLI matrix requires `--phase ""`
  // as a distinct negative case; pre-fix it wrote `Status: Executing Phase `
  // (trailing space) and claimed the empty phase.
  test('beginPhaseEmptyPhaseValueFailsClosed', () => {
    const before = seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', ''], tmpDir);

    assert.strictEqual(result.success, false, '#4138: an empty --phase is a missing phase');
    assert.notStrictEqual(result.exitCode, 0, '#4138: usage error must exit non-zero');
    assert.match(result.error, /--phase/, `the usage message must name the required flag; got: ${result.error}`);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
      before,
      '#4138: STATE.md must stay byte-identical',
    );
  });

  // #4138 row 4 — whitespace-only value is the same missing argument.
  test('beginPhaseWhitespacePhaseValueFailsClosed', () => {
    const before = seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', '   '], tmpDir);

    assert.strictEqual(result.success, false, '#4138: a whitespace-only --phase is a missing phase');
    assert.notStrictEqual(result.exitCode, 0, '#4138: usage error must exit non-zero');
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
      before,
      '#4138: STATE.md must stay byte-identical',
    );
  });

  // #4138 row 5 (not-the-bug pin): --name is OPTIONAL. A begin-phase that
  // names a phase but no slug must keep succeeding exactly as today — the
  // issue's Expected guards only the no-PHASE direction.
  test('beginPhaseWithoutNameStillSucceeds', () => {
    seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', '3'], tmpDir);

    assert.ok(result.success, `begin-phase --phase 3 must succeed without --name: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.phase, '3');
    assert.strictEqual(out.phase_name, null, 'no --name means a null name, which is legitimate');
    const fm = frontmatterLib.extractFrontmatter(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
    );
    assert.strictEqual(String(fm.current_phase), '3', 'phase identity must land in frontmatter');
  });

  // #4138 row 6 (boundary, not-the-bug pin): the FIRST legitimate phase of a
  // fresh milestone must keep initializing STATE.md exactly as today — zero
  // counters on a first-phase begin are legitimate, and the guard must not
  // have made the verb refuse its own happy path.
  test('beginPhaseFirstLegitimatePhaseStillInitializes', () => {
    seedBoundedProject();
    // Reset to a fresh-milestone STATE.md: no completed phases, phase 1 beginning.
    writeState(
      tmpDir,
      [
        '---',
        "gsd_state_version: '1.0'",
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: planning',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 0',
        '  total_plans: 4',
        '  completed_plans: 0',
        '  percent: 0',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 1 (Alpha) — READY TO EXECUTE',
        'Plan: 0 of ?',
        'Status: Ready to execute Phase 1',
        'Last activity: 2026-01-01 — roadmap created',
        '',
      ].join('\n'),
    );

    const result = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'alpha', '--plans', '1'], tmpDir);

    assert.ok(result.success, `first-phase begin must succeed: ${result.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    const fm = frontmatterLib.extractFrontmatter(after);
    assert.strictEqual(String(fm.current_phase), '1', 'current_phase must be initialized');
    assert.strictEqual(fm.status, 'executing', 'status must flip to executing');
    assert.strictEqual(fm.last_activity_desc, 'Phase 1 execution started');
    const position = stateDocument.stateExtractField(after, 'Phase');
    assert.match(position ?? '', /^1 \(alpha\) — EXECUTING/, `Current Position Phase line must carry the phase identity; got: ${position}`);
  });

  // #4138 row 7 (Defect 2 pin): a CORRECT invocation must never zero
  // progress.completed_phases / progress.percent — the issue's table shows
  // 5/33 becoming 0/0 on gsd-core 1.12.0. On next the #4359 write-path
  // ratchet keeps the curated completed counters; this row pins that contract
  // on the begin-phase verb so the zeroing class cannot return unnoticed.
  test('beginPhasePreservesSuppliedCompletedPhasesAndPercent', () => {
    seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--name', 'gamma'], tmpDir);

    assert.ok(result.success, `begin-phase failed: ${result.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    const fm = frontmatterLib.extractFrontmatter(after);
    assert.ok(fm.progress, 'progress block must survive the write');
    assert.strictEqual(
      Number(fm.progress.completed_phases),
      2,
      `#4138: completed_phases must stay at the stored 2 (phases 1-2 verification-passed), got ${fm.progress.completed_phases}`,
    );
    assert.strictEqual(
      Number(fm.progress.percent),
      50,
      `#4138: percent must stay coherent with the preserved counters (2/4), got ${fm.progress.percent}`,
    );
    assert.strictEqual(String(fm.current_phase), '3', 'the begun phase must land in frontmatter');
  });

  // #4138 row 8 (Defect 2 pin, resume variant): the #3127 resume branch must
  // preserve the counters identically — a wave-continue begin is still an
  // ordinary correct usage.
  test('beginPhaseResumePreservesSuppliedCounters', () => {
    seedBoundedProject();
    // Body already executing phase 3 → the #3127 resume branch fires.
    writeState(
      tmpDir,
      [
        '---',
        "gsd_state_version: '1.0'",
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: executing',
        'current_phase: 3',
        'current_phase_name: Gamma',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 2',
        '  total_plans: 4',
        '  completed_plans: 2',
        '  percent: 50',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 3 (Gamma) — EXECUTING',
        'Plan: 1 of 1',
        'Status: Executing Phase 3',
        'Last activity: 2026-01-02 — Phase 3 execution started',
        '',
      ].join('\n'),
    );

    const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--name', 'gamma'], tmpDir);

    assert.ok(result.success, `resume begin-phase failed: ${result.error}`);
    const fm = frontmatterLib.extractFrontmatter(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
    );
    assert.strictEqual(Number(fm.progress.completed_phases), 2, '#4138: resume must not zero completed_phases');
    assert.strictEqual(Number(fm.progress.percent), 50, '#4138: resume must not zero percent');
  });

  // #4138 row 9 (existing-guard pin): the sibling --plans validation already
  // exits non-zero without writing; pinned so the two required-argument
  // guards stay symmetric.
  test('beginPhaseNonNumericPlansStillFailsClosed', () => {
    const before = seedBoundedProject();

    const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--plans', 'abc'], tmpDir);

    assert.strictEqual(result.success, false, 'a non-numeric --plans must fail the command');
    assert.notStrictEqual(result.exitCode, 0, 'usage error must exit non-zero');
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8'),
      before,
      'STATE.md must stay byte-identical',
    );
  });
});
