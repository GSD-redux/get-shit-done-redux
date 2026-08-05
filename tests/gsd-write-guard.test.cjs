'use strict';

/**
 * gsd-write-guard.js — catastrophic-shrink guard for curated .planning/ writes
 *
 * Seam: hooks/gsd-write-guard.js (PreToolUse hook, spawned with a JSON payload
 * on stdin, exactly as every runtime bus invokes it).
 *
 * #2255 (fix 3 of #973): a planner read a ~16-line window of ROADMAP.md and
 * Write-overwrote the whole 292-line file with it. This hook hard-blocks
 * (decision: 'block', exit 2) a whole-file Write that shrinks a curated
 * .planning/ artifact below SHRINK_RATIO (40%) of its on-disk line count,
 * with a FLOOR_LINES (40) exemption for small stubs and a documented
 * GSD_ALLOW_PLANNING_SHRINK=1 escape hatch named in the block message.
 *
 * Acceptance criteria covered:
 *   1. Blocking polarity — decision: 'block' + exit 2, not advisory.
 *   2. Fires ONLY on the curated set — a wholesale rewrite of an arbitrary
 *      .md passes untouched.
 *   3. Compares the pending payload against the on-disk file.
 *   4. Documented env override exists and its name is in the block message.
 *   5. Line-count floor — a sub-floor file is exempt.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js');

/**
 * Run the hook with a given payload. The override env var is stripped by
 * default so an outer environment can never leak a bypass into the tests;
 * pass extraEnv to set it explicitly.
 *
 * Returns an object shaped like the raw spawnSync() result (status/stdout/
 * stderr) because every call site in this file was written against that
 * shape; the seam itself returns exitCode, not status, so it is mapped here.
 * 10_000ms: gsd-write-guard.js does no subprocess work of its own (pure
 * fs reads + JSON, no execFileSync/spawnSync inside the hook) — generous
 * headroom over the fs-bound workload without matching the 30_000ms figure
 * sibling suites use for guards that shell out to git.
 */
function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_ALLOW_PLANNING_SHRINK;
  Object.assign(env, extraEnv);
  const r = runHookSeam(HOOK_PATH, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    timeoutMs: 10_000,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function lines(n, tag = 'line') {
  return Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
}

function writePayload(filePath, content, overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
    ...overrides,
  };
}

let projectDir;
let planningDir;
let roadmapPath;

before(() => {
  projectDir = createTempDir('gsd-write-guard-');
  planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(path.join(planningDir, 'milestones'), { recursive: true });
  roadmapPath = path.join(planningDir, 'ROADMAP.md');
});

after(() => {
  cleanup(projectDir);
});

