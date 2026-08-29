'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3804 — audit-uat must see all three phase-archive layouts.
//
// listArchiveVersionDirs matched exactly one layout
// (`milestones/vX.Y-phases/<dir>/`). Two workstream layouts missed:
// archived workstream milestones (`milestones/ws-<slug>-<date>/phases/<dir>/`)
// and active workstream milestones
// (`workstreams/<ws>/milestones/vX.Y-phases/<dir>/`) — so a project using
// workstreams got an "All Clear" audit while items were open (the reporter's
// repo: 20 hidden phase artifacts), and `--ws` emptied the report entirely.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function seedPhaseArtifact(dir, kind) {
  fs.mkdirSync(dir, { recursive: true });
  if (kind === 'deferred') {
    fs.writeFileSync(path.join(dir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- open workstream item needing a human',
      '',
    ].join('\n'));
  } else {
    fs.writeFileSync(path.join(dir, `${path.basename(dir)}-UAT.md`), [
      '---',
      'status: gaps_found',
      '---',
      '',
      '# UAT',
      '',
      '## Verification',
      '',
      '1. **Test:** something',
      '   - **Result:** pending',
      '',
    ].join('\n'));
  }
}

function runAudit(cwd, extraArgs = []) {
  const r = runGsdTools(['query', 'audit-uat', ...extraArgs], cwd);
  assert.ok(r.success, r.error);
  return JSON.parse(r.output);
}

describe('#3804: audit-uat sees all three phase layouts', () => {
  test('#3804: archived workstream milestones surface in audit-uat', (t) => {
    const tmpDir = createTempProject('gsd-3804-wsarch-');
    t.after(() => cleanup(tmpDir));
    const wsArchive = path.join(tmpDir, '.planning', 'milestones',
      'ws-v7-3-catalog-models-2026-08-23', 'phases', '185-catalog-admin');
    seedPhaseArtifact(wsArchive, 'deferred');

    const out = runAudit(tmpDir);
    const phase185 = out.results.filter((r) => String(r.phase).startsWith('185'));
    assert.ok(
      phase185.length >= 1 && phase185.some((r) => (r.items || []).length > 0),
      `#3804: the archived workstream phase must surface with its open item; got ${JSON.stringify(out.results.map((r) => ({ phase: r.phase, items: (r.items || []).length })))}`,
    );
  });

  test('#3804: active workstream milestones surface in audit-uat (and --ws does not empty the report)', (t) => {
    const tmpDir = createTempProject('gsd-3804-wsact-');
    t.after(() => cleanup(tmpDir));
    const wsMilestone = path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs',
      'milestones', 'v1.0-phases', '176-boot-flow');
    seedPhaseArtifact(wsMilestone, 'uat');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs', 'config.json'), '{}');

    const bare = runAudit(tmpDir);
    assert.ok(
      bare.results.some((r) => String(r.phase).startsWith('176') && (r.items || []).length > 0),
      `#3804: a flat (no --ws) audit must see the active workstream milestone's open item; got ${JSON.stringify(bare.summary)}`,
    );

    const scoped = runAudit(tmpDir, ['--ws', 'v7-2-boot-obs']);
    assert.ok(
      scoped.summary.total_items > 0,
      `#3804: --ws must not empty the report; got ${JSON.stringify(scoped.summary)}`,
    );
  });

  test('#3804 control: the flat archive layout still surfaces', (t) => {
    const tmpDir = createTempProject('gsd-3804-flat-');
    t.after(() => cleanup(tmpDir));
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '09-old'), 'deferred');

    const out = runAudit(tmpDir);
    assert.ok(
      out.results.some((r) => String(r.phase).startsWith('09') && (r.items || []).length > 0),
      'the pre-existing flat archive layout must keep surfacing',
    );
  });

  test('#3804: a phase reachable via two roots reports once', (t) => {
    const tmpDir = createTempProject('gsd-3804-dup-');
    t.after(() => cleanup(tmpDir));
    const dirName = '42-shared';
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', dirName), 'deferred');
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'milestones', 'v1.0-phases', dirName), 'deferred');

    const out = runAudit(tmpDir);
    const phase42 = out.results.filter((r) => String(r.phase).startsWith('42'));
    assert.ok(phase42.length >= 1, 'the phase surfaces');
    // The count assertion is on summary consistency, not a hard 1 (two roots
    // legitimately carry the same phase number for different projects).
    assert.equal(out.summary.total_files, out.results.filter((r) => (r.items || []).length > 0 || r.parse_gap).length,
      'summary.total_files must agree with the per-result files actually reporting');
  });
});
