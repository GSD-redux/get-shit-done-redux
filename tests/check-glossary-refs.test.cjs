'use strict';

/**
 * Behavioral tests for scripts/check-glossary-refs.cjs — the CONTEXT.md
 * glossary drift gate (#2387).
 *
 * These drive the real CLI as a subprocess against synthetic CONTEXT.md /
 * bin/install.js fixtures in a temp dir, asserting on exit code and emitted
 * text. No source-grepping: the runtime behavior is the contract.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { copyScriptWithDeps } = require('./helpers/copy-script-fixture.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_REL = path.join('scripts', 'check-glossary-refs.cjs');

// The real bin/install.js allRuntimes array, mirrored here so fixtures can
// build both a matching and a deliberately-drifted CONTEXT.md against it.
const REAL_RUNTIMES = [
  'claude', 'antigravity', 'augment', 'cline', 'codebuddy', 'codex', 'copilot',
  'cursor', 'hermes', 'kimi', 'kilo', 'opencode', 'pi', 'qwen', 'trae', 'windsurf', 'zcode',
];

function allRuntimesSentence(count, members) {
  return `Runtime enum: \`allRuntimes\` (${count} values: ${members.join(', ')})`;
}

/**
 * Build a throwaway repo containing exactly what the gate reads: CONTEXT.md,
 * bin/install.js, a real src/ file a clean fixture can legitimately reference,
 * and a copy of the gate together with its transitive relative-require graph
 * (walked and copied by copyScriptWithDeps, not hand-listed — see that
 * helper's docstring for why: a hand-copied dependency list silently goes
 * stale the moment the script gains a new require). A unique mkdtemp per call
 * keeps parallel tests from colliding, and the dir is removed via `t.after()`
 * so a failing assertion cannot leak it.
 */
function makeRepo(t, { contextBody, runtimes = REAL_RUNTIMES }) {
  const root = createTempDir('gsd-glossary-refs-');
  t.after(() => cleanup(root));

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });

  copyScriptWithDeps(REPO_ROOT, root, SCRIPT_REL);

  fs.writeFileSync(path.join(root, 'CONTEXT.md'), contextBody);
  fs.writeFileSync(
    path.join(root, 'bin', 'install.js'),
    `'use strict';\nconst allRuntimes = [${runtimes.map((r) => `'${r}'`).join(', ')}];\nmodule.exports = { allRuntimes };\n`,
  );
  // A real file a clean CONTEXT.md fixture can legitimately reference.
  fs.writeFileSync(path.join(root, 'src', 'real-module.cts'), '// fixture\n');

  return root;
}