describe('gsd-write-guard.js: catastrophic shrink of curated artifacts', () => {

  test('#973 shape: 292-line ROADMAP.md overwritten with 16 lines is BLOCKED (exit 2, decision block)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'must emit decision: block (hard-block, not advisory)');
    assert.equal(out.oldLines, 292, 'typed oldLines field must carry the on-disk line count');
    assert.equal(out.newLines, 16, 'typed newLines field must carry the payload line count');
  });

  test('block output names the documented override in the typed overrideEnvVar field', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.overrideEnvVar, 'GSD_ALLOW_PLANNING_SHRINK',
      'the escape hatch must be named in the block output — an undocumented bypass gets bypassed with the blunt instrument instead'
    );
  });

  test('GSD_ALLOW_PLANNING_SHRINK=1 bypasses the block (documented escape hatch)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)), { GSD_ALLOW_PLANNING_SHRINK: '1' });
    assert.equal(r.status, 0, `override must pass; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '', 'override path must be silent');
  });

  test('milestone roadmap (.planning/milestones/v1-ROADMAP.md) is curated — blocked', () => {
    const msPath = path.join(planningDir, 'milestones', 'v1-ROADMAP.md');
    fs.writeFileSync(msPath, lines(120));
    const r = runHook(writePayload(msPath, lines(10)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('STATE.md under .planning/ is curated — blocked', () => {
    const statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, lines(90));
    const r = runHook(writePayload(statePath, lines(5)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('non-ENOENT read error fails CLOSED — curated target unreadable blocks (exit 2)', () => {
    // A directory at the curated path makes readFileSync throw EISDIR (or the
    // platform's equivalent) — any non-ENOENT read error must block, not wave
    // the Write through on a transient failure.
    // Injected via a directory-at-path collision rather than the usual
    // fs.readFileSync monkeypatch: runHook spawns the hook as a child process
    // (spawnSync), so an in-process fs patch can never reach the code under
    // test — the on-disk collision is the only injection that crosses the
    // process boundary, and it reproduces on all 3 CI platforms.
    const dirAsRoadmap = path.join(planningDir, 'milestones', 'vX-ROADMAP.md');
    fs.mkdirSync(dirAsRoadmap, { recursive: true });
    const r = runHook(writePayload(dirAsRoadmap, lines(300)));
    assert.equal(r.status, 2, `unreadable curated target must fail closed; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.overrideEnvVar, 'GSD_ALLOW_PLANNING_SHRINK');
    assert.notEqual(out.readError, undefined, 'typed readError field must carry the error code');
  });

  test('non-ENOENT read error still honors the documented override (fails open when set)', () => {
    const dirAsRoadmap = path.join(planningDir, 'milestones', 'vY-ROADMAP.md');
    fs.mkdirSync(dirAsRoadmap, { recursive: true });
    const r = runHook(writePayload(dirAsRoadmap, lines(300)), { GSD_ALLOW_PLANNING_SHRINK: '1' });
    assert.equal(r.status, 0, `override must bypass the fail-closed branch; stdout: ${r.stdout}`);
  });

  test('differently-cased path to a curated file is still guarded (case-insensitive FS bypass)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    // On a case-insensitive filesystem (macOS/Windows default) this path IS
    // ROADMAP.md; on a case-sensitive one it's a new file and ENOENT fails
    // open — either way the pattern match itself must be case-insensitive,
    // which this payload exercises via the resolved-path match.
    const casedPath = path.join(planningDir, 'roadmap.MD');
    const r = runHook(writePayload(casedPath, lines(16)));
    if (fs.existsSync(casedPath) && fs.statSync(casedPath).size > 0) {
      // case-insensitive FS: same real file — must block
      assert.equal(r.status, 2, `case-variant Write to the same real file must block; stdout: ${r.stdout}`);
    } else {
      // case-sensitive FS: genuinely a new file — new-file Writes pass
      assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    }
  });

  test('relative file_path resolves against the payload cwd — blocked', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = writePayload('.planning/ROADMAP.md', lines(16), { cwd: projectDir });
    const r = runHook(payload);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });
});

