'use strict';

/**
 * Behavioral tests for scripts/gen-features.cjs — the docs/FEATURES.md
 * generator and fragment gate (#3840).
 *
 * TWO LAYERS, deliberately:
 *
 *   1. Pure-function tests over the generator's INTERMEDIATE REPRESENTATION —
 *      the parsed fragment records, the assembled group/section ordering, and
 *      the typed violation objects. CONTRIBUTING.md forbids raw text matching
 *      on outputs, and for a generator that rule bites hardest: asserting on
 *      rendered markdown would pin cosmetics and miss semantics. The IR is the
 *      contract; the markdown is one projection of it.
 *
 *   2. CLI tests that drive the real script as a subprocess against SYNTHETIC
 *      corpora in a temp dir, asserting exit codes and the typed `--json`
 *      report — never stderr prose.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: the number of features, the
 * highest id, or the full list of groups. Every one of those is a shared
 * mutable cell that every feature-adding PR would have to edit — exactly the
 * merge-conflict class #3840 exists to delete. Pinning a count here would move
 * the conflict from docs/FEATURES.md into this file. Invariants only.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { copyScriptWithDeps } = require('./helpers/copy-script-fixture.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const gen = require('../scripts/gen-features.cjs');
const {
  REASON,
  MIN_BODY_HEADING_DEPTH,
  START_MARKER,
  END_MARKER,
  slugify,
  parseFrontmatter,
  renderFrontmatter,
  shallowBodyHeadings,
  forgedRegionMarker,
  FORBIDDEN_BODY_SUBSTRINGS,
  defaultOrder,
  buildCorpus,
  renderFeatures,
  spliceIntoFeatures,
} = gen;

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_REL = path.join('scripts', 'gen-features.cjs');

/** Seed pinned to the issue number so a failure is reproducible by name. */
const FC_SEED = 3840;
const FC_RUNS = 200;

// ---------------------------------------------------------------------------
// Fixture harness
// ---------------------------------------------------------------------------

/**
 * Build a throwaway repo whose docs/features/ contains exactly `fragments`
 * (name -> text) and whose scripts/ holds a copy of the generator plus its
 * transitive relative-require graph.
 *
 * The generator resolves its scan root from `path.join(__dirname, '..')`, so a
 * fixture run of the REAL script would scan the real repo. Copying is what
 * makes a synthetic corpus possible at all.
 */
