'use strict';

/**
 * Golden parity over the real corpus (ADR-3473 §8.1, #3881, phase test-matrix §D).
 *
 * The parser moved from a hand-rolled line scanner to vendored js-yaml across ~900 real
 * documents. This suite proves nothing was silently changed by diffing the CURRENT
 * parser's output against a golden captured from the LEGACY parser, independently of it.
 *
 * Golden provenance (do NOT re-derive from the current parser — see D2):
 *   `tests/fixtures/golden/frontmatter-legacy-golden.json` was captured by compiling
 *   `src/frontmatter.cts` AS IT EXISTED AT COMMIT ddde001af (`git show
 *   ddde001af:src/frontmatter.cts`) standalone with tsc, against this repo's sibling
 *   support modules (`io.cjs`, `shell-command-projection.cjs`, `validate.cjs`,
 *   `text-lines.cjs`, `unusable-input.cjs`, `pattern.cjs`, `phase-id.cjs`) — all
 *   byte-identical between ddde001af and HEAD (`git diff ddde001af..HEAD --stat` over
 *   those paths is empty), so borrowing the current build of those pure helpers does not
 *   change what the legacy frontmatter parser itself computed. The legacy
 *   `extractFrontmatter` was then run over every git-tracked `*.md` file, EXCLUDING
 *   `.changeset/**` (see below), whose content opens with a byte-0 `---` fence, and each
 *   result was structurally serialized (see `tests/helpers/frontmatter-golden-serializer.cjs`,
 *   D2) and committed. This is a one-time capture: the compiled legacy module is not part
 *   of this repo and is not re-run by the suite below, which only ever reads the committed
 *   golden.
 *
 * `.changeset/**` is excluded from the corpus entirely (redesign, #3881 follow-up): a
 *   changeset fragment's `pr:` field is REQUIRED by this repo's own workflow to mutate from
 *   the placeholder `pr: 0` to the real PR number once `gh api POST /pulls` returns it
 *   (CONTRIBUTING.md, "PR Number Handling"). A snapshot keyed to a file that is mutable BY
 *   DESIGN can never be stable — every backfill would turn this suite red on a change that
 *   has nothing to do with the parser, and the standard response would become "regenerate
 *   the golden," which trains people to overwrite the very snapshot meant to catch a real
 *   regression. This is exactly what happened: `.changeset/jolly-geese-roar.md`'s normal
 *   `pr: 0` -> `pr: 3888` backfill turned this suite red although the parser did not change.
 *
 * A tracked, frontmatter-carrying `*.md` file with NO golden entry is tolerated (it did not
 *   exist at capture time) rather than failed — see D1's "post-capture" test below — so this
 *   suite also does not go red merely because the tree grew a new document. It still fails
 *   when a file THAT IS in the golden parses differently today, or has vanished from the
 *   tree entirely (D1's coverage-floor and vanished-file tests).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { serializeFrontmatterValue } = require('./helpers/frontmatter-golden-serializer.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'golden', 'frontmatter-legacy-golden.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/**
 * D3 — the closed list of known, deliberate divergences. Each entry's justification was
 * verified against a live run of the legacy parser (see the module doc above) as part of
 * writing this suite, not copied blind from the design doc.
 */
