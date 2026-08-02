#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Write Guard — PreToolUse hook
// Blocks a whole-file Write that catastrophically shrinks a curated .planning/
// artifact (ROADMAP.md, milestone roadmaps, STATE.md).
//
// Problem (#973, fix 3 of 3): a planner read a ~16-line window of ROADMAP.md
// and Write-overwrote the whole 292-line file with it — three milestones of
// committed history destroyed. Fixes 1 and 2 (PR #989) are instructions to a
// model: they lower the probability of a clobber but cannot prevent one, and
// they protect only the agents that were audited. This hook is enforced by
// code rather than by instruction: it compares the pending Write payload
// against the file on disk and hard-blocks a catastrophic shrink BEFORE it
// happens. An advisory will not do — #973 records an agent reading the
// advisory, classifying it as non-binding, and reasoning past it while
// holding a false model of what Write does.
//
// The guarantee is bounded, and the bound is worth stating where the code
// lives: this stops accidental and single-shot collapse, not a determined
// agent. The sentinel hatch below is a plain file, so an agent that would
// reason past an advisory can arm one with a single Bash call it is already
// permitted to make. What ships is the conversion of "ignore a sentence" into
// "take one deliberate, path-bound, single-use, auditable action" — a real
// improvement against the confused-agent threat #973 records, not a defense
// against an evader.
//
// Deliberately narrow trigger:
//   - Write only (Edit/MultiEdit are scoped by construction);
//   - the target already exists on disk;
//   - the target is a curated .planning/ artifact — the project ROADMAP.md,
//     milestone roadmaps (.planning/milestones/*-ROADMAP.md), and STATE.md.
//     NOT arbitrary markdown: free-prose docs get legitimately rewritten
//     wholesale, and a guard that fires on those trains override-fatigue
//     until nobody reads it.
//
// Threshold: block when the pending payload carries fewer than SHRINK_RATIO
// (40%) of the on-disk line count. The docs-update fix-loop's 90% bar is far
// too permissive for a curated artifact — the #973 incident was a ~94.5%
// collapse and clears a 90% bar only barely. The same ~40%/floor-40 tuning
// has run clean (no false positives) as a commit-time twin downstream.
//
// Floor: files under FLOOR_LINES are exempt, so a 10 → 2 line stub never
// trips the ratio check.
//
// Escape hatches — both named in the block message; a guard whose bypass is
// undocumented gets bypassed with the blunt instrument instead, with every
// other guard disabled at the same time:
//   - GSD_ALLOW_PLANNING_SHRINK=1 (env) — for a human running interactively,
//     where the variable can actually reach the hook's environment.
//   - .planning/.gsd-allow-shrink (single-use sentinel file) — for workflow
//     steps. A PreToolUse hook inherits the RUNTIME's environment, so a
//     per-step env prefix can never reach it (#2255 round 5 M1); the sentinel
//     is a transport that code consults, not prose an agent obeys. The step
//     writes the target's path into the sentinel; at the block point the
//     guard checks it is fresh (15 min) and names the pending target, then
//     CONSUMES it and allows that one write. Path-bound + single-use +
//     freshness is what keeps it from becoming a standing unlock left on disk.
//
// Known design limits (out of #2255's scope by review, disclosed here AND in
// the changeset + USER-GUIDE — round 9 required the user-facing docs to match):
//   - Stateless per-write: sequential shrinks (292→120→50) each clear the 40%
//     floor against CURRENT disk state, so cumulative erosion is invisible.
//   - Unconditionally case-insensitive matching (required on the
//     case-insensitive filesystems macOS/Windows default to): on
//     case-sensitive Linux a genuinely distinct '.planning/roadmap.md' is
//     also treated as curated. Narrow, accepted cost.
// (A third limit — a symlinked path into a curated file escaping the lexical
// match — was closed in round 9: the target is realpath-resolved before the
// curated match.)
//
// Triggers on: Write tool calls
// Action: BLOCK (decision: 'block', exit 2) on catastrophic shrink of a curated file
// No-op: other tools, new files, non-curated paths, sub-floor files, override set,
//        hook errors (silent fail)

