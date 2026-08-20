/**
 * Tests gsd-context-monitor.js PreCompact sentinel reset.
 *
 * Regression guard for: after a context compaction the warn sentinel was never
 * cleared, so `lastLevel` stayed pinned at 'critical' for the rest of the
 * session. That permanently disables the documented rule
 * "Severity escalation (WARNING -> CRITICAL) bypasses debounce"
 * (docs/context-monitor.md), and leaves `criticalRecorded` sticky so the
 * /gsd-resume-work breadcrumb (#1974) is never re-recorded for the exhaustion
 * that actually ends the session.
 *
 * The hook exports nothing (it reads stdin and exits), so it is exercised as a
 * subprocess, the same way the host runtimes invoke it.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

let sessionId;
let bridgePath;
let warnPath;

function bridgeFile(id) {
  return path.join(os.tmpdir(), `claude-ctx-${id}.json`);
}

function warnFile(id) {
  return path.join(os.tmpdir(), `claude-ctx-${id}-warned.json`);
}

/** Run the hook with a payload on stdin, returning its result. */
function runHook(payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
}

function writeBridge(remaining) {
  fs.writeFileSync(
    bridgePath,
    JSON.stringify({
      session_id: sessionId,
      remaining_percentage: remaining,
      used_pct: 100 - remaining,
      timestamp: Math.floor(Date.now() / 1000),
    })
  );
}

function rm(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* already gone */
  }
}

describe('gsd-context-monitor PreCompact sentinel reset', () => {
  beforeEach(() => {
    sessionId = `test-ctxmon-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    bridgePath = bridgeFile(sessionId);
    warnPath = warnFile(sessionId);
  });

  afterEach(() => {
    rm(bridgePath);
    rm(warnPath);
  });

  test('PreCompact clears a sentinel left pinned at critical', () => {
    // A CRITICAL warning already fired before the compaction.
    fs.writeFileSync(
      warnPath,
      JSON.stringify({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true })
    );
    writeBridge(20); // 80% used — what triggered the CRITICAL

    const res = runHook({
      session_id: sessionId,
      hook_event_name: 'PreCompact',
      cwd: os.tmpdir(),
    });

    assert.equal(res.status, 0, 'hook must exit 0');
    assert.equal(res.stdout, '', 'PreCompact is not injection-capable: no stdout');
    assert.equal(
      fs.existsSync(warnPath),
      false,
      'sentinel must be cleared so the next cycle can escalate again'
    );
  });

  test('PreCompact is a no-op when no sentinel exists', () => {
    writeBridge(90);

    const res = runHook({
      session_id: sessionId,
      hook_event_name: 'PreCompact',
      cwd: os.tmpdir(),
    });

    assert.equal(res.status, 0, 'missing sentinel must not fail the hook');
    assert.equal(fs.existsSync(warnPath), false);
  });

  test('PreCompact does not consume the metrics bridge', () => {
    fs.writeFileSync(warnPath, JSON.stringify({ callsSinceWarn: 3, lastLevel: 'warning' }));
    writeBridge(30);

    runHook({ session_id: sessionId, hook_event_name: 'PreCompact', cwd: os.tmpdir() });

    assert.equal(
      fs.existsSync(bridgePath),
      true,
      'the statusline owns the bridge file; the monitor must not remove it'
    );
  });

  test('after a PreCompact reset, a fresh CRITICAL escalates immediately', () => {
    // Pre-compaction: CRITICAL already seen.
    fs.writeFileSync(
      warnPath,
      JSON.stringify({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true })
    );

    writeBridge(20);
    runHook({ session_id: sessionId, hook_event_name: 'PreCompact', cwd: os.tmpdir() });

    // Post-compaction the context climbs back into WARNING, then CRITICAL.
    writeBridge(30); // WARNING
    const warn = runHook({
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      cwd: os.tmpdir(),
    });
    assert.match(warn.stdout, /CONTEXT WARNING/, 'first post-reset warning fires immediately');
    assert.equal(JSON.parse(fs.readFileSync(warnPath, 'utf8')).lastLevel, 'warning');

    writeBridge(20); // CRITICAL on the very next tool use
    const crit = runHook({
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      cwd: os.tmpdir(),
    });
    assert.match(
      crit.stdout,
      /CONTEXT CRITICAL/,
      'WARNING -> CRITICAL must bypass debounce, per docs/context-monitor.md'
    );
  });
});
