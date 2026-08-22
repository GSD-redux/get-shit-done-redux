'use strict';

/**
 * Anchors BOTH halves of the inventory-drift rule (`CLAUDE.md` → Inventory Drift:
 * "requires updating `docs/INVENTORY.md` AND running
 * `node scripts/gen-inventory-manifest.cjs --write`"):
 *
 *   1. `docs/INVENTORY-MANIFEST.json` matches the filesystem — the machine half.
 *      Fix by running: node scripts/gen-inventory-manifest.cjs --write
 *   2. `docs/INVENTORY.md` carries a roster row for every manifest entry — the human
 *      half (#3762). Fix by hand-writing the row.
 *
 * Until #3762 only half 1 existed, so a PR could ship a surface, regenerate the
 * manifest, omit the roster row, and pass CI green — while `docs/INVENTORY.md:3`
 * called itself "Authoritative roster of every shipped GSD surface" and
 * `docs/INVENTORY.md:681` promised "a new file without a matching row here will fail
 * CI". PR #3758 is the live instance: `gsd-core/references/planner-coupling.md`,
 * manifest entry present, roster row absent, CI 30 success / 0 failing.
 *
 * The roster comparison itself lives in `tests/helpers/inventory-roster.cjs` — read
 * its header for exactly which families are enforced, which two are deliberately
 * exempt, and what shapes a row may legally take. The fixture rows at the bottom of
 * this file drive that matcher directly, because the live assertion passes whenever
 * the repo is clean and therefore proves nothing about the comparison on its own.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const {
  ROSTER_SECTIONS,
  findMissingRosterRows,
  formatRosterFailure,
} = require('./helpers/inventory-roster.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'INVENTORY-MANIFEST.json');
const INVENTORY_PATH = path.join(ROOT, 'docs', 'INVENTORY.md');

// #2996: FAMILIES and NESTED_FAMILIES are IMPORTED, never redeclared. This file used to
// carry its own copy of the family table — the `DEFECT.GENERATIVE-FIX` divergence class:
// a family added to the generator but not here left this test silently verifying a
// subset while still reporting green. Importing makes divergence impossible rather than
// merely detectable.
const { FAMILIES, NESTED_FAMILIES, collectNested, collectOneLevelSubdirs } = require('../scripts/gen-inventory-manifest.cjs');

test('docs/INVENTORY-MANIFEST.json matches the filesystem', () => {
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const additions = [];
  const removals = [];

  for (const { name, dir, filter, toName } of FAMILIES) {
    const flat = fs.readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile() && filter(f))
      .map(toName);
    // `cli_modules` also ships one level of subdirectory modules (#3309); mirror
    // buildManifest's special-case merge exactly, or this test would report every
    // subdirectory file as a phantom removal.
    const nested = name === 'cli_modules' ? collectOneLevelSubdirs({ dir, filter }) : [];
    const live = new Set([...flat, ...nested]);
    const recorded = new Set((committed.families || {})[name] || []);

    for (const entry of live) {
      if (!recorded.has(entry)) additions.push(name + '/' + entry);
    }
    for (const entry of recorded) {
      if (!live.has(entry)) removals.push(name + '/' + entry);
    }
  }

  for (const family of NESTED_FAMILIES) {
    const live = new Set(collectNested(family));
    const recorded = new Set((committed.families || {})[family.name] || []);
    for (const entry of live) {
      if (!recorded.has(entry)) additions.push(family.name + '/' + entry);
    }
    for (const entry of recorded) {
      if (!live.has(entry)) removals.push(family.name + '/' + entry);
    }
  }

  const msg = [
    additions.length ? 'New surfaces not in manifest (run node scripts/gen-inventory-manifest.cjs --write):\n' + additions.map((e) => '  + ' + e).join('\n') : '',
    removals.length  ? 'Manifest entries with no matching file:\n'                                                  + removals.map((e) => '  - ' + e).join('\n') : '',
  ].filter(Boolean).join('\n');

  assert.ok(additions.length === 0 && removals.length === 0, msg);
});

// ─── #3762: the roster half ──────────────────────────────────────────────────

test('docs/INVENTORY.md carries a roster row for every manifest entry', () => {
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const inventory = fs.readFileSync(INVENTORY_PATH, 'utf8');
  const findings = findMissingRosterRows(inventory, committed.families);

  assert.ok(
    findings.missingSections.length === 0 && findings.missingRows.length === 0,
    formatRosterFailure(findings),
  );
});

// ─── Fixture rows: the gate must be able to FAIL, and only for the right reason ──

const FIXTURE_HEAD = '# Fixture\n\n';

/** Assemble a fixture document from `{heading: bodyText}`, optionally with CRLF endings. */
function doc(sectionsBySpec, { crlf = false } = {}) {
  let out = FIXTURE_HEAD;
  for (const [heading, body] of Object.entries(sectionsBySpec)) {
    out += '## ' + heading + '\n\n' + body + '\n\n';
  }
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** Every in-scope section present and empty, so a row supplies only the table it cares about. */
function emptySections(overrides = {}) {
  const spec = {};
  for (const heading of Object.values(ROSTER_SECTIONS)) spec[heading] = '(no rows)';
  return doc({ ...spec, ...overrides });
}

test('row 2 — the PR #3758 shape: a manifest reference with no roster row is reported', () => {
  // gsd-core/references/planner-coupling.md shipped in PR #3758 with a manifest entry,
  // all 19 tests/fixtures/install-tree/*.json updated, and no row in
  // §"Modular Planner Decomposition". That PR's CI was 30 success / 3 skipped / 0
  // failing. This row is the reason it would not be.
  const text = emptySections({
    References: '| Reference | Role |\n|---|---|\n| `checkpoints.md` | Checkpoint types. |',
  });
  const { missingSections, missingRows } = findMissingRosterRows(text, {
    references: ['checkpoints.md', 'planner-coupling.md'],
  });

  assert.deepStrictEqual(missingSections, []);
  assert.deepStrictEqual(missingRows, ['references/planner-coupling.md']);
});

test('row 3 — adding the row clears the report', () => {
  const text = emptySections({
    References:
      '| Reference | Role |\n|---|---|\n| `checkpoints.md` | Checkpoint types. |\n' +
      '| `planner-coupling.md` | Planner coupling rules. |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { references: ['checkpoints.md', 'planner-coupling.md'] }).missingRows,
    [],
  );
});

test('row 4 — a substring of a longer rostered cell is not a row', () => {
  // The real docs/INVENTORY.md rosters `host-integration-adapters/imperative-hook-bus.cjs`.
  // A substring match would report the separate, genuinely-unrostered top-level
  // `hook-bus.cjs` as satisfied — a false pass on a shipped module.
  const text = emptySections({
    'CLI Modules':
      '| Module | Responsibility |\n|---|---|\n' +
      '| `host-integration-adapters/imperative-hook-bus.cjs` | Imperative hook-bus adapter. |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, {
      cli_modules: ['host-integration-adapters/imperative-hook-bus.cjs', 'hook-bus.cjs'],
    }).missingRows,
    ['cli_modules/hook-bus.cjs'],
  );
});

test('row 5 — a row in another family section does not satisfy this family', () => {
  // `smart-entry.md` (a workflow) and `smart-entry.cjs` (a CLI module) are different
  // surfaces sharing a stem; an unscoped document-wide search conflates two families
  // the moment they ever do share a full name.
  const text = emptySections({
    'CLI Modules': '| Module | Responsibility |\n|---|---|\n| `smart-entry.md` | Wrong section. |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { workflows: ['smart-entry.md'] }).missingRows,
    ['workflows/smart-entry.md'],
  );
});

test('row 6 — a command row is matched on its Source link, not its display name', () => {
  const text = emptySections({
    Commands:
      '| Command | Role | Source |\n|---|---|---|\n' +
      '| `/gsd-workflow` | Phase pipeline router. | [commands/gsd/ns-workflow.md](../commands/gsd/ns-workflow.md) |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { commands: ['/gsd-ns-workflow'] }).missingRows,
    [],
    'the six namespace routers deliberately render a name that is not their file stem',
  );
});

test('row 7 — a command row without a Source link is not a row', () => {
  const text = emptySections({
    Commands: '| Command | Role | Source |\n|---|---|---|\n| `/gsd-quick` | Quick task. | (todo) |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { commands: ['/gsd-quick'] }).missingRows,
    ['commands//gsd-quick'],
  );
});

test('row 8 — an unbackticked agent cell is a row', () => {
  // Agents is the one family whose identity column carries a bare, unbackticked name.
  const text = emptySections({
    Agents:
      '| Agent | Role | Spawned by | Primary doc |\n|---|---|---|---|\n' +
      '| gsd-planner | Creates executable phase plans. | `/gsd-plan-phase` | primary |',
  });

  assert.deepStrictEqual(findMissingRosterRows(text, { agents: ['gsd-planner'] }).missingRows, []);
});

test('row 9 — trailing HTML comments and extra columns are tolerated', () => {
  const text = emptySections({
    'CLI Modules':
      '| Module | Responsibility | Extra |\n|---|---|---|\n' +
      '| `installer-migrations/003-rename.cjs` | Migration. | n/a |<!-- gsd-allow-legacy-name -->',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { cli_modules: ['installer-migrations/003-rename.cjs'] }).missingRows,
    [],
  );
});

test('row 10 — CRLF line endings are tolerated', () => {
  const spec = {};
  for (const heading of Object.values(ROSTER_SECTIONS)) spec[heading] = '(no rows)';
  spec.Hooks = '| Hook | Event | Purpose |\n|---|---|---|\n| `gsd-statusline.js` | `statusLine` | Statusline. |';
  const text = doc(spec, { crlf: true });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { hooks: ['gsd-statusline.js'] }).missingRows,
    [],
    'a \\n-only split leaves a trailing \\r on every cell and reds every Windows checkout',
  );
});

test('row 10b — a fenced code block does not split a section or contribute cells', () => {
  // docs/INVENTORY.md carries no fence today. The day someone documents a `## `
  // example inside one, an unfenced scanner truncates the family section at that
  // line and reds a document that is perfectly correct — and a pipe-delimited line
  // inside the fence would count as a row it is not.
  const text = emptySections({
    References:
      '```\n## References\n| `imposter.md` | not a row |\n```\n\n' +
      '| Reference | Role |\n|---|---|\n| `real.md` | Real. |',
  });

  assert.deepStrictEqual(
    findMissingRosterRows(text, { references: ['real.md', 'imposter.md'] }).missingRows,
    ['references/imposter.md'],
  );
});

test('row 11 — a missing family section is reported as a section failure', () => {
  const text = '# Fixture\n\n## Agents\n\n| Agent |\n|---|\n| gsd-planner |\n';
  const { missingSections, missingRows } = findMissingRosterRows(text, {
    agents: ['gsd-planner'],
    cli_modules: ['a.cjs', 'b.cjs', 'c.cjs'],
  });

  assert.deepStrictEqual(missingSections, ['Commands', 'Workflows', 'References', 'CLI Modules', 'Hooks']);
  assert.deepStrictEqual(
    missingRows,
    [],
    'a missing section is ONE structural failure, not one phantom row per entry inside it',
  );
});

test('row 12 — an empty family contributes nothing (limit-1)', () => {
  assert.deepStrictEqual(
    findMissingRosterRows(emptySections(), { references: [] }),
    { missingSections: [], missingRows: [] },
  );
});

test('row 13 — exactly one entry, rostered (limit)', () => {
  const text = emptySections({ References: '| Reference | Role |\n|---|---|\n| `only.md` | Only. |' });
  assert.deepStrictEqual(findMissingRosterRows(text, { references: ['only.md'] }).missingRows, []);
});

test('row 14 — one more entry than the roster carries is the one reported (limit+1)', () => {
  const text = emptySections({ References: '| Reference | Role |\n|---|---|\n| `only.md` | Only. |' });
  assert.deepStrictEqual(
    findMissingRosterRows(text, { references: ['only.md', 'extra.md'] }).missingRows,
    ['references/extra.md'],
  );
});

test('row 16 — nested step/mode families are deliberately out of scope', () => {
  // docs/INVENTORY.md §"Workflow Sub-Files": "Adding a step or mode file requires no
  // hand-written row here". If that decision is ever reversed, this row is what has to
  // change first — deliberately and in the open, rather than by widening
  // ROSTER_SECTIONS and discovering 62 red rows.
  assert.deepStrictEqual(
    findMissingRosterRows(emptySections(), {
      workflow_steps: ['quick/steps/a.md', 'quick/steps/b.md'],
      workflow_modes: ['discuss-phase/modes/default.md'],
    }),
    { missingSections: [], missingRows: [] },
  );
});

test('the failure message names every missing path and the remedy that satisfies it', () => {
  const rendered = formatRosterFailure({
    missingSections: [],
    missingRows: ['references/planner-coupling.md', 'cli_modules/hook-bus.cjs'],
  });

  assert.match(rendered, /references\/planner-coupling\.md/);
  assert.match(rendered, /cli_modules\/hook-bus\.cjs/);
  assert.match(
    rendered,
    /Regenerating the manifest does NOT satisfy this/,
    'the predictable wrong guess is "run the generator"; the message has to close that door',
  );
});

test('property — an entry is reported missing exactly when no cell in its section equals it', () => {
  const nameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}\.md$/);

  fc.assert(
    fc.property(
      fc.uniqueArray(nameArb, { minLength: 1, maxLength: 8 }),
      fc.uniqueArray(nameArb, { maxLength: 8 }),
      (rostered, candidates) => {
        // `candidates` may overlap `rostered`; the entries genuinely absent from the
        // table are exactly the set difference, and that is what the matcher must
        // return — no more (false red) and no fewer (false pass).
        const absent = candidates.filter((c) => !rostered.includes(c));
        const rows = rostered.map((n) => '| `' + n + '` | role |').join('\n');
        const text = emptySections({ References: '| Reference | Role |\n|---|---|\n' + rows });

        const { missingRows } = findMissingRosterRows(text, {
          references: [...rostered, ...absent],
        });

        assert.deepStrictEqual(
          missingRows.slice().sort(),
          absent.map((e) => 'references/' + e).sort(),
        );
      },
    ),
  );
});
