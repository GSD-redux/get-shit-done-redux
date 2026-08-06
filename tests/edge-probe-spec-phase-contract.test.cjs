// allow-test-rule: source-text-is-the-product
// spec-phase.md Step 5.5 is the deployed workflow runtime contract under assertion
// spec-phase.md is the deployed spec workflow contract; these checks lock
// the Step 5.5 wiring so the edge-probe.cjs runtime invocation cannot
// silently rot the way the original plan-phase no-op did (reviewer finding RR-11).
// Assertions scope to the extracted Step 5.5 block to avoid false positives
// from incidental mentions elsewhere in the file.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'spec-phase.md');

function readSpecPhase() {
  return fs.readFileSync(SPEC_PHASE_PATH, 'utf8');
}

// Slice the Step 5.5 block: from the "Step 5.5" heading to the next "## " or "Step " heading.
// This scopes assertions to Step 5.5 only, preventing false positives from mentions elsewhere.
function extractStep55Block(content) {
  const startIdx = content.indexOf('## Step 5.5');
  if (startIdx === -1) {
    // Also try without the ## prefix
    const altIdx = content.indexOf('Step 5.5');
    if (altIdx === -1) return '';
    // Find end: next heading starting with ## or Step N (not Step 5.5)
    const rest = content.slice(altIdx + 'Step 5.5'.length);
    const nextHeading = rest.search(/\n## |\nStep \d/);
    if (nextHeading === -1) return content.slice(altIdx);
    return content.slice(altIdx, altIdx + 'Step 5.5'.length + nextHeading);
  }
  const rest = content.slice(startIdx + '## Step 5.5'.length);
  const nextHeading = rest.search(/\n## /);
  if (nextHeading === -1) return content.slice(startIdx);
  return content.slice(startIdx, startIdx + '## Step 5.5'.length + nextHeading);
}

// Test A (RR-11): Step 5.5 resolves and invokes edge-probe.cjs via node.
// MUST FAIL before the RR-04 wire (Step 5.5 is prose-only today — no CLI invocation).
test('RR-11: spec-phase Step 5.5 resolves edge-probe.cjs via path-fallback loop', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);

  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Assert the path-fallback resolution loop for edge-probe.cjs is present in Step 5.5.
  // The token "edge-probe.cjs" must appear inside the block (the artifact being resolved).
  assert.match(
    block,
    /edge-probe\.cjs/,
    'Step 5.5 must reference edge-probe.cjs as the artifact being resolved'
  );

  // Assert node invocation of edge-probe.cjs in Step 5.5.
  // Matches: node "$EDGE_PROBE_JS" or node ... edge-probe.cjs
  assert.match(
    block,
    /node\s+["$].*[Ee][Dd][Gg][Ee][-_][Pp][Rr][Oo][Bb][Ee]/,
    'Step 5.5 must invoke edge-probe.cjs via node (e.g. node "$EDGE_PROBE_JS" ...)'
  );
});

// Test C (RR-11 FUNCTION — the assertion that catches "decorative bash"):
// Token presence is not enough. The invocation is a no-op unless $REQS_JSON is actually
// POPULATED before the engine runs (the original block only mktemp'd it + left a comment,
// so the CLI parsed an empty file). Assert the block (a) writes $REQS_JSON via a redirect,
// (b) does so BEFORE the node invocation, and (c) guards against an empty/invalid file.
test('RR-11 function: Step 5.5 writes $REQS_JSON before invoking, and guards against empty input', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // (a) A redirect that writes the requirements into $REQS_JSON (e.g. `cat > "$REQS_JSON"`).
  const writeIdx = block.search(/>\s*"\$REQS_JSON"/);
  assert.ok(
    writeIdx !== -1,
    'Step 5.5 must WRITE requirements into $REQS_JSON (a redirect like `cat > "$REQS_JSON"`), not just mktemp it — an empty file makes the probe a silent no-op'
  );

  // (b) The write must precede the node invocation of the engine.
  const invokeIdx = block.search(/node\s+["$].*[Ee][Dd][Gg][Ee][-_][Pp][Rr][Oo][Bb][Ee]/);
  assert.ok(invokeIdx !== -1, 'Step 5.5 must invoke the engine via node');
  assert.ok(
    writeIdx < invokeIdx,
    'Step 5.5 must populate $REQS_JSON BEFORE invoking edge-probe.cjs (write precedes the node call)'
  );

  // (c) A guard that refuses to run on an empty/invalid requirements array.
  assert.match(
    block,
    /Array\.isArray|empty\/invalid|empty or invalid|REQS_JSON[^\n]*empty/i,
    'Step 5.5 must guard against an empty/invalid $REQS_JSON before invoking (fail loud, not silent no-op)'
  );
});

// Test B (RR-11): Step 5.5 has an explicit not-found branch — build:lib or error token.
// MUST FAIL before the RR-04 wire (no not-found handling today).
test('RR-11: spec-phase Step 5.5 has an explicit not-found branch (build:lib or blocking error)', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);

  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Assert either a build:lib invocation or an explicit "not found" / error message exists.
  // This prevents the wire from being added as a silent-skip with no fallback.
  assert.match(
    block,
    /build:lib|not found|ERROR.*edge-probe|edge-probe.*not found/i,
    'Step 5.5 must have an explicit not-found branch (build:lib attempt or clear blocking error)'
  );
});

