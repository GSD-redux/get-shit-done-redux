// allow-test-rule: source-text-is-the-product — see #3409
// Workflow markdown is the installed orchestration contract; the snippets
// below are extracted from the shipped .md files and EXECUTED (not
// re-typed), so the test binds to the deployed contract rather than a copy
// that could silently drift from it.

'use strict';

/**
 * Failing-first regression tests for #3409 (design:
 * .gsd/phase/feat-3409-unreachable-shell-guard-lint/40-design.md; matrix:
 * .gsd/phase/feat-3409-unreachable-shell-guard-lint/50-test-matrix.md,
 * section "Regression — the three defects this PR fixes", rows G1-G4).
 *
 * Root cause (40-design.md): `gsd-tools.cjs`'s `--pick <field>` extractor
 * coerces a missing/absent field to the empty string and exits 0. So
 * `X=$(gsd_run query V --pick F 2>/dev/null || echo D)` can NEVER reach its
 * `|| echo D` arm on field absence — only on a typo in the verb name. Three
 * shipped shell guards silently rely on that unreachable arm:
 *
 *   G1/G2 — plan-phase.md's Walking Skeleton gate reads a
 *           `phases.list --pick summaries_total` field that does not exist
 *           (#3365), so `PRIOR_SUMMARIES` is always `""`, never `"0"`, and
 *           the gate can never fire — not even for a genuinely fresh
 *           project (G1). G2 is the load-bearing negative-space case: it
 *           proves a bad fix that merely treats "no answer" as "zero"
 *           (making the gate fire unconditionally) is rejected, by pinning
 *           BOTH that the resolved count is a real nonzero integer AND that
 *           the gate stays off.
 *   G3     — plan-phase.md's `PHASE_REQ_IDS` site: on a phase with zero
 *            requirements, `query init.plan-phase <N> --pick phase_req_ids`
 *            exits 0 with empty stdout, so `|| echo TBD` never fires and
 *            `PHASE_REQ_IDS` resolves to `""` instead of the documented
 *            `TBD` sentinel (gate step reads "Skip if phase_req_ids is null
 *            or TBD").
 *   G4     — complete-milestone.md's bare `cat` over an unmatched-capable
 *            SUMMARY.md glob: under a `nullglob`
 *            left set by an earlier block in the SAME shell session (the
 *            `extract_accomplishments` step, a few hundred lines earlier in
 *            this same file), an unmatched glob expands to zero operands,
 *            so `cat` reads from stdin instead of erroring — and blocks
 *            forever if that stdin is not already at EOF.
 *
 * Each test below extracts the LIVE fenced-bash / single-line snippet out of
 * the shipped workflow markdown (never a hand-typed copy — see
 * `extractFencedBashAfterAnchor` / `extractLineStartingWith`) and executes it
 * with `runHook(..., { interpreter: 'bash' })`
 * (`tests/helpers/process-seam.cjs`), against a temp project fixture, driving
 * the real CLI at `gsd-core/bin/gsd-tools.cjs` through the real `gsd_run`
 * shell function sourced from the shipped
 * `gsd-core/workflows/_runtime-launcher.snippet.sh` preamble.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, readWorkflowCombined } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const COMPLETE_MILESTONE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'complete-milestone.md');
const LAUNCHER_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');
const GSD_TOOLS_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// A `cat`-under-blocked-stdin hang (G4) must be bounded well under this, but
// give the CI-shape headroom PROBE_TIMEOUT_MS documents for a short CLI call.
const G4_TIMEOUT_MS = 5000; // short and explicit per the test-matrix note (G4 must assert on
// `outcome`, never `signal` — a real timeout and a maxBuffer overflow both
// report SIGTERM; PROBE_TIMEOUT_MS (15000ms) would work too but a tight,
// named bound makes a genuine hang fail fast instead of eating the suite's
// time budget on every RED run.

// ─── extraction (source-text-is-the-product) ─────────────────────────────

/**
 * Extract the first ```bash fence appearing AFTER `anchor` in `content`.
 * Mirrors the extraction convention already established by
 * tests/plan-phase-stall-detection.test.cjs's extractStallHelpersBash(): walk
 * forward from the anchor to the next fence open, then to its close. Throws
 * with a message naming the anchor and file so a relocated/renamed anchor
 * fails loudly instead of silently extracting the wrong block.
 */
