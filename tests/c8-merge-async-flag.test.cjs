'use strict';

// Regression guard for #4068 and #4172: c8's default (sync) coverage-merge phase
// loads every raw V8 coverage file for the whole run into memory as one array before
// merging (`Report._getMergedProcessCov`), which OOM-crashed `npm run
// test:coverage:unit` in the `release.yml` `finalize` dry-run of 1.12.0 (exit 134,
// SIGABRT) once the unit suite grew to 1785 tests / 15 chunks -- a recurrence of
// #199, which hit the same class at ~466 tests and was "fixed" by raising the heap
// ceiling instead of the merge shape. `--merge-async` switches to
// `_getMergedProcessCovAsync`, which reads and merges one raw file at a time
// (documented root-cause verification, including a real memory-shape repro against
// this repo's actual pinned c8@11.0.0, lives in
// .gsd/bug/fix-4068-coverage-merge-oom/10-diagnosis.md).
//
// #4068's fix covered test:coverage:unit and test:coverage:report but missed the
// third script reading the same merged coverage/tmp data in the same
// "Coverage gate (merged shards)" test.yml job: test:coverage:scripts-floor. That
// gap OOM-crashed the coverage gate on every push to next starting at 4dfc46b, once
// #4068's own new test file plus other suite growth pushed the un-flagged sync merge
// over the 8192 MB heap ceiling (#4172).
//
// #4355: #4068's fix ALSO missed test:coverage:unit:raw, based on an incorrect
// assumption (see the test this replaces, below) that `--reporter none` makes c8
// skip the merge/report dispatch entirely. Verified false against
// node_modules/c8/lib/report.js: Report.prototype.run() unconditionally awaits
// `this.getCoverageMapFromAllCoverageFiles()` to build `context.coverageMap` BEFORE
// it ever looks at `this.reporter` -- the reporter list only controls what happens
// to that already-merged map in the loop AFTER, so `--reporter none` skips nothing
// but the final text/json output. Without --merge-async this still runs the
// synchronous `_getMergedProcessCov()`, which loads every raw per-process V8
// coverage dump into memory at once -- the same #4068/#4172 OOM shape, confirmed
// live on release.yml's finalize-test job (run 33997057100, shard 2/3: "# fail 0"
// then a silent exit 1 ~21s later with no stack trace -- an external OOM-kill of
// the wrapping c8 process). test:coverage:unit:raw is used by both test.yml's
// sharded full-test lane and (since #4335) release.yml's rc-test/finalize-test
// matrix jobs, so every shard of every CI run and release was exposed.
//
// IMPORTANT c8@11.0.0 gotcha (verified against node_modules/c8/lib/commands/
// check-coverage.js and report.js directly): the `check-coverage` CLI subcommand's
// handler does NOT forward `argv.mergeAsync` into the `Report(...)` constructor --
// only the `report` subcommand's handler (and the default command, which also calls
// into report.js's outputReport) does. So `c8 check-coverage --merge-async ...`
// silently ignores the flag and still OOMs -- confirmed live on PR #4173's CI run
// after simply adding the flag to the check-coverage invocation did not fix the
// crash. The actual fix routes test:coverage:scripts-floor through the `report`
// subcommand with `--check-coverage` (a boolean flag, not a subcommand) instead of
// the `check-coverage` subcommand directly: `c8 report --check-coverage --lines 55
// --merge-async --include ...`. This exercises the exact same threshold-checking
// logic (report.js's outputReport calls the same checkCoverages() helper from
// check-coverage.js when --check-coverage is truthy) but through the handler that
// actually wires mergeAsync.
//
// This test cannot behaviorally reproduce the OOM itself: `gsd-test` never invokes
// these npm scripts (it runs `node --test` directly), and a heap-ceiling crossover
// point is not a stable, portable assertion across this repo's OS x Node matrix on
// shared benches (see .gsd/bug/fix-4068-coverage-merge-oom/50-test-matrix.md for the
// full seam analysis). What IS stable and worth guarding: the flag must not silently
// disappear from the scripts that need it, must not be added to a script whose
// merge/report phase never runs (a no-op that would misleadingly imply coverage
// here too), and -- new for #4172 -- test:coverage:scripts-floor must keep routing
// through the `report` subcommand rather than reverting to the `check-coverage`
// subcommand, which would silently re-introduce the OOM despite --merge-async still
// being present in the script string.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const scripts = pkg.scripts;

