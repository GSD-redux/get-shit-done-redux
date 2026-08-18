/**
 * Active Workstream Pointer Store Module
 *
 * Owns active workstream source precedence, session identity, and pointer IO:
 * CLI --ws > GSD_WORKSTREAM env > stored active workstream pointer.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/active-workstream-store.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { probeTty, platformWriteSync, platformReadSync, platformEnsureDir } from './shell-command-projection.cjs';
import { isValidActiveWorkstreamName } from './workstream-name-policy.cjs';

const WORKSTREAM_SESSION_ENV_KEYS: ReadonlyArray<string> = [
  'GSD_SESSION_KEY',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  // #3557 — Claude Code (≥ 2.1.132) exports its session id to Bash-tool
  // subprocesses as CLAUDE_CODE_SESSION_ID. Without it the probe returned
  // null on Claude Code, so every concurrent session in a working tree
  // shared the single .planning/active-workstream pointer and cross-
  // workstream STATE.md writes landed silently in the wrong file. Inserted
  // beside the other runtime keys without reordering any existing entry;
  // ahead of CLAUDE_CODE_SSE_PORT so the canonical id wins when both are
  // present (runtime identity outranks terminal identity in this list).
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'OPENCODE_SESSION_ID',
  'GEMINI_SESSION_ID',
  'CURSOR_SESSION_ID',
  'WINDSURF_SESSION_ID',
  'TERM_SESSION_ID',
  'WT_SESSION',
  'TMUX_PANE',
  'ZELLIJ_SESSION_NAME',
];

let cachedControllingTtyToken: string | null = null;
let didProbeControllingTtyToken = false;

function planningRoot(cwd: string): string {
  return path.join(cwd, '.planning');
}

function validateWorkstreamName(name: string | null | undefined): boolean {
  return isValidActiveWorkstreamName(name);
}

function sanitizeWorkstreamSessionToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : `${value as number | boolean}`;
  const token = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return token ? token.slice(0, 160) : null;
}

/** Test-only seam: clear the memoized controlling-TTY probe cache (#1191). */
function _resetControllingTtyCacheForTests(): void {
  cachedControllingTtyToken = null;
  didProbeControllingTtyToken = false;
}