function extractFencedBashAfterAnchor(content, anchor, sourcePath) {
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`extractFencedBashAfterAnchor: could not find anchor "${anchor}" in ${sourcePath}`);
  }
  const after = content.slice(anchorIdx);
  const fenceOpen = after.match(/```bash\r?\n/);
  if (!fenceOpen) {
    throw new Error(`extractFencedBashAfterAnchor: no \`\`\`bash fence found after anchor "${anchor}" in ${sourcePath}`);
  }
  const bodyStart = anchorIdx + fenceOpen.index + fenceOpen[0].length;
  const closeIdx = content.indexOf('```', bodyStart);
  if (closeIdx === -1) {
    throw new Error(`extractFencedBashAfterAnchor: unterminated \`\`\`bash fence after anchor "${anchor}" in ${sourcePath}`);
  }
  return content.slice(bodyStart, closeIdx);
}

/**
 * Extract the single source line beginning with `prefix` (e.g.
 * `PHASE_REQ_IDS=`). Throws with a message naming the prefix and file if the
 * line is not found, so a rename/relocation fails loudly rather than
 * silently testing nothing.
 */
function extractLineStartingWith(content, prefix, sourcePath) {
  const re = new RegExp(`^${escapeRegex(prefix)}.*$`, 'm');
  const match = content.match(re);
  if (!match) {
    throw new Error(`extractLineStartingWith: no line starting with "${prefix}" found in ${sourcePath}`);
  }
  return match[0];
}

// ─── shared bash-script runner ────────────────────────────────────────────

/**
 * Write `script` to a fresh temp file and run it via the process seam's
 * `runHook(..., { interpreter: 'bash' })` — a script PATH, not a `bash -c`
 * argv string, matching tests/plan-phase-stall-detection.test.cjs's
 * runBashScript() (#2650: a quote-dense multi-line script passed as a single
 * `-c` argv element does not survive Windows argv serialization).
 *
 * @param {import('node:test').TestContext} t
 * @param {string} script - full script body (a shebang + `set -e` are
 *   prepended).
 * @param {object} [options] - forwarded to runHook (cwd, env, timeoutMs).
 */
function runBashScript(t, script, options = {}) {
  const scriptDir = createTempDir('gsd-3409-sh-');
  t.after(() => cleanup(scriptDir));
  const scriptPath = path.join(scriptDir, 'script.sh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -e\n${script}`, { mode: 0o755 });
  return runHook(scriptPath, [], { interpreter: 'bash', ...options });
}

/**
 * Parse `KEY=value` lines (one per line, as emitted by this file's own
 * `echo "KEY=$VAR"` trailers) out of a script's stdout. Values may
 * legitimately be the empty string (that IS the RED condition G1/G2/G3
 * assert against), so this returns `''` rather than `undefined` when the key
 * is present with nothing after `=`.
 */
function parseKeyValueStdout(stdout) {
  const result = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1).replace(/\r$/, '');
  }
  return result;
}

// ─── fixtures ──────────────────────────────────────────────────────────────

/**
 * A minimal `.planning/phases/01-foundation/` project fixture — enough for
 * `phases.list` and `init.plan-phase` to resolve phase 01 without error.
 * `withSummary` seeds one real `*-SUMMARY.md` file when the negative-space
 * (G2) case needs a nonzero prior-summary count.
 */
function buildPhase01Fixture({ withSummary }) {
  const root = createTempDir('gsd-3409-fixture-');
  const phaseDir = path.join(root, '.planning', 'phases', '01-foundation');
  fs.mkdirSync(phaseDir, { recursive: true });
  if (withSummary) {
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n\nDone.\n');
  }
  return root;
}

// ─── G1 / G2 — Walking Skeleton gate (plan-phase.md, #3365) ───────────────