const DIVERGENCES = [
  {
    file: 'commands/gsd/add-tests.md',
    justification:
      'Legacy returned the block scalar indicator `"|"` as the literal value of '
      + '`argument-instructions` and invented a phantom top-level key `Example` from the '
      + "block's first content line. js-yaml parses the block scalar correctly and emits no "
      + 'such key. Defect fix (B1/B2).',
  },
  {
    file: 'gsd-core/templates/summary-complex.md',
    justification:
      "Legacy's per-line flattening of the `requires` list produced an array whose first "
      + 'item read `"phase: [prior phase]"` but which ALSO carried a named own property '
      + '`.provides = "[what that phase built]"` (Object.keys === ["0","provides"]) — the '
      + 'second `key: value` line of the same list item leaked onto the array as a sibling '
      + 'property instead of being folded into the item text. js-yaml + this repo\'s '
      + 'normalizer instead produce ONE combined string per item: '
      + '`"phase: [prior phase], provides: [what that phase built]"`. Canonicalization.',
  },
  {
    file: 'tests/fixtures/adversarial/frontmatter/anchor-alias-bomb.md',
    justification:
      'Legacy is a line scanner, not a YAML engine — it read `&a`/`*a`/`<<:` as inert literal '
      + 'text on each key\'s value, bounded and harmless. js-yaml resolves real YAML anchors '
      + 'and aliases, so consequence 6/A7 refuses the whole region outright (returns {} '
      + 'carrying FRONTMATTER_UNPARSEABLE) rather than risk expanding a hostile alias fan-out '
      + '(A8, billion-laughs). Deliberate refusal, not a defect.',
  },
  {
    file: 'tests/fixtures/adversarial/frontmatter/unicode-keys-and-values.md',
    justification: 'Legacy dropped the `相` key (B3: its key regex was not Unicode-aware). Defect fix.',
  },
  {
    file: 'tests/fixtures/representative/audit-uat/human-verification-frontmatter.md',
    justification:
      "Legacy's per-line flattening of the single-key `human_verification` list item left an "
      + 'unstripped opening quote character in the flattened value '
      + '(`test: "Confirm the widget renders correctly`, note the stray leading `"`). js-yaml '
      + 'produces the clean combined string `"test: Confirm the widget renders correctly"` '
      + 'with the quoting resolved. Canonicalization (same per-line-flattening family as the '
      + 'summary-complex.md row above; this document has only one key per item so no named '
      + 'array property appears here — the divergence is the stray-quote artifact instead).',
  },
];
const DIVERGING_FILES = new Set(DIVERGENCES.map((d) => d.file));

// Coverage floor for D1's "not vacuous" sensor (see below): the real, non-changeset,
// frontmatter-carrying corpus is ~376 documents as of this capture. Recording the exact
// count captured (rather than the ~880 figure that included .changeset/** before the
// redesign) so a broken enumeration that quietly compares a handful of files still fails
// loudly instead of silently degrading.
const COVERAGE_FLOOR = 350;

/**
 * Every git-tracked *.md file, EXCLUDING .changeset/** (mutable by design — see the module
 * doc above), whose content opens with a byte-0 `---` fence.
 */
