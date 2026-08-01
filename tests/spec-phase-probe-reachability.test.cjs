// allow-test-rule: source-text-is-the-product (see #2733) — spec-phase.md IS the deployed
// workflow the runtime executes, so its control flow is the product under assertion, not an
// implementation detail behind a typed seam. There is no structured artifact to assert on: the
// jump instructions ARE prose the model follows.
//
// Why this file exists (#2733): Step 5.5 (edge-completeness) and Step 5.6 (prohibition-
// completeness) were spliced between Step 5 and Step 6 by two later feature commits, but the
// four pre-existing gate-passed "Jump to Step 6" instructions were never re-pointed — so every
// gate-passed path textually routed around both mandatory probes and NO jump in the file
// reached Step 5.5 at all.
//
// A FIFTH occurrence survived the first pass and was caught in review: Step 5.5's own terminal
// soft gate (":305") read "proceed to Step 6", so the COMMON path — all edges resolved — skipped
// the prohibition probe outright. It was invisible to this guard because the transition matcher
// keyed only on "Jump to Step"; see TRANSITION_RE. Its sibling at ":393" is byte-identical yet
// CORRECT, because Step 6 genuinely follows Step 5.6 — position is the discriminator, not text.
//
// The two existing probe contract tests (edge-probe-spec-phase-contract.test.cjs,
// prohibition-probe.spec-phase-contract.test.cjs) are structurally blind to this: both slice
// the file from the "## Step 5.5" / "## Step 5.6" heading onward, so no assertion in either can
// observe the upstream jump text. They assert the probes' CONTENTS; this file asserts their
// REACHABILITY. Neither is modified by this fix.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'spec-phase.md');

/**
 * `## Step 5.5: Edge-Completeness Probe` → captures the id and the title.
 *
 * The explicit `\r?` matters: `.` excludes line terminators, so on a CRLF checkout `(.*)`
 * stops before the `\r` and an unanchored `$` then fails to match, silently yielding ZERO
 * steps and vacuously passing every assertion below. `.gitattributes:2` forces `eol=lf` today,
 * but this repo has a recurring CRLF-regex bug class, so the guard does not lean on it.
 */
const STEP_HEADING_RE = /^## Step ([0-9]+(?:\.[0-9]+)*)\s*:?\s*(.*?)\r?$/;

/**
 * A transition instruction the executing model is told to follow.
 *
 * This must cover EVERY phrasing the workflow uses to move control, not just `Jump to Step`.
 * The original `Jump to Step`-only form was blind to Step 5.5's own soft gate at :305
 * (`proceed to Step 6`), which is the same probe-skipping defect class this file guards —
 * so the guard could not see the very case it claimed to hold. The verb alternation is what
 * makes the docstring's promise ("a future spliced-in probe is covered without editing this
 * test") true for a step whose exit is worded differently.
 *
 * Position, not phrasing, is what separates a correct transition from a violation: :305 and
 * :393 are byte-identical `proceed to Step 6` lines and only differ in which step encloses
 * them. That discrimination lives in the `jumpIsUpstreamOfProbe` guard below, not here.
 */
const TRANSITION_RE = /(?:jump|proceed|continue|go|return|skip)\s+to\s+Step\s+([0-9]+(?:\.[0-9]+)*)/i;

/**
 * The max-rounds bypass: reached ONLY when the ambiguity gate never passed. Both probes are
 * scoped to requirements that already cleared the gate ("you probe edges of clear
 * requirements, not vague ones"), so these paths legitimately go straight to SPEC generation
 * and must NOT be redirected into a probe.
 */
const MAX_ROUNDS_MARKER = 'If max rounds reached';

function readSpecPhase() {
  return fs.readFileSync(SPEC_PHASE_PATH, 'utf8');
}

