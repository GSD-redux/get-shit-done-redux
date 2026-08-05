'use strict';

// Producer-half of the async external-job contract (#1164 / #1105).
// The CORE consumer half (external_job_waiting) is covered by
// external-job-waiting.test.cjs. These tests assert the scheduler-adapter
// Capability's pure module: SLURM state mapping, manifest build/validate,
// sbatch/squeue/sacct parsers, and the fail-closed manifest writer that
// mirrors the consumer's duplicate-execution guard
// (docs/reference/planning-artifacts.md).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fc = require('fast-check');

const m = require('../gsd-core/bin/lib/external-job.cjs');
const {
  MANIFEST_VERSION,
  MANIFEST_STATUS,
  NON_TERMINAL_STATUSES,
  TERMINAL_FAILURE_STATUSES,
  mapSlurmState,
  buildManifest,
  validateManifest,
  parseSbatchParsable,
  parseSqueueLine,
  parseSacctRow,
  writeManifest,
  manifestPath,
} = m;

// ─── Closed status enum (Hyrum's Law: stability contract) ─────────────────────

test('MANIFEST_STATUS is the closed scheduler-agnostic enum from the contract', () => {
  assert.deepStrictEqual([...MANIFEST_STATUS].sort(), [
    'cancelled',
    'completed-unverified',
    'failed',
    'running',
    'submitted',
    'timeout',
  ]);
  assert.strictEqual(MANIFEST_VERSION, '1.0');
});

test('NON_TERMINAL / TERMINAL_FAILURE partition the enum without overlap', () => {
  for (const s of MANIFEST_STATUS) {
    const inNon = NON_TERMINAL_STATUSES.includes(s);
    const inTerm = TERMINAL_FAILURE_STATUSES.includes(s);
    // completed-unverified is neither non-terminal nor a failure — its own bucket.
    if (s === 'completed-unverified') {
      assert.ok(!inNon && !inTerm, 'completed-unverified is its own bucket');
    } else {
      assert.ok(inNon !== inTerm, `${s} must sit in exactly one partition`);
    }
  }
});

// ─── SLURM state mapping ──────────────────────────────────────────────────────

test('mapSlurmState maps every documented SLURM state to the closed enum', () => {
  const cases = {
    PENDING: 'submitted',
    CONFIGURING: 'submitted',
    RUNNING: 'running',
    COMPLETED: 'completed-unverified',
    COMPLETING: 'running',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    OUT_OF_MEMORY: 'failed',
    BOOT_FAIL: 'failed',
    NODE_FAIL: 'failed',
    PREEMPTED: 'failed',
  };
  for (const [slurm, expected] of Object.entries(cases)) {
    assert.strictEqual(mapSlurmState(slurm), expected, `${slurm} -> ${expected}`);
  }
});

test('mapSlurmState is case-insensitive and trims whitespace', () => {
  assert.strictEqual(mapSlurmState('running'), 'running');
  assert.strictEqual(mapSlurmState('  PENDING  '), 'submitted');
  assert.strictEqual(mapSlurmState('Cancelled'), 'cancelled');
});

test('mapSlurmState returns null for unknown states (no guessing)', () => {
  // Boundary: unknown must not collapse to a terminal failure silently.
  assert.strictEqual(mapSlurmState('NO_SUCH_STATE'), null);
  assert.strictEqual(mapSlurmState(''), null);
  assert.strictEqual(mapSlurmState('COMPLETED2'), null);
});

// ─── Manifest build ───────────────────────────────────────────────────────────

function baseInput() {
  return {
    plan_id: '3.1',
    phase: '3',
    job_id: '12345',
    backend: 'slurm',
    submit_command: 'sbatch --parsable ./run.sh',
    status: 'submitted',
    expected_artifacts: ['Artifacts/jobs/12345/result.h5'],
    verification_command: 'python -m verify.py 12345',
    resume_command: '/gsd:execute-phase 3',
  };
}

test('buildManifest stamps version and submitted_at via the clock seam', () => {
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const out = buildManifest(baseInput(), { clock });
  assert.strictEqual(out.version, '1.0');
  assert.strictEqual(out.submitted_at, '2020-06-15T12:00:00.000Z');
  assert.strictEqual(out.terminal_details, null, 'non-terminal -> null terminal_details');
  assert.strictEqual(out.plan_id, '3.1');
});

