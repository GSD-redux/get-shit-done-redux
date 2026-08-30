'use strict';

// Regression guard for #4068: c8's default (sync) coverage-merge phase loads every
// raw V8 coverage file for the whole run into memory as one array before merging
// (`Report._getMergedProcessCov`), which OOM-crashed `npm run test:coverage:unit` in
// the `release.yml` `finalize` dry-run of 1.12.0 (exit 134, SIGABRT) once the unit
// suite grew to 1785 tests / 15 chunks -- a recurrence of #199, which hit the same
// class at ~466 tests and was "fixed" by raising the heap ceiling instead of the
// merge shape. `--merge-async` switches to `_getMergedProcessCovAsync`, which reads
// and merges one raw file at a time (documented root-cause verification, including a
// real memory-shape repro against this repo's actual pinned c8@11.0.0, lives in
// .gsd/bug/fix-4068-coverage-merge-oom/10-diagnosis.md).
//
// This test cannot behaviorally reproduce the OOM itself: `gsd-test` never invokes
// `npm run test:coverage:unit` (it runs `node --test` directly), and a heap-ceiling
// crossover point is not a stable, portable assertion across this repo's OS x Node
// matrix on shared benches (see .gsd/bug/fix-4068-coverage-merge-oom/50-test-matrix.md
// for the full seam analysis). What IS stable and worth guarding: the flag must not
// silently disappear from the two scripts that need it, and must not be added to a
// script whose merge/report phase never runs (a no-op that would misleadingly imply
// coverage here too).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const scripts = pkg.scripts;

describe('coverage-merge-async-flag (#4068)', () => {
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

  test('--merge-async lands in the c8 invocation, not after the node runner', () => {
    for (const key of ['test:coverage:unit', 'test:coverage:report']) {
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

  test('test:coverage:unit:raw is intentionally unchanged (--reporter none skips the merge/report phase entirely)', () => {
    assert.match(
      scripts['test:coverage:unit:raw'],
      /--reporter none/,
      'test:coverage:unit:raw must keep --reporter none -- this is what defers all ' +
        'merging to the separate coverage-gate job (test:coverage:report)'
    );
    assert.doesNotMatch(
      scripts['test:coverage:unit:raw'],
      /--merge-async/,
      '--merge-async on a --reporter none run is a no-op (Report.run() never ' +
        'reaches the merge dispatch) and would misleadingly imply this script does ' +
        'its own merging'
    );
  });
});
