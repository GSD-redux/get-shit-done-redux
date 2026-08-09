'use strict';

/**
 * capability-cli.test.cjs — behavioral tests for the `gsd capability` MANAGEMENT CLI
 * (ADR-1244 D5/D6): install / update / remove / list / disable / enable wired in
 * gsd-tools.cjs `case 'capability'` to the Phase-4 lifecycle + Phase-3 ledger.
 *
 * These exercise the REAL CLI end-to-end via runGsdTools (subprocess), the REAL
 * source resolver (local-path kind — no network), and a GSD_HOME-sandboxed global
 * scope so no developer state is touched. They are the contract the reference doc
 * (docs/reference/gsd-capability-command.md) is verified against.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const tmps = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
test.after(() => { for (const d of tmps) cleanup(d); });

/** A GSD_HOME-sandboxed env that also neutralizes ambient GSD_ vars (test hermeticity). */
function scopeEnv(home) {
  return { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
}

/** A cwd with a .planning/ root so findProjectRoot resolves cleanly. */
function makeCwd() {
  const cwd = tmpDir('cap-cli-cwd-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
  return cwd;
}

/** A project cwd whose config carries a given capabilities.strict_known_registries value. */
function makeCwdWithStrict(strictValue) {
  const cwd = tmpDir('cap-cli-cwd-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.planning', 'config.json'),
    JSON.stringify({ capabilities: { strict_known_registries: strictValue } }),
  );
  return cwd;
}

/**
 * Write a conformant local capability source dir and return its absolute path
 * (usable directly as an install <spec>). Declarative by default; pass `hooks`
 * (with materialized scripts) to make it an executable surface requiring consent.
 */
function writeCapSource(id, { version = '1.0.0', hooks = [], engines, mcp } = {}) {
  const src = tmpDir(`cap-cli-src-${id}-`);
  const cap = {
    id,
    role: 'feature',
    version,
    title: id,
    description: 'test capability',
    tier: 'standard',
    requires: [],
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks,
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
  if (engines) cap.engines = engines;
  if (mcp) cap.mcpServers = mcp; // object map { name: {command, ...} } — an executable surface
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
  for (const h of hooks) {
    if (h && h.script) {
      const p = path.join(src, h.script);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '// artifact', 'utf8');
    }
  }
  return src;
}

function ledgerPath(home) { return path.join(home, '.gsd-capabilities.json'); }
function capDir(home, id) { return path.join(home, '.gsd', 'capabilities', id); }
function readLedgerEntry(home, id) {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'));
    return l && l.entries && l.entries[id] ? l.entries[id] : null;
  } catch { return null; }
}
function parse(out) { return JSON.parse(out); }

// ─── install ────────────────────────────────────────────────────────────────

