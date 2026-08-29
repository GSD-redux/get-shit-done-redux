/**
 * Companion MCP server (ADR-1239 Phase C-2, #1681 slice 3a).
 *
 * A minimal stdio JSON-RPC 2.0 server exposing two of the six interface points
 * so any MCP-consuming host (Claude/Codex/OpenCode/VS Code/Gemini/Cursor/Cline/
 * Hermes) can drive GSD with NO bespoke plugin:
 *
 *   - point 1 (command): tool `gsd_invoke_command` → `dispatchGsdCommand`
 *     (src/shell-command-projection.cts), a bounded subprocess-shim to
 *     gsd-tools.cjs. #2102 Stage 2: `commandRoutingHub.createHub()` called
 *     with no args here always hit `if(!_cjsRegistry) return
 *     makeUnknownCommand()` — every dispatch was UnknownCommand. No
 *     fully-populated hub factory exists anywhere in gsd-core (every
 *     createHub() caller builds a single-family hub for its own narrow
 *     purpose), so the fix routes through the SAME shared dispatch helper
 *     the pi extension uses (pi/gsd.cjs), mirroring the SUBPROCESS-REUSE
 *     precedent already established for the OpenCode/Kilo hook bridge.
 *   - point 5 (state IO): tools `gsd_read_state` / `gsd_write_state` → the
 *     Phase 3 `stateIO` seam (src/state-io.cts, filesystem default).
 *
 * No new runtime dependency — the JSON-RPC stdio loop is hand-rolled (the repo
 * ships only claude-agent-sdk + ws; adding an MCP SDK is a separate packaging
 * decision). The protocol logic (`handleMessage`) is PURE and fully testable;
 * `runServer` is a thin line-delimited-JSON loop over injectable streams.
 *
 * Bin entry / packaging / manifest-version-sync is slice 3b — this module is
 * the additive, importable server surface a host (or the bin shim) drives.
 */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateIo = require('./state-io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCommandProjection = require('./shell-command-projection.cjs');
const { dispatchGsdCommand } = shellCommandProjection;
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  buildCatalog,
  readResource,
  listResources,
  getPrompt,
  REASON,
  type Catalog,
} from './mcp-catalog.cjs';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'gsd-core';

// #3072: resolve SERVER_VERSION from package.json (source tree) or the
// installed gsd-core/VERSION marker, WITHOUT a top-level `require(...)` —
// mirrors the established, already-precedented resolver in
// `runtime-artifact-conversion.cts`'s `gsdVersion()` (#1383): a top-level
// require would throw on any runtime whose root has no package.json/VERSION,
// and `scripts/sync-manifest-versions.cjs` is not a fit here — its
// `VERSIONED_MANIFESTS` list stamps a `version` FIELD into hand-authored JSON
// manifests (plugin.json, marketplace.json, vscode/package.json); a `.cts`
// source constant is not a JSON document that script can round-trip through
// `readJson`/`setByPath`, and teaching it to text-edit TypeScript source
// would be a much larger footprint than this lazy, cached, defensive read.
// Resolved once per process (never per-request) and cached; a failed lookup
// degrades to '0.0.0' (never `undefined`, never a crash) rather than making
// `initialize`'s `serverInfo.version` field absent or malformed.
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;
let cachedServerVersion: string | undefined;
function resolveServerVersion(): string {
  if (cachedServerVersion !== undefined) return cachedServerVersion;
  let version = '0.0.0';
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
    if (SEMVER_PREFIX.test(v)) version = v;
  } catch {
    /* not an installed tree (no gsd-core/VERSION) */
  }
  if (version === '0.0.0') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, defensive: a top-level require would throw on a runtime root with no package.json.
      const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json')) as { version?: string };
      if (pkg && typeof pkg.version === 'string' && SEMVER_PREFIX.test(pkg.version)) version = pkg.version;
    } catch {
      /* runtime root has no package.json */
    }
  }
  cachedServerVersion = version;
  return version;
}