const fs = require('fs');
const path = require('path');

// Block when the pending payload has fewer than this fraction of the on-disk
// line count (0.4 → a Write shrinking a file below 40% of its current size).
const SHRINK_RATIO = 0.4;

// Files with fewer lines than this are exempt — small stubs get legitimately
// rewritten far below any ratio.
const FLOOR_LINES = 40;

// Curated .planning/ artifacts, matched against the resolved target path with
// separators normalized to '/'. Deliberately a closed set (see header).
// Case-insensitive: on the case-insensitive filesystems macOS and Windows
// default to, a differently-cased path is the SAME real file — a Write to
// '.planning/roadmap.md' clobbers ROADMAP.md while a case-sensitive match
// waves it through.
const CURATED_PATTERNS = [
  /(?:^|\/)\.planning\/ROADMAP\.md$/i,
  /(?:^|\/)\.planning\/STATE\.md$/i,
  /(?:^|\/)\.planning\/milestones\/[^/]+-ROADMAP\.md$/i,
];

// Count logical lines, ignoring a single trailing newline so that
// "a\nb\n" and "a\nb" both count as 2.
function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function isOverrideSet() {
  const v = process.env.GSD_ALLOW_PLANNING_SHRINK;
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

// Single-use sentinel (see header). Consulted ONLY at the shrink-block point —
// a write that would pass anyway never burns the token, so first-shrink-wins
// for the write the workflow armed it for.
const SENTINEL_NAME = '.gsd-allow-shrink';
const SENTINEL_REL = '.planning/' + SENTINEL_NAME;
const SENTINEL_TTL_MS = 15 * 60 * 1000;

function consumeSentinelFor(filePath, normalized) {
  try {
    // The curated match guarantees the target lives under a .planning/ dir;
    // normalized is filePath with separators flipped, so offsets line up.
    const m = normalized.match(/^(.*\/\.planning)\//i);
    if (!m) return false;
    const planningDir = filePath.slice(0, m[1].length);
    const sentinelPath = path.join(planningDir, SENTINEL_NAME);
    let st;
    try {
      st = fs.statSync(sentinelPath);
    } catch {
      return false; // not armed
    }
    if (Date.now() - st.mtimeMs > SENTINEL_TTL_MS) {
      // A stale token is a leftover, not an authorization — housekeep it.
      try { fs.unlinkSync(sentinelPath); } catch { /* best-effort */ }
      return false;
    }
    const token = fs.readFileSync(sentinelPath, 'utf8').split('\n')[0].trim();
    if (!token) return false;
    // Path-bound: the token names exactly one file, resolved against the
    // .planning/ dir's parent (repo root) — same case-insensitive stance as
    // the curated match itself.
    const namedNorm = path.resolve(path.join(planningDir, '..'), token).replace(/\\/g, '/').toLowerCase();
    if (namedNorm !== normalized.toLowerCase()) {
      return false; // armed for a different file — leave it for that write
    }
    // Consume BEFORE allowing: even if the Write then fails, the safe
    // direction is a spent token, never a lingering one.
    fs.unlinkSync(sentinelPath);
    return true;
  } catch {
    // Any sentinel-machinery error means "not exempt" — the guard's normal
    // (blocking) flow proceeds; the hatch may never fail a guard open.
    return false;
  }
}

// m2 (round 5): the block emission must itself be exception-safe. An EPIPE
// from writeSync inside the outer try would land in the fail-OPEN catch —
// the one outcome the fail-closed branches exist to prevent. The decision
// stands regardless of whether the payload could be delivered.
function emitBlock(output) {
  try {
    // writeSync: pipe writes via process.stdout/stderr are async on Windows
    // and process.exit() does not flush them — a truncated block payload is
    // a guard that silently half-fired.
    fs.writeSync(1, JSON.stringify(output));
    // Kimi feeds stderr (not stdout) back to the model on exit 2.
    fs.writeSync(2, output.reason);
  } catch {
    // Emission failed; the block still stands.
  }
  process.exit(2);
}

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the payload
// (Write → WriteFile, Edit/MultiEdit → StrReplaceFile) while the [[hooks]]
// matcher is registered pre-translated (runtime-hooks-surface.cts
// buildKimiHooksTomlBlock) — so without normalizing the payload too, the
// matcher fires but the tool_name check below exits 0 and the guard is dormant
// on Kimi. The tool_input field names differ as well (kimi-cli
// src/kimi_cli/tools/file/write.py): WriteFile takes `path`/`content`, and
// kimi-cli's hooks/events.py forwards tool_input verbatim, so both layers need
// mapping. Only WriteFile is mapped: this guard exits 0 for any tool but
// Write, so an Edit-class mapping here would be dead code. Accepts bare and
// module-qualified ('kimi_cli.tools.file:WriteFile') names; unknown names fall
// through untouched. Inlined per guard (not hooks/lib/): hook scripts are
// staged as standalone files, and a sibling require is a staging dependency
// that can fail silently.
// A Map, not an object literal: bare bracket lookup resolves prototype keys
// ('constructor', '__proto__', 'toString') to truthy functions/objects, so the
// !mapped fall-through never fires for them; Map.get returns undefined (same
// shape as canonicalizeRuntimeName in src/runtime-name-policy.cts).
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write']]);
function normalizeKimiPayload(data) {
  // #2595: total over everything JSON can express — JSON.parse('null') is
  // null, and reading .tool_name off a primitive would throw into the outer
  // fail-open catch. A null payload has nothing to guard; pass it through
  // deliberately rather than by crash.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2595 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's
    // WriteFile schema carries no `file_path` at all (src/kimi_cli/tools/
    // file/write.py), so a `file_path` in a Kimi payload is ALWAYS
    // model-supplied; under the old `=== undefined` condition a payload
    // pairing a curated `path` with a spurious `file_path: ""` left this
    // guard reading '' and exiting 0 while kimi-cli wrote to `path` — a
    // one-key bypass needing no crash. Overwriting can only narrow what the
    // guard inspects to the path that will actually be written.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));

    // A null/primitive payload has nothing to guard — exit deliberately
    // rather than throwing into the fail-open catch below (#2595 class).
    if (data === null || typeof data !== 'object') {
      process.exit(0);
    }

    // Only whole-file Write is catastrophic-by-construction; Edit/MultiEdit
    // replace bounded spans and are out of scope by design (#2255).
    if (data.tool_name !== 'Write') {
      process.exit(0);
    }

    if (isOverrideSet()) {
      process.exit(0); // documented escape hatch — legitimate reset in progress
    }

    // Typed read (#2547 class): `[]`/`{}` are truthy, pass a `!value`
    // early-out, then throw inside path.resolve() — crash-to-allow via the
    // outer catch. A non-string path field degrades to '' and exits here.
    const rawInput = data.tool_input;
    const rawFilePath = typeof rawInput?.file_path === 'string' ? rawInput.file_path : '';
    const content = rawInput?.content;
    if (!rawFilePath || typeof content !== 'string') {
      process.exit(0);
    }

    // Resolve relative paths against the session cwd (the same base the
    // runtime uses), then normalize separators for the curated match.
    const cwd = data.cwd || process.cwd();
    let filePath = path.resolve(cwd, rawFilePath);
    // Resolve symlinks before the curated match (round 9, Minor 1): a Write
    // to a non-curated path that symlinks into a curated file was not
    // matched, while writeFileSync follows the link and clobbers the real
    // target. ENOENT (new file) keeps the lexical resolution; any other
    // realpath error also keeps it, and the read below then fails closed.
    try {
      filePath = fs.realpathSync(filePath);
    } catch { /* keep the lexical path */ }
    const normalized = filePath.replace(/\\/g, '/');

    if (!CURATED_PATTERNS.some(re => re.test(normalized))) {
      process.exit(0); // not a curated planning artifact
    }

    // Only guard overwrites — creating a curated file fresh is fine.
    // ENOENT alone fails open (no baseline to protect); any OTHER read error
    // (EACCES, EISDIR, ELOOP, EMFILE, a Windows lock) fails CLOSED — a guard
    // that waves a curated Write through on a transient read error is not
    // enforced by code at all, it is a race away from #973.
    let onDisk;
    try {
      onDisk = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        process.exit(0); // does not exist — new-file Write, nothing to clobber
      }
      emitBlock({
        decision: 'block',
        readError: err && err.code ? String(err.code) : 'UNKNOWN',
        overrideEnvVar: 'GSD_ALLOW_PLANNING_SHRINK',
        overrideSentinel: SENTINEL_REL,
        reason:
          `Write guard: could not read '${filePath}' to compare against the pending ` +
          `Write (${err && err.code ? err.code : 'unknown read error'}). ` +
          `'${path.basename(filePath)}' is a curated planning artifact, so this guard ` +
          `fails closed rather than risk a blind overwrite. Retry once the file is ` +
          `readable, or — if this overwrite is intentional — re-run with the ` +
          `environment variable GSD_ALLOW_PLANNING_SHRINK=1 to bypass this guard once.`,
      });
    }

    const oldLines = countLines(onDisk);
    const newLines = countLines(content);

    if (oldLines < FLOOR_LINES) {
      process.exit(0); // sub-floor stub — ratio checks are meaningless here
    }

    if (newLines >= oldLines * SHRINK_RATIO) {
      process.exit(0); // shrink (if any) is within tolerance
    }

    // The mechanical hatch for workflow steps (see header): consulted only
    // here, at the block point, so a within-tolerance write never burns it.
    if (consumeSentinelFor(filePath, normalized)) {
      process.exit(0); // armed for exactly this file, fresh, now consumed
    }

    const pct = Math.round((newLines / oldLines) * 100);
    // Typed fields (oldLines/newLines/overrideEnvVar/overrideSentinel) ride
    // alongside the free-form reason so consumers — including this repo's
    // tests — never have to regex the prose (CONTRIBUTING.md: no raw text
    // matching).
    emitBlock({
      decision: 'block',
      oldLines,
      newLines,
      overrideEnvVar: 'GSD_ALLOW_PLANNING_SHRINK',
      overrideSentinel: SENTINEL_REL,
      // Round 9 Major 2: the denial deliberately does NOT explain how to arm
      // the sentinel — #973 was an agent reasoning past an advisory, and a
      // block message that prints the bypass recipe hands that same agent a
      // mechanical self-authorization at the moment it is blocked. The
      // sentinel transport stays documented where humans and the workflow
      // engine read (USER-GUIDE, complete-milestone.md); the typed
      // overrideSentinel field above stays for the binding tests. The env
      // var stays named per #2255's acceptance criterion ("the override must
      // be real and its name must appear in the block message") — it cannot
      // reach a hook from a per-step prefix, so naming it does not hand the
      // blocked agent a same-tool bypass.
      reason:
        `Write guard: this Write would shrink '${filePath}' from ${oldLines} lines to ` +
        `${newLines} (${pct}% of current). '${path.basename(filePath)}' is a curated planning ` +
        `artifact; a whole-file Write this much smaller usually means the payload was built ` +
        `from a partial read of the file and would destroy the sections outside that window ` +
        `(#973: a planner collapsed ROADMAP.md 292 → 16 lines this way). To fix: use Edit for ` +
        `a scoped change, or Read the full file and include every section in the Write. ` +
        `Intentional milestone resets go through the workflow's documented escape hatch; ` +
        `interactively, re-run with the environment variable GSD_ALLOW_PLANNING_SHRINK=1 ` +
        `to bypass this guard once.`,
    });
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