describe('round 9: symlink resolution, CRLF counting, and denial-content pins', () => {
  test('a Write to a non-curated SYMLINK into a curated file is guarded (realpath before the match)',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false }, () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const linkPath = path.join(projectDir, 'innocent-notes.md');
    fs.symlinkSync(roadmapPath, linkPath);
    try {
      const r = runHook(writePayload(linkPath, lines(16)));
      assert.equal(r.status, 2,
        `writeFileSync follows the link into ROADMAP.md, so the guard must too. Got ${r.status}; stdout: ${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(linkPath);
    }
  });

  test('the denial prose does NOT publish the sentinel recipe; the typed field still names it (round 9 Major 2)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overrideSentinel, '.planning/.gsd-allow-shrink',
      'the typed field stays — the binding tests and workflow consumers key on it');
    assert.ok(!out.reason.includes(out.overrideSentinel),
      '#973 was an agent reasoning past an advisory: the agent-facing denial must not print the sentinel recipe');
    assert.ok(out.reason.includes(out.overrideEnvVar),
      "#2255 acceptance criterion: the env override's name stays in the block message");
  });

  test('CRLF content counts lines correctly on both sides of the compare', () => {
    const crlf = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
    fs.writeFileSync(roadmapPath, crlf(100));
    const blocked = runHook(writePayload(roadmapPath, crlf(39)));
    assert.equal(blocked.status, 2, `39/100 CRLF lines is under the 40% ratio and must block. Got ${blocked.status}`);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.oldLines, 100, 'CRLF on disk must not inflate or deflate the count');
    assert.equal(out.newLines, 39, 'CRLF in the payload must not inflate or deflate the count');
    const pass = runHook(writePayload(roadmapPath, crlf(40)));
    assert.equal(pass.status, 0, '40/100 CRLF lines sits exactly on the tolerated boundary and must pass');
  });
});

describe('gsd-write-guard.js: deliberately narrow trigger (no-op paths)', () => {

  test('wholesale rewrite of a NON-curated .md passes untouched (no override-fatigue)', () => {
    const notesPath = path.join(projectDir, 'docs-notes.md');
    fs.writeFileSync(notesPath, lines(200));
    const r = runHook(writePayload(notesPath, lines(5)));
    assert.equal(r.status, 0, `non-curated file must pass; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('non-roadmap file under .planning/milestones/ is not curated — passes', () => {
    const auditPath = path.join(planningDir, 'milestones', 'v1-MILESTONE-AUDIT.md');
    fs.writeFileSync(auditPath, lines(200));
    const r = runHook(writePayload(auditPath, lines(5)));
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
  });

  test('sub-floor file (39 lines) is exempt from the ratio check', () => {
    fs.writeFileSync(roadmapPath, lines(39));
    const r = runHook(writePayload(roadmapPath, lines(2)));
    assert.equal(r.status, 0, `sub-floor stub must pass; stdout: ${r.stdout}`);
  });

  test('at-floor file (40 lines) IS guarded — the floor is exclusive', () => {
    fs.writeFileSync(roadmapPath, lines(40));
    const r = runHook(writePayload(roadmapPath, lines(15)));
    assert.equal(r.status, 2, `40-line file collapsing to 15 (37.5%) must block; stdout: ${r.stdout}`);
  });

  test('above-floor file (41 lines) IS guarded — floor boundary from above', () => {
    fs.writeFileSync(roadmapPath, lines(41));
    const r = runHook(writePayload(roadmapPath, lines(15)));
    assert.equal(r.status, 2, `41-line file collapsing to 15 (~36.6%) must block; stdout: ${r.stdout}`);
  });

  test('ratio boundary: exactly 40% of old passes; one line either side behaves', () => {
    fs.writeFileSync(roadmapPath, lines(100));
    const atThreshold = runHook(writePayload(roadmapPath, lines(40)));
    assert.equal(atThreshold.status, 0, `100 → 40 (exactly 40%) must pass; stdout: ${atThreshold.stdout}`);
    const belowThreshold = runHook(writePayload(roadmapPath, lines(39)));
    assert.equal(belowThreshold.status, 2, `100 → 39 (39%) must block; stdout: ${belowThreshold.stdout}`);
    const aboveThreshold = runHook(writePayload(roadmapPath, lines(41)));
    assert.equal(aboveThreshold.status, 0, `100 → 41 (41%) must pass; stdout: ${aboveThreshold.stdout}`);
  });

  test('creating a curated file that does not exist yet passes', () => {
    const freshPath = path.join(planningDir, 'milestones', 'v9-ROADMAP.md');
    const r = runHook(writePayload(freshPath, lines(3)));
    assert.equal(r.status, 0, `new-file Write must pass; stdout: ${r.stdout}`);
  });

  test('Edit tool call is out of scope — passes even on a curated target', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: roadmapPath, old_string: 'line 1', new_string: 'line one' },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0, `Edit is scoped by construction; stdout: ${r.stdout}`);
  });

  test('MultiEdit tool call is out of scope — passes', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: { file_path: roadmapPath, edits: [] },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0);
  });

  test('payload without content (non-string) fails open', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: roadmapPath },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0, `missing content must fail open; stdout: ${r.stdout}`);
  });

  test('malformed JSON on stdin fails open (silent fail, never blocks)', () => {
    const r = runHook('{not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #2304 — Kimi tool vocabulary engages the guard
// Payload shapes mirror kimi-cli's actual tool schemas
// (src/kimi_cli/tools/file/write.py): WriteFile takes `path`/`content`,
// not Claude's `file_path`. See PR #2326 for the sibling guards.
// ────────────────────────────────────────────────────────────────────────

describe('#2304: Kimi tool vocabulary engages the write guard', () => {
  test('Kimi WriteFile catastrophic shrink is BLOCKED like Write', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2, `Kimi WriteFile shrink must be blocked. Got ${r.status}; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.oldLines, 292);
    assert.equal(out.newLines, 16);
  });

  test('module-qualified kimi_cli.tools.file:WriteFile is recognized', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'kimi_cli.tools.file:WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2, `qualified Kimi WriteFile shrink must be blocked. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('block reason reaches stderr (Kimi feeds stderr back to the model on exit 2)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.length > 0, 'stderr must be non-empty — it is the channel Kimi feeds back');
    assert.equal(r.stderr, JSON.parse(r.stdout).reason,
      'stderr must carry exactly the typed reason — the same contract, without pinning prose');
  });

  test('Kimi StrReplaceFile stays exempt (Edit-class, out of scope by design)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'StrReplaceFile',
      tool_input: { path: roadmapPath, edit: { old: 'line 1', new: 'line one' } },
    });
    assert.equal(r.status, 0, 'StrReplaceFile is unmapped in this guard (Edit-class, out of scope by design #2255) and must fall through to the non-Write exemption');
    assert.equal(r.stdout, '');
  });

  test('Kimi WriteFile of a non-curated path stays exempt', () => {
    const otherPath = path.join(projectDir, 'notes.md');
    fs.writeFileSync(otherPath, lines(300));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: otherPath, content: lines(5) },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test("a spurious model-supplied file_path cannot shadow Kimi's authoritative path (#2595 class)", () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, file_path: '', content: lines(16) },
    });
    assert.equal(r.status, 2,
      `kimi-cli executes on \`path\`, so \`path\` must win outright — a spurious file_path:'' shadowed it pre-fix and the guard read '' and exited 0. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('null and primitive payloads fall through deliberately (total normalization, #2595 class)', () => {
    for (const payload of ['null', '42', '"write"']) {
      const r = runHook(payload);
      assert.equal(r.status, 0, `payload ${payload} has nothing to guard and must exit 0 without crashing`);
      assert.equal(r.stdout, '');
    }
  });
});

describe('single-use sentinel exemption (.planning/.gsd-allow-shrink) — the mechanical hatch the workflow uses', () => {
  // #2255 round 5 M1: a per-step env prefix cannot reach a PreToolUse hook
  // (the hook inherits the RUNTIME's environment), so the workflow's hatch is
  // a sentinel FILE the guard itself consults: the step writes the target's
  // path into .planning/.gsd-allow-shrink, and the guard consumes it (single
  // use) to allow exactly one otherwise-blocked shrink of exactly that file.
  const sentinelName = '.gsd-allow-shrink';
  let sentinelPath;

  before(() => {
    sentinelPath = path.join(planningDir, sentinelName);
  });

  function armSentinel(target = '.planning/ROADMAP.md') {
    fs.writeFileSync(sentinelPath, target + '\n');
  }

  function disarm() {
    cleanup(sentinelPath); // helpers.cleanup — carries the Windows-EBUSY retry budget
  }

  test('a reorganize-shaped Write PASSES under a fresh sentinel naming the target — and the sentinel is CONSUMED', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 0,
      `fresh sentinel naming the target must exempt the shrink. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(fs.existsSync(sentinelPath), false,
      'the sentinel must be consumed by the allow — single-use, never a standing unlock');

    // Single-use for real: the identical payload immediately after is blocked.
    const again = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(again.status, 2, 'the sentinel is spent — the identical second Write must block');
  });

  test('a STALE sentinel does not exempt', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const old = (Date.now() - 16 * 60 * 1000) / 1000; // past the 15-minute freshness window
    fs.utimesSync(sentinelPath, old, old);
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2, 'a stale sentinel is a leftover, not an authorization');
    disarm();
  });

  test('a sentinel naming a DIFFERENT file neither exempts nor is consumed', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel('.planning/STATE.md');
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2, 'the sentinel is path-bound — a token for STATE.md must not exempt ROADMAP.md');
    assert.equal(fs.existsSync(sentinelPath), true,
      'a mismatched sentinel must survive — it still authorizes the write it was armed for');
    disarm();
  });

  test('a within-tolerance Write does NOT consume a fresh sentinel (consulted only at the block point)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const r = runHook(writePayload(roadmapPath, lines(200), { cwd: projectDir }));
    assert.equal(r.status, 0, `200/292 is within tolerance and must pass. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(fs.existsSync(sentinelPath), true,
      'a passing Write must not burn the token the workflow armed for its collapse — true by construction, now asserted');
    disarm();
  });

  test('the block output names the sentinel via a typed field (consumers never regex the prose)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overrideSentinel, `.planning/${sentinelName}`,
      'blocked callers are told the mechanical hatch by typed field, same contract as overrideEnvVar');
  });
});

describe('guard <-> complete-milestone workflow binding (the escape hatch is WIRED, not just present)', () => {
  // #2255 review Blocker 1 (reopened round 5 as M1): the one first-party
  // legitimate milestone reset — complete-milestone's reorganize step — must
  // route through a hatch the guard MECHANICALLY honors, on the tool the
  // guard actually watches. Round 3's fix routed around Write via Bash+tee
  // with an env prefix nothing reads; this binding asserts the opposite: the
  // step arms the sentinel the guard consumes, keeps Write as the sanctioned
  // path, and no longer smuggles the rewrite through a shell pipe. The
  // sentinel name is taken from the guard's typed output, so a rename on
  // EITHER side fails here instead of silently unwiring the hatch.
  const workflowPath = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md'
  );

  test('the reorganize step arms the exact sentinel the guard consumes, and keeps Write as the path', () => {
    const src = fs.readFileSync(workflowPath, 'utf8');
    const stepStart = src.indexOf('<step name="reorganize_roadmap_and_delete_originals">');
    assert.notEqual(stepStart, -1,
      'reorganize step missing or renamed in complete-milestone.md — rebind this test');
    const step = src.slice(stepStart, src.indexOf('</step>', stepStart));

    fs.writeFileSync(roadmapPath, lines(292));
    const blocked = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(blocked.status, 2, 'baseline: the reorganize-shaped Write must block without the hatch');
    const sentinel = JSON.parse(blocked.stdout).overrideSentinel;
    assert.ok(sentinel, 'the guard must publish its sentinel path as a typed field');

    assert.ok(step.includes(sentinel),
      `complete-milestone.md's reorganize step no longer arms ${sentinel} — ` +
      'its whole-file ROADMAP.md rewrite would be hard-blocked by gsd-write-guard (#2255 M1)');

    assert.ok(!/GSD_ALLOW_PLANNING_SHRINK=1\s+tee/.test(step) && !/\btee\s+\.planning\/ROADMAP\.md/.test(step),
      'the reorganize step must not route the rewrite around Write via a shell pipe — ' +
      'that is the prose-level protection M1 exists to eliminate');

    // The real failure round 5 named: agent follows the step, arms the
    // sentinel, then calls Write — this exact sequence must pass.
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/ROADMAP.md\n');
    const allowed = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(allowed.status, 0,
      'the identical catastrophic payload must pass under the sentinel the workflow step arms');
  });

  test('the sentinel-armed reorganize step is the ONLY ROADMAP-collapsing step in the workflow', () => {
    // #2255 round 8 Blocker: a second, hatch-less `reorganize_roadmap` step —
    // a vestige of the pre-archive-then-reorganize design, sitting BEFORE
    // archive_milestone, so running it would collapse ROADMAP.md before the
    // archive snapshots the full detail — was removed rather than wired. This
    // binding fails if any reorganize step other than the sentinel-armed one
    // is (re)introduced without hatch wiring of its own.
    const src = fs.readFileSync(workflowPath, 'utf8');
    const names = [...src.matchAll(/<step name="([^"]*reorganize[^"]*)">/g)].map((m) => m[1]);
    assert.deepEqual(names, ['reorganize_roadmap_and_delete_originals'],
      'complete-milestone.md must contain exactly one ROADMAP-reorganize step — the ' +
      'sentinel-armed reorganize_roadmap_and_delete_originals; any additional reorganize ' +
      'step is an unguarded catastrophic-shrink Write (#2255 round 8 Blocker)');
  });
});