describe('#3409 G1/G2 — plan-phase.md Walking Skeleton gate observes a real summary count', () => {
  const anchor = 'Walking Skeleton gate.';

  function runWalkingSkeletonGate(t, projectRoot) {
    const snippet = extractFencedBashAfterAnchor(
      readWorkflowCombined(PLAN_PHASE_PATH),
      anchor,
      PLAN_PHASE_PATH,
    );
    const script = [
      `. "${LAUNCHER_PATH}"`,
      snippet,
      'echo "GSD_TEST_WALKING_SKELETON=$WALKING_SKELETON"',
      'echo "GSD_TEST_PRIOR_SUMMARIES=$PRIOR_SUMMARIES"',
    ].join('\n');
    const result = runBashScript(t, script, {
      cwd: projectRoot,
      env: {
        ...process.env,
        RUNTIME_DIR: REPO_ROOT,
        MVP_MODE: 'true',
        padded_phase: '01',
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.equal(result.outcome, OUTCOME.EXITED, `gate script did not exit cleanly: ${result.stderr}`);
    assert.equal(result.exitCode, 0, `gate script exited non-zero: ${result.stderr}`);
    return parseKeyValueStdout(result.stdout);
  }

  test('G1: zero prior summaries — the gate observes a real integer 0, and fires', (t) => {
    const root = buildPhase01Fixture({ withSummary: false });
    t.after(() => cleanup(root));
    const { GSD_TEST_WALKING_SKELETON, GSD_TEST_PRIOR_SUMMARIES } = runWalkingSkeletonGate(t, root);

    // RED on the current tree: `--pick summaries_total` names a field that
    // does not exist, so gsd-tools exits 0 with EMPTY stdout and the
    // unreachable `|| echo "0"` arm never fires — PRIOR_SUMMARIES is `""`,
    // not the integer `"0"` this asserts.
    assert.equal(GSD_TEST_PRIOR_SUMMARIES, '0', 'prior-summary count must resolve to the integer 0, not empty string');
    assert.equal(GSD_TEST_WALKING_SKELETON, 'true', 'a fresh phase-01 project must enter Walking Skeleton mode');
  });

  test('G2 (load-bearing negative space): a project WITH prior summaries does not enter skeleton mode', (t) => {
    const root = buildPhase01Fixture({ withSummary: true });
    t.after(() => cleanup(root));
    const { GSD_TEST_WALKING_SKELETON, GSD_TEST_PRIOR_SUMMARIES } = runWalkingSkeletonGate(t, root);

    // RED on the current tree: PRIOR_SUMMARIES is `""` here too (same
    // unreachable-arm defect), which fails this integer check even though
    // WALKING_SKELETON happens to read 'false' on the current, doubly-broken
    // gate (it never fires for ANY input). This is what rejects a bad fix
    // that treats "no answer" as "zero": such a fix would make
    // WALKING_SKELETON fire unconditionally, which the second assertion
    // below also catches.
    assert.match(
      GSD_TEST_PRIOR_SUMMARIES,
      /^[1-9][0-9]*$/,
      `prior-summary count must resolve to a nonzero integer, got ${JSON.stringify(GSD_TEST_PRIOR_SUMMARIES)}`,
    );
    assert.equal(GSD_TEST_WALKING_SKELETON, 'false', 'a project with prior summaries must NOT enter Walking Skeleton mode');
  });
});

// ─── G3 — PHASE_REQ_IDS falls back to TBD (plan-phase.md) ─────────────────

test('#3409 G3: an empty phase_req_ids falls back to TBD, not the empty string', (t) => {
  const root = createTempDir('gsd-3409-g3-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, '.planning', 'phases', '01-foundation'), { recursive: true });
  // Deliberately no REQUIREMENTS.md / ROADMAP.md — phase 01 with zero
  // requirements mapped to it, so `init.plan-phase --pick phase_req_ids`
  // resolves `phase_req_ids: null` and `--pick` renders that as empty stdout
  // (probe-confirmed: exit 0, empty stdout).

  const line = extractLineStartingWith(
    readWorkflowCombined(PLAN_PHASE_PATH),
    'PHASE_REQ_IDS=',
    PLAN_PHASE_PATH,
  );
  const script = [
    `. "${LAUNCHER_PATH}"`,
    line,
    'echo "GSD_TEST_PHASE_REQ_IDS=$PHASE_REQ_IDS"',
  ].join('\n');
  const result = runBashScript(t, script, {
    cwd: root,
    env: { ...process.env, RUNTIME_DIR: REPO_ROOT, PHASE: '01' },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(result.outcome, OUTCOME.EXITED, `PHASE_REQ_IDS script did not exit cleanly: ${result.stderr}`);
  assert.equal(result.exitCode, 0, `PHASE_REQ_IDS script exited non-zero: ${result.stderr}`);

  const { GSD_TEST_PHASE_REQ_IDS } = parseKeyValueStdout(result.stdout);
  // RED on the current tree: `--pick phase_req_ids` exits 0 with empty
  // stdout on a `null` field, so the unreachable `|| echo TBD` arm never
  // fires and PHASE_REQ_IDS resolves to `""` instead of the documented
  // `TBD` sentinel (plan-phase.md: "Skip if phase_req_ids is null or TBD").
  assert.equal(GSD_TEST_PHASE_REQ_IDS, 'TBD');
});

// ─── G4 — complete-milestone.md bare `cat <glob>` does not block on stdin ──

test('#3409 G4: the milestone summary read does not hang with no summaries', (t) => {
  // The blocked-stdin mechanism below is a read-write FIFO opened via
  // `mkfifo` — POSIX-only, and unavailable/non-functional on the
  // `windows-latest` CI lane. Under `set -e` an unsupported `mkfifo` fails
  // the script during setup, before the `cat` under test ever runs, so a
  // Windows run would exercise nothing and must be skipped, not weakened.
  if (process.platform === 'win32') {
    t.skip('mkfifo-blocked-stdin reproduction is POSIX-only; unreachable on Windows');
    return;
  }

  const root = createTempDir('gsd-3409-g4-');
  t.after(() => cleanup(root));
  // Zero-summary milestone: a phase dir exists, but no *-SUMMARY.md file
  // anywhere under it — the exact condition that makes the glob unmatched.
  fs.mkdirSync(path.join(root, '.planning', 'phases', '01-foundation'), { recursive: true });

  const snippet = extractFencedBashAfterAnchor(
    readWorkflowCombined(COMPLETE_MILESTONE_PATH),
    'Read all phase summaries:',
    COMPLETE_MILESTONE_PATH,
  );

  // Two things this script must reproduce, both faithfully, neither
  // confounded with the other:
  //
  //  1. `nullglob` set — not by this fenced block itself (it sets nothing),
  //     but by an EARLIER block in the SAME workflow file/shell session
  //     (`extract_accomplishments`'s `shopt -s nullglob`, a few hundred
  //     lines above this one). 40-design.md's B11 names this exact
  //     "latent option from a different block" hazard as why Detector B
  //     flags this site even though it never sets the option locally.
  //  2. stdin genuinely blocked, not just closed. Node's spawnSync closes
  //     an unwritten stdin immediately (EOF) when no `input` option is
  //     given, which would make a zero-operand `cat` return instantly
  //     instead of reproducing the real hang — so this opens a FIFO
  //     read-write on fd 3 (a read-write open never sees EOF, because the
  //     process holds its own write end) and redirects fd 0 there. This
  //     avoids `<(process substitution)`, which would leave a background
  //     job holding the CAPTURED STDOUT pipe open instead — a different,
  //     confounding hang unrelated to the stdin defect under test.
  const script = [
    'shopt -s nullglob',
    'FIFO=$(mktemp -u)',
    'mkfifo "$FIFO"',
    'exec 3<> "$FIFO"',
    'rm -f "$FIFO"',
    'exec 0<&3',
    snippet,
  ].join('\n');

  const result = runBashScript(t, script, { cwd: root, timeoutMs: G4_TIMEOUT_MS });

  // RED on the current tree: the bare `cat <glob>` reads from the blocked
  // stdin and never returns within G4_TIMEOUT_MS, so `outcome` is
  // TIMED_OUT. Asserting on `outcome` (never `signal`) per CONTRIBUTING.md's
  // process-seam guidance — a timeout and a maxBuffer overflow both report
  // SIGTERM, and only `outcome` discriminates them.
  assert.equal(
    result.outcome,
    OUTCOME.EXITED,
    `expected the summary read to complete, got outcome=${result.outcome} stderr=${result.stderr}`,
  );
  // A nonzero exit here means the script's own setup (mkfifo/exec/mktemp)
  // failed under `set -e` and the process exited immediately — which also
  // reports outcome=EXITED, so it would silently pass the assertion above
  // without ever reaching the `cat` under test. Pinning exitCode===0
  // distinguishes "setup failed" from "the blocked read actually completed".
  assert.equal(
    result.exitCode,
    0,
    `expected setup (mkfifo/exec/mktemp) to succeed and the read to complete cleanly, got exitCode=${result.exitCode} stderr=${result.stderr}`,
  );
});

// Sanity: the module under test actually exists at the path every fixture
// above points `RUNTIME_DIR`/`gsd_run` at — a moved/renamed CLI would
// otherwise make every test above fail with a confusing "gsd-tools.cjs not
// found" error deep inside a bash script instead of a clear assertion here.
test('#3409: gsd-tools.cjs exists at the path this suite drives gsd_run through', () => {
  assert.equal(fs.existsSync(GSD_TOOLS_PATH), true, `expected ${GSD_TOOLS_PATH} to exist`);
});