function listFrontmatterCarryingFiles() {
  // `-c safe.directory=*` (process-scoped, never written to any config file) rather than
  // `git config --global --add safe.directory` (persistent, requires write access to a global
  // config, and races other concurrent test runs sharing the same HOME): the remote runner
  // clones/mounts this repo as a different UID than the process running the suite, which git
  // treats as "dubious ownership" and refuses to operate on at all — this test's ONLY read is
  // `ls-files`, so trusting the directory for this one invocation is sufficient and leaves no
  // side effect behind. `--` bounds the pathspec so `*.md` is never misread as a flag.
  const raw = execFileSync(
    'git',
    ['-c', 'safe.directory=*', 'ls-files', '--', '*.md'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 },
  );
  const files = raw.split('\n').filter(Boolean);
  const carrying = [];
  for (const rel of files) {
    if (rel.startsWith('.changeset/')) continue; // mutable by design; never a stable golden
    const abs = path.join(REPO_ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    if (content.startsWith('---\n') || content.startsWith('---\r\n')) carrying.push(rel);
  }
  return carrying;
}

/** Serialized current-parser output for one tracked, frontmatter-carrying file. */
function currentSerialized(rel) {
  const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  return serializeFrontmatterValue(extractFrontmatter(content));
}

describe('frontmatter golden parity over the real corpus (ADR-3473 §8.1, #3881, §D)', () => {
  test('D1: post-capture documents (no golden entry) are counted, not failed', () => {
    // A tracked, frontmatter-carrying document with no golden entry did not exist when the
    // snapshot was captured — that is ordinary tree growth, not a parity break, so it must
    // NOT fail this suite. It is only counted and surfaced (stdout, for visibility).
    const carrying = listFrontmatterCarryingFiles();
    const postCapture = carrying.filter((rel) => !(rel in golden));
    const compared = carrying.length - postCapture.length;
    console.log(`frontmatter-golden-parity: compared ${compared} golden entries, skipped ${postCapture.length} post-capture file(s)`);
    // Not a hard assertion (post-capture files are tolerated by design) — the coverage
    // floor test below is what guards against this silently degrading to vacuous.
    assert.equal(postCapture.length, carrying.length - compared);
  });

  test('D1: every golden entry\'s file is still present in the tracked corpus (no silent deletions)', () => {
    // The inverse direction DOES matter: a document that WAS captured and has since
    // vanished from the tree (deleted, renamed, or its frontmatter fence removed) is a
    // real regression worth noticing, so this direction stays a hard failure.
    const carrying = new Set(listFrontmatterCarryingFiles());
    const vanished = Object.keys(golden).filter((rel) => !carrying.has(rel));
    assert.deepEqual(
      vanished,
      [],
      'golden entries whose file no longer exists / no longer carries frontmatter in the '
        + `tracked corpus (a real deletion — investigate before regenerating the golden): ${JSON.stringify(vanished)}`,
    );
  });

  test('D1: golden coverage has not quietly degraded to near-vacuous', () => {
    // Coverage floor: if the enumeration breaks and only compares a handful of files, this
    // must fail loudly rather than pass with hollow coverage.
    const carrying = listFrontmatterCarryingFiles();
    const compared = carrying.filter((rel) => rel in golden).length;
    assert.ok(
      compared >= COVERAGE_FLOOR,
      `golden entries actually compared (${compared}) fell below the coverage floor `
        + `(${COVERAGE_FLOOR}) — the corpus enumeration or golden lookup is likely broken`,
    );
  });

  test('D1: every non-diverging tracked document matches its legacy-parser golden exactly', () => {
    const carrying = listFrontmatterCarryingFiles();
    const failures = [];
    for (const rel of carrying) {
      if (DIVERGING_FILES.has(rel)) continue;
      if (!(rel in golden)) continue; // post-capture file; reported by the test above
      const actual = currentSerialized(rel);
      if (actual !== golden[rel]) {
        failures.push({ file: rel, expected: golden[rel], actual });
      }
    }
    assert.deepEqual(
      failures,
      [],
      'undocumented parity divergence(s) — either the parser silently changed behavior, or '
        + 'this is a deliberate divergence missing from DIVERGENCES in this file: '
        + `${JSON.stringify(failures, null, 2)}`,
    );
  });

  test('D1 sensor: the parity check is not vacuous — a mutated golden value is caught', () => {
    // Prove the comparison in the row above can actually fail: take one real
    // non-diverging document, mutate its recorded golden value, and confirm the equality
    // check used above would reject it.
    const carrying = listFrontmatterCarryingFiles().filter((rel) => !DIVERGING_FILES.has(rel) && rel in golden);
    assert.ok(carrying.length > 0, 'expected at least one non-diverging tracked document to sensor-check against');
    const rel = carrying[0];
    const actual = currentSerialized(rel);
    const mutatedGolden = `${golden[rel]}__MUTATED__`;
    assert.notEqual(
      actual,
      mutatedGolden,
      'sensor failed: a mutated golden value must not equal the real parser output',
    );
  });

  test('D1 sensor: deleting a covered file\'s golden entry is a post-capture skip, not a false pass, and still erodes the coverage floor', () => {
    // A single golden entry going missing (as opposed to the FILE vanishing from the tree,
    // which the hard-failure test above catches) is indistinguishable, from this suite's
    // point of view, from that file being genuinely new — both present as "tracked file
    // with no golden entry". That is correct: it must be tolerated, not fail. What must NOT
    // happen is that deletion being silently absorbed as a genuine parity PASS for that
    // file (comparing nothing is not the same as comparing and matching) — and repeated
    // erosion of entries must still trip the coverage floor. Both are checked here directly
    // against the same functions the real tests use, on a COPY of the golden set (never
    // mutating the module-level `golden`).
    const carrying = listFrontmatterCarryingFiles().filter((rel) => !DIVERGING_FILES.has(rel));
    const rel = carrying.find((f) => f in golden);
    assert.ok(rel, 'expected at least one non-diverging tracked file with a golden entry to sensor-check against');
    const goldenWithoutEntry = { ...golden };
    delete goldenWithoutEntry[rel];

    // 1. Not a false pass: the file is no longer compared at all (it falls into the same
    //    "no golden entry" branch the real D1 parity test uses to skip), so nothing here
    //    can be read as "parser output matched golden" for this file.
    const wouldBeCompared = rel in goldenWithoutEntry;
    assert.equal(wouldBeCompared, false, 'sensor failed: a deleted golden entry must fall out of comparison, not falsely match');

    // 2. The coverage floor still sees the loss: comparing against goldenWithoutEntry
    //    yields exactly one fewer compared entry than the real golden.
    const comparedReal = carrying.filter((f) => f in golden).length;
    const comparedAfterDeletion = carrying.filter((f) => f in goldenWithoutEntry).length;
    assert.equal(
      comparedAfterDeletion,
      comparedReal - 1,
      'sensor failed: deleting one covered golden entry must reduce the compared count seen by the coverage-floor test',
    );
  });

  test('D3: every entry in the divergence list actually diverges from its golden today', () => {
    const stillMatching = [];
    for (const { file } of DIVERGENCES) {
      assert.ok(file in golden, `divergence entry ${file} has no golden entry to diverge from`);
      const actual = currentSerialized(file);
      if (actual === golden[file]) stillMatching.push(file);
    }
    assert.deepEqual(
      stillMatching,
      [],
      'entries in DIVERGENCES that no longer diverge must be REMOVED from the list (it must '
        + `never become a wildcard exemption): ${JSON.stringify(stillMatching)}`,
    );
  });

  test('D3: the divergence list has no entries outside the real, currently-tracked corpus', () => {
    const carrying = new Set(listFrontmatterCarryingFiles());
    const stale = DIVERGENCES.filter((d) => !carrying.has(d.file)).map((d) => d.file);
    assert.deepEqual(stale, [], `divergence entries for files no longer tracked/frontmatter-carrying: ${JSON.stringify(stale)}`);
  });

  test('D3: every divergence entry carries a non-empty one-line justification', () => {
    for (const { file, justification } of DIVERGENCES) {
      assert.ok(typeof justification === 'string' && justification.trim().length > 0, `${file} has no justification`);
    }
  });
});

describe('frontmatter golden serializer protects the gate itself (ADR-3473 §8.1, #3881, §D2)', () => {
  test('D2: JSON.stringify silently drops a named property on an Array', () => {
    // Reproduce the exact legacy shape: `k:\n  - test: a\n    other: b` parses to an
    // array whose element 0 is "test: a" and which ALSO carries `.other === "b"`.
    const namedArray = ['test: a'];
    namedArray.other = 'b';

    assert.equal(
      JSON.stringify(namedArray),
      '["test: a"]',
      'JSON.stringify must (still) silently drop the named array property — this pins the '
        + 'exact defect a JSON-based golden would have',
    );
  });

  test('D2: the structural serializer distinguishes a plain array from the same array carrying a named property', () => {
    const plainArray = ['test: a'];
    const namedArray = ['test: a'];
    namedArray.other = 'b';

    const plainSerialized = serializeFrontmatterValue(plainArray);
    const namedSerialized = serializeFrontmatterValue(namedArray);

    assert.notEqual(
      plainSerialized,
      namedSerialized,
      'the serializer must distinguish ["test: a"] from the same array carrying .other = "b"',
    );
    assert.ok(
      namedSerialized.includes('"other"') && namedSerialized.includes('"b"'),
      `named-property serialization must surface the property and its value; got: ${namedSerialized}`,
    );
    // And it must not have been captured by dropping straight to JSON.stringify.
    assert.notEqual(namedSerialized, JSON.stringify(namedArray));
  });

  test('D2: the named-array-property shape is real, not hypothetical — it appears in the captured golden', () => {
    // summary-complex.md's `requires` entry is captured golden proof this shape occurs on
    // a real, tracked document (verified live against the legacy parser while writing this
    // suite): its serialized golden value must carry a named-property tail.
    const rel = 'gsd-core/templates/summary-complex.md';
    assert.ok(rel in golden, 'expected summary-complex.md in the golden set');
    assert.ok(
      /"requires":\["[^"]*"\]\{"provides":/.test(golden[rel]),
      `expected the golden entry for ${rel} to carry a named-property tail on 'requires'; got: ${golden[rel]}`,
    );
  });
});