describe('the shipped claim matches the shipped guarantee (round 10 Major 2)', () => {
  // The guard's reach is bounded: the sentinel is a plain file, so an agent
  // that would reason past an advisory can arm one with a single Bash call.
  // Round 10 asked that the claim not outrun that, and specifically that the
  // stronger wording not reach CHANGELOG.md. Pinned on the DURABLE surfaces
  // only — a changeset fragment is consumed at release, so a test reading it
  // would start failing the moment the release lands.
  const RETIRED = 'the only defense independent of per-agent tool config';
  const surfaces = [
    ['hooks/gsd-write-guard.js', path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js')],
    ['docs/USER-GUIDE.md', path.join(__dirname, '..', 'docs', 'USER-GUIDE.md')],
  ];

  for (const [label, file] of surfaces) {
    test(`${label} does not restate the retired unbounded claim`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!src.includes(RETIRED),
        `${label} carries the retired claim "${RETIRED}" — it overstates what the guard ` +
        'delivers, because the sentinel is agent-armable (#2255 round 10 Major 2)');
    });

    test(`${label} states the determined-agent bound`, () => {
      // Normalize before matching: the claim is prose, and in a source file it
      // is prose wrapped in `//` across several lines. A pin that breaks when
      // a paragraph is reflowed tests the formatter, not the claim.
      const src = fs.readFileSync(file, 'utf8')
        .replace(/^\s*\/\/ ?/gm, '')
        .replace(/\s+/g, ' ');
      assert.match(src, /not a defense against (a determined agent|an evader)/,
        `${label} must state that the guard does not stop a determined agent — the bound is ` +
        'the half a reader acts on (#2255 round 10 Major 2)');
    });
  }
});

