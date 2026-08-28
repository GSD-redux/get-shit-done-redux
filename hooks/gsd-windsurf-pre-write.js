#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-windsurf-pre-write.js — Windsurf/Cascade pre_write_code hook (ADR-1239 / #2100)
//
// Cascade (Windsurf's agent) invokes this script before each file-write tool
// call executes, via the workspace/global hooks.json hook bus.
//
// Input schema (Cascade pre_write_code envelope, JSON on stdin):
//   { agent_action_name: 'pre_write_code', trajectory_id, execution_id,
//     timestamp, model_name,
//     tool_info: { file_path, edits: [{ old_string, new_string }] } }
//
// Decision protocol — DISTINCT from Cursor's stdout-JSON form:
//   - exit 0  -> allow the write to proceed (no stdout contract)
//   - exit 2  -> BLOCK the write; the printed stderr text is the reason shown
//                to the agent/user
//
// Behaviour: reimplements the core containment check from
// hooks/gsd-worktree-path-guard.js — block a write whose file_path resolves
// (via `git rev-parse --show-toplevel`) to a DIFFERENT git root than the
// current working directory, or lands inside a `.git/` internals directory.
// Fails OPEN on any error, timeout, non-git cwd, or missing git binary — a
// hook bug must never wedge Cascade.
//
// Cascade hooks docs (reference): https://docs.windsurf.com/llms-full.txt ,
//                                  https://docs.devin.ai/desktop/cascade/hooks

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { allow, deny } = require('./lib/hook-exit.js');
const { reportIfUndetermined } = require('./lib/git-probe.js');

// #3911 (ADR-3889 Phase 7): the exit(2) call site (block(), below) is
// migrated to hook-exit.js's deny(undefined, reason) — see
// gsd-windsurf-pre-command.js's identical note for the fixed defect
// (terminateNow's fd 1/fd 2 writes now run in independent try/catch blocks).

const SPAWNOPT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true };

function git(args, cwd) {
  return spawnSync('git', args, { ...SPAWNOPT, cwd });
}

// Walk up from `start` to find the nearest existing DIRECTORY (not merely an
// existing filesystem entry) — a linked git worktree's `.git` is a plain FILE
// (a `gitdir:` pointer), not a directory, so a plain existence check would
// hand spawnSync an invalid `cwd` and silently fail the git calls below.
// Returns null if we reach the filesystem root without finding one.
function nearestExistingDir(start) {
  let dir = start;
  let prev;
  do {
    prev = dir;
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  } while (dir !== prev);
  return null;
}

function block(reason) {
  deny(undefined, `GSD windsurf pre_write_code guard: ${reason}\n`);
}

let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input || '{}');
    const toolInfo = (data && typeof data.tool_info === 'object' && data.tool_info) || {};
    const rawFilePath = typeof toolInfo.file_path === 'string' ? toolInfo.file_path : '';
    if (!rawFilePath) { allow(undefined); return; }

    const cwd = process.cwd();

    // Determine the active project's git root. No git root at all -> nothing
    // to enforce a boundary against -> fail open.
    const cwdTopResult = git(['rev-parse', '--show-toplevel'], cwd);
    // #3911: a timeout/spawn-failure result is indistinguishable from a clean
    // "no git root here" answer by status/stdout alone — reportIfUndetermined
    // is a no-op on a genuine negative and only fires when the probe itself
    // could not run. The allow() below is UNCHANGED either way.
    reportIfUndetermined('gsd-windsurf-pre-write', 'git rev-parse --show-toplevel (cwd)', cwdTopResult);
    if (cwdTopResult.status !== 0 || !cwdTopResult.stdout) { allow(undefined); return; }
    const cwdTopRaw = cwdTopResult.stdout.trim();

    const filePath = path.isAbsolute(rawFilePath) ? path.resolve(rawFilePath) : path.resolve(cwd, rawFilePath);

    // Find the nearest existing ancestor of filePath so we can ask git for its
    // toplevel. The file itself may not exist yet (a write can create it).
    const checkDir = nearestExistingDir(
      (() => {
        try {
          return fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
        } catch {
          return path.dirname(filePath);
        }
      })(),
    );
    if (!checkDir) { allow(undefined); return; } // synthetic path with no existing ancestor — fail open

    const fileTopResult = git(['rev-parse', '--show-toplevel'], checkDir);
    reportIfUndetermined('gsd-windsurf-pre-write', 'git rev-parse --show-toplevel (file location)', fileTopResult);
    if (fileTopResult.status !== 0 || !fileTopResult.stdout) {
      // Not inside any git worktree. Distinguish "inside a .git/ internals
      // directory" (dangerous — BLOCK) from "outside all git repos entirely"
      // (not the escape vector this guard targets — fail open).
      const insideGitDir = git(['rev-parse', '--is-inside-git-dir'], checkDir);
      reportIfUndetermined('gsd-windsurf-pre-write', 'git rev-parse --is-inside-git-dir', insideGitDir);
      if (insideGitDir.status === 0 && insideGitDir.stdout && insideGitDir.stdout.trim() === 'true') {
        block(
          `'${filePath}' is inside a git internal (.git) directory, not the active project at ` +
          `'${cwdTopRaw}'. Writing to repository internals via an absolute path is not permitted. ` +
          `Use a relative path. (cwd: '${cwd}')`,
        );
        return;
      }
      allow(undefined);
      return;
    }

    const fileTopRaw = fileTopResult.stdout.trim();
    if (fileTopRaw === cwdTopRaw) { allow(undefined); return; }

    // BLOCK: file resolves to a different git root than the active project.
    block(
      `'${filePath}' resolves to git root '${fileTopRaw}' which differs from the active project root ` +
      `'${cwdTopRaw}'. This likely means an absolute path was derived from a different repository. ` +
      `Use a relative path within the active project, or re-derive the base directory with ` +
      `\`git rev-parse --show-toplevel\` from the active project. (cwd: '${cwd}')`,
    );
  } catch {
    // Silent fail-open — never block a valid tool call due to a hook bug.
    allow(undefined);
  }
});