/** Run the gate in `root`; never throws — returns {status, stdout, stderr}. */
function run(root, args = []) {
  const res = spawnSync(process.execPath, [path.join(root, SCRIPT_REL), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('a clean CONTEXT.md whose refs resolve and whose allRuntimes matches passes --check', (t) => {
  const context = [
    '# Context',
    '',
    'See `src/real-module.cts` for details.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 0, `expected a clean pass: ${res.stderr}`);
  assert.match(res.stdout, /glossary references are current/);
});

test('a reference to a nonexistent tracked file fails --check and names the token', (t) => {
  const context = [
    '# Context',
    '',
    'See `src/does-not-exist.cts` for details.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /src\/does-not-exist\.cts/);
});

test('allRuntimes count and membership drift is caught', (t) => {
  // Mirrors the real-world case: CONTEXT.md says 15 while bin/install.js has 17.
  const claimed15 = REAL_RUNTIMES.filter((r) => r !== 'pi' && r !== 'zcode');
  assert.equal(claimed15.length, 15);
  const context = [
    '# Context',
    '',
    'See `src/real-module.cts` for details.',
    '',
    `${allRuntimesSentence(15, claimed15)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context }); // bin/install.js defaults to the real 17

  const res = run(root, ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /claims 15 values/);
  assert.match(res.stderr, /has 17/);
  assert.match(res.stderr, /pi/);
  assert.match(res.stderr, /zcode/);
});

test('a reference to a nonexistent gsd-core/bin/lib/*.cjs path is skipped (generated, gitignored)', (t) => {
  const context = [
    '# Context',
    '',
    'Generated router lives at `gsd-core/bin/lib/does-not-exist.cjs`.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 0, `generated bin/lib path must be skipped, not asserted missing: ${res.stderr}`);
});

test('an intentionally-absent documented path is skipped, not asserted missing', (t) => {
  // #2778. `tests/emitted-drift-ack.json` (ADR-2719 §3) is absent on a healthy
  // `next` BY DESIGN — it appears only inside a PR that needs it, which is what
  // makes touching it the alarm. Asserting its existence turns the correct state
  // into a drift finding. Under `tests/` it would otherwise be tracked, so this
  // is a real exemption rather than a prefix accident.
  const context = [
    '# Context',
    '',
    'The escape hatch is a committed acknowledgment (`tests/emitted-drift-ack.json`).',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(
    res.status, 0,
    `an intentionally-absent path must be skipped, not asserted missing: ${res.stderr}`,
  );
});

test('a sibling tests/ path that is merely missing is still caught', (t) => {
  // The exemption must be exact, not a blanket hole under `tests/`. A different
  // missing tests/ file must still fail, or #2778's fix would disarm the gate for
  // the whole directory.
  const context = [
    '# Context',
    '',
    'See `tests/emitted-drift-ack-typo.json` for details.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 1, 'a genuinely missing tests/ path must still be a finding');
  assert.match(`${res.stdout}${res.stderr}`, /emitted-drift-ack-typo\.json/);
});

test('a ~/-rooted path and a bare filename are both skipped', (t) => {
  const context = [
    '# Context',
    '',
    'See `~/.claude/x.md` and `core.cjs` for details.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 0, `home path and bare filename must be skipped, not asserted missing: ${res.stderr}`);
});

test('a `..`-traversal token cannot escape ROOT into a filesystem-existence probe', (t) => {
  // Security review finding: `src/../../../etc/passwd` passes PATH_TOKEN_RE (`.`
  // is a legal segment char) and the `src/` prefix, so without a confinement
  // check `path.join(ROOT, token)` normalizes out of the tree and existsSync
  // probes it — a doc lint turned filesystem oracle. It must be skipped, so the
  // gate neither errors nor reports a finding about an out-of-tree path.
  const context = [
    '# Context',
    '',
    'Escape attempt: `src/../../../../../../etc/passwd` and `src/../../etc/hosts`.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 0, `..-traversal tokens must be confined to ROOT and skipped: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /etc\/passwd|etc\/hosts/, 'a confined gate must not name out-of-tree paths');
});

test('the real script runs cleanly against the real repo without crashing', () => {
  // Does NOT assert the exit code — CONTEXT.md may still be mid-edit — only
  // that the gate itself runs to a real verdict (0 or 1), not an unhandled
  // crash (no status / non-2-shaped exit).
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, SCRIPT_REL), '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.error, undefined, `spawn must not error: ${res.error}`);
  assert.ok(res.status === 0 || res.status === 1, `expected exit 0 or 1, got ${res.status} (stderr: ${res.stderr})`);
});

// ---------------------------------------------------------------------------
// #3604 — backtick-pairing parity. extractTrackedRefs paired backticks in one
// whole-text pass, so (a) an odd-backtick line (the RULESET.* predicate format
// is backtick-wrapped and its values sometimes contain backticks) shifted the
// pairing of every later line, and (b) the fact-store predicate lines wrap the
// whole `CLASS.subkey=value` in ONE pair, hiding the real tests/… paths inside
// the span's value. A broken ref the gate cannot see is a gate that reports a
// false clean — the exact luck-based pass #2778's docstring warned about.
// ---------------------------------------------------------------------------

test('a broken tracked reference after a RULESET predicate with inner backticks is caught (#3604)', (t) => {
  // The predicate line carries an ODD backtick count (outer pair + one inner
  // unpaired tick), which desynchronized the old whole-text pairing. The broken
  // ref on a LATER line must still be found.
  const context = [
    '# Context',
    '',
    "`RULESET.TESTS.inner=this value breaks ` pairing for everything after it`",
    '',
    'Coverage lives in `src/does-not-exist.cts`.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const lf = run(root, ['--check']);
  assert.equal(lf.status, 1, 'a broken ref after a desynchronizing RULESET predicate must fail --check');

  // CRLF replay: the same verdict under \r\n (recurring class #1658/#1668/#2206).
  const rootCrlf = makeRepo(t, { contextBody: context.replace(/\n/g, '\r\n') });
  const crlf = run(rootCrlf, ['--check']);
  assert.equal(crlf.status, 1, 'CRLF input must yield the same verdict as LF');
});

test('tracked paths inside an outer-wrapped predicate span are extracted (#3604)', (t) => {
  // The line-647 shape: one backtick pair wraps the whole predicate, and the
  // VALUE carries two real paths. The resolving one must pass; the missing one
  // must be named. The old extractor read the whole span as one token (spaces
  // → rejected) and saw neither.
  const context = [
    '# Context',
    '',
    '`WORKTREE.SEAM.demo-anchor=src/real-module.cts + tests/missing-anchor.test.cjs`',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 1, 'a missing path inside a predicate value must fail --check');
  assert.match(`${res.stdout}${res.stderr}`, /tests\/missing-anchor\.test\.cjs/,
    'the finding must name the missing token, not the enclosing span');
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /real-module/,
    'the resolving sibling in the same span must not be reported');
});

test('glob and NNNN template mentions are not drift (#3604)', (t) => {
  // `scripts/gen-*.cjs`-style globs and the documented ADR filename template
  // (`docs/adr/NNNN-*.md`, CONTRIBUTING's "Do not compute a next number
  // locally") are legitimate mentions. A fragment ending in `-` or `.` is a
  // glob/template remnant, never a real path. The bare template shape
  // (`docs/adr/NNNN.md`, no dash-star) ends in a word char and ends the
  // final-char guard's reach — only the NNNN skip covers it.
  const context = [
    '# Context',
    '',
    '`RULESET.AUDIT.demo=search src/*.cts OR the scripts/gen-*.cjs generator`',
    '`RULESET.ADR-HEADER=every docs/adr/NNNN-*.md must open with Status and Date`',
    'A fresh ADR starts from `docs/adr/NNNN.md`.',
    'Retired scanners were `scripts/lint-*.cjs`.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 0, `glob and NNNN template fragments must be skipped: ${res.stderr}`);
});

test('retired-path exemptions are exact, not a blanket hole (#3604)', (t) => {
  // The emitted-attribution family retired by the #2724 cutover is documented
  // in CONTEXT.md as HISTORY ("Historically tests/fixtures/...") — absence is
  // the healthy steady state, the same semantics as the #2778 entry. But the
  // exemption must stay exact: a sibling missing tests/ path still fails.
  //
  // The NOT-mention must ride a PREDICATE span, mirroring CONTEXT.md's real
  // shape (RULESET.TESTS.eslint-harness): inside a predicate value the
  // sub-scan harvests `scripts/eslint-rules` WITHOUT the trailing slash, so
  // it is tracked-prefix-shaped and only the exemption saves it. Standalone
  // spans with trailing slashes never reach the exemption (PATH_TOKEN_RE
  // rejects them), which is exactly the vacuity this test must not have.
  const context = [
    '# Context',
    '',
    'Historically `tests/golden-install-parity.test.cjs` and `tests/workflow-size-baseline.json`.',
    '`RULESET.TESTS.harness=local plugin at eslint-rules/ (repo root, NOT scripts/eslint-rules/)`',
    'A typo sibling `tests/golden-install-parity-typo.test.cjs` is real drift.',
    '',
    `${allRuntimesSentence(17, REAL_RUNTIMES)}.`,
    '',
  ].join('\n');
  const root = makeRepo(t, { contextBody: context });

  const res = run(root, ['--check']);
  assert.equal(res.status, 1, 'the sibling typo must still be a finding');
  assert.match(`${res.stdout}${res.stderr}`, /golden-install-parity-typo/);
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /scripts\/eslint-rules/,
    'the contrastive NOT-mention inside a predicate value must be exempt');
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /workflow-size-baseline/,
    'the retired-path mention must be exempt');
});
