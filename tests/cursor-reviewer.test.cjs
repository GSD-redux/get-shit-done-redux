// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Cursor CLI Reviewer Tests (#1960)
 *
 * Verifies that /gsd-review includes Cursor CLI as a peer reviewer:
 *   - review.md workflow contains cursor detection, flag parsing, self-detection, invocation
 *   - commands/gsd/review.md command file mentions --cursor flag
 *   - help.md lists --cursor in the /gsd-review signature
 *   - docs/COMMANDS.md has --cursor flag row
 *   - docs/FEATURES.md has Cursor in the review section
 *   - i18n docs mirror the same content
 *   - REVIEWS.md template includes Cursor Review section
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('Cursor CLI reviewer in /gsd-review (#1960)', () => {

  // --- review.md workflow ---

  describe('review.md workflow', () => {
    const reviewPath = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');
    let _content;

    test('review.md exists', () => {
      assert.ok(fs.existsSync(reviewPath), 'review.md should exist');
      _content = fs.readFileSync(reviewPath, 'utf-8');
    });

    test('contains cursor CLI detection via command -v cursor-agent', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('command -v cursor-agent'),
        'review.md should detect cursor CLI via "command -v cursor-agent" (not the cursor IDE launcher)'
      );
    });

    test('contains --cursor flag parsing', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'review.md should parse --cursor flag'
      );
    });

    test('contains CURSOR_SESSION_ID self-detection', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('CURSOR_SESSION_ID'),
        'review.md should detect self-CLI via CURSOR_SESSION_ID env var'
      );
    });

    // Phase 5b (#2799) moved the invocation out of review.md's bash and into the declared lane.
    // These four assertions follow it: the descriptor and the resolved plan ARE the deployed
    // contract now, and asserting on them is strictly stronger than matching fence text.
    test('invocation uses the cursor-agent single binary, not two-token "cursor agent"', () => {
      const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
      const lane = REVIEWER_LANES.find((l) => l.slug === 'cursor');
      assert.equal(lane.invoke.binary, 'cursor-agent');
      assert.ok(lane.invoke.args.includes('-p'));
    });

    test('invocation includes --output-format text', () => {
      const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
      const lane = REVIEWER_LANES.find((l) => l.slug === 'cursor');
      const i = lane.invoke.args.indexOf('--output-format');
      assert.ok(i !== -1);
      assert.equal(lane.invoke.args[i + 1], 'text');
    });

    test('the prompt is a file-path ARGUMENT, never piped on stdin', () => {
      // Print mode takes the prompt as an argument, and a full plan set inline would approach the
      // 32,767-char Windows execFileSync ceiling — hence the file reference.
      const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
      const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
      const lane = REVIEWER_LANES.find((l) => l.slug === 'cursor');
      assert.equal(lane.invoke.promptChannel, 'argv-file-ref');
      const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/rd', repoRoot: '/repo' });
      assert.equal(r.ok, true);
      assert.equal(r.plan.stdin, null, 'nothing may be fed on stdin');
      assert.ok(r.plan.argv[r.plan.argv.length - 1].includes('/rd/gsd-review-prompt.md'));
    });

    test('does NOT use broken two-token "cursor agent " form', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      // Must not match "cursor agent " (cursor + space + agent + space)
      // The hyphenated "cursor-agent" must NOT trip this check — the regex uses a space, not a hyphen.
      assert.ok(
        !/cursor agent /.test(c),
        'review.md must NOT contain the broken two-token form "cursor agent " (use "cursor-agent" instead)'
      );
    });

    test('does NOT pipe the prompt into a cursor command via stdin', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      // Must not match a pipe feeding into a cursor command (e.g. "| cursor" or "|cursor")
      // "cursor-agent" (hyphenated) must NOT trip this — the regex anchors on "cursor" not followed by "-agent"
      assert.ok(
        !/\| *cursor(?!-agent)/.test(c),
        'review.md must NOT pipe the prompt to a cursor command via stdin'
      );
    });

    test('the lane declares its REVIEWS.md section', () => {
      // The heading used to be a literal in review.md's write_reviews template. Phase 5b renders
      // sections from each lane's declared `reviewsSection`, so THAT is the contract now — and
      // uniqueness across lanes is enforced by the parity gate (ADR-2782 D8), which a hardcoded
      // list never was.
      const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
      const lane = REVIEWER_LANES.find((l) => l.slug === 'cursor');
      assert.equal(lane.reviewsSection, 'Cursor');
      const sections = REVIEWER_LANES.map((l) => l.reviewsSection);
      assert.equal(
        sections.filter((x) => x === 'Cursor').length, 1,
        'two lanes sharing a heading would silently merge their output in REVIEWS.md',
      );
    });

    test('lists cursor in the reviewers frontmatter array', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        /reviewers:.*cursor/.test(c),
        'review.md should list cursor in the reviewers array'
      );
    });
  });

  // --- commands/gsd/review.md ---

  describe('commands/gsd/review.md', () => {
    const cmdPath = path.join(ROOT, 'commands', 'gsd', 'review.md');

    test('mentions --cursor flag', () => {
      const c = fs.readFileSync(cmdPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'commands/gsd/review.md should mention --cursor flag'
      );
    });

    test('mentions Cursor in objective or context', () => {
      const c = fs.readFileSync(cmdPath, 'utf-8');
      assert.ok(
        c.includes('Cursor'),
        'commands/gsd/review.md should mention Cursor'
      );
    });
  });

  // --- help.md ---

  describe('help.md', () => {
    // After #3039, help content moved into help/modes/full.md.
    const helpPath = path.join(ROOT, 'gsd-core', 'workflows', 'help', 'modes', 'full.md');

    test('lists --cursor in /gsd-review signature', () => {
      const c = fs.readFileSync(helpPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'help.md should list --cursor in the /gsd-review command signature'
      );
    });
  });

  // --- docs/COMMANDS.md ---

  describe('docs/COMMANDS.md', () => {
    const docsPath = path.join(ROOT, 'docs', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(docsPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  // --- docs/FEATURES.md ---

  describe('docs/FEATURES.md', () => {
    const featPath = path.join(ROOT, 'docs', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(featPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review purpose', () => {
      const c = fs.readFileSync(featPath, 'utf-8');
      assert.ok(
        c.includes('Cursor'),
        'docs/FEATURES.md should mention Cursor in the review section'
      );
    });
  });

  // --- i18n: ja-JP ---

  describe('docs/ja-JP/COMMANDS.md', () => {
    const jaPath = path.join(ROOT, 'docs', 'ja-JP', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(jaPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ja-JP/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  describe('docs/ja-JP/FEATURES.md', () => {
    const jaPath = path.join(ROOT, 'docs', 'ja-JP', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(jaPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ja-JP/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review section', () => {
      assert.ok(
        /Cursor/i.test(fs.readFileSync(jaPath, 'utf-8')),
        'docs/ja-JP/FEATURES.md should mention Cursor in the review section'
      );
    });
  });

  // --- i18n: ko-KR ---

  describe('docs/ko-KR/COMMANDS.md', () => {
    const koPath = path.join(ROOT, 'docs', 'ko-KR', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(koPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ko-KR/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  describe('docs/ko-KR/FEATURES.md', () => {
    const koPath = path.join(ROOT, 'docs', 'ko-KR', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(koPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ko-KR/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review section', () => {
      assert.ok(
        /Cursor/i.test(fs.readFileSync(koPath, 'utf-8')),
        'docs/ko-KR/FEATURES.md should mention Cursor in the review section'
      );
    });
  });
});
