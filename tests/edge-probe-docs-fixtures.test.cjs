// allow-test-rule: source-text-is-the-product
// the rendered reference/SPEC/ADR vocab surfaces are the runtime contract; this pins their bijection to the code (docs-parity)
// Asserts the portable reference doc (gsd-core/references/edge-probe.md) keeps its
// worked-example JSON blocks in sync with the source-of-truth fixture files under
// gsd-core/references/edge-probe-fixtures/. The fixtures are the canonical data; the
// doc embeds copies. Per the CONTRIBUTING.md exception matrix this is `docs-parity`: a
// reference doc must mirror source-defined data and there is no runtime enumeration API.
// The comparison is PARSED JSON (deepEqual of JSON.parse on both sides), never a raw-text
// substring match — so a reformat that preserves the data does not fail, and any semantic
// drift between doc and fixture does.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docPath = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe.md');
const fixturesRoot = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe-fixtures');
const adrPath = path.join(__dirname, '..', 'docs', 'adr', '550-spec-phase-probe-contract.md');
const specTemplatePath = path.join(__dirname, '..', 'gsd-core', 'templates', 'spec.md');

// Extract fenced blocks tagged ```json edge-probe:<dir>/<file> from the doc, keyed by ref.
// The \n? before the closing fence allows blocks whose closing fence has no preceding newline
// (fixes the silent-skip bug where a trailing-fence-with-no-newline was not matched).
function taggedJsonBlocks(md) {
  const re = /```json edge-probe:([^\r\n]+)\r?\n([\s\S]*?)\r?\n?```/g;
  const out = {};
  let m;
  while ((m = re.exec(md))) out[m[1].trim()] = m[2];
  return out;
}

describe('edge-probe doc/fixture sync', () => {
  test('reference doc exists', () => {
    assert.ok(fs.existsSync(docPath), `${docPath} must exist`);
  });

  test('doc embeds tagged fixture blocks for every expected-coverage.json fixture (count-equality)', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    // Count the expected-coverage.json files under the fixtures root (one per fixture dir).
    const expectedCount = fs.readdirSync(fixturesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(dir => fs.existsSync(path.join(fixturesRoot, dir.name, 'expected-coverage.json')))
      .length;
    assert.strictEqual(
      Object.keys(blocks).length,
      expectedCount,
      `edge-probe.md must embed exactly ${expectedCount} tagged blocks (one per fixture expected-coverage.json)`
    );
  });

  test('every tagged doc block parses and deepEquals its fixture file', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    for (const [ref, body] of Object.entries(blocks)) {
      const fixtureFile = path.join(fixturesRoot, ref);
      const onDisk = fs.readFileSync(fixtureFile, 'utf8');
      assert.deepEqual(JSON.parse(body), JSON.parse(onDisk),
        `doc block edge-probe:${ref} must deepEqual ${fixtureFile}`);
    }
  });
});

// m2: lock the machine↔SPEC vocabulary mapping so the two layers cannot silently drift. The
// machine contract uses orthogonal `status` × `verification`; the SPEC table and planner prose
// render a flat `covered/dismissed/backstop/unresolved`. The migration is documented in ADR-550
// Decision 7a and the reference's "Generic mapping" table, but the SPEC table is rendered by the
// LLM workflow (no JS renderer to round-trip against). So this pins the canonical map as code AND
// grounds it in every doc surface that renders the vocabulary — a renderer/parser drift fails here.
describe('edge-probe machine↔SPEC vocabulary mapping (m2 drift lock)', () => {
  // The canonical migration map (ADR-550 Decision 7a): machine state → SPEC display label.
  // `verification` is null for the lifecycle-only states (dismissed/unresolved).
  const MACHINE_TO_DISPLAY = [
    { status: 'resolved', verification: 'explicit', display: 'covered' },
    { status: 'resolved', verification: 'backstop', display: 'backstop' },
    { status: 'dismissed', verification: null, display: 'dismissed' },
    { status: 'unresolved', verification: null, display: 'unresolved' },
  ];
  const machineKey = (s, v) => `${s}|${v ?? '∅'}`;

  test('the mapping is a bijection — machine→display→machine is identity, no shared labels', () => {
    const toDisplay = new Map(MACHINE_TO_DISPLAY.map((m) => [machineKey(m.status, m.verification), m.display]));
    const fromDisplay = new Map(MACHINE_TO_DISPLAY.map((m) => [m.display, machineKey(m.status, m.verification)]));
    // No two machine states collapse onto the same display label (the silent-drift failure mode).
    assert.equal(toDisplay.size, MACHINE_TO_DISPLAY.length, 'each machine state must have a distinct key');
    assert.equal(fromDisplay.size, MACHINE_TO_DISPLAY.length, 'each display label must map back to exactly one machine state');
    // Round-trip identity.
    for (const m of MACHINE_TO_DISPLAY) {
      const key = machineKey(m.status, m.verification);
      assert.equal(fromDisplay.get(toDisplay.get(key)), key, `${key} must round-trip through its display label`);
    }
  });

  test('ADR-550 Decision 7a documents the resolved/explicit↔covered and resolved/backstop↔backstop migration', () => {
    const adr = fs.readFileSync(adrPath, 'utf8');
    assert.match(adr, /covered\b[^.]*resolved[^.]*explicit/i, 'ADR must document covered → {resolved, explicit}');
    assert.match(adr, /backstop\b[^.]*resolved[^.]*backstop/i, 'ADR must document backstop → {resolved, backstop}');
    assert.match(adr, /count-for-count|count-preserved/i, 'ADR must state coverage.resolved is count-preserved across the migration');
  });

  test('the SPEC template legend renders exactly the four canonical display labels', () => {
    const spec = fs.readFileSync(specTemplatePath, 'utf8');
    for (const { display } of MACHINE_TO_DISPLAY) {
      assert.match(spec, new RegExp(`\\b${display}\\b`, 'i'), `spec.md Edge Coverage legend must render the "${display}" label`);
    }
  });

  test('the reference Generic-mapping table distinguishes the resolved/explicit and resolved/backstop tiers', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    assert.match(md, /resolved`?\/`?explicit/i, 'reference must name the resolved/explicit tier in the mapping table');
    assert.match(md, /resolved`?\/`?backstop/i, 'reference must name the resolved/backstop tier in the mapping table');
  });
});