describe('capability install', () => {
  test('declarative local capability installs to the global scope and records the ledger', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('declcap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'installed');
    assert.equal(o.id, 'declcap');
    assert.equal(o.scope, 'global');
    assert.ok(readLedgerEntry(home, 'declcap'), 'ledger entry recorded');
    assert.ok(fs.existsSync(path.join(capDir(home, 'declcap'), 'capability.json')), 'bundle extracted');
  });

  test('executable capability WITHOUT --yes aborts for consent and writes nothing', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('execcap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'unconsented executable install must fail');
    assert.match(`${r.error}\n${r.output}`, /consent/i);
    assert.equal(readLedgerEntry(home, 'execcap'), null, 'no ledger entry');
    assert.ok(!fs.existsSync(capDir(home, 'execcap')), 'no install dir');
  });

  test('executable capability WITH --yes installs', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('execyes', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.equal(parse(r.output).status, 'installed');
    assert.ok(readLedgerEntry(home, 'execyes'), 'ledger entry recorded');
  });

  test('a reserved-namespace id is blocked', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('gsd-evil');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /blocked|reserved/i);
    assert.ok(!fs.existsSync(capDir(home, 'gsd-evil')));
  });

  test('an engines-incompatible capability is blocked', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('engcap', { engines: { gsd: '>=99.0.0' } });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /blocked/i);
    assert.equal(readLedgerEntry(home, 'engcap'), null);
  });

  test('missing <spec> is a usage error', () => {
    const r = runGsdTools(['capability', 'install'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <spec>/i);
  });

  test('an invalid --scope is rejected', () => {
    const src = writeCapSource('scopecap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'bogus'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Invalid --scope/i);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────

describe('capability list', () => {
  test('--json emits an array including first-party capabilities', () => {
    const r = runGsdTools(['capability', 'list', '--json'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, true, `list failed: ${r.error || r.output}`);
    const rows = parse(r.output);
    assert.ok(Array.isArray(rows), 'list is an array');
    const fp = rows.filter((x) => x.source === 'first-party');
    assert.ok(fp.length > 0, 'first-party capabilities present');
    assert.ok(fp.every((x) => typeof x.id === 'string' && x.scope === 'first-party'));
  });

  test('an installed overlay capability appears with its scope', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('listcap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'list', '--json'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `list failed: ${r.error || r.output}`);
    const row = parse(r.output).find((x) => x.id === 'listcap');
    assert.ok(row, 'installed capability listed');
    assert.equal(row.scope, 'global');
    assert.equal(row.source, src);
    assert.equal(row.version, '1.0.0');
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('capability update', () => {
  test('a not-installed id errors', () => {
    const r = runGsdTools(['capability', 'update', 'nope', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not installed/i);
  });

  test('requires <id> or --all', () => {
    const r = runGsdTools(['capability', 'update', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /requires <id> or --all/i);
  });

  test('<id> and --all are mutually exclusive', () => {
    const r = runGsdTools(['capability', 'update', 'foo', '--all', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not both/i);
  });

  test('an installed capability upgrades to a newer version from its recorded source', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('upcap', { version: '1.0.0' });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Bump the recorded source to a newer version, then update by id.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'upcap', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `update failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'upgraded');
    assert.equal(o.fromVersion, '1.0.0');
    assert.equal(o.toVersion, '2.0.0');
    assert.equal(readLedgerEntry(home, 'upcap').version, '2.0.0');
  });

  // Finding 4 (MEDIUM): `capability update --shared-file` over-cap previously ran the pre-op
  // reconcile (and re-parsed --shared-file per entry) BEFORE rejecting; install already had the early
  // guard, update did not. The count must now be enforced BEFORE capRunReconcile.
  //
  // To PROVE reconcile did not run, the ledger is intentionally CORRUPT: a reconcile sweep would
  // surface a "capability reconcile:" warning on stderr. The over-cap update must be rejected with a
  // count error and that reconcile prefix must be ABSENT (reconcile never executed).
  // Revert-fails: move the count check back below capRunReconcile (or drop it) → the corrupt-ledger
  // reconcile runs first and emits "capability reconcile:" on stderr, so the "prefix absent"
  // assertion fails (and/or the count error is missing).
  test('finding-4: an OVER-CAP --shared-file update is rejected BEFORE the pre-op reconcile runs', () => {
    const home = tmpDir('cap-cli-home-f4-');
    fs.mkdirSync(home, { recursive: true });
    // A corrupt ledger: if the pre-op reconcile RAN, it would emit a "capability reconcile:" warning.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');

    const sharedArgs = [];
    for (let i = 0; i < 300; i++) { sharedArgs.push('--shared-file', `f${i}.json`); } // over the 256 cap
    const r = runGsdTools(
      ['capability', 'update', '--all', '--scope', 'global', ...sharedArgs, '--raw'],
      makeCwd(), scopeEnv(home),
    );
    assert.equal(r.success, false, 'an over-cap --shared-file update must be rejected');
    const combined = `${r.error}\n${r.output}`;
    assert.match(combined, /shared.?file|count|too many|256/i,
      'the failure must clearly name the shared-file count problem');
    assert.doesNotMatch(combined, /capability reconcile:/i,
      'the pre-op reconcile must NOT have run — the count check precedes it (finding 4)');
  });
});

// ─── remove ─────────────────────────────────────────────────────────────────

describe('capability remove', () => {
  test('an installed overlay capability is removed (ledger + bundle gone)', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('rmcap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'remove', 'rmcap', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `remove failed: ${r.error || r.output}`);
    assert.equal(parse(r.output).status, 'removed');
    assert.equal(readLedgerEntry(home, 'rmcap'), null, 'ledger entry gone');
    assert.ok(!fs.existsSync(capDir(home, 'rmcap')), 'bundle gone');
  });

  test('a not-installed id errors', () => {
    const r = runGsdTools(['capability', 'remove', 'nope', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not installed/i);
  });

  test('a first-party capability cannot be removed here', () => {
    // Pick a real first-party id from the registry.
    const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
    const firstParty = Object.keys(reg.capabilities)[0];
    const r = runGsdTools(['capability', 'remove', firstParty, '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /first-party/i);
  });

  test('missing <id> is a usage error', () => {
    const r = runGsdTools(['capability', 'remove'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <id>/i);
  });
});

// ─── disable / enable ─────────────────────────────────────────────────────────

describe('capability disable / enable', () => {
  test('disable then enable a first-party capability toggles its activation state', () => {
    const cwd = makeCwd();
    const rcd = tmpDir('cap-cli-rcd-');
    const off = runGsdTools(['capability', 'disable', 'ui', '--config-dir', rcd, '--raw'], cwd);
    assert.equal(off.success, true, `disable failed: ${off.error || off.output}`);
    const ui = parse(off.output).capabilities.find((c) => c.id === 'ui');
    assert.equal(ui.enabled, false, 'ui disabled');
    const on = runGsdTools(['capability', 'enable', 'ui', '--config-dir', rcd, '--raw'], cwd);
    assert.equal(on.success, true, `enable failed: ${on.error || on.output}`);
    assert.equal(parse(on.output).capabilities.find((c) => c.id === 'ui').enabled, true, 'ui re-enabled');
  });

  test('disable without <id> is a usage error', () => {
    const r = runGsdTools(['capability', 'disable'], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <id>/i);
  });
});

// ─── unknown subcommand ───────────────────────────────────────────────────────

describe('capability (unknown)', () => {
  test('an unknown subcommand lists the full available set (incl. outdated)', () => {
    const r = runGsdTools(['capability', 'bogus'], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /install, update, remove, list, outdated, trust, disable, enable, state, set/);
  });
});

// ─── outdated (#1463) ───────────────────────────────────────────────────────

describe('capability outdated', () => {
  test('empty ledger → --json empty array; default table shows the empty marker', () => {
    const home = tmpDir('cap-cli-home-');
    const json = runGsdTools(['capability', 'outdated', '--scope', 'global', '--json'], makeCwd(), scopeEnv(home));
    assert.equal(json.success, true, `outdated --json failed: ${json.error || json.output}`);
    assert.deepEqual(parse(json.output), []);
    const table = runGsdTools(['capability', 'outdated', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(table.success, true, `outdated table failed: ${table.error || table.output}`);
    assert.match(table.output, /no installed overlay capabilities/i);
  });

  test('local source whose path now declares a newer version → status outdated (records shape)', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('outcap', { version: '1.0.0' });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Bump the recorded LOCAL source to a newer version — the peek re-reads it.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));

    const r = runGsdTools(['capability', 'outdated', '--scope', 'global', '--json'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `outdated failed: ${r.error || r.output}`);
    const rows = parse(r.output);
    const row = rows.find((x) => x.id === 'outcap');
    assert.ok(row, 'installed capability reported by outdated');
    // revert-fails: with the comparison inverted this would be 'current', not 'outdated'.
    assert.equal(row.status, 'outdated');
    assert.equal(row.current, '1.0.0');
    assert.equal(row.latest, '2.0.0');
    assert.equal(row.sourceKind, 'local');
    assert.equal(row.scope, 'global');
  });

  test('local source at the same version → status current; default emits a table with the row', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('samecap', { version: '1.0.0' });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'outdated', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `outdated failed: ${r.error || r.output}`);
    // Table form: header columns + the capability row with status current.
    assert.match(r.output, /ID\s+Source\s+Current\s+Latest\s+Status/);
    assert.match(r.output, /samecap\s+local\s+1\.0\.0\s+1\.0\.0\s+current/);
  });

  test('tarball source → status manual (not auto-detectable)', () => {
    // Plant a project-scope ledger entry with a tarball source directly (install would need network).
    const cwd = makeCwd();
    const ledgerMod = require('../gsd-core/bin/lib/capability-ledger.cjs');
    ledgerMod.recordInstall(cwd, {
      id: 'tarcap', version: '1.0.0', source: 'https://host/path/cap-1.0.0.tgz',
      integrity: '', files: ['.gsd/capabilities/tarcap'], sharedEdits: [],
    });
    const r = runGsdTools(['capability', 'outdated', '--scope', 'project', '--json'], cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
    assert.equal(r.success, true, `outdated failed: ${r.error || r.output}`);
    const row = parse(r.output).find((x) => x.id === 'tarcap');
    assert.ok(row, 'tarball capability reported');
    assert.equal(row.status, 'manual');
    assert.equal(row.latest, null);
  });

  test('invalid --scope is rejected', () => {
    const r = runGsdTools(['capability', 'outdated', '--scope', 'bogus'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Invalid --scope/i);
  });
});

// ─── review-hardening (adversarial-review fixes) ────────────────────────────

describe('capability install (trust hardening)', () => {
  test('an overlay reusing a first-party capability id is blocked', () => {
    // Pick a real first-party id and try to install an overlay that shadows it.
    const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
    const firstParty = Object.keys(reg.capabilities)[0];
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource(firstParty);
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /first-party capability id/i);
    assert.equal(readLedgerEntry(home, firstParty), null);
  });

  test('a malformed strict_known_registries value fails closed (does not downgrade to permissive)', () => {
    // A hand-edited string instead of an array must BLOCK an external source, not be ignored.
    const cwd = makeCwdWithStrict('github.com');
    const r = runGsdTools(['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'], cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /must be an array|blocked/i);
  });

  test('strict_known_registries: [] (lockdown) blocks an external source', () => {
    const cwd = makeCwdWithStrict([]);
    const r = runGsdTools(['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'], cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /external capability installs are disabled|blocked/i);
  });
});

describe('capability update (id-pinning + reporting)', () => {
  test('update refuses when the recorded source now resolves to a different id', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('orig');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Retarget the source to a different manifest id.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.id = 'switched';
    cap.version = '2.0.0';
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'orig', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /different capability id|refusing/i);
    // The original is untouched; nothing named 'switched' got installed.
    assert.equal(readLedgerEntry(home, 'orig').version, '1.0.0');
    assert.equal(readLedgerEntry(home, 'switched'), null);
  });

  test('update --all exits non-zero when any entry fails to upgrade', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('exupd', { hooks: [{ event: 'PostToolUse', script: 'hooks/a.js' }] });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Change the executable surface (new hook script) so the update needs re-consent.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    cap.hooks = [{ event: 'PostToolUse', script: 'hooks/b.js' }];
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    fs.writeFileSync(path.join(src, 'hooks', 'b.js'), '// artifact');
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'partial --all failure must be non-zero');
    assert.match(`${r.error}\n${r.output}`, /did not upgrade/i);
    // The aborted update left the old version intact.
    assert.equal(readLedgerEntry(home, 'exupd').version, '1.0.0');
  });

  test('a successful executable update reports the consented disclosure', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('discl', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0'; // same hook script => same exec set, no re-consent needed
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'discl', '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `update failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'upgraded');
    assert.ok(Array.isArray(o.disclosure) && o.disclosure.length > 0, 'disclosure reported');
  });
});

describe('capability disable (overlay boundary)', () => {
  test('disabling an unknown id (non-raw) reports the error on stderr and exits non-zero', () => {
    const rcd = tmpDir('cap-cli-rcd-');
    const r = runGsdTools(['capability', 'disable', 'totally-unknown-xyz', '--config-dir', rcd], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /unknown capability/i);
  });

  // Regression for the silent-stdout bug: a --raw command that writes a result/error envelope and
  // then throws (to set a non-zero exit) used to lose ALL of stdout — captureStdoutSyncWrites
  // buffered fd-1 output and discarded it on the throw path, and cmdCapabilitySet exited via
  // process.exit() (bypassing the wrapper). On the old code stdout was 0 bytes; now the JSON
  // error envelope is flushed to stdout AND the exit code stays non-zero.
  test('disabling an unknown id in --raw mode emits the JSON error envelope on stdout (not silent)', () => {
    const rcd = tmpDir('cap-cli-rcd-');
    const r = runGsdTools(['capability', 'disable', 'totally-unknown-xyz', '--config-dir', rcd, '--raw'], makeCwd());
    assert.equal(r.success, false, 'must exit non-zero');
    assert.ok(r.output && r.output.length > 0, 'stdout must NOT be empty in raw error mode');
    const out = JSON.parse(r.output);
    assert.ok(Array.isArray(out.errors), 'JSON error envelope present on stdout');
    assert.match(out.errors.join(' '), /unknown capability/i);
  });
});

// ─── --shared-file safety + config fail-closed (adversarial-review R2) ──────

describe('capability install (--shared-file confinement)', () => {
  test('a --shared-file whose parent is a symlink escaping the scope writes NOTHING outside it', () => {
    const home = tmpDir('cap-cli-home-');
    fs.mkdirSync(home, { recursive: true });
    const outside = tmpDir('cap-cli-outside-');
    // Plant a symlink inside the scope root pointing outside it.
    fs.symlinkSync(outside, path.join(home, 'evil'));
    const src = writeCapSource('symcap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--shared-file', 'evil/settings.json', '--raw'],
      makeCwd(), scopeEnv(home),
    );
    // Install still succeeds (the bundle installs); the unsafe shared-file edit is skipped.
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.ok(!fs.existsSync(path.join(outside, 'settings.json')), 'must NOT write through the escaping symlink');
  });

  // Finding 5(b) (MEDIUM): the --shared-file COUNT must be bounded EARLY — at the CLI/lifecycle
  // entry, BEFORE source resolution / staging / shared-config writes — so an over-cap install fails
  // fast with a clear count error instead of writing files + leaving a _pending to reconcile.
  // Revert-fails: remove the early count check in installCapability/gsd-tools → the install proceeds
  // to staging (a .gsd/capabilities/.staging dir is created) before any cap is enforced, so the
  // "no staging created" assertion fails (and there is no clear count error).
  test('finding-5b: an install with OVER-CAP --shared-file count is rejected BEFORE any staging dir is created', () => {
    const home = tmpDir('cap-cli-home-');
    fs.mkdirSync(home, { recursive: true });
    const src = writeCapSource('overcap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    // Build 300 --shared-file args (over the 256 generous cap).
    const sharedArgs = [];
    for (let i = 0; i < 300; i++) { sharedArgs.push('--shared-file', `f${i}.json`); }
    const r = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', ...sharedArgs, '--raw'],
      makeCwd(), scopeEnv(home),
    );
    assert.equal(r.success, false, 'an over-cap --shared-file install must be rejected');
    assert.match(`${r.error}\n${r.output}`, /shared.?file|count|too many|256/i,
      'the failure must clearly name the shared-file count problem');
    // NO staging dir may have been created — the bound is enforced before resolution/staging.
    const staging = path.join(home, '.gsd', 'capabilities', '.staging');
    assert.equal(fs.existsSync(staging) && fs.readdirSync(staging).length > 0, false,
      'no staging dir may be created when the over-cap install is rejected early');
    // NO ledger entry / _pending must be left behind.
    assert.equal(readLedgerEntry(home, 'overcap'), null, 'no ledger entry / _pending may be left');
    // NO shared-config file may have been written.
    assert.equal(fs.existsSync(path.join(home, 'f0.json')), false, 'no shared-config file may be written');
  });

  test('install does not clobber a user mcpServers entry whose name collides with the capability', () => {
    const home = tmpDir('cap-cli-home-');
    fs.mkdirSync(home, { recursive: true });
    // Pre-existing user settings with an mcpServers entry the capability will also declare.
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcpServers: { shared: { command: 'user-server' } } }));
    const src = writeCapSource('mcpcap', { mcp: { shared: { command: 'cap-server' } } });
    const r = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--shared-file', 'settings.json', '--raw'],
      makeCwd(), scopeEnv(home),
    );
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.mcpServers.shared.command, 'user-server', 'user mcpServers entry must be preserved, not clobbered');
  });
});

describe('capability install (config policy fail-closed)', () => {
  test('an unparseable project config fails CLOSED — an external source is blocked, not silently permitted', () => {
    const cwd = tmpDir('cap-cli-cwd-');
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{ this is not valid json');
    const r = runGsdTools(
      ['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'],
      cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' },
    );
    assert.equal(r.success, false, 'broken config must not silently permit an external install');
    assert.match(`${r.error}\n${r.output}`, /external capability installs are disabled|blocked|array/i);
  });
});

// ─── code-review coverage gaps ──────────────────────────────────────────────

describe('capability (argument + empty-state handling)', () => {
  test('update --all over an empty ledger succeeds with an empty result set', () => {
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, true, `update --all failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.deepEqual(o.updated, [], 'no installed capabilities → empty updated list');
  });

  test('a flag value that looks like another flag is rejected (no value swallowing)', () => {
    const src = writeCapSource('flagcap');
    // `--integrity --scope` — the value after --integrity is itself a flag, which must error, not be consumed.
    const r = runGsdTools(['capability', 'install', src, '--integrity', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing value for --integrity/i);
  });
});

// ─── corrupt-ledger fail-closed — list + remove (sites A and C) ─────────────

describe('capability list (corrupt ledger fail-closed — site A)', () => {
  test('capability list on a corrupt ledger exits non-zero with a blocked/corrupt error (finding-19)', () => {
    const home = tmpDir('cap-cli-home-list-corrupt-');
    fs.mkdirSync(home, { recursive: true });
    // Write a corrupt (unparseable) ledger file in the global scope location.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'global'], makeCwd(), scopeEnv(home));
    // Must exit non-zero (fail-closed — finding 19). A silent exit-0 is not acceptable.
    assert.equal(r.success, false, 'capability list must exit non-zero when the ledger is corrupt (fail-closed)');
    const combined = `${r.error}\n${r.output}`;
    assert.match(combined, /corrupt|blocked/i,
      'must mention corruption or blocked, not silently fail');
  });

  test('capability list --scope global: healthy global + corrupt project → exits zero (finding-8)', () => {
    // When --scope global is given, only the global ledger is read.
    // A corrupt project ledger must not block a global-only list.
    // Project scope runtimeDir = cwd (where .gsd-capabilities.json would live).
    const home = tmpDir('cap-cli-home-list-scoped-');
    fs.mkdirSync(home, { recursive: true });
    const cwd = makeCwd();
    // Write a corrupt ledger at the project scope location (cwd/.gsd-capabilities.json).
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), '{ broken project ledger ---');
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'global'], cwd, scopeEnv(home));
    // Global scope is healthy (no ledger = null = fine). Only the global scope is read.
    assert.equal(r.success, true, `list --scope global must succeed when only the project ledger is corrupt; got: ${r.error || r.output}`);
    const rows = parse(r.output);
    assert.ok(Array.isArray(rows), 'output must be a JSON array');
    // First-party capabilities must appear (they are always included).
    assert.ok(rows.some((x) => x.source === 'first-party'), 'first-party entries must appear');
  });

  test('capability list --scope project: corrupt project ledger exits non-zero (finding-8)', () => {
    const home = tmpDir('cap-cli-home-list-proj-corrupt-');
    fs.mkdirSync(home, { recursive: true });
    const cwd = makeCwd();
    // Project scope runtimeDir = cwd, so corrupt ledger goes at cwd/.gsd-capabilities.json.
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), '{ broken project ledger ---');
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, false, 'list --scope project must fail when the project ledger is corrupt');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i, 'must mention corruption');
  });
});

describe('capability remove (corrupt ledger fail-closed — site C)', () => {
  test('capability remove on a corrupt global ledger exits non-zero with a blocked/corrupt error, NOT not_installed or silent success', () => {
    const home = tmpDir('cap-cli-home-remove-corrupt-');
    fs.mkdirSync(home, { recursive: true });
    // Write a corrupt (unparseable) ledger file so the scope has one.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const r = runGsdTools(['capability', 'remove', 'some-cap', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'must exit non-zero on corrupt ledger');
    // Must NOT silently report "not installed" — that would hide the corruption.
    assert.doesNotMatch(`${r.error}\n${r.output}`, /not installed/i,
      'corrupt ledger must NOT produce "not installed" — must produce a blocked/corrupt error');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i,
      'must mention corruption or blocked');
  });

  test('capability remove first-party id on corrupt ledger surfaces corruption, not first-party error (finding-7)', () => {
    // Finding 7: with readLedger (old), a corrupt ledger + first-party id reports "first-party cannot be removed"
    // (hiding the corruption). With readLedgerStrict, corruption is surfaced first.
    const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
    const firstParty = Object.keys(reg.capabilities)[0];
    const home = tmpDir('cap-cli-home-f7-');
    fs.mkdirSync(home, { recursive: true });
    // Corrupt the ledger.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const r = runGsdTools(['capability', 'remove', firstParty, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'must exit non-zero on corrupt ledger');
    // Must NOT report "first-party" (which would hide the corruption).
    assert.doesNotMatch(`${r.error}\n${r.output}`, /first-party/i,
      'corrupt ledger must surface corruption, not first-party gate');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i,
      'must mention corruption or blocked');
  });

  test('capability remove on a corrupt project-scope ledger exits non-zero (finding-20)', () => {
    const home = tmpDir('cap-cli-home-remove-proj-corrupt-');
    fs.mkdirSync(home, { recursive: true });
    const cwd = makeCwd();
    // Project scope runtimeDir = cwd, so corrupt ledger goes at cwd/.gsd-capabilities.json.
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), '{ broken project json ---');
    const r = runGsdTools(['capability', 'remove', 'some-cap', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, false, 'must exit non-zero on corrupt project ledger');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i, 'must mention corruption or blocked');
  });
});

// ─── corrupt-ledger fail-closed (Codex pass 3 — medium #2) ──────────────────

describe('capability update (corrupt ledger fail-closed)', () => {
  test('capability update <id> on a corrupt ledger exits non-zero with a blocked/corrupt error, NOT not_installed', () => {
    const home = tmpDir('cap-cli-home-corrupt-');
    fs.mkdirSync(home, { recursive: true });
    // Write a corrupt (unparseable) ledger file.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const r = runGsdTools(['capability', 'update', 'some-cap', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'must exit non-zero on corrupt ledger');
    // Must NOT report "not installed" — that would hide the corruption silently.
    assert.doesNotMatch(`${r.error}\n${r.output}`, /not installed/i,
      'corrupt ledger must NOT produce "not installed" — must produce a blocked/corrupt error');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i,
      'must mention corruption or blocked');
  });

  test('capability update --all on a corrupt ledger exits non-zero, does NOT silently succeed with an empty list', () => {
    const home = tmpDir('cap-cli-home-corrupt-all-');
    fs.mkdirSync(home, { recursive: true });
    // Write a corrupt (unparseable) ledger file.
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'must exit non-zero on corrupt ledger for --all');
    assert.match(`${r.error}\n${r.output}`, /corrupt|blocked/i,
      'must mention corruption or blocked; not silently succeed');
  });
});

// ─── orthogonal adversarial review (#1462): UX / observability ──────────────

describe('capability update --all (UX-1: structured stdout on partial failure)', () => {
  test('UX-1: a partial --all failure emits {scope, updated:[...]} JSON on STDOUT and exits non-zero', () => {
    const home = tmpDir('cap-cli-home-ux1-');
    // Install an executable capability, then change its exec surface so the update needs re-consent
    // and (without --yes) ABORTS — a partial-failure --all run.
    const src = writeCapSource('ux1cap', { hooks: [{ event: 'PostToolUse', script: 'hooks/a.js' }] });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    cap.hooks = [{ event: 'PostToolUse', script: 'hooks/b.js' }];
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    fs.writeFileSync(path.join(src, 'hooks', 'b.js'), '// artifact');

    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    // Non-zero exit (partial failure).
    assert.equal(r.success, false, 'a partial --all failure must exit non-zero');
    // STRUCTURED data on STDOUT (not embedded in the error string) — UX-1.
    assert.ok(r.output && r.output.length > 0, 'structured result must be emitted on stdout');
    const parsed = JSON.parse(r.output);
    assert.equal(parsed.scope, 'global', 'stdout JSON must carry the scope');
    assert.ok(Array.isArray(parsed.updated), 'stdout JSON must carry the updated[] array');
    assert.ok(parsed.updated.some((x) => x.id === 'ux1cap' && x.status !== 'upgraded'),
      `updated[] must include the failed entry; got: ${JSON.stringify(parsed.updated)}`);
  });
});

describe('capability list (UX-3: corrupt-scope error names the scope)', () => {
  test('UX-3: a corrupt project-scope ledger error names the scope', () => {
    const home = tmpDir('cap-cli-home-ux3-');
    fs.mkdirSync(home, { recursive: true });
    const cwd = makeCwd();
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), '{ broken project ledger ---');
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, false, 'list --scope project must fail when the project ledger is corrupt');
    assert.match(`${r.error}\n${r.output}`, /\bproject\b/,
      `the corrupt-scope error must name the scope ("project"); got: ${r.error}\n${r.output}`);
  });
});

describe('capability install (UX-5: structured aborted/requiresConsent on stdout)', () => {
  test('UX-5: an executable install WITHOUT --yes in --raw mode emits a structured aborted envelope on stdout', () => {
    const home = tmpDir('cap-cli-home-ux5-');
    const src = writeCapSource('ux5cap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'an executable install without --yes must exit non-zero');
    assert.ok(r.output && r.output.length > 0, 'stdout must NOT be empty in raw aborted mode (UX-5)');
    const out = JSON.parse(r.output);
    assert.equal(out.status, 'aborted', 'structured stdout must carry status=aborted');
    assert.equal(out.requiresConsent, true, 'structured stdout must carry requiresConsent=true');
    assert.ok(Array.isArray(out.disclosure), 'structured stdout must carry the disclosure list');
  });
});

describe('capability update (UX-6: normalized per-entry fields)', () => {
  test('UX-6: a not_installed entry in --all output has explicit null fields (not undefined)', () => {
    // Seed a ledger with an entry whose recorded source resolves to a DIFFERENT id, so upgradeOne
    // reports a non-upgraded status with no fromVersion/toVersion — those must serialize as null.
    const home = tmpDir('cap-cli-home-ux6-');
    fs.mkdirSync(home, { recursive: true });
    // Hand-write a ledger entry pointing at a non-existent source so the update blocks.
    const ledger = {
      version: '1', updatedAt: new Date().toISOString(),
      entries: {
        'ux6cap': { id: 'ux6cap', version: '1.0.0', source: '/nonexistent/path/that/does/not/resolve', integrity: '', files: [], sharedEdits: [] },
      },
    };
    fs.writeFileSync(ledgerPath(home), JSON.stringify(ledger, null, 2));
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    // Partial failure (the blocked entry) → non-zero, structured stdout.
    assert.equal(r.success, false, 'a blocked --all entry must exit non-zero');
    const parsed = JSON.parse(r.output);
    const row = parsed.updated.find((x) => x.id === 'ux6cap');
    assert.ok(row, `updated[] must include ux6cap; got: ${JSON.stringify(parsed.updated)}`);
    // JSON.stringify omits undefined keys; explicit null is preserved. The fields must be present
    // as null (normalized), not absent.
    assert.ok('fromVersion' in row, 'fromVersion must be an explicit field (null), not omitted (UX-6)');
    assert.strictEqual(row.fromVersion, null, 'fromVersion must be null for a blocked entry (UX-6)');
    assert.ok('toVersion' in row, 'toVersion must be an explicit field (null), not omitted (UX-6)');
    assert.strictEqual(row.toVersion, null, 'toVersion must be null for a blocked entry (UX-6)');
  });
});

describe('capability install (UX-2: reconcile warnings surfaced on stderr)', () => {
  // Revert-fails: restore the bare `try{reconcile}catch{}` that discards the report → the distinctive
  // "capability reconcile:" warning prefix is never emitted to stderr, so this assertion fails. (The
  // install block reason references "corrupt" but NOT the reconcile-warning prefix, so the prefix
  // assertion is non-vacuous.)
  test('UX-2: a corrupt ledger detected by the pre-op reconcile is surfaced on stderr (not swallowed)', () => {
    const home = tmpDir('cap-cli-home-ux2-');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(ledgerPath(home), '{ broken json ---');
    const src = writeCapSource('ux2cap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'install on a corrupt ledger must exit non-zero');
    // The reconcile report's warning must be surfaced with its distinctive prefix on stderr — proving
    // the report was captured and emitted, not discarded in a bare try/catch.
    assert.match(`${r.error}\n${r.output}`, /capability reconcile:/i,
      'the pre-op reconcile warning must be surfaced on stderr with its prefix (UX-2)');
  });
});

// ─── #1459: user-owned consent store (trust list/revoke; inactive marking) ────

describe('capability consent store (#1459)', () => {
  const consentMod = require('../gsd-core/bin/lib/capability-consent.cjs');

  /** A project cwd that is its OWN project root (.planning) — project scope runtimeDir === cwd. */
  function projectCwd() {
    const cwd = tmpDir('cap-cli-proj-');
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
    return cwd;
  }

  test('project install lands the consent record under GSD_HOME, NOT under the project cwd', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('proj-consent-cap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    // Consent store is under the GSD_HOME-sandboxed home, not in the project repo.
    assert.ok(fs.existsSync(consentMod.consentStorePath(home)), 'consent store under GSD_HOME');
    assert.ok(!fs.existsSync(path.join(cwd, '.gsd', 'consent.json')), 'NOT written under the project cwd');
    const store = consentMod.readConsentStore(home);
    assert.equal(Object.keys(store.records).length, 1, 'one consent record written');
  });

  test('a consented project overlay shows status:active in `capability list`', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('proj-active-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    const row = parse(r.output).find((x) => x.id === 'proj-active-cap');
    assert.ok(row, 'consented project cap is listed');
    assert.equal(row.status, 'active', 'consented project overlay is active');
  });

  test('a planted project ledger with NO consent shows status:inactive in `capability list`', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    // Plant a committed-looking project ledger + bundle WITHOUT going through install (no consent).
    const capId = 'planted-cap';
    const dir = path.join(cwd, '.gsd', 'capabilities', capId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({
      id: capId, role: 'feature', version: '1.0.0', title: capId, description: 'd', tier: 'standard',
      requires: [], runtimeCompat: { supported: ['*'], unsupported: [] }, skills: [], agents: [],
      hooks: [], config: {}, steps: [], contributions: [], gates: [],
    }));
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), JSON.stringify({
      version: '1', updatedAt: '2026-01-01T00:00:00Z',
      entries: { [capId]: { id: capId, version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
    }));
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    const row = parse(r.output).find((x) => x.id === capId);
    assert.ok(row, 'planted cap is still LISTED (discovered)');
    assert.equal(row.status, 'inactive', 'a planted, unconsented project cap is marked inactive');
    assert.match(String(row.reason || ''), /consent/i, 'the inactive reason mentions consent');
  });

  test('IC-02: `capability list` marks inactive via the STRUCTURAL kind discriminant (not the reason prose)', () => {
    // revert-fails: if gsd-tools `list` filtered on /consent/i.test(reason) (the old prose match) AND
    // the loader's inactive warning omitted `kind`, this still passes by accident. To make it
    // anti-vacuous we (a) assert the loader emits the STRUCTURAL kind:'unconsented' (the discriminant
    // the filter must key on) and (b) assert the list marks the row inactive. Reverting the filter to
    // the prose match leaves (b) passing only because the prose still says "consent" — but reverting
    // the loader's `kind` tag makes (a) FAIL, and a future reason-prose change would break a
    // prose-matching filter while leaving (a) intact. The two together pin the kind path.
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const capId = 'kind-inactive-cap';
    const dir = path.join(cwd, '.gsd', 'capabilities', capId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({
      id: capId, role: 'feature', version: '1.0.0', title: capId, description: 'd', tier: 'standard',
      requires: [], runtimeCompat: { supported: ['*'], unsupported: [] }, skills: [], agents: [],
      hooks: [], config: {}, steps: [], contributions: [], gates: [],
    }));
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), JSON.stringify({
      version: '1', updatedAt: '2026-01-01T00:00:00Z',
      entries: { [capId]: { id: capId, version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
    }));
    // (a) The loader's overlay warning carries the structural discriminant kind:'unconsented'.
    const loader = require('../gsd-core/bin/lib/capability-loader.cjs');
    const savedHome = process.env.GSD_HOME;
    let reg;
    try {
      process.env.GSD_HOME = home;
      reg = loader.loadRegistry({ includeInstalled: true, cwd, gsdHome: home });
    } finally {
      if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
    }
    const warn = (reg._overlay && reg._overlay.warnings || []).find((w) => w.id === capId);
    assert.ok(warn, 'loader records a discovered-but-inactive warning for the unconsented cap');
    assert.equal(warn.kind, 'unconsented', 'the warning carries the structural kind discriminant');
    // (b) The CLI list marks the row inactive (via the kind-keyed filter).
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    const row = parse(r.output).find((x) => x.id === capId);
    assert.ok(row && row.status === 'inactive', 'list marks the unconsented cap inactive via kind');
  });

  test('IC-09: `capability trust list` exposes disclosureSignature + contentHash so operators can diff', () => {
    // revert-fails: drop disclosureSignature/contentHash from the trust-list row projection and these
    // field assertions fail. Operators need the stored binding to diff against the current bundle.
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('trust-fields-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'trust', 'list', '--json'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    const row = parse(r.output).find((x) => x.id === 'trust-fields-cap');
    assert.ok(row, 'consent record listed');
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'disclosureSignature'), 'disclosureSignature exposed');
    assert.ok(typeof row.contentHash === 'string' && /^sha512-/.test(row.contentHash), 'contentHash exposed (the security binding)');
  });

  test('capability trust list shows the consent record after a project install', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('trust-list-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'trust', 'list', '--json'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    const rows = parse(r.output);
    assert.ok(Array.isArray(rows) && rows.some((x) => x.id === 'trust-list-cap' && x.scope === 'project'), 'consent record listed');
  });

  test('capability trust revoke <id> removes the consent record (cap then lists inactive)', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('trust-revoke-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true);
    // Revoke.
    const rev = runGsdTools(['capability', 'trust', 'revoke', 'trust-revoke-cap', '--raw'], cwd, scopeEnv(home));
    assert.equal(rev.success, true, `${rev.error}\n${rev.output}`);
    assert.equal(consentMod.readConsentStore(home).records && Object.keys(consentMod.readConsentStore(home).records).length, 0, 'record removed');
    // The cap (bundle + ledger still present) now lists inactive.
    const list = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    const row = parse(list.output).find((x) => x.id === 'trust-revoke-cap');
    assert.ok(row && row.status === 'inactive', 'after revoke the cap is inactive');
  });

  test('finding 3: `trust revoke` with the consent-store lock HELD exits non-zero with a CLEAN message (not a raw stack)', () => {
    // revert-fails: without the CLI try/catch around revokeProjectConsent, the round-3 throw-on-no-lock
    // propagates to runMain, which prints a generic SDK/stack failure. The two assertions below — exit
    // non-zero AND a clean, actionable consent-lock message (no "at <fn> (<file>:<line>)" stack frame) —
    // FAIL when the throw is unhandled. The fix wraps it in error(...)/SDK_FAIL_FAST.
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('trust-locked-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true, 'install (records consent)');
    // Plant a FRESH, well-formed consent-store lock owned by THIS test process. A fresh lock (ts ≈ now,
    // age <= LOCK_STALE_MS) is NEVER stolen by the shared lock primitive, so the subprocess's bounded
    // waitForFresh budget exhausts and acquireConsentLock returns null → revokeProjectConsent throws.
    const lockPath = consentMod.consentLockPath(home);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const os = require('node:os');
    fs.writeFileSync(lockPath, JSON.stringify({ token: 'test-holder', pid: process.pid, hostname: os.hostname(), startTime: null, ts: Date.now() }), { flag: 'wx' });
    try {
      const rev = runGsdTools(['capability', 'trust', 'revoke', 'trust-locked-cap', '--raw'], cwd, scopeEnv(home));
      assert.equal(rev.success, false, 'a lock-held revoke exits non-zero');
      const combined = `${rev.error}\n${rev.output}`;
      assert.match(combined, /consent-store lock|consent store lock|another capability operation/i, 'clean, actionable lock message');
      assert.doesNotMatch(combined, /\bat \S+ \(.*:\d+:\d+\)/, 'no raw V8 stack frame leaked to the user');
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  });

  test('convergence-2: `capability list` with a FIFO project capability.json does not hang; the entry is omitted, exit clean', { skip: process.platform === 'win32' }, () => {
    // revert-fails: with the raw fs.readFileSync(path,'utf8') in the gsd-tools `list` metadata read,
    // reading the FIFO capability.json BLOCKS forever (no writer) → `capability list` hangs and the test
    // times out (runGsdTools never returns). The bounded reader (readSmallRegularFile) fstat-rejects the
    // FIFO BEFORE reading, so the list omits that entry and exits cleanly.
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const capId = 'fifo-list-cap';
    const dir = path.join(cwd, '.gsd', 'capabilities', capId);
    fs.mkdirSync(dir, { recursive: true });
    const { runHook } = require('./helpers/process-seam.cjs');
    const { throwIfFailed } = require('./helpers/git-fixture.cjs');
    const fifoPath = path.join(dir, 'capability.json');
    throwIfFailed(
      runHook(fifoPath, [], { interpreter: 'mkfifo', timeoutMs: 15000 }),
      `mkfifo ${fifoPath}`,
    );
    // A committed project ledger so the list iterates this entry (the FIFO is on the metadata-read path).
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), JSON.stringify({
      version: '1', updatedAt: '2026-01-01T00:00:00Z',
      entries: { [capId]: { id: capId, version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
    }));
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `list must exit cleanly (not hang) on a FIFO manifest: ${r.error}\n${r.output}`);
    const rows = parse(r.output);
    // The entry is LISTED (the ledger knows it) but with no metadata (null role/tier/title) since the
    // FIFO manifest could not be read; the key point is no hang and a clean exit.
    const row = rows.find((x) => x.id === capId);
    if (row) {
      assert.equal(row.role, null, 'FIFO manifest unreadable → no role metadata (omitted/marked)');
      assert.equal(row.title, null, 'FIFO manifest unreadable → no title metadata');
    }
  });

  test('convergence-2b: `capability list` with an OVERSIZED project capability.json does not OOM; entry omitted, exit clean', () => {
    // revert-fails: a raw readFileSync reads the whole oversized manifest into memory; the bounded reader
    // refuses a file past the cap so the metadata is dropped. The CONTROL (small valid manifest) proves
    // the same shape lists with metadata, so the dropped metadata is attributable to SIZE alone.
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const ctrlCwd = projectCwd();
    const mkManifest = (id, extra) => JSON.stringify({
      id, role: 'feature', version: '1.0.0', title: id, description: 'd', tier: 'standard',
      requires: [], runtimeCompat: { supported: ['*'], unsupported: [] }, skills: [], agents: [],
      hooks: [], config: {}, steps: [], contributions: [], gates: [], ...extra,
    });
    const ledgerFor = (id) => JSON.stringify({
      version: '1', updatedAt: '2026-01-01T00:00:00Z',
      entries: { [id]: { id, version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
    });
    // CONTROL: a small valid manifest lists WITH metadata.
    const ctrlDir = path.join(ctrlCwd, '.gsd', 'capabilities', 'small-list-cap');
    fs.mkdirSync(ctrlDir, { recursive: true });
    fs.writeFileSync(path.join(ctrlDir, 'capability.json'), mkManifest('small-list-cap'));
    fs.writeFileSync(path.join(ctrlCwd, '.gsd-capabilities.json'), ledgerFor('small-list-cap'));
    const ctrl = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], ctrlCwd, scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(ctrl.success, true, `${ctrl.error}\n${ctrl.output}`);
    const ctrlRow = parse(ctrl.output).find((x) => x.id === 'small-list-cap');
    assert.ok(ctrlRow && ctrlRow.role === 'feature' && ctrlRow.title === 'small-list-cap', 'CONTROL: a small manifest lists with metadata');
    // SUBJECT: an oversized manifest (>8 MiB) — bounded reader refuses; metadata dropped, no OOM.
    const capId = 'oversized-list-cap';
    const dir = path.join(cwd, '.gsd', 'capabilities', capId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), mkManifest(capId, { description: 'x'.repeat(9 * 1024 * 1024) }));
    fs.writeFileSync(path.join(cwd, '.gsd-capabilities.json'), ledgerFor(capId));
    const r = runGsdTools(['capability', 'list', '--json', '--scope', 'project'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `list must exit cleanly (not OOM) on an oversized manifest: ${r.error}\n${r.output}`);
    const row = parse(r.output).find((x) => x.id === capId);
    if (row) {
      assert.equal(row.role, null, 'oversized manifest refused → no role metadata');
      assert.equal(row.title, null, 'oversized manifest refused → no title metadata');
    }
  });

  test('capability remove (project scope) revokes the consent record', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = projectCwd();
    const src = writeCapSource('proj-remove-cap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'project', '--raw'], cwd, scopeEnv(home)).success, true);
    assert.equal(Object.keys(consentMod.readConsentStore(home).records).length, 1, 'consent present after install');
    const r = runGsdTools(['capability', 'remove', 'proj-remove-cap', '--scope', 'project', '--raw'], cwd, scopeEnv(home));
    assert.equal(r.success, true, `${r.error}\n${r.output}`);
    assert.equal(Object.keys(consentMod.readConsentStore(home).records).length, 0, 'remove revokes the consent record');
  });

  test('an unknown trust subcommand errors with guidance', () => {
    const r = runGsdTools(['capability', 'trust', 'bogus'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /trust/i);
  });
});

// ─── issue #2322: capability set --runtime materializes installed skills ──────

describe('issue-2322: capability set --runtime materializes an installed third-party capability skill end-to-end', () => {
  /**
   * A conformant local capability source that declares one owned skill
   * (`skills: [stem]`) and ships that skill's already-authored SKILL.md
   * verbatim under `skills/<stem>/SKILL.md` — mirroring the real on-disk
   * shape `capability install` copies into `~/.gsd/capabilities/<id>/`.
   */
  function writeCapSourceWithSkill(id, stem, skillContent, { tier = 'standard' } = {}) {
    const src = tmpDir(`cap-cli-src-${id}-`);
    const cap = {
      id,
      role: 'feature',
      version: '1.0.0',
      title: id,
      description: 'test capability with a skill',
      tier,
      requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [stem],
      agents: [],
      hooks: [],
      config: {},
      steps: [],
      contributions: [],
      gates: [],
    };
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const skillDir = path.join(src, 'skills', stem);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8');
    return src;
  }

  test('reproduces #2322: capability state reports surfaced:true but the skill is not written to <config-dir>/skills/', () => {
    const home = tmpDir('cap-cli-home-');
    const cwd = makeCwd();
    // #2322 MEDIUM-4: a fixture with NO rewrite-triggering content would pass
    // the byte-for-byte assertion below vacuously (it never proves the
    // runtime body rewrite pass — which DOES run over third-party skills too —
    // actually ran). Embed a `~/.claude/` reference so the later assertion
    // exercises that pass instead of asserting its absence.
    const AUTHORED = '---\nname: my-thing\ndescription: third-party test skill\n---\n\n# My Thing\nSee @~/.claude/workflows/example.md for details.\n';
    const src = writeCapSourceWithSkill('my-thing', 'my-thing', AUTHORED);

    // Step 2 of the issue repro: capability install ./capabilities/my-thing --yes
    const install = runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], cwd, scopeEnv(home));
    assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
    assert.equal(parse(install.output).status, 'installed');
    assert.ok(fs.existsSync(path.join(capDir(home, 'my-thing'), 'skills', 'my-thing', 'SKILL.md')), 'sanity: install copies the skill verbatim into the capabilities root');

    // Step 3 of the issue repro: capability set my-thing --runtime claude --scope global
    const rcd = tmpDir('cap-cli-rcd-');
    const setResult = runGsdTools(
      ['capability', 'set', 'my-thing', '--runtime', 'claude', '--scope', 'global', '--config-dir', rcd, '--raw'],
      cwd,
      scopeEnv(home),
    );
    assert.equal(setResult.success, true, `capability set failed: ${setResult.error || setResult.output}`);
    const setOut = parse(setResult.output);
    assert.deepEqual(setOut.errors, [], `capability set reported errors: ${JSON.stringify(setOut.errors)}`);

    // Step 4 of the issue repro: capability state --raw -> installed:true, surfaced:true
    const myThing = setOut.capabilities.find((c) => c.id === 'my-thing');
    assert.ok(myThing, 'my-thing present in the returned capability state');
    assert.equal(myThing.installed, true, 'installed:true (matches issue step 4)');
    assert.equal(myThing.surfaced, true, 'surfaced:true (matches issue step 4 — #2045 registry union already works)');

    // Step 5 of the issue repro: ls ~/.claude/skills/gsd-my-thing/ -> No such file or directory (THE BUG)
    const stagedPath = path.join(rcd, 'skills', 'gsd-my-thing', 'SKILL.md');
    assert.ok(
      fs.existsSync(stagedPath),
      `gsd-my-thing/SKILL.md must exist under ${rcd}/skills/ — capability state reports surfaced:true but nothing was materialized to disk (#2322)`,
    );
    const staged = fs.readFileSync(stagedPath, 'utf8');
    assert.notEqual(
      staged,
      AUTHORED,
      '#2322 MEDIUM-4: a third-party skill is NOT immune from the runtime-targeted body rewrite pass that runs over the whole stage dir (rewriteStagedSkillBodies) — a byte-for-byte-equal assertion here would be vacuous',
    );
    assert.ok(!staged.includes('~/.claude/'), 'the ~/.claude/ literal must have been rewritten to the resolved path prefix');
    assert.ok(staged.includes('workflows/example.md'), 'the rewrite must preserve the referenced path suffix, not corrupt the body');
  });
});
