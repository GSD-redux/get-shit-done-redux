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

function getActiveWorkstream(cwd: string, opts: ActiveWorkstreamOpts = {}): string | null {
  const adapter = pickActiveWorkstreamAdapter(cwd, opts);
  if (!adapter) return null;

  const name = adapter.read();
  if (!name || !validateWorkstreamName(name)) {
    adapter.clear();
    return null;
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name);
  if (!fs.existsSync(wsDir)) {
    adapter.clear();
    return null;
  }

  return name;
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
  const adapter = pickActiveWorkstreamAdapter(cwd, opts);
  if (!adapter) return null;

  const name = adapter.read();
  if (!name || !validateWorkstreamName(name)) return null;

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name);
  if (!fs.existsSync(wsDir)) return null;

  return name;
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
  getActiveWorkstream,
  peekActiveWorkstream,
  setActiveWorkstream,
  clearActiveWorkstream,
  parseCliWorkstream,
  resolveActiveWorkstream,
  applyResolvedWorkstreamEnv,
  _resetControllingTtyCacheForTests,
};