// Test D (review High): the build fallback must NEVER run the CONSUMING project's package
// scripts. Every executable `build:lib` invocation must be pinned to the GSD dir with
// `npm --prefix`, and the build must be gated behind a verified GSD source checkout. A bare
// `npm run build:lib` (no --prefix) uses cwd — which, under the git-toplevel fallback, is the
// consumer repo — and would execute its codegen/migrations during a spec workflow.
test('review High: Step 5.5 build:lib is --prefix-pinned to the GSD dir and gated on a source checkout', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Collect lines that actually INVOKE npm (trimmed start === "npm"), excluding echo/comment
  // mentions (e.g. the error message that quotes `npm run build:lib` for the user).
  const buildInvocations = block
    .split('\n')
    .filter((l) => l.trim().startsWith('npm') && l.includes('build:lib'));

  assert.ok(
    buildInvocations.length > 0,
    'Step 5.5 must contain at least one npm build:lib invocation (the dev-checkout fallback)'
  );
  for (const line of buildInvocations) {
    assert.match(
      line,
      /npm\s+--prefix\s+"?\$?\{?_?GSD_RT/,
      `build:lib must be pinned with \`npm --prefix "$_GSD_RT"\` so it never runs the consuming project's scripts — offending line: ${line.trim()}`
    );
  }

  // The build must be gated behind a verified GSD source checkout (tsconfig.build.json present),
  // so it cannot fire inside a plain consumer repo where the artifact merely happens to be absent.
  assert.match(
    block,
    /tsconfig\.build\.json/,
    'Step 5.5 must gate the build behind a GSD source checkout (e.g. test -f "$_GSD_RT/tsconfig.build.json")'
  );
});

// Test E (review #4 High): the engine's fail-closed exit(2) must NOT be swallowed by command
// substitution. A bare `COVERAGE=$(node "$EDGE_PROBE_JS" ...)` discards the exit status, leaves
// $COVERAGE empty on an invalid-shapes failure, and lets the workflow proceed into prose
// re-derivation — fail-OPEN at the very boundary the engine validation exists to protect.
test('review #4 High: Step 5.5 exit-checks the engine capture and validates the report (no fail-open)', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // The engine capture must be FATAL — guarded by `if ! COVERAGE=$(node "$EDGE_PROBE_JS" …)`
  // (or an explicit exit-status check) that exits non-zero on failure.
  assert.match(
    block,
    /if\s+!\s+COVERAGE=\$\(node\s+"\$EDGE_PROBE_JS"/,
    'Step 5.5 must exit-check the engine invocation (e.g. `if ! COVERAGE=$(node "$EDGE_PROBE_JS" …)`) — a bare command substitution swallows the engine exit code and fails open'
  );

  // And the captured report must be validated as JSON before the resolution loop consumes it
  // (guards against an exit-0-but-garbage capture).
  assert.match(
    block,
    /(COVERAGE[\s\S]{0,500}JSON\.parse)|(JSON\.parse[\s\S]{0,500}\$COVERAGE)/,
    'Step 5.5 must validate $COVERAGE parses as JSON before use (guard against exit-0-but-malformed output)'
  );
});

// Test F (adversarial review): a report with ZERO applicable edges across all requirements is
// the likely-classification-miss fail-open (same shape as an invalid shape yielding applicable:0).
// Step 5.5 must surface it, not silently emit a green empty ## Edge Coverage section.
test('adversarial review: Step 5.5 guards a zero-applicable coverage report', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');
  assert.match(
    block,
    /coverage\.applicable/,
    'Step 5.5 must read coverage.applicable and guard the zero-applicable case (warn/confirm, not silently proceed)'
  );
});