// Catalog is built once per process, lazily, and cached (design "Shape" /
// Gall's Law — no watching, no invalidation; Known limits: the package is
// immutable in every install mode we ship).
let cachedCatalog: Catalog | undefined;
function getCatalog(): Catalog {
  if (cachedCatalog === undefined) cachedCatalog = buildCatalog();
  return cachedCatalog;
}

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpContext {
  cwd?: string;
  /** Test seam; production always uses the shared CLI dispatcher. */
  dispatch?: typeof dispatchGsdCommand;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

const TOOLS = [
  {
    name: 'gsd_invoke_command',
    description: 'Invoke a GSD command via the command-routing hub (interface point 1).',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Command family (e.g. "query", "state", "phase").' },
        subcommand: { type: 'string', description: 'Subcommand name.' },
        args: { type: 'array', items: {}, description: 'Positional args.' },
      },
      required: ['family', 'subcommand'],
    },
  },
  {
    name: 'gsd_read_state',
    description: 'Read a .planning state file (interface point 5).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path under .planning/.' } },
      required: ['path'],
    },
  },
  {
    name: 'gsd_write_state',
    description: 'Write a .planning state file (interface point 5).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path under .planning/.' },
        content: { type: 'string', description: 'File content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'gsd_control_center',
    description: 'Read the selected project planning snapshot for the GSD Control Center.',
    _meta: { ui: { resourceUri: 'ui://gsd/control-center-v1.html' }, 'ui/resourceUri': 'ui://gsd/control-center-v1.html' },
    inputSchema: {
      type: 'object', properties: { project_path: { type: 'string', description: 'Absolute project directory.' } }, required: ['project_path'],
    },
  },
  {
    name: 'gsd_uat_workbench',
    description: 'Read unresolved UAT items for the selected project.',
    _meta: { ui: { resourceUri: 'ui://gsd/uat-workbench-v1.html' }, 'ui/resourceUri': 'ui://gsd/uat-workbench-v1.html' },
    inputSchema: {
      type: 'object', properties: { project_path: { type: 'string', description: 'Absolute project directory.' } }, required: ['project_path'],
    },
  },
  {
    name: 'gsd_record_uat_result',
    description: 'Record a pass or issue for one pending UAT test, then refresh the workbench.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Absolute project directory.' },
        file_path: { type: 'string', description: 'UAT file path under the project .planning directory.' },
        test_number: { type: 'integer', minimum: 1, description: 'Pending UAT test number.' },
        result: { type: 'string', enum: ['pass', 'issue'] },
        note: { type: 'string' },
      },
      required: ['project_path', 'file_path', 'test_number', 'result'],
    },
  },
];