test('buildManifest rejects missing required fields', () => {
  for (const key of ['plan_id', 'phase', 'job_id', 'backend', 'submit_command', 'status', 'expected_artifacts', 'verification_command', 'resume_command']) {
    const bad = baseInput();
    delete bad[key];
    assert.throws(() => buildManifest(bad), { message: new RegExp(key) }, `missing ${key} must throw`);
  }
});

test('buildManifest rejects an out-of-enum status', () => {
  const bad = baseInput();
  bad.status = 'done';
  assert.throws(() => buildManifest(bad), /status/i);
});

test('buildManifest sets terminal_details when status is a terminal failure', () => {
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  for (const status of TERMINAL_FAILURE_STATUSES) {
    const input = { ...baseInput(), status, terminal_details: { reason: 'oom', exit_code: 137 } };
    const out = buildManifest(input, { clock });
    assert.deepStrictEqual(out.terminal_details, { reason: 'oom', exit_code: 137 }, `${status} carries terminal_details`);
  }
});

// ─── validateManifest (producer-side mirror of the trust boundary) ────────────

test('validateManifest accepts a well-formed manifest', () => {
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const res = validateManifest(buildManifest(baseInput(), { clock }));
  assert.strictEqual(res.ok, true);
});

test('validateManifest rejects bad version, status, and missing plan_id', () => {
  const good = buildManifest(baseInput(), { clock: { nowIso: () => '2020-06-15T12:00:00.000Z' } });
  const badVersion = { ...good, version: '9.9' };
  assert.strictEqual(validateManifest(badVersion).ok, false);
  const badStatus = { ...good, status: 'finished' };
  assert.strictEqual(validateManifest(badStatus).ok, false);
  const noPlan = { ...good };
  delete noPlan.plan_id;
  assert.strictEqual(validateManifest(noPlan).ok, false);
});

// ─── Parsers ──────────────────────────────────────────────────────────────────

test('parseSbatchParsable parses a bare number and a number;cluster form', () => {
  assert.deepStrictEqual(parseSbatchParsable('12345'), { ok: true, job_id: '12345' });
  assert.deepStrictEqual(parseSbatchParsable('12345;mycluster\n'), { ok: true, job_id: '12345' });
});

test('parseSbatchParsable fails closed on empty or non-numeric output', () => {
  assert.strictEqual(parseSbatchParsable('').ok, false);
  assert.strictEqual(parseSbatchParsable('Submitted batch job 12345').ok, false, 'non-parsable prose rejected');
  assert.strictEqual(parseSbatchParsable('abc;cluster').ok, false);
});

test('parseSqueueLine parses "<jobid> <state>" and returns null for malformed', () => {
  assert.deepStrictEqual(parseSqueueLine('12345 RUNNING'), { job_id: '12345', state: 'RUNNING' });
  assert.strictEqual(parseSqueueLine('header'), null);
  assert.strictEqual(parseSqueueLine(''), null);
});

test('parseSacctRow parses [jobid, state] columns', () => {
  assert.deepStrictEqual(parseSacctRow(['12345', 'COMPLETED']), { job_id: '12345', state: 'COMPLETED' });
  assert.strictEqual(parseSacctRow(['x']), null);
  assert.strictEqual(parseSacctRow([], ), null);
});

// ─── writeManifest (fail-closed duplicate guard + fs injection) ────────────────

function memFs(files = {}, opts = {}) {
  const store = new Map(Object.entries(files));
  const failReads = new Map(Object.entries(opts.failReads || {}));
  return {
    mkdirSync: () => undefined,
    readdirSync: (d) => {
      const set = store.get(d);
      return Array.isArray(set) ? set : [];
    },
    readFileSync: (p) => {
      if (failReads.has(p)) {
        throw new Error(failReads.get(p));
      }
      if (!store.has(p)) { const e = new Error('enoent'); e.code = 'ENOENT'; throw e; }
      return store.get(p);
    },
    writeFileSync: (p, c) => { store.set(p, c); },
    existsSync: (p) => store.has(p),
  };
}

test('manifestPath projects to .planning/async-jobs/<job>.json', () => {
  assert.strictEqual(
    manifestPath('.planning', '12345'),
    path.join('.planning', 'async-jobs', '12345.json'),
  );
});

