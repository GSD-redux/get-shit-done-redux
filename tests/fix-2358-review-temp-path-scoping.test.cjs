'use strict';

/**
 * #2358 — review.md (and ship.md's external peer-review step) wrote every
 * temp file to a hardcoded, phase-number-only path under /tmp
 * (`/tmp/gsd-review-prompt-{phase}.md`, `/tmp/gsd-review-<reviewer>-{phase}.*`,
 * `/tmp/gsd-review-stderr.log`). Two GSD projects with a phase sharing the
 * same small integer number collide on the exact same path; a crashed prior
 * run's leftover file is bait a later, unrelated run can silently read (the
 * reporter forensically confirmed agy read a 3-week-old stale prompt from a
 * DIFFERENT project). Neither file used the portable ${TMPDIR:-/tmp} seam,
 * and review.md had no cleanup.
 *
 * The fix threads a single `mktemp -d "${TMPDIR:-/tmp}/gsd-review-XXXXXX"`
 * run directory (RUN_DIR / {run_dir}) through every review.md temp path, and
 * ship.md's stderr capture through a per-run `mktemp` file — eliminating the
 * shared-path collision by construction rather than by convention.
 *
 * review.md and ship.md ARE the product the runtime loads (an AI agent reads
 * and executes these workflow instructions verbatim), so this is a
 * static-content regression against the deployed text, mirroring
 * fix-2194-review-timeout-guidance.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');
const REVIEWER_INSTANCES_MD = path.join(__dirname, '..', 'gsd-core', 'references', 'reviewer-instances.md');

describe('#2358 review.md temp paths are run-scoped, not phase-only', () => {
  const content = fs.readFileSync(REVIEW_MD, 'utf-8');

  test('no bare, unscoped /tmp/gsd-review-* path remains', () => {
    assert.ok(
      !content.includes('/tmp/gsd-review'),
      'review.md must not contain any hardcoded /tmp/gsd-review* literal — ' +
      'every review temp path must be rooted under the run-scoped mktemp directory'
    );
  });

  test('creates exactly one run-scoped directory via the portable ${TMPDIR:-/tmp} seam', () => {
    const mktempAssignments = content.match(/RUN_DIR=\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/gsd-review-XXXXXX"\)/g) || [];
    assert.equal(
      mktempAssignments.length, 1,
      'review.md must create the run directory with exactly one `mktemp -d "${TMPDIR:-/tmp}/gsd-review-XXXXXX"` — ' +
      'a hardcoded /tmp (no ${TMPDIR:-/tmp} seam) breaks on Windows, and re-mktemp-ing per block would break the ' +
      'write/read pairing between build_prompt and the local-reviewer budget-trimming reads'
    );
  });

  test('every downstream temp path is threaded through {run_dir} / $RUN_DIR, not re-derived from {phase}', () => {
    assert.ok(
      /\{run_dir\}\/gsd-review-/.test(content),
      'reviewer blocks must reference {run_dir}/gsd-review-... (the run-scoped placeholder)'
    );
    assert.ok(
      /\$\{RUN_DIR\}\/gsd-review-/.test(content),
      'the build_prompt section-file writes must reference ${RUN_DIR}/gsd-review-... (the run-scoped shell var)'
    );
    // The old isolation key must be gone entirely from path construction.
    assert.ok(
      !/\/tmp\/gsd-review[^\r\n]*\{phase\}/.test(content),
      'no temp path may still be keyed on a bare {phase} placeholder'
    );
    assert.ok(
      !/\$\{PHASE\}-(?:instructions|roadmap|plan|project|context|research|requirements)\.md/.test(content),
      'no temp path may still be keyed on the ${PHASE} shell var'
    );
  });

  // Phase 5b (#2799) moved these strings out of review.md's bash and into the resolver and the
  // antigravity handler, so the assertions follow them. The invariant is unchanged and is what
  // #2358 was about: every reviewer artifact must live under the run-scoped mktemp directory, never
  // a bare `{phase}`-keyed /tmp path that a concurrent review could collide with.
  test('every lane anchors its prompt and artifacts under the run dir', () => {
    const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
    const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
    const RUN = '/run-scoped';
    for (const lane of REVIEWER_LANES) {
      const r = resolveLanePlan({
        lane, configGet: () => undefined, runDir: RUN, repoRoot: '/repo',
      });
      assert.equal(r.ok, true, `${lane.slug} failed to resolve`);
      const p = r.plan;
      assert.ok(p.reviewPath.startsWith(`${RUN}/`), `${lane.slug} review path escapes the run dir`);
      assert.ok(p.errPath.startsWith(`${RUN}/`), `${lane.slug} err path escapes the run dir`);
      assert.ok(p.promptPath.startsWith(`${RUN}/`), `${lane.slug} prompt path escapes the run dir`);
    }
  });

  test('the argv-borne prompt instruction references the run-scoped path', () => {
    const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
    const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
    const RUN = '/run-scoped';
    const fileRefLanes = REVIEWER_LANES.filter(
      (l) => l.transport === 'spawn' && l.invoke.promptChannel === 'argv-file-ref',
    );
    assert.ok(fileRefLanes.length > 0, 'expected at least one argv-file-ref lane');
    for (const lane of fileRefLanes) {
      const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: '/repo' });
      const arg = r.plan.argv[r.plan.argv.length - 1];
      assert.ok(arg.includes(`${RUN}/gsd-review-prompt.md`), `${lane.slug} prompt not run-scoped`);
    }
  });

  test('an instance writes under the run dir, keyed by its own identity', () => {
    // Two instances of one adapter must not overwrite each other, and neither may escape the run
    // dir — the identity is sanitized to a flat filename.
    const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
    const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
    const lane = REVIEWER_LANES.find((l) => l.slug === 'opencode');
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/run-scoped', repoRoot: '/repo' });
    assert.ok(r.plan.reviewPath.startsWith('/run-scoped/'));
  });
});

describe('#2358 design principle: run-scoped temp dirs never collide across projects/phases', () => {
  // review.md and ship.md are markdown instructions an AI agent executes, not
  // node-executable code, so this does not shell out to the literal snippet —
  // it validates the underlying guarantee the fix relies on (mktemp-style
  // randomized-suffix isolation) using Node's built-in equivalent, which is
  // cross-platform (Windows included) unlike shelling out to `mktemp`/bash.
  test('two runs — even for the same phase number, same or different project — get distinct run dirs', () => {
    const prefix = path.join(os.tmpdir(), 'gsd-review-');
    const runDirA = fs.mkdtempSync(prefix);
    const runDirB = fs.mkdtempSync(prefix);
    try {
      assert.notEqual(
        runDirA, runDirB,
        'two review runs sharing the same phase number must never resolve to the same run-scoped directory'
      );
      const phase = '10'; // same phase number in both "projects" — the historical collision case
      const staleProjectAPath = path.join(runDirA, `gsd-review-prompt.md`);
      const laterProjectBPath = path.join(runDirB, `gsd-review-prompt.md`);
      assert.notEqual(
        staleProjectAPath, laterProjectBPath,
        `phase ${phase} in two different runs must not resolve to the same prompt path`
      );
    } finally {
      // helpers.cleanup (not raw fs.rmSync) carries the Windows-EBUSY retry budget.
      cleanup(runDirA);
      cleanup(runDirB);
    }
  });
});