describe('guard <-> gsd-roadmapper binding (the /gsd:new-milestone collapse path is hatched)', () => {
  // #2255 round 10 Blocker 1: complete-milestone was not the only first-party
  // flow that overwrites a curated artifact wholesale. gsd-roadmapper's Step 7
  // Writes BOTH .planning/ROADMAP.md and .planning/STATE.md, and
  // /gsd:new-milestone spawns it against the OUTGOING milestone's files —
  // new-milestone's `phases.clear` archives phase DIRECTORIES, never
  // ROADMAP.md, so nothing compacts it first and no ordering rule forces
  // /gsd:complete-milestone to run before /gsd:new-milestone.
  //
  // Measured against the shipped hook at the #973 file size (292 lines): a new
  // 4-phase roadmap lands at 18.2% and an 8-phase one at 31.8% — both blocked;
  // only a 12-phase replacement (45.5%) clears. The sentinel is path-bound and
  // single-use, so each Write needs its own arming. As in the sibling binding
  // above, the sentinel name is taken from the guard's typed output so a
  // rename on EITHER side fails here instead of silently unwiring the hatch.
  const roadmapperPath = path.join(__dirname, '..', 'agents', 'gsd-roadmapper.md');

  test('the roadmapper write step arms the exact sentinel the guard consumes, for BOTH curated targets', () => {
    const src = fs.readFileSync(roadmapperPath, 'utf8');
    const stepStart = src.indexOf('## Step 7: Write Files Immediately');
    assert.notEqual(stepStart, -1,
      'roadmapper Step 7 missing or renamed in gsd-roadmapper.md — rebind this test');
    const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));

    fs.writeFileSync(roadmapPath, lines(292));
    const blocked = runHook(writePayload(roadmapPath, lines(53), { cwd: projectDir }));
    assert.equal(blocked.status, 2,
      'baseline: the new-milestone-shaped roadmap Write must block without the hatch');
    const sentinel = JSON.parse(blocked.stdout).overrideSentinel;
    assert.ok(sentinel, 'the guard must publish its sentinel path as a typed field');

    assert.ok(step.includes(sentinel),
      `gsd-roadmapper.md Step 7 no longer arms ${sentinel} — its whole-file ROADMAP.md ` +
      'write would be hard-blocked by gsd-write-guard on /gsd:new-milestone (#2255 round 10 Blocker 1)');

    // Both curated targets the step writes must be armed by name — one arming
    // cannot cover both, because the token is path-bound and single-use.
    for (const target of ['.planning/ROADMAP.md', '.planning/STATE.md']) {
      assert.ok(step.includes(`printf '${target}\\n' > ${sentinel}`),
        `Step 7 must arm ${sentinel} for ${target} immediately before writing it — ` +
        'the sentinel is path-bound and single-use, so a single arming covers only one file');
    }
  });

  test('the armed sequence passes the exact collapse /gsd:new-milestone produces', () => {
    // The real failure: roadmapper follows Step 7, arms the sentinel, Writes.
    fs.writeFileSync(roadmapPath, lines(292));
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/ROADMAP.md\n');
    const allowed = runHook(writePayload(roadmapPath, lines(53), { cwd: projectDir }));
    assert.equal(allowed.status, 0,
      'the identical collapse must pass under the sentinel the roadmapper step arms');

    // And the STATE.md leg, which the same step writes seconds later — its own
    // arming, because the ROADMAP arming was consumed by the write above.
    const statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, lines(195));
    const stateBlocked = runHook(writePayload(statePath, lines(60), { cwd: projectDir }));
    assert.equal(stateBlocked.status, 2,
      'a collapsing STATE.md rewrite must block once the ROADMAP arming is spent');
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/STATE.md\n');
    const stateAllowed = runHook(writePayload(statePath, lines(60), { cwd: projectDir }));
    assert.equal(stateAllowed.status, 0,
      'the STATE.md collapse must pass under its own arming');
  });

  test('arming is conditional on the target existing, so /gsd:new-project leaves no unconsumed token', () => {
    // A new-project run has no ROADMAP.md: the guard exempts via ENOENT and
    // never consumes a token, so an unconditional arming would strand a live
    // 15-minute unlock on disk. The step must guard both armings with [ -f ].
    const src = fs.readFileSync(roadmapperPath, 'utf8');
    const stepStart = src.indexOf('## Step 7: Write Files Immediately');
    const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));
    for (const target of ['.planning/ROADMAP.md', '.planning/STATE.md']) {
      assert.ok(step.includes(`[ -f ${target} ] &&`),
        `Step 7 must gate the ${target} arming on the file existing — an unconditional ` +
        'arming on the new-project path strands an unconsumed sentinel (#2255 round 10)');
    }
  });
});