describe('coverage-merge-async-flag (#4068, #4172)', () => {
  test('test:coverage:unit carries --merge-async', () => {
    assert.match(
      scripts['test:coverage:unit'],
      /(?:^|\s)c8\s.*--merge-async/,
      'test:coverage:unit must pass --merge-async to c8, or the report/merge phase ' +
        'reverts to loading every raw V8 coverage file into memory at once (#4068)'
    );
  });

  test('test:coverage:report carries --merge-async', () => {
    assert.match(
      scripts['test:coverage:report'],
      /(?:^|\s)c8\s.*--merge-async/,
      'test:coverage:report (the coverage-gate job merge step in test.yml) must pass ' +
        '--merge-async to c8 for the same reason as test:coverage:unit (#4068)'
    );
  });

  test('test:coverage:scripts-floor carries --merge-async', () => {
    assert.match(
      scripts['test:coverage:scripts-floor'],
      /(?:^|\s)c8\s.*--merge-async/,
      'test:coverage:scripts-floor (the coverage-gate job scripts/ floor check in ' +
        'test.yml) must pass --merge-async to c8, or it reverts to loading every ' +
        'raw V8 coverage file into memory at once, the same class as #4068 (#4172)'
    );
  });

  test('test:coverage:scripts-floor routes through the report subcommand, not check-coverage', () => {
    const script = scripts['test:coverage:scripts-floor'];
    assert.match(
      script,
      /(?:^|\s)c8\s+report\b/,
      'test:coverage:scripts-floor must invoke `c8 report --check-coverage ...`, not ' +
        '`c8 check-coverage ...` -- c8@11.0.0\'s check-coverage subcommand handler ' +
        'does not forward --merge-async into the Report constructor (verified against ' +
        'node_modules/c8/lib/commands/check-coverage.js), so that form silently drops ' +
        'the flag and still OOMs even with --merge-async present in the string (#4172)'
    );
    assert.match(
      script,
      /--check-coverage\b/,
      'test:coverage:scripts-floor must pass --check-coverage to `c8 report` so the ' +
        'coverage threshold is still enforced, not just reported'
    );
  });

  test('--merge-async lands in the c8 invocation, not after the node runner', () => {
    for (const key of ['test:coverage:unit', 'test:coverage:report', 'test:coverage:scripts-floor', 'test:coverage:unit:raw']) {
      const script = scripts[key];
      const flagIndex = script.indexOf('--merge-async');
      const nodeIndex = script.indexOf(' node ');
      assert.ok(flagIndex !== -1, `${key}: --merge-async not found`);
      // A negative nodeIndex (test:coverage:report has no `node` invocation of its
      // own -- it re-slices already-merged dumps) means there is nothing to be
      // "after"; the flag only needs to precede the runner when one exists.
      if (nodeIndex !== -1) {
        assert.ok(
          flagIndex < nodeIndex,
          `${key}: --merge-async (index ${flagIndex}) must precede the node ` +
            `invocation (index ${nodeIndex}) so it is consumed by c8's own arg ` +
            'parser, not forwarded as argv to the wrapped script'
        );
      }
    }
  });

  test('test:coverage is intentionally unchanged (whole-suite dev convenience, never run by CI as a command)', () => {
    assert.doesNotMatch(
      scripts['test:coverage'],
      /--merge-async/,
      'test:coverage (package.json line ~150) is not invoked by any workflow as a ' +
        'command -- adding the flag here is out of this fix\'s scope (see diagnosis ' +
        'artifact "Not-the-bug" section)'
    );
  });

  test('test:coverage:unit:raw carries --merge-async (#4355)', () => {
    assert.match(
      scripts['test:coverage:unit:raw'],
      /(?:^|\s)c8\s.*--merge-async/,
      'test:coverage:unit:raw must pass --merge-async to c8 -- `--reporter none` does ' +
        'NOT skip the merge phase (Report.run() computes it unconditionally before ' +
        'ever consulting the reporter list, verified against ' +
        'node_modules/c8/lib/report.js), so without this flag it still OOMs the same ' +
        'way #4068/#4172 already fixed on the other three coverage scripts (#4355)'
    );
    assert.match(
      scripts['test:coverage:unit:raw'],
      /--reporter none/,
      'test:coverage:unit:raw must keep --reporter none -- the merge still needs to ' +
        'happen for c8 to write nothing misleading, but the actual report output is ' +
        'deferred to the separate coverage-gate job (test:coverage:report)'
    );
  });
});
