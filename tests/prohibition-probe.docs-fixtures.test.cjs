// allow-test-rule: source-text-is-the-product (see #644) — the rendered reference doc's worked-example
// vocab surface is the runtime contract; this pins its bijection to the source-of-truth fixtures (docs-parity).
//
// RED-first parity contract: the portable reference doc (gsd-core/references/prohibition-probe.md) keeps
// its worked-example JSON blocks in sync with the source-of-truth fixture files under
// gsd-core/references/prohibition-probe-fixtures/. The fixtures are the canonical data; the doc embeds
// copies. The comparison is PARSED JSON (deepEqual of JSON.parse on both sides), never a raw-text
// substring — a reformat that preserves the data does not fail, and any semantic drift does.
//
// The reference doc does not exist yet (plan 01-02 creates it and embeds the
// ```json prohibition-probe:<dir>/<file>``` blocks) — so this is EXPECTED RED now. NOTE for plan 01-02:
// it MUST embed matching tagged json blocks or this parity test stays red (the doc<->fixture contract).
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docPath = path.join(__dirname, '..', 'gsd-core', 'references', 'prohibition-probe.md');
const fixturesRoot = path.join(__dirname, '..', 'gsd-core', 'references', 'prohibition-probe-fixtures');

// Extract fenced blocks tagged ```json prohibition-probe:<dir>/<file> from the doc, keyed by ref.
// The \n? before the closing fence allows blocks whose closing fence has no preceding newline.
function taggedJsonBlocks(md) {
  const re = /```json prohibition-probe:([^\r\n]+)\r?\n([\s\S]*?)\r?\n?```/g;
  const out = {};
  let m;
  while ((m = re.exec(md))) out[m[1].trim()] = m[2];
  return out;
}

describe('prohibition-probe doc/fixture sync', () => {
  test('reference doc exists', () => {
    assert.ok(fs.existsSync(docPath), `${docPath} must exist`);
  });

  test('doc embeds a tagged fixture block for every expected.json fixture (count-equality)', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    const expectedCount = fs.readdirSync(fixturesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(dir => fs.existsSync(path.join(fixturesRoot, dir.name, 'expected.json')))
      .length;
    assert.strictEqual(
      Object.keys(blocks).length,
      expectedCount,
      `prohibition-probe.md must embed exactly ${expectedCount} tagged blocks (one per fixture expected.json)`
    );
  });

  test('every tagged doc block parses and deepEquals its fixture file', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    for (const [ref, body] of Object.entries(blocks)) {
      const fixtureFile = path.join(fixturesRoot, ref);
      const onDisk = fs.readFileSync(fixtureFile, 'utf8');
      assert.deepEqual(JSON.parse(body), JSON.parse(onDisk),
        `doc block prohibition-probe:${ref} must deepEqual ${fixtureFile}`);
    }
  });
});