function errorResponse(id: unknown, code: number, message: string, data?: unknown) {
  const err: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function okResponse(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Extract the {@link REASON} carried by a `CatalogError`, if any (see `mcp-catalog.cts`). */
function catalogErrorReason(err: unknown): string | undefined {
  const reason = err && typeof err === 'object' ? (err as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason : undefined;
}

function catalogErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a `mcp-catalog.cts` `CatalogError.reason` to a JSON-RPC error code.
 * `READ_FAILED` is a server-side IO/compose failure (`INTERNAL_ERROR`);
 * every other reason (unknown uri/prompt/cursor/root, malformed/traversal
 * uri, wrong-typed param) is a client-supplied-value problem (`INVALID_PARAMS`)
 * — deliberately never `METHOD_NOT_FOUND`, so a refusal is never
 * indistinguishable from the method simply not existing (test-matrix rows
 * 33/35).
 */
function catalogErrorCode(err: unknown): number {
  return catalogErrorReason(err) === REASON.READ_FAILED ? INTERNAL_ERROR : INVALID_PARAMS;
}

function wireResource(entry: { uri: string; name: string; title: string; description: string; mimeType: string; _meta?: { 'ui.prefersBorder': true } }) {
  return entry._meta === undefined
    ? { uri: entry.uri, name: entry.name, title: entry.title, description: entry.description, mimeType: entry.mimeType }
    : { uri: entry.uri, name: entry.name, title: entry.title, description: entry.description, mimeType: entry.mimeType, _meta: entry._meta };
}

function wirePrompt(entry: { name: string; title: string; description: string }) {
  return { name: entry.name, title: entry.title, description: entry.description };
}

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function projectPath(value: unknown): string | null {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : null;
  } catch {
    return null;
  }
}

function parsedDispatch(family: string, subcommand: string, args: string[], cwd: string, dispatch = dispatchGsdCommand): { value?: unknown; error?: string } {
  const res = dispatch({ family, subcommand, args, cwd });
  if (!res.ok) return { error: res.stderr || res.stdout || `dispatch failed (exit ${res.code})` };
  try {
    return { value: JSON.parse(res.stdout) };
  } catch {
    return { error: 'GSD command returned invalid JSON.' };
  }
}

function structured(value: unknown) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || record[key] === null || typeof record[key] === 'string';
}

function validScopedValue(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && optionalString(record, 'value') && typeof record.scope === 'string';
}

function validFraction(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null
    && typeof record.completed === 'number'
    && typeof record.total === 'number'
    && (record.percent === null || typeof record.percent === 'number')
    && typeof record.scope === 'string';
}

function validPhase(value: unknown): boolean {
  const phase = asRecord(value);
  const verification = phase && asRecord(phase.verification);
  const acceptance = phase && asRecord(phase.roadmap_acceptance);
  const uat = phase && asRecord(phase.uat);
  return phase !== null
    && typeof phase.dir === 'string'
    && optionalString(phase, 'phase_id')
    && verification !== null
    && typeof verification.status === 'string'
    && optionalString(verification, 'next_action')
    && acceptance !== null
    && (acceptance.checkbox === null || typeof acceptance.checkbox === 'boolean')
    && uat !== null
    && Array.isArray(uat.unresolved)
    && uat.unresolved.every((item) => asRecord(item) !== null)
    && Number.isInteger(phase.plan_count)
    && Number(phase.plan_count) >= 0;
}

function validDiagnostic(value: unknown): boolean {
  const diagnostic = asRecord(value);
  return diagnostic !== null
    && typeof diagnostic.code === 'string'
    && typeof diagnostic.subject === 'string'
    && typeof diagnostic.detail === 'string';
}

function validCountRecord(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.values(record).every((count) => Number.isInteger(count) && Number(count) >= 0);
}

function validWorkbenchItem(value: unknown): boolean {
  const item = asRecord(value);
  return item !== null
    && typeof item.name === 'string'
    && typeof item.result === 'string'
    && typeof item.category === 'string'
    && (item.test === undefined || (Number.isInteger(item.test) && Number(item.test) >= 1))
    && optionalString(item, 'expected')
    && optionalString(item, 'reason')
    && optionalString(item, 'blocked_by');
}

function validWorkbenchFile(value: unknown): boolean {
  const file = asRecord(value);
  return file !== null
    && typeof file.phase === 'string'
    && typeof file.phase_dir === 'string'
    && typeof file.file === 'string'
    && typeof file.file_path === 'string'
    && (file.type === 'uat' || file.type === 'verification' || file.type === 'deferred')
    && typeof file.status === 'string'
    && optionalString(file, 'archived_milestone')
    && (file.parse_gap === undefined || typeof file.parse_gap === 'boolean')
    && (file.unparsed_blocks === undefined || (Number.isInteger(file.unparsed_blocks) && Number(file.unparsed_blocks) >= 1))
    && Array.isArray(file.items)
    && file.items.every(validWorkbenchItem);
}

function validPlanningSnapshot(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  const milestone = record && asRecord(record.milestone);
  const active = record && asRecord(record.active);
  const progress = record && asRecord(record.progress);
  return record !== null
    && record.schema_version === 1
    && asRecord(record.generated_from) !== null
    && milestone !== null
    && optionalString(milestone, 'name')
    && typeof milestone.scope === 'string'
    && active !== null
    && validScopedValue(active.phase)
    && validScopedValue(active.plan)
    && validScopedValue(active.status)
    && Array.isArray(record.phases)
    && record.phases.every(validPhase)
    && Array.isArray(record.orphan_phase_dirs)
    && Array.isArray(record.requirements)
    && progress !== null
    && validFraction(progress.accepted_phases)
    && validFraction(progress.completed_plans)
    && Array.isArray(record.diagnostics)
    && record.diagnostics.every(validDiagnostic);
}

function validWorkbench(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  const summary = record && asRecord(record.summary);
  return record !== null
    && Array.isArray(record.results)
    && record.results.every(validWorkbenchFile)
    && summary !== null
    && Number.isInteger(summary.total_files)
    && Number(summary.total_files) >= 0
    && Number.isInteger(summary.total_items)
    && Number(summary.total_items) >= 0
    && Number.isInteger(summary.parse_gap_files)
    && Number(summary.parse_gap_files) >= 0
    && validCountRecord(summary.by_category)
    && validCountRecord(summary.by_phase);
}

function callTool(name: string, args: unknown, ctx: McpContext): { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: unknown } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const cwd = asString(ctx.cwd) || process.cwd();
  const dispatch = ctx.dispatch ?? dispatchGsdCommand;
  try {
    if (name === 'gsd_invoke_command') {
      const family = asString(a.family);
      const subcommand = asString(a.subcommand);
      if (!family || !subcommand) {
        return { isError: true, content: [{ type: 'text', text: 'gsd_invoke_command requires string "family" and "subcommand".' }] };
      }
      const res = dispatch({ family, subcommand, args: Array.isArray(a.args) ? (a.args as string[]) : [], cwd });
      if (!res.ok) {
        return { isError: true, content: [{ type: 'text', text: res.stderr || res.stdout || `dispatch failed (exit ${res.code})` }] };
      }
      return { content: [{ type: 'text', text: res.stdout }] };
    }
    if (name === 'gsd_control_center' || name === 'gsd_uat_workbench' || name === 'gsd_record_uat_result') {
      const project = projectPath(a.project_path);
      if (!project) return toolError(`${name} requires an existing absolute "project_path" directory.`);
      if (name === 'gsd_control_center') {
        const result = parsedDispatch('planning', 'inspect', [], project, dispatch);
        return result.error || !validPlanningSnapshot(result.value)
          ? toolError(result.error || 'planning inspect returned an invalid schema-v1 snapshot.')
          : structured({ ...result.value, project_path: project });
      }
      if (name === 'gsd_uat_workbench') {
        const result = parsedDispatch('audit-uat', 'run', [], project, dispatch);
        return result.error || !validWorkbench(result.value)
          ? toolError(result.error || 'audit-uat returned an invalid workbench.')
          : structured({ ...result.value, project_path: project });
      }
      const file = asString(a.file_path);
      const test = a.test_number;
      const result = asString(a.result);
      const note = asString(a.note);
      if (!file || !Number.isInteger(test) || Number(test) < 1 || (result !== 'pass' && result !== 'issue') || (a.note !== undefined && note === null)) {
        return toolError('gsd_record_uat_result requires string "file_path", integer "test_number", result "pass" or "issue", and optional string "note".');
      }
      if (result === 'issue' && (!note || !note.trim())) return toolError('gsd_record_uat_result requires a nonblank "note" for issue results.');
      const mutation = parsedDispatch('uat', 'record-result', ['--file', file, '--test', String(test), '--result', result, ...(note === null ? [] : ['--note', note])], project, dispatch);
      if (mutation.error) return toolError(mutation.error);
      const mutationData = asRecord(mutation.value);
      if (!mutationData) return toolError('uat record-result returned invalid JSON.');
      const mutationStatus = mutationData.status;
      const nextTest = mutationData.next_test;
      if (mutationData.recorded !== true
        || mutationData.file_path !== file
        || mutationData.test_number !== test
        || mutationData.result !== result
        || (mutationStatus !== 'partial' && mutationStatus !== 'complete')
        || !(nextTest === null || (Number.isInteger(nextTest) && Number(nextTest) >= 1))) {
        return toolError('uat record-result returned invalid JSON.');
      }
      const mutationResult = {
        file_path: file,
        test_number: test,
        result,
        status: mutationStatus,
        next_test: nextTest,
      };
      const workbench = parsedDispatch('audit-uat', 'run', [], project, dispatch);
      if (workbench.error || !validWorkbench(workbench.value)) {
        return structured({
          mutation: mutationResult,
          workbench: null,
          refresh_error: workbench.error || 'audit-uat returned an invalid workbench.',
        });
      }
      return structured({
        mutation: mutationResult,
        workbench: { ...workbench.value, project_path: project },
      });
    }
    if (name === 'gsd_read_state') {
      const p = asString(a.path);
      if (!p) return { isError: true, content: [{ type: 'text', text: 'gsd_read_state requires string "path".' }] };
      const io = stateIo.createStateIO({ io: 'filesystem' });
      return { content: [{ type: 'text', text: io.read(p) }] };
    }
    if (name === 'gsd_write_state') {
      const p = asString(a.path);
      const content = asString(a.content);
      if (!p || content === null) return { isError: true, content: [{ type: 'text', text: 'gsd_write_state requires string "path" and "content".' }] };
      const io = stateIo.createStateIO({ io: 'filesystem' });
      io.write(p, content);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, path: p }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

/**
 * Pure JSON-RPC handler. Takes a parsed request object + context, returns a
 * JSON-RPC response object (or null for JSON-RPC notifications — no id).
 */
export function handleMessage(request: JsonRpcRequest, ctx: McpContext = {}): Record<string, unknown> | null {
  if (!request || typeof request !== 'object') {
    return errorResponse(null, INVALID_REQUEST, 'Invalid Request: not an object.');
  }
  const id = request.id;
  // Notification (no id) → no response per JSON-RPC.
  const isNotification = id === undefined || id === null;
  const method = typeof request.method === 'string' ? request.method : '';

  let result: unknown;
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: PROTOCOL_VERSION,
        // #3072: resources/prompts declared alongside tools. Deliberately NO
        // subscribe/listChanged — nothing ever sends those notifications
        // (design row 2 / Hyrum's Law: advertising an unimplemented
        // notification is a lie a host would act on).
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: SERVER_NAME, version: resolveServerVersion() },
      };
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    case 'tools/call': {
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
      const toolName = asString(params.name);
      if (!toolName) return errorResponse(id, INVALID_PARAMS, 'tools/call requires string "name".');
      result = callTool(toolName, params.arguments, ctx);
      break;
    }
    case 'resources/list': {
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
      try {
        const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
        const pageSize = typeof params.pageSize === 'number' ? params.pageSize : undefined;
        const page = listResources(getCatalog(), { cursor, pageSize });
        result = page.nextCursor === undefined
          ? { resources: page.resources.map(wireResource) }
          : { resources: page.resources.map(wireResource), nextCursor: page.nextCursor };
      } catch (e) {
        return errorResponse(id, catalogErrorCode(e), catalogErrorMessage(e));
      }
      break;
    }
    case 'resources/read': {
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
      try {
        const read = readResource(getCatalog(), params.uri);
        const entry = getCatalog().resources.get(read.uri);
        result = { contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text, ...(entry?._meta === undefined ? {} : { _meta: entry._meta }) }] };
      } catch (e) {
        return errorResponse(id, catalogErrorCode(e), catalogErrorMessage(e));
      }
      break;
    }
    case 'prompts/list':
      result = {
        prompts: [...getCatalog().prompts.values()]
          .map(wirePrompt)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      };
      break;
    case 'prompts/get': {
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
      const name = asString(params.name);
      if (!name) return errorResponse(id, INVALID_PARAMS, 'prompts/get requires string "name".');
      try {
        result = getPrompt(getCatalog(), name, params.arguments);
      } catch (e) {
        return errorResponse(id, catalogErrorCode(e), catalogErrorMessage(e));
      }
      break;
    }
    default:
      if (isNotification) return null;
      return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method || '(empty)'}.`);
  }
  if (isNotification) return null;
  return okResponse(id, result);
}

/**
 * Thin stdio loop over injectable streams. Reads line-delimited JSON-RPC from
 * `input`, writes responses (one JSON object + newline) to `output`. Stops when
 * input ends. Errors in handleMessage are caught and emitted as JSON-RPC error
 * responses (the loop never crashes).
 */
export async function runServer({
  input,
  output,
  ctx = {},
}: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  ctx?: McpContext;
}): Promise<void> {
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(JSON.stringify(errorResponse(null, PARSE_ERROR, 'Parse error.')) + '\n');
      return;
    }
    try {
      const response = handleMessage(parsed as JsonRpcRequest, ctx);
      if (response) output.write(JSON.stringify(response) + '\n');
    } catch (e) {
      output.write(JSON.stringify(errorResponse(null, INTERNAL_ERROR, e instanceof Error ? e.message : 'Internal error.')) + '\n');
    }
  };
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? decoder.end() + chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  }
  buffer += decoder.end();
  processLine(buffer.replace(/\r$/, ''));
}

// handleMessage + runServer are exported above (export function); PROTOCOL_VERSION
// + SERVER_NAME are exported above (export const).
