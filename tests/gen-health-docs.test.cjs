'use strict';

/**
 * gen-health-docs.cjs regression tests (#3309, "health.md's tables are
 * generated rather than hand-maintained, closing the 16-vs-30+ documentation
 * gap structurally").
 *
 * Every CLI-level test spawns the real generator (execFileSync) against a
 * temp copy of the shipped `gsd-core/workflows/health.md`, using the
 * generator's `--target <path>` override — never mutates the real committed
 * file. No fs monkeypatching is needed for these cases.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  buildErrorCodeRows,
  renderErrorCodesRegion,
  renderRepairActionsRegion,
  regenerateHealthMd,
  spliceRegion,
  compareCodes,
  PRECHECK_CODES,
  REMEDY_ACTION_ORDER,
  ERROR_CODES_START,
  ERROR_CODES_END,
} = require('../scripts/gen-health-docs.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-health-docs.cjs');
const SHIPPED_HEALTH_MD = path.join(ROOT, 'gsd-core', 'workflows', 'health.md');
const COMPILED_MODULE_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'health-diagnostic.cjs');

function loadRealRules() {
  // Real compiled RULES — build:lib is a pretest dependency for the whole
  // suite (package.json `pretest`), so this is always present by the time
  // node:test runs these files.
  return require(COMPILED_MODULE_PATH).RULES;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runGenHealthDocs(args, cwd = ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function copyShippedHealthMd(destDir) {
  const dest = path.join(destDir, 'health.md');
  fs.copyFileSync(SHIPPED_HEALTH_MD, dest);
  return dest;
}

// ─── CLI: --check / --write round trip ─────────────────────────────────────

describe('gen-health-docs.cjs --check / --write (CLI, --target fixture)', () => {
  test('--check passes on a freshly-written file', (t) => {
    const tmpRoot = createTempDir('gen-health-docs-');
    t.after(() => cleanup(tmpRoot));

    const target = copyShippedHealthMd(tmpRoot);

    const w = runGenHealthDocs(['--write', '--target', target]);
    assert.equal(w.code, 0, `stderr: ${w.stderr}`);

    const c = runGenHealthDocs(['--check', '--target', target]);
    assert.equal(c.code, 0, `--check must be clean immediately after --write; stderr: ${c.stderr}`);
    assert.match(c.stdout, /up to date/);
  });

  test('--check fails when the tagged region is stale (mutate a temp copy)', (t) => {
    const tmpRoot = createTempDir('gen-health-docs-');
    t.after(() => cleanup(tmpRoot));

    const target = copyShippedHealthMd(tmpRoot);

    // Mutate the committed, already-up-to-date table so it drifts from what
    // the generator would produce — a single row edit is enough.
    let content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('| E001 | error |'), 'sanity: shipped health.md must carry the E001 row');
    content = content.replace('| E001 | error |', '| E001 | error-STALE-MUTATION |');
    fs.writeFileSync(target, content, 'utf8');

    const c = runGenHealthDocs(['--check', '--target', target]);
    assert.equal(c.code, 1, 'a hand-mutated table must fail --check');
    assert.match(c.stderr, /is stale/);
    assert.match(c.stderr, /gen-health-docs\.cjs --write/);
  });

  test('--write on a stale copy regenerates it back to a clean --check', (t) => {
    const tmpRoot = createTempDir('gen-health-docs-');
    t.after(() => cleanup(tmpRoot));

    const target = copyShippedHealthMd(tmpRoot);
    let content = fs.readFileSync(target, 'utf8');
    content = content.replace('| W010 |', '| W010-DRIFTED |');
    fs.writeFileSync(target, content, 'utf8');

    const failedCheck = runGenHealthDocs(['--check', '--target', target]);
    assert.equal(failedCheck.code, 1, 'sanity: the mutated copy must fail --check first');

    const w = runGenHealthDocs(['--write', '--target', target]);
    assert.equal(w.code, 0, `stderr: ${w.stderr}`);

    const c = runGenHealthDocs(['--check', '--target', target]);
    assert.equal(c.code, 0, `stderr: ${c.stderr}`);
  });

  test('plain invocation (no flag) prints both tables to stdout and exits 0', () => {
    const r = runGenHealthDocs([]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\| Code \| Severity \| Description \| Repairable \|/);
    assert.match(r.stdout, /\| Action \| Effect \| Risk \|/);
  });

  test('an unrecognized flag exits 1 rather than silently falling through', () => {
    const r = runGenHealthDocs(['--bogus']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag/);
  });

  test('the shipped gsd-core/workflows/health.md already passes --check against the real repo', () => {
    const r = runGenHealthDocs(['--check']);
    assert.equal(r.code, 0, `the committed health.md must already be up to date; stderr: ${r.stderr}`);
  });
});

// ─── Row content: representative codes, including previously-undocumented ─

describe('gen-health-docs.cjs row content (representative codes)', () => {
  const rules = loadRealRules();

  test('produces a 34-row <error_codes> table: 31 rules + 3 pre-checks (E001, E010, I010)', () => {
    const rows = buildErrorCodeRows(rules);
    assert.equal(rows.length, 34);
    const codes = rows.map((r) => r.code);
    for (const precheck of PRECHECK_CODES) {
      assert.ok(codes.includes(precheck.code), `missing pre-check code ${precheck.code}`);
    }
  });

  test('W010 (previously-undocumented, agent-install) renders with its Rule-sourced description and Repairable=No', () => {
    const region = renderErrorCodesRegion(rules);
    const row = region.split('\n').find((line) => line.startsWith('| W010 |'));
    assert.ok(row, 'W010 row must be present');
    const w010Rule = rules.find((r) => r.code === 'W010');
    assert.ok(row.includes(w010Rule.description));
    assert.match(row, /\| No \|$/);
  });

  test('W026 (previously-undocumented, new post-migration split code) renders with its Rule-sourced description', () => {
    const region = renderErrorCodesRegion(rules);
    const row = region.split('\n').find((line) => line.startsWith('| W026 |'));
    assert.ok(row, 'W026 row must be present');
    const w026Rule = rules.find((r) => r.code === 'W026');
    assert.ok(row.includes(w026Rule.description));
  });

  test('E004 (already-documented, DESTRUCTIVE-risk remedy) renders with Repairable=No — --repair refuses to auto-apply regenerateState', () => {
    const region = renderErrorCodesRegion(rules);
    const row = region.split('\n').find((line) => line.startsWith('| E004 |'));
    assert.ok(row);
    assert.match(row, /\| No \|$/);
  });

  test('W018 renders the --backfill-qualified Repairable override, not a bare "Yes"', () => {
    const region = renderErrorCodesRegion(rules);
    const row = region.split('\n').find((line) => line.startsWith('| W018 |'));
    assert.ok(row);
    assert.match(row, /Yes \(`--backfill`\)/);
  });

  test('W025 (workflow-layer diagnostic, not a Rule) is absent from the generated table', () => {
    const region = renderErrorCodesRegion(rules);
    assert.ok(
      !region.split('\n').some((line) => line.startsWith('| W025 |')),
      'W025 must not appear as a generated row — it is documented in its own workflow step, not the RULES table',
    );
  });

  test('<error_codes> rows are sorted E-codes, then W-codes numerically, then I-codes', () => {
    const rows = buildErrorCodeRows(rules);
    const sorted = [...rows].sort(compareCodes);
    assert.deepEqual(rows, sorted, 'buildErrorCodeRows must already return its rows in sorted order');
    // Spot-check the three-group boundary explicitly.
    const codes = rows.map((r) => r.code);
    const lastE = codes.lastIndexOf(codes.filter((c) => c.startsWith('E')).at(-1));
    const firstW = codes.findIndex((c) => c.startsWith('W'));
    const lastW = codes.lastIndexOf(codes.filter((c) => c.startsWith('W')).at(-1));
    const firstI = codes.findIndex((c) => c.startsWith('I'));
    assert.ok(lastE < firstW, 'every E-code must sort before every W-code');
    assert.ok(lastW < firstI, 'every W-code must sort before every I-code');
  });

  test('renderRepairActionsRegion lists all 6 real repair actions, including the previously-undocumented addAiIntegrationPhaseKey', () => {
    const region = renderRepairActionsRegion();
    for (const action of REMEDY_ACTION_ORDER) {
      assert.ok(region.includes(`| ${action} |`), `missing repair action row: ${action}`);
    }
    assert.equal(REMEDY_ACTION_ORDER.length, 6);
    assert.ok(region.includes('addAiIntegrationPhaseKey'), '#3309: this action was "live in code, missing from docs"');
  });
});

// ─── spliceRegion / regenerateHealthMd — pure-function edge cases ─────────

describe('gen-health-docs.cjs spliceRegion (pure function)', () => {
  test('throws when a tag is missing', () => {
    assert.throws(
      () => spliceRegion('no tags here', ERROR_CODES_START, ERROR_CODES_END, 'x'),
      /missing the .*tags/,
    );
  });

  test('throws when a tag appears more than once', () => {
    const text = `${ERROR_CODES_START}a${ERROR_CODES_END}${ERROR_CODES_START}b${ERROR_CODES_END}`;
    assert.throws(() => spliceRegion(text, ERROR_CODES_START, ERROR_CODES_END, 'x'), /more than one/);
  });

  test('preserves content strictly outside the tags, byte-for-byte', () => {
    const before = 'PROSE BEFORE\n';
    const after = '\nPROSE AFTER';
    const text = `${before}${ERROR_CODES_START}old inner${ERROR_CODES_END}${after}`;
    const out = spliceRegion(text, ERROR_CODES_START, ERROR_CODES_END, 'new inner');
    assert.ok(out.startsWith(before + ERROR_CODES_START));
    assert.ok(out.endsWith(ERROR_CODES_END + after));
    assert.ok(!out.includes('old inner'));
    assert.ok(out.includes('new inner'));
  });

  test('regenerateHealthMd is idempotent: regenerating an already-generated document is a no-op', () => {
    const rules = loadRealRules();
    const shipped = fs.readFileSync(SHIPPED_HEALTH_MD, 'utf8');
    const regenerated = regenerateHealthMd(rules, shipped);
    assert.equal(regenerated, shipped);
  });
});