test('writeManifest writes a new manifest and returns its path', () => {
  const fs = memFs({ [path.join('.planning', 'async-jobs')]: [] });
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, true);
  assert.ok(res.path.endsWith(path.join('async-jobs', '12345.json')));
  const written = JSON.parse(fs.readFileSync(res.path));
  assert.strictEqual(written.plan_id, '3.1');
});

test('writeManifest allows updating the SAME job_id (status progression)', () => {
  const dir = path.join('.planning', 'async-jobs');
  const existingPath = path.join(dir, '12345.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const submitted = buildManifest(baseInput(), { clock });
  const existing = { ...submitted };
  const fs = memFs({ [dir]: ['12345.json'], [existingPath]: JSON.stringify(existing) });
  const running = buildManifest({ ...baseInput(), status: 'running' }, { clock });
  const res = writeManifest(running, '.planning', { fs, clock });
  assert.strictEqual(res.ok, true, 'same job_id progression must be allowed');
});

test('writeManifest FAILS CLOSED when a different non-terminal job exists for the same plan_id', () => {
  // Duplicate-execution guard: a second dispatch for the same plan would
  // duplicate the external job. Mirror of planning-artifacts.md fail-closed.
  const dir = path.join('.planning', 'async-jobs');
  const otherPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const other = buildManifest({ ...baseInput(), job_id: '99999' }, { clock });
  const fs = memFs({ [dir]: ['99999.json'], [otherPath]: JSON.stringify(other) });
  const second = buildManifest({ ...baseInput(), job_id: '12345' }, { clock });
  const res = writeManifest(second, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'duplicate_plan_id');
});

test('writeManifest allows a NEW job once the prior plan_id job is terminal', () => {
  const dir = path.join('.planning', 'async-jobs');
  const otherPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const dead = buildManifest({ ...baseInput(), job_id: '99999', status: 'failed', terminal_details: { code: 1 } }, { clock });
  const fs = memFs({ [dir]: ['99999.json'], [otherPath]: JSON.stringify(dead) });
  const next = buildManifest({ ...baseInput(), job_id: '12345' }, { clock });
  const res = writeManifest(next, '.planning', { fs, clock });
  assert.strictEqual(res.ok, true, 'terminal prior job must not block a new dispatch');
});

test('writeManifest fails closed on a malformed existing manifest', () => {
  const dir = path.join('.planning', 'async-jobs');
  const brokenPath = path.join(dir, '12345.json');
  const fs = memFs({ [dir]: ['12345.json'], [brokenPath]: '{not json' });
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'malformed_existing');
});

// ─── writeManifest — negative-space: an incomplete duplicate scan (#3057) ─────
// A corrupt/unreadable SIBLING manifest must not be silently skipped: the
// duplicate scan cannot be trusted to have inspected it, so the write must
// refuse rather than risk dispatching a duplicate external job.

test('an unreadable sibling manifest refuses the write', () => {
  // A1
  const dir = path.join('.planning', 'async-jobs');
  const siblingPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs(
    { [dir]: ['99999.json'] },
    { failReads: { [siblingPath]: 'eio: input/output error' } },
  );
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'scan_incomplete');
  assert.strictEqual(res.offendingPath, siblingPath, 'offendingPath must name the unreadable file');
});

test('an unparseable sibling manifest refuses the write', () => {
  // A2
  const dir = path.join('.planning', 'async-jobs');
  const siblingPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs({ [dir]: ['99999.json'], [siblingPath]: '{not json' });
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'scan_incomplete');
  assert.strictEqual(res.offendingPath, siblingPath, 'offendingPath must name the unparseable file');
});

test('target and sibling failures stay distinct kinds', () => {
  // A3
  const dir = path.join('.planning', 'async-jobs');
  const targetPath = path.join(dir, '12345.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs({ [dir]: ['12345.json'], [targetPath]: '{not json' });
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'malformed_existing', 'the TARGET failure must stay malformed_existing, not scan_incomplete');
});

// A4 (paired): prove the sibling really holds a duplicate (control), then
// prove that making that SAME content unreadable still refuses (regression).

test('control: a readable sibling with a non-terminal duplicate plan_id is duplicate_plan_id', () => {
  // A4a — control. Same construction as the "FAILS CLOSED on duplicate
  // plan_id" test above: valid JSON, same plan_id, different job_id,
  // non-terminal status. This establishes the sibling content genuinely
  // triggers the duplicate guard when it CAN be read.
  const dir = path.join('.planning', 'async-jobs');
  const siblingPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const duplicate = buildManifest({ ...baseInput(), job_id: '99999' }, { clock });
  const fs = memFs({ [dir]: ['99999.json'], [siblingPath]: JSON.stringify(duplicate) });
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'duplicate_plan_id', 'the sibling content must be a real duplicate trigger when readable');
});

