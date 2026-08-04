/**
 * Characterization tests for code-review-flags module.
 *
 * These assertions lock the flag-parsing and workflow-dispatch behaviour
 * used by the /gsd:code-review command. Covers both exports and every quirk
 * documented in the hand-written .cjs (ADR-457 build-at-publish migration).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCodeReviewFlags,
  resolveCodeReviewWorkflow,
} = require('../gsd-core/bin/lib/code-review-flags.cjs');

describe('parseCodeReviewFlags', () => {
  test('no flags → all defaults', () => {
    assert.deepStrictEqual(parseCodeReviewFlags([]), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
    });
  });

  test('--fix sets fix:true', () => {
    const flags = parseCodeReviewFlags(['--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
  });

  test('--all sets all:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--all']);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.auto, false);
  });

  test('--auto sets auto:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--auto']);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
  });

  test('--depth=high sets depth', () => {
    const flags = parseCodeReviewFlags(['--depth=high']);
    assert.strictEqual(flags.depth, 'high');
  });

  test('--files=src/foo sets files', () => {
    const flags = parseCodeReviewFlags(['--files=src/foo']);
    assert.strictEqual(flags.files, 'src/foo');
  });

  test('--depth= (empty value) leaves depth as empty string', () => {
    const flags = parseCodeReviewFlags(['--depth=']);
    assert.strictEqual(flags.depth, '');
  });

  test('first positional argument (phase number) is ignored', () => {
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
  });

  test('unknown flags are silently ignored', () => {
    assert.deepStrictEqual(parseCodeReviewFlags(['--unknown']), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
    });
  });

  test('combined: positional + --all + --depth + --files', () => {
    const flags = parseCodeReviewFlags(['3', '--all', '--depth=deep', '--files=a.ts']);
    assert.deepStrictEqual(flags, {
      fix: true,
      all: true,
      auto: false,
      depth: 'deep',
      files: 'a.ts',
    });
  });
});

describe('resolveCodeReviewWorkflow', () => {
  test('fix:true → code-review-fix.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: true, all: false, auto: false, depth: '', files: '' }),
      'code-review-fix.md',
    );
  });

  test('fix:false → code-review.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: false, all: false, auto: false, depth: '', files: '' }),
      'code-review.md',
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3727-code-review-fix-flag-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3727-code-review-fix-flag-dispatch (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3727)
// The workflow .md IS the product: its text is loaded and interpreted at
// runtime by the agent host. Structural assertions (step existence, flag
// references in the initialize step) verify the deployed dispatch contract.
// Pure-function assertions on parseCodeReviewFlags / resolveCodeReviewWorkflow
// are IR-level (not raw-text-match) per CONTRIBUTING.md L554.

/**
 * Regression tests for #3727 — /gsd-code-review N --fix silently no-ops.
 *
 * Root cause: code-review.md `initialize` step parses only --depth and
 * --files flags. --fix, --all, and --auto are never parsed, so no dispatch
 * to code-review-fix.md ever occurs.
 *
 * Fix: add parseCodeReviewFlags() to code-review-flags.cjs (typed IR), wire
 * it into the workflow initialize step, and add a dispatch_fix step that
 * delegates to code-review-fix.md when flags.fix is true.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'code-review-flags.cjs');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

// ---------------------------------------------------------------------------
// Stage 2 seam: typed IR from parseCodeReviewFlags and resolveCodeReviewWorkflow
// These functions are the production code under test — not text-matching on
// the .md source.
// ---------------------------------------------------------------------------

const { parseCodeReviewFlags, resolveCodeReviewWorkflow } = require(FLAGS_LIB);

describe('#3727 — parseCodeReviewFlags: typed IR for code-review argv', () => {
  test('code-review workflow parses --fix flag and dispatches gsd-code-fixer', () => {
    // This is the invariant being violated: --fix must be captured into the IR
    // and must route to the fixer workflow, not be silently dropped.
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.fix, true,
      '--fix must set flags.fix = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--fix must dispatch to code-review-fix.md, not code-review.md');
  });

  test('--fix absent: dispatch stays on code-review.md (review-only)', () => {
    // Counter-test (Stage 5 contract 6): omitting --fix must NOT dispatch fixer.
    const flags = parseCodeReviewFlags(['2']);
    assert.strictEqual(flags.fix, false,
      'Without --fix, flags.fix must be false');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review.md',
      'Without --fix, dispatch must stay on code-review.md');
  });

  test('--all implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--all']);
    assert.strictEqual(flags.fix, true,
      '--all must imply flags.fix = true');
    assert.strictEqual(flags.all, true,
      '--all must set flags.all = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--all must dispatch to code-review-fix.md');
  });

  test('--auto implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--auto']);
    assert.strictEqual(flags.fix, true,
      '--auto must imply flags.fix = true');
    assert.strictEqual(flags.auto, true,
      '--auto must set flags.auto = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--auto must dispatch to code-review-fix.md');
  });

  test('--fix --all --auto all set simultaneously', () => {
    const flags = parseCodeReviewFlags(['1', '--fix', '--all', '--auto']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--depth flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--depth=deep', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.depth, 'deep');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--files flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--files=src/foo.ts,src/bar.ts', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.files, 'src/foo.ts,src/bar.ts');
  });

  test('empty argv returns all-false IR', () => {
    const flags = parseCodeReviewFlags([]);
    assert.strictEqual(flags.fix, false);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
  });
});

// ---------------------------------------------------------------------------
// Docs-parity: the workflow .md must contain the dispatch_fix step and
// reference code-review-flags.cjs in the initialize step.
// These are structural invariants on the deployed product text.
// Source-text-is-the-product exemption applies (see file header).
// ---------------------------------------------------------------------------

describe('#3727 — code-review.md structural dispatch contract', () => {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // #2994: dispatch_fix moved wholly into a marker-gated step file
  // (gsd-core/workflows/code-review/steps/dispatch-fix.md, when="flag:--fix")
  // — the host now carries only the gsd:section marker + read-or-skip stub.
  const DISPATCH_FIX_STEP_PATH = path.join(
    ROOT,
    'gsd-core',
    'workflows',
    'code-review',
    'steps',
    'dispatch-fix.md',
  );
  const dispatchFixSrc = fs.readFileSync(DISPATCH_FIX_STEP_PATH, 'utf8');

  test('initialize step references code-review-flags.cjs for flag parsing', () => {
    const initStart = src.indexOf('<step name="initialize">');
    const initEnd = src.indexOf('</step>', initStart);
    assert.ok(initStart !== -1, 'workflow must have an initialize step');
    const initSection = src.slice(initStart, initEnd);
    assert.ok(
      initSection.includes('code-review-flags.cjs'),
      'initialize step must reference code-review-flags.cjs to parse --fix/--all/--auto flags'
    );
  });

  test('workflow gates a dispatch-fix section (flag:--fix) whose step file has the dispatch_fix step', () => {
    assert.ok(
      src.includes('<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->') &&
        src.includes('gsd-core/workflows/code-review/steps/dispatch-fix.md'),
      'code-review.md must gate a dispatch-fix section pointing at dispatch-fix.md (missing = --fix is silently no-op)'
    );
    assert.ok(
      dispatchFixSrc.includes('<step name="dispatch_fix">'),
      'dispatch-fix.md step file must contain the dispatch_fix step'
    );
  });

  test('dispatch_fix step delegates to code-review-fix.md when fix flag is true', () => {
    assert.ok(
      dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference code-review-fix.md workflow'
    );
  });

  test('dispatch_fix step references gsd-code-fixer agent (via code-review-fix.md chain)', () => {
    // The dispatch step must show that fixing will occur, either directly or
    // by loading code-review-fix.md (which in turn spawns gsd-code-fixer).
    assert.ok(
      dispatchFixSrc.includes('gsd-code-fixer') || dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference gsd-code-fixer agent or code-review-fix.md workflow'
    );
  });
});
  });
}