function probeControllingTtyToken(): string | null {
  if (didProbeControllingTtyToken) return cachedControllingTtyToken;
  didProbeControllingTtyToken = true;

  if (!(process.stdin && process.stdin.isTTY)) {
    return cachedControllingTtyToken;
  }

  const ttyPath = probeTty();
  if (ttyPath) {
    const token = sanitizeWorkstreamSessionToken(ttyPath.replace(/^\/dev\//, ''));
    if (token) cachedControllingTtyToken = `tty-${token}`;
  }

  return cachedControllingTtyToken;
}

function getControllingTtyToken(): string | null {
  for (const envKey of ['TTY', 'SSH_TTY']) {
    const token = sanitizeWorkstreamSessionToken(process.env[envKey]);
    if (token) return `tty-${token.replace(/^dev_/, '')}`;
  }

  return probeControllingTtyToken();
}

function getWorkstreamSessionKey(): string | null {
  for (const envKey of WORKSTREAM_SESSION_ENV_KEYS) {
    const raw = process.env[envKey];
    const token = sanitizeWorkstreamSessionToken(raw);
    if (token) return `${envKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token}`;
  }

  return getControllingTtyToken();
}

interface SessionScopedWorkstreamFile {
  sessionKey: string;
  dirPath: string;
  filePath: string;
}

function getSessionScopedWorkstreamFile(cwd: string, fixedSessionKey?: string | null): SessionScopedWorkstreamFile | null {
  const sessionKey = fixedSessionKey || getWorkstreamSessionKey();
  if (!sessionKey) return null;

  let planningAbs: string;
  try {
    planningAbs = fs.realpathSync.native(planningRoot(cwd));
  } catch {
    planningAbs = path.resolve(planningRoot(cwd));
  }
  const projectId = crypto
    .createHash('sha1')
    .update(planningAbs)
    .digest('hex')
    .slice(0, 16);

  const dirPath = path.join(os.tmpdir(), 'gsd-workstream-sessions', projectId);
  return {
    sessionKey,
    dirPath,
    filePath: path.join(dirPath, sessionKey),
  };
}

interface WorkstreamPointerAdapter {
  read(): string | null;
  write(name: string): void;
  clear(): void;
}

function createSharedPointerAdapter(cwd: string): WorkstreamPointerAdapter {
  const filePath = path.join(planningRoot(cwd), 'active-workstream');
  return {
    read(): string | null {
      const raw = platformReadSync(filePath);
      return raw ? raw.trim() || null : null;
    },
    write(name: string): void {
      platformWriteSync(filePath, name + '\n');
    },
    clear(): void {
      try { fs.unlinkSync(filePath); } catch {}
    },
  };
}

function createSessionScopedPointerAdapter(cwd: string, fixedSessionKey?: string | null): WorkstreamPointerAdapter | null {
  const scoped = getSessionScopedWorkstreamFile(cwd, fixedSessionKey);
  if (!scoped) return null;

  return {
    read(): string | null {
      const raw = platformReadSync(scoped.filePath);
      return raw ? raw.trim() || null : null;
    },
    write(name: string): void {
      platformEnsureDir(scoped.dirPath);
      platformWriteSync(scoped.filePath, name + '\n');
    },
    clear(): void {
      try { fs.unlinkSync(scoped.filePath); } catch {}
      try {
        const remaining = fs.readdirSync(scoped.dirPath);
        if (remaining.length === 0) {
          fs.rmdirSync(scoped.dirPath);
        }
      } catch {}
    },
  };
}

function createMemoryPointerAdapter(initialName: string | null = null): WorkstreamPointerAdapter {
  let value: string | null = initialName;
  return {
    read(): string | null {
      return value;
    },
    write(name: string): void {
      value = name;
    },
    clear(): void {
      value = null;
    },
  };
}

interface ActiveWorkstreamAdapters {
  session?: WorkstreamPointerAdapter;
  shared?: WorkstreamPointerAdapter;
}

interface ActiveWorkstreamOpts {
  activeWorkstreamAdapter?: WorkstreamPointerAdapter;
  activeWorkstreamAdapters?: ActiveWorkstreamAdapters;
  getStored?: (dir: string) => string | null;
}

function pickActiveWorkstreamAdapter(cwd: string, opts: ActiveWorkstreamOpts = {}): WorkstreamPointerAdapter | null {
  if (opts.activeWorkstreamAdapter) {
    return opts.activeWorkstreamAdapter;
  }

  const sessionKey = getWorkstreamSessionKey();
  if (sessionKey) {
    if (opts.activeWorkstreamAdapters && opts.activeWorkstreamAdapters.session) {
      return opts.activeWorkstreamAdapters.session;
    }
    return createSessionScopedPointerAdapter(cwd, sessionKey);
  }

  if (opts.activeWorkstreamAdapters && opts.activeWorkstreamAdapters.shared) {
    return opts.activeWorkstreamAdapters.shared;
  }
  return createSharedPointerAdapter(cwd);
}

/**
 * Read-resolution chain for getActiveWorkstream/peekActiveWorkstream (#3579).
 *
 * pickActiveWorkstreamAdapter (above) picks exactly one adapter and remains
 * the seam for WRITE paths (set/clear), where "which pointer do I mutate" has
 * only one right answer: the session pointer when a session key exists,
 * otherwise the shared marker. Reads are different — a session that has
 * never called `workstream use` has no opinion of its own, so it should
 * inherit the repo-wide `.planning/active-workstream` marker rather than
 * resolve to nothing. This returns an ORDERED chain: [owned, ...fallbacks].
 * `chain[0]` ("owned") is exactly what pickActiveWorkstreamAdapter would have
 * returned — resolveFromChain() self-heals only chain[0], never a fallback,
 * so one session's read can never delete another scope's marker. Fallbacks
 * are consulted ONLY when chain[0].read() comes back absent/empty; a session
 * with its own (even stale/invalid) pointer never falls through — that is
 * the isolation guarantee and it must not be weakened by inheritance.
 */
function pickActiveWorkstreamAdapterChain(cwd: string, opts: ActiveWorkstreamOpts = {}): WorkstreamPointerAdapter[] {
  if (opts.activeWorkstreamAdapter) {
    return [opts.activeWorkstreamAdapter];
  }

  // #3579 item 3: when a caller supplies `opts.activeWorkstreamAdapters` at
  // all, honor ONLY what it provides. The prior `|| createXPointerAdapter(...)`
  // fallback synthesized a REAL filesystem adapter for whichever half a test
  // double omitted — so a test injecting only `{ session }` silently touched
  // the real shared marker file, and one injecting only `{ shared }` silently
  // touched the real session-scoped tmp file. A missing half now gets a
  // no-op in-memory adapter (always reads null) instead — this preserves the
  // chain[0]-is-owned / rest-are-fallback shape resolveFromChain relies on
  // without ever reaching disk. A caller that wants a real adapter for one
  // half can still construct and pass it explicitly.
  const injected = opts.activeWorkstreamAdapters;
  const sessionKey = getWorkstreamSessionKey();

  if (!sessionKey) {
    const shared = injected
      ? (injected.shared ?? createMemoryPointerAdapter(null))
      : createSharedPointerAdapter(cwd);
    return [shared];
  }

  const session = injected
    ? (injected.session ?? createMemoryPointerAdapter(null))
    : createSessionScopedPointerAdapter(cwd, sessionKey);
  const shared = injected
    ? (injected.shared ?? createMemoryPointerAdapter(null))
    : createSharedPointerAdapter(cwd);

  return session ? [session, shared] : [shared];
}

/**
 * Shared "does this stored name resolve" predicate — format-valid AND its
 * workstream directory exists. Factored out so resolveFromChain's owned/
 * fallback arms (and diagnoseUnresolvedActiveWorkstream, #3579 item 1) share
 * one definition of "resolvable" instead of re-deriving the same two checks.
 */
function resolvesToExistingWorkstream(cwd: string, name: string | null): name is string {
  if (!name || !validateWorkstreamName(name)) return false;
  return fs.existsSync(path.join(planningRoot(cwd), 'workstreams', name));
}

/**
 * Resolves a stored workstream name by walking an adapter chain.
 *
 * chain[0] is "owned" by this resolution: an absent/empty read falls through
 * to the next adapter, but a present-and-bad read (invalid name, or a name
 * whose workstream dir no longer exists) is resolved right there — self-
 * healed via adapter.clear() when `selfHeal` is true, and never consulted
 * further. Anything after chain[0] is a read-only fallback (the inherited
 * marker): a bad value there resolves to null WITHOUT ever calling clear(),
 * so a pointer-less session's read can never delete the shared marker that
 * other sessions/scopes still depend on.
 */
function resolveFromChain(cwd: string, chain: WorkstreamPointerAdapter[], selfHeal: boolean): string | null {
  if (chain.length === 0) return null;
  const [owned, ...fallbacks] = chain;

  const ownedName = owned.read();
  if (ownedName) {
    if (!resolvesToExistingWorkstream(cwd, ownedName)) {
      if (selfHeal) owned.clear();
      return null;
    }
    return ownedName;
  }

  for (const adapter of fallbacks) {
    const name = adapter.read();
    if (resolvesToExistingWorkstream(cwd, name)) return name;
  }

  return null;
}

/**
 * Diagnostic sibling of resolveFromChain (#3579 item 1). getActiveWorkstream/
 * peekActiveWorkstream collapse EVERY unresolvable case to `null`, which is
 * exactly right for routing — but a fail-safe guard reporting "no active
 * workstream is set" to an operator needs to distinguish two very different
 * situations that both produce that same `null`:
 *
 *   (a) no marker/pointer exists anywhere in the chain at all, vs.
 *   (b) a marker/pointer EXISTS (names a value) but that value didn't
 *       resolve — either the name fails validateWorkstreamName, or it's a
 *       well-formed name whose `workstreams/<name>` directory is missing.
 *
 * Walks the same chain resolveFromChain uses and, for the first adapter that
 * held a non-empty raw value, reports why it didn't resolve. Read-only: never
 * calls adapter.clear() (mirrors peekActiveWorkstream, not getActiveWorkstream
 * — a diagnostic read must not have side effects). Reuses
 * resolvesToExistingWorkstream so this can never disagree with the actual
 * resolution predicate above.
 */
function diagnoseUnresolvedActiveWorkstream(
  cwd: string,
  opts: ActiveWorkstreamOpts = {},
): { present: boolean; value: string | null; reason: 'invalid_name' | 'missing_workstream_dir' | null } {
  const chain = pickActiveWorkstreamAdapterChain(cwd, opts);
  for (const adapter of chain) {
    const raw = adapter.read();
    if (!raw) continue;
    if (resolvesToExistingWorkstream(cwd, raw)) continue;
    return {
      present: true,
      value: raw,
      reason: validateWorkstreamName(raw) ? 'missing_workstream_dir' : 'invalid_name',
    };
  }
  return { present: false, value: null, reason: null };
}

function getActiveWorkstream(cwd: string, opts: ActiveWorkstreamOpts = {}): string | null {
  const chain = pickActiveWorkstreamAdapterChain(cwd, opts);
  return resolveFromChain(cwd, chain, true);
}

/**
 * Read-only sibling of getActiveWorkstream (#2850): identical resolution —
 * adapter -> stored name -> validate format -> workstream dir exists — but
 * NEVER calls adapter.clear(). getActiveWorkstream's self-heal (deleting a
 * stale/invalid pointer) is correct for a command that is actively acting on
 * the active workstream; it is wrong for a read-only consumer invoked on
 * every render (e.g. the statusline hook), which must never mutate
 * persistent, possibly cross-session state as a side effect of drawing a
 * screen. A stale or invalid pointer simply resolves to null here — the
 * caller decides what "unresolvable" means for its own render, and the
 * pointer file is left exactly as it was for whatever created it to fix.
 */
function peekActiveWorkstream(cwd: string, opts: ActiveWorkstreamOpts = {}): string | null {
  const chain = pickActiveWorkstreamAdapterChain(cwd, opts);
  return resolveFromChain(cwd, chain, false);
}

function setActiveWorkstream(cwd: string, name: string | null | undefined, opts: ActiveWorkstreamOpts = {}): void {
  const adapter = pickActiveWorkstreamAdapter(cwd, opts);
  if (!adapter) return;

  if (!name) {
    adapter.clear();
    return;
  }
  if (!validateWorkstreamName(name)) {
    throw new Error('Invalid workstream name: must be alphanumeric, hyphens, underscores, or dots');
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name);
  platformEnsureDir(wsDir);
  adapter.write(name);
}

function clearActiveWorkstream(cwd: string, opts: ActiveWorkstreamOpts = {}): void {
  const adapter = pickActiveWorkstreamAdapter(cwd, opts);
  if (!adapter) return;
  adapter.clear();
}

interface ParsedCliWorkstream {
  value: string | null;
  source: string | null;
  args: string[];
}

function parseCliWorkstream(args: string[]): ParsedCliWorkstream {
  const wsEqArg = args.find((arg) => arg.startsWith('--ws='));
  const wsIdx = args.indexOf('--ws');

  if (wsEqArg) {
    const value = wsEqArg.slice('--ws='.length).trim();
    if (!value) throw new Error('Missing value for --ws');
    return {
      value,
      source: 'cli',
      args: args.filter((arg) => arg !== wsEqArg),
    };
  }

  if (wsIdx !== -1) {
    const value = args[wsIdx + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --ws');
    return {
      value,
      source: 'cli',
      args: args.filter((_: string, idx: number) => idx !== wsIdx && idx !== wsIdx + 1),
    };
  }

  return {
    value: null,
    source: null,
    args: args.slice(),
  };
}

interface ResolvedWorkstream {
  ws: string | null;
  source: string;
  args: string[];
}

function resolveActiveWorkstream(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: ActiveWorkstreamOpts = {}
): ResolvedWorkstream {
  const parsed = parseCliWorkstream(args);
  const getStored = deps.getStored || ((dir: string) => getActiveWorkstream(dir, deps));

  let ws: string | null = null;
  let source = 'none';

  if (parsed.value) {
    ws = parsed.value;
    source = parsed.source ?? 'cli';
  } else if (env && typeof env['GSD_WORKSTREAM'] === 'string' && env['GSD_WORKSTREAM'].trim()) {
    ws = env['GSD_WORKSTREAM'].trim();
    source = 'env';
  } else {
    ws = getStored(cwd) || null;
    source = ws ? 'store' : 'none';
  }

  if (ws && !validateWorkstreamName(ws)) {
    throw new Error('Invalid workstream name: must be alphanumeric, hyphens, underscores, or dots');
  }

  return {
    ws,
    source,
    args: parsed.args,
  };
}

function applyResolvedWorkstreamEnv(
  resolution: ResolvedWorkstream | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!resolution || !resolution.ws) return;
  env['GSD_WORKSTREAM'] = resolution.ws;
}

export = {
  validateWorkstreamName,
  getWorkstreamSessionKey,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  pickActiveWorkstreamAdapter,
  pickActiveWorkstreamAdapterChain,
  getActiveWorkstream,
  peekActiveWorkstream,
  diagnoseUnresolvedActiveWorkstream,
  setActiveWorkstream,
  clearActiveWorkstream,
  parseCliWorkstream,
  resolveActiveWorkstream,
  applyResolvedWorkstreamEnv,
  _resetControllingTtyCacheForTests,
};
