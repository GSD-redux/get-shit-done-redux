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
 *   `extractFrontmatter` was then run over every git-tracked `*.md` file whose content
 *   opens with a byte-0 `---` fence, and each result was structurally serialized (see
 *   `tests/helpers/frontmatter-golden-serializer.cjs`, D2) and committed. This is a
 *   one-time capture: the compiled legacy module is not part of this repo and is not
 *   re-run by the suite below, which only ever reads the committed golden.
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
    file: '.changeset/archived/3593-cli-negative-matrix-harness.md',
    justification:
      "Legacy's top-level key regex could not match a leading `\"`, so it silently dropped "
      + 'the quoted key `"get-shit-done-cc"` and returned {}. js-yaml reads it. Defect fix.',
  },
  {
    file: '.changeset/archived/3594-parser-adversarial-fixtures.md',
    justification:
      "Legacy's top-level key regex could not match a leading `\"`, so it silently dropped "
      + 'the quoted key `"get-shit-done-cc"` and returned {}. js-yaml reads it. Defect fix.',
  },
  {
    file: '.changeset/archived/3595-fs-fault-injection-atomic-write.md',
    justification:
      "Legacy's top-level key regex could not match a leading `\"`, so it silently dropped "
      + 'the quoted key `"get-shit-done-cc"` and returned {}. js-yaml reads it. Defect fix.',
  },
  {
    file: '.changeset/archived/3621-cherry-pick-test-fixtures.md',
    justification:
      "Legacy's top-level key regex could not match a leading `\"`, so it silently dropped "
      + 'the quoted key `"get-shit-done-cc"` and returned {}. js-yaml reads it. Defect fix.',
  },
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

/** Every git-tracked *.md file whose content opens with a byte-0 `---` fence. */
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
  test('D1: every tracked frontmatter-carrying document has a golden entry', () => {
    const carrying = listFrontmatterCarryingFiles();
    const missing = carrying.filter((rel) => !(rel in golden));
    assert.deepEqual(
      missing,
      [],
      'frontmatter-carrying files with no golden entry (capture and commit an update to '
        + `tests/fixtures/golden/frontmatter-legacy-golden.json): ${JSON.stringify(missing)}`,
    );
    // Sanity: the golden set is the real ~901-document corpus, not a stub.
    assert.ok(Object.keys(golden).length > 800, `golden set looks too small: ${Object.keys(golden).length} entries`);
  });

  test('D1: every non-diverging tracked document matches its legacy-parser golden exactly', () => {
    const carrying = listFrontmatterCarryingFiles();
    const failures = [];
    for (const rel of carrying) {
      if (DIVERGING_FILES.has(rel)) continue;
      if (!(rel in golden)) continue; // reported by the coverage test above
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

  test('D1 sensor: an untracked-golden document is reported rather than silently skipped', () => {
    const fakeCarrying = ['this/path/does-not-exist-in-the-golden.md'];
    const missing = fakeCarrying.filter((rel) => !(rel in golden));
    assert.deepEqual(missing, fakeCarrying, 'a document absent from the golden must be reported as missing, not skipped');
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