function makeRepo(t, fragments, { notes = {}, doc, extraDocs = {} } = {}) {
  // helpers.cleanup (not raw fs.rmSync) carries the Windows-EBUSY retry budget.
  const root = createTempDir('gsd-features-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'docs', 'features', '_groups'), { recursive: true });

  copyScriptWithDeps(REPO_ROOT, root, SCRIPT_REL);

  for (const [name, body] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(root, 'docs', 'features', name), body);
  }
  for (const [name, body] of Object.entries(notes)) {
    fs.writeFileSync(path.join(root, 'docs', 'features', '_groups', name), body);
  }
  for (const [rel, body] of Object.entries(extraDocs)) {
    const abs = path.join(root, 'docs', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(
    path.join(root, 'docs', 'FEATURES.md'),
    doc === undefined ? `# Features\n\n${START_MARKER}\n${END_MARKER}\n` : doc,
  );
  return root;
}

/** Run the generator in `root`. Never throws — the seam returns data. */
function run(root, args = []) {
  return runNode([path.join(root, SCRIPT_REL), ...args], {
    cwd: root,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/** Run with `--json` and return the parsed typed report. */
function report(root) {
  const res = run(root, ['--json']);
  assert.equal(res.outcome, OUTCOME.EXITED);
  return JSON.parse(res.stdout);
}

/** Reasons present in a `--json` report, deduplicated and sorted. */
function reasonsIn(rep) {
  return [...new Set(rep.violations.map((v) => v.reason))].sort();
}

const fragment = (id, title, group, body = '**Purpose:** x.', extra = {}) =>
  renderFrontmatter({ id, title, group, ...extra }, `${body}\n`);

/**
 * Reason string when this host cannot create a symlink, else `false`.
 *
 * Unprivileged Windows without Developer Mode rejects `symlinkSync` with
 * EPERM. A bare `return` there would be a PASS, not a skip — the documented
 * trap — so the skip is declared to the runner instead.
 */
function symlinkSkip() {
  const probe = createTempDir('gsd-symlink-probe-');
  try {
    fs.writeFileSync(path.join(probe, 'target'), 'x');
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return false;
  } catch {
    return 'this host cannot create symlinks (unprivileged Windows)';
  } finally {
    // helpers.cleanup, not fs.rmSync — it carries the Windows-EBUSY retry budget.
    cleanup(probe);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parser — the seam every fragment passes through
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('splits a well-formed fragment into typed data and body', () => {
    const { data, body } = parseFrontmatter(
      '---\nid: 168\ntitle: Runtime Identity\ngroup: v1.7.0 Features\n---\n\n**Purpose:** x.\n',
    );
    assert.deepEqual(data, { id: '168', title: 'Runtime Identity', group: 'v1.7.0 Features' });
    assert.equal(body, '**Purpose:** x.\n');
  });

  test('reports a missing opening fence as data:null rather than guessing', () => {
    assert.equal(parseFrontmatter('**Purpose:** x.\n').data, null);
  });

  test('reports an unterminated fence as data:null', () => {
    assert.equal(parseFrontmatter('---\nid: 1\ntitle: X\n').data, null);
  });

  test('normalizes CRLF so a Windows-authored fragment parses identically', () => {
    const lf = parseFrontmatter('---\nid: 1\ntitle: X\ngroup: G\n---\n\nbody\n');
    const crlf = parseFrontmatter('---\r\nid: 1\r\ntitle: X\r\ngroup: G\r\n---\r\n\r\nbody\r\n');
    assert.deepEqual(crlf, lf);
  });

  test('preserves a colon inside a value (only the FIRST colon separates)', () => {
    const { data } = parseFrontmatter('---\ntitle: Ship: the final step\n---\n\nb\n');
    assert.deepEqual(data, { title: 'Ship: the final step' });
  });

  test('round-trips values that need quoting, so no fragment can be lossy', () => {
    for (const value of ['  padded  ', '"quoted"', '', 'plain']) {
      const text = renderFrontmatter({ title: value }, 'body\n');
      assert.equal(parseFrontmatter(text).data.title, value, `value ${JSON.stringify(value)}`);
    }
  });

  test('PROPERTY: parse(render(data, body)) === {data, body} for any scalar record', () => {
    const key = fc
      .tuple(
        fc.constantFrom('a', 'b', 'c', 'i', 'k', 'x', 'z'),
        fc.stringMatching(/^[a-z0-9_-]{0,8}$/),
      )
      .map(([head, tail]) => head + tail);
    // Values exclude newlines and lone CR: a newline would forge a second
    // frontmatter line, which is a different (rejected) document, not a
    // round-trip failure. Everything else — including quotes, colons and
    // padding — must survive.
    const value = fc.string({ maxLength: 40 }).filter((s) => !/[\r\n]/.test(s));
    const body = fc.string({ maxLength: 60 }).map((s) => `${s.replace(/\r/g, '')}\n`);

    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 6 }), body, (data, b) => {
        const parsed = parseFrontmatter(renderFrontmatter(data, b));
        // fc.dictionary yields null-prototype objects; the parser yields plain
        // ones. Spread both so the comparison is about CONTENT, not prototype.
        assert.deepEqual({ ...parsed.data }, { ...data });
        assert.equal(parsed.body, b);
      }),
      { seed: FC_SEED, numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Anchor derivation — the thing that keeps inbound #N links resolving
// ---------------------------------------------------------------------------

describe('slugify', () => {
  test('reproduces the live anchors the migration had to freeze', () => {
    const cases = [
      ['1. Project Initialization', '1-project-initialization'],
      ['27b. Existing Codebase Onboarding', '27b-existing-codebase-onboarding'],
      ['6.5. Ship', '65-ship'],
      ['69. STATE.md Consistency Gates', '69-statemd-consistency-gates'],
      ['70. Autonomous `--to N` Flag', '70-autonomous---to-n-flag'],
      ['101. Hard Stop Safety Gates in /gsd-progress --next', '101-hard-stop-safety-gates-in-gsd-progress---next'],
      ['152. Statusline Token Count & Git Segment', '152-statusline-token-count--git-segment'],
      ['149. Embeddable Orchestration System (Host-Integration Interface)', '149-embeddable-orchestration-system-host-integration-interface'],
      ['Core Features', 'core-features'],
      ['v1.42.1 Features', 'v1421-features'],
    ];
    for (const [heading, anchor] of cases) assert.equal(slugify(heading), anchor, heading);
  });

  test('PROPERTY: an anchor never contains a character outside [\\w-]', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        assert.equal(/^[\w-]*$/.test(slugify(s)), true, JSON.stringify(s));
      }),
      { seed: FC_SEED, numRuns: FC_RUNS },
    );
  });

  test('PROPERTY: slugify is idempotent on its own output', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 .&()`-]{0,40}$/), (s) => {
        assert.equal(slugify(slugify(s)), slugify(s));
      }),
      { seed: FC_SEED, numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Body heading depth — boundary coverage at limit-1 / limit / limit+1
// ---------------------------------------------------------------------------

describe('shallowBodyHeadings', () => {
  test('the guarded limit is h4', () => {
    assert.equal(MIN_BODY_HEADING_DEPTH, 4);
  });

  test('BOUNDARY limit-1 (h2) is rejected — it would forge a group', () => {
    const hits = shallowBodyHeadings('intro\n\n## Forged Group\n');
    assert.deepEqual(hits, [{ line: 3, depth: 2 }]);
  });

  test('BOUNDARY limit (h3) is rejected — it would forge a sibling section', () => {
    const hits = shallowBodyHeadings('intro\n\n### 999. Forged Section\n');
    assert.deepEqual(hits, [{ line: 3, depth: 3 }]);
  });

  test('BOUNDARY limit+1 (h4) is accepted — it nests inside the feature', () => {
    assert.deepEqual(shallowBodyHeadings('intro\n\n#### Sub-heading\n'), []);
  });

  test('h1 is rejected too (depth 1 is shallower still)', () => {
    assert.deepEqual(shallowBodyHeadings('# Title\n'), [{ line: 1, depth: 1 }]);
  });

  test('a heading-shaped line inside a fenced block is content, not structure', () => {
    assert.deepEqual(shallowBodyHeadings('a\n\n```md\n## Sample\n### Sample\n```\n\nb\n'), []);
    assert.deepEqual(shallowBodyHeadings('a\n\n~~~\n## Sample\n~~~\n'), []);
  });

  test('a longer fence is not closed by a shorter one inside it', () => {
    assert.deepEqual(shallowBodyHeadings('````\n```\n## Sample\n```\n````\n'), []);
  });

  test('a `#` with no following space is not a heading', () => {
    assert.deepEqual(shallowBodyHeadings('#hashtag\n'), []);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('forgedRegionMarker', () => {
  test('names the marker a body forges, so the violation can carry it', () => {
    assert.equal(forgedRegionMarker('a\n<!-- FEATURES:END -->\nb'), '<!-- FEATURES:END');
    assert.equal(forgedRegionMarker('<!-- FEATURES:START x -->'), '<!-- FEATURES:START');
  });

  test('an ordinary body forges nothing', () => {
    assert.equal(forgedRegionMarker('**Purpose:** talks about FEATURES.md.'), null);
    assert.equal(forgedRegionMarker(''), null);
  });

  test('the forbidden list is the marker PREFIXES, so a variant comment cannot slip past', () => {
    // Matching the full marker string would let `<!-- FEATURES:END junk -->`
    // through, and `indexOf`/`lastIndexOf` in the splice would still find the
    // real substring inside it. Prefixes close that gap.
    assert.deepEqual([...FORBIDDEN_BODY_SUBSTRINGS], ['<!-- FEATURES:START', '<!-- FEATURES:END']);
    assert.equal(forgedRegionMarker('<!-- FEATURES:END junk -->'), '<!-- FEATURES:END');
  });
});

describe('spliceIntoFeatures', () => {
  test('anchors the end boundary on the LAST marker, never the first', () => {
    const doc = `head\n${START_MARKER}\nold\n${END_MARKER}\nmiddle\n${END_MARKER}\ntail\n`;
    const out = spliceIntoFeatures(doc, `${START_MARKER}\nnew\n${END_MARKER}`);
    assert.equal(out, `head\n${START_MARKER}\nnew\n${END_MARKER}\ntail\n`);
  });

  test('is a fixed point on a document it just produced', () => {
    const doc = `head\n${START_MARKER}\nnew\n${END_MARKER}\ntail\n`;
    const region = `${START_MARKER}\nnew\n${END_MARKER}`;
    assert.equal(spliceIntoFeatures(doc, region), doc);
  });
});

describe('defaultOrder', () => {
  test('derives a sort key from the id so most fragments need no `order`', () => {
    assert.equal(defaultOrder('1'), 1);
    assert.equal(defaultOrder('27'), 27);
    assert.equal(defaultOrder('27a'), 27);
    assert.equal(defaultOrder('6.5'), 6.5);
    assert.equal(defaultOrder('168'), 168);
  });
});

// ---------------------------------------------------------------------------
// The real corpus — invariants only, never counts
// ---------------------------------------------------------------------------

describe('the committed docs/features/ corpus', () => {
  const corpus = buildCorpus();

  test('has no fragment violations and no unresolved inbound anchors', () => {
    assert.deepEqual(
      corpus.violations.map((v) => `${v.reason} ${v.file}${v.anchor ? ` #${v.anchor}` : ''}`),
      [],
    );
  });

  test('every id is unique', () => {
    const ids = corpus.fragments.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every anchor is unique', () => {
    const anchors = corpus.fragments.map((f) => f.anchor);
    assert.equal(new Set(anchors).size, anchors.length);
  });

  test('no fragment declares the same REQ id twice', () => {
    // WITHIN a fragment, never across the corpus. Two different features legitimately
    // both carry REQ-REVIEW-01..07 — the cross-AI review feature and the code-review
    // pipeline — so a corpus-wide uniqueness check would be wrong on the committed tree
    // and would have to be weakened the day it first ran. A requirement list belongs to
    // its feature; that is the scope of the identifier.
    //
    // WHY THIS EXISTS (#3829). The failure is a MERGE, not an edit. Two PRs open at once
    // each append "the next" REQ number to the same list; whichever lands second is
    // rebased onto a list that already used it. git merges them as different lines of one
    // file and reports nothing, and neither PR's diff shows a collision — each is correct
    // against the tree it was written on. Found exactly that way: #3661 took
    // REQ-REVIEW-08 while #3861 also claimed it, and reverting that renumber CONSISTENTLY
    // (fragment plus the regenerated projection) left `gen-features --check`, `lint:ci`
    // and the pipeline suite all green with two REQ-REVIEW-08 entries standing.
    //
    // Nothing else in the repo reads REQ ids, so this is the only place the duplicate can
    // be caught. No fragment carries one today.
    const offenders = [];
    for (const f of corpus.fragments) {
      const ids = [...String(f.body).matchAll(/^-\s+(REQ-[A-Z0-9-]*\d)\s*:/gm)].map((m) => m[1]);
      const seen = new Set();
      for (const id of ids) {
        if (seen.has(id)) offenders.push(`${f.file} declares ${id} more than once`);
        seen.add(id);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('groups are ordered by their lowest-ordered member', () => {
    const orders = corpus.groups.map((g) => g.order);
    assert.deepEqual([...orders].sort((a, b) => a - b), orders);
    for (const g of corpus.groups) {
      assert.equal(g.order, Math.min(...g.sections.map((s) => s.order)), g.title);
    }
  });

  test('sections within a group are non-decreasing by order', () => {
    for (const g of corpus.groups) {
      const orders = g.sections.map((s) => s.order);
      assert.deepEqual([...orders].sort((a, b) => a - b), orders, g.title);
    }
  });

  test('every group note names a group that has members', () => {
    const groups = new Set(corpus.groups.map((g) => g.title));
    for (const note of corpus.notes.values()) assert.equal(groups.has(note.group), true, note.file);
  });

  test('the frozen ids that inbound documentation links depend on are still present', () => {
    // A representative slice of the frozen set, chosen because each one is
    // load-bearing for a DIFFERENT reason: the first id, the two live
    // non-integer ids, the decimal id, the off-by-one that a how-to guide
    // links, and the highest id at migration time. Renumbering any of these
    // breaks a published anchor. This list is append-only and no feature PR
    // needs to touch it.
    const frozen = ['1', '6.5', '27', '27a', '27b', '144', '168'];
    const have = new Set(corpus.fragments.map((f) => f.id));
    for (const id of frozen) assert.equal(have.has(id), true, `id ${id} was renumbered`);
  });

  test('the committed docs/FEATURES.md equals the generated projection', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(spliceIntoFeatures(doc, renderFeatures(corpus)), doc);
  });

  test('every generated TOC entry points at a heading the same render emits', () => {
    const region = renderFeatures(corpus);
    const emitted = new Set([
      ...corpus.groups.map((g) => g.anchor),
      ...corpus.fragments.map((f) => f.anchor),
    ]);
    // The TOC and the headings are two projections of ONE IR. This asserts
    // they cannot diverge — the drift that left `6.5`, `27a` and everything
    // from 163 up missing from the hand-written TOC.
    const linked = [...region.matchAll(/^\s*- \[[^\]]*]\(#([\w-]+)\)$/gm)].map((m) => m[1]);
    assert.equal(linked.length > 0, true);
    for (const anchor of linked) assert.equal(emitted.has(anchor), true, `#${anchor}`);
  });
});

// ---------------------------------------------------------------------------
// Typed violation vocabulary
// ---------------------------------------------------------------------------

describe('REASON', () => {
  test('locks the reason vocabulary so a new violation class ships with an identity', () => {
    assert.deepEqual(Object.keys(REASON).sort(), [
      'ANCHOR_DUPLICATE',
      'BODY_EMPTY',
      'BODY_FORGES_REGION_MARKER',
      'BODY_HEADING_TOO_SHALLOW',
      'DIRENT_NOT_REGULAR_FILE',
      'DIRENT_UNREADABLE',
      'FIELD_MISSING',
      'FIELD_UNKNOWN',
      'FILENAME_INVALID',
      'FRONTMATTER_MISSING',
      'GROUP_NOTE_DUPLICATE',
      'GROUP_NOTE_ORPHAN',
      'ID_DUPLICATE',
      'ID_INVALID',
      'INBOUND_ANCHOR_UNRESOLVED',
      'ORDER_INVALID',
    ]);
  });

  test('every reason value is unique', () => {
    const values = Object.values(REASON);
    assert.equal(new Set(values).size, values.length);
  });
});

// ---------------------------------------------------------------------------
// CLI behavior against synthetic corpora
// ---------------------------------------------------------------------------

describe('gen-features CLI', () => {
  test('--write then --check is a fixed point on a clean corpus', (t) => {
    const root = makeRepo(t, {
      'alpha.md': fragment('1', 'Alpha', 'Core Features'),
      'beta.md': fragment('2', 'Beta', 'Core Features'),
      'gamma.md': fragment('3', 'Gamma', 'Later Features'),
    });

    assert.equal(run(root, ['--check']).exitCode, 1, 'an ungenerated doc is stale');
    assert.equal(run(root, ['--write']).exitCode, 0);
    assert.equal(run(root, ['--check']).exitCode, 0);

    const rep = report(root);
    assert.equal(rep.ok, true);
    assert.equal(rep.featureCount, 3);
    assert.equal(rep.groupCount, 2);
    assert.equal(rep.indexStale, false);
  });

  test('adding a fragment makes --check fail until --write runs again', (t) => {
    const root = makeRepo(t, { 'alpha.md': fragment('1', 'Alpha', 'Core Features') });
    run(root, ['--write']);
    fs.writeFileSync(
      path.join(root, 'docs', 'features', 'delta.md'),
      fragment('2', 'Delta', 'Core Features'),
    );
    assert.equal(report(root).indexStale, true);
    assert.equal(run(root, ['--check']).exitCode, 1);
    assert.equal(run(root, ['--write']).exitCode, 0);
    assert.equal(run(root, ['--check']).exitCode, 0);
  });

  test('a duplicate id is a typed violation, not a silent second §N', (t) => {
    const root = makeRepo(t, {
      'alpha.md': fragment('7', 'Alpha', 'Core Features'),
      'beta.md': fragment('7', 'Beta', 'Core Features'),
    });
    const rep = report(root);
    assert.equal(rep.ok, false);
    assert.deepEqual(reasonsIn(rep), [REASON.ID_DUPLICATE]);
    assert.equal(run(root, ['--check']).exitCode, 1);
  });

  test('two DIFFERENT ids in the same group are accepted — the no-collision promise', (t) => {
    // The point of the whole change: an author may pick any unique id, so two
    // concurrent contributions never have to agree on a number.
    const root = makeRepo(t, {
      'alpha.md': fragment('3840', 'Alpha', 'Core Features'),
      'beta.md': fragment('3841', 'Beta', 'Core Features'),
      'base.md': fragment('1', 'Base', 'Core Features'),
    });
    const rep = report(root);
    assert.deepEqual(rep.violations, []);
    assert.equal(rep.featureCount, 3);
  });

  test('a non-contiguous, non-maximal id set is legal', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G'),
      'b.md': fragment('6.5', 'B', 'G'),
      'c.md': fragment('27b', 'C', 'G'),
      'd.md': fragment('900', 'D', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
  });

  test('an unparseable id is rejected', (t) => {
    const root = makeRepo(t, { 'a.md': fragment('12ab', 'A', 'G') });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ID_INVALID]);
  });

  test('a missing required field is rejected, naming the field', (t) => {
    const root = makeRepo(t, {
      'a.md': renderFrontmatter({ id: '1', title: 'A' }, 'body\n'),
    });
    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.FIELD_MISSING]);
    assert.equal(rep.violations[0].field, 'group');
  });

  test('an unknown frontmatter field is rejected rather than silently dropped', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { section: '4' }),
    });
    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.FIELD_UNKNOWN]);
    assert.equal(rep.violations[0].field, 'section');
  });

  test('a body that forges a heading is rejected with its line and depth', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', 'intro\n\n### 999. Forged'),
    });
    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.BODY_HEADING_TOO_SHALLOW]);
    assert.equal(rep.violations[0].depth, 3);
    assert.equal(rep.violations[0].line, 3);
  });

  test('a missing frontmatter block is rejected', (t) => {
    const root = makeRepo(t, { 'a.md': 'just a body\n' });
    assert.deepEqual(reasonsIn(report(root)), [REASON.FRONTMATTER_MISSING]);
  });

  test('an empty body is rejected', (t) => {
    const root = makeRepo(t, { 'a.md': renderFrontmatter({ id: '1', title: 'A', group: 'G' }, '\n') });
    assert.deepEqual(reasonsIn(report(root)), [REASON.BODY_EMPTY]);
  });

  test('a non-kebab filename is rejected', (t) => {
    const root = makeRepo(t, { 'Not_Kebab.md': fragment('1', 'A', 'G') });
    assert.deepEqual(reasonsIn(report(root)), [REASON.FILENAME_INVALID]);
  });

  test('a non-numeric order is rejected', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order: 'soon' }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID]);
  });

  // ---------------------------------------------------------------------------
  // `order` validation (#3840 follow-up): `Number()` coercion is far more
  // liberal than a docs ordering field has reason to be. `Number('')` is 0,
  // and `0x10`, `0b11`, `0o17`, `1e3`, `1.` and `.5` all coerce to finite
  // numbers — so a fragment declaring `order:` with nothing after it sorted
  // to position 0, ahead of every real feature, with zero violations.
  // ---------------------------------------------------------------------------

  test('an empty order is rejected, not coerced to zero', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order: '' }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID]);
  });

  test('a bare `order:` line is rejected too — the shape an author actually types', (t) => {
    // The reject rows above build `order` through renderFrontmatter, which
    // emits the QUOTED-empty form `order: ""`. A human types the bare form.
    // Both converge to '' at the validator; this pins that they do, so a
    // change to parseScalar's quoted branch cannot quietly split them.
    for (const line of ['order:', 'order:   ']) {
      const root = makeRepo(t, {
        'a.md': `---\nid: 1\ntitle: A\ngroup: G\n${line}\n---\n\n**Purpose:** x.\n`,
      });
      assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID], line);
    }
  });

  test('a non-decimal radix order is rejected', (t) => {
    for (const order of ['0x10', '0b11', '0o17']) {
      const root = makeRepo(t, {
        'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order }),
      });
      assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID], `order: ${order}`);
    }
  });

  test('an exponential order is rejected', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order: '1e3' }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID]);
  });

  test('a malformed decimal order is rejected', (t) => {
    for (const order of ['1.', '.5']) {
      const root = makeRepo(t, {
        'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order }),
      });
      assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID], `order: ${order}`);
    }
  });

  test('Infinity, NaN and separators stay rejected', (t) => {
    // Regression pin: these already fail today under plain Number() coercion
    // and must keep failing once order is validated by shape as well.
    for (const order of ['Infinity', 'NaN', '1_0']) {
      const root = makeRepo(t, {
        'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order }),
      });
      assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID], `order: ${order}`);
    }
  });

  test('an order that overflows to Infinity is rejected', (t) => {
    // The regex alone would admit this shape; the finite guard must still fire.
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order: '1'.repeat(400) }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID]);
  });

  test('accepts a plain integer order', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('5', 'A', 'G', '**Purpose:** x.', { order: '27' }),
      'b.md': fragment('1', 'B', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
    run(root, ['--write']);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // order 27 > B's default order (1), so A must render after B.
    assert.equal(doc.indexOf('### 5.') > doc.indexOf('### 1.'), true);
  });

  test('accepts an explicit zero order', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('5', 'A', 'G', '**Purpose:** x.', { order: '0' }),
      'b.md': fragment('9', 'B', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
    run(root, ['--write']);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // order 0 < B's default order (9), so A must render before B.
    assert.equal(doc.indexOf('### 5.') < doc.indexOf('### 9.'), true);
  });

  test('accepts a negative order', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('5', 'A', 'G', '**Purpose:** x.', { order: '-1' }),
      'b.md': fragment('1', 'B', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
    run(root, ['--write']);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // order -1 < B's default order (1), so A must render before B.
    assert.equal(doc.indexOf('### 5.') < doc.indexOf('### 1.'), true);
  });

  test('accepts a leading-plus order', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('5', 'A', 'G', '**Purpose:** x.', { order: '+3' }),
      'b.md': fragment('1', 'B', 'G'),
      'c.md': fragment('10', 'C', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
    run(root, ['--write']);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // order +3 sits between B's default order (1) and C's default order (10).
    assert.equal(doc.indexOf('### 1.') < doc.indexOf('### 5.'), true);
    assert.equal(doc.indexOf('### 5.') < doc.indexOf('### 10.'), true);
  });

  test('a quoted numeric order is accepted after unquoting', (t) => {
    // Built by writing the raw fragment text so the frontmatter line literally
    // reads `order: "27.2"`, rather than going through the `fragment()` helper
    // (which would double-quote a JS string value).
    const root = makeRepo(t, {
      'a.md': '---\nid: 5\ntitle: A\ngroup: G\norder: "27.2"\n---\n\n**Purpose:** x.\n',
      'b.md': fragment('1', 'B', 'G'),
    });
    assert.deepEqual(report(root).violations, []);
    run(root, ['--write']);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // order 27.2 > B's default order (1), so A must render after B.
    assert.equal(doc.indexOf('### 5.') > doc.indexOf('### 1.'), true);
  });

  test('an invalid id short-circuits before order validation', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('12ab', 'A', 'G', '**Purpose:** x.', { order: '' }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ID_INVALID]);
  });

  test('an invalid order short-circuits before the body check', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '', { order: '' }),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.ORDER_INVALID]);
  });

  test('each malformed order is reported per file', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G', '**Purpose:** x.', { order: '' }),
      'b.md': fragment('2', 'B', 'G', '**Purpose:** x.', { order: '' }),
    });
    const rep = report(root);
    assert.equal(rep.violations.length, 2);
    const files = rep.violations.map((v) => v.file).sort();
    assert.deepEqual(files, ['docs/features/a.md', 'docs/features/b.md']);
  });

  test('a malformed order refuses the write rather than reordering the document', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G'),
      'b.md': fragment('2', 'B', 'G'),
      'c.md': fragment('900', 'C', 'G', '**Purpose:** x.', { order: '' }),
    });
    const before = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(run(root, ['--write']).exitCode, 1);
    const after = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(after, before);
  });

  test('an explicit order overrides the id-derived default', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('27', 'A', 'G'),
      'b.md': fragment('27a', 'B', 'G', '**Purpose:** x.', { order: '27.2' }),
      'c.md': fragment('27b', 'C', 'G', '**Purpose:** x.', { order: '27.1' }),
    });
    run(root, ['--write']);
    assert.deepEqual(report(root).violations, []);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    // Position, not prose: 27b must precede 27a because its explicit order says so.
    assert.equal(doc.indexOf('### 27b.') < doc.indexOf('### 27a.'), true);
  });

  test('a group note for a group nobody belongs to is rejected', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'A', 'Core Features') },
      { notes: { 'ghost.md': renderFrontmatter({ group: 'Ghost Features' }, '> note\n') } },
    );
    assert.deepEqual(reasonsIn(report(root)), [REASON.GROUP_NOTE_ORPHAN]);
  });

  test('a group note renders above its first section', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'A', 'Core Features') },
      { notes: { 'core-features.md': renderFrontmatter({ group: 'Core Features' }, '> a note\n') } },
    );
    assert.equal(run(root, ['--write']).exitCode, 0);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(doc.indexOf('> a note') < doc.indexOf('### 1. A'), true);
    assert.equal(doc.indexOf('## Core Features') < doc.indexOf('> a note'), true);
  });

  test('an inbound anchor that no heading provides is rejected', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'Alpha', 'Core Features') },
      { extraDocs: { 'how-to/x.md': 'see [Alpha](../FEATURES.md#2-alpha)\n' } },
    );
    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.INBOUND_ANCHOR_UNRESOLVED]);
    assert.equal(rep.violations[0].anchor, '2-alpha');
    assert.equal(rep.violations[0].file, 'docs/how-to/x.md');
  });

  test('an inbound anchor that resolves is accepted', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'Alpha', 'Core Features') },
      { extraDocs: { 'how-to/x.md': 'see [Alpha](../FEATURES.md#1-alpha)\n' } },
    );
    assert.deepEqual(report(root).violations, []);
  });

  test('a locale sibling FEATURES.md is out of scope — matched by resolved target', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'Alpha', 'Core Features') },
      {
        extraDocs: {
          'ja-JP/FEATURES.md': '# 機能\n\n### 999. なにか\n',
          'ja-JP/README.md': 'see [x](FEATURES.md#999-something)\n',
        },
      },
    );
    assert.deepEqual(report(root).violations, []);
  });

  test('a missing generated-region marker fails loudly instead of writing nothing', (t) => {
    const root = makeRepo(t, { 'a.md': fragment('1', 'A', 'G') }, { doc: '# Features\n' });
    assert.equal(run(root, ['--write']).exitCode, 1);
    assert.equal(run(root, ['--check']).exitCode, 1);
  });

  test('--write repairs a corpus that --check rejects only for staleness', (t) => {
    const root = makeRepo(t, { 'a.md': fragment('1', 'A', 'G') });
    assert.equal(run(root, ['--write']).exitCode, 0);
    assert.equal(run(root, ['--check']).exitCode, 0);
  });

  test('--write REFUSES to emit a corrupt file when violations remain', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G'),
      'b.md': fragment('1', 'B', 'G'),
    });
    const docPath = path.join(root, 'docs', 'FEATURES.md');
    const before = fs.readFileSync(docPath, 'utf8');

    // Fail-closed. An earlier revision wrote the region anyway and exited 0,
    // warning only on stderr — so `--write && git commit` would commit a
    // FEATURES.md carrying two colliding `### 1.` sections.
    assert.equal(run(root, ['--write']).exitCode, 1);
    assert.equal(fs.readFileSync(docPath, 'utf8'), before, 'the file must be untouched');
  });

  test('--write --force overrides the refusal, deliberately and loudly', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G'),
      'b.md': fragment('1', 'B', 'G'),
    });
    const docPath = path.join(root, 'docs', 'FEATURES.md');
    const before = fs.readFileSync(docPath, 'utf8');

    const res = run(root, ['--write', '--force']);
    assert.equal(res.exitCode, 0);
    assert.notEqual(fs.readFileSync(docPath, 'utf8'), before);
    // --force does not launder the corpus: --check still fails.
    assert.equal(run(root, ['--check']).exitCode, 1);
  });

  test('--force alone does not suppress the violation report on a read-only run', (t) => {
    const root = makeRepo(t, {
      'a.md': fragment('1', 'A', 'G'),
      'b.md': fragment('1', 'B', 'G'),
    });
    // --force is scoped to --write; without it the gate still refuses.
    assert.equal(run(root, ['--force']).exitCode, 1);
    assert.equal(run(root, ['--check', '--force']).exitCode, 1);
  });

  test('no flags prints the region without touching the file', (t) => {
    const root = makeRepo(t, { 'a.md': fragment('1', 'A', 'G') });
    const before = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    const res = run(root);
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout.includes(START_MARKER), true);
    assert.equal(res.stdout.includes(END_MARKER), true);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8'), before);
  });

  test('an unrecognized flag fails closed rather than falling through to print', (t) => {
    const root = makeRepo(t, { 'a.md': fragment('1', 'A', 'G') });
    const res = run(root, ['--wirte']);
    assert.equal(res.exitCode, 1);
    assert.equal(res.stdout, '');
  });

  test('a fragment body that forges the END marker is rejected', (t) => {
    const root = makeRepo(t, {
      'evil.md': fragment('1', 'Evil', 'G', 'body\n\n<!-- FEATURES:END -->\n\nsmuggled tail'),
    });
    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.BODY_FORGES_REGION_MARKER]);
    assert.equal(rep.violations[0].marker, '<!-- FEATURES:END');
    assert.equal(run(root, ['--write']).exitCode, 1, 'must not be written');
  });

  test('a fragment body that forges the START marker is rejected', (t) => {
    const root = makeRepo(t, {
      'evil.md': fragment('1', 'Evil', 'G', 'body\n\n<!-- FEATURES:START whatever -->'),
    });
    assert.deepEqual(reasonsIn(report(root)), [REASON.BODY_FORGES_REGION_MARKER]);
  });

  test('a group note that forges a region marker is rejected too', (t) => {
    const root = makeRepo(
      t,
      { 'a.md': fragment('1', 'A', 'Core Features') },
      { notes: { 'core-features.md': renderFrontmatter({ group: 'Core Features' }, '<!-- FEATURES:END -->\n') } },
    );
    assert.deepEqual(reasonsIn(report(root)), [REASON.BODY_FORGES_REGION_MARKER]);
  });

  test('a stray END marker inside the region cannot shrink it — the LAST one wins', (t) => {
    // Defence in depth: the fragment gate above rejects a forged marker at the
    // source, but a marker that reaches docs/FEATURES.md some other way (a hand
    // edit, a bad merge) must still not become the de facto boundary and freeze
    // everything after it as hand-authored.
    const doc = [
      '# Features',
      '',
      START_MARKER,
      'stale body',
      END_MARKER,
      'MUST NOT SURVIVE',
      END_MARKER,
      '',
      '## Related',
      '',
    ].join('\n');
    const root = makeRepo(t, { 'a.md': fragment('1', 'Alpha', 'G') }, { doc });
    assert.equal(run(root, ['--write']).exitCode, 0);
    const after = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(after.includes('MUST NOT SURVIVE'), false);
    assert.equal(after.includes('## Related'), true, 'real trailing content is preserved');
    // Idempotent: a second write is a fixed point, so the forgery cannot recur.
    assert.equal(run(root, ['--check']).exitCode, 0);
  });

  test('a symlinked fragment is refused, not followed', { skip: symlinkSkip() }, (t) => {
    const root = makeRepo(t, { 'real.md': fragment('1', 'Real', 'G') });
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'SUPER-SECRET-BYTES\n');
    fs.symlinkSync(secret, path.join(root, 'docs', 'features', 'evil.md'));

    const rep = report(root);
    assert.deepEqual(reasonsIn(rep), [REASON.DIRENT_NOT_REGULAR_FILE]);
    assert.equal(rep.violations[0].file, 'docs/features/evil.md');
    // Fail-closed keeps the bytes out of the document; belt and braces, assert it.
    assert.equal(run(root, ['--write']).exitCode, 1);
    const doc = fs.readFileSync(path.join(root, 'docs', 'FEATURES.md'), 'utf8');
    assert.equal(doc.includes('SUPER-SECRET-BYTES'), false);
  });

  test('a symlinked group note is refused too', { skip: symlinkSkip() }, (t) => {
    const root = makeRepo(t, { 'a.md': fragment('1', 'A', 'G') });
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'SUPER-SECRET-BYTES\n');
    fs.symlinkSync(secret, path.join(root, 'docs', 'features', '_groups', 'g.md'));
    assert.deepEqual(reasonsIn(report(root)), [REASON.DIRENT_NOT_REGULAR_FILE]);
  });

  test('an empty corpus is not a crash', (t) => {
    const root = makeRepo(t, {});
    const rep = report(root);
    assert.equal(rep.featureCount, 0);
    assert.equal(rep.groupCount, 0);
    assert.deepEqual(rep.violations, []);
  });
});