/** Segment-wise semver-ish compare so 5.10 sorts after 5.9 (a float compare would not). */
function compareStepIds(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Every `## Step N` heading, in document order, with the line it sits on. */
function collectSteps(lines) {
  const steps = [];
  lines.forEach((line, idx) => {
    const m = line.match(STEP_HEADING_RE);
    if (m) steps.push({ id: m[1], title: m[2].trim(), line: idx + 1 });
  });
  return steps;
}

/**
 * The MANDATORY probe steps, DERIVED from the file rather than hardcoded — any step whose
 * heading names it a probe. Deriving them means a future Step 5.7 probe is covered by this
 * assertion the moment it is spliced in, without anyone remembering to edit this test. That
 * is precisely the failure mode #2733 was.
 */
function collectProbeSteps(steps) {
  return steps.filter(s => /probe/i.test(s.title));
}

/** Every control-transition instruction (any phrasing), with the line it sits on. */
function collectJumps(lines) {
  const jumps = [];
  lines.forEach((line, idx) => {
    const m = line.match(TRANSITION_RE);
    if (m) jumps.push({ target: m[1], line: idx + 1, text: line.trim() });
  });
  return jumps;
}

/** Line range of the max-rounds bypass block: its marker through the next `## ` heading. */
function maxRoundsRange(lines) {
  const start = lines.findIndex(l => l.includes(MAX_ROUNDS_MARKER));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return { start: start + 1, end };
}

test('#2733: the probe steps exist and are DERIVABLE as mandatory from their headings', () => {
  const steps = collectSteps(readSpecPhase().split('\n'));
  const probes = collectProbeSteps(steps);

  assert.ok(
    probes.length >= 2,
    'spec-phase.md must define at least the edge-completeness and prohibition-completeness ' +
      `probe steps; found ${probes.length}: ${probes.map(p => p.id).join(', ')}`
  );
});

test('#2733: no jump instruction may skip a mandatory probe step', () => {
  const lines = readSpecPhase().split('\n');
  const steps = collectSteps(lines);
  const probes = collectProbeSteps(steps);
  const jumps = collectJumps(lines);
  const bypass = maxRoundsRange(lines);

  assert.ok(jumps.length > 0, 'spec-phase.md must contain jump instructions to assert on');

  const violations = [];
  for (const jump of jumps) {
    // The max-rounds bypass never passed the gate, so the probes do not apply to it.
    if (bypass && jump.line >= bypass.start && jump.line <= bypass.end) continue;

    for (const probe of probes) {
      const jumpIsUpstreamOfProbe = jump.line < probe.line;
      const targetIsPastProbe = compareStepIds(jump.target, probe.id) > 0;
      if (jumpIsUpstreamOfProbe && targetIsPastProbe) {
        violations.push(
          `spec-phase.md:${jump.line} jumps to Step ${jump.target}, skipping mandatory ` +
            `Step ${probe.id} (${probe.title}) — "${jump.text}"`
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    'Every gate-passed transition must route INTO the first mandatory probe, not past it. ' +
      `Found ${violations.length} probe-skipping jump(s):\n  ${violations.join('\n  ')}`
  );
});

test('#2733: at least one jump routes into the first mandatory probe', () => {
  const lines = readSpecPhase().split('\n');
  const probes = collectProbeSteps(collectSteps(lines));
  const jumps = collectJumps(lines);

  assert.ok(probes.length > 0, 'expected at least one probe step');
  const first = probes[0];
  const into = jumps.filter(j => j.target === first.id);

  assert.ok(
    into.length > 0,
    `Step ${first.id} (${first.title}) is defined but no jump instruction reaches it — ` +
      'it is unreachable dead prose. Jump targets found: ' +
      `${[...new Set(jumps.map(j => j.target))].join(', ')}`
  );
});

test('#2733 coupled: the max-rounds bypass is NOT redirected into a probe', () => {
  const lines = readSpecPhase().split('\n');
  const probes = collectProbeSteps(collectSteps(lines));
  const bypass = maxRoundsRange(lines);

  assert.ok(bypass, `expected a "${MAX_ROUNDS_MARKER}" block in spec-phase.md`);

  const block = lines.slice(bypass.start - 1, bypass.end);
  const probeIds = new Set(probes.map(p => p.id));
  const redirected = block
    .map((line, i) => ({ line: bypass.start + i, text: line.trim(), m: line.match(TRANSITION_RE) }))
    .filter(e => e.m && probeIds.has(e.m[1]));

  assert.deepEqual(
    redirected.map(e => `spec-phase.md:${e.line} — "${e.text}"`),
    [],
    'The max-rounds "write anyway" paths never passed the ambiguity gate, so the probes do ' +
      'not apply to them; they must continue straight to SPEC generation.'
  );

  assert.ok(
    block.some(l => l.includes('Write SPEC.md')),
    'The max-rounds bypass must still route to SPEC generation.'
  );
});

test('#2733 coupled: each probe step keeps its own exit to SPEC generation', () => {
  const lines = readSpecPhase().split('\n');
  const steps = collectSteps(lines);
  const probes = collectProbeSteps(steps);

  for (const probe of probes) {
    const next = steps.find(s => s.line > probe.line);
    const block = lines.slice(probe.line - 1, next ? next.line - 1 : lines.length).join('\n');
    assert.match(
      block,
      /proceed to Step [0-9]/i,
      `Step ${probe.id} (${probe.title}) must keep its own onward exit — the probes' soft ` +
        'gates are what carry control to SPEC generation once resolved.'
    );
  }
});