test('a corrupt sibling can no longer hide a duplicate dispatch', () => {
  // A4b — the bug, as a test. Same sibling PATH as the control above, which
  // that test proves can hold a genuine non-terminal duplicate for this
  // plan_id. Here the read itself faults (opts.failReads), so no content is
  // reachable at all — and that is the point: the guard now refuses on ANY
  // unreadable sibling precisely because it cannot know whether that file
  // was the duplicate. The control supplies the "it could have been"; this
  // supplies the "and we no longer gamble on it".
  //
  // Before the fix, an unreadable sibling was `continue`d past, the
  // duplicate was never seen, and this returned ok:true — dispatching a
  // duplicate external job.
  const dir = path.join('.planning', 'async-jobs');
  const siblingPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs(
    { [dir]: ['99999.json'] },
    { failReads: { [siblingPath]: 'eio: input/output error' } },
  );
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false, 'a corrupt sibling must refuse, not silently permit a possible duplicate dispatch');
  assert.strictEqual(res.kind, 'scan_incomplete');
});

test('happy path unaffected', () => {
  // A5
  const dir = path.join('.planning', 'async-jobs');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs({ [dir]: [] });
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, true);
});

test('a terminal prior job is still allowed', () => {
  // A6
  const dir = path.join('.planning', 'async-jobs');
  const otherPath = path.join(dir, '99999.json');
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const dead = buildManifest({ ...baseInput(), job_id: '99999', status: 'failed', terminal_details: { code: 1 } }, { clock });
  const fs = memFs({ [dir]: ['99999.json'], [otherPath]: JSON.stringify(dead) });
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, true, 'the duplicate guard only protects against re-dispatching live work');
});

test('a directory read failure is io_error, not scan_incomplete', () => {
  // A7
  const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
  const fs = memFs({}, { failReads: {} });
  fs.readdirSync = () => { throw new Error('eio: input/output error'); };
  const manifest = buildManifest(baseInput(), { clock });
  const res = writeManifest(manifest, '.planning', { fs, clock });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'io_error');
});

// ─── Property-based (CLAUDE.md: parsers/contracts need a fast-check test) ─────

test('property: mapSlurmState is total and idempotent over the known alphabet', () => {
  fc.assert(
    fc.property(fc.constantFrom(
      'PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'COMPLETED',
      'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'BOOT_FAIL', 'NODE_FAIL', 'PREEMPTED',
    ), (state) => {
      const a = mapSlurmState(state);
      const b = mapSlurmState(state);
      return a !== null && a === b && MANIFEST_STATUS.includes(a);
    }),
    { numRuns: 200 },
  );
});

test('property: buildManifest -> validateManifest round-trips for valid generated input', () => {
  fc.assert(
    fc.property(
      fc.record({
        plan_id: fc.stringMatching(/^[0-9]+\.[0-9]+$/),
        phase: fc.stringMatching(/^[0-9]+$/),
        job_id: fc.stringMatching(/^[0-9]{1,8}$/),
        backend: fc.constantFrom('slurm'),
        submit_command: fc.constantFrom('sbatch --parsable ./run.sh'),
        status: fc.constantFrom(...MANIFEST_STATUS),
        expected_artifacts: fc.array(fc.constantFrom('Artifacts/jobs/x/out.h5'), { minLength: 1 }),
        verification_command: fc.constantFrom('python -m verify.py'),
        resume_command: fc.constantFrom('/gsd:execute-phase 3'),
        terminal_details: fc.oneof(fc.constant(null), fc.record({ code: fc.integer() })),
      }),
      (input) => {
        const clock = { nowIso: () => '2020-06-15T12:00:00.000Z' };
        const td = input.status === 'completed-unverified' ? null : input.terminal_details;
        const built = buildManifest({ ...input, terminal_details: td }, { clock });
        return validateManifest(built).ok === true;
      },
    ),
    { numRuns: 100 },
  );
});
